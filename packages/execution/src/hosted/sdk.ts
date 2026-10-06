import { CIWorkflow } from '@cloudflare/ci';
import type { CiContext, CiParams, CloudflareArtifacts } from '@cloudflare/ci';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { DirectoryBackup, Sandbox } from '@cloudflare/sandbox';
import { ApiError } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import { attemptContext, executionResourceEnvironment, primary } from '../store.ts';
import { HostedAdapter } from './adapter.ts';
import { hostedCheckpointGuard } from './checkpoint-guard.ts';
import { readLocalHostedDraft, readLocalHostedProgress } from './checkpoints.ts';
import { reconcileLocalHostedAttempt } from './reconcile.ts';

type SdkBindings = ConstructorParameters<typeof HostedSdkWorkflow>[1];
const activeAdapters = new WeakSet<object>();

/** Both deployment topologies use the same real, pinned CI pipeline boundary. */
export interface SdkJobAdapter {
  readonly sdk_contract: 'gitknot-sdk-adapter-v1';
  readonly context: {
    attempt: { id: string; repo_id: string; account_id: string; runtime_name: string | null };
    run: { commit_sha: string; source_ref: string };
  };
  readonly sandbox: Sandbox;
  source: { url: string; commit: string; token: string };
  prepareSource(): Promise<void>;
  remaining(reserve?: number): number;
  checkout(): Promise<void>;
  executeCommands(): Promise<number>;
  snapshot(): Promise<DirectoryBackup>;
  destroy(): Promise<void>;
  safeLogSummary(): string;
}

/**
 * A version-specific namespace adapter, not a replacement CI engine. The real
 * CIWorkflow -> runCiStep -> SandboxRunner still owns invocation, step retry
 * configuration, reporting and SDK snapshots. Only its unsafe boundaries are
 * intercepted. No private SDK path import or node_modules rewrite is required.
 */
function hardenedNamespace(namespace: DurableObjectNamespace<Sandbox>, adapter: SdkJobAdapter): DurableObjectNamespace<Sandbox> {
  const id = namespace.idFromName(adapter.context.attempt.runtime_name!);
  const target = namespace.get(id);
  let checkoutDone = false;
  const exec = async (command: string) => {
    if (command === 'test -c /dev/fuse') return adapter.sandbox.exec(command, { timeout: 10_000 });
    if (!checkoutDone) {
      await adapter.checkout(); checkoutDone = true;
      return { success: true, exitCode: 0, stdout: '', stderr: '', command: 'GitKnot pinned checkout', duration: 0, timestamp: new Date().toISOString() };
    }
    if (/^tail -c 28000 \/tmp\/ci-step\.(?:out|err) 2>\/dev\/null$/.test(command)) {
      return { success: true, exitCode: 0, stdout: adapter.safeLogSummary(), stderr: '', command: 'GitKnot redacted log reference', duration: 0, timestamp: new Date().toISOString() };
    }
    throw new ApiError(503, 'sdk_contract_changed', 'The pinned SDK attempted an unsupported runner operation.');
  };
  const wrapped = new Proxy(target, {
    get(value, property) {
      if (property === 'exec' || property === 'execWithSessionToken') return exec;
      if (property === 'configure') return () => adapter.sandbox.configure({ sandboxName: { name: adapter.context.attempt.runtime_name! }, transport: 'rpc',
        containerTimeouts: { instanceGetTimeoutMS: 60_000, portReadyTimeoutMS: 60_000 } });
      if (property === 'startProcess') return async () => {
        const exitCode = await adapter.executeCommands();
        return { id: adapter.context.attempt.id, status: exitCode === 0 ? 'completed' : 'failed', exitCode,
          waitForExit: async () => ({ exitCode }) };
      };
      if (property === 'createBackup') return () => adapter.snapshot();
      if (property === 'restoreBackup') return () => { throw new ApiError(503, 'sdk_contract_changed', 'Whole-workspace SDK cache restoration is not permitted.'); };
      if (property === 'listFiles') return async (path: string) => {
        if (path !== '/tmp') throw new ApiError(503, 'sdk_contract_changed', 'Unexpected SDK log listing.');
        return { files: [{ absolutePath: '/tmp/ci-step.out', size: new TextEncoder().encode(adapter.safeLogSummary()).length }, { absolutePath: '/tmp/ci-step.err', size: 0 }] };
      };
      if (property === 'readFile') return async (path: string) => {
        if (!/^\/tmp\/ci-step\.(out|err)$/.test(path)) throw new ApiError(503, 'sdk_contract_changed', 'Unexpected SDK log file.');
        return { content: path.endsWith('.out') ? adapter.safeLogSummary() : '' };
      };
      if (property === 'readFileStream') return () => { throw new ApiError(503, 'sdk_contract_changed', 'SDK log streams must be drained before checkpointing.'); };
      if (property === 'destroy') return () => adapter.destroy();
      const member = Reflect.get(value, property);
      return typeof member === 'function' ? member.bind(value) : member;
    },
  });
  return new Proxy(namespace, {
    get(value, property) {
      if (property === 'idFromName') return () => id;
      if (property === 'get' || property === 'getByName') return () => wrapped;
      const member = Reflect.get(value, property); return typeof member === 'function' ? member.bind(value) : member;
    },
  }) as unknown as DurableObjectNamespace<Sandbox>;
}

class HostedSdkWorkflow extends CIWorkflow {
  static override getProvider(): ReturnType<typeof CIWorkflow.getProvider> {
    // CI 0.2.0's public static provider signature fixes this internal discriminator.
    // The provider below exclusively returns GitKnot checkout capabilities.
    return {
      id: 'cloudflare-artifacts', repository: {},
      accepts: source => source.provider === 'cloudflare-artifacts',
      assertSource(source) { if (source.provider !== 'cloudflare-artifacts') throw new Error('Unsupported internal SDK source discriminator.'); },
      create(env) {
        const adapter = env.GITKNOT_ADAPTER as SdkJobAdapter;
        if (!adapter || adapter.sdk_contract !== 'gitknot-sdk-adapter-v1' || !activeAdapters.has(adapter)) throw new Error('The hardened SDK adapter is missing.');
        return {
          async receiveEvent() { throw new Error('Hosted jobs only accept frozen GitKnot dispatch.'); },
          async getSourceCheckout(source) {
            if (source.repo !== adapter.context.attempt.repo_id || source.owner !== adapter.context.attempt.account_id || source.sha !== adapter.context.run.commit_sha) throw new Error('SDK source identity mismatch.');
            await adapter.prepareSource();
            return { kind: 'git', remote: adapter.source.url, token: adapter.source.token, sha: adapter.source.commit };
          },
          async listTreeBlobs() { throw new Error('Whole-runner SDK caching is disabled for verification.'); },
          async getStepCredentialEnv() { throw new Error('Provider credentials are forbidden in hosted jobs.'); },
          async getPushCredentials() { throw new Error('Hosted jobs cannot obtain provider write credentials.'); },
          async createPullRequest() { throw new Error('Hosted jobs cannot publish through the SDK source provider.'); },
          async startStepNotification() { return null; },
        };
      },
    };
  }

  protected override async pipeline(_event: WorkflowEvent<CiParams<CloudflareArtifacts>>, _step: WorkflowStep, ci: CiContext): Promise<void> {
    const adapter = this.env.GITKNOT_ADAPTER as SdkJobAdapter;
    await ci.runner({ name: `job-${adapter.context.attempt.id}`, command: 'gitknot-hosted-verified-job',
      config: { retries: { limit: 0, delay: 1000, backoff: 'constant' }, timeout: adapter.remaining(), commandTimeoutMs: Math.max(1, adapter.remaining() - 15_000), snapshotRetentionSeconds: 3600 },
      cloudflareCredentials: false, sourceControlCredentials: false,
    });
  }
}

export type HostedWorkflowContext = ConstructorParameters<typeof HostedSdkWorkflow>[0];

export async function runSdkJob(ctx: HostedWorkflowContext, namespace: DurableObjectNamespace<Sandbox>, adapter: SdkJobAdapter, event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
  activeAdapters.add(adapter);
  try {
    const sdkEnv = { SANDBOX: hardenedNamespace(namespace, adapter), GITKNOT_ADAPTER: adapter } as unknown as SdkBindings;
    await new HostedSdkWorkflow(ctx, sdkEnv).run({ ...event, payload: {
      provider: 'cloudflare-artifacts', providerData: { namespace: 'gitknot' }, event: { type: 'push' }, trigger: 'push',
      owner: adapter.context.attempt.account_id, repo: adapter.context.attempt.repo_id, sha: adapter.context.run.commit_sha, ref: adapter.context.run.source_ref,
    } }, step);
  } finally { activeAdapters.delete(adapter); }
}

export async function runHostedAttempt(ctx: HostedWorkflowContext, env: Bindings, event: WorkflowEvent<unknown>, step: WorkflowStep, attemptId: string): Promise<void> {
  env = await executionResourceEnvironment(env, attemptId, 'attempt');
  const context = await attemptContext(primary(env), attemptId);
  if (context.attempt.execution_backend === 'remote' || context.attempt.executor !== 'hosted') throw new ApiError(409, 'executor_mismatch', 'This Workflow owns same-account hosted execution only.');
  const input = { attempt_id: attemptId, generation: context.attempt.generation };
  if (context.attempt.execution_started_at || await readLocalHostedDraft(env, attemptId, input.generation) || await readLocalHostedProgress(env, input)) {
    await reconcileLocalHostedAttempt(env, attemptId, input.generation);
    return;
  }
  const adapter = new HostedAdapter(env, context);
  try {
    await runSdkJob(ctx, env.SANDBOX as DurableObjectNamespace<Sandbox>, adapter, event, hostedCheckpointGuard(step, () => adapter.beforeCheckpoint()));
  } catch { /* The adapter records the actual job/infra outcome and complete redacted logs. */ }
  await adapter.finish();
  // Job failure was durably recorded. The orchestration step can finish normally;
  // its result is never interpreted as a passed job by the DAG controller.
}
