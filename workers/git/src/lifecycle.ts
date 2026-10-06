import { authorize, getRepository, identityBinding, many, now, one, sha256, signInternalRequest } from '@gitknot/core';
import type { AppContext, Principal, Repository } from '@gitknot/core';
import { GIT_COORDINATOR_SCOPE } from '../../../packages/git/src/types.ts';
import type { GitMaintenanceMove, GitOperation, GitPolicy, GitRepositoryContext, GitRestoreContext } from '../../../packages/git/src/types.ts';
import { GitError, requireValue } from '../../../packages/git/src/errors.ts';
import { digestJson, boundedJson, reviewRefs } from '../../../packages/git/src/protocol.ts';
import { readGitLimits, validateOid, validateRef } from '../../../packages/git/src/policy.ts';
import { currentActor, publicationPolicy } from './policy.ts';
import { artifacts } from './storage.ts';
import { createNativeSession, nativeAction, nativeJson } from './native.ts';
import type { GitBindings } from './types.ts';
import { requireMaintenanceAuthority } from '../../../packages/operations/src/maintenance-authority.ts';
import { gitPlacement } from './placement.ts';
import { maintenanceRestoreAuthority } from './maintenance.ts';
import { beginPlacementGitProvision, confirmPlacementGitProvision, placementGitProvisionMarker, recordPlacementGitProvisionNotStarted } from '../../../packages/billing/src/placement-namespace.ts';
import { beginPlacementScratch, confirmPlacementScratch, deletePlacementScratch } from '../../../packages/billing/src/placement-scratch.ts';
import { placementStorageName, storagePlacement } from '../../../packages/billing/src/placement-state.ts';
import { moveControl } from '../../../packages/operations/src/move-control.ts';
import { moveRestoreAuthority } from './move-authority.ts';

interface LifecycleOperation { id: string; repo_id: string; actor_id: string; kind: string; status: string; input_json: string }

export async function lifecycleOperation(env: GitBindings, repoId: string, id: string, kinds: string[]): Promise<LifecycleOperation> {
  const operation = await one<LifecycleOperation>(env.DB.withSession('first-primary'), 'SELECT * FROM operations WHERE id=? AND repo_id=?', id, repoId);
  requireValue(operation && kinds.includes(operation.kind.replace(/^repository\./u, '')) && operation.status !== 'cancelled', 'lifecycle_operation', 'This Git request is not associated with an authorized repository operation.', 403);
  return operation;
}

export async function lifecycleRepository(c: AppContext, repoId: string, id: string, kind: 'import' | 'fork' | 'restore'): Promise<Repository> {
  const env = c.env as GitBindings;
  const operation = await lifecycleOperation(env, repoId, id, kind === 'restore' ? ['restore', 'move'] : [kind]);
  const actor = c.get('principal');
  requireValue(actor?.id === operation.actor_id, 'lifecycle_actor', 'The Git publication actor does not own this repository operation.', 403);
  const repository = await one<Repository>(env.DB, 'SELECT * FROM repositories WHERE id=?', repoId);
  requireValue(repository, 'not_found', 'Repository not found.', 404);
  if (kind === 'restore') {
    const capability = operation.kind.endsWith('.move') ? 'repositories.manage' : 'repositories.restore';
    const explanation = await (await import('@gitknot/core')).explainAuthorization(c, capability, { repo_id: repoId });
    requireValue(explanation.allowed || repository.state === 'moving' && explanation.reasons.every(reason => reason.code === 'repository_unavailable'),
      'restore_denied', 'Repository restoration is no longer authorized.', 403);
  } else {
    requireValue(repository.state === 'provisioning' || repository.state === 'active', 'lifecycle_state', 'The repository is not accepting an import.', 409);
    await authorize(c, 'repositories.create', { account_id: repository.owner_id });
    const lifecycle = await one<{ created_by: string; state: string }>(env.DB, 'SELECT created_by,state FROM repository_lifecycle WHERE operation_id=? AND repo_id=? AND kind=?', id, repoId, kind);
    requireValue(lifecycle && lifecycle.created_by === actor.id && ['queued', 'running', 'waiting'].includes(lifecycle.state), 'lifecycle_state', 'The repository import is not active.', 409);
  }
  return repository;
}

export async function retainedRefs(c: AppContext, repoId: string): Promise<string[]> {
  const inventory = await retainedRefInventory(c.env as GitBindings, repoId);
  for (const source of new Set(inventory.map(entry => entry.source_repo_id))) await getRepository(c, source);
  return inventory.map(entry => entry.ref);
}

async function retainedRefInventory(env: GitBindings, repoId: string): Promise<{ ref: string; source_repo_id: string }[]> {
  const rows = await many<{ source_repo_id: string; internal_ref: string }>(env.DB,
    'SELECT source_repo_id,internal_ref FROM git_candidates WHERE repo_id=? AND candidate_oid IS NOT NULL ORDER BY internal_ref', repoId);
  const reviews = await many<{ id: string; source_repo_id: string }>(env.DB, "SELECT id,source_repo_id FROM git_review_snapshots WHERE repo_id=? AND state='ready' ORDER BY id", repoId);
  return [...rows.map(row => ({ ref: row.internal_ref, source_repo_id: row.source_repo_id })),
    ...reviews.flatMap(review => reviewRefs(review.id).map(ref => ({ ref, source_repo_id: review.source_repo_id })))];
}

/** Private backup/move duty is a durable purpose grant, never an anonymous export permission. */
export async function exportMaintenanceGit(env: GitBindings, repoId: string, body: Record<string, unknown>): Promise<Response> {
  requireValue(typeof body.operation_id === 'string' && body.include_retained_refs === true,
    'maintenance_export_scope', 'Maintenance exports require their operation and full retained-ref inventory.', 403);
  const operation = await lifecycleOperation(env, repoId, body.operation_id, ['backup', 'move']);
  const purpose = operation.kind === 'repository.backup' ? 'repository.backup' : 'repository.move';
  const token = body.barrier_token ?? `${purpose === 'repository.move' ? 'move' : 'lifecycle'}_${operation.id}`;
  requireValue(typeof token === 'string', 'maintenance_export_scope', 'A maintenance barrier token is required.', 403);
  const authority = await requireMaintenanceAuthority(env, repoId, operation.id, purpose, token);
  const placement = await gitPlacement(env, repoId);
  requireValue(placement.cell_id === env.CELL_ID && placement.shard_id === env.SHARD_ID && placement.epoch === authority.routing_epoch
    && (placement.state === 'active' || placement.state === 'fenced' && placement.operation_id === operation.id),
  'maintenance_placement_changed', 'The maintenance operation no longer owns this repository placement.', 409);
  const held = await nativeJson<{ held: boolean; operation_id: string }>(await coordinator(env, repoId, '/barrier/check', { operation_id: operation.id, token }));
  requireValue(held.held && held.operation_id === operation.id, 'maintenance_barrier_required', 'The repository maintenance barrier is not held.', 409);
  const repository = await one<Repository>(env.DB, 'SELECT * FROM repositories WHERE id=?', repoId);
  requireValue(repository && repository.owner_id === authority.account_id && repository.routing_epoch === authority.routing_epoch,
    'maintenance_placement_changed', 'Repository ownership changed during maintenance export.', 409);
  const retained = (await retainedRefInventory(env, repoId)).map(entry => entry.ref);
  const session = await createNativeSession(env, { repository: repositoryContext(repository), policy: readPolicy(env), mode: 'read',
    remote: await artifacts(env).access(repository.storage_name, 'read'), retained_refs: retained });
  return nativeAction(session, 'bundle');
}

export async function verifyLifecycleGit(c: AppContext, env: GitBindings, repoId: string, body: Record<string, unknown>): Promise<Response> {
  await lifecycleOperation(env, repoId, String(body.operation_id), ['provision', 'import', 'fork', 'export', 'backup', 'delete', 'restore', 'move']);
  const repository = await one<Repository>(env.DB, 'SELECT * FROM repositories WHERE id=?', repoId);
  requireValue(repository, 'not_found', 'Repository not found.', 404);
  // This read-back endpoint is a scoped operations service receipt, not a customer code read.
  // It remains usable after the lifecycle worker intentionally revokes the original credential.
  const refs = await retainedRefInventory(env, repoId);
  const session = await createNativeSession(env, { repository: repositoryContext(repository), policy: readPolicy(env), mode: 'read',
    remote: await artifacts(env).access(repository.storage_name, 'read'), retained_refs: refs.map(row => row.ref) });
  return nativeAction(session, 'verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected_refs: body.expected_refs }) });
}

export async function purgeLifecycleGit(env: GitBindings, repoId: string, body: Record<string, unknown>): Promise<Response> {
  await lifecycleOperation(env, repoId, String(body.operation_id), ['purge']);
  const repository = await one<Repository>(env.DB, 'SELECT * FROM repositories WHERE id=?', repoId);
  requireValue(repository && repository.state === 'deleted' && repository.recovery_until && repository.recovery_until <= now()
    && body.storage_name === repository.storage_name && Array.isArray(body.retained_refs) && body.retained_refs.length === 0,
  'purge_denied', 'Repository retention does not permit this storage deletion.', 409);
  const pin = await one(env.DB, `SELECT 1 FROM repository_retention_pins WHERE source_repo_id=? AND (expires_at IS NULL OR expires_at>?)
    UNION ALL SELECT 1 FROM repositories WHERE fork_source_id=? AND state<>'deleted'
    UNION ALL SELECT 1 FROM git_candidates c JOIN repositories r ON r.id=c.repo_id
      WHERE c.source_repo_id=? AND c.repo_id<>? AND c.state IN ('ready','published') AND r.state<>'deleted'
    UNION ALL SELECT 1 FROM pull_patches p JOIN repositories r ON r.id=p.repo_id
      WHERE p.head_repo_id=? AND p.repo_id<>? AND r.state<>'deleted' LIMIT 1`, repoId, now(), repoId, repoId, repoId, repoId, repoId);
  requireValue(!pin, 'retention_pinned', 'Repository objects still have retained fork or review references.', 409);
  const store = artifacts(env);
  try { await store.remote(repository.storage_name); }
  catch (error) { if (error instanceof Error && 'status' in error && error.status === 404) return Response.json({ deleted: true, verified: true }); throw error; }
  await store.delete(repository.storage_name);
  try { await store.remote(repository.storage_name); }
  catch (error) { if (error instanceof Error && 'status' in error && error.status === 404) return Response.json({ deleted: true, verified: true }); throw error; }
  requireValue(false, 'purge_pending', 'Canonical Git storage deletion is still pending confirmation.', 503);
}

interface RestoreManifest { archive_id: string; repository: { id: string }; git: { bytes: number; sha256: string; refs: Array<{ ref: string; oid: string }> } }

export async function restoreLifecycleGit(c: AppContext, env: GitBindings): Promise<Response> {
  const url = new URL(c.req.url);
  const repoId = /^\/internal\/git\/repositories\/([\w-]+)\/restore$/u.exec(url.pathname)?.[1];
  const id = url.searchParams.get('operation_id');
  requireValue(repoId && id && c.req.method === 'POST' && c.req.raw.body, 'invalid_restore', 'A scoped streamed Git restore is required.');
  const operation = await lifecycleOperation(env, repoId, id, ['restore', 'move']);
  const archiveId = url.searchParams.get('archive_id');
  requireValue(archiveId, 'archive_not_found', 'A verified restore archive is required.', 400);
  const saved = JSON.parse(operation.input_json) as { principal?: Principal; actor?: Principal };
  const maintenance = operation.kind === 'repository.move' && operation.actor_id === 'system:operations'
    ? await maintenanceRestoreAuthority(env, repoId, id, archiveId) : undefined;
  const actor = maintenance?.actor ?? await currentActor(env, saved.principal ?? saved.actor!);
  c.set('principal', actor);
  const repository = maintenance?.repository ?? await lifecycleRepository(c, repoId, id, 'restore');
  const target = operation.kind === 'repository.move' ? (await moveControl(env, id)).target_storage_name : await placementStorageName(repoId, id);
  requireValue(url.searchParams.get('storage_name') === target && repository.storage_name !== target, 'restore_target', 'Restoration requires the operation\'s fresh storage target.', 409);
  const archive = await one<{ manifest_key: string; manifest_sha256: string }>(env.DB,
    "SELECT manifest_key,manifest_sha256 FROM repository_archives WHERE id=? AND repo_id=? AND state='verified' AND expires_at>?", archiveId, repoId, now());
  requireValue(archive, 'archive_not_found', 'Verified repository archive not found.', 404);
  requireValue(!maintenance || archive.manifest_sha256 === maintenance.maintenance.manifest_sha256,
    'maintenance_archive_unverified', 'The destination archive differs from the verified move source.', 409);
  const object = await env.BACKUPS.get(archive.manifest_key);
  requireValue(object && object.size <= 8 * 1024 * 1024, 'archive_invalid', 'Repository archive manifest is unavailable.', 503);
  const bytes = new Uint8Array(await object.arrayBuffer());
  requireValue(await sha256(bytes) === archive.manifest_sha256, 'archive_checksum', 'Repository archive manifest checksum does not match.', 503);
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as RestoreManifest;
  const limits = readGitLimits(env.LIMITS_JSON);
  requireValue(manifest.repository.id === repoId && manifest.archive_id === archiveId && manifest.git.sha256 === c.req.header('x-gitknot-content-sha256')
    && Number.isSafeInteger(manifest.git.bytes) && manifest.git.bytes >= 0 && manifest.git.bytes <= limits.max_pack_bytes
    && Array.isArray(manifest.git.refs) && manifest.git.refs.length <= limits.max_refs,
  'archive_scope', 'Restore bytes, quota, or repository scope do not match the verified manifest.');
  for (const ref of manifest.git.refs) { validateRef(ref.ref, true); validateOid(ref.oid, false); }
  const restore: GitRestoreContext = { archive_id: archiveId, bundle_sha256: manifest.git.sha256, bundle_bytes: manifest.git.bytes, expected_refs: manifest.git.refs };
  const move = await moveRestoreAuthority(env, repository, id, actor, restore);
  const scratch = await beginPlacementScratch(env, { operation_id: id, bytes: String(manifest.git.bytes), checksum: manifest.git.sha256 });
  if (operation.kind === 'repository.move') requireValue(scratch, 'move_physical_billing_handoff_unconfirmed', 'The move requires a funded physical placement before staging bytes.', 503);
  const key = scratch?.key ?? `git-restore/${repoId}/${id}/${crypto.randomUUID()}`;
  const fixed = new FixedLengthStream(manifest.git.bytes);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), limits.max_work_ms);
  const copied = scratch && !scratch.write ? c.req.raw.body.cancel() : c.req.raw.body.pipeTo(fixed.writable, { signal: controller.signal });
  void copied.catch(() => {});
  try {
    // R2 verifies the signed digest while streaming; no canonical effect precedes verification.
    if (!scratch || scratch.write) await env.BLOBS.put(key, fixed.readable, { sha256: manifest.git.sha256,
      ...(scratch ? { onlyIf: { etagDoesNotMatch: '*' } } : {}), customMetadata: { repo_id: repoId, operation_id: id, ...(scratch ? { billing_placement_scratch: id } : {}) } });
    await copied;
    if (scratch) await confirmPlacementScratch(env, id);
    if (maintenance) await maintenanceRestoreAuthority(env, repoId, id, archiveId, maintenance.maintenance);
    if (move) await moveRestoreAuthority(env, repository, id, maintenance?.actor ?? await currentActor(env, actor), restore, move);
    await provisionRestoreStore(env, id, target, repository.default_branch);
    const context = { ...repositoryContext(repository), storage_name: target };
    const policy = await publicationPolicy(c, repository, maintenance?.maintenance);
    if (restore.expected_refs.length) await publishRestore(env, context, policy, maintenance ? undefined : actor, id, restore, key, maintenance?.maintenance);
    const native = await createNativeSession(env, { repository: context, policy: readPolicy(env), remote: await artifacts(env).access(target, 'read'), mode: 'read',
      retained_refs: restore.expected_refs.filter(ref => ref.ref.startsWith('refs/gitknot/')).map(ref => ref.ref) });
    const response = await nativeAction(native, 'verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected_refs: manifest.git.refs }) });
    if (scratch && !restore.expected_refs.length) {
      const proof = await nativeJson<{ verified: boolean; objects_verified: boolean }>(response.clone());
      requireValue(proof.verified && proof.objects_verified, 'restore_unverified', 'The empty restore requires a definitive native verification.', 503);
      await deletePlacementScratch(env, id);
    }
    return response;
  } finally {
    clearTimeout(timeout); controller.abort(); await copied.catch(() => {});
    // A provider create or publisher can outlive its response. The original funded
    // scratch generation survives until journal finalization or fenced rollback.
    if (!scratch) await env.BLOBS.delete(key);
  }
}

async function provisionRestoreStore(env: GitBindings, id: string, target: string, defaultBranch: string): Promise<void> {
  const store = artifacts(env);
  const exists = async () => {
    try { await store.remote(target); return true; }
    catch (error) { if (error instanceof Error && 'status' in error && error.status === 404) return false; throw error; }
  };
  const provision = await beginPlacementGitProvision(env, id, target, exists);
  if (provision === null) { await store.provision(target, defaultBranch); return; }
  const marker = await placementGitProvisionMarker(env, id, target);
  let proof;
  try {
    proof = provision ? await store.provision(target, defaultBranch, { create_only: true, ownership_marker: marker }) : await store.observeCreation(target);
  } catch (error) {
    if (provision === true && error instanceof GitError && error.code === 'storage_namespace_exists' && error.status === 409
      && (error.cause as { proof?: string } | undefined)?.proof === 'not_started') {
      await recordPlacementGitProvisionNotStarted(env, id, target);
    }
    throw error;
  }
  requireValue(proof, 'storage_creation_unverified', 'The original provider creation has no positive operation-bound receipt.', 503);
  await confirmPlacementGitProvision(env, id, target, proof);
}

export async function finishRestoreScratch(env: GitBindings, operation: GitOperation): Promise<void> {
  requireValue(operation.kind === 'restore' && ['committed', 'rejected'].includes(operation.state),
    'publication_uncertain', 'Restore scratch cannot be released before a definitive publication outcome.', 409);
  const row = await one(identityBinding(env), 'SELECT 1 FROM billing_placement_scratch WHERE operation_id=?', operation.id);
  if (!row) return;
  const placement = await storagePlacement(env, operation.id);
  requireValue(placement.repo_id === operation.repo_id && placement.account_id === operation.repository.owner_id
    && placement.target_cell_id === env.CELL_ID && placement.target_storage_name === operation.repository.storage_name,
  'restore_scratch_scope', 'Scratch cleanup must retain its original physical placement.', 409);
  await deletePlacementScratch(env, operation.id);
}

async function publishRestore(env: GitBindings, repository: GitRepositoryContext, policy: GitPolicy, actor: Principal | undefined, id: string, restore: GitRestoreContext, key: string, maintenance?: GitMaintenanceMove): Promise<void> {
  const path = `/operations/${id}`;
  const prior = await coordinator(env, repository.id, path);
  if (prior.ok) {
    const operation = await boundedJson<{ state: string; finalized: boolean }>(prior);
    requireValue(operation.state === 'committed' && operation.finalized, 'restore_reconciling', 'The previous restore publisher must be reconciled before retrying.', 409);
    return;
  }
  requireValue(prior.status === 404, 'coordinator_unavailable', 'Restore coordination is unavailable.', 503);
  const publisher = `pub_${crypto.randomUUID().replaceAll('-', '')}`;
  const fence = crypto.randomUUID() + crypto.randomUUID();
  const barrier = (await lifecycleOperation(env, repository.id, id, ['restore', 'move'])).kind.endsWith('.move') ? `move_${id}` : `lifecycle_${id}`;
  const source = await env.BLOBS.get(key);
  requireValue(source, 'restore_upload_missing', 'Verified restore bytes are unavailable.', 503);
  await nativeJson(await coordinator(env, repository.id, '/begin', { repo_id: repository.id, operation_id: id, actor, kind: 'restore',
    publisher_id: publisher, fence, storage_name: repository.storage_name, restore, barrier_token: barrier, request_digest: await digestJson(restore) }));
  const native = await createNativeSession(env, { repository, policy, remote: await artifacts(env).access(repository.storage_name, 'read'), mode: 'mutate',
    operation_id: id, publisher_id: publisher, fence, actor_id: actor?.id ?? maintenance!.actor_id, kind: 'restore', restore,
    callback_url: `${env.GIT_ORIGIN}/internal/git/native/${repository.id}/${id}` });
  await nativeJson(await nativeAction(native, 'restore', { method: 'POST', body: source.body, headers: { 'content-type': 'application/x-git-bundle' } }));
}

async function coordinator(env: GitBindings, repoId: string, path: string, payload?: unknown): Promise<Response> {
  const request = new Request(`https://coordinator.gitknot.internal${path}?repo_id=${encodeURIComponent(repoId)}`, {
    method: payload === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repoId)).fetch(await signInternalRequest(request, env.INTERNAL_SERVICE_KEY, GIT_COORDINATOR_SCOPE));
}

export function repositoryContext(repository: Repository): GitRepositoryContext {
  const { id, owner_id, storage_name, default_branch, policy_revision, routing_epoch } = repository;
  return { id, owner_id, storage_name, default_branch, policy_revision, routing_epoch };
}

export function readPolicy(env: GitBindings): GitPolicy {
  return { revision: 0, rules: [], signatures: { ssh_signers: [], openpgp_keys: [], openpgp_fingerprints: [] }, limits: readGitLimits(env.LIMITS_JSON) };
}
