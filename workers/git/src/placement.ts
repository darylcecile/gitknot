import { cellDatabase, identityAuthorityBindings, one, resolveRepositoryPlacement, resolveRoute, selectRepositoryDatabase } from '@gitknot/core';
import type { AppContext, Repository, RepositoryPlacement } from '@gitknot/core';
import { routingBindings } from '@gitknot/core/routing/cells';
import { assertRepositoryPlacement } from '@gitknot/core/routing/repositories';
import { requireValue } from '../../../packages/git/src/errors.ts';
import type { GitBindings } from './types.ts';

export function gitCell(env: GitBindings, cellId: string): Fetcher {
  const name = routingBindings(env.CELL_GIT_BINDINGS_JSON, 32)[cellId];
  const binding = name ? env[name] as Fetcher | undefined : undefined;
  requireValue(binding && typeof binding.fetch === 'function', 'git_cell_unavailable', 'The current Git repository cell is unavailable.', 503);
  return binding;
}

export function gitShardEnvironment(env: GitBindings, shardId: string): GitBindings {
  return { ...env, ...identityAuthorityBindings(env), DB: cellDatabase(env, shardId), SHARD_ID: shardId,
    ROOT_DB: env.ROOT_DB ?? env.DB, ROOT_SHARD_ID: env.ROOT_SHARD_ID ?? env.SHARD_ID };
}

export async function selectGitPlacement(c: AppContext, placement: RepositoryPlacement, lifecycle: boolean): Promise<GitBindings> {
  requireValue(placement.cell_id === c.env.CELL_ID, 'routing_epoch_changed', 'This request belongs to another Git repository cell.', 409);
  const env = gitShardEnvironment(c.env as GitBindings, placement.shard_id);
  const repository = await one<Repository>(env.DB.withSession('first-primary'), 'SELECT * FROM repositories WHERE id=?', placement.repo_id);
  requireValue(repository, 'not_found', 'Git repository not found.', 404);
  assertRepositoryPlacement(repository, placement);
  c.env = env;
  selectRepositoryDatabase(c, placement);
  c.set('routing', { resource_id: placement.repo_id, cell_id: placement.cell_id, shard_id: placement.shard_id,
    epoch: placement.epoch, expected_state: repository.state, lifecycle });
  return env;
}

/** Only an exact, already-fenced move may restore into its staged destination before cutover. */
export async function gitPlacement(env: GitBindings, repoId: string, stagedOperationId?: string): Promise<RepositoryPlacement> {
  if (stagedOperationId) {
    const route = await resolveRoute(env, repoId);
    if (route?.state === 'fenced' && route.operation_id === stagedOperationId && route.destination_cell_id && route.destination_shard_id) {
      return { repo_id: repoId, cell_id: route.destination_cell_id, shard_id: route.destination_shard_id,
        epoch: route.epoch + 1, state: 'fenced', operation_id: stagedOperationId };
    }
  }
  const placement = await resolveRepositoryPlacement(env, repoId);
  requireValue(placement, 'not_found', 'Git repository not found.', 404);
  return placement;
}

export function sameGitPlacement(request: Request, placement: RepositoryPlacement): boolean {
  return request.headers.get('x-gitknot-routing-resource') === placement.repo_id
    && request.headers.get('x-gitknot-routing-cell') === placement.cell_id
    && request.headers.get('x-gitknot-routing-shard') === placement.shard_id
    && request.headers.get('x-gitknot-routing-epoch') === String(placement.epoch);
}
