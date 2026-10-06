import { hostname } from 'node:os';
import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, fingerprintToolchain, logicalIdentifierSchema, resolveToolchain, type ToolchainDescriptor, type WorkflowLimits } from '../../workflows/src/index.ts';
import { RunnerClient, apiOrigin, type HttpOptions } from './client.ts';
import { RunnerError } from './errors.ts';
import { atomicJson, configDirectory, isFsError, privateDirectory, readJsonFile, stateDirectory, takeLock, within } from './files.ts';
import { capabilitiesSchema, runnerConfigurationSchema, type CompletionReceipt, type LogChunk, type RunnerConfiguration, type TerminationReceipt } from './protocol.ts';
import type { ProcessGroup } from './process.ts';
import { matchToolchain } from './toolchain.ts';
import { createIsolation, isolationPlatform, isolationSchema, parseIsolation, type IsolationRecord, type RunnerIsolation } from './isolation.ts';
import { createCredentialExchange } from './credential-exchange.ts';
import { finishCredentialExchange, pendingCredentialExchange, saveCredentialExchange, withCredentialExchangeLock, type PendingCredentialExchange } from './exchanges.ts';

export async function loadRunnerConfiguration(path: string): Promise<RunnerConfiguration> {
  const parsed = runnerConfigurationSchema.safeParse(await readJsonFile(path, 1_048_576, true));
  if (!parsed.success) throw new RunnerError('runner_config_invalid', 'The runner configuration is invalid. Re-enroll the runner if its credentials have been lost.');
  apiOrigin(parsed.data.api_origin, parsed.data.allow_loopback_http);
  await privateDirectory(dirname(resolve(path)));
  if (within(parsed.data.work_directory, path)) throw new RunnerError('credential_location', 'The runner configuration cannot be stored beneath its job work directory.');
  if (parsed.data.isolation.type === 'windows_user' && within(parsed.data.work_directory, parsed.data.isolation.credential_file)) throw new RunnerError('credential_location', 'The Windows batch-logon credential must be outside the job work directory.');
  return parsed.data;
}

export interface RegisterRunnerOptions extends Omit<HttpOptions, 'origin' | 'token'> {
  api_origin?: string;
  enrollment_token: string;
  name?: string;
  toolchains: Record<string, ToolchainDescriptor>;
  labels?: string[];
  disposable?: boolean;
  configuration_path?: string;
  state_directory?: string;
  work_directory?: string;
  allowed_git_origins?: string[];
  isolation: RunnerIsolation;
}

export async function registerRunner(options: RegisterRunnerOptions): Promise<{ configuration: RunnerConfiguration; path: string }> {
  const name = options.name ?? hostname();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name)) throw new RunnerError('runner_name_invalid', 'Runner name must contain letters, numbers, underscores, or hyphens.');
  if (!options.enrollment_token || /[\r\n\x00]/.test(options.enrollment_token)) throw new RunnerError('enrollment_invalid', 'Provide a one-time enrollment token on standard input.');
  const path = resolve(options.configuration_path ?? join(configDirectory(), 'runners', `${name}.json`));
  return withCredentialExchangeLock(path, () => registerUnlocked(options, name, path));
}

async function registerUnlocked(options: RegisterRunnerOptions, name: string, path: string): Promise<{ configuration: RunnerConfiguration; path: string }> {
  const isolationConfiguration = parseIsolation(options.isolation);
  const origin = apiOrigin(options.api_origin ?? 'https://api.gitknot.com', options.allow_loopback_http);
  const pending = await pendingCredentialExchange(path);
  if (pending) {
    if (pending.kind !== 'register' || pending.secret !== options.enrollment_token || pending.request.name !== name || pending.configuration.api_origin !== origin || canonicalJson(pending.configuration.toolchains) !== canonicalJson(options.toolchains) || canonicalJson(pending.configuration.isolation) !== canonicalJson(isolationConfiguration)) throw new RunnerError('credential_exchange_pending', 'An exact registration exchange is pending. Use runner recover with its original config path.');
    return { path, configuration: await finishCredentialExchange(path, pending, options) };
  }
  await privateDirectory(dirname(path));
  try { await lstat(path); throw new RunnerError('runner_already_registered', 'A runner configuration already exists at that path. Use credential rotation for an enrolled runner.'); }
  catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
  const state = await privateDirectory(options.state_directory ?? join(stateDirectory(), 'runners', name));
  const work = await privateDirectory(options.work_directory ?? join(stateDirectory(), 'work', name));
  if (within(work, state) || within(work, path)) throw new RunnerError('credential_location', 'Runner state and credentials must be outside the job work directory.');
  if (isolationConfiguration.type === 'windows_user' && within(work, isolationConfiguration.credential_file)) throw new RunnerError('credential_location', 'The Windows batch-logon credential must be outside the job work directory.');
  const probe = await mkdtemp(join(work, 'probe-'));
  await Promise.all(['source', 'home', 'inputs', 'control'].map((directory) => mkdir(join(probe, directory), { mode: directory === 'inputs' ? 0o755 : 0o700 })));
  const platform = await isolationPlatform(isolationConfiguration);
  const probeJournal = join(state, 'isolation-probe.json');
  try {
    const record = await readJsonFile(probeJournal, 4096, true) as IsolationRecord;
    const { recoverIsolation } = await import('./isolation.ts');
    await recoverIsolation(isolationConfiguration, record, 1_000, state); await rm(probeJournal);
  } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
  const isolation = createIsolation(isolationConfiguration, { workspace: join(probe, 'source'), home: join(probe, 'home'), inputs: join(probe, 'inputs'), control: join(probe, 'control'), directory: probe, deadline_at: Date.now() + 120_000, grace_ms: 1_000, onRecord: async record => { if (record) await atomicJson(probeJournal, record); else await rm(probeJournal, { force: true }); } });
  const toolchains: Record<string, string> = {};
  try {
    await isolation.prepare();
    for (const [alias, descriptor] of Object.entries(options.toolchains)) {
      await matchToolchain(await resolveToolchain(alias, options.toolchains), { cwd: join(probe, 'source'), home: join(probe, 'home'), execute: (executable, args, processOptions) => isolation.run(executable, args, processOptions), environment: isolation.environment(), platform });
      toolchains[alias] = await fingerprintToolchain(descriptor);
    }
  } finally { await isolation.stop(); await rm(probe, { recursive: true, force: true }); }
  if (!Object.keys(toolchains).length) throw new RunnerError('toolchain_missing', 'Enroll with at least one verified toolchain descriptor.');
  const capabilities = capabilitiesSchema.parse({ os: platform.os, arch: platform.arch, toolchains, labels: options.labels ?? [] });
  const draft: Omit<RunnerConfiguration, 'registration'> = {
    version: 1, api_origin: origin, capabilities, toolchains: options.toolchains,
    state_directory: state, work_directory: work, allow_loopback_http: options.allow_loopback_http ?? false,
    allowed_git_origins: options.allowed_git_origins ?? [origin.replace('://api.', '://git.')],
    isolation: isolationConfiguration,
  };
  const exchange: PendingCredentialExchange = { version: 1, kind: 'register', exchange: createCredentialExchange(0), secret: options.enrollment_token, request: { name, capabilities, slots: 1, disposable: options.disposable ?? false }, configuration: draft };
  await saveCredentialExchange(path, exchange);
  return { configuration: await finishCredentialExchange(path, exchange, options), path };
}

export async function rotateRunnerCredential(path: string, options: Pick<HttpOptions, 'fetch'> = {}): Promise<RunnerConfiguration> {
  return withCredentialExchangeLock(path, async () => {
    const pending = await pendingCredentialExchange(path);
    if (pending && pending.kind !== 'rotate') throw new RunnerError('credential_exchange_pending', 'Recover the pending registration before rotating its credential.');
    const configuration = pending?.configuration ?? await loadRunnerConfiguration(path);
    const unlock = await takeLock(configuration.state_directory);
    try {
      const exchange: PendingCredentialExchange = pending ?? { version: 1, kind: 'rotate', exchange: createCredentialExchange(configuration.registration.credential_generation), secret: configuration.registration.machine_token, request: {}, configuration };
      await saveCredentialExchange(path, exchange);
      return await finishCredentialExchange(path, exchange, options);
    } finally { await unlock(); }
  });
}

export async function recoverRunnerCredential(path: string, options: Pick<HttpOptions, 'fetch'> = {}): Promise<RunnerConfiguration> {
  return withCredentialExchangeLock(path, async () => {
    const exchange = await pendingCredentialExchange(path);
    if (!exchange) throw new RunnerError('credential_exchange_missing', 'No credential exchange is pending for this configuration.');
    const unlock = await takeLock(exchange.configuration.state_directory);
    try { return await finishCredentialExchange(path, exchange, options); } finally { await unlock(); }
  });
}

export interface AttemptJournal {
  version: 1;
  attempt_id: string;
  run_id: string;
  job_id: string;
  generation: number;
  runner_id: string;
  lease_token: string;
  lease_expires_at: string;
  deadline_at: string;
  manifest_digest: string;
  commit: string;
  toolchain_fingerprint: string;
  started_at: string;
  state: 'running' | 'ready' | 'accepted' | 'fenced';
  directory: string | null;
  groups: ProcessGroup[];
  logs: LogChunk[];
  uploaded_logs: number;
  limits: WorkflowLimits;
  receipt?: CompletionReceipt;
  receipt_digest?: string;
  termination?: TerminationReceipt;
  termination_digest?: string;
  termination_acknowledged?: boolean;
  isolation?: IsolationRecord | null;
  isolation_allocations?: IsolationRecord[];
}

export class JournalStore {
  private queue: Promise<void> = Promise.resolve();
  constructor(readonly directory: string) {}
  get path(): string { return join(this.directory, 'journal.json'); }
  save(journal: AttemptJournal): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(journal)) as AttemptJournal;
    this.queue = this.queue.then(() => atomicJson(this.path, snapshot));
    return this.queue;
  }
  async initialize(journal: AttemptJournal): Promise<void> {
    await mkdir(this.directory, { recursive: false, mode: 0o700 });
    await this.save(journal);
  }
  async load(): Promise<AttemptJournal> {
    const value = await readJsonFile(this.path, 4_194_304, true);
    const parsed = z.object({
      version: z.literal(1), attempt_id: z.string().regex(/^[a-zA-Z0-9_-]+$/), run_id: z.string(), job_id: logicalIdentifierSchema,
      generation: z.number().int().positive(), runner_id: z.string(), lease_token: z.string().min(16), lease_expires_at: z.string(), deadline_at: z.string(),
      manifest_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), commit: z.string(), toolchain_fingerprint: z.string(), started_at: z.string(),
      state: z.enum(['running', 'ready', 'accepted', 'fenced']), directory: z.string().nullable(),
      groups: z.array(z.object({ pid: z.number().int().positive(), identity: z.string().nullable() })),
      logs: z.array(z.object({ sequence: z.number().int().nonnegative(), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), size_bytes: z.number().int().nonnegative() })),
      uploaded_logs: z.number().int().nonnegative(), limits: z.record(z.string(), z.number()),
      receipt: z.unknown().optional(), receipt_digest: z.string().optional(),
    }).safeParse(value);
    if (!parsed.success) throw new RunnerError('journal_invalid', 'The runner journal is invalid; inspect the private state before resuming.');
    return value as AttemptJournal;
  }
}
