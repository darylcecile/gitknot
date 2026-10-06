import { z } from 'zod';
import { cancelStandaloneStorageIntent, commitStorageObject, deleteStorageObject, reserveStandaloneStorage } from '@gitknot/billing';
import type { StorageObject } from '@gitknot/billing';
import { authorizeAttachmentObject } from './collaboration/attachment-storage.ts';
import { validatedUploadInput } from './storage-input.ts';
import {
  ApiError, authorize, database, decodeCursor, encodeCursor,
  etag, expectedRevision, getRepository, hex, jsonBody, limits,
  listResponse, many, mutate, mutationGuard, newId, now, one, page, requirePrincipal,
  identityDatabase, readBounded, route, sha256, stmt,
} from '@gitknot/core';
import type { App, AppContext, Database, IdempotencyOptions, Mutation, RequestAuthorization } from '@gitknot/core';

interface ObjectManifest {
  id: string;
  repo_id: string | null;
  account_id: string;
  kind: string;
  object_key: string;
  bucket: 'blobs' | 'backups';
  filename: string;
  content_type: string;
  bytes: number;
  sha256: string;
  state: 'reserving' | 'pending' | 'uploading' | 'ready' | 'deleting' | 'deleted' | 'failed';
  created_by: string;
  retention_until: string | null;
  requested_retention_until: string | null;
  billing_reservation_id: string | null;
  billing_fence: string | null;
  upload_generation: number;
  upload_bytes_received: number;
  upload_failure: string | null;
  reference_count: number;
  storage_accrued_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

const uploadSchema = z.object({
  filename: z.string().min(1).max(180).regex(/^[^\x00-\x1f\x7f/\\]+$/),
  content_type: z.string().max(120).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/).default('application/octet-stream'),
  bytes: z.number().int().min(0).max(5 * 1024 ** 3),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(['attachment', 'avatar']).default('attachment'),
  retention_days: z.number().int().min(1).max(3650).optional(),
}).strict();

function publicManifest(c: AppContext, manifest: ObjectManifest): Record<string, unknown> {
  return {
    id: manifest.id, repo_id: manifest.repo_id, account_id: manifest.account_id, kind: manifest.kind,
    filename: manifest.filename, content_type: manifest.content_type, bytes: manifest.bytes, sha256: manifest.sha256,
    state: manifest.state, revision: manifest.revision, created_at: manifest.created_at, retention_until: manifest.retention_until,
    upload_url: `${c.env.API_ORIGIN}/v1/uploads/${manifest.id}`,
    prepare_url: `${c.env.API_ORIGIN}/v1/uploads/${manifest.id}/prepare`,
    download_url: `${c.env.API_ORIGIN}/v1/objects/${manifest.id}/content`,
  };
}

function quotaStatements(db: Database, scope: string, size: number, maximum: number, timestamp: string, guards: string[]): D1PreparedStatement[] {
  const guard = newId('guard');
  guards.push(guard);
  return [
    stmt(db, 'INSERT INTO storage_quotas(scope_id,limit_bytes,updated_at) VALUES (?,?,?) ON CONFLICT(scope_id) DO NOTHING', scope, maximum, timestamp),
    stmt(db, `UPDATE storage_quotas SET reserved_bytes=reserved_bytes+?,revision=revision+1,updated_at=?
      WHERE scope_id=? AND used_bytes+reserved_bytes+?<=limit_bytes`, size, timestamp, scope, size),
    mutationGuard(db, guard),
  ];
}

async function beginUpload(c: AppContext, repoId: string | null, accountId: string): Promise<Response> {
  const actor = requirePrincipal(c);
  const body = await jsonBody(c, uploadSchema);
  const config = limits(c.env);
  if (body.bytes > config.upload_bytes) throw new ApiError(413, 'upload_limit', `This upload exceeds the ${config.upload_bytes}-byte object limit.`);
  if (body.kind === 'avatar' && !['image/png', 'image/jpeg', 'image/webp'].includes(body.content_type)) {
    throw new ApiError(422, 'avatar_format', 'Avatars must be PNG, JPEG, or WebP images.');
  }
  if (body.kind === 'avatar' && body.bytes > 5 * 1024 ** 2) throw new ApiError(413, 'avatar_limit', 'Avatars must be smaller than 5 MiB.');
  const retry = c.get('idempotency');
  const id = retry ? `obj_${(await sha256(`${actor.id}:${retry.key}:upload`)).slice(0, 32)}` : newId('obj');
  const timestamp = now();
  const expires = new Date(Date.now() + config.upload_reservation_minutes * 60_000).toISOString();
  const retainedUntil = body.retention_days ? new Date(Date.now() + body.retention_days * 86400_000).toISOString() : null;
  const db = database(c);
  const existing = await one<ObjectManifest>(db, 'SELECT * FROM object_manifests WHERE id=?', id);
  if (existing) {
    if (existing.account_id !== accountId || existing.repo_id !== repoId || existing.sha256 !== body.sha256 || existing.bytes !== body.bytes) {
      throw new ApiError(409, 'idempotency_conflict', 'This upload identity belongs to different content.');
    }
    if (existing.state === 'deleted') throw new ApiError(404, 'not_found', 'This upload has been deleted.');
    const admitted = existing.state === 'reserving' ? await admitUpload(c, existing) : existing;
    c.header('etag', etag(admitted.revision));
    return c.json(publicManifest(c, admitted));
  }
  const guards: string[] = [];
  // Account-wide capacity lives in the account coordinator, not independently in each repository shard.
  const statements = repoId ? quotaStatements(db, repoId, body.bytes, config.repository_storage_bytes, timestamp, guards) : [];
  for (const guard of guards) statements.push(stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard));
  try {
    await mutate(c, {
      sql: `INSERT INTO object_manifests
        (id,repo_id,account_id,kind,object_key,filename,content_type,bytes,sha256,created_by,retention_until,requested_retention_until,created_at,updated_at,state)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserving')`,
      bindings: [id, repoId, accountId, body.kind, `${accountId}/${repoId ?? 'assets'}/uploads/${id}`,
        body.filename, body.content_type, body.bytes, body.sha256, actor.id, expires, retainedUntil, timestamp, timestamp],
      after: statements,
      event: { type: 'object.reserving', resource_id: id, resource_revision: 1, repo_id: repoId, account_id: accountId,
        actor_id: actor.id, data: { bytes: body.bytes, expires_at: expires } },
      audit: { action: 'object.reserving', resource_id: id, details: { bytes: body.bytes } },
    });
  }
  catch (error) {
    if (repoId && error instanceof ApiError && error.status === 412) {
      const quota = await one<{ used_bytes: number; reserved_bytes: number; limit_bytes: number }>(db, 'SELECT * FROM storage_quotas WHERE scope_id=?', repoId);
      if (quota && quota.used_bytes + quota.reserved_bytes + body.bytes > quota.limit_bytes) {
        throw new ApiError(409, 'storage_quota_exceeded', 'This upload would exceed the repository storage quota.');
      }
    }
    throw error;
  }
  const manifest = await admitUpload(c, (await one<ObjectManifest>(db, 'SELECT * FROM object_manifests WHERE id=?', id))!);
  c.header('etag', etag(manifest.revision));
  c.header('location', `/v1/objects/${id}`);
  return c.json(publicManifest(c, manifest), 201);
}

async function admitUpload(c: AppContext, manifest: ObjectManifest): Promise<ObjectManifest> {
  if (manifest.state !== 'reserving') return manifest;
  if (!manifest.retention_until || manifest.retention_until <= now()) {
    throw new ApiError(409, 'upload_expired', 'This upload intent expired before admission. Cancel it before reserving a new upload.');
  }
  const reservation = await reserveStandaloneStorage(c.env, {
    account_id: manifest.account_id, repo_id: manifest.repo_id, actor_id: manifest.created_by,
    object_id: manifest.id, key: manifest.object_key, bucket: manifest.bucket,
    maximum_bytes: String(manifest.bytes), retention_until: manifest.requested_retention_until,
  });
  if (!receiptMatches(manifest, reservation) || reservation.admission_state !== 'ready' || reservation.state !== 'uploading') {
    throw new ApiError(503, 'storage_admission_unconfirmed', 'The account storage admission must be reconciled before accepting bytes.');
  }
  await objectFor(c, manifest.id, true);
  await mutate(c, {
    sql: "UPDATE object_manifests SET state='pending',billing_reservation_id=?,billing_fence=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND state='reserving'",
    bindings: [reservation.reservation_id, reservation.fence, now(), manifest.id, manifest.revision],
    event: { type: 'object.admitted', resource_id: manifest.id, resource_revision: manifest.revision + 1, repo_id: manifest.repo_id, account_id: manifest.account_id },
  });
  return { ...manifest, state: 'pending', billing_reservation_id: reservation.reservation_id, billing_fence: reservation.fence, revision: manifest.revision + 1 };
}

function receiptMatches(manifest: ObjectManifest, receipt: StorageObject): boolean {
  return receipt.id === manifest.id && receipt.account_id === manifest.account_id && receipt.key === manifest.object_key
    && receipt.bucket === manifest.bucket && receipt.source === 'standalone' && receipt.attribution.repo_id === manifest.repo_id
    && receipt.maximum_bytes === String(manifest.bytes) && !!receipt.reservation_id && !!receipt.fence;
}

async function objectFor(c: AppContext, id: string, write = false, includeDeleted = false): Promise<ObjectManifest> {
  const manifest = await one<ObjectManifest>(database(c), 'SELECT * FROM object_manifests WHERE id=?', id);
  if (!manifest || (!includeDeleted && manifest.state === 'deleted') || manifest.bucket !== 'blobs'
    || !['attachment', 'avatar', 'collaboration_attachment'].includes(manifest.kind)) {
    throw new ApiError(404, 'not_found', 'The object was not found.');
  }
  if (manifest.kind === 'collaboration_attachment') {
    await authorizeAttachmentObject(c, id, write);
    return manifest;
  }
  if (!write && c.req.path.endsWith('/content') && await publishedAvatar(c, manifest)) return manifest;
  const capability = objectCapability(manifest, write);
  if (manifest.repo_id) await getRepository(c, manifest.repo_id, capability);
  else {
    try { await authorize(c, capability, { account_id: manifest.account_id }); }
    catch (error) {
      if (!write && error instanceof ApiError && [401, 403].includes(error.status)) throw new ApiError(404, 'not_found', 'The object was not found.');
      throw error;
    }
  }
  return manifest;
}

async function publishedAvatar(c: AppContext, manifest: ObjectManifest): Promise<boolean> {
  if (manifest.kind !== 'avatar' || manifest.repo_id !== null || manifest.state !== 'ready') return false;
  const user = await one<{ avatar_url: string | null }>(identityDatabase(c),
    `SELECT u.avatar_url FROM users u JOIN accounts a ON a.id=u.id WHERE u.id=? AND u.disabled_at IS NULL
      AND u.profile_visibility='public' AND u.email_verified_at IS NOT NULL AND a.type='user' AND a.disabled_at IS NULL`, manifest.account_id);
  if (!user?.avatar_url) return false;
  try {
    const url = new URL(user.avatar_url, c.env.API_ORIGIN);
    return [c.env.API_ORIGIN, c.env.APP_ORIGIN].includes(url.origin)
      && url.pathname === `/v1/objects/${manifest.id}/content` && !url.username && !url.password;
  } catch { return false; }
}

function objectCapability(manifest: ObjectManifest, write: boolean): string {
  if (manifest.repo_id) return write ? 'attachments.write' : 'contents.read';
  return write ? 'accounts.manage' : 'attachments.read';
}

async function userUploadFor(c: AppContext, id: string): Promise<ObjectManifest> {
  const manifest = await objectFor(c, id, true);
  if (manifest.bucket !== 'blobs' || !['attachment', 'avatar'].includes(manifest.kind)) {
    throw new ApiError(404, 'not_found', 'The upload was not found.');
  }
  return manifest;
}

function selectedBucket(c: AppContext, manifest: ObjectManifest): R2Bucket {
  return manifest.bucket === 'backups' ? c.env.BACKUPS : c.env.BLOBS;
}

async function finalizeUpload(c: AppContext, manifest: ObjectManifest): Promise<ObjectManifest> {
  if (manifest.state === 'ready') return manifest;
  if (manifest.state !== 'uploading') throw new ApiError(409, 'upload_not_started', 'Upload the object before confirming it.');
  const object = await selectedBucket(c, manifest).head(manifest.object_key);
  if (!object) throw new ApiError(409, 'upload_incomplete', 'The upload is not yet complete. Retry this confirmation.');
  if (!storedUploadMatches(manifest, object)) throw new ApiError(422, 'checksum_mismatch', 'The stored object does not match this upload generation.');
  if (!manifest.billing_reservation_id || !manifest.billing_fence) throw new ApiError(503, 'storage_admission_unavailable', 'The upload admission must be reconciled before this object is published.');
  const receipt = await commitStorageObject(c.env, {
    account_id: manifest.account_id, reservation_id: manifest.billing_reservation_id, fence: manifest.billing_fence,
    object_id: manifest.id, bytes: String(manifest.bytes), etag: object.etag, checksum: manifest.sha256,
  });
  if (!receiptMatches(manifest, receipt) || receipt.state !== 'stored' || receipt.bytes !== String(manifest.bytes)
    || receipt.reservation_id !== manifest.billing_reservation_id || receipt.fence !== manifest.billing_fence) {
    throw new ApiError(503, 'storage_settlement_unconfirmed', 'The retained-storage commitment has not been confirmed.');
  }
  // Recheck the current audience after receiving and metering bytes, before publishing the attachment.
  await objectFor(c, manifest.id, true);
  const timestamp = now();
  const db = database(c);
  const after = manifest.repo_id ? guardedQuotaUpdate(db,
    `UPDATE storage_quotas SET reserved_bytes=reserved_bytes-?,used_bytes=used_bytes+?,revision=revision+1,updated_at=?
      WHERE scope_id=? AND reserved_bytes>=?`, manifest.bytes, manifest.bytes, timestamp, manifest.repo_id, manifest.bytes) : [];
  await mutate(c, {
    sql: `UPDATE object_manifests SET state='ready',retention_until=requested_retention_until,revision=revision+1,
      upload_bytes_received=bytes,upload_failure=NULL,storage_accrued_at=?,updated_at=? WHERE id=? AND state='uploading' AND revision=?`,
    bindings: [timestamp, timestamp, manifest.id, manifest.revision], after,
    event: { type: 'object.created', resource_id: manifest.id, resource_revision: manifest.revision + 1,
      repo_id: manifest.repo_id, account_id: manifest.account_id, data: { bytes: manifest.bytes, sha256: manifest.sha256, kind: manifest.kind } },
  });
  return { ...manifest, state: 'ready', revision: manifest.revision + 1, storage_accrued_at: timestamp, retention_until: manifest.requested_retention_until, updated_at: timestamp };
}

function guardedQuotaUpdate(db: Database, sql: string, ...values: unknown[]): D1PreparedStatement[] {
  const guard = newId('guard');
  return [stmt(db, sql, ...values), mutationGuard(db, guard), stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard)];
}

function storedUploadMatches(manifest: ObjectManifest, object: R2Object): boolean {
  const digest = object.checksums.sha256 ? hex(new Uint8Array(object.checksums.sha256)) : object.customMetadata?.sha256;
  return object.size === manifest.bytes && digest === manifest.sha256 && object.customMetadata?.object_id === manifest.id
    && object.customMetadata?.repo_id === (manifest.repo_id ?? '')
    && object.customMetadata?.upload_generation === String(manifest.upload_generation);
}

async function receiveUpload(c: AppContext): Promise<Response> {
  let manifest = await userUploadFor(c, c.req.param('id')!);
  if (manifest.state === 'ready') { c.header('etag', etag(manifest.revision)); return c.json(publicManifest(c, manifest)); }
  if (manifest.state === 'reserving') manifest = await admitUpload(c, manifest);
  if (manifest.state === 'uploading') {
    manifest = await finalizeUpload(c, manifest);
    c.header('etag', etag(manifest.revision));
    return c.json(publicManifest(c, manifest));
  }
  if (manifest.state !== 'pending' || manifest.retention_until! < now()) throw new ApiError(409, 'upload_expired', 'The upload reservation expired. Create a new upload.');
  if (!c.req.raw.body && manifest.bytes) throw new ApiError(400, 'body_required', 'The upload body is required.');
  const revision = expectedRevision(c);
  const generation = manifest.upload_generation + 1;
  await mutate(c, {
    sql: "UPDATE object_manifests SET state='uploading',upload_generation=?,upload_bytes_received=0,upload_failure=NULL,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND state='pending' AND billing_reservation_id IS NOT NULL",
    bindings: [generation, now(), manifest.id, revision],
    event: { type: 'object.uploading', resource_id: manifest.id, resource_revision: revision + 1, repo_id: manifest.repo_id, account_id: manifest.account_id },
  });
  manifest = { ...manifest, state: 'uploading', revision: revision + 1, upload_generation: generation };
  const input = validatedUploadInput(c.req.raw.body, manifest.bytes, manifest.sha256);
  try {
    // Empty uploads are fully validated before allocating a zero-length put.
    let body: ReadableStream<Uint8Array> | Uint8Array = manifest.bytes === 0 ? await readBounded(input.body, 0) : input.body;
    if (body instanceof ReadableStream && typeof FixedLengthStream !== 'undefined') body = body.pipeThrough(new FixedLengthStream(manifest.bytes));
    await selectedBucket(c, manifest).put(manifest.object_key, body, {
      sha256: manifest.sha256, onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: manifest.content_type }, customMetadata: { sha256: manifest.sha256, object_id: manifest.id,
        repo_id: manifest.repo_id ?? '', upload_generation: String(manifest.upload_generation) },
    });
  } catch (error) {
    const invalidInput = !input.complete;
    input.stop(error);
    const accepted = await selectedBucket(c, manifest).head(manifest.object_key).catch(() => null);
    if (accepted && storedUploadMatches(manifest, accepted)) {
      const ready = await finalizeUpload(c, manifest);
      c.header('etag', etag(ready.revision));
      return c.json(publicManifest(c, ready));
    }
    if (invalidInput) {
      await mutate(c, {
        sql: "UPDATE object_manifests SET state='pending',upload_bytes_received=?,upload_failure='input_incomplete',revision=revision+1,updated_at=? WHERE id=? AND state='uploading' AND upload_generation=? AND revision=?",
        bindings: [input.received, now(), manifest.id, generation, manifest.revision],
        event: { type: 'object.upload_failed', resource_id: manifest.id, resource_revision: manifest.revision + 1, repo_id: manifest.repo_id, account_id: manifest.account_id, data: { reason: 'input_incomplete' } },
      });
      c.header('etag', etag(manifest.revision + 1));
      throw new ApiError(422, 'upload_input_invalid', 'The upload was interrupted or its checksum did not match. Retrieve the current ETag and retry the same upload ID.', { object_id: manifest.id });
    }
    throw new ApiError(502, 'upload_unconfirmed', 'GitKnot could not confirm the upload. Use the completion endpoint to reconcile it before creating another.', { object_id: manifest.id });
  } finally { input.stop(); }
  manifest = await finalizeUpload(c, manifest);
  c.header('etag', etag(manifest.revision));
  return c.json(publicManifest(c, manifest), 201);
}

function byteRange(value: string | undefined, size: number): { offset: number; length: number } | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new ApiError(416, 'invalid_range', 'Only a single byte range is supported.');
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] ? (match[2] ? Number(match[2]) : size - 1) : size - 1;
  if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start || start >= size) throw new ApiError(416, 'invalid_range', 'The byte range is outside this object.');
  start = Math.min(start, size - 1);
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}

async function download(c: AppContext): Promise<Response> {
  const manifest = await objectFor(c, c.req.param('id')!);
  if (manifest.state !== 'ready') throw new ApiError(409, 'object_not_ready', 'The object is not available yet.');
  const tag = etag(manifest.sha256);
  const headers = new Headers({
    'etag': tag, 'cache-control': 'private, max-age=0, must-revalidate', 'accept-ranges': 'bytes',
    'x-content-type-options': 'nosniff', 'content-type': manifest.content_type,
    'content-security-policy': "default-src 'none'; sandbox",
    'content-disposition': `${manifest.kind === 'avatar' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(manifest.filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
  });
  if (c.req.header('if-none-match') === tag) return c.newResponse(null, { status: 304, headers });
  const requestedRange = c.req.header('if-range') && c.req.header('if-range') !== tag ? undefined : c.req.header('range');
  const range = byteRange(requestedRange, manifest.bytes);
  const bucket = selectedBucket(c, manifest);
  const object = c.req.method === 'HEAD' ? await bucket.head(manifest.object_key) : await bucket.get(manifest.object_key, range ? { range } : undefined);
  if (!object) throw new ApiError(503, 'object_temporarily_unavailable', 'The object is being recovered. Please retry later.');
  headers.set('content-length', String(range?.length ?? object.size));
  if (range) headers.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`);
  let content: ReadableStream | null = null;
  if (c.req.method !== 'HEAD') {
    if (!('body' in object) || !(object.body instanceof ReadableStream)) {
      throw new ApiError(503, 'object_temporarily_unavailable', 'The object download could not be opened. Please retry later.');
    }
    content = object.body;
  }
  return c.newResponse(content, { status: range ? 206 : 200, headers });
}

async function deleteObject(c: AppContext, resuming = false): Promise<Response> {
  const manifest = await objectFor(c, c.req.param('id')!, true, resuming);
  if (manifest.kind === 'collaboration_attachment') {
    throw new ApiError(409, 'attachment_operation_required', 'Delete this attachment from its issue, pull request, discussion, or task so its references are updated together.');
  }
  if (manifest.state === 'deleted') return c.body(null, 204);
  if (manifest.reference_count > 0) throw new ApiError(409, 'object_referenced', 'Remove this object from its associated records before deleting it.');
  const unused = manifest.upload_generation === 0 || manifest.upload_failure === 'input_incomplete';
  if (!['reserving', 'ready', 'pending', 'failed', 'deleting'].includes(manifest.state)
    || (!manifest.storage_accrued_at && !unused)) throw new ApiError(409, 'upload_in_progress', 'The upload must be reconciled before deletion.');
  const revision = expectedRevision(c);
  if ((!resuming || manifest.state !== 'deleting') && revision !== manifest.revision) throw new ApiError(412, 'revision_conflict', 'The object changed. Refresh it before deleting it.');
  const db = database(c);
  if (manifest.state !== 'deleting') await mutate(c, {
    sql: "UPDATE object_manifests SET state='deleting',retention_until=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND reference_count=0 AND state IN ('reserving','ready','pending','failed')",
    bindings: [now(), now(), manifest.id, revision],
    event: { type: 'object.deleting', resource_id: manifest.id, resource_revision: revision + 1, repo_id: manifest.repo_id, account_id: manifest.account_id, data: { was_ready: manifest.state === 'ready' } },
  });
  if (!manifest.billing_reservation_id || manifest.state === 'reserving') {
    const cancellation = await cancelStandaloneStorageIntent(c.env, { account_id: manifest.account_id, object_id: manifest.id, repo_id: manifest.repo_id });
    if (cancellation.id !== manifest.id || cancellation.account_id !== manifest.account_id || cancellation.repo_id !== manifest.repo_id
      || cancellation.key !== manifest.object_key || cancellation.bucket !== manifest.bucket || cancellation.source !== 'standalone'
      || cancellation.state !== 'cancelled') {
      throw new ApiError(503, 'storage_cancellation_unconfirmed', 'The unused upload admission is still being reconciled.');
    }
  } else {
    const receipt = await deleteStorageObject(c.env, { account_id: manifest.account_id, object_id: manifest.id });
    if (!receiptMatches(manifest, receipt) || receipt.state !== 'deleted' || receipt.reservation_id !== manifest.billing_reservation_id
      || receipt.fence !== manifest.billing_fence || await selectedBucket(c, manifest).head(manifest.object_key)) {
      throw new ApiError(503, 'storage_deletion_unconfirmed', 'Physical deletion and financial release are still being reconciled.');
    }
  }
  const current = await one<ObjectManifest>(db, 'SELECT * FROM object_manifests WHERE id=?', manifest.id);
  if (!current) throw new ApiError(503, 'storage_manifest_unavailable', 'The object deletion record is temporarily unavailable.');
  if (current.state !== 'deleted') await mutate(c, genericObjectDeletionMutation(db, current));
  return c.body(null, 204);
}

/** Shared finalization for user deletes and the verified retention/recovery consumer. */
export function genericObjectDeletionMutation(db: Database, manifest: Pick<ObjectManifest,
  'id' | 'repo_id' | 'account_id' | 'kind' | 'bytes' | 'revision' | 'billing_fence' | 'storage_accrued_at' | 'state'>): Mutation {
  if (!['attachment', 'avatar'].includes(manifest.kind) || manifest.state !== 'deleting') {
    throw new ApiError(409, 'object_owner_required', 'The owning feature must finalize this object deletion.');
  }
  const column = manifest.storage_accrued_at ? 'used_bytes' : 'reserved_bytes';
  const after = manifest.repo_id ? guardedQuotaUpdate(db,
    `UPDATE storage_quotas SET ${column}=${column}-?,revision=revision+1,updated_at=? WHERE scope_id=? AND ${column}>=?`,
    manifest.bytes, now(), manifest.repo_id, manifest.bytes) : [];
  return {
    sql: "UPDATE object_manifests SET state='deleted',revision=revision+1,updated_at=? WHERE id=? AND account_id=? AND kind=? AND state='deleting' AND revision=? AND billing_fence IS ? AND reference_count=0",
    bindings: [now(), manifest.id, manifest.account_id, manifest.kind, manifest.revision, manifest.billing_fence], after,
    event: { type: 'object.deleted', resource_id: manifest.id, resource_revision: manifest.revision + 1, repo_id: manifest.repo_id, account_id: manifest.account_id,
      data: { bytes: manifest.bytes, physical_deletion_verified: true } },
  };
}

function uploadRecovery(repository: boolean): IdempotencyOptions {
  return {
    strategy: 'external',
    authorization: c => [{ capability: repository ? 'attachments.write' : 'accounts.manage',
      scope: repository ? { repo_id: c.req.param('repoId')! } : { account_id: c.req.param('accountId')! } }],
    recover: async c => {
      if (!repository) return beginUpload(c, null, c.req.param('accountId')!);
      const repo = await getRepository(c, c.req.param('repoId')!, 'attachments.write');
      return beginUpload(c, repo.id, repo.owner_id);
    },
  };
}

async function objectAuthority(c: AppContext, includeDeleted = false): Promise<RequestAuthorization[]> {
  const manifest = await objectFor(c, c.req.param('id')!, true, includeDeleted);
  return [{ capability: objectCapability(manifest, true),
    scope: manifest.repo_id ? { repo_id: manifest.repo_id } : { account_id: manifest.account_id } }];
}

async function prepareUpload(c: AppContext): Promise<Response> {
  const manifest = await admitUpload(c, await userUploadFor(c, c.req.param('id')!));
  c.header('etag', etag(manifest.revision));
  return c.json(publicManifest(c, manifest));
}

async function completeUpload(c: AppContext): Promise<Response> {
  const manifest = await finalizeUpload(c, await userUploadFor(c, c.req.param('id')!));
  c.header('etag', etag(manifest.revision));
  return c.json(publicManifest(c, manifest));
}

export function registerStorageRoutes(app: App): void {
  route(app, 'POST', '/v1/repos/:repoId/uploads', { summary: 'Reserve a checksummed repository attachment upload', tags: ['uploads'], body: uploadSchema, capability: 'attachments.write', idempotency: uploadRecovery(true) }, async c => {
    const repo = await getRepository(c, c.req.param('repoId')!, 'attachments.write');
    return beginUpload(c, repo.id, repo.owner_id);
  });
  route(app, 'POST', '/v1/accounts/:accountId/uploads', { summary: 'Reserve an account image or attachment upload', tags: ['uploads'], body: uploadSchema, capability: 'accounts.manage', idempotency: uploadRecovery(false) }, async c => {
    await authorize(c, 'accounts.manage', { account_id: c.req.param('accountId')! });
    return beginUpload(c, null, c.req.param('accountId')!);
  });
  route(app, 'PUT', '/v1/uploads/:id', {
    summary: 'Stream the exact bytes of a reserved upload', tags: ['uploads'], streaming: true,
    requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
    responses: {
      '200': { description: 'The existing immutable upload is ready.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
      '201': { description: 'The checksum was verified and the object is ready.', content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } },
    },
  }, receiveUpload);
  route(app, 'POST', '/v1/uploads/:id/prepare', { summary: 'Resume a durable storage admission request', tags: ['uploads'],
    idempotency: { strategy: 'external', authorization: c => objectAuthority(c), recover: c => prepareUpload(c) } }, prepareUpload);
  route(app, 'POST', '/v1/uploads/:id/complete', { summary: 'Reconcile and confirm a checksummed upload', tags: ['uploads'],
    idempotency: { strategy: 'external', authorization: c => objectAuthority(c), recover: c => completeUpload(c) } }, completeUpload);
  route(app, 'GET', '/v1/objects/:id', { summary: 'Read an authorized object manifest', tags: ['uploads'] }, async c => {
    const manifest = await objectFor(c, c.req.param('id')!);
    c.header('etag', etag(manifest.revision));
    return c.json(publicManifest(c, manifest));
  });
  route(app, 'GET', '/v1/objects/:id/content', {
    summary: 'Download an authorized object with byte-range support', tags: ['uploads'], streaming: true,
    responses: {
      '206': { description: 'The requested byte range.', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
      '304': { description: 'The authorized immutable content has not changed.' },
      '416': { $ref: '#/components/responses/Error' },
    },
  }, download);
  route(app, 'HEAD', '/v1/objects/:id/content', { summary: 'Read authorized object download headers', tags: ['uploads'], streaming: true }, download);
  route(app, 'DELETE', '/v1/objects/:id', { summary: 'Delete an unreferenced object and release its quota', tags: ['uploads'],
    idempotency: { strategy: 'external', authorization: c => objectAuthority(c, true), recover: (c, record) => deleteObject(c, !!record.committed_at) },
    responses: { '204': { description: 'The object payload was deleted and its quota released.' } } }, c => deleteObject(c));
}

export function registerAuditRoutes(app: App): void {
  for (const scope of ['accounts', 'repos'] as const) {
    route(app, 'GET', `/v1/${scope}/:scopeId/audit`, { summary: `Read the ${scope === 'repos' ? 'repository' : 'account'} audit trail`, tags: ['audit'], capability: 'audit.read' }, async c => {
      const id = c.req.param('scopeId')!;
      const repo = scope === 'repos';
      await authorize(c, 'audit.read', repo ? { repo_id: id } : { account_id: id });
      const { limit, cursor } = page(c);
      const after = decodeCursor<{ created_at: string; id: string } | null>(cursor, null);
      if (after && (typeof after.created_at !== 'string' || typeof after.id !== 'string')) throw new ApiError(422, 'invalid_cursor', 'The audit cursor is invalid.');
      const rows = await many<{ id: string; created_at: string; details_json: string } & Record<string, unknown>>(database(c),
        `SELECT * FROM audit_log WHERE ${repo ? 'repo_id' : 'account_id'}=?
          ${after ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`,
      id, ...(after ? [after.created_at, after.created_at, after.id] : []), limit + 1);
      const more = rows.length > limit;
      const visible = rows.slice(0, limit);
      const last = visible.at(-1);
      return listResponse(c, visible.map(({ details_json, ...row }) => ({ ...row, details: JSON.parse(details_json) })),
        more && last ? encodeCursor({ created_at: last.created_at, id: last.id }) : null);
    });
  }
}
