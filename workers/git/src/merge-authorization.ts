import { canonicalJson, database, many, one, sha256 } from '@gitknot/core';
import type { AppContext, Repository } from '@gitknot/core';
import type { CandidateContext, GitMergeQueueContext, GitOperationKind } from '../../../packages/git/src/types.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';

interface QueueEntry extends GitMergeQueueContext {
  repo_id: string; pull_id: string; target_ref: string; head_oid: string; base_oid: string;
  strategy: string; policy_revision: number; state: string; requested_by: string; created_at: string;
}

interface QueueOperation {
  kind: string; status: string; actor_id: string; input_json: string;
  item_id: string; principal_json: string; input_digest: string; checkpoint_json: string;
}

/** Only the durable, accepted queue intent can substitute merge authority for candidate-write authority. */
export async function queuedPublication(c: AppContext, repository: Repository, operationId: string,
  kind: GitOperationKind, candidate?: CandidateContext, expected?: GitMergeQueueContext): Promise<{ proof: GitMergeQueueContext; paths: string[] } | undefined> {
  if (!candidate || kind !== 'candidate' && kind !== 'merge') return undefined;
  const db = database(c);
  const queue = await one<QueueEntry>(db, 'SELECT * FROM pull_merge_queue WHERE repo_id=? AND candidate_id=?', repository.id, candidate.id);
  requireValue(queue || !expected, 'merge_queue_changed', 'The accepted merge queue intent is no longer current.', 409);
  if (!queue) return undefined;
  requireValue(queue.state === (kind === 'candidate' ? 'preparing' : 'publishing') && queue.requested_by === c.get('principal')?.id
    && queue.pull_id === candidate.pull_request_id && queue.head_oid === candidate.source_oid && queue.base_oid === candidate.target_oid
    && queue.target_ref === candidate.target_ref && queue.strategy === candidate.strategy && queue.policy_revision === repository.policy_revision,
  'merge_queue_changed', 'The candidate no longer matches its accepted merge queue intent.', 409);
  const proof = { id: queue.id, operation_id: queue.operation_id, patch_id: queue.patch_id };
  requireValue(!expected || canonicalJson(expected) === canonicalJson(proof), 'merge_queue_changed', 'The accepted merge queue identity changed.', 409);
  await verifyQueueOperation(c, queue, operationId, kind, candidate.id);
  const pull = await one(db, `SELECT 1 FROM pull_requests p JOIN collaboration_items i ON i.repo_id=p.repo_id AND i.id=p.id
    WHERE p.repo_id=? AND p.id=? AND p.current_patch_id=? AND p.head_repo_id=? AND p.head_oid=? AND p.base_ref=?
      AND i.state='open' AND i.deleted_at IS NULL`, repository.id, queue.pull_id, queue.patch_id, candidate.source_repo_id, candidate.source_oid, candidate.target_ref);
  requireValue(pull, 'merge_queue_changed', 'The pull request changed after this merge was accepted.', 409);
  const earlier = await one(db, `SELECT 1 FROM pull_merge_queue WHERE repo_id=? AND target_ref=?
    AND state IN ('queued','preparing','verifying','ready','publishing','blocked') AND (created_at<? OR (created_at=? AND id<?)) LIMIT 1`,
  repository.id, queue.target_ref, queue.created_at, queue.created_at, queue.id);
  requireValue(!earlier, 'merge_queue_order', 'An earlier merge queue entry must complete first.', 409);
  const files = await many<{ path: string; old_path: string | null }>(db,
    'SELECT path,old_path FROM pull_patch_files WHERE repo_id=? AND pull_id=? AND patch_id=? ORDER BY path LIMIT 10001', repository.id, queue.pull_id, queue.patch_id);
  requireValue(files.length > 0 && files.length <= 10_000, 'merge_patch_unavailable', 'The accepted merge requires its complete reviewed patch.', 409);
  return { proof, paths: [...new Set(files.flatMap(file => file.old_path ? [file.path, file.old_path] : [file.path]))].sort() };
}

async function verifyQueueOperation(c: AppContext, queue: QueueEntry, nativeId: string, kind: GitOperationKind, candidateId: string): Promise<void> {
  const operation = await one<QueueOperation>(database(c), `SELECT o.kind,o.status,o.actor_id,o.input_json,
    x.item_id,x.principal_json,x.input_digest,x.checkpoint_json FROM operations o
    JOIN collaboration_operation_contexts x ON x.operation_id=o.id AND x.repo_id=o.repo_id
    WHERE o.id=? AND o.repo_id=? AND o.resource_id=?`, queue.operation_id, queue.repo_id, queue.id);
  requireValue(operation && operation.kind === 'collaboration.merge' && ['running', 'waiting'].includes(operation.status)
    && operation.actor_id === queue.requested_by && operation.item_id === queue.pull_id
    && await sha256(operation.input_json) === operation.input_digest,
  'merge_queue_operation', 'The candidate requires its intact, active collaboration operation.', 409);
  const input = JSON.parse(operation.input_json) as Record<string, unknown>;
  const checkpoint = JSON.parse(operation.checkpoint_json) as Record<string, unknown>;
  requireValue(input.queue_id === queue.id && input.pull_id === queue.pull_id && input.patch_id === queue.patch_id && input.strategy === queue.strategy
    && canonicalJson(JSON.parse(operation.principal_json)) === canonicalJson(c.get('principal'))
    && (kind === 'candidate' ? checkpoint.candidate_operation_id === nativeId && checkpoint.candidate_id === candidateId : nativeId === `${queue.operation_id}_publish`),
  'merge_queue_operation', 'The candidate is outside the accepted operation or its original credential authority.', 409);
}
