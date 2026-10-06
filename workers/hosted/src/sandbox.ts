import { Sandbox as CloudflareSandbox } from '@cloudflare/sandbox';
import type { BackupOptions, DirectoryBackup, ExecOptions, ProcessOptions } from '@cloudflare/sandbox';
import { ApiError } from '@gitknot/core';
import { CONTROL_DIR, SNAPSHOT_DIR, stopJobProcessesScript } from '@gitknot/execution/hosted/scripts';
import { EphemeralStore } from './ephemeral.ts';
import { bounded, fenced } from './errors.ts';
import { hostedOutbound, RuntimeEgress } from './egress.ts';
import { RuntimeJournal, guardedContext } from './runtime-journal.ts';
import { LIMITS } from './types.ts';
import type { HostedEnv, RuntimeFacts, RuntimeGrant, RuntimeIdentity } from './types.ts';

const noSession = '__DISABLE_SESSION__';
type Sdk = CloudflareSandbox<HostedEnv>;

/** The real 0.12.1 SDK, with a permanently closed lifecycle for each allocation. */
export class HostedSandbox extends CloudflareSandbox<HostedEnv> {
  override enableInternet = false;
  override interceptHttps = true;
  override sleepAfter = '60s';
  static {
    // These are SDK registry setters. Class-field shadowing would bypass them.
    this.outbound = hostedOutbound;
    this.outboundHandlers = { gitknot: hostedOutbound };
  }
  private readonly journal: RuntimeJournal;
  private readonly ephemeral: EphemeralStore;
  private readonly egress: RuntimeEgress;
  private cleanupCalls = 0;
  private destruction: Promise<RuntimeFacts> | null = null;
  private leaseWrite: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: HostedEnv) {
    const journal = new RuntimeJournal(ctx);
    const ephemeral = new EphemeralStore(env.BACKUP_BUCKET, journal);
    // No callback token, signing key, or provider credentials reach SDK env.
    super(guardedContext(ctx, journal) as DurableObjectState<{}>, { BACKUP_BUCKET: ephemeral.binding(), SANDBOX_TRANSPORT: 'rpc', SANDBOX_LOG_LEVEL: 'error' } as unknown as HostedEnv);
    this.journal = journal; this.ephemeral = ephemeral; this.egress = new RuntimeEgress(journal);
  }

  async arm(grant: RuntimeGrant): Promise<void> {
    await this.journal.arm(grant);
    await this.setOutboundHandler('gitknot');
    await this.setKeepAlive(true);
    await this.scheduleReaper();
  }

  async renewLease(identity: RuntimeIdentity, lease: string): Promise<void> {
    await this.journal.renew(identity, lease);
    const write = this.leaseWrite.then(async () => {
      if (!this.journal.ctx.container?.running || !this.journal.ctx.storage.kv.get('hosted:lease-file-enabled')) return;
      const record = this.journal.active();
      const body = JSON.stringify({ lease_expires_at: record.lease_expires_at, deadline_at: record.deadline_at });
      await this.writeFile(`${CONTROL_DIR}/lease.next`, body, { sessionId: noSession });
      const result = await this.exec(`chmod 600 ${CONTROL_DIR}/lease.next && mv -f ${CONTROL_DIR}/lease.next ${CONTROL_DIR}/lease.json`, { timeout: 5000 });
      if (!result.success) throw new ApiError(503, 'lease_update_failed', 'The VM execution lease could not be refreshed.');
    });
    this.leaseWrite = write.catch(() => undefined);
    await write;
    await this.scheduleReaper();
  }

  async enableLeaseFile(identity: RuntimeIdentity): Promise<void> {
    const record = this.journal.identify(identity);
    this.journal.active();
    this.journal.ctx.storage.kv.put('hosted:lease-file-enabled', true);
    await this.journal.ctx.storage.sync();
    await this.renewLease(identity, record.lease_expires_at);
  }

  async checkoutComplete(): Promise<void> { await this.journal.checkoutComplete(); }
  async runtimeStatus(identity: RuntimeIdentity): Promise<RuntimeFacts> { return this.journal.facts(identity); }

  override start(...args: Parameters<Sdk['start']>): Promise<void> {
    return this.journal.start(() => super.start(...args));
  }
  override startAndWaitForPorts: Sdk['startAndWaitForPorts'] = ((...args: Parameters<Sdk['startAndWaitForPorts']>) =>
    this.journal.start(() => super.startAndWaitForPorts(...args))) as Sdk['startAndWaitForPorts'];

  override async onStart(): Promise<void> {
    try { this.journal.active(); }
    catch (error) { await super.destroy(); throw error; }
    // SDK onStart starts an unawaited version probe and preview/tunnel work.
    // Hosted jobs have neither previews nor tunnels. Our explicit image check
    // verifies the pinned version without any unjournaled background SDK call.
    await this.scheduleReaper();
  }

  override async onStop(): Promise<void> {
    const identity = this.journal.read();
    if (identity) await this.journal.seal(identity);
    await super.onStop();
    if (identity) await this.scheduleReaper();
  }

  override async onActivityExpired(): Promise<void> {
    const record = this.journal.read();
    if (record && (record.sealed || Date.parse(record.lease_expires_at) <= Date.now() || Date.parse(record.deadline_at) <= Date.now())) await this.hostedReap();
    else this.renewActivityTimeout();
  }

  override async containerFetch(...args: Parameters<Sdk['containerFetch']>): Promise<Response> {
    if (!this.cleanupCalls) this.journal.active();
    else if (this.journal.ctx.container?.running !== true) throw fenced();
    return super.containerFetch(...args);
  }

  override async fetch(request: Request): Promise<Response> {
    if (!this.cleanupCalls) this.journal.active();
    return super.fetch(request);
  }

  override async exec(command: string, options?: ExecOptions) {
    return this.journal.operation('sdk-exec', () => super.execWithSessionToken(command, noSession, { ...options, origin: 'internal' }));
  }
  override async execWithSessionToken(command: string, token: string, options?: ExecOptions) {
    if (token !== noSession) throw fenced();
    return this.exec(command, options);
  }
  override async startProcess(command: string, options?: ProcessOptions, _sessionId?: string) {
    if (!options?.processId) throw fenced();
    await this.journal.claimProcess(options.processId);
    return this.journal.operation('sdk-process', () => super.startProcess(command, { ...options, onOutput: undefined, onExit: undefined }, noSession));
  }
  override async createBackup(options: BackupOptions): Promise<DirectoryBackup> {
    if (options.dir !== SNAPSHOT_DIR || !this.journal.active().process_group_stopped) throw fenced();
    const key = 'hosted:snapshot-claimed';
    if (this.journal.ctx.storage.kv.get(key)) throw fenced();
    this.journal.ctx.storage.kv.put(key, true);
    await this.journal.ctx.storage.sync();
    return this.journal.operation('sdk-backup', () => super.createBackup({ ...options, localBucket: true, multipart: false,
      compression: { format: 'lz4', threads: 1 } }));
  }
  override async restoreBackup(backup: DirectoryBackup) {
    if (backup.dir !== SNAPSHOT_DIR || backup.localBucket !== true
      || !this.ephemeral.record(`backups/${backup.id}/data.sqsh`)?.sha256 || !this.ephemeral.record(`backups/${backup.id}/meta.json`)?.sha256) throw fenced();
    return this.journal.operation('sdk-restore', () => super.restoreBackup(backup));
  }
  override async writeFile(...args: Parameters<Sdk['writeFile']>) { return this.journal.operation('sdk-write', () => super.writeFile(...args)); }
  override async readFileStream(...args: Parameters<Sdk['readFileStream']>) { return this.journal.stream('sdk-read-stream', () => super.readFileStream(...args)); }
  override readFile: Sdk['readFile'] = ((path: string, options?: { encoding?: string; sessionId?: string }) => {
    if (options?.encoding === 'none') throw new ApiError(403, 'sdk_operation_denied', 'Use the tracked SDK file stream.');
    return this.journal.operation('sdk-read', () => super.readFile(path, options as never));
  }) as Sdk['readFile'];
  override async listFiles(...args: Parameters<Sdk['listFiles']>) { return this.journal.operation('sdk-list', () => super.listFiles(...args)); }
  override async exists(...args: Parameters<Sdk['exists']>) { return this.journal.operation('sdk-exists', () => super.exists(...args)); }
  override async getProcess(...args: Parameters<Sdk['getProcess']>) { return this.journal.operation('sdk-get-process', () => super.getProcess(...args)); }
  override async listProcesses(...args: Parameters<Sdk['listProcesses']>) { return this.journal.operation('sdk-list-processes', () => super.listProcesses(...args)); }
  override async createSession(...args: Parameters<Sdk['createSession']>) { return this.journal.operation('sdk-session', () => super.createSession(...args)); }
  override async streamProcessLogs(...args: Parameters<Sdk['streamProcessLogs']>) { return this.journal.stream('sdk-process-stream', () => super.streamProcessLogs(...args)); }

  async stopJobProcesses(): Promise<boolean> {
    if (this.journal.ctx.container?.running !== true) return false;
    const result = await this.exec(stopJobProcessesScript, { timeout: 5000 });
    if (result.success) await this.journal.processesStopped();
    return result.success;
  }

  async importSnapshotObject(logical: string, stream: ReadableStream<Uint8Array>, expected: { sha256: string; size_bytes: number }): Promise<void> {
    await this.ephemeral.put(logical, stream, expected);
  }
  async snapshotObject(logical: string) {
    this.journal.active();
    const object = this.ephemeral.record(logical);
    if (!object?.sha256 || object.size_bytes === null) throw new ApiError(409, 'snapshot_unverified', 'The snapshot object was not verified.');
    return object;
  }
  async readSnapshotObject(logical: string): Promise<ReadableStream<Uint8Array>> {
    return this.journal.stream('r2-export', async () => {
      const object = await this.ephemeral.get(logical);
      if (!object) throw new ApiError(409, 'snapshot_missing', 'The snapshot object is unavailable.');
      return object.body;
    });
  }
  async deleteSnapshotObject(logical: string): Promise<void> {
    await this.journal.operation('r2-delete', () => this.ephemeral.delete(logical), { cleanup: true });
  }

  async sealAndDestroy(identity: RuntimeIdentity): Promise<RuntimeFacts> {
    if (this.destruction) return this.destruction;
    const operation = this.destroyRuntime(identity);
    this.destruction = operation;
    try { return await operation; }
    finally { if (this.destruction === operation) this.destruction = null; }
  }

  private async destroyRuntime(identity: RuntimeIdentity): Promise<RuntimeFacts> {
    await this.journal.seal(identity);
    await this.scheduleReaper();
    if (this.journal.ctx.container?.running) {
      const stop = this.journal.operation('sdk-stop-groups', async () => {
        this.cleanupCalls++;
        try {
          const result = await super.execWithSessionToken(stopJobProcessesScript, noSession, { timeout: 5000, origin: 'internal' });
          if (result.success) await this.journal.processesStopped();
        } finally { this.cleanupCalls--; }
      }, { cleanup: true });
      try { await bounded(stop, 6000); } catch { /* Hard destruction remains mandatory. */ }
    }
    await bounded(this.journal.operation('sdk-destroy', () => super.destroy(), { cleanup: true }), 20_000, 'destruction_unverified');
    if (this.journal.ctx.container?.running !== false) throw new ApiError(503, 'destruction_unverified', 'Container termination has not been independently confirmed.');
    if (this.journal.facts(identity).in_flight !== 0) throw new ApiError(503, 'destruction_unverified', 'Outstanding SDK operations must finish before destruction can be certified.');
    await this.ephemeral.deleteAll();
    const result = await this.journal.confirmDestroyed(identity);
    this.deleteSchedules('hostedReap');
    return result;
  }

  override async destroy(): Promise<void> {
    const record = this.journal.read();
    if (!record) throw fenced();
    await this.sealAndDestroy(record);
  }

  async hostedReap(): Promise<void> {
    const record = this.journal.read();
    if (!record) return;
    if (!record.sealed && Math.min(Date.parse(record.deadline_at), Date.parse(record.lease_expires_at)) > Date.now()) { await this.scheduleReaper(); return; }
    try { await this.sealAndDestroy(record); }
    catch { await this.scheduleReaper(); }
  }

  override async alarm(info?: AlarmInvocationInfo): Promise<void> {
    await this.hostedReap();
    try { await super.alarm(info); }
    finally { await this.scheduleReaper(); }
  }

  private async scheduleReaper(): Promise<void> {
    const record = this.journal.read();
    if (!record) return;
    const facts = this.journal.facts(record);
    if (record.destroyed_at && facts.running === false && facts.in_flight === 0 && facts.ephemeral_objects === 0) return;
    this.deleteSchedules('hostedReap');
    const at = record.sealed ? Date.now() + 5000 : Math.min(Date.parse(record.lease_expires_at), Date.parse(record.deadline_at));
    await super.schedule(new Date(Math.max(Date.now() + 1, at)), 'hostedReap', null);
  }

  async authorizeOutbound(url: string, method: string) { return this.egress.authorize(url, method); }
  async consumeOutbound(id: string, bytes: number, upload: boolean) { await this.egress.consume(id, bytes, upload); }
  async finishOutbound(id: string) { await this.egress.finish(id); }
}
