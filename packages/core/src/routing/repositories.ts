import { one } from '../db.ts';
import { ApiError } from '../errors.ts';
import { identityBinding } from '../authority/identity.ts';
import { cellDatabase, routingRpc, validPlacementId } from './cells.ts';
import type { AppContext, Bindings, Repository } from '../types.ts';

export interface ResourceRoute {
  resource_id: string;
  resource_type: string;
  cell_id: string;
  shard_id: string;
  epoch: number;
  state: 'active' | 'moving' | 'fenced' | 'deleted';
  destination_cell_id: string | null;
  destination_shard_id: string | null;
  operation_id: string | null;
  updated_at: string;
}

export interface RepositoryPlacement {
  repo_id: string;
  cell_id: string;
  shard_id: string;
  epoch: number;
  state: ResourceRoute['state'];
  operation_id: string | null;
}

export async function resolveRoute(env: Bindings, resourceId: string): Promise<ResourceRoute | null> {
  return one<ResourceRoute>((env.DIRECTORY_DB ?? identityBinding(env)).withSession('first-primary'),
    'SELECT * FROM resource_routes WHERE resource_id=?', resourceId);
}

/** A retained source is never authoritative once a directory placement exists. */
export async function resolveRepositoryPlacement(env: Bindings, repoId: string): Promise<RepositoryPlacement | null> {
  const route = await resolveRoute(env, repoId);
  if (route) {
    if (route.resource_type !== 'repository' || !validPlacementId(route.cell_id) || !validPlacementId(route.shard_id)
      || !Number.isSafeInteger(route.epoch) || route.epoch < 1) {
      throw new ApiError(503, 'routing_unavailable', 'The repository placement could not be verified.');
    }
    return { repo_id: repoId, cell_id: route.cell_id, shard_id: route.shard_id, epoch: route.epoch,
      state: route.state, operation_id: route.operation_id };
  }
  // Initial catalog creation may precede its directory projection. Only the
  // original primary placement is a valid fast path, never a moved/fenced copy.
  const repo = await one<Repository>(identityBinding(env).withSession('first-primary'), 'SELECT * FROM repositories WHERE id=?', repoId);
  if (!repo) return null;
  if (repo.routing_epoch !== 1 || repo.state === 'moving') {
    throw new ApiError(503, 'routing_unavailable', 'The current repository placement could not be confirmed.');
  }
  return { repo_id: repo.id, cell_id: repo.cell_id, shard_id: repo.shard_id, epoch: repo.routing_epoch,
    state: repo.state === 'deleted' ? 'deleted' : 'active', operation_id: null };
}

export function assertRepositoryPlacement(repository: Repository | null, placement: RepositoryPlacement): void {
  if (repository && (typeof repository.owner_id !== 'string' || !repository.owner_id
    || !['public', 'private', 'internal', 'unlisted'].includes(repository.visibility)
    || !['provisioning', 'active', 'archived', 'transfer_pending', 'moving', 'deleted'].includes(repository.state)
    || !Number.isSafeInteger(repository.revision) || repository.revision < 1
    || !Number.isSafeInteger(repository.policy_revision) || repository.policy_revision < 1)) {
    throw new ApiError(503, 'repository_authority_unavailable', 'The repository authority response could not be verified.');
  }
  if (repository && (repository.id !== placement.repo_id || repository.routing_epoch !== placement.epoch
    || repository.cell_id !== placement.cell_id || repository.shard_id !== placement.shard_id)) {
    throw new ApiError(409, 'routing_epoch_changed', 'The repository moved. Retry using the same resource ID.');
  }
}

export async function readPlacedRepository(env: Bindings, placement: RepositoryPlacement): Promise<Repository | null> {
  const repository = placement.cell_id === env.CELL_ID
    ? await one<Repository>(cellDatabase(env, placement.shard_id).withSession('first-primary'), 'SELECT * FROM repositories WHERE id=?', placement.repo_id)
    : await routingRpc<Repository | null>(env, placement.cell_id, { action: 'repository.read',
      repo_id: placement.repo_id, cell_id: placement.cell_id, shard_id: placement.shard_id, epoch: placement.epoch });
  assertRepositoryPlacement(repository, placement);
  return repository;
}

/** Independent repository scopes must resolve independently, including fork ancestry. */
export async function readRepositoryAuthority(c: AppContext, repoId: string): Promise<Repository | null> {
  const placement = await resolveRepositoryPlacement(c.env, repoId);
  return placement ? readPlacedRepository(c.env, placement) : null;
}
