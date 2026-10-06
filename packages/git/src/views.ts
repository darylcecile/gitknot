import type { GitOperation, PublicGitOperation } from './types.ts';

export function publicGitOperation(operation: GitOperation): PublicGitOperation {
  return { id: operation.id, operation_id: operation.id, repo_id: operation.repo_id, actor_id: operation.actor.id,
    kind: operation.kind, state: operation.state, policy_revision: operation.policy_revision, routing_epoch: operation.routing_epoch,
    result: operation.result ?? null, error: operation.error ?? null, finalized: operation.finalized,
    created_at: operation.created_at, updated_at: operation.updated_at };
}
