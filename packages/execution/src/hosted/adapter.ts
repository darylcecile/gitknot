import { createHash } from 'node:crypto';
import { streamFile } from '@cloudflare/sandbox';
import type { DirectoryBackup, Sandbox, Process } from '@cloudflare/sandbox';
import { resolveAttemptSecrets } from '@gitknot/secrets';
import { fingerprintToolchain } from '@gitknot/workflows';
import { ApiError, execute, now, one, readBounded, sha256 } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import { checkoutCapability, exactCheckoutScript, revokeCheckout, shellQuote } from '../checkout.ts';
import type { CheckoutCapability } from '../checkout.ts';
import { EXECUTION_LIMITS, requireHostedProfile } from '../config.ts';
import { completeObjectManifest, putObjectBytes, streamManifest } from '../objects.ts';
import { redactText, secretVariants } from '../redaction.ts';
import { reportFailed } from '../reports.ts';
import { primary } from '../store.ts';
import { attemptRequest, bounded } from '../transport.ts';
import type { AttemptContext, AttemptIdentity, CompletionReceipt, ExecutionObject, JobRecord, PlanStep } from '../types.ts';
import { HostedLogs, flushHostedLogs } from './logs.ts';
import { withEnvironmentSecrets } from '../environments.ts';
import { collectOutputScript, restoreInputScript } from './output-script.ts';
import { CONTROL_DIR, SNAPSHOT_DIR, dependencyRestoreScript, dependencySnapshotScript } from './scripts.ts';
import { hardenJobHostScript, jobSupervisorScript, launchStepScript, parseHostedProcessResult, hostedProcessConclusion, verifyExactSourceScript } from './job-scripts.ts';
import type { HostedProcessResult } from './job-scripts.ts';
import { claimLocalHostedAttempt, finalizeLocalHostedDraft, persistLocalHostedDraft } from './checkpoints.ts';
import { localAttemptEnvironment, localFenced } from './local-runtime.ts';
import type { LocalSandboxControl } from './local-runtime.ts';
import { reconcileLocalHostedAttempt } from './reconcile.ts';

export class HostedAdapter {
  readonly sdk_contract = 'gitknot-sdk-adapter-v1' as const;
  readonly sandbox: Sandbox;
  readonly identity: AttemptIdentity;
  readonly logs: HostedLogs;
  source!: CheckoutCapability;
  env: Bindings;
  context: AttemptContext;
  private readonly runtime: LocalSandboxControl;
  private readonly claimId = crypto.randomUUID();
  private owner = false;
  private activated = false;
  private processStopped = false;
  private lease: string;
  private finishedAt: string | null = null;
  private draftSaved = false;
  private rawLogBytes = 0;
  private inputBytes = 0;
  private outputBytes = 0;
  private secretExpires = Infinity;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatWork: Promise<void> | null = null;
  private heartbeatError: unknown = null;
  private heartbeatsStopped = false;
  private readonly protectedValues: string[] = [];
  private readonly inputs = new Map<string, string>();
  private readonly stepOutputs = new Map<string, string>();
  private cacheKey: string | null = null;
  private checkedOut = false;
  private exitCode: number | null = null;
  private conclusion: CompletionReceipt['conclusion'] = 'infrastructure_failed';
  private signal: string | null = null;
  private resource: CompletionReceipt['resource_exhaustion'] = null;
  private readonly outputs: CompletionReceipt['outputs'] = [];
  private logManifest: ExecutionObject | null = null;
  private destroyed = false;
  private activeStep: number | null = null;

  constructor(env: Bindings, context: AttemptContext) {
    this.env = env; this.context = context; this.lease = context.attempt.lease_expires_at!;
    requireHostedProfile(env, context.job);
    if (!context.attempt.runtime_name || !context.attempt.runtime_id) throw new Error('Hosted allocation identity is missing.');
    const namespace = env.SANDBOX as DurableObjectNamespace;
    const stub = namespace.get(namespace.idFromName(context.attempt.runtime_name));
    this.sandbox = stub as unknown as Sandbox; this.runtime = stub as unknown as LocalSandboxControl;
    this.identity = { attempt_id: context.attempt.id, generation: context.attempt.generation, plan_digest: context.attempt.plan_digest, runner_id: context.attempt.producer_id };
    this.logs = new HostedLogs(env, this.identity, this.sandbox, context.job.limits?.log_bytes ?? EXECUTION_LIMITS.log_bytes);
  }

  remaining(reserve = 0): number {
    if (this.heartbeatError) throw this.heartbeatError instanceof ApiError ? this.heartbeatError : localFenced();
    const value = Date.parse(this.context.attempt.deadline_at!) - Date.now() - reserve;
    if (value <= 0) throw new ApiError(504, 'job_deadline', 'The whole-job deadline expired.');
    return Math.min(value, this.context.job.timeout_ms);
  }

  async prepare(): Promise<void> {
    await this.prepareSource();
  }

  async prepareSource(): Promise<void> {
    if (this.owner || !await claimLocalHostedAttempt(this.env, this.identity, this.claimId)) throw localFenced();
    this.owner = true;
    const begun = await attemptRequest<{ execute: boolean }>(this.env, this.context.attempt.id, 'begin-hosted', {});
    if (!begun.execute) throw localFenced();
    await this.refreshContext();
    this.source = await checkoutCapability(this.env, this.context);
    this.protectedValues.push(this.source.token);
    const activated = await this.runtime.activate(this.identity, this.source.url);
    this.activated = true; this.lease = activated.lease_expires_at;
    await this.sandbox.configure({ sandboxName: { name: this.context.attempt.runtime_name! }, transport: 'rpc', keepAlive: true,
      containerTimeouts: { instanceGetTimeoutMS: 60_000, portReadyTimeoutMS: 60_000 } });
    this.scheduleHeartbeat();
  }

  async checkout(): Promise<void> {
    try { await this.prepareWorkspace(); }
    catch (error) { this.capture(error); throw new ApiError(503, 'hosted_preparation_failed', 'The frozen job could not be safely prepared.'); }
  }

  private async prepareWorkspace(): Promise<void> {
    if (this.checkedOut) throw new Error('The SDK attempted a second checkout for one allocation.');
    const result = await bounded(this.sandbox.exec(exactCheckoutScript(this.source), {
      cwd: '/', timeout: Math.min(120_000, this.remaining(45_000)), env: { GITKNOT_SOURCE_TOKEN: this.source.token },
    }), Math.min(130_000, this.remaining(30_000)), 'Pinned checkout timed out.');
    if (!result.success) {
      await this.logs.message(redactText(`${result.stdout}\n${result.stderr}`, this.protectedValues));
      throw new ApiError(503, 'checkout_failed', 'The exact GitKnot source commit could not be checked out.');
    }
    await revokeCheckout(this.env, this.context.attempt.id);
    await this.runtime.checkoutComplete(this.identity);
    this.source = { ...this.source, token: '' };
    await this.verifyToolchain();
    const isolation = await this.sandbox.exec(hardenJobHostScript, { cwd: '/', timeout: 15_000 });
    if (!isolation.success) throw new ApiError(503, 'hosted_isolation_unavailable', 'The image could not install its required kernel job boundaries.');
    await this.sandbox.writeFile(`${CONTROL_DIR}/supervisor.cjs`, jobSupervisorScript);
    await this.sandbox.writeFile(`${CONTROL_DIR}/lease.json`, JSON.stringify({ deadline_at: this.context.attempt.deadline_at, lease_expires_at: this.lease }));
    const protectedFiles = await this.sandbox.exec(`chmod 600 ${CONTROL_DIR}/supervisor.cjs ${CONTROL_DIR}/lease.json`, { timeout: 5000 });
    if (!protectedFiles.success) throw new ApiError(503, 'hosted_isolation_unavailable', 'The root supervisor files could not be protected.');
    await this.runtime.enableLeaseFile(this.identity);
    await this.restoreDependencies();
    await this.restoreInputs();
    const exact = await this.sandbox.exec(verifyExactSourceScript(this.context.run.commit_sha), { timeout: 10_000 });
    if (!exact.success) throw new ApiError(409, 'source_mismatch', 'The prepared workspace differs from the exact pinned tree.');
    this.checkedOut = true;
  }

  private async verifyToolchain(): Promise<void> {
    const check = await this.sandbox.exec('test "$(id -u gitknot)" = 10000 && test -x /usr/bin/setpriv && test -x /usr/bin/setsid && cat /opt/gitknot/toolchain.json', { timeout: 10_000 });
    let marker: { os?: string; arch?: string; tools?: Record<string, string>; sandbox_version?: string };
    try { marker = JSON.parse(check.stdout); } catch { throw new ApiError(503, 'hosted_image_unverified', 'The hosted image does not contain its pinned toolchain attestation.'); }
    if (!check.success || marker.os !== 'linux' || marker.arch !== 'x64' || marker.sandbox_version !== '0.12.1' || !marker.tools
      || await fingerprintToolchain({ os: 'linux', arch: 'x64', tools: marker.tools, image: this.context.job.toolchain.image }) !== this.context.job.toolchain.digest) {
      throw new ApiError(409, 'toolchain_mismatch', 'The allocated image differs from the immutable toolchain.');
    }
    const manifest = this.context.plan.portable_manifest as { jobs: Array<{ id: string; toolchain: { tools: Record<string, string> } }> };
    const tools = manifest.jobs.find(job => job.id === this.context.job.key)?.toolchain.tools;
    if (!tools) throw new Error('The manifest has no toolchain descriptor.');
    for (const [tool, version] of Object.entries(tools)) {
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(tool)) throw new Error('Unsafe toolchain command.');
      const result = await this.sandbox.exec(`env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp ${tool} --version`, { timeout: 10_000 });
      const actual = `${result.stdout}\n${result.stderr}`;
      const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!result.success || !new RegExp(`(?:^|[^0-9A-Za-z])v?${escaped}(?:$|[^0-9A-Za-z.])`).test(actual)) throw new ApiError(409, 'toolchain_mismatch', `The allocated ${tool} version differs from the pinned toolchain.`);
    }
    await this.sandbox.exec(`chmod 711 ${CONTROL_DIR}`, { timeout: 10_000 });
  }

  async executeCommands(): Promise<number> {
    try { await this.runCommands(); }
    catch (error) {
      this.capture(error);
      try { this.processStopped = await this.runtime.stopJobProcesses(); } catch { this.processStopped = false; }
      if (this.activeStep !== null && this.processStopped) {
        try { await this.drain(this.activeStep, true); } catch (logError) { this.capture(logError); }
      }
      if (!this.logs.exceeded) {
        try { await this.logs.message('GitKnot: hosted verification did not complete successfully.\n', this.protectedValues); } catch { /* The sanitized log journal owns pending bytes. */ }
      }
    }
    this.finishedAt = now();
    try { await this.logs.flush(); this.logManifest = await completeObjectManifest(this.env, this.identity, 'logs', 'logs'); }
    catch { this.conclusion = 'infrastructure_failed'; }
    return this.conclusion === 'succeeded' ? 0 : this.exitCode || 1;
  }

  private async runCommands(): Promise<void> {
    if (!this.checkedOut) throw new Error('SDK commands cannot execute before exact checkout.');
    for (let index = 0; index < this.context.job.steps.length; index++) {
      const step = this.context.job.steps[index]!;
      await this.executeStep(step, index);
      if (this.conclusion !== 'succeeded') break;
      await this.collectStepValues(step);
    }
    await this.collectOutputs(this.conclusion !== 'succeeded');
  }

  private async executeStep(step: PlanStep, index: number): Promise<void> {
    this.activeStep = index; this.exitCode = null; this.signal = null;
    await this.heartbeat();
    const values = await this.stepEnvironment(step);
    await this.sandbox.writeFile(`${CONTROL_DIR}/step-${index}.sh`, `set -eu\n${step.run}\n`);
    await this.sandbox.writeFile(`${CONTROL_DIR}/step-${index}.json`, JSON.stringify({ env: values, shell: step.shell, working_directory: step.working_directory,
      deadline: Date.parse(this.context.attempt.deadline_at!), step_deadline: Math.min(this.secretExpires, Date.now() + Math.min(step.timeout_ms, this.remaining(45_000))),
      log_bytes: Math.max(0, (this.context.job.limits?.log_bytes ?? EXECUTION_LIMITS.log_bytes) - this.rawLogBytes) }));
    const permissions = await this.sandbox.exec(`chmod 444 ${CONTROL_DIR}/step-${index}.sh && chmod 600 ${CONTROL_DIR}/step-${index}.json`, { timeout: 5000 });
    if (!permissions.success) throw new ApiError(503, 'step_start_failed', 'The root launcher configuration could not be protected.');
    this.processStopped = false;
    const process = await bounded(this.sandbox.startProcess(launchStepScript(index), { cwd: '/', env: {},
      processId: `${this.context.attempt.id}-step-${index}`, autoCleanup: false }), Math.min(60_000, this.remaining(30_000)), 'The job process could not start.');
    await attemptRequest(this.env, this.context.attempt.id, 'process', { process_id: process.id });
    const result = await this.waitForProcess(process, index);
    this.exitCode = result.exit_code; this.signal = result.signal; this.resource = result.resource_exhaustion; this.rawLogBytes += result.log_bytes;
    this.processStopped = result.process_group_stopped && await this.runtime.stopJobProcesses();
    if (!this.processStopped) throw new ApiError(503, 'process_stop_unconfirmed', 'Every job process must stop before collecting outputs.');
    await this.drain(index, true); this.activeStep = null;
    this.conclusion = hostedProcessConclusion(result);
  }

  private async stepEnvironment(step: PlanStep): Promise<Record<string, string>> {
    await this.refreshContext();
    this.secretExpires = Infinity;
    let secrets: Record<string, string> = {};
    const names = step.secrets.map(secret => secret.name);
    if (names.length) {
      const resolved = await withEnvironmentSecrets(this.env, this.context, () => resolveAttemptSecrets(this.env, { attempt_id: this.context.attempt.id, generation: this.context.attempt.generation,
        step_id: step.secret_step_id ?? step.id, names }));
      secrets = resolved.values;
      if (!Number.isFinite(Date.parse(resolved.expires_at)) || Date.parse(resolved.expires_at) <= Date.now()) throw new ApiError(403, 'secret_unavailable', 'A declared secret lease has expired.');
      this.secretExpires = Date.parse(resolved.expires_at);
      for (const name of names) if (typeof secrets[name] !== 'string') throw new ApiError(403, 'secret_unavailable', 'A declared secret is unavailable.');
      for (const value of Object.values(secrets)) if (!this.protectedValues.includes(value)) this.protectedValues.push(value);
    }
    const result = { ...step.env };
    for (const [name, value] of Object.entries(step.values ?? {})) result[name] = this.resolveValue(value, secrets);
    if (Object.values(result).some(value => value.includes('\0')) || Object.entries(result).reduce((bytes, [name, value]) => bytes + Buffer.byteLength(name) + Buffer.byteLength(value) + 2, 0) > 131072) {
      throw new ApiError(422, 'environment_limit', 'Resolved step environment values exceed the supported process limit.');
    }
    return result;
  }

  private resolveValue(value: unknown, secrets: Record<string, string>): string {
    if (value === null || typeof value !== 'object') return String(value);
    const ref = value as Record<string, unknown>;
    if ('literal' in ref) return JSON.stringify(ref.literal);
    if (typeof ref.secret === 'string' && Object.hasOwn(secrets, ref.secret)) return secrets[ref.secret]!;
    if (typeof ref.output === 'string') {
      const resolved = this.inputs.get(ref.output) ?? this.stepOutputs.get(ref.output);
      if (resolved !== undefined) return resolved;
    }
    throw new ApiError(409, 'input_unavailable', 'A declared step input could not be resolved.');
  }

  private async waitForProcess(process: Process, index: number): Promise<HostedProcessResult> {
    for (;;) {
      this.remaining(10_000);
      if (Date.parse(this.lease) <= Date.now()) throw localFenced();
      await this.drain(index);
      const actual = await bounded(this.sandbox.getProcess(process.id, '__DISABLE_SESSION__'), 10_000, 'The process status could not be verified.');
      if (!actual) throw new ApiError(503, 'process_exit_unconfirmed', 'The SDK process is no longer observable.');
      if (!['starting', 'running'].includes(actual.status)) {
        const result = await this.sandbox.readFile(`${CONTROL_DIR}/step-${index}.result.json`, { encoding: 'utf-8' });
        return parseHostedProcessResult(result.content);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  private async heartbeat(): Promise<void> {
    if (!this.activated || this.heartbeatsStopped) return;
    if (this.heartbeatError) throw this.heartbeatError;
    await this.refreshContext();
    const facts = await this.runtime.runtimeStatus(this.identity);
    if (facts.egress_exhausted) throw new ApiError(429, 'egress_quota_exceeded', 'The attempt exhausted its egress quota.');
    if (facts.sealed) throw localFenced();
    const response = await attemptRequest<{ status: string; lease_expires_at?: string }>(this.env, this.context.attempt.id, 'hosted-heartbeat', {});
    if (response.status !== 'active' || !response.lease_expires_at) throw localFenced();
    const refreshed = await this.runtime.refreshLease(this.identity);
    this.lease = refreshed.lease_expires_at;
  }

  private scheduleHeartbeat(): void {
    if (this.heartbeatsStopped) return;
    this.heartbeatTimer = setTimeout(() => {
      const work = this.heartbeat().catch(async error => {
        this.heartbeatError = error;
        if (error instanceof ApiError && ['attempt_fenced', 'egress_quota_exceeded'].includes(error.code)) {
          try { await this.runtime.destroyAndVerify(this.identity); } catch { /* The independent alarm retains unconfirmed cleanup. */ }
        }
      }).finally(() => { this.heartbeatWork = null; if (!this.heartbeatError) this.scheduleHeartbeat(); });
      this.heartbeatWork = work;
    }, EXECUTION_LIMITS.heartbeat_ms);
  }

  private async stopHeartbeats(): Promise<void> {
    this.heartbeatsStopped = true;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.heartbeatWork) await this.heartbeatWork;
  }

  private async refreshContext(): Promise<void> {
    const selected = await localAttemptEnvironment(this.env, this.identity, true);
    if (selected.context.attempt.plan_digest !== this.identity.plan_digest || selected.context.attempt.producer_id !== this.identity.runner_id) throw localFenced();
    this.env = selected.env; this.context = selected.context;
  }

  private async drain(index: number, final = false): Promise<void> {
    await this.logs.read(`${CONTROL_DIR}/step-${index}.out`, this.protectedValues, final);
    await this.logs.read(`${CONTROL_DIR}/step-${index}.err`, this.protectedValues, final);
  }

  private async restoreDependencies(): Promise<void> {
    await this.refreshContext();
    const cache = this.context.job.cache;
    if (!cache) return;
    const files = await this.sandbox.exec(`git -C /workspace ls-files -s -- ${cache.key_files.map(shellQuote).join(' ')}`, { timeout: 10_000 });
    if (!files.success || !files.stdout.trim()) throw new ApiError(409, 'cache_inputs_unavailable', 'Declared cache key files were not found in the pinned source.');
    const lineage: Array<{ job: string; output: string; digest: string }> = [];
    for (const input of this.context.job.inputs) {
      const output = await one<{ source_digest: string }>(primary(this.env), `SELECT o.source_digest FROM execution_objects o JOIN workflow_jobs j ON COALESCE(j.current_attempt_id,j.reused_attempt_id)=o.attempt_id
        WHERE j.run_id=? AND j.repo_id=? AND j.job_key=? AND j.status='succeeded' AND o.repo_id=j.repo_id AND o.kind='manifest' AND o.name=? AND o.state='sealed' AND o.expires_at>?`,
      this.context.run.id, this.context.run.repo_id, input.job, `output:${input.output}`, now());
      if (!output) throw new ApiError(409, 'input_unavailable', 'A declared cache input lineage is unavailable.');
      lineage.push({ job: input.job, output: input.output, digest: output.source_digest });
    }
    this.cacheKey = await sha256(JSON.stringify({ version: 1, repo_id: this.context.attempt.repo_id, trust: this.context.run.trust, producer: this.context.attempt.producer_id,
      toolchain: this.context.job.toolchain.digest, sdk: '0.2.0', sandbox: '0.12.1', declaration: { ...cache, mode: undefined }, files: files.stdout, workflow: this.context.run.workflow_digest, lineage }));
    const entry = await one<{ snapshot_json: string }>(primary(this.env), 'SELECT snapshot_json FROM execution_caches WHERE cache_key=? AND repo_id=? AND account_id=? AND trust=? AND toolchain_digest=? AND expires_at>?',
      this.cacheKey, this.context.attempt.repo_id, this.context.attempt.account_id, this.context.run.trust, this.context.job.toolchain.digest, now());
    if (!entry) return;
    const backup = JSON.parse(entry.snapshot_json) as DirectoryBackup;
    if (backup.dir !== SNAPSHOT_DIR || backup.localBucket !== true) throw new ApiError(409, 'cache_format_mismatch', 'The cache snapshot has an incompatible format.');
    await this.sandbox.restoreBackup(backup);
    await this.sandbox.writeFile(`${CONTROL_DIR}/restore-cache.cjs`, dependencyRestoreScript);
    const restored = await this.sandbox.exec(`node ${CONTROL_DIR}/restore-cache.cjs`, { timeout: Math.min(30_000, this.remaining(45_000)),
      env: { GITKNOT_CACHE_SPEC: JSON.stringify({ paths: cache.paths, max_bytes: this.context.job.limits?.cache_bytes ?? EXECUTION_LIMITS.cache_bytes }) } });
    if (!restored.success) {
      const cleaned = await this.sandbox.exec(`git -C /workspace -c core.hooksPath=/dev/null -c core.fsmonitor=false reset --hard ${shellQuote(this.context.run.commit_sha)} && git -C /workspace clean -ffdx`, { timeout: 30_000 });
      if (!cleaned.success) throw new ApiError(503, 'cache_recovery_failed', 'The pinned source could not be restored after a rejected dependency cache.');
      await execute(primary(this.env), 'DELETE FROM execution_caches WHERE cache_key=? AND repo_id=? AND account_id=?', this.cacheKey, this.context.run.repo_id, this.context.run.account_id);
      await this.logs.message('Dependency cache rejected and discarded; verification runs from the exact pinned source.\n');
    }
    const head = await this.sandbox.exec(`test "$(git -C /workspace rev-parse HEAD)" = ${shellQuote(this.context.run.commit_sha)} && git -C /workspace diff --exit-code HEAD --`, { timeout: 10_000 });
    if (!head.success) throw new ApiError(409, 'cached_source_mismatch', 'Cache restoration changed pinned tracked source.');
  }

  private async restoreInputs(): Promise<void> {
    for (const input of this.context.job.inputs) {
      await this.refreshContext();
      const dependency = await one<JobRecord>(primary(this.env), 'SELECT * FROM workflow_jobs WHERE run_id=? AND repo_id=? AND job_key=? AND status=?', this.context.run.id, this.context.run.repo_id, input.job, 'succeeded');
      const attemptId = dependency?.current_attempt_id ?? dependency?.reused_attempt_id;
      const object = attemptId && await one<ExecutionObject>(primary(this.env), `SELECT * FROM execution_objects WHERE attempt_id=? AND repo_id=? AND kind='manifest' AND name=? AND state='sealed' AND expires_at>?`, attemptId, this.context.run.repo_id, `output:${input.output}`, now());
      if (!object) throw new ApiError(409, 'input_unavailable', 'A required verified output is unavailable.');
      const definition = this.context.plan.jobs.find(job => job.key === input.job)?.outputs[input.output];
      if (!definition) throw new ApiError(409, 'input_unavailable', 'The producer output is missing from the plan.');
      const local = `${CONTROL_DIR}/input-${this.inputs.size}`;
      await this.writeStream(local, await streamManifest(this.env, object));
      let value: string;
      if ((definition.type ?? 'artifact') === 'artifact') {
        const destination = `/tmp/gitknot-inputs/${input.job}.${input.output}`;
        await this.sandbox.writeFile(`${CONTROL_DIR}/restore-input.cjs`, restoreInputScript);
        const result = await this.sandbox.exec(`node ${CONTROL_DIR}/restore-input.cjs`, { timeout: Math.min(30_000, this.remaining(45_000)),
          env: { GITKNOT_INPUT_SPEC: JSON.stringify({ archive: local, destination, max_bytes: EXECUTION_LIMITS.output_bytes }) } });
        if (!result.success) throw new ApiError(409, 'input_invalid', 'A verified input archive failed safe extraction.');
        value = destination;
      } else {
        const result = await this.sandbox.readFile(local, { encoding: 'utf-8' });
        const scalar = JSON.parse(result.content);
        value = typeof scalar === 'string' ? scalar : JSON.stringify(scalar);
      }
      this.inputs.set(`jobs.${input.job}.${input.output}`, value);
    }
  }

  private async writeStream(path: string, source: ReadableStream<Uint8Array>): Promise<void> {
    await this.sandbox.writeFile(path, '');
    const reader = source.getReader();
    let total = 0;
    const hash = createHash('sha256');
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        this.inputBytes += next.value.length;
        if (this.inputBytes > (this.context.job.limits?.input_bytes ?? EXECUTION_LIMITS.output_bytes)) throw new ApiError(413, 'input_limit', 'Input download exceeded its quota.');
        for (let offset = 0; offset < next.value.length; offset += EXECUTION_LIMITS.log_chunk_bytes) {
          const chunk = next.value.subarray(offset, offset + EXECUTION_LIMITS.log_chunk_bytes);
          await this.sandbox.writeFile(`${path}.chunk`, Buffer.from(chunk).toString('base64'), { encoding: 'base64' });
          const copied = await this.sandbox.exec(`dd if=${shellQuote(`${path}.chunk`)} of=${shellQuote(path)} bs=65536 oflag=seek_bytes seek=${total} conv=notrunc status=none && rm -f ${shellQuote(`${path}.chunk`)}`, { timeout: 10_000 });
          if (!copied.success) throw new ApiError(503, 'input_write_failed', 'The executor could not materialize an input.');
          total += chunk.length; hash.update(chunk);
        }
      }
    } finally { await reader.cancel(); }
    const checked = await this.sandbox.exec(`sha256sum ${shellQuote(path)}`, { timeout: 10_000 });
    if (!checked.success || checked.stdout.split(/\s+/)[0] !== hash.digest('hex')) throw new ApiError(409, 'input_checksum_mismatch', 'Materialized input bytes failed checksum verification.');
  }

  private async collectStepValues(step: PlanStep): Promise<void> {
    await this.sandbox.writeFile(`${CONTROL_DIR}/collect-output.cjs`, collectOutputScript);
    await this.sandbox.writeFile(`${CONTROL_DIR}/restore-input.cjs`, restoreInputScript);
    for (const [name, output] of Object.entries(step.outputs ?? {})) {
      if (!output.required && !(await this.sandbox.exists(`/workspace/${output.path}`)).exists) continue;
      const id = `steps.${step.secret_step_id ?? step.id}.${name}`, local = `${CONTROL_DIR}/value-${id}`;
      const masks = secretVariants(this.protectedValues);
      const collected = await this.sandbox.exec(`node ${CONTROL_DIR}/collect-output.cjs`, { timeout: Math.min(30_000, this.remaining(45_000)), env: {
        GITKNOT_OUTPUT_SPEC: JSON.stringify({ ...output, kind: output.type === 'artifact' ? 'artifact' : 'value', max_bytes: output.type === 'artifact' ? EXECUTION_LIMITS.output_bytes : 65536,
          destination: local, masks, mask_width: Math.max(1, ...masks.map(value => value.length)) }),
      } });
      if (!collected.success) throw new ApiError(409, 'step_output_invalid', 'A step output is missing, unsafe, secret-bearing, or has the wrong type.');
      if (output.type === 'artifact') {
        const destination = `/tmp/gitknot-inputs/${id}`;
        const restored = await this.sandbox.exec(`node ${CONTROL_DIR}/restore-input.cjs`, { timeout: Math.min(30_000, this.remaining(45_000)),
          env: { GITKNOT_INPUT_SPEC: JSON.stringify({ archive: local, destination, max_bytes: EXECUTION_LIMITS.output_bytes }) } });
        if (!restored.success) throw new ApiError(409, 'step_output_invalid', 'A step artifact could not be mounted safely.');
        this.stepOutputs.set(id, destination);
      } else {
        const result = await this.sandbox.readFile(local, { encoding: 'utf-8' });
        const value = JSON.parse(result.content);
        this.stepOutputs.set(id, typeof value === 'string' ? value : JSON.stringify(value));
      }
    }
  }

  private async collectOutputs(failedCommand = false): Promise<void> {
    await this.sandbox.writeFile(`${CONTROL_DIR}/collect-output.cjs`, collectOutputScript);
    let index = 0;
    for (const [name, definition] of Object.entries(this.context.job.outputs)) {
      if (failedCommand && definition.kind !== 'report') continue;
      await this.heartbeat();
      if (definition.required === false) {
        const exists = await this.sandbox.exists(`/workspace/${definition.path}`);
        if (!exists.exists) continue;
      }
      const path = `${CONTROL_DIR}/output-${index++}`;
      const masks = secretVariants(this.protectedValues);
      const result = await this.sandbox.exec(`node ${CONTROL_DIR}/collect-output.cjs`, { timeout: Math.min(60_000, this.remaining(30_000)), env: {
        GITKNOT_OUTPUT_SPEC: JSON.stringify({ ...definition, type: definition.type ?? (definition.kind === 'report' ? 'json' : 'artifact'), destination: path, masks, mask_width: Math.max(1, ...masks.map(value => Buffer.byteLength(value))), max_bytes: definition.max_bytes }),
      } });
      if (!result.success) throw new ApiError(409, 'output_invalid', `Output ${name} is missing, unsafe, secret-bearing, or over quota.`);
      const metadata = JSON.parse(result.stdout) as { size_bytes: number; sha256: string; failed: boolean };
      if (definition.kind === 'report') {
        const data = await readBounded(decodedFile(await this.sandbox.readFileStream(path)), Math.min(definition.max_bytes, 16 * 1024 ** 2));
        if (data.length > definition.max_bytes) throw new ApiError(413, 'report_limit', 'The report exceeded its byte quota.');
        metadata.failed = reportFailed(data, definition.format!);
      }
      if (metadata.failed) this.conclusion = 'failed';
      const input = decodedFile(await this.sandbox.readFileStream(path));
      let sequence = 0;
      let buffered = new Uint8Array();
      let produced = 0;
      const reader = input.getReader();
      const send = async (bytes: Uint8Array, final: boolean) => {
        produced += bytes.length;
        this.outputBytes += bytes.length;
        if (this.outputBytes > (this.context.job.limits?.output_bytes ?? EXECUTION_LIMITS.output_bytes)) throw new ApiError(413, 'output_quota_exceeded', 'The attempt exhausted its aggregate output quota.');
        if (produced > definition.max_bytes) throw new ApiError(413, 'output_limit', 'Output data exceeded its declared quota.');
        await putObjectBytes(this.env, { ...this.identity, kind: 'output', name, sequence: sequence++, final, content_type: definition.kind === 'report' && definition.format === 'junit' ? 'application/xml'
          : (definition.type ?? 'artifact') === 'artifact' ? 'application/vnd.gitknot.files+ndjson' : 'application/json', retention_seconds: definition.retention_seconds }, bytes);
      };
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          const combined = new Uint8Array(buffered.length + next.value.length); combined.set(buffered); combined.set(next.value, buffered.length); buffered = combined;
          while (buffered.length > EXECUTION_LIMITS.log_chunk_bytes) { await send(buffered.slice(0, EXECUTION_LIMITS.log_chunk_bytes), false); buffered = buffered.slice(EXECUTION_LIMITS.log_chunk_bytes); }
        }
        await send(buffered, true);
      } finally { await reader.cancel(); }
      const manifest = await completeObjectManifest(this.env, this.identity, name, 'output', metadata.sha256);
      this.outputs.push({ name, sha256: manifest.source_digest!, size_bytes: metadata.size_bytes });
    }
  }

  async snapshot(): Promise<DirectoryBackup> {
    try { return await this.createSnapshot(); }
    catch (error) { this.capture(error); throw new ApiError(503, 'hosted_snapshot_failed', 'The sanitized SDK snapshot could not be retained.'); }
  }

  private async createSnapshot(): Promise<DirectoryBackup> {
    this.processStopped = await this.runtime.stopJobProcesses();
    if (!this.processStopped) throw new ApiError(503, 'orphan_process', 'Snapshot creation requires confirmed process termination.');
    await this.sandbox.writeFile(`${CONTROL_DIR}/snapshot.cjs`, dependencySnapshotScript);
    // Secret-bearing jobs produce a real metadata-only SDK snapshot. They never
    // publish a dependency cache, regardless of where code wrote those secrets.
    const paths = this.context.job.steps.some(step => step.secrets.length) || this.context.job.cache?.mode === 'read' ? [] : this.context.job.cache?.paths ?? [];
    const result = await this.sandbox.exec(`node ${CONTROL_DIR}/snapshot.cjs`, { timeout: Math.min(30_000, this.remaining(20_000)), env: {
      GITKNOT_CACHE_SPEC: JSON.stringify({ paths, max_bytes: this.context.job.limits?.cache_bytes ?? EXECUTION_LIMITS.cache_bytes, masks: paths.length ? secretVariants(this.protectedValues) : [] }),
    } });
    if (!result.success) throw new ApiError(409, 'snapshot_unsafe', 'The dependency snapshot failed sanitization.');
    const snapshot = await bounded(this.sandbox.createBackup({ dir: SNAPSHOT_DIR, name: this.context.attempt.id, ttl: paths.length ? this.context.job.cache!.retention_seconds : 3600,
      multipart: false, localBucket: true }), Math.min(60_000, this.remaining(10_000)), 'Snapshot creation exceeded the job deadline.');
    await this.runtime.retainSnapshot(this.identity, snapshot, paths.length ? this.cacheKey : null);
    return snapshot;
  }

  safeLogSummary(): string { return this.logManifest ? `Full redacted logs: ${this.logManifest.id} (sha256:${this.logManifest.sha256})\n` : 'The executor did not produce a complete log manifest.\n'; }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    await this.beforeCheckpoint();
    await reconcileLocalHostedAttempt(this.env, this.identity.attempt_id, this.identity.generation);
    this.destroyed = true;
  }

  async finish(): Promise<void> {
    await this.beforeCheckpoint();
    await reconcileLocalHostedAttempt(this.env, this.identity.attempt_id, this.identity.generation);
  }

  async beforeCheckpoint(): Promise<void> {
    await this.stopHeartbeats();
    if (!this.owner || this.draftSaved) return;
    if (!this.logManifest) {
      try { await this.logs.flush(); await flushHostedLogs(this.env, this.identity); this.logManifest = await completeObjectManifest(this.env, this.identity, 'logs', 'logs'); }
      catch { this.conclusion = 'infrastructure_failed'; }
    }
    this.finishedAt ??= now();
    await persistLocalHostedDraft(this.env, this.identity, this.claimId, { ...this.identity, conclusion: this.conclusion,
      exit_code: this.exitCode, signal: this.signal, resource_exhaustion: this.resource, toolchain_digest: this.context.attempt.toolchain_digest,
      outputs: this.outputs, log_manifest_digest: this.logManifest?.sha256 ?? null, process_group_stopped: this.processStopped,
      started_at: this.context.attempt.started_at ?? this.context.attempt.allocated_at!, finished_at: this.finishedAt });
    if (this.logManifest) await finalizeLocalHostedDraft(this.env, this.identity, this.logManifest.sha256);
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

export function decodedFile(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = streamFile(source);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const item = await iterator.next(); if (item.done) controller.close(); else controller.enqueue(typeof item.value === 'string' ? new TextEncoder().encode(item.value) : item.value); }
      catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return(undefined as never); },
  });
}
