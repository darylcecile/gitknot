import { canonicalJson, internalFetch, limits as platformLimits, now, one, stmt, verifyInternalRequest } from '@gitknot/core';
import { currentRate } from './catalog.ts';
import { invariant } from './errors.ts';
import { maximumCharge, units } from './money.ts';
import { admissionRequest } from './transport.ts';
import { storageFundingWindow, storagePolicy } from './storage-policy.ts';
import { placementDb, placementReceipt, replacesPlacementGit, storagePlacement } from './placement-state.ts';
import { readGitLimits } from '../../git/src/policy.ts';
import { deletePlacementScratch } from './placement-scratch.ts';
import type { BillingBindings } from './types.ts';
import type { CanonicalGitMeter } from './git-types.ts';
import type { PlacementGitCreationProof, PlacementGitHold, PlacementNamespaceCleanup, PlacementPublicationFence, StoragePlacement } from './placement-types.ts';
import { confirmPlacementGitProvision, ownedPlacementNamespace, placementNamespace } from './placement-namespace.ts';
import { placementPublication, recordPlacementPublication } from './placement-publication.ts';
export { beginPlacementGitProvision, placementGitProvisionMarker, confirmPlacementGitProvision, recordPlacementGitProvisionNotStarted } from './placement-namespace.ts';

export interface PlacementGitProof { verified: true; objects_verified: true; refs: Array<{ ref: string; oid: string }> }
export interface PlacementGitBackend {
  exists(storageName: string): Promise<boolean>;
  verify(placement: StoragePlacement, storageName: string, side: 'source' | 'target'): Promise<PlacementGitProof>;
  reconcilePublisher(placement: StoragePlacement, side: 'source' | 'target'): Promise<PlacementPublicationFence>;
  observeCreation(placement: StoragePlacement): Promise<PlacementGitCreationProof | null>;
  delete(storageName: string): Promise<void>;
}

async function gitRpc<T>(env: BillingBindings, p: StoragePlacement, side: 'source' | 'target', action: 'verify' | 'cleanup' | 'reconcile'): Promise<T> {
  const cell = side === 'source' ? p.source_cell_id : p.target_cell_id;
  const names = JSON.parse(String(env.CELL_GIT_BINDINGS_JSON ?? '{}')) as Record<string, string>;
  const service = cell === env.CELL_ID ? env.GIT_SERVICE : env[names[cell]!] as Fetcher | undefined;
  invariant(service?.fetch, 'placement_git_cell_unavailable', 'The declared physical Git cell is not bound.', 503);
  const response = await internalFetch(service, env.INTERNAL_SERVICE_KEY, 'billing.git-placement', '/internal/git/storage-placement', { operation_id: p.operation_id, side, action });
  invariant(response.ok, 'placement_git_unconfirmed', 'The declared physical Git outcome is not verified.', 503);
  return response.json() as Promise<T>;
}

export async function preparePlacementGit(env: BillingBindings, p: StoragePlacement): Promise<void> {
  if (!replacesPlacementGit(p)) return;
  const db = placementDb(env);
  let row = await one<{ body_json: string }>(db, 'SELECT body_json FROM billing_placement_git WHERE operation_id=?', p.operation_id);
  if (!row) {
    const proof = await gitRpc<PlacementGitProof>(env, p, 'source', 'verify');
    invariant(proof.verified && proof.objects_verified && Array.isArray(proof.refs), 'placement_git_source_unverified', 'The live source graph must be verified before reserving its copy.');
    const source = await admissionRequest<CanonicalGitMeter | null>(env, `account:${p.account_id}`, 'git-meter', { repo_id: p.repo_id, storage_name: p.source_storage_name });
    invariant(source || proof.refs.length === 0, 'placement_git_source_unmetered', 'The existing canonical graph needs financial reconciliation before movement.');
    const limits = readGitLimits(env.LIMITS_JSON), policy = storagePolicy(env), at = now();
    const window = storageFundingWindow(at, null, source?.renewal_policy ?? { ...policy, on_renewal_failure: 'notify_block_writes_then_delete' });
    const rates = source?.rates ?? { logical: await currentRate(db, 'git.storage.logical'), peak: await currentRate(db, 'git.storage.daily-peak-bound') };
    // A compressed archive does not bound its inflated graph, and the current live
    // graph need not match that historical snapshot. Fund the receiver's enforced cap.
    const archive = p.purpose === 'archive_restore';
    const graphBytes = archive ? BigInt(p.archive_refs?.length ? Math.min(limits.max_inflated_bytes, limits.max_repository_bytes) : 0) : units(source?.logical_bytes ?? '0');
    const objectCount = archive ? BigInt(p.archive_refs?.length ? limits.max_objects : 0) : units(source?.object_count ?? '0');
    const bound = graphBytes + objectCount * 128n + BigInt(limits.max_metadata_bytes) + 1024n;
    const duration = BigInt(Date.parse(window.commitment_until) - Date.parse(at));
    const days = (duration + 86399999n) / 86400000n + 1n;
    const scratchRate = await currentRate(db, 'storage.blobs');
    const scratchBytes = archive ? p.archive_git_bytes : (bound < BigInt(limits.max_pack_bytes) ? bound : BigInt(limits.max_pack_bytes)).toString();
    invariant(scratchBytes && units(scratchBytes) <= BigInt(limits.max_pack_bytes), 'placement_archive_size', 'The declared archive exceeds the native copy limit.');
    const hold: PlacementGitHold = { operation_id: p.operation_id, account_id: p.account_id, repo_id: p.repo_id, actor_id: p.actor_id,
      storage_name: p.target_storage_name, slice_id: p.target_git_slice_id!, source, rates, bytes: bound.toString(), created_at: at, commitment_until: window.commitment_until,
      maximum_units: (units(maximumCharge((bound * duration).toString(), rates.logical)) + 1n).toString(),
      maximum_platform_units: (units(maximumCharge((bound * days).toString(), rates.peak, true)) + 1n).toString(),
      scratch_rate: scratchRate, scratch_bytes: scratchBytes, scratch_platform_units: maximumCharge((units(scratchBytes) * duration).toString(), scratchRate, true),
      repository_limit_bytes: String(platformLimits(env).repository_storage_bytes), state: 'reserved' };
    await db.prepare(`INSERT OR IGNORE INTO billing_placement_git(operation_id,body_json,source_verified_json)
      SELECT operation_id,?,? FROM billing_storage_placements WHERE operation_id=? AND state='preparing'`)
      .bind(JSON.stringify(hold), canonicalJson(proof), p.operation_id).run();
    row = await one<{ body_json: string }>(db, 'SELECT body_json FROM billing_placement_git WHERE operation_id=?', p.operation_id);
    invariant(row, 'placement_fenced', 'The physical placement closed before its canonical funding intent was recorded.');
  }
  const hold = JSON.parse(row.body_json) as PlacementGitHold;
  if (hold.source) {
    await admissionRequest(env, `account:${p.account_id}`, 'placement-git-source', { operation_id: p.operation_id });
    await admissionRequest(env, `capacity:${hold.source.slice_id}`, 'placement-git-source', { operation_id: p.operation_id });
  }
  await admissionRequest(env, `account:${p.account_id}`, 'placement-git-reserve', { operation_id: p.operation_id });
  await admissionRequest(env, `capacity:${p.target_git_slice_id}`, 'placement-git-reserve', { operation_id: p.operation_id });
}

export async function verifyPlacementGit(env: BillingBindings, p: StoragePlacement): Promise<void> {
  if (!replacesPlacementGit(p)) return;
  invariant(!await one(placementDb(env), "SELECT 1 FROM billing_placement_scratch WHERE operation_id=? AND state<>'deleted'", p.operation_id),
    'placement_scratch_pending', 'The scratch writer must finish and confirm cleanup before activation.');
  const proof = await gitRpc<PlacementGitProof>(env, p, 'target', 'verify');
  const row = await one<{ source_verified_json: string; body_json: string }>(placementDb(env), 'SELECT source_verified_json,body_json FROM billing_placement_git WHERE operation_id=?', p.operation_id);
  const expected = p.purpose === 'archive_restore' ? p.archive_refs : row ? JSON.parse(row.source_verified_json).refs : null;
  invariant(row && expected && proof.verified && proof.objects_verified && canonicalJson(proof.refs) === canonicalJson(expected),
    'placement_git_refs_changed', 'The verified destination must match the immutable move or archive ref inventory.');
  await placementDb(env).prepare('UPDATE billing_placement_git SET target_verified_json=? WHERE operation_id=? AND target_verified_json IS NULL').bind(canonicalJson(proof), p.operation_id).run();
  if (!await one(placementDb(env), 'SELECT 1 FROM billing_placement_scratch WHERE operation_id=?', p.operation_id)) {
    await placementReceipt(env, p.operation_id, 'scratch-unused', { fence: p.fence });
    await admissionRequest(env, `account:${p.account_id}`, 'placement-git-scratch', { operation_id: p.operation_id });
    await admissionRequest(env, `capacity:${p.target_git_slice_id}`, 'placement-git-scratch', { operation_id: p.operation_id });
  }
  if (!proof.refs.length) {
    await admissionRequest(env, `account:${p.account_id}`, 'placement-git-empty', { operation_id: p.operation_id });
    await admissionRequest(env, `capacity:${p.target_git_slice_id}`, 'placement-git-empty', { operation_id: p.operation_id });
  }
}

export async function finishPlacementGit(env: BillingBindings, p: StoragePlacement, phase: 'switch' | 'cleanup' | 'abort'): Promise<void> {
  if (!replacesPlacementGit(p)) return;
  const row = await one<{ body_json: string; target_verified_json: string | null }>(placementDb(env), 'SELECT body_json,target_verified_json FROM billing_placement_git WHERE operation_id=?', p.operation_id);
  if (!row) return;
  const hold = JSON.parse(row.body_json) as PlacementGitHold, payload = { operation_id: p.operation_id };
  if (phase === 'switch') {
    await admissionRequest(env, `account:${p.account_id}`, 'placement-git-switch', payload);
    await admissionRequest(env, `capacity:${p.target_git_slice_id}`, 'placement-git-switch', payload);
    if (hold.source) await admissionRequest(env, `capacity:${hold.source.slice_id}`, 'placement-git-switch', payload);
    return;
  }
  const side = phase === 'cleanup' ? 'source' : 'target';
  await gitRpc(env, p, side, 'cleanup');
  await admissionRequest(env, `account:${p.account_id}`, phase === 'cleanup' ? 'placement-git-cleanup' : 'placement-git-abort', payload);
  const slice = phase === 'cleanup' ? hold.source?.slice_id : p.target_git_slice_id;
  if (slice) await admissionRequest(env, `capacity:${slice}`, phase === 'cleanup' ? 'placement-git-cleanup' : 'placement-git-abort', payload);
  await admissionRequest(env, `account:${p.account_id}`, phase === 'cleanup' ? 'placement-git-target-release' : 'placement-git-source-release', payload);
  const releaseSlice = phase === 'cleanup' ? p.target_git_slice_id : hold.source?.slice_id;
  if (releaseSlice) await admissionRequest(env, `capacity:${releaseSlice}`, phase === 'cleanup' ? 'placement-git-target-release' : 'placement-git-source-release', payload);
}

/** This precedes ALL rollback deletion, including operations interrupted before a Git hold was created. */
export async function reconcilePlacementAbort(env: BillingBindings, p: StoragePlacement): Promise<void> {
  if (!replacesPlacementGit(p)) return;
  await gitRpc(env, p, 'target', 'reconcile');
  invariant(await placementPublication(env, p, 'target'), 'placement_publication_pending', 'The original target publisher is not positively closed.', 503);
}

export async function handlePlacementGitRequest(request: Request, env: BillingBindings, backend: PlacementGitBackend): Promise<Response> {
  await verifyInternalRequest(request, env.INTERNAL_SERVICE_KEY, 'billing.git-placement');
  const input = await request.json() as { operation_id: string; side: 'source' | 'target'; action: 'verify' | 'cleanup' | 'reconcile' };
  invariant(['source','target'].includes(input.side) && ['verify','cleanup','reconcile'].includes(input.action), 'placement_git_request', 'Invalid physical Git operation.', 422);
  const p = await storagePlacement(env, input.operation_id), source = input.side === 'source';
  invariant(env.CELL_ID === (source ? p.source_cell_id : p.target_cell_id), 'placement_git_cell', 'This request belongs to the recorded physical Git cell.');
  const name = source ? p.source_storage_name : p.target_storage_name;
  if (input.action === 'verify') {
    invariant(['preparing','prepared','committing'].includes(p.state), 'placement_git_fenced', 'Git verification is outside the physical handoff.');
    if (!source) await ownedPlacementNamespace(env, p);
    return Response.json(await backend.verify(p, name, input.side));
  }
  invariant(source ? ['active','complete'].includes(p.state) : ['aborting','aborted'].includes(p.state),
    'placement_git_cleanup_fenced', 'Publisher closure requires a recorded abort or committed cutover.');
  const terminal = await placementPublication(env, p, input.side)
    ?? await recordPlacementPublication(env, p, input.side, await backend.reconcilePublisher(p, input.side));
  if (input.action === 'reconcile') {
    if (!source && !await one(placementDb(env), "SELECT 1 FROM billing_placement_namespace_cleanup WHERE operation_id=? AND side='target'", p.operation_id)) {
      await targetNamespaceUnallocated(env, p, backend, terminal);
    }
    return Response.json(terminal);
  }
  invariant(replacesPlacementGit(p), 'placement_namespace_in_use', 'Metadata-only movement does not retire the shared canonical namespace.');
  invariant(source || p.state === 'aborting' || p.state === 'aborted', 'placement_git_cleanup_fenced', 'The committed destination cannot be deleted as an aborted copy.');
  // The source native hook validates its local writer and the destination's terminal
  // journal. Closing the active destination namespace here would fence future work.
  return Response.json(await cleanupNamespace(env, p, input.side, backend, terminal));
}

async function cleanupNamespace(env: BillingBindings, p: StoragePlacement, side: 'source' | 'target', backend: PlacementGitBackend,
  terminal: PlacementPublicationFence): Promise<PlacementNamespaceCleanup> {
  const db = placementDb(env), source = side === 'source', name = source ? p.source_storage_name : p.target_storage_name;
  const previous = await one<{ receipt_json: string }>(db, 'SELECT receipt_json FROM billing_placement_namespace_cleanup WHERE operation_id=? AND side=?', p.operation_id, side);
  if (previous) return JSON.parse(previous.receipt_json) as PlacementNamespaceCleanup;
  let claim = await placementNamespace(env, p, side);
  const unallocated = !source && await targetNamespaceUnallocated(env, p, backend, terminal);
  if (source) {
    const hold = await one<{ body_json: string; source_verified_json: string | null }>(db, 'SELECT body_json,source_verified_json FROM billing_placement_git WHERE operation_id=?', p.operation_id);
    const meter = hold ? (JSON.parse(hold.body_json) as PlacementGitHold).source : null;
    invariant(hold?.source_verified_json && (!claim || claim.repo_id === p.repo_id && claim.account_id === p.account_id)
      && (!meter || meter.repo_id === p.repo_id && meter.account_id === p.account_id && meter.storage_name === name),
    'placement_namespace_owner_mismatch', 'Source cleanup requires its original current-owner evidence.');
  } else if (!unallocated) {
    claim = await ownedPlacementNamespace(env, p);
  }
  if (!source) await deletePlacementScratch(env, p.operation_id);
  const exists = await backend.exists(name);
  if (!unallocated && exists) await backend.delete(name);
  if (!unallocated) invariant(!await backend.exists(name), 'placement_git_cleanup_unconfirmed', 'The original owned provider namespace still exists.', 503);
  const at = now();
  const receipt: PlacementNamespaceCleanup = { version: 1, operation_id: p.operation_id, repo_id: p.repo_id, storage_name: name,
    placement_fence: p.fence, side, outcome: unallocated ? 'unallocated' : 'deleted', observed_at: at, existed: !unallocated && (exists || !!claim?.owned_at) };
  const statements = [stmt(db, 'INSERT OR IGNORE INTO billing_placement_namespace_cleanup(operation_id,side,receipt_json,recorded_at) VALUES (?,?,?,?)', p.operation_id, side, canonicalJson(receipt), at)];
  if (!unallocated) statements.push(
    stmt(db, `UPDATE billing_placement_git SET ${source ? 'source_deleted_at' : 'target_deleted_at'}=? WHERE operation_id=? AND ${source ? 'source_deleted_at' : 'target_deleted_at'} IS NULL`, at, p.operation_id),
    stmt(db, "UPDATE billing_placement_namespaces SET state='deleted',deleted_at=COALESCE(deleted_at,?) WHERE cell_id=? AND storage_name=? AND repo_id=? AND account_id=? AND state='owned'", at, env.CELL_ID, name, p.repo_id, p.account_id));
  await db.batch(statements);
  const saved = await one<{ receipt_json: string }>(db, 'SELECT receipt_json FROM billing_placement_namespace_cleanup WHERE operation_id=? AND side=?', p.operation_id, side);
  invariant(saved, 'placement_cleanup_receipt_missing', 'The confirmed namespace cleanup receipt was not retained.', 503);
  return JSON.parse(saved.receipt_json) as PlacementNamespaceCleanup;
}

async function targetNamespaceUnallocated(env: BillingBindings, p: StoragePlacement, backend: PlacementGitBackend,
  terminal: PlacementPublicationFence): Promise<boolean> {
  const claim = await placementNamespace(env, p, 'target');
  if (!claim || claim.operation_id !== p.operation_id) {
    const issued = await one(placementDb(env), "SELECT 1 FROM billing_placement_receipts WHERE operation_id=? AND step='git-provision'", p.operation_id);
    invariant(!issued && terminal.state === 'not_started', 'placement_namespace_owner_mismatch', 'This operation has no positive ownership of the target namespace.');
    return true;
  }
  if (claim.state === 'not_started') {
    invariant(claim.repo_id === p.repo_id && claim.account_id === p.account_id && claim.placement_fence === p.fence
      && claim.not_started_at && terminal.state === 'not_started', 'placement_namespace_owner_mismatch', 'The refused provider creation is not a closed unallocated placement.');
    return true;
  }
  const proof = await backend.observeCreation(p);
  if (proof) await confirmPlacementGitProvision(env, p.operation_id, p.target_storage_name, proof);
  else {
    // A completed owned create can be observed absent after a lost deletion reply.
    // An issued-but-unproved create remains unknown whether the name exists or not.
    await ownedPlacementNamespace(env, p);
    invariant(!await backend.exists(p.target_storage_name), 'placement_namespace_unconfirmed', 'The provider namespace has no matching creation evidence.', 503);
  }
  return false;
}
