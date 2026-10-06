import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { one } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import { advanceRun, continueRunWorkflow, dispatchFairly } from '@gitknot/execution/control-plane';
import { runHostedAttempt } from '@gitknot/execution/hosted';
import { executionResourceEnvironment, primary } from '@gitknot/execution/store';
import type { RunRecord, RunWorkflowParams } from '@gitknot/execution/types';
import { executeWorkflowOperation } from '@gitknot/execution/operations';

export class RunWorkflow extends WorkflowEntrypoint<Bindings, RunWorkflowParams> {
  override async run(event: WorkflowEvent<RunWorkflowParams>, step: WorkflowStep): Promise<{ run_id: string; status: string }> {
    if (event.payload.mode === 'operation') {
      if (!event.payload.operation_id) throw new Error('The workflow operation identity is missing.');
      for (let turn = 0; turn < 400; turn++) {
        const result = await step.do(`operation-${turn}`, { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '3 minutes' }, () => executeWorkflowOperation(this.env, event.payload.operation_id!));
        if (result.status !== 'running') return result;
        await step.sleep(`operation-wait-${turn}`, '10 seconds');
      }
      return { run_id: event.payload.run_id, status: 'operation_waiting' };
    }
    if (event.payload.mode === 'attempt') {
      if (!event.payload.attempt_id) throw new Error('A hosted attempt workflow requires an immutable attempt ID.');
      await runHostedAttempt(this.ctx, await executionResourceEnvironment(this.env, event.payload.attempt_id, 'attempt'), event, step, event.payload.attempt_id);
      return { run_id: event.payload.run_id, status: 'attempt_recorded' };
    }
    for (let turn = 0; turn < 400; turn++) {
      const state = await step.do(`advance-${turn}`, { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, async () => {
        const env = await executionResourceEnvironment(this.env, event.payload.run_id, 'run');
        const result = await advanceRun(env, event.payload.run_id);
        await dispatchFairly(env);
        return result;
      });
      if (state.terminal) return { run_id: event.payload.run_id, status: state.status };
      // D1 is authoritative. Events are only wake-up hints, so missed/duplicate
      // signals and Workflows' own short history retention cannot lose run state.
      try { await step.waitForEvent(`wake-${turn}`, { type: 'execution-updated', timeout: '5 minutes' }); }
      catch (error) {
        if (!/timed?\s*out|timeout/i.test(error instanceof Error ? `${error.name} ${error.message}` : String(error))) throw error;
      }
    }
    await step.do('continue-run', { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '2 minutes' }, async () => {
      await continueRunWorkflow(this.env, event.payload.run_id, event.payload.orchestration_generation ?? 0);
    });
    return { run_id: event.payload.run_id, status: 'continued' };
  }
}
