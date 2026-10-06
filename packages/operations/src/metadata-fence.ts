import { ApiError, database, inRepositoryMetadataFence, newId, now, one, repositoryMetadataFenceGuard, selectedRepositoryScope, stmt } from '@gitknot/core';
import type { AppContext, Bindings, Database, RepositoryMetadataFence } from '@gitknot/core';

export type MetadataFenceReceipt = RepositoryMetadataFence;

export function metadataFenceGuard(db: Database, repoId: string, receipt: MetadataFenceReceipt | null): D1PreparedStatement[] {
  const id = newId('guard');
  return [repositoryMetadataFenceGuard(db, repoId, id, receipt ?? undefined), stmt(db, 'DELETE FROM mutation_guards WHERE id=?', id)];
}

export function operationFence(db: Database, operationId: string): Promise<MetadataFenceReceipt | null> {
  return one(db, 'SELECT repo_id,operation_id,routing_epoch,fence_id FROM repository_metadata_fence_receipts WHERE operation_id=?', operationId);
}

export async function operationFenceGuard(db: Database, repoId: string | null, operationId?: string): Promise<D1PreparedStatement[]> {
  if (!repoId) return [];
  return metadataFenceGuard(db, repoId, operationId ? await operationFence(db, operationId) : null);
}

export async function acquireMetadataFence(env: Bindings, repoId: string, operationId: string, epoch: number): Promise<MetadataFenceReceipt> {
  const db = env.DB.withSession('first-primary');
  const previous = await one<MetadataFenceReceipt & { released_at: string | null }>(db, 'SELECT * FROM repository_metadata_fence_receipts WHERE operation_id=?', operationId);
  if (previous?.released_at) throw new ApiError(409, 'metadata_fence_released', 'This metadata fence acquisition was already released.');
  if (previous && (previous.repo_id !== repoId || previous.routing_epoch !== epoch)) throw new Error('metadata_fence_scope_changed');
  const receipt = previous ?? { repo_id: repoId, operation_id: operationId, routing_epoch: epoch, fence_id: newId('mfence') };
  await db.batch([
    stmt(db, `INSERT INTO repository_metadata_fence_receipts(operation_id,repo_id,routing_epoch,fence_id,acquired_at)
      VALUES(?,?,?,?,?) ON CONFLICT(operation_id) DO NOTHING`, operationId, repoId, epoch, receipt.fence_id, now()),
    stmt(db, `INSERT INTO repository_metadata_fences(repo_id,operation_id,routing_epoch,fence_id,state,updated_at)
      SELECT repo_id,operation_id,routing_epoch,fence_id,'held',? FROM repository_metadata_fence_receipts WHERE operation_id=? AND released_at IS NULL
      ON CONFLICT(repo_id) DO UPDATE SET operation_id=excluded.operation_id,routing_epoch=excluded.routing_epoch,fence_id=excluded.fence_id,state='held',updated_at=excluded.updated_at
      WHERE repository_metadata_fences.state='released' OR (repository_metadata_fences.operation_id=excluded.operation_id AND repository_metadata_fences.fence_id=excluded.fence_id)`, now(), operationId),
  ]);
  const actual = await operationFence(db, operationId);
  if (!actual) throw new Error('metadata_fence_receipt_missing');
  await db.batch(metadataFenceGuard(db, repoId, actual));
  return actual;
}

export async function releaseMetadataFence(env: Bindings, receipt: MetadataFenceReceipt, checkpoint?: string): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const released = await one(db, 'SELECT 1 FROM repository_metadata_fence_receipts WHERE operation_id=? AND fence_id=? AND released_at IS NOT NULL', receipt.operation_id, receipt.fence_id);
  if (released) return;
  await db.batch([
    ...metadataFenceGuard(db, receipt.repo_id, receipt),
    ...(checkpoint ? [stmt(db, `UPDATE operation_steps SET state='completed',receipt_json='{"released":true}',completed_at=?,error_code=NULL
      WHERE operation_id=? AND name=? AND state='running'`, now(), receipt.operation_id, checkpoint)] : []),
    stmt(db, `UPDATE repository_metadata_fences SET state='released',updated_at=? WHERE repo_id=? AND operation_id=? AND routing_epoch=? AND fence_id=? AND state='held'`,
      now(), receipt.repo_id, receipt.operation_id, receipt.routing_epoch, receipt.fence_id),
    stmt(db, 'UPDATE repository_metadata_fence_receipts SET released_at=? WHERE operation_id=? AND fence_id=? AND released_at IS NULL', now(), receipt.operation_id, receipt.fence_id),
  ]);
}

export async function ownerBatch(env: Bindings, repoId: string, operationId: string, statements: D1PreparedStatement[]): Promise<void> {
  const db = env.DB.withSession('first-primary');
  await db.batch([...await operationFenceGuard(db, repoId, operationId), ...statements]);
}

export async function ownerExecute(env: Bindings, repoId: string, operationId: string, sql: string, ...values: unknown[]): Promise<D1Result> {
  const db = env.DB.withSession('first-primary');
  const results = await db.batch([...await operationFenceGuard(db, repoId, operationId), stmt(db, sql, ...values)]);
  return results.at(-1)!;
}

export async function withOperationMetadataFence<T>(c: AppContext, operationId: string, action: () => Promise<T>): Promise<T> {
  const receipt = await operationFence(database(c), operationId);
  return receipt && selectedRepositoryScope(c) === receipt.repo_id ? inRepositoryMetadataFence(c, receipt, action) : action();
}

export async function withOperationMetadataFences<T>(contexts: AppContext[], operationId: string, action: () => Promise<T>): Promise<T> {
  const enter = (index: number): Promise<T> => contexts[index] ? withOperationMetadataFence(contexts[index]!, operationId, () => enter(index + 1)) : action();
  return enter(0);
}
