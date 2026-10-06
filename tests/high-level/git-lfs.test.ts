import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv, Bindings } from '../../packages/core/src/types.ts';
import { authenticate, getRepository } from '../../packages/core/src/index.ts';
import { errorResponse } from '../../packages/core/src/errors.ts';
import { sha256 } from '../../packages/core/src/crypto.ts';
import { handleLfs, sweepLfs, verifyLfsPointers } from '../../packages/git/src/lfs.ts';
import { createTestDatabase } from '../support/database.ts';
import type { SqliteD1 } from '../support/database.ts';
import { TestBucket } from '../support/storage.ts';
import { AdmissionController, admissionRequest, reserveStandaloneStorage } from '../../packages/billing/src/index.ts';
import type { LfsUpload } from '../../packages/git/src/lfs.ts';

let db: SqliteD1;
let bucket: TestBucket;
let env: Bindings;
let app: Hono<AppEnv>;
const token = `gkt_${'a'.repeat(43)}`;
const header = { authorization: `Bearer ${token}`, 'content-type': 'application/vnd.git-lfs+json' };

beforeEach(async () => {
  db = await createTestDatabase();
  bucket = new TestBucket();
  env = { DB: db.binding(), DIRECTORY_DB: db.binding(), BLOBS: bucket.binding(), ENVIRONMENT: 'test', API_ORIGIN: 'http://lfs.test', APP_ORIGIN: 'http://lfs.test',
    INTERNAL_SERVICE_KEY: 'ad43b08bf3768acbb0cc74796873059338562354b3b264001f995e8378f58ec47', CELL_ID: 'local', SHARD_ID: 'core', BILLING_PLATFORM_SLICE_ID: 'slice_lfs',
    LIMITS_JSON: JSON.stringify({ git: { lfs_repository_bytes: 20, lfs_object_bytes: 16 } }) } as unknown as Bindings;
  const at = new Date().toISOString();
  db.sqlite.prepare(`INSERT INTO billing_platform_pools(id,period_start,period_end,limit_units,safety_buffer_units,baseline_commitment_units,allocated_units,max_instances,allocated_instances,state)
    VALUES ('pool_lfs',?,?,'1000000000000','0','0','1000000000',1,0,'active')`).run(at, new Date(Date.now() + 86400_000).toISOString());
  db.sqlite.prepare(`INSERT INTO billing_capacity_slices(id,pool_id,cell_id,limit_units,max_instances,max_storage_bytes,valid_until,state,created_at)
    VALUES ('slice_lfs','pool_lfs','local','1000000000',0,'1000000',?,'active',?)`).run(new Date(Date.now() + 86400_000).toISOString(), at);
  const controllers = new Map<string, AdmissionController>();
  env.ADMISSION = {
    idFromName: (name: string) => ({ toString: () => name }),
    get(id: { toString(): string }) {
      const name = id.toString();
      let controller = controllers.get(name);
      if (!controller) {
        const storage = new BillingTestStorage();
        controller = new AdmissionController({ storage, blockConcurrencyWhile: (callback: () => Promise<unknown>) => callback(), waitUntil: () => {}, id } as unknown as DurableObjectState, env);
        controllers.set(name, controller);
      }
      return { fetch: (request: Request) => controller!.fetch(request) };
    },
  } as unknown as DurableObjectNamespace;
  db.sqlite.prepare('INSERT INTO users(id,username,email,display_name,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('u_lfs', 'lfs', 'lfs@example.test', 'LFS actor', at, at, at);
  db.sqlite.prepare("INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES (?,'user',?,?,?,?,?)").run('u_lfs', 'lfs', 'LFS owner', 'u_lfs', at, at);
  db.sqlite.prepare("INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES (?,'user',?,?,?,?,?,?)").run('u_lfs', 'u_lfs', 'u_lfs', 'LFS actor', 'u_lfs', at, at);
  for (const id of ['r_lfs_a', 'r_lfs_b']) db.sqlite.prepare(`INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
    VALUES (?,'u_lfs',?,?,'private','active','local','core',?,'u_lfs',?,?)`).run(id, id, id, id, at, at);
  db.sqlite.prepare(`INSERT INTO credentials(id,principal_id,user_id,kind,name,token_hash,token_prefix,capabilities_json,auth_revision,mfa,authenticated_at,expires_at,created_by,created_at)
    VALUES ('cred_lfs','u_lfs','u_lfs','personal','LFS',?,?,'["*"]',1,1,?,?,'u_lfs',?)`).run(await sha256(token), token.slice(0, 12), at, new Date(Date.now() + 3600_000).toISOString(), at);
  // This fixture supplies the platform FixedLengthStream primitive; the production code
  // runs unchanged against real SQLite constraints and a checksumming local R2 adapter.
  vi.stubGlobal('FixedLengthStream', class extends TransformStream<Uint8Array, Uint8Array> {
    constructor(expected: number) {
      let size = 0;
      super({ transform(chunk, controller) { size += chunk.length; if (size > expected) throw new Error('length exceeded'); controller.enqueue(chunk); },
        flush() { if (size !== expected) throw new Error('length mismatch'); } });
    }
  });
  app = new Hono<AppEnv>();
  app.onError(errorResponse);
  app.all('/repos/:repoId/lfs/*', async c => {
    c.set('requestId', crypto.randomUUID());
    c.set('database', env.DB.withSession('first-primary'));
    c.set('principal', await authenticate(c.req.raw, env));
    const repo = await getRepository(c, c.req.param('repoId'));
    return handleLfs(c, repo, c.req.path.split('/lfs/')[1], `http://lfs.test/repos/${repo.id}/lfs`);
  });
});

afterEach(() => { vi.unstubAllGlobals(); db?.close(); });

test('LFS batch/upload/verify/download is checksummed, scoped, quota-reserved and revocation-aware', async () => {
  const bytes = 'hello LFS';
  const oid = await sha256(bytes);
  const batch = await call('/repos/r_lfs_a/lfs/objects/batch', 'POST', JSON.stringify({ operation: 'upload', objects: [{ oid, size: bytes.length }] }));
  expect(batch.status, await batch.clone().text()).toBe(200);
  const result = await batch.json() as { objects: Array<{ actions: { upload: { href: string }; verify: { href: string } } }> };
  const action = result.objects[0].actions;
  expect((db.sqlite.prepare('SELECT reserved_bytes FROM git_lfs_quotas WHERE repo_id=?').get('r_lfs_a') as { reserved_bytes: number }).reserved_bytes).toBe(bytes.length);
  const uploaded = await call(new URL(action.upload.href).pathname, 'PUT', bytes, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) });
  expect(uploaded.status, await uploaded.clone().text()).toBe(200);
  expect((await call(new URL(action.verify.href).pathname, 'POST', JSON.stringify({ oid, size: bytes.length }))).status).toBe(200);
  const download = await call(`/repos/r_lfs_a/lfs/objects/${oid}`, 'GET');
  expect(await download.text()).toBe(bytes);
  await verifyLfsPointers(env.DB, 'r_lfs_a', [{ oid, size: bytes.length }]);
  await expect(verifyLfsPointers(env.DB, 'r_lfs_b', [{ oid, size: bytes.length }])).rejects.toMatchObject({ code: 'lfs_object_missing' });
  expect((await call(`/repos/r_lfs_b/lfs/objects/${oid}`, 'GET')).status).toBe(404);
  const existing = await call('/repos/r_lfs_a/lfs/objects/batch', 'POST', JSON.stringify({ operation: 'upload', objects: [{ oid, size: bytes.length }] }));
  expect((await existing.json() as { objects: Array<{ actions?: unknown }> }).objects[0].actions).toBeUndefined();
  const quota = db.sqlite.prepare('SELECT used_bytes,reserved_bytes FROM git_lfs_quotas WHERE repo_id=?').get('r_lfs_a');
  expect(quota).toEqual({ used_bytes: bytes.length, reserved_bytes: 0 });
  const account = await admissionRequest<{ control: { revision: number; stored_bytes: string } }>(env, 'account:u_lfs', 'snapshot');
  expect(account.control.stored_bytes).toBe(String(bytes.length));
  await admissionRequest(env, 'account:u_lfs', 'limits', { revision: account.control.revision, max_concurrency: 1, max_storage_bytes: '15' });
  const crossRepo = await call('/repos/r_lfs_b/lfs/objects/batch', 'POST', JSON.stringify({ operation: 'upload', objects: [{ oid: await sha256('another'), size: 7 }] }));
  expect((await crossRepo.json() as { objects: Array<{ error: { code: number } }> }).objects[0].error.code).toBeGreaterThanOrEqual(400);
  expect((await admissionRequest<{ control: { stored_bytes: string; reserved_bytes: string } }>(env, 'account:u_lfs', 'snapshot')).control).toMatchObject({ stored_bytes: String(bytes.length), reserved_bytes: '0' });
  const over = await call('/repos/r_lfs_a/lfs/objects/batch', 'POST', JSON.stringify({ operation: 'upload', objects: [{ oid: await sha256('different 12'), size: 12 }] }));
  expect((await over.json() as { objects: Array<{ error: { code: number } }> }).objects[0].error.code).toBe(507);
  db.sqlite.prepare('UPDATE credentials SET revoked_at=? WHERE id=?').run(new Date().toISOString(), 'cred_lfs');
  expect((await call(`/repos/r_lfs_a/lfs/objects/${oid}`, 'GET')).status).toBe(404);
});

test('a checksum mismatch never makes an LFS object available or releases an uncertain upload reservation', async () => {
  const oid = await sha256('correct');
  const response = await call('/repos/r_lfs_a/lfs/objects/batch', 'POST', JSON.stringify({ operation: 'upload', objects: [{ oid, size: 7 }] }));
  const batch = await response.json() as { objects: Array<{ actions: { upload: { href: string } } }> };
  const uploaded = await call(new URL(batch.objects[0].actions.upload.href).pathname, 'PUT', 'invalid', { 'content-type': 'application/octet-stream', 'content-length': '7' });
  expect(uploaded.status).not.toBe(200);
  expect(db.sqlite.prepare('SELECT * FROM git_lfs_objects WHERE repo_id=? AND oid=?').get('r_lfs_a', oid)).toBeUndefined();
  expect(bucket.objects.size).toBe(0);
  expect((db.sqlite.prepare('SELECT reserved_bytes FROM git_lfs_quotas WHERE repo_id=?').get('r_lfs_a') as { reserved_bytes: number }).reserved_bytes).toBe(7);
});

test('lost LFS receipts reconcile only positive storage evidence and unused expiry uses verified billing deletion', async () => {
  const bytes = 'accepted';
  const oid = await sha256(bytes);
  const batch = await (await call('/repos/r_lfs_a/lfs/objects/batch', 'POST', JSON.stringify({ operation: 'upload', objects: [{ oid, size: bytes.length }] }))).json() as { objects: Array<{ actions: { upload: { href: string } } }> };
  const originalPut = bucket.put.bind(bucket);
  bucket.put = async (...args: Parameters<TestBucket['put']>) => { await originalPut(...args); throw new Error('Lost storage acknowledgment after acceptance'); };
  const upload = await call(new URL(batch.objects[0].actions.upload.href).pathname, 'PUT', bytes, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) });
  expect(upload.status).toBeGreaterThanOrEqual(500);
  expect((db.sqlite.prepare('SELECT state FROM git_lfs_uploads WHERE repo_id=? AND oid=?').get('r_lfs_a', oid) as { state: string }).state).toBe('uploading');
  bucket.put = originalPut;
  db.sqlite.prepare('UPDATE git_lfs_uploads SET expires_at=? WHERE repo_id=? AND oid=?').run('2000-01-01T00:00:00.000Z', 'r_lfs_a', oid);
  await sweepLfs(env);
  expect((db.sqlite.prepare('SELECT state FROM git_lfs_uploads WHERE repo_id=? AND oid=?').get('r_lfs_a', oid) as { state: string }).state).toBe('complete');
  expect(await (await call(`/repos/r_lfs_a/lfs/objects/${oid}`, 'GET')).text()).toBe(bytes);
  const never = await sha256('unused');
  await call('/repos/r_lfs_a/lfs/objects/batch', 'POST', JSON.stringify({ operation: 'upload', objects: [{ oid: never, size: 6 }] }));
  db.sqlite.prepare('UPDATE git_lfs_uploads SET expires_at=? WHERE repo_id=? AND oid=?').run('2000-01-01T00:00:00.000Z', 'r_lfs_a', never);
  await sweepLfs(env);
  expect((db.sqlite.prepare('SELECT state FROM git_lfs_uploads WHERE repo_id=? AND oid=?').get('r_lfs_a', never) as { state: string }).state).toBe('expired');
  const totals = await admissionRequest<{ control: { stored_bytes: string; reserved_bytes: string } }>(env, 'account:u_lfs', 'snapshot');
  expect(totals.control).toMatchObject({ stored_bytes: String(bytes.length), reserved_bytes: '0' });
});

test('denied LFS intents are tombstoned without fresh admission and one failed cleanup does not strand other uploads', async () => {
  const goodOid = await sha256('unused');
  const good = await call('/repos/r_lfs_a/lfs/objects/batch', 'POST', JSON.stringify({ operation: 'upload', objects: [{ oid: goodOid, size: 6 }] }));
  expect((await good.json() as { objects: Array<{ actions: unknown }> }).objects[0].actions).toBeDefined();
  const current = await admissionRequest<{ control: { revision: number } }>(env, 'account:u_lfs', 'snapshot');
  await admissionRequest(env, 'account:u_lfs', 'limits', { revision: current.control.revision, max_concurrency: 1, max_storage_bytes: '6' });
  const original = env.ADMISSION;
  const calls: string[] = [];
  let failedObject: string | undefined;
  let unavailable = true;
  env.ADMISSION = { idFromName: (name: string) => original.idFromName(name), get(id: DurableObjectId) {
    const stub = original.get(id);
    return { fetch: async (request: Request) => {
      const action = new URL(request.url).pathname.split('/').at(-1)!;
      calls.push(action);
      if (action === 'storage-cancel-intent') {
        const input = await request.clone().json() as { object_id: string };
        failedObject ??= input.object_id;
        if (unavailable && input.object_id === failedObject) return Response.json({ error: { code: 'test_cleanup_unavailable' } }, { status: 503 });
      }
      return stub.fetch(request);
    } };
  } } as unknown as DurableObjectNamespace;
  const deniedOid = await sha256('denied!');
  const denied = await call('/repos/r_lfs_a/lfs/objects/batch', 'POST', JSON.stringify({ operation: 'upload', objects: [{ oid: deniedOid, size: 7 }] }));
  expect((await denied.json() as { objects: Array<{ error: unknown }> }).objects[0].error).toBeDefined();
  const upload = db.sqlite.prepare('SELECT * FROM git_lfs_uploads WHERE oid=?').get(deniedOid) as unknown as LfsUpload;
  expect(upload.state).toBe('deleting');
  const reserveCalls = calls.filter(action => action === 'standalone-reserve').length;
  db.sqlite.prepare('UPDATE git_lfs_uploads SET expires_at=? WHERE oid=?').run('2000-01-01T00:00:00.000Z', deniedOid);
  db.sqlite.prepare('UPDATE git_lfs_uploads SET expires_at=? WHERE oid=?').run('2001-01-01T00:00:00.000Z', goodOid);
  await sweepLfs(env);
  expect(db.sqlite.prepare('SELECT state FROM git_lfs_uploads WHERE oid=?').get(goodOid)).toMatchObject({ state: 'expired' });
  expect(db.sqlite.prepare('SELECT state FROM git_lfs_uploads WHERE oid=?').get(deniedOid)).toMatchObject({ state: 'deleting' });
  expect(db.sqlite.prepare("SELECT reserved_bytes FROM git_lfs_quotas WHERE repo_id='r_lfs_a'").get()).toMatchObject({ reserved_bytes: 7 });
  unavailable = false;
  await sweepLfs(env);
  expect(db.sqlite.prepare('SELECT state FROM git_lfs_uploads WHERE oid=?').get(deniedOid)).toMatchObject({ state: 'expired' });
  expect(db.sqlite.prepare('SELECT state FROM object_manifests WHERE id=?').get(upload.object_id)).toMatchObject({ state: 'deleted' });
  expect(db.sqlite.prepare("SELECT reserved_bytes FROM git_lfs_quotas WHERE repo_id='r_lfs_a'").get()).toMatchObject({ reserved_bytes: 0 });
  expect(calls.filter(action => action === 'standalone-reserve')).toHaveLength(reserveCalls);
  const cleared = await admissionRequest<{ control: { revision: number; reserved_bytes: string } }>(env, 'account:u_lfs', 'snapshot');
  expect(cleared.control.reserved_bytes).toBe('0');
  await admissionRequest(env, 'account:u_lfs', 'limits', { revision: cleared.control.revision, max_concurrency: 1, max_storage_bytes: '20' });
  await expect(reserveStandaloneStorage(env, { account_id: upload.account_id, repo_id: upload.repo_id, actor_id: upload.actor_id,
    object_id: upload.object_id, key: upload.storage_key, bucket: 'blobs', maximum_bytes: String(upload.size), retention_until: null }))
    .rejects.toMatchObject({ code: 'storage_intent_cancelled' });
});

async function call(path: string, method: string, body?: BodyInit, headers: Record<string, string> = {}): Promise<Response> {
  return app.fetch(new Request(`http://lfs.test${path}`, { method, headers: { ...header, ...headers }, body }), env);
}

class BillingTestStorage {
  private values = new Map<string, unknown>();
  private tail: Promise<unknown> = Promise.resolve();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.values.get(key)) as T | undefined; }
  async put(key: string, value: unknown): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async list<T>(options: { prefix?: string; limit?: number; startAfter?: string } = {}): Promise<Map<string, T>> {
    return new Map([...this.values].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .filter(([key]) => key.startsWith(options.prefix ?? '') && key > (options.startAfter ?? '')).slice(0, options.limit ?? Infinity).map(([key, value]) => [key, structuredClone(value) as T]));
  }
  async transaction<T>(callback: (storage: BillingTestStorage) => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      const previous = structuredClone(this.values);
      try { return await callback(this); } catch (error) { this.values = previous; throw error; }
    });
    this.tail = next.catch(() => {}); return next;
  }
  async setAlarm(): Promise<void> {}
}
