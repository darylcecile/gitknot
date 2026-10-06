import { ApiError, database, makeEvent, newId, now, one, requirePrincipal, sha256, stmt } from '@gitknot/core';
import type { AppContext, IdempotencyRecord } from '@gitknot/core';
import type { Attachment } from './attachment-storage.ts';
import { commit } from './common.ts';

export type AttachmentAction = 'create' | 'prepare' | 'complete' | 'delete';
export interface AttachmentSaga {
  operation_id: string; attachment_id: string; object_id: string; repo_id: string; item_id: string;
  principal_id: string; action: AttachmentAction; request_hash: string; initial_revision: number; upload_generation: number;
}

export async function attachmentIdentity(c: AppContext): Promise<{ id: string; object_id: string; operation_id: string }> {
  const operation = c.get('idempotency')?.operation_id ?? newId('attachment_op');
  const digest = (await sha256(`GitKnot attachment intent\n${requirePrincipal(c).id}\n${operation}`)).slice(0, 32);
  return { id: `attachment_${digest}`, object_id: `obj_${digest}`, operation_id: operation };
}

export function sagaStatement(c: AppContext, value: AttachmentSaga): D1PreparedStatement {
  return stmt(database(c), `INSERT INTO collaboration_attachment_sagas(operation_id,attachment_id,object_id,repo_id,item_id,principal_id,action,
    request_hash,initial_revision,upload_generation,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, value.operation_id, value.attachment_id, value.object_id,
  value.repo_id, value.item_id, value.principal_id, value.action, value.request_hash, value.initial_revision, value.upload_generation, now());
}

export function newAttachmentSaga(c: AppContext, value: Pick<Attachment, 'id' | 'object_id' | 'repo_id' | 'item_id' | 'revision' | 'upload_generation'>,
  action: AttachmentAction, operationId = c.get('idempotency')?.operation_id ?? newId('attachment_op')): AttachmentSaga {
  return { operation_id: operationId, attachment_id: value.id, object_id: value.object_id, repo_id: value.repo_id, item_id: value.item_id,
    principal_id: requirePrincipal(c).id, action, request_hash: c.get('idempotency')?.request_hash ?? operationId,
    initial_revision: value.revision, upload_generation: value.upload_generation };
}

function validateSaga(c: AppContext, saga: AttachmentSaga, value: Attachment, action: AttachmentAction): void {
  if (saga.attachment_id !== value.id || saga.object_id !== value.object_id || saga.repo_id !== value.repo_id || saga.item_id !== value.item_id
    || saga.action !== action || saga.principal_id !== requirePrincipal(c).id
    || c.get('idempotency') && saga.request_hash !== c.get('idempotency')!.request_hash) {
    throw new ApiError(409, 'attachment_intent_mismatch', 'This operation is bound to a different attachment intent.');
  }
  if (['complete', 'delete'].includes(action) && value.upload_generation !== saga.upload_generation) {
    throw new ApiError(409, 'upload_generation_changed', 'This operation belongs to an earlier upload generation. Read the attachment before starting another action.');
  }
}

/** The accepted manifest/generation is durable before the first external effect. */
export async function beginAttachmentSaga(c: AppContext, value: Attachment, action: Exclude<AttachmentAction, 'create'>): Promise<AttachmentSaga> {
  const operation = c.get('idempotency')?.operation_id ?? newId('attachment_op');
  const existing = await one<AttachmentSaga>(database(c), 'SELECT * FROM collaboration_attachment_sagas WHERE operation_id=?', operation);
  if (existing) { validateSaga(c, existing, value, action); return existing; }
  const saga = newAttachmentSaga(c, value, action, operation);
  const data = { item_id: value.item_id, attachment_id: value.id, action, operation_id: operation };
  await commit(c, { resource_id: value.id, revision: value.revision, type: 'attachment.operation_accepted',
    event: makeEvent({ type: 'attachment.operation_accepted', resource_id: value.id, resource_revision: value.revision,
      repo_id: value.repo_id, account_id: value.account_id, actor_id: requirePrincipal(c).id, data }),
    sql: `INSERT INTO collaboration_attachment_sagas(operation_id,attachment_id,object_id,repo_id,item_id,principal_id,action,request_hash,
      initial_revision,upload_generation,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (
      SELECT 1 FROM object_manifests WHERE id=? AND repo_id=? AND revision=? AND state=? AND upload_generation=?)`,
    bindings: [saga.operation_id, value.id, value.object_id, value.repo_id, value.item_id, saga.principal_id, action,
      saga.request_hash, value.revision, value.upload_generation, now(), value.object_id, value.repo_id, value.revision, value.state, value.upload_generation],
    data });
  return saga;
}

export async function recoverySaga(c: AppContext, record: IdempotencyRecord, value: Attachment, action: AttachmentAction): Promise<AttachmentSaga | null> {
  if (!record.operation_id) throw new ApiError(503, 'attachment_recovery_unavailable', 'The external attachment operation has no durable identity.');
  const saga = await one<AttachmentSaga>(database(c), 'SELECT * FROM collaboration_attachment_sagas WHERE operation_id=?', record.operation_id);
  if (!saga) {
    if (record.committed_at || record.resource_id) throw new ApiError(503, 'attachment_recovery_unavailable', 'The accepted attachment operation binding is unavailable.');
    return null;
  }
  validateSaga(c, saga, value, action);
  return saga;
}
