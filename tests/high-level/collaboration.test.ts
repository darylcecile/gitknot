import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authenticate, base64url, errorResponse, handleRoutingRpc, identityAuthorityBindings, identityContext, makeEvent, now, one, prepareCredential, requestContext, routeResourceRequest,
  sha256, signInternalRequest, stmt, verifyInternalRequest, withAccountAuthorityBarrier,
} from '@gitknot/core';
import type { App, AppEnv, Bindings, EventRecord, Principal, Repository } from '@gitknot/core';
import { inboxDeliveryUserStateGuards, readInboxForDelivery, registerCollaborationRoutes, runCollaborationOperation, sweepCollaboration } from '../../apps/api/src/modules/collaboration.ts';
import type { NativePatch } from '../../apps/api/src/modules/collaboration/native.ts';
import { indexEvent, runCodeScan } from '../../packages/operations/src/search.ts';
import type { Operation, OperationsBindings } from '../../packages/operations/src/types.ts';
import { createTestEnvironment, type TestEnvironment } from '../support/environment.ts';
import { createTestDatabase, SqliteD1 } from '../support/database.ts';
import { AdmissionController } from '../../packages/billing/src/controller.ts';
import { admissionRequest } from '../../packages/billing/src/transport.ts';
import type { AdmissionControl } from '../../packages/billing/src/types.ts';
import { NativeGit } from '../../services/git/src/process.ts';
import { inspectCollaboration } from '../../services/git/src/inspection.ts';
import { DEFAULT_GIT_LIMITS } from '../../packages/git/src/types.ts';
import { preparePatch } from '../../apps/api/src/modules/collaboration/patches.ts';
import { backgroundContext } from '../../apps/api/src/modules/collaboration/operation-runtime.ts';
import type { Item } from '../../apps/api/src/modules/collaboration/common.ts';
import { advanceRun, cancelRun, createRun } from '../../packages/execution/src/control-plane.ts';
import { definitionDigest, planRun, validatedDefinition } from '../../packages/execution/src/planning.ts';
import type { PlanRunInput, WorkflowRecord, WorkflowVersion } from '../../packages/execution/src/planning.ts';
import type { AttemptRecord, ExecutionPlan } from '../../packages/execution/src/types.ts';
import { AttemptMachine } from '../../packages/execution/src/attempt-machine.ts';
import { verifyManifest } from '@gitknot/workflows';
import type { GitRule } from '@gitknot/git';
import type { NativeSessionSpec, PublicationPermit } from '../../packages/git/src/types.ts';
import { startNativeServer } from '../../services/git/src/server.ts';
import gitGateway from '../../workers/git/src/gateway.ts';
import { RepositoryCoordinator } from '../../workers/git/src/coordinator.ts';
import type { GitBindings } from '../../workers/git/src/types.ts';
import { LocalGitStore } from '../../infra/local/git-store.ts';
import { reviewRefs } from '../../packages/git/src/protocol.ts';
import { acquireMetadataFence, releaseMetadataFence } from '../../packages/operations/src/metadata-fence.ts';
import type { MetadataFenceReceipt } from '../../packages/operations/src/metadata-fence.ts';
import type { ReferenceRequest, WindowResponse } from '../../apps/api/src/modules/collaboration/global-read-schema.ts';
import { prepareManagedUser } from '../../packages/federation/src/identity.ts';
import { providerConfigSchema } from '../../packages/federation/src/config.ts';
import { FEDERATION_IDENTITY_CONTRACT } from '../../packages/federation/src/types.ts';
import { runShardMove } from '../../packages/operations/src/movement.ts';
import { submitShardMove } from '../../packages/operations/src/move-request.ts';
import type { Request as MiniflareRequest, Response as MiniflareResponse } from 'miniflare';

type Resource = { id: string; revision: number; [key: string]: unknown };
type Listing<T = Resource> = { items: T[]; next_cursor: string | null; coverage?: Record<string, unknown> };
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const REBASE = 'c'.repeat(40);
const CHANGED = 'd'.repeat(40);
const CANDIDATE = 'e'.repeat(40);
const SUGGESTED = '1'.repeat(40);

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Node-hosted durable-storage adapter; the production account/slice controllers and billing book execute unchanged. */
class TransactionalStorage {
  private values = new Map<string, unknown>();
  private tail: Promise<void> = Promise.resolve();
  private async serial<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    const next = deferred();
    this.tail = next.promise;
    await previous;
    try { return await callback(); } finally { next.resolve(); }
  }
  private view(values: Map<string, unknown>) {
    return {
      get: async <T>(key: string): Promise<T | undefined> => structuredClone(values.get(key)) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
      delete: async (key: string) => values.delete(key),
      list: async <T>(options: { prefix?: string; startAfter?: string; limit?: number } = {}): Promise<Map<string, T>> => new Map(
        [...values.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
          .filter(([key]) => key.startsWith(options.prefix ?? '') && key > (options.startAfter ?? ''))
          .slice(0, options.limit ?? Infinity).map(([key, value]) => [key, structuredClone(value) as T]),
      ),
    };
  }
  get<T>(key: string): Promise<T | undefined> { return this.serial(() => this.view(this.values).get<T>(key)); }
  put(key: string, value: unknown): Promise<void> { return this.serial(() => this.view(this.values).put(key, value)); }
  delete(key: string): Promise<boolean> { return this.serial(() => this.view(this.values).delete(key)); }
  list<T>(options?: { prefix?: string; startAfter?: string; limit?: number }): Promise<Map<string, T>> { return this.serial(() => this.view(this.values).list<T>(options)); }
  async transaction<T>(callback: (transaction: unknown) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const next = structuredClone(this.values);
      const result = await callback(this.view(next));
      this.values = next;
      return result;
    });
  }
  async setAlarm(): Promise<void> {}
  async deleteAlarm(): Promise<void> {}
}

function billingNamespace(env: Bindings): DurableObjectNamespace {
  const controllers = new Map<string, AdmissionController>();
  return {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (id: { toString(): string }) => {
      const name = id.toString();
      let controller = controllers.get(name);
      if (!controller) {
        const context = { storage: new TransactionalStorage(), blockConcurrencyWhile: <T>(callback: () => Promise<T>) => callback() } as unknown as DurableObjectState;
        controller = new AdmissionController(context, env);
        controllers.set(name, controller);
      }
      return { fetch: (request: Request) => controller!.fetch(request) };
    },
  } as unknown as DurableObjectNamespace;
}

/** Explicit native-service contract fixture. Native Git graph/protocol behavior is tested by the Git service's real-Git journeys. */
class GitServiceFixture {
  readonly heads = new Map<string, string>();
  readonly calls: string[] = [];
  readonly receipts = new Map<string, Record<string, unknown>>();
  readonly nativeRepositories = new Map<string, NativeGit>();
  publish = false;
  constructor(readonly fixture: TestEnvironment) {}

  binding(): Fetcher { return { fetch: (request: Request) => this.fetch(request) } as unknown as Fetcher; }

  async fetch(request: Request): Promise<Response> {
    await verifyInternalRequest(request, this.fixture.env.INTERNAL_SERVICE_KEY, 'git-service');
    const match = /\/repositories\/([^/]+)\/(.+)$/.exec(new URL(request.url).pathname)!;
    const repoId = match[1]!;
    const action = match[2]!;
    this.calls.push(action);
    if (action.startsWith('operations/')) {
      const id = action.slice('operations/'.length);
      const receipt = this.receipts.get(id);
      if (!receipt) return Response.json({ error: { code: 'not_found' } }, { status: 404 });
      if (receipt.state === 'uncertain' && this.publish) {
        receipt.state = 'committed'; receipt.finalized = true;
        (receipt.result as { outcome: string }).outcome = 'committed';
        const ref = (receipt.result as { refs: { ref: string; new_oid: string }[] }).refs[0]!;
        this.heads.set(`${repoId}:${ref.ref}`, ref.new_oid);
      }
      return Response.json(receipt);
    }
    const body = await request.json() as { operation_id?: string; candidate_id?: string; actor: Principal; inspection?: Record<string, unknown>; mutation?: Record<string, unknown> };
    if (action === 'collaboration/inspect') {
      const inspection = body.inspection!;
      const native = this.nativeRepositories.get(repoId);
      if (native) {
        const candidate = body.candidate_id ? await one<{ internal_ref: string }>(this.fixture.env.DB,
          'SELECT internal_ref FROM git_candidates WHERE repo_id=? AND id=?', repoId, body.candidate_id) : null;
        return inspectCollaboration(native, repoId, { inspection, ...(candidate ? { retained_refs: [candidate.internal_ref] } : {}) });
      }
      if (inspection.kind === 'resolve') return Response.json({ repo_id: repoId,
        commit_oid: /^[a-f0-9]{40}$/.test(String(inspection.ref)) ? inspection.ref : this.heads.get(`${repoId}:${inspection.ref}`) ?? BASE });
      if (inspection.kind === 'patch') {
        const head = String(inspection.head_oid);
        const files = await Promise.all(['alpha.ts', 'beta.ts'].map(async path => ({ path, old_path: null, change_kind: 'modified' as const,
          old_oid: BASE, new_oid: head, patch_fingerprint: await sha256(path === 'beta.ts' && head === CHANGED ? 'beta changed' : path === 'alpha.ts' && head === SUGGESTED ? 'alpha suggested' : path),
          old_lines: 4, new_lines: 4, binary: false, hunks: [{ old_start: 1, old_lines: 4, new_start: 1, new_lines: 4 }] })));
        const patch: NativePatch = { version: 1, fingerprint_algorithm: 'git-patch-id-verbatim-v1', repo_id: repoId, head_repo_id: String(inspection.head_repo_id),
          base_oid: String(inspection.base_oid), head_oid: head, merge_base_oid: String(inspection.base_oid),
          patch_fingerprint: await sha256(JSON.stringify(files.map(file => [file.path, file.patch_fingerprint]))),
          native_evidence_id: `native_${head}`, complete: true, files };
        return Response.json(patch);
      }
      if (inspection.kind === 'scan') {
        const second = inspection.cursor === 'page_2';
        return Response.json({ version: 1, repo_id: repoId, commit_oid: inspection.commit_oid,
          matches: [{ path: second ? 'beta.ts' : 'alpha.ts', line: 1, column: 1, preview: 'needle', preview_truncated: false, blob_oid: HEAD }],
          scanned_files: second ? 2 : 1, total_files: 2, excluded_files: 0, exclusions: [],
          next_cursor: second ? null : 'page_2', enumeration_complete: true });
      }
      if (inspection.kind === 'suggestion') return Response.json({ repo_id: repoId, head_oid: inspection.head_oid,
        edit: { path: inspection.path, content_base64: Buffer.from('replacement\n').toString('base64'), mode: '100644' } });
      return Response.json({ error: { code: 'unsupported_test_inspection' } }, { status: 422 });
    }
    if (action === 'mutate') {
      const mutation = body.mutation!;
      const candidate = mutation.candidate as { id: string; source_repo_id: string; source_oid: string; target_ref: string; target_oid: string; strategy: string; pull_request_id: string } | undefined;
      const id = body.operation_id!;
      const isCandidate = mutation.kind === 'candidate';
      const state = mutation.kind !== 'merge' || this.publish ? 'committed' : 'uncertain';
      const ref = isCandidate ? { ref: `refs/gitknot/candidates/${candidate!.id}`, old_oid: '0'.repeat(40), new_oid: CANDIDATE }
        : mutation.kind === 'edit' ? { ref: String(mutation.ref), old_oid: String(mutation.expected_oid), new_oid: SUGGESTED }
          : { ref: candidate!.target_ref, old_oid: candidate!.target_oid, new_oid: String(mutation.candidate_oid) };
      if (isCandidate) {
        await stmt(this.fixture.env.DB, `INSERT INTO git_candidates(repo_id,id,source_repo_id,pull_request_id,source_oid,target_ref,target_oid,candidate_oid,internal_ref,
          strategy,policy_revision,actor_id,state,operation_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?,'ready',?,?,?)`,
        repoId, candidate!.id, candidate!.source_repo_id, candidate!.pull_request_id, candidate!.source_oid, candidate!.target_ref,
        candidate!.target_oid, CANDIDATE, ref.ref, candidate!.strategy, body.actor.id, id, now(), now()).run();
      }
      await stmt(this.fixture.env.DB, `INSERT INTO git_publications(repo_id,id,actor_id,actor_json,kind,state,routing_epoch,policy_revision,publisher_id,created_at,updated_at)
        VALUES (?,?,?,?,?,?,1,1,'test-publisher',?,?)`, repoId, id, body.actor.id, JSON.stringify(body.actor), String(mutation.kind), state, now(), now()).run();
      const receipt = { id, state, finalized: state === 'committed', result: { operation_id: id, outcome: state === 'committed' ? 'committed' : 'uncertain',
        refs: [ref], marker_oid: 'f'.repeat(40), report_status: [{ ref: ref.ref, status: 'ok' }] } };
      this.receipts.set(id, receipt);
      if (state === 'committed' && !isCandidate) this.heads.set(`${repoId}:${ref.ref}`, ref.new_oid);
      return Response.json(receipt);
    }
    return Response.json({ error: { code: 'unsupported_test_service_operation' } }, { status: 503 });
  }
}

/** Full API + Git gateway + coordinator + billing, with native Git and callbacks over HTTP. */
async function nativeHttpFixture(fixture: TestEnvironment, root: string, canonical: string, storageName = 'r_main') {
  const api = (await import('../../apps/api/src/index.ts')).createApp();
  const env = fixture.env as GitBindings;
  const controls: { afterRetention?: () => Promise<void>; dropPullResponse: boolean } = { dropPullResponse: false };
  const diagnostics: unknown[] = [];
  const inspections: string[] = [];
  let origin = '';
  let native: Awaited<ReturnType<typeof startNativeServer>> | undefined;
  const server = createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else for (const part of value ?? []) headers.append(name, part);
      }
      const method = incoming.method ?? 'GET', path = incoming.url ?? '/';
      const body = ['GET', 'HEAD'].includes(method) ? undefined : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      // Service bindings preserve their signed logical authority across the local HTTP transport.
      const authority = headers.get('x-gitknot-internal-scope') === 'git-service' ? 'https://internal.gitknot.com' : origin;
      const request = new Request(new URL(path, authority), { method, headers, body, ...(body ? { duplex: 'half' } : {}) } as RequestInit);
      const inspection = path.endsWith('/collaboration/inspect') ? await request.clone().json() as { retain?: boolean; inspection?: { kind?: string } } : null;
      if (inspection?.inspection?.kind) inspections.push(inspection.inspection.kind);
      const response = path.startsWith('/v1/') ? await api.fetch(request, env, fixture.context) : await gitGateway.fetch(request, env, fixture.context);
      if (response.ok && inspection?.inspection?.kind === 'patch' && inspection.retain !== false && controls.afterRetention) {
        const after = controls.afterRetention; controls.afterRetention = undefined; await after();
      }
      if (controls.dropPullResponse && method === 'POST' && path === '/v1/repos/r_main/pulls' && response.status === 201) {
        controls.dropPullResponse = false; await response.body?.cancel(); outgoing.destroy(); return;
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body as never), outgoing); else outgoing.end();
    } catch (error) {
      diagnostics.push(error);
      if (outgoing.headersSent) outgoing.destroy();
      else outgoing.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'local_http_failure', message: String(error) } }));
    }
  });
  const localStore = vi.spyOn(LocalGitStore.prototype, 'remote').mockImplementation(async name => {
    if (name !== storageName) throw new Error('Unexpected local Git storage identity.');
    return pathToFileURL(canonical).href;
  });
  async function close() {
    await native?.close();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    localStore.mockRestore();
  }
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    env.ENVIRONMENT = 'development'; env.GIT_STORAGE_MODE = 'local'; env.GIT_ORIGIN = origin; env.API_ORIGIN = origin;
    const coordinators = new Map<string, RepositoryCoordinator>();
    env.REPO_COORDINATOR = {
      idFromName: (name: string) => ({ toString: () => name }),
      get: (id: { toString(): string }) => {
        let coordinator = coordinators.get(id.toString());
        if (!coordinator) {
          coordinator = new RepositoryCoordinator({ storage: new TransactionalStorage() } as unknown as DurableObjectState, env);
          coordinators.set(id.toString(), coordinator);
        }
        return coordinator;
      },
    } as unknown as DurableObjectNamespace;
    env.GIT_SERVICE = { fetch: (request: Request) => {
      const url = new URL(request.url);
      return fetch(new Request(new URL(url.pathname + url.search, origin), request));
    } } as unknown as Fetcher;
    async function callback<T>(spec: NativeSessionSpec, action: string, payload: object): Promise<T> {
      const request = new Request(`${spec.callback_url}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publisher_id: spec.publisher_id, fence: spec.fence, ...payload }) });
      const response = await fetch(await signInternalRequest(request, env.INTERNAL_SERVICE_KEY, 'git-native'));
      const value = await response.json() as T;
      if (!response.ok) throw new Error(`Native callback rejected: ${response.status} ${JSON.stringify(value)}`);
      return value;
    }
    native = await startNativeServer({
      configuration: { mode: 'test', cache_root: join(root, 'native-cache'), local_authority_root: root, max_sessions: 8, callback_origin: origin },
      authenticate: request => {
        const copy = request.clone(), url = new URL(copy.url);
        const canonical = new Request(new URL(url.pathname + url.search, 'http://git-native.internal'), {
          method: copy.method, headers: copy.headers, body: copy.body, ...(copy.body ? { duplex: 'half' } : {}),
        } as RequestInit);
        return verifyInternalRequest(canonical, env.INTERNAL_SERVICE_KEY, 'git-native');
      },
      callbacks: {
        async validated(spec, evidence) { await callback(spec, 'validated', { evidence }); },
        permit: (spec, evidence) => callback<PublicationPermit>(spec, 'permit', { evidence_digest: evidence.digest }),
        async result(spec, result) { await callback(spec, 'result', { result }); },
        async rejected(spec, reason, code) { await callback(spec, 'rejected', { reason, code }); },
      },
      on_error: error => { diagnostics.push(error); },
    }, 0, '127.0.0.1');
    env.GIT_CONTAINERS = { idFromName: (id: string) => id, get: () => ({ fetch: (request: Request) => {
      const url = new URL(request.url);
      return fetch(new Request(new URL(url.pathname + url.search, native!.origin), request));
    } }) } as unknown as DurableObjectNamespace;
    return { origin, controls, diagnostics, inspections, close };
  } catch (error) { await close(); throw error; }
}

async function copyWorkerdDatabase(target: D1Database, source: SqliteD1, searchOnly = false): Promise<void> {
  const schema = source.sqlite.prepare(`SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
    ${searchOnly ? "AND name NOT GLOB 'search_fts_*'" : ''} ORDER BY rowid`).all() as Array<{ sql: string }>;
  for (let index = 0; index < schema.length; index += 40) await target.batch(schema.slice(index, index + 40).map(row => target.prepare(row.sql)));
  if (searchOnly) return;
  const tables = source.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as Array<{ name: string }>;
  const seed = [target.prepare('PRAGMA defer_foreign_keys=ON')];
  for (const { name } of tables) for (const row of source.sqlite.prepare(`SELECT * FROM ${name}`).all()) {
    const columns = Object.keys(row);
    seed.push(stmt(target, `INSERT INTO ${name}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...Object.values(row)));
  }
  await target.batch(seed);
}

describe('collaboration HTTP and durable workflows', () => {
  let fixture: TestEnvironment;
  let search: SqliteD1;
  let app: App;
  let git: GitServiceFixture;
  const tokens = new Map<string, string>();

  beforeEach(async () => {
    fixture = await createTestEnvironment();
    fixture.env.IDENTITY_KEYS_JSON = JSON.stringify({ current: 'test', keys: { test: base64url(crypto.getRandomValues(new Uint8Array(32))) } });
    search = new SqliteD1();
    search.sqlite.exec(await readFile(new URL('../../ops/search/001_projection.sql', import.meta.url), 'utf8'));
    fixture.env.SEARCH_DB = search.binding();
    git = new GitServiceFixture(fixture);
    fixture.env.GIT_SERVICE = git.binding();
    tokens.clear();
    const at = now();
    for (const name of ['alice', 'bob', 'carol', 'eve']) {
      const id = `u_${name}`;
      fixture.db.sqlite.prepare('INSERT INTO users(id,username,email,display_name,password_hash,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, name, `${name}@example.test`, name, 'test-fixture-no-password-login', at, at, at);
      fixture.db.sqlite.prepare("INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES (?,'user',?,?,?,?,?)")
        .run(id, name, name, id, at, at);
      fixture.db.sqlite.prepare("INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES (?,'user',?,?,?,?,?,?)")
        .run(id, id, id, name, id, at, at);
      const credential = await prepareCredential(fixture.env.DB, { principal_id: id, user_id: id, kind: 'personal', name: 'High-level test client',
        capabilities: ['*'], repository_ids: null, account_ids: null, auth_revision: 1, mfa: true,
        expires_at: new Date(Date.now() + 86400_000).toISOString(), created_by: id });
      await credential.statement.run(); tokens.set(name, credential.token);
    }
    for (const [id, visibility, owner] of [['r_main', 'private', 'alice'], ['r_second', 'private', 'alice'], ['r_public', 'public', 'alice'], ['r_secret', 'private', 'alice'], ['r_eve', 'private', 'eve']]) {
      fixture.db.sqlite.prepare(`INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,'active','local','core',?,?,?,?)`).run(id!, `u_${owner}`, id!, id!, visibility!, id!, `u_${owner}`, at, at);
      git.heads.set(`${id}:refs/heads/main`, BASE); git.heads.set(`${id}:refs/heads/feature`, HEAD);
    }
    for (const name of ['bob', 'carol']) for (const repoId of ['r_main', 'r_public', 'r_secret']) {
      fixture.db.sqlite.prepare(`INSERT INTO access_grants(id,account_id,repo_id,principal_type,principal_id,role_id,effect,created_by,created_at,updated_at)
        VALUES (?,'u_alice',?,'user',?,'maintainer','allow','u_alice',?,?)`).run(`grant_${name}_${repoId}`, repoId, `u_${name}`, at, at);
    }
    const until = new Date(Date.now() + 30 * 86400_000).toISOString();
    fixture.db.sqlite.prepare(`INSERT INTO billing_platform_pools(id,period_start,period_end,limit_units,safety_buffer_units,baseline_commitment_units,max_instances,state)
      VALUES ('pool_collaboration',?,?,'1000000000000','0','0',10,'active')`).run(at, until);
    fixture.db.sqlite.prepare(`INSERT INTO billing_capacity_slices(id,pool_id,cell_id,limit_units,max_instances,max_storage_bytes,valid_until,state,created_at)
      VALUES ('slice_collaboration','pool_collaboration','local','1000000000000',10,'10000000000',?,'active',?)`).run(until, at);
    fixture.env.BILLING_PLATFORM_SLICE_ID = 'slice_collaboration';
    fixture.env.ADMISSION = billingNamespace(fixture.env);
    app = new Hono<AppEnv>();
    app.onError(errorResponse);
    app.use('*', requestContext);
    app.use('*', async (c, next) => { const forwarded = await routeResourceRequest(c); if (forwarded) return forwarded; await next(); });
    app.use('*', identityContext);
    registerCollaborationRoutes(app);
  });
  afterEach(() => { fixture.close(); search.close(); });

  async function request(method: string, path: string, body?: unknown, options: { actor?: string | null; revision?: number; key?: string; headers?: Record<string, string>; env?: Bindings } = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    if (options.actor !== null) headers.set('authorization', `Bearer ${tokens.get(options.actor ?? 'alice')!}`);
    if (options.revision !== undefined) headers.set('if-match', `"${options.revision}"`);
    if (options.key) headers.set('idempotency-key', options.key);
    if (body !== undefined) headers.set('content-type', 'application/json');
    return app.fetch(new Request(`http://localhost:8787${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), options.env ?? fixture.env, fixture.context);
  }
  async function json<T = Resource>(response: Response, status = 200): Promise<T> {
    const value = await response.json();
    expect(response.status, JSON.stringify(value)).toBe(status);
    return value as T;
  }
  async function get(id: string, collection = 'issues', repoId = 'r_main'): Promise<Resource> {
    return json(await request('GET', `/v1/repos/${repoId}/${collection}/${id}`));
  }
  async function createIssue(title = 'A tracked change', fields: object = {}, repoId = 'r_main'): Promise<Resource> {
    return json(await request('POST', `/v1/repos/${repoId}/issues`, { title, markdown: 'Canonical **Markdown**.', ...fields }), 201);
  }
  function operationsEnv(): OperationsBindings { return fixture.env as OperationsBindings; }
  async function accountStorage(): Promise<AdmissionControl> {
    return (await admissionRequest<{ control: AdmissionControl }>(fixture.env, 'account:u_alice', 'snapshot')).control;
  }
  function upload(path: string, bytes: Uint8Array<ArrayBuffer>, revision: number): Promise<Response> {
    return Promise.resolve(app.fetch(new Request(`http://localhost:8787${path}/content`, { method: 'PUT',
      headers: { authorization: `Bearer ${tokens.get('alice')}`, 'if-match': `"${revision}"`, 'content-type': 'application/octet-stream' }, body: bytes,
    }), fixture.env, fixture.context));
  }
  async function candidateRecord(pullId: string, id: string, target: string, head: string, candidate: string): Promise<void> {
    await git.nativeRepositories.get('r_main')?.run(['update-ref', `refs/gitknot/candidates/${id}`, candidate]);
    await stmt(fixture.env.DB, `INSERT INTO git_candidates(repo_id,id,source_repo_id,pull_request_id,source_oid,target_ref,target_oid,candidate_oid,internal_ref,
      strategy,policy_revision,actor_id,state,operation_id,created_at,updated_at) VALUES ('r_main',?,'r_main',?,?,'refs/heads/main',?,?,?,'merge',1,'u_alice','ready',?,?,?)`,
    id, pullId, head, target, candidate, `refs/gitknot/candidates/${id}`, `op_${id}`, now(), now()).run();
  }

  it('preserves Markdown, immutable history, typed templates, atomic concurrent edits, and scoped references', async () => {
    const label = await json(await request('POST', '/v1/repos/r_main/labels', { name: 'bug', color: 'AB12EF' }), 201);
    const status = await json(await request('POST', '/v1/repos/r_main/issues/statuses', { name: 'Investigating', type: 'in_progress' }), 201);
    const template = await json(await request('POST', '/v1/repos/r_main/issues/templates', {
      name: 'Bug report', title: 'Report', markdown: '```mermaid\ngraph TD; A-->B\n```\n\n<custom-block data-x="1">keep me</custom-block>\n',
      enabled: false, status_id: status.id, label_ids: [label.id],
    }), 201);
    const editedTemplate = await json(await request('PATCH', `/v1/repos/r_main/issues/templates/${template.id}`, { description: 'Only the description changes' }, { revision: 1 }));
    expect(editedTemplate.enabled).toBe(0);
    await json(await request('PATCH', `/v1/repos/r_main/issues/templates/${template.id}`, { enabled: true }, { revision: 2 }));
    const issue = await json(await request('POST', '/v1/repos/r_main/issues', { template_id: template.id }, { key: 'template-issue' }), 201);
    expect(issue.markdown).toBe(template.markdown);
    expect(issue.status_id).toBe(status.id);
    const replay = await request('POST', '/v1/repos/r_main/issues', { template_id: template.id }, { key: 'template-issue' });
    const replayBody = await replay.json() as Resource;
    expect.soft(replay.status, JSON.stringify(replayBody)).toBe(201);
    expect.soft(replay.headers.get('idempotency-replayed')).toBe('true');
    expect.soft(replayBody.id).toBe(issue.id);
    const changes = await Promise.all([
      request('PATCH', `/v1/repos/r_main/issues/${issue.id}`, { markdown: 'First concurrent save' }, { revision: 1 }),
      request('PATCH', `/v1/repos/r_main/issues/${issue.id}`, { markdown: 'Second concurrent save' }, { revision: 1 }),
    ]);
    expect(changes.map(value => value.status).sort()).toEqual([200, 412]);
    const versions = await json<Listing>(await request('GET', `/v1/repos/r_main/issues/${issue.id}/versions`));
    expect(versions.items).toHaveLength(2);
    expect(fixture.db.sqlite.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type='issue.updated' AND resource_id=?").get(issue.id)?.n).toBe(1);
    expect(fixture.db.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='issue.updated' AND resource_id=?").get(issue.id)?.n).toBe(1);
    const restored = await json(await request('POST', `/v1/repos/r_main/issues/${issue.id}/restore`, { document_revision: 1 }, { revision: 2 }));
    expect(restored.markdown).toBe(template.markdown);
    expect(() => fixture.db.sqlite.prepare('UPDATE collaboration_document_versions SET markdown=? WHERE resource_id=?').run('overwrite', issue.id)).toThrow(/immutable/);
    const foreignLabel = await json(await request('POST', '/v1/repos/r_second/labels', { name: 'other repository', color: '000000' }), 201);
    await json(await request('PUT', `/v1/repos/r_main/issues/${issue.id}/labels`, { label_ids: [foreignLabel.id] }, { revision: 3 }), 404);
    expect((await get(issue.id)).revision).toBe(3);
    await json(await request('PATCH', `/v1/repos/r_main/issues/${issue.id}`, { title: 'Missing precondition' }), 428);
  });

  it('keeps assignment decisions separate from reading, snoozes/mutes, and reauthorizes feed, inbox, search and attachments after revocation', async () => {
    const issue = await createIssue('needle private issue', { assignee_ids: ['u_bob'], markdown: 'A private needle for @bob.' });
    const inbox = await json<Listing>(await request('GET', '/v1/inbox', undefined, { actor: 'bob' }));
    const assignment = inbox.items.find(item => item.reason === 'assignment')!;
    expect(assignment).toBeDefined();
    const read = await json(await request('PATCH', `/v1/inbox/${assignment.id}`, { read: true }, { actor: 'bob', revision: assignment.revision }));
    expect(read.state).toBe('outstanding');
    await json(await request('PATCH', `/v1/inbox/${assignment.id}`, { state: 'completed' }, { actor: 'bob', revision: read.revision }), 409);
    const snoozed = await json(await request('PATCH', `/v1/inbox/${assignment.id}`, { snoozed_until: new Date(Date.now() + 3600_000).toISOString() }, { actor: 'bob', revision: read.revision }));
    expect((await json<Listing>(await request('GET', '/v1/inbox', undefined, { actor: 'bob' }))).items.some(item => item.id === assignment.id)).toBe(false);
    await json(await request('PATCH', `/v1/inbox/${assignment.id}`, { snoozed_until: null }, { actor: 'bob', revision: snoozed.revision }));
    const subscription = await json(await request('POST', '/v1/subscriptions', { repo_id: 'r_main', item_id: issue.id, mode: 'ignored' }, { actor: 'bob' }), 201);
    expect((await json<Listing>(await request('GET', '/v1/inbox', undefined, { actor: 'bob' }))).items).toHaveLength(0);
    await json(await request('DELETE', `/v1/subscriptions/${subscription.id}`, undefined, { actor: 'bob', revision: 1 }));
    await json(await request('POST', '/v1/users/u_bob/following', { user_id: 'u_alice' }, { actor: 'bob' }), 201);
    expect((await json<Listing>(await request('GET', '/v1/feed', undefined, { actor: 'bob' }))).items.length).toBeGreaterThan(0);
    const body = new TextEncoder().encode('attachment needle');
    const attachment = await json(await request('POST', `/v1/repos/r_main/issues/${issue.id}/attachments`, {
      filename: 'evidence.txt', content_type: 'text/plain', bytes: body.length, sha256: await sha256(body),
    }, { revision: (await get(issue.id)).revision }), 201);
    const upload = await app.fetch(new Request(`http://localhost:8787/v1/repos/r_main/issues/${issue.id}/attachments/${attachment.id}/content`, {
      method: 'PUT', headers: { authorization: `Bearer ${tokens.get('alice')}`, 'if-match': `"${attachment.revision}"`, 'content-type': 'application/octet-stream' }, body,
    }), fixture.env, fixture.context);
    await json(upload);
    expect((await request('GET', `/v1/repos/r_main/issues/${issue.id}/attachments/${attachment.id}/content`, undefined, { actor: 'bob' })).status).toBe(200);
    const eventRow = await one<{ event_json: string }>(fixture.env.DB, 'SELECT event_json FROM outbox WHERE repo_id=? ORDER BY created_at DESC,id DESC LIMIT 1', 'r_main');
    await indexEvent(operationsEnv(), JSON.parse(eventRow!.event_json) as EventRecord);
    const found = await json<Listing>(await request('GET', '/v1/search?q=needle&repo_id=r_main', undefined, { actor: 'bob' }));
    expect(found.items.some(item => item.id === issue.id)).toBe(true);
    expect(found.coverage?.complete).toBe(true);
    fixture.db.sqlite.prepare('UPDATE access_grants SET revoked_at=? WHERE id=?').run(now(), 'grant_bob_r_main');
    expect((await json<Listing>(await request('GET', '/v1/inbox', undefined, { actor: 'bob' }))).items).toHaveLength(0);
    expect((await json<Listing>(await request('GET', '/v1/feed', undefined, { actor: 'bob' }))).items).toHaveLength(0);
    expect((await json<Listing>(await request('GET', '/v1/search?q=needle', undefined, { actor: 'bob' }))).items).toHaveLength(0);
    await json(await request('GET', `/v1/repos/r_main/issues/${issue.id}/attachments/${attachment.id}/content`, undefined, { actor: 'bob' }), 404);
    const uploaded = await json(await request('GET', `/v1/repos/r_main/issues/${issue.id}/attachments/${attachment.id}`));
    await json(await request('DELETE', `/v1/repos/r_main/issues/${issue.id}/attachments/${attachment.id}`, undefined, { revision: uploaded.revision }));
    await json(await request('GET', `/v1/repos/r_main/issues/${issue.id}/attachments/${attachment.id}/content`), 404);
    expect(fixture.blobs.objects.size).toBe(0);
    expect(fixture.db.sqlite.prepare('SELECT used_bytes,reserved_bytes FROM storage_quotas WHERE scope_id=?').get('r_main')).toMatchObject({ used_bytes: 0, reserved_bytes: 0 });
    expect(fixture.db.sqlite.prepare('SELECT 1 FROM storage_quotas WHERE scope_id=?').get('u_alice')).toBeUndefined();
  });

  it('enforces dependency/duplicate graphs and preserves discussion context through answers and issue conversion', async () => {
    const first = await createIssue('First');
    const second = await createIssue('Second');
    await json(await request('POST', `/v1/repos/r_main/issues/${first.id}/dependencies`, { depends_on_id: second.id }, { revision: 1 }), 201);
    await json(await request('POST', `/v1/repos/r_main/issues/${second.id}/dependencies`, { depends_on_id: first.id }, { revision: 1 }), 409);
    await json(await request('PUT', `/v1/repos/r_main/issues/${first.id}/duplicate`, { duplicate_of_id: second.id }, { revision: 2 }));
    await json(await request('PUT', `/v1/repos/r_main/issues/${second.id}/duplicate`, { duplicate_of_id: first.id }, { revision: 1 }), 409);
    const category = await json(await request('POST', '/v1/repos/r_main/discussions/categories', { name: 'Questions', format: 'question' }), 201);
    const discussion = await json(await request('POST', '/v1/repos/r_main/discussions', { title: 'How should this work?', markdown: 'Keep the original **context**.', category_id: category.id }), 201);
    const answer = await json(await request('POST', `/v1/repos/r_main/discussions/${discussion.id}/comments`, { markdown: 'Use a durable operation.' }, { actor: 'bob', revision: 1 }), 201);
    const answered = await json(await request('PUT', `/v1/repos/r_main/discussions/${discussion.id}/answer`, { comment_id: answer.id }, { revision: 2 }));
    expect(answered.state).toBe('answered');
    const converted = await json(await request('POST', `/v1/repos/r_main/discussions/${discussion.id}/convert`, {}, { revision: 3 }), 201);
    expect(converted.markdown).toContain('Keep the original **context**.');
    expect(converted.markdown).toContain(discussion.id);
    const original = await get(discussion.id, 'discussions');
    expect(original.markdown).toBe(discussion.markdown);
    expect(original.converted_issue_id).toBe(converted.id);
    expect((original.accepted_answer as Resource).id).toBe(answer.id);
    await json(await request('PUT', `/v1/repos/r_main/discussions/${discussion.id}/comments/${answer.id}/moderation`, { state: 'hidden', reason: 'Superseded answer' }, { revision: 1 }));
    expect((await get(discussion.id, 'discussions')).accepted_answer).toBeNull();
    await json(await request('GET', `/v1/repos/r_main/discussions/${discussion.id}/comments/${answer.id}`, undefined, { actor: 'eve' }), 404);
  });

  it('uses one real account admission controller across isolated repository shards and keeps billing receipts private', async () => {
    const secondary = await createTestDatabase();
    try {
      for (const table of ['users', 'accounts', 'principals', 'credentials', 'repositories', 'access_grants']) {
        for (const row of fixture.db.sqlite.prepare(`SELECT * FROM ${table}`).all()) {
          if (table === 'accounts') {
            const seeded = secondary.sqlite.prepare('SELECT id,type,owner_user_id FROM accounts WHERE id=?').get(String(row.id));
            if (seeded) { expect(seeded).toMatchObject({ id: row.id, type: row.type, owner_user_id: row.owner_user_id }); continue; }
          }
          if (table === 'principals') {
            const seeded = secondary.sqlite.prepare('SELECT id,kind,user_id,account_id FROM principals WHERE id=?').get(String(row.id));
            if (seeded) {
              expect(seeded).toMatchObject({ id: row.id, kind: row.kind, user_id: row.user_id, account_id: row.account_id });
              continue;
            }
          }
          const columns = Object.keys(row);
          secondary.sqlite.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
            .run(...columns.map(column => row[column] as string | number | null));
        }
      }
      secondary.sqlite.prepare("UPDATE repositories SET shard_id='secondary' WHERE id='r_second'").run();
      fixture.db.sqlite.prepare(`INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,epoch,state,updated_at)
        VALUES ('r_second','repository','local','secondary',1,'active',?)`).run(now());
      fixture.env.SHARD_BINDINGS_JSON = JSON.stringify({ secondary: 'SECONDARY_DB' });
      fixture.env.SECONDARY_DB = secondary.binding();
      Object.assign(fixture.env, identityAuthorityBindings(fixture.env));
      const secondEnv: Bindings = { ...fixture.env, ...identityAuthorityBindings(fixture.env), DB: secondary.binding(), ROOT_DB: fixture.env.DB, ROOT_SHARD_ID: 'core',
        DIRECTORY_DB: fixture.env.DB, SHARD_ID: 'secondary' };
      const firstIssue = await createIssue('First shard attachment');
      const secondIssue = await json(await request('POST', '/v1/repos/r_second/issues', { title: 'Second shard attachment' }, { env: secondEnv }), 201);
      const control = await accountStorage();
      await admissionRequest(fixture.env, 'account:u_alice', 'limits', { max_concurrency: 1, max_storage_bytes: '20', revision: control.revision });
      const bytes = new TextEncoder().encode('twelve bytes');
      expect(bytes.length).toBe(12);
      const body = { filename: 'bounded.txt', content_type: 'text/plain', bytes: bytes.length, sha256: await sha256(bytes) };
      const calls = [
        { path: `/v1/repos/r_main/issues/${firstIssue.id}/attachments`, env: fixture.env },
        { path: `/v1/repos/r_second/issues/${secondIssue.id}/attachments`, env: secondEnv },
      ];
      const responses = await Promise.all(calls.map(call => request('POST', call.path, body, { env: call.env, revision: 1 })));
      expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
      const winnerIndex = responses.findIndex(response => response.status === 201);
      const loserIndex = 1 - winnerIndex;
      const admitted = await responses[winnerIndex]!.json() as Resource;
      const denied = await responses[loserIndex]!.json() as { error: { code: string; details: { attachment_id: string } } };
      expect(denied.error.code).toBe('storage_quota');
      expect(admitted.state).toBe('pending');
      expect(JSON.stringify(admitted)).not.toMatch(/billing_reservation|billing_fence|object_key|upload_generation|\bsf_/);
      expect((await accountStorage()).reserved_bytes).toBe('12');
      for (const db of [fixture.db, secondary]) expect(db.sqlite.prepare("SELECT 1 FROM storage_quotas WHERE scope_id='u_alice'").get()).toBeUndefined();
      const winner = calls[winnerIndex]!;
      await json(await request('DELETE', `${winner.path}/${admitted.id}`, undefined, { env: winner.env, revision: admitted.revision }));
      expect((await accountStorage()).reserved_bytes).toBe('0');
      const loser = calls[loserIndex]!;
      const waiting = await json(await request('GET', `${loser.path}/${denied.error.details.attachment_id}`, undefined, { env: loser.env }));
      expect(waiting.state).toBe('reserving');
      const resumed = await json(await request('POST', `${loser.path}/${waiting.id}/prepare`, {}, { env: loser.env, revision: waiting.revision }));
      expect(resumed.state).toBe('pending');
      expect((await accountStorage()).reserved_bytes).toBe('12');
      await json(await request('DELETE', `${loser.path}/${resumed.id}`, undefined, { env: loser.env, revision: resumed.revision }));
      expect((await accountStorage()).reserved_bytes).toBe('0');
    } finally { secondary.close(); }
  });

  it('fences upload/delete races, retries only definitive incomplete input, and retains uncertain upload holds until positive evidence', async () => {
    const issue = await createIssue('Upload generation races');
    const base = `/v1/repos/r_main/issues/${issue.id}/attachments`;
    const bytes = new TextEncoder().encode('payload');
    const reserve = async () => json(await request('POST', base, { filename: 'proof.txt', content_type: 'text/plain',
      bytes: bytes.length, sha256: await sha256(bytes) }, { revision: (await get(issue.id)).revision }), 201);
    const originalPut = fixture.blobs.put.bind(fixture.blobs);
    const entered = deferred();
    const release = deferred();
    let putCalls = 0;
    fixture.blobs.put = async (...args) => { putCalls++; entered.resolve(); await release.promise; return originalPut(...args); };
    const first = await reserve();
    const writing = upload(`${base}/${first.id}`, bytes, first.revision);
    await entered.promise;
    const inFlight = await json(await request('GET', `${base}/${first.id}`));
    expect(inFlight.state).toBe('uploading');
    await json(await request('DELETE', `${base}/${first.id}`, undefined, { revision: first.revision }), 412);
    await json(await request('DELETE', `${base}/${first.id}`, undefined, { revision: inFlight.revision }), 409);
    await json(await request('POST', `${base}/${first.id}/complete`, {}, { revision: inFlight.revision }), 409);
    expect((await accountStorage()).reserved_bytes).toBe(String(bytes.length));
    release.resolve();
    const ready = await json(await writing);
    expect(ready.state).toBe('ready');
    expect(putCalls).toBe(1);
    expect((await accountStorage()).stored_bytes).toBe(String(bytes.length));
    await json(await request('DELETE', `${base}/${first.id}`, undefined, { revision: ready.revision }));
    expect(fixture.blobs.objects.size).toBe(0);
    expect((await accountStorage()).stored_bytes).toBe('0');

    fixture.blobs.put = async (...args) => { putCalls++; return originalPut(...args); };
    const second = await reserve();
    await json(await upload(`${base}/${second.id}`, new TextEncoder().encode('short'), second.revision), 422);
    const incomplete = await json(await request('GET', `${base}/${second.id}`));
    expect(incomplete.state).toBe('pending');
    expect(putCalls).toBe(1);
    const retried = await json(await upload(`${base}/${second.id}`, bytes, incomplete.revision));
    const generation = fixture.db.sqlite.prepare(`SELECT o.upload_generation FROM object_manifests o
      JOIN collaboration_attachments a ON a.object_id=o.id WHERE a.id=?`).get(second.id);
    expect(generation?.upload_generation).toBe(2);
    expect(putCalls).toBe(2);
    await json(await request('DELETE', `${base}/${second.id}`, undefined, { revision: retried.revision }));

    const lateWrite: { args?: Parameters<typeof originalPut> } = {};
    fixture.blobs.put = async (...args) => { putCalls++; lateWrite.args = args; throw new Error('The R2 acknowledgment was lost.'); };
    const third = await reserve();
    await json(await upload(`${base}/${third.id}`, bytes, third.revision), 503);
    const uncertain = await json(await request('GET', `${base}/${third.id}`));
    expect(uncertain.state).toBe('uploading');
    await json(await upload(`${base}/${third.id}`, bytes, uncertain.revision), 409);
    await json(await request('DELETE', `${base}/${third.id}`, undefined, { revision: uncertain.revision }), 409);
    fixture.db.sqlite.prepare(`UPDATE object_manifests SET retention_until=? WHERE id=(SELECT object_id FROM collaboration_attachments WHERE id=?)`)
      .run(new Date(Date.now() - 1000).toISOString(), third.id);
    await sweepCollaboration(fixture.env);
    expect((await accountStorage()).reserved_bytes).toBe(String(bytes.length));
    expect((await json(await request('GET', `${base}/${third.id}`))).state).toBe('uploading');
    await json(await request('POST', `${base}/${third.id}/complete`, {}, { revision: uncertain.revision }), 409);
    // Deliver the original request's delayed storage result, rather than admitting another writer.
    await originalPut(...lateWrite.args!);
    const reconciled = await json(await request('POST', `${base}/${third.id}/complete`, {}, { revision: uncertain.revision }));
    expect(reconciled.state).toBe('ready');
    expect(putCalls).toBe(3);
    await json(await request('DELETE', `${base}/${third.id}`, undefined, { revision: reconciled.revision }));
    expect((await accountStorage()).stored_bytes).toBe('0');
    expect((await accountStorage()).reserved_bytes).toBe('0');
    expect(fixture.db.sqlite.prepare("SELECT used_bytes,reserved_bytes FROM storage_quotas WHERE scope_id='r_main'").get())
      .toMatchObject({ used_bytes: 0, reserved_bytes: 0 });
  });

  it('preserves unaffected scoped approvals across rebases, invalidates changed reviews, and blocks cached cross-fork replay after revocation', async () => {
    const pull = await json(await request('POST', '/v1/repos/r_main/pulls', { title: 'Patch-aware review', markdown: 'Review two files.', base_ref: 'refs/heads/main', head_ref: 'refs/heads/feature', base_oid: BASE, head_oid: HEAD }), 201);
    const patchId = (pull.patch as Resource).id;
    const scoped = await json(await request('POST', `/v1/repos/r_main/pulls/${pull.id}/reviews`, { patch_id: patchId, decision: 'approve', scope: 'files', paths: ['alpha.ts'] }, { actor: 'bob', revision: 1 }), 201);
    const all = await json(await request('POST', `/v1/repos/r_main/pulls/${pull.id}/reviews`, { patch_id: patchId, decision: 'approve' }, { actor: 'carol', revision: 2 }), 201);
    git.heads.set('r_main:refs/heads/feature', REBASE);
    await json(await request('POST', `/v1/repos/r_main/pulls/${pull.id}/patches`, { base_oid: BASE, head_oid: REBASE }, { revision: 3 }), 201);
    let reviews = await json<Listing>(await request('GET', `/v1/repos/r_main/pulls/${pull.id}/reviews`));
    expect(reviews.items.every(value => value.validity === 'preserved')).toBe(true);
    git.heads.set('r_main:refs/heads/feature', CHANGED);
    await json(await request('POST', `/v1/repos/r_main/pulls/${pull.id}/patches`, { base_oid: BASE, head_oid: CHANGED }, { revision: 4 }), 201);
    reviews = await json<Listing>(await request('GET', `/v1/repos/r_main/pulls/${pull.id}/reviews`));
    expect(reviews.items.find(value => value.id === scoped.id)?.validity).toBe('preserved');
    expect(reviews.items.find(value => value.id === all.id)?.validity).toBe('invalidated');
    expect(reviews.items.find(value => value.id === all.id)?.changed_paths).toEqual(['beta.ts']);
    const payload = { title: 'Private fork context', markdown: 'Secret proposal details', base_ref: 'refs/heads/main', head_ref: 'refs/heads/feature',
      base_oid: BASE, head_oid: HEAD, head_repo_id: 'r_secret' };
    await json(await request('POST', '/v1/repos/r_public/pulls', payload, { actor: 'bob', key: 'private-fork' }), 201);
    fixture.db.sqlite.prepare('UPDATE access_grants SET revoked_at=? WHERE id=?').run(now(), 'grant_bob_r_secret');
    await json(await request('POST', '/v1/repos/r_public/pulls', payload, { actor: 'bob', key: 'private-fork' }), 404);
  });

  it('creates retained PRs through the real API/gateway/native HTTP stack and fences source, policy and concurrent document changes', async () => {
    const temporary = join(tmpdir(), 'opencode');
    await mkdir(temporary, { recursive: true });
    const root = await mkdtemp(join(temporary, 'collaboration-native-http-'));
    const canonical = join(root, 'r_main.git'), checkout = join(root, 'checkout');
    await mkdir(checkout);
    const process = new NativeGit(root, { ...DEFAULT_GIT_LIMITS }, Date.now() + 180_000, true, {
      GIT_AUTHOR_NAME: 'HTTP fixture', GIT_AUTHOR_EMAIL: 'http@example.test', GIT_COMMITTER_NAME: 'HTTP fixture', GIT_COMMITTER_EMAIL: 'http@example.test',
    });
    const client = new NativeGit(checkout, process.limits, process.deadline, true, process.environment);
    const stored = new NativeGit(canonical, process.limits, process.deadline, true);
    let stack: Awaited<ReturnType<typeof nativeHttpFixture>> | undefined;
    try {
      await process.run(['init', '--bare', '--initial-branch=main', canonical]);
      await client.run(['init', '-b', 'main']);
      stack = await nativeHttpFixture(fixture, root, canonical);
      const { origin, controls } = stack;
      const http = (method: string, path: string, body?: unknown, revision?: number, key?: string) => fetch(`${origin}${path}`, {
        method, headers: { authorization: `Bearer ${tokens.get('alice')}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(revision === undefined ? {} : { 'if-match': `"${revision}"` }), ...(key ? { 'idempotency-key': key } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const push = (ref: string) => client.run(['push', '--atomic', `${origin}/alice/r_main.git`, `HEAD:${ref}`], {
        config: [`http.extraHeader=Authorization: Bearer ${tokens.get('alice')}`],
      });
      const count = () => fixture.db.sqlite.prepare("SELECT COUNT(*) AS n FROM collaboration_items WHERE kind='pull_request'").get()?.n;
      const retainedCount = () => fixture.db.sqlite.prepare("SELECT COUNT(*) AS n FROM git_publications WHERE kind='retain' AND state='committed' AND finalized=1").get()?.n;
      await writeFile(join(checkout, 'removed.txt'), 'Original retained line.\nSecond old-side line.\n');
      await client.run(['add', '.']); await client.run(['commit', '-m', 'Publish the actual target']);
      const base = await client.text(['rev-parse', 'HEAD']);
      await push('refs/heads/main');
      await client.run(['checkout', '-b', 'feature']);
      await client.run(['rm', 'removed.txt']);
      await writeFile(join(checkout, 'README.md'), 'Actual proposed content.\n');
      await client.run(['add', '.']); await client.run(['commit', '-m', 'Propose a deletion']);
      const head = await client.text(['rev-parse', 'HEAD']);
      await push('refs/heads/feature');
      const repository = await json(await http('GET', '/v1/repos/r_main'));
      const body = { title: 'Retained native HTTP pull', markdown: 'Canonical review context.', base_ref: 'refs/heads/main', head_ref: 'refs/heads/feature', base_oid: base, head_oid: head };

      let fence: MetadataFenceReceipt | undefined;
      controls.afterRetention = async () => {
        expect(count()).toBe(0);
        expect(retainedCount()).toBe(1);
        const snapshot = await one<{ id: string; state: string }>(fixture.env.DB, "SELECT id,state FROM git_review_snapshots WHERE repo_id='r_main'");
        expect(snapshot?.state).toBe('ready');
        expect(await stored.text(['rev-parse', ...reviewRefs(snapshot!.id)])).toBe(`${base}\n${head}\n${base}`);
        fence = await acquireMetadataFence(fixture.env, 'r_main', 'backup_http_capture', 1);
      };
      const batch = fixture.db.batch.bind(fixture.db);
      let captured: D1PreparedStatement[] | undefined, submittedId: unknown, attempts = 0, nativeCalls = 0;
      let release: Promise<void> | undefined, releaseError: unknown;
      fixture.db.batch = async statements => {
        // The local SQLite adapter exposes its SQL for transport-level fault injection.
        const insert = statements.find(statement => /^\s*INSERT INTO collaboration_items\(/.test((statement as unknown as { sql: string }).sql));
        if (insert) {
          attempts++;
          if (!captured) {
            captured = statements; submittedId = (insert as unknown as { parameters: unknown[] }).parameters[0];
            nativeCalls = stack!.inspections.length;
            release = (async () => {
              await delay(1300);
              expect(count()).toBe(0);
              await releaseMetadataFence(fixture.env, fence!);
            })().catch(error => { releaseError = error; });
          } else {
            expect(statements.length).toBe(captured.length);
            for (let index = 0; index < statements.length; index++) expect(statements[index]).toBe(captured[index]);
            expect(stack!.inspections.length).toBe(nativeCalls);
          }
        }
        return batch(statements);
      };
      let pull: Resource;
      try {
        const response = await http('POST', '/v1/repos/r_main/pulls', body, undefined, 'native-http-create');
        await release;
        if (releaseError) throw releaseError;
        pull = await json(response, 201);
        expect(attempts).toBe(2);
        expect(pull.id).toBe(submittedId);
        expect(stack.inspections.length).toBe(nativeCalls);
      } finally {
        await release;
        if (fence) await releaseMetadataFence(fixture.env, fence);
        fixture.db.batch = batch;
      }
      expect(pull.head_oid).toBe(head);
      expect((await json(await http('GET', '/v1/repos/r_main'))).revision).toBe(repository.revision);
      expect((await json(await http('POST', '/v1/repos/r_main/pulls', body, undefined, 'native-http-create'), 201)).id).toBe(pull.id);
      expect(count()).toBe(1); expect(retainedCount()).toBe(1);
      const diff = await http('GET', `/v1/repos/r_main/pulls/${pull.id}/diff`);
      expect(diff.status).toBe(200); expect(await diff.text()).toContain('+++ /dev/null');

      controls.dropPullResponse = true;
      const lostBody = { ...body, title: 'Lost HTTP acknowledgement' };
      await expect(http('POST', '/v1/repos/r_main/pulls', lostBody, undefined, 'native-http-lost')).rejects.toThrow();
      const committed = await one<{ resource_id: string }>(fixture.env.DB, "SELECT resource_id FROM idempotency_keys WHERE principal_id='u_alice' AND key='native-http-lost'");
      const recovered = await json(await http('POST', '/v1/repos/r_main/pulls', lostBody, undefined, 'native-http-lost'), 201);
      expect(recovered.id).toBe(committed?.resource_id);
      expect(count()).toBe(2); expect(retainedCount()).toBe(1);

      let nextHead = '';
      controls.afterRetention = async () => {
        await writeFile(join(checkout, 'README.md'), 'The source changed while retaining its earlier proposal.\n');
        await client.run(['add', '.']); await client.run(['commit', '-m', 'Concurrent source update']);
        nextHead = await client.text(['rev-parse', 'HEAD']);
        await push('refs/heads/feature');
      };
      const stale = await json<{ error: { code: string } }>(await http('POST', '/v1/repos/r_main/pulls', body, undefined, 'native-http-stale-source'), 412);
      expect(stale.error.code).toBe('review_head_changed'); expect(count()).toBe(2);
      const nextBody = { ...body, title: 'Policy-fenced proposal', head_oid: nextHead };
      controls.afterRetention = async () => {
        await json(await http('POST', '/v1/repos/r_main/rules', { name: 'Concurrent current policy',
          config: { target: 'refs/heads/main', files: { max_bytes: 8192 } } }), 201);
      };
      await json(await http('POST', '/v1/repos/r_main/pulls', nextBody, undefined, 'native-http-policy-race'), 412);
      expect(count()).toBe(2); expect(retainedCount()).toBe(2);
      const current = await json(await http('POST', '/v1/repos/r_main/pulls', nextBody, undefined, 'native-http-policy-race'), 201);
      expect((await json(await http('POST', '/v1/repos/r_main/pulls', nextBody, undefined, 'native-http-policy-race'), 201)).id).toBe(current.id);
      expect(count()).toBe(3); expect(retainedCount()).toBe(2);

      controls.afterRetention = async () => {
        const value = await json(await http('GET', '/v1/repos/r_main'));
        await json(await http('PATCH', '/v1/repos/r_main', { description: 'Concurrent repository settings' }, value.revision));
      };
      await json(await http('POST', '/v1/repos/r_main/pulls', nextBody, undefined, 'native-http-metadata-race'), 412);
      expect(count()).toBe(3);

      controls.afterRetention = async () => {
        await json(await http('PATCH', `/v1/repos/r_main/pulls/${pull.id}`, { title: 'Concurrent author edit' }, pull.revision));
      };
      const patchBody = { base_oid: base, head_oid: nextHead };
      await json(await http('POST', `/v1/repos/r_main/pulls/${pull.id}/patches`, patchBody, pull.revision, 'native-http-patch-race'), 412);
      const unchanged = await json(await http('GET', `/v1/repos/r_main/pulls/${pull.id}`));
      expect(unchanged.title).toBe('Concurrent author edit'); expect(unchanged.head_oid).toBe(head);
      expect((await json<Listing>(await http('GET', `/v1/repos/r_main/pulls/${pull.id}/patches`))).items).toHaveLength(1);
      await json(await http('POST', `/v1/repos/r_main/pulls/${pull.id}/patches`, patchBody, unchanged.revision, 'native-http-current-patch'), 201);
      const updated = await json(await http('GET', `/v1/repos/r_main/pulls/${pull.id}`));
      expect(updated.title).toBe('Concurrent author edit'); expect(updated.head_oid).toBe(nextHead);
      expect((await json<Listing>(await http('GET', `/v1/repos/r_main/pulls/${pull.id}/patches`))).items).toHaveLength(2);
      expect(stack.diagnostics).toEqual([]);
    } finally { await stack?.close(); await rm(root, { recursive: true, force: true }); }
  }, 120_000);

  it('derives review coverage from real Git target ancestry and enforces owners, required reviewers, disjoint scopes and all/any trusted checks', async () => {
    const temporary = join(tmpdir(), 'opencode');
    await mkdir(temporary, { recursive: true });
    const directory = await mkdtemp(join(temporary, 'collaboration-review-'));
    const native = new NativeGit(directory, { ...DEFAULT_GIT_LIMITS }, Date.now() + 120_000, true, {
      GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'author@example.test', GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'author@example.test',
    });
    try {
      await native.run(['init', '-b', 'main']);
      await writeFile(join(directory, 'alpha.py'), 'if enabled:\n    original()\n');
      await native.run(['add', '.']); await native.run(['commit', '-m', 'Trusted target']);
      const target = await native.text(['rev-parse', 'HEAD']);
      await native.run(['checkout', '-b', 'feature']);
      await mkdir(join(directory, 'security'));
      await writeFile(join(directory, 'security/access.yml'), 'administrator: true\n');
      await native.run(['add', '.']); await native.run(['commit', '-m', 'Sensitive intermediate change']);
      const intermediate = await native.text(['rev-parse', 'HEAD']);
      await writeFile(join(directory, 'alpha.py'), 'if enabled:\n    proposed()\n');
      await native.run(['add', '.']); await native.run(['commit', '-m', 'Visible final change']);
      const head = await native.text(['rev-parse', 'HEAD']);
      await native.run(['checkout', 'main']);
      await native.run(['merge', '--no-ff', '--no-edit', 'feature']);
      const candidate = await native.text(['rev-parse', 'HEAD']);
      await native.run(['update-ref', 'refs/gitknot/candidates/test', candidate]);
      await native.run(['reset', '--hard', target]);
      git.nativeRepositories.set('r_main', native);
      const body = { title: 'Actual full-graph change', base_ref: 'refs/heads/main', head_ref: 'refs/heads/feature', base_oid: target, head_oid: head };
      await json(await request('POST', '/v1/repos/r_main/pulls', { ...body, base_oid: intermediate }), 412);

      const legacy = await json(await request('POST', '/v1/repos/r_main/pulls', body), 201);
      const partial = await (await inspectCollaboration(native, 'r_main', { inspection: { kind: 'patch', head_repo_id: 'r_main', base_oid: intermediate, head_oid: head } })).json() as NativePatch;
      expect(partial.files.map(file => file.path)).toEqual(['alpha.py']);
      const actor = await authenticate(new Request('http://localhost:8787/', { headers: { authorization: `Bearer ${tokens.get('alice')}` } }), fixture.env);
      const context = backgroundContext(fixture.env, actor!);
      const legacyItem = await one<Item>(fixture.env.DB, 'SELECT * FROM collaboration_items WHERE id=?', legacy.id);
      const oldPatch = await preparePatch(context, legacyItem!, partial, 2);
      await fixture.env.DB.batch([...oldPatch.statements,
        stmt(fixture.env.DB, 'UPDATE pull_requests SET base_oid=?,current_patch_id=? WHERE id=?', intermediate, oldPatch.patch.id, legacy.id),
        stmt(fixture.env.DB, 'UPDATE collaboration_items SET revision=revision+1 WHERE id=?', legacy.id),
      ]);
      await candidateRecord(legacy.id, 'candidate_legacy', target, head, candidate);
      const hidden = await json(await request('GET', `/v1/repos/r_main/pulls/${legacy.id}/merge-eligibility?candidate_id=candidate_legacy`));
      expect(hidden.eligible).toBe(false);
      expect((hidden.blockers as Array<{ code: string }>).some(reason => reason.code === 'reviewed_patch_outdated')).toBe(true);
      expect(await native.text(['diff', '--name-only', target, candidate])).toContain('security/access.yml');
      await json(await request('POST', `/v1/repos/r_main/pulls/${legacy.id}/patches`, { base_oid: target, head_oid: head }, { revision: 2 }), 201);
      expect((await json(await request('GET', `/v1/repos/r_main/pulls/${legacy.id}/merge-eligibility?candidate_id=candidate_legacy`))).eligible).toBe(true);

      const at = now();
      fixture.db.sqlite.prepare(`INSERT INTO memberships(account_id,principal_id,role_id,state,created_by,created_at,updated_at)
        VALUES ('u_alice','u_bob','maintainer','active','u_alice',?,?)`).run(at, at);
      fixture.db.sqlite.prepare(`INSERT INTO teams(id,account_id,slug,name,created_by,created_at,updated_at)
        VALUES ('team_security','u_alice','security','Security','u_alice',?,?)`).run(at, at);
      fixture.db.sqlite.prepare(`INSERT INTO team_members(account_id,team_id,principal_id,created_at,updated_at)
        VALUES ('u_alice','team_security','u_bob',?,?)`).run(at, at);
      const expression = { type: 'all', checks: [
        { type: 'check', key: 'verify.test', producers: ['hosted:trusted'] },
        { type: 'any', checks: [{ type: 'check', key: 'verify.lint', producers: ['hosted:trusted'] }, { type: 'check', key: 'verify.compat', producers: ['hosted:trusted'] }] },
      ] };
      fixture.db.sqlite.prepare(`INSERT INTO repository_rules(id,account_id,repo_id,name,target_json,config_json,created_by,created_at,updated_at)
        VALUES ('rule_complete','u_alice','r_main','Complete obligations',?,?,'u_alice',?,?)`).run(JSON.stringify('refs/heads/main'),
        JSON.stringify({ reviews: { minimum: 1, required_reviewers: ['u_carol'], required_owners: { 'security/**': ['team_security'] } },
          verification: { required: [], expression } }), at, at);
      const pull = await json(await request('POST', '/v1/repos/r_main/pulls', body), 201);
      const patchId = (pull.patch as Resource).id;
      await candidateRecord(pull.id, 'candidate_complete', target, head, candidate);
      await json(await request('POST', `/v1/repos/r_main/pulls/${pull.id}/reviews`, { patch_id: patchId, decision: 'approve', scope: 'files', paths: ['alpha.py'] }, { actor: 'bob', revision: 1 }), 201);
      let result = await json(await request('GET', `/v1/repos/r_main/pulls/${pull.id}/merge-eligibility?candidate_id=candidate_complete`));
      expect((result.blockers as Array<{ code: string }>).some(reason => reason.code === 'required_owner')).toBe(true);
      await json(await request('POST', `/v1/repos/r_main/pulls/${pull.id}/reviews`, { patch_id: patchId, decision: 'approve', scope: 'files', paths: ['security/access.yml'] }, { actor: 'bob', revision: 2 }), 201);
      result = await json(await request('GET', `/v1/repos/r_main/pulls/${pull.id}/merge-eligibility?candidate_id=candidate_complete`));
      const reasons = (result.blockers as Array<{ code: string }>).map(reason => reason.code);
      expect(reasons).not.toContain('required_reviews');
      expect(reasons).not.toContain('required_owner');
      expect(reasons).toContain('required_reviewer');
      expect((result.reviews as Array<{ reviewer_id: string; paths: string[] }>).filter(review => review.reviewer_id === 'u_bob').flatMap(review => review.paths).sort())
        .toEqual(['alpha.py', 'security/access.yml']);
      await json(await request('POST', `/v1/repos/r_main/pulls/${pull.id}/reviews`, { patch_id: patchId, decision: 'approve' }, { actor: 'carol', revision: 3 }), 201);
      await seedVerification(true, 1, { commit: candidate });
      expect((await json(await request('GET', `/v1/repos/r_main/pulls/${pull.id}/merge-eligibility?candidate_id=candidate_complete`))).eligible).toBe(false);
      await seedVerification(false, 2, { commit: candidate, job: 'lint' });
      expect((await json(await request('GET', `/v1/repos/r_main/pulls/${pull.id}/merge-eligibility?candidate_id=candidate_complete`))).eligible).toBe(false);
      await seedVerification(true, 3, { commit: candidate, job: 'compat' });
      expect((await json(await request('GET', `/v1/repos/r_main/pulls/${pull.id}/merge-eligibility?candidate_id=candidate_complete`))).eligible).toBe(true);
      const identity = await createTestDatabase(), originalIdentity = identityAuthorityBindings(fixture.env);
      try {
        const tables = { users: "id LIKE 'u_%'", accounts: "type='user'", principals: "kind='user'", credentials: "kind='personal'",
          memberships: "account_id='u_alice'", teams: "account_id='u_alice'", team_members: "account_id='u_alice'", access_grants: "account_id='u_alice'" };
        for (const [table, where] of Object.entries(tables)) for (const row of fixture.db.sqlite.prepare(`SELECT * FROM ${table} WHERE ${where}`).all()) {
          const columns = Object.keys(row);
          identity.sqlite.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
            .run(...columns.map(column => row[column] as string | number | null));
        }
        fixture.db.sqlite.prepare(`INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,epoch,state,updated_at)
          VALUES ('r_main','repository','local','core',1,'active',?)`).run(at);
        Object.assign(fixture.env, { IDENTITY_DB: identity.binding(), IDENTITY_CELL_ID: 'local', IDENTITY_SHARD_ID: 'identity' });
        expect((await json(await request('GET', `/v1/repos/r_main/pulls/${pull.id}/merge-eligibility?candidate_id=candidate_complete`))).eligible).toBe(true);
        identity.sqlite.prepare("DELETE FROM team_members WHERE team_id='team_security' AND principal_id='u_bob'").run();
        expect(fixture.db.sqlite.prepare("SELECT 1 FROM team_members WHERE team_id='team_security' AND principal_id='u_bob'").get()).toBeDefined();
        result = await json(await request('GET', `/v1/repos/r_main/pulls/${pull.id}/merge-eligibility?candidate_id=candidate_complete`));
        expect((result.blockers as Array<{ code: string }>).some(reason => reason.code === 'required_owner')).toBe(true);
        identity.sqlite.prepare(`INSERT INTO repository_rules(id,account_id,repo_id,name,target_json,config_json,created_by,created_at,updated_at)
          VALUES ('rule_account_identity','u_alice',NULL,'Identity account policy',?,?,'u_alice',?,?)`).run(JSON.stringify('refs/heads/main'),
          JSON.stringify({ verification: { required: ['verify.account_policy'], trusted_producers: ['hosted:trusted'] } }), at, at);
        result = await json(await request('GET', `/v1/repos/r_main/pulls/${pull.id}/merge-eligibility?candidate_id=candidate_complete`));
        expect((result.blockers as Array<{ code: string; details?: { name?: string } }>).some(reason => reason.code === 'required_verification'
          && reason.details?.name === 'verify.account_policy')).toBe(true);
      } finally { Object.assign(fixture.env, originalIdentity); identity.close(); }
      await native.run(['checkout', 'feature']);
      await writeFile(join(directory, 'alpha.py'), 'if enabled:\n proposed()\n');
      await native.run(['add', '.']); await native.run(['commit', '-m', 'Whitespace-only semantic change']);
      const whitespaceHead = await native.text(['rev-parse', 'HEAD']);
      await json(await request('POST', `/v1/repos/r_main/pulls/${pull.id}/patches`, { base_oid: target, head_oid: whitespaceHead }, { revision: 4 }), 201);
      result = await json(await request('GET', `/v1/repos/r_main/pulls/${pull.id}/merge-eligibility`));
      expect((result.blockers as Array<{ code: string; details?: { paths?: string[] } }>).some(reason => reason.code === 'required_reviews' && reason.details?.paths?.includes('alpha.py'))).toBe(true);
      expect((result.reviews as Array<{ reviewer_id: string; paths: string[] }>).some(review => review.reviewer_id === 'u_bob' && review.paths.includes('security/access.yml'))).toBe(true);
    } finally { git.nativeRepositories.delete('r_main'); await rm(directory, { recursive: true, force: true }); }
  });

  it('paginates only authorized search hits and reports viewer-scoped coverage without private fork match or ID leakage', async () => {
    const first = await createIssue('visible needle one', {}, 'r_public');
    const second = await createIssue('visible needle two', {}, 'r_public');
    const secret = await json(await request('POST', '/v1/repos/r_public/pulls', { title: 'private-only-query needle',
      head_repo_id: 'r_secret', base_ref: 'refs/heads/main', head_ref: 'refs/heads/feature', base_oid: BASE, head_oid: HEAD }), 201);
    const secondSecret = await json(await request('POST', '/v1/repos/r_public/pulls', { title: 'private-only-query another needle',
      head_repo_id: 'r_secret', base_ref: 'refs/heads/main', head_ref: 'refs/heads/feature', base_oid: BASE, head_oid: HEAD }), 201);
    const event = await one<{ event_json: string }>(fixture.env.DB, "SELECT event_json FROM outbox WHERE repo_id='r_public' ORDER BY created_at DESC,id DESC LIMIT 1");
    await indexEvent(operationsEnv(), JSON.parse(event!.event_json) as EventRecord);
    fixture.db.sqlite.prepare("UPDATE access_grants SET revoked_at=? WHERE id='grant_bob_r_secret'").run(now());
    const hiddenOnly = await json<Listing>(await request('GET', '/v1/search?q=private-only-query&repo_id=r_public&limit=1', undefined, { actor: 'bob' }));
    const absent = await json<Listing>(await request('GET', '/v1/search?q=never-present-query&repo_id=r_public&limit=1', undefined, { actor: 'bob' }));
    expect(hiddenOnly.items).toHaveLength(0); expect(hiddenOnly.next_cursor).toBeNull();
    expect(absent.items).toHaveLength(0); expect(absent.next_cursor).toBeNull();
    expect(hiddenOnly.coverage).toEqual(absent.coverage);
    expect(JSON.stringify(hiddenOnly)).not.toContain(secret.id);
    expect(JSON.stringify(hiddenOnly)).not.toContain(secondSecret.id);
    const firstPage = await json<Listing>(await request('GET', '/v1/search?q=needle&repo_id=r_public&limit=1', undefined, { actor: 'bob' }));
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.next_cursor).toMatch(/^s1\./);
    expect(firstPage.next_cursor).not.toContain(secret.id);
    const secondPage = await json<Listing>(await request('GET', `/v1/search?q=needle&repo_id=r_public&limit=1&cursor=${firstPage.next_cursor}`, undefined, { actor: 'bob' }));
    expect(secondPage.items).toHaveLength(1); expect(secondPage.next_cursor).toBeNull();
    expect([firstPage.items[0]!.id, secondPage.items[0]!.id].sort()).toEqual([first.id, second.id].sort());
    const coverage = (firstPage.coverage?.repositories as Array<{ authoritative_documents: number; indexed_documents: number }>)[0]!;
    expect(coverage.authoritative_documents).toBe(2); expect(coverage.indexed_documents).toBe(2);
  });

  it('requires current server-manifest path proof for exemptions and keeps failed, missing and cancelled alternatives blocking', async () => {
    const temporary = join(tmpdir(), 'opencode');
    await mkdir(temporary, { recursive: true });
    const directory = await mkdtemp(join(temporary, 'collaboration-verification-'));
    const native = new NativeGit(directory, { ...DEFAULT_GIT_LIMITS }, Date.now() + 120_000, true, {
      GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'author@example.test', GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'author@example.test',
    });
    try {
      await native.run(['init', '-b', 'main']);
      await mkdir(join(directory, 'src'));
      await writeFile(join(directory, 'src/main.ts'), 'export const value = 1;\n');
      await native.run(['add', '.']); await native.run(['commit', '-m', 'Trusted target']);
      const target = await native.text(['rev-parse', 'HEAD']);
      await native.run(['checkout', '-b', 'feature']);
      await writeFile(join(directory, 'src/main.ts'), 'export const value = 2;\n');
      await native.run(['add', '.']); await native.run(['commit', '-m', 'Candidate source change']);
      const head = await native.text(['rev-parse', 'HEAD']);
      await native.run(['checkout', 'main']); await native.run(['merge', '--no-ff', '--no-edit', 'feature']);
      const candidate = await native.text(['rev-parse', 'HEAD']);
      await native.run(['reset', '--hard', target]);
      git.nativeRepositories.set('r_main', native);
      const pull = await json(await request('POST', '/v1/repos/r_main/pulls', { title: 'Current path-policy proof',
        base_ref: 'refs/heads/main', head_ref: 'refs/heads/feature', base_oid: target, head_oid: head }), 201);
      await candidateRecord(pull.id, 'candidate_policy', target, head, candidate);
      const changedPaths = (await native.text(['diff', '--name-only', target, candidate])).split('\n');
      expect(changedPaths).toEqual(['src/main.ts']);

      const source = JSON.stringify({ version: 1, name: 'verify', triggers: ['merge_candidate.created'], source: 'event.commit',
        defaults: { executor: { type: 'hosted', profile: 'linux-small' }, toolchain: 'fixture' }, jobs: {
          test: { when: { paths: { include: ['src/**'] } }, steps: [{ run: 'exit 9' }] },
          docs: { when: { paths: { include: ['docs/**'] } }, steps: [{ run: 'exit 9' }] },
        } });
      const definition = validatedDefinition(source), digest = await definitionDigest(definition), at = now();
      const policy = { access: { repository: 'read', capabilities: [], secrets: [] }, hosted_profiles: ['linux-small'],
        self_hosted_pools: {}, inapplicable_jobs: ['test', 'docs'] };
      const toolchains = { fixture: { os: 'linux', arch: 'x64', tools: { node: '24.18.0' } } };
      await fixture.env.DB.batch([
        stmt(fixture.env.DB, `INSERT INTO workflows(id,repo_id,account_id,name,path,current_version_id,created_by,created_at,updated_at)
          VALUES ('wf_policy','r_main','u_alice','verify','.gitknot/workflows/verify.yml','wfv_policy','u_alice',?,?)`, at, at),
        stmt(fixture.env.DB, `INSERT INTO workflow_versions(id,workflow_id,repo_id,account_id,source_commit,definition_digest,definition,definition_json,policy_revision,approved_by,created_at)
          VALUES ('wfv_policy','wf_policy','r_main','u_alice',?,?,?,?,1,'u_alice',?)`, target, digest, source, JSON.stringify(definition), at),
        stmt(fixture.env.DB, `INSERT INTO workflow_execution_policy(repo_id,account_id,policy_json,toolchains_json,modules_json,egress_json,updated_by,updated_at)
          VALUES ('r_main','u_alice',?,?,'{}',?,'u_alice',?)`, JSON.stringify(policy), JSON.stringify(toolchains),
        JSON.stringify({ hosts: [], max_bytes: 1024, max_requests: 5, max_request_bytes: 512 }), at),
        stmt(fixture.env.DB, `INSERT INTO repository_rules(id,account_id,repo_id,name,target_json,config_json,created_by,created_at,updated_at)
          VALUES ('rule_policy','u_alice','r_main','Verified applicability',?,?,'u_alice',?,?)`, JSON.stringify('refs/heads/main'),
        JSON.stringify({ verification: { required: ['verify.test'], trusted_producers: ['hosted:linux-small'] } }), at, at),
      ]);
      const repo = (await one<Repository>(fixture.env.DB, "SELECT * FROM repositories WHERE id='r_main'"))!;
      const workflow = (await one<WorkflowRecord>(fixture.env.DB, "SELECT * FROM workflows WHERE id='wf_policy'"))!;
      const version = (await one<WorkflowVersion>(fixture.env.DB, "SELECT * FROM workflow_versions WHERE id='wfv_policy'"))!;
      const actor = (await authenticate(new Request('http://localhost:8787/', { headers: { authorization: `Bearer ${tokens.get('alice')}` } }), fixture.env))!;
      const input: PlanRunInput = { commit: candidate, ref: 'refs/heads/main', changed_paths: changedPaths,
        event: { type: 'merge_candidate.created', id: 'event_policy', merge_candidate_id: 'candidate_policy', pull_request_id: pull.id } };
      const eligibility = async () => json(await request('GET', `/v1/repos/r_main/pulls/${pull.id}/merge-eligibility?candidate_id=candidate_policy`));
      function requireChecks(verification: GitRule['verification']) {
        fixture.db.sqlite.prepare("UPDATE repository_rules SET config_json=?,revision=revision+1 WHERE id='rule_policy'").run(JSON.stringify({ verification }));
      }
      async function start(plan: ExecutionPlan, key: string) {
        return createRun(fixture.env, fixture.env.DB, { workflow_id: workflow.id, plan, actor_id: actor.id, request_key: key, request_hash: await sha256(JSON.stringify(plan)) });
      }

      await expect(planRun(fixture.env, repo, workflow, version, actor, { ...input, event: { ...input.event, type: 'review.unsubscribed' } }))
        .rejects.toMatchObject({ code: 'event_untrusted' });
      expect(fixture.db.sqlite.prepare('SELECT COUNT(*) AS n FROM workflow_runs').get()?.n).toBe(0);

      // A valid server manifest with incomplete event coverage is still not proof about the actual candidate.
      const wrongCoverage = await planRun(fixture.env, repo, workflow, version, actor, { ...input, changed_paths: [] }, true);
      expect((await verifyManifest(wrongCoverage.portable_manifest)).jobs.every(job => job.condition.outcome === 'not_applicable')).toBe(true);
      const wronglyExempt = await start(wrongCoverage, 'wrong-coverage');
      await advanceRun(fixture.env, wronglyExempt.id);
      expect(fixture.db.sqlite.prepare('SELECT COUNT(*) AS n FROM execution_attempts WHERE run_id=?').get(wronglyExempt.id)?.n).toBe(0);
      let result = await eligibility();
      expect(result.eligible).toBe(false);
      expect(result.verifications).toContainEqual(expect.objectContaining({ name: 'verify.test', conclusion: 'not_applicable', reason: 'unproven_inapplicability' }));

      const planned = await planRun(fixture.env, repo, workflow, version, actor, input, true);
      const manifest = await verifyManifest(planned.portable_manifest);
      expect(manifest.event.changed_paths).toEqual(changedPaths);
      expect(manifest.jobs.find(job => job.id === 'test')?.condition.outcome).toBe('run');
      expect(manifest.jobs.find(job => job.id === 'docs')?.condition.outcome).toBe('not_applicable');
      const current = await start(planned, 'complete-coverage');
      await advanceRun(fixture.env, current.id);
      const attempt = (await one<AttemptRecord>(fixture.env.DB, 'SELECT * FROM execution_attempts WHERE run_id=?', current.id))!;
      // The local negative-outcome adapter reports an actual exit through the production controller.
      const execution = spawnSync('/bin/sh', ['-c', planned.jobs.find(job => job.key === 'test')!.steps[0]!.run], { cwd: directory, timeout: 5000 });
      if (execution.error) throw execution.error;
      expect(execution.status).toBe(9);
      await new AttemptMachine(fixture.env, new TransactionalStorage()).cancel(attempt.id, `Local adapter exited with code ${execution.status}.`, 'failed');
      await advanceRun(fixture.env, current.id);
      expect(fixture.db.sqlite.prepare('SELECT conclusion FROM workflow_verifications WHERE attempt_id=?').get(attempt.id)?.conclusion).toBe('failed');
      expect((await eligibility()).eligible).toBe(false);

      requireChecks({ required: ['verify.docs'], trusted_producers: ['hosted:linux-small'] });
      result = await eligibility();
      expect(result.eligible).toBe(true);
      expect(result.verifications).toContainEqual(expect.objectContaining({ name: 'verify.docs', satisfied: true, applicable: false,
        passed: false, conclusion: 'not_applicable', reason: 'validated_current_path_policy', run_id: current.id }));
      const docs = { type: 'check' as const, key: 'verify.docs', producers: ['hosted:linux-small'] };
      const test = { type: 'check' as const, key: 'verify.test', producers: ['hosted:linux-small'] };
      const optional = { type: 'check' as const, key: 'verify.optional', producers: ['hosted:linux-small'], paths: { include: ['optional/**'], exclude: [] } };
      requireChecks({ required: [], expression: { type: 'any', checks: [{ type: 'all', checks: [docs, optional] }, test] } });
      expect((await eligibility()).eligible).toBe(false);
      requireChecks({ required: [], expression: { type: 'all', checks: [docs, { type: 'any', checks: [test, optional] }] } });
      expect((await eligibility()).eligible).toBe(false);
      requireChecks({ required: [], expression: { type: 'any', checks: [docs, optional] } });
      expect((await eligibility()).eligible).toBe(false);
      requireChecks({ required: [], expression: { type: 'all', checks: [docs, optional] } });
      expect((await eligibility()).eligible).toBe(true);
      requireChecks({ required: [], expression: { ...test, paths: { include: [], exclude: [] } } });
      result = await eligibility();
      expect(result.eligible).toBe(false);
      expect(result.verifications).toContainEqual(expect.objectContaining({ name: 'verify.test', satisfied: false, applicable: true }));

      requireChecks({ required: ['verify.docs'] });
      fixture.db.sqlite.prepare("UPDATE workflow_execution_policy SET policy_json=? WHERE repo_id='r_main'").run(JSON.stringify({ ...policy, inapplicable_jobs: ['test'] }));
      expect((await eligibility()).eligible).toBe(false);
      fixture.db.sqlite.prepare("UPDATE workflow_execution_policy SET policy_json=?,toolchains_json=? WHERE repo_id='r_main'")
        .run(JSON.stringify(policy), JSON.stringify({ fixture: { ...toolchains.fixture, tools: { node: '24.19.0' } } }));
      expect((await eligibility()).eligible).toBe(false);
      fixture.db.sqlite.prepare("UPDATE workflow_execution_policy SET toolchains_json=? WHERE repo_id='r_main'").run(JSON.stringify(toolchains));
      expect((await eligibility()).eligible).toBe(true);

      const cancelled = await start(planned, 'cancelled-proof');
      expect((await eligibility()).eligible).toBe(false); // A missing latest result cannot fall back to an older exemption.
      await cancelRun(fixture.env, fixture.env.DB, cancelled, actor.id);
      await advanceRun(fixture.env, cancelled.id);
      expect(fixture.db.sqlite.prepare("SELECT conclusion FROM workflow_verifications WHERE run_id=? AND producer_id='policy:1'").get(cancelled.id)?.conclusion).toBe('not_applicable');
      expect((await eligibility()).eligible).toBe(false);

      const mismatch = await planRun(fixture.env, repo, workflow, version, actor, { ...input, event: { ...input.event, type: 'review.unsubscribed' } }, true);
      const unsubscribed = await start(mismatch, 'missing-trigger');
      await advanceRun(fixture.env, unsubscribed.id);
      expect(mismatch.jobs.every(job => !!job.blocked_reason && job.applicable)).toBe(true);
      expect(fixture.db.sqlite.prepare('SELECT COUNT(*) AS n FROM execution_attempts WHERE run_id=?').get(unsubscribed.id)?.n).toBe(0);
      expect((await eligibility()).eligible).toBe(false);
    } finally { git.nativeRepositories.delete('r_main'); await rm(directory, { recursive: true, force: true }); }
  });

  it('recovers keyed attachment sagas and cleans ready, in-flight and expired denied attachments after their parent is deleted', async () => {
    const issue = await createIssue('Keyed upload lifecycle');
    const base = `/v1/repos/r_main/issues/${issue.id}/attachments`;
    const bytes = new TextEncoder().encode('payload');
    const body = { filename: 'lifecycle.txt', content_type: 'text/plain', bytes: bytes.length, sha256: await sha256(bytes) };
    let control = await accountStorage();
    await admissionRequest(fixture.env, 'account:u_alice', 'limits', { max_concurrency: 1, max_storage_bytes: '1', revision: control.revision });
    const denied = await json<{ error: { details: { attachment_id: string } } }>(await request('POST', base, body, { revision: 1, key: 'keyed-create' }), 409);
    const id = denied.error.details.attachment_id;
    const intent = await json(await request('GET', `${base}/${id}`));
    expect(intent.state).toBe('reserving');
    control = await accountStorage();
    await admissionRequest(fixture.env, 'account:u_alice', 'limits', { max_concurrency: 1, max_storage_bytes: '1000', revision: control.revision });
    const pending = await json(await request('POST', `${base}/${id}/prepare`, {}, { revision: intent.revision, key: 'keyed-prepare' }));
    expect((await json(await request('POST', `${base}/${id}/prepare`, {}, { revision: intent.revision, key: 'keyed-prepare' }))).id).toBe(id);
    expect((await json(await request('POST', base, body, { revision: 1, key: 'keyed-create' }), 201)).id).toBe(id);
    expect((await accountStorage()).reserved_bytes).toBe(String(bytes.length));
    const originalPut = fixture.blobs.put.bind(fixture.blobs);
    fixture.blobs.put = async (...args) => { await originalPut(...args); throw new Error('Acknowledgment lost after acceptance'); };
    await json(await upload(`${base}/${id}`, bytes, pending.revision), 503);
    const uncertain = await json(await request('GET', `${base}/${id}`));
    const ready = await json(await request('POST', `${base}/${id}/complete`, {}, { revision: uncertain.revision, key: 'keyed-complete' }));
    expect((await json(await request('POST', `${base}/${id}/complete`, {}, { revision: uncertain.revision, key: 'keyed-complete' }))).state).toBe('ready');
    const deleted = await json(await request('DELETE', `${base}/${id}`, undefined, { revision: ready.revision, key: 'keyed-delete' }));
    expect(deleted.state).toBe('deleted');
    expect((await json(await request('DELETE', `${base}/${id}`, undefined, { revision: ready.revision, key: 'keyed-delete' }))).state).toBe('deleted');
    expect((await accountStorage()).stored_bytes).toBe('0');

    fixture.blobs.put = originalPut;
    const readyAttachment = await json(await request('POST', base, body, { revision: (await get(issue.id)).revision }), 201);
    await json(await upload(`${base}/${readyAttachment.id}`, bytes, readyAttachment.revision));
    await json(await request('DELETE', `/v1/repos/r_main/issues/${issue.id}`, undefined, { revision: (await get(issue.id)).revision }));
    await sweepCollaboration(fixture.env);
    expect((await accountStorage()).stored_bytes).toBe('0');
    expect(fixture.db.sqlite.prepare(`SELECT o.state FROM object_manifests o JOIN collaboration_attachments a ON a.object_id=o.id WHERE a.id=?`).get(readyAttachment.id)?.state).toBe('deleted');

    const inflightParent = await createIssue('Deleted during upload');
    const inflightBase = `/v1/repos/r_main/issues/${inflightParent.id}/attachments`;
    const inflight = await json(await request('POST', inflightBase, body, { revision: 1 }), 201);
    const entered = deferred(); const release = deferred();
    fixture.blobs.put = async (...args) => { entered.resolve(); await release.promise; return originalPut(...args); };
    const writing = upload(`${inflightBase}/${inflight.id}`, bytes, inflight.revision);
    await entered.promise;
    await json(await request('DELETE', `/v1/repos/r_main/issues/${inflightParent.id}`, undefined, { revision: (await get(inflightParent.id)).revision }));
    await sweepCollaboration(fixture.env);
    expect((await accountStorage()).reserved_bytes).toBe(String(bytes.length));
    expect(fixture.db.sqlite.prepare('SELECT state FROM collaboration_attachment_cleanup WHERE attachment_id=?').get(inflight.id)?.state).toBe('blocked');
    release.resolve();
    await json(await writing, 404);
    await sweepCollaboration(fixture.env);
    expect((await accountStorage()).reserved_bytes).toBe('0');
    expect((await accountStorage()).stored_bytes).toBe('0');
    expect(fixture.db.sqlite.prepare('SELECT state FROM collaboration_attachment_cleanup WHERE attachment_id=?').get(inflight.id)?.state).toBe('completed');

    const expiredParent = await createIssue('Denied admission expires');
    control = await accountStorage();
    await admissionRequest(fixture.env, 'account:u_alice', 'limits', { max_concurrency: 1, max_storage_bytes: '1', revision: control.revision });
    const expired = await json<{ error: { details: { attachment_id: string } } }>(await request('POST', `/v1/repos/r_main/issues/${expiredParent.id}/attachments`, body, { revision: 1 }), 409);
    fixture.db.sqlite.prepare(`UPDATE object_manifests SET retention_until=? WHERE id=(SELECT object_id FROM collaboration_attachments WHERE id=?)`)
      .run(new Date(Date.now() - 1000).toISOString(), expired.error.details.attachment_id);
    await sweepCollaboration(fixture.env);
    await sweepCollaboration(fixture.env);
    expect(fixture.db.sqlite.prepare("SELECT used_bytes,reserved_bytes FROM storage_quotas WHERE scope_id='r_main'").get())
      .toMatchObject({ used_bytes: 0, reserved_bytes: 0 });
    expect((await accountStorage()).reserved_bytes).toBe('0');
  });

  it('uses personal scope independently of repository ownership and restores scoped merge authority without reviving old credentials', async () => {
    fixture.db.sqlite.prepare("UPDATE access_grants SET revoked_at=? WHERE id='grant_bob_r_public'").run(now());
    const subscription = await json(await request('POST', '/v1/subscriptions', { repo_id: 'r_public', mode: 'watching' }, { actor: 'bob' }), 201);
    await json(await request('PATCH', `/v1/subscriptions/${subscription.id}`, { mode: 'ignored' }, { actor: 'bob', revision: subscription.revision }));
    const view = await json(await request('POST', '/v1/saved-filters', { name: 'Alice public work', repo_id: 'r_public', surface: 'issues', filters: { query: 'needle' } }, { actor: 'bob' }), 201);
    await json(await request('PATCH', `/v1/saved-filters/${view.id}`, { name: 'Saved personally' }, { actor: 'bob', revision: view.revision }));
    await json(await request('POST', '/v1/subscriptions', { repo_id: 'r_main', mode: 'watching' }, { actor: 'eve' }), 404);
    const pull = await json(await request('POST', '/v1/repos/r_main/pulls', { title: 'Scoped merge credentials', base_ref: 'refs/heads/main', head_ref: 'refs/heads/feature', base_oid: BASE, head_oid: HEAD }), 201);
    async function scoped(name: string) {
      const value = await prepareCredential(fixture.env.DB, { principal_id: 'u_alice', user_id: 'u_alice', kind: 'personal', name,
        capabilities: ['contents.read', 'pull_requests.merge'], repository_ids: ['r_main'], account_ids: ['u_alice'],
        ref_patterns: ['refs/heads/main'], path_patterns: ['alpha.ts', 'beta.ts'], auth_revision: 1, mfa: true,
        expires_at: new Date(Date.now() + 86400_000).toISOString(), created_by: 'u_alice' });
      await value.statement.run(); tokens.set(name, value.token); return value;
    }
    const original = await scoped('merge-only');
    const cancelled = await json(await request('POST', `/v1/repos/r_main/pulls/${pull.id}/merge-queue`, {}, { actor: 'merge-only', revision: 1 }), 202);
    await json(await request('DELETE', `/v1/repos/r_main/pulls/${pull.id}/merge-queue/${cancelled.id}`, undefined, { actor: 'merge-only', revision: cancelled.revision }));
    const queued = await json(await request('POST', `/v1/repos/r_main/pulls/${pull.id}/merge-queue`, {}, { actor: 'merge-only', revision: (await get(pull.id, 'pulls')).revision }), 202);
    const operationId = (queued.operation as Resource).id;
    fixture.db.sqlite.prepare('UPDATE credentials SET revoked_at=?,revision=revision+1 WHERE id=?').run(now(), original.credential.id);
    const renewed = await scoped('renewed');
    await json(await request('POST', `/v1/collaboration/operations/${operationId}/resume`, {}, { actor: 'renewed', revision: 1 }), 202);
    const saved = await one<{ principal_json: string }>(fixture.env.DB, 'SELECT principal_json FROM collaboration_operation_contexts WHERE operation_id=?', operationId);
    expect((JSON.parse(saved!.principal_json) as Principal).credential_id).toBe(renewed.credential.id);
    fixture.db.sqlite.prepare('UPDATE credentials SET revoked_at=?,revision=revision+1 WHERE id=?').run(now(), renewed.credential.id);
    await runCollaborationOperation(fixture.env, operationId);
    const waiting = await one<Operation>(fixture.env.DB, 'SELECT * FROM operations WHERE id=?', operationId);
    expect(waiting?.status).toBe('waiting'); expect(waiting?.phase).toBe('authorization_required');
    const current = await scoped('current');
    await json(await request('POST', `/v1/collaboration/operations/${operationId}/resume`, {}, { actor: 'current', revision: waiting!.revision }), 202);
    await runCollaborationOperation(fixture.env, operationId);
    await runCollaborationOperation(fixture.env, operationId);
    await runCollaborationOperation(fixture.env, operationId);
    await runCollaborationOperation(fixture.env, operationId);
    const mutations = git.calls.filter(action => action === 'mutate').length;
    fixture.db.sqlite.prepare('UPDATE credentials SET revoked_at=?,revision=revision+1 WHERE id=?').run(now(), current.credential.id);
    git.publish = true; // Acknowledge the already accepted, previously uncertain publication.
    await runCollaborationOperation(fixture.env, operationId);
    expect((await one<Operation>(fixture.env.DB, 'SELECT * FROM operations WHERE id=?', operationId))?.status).toBe('completed');
    expect(fixture.db.sqlite.prepare('SELECT state FROM collaboration_items WHERE id=?').get(pull.id)?.state).toBe('merged');
    expect(git.calls.filter(action => action === 'mutate').length).toBe(mutations);
  });

  it('keeps a merge pending through missing/untrusted checks and an uncertain native publication, then reconciles only the verified candidate', async () => {
    fixture.db.sqlite.prepare(`INSERT INTO repository_rules(id,account_id,repo_id,name,target_json,config_json,created_by,created_at,updated_at)
      VALUES ('rule_merge','u_alice','r_main','Required trusted test',?,?, 'u_alice',?,?)`)
      .run(JSON.stringify('refs/heads/main'), JSON.stringify({ verification: { required: ['verify.test'], trusted_producers: ['hosted:trusted'] } }), now(), now());
    const issue = await createIssue('Close after canonical merge');
    const pull = await json(await request('POST', '/v1/repos/r_main/pulls', { title: 'Protected merge', base_ref: 'refs/heads/main', head_ref: 'refs/heads/feature', base_oid: BASE, head_oid: HEAD }), 201);
    await json(await request('POST', `/v1/repos/r_main/issues/${issue.id}/pulls`, { pull_id: pull.id, closes_issue: true }, { revision: 1 }), 201);
    const queued = await json(await request('POST', `/v1/repos/r_main/pulls/${pull.id}/merge-queue`, {}, { revision: 1 }), 202);
    const operationId = (queued.operation as Resource).id;
    await runCollaborationOperation(fixture.env, operationId);
    await runCollaborationOperation(fixture.env, operationId);
    let queue = await json(await request('GET', `/v1/repos/r_main/pulls/${pull.id}/merge-queue/${queued.id}`));
    expect(queue.state).toBe('verifying');
    let eligibility = await json(await request('GET', `/v1/repos/r_main/pulls/${pull.id}/merge-eligibility?candidate_id=${queue.candidate_id}`));
    expect(eligibility.eligible).toBe(false);
    await seedVerification(false, 1);
    eligibility = await json(await request('GET', `/v1/repos/r_main/pulls/${pull.id}/merge-eligibility?candidate_id=${queue.candidate_id}`));
    expect(eligibility.eligible).toBe(false);
    await seedVerification(true, 2);
    eligibility = await json(await request('GET', `/v1/repos/r_main/pulls/${pull.id}/merge-eligibility?candidate_id=${queue.candidate_id}`));
    expect(eligibility.eligible).toBe(true);
    await runCollaborationOperation(fixture.env, operationId);
    await runCollaborationOperation(fixture.env, operationId);
    expect((await get(pull.id, 'pulls')).state).toBe('open');
    expect((await get(issue.id)).state).toBe('open');
    expect((await one<Operation>(fixture.env.DB, 'SELECT * FROM operations WHERE id=?', operationId))?.status).toBe('waiting');
    git.publish = true;
    await runCollaborationOperation(fixture.env, operationId);
    expect((await get(pull.id, 'pulls')).state).toBe('merged');
    expect((await get(issue.id)).state).toBe('closed');
    queue = await json(await request('GET', `/v1/repos/r_main/pulls/${pull.id}/merge-queue/${queued.id}`));
    expect(queue.state).toBe('merged');
    expect((await one<Operation>(fixture.env.DB, 'SELECT * FROM operations WHERE id=?', operationId))?.status).toBe('completed');
  });

  it('anchors a suggested change to a real patch version and records application only after verified source publication', async () => {
    const pull = await json(await request('POST', '/v1/repos/r_main/pulls', { title: 'Anchored suggestion', base_ref: 'refs/heads/main', head_ref: 'refs/heads/feature', base_oid: BASE, head_oid: HEAD }), 201);
    const originalPatch = (pull.patch as Resource).id;
    const thread = await json(await request('POST', `/v1/repos/r_main/pulls/${pull.id}/threads`, {
      patch_id: originalPatch, path: 'alpha.ts', side: 'new', start_line: 2, end_line: 2, markdown: 'Use the supported API.',
    }, { actor: 'bob', revision: 1 }), 201);
    const suggestion = await json(await request('POST', `/v1/repos/r_main/pulls/${pull.id}/suggestions`, {
      thread_id: thread.id, replacement: 'supportedApi();\n',
    }, { actor: 'bob', revision: 2 }), 201);
    const applying = await json(await request('POST', `/v1/repos/r_main/pulls/${pull.id}/suggestions/${suggestion.id}/apply`, { pull_revision: 3 }, { revision: 1 }), 202);
    expect(applying.state).toBe('applying');
    expect((await get(pull.id, 'pulls')).head_oid).toBe(HEAD);
    await runCollaborationOperation(fixture.env, (applying.operation as Resource).id);
    const applied = await json(await request('GET', `/v1/repos/r_main/pulls/${pull.id}/suggestions/${suggestion.id}`));
    expect(applied.state).toBe('applied');
    expect(applied.applied_patch_id).not.toBe(originalPatch);
    const updated = await get(pull.id, 'pulls');
    expect(updated.head_oid).toBe(SUGGESTED);
    const resolved = await json(await request('GET', `/v1/repos/r_main/pulls/${pull.id}/threads/${thread.id}`));
    expect(resolved.patch_id).toBe(originalPatch);
    expect(resolved.resolved_at).toBeTruthy();
  });

  async function seedVerification(trusted: boolean, generation: number, options: { commit?: string; job?: string } = {}): Promise<void> {
    const at = new Date(Date.now() - 5000 + generation * 100).toISOString();
    const workflowDigest = await sha256('approved workflow definition');
    const commit = options.commit ?? CANDIDATE;
    const jobKey = options.job ?? 'test';
    const plan = { version: 1, repo_id: 'r_main', account_id: 'u_alice', commit_sha: commit, workflow_digest: workflowDigest, trust: trusted ? 'trusted' : 'untrusted',
      policy_revision: 1, jobs: [{ key: jobKey, producer_id: 'hosted:trusted', applicable: true, inapplicable_reason: null,
        toolchain: { digest: 'toolchain-pinned' } }] };
    const planJson = JSON.stringify(plan);
    const digest = await sha256(planJson);
    const run = `run_fixture_${generation}`;
    const job = `job_fixture_${generation}`;
    const attempt = `attempt_fixture_${generation}`;
    if (generation === 1) {
      fixture.db.sqlite.prepare(`INSERT INTO workflows(id,repo_id,account_id,name,path,current_version_id,created_by,created_at,updated_at)
        VALUES ('workflow_fixture','r_main','u_alice','verify','.gitknot/workflows/verify.yml','version_fixture','u_alice',?,?)`).run(at, at);
      fixture.db.sqlite.prepare(`INSERT INTO workflow_versions(id,workflow_id,repo_id,account_id,source_commit,definition_digest,definition,definition_json,policy_revision,approved_by,created_at)
        VALUES ('version_fixture','workflow_fixture','r_main','u_alice',?,?,'version: 1','{}',1,'u_alice',?)`).run(BASE, workflowDigest, at);
    }
    fixture.db.sqlite.prepare(`INSERT INTO workflow_runs(id,repo_id,account_id,workflow_id,workflow_version_id,commit_sha,source_ref,workflow_digest,plan_digest,plan_json,
      policy_revision,trigger_type,trigger_id,trust,status,requested_by,request_key,request_hash,created_at,updated_at)
      VALUES (?,'r_main','u_alice','workflow_fixture','version_fixture',?,'refs/heads/main',?,?,?,1,'merge_candidate.created','candidate_fixture',?,'succeeded','u_alice',?,?,?,?)`)
      .run(run, commit, workflowDigest, digest, planJson, trusted ? 'trusted' : 'untrusted', run, digest, at, at);
    fixture.db.sqlite.prepare(`INSERT INTO workflow_jobs(id,repo_id,account_id,run_id,job_key,definition_json,status,current_attempt_id,created_at,updated_at)
      VALUES (?,'r_main','u_alice',?,?,'{}','succeeded',?,?,?)`).run(job, run, jobKey, attempt, at, at);
    fixture.db.sqlite.prepare(`INSERT INTO execution_attempts(id,repo_id,account_id,run_id,job_id,generation,plan_digest,toolchain_digest,producer_id,executor,profile,status,
      queue_deadline_at,receipt_hash,created_at,updated_at) VALUES (?,'r_main','u_alice',?,?,1,?,'toolchain-pinned','hosted:trusted','hosted','linux-small','succeeded',?,'verified-receipt',?,?)`)
      .run(attempt, run, job, digest, new Date(Date.now() + 60000).toISOString(), at, at);
    fixture.db.sqlite.prepare(`INSERT INTO workflow_verifications(id,repo_id,account_id,run_id,job_id,attempt_id,commit_sha,workflow_digest,plan_digest,policy_revision,producer_id,toolchain_digest,conclusion,created_at)
      VALUES (?,'r_main','u_alice',?,?,?,?,?,?,1,'hosted:trusted','toolchain-pinned','succeeded',?)`).run(`check_fixture_${generation}`, run, job, attempt, commit, workflowDigest, digest, at);
  }

  it('coordinates overlapping claims, fences expired heartbeats, and completes multi-page scans with authorized checksummed results', async () => {
    const task = await json(await request('POST', '/v1/repos/r_main/tasks', { title: 'Parallel migration', accountable_user_id: 'u_alice',
      contributor_ids: ['u_bob'], base_oid: BASE }), 201);
    const workspace = await json(await request('POST', `/v1/repos/r_main/tasks/${task.id}/workspaces`, {}, { revision: 1 }), 202);
    expect(workspace.state).toBe('provisioning');
    expect(fixture.db.sqlite.prepare('SELECT visibility,state,default_branch FROM repositories WHERE id=?').get(String(workspace.workspace_repo_id)))
      .toMatchObject({ visibility: 'private', state: 'provisioning', default_branch: 'work' });
    await runCollaborationOperation(fixture.env, (workspace.operation as Resource).id);
    expect((await one<Operation>(fixture.env.DB, 'SELECT * FROM operations WHERE id=?', (workspace.operation as Resource).id))?.status).toBe('waiting');
    expect((await json<Listing>(await request('GET', `/v1/repos/r_main/tasks/${task.id}/workspaces`, undefined, { actor: 'bob' }))).items).toHaveLength(0);
    const claim = await json(await request('POST', `/v1/repos/r_main/tasks/${task.id}/claims`, { description: 'API changes', paths: ['src/api'], lease_seconds: 30 }, { actor: 'bob', revision: 2 }), 201);
    const other = await json(await request('POST', `/v1/repos/r_main/tasks/${task.id}/claims`, { description: 'API compatibility', paths: ['src/api/routes'] }, { revision: 3 }), 201);
    expect((other.overlaps as Listing).items.some(value => value.id === claim.id)).toBe(true);
    fixture.db.sqlite.prepare('UPDATE task_claims SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), claim.id);
    await json(await request('POST', `/v1/repos/r_main/tasks/${task.id}/claims/${claim.id}/heartbeat`, {}, { actor: 'bob', revision: 1 }), 409);
    await sweepCollaboration(fixture.env);
    expect(fixture.db.sqlite.prepare('SELECT state FROM task_claims WHERE id=?').get(claim.id)?.state).toBe('expired');
    const scan = await json(await request('POST', '/v1/search/code-scans', { repositories: [{ repo_id: 'r_main', commit_oid: BASE }], query: 'needle' }), 202);
    const operation = await one<Operation>(fixture.env.DB, 'SELECT * FROM operations WHERE id=?', (scan.operation as Resource).id);
    const result = await runCodeScan(operationsEnv(), operation!);
    expect(result.complete).toBe(true);
    const first = await json<Listing>(await request('GET', `/v1/search/code-scans/${scan.id}/results?limit=1`));
    expect(first.items[0]?.path).toBe('alpha.ts');
    const second = await json<Listing>(await request('GET', `/v1/search/code-scans/${scan.id}/results?limit=1&cursor=${first.next_cursor}`));
    expect(second.items[0]?.path).toBe('beta.ts');
    expect(second.coverage?.complete_for_eligible_text).toBe(true);
    await json(await request('GET', `/v1/search/code-scans/${scan.id}/results`, undefined, { actor: 'eve' }), 404);
    expect(git.calls.filter(value => value === 'collaboration/inspect').length).toBeGreaterThanOrEqual(3);
    fixture.db.sqlite.prepare("UPDATE principals SET disabled_at=? WHERE id='svc_collaboration_maintenance'").run(now());
    await expect(sweepCollaboration(fixture.env)).rejects.toMatchObject({ code: 'maintenance_authority_unavailable' });
  });

  it('reads repository-local collaboration across cell placements and gives managed or linked SSO users their own scoped state', async () => {
    const remote = await createTestDatabase(), destination = await createTestDatabase();
    try {
      const at = now(), accountId = 'org_global_scope';
      await fixture.env.DB.batch([
        stmt(fixture.env.DB, `INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at)
          VALUES (?,'organization','global-scope','Global scope','u_alice',?,?)`, accountId, at, at),
        stmt(fixture.env.DB, `INSERT INTO memberships(account_id,principal_id,role_id,state,created_by,created_at,updated_at)
          VALUES (?,'u_alice','owner','active','u_alice',?,?),(?,'u_bob','reader','active','u_alice',?,?)`, accountId, at, at, accountId, at, at),
      ]);
      const managed = await prepareManagedUser(fixture.env.DB, { email: 'managed-global@example.test', display_name: 'Managed collaborator',
        verified: true, actor_id: 'u_alice', user_id: 'u_managed_global' });
      await fixture.env.DB.batch([...managed.statements, stmt(fixture.env.DB, `INSERT INTO memberships(account_id,principal_id,role_id,state,created_by,created_at,updated_at)
        VALUES (?,?,'reader','active','u_alice',?,?)`, accountId, managed.user.id, at, at)]);
      for (const table of ['users', 'accounts', 'principals']) for (const row of fixture.db.sqlite.prepare(`SELECT * FROM ${table}`).all()) {
        for (const db of [remote, destination]) {
          if (db.sqlite.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(String(row.id))) continue;
          const columns = Object.keys(row);
          db.sqlite.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
            .run(...columns.map(column => row[column] as string | number | null));
        }
      }
      await remote.prepare(`INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
        VALUES ('r_remote_global',?,'remote-global','remote-global','private','active','east','data','remote-global','u_alice',?,?)`).bind(accountId, at, at).run();
      await stmt(fixture.env.DB, `INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,epoch,state,updated_at)
        VALUES ('r_remote_global','repository','east','data',1,'active',?)`, at).run();
      Object.assign(fixture.env, identityAuthorityBindings(fixture.env));
      const east: Bindings = { ...fixture.env, DB: remote.binding(), CELL_ID: 'east', SHARD_ID: 'data', ROOT_DB: remote.binding(), ROOT_CELL_ID: 'east', ROOT_SHARD_ID: 'data',
        ARCHIVE_DB: destination.binding(), SHARD_BINDINGS_JSON: JSON.stringify({ data: 'DB', archive: 'ARCHIVE_DB' }),
        CELL_BINDINGS_JSON: JSON.stringify({ local: 'HOME_API' }) };
      fixture.env.CELL_BINDINGS_JSON = JSON.stringify({ east: 'EAST_API' });
      fixture.env.EAST_API = { fetch: (incoming: Request) => app.fetch(incoming, east, fixture.context) };
      east.HOME_API = { fetch: (incoming: Request) => app.fetch(incoming, fixture.env, fixture.context) };
      app.all('/internal/routing', async c => (await handleRoutingRpc(c.req.raw, c.env))!);
      const issue = await createIssue('needle in the current remote cell', { assignee_ids: ['u_bob'], markdown: 'Visible remote evidence.' }, 'r_remote_global');
      const event = await one<{ event_json: string }>(remote.binding(), "SELECT event_json FROM outbox WHERE type='issue.created' ORDER BY created_at DESC LIMIT 1");
      await indexEvent(east as OperationsBindings, JSON.parse(event!.event_json) as EventRecord);
      expect((await get(issue.id, 'issues', 'r_remote_global')).id).toBe(issue.id);
      const searched = await json<Listing>(await request('GET', '/v1/search?repo_id=r_remote_global&q=needle'));
      expect.soft(searched.items.some(item => item.id === issue.id)).toBe(true);
      expect.soft((searched.coverage?.repositories as Array<{ authoritative_documents: number }>)[0]?.authoritative_documents).toBe(1);
      const activity = await json<Listing>(await request('GET', '/v1/feed?scope=repository&repo_id=r_remote_global'));
      expect.soft(activity.items.some(item => item.item_id === issue.id)).toBe(true);
      const notifications = await json<Listing>(await request('GET', '/v1/inbox', undefined, { actor: 'bob' }));
      expect.soft(notifications.items.some(item => item.item_id === issue.id)).toBe(true);

      const config = providerConfigSchema.parse({ protocol: 'oidc', issuer: 'https://issuer.example.test', client_id: 'collaboration',
        authorization_endpoint: 'https://issuer.example.test/authorize', token_endpoint: 'https://issuer.example.test/token',
        jwks_uri: 'https://issuer.example.test/jwks', token_endpoint_auth_method: 'none', tenant_claim: 'tid', tenant_values: ['collaboration'],
        external_id_claim: 'oid', provisioning: 'jit', mappings: { default_role_id: 'reader', role_ceiling: ['reader'], capability_ceiling: ['*'] } });
      await stmt(fixture.env.DB, `INSERT INTO federation_providers(id,account_id,name,protocol,enabled,config_json,created_by,created_at,updated_at)
        VALUES ('fp_global',?,'Global SSO','oidc',1,?,'u_alice',?,?)`, accountId, JSON.stringify(config), at, at).run();
      fixture.env.FEDERATION_IDENTITY_CONTRACT = FEDERATION_IDENTITY_CONTRACT;
      east.FEDERATION_IDENTITY_CONTRACT = FEDERATION_IDENTITY_CONTRACT;
      for (const userId of [managed.user.id, 'u_bob']) {
        const credential = await prepareCredential(fixture.env.DB, { principal_id: userId, user_id: userId, kind: 'session', name: 'Organization-scoped SSO',
          capabilities: null, repository_ids: null, account_ids: null, auth_revision: 1, mfa: true,
          authenticated_at: at, expires_at: new Date(Date.now() + 3600_000).toISOString(), created_by: userId });
        await fixture.env.DB.batch([
          credential.statement,
          stmt(fixture.env.DB, `INSERT INTO federation_subjects(id,account_id,provider_id,issuer,subject,tenant,user_id,external_id,state,created_at,updated_at)
            VALUES (?,?,'fp_global',?,?, 'collaboration',?,?,'active',?,?)`, `fs_${userId}`, accountId, config.issuer, userId, userId, userId, at, at),
          stmt(fixture.env.DB, `INSERT INTO federation_session_grants(account_id,credential_id,provider_id,provider_revision,policy_revision,subject_id,user_id,authenticated_at,mfa,expires_at)
            VALUES (?,?,'fp_global',1,0,?,?,?,1,?)`, accountId, credential.credential.id, `fs_${userId}`, userId, at, credential.credential.expires_at),
        ]);
        const options = { actor: null, headers: { cookie: `gitknot_session=${credential.token}` } };
        expect((await request('GET', `/v1/repos/r_remote_global/issues/${issue.id}`, undefined, options)).status).toBe(200);
        for (const path of ['/v1/feed', '/v1/inbox', '/v1/subscriptions', '/v1/saved-filters']) {
          expect.soft((await request('GET', path, undefined, options)).status, `${userId} ${path}`).toBe(200);
        }
        expect((await request('GET', '/v1/repos/r_public/issues', undefined, options)).status).toBe(404);
      }
      expect(await one(fixture.env.DB, "SELECT id FROM accounts WHERE type='user' AND owner_user_id=?", managed.user.id)).toBeNull();
    } finally { remote.close(); destination.close(); }
  });

  it('keeps global views and OIDC/SAML user state authorized across real Workerd shards, a completed move and a cell outage', async () => {
    const [{ build }, { Miniflare, Response: WorkerResponse, convertV4MiniflareOptions }] = await Promise.all([import('esbuild'), import('miniflare')]);
    const root = await mkdtemp(join(tmpdir(), 'collaboration-global-workerd-'));
    let runtime: InstanceType<typeof Miniflare> | undefined;
    let native: Awaited<ReturnType<typeof nativeHttpFixture>> | undefined;
    let nativeService: Fetcher | undefined;
    let westUnavailable = false;
    const readFaults: { afterWindow?: (window: WindowResponse) => Promise<void>; afterReference?: (input: ReferenceRequest) => Promise<void> } = {};
    try {
      const compiled = await build({ absWorkingDir: process.cwd(), entryPoints: ['apps/api/src/index.ts'], bundle: true, write: false,
        format: 'esm', platform: 'neutral', target: 'es2023', conditions: ['workerd', 'browser'], mainFields: ['module', 'main'],
        external: ['node:*', 'cloudflare:*'], alias: { crypto: 'node:crypto', util: 'node:util' },
        banner: { js: "import {createRequire as __createRequire} from 'node:module';const require=__createRequire('/collaboration-global.js');" } });
      // Logical loopback URLs satisfy Miniflare's Origin guard; getWorker() uses
      // its private in-process transport and binds none of these ports.
      const shared = { ENVIRONMENT: 'test', API_ORIGIN: 'http://localhost:17887', APP_ORIGIN: 'http://localhost:17573',
        GIT_ORIGIN: 'http://localhost:17888', INTERNAL_SERVICE_KEY: fixture.env.INTERNAL_SERVICE_KEY, SESSION_KEY: String(fixture.env.SESSION_KEY),
        IDENTITY_KEYS_JSON: String(fixture.env.IDENTITY_KEYS_JSON), IDENTITY_CELL_ID: 'local', IDENTITY_SHARD_ID: 'core', FEDERATION_IDENTITY_CONTRACT };
      const definitions: Array<{ name: string; cell: string; shard: string; databases: Record<string, string>; shards: Record<string, string> }> = [
        { name: 'home', cell: 'local', shard: 'core', databases: { DB: 'identity', IDENTITY_DB: 'identity', DIRECTORY_DB: 'directory', SEARCH_DB: 'home-search' }, shards: { core: 'DB' } },
        { name: 'east', cell: 'east', shard: 'data', databases: { DB: 'east-data', IDENTITY_DB: 'identity', DIRECTORY_DB: 'directory', SEARCH_DB: 'east-search', ARCHIVE_DB: 'east-archive' }, shards: { data: 'DB', archive: 'ARCHIVE_DB' } },
        { name: 'west', cell: 'west', shard: 'data', databases: { DB: 'west-data', IDENTITY_DB: 'identity', DIRECTORY_DB: 'directory', SEARCH_DB: 'west-search', EXTRA_DB: 'west-extra' }, shards: { data: 'DB', extra: 'EXTRA_DB' } },
      ];
      const unavailable = async (incoming: MiniflareRequest): Promise<MiniflareResponse> => {
        if (westUnavailable && new URL(incoming.url).pathname === '/internal/collaboration/read') return new WorkerResponse(JSON.stringify({ error: { code: 'injected_cell_outage' } }),
          { status: 503, headers: { 'content-type': 'application/json' } });
        return (await runtime!.getWorker('west')).fetch(incoming.url, { method: incoming.method, headers: Object.fromEntries(incoming.headers),
          ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: await incoming.arrayBuffer() }) });
      };
      const eastTransport = async (incoming: MiniflareRequest): Promise<MiniflareResponse> => {
        const bytes = ['GET', 'HEAD'].includes(incoming.method) ? undefined : await incoming.arrayBuffer();
        const input = new URL(incoming.url).pathname === '/internal/collaboration/read' && bytes
          ? JSON.parse(new TextDecoder().decode(bytes)) as { action: string } : null;
        const response = await (await runtime!.getWorker('east')).fetch(incoming.url, { method: incoming.method,
          headers: Object.fromEntries(incoming.headers), ...(bytes ? { body: bytes } : {}) });
        if (response.ok && input?.action === 'window' && readFaults.afterWindow) {
          const hook = readFaults.afterWindow; readFaults.afterWindow = undefined;
          await hook((await response.clone().json() as { result: WindowResponse }).result);
        }
        if (response.ok && input?.action === 'reference' && readFaults.afterReference) await readFaults.afterReference(input as ReferenceRequest);
        return response;
      };
      const nativeTransport = async (incoming: MiniflareRequest): Promise<MiniflareResponse> => {
        if (!nativeService) throw new Error('The native HTTP fixture has not started.');
        const response = await nativeService.fetch(new Request(incoming.url, { method: incoming.method, headers: Object.fromEntries(incoming.headers),
          ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: await incoming.arrayBuffer() }) }));
        return new WorkerResponse(await response.arrayBuffer(), { status: response.status, headers: Object.fromEntries(response.headers) });
      };
      runtime = new Miniflare(convertV4MiniflareOptions({ cf: false, workers: definitions.map(definition => ({ name: definition.name,
        modules: true as const, script: compiled.outputFiles[0]!.text, compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
        d1Databases: definition.databases, bindings: { ...shared, CELL_ID: definition.cell, SHARD_ID: definition.shard,
          SHARD_BINDINGS_JSON: JSON.stringify(definition.shards), CELL_BINDINGS_JSON: JSON.stringify({ local: 'HOME_API', east: 'EAST_API', west: 'WEST_API' }) },
        serviceBindings: { HOME_API: 'home', EAST_API: definition.name === 'east' ? 'east' : eastTransport,
          WEST_API: definition.name === 'west' ? 'west' : unavailable, GIT_SERVICE: nativeTransport },
      })) }));
      await runtime.ready;
      const db = await runtime.getD1Database('DB', 'home') as unknown as D1Database;
      const directory = await runtime.getD1Database('DIRECTORY_DB', 'home') as unknown as D1Database;
      const eastData = await runtime.getD1Database('DB', 'east') as unknown as D1Database;
      const eastArchive = await runtime.getD1Database('ARCHIVE_DB', 'east') as unknown as D1Database;
      const westData = await runtime.getD1Database('DB', 'west') as unknown as D1Database;
      const westExtra = await runtime.getD1Database('EXTRA_DB', 'west') as unknown as D1Database;
      const homeSearch = await runtime.getD1Database('SEARCH_DB', 'home') as unknown as D1Database;
      const eastSearch = await runtime.getD1Database('SEARCH_DB', 'east') as unknown as D1Database;
      const westSearch = await runtime.getD1Database('SEARCH_DB', 'west') as unknown as D1Database;
      await Promise.all([db, directory, eastData, eastArchive, westData, westExtra].map(target => copyWorkerdDatabase(target, fixture.db)));
      await Promise.all([homeSearch, eastSearch, westSearch].map(target => copyWorkerdDatabase(target, search, true)));
      const worker = await runtime.getWorker('home');
      const call = (path: string, options: { method?: string; body?: unknown; cookie?: string; token?: string; revision?: number; key?: string; anonymous?: boolean } = {}) => worker.fetch(`${shared.API_ORIGIN}${path}`, {
        method: options.method ?? 'GET', headers: { origin: shared.APP_ORIGIN, 'x-gitknot-csrf': '1',
          ...(options.cookie ? { cookie: options.cookie } : options.anonymous ? {} : { authorization: `Bearer ${options.token ?? tokens.get('alice')}` }),
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.revision === undefined ? {} : { 'if-match': `"${options.revision}"` }), ...(options.key ? { 'idempotency-key': options.key } : {}) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      async function result<T = Resource>(response: { status: number; text(): Promise<string> }, status = 200): Promise<T> {
        const text = await response.text();
        expect(response.status, text).toBe(status);
        return JSON.parse(text) as T;
      }
      const binding = async (name: string): Promise<Fetcher> => {
        const target = await runtime!.getWorker(name);
        return { fetch: async (incoming: Request) => target.fetch(incoming.url, { method: incoming.method, headers: Object.fromEntries(incoming.headers),
          ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: new Uint8Array(await incoming.arrayBuffer()) }) }) } as unknown as Fetcher;
      };
      const home: Bindings = { ...fixture.env, DB: db, IDENTITY_DB: db, IDENTITY_CELL_ID: 'local', IDENTITY_SHARD_ID: 'core',
        DIRECTORY_DB: directory, SEARCH_DB: homeSearch, CELL_ID: 'local', SHARD_ID: 'core', FEDERATION_IDENTITY_CONTRACT,
        CELL_BINDINGS_JSON: JSON.stringify({ local: 'HOME_API', east: 'EAST_API', west: 'WEST_API' }),
        HOME_API: await binding('home'), EAST_API: await binding('east'), WEST_API: await binding('west') };
      home.ADMISSION = billingNamespace(home);
      const east: Bindings = { ...home, DB: eastData, SEARCH_DB: eastSearch, CELL_ID: 'east', SHARD_ID: 'data', ROOT_DB: eastData, ROOT_CELL_ID: 'east', ROOT_SHARD_ID: 'data',
        ARCHIVE_DB: eastArchive, SHARD_BINDINGS_JSON: JSON.stringify({ data: 'DB', archive: 'ARCHIVE_DB' }) };
      const west: Bindings = { ...home, DB: westExtra, SEARCH_DB: westSearch, CELL_ID: 'west', SHARD_ID: 'extra', ROOT_DB: westData, ROOT_CELL_ID: 'west', ROOT_SHARD_ID: 'data',
        EXTRA_DB: westExtra, SHARD_BINDINGS_JSON: JSON.stringify({ data: 'DB', extra: 'EXTRA_DB' }) };
      const at = now(), accountId = 'org_workerd_global';
      await db.batch([
        stmt(db, `INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES (?,'organization','workerd-global','Workerd global','u_alice',?,?)`, accountId, at, at),
        stmt(db, `INSERT INTO memberships(account_id,principal_id,role_id,state,created_by,created_at,updated_at) VALUES (?,'u_alice','owner','active','u_alice',?,?)`, accountId, at, at),
      ]);
      const certificatePath = join(root, 'saml.crt');
      await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'saml.key'), '-out', certificatePath,
        '-days', '1', '-subj', '/CN=collaboration-sso.example.test']);
      const certificate = await readFile(certificatePath, 'utf8');
      const sessions: Array<{ user_id: string; cookie: string; protocol: string }> = [];
      for (const [protocol, userId, managed] of [['oidc', 'u_workerd_oidc', true], ['saml', 'u_workerd_saml', true], ['oidc', 'u_bob', false]] as const) {
        if (managed) await db.batch((await prepareManagedUser(db, { user_id: userId, email: `${userId}@example.test`, display_name: userId,
          verified: true, actor_id: 'u_alice' })).statements);
        await stmt(db, `INSERT INTO memberships(account_id,principal_id,role_id,state,created_by,created_at,updated_at)
          VALUES (?,?,'reader','active','u_alice',?,?)`, accountId, userId, at, at).run();
        const providerId = `fp_${userId}`;
        const common = { tenant_claim: 'tid', tenant_values: ['global'], external_id_claim: 'oid', provisioning: 'jit',
          mappings: { default_role_id: 'reader', role_ceiling: ['reader'], capability_ceiling: ['*'] } };
        const config = providerConfigSchema.parse(protocol === 'oidc' ? { ...common, protocol, issuer: 'https://issuer.example.test', client_id: providerId,
          authorization_endpoint: 'https://issuer.example.test/authorize', token_endpoint: 'https://issuer.example.test/token', jwks_uri: 'https://issuer.example.test/jwks', token_endpoint_auth_method: 'none' }
          : { ...common, protocol, issuer: 'https://issuer.example.test/saml', sso_url: 'https://issuer.example.test/sso', signing_certificates: [certificate] });
        const credential = await prepareCredential(db, { principal_id: userId, user_id: userId, kind: 'session', name: `${protocol} scoped session`,
          capabilities: null, repository_ids: null, account_ids: null, auth_revision: 1, mfa: true, authenticated_at: at,
          expires_at: new Date(Date.now() + 3600_000).toISOString(), created_by: userId });
        await db.batch([
          stmt(db, `INSERT INTO federation_providers(id,account_id,name,protocol,enabled,config_json,created_by,created_at,updated_at)
            VALUES (?,?,?, ?,1,?,'u_alice',?,?)`, providerId, accountId, protocol, protocol, JSON.stringify(config), at, at),
          stmt(db, `INSERT INTO federation_subjects(id,account_id,provider_id,issuer,subject,tenant,user_id,external_id,state,created_at,updated_at)
            VALUES (?,?,?,?,?,'global',?,?,'active',?,?)`, `fs_${userId}`, accountId, providerId, config.issuer, userId, userId, userId, at, at),
          credential.statement,
          stmt(db, `INSERT INTO federation_session_grants(account_id,credential_id,provider_id,provider_revision,policy_revision,subject_id,user_id,authenticated_at,mfa,expires_at)
            VALUES (?,?,?,1,0,?,?,?,1,?)`, accountId, credential.credential.id, providerId, `fs_${userId}`, userId, at, credential.credential.expires_at),
        ]);
        sessions.push({ user_id: userId, cookie: `gitknot_session=${credential.token}`, protocol });
      }
      for (const target of [eastData, westExtra]) {
        const account = await one<Record<string, unknown>>(db, 'SELECT * FROM accounts WHERE id=?', accountId);
        await stmt(target, `INSERT INTO accounts(${Object.keys(account!).join(',')}) VALUES (${Object.keys(account!).map(() => '?').join(',')})`, ...Object.values(account!)).run();
        for (const person of sessions.filter(value => value.user_id !== 'u_bob')) for (const table of ['users', 'principals']) {
          const row = (await one<Record<string, unknown>>(db, `SELECT * FROM ${table} WHERE id=?`, person.user_id))!;
          await stmt(target, `INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, ...Object.values(row)).run();
        }
      }
      for (const [target, repoId, cell, shard] of [[eastData, 'r_workerd_global', 'east', 'data'], [westExtra, 'r_workerd_west', 'west', 'extra']] as const) {
        await stmt(target, `INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,'active',?,?,?,'u_alice',?,?)`, repoId, accountId, repoId, repoId, cell === 'east' ? 'public' : 'private', cell, shard, repoId, at, at).run();
        await stmt(directory, `INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,epoch,state,updated_at)
          VALUES (?,'repository',?,?,1,'active',?)`, repoId, cell, shard, at).run();
      }
      const eastIssue = await result(await call('/v1/repos/r_workerd_global/issues', { method: 'POST', body: { title: 'needle east source', markdown: 'Current east authority.', assignee_ids: sessions.map(value => value.user_id) } }), 201);
      const westIssue = await result(await call('/v1/repos/r_workerd_west/issues', { method: 'POST', body: { title: 'needle west source', markdown: 'Configured non-default west shard.' } }), 201);
      for (const env of [east, west]) {
        const event = await one<{ event_json: string }>(env.DB, "SELECT event_json FROM outbox WHERE type='issue.created' ORDER BY created_at DESC LIMIT 1");
        await indexEvent(env as OperationsBindings, JSON.parse(event!.event_json) as EventRecord);
      }
      const visible = await result<Listing>(await call('/v1/search?q=needle'));
      expect(visible.items.map(row => row.id).sort()).toEqual([eastIssue.id, westIssue.id].sort());
      const first = await result<Listing>(await call('/v1/search?q=needle&limit=1'));
      expect(first.items).toHaveLength(1); expect(first.next_cursor).toMatch(/^s1\./);
      const personalView = await result(await call('/v1/saved-filters', { method: 'POST', token: tokens.get('bob'), body: { name: 'Scoped view', repo_id: 'r_public', surface: 'issues', filters: {} } }), 201);
      for (const session of sessions) {
        const options = { cookie: session.cookie };
        expect((await call('/v1/repos/r_public/issues', options)).status).toBe(404);
        for (const path of ['/v1/feed', '/v1/inbox', '/v1/subscriptions', '/v1/saved-filters']) expect((await call(path, options)).status).toBe(200);
        const subscription = await result(await call('/v1/subscriptions', { ...options, method: 'POST', key: `subscription-${session.user_id}`,
          body: { repo_id: 'r_workerd_global', item_id: eastIssue.id, mode: 'watching' } }), 201);
        expect(subscription.context_account_id).toBe(accountId);
        expect((await result(await call('/v1/subscriptions', { ...options, method: 'POST', key: `subscription-${session.user_id}`,
          body: { repo_id: 'r_workerd_global', item_id: eastIssue.id, mode: 'watching' } }), 201)).id).toBe(subscription.id);
        const saved = await result(await call('/v1/saved-filters', { ...options, method: 'POST', body: { name: 'Scoped view', repo_id: 'r_workerd_global', surface: 'issues', filters: { query: 'needle' } } }), 201);
        expect(saved.context_account_id).toBe(accountId);
        expect((await call(`/v1/saved-filters/${personalView.id}`, options)).status).toBe(404);
        expect((await result<Listing>(await call('/v1/feed', options))).items.some(row => row.item_id === eastIssue.id)).toBe(true);
        const inbox = await result<Listing>(await call('/v1/inbox', options));
        const notification = inbox.items.find(row => row.item_id === eastIssue.id)!;
        expect(notification).toBeDefined();
        const updates = await Promise.all([true, false].map(read => call(`/v1/inbox/${notification.id}`, { ...options, method: 'PATCH', revision: notification.revision, body: { read } })));
        expect(updates.map(value => value.status).sort()).toEqual([200, 412]);
        if (session.user_id === 'u_workerd_oidc') {
          const recipient = (await authenticate(new Request(home.API_ORIGIN, { headers: { cookie: session.cookie } }), home))!;
          const deliveryContext = backgroundContext(home, recipient);
          const ready = await readInboxForDelivery(deliveryContext, notification.id);
          expect(ready).not.toBeNull();
          await db.batch(inboxDeliveryUserStateGuards(db, ready!.user_state));
          const muted = await result(await call(`/v1/subscriptions/${subscription.id}`, { ...options, method: 'PATCH', revision: subscription.revision, body: { mode: 'ignored' } }));
          await expect(db.batch(inboxDeliveryUserStateGuards(db, ready!.user_state))).rejects.toThrow();
          expect(await readInboxForDelivery(backgroundContext(home, recipient), notification.id)).toBeNull();
          await result(await call(`/v1/subscriptions/${subscription.id}`, { ...options, method: 'PATCH', revision: muted.revision, body: { mode: 'watching' } }));
        }
      }
      expect(await one(db, "SELECT COUNT(*) AS n FROM accounts WHERE type='user' AND owner_user_id IN ('u_workerd_oidc','u_workerd_saml')")).toEqual({ n: 0 });
      expect(await one(eastData, 'SELECT COUNT(*) AS n FROM collaboration_user_subscriptions')).toEqual({ n: 0 });

      const canonical = join(root, 'r_workerd_global.git');
      await new NativeGit(root, { ...DEFAULT_GIT_LIMITS }, Date.now() + 120_000, true).run(['init', '--bare', '--initial-branch=main', canonical]);
      native = await nativeHttpFixture({ env: east, context: fixture.context } as TestEnvironment, root, canonical, 'r_workerd_global');
      nativeService = east.GIT_SERVICE;
      const actor = (await authenticate(new Request(shared.API_ORIGIN, { headers: { authorization: `Bearer ${tokens.get('alice')}` } }), home))!;
      const moving = await result(await submitShardMove(east as OperationsBindings, { repo_id: 'r_workerd_global', target_cell_id: 'east', target_shard_id: 'archive', expected_epoch: 1, principal: actor }, false), 202);
      const operation = (await one<Operation>(eastData, 'SELECT * FROM operations WHERE id=?', moving.id))!;
      expect(await runShardMove(east as OperationsBindings, operation)).toMatchObject({ moved: true, routing_epoch: 2 });
      expect(await one(eastArchive, "SELECT state,routing_epoch FROM repositories WHERE id='r_workerd_global'")).toEqual({ state: 'active', routing_epoch: 2 });
      const second = await result<Listing>(await call(`/v1/search?q=needle&limit=1&cursor=${first.next_cursor}`));
      expect([first.items[0]!.id, second.items[0]!.id].sort()).toEqual([eastIssue.id, westIssue.id].sort());
      expect(second.next_cursor).toBeNull();
      const newcomer = await prepareManagedUser(db, { user_id: 'u_after_move', email: 'after-move@example.test', display_name: 'New managed colleague', verified: true, actor_id: 'u_alice' });
      await withAccountAuthorityBarrier(backgroundContext(home, actor), accountId, 'provision new managed collaborator', () => db.batch([
        ...newcomer.statements, stmt(db, `INSERT INTO memberships(account_id,principal_id,role_id,state,created_by,created_at,updated_at)
          VALUES (?,'u_after_move','reader','active','u_alice',?,?)`, accountId, now(), now()),
      ]));
      const mentioned = await one<{ username: string }>(db, "SELECT username FROM users WHERE id='u_workerd_oidc'");
      const afterMove = await result(await call('/v1/repos/r_workerd_global/issues', { method: 'POST', body: { title: 'needle after actual move',
        markdown: `Current identity mention for @${mentioned!.username}.`, assignee_ids: ['u_workerd_oidc', 'u_after_move'] } }), 201);
      expect((afterMove.assignees as Array<{ id: string; display_name: string }>).map(user => user.id).sort()).toEqual(['u_after_move', 'u_workerd_oidc']);
      expect((afterMove.assignees as Array<{ display_name: string }>).some(user => user.display_name === 'Metadata reference')).toBe(false);
      expect((await one<{ disabled_at: string | null }>(eastArchive, "SELECT disabled_at FROM users WHERE id='u_after_move'"))?.disabled_at).toEqual(expect.any(String));
      const movedInbox = await result<Listing>(await call('/v1/inbox', { cookie: sessions[0]!.cookie }));
      expect(movedInbox.items.some(row => row.item_id === afterMove.id)).toBe(true);
      expect(movedInbox.items.some(row => row.item_id === afterMove.id && row.reason === 'mention')).toBe(true);
      expect((await result<Listing>(await call('/v1/search?q=needle'))).items.map(row => row.id).sort()).toEqual([eastIssue.id, westIssue.id, afterMove.id].sort());
      const freshCoverage = await result<{ complete: boolean; repositories: Array<{ authoritative_documents: number; current: boolean | null }> }>(await call('/v1/repos/r_workerd_global/search/coverage'));
      expect(freshCoverage.repositories[0]?.authoritative_documents).toBe(2);
      expect(freshCoverage.complete).toBe(false); // The new canonical row has not yet reached the index.

      westUnavailable = true;
      const uncertain = await result<Listing>(await call('/v1/search?q=needle'));
      expect(uncertain.items).toHaveLength(0); expect(uncertain.coverage?.complete).toBe(false);
      expect((uncertain.coverage?.source_scan as { status: string }).status).toBe('unknown');
      expect((await result<Listing>(await call('/v1/search?q=needle&repo_id=r_workerd_global'))).items).toHaveLength(2);
      westUnavailable = false;
      expect((await result<Listing>(await call(`/v1/search?q=needle&cursor=${uncertain.next_cursor}`))).items).toHaveLength(3);
      const rawPrivate = await worker.fetch(`${shared.API_ORIGIN}/internal/collaboration/read`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 1, action: 'window', cell_id: 'local', surface: 'search', as_of: now(), after: null, filters: {} }) });
      expect(rawPrivate.status).toBe(401);

      // A real move retains the old public catalog/content rows. They remain
      // discoverable hints even after the authoritative destination is unlisted.
      const discoveryRepo = 'r_workerd_global', anonymous = { anonymous: true };
      async function changeVisibility(visibility: 'public' | 'unlisted' | 'private'): Promise<void> {
        const current = await result(await call(`/v1/repos/${discoveryRepo}`));
        await result(await call(`/v1/repos/${discoveryRepo}`, { method: 'PATCH', revision: current.revision, body: { visibility } }));
      }
      function excludesMovedContent(value: Listing): void {
        expect(value.items).toHaveLength(0);
        expect(value.next_cursor).toBeNull();
        for (const hidden of [discoveryRepo, eastIssue.id, afterMove.id, 'Current east authority.', 'needle east source', 'needle after actual move']) {
          expect(JSON.stringify(value)).not.toContain(hidden);
        }
      }
      expect((await result<Listing>(await call('/v1/search?q=needle', anonymous))).items.map(row => row.id).sort()).toEqual([eastIssue.id, afterMove.id].sort());
      await changeVisibility('unlisted');
      expect(await one(eastData, 'SELECT visibility,state,routing_epoch FROM repositories WHERE id=?', discoveryRepo))
        .toEqual({ visibility: 'public', state: 'moving', routing_epoch: 1 });
      expect(await one(eastArchive, 'SELECT visibility,state,routing_epoch FROM repositories WHERE id=?', discoveryRepo))
        .toEqual({ visibility: 'unlisted', state: 'active', routing_epoch: 2 });
      const hiddenSearch = await result<Listing>(await call('/v1/search?q=needle', anonymous));
      const missingSearch = await result<Listing>(await call('/v1/search?q=absent-for-everyone', anonymous));
      excludesMovedContent(hiddenSearch);
      expect(hiddenSearch.coverage).toEqual(missingSearch.coverage);
      expect(hiddenSearch.coverage?.repositories).toEqual([]);
      expect(hiddenSearch.coverage?.exclusions).toContain('unlisted_repositories');
      excludesMovedContent(await result<Listing>(await call('/v1/feed?scope=public', anonymous)));
      expect((await result<Listing>(await call(`/v1/search?q=needle&repo_id=${discoveryRepo}`, anonymous))).items).toHaveLength(2);
      expect((await result<Listing>(await call(`/v1/feed?scope=repository&repo_id=${discoveryRepo}`, anonymous))).items).toHaveLength(2);
      expect((await call(`/v1/repos/${discoveryRepo}/issues/${eastIssue.id}`, anonymous)).status).toBe(200);
      expect((await result<Listing>(await call(`/v1/search?q=needle&repo_id=${discoveryRepo}`, { cookie: sessions[0]!.cookie }))).items).toHaveLength(2);
      excludesMovedContent(await result<Listing>(await call(`/v1/feed?scope=public&repo_id=${discoveryRepo}`)));

      // Release a genuine public discovery window only after a concurrent,
      // revision-guarded destination PATCH has changed its listing eligibility.
      await changeVisibility('public');
      let capturedWindow = false;
      readFaults.afterWindow = async window => {
        expect(window.candidates.some(row => row.id === eastIssue.id)).toBe(true);
        capturedWindow = true;
        await changeVisibility('unlisted');
      };
      excludesMovedContent(await result<Listing>(await call('/v1/search?q=needle', anonymous)));
      expect(capturedWindow).toBe(true);

      await changeVisibility('public');
      readFaults.afterWindow = async window => {
        expect(window.candidates.some(row => row.repo_id === discoveryRepo)).toBe(true);
        await changeVisibility('private');
      };
      // The owner can still read private content; a public-only feed must not list it.
      excludesMovedContent(await result<Listing>(await call('/v1/feed?scope=public')));
      expect((await result<Listing>(await call(`/v1/feed?scope=repository&repo_id=${discoveryRepo}`))).items).toHaveLength(2);

      // The first candidate has already hydrated under public visibility when
      // the second read changes the repository. Final page validation must
      // remove the earlier result too, including its snippet and lookahead.
      await changeVisibility('public');
      let hydrated = 0;
      readFaults.afterReference = async input => {
        if (input.repo_id !== discoveryRepo || input.surface !== 'search') return;
        if (++hydrated !== 2) return;
        readFaults.afterReference = undefined;
        await changeVisibility('unlisted');
      };
      excludesMovedContent(await result<Listing>(await call('/v1/search?q=needle&limit=1', anonymous)));
      expect(hydrated).toBe(2);

      await changeVisibility('public');
      let profileHydrated = 0;
      readFaults.afterReference = async input => {
        if (input.repo_id !== discoveryRepo || input.surface !== 'feed') return;
        if (++profileHydrated !== 2) return;
        readFaults.afterReference = undefined;
        const preferences = await result(await call('/v1/users/u_alice/preferences'));
        await result(await call('/v1/users/u_alice/preferences', { method: 'PATCH', revision: preferences.revision, body: { activity_visibility: 'private' } }));
      };
      excludesMovedContent(await result<Listing>(await call('/v1/users/u_alice/activity', anonymous)));
      expect(profileHydrated).toBe(2);
      expect((await call(`/v1/repos/${discoveryRepo}/issues/${eastIssue.id}`, anonymous)).status).toBe(200);
      expect((await result<Listing>(await call('/v1/users/u_alice/activity'))).items.some(row => row.item_id === eastIssue.id)).toBe(true);

      await changeVisibility('private');
      await withAccountAuthorityBarrier(backgroundContext(home, actor), accountId, 'revoke managed collaborator', () =>
        stmt(db, "UPDATE memberships SET state='suspended',revision=revision+1 WHERE account_id=? AND principal_id='u_workerd_oidc'", accountId).run());
      expect((await call('/v1/inbox', { cookie: sessions[0]!.cookie })).status).toBe(401);
      expect([401, 404]).toContain((await call(`/v1/repos/r_workerd_global/issues/${afterMove.id}`, { cookie: sessions[0]!.cookie })).status);
    } finally { await native?.close(); await runtime?.dispose(); await rm(root, { recursive: true, force: true }); }
  }, 180_000);
});
