import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ApiError, authorize, database, eventStatement, execute, identityAuthorityBindings, many, mutationGuard, newId, now, one,
  registerResourceLocator, requestDatabaseBinding, requestDatabaseLocation, requirePrincipal, stmt } from '@gitknot/core';
import type { AppContext, Bindings, Database, Principal, Repository } from '@gitknot/core';
import { boundedJson } from './protocol.ts';
import { GitError, requireValue } from './errors.ts';
import { readGitLimits, validateRef } from './policy.ts';
import { admitLfsStorage, beginLfsStorageWrite, commitLfsStorage, deleteUnusedLfsStorage, failedLfsInput } from './lfs-storage.ts';
import type { BilledLfsUpload } from './lfs-storage.ts';

const mediaType = 'application/vnd.git-lfs+json';
const lfsObjectSchema = z.object({ oid: z.string().regex(/^[a-f0-9]{64}$/u), size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
export const lfsBatchSchema = z.object({
  operation: z.enum(['upload', 'download']), objects: z.array(lfsObjectSchema).min(1).max(100),
  transfers: z.array(z.string().max(64)).max(10).optional(),
  ref: z.object({ name: z.string().max(1024) }).strict().nullish(), hash_algo: z.literal('sha256').optional(),
}).strict();

export interface LfsObject { repo_id: string; oid: string; size: number; storage_key: string; state: string; revision: number; created_at: string }
export interface LfsUpload extends BilledLfsUpload {
  repo_id: string; id: string; oid: string; size: number; actor_id: string; credential_id: string | null;
  ref: string | null; storage_key: string; state: 'reserving' | 'reserved' | 'uploading' | 'complete' | 'deleting' | 'expired'; expires_at: string;
}

export async function handleLfs(c: AppContext, repository: Repository, suffix: string, baseUrl: string): Promise<Response> {
  try {
    if (suffix === 'objects/batch' && c.req.method === 'POST') return await batch(c, repository, baseUrl);
    const upload = /^uploads\/([\w-]+)(\/verify)?$/u.exec(suffix);
    if (upload) {
      if (upload[2] && c.req.method === 'POST') return await verifyUpload(c, repository, upload[1]);
      if (!upload[2] && c.req.method === 'PUT') return await uploadObject(c, repository, upload[1]);
    }
    const object = /^objects\/([a-f0-9]{64})$/u.exec(suffix);
    if (object && ['GET', 'HEAD'].includes(c.req.method)) return await downloadObject(c, repository, object[1]);
    throw new GitError('not_found', 'Git LFS endpoint not found.', 404);
  } catch (error) {
    const known = error instanceof GitError || (error instanceof Error && 'status' in error && 'code' in error);
    const status = known ? Number((error as GitError).status) : 503;
    return Response.json({ message: known ? (error as Error).message : 'Git LFS storage is temporarily unavailable.', request_id: c.get('requestId') }, {
      status, headers: { 'content-type': mediaType, 'cache-control': 'no-store',
        ...(status === 401 ? { 'lfs-authenticate': 'Basic realm="GitKnot LFS"', 'www-authenticate': 'Basic realm="GitKnot"' } : {}),
      },
    });
  }
}

async function batch(c: AppContext, repository: Repository, base: string): Promise<Response> {
  const env = storageEnvironment(c);
  const parsed = lfsBatchSchema.safeParse(await boundedJson(c.req.raw, 128 * 1024));
  requireValue(parsed.success, 'invalid_lfs_batch', 'Invalid Git LFS batch request.', 422);
  const body = parsed.data;
  requireValue(!body.transfers || body.transfers.includes('basic'), 'lfs_transfer', 'GitKnot supports the basic LFS transfer adapter.', 422);
  const limits = readGitLimits(c.env.LIMITS_JSON);
  requireValue(body.objects.length <= limits.lfs_batch_objects, 'lfs_batch_limit', 'Git LFS batch contains too many objects.', 413);
  if (body.ref?.name) validateRef(body.ref.name);
  await authorize(c, body.operation === 'upload' ? 'lfs.write' : 'lfs.read', { repo_id: repository.id, ref: body.ref?.name, paths: [] });
  const actor = body.operation === 'upload' ? requirePrincipal(c) : c.get('principal');
  const results: Record<string, unknown>[] = [];
  for (const input of body.objects) {
    try {
      requireValue(input.size <= limits.lfs_object_bytes, 'lfs_object_limit', 'This LFS object exceeds the configured byte limit.', 413);
      const object = await one<LfsObject>(database(c), "SELECT * FROM git_lfs_objects WHERE repo_id=? AND oid=? AND state='available'", repository.id, input.oid);
      if (object) {
        requireValue(object.size === input.size, 'lfs_size_mismatch', 'Git LFS object size does not match the stored object.', 422);
        if (body.operation === 'upload') { results.push({ ...input }); continue; }
        results.push({ ...input, authenticated: false, actions: { download: { href: `${base}/objects/${input.oid}` } } });
        continue;
      }
      requireValue(body.operation === 'upload', 'lfs_not_found', 'Git LFS object not found.', 404);
      const upload = await reserveLfsUpload(env, repository.id, actor!, input, body.ref?.name ?? null);
      results.push({ ...input, authenticated: false, actions: {
        upload: { href: `${base}/uploads/${upload.id}`, expires_at: upload.expires_at },
        verify: { href: `${base}/uploads/${upload.id}/verify`, expires_at: upload.expires_at },
      } });
    } catch (error) {
      const known = error instanceof GitError || error instanceof ApiError;
      results.push({ ...input, error: { code: known ? error.status : 503,
        message: known ? error.message : 'Git LFS admission is temporarily unavailable.' } });
    }
  }
  return Response.json({ transfer: 'basic', hash_algo: 'sha256', objects: results }, { headers: { 'content-type': mediaType, 'cache-control': 'no-store' } });
}

export async function reserveLfsUpload(env: Bindings, repoId: string, actor: Principal, object: { oid: string; size: number }, ref: string | null): Promise<LfsUpload> {
  const db = env.DB.withSession('first-primary');
  const limits = readGitLimits(env.LIMITS_JSON);
  requireValue(object.size <= limits.lfs_object_bytes, 'lfs_object_limit', 'Git LFS object exceeds its size limit.', 413);
  const previous = await one<LfsUpload>(db, "SELECT * FROM git_lfs_uploads WHERE repo_id=? AND oid=? AND state IN ('reserving','reserved','uploading','deleting')", repoId, object.oid);
  if (previous) {
    requireValue(previous.actor_id === actor.id && previous.size === object.size && previous.expires_at > now(),
      'lfs_upload_pending', 'This Git LFS object already has a pending upload.', 409);
    if (previous.state === 'reserving') await admitUpload(env, previous);
    requireValue(previous.state !== 'deleting', 'lfs_upload_pending', 'An earlier LFS upload is being deleted.', 409);
    return previous;
  }
  const id = newId('lfsup');
  const owner = await one<{ owner_id: string }>(db, 'SELECT owner_id FROM repositories WHERE id=?', repoId);
  requireValue(owner, 'not_found', 'Repository not found.', 404);
  const upload: LfsUpload = { repo_id: repoId, id, ...object, actor_id: actor.id, credential_id: actor.credential_id,
    account_id: owner.owner_id, object_id: `obj_${id}`, billing_reservation_id: null, billing_fence: null, upload_generation: 0,
    ref, storage_key: `${owner.owner_id}/${repoId}/lfs/${object.oid}/${id}`, state: 'reserving', expires_at: new Date(Date.now() + 30 * 60_000).toISOString() };
  await registerResourceLocator(env, { resource_id: upload.object_id, resource_type: 'object', repo_id: repoId, authority: 'repository' });
  await execute(db, 'INSERT OR IGNORE INTO git_lfs_quotas(repo_id,byte_limit,updated_at) VALUES (?,?,?)', repoId, limits.lfs_repository_bytes, now());
  const guard = newId('guard');
  try {
    await db.batch([
      stmt(db, `UPDATE git_lfs_quotas SET reserved_bytes=reserved_bytes+?,revision=revision+1,updated_at=?
        WHERE repo_id=? AND used_bytes+reserved_bytes+?<=MIN(byte_limit,?)`, object.size, now(), repoId, object.size, limits.lfs_repository_bytes),
      mutationGuard(db, guard),
      stmt(db, `INSERT INTO object_manifests(id,repo_id,account_id,kind,object_key,bucket,filename,content_type,bytes,sha256,state,created_by,retention_until,created_at,updated_at)
        VALUES (?,?,?,'git_lfs',?,'blobs',?,'application/octet-stream',?,?,'reserving',?,NULL,?,?)`, upload.object_id, repoId, owner.owner_id,
      upload.storage_key, object.oid, object.size, object.oid, actor.id, now(), now()),
      stmt(db, `INSERT INTO git_lfs_uploads(repo_id,id,account_id,object_id,oid,size,actor_id,credential_id,ref,storage_key,state,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, repoId, id, owner.owner_id, upload.object_id, object.oid, object.size, actor.id, actor.credential_id, ref, upload.storage_key, upload.state, now(), upload.expires_at),
      stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard),
    ]);
  } catch (cause) {
    if (/CHECK constraint|mutation_requires_one_row/iu.test(String(cause))) throw new GitError('lfs_quota', 'Repository LFS storage quota is exhausted.', 507);
    if (/UNIQUE constraint/iu.test(String(cause))) throw new GitError('lfs_upload_pending', 'A concurrent upload reserved this object. Retry the batch.', 409);
    throw cause;
  }
  await admitUpload(env, upload);
  return upload;
}

async function admitUpload(env: Bindings, upload: LfsUpload): Promise<void> {
  try { await admitLfsStorage(env, upload); upload.state = 'reserved'; }
  catch (error) {
    // No input permission has escaped a reserving manifest. Fence it before
    // compensating even a lost billing reply; cancellation never requests budget.
    try { if (await deleteUnusedLfsStorage(env, upload, true)) await finishUnusedUpload(env, upload); }
    catch (cleanupError) { reportLfsCleanup(upload.id, cleanupError); }
    throw error;
  }
}

async function authorizedUpload(c: AppContext, repository: Repository, id: string): Promise<LfsUpload> {
  const actor = requirePrincipal(c);
  const upload = await one<LfsUpload>(database(c), 'SELECT * FROM git_lfs_uploads WHERE repo_id=? AND id=? AND actor_id=?', repository.id, id, actor.id);
  requireValue(upload, 'lfs_upload_not_found', 'Git LFS upload not found.', 404);
  await authorize(c, 'lfs.write', { repo_id: repository.id, ref: upload.ref ?? undefined, paths: [] });
  requireValue(!['reserving', 'deleting', 'expired'].includes(upload.state) && (upload.state === 'complete' || upload.expires_at > now()), 'lfs_upload_expired', 'Git LFS upload expired or is not admitted. Request a new batch.', 410);
  return upload;
}

async function uploadObject(c: AppContext, repository: Repository, id: string): Promise<Response> {
  const env = storageEnvironment(c);
  const upload = await authorizedUpload(c, repository, id);
  const existing = await c.env.BLOBS.head(upload.storage_key);
  if (existing) {
    await verifyStoredObject(existing, upload);
    await completeLfsUpload(env, upload);
    await c.req.raw.body?.cancel();
    return new Response(null, { status: 200 });
  }
  requireValue(upload.state !== 'complete', 'lfs_storage_missing', 'Stored Git LFS bytes are missing. Contact support with the request ID.', 503);
  const length = c.req.header('content-length');
  requireValue(length !== undefined && /^\d+$/u.test(length) && Number(length) === upload.size, 'lfs_length_required', 'Git LFS upload requires its exact Content-Length.', 411);
  requireValue(c.req.raw.body || upload.size === 0, 'lfs_body_required', 'Git LFS upload requires object bytes.', 400);
  await receiveLfsBytes(env, upload, c.req.raw.body ?? new Blob([]).stream());
  // Recheck current identity and write scope after a potentially long upload.
  await authorize(c, 'lfs.write', { repo_id: repository.id, ref: upload.ref ?? undefined, paths: [] });
  await completeLfsUpload(env, upload);
  return new Response(null, { status: 200 });
}

export async function putLfsBytes(bucket: R2Bucket, upload: LfsUpload, body: ReadableStream<Uint8Array>): Promise<R2Object | null> {
  const fixed = new FixedLengthStream(upload.size);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new GitError('lfs_upload_timeout', 'Git LFS upload exceeded its time limit.', 408)), 180_000);
  let received = 0;
  let complete = false;
  let actualChecksum = '';
  const checksum = createHash('sha256');
  const counted = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, target) { received += chunk.length; checksum.update(chunk); target.enqueue(chunk); },
    flush() { complete = true; actualChecksum = checksum.digest('hex'); },
  }));
  const copy = counted.pipeTo(fixed.writable, { signal: controller.signal });
  void copy.catch(() => {});
  try {
    const result = await bucket.put(upload.storage_key, fixed.readable, {
      onlyIf: { etagDoesNotMatch: '*' }, sha256: upload.oid,
      httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'private, no-store' },
      customMetadata: { repo_id: upload.repo_id, oid: upload.oid, upload_id: upload.id, upload_generation: String(upload.upload_generation) },
    });
    if (result) await copy;
    return result;
  } catch (cause) {
    if (received < upload.size || complete && received === upload.size && actualChecksum !== upload.oid) throw new GitError('lfs_input_incomplete', 'Git LFS input did not match the expected bytes.', 422, { cause });
    throw cause;
  } finally { clearTimeout(timer); controller.abort(); await copy.catch(() => {}); }
}

export async function receiveLfsBytes(env: Bindings, upload: LfsUpload, body: ReadableStream<Uint8Array>): Promise<void> {
  await beginLfsStorageWrite(env, upload);
  try {
    const stored = await putLfsBytes(env.BLOBS, upload, body);
    await verifyStoredObject(stored ?? await env.BLOBS.head(upload.storage_key), upload);
  } catch (error) {
    if (error instanceof GitError && error.code === 'lfs_input_incomplete' && !await env.BLOBS.head(upload.storage_key)) await failedLfsInput(env, upload);
    throw error;
  }
}

export async function verifyStoredLfsObject(object: R2Object | null, upload: Pick<LfsUpload, 'repo_id' | 'id' | 'oid' | 'size' | 'upload_generation'>): Promise<void> {
  const checksum = object?.checksums.sha256;
  const hex = checksum ? Array.from(new Uint8Array(checksum), byte => byte.toString(16).padStart(2, '0')).join('') : '';
  requireValue(object && object.size === upload.size && hex === upload.oid && object.customMetadata?.repo_id === upload.repo_id
    && object.customMetadata.upload_id === upload.id && object.customMetadata.upload_generation === String(upload.upload_generation),
  'lfs_checksum', 'Git LFS bytes do not match their checksum, size, repository ownership, or upload generation.', 422);
}

const verifyStoredObject = verifyStoredLfsObject;

export async function completeLfsUpload(env: Bindings, upload: LfsUpload): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const previous = await one<{ state: string }>(db, 'SELECT state FROM git_lfs_uploads WHERE repo_id=? AND id=?', upload.repo_id, upload.id);
  if (previous?.state === 'complete') return;
  const stored = await env.BLOBS.head(upload.storage_key);
  await verifyStoredObject(stored, upload);
  await commitLfsStorage(env, upload, stored!);
  const guard = newId('guard');
  await db.batch([
    stmt(db, "UPDATE git_lfs_uploads SET state='complete',completed_at=? WHERE repo_id=? AND id=? AND state IN ('reserved','uploading')", now(), upload.repo_id, upload.id),
    mutationGuard(db, guard),
    stmt(db, `INSERT INTO git_lfs_objects(repo_id,object_id,oid,size,storage_key,state,created_by,created_at,verified_at)
      VALUES (?,?,?,?,?,'available',?,?,?) ON CONFLICT(repo_id,oid) DO UPDATE SET object_id=excluded.object_id,
      storage_key=excluded.storage_key,state='available',revision=git_lfs_objects.revision+1,verified_at=excluded.verified_at`,
    upload.repo_id, upload.object_id, upload.oid, upload.size, upload.storage_key, upload.actor_id, now(), now()),
    stmt(db, `UPDATE object_manifests SET state='ready',upload_bytes_received=?,reference_count=1,revision=revision+1,updated_at=?
      WHERE id=? AND repo_id=? AND state IN ('pending','uploading') AND billing_reservation_id=? AND billing_fence=?`,
    upload.size, now(), upload.object_id, upload.repo_id, upload.billing_reservation_id, upload.billing_fence),
    mutationGuard(db, `${guard}_manifest`),
    stmt(db, 'UPDATE git_lfs_quotas SET used_bytes=used_bytes+?,reserved_bytes=reserved_bytes-?,revision=revision+1,updated_at=? WHERE repo_id=? AND reserved_bytes>=?',
      upload.size, upload.size, now(), upload.repo_id, upload.size),
    mutationGuard(db, `${guard}_quota`),
    eventStatement(db, { id: `evt_${upload.id}`, type: 'git.lfs_object.created', actor_id: upload.actor_id,
      repo_id: upload.repo_id, resource_id: `lfs_${upload.oid}`, resource_revision: 1, data: { oid: upload.oid, size: upload.size } }),
    stmt(db, 'DELETE FROM mutation_guards WHERE id IN (?,?,?)', guard, `${guard}_quota`, `${guard}_manifest`),
  ]);
}

async function verifyUpload(c: AppContext, repository: Repository, id: string): Promise<Response> {
  const upload = await authorizedUpload(c, repository, id);
  const parsed = lfsObjectSchema.safeParse(await boundedJson(c.req.raw, 1024));
  requireValue(parsed.success && parsed.data.oid === upload.oid && parsed.data.size === upload.size, 'lfs_verify_mismatch', 'LFS verification does not match this upload.');
  await verifyStoredObject(await c.env.BLOBS.head(upload.storage_key), upload);
  await completeLfsUpload(storageEnvironment(c), upload);
  return new Response(null, { status: 200 });
}

async function downloadObject(c: AppContext, repository: Repository, oid: string): Promise<Response> {
  await authorize(c, 'lfs.read', { repo_id: repository.id });
  const row = await one<LfsObject>(database(c), "SELECT * FROM git_lfs_objects WHERE repo_id=? AND oid=? AND state='available'", repository.id, oid);
  requireValue(row, 'lfs_not_found', 'Git LFS object not found.', 404);
  const object = await c.env.BLOBS.get(row.storage_key);
  const checksum = object?.checksums.sha256 ? Array.from(new Uint8Array(object.checksums.sha256), byte => byte.toString(16).padStart(2, '0')).join('') : '';
  requireValue(object && object.customMetadata?.repo_id === repository.id && checksum === oid && object.size === row.size,
    'lfs_storage_missing', 'Git LFS object bytes are temporarily unavailable.', 503);
  if (c.req.method === 'HEAD') await object.body.cancel();
  return new Response(c.req.method === 'HEAD' ? null : object.body, { headers: {
    'content-type': 'application/octet-stream', 'content-length': String(object.size), etag: `"${oid}"`,
    'cache-control': 'private, no-store', 'content-disposition': 'attachment', 'x-content-type-options': 'nosniff',
  } });
}

export async function verifyLfsPointers(db: Database, repoId: string, objects: Array<{ oid: string; size: number }>): Promise<void> {
  for (const object of objects) {
    const row = await one<{ size: number }>(db, "SELECT size FROM git_lfs_objects WHERE repo_id=? AND oid=? AND state='available'", repoId, object.oid);
    requireValue(row && row.size === object.size, 'lfs_object_missing', 'Upload all Git LFS objects to this repository before publishing their pointers.');
  }
}

function storageEnvironment(c: AppContext): Bindings {
  return { ...c.env, ...identityAuthorityBindings(c.env), DB: requestDatabaseBinding(c), SHARD_ID: requestDatabaseLocation(c).shard_id,
    ROOT_DB: c.env.ROOT_DB ?? c.env.DB, ROOT_SHARD_ID: c.env.ROOT_SHARD_ID ?? c.env.SHARD_ID };
}

/** Expiration releases only never-started uploads; uncertain in-flight writes retain reservations. */
export async function sweepLfs(env: Bindings, limit = 100): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const uploads = await many<LfsUpload>(db, `SELECT * FROM git_lfs_uploads WHERE state='deleting'
    OR state IN ('reserving','reserved','uploading') AND expires_at<? ORDER BY expires_at,id LIMIT ?`, now(), limit);
  for (const upload of uploads) {
    try { await reconcileLfsUpload(env, upload); }
    catch (error) { reportLfsCleanup(upload.id, error); }
  }
}

async function reconcileLfsUpload(env: Bindings, upload: LfsUpload): Promise<void> {
  if (upload.state !== 'deleting') {
    const object = await env.BLOBS.head(upload.storage_key);
    if (object) {
      await verifyStoredObject(object, upload);
      await completeLfsUpload(env, upload);
      return;
    }
    if (upload.state === 'uploading') return;
  }
  if (await deleteUnusedLfsStorage(env, upload)) await finishUnusedUpload(env, upload);
}

async function finishUnusedUpload(env: Bindings, upload: LfsUpload): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const guard = newId('guard');
  await db.batch([
    stmt(db, "UPDATE git_lfs_uploads SET state='expired' WHERE repo_id=? AND id=? AND state='deleting'", upload.repo_id, upload.id), mutationGuard(db, guard),
    stmt(db, "UPDATE object_manifests SET state='deleted',revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND state='deleting'", now(), upload.object_id, upload.repo_id),
    mutationGuard(db, `${guard}_manifest`),
    stmt(db, 'UPDATE git_lfs_quotas SET reserved_bytes=reserved_bytes-?,revision=revision+1,updated_at=? WHERE repo_id=? AND reserved_bytes>=?', upload.size, now(), upload.repo_id, upload.size),
    mutationGuard(db, `${guard}_quota`), stmt(db, 'DELETE FROM mutation_guards WHERE id IN (?,?,?)', guard, `${guard}_manifest`, `${guard}_quota`),
  ]);
}

function reportLfsCleanup(uploadId: string, error: unknown): void {
  console.error(JSON.stringify({ event: 'git.lfs_cleanup_pending', upload_id: uploadId,
    code: error instanceof GitError || error instanceof ApiError ? error.code : 'storage_cleanup_unconfirmed' }));
}

export async function copyLfsPage(env: Bindings, actor: Principal, sourceRepo: string, targetRepo: string, cursor = '', limit = 50): Promise<{ next_cursor: string | null }> {
  const rows = await many<LfsObject>(env.DB.withSession('first-primary'), "SELECT * FROM git_lfs_objects WHERE repo_id=? AND state='available' AND oid>? ORDER BY oid LIMIT ?", sourceRepo, cursor, limit + 1);
  await copyLfsObjects(env, actor, sourceRepo, targetRepo, rows.slice(0, limit));
  return { next_cursor: rows.length > limit ? rows[limit - 1].oid : null };
}

export async function copyLfsObjects(env: Bindings, actor: Principal, sourceRepo: string, targetRepo: string, pointers: Array<{ oid: string; size: number }>): Promise<void> {
  for (const pointer of pointers) {
    const row = await one<LfsObject>(env.DB, "SELECT * FROM git_lfs_objects WHERE repo_id=? AND oid=? AND state='available'", sourceRepo, pointer.oid);
    requireValue(row && row.size === pointer.size, 'lfs_source_missing', 'A source Git LFS object is unavailable.', 409);
    const existing = await one<LfsObject>(env.DB, "SELECT * FROM git_lfs_objects WHERE repo_id=? AND oid=? AND state='available'", targetRepo, row.oid);
    if (existing) { requireValue(existing.size === row.size, 'lfs_size_mismatch', 'Fork LFS checksum metadata disagrees.', 503); continue; }
    const object = await env.BLOBS.get(row.storage_key);
    requireValue(object && object.customMetadata?.repo_id === sourceRepo, 'lfs_not_found', 'Source Git LFS object is unavailable.', 503);
    const upload = await reserveLfsUpload(env, targetRepo, actor, row, null);
    await receiveLfsBytes(env, upload, object.body);
    await completeLfsUpload(env, upload);
  }
}
