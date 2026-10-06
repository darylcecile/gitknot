import { canonicalJson } from '@gitknot/core';
import { GitAdmissionBook } from './git-book.ts';
import { invariant } from './errors.ts';
import { maximumCharge, units } from './money.ts';
import type { AdmissionControl, BillingTransaction, Budget, StorageObject } from './types.ts';
import type { PlacementCopy, PlacementGitHold, StoragePlacement } from './placement-types.ts';
import type { CanonicalGitMeter } from './git-types.ts';

function fits(budgets: Budget[], amount: bigint): void {
  invariant(budgets.some(b => b.scope === 'account'), 'account_budget_required', 'Physical placement needs a funded account cap.', 503);
  for (const b of budgets) invariant(!b.stopped && units(b.settled_units) + units(b.reserved_units) + units(b.commitment_units) + amount
    <= units(b.limit_units) - units(b.safety_buffer_units), 'placement_budget_exhausted', 'The temporary duplicate does not fit every applicable cap.');
}

export class PlacementAdmissionBook extends GitAdmissionBook {
  private async acquirePlacement(tx: BillingTransaction, p: StoragePlacement): Promise<void> {
    invariant(['preparing', 'prepared'].includes(p.state) && !await tx.get(`placement-closed:${p.operation_id}`)
      && !await tx.get(`placement-aborted:${p.operation_id}`), 'placement_fenced', 'A closed physical placement cannot acquire or renew a grant.');
    const generation = canonicalJson({ operation_id: p.operation_id, repo_id: p.repo_id, account_id: p.account_id, fence: p.fence,
      source_cell_id: p.source_cell_id, source_shard_id: p.source_shard_id, source_epoch: p.source_epoch,
      target_cell_id: p.target_cell_id, target_shard_id: p.target_shard_id, target_epoch: p.target_epoch,
      request_hash: p.request_hash, purpose: p.purpose ?? 'move', archive_id: p.archive_id ?? null });
    const key = `placement-generation:${p.operation_id}`, prior = await tx.get<string>(key);
    invariant(!prior || prior === generation, 'placement_generation_changed', 'The immutable physical placement generation changed.');
    if (!prior) await tx.put(key, generation);
  }

  async closePlacement(p: StoragePlacement): Promise<void> {
    await this.store.transaction(async tx => {
      invariant(['aborting','aborted','active','complete'].includes(p.state), 'placement_not_closing', 'The physical placement has no close decision.');
      await this.closePlacementInTransaction(tx, p);
    });
  }

  private async closePlacementInTransaction(tx: BillingTransaction, p: StoragePlacement): Promise<void> {
    const key = `placement-closed:${p.operation_id}`, prior = await tx.get<string>(key);
    invariant(!prior || prior === p.fence, 'placement_generation_changed', 'The close receipt belongs to another placement generation.');
    await tx.put(key, p.fence);
    if (p.state === 'aborting' || p.state === 'aborted') await tx.put(`placement-aborted:${p.operation_id}`, true);
  }
  async metadataPlacement(id: string, p: StoragePlacement): Promise<StorageObject> {
    return this.store.transaction(async tx => {
      const control = await this.control(tx), object = await tx.get<StorageObject>(`object:${id}`);
      invariant(object && control.kind === 'account' && object.account_id === p.account_id && object.attribution.repo_id === p.repo_id
        && p.state === 'committing' && p.source_cell_id === p.target_cell_id, 'placement_scope', 'Metadata placement does not change physical storage.');
      if (object.storage_epoch === p.target_epoch) return object;
      object.storage_epoch = p.target_epoch; object.revision++;
      await tx.put(`object:${id}`, object); await this.journal(tx, control, [], 'billing.placement.metadata_moved', undefined, object);
      return object;
    });
  }
  async fencePlacementObject(id: string, placement: StoragePlacement): Promise<StorageObject> {
    return this.store.transaction(async tx => {
      await this.acquirePlacement(tx, placement);
      const control = await this.control(tx), object = await tx.get<StorageObject>(`object:${id}`);
      invariant(object && object.account_id === placement.account_id && object.attribution.repo_id === placement.repo_id
        && object.state === 'stored' && !object.pending_renewal, 'placement_source_unavailable', 'The source object is not quiescent.');
      invariant(!object.placement_handoff_id || object.placement_handoff_id === placement.operation_id, 'placement_conflict', 'Another physical handoff owns this object.');
      if (object.placement_handoff_id) return object;
      object.placement_handoff_id = placement.operation_id; object.revision++;
      await tx.put(`object:${id}`, object);
      await this.journal(tx, control, [], 'billing.placement.source_fenced', undefined, object);
      return object;
    });
  }

  async reservePlacementCopy(copy: PlacementCopy, placement: StoragePlacement): Promise<StorageObject> {
    return this.store.transaction(async tx => {
      await this.acquirePlacement(tx, placement);
      const control = await this.control(tx), old = await tx.get<StorageObject>(`object:${copy.copy_id}`);
      invariant(!await tx.get(`placement-aborted:${placement.operation_id}`), 'placement_aborted', 'A cancelled placement cannot issue a late copy grant.');
      if (old) { invariant(old.placement_handoff_id === placement.operation_id, 'placement_conflict', 'This physical copy belongs to another handoff.'); return old; }
      invariant(!control.stopped && this.at() < control.valid_until, 'placement_stopped', 'Physical duplication requires current funded admission.');
      const object = structuredClone(copy.destination);
      const amount = units(maximumCharge((units(object.maximum_bytes) * BigInt(Date.parse(object.commitment_until) - Date.parse(object.created_at))).toString(), object.rate, control.kind === 'capacity'));
      const budgets = await this.relatedBudgets(tx, control, object.attribution, object.created_at);
      fits(budgets, amount);
      invariant((control.object_count ?? 0) < (control.max_objects ?? 100000), 'object_quota', 'Physical duplication exceeds the object cap.');
      await this.reserveBytes(tx, control, object.attribution.repo_id, object.maximum_bytes, object.repository_limit_bytes ?? undefined);
      await this.adjust(tx, control, budgets, object.attribution, { reserved: amount });
      object.commitment_units = amount.toString(); object.budget_ids = budgets.map(b => b.id);
      control.object_count = (control.object_count ?? 0) + 1;
      await tx.put(`object:${object.id}`, object); await tx.put(`stored:${object.id}`, object.id);
      await this.journal(tx, control, budgets, 'billing.placement.copy_reserved', undefined, object);
      return object;
    });
  }

  async switchPlacementCopy(copy: PlacementCopy, placement: StoragePlacement): Promise<StorageObject> {
    const at = placement.effective_at!;
    const completed = await this.store.get<string>(`placement-switched:${copy.copy_id}`);
    if (completed) { invariant(completed === at, 'placement_boundary_conflict', 'The physical metering boundary is immutable.'); return this.object(copy.object_id); }
    await this.accrueObject(copy.object_id, at, false, undefined, placement.operation_id);
    await this.accrueObject(copy.copy_id, at, false, undefined, placement.operation_id);
    return this.store.transaction(async tx => {
      const control = await this.control(tx);
      invariant(control.kind === 'account', 'placement_scope', 'The account owns the logical object selector.');
      const source = await tx.get<StorageObject>(`object:${copy.object_id}`), destination = await tx.get<StorageObject>(`object:${copy.copy_id}`);
      invariant(source?.placement_handoff_id === placement.operation_id && destination?.state === 'stored'
        && destination.placement_handoff_id === placement.operation_id && source.accrued_at === at && destination.accrued_at === at,
      'placement_not_verified', 'Both copies must be verified at the same consumption boundary.');
      const shadow: StorageObject = { ...source, id: copy.source_id, placement_shadow: true, billable_until: at,
        platform_object_id: source.platform_object_id ?? source.id, revision: source.revision + 1 };
      const moved: StorageObject = { ...destination, id: source.id, source: source.source, billable_from: at,
        placement_shadow: false, platform_object_id: copy.copy_id, storage_epoch: placement.target_epoch, revision: Math.max(source.revision, destination.revision) + 1 };
      await this.moveCarry(tx, source, shadow.id); await this.moveCarry(tx, destination, moved.id);
      await tx.put(`object:${shadow.id}`, shadow); await tx.put(`stored:${shadow.id}`, shadow.id);
      await tx.put(`object:${moved.id}`, moved); await tx.put(`stored:${moved.id}`, moved.id);
      destination.state = 'transferred'; destination.commitment_units = '0'; destination.quota_handed_off = true; destination.transferred_at = at; destination.revision++;
      await tx.put(`object:${destination.id}`, destination); await tx.delete(`stored:${destination.id}`);
      await tx.put(`placement-switched:${copy.copy_id}`, at);
      await this.journal(tx, control, [], 'billing.placement.source_retained', undefined, shadow);
      await this.journal(tx, control, [], 'billing.placement.copy_aliased', undefined, destination);
      await this.journal(tx, control, [], 'billing.placement.switched', undefined, moved);
      return moved;
    });
  }

  private async moveCarry(tx: BillingTransaction, object: StorageObject, destination: string): Promise<void> {
    const key = `remainder:${object.rate.id}:${object.rate.meter_version}:${object.id}`;
    await tx.put(`remainder:${object.rate.id}:${object.rate.meter_version}:${destination}`, await tx.get<string>(key) ?? '0');
    await tx.delete(key);
  }

  async releasePlacementObject(id: string, placement: StoragePlacement, aborted: boolean): Promise<StorageObject> {
    return this.store.transaction(async tx => {
      await this.closePlacementInTransaction(tx, placement);
      const control = await this.control(tx), object = await tx.get<StorageObject>(`object:${id}`);
      invariant(object, 'placement_object_missing', 'The physical selector is unavailable.', 404);
      if (!object.placement_handoff_id) return object;
      invariant(object.placement_handoff_id === placement.operation_id, 'placement_conflict', 'The physical object fence changed.');
      if (aborted) await tx.put(`placement-aborted:${placement.operation_id}`, true);
      object.placement_handoff_id = undefined; object.storage_epoch = aborted ? placement.source_epoch : placement.target_epoch; object.revision++;
      await tx.put(`object:${id}`, object);
      await this.journal(tx, control, [], aborted ? 'billing.placement.resumed' : 'billing.placement.finalized', undefined, object);
      return object;
    });
  }

  async reservePlacementGit(hold: PlacementGitHold, p: StoragePlacement): Promise<void> {
    await this.store.transaction(async tx => {
      await this.acquirePlacement(tx, p);
      const control = await this.control(tx), key = `placement-git:${hold.operation_id}`;
      invariant(!await tx.get(`placement-aborted:${hold.operation_id}`), 'placement_aborted', 'This placement is permanently fenced.');
      const old = await tx.get<PlacementGitHold>(key); if (old) return;
      invariant(!control.stopped && this.at() < control.valid_until, 'placement_stopped', 'Canonical duplication needs a current operating allocation.');
      const a = { account_id: hold.account_id, repo_id: hold.repo_id, actor_id: hold.actor_id, workflow_id: null, team_id: null, run_id: null, attempt_id: null, generation: null };
      const budgets = await this.relatedBudgets(tx, control, a, hold.created_at), amount = control.kind === 'capacity'
        ? units(hold.maximum_platform_units) + units(hold.scratch_platform_units) : units(hold.maximum_units);
      fits(budgets, amount); await this.reserveBytes(tx, control, hold.repo_id, (units(hold.bytes) + units(hold.scratch_bytes ?? hold.bytes)).toString(), hold.repository_limit_bytes);
      await this.adjust(tx, control, budgets, a, { reserved: amount }); await tx.put(key, hold);
      await this.journal(tx, control, budgets, 'billing.placement.git_reserved');
    });
  }

  async settlePlacementScratch(hold: PlacementGitHold, receipt: { bytes: string; uploaded_at: string | null; deleted_at: string }): Promise<void> {
    await this.store.transaction(async tx => {
      const control = await this.control(tx), key = `placement-scratch-settled:${hold.operation_id}`;
      if (await tx.get(key)) return;
      const reserved = await tx.get<PlacementGitHold>(`placement-git:${hold.operation_id}`);
      if (!reserved) { await tx.put(key, true); return; }
      invariant(receipt.deleted_at <= this.at() && (!receipt.uploaded_at || receipt.uploaded_at <= receipt.deleted_at), 'placement_scratch_time', 'Scratch cleanup has an invalid observation time.');
      const a = { account_id: hold.account_id, repo_id: hold.repo_id, actor_id: hold.actor_id, workflow_id: null, team_id: null, run_id: null, attempt_id: null, generation: null };
      const quantity = receipt.uploaded_at ? units(receipt.bytes) * BigInt(Date.parse(receipt.deleted_at) - Date.parse(receipt.uploaded_at)) : 0n;
      const ledger = control.kind === 'capacity' ? [await this.charge(tx, { attribution: a, reservation_id: hold.operation_id, accrued_at: receipt.uploaded_at ?? hold.created_at }, hold.scratch_rate,
        quantity.toString(), `placement-scratch:${hold.operation_id}`, `scratch-deleted:${hold.operation_id}`, true)] : [];
      const cost = ledger.reduce((sum, entry) => sum + units(entry.amount_units), 0n);
      const budgets = await this.relatedBudgets(tx, control, a, hold.created_at);
      await this.adjust(tx, control, budgets, a, { reserved: control.kind === 'capacity' ? -units(hold.scratch_platform_units) : 0n, settled: cost });
      await this.moveBytes(tx, control, hold.repo_id, -units(hold.scratch_bytes ?? hold.bytes), 0n);
      if (cost > units(hold.scratch_platform_units)) this.stopForOverrun(control);
      await tx.put(key, true); await this.journal(tx, control, budgets, 'billing.placement.scratch_settled', undefined, undefined, ledger);
    });
  }

  async cancelPlacementGit(hold: PlacementGitHold): Promise<void> {
    await this.store.transaction(async tx => {
      const control = await this.control(tx), key = `placement-git:${hold.operation_id}`, current = await tx.get<PlacementGitHold>(key);
      await tx.put(`placement-aborted:${hold.operation_id}`, true);
      if (!current || current.state === 'cancelled' || current.state === 'consumed') return;
      const a = { account_id: hold.account_id, repo_id: hold.repo_id, actor_id: hold.actor_id, workflow_id: null, team_id: null, run_id: null, attempt_id: null, generation: null };
      const budgets = await this.relatedBudgets(tx, control, a, hold.created_at);
      await this.adjust(tx, control, budgets, a, { reserved: -units(control.kind === 'capacity' ? hold.maximum_platform_units : hold.maximum_units) });
      await this.moveBytes(tx, control, hold.repo_id, -units(hold.bytes), 0n);
      current.state = 'cancelled'; await tx.put(key, current); await this.journal(tx, control, budgets, 'billing.placement.git_cancelled');
    });
  }

  async fencePlacementGit(p: StoragePlacement, sourceCell: string): Promise<CanonicalGitMeter | null> {
    return this.store.transaction(async tx => {
      await this.acquirePlacement(tx, p);
      const control = await this.control(tx), key = `git-store:${p.repo_id}:${p.source_storage_name}`;
      const meter = await tx.get<CanonicalGitMeter>(key);
      if (!meter) return null;
      invariant(meter.account_id === p.account_id && meter.state === 'stored' && !meter.pending_renewal
        && !await tx.get(`git-active:${p.repo_id}`) && (!meter.placement_handoff_id || meter.placement_handoff_id === p.operation_id),
      'git_placement_source_unavailable', 'Canonical source publication and funding must be quiescent.');
      if (meter.placement_handoff_id) return meter;
      meter.storage_cell_id ??= sourceCell; meter.placement_handoff_id = p.operation_id; meter.revision++;
      await tx.put(key, meter); await this.journal(tx, control, [], 'billing.placement.git_fenced', undefined, undefined, [], { git_meters: [meter] });
      return meter;
    });
  }

  async switchPlacementGit(p: StoragePlacement, name: string, destination: boolean): Promise<void> {
    await this.store.transaction(async tx => {
      const control = await this.control(tx), key = `git-store:${p.repo_id}:${name}`, receiptKey = `placement-git-switched:${p.operation_id}:${name}`;
      if (await tx.get(receiptKey)) return;
      const meter = await tx.get<CanonicalGitMeter>(key);
      if (!meter) { invariant(!destination, 'git_placement_target_missing', 'Canonical destination has no verified meter.'); return; }
      invariant(meter.placement_handoff_id === p.operation_id && p.effective_at && meter.state === 'stored', 'git_placement_fenced', 'The canonical metering switch is outside its physical handoff.');
      const ledger = await this.accrueGitInTransaction(tx, control, meter, p.effective_at);
      if (destination) { meter.billable_from = p.effective_at; meter.routing_epoch = p.target_epoch; meter.storage_cell_id = p.target_cell_id; }
      else meter.billable_until = p.effective_at;
      meter.revision++; await tx.put(key, meter); await tx.put(receiptKey, p.effective_at);
      await this.journal(tx, control, await this.budgets(tx, control), 'billing.placement.git_switched', undefined, undefined, ledger, { git_meters: [meter] });
    });
  }

  async releasePlacementGit(p: StoragePlacement, name: string): Promise<void> {
    await this.store.transaction(async tx => {
      await this.closePlacementInTransaction(tx, p);
      const control = await this.control(tx), key = `git-store:${p.repo_id}:${name}`, meter = await tx.get<CanonicalGitMeter>(key);
      if (!meter || !meter.placement_handoff_id) return;
      invariant(meter.placement_handoff_id === p.operation_id, 'git_placement_fenced', 'Another placement owns this canonical meter.');
      meter.placement_handoff_id = undefined; meter.revision++; await tx.put(key, meter);
      await this.journal(tx, control, [], 'billing.placement.git_released', undefined, undefined, [], { git_meters: [meter] });
    });
  }

  async emptyPlacementGit(p: StoragePlacement, hold: PlacementGitHold, verifiedEmpty = true): Promise<void> {
    await this.store.transaction(async tx => {
      const control = await this.control(tx), key = `git-store:${p.repo_id}:${p.target_storage_name}`;
      if (await tx.get(key)) return;
      const escrow = await tx.get<PlacementGitHold>(`placement-git:${p.operation_id}`);
      invariant(escrow?.state === 'reserved', 'git_placement_fenced', 'The empty canonical destination has no funded duplication grant.');
      const attribution = { account_id: p.account_id, repo_id: p.repo_id, actor_id: p.actor_id, workflow_id: null, team_id: null, run_id: null, attempt_id: null, generation: null };
      const budgets = await this.relatedBudgets(tx, control, attribution, hold.created_at), platform = control.kind === 'capacity';
      const reserved = units(platform ? hold.maximum_platform_units : hold.maximum_units);
      const meter: CanonicalGitMeter = { id: `git:${p.repo_id}:${p.target_storage_name}`, account_id: p.account_id, repo_id: p.repo_id,
        storage_name: p.target_storage_name, routing_epoch: p.target_epoch, attribution, logical_bytes: '0', retained_bound_bytes: hold.bytes, object_count: '0',
        commitment_units: '0', budget_ids: budgets.map(b => b.id), budget_started_at: hold.created_at, accrued_at: hold.created_at,
        funded_until: hold.commitment_until, commitment_until: hold.commitment_until, renew_after: hold.commitment_until,
        peak_day: hold.created_at.slice(0, 10), peak_bytes: hold.bytes, rates: hold.rates, slice_id: hold.slice_id, last_operation_id: p.operation_id, revision: 1,
        renewal_policy: hold.source?.renewal_policy ?? { commitment_seconds: 2592000, renew_before_seconds: 604800, deletion_grace_seconds: 1209600, on_renewal_failure: 'notify_block_writes_then_delete' },
        funding_failure_at: null, state: 'stored', placement_handoff_id: p.operation_id, storage_cell_id: p.target_cell_id, billable_from: '9999-01-01T00:00:00.000Z' };
      const ledger = platform ? [await this.charge(tx, { attribution, reservation_id: p.operation_id, accrued_at: hold.created_at }, hold.rates.peak,
        hold.bytes, `placement:${p.operation_id}:empty`, `${verifiedEmpty ? 'verified-empty' : 'unpublished-copy'}:${p.operation_id}`, true, meter.id)] : [];
      const cost = ledger.reduce((sum, entry) => sum + units(entry.amount_units), 0n);
      invariant(cost <= reserved, 'placement_bound_exceeded', 'Canonical metadata exceeded its funded bound.');
      meter.commitment_units = (platform ? reserved - cost : 0n).toString();
      await this.adjust(tx, control, budgets, attribution, { reserved: -reserved, commitment: units(meter.commitment_units), settled: cost });
      await this.moveBytes(tx, control, p.repo_id, -units(hold.bytes), units(hold.bytes));
      escrow.state = 'consumed'; await tx.put(`placement-git:${p.operation_id}`, escrow); await tx.put(key, meter);
      await this.journal(tx, control, budgets, 'billing.placement.git_empty_verified', undefined, undefined, ledger, { git_meters: [meter] });
    });
  }
}
