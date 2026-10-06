import { Sandbox as CloudflareSandbox } from '@cloudflare/sandbox';
import type { BackupOptions, DirectoryBackup, ExecOptions, ProcessOptions } from '@cloudflare/sandbox';
import { ApiError, execute, now, one } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import { authorizeExecutionActor, fenceExecutionAuthority } from '@gitknot/execution/authorization';
import { primary } from '@gitknot/execution/store';
import { bounded } from '@gitknot/execution/transport';
import type { DestructionReceipt } from '@gitknot/execution/attempt-machine';
import { RuntimeJournal, guardedContext } from '@gitknot/execution/hosted/runtime-journal';
import { LOCAL_SCOPE_KEY, localAttemptEnvironment, localFenced, localRuntimeGrant, localScope } from '@gitknot/execution/hosted/local-runtime';
import type { LocalRuntimeRequest, LocalRuntimeScope } from '@gitknot/execution/hosted/local-runtime';
import type { RuntimeFacts, RuntimeRecord } from '@gitknot/execution/hosted/runtime-types';
import { CONTROL_DIR, SNAPSHOT_DIR, stopJobProcessesScript } from '@gitknot/execution/hosted/scripts';
import { authorizeEgress, chargeEgress, finishEgress, outbound } from './egress.ts';
import { LocalSnapshotStore } from './snapshot-bucket.ts';

const noSession = '__DISABLE_SESSION__';
type Sdk = CloudflareSandbox<Bindings>;

/** Real pinned SDK; one permanently fenced VM identity per local attempt. */
export class Sandbox extends CloudflareSandbox<Bindings> {
  override enableInternet = false;
  override interceptHttps = true;
  override sleepAfter = '60s';
  static {
    this.outbound = outbound;
    this.outboundHandlers = { gitknot: outbound };
  }
  private readonly journal: RuntimeJournal;
  private readonly snapshots: LocalSnapshotStore;
  private readonly runtimeEnv: Bindings;
  private cleanupCalls = 0;
  private destruction: Promise<DestructionReceipt> | null = null;
  private leaseWrite: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Bindings) {
    const journal = new RuntimeJournal(ctx), snapshots = new LocalSnapshotStore(env, journal);
    // Trusted DB/identity/billing bindings stay in the Worker, not SDK env or VM.
    super(guardedContext(ctx, journal) as DurableObjectState<{}>, { BACKUP_BUCKET: snapshots.binding(), SANDBOX_TRANSPORT: 'rpc', SANDBOX_LOG_LEVEL: 'error' } as unknown as Bindings);
    this.journal = journal; this.snapshots = snapshots; this.runtimeEnv = env;
  }

  private scope(input?: LocalRuntimeRequest): LocalRuntimeScope {
    const scope = this.journal.ctx.storage.kv.get<LocalRuntimeScope>(LOCAL_SCOPE_KEY);
    if (!scope || input && (input.attempt_id !== scope.attempt_id || input.generation !== scope.generation)) throw localFenced();
    return scope;
  }
  private usable(): RuntimeRecord {
    if (!this.scope().activated || this.journal.ctx.storage.kv.get<{ sealed?: boolean }>('gitknot:runtime')?.sealed) throw localFenced();
    return this.journal.active();
  }

  async arm(input: LocalRuntimeRequest): Promise<{ armed: true }> {
    const prior = this.journal.read();
    if (prior?.sealed || this.journal.ctx.storage.kv.get<{ sealed?: boolean }>('gitknot:runtime')?.sealed) throw localFenced();
    const selected = await localAttemptEnvironment(this.runtimeEnv, input, true), scope = localScope(selected.env, selected.context);
    if (scope.runtime_id !== this.journal.ctx.id.toString()) throw localFenced();
    const old = this.journal.ctx.storage.kv.get<LocalRuntimeScope>(LOCAL_SCOPE_KEY);
    if (old && (old.attempt_id !== scope.attempt_id || old.generation !== scope.generation || old.plan_digest !== scope.plan_digest || old.runtime_id !== scope.runtime_id)) throw localFenced();
    if (!old) { this.journal.ctx.storage.kv.put(LOCAL_SCOPE_KEY, scope); await this.journal.ctx.storage.sync(); }
    await this.journal.arm(await localRuntimeGrant(selected.env, selected.context));
    await execute(primary(selected.env), `INSERT OR IGNORE INTO execution_runtime_receipts
      (runtime_id,attempt_id,repo_id,account_id,generation,receipt_id,state,armed_at,updated_at) VALUES (?,?,?,?,?,?,'armed',?,?)`,
    scope.runtime_id, scope.attempt_id, scope.repo_id, scope.account_id, scope.generation, `destroy_${scope.attempt_id}_${scope.generation}`, scope.allocated_at, now());
    await this.setOutboundHandler('gitknot');
    await this.setKeepAlive(true);
    await this.scheduleReaper();
    return { armed: true };
  }

  async activate(input: LocalRuntimeRequest, sourceUrl: string): Promise<{ lease_expires_at: string }> {
    await this.arm(input);
    const selected = await localAttemptEnvironment(this.runtimeEnv, input, true), { attempt: a } = selected.context;
    if (!a.execution_started_at || a.status !== 'running') throw localFenced();
    const source = new URL(sourceUrl), origin = new URL(this.runtimeEnv.GIT_ORIGIN);
    if (source.protocol !== 'https:' || source.origin !== origin.origin || source.username || source.password || source.search || source.hash) throw localFenced();
    await fenceExecutionAuthority(selected.env, selected.context, await authorizeExecutionActor(selected.env, selected.context.plan), 'local-runtime-start');
    const record = this.journal.active(), scope = this.scope(input);
    if (scope.activated) throw localFenced();
    this.journal.ctx.storage.kv.put(LOCAL_SCOPE_KEY, { ...scope, activated: true });
    this.journal.ctx.storage.kv.put('hosted:runtime', { ...record, source_url: source.href });
    await this.journal.ctx.storage.sync();
    await this.journal.renew(record, a.lease_expires_at!);
    return { lease_expires_at: a.lease_expires_at! };
  }

  async refreshLease(input: LocalRuntimeRequest): Promise<{ lease_expires_at: string }> {
    this.scope(input); this.usable();
    const selected = await localAttemptEnvironment(this.runtimeEnv, input, true), a = selected.context.attempt;
    if (!a.execution_started_at || a.status !== 'running') throw localFenced();
    const record = this.journal.read()!;
    await this.journal.renew(record, a.lease_expires_at!);
    await this.syncCounters(selected.env);
    const write = this.leaseWrite.then(async () => {
      if (!this.journal.ctx.container?.running || !this.journal.ctx.storage.kv.get('hosted:lease-file-enabled')) return;
      const current = this.usable();
      await this.writeFile(`${CONTROL_DIR}/lease.next`, JSON.stringify({ lease_expires_at: current.lease_expires_at, deadline_at: current.deadline_at }), { sessionId: noSession });
      const result = await this.exec(`chmod 600 ${CONTROL_DIR}/lease.next && mv -f ${CONTROL_DIR}/lease.next ${CONTROL_DIR}/lease.json`, { timeout: 5000 });
      if (!result.success) throw new ApiError(503, 'lease_update_failed', 'The root lease watchdog could not be updated.');
    });
    this.leaseWrite = write.catch(() => undefined); await write;
    await this.scheduleReaper();
    return { lease_expires_at: this.journal.read()!.lease_expires_at };
  }

  async enableLeaseFile(input: LocalRuntimeRequest): Promise<void> {
    this.scope(input); this.usable();
    this.journal.ctx.storage.kv.put('hosted:lease-file-enabled', true); await this.journal.ctx.storage.sync();
    await this.refreshLease(input);
  }
  async checkoutComplete(input: LocalRuntimeRequest): Promise<void> { this.scope(input); await this.journal.checkoutComplete(); }
  async runtimeStatus(input: LocalRuntimeRequest): Promise<RuntimeFacts> { this.scope(input); return this.journal.facts(this.journal.read()!); }

  override start(...args: Parameters<Sdk['start']>): Promise<void> { this.usable(); return this.journal.start(() => super.start(...args)); }
  override startAndWaitForPorts: Sdk['startAndWaitForPorts'] = ((...args: Parameters<Sdk['startAndWaitForPorts']>) => {
    this.usable(); return this.journal.start(() => super.startAndWaitForPorts(...args));
  }) as Sdk['startAndWaitForPorts'];

  override async onStart(): Promise<void> {
    try { this.usable(); }
    catch (error) {
      const record = this.journal.read(); if (record) await this.journal.seal(record);
      await super.destroy(); throw error;
    }
    // The inherited hook starts unawaited version/preview/tunnel work. Hosted
    // jobs verify the actual pinned toolchain explicitly, under the SDK journal.
    await this.scheduleReaper();
  }
  override async onStop(): Promise<void> {
    const record = this.journal.read(); if (record) await this.journal.seal(record);
    await super.onStop(); await this.scheduleReaper();
  }
  override async onActivityExpired(): Promise<void> {
    const record = this.journal.read();
    if (record && (record.sealed || Math.min(Date.parse(record.deadline_at), Date.parse(record.lease_expires_at)) <= Date.now())) await this.hostedReap();
    else this.renewActivityTimeout();
  }
  override async containerFetch(...args: Parameters<Sdk['containerFetch']>): Promise<Response> {
    if (!this.cleanupCalls) this.usable(); else if (this.journal.ctx.container?.running !== true) throw localFenced();
    return super.containerFetch(...args);
  }
  override async fetch(request: Request): Promise<Response> { if (!this.cleanupCalls) this.usable(); return super.fetch(request); }

  override async exec(command: string, options?: ExecOptions) {
    this.usable(); return this.journal.operation('sdk-exec', () => super.execWithSessionToken(command, noSession, { ...options, origin: 'internal' }));
  }
  override async execWithSessionToken(command: string, token: string, options?: ExecOptions) {
    if (token !== noSession) throw localFenced(); return this.exec(command, options);
  }
  override async startProcess(command: string, options?: ProcessOptions, _sessionId?: string) {
    this.usable(); if (!options?.processId) throw localFenced();
    await this.journal.claimProcess(options.processId);
    return this.journal.operation('sdk-process', () => super.startProcess(command, { ...options, onOutput: undefined, onExit: undefined }, noSession));
  }
  override async createBackup(options: BackupOptions): Promise<DirectoryBackup> {
    const record = this.usable();
    if (options.dir !== SNAPSHOT_DIR || !record.process_group_stopped || this.journal.ctx.storage.kv.get('hosted:snapshot-claimed')) throw localFenced();
    this.journal.ctx.storage.kv.put('hosted:snapshot-claimed', true); await this.journal.ctx.storage.sync();
    return this.journal.operation('sdk-backup', () => super.createBackup({ ...options, ttl: this.scope().retention_seconds,
      localBucket: true, multipart: false, compression: { format: 'lz4', threads: 1 } }));
  }
  override async restoreBackup(backup: DirectoryBackup) {
    this.usable(); await this.snapshots.permitRestore(backup);
    try { return await this.journal.operation('sdk-restore', () => super.restoreBackup(backup)); }
    finally { this.snapshots.finishRestore(backup); }
  }
  async retainSnapshot(input: LocalRuntimeRequest, snapshot: DirectoryBackup, cacheKey: string | null): Promise<void> {
    this.scope(input); this.usable();
    await this.journal.operation('snapshot-retention', () => this.snapshots.retain(snapshot, cacheKey));
    await this.scheduleReaper();
  }
  override async writeFile(...args: Parameters<Sdk['writeFile']>) {
    this.usable(); return this.journal.operation('sdk-write', () => super.writeFile(args[0], args[1], { ...args[2], sessionId: noSession }));
  }
  override async readFileStream(...args: Parameters<Sdk['readFileStream']>) {
    this.usable(); return this.journal.stream('sdk-read-stream', () => super.readFileStream(args[0], { ...args[1], sessionId: noSession }));
  }
  override readFile: Sdk['readFile'] = ((path: string, options?: { encoding?: string; sessionId?: string }) => {
    this.usable();
    if (options?.encoding === 'none') return this.readBinaryFile(path, noSession);
    return this.journal.operation('sdk-read', () => super.readFile(path, { ...options, sessionId: noSession } as never));
  }) as Sdk['readFile'];
  private readBinaryFile(path: string, sessionId?: string) {
    return this.journal.streamResult('sdk-read-binary', () => super.readFile(path, { encoding: 'none', sessionId }));
  }
  override async listFiles(...args: Parameters<Sdk['listFiles']>) { this.usable(); return this.journal.operation('sdk-list', () => super.listFiles(...args)); }
  override async exists(...args: Parameters<Sdk['exists']>) { this.usable(); return this.journal.operation('sdk-exists', () => super.exists(...args)); }
  override async getProcess(...args: Parameters<Sdk['getProcess']>) { this.usable(); return this.journal.operation('sdk-get-process', () => super.getProcess(...args)); }
  override async listProcesses(...args: Parameters<Sdk['listProcesses']>) { this.usable(); return this.journal.operation('sdk-list-processes', () => super.listProcesses(...args)); }
  override async createSession(...args: Parameters<Sdk['createSession']>) { this.usable(); return this.journal.operation('sdk-session', () => super.createSession(...args)); }
  override async streamProcessLogs(...args: Parameters<Sdk['streamProcessLogs']>) { this.usable(); return this.journal.stream('sdk-process-stream', () => super.streamProcessLogs(...args)); }

  async stopJobProcesses(): Promise<boolean> {
    if (this.journal.ctx.container?.running !== true) return false;
    const result = await this.exec(stopJobProcessesScript, { timeout: 5000 });
    if (result.success) await this.journal.processesStopped();
    return result.success;
  }

  async destroyAndVerify(input: LocalRuntimeRequest): Promise<DestructionReceipt> {
    const scope = this.journal.ctx.storage.kv.get<LocalRuntimeScope>(LOCAL_SCOPE_KEY);
    if (scope) this.scope(input);
    if (this.destruction) return this.destruction;
    const operation = this.destroyRuntime(input); this.destruction = operation;
    try { return await operation; } finally { if (this.destruction === operation) this.destruction = null; }
  }

  private async destroyRuntime(input: LocalRuntimeRequest): Promise<DestructionReceipt> {
    let record = this.journal.read();
    if (!record) {
      const selected = await localAttemptEnvironment(this.runtimeEnv, input), scope = localScope(selected.env, selected.context);
      if (scope.runtime_id !== this.journal.ctx.id.toString()) throw localFenced();
      this.journal.ctx.storage.kv.put(LOCAL_SCOPE_KEY, scope); await this.journal.ctx.storage.sync();
      await this.journal.seal(await localRuntimeGrant(selected.env, selected.context)); record = this.journal.read()!;
    }
    this.scope(input);
    // The persisted immutable scope is enough to stop an existing VM even when
    // metadata placement or identity services are unavailable.
    await this.journal.seal(record);
    await this.scheduleReaper();
    if (this.journal.ctx.container?.running) {
      const stopping = this.journal.operation('sdk-stop-groups', async () => {
        this.cleanupCalls++;
        try {
          const result = await super.execWithSessionToken(stopJobProcessesScript, noSession, { timeout: 5000, origin: 'internal' });
          if (result.success) await this.journal.processesStopped();
        } finally { this.cleanupCalls--; }
      }, { cleanup: true });
      try { await bounded(stopping, 6000, 'Job process termination remains unconfirmed.'); } catch { /* Hard destruction follows. */ }
    }
    await bounded(this.journal.operation('sdk-destroy', () => super.destroy(), { cleanup: true }), 20_000, 'SDK destruction remains unconfirmed.');
    if (this.journal.ctx.container?.running !== false) throw new ApiError(503, 'destruction_unverified', 'The Container is still running.');
    await this.snapshots.reap();
    if ((await this.journal.ctx.storage.list({ prefix: 'gitknot:inflight:', limit: 1 })).size) throw new ApiError(503, 'destruction_unverified', 'An older SDK operation remains unconfirmed.');
    const scope = this.scope(), facts = await this.journal.confirmDestroyed(record, `destroy_${scope.attempt_id}_${scope.generation}`);
    const receipt: DestructionReceipt = { attempt_id: scope.attempt_id, generation: scope.generation, runtime_id: scope.runtime_id,
      receipt_id: facts.receipt_id!, destroyed_at: facts.destroyed_at!, running: false, sealed: true };
    const durable = await this.projectDestruction(receipt);
    this.journal.ctx.storage.kv.put('hosted:local-destroyed', durable); await this.journal.ctx.storage.sync();
    await this.scheduleReaper();
    return durable;
  }

  private async syncCounters(env: Bindings): Promise<void> {
    const scope = this.scope(), record = this.journal.read()!;
    await execute(primary(env), `UPDATE execution_attempts SET egress_bytes=MAX(egress_bytes,?),egress_requests=MAX(egress_requests,?)
      WHERE id=? AND repo_id=? AND account_id=? AND generation=? AND runtime_id=?`, record.egress_bytes, record.egress_requests,
    scope.attempt_id, scope.repo_id, scope.account_id, scope.generation, scope.runtime_id);
  }
  private async projectDestruction(receipt: DestructionReceipt): Promise<DestructionReceipt> {
    const scope = this.scope(), selected = await localAttemptEnvironment(this.runtimeEnv, scope);
    if (selected.context.attempt.runtime_id !== scope.runtime_id || selected.context.attempt.plan_digest !== scope.plan_digest) throw localFenced();
    await this.syncCounters(selected.env);
    await execute(primary(selected.env), `INSERT INTO execution_runtime_receipts
      (runtime_id,attempt_id,repo_id,account_id,generation,receipt_id,state,armed_at,destroyed_at,updated_at)
      VALUES (?,?,?,?,?,?,'destroyed',?,?,?) ON CONFLICT(runtime_id) DO UPDATE SET state='destroyed',destroyed_at=COALESCE(execution_runtime_receipts.destroyed_at,excluded.destroyed_at),updated_at=excluded.updated_at
      WHERE execution_runtime_receipts.attempt_id=excluded.attempt_id AND execution_runtime_receipts.repo_id=excluded.repo_id
        AND execution_runtime_receipts.account_id=excluded.account_id AND execution_runtime_receipts.generation=excluded.generation AND execution_runtime_receipts.receipt_id=excluded.receipt_id`,
    scope.runtime_id, scope.attempt_id, scope.repo_id, scope.account_id, scope.generation, receipt.receipt_id, scope.allocated_at, receipt.destroyed_at, now());
    const stored = await one<{ receipt_id: string; destroyed_at: string; state: string }>(primary(selected.env),
      'SELECT receipt_id,destroyed_at,state FROM execution_runtime_receipts WHERE runtime_id=? AND attempt_id=? AND repo_id=? AND account_id=? AND generation=?',
    scope.runtime_id, scope.attempt_id, scope.repo_id, scope.account_id, scope.generation);
    if (!stored || stored.state !== 'destroyed' || stored.receipt_id !== receipt.receipt_id || !stored.destroyed_at) throw new ApiError(503, 'destruction_unverified', 'The durable cleanup observation could not be reconciled.');
    return { ...receipt, destroyed_at: stored.destroyed_at };
  }

  override async destroy(): Promise<void> { await this.destroyAndVerify(this.scope()); }
  async hostedReap(): Promise<void> {
    const record = this.journal.read(); if (!record) return;
    if (!record.sealed && Math.min(Date.parse(record.lease_expires_at), Date.parse(record.deadline_at)) > Date.now()) { await this.scheduleReaper(); return; }
    try { await this.destroyAndVerify(this.scope()); } catch { /* Retry indefinitely; elapsed time is not cleanup proof. */ }
    await this.scheduleReaper();
  }
  override async alarm(info?: AlarmInvocationInfo): Promise<void> {
    await this.hostedReap();
    try { await super.alarm(info); } finally { await this.scheduleReaper(); }
  }
  private async scheduleReaper(): Promise<void> {
    const record = this.journal.read(); if (!record) return;
    const facts = this.journal.facts(record), retained = this.snapshots.nextWakeup();
    const projected = this.journal.ctx.storage.kv.get('hosted:local-destroyed');
    this.deleteSchedules('hostedReap');
    if (projected && facts.running === false && facts.in_flight === 0 && facts.ephemeral_objects === 0 && retained === null) return;
    const at = projected && facts.running === false && facts.in_flight === 0 && facts.ephemeral_objects === 0
      ? retained! : record.sealed ? Date.now() + 5000 : Math.min(Date.parse(record.deadline_at), Date.parse(record.lease_expires_at));
    await super.schedule(new Date(Math.max(Date.now() + 1, at)), 'hostedReap', null);
  }

  async authorizeOutbound(url: string, method: string) { return authorizeEgress(this.runtimeEnv, this.journal.ctx, url, method); }
  async consumeOutbound(id: string, bytes: number, upload = false) { await chargeEgress(this.journal.ctx, id, bytes, upload); }
  async finishOutbound(id: string) { await finishEgress(this.journal.ctx, id); }
}

export { Sandbox as SANDBOX };
