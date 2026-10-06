import { gitCosts } from '../../../packages/git/src/cost.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';
import type { GitBindings } from './types.ts';

export interface HelperAllocation {
  id: string;
  phase: 'reserving' | 'admitted' | 'starting' | 'running' | 'stopped' | 'settled';
  profile: string;
  reservation_id?: string;
  fence?: string;
  started_at: string;
  deadline_at: string;
  work_deadline_at: string;
  stopped_at?: string;
  termination_receipt?: string;
  termination_kind?: 'container_destroyed' | 'never_allocated';
  maximum_duration_ms: number;
  maximum_egress_bytes: number;
  maximum_operations: number;
  operations: number;
  sessions: number;
  egress_bytes: number;
}

export class HelperBudget {
  constructor(private readonly storage: DurableObjectStorage, private readonly env: GitBindings, private readonly identity: string) {}

  read(): Promise<HelperAllocation | undefined> { return this.storage.get<HelperAllocation>('git_allocation'); }

  async reserve(): Promise<HelperAllocation> {
    let allocation = await this.read();
    if (!allocation || allocation.phase === 'settled') {
      const duration = 330_000;
      const bytes = Number(this.env.GIT_HELPER_EGRESS_BYTES ?? 4 * 1024 ** 3);
      const operations = Number(this.env.GIT_HELPER_OPERATIONS ?? 1024);
      requireValue(Number.isSafeInteger(bytes) && bytes > 0 && Number.isSafeInteger(operations) && operations > 0 && operations <= 100_000,
        'git_budget_configuration', 'Trusted Git helper limits are invalid.', 503);
      allocation = { id: `git_${this.identity}_${crypto.randomUUID()}`, phase: 'reserving', started_at: new Date().toISOString(),
        profile: this.env.GIT_HELPER_PROFILE ?? 'standard-2',
        deadline_at: new Date(Date.now() + duration).toISOString(), work_deadline_at: new Date(Date.now() + duration - 30_000).toISOString(), maximum_duration_ms: duration, maximum_egress_bytes: bytes,
        maximum_operations: operations, operations: 0, sessions: 0, egress_bytes: 0 };
      await this.storage.put('git_allocation', allocation);
    }
    requireValue(allocation.phase === 'reserving' || allocation.phase === 'admitted', 'git_budget_reconciling', 'A previous helper allocation is being reconciled.', 503);
    allocation = await this.confirmReservation(allocation);
    allocation.phase = 'admitted';
    await this.storage.put('git_allocation', allocation);
    if (Date.now() >= Date.parse(allocation.work_deadline_at)) {
      await this.stopped(`allocation:${allocation.id}:never-allocated`, 'never_allocated');
      await this.settle();
      requireValue(false, 'git_budget_expired', 'The unused helper episode was settled. Retry with a fresh allocation.', 503);
    }
    // Persist potential financial startup before sending it; a lost reply must not
    // later be reclassified as a provably never-started allocation.
    allocation.phase = 'starting';
    await this.storage.put('git_allocation', allocation);
    await gitCosts.startHelper(this.env, { service: 'git-helper', allocation_id: allocation.id, reservation_id: allocation.reservation_id!, fence: allocation.fence! });
    const current = await this.read();
    requireValue(current?.id === allocation.id && current.phase === 'starting' && Date.now() < Date.parse(current.work_deadline_at),
      'git_budget_expired', 'The helper allocation changed or expired while startup was being admitted.', 503);
    return current;
  }

  private async confirmReservation(allocation: HelperAllocation): Promise<HelperAllocation> {
    if (allocation.reservation_id && allocation.fence) return allocation;
    allocation.profile ??= this.env.GIT_HELPER_PROFILE ?? 'standard-2';
    const reservation = await gitCosts.reserveHelper({ ...this.env, GIT_HELPER_OPERATIONS: String(allocation.maximum_operations) }, { service: 'git-helper', allocation_id: allocation.id,
      profile: allocation.profile, maximum_duration_ms: allocation.maximum_duration_ms,
      maximum_egress_bytes: String(allocation.maximum_egress_bytes) });
    requireValue(reservation.reservation_id && reservation.fence && Number.isSafeInteger(reservation.maximum_duration_ms) && reservation.maximum_duration_ms > 0,
      'git_budget_unconfirmed', 'Git helper financial admission was not confirmed.', 503);
    allocation.reservation_id = reservation.reservation_id; allocation.fence = reservation.fence;
    const duration = Math.min(allocation.maximum_duration_ms, reservation.maximum_duration_ms);
    allocation.deadline_at = new Date(Date.parse(allocation.started_at) + duration).toISOString();
    allocation.work_deadline_at = new Date(Date.parse(allocation.started_at) + Math.max(0, duration - 30_000)).toISOString();
    await this.storage.put('git_allocation', allocation);
    return allocation;
  }

  async running(): Promise<void> {
    await this.change(allocation => { requireValue(allocation.phase === 'starting' && Date.now() < Date.parse(allocation.work_deadline_at),
      'git_budget_unconfirmed', 'Helper startup has no current allocation grant.', 503); allocation.phase = 'running'; });
  }

  async operation(allocationId: string, count = 1, session = false): Promise<void> {
    await this.change(allocation => {
      this.current(allocation, allocationId);
      requireValue(allocation.operations + count <= allocation.maximum_operations && (!session || allocation.sessions < 64),
        'git_helper_work_limit', 'This helper reached its work allowance. Retry after it is replaced.', 429);
      allocation.operations += count;
      if (session) allocation.sessions++;
    });
  }

  async bytes(allocationId: string, streamId: string, bytes: number): Promise<void> {
    requireValue(Number.isSafeInteger(bytes) && bytes >= 0, 'git_egress_size', 'Invalid native transfer accounting.', 503);
    await this.storage.transaction(async tx => {
      const allocation = await tx.get<HelperAllocation>('git_allocation');
      requireValue(allocation, 'git_budget_unconfirmed', 'Helper allocation is unavailable.', 503);
      this.current(allocation, allocationId);
      const prior = await tx.get<{ id: string; bytes: number }>(`git_stream:${streamId}`);
      requireValue(!prior || prior.id === allocationId, 'git_stream_scope', 'Native stream belongs to another helper allocation.', 409);
      const delta = bytes - (prior?.bytes ?? 0);
      requireValue(delta >= 0 && allocation.egress_bytes + delta <= allocation.maximum_egress_bytes, 'git_egress_limit', 'Trusted Git transfer allowance is exhausted.', 429);
      allocation.egress_bytes += delta;
      await tx.put('git_allocation', allocation);
      await tx.put(`git_stream:${streamId}`, { id: allocationId, bytes });
    });
  }

  async finishStream(allocationId: string, streamId: string, actual: number): Promise<void> {
    await this.storage.transaction(async tx => {
      const prior = await tx.get<{ id: string; bytes: number }>(`git_stream:${streamId}`);
      if (!prior) return;
      requireValue(prior.id === allocationId && actual >= 0 && actual <= prior.bytes, 'git_stream_scope', 'Invalid native stream completion.', 409);
      const allocation = await tx.get<HelperAllocation>('git_allocation');
      // An already-settled episode retains its conservative admission bound rather than
      // rewriting a financial receipt after an unknown stream outcome.
      if (allocation?.id === allocationId && allocation.phase === 'running') {
        allocation.egress_bytes -= prior.bytes - actual;
        await tx.put('git_allocation', allocation);
      }
      await tx.delete(`git_stream:${streamId}`);
    });
  }

  async stopped(receipt: string, kind: 'container_destroyed' | 'never_allocated' = 'container_destroyed'): Promise<void> {
    await this.change(allocation => {
      if (allocation.phase === 'settled' || allocation.phase === 'stopped') return;
      requireValue(kind !== 'never_allocated' || allocation.phase === 'admitted' && allocation.egress_bytes === 0,
        'git_teardown_unconfirmed', 'A possibly started helper requires verified destruction.', 503);
      allocation.phase = 'stopped'; allocation.stopped_at = new Date().toISOString(); allocation.termination_receipt = receipt;
      allocation.termination_kind = kind;
    });
  }

  async settle(): Promise<void> {
    let allocation = await this.read();
    if (!allocation || allocation.phase === 'settled') return;
    requireValue(allocation.phase === 'stopped' && allocation.stopped_at && allocation.termination_receipt,
      'git_budget_reconciling', 'Helper teardown must be verified before its financial hold is released.', 503);
    allocation = await this.confirmReservation(allocation);
    const kind = allocation.termination_kind ?? 'container_destroyed';
    await gitCosts.settleHelper(this.env, { service: 'git-helper', allocation_id: allocation.id, reservation_id: allocation.reservation_id!,
      fence: allocation.fence!, event_id: `git_helper:${allocation.id}:stopped`, duration_ms: kind === 'never_allocated' ? 0 : Math.max(0, Date.parse(allocation.stopped_at!) - Date.parse(allocation.started_at)),
      egress_bytes: String(allocation.egress_bytes), termination_proof: { kind, receipt_id: allocation.termination_receipt!, verified_at: allocation.stopped_at! } });
    allocation.phase = 'settled'; await this.storage.put('git_allocation', allocation);
  }

  private current(allocation: HelperAllocation, id: string): void {
    requireValue(allocation.id === id && allocation.phase === 'running' && Date.now() < Date.parse(allocation.work_deadline_at),
      'git_allocation_expired', 'The native helper no longer has a current allocation grant.', 409);
  }

  private async change(update: (allocation: HelperAllocation) => void): Promise<void> {
    await this.storage.transaction(async tx => {
      const allocation = await tx.get<HelperAllocation>('git_allocation');
      requireValue(allocation, 'git_budget_unconfirmed', 'The helper financial journal is unavailable.', 503);
      update(allocation); await tx.put('git_allocation', allocation);
    });
  }
}
