import { many, now, stmt } from '@gitknot/core';
import type { EventRecord } from '@gitknot/core';
import { completion, consumeOnce } from './durable.ts';
import type { OperationsBindings } from './types.ts';

/** Projections consume only durable ledger entries; events and telemetry never invent charges. */
export async function projectUsage(env: OperationsBindings, event: EventRecord): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const ids = Array.isArray(event.data.ledger_ids) ? event.data.ledger_ids.filter((id): id is string => typeof id === 'string') : [];
  if (ids.length > 1000) throw new Error('ledger_projection_batch_limit');
  const entries = await many<Record<string, string | number>>(db,
    `SELECT id,event_id,account_id,repo_id,meter,meter_version,price_version,quantity,amount_units,operating_cost,occurred_at
      FROM billing_ledger WHERE id IN(SELECT value FROM json_each(?)) AND account_id=? ORDER BY id`, JSON.stringify(ids), event.account_id ?? '');
  if (entries.length !== ids.length) throw new Error('committed_ledger_entries_missing');
  const effects = entries.map((entry) => stmt(db, `INSERT OR IGNORE INTO usage_projection_entries
    (ledger_id,event_id,account_id,repo_id,meter,meter_version,price_version,quantity,amount_units,operating_cost,occurred_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`, entry.id, entry.event_id, entry.account_id, entry.repo_id, entry.meter, entry.meter_version,
  entry.price_version, entry.quantity, entry.amount_units, entry.operating_cost, entry.occurred_at));
  effects.push(completion(db, 'meter', event.id));
  await consumeOnce(db, 'meter', event.id, effects);
}

export async function operationalMetrics(env: OperationsBindings): Promise<Record<string, number>> {
  const db = env.DB.withSession('first-primary');
  const counts = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS value FROM outbox WHERE status<>'published'`).first<{ value: number }>(),
    db.prepare(`SELECT COUNT(*) AS value FROM event_consumer_jobs WHERE state<>'completed'`).first<{ value: number }>(),
    db.prepare(`SELECT COUNT(*) AS value FROM webhook_deliveries WHERE state='pending' AND next_attempt_at<?`).bind(now()).first<{ value: number }>(),
    db.prepare(`SELECT COUNT(*) AS value FROM operations WHERE status='failed'`).first<{ value: number }>(),
    db.prepare(`SELECT COUNT(*) AS value FROM object_manifests WHERE state='deleting'`).first<{ value: number }>(),
  ]);
  const names = ['outbox_unpublished', 'consumer_backlog', 'webhook_due', 'operations_failed', 'objects_deleting'];
  const metrics = Object.fromEntries(names.map((name, index) => [name, counts[index]?.value ?? 0]));
  for (const [name, value] of Object.entries(metrics)) env.METRICS?.writeDataPoint({ indexes: [env.CELL_ID], blobs: [env.SHARD_ID, name], doubles: [value] });
  return metrics;
}
