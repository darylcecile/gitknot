import { createHash } from 'node:crypto';
import { ApiError, canonicalJson, identityBinding, many, now, one, sha256, stmt } from '@gitknot/core';
import type { Principal } from '@gitknot/core';
import { admissionRequest } from '../../billing/src/transport.ts';
import type { StorageObject } from '../../billing/src/types.ts';
import { accountExport, accountExportPrincipal, authorizeAccountExport } from './account-export-state.ts';
import type { AccountExport, AccountExportPart } from './account-export-types.ts';
import { chunks } from './archive.ts';
import { putObject } from './objects.ts';
import type { StoredObject } from './objects.ts';
import { backgroundCell } from './placement.ts';
import { privateRequest } from './private.ts';
import type { OperationsBindings } from './types.ts';

export async function putAccountExportPart(env: OperationsBindings, exported: AccountExport, path: string, bytes: Uint8Array, rowCount: number | null): Promise<AccountExportPart> {
  const current = await accountExport(env, exported.id);
  if (!['capturing', 'verifying'].includes(current.state) || current.expires_at <= now()) throw new ApiError(409, 'account_export_closed', 'This account export is closed.');
  const object = await putObject(env, { id: `obj_${await sha256(`${exported.id}:${path}`)}`, repo_id: null, account_id: exported.account_id,
    actor_id: exported.created_by, kind: 'account_export_chunk', key: `${exported.account_id}/assets/exports/${exported.id}/${path}`, data: bytes,
    content_type: path.endsWith('.json') ? 'application/json' : 'application/octet-stream', retention_until: exported.expires_at, bucket: 'backups', referenced: true,
    operation_id: exported.operation_id });
  const value = { path, object_id: object.id, object_key: object.object_key, bytes: object.bytes, sha256: object.sha256, row_count: rowCount };
  await stmt(identityBinding(env), `INSERT OR IGNORE INTO account_export_parts(export_id,path,object_id,object_key,bytes,sha256,row_count)
    SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM account_exports WHERE id=? AND state IN ('capturing','verifying') AND expires_at>?)`,
  exported.id, path, object.id, object.object_key, object.bytes, object.sha256, rowCount, exported.id, now()).run();
  const saved = await one<AccountExportPart>(identityBinding(env), 'SELECT path,object_id,object_key,bytes,sha256,row_count FROM account_export_parts WHERE export_id=? AND path=?', exported.id, path);
  if (!saved || canonicalJson(saved) !== canonicalJson(value)) throw new Error('account_export_part_conflict');
  return saved;
}

export async function accountExportPartBytes(env: OperationsBindings, part: AccountExportPart, accountId: string): Promise<Uint8Array> {
  if (!Number.isSafeInteger(part.bytes) || part.bytes < 0 || part.bytes > 8 * 1024 * 1024) throw new Error('account_export_part_size');
  const receipt = await admissionRequest<StorageObject>(env, `account:${accountId}`, 'get-object', { object_id: part.object_id });
  if (receipt.state !== 'stored' || receipt.storage_cell_id !== env.CELL_ID || receipt.key !== part.object_key || receipt.bucket !== 'backups'
    || receipt.attribution.repo_id !== null || receipt.account_id !== accountId || receipt.bytes !== String(part.bytes) || receipt.checksum !== part.sha256) throw new Error('account_export_storage_unverified');
  const object = await env.BACKUPS.get(part.object_key);
  if (!object || object.size !== part.bytes || object.etag !== receipt.etag) throw new Error('account_export_part_missing');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await sha256(bytes) !== part.sha256) throw new Error('account_export_part_corrupt');
  return bytes;
}

export async function writeAccountMetadata(env: OperationsBindings, exported: AccountExport, principal: Principal): Promise<void> {
  for (const table of JSON.parse(exported.tables_json!) as string[]) {
    let after = 0, page = 0;
    for (;;) {
      const rows = await many<{ row_key: number; data_json: string }>(identityBinding(env),
        'SELECT row_key,data_json FROM account_export_rows WHERE export_id=? AND table_name=? AND row_key>? ORDER BY row_key LIMIT 10', exported.id, table, after);
      if (!rows.length) break;
      await authorizeAccountExport(env, principal, await accountExport(env, exported.id), true);
      let group: unknown[] = [], size = 2;
      const flush = async () => {
        if (!group.length) return;
        await putAccountExportPart(env, exported, `metadata/${table}/${String(page++).padStart(8, '0')}.json`, new TextEncoder().encode(canonicalJson(group)), group.length);
        group = []; size = 2;
      };
      for (const row of rows) {
        const bytes = new TextEncoder().encode(row.data_json).byteLength;
        if (bytes > 4 * 1024 * 1024) throw new Error('account_export_metadata_row_limit');
        if (size + bytes > 4 * 1024 * 1024) await flush();
        group.push(JSON.parse(row.data_json)); size += bytes + 1;
      }
      await flush(); after = rows.at(-1)!.row_key;
    }
  }
  const sources = await many<{ repository_id: string; table_name: string }>(identityBinding(env),
    'SELECT DISTINCT repository_id,table_name FROM account_export_repository_rows WHERE export_id=? ORDER BY repository_id,table_name', exported.id);
  for (const source of sources) {
    let after = 0, sequence = 0;
    for (;;) {
      const rows = await many<{ row_key: number; data_json: string }>(identityBinding(env), `SELECT row_key,data_json FROM account_export_repository_rows
        WHERE export_id=? AND repository_id=? AND table_name=? AND row_key>? ORDER BY row_key LIMIT 10`, exported.id, source.repository_id, source.table_name, after);
      if (!rows.length) break;
      await authorizeAccountExport(env, principal, await accountExport(env, exported.id), true);
      await putAccountExportPart(env, exported, `metadata/repository_${source.table_name}/${source.repository_id}/${String(sequence++).padStart(8, '0')}.json`,
        new TextEncoder().encode(canonicalJson(rows.map(row => JSON.parse(row.data_json)))), rows.length);
      after = rows.at(-1)!.row_key;
    }
  }
}

export async function accountAssetRequest(env: OperationsBindings, input: { export_id: string; object_id: string }): Promise<Response> {
  const exported = await accountExport(env, input.export_id), principal = await accountExportPrincipal(env, exported);
  if (exported.state !== 'capturing' || exported.expires_at <= now()) throw new Error('account_export_asset_capture_closed');
  await authorizeAccountExport(env, principal, exported, true);
  const frozen = await one<{ data_json: string }>(identityBinding(env), `SELECT data_json FROM account_export_rows WHERE export_id=? AND table_name='object_manifests'
    AND json_extract(data_json,'$.id')=? AND json_extract(data_json,'$.state')='ready'`, exported.id, input.object_id);
  const object = await one<StoredObject>(identityBinding(env), 'SELECT * FROM object_manifests WHERE id=? AND account_id=? AND repo_id IS NULL', input.object_id, exported.account_id);
  if (!frozen || !object || object.state !== 'ready') throw new Error('account_export_asset_unavailable');
  const snapshot = JSON.parse(frozen.data_json) as StoredObject;
  const billing = await admissionRequest<StorageObject>(env, `account:${exported.account_id}`, 'get-object', { object_id: object.id });
  if (snapshot.sha256 !== object.sha256 || snapshot.bytes !== object.bytes || billing.storage_cell_id !== env.CELL_ID || billing.state !== 'stored'
    || billing.key !== object.object_key || billing.checksum !== snapshot.sha256 || billing.bytes !== String(snapshot.bytes)) throw new Error('account_export_asset_changed');
  const stored = await (object.bucket === 'backups' ? env.BACKUPS : env.BLOBS).get(object.object_key);
  if (!stored || stored.size !== object.bytes || stored.etag !== billing.etag) throw new Error('account_export_asset_missing');
  async function* data() {
    for await (const bytes of chunks(stored!.body)) { await authorizeAccountExport(env, principal, await accountExport(env, exported.id), true); yield bytes; }
  }
  const iterator = data();
  return new Response(new ReadableStream({ async pull(controller) {
    try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); } catch (error) { controller.error(error); }
  }, async cancel() { await iterator.return(undefined); } }, { highWaterMark: 0 }), { headers: { 'content-length': String(object.bytes), 'x-gitknot-content-sha256': object.sha256 } });
}

export async function captureAccountAssets(env: OperationsBindings, exported: AccountExport, principal: Principal): Promise<void> {
  let after = 0;
  for (;;) {
    const rows = await many<{ row_key: number; data_json: string }>(identityBinding(env), `SELECT row_key,data_json FROM account_export_rows
      WHERE export_id=? AND table_name='object_manifests' AND row_key>? AND json_extract(data_json,'$.state')='ready' ORDER BY row_key LIMIT 10`, exported.id, after);
    if (!rows.length) return;
    for (const row of rows) {
      const object = JSON.parse(row.data_json) as StoredObject;
      if (await one(identityBinding(env), 'SELECT 1 FROM account_export_assets WHERE export_id=? AND object_id=?', exported.id, object.id)) continue;
      await authorizeAccountExport(env, principal, exported, true);
      const billing = await admissionRequest<StorageObject>(env, `account:${exported.account_id}`, 'get-object', { object_id: object.id });
      const input = { export_id: exported.id, object_id: object.id };
      const response = billing.storage_cell_id === env.CELL_ID ? await accountAssetRequest(env, input)
        : await privateRequest(env, backgroundCell(env, billing.storage_cell_id!), 'operations.maintenance', '/internal/account-exports/asset', input);
      if (!response.ok || !response.body) throw new Error('account_export_asset_unconfirmed');
      const hash = createHash('sha256'); let bytes = 0, sequence = 0;
      for await (const chunk of chunks(response.body)) {
        bytes += chunk.byteLength; if (bytes > object.bytes) throw new Error('account_export_asset_size');
        hash.update(chunk);
        await putAccountExportPart(env, exported, `assets/${object.id}/${String(sequence++).padStart(8, '0')}`, chunk, null);
      }
      if (bytes !== object.bytes || hash.digest('hex') !== object.sha256) throw new Error('account_export_asset_checksum');
      await stmt(identityBinding(env), 'INSERT OR IGNORE INTO account_export_assets(export_id,object_id,bytes,sha256) VALUES(?,?,?,?)', exported.id, object.id, bytes, object.sha256).run();
    }
    after = rows.at(-1)!.row_key;
  }
}
