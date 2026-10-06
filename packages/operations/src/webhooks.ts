import { execute, many, mutationGuard, newId, now, one, registerResourceLocator, sha256, stmt } from '@gitknot/core';
import type { Database, EventRecord } from '@gitknot/core';
import { webhookAuthorization } from './authorization.ts';
import { completion, consumeOnce, sourceEvent } from './durable.ts';
import { privateJSON, recordDiagnostic } from './private.ts';
import { retryAt } from './security.ts';
import { signDelivery } from './webhook-broker.ts';
import type { Delivery, OperationsBindings, OutboundResponse, PublicEvent, Webhook } from './types.ts';
import { retainEventSource, routeDelivery } from './event-routing.ts';
import { localRepository, placementGuard, requireLocalAuthority } from './ownership.ts';
import { readReplayPage } from './replay.ts';

const publicPrefixes = ['repository.', 'ref.', 'git.', 'issue.', 'pull_request.', 'review.', 'discussion.', 'task.', 'workflow.', 'run.', 'membership.', 'billing.'];

export function eventCapability(event: EventRecord): string {
  if (/^(?:pull_request|review)\./.test(event.type)) return 'pull_requests.read';
  if (event.type.startsWith('issue.')) return 'issues.read';
  if (event.type.startsWith('discussion.')) return 'discussions.read';
  if (event.type.startsWith('task.')) return 'tasks.read';
  if (/^(?:workflow|run)\./.test(event.type)) return 'runs.read';
  if (event.type.startsWith('membership.')) return 'members.read';
  if (event.type.startsWith('billing.')) return 'billing.read';
  return 'contents.read';
}

export function acceptsEvent(webhook: Pick<Webhook, 'events_json'>, type: string): boolean {
  if (!publicPrefixes.some((prefix) => type.startsWith(prefix))) return false;
  return (JSON.parse(webhook.events_json) as string[]).some((pattern) => pattern === '*' || pattern === type || (pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1))));
}

export function publicEvent(event: EventRecord): PublicEvent {
  // The source may contain internal metadata. The public envelope is an explicit thin projection.
  const data: Record<string, unknown> = {};
  for (const name of ['ref', 'before', 'after', 'commit_oid', 'head_oid', 'base_oid', 'state', 'action', 'number', 'run_id', 'item_id']) {
    const value = event.data[name];
    if ((typeof value === 'string' && value.length <= 1024) || typeof value === 'number' || typeof value === 'boolean' || value === null) data[name] = value;
  }
  return {
    id: event.id, type: event.type, version: event.version, occurred_at: event.occurred_at,
    actor_id: event.actor_id, resource_id: event.resource_id, resource_revision: event.resource_revision,
    repo_id: event.repo_id ?? null, account_id: event.account_id ?? null, data,
  };
}

export function deliveryStatement(db: Database, hook: Webhook, eventId: string, timestamp: string, id: string): D1PreparedStatement {
  return stmt(db, `INSERT OR IGNORE INTO webhook_deliveries(id,event_id,webhook_id,repo_id,account_id,next_attempt_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`, id, eventId, hook.id, hook.repo_id, hook.account_id, timestamp, timestamp, timestamp);
}

export async function scheduleWebhooks(env: OperationsBindings, event: EventRecord): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const repository = event.repo_id ? await requireLocalAuthority(env, event.repo_id) : null;
  const hooks = event.repo_id ? await many<Webhook>(db,
    `SELECT * FROM webhooks WHERE repo_id=? AND state='active' AND created_at<=? ORDER BY id LIMIT 101`, event.repo_id, event.occurred_at) : [];
  if (hooks.length > 100) throw new Error('webhook_fanout_limit');
  const deliveries = await Promise.all(hooks.filter((hook) => acceptsEvent(hook, event.type)).map(async (hook) => {
    const audience = await webhookAuthorization(env, hook, eventCapability(event), event);
    if (audience === 'revoked' || audience === 'event_denied') return null;
    if (audience === 'changed') throw new Error('webhook_configuration_changed');
    const id = `delivery_${(await sha256(`${hook.id}:${event.id}:0`)).slice(0, 48)}`;
    await registerResourceLocator(env, { resource_id: id, resource_type: 'delivery', repo_id: hook.repo_id });
    return deliveryStatement(db, hook, event.id, now(), id);
  }));
  await consumeOnce(db, 'webhooks', event.id, [
    ...placementGuard(db, repository),
    ...deliveries.filter((statement): statement is D1PreparedStatement => statement !== null),
    completion(db, 'webhooks', event.id),
  ]);
}

async function claimDelivery(env: OperationsBindings, id: string): Promise<Delivery | null> {
  const db = env.DB.withSession('first-primary');
  const row = await one<{ repo_id: string }>(db, 'SELECT repo_id FROM webhook_deliveries WHERE id=?', id);
  if (!row) throw new Error('delivery_source_missing');
  const repository = await requireLocalAuthority(env, row.repo_id);
  const token = newId('attempt');
  const timestamp = now();
  await db.batch([
    ...placementGuard(db, repository),
    stmt(db, `UPDATE webhook_deliveries SET state='sending',lease_token=?,lease_until=?,attempt_count=attempt_count+1,
      revision=revision+1,updated_at=? WHERE id=? AND state IN ('pending','sending') AND next_attempt_at<=?
      AND (lease_until IS NULL OR lease_until<=?)`, token, new Date(Date.now() + 120_000).toISOString(), timestamp, id, timestamp, timestamp),
    stmt(db, `UPDATE webhook_attempts SET state='uncertain',finished_at=?,error_code='interrupted'
      WHERE delivery_id=? AND state='sending' AND EXISTS(SELECT 1 FROM webhook_deliveries WHERE id=? AND lease_token=?)`, timestamp, id, id, token),
    stmt(db, `INSERT INTO webhook_attempts(id,delivery_id,repo_id,attempt,state,started_at)
      SELECT ?,id,repo_id,attempt_count,'sending',? FROM webhook_deliveries WHERE id=? AND lease_token=?`, token, timestamp, id, token),
  ]);
  return one<Delivery>(db, 'SELECT * FROM webhook_deliveries WHERE id=? AND lease_token=?', id, token);
}

async function finishDelivery(env: OperationsBindings, delivery: Delivery, result: OutboundResponse | null, errorCode?: string, cancelled = false): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const succeeded = !!result && result.status >= 200 && result.status < 300;
  const timestamp = now();
  const next = cancelled || succeeded || result?.status === 410 ? null : retryAt(delivery.attempt_count, delivery.created_at, result?.retry_after);
  const state = cancelled ? 'cancelled' : succeeded ? 'succeeded' : next ? 'pending' : 'failed';
  const code = succeeded ? null : errorCode ?? (result ? `http_${result.status}` : 'delivery_failed');
  await db.batch([
    stmt(db, `UPDATE webhook_attempts SET state=?,finished_at=?,status=?,error_code=?,duration_ms=?,response_excerpt=?,response_truncated=?
      WHERE id=? AND EXISTS(SELECT 1 FROM webhook_deliveries WHERE id=? AND lease_token=? AND state='sending')`,
    cancelled ? 'cancelled' : succeeded ? 'succeeded' : 'failed', timestamp, result?.status ?? null, code,
    result?.duration_ms ?? null, result?.response_excerpt ?? null, Number(result?.response_truncated ?? false), delivery.lease_token, delivery.id, delivery.lease_token),
    stmt(db, `UPDATE webhook_deliveries SET state=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,enqueued_at=NULL,
      last_status=?,error_code=?,revision=revision+1,updated_at=? WHERE id=? AND lease_token=? AND state='sending'`,
    state, next ?? timestamp, result?.status ?? null, code, timestamp, delivery.id, delivery.lease_token),
  ]);
}

export async function deliverWebhook(env: OperationsBindings, id: string): Promise<void> {
  const target = await routeDelivery(env, id, 'webhook');
  if (!target) return;
  env = target;
  const delivery = await claimDelivery(env, id);
  if (!delivery) return;
  try {
    const db = env.DB.withSession('first-primary');
    const hook = await one<Webhook>(db, 'SELECT * FROM webhooks WHERE id=? AND repo_id=?', delivery.webhook_id, delivery.repo_id);
    const event = await sourceEvent(db, delivery.event_id);
    if (!hook || !event || event.repo_id !== delivery.repo_id || !acceptsEvent(hook, event.type)) {
      await finishDelivery(env, delivery, null, 'access_revoked', true);
      return;
    }
    const initial = await webhookAuthorization(env, hook, eventCapability(event), event);
    if (initial !== 'authorized') {
      await finishDelivery(env, delivery, null, initial === 'event_denied' ? 'event_audience_revoked' : initial === 'revoked' ? 'access_revoked' : 'configuration_changed', initial === 'revoked' || initial === 'event_denied');
      return;
    }
    const body = JSON.stringify(publicEvent(event));
    const timestamp = Math.floor(Date.now() / 1000);
    const { signature } = await signDelivery(env, { delivery_id: id, event_id: event.id, timestamp, body });
    if (!/^v1,[A-Za-z0-9+/]+=*(?: v1,[A-Za-z0-9+/]+=*)*$/.test(signature)) throw new Error('invalid_broker_signature');
    await requireLocalAuthority(env, delivery.repo_id);
    const current = await webhookAuthorization(env, hook, eventCapability(event), event);
    if (current !== 'authorized') {
      await finishDelivery(env, delivery, null, current === 'event_denied' ? 'event_audience_revoked' : current === 'revoked' ? 'access_revoked' : 'configuration_changed', current === 'revoked' || current === 'event_denied');
      return;
    }
    const response = await privateJSON<OutboundResponse>(env, env.WEBHOOK_EGRESS, 'webhook-egress', '/internal/webhooks/send', {
      url: hook.url, body, headers: {
        'webhook-id': event.id, 'webhook-timestamp': String(timestamp), 'webhook-signature': signature,
        'x-gitknot-delivery': delivery.id, 'user-agent': 'GitKnot-Webhooks/1.0', 'content-type': 'application/json',
      },
    });
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw new Error('invalid_egress_receipt');
    await finishDelivery(env, delivery, response);
    if (response.status === 410) await execute(db, `UPDATE webhooks SET state='disabled',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND state='active'`, now(), hook.id, hook.revision);
  } catch (error) {
    await recordDiagnostic(env, 'webhook', delivery.id, error);
    await finishDelivery(env, delivery, null, 'delivery_unavailable');
  }
}

export async function enqueueDeliveries(env: OperationsBindings): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const stale = new Date(Date.now() - 5 * 60_000).toISOString();
  await Promise.all((['webhook', 'mail'] as const).map(async (kind) => {
    const table = kind === 'webhook' ? 'webhook_deliveries' : 'mail_deliveries';
    const queue = kind === 'webhook' ? env.WEBHOOK_DELIVERIES : env.MAIL_DELIVERIES;
    const rows = await many<{ id: string }>(db, `SELECT id FROM ${table} WHERE state IN ('pending','sending')
      AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?) AND (enqueued_at IS NULL OR enqueued_at<=?)
      ORDER BY next_attempt_at,id LIMIT 100`, now(), now(), stale);
    for (const row of rows) {
      await queue.send({ delivery_id: row.id, shard_id: env.SHARD_ID, cell_id: env.CELL_ID });
      await execute(db, `UPDATE ${table} SET enqueued_at=? WHERE id=?`, now(), row.id);
    }
  }));
}

export async function sweepReplays(env: OperationsBindings): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const replays = await many<{ id: string; repo_id: string; webhook_id: string; source_cell_id: string | null; source_shard_id: string | null;
    since_at: string; until_at: string; through_rowid: number; cursor: string | null; revision: number }>(db,
    `SELECT * FROM event_replays WHERE state IN ('pending','running') ORDER BY id LIMIT 10`);
  for (const replay of replays) {
    const repository = await localRepository(env, replay.repo_id);
    if (!repository) continue;
    const hook = await one<Webhook>(db, 'SELECT * FROM webhooks WHERE id=? AND repo_id=?', replay.webhook_id, replay.repo_id);
    const authorization = hook ? await webhookAuthorization(env, hook) : 'revoked';
    if (authorization === 'revoked') {
      await execute(db, `UPDATE event_replays SET state='cancelled',revision=revision+1,updated_at=? WHERE id=? AND revision=?`, now(), replay.id, replay.revision);
      continue;
    }
    if (!hook || authorization === 'changed') continue;
    const page = await readReplayPage(env, { replay_id: replay.id, repo_id: replay.repo_id, cell_id: replay.source_cell_id ?? env.CELL_ID,
      shard_id: replay.source_shard_id ?? env.SHARD_ID, cursor: replay.cursor });
    const effects: D1PreparedStatement[] = [...placementGuard(db, repository)];
    let delivered = 0;
    for (const source of page.items) {
      const event = source.event;
      if (!acceptsEvent(hook, event.type)) continue;
      if (event.repo_id !== replay.repo_id || event.id !== source.event_id) throw new Error('replay_source_scope');
      const current = await webhookAuthorization(env, hook, eventCapability(event), event);
      if (current === 'changed') throw new Error('webhook_configuration_changed');
      if (current !== 'authorized') continue;
      await retainEventSource(env, source, null, { repo_id: replay.repo_id, cell_id: env.CELL_ID, shard_id: env.SHARD_ID, epoch: repository.routing_epoch });
      const id = `delivery_${(await sha256(`${replay.id}:${hook.id}:${event.id}`)).slice(0, 48)}`;
      await registerResourceLocator(env, { resource_id: id, resource_type: 'delivery', repo_id: hook.repo_id });
      effects.push(stmt(db, `INSERT OR IGNORE INTO webhook_deliveries
        (id,event_id,webhook_id,repo_id,account_id,generation,replay_id,next_attempt_at,created_at,updated_at)
        SELECT ?,?,?,?,?,COALESCE((SELECT MAX(generation)+1 FROM webhook_deliveries WHERE event_id=? AND webhook_id=?),0),?,?,?,?
        WHERE NOT EXISTS(SELECT 1 FROM webhook_deliveries WHERE event_id=? AND replay_id=?)`,
      id, event.id, hook.id, hook.repo_id, hook.account_id, event.id, hook.id, replay.id, now(), now(), now(), event.id, replay.id));
      delivered++;
    }
    const guard = newId('guard');
    effects.push(stmt(db, `UPDATE event_replays SET state=?,cursor=?,delivered_count=delivered_count+?,revision=revision+1,updated_at=? WHERE id=? AND revision=?`,
      page.complete ? 'completed' : 'running', page.items.at(-1)?.event_id ?? replay.cursor, delivered, now(), replay.id, replay.revision),
    mutationGuard(db, guard), stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard),
    stmt(db, `UPDATE operations SET status=?,phase=?,progress=?,revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND kind='events.replay'`,
      page.complete ? 'completed' : 'running', page.complete ? 'completed' : 'replaying', page.complete ? 100 : 0, now(), page.complete ? now() : null, replay.id));
    await consumeOnce(db, `replay:${replay.id}`, replay.cursor ?? 'start', effects);
  }
}
