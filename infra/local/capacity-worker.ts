import { allocatePlatformSlices } from '../../packages/billing/src/catalog.ts';
import { auditStatement } from '../../packages/core/src/events.ts';

type Purpose = 'discretionary' | 'essential';
export interface LocalCapacityPlan {
  mode: 'development';
  cell: string;
  generation: string;
  starts_at: string;
  ends_at: string;
  pools: { id: string; purpose: Purpose; limit_units: string; safety_buffer_units: string; baseline_commitment_units: string; max_instances: number }[];
  slices: { id: string; pool_id: string; purpose: Purpose; limit_units: string; max_instances: number; max_storage_bytes: string }[];
}
type Pool = LocalCapacityPlan['pools'][number] & {
  period_start: string; period_end: string; allocated_units: string; allocated_instances: number;
  revision: number; state: 'active' | 'stopped';
};
type Slice = LocalCapacityPlan['slices'][number] & {
  cell_id: string; valid_until: string; state: 'active' | 'stopped' | 'retired'; admission_epoch: number;
};
export interface LocalCapacityReport {
  mode: 'development'; generation: string;
  allocations: { id: string; pool_id: string | null; purpose: Purpose; action: 'created' | 'preserved' | 'missing';
    status: 'configured' | 'stopped' | 'expired' | 'reconciliation_required' | 'missing'; limit_units: string | null; valid_until: string | null }[];
}
interface Env { DB: D1Database; LOCAL_CAPACITY_PLAN: string; LOCAL_CAPACITY_KEY: string }

function money(value: string): bigint {
  if (!/^(?:0|[1-9][0-9]{0,62})$/.test(value)) throw new Error('Local capacity contains a noncanonical monetary quantity.');
  return BigInt(value);
}

async function pool(db: D1Database, id: string, purpose: Purpose): Promise<Pool | null> {
  const row = await db.prepare('SELECT * FROM billing_platform_pools WHERE id=?').bind(id).first<Pool>();
  if (!row) return null;
  if (row.purpose !== purpose || !['active', 'stopped'].includes(row.state) || !(Date.parse(row.period_end) > Date.parse(row.period_start))
    || money(row.allocated_units) + money(row.safety_buffer_units) + money(row.baseline_commitment_units) > money(row.limit_units)
    || row.allocated_instances < 0 || row.allocated_instances > row.max_instances) throw new Error(`Local pool ${id} has incompatible scope or accounting; reconcile it explicitly.`);
  return row;
}

async function allocation(db: D1Database, plan: LocalCapacityPlan, desired: LocalCapacityPlan['slices'][number]): Promise<LocalCapacityReport['allocations'][number]> {
  const row = await db.prepare('SELECT * FROM billing_capacity_slices WHERE id=?').bind(desired.id).first<Slice>();
  if (!row) return { id: desired.id, pool_id: null, purpose: desired.purpose, action: 'missing', status: 'missing', limit_units: null, valid_until: null };
  const parent = await pool(db, row.pool_id, desired.purpose);
  if (!parent || row.cell_id !== plan.cell || row.purpose !== desired.purpose || !['active', 'stopped', 'retired'].includes(row.state)
    || !(Date.parse(row.valid_until) > Date.parse(parent.period_start)) || Date.parse(row.valid_until) > Date.parse(parent.period_end)
    || money(row.limit_units) > money(parent.allocated_units) || money(row.max_storage_bytes) < 0n
    || row.max_instances < 0 || row.max_instances > parent.allocated_instances) throw new Error(`Existing local slice ${desired.id} does not match its configured cell/purpose or finite pool.`);
  const projection = await db.prepare('SELECT body_json FROM billing_controls WHERE coordinator_id=?').bind(`capacity:${row.id}`).first<{ body_json: string }>();
  const control = projection ? JSON.parse(projection.body_json) as { stopped?: boolean; valid_until?: string } : undefined;
  const stopped = row.state !== 'active' || parent.state !== 'active' || control?.stopped === true;
  const expired = row.valid_until <= new Date().toISOString() || Boolean(control?.valid_until && control.valid_until <= new Date().toISOString());
  const status = stopped ? 'stopped' : expired ? 'expired' : row.admission_epoch > 0 && !control ? 'reconciliation_required' : 'configured';
  return { id: row.id, pool_id: row.pool_id, purpose: row.purpose, action: 'preserved', status, limit_units: row.limit_units, valid_until: row.valid_until };
}

async function ensurePool(db: D1Database, plan: LocalCapacityPlan, desired: LocalCapacityPlan['pools'][number]): Promise<Pool> {
  let current = await pool(db, desired.id, desired.purpose);
  if (current) return current;
  try {
    await db.batch([
      db.prepare(`INSERT INTO billing_platform_pools(id,period_start,period_end,limit_units,safety_buffer_units,baseline_commitment_units,max_instances,state,purpose)
        VALUES (?,?,?,?,?,?,?,'active',?)`).bind(desired.id, plan.starts_at, plan.ends_at, desired.limit_units,
        desired.safety_buffer_units, desired.baseline_commitment_units, desired.max_instances, desired.purpose),
      auditStatement(db, { action: 'billing.local_operator.pool_created', actor_id: 'system:local-operator', resource_id: desired.id,
        details: { mode: plan.mode, cell_id: plan.cell, generation: plan.generation, purpose: desired.purpose, limit_units: desired.limit_units,
          valid_until: plan.ends_at, source: 'explicit_local_development_allocation' } }),
    ]);
  } catch (error) {
    current = await pool(db, desired.id, desired.purpose);
    if (!current) throw error;
  }
  current ??= await pool(db, desired.id, desired.purpose);
  if (!current) throw new Error('Local pool creation did not produce a verified allocation parent.');
  return current;
}

async function bootstrap(db: D1Database, plan: LocalCapacityPlan, apply: boolean): Promise<LocalCapacityReport> {
  const initial = await Promise.all(plan.slices.map(slice => allocation(db, plan, slice)));
  if (!apply || initial.every(slice => slice.action !== 'missing')) return { mode: plan.mode, generation: plan.generation, allocations: initial };
  if (initial.some(slice => !['configured', 'missing'].includes(slice.status))) throw new Error('Existing local funding is stopped, expired or unreconciled. Preserve it and complete the explicit operator recovery before adding allocations.');
  const created = new Set<string>();
  for (const desired of plan.pools) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidates = plan.slices.filter(slice => slice.pool_id === desired.id);
      const observed = await Promise.all(candidates.map(slice => allocation(db, plan, slice)));
      const missing = candidates.filter((_, index) => observed[index]!.action === 'missing');
      if (!missing.length) break;
      const parent = await ensurePool(db, plan, desired);
      try {
        await allocatePlatformSlices({ DB: db }, { pool_id: parent.id, expected_revision: parent.revision,
          slices: missing.map(slice => ({ id: slice.id, cell_id: plan.cell, limit_units: slice.limit_units, max_instances: slice.max_instances,
            max_storage_bytes: slice.max_storage_bytes, valid_until: parent.period_end })) });
        for (const slice of missing) created.add(slice.id);
        break;
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (attempt === 2 || !['billing_conflict', 'platform_configuration'].includes(String(code))) throw error;
      }
    }
  }
  const allocations = await Promise.all(plan.slices.map(slice => allocation(db, plan, slice)));
  if (allocations.some(slice => slice.action === 'missing')) throw new Error('Local capacity allocation did not produce every configured slice.');
  return { mode: plan.mode, generation: plan.generation, allocations: allocations.map(slice => ({ ...slice, action: created.has(slice.id) ? 'created' : slice.action })) };
}

/** Only the local CLI starts this Worker; its immutable plan is never accepted from an HTTP body. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.headers.get('authorization') !== `Bearer ${env.LOCAL_CAPACITY_KEY}`) return new Response(null, { status: 401 });
    if (!['GET', 'POST'].includes(request.method) || new URL(request.url).pathname !== '/') return new Response(null, { status: 404 });
    try {
      const plan = JSON.parse(env.LOCAL_CAPACITY_PLAN) as LocalCapacityPlan;
      if (plan.mode !== 'development') throw new Error('Local capacity bootstrap is development-only.');
      return Response.json(await bootstrap(env.DB, plan, request.method === 'POST'));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'Local capacity could not be verified.' }, { status: 409 });
    }
  },
} satisfies ExportedHandler<Env>;
