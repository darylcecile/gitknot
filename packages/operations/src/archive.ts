import { createHash } from 'node:crypto';
import { boundedStream, canonicalJson, execute, getRepository, hex, many, newId, now, one, registerResourceLocator, sha256, stmt } from '@gitknot/core';
import type { Bindings, Database, Repository } from '@gitknot/core';
import { deleteExpiredObjects, putObject } from './objects.ts';
import { privateRequest } from './private.ts';
import { operationActor } from './lifecycle.ts';
import { backgroundContext } from './authorization.ts';
import { archiveAudienceIds, authorizeArchiveSources, captureArchiveAudiences, captureArchiveRefAudiences, retainArchiveAudiences } from './archive-access.ts';
import type { ArchiveRefAudience } from './archive-access.ts';
import { verifiedBundleStream } from './bundle.ts';
import { retainedStorageReceipt } from './storage-evidence.ts';
import type { StoredObject } from './objects.ts';
import { materializeArchiveSnapshot, portableTables, verifySnapshotClosure } from './archive-snapshot.ts';
import { ownerBatch, ownerExecute } from './metadata-fence.ts';
import { requireMaintenanceAuthority } from './maintenance-authority.ts';
import { requireSharedArchiveSnapshot } from './archive-privacy.ts';
export { authorizeArchive, archiveAuthorizer } from './archive-access.ts';
import type { Operation, OperationsBindings } from './types.ts';

export interface ArchivePart { path: string; object_key: string; bucket: 'BLOBS' | 'BACKUPS'; sha256: string; bytes: number; media_type: string }
export interface ArchiveManifest {
  format: 'gitknot.repository'; version: 1; archive_id: string; created_at: string;
  repository: Repository; tables: string[]; parts: ArchivePart[];
  audience_repo_ids: string[];
  ref_audiences?: ArchiveRefAudience[];
  privacy?: { version: 1; private_user_state: 'excluded' };
  git: { encoding: 'git-bundle-v2-or-v3' | 'empty'; parts_prefix: 'git/'; refs: { ref: string; oid: string }[]; sha256: string; bytes: number };
  exclusions: string[];
}

async function putPart(env: OperationsBindings, operation: Operation, archiveId: string, path: string, data: Uint8Array, type: string, expires: string): Promise<ArchivePart> {
  if (path.startsWith('metadata/')) {
    const frozen = await one<ArchivePart>(env.DB, 'SELECT path,object_key,bucket,sha256,bytes,media_type FROM archive_parts WHERE archive_id=? AND path=?', archiveId, path);
    if (frozen) { await verifiedPart(env, frozen); return frozen; }
  }
  const digest = await sha256(data);
  const id = `obj_${await sha256(`${archiveId}:${path}`)}`;
  const key = `${operation.account_id}/${operation.repo_id}/archives/${archiveId}/${path}`;
  const object = await putObject(env, { id, repo_id: operation.repo_id!, account_id: operation.account_id!, actor_id: operation.actor_id,
    kind: 'archive_chunk', key, data, content_type: type, retention_until: expires, bucket: 'backups', referenced: true, operation_id: operation.id });
  if (object.sha256 !== digest) throw new Error('archive_part_conflict');
  const part: ArchivePart = { path, object_key: key, bucket: 'BACKUPS', sha256: digest, bytes: data.byteLength, media_type: type };
  await ownerExecute(env, operation.repo_id!, operation.id, `INSERT OR IGNORE INTO archive_parts(archive_id,path,object_key,bucket,sha256,bytes,media_type) VALUES(?,?,?,?,?,?,?)`,
    archiveId, path, key, part.bucket, digest, part.bytes, type);
  return part;
}

export async function* chunks(stream: ReadableStream<Uint8Array>, size = 4 * 1024 * 1024): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let buffer = new Uint8Array(size);
  let used = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      let offset = 0;
      while (offset < value.byteLength) {
        const length = Math.min(size - used, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + length), used);
        used += length; offset += length;
        if (used === size) { yield buffer; buffer = new Uint8Array(size); used = 0; }
      }
    }
    if (used) yield buffer.subarray(0, used);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

async function copyStream(env: OperationsBindings, operation: Operation, archiveId: string, prefix: string, open: () => Promise<ReadableStream<Uint8Array>>, expires: string): Promise<{ sha256: string; bytes: number }> {
  const db = env.DB.withSession('first-primary');
  const prior = await one<{ state: string; generation: string; sha256: string; bytes: number }>(db, 'SELECT * FROM archive_components WHERE archive_id=? AND component=?', archiveId, prefix);
  if (prior?.state === 'complete') {
    if (!/^[a-f0-9]{64}$/.test(prior.sha256) || !Number.isSafeInteger(prior.bytes) || prior.bytes < 0) throw new Error('archive_component_integrity');
    return { sha256: prior.sha256, bytes: prior.bytes };
  }
  // Short generation names keep opaque object paths within the portable USTAR name bound.
  let generation = newId('partset').slice(-12);
  for (let collision = 0; collision < 5; collision++) {
    const stem = `${prefix}/${generation}/`;
    if (generation !== prior?.generation && !await one(db, 'SELECT 1 FROM archive_parts WHERE archive_id=? AND substr(path,1,?)=? LIMIT 1', archiveId, stem.length, stem)) break;
    if (collision === 4) throw new Error('archive_generation_conflict');
    generation = newId('partset').slice(-12);
  }
  if (prior) {
    const oldPrefix = `${operation.account_id}/${operation.repo_id}/archives/${archiveId}/${prefix}/${prior.generation}/`;
    await ownerExecute(env, operation.repo_id!, operation.id, `UPDATE object_manifests SET reference_count=0,retention_until=?,revision=revision+1,updated_at=?
      WHERE repo_id=? AND kind='archive_chunk' AND substr(object_key,1,?)=? AND state<>'deleted'`, now(), now(), operation.repo_id, oldPrefix.length, oldPrefix);
    while (await deleteExpiredObjects(env, operation.repo_id!, operation.id) === 100) { /* Reclaim obsolete immutable parts before restarting the component. */ }
  }
  await ownerExecute(env, operation.repo_id!, operation.id, `INSERT INTO archive_components(archive_id,component,generation,state,updated_at) VALUES(?,?,?,'writing',?)
    ON CONFLICT(archive_id,component) DO UPDATE SET generation=excluded.generation,state='writing',sha256=NULL,bytes=NULL,updated_at=excluded.updated_at
    WHERE archive_components.state='writing'`, archiveId, prefix, generation, now());
  const owned = await one(db, `SELECT 1 FROM archive_components WHERE archive_id=? AND component=? AND generation=? AND state='writing'`, archiveId, prefix, generation);
  if (!owned) throw new Error('archive_component_advanced');
  const stream = await open();
  let index = 0;
  let bytes = 0;
  const hash = createHash('sha256');
  for await (const chunk of chunks(stream)) {
    hash.update(chunk); bytes += chunk.byteLength;
    await putPart(env, operation, archiveId, `${prefix}/${generation}/${String(index++).padStart(8, '0')}`, chunk, 'application/octet-stream', expires);
  }
  const digest = hash.digest('hex');
  const saved = await ownerExecute(env, operation.repo_id!, operation.id, `UPDATE archive_components SET state='complete',sha256=?,bytes=?,updated_at=? WHERE archive_id=? AND component=? AND generation=? AND state='writing'`, digest, bytes, now(), archiveId, prefix, generation);
  if (saved.meta.changes !== 1) throw new Error('archive_component_superseded');
  return { sha256: digest, bytes };
}

async function archiveMetadata(env: OperationsBindings, operation: Operation, archiveId: string, tables: string[], expires: string): Promise<void> {
  const db = env.DB.withSession('first-primary');
  await requireSharedArchiveSnapshot(db, archiveId);
  for (const table of tables) {
    let cursor = 0;
    let page = 0;
    while (true) {
      const snapshot = await many<{ row_key: number; data_json: string }>(db, `SELECT row_key,data_json FROM archive_snapshot_rows
        WHERE archive_id=? AND table_name=? AND row_key>? ORDER BY row_key LIMIT 10`, archiveId, table, cursor);
      const rows = snapshot.map<Record<string, unknown> & { __cursor: number }>(row => ({
        ...JSON.parse(row.data_json) as Record<string, unknown>, __cursor: row.row_key,
      }));
      if (!rows.length) break;
      cursor = Number(rows.at(-1)!.__cursor);
      const safe = rows.filter((row) => (table !== 'object_manifests' || !['archive_chunk', 'scan_chunk', 'collaboration_code_scan', 'cache', 'snapshot'].includes(String(row.kind)))
        && (table !== 'execution_objects' || ['log', 'output', 'manifest'].includes(String(row.kind)))).map(({ __cursor, ...row }) => {
        void __cursor;
        if (table === 'execution_attempts') {
          row.credential_hash = null; row.runtime_id = null; row.runtime_name = null; row.process_id = null;
          row.runner_id = null; row.runner_credential_generation = null;
          row.runner_credential_hash = null; row.runner_slot_fence = null;
        }
        return row;
      });
      const sourceField = table === 'pull_requests' || table === 'pull_patches' ? 'head_repo_id'
        : table === 'git_candidates' || table === 'git_review_snapshots' ? 'source_repo_id' : table === 'task_workspaces' ? 'workspace_repo_id' : null;
      if (sourceField) await retainArchiveAudiences(db, archiveId, safe.flatMap((row) => typeof row[sourceField] === 'string' ? [row[sourceField] as string] : []));
      let group: Record<string, unknown>[] = [];
      let size = 2;
      const flush = async () => {
        if (!group.length) return;
        await putPart(env, operation, archiveId, `metadata/${table}/snapshot-v2/${String(page++).padStart(8, '0')}.json`, new TextEncoder().encode(canonicalJson(group)), 'application/json', expires);
        group = []; size = 2;
      };
      for (const row of safe) {
        const bytes = new TextEncoder().encode(canonicalJson(row)).byteLength;
        if (size + bytes > 4 * 1024 * 1024) await flush();
        if (bytes > 4 * 1024 * 1024) throw new Error('archive_metadata_row_limit');
        group.push(row); size += bytes + 1;
      }
      await flush();
    }
  }
}

async function archiveObjects(env: OperationsBindings, operation: Operation, archiveId: string, expires: string): Promise<void> {
  const db = env.DB.withSession('first-primary');
  // Follow the captured manifest rows, so concurrent expiry cannot silently omit a referenced object on retry.
  const parts = await many<ArchivePart>(db, `SELECT path,object_key,bucket,sha256,bytes,media_type FROM archive_parts WHERE archive_id=? AND
    (path LIKE 'metadata/object_manifests/snapshot-v2/%' OR path LIKE 'metadata/git_lfs_objects/snapshot-v2/%' OR path LIKE 'metadata/execution_objects/snapshot-v2/%') ORDER BY path`, archiveId);
  for (const part of parts) {
    const table = part.path.split('/')[1];
    const rows = JSON.parse(new TextDecoder().decode(await verifiedPart(env, part))) as Record<string, string | number>[];
    for (const row of rows) {
      const eligible = table === 'git_lfs_objects' ? row.state === 'available' : table === 'execution_objects'
        ? row.state === 'sealed' && ['log', 'output', 'manifest'].includes(String(row.kind)) : row.state === 'ready';
      if (!eligible) continue;
      const lfs = table === 'git_lfs_objects';
      const bucket = row.bucket === 'backups' ? env.BACKUPS : env.BLOBS;
      const prefix = `${lfs ? 'lfs' : table === 'execution_objects' ? 'execution' : 'objects'}/${lfs ? row.oid : row.id}`;
      const copied = await copyStream(env, operation, archiveId, prefix, async () => {
        const object = await bucket.get(String(lfs ? row.storage_key : row.object_key));
        if (!object) throw new Error('archive_referenced_object_missing');
        return object.body;
      }, expires);
      if (copied.sha256 !== (lfs ? row.oid : row.sha256)) throw new Error('archive_object_checksum_mismatch');
      const expectedBytes = Number(lfs ? row.size : table === 'execution_objects' ? row.size_bytes : row.bytes);
      if (!Number.isSafeInteger(expectedBytes) || expectedBytes !== copied.bytes) throw new Error('archive_object_size_mismatch');
    }
  }
}

export async function createArchive(env: OperationsBindings, operation: Operation, repository: Repository, refs: { ref: string; oid: string }[], kind: 'export' | 'backup' | 'deletion' | 'move'): Promise<{ archive_id: string; manifest_key: string; sha256: string; bytes: number }> {
  const db = env.DB.withSession('first-primary');
  const archiveId = `archive_${operation.id}`;
  await registerResourceLocator(env, { resource_id: archiveId, resource_type: 'archive', repo_id: repository.id });
  const existing = await one<{ state: string; manifest_key: string; manifest_sha256: string; archive_sha256: string | null; bytes: number; expires_at: string }>(db, 'SELECT state,manifest_key,manifest_sha256,archive_sha256,bytes,expires_at FROM repository_archives WHERE id=?', archiveId);
  const expires = existing?.expires_at ?? new Date(Date.now() + (kind === 'export' ? 7 : 35) * 86400_000).toISOString();
  if (existing?.state === 'expired') throw new Error('archive_capture_abandoned');
  if (existing?.state === 'verified') {
    const manifest = await readArchive(env, archiveId, repository.id);
    if (!existing.archive_sha256) {
      const archive = await checksumArchive(env, manifest);
      await ownerExecute(env, repository.id, operation.id, 'UPDATE repository_archives SET archive_sha256=?,bytes=? WHERE id=? AND archive_sha256 IS NULL', archive.sha256, archive.bytes, archiveId);
      return { archive_id: archiveId, manifest_key: existing.manifest_key, ...archive };
    }
    return { archive_id: archiveId, manifest_key: existing.manifest_key, sha256: existing.archive_sha256, bytes: existing.bytes };
  }
  await ownerExecute(env, repository.id, operation.id, `INSERT OR IGNORE INTO repository_archives(id,operation_id,repo_id,account_id,kind,state,routing_epoch,revision,created_at,expires_at)
    VALUES(?,?,?,?,?,'writing',?,?,?,?)`, archiveId, operation.id, repository.id, repository.owner_id, kind, repository.routing_epoch, repository.revision, now(), expires);
  const initialAudiences = await captureArchiveAudiences(db, archiveId, repository.id);
  const refAudiences = await captureArchiveRefAudiences(db, archiveId, repository.id, refs);
  if (kind === 'export') {
    const context = backgroundContext(env, await operationActor(env, operation), repository);
    await authorizeArchiveSources(context, repository.id, initialAudiences);
    if (await one(db, 'SELECT 1 FROM workflow_runs WHERE repo_id=? LIMIT 1', repository.id)) await getRepository(context, repository.id, 'runs.read');
  }
  const tables = await materializeArchiveSnapshot(env, operation.id, archiveId, repository, refs);
  const git = await copyStream(env, operation, archiveId, 'git', async () => {
    if (refs.length === 0) return new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
    const maintenance = (JSON.parse(operation.input_json) as { maintenance?: boolean }).maintenance === true;
    const barrierToken = `${kind === 'move' ? 'move' : 'lifecycle'}_${operation.id}`;
    if (maintenance) {
      if (kind !== 'backup' && kind !== 'move') throw new Error('maintenance_archive_purpose_invalid');
      await requireMaintenanceAuthority(env, repository.id, operation.id, kind === 'move' ? 'repository.move' : 'repository.backup', barrierToken);
    }
    const response = await privateRequest(env, env.GIT_SERVICE, 'git-service', `/internal/git/repositories/${repository.id}/export`, {
      operation_id: operation.id, ...(maintenance ? { barrier_token: barrierToken } : { actor: await operationActor(env, operation) }), include_retained_refs: true,
    });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('native_export_failed'); }
    const length = Number(response.headers.get('content-length'));
    if (!Number.isSafeInteger(length) || length <= 0) { await response.body.cancel(); throw new Error('native_export_size_unverified'); }
    return verifiedBundleStream(boundedStream(response.body, length, length), refs);
  }, expires);
  await archiveMetadata(env, operation, archiveId, tables, expires);
  await archiveObjects(env, operation, archiveId, expires);
  await verifySnapshotClosure(db, 'archive_snapshot_rows', 'archive_id', archiveId, tables);
  // Include cached metadata pages from earlier attempts, even when their source records changed later.
  const historical = await many<ArchivePart>(db, `SELECT path,object_key,bucket,sha256,bytes,media_type FROM archive_parts WHERE archive_id=? AND
    (path LIKE 'metadata/pull_requests/snapshot-v2/%' OR path LIKE 'metadata/pull_patches/snapshot-v2/%' OR path LIKE 'metadata/git_candidates/snapshot-v2/%'
      OR path LIKE 'metadata/git_review_snapshots/snapshot-v2/%' OR path LIKE 'metadata/task_workspaces/snapshot-v2/%')`, archiveId);
  for (const part of historical) {
    const rows = JSON.parse(new TextDecoder().decode(await verifiedPart(env, part))) as Record<string, unknown>[];
    await retainArchiveAudiences(db, archiveId, rows.flatMap((row) => [row.head_repo_id, row.source_repo_id, row.workspace_repo_id].filter((value): value is string => typeof value === 'string')));
  }
  const audiences = await archiveAudienceIds(db, archiveId);
  if (kind === 'export') await authorizeArchiveSources(backgroundContext(env, await operationActor(env, operation), repository), repository.id, audiences);
  const parts = await many<ArchivePart>(db, `SELECT p.path,p.object_key,p.bucket,p.sha256,p.bytes,p.media_type FROM archive_parts p
    WHERE p.archive_id=? AND p.path<>'manifest.json' AND (p.path GLOB 'metadata/*/snapshot-v2/*' OR EXISTS(SELECT 1 FROM archive_components c
      WHERE c.archive_id=p.archive_id AND c.state='complete' AND substr(p.path,1,length(c.component||'/'||c.generation||'/'))=c.component||'/'||c.generation||'/')) ORDER BY p.path`, archiveId);
  if (parts.length > 20_000) throw new Error('archive_manifest_limit');
  const manifest: ArchiveManifest = { format: 'gitknot.repository', version: 1, archive_id: archiveId, created_at: operation.created_at,
    repository, tables, parts, audience_repo_ids: audiences, ref_audiences: refAudiences, privacy: { version: 1, private_user_state: 'excluded' },
    git: { encoding: refs.length ? 'git-bundle-v2-or-v3' : 'empty', parts_prefix: 'git/', refs, ...git },
    exclusions: ['credential material', 'tenant secret values', 'private user drafts and draft history (available only in the owner-scoped account export)',
      'personal inbox and subscriptions', 'rebuildable indexes', 'ephemeral runner disks and caches', 'provider diagnostic payloads'] };
  const bytes = new TextEncoder().encode(canonicalJson(manifest));
  const final = await putPart(env, operation, archiveId, 'manifest.json', bytes, 'application/json', expires);
  const archive = await checksumArchive(env, manifest);
  await ownerBatch(env, repository.id, operation.id, [stmt(db, `UPDATE repository_archives SET state='verified',manifest_key=?,manifest_sha256=?,archive_sha256=?,audience_sha256=?,bytes=?,verified_at=? WHERE id=? AND state='writing'`,
    final.object_key, final.sha256, archive.sha256, await sha256(canonicalJson(audiences)), archive.bytes, now(), archiveId)]);
  return { archive_id: archiveId, manifest_key: final.object_key, ...archive };
}

async function checksumArchive(env: Bindings, manifest: ArchiveManifest): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let size = 0;
  // The fenced lifecycle operation owns this private verification read; every R2 part is checksum-validated.
  const stream = portableArchiveStream(env, manifest, async () => undefined);
  for await (const chunk of chunks(stream)) { hash.update(chunk); size += chunk.byteLength; }
  return { sha256: hash.digest('hex'), bytes: size };
}

export async function readArchive(env: Bindings, id: string, repoId: string): Promise<ArchiveManifest> {
  const row = await one<{ manifest_key: string; manifest_sha256: string; audience_sha256: string | null }>(env.DB.withSession('first-primary'),
    `SELECT manifest_key,manifest_sha256,audience_sha256 FROM repository_archives WHERE id=? AND repo_id=? AND state='verified' AND expires_at>?`, id, repoId, now());
  if (!row) throw new Error('archive_not_available');
  const object = await env.BACKUPS.get(row.manifest_key);
  if (!object || object.size > 8 * 1024 * 1024) throw new Error('archive_manifest_missing');
  const data = new Uint8Array(await object.arrayBuffer());
  if (await sha256(data) !== row.manifest_sha256) throw new Error('archive_manifest_corrupt');
  const manifest = JSON.parse(new TextDecoder().decode(data)) as ArchiveManifest;
  if (manifest.format !== 'gitknot.repository' || manifest.version !== 1 || manifest.repository.id !== repoId || manifest.archive_id !== id) throw new Error('archive_identity_mismatch');
  if (!Array.isArray(manifest.audience_repo_ids) || !manifest.audience_repo_ids.includes(repoId)
    || !row.audience_sha256 || await sha256(canonicalJson(manifest.audience_repo_ids)) !== row.audience_sha256) throw new Error('archive_audience_unverified');
  // The checksummed manifest carries this source-capture proof through a move
  // or restore that does not copy the original materialization tables.
  if (manifest.privacy?.version !== 1 || manifest.privacy.private_user_state !== 'excluded') await requireSharedArchiveSnapshot(env.DB.withSession('first-primary'), id);
  return manifest;
}

export async function verifiedPart(env: Bindings, part: ArchivePart): Promise<Uint8Array> {
  if (part.bytes > 8 * 1024 * 1024 || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/archives\//.test(part.object_key)) throw new Error('archive_part_invalid');
  const object = await (part.bucket === 'BACKUPS' ? env.BACKUPS : env.BLOBS).get(part.object_key);
  if (!object || object.size !== part.bytes) throw new Error('archive_part_missing');
  const data = new Uint8Array(await object.arrayBuffer());
  if (await sha256(data) !== part.sha256) throw new Error('archive_part_corrupt');
  return data;
}

export function archiveStream(env: Bindings, manifest: ArchiveManifest, prefix: string, authorizePart?: () => Promise<void>): ReadableStream<Uint8Array> {
  const parts = manifest.parts.filter((part) => part.path.startsWith(prefix)).sort((a, b) => a.path.localeCompare(b.path));
  let index = 0;
  return new ReadableStream({ async pull(controller) {
    const part = parts[index++];
    if (!part) { controller.close(); return; }
    try {
      await authorizePart?.();
      const bytes = await verifiedPart(env, part);
      await authorizePart?.();
      controller.enqueue(bytes);
    } catch (error) { controller.error(error); }
  } }, { highWaterMark: 0 });
}

export async function verifyArchive(env: Bindings, manifest: ArchiveManifest): Promise<void> {
  for (const part of manifest.parts) await verifiedPart(env, part);
}

export function isPortableTable(table: string): boolean { return portableTables.includes(table); }

export function tarHeader(path: string, size: number, timestamp: number): Uint8Array {
  if (new TextEncoder().encode(path).byteLength > 100 || !/^[A-Za-z0-9_./-]+$/.test(path) || path.includes('..')) throw new Error('invalid_archive_path');
  const header = new Uint8Array(512);
  const text = (offset: number, value: string) => header.set(new TextEncoder().encode(value), offset);
  const octal = (offset: number, value: number, length: number) => {
    const encoded = value.toString(8).padStart(length - 1, '0');
    if (encoded.length >= length) throw new Error('tar_value_too_large');
    text(offset, `${encoded}\0`);
  };
  text(0, path); octal(100, 0o644, 8); octal(108, 0, 8); octal(116, 0, 8);
  octal(124, size, 12); octal(136, timestamp, 12); header.fill(32, 148, 156);
  text(156, '0'); text(257, 'ustar\0'); text(263, '00'); text(265, 'gitknot'); text(297, 'gitknot');
  const sum = header.reduce((total, value) => total + value, 0);
  text(148, `${sum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

/** POSIX tar contains an ordinary complete Git bundle plus canonical JSON and binary objects. */
export function portableArchiveStream(env: Bindings, manifest: ArchiveManifest, authorizePart: () => Promise<void>): ReadableStream<Uint8Array> {
  async function* content(): AsyncGenerator<Uint8Array> {
    await authorizePart();
    const { storage_name, cell_id, shard_id, ...repository } = manifest.repository;
    void storage_name; void cell_id; void shard_id;
    const timestamp = Math.floor(Date.parse(manifest.created_at) / 1000);
    const publicManifest = new TextEncoder().encode(canonicalJson({ ...manifest, repository,
      parts: manifest.parts.map(({ object_key, bucket, ...part }) => { void object_key; void bucket; return part; }) }));
    yield tarHeader('manifest.json', publicManifest.byteLength, timestamp); yield publicManifest;
    if (publicManifest.byteLength % 512) yield new Uint8Array(512 - publicManifest.byteLength % 512);
    yield tarHeader('repository.bundle', manifest.git.bytes, timestamp);
    for (const part of manifest.parts.filter((entry) => entry.path.startsWith('git/')).sort((a, b) => a.path.localeCompare(b.path))) {
      await authorizePart(); yield await verifiedPart(env, part);
    }
    if (manifest.git.bytes % 512) yield new Uint8Array(512 - manifest.git.bytes % 512);
    for (const part of manifest.parts.filter((entry) => !entry.path.startsWith('git/'))) {
      await authorizePart();
      yield tarHeader(part.path, part.bytes, timestamp); yield await verifiedPart(env, part);
      if (part.bytes % 512) yield new Uint8Array(512 - part.bytes % 512);
    }
    yield new Uint8Array(1024);
  }
  const iterator = content();
  return new ReadableStream({ async pull(controller) {
    try {
      const result = await iterator.next();
      if (result.done) controller.close();
      else { await authorizePart(); controller.enqueue(result.value); }
    }
    catch (error) { controller.error(error); }
  }, async cancel() { await iterator.return(undefined); } }, { highWaterMark: 0 });
}

export async function restoreArchiveMetadata(env: OperationsBindings, manifest: ArchiveManifest, target: Database): Promise<void> {
  // Target identity/directory rows must already exist; a restore cannot manufacture account authority.
  const pending = new Set(manifest.tables);
  const ordered: string[] = [];
  while (pending.size) {
    let advanced = false;
    for (const table of pending) {
      if (!isPortableTable(table)) throw new Error('archive_table_not_allowed');
      const dependencies = await many<{ table: string }>(target, `PRAGMA foreign_key_list(${table})`);
      if (dependencies.some((entry) => entry.table !== table && pending.has(entry.table))) continue;
      ordered.push(table); pending.delete(table); advanced = true;
    }
    if (!advanced) throw new Error('archive_schema_cycle');
  }
  const parts = manifest.parts.filter((entry) => entry.path.startsWith('metadata/')).sort((a, b) => ordered.indexOf(a.path.split('/')[1]!) - ordered.indexOf(b.path.split('/')[1]!) || a.path.localeCompare(b.path));
  for (const part of parts) {
    const table = part.path.split('/')[1]!;
    if (!isPortableTable(table)) throw new Error('archive_table_not_allowed');
    const columns = await many<{ name: string }>(target, `PRAGMA table_info(${table})`);
    const names = new Set(columns.map((column) => column.name));
    const rows = JSON.parse(new TextDecoder().decode(await verifiedPart(env, part))) as Record<string, unknown>[];
    const statements: D1PreparedStatement[] = [];
    for (const row of rows) {
      if (row.repo_id !== manifest.repository.id) throw new Error('archive_row_scope_mismatch');
      const fields = Object.keys(row);
      if (fields.some((field) => !names.has(field) || !/^[a-z_][a-z_0-9]*$/.test(field))) throw new Error('archive_schema_mismatch');
      statements.push(stmt(target, `INSERT OR IGNORE INTO ${table}(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`, ...fields.map((field) => row[field])));
    }
    if (statements.length) await target.batch(statements);
  }
}

export async function restoreArchiveObjects(env: OperationsBindings, manifest: ArchiveManifest, target: OperationsBindings, authorizePart?: () => Promise<void>): Promise<void> {
  const objectRows = manifest.parts.filter((entry) => entry.path.startsWith('metadata/object_manifests/'));
  for (const part of objectRows) {
    const rows = JSON.parse(new TextDecoder().decode(await verifiedPart(env, part))) as { id: string; bytes: number; object_key: string; bucket: string; sha256: string; state: string }[];
    for (const row of rows) {
      if (row.state !== 'ready') continue;
      const current = await one<StoredObject>(target.DB.withSession('first-primary'), "SELECT * FROM object_manifests WHERE id=? AND repo_id=? AND state='ready'", row.id, manifest.repository.id);
      if (!current || current.object_key !== row.object_key || current.sha256 !== row.sha256 || current.bytes !== row.bytes) throw new Error('restore_live_manifest_unconfirmed');
      const receipt = await retainedStorageReceipt(target, { id: row.id, account_id: current.account_id, repo_id: manifest.repository.id,
        key: row.object_key, bucket: current.bucket, bytes: row.bytes, sha256: row.sha256 });
      if (receipt.storage_cell_id !== target.CELL_ID || receipt.fence !== current.billing_fence || receipt.reservation_id !== current.billing_reservation_id) throw new Error('restore_storage_placement_unconfirmed');
      const bucket = row.bucket === 'backups' ? target.BACKUPS : target.BLOBS;
      const present = await bucket.head(row.object_key);
      if (present && present.etag === receipt.etag && present.size === row.bytes && present.checksums.sha256
        && hex(new Uint8Array(present.checksums.sha256)) === row.sha256) continue;
      let body = archiveStream(env, manifest, `objects/${row.id}/`, authorizePart);
      if (typeof FixedLengthStream !== 'undefined') body = body.pipeThrough(new FixedLengthStream(row.bytes));
      await bucket.put(row.object_key, body, { sha256: row.sha256, customMetadata: { sha256: row.sha256, repo_id: manifest.repository.id,
        object_id: row.id, upload_generation: String(current.upload_generation) } });
      const stored = await bucket.head(row.object_key);
      if (!stored || stored.size !== row.bytes || stored.etag !== receipt.etag || !stored.checksums.sha256
        || hex(new Uint8Array(stored.checksums.sha256)) !== row.sha256) throw new Error('restore_object_unconfirmed');
    }
  }
  for (const part of manifest.parts.filter((entry) => entry.path.startsWith('metadata/git_lfs_objects/'))) {
    const rows = JSON.parse(new TextDecoder().decode(await verifiedPart(env, part))) as { oid: string; object_id: string; storage_key: string; size: number; state: string }[];
    for (const row of rows) {
      if (row.state !== 'available') continue;
      const current = await one<StoredObject>(target.DB.withSession('first-primary'), "SELECT * FROM object_manifests WHERE id=? AND repo_id=? AND state='ready'", row.object_id, manifest.repository.id);
      if (!current || current.object_key !== row.storage_key || current.bytes !== row.size || current.sha256 !== row.oid) throw new Error('restore_lfs_manifest_unconfirmed');
      const receipt = await retainedStorageReceipt(target, { id: row.object_id, account_id: current.account_id, repo_id: manifest.repository.id,
        key: row.storage_key, bucket: 'blobs', bytes: row.size, sha256: row.oid });
      if (receipt.storage_cell_id !== target.CELL_ID) throw new Error('restore_storage_placement_unconfirmed');
      const present = await target.BLOBS.head(row.storage_key);
      if (present && present.etag === receipt.etag && present.size === row.size && present.checksums.sha256
        && hex(new Uint8Array(present.checksums.sha256)) === row.oid) continue;
      let body = archiveStream(env, manifest, `lfs/${row.oid}/`, authorizePart);
      if (typeof FixedLengthStream !== 'undefined') body = body.pipeThrough(new FixedLengthStream(row.size));
      await target.BLOBS.put(row.storage_key, body, { sha256: row.oid, customMetadata: { sha256: row.oid, repo_id: manifest.repository.id, object_id: row.object_id,
        upload_generation: String(current.upload_generation) } });
      const stored = await target.BLOBS.head(row.storage_key);
      if (!stored || stored.size !== row.size || stored.etag !== receipt.etag || !stored.checksums.sha256
        || hex(new Uint8Array(stored.checksums.sha256)) !== row.oid) throw new Error('restore_lfs_unconfirmed');
    }
  }
  for (const part of manifest.parts.filter((entry) => entry.path.startsWith('metadata/execution_objects/'))) {
    const rows = JSON.parse(new TextDecoder().decode(await verifiedPart(env, part))) as { id: string; object_key: string; size_bytes: number; sha256: string; state: string; kind: string }[];
    for (const row of rows) {
      if (row.state !== 'sealed' || !['log', 'output', 'manifest'].includes(row.kind)) continue;
      const current = await one<{ account_id: string }>(target.DB.withSession('first-primary'), "SELECT account_id FROM execution_objects WHERE id=? AND repo_id=? AND state='sealed'", row.id, manifest.repository.id);
      if (!current) throw new Error('restore_execution_manifest_unconfirmed');
      const receipt = await retainedStorageReceipt(target, { id: row.id, account_id: current.account_id, repo_id: manifest.repository.id,
        key: row.object_key, bucket: 'blobs', bytes: row.size_bytes, sha256: row.sha256 });
      if (receipt.storage_cell_id !== target.CELL_ID) throw new Error('restore_storage_placement_unconfirmed');
      const present = await target.BLOBS.head(row.object_key);
      if (present && present.etag === receipt.etag && present.size === row.size_bytes && present.checksums.sha256
        && hex(new Uint8Array(present.checksums.sha256)) === row.sha256) continue;
      let body = archiveStream(env, manifest, `execution/${row.id}/`, authorizePart);
      if (typeof FixedLengthStream !== 'undefined') body = body.pipeThrough(new FixedLengthStream(row.size_bytes));
      await target.BLOBS.put(row.object_key, body, { sha256: row.sha256, customMetadata: { sha256: row.sha256, repo_id: manifest.repository.id } });
      const stored = await target.BLOBS.head(row.object_key);
      if (!stored || stored.size !== row.size_bytes || stored.etag !== receipt.etag || !stored.checksums.sha256
        || hex(new Uint8Array(stored.checksums.sha256)) !== row.sha256) throw new Error('restore_execution_object_unconfirmed');
    }
  }
}
