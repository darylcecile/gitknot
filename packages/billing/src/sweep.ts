import { auditStatement, eventStatement, many, now, one, stmt } from '@gitknot/core';
import { closeInvoice, finalizeInvoiceAdmission, reconcileSubscriptionChange } from './commerce.ts';
import { accrueStorage, deleteStorageObject } from './execution.ts';
import { renewStorageCommitment } from './storage.ts';
import { admissionRequest } from './transport.ts';
import { units } from './money.ts';
import type { AdmissionControl, BillingBindings, Budget, StorageObject } from './types.ts';
import { BillingError, invariant } from './errors.ts';
import { billingEnvironment } from './authority.ts';
import { canonicalPurgeReceipt } from './git.ts';
import type { CanonicalGitMeter } from './git-types.ts';
import { abortRepositoryStoragePlacement, commitRepositoryStoragePlacement, finalizeRepositoryStoragePlacement } from './storage-placement.ts';
import { storageAccrualCheckpoint, storagePolicy } from './configuration.ts';

/** Stable UTC checkpoints coalesce concurrent sweeps without advancing unrecorded usage. */
function periodicAccrualThrough(accruedAt: string, at: string, seconds: number, ...boundaries: Array<string | null | undefined>): string | null {
  let through = storageAccrualCheckpoint(at, seconds);
  // Invoices and financed/retention boundaries must not wait for an ordinary tick.
  for (const boundary of boundaries) {
    if (boundary && boundary <= at && boundary > through) through = boundary;
  }
  return through > accruedAt ? through : null;
}

export async function setPlatformStop(env: BillingBindings, input: { pool_id: string; stopped: boolean; reason: string; expected_revision: number }): Promise<void> {
  env = billingEnvironment(env);
  // Stop the authority first; start/reserve independently check it in every slice.
  const result = await env.DB.prepare('UPDATE billing_platform_pools SET state=?,revision=revision+1 WHERE id=? AND revision=?')
    .bind(input.stopped ? 'stopped' : 'active', input.pool_id, input.expected_revision).run();
  invariant(result.meta.changes === 1, 'revision_conflict', 'The platform pool changed.', 412);
  const slices = await many<{ id: string; admission_epoch: number }>(env.DB, "SELECT id,admission_epoch FROM billing_capacity_slices WHERE pool_id=? AND state!='retired'", input.pool_id);
  for (const slice of slices) {
    if (!slice.admission_epoch) continue;
    const { control } = await admissionRequest<{ control: AdmissionControl }>(env, `capacity:${slice.id}`, 'snapshot');
    await admissionRequest(env, `capacity:${slice.id}`, 'stop', { stopped: input.stopped, reason: input.reason, revision: control.revision });
  }
  await auditStatement(env.DB, { action: input.stopped ? 'billing.platform.stopped' : 'billing.platform.resumed', resource_id: input.pool_id,
    details: { reason: input.reason, active_runtimes_retain_holds: true } }).run();
}

export async function emitBudgetAlerts(env: Pick<BillingBindings, 'DB'>, limit = 100): Promise<number> {
  env = billingEnvironment(env);
  const rows = await many<Budget & { threshold_percentages_json: string }>(env.DB, `SELECT * FROM billing_budgets WHERE account_id NOT LIKE 'capacity:%'
    AND (period_end IS NULL OR period_end>?) ORDER BY id LIMIT ?`, now(), limit);
  let emitted = 0;
  for (const budget of rows) {
    const maximum = units(budget.limit_units) - units(budget.safety_buffer_units);
    const exposure = units(budget.settled_units) + units(budget.reserved_units) + units(budget.commitment_units);
    for (const threshold of JSON.parse(budget.threshold_percentages_json) as number[]) {
      if (exposure * 100n < maximum * BigInt(threshold)) continue;
      const id = `budget-alert:${budget.id}:${threshold}`;
      const exists = await one(env.DB, 'SELECT id FROM billing_alerts WHERE id=?', id);
      if (exists) continue;
      try {
        await env.DB.batch([
          stmt(env.DB, 'INSERT INTO billing_alerts (id,account_id,budget_id,budget_revision,threshold,created_at) VALUES (?,?,?,?,?,?)',
            id, budget.account_id, budget.id, budget.revision, threshold, now()),
          eventStatement(env.DB, { id: `evt:${id}`, type: 'billing.budget.threshold', resource_id: budget.id, resource_revision: budget.revision,
            account_id: budget.account_id, data: { budget_id: budget.id, threshold, settled_units: budget.settled_units,
              reserved_units: budget.reserved_units, storage_commitment_units: budget.commitment_units } }),
        ]);
        emitted += 1;
      } catch (error) { if (!await one(env.DB, 'SELECT id FROM billing_alerts WHERE id=?', id)) throw error; }
    }
  }
  return emitted;
}

/** Bounded, cursor-persisted maintenance. Cleanup never depends on a remaining spend allowance. */
export async function sweepBilling(env: BillingBindings): Promise<{ processed: number; failed: number }> {
  env = billingEnvironment(env);
  let processed = 0, failed = 0;
  const cadence = storagePolicy(env).periodic_accrual_seconds;
  const cursor = await one<{ cursor: string }>(env.DB, 'SELECT cursor FROM billing_sweep_cursors WHERE name=?', 'storage');
  const objects = await many<{ id: string; account_id: string; state: string; body_json: string }>(env.DB, `SELECT id,account_id,state,body_json FROM billing_storage_objects
    WHERE coordinator_id LIKE 'account:%' AND state NOT IN ('deleted','transferred','transfer_pending','transferring')
      AND COALESCE(json_extract(body_json,'$.placement_shadow'),0)=0 AND json_extract(body_json,'$.placement_handoff_id') IS NULL AND id>? ORDER BY id LIMIT 64`, cursor?.cursor ?? '');
  for (const row of objects) {
    let object = JSON.parse(row.body_json) as StorageObject;
    try {
      if (object.state === 'stored') {
        if (object.source === 'standalone' && object.renew_after && object.renew_after <= now()) {
          try { object = await renewStorageCommitment(env, { account_id: object.account_id, object_id: object.id }); } catch { failed++; }
        } else {
          const through = periodicAccrualThrough(object.accrued_at, now(), cadence, object.funded_until,
            object.commitment_until, object.retention_until, object.delete_after, object.billable_until);
          if (through) object = await accrueStorage(env, { account_id: object.account_id, object_id: object.id, through });
        }
      }
      const deadline = object.delete_after ?? object.retention_until;
      if (object.state !== 'uploading' && deadline && deadline <= now()) await admissionRequest(env, `account:${object.account_id}`, 'storage-expire', { object_id: object.id });
      processed += 1;
    } catch { failed += 1; }
  }
  await env.DB.prepare(`INSERT INTO billing_sweep_cursors (name,cursor,updated_at) VALUES ('storage',?,?) ON CONFLICT(name)
    DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at WHERE billing_sweep_cursors.cursor<>excluded.cursor`).bind(objects.length === 64 ? objects.at(-1)!.id : '', now()).run();
  const gitCursor = await one<{ cursor: string }>(env.DB, "SELECT cursor FROM billing_sweep_cursors WHERE name='canonical-git'");
  const repositories = await many<{ id: string; body_json: string }>(env.DB, `SELECT id,body_json FROM billing_git_repositories
    WHERE coordinator_id LIKE 'account:%' AND json_extract(body_json,'$.state')='stored' AND id>? ORDER BY id LIMIT 32`, gitCursor?.cursor ?? '');
  for (const row of repositories) {
    const meter = JSON.parse(row.body_json) as CanonicalGitMeter;
    const input = { repo_id: meter.repo_id, storage_name: meter.storage_name };
    try {
      if (await canonicalPurgeReceipt(env, meter.repo_id, meter.storage_name)) await admissionRequest(env, `account:${meter.account_id}`, 'git-purge', input);
      else if (meter.renew_after <= now()) await admissionRequest(env, `account:${meter.account_id}`, 'git-renew', input);
      else {
        const at = now(), through = periodicAccrualThrough(meter.accrued_at, at, cadence, `${at.slice(0, 10)}T00:00:00.000Z`,
          meter.funded_until, meter.commitment_until, meter.billable_until);
        if (through) await admissionRequest(env, `account:${meter.account_id}`, 'git-accrue', { ...input, through });
      }
      processed++;
    } catch { failed++; }
  }
  await env.DB.prepare(`INSERT INTO billing_sweep_cursors(name,cursor,updated_at) VALUES ('canonical-git',?,?) ON CONFLICT(name)
    DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at WHERE billing_sweep_cursors.cursor<>excluded.cursor`).bind(repositories.length === 32 ? repositories.at(-1)!.id : '', now()).run();
  const finals = await many<{ invoice_id: string }>(env.DB, "SELECT invoice_id FROM billing_invoice_finalizations WHERE state='pending' ORDER BY invoice_id LIMIT 16");
  const placements = await many<{ operation_id: string; state: string }>(env.DB, "SELECT operation_id,state FROM billing_storage_placements WHERE state IN ('committing','active','aborting') ORDER BY operation_id LIMIT 8");
  for (const p of placements) {
    try {
      if (p.state === 'committing') await commitRepositoryStoragePlacement(env, p);
      else if (p.state === 'aborting') await abortRepositoryStoragePlacement(env, p);
      else await finalizeRepositoryStoragePlacement(env, p);
      processed++;
    } catch (error) {
      if (!(error instanceof BillingError) || error.code !== 'placement_epoch_changed') failed++;
    }
  }
  for (const final of finals) { try { await finalizeInvoiceAdmission(env, final.invoice_id); processed++; } catch { failed++; } }
  const changes = await many<{ id: string }>(env.DB, "SELECT id FROM billing_subscription_changes WHERE state='pending' ORDER BY id LIMIT 16");
  for (const change of changes) { try { await reconcileSubscriptionChange(env, change.id); processed++; } catch { failed++; } }
  const accounts = await many<{ account_id: string }>(env.DB, 'SELECT account_id FROM billing_accounts WHERE period_end<=? ORDER BY period_end,account_id LIMIT 16', now());
  for (const account of accounts) { try { await closeInvoice(env, account.account_id); processed++; } catch { failed++; } }
  await env.DB.prepare(`UPDATE billing_accounts SET state='past_due',revision=revision+1,updated_at=? WHERE state='active'
    AND EXISTS (SELECT 1 FROM billing_invoices i WHERE i.account_id=billing_accounts.account_id AND i.state='open' AND i.due_at<?)`).bind(now(), now()).run();
  await emitBudgetAlerts(env);
  if (failed) throw new BillingError('billing_maintenance_incomplete', 'Some billing maintenance remains pending for a bounded retry.', 503, { processed, failed });
  return { processed, failed };
}
