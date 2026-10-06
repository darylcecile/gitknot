import { WorkflowEntrypoint } from 'cloudflare:workers';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Sandbox } from '@cloudflare/sandbox';
import { runSdkJob } from '@gitknot/execution/hosted/sdk';
import { RemoteSdkAdapter } from './adapter.ts';
import { attemptController } from './controller.ts';
import { fenced } from './errors.ts';
import type { AttemptJournal, HostedEnv, HostedWorkflowParams } from './types.ts';

export class HostedAttemptWorkflow extends WorkflowEntrypoint<HostedEnv, HostedWorkflowParams> {
  override async run(event: WorkflowEvent<HostedWorkflowParams>, step: WorkflowStep): Promise<void> {
    const controller = attemptController(this.env, event.payload.attempt_id);
    // Private DO RPC, deliberately outside step.do: neither the grant capability
    // nor the callback token can become a Workflow checkpoint or event payload.
    const journal = JSON.parse(await controller.load(event.payload)) as AttemptJournal;
    if (journal.workflow_id !== event.instanceId) throw fenced();
    if (journal.sealed || journal.draft) { await controller.reconcile(); return; }
    const adapter = new RemoteSdkAdapter(this.env, journal.grant, journal);
    try {
      await runSdkJob(this.ctx, this.env.SANDBOX as unknown as DurableObjectNamespace<Sandbox>, adapter, event, checkpointGuard(step, () => adapter.beforeCheckpoint()));
    } catch { /* Actual exit facts and sanitized drafts, never SDK success, decide the result. */ }
    await adapter.finish();
  }
}

/** Keep the real SDK step/retry engine; fence its return before durable storage. */
export function checkpointGuard(step: WorkflowStep, persist: () => Promise<void>): WorkflowStep {
  return new Proxy(step, { get(target, property) {
    if (property === 'do') return (name: string, config: unknown, work: unknown) => {
      if (typeof work !== 'function') throw new Error('The pinned CI Workflow step contract changed.');
      return Reflect.apply(target.do, target, [name, config, async (context: unknown) => {
        let result: unknown, failed = false;
        try { result = await work(context); }
        catch { failed = true; }
        try { await persist(); }
        catch { throw new Error('GitKnot could not durably checkpoint the normalized attempt facts.'); }
        if (failed) throw new Error('GitKnot hosted execution failed; the durable attempt facts are authoritative.');
        return result;
      }]);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
