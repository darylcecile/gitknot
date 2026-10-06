import { ApiError, now, one, sha256 } from '@gitknot/core';
import type { Repository } from '@gitknot/core';
import { cellShards } from './placement.ts';
import type { Operation, OperationsBindings } from './types.ts';
import { localRepository } from './ownership.ts';

const retentionActor = 'system:collaboration-retention';

/** An automatic cleanup flag is effective only when the committed parent/child/workspace chain proves it. */
export async function validateWorkspaceRetention(env: OperationsBindings, operation: Operation, kind: string): Promise<boolean> {
  const input = JSON.parse(operation.input_json) as Record<string, unknown>;
  if (input.maintenance_kind !== 'task_workspace_retention') return false;
  if (input.maintenance !== true || !['archive', 'delete'].includes(kind) || operation.actor_id !== retentionActor
    || typeof input.workspace_id !== 'string' || typeof input.parent_operation_id !== 'string') {
    throw new ApiError(403, 'invalid_retention_operation', 'This operation does not have a valid workspace retention authority.');
  }
  const target = await one<Repository>(env.DB, 'SELECT * FROM repositories WHERE id=?', operation.repo_id);
  if (!target || target.visibility !== 'private') throw new ApiError(409, 'workspace_retention_changed', 'The workspace is no longer private.');
  for (const source of cellShards(env)) {
    const row = await one<{ id: string; repo_id: string; task_id: string; workspace_repo_id: string; operation_id: string; state: string; retention_until: string }>(source.DB,
      'SELECT * FROM task_workspaces WHERE id=? AND workspace_repo_id=?', input.workspace_id, target.id);
    if (!row) continue;
    if (!await localRepository(source, row.repo_id)) continue;
    const parent = await one<Operation>(source.DB, 'SELECT * FROM operations WHERE id=?', input.parent_operation_id);
    const context = await one<{ repo_id: string; item_id: string; input_digest: string; checkpoint_json: string }>(source.DB,
      'SELECT repo_id,item_id,input_digest,checkpoint_json FROM collaboration_operation_contexts WHERE operation_id=?', input.parent_operation_id);
    if (!parent || !context || parent.kind !== 'collaboration.workspace_retire' || parent.actor_id !== retentionActor || parent.status === 'cancelled'
      || row.operation_id !== parent.id || parent.resource_id !== row.id || parent.repo_id !== row.repo_id
      || context.repo_id !== row.repo_id || context.item_id !== row.task_id || context.input_digest !== await sha256(parent.input_json)) {
      throw new ApiError(403, 'invalid_retention_operation', 'The workspace retention parent could not be verified.');
    }
    const planned = JSON.parse(parent.input_json) as Record<string, unknown>;
    const checkpoint = JSON.parse(context.checkpoint_json) as Record<string, unknown>;
    if (planned.automatic !== true || planned.workspace_id !== row.id || planned.workspace_repo_id !== target.id
      || checkpoint.retirement_operation_id !== operation.id || checkpoint.retirement_kind !== kind
      || row.state !== 'expiring' || row.retention_until > now() || target.fork_source_id !== row.repo_id) {
      throw new ApiError(409, 'workspace_retention_changed', 'This private workspace is no longer eligible for its recorded retirement.');
    }
    const references = await one<{ count: number }>(source.DB, 'SELECT COUNT(*) AS count FROM pull_patches WHERE head_repo_id=?', target.id);
    if (kind === 'delete' && (references?.count ?? 0) !== 0) throw new ApiError(409, 'workspace_review_retention_required', 'New review references require archival rather than deletion.');
    return true;
  }
  throw new ApiError(503, 'workspace_retention_context_unavailable', 'The authoritative workspace retention context is unavailable.');
}
