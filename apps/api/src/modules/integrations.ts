import { z } from 'zod';
import {
  ApiError, authorize, database, etag, expectedRevision, getRepository, hmac, identityDatabase, jsonBody, listResponse,
  many, mutate, mutationGuard, mutationStatements, newId, now, one, page, registerResourceLocator, requestDatabaseLocation,
  requirePrincipal, resolveResourceLocator, route, routeRepositoryRequest, sha256, stmt, verifyHmac,
} from '@gitknot/core';
import type { App, AppContext, Bindings, IdempotencyRecord, RequestAuthorization } from '@gitknot/core';
import { endpointURL } from '../../../../packages/operations/src/security.ts';
import { createSigningKey } from '../../../../packages/operations/src/webhook-broker.ts';
import { privateRequest } from '../../../../packages/operations/src/private.ts';
import { readBounded } from '../../../../packages/operations/src/security.ts';
import type { Delivery, Webhook } from '../../../../packages/operations/src/types.ts';
import { requestOperationsEnvironment } from '../../../../packages/operations/src/placement.ts';
import { executionEventVisible } from '../../../../packages/operations/src/execution-audience.ts';
import { executionReadPage } from '../../../../packages/execution/src/reads.ts';

const events = z.array(z.string().regex(/^(?:\*|(?:repository|ref|git|issue|pull_request|review|discussion|task|workflow|run|membership|billing)\.(?:[a-z_]+\.)*(?:[a-z_]+|\*))$/)).min(1).max(50);
const createSchema = z.object({ url: z.url().max(2048), events, installation_id: z.string().min(1).max(100).optional() }).strict();
const editSchema = z.object({ url: z.url().max(2048).optional(), events: events.optional(), state: z.enum(['active', 'disabled']).optional() }).strict();
const rotateSchema = z.object({ overlap_seconds: z.number().int().min(0).max(86400).default(3600) }).strict();
const replaySchema = z.object({ repo_id: z.string().max(100), webhook_id: z.string().max(100), since: z.iso.datetime(), until: z.iso.datetime().optional() }).strict();
const preferenceSchema = z.object({ transactional: z.boolean(), digest: z.enum(['off', 'daily', 'weekly']) }).strict();

function env(c: AppContext): Bindings { return requestOperationsEnvironment(c); }

function isEgressService(value: unknown): value is Fetcher {
  return !!value && typeof value === 'object' && 'fetch' in value && typeof value.fetch === 'function';
}

function publicWebhook(hook: Webhook): Record<string, unknown> {
  return { id: hook.id, repo_id: hook.repo_id, installation_id: hook.installation_id, url: hook.url,
    events: JSON.parse(hook.events_json), state: hook.state, revision: hook.revision, created_at: hook.created_at, updated_at: hook.updated_at };
}

function publicDelivery(delivery: Delivery): Record<string, unknown> {
  return { id: delivery.id, event_id: delivery.event_id, webhook_id: delivery.webhook_id, repo_id: delivery.repo_id,
    generation: delivery.generation, state: delivery.state, attempt_count: delivery.attempt_count,
    next_attempt_at: delivery.state === 'pending' ? delivery.next_attempt_at : null,
    last_status: delivery.last_status, error_code: delivery.error_code, revision: delivery.revision,
    created_at: delivery.created_at, updated_at: delivery.updated_at };
}

async function webhook(c: AppContext, id: string): Promise<Webhook> {
  const hook = await one<Webhook>(database(c), 'SELECT * FROM webhooks WHERE id=?', id);
  if (!hook) throw new ApiError(404, 'not_found', 'The webhook was not found.');
  await getRepository(c, hook.repo_id, 'webhooks.manage');
  return hook;
}

async function validateEndpoint(c: AppContext, value: string): Promise<string> {
  let url: URL;
  try { url = endpointURL(value); }
  catch { throw new ApiError(422, 'endpoint_not_allowed', 'Use a public HTTPS webhook endpoint on port 443.'); }
  const service = c.env.WEBHOOK_EGRESS;
  if (!isEgressService(service)) throw new ApiError(503, 'endpoint_validation_unavailable', 'The webhook validation service is unavailable.');
  const response = await privateRequest(env(c), service, 'webhook-egress', '/internal/webhooks/validate', { url: url.href });
  if (response.status === 422) { await response.body?.cancel(); throw new ApiError(422, 'endpoint_not_allowed', 'Use a publicly reachable HTTPS webhook endpoint.'); }
  if (!response.ok) { await response.body?.cancel(); throw new ApiError(503, 'endpoint_validation_unavailable', 'The webhook endpoint could not be validated. Retry shortly.'); }
  const result = JSON.parse(await readBounded(response, 4096)) as { valid: boolean };
  if (!result.valid) throw new ApiError(422, 'endpoint_not_allowed', 'This webhook endpoint cannot be reached safely.');
  return url.href;
}

async function createWebhook(c: AppContext): Promise<Response> {
  const body = await jsonBody(c, createSchema);
  const repo = await getRepository(c, c.req.param('repoId')!, 'webhooks.manage');
  let principal = requirePrincipal(c);
  if (body.installation_id) {
    const install = await one<{ id: string; capabilities_json: string; repository_ids_json: string }>(identityDatabase(c),
      `SELECT i.id,i.capabilities_json,i.repository_ids_json FROM installations i JOIN principals p ON p.id=i.id
       JOIN applications a ON a.id=i.application_id WHERE i.id=? AND i.account_id=? AND i.suspended_at IS NULL
       AND p.disabled_at IS NULL AND a.disabled_at IS NULL`, body.installation_id, repo.owner_id);
    if (!install || !(JSON.parse(install.repository_ids_json) as string[]).includes(repo.id)) throw new ApiError(404, 'not_found', 'The installation was not found.');
    principal = { id: install.id, kind: 'application', user_id: null, credential_id: null, mfa: false,
      capabilities: JSON.parse(install.capabilities_json) as string[], repository_ids: JSON.parse(install.repository_ids_json) as string[], account_ids: [repo.owner_id] };
  }
  const url = await validateEndpoint(c, body.url);
  const id = newId('wh');
  const timestamp = now();
  await mutate(c, {
    sql: `INSERT INTO webhooks(id,repo_id,account_id,installation_id,principal_id,principal_json,url,events_json,state,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,'disabled',?,? WHERE (SELECT COUNT(*) FROM webhooks WHERE repo_id=? AND state<>'revoked')<100`,
    bindings: [id, repo.id, repo.owner_id, body.installation_id ?? null, principal.id, JSON.stringify(principal), url, JSON.stringify(body.events), timestamp, timestamp, repo.id],
    event: { type: 'webhook.created', resource_id: id, resource_revision: 1, repo_id: repo.id, account_id: repo.owner_id },
  });
  const created = (await one<Webhook>(database(c), 'SELECT * FROM webhooks WHERE id=?', id))!;
  c.header('etag', etag(created.revision));
  c.header('location', `/v1/webhooks/${id}`);
  return c.json({ ...publicWebhook(created), signing_key_url: `/v1/webhooks/${id}/keys` }, 201);
}

async function editWebhook(c: AppContext): Promise<Response> {
  const hook = await webhook(c, c.req.param('id')!);
  const revision = expectedRevision(c);
  const body = await jsonBody(c, editSchema);
  if (hook.state === 'revoked') throw new ApiError(409, 'webhook_revoked', 'Create a new webhook to resume delivery.');
  const url = body.url ? await validateEndpoint(c, body.url) : hook.url;
  if (body.state === 'active' && !await one(database(c), `SELECT 1 FROM webhook_keys WHERE webhook_id=? AND state='active'`, hook.id)) {
    throw new ApiError(409, 'signing_key_required', 'Create a signing key before activating this webhook.');
  }
  await mutate(c, {
    sql: `UPDATE webhooks SET url=?,events_json=?,state=?,revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND revision=? AND state<>'revoked'`,
    bindings: [url, JSON.stringify(body.events ?? JSON.parse(hook.events_json)), body.state ?? hook.state, now(), hook.id, hook.repo_id, revision],
    event: { type: 'webhook.updated', resource_id: hook.id, resource_revision: revision + 1, repo_id: hook.repo_id, account_id: hook.account_id },
  });
  const updated = (await one<Webhook>(database(c), 'SELECT * FROM webhooks WHERE id=?', hook.id))!;
  c.header('etag', etag(updated.revision));
  return c.json(publicWebhook(updated));
}

async function rotateWebhook(c: AppContext): Promise<Response> {
  const hook = await webhook(c, c.req.param('id')!);
  const revision = expectedRevision(c);
  if (revision !== hook.revision || hook.state === 'revoked') throw new ApiError(412, 'revision_conflict', 'Refresh the webhook before rotating its key.');
  const body = await jsonBody(c, rotateSchema);
  const request = c.get('idempotency');
  if (!request?.operation_id || request.strategy !== 'external') throw new ApiError(428, 'idempotency_key_required', 'Send Idempotency-Key when issuing a one-time signing key.');
  const keyId = `whkey_${(await sha256(request.operation_id)).slice(0, 48)}`;
  const db = database(c);
  const timestamp = now();
  const guard = newId('guard');
  await db.batch(await mutationStatements(c, { statements: [
    stmt(db, `INSERT INTO webhook_key_operations(operation_id,webhook_id,repo_id,account_id,actor_id,key_id,expected_revision,overlap_seconds,state,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,'prepared',?,? WHERE EXISTS(SELECT 1 FROM webhooks WHERE id=? AND repo_id=? AND revision=? AND state<>'revoked')`,
    request.operation_id, hook.id, hook.repo_id, hook.account_id, requirePrincipal(c).id, keyId, revision, body.overlap_seconds, timestamp, timestamp, hook.id, hook.repo_id, revision),
    mutationGuard(db, guard), stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard),
  ], event: { type: 'webhook.key_rotation_requested', resource_id: hook.id, resource_revision: revision, repo_id: hook.repo_id, account_id: hook.account_id,
    data: { operation_id: request.operation_id, key_id: keyId } } }));
  const key = await createSigningKey(env(c), { webhook_id: hook.id, key_id: keyId, principal: requirePrincipal(c), overlap_seconds: body.overlap_seconds });
  if (key.key_id !== keyId || !key.secret.startsWith('whsec_')) throw new Error('invalid_key_receipt');
  const intent = (await one<KeyRotation>(db, 'SELECT * FROM webhook_key_operations WHERE operation_id=?', request.operation_id))!;
  const issued = await issuedKey(c, intent);
  if (!issued || issued.secret_ref !== key.secret_ref) throw new ApiError(503, 'signing_key_unconfirmed', 'The signing-key issuance must be reconciled.');
  const completed = await finishKeyRotation(c, intent, issued.secret_ref);
  if (!completed.attached) throw new ApiError(412, 'webhook_changed', 'The webhook changed before this key could be attached. Its issuance is retained for inspection.');
  c.header('etag', etag(completed.revision));
  c.header('cache-control', 'no-store');
  return c.json({ key_id: keyId, secret: key.secret, revision: completed.revision }, 201);
}

interface KeyRotation {
  operation_id: string; webhook_id: string; repo_id: string; account_id: string; actor_id: string;
  key_id: string; expected_revision: number; overlap_seconds: number; state: string; secret_ref: string | null;
}

async function issuedKey(c: AppContext, rotation: KeyRotation): Promise<{ secret_ref: string } | null> {
  return one(identityDatabase(c), `SELECT ciphertext_id AS secret_ref FROM vault_webhook_keys
    WHERE id=? AND webhook_id=? AND repo_id=? AND account_id=? AND created_by=? AND revoked_at IS NULL`,
  rotation.key_id, rotation.webhook_id, rotation.repo_id, rotation.account_id, rotation.actor_id);
}

async function finishKeyRotation(c: AppContext, rotation: KeyRotation, secretRef: string): Promise<{ attached: boolean; revision: number }> {
  if (rotation.actor_id !== requirePrincipal(c).id) throw new ApiError(404, 'not_found', 'The signing-key operation was not found.');
  const hook = await webhook(c, rotation.webhook_id);
  if (rotation.state === 'completed' || rotation.state === 'unattached') return { attached: rotation.state === 'completed', revision: hook.revision };
  const db = database(c);
  const guard = newId('guard');
  const timestamp = now();
  const attach = hook.state !== 'revoked' && hook.revision === rotation.expected_revision && hook.account_id === rotation.account_id;
  const statements = [
    stmt(db, `UPDATE webhook_key_operations SET state=?,secret_ref=?,updated_at=? WHERE operation_id=? AND state='prepared'`, attach ? 'completed' : 'unattached', secretRef, timestamp, rotation.operation_id),
    mutationGuard(db, guard),
  ];
  if (attach) statements.push(
    stmt(db, `UPDATE webhooks SET revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND revision=? AND state<>'revoked'`, timestamp, hook.id, hook.repo_id, rotation.expected_revision),
    mutationGuard(db, `${guard}_hook`),
    stmt(db, `UPDATE webhook_keys SET state='revoked',valid_until=? WHERE webhook_id=? AND state='retiring'`, timestamp, hook.id),
    stmt(db, `UPDATE webhook_keys SET state=?,valid_until=? WHERE webhook_id=? AND state='active'`, rotation.overlap_seconds ? 'retiring' : 'revoked', new Date(Date.now() + rotation.overlap_seconds * 1000).toISOString(), hook.id),
    stmt(db, `INSERT INTO webhook_keys(id,webhook_id,secret_ref,state,created_at) VALUES(?,?,?,'active',?)`, rotation.key_id, hook.id, secretRef, timestamp),
  );
  statements.push(stmt(db, 'DELETE FROM mutation_guards WHERE id IN (?,?)', guard, `${guard}_hook`));
  await db.batch(await mutationStatements(c, { statements,
    event: { type: attach ? 'webhook.key_rotated' : 'webhook.key_issuance_reconciled', resource_id: hook.id, resource_revision: hook.revision + Number(attach), repo_id: hook.repo_id, account_id: hook.account_id,
      data: { operation_id: rotation.operation_id, key_id: rotation.key_id, attached: attach } },
  }));
  return { attached: attach, revision: hook.revision + Number(attach) };
}

async function keyAuthorization(c: AppContext): Promise<RequestAuthorization[]> {
  const hook = await webhook(c, c.req.param('id')!);
  return [{ capability: 'webhooks.manage', scope: { repo_id: hook.repo_id } }];
}

async function recoverKeyRotation(c: AppContext, record: IdempotencyRecord): Promise<Response | null> {
  if (!record.operation_id) return null;
  const rotation = await one<KeyRotation>(database(c), 'SELECT * FROM webhook_key_operations WHERE operation_id=? AND webhook_id=?', record.operation_id, c.req.param('id'));
  if (!rotation) return null;
  const issued = await issuedKey(c, rotation);
  if (!issued) return null;
  await finishKeyRotation(c, rotation, issued.secret_ref);
  return c.json({ key_id: rotation.key_id, issuance_reconciled: true });
}

async function listDeliveries(c: AppContext, hookId?: string): Promise<Response> {
  const hook = hookId ? await webhook(c, hookId) : null;
  const repo = hook ? null : await getRepository(c, c.req.query('repo_id') ?? '', 'webhooks.manage');
  const result = await executionReadPage<Delivery>(c, `webhook-deliveries:${hook?.repo_id ?? repo!.id}:${hookId ?? '*'}`, (after, limit) => many<Delivery>(database(c),
    'SELECT * FROM webhook_deliveries WHERE repo_id=? AND (? IS NULL OR webhook_id=?) AND id>? ORDER BY id LIMIT ?', hook?.repo_id ?? repo!.id, hook?.id ?? null, hook?.id ?? null, after, limit),
  delivery => executionEventVisible(c, delivery.event_id));
  return listResponse(c, result.items.map(publicDelivery), result.next_cursor);
}

async function getDelivery(c: AppContext): Promise<Delivery> {
  const delivery = await one<Delivery>(database(c), 'SELECT * FROM webhook_deliveries WHERE id=?', c.req.param('id'));
  if (!delivery) throw new ApiError(404, 'not_found', 'The delivery was not found.');
  await getRepository(c, delivery.repo_id, 'webhooks.manage');
  if (!await executionEventVisible(c, delivery.event_id)) throw new ApiError(404, 'not_found', 'The delivery was not found.');
  return delivery;
}

async function redeliver(c: AppContext): Promise<Response> {
  const delivery = await getDelivery(c);
  const revision = expectedRevision(c);
  const db = database(c);
  const source = await one<{ id: string }>(db, 'SELECT id FROM outbox WHERE id=? AND created_at>=?', delivery.event_id, new Date(Date.now() - 30 * 86400_000).toISOString());
  if (!source) throw new ApiError(410, 'event_expired', 'This event is outside the 30-day redelivery window.');
  const hook = await webhook(c, delivery.webhook_id);
  if (hook.state !== 'active') throw new ApiError(409, 'webhook_inactive', 'Activate the webhook before redelivering.');
  const id = newId('delivery');
  const timestamp = now();
  await mutate(c, {
    sql: `INSERT INTO webhook_deliveries(id,event_id,webhook_id,repo_id,account_id,generation,next_attempt_at,created_at,updated_at)
      SELECT ?,event_id,webhook_id,repo_id,account_id,(SELECT MAX(generation)+1 FROM webhook_deliveries WHERE webhook_id=? AND event_id=?),?,?,?
      FROM webhook_deliveries WHERE id=? AND repo_id=? AND revision=?`,
    bindings: [id, hook.id, delivery.event_id, timestamp, timestamp, timestamp, delivery.id, delivery.repo_id, revision],
    event: { type: 'webhook.redelivery_requested', resource_id: id, resource_revision: 1, repo_id: delivery.repo_id, account_id: delivery.account_id, data: { event_id: delivery.event_id } },
  });
  c.header('location', `/v1/deliveries/${id}`);
  c.header('etag', etag(1));
  return c.json(publicDelivery((await one<Delivery>(db, 'SELECT * FROM webhook_deliveries WHERE id=?', id))!), 202);
}

async function replayEvents(c: AppContext): Promise<Response> {
  const body = await jsonBody(c, replaySchema);
  if (c.req.param('repoId') && c.req.param('repoId') !== body.repo_id) throw new ApiError(404, 'not_found', 'The replay repository was not found.');
  await getRepository(c, body.repo_id, 'webhooks.manage');
  const hook = await webhook(c, body.webhook_id);
  if (hook.repo_id !== body.repo_id || hook.state !== 'active') throw new ApiError(404, 'not_found', 'The active webhook was not found.');
  const until = body.until ?? now();
  if (Date.parse(body.since) < Date.now() - 30 * 86400_000 || Date.parse(until) > Date.now() || body.since > until) {
    throw new ApiError(422, 'invalid_replay_window', 'Choose a replay window within the past 30 days.');
  }
  const id = newId('op');
  const location = requestDatabaseLocation(c);
  await mutate(c, {
    sql: `INSERT INTO event_replays(id,repo_id,webhook_id,actor_id,since_at,until_at,created_at,updated_at,source_cell_id,source_shard_id,through_rowid)
      VALUES(?,?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(rowid),0) FROM outbox))`,
    bindings: [id, body.repo_id, hook.id, requirePrincipal(c).id, body.since, until, now(), now(), location.cell_id, location.shard_id],
    after: [stmt(database(c), `INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,status,input_json,created_at,updated_at)
      VALUES(?,'events.replay',?,?,?,?,'running','{}',?,?)`, id, id, body.repo_id, hook.account_id, requirePrincipal(c).id, now(), now())],
    event: { type: 'webhook.replay_requested', resource_id: id, resource_revision: 1, repo_id: hook.repo_id, account_id: hook.account_id },
  });
  c.header('location', `/v1/operations/${id}/replay`);
  c.header('etag', etag(1));
  return c.json({ id, state: 'pending', revision: 1, since: body.since, until }, 202);
}

export function registerIntegrationsRoutes(app: App): void {
  app.use('/v1/events/replay', async (c, next) => {
    if (c.req.method !== 'POST') return next();
    const body = await jsonBody(c, replaySchema);
    // Normalize the legacy collection alias before request fingerprinting and
    // cross-cell forwarding. Both retries use the same repository-owned path.
    c.req.raw = new Request(new URL(`/v1/repos/${encodeURIComponent(body.repo_id)}/events/replay`, c.req.url), {
      method: 'POST', headers: c.req.raw.headers, body: JSON.stringify(body),
    });
    const forwarded = await routeRepositoryRequest(c, body.repo_id);
    if (forwarded) return forwarded;
    return next();
  });
  app.use('/v1/events/replays/:id', async (c, next) => {
    const id = c.req.param('id')!;
    let locator = await resolveResourceLocator(c.env, id, 'operation');
    if (!locator) {
      const legacy = await one<{ repo_id: string }>(identityDatabase(c), 'SELECT repo_id FROM event_replays WHERE id=?', id);
      if (legacy) { await registerResourceLocator(c.env, { resource_id: id, resource_type: 'operation', repo_id: legacy.repo_id }); locator = await resolveResourceLocator(c.env, id, 'operation'); }
    }
    if (!locator?.repo_id) throw new ApiError(404, 'not_found', 'The replay was not found.');
    c.req.raw = new Request(new URL(`/v1/operations/${encodeURIComponent(id)}/replay`, c.req.url), { headers: c.req.raw.headers });
    const forwarded = await routeRepositoryRequest(c, locator.repo_id);
    if (forwarded) return forwarded;
    return next();
  });
  const options = { tags: ['Integrations'], capability: 'webhooks.manage' };
  route(app, 'POST', '/v1/repos/:repoId/webhooks', { ...options, summary: 'Create a disabled webhook; provision its signing key before activation', body: createSchema }, createWebhook);
  route(app, 'GET', '/v1/repos/:repoId/webhooks', { ...options, summary: 'List repository webhooks' }, async (c) => {
    const repo = await getRepository(c, c.req.param('repoId')!, 'webhooks.manage');
    const { limit, cursor } = page(c);
    const rows = await many<Webhook>(database(c), 'SELECT * FROM webhooks WHERE repo_id=? AND id>? ORDER BY id LIMIT ?', repo.id, cursor ?? '', limit + 1);
    return listResponse(c, rows.slice(0, limit).map(publicWebhook), rows.length > limit ? rows[limit - 1]!.id : null);
  });
  route(app, 'GET', '/v1/webhooks/:id', { ...options, summary: 'Read a webhook' }, async (c) => {
    const hook = await webhook(c, c.req.param('id')!); c.header('etag', etag(hook.revision)); return c.json(publicWebhook(hook));
  });
  route(app, 'PATCH', '/v1/webhooks/:id', { ...options, summary: 'Update a webhook', body: editSchema }, editWebhook);
  route(app, 'POST', '/v1/webhooks/:id/keys', { ...options, summary: 'Create or rotate a one-time signing key', sensitive: true, body: rotateSchema,
    description: 'Requires Idempotency-Key and If-Match. Recovery reconciles the original key ID and never issues another secret.',
    idempotency: { strategy: 'external', authorization: keyAuthorization, recover: recoverKeyRotation } }, rotateWebhook);
  route(app, 'GET', '/v1/webhooks/:id/keys', { ...options, summary: 'Read signing-key metadata without secret material' }, async (c) => {
    const hook = await webhook(c, c.req.param('id')!);
    const issued = await many<{ id: string; created_at: string }>(identityDatabase(c),
      'SELECT id,created_at FROM vault_webhook_keys WHERE webhook_id=? AND repo_id=? ORDER BY created_at DESC LIMIT 100', hook.id, hook.repo_id);
    const rows = await Promise.all(issued.map(async key => ({ ...key,
      ...await one<{ state: string; valid_until: string | null }>(database(c), 'SELECT state,valid_until FROM webhook_keys WHERE id=? AND webhook_id=?', key.id, hook.id) ?? { state: 'unattached', valid_until: null },
    })));
    return listResponse(c, rows);
  });
  route(app, 'DELETE', '/v1/webhooks/:id', { ...options, summary: 'Revoke a webhook and its pending deliveries' }, async (c) => {
    const hook = await webhook(c, c.req.param('id')!); const revision = expectedRevision(c); const db = database(c);
    await mutate(c, { sql: `UPDATE webhooks SET state='revoked',revoked_at=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?`,
      bindings: [now(), now(), hook.id, revision],
      after: [stmt(db, `UPDATE webhook_keys SET state='revoked',valid_until=? WHERE webhook_id=?`, now(), hook.id),
        stmt(db, `UPDATE webhook_deliveries SET state='cancelled',error_code='subscription_revoked',revision=revision+1,updated_at=? WHERE webhook_id=? AND state IN ('pending','sending')`, now(), hook.id)],
      event: { type: 'webhook.revoked', resource_id: hook.id, resource_revision: revision + 1, repo_id: hook.repo_id, account_id: hook.account_id } });
    return c.body(null, 204);
  });
  route(app, 'GET', '/v1/webhooks/:id/deliveries', { ...options, summary: 'List webhook deliveries' }, (c) => listDeliveries(c, c.req.param('id')!));
  route(app, 'GET', '/v1/deliveries', { ...options, summary: 'List deliveries in an authorized repository' }, (c) => listDeliveries(c));
  route(app, 'GET', '/v1/deliveries/:id', { ...options, summary: 'Inspect a delivery and its attempts' }, async (c) => {
    const delivery = await getDelivery(c); c.header('etag', etag(delivery.revision));
    const attempts = await many(database(c), `SELECT id,attempt,state,started_at,finished_at,status,error_code,duration_ms,response_excerpt,response_truncated
      FROM webhook_attempts WHERE delivery_id=? AND repo_id=? ORDER BY attempt`, delivery.id, delivery.repo_id);
    return c.json({ ...publicDelivery(delivery), attempts });
  });
  route(app, 'POST', '/v1/deliveries/:id/redeliver', { ...options, summary: 'Redeliver the same event with a new delivery generation', body: z.object({}).strict() }, redeliver);
  route(app, 'POST', '/v1/events/replay', { ...options, summary: 'Replay committed events from the past 30 days', body: replaySchema }, replayEvents);
  route(app, 'POST', '/v1/repos/:repoId/events/replay', { ...options, summary: 'Replay repository events from their committed source', body: replaySchema }, replayEvents);
  const readReplay = async (c: AppContext) => {
    const replay = await one<{ repo_id: string; revision: number } & Record<string, unknown>>(database(c), `SELECT id,repo_id,webhook_id,since_at,until_at,state,delivered_count,revision,created_at,updated_at
      FROM event_replays WHERE id=?`, c.req.param('id'));
    if (!replay) throw new ApiError(404, 'not_found', 'The replay was not found.');
    await getRepository(c, replay.repo_id, 'webhooks.manage'); c.header('etag', etag(replay.revision)); return c.json(replay);
  };
  route(app, 'GET', '/v1/events/replays/:id', { ...options, summary: 'Read replay progress' }, readReplay);
  route(app, 'GET', '/v1/operations/:id/replay', { ...options, summary: 'Read durable replay progress at its current placement' }, readReplay);
  registerEmailPreferences(app);
}

function registerEmailPreferences(app: App): void {
  route(app, 'GET', '/v1/me/email-preferences', { summary: 'Read email notification preferences', tags: ['Notifications'] }, async (c) => {
    const user = requirePrincipal(c).user_id;
    if (!user) throw new ApiError(403, 'user_required', 'A user account is required.');
    const row = await one<{ transactional: number; digest: string; revision: number }>(database(c), 'SELECT transactional,digest,revision FROM email_preferences WHERE user_id=?', user);
    c.header('etag', etag(row?.revision ?? 1));
    return c.json({ transactional: row ? !!row.transactional : true, digest: row?.digest ?? 'off', revision: row?.revision ?? 1 });
  });
  route(app, 'PUT', '/v1/me/email-preferences', { summary: 'Set email notification preferences', tags: ['Notifications'], body: preferenceSchema }, async (c) => {
    const user = requirePrincipal(c).user_id;
    if (!user) throw new ApiError(403, 'user_required', 'A user account is required.');
    const body = await jsonBody(c, preferenceSchema); const revision = expectedRevision(c);
    const token = await hmac(c.env.INTERNAL_SERVICE_KEY, `email-unsubscribe:${user}`);
    await mutate(c, {
      sql: `INSERT INTO email_preferences(user_id,transactional,digest,next_digest_at,unsubscribe_token_hash,revision,updated_at)
        SELECT ?,?,?,?,?,?,? WHERE ?=1 OR EXISTS(SELECT 1 FROM email_preferences WHERE user_id=?)
        ON CONFLICT(user_id) DO UPDATE SET transactional=excluded.transactional,digest=excluded.digest,next_digest_at=excluded.next_digest_at,
          unsubscribe_token_hash=excluded.unsubscribe_token_hash,revision=email_preferences.revision+1,updated_at=excluded.updated_at WHERE email_preferences.revision=?`,
      bindings: [user, Number(body.transactional), body.digest, body.digest === 'off' ? null : new Date(Date.now() + 86400_000).toISOString(), await sha256(token), revision + 1, now(), revision, user, revision],
      event: { type: 'notification.preferences_changed', resource_id: user, resource_revision: revision + 1 },
    });
    c.header('etag', etag(revision + 1)); return c.json({ ...body, revision: revision + 1 });
  });
  route(app, 'POST', '/v1/email/unsubscribe', { summary: 'One-click unsubscribe from activity email', tags: ['Notifications'], public: true, idempotent: false }, async (c) => {
    const user = c.req.query('user_id') ?? ''; const token = c.req.query('token') ?? '';
    const row = await one<{ revision: number; unsubscribe_token_hash: string }>(database(c), 'SELECT revision,unsubscribe_token_hash FROM email_preferences WHERE user_id=?', user);
    if (!row || !await verifyHmac(c.env.INTERNAL_SERVICE_KEY, `email-unsubscribe:${user}`, token) || await sha256(token) !== row.unsubscribe_token_hash) {
      throw new ApiError(400, 'invalid_unsubscribe', 'This unsubscribe link is invalid or has expired.');
    }
    await database(c).batch([stmt(database(c), `UPDATE email_preferences SET digest='off',transactional=0,revision=revision+1,updated_at=? WHERE user_id=? AND revision=?`, now(), user, row.revision)]);
    return c.json({ unsubscribed: true });
  });
}
