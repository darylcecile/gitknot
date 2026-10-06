import { many } from '@gitknot/core';
import type { Database } from '@gitknot/core';
import { integer, signedUnits, units } from './money.ts';
import { invariant } from './errors.ts';
import type { UsageRollup } from './types.ts';

/** Each coordinator owns a cumulative contribution. SQL never sums monetary TEXT. */
export async function usageRollups(db: Database, input: {
  account_id: string; period: string; dimension: UsageRollup['dimension']; operating_cost?: boolean; after?: string; limit?: number;
}): Promise<UsageRollup[]> {
  const limit = integer(input.limit ?? 101, 'usage_limit', 1001);
  invariant(limit > 0, 'usage_limit', 'Usage pages must have a positive limit.', 422);
  const args = [input.account_id, input.period, input.dimension, input.operating_cost ? 1 : 0, input.after ?? '', limit];
  const rows = await many<UsageRollup>(db, `WITH page AS (
    SELECT dimension_id,meter FROM billing_usage_rollups WHERE account_id=? AND period=? AND dimension=? AND operating_cost=?
      AND (dimension_id||':'||meter)>? GROUP BY dimension_id,meter ORDER BY dimension_id,meter LIMIT ?)
    SELECT r.* FROM billing_usage_rollups r JOIN page p ON p.dimension_id=r.dimension_id AND p.meter=r.meter
    WHERE r.account_id=? AND r.period=? AND r.dimension=? AND r.operating_cost=? ORDER BY r.dimension_id,r.meter,r.coordinator_id LIMIT 10001`,
  ...args, ...args.slice(0, 4));
  invariant(rows.length <= 10000, 'usage_page_too_large', 'Reduce the usage page size to aggregate every coordinator contribution.', 422);
  const totals = new Map<string, UsageRollup>();
  for (const row of rows) {
    const key = JSON.stringify([row.dimension_id, row.meter]);
    const total = totals.get(key) ?? { account_id: row.account_id, period: row.period, dimension: row.dimension,
      dimension_id: row.dimension_id, meter: row.meter, operating_cost: Boolean(row.operating_cost), quantity: '0', amount_units: '0', revision: 0 };
    total.quantity = (units(total.quantity) + units(row.quantity)).toString();
    total.amount_units = (signedUnits(total.amount_units) + signedUnits(row.amount_units)).toString();
    total.revision = integer(total.revision + row.revision, 'usage_revision');
    totals.set(key, total);
  }
  return [...totals.values()];
}
