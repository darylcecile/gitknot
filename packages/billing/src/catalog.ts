import { ApiError, auditStatement, eventStatement, limits, many, newId, now, one, stmt } from '@gitknot/core';
import type { Database, Repository } from '@gitknot/core';
import { BillingError, invariant } from './errors.ts';
import { admissionRequest } from './transport.ts';
import { storagePolicy } from './configuration.ts';
import { billingEnvironment } from './authority.ts';
import { billingMetadata } from './storage-policy.ts';
import { integer, maximumCharge, monthWindow, units } from './money.ts';
import type { Rate } from './money.ts';
import type { AdmissionControl, BillingBindings, Budget, ExecutionQuote, ExecutionQuotePreview, PreviewExecutionInput, ReserveExecutionInput } from './types.ts';

export interface BillingAccount {
  account_id: string; plan_id: string; state: 'active' | 'past_due' | 'suspended' | 'cancelled';
  collection_method: 'manual' | 'processor'; period_start: string; period_end: string;
  billing_email: string | null; seat_count: number; rounding_carry_units: string;
  admission_epoch: number; admission_initialized_at: string | null; subscription_remainder: string; revision: number; created_at: string; updated_at: string;
}

export interface Plan {
  id: string; name: string; version: string; currency: 'USD'; monthly_base_units: string; seat_units: string;
  included_usage_units: string; default_budget_units: string; max_concurrency: number; max_storage_bytes: string;
  max_seats: number; entitlements_json: string; created_at: string;
}

interface Entitlements {
  hosted: boolean; self_hosted: boolean; maximum_duration_ms: number; maximum_retention_seconds: number;
  maximum_objects: number; maximum_egress_bytes: string;
}

export interface CapacitySlice {
  id: string; pool_id: string; cell_id: string; limit_units: string; max_instances: number; max_storage_bytes: string;
  valid_until: string; state: 'active' | 'stopped' | 'retired'; admission_epoch: number; revision: number; created_at: string;
  purpose: 'discretionary' | 'essential';
}

export async function ensureBillingAccount(env: Pick<BillingBindings, 'DB'>, accountId: string): Promise<BillingAccount> {
  env = billingEnvironment(env);
  const db = env.DB;
  const existing = await one<BillingAccount>(db, 'SELECT * FROM billing_accounts WHERE account_id=?', accountId);
  if (existing) return existing;
  const owner = await one<{ id: string }>(db, 'SELECT id FROM accounts WHERE id=? AND disabled_at IS NULL', accountId);
  invariant(owner, 'account_not_found', 'Account not found.', 404);
  const at = now();
  const window = monthWindow();
  try { await db.batch([
    stmt(db, `INSERT INTO billing_accounts (account_id,plan_id,state,collection_method,period_start,period_end,created_at,updated_at)
      VALUES (?,'plan_free_202610','active','manual',?,?,?,?)`, accountId, window.period_start, window.period_end, at, at),
    stmt(db, `INSERT OR IGNORE INTO billing_credits (id,account_id,amount_units,remaining_units,reason,source,source_id,expires_at,created_at,actor_id)
      SELECT ?,a.account_id,p.included_usage_units,p.included_usage_units,'Plan included usage','included',?,?,?,'system:billing'
      FROM billing_accounts a JOIN billing_plans p ON p.id=a.plan_id WHERE a.account_id=?`,
    `credit:${accountId}:${window.period_start}`, window.period_start, window.period_end, at, accountId),
    stmt(db, `INSERT OR IGNORE INTO billing_plan_segments (id,account_id,plan_id,seat_count,started_at,created_at)
      SELECT ?,account_id,plan_id,seat_count,?,? FROM billing_accounts WHERE account_id=?`, `segment:${accountId}:initial`, at, at, accountId),
    eventStatement(db, { id: `evt_billing_account_${accountId}`, type: 'billing.account.created', resource_id: accountId, resource_revision: 1, account_id: accountId, occurred_at: at }),
    auditStatement(db, { id: `audit_billing_account_${accountId}`, action: 'billing.account.created', resource_id: accountId, resource_revision: 1, account_id: accountId, created_at: at }),
  ]); } catch (error) {
    const raced = await one<BillingAccount>(db, 'SELECT * FROM billing_accounts WHERE account_id=?', accountId);
    if (raced) return raced;
    throw error;
  }
  const account = await one<BillingAccount>(db, 'SELECT * FROM billing_accounts WHERE account_id=?', accountId);
  invariant(account, 'billing_unavailable', 'Billing account creation could not be verified.', 503);
  return account;
}

export async function getPlan(db: Database, id: string): Promise<Plan> {
  const plan = await one<Plan>(db, 'SELECT * FROM billing_plans WHERE id=?', id);
  invariant(plan, 'plan_unavailable', 'The account plan is not available.', 503);
  return plan;
}

export function planEntitlements(plan: Plan): Entitlements {
  const parsed = JSON.parse(plan.entitlements_json) as Entitlements;
  integer(parsed.maximum_duration_ms, 'maximum_duration_ms', 86_400_000);
  integer(parsed.maximum_retention_seconds, 'maximum_retention_seconds', 31_536_000);
  integer(parsed.maximum_objects, 'maximum_objects', 65_536);
  units(parsed.maximum_egress_bytes);
  invariant(typeof parsed.hosted === 'boolean' && typeof parsed.self_hosted === 'boolean', 'plan_unavailable', 'Plan entitlements are invalid.', 503);
  return parsed;
}

export async function currentRate(db: Database, meter: string): Promise<Rate> {
  const rate = await one<Rate>(db, 'SELECT * FROM billing_prices WHERE meter=? AND created_at<=? ORDER BY created_at DESC,id DESC LIMIT 1', meter, now());
  invariant(rate, 'price_unavailable', 'An immutable price is required before admission.', 503);
  invariant(rate.currency === 'USD' && units(rate.unit_quantity) > 0n, 'price_unavailable', 'The active price is invalid.', 503);
  return rate;
}

export async function quoteExecution(env: BillingBindings, input: ReserveExecutionInput): Promise<ExecutionQuote> {
  env = billingEnvironment(env);
  const account = await ensureBillingAccount(env, input.account_id);
  invariant(account.state === 'active', 'subscription_inactive', 'The subscription does not currently permit new paid work.');
  const plan = await getPlan(env.DB, account.plan_id);
  const entitlements = planEntitlements(plan);
  await reserveSubscriptionCommitment(env, input.account_id, plan, account.seat_count);
  validateExecutionDuration(input, entitlements);
  integer(input.generation, 'generation', 1_000_000);
  invariant(input.generation > 0, 'invalid_generation', 'Attempt generations start at one.', 422);
  const repo = await executionRepository(env, input);
  const sliceId = env.BILLING_PLATFORM_SLICE_ID;
  invariant(typeof sliceId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(sliceId), 'capacity_unconfigured', 'This execution cell has no allocated operating-cost slice.', 503);
  const slice = await activeSlice(env, sliceId);
  invariant(slice.cell_id === env.CELL_ID, 'capacity_cell', 'The operating-cost slice belongs to another cell.', 503);
  invariant(slice.purpose === 'discretionary', 'capacity_purpose', 'Customer execution requires a discretionary operating allocation.', 503);
  return { ...await executionAmounts(env.DB, input, plan, entitlements), execution_cell_id: env.CELL_ID,
    attribution: { account_id: input.account_id, repo_id: input.repo_id, actor_id: input.actor_id, workflow_id: input.workflow_id ?? null,
      team_id: input.team_id ?? null, run_id: input.run_id, attempt_id: input.attempt_id, generation: input.generation },
    slice_id: sliceId, routing_epoch: repo.routing_epoch, quoted_at: now(), repository_storage_limit_bytes: String(limits(env).repository_storage_bytes) };
}

function validateExecutionDuration(input: PreviewExecutionInput, entitlements: Entitlements): void {
  invariant(entitlements[input.executor] === true, 'executor_not_entitled', 'The selected executor is not included in this plan.', 403);
  integer(input.maximum_duration_ms, 'maximum_duration_ms', entitlements.maximum_duration_ms);
  invariant(input.maximum_duration_ms > 0, 'deadline_required', 'Execution requires a bounded whole-job deadline.', 422);
}

async function executionRepository(env: BillingBindings, input: PreviewExecutionInput): Promise<Repository> {
  const repo = await billingMetadata<Repository>(env, { repo_id: input.repo_id });
  invariant(repo?.owner_id === input.account_id && repo.state === 'active', 'repository_unavailable', 'The owning account and repository must be current before consumption.', 409);
  if (input.team_id) {
    invariant(await one(env.DB, 'SELECT id FROM teams WHERE id=? AND account_id=?', input.team_id, input.account_id), 'team_scope', 'The cost attribution team is outside this account.', 422);
  }
  return repo;
}

type ExecutionAmounts = Omit<ExecutionQuote, 'attribution' | 'execution_cell_id' | 'repository_storage_limit_bytes' | 'slice_id' | 'routing_epoch' | 'quoted_at'>;
async function executionAmounts(db: Database, input: PreviewExecutionInput, plan: Plan, entitlements: Entitlements): Promise<ExecutionAmounts> {
  const rates = {
    compute: await currentRate(db, input.executor === 'hosted' ? `hosted.${input.profile}` : 'self_hosted'),
    storage: await currentRate(db, 'storage.blobs'), egress: await currentRate(db, 'execution.egress'),
  };
  const storageBytes = input.maximum_storage_bytes ?? '0';
  const egressBytes = input.maximum_egress_bytes ?? '0';
  invariant(units(storageBytes) <= units(plan.max_storage_bytes), 'storage_quota', 'The request exceeds the plan storage quota.', 422);
  invariant(units(egressBytes) <= units(entitlements.maximum_egress_bytes), 'egress_quota', 'The request exceeds the plan egress quota.', 422);
  const retention = integer(input.storage_retention_seconds ?? 0, 'storage_retention_seconds', entitlements.maximum_retention_seconds) * 1000;
  invariant(storageBytes === '0' || retention > 0, 'retention_required', 'Storage must have an explicit retained lifetime.', 422);
  const grace = 86_400_000;
  const storageQuantity = (units(storageBytes) * BigInt(retention + grace + input.maximum_duration_ms)).toString();
  // Per-object ceil reservations need at most one extra unit each, even when the aggregate meter uses a fractional rate.
  const objectHeadroom = storageBytes === '0' ? 0n : BigInt(entitlements.maximum_objects);
  const storage = units(maximumCharge(storageQuantity, rates.storage)) + objectHeadroom;
  const platformStorage = units(maximumCharge(storageQuantity, rates.storage, true)) + objectHeadroom;
  const total = (platform: boolean, storageCost: bigint) => (units(maximumCharge(String(input.maximum_duration_ms), rates.compute, platform))
    + units(maximumCharge(egressBytes, rates.egress, platform)) + storageCost).toString();
  return {
    executor: input.executor, profile: input.profile, duration_ms: input.maximum_duration_ms, storage_bytes: storageBytes,
    storage_retention_ms: retention, storage_cleanup_grace_ms: grace, maximum_objects: entitlements.maximum_objects,
    egress_bytes: egressBytes, rates, maximum_charge_units: total(false, storage), maximum_platform_units: total(true, platformStorage),
    storage_charge_units: storage.toString(), platform_storage_units: platformStorage.toString(),
  };
}

/** A priced configuration snapshot. Eligibility is advisory; only execution admission can issue a grant. */
export async function previewExecutionQuote(env: BillingBindings, input: PreviewExecutionInput): Promise<ExecutionQuotePreview> {
  try { return await readExecutionPreview(env, input); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    throw new BillingError('billing_preview_unavailable', 'Current billing configuration and prices could not be verified for this preview.', 503);
  }
}

async function readExecutionPreview(env: BillingBindings, input: PreviewExecutionInput): Promise<ExecutionQuotePreview> {
  env = billingEnvironment(env);
  invariant(!['run_id', 'attempt_id', 'generation'].some(key => Object.hasOwn(input, key)), 'preview_runtime_identity', 'A compiler quote preview takes no runtime identity.', 422);
  const db = env.DB.withSession('first-primary');
  const owner = await one<{ id: string }>(db, 'SELECT id FROM accounts WHERE id=? AND disabled_at IS NULL', input.account_id);
  invariant(owner, 'account_not_found', 'Account not found.', 404);
  const account = await one<BillingAccount>(db, 'SELECT * FROM billing_accounts WHERE account_id=?', input.account_id);
  // This is the same initial plan selected by ensureBillingAccount, without creating that account or its credits.
  const plan = await getPlan(db, account?.plan_id ?? 'plan_free_202610');
  const entitlements = planEntitlements(plan);
  validateExecutionDuration(input, entitlements);
  const repository = await executionRepository(env, input);
  const amounts = await executionAmounts(db, input, plan, entitlements);
  const sliceId = typeof env.BILLING_PLATFORM_SLICE_ID === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(env.BILLING_PLATFORM_SLICE_ID) ? env.BILLING_PLATFORM_SLICE_ID : null;
  const availability = await previewAvailability(env, account, input.account_id, sliceId);
  const current = await one<{ plan_id: string; revision: number }>(db, 'SELECT plan_id,revision FROM billing_accounts WHERE account_id=?', input.account_id);
  const currentRepo = await executionRepository(env, input);
  invariant(current?.revision === account?.revision && current?.plan_id === account?.plan_id && currentRepo.revision === repository.revision
    && currentRepo.routing_epoch === repository.routing_epoch, 'preview_authority_changed', 'The payer, subscription or repository changed during preview.', 409);
  return { ...amounts, kind: 'preview', currency: 'USD', payer_account_id: repository.owner_id,
    execution_cell_id: env.CELL_ID, repository_storage_limit_bytes: String(limits(env).repository_storage_bytes),
    attribution: { account_id: repository.owner_id, repo_id: input.repo_id, actor_id: input.actor_id, workflow_id: input.workflow_id ?? null,
      team_id: input.team_id ?? null, run_id: null, attempt_id: null, generation: null },
    slice_id: sliceId, routing_epoch: repository.routing_epoch, repository_revision: repository.revision, quoted_at: now(), availability,
    subscription: { initialized: account !== null, plan_id: plan.id, plan_version: plan.version, revision: account?.revision ?? null, state: account?.state ?? 'uninitialized' } };
}

async function previewAvailability(env: BillingBindings, account: BillingAccount | null, accountId: string, sliceId: string | null): Promise<ExecutionQuotePreview['availability']> {
  const reasons: ExecutionQuotePreview['availability']['reasons'] = [];
  if (!account) reasons.push({ code: 'billing_account_uninitialized', message: 'Billing setup is required before execution admission.' });
  else if (account.state !== 'active') reasons.push({ code: 'subscription_inactive', message: 'The subscription does not currently permit new paid work.' });
  else if (account.period_end <= now()) reasons.push({ code: 'billing_period_expired', message: 'The billing period requires settlement and renewal.' });
  const slice = sliceId ? await one<CapacitySlice & { pool_state: string }>(env.DB.withSession('first-primary'), `SELECT s.*,p.state AS pool_state FROM billing_capacity_slices s
    JOIN billing_platform_pools p ON p.id=s.pool_id WHERE s.id=?`, sliceId) : null;
  if (!slice) reasons.push({ code: 'capacity_unconfigured', message: 'This cell has no configured operating-cost allocation.' });
  else if (slice.cell_id !== env.CELL_ID || slice.purpose !== 'discretionary') reasons.push({ code: 'capacity_scope', message: 'The configured allocation does not serve customer execution in this cell.' });
  else if (slice.state !== 'active' || slice.pool_state !== 'active' || slice.valid_until <= now()) reasons.push({ code: 'platform_stopped', message: 'The operating-cost allocation is stopped or expired.' });
  const controls = await many<{ body_json: string }>(env.DB.withSession('first-primary'), 'SELECT body_json FROM billing_controls WHERE coordinator_id IN (?,?)', `account:${accountId}`, `capacity:${sliceId ?? ''}`);
  for (const row of controls) {
    const control = JSON.parse(row.body_json) as AdmissionControl;
    if (control.stopped) reasons.push({ code: control.kind === 'account' ? 'execution_stopped' : 'platform_stopped', message: 'The recorded admission control is stopped.' });
  }
  return { state: reasons.length ? 'unavailable' : 'eligible', admission_required: true, reasons };
}

export async function activeSlice(env: Pick<BillingBindings, 'DB'>, id: string, continuingStorage = false): Promise<CapacitySlice> {
  env = billingEnvironment(env);
  const row = await one<CapacitySlice & { pool_state: string }>(env.DB, `SELECT s.*,p.state AS pool_state FROM billing_capacity_slices s
    JOIN billing_platform_pools p ON p.id=s.pool_id WHERE s.id=?`, id);
  invariant(row && row.state === 'active' && row.pool_state === 'active' && (continuingStorage || row.valid_until > now()),
    'platform_stopped', 'The operating-cost allocation is stopped, expired or unavailable.', 503);
  return row;
}

export async function initialControl(env: BillingBindings, target: string): Promise<{ control: AdmissionControl; budgets: Budget[]; subscription?: { id: string; amount_units: string } }> {
  const [kind, id] = target.split(':');
  invariant((kind === 'account' || kind === 'capacity') && id, 'coordinator_scope', 'Unknown admission coordinator.', 404);
  const at = now();
  let maxConcurrency: number, storageBytes: string, cap: string, validUntil: string, accountId: string | null;
  let subscription: { id: string; amount_units: string } | undefined;
  if (kind === 'account') {
    const account = await ensureBillingAccount(env, id);
    invariant(account.admission_epoch === 0, 'admission_recovery_required', 'Existing billing state must be reconciled before coordinator recovery.', 503);
    const plan = await getPlan(env.DB, account.plan_id);
    subscription = { id: `subscription:${account.period_start}`, amount_units: await subscriptionCommitmentUnits(env.DB, account, plan) };
    maxConcurrency = plan.max_concurrency;
    storageBytes = (units(plan.max_storage_bytes) < BigInt(limits(env).account_storage_bytes) ? units(plan.max_storage_bytes) : BigInt(limits(env).account_storage_bytes)).toString();
    cap = plan.default_budget_units;
    validUntil = account.period_end; accountId = id;
    await guardedBatch(env.DB, stmt(env.DB, 'UPDATE billing_accounts SET admission_epoch=1,admission_initialized_at=? WHERE account_id=? AND admission_epoch=0', at, id), []);
  } else {
    const slice = await activeSlice(env, id);
    invariant(slice.admission_epoch === 0, 'admission_recovery_required', 'Existing capacity state must be reconciled before coordinator recovery.', 503);
    maxConcurrency = slice.max_instances; storageBytes = slice.max_storage_bytes; cap = slice.limit_units; validUntil = slice.valid_until; accountId = null;
    await guardedBatch(env.DB, stmt(env.DB, 'UPDATE billing_capacity_slices SET admission_epoch=1 WHERE id=? AND admission_epoch=0', id), []);
  }
  const budget: Budget = {
    id: `budget:${target}:root`, account_id: accountId ?? target, scope: 'account', scope_id: accountId ?? target,
    limit_units: cap, safety_buffer_units: '0', settled_units: '0', reserved_units: '0', commitment_units: '0',
    period_start: at, period_end: null, threshold_percentages: [50, 80, 100], revision: 1, stopped: false,
  };
  return { control: {
    id: target, kind, account_id: accountId, revision: 1, epoch: 1, coordinator_cell_id: env.CELL_ID, stopped: false, stop_reason: null, valid_until: validUntil,
    max_concurrency: maxConcurrency, max_queue: 256, max_storage_bytes: storageBytes, active_slots: 0,
    object_count: 0, max_objects: storagePolicy(env).maximum_objects,
    reserved_bytes: '0', stored_bytes: '0', budget_ids: [budget.id], plan_budget_id: budget.id, next_ticket: 0, next_event: 0,
  }, budgets: [budget], subscription };
}

export async function subscriptionCommitmentUnits(db: Database, account: Pick<BillingAccount, 'account_id' | 'seat_count'>, plan: Plan): Promise<string> {
  const pending = await one<{ seats: number }>(db, "SELECT COALESCE(SUM(additional_seats),0) AS seats FROM billing_seat_reservations WHERE account_id=? AND state='reserved'", account.account_id);
  return (units(plan.monthly_base_units) + units(plan.seat_units) * BigInt(account.seat_count + (pending?.seats ?? 0))).toString();
}

export async function guardedBatch(db: Database, first: D1PreparedStatement, after: D1PreparedStatement[]): Promise<void> {
  const guard = newId('bill_guard');
  try {
    await db.batch([first, stmt(db, 'INSERT INTO billing_write_guards (id,valid) VALUES (?,changes())', guard), ...after,
      stmt(db, 'DELETE FROM billing_write_guards WHERE id=?', guard)]);
  } catch (error) {
    if (/CHECK constraint failed.*valid|UNIQUE constraint failed/i.test(String(error))) {
      throw new BillingError('billing_conflict', 'Billing state changed; retry using the same operation ID.', 409);
    }
    throw error;
  }
}

/** Offline/operator control-plane allocation: immutable slices, one CAS over the finite pool. */
export async function allocatePlatformSlices(env: Pick<BillingBindings, 'DB'>, input: {
  pool_id: string; expected_revision: number; slices: Array<{ id: string; cell_id: string; limit_units: string; max_instances: number; max_storage_bytes: string; valid_until: string }>;
}): Promise<void> {
  env = billingEnvironment(env);
  const db = env.DB;
  const pool = await one<{ limit_units: string; safety_buffer_units: string; baseline_commitment_units: string; allocated_units: string; max_instances: number; allocated_instances: number; revision: number; period_end: string; state: string; purpose: string }>(db,
    'SELECT * FROM billing_platform_pools WHERE id=?', input.pool_id);
  invariant(pool && pool.state === 'active' && pool.revision === input.expected_revision, 'platform_configuration', 'The platform allocation changed.', 412);
  invariant(input.slices.length > 0 && input.slices.length <= 64, 'slice_limit', 'Allocate between one and 64 bounded slices.', 422);
  let amount = units(pool.allocated_units), instances = pool.allocated_instances;
  const statements: D1PreparedStatement[] = [];
  for (const slice of input.slices) {
    amount += units(slice.limit_units); instances += integer(slice.max_instances, 'max_instances', 10_000); units(slice.max_storage_bytes);
    invariant(slice.valid_until > now() && slice.valid_until <= pool.period_end, 'slice_lifetime', 'Slice admission lifetime must fit its parent allocation.', 422);
    statements.push(stmt(db, `INSERT INTO billing_capacity_slices (id,pool_id,cell_id,limit_units,max_instances,max_storage_bytes,valid_until,state,created_at,purpose)
      VALUES (?,?,?,?,?,?,?,'active',?,?)`, slice.id, input.pool_id, slice.cell_id, slice.limit_units, slice.max_instances, slice.max_storage_bytes, slice.valid_until, now(), pool.purpose));
  }
  invariant(amount + units(pool.safety_buffer_units) + units(pool.baseline_commitment_units) <= units(pool.limit_units)
    && instances <= pool.max_instances, 'platform_budget_exhausted', 'Slices, base services and safety headroom exceed the platform pool.', 422);
  statements.push(auditStatement(db, { action: 'billing.capacity.allocated', resource_id: input.pool_id, resource_revision: pool.revision + 1,
    details: { slices: input.slices.map((s) => s.id), allocated_units: amount.toString(), allocated_instances: instances } }));
  await guardedBatch(db, stmt(db, 'UPDATE billing_platform_pools SET allocated_units=?,allocated_instances=?,revision=revision+1 WHERE id=? AND revision=?',
    amount.toString(), instances, input.pool_id, input.expected_revision), statements);
}

export async function listPlans(db: Database): Promise<Plan[]> {
  return many<Plan>(db, 'SELECT * FROM billing_plans ORDER BY created_at,id');
}

export async function reserveSubscriptionCommitment(env: BillingBindings, accountId: string, plan: Plan, seats: number): Promise<void> {
  const pending = await one<{ seats: number }>(env.DB, `SELECT COALESCE(SUM(additional_seats),0) AS seats FROM billing_seat_reservations
    WHERE account_id=? AND state='reserved'`, accountId);
  const maximum = units(plan.monthly_base_units) + units(plan.seat_units) * BigInt(seats + (pending?.seats ?? 0));
  await admissionRequest(env, `account:${accountId}`, 'fixed-cost', {
    id: `subscription:${monthWindow().period_start}`, amount_units: maximum.toString(),
  });
}
