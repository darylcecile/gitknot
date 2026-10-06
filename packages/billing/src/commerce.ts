import { auditStatement, eventStatement, many, newId, now, one, sha256, stmt, internalFetch } from '@gitknot/core';
import type { Database } from '@gitknot/core';
import { ensureBillingAccount, getPlan, guardedBatch, reserveSubscriptionCommitment } from './catalog.ts';
import type { BillingAccount, Plan } from './catalog.ts';
import { invariant } from './errors.ts';
import { integer, invoiceRounding, monthWindow, signedUnits, units } from './money.ts';
import { admissionRequest } from './transport.ts';
import type { AdmissionControl, BillingBindings, Budget, LedgerEntry } from './types.ts';
import { billingEnvironment } from './authority.ts';
import { usageRollups } from './usage.ts';

// A multiple of every Gregorian month's millisecond length (28, 29, 30, 31 days).
// Proration therefore carries an exact rational remainder across different months.
export const PRORATION_DENOMINATOR = 65_245_824_000_000n;

export interface Credit {
  id: string; account_id: string; amount_units: string; remaining_units: string; reason: string;
  source: 'included' | 'operator' | 'processor' | 'refund'; source_id: string; expires_at: string | null;
  revision: number; created_at: string; actor_id: string;
}

export interface Invoice {
  id: string; account_id: string; period_start: string; period_end: string; state: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
  currency: 'USD'; subtotal_units: string; credit_applied_units: string; payable_units: string; rounded_units: string;
  processor_amount_cents: string; rounding_carry_units: string; processor_payment_id: string | null;
  collection_method: 'manual' | 'processor'; issued_at: string; due_at: string; paid_at: string | null; revision: number;
}

export interface SeatPreview {
  account_id: string; plan_id: string; subscription_revision: number; current_seats: number; reserved_seats: number;
  additional_seats: number; resulting_seats: number; monthly_delta_units: string; maximum_current_period_units: string;
  currency: 'USD'; expires_at: string; requires_payment_method: boolean;
}

export async function previewSeatChange(env: Pick<BillingBindings, 'DB'>, input: { account_id: string; additional_seats: number }): Promise<SeatPreview> {
  env = billingEnvironment(env);
  integer(input.additional_seats, 'additional_seats', 100_000);
  const account = await ensureBillingAccount(env, input.account_id);
  const plan = await getPlan(env.DB, account.plan_id);
  const reserved = await one<{ seats: number }>(env.DB, `SELECT COALESCE(SUM(additional_seats),0) AS seats FROM billing_seat_reservations WHERE account_id=? AND state='reserved'`, input.account_id);
  const resulting = account.seat_count + (reserved?.seats ?? 0) + input.additional_seats;
  invariant(resulting <= plan.max_seats, 'seat_limit', 'The invitation would exceed the plan seat entitlement.', 422);
  const window = monthWindow();
  const monthly = units(plan.seat_units) * BigInt(input.additional_seats);
  const duration = BigInt(Date.parse(window.period_end) - Date.parse(window.period_start));
  const remaining = BigInt(Math.max(0, Date.parse(window.period_end) - Date.now()));
  const maximum = (monthly * remaining + duration - 1n) / duration;
  return {
    account_id: input.account_id, plan_id: plan.id, subscription_revision: account.revision, current_seats: account.seat_count,
    reserved_seats: reserved?.seats ?? 0, additional_seats: input.additional_seats, resulting_seats: resulting,
    monthly_delta_units: monthly.toString(), maximum_current_period_units: maximum.toString(), currency: 'USD',
    expires_at: window.period_end, requires_payment_method: false,
  };
}

export async function reserveSeatChange(env: BillingBindings, input: {
  account_id: string; principal_id: string; additional_seats: number; request_id: string; expected_revision: number;
}): Promise<SeatPreview & { reservation_id: string }> {
  env = billingEnvironment(env);
  const id = `seat_${(await sha256(`${input.account_id}:${input.request_id}`)).slice(0, 48)}`;
  const hash = await sha256(JSON.stringify(input));
  const old = await one<{ request_hash: string; amount_units: string; state: string }>(env.DB, 'SELECT * FROM billing_seat_reservations WHERE id=? AND account_id=?', id, input.account_id);
  if (old) {
    invariant(old.request_hash === hash && old.state !== 'cancelled', 'idempotency_conflict', 'This seat request has already been used.');
    const preview = await previewSeatChange(env, { account_id: input.account_id, additional_seats: 0 });
    return { ...preview, additional_seats: input.additional_seats, maximum_current_period_units: old.amount_units, reservation_id: id };
  }
  const preview = await previewSeatChange(env, input);
  invariant(preview.subscription_revision === input.expected_revision && input.additional_seats > 0, 'seat_preview_stale', 'Refresh the seat-cost preview before accepting this change.', 412);
  const plan = await getPlan(env.DB, preview.plan_id);
  await reserveSubscriptionCommitment(env, input.account_id, plan, preview.current_seats + input.additional_seats);
  await guardedBatch(env.DB, stmt(env.DB, 'UPDATE billing_accounts SET revision=revision+1,updated_at=? WHERE account_id=? AND revision=? AND plan_id=? AND state=?',
    now(), input.account_id, input.expected_revision, plan.id, 'active'), [
    stmt(env.DB, `INSERT INTO billing_seat_reservations
      (id,account_id,principal_id,additional_seats,plan_id,subscription_revision,amount_units,state,request_hash,created_at)
      VALUES (?,?,?,?,?,?,?,'reserved',?,?)`, id, input.account_id, input.principal_id, input.additional_seats, plan.id,
    input.expected_revision, preview.maximum_current_period_units, hash, now()),
    auditStatement(env.DB, { action: 'billing.seat.reserved', resource_id: id, account_id: input.account_id,
      details: { additional_seats: input.additional_seats, maximum_charge_units: preview.maximum_current_period_units } }),
  ]);
  return { ...preview, reservation_id: id };
}

/** Include these statements in the SAME guarded D1 batch as membership acceptance. */
export async function seatAcceptanceStatements(db: Database, input: { account_id: string; reservation_id: string; principal_id: string }): Promise<D1PreparedStatement[]> {
  const seat = await one<{ state: string; plan_id: string; additional_seats: number; created_at: string }>(db,
    'SELECT * FROM billing_seat_reservations WHERE id=? AND account_id=? AND principal_id=?', input.reservation_id, input.account_id, input.principal_id);
  invariant(seat?.state === 'reserved', 'seat_reservation_required', 'Accepting this membership requires its pending seat reservation.');
  const account = await one<BillingAccount>(db, 'SELECT * FROM billing_accounts WHERE account_id=?', input.account_id);
  invariant(account && account.plan_id === seat.plan_id && seat.created_at >= monthWindow().period_start, 'seat_preview_stale', 'The plan or billing period changed; preview and reserve the seat again.');
  const at = now();
  const guard = newId('bill_guard');
  return [
    stmt(db, `UPDATE billing_seat_reservations SET state='consumed',consumed_at=?,revision=revision+1
      WHERE id=? AND account_id=? AND principal_id=? AND state='reserved' AND EXISTS
      (SELECT 1 FROM billing_accounts WHERE account_id=? AND plan_id=? AND revision=? AND state='active')`,
    at, input.reservation_id, input.account_id, input.principal_id, input.account_id, account.plan_id, account.revision),
    stmt(db, 'INSERT INTO billing_write_guards (id,valid) VALUES (?,changes())', guard),
    stmt(db, 'UPDATE billing_accounts SET seat_count=seat_count+?,revision=revision+1,updated_at=? WHERE account_id=?', seat.additional_seats, at, input.account_id),
    stmt(db, 'UPDATE billing_plan_segments SET ended_at=? WHERE account_id=? AND ended_at IS NULL', at, input.account_id),
    stmt(db, `INSERT INTO billing_plan_segments (id,account_id,plan_id,seat_count,started_at,created_at)
      SELECT ?,account_id,plan_id,seat_count,?,? FROM billing_accounts WHERE account_id=?`, `segment:${input.reservation_id}`, at, at, input.account_id),
    stmt(db, 'INSERT INTO billing_seat_events (id,account_id,principal_id,delta,reservation_id,occurred_at) VALUES (?,?,?,?,?,?)',
      `seat-event:${input.reservation_id}`, input.account_id, input.principal_id, seat.additional_seats, input.reservation_id, at),
    eventStatement(db, { id: `evt:${input.reservation_id}:consumed`, type: 'billing.seat.consumed', resource_id: input.reservation_id,
      resource_revision: 2, account_id: input.account_id, data: { principal_id: input.principal_id, seats: seat.additional_seats } }),
    stmt(db, 'DELETE FROM billing_write_guards WHERE id=?', guard),
  ];
}

export async function cancelSeatReservation(env: Pick<BillingBindings, 'DB'>, input: { account_id: string; reservation_id: string }): Promise<void> {
  env = billingEnvironment(env);
  const seat = await one<{ state: string; revision: number }>(env.DB, 'SELECT state,revision FROM billing_seat_reservations WHERE id=? AND account_id=?', input.reservation_id, input.account_id);
  invariant(seat, 'seat_not_found', 'Seat reservation not found.', 404);
  if (seat.state === 'cancelled') return;
  invariant(seat.state === 'reserved', 'seat_already_consumed', 'A consumed seat must be removed through membership administration.');
  await guardedBatch(env.DB, stmt(env.DB, "UPDATE billing_seat_reservations SET state='cancelled',revision=revision+1 WHERE id=? AND account_id=? AND state='reserved' AND revision=?", input.reservation_id, input.account_id, seat.revision), [
    auditStatement(env.DB, { action: 'billing.seat.cancelled', resource_id: input.reservation_id, account_id: input.account_id }),
  ]);
  // The period peak standing commitment remains until invoice close, preventing proration or delayed-acceptance races.
}

export async function changeSubscription(env: BillingBindings, input: {
  account_id: string; plan_id: string; expected_revision: number; actor_id: string; request_id: string;
}): Promise<BillingAccount> {
  env = billingEnvironment(env);
  const db = env.DB;
  const id = `sub_${(await sha256(`${input.account_id}:${input.request_id}`)).slice(0, 48)}`;
  const hash = await sha256(JSON.stringify(input));
  let existing = await one<{ request_hash: string; state: string; previous_stopped: number }>(db,
    'SELECT * FROM billing_subscription_changes WHERE id=? AND account_id=?', id, input.account_id);
  if (existing) invariant(existing.request_hash === hash, 'idempotency_conflict', 'The subscription request has different inputs.');
  if (existing?.state === 'complete') return ensureBillingAccount(env, input.account_id);
  const account = await ensureBillingAccount(env, input.account_id);
  invariant(account.state === 'active', 'subscription_inactive', 'Reactivate or settle the account before changing plans.');
  const pendingChange = await one(env.DB, "SELECT id FROM billing_subscription_changes WHERE account_id=? AND state='pending' AND id!=?", input.account_id, id);
  invariant(!pendingChange, 'subscription_change_pending', 'A prior plan change is still being reconciled.');
  const plan = await getPlan(db, input.plan_id);
  invariant(account.seat_count <= plan.max_seats, 'seat_limit', 'Remove excess seats before changing to this plan.', 422);
  const target = `account:${input.account_id}`;
  let snapshot = await admissionRequest<{ control: AdmissionControl; budgets: Budget[] }>(env, target, 'snapshot');
  invariant(snapshot.control.active_slots <= plan.max_concurrency
    && units(snapshot.control.stored_bytes) + units(snapshot.control.reserved_bytes) <= units(plan.max_storage_bytes),
  'entitlement_in_use', 'Existing reservations exceed the new plan entitlement.', 422);
  await reserveSubscriptionCommitment(env, input.account_id, plan, account.seat_count);
  snapshot = await admissionRequest(env, target, 'snapshot');
  const reason = `Subscription change ${id}`;
  invariant(!snapshot.control.stop_reason?.startsWith('Subscription change ') || snapshot.control.stop_reason === reason,
    'subscription_change_pending', 'A prior plan change is still being reconciled.');
  if (!existing) {
    invariant(account.revision === input.expected_revision, 'revision_conflict', 'The subscription changed.', 412);
    const priorStopped = snapshot.control.stopped;
    await admissionRequest(env, target, 'stop', { stopped: true, reason, revision: snapshot.control.revision });
    const at = now();
    try {
      await guardedBatch(db, stmt(db, 'UPDATE billing_accounts SET plan_id=?,revision=revision+1,updated_at=? WHERE account_id=? AND revision=?',
        plan.id, at, input.account_id, input.expected_revision), [
        stmt(db, `INSERT INTO billing_subscription_changes (id,account_id,previous_plan_id,plan_id,effective_at,actor_id,request_hash,created_at,previous_stopped)
          VALUES (?,?,?,?,?,?,?,?,?)`, id, input.account_id, account.plan_id, plan.id, at, input.actor_id, hash, at, priorStopped ? 1 : 0),
        stmt(db, 'UPDATE billing_plan_segments SET ended_at=? WHERE account_id=? AND ended_at IS NULL', at, input.account_id),
        stmt(db, 'INSERT INTO billing_plan_segments (id,account_id,plan_id,seat_count,started_at,created_at) VALUES (?,?,?,?,?,?)',
          `segment:${id}`, input.account_id, plan.id, account.seat_count, at, at),
        eventStatement(db, { type: 'billing.subscription.changed', resource_id: input.account_id, resource_revision: account.revision + 1,
          account_id: input.account_id, actor_id: input.actor_id, data: { plan_id: plan.id, previous_plan_id: account.plan_id } }),
        auditStatement(db, { action: 'billing.subscription.changed', resource_id: input.account_id, account_id: input.account_id,
          actor_id: input.actor_id, details: { plan_id: plan.id, operation_id: id } }),
      ]);
    } catch (error) {
      const current = await admissionRequest<{ control: AdmissionControl }>(env, target, 'snapshot');
      if (!priorStopped && current.control.stop_reason === reason) await admissionRequest(env, target, 'stop', { stopped: false, reason: null, revision: current.control.revision });
      throw error;
    }
    existing = { request_hash: hash, state: 'pending', previous_stopped: priorStopped ? 1 : 0 };
  }
  snapshot = await admissionRequest(env, target, 'snapshot');
  const configured = await admissionRequest<AdmissionControl>(env, target, 'limits', {
    max_concurrency: plan.max_concurrency, max_storage_bytes: plan.max_storage_bytes, revision: snapshot.control.revision,
  });
  if (!existing.previous_stopped && configured.stop_reason === reason) await admissionRequest(env, target, 'stop', { stopped: false, reason: null, revision: configured.revision });
  await db.prepare("UPDATE billing_subscription_changes SET state='complete' WHERE id=? AND account_id=?").bind(id, input.account_id).run();
  return ensureBillingAccount(env, input.account_id);
}

export async function reconcileSubscriptionChange(env: BillingBindings, id: string): Promise<void> {
  env = billingEnvironment(env);
  const change = await one<{ account_id: string; plan_id: string; state: string; previous_stopped: number }>(env.DB, 'SELECT * FROM billing_subscription_changes WHERE id=?', id);
  if (!change || change.state === 'complete') return;
  const account = await ensureBillingAccount(env, change.account_id);
  invariant(account.plan_id === change.plan_id, 'subscription_reconciliation_conflict', 'The pending plan and account pointer disagree.', 503);
  const plan = await getPlan(env.DB, change.plan_id);
  const target = `account:${change.account_id}`;
  const snapshot = await admissionRequest<{ control: AdmissionControl }>(env, target, 'snapshot');
  const updated = await admissionRequest<AdmissionControl>(env, target, 'limits', { max_concurrency: plan.max_concurrency, max_storage_bytes: plan.max_storage_bytes, revision: snapshot.control.revision });
  if (!change.previous_stopped && updated.stop_reason === `Subscription change ${id}`) await admissionRequest(env, target, 'stop', { stopped: false, reason: null, revision: updated.revision });
  await env.DB.prepare("UPDATE billing_subscription_changes SET state='complete' WHERE id=? AND state='pending'").bind(id).run();
}

interface InvoiceLine { id: string; description: string; quantity: string; amount_units: string; price_version: string; kind: string }

async function subscriptionLines(db: Database, account: BillingAccount): Promise<{ lines: InvoiceLine[]; remainder: string }> {
  const segments = await many<{ id: string; plan_id: string; seat_count: number; started_at: string; ended_at: string | null;
    name: string; version: string; monthly_base_units: string; seat_units: string }>(db, `SELECT s.*,p.name,p.version,p.monthly_base_units,p.seat_units
    FROM billing_plan_segments s JOIN billing_plans p ON p.id=s.plan_id WHERE s.account_id=? AND s.started_at<?
    AND (s.ended_at IS NULL OR s.ended_at>?) ORDER BY s.started_at,s.id`, account.account_id, account.period_end, account.period_start);
  let remainder = units(account.subscription_remainder);
  const periodMs = BigInt(Date.parse(account.period_end) - Date.parse(account.period_start));
  invariant(periodMs > 0n && PRORATION_DENOMINATOR % periodMs === 0n, 'billing_period_invalid', 'Billing periods must be UTC calendar months.', 503);
  const lines: InvoiceLine[] = [];
  for (const segment of segments) {
    const start = Math.max(Date.parse(segment.started_at), Date.parse(account.period_start));
    const end = Math.min(Date.parse(segment.ended_at ?? account.period_end), Date.parse(account.period_end));
    const monthly = units(segment.monthly_base_units) + units(segment.seat_units) * BigInt(segment.seat_count);
    const numerator = monthly * BigInt(end - start) * (PRORATION_DENOMINATOR / periodMs) + remainder;
    const amount = numerator / PRORATION_DENOMINATOR;
    remainder = numerator % PRORATION_DENOMINATOR;
    lines.push({ id: `${segment.id}:${account.period_start}`, description: `${segment.name}: ${segment.seat_count} seats, ${new Date(start).toISOString()}–${new Date(end).toISOString()}`,
      quantity: String(end - start), amount_units: amount.toString(), price_version: `${segment.plan_id}:${segment.version}`, kind: 'subscription' });
  }
  return { lines, remainder: remainder.toString() };
}

function applyCredits(credits: Credit[], due: bigint): Array<{ credit: Credit; amount: bigint }> {
  const applied: Array<{ credit: Credit; amount: bigint }> = [];
  for (const credit of credits) {
    if (due === 0n) break;
    const amount = units(credit.remaining_units) > due ? due : units(credit.remaining_units);
    if (amount > 0n) applied.push({ credit, amount });
    due -= amount;
  }
  return applied;
}

/** A closed immutable period plus a revision/credit guarded D1 transaction makes invoicing retry-safe. */
export async function closeInvoice(env: BillingBindings, accountId: string): Promise<Invoice> {
  env = billingEnvironment(env);
  const db = env.DB;
  const account = await ensureBillingAccount(env, accountId);
  invariant(account.period_end <= now(), 'billing_period_open', 'The billing period is still open.', 409);
  const previous = await one<Invoice>(db, 'SELECT * FROM billing_invoices WHERE account_id=? AND period_start=? AND period_end=?', accountId, account.period_start, account.period_end);
  if (previous) return previous;
  await admissionRequest(env, `account:${accountId}`, 'close-period', { through: account.period_end });
  const usage = await usageRollups(db, { account_id: accountId, period: account.period_start.slice(0, 7), dimension: 'account', limit: 1001 });
  invariant(usage.length <= 1000, 'invoice_meter_limit', 'The full account meter set requires invoice reconciliation.', 503);
  const subscription = await subscriptionLines(db, account);
  const fees = subscription.lines.reduce((sum, line) => sum + units(line.amount_units), 0n);
  const subtotal = usage.reduce((sum, entry) => sum + signedUnits(entry.amount_units), fees);
  invariant(subtotal >= 0n, 'billing_reconciliation', 'Negative statements require an explicit account credit.', 503);
  const credits = await many<Credit>(db, `SELECT * FROM billing_credits WHERE account_id=? AND remaining_units!='0' AND created_at<?
    AND (expires_at IS NULL OR expires_at>?) ORDER BY COALESCE(expires_at,'9999'),created_at,id`, accountId, account.period_end, account.period_start);
  const applied = applyCredits(credits, subtotal);
  const creditTotal = applied.reduce((sum, entry) => sum + entry.amount, 0n);
  const payable = subtotal - creditTotal;
  const rounded = invoiceRounding(payable.toString(), account.rounding_carry_units);
  const at = now();
  const id = `inv_${(await sha256(`${accountId}:${account.period_start}:${account.period_end}`)).slice(0, 48)}`;
  const next = monthWindow(new Date(account.period_end));
  const plan = await getPlan(db, account.plan_id);
  const statements: D1PreparedStatement[] = [
    stmt(db, `INSERT INTO billing_invoices (id,account_id,period_start,period_end,state,currency,subtotal_units,credit_applied_units,payable_units,
      rounded_units,processor_amount_cents,rounding_carry_units,collection_method,issued_at,due_at,paid_at)
      VALUES (?,?,?,?,?,'USD',?,?,?,?,?,?,?,?,?,?)`, id, accountId, account.period_start, account.period_end,
    rounded.cents === '0' ? 'paid' : 'open', subtotal.toString(), creditTotal.toString(), payable.toString(), rounded.rounded_units,
    rounded.cents, rounded.carry_units, account.collection_method, at, new Date(Date.now() + 30 * 86_400_000).toISOString(), rounded.cents === '0' ? at : null),
  ];
  for (const line of subscription.lines) statements.push(stmt(db, 'INSERT INTO billing_invoice_lines (id,invoice_id,description,quantity,amount_units,price_version,kind) VALUES (?,?,?,?,?,?,?)',
    `${id}:${line.id}`, id, line.description, line.quantity, line.amount_units, line.price_version, line.kind));
  statements.push(stmt(db, `INSERT INTO billing_invoice_entries (invoice_id,ledger_id) SELECT ?,id FROM billing_ledger
    WHERE account_id=? AND operating_cost=0 AND occurred_at>=? AND occurred_at<?`, id, accountId, account.period_start, account.period_end));
  for (const { credit, amount } of applied) {
    const guard = newId('bill_guard');
    statements.push(stmt(db, 'UPDATE billing_credits SET remaining_units=?,revision=revision+1 WHERE id=? AND account_id=? AND revision=?',
      (units(credit.remaining_units) - amount).toString(), credit.id, accountId, credit.revision),
    stmt(db, 'INSERT INTO billing_write_guards (id,valid) VALUES (?,changes())', guard),
    stmt(db, 'INSERT INTO billing_credit_applications (invoice_id,credit_id,amount_units) VALUES (?,?,?)', id, credit.id, amount.toString()),
    stmt(db, 'DELETE FROM billing_write_guards WHERE id=?', guard));
  }
  const included = account.state === 'active' ? plan.included_usage_units : '0';
  statements.push(stmt(db, `INSERT INTO billing_credits (id,account_id,amount_units,remaining_units,reason,source,source_id,expires_at,created_at,actor_id)
    VALUES (?,?,?,?,?,'included',?,?,?,'system:billing')`, `credit:${accountId}:${next.period_start}`, accountId, included,
  included, 'Plan included usage', next.period_start, next.period_end, next.period_start));
  statements.push(eventStatement(db, { id: `evt:${id}`, type: 'billing.invoice.created', resource_id: id, resource_revision: 1,
    account_id: accountId, data: { invoice_id: id, payable_units: payable.toString(), currency: 'USD' } }),
  auditStatement(db, { action: 'billing.invoice.created', resource_id: id, account_id: accountId, details: { period_start: account.period_start, period_end: account.period_end } }));
  statements.push(stmt(db, `INSERT INTO billing_invoice_finalizations (invoice_id,account_id,period_start,next_period_start,next_period_end,fixed_cost_units)
    VALUES (?,?,?,?,?,?)`, id, accountId, account.period_start, next.period_start, next.period_end, fees.toString()));
  await guardedBatch(db, stmt(db, `UPDATE billing_accounts SET period_start=?,period_end=?,rounding_carry_units=?,subscription_remainder=?,revision=revision+1,updated_at=?
    WHERE account_id=? AND revision=? AND period_start=?`, next.period_start, next.period_end, rounded.carry_units, subscription.remainder, at, accountId, account.revision, account.period_start), statements);
  await finalizeInvoiceAdmission(env, id);
  const invoice = await one<Invoice>(db, 'SELECT * FROM billing_invoices WHERE id=? AND account_id=?', id, accountId);
  invariant(invoice, 'invoice_unavailable', 'The committed invoice could not be read.', 503);
  return invoice;
}

export async function finalizeInvoiceAdmission(env: BillingBindings, invoiceId: string): Promise<void> {
  env = billingEnvironment(env);
  const row = await one<{ account_id: string; period_start: string; next_period_start: string; next_period_end: string; fixed_cost_units: string; state: string }>(env.DB,
    'SELECT * FROM billing_invoice_finalizations WHERE invoice_id=?', invoiceId);
  if (!row || row.state === 'complete') return;
  await admissionRequest(env, `account:${row.account_id}`, 'rollover', { period_start: row.next_period_start, period_end: row.next_period_end });
  await env.DB.prepare("UPDATE billing_invoice_finalizations SET state='complete' WHERE invoice_id=?").bind(invoiceId).run();
}

export async function redeemCreditCode(env: Pick<BillingBindings, 'DB'>, input: { account_id: string; actor_id: string; code: string }): Promise<Credit> {
  invariant(/^[A-Za-z0-9_-]{32,128}$/.test(input.code), 'credit_code_invalid', 'The credit code is invalid or unavailable.', 404);
  return redeemCreditHash(env, { account_id: input.account_id, actor_id: input.actor_id, code_hash: await sha256(input.code) });
}

/** Internal durable-operation form; the public endpoint accepts the original high-entropy code, never its hash. */
export async function redeemCreditHash(env: Pick<BillingBindings, 'DB'>, input: { account_id: string; actor_id: string; code_hash: string }): Promise<Credit> {
  env = billingEnvironment(env);
  invariant(/^[a-f0-9]{64}$/.test(input.code_hash), 'credit_code_invalid', 'The credit code is invalid or unavailable.', 404);
  await ensureBillingAccount(env, input.account_id);
  const code = await one<{ id: string; account_id: string | null; amount_units: string; reason: string; expires_at: string; redeemed_by_account_id: string | null }>(env.DB,
    'SELECT * FROM billing_credit_codes WHERE code_hash=?', input.code_hash);
  invariant(code && (!code.account_id || code.account_id === input.account_id),
    'credit_code_invalid', 'The credit code is invalid or unavailable.', 404);
  const id = `credit:code:${code.id}`;
  if (code.redeemed_by_account_id === input.account_id) {
    const previous = await one<Credit>(env.DB, 'SELECT * FROM billing_credits WHERE id=? AND account_id=?', id, input.account_id);
    invariant(previous, 'credit_unavailable', 'Credit state could not be verified.', 503);
    return previous;
  }
  invariant(code.expires_at > now(), 'credit_code_invalid', 'The credit code is invalid or unavailable.', 404);
  invariant(!code.redeemed_by_account_id, 'credit_code_invalid', 'The credit code is invalid or unavailable.', 404);
  const at = now();
  await guardedBatch(env.DB, stmt(env.DB, 'UPDATE billing_credit_codes SET redeemed_by_account_id=?,redeemed_at=? WHERE id=? AND redeemed_at IS NULL AND expires_at>?',
    input.account_id, at, code.id, at), [
    stmt(env.DB, `INSERT INTO billing_credits (id,account_id,amount_units,remaining_units,reason,source,source_id,created_at,actor_id)
      VALUES (?,?,?,?,?,'operator',?,?,?)`, id, input.account_id, code.amount_units, code.amount_units, code.reason, code.id, at, input.actor_id),
    auditStatement(env.DB, { action: 'billing.credit.redeemed', resource_id: id, account_id: input.account_id, actor_id: input.actor_id, details: { code_id: code.id, amount_units: code.amount_units } }),
    eventStatement(env.DB, { type: 'billing.credit.created', resource_id: id, resource_revision: 1, account_id: input.account_id, data: { credit_id: id, amount_units: code.amount_units } }),
  ]);
  return (await one<Credit>(env.DB, 'SELECT * FROM billing_credits WHERE id=? AND account_id=?', id, input.account_id))!;
}

export async function grantCredit(env: Pick<BillingBindings, 'DB'>, input: {
  account_id: string; amount_units: string; reason: string; source: Credit['source']; source_id: string; actor_id: string; expires_at?: string | null;
}): Promise<Credit> {
  env = billingEnvironment(env);
  invariant(units(input.amount_units) > 0n && input.reason.length > 0, 'invalid_credit', 'A credit requires a positive amount and a reason.', 422);
  await ensureBillingAccount(env, input.account_id);
  const id = `credit_${(await sha256(`${input.account_id}:${input.source}:${input.source_id}`)).slice(0, 48)}`;
  const previous = await one<Credit>(env.DB, 'SELECT * FROM billing_credits WHERE id=? AND account_id=?', id, input.account_id);
  if (previous) {
    invariant(previous.amount_units === input.amount_units && previous.reason === input.reason && previous.expires_at === (input.expires_at ?? null),
      'idempotency_conflict', 'The credit source already has a different adjustment.');
    return previous;
  }
  const credit: Credit = { ...input, id, remaining_units: input.amount_units, expires_at: input.expires_at ?? null, revision: 1, created_at: now() };
  await env.DB.batch([
    stmt(env.DB, `INSERT INTO billing_credits (id,account_id,amount_units,remaining_units,reason,source,source_id,expires_at,revision,created_at,actor_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      credit.id, credit.account_id, credit.amount_units, credit.remaining_units, credit.reason, credit.source, credit.source_id, credit.expires_at, credit.revision, credit.created_at, credit.actor_id),
    auditStatement(env.DB, { action: 'billing.credit.granted', resource_id: id, account_id: input.account_id, actor_id: input.actor_id, details: { amount_units: input.amount_units, reason: input.reason } }),
    eventStatement(env.DB, { type: 'billing.credit.created', resource_id: id, resource_revision: 1, account_id: input.account_id, actor_id: input.actor_id, data: { credit_id: id, amount_units: input.amount_units } }),
  ]);
  return credit;
}

export async function collectInvoice(env: BillingBindings, input: { account_id: string; invoice_id: string }): Promise<{ state: string; payment_id?: string }> {
  env = billingEnvironment(env);
  const invoice = await one<Invoice>(env.DB, 'SELECT * FROM billing_invoices WHERE id=? AND account_id=?', input.invoice_id, input.account_id);
  invariant(invoice, 'invoice_not_found', 'Invoice not found.', 404);
  if (invoice.state === 'paid') return { state: 'paid', payment_id: invoice.processor_payment_id ?? undefined };
  invariant(invoice.state === 'open', 'invoice_not_payable', 'Only an open invoice can be collected.');
  invariant(env.PAYMENTS && typeof env.PAYMENTS_SERVICE_KEY === 'string' && env.PAYMENTS_SERVICE_KEY.length >= 32,
    'processor_unconfigured', 'Card collection is not configured; this invoice supports manual settlement.', 503);
  const response = await internalFetch(env.PAYMENTS, env.PAYMENTS_SERVICE_KEY, 'billing.collect', '/internal/payments/collect', {
    idempotency_key: invoice.id, account_id: input.account_id, invoice_id: invoice.id, currency: 'USD', amount_cents: invoice.processor_amount_cents,
  });
  invariant(response.ok, 'payment_unavailable', 'Payment collection could not be confirmed.', 503);
  const receipt = await response.json() as { state: string; payment_id: string };
  invariant(['pending', 'requires_action', 'succeeded'].includes(receipt.state) && typeof receipt.payment_id === 'string',
    'payment_unverified', 'The payment processor returned an invalid receipt.', 503);
  await env.DB.prepare('UPDATE billing_invoices SET processor_payment_id=?,revision=revision+1 WHERE id=? AND account_id=? AND state=?')
    .bind(receipt.payment_id, invoice.id, input.account_id, 'open').run();
  // Only a separately authenticated settlement event can mark the invoice paid.
  return { state: receipt.state, payment_id: receipt.payment_id };
}

export async function recordPaymentSettlement(env: Pick<BillingBindings, 'DB'>, input: {
  account_id: string; invoice_id: string; processor_event_id: string; payment_id: string; amount_cents: string; occurred_at: string;
}): Promise<void> {
  env = billingEnvironment(env);
  const invoice = await one<Invoice>(env.DB, 'SELECT * FROM billing_invoices WHERE id=? AND account_id=?', input.invoice_id, input.account_id);
  invariant(invoice, 'invoice_not_found', 'Invoice not found.', 404);
  const hash = await sha256(JSON.stringify(input));
  const previous = await one<{ request_hash: string }>(env.DB, 'SELECT request_hash FROM billing_payment_events WHERE processor_event_id=?', input.processor_event_id);
  if (previous) { invariant(previous.request_hash === hash, 'payment_event_conflict', 'The processor event changed.'); return; }
  invariant(invoice.processor_amount_cents === input.amount_cents && invoice.state === 'open'
    && (!invoice.processor_payment_id || invoice.processor_payment_id === input.payment_id), 'payment_mismatch', 'Payment does not match the open invoice.');
  await guardedBatch(env.DB, stmt(env.DB, "UPDATE billing_invoices SET state='paid',paid_at=?,processor_payment_id=?,revision=revision+1 WHERE id=? AND account_id=? AND revision=? AND state='open'",
    input.occurred_at, input.payment_id, invoice.id, input.account_id, invoice.revision), [
    stmt(env.DB, 'INSERT INTO billing_payment_events (id,invoice_id,account_id,processor_event_id,type,amount_cents,request_hash,occurred_at) VALUES (?,?,?,?,?,?,?,?)',
      newId('payment'), invoice.id, input.account_id, input.processor_event_id, 'settled', input.amount_cents, hash, input.occurred_at),
    eventStatement(env.DB, { type: 'billing.invoice.paid', resource_id: invoice.id, resource_revision: invoice.revision + 1, account_id: input.account_id, data: { invoice_id: invoice.id } }),
    auditStatement(env.DB, { action: 'billing.payment.settled', resource_id: invoice.id, account_id: input.account_id, details: { processor_event_id: input.processor_event_id, amount_cents: input.amount_cents } }),
    stmt(env.DB, `UPDATE billing_accounts SET state='active',revision=revision+1,updated_at=? WHERE account_id=? AND state='past_due'
      AND NOT EXISTS (SELECT 1 FROM billing_invoices WHERE account_id=? AND state='open' AND due_at<?)`, now(), input.account_id, input.account_id, now()),
  ]);
}
