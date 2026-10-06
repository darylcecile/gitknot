import { ApiError, canonicalJson, database, identityBinding, mutationGuard, mutationStatements, newId, now, one, requirePrincipal, sha256, stmt } from '@gitknot/core';
import type { AppContext } from '@gitknot/core';
import { changeSubscription, collectInvoice, reconcileSubscriptionChange, redeemCreditHash, reserveSeatChange } from './commerce.ts';
import { admissionRequest } from './transport.ts';
import { ensureBillingAccount } from './catalog.ts';
import type { AdmissionControl, BillingCommand, BillingCommandReceipt, Budget } from './types.ts';

export type BillingRequestInput =
  | { kind: 'budget'; budget: Budget; expected_revision: number | null }
  | { kind: 'stop'; stopped: boolean; reason: string; revision: number }
  | { kind: 'subscription'; plan_id: string; expected_revision: number }
  | { kind: 'seat'; principal_id: string; additional_seats: number; expected_revision: number }
  | { kind: 'credit'; code_hash: string }
  | { kind: 'collection'; invoice_id: string; expected_revision: number };

export interface BillingApiOperation {
  id: string; account_id: string; actor_id: string; kind: BillingRequestInput['kind']; input_json: string; request_hash: string;
  state: 'pending' | 'complete'; resource_id: string | null; dispatched_at: string | null; revision: number; created_at: string; updated_at: string;
}

export async function billingApiOperation(c: AppContext, id: string): Promise<BillingApiOperation | null> {
  return one<BillingApiOperation>(database(c), 'SELECT * FROM billing_api_operations WHERE id=? AND account_id=? AND actor_id=?',
    id, c.req.param('accountId'), requirePrincipal(c).id);
}

/** Persist a fenced intent before any command/service call. Only references and sanitized inputs are durable. */
export async function beginBillingApiOperation(c: AppContext, id: string, input: BillingRequestInput): Promise<BillingApiOperation> {
  const db = database(c), accountId = c.req.param('accountId')!, actor = requirePrincipal(c);
  const hash = c.get('idempotency')?.request_hash ?? await sha256(canonicalJson(input));
  const old = await billingApiOperation(c, id);
  if (old) {
    if (old.request_hash !== hash || old.kind !== input.kind) throw new ApiError(409, 'billing_operation_conflict', 'The billing operation has different immutable inputs.');
    return old;
  }
  const at = now();
  try {
    await db.batch(await mutationStatements(c, {
      statements: [stmt(db, `INSERT INTO billing_api_operations(id,account_id,actor_id,kind,input_json,request_hash,state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'pending',?,?)`, id, accountId, actor.id, input.kind, canonicalJson(input), hash, at, at)],
      event: { type: 'billing.request.accepted', resource_id: id, resource_revision: 1, account_id: accountId, data: { kind: input.kind } },
    }));
  } catch (error) {
    const raced = await billingApiOperation(c, id);
    if (raced?.request_hash === hash && raced.kind === input.kind) return raced;
    throw error;
  }
  return (await billingApiOperation(c, id))!;
}

async function complete(c: AppContext, operation: BillingApiOperation, resourceId: string): Promise<BillingApiOperation> {
  const current = (await billingApiOperation(c, operation.id))!;
  if (current.state === 'complete') return current;
  const db = database(c), guard = newId('guard');
  try {
    await db.batch(await mutationStatements(c, {
      statements: [stmt(db, `UPDATE billing_api_operations SET state='complete',resource_id=?,revision=revision+1,updated_at=?
        WHERE id=? AND account_id=? AND actor_id=? AND state='pending' AND revision=?`, resourceId, now(), current.id, current.account_id, current.actor_id, current.revision),
      mutationGuard(db, guard), stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard)],
      event: { type: 'billing.request.completed', resource_id: current.id, resource_revision: current.revision + 1,
        account_id: current.account_id, data: { kind: current.kind, resource_id: resourceId } },
    }));
  } catch (error) {
    const raced = await billingApiOperation(c, operation.id);
    if (raced?.state === 'complete' && raced.resource_id === resourceId) return raced;
    throw error;
  }
  return (await billingApiOperation(c, operation.id))!;
}

async function dispatchCollection(c: AppContext, operation: BillingApiOperation, input: Extract<BillingRequestInput, { kind: 'collection' }>): Promise<boolean> {
  const db = database(c);
  const invoice = await one<{ state: string; revision: number }>(db, 'SELECT state,revision FROM billing_invoices WHERE id=? AND account_id=?', input.invoice_id, operation.account_id);
  if (!invoice) throw new ApiError(404, 'not_found', 'The invoice was not found.');
  if (invoice.state === 'paid') return true;
  if (operation.dispatched_at) {
    // The signed processor settlement callback is the authority. Recovery never issues another collection.
    return false;
  }
  if (invoice.revision !== input.expected_revision) throw new ApiError(412, 'revision_conflict', 'The invoice changed before collection was admitted.');
  if (!c.env.PAYMENTS || typeof c.env.PAYMENTS_SERVICE_KEY !== 'string') throw new ApiError(503, 'processor_unconfigured', 'Payment collection is not configured.');
  const guard = newId('guard');
  try {
    await db.batch(await mutationStatements(c, {
      statements: [stmt(db, `UPDATE billing_api_operations SET dispatched_at=?,resource_id=?,revision=revision+1,updated_at=?
        WHERE id=? AND account_id=? AND actor_id=? AND state='pending' AND dispatched_at IS NULL AND revision=?`, now(), input.invoice_id, now(), operation.id, operation.account_id, operation.actor_id, operation.revision),
      mutationGuard(db, guard), stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard)],
      event: { type: 'billing.collection.dispatched', resource_id: operation.id, resource_revision: operation.revision + 1,
        account_id: operation.account_id, data: { invoice_id: input.invoice_id } },
    }));
  } catch (error) {
    if ((await billingApiOperation(c, operation.id))?.dispatched_at) return false;
    throw error;
  }
  const receipt = await collectInvoice(c.env, { account_id: operation.account_id, invoice_id: input.invoice_id });
  return receipt.state === 'paid';
}

export async function resumeBillingApiOperation(c: AppContext, operation: BillingApiOperation): Promise<BillingApiOperation> {
  if (operation.state === 'complete') return operation;
  const input = JSON.parse(operation.input_json) as BillingRequestInput;
  const command: BillingCommand = { id: operation.id, request_hash: operation.request_hash };
  const account = operation.account_id;
  let resource: string;
  switch (input.kind) {
    case 'budget': {
      const receipt = await admissionRequest<BillingCommandReceipt | null>(c.env, `account:${account}`, 'get-command', { command_id: operation.id });
      resource = receipt?.resource_id ?? (await admissionRequest<Budget>(c.env, `account:${account}`, 'budget', { budget: input.budget, expected_revision: input.expected_revision, command })).id;
      break;
    }
    case 'stop': {
      const receipt = await admissionRequest<BillingCommandReceipt | null>(c.env, `account:${account}`, 'get-command', { command_id: operation.id });
      if (!receipt) await admissionRequest<AdmissionControl>(c.env, `account:${account}`, 'stop', { stopped: input.stopped, reason: input.reason, revision: input.revision, command });
      resource = account;
      break;
    }
    case 'subscription': {
      const id = `sub_${(await sha256(`${account}:${operation.id}`)).slice(0, 48)}`;
      const change = await one<{ state: string }>(identityBinding(c.env), 'SELECT state FROM billing_subscription_changes WHERE id=? AND account_id=?', id, account);
      if (change) await reconcileSubscriptionChange(c.env, id);
      else await changeSubscription(c.env, { account_id: account, actor_id: operation.actor_id, request_id: operation.id, plan_id: input.plan_id, expected_revision: input.expected_revision });
      resource = account;
      break;
    }
    case 'seat': {
      const id = `seat_${(await sha256(`${account}:${operation.id}`)).slice(0, 48)}`;
      const seat = await one(identityBinding(c.env), 'SELECT id FROM billing_seat_reservations WHERE id=? AND account_id=?', id, account);
      if (!seat) await reserveSeatChange(c.env, { account_id: account, principal_id: input.principal_id, additional_seats: input.additional_seats,
        expected_revision: input.expected_revision, request_id: operation.id });
      resource = id;
      break;
    }
    case 'credit': {
      const existing = await one<{ id: string }>(identityBinding(c.env), `SELECT c.id FROM billing_credits c JOIN billing_credit_codes k ON k.id=c.source_id
        WHERE c.account_id=? AND c.source='operator' AND k.code_hash=? AND k.redeemed_by_account_id=?`, account, input.code_hash, account);
      resource = existing?.id ?? (await redeemCreditHash(c.env, { account_id: account, actor_id: operation.actor_id, code_hash: input.code_hash })).id;
      break;
    }
    case 'collection': {
      if (!await dispatchCollection(c, operation, input)) return (await billingApiOperation(c, operation.id))!;
      resource = input.invoice_id; break;
    }
  }
  return complete(c, operation, resource);
}

export async function billingApiResult(c: AppContext, operation: BillingApiOperation): Promise<Record<string, unknown>> {
  if (operation.state !== 'complete') return { id: operation.id, account_id: operation.account_id, kind: operation.kind, state: operation.state, resource_id: operation.resource_id };
  switch (operation.kind) {
    case 'budget': return { ...await admissionRequest<Budget>(c.env, `account:${operation.account_id}`, 'get-budget', { budget_id: operation.resource_id }) };
    case 'stop': return { ...(await admissionRequest<{ control: AdmissionControl }>(c.env, `account:${operation.account_id}`, 'snapshot')).control };
    case 'subscription': return { ...await ensureBillingAccount(c.env, operation.account_id) };
    case 'seat': {
      const row = await requiredResource(c, 'SELECT id,account_id,principal_id,additional_seats,plan_id,subscription_revision,amount_units,state,revision,created_at,consumed_at FROM billing_seat_reservations WHERE id=? AND account_id=?', operation);
      return { ...row, reservation_id: row.id, maximum_current_period_units: row.amount_units };
    }
    case 'credit': return requiredResource(c, 'SELECT * FROM billing_credits WHERE id=? AND account_id=?', operation);
    case 'collection': return requiredResource(c, 'SELECT * FROM billing_invoices WHERE id=? AND account_id=?', operation);
  }
}

async function requiredResource(c: AppContext, sql: string, operation: BillingApiOperation): Promise<Record<string, unknown>> {
  const row = await one<Record<string, unknown>>(database(c), sql, operation.resource_id, operation.account_id);
  if (!row) throw new ApiError(404, 'not_found', 'The currently authorized billing resource was not found.');
  return row;
}
