import { canonicalJson, one, resolveRoute, sha256 } from '@gitknot/core';
import type { Principal, Repository } from '@gitknot/core';
import { moveControl } from '../../../packages/operations/src/move-control.ts';
import { storagePlacement } from '../../../packages/billing/src/placement-state.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';
import type { GitMoveRestore, GitRestoreContext } from '../../../packages/git/src/types.ts';
import type { GitBindings } from './types.ts';
import { readMoveArchive } from './maintenance.ts';

/** A copied operation alone cannot opt out of public catalog revision semantics. */
export async function moveRestoreAuthority(env: GitBindings, repository: Repository, operationId: string,
  actor: Principal, restore: GitRestoreContext, expected?: GitMoveRestore): Promise<GitMoveRestore | undefined> {
  const db = env.DB.withSession('first-primary');
  const operation = await one<{ kind: string; actor_id: string; input_json: string }>(db,
    'SELECT kind,actor_id,input_json FROM operations WHERE id=? AND repo_id=?', operationId, repository.id);
  if (operation?.kind !== 'repository.move') {
    requireValue(!expected, 'move_publication_changed', 'The admitted publication no longer names its original move.', 409);
    return undefined;
  }
  const control = await moveControl(env, operationId);
  const placement = await storagePlacement(env, operationId);
  const route = await resolveRoute(env, repository.id);
  requireValue(control.repo_id === repository.id && control.account_id === repository.owner_id && control.state === 'copying'
    && control.snapshot_sha256 && control.archive_manifest_sha256 && control.target_fence_id
    && control.target_cell_id === env.CELL_ID && control.target_shard_id === env.SHARD_ID
    && control.target_epoch === repository.routing_epoch && control.source_storage_name === repository.storage_name
    && control.archive_id === restore.archive_id && repository.state === 'moving',
  'move_publication_scope', 'The native restore must match its frozen destination and archive.', 409);
  requireValue(route?.state === 'fenced' && route.operation_id === operationId && route.cell_id === control.source_cell_id
    && route.shard_id === control.source_shard_id && route.epoch === control.source_epoch
    && route.destination_cell_id === control.target_cell_id && route.destination_shard_id === control.target_shard_id,
  'move_publication_fenced', 'The move no longer owns its original directory fence.', 409);
  requireValue(placement.state === 'prepared' && placement.repo_id === control.repo_id && placement.account_id === control.account_id
    && placement.actor_id === actor.id && operation.actor_id === actor.id
    && placement.source_cell_id === control.source_cell_id && placement.source_shard_id === control.source_shard_id
    && placement.source_epoch === control.source_epoch && placement.source_storage_name === control.source_storage_name
    && placement.target_cell_id === control.target_cell_id && placement.target_shard_id === control.target_shard_id
    && placement.target_epoch === control.target_epoch && placement.target_storage_name === control.target_storage_name,
  'move_physical_billing_handoff_unconfirmed', 'The native restore requires its exact funded physical placement.', 503);
  const fence = await one(db, `SELECT 1 FROM repository_metadata_fences WHERE repo_id=? AND operation_id=? AND routing_epoch=? AND fence_id=? AND state='held'`,
    repository.id, operationId, control.target_epoch, control.target_fence_id);
  const staged = await one(db, `SELECT 1 FROM move_staging WHERE operation_id=? AND repo_id=? AND source_cell_id=? AND source_shard_id=?
    AND source_epoch=? AND target_shard_id=? AND phase='final' AND state IN ('applying','verified')`,
  operationId, repository.id, control.source_cell_id, control.source_shard_id, control.source_epoch, control.target_shard_id);
  const snapshot = await one<{ data_json: string; sha256: string }>(db,
    "SELECT data_json,sha256 FROM move_snapshot_rows WHERE operation_id=? AND table_name='repositories'", operationId);
  requireValue(fence && staged && snapshot && await sha256(snapshot.data_json) === snapshot.sha256,
    'move_snapshot_changed', 'The destination must retain its exact frozen repository snapshot and metadata fence.', 409);
  const frozen = JSON.parse(snapshot.data_json) as Repository;
  const current = await one<Repository>(db, 'SELECT * FROM repositories WHERE id=?', repository.id);
  requireValue(canonicalJson(current) === canonicalJson(repository) && canonicalJson(repository) === canonicalJson({ ...frozen, cell_id: control.target_cell_id, shard_id: control.target_shard_id,
    routing_epoch: control.target_epoch, state: 'moving' }), 'move_snapshot_changed', 'The staged repository changed after its source snapshot.', 409);
  const saved = await one<{ data_json: string; sha256: string }>(db,
    "SELECT data_json,sha256 FROM move_snapshot_rows WHERE operation_id=? AND table_name='operations' AND json_extract(data_json,'$.id')=?", operationId, operationId);
  requireValue(saved && await sha256(saved.data_json) === saved.sha256, 'move_snapshot_changed', 'The original move operation snapshot is unavailable.', 409);
  const originalOperation = JSON.parse(saved.data_json) as typeof operation;
  requireValue(originalOperation.kind === operation.kind && originalOperation.actor_id === operation.actor_id && originalOperation.input_json === operation.input_json,
    'move_actor_changed', 'The staged operation differs from its original actor and request.', 409);
  const input = JSON.parse(operation.input_json) as { principal?: Principal; actor?: Principal; maintenance?: boolean; archive_id?: string };
  const original = input.principal ?? input.actor;
  requireValue(original ? canonicalJson(original) === canonicalJson(actor) : input.maintenance === true && actor.id === 'system:operations'
    && actor.kind === 'service' && actor.credential_id === null && actor.user_id === null,
  'move_actor_changed', 'The restore must retain the original operation principal and credential ceilings.', 403);
  const requestHash = await sha256(canonicalJson({ repo_id: repository.id, target_cell_id: control.target_cell_id,
    target_shard_id: control.target_shard_id, expected_epoch: control.source_epoch, archive_id: input.archive_id ?? null, actor_id: actor.id }));
  requireValue(input.archive_id ? placement.purpose === 'archive_restore' && placement.archive_id === input.archive_id
    && placement.archive_manifest_sha256 === control.archive_manifest_sha256 : placement.purpose === 'move',
  'move_archive_changed', 'The physical placement has a different move or archive-recovery purpose.', 409);
  const archive = await one<{ manifest_key: string; manifest_sha256: string }>(db, "SELECT manifest_key,manifest_sha256 FROM repository_archives WHERE id=? AND repo_id=? AND account_id=? AND manifest_sha256=? AND state='verified'",
    restore.archive_id, repository.id, control.account_id, control.archive_manifest_sha256);
  requireValue(archive, 'move_archive_changed', 'The restore no longer matches its immutable move request and verified archive.', 409);
  requireValue(canonicalJson(restore) === canonicalJson(await readMoveArchive(env, repository.id, control.account_id, restore.archive_id, archive)),
    'move_archive_changed', 'The native restore must preserve the exact verified archive graph and ref inventory.', 409);
  const proof: GitMoveRestore = { operation_id: operationId, repo_id: repository.id, account_id: repository.owner_id, actor_id: actor.id,
    actor_sha256: await sha256(canonicalJson(actor)), request_sha256: requestHash, placement_fence: placement.fence, placement_request_sha256: placement.request_hash,
    source: { cell_id: control.source_cell_id, shard_id: control.source_shard_id, epoch: control.source_epoch, storage_name: control.source_storage_name, fence_id: control.source_fence_id },
    destination: { cell_id: control.target_cell_id, shard_id: control.target_shard_id, epoch: control.target_epoch, storage_name: control.target_storage_name, fence_id: control.target_fence_id },
    snapshot_sha256: control.snapshot_sha256, repository_sha256: snapshot.sha256, repository_revision: frozen.revision,
    archive_id: control.archive_id, manifest_sha256: control.archive_manifest_sha256, restore_sha256: await sha256(canonicalJson(restore)) };
  requireValue(!expected || canonicalJson(expected) === canonicalJson(proof), 'move_publication_changed', 'The move proof changed after native admission.', 409);
  return proof;
}
