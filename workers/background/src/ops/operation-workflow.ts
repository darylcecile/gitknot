import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { runCollaborationOperation } from '../../../../apps/api/src/modules/collaboration.ts';
import { completeOperation, failOperation, operationById, runLifecycle } from '../../../../packages/operations/src/lifecycle.ts';
import type { Stepper } from '../../../../packages/operations/src/lifecycle.ts';
import { runShardMove } from '../../../../packages/operations/src/movement.ts';
import { shardEnvironment } from '../../../../packages/operations/src/placement.ts';
import { runCodeScan } from '../../../../packages/operations/src/search.ts';
import type { OperationsBindings } from '../../../../packages/operations/src/types.ts';
import { ApiError, canonicalJson, identityBinding, one } from '@gitknot/core';
import { failAccountExport, runAccountExport } from '../../../../packages/operations/src/account-export.ts';

function lifecycleSteps(step: WorkflowStep): Stepper {
  return { async do<T>(name: string, _options: unknown, callback: () => Promise<T>): Promise<T> {
    const value = await step.do(name, { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '30 minutes' },
      async () => {
        try { return canonicalJson(await callback()); }
        catch (error) {
          if (error instanceof ApiError && error.code === 'snapshot_abandoned') throw new NonRetryableError(error.message);
          throw error;
        }
      });
    return JSON.parse(value) as T;
  } };
}

export class OperationWorkflow extends WorkflowEntrypoint<OperationsBindings, { operation_id: string; shard_id?: string; cell_id?: string }> {
  async run(event: WorkflowEvent<{ operation_id: string; shard_id?: string; cell_id?: string }>, step: WorkflowStep): Promise<unknown> {
    if (event.payload.cell_id && event.payload.cell_id !== this.env.CELL_ID) throw new Error('operation_runtime_cell_mismatch');
    const env = shardEnvironment(this.env, event.payload.shard_id ?? this.env.SHARD_ID);
    const operation = await step.do('load-operation', () => operationById(env, event.payload.operation_id));
    const movePending = operation.kind === 'repository.move' && await one(identityBinding(env), "SELECT 1 FROM repository_move_controls WHERE operation_id=? AND state NOT IN ('completed','aborted')", operation.id);
    if ((operation.status === 'completed' || operation.status === 'cancelled') && !movePending) return { id: operation.id, status: operation.status };
    try {
      let result: Record<string, unknown>;
      const scan = await step.do('select-operation', async () => !!await one(env.DB, 'SELECT id FROM collaboration_code_scans WHERE operation_id=?', operation.id));
      if (scan) result = JSON.parse(await step.do('scan-code', { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '30 minutes' }, async () => canonicalJson(await runCodeScan(env, operation)))) as Record<string, unknown>;
      else if (operation.kind === 'account.export') result = JSON.parse(await step.do('account-export', { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '30 minutes' }, async () => {
        try { return canonicalJson(await runAccountExport(env, operation)); }
        catch (error) { if (error instanceof ApiError && error.code === 'account_export_incomplete') throw new NonRetryableError(error.message); throw error; }
      })) as Record<string, unknown>;
      else if (operation.kind === 'repository.move') result = JSON.parse(await step.do('move-shard', { retries: { limit: 5, delay: '30 seconds', backoff: 'exponential' }, timeout: '30 minutes' }, async () => canonicalJson(await runShardMove(env, operation)))) as Record<string, unknown>;
      else if (operation.kind.startsWith('collaboration.')) {
        for (let pass = 0; pass < 400; pass++) {
          const current = await step.do(`collaboration-${pass}`, async () => {
            await runCollaborationOperation(env, operation.id);
            return operationById(env, operation.id);
          });
          if (current.status === 'completed' || current.status === 'cancelled') return { id: current.id, status: current.status };
          if (current.status === 'failed') throw new Error('collaboration_operation_failed');
          await step.sleep(`collaboration-wait-${pass}`, '1 minute');
        }
        throw new Error('collaboration_operation_wait_budget');
      } else result = await runLifecycle(env, operation, lifecycleSteps(step));
      if (operation.kind !== 'repository.move') await step.do('complete-operation', () => completeOperation(env, operation, result));
      return { id: operation.id, status: 'completed', ...result };
    } catch (error) {
      const current = await operationById(env, operation.id);
      if (current.status === 'cancelled') return { id: current.id, status: 'cancelled' };
      await step.do('record-operation-failure', () => operation.kind === 'account.export' ? failAccountExport(env, operation, error) : failOperation(env, operation.id, error));
      throw error;
    }
  }
}
