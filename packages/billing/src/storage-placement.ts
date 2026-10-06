import { limits, many, now, sha256, stmt } from '@gitknot/core';
import { z } from 'zod';
import { admissionRequest } from './transport.ts';
import { headStorageObject } from './physical-storage.ts';
import { invariant } from './errors.ts';
import { storageFundingWindow, storagePolicy } from './storage-policy.ts';
import { assertPlacementRoute, localPlacementAuthority, placementCopy, placementDb, placementIdentity, placementParticipants, placementReceipt, placementRpc, placementStorageName, saveCopy, savePlacement, storagePlacement } from './placement-state.ts';
import { finishPlacementGit, preparePlacementGit, reconcilePlacementAbort, verifyPlacementGit } from './placement-git.ts';
import type { BillingBindings, StorageObject } from './types.ts';
import type { PlacementAuthority } from './placement-state.ts';
import type { PlacementCopy, PlacementProgress, StoragePlacement, StoragePlacementInput } from './placement-types.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const inputSchema = z.object({ operation_id: id, repo_id: id, source_cell_id: id, source_shard_id: id,
  target_cell_id: id, target_shard_id: id, source_epoch: z.number().int().positive() }).strict();
const progress = (p: StoragePlacement, processed: number, remaining: boolean): PlacementProgress => ({ operation_id: p.operation_id, state: p.state, processed, remaining, fence: p.fence });
const account = (p: StoragePlacement) => `account:${p.account_id}`;
const payload = (p: StoragePlacement, c: PlacementCopy) => ({ operation_id: p.operation_id, object_id: c.object_id });

async function copies(env: BillingBindings, p: StoragePlacement, states: string[]): Promise<PlacementCopy[]> {
  const rows = await many<{ body_json: string }>(placementDb(env), `SELECT body_json FROM billing_placement_copies WHERE operation_id=?
    AND state IN (SELECT value FROM json_each(?)) ORDER BY object_id LIMIT 32`, p.operation_id, JSON.stringify(states));
  return rows.map(row => JSON.parse(row.body_json) as PlacementCopy);
}

export async function prepareRepositoryStoragePlacement(env: BillingBindings, raw: StoragePlacementInput): Promise<PlacementProgress> {
  const input = inputSchema.parse(raw), db = placementDb(env), identity = await placementIdentity(input);
  let old = await db.prepare('SELECT body_json FROM billing_storage_placements WHERE operation_id=?').bind(input.operation_id).first<{ body_json: string }>();
  if (!old) {
    const authority: PlacementAuthority = env.CELL_ID === input.source_cell_id ? await localPlacementAuthority(env, input)
      : await placementRpc(env, input.source_cell_id, 'authority', input);
    const newGit = input.source_cell_id !== input.target_cell_id || authority.purpose === 'archive_restore';
    const config = !newGit ? { cell_id: input.target_cell_id, slice_id: null, git_slice_id: null }
      : await placementRpc<{ cell_id: string; slice_id: string; git_slice_id: string }>(env, input.target_cell_id, 'configuration', {});
    invariant(config.cell_id === input.target_cell_id, 'placement_configuration_changed', 'The destination physical configuration changed.');
    const p: StoragePlacement = { ...input, ...identity, account_id: authority.account_id, actor_id: authority.actor_id,
      target_epoch: input.source_epoch + 1, target_slice_id: config.slice_id, target_git_slice_id: config.git_slice_id,
      source_storage_name: authority.storage_name, target_storage_name: newGit ? await placementStorageName(input.repo_id, input.operation_id) : authority.storage_name,
      purpose: authority.purpose, archive_id: authority.archive_id, archive_manifest_sha256: authority.archive_manifest_sha256,
      archive_refs: authority.archive_refs, archive_git_bytes: authority.archive_git_bytes,
      state: 'preparing', effective_at: null, created_at: now(), revision: 1 };
    await db.prepare('INSERT OR IGNORE INTO billing_storage_placements(operation_id,repo_id,account_id,state,request_hash,body_json,revision) VALUES (?,?,?,?,?,?,1)')
      .bind(p.operation_id, p.repo_id, p.account_id, p.state, p.request_hash, JSON.stringify(p)).run();
  }
  let p = await storagePlacement(env, input.operation_id);
  invariant(p.request_hash === identity.request_hash && !['aborting','aborted'].includes(p.state), 'placement_intent_conflict', 'The move ID has another immutable physical placement.');
  if (p.state !== 'preparing') return progress(p, 0, false);
  await assertPlacementRoute(env, p);
  await preparePlacementGit(env, p);
  const rows = await many<{ id: string }>(db, `SELECT s.id FROM billing_storage_objects s WHERE s.coordinator_id=? AND s.repo_id=? AND s.state NOT IN ('deleted','transferred')
    AND COALESCE(json_extract(s.body_json,'$.placement_shadow'),0)=0 AND NOT EXISTS
    (SELECT 1 FROM billing_placement_copies c WHERE c.operation_id=? AND c.object_id=s.id) ORDER BY s.id LIMIT 32`, account(p), p.repo_id, p.operation_id);
  for (const row of rows) {
    const source = await admissionRequest<StorageObject>(env, account(p), 'get-object', { object_id: row.id });
    invariant(source.state === 'stored' && source.storage_cell_id && source.slice_id && source.checksum && !source.pending_renewal,
      'placement_source_unconfirmed', 'Every retained object requires its original physical placement and a settled upload.');
    const head = await headStorageObject(env, source);
    invariant(head && String(head.size) === source.bytes && head.etag === source.etag, 'placement_source_changed', 'The immutable source size and ETag changed.');
    const config = storagePolicy(env), created = now();
    const window = storageFundingWindow(created, source.retention_until && source.retention_until > created ? source.retention_until : null,
      source.renewal_policy ?? { commitment_seconds: config.commitment_seconds, deletion_grace_seconds: config.deletion_grace_seconds, renew_before_seconds: config.renew_before_seconds, on_renewal_failure: 'notify_block_writes_then_delete' });
    const copyId = `pcopy_${await sha256(`${p.operation_id}:${row.id}`)}`, sourceId = `psrc_${await sha256(`${row.id}:${p.operation_id}`)}`;
    const destination: StorageObject = { ...source, ...window, id: copyId, state: 'uploading', source: 'standalone', admission_state: 'ready',
      maximum_bytes: source.bytes, bytes: '0', commitment_units: '0', etag: null, checksum: null, created_at: created, accrued_at: created,
      repository_limit_bytes: String(limits(env).repository_storage_bytes),
      budget_started_at: created, budget_ids: [], slice_id: p.target_slice_id ?? source.slice_id, platform_object_id: copyId, storage_cell_id: p.target_cell_id,
      storage_epoch: p.target_epoch, placement_handoff_id: p.operation_id, placement_shadow: true, billable_from: '9999-01-01T00:00:00.000Z',
      billable_until: source.billable_until ?? (source.retention_until ? source.commitment_until : undefined), deleted_at: null, deletion_started_at: undefined, deletion_request_id: undefined, revision: 1 };
    const copy: PlacementCopy = { operation_id: p.operation_id, object_id: row.id, copy_id: copyId, source_id: sourceId, source, destination,
      state: p.source_cell_id === p.target_cell_id ? 'stored' : 'preparing', writer_id: `writer_${await sha256(`${p.fence}:${row.id}`)}`, receipt: null, deleted_at: null };
    await db.prepare(`INSERT OR IGNORE INTO billing_placement_copies(operation_id,object_id,copy_id,source_id,state,body_json)
      SELECT operation_id,?,?,?,?,? FROM billing_storage_placements WHERE operation_id=? AND state='preparing'`)
      .bind(row.id, copyId, sourceId, copy.state, JSON.stringify(copy), p.operation_id).run();
  }
  for (const copy of await copies(env, p, ['preparing'])) {
    const body = payload(p, copy);
    await admissionRequest(env, account(p), 'placement-source', body);
    await admissionRequest(env, `capacity:${copy.source.slice_id}`, 'placement-source', body);
    await admissionRequest(env, account(p), 'placement-reserve', body);
    await admissionRequest(env, `capacity:${copy.destination.slice_id}`, 'placement-reserve', body);
    await saveCopy(env, copy, 'reserved');
  }
  const remaining = await db.prepare(`SELECT 1 AS pending FROM billing_storage_objects s WHERE s.coordinator_id=? AND s.repo_id=? AND s.state NOT IN ('deleted','transferred')
    AND COALESCE(json_extract(s.body_json,'$.placement_shadow'),0)=0 AND NOT EXISTS(SELECT 1 FROM billing_placement_copies c WHERE c.operation_id=? AND c.object_id=s.id)
    UNION ALL SELECT 1 FROM billing_placement_copies WHERE operation_id=? AND state='preparing' LIMIT 1`).bind(account(p), p.repo_id, p.operation_id, p.operation_id).first();
  if (!remaining) p = await savePlacement(env, p, 'prepared');
  return progress(p, rows.length, !!remaining);
}

export async function copyRepositoryStoragePlacement(env: BillingBindings, input: { operation_id: string }): Promise<PlacementProgress> {
  const p = await storagePlacement(env, input.operation_id);
  invariant(p.state === 'prepared', 'placement_not_prepared', 'All duplication caps must be reserved before copying.');
  await assertPlacementRoute(env, p);
  const rows = await copies(env, p, ['reserved','writing','verified']);
  for (const copy of rows) {
    const observed = await placementRpc<PlacementCopy>(env, p.target_cell_id, 'copy', payload(p, copy));
    invariant(observed.state === 'verified', 'placement_copy_unconfirmed', 'The destination copy has no authoritative verification.');
    await admissionRequest(env, `capacity:${copy.destination.slice_id}`, 'placement-verify', payload(p, copy));
    await admissionRequest(env, account(p), 'placement-verify', payload(p, copy));
    await saveCopy(env, await placementCopy(env, p.operation_id, copy.object_id), 'stored');
  }
  const pending = await placementDb(env).prepare("SELECT 1 FROM billing_placement_copies WHERE operation_id=? AND state<>'stored' LIMIT 1").bind(p.operation_id).first();
  return progress(p, rows.length, !!pending);
}

export async function commitRepositoryStoragePlacement(env: BillingBindings, input: { operation_id: string; effective_at?: string }): Promise<PlacementProgress> {
  let p = await storagePlacement(env, input.operation_id);
  invariant(['prepared','committing','active','complete'].includes(p.state), 'placement_not_prepared', 'The physical handoff is not ready for cutover.');
  if (p.effective_at && input.effective_at) invariant(p.effective_at === input.effective_at, 'placement_boundary_conflict', 'The handoff boundary is immutable.');
  if (p.state === 'active' || p.state === 'complete') return progress(p, 0, false);
  await assertPlacementRoute(env, p);
  if (p.state === 'prepared') {
    invariant(!await placementDb(env).prepare("SELECT 1 FROM billing_placement_copies WHERE operation_id=? AND state<>'stored' LIMIT 1").bind(p.operation_id).first(), 'placement_copies_pending', 'Every declared destination must be verified before cutover.');
    await verifyPlacementGit(env, p);
    const at = input.effective_at ?? now();
    invariant(at >= p.created_at && at <= now(), 'placement_boundary_invalid', 'Physical metering needs an observed cutover time.');
    p = await savePlacement(env, p, 'committing', at);
  }
  if (input.effective_at) invariant(input.effective_at === p.effective_at, 'placement_boundary_conflict', 'The handoff boundary is immutable.');
  const rows = await copies(env, p, ['stored']);
  for (const copy of rows) {
    if (p.source_cell_id !== p.target_cell_id) {
      const body = payload(p, copy);
      await placementRpc(env, p.target_cell_id, 'observe', body);
      await admissionRequest(env, `capacity:${copy.source.slice_id}`, 'placement-source-accrue', body);
      await admissionRequest(env, `capacity:${copy.destination.slice_id}`, 'placement-switch', body);
      await admissionRequest(env, account(p), 'placement-switch', body);
    } else {
      await admissionRequest(env, account(p), 'placement-metadata-switch', payload(p, copy));
    }
    await saveCopy(env, copy, 'active');
  }
  const pending = await placementDb(env).prepare("SELECT 1 FROM billing_placement_copies WHERE operation_id=? AND state<>'active' LIMIT 1").bind(p.operation_id).first();
  if (!pending) { await finishPlacementGit(env, p, 'switch'); p = await savePlacement(env, p, 'active'); }
  return progress(p, rows.length, !!pending);
}

export async function finalizeRepositoryStoragePlacement(env: BillingBindings, input: { operation_id: string }): Promise<PlacementProgress> {
  let p = await storagePlacement(env, input.operation_id);
  invariant(['active','complete'].includes(p.state), 'placement_cutover_pending', 'Source cleanup requires the verified financial cutover.');
  if (p.state === 'complete' && await placementDb(env).prepare("SELECT 1 FROM billing_placement_receipts WHERE operation_id=? AND step='complete'").bind(p.operation_id).first()) return progress(p, 0, false);
  await assertPlacementRoute(env, p, true);
  const rows = await copies(env, p, ['active']);
  let processed = rows.length;
  for (const copy of rows) {
    if (p.source_cell_id !== p.target_cell_id) {
      await placementRpc(env, p.target_cell_id, 'observe', payload(p, copy));
      await placementRpc(env, copy.source.storage_cell_id!, 'cleanup', payload(p, copy));
      await admissionRequest(env, `capacity:${copy.source.slice_id}`, 'placement-delete', payload(p, copy));
      await admissionRequest(env, account(p), 'placement-delete', payload(p, copy));
    }
    await saveCopy(env, await placementCopy(env, p.operation_id, copy.object_id), 'cleaned');
  }
  const pending = await placementDb(env).prepare("SELECT 1 FROM billing_placement_copies WHERE operation_id=? AND state NOT IN ('cleaned','released') LIMIT 1").bind(p.operation_id).first();
  if (!pending) {
    await finishPlacementGit(env, p, 'cleanup');
    for (const copy of await copies(env, p, ['cleaned'])) {
      if (p.source_cell_id !== p.target_cell_id) await admissionRequest(env, `capacity:${copy.destination.slice_id}`, 'placement-target-release', payload(p, copy));
      if (p.source_cell_id !== p.target_cell_id) await admissionRequest(env, account(p), 'placement-target-release', payload(p, copy));
      await saveCopy(env, copy, 'released');
      processed++;
    }
  }
  const releasing = await placementDb(env).prepare("SELECT 1 FROM billing_placement_copies WHERE operation_id=? AND state='cleaned' LIMIT 1").bind(p.operation_id).first();
  if (!pending && !releasing) {
    if (p.state !== 'complete') p = await savePlacement(env, p, 'complete');
    await placementReceipt(env, p.operation_id, 'complete', { fence: p.fence, effective_at: p.effective_at, source: [p.source_cell_id,p.source_shard_id,p.source_epoch], destination: [p.target_cell_id,p.target_shard_id,p.target_epoch] });
  }
  return progress(p, processed, !!pending || !!releasing);
}

export async function abortRepositoryStoragePlacement(env: BillingBindings, input: { operation_id: string }): Promise<PlacementProgress> {
  let p = await storagePlacement(env, input.operation_id);
  invariant(!['committing','active','complete'].includes(p.state), 'placement_already_committed', 'A committed physical cutover cannot be rolled back as an unused copy.');
  if (p.state === 'aborted' && await placementDb(env).prepare("SELECT 1 FROM billing_placement_receipts WHERE operation_id=? AND step='aborted'").bind(p.operation_id).first()) return progress(p, 0, false);
  await assertPlacementRoute(env, p);
  if (p.state !== 'aborting' && p.state !== 'aborted') p = await savePlacement(env, p, 'aborting');
  for (const participant of await placementParticipants(env, p)) await admissionRequest(env, participant, 'placement-close', { operation_id: p.operation_id });
  await reconcilePlacementAbort(env, p);
  const rows = await copies(env, p, ['preparing','reserved','writing','failed','verified','stored']);
  let processed = rows.length;
  for (let copy of rows) {
    if (copy.state === 'writing') copy = await placementRpc(env, p.target_cell_id, 'observe', payload(p, copy));
    invariant(copy.state !== 'writing', 'placement_copy_uncertain', 'The original copy outcome is unknown; both holds remain active.', 503);
    if (p.source_cell_id !== p.target_cell_id) {
      if (copy.state === 'verified') {
        await admissionRequest(env, `capacity:${copy.destination.slice_id}`, 'placement-verify', payload(p, copy));
        await admissionRequest(env, account(p), 'placement-verify', payload(p, copy));
        copy = await saveCopy(env, copy, 'stored');
      }
      await placementRpc(env, p.target_cell_id, 'cleanup', payload(p, copy));
      await admissionRequest(env, `capacity:${copy.destination.slice_id}`, 'placement-delete', payload(p, copy));
      await admissionRequest(env, account(p), 'placement-delete', payload(p, copy));
    }
    await saveCopy(env, await placementCopy(env, p.operation_id, copy.object_id), 'aborted');
  }
  const pending = await placementDb(env).prepare("SELECT 1 FROM billing_placement_copies WHERE operation_id=? AND state NOT IN ('aborted','released') LIMIT 1").bind(p.operation_id).first();
  if (!pending) {
    await finishPlacementGit(env, p, 'abort');
    for (const copy of await copies(env, p, ['aborted'])) {
      if (p.source_cell_id !== p.target_cell_id) {
        await admissionRequest(env, `capacity:${copy.source.slice_id}`, 'placement-source-release', payload(p, copy));
        await admissionRequest(env, account(p), 'placement-source-release', payload(p, copy));
      }
      await saveCopy(env, copy, 'released');
      processed++;
    }
  }
  const releasing = await placementDb(env).prepare("SELECT 1 FROM billing_placement_copies WHERE operation_id=? AND state='aborted' LIMIT 1").bind(p.operation_id).first();
  if (!pending && !releasing) {
    if (p.state !== 'aborted') p = await savePlacement(env, p, 'aborted');
    await placementReceipt(env, p.operation_id, 'aborted', { fence: p.fence });
  }
  return progress(p, processed, !!pending || !!releasing);
}

/** A staged reader may use a verified duplicate before the logical selector's cutover. */
export async function verifiedPlacementStorageObject(env: BillingBindings, input: { operation_id: string; object_id: string }): Promise<StorageObject> {
  const p = await storagePlacement(env, input.operation_id), copy = await placementCopy(env, input.operation_id, input.object_id);
  invariant(p.target_cell_id === env.CELL_ID && p.target_shard_id === env.SHARD_ID && ['prepared','committing','active'].includes(p.state)
    && ['stored','active'].includes(copy.state), 'placement_reader_fenced', 'This staged reader has no verified destination copy.');
  const receipt = await admissionRequest<StorageObject>(env, account(p), 'get-object', { object_id: p.state === 'active' ? copy.object_id : copy.copy_id });
  invariant(receipt.state === 'stored' && receipt.storage_cell_id === p.target_cell_id && receipt.checksum === copy.source.checksum && receipt.bytes === copy.source.bytes,
    'placement_reader_unverified', 'The destination copy does not match its immutable financial receipt.');
  return { ...receipt, id: copy.object_id };
}
