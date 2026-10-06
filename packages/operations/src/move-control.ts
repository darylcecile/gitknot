import { ApiError, canonicalJson, identityBinding, now, one, stmt } from '@gitknot/core';
import type { Bindings, Repository } from '@gitknot/core';
import type { MetadataFenceReceipt } from './metadata-fence.ts';
import { placementStorageName } from '../../billing/src/placement-state.ts';

export interface MoveControl {
  operation_id: string; repo_id: string; account_id: string;
  source_cell_id: string; source_shard_id: string; source_epoch: number;
  target_cell_id: string; target_shard_id: string; target_epoch: number;
  source_storage_name: string; target_storage_name: string; source_state: 'active' | 'archived' | 'deleted';
  source_fence_id: string; target_fence_id: string | null; snapshot_sha256: string | null;
  physical_sha256: string | null; physical_count: number | null;
  archive_id: string; archive_manifest_sha256: string | null;
  state: 'preparing' | 'copying' | 'verified' | 'cutover' | 'committed' | 'active' | 'cleaning' | 'completed' | 'aborting' | 'aborted';
  effective_at: string | null; activated_at: string | null; source_retained_until: string | null;
  source_barrier_released_at: string | null;
  abort_epoch: number | null; abort_requested_at: string | null; aborted_at: string | null; cleanup_verified_at: string | null;
  created_at: string; updated_at: string;
}

export async function moveControl(env: Bindings, operationId: string): Promise<MoveControl> {
  const row = await one<MoveControl>(identityBinding(env).withSession('first-primary'), 'SELECT * FROM repository_move_controls WHERE operation_id=?', operationId);
  if (!row) throw new ApiError(503, 'move_control_unavailable', 'The durable physical-placement operation is unavailable.');
  return row;
}

export async function initializeMoveControl(env: Bindings, input: {
  operation_id: string; repository: Repository; target_cell_id: string; target_shard_id: string;
  source_state: MoveControl['source_state']; metadata_fence: MetadataFenceReceipt; archive_id: string;
}): Promise<MoveControl> {
  const repo = input.repository;
  if (input.metadata_fence.repo_id !== repo.id || input.metadata_fence.operation_id !== input.operation_id
    || input.metadata_fence.routing_epoch !== repo.routing_epoch) throw new Error('move_control_fence_mismatch');
  const immutable = { operation_id: input.operation_id, repo_id: repo.id, account_id: repo.owner_id,
    source_cell_id: env.CELL_ID, source_shard_id: env.SHARD_ID, source_epoch: repo.routing_epoch,
    target_cell_id: input.target_cell_id, target_shard_id: input.target_shard_id, target_epoch: repo.routing_epoch + 1,
    source_storage_name: repo.storage_name, target_storage_name: env.CELL_ID === input.target_cell_id && input.archive_id === `archive_${input.operation_id}`
      ? repo.storage_name : await placementStorageName(repo.id, input.operation_id),
    source_state: input.source_state, source_fence_id: input.metadata_fence.fence_id, archive_id: input.archive_id };
  const fields = Object.keys(immutable);
  await stmt(identityBinding(env), `INSERT INTO repository_move_controls(${fields.join(',')},state,created_at,updated_at)
    VALUES(${fields.map(() => '?').join(',')},'preparing',?,?) ON CONFLICT(operation_id) DO NOTHING`, ...Object.values(immutable), now(), now()).run();
  const current = await moveControl(env, input.operation_id);
  const actual = Object.fromEntries(fields.map(field => [field, current[field as keyof MoveControl]]));
  if (canonicalJson(actual) !== canonicalJson(immutable)) throw new ApiError(409, 'move_control_conflict', 'The move ID already has different immutable participants.');
  return current;
}

export function sameMovePlacement(control: MoveControl, env: Bindings, side: 'source' | 'target'): boolean {
  return env.CELL_ID === control[`${side}_cell_id`] && env.SHARD_ID === control[`${side}_shard_id`];
}

export async function advanceMoveControl(env: Bindings, control: MoveControl, state: MoveControl['state'],
  values: Partial<Pick<MoveControl, 'snapshot_sha256' | 'archive_manifest_sha256' | 'physical_sha256' | 'physical_count' | 'target_fence_id'
    | 'effective_at' | 'activated_at' | 'source_barrier_released_at' | 'source_retained_until' | 'abort_epoch' | 'abort_requested_at' | 'aborted_at' | 'cleanup_verified_at'>> = {}): Promise<MoveControl> {
  const fields = Object.keys(values);
  const result = await stmt(identityBinding(env), `UPDATE repository_move_controls SET state=?,updated_at=?${fields.map(name => `,${name}=?`).join('')}
    WHERE operation_id=? AND state=? AND updated_at=?`, state, now(), ...Object.values(values), control.operation_id, control.state, control.updated_at).run();
  const current = await moveControl(env, control.operation_id);
  if (result.meta.changes !== 1 && (current.state !== state || fields.some(name => current[name as keyof MoveControl] !== values[name as keyof typeof values]))) {
    throw new ApiError(409, 'move_control_changed', 'The durable move decision advanced concurrently. Recover the same operation.');
  }
  return current;
}

export async function bindDestinationFence(env: Bindings, control: MoveControl, receipt: MetadataFenceReceipt): Promise<void> {
  if (!sameMovePlacement(control, env, 'target') || receipt.repo_id !== control.repo_id || receipt.operation_id !== control.operation_id
    || receipt.routing_epoch !== control.target_epoch) throw new Error('move_destination_fence_mismatch');
  await stmt(identityBinding(env), `UPDATE repository_move_controls SET target_fence_id=? WHERE operation_id=? AND target_fence_id IS NULL
    AND state IN ('preparing','copying')`, receipt.fence_id, control.operation_id).run();
  if ((await moveControl(env, control.operation_id)).target_fence_id !== receipt.fence_id) throw new Error('move_destination_fence_changed');
}
