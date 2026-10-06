import {
  ApiError, database, hex, limits, makeEvent, many, mutationGuard, newId, now, one, readBounded,
  registerResourceLocator, requirePrincipal, sha256, stmt,
} from '@gitknot/core';
import type { AppContext, Bindings, Repository } from '@gitknot/core';
import { cancelStandaloneStorageIntent, reserveStandaloneStorage } from '../../../../../packages/billing/src/storage.ts';
import { commitStorageObject, deleteStorageObject } from '../../../../../packages/billing/src/execution.ts';
import type { StorageObject } from '../../../../../packages/billing/src/types.ts';
import { commit, getItem, itemFence, itemTouch, notFound, unlocked } from './common.ts';
import type { Item, ItemKind } from './common.ts';
import { isMaintenanceRace, maintenanceContext } from './maintenance.ts';

export interface Attachment {
  id: string; repo_id: string; item_id: string; object_id: string; created_by: string;
  association_revision: number; revision: number; created_at: string; updated_at: string;
  account_id: string; object_key: string; bucket: 'blobs' | 'backups'; filename: string; content_type: string;
  bytes: number; sha256: string; state: 'reserving' | 'pending' | 'uploading' | 'ready' | 'deleting' | 'deleted' | 'failed';
  retention_until: string | null; requested_retention_until: string | null; storage_accrued_at: string | null;
  billing_reservation_id: string | null; billing_fence: string | null;
  upload_generation: number; upload_bytes_received: number; upload_failure: string | null;
}

export const attachmentSelect = `SELECT a.id,a.repo_id,a.item_id,a.object_id,a.created_by,a.revision AS association_revision,
  a.created_at,o.updated_at,o.revision,o.account_id,o.object_key,o.bucket,o.filename,o.content_type,o.bytes,o.sha256,
  o.state,o.retention_until,o.requested_retention_until,o.storage_accrued_at,o.billing_reservation_id,o.billing_fence,
  o.upload_generation,o.upload_bytes_received,o.upload_failure FROM collaboration_attachments a
  JOIN object_manifests o ON o.id=a.object_id AND o.repo_id=a.repo_id AND o.kind='collaboration_attachment'`;

export async function readAttachment(c: AppContext, repoId: string, itemId: string, id: string | undefined, includeDeleted = false): Promise<Attachment> {
  const value = await one<Attachment>(database(c), `${attachmentSelect} WHERE a.repo_id=? AND a.item_id=? AND a.id=?${includeDeleted ? '' : " AND o.state<>'deleted'"}`, repoId, itemId, id ?? '');
  if (!value) notFound();
  return value;
}

export async function authorizeAttachmentObject(c: AppContext, objectId: string, write = false): Promise<Attachment> {
  const value = await one<Attachment>(database(c), `${attachmentSelect} WHERE a.object_id=? AND o.state<>'deleted'`, objectId);
  if (!value) notFound();
  await getItem(c, undefined, value.item_id, write ? 'attachments.write' : 'contents.read', value.repo_id, write);
  return value;
}

export function publicAttachment(value: Attachment): Record<string, unknown> & { revision: number } {
  return { id: value.id, repo_id: value.repo_id, item_id: value.item_id, filename: value.filename,
    content_type: value.content_type, bytes: value.bytes, sha256: value.sha256, state: value.state,
    revision: value.revision, created_by: value.created_by, created_at: value.created_at, updated_at: value.updated_at,
    ...(['reserving', 'pending'].includes(value.state) ? { upload_expires_at: value.retention_until } : {}) };
}

export function attachmentDisposition(filename: string): string {
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename*=UTF-8''${encoded}`;
}

function guarded(c: AppContext, statement: D1PreparedStatement): D1PreparedStatement[] {
  const guard = newId('guard');
  return [statement, mutationGuard(database(c), guard), stmt(database(c), 'DELETE FROM mutation_guards WHERE id=?', guard)];
}

/** Account byte/cost holds live exclusively in account:<account_id>; this is only the local repository cap. */
export function reserveAttachmentRepositoryBytes(c: AppContext, repo: Repository, bytes: number): D1PreparedStatement[] {
  return [stmt(database(c), `INSERT INTO storage_quotas(scope_id,limit_bytes,updated_at) VALUES (?,?,?) ON CONFLICT(scope_id) DO NOTHING`,
    repo.id, limits(c.env).repository_storage_bytes, now()), ...guarded(c, stmt(database(c),
    'UPDATE storage_quotas SET reserved_bytes=reserved_bytes+?,revision=revision+1,updated_at=? WHERE scope_id=? AND used_bytes+reserved_bytes+?<=limit_bytes',
    bytes, now(), repo.id, bytes))];
}

type ManifestFields = Partial<Pick<Attachment, 'state' | 'billing_reservation_id' | 'billing_fence' | 'upload_generation'
  | 'upload_bytes_received' | 'upload_failure' | 'retention_until' | 'storage_accrued_at'>> & { reference_count?: number };
interface TransitionOptions {
  authority?: { item: Item; repo: Repository };
  effects?: D1PreparedStatement[];
  touch_item?: boolean;
  sealed_at?: string;
}

export async function transitionAttachment(c: AppContext, value: Attachment, fields: ManifestFields, type: string, options: TransitionOptions = {}): Promise<Attachment> {
  const at = now();
  const keys = Object.keys(fields) as Array<keyof ManifestFields>;
  const after = guarded(c, stmt(database(c), `UPDATE collaboration_attachments SET revision=revision+1,updated_at=?${options.sealed_at ? ',sealed_at=?' : ''}
    WHERE repo_id=? AND item_id=? AND id=? AND object_id=? AND revision=?`, at, ...(options.sealed_at ? [options.sealed_at] : []),
  value.repo_id, value.item_id, value.id, value.object_id, value.association_revision));
  if (options.authority) after.push(...itemFence(database(c), options.authority.item));
  if (options.authority && options.touch_item) after.push(itemTouch(database(c), options.authority.item));
  after.push(...(options.effects ?? []));
  const data = { item_id: value.item_id, attachment_id: value.id, object_id: value.object_id,
    state: fields.state ?? value.state, ...(fields.upload_failure ? { reason: fields.upload_failure } : {}) };
  await commit(c, { repo: options.authority?.repo, item: options.touch_item ? options.authority?.item : undefined,
    resource_id: value.id, revision: value.revision + 1, type,
    event: makeEvent({ type, resource_id: value.id, resource_revision: value.revision + 1, repo_id: value.repo_id,
      account_id: value.account_id, actor_id: requirePrincipal(c).id, data }),
    sql: `UPDATE object_manifests SET ${keys.map(key => `${key}=?`).join(',')},revision=revision+1,updated_at=?
      WHERE id=? AND repo_id=? AND account_id=? AND kind='collaboration_attachment' AND state=? AND revision=? AND upload_generation=?`,
    bindings: [...keys.map(key => fields[key]), at, value.object_id, value.repo_id, value.account_id, value.state, value.revision, value.upload_generation], after,
    data });
  return { ...value, ...fields, revision: value.revision + 1, association_revision: value.association_revision + 1, updated_at: at };
}

const transition = transitionAttachment;

function receiptMatches(value: Attachment, receipt: StorageObject): boolean {
  return receipt.id === value.object_id && receipt.account_id === value.account_id && receipt.key === value.object_key
    && receipt.bucket === value.bucket && receipt.source === 'standalone' && receipt.attribution.repo_id === value.repo_id
    && receipt.maximum_bytes === String(value.bytes) && !!receipt.reservation_id && !!receipt.fence;
}

export async function admitAttachment(c: AppContext, value: Attachment, kind: ItemKind): Promise<Attachment> {
  if (value.state !== 'reserving') return value;
  if (!value.retention_until || value.retention_until <= now()) throw new ApiError(409, 'upload_expired', 'This upload admission expired and is awaiting verified cancellation.');
  await registerResourceLocator(c.env, { resource_id: value.object_id, resource_type: 'object', repo_id: value.repo_id });
  const receipt = await reserveStandaloneStorage(c.env, { account_id: value.account_id, repo_id: value.repo_id,
    actor_id: value.created_by, object_id: value.object_id, key: value.object_key, bucket: value.bucket,
    maximum_bytes: String(value.bytes), retention_until: value.requested_retention_until });
  if (!receiptMatches(value, receipt) || receipt.admission_state !== 'ready' || receipt.state !== 'uploading') {
    throw new ApiError(503, 'storage_admission_unconfirmed', 'The account storage admission must be reconciled before accepting bytes.');
  }
  const authority = await getItem(c, kind, value.item_id, 'attachments.write', value.repo_id);
  return transition(c, value, { state: 'pending', billing_reservation_id: receipt.reservation_id, billing_fence: receipt.fence }, 'attachment.admitted', { authority });
}

export function queueAttachmentCleanup(c: AppContext, item: Item, actorId: string): D1PreparedStatement {
  return stmt(database(c), `INSERT INTO collaboration_attachment_cleanup(object_id,attachment_id,repo_id,item_id,requested_by,reason,created_at,updated_at)
    SELECT o.id,a.id,a.repo_id,a.item_id,?,'parent_deleted',?,? FROM collaboration_attachments a JOIN object_manifests o ON o.id=a.object_id AND o.repo_id=a.repo_id
      WHERE a.repo_id=? AND a.item_id=? AND o.state<>'deleted' ON CONFLICT(object_id) DO NOTHING`, actorId, now(), now(), item.repo_id, item.id);
}

/** No capacity is released until the account authority has tombstoned the original admission intent. */
async function cancelReservingAttachment(c: AppContext, value: Attachment): Promise<Attachment> {
  if (value.upload_generation !== 0 || value.upload_bytes_received !== 0) throw new ApiError(409, 'upload_in_progress', 'The original storage producer must be reconciled.');
  const deleting = value.state === 'deleting' ? value : await transition(c, value,
    { state: 'deleting', reference_count: 0, retention_until: null }, 'attachment.admission_cancel_requested');
  await registerResourceLocator(c.env, { resource_id: deleting.object_id, resource_type: 'object', repo_id: deleting.repo_id });
  const proof = await cancelStandaloneStorageIntent(c.env, { account_id: deleting.account_id, repo_id: deleting.repo_id, object_id: deleting.object_id });
  if (proof.account_id !== deleting.account_id || proof.id !== deleting.object_id || proof.repo_id !== deleting.repo_id
    || proof.key !== deleting.object_key || proof.bucket !== deleting.bucket || proof.source !== 'standalone'
    || proof.state !== 'cancelled' || await bucket(c, deleting).head(deleting.object_key)) {
    throw new ApiError(503, 'storage_cancellation_unconfirmed', 'The original storage admission intent is still being reconciled.');
  }
  return transition(c, deleting, { state: 'deleted' }, 'attachment.admission_cancelled', {
    effects: guarded(c, stmt(database(c), `UPDATE storage_quotas SET reserved_bytes=reserved_bytes-?,revision=revision+1,updated_at=?
      WHERE scope_id=? AND reserved_bytes>=?`, deleting.bytes, now(), deleting.repo_id, deleting.bytes)),
  });
}

function bucket(c: AppContext, value: Attachment): R2Bucket {
  if (value.bucket !== 'blobs' || !c.env.BLOBS) throw new ApiError(503, 'storage_unavailable', 'Attachment storage is temporarily unavailable.');
  return c.env.BLOBS;
}

function verifiedObject(value: Attachment, object: R2Object): boolean {
  const digest = object.checksums.sha256 ? hex(new Uint8Array(object.checksums.sha256)) : null;
  return object.size === value.bytes && digest === value.sha256 && object.customMetadata?.repo_id === value.repo_id
    && object.customMetadata?.item_id === value.item_id && object.customMetadata?.attachment_id === value.id
    && object.customMetadata?.object_id === value.object_id && object.customMetadata?.upload_generation === String(value.upload_generation);
}

/** No retry in this function can issue a second R2 write for a claimed upload generation. */
export async function receiveAttachment(c: AppContext, value: Attachment, kind: ItemKind): Promise<Attachment> {
  if (value.state !== 'pending') throw new ApiError(409, value.state === 'uploading' ? 'upload_in_progress' : 'upload_not_pending',
    value.state === 'uploading' ? 'This upload generation is already in flight. Use the completion endpoint to reconcile it.' : 'Prepare this upload before sending its bytes.');
  if (!value.retention_until || value.retention_until <= now()) throw new ApiError(409, 'upload_expired', 'The upload reservation expired.');
  if (!value.billing_reservation_id || !value.billing_fence) throw new ApiError(503, 'storage_admission_unavailable', 'The account storage admission is not confirmed.');
  if (value.created_by !== requirePrincipal(c).id) notFound();
  const storage = bucket(c, value);
  const declared = c.req.header('content-length');
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) !== value.bytes)) throw new ApiError(422, 'size_mismatch', 'Content-Length must match the upload manifest.');
  const authority = await getItem(c, kind, value.item_id, 'attachments.write', value.repo_id);
  unlocked(authority.item);
  let claimed = await transition(c, value, { state: 'uploading', upload_generation: value.upload_generation + 1,
    upload_bytes_received: 0, upload_failure: null }, 'attachment.upload_started', { authority });
  let bytes: Uint8Array<ArrayBuffer>;
  let received = 0;
  try {
    bytes = await readBounded(c.req.raw.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { received += chunk.byteLength; controller.enqueue(chunk); },
    })) ?? null, value.bytes);
    if (bytes.byteLength !== value.bytes || await sha256(bytes) !== value.sha256) throw new ApiError(422, 'checksum_mismatch', 'The input does not match the reserved byte count and SHA-256.');
  } catch (error) {
    // No R2 call has happened. The upload owner can positively fence this failed input and permit a new generation.
    claimed = await transition(await maintenanceContext(c.env, claimed.repo_id), claimed,
      { state: 'pending', upload_bytes_received: received, upload_failure: 'input_incomplete' }, 'attachment.upload_input_rejected');
    c.header('etag', `"${claimed.revision}"`);
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, 'upload_input_incomplete', 'The input stream did not complete. Retrieve the current ETag and retry this attachment.');
  }
  claimed = await transition(c, claimed, { upload_bytes_received: bytes.byteLength, upload_failure: 'write_pending' }, 'attachment.storage_write_started');
  try {
    const stored = await storage.put(claimed.object_key, bytes, {
      onlyIf: { etagDoesNotMatch: '*' }, sha256: claimed.sha256,
      httpMetadata: { contentType: claimed.content_type, contentDisposition: attachmentDisposition(claimed.filename) },
      customMetadata: { repo_id: claimed.repo_id, item_id: claimed.item_id, attachment_id: claimed.id,
        object_id: claimed.object_id, upload_generation: String(claimed.upload_generation), sha256: claimed.sha256 },
    });
    const object = stored ?? await storage.head(claimed.object_key);
    if (!object || !verifiedObject(claimed, object)) throw new ApiError(503, 'upload_evidence_mismatch', 'The stored bytes do not match this upload generation.');
  } catch (error) {
    const current = await readAttachment(c, value.repo_id, value.item_id, value.id, true);
    if (current.state === 'uploading' && current.upload_generation === claimed.upload_generation && current.revision === claimed.revision) {
      claimed = await transition(await maintenanceContext(c.env, current.repo_id), current, { upload_failure: 'write_uncertain' }, 'attachment.storage_write_uncertain');
    }
    c.header('etag', `"${claimed.revision}"`);
    throw new ApiError(503, 'upload_unconfirmed', 'The storage write is being reconciled. Its upload fence and financial reservation remain active.',
      { attachment_id: value.id });
  }
  const current = await readAttachment(c, value.repo_id, value.item_id, value.id, true);
  if (current.state !== 'uploading' || current.upload_generation !== claimed.upload_generation) {
    throw new ApiError(412, 'upload_generation_changed', 'This upload was already reconciled. Read its current state.');
  }
  return completeAttachment(c, current, kind);
}

/** Positive, generation-bound R2 evidence can reconcile an accepted write; absence never clears the fence. */
export async function completeAttachment(c: AppContext, value: Attachment, kind: ItemKind): Promise<Attachment> {
  if (value.state === 'ready') return value;
  if (value.state !== 'uploading') throw new ApiError(409, 'upload_not_started', 'Upload this attachment before completing it.');
  if (value.upload_bytes_received !== value.bytes || !['write_pending', 'write_uncertain'].includes(value.upload_failure ?? '')) {
    throw new ApiError(409, 'upload_input_incomplete', 'The admitted upload owner has not completed its exact input yet.');
  }
  const object = await bucket(c, value).head(value.object_key);
  if (!object || !verifiedObject(value, object)) throw new ApiError(409, 'upload_unconfirmed', 'The exact upload generation has not been confirmed. Its fence remains active.');
  if (!value.billing_reservation_id || !value.billing_fence) throw new ApiError(503, 'storage_admission_unavailable', 'Storage admission must be reconciled before publishing this attachment.');
  const receipt = await commitStorageObject(c.env, { account_id: value.account_id, reservation_id: value.billing_reservation_id,
    fence: value.billing_fence, object_id: value.object_id, bytes: String(value.bytes), etag: object.etag, checksum: value.sha256 });
  if (!receiptMatches(value, receipt) || receipt.state !== 'stored' || receipt.bytes !== String(value.bytes)
    || receipt.reservation_id !== value.billing_reservation_id || receipt.fence !== value.billing_fence) {
    throw new ApiError(503, 'storage_settlement_unconfirmed', 'The retained-storage commitment has not been confirmed.');
  }
  // Authorization is deliberately after R2 verification and account-wide financial settlement.
  const authority = await getItem(c, kind, value.item_id, 'attachments.write', value.repo_id);
  const at = now();
  return transition(c, value, { state: 'ready', retention_until: value.requested_retention_until,
    storage_accrued_at: at, upload_bytes_received: value.bytes, upload_failure: null }, 'attachment.uploaded', {
    authority, sealed_at: at, touch_item: true,
    effects: guarded(c, stmt(database(c), `UPDATE storage_quotas SET reserved_bytes=reserved_bytes-?,used_bytes=used_bytes+?,revision=revision+1,updated_at=?
      WHERE scope_id=? AND reserved_bytes>=?`, value.bytes, value.bytes, at, value.repo_id, value.bytes)),
  });
}

export async function deleteAttachment(c: AppContext, value: Attachment, authority?: { item: Item; repo: Repository }): Promise<Attachment> {
  if (value.state === 'deleted') return value;
  await registerResourceLocator(c.env, { resource_id: value.object_id, resource_type: 'object', repo_id: value.repo_id });
  if (value.state === 'reserving' || value.state === 'deleting' && !value.billing_reservation_id) return cancelReservingAttachment(c, value);
  const unused = value.upload_generation === 0 || value.upload_failure === 'input_incomplete';
  if (!['pending', 'ready', 'failed', 'deleting'].includes(value.state) || (!value.storage_accrued_at && !unused)) {
    throw new ApiError(409, 'upload_in_progress', 'Reconcile this upload or storage admission before deleting it.');
  }
  if (!value.billing_reservation_id || !value.billing_fence) throw new ApiError(503, 'storage_admission_unavailable', 'The storage reservation must be reconciled before deletion.');
  let deleting = value;
  if (value.state !== 'deleting') {
    // A NULL cleanup deadline keeps the generic TTL reaper out of this billing-owned deletion saga.
    deleting = await transition(c, value, { state: 'deleting', reference_count: 0, retention_until: null }, 'attachment.deleting', { authority, touch_item: !!authority });
  }
  const receipt = await deleteStorageObject(c.env, { account_id: deleting.account_id, object_id: deleting.object_id });
  if (!receiptMatches(deleting, receipt) || receipt.state !== 'deleted' || receipt.reservation_id !== deleting.billing_reservation_id
    || receipt.fence !== deleting.billing_fence || await bucket(c, deleting).head(deleting.object_key)) {
    throw new ApiError(503, 'storage_deletion_unconfirmed', 'Physical storage deletion and financial release are still being reconciled.');
  }
  const column = deleting.storage_accrued_at ? 'used_bytes' : 'reserved_bytes';
  return transition(c, deleting, { state: 'deleted' }, 'attachment.deleted', {
    effects: guarded(c, stmt(database(c), `UPDATE storage_quotas SET ${column}=${column}-?,revision=revision+1,updated_at=?
      WHERE scope_id=? AND ${column}>=?`, deleting.bytes, now(), deleting.repo_id, deleting.bytes)),
  });
}

/** Only pending, provably unused reservations and already-fenced deletions are eligible for automatic cleanup. */
export async function sweepAttachmentStorage(env: Bindings): Promise<void> {
  const enumeration = await maintenanceContext(env);
  const rows = await many<Attachment>(database(enumeration), `${attachmentSelect} WHERE o.state='deleting' OR
    (o.state IN ('reserving','pending') AND o.retention_until<=? AND (o.upload_generation=0 OR o.upload_failure='input_incomplete')) OR
    (o.state<>'deleted' AND EXISTS(SELECT 1 FROM collaboration_attachment_cleanup q WHERE q.object_id=o.id AND q.state<>'completed'))
    ORDER BY o.updated_at,o.id LIMIT 50`, now());
  for (const hint of rows) {
    const c = await maintenanceContext(env, hint.repo_id);
    const value = await readAttachment(c, hint.repo_id, hint.item_id, hint.id, true);
    if (value.state === 'deleted') { await finishCleanup(c, value, 'completed', null); continue; }
    try {
      const parent = await one<{ deleted_at: string | null }>(database(c), 'SELECT deleted_at FROM collaboration_items WHERE repo_id=? AND id=?', value.repo_id, value.item_id);
      const queued = await one<{ reason: string }>(database(c), 'SELECT reason FROM collaboration_attachment_cleanup WHERE object_id=? AND state<>?', value.object_id, 'completed');
      if (queued?.reason === 'parent_deleted' && !parent?.deleted_at && value.state !== 'deleting') {
        await finishCleanup(c, value, 'completed', 'parent_restored');
        continue;
      }
      if (value.state !== 'deleting' && !queued && !(value.retention_until && value.retention_until <= now()
        && ['reserving', 'pending'].includes(value.state) && (value.upload_generation === 0 || value.upload_failure === 'input_incomplete'))) continue;
      let target = value;
      if (value.state === 'uploading') {
        if (!parent?.deleted_at) continue;
        target = await fenceAcceptedAbandonedUpload(c, value);
      }
      await deleteAttachment(c, target);
      await finishCleanup(c, value, 'completed', null);
    }
    catch (error) {
      if (await isMaintenanceRace(env, error, async () => !!await one(database(c),
        'SELECT 1 FROM object_manifests WHERE id=? AND revision=? AND state=?', value.object_id, value.revision, value.state))) continue;
      if (error instanceof ApiError && error.code === 'upload_unconfirmed') {
        await finishCleanup(c, value, 'blocked', error.code);
        continue;
      }
      console.error(JSON.stringify({ event: 'attachment.cleanup_pending', attachment_id: value.id,
        code: error instanceof ApiError ? error.code : 'storage_cleanup_unconfirmed' }));
      throw error;
    }
  }
}

async function fenceAcceptedAbandonedUpload(c: AppContext, value: Attachment): Promise<Attachment> {
  if (value.upload_bytes_received !== value.bytes || !['write_pending', 'write_uncertain'].includes(value.upload_failure ?? '')) {
    throw new ApiError(409, 'upload_unconfirmed', 'The abandoned upload still has an unconfirmed producer.');
  }
  const object = await bucket(c, value).head(value.object_key);
  if (!object || !verifiedObject(value, object) || !value.billing_reservation_id || !value.billing_fence) {
    throw new ApiError(409, 'upload_unconfirmed', 'The abandoned upload has no definitive storage receipt.');
  }
  const receipt = await commitStorageObject(c.env, { account_id: value.account_id, object_id: value.object_id,
    reservation_id: value.billing_reservation_id, fence: value.billing_fence, bytes: String(value.bytes), etag: object.etag, checksum: value.sha256 });
  if (!receiptMatches(value, receipt) || receipt.state !== 'stored') throw new ApiError(503, 'storage_settlement_unconfirmed', 'The abandoned upload settlement is unconfirmed.');
  return transition(c, value, { state: 'deleting', reference_count: 0, retention_until: null, storage_accrued_at: now() }, 'attachment.abandoned_upload_fenced', {
    effects: guarded(c, stmt(database(c), `UPDATE storage_quotas SET reserved_bytes=reserved_bytes-?,used_bytes=used_bytes+?,revision=revision+1,updated_at=?
      WHERE scope_id=? AND reserved_bytes>=?`, value.bytes, value.bytes, now(), value.repo_id, value.bytes)),
  });
}

async function finishCleanup(c: AppContext, value: Attachment, state: 'blocked' | 'completed', reason: string | null): Promise<void> {
  const queued = await one<{ revision: number; state: string; last_error: string | null }>(database(c),
    'SELECT revision,state,last_error FROM collaboration_attachment_cleanup WHERE object_id=? AND repo_id=?', value.object_id, value.repo_id);
  if (!queued || queued.state === state && queued.last_error === reason) return;
  await commit(c, { resource_id: value.id, revision: queued.revision + 1, type: 'attachment.cleanup_progress',
    sql: 'UPDATE collaboration_attachment_cleanup SET state=?,last_error=?,revision=revision+1,updated_at=? WHERE object_id=? AND repo_id=? AND revision=?',
    bindings: [state, reason, now(), value.object_id, value.repo_id, queued.revision], data: { item_id: value.item_id, state, reason } });
}
