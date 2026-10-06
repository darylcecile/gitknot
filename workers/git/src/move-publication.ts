import { signInternalRequest } from '@gitknot/core';
import type { RepositoryPlacement } from '@gitknot/core';
import { moveControl } from '../../../packages/operations/src/move-control.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';
import { GIT_COORDINATOR_SCOPE, GIT_SERVICE_SCOPE } from '../../../packages/git/src/types.ts';
import type { GitMovePublisherRequest, GitMovePublisherState } from '../../../packages/git/src/types.ts';
import { nativeJson } from './native.ts';
import { gitCell } from './placement.ts';
import type { GitBindings } from './types.ts';
import type { PlacementPublicationFence, StoragePlacement } from '../../../packages/billing/src/placement-types.ts';

/** The identity-primary move record survives destination metadata removal. */
export async function movePublisherPlacement(env: GitBindings, repoId: string, input: GitMovePublisherRequest): Promise<RepositoryPlacement> {
  requireValue(typeof input.operation_id === 'string' && ['source', 'target'].includes(input.side) && ['read', 'settle'].includes(input.action),
    'move_publication_request', 'An exact move publisher and physical side are required.', 400);
  const control = await moveControl(env, input.operation_id);
  requireValue(control.repo_id === repoId, 'move_publication_scope', 'This move belongs to another repository.', 403);
  if (input.action === 'settle') requireValue(input.side === 'target' ? ['aborting', 'aborted'].includes(control.state)
    : ['cleaning', 'active', 'completed'].includes(control.state),
  'move_publication_fenced', 'The durable move decision does not authorize closing this publisher.', 409);
  return { repo_id: repoId, cell_id: control[`${input.side}_cell_id`], shard_id: control[`${input.side}_shard_id`],
    epoch: control[`${input.side}_epoch`], state: 'fenced', operation_id: input.operation_id };
}

export async function movePublisherState(env: GitBindings, repoId: string, input: GitMovePublisherRequest): Promise<GitMovePublisherState> {
  const placement = await movePublisherPlacement(env, repoId, input);
  const local = placement.cell_id === env.CELL_ID;
  const request = new Request(local ? `https://coordinator.gitknot.internal/move-publication?repo_id=${encodeURIComponent(repoId)}`
    : `https://internal.gitknot.com/internal/git/repositories/${repoId}/move-publication`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  const service = local ? env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repoId)) : gitCell(env, placement.cell_id);
  const result = await nativeJson<GitMovePublisherState>(await service.fetch(await signInternalRequest(request, env.INTERNAL_SERVICE_KEY,
    local ? GIT_COORDINATOR_SCOPE : GIT_SERVICE_SCOPE)));
  requireValue(result.operation_id === input.operation_id && result.repo_id === repoId && result.cell_id === placement.cell_id && result.shard_id === placement.shard_id,
    'move_publication_scope', 'The publisher receipt came from a different physical placement.', 503);
  return result;
}

/** Billing records only this positive, original-journal terminal fence receipt. */
export async function reconcilePlacementPublisher(env: GitBindings, placement: StoragePlacement, side: 'source' | 'target'): Promise<PlacementPublicationFence> {
  const publisher = await movePublisherState(env, placement.repo_id, { operation_id: placement.operation_id, side, action: 'settle' });
  requireValue(publisher.storage_name === placement[`${side}_storage_name`] && publisher.closed && publisher.terminal && publisher.finalized
    && (publisher.state === 'committed' || publisher.state === 'rejected' || publisher.state === 'not_started'),
  'publication_in_progress', 'The original native publisher must be terminal and fenced before physical cleanup.', 409);
  return { version: 1, operation_id: placement.operation_id, repo_id: placement.repo_id, storage_name: publisher.storage_name,
    placement_fence: placement.fence, side, source_epoch: placement.source_epoch, target_epoch: placement.target_epoch,
    state: publisher.state, finalized: true, writer_fenced: true };
}
