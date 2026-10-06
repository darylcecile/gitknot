import { ApiError, canonicalJson, identityDatabaseLocation, now, one, resolveRepositoryPlacement, resolveResourceLocator,
  registerResourceLocator, sha256, stmt } from '@gitknot/core';
import type { EventRecord, RepositoryPlacement } from '@gitknot/core';
import { backgroundCell, financialEnvironment, shardEnvironment } from './placement.ts';
import { placementGuard, requireLocalAuthority } from './ownership.ts';
import { privateJSON } from './private.ts';
import type { Consumer, OperationsBindings } from './types.ts';

export interface EventReference { event_id: string; cell_id: string; shard_id: string }
export interface CommittedEvent extends EventReference { event: EventRecord; created_at: string }
export interface EffectTarget { cell_id: string; shard_id: string; repo_id: string | null; epoch: number | null }
export const EVENT_RPC_SCOPE = 'operations.events';

export function eventReference(env: OperationsBindings, eventId: string): EventReference {
  return { event_id: eventId, cell_id: env.CELL_ID, shard_id: env.SHARD_ID };
}

/** An absent source is an error, not a successful Queue acknowledgement. */
export async function readCommittedEvent(env: OperationsBindings, source: EventReference): Promise<CommittedEvent> {
  if (source.cell_id !== env.CELL_ID) {
    const result = await privateJSON<CommittedEvent>(env, backgroundCell(env, source.cell_id), EVENT_RPC_SCOPE, '/internal/events/source', source);
    if (result.event_id !== source.event_id || result.cell_id !== source.cell_id || result.shard_id !== source.shard_id || result.event.id !== source.event_id) {
      throw new Error('event_source_receipt_mismatch');
    }
    return result;
  }
  const local = shardEnvironment(env, source.shard_id);
  const row = await one<{ event_json: string; created_at: string }>(local.DB.withSession('first-primary'), 'SELECT event_json,created_at FROM outbox WHERE id=?', source.event_id);
  if (!row) throw new ApiError(503, 'event_source_missing', 'The declared committed event source is unavailable.');
  const event = JSON.parse(row.event_json) as EventRecord;
  if (event.id !== source.event_id || !event.type || !Number.isSafeInteger(event.resource_revision)) throw new Error('invalid_source_event');
  return { ...source, event, created_at: row.created_at };
}

function identityEffect(event: EventRecord, consumer: Consumer): boolean {
  return consumer === 'meter' || consumer === 'mail' && /^(?:identity|invitation|runner)\./.test(event.type);
}

export async function effectTarget(env: OperationsBindings, event: EventRecord, consumer: Consumer): Promise<EffectTarget> {
  if (!event.repo_id || identityEffect(event, consumer)) return { ...identityDatabaseLocation(env), repo_id: null, epoch: null };
  const placement = await resolveRepositoryPlacement(env, event.repo_id);
  if (!placement) throw new Error('event_repository_authority_missing');
  return { cell_id: placement.cell_id, shard_id: placement.shard_id, repo_id: event.repo_id, epoch: placement.epoch };
}

export function targetEnvironment(env: OperationsBindings, target: EffectTarget): OperationsBindings {
  if (target.cell_id !== env.CELL_ID) throw new Error('event_target_cell_mismatch');
  if (target.repo_id === null) return financialEnvironment(env);
  return shardEnvironment(env, target.shard_id);
}

export async function verifyEffectTarget(env: OperationsBindings, target: EffectTarget): Promise<void> {
  if (target.cell_id !== env.CELL_ID || target.shard_id !== env.SHARD_ID) throw new Error('event_target_placement_mismatch');
  const repository = await requireLocalAuthority(env, target.repo_id);
  if (repository && repository.routing_epoch !== target.epoch) throw new ApiError(409, 'event_target_changed', 'The event effect placement changed.');
}

/** This copy is made only after reading a committed source through the fixed private protocol. */
export async function retainEventSource(env: OperationsBindings, source: CommittedEvent, consumer: Consumer | null, target: EffectTarget): Promise<void> {
  await verifyEffectTarget(env, target);
  const db = env.DB.withSession('first-primary');
  const event = source.event;
  const encoded = JSON.stringify(event);
  const hash = await sha256(canonicalJson(event));
  const existing = await one<{ event_json: string }>(db, 'SELECT event_json FROM outbox WHERE id=?', event.id);
  if (existing && await sha256(canonicalJson(JSON.parse(existing.event_json))) !== hash) throw new Error('event_identity_conflict');
  const repository = await requireLocalAuthority(env, target.repo_id);
  await db.batch([
    ...placementGuard(db, repository),
    stmt(db, `INSERT INTO event_source_links(event_id,repo_id,source_cell_id,source_shard_id,event_sha256,imported,created_at)
      SELECT ?,?,?,?,?,CASE WHEN EXISTS(SELECT 1 FROM outbox WHERE id=?) THEN 0 ELSE 1 END,? ON CONFLICT(event_id) DO NOTHING`,
    event.id, event.repo_id ?? null, source.cell_id, source.shard_id, hash, event.id, now()),
    stmt(db, `INSERT INTO outbox(id,type,version,occurred_at,actor_id,resource_id,resource_revision,repo_id,account_id,payload_json,event_json,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'published',?) ON CONFLICT(id) DO NOTHING`, event.id, event.type, event.version, event.occurred_at,
    event.actor_id, event.resource_id, event.resource_revision, event.repo_id ?? null, event.account_id ?? null, JSON.stringify(event.data), encoded, source.created_at),
    ...(consumer ? [stmt(db, 'INSERT INTO event_consumer_jobs(event_id,consumer,due_at) VALUES(?,?,?) ON CONFLICT(event_id,consumer) DO NOTHING', event.id, consumer, now())] : []),
  ]);
}

/** Public delivery locators preserve repository ownership; mail's account notices stay primary-owned. */
export async function deliveryTarget(env: OperationsBindings, id: string, kind: 'webhook' | 'mail'): Promise<EffectTarget> {
  let locator = await resolveResourceLocator(env, id, 'delivery');
  if (!locator) {
    const table = kind === 'webhook' ? 'webhook_deliveries' : 'mail_deliveries';
    const row = await one<{ repo_id: string | null; template?: string }>(env.DB.withSession('first-primary'), `SELECT * FROM ${table} WHERE id=?`, id);
    if (!row) throw new ApiError(503, 'delivery_source_missing', 'The declared delivery source is unavailable.');
    const identity = kind === 'mail' && (row.repo_id === null || /^(?:verify_email|recover_password|change_email|invitation|runner_enrolled|security_notice)$/.test(row.template ?? ''));
    await registerResourceLocator(env, { resource_id: id, resource_type: 'delivery', repo_id: row.repo_id, authority: identity ? 'identity' : 'repository' });
    locator = await resolveResourceLocator(env, id, 'delivery');
  }
  if (!locator) throw new Error('delivery_locator_missing');
  if (!locator.repo_id || locator.authority === 'identity') return { ...identityDatabaseLocation(env), repo_id: null, epoch: null };
  const placement = await resolveRepositoryPlacement(env, locator.repo_id);
  if (!placement) throw new Error('delivery_repository_missing');
  return { cell_id: placement.cell_id, shard_id: placement.shard_id, repo_id: locator.repo_id, epoch: placement.epoch };
}

export async function routeDelivery(env: OperationsBindings, id: string, kind: 'webhook' | 'mail'): Promise<OperationsBindings | null> {
  const target = await deliveryTarget(env, id, kind);
  if (target.cell_id !== env.CELL_ID) {
    const result = await privateJSON<{ accepted: boolean }>(env, backgroundCell(env, target.cell_id), EVENT_RPC_SCOPE, '/internal/events/delivery',
      { delivery_id: id, kind, target });
    if (!result.accepted) throw new Error('delivery_handoff_unconfirmed');
    return null;
  }
  const local = targetEnvironment(env, target);
  await verifyEffectTarget(local, target);
  return local;
}

export function targetFromPlacement(placement: RepositoryPlacement): EffectTarget {
  return { cell_id: placement.cell_id, shard_id: placement.shard_id, repo_id: placement.repo_id, epoch: placement.epoch };
}
