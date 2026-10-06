import {
  ApiError, authorize, database, identityDatabase, decodeCursor, encodeCursor, etag, expectedRevision, jsonBody, listResponse,
  many, newId, now, one, requirePrincipal, resourceResponse, route, stmt, verifyInternalRequest, mutate, sha256,
} from '@gitknot/core';
import type { App, AppContext, IdempotencyOptions, Repository } from '@gitknot/core';
import {
  admissionRequest, ensureBillingAccount, getPlan, listPlans, planEntitlements,
  previewSeatChange, signedUnits, billingMetadata, handleBillingPhysicalRequest, storagePolicy,
  beginBillingApiOperation, billingApiOperation, resumeBillingApiOperation, billingApiResult,
  recordPaymentSettlement, usageRollups, handleStoragePlacementRequest, handleBillingAdmissionRequest,
} from '@gitknot/billing';
import type { AdmissionControl, Budget, Credit, Invoice, LedgerEntry, UsageRollup, BillingRequestInput, BillingApiOperation } from '@gitknot/billing';
import { z } from 'zod';

const amount = z.string().regex(/^(0|[1-9][0-9]{0,62})$/);
const budgetSchema = z.object({
  scope: z.enum(['account', 'repository', 'team', 'workflow', 'actor']), scope_id: z.string().min(1).max(128),
  limit_units: amount, safety_buffer_units: amount.default('0'),
  period_end: z.iso.datetime().nullable().default(null), threshold_percentages: z.array(z.number().int().min(1).max(100)).max(10).default([50, 80, 100]),
  repo_id: z.string().min(1).max(128).optional(),
}).strict();
const budgetUpdate = z.object({ limit_units: amount, safety_buffer_units: amount, threshold_percentages: z.array(z.number().int().min(1).max(100)).max(10), stopped: z.boolean().default(false) }).strict();
const subscriptionSchema = z.object({ plan_id: z.string().min(1).max(128) }).strict();
const subscriptionSettings = z.object({
  collection_method: z.enum(['manual', 'processor']).optional(), billing_email: z.email().nullable().optional(), state: z.enum(['active', 'cancelled']).optional(),
}).strict();
const stopSchema = z.object({ stopped: z.boolean(), reason: z.string().min(1).max(1000) }).strict();
const seatSchema = z.object({ additional_seats: z.number().int().min(1).max(100_000), principal_id: z.string().min(1).max(128) }).strict();
const creditSchema = z.object({ code: z.string().min(32).max(128) }).strict();

async function account(c: AppContext, capability = 'billing.read'): Promise<string> {
  const id = c.req.param('accountId')!;
  await authorize(c, capability, { account_id: id });
  await ensureBillingAccount(c.env, id);
  c.header('cache-control', 'no-store');
  return id;
}

function pagination(c: AppContext): { limit: number; after: string } {
  const limit = Number(c.req.query('limit') ?? 30);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ApiError(422, 'invalid_pagination', 'limit must be between 1 and 100.');
  const after = decodeCursor<unknown>(c.req.query('cursor') ?? null, '');
  if (typeof after !== 'string' || after.length > 1024) throw new ApiError(422, 'invalid_cursor', 'Invalid billing cursor.');
  return { limit, after };
}

type BillingInputFactory = (c: AppContext, operationId: string) => Promise<BillingRequestInput>;

function externalBilling(kind: BillingRequestInput['kind'], factory: BillingInputFactory, status = 200): IdempotencyOptions {
  return { strategy: 'external', authorization: (c) => [{ capability: 'billing.manage', scope: { account_id: c.req.param('accountId')! } }],
    recover: async (c, record) => {
      if (!record.operation_id) throw new ApiError(503, 'billing_recovery_unavailable', 'The billing request has no durable operation identity.');
      return externalBillingResponse(c, kind, factory, status, record.operation_id);
    } };
}

function resultPath(operation: BillingApiOperation): string {
  const base = `/v1/accounts/${operation.account_id}`;
  if (operation.state !== 'complete') return `${base}/billing/operations/${operation.id}`;
  const paths = { budget: 'budgets', credit: 'credits', collection: 'invoices', seat: 'subscription/seats' };
  if (operation.kind in paths) return `${base}/${paths[operation.kind as keyof typeof paths]}/${encodeURIComponent(operation.resource_id!)}`;
  return `${base}/${operation.kind === 'subscription' ? 'subscription' : 'billing'}`;
}

async function externalBillingResponse(c: AppContext, kind: BillingRequestInput['kind'], factory: BillingInputFactory, status = 200, operationId?: string): Promise<Response> {
  await account(c, 'billing.manage');
  const id = operationId ?? c.get('idempotency')?.operation_id ?? newId('op');
  let operation = await billingApiOperation(c, id);
  if (!operation) operation = await beginBillingApiOperation(c, id, await factory(c, id));
  if (operation.kind !== kind) throw new ApiError(409, 'billing_operation_conflict', 'The billing operation belongs to another request kind.');
  operation = await resumeBillingApiOperation(c, operation);
  c.header('location', resultPath(operation));
  return resourceResponse(c, await billingApiResult(c, operation), operation.state === 'complete' ? status : 202);
}

const stopInput: BillingInputFactory = async (c) => ({ kind: 'stop', ...await jsonBody(c, stopSchema), revision: expectedRevision(c) });
const planInput: BillingInputFactory = async (c) => ({ kind: 'subscription', ...await jsonBody(c, subscriptionSchema), expected_revision: expectedRevision(c) });
const seatsInput: BillingInputFactory = async (c) => ({ kind: 'seat', ...await jsonBody(c, seatSchema), expected_revision: expectedRevision(c) });
const creditInput: BillingInputFactory = async (c) => ({ kind: 'credit', code_hash: await sha256((await jsonBody(c, creditSchema)).code) });
const collectionInput: BillingInputFactory = async (c) => ({ kind: 'collection', invoice_id: c.req.param('invoiceId')!, expected_revision: expectedRevision(c) });

const createBudgetInput: BillingInputFactory = async (c, operationId) => {
  const accountId = c.req.param('accountId')!;
  const body = await jsonBody(c, budgetSchema);
  await budgetScope(c, accountId, body.scope, body.scope_id, body.repo_id);
  if (body.period_end && body.period_end <= now()) throw new ApiError(422, 'invalid_period', 'A cap must end after its effective time.');
  return { kind: 'budget', expected_revision: null, budget: { ...body, id: `budget_${(await sha256(operationId)).slice(0, 48)}`, account_id: accountId,
    period_start: now(), settled_units: '0', reserved_units: '0', commitment_units: '0', revision: 1, stopped: false } };
};

const updateBudgetInput: BillingInputFactory = async (c) => {
  const accountId = c.req.param('accountId')!;
  const previous = await admissionRequest<Budget>(c.env, `account:${accountId}`, 'get-budget', { budget_id: c.req.param('budgetId')! });
  if (previous.account_id !== accountId) throw new ApiError(404, 'not_found', 'Budget not found.');
  return { kind: 'budget', budget: { ...previous, ...await jsonBody(c, budgetUpdate) }, expected_revision: expectedRevision(c) };
};

async function budgetScope(c: AppContext, accountId: string, scope: Budget['scope'], scopeId: string, repoHint?: string): Promise<void> {
  if (scope === 'account') {
    if (scopeId !== accountId) throw new ApiError(422, 'budget_scope', 'The account budget must identify its own account.');
    return;
  }
  if (scope === 'repository') {
    const repository = await billingMetadata<Repository>(c.env, { repo_id: scopeId });
    if (!repository || repository.owner_id !== accountId) throw new ApiError(404, 'not_found', 'The budget repository was not found in this account.');
    return;
  }
  if (scope === 'workflow') {
    const hint = repoHint ?? (await one<{ repo_id: string }>(identityDatabase(c), 'SELECT repo_id FROM workflows WHERE id=?', scopeId))?.repo_id;
    if (!hint) throw new ApiError(422, 'workflow_repository_required', 'Provide repo_id to locate this workflow at its current authority.');
    const workflow = await billingMetadata<{ id: string; repo_id: string; account_id: string }>(c.env, { repo_id: hint, workflow_id: scopeId });
    if (!workflow || workflow.account_id !== accountId) throw new ApiError(404, 'not_found', 'The budget workflow was not found in this account.');
    return;
  }
  const queries = {
    repository: 'SELECT id FROM repositories WHERE id=? AND owner_id=?',
    team: 'SELECT id FROM teams WHERE id=? AND account_id=?',
    workflow: 'SELECT id FROM workflows WHERE id=? AND account_id=?',
    actor: "SELECT principal_id AS id FROM memberships WHERE principal_id=? AND account_id=? AND state='active'",
  };
  if (!await one(identityDatabase(c), queries[scope], scopeId, accountId)) throw new ApiError(404, 'not_found', 'The budget resource was not found in this account.');
}

async function invoice(c: AppContext, accountId: string): Promise<Invoice> {
  const value = await one<Invoice>(database(c), 'SELECT * FROM billing_invoices WHERE id=? AND account_id=?', c.req.param('invoiceId'), accountId);
  if (!value) throw new ApiError(404, 'not_found', 'Invoice not found.');
  return value;
}

export function registerBillingRoutes(app: App): void {
  app.post('/internal/billing/physical', (c) => handleBillingPhysicalRequest(c.req.raw, c.env));
  app.post('/internal/billing/payment-settlement', async (c) => {
    const key = c.env.PAYMENTS_SERVICE_KEY;
    if (typeof key !== 'string' || key.length < 32 || key === c.env.INTERNAL_SERVICE_KEY || /placeholder|change[-_ ]?me|example/i.test(key)) {
      throw new ApiError(503, 'processor_unconfigured', 'The payment settlement service identity is not configured.');
    }
    await verifyInternalRequest(c.req.raw, key, 'billing.settlement', { database: c.env.DB });
    const input = z.object({ account_id: z.string().min(1).max(128), invoice_id: z.string().min(1).max(128),
      processor_event_id: z.string().min(1).max(256), payment_id: z.string().min(1).max(256), amount_cents: amount,
      occurred_at: z.iso.datetime().transform((value) => new Date(value).toISOString()) }).strict().parse(await c.req.json());
    await recordPaymentSettlement(c.env, input);
    return c.json({ accepted: true });
  });
  route(app, 'GET', '/v1/storage/policy', { summary: 'Storage retention, funded renewal windows and deletion grace policy', tags: ['Billing'], public: true }, (c) => c.json({ ...storagePolicy(c.env), on_renewal_failure: 'notify_block_writes_then_delete' }));
  app.post('/internal/billing/metadata', async (c) => {
    await verifyInternalRequest(c.req.raw, c.env.INTERNAL_SERVICE_KEY, 'billing.metadata');
    const input = z.object({ repo_id: z.string().nullable(), object_id: z.string().optional(), account_id: z.string().optional(), transfer_operation_id: z.string().optional(), workflow_id: z.string().optional(), git_operation_id: z.string().optional(), git_repository_operation_id: z.string().optional(), git_purge_storage_name: z.string().optional() }).strict().parse(await c.req.json());
    return c.json(await billingMetadata(c.env, input));
  });
  app.post('/internal/billing/placement/:action', c => handleStoragePlacementRequest(c.req.raw, c.env));
  app.post('/internal/billing/admission', c => handleBillingAdmissionRequest(c.req.raw, c.env));
  route(app, 'GET', '/v1/accounts/:accountId/billing', { summary: 'Account billing, entitlements, forecast and enforceable exposure', tags: ['Billing'], capability: 'billing.read' }, async (c) => {
    const id = await account(c);
    const subscription = await ensureBillingAccount(c.env, id);
    const plan = await getPlan(database(c), subscription.plan_id);
    const snapshot = await admissionRequest<{ control: AdmissionControl; budgets: Budget[] }>(c.env, `account:${id}`, 'snapshot');
    const usage = await usageRollups(identityDatabase(c), { account_id: id, period: subscription.period_start.slice(0, 7), dimension: 'account', limit: 1000 });
    const measured = usage.reduce((total, row) => total + signedUnits(row.amount_units), 0n);
    const elapsed = BigInt(Math.max(1, Math.min(Date.now(), Date.parse(subscription.period_end)) - Date.parse(subscription.period_start)));
    const duration = BigInt(Date.parse(subscription.period_end) - Date.parse(subscription.period_start));
    c.header('etag', etag(snapshot.control.revision));
    return c.json({ account_id: id, currency: 'USD', monetary_unit: 'USD/1000000000', subscription,
      plan: { ...plan, entitlements: planEntitlements(plan), entitlements_json: undefined }, included_usage_units: plan.included_usage_units,
      measured_usage_units: measured.toString(), forecast_usage_units: ((measured * duration) / elapsed).toString(),
      forecast_is_estimate: true, usage, admission: snapshot.control, budgets: snapshot.budgets,
      collection_available: !!c.env.PAYMENTS, attribution_owner: 'owner_at_consumption' });
  });
  route(app, 'PATCH', '/v1/accounts/:accountId/billing', { summary: 'Stop or resume new account execution', tags: ['Billing'], capability: 'billing.manage', body: stopSchema,
    idempotency: externalBilling('stop', stopInput) }, (c) => externalBillingResponse(c, 'stop', stopInput));
  route(app, 'GET', '/v1/accounts/:accountId/billing/operations/:operationId', { summary: 'Inspect a durable billing request without revealing its sensitive inputs', tags: ['Billing'], capability: 'billing.read' }, async (c) => {
    const id = await account(c);
    const operation = await one<Record<string, unknown>>(database(c), 'SELECT id,account_id,actor_id,kind,state,resource_id,revision,created_at,updated_at FROM billing_api_operations WHERE id=? AND account_id=?', c.req.param('operationId'), id);
    if (!operation) throw new ApiError(404, 'not_found', 'Billing operation not found.');
    return resourceResponse(c, operation);
  });
  route(app, 'GET', '/v1/accounts/:accountId/billing/plans', { summary: 'Versioned plans and exact prices', tags: ['Billing'], capability: 'billing.read' }, async (c) => {
    await account(c);
    const plans = await listPlans(database(c));
    return c.json({ plans: plans.map((p) => ({ ...p, entitlements: planEntitlements(p), entitlements_json: undefined })),
      prices: await many(database(c), 'SELECT * FROM billing_prices ORDER BY meter,created_at,id') });
  });
  registerUsageRoutes(app);
  registerBudgetRoutes(app);
  registerSubscriptionRoutes(app);
  registerInvoiceRoutes(app);
  registerCreditRoutes(app);
}

function registerUsageRoutes(app: App): void {
  route(app, 'GET', '/v1/accounts/:accountId/usage', { summary: 'Exact metered usage by repository, workflow, team, or actor', tags: ['Billing'], capability: 'billing.read' }, async (c) => {
    const id = await account(c);
    const period = c.req.query('period') ?? now().slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new ApiError(422, 'invalid_period', 'Use a YYYY-MM billing period.');
    const dimension = z.enum(['account', 'repository', 'workflow', 'team', 'actor']).parse(c.req.query('group_by') ?? 'account');
    const { limit, after } = pagination(c);
    const rows = await usageRollups(identityDatabase(c), { account_id: id, period, dimension, after, limit: limit + 1 });
    const more = rows.length > limit;
    const items = rows.slice(0, limit);
    return listResponse(c, items, more ? encodeCursor(`${items.at(-1)!.dimension_id}:${items.at(-1)!.meter}`) : null);
  });
  route(app, 'GET', '/v1/accounts/:accountId/usage/ledger', { summary: 'Immutable usage receipts with pinned attribution and price versions', tags: ['Billing'], capability: 'billing.read' }, async (c) => {
    const id = await account(c);
    const { limit, after } = pagination(c);
    const repo = c.req.query('repo_id') ?? null;
    const rows = await many<LedgerEntry>(database(c), `SELECT * FROM billing_ledger WHERE account_id=? AND operating_cost=0 AND id>?
      AND (? IS NULL OR repo_id=?) ORDER BY id LIMIT ?`, id, after, repo, repo, limit + 1);
    return listResponse(c, rows.slice(0, limit), rows.length > limit ? encodeCursor(rows[limit - 1]!.id) : null);
  });
}

function registerBudgetRoutes(app: App): void {
  route(app, 'GET', '/v1/accounts/:accountId/budgets', { summary: 'Current caps, safety buffers and outstanding commitments', tags: ['Billing'], capability: 'billing.read' }, async (c) => {
    const id = await account(c);
    const { budgets } = await admissionRequest<{ budgets: Budget[] }>(c.env, `account:${id}`, 'snapshot');
    return listResponse(c, budgets);
  });
  route(app, 'POST', '/v1/accounts/:accountId/budgets', { summary: 'Apply an account or resource cap including already outstanding work', tags: ['Billing'], capability: 'billing.manage', body: budgetSchema,
    idempotency: externalBilling('budget', createBudgetInput, 201) }, (c) => externalBillingResponse(c, 'budget', createBudgetInput, 201));
  route(app, 'GET', '/v1/accounts/:accountId/budgets/:budgetId', { summary: 'Inspect an enforceable budget', tags: ['Billing'], capability: 'billing.read' }, async (c) => {
    const id = await account(c);
    const { budgets } = await admissionRequest<{ budgets: Budget[] }>(c.env, `account:${id}`, 'snapshot');
    const budget = budgets.find((b) => b.id === c.req.param('budgetId'));
    if (!budget) throw new ApiError(404, 'not_found', 'Budget not found.');
    return resourceResponse(c, budget);
  });
  route(app, 'PATCH', '/v1/accounts/:accountId/budgets/:budgetId', { summary: 'Change a cap without dropping existing commitments', tags: ['Billing'], capability: 'billing.manage', body: budgetUpdate,
    idempotency: externalBilling('budget', updateBudgetInput) }, (c) => externalBillingResponse(c, 'budget', updateBudgetInput));
}

function registerSubscriptionRoutes(app: App): void {
  route(app, 'GET', '/v1/accounts/:accountId/subscription', { summary: 'Subscription and current seat entitlement', tags: ['Billing'], capability: 'billing.read' }, async (c) => {
    const id = await account(c);
    return resourceResponse(c, await ensureBillingAccount(c.env, id));
  });
  route(app, 'PUT', '/v1/accounts/:accountId/subscription', { summary: 'Change the subscription plan with fenced entitlement updates', tags: ['Billing'], capability: 'billing.manage', body: subscriptionSchema,
    idempotency: externalBilling('subscription', planInput) }, (c) => externalBillingResponse(c, 'subscription', planInput));
  route(app, 'PATCH', '/v1/accounts/:accountId/subscription', { summary: 'Billing contact, collection method and voluntary subscription cancellation', tags: ['Billing'], capability: 'billing.manage', body: subscriptionSettings }, async (c) => {
    const id = await account(c, 'billing.manage');
    const previous = await ensureBillingAccount(c.env, id);
    const body = await jsonBody(c, subscriptionSettings);
    const revision = expectedRevision(c);
    if (revision !== previous.revision) throw new ApiError(412, 'revision_conflict', 'The subscription changed.');
    if (body.collection_method === 'processor' && !c.env.PAYMENTS) throw new ApiError(503, 'processor_unconfigured', 'Card collection is not configured.');
    if (body.state === 'active' && ['past_due', 'suspended'].includes(previous.state)) throw new ApiError(409, 'account_settlement_required', 'Resolve the account settlement before reactivation.');
    const timestamp = now();
    const after: D1PreparedStatement[] = [];
    if (body.state && body.state !== previous.state) after.push(
      stmt(database(c), 'UPDATE billing_plan_segments SET ended_at=? WHERE account_id=? AND ended_at IS NULL', timestamp, id),
      stmt(database(c), 'INSERT INTO billing_plan_segments(id,account_id,plan_id,seat_count,started_at,created_at) VALUES (?,?,?,?,?,?)',
        newId('segment'), id, body.state === 'cancelled' ? 'plan_free_202610' : previous.plan_id, body.state === 'cancelled' ? 0 : previous.seat_count, timestamp, timestamp),
    );
    await mutate(c, { sql: 'UPDATE billing_accounts SET state=?,collection_method=?,billing_email=?,revision=revision+1,updated_at=? WHERE account_id=? AND revision=?',
      bindings: [body.state ?? previous.state, body.collection_method ?? previous.collection_method, body.billing_email === undefined ? previous.billing_email : body.billing_email, timestamp, id, revision], after,
      event: { type: 'billing.subscription.updated', account_id: id, resource_id: id, resource_revision: previous.revision + 1,
        data: { state: body.state ?? previous.state } } });
    return resourceResponse(c, await ensureBillingAccount(c.env, id));
  });
  route(app, 'GET', '/v1/accounts/:accountId/subscription/seat-preview', { summary: 'Preview exact seat costs before accepting an invitation', tags: ['Billing'], capability: 'billing.read' }, async (c) => {
    const id = await account(c);
    return c.json(await previewSeatChange(c.env, { account_id: id, additional_seats: Number(c.req.query('additional_seats') ?? 1) }));
  });
  route(app, 'POST', '/v1/accounts/:accountId/subscription/seats', { summary: 'Reserve seats against the displayed plan revision', tags: ['Billing'], capability: 'billing.manage', body: seatSchema,
    idempotency: externalBilling('seat', seatsInput, 201) }, (c) => externalBillingResponse(c, 'seat', seatsInput, 201));
  route(app, 'GET', '/v1/accounts/:accountId/subscription/seats/:reservationId', { summary: 'Read a current seat reservation', tags: ['Billing'], capability: 'billing.read' }, async (c) => {
    const id = await account(c);
    const seat = await one<Record<string, unknown>>(database(c), 'SELECT id,account_id,principal_id,additional_seats,plan_id,amount_units,state,revision,created_at,consumed_at FROM billing_seat_reservations WHERE id=? AND account_id=?', c.req.param('reservationId'), id);
    if (!seat) throw new ApiError(404, 'not_found', 'Seat reservation not found.');
    return resourceResponse(c, seat);
  });
  route(app, 'DELETE', '/v1/accounts/:accountId/subscription/seats/:reservationId', { summary: 'Cancel an unconsumed seat reservation', tags: ['Billing'], capability: 'billing.manage' }, async (c) => {
    const id = await account(c, 'billing.manage');
    const row = await one<{ revision: number; state: string }>(database(c), 'SELECT revision,state FROM billing_seat_reservations WHERE id=? AND account_id=?', c.req.param('reservationId'), id);
    if (!row) throw new ApiError(404, 'not_found', 'Seat reservation not found.');
    if (row.revision !== expectedRevision(c)) throw new ApiError(412, 'revision_conflict', 'Seat reservation changed.');
    if (row.state !== 'reserved') throw new ApiError(409, 'seat_already_consumed', 'A consumed seat must be removed through membership administration.');
    await mutate(c, { sql: "UPDATE billing_seat_reservations SET state='cancelled',revision=revision+1 WHERE id=? AND account_id=? AND revision=? AND state='reserved'",
      bindings: [c.req.param('reservationId'), id, row.revision], event: { type: 'billing.seat.cancelled', resource_id: c.req.param('reservationId')!, resource_revision: row.revision + 1, account_id: id } });
    return c.body(null, 204);
  });
}

function registerInvoiceRoutes(app: App): void {
  for (const resource of ['invoices', 'statements']) {
    route(app, 'GET', `/v1/accounts/:accountId/${resource}`, { summary: `List account ${resource}`, tags: ['Billing'], capability: 'billing.read' }, async (c) => {
      const id = await account(c);
      const { limit, after } = pagination(c);
      const rows = await many<Invoice>(database(c), 'SELECT * FROM billing_invoices WHERE account_id=? AND id>? ORDER BY id LIMIT ?', id, after, limit + 1);
      return listResponse(c, rows.slice(0, limit), rows.length > limit ? encodeCursor(rows[limit - 1]!.id) : null);
    });
    route(app, 'GET', `/v1/accounts/:accountId/${resource}/:invoiceId`, { summary: 'Invoice totals, credit applications and versioned subscription lines', tags: ['Billing'], capability: 'billing.read' }, async (c) => {
      const id = await account(c);
      const value = await invoice(c, id);
      return resourceResponse(c, { ...value, lines: await many(database(c), 'SELECT * FROM billing_invoice_lines WHERE invoice_id=? ORDER BY id', value.id),
        credits: await many(database(c), 'SELECT credit_id,amount_units FROM billing_credit_applications WHERE invoice_id=? ORDER BY credit_id', value.id) });
    });
  }
  route(app, 'GET', '/v1/accounts/:accountId/statements/:invoiceId/download', { summary: 'Stream a complete exact-unit CSV statement', tags: ['Billing'], capability: 'billing.read', streaming: true }, async (c) => {
    const id = await account(c);
    const value = await invoice(c, id);
    return statementCsv(c, value);
  });
  route(app, 'POST', '/v1/accounts/:accountId/invoices/:invoiceId/pay', { summary: 'Request idempotent payment collection', tags: ['Billing'], capability: 'billing.manage', body: z.object({}).strict(),
    idempotency: externalBilling('collection', collectionInput) }, (c) => externalBillingResponse(c, 'collection', collectionInput));
}

function registerCreditRoutes(app: App): void {
  route(app, 'GET', '/v1/accounts/:accountId/credits', { summary: 'Included usage, credits and remaining balances', tags: ['Billing'], capability: 'billing.read' }, async (c) => {
    const id = await account(c);
    const { limit, after } = pagination(c);
    const rows = await many<Credit>(database(c), 'SELECT * FROM billing_credits WHERE account_id=? AND id>? ORDER BY id LIMIT ?', id, after, limit + 1);
    return listResponse(c, rows.slice(0, limit), rows.length > limit ? encodeCursor(rows[limit - 1]!.id) : null);
  });
  route(app, 'POST', '/v1/accounts/:accountId/credits', { summary: 'Redeem an operator-issued prepaid credit code', tags: ['Billing'], capability: 'billing.manage', body: creditSchema,
    idempotency: externalBilling('credit', creditInput, 201) }, (c) => externalBillingResponse(c, 'credit', creditInput, 201));
  route(app, 'GET', '/v1/accounts/:accountId/credits/:creditId', { summary: 'Read the current remaining balance of an account credit', tags: ['Billing'], capability: 'billing.read' }, async (c) => {
    const id = await account(c);
    const credit = await one<Credit>(database(c), 'SELECT * FROM billing_credits WHERE id=? AND account_id=?', c.req.param('creditId'), id);
    if (!credit) throw new ApiError(404, 'not_found', 'Credit not found.');
    return resourceResponse(c, credit);
  });
}

function csv(value: unknown): string {
  let text = String(value ?? '');
  if (/^[=+@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function statementCsv(c: AppContext, invoice: Invoice): Response {
  const encoder = new TextEncoder();
  let cursor = '';
  let header = false;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!header) {
        controller.enqueue(encoder.encode('entry_id,occurred_at,repository,workflow,team,actor,meter,quantity,amount_nanousd,price_version,meter_version\r\n'));
        const lines = await many<{ id: string; description: string; quantity: string; amount_units: string; price_version: string }>(c.env.DB,
          'SELECT id,description,quantity,amount_units,price_version FROM billing_invoice_lines WHERE invoice_id=? ORDER BY id', invoice.id);
        for (const line of lines) controller.enqueue(encoder.encode([line.id, invoice.period_start, '', '', '', '', line.description, line.quantity, line.amount_units, line.price_version, ''].map(csv).join(',') + '\r\n'));
        const credits = await many<{ credit_id: string; amount_units: string }>(c.env.DB, 'SELECT credit_id,amount_units FROM billing_credit_applications WHERE invoice_id=? ORDER BY credit_id', invoice.id);
        for (const credit of credits) controller.enqueue(encoder.encode([credit.credit_id, invoice.issued_at, '', '', '', '', 'credit', '1', (-BigInt(credit.amount_units)).toString(), '', ''].map(csv).join(',') + '\r\n'));
        controller.enqueue(encoder.encode([`${invoice.id}:payment-rounding`, invoice.issued_at, '', '', '', '', 'payment_rounding_carry', '1',
          (BigInt(invoice.rounded_units) - BigInt(invoice.payable_units)).toString(), '', ''].map(csv).join(',') + '\r\n'));
        header = true;
      }
      try {
        await authorize(c, 'billing.read', { account_id: invoice.account_id });
        const rows = await many<LedgerEntry>(c.env.DB, `SELECT l.* FROM billing_invoice_entries e JOIN billing_ledger l ON l.id=e.ledger_id
          WHERE e.invoice_id=? AND l.account_id=? AND l.id>? ORDER BY l.id LIMIT 250`, invoice.id, invoice.account_id, cursor);
        if (cancelled) return;
        for (const row of rows) controller.enqueue(encoder.encode([row.id, row.occurred_at, row.repo_id, row.workflow_id, row.team_id, row.actor_id,
          row.meter, row.quantity, row.amount_units, row.price_version, row.meter_version].map(csv).join(',') + '\r\n'));
        cursor = rows.at(-1)?.id ?? cursor;
        if (rows.length < 250) controller.close();
      } catch { if (!cancelled) controller.error(new Error('Statement streaming could not continue.')); }
    },
    cancel() { cancelled = true; },
  });
  return new Response(stream, { headers: { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
    'content-disposition': `attachment; filename="${invoice.id}.csv"` } });
}
