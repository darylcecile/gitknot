import { open, mkdir, rm } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_TYPED_OUTPUT_WIRE_BYTES, digestJson, logicalIdentifierSchema, resolveLimits, sha256, verifyManifest, type RunManifest } from '../../workflows/src/index.ts';
import { fileDigest } from './archive.ts';
import { RunnerClient } from './client.ts';
import { abortError, RunnerApiError, RunnerError, throwIfAborted } from './errors.ts';
import { atomicWrite, directoryEntries, isFsError, privateDirectory, readBounded, removeAndVerify, takeLock, within } from './files.ts';
import { decodeOutputWire, type StoredOutput } from './outputs.ts';
import { groupAlive, processIdentity, terminateGroup } from './process.ts';
import type { Assignment, AttemptAuth, CompletionReceipt, ReceiptOutput, RunnerConfiguration } from './protocol.ts';
import { executeJob, type JobExecutionResult } from './runtime.ts';
import { isolationPlatform, parseIsolation, recoverIsolation } from './isolation.ts';
import { JournalStore, loadRunnerConfiguration, type AttemptJournal } from './state.ts';
import { utf8Chunks } from './encoding.ts';
import { pendingCredentialExchange } from './exchanges.ts';

export interface RunRunnerOptions {
  signal?: AbortSignal;
  once?: boolean;
  max_assignments?: number;
  grace_ms?: number;
  idle_delay_ms?: number;
  /** Explicit local test adapter; never accepted from a server assignment or config file. */
  allow_local_source?: boolean;
  fetch?: typeof fetch;
  onStatus?: (status: { type: string; attempt_id?: string; outcome?: string }) => void;
}

interface AttemptWatch {
  signal: AbortSignal;
  fenced: boolean;
  fence: (error: RunnerError) => void;
  stop: () => Promise<void>;
}

function authFor(journal: AttemptJournal): AttemptAuth {
  return { runner_id: journal.runner_id, generation: journal.generation, lease_token: journal.lease_token };
}

function live(journal: AttemptJournal): boolean {
  return Date.now() < Math.min(Date.parse(journal.lease_expires_at), Date.parse(journal.deadline_at));
}

function watchAttempt(client: RunnerClient, journal: AttemptJournal, store: JournalStore, intervalMs: number): AttemptWatch {
  const fenced = new AbortController();
  const stopped = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const state: AttemptWatch = {
    signal: fenced.signal, fenced: false,
    fence: (error) => { state.fenced = true; fenced.abort(error); },
    stop: async () => { clearTimeout(timer); stopped.abort(); await loop; },
  };
  const arm = () => {
    clearTimeout(timer);
    const remaining = Math.min(Date.parse(journal.lease_expires_at), Date.parse(journal.deadline_at)) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) { state.fence(new RunnerError('lease_expired', 'The attempt lease or absolute deadline expired.')); return; }
    timer = setTimeout(() => state.fence(new RunnerError('lease_expired', 'The attempt lease or absolute deadline expired.')), remaining);
  };
  arm();
  const loop = (async () => {
    const signal = AbortSignal.any([stopped.signal, fenced.signal]);
    while (!signal.aborted) {
      try {
        const wait = Math.max(100, Math.min(intervalMs, (Date.parse(journal.lease_expires_at) - Date.now()) / 3));
        await delay(wait, undefined, { signal });
        const result = await client.attemptHeartbeat(journal.attempt_id, authFor(journal), signal);
        if (result.status !== 'active') {
          state.fence(new RunnerError(result.status === 'expired' ? 'lease_expired' : 'attempt_fenced', 'GitKnot fenced this attempt.'));
          break;
        }
        if (result.lease_expires_at) {
          const next = Date.parse(result.lease_expires_at);
          if (!Number.isFinite(next) || next <= Date.now() || next > Date.parse(journal.deadline_at)) {
            state.fence(new RunnerError('attempt_fenced', 'GitKnot returned an invalid lease extension.'));
            break;
          }
          journal.lease_expires_at = result.lease_expires_at;
          await store.save(journal);
          arm();
        }
      } catch (error) {
        if (signal.aborted) break;
        if (error instanceof RunnerApiError && error.fenced) { state.fence(new RunnerError('attempt_fenced', 'GitKnot no longer authorizes this attempt.')); break; }
        // Connectivity does not manufacture a lease extension. The independent timer remains armed.
        if (error instanceof RunnerError && !['api_unavailable', 'api_timeout'].includes(error.code) && !(error instanceof RunnerApiError && (error.status === 429 || error.status >= 500))) {
          state.fence(new RunnerError('attempt_fenced', 'The attempt heartbeat could not be validated.')); break;
        }
      }
    }
  })();
  return state;
}

function assertAssignment(assignment: Assignment, configuration: RunnerConfiguration): void {
  const runner = configuration.registration;
  const manifest = assignment.manifest;
  const job = manifest.jobs.find((entry) => entry.id === assignment.job_id);
  if (!job || job.executor.type !== 'self_hosted' || ![runner.pool_id, runner.pool_name].includes(job.executor.pool) && job.producer_id !== `pool:${runner.pool_id}`) throw new RunnerError('assignment_pool', 'The assignment does not match this customer runner pool.');
  if (!runner.repository_ids.includes(manifest.repo_id)) throw new RunnerError('assignment_scope', 'The assignment repository is outside this runner registration.');
  const producers = [runner.runner_id, `runner:${runner.runner_id}`, `pool:${runner.pool_id}`, ...(runner.pool_name ? [`pool:${runner.pool_name}`] : [])];
  if (!producers.includes(job.producer_id)) throw new RunnerError('assignment_producer', 'The immutable plan does not authorize this producer identity.');
  if (manifest.trust.level !== runner.trust || ((manifest.trust.fork || manifest.trust.level === 'untrusted') && !runner.disposable)) throw new RunnerError('assignment_trust', 'The assignment violates this machine’s disposable/trust constraints.');
  if (configuration.capabilities.toolchains[job.toolchain.name] !== job.toolchain.fingerprint || job.toolchain.os !== configuration.capabilities.os || job.toolchain.arch !== configuration.capabilities.arch) throw new RunnerError('assignment_toolchain', 'The assignment does not match this runner’s advertised toolchain.');
  if (assignment.source.commit !== manifest.source.commit) throw new RunnerError('source_mismatch', 'Assignment source does not match the frozen manifest.');
  const lease = Date.parse(assignment.lease_expires_at);
  const deadline = Date.parse(assignment.deadline_at);
  if (lease <= Date.now() || deadline <= Date.now() || lease > deadline || deadline - Date.now() > manifest.limits.max_timeout_ms + 60_000) throw new RunnerError('assignment_expired', 'Assignment lease/deadline is expired or invalid.');
}

async function downloadInputs(client: RunnerClient, assignment: Assignment, journal: AttemptJournal, directory: string, signal: AbortSignal): Promise<Record<string, StoredOutput>> {
  const inputs: Record<string, StoredOutput> = {};
  const job = assignment.manifest.jobs.find((entry) => entry.id === assignment.job_id)!;
  let total = 0;
  for (const input of assignment.inputs ?? []) {
    const definition = assignment.manifest.jobs.find((entry) => entry.id === input.job_id)?.outputs[input.name];
    const key = `jobs.${input.job_id}.${input.name}`;
    if (!job.needs.includes(input.job_id) || !definition || definition.type !== input.type || Object.hasOwn(inputs, key)) throw new RunnerError('input_scope', 'An input is not a declared, typed dependency output.');
    if (!input.download_path.startsWith(`/v1/attempts/${assignment.attempt_id}/`)) throw new RunnerError('input_scope', 'An input download is outside this attempt capability.');
    total += input.size_bytes;
    if (total > assignment.manifest.limits.max_input_bytes) throw new RunnerError('input_limit', 'Combined dependency inputs exceed their byte limit.');
    const path = join(directory, `${input.job_id}.${input.name}`);
    await client.download(input.download_path, path, input, { signal, max_bytes: assignment.manifest.limits.max_input_bytes, headers: { 'X-GitKnot-Runner': journal.runner_id, 'X-GitKnot-Generation': String(journal.generation), 'X-GitKnot-Lease': journal.lease_token } });
    let value: unknown;
    if (input.type !== 'artifact') {
      value = decodeOutputWire(await readBounded(path, MAX_TYPED_OUTPUT_WIRE_BYTES), input.type);
    }
    inputs[key] = { name: input.name, kind: input.type === 'artifact' ? 'artifact' : 'value', type: input.type, path, digest: input.digest, size_bytes: input.size_bytes, media_type: input.type === 'artifact' ? 'application/vnd.gitknot.files+ndjson' : 'application/json', retention_seconds: definition.retention_seconds, ...(input.type !== 'artifact' ? { value } : {}) };
  }
  return inputs;
}

async function replayLogs(client: RunnerClient, journal: AttemptJournal, store: JournalStore, signal?: AbortSignal): Promise<void> {
  for (const chunk of journal.logs.slice(journal.uploaded_logs)) {
    const data = await readBounded(join(store.directory, 'logs', `${chunk.sequence}.bin`), journal.limits.max_chunk_bytes, true);
    await client.log(journal.attempt_id, authFor(journal), chunk, data, signal);
    journal.uploaded_logs = chunk.sequence + 1;
    await store.save(journal);
  }
}

async function uploadOutput(client: RunnerClient, journal: AttemptJournal, output: StoredOutput, signal: AbortSignal): Promise<ReceiptOutput> {
  const actual = await fileDigest(output.path, journal.limits.max_output_bytes, signal);
  if (actual.digest !== output.digest || actual.size_bytes !== output.size_bytes) throw new RunnerError('output_checksum', 'An output changed before upload.');
  const file = await open(output.path, 'r');
  const chunks: ReceiptOutput['chunks'] = [];
  let position = 0;
  try {
    do {
      throwIfAborted(signal);
      const data = Buffer.alloc(Math.min(journal.limits.max_chunk_bytes, output.size_bytes - position));
      const { bytesRead } = await file.read(data, 0, data.length, position);
      if (bytesRead !== data.length) throw new RunnerError('output_changed', 'An output changed during upload.');
      const chunk = { sequence: chunks.length, digest: await sha256(data), size_bytes: bytesRead };
      position += bytesRead;
      await client.output(journal.attempt_id, authFor(journal), { ...chunk, name: output.name, kind: output.kind, final: position === output.size_bytes, media_type: output.media_type, retention_seconds: output.retention_seconds }, data, signal);
      chunks.push(chunk);
    } while (position < output.size_bytes);
  } finally { await file.close(); }
  return { name: output.name, kind: output.kind, digest: output.digest, size_bytes: output.size_bytes, chunks };
}

function makeReceipt(journal: AttemptJournal, result: JobExecutionResult, outputs: ReceiptOutput[]): CompletionReceipt {
  return {
    version: 1, attempt_id: journal.attempt_id, run_id: journal.run_id, job_id: journal.job_id, runner_id: journal.runner_id, generation: journal.generation,
    manifest_digest: journal.manifest_digest, commit: journal.commit, toolchain_fingerprint: journal.toolchain_fingerprint,
    outcome: result.outcome, started_at: result.started_at, finished_at: result.finished_at,
    exit_code: result.exit_code, signal: result.signal, reason: result.reason, logs: journal.logs, outputs, steps: result.steps, cleanup_confirmed: true,
  };
}

async function acknowledgeTermination(client: RunnerClient, journal: AttemptJournal, store: JournalStore): Promise<void> {
  if (!journal.termination || !journal.termination_digest || journal.termination_acknowledged) return;
  if (await digestJson(journal.termination) !== journal.termination_digest) throw new RunnerError('journal_invalid', 'Termination receipt checksum is invalid.');
  try {
    await client.terminated(journal.attempt_id, authFor(journal), journal.termination, journal.termination_digest);
    journal.termination_acknowledged = true; await store.save(journal);
  } catch (error) {
    if (!(error instanceof RunnerError)) throw error;
    // A cleanup-only acknowledgement is retained for reconciliation. It never publishes outputs.
  }
}

async function fenceJournal(journal: AttemptJournal, store: JournalStore, client?: RunnerClient): Promise<void> {
  journal.state = 'fenced';
  if (!journal.groups.some((group) => groupAlive(group.pid))) {
    journal.termination ??= { version: 1, attempt_id: journal.attempt_id, runner_id: journal.runner_id, generation: journal.generation, manifest_digest: journal.manifest_digest, commit: journal.commit, finished_at: new Date().toISOString(), cleanup_confirmed: true };
    journal.termination_digest ??= await digestJson(journal.termination);
  }
  await store.save(journal);
  if (client) await acknowledgeTermination(client, journal, store);
}

async function acknowledgeReceipt(client: RunnerClient, journal: AttemptJournal, store: JournalStore, signal?: AbortSignal): Promise<boolean> {
  if (!journal.receipt || !journal.receipt_digest || await digestJson(journal.receipt) !== journal.receipt_digest) throw new RunnerError('receipt_invalid', 'A durable completion receipt failed verification.');
  if (!live(journal)) { await fenceJournal(journal, store, client); return false; }
  try {
    await client.complete(journal.attempt_id, authFor(journal), journal.receipt, journal.receipt_digest, signal);
    journal.state = 'accepted';
    await store.save(journal);
    await Promise.all(['logs', 'outputs', 'inputs'].map((name) => rm(join(store.directory, name), { recursive: true, force: true })));
    return true;
  } catch (error) {
    if (error instanceof RunnerApiError && error.fenced) { await fenceJournal(journal, store, client); return false; }
    throw error;
  }
}

async function recoverJournals(client: RunnerClient, configuration: RunnerConfiguration, options: RunRunnerOptions): Promise<number> {
  const attempts = join(configuration.state_directory, 'attempts');
  let recovered = 0;
  for (const name of await directoryEntries(attempts)) {
    if (!/^[a-zA-Z0-9_-]+\.[0-9]+$/.test(name)) continue;
    const store = new JournalStore(join(attempts, name));
    const journal = await store.load();
    if (journal.runner_id !== configuration.registration.runner_id || name !== `${journal.attempt_id}.${journal.generation}`) throw new RunnerError('journal_scope', 'A journal belongs to another runner or attempt.');
    journal.limits = resolveLimits(journal.limits);
    if (journal.state === 'accepted') continue;
    if (journal.state === 'fenced') { await acknowledgeTermination(client, journal, store); continue; }
    if (journal.state === 'running') {
      if (journal.isolation) {
        await recoverIsolation(configuration.isolation, journal.isolation, options.grace_ms ?? 5_000, configuration.state_directory);
        journal.isolation = null; await store.save(journal);
      }
      for (const group of journal.groups) {
        if (!groupAlive(group.pid)) continue;
        if (!group.identity || await processIdentity(group.pid) !== group.identity) throw new RunnerError('runner_recovery_blocked', 'A leftover process group cannot be identified safely. Recycle the disposable machine or stop the recorded job processes before restarting.');
        await terminateGroup(group.pid, options.grace_ms);
        if (groupAlive(group.pid)) throw new RunnerError('cleanup_failed', 'Interrupted job processes could not be terminated.');
      }
      if (journal.directory) {
        if (!within(configuration.work_directory, journal.directory) || !basename(journal.directory).startsWith(`${journal.job_id}-`)) throw new RunnerError('journal_scope', 'Interrupted workspace is outside the runner work directory.');
        await removeAndVerify(journal.directory);
      }
      journal.groups = []; journal.directory = null;
      if (!live(journal)) { await fenceJournal(journal, store, client); continue; }
      await replayLogs(client, journal, store, options.signal);
      journal.receipt = {
        version: 1, attempt_id: journal.attempt_id, run_id: journal.run_id, job_id: journal.job_id, runner_id: journal.runner_id, generation: journal.generation,
        manifest_digest: journal.manifest_digest, commit: journal.commit, toolchain_fingerprint: journal.toolchain_fingerprint,
        outcome: 'failed', started_at: journal.started_at, finished_at: new Date().toISOString(), exit_code: null, signal: null,
        reason: 'runner_interrupted: The runner restarted before durable completion; commands were not rerun.', logs: journal.logs, outputs: [], steps: [], cleanup_confirmed: true,
      };
      journal.receipt_digest = await digestJson(journal.receipt); journal.state = 'ready';
      await store.save(journal);
    }
    await acknowledgeReceipt(client, journal, store, options.signal);
    recovered += 1;
  }
  return recovered;
}

async function executeAssignment(client: RunnerClient, configuration: RunnerConfiguration, assignment: Assignment, options: RunRunnerOptions, setActive: (watch: AttemptWatch | null) => void): Promise<boolean> {
  assertAssignment(assignment, configuration);
  const job = assignment.manifest.jobs.find((entry) => entry.id === assignment.job_id)!;
  const store = new JournalStore(join(configuration.state_directory, 'attempts', `${assignment.attempt_id}.${assignment.generation}`));
  try {
    const existing = await store.load();
    if (existing.manifest_digest !== assignment.manifest.digest || existing.job_id !== assignment.job_id) throw new RunnerError('assignment_conflict', 'An existing attempt identity was redelivered with different immutable inputs.');
    if (existing.state === 'accepted') return true;
    if (existing.state === 'ready') return acknowledgeReceipt(client, existing, store, options.signal);
    // Crash recovery ran before polling. A repeated running/fenced identity is never executed twice.
    throw new RunnerError('assignment_duplicate', 'GitKnot redelivered an interrupted or fenced attempt; a new generation is required.');
  } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
  const journal: AttemptJournal = {
    version: 1, attempt_id: assignment.attempt_id, run_id: assignment.run_id, job_id: assignment.job_id, generation: assignment.generation,
    runner_id: configuration.registration.runner_id, lease_token: assignment.lease_token, lease_expires_at: assignment.lease_expires_at, deadline_at: assignment.deadline_at,
    manifest_digest: assignment.manifest.digest, commit: assignment.manifest.source.commit, toolchain_fingerprint: job.toolchain.fingerprint,
    started_at: new Date().toISOString(), state: 'running', directory: null, groups: [], logs: [], uploaded_logs: 0, limits: assignment.manifest.limits,
  };
  await store.initialize(journal);
  client.addRedactions([assignment.lease_token, ...(assignment.source.token ? [assignment.source.token] : [])]);
  const watch = watchAttempt(client, journal, store, configuration.registration.heartbeat_interval_seconds * 1_000);
  setActive(watch);
  const executionSignal = options.signal ? AbortSignal.any([watch.signal, options.signal]) : watch.signal;
  let executing = false;
  let cleanupConfirmed = false;
  let logQueue: Promise<void> = Promise.resolve();
  const writeLog = (bytes: Uint8Array): Promise<void> => {
    logQueue = logQueue.then(async () => {
      for (const data of utf8Chunks(bytes, journal.limits.max_chunk_bytes)) {
        throwIfAborted(watch.signal);
        const chunk = { sequence: journal.logs.length, digest: await sha256(data), size_bytes: data.byteLength };
        await atomicWrite(join(store.directory, 'logs', `${chunk.sequence}.bin`), data);
        journal.logs.push(chunk); await store.save(journal);
        await client.log(journal.attempt_id, authFor(journal), chunk, data, watch.signal);
        journal.uploaded_logs = chunk.sequence + 1; await store.save(journal);
      }
    });
    return logQueue;
  };
  try {
    const inputs = await downloadInputs(client, assignment, journal, join(store.directory, 'inputs'), watch.signal);
    executing = true;
    const result = await executeJob(assignment.manifest, assignment.job_id, {
      source: assignment.source, work_root: configuration.work_directory, output_directory: join(store.directory, 'outputs'), cache_directory: join(configuration.state_directory, 'caches'),
      deadline_at: Date.parse(assignment.deadline_at), signal: executionSignal, grace_ms: options.grace_ms,
      allow_local_source: options.allow_local_source, allowed_git_origins: configuration.allowed_git_origins,
      variables: assignment.variables, inputs, approved_environment: assignment.approved_environment,
      redaction_secrets: [configuration.registration.machine_token, assignment.lease_token],
      isolation: configuration.isolation,
      onIsolation: async (record) => { journal.isolation = record; if (record) (journal.isolation_allocations ??= []).push(record); await store.save(journal); },
      secretProvider: async (stepId, names, signal) => {
        const values = await client.secrets(assignment.attempt_id, authFor(journal), stepId, names, signal);
        client.addRedactions(Object.values(values)); return values;
      },
      onLog: writeLog,
      onGroups: async (groups, directory) => { journal.groups = groups; journal.directory = directory; await store.save(journal); },
    });
    cleanupConfirmed = true;
    await logQueue.catch(() => {});
    if (watch.fenced || !live(journal)) { await fenceJournal(journal, store, client); return false; }
    await replayLogs(client, journal, store, watch.signal);
    const outputs: ReceiptOutput[] = [];
    for (const output of result.outputs) outputs.push(await uploadOutput(client, journal, output, watch.signal));
    journal.receipt = makeReceipt(journal, result, outputs);
    journal.receipt_digest = await digestJson(journal.receipt); journal.state = 'ready';
    await store.save(journal);
    const accepted = await acknowledgeReceipt(client, journal, store, watch.signal);
    options.onStatus?.({ type: accepted ? 'completed' : 'fenced', attempt_id: assignment.attempt_id, outcome: result.outcome });
    return accepted;
  } catch (error) {
    if (executing && !cleanupConfirmed) throw error;
    if (watch.fenced || (error instanceof RunnerApiError && error.fenced)) { await fenceJournal(journal, store, client); return false; }
    throw error;
  } finally { setActive(null); await watch.stop(); }
}

/** Outbound-only, one-slot worker loop with durable receipt recovery and lease fencing. */
export async function runRunner(configurationInput: RunnerConfiguration | string, options: RunRunnerOptions = {}): Promise<{ completed: number; fenced: number; recovered: number }> {
  if (typeof configurationInput === 'string' && await pendingCredentialExchange(configurationInput)) throw new RunnerError('credential_exchange_pending', 'Recover the pending credential exchange before starting this runner.');
  const configuration = typeof configurationInput === 'string' ? await loadRunnerConfiguration(configurationInput) : configurationInput;
  configuration.isolation = parseIsolation(configuration.isolation);
  await isolationPlatform(configuration.isolation);
  await privateDirectory(configuration.state_directory); await privateDirectory(configuration.work_directory);
  if (within(configuration.work_directory, configuration.state_directory)) throw new RunnerError('credential_location', 'Runner state cannot be inside the job work directory.');
  await mkdir(join(configuration.state_directory, 'attempts'), { recursive: true, mode: 0o700 });
  const unlock = await takeLock(configuration.state_directory);
  let unlockIdentity: (() => Promise<void>) | undefined;
  const stopped = new AbortController();
  const signal = options.signal ? AbortSignal.any([stopped.signal, options.signal]) : stopped.signal;
  const client = new RunnerClient({ origin: configuration.api_origin, token: configuration.registration.machine_token, allow_loopback_http: configuration.allow_loopback_http, fetch: options.fetch });
  const active: { watch: AttemptWatch | null; assignment: Assignment | null; error: RunnerError | null } = { watch: null, assignment: null, error: null };
  let heartbeatLoop: Promise<void> | undefined;
  const result = { completed: 0, fenced: 0, recovered: 0 };
  try {
    if (configuration.isolation.type === 'posix_user') unlockIdentity = await takeLock(`/var/run/gitknot/execution-user-${configuration.isolation.uid}`);
    if (configuration.isolation.type === 'windows_user') unlockIdentity = await takeLock(join(process.env.ProgramData ?? 'C:\\ProgramData', 'GitKnot', 'native-execution-lock'));
    if (Date.parse(configuration.registration.credential_expires_at) <= Date.now()) throw new RunnerError('runner_credential_expired', 'The machine credential expired. Re-enroll this runner.');
    result.recovered = await recoverJournals(client, configuration, options);
    if (configuration.registration.disposable && (await directoryEntries(join(configuration.state_directory, 'attempts'))).length) return result;
    heartbeatLoop = (async () => {
      while (!signal.aborted) {
        try {
          if (Date.parse(configuration.registration.credential_expires_at) <= Date.now()) throw new RunnerError('runner_credential_expired', 'The machine credential expired.');
          const response = await client.heartbeat(configuration.registration, configuration.capabilities, active.assignment ? [{ attempt_id: active.assignment.attempt_id, generation: active.assignment.generation }] : [], signal);
          if (response.status === 'revoked') throw new RunnerError('runner_revoked', 'This runner was revoked.');
          if (active.assignment && response.cancel_attempt_ids.includes(active.assignment.attempt_id)) active.watch?.fence(new RunnerError('attempt_fenced', 'GitKnot cancelled this attempt.'));
        } catch (error) {
          if (signal.aborted) break;
          if ((error instanceof RunnerApiError && error.fenced) || (error instanceof RunnerError && ['runner_revoked', 'runner_credential_expired', 'heartbeat_invalid'].includes(error.code))) {
            active.error = new RunnerError('runner_revoked', 'GitKnot no longer authorizes this runner.'); active.watch?.fence(active.error); stopped.abort(active.error); break;
          }
        }
        await delay(configuration.registration.heartbeat_interval_seconds * 1_000, undefined, { signal }).catch(() => {});
      }
    })();
    const maximum = configuration.registration.disposable ? 1 : options.max_assignments ?? Number.MAX_SAFE_INTEGER;
    let assignments = 0;
    while (!signal.aborted && assignments < maximum) {
      const assignment = await client.poll(configuration.registration, configuration.capabilities, signal);
      if (!assignment) {
        if (options.once) break;
        await delay(options.idle_delay_ms ?? 1_000, undefined, { signal }).catch(() => {});
        continue;
      }
      await verifyManifest(assignment.manifest);
      active.assignment = assignment;
      options.onStatus?.({ type: 'assigned', attempt_id: assignment.attempt_id });
      const accepted = await executeAssignment(client, configuration, assignment, { ...options, signal }, (watch) => { active.watch = watch; });
      active.assignment = null;
      assignments += 1;
      if (accepted) result.completed += 1; else result.fenced += 1;
      if (options.once) break;
    }
    if (active.error) throw active.error;
    return result;
  } catch (error) {
    if (active.error) throw active.error;
    if (options.signal?.aborted) return result;
    throw error;
  } finally {
    stopped.abort();
    await heartbeatLoop;
    await unlockIdentity?.();
    await unlock();
  }
}
