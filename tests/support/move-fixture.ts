import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { vi } from 'vitest';
import { createApp } from '../../apps/api/src/index.ts';
import { identityAuthorityBindings, now, one, prepareCredential, signInternalRequest, stmt, verifyInternalRequest } from '../../packages/core/src/index.ts';
import type { Bindings, Principal } from '../../packages/core/src/index.ts';
import { AdmissionController } from '../../packages/billing/src/controller.ts';
import { commitStorageObject } from '../../packages/billing/src/execution.ts';
import { reserveStandaloneStorage } from '../../packages/billing/src/storage.ts';
import { sha256 } from '../../packages/core/src/crypto.ts';
import { GIT_NATIVE_SCOPE, ZERO_OID } from '../../packages/git/src/types.ts';
import type { GitStorageProvisionOptions, NativeSessionSpec } from '../../packages/git/src/types.ts';
import { GitError } from '../../packages/git/src/errors.ts';
import { startNativeServer } from '../../services/git/src/server.ts';
import { provisionFilesystemRepository, readFilesystemCreation } from '../../services/git/src/filesystem-store.ts';
import { RepositoryCoordinator } from '../../workers/git/src/coordinator.ts';
import gitGateway from '../../workers/git/src/gateway.ts';
import type { GitBindings } from '../../workers/git/src/types.ts';
import background from '../../workers/background/src/ops/handler.ts';
import type { OperationsBindings } from '../../packages/operations/src/types.ts';
import { createTestEnvironment } from './environment.ts';
import { TestBucket } from './storage.ts';

/** Provider storage adapter only. Admission, publication, routing and recovery run production code. */
class DurableStorage {
  private values = new Map<string, unknown>();
  private tail = Promise.resolve();
  private async serial<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.tail; let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; }); await previous;
    try { return await action(); } finally { release(); }
  }
  private view(values: Map<string, unknown>) {
    return { get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); }, delete: async (key: string) => values.delete(key),
      list: async <T>(options: { prefix?: string; startAfter?: string; limit?: number } = {}) => new Map([...values.entries()]
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).filter(([key]) => key.startsWith(options.prefix ?? '') && key > (options.startAfter ?? ''))
        .slice(0, options.limit ?? Infinity).map(([key, value]) => [key, structuredClone(value) as T])) };
  }
  get<T>(key: string) { return this.serial(() => this.view(this.values).get<T>(key)); }
  put(key: string, value: unknown) { return this.serial(() => this.view(this.values).put(key, value)); }
  delete(key: string) { return this.serial(() => this.view(this.values).delete(key)); }
  list<T>(options?: { prefix?: string; startAfter?: string; limit?: number }) { return this.serial(() => this.view(this.values).list<T>(options)); }
  transaction<T>(action: (tx: ReturnType<DurableStorage['view']>) => Promise<T>): Promise<T> {
    return this.serial(async () => { const copy = structuredClone(this.values); const result = await action(this.view(copy)); this.values = copy; return result; });
  }
  async setAlarm() {}
}

export async function moveFixture() {
  const source = await createTestEnvironment(), destination = await createTestEnvironment({ INTERNAL_SERVICE_KEY: source.env.INTERNAL_SERVICE_KEY });
  const directory = await mkdtemp('/private/var/folders/zh/l70grz9n3ll9j9c_f1ghp7gr0000gn/T/opencode/physical-move-');
  const command = promisify(execFile);
  const git = async (cwd: string, ...args: string[]) => (await command('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
    cwd, timeout: 60_000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  })).stdout.trim();
  const key = source.env.INTERNAL_SERVICE_KEY, at = now(), until = new Date(Date.now() + 60 * 86400_000).toISOString();
  const repoId = 'r_physical', accountId = 'u_physical', storageName = 'physical_source';
  await source.db.batch([
    stmt(source.env.DB, "INSERT INTO users(id,username,email,email_verified_at,created_at,updated_at) VALUES('u_physical','physical','physical@example.net',?,?,?)", at, at, at),
    stmt(source.env.DB, "INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES('u_physical','user','physical','Physical','u_physical',?,?)", at, at),
    stmt(source.env.DB, "INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES('u_physical','user','u_physical','u_physical','Physical','u_physical',?,?)", at, at),
    stmt(source.env.DB, `INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
      VALUES('r_physical','u_physical','physical','physical','private','active','local','core','physical_source','u_physical',?,?)`, at, at),
    stmt(source.env.DB, "INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,epoch,state,updated_at) VALUES('r_physical','repository','local','core',1,'active',?)", at),
    stmt(source.env.DB, `INSERT INTO billing_platform_pools(id,period_start,period_end,limit_units,safety_buffer_units,baseline_commitment_units,max_instances,state)
      VALUES('pool_physical',?,?,'1000000000000','0','0',10,'active')`, at, until),
    ...['local', 'remote'].map(cell => stmt(source.env.DB, `INSERT INTO billing_capacity_slices(id,pool_id,cell_id,limit_units,max_instances,max_storage_bytes,valid_until,state,created_at)
      VALUES(?,'pool_physical',?,'500000000000',5,'10000000000',?,'active',?)`, `slice_${cell}`, cell, until, at)),
  ]);
  const credential = await prepareCredential(source.env.DB, { principal_id: accountId, user_id: accountId, kind: 'personal', name: 'Physical move source',
    capabilities: ['*'], repository_ids: null, account_ids: null, auth_revision: 1, mfa: false, expires_at: until, created_by: accountId });
  await credential.statement.run();
  const actor: Principal = { id: accountId, kind: 'user', user_id: accountId, credential_id: credential.credential.id, capabilities: ['*'], repository_ids: null, account_ids: null, mfa: false };
  const sourceSnapshots = new TestBucket(), destinationSnapshots = new TestBucket();
  Object.assign(source.env, identityAuthorityBindings(source.env), { ENVIRONMENT: 'development', GIT_STORAGE_MODE: 'local', GIT_ORIGIN: 'https://git.gitknot.com',
    BILLING_PLATFORM_SLICE_ID: 'slice_local', BILLING_GIT_STORAGE_SLICE_ID: 'slice_local', BACKUP_BUCKET: sourceSnapshots.binding(),
    CELL_BINDINGS_JSON: '{"local":"API","remote":"DESTINATION_API"}', CELL_GIT_BINDINGS_JSON: '{"remote":"DESTINATION_GIT"}', CELL_BACKGROUND_BINDINGS_JSON: '{"remote":"DESTINATION_BACKGROUND"}' });
  Object.assign(destination.env, identityAuthorityBindings(source.env), { ENVIRONMENT: 'development', GIT_STORAGE_MODE: 'local', GIT_ORIGIN: 'https://git.gitknot.com',
    CELL_ID: 'remote', SHARD_ID: 'destination', SHARD_BINDINGS_JSON: '{"destination":"DB"}', DIRECTORY_DB: source.env.DB,
    BILLING_PLATFORM_SLICE_ID: 'slice_remote', BILLING_GIT_STORAGE_SLICE_ID: 'slice_remote', BACKUP_BUCKET: destinationSnapshots.binding(),
    CELL_BINDINGS_JSON: '{"remote":"API","local":"SOURCE_API"}', CELL_GIT_BINDINGS_JSON: '{"local":"SOURCE_GIT"}', CELL_BACKGROUND_BINDINGS_JSON: '{"local":"SOURCE_BACKGROUND"}' });
  const env = source.env as OperationsBindings & GitBindings, target = destination.env as OperationsBindings & GitBindings;
  const diagnostics: unknown[] = [];
  const app = createApp();
  const callApi = (bindings: Bindings) => ({ fetch: (request: Request) => app.fetch(request, bindings, source.context) }) as Fetcher;
  env.API = callApi(env); target.API = callApi(target); env.DESTINATION_API = target.API; target.SOURCE_API = env.API;
  const callBackground = (bindings: OperationsBindings) => ({ fetch: (request: Request) => background.fetch(request, bindings) }) as Fetcher;
  env.BACKGROUND = callBackground(env); target.BACKGROUND = callBackground(target); env.DESTINATION_BACKGROUND = target.BACKGROUND; target.SOURCE_BACKGROUND = env.BACKGROUND;
  env.GIT_SERVICE = { fetch: (request: Request) => gitGateway.fetch(request, env) } as Fetcher;
  target.GIT_SERVICE = { fetch: async (request: Request) => {
    const response = await gitGateway.fetch(request, target);
    if (!response.ok) diagnostics.push(`${new URL(request.url).pathname}: ${await response.clone().text()}`);
    return response;
  } } as Fetcher;
  env.DESTINATION_GIT = target.GIT_SERVICE; target.SOURCE_GIT = env.GIT_SERVICE;
  const admissionHomes = new Map<string, Set<string>>();
  for (const bindings of [env, target]) {
    const controllers = new Map<string, AdmissionController>(); admissionHomes.set(bindings.CELL_ID, new Set());
    bindings.ADMISSION = { idFromName: (name: string) => ({ toString: () => name }), get: (id: { toString(): string }) => {
      const name = id.toString(); let controller = controllers.get(name);
      if (!controller) {
        admissionHomes.get(bindings.CELL_ID)!.add(name);
        controller = new AdmissionController({ storage: new DurableStorage(), blockConcurrencyWhile: <T>(action: () => Promise<T>) => action() } as unknown as DurableObjectState, bindings);
        controllers.set(name, controller);
      }
      return { fetch: (request: Request) => controller!.fetch(request) };
    } } as unknown as DurableObjectNamespace;
    const repositories = new Map<string, RepositoryCoordinator>();
    bindings.REPO_COORDINATOR = { idFromName: (id: string) => id, get: (id: string) => {
      let coordinator = repositories.get(id);
      if (!coordinator) { coordinator = new RepositoryCoordinator({ storage: new DurableStorage() } as unknown as DurableObjectState, bindings); repositories.set(id, coordinator); }
      return coordinator;
    } } as unknown as DurableObjectNamespace;
  }
  const sourceStores = new Map<string, string>(), destinationStores = new Map<string, string>(), provisions = new Map<string, number>();
  const sourcePath = join(directory, 'source', `${storageName}.git`);
  await mkdir(join(directory, 'source'), { recursive: true }); await git(directory, 'init', '--bare', '--template=', '--initial-branch=main', sourcePath);
  sourceStores.set(storageName, sourcePath);
  const originalFetch = globalThis.fetch;
  const storeFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init), url = new URL(request.url);
    if (url.origin !== 'http://127.0.0.1:8792') return originalFetch(input, init);
    const local = new Request(`http://git-local.internal${url.pathname}`, request);
    await verifyInternalRequest(local, key, 'git-local-storage');
    const name = /^\/repositories\/([\w-]+)$/.exec(url.pathname)?.[1];
    if (!name) return new Response(null, { status: 404 });
    const stores = name === storageName ? sourceStores : destinationStores;
    const path = stores.get(name) ?? join(directory, 'destination', `${name}.git`);
    if (request.method === 'PUT') {
      provisions.set(name, (provisions.get(name) ?? 0) + 1);
      const data = await local.json() as { default_branch: string } & GitStorageProvisionOptions;
      await mkdir(join(directory, 'destination'), { recursive: true });
      try {
        const receipt = await provisionFilesystemRepository(path, data.default_branch, { create_only: data.create_only, ownership_marker: data.ownership_marker });
        stores.set(name, path);
        return Response.json(receipt);
      } catch (error) {
        if (error instanceof GitError && error.code === 'storage_namespace_exists' && (error.cause as { proof?: string } | undefined)?.proof === 'not_started') {
          return Response.json({ error: { code: error.code, proof: 'not_started' } }, { status: 409 });
        }
        throw error;
      }
    }
    if (request.method === 'DELETE') { await rm(path, { recursive: true, force: true }); stores.delete(name); }
    else {
      try { await stat(join(path, 'HEAD')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response(null, { status: 404 }); throw error; }
    }
    return Response.json({ remote: pathToFileURL(path).href, ...(request.method === 'GET' ? { creation: await readFilesystemCreation(path) } : {}) });
  });
  const callback = async <T>(spec: NativeSessionSpec, action: string, value: unknown): Promise<T> => {
    const response = await env.GIT_SERVICE.fetch(await signInternalRequest(new Request(`${spec.callback_url}/${action}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publisher_id: spec.publisher_id, fence: spec.fence, ...value as object }) }), key, GIT_NATIVE_SCOPE));
    const result = await response.json() as T & { error?: { code: string; message: string } };
    if (!response.ok) throw new GitError(result.error?.code ?? 'callback_failed', result.error?.message ?? 'Native callback failed', response.status);
    return result;
  };
  const native = await startNativeServer({ configuration: { mode: 'test', cache_root: join(directory, 'cache'), local_authority_root: directory,
    max_sessions: 8, callback_origin: 'https://git.gitknot.com' }, authenticate: request => verifyInternalRequest(request, key, GIT_NATIVE_SCOPE),
    callbacks: { validated: (spec, evidence) => callback(spec, 'validated', { evidence }), permit: (spec, evidence) => callback(spec, 'permit', { evidence_digest: evidence.digest }),
      result: (spec, result) => callback(spec, 'result', { result }), rejected: (spec, reason, code) => callback(spec, 'rejected', { reason, code }) },
    on_error: error => { diagnostics.push(error); } }, 0, '127.0.0.1');
  for (const bindings of [env, target]) bindings.GIT_CONTAINERS = { idFromName: (id: string) => id, get: () => ({ fetch: (request: Request) => native.service.fetch(request) }) } as unknown as DurableObjectNamespace;
  vi.stubGlobal('FixedLengthStream', class extends TransformStream<Uint8Array, Uint8Array> {
    constructor(expected: number) { let size = 0; super({ transform(value, output) { size += value.byteLength; if (size > expected) throw new Error('Fixed length exceeded'); output.enqueue(value); },
      flush() { if (size !== expected) throw new Error('Fixed length mismatch'); } }); }
  });
  const internalGit = async (action: string, value: unknown) => {
    const response = await env.GIT_SERVICE.fetch(await signInternalRequest(new Request(`https://internal.gitknot.com/internal/git/repositories/${repoId}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
    }), key, 'git-service'));
    if (!response.ok) throw new Error(`Native ${action}: ${await response.text()}; ${diagnostics.map(String).join('\n')}`);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const fundObject = async (id: string, bucket: 'blobs' | 'backups' | 'snapshots', objectKey: string, content: string) => {
    const reservation = await reserveStandaloneStorage(env, { account_id: accountId, repo_id: repoId, actor_id: accountId, object_id: id,
      key: objectKey, bucket, maximum_bytes: String(Buffer.byteLength(content)), retention_until: null });
    const sha = await sha256(content), storage = bucket === 'blobs' ? source.blobs : bucket === 'backups' ? source.backups : sourceSnapshots;
    const stored = await storage.put(objectKey, content, { sha256: sha, customMetadata: { object_id: id, repo_id: repoId, sha256: sha, immutable_source: 'retained' },
      httpMetadata: { contentType: 'application/octet-stream', cacheControl: 'private, max-age=0' } });
    await commitStorageObject(env, { account_id: accountId, object_id: id, reservation_id: reservation.reservation_id, fence: reservation.fence,
      bytes: String(Buffer.byteLength(content)), etag: stored!.etag, checksum: sha });
    return { id, key: objectKey, sha256: sha, bytes: Buffer.byteLength(content), content };
  };
  return { env, target, source, destination, sourceSnapshots, destinationSnapshots, sourceStores, destinationStores, admissionHomes, repoId, accountId, actor,
    storageName, git, internalGit, fundObject, diagnostics, provisions, token: credential.token,
    async initializeGit() {
      await internalGit('mutate', { operation_id: 'gop_physical_seed', actor, mutation: { kind: 'edit', ref: 'refs/heads/main', expected_oid: ZERO_OID, message: 'Physical move source',
        author: { name: 'Physical fixture', email: 'physical@example.net' }, edits: [{ path: 'README.md', content_base64: Buffer.from('Actual native graph across cells\n').toString('base64') }] } });
      return git(sourcePath, 'rev-parse', 'refs/heads/main');
    },
    async close() { await native.close(); storeFetch.mockRestore(); vi.unstubAllGlobals(); source.close(); destination.close(); await rm(directory, { recursive: true, force: true }); },
  };
}
