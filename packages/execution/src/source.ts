import { ApiError, authorize, internalFetch, now, one, prepareCredential, readBounded } from '@gitknot/core';
import type { Bindings, Principal } from '@gitknot/core';
import { identityPrimary } from './store.ts';
import { commitIdentityCredential, identityExecutionContext } from './credentials.ts';

async function withSourceRead<T>(env: Bindings, repoId: string, actor: Principal, operation: string, input: Record<string, unknown>, consume: (response: Response) => Promise<T>): Promise<T> {
  const authority = identityExecutionContext(env, actor);
  await authorize(authority, 'contents.read', { repo_id: repoId });
  let current = actor;
  if (!current.credential_id) {
    const user = actor.user_id ? await one<{ auth_revision: number }>(identityPrimary(env), 'SELECT auth_revision FROM users WHERE id=? AND disabled_at IS NULL', actor.user_id) : null;
    const credential = await prepareCredential(identityPrimary(env), { principal_id: actor.id, user_id: actor.user_id, kind: 'job', name: 'Workflow source inspection', capabilities: ['contents.read'],
      repository_ids: [repoId], account_ids: null, auth_revision: user?.auth_revision ?? null, mfa: actor.mfa,
      expires_at: new Date(Date.now() + 180_000).toISOString(), created_by: actor.id });
    await commitIdentityCredential(env, authority, [credential.statement], { type: 'execution.source.authorized', resource_id: credential.credential.id, resource_revision: 1,
      repo_id: repoId, actor_id: actor.id, data: { purpose: 'private-source-inspection' } });
    current = { ...actor, credential_id: credential.credential.id, capabilities: ['contents.read'], repository_ids: [repoId] };
  }
  // Private inspection credentials have a three-minute expiry; their random
  // bearer is never sent or returned. Git resolves their ID at current authority.
  const response = await internalFetch(env.GIT_SERVICE, env.INTERNAL_SERVICE_KEY, 'git-service', `/internal/git/repositories/${repoId}/${operation}`, { actor: current, ...input });
  if (!response.ok) { await response.body?.cancel(); throw new ApiError(response.status === 404 ? 404 : 503, 'source_unavailable', 'GitKnot could not verify repository source.'); }
  return consume(response);
}

/** Uses the same current-authorized native Git service as browsing and publication. */
export async function resolveSourceRef(env: Bindings, repoId: string, ref: string, actor: Principal): Promise<string> {
  if (!/^refs\/(heads|tags)\/[^\s\x00-\x1f]+$/.test(ref)) throw new ApiError(422, 'invalid_ref', 'Use a complete branch or tag ref.');
  return withSourceRead(env, repoId, actor, 'collaboration/inspect', { inspection: { kind: 'resolve', ref } }, async response => {
    const value = JSON.parse(new TextDecoder().decode(await readBounded(response.body, 8192))) as { repo_id: string; commit_oid: string };
    if (value.repo_id !== repoId || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.commit_oid)) throw new ApiError(503, 'source_evidence_invalid', 'The source revision was not verified for this repository.');
    return value.commit_oid;
  });
}

export async function readWorkflowSource(env: Bindings, repoId: string, commit: string, path: string, actor: Principal): Promise<string> {
  if (!/^\.gitknot\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/.test(path) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit)) throw new ApiError(422, 'invalid_workflow_source', 'Workflows require a pinned commit and a .gitknot/workflows YAML path.');
  return withSourceRead(env, repoId, actor, 'browse/raw', { query: { ref: commit, path } }, async response =>
    new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(response.body, 512 * 1024)));
}
