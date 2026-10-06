import { now } from '@gitknot/core';
import { invariant } from './errors.ts';
import { activeSlice } from './catalog.ts';
import { placementCopy, placementDb, storagePlacement } from './placement-state.ts';
import { PlacementAdmissionBook } from './placement-book.ts';
import type { BillingBindings, StorageObject } from './types.ts';
import type { PlacementGitHold, PlacementNamespaceCleanup } from './placement-types.ts';
import { placementPublication } from './placement-publication.ts';

export async function placementController(env: BillingBindings, book: PlacementAdmissionBook, target: string, action: string,
  input: { operation_id: string; object_id?: string }): Promise<unknown> {
  const p = await storagePlacement(env, input.operation_id), account = target.startsWith('account:');
  if (account) invariant(target === `account:${p.account_id}`, 'placement_scope', 'The physical handoff payer changed.');
  if (action.startsWith('placement-git-')) {
    const row = await placementDb(env).prepare('SELECT * FROM billing_placement_git WHERE operation_id=?').bind(p.operation_id)
      .first<{ body_json: string; target_verified_json: string | null; source_deleted_at: string | null; target_deleted_at: string | null }>();
    invariant(row, 'placement_git_missing', 'The canonical duplication bound is unavailable.');
    const hold = JSON.parse(row.body_json) as PlacementGitHold;
    invariant(account || target === `capacity:${hold.slice_id}` || target === `capacity:${hold.source?.slice_id}`, 'placement_scope', 'The canonical duplication slice changed.');
    if (action === 'placement-git-scratch') {
      const scratch = await placementDb(env).prepare('SELECT bytes,uploaded_at,deleted_at,state FROM billing_placement_scratch WHERE operation_id=?').bind(p.operation_id)
        .first<{ bytes: string; uploaded_at: string | null; deleted_at: string; state: string }>();
      const unused = await placementDb(env).prepare("SELECT 1 FROM billing_placement_receipts WHERE operation_id=? AND step='scratch-unused'").bind(p.operation_id).first();
      invariant(scratch ? scratch.state === 'deleted' : p.state === 'aborting' || p.state === 'aborted' || unused, 'placement_scratch_unverified', 'Scratch cost requires confirmed cleanup or a fenced unused intent.');
      await book.settlePlacementScratch(hold, scratch ?? { bytes: '0', uploaded_at: null, deleted_at: now() }); return { settled: true };
    }
    if (action === 'placement-git-source') {
      invariant(['preparing','prepared'].includes(p.state), 'placement_fenced', 'A terminal placement cannot fence its source again.');
      return book.fencePlacementGit(p, p.source_cell_id);
    }
    if (action === 'placement-git-empty') {
      invariant(row.target_verified_json && JSON.parse(row.target_verified_json).refs.length === 0, 'placement_git_unverified', 'An empty target needs verified native refs.');
      await book.emptyPlacementGit(p, hold); return { committed: true };
    }
    if (action === 'placement-git-switch') {
      invariant(p.state === 'committing', 'placement_fenced', 'Canonical consumption can switch only at the recorded boundary.');
      if (account || target === `capacity:${hold.slice_id}`) await book.switchPlacementGit(p, p.target_storage_name, true);
      if (hold.source && (account || target === `capacity:${hold.source.slice_id}`)) await book.switchPlacementGit(p, p.source_storage_name, false);
      return { switched: true };
    }
    if (action === 'placement-git-cleanup' || action === 'placement-git-abort') {
      const source = action === 'placement-git-cleanup', side = source ? 'source' : 'target';
      const cleanupRow = await placementDb(env).prepare('SELECT receipt_json FROM billing_placement_namespace_cleanup WHERE operation_id=? AND side=?').bind(p.operation_id, side).first<{ receipt_json: string }>();
      const cleanup = cleanupRow ? JSON.parse(cleanupRow.receipt_json) as PlacementNamespaceCleanup : null;
      const terminal = await placementPublication(env, p, side);
      invariant(cleanup && terminal && cleanup.repo_id === p.repo_id && cleanup.placement_fence === p.fence && cleanup.side === side
        && (source ? p.state === 'active' || p.state === 'complete' : p.state === 'aborting' || p.state === 'aborted'),
      'placement_git_cleanup_unverified', 'Canonical cleanup needs positive ownership, terminal publication and physical outcome receipts.');
      const at = cleanup.observed_at;
      const name = source ? p.source_storage_name : p.target_storage_name;
      invariant(cleanup.storage_name === name, 'placement_namespace_owner_mismatch', 'The namespace cleanup belongs to another physical store.');
      let meter = await book.gitMeter(p.repo_id, name);
      if (!meter && !source) {
        const intent = await placementDb(env).prepare('SELECT reservation_id,fence FROM billing_git_intents WHERE repo_id=? AND operation_id=?').bind(p.repo_id, p.operation_id).first<{ reservation_id: string; fence: string }>();
        const pending = intent ? await book.store.get<{ state: string }>(`git-operation:${intent.reservation_id}`) : null;
        if (intent && pending && ['prepared','reserved'].includes(pending.state)) {
          invariant(false, 'placement_publication_unsettled', 'The native publication must finalize its actual outcome before financial cleanup.', 503);
        }
        if (!meter) {
          if (cleanup.outcome === 'deleted' && cleanup.existed) {
            await book.emptyPlacementGit(p, hold, false); meter = await book.gitMeter(p.repo_id, name);
          }
        }
      }
      if (meter) {
        invariant(cleanup.outcome === 'deleted', 'placement_namespace_owner_mismatch', 'An unowned namespace cannot settle a retained meter.');
        await book.purgeGit(p.repo_id, name, at, p.operation_id);
      }
      else if (!source) await book.cancelPlacementGit(hold);
      return { deleted: true };
    }
    if (action === 'placement-git-target-release' || action === 'placement-git-source-release') {
      invariant(p.state === 'active' || p.state === 'complete' || p.state === 'aborting' || p.state === 'aborted', 'placement_fenced', 'The canonical handoff is not releasing.');
      await book.releasePlacementGit(p, action === 'placement-git-target-release' ? p.target_storage_name : p.source_storage_name);
      return { released: true };
    }
    invariant(action === 'placement-git-reserve', 'placement_git_action', 'Unknown canonical placement action.', 422);
    invariant(['preparing','prepared'].includes(p.state), 'placement_fenced', 'This placement cannot reserve more work.');
    await activeSlice(env, hold.slice_id); await book.reservePlacementGit(hold, p); return { reserved: true };
  }
  invariant(input.object_id, 'placement_object_required', 'A declared physical object is required.', 422);
  const copy = await placementCopy(env, p.operation_id, input.object_id);
  const sourceId = account ? copy.object_id : copy.source.platform_object_id ?? copy.object_id;
  const sourceSlice = copy.source.slice_id!;
  const source = ['placement-source','placement-source-accrue','placement-source-release'].includes(action)
    || action === 'placement-delete' && p.state === 'active';
  invariant(account || target === `capacity:${source ? sourceSlice : copy.destination.slice_id}`, 'placement_scope', 'The object belongs to another physical slice.');
  switch (action) {
    case 'placement-source':
      invariant(['preparing','prepared'].includes(p.state), 'placement_fenced', 'This placement cannot acquire a source fence.');
      return book.fencePlacementObject(sourceId, p);
    case 'placement-reserve':
      invariant(['preparing','prepared'].includes(p.state), 'placement_fenced', 'The copy grant is permanently fenced.');
      await activeSlice(env, copy.destination.slice_id!);
      return book.reservePlacementCopy(copy, p);
    case 'placement-verify': {
      invariant(copy.receipt && ['verified','stored','active','cleaned'].includes(copy.state), 'placement_copy_unverified', 'A positive storage verification is required.');
      return book.commitObject({ account_id: p.account_id, object_id: copy.copy_id, reservation_id: copy.destination.reservation_id, fence: copy.destination.fence,
        bytes: copy.receipt.bytes, etag: copy.receipt.etag, checksum: copy.receipt.checksum, uploaded_at: copy.receipt.uploaded_at });
    }
    case 'placement-source-accrue':
      invariant(p.effective_at && ['committing','active'].includes(p.state), 'placement_boundary_missing', 'The physical metering boundary is not committed.');
      return book.accrueObject(sourceId, p.effective_at, false, undefined, p.operation_id);
    case 'placement-switch':
      invariant(p.effective_at && ['committing','active'].includes(p.state), 'placement_boundary_missing', 'The physical metering boundary is not committed.');
      return account ? book.switchPlacementCopy(copy, p) : book.accrueObject(copy.copy_id, p.effective_at, false, undefined, p.operation_id);
    case 'placement-metadata-switch':
      return book.metadataPlacement(copy.object_id, p);
    case 'placement-delete': {
      invariant(copy.deleted_at && ['active','aborting'].includes(p.state), 'placement_deletion_unverified', 'Physical cleanup requires the original verified deletion receipt.');
      const id = p.state === 'active' ? account ? copy.source_id : sourceId : copy.copy_id;
      const object = await book.store.get<StorageObject>(`object:${id}`);
      if (!object) { await book.store.put(`placement-aborted:${p.operation_id}`, true); return { deleted: true }; }
      if (object.state === 'uploading') {
        invariant(p.state === 'aborting' && ['reserved','failed','preparing'].includes(copy.state), 'placement_copy_uncertain', 'An uncertain writer retains its hold.');
        return book.abortUnuploadedObject(id, object.fence, `placement:${p.fence}:unwritten`);
      }
      await book.beginDelete(id, p.operation_id);
      return book.accrueObject(id, copy.deleted_at, true, undefined, p.operation_id);
    }
    case 'placement-source-release':
      invariant(p.state === 'aborted' || p.state === 'aborting' && ['aborted','released'].includes(copy.state), 'placement_cleanup_pending', 'Physical placement cleanup must finish before release.');
      return book.releasePlacementObject(sourceId, p, true);
    case 'placement-target-release':
      invariant(p.state === 'complete' || p.state === 'active' && ['cleaned','released'].includes(copy.state), 'placement_cleanup_pending', 'Physical placement cleanup must finish before release.');
      return book.releasePlacementObject(account ? copy.object_id : copy.copy_id, p, false);
    default: throw new Error(`Unknown storage placement action: ${action}`);
  }
}
