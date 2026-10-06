import { Hono } from 'hono';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { deserialize, serialize } from 'node:v8';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserBoundary, errorResponse, identityContext, now, one, prepareCredential, requestContext,
  routeResourceRequest, sha256, stmt,
} from '@gitknot/core';
import type { AppEnv } from '@gitknot/core';
import { AdmissionController, admissionRequest } from '@gitknot/billing';
import type { AdmissionControl, BillingBindings, BillingStore, BillingTransaction, Budget, StorageObject } from '@gitknot/billing';
import { registerProfileRoutes } from '../../apps/api/src/modules/identity/profile.ts';
import { registerStorageRoutes } from '../../apps/api/src/modules/storage.ts';
import { createTestEnvironment } from '../support/environment.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Only the DO persistence boundary is adapted; controllers, books, and financial journals are production code. */
class SqliteDurableStorage implements BillingStore {
  private readonly db = new DatabaseSync(':memory:');
  private tail: Promise<void> = Promise.resolve();

  constructor() { this.db.exec('CREATE TABLE kv(key TEXT PRIMARY KEY,value BLOB NOT NULL)'); }

  private async serial<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    const next = deferred();
    this.tail = next.promise;
    await previous;
    try { return await run(); } finally { next.resolve(); }
  }

  private view(): BillingTransaction {
    return {
      get: async <T>(key: string) => {
        const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key);
        return row ? deserialize(row.value as Uint8Array) as T : undefined;
      },
      put: async <T>(key: string, value: T) => {
        this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, serialize(value));
      },
      delete: async key => Number(this.db.prepare('DELETE FROM kv WHERE key=?').run(key).changes) > 0,
      list: async <T>(options: { prefix?: string; startAfter?: string; limit?: number } = {}) => new Map<string, T>(
        this.db.prepare('SELECT key,value FROM kv WHERE key>? ORDER BY key').all(options.startAfter ?? '')
          .filter(row => String(row.key).startsWith(options.prefix ?? '')).slice(0, options.limit ?? Infinity)
          .map(row => [String(row.key), deserialize(row.value as Uint8Array) as T]),
      ),
    };
  }

  get<T>(key: string) { return this.serial(() => this.view().get<T>(key)); }
  put<T>(key: string, value: T) { return this.serial(() => this.view().put(key, value)); }
  delete(key: string) { return this.serial(() => this.view().delete(key)); }
  list<T>(options?: { prefix?: string; startAfter?: string; limit?: number }) { return this.serial(() => this.view().list<T>(options)); }
  transaction<T>(run: (tx: BillingTransaction) => Promise<T>) {
    return this.serial(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try { const result = await run(this.view()); this.db.exec('COMMIT'); return result; }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
    });
  }
  async setAlarm(): Promise<void> {}
  close() { this.db.close(); }
}

class AdmissionNetwork {
  readonly calls: string[] = [];
  private readonly controllers = new Map<string, { controller: AdmissionController; storage: SqliteDurableStorage }>();
  intercept?: (target: string, action: string, deliver: () => Promise<Response>) => Promise<Response>;

  constructor(readonly env: BillingBindings) {}

  binding(): DurableObjectNamespace {
    return {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id: { toString(): string }) => ({ fetch: (request: Request) => {
        const target = id.toString();
        const action = new URL(request.url).pathname.split('/').at(-1)!;
        this.calls.push(`${target}/${action}`);
        const deliver = () => {
          let entry = this.controllers.get(target);
          if (!entry) {
            const storage = new SqliteDurableStorage();
            const state = { storage, blockConcurrencyWhile: <T>(run: () => Promise<T>) => run() } as unknown as DurableObjectState;
            entry = { storage, controller: new AdmissionController(state, this.env) };
            this.controllers.set(target, entry);
          }
          return entry.controller.fetch(request);
        };
        return this.intercept ? this.intercept(target, action, deliver) : deliver();
      } }),
    } as unknown as DurableObjectNamespace;
  }

  close() { for (const { storage } of this.controllers.values()) storage.close(); }
}

interface Manifest {
  id: string; state: string; revision: number; bytes: number; sha256: string; content_type: string;
  account_id: string; repo_id: string | null; retention_until: string | null;
}
interface StoredManifest extends Manifest {
  object_key: string; upload_generation: number; upload_failure: string | null; upload_bytes_received: number;
  billing_reservation_id: string | null; billing_fence: string | null;
}
interface RequestOptions {
  key?: string; etag?: string; token?: string | null; json?: unknown; body?: BodyInit; headers?: Record<string, string>;
}
type Snapshot = { control: AdmissionControl; budgets: Budget[] };
const opened: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of opened.splice(0)) await close();
});

async function status(response: Response, expected: number): Promise<Response> {
  expect(response.status, response.status === expected ? undefined : await response.clone().text()).toBe(expected);
  return response;
}

async function error(response: Response, expected: number, code: string): Promise<void> {
  await status(response, expected);
  expect(response.headers.get('content-type')).toMatch(/^application\/json/);
  expect(response.headers.get('content-disposition')).toBeNull();
  expect(response.headers.get('content-range')).toBeNull();
  expect(await response.json()).toMatchObject({ error: { code, request_id: response.headers.get('x-gitknot-request-id') } });
}

const bytes = (value: string) => new TextEncoder().encode(value);
function chunks(...values: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({ pull(controller) {
    if (index === values.length) controller.close();
    else controller.enqueue(values[index++]!);
  } });
}

async function fixture() {
  const test = await createTestEnvironment({ API_ORIGIN: 'https://api.gitknot.com', APP_ORIGIN: 'https://gitknot.com',
    BILLING_PLATFORM_SLICE_ID: 'slice_local' });
  const env = test.env as BillingBindings;
  env.IDENTITY_DB = env.DB;
  env.IDENTITY_CELL_ID = 'local';
  env.IDENTITY_SHARD_ID = 'core';
  const network = new AdmissionNetwork(env);
  env.ADMISSION = network.binding();
  opened.push(async () => { await test.flush(); network.close(); test.close(); });
  const at = now();
  for (const name of ['owner', 'reader']) await env.DB.batch([
    stmt(env.DB, 'INSERT INTO users(id,username,email,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?)', `u_${name}`, name, `${name}@example.net`, at, at, at),
    stmt(env.DB, "INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES (?,'user',?,?,?,?,?)", `u_${name}`, name, name, `u_${name}`, at, at),
    stmt(env.DB, "INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES (?,'user',?,?,?,?,?,?)", `u_${name}`, `u_${name}`, `u_${name}`, name, `u_${name}`, at, at),
  ]);
  await env.DB.batch([
    stmt(env.DB, `INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
      VALUES ('r_repo','u_owner','Repo','repo','private','active','local','core','storage_repo','u_owner',?,?)`, at, at),
    stmt(env.DB, `INSERT INTO billing_platform_pools(id,period_start,period_end,limit_units,safety_buffer_units,baseline_commitment_units,max_instances,state)
      VALUES ('pool_local',?,'2099-01-01T00:00:00.000Z','1000000000000','1000000000','1000000000',16,'active')`, at),
    stmt(env.DB, `INSERT INTO billing_capacity_slices(id,pool_id,cell_id,limit_units,max_instances,max_storage_bytes,valid_until,state,created_at)
      VALUES ('slice_local','pool_local','local','100000000000',16,'1000000000000','2099-01-01T00:00:00.000Z','active',?)`, at),
  ]);
  async function credential(capabilities: string[] = ['*'], user = 'u_owner') {
    const issued = await prepareCredential(env.DB, { principal_id: user, user_id: user, kind: 'personal', name: 'Storage journey',
      capabilities, repository_ids: null, account_ids: null, auth_revision: 1, mfa: false,
      expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), created_by: user });
    await issued.statement.run();
    return issued;
  }
  const owner = await credential();
  const app = new Hono<AppEnv>();
  app.onError(errorResponse);
  app.use('*', requestContext);
  app.use('/v1/*', browserBoundary);
  app.use('/v1/*', async (c, next) => { const response = await routeResourceRequest(c); if (response) return response; await next(); });
  app.use('/v1/*', identityContext);
  registerStorageRoutes(app);
  registerProfileRoutes(app);
  const request = (method: string, path: string, options: RequestOptions = {}): Promise<Response> => {
    const token = options.token === undefined ? owner.token : options.token;
    const headers = new Headers(options.headers);
    if (token !== null) headers.set('authorization', `Bearer ${token}`);
    if (options.key) headers.set('idempotency-key', options.key);
    if (options.etag) headers.set('if-match', options.etag);
    if (options.json !== undefined) headers.set('content-type', 'application/json');
    else if (options.body !== undefined) headers.set('content-type', 'application/octet-stream');
    const body = options.json === undefined ? options.body : JSON.stringify(options.json);
    return Promise.resolve(app.fetch(new Request(`${env.API_ORIGIN}${path}`, { method, headers, body,
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) }), env, test.context));
  };
  const input = async (content: Uint8Array, avatar = false) => ({ filename: avatar ? 'avatar.png' : 'file.txt', bytes: content.byteLength,
    sha256: await sha256(content), kind: avatar ? 'avatar' as const : 'attachment' as const, content_type: avatar ? 'image/png' : 'application/octet-stream' });
  const reserve = async (key: string, content: Uint8Array, options: { account?: boolean; avatar?: boolean } = {}) => {
    const path = options.account ? '/v1/accounts/u_owner/uploads' : '/v1/repos/r_repo/uploads';
    const response = await status(await request('POST', path, { key, json: await input(content, options.avatar) }), 201);
    return { manifest: await response.json() as Manifest, etag: response.headers.get('etag')! };
  };
  const ready = async (key: string, content: Uint8Array, options: { account?: boolean; avatar?: boolean } = {}) => {
    const value = await reserve(key, content, options);
    const response = await status(await request('PUT', `/v1/uploads/${value.manifest.id}`, { etag: value.etag, body: chunks(content) }), 201);
    return await response.json() as Manifest;
  };
  const stored = async (id: string) => (await one<StoredManifest>(env.DB, 'SELECT * FROM object_manifests WHERE id=?', id))!;
  const quota = () => one<{ used_bytes: number; reserved_bytes: number }>(env.DB, "SELECT used_bytes,reserved_bytes FROM storage_quotas WHERE scope_id='r_repo'");
  const snapshot = (target = 'account:u_owner') => admissionRequest<Snapshot>(env, target, 'snapshot');
  const meter = (id: string) => admissionRequest<StorageObject>(env, 'account:u_owner', 'get-object', { object_id: id });
  const remove = async (manifest: Pick<Manifest, 'id' | 'revision'>, key: string) => {
    const options = { key, etag: `"${manifest.revision}"` };
    await status(await request('DELETE', `/v1/objects/${manifest.id}`, options), 204);
    await status(await request('DELETE', `/v1/objects/${manifest.id}`, options), 204);
  };
  return { ...test, env, network, request, credential, input, reserve, ready, stored, quota, snapshot, meter, remove };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

interface SinkAttempt { key: string; received: number; accepted: boolean }
/** This R2 transport can commit as soon as N bytes arrive; it never waits for the input stream's EOF. */
function lengthAcceptingSink(f: Fixture) {
  const put = f.blobs.put.bind(f.blobs);
  const sink: { attempts: SinkAttempt[]; afterRead?: (attempt: SinkAttempt) => Promise<void> } = { attempts: [] };
  f.blobs.put = async (key, value, options) => {
    const manifest = (await one<{ bytes: number }>(f.env.DB, 'SELECT bytes FROM object_manifests WHERE object_key=?', key))!;
    const attempt: SinkAttempt = { key, received: 0, accepted: false };
    sink.attempts.push(attempt);
    const content = new Uint8Array(manifest.bytes);
    const reader = value instanceof ReadableStream ? value.getReader() : new Response(value as BodyInit | null).body?.getReader();
    try {
      while (attempt.received < content.byteLength) {
        const chunk = await reader!.read();
        if (chunk.done) throw new Error('R2 received fewer bytes than the declared length.');
        content.set(chunk.value, attempt.received);
        attempt.received += chunk.value.byteLength;
        await sink.afterRead?.(attempt);
      }
      const object = await put(key, content, options);
      attempt.accepted = object !== null;
      return object;
    } finally { void reader?.cancel().catch(() => undefined); reader?.releaseLock(); }
  };
  return sink;
}

async function reached(entered: Promise<void>, response: Promise<Response>): Promise<void> {
  let waiting = true;
  try { await Promise.race([entered, response.then(async value => {
    if (waiting) throw new Error(`Request finished before the intended boundary: ${value.status} ${await value.text()}`);
  })]); } finally { waiting = false; }
}

describe('generic upload HTTP, privacy, and financial recovery', () => {
  it('keeps account assets private and rechecks current avatar publication before GET, HEAD, and 304', async () => {
    const f = await fixture();
    const image = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1kAAAAASUVORK5CYII=', 'base64'));
    const attachment = await f.ready('private-account-file', bytes('private'), { account: true });
    const first = await f.ready('first-avatar', image, { account: true, avatar: true });
    const second = await f.ready('second-avatar', image, { account: true, avatar: true });
    const get = vi.spyOn(f.blobs, 'get');
    const head = vi.spyOn(f.blobs, 'head');
    const path = (manifest: Manifest) => `/v1/objects/${manifest.id}/content`;
    const condition = (manifest: Manifest) => ({ 'if-none-match': `"${manifest.sha256}"` });
    async function hidden(manifest: Manifest) {
      const reads = get.mock.calls.length + head.mock.calls.length;
      for (const method of ['GET', 'HEAD']) for (const headers of [{}, condition(manifest)]) {
        await status(await f.request(method, path(manifest), { token: null, headers }), 404);
      }
      expect(get.mock.calls.length + head.mock.calls.length).toBe(reads);
    }
    await hidden(attachment);
    await hidden(first);
    await status(await f.request('GET', `/v1/objects/${first.id}`, { token: null }), 404);
    const profileOnly = await f.credential(['accounts.read']);
    await status(await f.request('GET', path(attachment), { token: profileOnly.token }), 404);
    const readOnly = await f.credential(['attachments.read']);
    const metadata = await status(await f.request('GET', `/v1/objects/${attachment.id}`, { token: readOnly.token }), 200);
    expect(metadata.headers.get('content-type')).toMatch(/^application\/json/);
    expect(metadata.headers.get('content-disposition')).toBeNull();
    expect(metadata.headers.get('accept-ranges')).toBeNull();
    expect(await metadata.json()).not.toHaveProperty('object_key');
    await status(await f.request('GET', path(attachment), { token: readOnly.token, headers: condition(attachment) }), 304);
    await stmt(f.env.DB, 'UPDATE credentials SET revoked_at=?,revision=revision+1 WHERE id=?', now(), readOnly.credential.id).run();
    await status(await f.request('GET', path(attachment), { token: readOnly.token, headers: condition(attachment) }), 404);

    await stmt(f.env.IDENTITY_DB!, "UPDATE users SET avatar_url=?,revision=revision+1 WHERE id='u_owner'", `${f.env.API_ORIGIN}${path(first)}`).run();
    const visible = await status(await f.request('GET', path(first), { token: null }), 200);
    expect(new Uint8Array(await visible.arrayBuffer())).toEqual(image);
    expect(visible.headers.get('content-type')).toBe('image/png');
    expect(visible.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(visible.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(visible.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    const visibleHead = await status(await f.request('HEAD', path(first), { token: null }), 200);
    expect(visibleHead.headers.get('content-length')).toBe(String(image.byteLength));
    expect(await visibleHead.text()).toBe('');
    for (const method of ['GET', 'HEAD']) await status(await f.request(method, path(first), { token: null, headers: condition(first) }), 304);
    await status(await f.request('GET', `/v1/objects/${first.id}`, { token: null }), 404);

    await stmt(f.env.IDENTITY_DB!, "UPDATE users SET avatar_url=?,revision=revision+1 WHERE id='u_owner'", `${f.env.API_ORIGIN}${path(second)}`).run();
    await hidden(first);
    await status(await f.request('GET', path(second), { token: null, headers: condition(second) }), 304);
    await f.env.IDENTITY_DB!.prepare("UPDATE users SET profile_visibility='private',revision=revision+1 WHERE id='u_owner'").run();
    await status(await f.request('GET', '/v1/users/u_owner', { token: null }), 404);
    await hidden(second);
    await f.env.IDENTITY_DB!.prepare("UPDATE users SET profile_visibility='public',email_verified_at=NULL,revision=revision+1 WHERE id='u_owner'").run();
    await hidden(second);
    await stmt(f.env.IDENTITY_DB!, "UPDATE users SET email_verified_at=?,revision=revision+1 WHERE id='u_owner'", now()).run();
    await stmt(f.env.IDENTITY_DB!, "UPDATE accounts SET disabled_at=?,revision=revision+1 WHERE id='u_owner'", now()).run();
    await hidden(second);
  });

  it('withholds acceptance for invalid tails and empty uploads, permits retry/cancellation, and streams under backpressure', async () => {
    const f = await fixture();
    const put = f.blobs.put.bind(f.blobs);
    const sink = lengthAcceptingSink(f);
    const cases = [
      { name: 'exact-boundary-overflow', content: bytes('data'), input: [bytes('data'), bytes('x')], retry: true },
      { name: 'zero-byte-overflow', content: bytes(''), input: [bytes('x')], retry: true },
      { name: 'checksum-mismatch', content: bytes('data'), input: [bytes('fail')], retry: false },
    ];
    for (const scenario of cases) {
      const created = await f.reserve(scenario.name, scenario.content);
      const id = created.manifest.id;
      const calls = sink.attempts.length;
      await error(await f.request('PUT', `/v1/uploads/${id}`, { etag: created.etag, body: chunks(...scenario.input) }), 422, 'upload_input_invalid');
      const rejected = await f.stored(id);
      expect(rejected).toMatchObject({ state: 'pending', upload_generation: 1, upload_failure: 'input_incomplete' });
      expect(await f.blobs.head(rejected.object_key)).toBeNull();
      if (scenario.content.byteLength === 0) expect(sink.attempts).toHaveLength(calls);
      else expect(sink.attempts.at(-1)).toMatchObject({ received: scenario.content.byteLength - 1, accepted: false });
      expect((await f.snapshot()).control).toMatchObject({ reserved_bytes: String(scenario.content.byteLength), stored_bytes: '0', object_count: 1 });
      expect(await f.quota()).toEqual({ reserved_bytes: scenario.content.byteLength, used_bytes: 0 });
      expect(await one(f.env.DB, 'SELECT COUNT(*) AS count FROM billing_ledger WHERE object_id=?', id)).toEqual({ count: 0 });
      const current = await status(await f.request('GET', `/v1/objects/${id}`), 200);
      let final = await current.json() as Manifest;
      if (scenario.retry) {
        const retried = await status(await f.request('PUT', `/v1/uploads/${id}`, { etag: current.headers.get('etag')!,
          body: scenario.content.byteLength ? chunks(scenario.content) : undefined }), 201);
        final = await retried.json() as Manifest;
        expect(await f.stored(id)).toMatchObject({ state: 'ready', upload_generation: 2, upload_bytes_received: scenario.content.byteLength });
        expect(sink.attempts.at(-1)).toMatchObject({ received: scenario.content.byteLength, accepted: true });
        expect((await f.snapshot()).control).toMatchObject({ reserved_bytes: '0', stored_bytes: String(scenario.content.byteLength) });
      }
      await f.remove(final, `${scenario.name}-delete`);
      expect(await f.blobs.head(rejected.object_key)).toBeNull();
      expect(await f.quota()).toEqual({ reserved_bytes: 0, used_bytes: 0 });
      for (const target of ['account:u_owner', 'capacity:slice_local']) {
        expect((await f.snapshot(target)).control).toMatchObject({ reserved_bytes: '0', stored_bytes: '0', object_count: 0 });
      }
      expect(await one(f.env.DB, "SELECT COUNT(*) AS count FROM outbox WHERE resource_id=? AND type='object.deleted'", id)).toEqual({ count: 1 });
    }

    const content = new Uint8Array(2 * 1024 * 1024).fill(0x61);
    const large = await f.reserve('backpressured-upload', content);
    const entered = deferred(), released = deferred();
    let paused = false;
    sink.afterRead = async () => { if (!paused) { paused = true; entered.resolve(); await released.promise; } };
    const chunkSize = 64 * 1024;
    let produced = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (produced * chunkSize === content.byteLength) controller.close();
      else {
        const offset = produced++ * chunkSize;
        controller.enqueue(content.subarray(offset, offset + chunkSize));
      }
    } });
    const pending = f.request('PUT', `/v1/uploads/${large.manifest.id}`, { etag: large.etag, body });
    await reached(entered.promise, pending);
    let uploaded!: Response;
    try {
      await setImmediate();
      expect(produced).toBeGreaterThan(0);
      expect(produced * chunkSize).toBeLessThanOrEqual(4 * chunkSize);
    } finally { released.resolve(); uploaded = await pending; }
    await status(uploaded, 201);
    const result = await uploaded.json() as Manifest;
    const download = await status(await f.request('GET', `/v1/objects/${result.id}/content`), 200);
    expect(await sha256(new Uint8Array(await download.arrayBuffer()))).toBe(result.sha256);
    expect((await f.snapshot()).control).toMatchObject({ stored_bytes: String(content.byteLength), reserved_bytes: '0' });
    await f.remove(result, 'backpressured-delete');
    expect(await f.quota()).toEqual({ reserved_bytes: 0, used_bytes: 0 });

    // Legal chunk boundaries must also work with a sink that immediately awaits its first byte.
    f.blobs.put = put;
    for (const [name, pieces] of [
      ['one-byte-file', ['x']], ['one-byte-first-chunk', ['d', 'ata']], ['empty-chunks', ['', '', 'da', '', 'ta', '']],
      ['zero-byte-empty-chunks', ['', '']],
    ] as const) {
      const small = await f.reserve(name, bytes(pieces.join('')));
      const response = await status(await f.request('PUT', `/v1/uploads/${small.manifest.id}`, {
        etag: small.etag, body: chunks(...pieces.map(bytes)),
      }), 201);
      await f.remove(await response.json() as Manifest, `${name}-delete`);
    }
  });

  it('never funds an expired denied intent and durably cancels it before a fresh admission', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = await fixture();
    const initial = (await f.snapshot()).control;
    await admissionRequest(f.env, 'account:u_owner', 'stop', { stopped: true, reason: 'Paused for this scenario', revision: initial.revision });
    const input = await f.input(bytes('data'));
    const create = () => f.request('POST', '/v1/repos/r_repo/uploads', { key: 'denied-create', json: input });
    await error(await create(), 409, 'execution_stopped');
    const intent = (await one<StoredManifest>(f.env.DB, "SELECT * FROM object_manifests WHERE state='reserving'"))!;
    expect(intent.billing_reservation_id).toBeNull();
    expect(await one(f.env.DB, 'SELECT COUNT(*) AS count FROM billing_storage_objects')).toEqual({ count: 0 });
    vi.setSystemTime(Date.parse(intent.retention_until!) + 1);
    const stopped = (await f.snapshot()).control;
    await admissionRequest(f.env, 'account:u_owner', 'stop', { stopped: false, reason: null, revision: stopped.revision });
    const admissions = f.network.calls.filter(call => call.endsWith('/standalone-reserve')).length;
    for (let retry = 0; retry < 2; retry++) {
      await error(await f.request('POST', `/v1/uploads/${intent.id}/prepare`, { key: 'expired-prepare' }), 409, 'upload_expired');
      await error(await create(), 409, 'upload_expired');
    }
    await error(await f.request('PUT', `/v1/uploads/${intent.id}`, { etag: `"${intent.revision}"`, body: chunks(bytes('data')) }), 409, 'upload_expired');
    expect(f.network.calls.filter(call => call.endsWith('/standalone-reserve'))).toHaveLength(admissions);
    expect(await f.stored(intent.id)).toMatchObject({ state: 'reserving', revision: intent.revision, billing_reservation_id: null, billing_fence: null });
    expect((await f.snapshot()).control).toMatchObject({ reserved_bytes: '0', stored_bytes: '0' });
    expect(await one(f.env.DB, 'SELECT COUNT(*) AS count FROM billing_storage_objects')).toEqual({ count: 0 });
    expect(await one(f.env.DB, 'SELECT COUNT(*) AS count FROM billing_ledger')).toEqual({ count: 0 });
    await f.remove(intent, 'cancel-expired');
    expect(await f.quota()).toEqual({ used_bytes: 0, reserved_bytes: 0 });
    expect(await one(f.env.DB, 'SELECT COUNT(*) AS count FROM billing_storage_objects')).toEqual({ count: 0 });
    await error(await create(), 404, 'not_found');
    const fresh = await f.reserve('fresh-after-cancel', bytes('data'));
    expect(fresh.manifest.state).toBe('pending');
    expect((await f.snapshot()).control.reserved_bytes).toBe('4');
    await f.remove(fresh.manifest, 'cancel-fresh');
    expect((await f.snapshot()).control).toMatchObject({ reserved_bytes: '0', stored_bytes: '0', object_count: 0 });
    expect(await one(f.env.DB, 'SELECT COUNT(*) AS count FROM billing_ledger')).toEqual({ count: 0 });
  });

  it('reconciles positive R2 evidence, stops pending transport reads, and retains fully transmitted uncertainty', async () => {
    const f = await fixture();
    const put = f.blobs.put.bind(f.blobs);
    const positive = await f.reserve('accepted-lost-reply', bytes('data'));
    let puts = 0;
    f.blobs.put = async (...args) => { puts++; await put(...args); throw new Error('R2 accepted the object but its acknowledgement was lost.'); };
    const accepted = await status(await f.request('PUT', `/v1/uploads/${positive.manifest.id}`, { etag: positive.etag, body: chunks(bytes('data')) }), 200);
    const ready = await accepted.json() as Manifest;
    expect((await f.meter(ready.id)).state).toBe('stored');
    await status(await f.request('POST', `/v1/uploads/${ready.id}/complete`, { key: 'positive-complete' }), 200);
    await status(await f.request('POST', `/v1/uploads/${ready.id}/complete`, { key: 'positive-complete' }), 200);
    expect(puts).toBe(1);
    const stored = await f.stored(ready.id);
    const head = (await f.blobs.head(stored.object_key))!;
    expect(head.customMetadata).toMatchObject({ object_id: ready.id, repo_id: 'r_repo', sha256: ready.sha256, upload_generation: '1' });
    await f.remove(ready, 'positive-delete');
    const receipt = await f.meter(ready.id);
    const lines = (await f.env.DB.prepare('SELECT quantity FROM billing_ledger WHERE object_id=? AND operating_cost=0').bind(ready.id).all<{ quantity: string }>()).results;
    expect(lines).toHaveLength(1);
    expect(BigInt(lines[0]!.quantity)).toBe(4n * BigInt(Date.parse(receipt.deleted_at!) - head.uploaded.getTime()));

    // A failed PUT can leave a transport read pending while the client has not sent EOF.
    // If that read ever receives the fourth byte, this adapter really commits it to R2.
    const interrupted = await f.reserve('reply-failed-before-eof', bytes('data'));
    const waiting = deferred(), eof = deferred();
    let first = true, cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (first) { first = false; controller.enqueue(bytes('data')); return; }
        waiting.resolve();
        await eof.promise;
        if (!cancelled) controller.close();
      },
      cancel() { cancelled = true; eof.resolve(); },
    });
    let wireBytes = 0;
    let transport!: Promise<string>;
    f.blobs.put = async (key, value, options) => {
      expect(value).toBeInstanceOf(ReadableStream);
      const reader = (value as ReadableStream<Uint8Array>).getReader();
      const prefix = (await reader.read()).value!;
      wireBytes = prefix.byteLength;
      transport = reader.read().then(async result => {
        if (result.done) return 'closed';
        wireBytes += result.value.byteLength;
        await put(key, new Uint8Array([...prefix, ...result.value]), options);
        return 'accepted';
      }).catch(() => 'stopped').finally(() => reader.releaseLock());
      await waiting.promise;
      throw new Error('The provider reply failed while its request reader was still pending.');
    };
    await error(await f.request('PUT', `/v1/uploads/${interrupted.manifest.id}`, { etag: interrupted.etag, body: source }), 422, 'upload_input_invalid');
    expect(cancelled).toBe(true);
    expect(await transport).toBe('stopped');
    expect(wireBytes).toBe(3);
    const failed = await f.stored(interrupted.manifest.id);
    expect(failed).toMatchObject({ state: 'pending', upload_failure: 'input_incomplete' });
    expect(await f.blobs.head(failed.object_key)).toBeNull();
    await f.remove(failed, 'cancel-stopped-transport');

    const unknown = await f.reserve('valid-unknown-outcome', bytes('data'));
    let submitted!: { key: string; content: Uint8Array<ArrayBuffer>; options: R2PutOptions | undefined };
    puts = 0;
    f.blobs.put = async (key, value, options) => {
      puts++;
      submitted = { key, content: new Uint8Array(await new Response(value as BodyInit | null).arrayBuffer()), options };
      throw new Error('The complete valid upload was transmitted; storage acceptance is unknown.');
    };
    await error(await f.request('PUT', `/v1/uploads/${unknown.manifest.id}`, { etag: unknown.etag, body: chunks(bytes('data')) }), 502, 'upload_unconfirmed');
    expect(await f.stored(unknown.manifest.id)).toMatchObject({ state: 'uploading', upload_generation: 1, upload_failure: null });
    expect(await f.quota()).toEqual({ reserved_bytes: 4, used_bytes: 0 });
    for (const target of ['account:u_owner', 'capacity:slice_local']) {
      expect((await f.snapshot(target)).control).toMatchObject({ reserved_bytes: '4', stored_bytes: '0', object_count: 1 });
    }
    await error(await f.request('PUT', `/v1/uploads/${unknown.manifest.id}`, { etag: '"3"', body: chunks(bytes('data')) }), 409, 'upload_incomplete');
    await error(await f.request('POST', `/v1/uploads/${unknown.manifest.id}/complete`, { key: 'unknown-complete' }), 409, 'upload_incomplete');
    await error(await f.request('DELETE', `/v1/objects/${unknown.manifest.id}`, { key: 'unknown-delete', etag: '"3"' }), 409, 'upload_in_progress');
    expect(puts).toBe(1);
    expect(await one(f.env.DB, 'SELECT COUNT(*) AS count FROM billing_ledger WHERE object_id=?', unknown.manifest.id)).toEqual({ count: 0 });

    // Deliver the original in-flight provider write, rather than issue a replacement upload or a billing receipt.
    await put(submitted.key, submitted.content, submitted.options);
    const completed = await status(await f.request('POST', `/v1/uploads/${unknown.manifest.id}/complete`, { key: 'unknown-complete' }), 200);
    const manifest = await completed.json() as Manifest;
    expect(await f.quota()).toEqual({ reserved_bytes: 0, used_bytes: 4 });
    let lost = false;
    f.network.intercept = async (target, action, deliver) => {
      const response = await deliver();
      if (!lost && target === 'account:u_owner' && action === 'storage-delete') { lost = true; throw new Error('Lost the real financial deletion receipt.'); }
      return response;
    };
    const deletion = { key: 'settled-delete', etag: `"${manifest.revision}"` };
    await error(await f.request('DELETE', `/v1/objects/${manifest.id}`, deletion), 503, 'admission_unavailable');
    expect((await f.stored(manifest.id)).state).toBe('deleting');
    expect((await f.snapshot()).control.stored_bytes).toBe('0');
    expect(await f.quota()).toEqual({ reserved_bytes: 0, used_bytes: 4 });
    await status(await f.request('DELETE', `/v1/objects/${manifest.id}`, deletion), 204);
    await status(await f.request('DELETE', `/v1/objects/${manifest.id}`, deletion), 204);
    expect(await f.quota()).toEqual({ reserved_bytes: 0, used_bytes: 0 });
    expect(await one(f.env.DB, "SELECT COUNT(*) AS count FROM outbox WHERE resource_id=? AND type='object.deleted'", manifest.id)).toEqual({ count: 1 });
    expect(await one(f.env.DB, 'SELECT COUNT(*) AS count FROM billing_ledger WHERE object_id=? AND operating_cost=0', manifest.id)).toEqual({ count: 1 });
  });
});
