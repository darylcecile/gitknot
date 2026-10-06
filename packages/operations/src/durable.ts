import { ApiError, execute, many, mutationGuard, newId, now, one, stmt } from '@gitknot/core';
import type { Database, EventRecord } from '@gitknot/core';
import { consumers } from './types.ts';
import type { Consumer, OperationsBindings } from './types.ts';
import { operationFenceGuard } from './metadata-fence.ts';

export const EVENT_RETENTION_MS = 30 * 86400_000;

export async function sourceEvent(db: Database, id: string): Promise<EventRecord | null> {
  const source = await one<{ event_json: string }>(db, 'SELECT event_json FROM outbox WHERE id=?', id);
  if (!source) return null;
  const event = JSON.parse(source.event_json) as EventRecord;
  if (event.id !== id || !event.type || !Number.isInteger(event.resource_revision)) throw new Error('invalid_source_event');
  return event;
}

/** A duplicate receipt aborts the entire batch, including every effect. */
export async function consumeOnce(db: Database, consumer: string, eventId: string, effects: D1PreparedStatement[]): Promise<boolean> {
  try {
    await db.batch([
      stmt(db, 'INSERT INTO processed_events(consumer,event_id,processed_at) VALUES(?,?,?)', consumer, eventId, now()),
      ...effects,
    ]);
    return true;
  } catch (error) {
    // Only swallow a duplicate if a committed receipt proves another transaction finished.
    if (await one(db, 'SELECT 1 FROM processed_events WHERE consumer=? AND event_id=?', consumer, eventId)) return false;
    throw error;
  }
}

export function completion(db: Database, consumer: Consumer, eventId: string): D1PreparedStatement {
  return stmt(db, `UPDATE event_consumer_jobs SET state='completed',completed_at=?,lease_token=NULL,lease_until=NULL,error_code=NULL
    WHERE consumer=? AND event_id=?`, now(), consumer, eventId);
}

export async function fanoutEvent(env: OperationsBindings, eventId: string): Promise<void> {
  const db = env.DB.withSession('first-primary');
  if (!await sourceEvent(db, eventId)) throw new Error('event_source_missing');
  await consumeOnce(db, 'dispatcher', eventId, consumers.map((consumer) => stmt(db,
    `INSERT OR IGNORE INTO event_consumer_jobs(event_id,consumer,due_at) VALUES(?,?,?)`, eventId, consumer, now())));
}

export async function dispatchOutbox(env: OperationsBindings, limit = 100): Promise<number> {
  const db = env.DB.withSession('first-primary');
  const timestamp = now();
  const stale = new Date(Date.now() - 5 * 60_000).toISOString();
  const rows = await many<{ id: string; created_at: string }>(db, `SELECT o.id,o.created_at FROM outbox o
    LEFT JOIN event_publications p ON p.event_id=o.id
    WHERE (o.status<>'published' OR NOT EXISTS(SELECT 1 FROM processed_events r WHERE r.consumer='dispatcher' AND r.event_id=o.id))
      AND (p.next_attempt_at IS NULL OR p.next_attempt_at<=?) AND (p.last_enqueued_at IS NULL OR p.last_enqueued_at<=?)
      AND NOT EXISTS(SELECT 1 FROM event_source_links s WHERE s.event_id=o.id AND s.imported=1)
    ORDER BY o.created_at,o.id LIMIT ?`, timestamp, stale, limit);
  for (const row of rows) {
    const expiry = new Date(Math.max(Date.parse(row.created_at), Date.now()) + EVENT_RETENTION_MS).toISOString();
    try {
      await env.EVENTS.send({ event_id: row.id, shard_id: env.SHARD_ID, cell_id: env.CELL_ID });
      await db.batch([
        stmt(db, `UPDATE outbox SET status='published',published_at=COALESCE(published_at,?),attempts=attempts+1,last_error=NULL WHERE id=?`, timestamp, row.id),
        stmt(db, `INSERT INTO event_publications(event_id,last_enqueued_at,next_attempt_at,attempts,expires_at)
          VALUES(?,?,?,1,?) ON CONFLICT(event_id) DO UPDATE SET last_enqueued_at=excluded.last_enqueued_at,
          next_attempt_at=excluded.next_attempt_at,attempts=event_publications.attempts+1,error_code=NULL`, row.id, timestamp, timestamp, expiry),
      ]);
    } catch (error) {
      await execute(db, `INSERT INTO event_publications(event_id,next_attempt_at,attempts,error_code,expires_at)
        VALUES(?,?,1,'queue_unavailable',?) ON CONFLICT(event_id) DO UPDATE SET next_attempt_at=excluded.next_attempt_at,
        attempts=event_publications.attempts+1,error_code='queue_unavailable'`, row.id, new Date(Date.now() + 60_000).toISOString(), expiry);
      console.error(JSON.stringify({ component: 'outbox', event_id: row.id, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  return rows.length;
}

export async function enqueueConsumers(env: OperationsBindings): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const timestamp = now();
  const stale = new Date(Date.now() - 5 * 60_000).toISOString();
  await Promise.all(consumers.map(async (consumer) => {
    const rows = await many<{ event_id: string }>(db, `SELECT event_id FROM event_consumer_jobs
      WHERE consumer=? AND state IN ('pending','running') AND due_at<=? AND (lease_until IS NULL OR lease_until<=?)
      AND (enqueued_at IS NULL OR enqueued_at<=?) ORDER BY due_at,event_id LIMIT 100`, consumer, timestamp, timestamp, stale);
    const queue = consumer === 'index' ? env.INDEX_EVENTS : consumer === 'meter' ? env.METER_EVENTS : env.EVENTS;
    if (!queue) throw new Error(`missing_${consumer}_queue`);
    for (const row of rows) {
      await queue.send({ event_id: row.event_id, consumer, shard_id: env.SHARD_ID, cell_id: env.CELL_ID });
      await execute(db, `UPDATE event_consumer_jobs SET enqueued_at=? WHERE event_id=? AND consumer=? AND state<>'completed'`, timestamp, row.event_id, consumer);
    }
  }));
}

export async function claimConsumer(env: OperationsBindings, consumer: Consumer, eventId: string): Promise<string | null> {
  const db = env.DB.withSession('first-primary');
  const token = newId('lease');
  const result = await execute(db, `UPDATE event_consumer_jobs SET state='running',lease_token=?,lease_until=?,attempts=attempts+1
    WHERE event_id=? AND consumer=? AND state IN ('pending','running') AND due_at<=? AND (lease_until IS NULL OR lease_until<=?)`,
  token, new Date(Date.now() + 120_000).toISOString(), eventId, consumer, now(), now());
  return result.meta.changes === 1 ? token : null;
}

export async function deferConsumer(env: OperationsBindings, consumer: Consumer, eventId: string, token: string): Promise<void> {
  const db = env.DB.withSession('first-primary');
  await execute(db, `UPDATE event_consumer_jobs SET state='pending',due_at=?,lease_token=NULL,lease_until=NULL,
    enqueued_at=NULL,error_code='consumer_retry' WHERE event_id=? AND consumer=? AND lease_token=?`,
  new Date(Date.now() + 60_000).toISOString(), eventId, consumer, token);
}

export async function claimOperationRuntime(env: OperationsBindings, operationId: string, name: string): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const guard = newId('guard');
  const operation = await one<{ repo_id: string | null; kind: string }>(db, 'SELECT repo_id,kind FROM operations WHERE id=?', operationId);
  if (!operation) throw new Error('operation_not_found');
  try {
    await db.batch([
      ...await operationFenceGuard(db, operation.kind === 'collaboration.code_scan' ? null : operation.repo_id, operationId),
      stmt(db, `UPDATE operations SET status='running',phase=?,revision=revision+1,updated_at=? WHERE id=? AND status IN ('pending','waiting','running','failed')`, name, now(), operationId),
      mutationGuard(db, guard),
      stmt(db, `INSERT INTO operation_steps(operation_id,name,state,idempotency_key,attempts,started_at) VALUES(?,?,'running',?,1,?)
        ON CONFLICT(operation_id,name) DO UPDATE SET state='running',attempts=attempts+1`, operationId, name, `${operationId}:${name}`, now()),
      stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard),
    ]);
  } catch (error) {
    if (/mutation_requires_one_row/.test(String(error))) throw new ApiError(409, 'operation_not_running', 'The operation was cancelled or already completed.');
    throw error;
  }
}
