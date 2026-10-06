import { Hono } from 'hono';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { prepareCredential, publicCredential } from '../../packages/core/src/auth.ts';
import { bytes, canonicalJson, newId, now, randomToken, sha256 } from '../../packages/core/src/crypto.ts';
import { database, one, stmt } from '../../packages/core/src/db.ts';
import { ApiError, errorResponse } from '../../packages/core/src/errors.ts';
import { mutate, mutationGuard, mutationStatements } from '../../packages/core/src/events.ts';
import { expectedRevision, jsonBody, requirePrincipal, resourceResponse } from '../../packages/core/src/http.ts';
import { browserBoundary, identityContext, requestContext } from '../../packages/core/src/middleware.ts';
import { readBounded } from '../../packages/core/src/limits.ts';
import { authorize } from '../../packages/core/src/policy.ts';
import { openApiDocument, route } from '../../packages/core/src/routes.ts';
import { routeRepositoryRequest } from '../../packages/core/src/routing.ts';
import type { AppContext, AppEnv, Bindings, IdempotencyRecord } from '../../packages/core/src/types.ts';
import { createTestDatabase, SqliteD1 } from '../support/database.ts';

const open: SqliteD1[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

function gate() {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  return { reached, release, wait: async () => { entered(); await held; } };
}

interface Faults {
  beforeMutation?: () => Promise<void>;
  beforeBatch?: () => Promise<void>;
  afterCommit?: boolean;
  completionFailures: number;
  referenced?: boolean;
}

/** Network failures leave the real SQLite transaction intact or fully rolled back. */
function faultableDatabase(db: SqliteD1, faults: Faults): D1Database {
  function prepared(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    return new Proxy(statement, { get(target, property) {
      if (property === 'bind') return (...values: unknown[]) => prepared(target.bind(...values), sql);
      if (property === 'run') return async () => {
        if (faults.completionFailures && /UPDATE idempotency_keys SET status=\?,response_status=/i.test(sql)) {
          faults.completionFailures--;
          throw new Error('injected response persistence outage');
        }
        return target.run();
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
  const binding = new Proxy(db.binding(), { get(target, property) {
    if (property === 'withSession') return (constraint: string) => {
      expect(constraint).toBe('first-primary');
      return binding as unknown as D1DatabaseSession;
    };
    if (property === 'prepare') return (sql: string) => prepared(target.prepare(sql), sql);
    if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
      const pause = faults.beforeBatch;
      faults.beforeBatch = undefined;
      if (pause) await pause();
      const results = await db.batch(statements);
      if (faults.afterCommit) {
        faults.afterCommit = false;
        throw new Error('injected lost D1 commit acknowledgement');
      }
      return results;
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return binding;
}

const documentSchema = z.object({ title: z.string().min(1), ref: z.string().optional(), paths: z.array(z.string()).optional() }).strict();
interface Document { id: string; repo_id: string; title: string; revision: number }

async function fixture(options: { legacyFingerprints?: boolean } = {}) {
  const db = await createTestDatabase({ migrations: [
    '000_core.sql', '000_idempotency_recovery.sql', '001_identity.sql', '002_authorization.sql', '003_credentials.sql', '004_repository_catalog.sql', '018_federation.sql',
    '090_authority_routing.sql', ...(options.legacyFingerprints ? [] : ['091_request_fingerprints.sql']), '093_metadata_fences.sql', '097_metadata_fence_wait.sql',
  ] });
  open.push(db);
  db.sqlite.exec(`
    INSERT INTO users(id,username,email,email_verified_at,created_at,updated_at) VALUES
      ('u_alice','alice','alice@example.net','2026-01-01','2026-01-01','2026-01-01'),
      ('u_bob','bob','bob@example.net','2026-01-01','2026-01-01','2026-01-01');
    INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES
      ('u_alice','user','alice','Alice','u_alice','2026-01-01','2026-01-01'),
      ('u_bob','user','bob','Bob','u_bob','2026-01-01','2026-01-01'),
      ('org_team','organization','team','Team','u_alice','2026-01-01','2026-01-01');
    INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES
      ('u_alice','user','u_alice','u_alice','Alice','u_alice','2026-01-01','2026-01-01'),
      ('u_bob','user','u_bob','u_bob','Bob','u_bob','2026-01-01','2026-01-01');
    INSERT INTO memberships(account_id,principal_id,role_id,state,created_by,created_at,updated_at) VALUES
      ('org_team','u_alice','owner','active','u_alice','2026-01-01','2026-01-01'),
      ('org_team','u_bob','maintainer','active','u_alice','2026-01-01','2026-01-01');
    INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
      VALUES('r_repo','org_team','Repo','repo','private','active','test','core','repo','u_alice','2026-01-01','2026-01-01');
    CREATE TABLE request_documents(id TEXT PRIMARY KEY,repo_id TEXT NOT NULL,title TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE request_capacity(id TEXT PRIMARY KEY,remaining INTEGER NOT NULL CHECK(remaining>=0));
    INSERT INTO request_capacity VALUES('documents',20);
  `);
  const faults: Faults = { completionFailures: 0 };
  const env = { DB: faultableDatabase(db, faults), CELL_ID: 'test', SHARD_ID: 'core', ENVIRONMENT: 'test',
    APP_ORIGIN: 'https://gitknot.com', API_ORIGIN: 'https://api.gitknot.com', GIT_ORIGIN: 'https://git.gitknot.com',
    IDENTITY_KEYS_JSON: JSON.stringify({ current: 'v1', keys: { v1: randomToken() } }),
  } as unknown as Bindings;
  async function token(user = 'u_alice', scopes: { repositories?: string[]; refs?: string[] } = {}) {
    const value = await prepareCredential(env.DB, { principal_id: user, user_id: user, kind: 'personal', name: 'Recovery scenario',
      capabilities: ['*'], repository_ids: scopes.repositories ?? null, account_ids: null, ref_patterns: scopes.refs ?? null,
      auth_revision: 1, mfa: false, expires_at: new Date(Date.now() + 86400_000).toISOString(), created_by: user });
    await value.statement.run();
    return value;
  }
  const alice = await token();
  const app = new Hono<AppEnv>();
  app.onError(errorResponse);
  app.use('*', requestContext, browserBoundary, identityContext);
  const path = '/v1/repos/:repoId/documents';
  route(app, 'GET', `${path}/:id`, { summary: 'Read a current document', capability: 'contents.read' }, async c => {
    await authorize(c, 'contents.read', { repo_id: c.req.param('repoId') });
    const document = await one<Document>(database(c), 'SELECT * FROM request_documents WHERE id=? AND repo_id=?', c.req.param('id'), c.req.param('repoId'));
    if (!document) throw new ApiError(404, 'not_found', 'The document was not found.');
    return resourceResponse(c, document);
  });
  const createDocument = async (c: AppContext) => {
    const input = await jsonBody(c, documentSchema);
    const before = faults.beforeMutation;
    faults.beforeMutation = undefined;
    if (before) await before();
    if (faults.referenced) throw new ApiError(409, 'document_referenced', 'This private document is referenced.', { private_context: 'must-not-be-replayed' });
    const id = newId('doc');
    const guard = newId('guard');
    await mutate(c, {
      sql: 'INSERT INTO request_documents(id,repo_id,title) VALUES (?,?,?)', bindings: [id, c.req.param('repoId'), input.title],
      after: [stmt(database(c), "UPDATE request_capacity SET remaining=remaining-1 WHERE id='documents' AND remaining>0"),
        mutationGuard(database(c), guard), stmt(database(c), 'DELETE FROM mutation_guards WHERE id=?', guard)],
      event: { type: 'document.created', resource_id: id, resource_revision: 1, repo_id: c.req.param('repoId'), account_id: 'org_team' },
    });
    return resourceResponse(c, { id, repo_id: c.req.param('repoId'), title: input.title, revision: 1 }, 201);
  };
  route(app, 'POST', path, { summary: 'Create a guarded document', capability: 'issues.write', body: documentSchema }, createDocument);
  route(app, 'POST', `${path}/publication`, { summary: 'Record an exact ref/path-scoped publication', capability: 'contents.push', body: documentSchema,
    idempotency: { authorization: c => [{ capability: 'contents.push', scope: { repo_id: c.req.param('repoId'),
      ref: (c.get('input') as z.infer<typeof documentSchema>).ref, paths: (c.get('input') as z.infer<typeof documentSchema>).paths } }] },
  }, createDocument);

  route(app, 'POST', '/v1/repos/:repoId/credentials', { summary: 'Issue one credential through a guarded shared batch',
    capability: 'tokens.manage', body: documentSchema, sensitive: true }, async c => {
    const actor = requirePrincipal(c);
    const credential = await prepareCredential(database(c), { principal_id: actor.id, user_id: actor.user_id, kind: 'personal', name: 'Issued once',
      capabilities: ['contents.read'], repository_ids: [c.req.param('repoId')!], account_ids: ['org_team'], auth_revision: 1, mfa: false,
      expires_at: new Date(Date.now() + 86400_000).toISOString(), created_by: actor.id });
    await database(c).batch(await mutationStatements(c, { statements: [credential.statement],
      event: { type: 'credential.issued', resource_id: credential.credential.id, resource_revision: 1,
        repo_id: c.req.param('repoId'), account_id: 'org_team' } }));
    return c.json({ ...publicCredential(credential.credential), token: credential.token }, 201);
  });
  const request = (key?: string, options: { path?: string; token?: string; body?: object; contentType?: string; ifMatch?: string } = {}) =>
    app.fetch(new Request(`https://api.gitknot.com${options.path ?? '/v1/repos/r_repo/documents'}`, { method: 'POST',
      headers: { authorization: `Bearer ${options.token ?? alice.token}`, 'content-type': options.contentType ?? 'application/json',
        ...(key ? { 'idempotency-key': key } : {}), origin: env.APP_ORIGIN, ...(options.ifMatch ? { 'if-match': options.ifMatch } : {}) },
      body: JSON.stringify(options.body ?? { title: 'Original document' }),
    }), env);
  const count = async (table: string) => (await one<{ total: number }>(env.DB, `SELECT COUNT(*) AS total FROM ${table}`))!.total;
  return { db, env, app, faults, request, token, alice, count };
}

describe('HTTP request recovery from durable effects', () => {
  it('lets only fixed cleanup callbacks reach their proof verifier after account fencing and credential retirement', async () => {
    const f = await fixture();
    const cleanupCapability = randomToken();
    const schema = z.object({ capability: z.string(), lease: z.number().int(), terminated: z.boolean() }).strict();
    const options = { summary: 'Attempt callback', idempotent: false, body: schema,
      authorization: () => [{ capability: 'runners.manage', scope: { account_id: 'org_team' } }] };
    let cleaned = 0;
    let completed = 0;
    route(f.app, 'POST', '/v1/attempts/:id/terminated', options, async c => {
      const proof = await jsonBody(c, schema);
      if (c.req.param('id') !== 'att_cleanup' || proof.capability !== cleanupCapability || proof.lease !== 3 || !proof.terminated) {
        throw new ApiError(401, 'invalid_cleanup_proof', 'The cleanup proof is invalid.');
      }
      cleaned++;
      return c.body(null, 204);
    });
    route(f.app, 'POST', '/v1/attempts/:id/completed', options, c => { completed++; return c.body(null, 204); });
    f.db.sqlite.exec(`INSERT INTO account_policy_barriers(account_id,id,reason,previous_policy_revision,recover_after,created_at)
      VALUES ('org_team','barrier_cleanup','test fence',1,'2099-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`);
    f.db.sqlite.prepare('UPDATE credentials SET revoked_at=?,revision=revision+1 WHERE id=?').run(now(), f.alice.credential.id);
    const body = { capability: cleanupCapability, lease: 3, terminated: true };
    expect((await f.request('cleanup-proof', { path: '/v1/attempts/att_cleanup/terminated', body })).status).toBe(204);
    const forged = await f.request('cleanup-proof', { path: '/v1/attempts/att_cleanup/terminated', body: { ...body, lease: 2 } });
    expect(forged.status).toBe(401);
    expect(await forged.json()).toMatchObject({ error: { code: 'invalid_cleanup_proof' } });
    expect((await f.request('cleanup-proof', { path: '/v1/attempts/att_cleanup/completed', body })).status).toBe(401);
    expect(cleaned).toBe(1);
    expect(completed).toBe(0);
    expect(await f.count('idempotency_keys')).toBe(0);
  });

  it('protects secret-write fingerprints and recovers the same request across retained-key rotation and API-cell movement', async () => {
    const f = await fixture({ legacyFingerprints: true });
    const keys = { v1: randomToken(), v2: randomToken() };
    f.env.IDENTITY_KEYS_JSON = JSON.stringify({ current: 'v1', keys: { v1: keys.v1 } });
    const path = '/v1/repos/r_repo/test-secrets/deploy';
    const input = { value: 'letmein' };
    const bodyHash = await sha256(JSON.stringify(input));
    const legacyHash = await sha256(['PUT', path, '', bodyHash].join('\n'));
    await f.env.DB.prepare(`INSERT INTO idempotency_keys(principal_id,key,request_hash,status,response_body,created_at,updated_at,expires_at)
      VALUES ('u_alice','legacy-secret',?,'uncertain',?,?,?,?)`).bind(legacyHash, JSON.stringify({ error: { details: input } }), now(), now(), new Date(Date.now() + 86400_000).toISOString()).run();
    await f.db.exec(await readFile(new URL('../../migrations/091_request_fingerprints.sql', import.meta.url), 'utf8'));
    expect(await one(f.env.DB, "SELECT request_hash,response_body,fingerprint_version FROM idempotency_keys WHERE key='legacy-secret'"))
      .toEqual({ request_hash: '0'.repeat(64), response_body: null, fingerprint_version: 0 });

    // Only the test vault adapter holds this key; the metadata database stores ciphertext.
    const vaultKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    f.db.sqlite.exec('CREATE TABLE request_secrets(id TEXT PRIMARY KEY,repo_id TEXT NOT NULL,name TEXT NOT NULL,nonce BLOB NOT NULL,ciphertext BLOB NOT NULL,revision INTEGER NOT NULL,UNIQUE(repo_id,name))');
    const schema = z.object({ value: z.string().min(1).max(1000) }).strict();
    let handlerCalls = 0;
    const app = new Hono<AppEnv>();
    app.onError(errorResponse);
    app.use('*', requestContext, browserBoundary);
    app.use('/v1/repos/:repoId/*', async (c, next) => {
      const forwarded = await routeRepositoryRequest(c, c.req.param('repoId')!);
      if (forwarded) return forwarded;
      await next();
    });
    app.use('*', identityContext);
    route(app, 'PUT', '/v1/repos/:repoId/test-secrets/:name', { summary: 'Write an encrypted secret and return metadata', body: schema, capability: 'secrets.manage',
      idempotency: { recover: async (c, record) => `/v1/repos/${c.req.param('repoId')}/test-secret-versions/${record.resource_id}` },
    }, async c => {
      handlerCalls++;
      const fail = f.faults.beforeMutation;
      f.faults.beforeMutation = undefined;
      if (fail) await fail();
      const body = await jsonBody(c, schema);
      const previous = await one<{ id: string; revision: number }>(database(c), 'SELECT id,revision FROM request_secrets WHERE repo_id=? AND name=?', c.req.param('repoId'), c.req.param('name'));
      if (previous && c.req.header('if-none-match') === '*') throw new ApiError(412, 'revision_conflict', 'The secret already exists.');
      const revision = previous ? expectedRevision(c) : 0;
      const id = previous?.id ?? newId('testsecret');
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, vaultKey, bytes(body.value)));
      await mutate(c, { ...(previous ? {
        sql: 'UPDATE request_secrets SET nonce=?,ciphertext=?,revision=revision+1 WHERE id=? AND revision=?',
        bindings: [nonce, ciphertext, id, revision],
      } : {
        sql: 'INSERT INTO request_secrets(id,repo_id,name,nonce,ciphertext,revision) VALUES (?,?,?,?,?,1)',
        bindings: [id, c.req.param('repoId'), c.req.param('name'), nonce, ciphertext],
      }), event: { type: previous ? 'secret.rotated' : 'secret.created', resource_id: id, resource_revision: revision + 1,
        repo_id: c.req.param('repoId'), account_id: 'org_team' } });
      return resourceResponse(c, { id, name: c.req.param('name'), revision: revision + 1 }, previous ? 200 : 201);
    });
    route(app, 'GET', '/v1/repos/:repoId/test-secret-versions/:id', { summary: 'Read write-only secret metadata', capability: 'secrets.manage' }, async c => {
      await authorize(c, 'secrets.manage', { repo_id: c.req.param('repoId') });
      const secret = await one<{ id: string; name: string; revision: number }>(database(c), 'SELECT id,name,revision FROM request_secrets WHERE id=? AND repo_id=?', c.req.param('id'), c.req.param('repoId'));
      if (!secret) throw new ApiError(404, 'not_found', 'The secret was not found.');
      return resourceResponse(c, secret);
    });
    const send = (key: string, env = f.env, value = input.value, conditions: Record<string, string> = { 'if-none-match': '*' }) =>
      app.fetch(new Request(`https://api.gitknot.com${path}`, { method: 'PUT',
        headers: { authorization: `Bearer ${f.alice.token}`, 'content-type': 'application/json', 'idempotency-key': key, ...conditions },
        body: JSON.stringify({ value }) }), env);
    expect((await send('legacy-secret')).status).toBe(409);
    expect(handlerCalls).toBe(0);
    f.faults.beforeMutation = async () => { throw new ApiError(503, 'vault_unavailable', 'The private vault is temporarily unavailable.'); };
    expect((await send('secret-write')).status).toBe(503);
    type Fingerprint = { request_hash: string; fingerprint_version: number; fingerprint_key_id: string; generation: number; repo_id: string; account_id: string };
    const original = (await one<Fingerprint>(f.env.DB, "SELECT request_hash,fingerprint_version,fingerprint_key_id,generation,repo_id,account_id FROM idempotency_keys WHERE key='secret-write'"))!;
    expect(original).toMatchObject({ fingerprint_version: 1, fingerprint_key_id: 'v1', generation: 1, repo_id: 'r_repo', account_id: 'org_team' });
    expect(original.request_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(original.request_hash).not.toBe(legacyHash);
    const subkey = createHmac('sha256', Buffer.from(keys.v1, 'base64url')).update('GitKnot request fingerprint key v1\0').digest();
    const expected = createHmac('sha256', subkey).update('GitKnot request fingerprint message v1\0' + canonicalJson({
      version: 1, key_id: 'v1', principal_id: 'u_alice', idempotency_key: 'secret-write', method: 'PUT', path,
      preconditions: { 'if-match': null, 'if-none-match': '*', 'if-unmodified-since': null, 'if-modified-since': null, 'if-range': null }, body_sha256: bodyHash,
    })).digest('hex');
    expect(original.request_hash).toBe(expected);

    // A different cell/binding serves the relocated repository and its preserved request records.
    f.db.sqlite.exec(`UPDATE repositories SET cell_id='cell_b',shard_id='shard_b',routing_epoch=2,revision=revision+1 WHERE id='r_repo';
      INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,epoch,state,updated_at)
      VALUES ('r_repo','repository','cell_b','shard_b',2,'active','2026-01-01T00:00:00.000Z')
      ON CONFLICT(resource_id) DO UPDATE SET cell_id='cell_b',shard_id='shard_b',epoch=2;`);
    const moved: Bindings = { ...f.env, DB: faultableDatabase(f.db, f.faults), CELL_ID: 'cell_b', SHARD_ID: 'shard_b',
      IDENTITY_KEYS_JSON: JSON.stringify({ current: 'v2', keys: { v2: keys.v2 } }) };
    const unavailable = await send('secret-write', moved);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ error: { code: 'idempotency_fingerprint_unavailable' } });
    expect(handlerCalls).toBe(1);
    expect(await one(f.env.DB, "SELECT generation,event_id FROM idempotency_keys WHERE key='secret-write'")).toEqual({ generation: 1, event_id: null });
    moved.IDENTITY_KEYS_JSON = JSON.stringify({ current: 'v2', keys });
    f.faults.afterCommit = true;
    expect((await send('secret-write', moved)).status).toBe(500);
    f.faults.completionFailures = 1;
    const recovered = await send('secret-write', moved);
    expect(recovered.status).toBe(200);
    const metadata = await recovered.json() as { id: string; revision: number };
    expect(metadata).toMatchObject({ revision: 1 });
    expect(JSON.stringify(metadata)).not.toContain(input.value);
    expect(metadata).not.toHaveProperty('request_hash');
    expect(metadata).not.toHaveProperty('fingerprint_key_id');
    expect(await (await send('secret-write', moved)).json()).toMatchObject(metadata);
    expect(handlerCalls).toBe(2);
    expect((await send('secret-write', moved, 'another-guess')).status).toBe(409);
    expect((await send('secret-write', moved, input.value, { 'if-none-match': '"changed"' })).status).toBe(409);
    expect(await one(f.env.DB, "SELECT request_hash,fingerprint_key_id,generation FROM idempotency_keys WHERE key='secret-write'"))
      .toEqual({ request_hash: original.request_hash, fingerprint_key_id: 'v1', generation: 2 });
    const stored = (await one<{ nonce: Uint8Array; ciphertext: Uint8Array }>(f.env.DB, 'SELECT nonce,ciphertext FROM request_secrets WHERE id=?', metadata.id))!;
    expect(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(stored.nonce) }, vaultKey, bytes(stored.ciphertext)))).toBe(input.value);

    const rotate = await send('new-secret-version', moved, 'replacement', { 'if-match': '"1"' });
    expect(rotate.status).toBe(200);
    expect(await rotate.json()).toMatchObject({ id: metadata.id, revision: 2 });
    expect(await one(f.env.DB, "SELECT fingerprint_key_id FROM idempotency_keys WHERE key='new-secret-version'")).toEqual({ fingerprint_key_id: 'v2' });
    moved.IDENTITY_KEYS_JSON = JSON.stringify({ current: 'v2', keys: { v2: keys.v2 } });
    expect((await send('secret-write', moved)).status).toBe(503);
    expect((await send('new-secret-version', moved, 'replacement', { 'if-match': '"1"' })).status).toBe(200);
    expect(handlerCalls).toBe(3);
    expect(await f.count('request_secrets')).toBe(1);
    expect(await f.count('outbox')).toBe(2);
    expect(await f.count('audit_log')).toBe(2);
    expect(await one(f.env.DB, 'SELECT COUNT(*) AS total FROM idempotency_keys WHERE response_body IS NOT NULL')).toEqual({ total: 0 });
    const copy = await f.env.DB.prepare('SELECT * FROM idempotency_keys').all();
    expect(JSON.stringify(copy.results)).not.toContain(input.value);
    expect(JSON.stringify(copy.results)).not.toContain(bodyHash);
    expect(JSON.stringify(copy.results)).not.toContain(legacyHash);
  });

  it('fences no-key mutations and streamed publication against credential and cross-scope policy revocation', async () => {
    for (const boundary of ['json_credential', 'stream_credential', 'stream_source_policy'] as const) {
      const f = await fixture();
      const streamed = boundary !== 'json_credential';
      const paused = gate();
      let closeBody: (() => void) | undefined;
      let response: Promise<Response>;
      if (streamed) {
        f.db.sqlite.exec(`
          INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at)
            VALUES('org_source','organization','source','Source','u_alice','2026-01-01','2026-01-01');
          INSERT INTO memberships(account_id,principal_id,role_id,state,created_by,created_at,updated_at)
            VALUES('org_source','u_alice','owner','active','u_alice','2026-01-01','2026-01-01');
          INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
            VALUES('r_source','org_source','Source','source','private','active','test','core','source','u_alice','2026-01-01','2026-01-01');
        `);
        const body = new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode('first chunk'));
          closeBody = () => { controller.enqueue(new TextEncoder().encode('last chunk')); controller.close(); };
        } });
        route(f.app, 'PUT', '/v1/repos/:repoId/publication', { summary: 'Publish a streamed document with a required source audience',
          capability: 'attachments.write', streaming: true, idempotent: false,
          authorization: c => [
            { capability: 'attachments.write', scope: { repo_id: c.req.param('repoId') } },
            { capability: 'contents.read', scope: { repo_id: 'r_source' } },
          ],
        }, async c => {
          // The request is authorized, but its input remains in flight.
          void paused.wait();
          const bytes = await readBounded(c.req.raw.body, 1024);
          const id = newId('doc');
          await mutate(c, { sql: 'INSERT INTO request_documents(id,repo_id,title) VALUES (?,?,?)',
            bindings: [id, c.req.param('repoId'), new TextDecoder().decode(bytes)],
            event: { type: 'document.published', resource_id: id, resource_revision: 1, repo_id: c.req.param('repoId'), account_id: 'org_team' } });
          return c.json({ id }, 201);
        });
        const init = { method: 'PUT', body, duplex: 'half', headers: { authorization: `Bearer ${f.alice.token}`, 'content-type': 'application/octet-stream' } };
        response = Promise.resolve(f.app.fetch(new Request('https://api.gitknot.com/v1/repos/r_repo/publication', init), f.env));
      } else {
        f.faults.beforeBatch = paused.wait;
        response = Promise.resolve(f.request());
      }
      await paused.reached;
      if (boundary === 'stream_source_policy') {
        f.db.sqlite.exec("UPDATE memberships SET state='suspended' WHERE account_id='org_source' AND principal_id='u_alice'; UPDATE accounts SET policy_revision=policy_revision+1 WHERE id='org_source'");
      } else {
        f.db.sqlite.prepare('UPDATE credentials SET revoked_at=?,revision=revision+1 WHERE id=?').run(now(), f.alice.credential.id);
      }
      closeBody?.();
      paused.release();
      expect((await response).status).toBe(412);
      expect(await f.count('request_documents')).toBe(0);
      expect(await f.count('outbox')).toBe(0);
      expect(await f.count('audit_log')).toBe(0);
      expect(await f.count('idempotency_keys')).toBe(0);
      expect(await f.count('mutation_guards')).toBe(0);
    }
  });

  it('recovers failures before mutation, after commit, and during response persistence without duplicate effects', async () => {
    for (const boundary of ['before_mutation', 'after_commit', 'response_persistence'] as const) {
      const f = await fixture();
      if (boundary === 'before_mutation') f.faults.beforeMutation = async () => { throw new ApiError(503, 'dependency_unavailable', 'Retry this request.'); };
      if (boundary === 'after_commit') f.faults.afterCommit = true;
      if (boundary === 'response_persistence') f.faults.completionFailures = 1;
      const interrupted = await f.request(boundary);
      expect(interrupted.status).toBe(boundary === 'response_persistence' ? 201 : boundary === 'before_mutation' ? 503 : 500);
      const recovered = await f.request(boundary);
      expect(recovered.status).toBe(201);
      const document = await recovered.json() as Document;
      expect(document.title).toBe('Original document');
      const repeated = await f.request(boundary);
      expect(repeated.status).toBe(201);
      expect(await repeated.json()).toMatchObject({ id: document.id });
      expect(repeated.headers.get('idempotency-replayed')).toBe('true');
      expect(repeated.headers.get('access-control-allow-origin')).toBe(f.env.APP_ORIGIN);
      expect(await f.count('request_documents')).toBe(1);
      expect(await f.count('outbox')).toBe(1);
      expect(await f.count('audit_log')).toBe(1);
      expect(await one(f.env.DB, "SELECT remaining FROM request_capacity WHERE id='documents'")).toEqual({ remaining: 19 });
      expect(await one(f.env.DB, 'SELECT response_body,status FROM idempotency_keys WHERE key=?', boundary)).toEqual({ response_body: null, status: 'complete' });
      if (boundary === 'response_persistence') {
        // An incomplete restore must not turn a lost source event into permission
        // to execute the accepted mutation again.
        f.db.sqlite.exec('DELETE FROM outbox');
        expect((await f.request(boundary)).status).toBe(503);
        expect(await f.count('request_documents')).toBe(1);
        expect(await one(f.env.DB, 'SELECT generation FROM idempotency_keys WHERE key=?', boundary)).toEqual({ generation: 1 });
      }
    }
  });

  it('fences a still-live abandoned writer and preserves the active lease against duplicate requests', async () => {
    const f = await fixture();
    const paused = gate();
    f.faults.beforeMutation = paused.wait;
    const old = f.request('racing-request');
    await paused.reached;
    const pending = await f.request('racing-request');
    expect(pending.status).toBe(409);
    expect(pending.headers.get('retry-after')).toBe('2');
    expect(await one(f.env.DB, 'SELECT generation,status FROM idempotency_keys WHERE key=?', 'racing-request')).toEqual({ generation: 1, status: 'pending' });
    f.db.sqlite.exec("UPDATE idempotency_keys SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE key='racing-request'");
    const replacement = await f.request('racing-request');
    expect(replacement.status).toBe(201);
    const accepted = await replacement.json() as Document;
    paused.release();
    const stale = await old;
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: 'idempotency_request_superseded' } });
    expect(await one(f.env.DB, 'SELECT id FROM request_documents')).toEqual({ id: accepted.id });
    expect(await f.count('outbox')).toBe(1);
    expect(await f.count('audit_log')).toBe(1);
    expect(await one(f.env.DB, 'SELECT generation,status FROM idempotency_keys WHERE key=?', 'racing-request')).toEqual({ generation: 2, status: 'complete' });
  });

  it('rolls back conditional effects and policy races together with their source events and receipts', async () => {
    const f = await fixture();
    f.db.sqlite.exec("UPDATE request_capacity SET remaining=0 WHERE id='documents'");
    expect((await f.request('quota-retry')).status).toBe(412);
    expect(await f.count('request_documents')).toBe(0);
    expect(await f.count('outbox')).toBe(0);
    expect(await f.count('audit_log')).toBe(0);
    expect(await one(f.env.DB, 'SELECT committed_at,event_id,audit_id FROM idempotency_keys WHERE key=?', 'quota-retry')).toEqual({ committed_at: null, event_id: null, audit_id: null });
    f.db.sqlite.exec("UPDATE request_capacity SET remaining=20 WHERE id='documents'");
    const paused = gate();
    f.faults.beforeBatch = paused.wait;
    const pending = f.request('quota-retry');
    await paused.reached;
    f.db.sqlite.exec("UPDATE accounts SET policy_revision=policy_revision+1 WHERE id='org_team'");
    paused.release();
    expect((await pending).status).toBe(412);
    expect(await f.count('request_documents')).toBe(0);
    expect(await f.count('outbox')).toBe(0);
    expect((await f.request('quota-retry')).status).toBe(201);
    expect(await f.count('request_documents')).toBe(1);
    expect(await f.count('outbox')).toBe(1);
    expect(await f.count('audit_log')).toBe(1);
    expect(await f.count('mutation_guards')).toBe(0);
    expect(await f.count('idempotency_write_guards')).toBe(0);
  });

  it('rechecks error and resource authorization, credential scope, and exact ref/path conditions', async () => {
    const f = await fixture();
    f.faults.referenced = true;
    const first = await f.request('private-error');
    expect(first.status).toBe(409);
    expect(await first.text()).toContain('must-not-be-replayed');
    f.faults.referenced = false;
    const accepted = await f.request('private-resource');
    const document = await accepted.json() as Document;
    f.db.sqlite.prepare('UPDATE request_documents SET title=?,revision=revision+1 WHERE id=?').run('Current authorized representation', document.id);
    expect(await (await f.request('private-resource')).json()).toMatchObject({ id: document.id, title: 'Current authorized representation', revision: 2 });
    const restricted = await f.token('u_alice', { repositories: [] });
    for (const key of ['private-error', 'private-resource']) {
      const denied = await f.request(key, { token: restricted.token });
      expect(denied.status).toBe(404);
      const error = await denied.json() as { error: { request_id: string } };
      expect(JSON.stringify(error)).not.toMatch(/must-not-be-replayed|Current authorized representation/);
      expect(error.error.request_id).toBe(denied.headers.get('x-gitknot-request-id'));
    }
    const body = { title: 'Protected publication', ref: 'refs/heads/release', paths: ['release/config.json'] };
    expect((await f.request('scoped-publication', { path: '/v1/repos/r_repo/documents/publication', body })).status).toBe(201);
    const branchToken = await f.token('u_alice', { repositories: ['r_repo'], refs: ['refs/heads/automation/*'] });
    expect((await f.request('scoped-publication', { path: '/v1/repos/r_repo/documents/publication', body, token: branchToken.token })).status).toBe(404);
    const keysBefore = await f.count('idempotency_keys');
    expect((await f.request(undefined, { path: '/v1/repos/r_repo/documents/publication',
      body: { ...body, ref: 'refs/heads/automation/update' }, token: branchToken.token })).status).toBe(201);
    expect(await f.count('idempotency_keys')).toBe(keysBefore);
    f.db.sqlite.exec("UPDATE memberships SET state='suspended' WHERE account_id='org_team' AND principal_id='u_alice'; UPDATE accounts SET policy_revision=policy_revision+1 WHERE id='org_team'");
    expect((await f.request('private-resource')).status).toBe(404);
    expect(await one(f.env.DB, 'SELECT COUNT(*) AS total FROM idempotency_keys WHERE response_body IS NOT NULL')).toEqual({ total: 0 });
  });

  it('binds keys to principals, exact bodies and preconditions for every accepted JSON media type', async () => {
    const f = await fixture();
    const options = { contentType: 'application/vnd.gitknot+json; charset=utf-8', ifMatch: '"1"' };
    const first = await f.request('same-key', options);
    expect(first.status).toBe(201);
    const document = await first.json() as Document;
    expect(await (await f.request('same-key', options)).json()).toMatchObject({ id: document.id });
    expect((await f.request('same-key', { ...options, body: { title: 'Different request' } })).status).toBe(409);
    expect((await f.request('same-key', { ...options, ifMatch: '"2"' })).status).toBe(409);
    const bob = await f.token('u_bob');
    const other = await f.request('same-key', { ...options, token: bob.token });
    expect(other.status).toBe(201);
    expect((await other.json() as Document).id).not.toBe(document.id);
    expect(await f.count('request_documents')).toBe(2);
    expect(await f.count('outbox')).toBe(2);
  });

  it('never caches or reissues one-time credentials after committed-response loss', async () => {
    for (const loss of ['commit_acknowledgement', 'response_persistence'] as const) {
      const f = await fixture();
      const before = await f.count('credentials');
      if (loss === 'commit_acknowledgement') f.faults.afterCommit = true;
      else f.faults.completionFailures = 1;
      const issued = await f.request(loss, { path: '/v1/repos/r_repo/credentials' });
      expect(issued.status).toBe(loss === 'commit_acknowledgement' ? 500 : 201);
      const retry = await f.request(loss, { path: '/v1/repos/r_repo/credentials' });
      expect(retry.status).toBe(409);
      expect(await retry.json()).toMatchObject({ error: { code: 'one_time_value_already_issued' } });
      expect(await f.count('credentials')).toBe(before + 1);
      expect(await f.count('outbox')).toBe(1);
      expect(await f.count('audit_log')).toBe(1);
      expect(await one(f.env.DB, 'SELECT replayable,response_body FROM idempotency_keys WHERE key=?', loss)).toEqual({ replayable: 0, response_body: null });
    }
  });

  it('reconciles an external operation by its durable identity without treating a D1 intent or elapsed lease as completion', async () => {
    const f = await fixture();
    const remote = new SqliteD1();
    open.push(remote);
    remote.sqlite.exec('CREATE TABLE external_operations(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,state TEXT NOT NULL)');
    let originalCalls = 0;
    const finishExternal = async (c: AppContext, record: Pick<IdempotencyRecord, 'operation_id' | 'request_hash'>) => {
      if (!record.operation_id) throw new Error('External recovery requires its persisted operation ID.');
      const operation = await one<{ id: string; state: string }>(remote.binding(), 'SELECT * FROM external_operations WHERE id=?', record.operation_id);
      if (!operation || operation.state !== 'completed') return null;
      const local = (await one<{ revision: number; status: string }>(database(c), 'SELECT revision,status FROM operations WHERE id=?', operation.id))!;
      if (local.status !== 'completed') await mutate(c, {
        sql: "UPDATE operations SET status='completed',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='pending'",
        bindings: [now(), operation.id, local.revision],
        event: { type: 'external.completed', resource_id: operation.id, resource_revision: local.revision + 1, repo_id: 'r_repo', account_id: 'org_team' },
      });
      return c.json({ id: operation.id, status: 'completed' }, 201);
    };
    route(f.app, 'POST', '/v1/repos/:repoId/external-operations', { summary: 'Start an independently journaled operation', body: documentSchema,
      idempotency: { strategy: 'external', authorization: c => [{ capability: 'issues.write', scope: { repo_id: c.req.param('repoId') } }],
        recover: finishExternal },
    }, async c => {
      originalCalls++;
      const request = c.get('idempotency')!;
      await mutate(c, {
        sql: 'INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        bindings: [request.operation_id, 'external.request', 'r_repo', 'r_repo', 'org_team', requirePrincipal(c).id, now(), now()],
        event: { type: 'external.requested', resource_id: request.operation_id!, resource_revision: 1, repo_id: 'r_repo', account_id: 'org_team' },
      });
      const digest = await sha256(JSON.stringify(await jsonBody(c, documentSchema)));
      await remote.prepare("INSERT INTO external_operations VALUES (?,?,'running') ON CONFLICT(id) DO NOTHING").bind(request.operation_id, digest).run();
      throw new ApiError(502, 'external_unconfirmed', 'The external acknowledgement was lost.');
    });
    const options = { path: '/v1/repos/r_repo/external-operations' };
    expect((await f.request('external-recovery', options)).status).toBe(502);
    f.db.sqlite.exec("UPDATE idempotency_keys SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE key='external-recovery'");
    expect((await f.request('external-recovery', options)).status).toBe(409);
    expect(originalCalls).toBe(1);
    expect(await one(f.env.DB, 'SELECT status FROM operations')).toEqual({ status: 'pending' });
    expect(await f.count('outbox')).toBe(1);
    remote.sqlite.exec("UPDATE external_operations SET state='completed'");
    const completed = await f.request('external-recovery', options);
    expect(completed.status).toBe(201);
    const operation = await completed.json() as { id: string };
    expect(await (await f.request('external-recovery', options)).json()).toMatchObject({ id: operation.id, status: 'completed' });
    expect(originalCalls).toBe(1);
    expect(await one(remote.binding(), 'SELECT COUNT(*) AS total FROM external_operations')).toEqual({ total: 1 });
    expect(await f.count('operations')).toBe(1);
    expect(await f.count('outbox')).toBe(2);
    expect(await f.count('audit_log')).toBe(2);
    expect(await one(f.env.DB, 'SELECT generation,status FROM idempotency_keys WHERE key=?', 'external-recovery')).toEqual({ generation: 1, status: 'complete' });

    let issued = 0;
    let reconciled = 0;
    const credentialFixture = await fixture();
    route(credentialFixture.app, 'POST', '/v1/repos/:repoId/external-credentials', { summary: 'Reconcile one external issuance without replaying its value',
      body: documentSchema, sensitive: true, idempotency: { strategy: 'external',
        authorization: c => [{ capability: 'tokens.manage', scope: { repo_id: c.req.param('repoId') } }],
        recover: async (c, record) => {
          const receipt = await one<{ request_hash: string }>(remote.binding(), 'SELECT request_hash FROM external_operations WHERE id=?', record.operation_id);
          if (!receipt || receipt.request_hash !== record.request_hash) return null;
          reconciled++;
          // Even an adapter returning the value again cannot expose or cache it.
          return c.json({ token: 'never-replay-this-one-time-value' }, 201);
        },
      },
    }, async c => {
      const request = c.get('idempotency')!;
      issued++;
      await remote.prepare("INSERT INTO external_operations VALUES (?,?,'completed')").bind(request.operation_id, request.request_hash).run();
      throw new ApiError(502, 'issuance_unconfirmed', 'The credential acknowledgement was lost.');
    });
    const credentialOptions = { path: '/v1/repos/r_repo/external-credentials' };
    expect((await credentialFixture.request('external-one-time', credentialOptions)).status).toBe(502);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await credentialFixture.request('external-one-time', credentialOptions);
      expect(response.status).toBe(409);
      const body = await response.text();
      expect(body).toContain('one_time_value_already_issued');
      expect(body).not.toContain('never-replay-this-one-time-value');
    }
    expect(issued).toBe(1);
    expect(reconciled).toBe(1);
    expect(await one(credentialFixture.env.DB, 'SELECT status,replayable,response_body,response_headers_json FROM idempotency_keys WHERE key=?', 'external-one-time'))
      .toEqual({ status: 'complete', replayable: 0, response_body: null, response_headers_json: '{}' });
  });
});

describe('published OpenAPI schema references', () => {
  it('namespaces recursive schemas and preserves binary, SCIM, and explicitly declared metadata', async () => {
    interface TextNode { value: string; next?: TextNode }
    interface NumberNode { value: number; next?: NumberNode }
    const text: z.ZodType<TextNode> = z.object({ value: z.string(), get next() { return text.optional(); } });
    const numeric: z.ZodType<NumberNode> = z.object({ value: z.number().int(), get next() { return numeric.optional(); } });
    const wrappedText = z.object({ default: text, state: z.string().default('draft') });
    const wrappedNumber = z.object({ enum: numeric });
    const binary = { description: 'Exact upload bytes', required: true,
      content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } };
    const uploaded = { description: 'Checksum verified', headers: { ETag: { schema: { type: 'string' } } },
      content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } };
    const scim = { description: 'SCIM resource envelope', content: { 'application/scim+json': {
      schema: { type: 'object', required: ['schemas'], properties: { schemas: { type: 'array', items: { type: 'string' } } } },
      example: { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], active: true },
    } } };
    const manualRecursive = { description: 'Recursive SCIM extension', required: true, content: { 'application/scim+json': {
      schema: { type: 'object', properties: { child: { $ref: '#/$defs/node' } }, $defs: {
        node: { type: 'object', properties: { parent: { $ref: '#' } } },
      } },
    } } };
    const app = new Hono<AppEnv>();
    route(app, 'POST', '/v1/schema-text', { summary: 'Text recursion', operationId: 'schema:text', body: wrappedText, response: wrappedText }, c => c.json({}));
    // These distinct operation IDs intentionally collide after component-name sanitization.
    route(app, 'POST', '/v1/schema-number', { summary: 'Numeric recursion', operationId: 'schema/text', body: wrappedNumber, response: numeric }, c => c.json({}));
    route(app, 'PUT', '/v1/blobs/:id', { summary: 'Upload bytes', streaming: true, requestBody: binary,
      responses: { '200': uploaded, '201': uploaded, '204': { description: 'No response body' } } }, c => c.json({}));
    route(app, 'POST', '/scim/v2/Users', { summary: 'SCIM extension', requestBody: manualRecursive,
      responses: { '200': scim, default: { $ref: '#/components/responses/Error' } } }, c => c.json({}));
    app.get('/openapi.json', c => c.json(openApiDocument(app)));
    const response = await app.request('https://api.gitknot.com/openapi.json');
    expect(response.status).toBe(200);
    const document = await response.json() as Record<string, unknown>;
    function target(reference: string): unknown {
      expect(reference).toMatch(/^#\//);
      let value: unknown = document;
      for (const token of decodeURIComponent(reference.slice(2)).split('/')) {
        const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
        expect(value).not.toBeNull();
        expect(Object.hasOwn(value as object, key), reference).toBe(true);
        value = (value as Record<string, unknown>)[key];
      }
      return value;
    }
    const values: unknown[] = [document];
    const references: string[] = [];
    while (values.length) {
      const value = values.pop();
      if (!value || typeof value !== 'object') continue;
      const reference = (value as { $ref?: unknown }).$ref;
      if (typeof reference === 'string' && reference.startsWith('#')) { references.push(reference); expect(target(reference)).toBeDefined(); }
      values.push(...Object.values(value));
    }
    expect(references.some(reference => reference.includes('/$defs/'))).toBe(true);
    type Schema = { $ref?: string; properties?: Record<string, Schema>; required?: string[]; type?: string };
    type Operation = { requestBody?: { content: Record<string, { schema: Schema }> }; responses: Record<string, { content?: Record<string, { schema: Schema }> }> };
    const paths = document.paths as Record<string, Record<string, Operation>>;
    const resolve = (schema: Schema): Schema => schema.$ref ? target(schema.$ref) as Schema : schema;
    const textOperation = paths['/v1/schema-text'].post;
    const input = resolve(textOperation.requestBody!.content['application/json'].schema);
    const output = resolve(textOperation.responses['200'].content!['application/json'].schema);
    const other = resolve(paths['/v1/schema-number'].post.requestBody!.content['application/json'].schema);
    expect(resolve(input.properties!.default).properties!.value.type).toBe('string');
    expect(resolve(other.properties!.enum).properties!.value.type).toBe('integer');
    expect(input.required).not.toContain('state');
    expect(output.required).toContain('state');
    const self = resolve(paths['/v1/schema-number'].post.responses['200'].content!['application/json'].schema);
    expect(target(self.properties!.next.$ref!)).toBe(self);
    expect(paths['/v1/blobs/{id}'].put.requestBody).toEqual(binary);
    expect(paths['/v1/blobs/{id}'].put.responses['200']).toEqual(uploaded);
    expect(paths['/v1/blobs/{id}'].put.responses['204']).toEqual({ description: 'No response body' });
    expect(paths['/scim/v2/Users'].post.responses['200']).toEqual(scim);
    const extension = resolve(paths['/scim/v2/Users'].post.requestBody!.content['application/scim+json'].schema);
    expect(target(resolve(extension.properties!.child).properties!.parent.$ref!)).toBe(extension);
    expect(manualRecursive.content['application/scim+json'].schema.properties.child.$ref).toBe('#/$defs/node');

    const invalid = new Hono<AppEnv>();
    route(invalid, 'GET', '/v1/broken', { summary: 'Invalid reference', responses: { default: { $ref: '#/components/responses/Missing' } } }, c => c.json({}));
    expect(() => openApiDocument(invalid)).toThrow('Unresolved local OpenAPI reference');
  });
});
