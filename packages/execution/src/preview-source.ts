import { ApiError, authorize, database, one, readRepositoryAuthority, requirePrincipal } from '@gitknot/core';
import type { AppContext, Repository, RequestAuthorization } from '@gitknot/core';
import { z } from 'zod';
import { executionRequestEnvironment } from './store.ts';
import { resolveSourceRef } from './source.ts';
import type { PlanRunInput } from './planning.ts';

const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const ref = z.string().regex(/^refs\/(heads|tags)\/[^\s\x00-\x1f]+$/).max(1024);
const id = z.string().regex(/^[a-z][a-z0-9]*_[A-Za-z0-9_-]{1,120}$/);
const inputs = z.record(z.string().max(128), z.union([z.string().max(65536), z.number().finite(), z.boolean(), z.null()]));
const sourceFields = { commit_oid: commit, ref, inputs: inputs.default({}), pull_request_id: id.optional(), merge_candidate_id: id.optional() };
export const workflowPreviewSchema = z.object(sourceFields).strict();
export const workflowValidationSchema = z.object({ ...sourceFields, commit_oid: commit.optional(), ref: ref.optional(),
  source: z.string().min(1).max(512 * 1024).refine(value => new TextEncoder().encode(value).length <= 512 * 1024, 'Workflow source must fit 512 KiB.') }).strict();
export type PreviewSourceInput = Omit<z.infer<typeof workflowPreviewSchema>, 'commit_oid' | 'ref'> & { commit_oid?: string; ref?: string };
export interface PreviewSource {
  input: PlanRunInput;
  related_repo_ids: string[];
  source_repo_id: string;
  observation: { commit: string; ref: string; source_repo_id: string; candidate_id: string | null; head_oid: string; target_oid: string | null };
}

export async function previewAuthorization(c: AppContext): Promise<RequestAuthorization[]> {
  const repoId = c.req.param('repoId');
  const repository = repoId ? await readRepositoryAuthority(c, repoId) : null;
  if (!repository) throw new ApiError(404, 'not_found', 'The repository was not found.');
  const input = c.get('input') as PreviewSourceInput | undefined;
  return [{ capability: 'workflows.run', scope: { repo_id: repository.id, ref: input?.ref ?? `refs/heads/${repository.default_branch}` } }];
}

export async function previewRepository(c: AppContext, input: PreviewSourceInput): Promise<{ repository: Repository; ref: string }> {
  const requirements = await previewAuthorization(c);
  const selected = requirements[0]!.scope;
  await authorize(c, 'workflows.run', selected);
  const repository = await readRepositoryAuthority(c, selected.repo_id!);
  if (!repository || repository.state !== 'active') throw new ApiError(409, 'repository_unavailable', 'Workflow previews require the current active repository.');
  return { repository, ref: input.ref ?? `refs/heads/${repository.default_branch}` };
}

async function resolve(c: AppContext, repoId: string, ref: string): Promise<string> {
  await authorize(c, 'contents.read', { repo_id: repoId, ref });
  return resolveSourceRef(executionRequestEnvironment(c), repoId, ref, requirePrincipal(c));
}

/** Current native refs and immutable candidate/PR identity, with no caller-authored event trust. */
export async function inspectPreviewSource(c: AppContext, repository: Repository, requested: PreviewSourceInput, previewId: string): Promise<PreviewSource> {
  const selectedRef = requested.ref ?? `refs/heads/${repository.default_branch}`, db = database(c);
  let sourceRepo = repository.id, head: string, target: string | null = null, candidateId: string | null = null;
  let pullId = requested.pull_request_id;
  if (requested.merge_candidate_id) {
    const candidate = await one<{ id: string; source_repo_id: string; source_oid: string; target_oid: string; candidate_oid: string | null; target_ref: string; pull_request_id: string | null; policy_revision: number; state: string }>(db,
      'SELECT * FROM git_candidates WHERE repo_id=? AND id=?', repository.id, requested.merge_candidate_id);
    if (!candidate || candidate.state !== 'ready' || !candidate.candidate_oid || candidate.policy_revision !== repository.policy_revision
      || candidate.target_ref !== selectedRef || requested.commit_oid !== undefined && requested.commit_oid !== candidate.candidate_oid
      || pullId && pullId !== candidate.pull_request_id) throw new ApiError(409, 'candidate_stale', 'The preview candidate does not match the current repository policy and requested source.');
    target = await resolve(c, repository.id, candidate.target_ref);
    if (target !== candidate.target_oid) throw new ApiError(409, 'candidate_stale', 'The accepted target moved after this merge candidate was created.');
    sourceRepo = candidate.source_repo_id; head = candidate.source_oid; candidateId = candidate.id;
    pullId ??= candidate.pull_request_id ?? undefined;
    await authorize(c, 'contents.read', { repo_id: sourceRepo, ...(sourceRepo === repository.id ? { ref: selectedRef } : {}) });
    if (pullId) await verifyPull(c, repository.id, pullId, sourceRepo, head);
    return finish(candidate.candidate_oid);
  }
  if (pullId) {
    const pull = await one<{ head_repo_id: string; head_oid: string; head_ref: string }>(db, 'SELECT head_repo_id,head_oid,head_ref FROM pull_requests WHERE repo_id=? AND id=?', repository.id, pullId);
    if (!pull || pull.head_ref !== selectedRef || requested.commit_oid !== undefined && requested.commit_oid !== pull.head_oid) throw new ApiError(409, 'pull_request_stale', 'The preview does not name the current pull-request source.');
    sourceRepo = pull.head_repo_id; head = await resolve(c, sourceRepo, pull.head_ref);
    if (head !== pull.head_oid) throw new ApiError(409, 'pull_request_stale', 'The native pull-request head changed.');
    return finish(head);
  }
  head = await resolve(c, sourceRepo, selectedRef);
  if (requested.commit_oid !== undefined && requested.commit_oid !== head) throw new ApiError(409, 'source_ref_changed', 'The preview commit is not the current accepted ref target.');
  return finish(head);

  function finish(oid: string): PreviewSource {
    return { source_repo_id: candidateId ? repository.id : sourceRepo, related_repo_ids: [...new Set([repository.id, sourceRepo])],
      input: { commit: oid, ref: selectedRef, event: { type: 'workflow.dispatch', id: previewId, inputs: requested.inputs,
        ...(pullId ? { pull_request_id: pullId } : {}), ...(candidateId ? { merge_candidate_id: candidateId } : {}) } },
      observation: { commit: oid, ref: selectedRef, source_repo_id: sourceRepo, candidate_id: candidateId, head_oid: head, target_oid: target } };
  }
}

async function verifyPull(c: AppContext, repoId: string, pullId: string, sourceRepo: string, head: string): Promise<void> {
  const pull = await one<{ head_repo_id: string; head_oid: string; head_ref: string }>(database(c), 'SELECT head_repo_id,head_oid,head_ref FROM pull_requests WHERE repo_id=? AND id=?', repoId, pullId);
  if (!pull || pull.head_repo_id !== sourceRepo || pull.head_oid !== head || await resolve(c, sourceRepo, pull.head_ref) !== head) {
    throw new ApiError(409, 'candidate_stale', 'The merge candidate no longer matches its native pull-request head.');
  }
}
