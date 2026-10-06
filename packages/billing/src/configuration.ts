import { z } from 'zod';
import { BillingError } from './errors.ts';
import type { BillingBindings } from './types.ts';

const policySchema = z.object({
  commitment_seconds: z.number().int().min(86_400).max(90 * 86_400).default(30 * 86_400),
  renew_before_seconds: z.number().int().min(3600).max(30 * 86_400).default(7 * 86_400),
  deletion_grace_seconds: z.number().int().min(86_400).max(90 * 86_400).default(14 * 86_400),
  maximum_retention_seconds: z.number().int().min(86_400).max(36500 * 86_400).default(3650 * 86_400),
  maximum_objects: z.number().int().min(1).max(1_000_000).default(100_000),
  periodic_accrual_seconds: z.number().int().min(60).max(3600).default(3600),
}).strict().refine((p) => p.renew_before_seconds < p.commitment_seconds);

export function storagePolicy(env: Pick<BillingBindings, 'LIMITS_JSON'>): z.infer<typeof policySchema> {
  try {
    const config = JSON.parse(env.LIMITS_JSON ?? '{}') as Record<string, unknown>;
    return policySchema.parse(config.billing_storage ?? {});
  } catch { throw new BillingError('storage_policy_unavailable', 'The configured storage retention policy could not be verified.', 503); }
}

/** An observed UTC bucket boundary; explicit settlement callers keep their exact timestamp. */
export function storageAccrualCheckpoint(at: string, seconds: number): string {
  const interval = seconds * 1000;
  const tick = new Date(Math.floor(Date.parse(at) / interval) * interval).toISOString();
  const month = `${at.slice(0, 7)}-01T00:00:00.000Z`;
  return tick > month ? tick : month;
}
