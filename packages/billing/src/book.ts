import { BillingError, invariant } from './errors.ts';
import { ceilDivide, integer, maximumCharge, meterCharge, monthWindow, signedUnits, units } from './money.ts';
import type { Rate } from './money.ts';
import type {
  AdmissionControl, Attribution, BillingStore, BillingTransaction, Budget, ExecutionQuote, Journal,
  LedgerEntry, Reservation, ReserveStorageInput, CommitStorageInput, SettleExecutionInput, StorageObject, UsageRollup,
  StandaloneStorageTerms, StorageRenewal, StorageImport, BillingCommand, BillingCommandReceipt, StorageDeletionRequest, StorageIntentCancellation,
} from './types.ts';

interface Counters { reserved_units: string; commitment_units: string; settled_units: string }
interface QueueTicket { id: string; fair_key: string; ticket: number }
type Change = { reserved?: bigint; commitment?: bigint; settled?: bigint };
const pad = (value: number) => String(value).padStart(16, '0');
const key = (id: string) => `reservation:${id}`;
const objectKey = (id: string) => `object:${id}`;

function scopeKeys(a: Attribution): Array<[Budget['scope'], string]> {
  const result: Array<[Budget['scope'], string]> = [['account', a.account_id]];
  if (a.repo_id) result.push(['repository', a.repo_id]);
  if (a.actor_id) result.push(['actor', a.actor_id]);
  if (a.workflow_id) result.push(['workflow', a.workflow_id]);
  if (a.team_id) result.push(['team', a.team_id]);
  return result;
}

function applies(budget: Budget, a: Attribution): boolean {
  return scopeKeys(a).some(([scope, id]) => budget.scope === scope && budget.scope_id === id);
}

function move(counter: Counters, change: Change): void {
  counter.reserved_units = (units(counter.reserved_units) + (change.reserved ?? 0n)).toString();
  counter.commitment_units = (units(counter.commitment_units) + (change.commitment ?? 0n)).toString();
  counter.settled_units = (units(counter.settled_units) + (change.settled ?? 0n)).toString();
  invariant(![counter.reserved_units, counter.commitment_units, counter.settled_units].some((amount) => amount.startsWith('-')),
    'admission_corrupt', 'Admission counters require reconciliation.', 503);
}

function available(budget: Budget): bigint {
  return units(budget.limit_units) - units(budget.safety_buffer_units) - units(budget.settled_units)
    - units(budget.reserved_units) - units(budget.commitment_units);
}

function slots(control: AdmissionControl, quote: ExecutionQuote): number {
  return control.kind === 'capacity' && quote.executor === 'self_hosted' ? 0 : 1;
}

function canAdmit(control: AdmissionControl, at: string): void {
  invariant(!control.stopped, 'execution_stopped', control.stop_reason ?? 'New paid work is stopped.', 409);
  invariant(at < control.valid_until, 'admission_expired', 'The operating allocation must be renewed before starting work.', 503);
}

/** All mutations happen inside the storage transaction. Network I/O belongs in the coordinator saga. */
export class AdmissionBook {
  constructor(readonly store: BillingStore, private readonly clock: () => Date = () => new Date()) {}

  async initialize(control: AdmissionControl, budgets: Budget[], subscription?: { id: string; amount_units: string }): Promise<void> {
    await this.store.transaction(async (tx) => {
      const existing = await tx.get<AdmissionControl>('control');
      if (existing) {
        invariant(existing.id === control.id && existing.epoch === control.epoch, 'coordinator_identity', 'Coordinator identity changed.', 503);
        return;
      }
      invariant(budgets.length > 0 && budgets.length <= 128, 'budget_configuration', 'A coordinator requires a bounded budget set.', 503);
      await tx.put('control', control);
      for (const budget of budgets) await tx.put(`budget:${budget.id}`, budget);
      if (subscription) await this.applyStandingCommitment(tx, control, subscription);
      await this.journal(tx, control, await this.budgets(tx, control), 'billing.admission.initialized');
    });
  }

  async snapshot(): Promise<{ control: AdmissionControl; budgets: Budget[] }> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      return { control, budgets: await this.budgets(tx, control) };
    });
  }

  async reservation(id: string): Promise<Reservation> {
    const value = await this.store.get<Reservation>(key(id));
    invariant(value, 'reservation_not_found', 'Reservation not found.', 404);
    return value;
  }

  async object(id: string): Promise<StorageObject> {
    const value = await this.store.get<StorageObject>(objectKey(id));
    invariant(value, 'storage_not_found', 'Storage reservation not found.', 404);
    return value;
  }

  async command(id: string): Promise<BillingCommandReceipt | null> {
    return await this.store.get<BillingCommandReceipt>(`command:${id}`) ?? null;
  }

  async budget(id: string): Promise<Budget> {
    const budget = await this.store.get<Budget>(`budget:${id}`);
    invariant(budget, 'budget_not_found', 'Budget not found.', 404);
    return budget;
  }

  async reserveStandalone(terms: StandaloneStorageTerms, imported?: StorageImport): Promise<StorageObject> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      invariant(!await tx.get(`storage-intent-cancelled:${terms.input.object_id}`), 'storage_intent_cancelled', 'This storage intent was permanently fenced before upload.');
      if (imported) invariant(!await tx.get(`transfer-cancelled:${imported.operation_id}:${terms.input.object_id}`), 'transfer_cancelled', 'The storage import was cancelled.');
      const old = await tx.get<StorageObject>(objectKey(terms.input.object_id));
      if (old && !(imported && old.state === 'transferred' && old.reservation_id !== terms.reservation_id)) {
        invariant(old.source === 'standalone' && old.request_hash === terms.request_hash && old.fence === terms.fence,
          'storage_conflict', 'This object ID already identifies a different storage reservation.');
        return old;
      }
      invariant(!await tx.get(`storage-cancelled:${terms.reservation_id}`), 'storage_cancelled', 'This cancelled object ID cannot be revived.');
      canAdmit(control, this.at());
      const all = await this.budgets(tx, control);
      const budgets = all.filter((b) => (control.kind === 'capacity' || applies(b, terms.attribution)) && b.period_start <= this.at() && (!b.period_end || b.period_end > this.at()));
      invariant(budgets.some((b) => b.scope === 'account'), 'account_budget_required', 'Storage admission requires an authoritative account cap.', 503);
      const hold = units(control.kind === 'capacity' ? terms.maximum_platform_units : terms.maximum_units);
      for (const budget of budgets) invariant(!budget.stopped && available(budget) >= hold, 'budget_exhausted', 'The retained-storage commitment does not fit every applicable cap.');
      invariant((control.object_count ?? 0) < (control.max_objects ?? 100_000), 'object_quota', 'The account object-count limit was reached.', 422);
      invariant(imported || !await tx.get(`object-key:${terms.input.bucket}:${terms.input.key}`), 'immutable_object_key', 'The storage key has already been reserved.');
      const reuse = control.kind === 'capacity' && imported?.reuse_physical_quota;
      if (!reuse) {
        await this.reserveBytes(tx, control, terms.attribution.repo_id, terms.input.maximum_bytes, terms.repository_limit_bytes ?? undefined);
        if (imported) await this.moveBytes(tx, control, terms.attribution.repo_id, -units(terms.input.maximum_bytes), units(terms.input.maximum_bytes));
      }
      await this.adjust(tx, control, budgets, terms.attribution, imported ? { commitment: hold } : { reserved: hold });
      const object: StorageObject = {
        id: terms.input.object_id, account_id: terms.input.account_id, reservation_id: terms.reservation_id, fence: terms.fence,
        key: terms.input.key, bucket: terms.input.bucket, state: imported ? 'transfer_pending' : 'uploading', source: 'standalone', slice_id: terms.slice_id,
        request_hash: terms.request_hash, repository_limit_bytes: terms.repository_limit_bytes, storage_cell_id: terms.storage_cell_id, admission_state: 'preparing',
        maximum_bytes: terms.input.maximum_bytes, bytes: imported ? terms.input.maximum_bytes : '0', commitment_units: hold.toString(), budget_ids: budgets.map((b) => b.id),
        attribution: terms.attribution, rate: terms.rate, etag: imported?.etag ?? null, checksum: imported?.checksum ?? null, created_at: terms.created_at, accrued_at: terms.created_at,
        budget_started_at: terms.created_at, retention_until: terms.input.retention_until, commitment_until: terms.commitment_until,
        funded_until: terms.funded_until, renew_after: terms.renew_after, renewal_policy: terms.renewal_policy,
        funding_failure_at: null, delete_after: terms.renew_after ? null : terms.input.retention_until, deleted_at: null, revision: (old?.revision ?? 0) + 1,
        ...(imported ? { import_source: imported, transfer_operation_id: imported.operation_id, platform_object_id: imported.platform_object_id } : {}),
      };
      if (!reuse) control.object_count = (control.object_count ?? 0) + 1;
      if (old) await tx.put(`object-history:${old.id}:${old.reservation_id}`, old);
      await tx.put(`object-key:${object.bucket}:${object.key}`, object.id);
      await tx.put(`stored:${object.id}`, object.id);
      await tx.put(objectKey(object.id), object);
      await this.journal(tx, control, budgets, 'billing.storage.reserved', undefined, object);
      return object;
    });
  }

  async commitStandaloneAdmission(id: string, fence: string): Promise<StorageObject> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      invariant(!await tx.get(`storage-intent-cancelled:${id}`), 'storage_intent_cancelled', 'This storage intent cannot issue a late admission.');
      const object = await tx.get<StorageObject>(objectKey(id));
      invariant(object?.source === 'standalone' && object.fence === fence, 'storage_not_found', 'Storage reservation not found.', 404);
      invariant(object.admission_state !== 'cancelled', 'storage_cancelled', 'A cancelled storage fence cannot be revived.');
      if (object.admission_state === 'ready') return object;
      object.admission_state = 'ready';
      object.revision += 1;
      await tx.put(objectKey(id), object);
      await this.journal(tx, control, [], 'billing.storage.admitted', undefined, object);
      return object;
    });
  }

  async cancelStorageIntent(input: Omit<StorageIntentCancellation, 'state' | 'reservation_id' | 'fence'>): Promise<StorageIntentCancellation> {
    return this.store.transaction(async (tx) => {
      const previous = await tx.get<StorageIntentCancellation>(`storage-intent-cancelled:${input.id}`);
      if (previous) {
        invariant(previous.account_id === input.account_id && previous.key === input.key && previous.repo_id === input.repo_id && previous.bucket === input.bucket,
          'storage_intent_conflict', 'The cancellation identity belongs to a different immutable object.');
        return previous;
      }
      const object = await tx.get<StorageObject>(objectKey(input.id));
      invariant(!object || object.source === 'standalone', 'storage_intent_conflict', 'This object is owned by execution admission.');
      const cancelled: StorageIntentCancellation = { ...input, state: 'cancelling', reservation_id: object?.reservation_id ?? null, fence: object?.fence ?? null };
      await tx.put(`storage-intent-cancelled:${input.id}`, cancelled);
      return cancelled;
    });
  }

  async completeStorageIntentCancellation(id: string): Promise<StorageIntentCancellation> {
    return this.store.transaction(async (tx) => {
      const receipt = await tx.get<StorageIntentCancellation>(`storage-intent-cancelled:${id}`);
      invariant(receipt, 'storage_intent_not_found', 'The storage cancellation is not recorded.', 404);
      const object = await tx.get<StorageObject>(objectKey(id));
      invariant(!object || object.state === 'deleted', 'storage_settlement_pending', 'The cancelled intent still has unsettled financial holds.', 503);
      receipt.state = 'cancelled';
      await tx.put(`storage-intent-cancelled:${id}`, receipt);
      return receipt;
    });
  }

  async requestStorageDeletion(id: string): Promise<StorageObject> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      const object = await tx.get<StorageObject>(objectKey(id));
      invariant(object, 'storage_not_found', 'Storage object not found.', 404);
      const deadline = object.delete_after ?? object.retention_until;
      if (!deadline || deadline > this.at() || !['stored', 'deleting'].includes(object.state)) return object;
      const previous = object.deletion_request_id ? await tx.get<StorageDeletionRequest>(`deletion-request:${object.deletion_request_id}`) : null;
      if (previous && previous.state !== 'cancelled') return object;
      const request: StorageDeletionRequest = { id: `sdel_${crypto.randomUUID().replaceAll('-', '')}`, account_id: object.account_id,
        repo_id: object.attribution.repo_id, object_id: object.id, reservation_id: object.reservation_id, fence: object.fence,
        reason: object.funding_failure_at ? 'funding' : 'retention', state: 'pending', requested_at: this.at(), delete_after: deadline, revision: 1 };
      object.deletion_request_id = request.id; object.revision += 1;
      await tx.put(`deletion-request:${request.id}`, request); await tx.put(objectKey(id), object);
      await this.journal(tx, control, [], 'billing.storage.deletion_requested', undefined, object);
      return object;
    });
  }

  async claimStorageDeletion(id: string, requestId: string): Promise<StorageObject> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx), object = await tx.get<StorageObject>(objectKey(id));
      const request = await tx.get<StorageDeletionRequest>(`deletion-request:${requestId}`);
      invariant(object && request && object.deletion_request_id === requestId && object.fence === request.fence && request.state !== 'cancelled',
        'storage_deletion_superseded', 'The retention request no longer matches current ownership or funding.');
      if (request.state === 'financially_deleted' || request.state === 'claimed') return object;
      const deadline = object.delete_after ?? object.retention_until;
      invariant(deadline && deadline <= this.at() && !object.pending_renewal && object.state === 'stored',
        'storage_deletion_superseded', 'The object has renewed funding or another operation in progress.');
      object.state = 'deleting'; object.revision += 1; request.state = 'claimed'; request.revision += 1;
      await tx.put(`deletion-request:${requestId}`, request); await tx.put(objectKey(id), object);
      await this.journal(tx, control, [], 'billing.storage.deletion_claimed', undefined, object);
      return object;
    });
  }

  async releaseStorageDeletion(id: string, requestId: string): Promise<StorageObject> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx), object = await tx.get<StorageObject>(objectKey(id));
      const request = await tx.get<StorageDeletionRequest>(`deletion-request:${requestId}`);
      invariant(object && request && request.object_id === object.id && request.account_id === object.account_id,
        'storage_deletion_not_found', 'The scoped retention claim was not found.', 404);
      if (request.state === 'cancelled') return object;
      invariant(object && request && object.deletion_request_id === requestId && !object.deletion_started_at && request.state === 'claimed',
        'storage_delete_started', 'A physical deletion that may have started cannot be released.');
      object.state = 'stored'; object.revision += 1; request.state = 'cancelled'; request.revision += 1;
      await tx.put(`deletion-request:${requestId}`, request); await tx.put(objectKey(id), object);
      await this.journal(tx, control, [], 'billing.storage.deletion_claim_released', undefined, object);
      return object;
    });
  }

  /** Compensation is valid only while no upload permission has been returned by this participant. */
  async cancelStandalone(terms: StandaloneStorageTerms, coordinatorFenced = false): Promise<StorageObject | { cancelled: true; reservation_id: string; fence: string }> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      const object = await tx.get<StorageObject>(objectKey(terms.input.object_id));
      if (!object) {
        await tx.put(`storage-cancelled:${terms.reservation_id}`, terms.fence);
        return { cancelled: true, reservation_id: terms.reservation_id, fence: terms.fence };
      }
      invariant(object.fence === terms.fence && object.source === 'standalone', 'storage_conflict', 'Storage reservation fence changed.');
      if (object.admission_state === 'cancelled') return object;
      invariant(object.state === 'uploading' && (object.admission_state === 'preparing' || (control.kind === 'capacity' && coordinatorFenced)),
        'upload_termination_required', 'An admitted upload keeps its hold until its upstream outcome is verified.');
      const budgets = await this.relatedBudgets(tx, control, object.attribution, object.budget_started_at);
      await this.adjust(tx, control, budgets, object.attribution, { reserved: -units(object.commitment_units) });
      await this.moveBytes(tx, control, object.attribution.repo_id, -units(object.maximum_bytes), 0n);
      control.object_count = (control.object_count ?? 1) - 1;
      object.admission_state = 'cancelled'; object.state = 'deleted'; object.commitment_units = '0'; object.deleted_at = this.at(); object.revision += 1;
      await tx.put(`storage-cancelled:${terms.reservation_id}`, terms.fence);
      await tx.put(objectKey(object.id), object);
      await tx.delete(`stored:${object.id}`);
      await this.journal(tx, control, budgets, 'billing.storage.compensated', undefined, object);
      return object;
    });
  }

  async abortUnuploadedObject(id: string, fence: string, receipt: string): Promise<StorageObject> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      const object = await tx.get<StorageObject>(objectKey(id));
      invariant(object?.source === 'standalone' && object.fence === fence, 'storage_not_found', 'Standalone storage reservation not found.', 404);
      if (object.state === 'deleted') return object;
      invariant(object.state === 'uploading' && !object.pending_renewal && receipt.length >= 8,
        'upload_termination_required', 'An unconfirmed upload keeps its original reservation.');
      const budgets = await this.relatedBudgets(tx, control, object.attribution, object.budget_started_at);
      await this.adjust(tx, control, budgets, object.attribution, { reserved: -units(object.commitment_units) });
      await this.moveBytes(tx, control, object.attribution.repo_id, -units(object.maximum_bytes), 0n);
      control.object_count = (control.object_count ?? 1) - 1;
      object.state = 'deleted'; object.admission_state = 'cancelled'; object.commitment_units = '0'; object.deleted_at = this.at(); object.revision += 1;
      await tx.put(`upload-abort-receipt:${id}`, receipt);
      await tx.put(objectKey(id), object); await tx.delete(`stored:${id}`);
      await this.journal(tx, control, budgets, 'billing.storage.upload_aborted', undefined, object);
      return object;
    });
  }

  async prepareRenewal(id: string, input: Pick<StorageRenewal, 'id' | 'funded_until' | 'commitment_until' | 'renew_after'>): Promise<StorageObject> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      const object = await tx.get<StorageObject>(objectKey(id));
      invariant(object?.source === 'standalone' && object.state === 'stored', 'storage_not_renewable', 'This object is not available for rolling funding.');
      invariant(!object.placement_handoff_id, 'storage_placement_fenced', 'Storage placement is being reconciled.');
      if (object.last_renewal_id === input.id) return object;
      invariant(!await tx.get(`renewal-cancelled:${id}:${input.id}`), 'renewal_cancelled', 'A cancelled funding fence cannot be reused.');
      if (object.pending_renewal) {
        invariant(object.pending_renewal.id === input.id, 'renewal_in_progress', 'A prior storage funding decision is still being reconciled.');
        return object;
      }
      invariant(input.commitment_until > object.commitment_until && Date.parse(input.commitment_until) > Date.parse(object.accrued_at),
        'invalid_commitment_window', 'A renewal must extend the financed storage window.', 422);
      const all = await this.relatedBudgets(tx, control, object.attribution, object.budget_started_at);
      const budgets = all.filter((b) => !b.period_end || b.period_end > this.at());
      const quantity = units(object.bytes) * BigInt(Date.parse(input.commitment_until) - Date.parse(object.accrued_at));
      const remainder = units(await tx.get<string>(`remainder:${object.rate.id}:${object.rate.meter_version}:${object.id}`) ?? '0');
      const price = units(control.kind === 'capacity' ? object.rate.platform_unit_price_units : object.rate.unit_price_units);
      const needed = ceilDivide(quantity * price + remainder, units(object.rate.unit_quantity));
      const delta = needed > units(object.commitment_units) ? needed - units(object.commitment_units) : 0n;
      for (const budget of budgets) invariant(!budget.stopped && available(budget) >= delta, 'budget_exhausted', 'Renewing retained storage would exceed an applicable cap.');
      await this.adjust(tx, control, budgets, object.attribution, { commitment: delta });
      object.pending_renewal = { ...input, delta_units: delta.toString(), budget_ids: budgets.map((b) => b.id), created_at: this.at() };
      object.revision += 1;
      await tx.put(objectKey(id), object);
      await this.journal(tx, control, budgets, 'billing.storage.renewal_prepared', undefined, object);
      return object;
    });
  }

  async finishRenewal(id: string, renewalId: string, commit: boolean): Promise<StorageObject> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      const object = await tx.get<StorageObject>(objectKey(id));
      invariant(object?.source === 'standalone', 'storage_not_found', 'Storage object not found.', 404);
      if (object.last_renewal_id === renewalId) return object;
      const pending = object.pending_renewal;
      if (!pending && !commit) { await tx.put(`renewal-cancelled:${id}:${renewalId}`, true); return object; }
      invariant(pending?.id === renewalId, 'renewal_conflict', 'Storage funding generation changed.');
      const budgets = await this.relatedBudgets(tx, control, object.attribution, object.budget_started_at);
      const funded = budgets.filter((b) => pending.budget_ids.includes(b.id) || b.period_start >= pending.created_at);
      if (!commit) {
        await this.adjust(tx, control, funded, object.attribution, { commitment: -units(pending.delta_units) });
        await tx.put(`renewal-cancelled:${id}:${renewalId}`, true);
      } else {
        // Expired windows funded the old commitment only. Future renewals belong to the currently applicable windows.
        for (const budget of budgets.filter((b) => b.period_end && b.period_end <= this.at())) {
          const release = units(object.commitment_units) + (funded.some((b) => b.id === budget.id) ? units(pending.delta_units) : 0n);
          move(budget, { commitment: -release }); budget.revision += 1; await tx.put(`budget:${budget.id}`, budget);
        }
        object.commitment_units = (units(object.commitment_units) + units(pending.delta_units)).toString();
        object.commitment_until = pending.commitment_until; object.funded_until = pending.funded_until; object.renew_after = pending.renew_after;
        object.budget_started_at = this.at(); object.budget_ids = budgets.filter((b) => !b.period_end || b.period_end > this.at()).map((b) => b.id);
        object.last_renewal_id = renewalId; object.funding_failure_at = null; object.delete_after = object.renew_after ? null : object.retention_until;
        if (object.deletion_request_id) {
          const request = await tx.get<StorageDeletionRequest>(`deletion-request:${object.deletion_request_id}`);
          if (request && request.state === 'pending') { request.state = 'cancelled'; request.revision += 1; await tx.put(`deletion-request:${request.id}`, request); }
        }
        await tx.delete(`funding-block:${id}`);
        if (control.stop_reason === 'Retained storage funding requires renewal.' && !(await tx.list({ prefix: 'funding-block:', limit: 1 })).size) {
          control.stopped = false; control.stop_reason = null;
        }
      }
      object.pending_renewal = null; object.revision += 1;
      await tx.put(objectKey(id), object);
      await this.journal(tx, control, budgets, commit ? 'billing.storage.renewed' : 'billing.storage.renewal_compensated', undefined, object);
      return object;
    });
  }

  async fundingFailure(id: string): Promise<StorageObject> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      const object = await tx.get<StorageObject>(objectKey(id));
      invariant(object, 'storage_not_found', 'Storage object not found.', 404);
      if (object.funding_failure_at) return object;
      object.funding_failure_at = this.at(); object.delete_after = object.commitment_until; object.revision += 1;
      await tx.put(`funding-block:${id}`, true);
      if (!control.stopped) { control.stopped = true; control.stop_reason = 'Retained storage funding requires renewal.'; }
      await tx.put(objectKey(id), object);
      await this.journal(tx, control, [], 'billing.storage.funding_required', undefined, object);
      return object;
    });
  }

  async fenceStorageTransfer(id: string, operationId: string, destination: string): Promise<StorageObject> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      const object = await tx.get<StorageObject>(objectKey(id));
      invariant(object, 'storage_not_found', 'Storage object not found.', 404);
      invariant(!object.placement_handoff_id, 'storage_placement_fenced', 'Complete physical placement before changing the payer.');
      invariant(!await tx.get(`source-transfer-cancelled:${operationId}:${id}`), 'transfer_cancelled', 'The source handoff was cancelled.');
      if (object.state === 'transferring' || object.state === 'transferred') {
        invariant(object.transfer_operation_id === operationId && object.destination_account_id === destination, 'transfer_conflict', 'A different ownership handoff is active.');
        return object;
      }
      invariant(object.state === 'stored' && !object.pending_renewal, 'storage_not_quiescent', 'Finish upload and funding reconciliation before transferring storage.');
      object.state = 'transferring'; object.transfer_operation_id = operationId; object.destination_account_id = destination; object.revision += 1;
      await tx.put(objectKey(id), object);
      await this.journal(tx, control, [], 'billing.storage.owner_fenced', undefined, object);
      return object;
    });
  }

  async activateStorageImport(id: string, operationId: string, effectiveAt: string): Promise<StorageObject> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      const object = await tx.get<StorageObject>(objectKey(id));
      invariant(object?.import_source?.operation_id === operationId, 'transfer_conflict', 'The receiving storage reservation is not prepared.');
      if (object.state === 'stored') { invariant(object.transferred_at === effectiveAt, 'transfer_conflict', 'The owner-at-consumption boundary is immutable.'); return object; }
      invariant(object.state === 'transfer_pending' && object.admission_state === 'ready' && Date.parse(effectiveAt) <= this.clock().getTime()
        && effectiveAt >= object.created_at, 'transfer_not_ready', 'Prepare both funding participants before activating the receiver.');
      const shift = Date.parse(effectiveAt) - Date.parse(object.created_at);
      const funded = Math.min(Date.parse(object.funded_until!) + shift, object.retention_until ? Date.parse(object.retention_until) : Infinity);
      object.funded_until = new Date(funded).toISOString();
      object.commitment_until = new Date(funded + object.renewal_policy!.deletion_grace_seconds * 1000).toISOString();
      object.renew_after = object.retention_until === null || funded < Date.parse(object.retention_until)
        ? new Date(funded - object.renewal_policy!.renew_before_seconds * 1000).toISOString() : null;
      object.accrued_at = effectiveAt; object.transferred_at = effectiveAt; object.state = 'stored'; object.revision += 1;
      if (control.kind === 'capacity' && object.import_source.reuse_physical_quota) {
        const source = await tx.get<StorageObject>(objectKey(object.import_source.source_platform_object_id));
        invariant(source?.state === 'transferring' && source.transfer_operation_id === operationId, 'transfer_source_changed', 'The physical storage quota source changed.');
        source.quota_handed_off = true; source.revision += 1;
        await tx.put(objectKey(source.id), source);
        await this.journal(tx, control, [], 'billing.storage.capacity_handed_off', undefined, source);
      }
      await tx.put(objectKey(id), object);
      await this.journal(tx, control, [], 'billing.storage.owner_activated', undefined, object);
      return object;
    });
  }

  async abortStorageImport(id: string, operationId: string): Promise<StorageObject | { aborted: true }> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      const object = await tx.get<StorageObject>(objectKey(id));
      await tx.put(`transfer-cancelled:${operationId}:${id}`, true);
      if (object?.import_source?.operation_id !== operationId) return { aborted: true };
      if (object.state === 'deleted' && object.admission_state === 'cancelled') return object;
      invariant(object.state === 'transfer_pending', 'transfer_already_active', 'An activated owner cannot be cancelled as an unstarted transfer.');
      const budgets = await this.relatedBudgets(tx, control, object.attribution, object.budget_started_at);
      await this.adjust(tx, control, budgets, object.attribution, { commitment: -units(object.commitment_units) });
      if (!(control.kind === 'capacity' && object.import_source.reuse_physical_quota)) {
        await this.moveBytes(tx, control, object.attribution.repo_id, 0n, -units(object.bytes)); control.object_count = (control.object_count ?? 1) - 1;
      }
      object.state = 'deleted'; object.admission_state = 'cancelled'; object.commitment_units = '0'; object.revision += 1;
      await tx.put(`storage-cancelled:${object.reservation_id}`, object.fence);
      await tx.put(objectKey(id), object); await tx.delete(`stored:${id}`);
      await this.journal(tx, control, budgets, 'billing.storage.owner_import_aborted', undefined, object);
      return object;
    });
  }

  async resumeStorageOwner(id: string, operationId: string): Promise<StorageObject> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      const object = await tx.get<StorageObject>(objectKey(id));
      invariant(object, 'storage_not_found', 'Storage object not found.', 404);
      await tx.put(`source-transfer-cancelled:${operationId}:${id}`, true);
      if (object.state === 'stored') return object;
      invariant(object.transfer_operation_id === operationId, 'transfer_conflict', 'Storage ownership fence changed.');
      invariant(object.state === 'transferring' && !object.quota_handed_off, 'transfer_already_active', 'A committed handoff cannot resume its former owner.');
      object.state = 'stored'; object.destination_account_id = undefined; object.revision += 1;
      await tx.put(objectKey(id), object);
      await this.journal(tx, control, [], 'billing.storage.owner_resumed', undefined, object);
      return object;
    });
  }

  async prepare(input: { id: string; fence: string; request_hash: string; quote: ExecutionQuote }): Promise<Reservation> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      let reservation = await tx.get<Reservation>(key(input.id));
      if (reservation) {
        invariant(reservation.request_hash === input.request_hash && reservation.fence === input.fence,
          'idempotency_conflict', 'This attempt generation already has a different admission request.');
        if (reservation.state !== 'queued') return reservation;
      } else {
        canAdmit(control, this.at());
        const queued = await tx.list<QueueTicket>({ prefix: 'queue:', limit: control.max_queue + 1 });
        invariant(queued.size < control.max_queue, 'queue_full', 'The fair admission queue is full.', 429);
        control.next_ticket = integer(control.next_ticket + 1, 'ticket');
        reservation = this.newReservation(input, control);
        await tx.put(`queue:${pad(reservation.ticket)}`, { id: reservation.id, fair_key: reservation.fair_key, ticket: reservation.ticket });
      }
      const budgets = await this.budgets(tx, control);
      if (await this.isTurn(tx, control, reservation) && control.active_slots + slots(control, reservation.quote) <= control.max_concurrency) {
        await this.hold(tx, control, budgets, reservation);
      }
      reservation.revision += 1;
      await tx.put(key(reservation.id), reservation);
      await this.journal(tx, control, budgets, 'billing.reservation.prepared', reservation);
      return reservation;
    });
  }

  async markReserved(id: string, fence: string): Promise<Reservation> {
    return this.transition(id, fence, ['preparing', 'prepared'], 'reserved');
  }

  async beginStart(id: string, fence: string, runtimeId: string): Promise<Reservation> {
    invariant(runtimeId.length > 0 && runtimeId.length <= 256, 'runtime_required', 'A stable runtime/allocation ID is required.', 422);
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      const r = await this.fenced(tx, id, fence);
      if (r.state === 'starting' || r.state === 'running') {
        invariant(r.runtime_id === runtimeId, 'runtime_conflict', 'A reservation can allocate only its original runtime.');
        return r;
      }
      canAdmit(control, this.at());
      invariant(r.state === 'reserved', 'reservation_not_ready', 'All budget participants must commit before allocation.');
      r.state = 'starting';
      r.runtime_id = runtimeId;
      r.started_at = this.at();
      r.deadline_at = new Date(this.clock().getTime() + r.quote.duration_ms).toISOString();
      r.revision += 1;
      await tx.put(key(id), r);
      await this.journal(tx, control, [], 'billing.execution.starting', r);
      return r;
    });
  }

  async markRunning(id: string, fence: string): Promise<Reservation> {
    return this.transition(id, fence, ['starting'], 'running');
  }

  async cancel(id: string, fence: string, tombstone?: { request_hash: string; quote: ExecutionQuote }): Promise<Reservation> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      let r = await tx.get<Reservation>(key(id));
      if (!r) {
        invariant(tombstone, 'reservation_not_found', 'Reservation not found.', 404);
        r = this.newReservation({ id, fence, ...tombstone }, control);
      }
      invariant(r.fence === fence, 'stale_reservation', 'Reservation fence is stale.');
      if (r.state === 'cancelled') return r;
      invariant(!['starting', 'running', 'settled'].includes(r.state), 'termination_required', 'A started or uncertain runtime requires verified termination before releasing its hold.');
      const budgets = await this.relatedBudgets(tx, control, r.quote.attribution, r.held_at ?? r.created_at);
      if (r.state !== 'queued') {
        await this.adjust(tx, control, budgets, r.quote.attribution, { reserved: -units(r.held_units) });
        control.active_slots -= slots(control, r.quote);
        await this.moveBytes(tx, control, r.quote.attribution.repo_id, -units(r.unassigned_storage_bytes), 0n);
      }
      r.state = 'cancelled';
      r.held_units = '0';
      r.unassigned_storage_units = '0';
      r.unassigned_storage_bytes = '0';
      r.revision += 1;
      await tx.delete(`queue:${pad(r.ticket)}`);
      await tx.delete(`active:${r.id}`);
      await tx.put(key(id), r);
      await this.journal(tx, control, budgets, 'billing.reservation.cancelled', r);
      return r;
    });
  }

  async settle(input: SettleExecutionInput, hash: string): Promise<Reservation> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      const r = await this.fenced(tx, input.reservation_id, input.fence);
      if (r.state === 'settled') {
        invariant(r.settlement_hash === hash, 'settlement_conflict', 'A different receipt already settled this reservation.');
        return r;
      }
      this.validateTermination(r, input);
      const usedEvent = await tx.get<string>(`settlement-event:${input.event_id}`);
      invariant(!usedEvent || usedEvent === r.id, 'meter_event_conflict', 'A meter event cannot settle two attempts.');
      await tx.put(`settlement-event:${input.event_id}`, r.id);
      const budgets = await this.relatedBudgets(tx, control, r.quote.attribution, r.held_at ?? r.created_at);
      const platform = control.kind === 'capacity';
      const ledger: LedgerEntry[] = [];
      ledger.push(await this.charge(tx, r, r.quote.rates.compute, String(input.duration_ms), input.event_id, input.termination_proof.receipt_id, platform));
      ledger.push(await this.charge(tx, r, r.quote.rates.egress, input.egress_bytes ?? '0', input.event_id, input.termination_proof.receipt_id, platform));
      if (!platform) {
        const waived = input.outcome === 'infrastructure_failure';
        const quantities = [waived ? '0' : String(Math.min(input.duration_ms, r.quote.duration_ms)),
          waived ? '0' : (units(input.egress_bytes ?? '0') < units(r.quote.egress_bytes) ? input.egress_bytes ?? '0' : r.quote.egress_bytes)];
        for (const [index, rate] of [r.quote.rates.compute, r.quote.rates.egress].entries()) {
          const refund = await this.refundUnbillable(tx, ledger[index]!, rate, quantities[index]!);
          if (refund) ledger.push(refund);
        }
      }
      const actual = ledger.reduce((sum, item) => sum + signedUnits(item.amount_units), 0n);
      const overrun = input.duration_ms > r.quote.duration_ms || units(input.egress_bytes ?? '0') > units(r.quote.egress_bytes)
        || actual > units(r.held_units) - units(r.unassigned_storage_units);
      await this.adjust(tx, control, budgets, r.quote.attribution, { reserved: -units(r.held_units), settled: actual });
      await this.moveBytes(tx, control, r.quote.attribution.repo_id, -units(r.unassigned_storage_bytes), 0n);
      control.active_slots -= slots(control, r.quote);
      if (overrun || budgets.some((budget) => available(budget) < 0n)) this.stopForOverrun(control);
      r.state = 'settled';
      r.settlement_hash = hash;
      r.settled_at = this.at();
      r.actual_units = actual.toString();
      r.held_units = '0';
      r.unassigned_storage_units = '0';
      r.unassigned_storage_bytes = '0';
      r.revision += 1;
      await tx.put(key(r.id), r);
      await tx.delete(`active:${r.id}`);
      await this.journal(tx, control, budgets, 'billing.execution.settled', r, undefined, ledger);
      return r;
    });
  }

  async reserveObject(input: ReserveStorageInput): Promise<StorageObject> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      const r = await this.fenced(tx, input.reservation_id, input.fence);
      const previous = await tx.get<StorageObject>(objectKey(input.object_id));
      if (previous) {
        invariant(previous.reservation_id === r.id && previous.fence === input.fence && previous.key === input.key
          && previous.bucket === input.bucket && previous.maximum_bytes === input.maximum_bytes && previous.retention_until === input.retention_until,
        'storage_conflict', 'Object ID is already bound to a different immutable upload.');
        return previous;
      }
      invariant(r.state === 'running', 'attempt_not_running', 'Storage upload requires a running admitted attempt.');
      invariant(r.deadline_at && r.deadline_at > this.at(), 'upload_admission_expired', 'The upload admission deadline has expired.');
      invariant(r.object_count < r.quote.maximum_objects, 'object_quota', 'The attempt object-count limit was reached.', 422);
      invariant((control.object_count ?? 0) < (control.max_objects ?? 100_000), 'object_quota', 'The account retained-object quota was reached.', 422);
      const retention = Date.parse(input.retention_until) - this.clock().getTime();
      invariant(Number.isSafeInteger(retention) && retention > 0 && retention <= r.quote.storage_retention_ms,
        'retention_limit', 'Object retention exceeds its reserved lifetime.', 422);
      const quantity = units(input.maximum_bytes) * BigInt(retention + r.quote.storage_cleanup_grace_ms);
      const hold = units(maximumCharge(quantity.toString(), r.quote.rates.storage, control.kind === 'capacity'));
      invariant(units(input.maximum_bytes) <= units(r.unassigned_storage_bytes) && hold <= units(r.unassigned_storage_units),
        'storage_quota', 'The upload exceeds the pre-reserved byte or retention allowance.', 422);
      const existingKey = await tx.get<string>(`object-key:${input.bucket}:${input.key}`);
      invariant(!existingKey, 'immutable_object_key', 'Every metered upload requires a new immutable object key.');
      const object: StorageObject = {
        id: input.object_id, account_id: input.account_id, reservation_id: r.id, fence: r.fence, key: input.key, bucket: input.bucket,
        state: 'uploading', source: 'execution', slice_id: r.quote.slice_id, storage_cell_id: r.quote.execution_cell_id, admission_state: 'ready', maximum_bytes: input.maximum_bytes, bytes: '0', commitment_units: hold.toString(),
        budget_ids: r.budget_ids, attribution: r.quote.attribution, rate: r.quote.rates.storage,
        etag: null, checksum: null, created_at: this.at(), budget_started_at: r.held_at ?? r.created_at, accrued_at: this.at(), retention_until: input.retention_until,
        commitment_until: new Date(Date.parse(input.retention_until) + r.quote.storage_cleanup_grace_ms).toISOString(), deleted_at: null, revision: 1,
      };
      r.unassigned_storage_units = (units(r.unassigned_storage_units) - hold).toString();
      r.held_units = (units(r.held_units) - hold).toString();
      r.unassigned_storage_bytes = (units(r.unassigned_storage_bytes) - units(input.maximum_bytes)).toString();
      r.object_count += 1;
      control.object_count = (control.object_count ?? 0) + 1;
      r.revision += 1;
      await tx.put(`object-key:${input.bucket}:${input.key}`, object.id);
      await tx.put(objectKey(object.id), object);
      await tx.put(`stored:${object.id}`, object.id);
      await tx.put(key(r.id), r);
      await this.journal(tx, control, [], 'billing.storage.reserved', r, object);
      return object;
    });
  }

  async commitObject(input: CommitStorageInput): Promise<StorageObject> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      const object = await this.fencedObject(tx, input.object_id, input.reservation_id, input.fence);
      if (object.state !== 'uploading') {
        invariant(object.bytes === input.bytes && object.etag === input.etag && object.checksum === input.checksum,
          'storage_conflict', 'The immutable object has different contents.');
        return object;
      }
      invariant(units(input.bytes) <= units(object.maximum_bytes), 'storage_quota', 'Uploaded bytes exceed the admitted limit.', 422);
      invariant(/^[a-f0-9]{64}$/.test(input.checksum), 'checksum_required', 'An object requires a SHA-256 checksum.', 422);
      const budgets = await this.relatedBudgets(tx, control, object.attribution, object.budget_started_at);
      const quantity = units(input.bytes) * BigInt(Date.parse(object.commitment_until) - Date.parse(object.created_at));
      const commitment = units(maximumCharge(quantity.toString(), object.rate, control.kind === 'capacity'));
      await this.adjust(tx, control, budgets, object.attribution, { reserved: -units(object.commitment_units), commitment });
      invariant(object.admission_state === undefined || object.admission_state === 'ready', 'storage_not_admitted', 'All storage budget participants must commit before upload acceptance.');
      await this.moveBytes(tx, control, object.attribution.repo_id, -units(object.maximum_bytes), units(input.bytes));
      object.state = 'stored';
      object.bytes = input.bytes;
      object.commitment_units = commitment.toString();
      object.etag = input.etag;
      object.checksum = input.checksum;
      object.accrued_at = input.uploaded_at ?? this.at();
      object.revision += 1;
      await tx.put(objectKey(object.id), object);
      await this.journal(tx, control, budgets, 'billing.storage.committed', undefined, object);
      return object;
    });
  }

  async accrueObject(id: string, through: string, deleted = false, transferOperation?: string, placementOperation?: string): Promise<StorageObject> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      const object = await tx.get<StorageObject>(objectKey(id));
      invariant(object, 'storage_not_found', 'Storage object not found.', 404);
      if (object.state === 'deleted' || object.state === 'transferred') return object;
      if (object.placement_handoff_id && object.placement_handoff_id !== placementOperation) return object;
      if (object.state === 'transferring' && !transferOperation) return object;
      if (transferOperation) invariant(object.state === 'transferring' && object.transfer_operation_id === transferOperation, 'transfer_fenced', 'Storage ownership handoff changed.');
      if ((!deleted && object.state === 'deleting') || object.pending_renewal) return object;
      invariant(object.state === 'stored' || object.state === 'deleting' || !!transferOperation, 'upload_incomplete', 'An unfinished upload cannot release its storage hold.');
      const end = Date.parse(through);
      invariant(Number.isSafeInteger(end) && end <= this.clock().getTime(), 'invalid_accrual', 'Storage accrual requires an observed timestamp.', 422);
      if (transferOperation) invariant(end >= Date.parse(object.accrued_at), 'transfer_boundary_stale', 'A handoff cannot predate already-metered consumption.');
      if (end < Date.parse(object.accrued_at) || (!deleted && !transferOperation && end === Date.parse(object.accrued_at))) return object;
      const entries: LedgerEntry[] = [];
      let cursor = Date.parse(object.accrued_at);
      do {
        const boundary = Math.min(Date.parse(monthWindow(new Date(cursor)).period_end), end);
        const at = new Date(boundary).toISOString();
        const billable = units(object.bytes) * BigInt(Math.max(0, Math.min(boundary, Date.parse(object.commitment_until), Date.parse(object.billable_until ?? object.commitment_until))
          - Math.max(cursor, Date.parse(object.billable_from ?? object.created_at))));
        const placementCustomer = control.kind === 'account' && !!object.placement_handoff_id;
        const quantity = placementCustomer ? billable : units(object.bytes) * BigInt(boundary - cursor);
        const entry = await this.charge(tx, object, object.rate, quantity.toString(), `storage:${object.account_id}:${object.id}:${at}${transferOperation ? `:transfer:${transferOperation}` : deleted ? ':deleted' : ''}`, object.etag ?? object.id,
          control.kind === 'capacity', object.id, new Date(cursor).toISOString(), (deleted || !!transferOperation) && boundary === end);
        entries.push(entry);
        if (control.kind === 'account' && !placementCustomer) {
          const refund = await this.refundUnbillable(tx, entry, object.rate, billable.toString(), object.id);
          if (refund) entries.push(refund);
        }
        cursor = boundary;
      } while (cursor < end);
      const actual = entries.reduce((sum, entry) => sum + signedUnits(entry.amount_units), 0n);
      const held = units(object.commitment_units);
      const consumed = actual > held ? held : actual;
      const budgets = await this.relatedBudgets(tx, control, object.attribution, object.budget_started_at);
      const closing = deleted || !!transferOperation;
      await this.adjust(tx, control, budgets, object.attribution, { commitment: -(closing ? held : consumed), settled: actual });
      object.commitment_units = closing ? '0' : (held - consumed).toString();
      object.accrued_at = through;
      if (actual > held || (!closing && through >= object.commitment_until)) this.stopForOverrun(control);
      if (closing) {
        object.state = transferOperation ? 'transferred' : 'deleted';
        if (transferOperation) object.transferred_at = through;
        else object.deleted_at = through;
        if (!object.quota_handed_off) {
          await this.moveBytes(tx, control, object.attribution.repo_id, 0n, -units(object.bytes));
          control.object_count = (control.object_count ?? 1) - 1;
        }
        await tx.delete(`stored:${object.id}`);
        if (deleted && object.deletion_request_id) {
          const request = await tx.get<StorageDeletionRequest>(`deletion-request:${object.deletion_request_id}`);
          if (request) { request.state = 'financially_deleted'; request.revision += 1; await tx.put(`deletion-request:${request.id}`, request); }
        }
      }
      object.revision += 1;
      await tx.put(objectKey(id), object);
      await this.journal(tx, control, budgets, transferOperation ? 'billing.storage.owner_settled' : deleted ? 'billing.storage.deleted' : 'billing.storage.accrued', undefined, object, entries);
      return object;
    });
  }

  async beginDelete(id: string, placementOperation?: string): Promise<StorageObject> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      const object = await tx.get<StorageObject>(objectKey(id));
      invariant(object, 'storage_not_found', 'Storage object not found.', 404);
      invariant(!object.placement_handoff_id || object.placement_handoff_id === placementOperation, 'storage_placement_fenced', 'Physical placement owns this deletion fence.');
      if (object.state === 'deleted' || object.deletion_started_at) return object;
      invariant(object.state === 'stored' || object.state === 'deleting', 'upload_incomplete', 'Finish or reconcile the uploader before physical deletion.');
      object.state = 'deleting';
      object.deletion_started_at = this.at();
      object.revision += 1;
      await tx.put(objectKey(id), object);
      await this.journal(tx, control, [], 'billing.storage.deleting', undefined, object);
      return object;
    });
  }

  async setStop(stopped: boolean, reason: string | null, revision: number, command?: BillingCommand): Promise<AdmissionControl> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      if (await this.existingCommand(tx, command, 'stop')) return control;
      invariant(control.revision === revision, 'revision_conflict', 'Admission state changed.', 412);
      if (!stopped) {
        const budgets = await this.budgets(tx, control);
        invariant(budgets.every((b) => available(b) >= 0n), 'budget_exhausted', 'Reconcile outstanding cost before resuming.');
      }
      control.stopped = stopped;
      control.stop_reason = stopped ? reason : null;
      if (command) await tx.put(`command:${command.id}`, { ...command, kind: 'stop', resource_id: control.account_id ?? control.id, revision: control.revision + 1 });
      await this.journal(tx, control, [], stopped ? 'billing.execution.stopped' : 'billing.execution.resumed');
      return control;
    });
  }

  async putBudget(input: Budget, expectedRevision: number | null, command?: BillingCommand): Promise<Budget> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      const receipt = await this.existingCommand(tx, command, 'budget');
      if (receipt) {
        const committed = await tx.get<Budget>(`budget:${receipt.resource_id}`);
        invariant(committed, 'budget_unavailable', 'The committed budget requires reconciliation.', 503);
        return committed;
      }
      invariant(control.kind === 'account' && control.account_id === input.account_id, 'budget_scope', 'Budget belongs to a different account.', 404);
      const previous = await tx.get<Budget>(`budget:${input.id}`);
      const budget = { ...input };
      if (previous) {
        invariant(previous.revision === expectedRevision, 'revision_conflict', 'Budget changed.', 412);
        invariant(previous.scope === input.scope && previous.scope_id === input.scope_id && previous.period_start === input.period_start
          && previous.period_end === input.period_end, 'immutable_budget_scope', 'A budget window and resource scope are immutable.', 422);
        Object.assign(budget, { settled_units: previous.settled_units, reserved_units: previous.reserved_units, commitment_units: previous.commitment_units, revision: previous.revision + 1 });
      } else {
        invariant(expectedRevision === null && control.budget_ids.length < 128, 'budget_configuration', 'The account budget set is full or changed.');
        budget.period_start = this.at();
        invariant(!budget.period_end || budget.period_end > budget.period_start, 'invalid_budget_window', 'A new cap must end after its actual admission time.', 422);
        const counters = await tx.get<Counters>(`counter:${input.scope}:${input.scope_id}`);
        Object.assign(budget, { settled_units: '0', reserved_units: counters?.reserved_units ?? '0', commitment_units: counters?.commitment_units ?? '0', revision: 1 });
        control.budget_ids.push(budget.id);
      }
      invariant(available(budget) >= 0n, 'budget_below_commitments', 'The cap cannot be below settled cost, outstanding reservations, storage commitments and its safety buffer.', 422);
      await tx.put(`budget:${budget.id}`, budget);
      if (command) await tx.put(`command:${command.id}`, { ...command, kind: 'budget', resource_id: budget.id, revision: budget.revision });
      await this.journal(tx, control, [budget], 'billing.budget.updated');
      return budget;
    });
  }

  async updateLimits(input: { max_concurrency: number; max_storage_bytes: string; valid_until?: string }, revision: number): Promise<AdmissionControl> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      invariant(control.revision === revision, 'revision_conflict', 'Admission state changed.', 412);
      integer(input.max_concurrency, 'max_concurrency', 10_000);
      invariant(input.max_concurrency >= control.active_slots && units(input.max_storage_bytes) >= units(control.stored_bytes) + units(control.reserved_bytes),
        'entitlement_in_use', 'Current reservations exceed the requested entitlement.', 422);
      control.max_concurrency = input.max_concurrency;
      control.max_storage_bytes = input.max_storage_bytes;
      if (input.valid_until) control.valid_until = input.valid_until;
      await this.journal(tx, control, [], 'billing.entitlements.updated');
      return control;
    });
  }

  async closePeriod(through: string, verifiedRevision: number): Promise<void> {
    await this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      invariant(control.revision === verifiedRevision, 'billing_conflict', 'Usage changed while closing the period; retry.', 409);
      invariant(through <= this.at(), 'period_open', 'An invoice period must have ended.', 422);
      if (control.closed_through && control.closed_through >= through) return;
      control.closed_through = through;
      await this.journal(tx, control, [], 'billing.period.closed');
    });
  }

  async standingCommitment(input: { id: string; amount_units: string; settle_units?: string }): Promise<void> {
    await this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      const budgets = await this.applyStandingCommitment(tx, control, input);
      if (budgets) await this.journal(tx, control, budgets, input.settle_units === undefined ? 'billing.fixed_cost.reserved' : 'billing.fixed_cost.settled');
    });
  }

  private async applyStandingCommitment(tx: BillingTransaction, control: AdmissionControl,
    input: { id: string; amount_units: string; settle_units?: string }): Promise<Budget[] | null> {
    invariant(control.kind === 'account' && control.account_id, 'fee_scope', 'Subscription commitments belong to a billing account.', 422);
    const old = await tx.get<{ amount_units: string; settled_units: string | null; budget_started_at: string }>(`fee:${input.id}`);
    if (old?.settled_units !== undefined && old.settled_units !== null) {
      invariant(old.settled_units === input.settle_units, 'fee_conflict', 'The fixed charge was already settled.');
      return null;
    }
    const a: Attribution = { account_id: control.account_id, repo_id: null, actor_id: '', workflow_id: null, team_id: null, run_id: null, attempt_id: null, generation: null };
    const budgets = (await this.relatedBudgets(tx, control, a, old?.budget_started_at ?? this.at())).filter((b) => b.scope === 'account');
    const previous = units(old?.amount_units ?? '0'), requested = units(input.amount_units);
    const next = input.settle_units === undefined ? (requested > previous ? requested : previous) : 0n;
    if (old && input.settle_units === undefined && next === previous) return null;
    const settled = input.settle_units === undefined ? 0n : units(input.settle_units);
    for (const budget of budgets) invariant(next - previous + settled <= available(budget), 'budget_exhausted', 'Subscription or seat commitments exceed the account cap.');
    await this.adjust(tx, control, budgets, a, { commitment: next - previous, settled });
    await tx.put(`fee:${input.id}`, { amount_units: next.toString(), settled_units: input.settle_units ?? null, budget_started_at: old?.budget_started_at ?? this.at() });
    return budgets;
  }

  async rolloverPeriod(start: string, end: string, recurringUnits: string, previousFee: { id: string; amount_units: string }): Promise<void> {
    await this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      invariant(control.kind === 'account' && control.account_id, 'period_scope', 'Only account budgets roll over.', 422);
      if (control.valid_until >= end) return;
      invariant(control.closed_through && control.closed_through >= start && start < end, 'period_not_closed', 'Close and settle the previous period first.');
      await this.applyStandingCommitment(tx, control, { ...previousFee, settle_units: previousFee.amount_units });
      const previous = await tx.get<Budget>(`budget:${control.plan_budget_id}`);
      invariant(previous, 'budget_unavailable', 'The plan cap is unavailable.', 503);
      const feeId = `subscription:${start}`;
      const nextFee = await tx.get<{ amount_units: string; settled_units: string | null; budget_started_at: string }>(`fee:${feeId}`);
      invariant(!nextFee?.settled_units, 'period_fee_settled', 'The next subscription period is already settled.');
      const alreadyHeld = units(nextFee?.amount_units ?? '0');
      const recurring = units(recurringUnits) > alreadyHeld ? units(recurringUnits) : alreadyHeld;
      const delta = recurring - alreadyHeld;
      const counters = await tx.get<Counters>(`counter:account:${control.account_id}`) ?? { reserved_units: '0', commitment_units: '0', settled_units: '0' };
      const budget: Budget = { ...previous, id: `budget:${control.id}:period:${start}`, period_start: start, period_end: null,
        settled_units: '0', reserved_units: counters.reserved_units, commitment_units: (units(counters.commitment_units) + delta).toString(), revision: 1 };
      invariant(available(budget) >= 0n, 'carried_commitments', 'The new period cap must cover outstanding runtime and retained-storage commitments.');
      previous.period_end = start;
      move(previous, { commitment: -alreadyHeld });
      previous.revision += 1;
      await tx.put(`budget:${previous.id}`, previous);
      const all = await this.budgets(tx, control);
      const ongoing = all.filter(b => b.id !== previous.id && b.scope === 'account' && b.period_start <= this.at() && (!b.period_end || b.period_end > start));
      for (const b of ongoing) invariant(available(b) >= delta, 'budget_exhausted', 'Recurring subscription and seat commitments exceed an account cap.');
      const attribution: Attribution = { account_id: control.account_id, repo_id: null, actor_id: '', workflow_id: null, team_id: null, run_id: null, attempt_id: null, generation: null };
      await this.adjust(tx, control, ongoing, attribution, { commitment: delta });
      for (const b of all.filter(b => b.id !== previous.id && b.scope === 'account' && b.period_end && b.period_end <= start && nextFee && nextFee.budget_started_at < b.period_end)) {
        move(b, { commitment: -alreadyHeld }); b.revision += 1; await tx.put(`budget:${b.id}`, b);
      }
      await tx.put(`fee:${feeId}`, { amount_units: recurring.toString(), settled_units: null, budget_started_at: start });
      await tx.put(`budget:${budget.id}`, budget);
      control.budget_ids = all.filter((b) => !b.period_end || b.reserved_units !== '0' || b.commitment_units !== '0').map((b) => b.id);
      control.budget_ids.push(budget.id);
      invariant(control.budget_ids.length <= 128, 'budget_configuration', 'Archive settled budget windows before renewing admission.', 503);
      control.plan_budget_id = budget.id;
      control.valid_until = end;
      const changed = await Promise.all(all.map(b => tx.get<Budget>(`budget:${b.id}`)));
      await this.journal(tx, control, [...changed.filter((b): b is Budget => !!b), budget], 'billing.period.renewed');
    });
  }

  protected at(): string { return this.clock().toISOString(); }

  protected async control(tx: BillingTransaction): Promise<AdmissionControl> {
    const control = await tx.get<AdmissionControl>('control');
    invariant(control, 'admission_uninitialized', 'Billing admission has not been initialized.', 503);
    return control;
  }

  private async existingCommand(tx: BillingTransaction, command: BillingCommand | undefined, kind: BillingCommandReceipt['kind']): Promise<BillingCommandReceipt | undefined> {
    if (!command) return undefined;
    const receipt = await tx.get<BillingCommandReceipt>(`command:${command.id}`);
    invariant(!receipt || (receipt.request_hash === command.request_hash && receipt.kind === kind), 'command_conflict', 'The operation identity already identifies different billing inputs.');
    return receipt;
  }

  protected async budgets(tx: BillingTransaction, control: AdmissionControl): Promise<Budget[]> {
    const result: Budget[] = [];
    for (const id of control.budget_ids) {
      const budget = await tx.get<Budget>(`budget:${id}`);
      invariant(budget, 'admission_corrupt', 'An applicable budget is unavailable.', 503);
      result.push(budget);
    }
    return result;
  }

  protected async relatedBudgets(tx: BillingTransaction, control: AdmissionControl, a: Attribution, createdAt: string): Promise<Budget[]> {
    const all = await this.budgets(tx, control);
    return all.filter((b) => (control.kind === 'capacity' || applies(b, a)) && b.period_start <= this.at() && (!b.period_end || createdAt < b.period_end));
  }

  private newReservation(input: { id: string; fence: string; request_hash: string; quote: ExecutionQuote }, control: AdmissionControl): Reservation {
    return {
      id: input.id, fence: input.fence, request_hash: input.request_hash, quote: input.quote, state: 'queued', budget_ids: [],
      held_units: '0', unassigned_storage_units: '0', unassigned_storage_bytes: '0', object_count: 0,
      ticket: control.next_ticket, fair_key: control.kind === 'capacity' ? input.quote.attribution.account_id : input.quote.attribution.repo_id,
      runtime_id: null, started_at: null, deadline_at: null, settled_at: null, settlement_hash: null, actual_units: null, created_at: this.at(), held_at: null, revision: 1,
    };
  }

  private async isTurn(tx: BillingTransaction, control: AdmissionControl, r: Reservation): Promise<boolean> {
    const tickets = await tx.list<QueueTicket>({ prefix: 'queue:', limit: control.max_queue + 1 });
    const heads = new Map<string, QueueTicket>();
    for (const ticket of tickets.values()) if (!heads.has(ticket.fair_key)) heads.set(ticket.fair_key, ticket);
    let winner: QueueTicket | undefined;
    let winnerTurn = Number.MAX_SAFE_INTEGER;
    for (const head of heads.values()) {
      const candidate = head.id === r.id ? r : await tx.get<Reservation>(key(head.id));
      if (!candidate || control.active_slots + slots(control, candidate.quote) > control.max_concurrency) continue;
      const turn = (await tx.get<number>(`fair:${head.fair_key}`)) ?? 0;
      if (turn < winnerTurn || (turn === winnerTurn && head.ticket < (winner?.ticket ?? Infinity))) {
        winner = head;
        winnerTurn = turn;
      }
    }
    return winner?.id === r.id;
  }

  private async hold(tx: BillingTransaction, control: AdmissionControl, all: Budget[], r: Reservation): Promise<void> {
    canAdmit(control, this.at());
    if (control.closed_through && r.created_at < control.closed_through) r.created_at = this.at();
    const budgets = all.filter((b) => (control.kind === 'capacity' || applies(b, r.quote.attribution))
      && b.period_start <= this.at() && (!b.period_end || this.at() < b.period_end));
    invariant(budgets.some((b) => b.scope === 'account'), 'account_budget_required', 'An active account operating cap is required.', 503);
    const amount = units(control.kind === 'capacity' ? r.quote.maximum_platform_units : r.quote.maximum_charge_units);
    for (const budget of budgets) {
      if (budget.stopped || available(budget) < amount) throw new BillingError('budget_exhausted', 'The maximum charge does not fit all applicable caps.', 409, { budget_id: budget.id, available_units: available(budget).toString(), required_units: amount.toString() });
    }
    await this.reserveBytes(tx, control, r.quote.attribution.repo_id, r.quote.storage_bytes, r.quote.repository_storage_limit_bytes);
    await this.adjust(tx, control, budgets, r.quote.attribution, { reserved: amount });
    r.state = control.kind === 'capacity' ? 'prepared' : 'preparing';
    r.held_at = this.at();
    r.budget_ids = budgets.map((b) => b.id);
    r.held_units = amount.toString();
    r.unassigned_storage_units = control.kind === 'capacity' ? r.quote.platform_storage_units : r.quote.storage_charge_units;
    r.unassigned_storage_bytes = r.quote.storage_bytes;
    control.active_slots += slots(control, r.quote);
    await tx.put(`fair:${r.fair_key}`, control.next_event + 1);
    await tx.put(`active:${r.id}`, r.id);
    await tx.delete(`queue:${pad(r.ticket)}`);
  }

  protected async adjust(tx: BillingTransaction, control: AdmissionControl, budgets: Budget[], a: Attribution, change: Change): Promise<void> {
    for (const budget of budgets) {
      move(budget, change);
      budget.revision += 1;
      await tx.put(`budget:${budget.id}`, budget);
    }
    if (control.kind !== 'account') return;
    for (const [scope, id] of scopeKeys(a)) {
      const counterKey = `counter:${scope}:${id}`;
      const counter = (await tx.get<Counters>(counterKey)) ?? { reserved_units: '0', commitment_units: '0', settled_units: '0' };
      move(counter, change);
      await tx.put(counterKey, counter);
    }
  }

  protected async reserveBytes(tx: BillingTransaction, control: AdmissionControl, repoId: string | null, value: string, repositoryLimit?: string): Promise<void> {
    const amount = units(value);
    invariant(units(control.stored_bytes) + units(control.reserved_bytes) + amount <= units(control.max_storage_bytes),
      'storage_quota', 'The authoritative account storage quota is exhausted.');
    if (repoId && control.kind === 'account') {
      const counter = await tx.get<{ reserved: string; stored: string }>(`bytes:${repoId}`) ?? { reserved: '0', stored: '0' };
      invariant(units(counter.reserved) + units(counter.stored) + amount <= units(repositoryLimit ?? control.max_storage_bytes),
        'repository_storage_quota', 'The repository storage quota is exhausted.');
    }
    await this.moveBytes(tx, control, repoId, amount, 0n);
  }

  protected async moveBytes(tx: BillingTransaction, control: AdmissionControl, repoId: string | null, reserved: bigint, stored: bigint): Promise<void> {
    const nextReserved = units(control.reserved_bytes) + reserved, nextStored = units(control.stored_bytes) + stored;
    invariant(nextReserved >= 0n && nextStored >= 0n, 'storage_counter_corrupt', 'Storage quota accounting requires reconciliation.', 503);
    control.reserved_bytes = nextReserved.toString(); control.stored_bytes = nextStored.toString();
    if (!repoId || control.kind === 'capacity') return;
    const counter = await tx.get<{ reserved: string; stored: string }>(`bytes:${repoId}`) ?? { reserved: '0', stored: '0' };
    const repoReserved = units(counter.reserved) + reserved, repoStored = units(counter.stored) + stored;
    invariant(repoReserved >= 0n && repoStored >= 0n, 'storage_counter_corrupt', 'Repository storage accounting requires reconciliation.', 503);
    await tx.put(`bytes:${repoId}`, { reserved: repoReserved.toString(), stored: repoStored.toString() });
  }

  private async fenced(tx: BillingTransaction, id: string, fence: string): Promise<Reservation> {
    const reservation = await tx.get<Reservation>(key(id));
    invariant(reservation, 'reservation_not_found', 'Reservation not found.', 404);
    invariant(reservation.fence === fence, 'stale_reservation', 'Reservation fence is stale.');
    return reservation;
  }

  private async fencedObject(tx: BillingTransaction, id: string, reservationId: string, fence: string): Promise<StorageObject> {
    const object = await tx.get<StorageObject>(objectKey(id));
    invariant(object, 'storage_not_found', 'Object not found.', 404);
    invariant(object.reservation_id === reservationId && object.fence === fence, 'stale_reservation', 'Object reservation fence is stale.');
    return object;
  }

  private async transition(id: string, fence: string, from: Reservation['state'][], state: Reservation['state']): Promise<Reservation> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      const r = await this.fenced(tx, id, fence);
      if (r.state === state || (state === 'reserved' && ['starting', 'running', 'settled'].includes(r.state))) return r;
      invariant(from.includes(r.state), 'reservation_state', 'Reservation transition is fenced by its current state.');
      r.state = state;
      r.revision += 1;
      await tx.put(key(id), r);
      await this.journal(tx, control, [], `billing.reservation.${state}`, r);
      return r;
    });
  }

  private validateTermination(r: Reservation, input: SettleExecutionInput): void {
    invariant(['running', 'starting'].includes(r.state) && r.runtime_id === input.runtime_id,
      'termination_required', 'Settlement must identify the current started runtime.');
    const verified = Date.parse(input.termination_proof.verified_at);
    invariant(Number.isSafeInteger(verified) && verified <= this.clock().getTime() && verified >= Date.parse(r.started_at!),
      'invalid_termination', 'Termination evidence has an invalid observation time.', 422);
    invariant(input.termination_proof.receipt_id.length >= 8, 'termination_required', 'An authenticated teardown receipt is required.', 422);
    integer(input.duration_ms, 'duration_ms');
    units(input.egress_bytes ?? '0', 'egress_bytes');
    if (input.termination_proof.kind === 'never_allocated') invariant(input.duration_ms === 0, 'invalid_termination', 'Never-allocated work has no runtime.', 422);
    if (r.quote.executor === 'hosted') invariant(input.termination_proof.kind !== 'customer_process_exited', 'invalid_termination', 'Hosted runtime settlement requires verified destruction.', 422);
  }

  protected async charge(tx: BillingTransaction, source: Reservation | { attribution: Attribution; reservation_id: string; accrued_at: string }, rate: Rate, quantity: string, eventId: string, evidenceId: string,
    platform: boolean, objectId: string | null = null, occurredAt?: string, closing = false): Promise<LedgerEntry> {
    const a = 'quote' in source ? source.quote.attribution : source.attribution;
    const reservationId = 'quote' in source ? source.id : source.reservation_id;
    const occurred = occurredAt ?? ('quote' in source ? source.started_at ?? source.created_at : source.accrued_at);
    const carryKey = `remainder:${rate.id}:${rate.meter_version}${objectId ? `:${objectId}` : ''}`;
    const before = (await tx.get<string>(carryKey)) ?? '0';
    const charge = meterCharge(quantity, rate, before, platform);
    let closingBefore: string | undefined, closingAfter: string | undefined;
    if (closing) {
      const closingKey = `remainder:closed-storage:${rate.id}:${rate.meter_version}`;
      closingBefore = await tx.get<string>(closingKey) ?? '0';
      const combined = units(closingBefore) + units(charge.remainder);
      charge.amount_units = (units(charge.amount_units) + combined / units(rate.unit_quantity)).toString();
      closingAfter = (combined % units(rate.unit_quantity)).toString();
      charge.remainder = '0';
      await tx.put(closingKey, closingAfter);
    }
    await tx.put(carryKey, charge.remainder);
    return {
      ...a, id: `${eventId}:${platform ? 'platform' : 'account'}:${rate.id}`, event_id: eventId,
      reservation_id: reservationId, object_id: objectId, kind: 'usage', operating_cost: platform, quantity,
      amount_units: charge.amount_units, currency: 'USD', price_id: rate.id, price_version: rate.version,
      meter: rate.meter, meter_version: rate.meter_version, unit_price_units: platform ? rate.platform_unit_price_units : rate.unit_price_units,
      unit_quantity: rate.unit_quantity, remainder_before: before, remainder_after: charge.remainder,
      closing_remainder_before: closingBefore, closing_remainder_after: closingAfter,
      occurred_at: occurred, recorded_at: this.at(), evidence_id: evidenceId,
    };
  }

  protected stopForOverrun(control: AdmissionControl): void {
    control.stopped = true;
    control.stop_reason = 'Measured cost exceeded a bounded commitment; reconcile runtime or storage cleanup before resuming.';
  }

  /** Refund unbillable phases and restore their rational carry, so fractional waived usage cannot leak into a later charge. */
  protected async refundUnbillable(tx: BillingTransaction, entry: LedgerEntry, rate: Rate, billableQuantity: string, objectId?: string): Promise<LedgerEntry | null> {
    if (billableQuantity === entry.quantity) return null;
    const billable = meterCharge(billableQuantity, rate, entry.remainder_before);
    let closingAfter: string | undefined;
    if (entry.closing_remainder_before !== undefined) {
      const numerator = units(entry.closing_remainder_before) + units(billable.remainder);
      billable.amount_units = (units(billable.amount_units) + numerator / units(rate.unit_quantity)).toString();
      closingAfter = (numerator % units(rate.unit_quantity)).toString();
      billable.remainder = '0';
      await tx.put(`remainder:closed-storage:${rate.id}:${rate.meter_version}`, closingAfter);
    }
    await tx.put(`remainder:${rate.id}:${rate.meter_version}${objectId ? `:${objectId}` : ''}`, billable.remainder);
    return { ...entry, id: `${entry.id}:refund`, kind: 'infrastructure_refund', quantity: (units(entry.quantity) - units(billableQuantity)).toString(),
      amount_units: (units(billable.amount_units) - units(entry.amount_units)).toString(), remainder_before: entry.remainder_after,
      remainder_after: billable.remainder, closing_remainder_before: entry.closing_remainder_after, closing_remainder_after: closingAfter };
  }

  protected async journal(tx: BillingTransaction, control: AdmissionControl, budgets: Budget[], eventType: string,
    reservation?: Reservation, object?: StorageObject, ledger: LedgerEntry[] = [], extras: Pick<Journal, 'helper' | 'git_operation' | 'git_meters'> = {}): Promise<void> {
    control.revision += 1;
    control.next_event = integer(control.next_event + 1, 'journal sequence');
    const rollups = await this.rollup(tx, ledger);
    const journal: Journal = {
      id: `billing:${control.id}:${control.epoch}:${control.next_event}`, coordinator_id: control.id,
      sequence: control.next_event, created_at: this.at(), control, budgets, reservation, object, ledger, rollups, event_type: eventType,
      deletion_request: object?.deletion_request_id ? await tx.get<StorageDeletionRequest>(`deletion-request:${object.deletion_request_id}`) : undefined,
      ...extras,
    };
    await tx.put('control', control);
    await tx.put(`journal:${pad(control.next_event)}`, journal);
  }

  private async rollup(tx: BillingTransaction, ledger: LedgerEntry[]): Promise<UsageRollup[]> {
    const changed = new Map<string, UsageRollup>();
    for (const entry of ledger) for (const [dimension, dimensionId] of scopeKeys(entry)) {
      const period = entry.occurred_at.slice(0, 7);
      const key = `usage:${entry.account_id}:${period}:${dimension}:${dimensionId}:${entry.meter}`;
      const rollup = changed.get(key) ?? await tx.get<UsageRollup>(key) ?? {
        account_id: entry.account_id, period, dimension, dimension_id: dimensionId, meter: entry.meter,
        operating_cost: entry.operating_cost, quantity: '0', amount_units: '0', revision: 0,
      };
      rollup.amount_units = (signedUnits(rollup.amount_units) + signedUnits(entry.amount_units)).toString();
      if (entry.kind === 'usage') rollup.quantity = (units(rollup.quantity) + units(entry.quantity)).toString();
      rollup.revision += 1;
      changed.set(key, rollup);
    }
    for (const [key, value] of changed) await tx.put(key, value);
    return [...changed.values()];
  }
}
