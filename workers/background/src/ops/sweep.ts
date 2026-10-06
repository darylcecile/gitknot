import { sweepExecution } from '@gitknot/execution';
import { sweepBilling } from '@gitknot/billing';
import { sweepFederationState } from '@gitknot/federation';
import { sweepLfs } from '../../../../packages/git/src/lfs.ts';
import { sweepCollaboration } from '../../../../apps/api/src/modules/collaboration.ts';
import { dispatchOperations, expireArchives, expireEventHistory, scheduleMaintenance } from '../../../../packages/operations/src/dispatch.ts';
import { dispatchOutbox, enqueueConsumers } from '../../../../packages/operations/src/durable.ts';
import { scheduleDigests, sweepEmailStatus } from '../../../../packages/operations/src/mail.ts';
import { sweepRepositoryCatalog } from '../../../../apps/api/src/modules/repositories/lifecycle.ts';
import { operationalMetrics } from '../../../../packages/operations/src/meter.ts';
import { accrueObjects, deleteExpiredObjects, recoverOperationObjects } from '../../../../packages/operations/src/objects.ts';
import { recordDiagnostic } from '../../../../packages/operations/src/private.ts';
import { enqueueDeliveries, sweepReplays } from '../../../../packages/operations/src/webhooks.ts';
import type { OperationsBindings } from '../../../../packages/operations/src/types.ts';
import { sweepStorageCleanup } from '../../../../packages/operations/src/storage-cleanup.ts';
import { isIdentityPlacement } from '../../../../packages/operations/src/ownership.ts';
import { sweepAccountExports } from '../../../../packages/operations/src/account-export.ts';

export async function sweep(env: OperationsBindings): Promise<{ succeeded: number; failed: number }> {
  const tasks: [string, () => Promise<unknown>][] = [
    ['outbox', () => dispatchOutbox(env)], ['consumers', () => enqueueConsumers(env)], ['deliveries', () => enqueueDeliveries(env)],
    ['replays', () => sweepReplays(env)], ['digests', () => scheduleDigests(env)], ['operations', () => dispatchOperations(env)],
    ['email-status', () => sweepEmailStatus(env)], ['repository-catalog', () => sweepRepositoryCatalog(env)],
    ['execution', () => sweepExecution(env)], ['collaboration', () => sweepCollaboration(env)],
    ['lfs-storage', () => sweepLfs(env, 100)],
    ['storage-accrual', () => accrueObjects(env)], ['archive-retention', () => expireArchives(env)],
    ['object-retention', () => deleteExpiredObjects(env)], ['maintenance', () => scheduleMaintenance(env)],
    ['operation-object-recovery', () => recoverOperationObjects(env)],
    ['storage-cleanup', () => sweepStorageCleanup(env)],
    ['account-exports', () => sweepAccountExports(env)],
    ['event-retention', () => expireEventHistory(env)], ['metrics', () => operationalMetrics(env)],
  ];
  if (isIdentityPlacement(env)) tasks.push(['billing', () => sweepBilling(env)],
    ['federation', () => sweepFederationState(env.DB.withSession('first-primary'), 1000)]);
  const results = await Promise.allSettled(tasks.map(([, task]) => task()));
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!;
    if (result.status === 'rejected') await recordDiagnostic(env, `sweeper:${tasks[index]![0]}`, null, result.reason);
  }
  const failed = results.filter((result) => result.status === 'rejected').length;
  return { succeeded: results.length - failed, failed };
}
