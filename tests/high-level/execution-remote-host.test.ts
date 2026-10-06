import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { ApiError, now, sha256, verifyInternalRequest } from '../../packages/core/src/index.ts';
import type { Bindings } from '../../packages/core/src/types.ts';
import { fingerprintToolchain } from '../../packages/workflows/src/index.ts';
import { grantDigest, remoteRuntimeId, signRemoteRequest, signCallbackRequest, verifyCallbackRequest, verifyRemoteStatus } from '../../packages/execution/src/remote/protocol.ts';
import type { RemoteAttemptGrant, RemoteCache, RemoteCompletion, RemoteStoredObject, SignedRemoteStatus } from '../../packages/execution/src/remote/protocol.ts';
import hosted, { HostedAttemptWorkflow, HostedSandbox, RemoteAttemptController } from '../../workers/hosted/src/index.ts';
import { checkpointGuard } from '../../workers/hosted/src/workflow.ts';
import { validateGrant } from '../../workers/hosted/src/validation.ts';
import { attemptController, reapHosted, runtimeIdentity } from '../../workers/hosted/src/controller.ts';
import { RemoteCallbacks } from '../../workers/hosted/src/callback.ts';
import { RemoteDependencyCache } from '../../workers/hosted/src/cache.ts';
import { EphemeralStore } from '../../workers/hosted/src/ephemeral.ts';
import { RuntimeJournal, guardedContext } from '../../workers/hosted/src/runtime-journal.ts';
import { RuntimeEgress } from '../../workers/hosted/src/egress.ts';
import { RemoteLogs } from '../../workers/hosted/src/logs.ts';
import { chunks } from '../../workers/hosted/src/files.ts';
import { ATTEMPT_KEY, LIMITS } from '../../workers/hosted/src/types.ts';
import type { AttemptJournal, CompletionDraft, HostedEnv, HostedWorkflowParams, RuntimeGrant } from '../../workers/hosted/src/types.ts';
import type { Sandbox } from '@cloudflare/sandbox';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { Sandbox as LocalSandbox } from '../../workers/execution/src/sandbox.ts';
import { LocalSnapshotStore } from '../../workers/execution/src/snapshot-bucket.ts';
import { claimLocalHostedAttempt, persistLocalHostedDraft, finalizeLocalHostedDraft, readLocalHostedDraft, normalizeLocalHostedDraft } from '../../packages/execution/src/hosted/checkpoints.ts';
import { localAttemptEnvironment } from '../../packages/execution/src/hosted/local-runtime.ts';
import { runHostedAttempt } from '../../packages/execution/src/hosted/sdk.ts';
import { hostedCheckpointGuard } from '../../packages/execution/src/hosted/checkpoint-guard.ts';
import * as localAuthorization from '../../packages/execution/src/authorization.ts';
import type { ExecutionPlan, CompletionReceipt } from '../../packages/execution/src/types.ts';
import { SqliteD1 } from '../support/database.ts';
import { Sandbox as CloudflareSandbox } from '@cloudflare/sandbox';

const close: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); for (const dispose of close.splice(0).reverse()) await dispose(); });

/** Explicit provider boundary for HTTP tests. It NEVER runs or passes a VM job. */
class UnavailableContainer {
  running = false;
  starts = 0;
  destroys = 0;
  async destroy() { this.destroys++; this.running = false; }
  start() { this.starts++; throw new Error('Physical provider execution is deliberately unavailable in this HTTP test.'); }
  monitor() { return new Promise<void>(() => {}); }
  interceptAllOutboundHttp() {}
  interceptOutboundHttp() {}
  interceptOutboundHttps() {}
  getTcpPort() { return { fetch: async () => { throw new Error('No physical container is selected.'); } }; }
  signal() { this.running = false; }
}

class FixtureBucket {
  readonly objects = new Map<string, Uint8Array>();
  async head(key: string): Promise<R2Object | null> {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    const digest = createHash('sha256').update(bytes).digest('hex');
    return { key, version: digest, size: bytes.length, etag: digest, httpEtag: `"${digest}"`, uploaded: new Date(),
      storageClass: 'Standard', customMetadata: {}, httpMetadata: {}, checksums: { toJSON: () => ({ sha256: digest }) }, writeHttpMetadata() {} } as R2Object;
  }
  async get(key: string): Promise<R2ObjectBody | null> {
    const metadata = await this.head(key), bytes = this.objects.get(key);
    if (!metadata || !bytes) return null;
    const response = new Response(new Uint8Array(bytes));
    return { ...metadata, body: response.body!, bodyUsed: false, arrayBuffer: () => response.arrayBuffer(), text: () => response.text(),
      json: () => response.json(), blob: () => response.blob() } as R2ObjectBody;
  }
  async put(key: string, value: ReadableStream<Uint8Array> | string | Uint8Array): Promise<R2Object> {
    const data = value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, data); return (await this.head(key))!;
  }
  async delete(keys: string | string[]): Promise<void> { for (const key of typeof keys === 'string' ? [keys] : keys) this.objects.delete(key); }
  async list(options: R2ListOptions = {}): Promise<R2Objects> {
    const keys = [...this.objects.keys()].filter(key => key.startsWith(options.prefix ?? '')).sort();
    return { objects: await Promise.all(keys.slice(0, options.limit ?? 1000).map(key => this.head(key))) as R2Object[],
      truncated: keys.length > (options.limit ?? 1000), delimitedPrefixes: [] } as R2Objects;
  }
  binding(): R2Bucket { return this as unknown as R2Bucket; }
}

class LocalDurableStorage {
  readonly data = new Map<string, unknown>();
  alarm: number | null = null;
  readonly database = new DatabaseSync(':memory:');
  syncs = 0;
  readonly kv = {
    get: <T>(key: string): T | undefined => structuredClone(this.data.get(key)) as T | undefined,
    put: (key: string, value: unknown) => { this.data.set(key, structuredClone(value)); },
    delete: (key: string) => this.data.delete(key),
    list: <T>(options: SyncKvListOptions = {}): Array<[string, T]> => [...this.data.entries()]
      .filter(([key]) => key.startsWith(options.prefix ?? '') && (!options.startAfter || key > options.startAfter) && (!options.start || key >= options.start))
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, options.limit ?? Infinity).map(([key, value]) => [key, structuredClone(value) as T]),
  };
  readonly sql = { exec: (query: string, ...bindings: unknown[]) => {
    const statement = this.database.prepare(query);
    const rows = statement.all(...bindings as never[]) as Record<string, unknown>[];
    return { toArray: () => rows, one: () => { if (rows.length !== 1) throw new Error('Expected one SQLite row.'); return rows[0]; },
      raw: () => ({ toArray: () => rows.map(row => Object.values(row)) }), [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } };
  async get<T>(key: string) { return this.kv.get<T>(key); }
  async put(key: string, value: unknown) { this.kv.put(key, value); }
  async delete(key: string | string[]) { return typeof key === 'string' ? this.kv.delete(key) : key.filter(item => this.kv.delete(item)).length; }
  async list<T>(options?: SyncKvListOptions) { return new Map(this.kv.list<T>(options)); }
  transactionSync<T>(work: () => T): T {
    const before = new Map([...this.data.entries()].map(([key, value]) => [key, structuredClone(value)]));
    try { return work(); } catch (error) { this.data.clear(); for (const [key, value] of before) this.data.set(key, value); throw error; }
  }
  async setAlarm(at: number | Date) { this.alarm = Number(at); }
  async getAlarm() { return this.alarm; }
  async deleteAlarm() { this.alarm = null; }
  async sync() { this.syncs++; }
  binding() { return this as unknown as DurableObjectStorage; }
}

function doId(name: string): DurableObjectId {
  const id = /^[a-f0-9]{64}$/.test(name) ? name : createHash('sha256').update(name).digest('hex');
  return { toString: () => id, equals: (other: DurableObjectId) => other.toString() === id } as DurableObjectId;
}

function localState(name: string, storage = new LocalDurableStorage()) {
  const container = new UnavailableContainer(), ready: Promise<unknown>[] = [];
  const ctx = { id: doId(name), storage: storage.binding(), container,
    blockConcurrencyWhile<T>(work: () => Promise<T>) { const pending = Promise.resolve().then(work); ready.push(pending); return pending; },
    waitUntil(work: Promise<unknown>) { ready.push(work); },
    exports: { ContainerProxy: () => ({ fetch: async () => new Response('No provider interception in HTTP tests.', { status: 503 }) }) },
  } as unknown as DurableObjectState;
  close.push(async () => { for (const promise of ready) await promise; storage.database.close(); });
  return { ctx, storage, container, ready: async () => { for (const promise of ready) await promise; } };
}

async function http(handler: (request: Request) => Promise<Response>, drop?: (request: Request) => boolean) {
  let origin = '';
  const errors: unknown[] = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const body = incoming.method === 'GET' || incoming.method === 'HEAD' ? undefined : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      const request = new Request(`${origin}${incoming.url}`, { method: incoming.method, headers, body, duplex: 'half' } as RequestInit);
      const response = await handler(request);
      if (drop?.(request)) { await response.body?.cancel(); outgoing.destroy(); return; }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) { outgoing.end(); return; }
      for await (const chunk of Readable.fromWeb(response.body as never)) outgoing.write(chunk);
      outgoing.end();
    } catch (error) { errors.push(error); if (!outgoing.headersSent) outgoing.writeHead(500); outgoing.end('Isolated HTTP fixture failure.'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  close.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  return { origin, errors, server };
}

async function frozenGrant(origin: string): Promise<RemoteAttemptGrant> {
  const toolchain = { os: 'linux' as const, arch: 'x64' as const, tools: { node: '24.18.0' }, image: `registry.gitknot.com/remote@sha256:${'f'.repeat(64)}` };
  const digest = await fingerprintToolchain(toolchain), attempt = 'att_remote_http';
  return { version: 1, executor_id: 'http-fixture', attempt_id: attempt, generation: 1, run_id: 'run_http', job_id: 'verify', repo_id: 'r_private', account_id: 'org_owner',
    plan_digest: 'a'.repeat(64), workflow_digest: 'b'.repeat(64), policy_revision: 7, commit_sha: 'c'.repeat(40), source_ref: 'refs/heads/main',
    producer_id: 'hosted:http-fixture', runtime_name: `${attempt}-g1`, runtime_id: remoteRuntimeId('http-fixture', attempt, 1),
    deadline_at: new Date(Date.now() + 600_000).toISOString(), lease_expires_at: new Date(Date.now() + 90_000).toISOString(), toolchain,
    callback: { origin, token: `ghc_${'t'.repeat(43)}` },
    job: { key: 'verify', needs: [], executor: { type: 'hosted', profile: 'linux-small' }, producer_id: 'hosted:http-fixture', execution_backend: 'remote', remote_executor_id: 'http-fixture',
      toolchain: { name: 'node-fixture', digest, image: toolchain.image, os: 'linux', architecture: 'amd64' }, timeout_ms: 600_000, infrastructure_retries: 1,
      applicable: true, inapplicable_reason: null, steps: [{ id: 'verify', run: 'exit 2', shell: 'sh', working_directory: '.', env: {}, secrets: [], timeout_ms: 60_000 }],
      cache: null, inputs: [], outputs: {}, environment: null,
      egress: { hosts: ['registry.npmjs.org'], max_requests: 20, max_bytes: 1024 * 1024, max_request_bytes: 65536 } },
  };
}

/** CP protocol stand-in is a different HTTP server with disjoint state/storage. */
async function fixture(configure?: (grant: RemoteAttemptGrant) => void) {
  const cp = { active: true, begin: false, beginCalls: 0, logs: new Map<number, Uint8Array>(), objects: new Map<string, Uint8Array>(),
    completions: [] as RemoteCompletion[], drafts: [] as RemoteCompletion[], calls: [] as string[], cacheKeys: [] as string[], destroyed: 0, dropAction: '', rejectQuota: '',
    beforeBegin: null as (() => Promise<void>) | null, cache: null as RemoteCache | null };
  let grant: RemoteAttemptGrant, remoteOrigin = '', key = 'control-key-'.repeat(5);
  let uploadSequence = 0;
  const cpServer = await http(async request => {
    const url = new URL(request.url), action = url.pathname.split('/').at(-1)!;
    try {
      if (url.pathname !== `/internal/hosted/attempts/${grant.attempt_id}/${action}`) return new Response('Unknown attempt', { status: 404 });
      await verifyCallbackRequest(request, grant.callback.token, action === 'snapshot-upload');
      if (request.headers.get('authorization') !== `Bearer ${grant.callback.token}`) return new Response('Bad capability', { status: 401 });
      cp.calls.push(action);
      if (cp.rejectQuota === action) return Response.json({ error: { code: `${action}_quota_exceeded`, message: 'Sensitive provider diagnostics must not escape.' } }, { status: 413 });
      if (!cp.active && !['destroyed', 'complete'].includes(action)) return new Response('Fenced', { status: 409 });
      if (action === 'input' || action === 'cache-read') {
        if (url.searchParams.get('generation') !== String(grant.generation) || url.searchParams.get('plan_digest') !== grant.plan_digest) return new Response('Fenced', { status: 409 });
        const object = cp.objects.get(url.searchParams.get('object_id')!);
        return object ? new Response(new Uint8Array(object)) : new Response('Undeclared object', { status: 404 });
      }
      if (action === 'snapshot-upload') {
        for (const [query, header] of [['generation', 'x-gitknot-generation'], ['plan_digest', 'x-gitknot-plan-digest'], ['snapshot_id', 'x-gitknot-snapshot-id'], ['snapshot_part', 'x-gitknot-snapshot-part']]) {
          if (url.searchParams.get(query!) !== request.headers.get(header!)) return new Response('Unbound snapshot headers', { status: 401 });
        }
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (await sha256(bytes) !== request.headers.get('x-gitknot-content-sha256') || bytes.length !== Number(request.headers.get('content-length'))) return new Response('Bad checksum', { status: 422 });
        const id = `obj_snapshot_${uploadSequence++}`; cp.objects.set(id, bytes);
        return Response.json({ id, sha256: await sha256(bytes), source_digest: await sha256(bytes), size_bytes: bytes.length });
      }
      const body = await request.json() as Record<string, unknown>;
      if (body.generation !== grant.generation || body.plan_digest !== grant.plan_digest) return new Response('Fenced', { status: 409 });
      if (action === 'begin') {
        cp.beginCalls++;
        await cp.beforeBegin?.();
        return Response.json({ execute: cp.begin, status: cp.begin ? 'running' : 'closed',
          ...(cp.begin ? { source: { url: 'https://git.gitknot.com/owner/repo.git', commit: grant.commit_sha, token: `gkt_${'s'.repeat(43)}` }, inputs: [], lease_expires_at: grant.lease_expires_at } : {}) });
      }
      if (action === 'heartbeat') return Response.json({ status: cp.active ? 'active' : 'expired', lease_expires_at: grant.lease_expires_at });
      if (action === 'log') {
        const bytes = Buffer.from(String(body.data_base64), 'base64'), sequence = Number(body.sequence);
        if (await sha256(bytes) !== body.sha256 || bytes.length !== body.size_bytes || bytes.length > LIMITS.chunk_bytes) return new Response('Invalid chunk', { status: 422 });
        if (!cp.logs.has(sequence) && sequence !== cp.logs.size) return new Response('Noncontiguous log', { status: 409 });
        const prior = cp.logs.get(sequence);
        if (prior && await sha256(prior) !== body.sha256) return new Response('Conflicting chunk', { status: 409 });
        cp.logs.set(sequence, bytes);
        return Response.json({ id: `obj_log_${sequence}`, sha256: body.sha256, source_digest: body.sha256, size_bytes: bytes.length });
      }
      if (action === 'log-manifest') {
        const data = Buffer.concat([...cp.logs.entries()].sort(([a], [b]) => a - b).map(([, value]) => value));
        return Response.json({ id: 'obj_log_manifest', sha256: await sha256(data), source_digest: await sha256(data), size_bytes: data.length });
      }
      if (action === 'cache-get') { cp.cacheKeys.push(String(body.cache_key)); return Response.json(cp.cache); }
      if (action === 'checkpoint') { cp.drafts.push(body.receipt as RemoteCompletion); return Response.json({ recorded: true }); }
      if (action === 'complete' || action === 'destroyed') {
        const challenge = crypto.randomUUID();
        const statusRequest = await signRemoteRequest(new Request(`${remoteOrigin}/internal/hosted/attempts/${grant.attempt_id}/status`, {
          method: 'POST', body: JSON.stringify({ generation: grant.generation, grant_digest: await grantDigest(grant), challenge }) }), key);
        const statusResponse = await fetch(statusRequest);
        const signed = await statusResponse.json() as SignedRemoteStatus;
        const status = await verifyRemoteStatus(signed, key, { executor_id: grant.executor_id, producer_id: grant.producer_id, deadline_at: grant.deadline_at, attempt_id: grant.attempt_id, generation: grant.generation,
          grant_digest: await grantDigest(grant), runtime_id: grant.runtime_id, challenge });
        if (status.state !== 'destroyed' || !status.sealed || status.running !== false || status.in_flight || status.ephemeral_objects || !status.receipt_id) return new Response('Unproven destruction', { status: 503 });
        if (action === 'complete') {
          const receipt = body.receipt as RemoteCompletion;
          if (!receipt.process_group_stopped || !cp.drafts.some(draft => JSON.stringify(draft) === JSON.stringify(receipt))) return new Response('Uncheckpointed completion', { status: 409 });
          if (!cp.completions.some(old => JSON.stringify(old) === JSON.stringify(receipt))) cp.completions.push(receipt);
        } else cp.destroyed++;
        return Response.json({ accepted: true });
      }
      return Response.json({ acknowledged: true });
    } catch (error) { return new Response(error instanceof ApiError ? error.code : 'Callback rejected', { status: error instanceof ApiError ? error.status : 500 }); }
  }, request => { if (new URL(request.url).pathname.endsWith(`/${cp.dropAction}`) && cp.dropAction) { cp.dropAction = ''; return true; } return false; });
  grant = await frozenGrant(cpServer.origin);
  configure?.(grant);
  const bucket = new FixtureBucket();
  const stores = new Map<string, ReturnType<typeof localState>>(), controllers = new Map<string, RemoteAttemptController>(), runtimes = new Map<string, HostedSandbox>();
  const workflows = new Map<string, { params: HostedWorkflowParams; status: string }>();
  let creates = 0, lostCreate = false, dropAccept = false;
  const env = { ENVIRONMENT: 'test', HOSTED_TEST_ALLOW_LOOPBACK: true, HOSTED_CONTROL_KEY: key, HOSTED_EXECUTOR_ID: grant.executor_id,
    HOSTED_CALLBACK_ORIGIN: cpServer.origin, BACKUP_BUCKET: bucket.binding(), HOSTED_PROFILES_JSON: JSON.stringify([{ name: 'linux-small', image: grant.job.toolchain.image,
      toolchain_digest: grant.job.toolchain.digest, sdk_version: '0.2.0', sandbox_version: '0.12.1', vcpu: 1, memory_mib: 1024, disk_mb: 2000,
      max_instances: 2, max_job_ms: 600_000, measurement: { evidence_sha256: 'e'.repeat(64), measured_at: '2026-10-01T00:00:00.000Z',
        cold_start_p95_ms: 1000, teardown_p99_ms: 1000, isolation_verified: true, egress_verified: true, destruction_verified: true } }]),
  } as HostedEnv;
  const state = (id: string) => { if (!stores.has(id)) stores.set(id, localState(id)); return stores.get(id)!; };
  env.HOSTED_ATTEMPTS = { idFromName: doId, get: (id: DurableObjectId) => {
    const key = id.toString(); if (!controllers.has(key)) controllers.set(key, new RemoteAttemptController(state(key).ctx, env));
    return controllers.get(key)!;
  } } as unknown as HostedEnv['HOSTED_ATTEMPTS'];
  env.SANDBOX = { idFromName: doId, idFromString: doId, get: (id: DurableObjectId) => {
    const key = id.toString(); if (!runtimes.has(key)) runtimes.set(key, new HostedSandbox(state(key).ctx, env));
    return runtimes.get(key)!;
  } } as unknown as HostedEnv['SANDBOX'];
  env.HOSTED_WORKFLOW = {
    async create(input: { id: string; params: HostedWorkflowParams }) {
      expect(state(doId(grant.attempt_id).toString()).storage.data.has(ATTEMPT_KEY)).toBe(true);
      creates++;
      if (workflows.has(input.id)) throw new Error('Workflow ID already exists.');
      workflows.set(input.id, { params: structuredClone(input.params), status: 'queued' });
      if (lostCreate) { lostCreate = false; throw new Error('Workflow create response lost.'); }
      return { id: input.id };
    },
    async get(id: string) {
      if (!workflows.has(id)) throw new Error('Workflow ID not found.');
      return { id, status: async () => ({ status: workflows.get(id)!.status }), terminate: async () => { workflows.get(id)!.status = 'terminated'; } };
    },
  } as unknown as HostedEnv['HOSTED_WORKFLOW'];
  const hostServer = await http(request => hosted.fetch(request, env), request => {
    if (dropAccept && new URL(request.url).pathname.endsWith('/accept')) { dropAccept = false; return true; }
    return false;
  });
  remoteOrigin = hostServer.origin;
  const command = async (action: 'accept' | 'cancel' | 'status', body: unknown = grant) => {
    const request = await signRemoteRequest(new Request(`${remoteOrigin}/internal/hosted/attempts/${grant.attempt_id}/${action}`, { method: 'POST', body: JSON.stringify(body) }), key);
    return fetch(request);
  };
  const params = { attempt_id: grant.attempt_id, generation: grant.generation, grant_digest: await grantDigest(grant) };
  return { env, grant, cp, bucket, stores, controllers, runtimes, workflows, command, params, key, origin: remoteOrigin, state,
    loseCreate: () => { lostCreate = true; }, loseAccept: () => { dropAccept = true; }, creates: () => creates,
    runtimeState: () => state(doId(grant.runtime_name).toString()), controller: () => attemptController(env, grant.attempt_id),
    runtime: () => env.SANDBOX.get(env.SANDBOX.idFromName(grant.runtime_name)),
    async signedStatus(action: 'status' | 'cancel' = 'status') {
      const challenge = crypto.randomUUID();
      const response = await command(action, { generation: grant.generation, grant_digest: params.grant_digest, challenge });
      expect(response.status).toBe(200);
      const signed = await response.json() as SignedRemoteStatus;
      const verified = await verifyRemoteStatus(signed, key, { ...params, runtime_id: grant.runtime_id, executor_id: grant.executor_id, producer_id: grant.producer_id, deadline_at: grant.deadline_at, challenge });
      return { signed, verified };
    },
  };
}

function runtimeGrant(test: Awaited<ReturnType<typeof fixture>>): RuntimeGrant {
  return { ...runtimeIdentity(test.env, test.grant, test.params.grant_digest), lease_expires_at: test.grant.lease_expires_at,
    source_url: 'https://git.gitknot.com/owner/repo.git', egress: test.grant.job.egress, cache_bytes: LIMITS.cache_bytes };
}

/** Two real SQLite stores: identity routing and repository execution metadata. */
async function localFixture() {
  const identity = new SqliteD1(), metadata = new SqliteD1();
  close.push(() => identity.close(), () => metadata.close());
  identity.sqlite.exec(`CREATE TABLE resource_locators(resource_id TEXT PRIMARY KEY,resource_type TEXT,repo_id TEXT,authority TEXT);
    CREATE TABLE resource_routes(resource_id TEXT PRIMARY KEY,resource_type TEXT,cell_id TEXT,shard_id TEXT,epoch INTEGER,state TEXT,operation_id TEXT,updated_at TEXT);
    CREATE TABLE billing_controls(coordinator_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,body_json TEXT NOT NULL CHECK(json_valid(body_json)),updated_at TEXT NOT NULL);`);
  metadata.sqlite.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY);
    CREATE TABLE repositories(id TEXT PRIMARY KEY,owner_id TEXT,state TEXT,policy_revision INTEGER,routing_epoch INTEGER);
    CREATE TABLE workflow_runs(id TEXT PRIMARY KEY,repo_id TEXT,account_id TEXT,commit_sha TEXT,source_ref TEXT,workflow_digest TEXT,plan_digest TEXT,plan_json TEXT,policy_revision INTEGER,status TEXT,trust TEXT);
    CREATE TABLE workflow_jobs(id TEXT PRIMARY KEY,run_id TEXT,repo_id TEXT,account_id TEXT,job_key TEXT,definition_json TEXT,status TEXT,generation INTEGER,current_attempt_id TEXT);
    CREATE TABLE execution_attempts(id TEXT PRIMARY KEY,repo_id TEXT,account_id TEXT,run_id TEXT,job_id TEXT,generation INTEGER,plan_digest TEXT,toolchain_digest TEXT,producer_id TEXT,
      executor TEXT,execution_backend TEXT,status TEXT,runtime_name TEXT,runtime_id TEXT,deadline_at TEXT,lease_expires_at TEXT,allocated_at TEXT,started_at TEXT,
      execution_started_at TEXT,reservation_id TEXT,reservation_fence TEXT,receipt_hash TEXT,egress_bytes INTEGER DEFAULT 0,egress_requests INTEGER DEFAULT 0);
    CREATE TABLE execution_runtime_receipts(runtime_id TEXT PRIMARY KEY,attempt_id TEXT,repo_id TEXT,account_id TEXT,generation INTEGER,receipt_id TEXT UNIQUE,state TEXT,
      armed_at TEXT,destroyed_at TEXT,updated_at TEXT,proof_kind TEXT DEFAULT 'hosted_destroyed');
    CREATE TABLE mutation_guards(id TEXT PRIMARY KEY,ok INTEGER CHECK(ok=1));`);
  const schema = await readFile(new URL('../../migrations/040_execution.sql', import.meta.url), 'utf8');
  metadata.sqlite.exec(schema.slice(schema.indexOf('CREATE TABLE execution_caches'), schema.indexOf('CREATE TABLE workflow_verifications')));
  metadata.sqlite.exec(await readFile(new URL('../../migrations/055_local_hosted_checkpoints.sql', import.meta.url), 'utf8'));
  const grant = await frozenGrant('https://control.gitknot.com');
  grant.job.execution_backend = 'local'; delete grant.job.remote_executor_id;
  const attemptId = 'att_same_account', runtimeName = `${attemptId}-g1`, runtimeId = doId(runtimeName).toString();
  const plan: ExecutionPlan = { version: 1, repo_id: grant.repo_id, account_id: grant.account_id, commit_sha: grant.commit_sha, source_ref: grant.source_ref,
    workflow_digest: grant.workflow_digest, workflow_version_id: 'wfv_local', policy_revision: 7, trust: 'trusted', trigger: { type: 'workflow.dispatch', id: 'manual' },
    concurrency: { key: null, supersede: false }, jobs: [grant.job], portable_manifest: { jobs: [{ id: grant.job.key, toolchain: grant.toolchain }] },
    actor: { id: 'u_local', kind: 'user', user_id: 'u_local', credential_id: null }, routing_epoch: 1 };
  const planJson = JSON.stringify(plan), digest = await sha256(planJson), at = now();
  identity.sqlite.prepare('INSERT INTO billing_controls VALUES (?,1,?,?)').run(`account:${grant.account_id}`, JSON.stringify({ coordinator_cell_id: 'local-cell' }), at);
  identity.sqlite.prepare('INSERT INTO resource_locators VALUES (?,?,?,?)').run(attemptId, 'attempt', grant.repo_id, 'repository');
  identity.sqlite.prepare('INSERT INTO resource_routes VALUES (?,?,?,?,?,?,?,?)').run(grant.repo_id, 'repository', 'local-cell', 'repo-meta', 1, 'active', null, at);
  metadata.sqlite.prepare('INSERT INTO accounts VALUES (?)').run(grant.account_id);
  metadata.sqlite.prepare('INSERT INTO repositories VALUES (?,?,?,?,?)').run(grant.repo_id, grant.account_id, 'active', 7, 1);
  metadata.sqlite.prepare('INSERT INTO workflow_runs VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(grant.run_id, grant.repo_id, grant.account_id, grant.commit_sha,
    grant.source_ref, grant.workflow_digest, digest, planJson, 7, 'running', 'trusted');
  metadata.sqlite.prepare('INSERT INTO workflow_jobs VALUES (?,?,?,?,?,?,?,?,?)').run('job_local', grant.run_id, grant.repo_id, grant.account_id, grant.job.key, JSON.stringify(grant.job), 'running', 1, attemptId);
  metadata.sqlite.prepare(`INSERT INTO execution_attempts
    (id,repo_id,account_id,run_id,job_id,generation,plan_digest,toolchain_digest,producer_id,executor,execution_backend,status,runtime_name,runtime_id,
      deadline_at,lease_expires_at,allocated_at,reservation_id,reservation_fence) VALUES (?,?,?,?,?,?,?,?,?,'hosted','local','leased',?,?,?,?,?,?,?)`)
    .run(attemptId, grant.repo_id, grant.account_id, grant.run_id, 'job_local', 1, digest, grant.job.toolchain.digest, grant.producer_id, runtimeName, runtimeId,
      grant.deadline_at, grant.lease_expires_at, at, 'bres_local', 'bf_local');
  const bucket = new FixtureBucket(), state = localState(runtimeId), proofBodies: unknown[] = [], completions: CompletionReceipt[] = [];
  const reservations = new Map<string, string>(), commits: Record<string, unknown>[] = [];
  let runtime!: LocalSandbox;
  const env = { DB: identity.binding(), IDENTITY_DB: identity.binding(), IDENTITY_CELL_ID: 'local-cell', IDENTITY_SHARD_ID: 'identity',
    CELL_ID: 'local-cell', SHARD_ID: 'identity', SHARD_BINDINGS_JSON: JSON.stringify({ 'repo-meta': 'REPO_DB' }), REPO_DB: metadata.binding(),
    ENVIRONMENT: 'test', INTERNAL_SERVICE_KEY: 'local-hosted-controlled-fixture-key-'.repeat(2), GIT_ORIGIN: 'https://git.gitknot.com', BACKUP_BUCKET: bucket.binding() } as unknown as Bindings;
  env.SANDBOX = { idFromName: doId, idFromString: doId, get: (id: DurableObjectId) => { expect(id.toString()).toBe(runtimeId); return runtime; } } as unknown as DurableObjectNamespace;
  env.ADMISSION = { idFromName: doId, get: () => ({ fetch: async (request: Request) => {
    const action = new URL(request.url).pathname.split('/').at(-1)!;
    await verifyInternalRequest(request, env.INTERNAL_SERVICE_KEY, `billing:account:${action}`);
    const body = await request.json() as Record<string, unknown>;
    if (action === 'storage-reserve') reservations.set(String(body.object_id), String(body.key));
    else if (action === 'storage-commit') {
      const object = await bucket.get(reservations.get(String(body.object_id))!);
      expect(object).not.toBeNull();
      expect(body.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(body.checksum).toBe(await sha256(new Uint8Array(await object!.arrayBuffer())));
      commits.push(body);
    } else if (action === 'storage-delete') await bucket.delete(reservations.get(String(body.object_id))!);
    else throw new Error('Unexpected fixture billing action.');
    return Response.json({ state: action === 'storage-delete' ? 'deleted' : 'stored' });
  } }) } as unknown as DurableObjectNamespace;
  env.ATTEMPTS = { idFromName: doId, get: () => ({ fetch: async (request: Request) => {
    await verifyInternalRequest(request, env.INTERNAL_SERVICE_KEY, 'execution');
    const action = new URL(request.url).pathname.split('/').at(-1), body = await request.json() as Record<string, unknown>;
    if (action === 'destroyed') {
      const proof = metadata.sqlite.prepare('SELECT * FROM execution_runtime_receipts WHERE runtime_id=?').get(runtimeId)!;
      expect(proof.state).toBe('destroyed'); expect(body.destroyed_at).toBe(proof.destroyed_at); proofBodies.push(body);
    } else if (action === 'hosted-complete') {
      const receipt = body as unknown as CompletionReceipt;
      expect(await readLocalHostedDraft(env, attemptId, 1)).toEqual(receipt);
      if (!completions.length) completions.push(receipt);
      metadata.sqlite.prepare("UPDATE execution_attempts SET status='failed',receipt_hash=? WHERE id=?").run(await sha256(JSON.stringify(receipt)), attemptId);
    } else if (action !== 'cancel') throw new Error(`Unexpected fixture attempt action: ${action}`);
    return Response.json({ accepted: true });
  } }) } as unknown as DurableObjectNamespace;
  vi.spyOn(localAuthorization, 'authorizeExecutionActor').mockImplementation(async selected => {
    expect(selected.IDENTITY_CELL_ID).toBe('local-cell'); expect(selected.IDENTITY_SHARD_ID).toBe('identity');
    expect(selected.SHARD_ID).toBe('repo-meta');
    return localAuthorization.executionContext(selected, null);
  });
  vi.spyOn(localAuthorization, 'fenceExecutionAuthority').mockResolvedValue(undefined);
  runtime = new LocalSandbox(state.ctx, env); await state.ready();
  const input = { attempt_id: attemptId, generation: 1 };
  const begin = () => metadata.sqlite.prepare("UPDATE execution_attempts SET status='running',started_at=?,execution_started_at=? WHERE id=?").run(now(), now(), attemptId);
  return { env, identity, metadata, bucket, state, input, runtimeId, runtimeName, grant, planDigest: digest, runtime: () => runtime, begin, reservations, commits, completions, proofBodies,
    restart: async () => { runtime = new LocalSandbox(state.ctx, env); await state.ready(); return runtime; } };
}

describe('remote execution account over isolated authenticated HTTP', () => {
  it('journals before lost acceptance/create replies, deduplicates across DO restart, and binds fresh status challenges', async () => {
    const test = await fixture(); test.loseCreate(); test.loseAccept();
    await expect(test.command('accept')).rejects.toThrow();
    test.controllers.delete(doId(test.grant.attempt_id).toString());
    const responses = await Promise.all(Array.from({ length: 8 }, () => test.command('accept')));
    expect(responses.map(response => response.status)).toEqual(Array(8).fill(202));
    const accepted = await verifyRemoteStatus(await responses[0]!.json() as SignedRemoteStatus, test.key, { ...test.params,
      executor_id: test.grant.executor_id, producer_id: test.grant.producer_id, deadline_at: test.grant.deadline_at, runtime_id: test.grant.runtime_id, challenge: test.params.grant_digest });
    expect(accepted.sandbox_id).toMatch(/^[a-f0-9]{64}$/);
    expect(test.workflows.size).toBe(1); expect(test.creates()).toBe(1);
    expect([...test.workflows.values()][0]!.params).toEqual(test.params);
    expect(JSON.stringify([...test.workflows.values()])).not.toContain(test.grant.callback.token);
    const { signed, verified } = await test.signedStatus();
    expect(verified.state).toBe('accepted'); expect(verified.running).toBeNull();
    expect(verified.sandbox_id).toBe(doId(test.grant.runtime_name).toString());
    await expect(verifyRemoteStatus(signed, test.key, { ...test.params, executor_id: test.grant.executor_id, producer_id: test.grant.producer_id, deadline_at: test.grant.deadline_at, runtime_id: test.grant.runtime_id, challenge: crypto.randomUUID() })).rejects.toMatchObject({ code: 'remote_status_unverified' });
    const changed = structuredClone(test.grant); changed.job.steps[0]!.run = 'different command';
    expect((await test.command('accept', changed)).status).toBe(409);
    expect((await test.command('status', { generation: 2, grant_digest: test.params.grant_digest, challenge: crypto.randomUUID() })).status).toBe(409);
    expect(test.runtimeState().container.starts).toBe(0);
  });

  it('requires HTTPS in production, verifies content/scope, and durably rejects signed nonce replay', async () => {
    const test = await fixture();
    const url = `${test.origin}/internal/hosted/attempts/${test.grant.attempt_id}/accept`;
    const signed = await signRemoteRequest(new Request(url, { method: 'POST', body: JSON.stringify(test.grant) }), test.key);
    expect((await fetch(signed.clone() as Request)).status).toBe(202);
    test.controllers.delete(doId(test.grant.attempt_id).toString());
    expect((await fetch(signed.clone() as Request)).status).toBe(409);
    const altered = new Request(signed.clone() as Request, { body: JSON.stringify({ ...test.grant, generation: 9 }) });
    expect((await fetch(altered)).status).toBe(401);
    expect((await fetch(url, { method: 'POST', body: JSON.stringify(test.grant) })).status).toBe(401);
    const callbackSigned = await signCallbackRequest(new Request(url, { method: 'POST', body: JSON.stringify(test.grant) }), test.key);
    expect((await fetch(callbackSigned)).status).toBe(401);
    expect((await hosted.fetch(signed.clone() as Request, { ...test.env, ENVIRONMENT: 'production' })).status).toBe(503);
    const absent = { ...test.env, HOSTED_WORKFLOW: undefined } as unknown as HostedEnv;
    const other = structuredClone(test.grant); other.attempt_id = 'att_missing_binding'; other.runtime_name = 'att_missing_binding-g1';
    other.runtime_id = remoteRuntimeId(other.executor_id, other.attempt_id, other.generation);
    const controllerState = localState(doId(other.attempt_id).toString());
    const controller = new RemoteAttemptController(controllerState.ctx, absent);
    const absentRequest = await signRemoteRequest(new Request(`https://executor.gitknot.com/internal/hosted/attempts/${other.attempt_id}/accept`, { method: 'POST', body: JSON.stringify(other) }), test.key);
    expect((await controller.fetch(absentRequest)).status).toBe(503);
    expect(controllerState.storage.data.has(ATTEMPT_KEY)).toBe(false);
  });

  it('requires the configured callback origin and rejects a grant-selected destination before acceptance or callback transmission', async () => {
    const test = await fixture();
    let foreignCalls = 0;
    const foreign = await http(async () => { foreignCalls++; return Response.json({ execute: true }); });
    const wrong = structuredClone(test.grant); wrong.callback.origin = foreign.origin;
    const rejected = await test.command('accept', wrong);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: { code: 'callback_origin_mismatch' } });
    expect(() => new RemoteCallbacks(test.env, wrong)).toThrowError(expect.objectContaining({ code: 'callback_origin_mismatch' }));
    const configured = test.env.HOSTED_CALLBACK_ORIGIN;
    for (const origin of [undefined, '', 'https://control.gitknot.com/path', 'https://user:password@control.gitknot.com', 'https://control.gitknot.com?redirect=other']) {
      test.env.HOSTED_CALLBACK_ORIGIN = origin as string;
      expect((await test.command('accept')).status).toBe(503);
    }
    expect(test.workflows.size).toBe(0);
    expect(test.state(doId(test.grant.attempt_id).toString()).storage.data.has(ATTEMPT_KEY)).toBe(false);
    expect(test.cp.calls).toEqual([]); expect(foreignCalls).toBe(0);
    test.env.HOSTED_CALLBACK_ORIGIN = configured;
    expect((await test.command('accept')).status).toBe(202);
    const callbacks = new RemoteCallbacks(test.env, test.grant);
    await callbacks.json('heartbeat', { egress_bytes: 0, egress_requests: 0 });
    const sent = test.cp.calls.length;
    test.env.HOSTED_CALLBACK_ORIGIN = foreign.origin;
    await expect(callbacks.json('begin')).rejects.toMatchObject({ code: 'callback_origin_mismatch' });
    await expect(callbacks.download('cache-read', 'obj_declared')).rejects.toMatchObject({ code: 'callback_origin_mismatch' });
    expect(test.cp.calls).toHaveLength(sent); expect(foreignCalls).toBe(0);
    expect(test.runtimeState().container.starts).toBe(0);
  });

  it('matches the complete configured HTTPS origin in production even when the loopback test flag is set', async () => {
    const test = await fixture();
    const origin = 'https://control.gitknot.com';
    const production = { ...test.env, ENVIRONMENT: 'production', HOSTED_CALLBACK_ORIGIN: origin, HOSTED_TEST_ALLOW_LOOPBACK: true };
    const grant = { ...test.grant, callback: { ...test.grant.callback, origin } };
    expect((await validateGrant(grant, production)).callback.origin).toBe(origin);
    for (const other of ['https://another.gitknot.com', 'https://control.gitknot.com.attacker.com', 'https://control.gitknot.com:444']) {
      await expect(validateGrant({ ...grant, callback: { ...grant.callback, origin: other } }, production)).rejects.toMatchObject({ code: 'callback_origin_mismatch' });
    }
    await expect(validateGrant({ ...grant, callback: { ...grant.callback, origin: 'http://control.gitknot.com' } }, production)).rejects.toMatchObject({ code: 'remote_origin_invalid' });
    await expect(validateGrant(test.grant, { ...production, HOSTED_CALLBACK_ORIGIN: test.grant.callback.origin })).rejects.toMatchObject({ code: 'remote_origin_invalid' });
    expect(test.workflows.size).toBe(0); expect(test.cp.calls).toEqual([]);
  });

  it.each([false, true])('waits for successful CP begin before arming and does not retry a lost begin response (lost reply: %s)', async lostReply => {
    const test = await fixture(); await test.command('accept'); test.cp.begin = true;
    const runtime = test.runtime(); await test.runtimeState().ready();
    const arm = vi.spyOn(runtime, 'arm');
    const execute = vi.spyOn(runtime, 'exec').mockRejectedValue(new Error('No physical execution is selected in this HTTP test.'));
    let entered!: () => void, release!: () => void;
    const requested = new Promise<void>(resolve => { entered = resolve; });
    const permitted = new Promise<void>(resolve => { release = resolve; });
    test.cp.beforeBegin = async () => { entered(); await permitted; };
    if (lostReply) test.cp.dropAction = 'begin';
    const journal = JSON.parse(await test.controller().load(test.params)) as AttemptJournal;
    const step = { do: async (_name: string, _config: unknown, work: (context: { attempt: number }) => Promise<unknown>) => work({ attempt: 1 }) } as unknown as WorkflowStep;
    const workflow = new HostedAttemptWorkflow({ waitUntil() {} } as unknown as ExecutionContext, test.env);
    const event = { payload: test.params, instanceId: journal.workflow_id, timestamp: new Date() } as WorkflowEvent<HostedWorkflowParams>;
    const running = workflow.run(event, step);
    try {
      await requested;
      expect(arm).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
      expect(test.runtimeState().container.starts).toBe(0);
    } finally { release(); await running; }
    expect(arm).toHaveBeenCalledTimes(lostReply ? 0 : 1);
    expect(execute).toHaveBeenCalledTimes(lostReply ? 0 : 1);
    await workflow.run(event, step);
    expect(test.cp.beginCalls).toBe(1); expect(test.workflows.size).toBe(1);
    expect(test.runtimeState().container.starts).toBe(0);
    expect(test.cp.completions.every(receipt => receipt.conclusion === 'infrastructure_failed')).toBe(true);
  });

  it('runs the real CI provider step with zero retries, consumes begin once, and never fabricates execution after a closed begin', async () => {
    const test = await fixture(); expect((await test.command('accept')).status).toBe(202);
    await test.runtimeState().ready();
    const arm = vi.spyOn(test.runtime(), 'arm');
    const journal = JSON.parse(await test.controller().load(test.params)) as AttemptJournal, checkpoints: unknown[] = [], configs: unknown[] = [];
    const step = { do: async (_name: string, config: unknown, work: (context: { attempt: number }) => Promise<unknown>) => {
      configs.push(config);
      const value = await work({ attempt: 1 }); checkpoints.push(structuredClone(value)); return value;
    } } as unknown as WorkflowStep;
    const workflow = new HostedAttemptWorkflow({ waitUntil() {} } as unknown as ExecutionContext, test.env);
    const event = { payload: test.params, instanceId: journal.workflow_id, timestamp: new Date() } as WorkflowEvent<HostedWorkflowParams>;
    await workflow.run(event, step);
    await workflow.run(event, step);
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ retries: { limit: 0 } });
    expect(test.cp.beginCalls).toBe(1); expect(test.runtimeState().container.starts).toBe(0);
    expect(arm).not.toHaveBeenCalled();
    expect(test.cp.completions).toHaveLength(1);
    expect(test.cp.completions[0]).toMatchObject({ conclusion: 'infrastructure_failed', exit_code: null, process_group_stopped: true });
    expect(checkpoints).toEqual([]);
    expect(JSON.stringify(test.cp.drafts)).not.toContain(test.grant.callback.token);
  });

  it('retains the full failure stream with cross-chunk redaction and recovers a lost chunk response without gaps or duplicate text', async () => {
    const test = await fixture(); await test.command('accept');
    const secret = 'vault-private-secret-🌍', encoded = Buffer.from(secret).toString('base64');
    const stdout = Buffer.from(`${'x'.repeat(65528)}${secret}\n${'failure detail\n'.repeat(8000)}${encoded}\nfull failure trailer\n`);
    const stderr = Buffer.from(`stderr ${secret}\n${'diagnostic\n'.repeat(5000)}`);
    const sandbox = { exec: async (command: string) => {
      const match = /if=([^ ]+).*skip=(\d+)/.exec(command)!;
      const data = match[1]!.endsWith('.out') ? stdout : stderr, offset = Number(match[2]) * 65536;
      return { success: true, stdout: data.subarray(offset, offset + 65536).toString('base64') };
    } } as unknown as Sandbox;
    const logs = new RemoteLogs(test.env, test.params, sandbox, [secret]);
    test.cp.dropAction = 'log';
    await expect(logs.read('/tmp/gitknot-control/step-0.out', true)).rejects.toMatchObject({ code: 'callback_unconfirmed' });
    await logs.read('/tmp/gitknot-control/step-0.out', true);
    await logs.read('/tmp/gitknot-control/step-0.err', true);
    test.controllers.delete(doId(test.grant.attempt_id).toString());
    const manifest = await test.controller().publishObject(test.params, 'log-manifest', 'manifest:logs', {});
    const retained = Buffer.concat([...test.cp.logs.values()]).toString('utf8');
    expect(retained).toBe((stdout.toString('utf8') + stderr.toString('utf8')).replaceAll(secret, '[REDACTED]').replaceAll(encoded, '[REDACTED]'));
    expect(retained.length).toBeGreaterThan(200_000); expect(retained).toContain('full failure trailer');
    expect(manifest.sha256).toBe(await sha256(Buffer.from(retained)));
    expect([...test.cp.logs.keys()]).toEqual(Array.from({ length: test.cp.logs.size }, (_, index) => index));
    expect(JSON.stringify([...test.stores.get(doId(test.grant.attempt_id).toString())!.storage.data])).not.toContain(secret);
    expect(test.runtimeState().container.starts).toBe(0);
  });

  it('withholds destruction for an outstanding SDK operation and a failed ephemeral deletion, then reaps without restarting', async () => {
    const test = await fixture(); await test.command('accept');
    const runtime = test.runtime(); await test.runtimeState().ready(); await runtime.arm(runtimeGrant(test));
    const identity = runtimeIdentity(test.env, test.grant, test.params.grant_digest);
    const bytes = Buffer.from('ephemeral SDK archive transport fixture'), logical = `backups/${crypto.randomUUID()}/data.sqsh`;
    await runtime.importSnapshotObject(logical, new Response(bytes).body!, { sha256: await sha256(bytes), size_bytes: bytes.length });
    const journal = new RuntimeJournal(test.runtimeState().ctx);
    let finish!: () => void;
    const operation = journal.operation('test-pending-sdk-operation', () => new Promise<void>(resolve => { finish = resolve; }));
    await Promise.resolve(); await Promise.resolve();
    const cancelled = await test.signedStatus('cancel');
    expect(cancelled.verified).toMatchObject({ state: 'stopping', sealed: true, running: false, in_flight: 1, ephemeral_objects: 1, receipt_id: null });
    expect(test.cp.destroyed).toBe(0);
    await expect(runtime.start()).rejects.toMatchObject({ code: 'attempt_fenced' });
    finish(); await operation;
    const original = test.bucket.delete.bind(test.bucket);
    test.bucket.delete = async () => undefined;
    await expect(test.controller().reconcile()).rejects.toMatchObject({ code: 'snapshot_deletion_unverified' });
    expect((await test.signedStatus()).verified.receipt_id).toBeNull();
    test.bucket.delete = original;
    await reapHosted(test.env);
    expect((await test.signedStatus()).verified).toMatchObject({ state: 'destroyed', sealed: true, running: false, in_flight: 0, ephemeral_objects: 0 });
    expect(test.bucket.objects.size).toBe(0); expect(test.cp.destroyed).toBe(1);
    expect(test.cp.completions[0]?.conclusion).toBe('cancelled');
    expect(test.runtimeState().container.starts).toBe(0);
    test.runtimes.delete(identity.sandbox_id);
    await expect(test.runtime().start()).rejects.toMatchObject({ code: 'attempt_fenced' });
  });

  it('returns cancellation facts before callbacks so an occupied control-plane attempt controller cannot deadlock cleanup', async () => {
    const test = await fixture(); await test.command('accept');
    test.cp.active = false;
    const result = await test.signedStatus('cancel');
    expect(result.verified).toMatchObject({ state: 'destroyed', sealed: true, running: false, in_flight: 0, ephemeral_objects: 0 });
    expect(test.cp.calls).toEqual([]);
    expect(test.cp.destroyed).toBe(0);
    await test.controller().reconcile();
    expect(test.cp.destroyed).toBe(1);
    expect(test.cp.completions).toEqual([]);
    expect(test.runtimeState().container.starts).toBe(0);
  });

  it('gates the actual pinned Sandbox startup API before its first provider call and never retries an uncertain start', async () => {
    const test = await fixture(); await test.command('accept');
    const runtime = test.runtime(); await test.runtimeState().ready();
    await expect(runtime.start()).rejects.toMatchObject({ code: 'attempt_fenced' });
    await runtime.arm(runtimeGrant(test));
    await expect(runtime.start()).rejects.toThrow('Physical provider execution is deliberately unavailable');
    expect(test.runtimeState().container.starts).toBe(1);
    test.runtimes.delete(doId(test.grant.runtime_name).toString());
    await expect(test.runtime().start()).rejects.toMatchObject({ code: 'attempt_fenced' });
    expect(test.runtimeState().container.starts).toBe(1);
    await test.signedStatus('cancel');
    expect((await test.signedStatus()).verified.state).toBe('destroyed');
    expect(test.runtimeState().container.starts).toBe(1);
  });

  it('expires absolute runtime leases, rejects local extension/replay, and meters exact hosts before allowing bytes', async () => {
    const test = await fixture(); await test.command('accept');
    const state = test.runtimeState(), journal = new RuntimeJournal(state.ctx), grant = runtimeGrant(test);
    await journal.arm({ ...grant, egress: { hosts: ['registry.npmjs.org'], max_requests: 2, max_bytes: 12, max_request_bytes: 4 } });
    const egress = new RuntimeEgress(journal);
    await expect(egress.authorize('https://registry.npmjs.org.attacker.com/path', 'GET')).rejects.toMatchObject({ code: 'egress_denied' });
    await expect(egress.authorize('https://127.0.0.1/path', 'GET')).rejects.toMatchObject({ code: 'egress_denied' });
    const first = await egress.authorize('https://registry.npmjs.org/package', 'POST');
    await egress.consume(first.request_id, 4, true);
    await expect(egress.consume(first.request_id, 1, true)).rejects.toMatchObject({ code: 'egress_quota_exceeded' });
    await egress.finish(first.request_id);
    const second = await egress.authorize('https://registry.npmjs.org/package', 'GET');
    await egress.consume(second.request_id, 8, false);
    await expect(egress.consume(second.request_id, 1, false)).rejects.toMatchObject({ code: 'egress_quota_exceeded' });
    await egress.finish(second.request_id);
    expect(journal.facts(grant)).toMatchObject({ egress_bytes: 12, egress_requests: 2, in_flight: 0 });
    await expect(journal.renew(grant, new Date(Date.parse(grant.deadline_at) + 1).toISOString())).rejects.toMatchObject({ code: 'attempt_fenced' });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(grant.lease_expires_at) + 1);
    await expect(journal.renew(grant, grant.deadline_at)).rejects.toMatchObject({ code: 'attempt_fenced' });
    expect(() => guardedContext(state.ctx, journal).container!.start({ enableInternet: false })).toThrow();
    clock.mockRestore();
    expect(state.container.starts).toBe(0);
  });

  it('copies only capability-listed, checksummed cache parts through HTTP, binds snapshot headers, and deletes imported objects', async () => {
    const test = await fixture(); await test.command('accept');
    const runtime = test.runtime(); await test.runtimeState().ready(); await runtime.arm(runtimeGrant(test));
    const callbacks = new RemoteCallbacks(test.env, test.grant), id = crypto.randomUUID();
    const bytes = Buffer.from('snapshot binary transport fixture'), sum = await sha256(bytes);
    const stored = await callbacks.snapshot(id, 'archive', new Response(bytes).body!, bytes.length, sum);
    expect(stored.sha256).toBe(sum); expect(test.cp.objects.get(stored.id)).toEqual(new Uint8Array(bytes));
    const downloaded = await callbacks.download('cache-read', stored.id);
    await runtime.importSnapshotObject(`backups/${id}/data.sqsh`, downloaded.body!, { sha256: sum, size_bytes: bytes.length });
    expect(test.bucket.objects.size).toBe(1);
    expect([...test.bucket.objects.keys()][0]).toBe(`hosted/${test.params.grant_digest}/backups/${id}/data.sqsh`);
    await expect(callbacks.download('cache-read', 'obj_another_tenant')).rejects.toMatchObject({ code: 'attempt_fenced' });
    const url = `${test.grant.callback.origin}/internal/hosted/attempts/${test.grant.attempt_id}/snapshot-upload?generation=1&plan_digest=${test.grant.plan_digest}&snapshot_id=${id}&snapshot_part=archive`;
    const request = await signCallbackRequest(new Request(url, { method: 'POST', body: bytes, headers: { 'content-length': String(bytes.length),
      'x-gitknot-content-sha256': sum, 'x-gitknot-generation': '1', 'x-gitknot-plan-digest': test.grant.plan_digest,
      'x-gitknot-snapshot-id': id, 'x-gitknot-snapshot-part': 'metadata' } }), test.grant.callback.token);
    expect((await fetch(request)).status).toBe(401);
    await runtime.deleteSnapshotObject(`backups/${id}/data.sqsh`);
    expect(test.bucket.objects.size).toBe(0);
    expect((await runtime.runtimeStatus(runtimeGrant(test))).ephemeral_objects).toBe(0);
    expect(test.runtimeState().container.starts).toBe(0);
  });

  it('replays durable drafts and lost checkpoint/completion replies after restart without creating another Workflow or VM', async () => {
    const test = await fixture(); await test.command('accept');
    expect(await test.controller().claim(test.params)).toBe(true);
    const runtime = test.runtime(); await test.runtimeState().ready(); await runtime.arm(runtimeGrant(test));
    const draft: CompletionDraft = { attempt_id: test.grant.attempt_id, generation: 1, plan_digest: test.grant.plan_digest,
      runner_id: test.grant.producer_id, conclusion: 'failed', exit_code: 2, signal: null, resource_exhaustion: null,
      toolchain_digest: test.grant.job.toolchain.digest, outputs: [], log_manifest_digest: null, process_group_stopped: false,
      started_at: now(), finished_at: now() };
    await test.controller().saveDraft(test.params, draft);
    test.cp.dropAction = 'checkpoint';
    await expect(test.controller().reconcile()).rejects.toMatchObject({ code: 'callback_unconfirmed' });
    expect(test.cp.drafts).toHaveLength(1);
    expect(test.cp.drafts[0]!.process_group_stopped).toBe(true);
    expect((JSON.parse(await test.controller().load(test.params)) as AttemptJournal).draft?.process_group_stopped).toBe(false);
    test.controllers.delete(doId(test.grant.attempt_id).toString());
    test.cp.dropAction = 'complete';
    await expect(test.controller().reconcile()).rejects.toMatchObject({ code: 'callback_unconfirmed' });
    expect(test.cp.completions).toHaveLength(1);
    test.controllers.delete(doId(test.grant.attempt_id).toString()); test.cp.active = false;
    expect(await test.controller().reconcile()).toBe(true);
    expect(test.cp.completions).toHaveLength(1);
    expect((await test.signedStatus()).verified.state).toBe('destroyed');
    expect(await test.controller().claim(test.params)).toBe(false);
    expect(test.workflows.size).toBe(1); expect(test.runtimeState().container.starts).toBe(0);
  });

  it('keeps a corrupt or unresolved ephemeral write unproven and streams output chunks with exact aggregate checksums', async () => {
    const test = await fixture(); await test.command('accept');
    const state = test.runtimeState(), journal = new RuntimeJournal(state.ctx), grant = runtimeGrant(test);
    await journal.arm(grant);
    const store = new EphemeralStore(test.bucket.binding(), journal);
    await expect(store.put(`backups/${crypto.randomUUID()}/data.sqsh`, 'wrong bytes', { sha256: '0'.repeat(64), size_bytes: 11 })).rejects.toMatchObject({ code: 'snapshot_checksum_mismatch' });
    expect(journal.facts(grant).in_flight).toBe(0); // The completed bad checksum is a known write, not an ambiguous transport.
    vi.spyOn(test.bucket, 'put').mockRejectedValueOnce(new Error('Injected unknown R2 write acceptance.'));
    await expect(store.put(`backups/${crypto.randomUUID()}/data.sqsh`, 'uncertain')).rejects.toThrow('unknown R2 write');
    await journal.seal(grant); await store.deleteAll();
    await expect(journal.confirmDestroyed(grant)).rejects.toMatchObject({ code: 'destruction_unverified' });
    expect(journal.facts(grant).in_flight).toBe(1);
    const data = Buffer.from('x'.repeat(LIMITS.chunk_bytes * 2 + 17));
    const output: Array<{ bytes: Uint8Array; final: boolean }> = [];
    const result = await chunks(new ReadableStream({ start(controller) { controller.enqueue(data.subarray(0, 7)); controller.enqueue(data.subarray(7)); controller.close(); } }), data.length,
      async (bytes, final) => { output.push({ bytes: new Uint8Array(bytes), final }); });
    expect(result).toEqual({ size_bytes: data.length, sha256: await sha256(data) });
    expect(output.map(value => [value.bytes.length, value.final])).toEqual([[LIMITS.chunk_bytes, false], [LIMITS.chunk_bytes, false], [17, true]]);
    expect(Buffer.concat(output.map(value => value.bytes))).toEqual(data);
    await expect(chunks(new Response(data).body!, 10, async () => undefined)).rejects.toMatchObject({ code: 'output_quota_exceeded' });
  });

  it('looks up a dependency-only cache through its capability using a stable key independent of read/write mode', async () => {
    const test = await fixture(grant => { grant.job.cache = { key: 'npm', paths: ['.cache/npm'], key_files: ['package-lock.json'], retention_seconds: 3600, mode: 'read_write' }; });
    await test.command('accept');
    const sandbox = { exec: async (command: string) => {
      expect(command).toBe("git -C /workspace ls-files -s -- 'package-lock.json'");
      return { success: true, stdout: `100644 ${'a'.repeat(40)} 0\tpackage-lock.json\n` };
    } } as unknown as Sandbox;
    const dependency = () => new RemoteDependencyCache(test.env, test.params, test.grant, sandbox, test.runtime(), new RemoteCallbacks(test.env, test.grant), [], () => 120_000);
    await dependency().restore([]);
    test.grant.job.cache!.mode = 'read';
    await dependency().restore([]);
    expect(test.cp.cacheKeys).toHaveLength(2);
    expect(test.cp.cacheKeys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(test.cp.cacheKeys[0]).toBe(test.cp.cacheKeys[1]);
    expect(test.runtimeState().container.starts).toBe(0);
  });

  it('stops an already-open SDK stream at lease expiry rather than releasing bytes under expired authority', async () => {
    const test = await fixture(); await test.command('accept');
    const journal = new RuntimeJournal(test.runtimeState().ctx), grant = runtimeGrant(test);
    await journal.arm(grant);
    let supply!: (bytes: Uint8Array) => void;
    const pending = new Promise<Uint8Array>(resolve => { supply = resolve; });
    const stream = await journal.stream('test-sdk-read', async () => new ReadableStream<Uint8Array>({
      async pull(controller) { const bytes = await pending; controller.enqueue(bytes); controller.close(); },
    }));
    const read = stream.getReader().read();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(grant.lease_expires_at) + 1);
    supply(new Uint8Array([1, 2, 3]));
    await expect(read).rejects.toMatchObject({ code: 'attempt_fenced' });
    clock.mockRestore();
    expect(journal.facts(grant).in_flight).toBe(0);
  });

  it('prevents a swallowed SDK destroy error from checkpointing success before the normalized draft is durable', async () => {
    const test = await fixture(); await test.command('accept');
    const persisted: unknown[] = [];
    const platform = { do: async (_name: string, _config: unknown, work: (context: unknown) => Promise<unknown>) => {
      const value = await work({ attempt: 1 }); persisted.push(structuredClone(value)); return value;
    } } as unknown as WorkflowStep;
    const controller = test.controller();
    const draft: CompletionDraft = { attempt_id: test.grant.attempt_id, generation: 1, plan_digest: test.grant.plan_digest, runner_id: test.grant.producer_id,
      conclusion: 'infrastructure_failed', exit_code: null, signal: 'UNKNOWN', resource_exhaustion: null, toolchain_digest: test.grant.job.toolchain.digest,
      outputs: [], log_manifest_digest: null, process_group_stopped: false, started_at: now(), finished_at: now() };
    let storageAvailable = false;
    const guarded = checkpointGuard(platform, async () => {
      if (!storageAvailable) throw new Error('Injected persistence failure containing sensitive diagnostics.');
      await controller.saveDraft(test.params, draft);
    });
    // This value models the SDK's unsafe "destroy failed but runner returned"
    // boundary, not a VM result. It must not reach the platform checkpoint.
    const sdkReturn = async () => ({ conclusion: 'success', logs: { stdout: 'Full redacted log reference', stderr: '' } });
    await expect(guarded.do('pinned-sdk-step', { retries: { limit: 0, delay: 1000 }, timeout: 10000 }, sdkReturn)).rejects.toThrow('could not durably checkpoint');
    expect(persisted).toEqual([]);
    storageAvailable = true;
    await guarded.do('pinned-sdk-step', { retries: { limit: 0, delay: 1000 }, timeout: 10000 }, sdkReturn);
    expect(persisted).toHaveLength(1);
    expect((JSON.parse(await controller.load(test.params)) as AttemptJournal).draft).toEqual(draft);
    expect(test.cp.completions).toEqual([]); // An SDK assertion still cannot accept a check.
    expect(test.runtimeState().container.starts).toBe(0);
  });

  it('reports an authoritative resource quota separately from cancellation without retaining callback diagnostics', async () => {
    const test = await fixture(); await test.command('accept'); test.cp.rejectQuota = 'output';
    const callbacks = new RemoteCallbacks(test.env, test.grant);
    await expect(callbacks.json('output', {})).rejects.toMatchObject({ status: 413, code: 'output_quota_exceeded', message: 'The attempt exhausted a control-plane resource quota.' });
    expect(test.cp.completions).toEqual([]);
    expect(JSON.stringify([...test.stores.values()].flatMap(state => [...state.storage.data]))).not.toContain('Sensitive provider diagnostics');
  });
});

describe('same-account hosted lifecycle with isolated identity and metadata stores', () => {
  it('gates the real SDK start API on CP begin, registers outbound interception, and permanently fences an uncertain start', async () => {
    const test = await localFixture();
    await test.runtime().arm(test.input);
    await expect(Promise.resolve().then(() => test.runtime().start())).rejects.toMatchObject({ code: 'attempt_fenced' });
    expect(test.state.container.starts).toBe(0);
    const selected = await localAttemptEnvironment(test.env, test.input, true);
    expect(selected.env.SHARD_ID).toBe('repo-meta');
    expect(selected.env.IDENTITY_SHARD_ID).toBe('identity');
    expect(selected.env.IDENTITY_DB).toBe(test.env.IDENTITY_DB);
    test.begin();
    await test.runtime().activate(test.input, `${test.env.GIT_ORIGIN}/owner/repo.git`);
    expect(LocalSandbox.outbound).toBeTypeOf('function');
    expect(LocalSandbox.outboundHandlers?.gitknot).toBeTypeOf('function');
    const background = vi.spyOn(CloudflareSandbox.prototype, 'onStart');
    await test.runtime().onStart();
    expect(background).not.toHaveBeenCalled();
    await expect(test.runtime().start()).rejects.toThrow('Physical provider execution is deliberately unavailable');
    expect(test.state.container.starts).toBe(1);
    await test.restart();
    await expect(Promise.resolve().then(() => test.runtime().start())).rejects.toMatchObject({ code: 'attempt_fenced' });
    expect(test.state.container.starts).toBe(1);
    const proof = await test.runtime().destroyAndVerify(test.input);
    expect(proof).toMatchObject({ runtime_id: test.runtimeId, sealed: true, running: false });
  });

  it('keeps streamed SDK reads in flight until cancellation and preserves the first D1 destruction observation across rehydration', async () => {
    const test = await localFixture(); await test.runtime().arm(test.input); test.begin();
    await test.runtime().activate(test.input, `${test.env.GIT_ORIGIN}/owner/repo.git`);
    let cancelled = false;
    vi.spyOn(CloudflareSandbox.prototype, 'readFileStream').mockResolvedValueOnce(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); }, cancel() { cancelled = true; },
    }));
    const stream = await test.runtime().readFileStream('/tmp/observed');
    expect((await test.runtime().runtimeStatus(test.input)).in_flight).toBe(1);
    await expect(test.runtime().destroyAndVerify(test.input)).rejects.toMatchObject({ code: 'destruction_unverified' });
    await stream.cancel(); expect(cancelled).toBe(true);
    const first = await test.runtime().destroyAndVerify(test.input);
    const journal = test.state.storage.kv.get<Record<string, unknown>>('hosted:runtime')!;
    test.state.storage.kv.put('hosted:runtime', { ...journal, destroyed_at: null, receipt_id: null });
    await test.restart();
    const second = await test.runtime().destroyAndVerify(test.input);
    expect(second).toEqual(first);
    expect(test.metadata.sqlite.prepare('SELECT destroyed_at FROM execution_runtime_receipts').get()?.destroyed_at).toBe(first.destroyed_at);
    expect(test.state.container.starts).toBe(0);
    const identityRead = vi.spyOn(test.identity, 'prepare').mockImplementation(() => { throw new Error('Identity/placement outage.'); });
    const destroyedBefore = test.state.container.destroys;
    await expect(test.runtime().destroyAndVerify(test.input)).rejects.toThrow('outage');
    expect(test.state.container.destroys).toBe(destroyedBefore + 1);
    expect((await test.runtime().runtimeStatus(test.input)).sealed).toBe(true);
    identityRead.mockRestore();
  });

  it('retains verified trusted-account snapshots while reaping partial SDK objects, then verifies real fixture deletion at expiry', async () => {
    const test = await localFixture(); await test.runtime().arm(test.input); test.begin();
    await test.runtime().activate(test.input, `${test.env.GIT_ORIGIN}/owner/repo.git`);
    const journal = new RuntimeJournal(test.state.ctx), store = new LocalSnapshotStore(test.env, journal);
    const id = crypto.randomUUID(), archive = `backups/${id}/data.sqsh`, metadata = `backups/${id}/meta.json`;
    const bytes = new Uint8Array([0, 1, 2, 3, 4]);
    await store.put(archive, new Response(bytes).body!);
    await store.put(metadata, JSON.stringify({ id, dir: '/tmp/gitknot-snapshot', sizeBytes: bytes.length, ttl: 3600, createdAt: now() }));
    await store.retain({ id, dir: '/tmp/gitknot-snapshot', localBucket: true }, null);
    expect(test.commits).toHaveLength(2);
    expect(test.commits[0]?.checksum).toBe(await sha256(bytes));
    const orphan = `backups/${crypto.randomUUID()}/data.sqsh`;
    await store.put(orphan, 'uncommitted fixture archive');
    await journal.seal(journal.read()!);
    // Lost retention ACK: recover the durable DB row, rather than deleting it.
    const saved = test.state.storage.kv.get<Record<string, unknown>>(`hosted:local-snapshot:${archive}`)!;
    test.state.storage.kv.put(`hosted:local-snapshot:${archive}`, { ...saved, retained: false });
    test.state.storage.kv.put(`hosted:object:${archive}`, { key: archive });
    await store.reap();
    expect(await test.bucket.head(orphan)).toBeNull();
    expect(await test.bucket.head(archive)).not.toBeNull(); expect(await test.bucket.head(metadata)).not.toBeNull();
    expect(journal.facts(journal.read()!).ephemeral_objects).toBe(0);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 3_700_000);
    const remove = vi.spyOn(test.bucket, 'delete').mockResolvedValueOnce(undefined);
    await expect(store.reap()).rejects.toMatchObject({ code: 'snapshot_deletion_unverified' });
    remove.mockRestore();
    await store.reap();
    expect(test.bucket.objects.size).toBe(0);
    expect(test.state.container.starts).toBe(0);
  });

  it('journals a single normalized local result and replays completion without entering the SDK or rerunning commands', async () => {
    const test = await localFixture(); await test.runtime().arm(test.input);
    const owner = crypto.randomUUID();
    expect(await claimLocalHostedAttempt(test.env, test.input, owner)).toBe(true);
    expect(await claimLocalHostedAttempt(test.env, test.input, crypto.randomUUID())).toBe(false);
    test.begin();
    const draft = { ...test.input, plan_digest: test.planDigest, runner_id: test.grant.producer_id, toolchain_digest: test.grant.job.toolchain.digest,
      conclusion: 'failed' as const, exit_code: 2, signal: null, resource_exhaustion: null, outputs: [], log_manifest_digest: await sha256('redacted logs'),
      process_group_stopped: false, started_at: now(), finished_at: now() };
    const checkpoints: unknown[] = [];
    const step = { do: async (_name: string, _config: unknown, work: (context: unknown) => Promise<unknown>) => {
      const result = await work({ attempt: 1 }); checkpoints.push(result); return result;
    } } as unknown as WorkflowStep;
    const guarded = hostedCheckpointGuard(step, () => persistLocalHostedDraft(test.env, test.input, owner, draft));
    await guarded.do('sdk-facts', { retries: { limit: 0, delay: 1000 }, timeout: 10000 }, async () => ({ logs: 'redacted reference' }));
    expect(await finalizeLocalHostedDraft(test.env, test.input, draft.log_manifest_digest)).toBeNull();
    expect(checkpoints).toHaveLength(1); expect(await readLocalHostedDraft(test.env, test.input.attempt_id, 1)).toBeNull();
    expect(() => normalizeLocalHostedDraft({ ...draft, source: { token: 'must-not-checkpoint' } })).toThrow();
    await expect(persistLocalHostedDraft(test.env, test.input, owner, { ...draft, exit_code: 3 })).rejects.toMatchObject({ code: 'hosted_draft_conflict' });
    const sdkStep = { do: () => { throw new Error('Replay must not enter the SDK.'); } } as unknown as WorkflowStep;
    const event: WorkflowEvent<unknown> = { payload: { mode: 'attempt' }, instanceId: `attempt-${test.input.attempt_id}`, workflowName: 'RunWorkflow', timestamp: new Date() };
    await runHostedAttempt({ waitUntil() {} } as unknown as ExecutionContext, test.env, event, sdkStep, test.input.attempt_id);
    await test.restart();
    await runHostedAttempt({ waitUntil() {} } as unknown as ExecutionContext, test.env, event, sdkStep, test.input.attempt_id);
    expect(test.completions).toEqual([{ ...draft, process_group_stopped: true }]); expect(test.state.container.starts).toBe(0);
    expect(test.proofBodies[0]).toEqual(test.proofBodies[1]);
  });
});
