import { mkdir, mkdtemp } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { MAX_TYPED_OUTPUT_WIRE_BYTES, canonicalJson, sha256, verifyManifest, type CompiledJob, type CompiledStep, type JobOutcome, type RunManifest, type StepResult, type Value } from '../../workflows/src/index.ts';
import { makeReadOnly, restoreArchive } from './archive.ts';
import { cacheIdentity, restoreCache, saveCache, validateCachePaths } from './cache.ts';
import { checkoutSource, type SourceLocation } from './checkout.ts';
import { abortError, errorCode, RunnerError, throwIfAborted } from './errors.ts';
import { privateDirectory, readBounded, removeAndVerify, safeWorkspacePath, within } from './files.ts';
import { collectOutputs, collectReports, decodeOutputWire, type StoredOutput } from './outputs.ts';
import { cleanEnvironment, groupAlive, runProcess, shellCommand, terminateGroup, type ProcessGroup } from './process.ts';
import { redactText } from './redaction.ts';
import { matchToolchain } from './toolchain.ts';
import { createIsolation, isolationPlatform, parseIsolation, type RunnerIsolation, type JobIsolation, type IsolationRecord } from './isolation.ts';
import { snapshotStepOutputs } from './snapshot.ts';
import { OutputBudget } from './output-budget.ts';

export interface JobExecutionResult {
  job_id: string;
  outcome: JobOutcome;
  reason: string;
  exit_code: number | null;
  signal: string | null;
  started_at: string;
  finished_at: string;
  toolchain_fingerprint: string;
  steps: StepResult[];
  outputs: StoredOutput[];
  cleanup_confirmed: true;
  missing_secrets?: string[];
  cache_hit: boolean;
}

export interface ExecuteJobOptions {
  source: SourceLocation;
  work_root: string;
  output_directory: string;
  cache_directory?: string;
  deadline_at?: number;
  signal?: AbortSignal;
  grace_ms?: number;
  allow_local_source?: boolean;
  allowed_git_origins?: string[];
  variables?: Record<string, string>;
  secrets?: Record<string, string>;
  secretProvider?: (stepId: string, names: string[], signal: AbortSignal) => Promise<Record<string, string>>;
  inputs?: Record<string, StoredOutput>;
  redaction_secrets?: string[];
  approved_environment?: { name: string; manifest_digest: string; commit: string };
  onLog?: (bytes: Uint8Array) => Promise<void>;
  onGroups?: (groups: ProcessGroup[], directory: string) => Promise<void>;
  isolation?: RunnerIsolation;
  onIsolation?: (record: IsolationRecord | null) => Promise<void>;
}

function secretNames(values: Record<string, Value>[]): string[] {
  return [...new Set(values.flatMap((environment) => Object.values(environment).flatMap((value) => value && typeof value === 'object' && 'secret' in value ? [value.secret] : [])))].sort();
}

function outcomeFor(error: unknown): JobOutcome {
  const code = errorCode(error);
  if (code === 'timed_out' || code === 'lease_expired') return 'timed_out';
  if (['cancelled', 'attempt_fenced', 'runner_revoked'].includes(code)) return 'cancelled';
  if (['secret_missing', 'variable_missing', 'input_missing', 'toolchain_mismatch', 'toolchain_unavailable', 'environment_approval_required'].includes(code)) return 'dependency_blocked';
  return 'failed';
}

function emptyResult(job: CompiledJob): JobExecutionResult {
  return {
    job_id: job.id, outcome: 'passed', reason: 'All commands and required outputs passed.', exit_code: 0, signal: null,
    started_at: new Date().toISOString(), finished_at: new Date().toISOString(), toolchain_fingerprint: job.toolchain.fingerprint,
    steps: [], outputs: [], cleanup_confirmed: true, cache_hit: false,
  };
}

function recordFailure(result: JobExecutionResult, error: unknown, secrets: string[]): void {
  result.outcome = outcomeFor(error);
  result.reason = redactText(error instanceof RunnerError ? `${error.code}: ${error.message}` : 'execution_failed: The job could not complete.', secrets);
  result.exit_code = error instanceof RunnerError && typeof error.details?.exit_code === 'number' ? error.details.exit_code : null;
  result.signal = error instanceof RunnerError && typeof error.details?.signal === 'string' ? error.details.signal : null;
  if (error instanceof RunnerError && error.code === 'secret_missing' && Array.isArray(error.details?.names)) result.missing_secrets = error.details.names as string[];
}

interface ValueContext {
  inputs: Record<string, StoredOutput>;
  mounts: Map<string, string>;
  private_directory: string;
  secrets: Record<string, string>;
  variables: Record<string, string>;
  manifest: RunManifest;
  signal: AbortSignal;
  isolation?: JobIsolation;
}

async function resolveValue(value: Value, context: ValueContext): Promise<string> {
  if (value === null) return 'null';
  if (typeof value !== 'object') return String(value);
  if ('literal' in value) return canonicalJson(value.literal);
  if ('input' in value) throw new RunnerError('manifest_invalid', 'The compiled manifest contains an unresolved input.');
  if ('secret' in value) {
    const secret = context.secrets[value.secret];
    if (secret === undefined) throw new RunnerError('secret_missing', `Secret ${value.secret} is unavailable.`, { names: [value.secret] });
    return secret;
  }
  if ('variable' in value) {
    const variable = context.variables[value.variable];
    if (variable === undefined) throw new RunnerError('variable_missing', `Variable ${value.variable} is unavailable.`);
    return variable;
  }
  const output = context.inputs[value.output];
  if (!output) throw new RunnerError('input_missing', `Required output ${value.output} is unavailable.`);
  if (output.type !== 'artifact') {
    if (output.type === 'report') throw new RunnerError('input_type', 'Reports cannot be consumed as typed values.');
    const bytes = await readBounded(output.path, MAX_TYPED_OUTPUT_WIRE_BYTES);
    if (bytes.byteLength !== output.size_bytes || await sha256(bytes) !== output.digest) throw new RunnerError('input_checksum', 'A typed dependency output changed before consumption.');
    const value = decodeOutputWire(bytes, output.type);
    return output.type !== 'json' && typeof value === 'string' ? value : canonicalJson(value);
  }
  const existing = context.mounts.get(value.output);
  if (existing) return context.isolation?.path(existing) ?? existing;
  const target = join(context.private_directory, value.output);
  await restoreArchive(output.path, target, output, { max_bytes: context.manifest.limits.max_input_bytes, max_files: context.manifest.limits.max_output_files, signal: context.signal });
  await makeReadOnly(target);
  context.mounts.set(value.output, target);
  await context.isolation?.grantInputs();
  return context.isolation?.path(target) ?? target;
}

async function resolveEnvironment(environment: Record<string, Value>, context: ValueContext): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  let bytes = 0;
  for (const [name, value] of Object.entries(environment)) {
    result[name] = await resolveValue(value, context);
    bytes += Buffer.byteLength(name) + Buffer.byteLength(result[name]!) + 2;
    if (result[name]!.includes('\0') || bytes > (process.platform === 'win32' ? 24_000 : 131_072)) throw new RunnerError('environment_limit', 'Resolved environment values contain NUL bytes or exceed the process environment limit.');
  }
  return result;
}

function verifyEnvironmentApproval(manifest: RunManifest, job: CompiledJob, approved: ExecuteJobOptions['approved_environment']): void {
  if (!job.environment?.approval_required) return;
  if (approved?.name !== job.environment.name || approved.manifest_digest !== manifest.digest || approved.commit !== manifest.source.commit) throw new RunnerError('environment_approval_required', `Environment ${job.environment.name} needs approval for this exact commit and manifest.`);
}

async function loadStepSecrets(step: CompiledStep, job: CompiledJob, options: ExecuteJobOptions, context: ValueContext, protectedValues: string[]): Promise<void> {
  const names = secretNames([job.env, step.env, ...step.commands.map((command) => command.env)]);
  if (!names.length) return;
  if (options.secretProvider && !context.manifest.configuration.selection_digest) throw new RunnerError('secret_plan_unbound', 'Remote secrets require a version-bound configuration selection in the manifest.');
  const values = options.secretProvider ? await options.secretProvider(step.id, names, context.signal) : options.secrets ?? {};
  const missing = names.filter((name) => typeof values[name] !== 'string' || values[name]!.length === 0);
  if (missing.length) throw new RunnerError('secret_missing', `Unavailable secrets: ${missing.join(', ')}.`, { names: missing });
  for (const name of names) {
    const value = values[name]!;
    if (value.length > 65_536 || value.includes('\0')) throw new RunnerError('secret_invalid', 'A secret exceeds the supported size or contains a NUL byte.');
    if (context.secrets[name] !== undefined && context.secrets[name] !== value) throw new RunnerError('secret_version_changed', 'The broker changed a pinned secret value during the job.');
    context.secrets[name] = value;
    if (!protectedValues.includes(value)) protectedValues.push(value);
  }
}

/** The single shell executor used by local runs, reproduction, and customer machines. */
export async function executeJob(manifestInput: RunManifest, jobId: string, options: ExecuteJobOptions): Promise<JobExecutionResult> {
  const isolationConfiguration = parseIsolation(options.isolation);
  const manifest = await verifyManifest(manifestInput);
  const job = manifest.jobs.find((entry) => entry.id === jobId);
  if (!job) throw new RunnerError('job_unknown', 'The requested job is not in this manifest.');
  if (options.source.commit !== manifest.source.commit) throw new RunnerError('source_mismatch', 'Source does not match the immutable manifest.');
  const result = emptyResult(job);
  if (job.condition.outcome !== 'run') {
    result.outcome = job.condition.outcome === 'not_applicable' ? 'not_applicable' : 'dependency_blocked';
    result.reason = job.condition.reason; result.exit_code = null;
    return result;
  }
  const root = await privateDirectory(options.work_root);
  const outputDirectory = await privateDirectory(options.output_directory);
  if (within(root, outputDirectory)) throw new RunnerError('output_location', 'Output storage must be outside the disposable work directory.');
  const directory = await mkdtemp(join(root, `${job.id}-`));
  const workspace = join(directory, 'source');
  const privateDir = join(directory, 'control');
  const home = join(directory, 'home');
  const inputsDirectory = join(directory, 'inputs');
  await Promise.all([mkdir(home, { recursive: true, mode: 0o700 }), mkdir(privateDir, { recursive: true, mode: 0o700 }), mkdir(inputsDirectory, { recursive: true, mode: 0o755 })]);
  const controller = new AbortController();
  const deadline = Math.min(options.deadline_at ?? Number.MAX_SAFE_INTEGER, Date.now() + job.timeout_ms);
  const isolation = createIsolation(isolationConfiguration, { workspace, home, inputs: inputsDirectory, control: privateDir, directory, deadline_at: deadline, signal: controller.signal, grace_ms: options.grace_ms ?? 5_000, onRecord: options.onIsolation });
  const timer = setTimeout(() => controller.abort(new RunnerError('timed_out', 'The whole job exceeded its deadline.')), Math.max(1, deadline - Date.now()));
  const onAbort = () => controller.abort(options.signal ? abortError(options.signal) : new RunnerError('cancelled', 'Execution was cancelled.'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  let groups: ProcessGroup[] = [];
  const onGroup = async (group: ProcessGroup) => {
    groups = groups.filter((existing) => groupAlive(existing.pid));
    groups.push(group);
    await options.onGroups?.(groups, directory);
  };
  const stopGroups = async () => {
    for (const group of groups) await terminateGroup(group.pid, options.grace_ms ?? 5_000);
    groups = groups.filter((group) => groupAlive(group.pid));
    await options.onGroups?.(groups, directory);
  };
  const protectedValues = [...(options.redaction_secrets ?? []), ...(options.source.token ? [options.source.token] : []), ...Object.values(options.secrets ?? {})];
  const values: ValueContext = { inputs: { ...options.inputs }, mounts: new Map(), private_directory: inputsDirectory, secrets: {}, variables: options.variables ?? {}, manifest, signal: controller.signal, isolation };
  let logBytes = 0;
  const outputBudget = new OutputBudget(manifest.limits);
  const log = async (bytes: Uint8Array) => {
    logBytes += bytes.byteLength;
    if (logBytes > manifest.limits.max_log_bytes) throw new RunnerError('log_limit', 'The job exceeded its log byte limit.');
    await options.onLog?.(bytes);
  };
  const inputDigests = Object.fromEntries(Object.entries(options.inputs ?? {}).filter(([reference]) => job.needs.some(dependency => reference.startsWith(`jobs.${dependency}.`))).map(([reference, output]) => [reference, output.digest]));
  const cacheOptions = { job, workspace, directory: options.cache_directory ?? '', private_directory: privateDir, limits: manifest.limits, signal: controller.signal, secrets: protectedValues, configuration_digest: manifest.configuration.selection_digest, input_digests: inputDigests, variables: options.variables ?? {} };
  let key: string | null = null;
  try {
    throwIfAborted(controller.signal);
    await options.onGroups?.([], directory);
    verifyEnvironmentApproval(manifest, job, options.approved_environment);
    await checkoutSource({ source: options.source, workspace, private_directory: privateDir, signal: controller.signal, deadline_at: deadline, allow_local_source: options.allow_local_source, allowed_git_origins: options.allowed_git_origins, onGroup, grace_ms: options.grace_ms });
    if (options.cache_directory && job.cache) {
      await validateCachePaths(cacheOptions);
      key = Object.keys(options.secrets ?? {}).length ? null : await cacheIdentity(cacheOptions);
      result.cache_hit = await restoreCache(cacheOptions, key);
      await log(Buffer.from(result.cache_hit ? 'GitKnot: dependency cache restored; verification will execute.\n' : 'GitKnot: dependency cache miss; verification will execute.\n'));
    }
    await isolation.prepare();
    await matchToolchain(job.toolchain, { cwd: workspace, home, signal: controller.signal, onGroup, execute: (executable, args, processOptions) => isolation.run(executable, args, processOptions), platform: await isolationPlatform(isolationConfiguration), environment: isolation.environment() });
    for (const step of job.steps) {
      throwIfAborted(controller.signal);
      const stepResult: StepResult = { id: step.id, outcome: 'passed', exit_code: 0, signal: null };
      result.steps.push(stepResult);
      const stepDeadline = Math.min(deadline, Date.now() + step.timeout_ms);
      try {
        await loadStepSecrets(step, job, options, values, protectedValues);
        for (const command of step.commands) {
          const env = await resolveEnvironment({ ...job.env, ...step.env, ...command.env }, values);
          const [executable, args] = shellCommand(command.shell, command.run);
          const remaining = Math.min(command.timeout_ms, stepDeadline - Date.now());
          if (remaining <= 0) throw new RunnerError('timed_out', 'The step exceeded its deadline.');
          const executed = await isolation.run(executable, args, {
            cwd: await safeWorkspacePath(workspace, command.working_directory),
            env: { ...isolation.environment(), ...env, GITKNOT_JOB: job.id, GITKNOT_COMMIT: manifest.source.commit, GITKNOT_MANIFEST_DIGEST: manifest.digest },
            signal: controller.signal, timeout_ms: remaining, grace_ms: options.grace_ms, secrets: protectedValues,
            onLog: log, onGroup, max_output_bytes: Math.max(1, manifest.limits.max_log_bytes - logBytes),
          });
          stepResult.exit_code = executed.exit_code; stepResult.signal = executed.signal;
          if (executed.exit_code !== 0 || executed.signal) {
            stepResult.outcome = 'failed'; result.outcome = 'failed'; result.reason = `Step ${step.id} failed.`;
            result.exit_code = executed.exit_code; result.signal = executed.signal;
            break;
          }
        }
        if (stepResult.outcome !== 'passed') break;
        const hasOutputs = Object.keys(step.outputs).length > 0;
        if (hasOutputs) outputBudget.check(0, 1);
        const snapshot = hasOutputs ? await snapshotStepOutputs(isolation, step.outputs, { workspace, control: privateDir, limits: outputBudget.remaining(), signal: controller.signal, timeout_ms: Math.max(1, stepDeadline - Date.now()), onGroup }) : workspace;
        const outputs = await collectOutputs(step.outputs, { workspace: snapshot, destination: join(outputDirectory, 'steps', step.id), limits: manifest.limits, budget: outputBudget, secrets: protectedValues, signal: controller.signal });
        for (const output of outputs) values.inputs[`steps.${step.id}.${output.name}`] = output;
      } catch (error) {
        recordFailure(result, controller.signal.aborted ? abortError(controller.signal) : error, protectedValues);
        stepResult.outcome = result.outcome; stepResult.exit_code = result.exit_code; stepResult.signal = result.signal;
        break;
      }
    }
    await isolation.stop();
    await stopGroups();
    throwIfAborted(controller.signal);
    // Reports are retained on command failure. Required output absence cannot hide that failure.
    try {
      const reports = await collectReports(job.reports, { workspace, destination: join(outputDirectory, 'reports'), limits: manifest.limits, budget: outputBudget, secrets: protectedValues, signal: controller.signal });
      result.outputs.push(...reports.outputs);
      if (reports.failed && result.outcome === 'passed') { result.outcome = 'failed'; result.reason = 'A test or analysis report contains failures.'; result.exit_code = 1; }
    } catch (error) { if (result.outcome === 'passed') recordFailure(result, error, protectedValues); }
    if (result.outcome === 'passed') {
      result.outputs.push(...await collectOutputs(job.outputs, { workspace, destination: join(outputDirectory, 'outputs'), limits: manifest.limits, budget: outputBudget, secrets: protectedValues, signal: controller.signal }));
      if (options.cache_directory) await saveCache(cacheOptions, key);
    }
  } catch (error) { recordFailure(result, controller.signal.aborted ? abortError(controller.signal) : error, protectedValues); }
  finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    await isolation.stop();
    await stopGroups();
    await removeAndVerify(directory);
    if (groups.some((group) => groupAlive(group.pid))) throw new RunnerError('cleanup_failed', 'Job processes are still present after forceful termination.');
    await options.onGroups?.([], directory);
    result.finished_at = new Date().toISOString();
  }
  return result;
}

export interface LocalRunResult {
  manifest_digest: string;
  commit: string;
  outcome: 'passed' | 'failed';
  jobs: JobExecutionResult[];
}

export interface LocalRunOptions extends Omit<ExecuteJobOptions, 'inputs' | 'source' | 'output_directory'> {
  source: SourceLocation;
  output_directory: string;
  job?: string;
  /** Reproduction can supply immutable successful dependency outputs instead of rerunning them. */
  inputs?: Record<string, StoredOutput>;
  completed_dependencies?: string[];
  disposable?: boolean;
}

export async function runLocalWorkflow(manifestInput: RunManifest, options: LocalRunOptions): Promise<LocalRunResult> {
  parseIsolation(options.isolation);
  const manifest = await verifyManifest(manifestInput);
  if (manifest.trust.level === 'untrusted' && (!options.disposable || !options.isolation)) throw new RunnerError('disposable_required', 'Untrusted source requires a disposable machine and an enforced credential-isolation backend.');
  if (options.job && !manifest.jobs.some((job) => job.id === options.job)) throw new RunnerError('job_unknown', 'Requested job does not exist in the manifest.');
  const selected = new Set<string>();
  const collect = (id: string): void => {
    if (selected.has(id) || options.completed_dependencies?.includes(id)) return;
    selected.add(id);
    for (const dependency of manifest.jobs.find((job) => job.id === id)!.needs) collect(dependency);
  };
  if (options.job) collect(options.job);
  else for (const id of manifest.order) selected.add(id);
  const results = new Map<string, JobExecutionResult>();
  const inputs = { ...options.inputs };
  for (const id of manifest.order.filter((job) => selected.has(job))) {
    const job = manifest.jobs.find((entry) => entry.id === id)!;
    const blocked = job.needs.filter((dependency) => !options.completed_dependencies?.includes(dependency) && !['passed', 'not_applicable'].includes(results.get(dependency)?.outcome ?? 'missing'));
    let result: JobExecutionResult;
    if (options.signal?.aborted || blocked.length) {
      result = emptyResult(job);
      result.outcome = options.signal?.aborted ? 'cancelled' : 'dependency_blocked'; result.exit_code = null;
      result.reason = options.signal?.aborted ? 'The run was cancelled.' : `Dependencies did not pass: ${blocked.join(', ')}.`;
    } else {
      result = await executeJob(manifest, id, { ...options, inputs, output_directory: join(options.output_directory, id) });
    }
    results.set(id, result);
    if (result.outcome === 'passed') for (const output of result.outputs.filter((entry) => entry.kind !== 'report')) inputs[`jobs.${id}.${output.name}`] = output;
  }
  const jobs = [...results.values()];
  return { manifest_digest: manifest.digest, commit: manifest.source.commit, outcome: jobs.every((job) => ['passed', 'not_applicable'].includes(job.outcome)) ? 'passed' : 'failed', jobs };
}
