import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  AdmissionController, admissionRequest, cancelExecutionReservation, commitStorageObject, deleteStorageObject,
  ensureBillingAccount, reserveExecution, reserveStandaloneStorage, settleExecution, startExecution,
  renewStorageCommitment, prepareRepositoryStorageTransfer, commitRepositoryStorageTransfer, storageTransferReceipts,
  closeInvoice, grantCredit, invoiceRounding,
  cancelStandaloneStorageIntent, claimStorageDeletion,
  releaseStorageDeletionClaim, usageRollups, changeSubscription, reserveSeatChange, seatAcceptanceStatements, finalizeInvoiceAdmission, allocatePlatformSlices,
  previewExecutionQuote, quoteExecution,
  accrueStorage, sweepBilling,
} from '../../packages/billing/src/index.ts';
import type { CanonicalGitMeter, CanonicalGitStorageInput } from '../../packages/billing/src/git-types.ts';
import { placementStorageName } from '../../packages/billing/src/placement-state.ts';
import { gitCosts } from '../../packages/git/src/cost.ts';
import type { AdmissionControl, BillingBindings, BillingStore, BillingTransaction, Budget, ReservationResult, StorageObject } from '../../packages/billing/src/types.ts';
import { errorResponse, many, now, one, randomToken, sha256, stmt } from '../../packages/core/src/index.ts';
import type { AppEnv, Principal } from '../../packages/core/src/types.ts';
import { registerBillingRoutes } from '../../apps/api/src/modules/billing.ts';
import { accrueObjects } from '../../packages/operations/src/objects.ts';
import type { OperationsBindings } from '../../packages/operations/src/types.ts';
import { createTestEnvironment } from '../support/environment.ts';
import type { TestEnvironment } from '../support/environment.ts';
import { createTestDatabase } from '../support/database.ts';

class TransactionalMemory implements BillingStore {
  private data = new Map<string, unknown>();
  private tail: Promise<void> = Promise.resolve();
  alarmAt: number | null = null;

  private view(data: Map<string, unknown>): BillingTransaction {
    return {
      get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
      put: async <T>(key: string, value: T) => { data.set(key, structuredClone(value)); },
      delete: async (key: string) => data.delete(key),
      list: async <T>(options: { prefix?: string; limit?: number; startAfter?: string } = {}) => new Map([...data.entries()]
        .filter(([key]) => key.startsWith(options.prefix ?? '') && key > (options.startAfter ?? '')).sort(([a], [b]) => a.localeCompare(b))
        .slice(0, options.limit ?? Infinity).map(([key, value]) => [key, structuredClone(value) as T])),
    };
  }
  async transaction<T>(callback: (tx: BillingTransaction) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const working = structuredClone(this.data);
    try { const result = await callback(this.view(working)); this.data = working; return result; }
    finally { release(); }
  }
  async get<T>(key: string): Promise<T | undefined> { await this.tail; return this.view(this.data).get<T>(key); }
  async put<T>(key: string, value: T): Promise<void> { await this.transaction((tx) => tx.put(key, value)); }
  async delete(key: string): Promise<boolean> { return this.transaction((tx) => tx.delete(key)); }
  async list<T>(options?: { prefix?: string; limit?: number; startAfter?: string }): Promise<Map<string, T>> { await this.tail; return this.view(this.data).list<T>(options); }
  async setAlarm(at: number): Promise<void> { this.alarmAt = at; }
}

class AdmissionNetwork {
  readonly objects = new Map<string, { controller: AdmissionController; storage: TransactionalMemory }>();
  intercept?: (target: string, request: Request, deliver: () => Promise<Response>) => Promise<Response>;
  constructor(readonly env: BillingBindings) {}
  private object(target: string): AdmissionController {
    let object = this.objects.get(target);
    if (!object) {
      const storage = new TransactionalMemory();
      const state = { storage, blockConcurrencyWhile: <T>(callback: () => Promise<T>) => callback() } as unknown as DurableObjectState;
      object = { storage, controller: new AdmissionController(state, this.env) };
      this.objects.set(target, object);
    }
    return object.controller;
  }
  binding(): DurableObjectNamespace {
    return { idFromName: (id: string) => ({ toString: () => id }), get: (id: { toString(): string }) => ({ fetch: (request: Request) => {
      const target = id.toString();
      const deliver = () => this.object(target).fetch(request);
      return this.intercept ? this.intercept(target, request, deliver) : deliver();
    } }) } as unknown as DurableObjectNamespace;
  }
}

const opened: Array<{ close(): void }> = [];
afterEach(() => { vi.useRealTimers(); for (const fixture of opened.splice(0)) fixture.close(); });

async function fixture(instances = 16): Promise<TestEnvironment & { env: BillingBindings; network: AdmissionNetwork }> {
  const test = await createTestEnvironment({ BILLING_PLATFORM_SLICE_ID: 'slice_local', LIMITS_JSON: '{"repository_storage_bytes":2147483648}',
    IDENTITY_KEYS_JSON: JSON.stringify({ current: 'test', keys: { test: randomToken() } }) });
  opened.push(test);
  const env = test.env as BillingBindings;
  const network = new AdmissionNetwork(env);
  env.ADMISSION = network.binding();
  const timestamp = now();
  for (const name of ['one', 'two']) await env.DB.batch([
    stmt(env.DB, 'INSERT INTO users(id,username,email,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?)', `u_${name}`, name, `${name}@example.net`, timestamp, timestamp, timestamp),
    stmt(env.DB, "INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES (?,'user',?,?,?,?,?)", `u_${name}`, name, name, `u_${name}`, timestamp, timestamp),
    stmt(env.DB, "INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES (?,'user',?,?,?,?,?,?)", `u_${name}`, `u_${name}`, `u_${name}`, name, `u_${name}`, timestamp, timestamp),
    stmt(env.DB, "INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at) VALUES (?,?,?,?,'private','active','local','core',?,?,?,?)",
      `r_${name}`, `u_${name}`, name, name, `storage_${name}`, `u_${name}`, timestamp, timestamp),
  ]);
  await env.DB.batch([
    stmt(env.DB, "INSERT INTO billing_platform_pools(id,period_start,period_end,limit_units,safety_buffer_units,baseline_commitment_units,max_instances,state) VALUES ('pool_local',?,'2099-01-01T00:00:00.000Z','1000000000000','1000000000','1000000000',?,'active')", timestamp, instances),
    stmt(env.DB, "INSERT INTO billing_capacity_slices(id,pool_id,cell_id,limit_units,max_instances,max_storage_bytes,valid_until,state,created_at) VALUES ('slice_local','pool_local','local','100000000000',?,'1000000000000','2099-01-01T00:00:00.000Z','active',?)", instances, timestamp),
  ]);
  return { ...test, env, network };
}

async function snapshot(env: BillingBindings, account = 'u_one'): Promise<{ control: AdmissionControl; budgets: Budget[] }> {
  return admissionRequest(env, `account:${account}`, 'snapshot');
}

async function cap(env: BillingBindings, value: string, safety = '0', account = 'u_one'): Promise<void> {
  const { budgets } = await snapshot(env, account);
  await admissionRequest(env, `account:${account}`, 'budget', { budget: { ...budgets[0]!, limit_units: value, safety_buffer_units: safety }, expected_revision: budgets[0]!.revision });
}

function job(id: string, account = 'u_one') {
  return { account_id: account, repo_id: account === 'u_one' ? 'r_one' : 'r_two', actor_id: account, run_id: `run_${id}`, attempt_id: `att_${id}`,
    generation: 1, executor: 'hosted' as const, profile: 'linux-small', maximum_duration_ms: 1000, maximum_storage_bytes: '0' };
}

async function readyManifest(env: BillingBindings, object: StorageObject, checksum: string, bytes: number, state = 'pending'): Promise<void> {
  await env.DB.prepare(`INSERT INTO object_manifests(id,account_id,repo_id,kind,object_key,bucket,filename,bytes,sha256,state,created_by,
    billing_reservation_id,billing_fence,retention_until,requested_retention_until,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(object.id, object.account_id, object.attribution.repo_id, 'attachment', object.key, object.bucket, 'file', bytes, checksum, state,
      object.attribution.actor_id, object.reservation_id, object.fence, object.retention_until, object.retention_until, now(), now()).run();
}

describe('production billing admission and exact ledger', () => {
  it('previews the real quote math without creating billing state or contacting admission', async () => {
    const { env, db, network } = await fixture();
    const input = { account_id: 'u_one', repo_id: 'r_one', actor_id: 'u_one', workflow_id: null, executor: 'hosted' as const,
      profile: 'linux-small', maximum_duration_ms: 1000, maximum_storage_bytes: '1048576', storage_retention_seconds: 3600, maximum_egress_bytes: '1024' };
    const changes = () => db.sqlite.prepare('SELECT total_changes() AS changes').get()!.changes;
    const before = changes();
    const preview = await previewExecutionQuote(env, input);
    expect(changes()).toBe(before);
    expect(network.objects.size).toBe(0);
    expect(await one(env.DB, "SELECT COUNT(*) AS count FROM billing_accounts WHERE account_id='u_one'")).toEqual({ count: 0 });
    expect(preview).toMatchObject({ kind: 'preview', payer_account_id: 'u_one', attribution: { run_id: null, attempt_id: null, generation: null },
      subscription: { initialized: false, plan_id: 'plan_free_202610' }, availability: { state: 'unavailable', admission_required: true } });
    await expect(previewExecutionQuote(env, { ...input, profile: 'unconfigured-profile' })).rejects.toMatchObject({ code: 'price_unavailable', status: 503 });
    const unavailableDb = { withSession() { throw new Error('Billing datastore unavailable'); } } as unknown as D1Database;
    await expect(previewExecutionQuote({ ...env, DB: unavailableDb }, input)).rejects.toMatchObject({ code: 'billing_preview_unavailable', status: 503 });
    expect(changes()).toBe(before);
    expect(network.objects.size).toBe(0);
    const executable = await quoteExecution(env, { ...input, run_id: 'run_quote_comparison', attempt_id: 'attempt_quote_comparison', generation: 1 });
    for (const key of ['maximum_charge_units', 'maximum_platform_units', 'storage_charge_units', 'platform_storage_units', 'storage_retention_ms', 'storage_cleanup_grace_ms', 'maximum_objects', 'rates'] as const) {
      expect(preview[key]).toEqual(executable[key]);
    }
    const initialized = changes();
    expect((await previewExecutionQuote(env, input)).availability.state).toBe('eligible');
    expect(changes()).toBe(initialized);
    await env.DB.prepare("UPDATE billing_accounts SET state='past_due',revision=revision+1 WHERE account_id='u_one'").run();
    const unavailable = await previewExecutionQuote(env, input);
    expect(unavailable.maximum_charge_units).toBe(preview.maximum_charge_units);
    expect(unavailable.availability.reasons.some(reason => reason.code === 'subscription_inactive')).toBe(true);
    expect(await one(env.DB, 'SELECT COUNT(*) AS count FROM billing_reservations')).toEqual({ count: 0 });
    expect(await one(env.DB, 'SELECT COUNT(*) AS count FROM billing_ledger')).toEqual({ count: 0 });
  });

  it('refunds both monetary units and fractional carry for infrastructure failures', async () => {
    const { env } = await fixture();
    const amounts: string[] = [];
    for (const [index, bytes] of ['4', '6', '4'].entries()) {
      const reservation = await reserveExecution(env, { ...job(`fraction_${index}`), maximum_egress_bytes: '10' });
      const identity = { account_id: 'u_one', reservation_id: reservation.reservation_id, fence: reservation.fence, runtime_id: `fraction_runtime_${index}` };
      await startExecution(env, identity);
      const settled = await settleExecution(env, { ...identity, event_id: `fraction_receipt_${index}`, duration_ms: 0, egress_bytes: bytes,
        outcome: index === 0 ? 'infrastructure_failure' : 'success', termination_proof: { kind: 'hosted_destroyed', receipt_id: `fraction_destroyed_${index}`, verified_at: now() } });
      amounts.push(settled.actual_units);
    }
    expect(amounts).toEqual(['0', '0', '1']);
    expect((await snapshot(env)).budgets[0]!.settled_units).toBe('1');
  });

  it('races all account caps, reserves safety headroom, and settles one authenticated receipt exactly once', async () => {
    const { env } = await fixture();
    await ensureBillingAccount(env, 'u_one');
    await env.DB.prepare("UPDATE billing_accounts SET plan_id='plan_team_202610' WHERE account_id='u_one'").run();
    await cap(env, '12000250000', '50000');
    const replies = await Promise.allSettled(Array.from({ length: 24 }, (_, i) => reserveExecution(env, job(`race_${i}`))));
    const admitted = replies.flatMap((r) => r.status === 'fulfilled' && r.value.status === 'reserved' ? [r.value] : []);
    expect(admitted).toHaveLength(2);
    const before = await snapshot(env);
    expect(before.budgets[0]!.reserved_units).toBe('200000');
    expect(before.budgets[0]!.commitment_units).toBe('12000000000');
    const reservation = admitted[0]!;
    const grant = await startExecution(env, { account_id: 'u_one', reservation_id: reservation.reservation_id, fence: reservation.fence, runtime_id: 'runtime_verified' });
    expect(grant.status).toBe('running');
    const receipt = { account_id: 'u_one', reservation_id: reservation.reservation_id, fence: reservation.fence, runtime_id: 'runtime_verified',
      event_id: 'evt_verified_receipt', duration_ms: 500, outcome: 'success' as const,
      termination_proof: { kind: 'hosted_destroyed' as const, receipt_id: 'destroy_verified_receipt', verified_at: now() } };
    const settled = await Promise.all(Array.from({ length: 12 }, () => settleExecution(env, receipt)));
    expect(new Set(settled.map((r) => r.actual_units))).toEqual(new Set(['50000']));
    expect(await one(env.DB, "SELECT COUNT(*) AS count FROM billing_ledger WHERE event_id='evt_verified_receipt' AND operating_cost=0")).toEqual({ count: 2 });
    const line = await one<{ amount_units: string; account_id: string; repo_id: string; actor_id: string; price_version: string; meter_version: number }>(env.DB,
      "SELECT amount_units,account_id,repo_id,actor_id,price_version,meter_version FROM billing_ledger WHERE event_id='evt_verified_receipt' AND meter='hosted.linux-small' AND operating_cost=0");
    expect(line).toEqual({ amount_units: '50000', account_id: 'u_one', repo_id: 'r_one', actor_id: 'u_one', price_version: '2026-10-04', meter_version: 1 });
    await expect(settleExecution(env, { ...receipt, duration_ms: 501 })).rejects.toThrow(/different receipt|different/i);
  });

  it('compensates a cancelled queued generation and fences a delayed capacity prepare', async () => {
    const { env, network } = await fixture(1);
    const blocker = await reserveExecution(env, job('blocker', 'u_two'));
    const waiting = await reserveExecution(env, job('waiting'));
    expect(waiting.status).toBe('queued');
    await cancelExecutionReservation(env, { account_id: 'u_two', reservation_id: blocker.reservation_id, fence: blocker.fence });
    let entered!: () => void, release!: () => void;
    const entering = new Promise<void>((r) => { entered = r; });
    const paused = new Promise<void>((r) => { release = r; });
    let intercepted = false;
    network.intercept = async (target, request, deliver) => {
      if (!intercepted && target.startsWith('capacity:') && new URL(request.url).pathname.endsWith('/reserve')) {
        intercepted = true; entered(); await paused;
      }
      return deliver();
    };
    const late = reserveExecution(env, job('waiting')).then((value) => ({ value }), (error: unknown) => ({ error }));
    await entering;
    await cancelExecutionReservation(env, { account_id: 'u_one', reservation_id: waiting.reservation_id, fence: waiting.fence });
    release();
    expect(await late).toHaveProperty('error');
    expect((await snapshot(env)).budgets[0]!.reserved_units).toBe('0');
    const platform = await admissionRequest<{ control: AdmissionControl; budgets: Budget[] }>(env, 'capacity:slice_local', 'snapshot');
    expect(platform.control.active_slots).toBe(0);
    expect(platform.budgets[0]!.reserved_units).toBe('0');
    await expect(startExecution(env, { account_id: 'u_one', reservation_id: waiting.reservation_id, fence: waiting.fence, runtime_id: 'stale_runtime' })).rejects.toThrow();
  });

  it('retains uncertainty through a lost capacity reply and never expiry-releases a possible runtime', async () => {
    const { env, network } = await fixture();
    let lost = false;
    network.intercept = async (target, request, deliver) => {
      const response = await deliver();
      if (!lost && target.startsWith('capacity:') && new URL(request.url).pathname.endsWith('/reserve')) { lost = true; throw new Error('lost committed response'); }
      return response;
    };
    await expect(reserveExecution(env, job('uncertain'))).rejects.toThrow();
    expect((await snapshot(env)).budgets[0]!.reserved_units).toBe('100000');
    network.intercept = undefined;
    const recovered = await reserveExecution(env, job('uncertain'));
    await startExecution(env, { account_id: 'u_one', reservation_id: recovered.reservation_id, fence: recovered.fence, runtime_id: 'runtime_uncertain' });
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 60_000);
    await network.objects.get('account:u_one')!.controller.alarm();
    const current = await snapshot(env);
    expect(current.control.stopped).toBe(true);
    expect(current.budgets[0]!.reserved_units).toBe('100000');
    await expect(cancelExecutionReservation(env, { account_id: 'u_one', reservation_id: recovered.reservation_id, fence: recovered.fence })).rejects.toThrow(/termination|runtime/i);
    await env.DB.prepare("UPDATE billing_platform_pools SET state='stopped' WHERE id='pool_local'").run();
    await settleExecution(env, { account_id: 'u_one', reservation_id: recovered.reservation_id, fence: recovered.fence,
      runtime_id: 'runtime_uncertain', event_id: 'cleanup_after_stop', duration_ms: 1000, outcome: 'infrastructure_failure',
      termination_proof: { kind: 'hosted_destroyed', receipt_id: 'reaper_verified_destroyed', verified_at: now() } });
    expect((await snapshot(env)).budgets[0]!.reserved_units).toBe('0');
    expect(await one(env.DB, "SELECT amount_units FROM billing_ledger WHERE event_id='cleanup_after_stop' AND kind='infrastructure_refund' AND meter='hosted.linux-small'")).toEqual({ amount_units: '-100000' });
  });
});

describe('standalone storage ownership, quotas and rolling commitments', () => {
  it('tombstones a never-admitted deleting intent before a delayed admission can create a meter', async () => {
    const { env, network } = await fixture();
    const id = 'obj_denied_intent', key = `u_one/r_one/uploads/${id}`;
    await env.DB.prepare(`INSERT INTO object_manifests(id,account_id,repo_id,kind,object_key,filename,bytes,sha256,state,created_by,created_at,updated_at)
      VALUES (?,'u_one','r_one','attachment',?,'file',4,?,'deleting','u_one',?,?)`).bind(id, key, await sha256('data'), now(), now()).run();
    let entered!: () => void, release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    network.intercept = async (target, request, deliver) => {
      if (target === 'account:u_one' && new URL(request.url).pathname.endsWith('/standalone-reserve')) { entered(); await paused; }
      return deliver();
    };
    const late = reserveStandaloneStorage(env, { account_id: 'u_one', repo_id: 'r_one', actor_id: 'u_one', object_id: id, key, bucket: 'blobs', maximum_bytes: '4', retention_until: null }).catch((error: unknown) => error);
    await started;
    const cancelled = await cancelStandaloneStorageIntent(env, { account_id: 'u_one', object_id: id, repo_id: 'r_one' });
    expect(cancelled).toMatchObject({ id, key, state: 'cancelled', source: 'standalone', reservation_id: null, fence: null });
    release();
    expect(await late).toBeInstanceOf(Error);
    expect((await snapshot(env)).control.reserved_bytes).toBe('0');
    expect(await one(env.DB, 'SELECT COUNT(*) AS count FROM billing_storage_objects')).toEqual({ count: 0 });
  });

  it('dispatches expiry to the feature owner and never finalizes its manifest or associations', async () => {
    const { env, blobs } = await fixture();
    const object = await reserveStandaloneStorage(env, { account_id: 'u_one', repo_id: null, actor_id: 'u_one', object_id: 'obj_owner_cleanup',
      key: 'u_one/assets/uploads/obj_owner_cleanup', bucket: 'blobs', maximum_bytes: '4', retention_until: new Date(Date.now() + 1000).toISOString() });
    await readyManifest(env, object, await sha256('data'), 4, 'uploading');
    const head = await blobs.put(object.key, 'data');
    await commitStorageObject(env, { account_id: 'u_one', reservation_id: object.reservation_id, fence: object.fence,
      object_id: object.id, bytes: '4', etag: head!.etag, checksum: await sha256('data') });
    await env.DB.prepare("UPDATE object_manifests SET state='ready',storage_accrued_at=? WHERE id=?").bind(now(), object.id).run();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 2000);
    let requested = await admissionRequest<StorageObject>(env, 'account:u_one', 'storage-expire', { object_id: object.id });
    expect(requested.state).toBe('stored');
    expect(await blobs.head(object.key)).not.toBeNull();
    expect(await one(env.DB, 'SELECT state FROM object_manifests WHERE id=?', object.id)).toEqual({ state: 'ready' });
    await claimStorageDeletion(env, { account_id: 'u_one', object_id: object.id, request_id: requested.deletion_request_id! });
    const cancelledId = requested.deletion_request_id!;
    const claim = { account_id: 'u_one', object_id: object.id, request_id: cancelledId };
    await releaseStorageDeletionClaim(env, claim);
    await releaseStorageDeletionClaim(env, claim);
    requested = await admissionRequest<StorageObject>(env, 'account:u_one', 'storage-expire', { object_id: object.id });
    expect(requested.deletion_request_id).not.toBe(cancelledId);
    expect((await admissionRequest<StorageObject>(env, 'account:u_one', 'storage-expire', { object_id: object.id })).deletion_request_id).toBe(requested.deletion_request_id);
    await releaseStorageDeletionClaim(env, claim); // A replay cannot cancel the newer live claim.
    await claimStorageDeletion(env, { account_id: 'u_one', object_id: object.id, request_id: requested.deletion_request_id! });
    await claimStorageDeletion(env, { account_id: 'u_one', object_id: object.id, request_id: requested.deletion_request_id! });
    await env.DB.prepare("UPDATE object_manifests SET state='deleting' WHERE id=?").bind(object.id).run();
    await deleteStorageObject(env, { account_id: 'u_one', object_id: object.id });
    expect(await blobs.head(object.key)).toBeNull();
    expect(await one(env.DB, 'SELECT state FROM object_manifests WHERE id=?', object.id)).toEqual({ state: 'deleting' });
    expect(await one(env.DB, 'SELECT state FROM billing_storage_deletion_requests WHERE id=?', requested.deletion_request_id)).toEqual({ state: 'financially_deleted' });
    expect(await one(env.DB, 'SELECT state FROM billing_storage_deletion_requests WHERE id=?', cancelledId)).toEqual({ state: 'cancelled' });
    expect((await snapshot(env)).control.stored_bytes).toBe('0');
    expect((await reserveExecution(env, job('after-retention-reclaim'))).status).toBe('reserved');
  });

  it('shares one account byte quota across repository shards, admits assets without runs, and rejects ambiguous aborts', async () => {
    const { env, db, blobs } = await fixture();
    const shard = await createTestDatabase(); opened.push(shard);
    shard.sqlite.exec(`INSERT INTO users(id,username,email,email_verified_at,created_at,updated_at) SELECT 'u_one','one','one@example.net','2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z';
      INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES('u_one','user','one','one','u_one','2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z');
      INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
      VALUES('r_shard','u_one','shard','shard','private','active','local','other','storage_shard','u_one','2026-10-05T00:00:00.000Z','2026-10-05T00:00:00.000Z');`);
    env.SHARD_BINDINGS_JSON = '{"other":"OTHER_DB"}'; env.OTHER_DB = shard.binding();
    await env.DB.prepare("INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,state,updated_at) VALUES('r_shard','repository','local','other','active',?)").bind(now()).run();
    const control = (await snapshot(env)).control;
    await admissionRequest(env, 'account:u_one', 'limits', { max_concurrency: 1, max_storage_bytes: '10', revision: control.revision });
    const replies = await Promise.allSettled(['r_one', 'r_shard'].map((repo, i) => reserveStandaloneStorage(env, { account_id: 'u_one', repo_id: repo,
      actor_id: 'u_one', object_id: `obj_shard_${i}`, key: `u_one/${repo}/uploads/obj_shard_${i}`, bucket: 'blobs', maximum_bytes: '6', retention_until: null })));
    expect(replies.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await snapshot(env)).control.reserved_bytes).toBe('6');
    const asset = await reserveStandaloneStorage(env, { account_id: 'u_one', repo_id: null, actor_id: 'u_one', object_id: 'obj_avatar', key: 'u_one/assets/uploads/obj_avatar', bucket: 'blobs', maximum_bytes: '4', retention_until: null });
    expect(asset.attribution).toMatchObject({ repo_id: null, run_id: null, attempt_id: null, generation: null });
    expect((await snapshot(env)).control.active_slots).toBe(0);
    const checksum = await sha256('data');
    await readyManifest(env, asset, checksum, 4);
    await db.prepare("UPDATE object_manifests SET state='deleting',upload_generation=1,upload_bytes_received=0 WHERE id='obj_avatar'").run();
    await expect(deleteStorageObject(env, { account_id: 'u_one', object_id: 'obj_avatar' })).rejects.toThrow(/unconfirmed|upload|invalid/i);
    expect((await snapshot(env)).control.reserved_bytes).toBe('10');
    await db.prepare("UPDATE object_manifests SET upload_generation=0,billing_reservation_id=NULL,billing_fence=NULL WHERE id='obj_avatar'").run();
    await deleteStorageObject(env, { account_id: 'u_one', object_id: 'obj_avatar' });
    expect((await snapshot(env)).control.reserved_bytes).toBe('6');
    expect(blobs.objects.size).toBe(0);
    expect(await one(env.DB, 'SELECT COUNT(*) AS count FROM billing_reservations')).toEqual({ count: 0 });
  });

  it('renews nullable retention, retains committed quota until real deletion, and carries exact byte-time', async () => {
    const { env, blobs } = await fixture();
    const object = await reserveStandaloneStorage(env, { account_id: 'u_one', repo_id: null, actor_id: 'u_one', object_id: 'obj_retained', key: 'u_one/assets/uploads/obj_retained',
      bucket: 'blobs', maximum_bytes: '4', retention_until: null });
    const stored = await blobs.put(object.key, 'data');
    await readyManifest(env, object, await sha256('data'), 4, 'uploading');
    await commitStorageObject(env, { account_id: 'u_one', reservation_id: object.reservation_id, fence: object.fence, object_id: object.id, bytes: '4', etag: stored!.etag, checksum: await sha256('data') });
    await env.DB.prepare("UPDATE object_manifests SET state='ready',storage_accrued_at=? WHERE id=?").bind(now(), object.id).run();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(object.renew_after!) + 1);
    const renewed = await renewStorageCommitment(env, { account_id: 'u_one', object_id: object.id });
    expect(renewed.retention_until).toBeNull();
    expect(renewed.commitment_until > object.commitment_until).toBe(true);
    expect((await snapshot(env)).control.stored_bytes).toBe('4');
    const originalDelete = env.BLOBS.delete.bind(env.BLOBS);
    env.BLOBS.delete = async () => { throw new Error('provider deletion unavailable'); };
    await env.DB.prepare("UPDATE object_manifests SET state='deleting' WHERE id=?").bind(object.id).run();
    await expect(deleteStorageObject(env, { account_id: 'u_one', object_id: object.id })).rejects.toThrow();
    expect((await snapshot(env)).control.stored_bytes).toBe('4');
    env.BLOBS.delete = originalDelete;
    await deleteStorageObject(env, { account_id: 'u_one', object_id: object.id });
    await deleteStorageObject(env, { account_id: 'u_one', object_id: object.id });
    expect(await blobs.head(object.key)).toBeNull();
    expect((await snapshot(env)).control.stored_bytes).toBe('0');
    const lines = await many<{ quantity: string; amount_units: string }>(env.DB, 'SELECT quantity,amount_units FROM billing_ledger WHERE object_id=? AND operating_cost=0', object.id);
    const quantity = lines.reduce((sum, row) => sum + BigInt(row.quantity), 0n);
    expect(lines.reduce((sum, row) => sum + BigInt(row.amount_units), 0n)).toBe(quantity * 30_000_000n / 2_592_000_000_000_000_000n);
  });

  it('coalesces repeated sweeps while preserving exact money, carry and unknown holds across owner cutover and deletion', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.parse('2026-10-05T17:24:23.334Z'); vi.setSystemTime(start);
    const { env: bindings, db, blobs, network } = await fixture();
    const env = bindings as BillingBindings & OperationsBindings;
    const objects: StorageObject[] = [];
    for (let i = 0; i < 55; i++) {
      const value = 'x'.repeat(i === 0 ? 262147 : 204 + i);
      const object = await reserveStandaloneStorage(env, { account_id: 'u_one', repo_id: 'r_one', actor_id: 'u_one', object_id: `obj_sweep_${i}`,
        key: `u_one/r_one/sweep/${i}`, bucket: 'blobs', maximum_bytes: String(value.length), retention_until: null });
      const head = await blobs.put(object.key, value);
      const digest = await sha256(value);
      const stored = await commitStorageObject(env, { account_id: 'u_one', object_id: object.id, reservation_id: object.reservation_id, fence: object.fence,
        bytes: String(value.length), etag: head!.etag, checksum: digest });
      await readyManifest(env, stored, digest, value.length, 'ready');
      await env.DB.prepare('UPDATE object_manifests SET storage_accrued_at=? WHERE id=?').bind(stored.accrued_at, stored.id).run();
      objects.push(stored);
    }
    const pending = await reserveStandaloneStorage(env, { account_id: 'u_one', repo_id: null, actor_id: 'u_one', object_id: 'obj_sweep_pending',
      key: 'u_one/assets/sweep/pending', bucket: 'blobs', maximum_bytes: '128', retention_until: null });
    const publication = await canonicalPublication(env, 'git_sweep', { reachable: '16387', added: '16387', growth: '16643' });
    const grant = await gitCosts.reserveStorage(env, publication.input); await publication.outcome('committed', grant);
    await gitCosts.commitStorage(env, publication.commitInput(grant));
    const gitInput = { repo_id: 'r_one', storage_name: 'storage_one' };
    const gitMeter = await admissionRequest<CanonicalGitMeter>(env, 'account:u_one', 'git-meter', gitInput);
    const before = await snapshot(env), exposure = (budget: Budget) => BigInt(budget.settled_units) + BigInt(budget.reserved_units) + BigInt(budget.commitment_units);
    const changes = () => Number(db.sqlite.prepare('SELECT total_changes() AS n').get()!.n);
    const periodicEvents = () => Number(db.sqlite.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type IN ('billing.storage.accrued','billing.git.storage_accrued')").get()!.n);
    const ledgerCount = () => Number(db.sqlite.prepare('SELECT COUNT(*) AS n FROM billing_ledger').get()!.n);
    await sweepBilling(env); // Establish the two cursor rows before measuring idle work.
    const baseline = { changes: changes(), ledger: ledgerCount(), events: periodicEvents() };
    for (let tick = 1; tick <= 212; tick++) {
      vi.setSystemTime(start + tick * 15000);
      if (tick === 143) await Promise.all([sweepBilling(env), sweepBilling(env), accrueObjects(env)]); // All see the first due UTC checkpoint.
      else { await sweepBilling(env); await accrueObjects(env); }
      if (tick === 100) expect(changes()).toBe(baseline.changes);
    }
    expect(periodicEvents() - baseline.events).toBe(56);
    expect(ledgerCount() - baseline.ledger).toBe(112);
    expect(changes() - baseline.changes).toBeLessThan(2000);
    for (const object of objects) {
      const stored = await admissionRequest<StorageObject>(env, 'account:u_one', 'get-object', { object_id: object.id });
      expect(stored.accrued_at).toBe('2026-10-05T18:00:00.000Z'); expect(stored.rate).toEqual(object.rate);
    }
    expect(await admissionRequest(env, 'account:u_one', 'get-object', { object_id: pending.id })).toEqual(pending);
    expect(exposure((await snapshot(env)).budgets[0]!)).toBe(exposure(before.budgets[0]!));
    // Uncheckpointed consumption remains covered by the full admitted commitment.
    await cap(env, exposure(before.budgets[0]!).toString());
    await expect(reserveStandaloneStorage(env, { account_id: 'u_one', repo_id: 'r_one', actor_id: 'u_one', object_id: 'obj_sweep_no_headroom',
      key: 'u_one/r_one/sweep/no-headroom', bucket: 'blobs', maximum_bytes: '1', retention_until: null })).rejects.toMatchObject({ code: 'budget_exhausted' });
    await cap(env, before.budgets[0]!.limit_units);
    const forcedAt = now();
    expect((await accrueStorage(env, { account_id: 'u_one', object_id: objects[0]!.id, through: forcedAt })).accrued_at).toBe(forcedAt);
    await env.DB.batch([
      stmt(env.DB, "UPDATE repositories SET state='transfer_pending' WHERE id='r_one'"),
      stmt(env.DB, `INSERT INTO repository_transfers(id,repo_id,source_owner_id,destination_owner_id,destination_name,previous_state,state,operation_id,expires_at,accepted_by,accepted_at,created_by,created_at,updated_at)
        VALUES('sweep_transfer','r_one','u_one','u_two','one','active','accepted','op_sweep_transfer','2099-01-01T00:00:00.000Z','u_two',?,'u_one',?,?)`, now(), now(), now()),
    ]);
    let prepared;
    do { prepared = await prepareRepositoryStorageTransfer(env, { operation_id: 'op_sweep_transfer', repo_id: 'r_one', from_account_id: 'u_one', to_account_id: 'u_two', actor_id: 'u_two' }); }
    while (prepared.state !== 'prepared');
    vi.setSystemTime(Date.now() + 1234); const boundary = now();
    await env.DB.prepare("UPDATE repositories SET owner_id='u_two',updated_at=? WHERE id='r_one'").bind(boundary).run();
    let committed;
    do { committed = await commitRepositoryStorageTransfer(env, { operation_id: 'op_sweep_transfer', effective_at: boundary }); }
    while (committed.state !== 'complete');
    for (const object of objects) expect(await admissionRequest<StorageObject>(env, 'account:u_two', 'get-object', { object_id: object.id }))
      .toMatchObject({ account_id: 'u_two', accrued_at: boundary, rate: object.rate });
    vi.setSystemTime('2026-10-05T18:43:31.987Z'); const deletedAt = now();
    const deleteOriginal = env.BLOBS.delete.bind(env.BLOBS);
    env.BLOBS.delete = async () => { throw new Error('Original provider deletion has not been confirmed'); };
    await expect(deleteStorageObject(env, { account_id: 'u_two', object_id: objects[0]!.id })).rejects.toThrow();
    expect((await snapshot(env, 'u_two')).control.stored_bytes).toBe((objects.reduce((total, object) => total + BigInt(object.bytes), 0n) + 16643n).toString());
    const retained = await admissionRequest(env, 'account:u_two', 'get-object', { object_id: objects[0]!.id });
    await sweepBilling(env);
    expect(await admissionRequest(env, 'account:u_two', 'get-object', { object_id: objects[0]!.id })).toEqual(retained);
    expect(await admissionRequest(env, 'account:u_one', 'get-object', { object_id: pending.id })).toEqual(pending);
    env.BLOBS.delete = deleteOriginal;
    for (const object of objects) await deleteStorageObject(env, { account_id: 'u_two', object_id: object.id });
    await env.DB.batch([
      stmt(env.DB, "INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,status,created_at,updated_at) VALUES('op_sweep_purge','repository.purge','r_one','r_one','u_two','u_two','running',?,?)", now(), now()),
      stmt(env.DB, "INSERT INTO operation_steps(operation_id,name,state,idempotency_key,receipt_json,completed_at) VALUES('op_sweep_purge','fence-writes','completed','sweep_purge_fence',?,?)", JSON.stringify({ repository: { storage_name: 'storage_one' } }), now()),
      stmt(env.DB, "INSERT INTO operation_steps(operation_id,name,state,idempotency_key,receipt_json,completed_at) VALUES('op_sweep_purge','purge-storage','completed','sweep_purge_verified','{\"deleted\":true,\"storage_verified\":true}',?)", now()),
    ]);
    await admissionRequest(env, 'account:u_two', 'git-purge', gitInput);
    const totalBytes = objects.reduce((total, object) => total + BigInt(object.bytes), 0n);
    const oldElapsed = BigInt(Date.parse(boundary) - start), newElapsed = BigInt(Date.parse(deletedAt) - Date.parse(boundary));
    const exact = async (coordinator: string, rate: StorageObject['rate'], quantity: bigint, accountId?: string) => {
      const platform = coordinator.startsWith('capacity:');
      const lines = await many<{ kind: string; quantity: string; amount_units: string; price_id: string; meter_version: number }>(env.DB,
        'SELECT kind,quantity,amount_units,price_id,meter_version FROM billing_ledger WHERE meter=? AND operating_cost=? AND (? IS NULL OR account_id=?)',
        rate.meter, platform ? 1 : 0, accountId ?? null, accountId ?? null);
      expect(lines.every(line => line.price_id === rate.id && line.meter_version === rate.meter_version)).toBe(true);
      expect(lines.filter(line => line.kind === 'usage').reduce((sum, line) => sum + BigInt(line.quantity), 0n)).toBe(quantity);
      const numerator = quantity * BigInt(platform ? rate.platform_unit_price_units : rate.unit_price_units), denominator = BigInt(rate.unit_quantity);
      expect(lines.reduce((sum, line) => sum + BigInt(line.amount_units), 0n)).toBe(numerator / denominator);
      expect(await network.objects.get(coordinator)!.storage.get(`remainder:closed-storage:${rate.id}:${rate.meter_version}`)).toBe((numerator % denominator).toString());
    };
    for (const [account, elapsed] of [['u_one', oldElapsed], ['u_two', newElapsed]] as const) {
      await exact(`account:${account}`, objects[0]!.rate, totalBytes * elapsed, account);
      await exact(`account:${account}`, gitMeter.rates.logical, 16387n * elapsed, account);
    }
    await exact('capacity:slice_local', objects[0]!.rate, totalBytes * (oldElapsed + newElapsed));
    await exact('capacity:slice_local', gitMeter.rates.peak, 16643n);
    expect((await snapshot(env, 'u_two')).control).toMatchObject({ stored_bytes: '0', reserved_bytes: '0' });
    expect((await snapshot(env)).control).toMatchObject({ stored_bytes: '0', reserved_bytes: '128' });
    expect(await admissionRequest(env, 'account:u_one', 'get-object', { object_id: pending.id })).toEqual(pending);
    const terminalLedger = ledgerCount();
    for (const object of objects) await deleteStorageObject(env, { account_id: 'u_two', object_id: object.id });
    await admissionRequest(env, 'account:u_two', 'git-purge', gitInput);
    expect(ledgerCount()).toBe(terminalLedger);
    const retention = new Date(Date.now() + 61234).toISOString();
    const expiring = await reserveStandaloneStorage(env, { account_id: 'u_two', repo_id: null, actor_id: 'u_two', object_id: 'obj_sweep_expiring',
      key: 'u_two/assets/sweep/expiring', bucket: 'blobs', maximum_bytes: '4', retention_until: retention });
    const expiringHead = await blobs.put(expiring.key, 'data');
    await commitStorageObject(env, { account_id: 'u_two', object_id: expiring.id, reservation_id: expiring.reservation_id, fence: expiring.fence,
      bytes: '4', etag: expiringHead!.etag, checksum: await sha256('data') });
    vi.setSystemTime(Date.parse(retention) + 100);
    await sweepBilling(env);
    const due = await admissionRequest<StorageObject>(env, 'account:u_two', 'get-object', { object_id: expiring.id });
    expect(due.accrued_at).toBe(retention);
    expect(await one(env.DB, 'SELECT state FROM billing_storage_deletion_requests WHERE id=?', due.deletion_request_id)).toEqual({ state: 'pending' });
    await deleteStorageObject(env, { account_id: 'u_two', object_id: expiring.id });
    expect(await admissionRequest(env, 'account:u_one', 'get-object', { object_id: pending.id })).toEqual(pending);
  });

  it('prepares receiver funding before a prospective owner boundary and keeps all historical charges with the former owner', async () => {
    const { env, blobs } = await fixture();
    const object = await reserveStandaloneStorage(env, { account_id: 'u_one', repo_id: 'r_one', actor_id: 'u_one', object_id: 'obj_transfer', key: 'u_one/r_one/uploads/obj_transfer',
      bucket: 'blobs', maximum_bytes: '4', retention_until: null });
    const head = await blobs.put(object.key, 'data');
    await commitStorageObject(env, { account_id: 'u_one', reservation_id: object.reservation_id, fence: object.fence, object_id: object.id, bytes: '4', etag: head!.etag, checksum: await sha256('data') });
    await env.DB.batch([
      stmt(env.DB, "UPDATE repositories SET state='transfer_pending' WHERE id='r_one'"),
      stmt(env.DB, `INSERT INTO repository_transfers(id,repo_id,source_owner_id,destination_owner_id,destination_name,previous_state,state,operation_id,expires_at,accepted_by,accepted_at,created_by,created_at,updated_at)
        VALUES('transfer_one','r_one','u_one','u_two','one','active','accepted','op_transfer','2099-01-01T00:00:00.000Z','u_two',?,'u_one',?,?)`, now(), now(), now()),
    ]);
    expect((await prepareRepositoryStorageTransfer(env, { operation_id: 'op_transfer', repo_id: 'r_one', from_account_id: 'u_one', to_account_id: 'u_two', actor_id: 'u_two' })).state).toBe('prepared');
    expect((await snapshot(env, 'u_one')).control.stored_bytes).toBe('4');
    expect((await snapshot(env, 'u_two')).control.stored_bytes).toBe('4');
    const boundary = now();
    await env.DB.prepare("UPDATE repositories SET owner_id='u_two',updated_at=? WHERE id='r_one'").bind(boundary).run();
    expect((await commitRepositoryStorageTransfer(env, { operation_id: 'op_transfer', effective_at: boundary })).state).toBe('complete');
    const receipts = await storageTransferReceipts(env, 'op_transfer');
    expect(receipts.items[0]).toMatchObject({ object_id: object.id, account_id: 'u_two' });
    expect((await snapshot(env, 'u_one')).control.stored_bytes).toBe('0');
    expect((await snapshot(env, 'u_two')).control.stored_bytes).toBe('4');
    expect(await blobs.head(object.key)).not.toBeNull();
    const oldLines = await many<{ account_id: string }>(env.DB, 'SELECT account_id FROM billing_ledger WHERE object_id=? AND operating_cost=0', object.id);
    expect(oldLines.every((line) => line.account_id === 'u_one')).toBe(true);
  });
});

describe('commercial exactness', () => {
  it('settles and rolls recurring plan/seat commitments atomically, including a lost rollover reply', async () => {
    const { env, network } = await fixture();
    for (const [accountId, planId] of [['u_one', 'plan_pro_202610'], ['u_two', 'plan_team_202610']] as const) {
      await cap(env, '100000000000', '0', accountId);
      const account = await ensureBillingAccount(env, accountId);
      await changeSubscription(env, { account_id: accountId, plan_id: planId, expected_revision: account.revision, actor_id: accountId, request_id: 'paid-plan' });
    }
    const team = await ensureBillingAccount(env, 'u_two');
    const seats = await reserveSeatChange(env, { account_id: 'u_two', principal_id: 'u_one', additional_seats: 2, request_id: 'team-seats', expected_revision: team.revision });
    await env.DB.batch(await seatAcceptanceStatements(env.DB, { account_id: 'u_two', principal_id: 'u_one', reservation_id: seats.reservation_id }));
    const period = await ensureBillingAccount(env, 'u_one');
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(period.period_end) + 1000);
    let lost = false;
    network.intercept = async (target, request, deliver) => {
      const response = await deliver();
      if (!lost && target === 'account:u_one' && new URL(request.url).pathname.endsWith('/rollover') && response.ok) { lost = true; throw new Error('lost rollover receipt'); }
      return response;
    };
    await expect(closeInvoice(env, 'u_one')).rejects.toThrow();
    expect((await snapshot(env)).budgets.find(b => b.period_end === null)!.commitment_units).toBe('9000000000');
    await expect(cap(env, '1')).rejects.toThrow(/commitment|cap/i);
    const pending = (await one<{ invoice_id: string }>(env.DB, "SELECT invoice_id FROM billing_invoice_finalizations WHERE account_id='u_one'"))!;
    network.intercept = undefined;
    await finalizeInvoiceAdmission(env, pending.invoice_id);
    await closeInvoice(env, 'u_two');
    expect((await snapshot(env, 'u_two')).budgets.find(b => b.period_end === null)!.commitment_units).toBe('36000000000');
    await expect(cap(env, '1', '0', 'u_two')).rejects.toThrow();
    const next = await ensureBillingAccount(env, 'u_one'); vi.setSystemTime(Date.parse(next.period_end) + 1000);
    expect((await closeInvoice(env, 'u_one')).subtotal_units).toBe('9000000000');
    expect((await closeInvoice(env, 'u_two')).subtotal_units).toBe('36000000000');
    expect(await one(env.DB, "SELECT COUNT(*) AS count FROM billing_invoice_finalizations WHERE state<>'complete'")).toEqual({ count: 0 });
    expect((await snapshot(env)).budgets.find(b => b.period_end === null)!.commitment_units).toBe('9000000000');
  });

  it('reconciles independent capacity contributions without losing exact global totals on replay', async () => {
    const { env } = await fixture();
    await env.DB.prepare(`INSERT INTO billing_capacity_slices(id,pool_id,cell_id,limit_units,max_instances,max_storage_bytes,valid_until,state,created_at)
      VALUES('slice_second','pool_local','local','100000000000',2,'1000000000000','2099-01-01T00:00:00.000Z','active',?)`).bind(now()).run();
    for (const [index, slice] of ['slice_local', 'slice_second'].entries()) {
      env.BILLING_PLATFORM_SLICE_ID = slice;
      const reservation = await reserveExecution(env, job(`slice_${index}`));
      const identity = { account_id: 'u_one', reservation_id: reservation.reservation_id, fence: reservation.fence, runtime_id: `slice_runtime_${index}` };
      await startExecution(env, identity);
      const receipt = { ...identity, event_id: `slice_receipt_${index}`, duration_ms: 1000, outcome: 'success' as const,
        termination_proof: { kind: 'hosted_destroyed' as const, receipt_id: `slice_destroyed_${index}`, verified_at: now() } };
      await settleExecution(env, receipt); await settleExecution(env, receipt);
    }
    const totals = await usageRollups(env.DB, { account_id: 'u_one', period: now().slice(0, 7), dimension: 'account', operating_cost: true });
    expect(totals.find(row => row.meter === 'hosted.linux-small')).toMatchObject({ quantity: '2000', amount_units: '83332' });
    const entries = await many<{ amount_units: string }>(env.DB, "SELECT amount_units FROM billing_ledger WHERE account_id='u_one' AND meter='hosted.linux-small' AND operating_cost=1");
    expect(entries.reduce((sum, entry) => sum + BigInt(entry.amount_units), 0n)).toBe(83332n);
    expect(await one(env.DB, "SELECT COUNT(*) AS count FROM billing_usage_rollups WHERE account_id='u_one' AND dimension='account' AND meter='hosted.linux-small' AND operating_cost=1")).toEqual({ count: 2 });
  });
  it('recovers the original externally journaled budget command after a lost reply and returns current authorized state', async () => {
    const test = await fixture();
    const principal: Principal = { id: 'u_one', kind: 'user', user_id: 'u_one', credential_id: null, capabilities: null, repository_ids: null, account_ids: null, mfa: false };
    const app = new Hono<AppEnv>(); app.onError(errorResponse);
    app.use('*', async (c, next) => { c.set('principal', principal); c.set('requestId', 'billing_http_request'); c.set('database', c.env.DB.withSession('first-primary')); await next(); });
    registerBillingRoutes(app);
    let lost = false;
    test.network.intercept = async (target, request, deliver) => {
      const response = await deliver();
      if (!lost && target === 'account:u_one' && new URL(request.url).pathname.endsWith('/budget') && response.ok) { lost = true; throw new Error('lost completed budget reply'); }
      return response;
    };
    const request = () => app.fetch(new Request('https://api.gitknot.com/v1/accounts/u_one/budgets', { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'budget-request' },
      body: JSON.stringify({ scope: 'account', scope_id: 'u_one', limit_units: '1000000000' }) }), test.env, test.context);
    expect((await request()).status).toBe(503);
    const replay = await request();
    expect(replay.status, await replay.clone().text()).toBe(201);
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    const created = await replay.json() as Budget;
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM billing_api_operations')).toEqual({ count: 1 });
    await admissionRequest(test.env, 'account:u_one', 'budget', { budget: { ...created, limit_units: '2000000000' }, expected_revision: created.revision });
    expect((await (await request()).json() as Budget).limit_units).toBe('2000000000');
    expect(await one(test.env.DB, "SELECT response_body,strategy FROM idempotency_keys WHERE principal_id='u_one' AND key='budget-request'")).toEqual({ response_body: null, strategy: 'external' });
    await test.env.DB.prepare("UPDATE principals SET disabled_at=? WHERE id='u_one'").bind(now()).run();
    expect([403, 404]).toContain((await request()).status);
  });

  it('preserves sub-cent carry, immutable credits and an idempotent monthly invoice', async () => {
    const { env } = await fixture();
    const account = await ensureBillingAccount(env, 'u_one');
    const first = await grantCredit(env, { account_id: 'u_one', amount_units: '100000000000000000000', reason: 'Contractual credit', source: 'operator', source_id: 'contract_1', actor_id: 'operator' });
    expect((await grantCredit(env, { account_id: 'u_one', amount_units: first.amount_units, reason: first.reason, source: 'operator', source_id: 'contract_1', actor_id: 'operator' })).id).toBe(first.id);
    expect(invoiceRounding('6000000')).toEqual({ cents: '1', rounded_units: '10000000', carry_units: '-4000000' });
    expect(invoiceRounding('0', '-4000000')).toEqual({ cents: '0', rounded_units: '0', carry_units: '-4000000' });
    await snapshot(env);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(account.period_end) + 1000);
    const invoice = await closeInvoice(env, 'u_one');
    expect(invoice.state).toBe('paid');
    expect(invoice.subtotal_units).toBe('0');
    expect(await one(env.DB, 'SELECT COUNT(*) AS count FROM billing_invoices WHERE account_id=?', 'u_one')).toEqual({ count: 1 });
  });
});

async function canonicalPublication(env: BillingBindings, operationId: string, options: { repo_id?: string; baseline?: string; reachable?: string; growth?: string; added?: string; storage_name?: string; kind?: string } = {}) {
  const repo = (await one<{ id: string; owner_id: string; storage_name: string; routing_epoch: number; policy_revision: number }>(env.DB, 'SELECT * FROM repositories WHERE id=?', options.repo_id ?? 'r_one'))!;
  const updates = [{ ref: 'refs/heads/main', old_oid: (options.baseline ?? '0') === '0' ? '0'.repeat(40) : 'a'.repeat(40), new_oid: options.reachable === '0' ? '0'.repeat(40) : 'a'.repeat(40) }];
  const body = { version: 1, policy_revision: repo.policy_revision, supplied_objects: 1, supplied_bytes: 4, updates,
    storage: { model: 'logical-reachable-v1', baseline_bytes: options.baseline ?? '0', reachable_bytes: options.reachable ?? '4',
      new_object_bytes: options.added ?? '4', object_count: options.reachable === '0' ? '0' : '1', object_manifest_digest: 'c'.repeat(64), maximum_growth_bytes: options.growth ?? '1000' } };
  const evidence = { ...body, digest: await sha256(JSON.stringify(body)), marker_oid: 'b'.repeat(40), marker_object_bytes: '6' };
  const storageName = options.storage_name ?? repo.storage_name;
  const context = { repository: { ...repo, storage_name: storageName }, storage_admission: { requested: true, settled: false } as Record<string, unknown> };
  const input: CanonicalGitStorageInput = { account_id: repo.owner_id, repo_id: repo.id, actor_id: repo.owner_id, operation_id: operationId,
    storage_name: storageName, routing_epoch: repo.routing_epoch, maximum_growth_bytes: body.storage.maximum_growth_bytes, retention_until: null };
  await env.DB.prepare(`INSERT INTO git_publications(repo_id,id,actor_id,actor_json,kind,state,routing_epoch,policy_revision,publisher_id,context_json,evidence_json,created_at,updated_at)
    VALUES(?,?,?,?,?,'validated',?,?,'publisher_billing',?,?,?,?)`).bind(repo.id, operationId, repo.owner_id, JSON.stringify({ id: repo.owner_id }), options.kind ?? 'push', repo.routing_epoch,
    repo.policy_revision, JSON.stringify(context), JSON.stringify(evidence), now(), now()).run();
  return { input, evidence, async outcome(outcome: 'committed' | 'rejected' | 'uncertain', grant?: { reservation_id: string; fence: string }, proof = outcome === 'committed' ? 'marker' : 'not_started') {
    context.storage_admission = { ...context.storage_admission, ...grant };
    await env.DB.prepare('UPDATE git_publications SET state=?,result_json=?,context_json=?,revision=revision+1,updated_at=? WHERE repo_id=? AND id=?')
      .bind(outcome, JSON.stringify({ outcome, operation_id: operationId, refs: updates, marker_oid: outcome === 'committed' ? evidence.marker_oid : null, proof }), JSON.stringify(context), now(), repo.id, operationId).run();
  }, commitInput(grant: { reservation_id: string; fence: string }) { return { account_id: repo.owner_id, repo_id: repo.id, operation_id: operationId, ...grant,
    reachable_bytes: body.storage.reachable_bytes, new_object_bytes: (BigInt(body.storage.new_object_bytes) + 6n).toString(), object_count: body.storage.object_count,
    evidence_digest: evidence.digest, marker_oid: evidence.marker_oid, verified_at: now() }; },
  rejection: { account_id: repo.owner_id, repo_id: repo.id, operation_id: operationId, rejection_evidence_id: `git-publication:${operationId}:publisher_billing:rejected` } };
}

describe('native Git financial adapters', () => {
  it('admits restoration only at the exact fenced move destination and keeps financial authority global', async () => {
    const { env, db } = await fixture();
    const stage = await createTestDatabase(); opened.push(stage);
    for (const table of ['users', 'accounts', 'principals', 'repositories']) for (const row of db.sqlite.prepare(`SELECT * FROM ${table}`).all()) {
      await stage.prepare(`INSERT OR IGNORE INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).bind(...Object.values(row)).run();
    }
    await stage.prepare("UPDATE repositories SET shard_id='git_stage',routing_epoch=2,state='moving' WHERE id='r_one'").run();
    env.SHARD_BINDINGS_JSON = '{"git_stage":"GIT_STAGE_DB"}'; env.GIT_STAGE_DB = stage.binding();
    await env.DB.prepare(`INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,epoch,state,destination_cell_id,destination_shard_id,operation_id,updated_at)
      VALUES('r_one','repository','local','core',1,'fenced','local','git_stage','op_billing_move',?)`).bind(now()).run();
    const staged = await canonicalPublication({ ...env, DB: stage.binding() }, 'op_billing_move', { kind: 'restore', storage_name: await placementStorageName('r_one', 'op_billing_move') });
    const grant = await gitCosts.reserveStorage(env, staged.input);
    await staged.outcome('committed', grant); await gitCosts.commitStorage(env, staged.commitInput(grant));
    expect((await snapshot(env)).control.stored_bytes).toBe('1000');
    expect(await one(stage.binding(), 'SELECT COUNT(*) AS count FROM billing_git_operations')).toEqual({ count: 0 });
    const unrelated = await canonicalPublication({ ...env, DB: stage.binding() }, 'op_unrelated_restore', { kind: 'restore', storage_name: await placementStorageName('r_one', 'op_unrelated_restore') });
    await expect(gitCosts.reserveStorage(env, unrelated.input)).rejects.toThrow();
  });

  it('funds essential helper lifetime, operations and egress independently and retains uncertain teardown', async () => {
    const { env, network } = await fixture();
    env.BILLING_ESSENTIAL_SLICE_ID = 'slice_essential';
    await env.DB.prepare(`INSERT INTO billing_platform_pools(id,period_start,period_end,limit_units,safety_buffer_units,baseline_commitment_units,max_instances,state,purpose)
      VALUES ('pool_essential',?,'2099-01-01T00:00:00.000Z','10000000000','1000000000','1000000000',1,'active','essential')`).bind(now()).run();
    await allocatePlatformSlices(env, { pool_id: 'pool_essential', expected_revision: 1, slices: [{ id: 'slice_essential', cell_id: 'local', limit_units: '8000000000', max_instances: 1, max_storage_bytes: '0', valid_until: '2099-01-01T00:00:00.000Z' }] });
    const account = await snapshot(env);
    await admissionRequest(env, 'account:u_one', 'stop', { stopped: true, reason: 'Customer CI paused', revision: account.control.revision });
    await env.DB.prepare("UPDATE billing_platform_pools SET state='stopped' WHERE id='pool_local'").run();
    const container = 'd'.repeat(64), allocation = `git_${container}_${crypto.randomUUID()}`;
    const grant = await gitCosts.reserveHelper(env, { service: 'git-helper', allocation_id: allocation, profile: 'standard-2', maximum_duration_ms: 330000, maximum_egress_bytes: '4294967296' });
    const identity = { service: 'git-helper' as const, allocation_id: allocation, reservation_id: grant.reservation_id, fence: grant.fence };
    await gitCosts.startHelper(env, identity);
    expect(await one(env.DB, 'SELECT COUNT(*) AS count FROM billing_reservations')).toEqual({ count: 0 });
    const held = await admissionRequest<{ control: AdmissionControl; budgets: Budget[] }>(env, 'capacity:slice_essential', 'snapshot');
    expect(held.control.active_slots).toBe(1);
    expect(BigInt(held.budgets[0]!.reserved_units)).toBeGreaterThan(300000000n);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 331000);
    await network.objects.get('capacity:slice_essential')!.controller.alarm();
    expect((await admissionRequest<{ budgets: Budget[] }>(env, 'capacity:slice_essential', 'snapshot')).budgets[0]!.reserved_units).toBe(held.budgets[0]!.reserved_units);
    await expect(gitCosts.settleHelper(env, { ...identity, event_id: 'helper-invalid-zero', duration_ms: 0, egress_bytes: '0', termination_proof: { kind: 'never_allocated', receipt_id: 'never-allocated', verified_at: now() } })).rejects.toThrow();
    const receipt = { ...identity, event_id: 'helper-verified-teardown', duration_ms: 332000, egress_bytes: '1000',
      termination_proof: { kind: 'container_destroyed' as const, receipt_id: `container:${container}:${allocation}:destroyed`, verified_at: now() } };
    await gitCosts.settleHelper(env, receipt); await gitCosts.settleHelper(env, receipt);
    const settled = await admissionRequest<{ control: AdmissionControl; budgets: Budget[] }>(env, 'capacity:slice_essential', 'snapshot');
    expect(settled.control.active_slots).toBe(0); expect(settled.budgets[0]!.reserved_units).toBe('0');
    const lines = await many<{ meter: string; quantity: string; meter_version: number; operating_cost: number }>(env.DB, 'SELECT meter,quantity,meter_version,operating_cost FROM billing_ledger WHERE event_id=? ORDER BY meter', receipt.event_id);
    expect(lines).toEqual([{ meter: 'git.helper.egress', quantity: '1000', meter_version: 1, operating_cost: 1 },
      { meter: 'git.helper.operations', quantity: '1024', meter_version: 1, operating_cost: 1 }, { meter: 'git.helper.standard-2', quantity: '332000', meter_version: 1, operating_cost: 1 }]);
    await expect(gitCosts.settleHelper(env, { ...receipt, egress_bytes: '1001' })).rejects.toThrow();
  });

  it('meters verified logical byte-time, keeps daily peak exposure through ref deletion, and settles an exact native purge', async () => {
    const { env } = await fixture();
    const publish = await canonicalPublication(env, 'git_billing_first', { reachable: '100000000', added: '100000000', growth: '100000256' });
    const grant = await gitCosts.reserveStorage(env, publish.input);
    await expect(gitCosts.commitStorage(env, publish.commitInput(grant))).rejects.toThrow();
    await publish.outcome('uncertain', grant);
    await expect(gitCosts.abortStorage(env, publish.rejection)).rejects.toThrow();
    expect((await snapshot(env)).control.reserved_bytes).toBe('100000256');
    await publish.outcome('committed', grant);
    await gitCosts.commitStorage(env, publish.commitInput(grant)); await gitCosts.commitStorage(env, publish.commitInput(grant));
    const before = (await admissionRequest<CanonicalGitMeter>(env, 'account:u_one', 'git-meter', { repo_id: 'r_one', storage_name: 'storage_one' }));
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 86402000);
    await env.DB.prepare(`INSERT INTO billing_prices VALUES('price_git_logical_future','git.storage.logical',2,'next','USD','logical-byte-ms','1','999','0',?)`).bind(now()).run();
    const input = { repo_id: 'r_one', storage_name: 'storage_one' };
    const accrued = await admissionRequest<CanonicalGitMeter>(env, 'account:u_one', 'git-accrue', { ...input, through: now() });
    const logical = await many<{ quantity: string; amount_units: string; meter_version: number }>(env.DB, "SELECT quantity,amount_units,meter_version FROM billing_ledger WHERE operating_cost=0 AND meter='git.storage.logical'");
    const elapsed = BigInt(Date.parse(accrued.accrued_at) - Date.parse(before.accrued_at));
    expect(logical.reduce((sum, row) => sum + BigInt(row.quantity), 0n)).toBe(100000000n * elapsed);
    expect(logical.every(row => row.meter_version === 1)).toBe(true);
    const remove = await canonicalPublication(env, 'git_billing_delete_ref', { baseline: '100000000', reachable: '0', added: '0', growth: '256' });
    const deletion = await gitCosts.reserveStorage(env, remove.input); await remove.outcome('committed', deletion); await gitCosts.commitStorage(env, remove.commitInput(deletion));
    expect((await snapshot(env)).control).toMatchObject({ stored_bytes: '100000512', reserved_bytes: '0', active_slots: 0 });
    expect((await admissionRequest<CanonicalGitMeter>(env, 'account:u_one', 'git-meter', input)).logical_bytes).toBe('0');
    await expect(admissionRequest(env, 'account:u_one', 'git-purge', input)).rejects.toThrow();
    await env.DB.batch([
      stmt(env.DB, "INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,status,created_at,updated_at) VALUES('op_git_purge','repository.purge','r_one','r_one','u_one','u_one','running',?,?)", now(), now()),
      stmt(env.DB, "INSERT INTO operation_steps(operation_id,name,state,idempotency_key,receipt_json,completed_at) VALUES('op_git_purge','fence-writes','completed','git_purge_fence',?,?)", JSON.stringify({ repository: { storage_name: 'storage_one' } }), now()),
      stmt(env.DB, "INSERT INTO operation_steps(operation_id,name,state,idempotency_key,receipt_json,completed_at) VALUES('op_git_purge','purge-storage','completed','git_purge_verified','{\"deleted\":true,\"storage_verified\":true}',?)", now()),
    ]);
    await admissionRequest(env, 'account:u_one', 'git-purge', input); await admissionRequest(env, 'account:u_one', 'git-purge', input);
    expect((await snapshot(env)).control.stored_bytes).toBe('0');
    const peak = await many<{ quantity: string; amount_units: string }>(env.DB, "SELECT quantity,amount_units FROM billing_ledger WHERE operating_cost=1 AND meter='git.storage.daily-peak-bound'");
    const byteDays = peak.reduce((sum, line) => sum + BigInt(line.quantity), 0n);
    expect(byteDays).toBe(200000768n);
    expect(peak.reduce((sum, line) => sum + BigInt(line.amount_units), 0n)).toBe(byteDays * 500000000n / 30000000000n);
  });

  it('fences a rejected lost-reply intent before delayed prepare and preserves original-owner checks', async () => {
    const { env, network } = await fixture();
    const publish = await canonicalPublication(env, 'git_billing_late');
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), paused = new Promise<void>(resolve => { release = resolve; });
    network.intercept = async (target, request, deliver) => {
      if (target === 'capacity:slice_local' && new URL(request.url).pathname.endsWith('/git-reserve')) { enter(); await paused; }
      return deliver();
    };
    const late = gitCosts.reserveStorage(env, publish.input).catch((error: unknown) => error);
    await entered;
    await publish.outcome('rejected'); await gitCosts.abortStorage(env, publish.rejection); await gitCosts.abortStorage(env, publish.rejection);
    release(); expect(await late).toBeInstanceOf(Error); network.intercept = undefined;
    expect((await snapshot(env)).control.reserved_bytes).toBe('0');
    expect((await snapshot(env)).budgets[0]!.reserved_units).toBe('0');
    await expect(gitCosts.reserveStorage(env, publish.input)).rejects.toThrow();
    const changed = await canonicalPublication(env, 'git_billing_owner_changed');
    await env.DB.prepare("UPDATE repositories SET owner_id='u_two',revision=revision+1 WHERE id='r_one'").run();
    await expect(gitCosts.reserveStorage(env, changed.input)).rejects.toThrow();
    expect((await snapshot(env)).control.reserved_bytes).toBe('0');
  });

  it('renews nullable canonical retention and hands logical charges/quota to the new owner at one boundary', async () => {
    const { env } = await fixture();
    const publish = await canonicalPublication(env, 'git_billing_transfer');
    const grant = await gitCosts.reserveStorage(env, publish.input); await publish.outcome('committed', grant); await gitCosts.commitStorage(env, publish.commitInput(grant));
    const input = { repo_id: 'r_one', storage_name: 'storage_one' };
    const before = await admissionRequest<CanonicalGitMeter>(env, 'account:u_one', 'git-meter', input);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.parse(before.renew_after) + 1000);
    const renewed = await admissionRequest<CanonicalGitMeter>(env, 'account:u_one', 'git-renew', input);
    expect(renewed.commitment_until > before.commitment_until).toBe(true);
    expect(renewed.funding_failure_at).toBeNull();
    await env.DB.batch([
      stmt(env.DB, "UPDATE repositories SET state='transfer_pending' WHERE id='r_one'"),
      stmt(env.DB, `INSERT INTO repository_transfers(id,repo_id,source_owner_id,destination_owner_id,destination_name,previous_state,state,operation_id,expires_at,accepted_by,accepted_at,created_by,created_at,updated_at)
        VALUES('git_transfer','r_one','u_one','u_two','one','active','accepted','op_git_transfer','2099-01-01T00:00:00.000Z','u_two',?,'u_one',?,?)`, now(), now(), now()),
    ]);
    expect((await prepareRepositoryStorageTransfer(env, { operation_id: 'op_git_transfer', repo_id: 'r_one', from_account_id: 'u_one', to_account_id: 'u_two', actor_id: 'u_two' })).state).toBe('prepared');
    const boundary = now();
    await env.DB.prepare("UPDATE repositories SET owner_id='u_two',updated_at=? WHERE id='r_one'").bind(boundary).run();
    expect((await commitRepositoryStorageTransfer(env, { operation_id: 'op_git_transfer', effective_at: boundary })).state).toBe('complete');
    expect((await snapshot(env)).control.stored_bytes).toBe('0');
    expect((await snapshot(env, 'u_two')).control.stored_bytes).toBe('1000');
    const platform = await admissionRequest<{ control: AdmissionControl }>(env, 'capacity:slice_local', 'snapshot');
    expect(platform.control.stored_bytes).toBe('1000');
    vi.setSystemTime(Date.now() + 1000);
    await admissionRequest(env, 'account:u_two', 'git-accrue', { ...input, through: now() });
    const lines = await many<{ account_id: string; occurred_at: string }>(env.DB, "SELECT account_id,occurred_at FROM billing_ledger WHERE operating_cost=0 AND meter='git.storage.logical' ORDER BY recorded_at");
    expect(lines.filter(line => line.account_id === 'u_one').every(line => line.occurred_at <= boundary)).toBe(true);
    expect(lines.filter(line => line.account_id === 'u_two').every(line => line.occurred_at >= boundary)).toBe(true);
    expect(lines.some(line => line.account_id === 'u_two')).toBe(true);
  });
});
