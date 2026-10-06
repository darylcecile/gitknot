import { canonicalJson, identityBinding, now, one, resolveRoute, sha256, signInternalRequest } from '@gitknot/core';
import type { Principal, Repository, ResourceRoute } from '@gitknot/core';
import type { GitMaintenanceMove, GitRestoreContext } from '../../../packages/git/src/types.ts';
import { GIT_COORDINATOR_SCOPE, GIT_SERVICE_SCOPE } from '../../../packages/git/src/types.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';
import { requireMaintenanceAuthority } from '../../../packages/operations/src/maintenance-authority.ts';
import { gitCell, gitShardEnvironment } from './placement.ts';
import { nativeJson } from './native.ts';
import type { GitBindings } from './types.ts';
import { readGitLimits, validateOid, validateRef } from '../../../packages/git/src/policy.ts';
import { movePublisherState } from './move-publication.ts';
import type { MoveControl } from '../../../packages/operations/src/move-control.ts';

interface MoveRequest {
  operation_id: string; repo_id: string; expected_epoch: number; request_sha256: string;
  source_cell_id: string; source_shard_id: string; target_cell_id: string; target_shard_id: string;
}

async function fencedMove(env: GitBindings, repoId: string, operationId: string): Promise<ResourceRoute> {
  const route = await resolveRoute(env, repoId);
  requireValue(route?.resource_type === 'repository' && route.state === 'fenced' && route.operation_id === operationId
    && route.destination_cell_id && route.destination_shard_id, 'maintenance_move_fenced', 'The exact repository move must still own its directory fence.', 409);
  return route;
}

/** Runs on the source placement. A destination's copied intent is never the authority. */
export async function sourceMoveAuthority(env: GitBindings, repoId: string, operationId: string, archiveId: string): Promise<GitMaintenanceMove> {
  const route = await fencedMove(env, repoId, operationId);
  requireValue(route.cell_id === env.CELL_ID && route.shard_id === env.SHARD_ID, 'maintenance_source_changed', 'The move authority must be read at its source placement.', 409);
  const token = `move_${operationId}`;
  const tokenHash = await sha256(token);
  const coordinator = await one<{ cell_id: string; shard_id: string; epoch: number; token_hash: string }>(identityBinding(env),
    'SELECT cell_id,shard_id,epoch,token_hash FROM git_barrier_routes WHERE repo_id=? AND operation_id=?', repoId, operationId);
  requireValue(coordinator?.cell_id === route.cell_id && coordinator.shard_id === route.shard_id && coordinator.epoch === route.epoch
    && coordinator.token_hash === tokenHash, 'maintenance_barrier_required', 'The move must retain its original coordinator ownership record.', 409);
  const intent = await requireMaintenanceAuthority(env, repoId, operationId, 'repository.move', token);
  const request = await one<MoveRequest>(env.DB, 'SELECT * FROM repository_move_requests WHERE operation_id=? AND repo_id=?', operationId, repoId);
  const operation = await one<{ input_json: string; resource_id: string }>(env.DB, 'SELECT input_json,resource_id FROM operations WHERE id=? AND repo_id=?', operationId, repoId);
  requireValue(request && operation?.resource_id === repoId && request.expected_epoch === route.epoch && intent.routing_epoch === route.epoch
    && request.source_cell_id === route.cell_id && request.source_shard_id === route.shard_id
    && request.target_cell_id === route.destination_cell_id && request.target_shard_id === route.destination_shard_id,
  'maintenance_move_scope', 'The maintenance move no longer matches its durable placement request.', 409);
  const input = JSON.parse(operation.input_json) as Record<string, unknown>;
  const expectedHash = await sha256(canonicalJson({ repo_id: repoId, target_cell_id: request.target_cell_id,
    target_shard_id: request.target_shard_id, expected_epoch: route.epoch, archive_id: null, actor_id: 'system:operations' }));
  requireValue(input.maintenance === true && !input.principal && !input.actor && !input.archive_id
    && input.expected_epoch === route.epoch && input.target_cell_id === request.target_cell_id && input.target_shard_id === request.target_shard_id
    && request.request_sha256 === expectedHash && archiveId === `archive_${operationId}`,
  'maintenance_move_scope', 'Credentialless movement cannot restore another archive or assume a user identity.', 403);
  const move = await one<{ manifest_sha256: string | null }>(env.DB, `SELECT manifest_sha256 FROM shard_moves WHERE operation_id=? AND repo_id=?
    AND source_cell_id=? AND source_shard_id=? AND source_epoch=? AND target_cell_id=? AND target_shard_id=? AND target_epoch=?
    AND state IN ('fenced','finalizing')`, operationId, repoId, route.cell_id, route.shard_id, route.epoch, request.target_cell_id, request.target_shard_id, route.epoch + 1);
  const archive = await one<{ manifest_sha256: string; manifest_key: string }>(env.DB, `SELECT manifest_sha256,manifest_key FROM repository_archives WHERE id=? AND operation_id=? AND repo_id=?
    AND account_id=? AND kind='move' AND state='verified' AND routing_epoch=? AND expires_at>?`, archiveId, operationId, repoId, intent.account_id, route.epoch, now());
  requireValue(move?.manifest_sha256 && /^[a-f0-9]{64}$/u.test(move.manifest_sha256) && archive && /^[a-f0-9]{64}$/u.test(archive.manifest_sha256),
    'maintenance_archive_unverified', 'The move requires its verified source archive and final metadata snapshot.', 409);
  const repository = await one<Repository>(env.DB, 'SELECT * FROM repositories WHERE id=?', repoId);
  requireValue(repository?.state === 'moving' && repository.owner_id === intent.account_id && repository.routing_epoch === route.epoch,
    'maintenance_source_changed', 'The source repository changed during movement.', 409);
  const restore = await readMoveArchive(env, repoId, intent.account_id, archiveId, archive);
  await checkMoveBarrier(env, repoId, operationId, token);
  return { purpose: 'repository.move', operation_id: operationId, repo_id: repoId, account_id: intent.account_id, actor_id: 'system:operations',
    source: { cell_id: route.cell_id, shard_id: route.shard_id, epoch: route.epoch },
    destination: { cell_id: request.target_cell_id, shard_id: request.target_shard_id, epoch: route.epoch + 1 },
    archive_id: archiveId, manifest_sha256: archive.manifest_sha256, request_sha256: request.request_sha256,
    snapshot_sha256: move.manifest_sha256, barrier_token_hash: tokenHash, restore,
    repository: { visibility: repository.visibility, fork_source_id: repository.fork_source_id, default_branch: repository.default_branch,
      policy_revision: repository.policy_revision, storage_name: repository.storage_name } };
}

export async function readMoveArchive(env: GitBindings, repoId: string, accountId: string, archiveId: string,
  archive: { manifest_key: string; manifest_sha256: string }): Promise<GitRestoreContext> {
  const object = await env.BACKUPS.get(archive.manifest_key);
  requireValue(object && object.size <= 8 * 1024 * 1024, 'maintenance_archive_unverified', 'The source move manifest is unavailable.', 503);
  const bytes = new Uint8Array(await object.arrayBuffer());
  requireValue(await sha256(bytes) === archive.manifest_sha256, 'maintenance_archive_unverified', 'The source move manifest checksum changed.', 409);
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as { archive_id: string; repository: { id: string; owner_id: string };
    git: { bytes: number; sha256: string; refs: Array<{ ref: string; oid: string }> } };
  const limits = readGitLimits(env.LIMITS_JSON);
  requireValue(manifest.archive_id === archiveId && manifest.repository.id === repoId && manifest.repository.owner_id === accountId
    && Number.isSafeInteger(manifest.git.bytes) && manifest.git.bytes >= 0 && manifest.git.bytes <= limits.max_pack_bytes
    && /^[a-f0-9]{64}$/u.test(manifest.git.sha256) && Array.isArray(manifest.git.refs) && manifest.git.refs.length <= limits.max_refs,
  'maintenance_archive_unverified', 'The source move archive has a different owner or Git inventory.', 409);
  for (const entry of manifest.git.refs) { validateRef(entry.ref, true); validateOid(entry.oid, false); }
  return { archive_id: archiveId, bundle_sha256: manifest.git.sha256, bundle_bytes: manifest.git.bytes, expected_refs: manifest.git.refs };
}

async function checkMoveBarrier(env: GitBindings, repoId: string, operationId: string, token: string): Promise<void> {
  const request = new Request(`https://coordinator.gitknot.internal/barrier/check?repo_id=${encodeURIComponent(repoId)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation_id: operationId, token, restore_operation_id: operationId }),
  });
  const held = await nativeJson<{ held: boolean; operation_id: string }>(await env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repoId))
    .fetch(await signInternalRequest(request, env.INTERNAL_SERVICE_KEY, GIT_COORDINATOR_SCOPE)));
  requireValue(held.held && held.operation_id === operationId, 'maintenance_barrier_required', 'The move no longer owns its live source barrier.', 409);
}

export async function maintenanceRestoreAuthority(env: GitBindings, repoId: string, operationId: string, archiveId: string,
  expected?: GitMaintenanceMove): Promise<{ actor: Principal; repository: Repository; maintenance: GitMaintenanceMove }> {
  const route = await fencedMove(env, repoId, operationId);
  requireValue(route.destination_cell_id === env.CELL_ID && route.destination_shard_id === env.SHARD_ID,
    'maintenance_destination_changed', 'The restore is outside the move destination.', 409);
  let maintenance: GitMaintenanceMove;
  if (route.cell_id === env.CELL_ID) maintenance = await sourceMoveAuthority(gitShardEnvironment(env, route.shard_id), repoId, operationId, archiveId);
  else {
    const request = new Request(`https://internal.gitknot.com/internal/git/repositories/${repoId}/move-restore-authority`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation_id: operationId, archive_id: archiveId }),
    });
    maintenance = await nativeJson<GitMaintenanceMove>(await gitCell(env, route.cell_id).fetch(await signInternalRequest(request, env.INTERNAL_SERVICE_KEY, GIT_SERVICE_SCOPE)));
  }
  requireValue(maintenance.purpose === 'repository.move' && maintenance.repo_id === repoId && maintenance.operation_id === operationId
    && maintenance.archive_id === archiveId && maintenance.source.cell_id === route.cell_id && maintenance.source.shard_id === route.shard_id
    && maintenance.source.epoch === route.epoch && maintenance.destination.cell_id === env.CELL_ID && maintenance.destination.shard_id === env.SHARD_ID
    && maintenance.destination.epoch === route.epoch + 1 && (!expected || canonicalJson(expected) === canonicalJson(maintenance)),
  'maintenance_move_changed', 'The restore authority changed after admission.', 409);
  const staged = await one(env.DB, `SELECT 1 FROM move_staging WHERE operation_id=? AND repo_id=? AND source_cell_id=? AND source_shard_id=?
    AND target_shard_id=? AND source_epoch=? AND phase='final' AND state IN ('applying','verified')`, operationId, repoId, route.cell_id, route.shard_id, env.SHARD_ID, route.epoch);
  const repository = await one<Repository>(env.DB, 'SELECT * FROM repositories WHERE id=?', repoId);
  requireValue(staged && repository?.state === 'moving' && repository.cell_id === env.CELL_ID && repository.shard_id === env.SHARD_ID
    && repository.routing_epoch === maintenance.destination.epoch && repository.owner_id === maintenance.account_id
    && repository.visibility === maintenance.repository.visibility && repository.fork_source_id === maintenance.repository.fork_source_id
    && repository.default_branch === maintenance.repository.default_branch && repository.policy_revision === maintenance.repository.policy_revision
    && repository.storage_name === maintenance.repository.storage_name,
  'maintenance_destination_changed', 'Movement must preserve repository ownership, audience, policy and its exact staged epoch.', 409);
  const principal = await one<{ id: string; kind: 'service'; user_id: null }>(identityBinding(env).withSession('first-primary'),
    `SELECT id,kind,user_id FROM principals WHERE id='system:operations' AND kind='service' AND user_id IS NULL AND account_id IS NULL
     AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at>?)`, now());
  requireValue(principal, 'maintenance_actor_inactive', 'The recorded maintenance service is no longer active.', 403);
  return { maintenance, repository, actor: { ...principal, credential_id: null, capabilities: [], repository_ids: [], account_ids: [], mfa: false } };
}

/** A remote restore publisher keeps the source barrier until its terminal receipt is durable. */
export async function requireMovePublisherSettled(env: GitBindings, repoId: string, operationId: string): Promise<void> {
  const control = await one<MoveControl>(identityBinding(env), 'SELECT * FROM repository_move_controls WHERE repo_id=? AND operation_id=?', repoId, operationId);
  const location = await one<{ shard_id: string; cell_id: string }>(identityBinding(env),
    'SELECT cell_id,shard_id FROM git_barrier_routes WHERE repo_id=? AND operation_id=?', repoId, operationId);
  requireValue(!control || location?.cell_id === control.source_cell_id && location.shard_id === control.source_shard_id,
    'move_barrier_unavailable', 'The move requires its original source coordinator ownership record.', 503);
  if (!location || location.cell_id !== env.CELL_ID) return;
  if (!control) {
    const source = gitShardEnvironment(env, location.shard_id);
    requireValue(!await one(source.DB, 'SELECT 1 FROM repository_move_requests WHERE operation_id=? AND repo_id=?', operationId, repoId),
      'move_control_unavailable', 'The original move control is required before releasing its publisher barrier.', 503);
    return;
  }
  if (control.source_cell_id === control.target_cell_id && control.source_storage_name === control.target_storage_name) return;
  if (control.state === 'aborting' || control.state === 'aborted') {
    const placement = await one<{ state: string }>(identityBinding(env), 'SELECT state FROM billing_storage_placements WHERE operation_id=?', operationId);
    requireValue(!placement || placement.state === 'aborted', 'move_storage_unsettled',
      'An unknown provider creation or unfinished physical rollback must retain the source barrier.', 409);
  }
  const publisher = await movePublisherState(env, repoId, { operation_id: operationId, side: 'target', action: 'read' });
  requireValue(publisher.storage_name === control.target_storage_name && publisher.terminal && publisher.finalized,
    'publication_in_progress', 'The destination restore publisher must be reconciled before releasing the source barrier.', 409);
}
