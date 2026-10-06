import { commitStorageObject, deleteStorageObject } from '@gitknot/billing';
import { ApiError, execute, many, now, one, sha256 } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import { advanceRun, cancelRun, dispatchFairly, ensureRunWorkflow } from './control-plane.ts';
import { promoteArtifact, recoverPromotionBarriers } from './environments.ts';
import { primary } from './store.ts';
import { attemptRequest } from './transport.ts';
import type { AttemptRecord, ExecutionObject, RunRecord } from './types.ts';
import { sweepWorkflowOperations } from './operations.ts';
import { reconcileRunnerAuthorityChanges } from './runner-authority.ts';
import { expireWorkflowPreviews } from './previews.ts';

export async function expireExecutionObjects(env: Bindings): Promise<number> {
  const db = primary(env), at = now(), staleUpload = new Date(Date.now() - 60 * 60_000).toISOString();
  const objects = await many<ExecutionObject>(db, `SELECT o.* FROM execution_objects o JOIN execution_attempts a ON a.id=o.attempt_id AND a.repo_id=o.repo_id
    WHERE o.state!='deleted' AND (o.expires_at<=? OR (o.state='uploading' AND o.created_at<? AND a.status NOT IN ('leased','running')))
    ORDER BY o.expires_at,o.id LIMIT 64`, at, staleUpload);
  let count = 0;
  for (const object of objects) {
    if (object.state === 'uploading') {
      const head = await env.BLOBS.head(object.object_key);
      if (!head || head.size !== object.size_bytes || head.customMetadata?.sha256 !== object.sha256) {
        // Absence is not proof that an uncertain old upload can no longer finish.
        // Preserve its quota hold; never fabricate an empty upload receipt.
        throw new ApiError(503, 'upload_reconciliation_required', 'An interrupted upload has no verifiable completion receipt.');
      }
      const attempt = await one<AttemptRecord>(db, 'SELECT * FROM execution_attempts WHERE id=? AND repo_id=?', object.attempt_id, object.repo_id);
      if (!attempt?.reservation_id || !attempt.reservation_fence) throw new ApiError(503, 'storage_reservation_missing', 'The interrupted upload reservation is unavailable.');
      await commitStorageObject(env, { account_id: object.account_id, reservation_id: attempt.reservation_id, fence: attempt.reservation_fence,
        object_id: object.id, bytes: String(head.size), etag: head.etag, checksum: object.sha256 });
    }
    await execute(db, `UPDATE execution_objects SET state='deleting' WHERE id=? AND repo_id=? AND state!='deleted'`, object.id, object.repo_id);
    await deleteStorageObject(env, { account_id: object.account_id, object_id: object.id });
    if (await env.BLOBS.head(object.object_key)) throw new ApiError(503, 'object_deletion_unverified', 'An expired execution object is still present.');
    await execute(db, `UPDATE execution_objects SET state='deleted',deleted_at=? WHERE id=? AND repo_id=? AND state='deleting'`, now(), object.id, object.repo_id);
    count++;
  }
  const bucket = env.BACKUP_BUCKET as R2Bucket | undefined;
  const snapshots = await many<{ id: string; account_id: string; repo_id: string; archive_key: string; metadata_key: string }>(db,
    `SELECT * FROM execution_snapshots WHERE state!='deleted' AND expires_at<=? ORDER BY expires_at,id LIMIT 32`, at);
  if (snapshots.length && !bucket) throw new ApiError(503, 'snapshot_storage_unavailable', 'The execution snapshot bucket is unavailable for cleanup.');
  for (const snapshot of snapshots) {
    await execute(db, `UPDATE execution_snapshots SET state='deleting' WHERE id=? AND repo_id=?`, snapshot.id, snapshot.repo_id);
    for (const key of [snapshot.archive_key, snapshot.metadata_key]) {
      await deleteStorageObject(env, { account_id: snapshot.account_id, object_id: `sdk_${(await sha256(key)).slice(0, 48)}` });
      if (await bucket!.head(key)) throw new ApiError(503, 'snapshot_deletion_unverified', 'An expired SDK snapshot object is still present.');
    }
    await execute(db, 'DELETE FROM execution_caches WHERE repo_id=? AND json_extract(snapshot_json,\'$.id\')=?', snapshot.repo_id, snapshot.id);
    await execute(db, `UPDATE execution_snapshots SET state='deleted',deleted_at=? WHERE id=? AND repo_id=?`, now(), snapshot.id, snapshot.repo_id);
    count++;
  }
  const orphaned = await many<{ id: string; account_id: string; object_key: string }>(db, `SELECT b.id,b.account_id,b.object_key FROM billing_storage_objects b
    JOIN execution_attempts a ON a.id=json_extract(b.body_json,'$.attribution.attempt_id') AND a.repo_id=b.repo_id
    WHERE b.id LIKE 'sdk_%' AND b.state='stored' AND a.cleanup_state='verified' AND json_extract(b.body_json,'$.created_at')<?
      AND NOT EXISTS (SELECT 1 FROM execution_snapshots s WHERE s.archive_key=b.object_key OR s.metadata_key=b.object_key)
    ORDER BY b.id LIMIT 32`, staleUpload);
  for (const object of orphaned) {
    if (!bucket) throw new ApiError(503, 'snapshot_storage_unavailable', 'The execution snapshot bucket is unavailable for orphan cleanup.');
    await deleteStorageObject(env, { account_id: object.account_id, object_id: object.id });
    if (await bucket.head(object.object_key)) throw new ApiError(503, 'snapshot_deletion_unverified', 'An orphaned SDK snapshot is still present.');
    count++;
  }
  return count;
}

/** SDK callbacks are not the sole source of cleanup or metering progress. */
export async function sweepExecution(env: Bindings): Promise<{ dispatched: number; recovered: number; deleted: number; errors: number }> {
  const db = primary(env);
  let recovered = 0, errors = 0;
  const recover = async (run: () => Promise<unknown>) => { try { await run(); recovered++; } catch { errors++; } };
  const attempts = await many<AttemptRecord>(db, `SELECT * FROM execution_attempts WHERE (status IN ('accepted','admitting','leased','running','cancelling'))
    OR (cleanup_state IN ('required','destroying')) OR (status IN ('succeeded','failed','cancelled','timed_out','infrastructure_failed') AND reservation_id IS NOT NULL AND settled_at IS NULL)
    ORDER BY COALESCE(deadline_at,queue_deadline_at),id LIMIT 64`);
  for (const attempt of attempts) await recover(() => attemptRequest(env, attempt.id, 'reconcile', {}));
  const runs = await many<RunRecord>(db, `SELECT * FROM workflow_runs WHERE status IN ('queued','running','waiting','waiting_approval','cancelling') ORDER BY updated_at,id LIMIT 32`);
  for (const run of runs) await recover(async () => { await ensureRunWorkflow(env, run.id); await advanceRun(env, run.id); });
  const promotions = await many<{ id: string }>(db, `SELECT id FROM workflow_promotions WHERE status='approved' ORDER BY created_at,id LIMIT 16`);
  for (const promotion of promotions) await recover(() => promoteArtifact(env, promotion.id));
  await recover(() => recoverPromotionBarriers(env));
  await recover(() => sweepWorkflowOperations(env));
  await recover(() => reconcileRunnerAuthorityChanges(env));
  await recover(() => expireWorkflowPreviews(env));
  const dispatched = await dispatchFairly(env);
  let deleted = 0;
  try { deleted = await expireExecutionObjects(env); } catch { errors++; }
  if (errors) console.error(JSON.stringify({ event: 'execution.recovery.pending', recovered, errors }));
  return { dispatched, recovered, deleted, errors };
}

/** Movement/purge calls this before copying mutable execution state or removing its source. */
export async function quiesceRepositoryExecution(env: Bindings, repoId: string): Promise<{ ready: boolean; pending: number; customer_unreachable: number }> {
  const db = primary(env);
  const runs = await many<RunRecord>(db, `SELECT * FROM workflow_runs WHERE repo_id=? AND status IN ('queued','running','waiting','waiting_approval','cancelling') ORDER BY created_at,id LIMIT 32`, repoId);
  for (const run of runs) {
    try { await cancelRun(env, db, run, run.requested_by, 'Repository execution is quiescing for a placement or lifecycle change.'); }
    catch { /* The durable cancellation fence is retained and the next pass retries cleanup. */ }
  }
  const attempts = await many<AttemptRecord>(db, `SELECT * FROM execution_attempts WHERE repo_id=? AND (status IN ('queued','accepted','admitting','leased','running','cancelling') OR cleanup_state IN ('required','destroying')) ORDER BY created_at,id LIMIT 64`, repoId);
  for (const attempt of attempts) {
    try { await attemptRequest(env, attempt.id, 'cancel', { reason: 'Repository execution is quiescing.' }); }
    catch { /* No unverified teardown is treated as completion. */ }
  }
  const pending = await one<{ count: number }>(db, `SELECT COUNT(*) AS count FROM execution_attempts WHERE repo_id=? AND
    (status IN ('queued','accepted','admitting','leased','running','cancelling') OR (executor='hosted' AND cleanup_state NOT IN ('none','verified')))`, repoId);
  const queued = await one<{ count: number }>(db, `SELECT COUNT(*) AS count FROM workflow_jobs WHERE repo_id=? AND status IN ('waiting','ready','queued','admitting','running','waiting_approval','cancelling')`, repoId);
  const unreachable = await one<{ count: number }>(db, `SELECT COUNT(*) AS count FROM execution_attempts WHERE repo_id=? AND executor='self_hosted' AND cleanup_state='unreachable'`, repoId);
  const count = (pending?.count ?? 0) + (queued?.count ?? 0);
  return { ready: count === 0, pending: count, customer_unreachable: unreachable?.count ?? 0 };
}
