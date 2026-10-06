import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { object, result } from '../cf-client.ts';
import { ROOT, resourceName, scopedVariable, type Environment, type ResourceState } from '../environment.ts';
import { resources } from '../inventory.ts';
import { cf, offlineEnvironment, writeJson } from '../process.ts';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const d1SnapshotSchema = z.object({
  format: z.literal('gitknot.d1.snapshot'), version: z.literal(1), id: z.string(), created_at: z.string(),
  source: z.object({ account_id: z.string().regex(/^[a-f0-9]{32}$/), database_id: z.string().uuid(), resource_key: z.string(), name: z.string(), cell_id: z.string(), mode: z.string() }),
  bookmark: z.string(), file: z.string(), sha256: digestSchema, bytes: z.number().int().positive(),
  r2: z.object({ account_id: z.string(), bucket: z.string(), jurisdiction: z.string().optional(), manifest_key: z.string(), parts: z.array(z.object({ key: z.string().startsWith('scheduled/'), sha256: digestSchema, bytes: z.number().int().positive() })) }).optional(),
});
export type D1Snapshot = z.infer<typeof d1SnapshotSchema>;

function token(env: Environment): string {
  const value = scopedVariable(env.mode, 'TRUST_API_TOKEN') ?? process.env.CLOUDFLARE_API_TOKEN;
  if (!value) throw new Error('An operator-supplied scoped Cloudflare token is required for D1 recovery.');
  return value;
}

function database(env: Environment, key: string): ResourceState {
  const value = env.state.resources[key];
  const spec = resources(env).find(resource => resource.key === key);
  if (spec?.kind !== 'd1' || key === 'd1.search' || !value || value.kind !== 'd1' || !z.string().uuid().safeParse(value.id).success) throw new Error('Choose a resolved authoritative D1 database; SEARCH_DB is rebuilt instead of exported.');
  if (value.name !== spec.name || value.account_id !== env.accounts[spec.account]) throw new Error('The recorded D1 authority differs from the selected database or account.');
  return value;
}

async function api(env: Environment, db: ResourceState, operation: 'export' | 'import' | 'raw', body: unknown): Promise<unknown> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${db.account_id}/d1/database/${db.id}/${operation}`, {
    method: 'POST', headers: { authorization: `Bearer ${token(env)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(60_000),
  });
  const envelope = object(await response.json());
  if (!response.ok || envelope.success !== true) throw new Error(`D1 ${operation} failed (${response.status}); its outcome was not confirmed.`);
  return envelope.result;
}

async function query(env: Environment, db: ResourceState, sql: string): Promise<unknown[][]> {
  const response = await api(env, db, 'raw', { sql });
  if (!Array.isArray(response)) throw new Error('Unexpected D1 query shape.');
  return response.flatMap(value => {
    const row = object(value);
    if (row.success === false) throw new Error('D1 rejected a recovery verification query.');
    const rows = object(row.results).rows;
    if (!Array.isArray(rows)) throw new Error('D1 result rows missing.');
    return rows as unknown[][];
  });
}

export async function readD1Rows(env: Environment, resourceKey: string, sql: string): Promise<unknown[][]> {
  if (!/^SELECT\s/i.test(sql)) throw new Error('The read-only recovery adapter accepts SELECT only.');
  return query(env, database(env, resourceKey), sql);
}

export async function materializeD1Snapshot(env: Environment, snapshot: D1Snapshot, file: string): Promise<D1Snapshot> {
  if (!snapshot.r2) throw new Error('The snapshot has no retained R2 parts.');
  const credentials = scopedVariable(env.mode, 'BACKUP_API_TOKEN') ?? token(env);
  const temporary = `${file}.${randomUUID()}.partial`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const output = await open(temporary, 'wx', 0o600);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for (const part of snapshot.r2.parts) {
      const path = part.key.split('/').map(encodeURIComponent).join('/');
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${snapshot.r2.account_id}/r2/buckets/${snapshot.r2.bucket}/objects/${path}`, {
        headers: { authorization: `Bearer ${credentials}`, ...(snapshot.r2.jurisdiction ? { 'cf-r2-jurisdiction': snapshot.r2.jurisdiction } : {}) },
        redirect: 'error', signal: AbortSignal.timeout(300_000),
      });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Retained snapshot part is unavailable (${response.status}).`); }
      const digest = createHash('sha256');
      let size = 0;
      for await (const value of Readable.fromWeb(response.body as never)) {
        const chunk = Buffer.from(value); size += chunk.byteLength;
        if (size > part.bytes) throw new Error('Retained snapshot part exceeded its manifest.');
        hash.update(chunk); digest.update(chunk);
        let offset = 0;
        while (offset < chunk.length) offset += (await output.write(chunk, offset, chunk.length - offset)).bytesWritten;
      }
      if (size !== part.bytes || digest.digest('hex') !== part.sha256) throw new Error('Retained snapshot part checksum mismatch.');
      bytes += size;
    }
    if (bytes !== snapshot.bytes || hash.digest('hex') !== snapshot.sha256) throw new Error('Reconstructed D1 snapshot differs from its manifest.');
    await output.close();
    await rename(temporary, file);
    return { ...snapshot, file };
  } catch (error) { await output.close().catch(() => {}); await rm(temporary, { force: true }); throw error; }
}

async function poll(env: Environment, db: ResourceState, operation: 'export' | 'import', initial: unknown): Promise<Record<string, unknown>> {
  let progress = object(initial);
  let bookmark = typeof progress.at_bookmark === 'string' ? progress.at_bookmark : undefined;
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    if (progress.status === 'error' || progress.success === false) throw new Error(`D1 ${operation} did not complete.`);
    if (progress.status === 'complete') return { ...progress, ...(bookmark ? { at_bookmark: bookmark } : {}) };
    if (typeof progress.at_bookmark !== 'string') throw new Error(`D1 ${operation} returned neither completion nor a polling bookmark.`);
    await delay(500);
    progress = object(await api(env, db, operation, operation === 'export'
      ? { output_format: 'polling', current_bookmark: progress.at_bookmark }
      : { action: 'poll', current_bookmark: progress.at_bookmark }));
    if (typeof progress.at_bookmark === 'string') bookmark = progress.at_bookmark;
  }
  throw new Error(`D1 ${operation} exceeded 30 minutes; inspect its persisted bookmark before retrying.`);
}

function transferUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('D1 transfer URL missing.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('D1 transfer URL is not a credential-free HTTPS URL.');
  return url.href;
}

async function download(url: string, file: string, headers: Record<string, string> = {}): Promise<{ sha256: string; bytes: number }> {
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`D1 backup download failed (${response.status}).`); }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const partial = `${file}.${randomUUID()}.partial`;
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    await pipeline(Readable.fromWeb(response.body as never), new Transform({ transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk); bytes += chunk.byteLength; done(null, chunk);
    } }), createWriteStream(partial, { mode: 0o600, flags: 'wx' }));
    await rename(partial, file);
    return { sha256: hash.digest('hex'), bytes };
  } catch (error) { await rm(partial, { force: true }); throw error; }
}

export async function exportD1(env: Environment, resourceKey: string, directory: string): Promise<D1Snapshot> {
  const db = database(env, resourceKey);
  const virtual = await query(env, db, "SELECT name FROM sqlite_schema WHERE type='table' AND upper(sql) LIKE 'CREATE VIRTUAL TABLE%'");
  if (virtual.length) throw new Error('Native D1 export does not support virtual tables. Keep FTS in the separate search database.');
  const completed = await poll(env, db, 'export', await api(env, db, 'export', { output_format: 'polling' }));
  const exported = object(completed.result);
  const id = randomUUID();
  const file = join(directory, `${resourceKey}-${id}.sql`);
  const downloaded = await download(transferUrl(exported.signed_url), file);
  if (typeof completed.at_bookmark !== 'string') throw new Error('Completed D1 export omitted its consistency bookmark.');
  const snapshot: D1Snapshot = { format: 'gitknot.d1.snapshot', version: 1, id, created_at: new Date().toISOString(),
    source: { account_id: db.account_id, database_id: db.id, resource_key: resourceKey, name: db.name, cell_id: env.cell, mode: env.mode },
    bookmark: completed.at_bookmark, file, ...downloaded,
  };
  await writeJson(join(directory, `${resourceKey}-${id}.json`), snapshot);
  return snapshot;
}

interface ImportJournal {
  target_id: string; target_account_id: string; source_sha256: string;
  phase: 'uploading' | 'ingesting' | 'polling' | 'completed'; bookmark?: string; receipt?: Record<string, unknown>;
}

async function readImportJournal(path: string): Promise<ImportJournal | undefined> {
  try {
    return z.object({ target_id: z.string(), target_account_id: z.string(), source_sha256: digestSchema,
      phase: z.enum(['uploading', 'ingesting', 'polling', 'completed']), bookmark: z.string().optional(), receipt: z.record(z.string(), z.unknown()).optional(),
    }).parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function ingestSnapshot(env: Environment, target: ResourceState, snapshot: D1Snapshot, etag: string, journal: ImportJournal, journalPath: string): Promise<Record<string, unknown>> {
  const existing = await query(env, target, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'");
  if (existing.length) throw new Error('The destination database is not fresh. Recovery never drops existing tables.');
  await writeJson(journalPath, journal);
  const initialized = object(await api(env, target, 'import', { action: 'init', etag }));
  if (typeof initialized.filename !== 'string') throw new Error('D1 import filename missing.');
  if (initialized.upload_url) {
    const response = await fetch(transferUrl(initialized.upload_url), { method: 'PUT', body: Readable.toWeb(createReadStream(snapshot.file)) as ReadableStream<Uint8Array>,
      headers: { 'content-length': String(snapshot.bytes) }, redirect: 'error', signal: AbortSignal.timeout(30 * 60_000), duplex: 'half',
    } as RequestInit);
    await response.body?.cancel();
    if (!response.ok) throw new Error(`D1 snapshot upload failed (${response.status}).`);
  }
  journal.phase = 'ingesting';
  await writeJson(journalPath, journal);
  const started = object(await api(env, target, 'import', { action: 'ingest', filename: initialized.filename, etag }));
  if (typeof started.at_bookmark === 'string') journal.bookmark = started.at_bookmark;
  journal.phase = 'polling';
  await writeJson(journalPath, journal);
  return started;
}

/** D1's import endpoint accepts at most 5 GiB per SQL file. It is never a migration runner. */
export async function restoreD1(env: Environment, resourceKey: string, snapshot: D1Snapshot, resumeBookmark?: string): Promise<Record<string, unknown>> {
  const target = database(env, resourceKey);
  if (resources(env).find(resource => resource.key === resourceKey)?.existing) throw new Error('A metadata-cell restore cannot overwrite its shared identity or directory authority. Recover that authority through its owning cell.');
  if (target.id === snapshot.source.database_id && target.account_id === snapshot.source.account_id) throw new Error('D1 recovery requires a fresh database, not the source authority.');
  if (env.mode !== snapshot.source.mode || (resourceKey === 'd1.directory') !== (snapshot.source.resource_key === 'd1.directory')) throw new Error('Snapshot mode/database role differs from the destination.');
  if (!env.recovery) throw new Error('Fresh-cell SQL recovery requires GITKNOT_<MODE>_RECOVERY_MODE=true so ingress, admission and automatic side effects remain disabled in its configuration.');
  if ((await stat(snapshot.file)).size > 5 * 1024 ** 3) throw new Error('This SQL snapshot exceeds the provider 5 GiB import ceiling. Use an operationally validated split import; do not truncate the export.');
  const sha256 = createHash('sha256');
  const md5 = createHash('md5');
  for await (const chunk of createReadStream(snapshot.file)) { sha256.update(chunk); md5.update(chunk); }
  if (sha256.digest('hex') !== snapshot.sha256) throw new Error('D1 snapshot checksum does not match its retained manifest.');
  const etag = md5.digest('hex');
  const journalPath = join(ROOT, '.gitknot', 'recovery', 'd1', `${target.account_id}-${target.id}.json`);
  const journal: ImportJournal = await readImportJournal(journalPath) ?? { target_id: target.id, target_account_id: target.account_id, source_sha256: snapshot.sha256, phase: 'uploading' };
  if (journal.target_id !== target.id || journal.target_account_id !== target.account_id || journal.source_sha256 !== snapshot.sha256) throw new Error('An existing restore journal belongs to another snapshot or destination.');
  if (journal.phase === 'completed' && journal.receipt) return journal.receipt;
  if (resumeBookmark) {
    if (journal.phase !== 'ingesting' && journal.phase !== 'polling') throw new Error('A resume bookmark requires an already submitted import journal.');
    journal.bookmark = resumeBookmark;
  }
  if ((journal.phase === 'ingesting' || journal.phase === 'polling') && !journal.bookmark) throw new Error(`Import submission is uncertain. Inspect ${journalPath} and the provider operation, then supply its actual --resume-bookmark; do not reingest.`);
  const started = journal.bookmark ? await api(env, target, 'import', { action: 'poll', current_bookmark: journal.bookmark })
    : await ingestSnapshot(env, target, snapshot, etag, journal, journalPath);
  const imported = await poll(env, target, 'import', started);
  const integrity = await query(env, target, 'PRAGMA quick_check');
  if (integrity.length !== 1 || integrity[0]?.[0] !== 'ok' || (await query(env, target, 'PRAGMA foreign_key_check')).length) throw new Error('Restored D1 integrity/foreign-key verification failed. Keep the cell private.');
  const tableRows = await query(env, target, "SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('credentials','repositories','resource_routes','account_authority_placements')");
  const tables = new Set(tableRows.map(row => String(row[0])));
  const time = new Date().toISOString();
  if (tables.has('resource_routes')) await query(env, target, `UPDATE resource_routes SET state='fenced',updated_at='${time}' WHERE state<>'deleted'`);
  if (tables.has('repositories')) await query(env, target, `UPDATE repositories SET state='moving',revision=revision+1,updated_at='${time}' WHERE state<>'deleted'`);
  const distributedAuthority = tables.has('account_authority_placements') && (await query(env, target, 'SELECT account_id FROM account_authority_placements LIMIT 1')).length > 0;
  if (tables.has('credentials') && !distributedAuthority) await query(env, target, `UPDATE credentials SET revoked_at='${time}',revision=revision+1 WHERE revoked_at IS NULL`);
  const receipt = { database_id: target.id, source_database_id: snapshot.source.database_id, source_sha256: snapshot.sha256,
    final_bookmark: object(imported.result).final_bookmark, integrity_verified: true, credentials_revoked: tables.has('credentials') && !distributedAuthority, writes_fenced: tables.has('repositories') || tables.has('resource_routes'),
    identity_authority_reconciliation_required: distributedAuthority,
    routing_switched: false, repository_content_reconciliation_required: true,
  };
  await writeJson(journalPath, { ...journal, phase: 'completed', receipt });
  return receipt;
}

export async function storeD1Snapshot(env: Environment, snapshot: D1Snapshot): Promise<D1Snapshot> {
  const bucket = resourceName(env, 'backups');
  if (!env.state.resources['r2.backups']) throw new Error('Backup bucket is not resolved.');
  const account = env.accounts.trusted!;
  const key = scopedVariable(env.mode, 'BACKUP_API_TOKEN') ?? token(env);
  const cliEnv = { ...offlineEnvironment(), CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: key };
  const prefix = `scheduled/${snapshot.created_at.slice(0, 10)}/${snapshot.id}`;
  const parts: { key: string; sha256: string; bytes: number }[] = [];
  const temporary = join(ROOT, '.gitknot', 'backup-chunks', snapshot.id);
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  const input = await open(snapshot.file, 'r');
  try {
    // Stay well below the cf R2 object endpoint's 300 MB upload limit.
    for (let offset = 0, number = 0; offset < snapshot.bytes; number++) {
      const length = Math.min(64 * 1024 * 1024, snapshot.bytes - offset);
      const bytes = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const part = await input.read(bytes, filled, length - filled, offset + filled);
        if (!part.bytesRead) throw new Error('SQL snapshot changed or was truncated during upload.');
        filled += part.bytesRead;
      }
      const file = join(temporary, 'chunk');
      await writeFile(file, bytes, { mode: 0o600 });
      const objectKey = `${prefix}/${String(number).padStart(8, '0')}.sql.part`;
      const args = ['r2', 'objects', 'put', objectKey, '--bucket-name', bucket, '--file', file, '--content-type', 'application/octet-stream'];
      if (env.jurisdiction) args.push('--cf-r2-jurisdiction', env.jurisdiction);
      const uploaded = object(result(JSON.parse(await cf(args, { env: cliEnv, capture: true, timeout: 300_000 }))));
      if (Number(uploaded.size) !== length) throw new Error('R2 did not confirm the uploaded snapshot chunk size.');
      parts.push({ key: objectKey, bytes: length, sha256: createHash('sha256').update(bytes).digest('hex') });
      offset += length;
    }
    const stored: D1Snapshot = { ...snapshot, r2: { account_id: account, bucket, ...(env.jurisdiction ? { jurisdiction: env.jurisdiction } : {}), manifest_key: `${prefix}/manifest.json`, parts } };
    const manifest = join(temporary, 'manifest.json');
    await writeJson(manifest, stored);
    const args = ['r2', 'objects', 'put', stored.r2!.manifest_key, '--bucket-name', bucket, '--file', manifest, '--content-type', 'application/json'];
    if (env.jurisdiction) args.push('--cf-r2-jurisdiction', env.jurisdiction);
    await cf(args, { env: cliEnv, capture: true, timeout: 120_000 });
    return stored;
  } finally { await input.close(); await rm(temporary, { recursive: true, force: true }); }
}

export async function loadD1Snapshot(path: string): Promise<D1Snapshot> {
  return d1SnapshotSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
