import { AdmissionBook } from './book.ts';
import { invariant } from './errors.ts';
import { ceilDivide, maximumCharge, signedUnits, units } from './money.ts';
import type { AdmissionControl, Attribution, BillingTransaction, Budget, LedgerEntry } from './types.ts';
import type { CanonicalGitMeter, CanonicalGitQuote, CanonicalGitReservation, EssentialServiceSettlement, GitFundingWindow, HelperQuote, HelperReservation } from './git-types.ts';
import type { PlacementGitHold } from './placement-types.ts';

const day = (at: string) => at.slice(0, 10);
const dayTime = (at: string) => Date.parse(`${day(at)}T00:00:00.000Z`);
const days = (from: string, until: string) => Math.max(0, Math.floor((dayTime(until) - dayTime(from)) / 86_400_000));
const storeKey = (repo: string, name: string) => `git-store:${repo}:${name}`;
const payer = (account: string, repo: string | null, actor: string): Attribution => ({ account_id: account, repo_id: repo, actor_id: actor, workflow_id: null, team_id: null, run_id: null, attempt_id: null, generation: null });

function fits(budgets: Budget[], amount: bigint): void {
  for (const b of budgets) invariant(!b.stopped && units(b.settled_units) + units(b.reserved_units) + units(b.commitment_units) + amount
    <= units(b.limit_units) - units(b.safety_buffer_units), 'budget_exhausted', 'The complete Git operating or retained-storage bound does not fit all applicable caps.');
}

export class GitAdmissionBook extends AdmissionBook {
  async helperReservation(id: string): Promise<HelperReservation> {
    const value = await this.store.get<HelperReservation>(`helper:${id}`);
    invariant(value, 'helper_reservation_missing', 'Trusted helper admission is unavailable.', 404);
    return value;
  }

  async reserveHelper(quote: HelperQuote): Promise<HelperReservation> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx);
      invariant(control.kind === 'capacity', 'helper_scope', 'Helpers require a platform capacity slice.', 403);
      const old = await tx.get<HelperReservation>(`helper:${quote.reservation_id}`);
      if (old) { invariant(old.request_hash === quote.request_hash && old.fence === quote.fence, 'helper_conflict', 'The allocation ID has different immutable limits.'); return old; }
      invariant(!control.stopped && this.at() < control.valid_until, 'essential_budget_stopped', 'The essential-service allocation is stopped or expired.', 503);
      invariant(control.active_slots < control.max_concurrency, 'essential_capacity_busy', 'All funded trusted-helper slots are in use.', 429);
      const budgets = await this.budgets(tx, control);
      fits(budgets, units(quote.maximum_units));
      const attribution = payer(`platform:${quote.slice_id}`, null, 'system:git-helper');
      await this.adjust(tx, control, budgets, attribution, { reserved: units(quote.maximum_units) });
      control.active_slots += 1;
      const helper: HelperReservation = { ...quote, state: 'reserved', started_at: null, settled_at: null, actual_units: null, settlement_hash: null, revision: 1 };
      await tx.put(`helper:${helper.reservation_id}`, helper);
      await tx.put(`helper-active:${helper.reservation_id}`, helper.reservation_id);
      await this.journal(tx, control, budgets, 'billing.git.helper_reserved', undefined, undefined, [], { helper });
      return helper;
    });
  }

  async startHelper(id: string, fence: string): Promise<void> {
    await this.store.transaction(async (tx) => {
      const control = await this.control(tx), helper = await tx.get<HelperReservation>(`helper:${id}`);
      invariant(helper && helper.fence === fence, 'helper_fenced', 'The helper allocation fence changed.');
      if (helper.state === 'started') return;
      invariant(helper.state === 'reserved' && !control.stopped && this.at() < control.valid_until, 'helper_fenced', 'The helper cannot start under this allocation.');
      invariant(Date.parse(helper.created_at) + helper.input.maximum_duration_ms > Date.parse(this.at()), 'helper_allocation_expired', 'This unstarted allocation must be settled before a new generation can start.');
      helper.state = 'started'; helper.started_at = this.at(); helper.revision += 1;
      await tx.put(`helper:${id}`, helper);
      await this.journal(tx, control, [], 'billing.git.helper_started', undefined, undefined, [], { helper });
    });
  }

  async settleHelper(input: EssentialServiceSettlement, hash: string): Promise<void> {
    await this.store.transaction(async (tx) => {
      const control = await this.control(tx), helper = await tx.get<HelperReservation>(`helper:${input.reservation_id}`);
      invariant(helper && helper.fence === input.fence && helper.input.allocation_id === input.allocation_id, 'helper_fenced', 'The helper settlement does not match its allocation.');
      if (helper.state === 'settled') { invariant(helper.settlement_hash === hash, 'helper_receipt_conflict', 'This allocation already has a different teardown receipt.'); return; }
      const never = input.termination_proof.kind === 'never_allocated';
      invariant(!never || (helper.state === 'reserved' && input.duration_ms === 0 && input.egress_bytes === '0'), 'helper_termination_required', 'A started or uncertain helper requires verified destruction.');
      invariant(input.termination_proof.verified_at >= helper.created_at && input.termination_proof.verified_at <= this.at(), 'helper_receipt_time', 'The helper teardown observation is invalid.', 422);
      invariant(never || input.duration_ms >= Date.parse(input.termination_proof.verified_at) - Date.parse(helper.created_at),
        'helper_duration_unverified', 'The observed helper lifetime cannot omit allocation, startup or teardown.', 422);
      const previousEvent = await tx.get<string>(`helper-event:${input.event_id}`);
      invariant(!previousEvent || previousEvent === helper.reservation_id, 'helper_event_conflict', 'One teardown event cannot settle two allocations.');
      await tx.put(`helper-event:${input.event_id}`, helper.reservation_id);
      const attribution = payer(`platform:${helper.slice_id}`, null, 'system:git-helper');
      const source = { attribution, reservation_id: helper.reservation_id, accrued_at: helper.started_at ?? helper.created_at };
      const quantities = [never ? '0' : ((BigInt(input.duration_ms) + 9n) / 10n * 10n).toString(), never ? '0' : input.egress_bytes, never ? '0' : String(helper.maximum_operations)];
      const rates = [helper.rates.compute, helper.rates.egress, helper.rates.operations];
      const ledger: LedgerEntry[] = [];
      for (const [index, rate] of rates.entries()) ledger.push(await this.charge(tx, source, rate, quantities[index]!, input.event_id, input.termination_proof.receipt_id, true));
      const actual = ledger.reduce((sum, item) => sum + units(item.amount_units), 0n);
      const budgets = await this.budgets(tx, control);
      await this.adjust(tx, control, budgets, attribution, { reserved: -units(helper.maximum_units), settled: actual });
      control.active_slots -= 1;
      if (actual > units(helper.maximum_units) || input.duration_ms > helper.input.maximum_duration_ms || units(input.egress_bytes) > units(helper.input.maximum_egress_bytes)) this.stopForOverrun(control);
      helper.state = 'settled'; helper.actual_units = actual.toString(); helper.settled_at = input.termination_proof.verified_at; helper.settlement_hash = hash; helper.revision += 1;
      await tx.put(`helper:${helper.reservation_id}`, helper);
      await tx.delete(`helper-active:${helper.reservation_id}`);
      await this.journal(tx, control, budgets, 'billing.git.helper_settled', undefined, undefined, ledger, { helper });
    });
  }

  async gitOperation(id: string): Promise<CanonicalGitReservation> {
    const value = await this.store.get<CanonicalGitReservation>(`git-operation:${id}`);
    invariant(value, 'git_reservation_missing', 'The canonical Git storage reservation is unavailable.', 404);
    return value;
  }

  async gitMeter(repoId: string, storageName: string): Promise<CanonicalGitMeter | null> {
    return await this.store.get<CanonicalGitMeter>(storeKey(repoId, storageName)) ?? null;
  }

  async reserveGit(quote: CanonicalGitQuote): Promise<CanonicalGitReservation> {
    return this.store.transaction(async (tx) => {
      const control = await this.control(tx), i = quote.input;
      invariant(!await tx.get(`git-aborted:${i.repo_id}:${i.operation_id}`), 'git_operation_aborted', 'A rejected publication cannot reacquire storage admission.');
      if (quote.placement_operation_id) invariant(!await tx.get(`placement-closed:${quote.placement_operation_id}`)
        && !await tx.get(`placement-aborted:${quote.placement_operation_id}`), 'placement_fenced', 'A closed placement cannot acquire late canonical admission.');
      const old = await tx.get<CanonicalGitReservation>(`git-operation:${quote.reservation_id}`);
      if (old) { invariant(old.request_hash === quote.request_hash && old.fence === quote.fence, 'git_reservation_conflict', 'The operation already has different storage inputs.'); return old; }
      invariant(!control.stopped && this.at() < control.valid_until, 'git_storage_stopped', 'New Git storage commitments are stopped.');
      invariant((!control.closed_through || quote.created_at >= control.closed_through) && this.at() < quote.commitment_until,
        'git_quote_expired', 'This unstarted publication needs a new funded operation.');
      const active = await tx.get<string>(`git-active:${i.repo_id}`);
      invariant(!active || active === quote.reservation_id, 'git_storage_pending', 'Reconcile the previous canonical publication before reserving another.');
      const meter = await tx.get<CanonicalGitMeter>(storeKey(i.repo_id, i.storage_name));
      invariant(meter ? meter.logical_bytes === quote.baseline_bytes : quote.baseline_bytes === '0', 'git_baseline_unverified', 'An untracked or changed canonical baseline requires verified reconciliation.', 503);
      invariant((meter?.retained_bound_bytes ?? '0') === quote.retained_baseline_bytes && !meter?.pending_renewal && (!meter || meter.state === 'stored')
        && (!meter || meter.account_id === i.account_id) && !meter?.placement_handoff_id, 'git_baseline_changed', 'The retained Git funding baseline changed; reconcile the original publication.');
      const budgets = await this.relatedBudgets(tx, control, payer(i.account_id, i.repo_id, i.actor_id), quote.created_at);
      invariant(budgets.some(b => b.scope === 'account'), 'account_budget_required', 'Canonical storage requires an authoritative account cap.', 503);
      const escrow = await tx.get<PlacementGitHold>(`placement-git:${i.operation_id}`);
      if (escrow) {
        invariant(escrow.state === 'reserved' && escrow.storage_name === i.storage_name && escrow.account_id === i.account_id,
          'placement_git_fenced', 'The canonical duplication reservation is fenced.');
        invariant(units(i.maximum_growth_bytes) <= units(escrow.bytes), 'placement_bound_exceeded', 'The native graph exceeds its funded duplication bound.');
        const a = payer(escrow.account_id, escrow.repo_id, escrow.actor_id);
        await this.adjust(tx, control, await this.relatedBudgets(tx, control, a, escrow.created_at), a,
          { reserved: -units(control.kind === 'capacity' ? escrow.maximum_platform_units : escrow.maximum_units) });
        await this.moveBytes(tx, control, i.repo_id, -units(escrow.bytes), 0n);
        escrow.state = 'consumed'; await tx.put(`placement-git:${i.operation_id}`, escrow);
      }
      const currentBudgets = await this.relatedBudgets(tx, control, payer(i.account_id, i.repo_id, i.actor_id), quote.created_at);
      const amount = units(control.kind === 'capacity' ? quote.maximum_platform_units : quote.maximum_units);
      fits(currentBudgets, amount);
      await this.reserveBytes(tx, control, i.repo_id, i.maximum_growth_bytes, quote.repository_limit_bytes);
      await this.adjust(tx, control, currentBudgets, payer(i.account_id, i.repo_id, i.actor_id), { reserved: amount });
      const operation: CanonicalGitReservation = { ...quote, state: 'prepared', held_units: amount.toString(), budget_ids: budgets.map(b => b.id), verified_at: null, receipt_hash: null, revision: 1 };
      await tx.put(`git-operation:${operation.reservation_id}`, operation); await tx.put(`git-active:${i.repo_id}`, operation.reservation_id);
      await this.journal(tx, control, await this.budgets(tx, control), 'billing.git.storage_prepared', undefined, undefined, [], { git_operation: operation });
      return operation;
    });
  }

  async admitGit(id: string, fence: string): Promise<CanonicalGitReservation> {
    return this.store.transaction(async tx => {
      const control = await this.control(tx), operation = await tx.get<CanonicalGitReservation>(`git-operation:${id}`);
      invariant(operation && operation.fence === fence && operation.state !== 'aborted', 'git_operation_fenced', 'Canonical storage admission is fenced.');
      invariant(!await tx.get(`git-aborted:${operation.input.repo_id}:${operation.input.operation_id}`), 'git_operation_aborted', 'This rejected publication cannot receive a late admission.');
      if (operation.state !== 'prepared') return operation;
      if (operation.placement_operation_id) invariant(!await tx.get(`placement-closed:${operation.placement_operation_id}`),
        'placement_fenced', 'A closed placement cannot issue a late canonical grant.');
      invariant(!control.stopped && this.at() < control.valid_until, 'git_storage_stopped', 'Canonical storage admission is stopped.');
      operation.state = 'reserved'; operation.revision += 1;
      await tx.put(`git-operation:${id}`, operation);
      await this.journal(tx, control, [], 'billing.git.storage_admitted', undefined, undefined, [], { git_operation: operation });
      return operation;
    });
  }

  async commitGit(id: string, fence: string, receiptHash: string, verifiedAt: string, accepted: boolean, retainRejectedPack = false): Promise<void> {
    await this.store.transaction(async tx => {
      const control = await this.control(tx), operation = await tx.get<CanonicalGitReservation>(`git-operation:${id}`);
      invariant(operation && operation.fence === fence, 'git_operation_fenced', 'Canonical storage receipt is outside its reservation.');
      if (operation.state === 'committed' || operation.state === 'aborted') { invariant(operation.receipt_hash === receiptHash, 'git_receipt_conflict', 'The Git operation already has a different terminal receipt.'); return; }
      const i = operation.input, attribution = payer(i.account_id, i.repo_id, i.actor_id);
      let meter = await tx.get<CanonicalGitMeter>(storeKey(i.repo_id, i.storage_name));
      const ledger: LedgerEntry[] = [];
      if (meter) ledger.push(...await this.accrueGitInTransaction(tx, control, meter, verifiedAt));
      const keepGrowth = accepted || retainRejectedPack;
      const retained = units(meter?.retained_bound_bytes ?? '0') + (keepGrowth ? units(i.maximum_growth_bytes) : 0n);
      const oldRemaining = units(meter?.commitment_units ?? '0');
      if (keepGrowth) {
        meter ??= this.newGitMeter(operation, verifiedAt);
        const growthLedger = [];
        if (control.kind === 'capacity') {
          growthLedger.push(...await this.peakEntries(tx, meter, { attribution, reservation_id: id, accrued_at: operation.created_at },
            i.maximum_growth_bytes, dayTime(operation.created_at), dayTime(verifiedAt) + 86_400_000, `git:${id}:peak`, operation.marker_oid));
          meter.peak_day = day(verifiedAt); meter.peak_bytes = retained.toString();
        }
        if (accepted || control.kind === 'capacity') {
          await this.adjust(tx, control, await this.relatedBudgets(tx, control, meter.attribution, meter.budget_started_at), meter.attribution, { commitment: -oldRemaining });
          meter.attribution = attribution; meter.budget_started_at = operation.created_at; meter.budget_ids = operation.budget_ids;
          meter.logical_bytes = accepted ? operation.reachable_bytes : meter.logical_bytes;
          meter.funded_until = operation.funded_until; meter.commitment_until = operation.commitment_until; meter.renew_after = operation.renew_after;
        }
        meter.retained_bound_bytes = retained.toString(); meter.object_count = accepted ? operation.object_count : meter.object_count;
        meter.accrued_at = verifiedAt; meter.last_operation_id = i.operation_id; meter.routing_epoch = i.routing_epoch;
        const charge = growthLedger.reduce((sum, e) => sum + signedUnits(e.amount_units), 0n);
        const budgets = await this.relatedBudgets(tx, control, attribution, operation.created_at);
        if (accepted || control.kind === 'capacity') {
          const availableHold = units(operation.held_units) + oldRemaining;
          const remaining = availableHold > charge ? availableHold - charge : 0n;
          const target = await this.requiredGitCommitment(tx, control, meter, meter.commitment_until);
          meter.commitment_units = (remaining < target ? remaining : target).toString();
          await this.adjust(tx, control, budgets, attribution, { reserved: -units(operation.held_units), commitment: units(meter.commitment_units), settled: charge });
          if (target > remaining || charge > availableHold || verifiedAt >= meter.commitment_until) this.stopForOverrun(control);
        } else await this.adjust(tx, control, budgets, attribution, { reserved: -units(operation.held_units) });
        await this.moveBytes(tx, control, i.repo_id, -units(i.maximum_growth_bytes), units(i.maximum_growth_bytes));
        ledger.push(...growthLedger); meter.revision += 1;
        await tx.put(storeKey(i.repo_id, i.storage_name), meter);
      } else {
        await this.adjust(tx, control, await this.relatedBudgets(tx, control, attribution, operation.created_at), attribution, { reserved: -units(operation.held_units) });
        await this.moveBytes(tx, control, i.repo_id, -units(i.maximum_growth_bytes), 0n);
        if (meter) { meter.revision += 1; await tx.put(storeKey(i.repo_id, i.storage_name), meter); }
      }
      operation.state = accepted ? 'committed' : 'aborted'; operation.receipt_hash = receiptHash; operation.verified_at = verifiedAt; operation.held_units = '0'; operation.revision += 1;
      await tx.put(`git-operation:${id}`, operation); await tx.delete(`git-active:${i.repo_id}`);
      if (!accepted) await tx.put(`git-aborted:${i.repo_id}:${i.operation_id}`, true);
      await this.journal(tx, control, await this.budgets(tx, control), accepted ? 'billing.git.storage_committed' : 'billing.git.storage_aborted', undefined, undefined, ledger,
        { git_operation: operation, git_meters: meter ? [meter] : [] });
    });
  }

  async abortGitIntent(repoId: string, operationId: string): Promise<void> {
    await this.store.transaction(async tx => { await tx.put(`git-aborted:${repoId}:${operationId}`, true); });
  }

  async cancelGitPrepare(quote: CanonicalGitQuote, coordinatorFenced = false): Promise<void> {
    await this.store.transaction(async tx => {
      const control = await this.control(tx), operation = await tx.get<CanonicalGitReservation>(`git-operation:${quote.reservation_id}`);
      const i = quote.input;
      await tx.put(`git-aborted:${i.repo_id}:${i.operation_id}`, true);
      if (!operation || operation.state === 'aborted') return;
      invariant(operation.fence === quote.fence && (operation.state === 'prepared' || control.kind === 'capacity' && coordinatorFenced && operation.state === 'reserved'),
        'git_publication_receipt_required', 'An issued canonical publication grant cannot be compensated without its verified outcome.');
      const attribution = payer(i.account_id, i.repo_id, i.actor_id);
      const budgets = await this.relatedBudgets(tx, control, attribution, operation.created_at);
      await this.adjust(tx, control, budgets, attribution, { reserved: -units(operation.held_units) });
      await this.moveBytes(tx, control, i.repo_id, -units(i.maximum_growth_bytes), 0n);
      operation.state = 'aborted'; operation.receipt_hash = `admission-denied:${operation.reservation_id}`; operation.held_units = '0'; operation.revision += 1;
      await tx.put(`git-operation:${operation.reservation_id}`, operation); await tx.delete(`git-active:${i.repo_id}`);
      await this.journal(tx, control, budgets, 'billing.git.admission_compensated', undefined, undefined, [], { git_operation: operation });
    });
  }

  private newGitMeter(operation: CanonicalGitReservation, at: string): CanonicalGitMeter {
    const i = operation.input;
    return { id: `git:${i.repo_id}:${i.storage_name}`, account_id: i.account_id, repo_id: i.repo_id, storage_name: i.storage_name, routing_epoch: i.routing_epoch,
      attribution: payer(i.account_id, i.repo_id, i.actor_id), logical_bytes: '0', retained_bound_bytes: '0', object_count: '0', commitment_units: '0', budget_ids: operation.budget_ids,
      budget_started_at: operation.created_at, accrued_at: at, funded_until: operation.funded_until, commitment_until: operation.commitment_until, renew_after: operation.renew_after,
      renewal_policy: operation.renewal_policy, funding_failure_at: null, state: 'stored', peak_day: day(operation.created_at), peak_bytes: '0',
      rates: operation.rates, slice_id: operation.slice_id, last_operation_id: i.operation_id, revision: 0,
      storage_cell_id: operation.storage_cell_id, placement_handoff_id: operation.placement_operation_id,
      ...(operation.placement_operation_id ? { billable_from: '9999-01-01T00:00:00.000Z' } : {}) };
  }

  protected async requiredGitCommitment(tx: BillingTransaction, control: AdmissionControl, meter: CanonicalGitMeter, until: string): Promise<bigint> {
    const platform = control.kind === 'capacity', rate = platform ? meter.rates.peak : meter.rates.logical;
    const quantity = platform ? units(meter.retained_bound_bytes) * BigInt(days(meter.accrued_at, until))
      : units(meter.logical_bytes) * BigInt(Math.max(0, Date.parse(until) - Date.parse(meter.accrued_at)));
    const remainder = units(await tx.get<string>(`remainder:${rate.id}:${rate.meter_version}:${meter.id}`) ?? '0');
    return ceilDivide(quantity * units(platform ? rate.platform_unit_price_units : rate.unit_price_units) + remainder, units(rate.unit_quantity));
  }

  private async peakEntries(tx: BillingTransaction, meter: CanonicalGitMeter, source: { attribution: Attribution; reservation_id: string; accrued_at: string },
    bytes: string, from: number, until: number, eventId: string, evidenceId: string, closing = false): Promise<LedgerEntry[]> {
    const ledger: LedgerEntry[] = [];
    let cursor = from;
    do {
      const date = new Date(cursor), nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
      const end = Math.min(nextMonth, until), at = new Date(cursor).toISOString();
      const quantity = units(bytes) * BigInt(Math.max(0, Math.floor((end - cursor) / 86_400_000)));
      ledger.push(await this.charge(tx, source, meter.rates.peak, quantity.toString(), `${eventId}:${at}`, evidenceId, true, meter.id,
        at, closing && end === until));
      cursor = end;
    } while (cursor < until);
    return ledger;
  }

  protected async accrueGitInTransaction(tx: BillingTransaction, control: AdmissionControl, meter: CanonicalGitMeter, through: string, closing = false): Promise<LedgerEntry[]> {
    invariant(through >= meter.accrued_at && through <= this.at(), 'git_meter_time', 'Canonical metering cannot move backward or invent future consumption.', 422);
    if (through === meter.accrued_at && !closing) return [];
    const quantity = units(meter.logical_bytes) * BigInt(Date.parse(through) - Date.parse(meter.accrued_at));
    const billable = units(meter.logical_bytes) * BigInt(Math.max(0, Math.min(Date.parse(through), Date.parse(meter.commitment_until), Date.parse(meter.billable_until ?? meter.commitment_until))
      - Math.max(Date.parse(meter.accrued_at), Date.parse(meter.billable_from ?? meter.accrued_at))));
    const rate = meter.rates.logical, source = { attribution: meter.attribution, reservation_id: meter.last_operation_id, accrued_at: meter.accrued_at };
    const event = `git-accrual:${meter.id}:${meter.account_id}:${through}${closing ? ':closed' : ''}`;
    const firstDay = dayTime(meter.peak_day) + 86_400_000, lastDay = dayTime(through) + 86_400_000;
    const entries = control.kind === 'capacity'
      ? await this.peakEntries(tx, meter, source, meter.retained_bound_bytes, firstDay === lastDay ? dayTime(through) : firstDay,
        firstDay === lastDay ? dayTime(through) : lastDay, event, meter.last_operation_id, closing)
      : [await this.charge(tx, source, rate, (meter.placement_handoff_id ? billable : quantity).toString(), event, meter.last_operation_id, false, meter.id, undefined, closing)];
    if (control.kind === 'account' && !meter.placement_handoff_id) {
      const refund = await this.refundUnbillable(tx, entries[0]!, rate, billable.toString(), meter.id);
      if (refund) entries.push(refund);
    }
    if (control.kind === 'capacity' && day(through) !== meter.peak_day) { meter.peak_day = day(through); meter.peak_bytes = meter.retained_bound_bytes; }
    const actual = entries.reduce((sum, e) => sum + signedUnits(e.amount_units), 0n);
    const held = units(meter.commitment_units), consumed = actual > held ? held : actual;
    const budgets = await this.relatedBudgets(tx, control, meter.attribution, meter.budget_started_at);
    await this.adjust(tx, control, budgets, meter.attribution, { commitment: -consumed, settled: actual });
    meter.commitment_units = (held - consumed).toString();
    if (actual > held || through >= meter.commitment_until) this.stopForOverrun(control);
    meter.accrued_at = through;
    return entries;
  }

  async accrueGit(repoId: string, storageName: string, through: string): Promise<CanonicalGitMeter> {
    return this.store.transaction(async tx => {
      const control = await this.control(tx), meter = await tx.get<CanonicalGitMeter>(storeKey(repoId, storageName));
      invariant(meter, 'git_meter_missing', 'Canonical Git storage has no verified meter.', 404);
      if (meter.state !== 'stored' || meter.placement_handoff_id || meter.pending_renewal || await tx.get(`git-active:${repoId}`) || through <= meter.accrued_at) return meter;
      const ledger: LedgerEntry[] = [];
      // Bounded calendar segments keep ledger statements and invoice attribution exact.
      let at = meter.accrued_at;
      while (at < through) {
        const d = new Date(at), boundary = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
        const until = boundary < through ? boundary : through;
        ledger.push(...await this.accrueGitInTransaction(tx, control, meter, until)); at = until;
        invariant(ledger.length <= 24, 'git_accrual_batch_limit', 'Canonical history must be accrued in bounded maintenance windows.', 503);
      }
      meter.revision += 1; await tx.put(storeKey(repoId, storageName), meter);
      await this.journal(tx, control, await this.budgets(tx, control), 'billing.git.storage_accrued', undefined, undefined, ledger, { git_meters: [meter] });
      return meter;
    });
  }

  async prepareGitRenewal(repoId: string, storageName: string, id: string, window: GitFundingWindow): Promise<void> {
    await this.store.transaction(async tx => {
      const control = await this.control(tx), meter = await tx.get<CanonicalGitMeter>(storeKey(repoId, storageName));
      if (await tx.get(`git-renewed:${id}`)) return;
      invariant(!await tx.get(`git-renewal-cancelled:${id}`), 'git_renewal_cancelled', 'This funding generation was cancelled.');
      invariant(meter && meter.state === 'stored' && window.commitment_until > meter.commitment_until, 'git_renewal_invalid', 'The canonical funding window must advance.');
      invariant(!meter.placement_handoff_id, 'git_placement_fenced', 'Complete the physical handoff before renewing retained Git.');
      if (meter.pending_renewal) { invariant(meter.pending_renewal.id === id, 'git_renewal_pending', 'A canonical funding decision is still pending.'); return; }
      invariant(!await tx.get(`git-active:${repoId}`), 'git_publication_pending', 'An uncertain publication keeps its existing storage holds until reconciliation.');
      const required = await this.requiredGitCommitment(tx, control, meter, window.commitment_until);
      const delta = required > units(meter.commitment_units) ? required - units(meter.commitment_units) : 0n;
      const budgets = (await this.relatedBudgets(tx, control, meter.attribution, meter.budget_started_at)).filter(b => !b.period_end || b.period_end > this.at());
      fits(budgets, delta);
      await this.adjust(tx, control, budgets, meter.attribution, { reserved: delta });
      meter.pending_renewal = { id, delta_units: delta.toString(), ...window, prepared_at: this.at(), budget_ids: budgets.map(b => b.id) };
      meter.revision += 1; await tx.put(storeKey(repoId, storageName), meter);
      await this.journal(tx, control, budgets, 'billing.git.renewal_prepared', undefined, undefined, [], { git_meters: [meter] });
    });
  }

  async commitGitRenewal(repoId: string, storageName: string, id: string): Promise<void> {
    await this.store.transaction(async tx => {
      const control = await this.control(tx), meter = await tx.get<CanonicalGitMeter>(storeKey(repoId, storageName));
      invariant(meter, 'git_meter_missing', 'Canonical Git storage has no meter.', 404);
      if (!meter.pending_renewal) { invariant(await tx.get(`git-renewed:${id}`), 'git_renewal_missing', 'The funding reservation is unavailable.'); return; }
      const p = meter.pending_renewal;
      invariant(p.id === id, 'git_renewal_conflict', 'A different canonical funding reservation is pending.');
      const all = await this.relatedBudgets(tx, control, meter.attribution, meter.budget_started_at);
      const funded = all.filter(b => p.budget_ids.includes(b.id) || b.period_start >= p.prepared_at);
      await this.adjust(tx, control, funded, meter.attribution, { reserved: -units(p.delta_units), commitment: units(p.delta_units) });
      for (const b of all.filter(b => b.period_end && b.period_end <= this.at())) {
        const amount = units(meter.commitment_units) + (funded.some(f => f.id === b.id) ? units(p.delta_units) : 0n);
        invariant(units(b.commitment_units) >= amount, 'git_funding_corrupt', 'Historical Git funding requires reconciliation.', 503);
        b.commitment_units = (units(b.commitment_units) - amount).toString(); b.revision += 1; await tx.put(`budget:${b.id}`, b);
      }
      meter.commitment_units = (units(meter.commitment_units) + units(p.delta_units)).toString();
      meter.funded_until = p.funded_until; meter.commitment_until = p.commitment_until; meter.renew_after = p.renew_after;
      meter.budget_started_at = this.at(); meter.pending_renewal = null; meter.funding_failure_at = null; meter.revision += 1;
      await tx.delete(`git-funding-block:${meter.id}`);
      if (control.stop_reason === 'Canonical Git storage requires funded retention.' && !(await tx.list({ prefix: 'git-funding-block:', limit: 1 })).size) {
        control.stopped = false; control.stop_reason = null;
      }
      await tx.put(`git-renewed:${id}`, true); await tx.put(storeKey(repoId, storageName), meter);
      await this.journal(tx, control, await this.budgets(tx, control), 'billing.git.renewed', undefined, undefined, [], { git_meters: [meter] });
    });
  }

  async abortGitRenewal(repoId: string, storageName: string, id: string): Promise<void> {
    await this.store.transaction(async tx => {
      const control = await this.control(tx), meter = await tx.get<CanonicalGitMeter>(storeKey(repoId, storageName));
      invariant(!await tx.get(`git-renewed:${id}`), 'git_renewal_committed', 'Committed retention cannot be compensated as unstarted.');
      await tx.put(`git-renewal-cancelled:${id}`, true);
      if (!meter?.pending_renewal) return;
      const pending = meter.pending_renewal;
      invariant(pending.id === id, 'git_renewal_conflict', 'The current retention funding generation changed.');
      const budgets = (await this.relatedBudgets(tx, control, meter.attribution, meter.budget_started_at)).filter(b => pending.budget_ids.includes(b.id) || b.period_start >= pending.prepared_at);
      await this.adjust(tx, control, budgets, meter.attribution, { reserved: -units(pending.delta_units) });
      meter.pending_renewal = null; meter.revision += 1; await tx.put(storeKey(repoId, storageName), meter);
      await this.journal(tx, control, budgets, 'billing.git.renewal_aborted', undefined, undefined, [], { git_meters: [meter] });
    });
  }

  async gitFundingFailure(repoId: string, storageName: string): Promise<CanonicalGitMeter> {
    return this.store.transaction(async tx => {
      const control = await this.control(tx), meter = await tx.get<CanonicalGitMeter>(storeKey(repoId, storageName));
      invariant(meter, 'git_meter_missing', 'Canonical Git storage has no verified meter.', 404);
      if (meter.funding_failure_at) return meter;
      meter.funding_failure_at = this.at(); meter.revision += 1;
      await tx.put(`git-funding-block:${meter.id}`, true);
      if (!control.stopped) { control.stopped = true; control.stop_reason = 'Canonical Git storage requires funded retention.'; }
      await tx.put(storeKey(repoId, storageName), meter);
      await this.journal(tx, control, [], 'billing.git.storage.funding_required', undefined, undefined, [], { git_meters: [meter] });
      return meter;
    });
  }

  async purgeGit(repoId: string, storageName: string, confirmedAt: string, operationId: string): Promise<CanonicalGitMeter> {
    return this.store.transaction(async tx => {
      const control = await this.control(tx), meter = await tx.get<CanonicalGitMeter>(storeKey(repoId, storageName));
      invariant(meter, 'git_meter_missing', 'The retained canonical meter is unavailable.', 404);
      if (meter.state === 'purged') return meter;
      invariant(meter.state === 'stored' && !meter.pending_renewal && !await tx.get(`git-active:${repoId}`), 'git_purge_pending', 'Reconcile publication, ownership and funding before settling physical purge.');
      const ledger = await this.accrueGitInTransaction(tx, control, meter, confirmedAt, true);
      const budgets = await this.relatedBudgets(tx, control, meter.attribution, meter.budget_started_at);
      await this.adjust(tx, control, budgets, meter.attribution, { commitment: -units(meter.commitment_units) });
      await this.moveBytes(tx, control, repoId, 0n, -units(meter.retained_bound_bytes));
      meter.commitment_units = '0'; meter.logical_bytes = '0'; meter.retained_bound_bytes = '0'; meter.object_count = '0';
      meter.state = 'purged'; meter.purged_at = confirmedAt; meter.last_operation_id = operationId; meter.revision += 1;
      await tx.put(storeKey(repoId, storageName), meter); await tx.delete(`git-funding-block:${meter.id}`);
      await this.journal(tx, control, budgets, 'billing.git.storage.purged', undefined, undefined, ledger, { git_meters: [meter] });
      return meter;
    });
  }

  async fenceGitTransfer(repoId: string, storageName: string, operationId: string, destination: string): Promise<CanonicalGitMeter> {
    return this.store.transaction(async tx => {
      const control = await this.control(tx), meter = await tx.get<CanonicalGitMeter>(storeKey(repoId, storageName));
      invariant(meter && !await tx.get(`git-transfer-cancelled:${operationId}:${meter.id}`), 'git_transfer_cancelled', 'The canonical owner handoff was cancelled.');
      invariant(!meter.placement_handoff_id, 'git_placement_fenced', 'Complete the physical handoff before changing the payer.');
      if (meter.state === 'transferring') {
        invariant(meter.transfer_operation_id === operationId && meter.destination_account_id === destination, 'git_transfer_conflict', 'Another owner handoff is in progress.');
        return meter;
      }
      invariant(meter.state === 'stored' && !meter.pending_renewal && !await tx.get(`git-active:${repoId}`), 'git_not_quiescent', 'Reconcile canonical publication and funding before owner handoff.');
      meter.state = 'transferring'; meter.transfer_operation_id = operationId; meter.destination_account_id = destination; meter.revision += 1;
      await tx.put(storeKey(repoId, storageName), meter);
      await this.journal(tx, control, [], 'billing.git.owner_fenced', undefined, undefined, [], { git_meters: [meter] });
      return meter;
    });
  }

  async prepareGitImport(source: CanonicalGitMeter, operationId: string, destination: string, actorId: string, window: GitFundingWindow, repositoryLimit?: string): Promise<CanonicalGitMeter> {
    return this.store.transaction(async tx => {
      const control = await this.control(tx), key = `git-import:${operationId}:${source.id}`;
      invariant(!await tx.get(`git-import-cancelled:${operationId}:${source.id}`), 'git_transfer_cancelled', 'This receiving owner reservation was cancelled.');
      const old = await tx.get<CanonicalGitMeter>(key);
      if (old) return old;
      invariant(!control.stopped && this.at() < control.valid_until && source.state === 'transferring' && source.transfer_operation_id === operationId
        && source.destination_account_id === destination, 'git_transfer_unfunded', 'Both owners must have a current fenced and funded handoff.');
      invariant(control.kind === 'capacity' || control.account_id === destination, 'git_transfer_scope', 'The receiving account is incorrect.');
      const at = this.at(), attribution = payer(destination, source.repo_id, actorId);
      const budgets = await this.relatedBudgets(tx, control, attribution, at);
      const current = await tx.get<CanonicalGitMeter>(storeKey(source.repo_id, source.storage_name));
      if (control.kind === 'account') invariant(!current || current.state === 'transferred', 'git_transfer_conflict', 'The receiving account already owns an active canonical meter.');
      const meter: CanonicalGitMeter = { ...source, ...window, account_id: destination, attribution, state: 'transfer_pending',
        accrued_at: at, budget_started_at: at, budget_ids: budgets.map(b => b.id), pending_renewal: null, funding_failure_at: null,
        destination_account_id: undefined, transferred_at: undefined, revision: Math.max(source.revision, current?.revision ?? 0) + 1 };
      const amount = await this.requiredGitCommitment(tx, control, meter, meter.commitment_until);
      fits(budgets, amount);
      if (control.kind === 'account') await this.reserveBytes(tx, control, source.repo_id, source.retained_bound_bytes, repositoryLimit);
      await this.adjust(tx, control, budgets, attribution, { reserved: amount });
      meter.commitment_units = amount.toString(); await tx.put(key, meter);
      // The physical capacity projection remains with the old owner until the single cutover.
      await this.journal(tx, control, budgets, 'billing.git.owner_reserved');
      return meter;
    });
  }

  async activateGitImport(repoId: string, storageName: string, operationId: string, effectiveAt: string): Promise<CanonicalGitMeter> {
    return this.store.transaction(async tx => {
      const control = await this.control(tx), sourceKey = storeKey(repoId, storageName), identity = `git:${repoId}:${storageName}`;
      const receiptKey = `git-activated:${operationId}:${identity}`, receipt = await tx.get<string>(receiptKey);
      if (receipt) { invariant(receipt === effectiveAt, 'git_transfer_boundary', 'The canonical owner boundary is immutable.'); return (await tx.get<CanonicalGitMeter>(sourceKey))!; }
      const imported = await tx.get<CanonicalGitMeter>(`git-import:${operationId}:${identity}`);
      invariant(imported?.state === 'transfer_pending' && effectiveAt >= imported.accrued_at && effectiveAt <= this.at(), 'git_transfer_unprepared', 'The receiving canonical meter is not prepared at this owner boundary.');
      const ledger: LedgerEntry[] = [];
      const source = await tx.get<CanonicalGitMeter>(sourceKey);
      if (control.kind === 'capacity') {
        invariant(source?.state === 'transferring' && source.transfer_operation_id === operationId && source.destination_account_id === imported.account_id,
          'git_transfer_source_changed', 'The physical canonical owner fence changed.');
        ledger.push(...await this.accrueGitInTransaction(tx, control, source, effectiveAt, true));
        await this.adjust(tx, control, await this.relatedBudgets(tx, control, source.attribution, source.budget_started_at), source.attribution, { commitment: -units(source.commitment_units) });
        source.state = 'transferred'; source.commitment_units = '0'; source.transferred_at = effectiveAt;
        await tx.put(`git-transferred-source:${operationId}:${identity}`, source);
        imported.peak_day = source.peak_day; imported.peak_bytes = source.peak_bytes;
      }
      const reserved = units(imported.commitment_units);
      imported.accrued_at = effectiveAt; imported.state = 'stored'; imported.transferred_at = effectiveAt;
      const needed = await this.requiredGitCommitment(tx, control, imported, imported.commitment_until);
      imported.commitment_units = (needed < reserved ? needed : reserved).toString();
      const budgets = await this.relatedBudgets(tx, control, imported.attribution, imported.budget_started_at);
      await this.adjust(tx, control, budgets, imported.attribution, { reserved: -reserved, commitment: units(imported.commitment_units) });
      if (control.kind === 'account') await this.moveBytes(tx, control, repoId, -units(imported.retained_bound_bytes), units(imported.retained_bound_bytes));
      if (needed > reserved || effectiveAt >= imported.commitment_until) this.stopForOverrun(control);
      imported.revision = Math.max(imported.revision, source?.revision ?? 0) + 1;
      await tx.put(sourceKey, imported); await tx.put(receiptKey, effectiveAt); await tx.put(`git-import:${operationId}:${identity}`, imported);
      await this.journal(tx, control, await this.budgets(tx, control), 'billing.git.owner_activated', undefined, undefined, ledger, { git_meters: [imported] });
      return imported;
    });
  }

  async settleGitTransfer(repoId: string, storageName: string, operationId: string, effectiveAt: string): Promise<CanonicalGitMeter> {
    return this.store.transaction(async tx => {
      const control = await this.control(tx), identity = `git:${repoId}:${storageName}`;
      if (control.kind === 'capacity') {
        const old = await tx.get<CanonicalGitMeter>(`git-transferred-source:${operationId}:${identity}`);
        invariant(old?.transferred_at === effectiveAt, 'git_transfer_pending', 'Activate the funded canonical receiver before releasing the former owner.');
        return old;
      }
      const meter = await tx.get<CanonicalGitMeter>(storeKey(repoId, storageName));
      invariant(meter?.transfer_operation_id === operationId, 'git_transfer_scope', 'The former canonical owner handoff changed.');
      if (meter.state === 'transferred') { invariant(meter.transferred_at === effectiveAt, 'git_transfer_boundary', 'The canonical consumption boundary changed.'); return meter; }
      invariant(meter.state === 'transferring', 'git_transfer_unprepared', 'The former owner is not fenced.');
      const ledger = await this.accrueGitInTransaction(tx, control, meter, effectiveAt, true);
      const budgets = await this.relatedBudgets(tx, control, meter.attribution, meter.budget_started_at);
      await this.adjust(tx, control, budgets, meter.attribution, { commitment: -units(meter.commitment_units) });
      await this.moveBytes(tx, control, repoId, 0n, -units(meter.retained_bound_bytes));
      meter.commitment_units = '0'; meter.state = 'transferred'; meter.transferred_at = effectiveAt; meter.revision += 1;
      await tx.put(storeKey(repoId, storageName), meter);
      await this.journal(tx, control, budgets, 'billing.git.owner_settled', undefined, undefined, ledger, { git_meters: [meter] });
      return meter;
    });
  }

  async abortGitImport(repoId: string, storageName: string, operationId: string): Promise<void> {
    await this.store.transaction(async tx => {
      const control = await this.control(tx), identity = `git:${repoId}:${storageName}`, key = `git-import:${operationId}:${identity}`;
      invariant(!await tx.get(`git-activated:${operationId}:${identity}`), 'git_transfer_committed', 'The new canonical owner is already active.');
      await tx.put(`git-import-cancelled:${operationId}:${identity}`, true);
      const meter = await tx.get<CanonicalGitMeter>(key);
      if (!meter || meter.state === 'cancelled') return;
      const budgets = await this.relatedBudgets(tx, control, meter.attribution, meter.budget_started_at);
      await this.adjust(tx, control, budgets, meter.attribution, { reserved: -units(meter.commitment_units) });
      if (control.kind === 'account') await this.moveBytes(tx, control, repoId, -units(meter.retained_bound_bytes), 0n);
      meter.state = 'cancelled'; meter.commitment_units = '0'; meter.revision += 1; await tx.put(key, meter);
      await this.journal(tx, control, budgets, 'billing.git.owner_import_aborted');
    });
  }

  async resumeGitOwner(repoId: string, storageName: string, operationId: string): Promise<void> {
    await this.store.transaction(async tx => {
      const control = await this.control(tx), meter = await tx.get<CanonicalGitMeter>(storeKey(repoId, storageName));
      invariant(meter, 'git_meter_missing', 'The former canonical owner is unavailable.', 404);
      await tx.put(`git-transfer-cancelled:${operationId}:${meter.id}`, true);
      if (meter.state === 'stored') return;
      invariant(meter.state === 'transferring' && meter.transfer_operation_id === operationId, 'git_transfer_committed', 'A committed canonical owner cannot be resumed.');
      meter.state = 'stored'; meter.destination_account_id = undefined; meter.revision += 1;
      await tx.put(storeKey(repoId, storageName), meter);
      await this.journal(tx, control, [], 'billing.git.owner_resumed', undefined, undefined, [], { git_meters: [meter] });
    });
  }
}
