import { Context } from 'hono';
import { ApiError, eventStatement, getRepository, identityBinding, now, one, readBounded, requirePrincipal, resolveResourceLocator,
  routeRepositoryRequest, selectIdentityDatabase, sha256, stmt } from '@gitknot/core';
import type { AppContext, AppEnv } from '@gitknot/core';
import { authorizeCodeScanObject } from './code-scans.ts';
import { consumeOnce } from './durable.ts';
import { shardEnvironment } from './placement.ts';
import type { StoredObject } from './objects.ts';
import type { OperationsBindings } from './types.ts';

function freshContext(c: AppContext, url = c.req.url): AppContext {
  const headers = new Headers();
  for (const name of ['authorization', 'cookie', 'user-agent']) {
    const value = c.req.header(name); if (value) headers.set(name, value);
  }
  const fresh = new Context<AppEnv>(new Request(url, { headers }), { env: c.env });
  fresh.set('principal', requirePrincipal(c)); fresh.set('requestId', c.get('requestId'));
  selectIdentityDatabase(fresh);
  return fresh;
}

/** The scan link is primary-owned; bytes and mutable manifest state come from their current repository placement. */
export async function readCodeScanResult(c: AppContext, objectId: string, redirects = 0): Promise<Uint8Array<ArrayBuffer>> {
  if (redirects > 2) throw new ApiError(409, 'scan_placement_changed', 'The scan result moved. Retry its current URL.');
  const context = freshContext(c);
  await authorizeCodeScanObject(context, objectId);
  const link = await one<{ repo_id: string; sha256: string; bytes: number }>(identityBinding(c.env).withSession('first-primary'),
    'SELECT repo_id,sha256,bytes FROM collaboration_code_scan_chunks WHERE object_id=?', objectId);
  const locator = await resolveResourceLocator(c.env, objectId, 'object');
  if (!link || !locator || locator.repo_id !== link.repo_id || locator.authority !== 'repository') throw new ApiError(404, 'not_found', 'The scan result was not found.');
  const repo = await getRepository(context, link.repo_id, 'contents.read');
  let bytes: Uint8Array<ArrayBuffer>;
  if (repo.cell_id !== c.env.CELL_ID) {
    const target = freshContext(c, new URL(`/v1/objects/${encodeURIComponent(objectId)}/scan-content`, c.env.API_ORIGIN).href);
    const response = await routeRepositoryRequest(target, repo.id);
    if (!response) return readCodeScanResult(target, objectId, redirects + 1);
    if (!response.ok) { await response.body?.cancel(); throw new ApiError(response.status === 404 ? 404 : 503, 'scan_result_unavailable', 'The current scan result authority is unavailable.'); }
    bytes = await readBounded(response.body, 8 * 1024 * 1024);
  } else {
    const env = shardEnvironment(c.env, repo.shard_id);
    const object = await one<StoredObject>(env.DB.withSession('first-primary'), `SELECT * FROM object_manifests WHERE id=? AND repo_id=?
      AND kind='collaboration_code_scan' AND state='ready'`, objectId, repo.id);
    if (!object || object.account_id !== repo.owner_id || object.sha256 !== link.sha256 || object.bytes !== link.bytes) throw new ApiError(503, 'scan_result_unavailable', 'The current scan result manifest is unavailable.');
    const stored = await env.BLOBS.get(object.object_key);
    if (!stored || stored.size !== object.bytes || stored.customMetadata?.repo_id !== repo.id || stored.customMetadata?.object_id !== objectId) {
      throw new ApiError(503, 'scan_result_unavailable', 'A retained scan result chunk is unavailable.');
    }
    bytes = await readBounded(stored.body, 8 * 1024 * 1024);
  }
  if (bytes.byteLength !== link.bytes || await sha256(bytes) !== link.sha256) throw new ApiError(503, 'scan_result_corrupt', 'The scan result failed checksum verification.');
  await authorizeCodeScanObject(freshContext(c), objectId);
  return bytes;
}

/** Fence primary publication before a funded chunk can be physically removed. */
export async function invalidateCodeScanObject(env: OperationsBindings, object: StoredObject): Promise<void> {
  if (object.kind !== 'collaboration_code_scan') return;
  const db = identityBinding(env).withSession('first-primary');
  const scanId = object.object_key.split('/')[3];
  const scan = await one<{ id: string; operation_id: string; principal_id: string; revision: number }>(db,
    `SELECT s.id,s.operation_id,s.principal_id,s.revision FROM collaboration_code_scans s WHERE s.id=? AND s.principal_id=?
      AND EXISTS(SELECT 1 FROM collaboration_code_scan_repositories r WHERE r.scan_id=s.id AND r.repo_id=?)`, scanId, object.created_by, object.repo_id);
  if (!scan) throw new Error('scan_storage_authority_missing');
  await consumeOnce(db, 'scan-storage-expiry', object.id, [
    stmt(db, `UPDATE collaboration_code_scans SET state='failed',failure_code='scan_storage_expired',revision=revision+1,updated_at=?
      WHERE id=? AND principal_id=? AND state<>'cancelled'`, now(), scan.id, scan.principal_id),
    stmt(db, `UPDATE operations SET status='failed',error_json=?,revision=revision+1,updated_at=? WHERE id=? AND status NOT IN ('cancelled','completed')`,
      JSON.stringify({ code: 'scan_storage_expired', retryable: false }), now(), scan.operation_id),
    eventStatement(db, { type: 'search.code_scan_storage_expired', resource_id: scan.id, resource_revision: scan.revision + 1,
      actor_id: scan.principal_id, data: { object_id: object.id } }),
  ]);
}
