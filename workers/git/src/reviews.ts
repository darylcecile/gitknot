import { authorize, getRepository, now, one, stmt } from '@gitknot/core';
import type { AppContext, Repository } from '@gitknot/core';
import { reviewEvidenceId, reviewRefs } from '../../../packages/git/src/protocol.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';
import { validateOid } from '../../../packages/git/src/policy.ts';
import type { GitMutationRequest, PublicGitOperation } from '../../../packages/git/src/types.ts';
import type { GitBindings } from './types.ts';

interface ReviewSnapshot {
  repo_id: string; id: string; source_repo_id: string; base_oid: string; head_oid: string; merge_base_oid: string | null;
  operation_id: string; actor_id: string; state: 'building' | 'ready' | 'failed'; inspection_json: string | null;
}

interface PatchRecord { id: string; repo_id: string; pull_id: string; head_repo_id: string; base_oid: string; head_oid: string; merge_base_oid: string; native_evidence_id: string }

export async function retainReviewInspection(c: AppContext, env: GitBindings, repository: Repository,
  input: { head_repo_id: string; base_oid: string; head_oid: string },
  submit: (request: GitMutationRequest) => Promise<Response>,
  reconcile: () => Promise<unknown>): Promise<Response> {
  const actor = c.get('principal');
  requireValue(actor, 'authentication_required', 'Retaining a proposed patch requires an authenticated actor.', 401);
  await authorize(c, 'pull_requests.write', { repo_id: repository.id });
  await getRepository(c, input.head_repo_id);
  validateOid(input.base_oid, false); validateOid(input.head_oid, false);
  const id = await reviewEvidenceId(repository.id, input.head_repo_id, input.base_oid, input.head_oid);
  let saved = await snapshot(env, repository.id, id);
  if (saved?.state === 'ready') return inspectionResponse(saved);
  if (saved?.state === 'building') {
    await reconcile();
    saved = await snapshot(env, repository.id, id);
    if (saved?.state === 'ready') return inspectionResponse(saved);
  }
  if (!saved) {
    const operationId = `retain_${crypto.randomUUID().replaceAll('-', '')}`;
    await stmt(env.DB, `INSERT OR IGNORE INTO git_review_snapshots(repo_id,id,source_repo_id,base_oid,head_oid,operation_id,actor_id,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'building',?,?)`, repository.id, id, input.head_repo_id, input.base_oid, input.head_oid, operationId, actor.id, now(), now()).run();
    saved = await snapshot(env, repository.id, id);
  }
  requireValue(saved, 'review_snapshot_unavailable', 'Review retention metadata is unavailable.', 503);
  if (saved.state === 'failed') {
    const previous = await one<{ state: string; finalized: number }>(env.DB, 'SELECT state,finalized FROM git_publications WHERE repo_id=? AND id=?', repository.id, saved.operation_id);
    requireValue(previous?.state === 'rejected' && previous.finalized === 1, 'review_retention_pending', 'A previous review publisher still requires reconciliation.', 409);
    const replacement = `retain_${crypto.randomUUID().replaceAll('-', '')}`;
    await stmt(env.DB, "UPDATE git_review_snapshots SET operation_id=?,actor_id=?,state='building',updated_at=? WHERE repo_id=? AND id=? AND state='failed' AND operation_id=?",
      replacement, actor.id, now(), repository.id, id, saved.operation_id).run();
    saved = (await snapshot(env, repository.id, id))!;
  }
  const response = await submit({ operation_id: saved.operation_id, actor,
    mutation: { kind: 'retain', review: { id, source_repo_id: input.head_repo_id, base_oid: input.base_oid, head_oid: input.head_oid } } });
  if (!response.ok) return response;
  const operation = await response.json() as PublicGitOperation;
  requireValue(operation.state === 'committed' && operation.finalized, 'review_retention_pending', 'The proposed review commits are being durably retained. Retry this request.', 503);
  return inspectionResponse((await snapshot(env, repository.id, id))!);
}

export async function historicalReviewRefs(c: AppContext, repository: Repository, input: {
  pull_id?: string; from_patch_id?: string | null; to_patch_id?: string; base_oid: string; head_oid: string; head_repo_id: string;
}): Promise<string[]> {
  requireValue(input.pull_id && input.to_patch_id, 'review_association_required', 'Historical Git diffs require their recorded pull request and patch identities.', 400);
  const pull = await one(c.env.DB, "SELECT 1 FROM collaboration_items WHERE repo_id=? AND id=? AND kind='pull_request' AND deleted_at IS NULL", repository.id, input.pull_id);
  requireValue(pull, 'not_found', 'Pull request not found.', 404);
  const to = await one<PatchRecord>(c.env.DB, 'SELECT * FROM pull_patches WHERE repo_id=? AND pull_id=? AND id=?', repository.id, input.pull_id, input.to_patch_id);
  const from = input.from_patch_id ? await one<PatchRecord>(c.env.DB, 'SELECT * FROM pull_patches WHERE repo_id=? AND pull_id=? AND id=?', repository.id, input.pull_id, input.from_patch_id) : null;
  requireValue(to && (!input.from_patch_id || from) && to.head_repo_id === input.head_repo_id && to.head_oid === input.head_oid
    && (from?.head_oid ?? to.merge_base_oid) === input.base_oid, 'review_association_mismatch', 'Historical diff revisions do not belong to the selected patches.', 404);
  const refs = new Set<string>();
  for (const patch of from ? [from, to] : [to]) {
    await getRepository(c, patch.head_repo_id);
    const retained = await snapshot(c.env as GitBindings, repository.id, patch.native_evidence_id);
    requireValue(retained?.state === 'ready' && retained.source_repo_id === patch.head_repo_id && retained.head_oid === patch.head_oid
      && retained.base_oid === patch.base_oid && retained.merge_base_oid === patch.merge_base_oid,
    'review_history_unavailable', 'The retained review history is unavailable.', 503);
    for (const ref of reviewRefs(retained.id)) refs.add(ref);
  }
  return [...refs];
}

function snapshot(env: GitBindings, repoId: string, id: string): Promise<ReviewSnapshot | null> {
  return one<ReviewSnapshot>(env.DB, 'SELECT * FROM git_review_snapshots WHERE repo_id=? AND id=?', repoId, id);
}

function inspectionResponse(value: ReviewSnapshot): Response {
  requireValue(value.state === 'ready' && value.inspection_json, 'review_retention_pending', 'Review commit retention is incomplete.', 503);
  return new Response(value.inspection_json, { headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } });
}
