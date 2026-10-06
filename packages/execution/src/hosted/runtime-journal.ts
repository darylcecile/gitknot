import { ApiError, canonicalJson, now } from '@gitknot/core';
import { OBJECT_PREFIX, OPERATION_PREFIX, RUNTIME_KEY } from './runtime-types.ts';
import type { RuntimeFacts, RuntimeGrant, RuntimeIdentity, RuntimeRecord } from './runtime-types.ts';

const fenced = () => new ApiError(409, 'attempt_fenced', 'The hosted runtime is permanently fenced.');

export interface RuntimeOperation { kind: string; started_at: string; uncertain?: boolean }

/** Local execution facts only: this is not a replica of control-plane authority. */
export class RuntimeJournal {
  private startPermit = false;
  private startPromise: Promise<void> | null = null;

  constructor(readonly ctx: DurableObjectState) {
    if (!ctx.storage.kv || !ctx.storage.transactionSync) throw new ApiError(503, 'hosted_storage_unavailable', 'Hosted runtimes require SQLite-backed durable storage.');
  }

  read(): RuntimeRecord | undefined { return this.ctx.storage.kv.get<RuntimeRecord>(RUNTIME_KEY); }

  active(): RuntimeRecord {
    const record = this.read();
    const end = record ? Math.min(Date.parse(record.deadline_at), Date.parse(record.lease_expires_at)) : NaN;
    if (!record || record.sealed || !Number.isFinite(end) || end <= Date.now()) throw fenced();
    return record;
  }

  identify(identity: RuntimeIdentity): RuntimeRecord {
    const record = this.read();
    if (!record || ['executor_id', 'attempt_id', 'generation', 'grant_digest', 'runtime_id', 'runtime_name', 'sandbox_id', 'producer_id', 'deadline_at']
      .some(key => record[key as keyof RuntimeIdentity] !== identity[key as keyof RuntimeIdentity])) throw fenced();
    return record;
  }

  async arm(grant: RuntimeGrant): Promise<void> {
    if (grant.sandbox_id !== this.ctx.id.toString() || !/^[a-f0-9]{64}$/.test(grant.grant_digest)) throw fenced();
    this.ctx.storage.transactionSync(() => {
      const prior = this.read();
      if (prior) {
        this.identify(grant);
        if (prior.sealed || canonicalJson(prior.egress) !== canonicalJson(grant.egress) || prior.cache_bytes !== grant.cache_bytes) throw fenced();
        return;
      }
      const end = Math.min(Date.parse(grant.lease_expires_at), Date.parse(grant.deadline_at));
      if (!Number.isFinite(end) || end <= Date.now()) throw fenced();
      this.ctx.storage.kv.put(RUNTIME_KEY, { ...grant, sealed: false, launch_claimed: false, started_at: null, destroyed_at: null,
        receipt_id: null, process_group_stopped: false, egress_bytes: 0, egress_requests: 0, egress_exhausted: false } satisfies RuntimeRecord);
    });
    await this.ctx.storage.sync();
  }

  async renew(identity: RuntimeIdentity, lease: string): Promise<void> {
    const record = this.identify(identity);
    this.active();
    const end = Date.parse(lease);
    if (!Number.isFinite(end) || end <= Date.now() || end > Date.parse(record.deadline_at)) throw fenced();
    if (end < Date.parse(record.lease_expires_at)) return; // Reordered, older heartbeat response.
    this.ctx.storage.kv.put(RUNTIME_KEY, { ...record, lease_expires_at: lease });
    await this.ctx.storage.sync();
  }

  async seal(identity: RuntimeIdentity): Promise<void> {
    const record = this.read();
    if (record) {
      this.identify(identity);
      this.ctx.storage.kv.put(RUNTIME_KEY, { ...record, sealed: true, source_url: null });
    } else {
      // Cancellation before arm still installs the permanent allocation tombstone.
      if (identity.sandbox_id !== this.ctx.id.toString()) throw fenced();
      this.ctx.storage.kv.put(RUNTIME_KEY, { ...identity, lease_expires_at: now(), source_url: null, cache_bytes: 0,
        egress: { hosts: [], max_bytes: 0, max_request_bytes: 0, max_requests: 0 }, sealed: true, launch_claimed: false,
        started_at: null, destroyed_at: null, receipt_id: null, process_group_stopped: false, egress_bytes: 0, egress_requests: 0, egress_exhausted: false } satisfies RuntimeRecord);
    }
    this.startPermit = false;
    await this.ctx.storage.sync();
  }

  async operation<T>(kind: string, work: () => Promise<T>, options: { cleanup?: boolean; uncertainOnReject?: boolean } = {}): Promise<T> {
    if (!options.cleanup) this.active();
    const key = `${OPERATION_PREFIX}${crypto.randomUUID()}`;
    this.ctx.storage.kv.put(key, { kind, started_at: now() } satisfies RuntimeOperation);
    await this.ctx.storage.sync();
    try {
      if (!options.cleanup) this.active();
      const value = await work();
      this.ctx.storage.kv.delete(key);
      await this.ctx.storage.sync();
      return value;
    } catch (error) {
      if (options.uncertainOnReject) this.ctx.storage.kv.put(key, { kind, started_at: now(), uncertain: true } satisfies RuntimeOperation);
      else this.ctx.storage.kv.delete(key);
      await this.ctx.storage.sync();
      throw error;
    }
  }

  async stream(kind: string, work: () => Promise<ReadableStream<Uint8Array>>): Promise<ReadableStream<Uint8Array>> {
    this.active();
    const key = `${OPERATION_PREFIX}${crypto.randomUUID()}`;
    this.ctx.storage.kv.put(key, { kind, started_at: now() } satisfies RuntimeOperation);
    await this.ctx.storage.sync();
    let source: ReadableStream<Uint8Array>;
    try { this.active(); source = await work(); }
    catch (error) { this.ctx.storage.kv.delete(key); await this.ctx.storage.sync(); throw error; }
    const reader = source.getReader();
    const release = async () => { this.ctx.storage.kv.delete(key); await this.ctx.storage.sync(); };
    const active = () => this.active();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          active();
          const chunk = await reader.read();
          if (chunk.done) { await release(); controller.close(); }
          else { active(); controller.enqueue(chunk.value); }
        } catch (error) { try { await reader.cancel(); } finally { await release(); } controller.error(error); }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { await release(); } },
    });
  }

  /** Preserve the public SDK method's inferred metadata type and stream lifetime. */
  async streamResult<T extends { content: ReadableStream<Uint8Array> }>(kind: string, work: () => Promise<T>): Promise<T> {
    let result!: T;
    const content = await this.stream(kind, async () => { result = await work(); return result.content; });
    return { ...result, content };
  }

  async start(work: () => Promise<void>): Promise<void> {
    this.active();
    if (this.startPromise) return this.startPromise;
    if (this.ctx.container?.running === true) return this.operation('sdk-start-attach', work);
    const record = this.active();
    if (record.launch_claimed) throw fenced();
    this.ctx.storage.kv.put(RUNTIME_KEY, { ...record, launch_claimed: true });
    const start = this.operation('sdk-start', async () => {
      this.startPermit = true;
      try { await work(); }
      finally { this.startPermit = false; }
    });
    this.startPromise = start;
    try { await start; }
    finally { if (this.startPromise === start) this.startPromise = null; }
  }

  /** Synchronous raw Container.start guard; the launch claim was synced first. */
  consumeStart(): void {
    const record = this.active();
    if (!record.launch_claimed || !this.startPermit) throw fenced();
    this.startPermit = false;
    this.ctx.storage.kv.put(RUNTIME_KEY, { ...record, started_at: now() });
  }

  async claimProcess(processId: string): Promise<void> {
    const record = this.active();
    if (!new RegExp(`^${record.attempt_id}-step-[0-9]{1,3}$`).test(processId)) throw fenced();
    const key = `hosted:process:${processId}`;
    if (this.ctx.storage.kv.get(key)) throw fenced();
    this.ctx.storage.kv.put(key, { claimed_at: now() });
    this.ctx.storage.kv.put(RUNTIME_KEY, { ...record, process_group_stopped: false });
    await this.ctx.storage.sync();
  }

  async processesStopped(): Promise<void> {
    const record = this.read();
    if (!record) throw fenced();
    this.ctx.storage.kv.put(RUNTIME_KEY, { ...record, process_group_stopped: true });
    await this.ctx.storage.sync();
  }

  async checkoutComplete(): Promise<void> {
    const record = this.active();
    this.ctx.storage.kv.put(RUNTIME_KEY, { ...record, source_url: null });
    await this.ctx.storage.sync();
  }

  facts(identity: RuntimeIdentity): RuntimeFacts {
    const record = this.identify(identity);
    return { ...identity, sealed: record.sealed, running: this.ctx.container?.running ?? null,
      in_flight: [...this.ctx.storage.kv.list({ prefix: OPERATION_PREFIX })].length,
      ephemeral_objects: [...this.ctx.storage.kv.list({ prefix: OBJECT_PREFIX })].length,
      started_at: record.started_at, destroyed_at: record.destroyed_at, receipt_id: record.receipt_id,
      process_group_stopped: record.process_group_stopped, egress_bytes: record.egress_bytes, egress_requests: record.egress_requests,
      egress_exhausted: record.egress_exhausted };
  }

  async confirmDestroyed(identity: RuntimeIdentity, receiptId?: string): Promise<RuntimeFacts> {
    const facts = this.facts(identity);
    if (!facts.sealed || facts.running !== false || facts.in_flight !== 0 || facts.ephemeral_objects !== 0) {
      throw new ApiError(503, 'destruction_unverified', 'The runtime still has running, outstanding, or ephemeral resources.');
    }
    const record = this.identify(identity);
    this.ctx.storage.kv.put(RUNTIME_KEY, { ...record, process_group_stopped: true, destroyed_at: record.destroyed_at ?? now(),
      receipt_id: record.receipt_id ?? receiptId ?? `remote-destroy-${identity.grant_digest}` });
    await this.ctx.storage.sync();
    return this.facts(identity);
  }
}

/** Blocks every SDK retry/start path, including starts inside internal transports. */
export function guardedContext(ctx: DurableObjectState, journal: RuntimeJournal): DurableObjectState {
  const container = ctx.container;
  if (!container) throw new ApiError(503, 'hosted_container_unavailable', 'The hosted Container binding is missing.');
  const guarded = new Proxy(container, { get(target, property) {
    if (property === 'start') return (options?: ContainerStartupOptions) => {
      journal.consumeStart();
      if (options?.enableInternet !== false) throw fenced();
      return target.start(options);
    };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return new Proxy(ctx, { get(target, property) {
    if (property === 'container') return guarded;
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
