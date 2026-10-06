import { ApiError, authorize, database, many, now, one, requirePrincipal, stmt } from '@gitknot/core';
import type { Repository } from '@gitknot/core';
import { completeInbox, getItem } from './common.ts';
import type { Item } from './common.ts';
import { getMergeEligibility } from './merge.ts';
import type { Candidate, MergeQueueEntry } from './merge.ts';
import { pullDetails, readPatchFiles } from './patches.ts';
import type { NativeOperation } from './native.ts';
import { inspectPatch, nativeJSON, nativeOperationSchema } from './native.ts';
import { checked, committedPublication, domainStatements, nativeMutation, nativeWaiting, requiredString } from './operation-runtime.ts';
import type { OperationState, OperationStep } from './operation-runtime.ts';

async function queueEntry(state: OperationState): Promise<MergeQueueEntry> {
  const queueId = requiredString(state.input, 'queue_id');
  const queue = await one<MergeQueueEntry>(database(state.c), 'SELECT * FROM pull_merge_queue WHERE id=? AND repo_id=? AND operation_id=?', queueId, state.operation.repo_id, state.operation.id);
  if (!queue) throw new ApiError(404, 'merge_queue_missing', 'The merge queue entry is unavailable.');
  return queue;
}

function queueUpdate(state: OperationState, queue: MergeQueueEntry, fields: Record<string, string | number | null>): D1PreparedStatement[] {
  const keys = Object.keys(fields);
  return checked(state.c, stmt(database(state.c), `UPDATE pull_merge_queue SET ${keys.map(key => `${key}=?`).join(',')},revision=revision+1,updated_at=? WHERE repo_id=? AND id=? AND revision=?`,
    ...keys.map(key => fields[key]), now(), queue.repo_id, queue.id, queue.revision));
}

/** Metadata reconciliation remains available after the initiating credential is revoked. It cannot publish refs. */
export async function reconcileMergedPublication(state: OperationState): Promise<OperationStep | null> {
  if (state.operation.kind !== 'collaboration.merge') return null;
  const queue = await queueEntry(state);
  if (queue.state === 'merged') return { status: 'completed', phase: 'merged', result: { queue_id: queue.id, pull_id: queue.pull_id, merge_oid: queue.candidate_oid } };
  const nativeId = `${state.operation.id}_publish`;
  const existing = await one<{ state: string }>(database(state.c), 'SELECT state FROM git_publications WHERE repo_id=? AND id=? AND actor_id=?', queue.repo_id, nativeId, state.operation.actor_id);
  if (!existing) return null;
  const native = await nativeJSON(state.c, queue.repo_id, `operations/${nativeId}`, nativeOperationSchema);
  return committedPublication(native, nativeId) ? finalizeMerge(state, queue, native) : null;
}

export async function stepMerge(state: OperationState): Promise<OperationStep> {
  const { c, operation } = state;
  const queue = await queueEntry(state);
  if (['cancelled', 'superseded'].includes(queue.state)) return { status: 'cancelled', phase: queue.state, result: { queue_id: queue.id } };
  const { item, repo } = await getItem(c, 'pull_request', queue.pull_id, 'contents.read', queue.repo_id);
  const pull = await pullDetails(c, item);
  await authorize(c, 'pull_requests.merge', { repo_id: repo.id, ref: queue.target_ref,
    paths: (await readPatchFiles(c, item, pull.current_patch_id)).map(file => file.path) });
  if (queue.patch_id !== pull.current_patch_id || queue.head_oid !== pull.head_oid || queue.target_ref !== pull.base_ref) {
    return { status: 'cancelled', phase: 'superseded', result: { queue_id: queue.id, reason: 'patch_changed' },
      effects: queueUpdate(state, queue, { state: 'superseded', reason_json: JSON.stringify(['patch_changed']) }) };
  }
  const earlier = await one(database(c), `SELECT 1 FROM pull_merge_queue WHERE repo_id=? AND target_ref=?
    AND state IN ('queued','preparing','verifying','ready','publishing','blocked') AND (created_at<? OR (created_at=? AND id<?)) LIMIT 1`,
  repo.id, queue.target_ref, queue.created_at, queue.created_at, queue.id);
  if (earlier && queue.state !== 'publishing') return nativeWaiting(state, 'waiting_queue_position');
  if (queue.state === 'publishing') return publishCandidate(state, queue);
  const candidate = queue.candidate_id ? await one<Candidate>(database(c), 'SELECT * FROM git_candidates WHERE repo_id=? AND id=?', repo.id, queue.candidate_id) : null;
  const eligibility = await getMergeEligibility(c, item.id, { repo_id: repo.id, strategy: queue.strategy,
    ...(candidate?.state === 'ready' && ['verifying', 'ready', 'blocked'].includes(queue.state) ? { candidate_id: candidate.id } : {}) });
  if (!eligibility.queueable) {
    return { status: 'waiting', phase: 'waiting_prerequisites', progress: 10,
      effects: queueUpdate(state, queue, { state: 'blocked', reason_json: JSON.stringify(eligibility.blockers.filter(reason => reason.code !== 'candidate_missing')) }) };
  }
  const stale = queue.policy_revision !== repo.policy_revision || queue.base_oid !== eligibility.target_oid
    || (candidate && ['obsolete', 'failed'].includes(candidate.state));
  if (!queue.candidate_id || stale) {
    const generation = Number(state.checkpoint.candidate_generation ?? 0) + 1;
    const candidateId = `candidate_${operation.id}_${generation}`;
    return { status: 'waiting', phase: 'candidate_planned', progress: 15,
      checkpoint: { candidate_generation: generation, candidate_operation_id: `${operation.id}_candidate_${generation}`, candidate_id: candidateId },
      effects: [
        ...queueUpdate(state, queue, { state: 'preparing', candidate_id: candidateId, candidate_oid: null,
          policy_revision: repo.policy_revision, base_oid: eligibility.target_oid, reason_json: '[]' }),
        ...(candidate ? [stmt(database(c), "UPDATE git_candidates SET state='obsolete',revision=revision+1,updated_at=? WHERE repo_id=? AND id=? AND state='ready'", now(), repo.id, candidate.id)] : []),
      ] };
  }
  if (queue.state === 'preparing' || candidate?.state === 'building' || !candidate) {
    const nativeId = requiredString(state.checkpoint, 'candidate_operation_id');
    const native = await nativeMutation(state, repo.id, nativeId, { kind: 'candidate',
      candidate: { id: queue.candidate_id, source_repo_id: pull.head_repo_id, source_oid: queue.head_oid,
        target_ref: queue.target_ref, target_oid: queue.base_oid, strategy: queue.strategy, pull_request_id: item.id },
      author: { name: 'GitKnot', email: 'git@gitknot.com' }, message: `Merge pull request #${item.number}: ${item.title}` });
    if (native.state === 'rejected') return { status: 'failed', phase: 'candidate_rejected',
      error: { code: native.error?.code ?? 'candidate_rejected', message: 'Native Git rejected the candidate. Resolve conflicts or policy requirements before retrying.', retryable: false },
      effects: queueUpdate(state, queue, { state: 'blocked', reason_json: JSON.stringify(['candidate_rejected', native.error?.code ?? null]) }) };
    if (!committedPublication(native, nativeId)) return nativeWaiting(state, 'building_candidate');
    const retained = await one<Candidate>(database(c), 'SELECT * FROM git_candidates WHERE repo_id=? AND id=?', repo.id, queue.candidate_id);
    if (!retained?.candidate_oid || retained.state !== 'ready' || retained.source_oid !== queue.head_oid || retained.target_oid !== queue.base_oid) {
      throw new ApiError(503, 'candidate_unconfirmed', 'The retained candidate has not been verified.');
    }
    const candidatePatch = await inspectPatch(c, repo.id, repo.id, retained.target_oid, retained.candidate_oid, false, retained.id);
    if (candidatePatch.merge_base_oid !== retained.target_oid) throw new ApiError(503, 'candidate_graph_mismatch', 'The native candidate is not based on its target.');
    const changedPaths = [...new Set(candidatePatch.files.flatMap(file => file.old_path ? [file.path, file.old_path] : [file.path]))].sort();
    return { status: 'waiting', phase: 'waiting_verification', progress: 45,
      effects: [...queueUpdate(state, queue, { state: 'verifying', candidate_oid: retained.candidate_oid, reason_json: '[]' }),
        ...domainStatements(c, repo, item, 'merge_candidate.created', retained.revision,
          { candidate_id: retained.id, commit_sha: retained.candidate_oid, commit: retained.candidate_oid,
            policy_revision: repo.policy_revision, pull_request_id: item.id, head_oid: pull.head_oid,
            target_oid: queue.base_oid, target_ref: queue.target_ref, queue_id: queue.id, changed_paths: changedPaths }, retained.id)] };
  }
  if (!eligibility.eligible) return { status: 'waiting', phase: 'waiting_verification', progress: 60,
    effects: queueUpdate(state, queue, { state: 'verifying', reason_json: JSON.stringify(eligibility.blockers) }) };
  return { status: 'waiting', phase: 'publication_planned', progress: 80,
    effects: queueUpdate(state, queue, { state: 'publishing', reason_json: '[]' }) };
}

async function publishCandidate(state: OperationState, queue: MergeQueueEntry): Promise<OperationStep> {
  const { c, operation } = state;
  if (!queue.candidate_id || !queue.candidate_oid) throw new ApiError(503, 'candidate_missing', 'The publication candidate is missing.');
  const { item } = await getItem(c, 'pull_request', queue.pull_id, 'contents.read', queue.repo_id);
  const pull = await pullDetails(c, item);
  const nativeId = `${operation.id}_publish`;
  const native = await nativeMutation(state, queue.repo_id, nativeId, { kind: 'merge', candidate_oid: queue.candidate_oid,
    candidate: { id: queue.candidate_id, source_repo_id: pull.head_repo_id, source_oid: queue.head_oid,
      target_ref: queue.target_ref, target_oid: queue.base_oid, strategy: queue.strategy, pull_request_id: queue.pull_id } });
  if (committedPublication(native, nativeId)) return finalizeMerge(state, queue, native);
  if (native.state === 'rejected') return { status: 'failed', phase: 'publication_rejected',
    error: { code: native.error?.code ?? 'publication_rejected', message: 'The canonical publication was rejected. Rebuild the candidate against current policy and refs.', retryable: false },
    effects: queueUpdate(state, queue, { state: 'blocked', reason_json: JSON.stringify(['publication_rejected', native.error?.code ?? null]) }) };
  return nativeWaiting(state, 'reconciling_publication');
}

async function finalizeMerge(state: OperationState, queue: MergeQueueEntry, publication: NativeOperation): Promise<OperationStep> {
  const { c } = state;
  const result = publication.result;
  const ref = result?.refs.find(value => value.ref === queue.target_ref);
  if (!ref || ref.old_oid !== queue.base_oid || ref.new_oid !== queue.candidate_oid || result?.refs.length !== 1) {
    throw new ApiError(503, 'publication_result_mismatch', 'Canonical publication evidence does not match the queued candidate.');
  }
  const repo = await one<Repository>(database(c), 'SELECT * FROM repositories WHERE id=?', queue.repo_id);
  const item = await one<Item>(database(c), "SELECT * FROM collaboration_items WHERE repo_id=? AND id=? AND kind='pull_request'", queue.repo_id, queue.pull_id);
  if (!repo || !item) throw new ApiError(503, 'publication_metadata_missing', 'Publication succeeded but its metadata needs reconciliation.');
  const pull = await pullDetails(c, item);
  const stillCurrent = pull.current_patch_id === queue.patch_id && pull.head_oid === queue.head_oid;
  const at = now();
  const effects: D1PreparedStatement[] = [
    ...queueUpdate(state, queue, { state: 'merged', reason_json: '[]' }),
    ...checked(c, stmt(database(c), `UPDATE collaboration_items SET state=?,revision=revision+1,updated_at=? WHERE repo_id=? AND id=? AND revision=?`,
      stillCurrent ? 'merged' : item.state, at, repo.id, item.id, item.revision)),
    stmt(database(c), 'UPDATE pull_requests SET merged_at=?,merged_by=?,merge_oid=?,merged_patch_id=? WHERE repo_id=? AND id=?', at, requirePrincipal(c).id, ref.new_oid, queue.patch_id, repo.id, item.id),
    ...domainStatements(c, repo, item, 'pull_request.merged', item.revision + 1, { patch_id: queue.patch_id, merge_oid: ref.new_oid,
      target_ref: queue.target_ref, operation_id: state.operation.id, current_patch_changed: !stillCurrent }),
  ];
  if (stillCurrent) effects.push(completeInbox(database(c), item, 'review_request'));
  if (queue.target_ref === `refs/heads/${repo.default_branch}`) {
    const issues = await many<Item>(database(c), `SELECT i.* FROM collaboration_items i JOIN issue_pull_links l ON l.repo_id=i.repo_id AND l.issue_id=i.id
      WHERE l.repo_id=? AND l.pull_id=? AND l.closes_issue=1 AND i.state='open' AND i.deleted_at IS NULL`, repo.id, item.id);
    for (const issue of issues) effects.push(
      ...checked(c, stmt(database(c), "UPDATE collaboration_items SET state='closed',revision=revision+1,updated_at=? WHERE repo_id=? AND id=? AND revision=?", at, repo.id, issue.id, issue.revision)),
      stmt(database(c), 'UPDATE issues SET status_id=NULL WHERE repo_id=? AND id=?', repo.id, issue.id),
      completeInbox(database(c), issue, 'assignment'),
      ...domainStatements(c, repo, issue, 'issue.closed_by_merge', issue.revision + 1, { pull_id: item.id, merge_oid: ref.new_oid }),
    );
  }
  return { status: 'completed', phase: 'merged', result: { queue_id: queue.id, pull_id: item.id, merged_patch_id: queue.patch_id,
    merge_oid: ref.new_oid, canonical_publication_verified: true, current_patch_changed: !stillCurrent }, effects };
}
