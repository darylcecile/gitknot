import { ApiError, eventStatement, execute, identityBinding, mutationGuard, newId, now, one, sha256, stmt } from '@gitknot/core';
import { metadataFenceGuard, operationFence } from './metadata-fence.ts';
import type { MetadataFenceReceipt } from './metadata-fence.ts';
import { privateJSON } from './private.ts';
import type { Operation, OperationsBindings } from './types.ts';

export function definitiveSnapshotFailure(error: unknown): boolean {
  if (error instanceof ApiError && [400, 401, 403, 404, 412, 422].includes(error.status)) return true;
  return /SQLITE_ERROR|too many terms|no such (?:table|column)|archive_(?:dependency|schema|identity|ref_audience|retained_ref|bundle_ref|snapshot_refs)/.test(String(error));
}

export function snapshotAbandoned(): ApiError {
  return new ApiError(409, 'snapshot_abandoned', 'This read-only capture was abandoned. A new capture requires a new operation.');
}

async function releaseDirectory(env: OperationsBindings, receipt: MetadataFenceReceipt): Promise<void> {
  await execute(env.DIRECTORY_DB ?? identityBinding(env), `UPDATE resource_routes SET state='active',operation_id=NULL,updated_at=?
    WHERE resource_id=? AND cell_id=? AND shard_id=? AND operation_id=? AND epoch=? AND state='fenced'`,
  now(), receipt.repo_id, env.CELL_ID, env.SHARD_ID, receipt.operation_id, receipt.routing_epoch);
}

/** Abandon a read-only namespace; uncertain R2 writes retain their original financial holds. */
export async function abandonReadOnlySnapshot(env: OperationsBindings, operation: Operation): Promise<boolean> {
  if (!['repository.backup', 'repository.export'].includes(operation.kind) || !operation.repo_id) return false;
  const db = env.DB.withSession('first-primary');
  const current = await one<Operation>(db, 'SELECT * FROM operations WHERE id=?', operation.id);
  if (!current || ['completed', 'cancelled'].includes(current.status)) return false;
  if (!['archive', 'verify-export-source', 'snapshot_abandoning', 'snapshot_abandoned'].includes(current.phase)) return false;
  const receipt = await operationFence(db, operation.id);
  if (!receipt) return false;
  if (current.phase === 'snapshot_abandoned') { await releaseDirectory(env, receipt); return true; }
  if (await one(db, "SELECT 1 FROM repository_archives WHERE operation_id=? AND state='verified'", operation.id)) return false;
  if (current.phase !== 'snapshot_abandoning') {
    const guard = newId('guard');
    await db.batch([
      ...metadataFenceGuard(db, operation.repo_id, receipt),
      stmt(db, `UPDATE operations SET status='failed',phase='snapshot_abandoning',error_json=?,revision=revision+1,updated_at=?
        WHERE id=? AND revision=? AND status NOT IN ('completed','cancelled')`,
      JSON.stringify({ code: 'snapshot_abandoning', retryable: true }), now(), operation.id, current.revision),
      mutationGuard(db, guard), stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard),
    ]);
  }
  const token = `lifecycle_${operation.id}`;
  // Native release independently refuses an active/uncertain canonical publisher.
  const released = await privateJSON<{ held: boolean }>(env, env.GIT_SERVICE, 'git-service', `/internal/git/repositories/${operation.repo_id}/barrier`,
    { operation_id: operation.id, token }, 'DELETE');
  if (released.held !== false) throw new Error('snapshot_abandonment_native_unconfirmed');
  const at = now(), archiveId = `archive_${operation.id}`, prefix = `${operation.account_id}/${operation.repo_id}/archives/${archiveId}/`;
  await db.batch([
    ...metadataFenceGuard(db, operation.repo_id, receipt),
    stmt(db, `UPDATE operations SET status='failed',phase='snapshot_abandoned',error_json=?,revision=revision+1,updated_at=?
      WHERE id=? AND phase='snapshot_abandoning'`, JSON.stringify({ code: 'snapshot_abandoned', retryable: false }), at, operation.id),
    stmt(db, "UPDATE operation_steps SET state='failed',error_code='snapshot_abandoned',completed_at=? WHERE operation_id=? AND state='running'", at, operation.id),
    stmt(db, "UPDATE repository_archives SET state='expired' WHERE operation_id=? AND state='writing'", operation.id),
    stmt(db, "UPDATE repository_exports SET state='failed',revision=revision+1 WHERE operation_id=? AND state<>'completed'", operation.id),
    stmt(db, `UPDATE object_manifests SET reference_count=0,retention_until=?,requested_retention_until=?,revision=revision+1,updated_at=?
      WHERE repo_id=? AND kind='archive_chunk' AND substr(object_key,1,?)=? AND state<>'deleted'`, at, at, at, operation.repo_id, prefix.length, prefix),
    stmt(db, "UPDATE repository_lifecycle SET state='failed',failure_code='snapshot_abandoned',updated_at=? WHERE operation_id=?", at, operation.id),
    stmt(db, 'UPDATE operations_maintenance_intents SET barrier_released_at=? WHERE operation_id=? AND barrier_token_hash=?', at, operation.id, await sha256(token)),
    stmt(db, "UPDATE repository_metadata_fences SET state='released',updated_at=? WHERE repo_id=? AND operation_id=? AND routing_epoch=? AND fence_id=? AND state='held'",
      at, receipt.repo_id, receipt.operation_id, receipt.routing_epoch, receipt.fence_id),
    stmt(db, 'UPDATE repository_metadata_fence_receipts SET released_at=? WHERE operation_id=? AND fence_id=? AND released_at IS NULL', at, operation.id, receipt.fence_id),
    eventStatement(db, { id: `evt_snapshot_abandoned_${await sha256(operation.id)}`, type: 'operation.snapshot_abandoned', resource_id: operation.id,
      resource_revision: current.revision + (current.phase === 'snapshot_abandoning' ? 1 : 2), repo_id: operation.repo_id,
      account_id: operation.account_id, actor_id: operation.actor_id, data: { archive_id: archiveId } }),
  ]);
  // Repeated even after the local tombstone committed, including a lost D1 response.
  await releaseDirectory(env, receipt);
  return true;
}
