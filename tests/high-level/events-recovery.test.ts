import { createHash, createHmac, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Context, Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { actionToken, base64url, createIdentityAction, errorResponse, eventStatement, execute, getRepository, identityAuthorityBindings, identityKeys, makeEvent,
  many, mutationGuard, mutationStatements, newId, now, one, prepareCredential, requestContext, route, routeResourceRequest, sha256, signInternalRequest, stmt, withAccountAuthorityBarrier } from '../../packages/core/src/index.ts';
import type { AppEnv, Bindings, EventRecord, Principal, Repository } from '../../packages/core/src/types.ts';
import { registerIntegrationsRoutes } from '../../apps/api/src/modules/integrations.ts';
import { registerInternalMailRoutes } from '../../apps/api/src/modules/internal-mail.ts';
import { deliverMail, scheduleMail } from '../../packages/operations/src/mail.ts';
import { IDENTITY_MAIL_PATH } from '../../packages/operations/src/mail-contract.ts';
import { createArchive, portableArchiveStream, readArchive } from '../../packages/operations/src/archive.ts';
import { consumeOnce, dispatchOutbox, fanoutEvent } from '../../packages/operations/src/durable.ts';
import { completeOperation, failOperation, operationById, runLifecycle } from '../../packages/operations/src/lifecycle.ts';
import { deleteExpiredObjects, putObject } from '../../packages/operations/src/objects.ts';
import { deliverWebhook, scheduleWebhooks, sweepReplays } from '../../packages/operations/src/webhooks.ts';
import { isPublicAddress } from '../../packages/operations/src/security.ts';
import type { Delivery, OperationsBindings } from '../../packages/operations/src/types.ts';
import { createTestEnvironment } from '../support/environment.ts';
import type { TestEnvironment } from '../support/environment.ts';
import { TestQueue } from '../support/storage.ts';
import { AdmissionController } from '../../packages/billing/src/controller.ts';
import { createTestDatabase } from '../support/database.ts';
import { createSecretsBroker, brokerRequest } from '../../packages/secrets/src/index.ts';
import type { SecretsBrokerBindings } from '../../packages/secrets/src/types.ts';
import background from '../../workers/background/src/ops/handler.ts';
import { shardEnvironment } from '../../packages/operations/src/placement.ts';
import { runShardMove } from '../../packages/operations/src/movement.ts';
import { consumeEvent } from '../../workers/background/src/ops/events.ts';
import { registerRepositoryLifecycleRoutes } from '../../apps/api/src/modules/repositories/lifecycle.ts';
import { authorizeArchive, archiveAuthorizer } from '../../packages/operations/src/archive-access.ts';
import { reviewEvidenceId, reviewRefs } from '../../packages/git/src/protocol.ts';
import { registerOperationsRoutes } from '../../apps/api/src/modules/operations.ts';
import { registerStorageRoutes } from '../../apps/api/src/modules/storage.ts';
import { registerCollaborationRoutes } from '../../apps/api/src/modules/collaboration.ts';
import { expireEventHistory } from '../../packages/operations/src/dispatch.ts';
import { ownerExecute } from '../../packages/operations/src/metadata-fence.ts';
import { NativeGit } from '../../services/git/src/process.ts';
import { inspectCollaboration } from '../../services/git/src/inspection.ts';
import { DEFAULT_GIT_LIMITS } from '../../packages/git/src/types.ts';
import { createRun } from '../../packages/execution/src/control-plane.ts';
import { pinWorkflowSource } from '../../packages/execution/src/source-identity.ts';
import type { ExecutionPlan } from '../../packages/execution/src/types.ts';
import { backgroundContext } from '../../packages/operations/src/authorization.ts';

const opened: Array<{ close(): void }> = [];
afterEach(() => { for (const fixture of opened.splice(0)) fixture.close(); });

async function fixture(): Promise<TestEnvironment & { operations: OperationsBindings; actor: Principal }> {
  const test = await createTestEnvironment({ INDEX_EVENTS: new TestQueue().binding(), METER_EVENTS: new TestQueue().binding(),
    SECRETS_CLIENT_ID: 'test-background', SECRETS_CLIENT_KEY: base64url(randomBytes(32)) });
  opened.push(test);
  const timestamp = now();
  await test.db.batch([
    stmt(test.env.DB, `INSERT INTO users(id,username,email,display_name,email_verified_at,created_at,updated_at) VALUES('u_owner','owner','owner@example.net','Owner',?,?,?)`, timestamp, timestamp, timestamp),
    stmt(test.env.DB, `INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES('u_owner','user','owner','Owner','u_owner',?,?)`, timestamp, timestamp),
    stmt(test.env.DB, `INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES('u_owner','user','u_owner','u_owner','Owner','u_owner',?,?)`, timestamp, timestamp),
    stmt(test.env.DB, `INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
      VALUES('r_repo','u_owner','repo','repo','private','active','local','core','storage_repo','u_owner',?,?)`, timestamp, timestamp),
    stmt(test.env.DB, `INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,epoch,state,updated_at)
      VALUES('r_repo','repository','local','core',1,'active',?)`, timestamp),
  ]);
  const credential = await prepareCredential(test.env.DB, { principal_id: 'u_owner', user_id: 'u_owner', kind: 'personal', name: 'Events recovery test',
    capabilities: ['*'], repository_ids: null, account_ids: null, auth_revision: 1, mfa: true,
    expires_at: new Date(Date.now() + 86400_000).toISOString(), created_by: 'u_owner' });
  await credential.statement.run();
  const actor: Principal = { id: 'u_owner', kind: 'user', user_id: 'u_owner', credential_id: credential.credential.id, capabilities: ['*'], repository_ids: null, account_ids: null, mfa: true };
  const until = new Date(Date.now() + 60 * 86400_000).toISOString();
  await test.env.DB.batch([
    stmt(test.env.DB, `INSERT INTO billing_platform_pools(id,period_start,period_end,limit_units,safety_buffer_units,baseline_commitment_units,max_instances,state)
      VALUES('pool_events',?,?,'1000000000000','0','0',10,'active')`, timestamp, until),
    stmt(test.env.DB, `INSERT INTO billing_capacity_slices(id,pool_id,cell_id,limit_units,max_instances,max_storage_bytes,valid_until,state,created_at)
      VALUES('slice_events','pool_events','local','1000000000000',10,'10000000000',?,'active',?)`, until, timestamp),
  ]);
  test.env.BILLING_PLATFORM_SLICE_ID = 'slice_events';
  test.env.ADMISSION = billingNamespace(test.env);
  return { ...test, operations: test.env as OperationsBindings, actor };
}

/** Only provider storage is adapted: the real account/capacity controllers and billing book run unchanged. */
class DurableStorage {
  private values = new Map<string, unknown>();
  private tail = Promise.resolve();
  private async serial<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(done => { release = done; });
    await previous;
    try { return await callback(); } finally { release(); }
  }
  private view(values: Map<string, unknown>) {
    return {
      get: async <T>(key: string): Promise<T | undefined> => structuredClone(values.get(key)) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
      delete: async (key: string) => values.delete(key),
      list: async <T>(options: { prefix?: string; startAfter?: string; limit?: number } = {}): Promise<Map<string, T>> => new Map([...values.entries()]
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).filter(([key]) => key.startsWith(options.prefix ?? '') && key > (options.startAfter ?? ''))
        .slice(0, options.limit ?? Infinity).map(([key, value]) => [key, structuredClone(value) as T])),
    };
  }
  get<T>(key: string): Promise<T | undefined> { return this.serial(() => this.view(this.values).get<T>(key)); }
  put(key: string, value: unknown): Promise<void> { return this.serial(() => this.view(this.values).put(key, value)); }
  delete(key: string): Promise<boolean> { return this.serial(() => this.view(this.values).delete(key)); }
  list<T>(options?: { prefix?: string; startAfter?: string; limit?: number }): Promise<Map<string, T>> { return this.serial(() => this.view(this.values).list<T>(options)); }
  transaction<T>(callback: (transaction: unknown) => Promise<T>): Promise<T> {
    return this.serial(async () => { const next = structuredClone(this.values); const result = await callback(this.view(next)); this.values = next; return result; });
  }
  async setAlarm(): Promise<void> {}
}

function billingNamespace(env: Bindings): DurableObjectNamespace {
  const controllers = new Map<string, AdmissionController>();
  return { idFromName: (name: string) => ({ toString: () => name }), get: (id: { toString(): string }) => {
    const name = id.toString();
    let controller = controllers.get(name);
    if (!controller) {
      controller = new AdmissionController({ storage: new DurableStorage(), blockConcurrencyWhile: <T>(callback: () => Promise<T>) => callback() } as unknown as DurableObjectState, env);
      controllers.set(name, controller);
    }
    return { fetch: (request: Request) => controller!.fetch(request) };
  } } as unknown as DurableObjectNamespace;
}

async function secondaryShard(test: Awaited<ReturnType<typeof fixture>>) {
  const shard = await createTestDatabase(); opened.push(shard);
  Object.assign(test.operations, identityAuthorityBindings(test.operations), { SECONDARY_DB: shard.binding(), SHARD_BINDINGS_JSON: '{"core":"DB","secondary":"SECONDARY_DB"}' });
  return shard;
}

function nativeLifecycleService(options: { loseRelease?: boolean } = {}) {
  const held = new Set<string>();
  const released = new Set<string>();
  let acquisitions = 0;
  const service = { fetch: async (request: Request) => {
    const action = new URL(request.url).pathname.split('/').at(-1);
    const input = await request.json() as { operation_id: string };
    if (action === 'barrier') {
      if (request.method === 'DELETE') {
        held.delete(input.operation_id); released.add(input.operation_id);
        if (options.loseRelease) { options.loseRelease = false; throw new Error('injected lost barrier release receipt'); }
        return Response.json({ held: false, operation_id: input.operation_id });
      }
      acquisitions++;
      if (released.has(input.operation_id)) return Response.json({ held: false, released: true, operation_id: input.operation_id });
      held.add(input.operation_id); return Response.json({ held: true, operation_id: input.operation_id });
    }
    if (action === 'verify') return Response.json({ verified: true, objects_verified: true, refs: [] });
    return Response.json({ error: 'unexpected native action' }, { status: 503 });
  } } as unknown as Fetcher;
  return { service, acquisitions: () => acquisitions };
}

function api(env: OperationsBindings, actor: Principal): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(errorResponse);
  app.use('*', requestContext);
  app.use('*', async (c, next) => { c.set('principal', actor); const forwarded = await routeResourceRequest(c); if (forwarded) return forwarded; await next(); });
  return app;
}

async function realGitLifecycle(test: Awaited<ReturnType<typeof fixture>>) {
  const directory = await mkdtemp('/private/var/folders/zh/l70grz9n3ll9j9c_f1ghp7gr0000gn/T/opencode/events-lifecycle-');
  const command = promisify(execFile);
  const stores = new Map([['storage_repo', join(directory, 'current')]]);
  await mkdir(stores.get('storage_repo')!);
  const git = async (store: string, ...args: string[]) => String((await command('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: stores.get(store)!, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  })).stdout).trim();
  await git('storage_repo', 'init', '--template=', '--initial-branch=main');
  const commit = async (text: string) => {
    await writeFile(join(stores.get('storage_repo')!, 'README.md'), text); await git('storage_repo', 'add', 'README.md');
    await git('storage_repo', '-c', 'user.name=GitKnot', '-c', 'user.email=test@example.net', 'commit', '-m', text);
    return git('storage_repo', 'rev-parse', 'HEAD');
  };
  const inventory = async (store: string) => {
    await git(store, 'fsck', '--full');
    const output = await git(store, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags', 'refs/gitknot');
    return output ? output.split('\n').map(line => { const [ref, oid] = line.split(' '); return { ref: ref!, oid: oid! }; }) : [];
  };
  const barrier = nativeLifecycleService();
  let onExport: ((operationId: string) => Promise<void>) | undefined;
  test.operations.GIT_SERVICE = { fetch: async (request: Request) => {
    const url = new URL(request.url), action = url.pathname.split('/').at(-1);
    if (action === 'barrier') return barrier.service.fetch(request);
    const repository = (await one<Repository>(test.env.DB, "SELECT * FROM repositories WHERE id='r_repo'"))!;
    if (action === 'verify') return Response.json({ verified: true, objects_verified: true, refs: await inventory(repository.storage_name) });
    if (action === 'export') {
      const input = await request.json() as { operation_id: string };
      await onExport?.(input.operation_id);
      const refs = await inventory(repository.storage_name), file = join(directory, `${input.operation_id}.bundle`);
      await git(repository.storage_name, 'bundle', 'create', file, ...refs.map(ref => ref.ref));
      const data = new Uint8Array(await readFile(file));
      return new Response(data, { headers: { 'content-length': String(data.byteLength) } });
    }
    if (action === 'restore') {
      const archiveId = url.searchParams.get('archive_id')!, storage = url.searchParams.get('storage_name')!;
      const manifest = await readArchive(test.env, archiveId, 'r_repo');
      const data = new Uint8Array(await request.arrayBuffer());
      expect(await sha256(data)).toBe(manifest.git.sha256);
      const file = join(directory, `${storage}.bundle`), target = join(directory, storage);
      await writeFile(file, data); await mkdir(target, { recursive: true }); stores.set(storage, target);
      await git(storage, 'init', '--bare', '--template=', `--initial-branch=${manifest.repository.default_branch}`);
      await git(storage, 'fetch', file, '+refs/*:refs/*');
      return Response.json({ verified: true, objects_verified: true, refs: await inventory(storage) });
    }
    return Response.json({ error: 'unsupported lifecycle fixture action' }, { status: 503 });
  } } as unknown as Fetcher;
  const broker = createSecretsBroker();
  const brokerEnv: SecretsBrokerBindings = { ...test.operations, SECRETS_KEK_CURRENT_ID: 'lifecycle-kek', SECRETS_KEK_KEYRING_JSON: JSON.stringify({ 'lifecycle-kek': base64url(randomBytes(32)) }),
    SECRETS_SERVICE_KEYS_JSON: JSON.stringify({ 'test-background': { key: test.operations.SECRETS_CLIENT_KEY, scopes: ['vault.lifecycle'] } }) };
  test.operations.SECRETS = { fetch: (request: Request) => broker.fetch(request, brokerEnv, test.context) } as unknown as Fetcher;
  return { git, commit, inventory, native: (store: string) => new NativeGit(stores.get(store)!, DEFAULT_GIT_LIMITS, Date.now() + 60_000, true),
    onExport: (callback: typeof onExport) => { onExport = callback; }, close: () => rm(directory, { recursive: true, force: true }) };
}

async function source(env: OperationsBindings, id = 'evt_change'): Promise<EventRecord> {
  const event = makeEvent({ id, type: 'issue.created', resource_id: 'issue_example', resource_revision: 4, repo_id: 'r_repo', account_id: 'u_owner', actor_id: 'u_owner', data: { number: 7, secret: 'never-release-this', provider_token: 'never-release-this-either' } });
  await eventStatement(env.DB, event).run();
  return event;
}

describe('durable committed-source delivery and recovery', () => {
  it('materializes a consistent backup and restores Git, canonical metadata, dependency summaries and fresh billed objects together', async () => {
    const test = await fixture();
    const { operations: env, actor, context } = test;
    const native = await realGitLifecycle(test);
    try {
      const oidA = await native.commit('Git A');
      await native.git('storage_repo', 'switch', '-c', 'feature');
      const feature = await native.commit('Feature A');
      await native.git('storage_repo', 'switch', 'main');
      const evidence = await reviewEvidenceId('r_repo', 'r_repo', oidA, feature);
      for (const [index, ref] of reviewRefs(evidence).entries()) await native.git('storage_repo', 'update-ref', ref, index === 1 ? feature : oidA);
      const inspection = await inspectCollaboration(native.native('storage_repo'), 'r_repo', { inspection: { kind: 'patch', head_repo_id: 'r_repo', base_oid: oidA, head_oid: feature } });
      const patch = await inspection.json() as { patch_fingerprint: string };
      const app = api(env, actor);
      let ready!: () => void, release!: () => void;
      const prepared = new Promise<void>(done => { ready = done; });
      const resume = new Promise<void>(done => { release = done; });
      route(app, 'POST', '/v1/repos/:repoId/prepared-issue/:issueId', { summary: 'Prepared issue edit', capability: 'issues.write' }, async c => {
        await getRepository(c, 'r_repo', 'issues.write');
        const db = c.get('database'); const guard = newId('guard');
        const statements = await mutationStatements(c, { statements: [stmt(db, "UPDATE collaboration_items SET title='late edit',revision=revision+1 WHERE id=? AND revision=1", c.req.param('issueId')),
          mutationGuard(db, guard), stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard)],
        event: { type: 'issue.updated', resource_id: c.req.param('issueId')!, resource_revision: 2, repo_id: 'r_repo', account_id: actor.id } });
        ready(); await resume; await db.batch(statements); return c.json({ changed: true });
      });
      registerCollaborationRoutes(app); registerOperationsRoutes(app); registerRepositoryLifecycleRoutes(app); registerStorageRoutes(app);
      const request = (method: string, path: string, body?: unknown, revision?: number, key?: string) => app.fetch(new Request(`https://api.gitknot.com${path}`, {
        method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(revision === undefined ? {} : { 'if-match': `"${revision}"` }),
          ...(key ? { 'idempotency-key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), env, context);
      const json = async (response: Response, status: number) => { const value = await response.json() as Record<string, unknown>; expect(response.status, JSON.stringify(value)).toBe(status); return value; };
      const issue = await json(await request('POST', '/v1/repos/r_repo/issues', { title: 'issue v1', markdown: 'version one' }), 201);
      const bytes = new TextEncoder().encode('object A');
      const upload = await json(await request('POST', '/v1/repos/r_repo/uploads', { filename: 'snapshot.txt', content_type: 'text/plain', bytes: bytes.byteLength, sha256: await sha256(bytes) }, undefined, 'snapshot-object'), 201);
      await json(await app.fetch(new Request(String(upload.upload_url), { method: 'PUT', headers: { 'if-match': `"${upload.revision}"` }, body: bytes }), env, context), 201);
      await env.DB.batch([
        stmt(env.DB, `INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,fork_source_id,created_by,created_at,updated_at)
          VALUES('r_dependency','u_owner','dependency','dependency','private','active','local','core','dependency_store','r_repo','u_owner',?,?)`, now(), now()),
        stmt(env.DB, `INSERT INTO collaboration_items(id,repo_id,kind,number,title,author_id,state,created_at,updated_at) VALUES('task_snapshot','r_repo','task',1,'Snapshot task','u_owner','active',?,?)`, now(), now()),
        stmt(env.DB, "INSERT INTO tasks(id,repo_id,accountable_user_id,base_oid) VALUES('task_snapshot','r_repo','u_owner',?)", oidA),
        stmt(env.DB, `INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,status,input_json,created_at,updated_at)
          VALUES('op_workspace_snapshot','collaboration.workspace','ws_snapshot','r_repo','u_owner','u_owner','running','{"must_not_replay":"secret producer input"}',?,?)`, now(), now()),
        stmt(env.DB, `INSERT INTO task_workspaces(id,repo_id,task_id,workspace_repo_id,owner_principal_id,base_oid,operation_id,state,retention_until,last_active_at,created_at,updated_at)
          VALUES('ws_snapshot','r_repo','task_snapshot','r_dependency','u_owner',?,'op_workspace_snapshot','active',?,?,?,?)`, oidA, new Date(Date.now() + 86400_000).toISOString(), now(), now(), now()),
        stmt(env.DB, `INSERT INTO collaboration_items(id,repo_id,kind,number,title,author_id,state,created_at,updated_at) VALUES('pull_snapshot','r_repo','pull_request',1,'Snapshot pull','u_owner','open',?,?)`, now(), now()),
        stmt(env.DB, `INSERT INTO pull_requests(id,repo_id,head_repo_id,base_ref,head_ref,base_oid,head_oid,current_patch_id)
          VALUES('pull_snapshot','r_repo','r_repo','refs/heads/main','refs/heads/feature',?,?,'patch_snapshot')`, oidA, feature),
        stmt(env.DB, `INSERT INTO pull_patches(id,repo_id,pull_id,version,head_repo_id,base_oid,head_oid,merge_base_oid,patch_fingerprint,native_evidence_id,created_by,created_at)
          VALUES('patch_snapshot','r_repo','pull_snapshot',1,'r_repo',?,?,?, ?,?,'u_owner',?)`, oidA, feature, oidA, patch.patch_fingerprint, evidence, now()),
        stmt(env.DB, `INSERT INTO git_review_snapshots(repo_id,id,source_repo_id,base_oid,head_oid,merge_base_oid,operation_id,actor_id,state,created_at,updated_at)
          VALUES('r_repo',?,'r_repo',?,?,?,'op_retained_review','u_owner','ready',?,?)`, evidence, oidA, feature, oidA, now(), now()),
        stmt(env.DB, `INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,input_json,created_at,updated_at)
          VALUES('op_merge_snapshot','collaboration.merge','pull_snapshot','r_repo','u_owner','u_owner','{"must_not_replay":"merge"}',?,?)`, now(), now()),
        stmt(env.DB, `INSERT INTO pull_merge_queue(id,repo_id,pull_id,patch_id,target_ref,head_oid,base_oid,strategy,policy_revision,operation_id,state,requested_by,created_at,updated_at)
          VALUES('queue_snapshot','r_repo','pull_snapshot','patch_snapshot','refs/heads/main',?,?,'merge',1,'op_merge_snapshot','queued','u_owner',?,?)`, feature, oidA, now(), now()),
      ]);
      const pending = request('POST', `/v1/repos/r_repo/prepared-issue/${issue.id}`, {}, 1);
      await prepared;
      native.onExport(async operationId => {
        release(); const response = await pending; expect(response.ok).toBe(false);
        // The owning operation may progress after capture; its paged archive remains the original materialized snapshot.
        await ownerExecute(env, 'r_repo', operationId, "UPDATE collaboration_items SET title='owner progress',revision=revision+1 WHERE id=?", issue.id);
      });
      const backup = await json(await request('POST', '/v1/repos/r_repo/backups', {}), 202);
      const run = async (id: string) => {
        const operation = await operationById(env, id);
        const result = await runLifecycle(env, operation, { do: async <T>(_name: string, _options: unknown, action: () => Promise<T>) => action() });
        await completeOperation(env, operation, result); return result;
      };
      const archived = await run(String(backup.id));
      native.onExport(undefined);
      const manifest = await readArchive(env, String(archived.archive_id), 'r_repo');
      const operationPart = manifest.parts.find(part => part.path.startsWith('metadata/operations/'))!;
      const operations = JSON.parse(new TextDecoder().decode(await (await import('../../packages/operations/src/archive.ts')).verifiedPart(env, operationPart))) as { id: string; status: string; input_json: string }[];
      expect(operations).toContainEqual(expect.objectContaining({ id: 'op_workspace_snapshot', status: 'cancelled', input_json: '{}' }));
      const oidB = await native.commit('Git B');
      const currentIssue = await one<{ revision: number }>(env.DB, 'SELECT revision FROM collaboration_items WHERE id=?', issue.id);
      await json(await request('PATCH', `/v1/repos/r_repo/issues/${issue.id}`, { title: 'issue v2', markdown: 'version two' }, currentIssue!.revision), 200);
      const deleteAndRun = async () => {
        const repo = (await one<Repository>(env.DB, "SELECT * FROM repositories WHERE id='r_repo'"))!;
        const deleted = await json(await request('DELETE', '/v1/repos/r_repo', undefined, repo.revision), 202);
        await run((deleted.operation as { id: string }).id);
      };
      const restore = async (archiveId?: string) => {
        const repo = (await one<Repository>(env.DB, "SELECT * FROM repositories WHERE id='r_repo'"))!;
        const restored = await json(await request('POST', '/v1/repos/r_repo/restore', archiveId ? { archive_id: archiveId } : {}, repo.revision), 202);
        const id = (restored.operation as { id: string }).id; await run(id); return id;
      };
      await deleteAndRun(); await restore();
      expect((await one<{ storage_name: string }>(env.DB, "SELECT storage_name FROM repositories WHERE id='r_repo'"))!.storage_name).toBe('storage_repo');
      expect(await native.git('storage_repo', 'rev-parse', 'refs/heads/main')).toBe(oidB);
      expect(await one(env.DB, 'SELECT title,markdown FROM collaboration_items WHERE id=?', issue.id)).toEqual({ title: 'issue v2', markdown: 'version two' });
      await deleteAndRun(); const restoredId = await restore(String(archived.archive_id));
      const final = (await one<Repository>(env.DB, "SELECT * FROM repositories WHERE id='r_repo'"))!;
      expect(final.state).toBe('active'); expect(final.storage_name).not.toBe('storage_repo');
      expect(await native.git(final.storage_name, 'rev-parse', 'refs/heads/main')).toBe(oidA);
      expect(await one(env.DB, 'SELECT title,markdown FROM collaboration_items WHERE id=?', issue.id)).toEqual({ title: 'issue v1', markdown: 'version one' });
      expect(await one(env.DB, "SELECT input_json,status FROM operations WHERE id='op_workspace_snapshot'")).toEqual({ input_json: '{}', status: 'cancelled' });
      expect(await one(env.DB, "SELECT operation_id FROM task_workspaces WHERE id='ws_snapshot'")).toEqual({ operation_id: 'op_workspace_snapshot' });
      expect(await one(env.DB, "SELECT operation_id,state FROM pull_merge_queue WHERE id='queue_snapshot'")).toEqual({ operation_id: 'op_merge_snapshot', state: 'cancelled' });
      const object = (await one<{ object_id: string; object_key: string }>(env.DB, 'SELECT object_id,object_key FROM repository_restore_objects WHERE operation_id=? AND original_id=?', restoredId, upload.id))!;
      expect(object.object_id).not.toBe(upload.id);
      expect(await (await test.blobs.get(object.object_key) as R2ObjectBody).text()).toBe('object A');
      expect(await one(env.DB, 'SELECT state FROM object_manifests WHERE id=?', upload.id)).toEqual({ state: 'deleted' });
      expect(await one(env.DB, 'SELECT state FROM repository_restore_plans WHERE operation_id=?', restoredId)).toEqual({ state: 'verified' });
      expect(await many(env.DB, 'PRAGMA foreign_key_check')).toEqual([]);
      expect(await one(env.DB, "SELECT state FROM repository_metadata_fences WHERE repo_id='r_repo'")).toEqual({ state: 'released' });
    } finally { await native.close(); }
  });
  it('recovers one broker-issued signing key after its response is lost without a second issuance', async () => {
    const { operations: env, actor, context } = await fixture();
    const broker = createSecretsBroker();
    const operatorKey = base64url(randomBytes(32));
    const brokerEnv: SecretsBrokerBindings = { ...env, SECRETS_KEK_CURRENT_ID: 'test-kek', SECRETS_KEK_KEYRING_JSON: JSON.stringify({ 'test-kek': base64url(randomBytes(32)) }),
      SECRETS_SERVICE_KEYS_JSON: JSON.stringify({ 'test-background': { key: env.SECRETS_CLIENT_KEY, scopes: ['webhooks.manage'] },
        operator: { key: operatorKey, scopes: ['vault.rotate'] } }) };
    const issued: string[] = [];
    let lostSecret = '';
    const service = { fetch: async (request: Request) => {
      const keyRequest = new URL(request.url).pathname === '/internal/webhooks/keys';
      const input = keyRequest ? await request.clone().json() as { key_id: string } : null;
      const response = await broker.fetch(request, brokerEnv, context);
      if (keyRequest && response.ok) {
        issued.push(input!.key_id); lostSecret = (await response.json() as { secret: string }).secret;
        throw new Error('injected lost one-time key response');
      }
      return response;
    } } as unknown as Fetcher;
    env.SECRETS = service;
    await brokerRequest({ SECRETS: service, SECRETS_CLIENT_ID: 'operator', SECRETS_CLIENT_KEY: operatorKey }, 'vault.rotate', '/internal/vault/keys/register', { expected_revision: 0 });
    await execute(env.DB, `INSERT INTO webhooks(id,repo_id,account_id,principal_id,principal_json,url,events_json,state,created_at,updated_at)
      VALUES('wh_once','r_repo','u_owner','u_owner',?,'https://hooks.example.net/events','["issue.*"]','disabled',?,?)`, JSON.stringify(actor), now(), now());
    const app = api(env, actor); registerIntegrationsRoutes(app);
    const request = () => new Request('https://api.gitknot.com/v1/webhooks/wh_once/keys', { method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': '"1"', 'idempotency-key': 'one-external-key' }, body: '{}' });
    expect((await app.fetch(request(), env, context)).ok).toBe(false);
    await execute(env.DB, "UPDATE idempotency_keys SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE key='one-external-key'");
    const retry = await app.fetch(request(), env, context);
    expect(retry.status, await retry.clone().text()).toBe(409);
    expect(await retry.text()).not.toContain(lostSecret);
    expect(issued).toHaveLength(1);
    const intent = await one<{ key_id: string; state: string; operation_id: string }>(env.DB, 'SELECT key_id,state,operation_id FROM webhook_key_operations');
    expect(intent).toMatchObject({ key_id: issued[0], state: 'completed' });
    expect(intent!.key_id).toBe(`whkey_${(await sha256(intent!.operation_id)).slice(0, 48)}`);
    expect(await one(env.DB, 'SELECT COUNT(*) AS count FROM vault_webhook_keys')).toEqual({ count: 1 });
    expect(await one(env.DB, "SELECT COUNT(*) AS count FROM webhook_keys WHERE state='active'")).toEqual({ count: 1 });
    expect(await one(env.DB, "SELECT response_body FROM idempotency_keys WHERE key='one-external-key'")).toEqual({ response_body: null });
  });

  it('keeps stable mail membership through interruption and rechecks plaintext/lease authority while key rotations retry the same webhook event', async () => {
    const { operations: env, actor, db } = await fixture();
    const event = makeEvent({ id: 'evt_recipient_membership', type: 'issue.created', resource_id: 'issue_mail_private', resource_revision: 1,
      repo_id: 'r_repo', account_id: actor.id, actor_id: actor.id });
    await eventStatement(env.DB, event).run();
    await env.DB.batch([
      stmt(env.DB, `INSERT INTO collaboration_items(id,repo_id,kind,number,title,author_id,state,created_at,updated_at)
        VALUES('issue_mail_private','r_repo','issue',1,'PRIVATE notification title','u_owner','open',?,?)`, now(), now()),
      stmt(env.DB, "INSERT INTO issues(id,repo_id) VALUES('issue_mail_private','r_repo')"),
      stmt(env.DB, `INSERT INTO collaboration_document_versions(id,repo_id,resource_kind,resource_id,document_revision,title,markdown,sha256,actor_id,created_at)
        VALUES('doc_mail_private','r_repo','issue','issue_mail_private',1,'PRIVATE notification title','mentions',?,'u_owner',?)`, await sha256('mentions'), now()),
    ]);
    for (let index = 0; index < 51; index++) {
      const user = `u_notify_${index}`;
      await env.DB.batch([
        stmt(env.DB, `INSERT INTO users(id,username,email,display_name,email_verified_at,created_at,updated_at) VALUES(?,?,?,'Recipient',?,?,?)`, user, `notify-${index}`, `notify-${index}@example.net`, now(), now(), now()),
        stmt(env.DB, "INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES(?,'user',?,'Recipient',?,?,?)", user, `notify-${index}`, user, now(), now()),
        stmt(env.DB, "INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES(?,'user',?,?,'Recipient',?,?,?)", user, user, user, user, now(), now()),
        stmt(env.DB, `INSERT INTO access_grants(id,account_id,repo_id,principal_type,principal_id,role_id,effect,created_by,created_at,updated_at)
          VALUES(?,'u_owner','r_repo','user',?,'reader','allow','u_owner',?,?)`, `grant_notify_${index}`, user, now(), now()),
        stmt(env.DB, "INSERT INTO collaboration_mentions(repo_id,resource_id,document_revision,user_id,created_at) VALUES('r_repo','issue_mail_private',1,?,?)", user, now()),
        stmt(env.DB, `INSERT INTO collaboration_inbox(id,user_id,repo_id,item_id,reason,source_id,source_event_id,state,created_at,updated_at)
          VALUES(?,?,'r_repo','issue_mail_private','mention','issue_mail_private',?,'outstanding',?,?)`, `inbox_${String(index).padStart(3, '0')}`, user, event.id, now(), now()),
      ]);
    }
    const originalBatch = db.batch.bind(db);
    let created = 0, interrupt = true;
    db.batch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      if (interrupt && statements.some(statement => /INSERT INTO mail_deliveries/.test((statement as unknown as { sql: string }).sql)) && ++created === 51) {
        interrupt = false; throw new Error('interrupted after first recipient page');
      }
      return originalBatch<T>(statements);
    };
    await expect(scheduleMail(env, event)).rejects.toThrow('interrupted after first recipient page');
    const first = (await one<{ reference_id: string }>(env.DB, "SELECT reference_id FROM mail_recipients WHERE event_id=? AND state='materialized' ORDER BY reference_id LIMIT 1", event.id))!;
    await execute(env.DB, "UPDATE collaboration_inbox SET state='completed',revision=revision+1 WHERE id=?", first.reference_id);
    await scheduleMail(env, event);
    expect(await one(env.DB, 'SELECT COUNT(*) AS count FROM mail_deliveries WHERE event_id=?', event.id)).toEqual({ count: 51 });
    expect(await one(env.DB, "SELECT COUNT(*) AS count FROM mail_recipients WHERE event_id=? AND state='materialized'", event.id)).toEqual({ count: 51 });
    const outbound: string[] = [];
    env.EMAIL = { send: async message => { outbound.push(message.text); return { messageId: 'unexpected-private-send' }; } };
    const baseline = (await one<{ id: string }>(env.DB, 'SELECT id FROM mail_deliveries WHERE reference_id<>? ORDER BY id LIMIT 1', first.reference_id))!;
    await deliverMail(env, baseline.id);
    expect(outbound[0]).toContain('PRIVATE notification title');
    outbound.length = 0;
    const delivery = (await one<{ id: string; user_id: string }>(env.DB, "SELECT id,user_id FROM mail_deliveries WHERE reference_id<>? AND state='pending' ORDER BY id LIMIT 1", first.reference_id))!;
    const originalPrepare = db.prepare.bind(db);
    let revoke = true;
    db.prepare = (sql: string): D1PreparedStatement => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, property) {
        if (property === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
        if (property === 'first') return async <T>(column?: string): Promise<T | null> => {
          const result = column === undefined ? await target.first<T>() : await target.first<T>(column);
          if (revoke && sql.includes('SELECT 1 FROM mail_suppressions WHERE email_hash=')) {
            revoke = false;
            await withAccountAuthorityBarrier(new Context<AppEnv>(new Request('https://internal.gitknot.com/mail-revoke'), { env }), actor.id, 'mail source revoked after render', async () => {
              await execute(env.DB, `INSERT INTO access_grants(id,account_id,repo_id,principal_type,principal_id,capability,effect,created_by,created_at,updated_at)
                VALUES('deny_mail_release','u_owner','r_repo','user',?,'contents.read','deny','u_owner',?,?)`, delivery.user_id, now(), now());
            });
          }
          return result;
        };
        const value: unknown = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
      } });
      return wrap(originalPrepare(sql));
    };
    await deliverMail(env, delivery.id);
    expect(outbound).toEqual([]);
    expect(await one(env.DB, 'SELECT state FROM mail_deliveries WHERE id=?', delivery.id)).toEqual({ state: 'cancelled' });
    await withAccountAuthorityBarrier(new Context<AppEnv>(new Request('https://internal.gitknot.com/mail-restore-access'), { env }), actor.id, 'restore source grant', async () => {
      await execute(env.DB, "DELETE FROM access_grants WHERE id='deny_mail_release'");
    });
    await execute(env.DB, `INSERT INTO webhooks(id,repo_id,account_id,principal_id,principal_json,url,events_json,state,created_at,updated_at)
      VALUES('wh_rotation_race','r_repo','u_owner','u_owner',?,'https://hooks.example.net/events','["issue.*"]','active','2000-01-01T00:00:00.000Z',?)`, JSON.stringify(actor), now());
    let signs = 0, sends = 0;
    env.SECRETS = { fetch: async () => {
      if (++signs === 1) await execute(env.DB, "UPDATE webhooks SET revision=revision+1 WHERE id='wh_rotation_race'");
      return Response.json({ signature: `v1,${Buffer.alloc(32, 1).toString('base64')}` });
    } } as unknown as Fetcher;
    env.WEBHOOK_EGRESS = { fetch: async (request: Request) => { const value = await request.json() as { headers: Record<string, string> };
      expect(value.headers['webhook-id']).toBe(event.id); sends++; return Response.json({ status: 204, retry_after: null, response_excerpt: '', response_truncated: false, duration_ms: 1 });
    } } as unknown as Fetcher;
    await scheduleWebhooks(env, event);
    const webhook = (await one<{ id: string }>(env.DB, "SELECT id FROM webhook_deliveries WHERE webhook_id='wh_rotation_race'"))!;
    await deliverWebhook(env, webhook.id);
    expect(await one(env.DB, 'SELECT state,error_code FROM webhook_deliveries WHERE id=?', webhook.id)).toEqual({ state: 'pending', error_code: 'configuration_changed' });
    expect(sends).toBe(0);
    await execute(env.DB, "UPDATE webhook_deliveries SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE id=?", webhook.id);
    await deliverWebhook(env, webhook.id);
    expect(signs).toBe(2); expect(sends).toBe(1);
    expect(await one(env.DB, 'SELECT event_id,generation,state FROM webhook_deliveries WHERE id=?', webhook.id)).toEqual({ event_id: event.id, generation: 0, state: 'succeeded' });
  });

  it('retains delayed committed sources using the database commit clock and the captured replay boundary', async () => {
    const { operations: env } = await fixture();
    const event = makeEvent({ id: 'evt_delayed_commit', type: 'operation.completed', resource_id: 'op_historical', resource_revision: 1,
      repo_id: 'r_repo', account_id: 'u_owner', occurred_at: new Date(Date.now() - 35 * 86400_000).toISOString() });
    await eventStatement(env.DB, event).run();
    await dispatchOutbox(env); await fanoutEvent(env, event.id);
    for (const consumer of ['webhooks', 'mail', 'index', 'meter', 'operations'] as const) await consumeEvent(env, event.id, consumer);
    expect(await one(env.DB, "SELECT COUNT(*) AS count FROM event_consumer_jobs WHERE event_id=? AND state='completed'", event.id)).toEqual({ count: 5 });
    await expireEventHistory(env);
    const source = await one<{ created_at: string; occurred_at: string }>(env.DB, 'SELECT created_at,occurred_at FROM outbox WHERE id=?', event.id);
    expect(source).not.toBeNull(); expect(source!.created_at > new Date(Date.now() - 60_000).toISOString()).toBe(true);
    expect(source!.occurred_at).toBe(event.occurred_at);
  });

  it('keeps private-fork run events out of public-target webhooks, replays and mail while allowing a fully scoped recipient', async () => {
    const { operations: env, actor, context } = await fixture();
    const at = now(), oid = 'a'.repeat(40), digest = 'b'.repeat(64);
    await execute(env.DB, "UPDATE repositories SET visibility='public' WHERE id='r_repo'");
    for (const name of ['fork', 'subscriber']) await env.DB.batch([
      stmt(env.DB, "INSERT INTO users(id,username,email,email_verified_at,created_at,updated_at) VALUES(?,?,?,?,?,?)", `u_${name}`, name, `${name}@example.net`, at, at, at),
      stmt(env.DB, "INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES(?,'user',?,?,?,?,?)", `u_${name}`, name, name, `u_${name}`, at, at),
      stmt(env.DB, "INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES(?,'user',?,?,?,?,?,?)", `u_${name}`, `u_${name}`, `u_${name}`, name, `u_${name}`, at, at),
    ]);
    const credential = await prepareCredential(env.DB, { principal_id: 'u_subscriber', user_id: 'u_subscriber', kind: 'personal', name: 'Public target subscriber',
      capabilities: ['*'], account_ids: null, repository_ids: null, auth_revision: 1, mfa: false, expires_at: new Date(Date.now() + 86400_000).toISOString(), created_by: 'u_subscriber' });
    await credential.statement.run();
    const subscriber: Principal = { ...actor, id: 'u_subscriber', user_id: 'u_subscriber', credential_id: credential.credential.id, mfa: false };
    await env.DB.batch([
      stmt(env.DB, `INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
        VALUES('r_fork','u_fork','fork','fork','private','active','local','core','fork','u_fork',?,?)`, at, at),
      stmt(env.DB, `INSERT INTO access_grants(id,account_id,repo_id,principal_type,principal_id,capability,effect,created_by,created_at,updated_at)
        VALUES('fork_read','u_fork','r_fork','user','u_owner','contents.read','allow','u_fork',?,?)`, at, at),
      stmt(env.DB, `INSERT INTO workflows(id,repo_id,account_id,name,path,current_version_id,created_by,created_at,updated_at)
        VALUES('wf_events','r_repo','u_owner','private-source','.gitknot/workflows/private.yaml','wfv_events','u_owner',?,?)`, at, at),
      stmt(env.DB, `INSERT INTO workflow_versions(id,workflow_id,repo_id,account_id,source_commit,definition_digest,definition,definition_json,policy_revision,approved_by,created_at)
        VALUES('wfv_events','wf_events','r_repo','u_owner',?,?,'version: 1','{}',1,'u_owner',?)`, oid, digest, at),
      stmt(env.DB, `INSERT INTO collaboration_items(id,repo_id,kind,number,title,author_id,state,created_at,updated_at)
        VALUES('pr_event_source','r_repo','pull_request',1,'Private run progress','u_owner','open',?,?)`, at, at),
      stmt(env.DB, "INSERT INTO pull_requests(id,repo_id,head_repo_id,base_ref,head_ref,base_oid,head_oid) VALUES('pr_event_source','r_repo','r_fork','refs/heads/main','refs/heads/main',?,?)", oid, oid),
      stmt(env.DB, `INSERT INTO pull_patches(id,repo_id,pull_id,version,head_repo_id,base_oid,head_oid,merge_base_oid,patch_fingerprint,native_evidence_id,created_by,created_at)
        VALUES('patch_event_source','r_repo','pr_event_source',1,'r_fork',?,?,?,?,'evidence_event_source','u_owner',?)`, oid, oid, oid, digest, at),
      stmt(env.DB, "UPDATE pull_requests SET current_patch_id='patch_event_source' WHERE id='pr_event_source'"),
    ]);
    const repository = (await one<Repository>(env.DB, "SELECT * FROM repositories WHERE id='r_repo'"))!;
    const source = await pinWorkflowSource(env.DB, repository, { commit: oid, ref: 'refs/heads/main', event: { type: 'pull_request.updated', id: 'source_fork_event', pull_request_id: 'pr_event_source' } });
    const plan: ExecutionPlan = { version: 1, repo_id: repository.id, account_id: repository.owner_id, source_repo_id: 'r_fork', related_repo_ids: ['r_repo', 'r_fork'], source_evidence: source,
      commit_sha: oid, source_ref: 'refs/heads/main', workflow_digest: digest, workflow_version_id: 'wfv_events', policy_revision: 1, trust: 'untrusted',
      trigger: { type: 'pull_request.updated', id: 'source_fork_event', pull_request_id: 'pr_event_source' }, concurrency: { key: null, supersede: false },
      jobs: [{ key: 'inspect', needs: [], executor: { type: 'hosted', profile: 'linux-small' }, toolchain: { name: 'fixture', digest, image: 'fixture', os: 'linux', architecture: 'amd64' },
        producer_id: 'fixture', timeout_ms: 1000, infrastructure_retries: 0, applicable: false, inapplicable_reason: 'Source-event proof only', steps: [], cache: null, outputs: {}, inputs: [],
        egress: { hosts: [], max_requests: 1, max_bytes: 1, max_request_bytes: 1 }, environment: null }], portable_manifest: {}, actor, routing_epoch: 1 };
    const run = await createRun(env, env.DB, { workflow_id: 'wf_events', plan, actor_id: actor.id, request_key: 'private-event', request_hash: 'private-event' });
    const sourceRow = (await one<{ event_json: string }>(env.DB, "SELECT event_json FROM outbox WHERE type='workflow.run.created' AND resource_id=?", run.id))!;
    const event = JSON.parse(sourceRow.event_json) as EventRecord;
    // Today's public PR head cannot authorize its earlier private-source execution.
    await execute(env.DB, "UPDATE pull_requests SET head_repo_id='r_repo' WHERE id='pr_event_source'");
    for (const [id, principal] of [['wh_allowed', actor], ['wh_target_only', subscriber]] as const) await execute(env.DB,
      `INSERT INTO webhooks(id,repo_id,account_id,principal_id,principal_json,url,events_json,state,created_at,updated_at)
        VALUES(?,'r_repo','u_owner',?,?,'https://hooks.example.net/events','["workflow.run.*"]','active','2000-01-01T00:00:00.000Z',?)`, id, principal.id, JSON.stringify(principal), at);
    const broker = createSecretsBroker(), operator = base64url(randomBytes(32));
    const brokerEnv: SecretsBrokerBindings = { ...env, SECRETS_KEK_CURRENT_ID: 'events', SECRETS_KEK_KEYRING_JSON: JSON.stringify({ events: base64url(randomBytes(32)) }),
      SECRETS_SERVICE_KEYS_JSON: JSON.stringify({ 'test-background': { key: env.SECRETS_CLIENT_KEY, scopes: ['webhooks.manage', 'webhooks.sign'] }, operator: { key: operator, scopes: ['vault.rotate'] } }) };
    let revokeAtSign = false;
    env.SECRETS = { fetch: async (request: Request) => {
      const response = await broker.fetch(request, brokerEnv, context);
      if (revokeAtSign && new URL(request.url).pathname.endsWith('/sign') && response.ok) {
        revokeAtSign = false;
        await withAccountAuthorityBarrier(backgroundContext(env, actor), 'u_fork', 'revoke private source after signing', async () => { await execute(env.DB, "UPDATE access_grants SET revoked_at=?,revision=revision+1 WHERE id='fork_read'", now()); });
      }
      return response;
    } } as unknown as Fetcher;
    await brokerRequest({ SECRETS: env.SECRETS, SECRETS_CLIENT_ID: 'operator', SECRETS_CLIENT_KEY: operator }, 'vault.rotate', '/internal/vault/keys/register', { expected_revision: 0 });
    const app = api(env, actor); registerIntegrationsRoutes(app);
    for (const id of ['wh_allowed', 'wh_target_only']) {
      const response = await app.fetch(new Request(`https://api.gitknot.com/v1/webhooks/${id}/keys`, { method: 'POST', headers: {
        'content-type': 'application/json', 'if-match': '"1"', 'idempotency-key': `key-${id}` }, body: '{}' }), env, context);
      expect(response.status, await response.clone().text()).toBe(201);
    }
    const sent: string[] = [];
    env.WEBHOOK_EGRESS = { fetch: async (request: Request) => { const input = await request.json() as { body: string }; sent.push(input.body);
      return Response.json({ status: 204, retry_after: null, response_excerpt: '', response_truncated: false, duration_ms: 1 }); } } as Fetcher;
    await scheduleWebhooks(env, event);
    expect(await one(env.DB, "SELECT COUNT(*) AS n FROM webhook_deliveries WHERE webhook_id='wh_target_only'")).toEqual({ n: 0 });
    const delivery = (await one<Delivery>(env.DB, "SELECT * FROM webhook_deliveries WHERE webhook_id='wh_allowed'"))!;
    await deliverWebhook(env, delivery.id);
    expect(sent).toHaveLength(1); expect(JSON.parse(sent[0]!)).toMatchObject({ resource_id: run.id, data: { run_id: run.id } });
    const current = (await one<Delivery>(env.DB, 'SELECT * FROM webhook_deliveries WHERE id=?', delivery.id))!;
    const redelivered = await app.fetch(new Request(`https://api.gitknot.com/v1/deliveries/${delivery.id}/redeliver`, { method: 'POST', headers: {
      'content-type': 'application/json', 'if-match': `"${current.revision}"`, 'idempotency-key': 'private-redelivery' }, body: '{}' }), env, context);
    expect(redelivered.status, await redelivered.clone().text()).toBe(202);
    revokeAtSign = true;
    await deliverWebhook(env, (await redelivered.json() as { id: string }).id);
    expect(revokeAtSign).toBe(false); expect(sent).toHaveLength(1);
    expect(await one(env.DB, "SELECT state FROM webhooks WHERE id='wh_allowed'")).toEqual({ state: 'active' });
    const replay = await app.fetch(new Request('https://api.gitknot.com/v1/events/replay', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'private-replay' },
      body: JSON.stringify({ repo_id: 'r_repo', webhook_id: 'wh_allowed', since: new Date(Date.now() - 60_000).toISOString() }) }), env, context);
    expect(replay.status, await replay.clone().text()).toBe(202); await sweepReplays(env);
    expect(await one(env.DB, 'SELECT state,delivered_count FROM event_replays WHERE id=?', (await replay.json() as { id: string }).id)).toEqual({ state: 'completed', delivered_count: 0 });
    await env.DB.batch([
      stmt(env.DB, "INSERT INTO collaboration_mentions(repo_id,resource_id,document_revision,user_id,created_at) VALUES('r_repo','pr_event_source',1,'u_subscriber',?)", at),
      stmt(env.DB, `INSERT INTO collaboration_inbox(id,user_id,repo_id,item_id,reason,source_id,source_event_id,state,created_at,updated_at)
        VALUES('inbox_private_run','u_subscriber','r_repo','pr_event_source','mention','pr_event_source',?,'outstanding',?,?)`, event.id, at, at),
    ]);
    await scheduleMail(env, event);
    expect(await one(env.DB, 'SELECT COUNT(*) AS n FROM mail_deliveries WHERE event_id=?', event.id)).toEqual({ n: 0 });
  });

  it('uses stable move admission and survives lost finalization/release receipts before consuming both source envelopes at the new placement', async () => {
    const test = await fixture();
    const { operations: env, actor } = test;
    const shard = await secondaryShard(test);
    const native = nativeLifecycleService({ loseRelease: true }); env.GIT_SERVICE = native.service;
    await execute(env.DB, `INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,status,phase,input_json,created_at,updated_at)
      VALUES('op_provisioned','repository.provision','r_repo','r_repo','u_owner','u_owner','completed','completed','{}',?,?)`, now(), now());
    await consumeOnce(env.DB, 'catalog:op_provisioned:active', 'op_provisioned', []);
    const event = await source(env, 'evt_before_move'); await fanoutEvent(env, event.id);
    await execute(env.DB, `INSERT INTO webhooks(id,repo_id,account_id,principal_id,principal_json,url,events_json,state,created_at,updated_at)
      VALUES('wh_moving','r_repo','u_owner','u_owner',?,'https://hooks.example.net/events','["issue.*"]','active','2000-01-01T00:00:00.000Z',?)`, JSON.stringify(actor), now());
    const input = { repo_id: 'r_repo', target_cell_id: 'local', target_shard_id: 'secondary', expected_epoch: 1 };
    const submit = async (value = input) => background.fetch(await signInternalRequest(new Request('https://internal.gitknot.com/internal/operations/move', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
    }), env.INTERNAL_SERVICE_KEY, 'operations.maintenance'), env);
    const first = await submit(); expect(first.status, await first.clone().text()).toBe(202);
    const accepted = await first.json() as { id: string };
    expect(await (await submit()).json()).toMatchObject({ id: accepted.id });
    expect(await one(env.DB, 'SELECT resource_type,repo_id FROM resource_locators WHERE resource_id=?', accepted.id)).toEqual({ resource_type: 'operation', repo_id: 'r_repo' });
    expect((await submit({ ...input, target_shard_id: 'other' })).status).toBe(409);
    const originalBatch = shard.batch.bind(shard);
    let lostFinalization = true;
    shard.batch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      const result = await originalBatch<T>(statements);
      if (lostFinalization && statements.some(statement => /UPDATE move_staging SET state='active'/.test((statement as unknown as { sql: string }).sql))) {
        lostFinalization = false; throw new Error('injected lost target finalization receipt');
      }
      return result;
    };
    const operation = await operationById(env, accepted.id);
    await expect(runShardMove(env, operation)).rejects.toThrow('injected lost target finalization receipt');
    expect(await one(env.DB, 'SELECT epoch,state FROM resource_routes WHERE resource_id=?', 'r_repo')).toEqual({ epoch: 2, state: 'active' });
    // Routing can advance during settlement; the destination's exact local fence still closes ordinary writes.
    expect(await one(shard, "SELECT state,routing_epoch FROM repository_metadata_fences WHERE repo_id='r_repo'")).toEqual({ state: 'held', routing_epoch: 2 });
    await expect(runShardMove(env, operation)).rejects.toThrow('injected lost barrier release receipt');
    const moved = await runShardMove(env, operation);
    expect(moved.routing_epoch).toBe(2);
    expect(native.acquisitions()).toBe(1);
    expect(await (await submit()).json()).toMatchObject({ id: accepted.id, status: 'completed' });
    const target = shardEnvironment(env, 'secondary');
    expect(await one(target.DB, "SELECT event_id FROM processed_events WHERE consumer='catalog:op_provisioned:active'")).toEqual({ event_id: 'op_provisioned' });
    expect(await one(env.DB, 'SELECT purpose FROM operations_maintenance_intents WHERE operation_id=?', accepted.id)).toEqual({ purpose: 'repository.move' });
    expect(await one(target.DB, "SELECT disabled_at IS NOT NULL AS disabled FROM accounts WHERE id='u_owner'")).toEqual({ disabled: 1 });
    expect(await one(target.DB, 'SELECT COUNT(*) AS count FROM credentials')).toEqual({ count: 0 });
    await consumeEvent(env, event.id, 'webhooks');
    await consumeEvent(target, event.id, 'webhooks');
    expect(await one(env.DB, 'SELECT COUNT(*) AS count FROM webhook_deliveries')).toEqual({ count: 0 });
    expect(await one(target.DB, 'SELECT COUNT(*) AS count FROM webhook_deliveries')).toEqual({ count: 1 });
    const created = await source(target, 'evt_only_at_destination');
    await dispatchOutbox(target);
    expect(test.events.messages).toContainEqual({ event_id: created.id, shard_id: 'secondary', cell_id: 'local' });
    let acknowledgements = 0, retries = 0;
    const queued = async (shardId: string) => background.queue({ queue: 'gitknot-events', messages: [{ id: `message-${shardId}`, body: {
      event_id: created.id, cell_id: 'local', shard_id: shardId }, ack: () => { acknowledgements++; }, retry: () => { retries++; } }] } as unknown as MessageBatch<unknown>, env);
    await queued('secondary'); expect(acknowledgements).toBe(1); expect(retries).toBe(0);
    expect(await one(target.DB, 'SELECT COUNT(*) AS count FROM event_consumer_jobs WHERE event_id=?', created.id)).toEqual({ count: 5 });
    await queued('core'); expect(acknowledgements).toBe(1); expect(retries).toBe(1);
  });

  it('tombstones never-admitted Core upload intents and releases only their repository-local reservations once', async () => {
    const { operations: env } = await fixture();
    await env.DB.batch([
      stmt(env.DB, `INSERT INTO storage_quotas(scope_id,limit_bytes,reserved_bytes,updated_at) VALUES('r_repo',1000,12,?)`, now()),
      stmt(env.DB, `INSERT INTO object_manifests(id,repo_id,account_id,kind,object_key,filename,bytes,sha256,state,created_by,retention_until,created_at,updated_at)
        VALUES('obj_unused','r_repo','u_owner','attachment','u_owner/r_repo/uploads/obj_unused','unused.txt',12,?,'reserving','u_owner','2000-01-01T00:00:00.000Z',?,?)`, '0'.repeat(64), now(), now()),
    ]);
    await deleteExpiredObjects(env); await deleteExpiredObjects(env);
    expect(await one(env.DB, 'SELECT state FROM object_manifests WHERE id=?', 'obj_unused')).toEqual({ state: 'deleted' });
    expect(await one(env.DB, 'SELECT reserved_bytes,used_bytes FROM storage_quotas WHERE scope_id=?', 'r_repo')).toEqual({ reserved_bytes: 0, used_bytes: 0 });
    expect(await one(env.DB, 'SELECT scope_id FROM storage_quotas WHERE scope_id=?', 'u_owner')).toBeNull();
    expect(await one(env.DB, "SELECT COUNT(*) AS count FROM outbox WHERE resource_id='obj_unused' AND type='object.deleted'")).toEqual({ count: 1 });
    expect(await one(env.DB, "SELECT COUNT(*) AS count FROM billing_ledger WHERE object_id='obj_unused'")).toEqual({ count: 0 });
  });

  it('rechecks the accepted receiver transfer capability before publishing ownership', async () => {
    const { operations: env, actor, context } = await fixture();
    const at = now();
    await env.DB.batch([
      stmt(env.DB, `INSERT INTO users(id,username,email,display_name,email_verified_at,created_at,updated_at) VALUES('u_receiver','receiver','receiver@example.net','Receiver',?,?,?)`, at, at, at),
      stmt(env.DB, `INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES('u_receiver','user','receiver','Receiver','u_receiver',?,?)`, at, at),
      stmt(env.DB, `INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES('u_receiver','user','u_receiver','u_receiver','Receiver','u_receiver',?,?)`, at, at),
    ]);
    const credential = await prepareCredential(env.DB, { principal_id: 'u_receiver', user_id: 'u_receiver', kind: 'session', name: 'Transfer receiver',
      capabilities: null, repository_ids: null, account_ids: null, auth_revision: 1, mfa: true, expires_at: new Date(Date.now() + 600_000).toISOString(), created_by: 'u_receiver' });
    await credential.statement.run();
    const receiver: Principal = { ...actor, id: 'u_receiver', user_id: 'u_receiver', credential_id: credential.credential.id, capabilities: null };
    env.GIT_SERVICE = nativeLifecycleService().service;
    const senderApi = api(env, actor); registerRepositoryLifecycleRoutes(senderApi);
    const receiverApi = api(env, receiver); registerRepositoryLifecycleRoutes(receiverApi);
    const created = await senderApi.fetch(new Request('https://api.gitknot.com/v1/repos/r_repo/transfers', { method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': '"1"' }, body: JSON.stringify({ destination_owner_id: receiver.id }) }), env, context);
    expect(created.status, await created.clone().text()).toBe(202);
    const transfer = await created.json() as { id: string; revision: number; operation_id: string };
    const accepted = await receiverApi.fetch(new Request(`https://api.gitknot.com/v1/repos/r_repo/transfers/${transfer.id}/accept`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': `"${transfer.revision}"` }, body: '{}' }), env, context);
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    await withAccountAuthorityBarrier(new Context<AppEnv>(new Request('https://internal.gitknot.com/test-revocation'), { env }), receiver.id, 'receiver transfer grant revoked', async () => {
      await execute(env.DB, `INSERT INTO access_grants(id,account_id,principal_type,principal_id,capability,effect,created_by,created_at,updated_at)
        VALUES('deny_receiver_transfer','u_receiver','user','u_receiver','repositories.transfer','deny','u_receiver',?,?)`, now(), now());
    });
    const row = await one<{ operation_id: string }>(env.DB, 'SELECT operation_id FROM repository_transfers WHERE id=?', transfer.id);
    const operation = await operationById(env, row!.operation_id);
    const step = { do: async <T>(_name: string, _options: unknown, action: () => Promise<T>) => action() };
    await expect(runLifecycle(env, operation, step)).rejects.toMatchObject({ status: 403 });
    expect(await one(env.DB, "SELECT owner_id,state FROM repositories WHERE id='r_repo'")).toEqual({ owner_id: actor.id, state: 'moving' });
    expect(await one(env.DB, 'SELECT storage_effective_at,state FROM repository_transfers WHERE id=?', transfer.id)).toEqual({ storage_effective_at: null, state: 'accepted' });
  });

  it('retires an expired private workspace only through its committed automatic parent operation', async () => {
    const { operations: env } = await fixture();
    const parent = { automatic: true, workspace_id: 'ws_retained', workspace_repo_id: 'r_workspace' };
    const child = { maintenance: true, maintenance_kind: 'task_workspace_retention', workspace_id: 'ws_retained', parent_operation_id: 'op_retention_parent' };
    await env.DB.batch([
      stmt(env.DB, `INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,fork_source_id,created_by,created_at,updated_at)
        VALUES('r_workspace','u_owner','workspace','workspace','private','active','local','core','workspace_store','r_repo','u_owner',?,?)`, now(), now()),
      stmt(env.DB, `INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,epoch,state,updated_at) VALUES('r_workspace','repository','local','core',1,'active',?)`, now()),
      stmt(env.DB, `INSERT INTO collaboration_items(id,repo_id,kind,number,title,author_id,state,created_at,updated_at)
        VALUES('task_retention','r_repo','task',1,'Retained workspace','u_owner','open',?,?)`, now(), now()),
      stmt(env.DB, `INSERT INTO tasks(id,repo_id,accountable_user_id,base_oid) VALUES('task_retention','r_repo','u_owner',?)`, 'a'.repeat(40)),
      stmt(env.DB, `INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,status,input_json,created_at,updated_at)
        VALUES('op_retention_parent','collaboration.workspace_retire','ws_retained','r_repo','u_owner','system:collaboration-retention','waiting',?,?,?)`, JSON.stringify(parent), now(), now()),
      stmt(env.DB, `INSERT INTO collaboration_operation_contexts(operation_id,repo_id,item_id,principal_json,input_digest,checkpoint_json,created_at,updated_at)
        VALUES('op_retention_parent','r_repo','task_retention','{}',?,?,?,?)`, await sha256(JSON.stringify(parent)),
      JSON.stringify({ retirement_operation_id: 'op_retention_child', retirement_kind: 'archive' }), now(), now()),
      stmt(env.DB, `INSERT INTO task_workspaces(id,repo_id,task_id,workspace_repo_id,owner_principal_id,base_oid,operation_id,state,retention_until,last_active_at,created_at,updated_at)
        VALUES('ws_retained','r_repo','task_retention','r_workspace','u_owner',?,'op_retention_parent','expiring','2000-01-01T00:00:00.000Z',?,?,?)`, 'a'.repeat(40), now(), now(), now()),
      stmt(env.DB, `INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,input_json,created_at,updated_at)
        VALUES('op_retention_child','repository.archive','r_workspace','r_workspace','u_owner','system:collaboration-retention',?,?,?)`, JSON.stringify(child), now(), now()),
      stmt(env.DB, `INSERT INTO repository_lifecycle(operation_id,repo_id,account_id,kind,previous_state,desired_state,input_json,expected_repository_revision,created_by,created_at,updated_at)
        VALUES('op_retention_child','r_workspace','u_owner','archive','active','archived',?,1,'system:collaboration-retention',?,?)`, JSON.stringify(child), now(), now()),
    ]);
    const operation = await operationById(env, 'op_retention_child');
    const step = { do: async <T>(_name: string, _options: unknown, action: () => Promise<T>) => action() };
    await expect(runLifecycle(env, { ...operation, input_json: JSON.stringify({ ...child, parent_operation_id: 'missing_parent' }) }, step)).rejects.toMatchObject({ status: 403 });
    expect(await one(env.DB, "SELECT state FROM repositories WHERE id='r_workspace'")).toEqual({ state: 'active' });
    env.GIT_SERVICE = nativeLifecycleService().service;
    const result = await runLifecycle(env, operation, step);
    await completeOperation(env, operation, result);
    expect(await one(env.DB, "SELECT state FROM repositories WHERE id='r_workspace'")).toEqual({ state: 'archived' });
    expect((await operationById(env, operation.id)).status).toBe('completed');
    expect(await one(env.DB, "SELECT state FROM task_workspaces WHERE id='ws_retained'")).toEqual({ state: 'expiring' });
  });
  it('recovers a committed event after Queue loss and rolls consumer effects back with their receipt', async () => {
    const { operations: env, db } = await fixture();
    await source(env);
    const transport = new TestQueue<{ event_id: string }>();
    let unavailable = true;
    env.EVENTS = { send: async (body: { event_id: string }) => { if (unavailable) throw new Error('injected queue outage'); await transport.send(body); } } as unknown as Queue<{ event_id: string }>;
    await dispatchOutbox(env);
    expect(await one(env.DB, 'SELECT id FROM outbox WHERE id=?', 'evt_change')).not.toBeNull();
    expect(transport.messages).toHaveLength(0);
    unavailable = false;
    await execute(env.DB, `UPDATE event_publications SET next_attempt_at='2000-01-01T00:00:00.000Z'`);
    await dispatchOutbox(env);
    // Simulate an acknowledged Queue publication disappearing before any consumer handles it.
    transport.messages.splice(0);
    await execute(env.DB, `UPDATE event_publications SET last_enqueued_at='2000-01-01T00:00:00.000Z'`);
    await dispatchOutbox(env);
    expect(transport.messages).toHaveLength(1);
    await Promise.all([fanoutEvent(env, 'evt_change'), fanoutEvent(env, 'evt_change')]);
    expect(await one(env.DB, 'SELECT COUNT(*) AS count FROM event_consumer_jobs')).toEqual({ count: 5 });
    db.sqlite.exec('CREATE TABLE consumer_effects(id TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK(value>0))');
    await expect(consumeOnce(env.DB, 'test-effect', 'evt_change', [stmt(env.DB, 'INSERT INTO consumer_effects VALUES(?,?)', 'effect', 0)])).rejects.toThrow();
    expect(await one(env.DB, `SELECT 1 FROM processed_events WHERE consumer='test-effect'`)).toBeNull();
    await consumeOnce(env.DB, 'test-effect', 'evt_change', [stmt(env.DB, 'INSERT INTO consumer_effects VALUES(?,?)', 'effect', 1)]);
    await consumeOnce(env.DB, 'test-effect', 'evt_change', [stmt(env.DB, 'UPDATE consumer_effects SET value=value+1')]);
    expect(await one(env.DB, 'SELECT value FROM consumer_effects')).toEqual({ value: 1 });
  });

  it('keeps event identity on redelivery, signs each attempt, and cancels queued payloads after access revocation', async () => {
    const { operations: env, actor, context } = await fixture();
    const secret = randomBytes(32);
    const outbound: { body: string; headers: Record<string, string> }[] = [];
    let status = 503;
    env.SECRETS = { fetch: async (request: Request) => {
      const input = await request.json() as { event_id: string; timestamp: number; body: string };
      const signature = createHmac('sha256', secret).update(`${input.event_id}.${input.timestamp}.${input.body}`).digest('base64');
      return Response.json({ signature: `v1,${signature}` });
    } } as unknown as Fetcher;
    env.WEBHOOK_EGRESS = { fetch: async (request: Request) => {
      const body = await request.json() as { body: string; headers: Record<string, string> };
      outbound.push(body);
      return Response.json({ status, retry_after: '1', response_excerpt: 'receiver response', response_truncated: false, duration_ms: 2 });
    } } as unknown as Fetcher;
    await execute(env.DB, `INSERT INTO webhooks(id,repo_id,account_id,principal_id,principal_json,url,events_json,state,created_at,updated_at)
      VALUES('wh_test','r_repo','u_owner','u_owner',?,'https://hooks.receiver.net/events','["issue.*"]','active','2000-01-01T00:00:00.000Z',?)`, JSON.stringify(actor), now());
    const event = await source(env);
    await scheduleWebhooks(env, event);
    const first = (await one<Delivery>(env.DB, 'SELECT * FROM webhook_deliveries'))!;
    await deliverWebhook(env, first.id);
    expect(await one(env.DB, 'SELECT state,attempt_count FROM webhook_deliveries WHERE id=?', first.id)).toEqual({ state: 'pending', attempt_count: 1 });
    status = 204;
    await execute(env.DB, `UPDATE webhook_deliveries SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE id=?`, first.id);
    await deliverWebhook(env, first.id);
    const delivered = (await one<Delivery>(env.DB, 'SELECT * FROM webhook_deliveries WHERE id=?', first.id))!;
    expect(delivered.state).toBe('succeeded');
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => { c.set('principal', actor); c.set('requestId', 'req_test'); c.set('database', env.DB.withSession('first-primary')); await next(); });
    registerIntegrationsRoutes(app);
    const response = await app.fetch(new Request(`https://api.gitknot.com/v1/deliveries/${first.id}/redeliver`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': `"${delivered.revision}"`, 'idempotency-key': 'manual-redelivery' }, body: '{}' }), env, context);
    expect(response.status).toBe(202);
    const redelivery = await response.json() as { id: string; event_id: string; generation: number };
    expect(redelivery.event_id).toBe(event.id);
    expect(redelivery.id).not.toBe(first.id);
    expect(redelivery.generation).toBe(1);
    await deliverWebhook(env, redelivery.id);
    expect(outbound).toHaveLength(3);
    for (const delivery of outbound) {
      expect(delivery.headers['webhook-id']).toBe(event.id);
      expect(delivery.headers['webhook-signature']).toBe(`v1,${createHmac('sha256', secret).update(`${event.id}.${delivery.headers['webhook-timestamp']}.${delivery.body}`).digest('base64')}`);
      expect(delivery.body).not.toContain('never-release');
    }
    const later = await source(env, 'evt_later');
    await scheduleWebhooks(env, later);
    await execute(env.DB, `INSERT INTO access_grants(id,account_id,repo_id,principal_type,principal_id,capability,effect,created_by,created_at,updated_at)
      VALUES('grant_deny','u_owner','r_repo','user','u_owner','issues.read','deny','u_owner',?,?)`, now(), now());
    const denied = (await one<Delivery>(env.DB, 'SELECT * FROM webhook_deliveries WHERE event_id=?', later.id))!;
    await deliverWebhook(env, denied.id);
    expect(outbound).toHaveLength(3);
    expect(await one(env.DB, 'SELECT state,error_code FROM webhook_deliveries WHERE id=?', denied.id)).toEqual({ state: 'cancelled', error_code: 'access_revoked' });
    expect(['127.0.0.1', '169.254.169.254', '::ffff:127.0.0.1', '2002:7f00:1::', 'fe80::1'].every((address) => !isPublicAddress(address))).toBe(true);
    await execute(env.DB, `DELETE FROM access_grants WHERE id='grant_deny'`);
    const since = new Date(Date.now() - 60_000).toISOString();
    const replay = await app.fetch(new Request('https://api.gitknot.com/v1/events/replay', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repo_id: 'r_repo', webhook_id: 'wh_test', since }) }), env, context);
    expect(replay.status).toBe(202);
    const replayId = (await replay.json() as { id: string }).id;
    const postBoundary = await source(env, 'evt_after_replay_boundary');
    // A backdated source timestamp must not move a newly committed event into an existing replay.
    await execute(env.DB, 'UPDATE outbox SET created_at=? WHERE id=?', since, postBoundary.id);
    await sweepReplays(env);
    expect(await one(env.DB, 'SELECT state,delivered_count FROM event_replays WHERE id=?', replayId)).toEqual({ state: 'completed', delivered_count: 2 });
    expect(await one(env.DB, 'SELECT id FROM webhook_deliveries WHERE replay_id=? AND event_id=?', replayId, postBoundary.id)).toBeNull();
  });

  it('resumes provision after failed native verification and only releases storage quota after physical deletion', async () => {
    const { operations: env, actor, blobs } = await fixture();
    await execute(env.DB, `UPDATE repositories SET state='provisioning' WHERE id='r_repo'`);
    await execute(env.DB, `INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,input_json,created_at,updated_at)
      VALUES('op_recovery','repository.provision','r_repo','r_repo','u_owner','u_owner',?,?,?)`, JSON.stringify({ principal: actor }), now(), now());
    let provisioned = 0;
    let failed = true;
    env.GIT_SERVICE = { fetch: async (request: Request) => {
      if (new URL(request.url).pathname.endsWith('/provision')) { provisioned++; return Response.json({ ready: true }); }
      if (failed) return Response.json({ detail: 'injected native provider failure' }, { status: 503 });
      return Response.json({ verified: true, objects_verified: true, refs: [] });
    } } as unknown as Fetcher;
    const step = { do: async <T>(_name: string, _options: unknown, callback: () => Promise<T>) => callback() };
    const operation = await operationById(env, 'op_recovery');
    await expect(runLifecycle(env, operation, step).catch(async (error) => { await failOperation(env, operation.id, error); throw error; })).rejects.toThrow();
    expect((await operationById(env, operation.id)).status).toBe('failed');
    expect(await one(env.DB, 'SELECT state FROM repositories WHERE id=?', 'r_repo')).toEqual({ state: 'provisioning' });
    failed = false;
    const result = await runLifecycle(env, await operationById(env, operation.id), step);
    await completeOperation(env, operation, result);
    expect((await operationById(env, operation.id)).status).toBe('completed');
    expect(provisioned).toBe(1);
    const object = await putObject(env, { id: 'obj_retained', repo_id: 'r_repo', account_id: 'u_owner', actor_id: actor.id,
      kind: 'scan_chunk', key: 'u_owner/r_repo/results/retained', data: new TextEncoder().encode('retained bytes'), content_type: 'text/plain', retention_until: new Date(Date.now() + 600_000).toISOString() });
    await execute(env.DB, "UPDATE object_manifests SET retention_until='2000-01-01T00:00:00.000Z' WHERE id=?", object.id);
    const originalDelete = blobs.delete.bind(blobs);
    blobs.delete = async () => { throw new Error('injected R2 delete failure'); };
    await expect(deleteExpiredObjects(env)).rejects.toThrow();
    expect(await one(env.DB, 'SELECT used_bytes FROM storage_quotas WHERE scope_id=?', 'r_repo')).toEqual({ used_bytes: object.bytes });
    expect(await one(env.DB, 'SELECT scope_id FROM storage_quotas WHERE scope_id=?', 'u_owner')).toBeNull();
    expect(await blobs.head(object.object_key)).not.toBeNull();
    blobs.delete = originalDelete;
    await deleteExpiredObjects(env);
    await deleteExpiredObjects(env);
    expect(await blobs.head(object.object_key)).toBeNull();
    expect(await one(env.DB, 'SELECT used_bytes FROM storage_quotas WHERE scope_id=?', 'r_repo')).toEqual({ used_bytes: 0 });
    expect(await one(env.DB, `SELECT COUNT(*) AS count FROM outbox WHERE type='object.deleted' AND resource_id=?`, object.id)).toEqual({ count: 1 });
  });

  it('publishes the checksum of the actual portable download and rejects corrupted archive chunks', async () => {
    const { operations: env, actor, backups } = await fixture();
    const parent = '/private/var/folders/zh/l70grz9n3ll9j9c_f1ghp7gr0000gn/T/opencode';
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, 'gitknot-events-'));
    try {
      const command = promisify(execFile);
      const git = async (...args: string[]) => String((await command('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: directory, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
      })).stdout).trim();
      await git('init', '--template=', '--initial-branch=main');
      await writeFile(join(directory, 'README.md'), '# Verified archive\n');
      await git('add', 'README.md');
      await git('-c', 'user.name=GitKnot Test', '-c', 'user.email=test@example.net', 'commit', '-m', 'Archive fixture');
      const oid = await git('rev-parse', 'HEAD');
      await git('switch', '-c', 'retained-private');
      await writeFile(join(directory, 'secret.txt'), 'historical private source content\n');
      await git('add', 'secret.txt');
      await git('-c', 'user.name=GitKnot Test', '-c', 'user.email=test@example.net', 'commit', '-m', 'Private retained history');
      const privateOid = await git('rev-parse', 'HEAD');
      const candidateRef = 'refs/gitknot/candidates/private_history';
      const evidenceId = await reviewEvidenceId('r_repo', 'r_private', oid, privateOid);
      const review = reviewRefs(evidenceId);
      const refs = [{ ref: 'refs/heads/main', oid }, { ref: candidateRef, oid: privateOid },
        ...review.map((ref, index) => ({ ref, oid: index === 1 ? privateOid : oid }))];
      for (const ref of refs.slice(1)) await git('update-ref', ref.ref, ref.oid);
      await git('switch', 'main'); await git('branch', '-D', 'retained-private');
      await git('bundle', 'create', 'repository.bundle', ...refs.map(ref => ref.ref));
      await git('bundle', 'verify', 'repository.bundle');
      expect(await git('show', `${candidateRef}:secret.txt`)).toBe('historical private source content');
      const bundle = new Uint8Array(await readFile(join(directory, 'repository.bundle')));
      await env.DB.batch([
        stmt(env.DB, `INSERT INTO users(id,username,email,display_name,email_verified_at,created_at,updated_at) VALUES('u_private','private-source','private@example.net','Private',?,?,?)`, now(), now(), now()),
        stmt(env.DB, `INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES('u_private','user','private-source','Private','u_private',?,?)`, now(), now()),
        stmt(env.DB, `INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES('u_private','user','u_private','u_private','Private','u_private',?,?)`, now(), now()),
        stmt(env.DB, `INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
          VALUES('r_private','u_private','private','private','private','active','local','core','storage_private','u_private',?,?)`, now(), now()),
        stmt(env.DB, `INSERT INTO access_grants(id,account_id,repo_id,principal_type,principal_id,capability,effect,created_by,created_at,updated_at)
          VALUES('archive_source_reader','u_private','r_private','user','u_owner','contents.read','allow','u_private',?,?)`, now(), now()),
        stmt(env.DB, `INSERT INTO git_candidates(repo_id,id,source_repo_id,source_oid,target_ref,target_oid,candidate_oid,internal_ref,strategy,policy_revision,actor_id,state,operation_id,created_at,updated_at)
          VALUES('r_repo','private_history','r_private',?,'refs/heads/main',?,?,?,'merge',1,'u_owner','obsolete','candidate_private',?,?)`, privateOid, oid, privateOid, candidateRef, now(), now()),
        stmt(env.DB, `INSERT INTO git_review_snapshots(repo_id,id,source_repo_id,base_oid,head_oid,merge_base_oid,operation_id,actor_id,state,created_at,updated_at)
          VALUES('r_repo',?,'r_private',?,?,?,'review_private','u_owner','ready',?,?)`, evidenceId, oid, privateOid, oid, now(), now()),
      ]);
      env.GIT_SERVICE = { fetch: async () => new Response(bundle, { headers: { 'content-type': 'application/x-git-bundle', 'content-length': String(bundle.byteLength) } }) } as unknown as Fetcher;
      await execute(env.DB, `INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,input_json,created_at,updated_at)
        VALUES('op_archive','repository.export','r_repo','r_repo','u_owner','u_owner',?,?,?)`, JSON.stringify({ principal: actor }), now(), now());
      const operation = await operationById(env, 'op_archive');
      const repo = (await one<Repository>(env.DB, 'SELECT * FROM repositories WHERE id=?', 'r_repo'))!;
      const result = await createArchive(env, operation, repo, refs, 'export');
      const manifest = await readArchive(env, result.archive_id, repo.id);
      expect(manifest.audience_repo_ids).toEqual(['r_private', 'r_repo']);
      expect(manifest.ref_audiences).toContainEqual({ ref: candidateRef, oid: privateOid, source_repo_id: 'r_private' });
      const output = new Uint8Array(await new Response(portableArchiveStream(env, manifest, async () => undefined)).arrayBuffer());
      expect(createHash('sha256').update(output).digest('hex')).toBe(result.sha256);
      expect(output.byteLength).toBe(result.bytes);
      expect(output.byteLength % 512).toBe(0);
      const catalog = (await one<{ manifest_sha256: string; archive_sha256: string }>(env.DB, 'SELECT manifest_sha256,archive_sha256 FROM repository_archives WHERE id=?', result.archive_id))!;
      expect(catalog.archive_sha256).toBe(result.sha256);
      expect(catalog.manifest_sha256).not.toBe(result.sha256);
      const readerContext = new Context<AppEnv>(new Request('https://api.gitknot.com/archive-read'), { env });
      readerContext.set('principal', actor); readerContext.set('requestId', 'archive-read');
      await authorizeArchive(readerContext, result.archive_id);
      const reader = portableArchiveStream(env, manifest, archiveAuthorizer(readerContext, result.archive_id)).getReader();
      expect((await reader.read()).done).toBe(false);
      await withAccountAuthorityBarrier(new Context<AppEnv>(new Request('https://internal.gitknot.com/archive-revoke'), { env }), 'u_private', 'private history access revoked', async () => {
        await execute(env.DB, "UPDATE access_grants SET revoked_at=?,revision=revision+1 WHERE id='archive_source_reader'", now());
      });
      await expect(reader.read()).rejects.toMatchObject({ status: 404 });
      await expect(authorizeArchive(readerContext, result.archive_id)).rejects.toMatchObject({ status: 404 });
      const part = manifest.parts.find((value) => value.path.startsWith('git/'))!;
      await backups.put(part.object_key, new TextEncoder().encode('corrupted object'));
      await expect(new Response(portableArchiveStream(env, manifest, async () => undefined)).arrayBuffer()).rejects.toThrow('archive_part_missing');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('prepares identity and invitation mail through the API-only key boundary and rejects replay or consumed actions', async () => {
    const { operations: env, actor, context } = await fixture();
    const apiEnv = { ...env };
    delete env.SESSION_KEY;
    delete env.IDENTITY_KEYS_JSON;
    const api = new Hono<AppEnv>();
    api.onError(errorResponse);
    api.use('*', requestContext);
    registerInternalMailRoutes(api);
    const prepared: { url: string; body: string; headers: Headers }[] = [];
    env.API = { fetch: async (request: Request) => {
      prepared.push({ url: request.url, body: await request.clone().text(), headers: new Headers(request.headers) });
      return api.fetch(request, apiEnv, context);
    } } as unknown as Fetcher;
    const delivered: { to: string; text: string }[] = [];
    env.EMAIL = { send: async (message) => { delivered.push({ to: message.to, text: message.text }); return { messageId: `mail-provider-${delivered.length}` }; } };
    const unsigned = await api.fetch(new Request(`https://internal.gitknot.com${IDENTITY_MAIL_PATH}`, { method: 'POST', body: '{}' }), apiEnv, context);
    expect(unsigned.status).toBe(401);
    await execute(env.DB, `UPDATE users SET email_verified_at=NULL WHERE id='u_owner'`);
    const action = await createIdentityAction(apiEnv, { purpose: 'verify_email', user_id: actor.id, email: 'owner@example.net', auth_revision: 1 });
    const event = makeEvent({ type: 'identity.verification_requested', resource_id: action.action.id, resource_revision: 1, account_id: actor.id, actor_id: actor.id });
    await env.DB.batch([action.statement, eventStatement(env.DB, event)]);
    await scheduleMail(env, event);
    const mail = (await one<{ id: string }>(env.DB, 'SELECT id FROM mail_deliveries WHERE event_id=?', event.id))!;
    await deliverMail(env, mail.id);
    expect(env.SESSION_KEY).toBeUndefined();
    expect(env.IDENTITY_KEYS_JSON).toBeUndefined();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ to: 'owner@example.net' });
    expect(delivered[0]!.text).toContain(action.token);
    expect(await one(env.DB, 'SELECT state FROM mail_deliveries WHERE id=?', mail.id)).toEqual({ state: 'accepted' });
    const replay = await api.fetch(new Request(prepared[0]!.url, { method: 'POST', headers: prepared[0]!.headers, body: prepared[0]!.body }), apiEnv, context);
    expect(replay.status).toBe(409);
    expect(await replay.text()).not.toContain(action.token);
    const obsolete = await createIdentityAction(apiEnv, { purpose: 'verify_email', user_id: actor.id, email: 'owner@example.net', auth_revision: 1 });
    const obsoleteEvent = makeEvent({ type: 'identity.verification_requested', resource_id: obsolete.action.id, resource_revision: 1, account_id: actor.id });
    await env.DB.batch([obsolete.statement, eventStatement(env.DB, obsoleteEvent)]);
    await scheduleMail(env, obsoleteEvent);
    await execute(env.DB, 'UPDATE identity_actions SET consumed_at=? WHERE id=?', now(), obsolete.action.id);
    const cancelled = (await one<{ id: string }>(env.DB, 'SELECT id FROM mail_deliveries WHERE event_id=?', obsoleteEvent.id))!;
    await deliverMail(env, cancelled.id);
    expect(delivered).toHaveLength(1);
    expect(await one(env.DB, 'SELECT state FROM mail_deliveries WHERE id=?', cancelled.id)).toEqual({ state: 'cancelled' });

    await execute(env.DB, `UPDATE users SET email_verified_at=? WHERE id='u_owner'`, now());
    const invitation = { id: 'invite_mail', key_id: identityKeys(apiEnv).current, purpose: 'invitation', expires_at: new Date(Date.now() + 600_000).toISOString() };
    const token = await actionToken(apiEnv, invitation);
    await execute(env.DB, `INSERT INTO invitations(id,account_id,email,role_id,token_hash,key_id,expires_at,seat_quote_json,created_by,created_at,updated_at,principal_json)
      VALUES(?,'u_owner','invitee@example.net','reader',?,?,?,'{}','u_owner',?,?,?)`, invitation.id, await sha256(token), invitation.key_id, invitation.expires_at, now(), now(), JSON.stringify(actor));
    const invitationEvent = makeEvent({ type: 'invitation.created', resource_id: invitation.id, resource_revision: 1, account_id: actor.id, actor_id: actor.id });
    await eventStatement(env.DB, invitationEvent).run();
    await scheduleMail(env, invitationEvent);
    const invitationMail = (await one<{ id: string }>(env.DB, 'SELECT id FROM mail_deliveries WHERE event_id=?', invitationEvent.id))!;
    await deliverMail(env, invitationMail.id);
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toMatchObject({ to: 'invitee@example.net' });
    expect(delivered[1]!.text).toContain(token);
    const persisted = JSON.stringify(await env.DB.prepare(`SELECT event_json AS value FROM outbox UNION ALL SELECT details_json AS value FROM audit_log`).all());
    expect(persisted).not.toContain(action.token);
    expect(persisted).not.toContain(token);
  });
});
