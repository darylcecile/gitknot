import { auditStatement, many, now, one, stmt } from '@gitknot/core';
import type { Repository } from '@gitknot/core';
import { invariant } from './errors.ts';
import { billingMetadata } from './storage-policy.ts';
import type { StorageTransferAuthority } from './storage-policy.ts';
import { admissionRequest } from './transport.ts';
import { guardedBatch } from './catalog.ts';
import { billingEnvironment } from './authority.ts';
import { abortCanonicalTransfers, completeCanonicalTransfers, prepareCanonicalTransfers } from './git-transfer.ts';
import type { BillingBindings, StorageObject } from './types.ts';

export interface StorageHandoff {
  operation_id: string; repo_id: string; from_account_id: string; to_account_id: string; actor_id: string;
  state: 'preparing' | 'prepared' | 'committing' | 'complete' | 'aborting' | 'aborted'; effective_at: string | null;
  created_at: string; updated_at: string; revision: number;
}
export interface StorageTransferReceipt { object_id: string; account_id: string; reservation_id: string; fence: string }
export interface HandoffProgress { state: StorageHandoff['state']; processed: number; operation_id: string }

export async function verifyStorageHandoff(env: BillingBindings, operationId: string, phase: 'prepare' | 'commit' | 'abort'): Promise<StorageHandoff> {
  env = billingEnvironment(env);
  const handoff = await one<StorageHandoff>(env.DB, 'SELECT * FROM billing_storage_handoffs WHERE operation_id=?', operationId);
  invariant(handoff, 'storage_handoff_not_found', 'Storage ownership handoff not found.', 404);
  const authority = await billingMetadata<StorageTransferAuthority>(env, { repo_id: handoff.repo_id, transfer_operation_id: operationId });
  const repo = await billingMetadata<Repository>(env, { repo_id: handoff.repo_id });
  invariant(authority && repo && authority.source_owner_id === handoff.from_account_id && authority.destination_owner_id === handoff.to_account_id,
    'storage_handoff_scope', 'The storage handoff does not match the authoritative repository transfer.');
  if (phase === 'abort') {
    invariant(repo.owner_id === handoff.from_account_id && ['cancelled', 'expired', 'failed'].includes(authority.state),
      'storage_handoff_not_cancelled', 'The catalog must cancel its owner-change intent before storage holds can be compensated.');
    return handoff;
  }
  invariant(authority.accepted_by && authority.accepted_at && authority.accepted_by === handoff.actor_id
    && ['accepted', 'moving', 'completed'].includes(authority.state), 'storage_handoff_not_accepted', 'The receiving principal must accept this exact repository transfer.');
  invariant(['transfer_pending', 'moving'].includes(repo.state), 'repository_not_fenced', 'Keep repository writes fenced until storage ownership has committed.');
  invariant(repo.owner_id === (phase === 'prepare' ? handoff.from_account_id : handoff.to_account_id), 'storage_handoff_owner_changed', 'The repository ownership phase changed.');
  return handoff;
}

/** Bounded Workflow step; repeat until state=prepared, then perform the still-fenced catalog owner CAS. */
export async function prepareRepositoryStorageTransfer(env: BillingBindings, input: {
  operation_id: string; repo_id: string; from_account_id: string; to_account_id: string; actor_id: string;
}): Promise<HandoffProgress> {
  env = billingEnvironment(env);
  await env.DB.prepare(`INSERT OR IGNORE INTO billing_storage_handoffs
    (operation_id,repo_id,from_account_id,to_account_id,actor_id,state,created_at,updated_at) VALUES (?,?,?,?,?,'preparing',?,?)`)
    .bind(input.operation_id, input.repo_id, input.from_account_id, input.to_account_id, input.actor_id, now(), now()).run();
  const handoff = await verifyStorageHandoff(env, input.operation_id, 'prepare');
  invariant(Object.entries(input).every(([k, v]) => handoff[k as keyof StorageHandoff] === v), 'storage_handoff_conflict', 'The handoff ID already has different immutable participants.');
  if (handoff.state === 'prepared') return { state: 'prepared', processed: 0, operation_id: input.operation_id };
  invariant(handoff.state === 'preparing', 'storage_handoff_phase', 'This ownership handoff is no longer preparing.');
  const uploading = await one(env.DB, `SELECT id FROM billing_storage_objects WHERE coordinator_id=? AND repo_id=? AND state IN ('uploading','transfer_pending','deleting') LIMIT 1`,
    `account:${input.from_account_id}`, input.repo_id);
  invariant(!uploading, 'storage_not_quiescent', 'Reconcile or cancel unfinished uploads before preparing the ownership handoff.');
  const gitPending = await one(env.DB, "SELECT 1 FROM billing_git_operations WHERE coordinator_id=? AND repo_id=? AND state IN ('prepared','reserved') LIMIT 1", `account:${input.from_account_id}`, input.repo_id);
  invariant(!gitPending, 'git_not_quiescent', 'Reconcile canonical publication before transferring storage ownership.');
  const git = await prepareCanonicalTransfers(env, handoff);
  if (git.remaining || git.processed === 32) return { state: 'preparing', processed: git.processed, operation_id: input.operation_id };
  const objects = await many<{ id: string }>(env.DB, `SELECT s.id FROM billing_storage_objects s WHERE s.coordinator_id=? AND s.repo_id=? AND s.state IN ('stored','transferring')
    AND NOT EXISTS(SELECT 1 FROM billing_storage_transfers t WHERE t.operation_id=? AND t.object_id=s.id AND t.state='prepared') ORDER BY s.id LIMIT ?`,
  `account:${input.from_account_id}`, input.repo_id, input.operation_id, 32 - git.processed);
  for (const row of objects) {
    const initial = await admissionRequest<StorageObject>(env, `account:${input.from_account_id}`, 'get-object', { object_id: row.id });
    await env.DB.prepare(`INSERT INTO billing_storage_transfers
      (operation_id,object_id,from_account_id,to_account_id,repo_id,state,source_json,created_at,updated_at) VALUES (?,?,?,?,?,'preparing',?,?,?)
      ON CONFLICT(operation_id,object_id) DO UPDATE SET source_json=excluded.source_json,updated_at=excluded.updated_at WHERE billing_storage_transfers.state='preparing'`)
      .bind(input.operation_id, row.id, input.from_account_id, input.to_account_id, input.repo_id, JSON.stringify(initial), now(), now()).run();
    const source = await admissionRequest<StorageObject>(env, `account:${input.from_account_id}`, 'transfer-out', { object_id: row.id, operation_id: input.operation_id });
    await env.DB.prepare('UPDATE billing_storage_transfers SET source_json=?,updated_at=? WHERE operation_id=? AND object_id=?').bind(JSON.stringify(source), now(), input.operation_id, row.id).run();
    const target = await admissionRequest<StorageObject>(env, `account:${input.to_account_id}`, 'transfer-in', { object_id: row.id, operation_id: input.operation_id });
    const receipt: StorageTransferReceipt = { object_id: row.id, account_id: input.to_account_id, reservation_id: target.reservation_id, fence: target.fence };
    await env.DB.prepare("UPDATE billing_storage_transfers SET state='prepared',receipt_json=?,updated_at=? WHERE operation_id=? AND object_id=? AND state='preparing'")
      .bind(JSON.stringify(receipt), now(), input.operation_id, row.id).run();
  }
  const remaining = await one(env.DB, `SELECT s.id FROM billing_storage_objects s WHERE s.coordinator_id=? AND s.repo_id=? AND s.state IN ('stored','transferring')
    AND NOT EXISTS(SELECT 1 FROM billing_storage_transfers t WHERE t.operation_id=? AND t.object_id=s.id AND t.state='prepared') LIMIT 1`,
  `account:${input.from_account_id}`, input.repo_id, input.operation_id);
  if (!remaining) await env.DB.prepare("UPDATE billing_storage_handoffs SET state='prepared',revision=revision+1,updated_at=? WHERE operation_id=? AND state='preparing'").bind(now(), input.operation_id).run();
  return { state: remaining ? 'preparing' : 'prepared', processed: objects.length + git.processed, operation_id: input.operation_id };
}

/** Bounded Workflow step; repeat until complete. Both old and new ledgers use the SAME immutable consumption boundary. */
export async function commitRepositoryStorageTransfer(env: BillingBindings, input: { operation_id: string; effective_at: string }): Promise<HandoffProgress> {
  env = billingEnvironment(env);
  const completed = await one<StorageHandoff>(env.DB, "SELECT * FROM billing_storage_handoffs WHERE operation_id=? AND state='complete'", input.operation_id);
  if (completed) {
    invariant(completed.effective_at === input.effective_at, 'storage_handoff_conflict', 'The consumption ownership boundary is immutable.');
    return { state: 'complete', processed: 0, operation_id: input.operation_id };
  }
  const handoff = await verifyStorageHandoff(env, input.operation_id, 'commit');
  invariant(Number.isFinite(Date.parse(input.effective_at)) && input.effective_at <= now() && input.effective_at >= handoff.created_at,
    'invalid_handoff_boundary', 'Storage ownership requires the observed catalog owner-CAS timestamp.', 422);
  invariant(!handoff.effective_at || handoff.effective_at === input.effective_at, 'storage_handoff_conflict', 'The consumption ownership boundary is immutable.');
  if (handoff.state === 'complete') return { state: 'complete', processed: 0, operation_id: input.operation_id };
  invariant(['prepared', 'committing'].includes(handoff.state), 'storage_handoff_not_prepared', 'Finish all receiving reservations before changing storage ownership.');
  await env.DB.prepare("UPDATE billing_storage_handoffs SET state='committing',effective_at=?,revision=revision+1,updated_at=? WHERE operation_id=? AND state IN ('prepared','committing') AND (effective_at IS NULL OR effective_at=?)")
    .bind(input.effective_at, now(), input.operation_id, input.effective_at).run();
  const git = await completeCanonicalTransfers(env, handoff, input.effective_at);
  if (git.remaining || git.processed === 32) return { state: 'committing', processed: git.processed, operation_id: input.operation_id };
  const rows = await many<{ object_id: string; source_json: string; receipt_json: string }>(env.DB,
    "SELECT object_id,source_json,receipt_json FROM billing_storage_transfers WHERE operation_id=? AND state='prepared' ORDER BY object_id LIMIT ?", input.operation_id, 32 - git.processed);
  for (const row of rows) {
    const source = JSON.parse(row.source_json) as StorageObject;
    const receipt = JSON.parse(row.receipt_json) as StorageTransferReceipt;
    await admissionRequest(env, `account:${handoff.to_account_id}`, 'transfer-activate', { object_id: row.object_id, operation_id: input.operation_id, effective_at: input.effective_at });
    await admissionRequest(env, `account:${handoff.from_account_id}`, 'transfer-settle', { object_id: row.object_id, operation_id: input.operation_id, effective_at: input.effective_at });
    await guardedBatch(env.DB, stmt(env.DB, `UPDATE billing_storage_keys SET account_id=?,reservation_id=? WHERE bucket=? AND object_key=? AND object_id=? AND account_id IN (?,?)`,
      handoff.to_account_id, receipt.reservation_id, source.bucket, source.key, source.id, handoff.from_account_id, handoff.to_account_id), [
      stmt(env.DB, "UPDATE billing_storage_transfers SET state='complete',effective_at=?,updated_at=? WHERE operation_id=? AND object_id=? AND state='prepared'", input.effective_at, now(), input.operation_id, row.object_id),
    ]);
  }
  const remaining = await one(env.DB, "SELECT object_id FROM billing_storage_transfers WHERE operation_id=? AND state!='complete' LIMIT 1", input.operation_id);
  if (!remaining) await env.DB.batch([
    stmt(env.DB, "UPDATE billing_storage_handoffs SET state='complete',revision=revision+1,updated_at=? WHERE operation_id=? AND state='committing'", now(), input.operation_id),
    auditStatement(env.DB, { id: `audit:storage-handoff:${input.operation_id}`, action: 'billing.storage.ownership_transferred', resource_id: handoff.repo_id,
      repo_id: handoff.repo_id, account_id: handoff.to_account_id, actor_id: handoff.actor_id,
      details: { operation_id: input.operation_id, previous_account_id: handoff.from_account_id, effective_at: input.effective_at } }),
  ]);
  return { state: remaining ? 'committing' : 'complete', processed: rows.length + git.processed, operation_id: input.operation_id };
}

export async function abortRepositoryStorageTransfer(env: BillingBindings, input: { operation_id: string }): Promise<HandoffProgress> {
  env = billingEnvironment(env);
  const handoff = await verifyStorageHandoff(env, input.operation_id, 'abort');
  invariant(handoff.state !== 'complete' && handoff.state !== 'committing', 'storage_handoff_committed', 'A committed ownership boundary cannot be compensated.');
  const git = await abortCanonicalTransfers(env, handoff);
  if (git.remaining || git.processed === 32) return { state: 'aborting', processed: git.processed, operation_id: input.operation_id };
  const rows = await many<{ object_id: string }>(env.DB, "SELECT object_id FROM billing_storage_transfers WHERE operation_id=? AND state!='aborted' ORDER BY object_id LIMIT ?", input.operation_id, 32 - git.processed);
  for (const row of rows) {
    await admissionRequest(env, `account:${handoff.to_account_id}`, 'transfer-abort-in', { object_id: row.object_id, operation_id: input.operation_id });
    await admissionRequest(env, `account:${handoff.from_account_id}`, 'transfer-resume', { object_id: row.object_id, operation_id: input.operation_id });
    await env.DB.prepare("UPDATE billing_storage_transfers SET state='aborted',updated_at=? WHERE operation_id=? AND object_id=?").bind(now(), input.operation_id, row.object_id).run();
  }
  const remaining = await one(env.DB, "SELECT object_id FROM billing_storage_transfers WHERE operation_id=? AND state!='aborted' LIMIT 1", input.operation_id);
  await env.DB.prepare('UPDATE billing_storage_handoffs SET state=?,revision=revision+1,updated_at=? WHERE operation_id=?').bind(remaining ? 'aborting' : 'aborted', now(), input.operation_id).run();
  return { state: remaining ? 'aborting' : 'aborted', processed: rows.length + git.processed, operation_id: input.operation_id };
}

/** Apply these durable receipts to manifests in a separate resumable phase, then unfence the catalog. */
export async function storageTransferReceipts(env: Pick<BillingBindings, 'DB'>, operationId: string, after = '', limit = 100): Promise<{ items: StorageTransferReceipt[]; next_cursor: string | null }> {
  env = billingEnvironment(env);
  invariant(Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'invalid_page', 'Receipt pages contain at most 100 objects.', 422);
  const rows = await many<{ object_id: string; receipt_json: string }>(env.DB, "SELECT object_id,receipt_json FROM billing_storage_transfers WHERE operation_id=? AND state='complete' AND object_id>? ORDER BY object_id LIMIT ?", operationId, after, limit + 1);
  return { items: rows.slice(0, limit).map((r) => JSON.parse(r.receipt_json) as StorageTransferReceipt), next_cursor: rows.length > limit ? rows[limit - 1]!.object_id : null };
}
