import type { DirectoryBackup, Process, Sandbox } from '@cloudflare/sandbox';
import { ApiError, now } from '@gitknot/core';
import { fingerprintToolchain } from '@gitknot/workflows';
import type { SdkJobAdapter } from '@gitknot/execution/hosted/sdk';
import type { RemoteAttemptGrant, RemoteBeginResult, RemoteInput, RemoteStoredObject } from '@gitknot/execution/remote/protocol';
import type { PlanStep } from '@gitknot/execution/types';
import { exactCheckoutScript } from '@gitknot/execution/checkout';
import { CONTROL_DIR } from '@gitknot/execution/hosted/scripts';
import { RemoteArtifacts } from './artifacts.ts';
import { RemoteDependencyCache } from './cache.ts';
import { RemoteCallbacks } from './callback.ts';
import { attemptController, runtimeIdentity } from './controller.ts';
import { bounded, fenced } from './errors.ts';
import { hardenJobHostScript, jobSupervisorScript, launchStepScript, verifyExactSourceScript } from './job-scripts.ts';
import { RemoteLogs } from './logs.ts';
import type { HostedSandbox } from './sandbox.ts';
import { LIMITS } from './types.ts';
import type { AttemptJournal, CompletionDraft, HostedEnv, HostedWorkflowParams, RuntimeIdentity } from './types.ts';
import { requireProfile } from './validation.ts';

interface ProcessResult {
  exit_code: number | null;
  signal: string | null;
  reason: 'deadline' | 'lease' | 'cancelled' | 'quota' | 'infrastructure' | null;
  resource_exhaustion: CompletionDraft['resource_exhaustion'];
  process_group_stopped: boolean;
  started_at: string;
  finished_at: string;
  log_bytes: number;
}

/** All real SDK calls run from the CI Workflow; only normalized facts escape. */
export class RemoteSdkAdapter implements SdkJobAdapter {
  readonly sdk_contract = 'gitknot-sdk-adapter-v1' as const;
  readonly context: SdkJobAdapter['context'];
  readonly sandbox: Sandbox;
  readonly identity: RuntimeIdentity;
  readonly params: HostedWorkflowParams;
  readonly logs: RemoteLogs;
  source = { url: '', commit: '', token: '' };
  private readonly runtime: DurableObjectStub<HostedSandbox>;
  private readonly callbacks: RemoteCallbacks;
  private readonly artifacts: RemoteArtifacts;
  private readonly cache: RemoteDependencyCache;
  private readonly protectedValues: string[] = [];
  private declaredInputs: RemoteInput[] = [];
  private lease: string;
  private owner = false;
  private armed = false;
  private checkedOut = false;
  private activeStep: number | null = null;
  private conclusion: CompletionDraft['conclusion'] = 'infrastructure_failed';
  private exitCode: number | null = null;
  private signal: CompletionDraft['signal'] = null;
  private resource: CompletionDraft['resource_exhaustion'] = null;
  private processStopped = false;
  private rawLogBytes = 0;
  private startedAt: string;
  private finishedAt: string | null = null;
  private logManifest: RemoteStoredObject | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatWork: Promise<void> | null = null;
  private heartbeatError: unknown = null;
  private heartbeatsStopped = false;
  private draftSaved = false;

  constructor(private readonly env: HostedEnv, readonly grant: RemoteAttemptGrant, journal: AttemptJournal) {
    requireProfile(env, grant);
    this.context = { attempt: { id: grant.attempt_id, repo_id: grant.repo_id, account_id: grant.account_id, runtime_name: grant.runtime_name },
      run: { commit_sha: grant.commit_sha, source_ref: grant.source_ref } };
    this.params = { attempt_id: grant.attempt_id, generation: grant.generation, grant_digest: journal.grant_digest };
    this.identity = runtimeIdentity(env, grant, journal.grant_digest);
    this.runtime = env.SANDBOX.get(env.SANDBOX.idFromName(grant.runtime_name));
    this.sandbox = this.runtime as unknown as Sandbox;
    this.callbacks = new RemoteCallbacks(env, grant);
    this.lease = journal.lease_expires_at; this.startedAt = journal.started_at ?? journal.accepted_at;
    this.logs = new RemoteLogs(env, this.params, this.sandbox, this.protectedValues, grant.job.limits?.log_bytes ?? LIMITS.log_bytes);
    this.artifacts = new RemoteArtifacts(env, this.params, grant, this.sandbox, this.callbacks, this.protectedValues, this.remaining.bind(this));
    this.cache = new RemoteDependencyCache(env, this.params, grant, this.sandbox, this.runtime, this.callbacks, this.protectedValues, this.remaining.bind(this));
  }

  remaining(reserve = 0): number {
    if (this.heartbeatError) throw this.heartbeatError instanceof ApiError ? this.heartbeatError : fenced();
    const remaining = Date.parse(this.grant.deadline_at) - Date.now() - reserve;
    if (remaining <= 0) throw new ApiError(504, 'job_deadline', 'The absolute hosted job deadline expired.');
    return Math.min(remaining, this.grant.job.timeout_ms);
  }

  async prepareSource(): Promise<void> {
    if (this.owner || !await attemptController(this.env, this.grant.attempt_id).claim(this.params)) throw fenced();
    this.owner = true; this.startedAt = now();
    // No retry after an ambiguous begin. The durable claim is already consumed.
    const begin = await this.callbacks.json<RemoteBeginResult>('begin');
    if (begin.execute !== true || !begin.source || !begin.lease_expires_at) throw fenced();
    const url = new URL(begin.source.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || begin.source.commit !== this.grant.commit_sha
      || !begin.source.token.startsWith('gkt_') || begin.source.token.length < 32 || begin.source.token.length > 4096) {
      throw new ApiError(409, 'checkout_capability_invalid', 'The control plane did not return an exact GitKnot checkout capability.');
    }
    this.source = { url: url.href, commit: begin.source.commit, token: begin.source.token };
    this.protectedValues.push(this.source.token);
    this.declaredInputs = begin.inputs ?? [];
    await attemptController(this.env, this.grant.attempt_id).renew(this.params, begin.lease_expires_at);
    this.lease = begin.lease_expires_at;
    await this.runtime.arm({ ...this.identity, lease_expires_at: this.lease, egress: this.grant.job.egress,
      cache_bytes: this.grant.job.limits?.cache_bytes ?? LIMITS.cache_bytes, source_url: this.source.url });
    this.armed = true;
    await this.sandbox.configure({ sandboxName: { name: this.grant.runtime_name }, transport: 'rpc', keepAlive: true,
      containerTimeouts: { instanceGetTimeoutMS: 60_000, portReadyTimeoutMS: 60_000 } });
    this.scheduleHeartbeat();
  }

  async checkout(): Promise<void> {
    if (this.checkedOut) throw fenced();
    try {
      const result = await bounded(this.sandbox.exec(exactCheckoutScript(this.source), { cwd: '/',
        timeout: Math.min(120_000, this.remaining(45_000)), env: { GITKNOT_SOURCE_TOKEN: this.source.token } }), this.remaining(30_000));
      if (!result.success) {
        await this.logs.message(`${result.stdout}\n${result.stderr}`);
        throw new ApiError(503, 'checkout_failed', 'The exact source commit could not be checked out.');
      }
      await this.runtime.checkoutComplete();
      await attemptController(this.env, this.grant.attempt_id).publish(this.params, 'checkout-complete', 'source:revoked', {});
      this.source = { ...this.source, token: '' };
      await this.verifyToolchain();
      const hardened = await this.sandbox.exec(hardenJobHostScript, { cwd: '/', timeout: 15_000 });
      if (!hardened.success) throw new ApiError(503, 'hosted_isolation_unavailable', 'The image could not install the required job isolation controls.');
      await this.sandbox.writeFile(`${CONTROL_DIR}/supervisor.cjs`, jobSupervisorScript, { sessionId: '__DISABLE_SESSION__' });
      await this.sandbox.writeFile(`${CONTROL_DIR}/lease.json`, JSON.stringify({ lease_expires_at: this.lease, deadline_at: this.grant.deadline_at }), { sessionId: '__DISABLE_SESSION__' });
      const protectedFiles = await this.sandbox.exec(`chmod 600 ${CONTROL_DIR}/supervisor.cjs ${CONTROL_DIR}/lease.json`, { timeout: 5000 });
      if (!protectedFiles.success) throw new ApiError(503, 'hosted_isolation_unavailable', 'The root execution supervisor could not be protected.');
      await this.runtime.enableLeaseFile(this.identity);
      await this.cache.restore(this.declaredInputs);
      await this.artifacts.restoreInputs(this.declaredInputs);
      const exact = await this.sandbox.exec(verifyExactSourceScript(this.grant.commit_sha), { timeout: 10_000 });
      if (!exact.success) throw new ApiError(409, 'source_mismatch', 'The prepared workspace differs from the frozen source.');
      this.checkedOut = true;
    } catch (error) {
      this.capture(error);
      throw new ApiError(503, 'hosted_preparation_failed', 'The hosted executor could not safely prepare the frozen job.');
    }
  }

  private async verifyToolchain(): Promise<void> {
    const result = await this.sandbox.exec('cat /opt/gitknot/toolchain.json', { timeout: 5000 });
    let marker: { os?: string; arch?: string; sandbox_version?: string; tools?: Record<string, string> };
    try { marker = JSON.parse(result.stdout); } catch { throw new ApiError(409, 'toolchain_mismatch', 'The image toolchain descriptor is unavailable.'); }
    if (!result.success || marker.os !== 'linux' || marker.arch !== 'x64' || marker.sandbox_version !== '0.12.1' || !marker.tools
      || await fingerprintToolchain({ os: 'linux', arch: 'x64', tools: marker.tools, image: this.grant.toolchain.image }) !== this.grant.job.toolchain.digest) {
      throw new ApiError(409, 'toolchain_mismatch', 'The runtime does not match its pinned toolchain.');
    }
    for (const [name, version] of Object.entries(this.grant.toolchain.tools)) {
      const actual = await this.sandbox.exec(`env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp ${name} --version`, { timeout: 10_000 });
      const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!actual.success || !new RegExp(`(?:^|[^0-9A-Za-z])v?${escaped}(?:$|[^0-9A-Za-z.])`).test(`${actual.stdout}\n${actual.stderr}`)) {
        throw new ApiError(409, 'toolchain_mismatch', 'An installed tool does not match the pinned version.');
      }
    }
  }

  async executeCommands(): Promise<number> {
    try {
      if (!this.checkedOut) throw fenced();
      for (let index = 0; index < this.grant.job.steps.length; index++) {
        const step = this.grant.job.steps[index]!;
        this.activeStep = index;
        this.exitCode = null; this.signal = null;
        await this.heartbeat();
        const { env, expires } = await this.stepEnvironment(step);
        await this.sandbox.writeFile(`${CONTROL_DIR}/step-${index}.sh`, `set -eu\n${step.run}\n`, { sessionId: '__DISABLE_SESSION__' });
        await this.sandbox.writeFile(`${CONTROL_DIR}/step-${index}.json`, JSON.stringify({ env, shell: step.shell, working_directory: step.working_directory,
          deadline: Date.parse(this.grant.deadline_at), step_deadline: Math.min(expires, Date.now() + Math.min(step.timeout_ms, this.remaining(45_000))),
          log_bytes: Math.max(0, (this.grant.job.limits?.log_bytes ?? LIMITS.log_bytes) - this.rawLogBytes) }), { sessionId: '__DISABLE_SESSION__' });
        const permissions = await this.sandbox.exec(`chmod 444 ${CONTROL_DIR}/step-${index}.sh && chmod 600 ${CONTROL_DIR}/step-${index}.json`, { timeout: 5000 });
        if (!permissions.success) throw new ApiError(503, 'step_start_failed', 'The step launcher could not be protected.');
        this.processStopped = false;
        const process = await bounded(this.sandbox.startProcess(launchStepScript(index), { cwd: '/', env: {},
          processId: `${this.grant.attempt_id}-step-${index}`, autoCleanup: false }), Math.min(60_000, this.remaining(30_000)));
        await attemptController(this.env, this.grant.attempt_id).publish(this.params, 'process', `process:${index}`, { process_id: process.id });
        const result = await this.waitForProcess(process, index);
        this.exitCode = result.exit_code; this.signal = result.signal;
        this.resource = result.resource_exhaustion; this.rawLogBytes += result.log_bytes;
        this.processStopped = result.process_group_stopped && await this.runtime.stopJobProcesses();
        if (!this.processStopped) throw new ApiError(503, 'process_stop_unconfirmed', 'The job process group did not stop.');
        await this.drain(index, true); this.activeStep = null;
        this.conclusion = processConclusion(result);
        if (this.conclusion !== 'succeeded') break;
        await this.artifacts.collectStep(step);
      }
      if (await this.artifacts.collectJob(this.conclusion !== 'succeeded')) this.conclusion = 'failed';
    } catch (error) {
      this.capture(error);
      if (this.armed) {
        try { this.processStopped = await this.runtime.stopJobProcesses(); } catch { this.processStopped = false; }
        if (this.activeStep !== null && this.processStopped) {
          try { await this.drain(this.activeStep, true); } catch (logError) { this.capture(logError); }
        }
      }
      if (!this.logs.exceeded) {
        try { await this.logs.message(`GitKnot: ${this.conclusion === 'infrastructure_failed' ? 'Executor infrastructure failed.' : 'Job verification failed.'}\n`); }
        catch { /* Already-journaled failure chunks are replayed by the outbox. */ }
      }
    }
    this.finishedAt = now();
    try { this.logManifest = await attemptController(this.env, this.grant.attempt_id).publishObject(this.params, 'log-manifest', 'manifest:logs', {}); }
    catch { this.conclusion = 'infrastructure_failed'; }
    return this.conclusion === 'succeeded' ? 0 : this.exitCode || 1;
  }

  private async stepEnvironment(step: PlanStep): Promise<{ env: Record<string, string>; expires: number }> {
    const names = [...new Set(step.secrets.map(secret => secret.name))];
    let secrets: Record<string, string> = {}, expires = Date.parse(this.grant.deadline_at);
    if (names.length) {
      const resolved = await this.callbacks.json<{ values: Record<string, string>; expires_at: string }>('secrets', { step_id: step.secret_step_id ?? step.id, names });
      if (!resolved.values || Object.keys(resolved.values).length !== names.length || names.some(name => typeof resolved.values[name] !== 'string')
        || !Number.isFinite(Date.parse(resolved.expires_at)) || Date.parse(resolved.expires_at) <= Date.now()) throw new ApiError(403, 'secret_unavailable', 'A declared secret is unavailable or expired.');
      secrets = Object.fromEntries(names.map(name => [name, resolved.values[name]!]));
      expires = Math.min(expires, Date.parse(resolved.expires_at));
      for (const value of Object.values(secrets)) {
        if (Buffer.byteLength(value) > 16384) throw new ApiError(422, 'secret_too_large', 'A declared secret exceeds the redaction limit.');
        if (!this.protectedValues.includes(value)) this.protectedValues.push(value);
      }
    }
    const env = { ...step.env };
    for (const [name, value] of Object.entries(step.values ?? {})) env[name] = this.resolveValue(value, secrets);
    if (Object.values(env).some(value => value.includes('\0')) || Object.entries(env).reduce((total, [key, value]) => total + Buffer.byteLength(key) + Buffer.byteLength(value) + 2, 0) > 131072) {
      throw new ApiError(422, 'environment_limit', 'The step environment exceeds the process limit.');
    }
    return { env, expires };
  }

  private resolveValue(value: unknown, secrets: Record<string, string>): string {
    if (value === null || typeof value !== 'object') return String(value);
    const reference = value as Record<string, unknown>;
    if ('literal' in reference) return JSON.stringify(reference.literal);
    if (typeof reference.secret === 'string' && Object.hasOwn(secrets, reference.secret)) return secrets[reference.secret]!;
    if (typeof reference.output === 'string') {
      const output = this.artifacts.inputs.get(reference.output) ?? this.artifacts.stepOutputs.get(reference.output);
      if (output !== undefined) return output;
    }
    throw new ApiError(409, 'input_unavailable', 'The step references an unavailable declared value.');
  }

  private async waitForProcess(process: Process, index: number): Promise<ProcessResult> {
    for (;;) {
      this.remaining(10_000);
      if (Date.parse(this.lease) <= Date.now()) throw fenced();
      await this.drain(index);
      const actual = await bounded(this.sandbox.getProcess(process.id, '__DISABLE_SESSION__'), 10_000);
      if (!actual) throw new ApiError(503, 'process_exit_unconfirmed', 'The SDK process is no longer observable.');
      if (!['starting', 'running'].includes(actual.status)) {
        const result = await this.sandbox.readFile(`${CONTROL_DIR}/step-${index}.result.json`, { encoding: 'utf-8', sessionId: '__DISABLE_SESSION__' });
        return parseProcessResult(result.content);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  private async drain(index: number, final = false): Promise<void> {
    await this.logs.read(`${CONTROL_DIR}/step-${index}.out`, final);
    await this.logs.read(`${CONTROL_DIR}/step-${index}.err`, final);
  }

  private async heartbeat(): Promise<void> {
    if (!this.armed || this.heartbeatsStopped) return;
    if (this.heartbeatError) throw this.heartbeatError instanceof ApiError ? this.heartbeatError : fenced();
    const facts = await this.runtime.runtimeStatus(this.identity);
    if (facts.egress_exhausted) throw new ApiError(429, 'egress_quota_exceeded', 'The attempt exhausted its egress quota.');
    if (facts.sealed) throw fenced();
    const response = await this.callbacks.json<{ status: string; lease_expires_at?: string }>('heartbeat', { egress_bytes: facts.egress_bytes, egress_requests: facts.egress_requests });
    if (!['active', 'running', 'leased'].includes(response.status) || !response.lease_expires_at) throw fenced();
    await attemptController(this.env, this.grant.attempt_id).renew(this.params, response.lease_expires_at);
    await this.runtime.renewLease(this.identity, response.lease_expires_at);
    if (Date.parse(response.lease_expires_at) > Date.parse(this.lease)) this.lease = response.lease_expires_at;
  }

  private scheduleHeartbeat(): void {
    if (this.heartbeatsStopped) return;
    this.heartbeatTimer = setTimeout(() => {
      const work = this.heartbeat().catch(async error => {
        this.heartbeatError = error;
        // An observed revocation closes the runtime immediately. A mere network
        // failure cannot extend authority; the absolute lease watchdog also fires.
        if (error instanceof ApiError && ['attempt_fenced', 'egress_quota_exceeded'].includes(error.code)) {
          try { await this.runtime.sealAndDestroy(this.identity); } catch { /* Reaper retains uncertain cleanup. */ }
        }
      }).finally(() => { this.heartbeatWork = null; if (!this.heartbeatError) this.scheduleHeartbeat(); });
      this.heartbeatWork = work;
    }, LIMITS.heartbeat_ms);
  }

  private async stopHeartbeats(): Promise<void> {
    this.heartbeatsStopped = true;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.heartbeatWork) await this.heartbeatWork;
  }

  async snapshot(): Promise<DirectoryBackup> {
    try { return await this.cache.snapshot(); }
    catch (error) { this.capture(error); throw new ApiError(503, 'hosted_snapshot_failed', 'The sanitized SDK snapshot could not be retained.'); }
  }

  safeLogSummary(): string {
    return this.logManifest ? `Full redacted logs: ${this.logManifest.id} (sha256:${this.logManifest.sha256})\n` : 'Full redacted logs are being reconciled by GitKnot.\n';
  }

  /** Runs from SDK finally BEFORE it can return/checkpoint a runner result. */
  async destroy(): Promise<void> {
    await this.stopHeartbeats();
    await this.persistDraft();
    try { await attemptController(this.env, this.grant.attempt_id).checkpoint(this.params); }
    catch { /* The local draft/outbox is durable; cleanup cannot depend on CP availability. */ }
    await attemptController(this.env, this.grant.attempt_id).reconcile();
  }

  async finish(): Promise<void> {
    await this.stopHeartbeats();
    if (this.owner) await this.persistDraft();
    await attemptController(this.env, this.grant.attempt_id).reconcile();
  }

  /** CI swallows destroy() errors; this second gate is outside that SDK catch. */
  async beforeCheckpoint(): Promise<void> {
    await this.stopHeartbeats();
    if (this.owner) await this.persistDraft();
  }

  private async persistDraft(): Promise<void> {
    if (this.draftSaved || !this.owner) return;
    const draft: CompletionDraft = { attempt_id: this.grant.attempt_id, generation: this.grant.generation, plan_digest: this.grant.plan_digest,
      runner_id: this.grant.producer_id, conclusion: this.conclusion, exit_code: this.exitCode, signal: this.signal,
      resource_exhaustion: this.resource, toolchain_digest: this.grant.job.toolchain.digest, outputs: this.artifacts.outputs,
      log_manifest_digest: this.logManifest?.sha256 ?? null, process_group_stopped: this.processStopped,
      started_at: this.startedAt, finished_at: this.finishedAt ?? now() };
    await attemptController(this.env, this.grant.attempt_id).saveDraft(this.params, draft);
    this.draftSaved = true;
  }

  private capture(error: unknown): void {
    if (this.activeStep !== null && this.exitCode === null) this.signal = 'UNKNOWN';
    if (!(error instanceof ApiError)) { this.conclusion = 'infrastructure_failed'; return; }
    if (error.code === 'job_deadline') this.conclusion = 'timed_out';
    else if (error.code === 'attempt_fenced') this.conclusion = 'cancelled';
    else this.conclusion = error.status >= 500 ? 'infrastructure_failed' : 'failed';
    if (error.code.includes('log_quota')) this.resource = 'logs';
    if (error.code.includes('output_quota') || error.code.includes('snapshot_quota') || error.code === 'output_limit') this.resource = 'outputs';
    if (error.code.includes('egress_quota')) this.resource = 'egress';
  }
}

function processConclusion(result: ProcessResult): CompletionDraft['conclusion'] {
  if (result.reason === 'deadline') return 'timed_out';
  if (result.reason === 'cancelled') return 'cancelled';
  if (result.reason === 'infrastructure' || result.reason === 'lease' || !result.process_group_stopped) return 'infrastructure_failed';
  return result.exit_code === 0 && !result.signal && !result.resource_exhaustion && !result.reason ? 'succeeded' : 'failed';
}

function parseProcessResult(text: string): ProcessResult {
  let result: ProcessResult;
  try { result = JSON.parse(text) as ProcessResult; } catch { throw new ApiError(503, 'process_exit_unconfirmed', 'The root process supervisor did not record an exit.'); }
  if (!(result.exit_code === null || Number.isInteger(result.exit_code) && result.exit_code >= 0 && result.exit_code <= 255)
    || !(result.signal === null || /^SIG[A-Z0-9]+$/.test(result.signal)) || ![null, 'deadline', 'lease', 'cancelled', 'quota', 'infrastructure'].includes(result.reason)
    || ![null, 'memory', 'disk', 'processes', 'logs', 'outputs', 'egress'].includes(result.resource_exhaustion)
    || typeof result.process_group_stopped !== 'boolean' || !Number.isFinite(Date.parse(result.started_at)) || !Number.isFinite(Date.parse(result.finished_at))
    || !Number.isSafeInteger(result.log_bytes) || result.log_bytes < 0) throw new ApiError(503, 'process_exit_unconfirmed', 'The root process supervisor returned invalid exit facts.');
  return { ...result, signal: result.exit_code === null && !result.signal ? 'UNKNOWN' : result.signal };
}
