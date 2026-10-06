import { ApiError, identityBinding, many, now, one, stmt } from '@gitknot/core';
import type { EventRecord } from '@gitknot/core';
import { claimStorageDeletion } from '../../billing/src/retention.ts';
import type { StorageDeletionRequest } from '../../billing/src/types.ts';
import { attachmentSelect, deleteAttachment } from '../../../apps/api/src/modules/collaboration/attachment-storage.ts';
import type { Attachment } from '../../../apps/api/src/modules/collaboration/attachment-storage.ts';
import { maintenanceContext } from '../../../apps/api/src/modules/collaboration/maintenance.ts';
import { deleteRequestedObject } from './objects.ts';
import { isIdentityPlacement, localRepository } from './ownership.ts';
import { consumeOnce } from './durable.ts';
import type { OperationsBindings } from './types.ts';

async function fulfill(env: OperationsBindings, request: StorageDeletionRequest): Promise<void> {
  if (await one(env.DB, 'SELECT 1 FROM storage_cleanup_receipts WHERE request_id=?', request.id)) return;
  let completed = await deleteRequestedObject(env, request);
  if (!completed && request.repo_id) {
    const attachment = await one<Attachment>(env.DB, `${attachmentSelect} WHERE a.repo_id=? AND o.id=?`, request.repo_id, request.object_id);
    if (attachment) {
      if (attachment.account_id !== request.account_id || attachment.billing_fence !== request.fence
        || attachment.billing_reservation_id !== request.reservation_id) throw new Error('attachment_cleanup_fence_changed');
      if (attachment.state !== 'deleted') {
        await claimStorageDeletion(env, { account_id: request.account_id, object_id: request.object_id, request_id: request.id });
        await deleteAttachment(await maintenanceContext(env, request.repo_id), attachment);
      }
      completed = true;
    }
  }
  if (!completed) throw new ApiError(503, 'storage_cleanup_owner_pending', 'The owning feature has not confirmed its storage cleanup.');
  await consumeOnce(env.DB, 'storage-cleanup', request.id, [stmt(env.DB,
    'INSERT INTO storage_cleanup_receipts(request_id,object_id,repo_id,account_id,completed_at) VALUES(?,?,?,?,?)',
    request.id, request.object_id, request.repo_id, request.account_id, now())]);
}

export async function consumeStorageDeletion(env: OperationsBindings, event: EventRecord): Promise<void> {
  const id = event.data.deletion_request_id;
  if (typeof id !== 'string' || typeof event.data.object_id !== 'string' || !event.account_id) throw new Error('storage_deletion_event_invalid');
  const request = await one<StorageDeletionRequest>(identityBinding(env).withSession('first-primary'), 'SELECT * FROM billing_storage_deletion_requests WHERE id=?', id);
  if (!request || request.object_id !== event.data.object_id || request.account_id !== event.account_id
    || request.repo_id !== event.repo_id || request.fence !== event.data.fence) throw new Error('storage_deletion_event_scope');
  if (request.state === 'cancelled') return;
  await fulfill(env, request);
}

/** The source outbox is the primary wake-up; this bounded cursor also repairs missed wake-ups. */
export async function sweepStorageCleanup(env: OperationsBindings): Promise<number> {
  const cursor = await one<{ after_id: string }>(env.DB, "SELECT after_id FROM operations_sweep_cursors WHERE name='storage-cleanup'");
  const rows = await many<StorageDeletionRequest>(identityBinding(env).withSession('first-primary'),
    `SELECT * FROM billing_storage_deletion_requests WHERE id>? AND state IN ('pending','claimed','financially_deleted') ORDER BY id LIMIT 100`, cursor?.after_id ?? '');
  let completed = 0;
  for (const request of rows) {
    if (request.repo_id ? !await localRepository(env, request.repo_id) : !isIdentityPlacement(env)) continue;
    await fulfill(env, request); completed++;
  }
  await stmt(env.DB, `INSERT INTO operations_sweep_cursors(name,after_id) VALUES('storage-cleanup',?)
    ON CONFLICT(name) DO UPDATE SET after_id=excluded.after_id`, rows.length === 100 ? rows.at(-1)!.id : '').run();
  return completed;
}
