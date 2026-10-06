import { cellDatabase, one } from '@gitknot/core';
import type { Repository } from '@gitknot/core';
import { handlePlacementGitRequest } from '../../../packages/billing/src/placement-git.ts';
import type { PlacementGitBackend } from '../../../packages/billing/src/placement-git.ts';
import { artifacts } from './storage.ts';
import { createNativeSession, nativeAction, nativeJson } from './native.ts';
import { readPolicy } from './lifecycle.ts';
import { reviewRefs } from '../../../packages/git/src/protocol.ts';
import { many } from '@gitknot/core';
import type { GitBindings } from './types.ts';
import { reconcilePlacementPublisher } from './move-publication.ts';

export function gitStoragePlacement(request: Request, env: GitBindings): Promise<Response> {
  const store = artifacts(env);
  const backend: PlacementGitBackend = {
    reconcilePublisher: (placement, side) => reconcilePlacementPublisher(env, placement, side),
    observeCreation: placement => store.observeCreation(placement.target_storage_name),
    async exists(name) {
      try { await store.remote(name); return true; }
      catch (error) { if (error instanceof Error && 'status' in error && error.status === 404) return false; throw error; }
    },
    async delete(name) { await store.delete(name); },
    async verify(placement, storageName, side) {
      const shard = side === 'target' ? placement.target_shard_id : placement.source_shard_id;
      const db = cellDatabase(env, shard).withSession('first-primary');
      const repo = await one<Repository>(db, 'SELECT * FROM repositories WHERE id=?', placement.repo_id);
      if (!repo || repo.owner_id !== placement.account_id) throw new Error('placement_git_repository_changed');
      const candidates = await many<{ internal_ref: string }>(db, 'SELECT internal_ref FROM git_candidates WHERE repo_id=? AND candidate_oid IS NOT NULL ORDER BY internal_ref', repo.id);
      const reviews = await many<{ id: string }>(db, "SELECT id FROM git_review_snapshots WHERE repo_id=? AND state='ready' ORDER BY id", repo.id);
      const native = await createNativeSession(env, { repository: { id: repo.id, owner_id: repo.owner_id, storage_name: storageName,
        default_branch: repo.default_branch, policy_revision: repo.policy_revision, routing_epoch: repo.routing_epoch }, policy: readPolicy(env),
        remote: await store.access(storageName, 'read'), mode: 'read', retained_refs: [...candidates.map(row => row.internal_ref), ...reviews.flatMap(row => reviewRefs(row.id))] });
      return nativeJson(await nativeAction(native, 'verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    },
  };
  return handlePlacementGitRequest(request, env, backend);
}
