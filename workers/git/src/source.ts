import { signInternalRequest } from '@gitknot/core';
import type { AppContext, Repository } from '@gitknot/core';
import type { GitRemote } from '../../../packages/git/src/types.ts';
import { GIT_SERVICE_SCOPE } from '../../../packages/git/src/types.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';
import { gitCell, gitPlacement } from './placement.ts';
import { artifacts } from './storage.ts';
import { nativeJson } from './native.ts';
import type { GitBindings } from './types.ts';

/** A source's provider namespace belongs to its current cell, independently of the target. */
export async function repositoryReadRemote(c: AppContext, repository: Repository): Promise<GitRemote> {
  const env = c.env as GitBindings;
  const placement = await gitPlacement(env, repository.id);
  requireValue(placement.epoch === repository.routing_epoch && placement.cell_id === repository.cell_id
    && placement.shard_id === repository.shard_id, 'routing_epoch_changed', 'The Git source moved during authorization.', 409);
  if (placement.cell_id === env.CELL_ID) return artifacts(env).access(repository.storage_name, 'read');
  const request = new Request(`https://internal.gitknot.com/internal/git/repositories/${repository.id}/read-remote`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: c.get('principal') }),
  });
  const value = await nativeJson<{ repo_id: string; routing_epoch: number; storage_name: string; remote: GitRemote }>(
    await gitCell(env, placement.cell_id).fetch(await signInternalRequest(request, env.INTERNAL_SERVICE_KEY, GIT_SERVICE_SCOPE)));
  requireValue(value.repo_id === repository.id && value.routing_epoch === repository.routing_epoch && value.storage_name === repository.storage_name,
    'routing_epoch_changed', 'The Git source changed during remote admission.', 409);
  return value.remote;
}
