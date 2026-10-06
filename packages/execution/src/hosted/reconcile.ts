import { ApiError } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import { completeObjectManifest } from '../objects.ts';
import { attemptRequest, bounded } from '../transport.ts';
import { EXECUTION_LIMITS } from '../config.ts';
import { TERMINAL_ATTEMPTS } from '../state.ts';
import { finalizeLocalHostedDraft, readLocalHostedDraft, readLocalHostedProgress } from './checkpoints.ts';
import { flushHostedLogs } from './logs.ts';
import { localAttemptEnvironment } from './local-runtime.ts';
import type { LocalSandboxControl } from './local-runtime.ts';

/** Attach/reap only. This path cannot create a Sandbox handle that executes code. */
export async function reconcileLocalHostedAttempt(env: Bindings, attemptId: string, generation: number): Promise<void> {
  const input = { attempt_id: attemptId, generation }, selected = await localAttemptEnvironment(env, input), a = selected.context.attempt;
  const namespace = selected.env.SANDBOX as DurableObjectNamespace;
  const runtime = namespace.get(namespace.idFromName(a.runtime_name!)) as unknown as LocalSandboxControl;
  const proof = await bounded(runtime.destroyAndVerify(input), EXECUTION_LIMITS.cleanup_ms, 'Hosted destruction has not been verified.');
  await attemptRequest(selected.env, attemptId, 'destroyed', proof);
  let receipt = await readLocalHostedDraft(selected.env, attemptId, generation);
  if (!receipt) {
    const draft = await readLocalHostedProgress(selected.env, input);
    if (!draft) {
      if (!TERMINAL_ATTEMPTS.has(a.status)) await attemptRequest(selected.env, attemptId, 'cancel', {
        reason: 'The prior hosted execution has no durable completion draft.', outcome: 'infrastructure_failed',
      });
      return;
    }
    const identity = { attempt_id: a.id, generation: a.generation, plan_digest: a.plan_digest, runner_id: a.producer_id };
    await flushHostedLogs(selected.env, identity);
    const digest = draft.log_manifest_digest ?? (await completeObjectManifest(selected.env, identity, 'logs', 'logs')).sha256;
    receipt = await finalizeLocalHostedDraft(selected.env, input, digest);
  }
  if (!receipt) throw new ApiError(503, 'hosted_draft_incomplete', 'The durable hosted result is still being reconciled.');
  await attemptRequest(selected.env, attemptId, 'hosted-complete', receipt);
}
