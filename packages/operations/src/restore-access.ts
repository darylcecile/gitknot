import { ApiError, captureAccountAuthority, captureMutationAuthority, explainAuthorization, readRepositoryAuthority, recordRequestPolicy } from '@gitknot/core';
import type { AppContext } from '@gitknot/core';
import { metadataFenceGuard, operationFence } from './metadata-fence.ts';

/** Only the held restore owner can inspect a fork audience through its own deleted base. Every actual grant/credential/policy denial still applies. */
export async function authorizeRestoreSource(c: AppContext, operationId: string, baseRepoId: string, sourceRepoId: string): Promise<void> {
  const fence = await operationFence(c.get('database'), operationId);
  if (!fence || fence.repo_id !== baseRepoId) throw new ApiError(403, 'restore_fence_required', 'This source read requires the recorded restore owner.');
  await c.get('database').batch(metadataFenceGuard(c.get('database'), baseRepoId, fence));
  await captureMutationAuthority(c);
  const visit = async (id: string, visited: Set<string>, ancestor = false): Promise<void> => {
    if (visited.has(id) || visited.size >= 32) throw new ApiError(403, 'restore_source_unavailable', 'The restore source ancestry cannot be verified.');
    const repo = await readRepositoryAuthority(c, id);
    const decision = await explainAuthorization(c, 'contents.read', { repo_id: id }, c.get('principal'), new Set(), ancestor);
    const permittedReasons = id === baseRepoId ? ['repository_deleted', 'repository_unavailable', 'fork_source_access_required'] : ['fork_source_access_required'];
    const lifecycleOnly = decision.matched_grants.some(grant => grant.effect === 'allow') && decision.reasons.every(reason => permittedReasons.includes(reason.code))
      && (id === baseRepoId || !!repo?.fork_source_id);
    if (!repo || !decision.allowed && !lifecycleOnly) throw new ApiError(403, 'restore_source_revoked', 'A historical source is no longer in the restoring principal’s audience.');
    await captureAccountAuthority(c, repo.owner_id, decision.account_policy_revision);
    if (repo.fork_source_id) await visit(repo.fork_source_id, new Set(visited).add(id), true);
    if (!ancestor || id === baseRepoId) recordRequestPolicy(c, { capability: 'contents.read', scope: { repo_id: id } }, { ...decision, allowed: true });
  };
  await visit(sourceRepoId, new Set());
}
