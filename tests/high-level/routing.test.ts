import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerIdentityRoutes } from '../../apps/api/src/modules/identity.ts';
import { registerAccountRoutes } from '../../apps/api/src/modules/accounts.ts';
import { registerRepositoryRoutes } from '../../apps/api/src/modules/repositories.ts';
import { registerOperationsRoutes } from '../../apps/api/src/modules/operations.ts';
import { registerWorkflowsRoutes } from '../../apps/api/src/modules/workflows.ts';
import { registerIntegrationsRoutes } from '../../apps/api/src/modules/integrations.ts';
import { registerStorageRoutes } from '../../apps/api/src/modules/storage.ts';
import { registerRunnersRoutes } from '../../apps/api/src/modules/runners.ts';
import {
  authenticate, authorize, base64url, browserBoundary, database, errorResponse, expectedRevision, getRepository, handleRoutingRpc, hashPassword,
  identityContext, inRepositoryMetadataFence, jsonBody, mutate, newId, now, one, prepareCredential, registerRepositoryPlacement,
  recoverAccountAuthorityBarriers, registerResourceLocator, requestContext, requestPolicies, route, routeResourceRequest, stmt, verifyInternalRequest,
  withAccountAuthorityBarrier,
} from '../../packages/core/src/index.ts';
import type { App, AppEnv, Bindings, Database, Repository } from '../../packages/core/src/index.ts';
import { createRun } from '../../packages/execution/src/control-plane.ts';
import { handleBillingAdmissionRequest } from '../../packages/billing/src/transport.ts';
import type { ExecutionPlan, RunRecord } from '../../packages/execution/src/types.ts';
import { runShardMove } from '../../packages/operations/src/movement.ts';
import { failOperation } from '../../packages/operations/src/lifecycle.ts';
import { submitShardMove } from '../../packages/operations/src/move-request.ts';
import { backgroundContext } from '../../packages/operations/src/authorization.ts';
import { acquireMetadataFence, releaseMetadataFence } from '../../packages/operations/src/metadata-fence.ts';
import type { Operation, OperationsBindings } from '../../packages/operations/src/types.ts';
import { createTestDatabase, projectRoot, type SqliteD1 } from '../support/database.ts';
import { createTestEnvironment, type TestEnvironment } from '../support/environment.ts';
import { TestBucket } from '../support/storage.ts';

const opened: { close(): void }[] = [];
const recoverablePassword = hashPassword('A real recoverable routing fixture passphrase.');
afterEach(() => { for (const item of opened.splice(0)) item.close(); });

function gate() {
  let enter!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  return { reached, release, pause: async () => { enter(); await held; } };
}

async function reached(pause: ReturnType<typeof gate>, response: Promise<Response>): Promise<void> {
  let waiting = true;
  try {
    await Promise.race([pause.reached, response.then(async result => {
      if (waiting) throw new Error(`Request completed before its intended boundary: ${result.status} ${await result.text()}`);
    })]);
  } finally { waiting = false; }
}

interface Faults {
  beforeAdmission?: () => Promise<void>;
  beforeWrite?: () => Promise<void>;
  beforeFence?: () => Promise<void>;
  loseReleaseAck?: (accountId: string) => Promise<boolean>;
  mutationBatches?: D1PreparedStatement[][];
}
function faultable(db: SqliteD1, faults: Faults): D1Database {
  function prepared(statement: D1PreparedStatement, sql: string, args: unknown[] = []): D1PreparedStatement {
    return new Proxy(statement, { get(target, key) {
      if (key === 'bind') return (...values: unknown[]) => prepared(target.bind(...values), sql, values);
      if (key === 'run') return async () => {
        if (sql.includes('INSERT INTO account_authority_fences')) {
          const pause = args[3] === 'fenced' ? faults.beforeFence : undefined;
          if (args[3] === 'fenced') faults.beforeFence = undefined;
          if (pause) await pause();
          const result = await target.run();
          if (args[3] === 'active' && await faults.loseReleaseAck?.(String(args[0]))) throw new Error('injected lost release acknowledgement');
          return result;
        }
        return target.run();
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
  const binding = new Proxy(db.binding(), { get(target, key) {
    if (key === 'withSession') return () => binding as unknown as D1DatabaseSession;
    if (key === 'prepare') return (sql: string) => prepared(target.prepare(sql), sql);
    if (key === 'batch') return async (statements: D1PreparedStatement[]) => {
      if (statements.some(statement => (statement as unknown as { sql: string }).sql.includes('/* routing-inflight */'))) {
        faults.mutationBatches?.push([...statements]);
        const pause = faults.beforeWrite;
        faults.beforeWrite = undefined;
        if (pause) await pause();
      }
      return db.batch(statements);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return binding;
}

interface Person { id: string; cookie: string; credential_id: string }
interface Harness extends TestEnvironment { app: App; destination: SqliteD1; faults: Faults; owner: Person; writer: Person; receiver: Person }

async function insertPerson(db: D1Database, id: string): Promise<Person> {
  const timestamp = now();
  const name = id.slice(2);
  await db.batch([
    stmt(db, 'INSERT INTO users(id,username,email,password_hash,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', id, name, `${name}@example.net`, await recoverablePassword, timestamp, timestamp, timestamp),
    stmt(db, "INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES (?,'user',?,?,?,?,?)", id, name, name, id, timestamp, timestamp),
    stmt(db, "INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES (?,'user',?,?,?,?,?,?)", id, id, id, name, id, timestamp, timestamp),
  ]);
  const credential = await prepareCredential(db, { principal_id: id, user_id: id, kind: 'session', name: 'Routing journey',
    capabilities: null, repository_ids: null, account_ids: null, auth_revision: 1, mfa: false,
    expires_at: new Date(Date.now() + 86400_000).toISOString(), created_by: id });
  await credential.statement.run();
  return { id, cookie: `gitknot_session=${credential.token}`, credential_id: credential.credential.id };
}

async function insertOrganization(db: Database, id: string): Promise<void> {
  await db.batch([
    stmt(db, "INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES (?,'organization',?,?,'u_owner',?,?)", id, id, id, now(), now()),
    stmt(db, "INSERT INTO memberships(account_id,principal_id,role_id,state,created_by,created_at,updated_at) VALUES (?,'u_owner','owner','active','u_owner',?,?)", id, now(), now()),
    stmt(db, "INSERT INTO memberships(account_id,principal_id,role_id,state,created_by,created_at,updated_at) VALUES (?,'u_writer','maintainer','active','u_owner',?,?)", id, now(), now()),
  ]);
}

async function insertRepository(db: Database, id = 'r_repo', ownerId = 'org_team', shard = 'core', forkSource: string | null = null): Promise<void> {
  await stmt(db, `INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,fork_source_id,created_by,created_at,updated_at)
    VALUES (?,?,?,?,'private','active','local',?,?,?,'u_owner',?,?)`, id, ownerId, id, id, shard, `storage_${id}`, forkSource, now(), now()).run();
}

async function identitySeed(source: Database, target: Database): Promise<void> {
  // The mover's existing FK seed is deliberately stale after the first change.
  for (const table of ['users', 'accounts', 'principals', 'memberships', 'credentials']) {
    const field = table === 'memberships' ? 'account_id' : table === 'credentials' ? 'principal_id' : 'id';
    const filter = ` WHERE ${field} IN ('u_owner','u_writer','u_receiver','org_team','org_source')`;
    const order = table === 'memberships' ? " ORDER BY (role_id='owner') DESC,account_id,principal_id" : '';
    const rows = (await source.prepare(`SELECT * FROM ${table}${filter}${order}`).all<Record<string, unknown>>()).results;
    for (const row of rows) {
      const fields = Object.keys(row);
      await stmt(target, `INSERT INTO ${table}(${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`, ...Object.values(row)).run();
    }
  }
  const accounts = (await source.prepare('SELECT id,policy_revision FROM accounts').all<{ id: string; policy_revision: number }>()).results;
  for (const account of accounts) await stmt(target, 'UPDATE accounts SET policy_revision=? WHERE id=?', account.policy_revision, account.id).run();
}

async function fixture(): Promise<Harness> {
  const test = await createTestEnvironment();
  opened.push(test);
  const destination = await createTestDatabase();
  opened.push(destination);
  const owner = await insertPerson(test.env.DB, 'u_owner');
  const writer = await insertPerson(test.env.DB, 'u_writer');
  const receiver = await insertPerson(test.env.DB, 'u_receiver');
  await insertOrganization(test.env.DB, 'org_team');
  await insertOrganization(test.env.DB, 'org_source');
  await insertRepository(test.env.DB);
  await insertRepository(test.env.DB, 'r_source', 'org_source');
  await stmt(test.env.DB, `INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,epoch,state,updated_at)
    VALUES ('r_repo','repository','local','core',1,'active',?),('r_source','repository','local','core',1,'active',?)`, now(), now()).run();
  await identitySeed(test.env.DB, destination.binding());
  // A source-row FK seed must not override r_source's actual primary placement.
  await insertRepository(destination.binding(), 'r_source', 'org_source');
  const faults: Faults = {};
  test.env.SECONDARY = faultable(destination, faults);
  test.env.SHARD_BINDINGS_JSON = JSON.stringify({ core: 'DB', secondary: 'SECONDARY' });
  test.env.IDENTITY_DB = test.env.DB;
  test.env.IDENTITY_CELL_ID = 'local';
  test.env.IDENTITY_SHARD_ID = 'core';
  test.env.IDENTITY_KEYS_JSON = JSON.stringify({ current: 'routing-test', keys: { 'routing-test': base64url(crypto.getRandomValues(new Uint8Array(32))) } });
  const held = new Map<string, string>();
  test.env.GIT_SERVICE = { fetch: async (request: Request) => {
    await verifyInternalRequest(request, test.env.INTERNAL_SERVICE_KEY, 'git-service');
    const path = new URL(request.url).pathname;
    if (path.endsWith('/barrier')) {
      const input = await request.json() as { token: string };
      if (request.method === 'DELETE') { held.delete(path); return Response.json({ held: false }); }
      if (held.has(path) && held.get(path) !== input.token) return Response.json({ error: { code: 'repository_busy' } }, { status: 409 });
      held.set(path, input.token);
      return Response.json({ held: true, token: input.token });
    }
    if (path.endsWith('/verify')) return Response.json({ verified: true, objects_verified: true, refs: [] });
    return Response.json({ error: { code: 'unconfigured_test_boundary' } }, { status: 503 });
  } } as unknown as Fetcher;
  const app = new Hono<AppEnv>();
  app.onError(errorResponse);
  app.use('*', requestContext);
  app.use('/v1/*', browserBoundary);
  app.use('/v1/*', async (c, next) => {
    const forwarded = await routeResourceRequest(c);
    if (forwarded) return forwarded;
    const before = faults.beforeAdmission;
    faults.beforeAdmission = undefined;
    if (before) await before();
    await next();
  });
  app.use('/v1/*', identityContext);
  app.all('/internal/routing', async c => (await handleRoutingRpc(c.req.raw, c.env))!);
  app.post('/internal/billing/admission', c => handleBillingAdmissionRequest(c.req.raw, c.env));
  registerIdentityRoutes(app);
  registerAccountRoutes(app);
  registerRepositoryRoutes(app);
  registerOperationsRoutes(app);
  registerWorkflowsRoutes(app);
  registerIntegrationsRoutes(app);
  registerStorageRoutes(app);
  registerRunnersRoutes(app);
  const probe = z.object({ description: z.string() }).strict();
  route(app, 'POST', '/v1/repos/:id/routing-probe', { summary: 'Exercise a frozen in-flight metadata transaction', capability: 'issues.write', body: probe }, async c => {
    const repo = await getRepository(c, c.req.param('id'), 'issues.write');
    const input = await jsonBody(c, probe);
    const revision = expectedRevision(c);
    await mutate(c, { sql: 'UPDATE repositories SET description=?,revision=revision+1 WHERE id=? AND revision=? /* routing-inflight */',
      bindings: [input.description, repo.id, revision], event: { type: 'routing.probe', resource_id: repo.id, resource_revision: revision + 1, repo_id: repo.id, account_id: repo.owner_id } });
    return c.json({ id: repo.id, revision: revision + 1 });
  });
  route(app, 'POST', '/v1/routing-test/credential-revoke', { summary: 'Exercise primary credential authority fencing', body: z.object({}).strict() }, async c => {
    await authorize(c, 'tokens.revoke', { account_id: 'u_writer' });
    await withAccountAuthorityBarrier(c, 'u_writer', 'credential.revoked', async () => {
      await stmt(test.env.DB, 'UPDATE credentials SET revoked_at=?,revision=revision+1 WHERE id=?', now(), writer.credential_id).run();
    });
    return c.body(null, 204);
  });
  return { ...test, app, destination, faults, owner, writer, receiver };
}

function request(f: Harness, path: string, options: { method?: string; body?: unknown; actor?: Person; token?: string; revision?: number; key?: string } = {}): Promise<Response> {
  return Promise.resolve(f.app.fetch(new Request(`${f.env.API_ORIGIN}${path}`, { method: options.method ?? 'GET', headers: {
    cookie: (options.actor ?? f.owner).cookie, origin: f.env.APP_ORIGIN, 'x-gitknot-csrf': '1',
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(options.revision === undefined ? {} : { 'if-match': `"${options.revision}"` }),
    ...(options.key ? { 'idempotency-key': options.key } : {}),
  }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }), f.env, f.context));
}

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(status);
  return value as T;
}

async function move(f: Harness): Promise<void> {
  const principal = (await authenticate(new Request(f.env.API_ORIGIN, { headers: { cookie: f.owner.cookie } }), f.env))!;
  const { id } = await json<{ id: string }>(await submitShardMove(f.env as OperationsBindings, {
    repo_id: 'r_repo', target_cell_id: 'local', target_shard_id: 'secondary', expected_epoch: 1, principal,
  }, false), 202);
  const operation = (await one<Operation>(f.env.DB, 'SELECT * FROM operations WHERE id=?', id))!;
  await runShardMove(f.env as OperationsBindings, operation);
  expect(await one(f.env.DB, "SELECT state,routing_epoch FROM repositories WHERE id='r_repo'"))
    .toEqual({ state: 'moving', routing_epoch: 1 });
  expect(await one(f.destination.binding(), "SELECT state,routing_epoch FROM repositories WHERE id='r_repo'"))
    .toEqual({ state: 'active', routing_epoch: 2 });
  expect(await one(f.env.DB, `SELECT repo_id FROM account_authority_repositories
    WHERE account_id='org_team' AND repo_id='r_repo' AND cell_id='local' AND shard_id='secondary' AND epoch=2`))
    .toEqual({ repo_id: 'r_repo' });
  expect(await one(f.destination.binding(), "SELECT phase FROM account_authority_fences WHERE account_id='org_team'"))
    .toEqual({ phase: 'active' });
}

async function run(f: Harness, db: Database, id: string, epoch: number): Promise<RunRecord> {
  const repo = (await one<Repository>(db, "SELECT * FROM repositories WHERE id='r_repo'"))!;
  if (!await one(db, "SELECT 1 FROM workflows WHERE id='wf_routing'")) await db.batch([
    stmt(db, `INSERT INTO workflows(id,repo_id,account_id,name,path,current_version_id,created_by,created_at,updated_at)
      VALUES ('wf_routing','r_repo','org_team','Routing','.gitknot/workflows/routing.yaml','wfv_routing','u_owner',?,?)`, now(), now()),
    stmt(db, `INSERT INTO workflow_versions(id,workflow_id,repo_id,account_id,source_commit,definition_digest,definition,definition_json,policy_revision,approved_by,created_at)
      VALUES ('wfv_routing','wf_routing','r_repo','org_team',?,?,'name: Routing','{}',1,'u_owner',?)`, 'a'.repeat(40), 'b'.repeat(64), now()),
  ]);
  const actor = (await authenticate(new Request(f.env.API_ORIGIN, { headers: { cookie: f.owner.cookie } }), f.env))!;
  const plan: ExecutionPlan = { version: 1, repo_id: repo.id, account_id: repo.owner_id, commit_sha: 'a'.repeat(40),
    source_ref: 'refs/heads/main', workflow_digest: 'b'.repeat(64), workflow_version_id: 'wfv_routing', policy_revision: repo.policy_revision,
    trust: 'trusted', trigger: { type: 'workflow.dispatch', id }, concurrency: { key: null, supersede: false }, actor, routing_epoch: epoch,
    portable_manifest: {}, jobs: [{ key: 'verify', needs: [], executor: { type: 'self_hosted', pool: 'pool_routing' },
      toolchain: { name: 'test', digest: 'c'.repeat(64), image: 'test@sha256:' + 'c'.repeat(64), os: 'linux', architecture: 'amd64' },
      producer_id: 'runner-pool:pool_routing', timeout_ms: 60_000, infrastructure_retries: 0, applicable: true, inapplicable_reason: null,
      steps: [], cache: null, outputs: {}, inputs: [], environment: null, egress: { hosts: [], max_requests: 0, max_bytes: 0, max_request_bytes: 0 } }] };
  const env = epoch === 1 ? f.env : { ...f.env, ROOT_DB: f.env.DB, ROOT_SHARD_ID: 'core', DB: f.env.SECONDARY as D1Database, SHARD_ID: 'secondary' };
  return createRun(env, db, { run_id: id, workflow_id: 'wf_routing', plan, actor_id: actor.id, request_key: id, request_hash: id });
}

describe('authoritative identity and global routing across real SQLite shards', () => {
  it('blocks prepared and newly authorized metadata writes behind a local snapshot fence without changing repository revisions', async () => {
    for (const boundary of ['prepared', 'before_admission'] as const) {
      const f = await fixture();
      await move(f);
      const db = f.env.SECONDARY as D1Database;
      const repo = (await one<Repository>(db, "SELECT * FROM repositories WHERE id='r_repo'"))!;
      const paused = gate();
      if (boundary === 'prepared') f.faults.beforeWrite = paused.pause;
      else f.faults.beforeAdmission = paused.pause;
      const write = request(f, '/v1/repos/r_repo/routing-probe', { method: 'POST', actor: f.owner,
        revision: repo.revision, body: { description: 'must not enter the snapshot' } });
      await reached(paused, write);
      const operationId = newId('op');
      const metadata = { ...f.env, DB: db, SHARD_ID: 'secondary' } as OperationsBindings;
      await stmt(db, `INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,created_at,updated_at)
        VALUES (?,'repository.backup',?,?,?,'u_owner',?,?)`, operationId, repo.id, repo.id, repo.owner_id, now(), now()).run();
      const fence = await acquireMetadataFence(metadata, repo.id, operationId, repo.routing_epoch);
      await stmt(f.env.DIRECTORY_DB!, "UPDATE resource_routes SET state='fenced',operation_id=? WHERE resource_id=?", fence.operation_id, repo.id).run();
      // Directory/native fencing did not alter the row compared by the old CAS.
      expect(await one(db, 'SELECT state,revision,policy_revision,routing_epoch FROM repositories WHERE id=?', repo.id))
        .toEqual({ state: repo.state, revision: repo.revision, policy_revision: repo.policy_revision, routing_epoch: repo.routing_epoch });
      paused.release();
      const blocked = await write;
      expect(blocked.status).toBe(423);
      expect(blocked.headers.get('retry-after')).toBe('1');
      expect(await one(db, 'SELECT description FROM repositories WHERE id=?', repo.id)).toEqual({ description: '' });
      expect(await one(db, "SELECT COUNT(*) AS count FROM outbox WHERE type='routing.probe'")).toEqual({ count: 0 });

      const principal = (await authenticate(new Request(f.env.API_ORIGIN, { headers: { cookie: f.owner.cookie } }), f.env))!;
      const context = backgroundContext(metadata, principal, repo);
      await requestPolicies(context, [{ capability: 'repositories.read', scope: { repo_id: repo.id } }]);
      const progress = (revision: number) => mutate(context, {
        sql: 'UPDATE operations SET progress=progress+1,revision=revision+1 WHERE id=? AND repo_id=? AND revision=?',
        bindings: [fence.operation_id, repo.id, revision], event: { type: 'operation.progress', resource_id: fence.operation_id,
          resource_revision: revision + 1, repo_id: repo.id, account_id: repo.owner_id },
      });
      await inRepositoryMetadataFence(context, fence, () => progress(1));
      await expect(inRepositoryMetadataFence(context, { ...fence, operation_id: newId('op') }, () => progress(2)))
        .rejects.toMatchObject({ status: 412 });
      await releaseMetadataFence(metadata, fence);
      await expect(inRepositoryMetadataFence(context, fence, () => progress(2))).rejects.toMatchObject({ status: 412 });
      await expect(acquireMetadataFence(metadata, repo.id, fence.operation_id, repo.routing_epoch))
        .rejects.toMatchObject({ code: 'metadata_fence_released' });
      expect(await one(db, 'SELECT progress,revision FROM operations WHERE id=?', fence.operation_id)).toEqual({ progress: 1, revision: 2 });
    }
  });

  it('defers one exact transaction until maintenance releases, preserving IDs and every original guard', async () => {
    for (const change of ['release', 'policy', 'public_revision', 'credential', 'generation', 'deadline'] as const) {
      const f = await fixture();
      f.faults.mutationBatches = [];
      f.env.DB = faultable(f.db, f.faults);
      await f.db.prepare('CREATE TABLE routing_wait_documents(id TEXT PRIMARY KEY,repo_id TEXT NOT NULL,title TEXT NOT NULL)').run();
      let plans = 0;
      let documentId = '';
      let eventId = '';
      route(f.app, 'POST', '/v1/repos/:id/maintenance-wait-proof', {
        summary: 'Preserve an already prepared write through transient maintenance', capability: 'issues.write',
        body: z.object({ title: z.string() }).strict(),
      }, async c => {
        const repo = await getRepository(c, c.req.param('id'), 'issues.write');
        plans++;
        documentId = newId('doc');
        eventId = newId('evt');
        await mutate(c, { sql: 'INSERT INTO routing_wait_documents(id,repo_id,title) VALUES (?,?,?) /* routing-inflight */',
          bindings: [documentId, repo.id, (c.get('input') as { title: string }).title],
          event: { id: eventId, type: 'routing.wait.saved', resource_id: documentId, resource_revision: 1, repo_id: repo.id, account_id: repo.owner_id } });
        return c.json({ id: documentId }, 201);
      });
      const paused = gate();
      f.faults.beforeWrite = paused.pause;
      const result = request(f, '/v1/repos/r_repo/maintenance-wait-proof', { method: 'POST', actor: f.writer,
        key: `wait-${change}`, body: { title: 'Validated once' } });
      await reached(paused, result);
      const captured = (await one<{ generation: number; attempt_id: string }>(f.env.DB,
        'SELECT generation,attempt_id FROM idempotency_keys WHERE key=?', `wait-${change}`))!;
      const fence = await acquireMetadataFence(f.env, 'r_repo', newId('op'), 1);
      const began = performance.now();
      const release = change === 'deadline' ? Promise.resolve() : (async () => {
        await new Promise<void>(resolve => setTimeout(resolve, change === 'release' ? 1300 : 80));
        if (change === 'policy') await stmt(f.env.DB, "UPDATE accounts SET policy_revision=policy_revision+1 WHERE id='org_team'").run();
        // Native public-ref publication advances this catalog revision. Private
        // retention work does not, which is why a temporary fence alone can wait.
        if (change === 'public_revision') await stmt(f.env.DB, "UPDATE repositories SET revision=revision+1 WHERE id='r_repo'").run();
        if (change === 'credential') await stmt(f.env.DB, 'UPDATE credentials SET revoked_at=?,revision=revision+1 WHERE id=?', now(), f.writer.credential_id).run();
        if (change === 'generation') await stmt(f.env.DB, 'UPDATE idempotency_keys SET generation=generation+1,attempt_id=? WHERE key=?', newId('attempt'), `wait-${change}`).run();
        await releaseMetadataFence(f.env, fence);
      })();
      paused.release();
      const response = await result;
      await release;
      expect(plans).toBe(1);
      const batches = f.faults.mutationBatches;
      expect(batches).toHaveLength(change === 'deadline' ? 1 : 2);
      if (batches.length === 2) {
        expect(batches[1]).toHaveLength(batches[0]!.length);
        for (let index = 0; index < batches[0]!.length; index++) expect(batches[1]![index]).toBe(batches[0]![index]);
      }
      const count = await one<{ count: number }>(f.env.DB, 'SELECT COUNT(*) AS count FROM routing_wait_documents');
      if (change === 'release') {
        expect(await json(response, 201)).toEqual({ id: documentId });
        expect(performance.now() - began).toBeGreaterThanOrEqual(1200);
        expect(count).toEqual({ count: 1 });
        expect(await one(f.env.DB, "SELECT id,resource_id FROM outbox WHERE type='routing.wait.saved'"))
          .toEqual({ id: eventId, resource_id: documentId });
        expect(await one(f.env.DB, "SELECT COUNT(*) AS count FROM audit_log WHERE action='routing.wait.saved'")).toEqual({ count: 1 });
        expect(await one(f.env.DB, 'SELECT generation,attempt_id FROM idempotency_keys WHERE key=?', `wait-${change}`)).toEqual(captured);
      } else {
        expect(response.status).toBe(change === 'deadline' ? 423 : change === 'generation' ? 409 : 412);
        expect(count).toEqual({ count: 0 });
        expect(await one(f.env.DB, "SELECT COUNT(*) AS count FROM outbox WHERE type='routing.wait.saved'")).toEqual({ count: 0 });
        expect(await one(f.env.DB, "SELECT COUNT(*) AS count FROM audit_log WHERE action='routing.wait.saved'")).toEqual({ count: 0 });
        if (change === 'deadline') {
          expect(response.headers.get('retry-after')).toBe('1');
          expect(await response.json()).toMatchObject({ error: { code: 'repository_metadata_busy' } });
          expect(performance.now() - began).toBeLessThan(4000);
          await releaseMetadataFence(f.env, fence);
        }
      }
    }
  }, 30_000);

  it('uses current primary grants and owner data after runShardMove, retaining a valid unrelated session', async () => {
    const f = await fixture();
    await move(f);
    const before = await json<{ revision: number }>(await request(f, '/v1/repos/r_repo', { actor: f.writer }), 200);
    await json(await request(f, '/v1/repos/r_repo', { method: 'PATCH', actor: f.writer, revision: before.revision, body: { description: 'destination edit' } }), 200);
    expect(await one(f.env.DB, "SELECT description FROM repositories WHERE id='r_repo'" )).toEqual({ description: '' });
    await stmt(f.env.DB, "UPDATE accounts SET name='Current primary owner name' WHERE id='org_team'").run();
    expect(await json(await request(f, '/v1/repos/r_repo'), 200)).toMatchObject({ owner: { name: 'Current primary owner name' } });
    const removed = await request(f, '/v1/orgs/org_team/members/u_writer', { method: 'DELETE', revision: 1 });
    expect(removed.status, await removed.text()).toBe(204);
    expect(await authenticate(new Request(f.env.API_ORIGIN, { headers: { cookie: f.writer.cookie } }), f.env)).toMatchObject({ id: f.writer.id });
    expect(await one(f.destination.binding(), "SELECT state FROM memberships WHERE account_id='org_team' AND principal_id='u_writer'" )).toEqual({ state: 'active' });
    expect((await request(f, '/v1/repos/r_repo', { actor: f.writer })).status).toBe(404);
    expect((await request(f, '/v1/repos/r_repo', { method: 'PATCH', actor: f.writer, revision: before.revision + 1, body: { description: 'revoked edit' } })).status).toBe(404);
    expect(await one(f.destination.binding(), "SELECT description FROM repositories WHERE id='r_repo'" )).toEqual({ description: 'destination edit' });
  });

  it('waits for placement fence acknowledgement and aborts an already-authorized cross-D1 writer', async () => {
    const f = await fixture();
    await move(f);
    const repo = await json<{ revision: number }>(await request(f, '/v1/repos/r_repo'), 200);
    const writer = gate();
    f.faults.beforeWrite = writer.pause;
    const inFlight = request(f, '/v1/repos/r_repo/routing-probe', { method: 'POST', actor: f.writer, revision: repo.revision,
      body: { description: 'must roll back' }, key: 'inflight-before-revocation' });
    await reached(writer, inFlight);
    const ack = gate();
    f.faults.beforeFence = ack.pause;
    let acknowledged = false;
    const revocation = request(f, '/v1/orgs/org_team/members/u_writer', { method: 'DELETE', revision: 1 }).then(response => { acknowledged = true; return response; });
    await reached(ack, revocation);
    expect(acknowledged).toBe(false);
    expect(await one(f.env.DB, "SELECT state FROM memberships WHERE account_id='org_team' AND principal_id='u_writer'" )).toEqual({ state: 'active' });
    ack.release();
    const revoked = await revocation;
    expect(revoked.status, await revoked.text()).toBe(204);
    writer.release();
    expect((await inFlight).status).toBe(412);
    expect(await one(f.destination.binding(), "SELECT description FROM repositories WHERE id='r_repo'" )).toEqual({ description: '' });
    expect(await one(f.destination.binding(), "SELECT COUNT(*) AS count FROM outbox WHERE type='routing.probe'" )).toEqual({ count: 0 });
    expect(await one(f.destination.binding(), "SELECT committed_at FROM idempotency_keys WHERE key='inflight-before-revocation'" )).toEqual({ committed_at: null });
    expect(await one(f.env.DB, "SELECT 1 FROM account_policy_barriers WHERE account_id='org_team'" )).toBeNull();
  });

  it('locates old and newly created operations/runs/webhooks and only cancels the current placement', async () => {
    const f = await fixture();
    const pendingIntent = gate();
    let starts = 0;
    const reconciled: string[] = [];
    route(f.app, 'POST', '/v1/repos/:id/pending-routing-operation', { summary: 'Preserve an admitted external identity through cutover',
      body: z.object({}).strict(), idempotency: { strategy: 'external',
        authorization: c => [{ capability: 'repositories.export', scope: { repo_id: c.req.param('id') } }],
        recover: async (_c, record) => { reconciled.push(record.operation_id!); return null; },
      },
    }, async c => {
      starts++;
      await pendingIntent.pause();
      const id = c.get('idempotency')!.operation_id!;
      await mutate(c, { sql: `INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,created_at,updated_at)
        VALUES (?,'repository.backup','r_repo','r_repo','org_team','u_owner',?,?)`, bindings: [id, now(), now()],
        event: { type: 'operation.requested', resource_id: id, resource_revision: 1, repo_id: 'r_repo', account_id: 'org_team' } });
      return c.json({ id }, 202);
    });
    const old = await json<{ id: string }>(await request(f, '/v1/repos/r_repo/backups', { method: 'POST', body: {} }), 202);
    await run(f, f.env.DB, 'run_before_move', 1);
    await f.env.DB.batch([
      stmt(f.env.DB, "UPDATE workflow_jobs SET status='succeeded',completed_at=? WHERE run_id='run_before_move'", now()),
      stmt(f.env.DB, "UPDATE workflow_runs SET status='succeeded',completed_at=? WHERE id='run_before_move'", now()),
    ]);
    const actor = (await authenticate(new Request(f.env.API_ORIGIN, { headers: { cookie: f.owner.cookie } }), f.env))!;
    await stmt(f.env.DB, `INSERT INTO webhooks(id,repo_id,account_id,principal_id,principal_json,url,events_json,created_at,updated_at)
      VALUES ('wh_before_move','r_repo','org_team','u_owner',?,'https://hooks.example.net/events','["issue.*"]',?,?)`, JSON.stringify(actor), now(), now()).run();
    const pendingPath = '/v1/repos/r_repo/pending-routing-operation';
    const pendingRequest = request(f, pendingPath, { method: 'POST', body: {}, key: 'pending-at-cutover' });
    await reached(pendingIntent, pendingRequest);
    const admitted = (await one<{ operation_id: string; repo_id: string; policy_json: string }>(f.env.DB,
      "SELECT operation_id,repo_id,policy_json FROM idempotency_keys WHERE key='pending-at-cutover'"))!;
    expect(admitted.repo_id).toBe('r_repo');
    await move(f);
    expect(await one(f.env.DB, "SELECT repo_id,authority FROM resource_locators WHERE resource_id='wh_before_move'"))
      .toEqual({ repo_id: 'r_repo', authority: 'repository' });
    expect(await one(f.destination.binding(), "SELECT operation_id,repo_id,policy_json FROM idempotency_keys WHERE key='pending-at-cutover'" )).toEqual(admitted);
    expect((await request(f, pendingPath, { method: 'POST', body: {}, key: 'pending-at-cutover' })).status).toBe(409);
    expect(reconciled).toEqual([admitted.operation_id]);
    expect(starts).toBe(1);
    pendingIntent.release();
    expect((await pendingRequest).status).toBe(412);
    expect(await json(await request(f, '/v1/runs/run_before_move'), 200)).toMatchObject({ id: 'run_before_move', status: 'succeeded' });
    expect(await json(await request(f, '/v1/webhooks/wh_before_move'), 200)).toMatchObject({ id: 'wh_before_move' });
    await json(await request(f, `/v1/operations/${old.id}/cancel`, { method: 'POST', body: {}, revision: 1 }), 200);
    expect(await one(f.env.DB, 'SELECT status FROM operations WHERE id=?', old.id)).toEqual({ status: 'pending' });
    expect(await one(f.destination.binding(), 'SELECT status FROM operations WHERE id=?', old.id)).toEqual({ status: 'cancelled' });
    const created = await request(f, '/v1/repos/r_repo/backups', { method: 'POST', body: {}, key: 'backup-after-move' });
    const next = await json<{ id: string }>(created, 202);
    expect(await one(f.env.DB, 'SELECT id FROM operations WHERE id=?', next.id)).toBeNull();
    expect(await json(await request(f, created.headers.get('location')!), 200)).toMatchObject({ id: next.id, status: 'pending' });
    expect(await json(await request(f, '/v1/repos/r_repo/backups', { method: 'POST', body: {}, key: 'backup-after-move' }), 202)).toMatchObject({ id: next.id });
    await run(f, f.destination.binding(), 'run_after_move', 2);
    expect(await json(await request(f, '/v1/runs/run_after_move'), 200)).toMatchObject({ id: 'run_after_move', status: 'queued' });
    const cancellation = await json<{ operation_id: string }>(await request(f, '/v1/runs/run_after_move/cancel', {
      method: 'POST', body: {}, revision: 1, key: 'cancel-run-after-move' }), 202);
    expect(await json(await request(f, `/v1/workflow-operations/${cancellation.operation_id}`), 200)).toMatchObject({ kind: 'cancel' });
    expect(await one(f.destination.binding(), "SELECT status FROM workflow_runs WHERE id='run_after_move'" )).toEqual({ status: 'cancelling' });
    expect(await one(f.env.DB, "SELECT id FROM workflow_runs WHERE id='run_after_move'" )).toBeNull();
    await expect(registerResourceLocator(f.env, { resource_id: next.id, resource_type: 'operation', repo_id: 'r_source' })).rejects.toMatchObject({ code: 'resource_locator_conflict' });
  });

  it('retains an uncertain release fence and recovers it without reviving an old writer', async () => {
    const f = await fixture();
    await move(f);
    const repo = await json<{ revision: number }>(await request(f, '/v1/repos/r_repo'), 200);
    const paused = gate();
    f.faults.beforeWrite = paused.pause;
    const write = request(f, '/v1/repos/r_repo/routing-probe', { method: 'POST', actor: f.writer, revision: repo.revision, body: { description: 'revived authority' } });
    await reached(paused, write);
    f.faults.loseReleaseAck = async accountId => accountId === 'org_team'
      && !await one(f.env.DB, "SELECT 1 FROM memberships WHERE account_id='org_team' AND principal_id='u_writer'");
    const revocation = await request(f, '/v1/orgs/org_team/members/u_writer', { method: 'DELETE', revision: 1, key: 'uncertain-authority-release' });
    expect(revocation.status, await revocation.text()).toBe(503);
    expect(await one(f.env.DB, "SELECT phase FROM account_authority_epochs WHERE account_id='org_team'" )).toEqual({ phase: 'releasing' });
    expect(await one(f.env.DB, "SELECT 1 FROM memberships WHERE account_id='org_team' AND principal_id='u_writer'" )).toBeNull();
    expect(await one(f.env.DB, "SELECT committed_at IS NOT NULL AS committed FROM idempotency_keys WHERE key='uncertain-authority-release'" )).toEqual({ committed: 1 });
    paused.release();
    expect((await write).status).toBe(412);
    f.faults.loseReleaseAck = undefined;
    await stmt(f.env.DB, "UPDATE account_policy_barriers SET recover_after='2000-01-01T00:00:00.000Z' WHERE account_id='org_team'").run();
    expect(await recoverAccountAuthorityBarriers(f.env)).toBe(1);
    expect(await one(f.env.DB, "SELECT phase FROM account_authority_epochs WHERE account_id='org_team'" )).toEqual({ phase: 'active' });
    expect(await one(f.env.DB, "SELECT 1 FROM account_policy_barriers WHERE account_id='org_team'" )).toBeNull();
    expect((await request(f, '/v1/repos/r_repo', { actor: f.writer })).status).toBe(404);
    expect(await one(f.destination.binding(), "SELECT description FROM repositories WHERE id='r_repo'" )).toEqual({ description: '' });
  });

  it('keeps repository-scoped runner pools and enrollments on their declared identity authority', async () => {
    const f = await fixture();
    await move(f);
    const pool = await json<{ id: string }>(await request(f, '/v1/runner-pools', { method: 'POST', key: 'primary-pool', body: {
      account_id: 'org_team', repo_id: 'r_repo', name: 'routing-pool', os: 'linux', architecture: 'amd64',
      toolchains: ['sha256:' + 'c'.repeat(64)], trust: 'trusted', isolation: 'ephemeral',
    } }), 201);
    expect(await one(f.env.DB, 'SELECT id FROM runner_pools WHERE id=?', pool.id)).toEqual({ id: pool.id });
    expect(await one(f.destination.binding(), 'SELECT id FROM runner_pools WHERE id=?', pool.id)).toBeNull();
    expect(await one(f.env.DB, 'SELECT authority,repo_id FROM resource_locators WHERE resource_id=?', pool.id))
      .toEqual({ authority: 'identity', repo_id: 'r_repo' });
    expect(await json(await request(f, `/v1/runner-pools/${pool.id}`), 200)).toMatchObject({ id: pool.id });
    const enrollment = await json<{ id: string }>(await request(f, '/v1/runner-enrollments', {
      method: 'POST', key: 'primary-enrollment', body: { pool_id: pool.id },
    }), 201);
    expect(await json(await request(f, `/v1/runner-enrollments/${enrollment.id}`), 200)).toMatchObject({ id: enrollment.id });
    expect(await json(await request(f, `/v1/runner-enrollments?pool_id=${pool.id}`), 200)).toMatchObject({ items: [{ id: enrollment.id }] });
    expect(await one(f.destination.binding(), 'SELECT id FROM runner_enrollments WHERE id=?', enrollment.id)).toBeNull();
    expect(await one(f.env.DB, "SELECT COUNT(*) AS count FROM idempotency_keys WHERE key IN ('primary-pool','primary-enrollment')" )).toEqual({ count: 2 });
    expect(await one(f.destination.binding(), "SELECT COUNT(*) AS count FROM idempotency_keys WHERE key IN ('primary-pool','primary-enrollment')" )).toEqual({ count: 0 });
  });

  it('retains private-fork source audience fences without requiring source scope on a fork-only token', async () => {
    const f = await fixture();
    await move(f);
    await insertRepository(f.destination.binding(), 'r_fork', 'org_team', 'secondary', 'r_source');
    await stmt(f.env.DB, `INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,epoch,state,updated_at)
      VALUES ('r_fork','repository','local','secondary',1,'active',?)`, now()).run();
    await registerRepositoryPlacement(f.env, { repo_id: 'r_fork', account_id: 'org_team', cell_id: 'local', shard_id: 'secondary', epoch: 1 });
    const credential = await prepareCredential(f.env.DB, { principal_id: f.writer.id, user_id: f.writer.id, kind: 'personal', name: 'Fork-only audience',
      capabilities: ['repositories.read', 'contents.read', 'issues.write'], repository_ids: ['r_fork'], account_ids: null, auth_revision: 1, mfa: false,
      expires_at: new Date(Date.now() + 86400_000).toISOString(), created_by: f.writer.id });
    await credential.statement.run();
    expect((await request(f, '/v1/repos/r_fork', { token: credential.token })).status).toBe(200);
    const paused = gate();
    f.faults.beforeWrite = paused.pause;
    const inFlight = request(f, '/v1/repos/r_fork/routing-probe', { method: 'POST', token: credential.token, revision: 1, body: { description: 'private source dependency' } });
    await reached(paused, inFlight);
    const removed = await request(f, '/v1/orgs/org_source/members/u_writer', { method: 'DELETE', revision: 1 });
    expect(removed.status, await removed.text()).toBe(204);
    paused.release();
    expect((await inFlight).status).toBe(412);
    expect((await request(f, '/v1/repos/r_fork', { token: credential.token })).status).toBe(404);
    expect((await request(f, '/v1/repos/r_fork/routing-probe', { method: 'POST', token: credential.token, revision: 1, body: { description: 'revoked audience' } })).status).toBe(404);
    expect(await one(f.destination.binding(), "SELECT description FROM repositories WHERE id='r_fork'" )).toEqual({ description: '' });
    expect(await one(f.destination.binding(), "SELECT state FROM memberships WHERE account_id='org_source' AND principal_id='u_writer'" )).toEqual({ state: 'active' });
  });

  it('fences current credentials independently of copied credentials at metadata commit', async () => {
    const f = await fixture();
    await move(f);
    const repo = await json<{ revision: number }>(await request(f, '/v1/repos/r_repo'), 200);
    const paused = gate();
    f.faults.beforeWrite = paused.pause;
    const write = request(f, '/v1/repos/r_repo/routing-probe', { method: 'POST', actor: f.writer, revision: repo.revision, body: { description: 'old credential' } });
    await reached(paused, write);
    const revoked = await request(f, '/v1/routing-test/credential-revoke', { method: 'POST', actor: f.writer, body: {} });
    expect(revoked.status, await revoked.text()).toBe(204);
    paused.release();
    expect((await write).status).toBe(412);
    expect(await one(f.destination.binding(), 'SELECT revoked_at FROM credentials WHERE id=?', f.writer.credential_id)).toEqual({ revoked_at: null });
    expect(await authenticate(new Request(f.env.API_ORIGIN, { headers: { cookie: f.writer.cookie } }), f.env)).toBeNull();
  });

  it('routes authorized restore and receiving-owner acceptance through directory lifecycle fences', async () => {
    const f = await fixture();
    await move(f);
    const repo = await json<{ revision: number }>(await request(f, '/v1/repos/r_repo'), 200);
    const deleted = await json<{ revision: number; operation: { id: string } }>(await request(f, '/v1/repos/r_repo', { method: 'DELETE', revision: repo.revision }), 202);
    await stmt(f.env.DB, "UPDATE resource_routes SET state='deleted' WHERE resource_id='r_repo'").run();
    expect((await request(f, '/v1/repos/r_repo', { method: 'PATCH', body: { description: 'deleted write' }, revision: deleted.revision })).status).toBe(404);
    expect((await request(f, '/v1/repos/r_repo/restore', { method: 'POST', actor: f.writer, body: {}, revision: deleted.revision })).status).toBe(404);
    // The existing exclusive lifecycle gate still applies. An interrupted
    // deletion remains recoverable after its real failure transition is recorded.
    expect((await request(f, '/v1/repos/r_repo/restore', { method: 'POST', body: {}, revision: deleted.revision })).status).toBe(409);
    await failOperation({ ...f.env, DB: f.destination.binding(), SHARD_ID: 'secondary' } as OperationsBindings,
      deleted.operation.id, new Error('injected deletion service interruption'));
    expect(await json(await request(f, '/v1/repos/r_repo/restore', { method: 'POST', body: {}, revision: deleted.revision }), 202))
      .toMatchObject({ id: 'r_repo', state: 'deleted', revision: deleted.revision + 1 });

    const transfer = await fixture();
    await move(transfer);
    const current = await json<{ revision: number }>(await request(transfer, '/v1/repos/r_repo'), 200);
    const pending = await json<{ id: string; revision: number }>(await request(transfer, '/v1/repos/r_repo/transfers', {
      method: 'POST', body: { destination_owner_id: transfer.receiver.id }, revision: current.revision }), 202);
    await stmt(transfer.env.DB, "UPDATE resource_routes SET state='fenced' WHERE resource_id='r_repo'").run();
    expect((await request(transfer, '/v1/repos/r_repo', { method: 'PATCH', body: { description: 'fenced write' }, revision: current.revision + 1 })).status).toBe(423);
    expect(await json(await request(transfer, `/v1/repos/r_repo/transfers/${pending.id}/accept`, {
      method: 'POST', actor: transfer.receiver, body: {}, revision: pending.revision }), 202)).toMatchObject({ state: 'accepted' });
  });

  it('streams a reserved 6 MiB upload across cells without eager buffering and retains real body validation', async () => {
    const f = await fixture();
    const blobs = new TestBucket();
    const peer: Bindings = { ...f.env, DB: f.destination.binding(), IDENTITY_DB: f.env.DB, CELL_ID: 'peer', SHARD_ID: 'core',
      SHARD_BINDINGS_JSON: '{}', CELL_BINDINGS_JSON: JSON.stringify({ local: 'ORIGIN_API' }), BLOBS: blobs.binding() };
    peer.ORIGIN_API = { fetch: (input: Request) => f.app.fetch(input, f.env, f.context) } as unknown as Fetcher;
    let tamper = false;
    f.env.PEER_API = { fetch: (input: Request) => {
      const path = new URL(input.url).pathname;
      if (path.startsWith('/v1/') || path.startsWith('/internal/hosted/')) {
        expect(input.headers.has('x-gitknot-routing-signature')).toBe(true);
        expect(input.headers.has('x-gitknot-internal-scope')).toBe(false);
        if (tamper) input.headers.set('cookie', f.receiver.cookie);
      } else expect(input.headers.get('x-gitknot-internal-scope')).toBe('cell.authority');
      return f.app.fetch(input, peer, f.context);
    } } as unknown as Fetcher;
    f.env.CELL_BINDINGS_JSON = JSON.stringify({ peer: 'PEER_API' });
    await insertRepository(f.destination.binding());
    await stmt(f.destination.binding(), "UPDATE repositories SET cell_id='peer',routing_epoch=2 WHERE id='r_repo'").run();
    await stmt(f.env.DB, "UPDATE repositories SET state='moving' WHERE id='r_repo'").run();
    await stmt(f.env.DB, "UPDATE resource_routes SET cell_id='peer',epoch=2 WHERE resource_id='r_repo'").run();
    await registerRepositoryPlacement(f.env, { repo_id: 'r_repo', account_id: 'org_team', cell_id: 'peer', shard_id: 'core', epoch: 2 });
    const block = new Uint8Array(64 * 1024).fill(42);
    const chunks = 96;
    const size = block.byteLength * chunks;
    const hasher = createHash('sha256');
    for (let index = 0; index < chunks; index++) hasher.update(block);
    const digest = hasher.digest('hex');
    const key = 'org_team/r_repo/uploads/obj_stream';
    const expiry = new Date(Date.now() + 60_000).toISOString();
    await registerResourceLocator(f.env, { resource_id: 'obj_stream', resource_type: 'object', repo_id: 'r_repo' });
    for (const db of [f.env.DB, f.destination.binding()]) await stmt(db, `INSERT INTO object_manifests
      (id,repo_id,account_id,kind,object_key,filename,bytes,sha256,state,created_by,retention_until,billing_reservation_id,billing_fence,created_at,updated_at)
      VALUES ('obj_stream','r_repo','org_team','attachment',?,'stream.bin',?,?,'pending','u_owner',?,'bres_stream','bf_stream',?,?)`,
    key, size, digest, expiry, now(), now()).run();
    await stmt(f.destination.binding(), 'INSERT INTO storage_quotas(scope_id,limit_bytes,reserved_bytes,updated_at) VALUES (?,?,?,?)',
      'r_repo', size * 2, size, now()).run();
    let settled = 0;
    // The financial service is an explicit boundary double; the real upload
    // handler, D1 admission/CAS, byte counter and R2 checksum validation all run.
    const financial = { fetch: async (input: Request) => {
      await verifyInternalRequest(input, f.env.INTERNAL_SERVICE_KEY, 'billing:account:storage-commit');
      const body = await input.json() as { object_id: string; bytes: string; checksum: string; etag: string };
      expect(body).toMatchObject({ object_id: 'obj_stream', bytes: String(size), checksum: digest });
      expect((await blobs.head(key))?.etag).toBe(body.etag);
      settled++;
      return Response.json({ id: body.object_id, account_id: 'org_team', key, bucket: 'blobs', source: 'standalone',
        attribution: { repo_id: 'r_repo' }, state: 'stored', maximum_bytes: String(size), bytes: String(size), reservation_id: 'bres_stream', fence: 'bf_stream' });
    } } as unknown as Fetcher;
    peer.ADMISSION = { idFromName: (name: string) => ({ toString: () => name }), get: () => financial } as unknown as DurableObjectNamespace;
    f.env.ADMISSION = peer.ADMISSION;
    const slowSink = gate();
    const put = blobs.put.bind(blobs);
    blobs.put = async (name, value, options) => { await slowSink.pause(); return put(name, value, options); };
    let produced = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (produced === chunks) { controller.close(); return; }
      produced++;
      controller.enqueue(new Uint8Array(block));
    } }, { highWaterMark: 0 });
    const init = { method: 'PUT', body, duplex: 'half', headers: { cookie: f.owner.cookie, origin: f.env.APP_ORIGIN,
      'x-gitknot-csrf': '1', 'if-match': '"1"', 'content-type': 'application/octet-stream', 'x-actor': f.receiver.id } };
    const uploaded = Promise.resolve(f.app.fetch(new Request(`${f.env.API_ORIGIN}/v1/uploads/obj_stream`, init), f.env, f.context));
    await reached(slowSink, uploaded);
    expect(produced).toBeLessThanOrEqual(8); // bounded pipe queues, not a body-sized tee
    expect(settled).toBe(0);
    slowSink.release();
    expect(await json(await uploaded, 201)).toMatchObject({ id: 'obj_stream', state: 'ready', bytes: size, sha256: digest });
    expect(settled).toBe(1);
    expect(await one(f.env.DB, "SELECT state FROM object_manifests WHERE id='obj_stream'" )).toEqual({ state: 'pending' });
    expect(await one(f.destination.binding(), "SELECT actor_id FROM outbox WHERE type='object.created' AND resource_id='obj_stream'" )).toEqual({ actor_id: f.owner.id });
    tamper = true;
    expect((await request(f, '/v1/objects/obj_stream')).status).toBe(401);
    tamper = false;
    await registerResourceLocator(f.env, { resource_id: 'att_cleanup', resource_type: 'attempt', repo_id: 'r_repo' });
    const caller = await prepareCredential(f.env.DB, { principal_id: f.owner.id, user_id: f.owner.id, kind: 'personal', name: 'Cleanup admission',
      capabilities: ['*'], repository_ids: null, account_ids: null, auth_revision: 1, mfa: false,
      expires_at: new Date(Date.now() + 86400_000).toISOString(), created_by: f.owner.id });
    await caller.statement.run();
    await stmt(f.env.DB, `INSERT INTO account_policy_barriers(account_id,id,reason,previous_policy_revision,recover_after,created_at)
      VALUES ('u_owner','policy_barrier_cleanup','credential.revoked',1,?,?)`, expiry, now()).run();
    await stmt(f.destination.binding(), "UPDATE repositories SET state='moving' WHERE id='r_repo'").run();
    let cleanupGates = 0;
    peer.EXECUTOR = { fetch: async (input: Request) => {
      if (new URL(input.url).pathname.startsWith('/internal/hosted/')) {
        expect(input.headers.get('x-gitknot-callback-signature')).toBe('independent-attempt-signature');
      } else await verifyInternalRequest(input, f.env.INTERNAL_SERVICE_KEY, 'execution');
      cleanupGates++;
      // Routing must reach this independent proof gate, never authorize cleanup
      // itself from an ordinary principal or an untrusted callback header.
      return Response.json({ error: { code: 'attempt_cleanup_proof_required' } }, { status: 401 });
    } } as unknown as Fetcher;
    const termination = { runner_id: 'runner_test', generation: 1, lease_token: 'l'.repeat(43), termination_digest: 'sha256:' + 'd'.repeat(64),
      termination: { version: 1, attempt_id: 'att_cleanup', runner_id: 'runner_test', generation: 1,
        manifest_digest: 'sha256:' + 'c'.repeat(64), commit: 'a'.repeat(40), finished_at: now(), cleanup_confirmed: true } };
    for (const state of ['fenced', 'deleted'] as const) {
      await stmt(f.env.DB, 'UPDATE resource_routes SET state=? WHERE resource_id=?', state, 'r_repo').run();
      const callback = (action: string) => Promise.resolve(f.app.fetch(new Request(`${f.env.API_ORIGIN}/internal/hosted/attempts/att_cleanup/${action}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-gitknot-callback-signature': 'independent-attempt-signature' }, body: '{}',
      }), f.env, f.context));
      expect(await json(await callback('destroyed'), 401)).toMatchObject({ error: { code: 'attempt_cleanup_proof_required' } });
      expect((await callback('complete')).status).toBe(state === 'deleted' ? 404 : 423);
      expect(await json(await request(f, '/v1/attempts/att_cleanup/terminated', { method: 'POST', body: termination, token: caller.token }), 401))
        .toMatchObject({ error: { code: 'attempt_cleanup_proof_required' } });
    }
    expect(cleanupGates).toBe(4);
  });
});

describe('configured D1 alias authority in actual Cloudflare workerd', () => {
  it('uses the atomic colocated path while retaining distinct repository and identity request ownership', async () => {
    const [{ build }, { Miniflare, convertV4MiniflareOptions }] = await Promise.all([import('esbuild'), import('miniflare')]);
    const script = await build({ absWorkingDir: projectRoot, bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2023',
      banner: { js: "import {createRequire as __createRequire} from 'node:module'; const require=__createRequire('/routing-alias-worker.js');" },
      stdin: { resolveDir: projectRoot, contents: `
        import {Hono} from 'hono';
        import {z} from 'zod';
        import {authorize,database,errorResponse,identityContext,mutate,newId,one,requestContext,
          requestDatabaseAuthority,route,routeResourceRequest,selectedRepositoryScope,separateIdentityAuthority}
          from './packages/core/src/index.ts';
        const app=new Hono();
        app.onError(errorResponse);
        app.use('*',requestContext);
        app.use('/v1/*',async(c,next)=>{const forwarded=await routeResourceRequest(c);if(forwarded)return forwarded;await next();});
        app.use('/v1/*',identityContext);
        async function write(c) {
          const input=c.get('input');
          const repoId=c.req.param('id')??input.repo_id;
          const admitted=await one(database(c),'SELECT repo_id FROM idempotency_keys WHERE principal_id=? AND key=?',
            c.get('principal').id,c.req.header('idempotency-key'));
          const ownership=requestDatabaseAuthority(c);
          const scope=selectedRepositoryScope(c);
          const colocated=!separateIdentityAuthority(c);
          const id=newId('alias');
          await mutate(c,{sql:'INSERT INTO alias_notes(id,repo_id,title) VALUES (?,?,?)',bindings:[id,repoId,input.title],
            event:{type:'alias.note.created',resource_id:id,resource_revision:1,repo_id:repoId,account_id:'u_alias'}});
          return c.json({id,colocated,kind:ownership.kind,scope,initial_repo_id:admitted?.repo_id??null},201);
        }
        route(app,'POST','/v1/repos/:id/alias-notes',{summary:'Repository-owned alias mutation',
          capability:'issues.write',body:z.object({title:z.string()}).strict()},write);
        route(app,'POST','/v1/alias-account-notes',{summary:'Identity-owned resource with repository permission scope',
          capability:'issues.write',body:z.object({title:z.string(),repo_id:z.string()}).strict()},write);
        route(app,'GET','/v1/alias-notes/:id',{summary:'Read current alias note'},async c=>{
          const row=await one(database(c),'SELECT * FROM alias_notes WHERE id=?',c.req.param('id'));
          if(!row)return c.json({},404);
          await authorize(c,'issues.read',{repo_id:row.repo_id});return c.json(row);
        });
        export default {fetch:(request,env,context)=>app.fetch(request,env,context)};
      ` } });
    const runtime = new Miniflare(convertV4MiniflareOptions({ cf: false, workers: [{ name: 'api', modules: true,
      script: script.outputFiles[0]!.text, compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: 'routing-aliased-primary', IDENTITY_DB: 'routing-aliased-primary', DIRECTORY_DB: 'routing-aliased-primary' },
      bindings: { ENVIRONMENT: 'test', CELL_ID: 'alias-cell', SHARD_ID: 'core', IDENTITY_CELL_ID: 'alias-cell', IDENTITY_SHARD_ID: 'core',
        IDENTITY_KEYS_JSON: JSON.stringify({ current: 'alias-test', keys: { 'alias-test': base64url(crypto.getRandomValues(new Uint8Array(32))) } }),
        API_ORIGIN: 'https://api.gitknot.com', APP_ORIGIN: 'https://gitknot.com', GIT_ORIGIN: 'https://git.gitknot.com', INTERNAL_SERVICE_KEY: 'a'.repeat(64) },
    }] }));
    try {
      await runtime.ready;
      const db = await runtime.getD1Database('DB', 'api') as unknown as D1Database;
      const identity = await runtime.getD1Database('IDENTITY_DB', 'api') as unknown as D1Database;
      const schema = await createTestDatabase({ migrations: ['000_core.sql', '000_idempotency_recovery.sql', '001_identity.sql',
        '002_authorization.sql', '003_credentials.sql', '004_repository_catalog.sql', '018_federation.sql',
        '090_authority_routing.sql', '091_request_fingerprints.sql', '093_metadata_fences.sql', '097_metadata_fence_wait.sql'] });
      try {
        const definitions = schema.sqlite.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as { sql: string }[];
        for (const definition of definitions) await db.prepare(definition.sql).run();
        for (const table of ['roles', 'role_capabilities']) {
          const rows = schema.sqlite.prepare(`SELECT * FROM ${table}`).all();
          for (const row of rows) await stmt(db, `INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, ...Object.values(row)).run();
        }
      } finally { schema.close(); }
      const at = now();
      await db.batch([
        stmt(db, "INSERT INTO users(id,username,email,email_verified_at,created_at,updated_at) VALUES ('u_alias','alias','alias@example.net',?,?,?)", at, at, at),
        stmt(db, "INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES ('u_alias','user','alias','Alias','u_alias',?,?)", at, at),
        stmt(db, "INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES ('u_alias','user','u_alias','u_alias','Alias','u_alias',?,?)", at, at),
        stmt(db, `INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
          VALUES ('r_alias','u_alias','Alias','alias','private','active','alias-cell','core','alias_storage','u_alias',?,?)`, at, at),
        stmt(db, "INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,epoch,state,updated_at) VALUES ('r_alias','repository','alias-cell','core',1,'active',?)", at),
        stmt(db, 'CREATE TABLE alias_notes(id TEXT PRIMARY KEY,repo_id TEXT NOT NULL,title TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1)'),
      ]);
      const credential = await prepareCredential(identity, { principal_id: 'u_alias', user_id: 'u_alias', kind: 'personal', name: 'Aliased binding journey',
        capabilities: ['*'], repository_ids: null, account_ids: null, auth_revision: 1, mfa: false,
        expires_at: new Date(Date.now() + 86400_000).toISOString(), created_by: 'u_alias' });
      await credential.statement.run();
      const write = async (path: string, key: string, body: unknown, status = 201) => {
        const response = await runtime.dispatchFetch(`https://api.gitknot.com${path}`, { method: 'POST',
          headers: { authorization: `Bearer ${credential.token}`, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
        const value = await response.json();
        expect(response.status, JSON.stringify(value)).toBe(status);
        return value;
      };
      expect(await write('/v1/repos/r_alias/alias-notes', 'repository-alias', { title: 'Repository physical alias' }))
        .toMatchObject({ colocated: true, kind: 'repository', scope: 'r_alias', initial_repo_id: 'r_alias' });
      expect(await write('/v1/alias-account-notes', 'identity-alias', { title: 'Identity physical alias', repo_id: 'r_alias' }))
        .toMatchObject({ colocated: true, kind: 'identity', scope: null, initial_repo_id: null });
      expect(await one(identity, 'SELECT COUNT(*) AS count FROM alias_notes')).toEqual({ count: 2 });
      expect(await one(identity, 'SELECT COUNT(*) AS count FROM account_authority_placements')).toEqual({ count: 0 });
      expect(await one(db, 'SELECT COUNT(*) AS count FROM audit_log')).toEqual({ count: 2 });
      await db.prepare(`INSERT INTO repository_metadata_fences(repo_id,operation_id,routing_epoch,fence_id,state,updated_at)
        VALUES ('r_alias','op_alias_snapshot',1,'mfence_alias','held',?)`).bind(now()).run();
      await write('/v1/repos/r_alias/alias-notes', 'repository-fenced', { title: 'Blocked colocated metadata' }, 423);
      expect(await write('/v1/alias-account-notes', 'identity-while-repo-fenced', { title: 'Independent identity storage', repo_id: 'r_alias' }))
        .toMatchObject({ colocated: true, kind: 'identity', scope: null, initial_repo_id: null });
      expect(await one(identity, 'SELECT COUNT(*) AS count FROM alias_notes')).toEqual({ count: 3 });
    } finally { await runtime.dispose(); }
  }, 60_000);
});
