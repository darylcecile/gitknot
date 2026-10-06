import { createHash, createHmac, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { Context, Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { actionToken, authenticate, base64url, browserBoundary, canonicalJson, errorResponse, identityContext, newId, now, one, prepareCredential, requestContext, routeResourceRequest, sha256, stmt, verifyInternalRequest,
  type App, type AppEnv, type IdentityAction, type Repository, type UserRecord } from '../../packages/core/src/index.ts';
import { registerIdentityRoutes } from '../../apps/api/src/modules/identity.ts';
import { registerAccountRoutes } from '../../apps/api/src/modules/accounts.ts';
import { registerRepositoryRoutes } from '../../apps/api/src/modules/repositories.ts';
import { withAccountAuthorityBarriers } from '../../apps/api/src/modules/repositories/shared.ts';
import { completeOperation, failOperation, operationById, runLifecycle } from '../../packages/operations/src/lifecycle.ts';
import type { OperationsBindings } from '../../packages/operations/src/types.ts';
import { createTestEnvironment, type TestEnvironment } from '../support/environment.ts';
import { createTestDatabase } from '../support/database.ts';
import { PublicationJournal, type JournalStorage } from '../../packages/git/src/journal.ts';
import type { GitEvidence, GitOperation } from '../../packages/git/src/types.ts';
import { providerConfigSchema } from '../../packages/federation/src/config.ts';
import { FEDERATION_IDENTITY_CONTRACT } from '../../packages/federation/src/types.ts';
import { registerRepositoryPlacement, selectIdentityDatabase, withAccountAuthorityBarrier } from '../../packages/core/src/authority.ts';
import { alreadyHasSeat } from '../../apps/api/src/modules/accounts/billing.ts';
import { portableArchiveStream, type ArchiveManifest } from '../../packages/operations/src/archive.ts';

interface Harness extends TestEnvironment {
  app: App;
  native: { ready: boolean; calls: string[]; barriers: Map<string, string>; journal(repoId: string): PublicationJournal };
}
interface Person { id: string; username: string; email: string; password: string; cookie: string }
const fixtures: Harness[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

class JournalMemory implements JournalStorage {
  private records = new Map<string, unknown>();
  private tail: Promise<void> = Promise.resolve();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.records.get(key)) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.records.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.records.delete(key); }
  async transaction<T>(callback: (storage: JournalStorage) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    const snapshot = structuredClone(this.records);
    try { return await callback(this); }
    catch (error) { this.records = snapshot; throw error; }
    finally { release(); }
  }
}

async function setup(): Promise<Harness> {
  const fixture = await createTestEnvironment();
  fixture.env.IDENTITY_KEYS_JSON = JSON.stringify({ current: 'identity-test', keys: { 'identity-test': base64url(randomBytes(32)) } });
  const journals = new Map<string, PublicationJournal>();
  const native = { ready: false, calls: [] as string[], barriers: new Map<string, string>(), journal(repoId: string) {
    let journal = journals.get(repoId);
    if (!journal) { journal = new PublicationJournal(new JournalMemory()); journals.set(repoId, journal); }
    return journal;
  } };
  // Fault injection at the authenticated external storage boundary. The API,
  // credential engine, constraints, transactional outbox and lifecycle journal run unchanged.
  fixture.env.GIT_SERVICE = { fetch: async (request: Request) => {
    await verifyInternalRequest(request, fixture.env.INTERNAL_SERVICE_KEY, 'git-service');
    const path = new URL(request.url).pathname;
    native.calls.push(path);
    if (path.endsWith('/barrier')) {
      const body = await request.json() as { token: string; operation_id: string; issued_at?: number };
      const repoId = path.split('/').at(-2)!;
      try {
        if (request.method === 'DELETE') {
          const result = await native.journal(repoId).releaseBarrier(body.operation_id, await sha256(body.token));
          native.barriers.delete(path);
          return Response.json(result);
        }
        const issued = body.issued_at ?? Number(request.headers.get('x-gitknot-internal-time')) * 1000;
        const result = await native.journal(repoId).barrier({ operation_id: body.operation_id, token_hash: await sha256(body.token), reason: 'catalog',
          created_at: now(), acquire_before: new Date(issued + 120000).toISOString() });
        if (result.held) native.barriers.set(path, body.token);
        return Response.json(result, { status: result.held ? 200 : 409 });
      } catch (error) {
        const failure = error as { status?: number; code?: string };
        return Response.json({ error: { code: failure.code ?? 'test_barrier_failure' } }, { status: failure.status ?? 503 });
      }
    }
    if (path.endsWith('/provision')) return Response.json({ ready: true });
    if (path.endsWith('/verify')) return native.ready
      ? Response.json({ verified: true, objects_verified: true, refs: [] })
      : Response.json({ internal_provider_diagnostic: 'injected storage verification failure' }, { status: 503 });
    if (path.endsWith('/mutate')) {
      const body = await request.json() as { operation_id: string };
      return Response.json({ state: 'committed', finalized: true, result: { outcome: 'committed', operation_id: body.operation_id } });
    }
    if (path.endsWith('/copy-lfs')) return Response.json({ next_cursor: null });
    return Response.json({ error: { code: 'test_native_endpoint_missing' } }, { status: 503 });
  } } as unknown as Fetcher;
  const freeSeatAdmission = { fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (!path.endsWith('/fixed-cost')) return Response.json({ error: { code: 'test_admission_unconfigured' } }, { status: 503 });
    await verifyInternalRequest(request, fixture.env.INTERNAL_SERVICE_KEY, 'billing:account:fixed-cost');
    const body = await request.json() as { amount_units: string };
    if (body.amount_units !== '0') return Response.json({ error: { code: 'test_accepts_only_zero_cost_seats' } }, { status: 503 });
    return Response.json({ commitment_units: '0' });
  } } as unknown as Fetcher;
  fixture.env.ADMISSION = { idFromName: (name: string) => ({ toString: () => name }), get: () => freeSeatAdmission } as unknown as DurableObjectNamespace;
  const app = new Hono<AppEnv>();
  app.onError(errorResponse);
  app.use('*', requestContext);
  app.use('/v1/*', browserBoundary);
  app.use('/v1/*', async (c, next) => {
    const forwarded = await routeResourceRequest(c);
    if (forwarded) return forwarded;
    await next();
  });
  app.use('/v1/*', identityContext);
  registerIdentityRoutes(app);
  registerAccountRoutes(app);
  registerRepositoryRoutes(app);
  const result = { ...fixture, app, native };
  fixtures.push(result);
  return result;
}

function request(fixture: Harness, path: string, options: { method?: string; body?: unknown; cookie?: string; token?: string; revision?: number; key?: string; origin?: string } = {}): Promise<Response> {
  return fixture.app.fetch(new Request(`${fixture.env.API_ORIGIN}${path}`, {
    method: options.method ?? 'GET', headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.cookie ? { cookie: options.cookie, 'x-gitknot-csrf': '1' } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.revision === undefined ? {} : { 'if-match': `"${options.revision}"` }),
      ...(options.key ? { 'idempotency-key': options.key } : {}),
      origin: options.origin ?? fixture.env.APP_ORIGIN,
    }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }), fixture.env, fixture.context) as Promise<Response>;
}

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const value = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(status);
  return value as T;
}
function cookie(response: Response): string {
  const value = response.headers.get('set-cookie');
  expect(value).toContain('HttpOnly');
  return value!.split(';')[0]!;
}
async function action(fixture: Harness, userId: string, purpose: IdentityAction['purpose']): Promise<string> {
  const record = await one<IdentityAction>(fixture.env.DB, 'SELECT * FROM identity_actions WHERE user_id=? AND purpose=? AND consumed_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 1', userId, purpose);
  expect(record).not.toBeNull();
  return actionToken(fixture.env, { ...record!, key_id: record!.key_id! });
}
async function person(fixture: Harness, username: string): Promise<Person> {
  const email = `${username}@example.net`;
  const password = 'A long independent test passphrase.';
  await json(await request(fixture, '/v1/auth/signup', { method: 'POST', body: { username, email, password } }), 202);
  const user = (await one<UserRecord>(fixture.env.DB, 'SELECT * FROM users WHERE username=?', username))!;
  expect(user.password_hash).toMatch(/^\$scrypt\$16384\$8\$5\$/);
  expect(user.password_hash).not.toContain(password);
  await json(await request(fixture, '/v1/auth/verify', { method: 'POST', body: { token: await action(fixture, user.id, 'verify_email') } }), 200);
  const signedIn = await request(fixture, '/v1/auth/login', { method: 'POST', body: { login: username, password } });
  await json(signedIn, 200);
  return { id: user.id, username, email, password, cookie: cookie(signedIn) };
}
async function currentRevision(fixture: Harness, user: Person): Promise<number> {
  return (await json<{ revision: number }>(await request(fixture, '/v1/me', { cookie: user.cookie }), 200)).revision;
}

async function primaryContext(fixture: Harness, user: Person) {
  const context = new Context<AppEnv>(new Request(`${fixture.env.API_ORIGIN}/v1/test-fixture`, { method: 'POST' }), { env: fixture.env });
  context.set('principal', await authenticate(new Request(`${fixture.env.API_ORIGIN}/v1/me`, { headers: { cookie: user.cookie } }), fixture.env));
  context.set('requestId', newId('req'));
  selectIdentityDatabase(context);
  return context;
}

async function inviteAndAccept(fixture: Harness, owner: Person, recipient: Person, path: string, roleId = 'reader'): Promise<void> {
  const invitation = await json<{ id: string; revision: number }>(await request(fixture, path, { method: 'POST', cookie: owner.cookie,
    body: { email: recipient.email, role_id: roleId } }), 201);
  const row = (await one<{ key_id: string; expires_at: string }>(fixture.env.DB, 'SELECT key_id,expires_at FROM invitations WHERE id=?', invitation.id))!;
  const token = await actionToken(fixture.env, { ...row, id: invitation.id, purpose: 'invitation' });
  const preview = await json<{ seat_quote: { subscription_revision: number; plan_id: string; monthly_delta_units: string; maximum_current_period_units: string } }>(
    await request(fixture, `/v1/invitations/${invitation.id}`, { cookie: recipient.cookie }), 200);
  await json(await request(fixture, `/v1/invitations/${invitation.id}/accept`, { method: 'POST', cookie: recipient.cookie, revision: invitation.revision,
    body: { token, seat_quote: { subscription_revision: preview.seat_quote.subscription_revision, plan_id: preview.seat_quote.plan_id,
      maximum_monthly_units: preview.seat_quote.monthly_delta_units, maximum_current_period_units: preview.seat_quote.maximum_current_period_units } } }), 200);
}
async function provision(fixture: Harness, operationId: string): Promise<void> {
  const env = fixture.env as OperationsBindings;
  const operation = await operationById(env, operationId);
  const step = { do: async <T>(_name: string, _options: unknown, run: () => Promise<T>) => run() };
  try { await completeOperation(env, operation, await runLifecycle(env, operation, step)); }
  catch (error) { await failOperation(env, operation.id, error); throw error; }
}

async function verifiedExport(fixture: Harness, repository: Repository, sourceId: string, exported: { id: string; operation: { id: string } }): Promise<void> {
  const archiveId = newId('arc');
  const timestamp = now();
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const prefix = `${repository.owner_id}/${repository.id}/archives/${archiveId}`;
  const data = new TextEncoder().encode(canonicalJson([{ repo_id: repository.id, head_repo_id: sourceId, body: 'Restricted historical patch contents' }]));
  const part = { path: 'metadata/pull_patches/00000000.json', object_key: `${prefix}/metadata/pull_patches/00000000.json`,
    bucket: 'BACKUPS' as const, bytes: data.byteLength, sha256: await sha256(data), media_type: 'application/json' };
  const manifest: ArchiveManifest = { format: 'gitknot.repository', version: 1, archive_id: archiveId, created_at: timestamp,
    repository, tables: ['pull_patches'], parts: [part], audience_repo_ids: [repository.id, sourceId].sort(),
    privacy: { version: 1, private_user_state: 'excluded' },
    git: { encoding: 'empty', parts_prefix: 'git/', refs: [], sha256: await sha256(new Uint8Array()), bytes: 0 }, exclusions: [] };
  const manifestBytes = new TextEncoder().encode(canonicalJson(manifest));
  await fixture.env.BACKUPS.put(part.object_key, data);
  await fixture.env.BACKUPS.put(`${prefix}/manifest.json`, manifestBytes);
  const portable = await new Response(portableArchiveStream(fixture.env as OperationsBindings, manifest, async () => {})).arrayBuffer();
  const checksum = await sha256(new Uint8Array(portable));
  // This verified worker fixture contains only shared patch data, with the
  // producer's privacy classification; all archive integrity,
  // audience authorization and subsequent stream reads use production code.
  await fixture.env.DB.batch([
    stmt(fixture.env.DB, `INSERT INTO repository_archives(id,operation_id,repo_id,account_id,kind,state,routing_epoch,revision,created_at,expires_at)
      VALUES (?,?,?,?,'export','writing',?,1,?,?)`, archiveId, exported.operation.id, repository.id, repository.owner_id, repository.routing_epoch, timestamp, expiresAt),
    ...manifest.audience_repo_ids.map(id => stmt(fixture.env.DB, 'INSERT INTO archive_audiences(archive_id,repository_id,created_at) VALUES (?,?,?)', archiveId, id, timestamp)),
    stmt(fixture.env.DB, 'INSERT INTO archive_parts(archive_id,path,object_key,bucket,sha256,bytes,media_type) VALUES (?,?,?,?,?,?,?)', archiveId, part.path, part.object_key, part.bucket, part.sha256, part.bytes, part.media_type),
    stmt(fixture.env.DB, `UPDATE repository_archives SET state='verified',manifest_key=?,manifest_sha256=?,archive_sha256=?,audience_sha256=?,bytes=?,verified_at=? WHERE id=?`,
      `${prefix}/manifest.json`, await sha256(manifestBytes), checksum, await sha256(canonicalJson(manifest.audience_repo_ids)), portable.byteLength, timestamp, archiveId),
    stmt(fixture.env.DB, "UPDATE repository_exports SET state='completed',checksum_sha256=?,size_bytes=?,completed_at=?,revision=revision+1 WHERE id=?", checksum, portable.byteLength, timestamp, exported.id),
    stmt(fixture.env.DB, "UPDATE operations SET status='completed',phase='completed',completed_at=?,updated_at=?,revision=revision+1 WHERE id=?", timestamp, timestamp, exported.operation.id),
    stmt(fixture.env.DB, "UPDATE repository_lifecycle SET state='completed',updated_at=? WHERE operation_id=?", timestamp, exported.operation.id),
  ]);
}

async function publishing(fixture: Harness, repoId: string, person: Person): Promise<() => Promise<void>> {
  const repo = (await one<Repository>(fixture.env.DB, 'SELECT * FROM repositories WHERE id=?', repoId))!;
  const actor = (await authenticate(new Request(`${fixture.env.API_ORIGIN}/v1/me`, { headers: { cookie: person.cookie } }), fixture.env))!;
  const id = newId('gitop');
  const evidence: GitEvidence = { version: 1, updates: [], supplied_objects: 0, supplied_bytes: 0,
    policy_revision: repo.policy_revision, digest: 'a'.repeat(64), marker_oid: 'b'.repeat(40) };
  const operation: GitOperation = { id, repo_id: repo.id, repository: repo, actor, kind: 'push', state: 'receiving',
    routing_epoch: repo.routing_epoch, policy_revision: repo.policy_revision, publisher_id: 'native-test-publisher', fence_hash: 'c'.repeat(64),
    created_at: now(), updated_at: now(), deadline_at: new Date(Date.now() + 60000).toISOString(), finalized: false };
  const journal = fixture.native.journal(repo.id);
  await journal.open(operation);
  await journal.validated(id, operation.publisher_id, evidence);
  await journal.publishing(id, operation.publisher_id, evidence.digest);
  return async () => {
    await journal.result(id, { operation_id: id, outcome: 'committed', refs: [], marker_oid: evidence.marker_oid, report_status: [], proof: 'marker' });
    await journal.finalized(id);
  };
}

function totp(secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let buffer = 0, bits = 0;
  const bytes: number[] = [];
  for (const character of secret) {
    buffer = (buffer << 5) | alphabet.indexOf(character); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((buffer >>> bits) & 255); }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  return ((new DataView(mac.buffer, mac.byteOffset, mac.byteLength).getUint32(mac.at(-1)! & 15) & 0x7fff_ffff) % 1_000_000).toString().padStart(6, '0');
}

// Wire-format virtual authenticator: real P-256 signatures are verified by the
// production WebAuthn library, including RP ID, origin, UV, challenge and counter.
function cbor(value: number | string | Uint8Array | Map<unknown, unknown>): Buffer {
  const header = (major: number, length: number) => length < 24 ? Buffer.from([major * 32 + length])
    : length < 256 ? Buffer.from([major * 32 + 24, length]) : Buffer.from([major * 32 + 25, length >>> 8, length & 255]);
  if (typeof value === 'number') return header(value < 0 ? 1 : 0, value < 0 ? -value - 1 : value);
  if (typeof value === 'string') { const bytes = Buffer.from(value); return Buffer.concat([header(3, bytes.length), bytes]); }
  if (value instanceof Uint8Array) return Buffer.concat([header(2, value.length), value]);
  return Buffer.concat([header(5, value.size), ...Array.from(value).flatMap(([key, item]) => [cbor(key as Parameters<typeof cbor>[0]), cbor(item as Parameters<typeof cbor>[0])])]);
}
function virtualAuthenticator(origin: string) {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = keys.publicKey.export({ format: 'jwk' });
  const id = randomBytes(32);
  const rpHash = createHash('sha256').update(new URL(origin).hostname).digest();
  const credential = cbor(new Map<unknown, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]));
  const data = (type: string, challenge: string, actualOrigin: string) => Buffer.from(JSON.stringify({ type, challenge, origin: actualOrigin, crossOrigin: false }));
  const authData = (flags: number, counter: number) => { const count = Buffer.alloc(4); count.writeUInt32BE(counter); return Buffer.concat([rpHash, Buffer.from([flags]), count]); };
  const envelope = { id: base64url(id), rawId: base64url(id), type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'cross-platform' };
  return {
    registration(challenge: string) {
      const length = Buffer.alloc(2); length.writeUInt16BE(id.length);
      const authenticatorData = Buffer.concat([authData(0x45, 0), Buffer.alloc(16), length, id, credential]);
      return { ...envelope, response: { clientDataJSON: data('webauthn.create', challenge, origin).toString('base64url'),
        attestationObject: base64url(cbor(new Map<unknown, unknown>([['fmt', 'none'], ['authData', authenticatorData], ['attStmt', new Map()]]))), transports: ['usb'] } };
    },
    assertion(challenge: string, userId: string, counter: number, actualOrigin = origin, privateKey: KeyObject = keys.privateKey) {
      const clientData = data('webauthn.get', challenge, actualOrigin);
      const authenticatorData = authData(0x05, counter);
      const signature = sign('sha256', Buffer.concat([authenticatorData, createHash('sha256').update(clientData).digest()]), privateKey);
      return { ...envelope, response: { clientDataJSON: clientData.toString('base64url'), authenticatorData: authenticatorData.toString('base64url'),
        signature: base64url(signature), userHandle: Buffer.from(userId).toString('base64url') } };
    },
  };
}

describe('GitKnot identity, account authorization and repository HTTP journeys', () => {
  it('enrolls MFA, rejects factor replay, and keeps password recovery behind the second factor', async () => {
    const fixture = await setup();
    const user = await person(fixture, 'identity-alice');
    const beforeMfa = user.cookie;
    const setupFactor = await json<{ secret: string; revision: number }>(await request(fixture, '/v1/auth/mfa/totp/setup', {
      method: 'POST', body: {}, cookie: user.cookie, revision: await currentRevision(fixture, user),
    }), 200);
    const code = totp(setupFactor.secret);
    const enrollmentResponse = await request(fixture, '/v1/auth/mfa/totp/verify', { method: 'POST', cookie: user.cookie,
      revision: setupFactor.revision, body: { code } });
    const enrollment = await json<{ recovery_codes: string[] }>(enrollmentResponse, 200);
    user.cookie = cookie(enrollmentResponse);
    expect((await request(fixture, '/v1/me', { cookie: beforeMfa })).status).toBe(401);
    const challenge = await json<{ token: string }>(await request(fixture, '/v1/auth/login', { method: 'POST', body: { login: user.email, password: user.password } }), 202);
    expect((await request(fixture, '/v1/auth/login/mfa', { method: 'POST', body: { token: challenge.token, code } })).status).toBe(401);
    await json(await request(fixture, '/v1/auth/login/mfa', { method: 'POST', body: { token: challenge.token, recovery_code: enrollment.recovery_codes[0] } }), 200);
    expect((await request(fixture, '/v1/auth/login/mfa', { method: 'POST', body: { token: challenge.token, recovery_code: enrollment.recovery_codes[1] } })).status).toBe(400);
    await json(await request(fixture, '/v1/auth/recover', { method: 'POST', body: { email: user.email } }), 202);
    const recoveryToken = await action(fixture, user.id, 'recover_password');
    const replacement = 'A different sufficiently long passphrase.';
    expect((await request(fixture, '/v1/auth/reset', { method: 'POST', body: { token: recoveryToken, password: replacement } })).status).toBe(401);
    await json(await request(fixture, '/v1/auth/reset', { method: 'POST', body: { token: recoveryToken, password: replacement, recovery_code: enrollment.recovery_codes[1] } }), 200);
    expect((await request(fixture, '/v1/me', { cookie: user.cookie })).status).toBe(401);
    expect((await request(fixture, '/v1/auth/reset', { method: 'POST', body: { token: recoveryToken, password: replacement, recovery_code: enrollment.recovery_codes[2] } })).status).toBe(400);
    expect((await one<UserRecord>(fixture.env.DB, 'SELECT * FROM users WHERE id=?', user.id))!.mfa_required).toBe(1);
    const stored = fixture.db.sqlite.prepare('SELECT * FROM user_mfa').all();
    const events = fixture.db.sqlite.prepare('SELECT event_json FROM outbox').all();
    expect(JSON.stringify(stored)).not.toContain(setupFactor.secret);
    expect(JSON.stringify(events)).not.toContain(recoveryToken);
    expect(JSON.stringify(fixture.db.sqlite.prepare('SELECT * FROM recovery_codes').all())).not.toContain(enrollment.recovery_codes[0]);
  });

  it('registers and authenticates a real passkey assertion while rejecting wrong origins and stale counters', async () => {
    const fixture = await setup();
    const user = await person(fixture, 'passkey-alice');
    const authenticator = virtualAuthenticator(fixture.env.APP_ORIGIN);
    const start = await json<{ token: string; options: { challenge: string } }>(await request(fixture, '/v1/auth/passkeys/registration/options', {
      method: 'POST', cookie: user.cookie, body: { name: 'Security key' },
    }), 200);
    const registeredResponse = await request(fixture, '/v1/auth/passkeys/registration/verify', { method: 'POST', cookie: user.cookie,
      revision: await currentRevision(fixture, user), body: { token: start.token, response: authenticator.registration(start.options.challenge) } });
    await json(registeredResponse, 201);
    user.cookie = cookie(registeredResponse);
    const options = async () => json<{ token: string; options: { challenge: string } }>(await request(fixture, '/v1/auth/passkeys/authentication/options', { method: 'POST', body: {} }), 200);
    const login = await options();
    const badOrigin = await request(fixture, '/v1/auth/passkeys/authentication/verify', { method: 'POST', body: {
      token: login.token, response: authenticator.assertion(login.options.challenge, user.id, 1, 'https://wrong-origin.example'),
    } });
    expect(badOrigin.status).toBe(401);
    const signedIn = await request(fixture, '/v1/auth/passkeys/authentication/verify', { method: 'POST', body: {
      token: login.token, response: authenticator.assertion(login.options.challenge, user.id, 1),
    } });
    expect(await json(signedIn, 200)).toMatchObject({ session: { mfa: true } });
    const replay = await options();
    expect((await request(fixture, '/v1/auth/passkeys/authentication/verify', { method: 'POST', body: {
      token: replay.token, response: authenticator.assertion(replay.options.challenge, user.id, 1),
    } })).status).toBe(401);
    const me = await json(await request(fixture, '/v1/me', { cookie: cookie(signedIn) }), 200);
    expect(me).toMatchObject({ id: user.id, mfa_required: true });
  });

  it('consumes invitation seat reservations and preserves a recoverable owner under deny and removal races', async () => {
    const fixture = await setup();
    const alice = await person(fixture, 'owner-alice');
    const bob = await person(fixture, 'owner-bob');
    const organization = await json<{ id: string }>(await request(fixture, '/v1/orgs', { method: 'POST', cookie: alice.cookie,
      body: { slug: 'identity-org', name: 'Identity organization' }, key: 'create-org' }), 201);
    const internal = await json<{ id: string; operation: { id: string } }>(await request(fixture, '/v1/repos', { method: 'POST', cookie: alice.cookie,
      body: { owner_id: organization.id, name: 'internal-project', visibility: 'internal' } }), 202);
    fixture.native.ready = true;
    await provision(fixture, internal.operation.id);
    expect((await request(fixture, `/v1/repos/${internal.id}`)).status).toBe(404);
    expect((await request(fixture, `/v1/repos/${internal.id}`, { cookie: alice.cookie })).status).toBe(200);
    const invitation = await json<{ id: string; revision: number }>(await request(fixture, `/v1/orgs/${organization.id}/invitations`, { method: 'POST', cookie: alice.cookie,
      body: { email: bob.email, role_id: 'owner' }, key: 'invite-bob' }), 201);
    const row = (await one<{ key_id: string; expires_at: string }>(fixture.env.DB, 'SELECT key_id,expires_at FROM invitations WHERE id=?', invitation.id))!;
    const token = await actionToken(fixture.env, { id: invitation.id, purpose: 'invitation', ...row });
    const preview = await json<{ seat_quote: { subscription_revision: number; plan_id: string; monthly_delta_units: string; maximum_current_period_units: string } }>(
      await request(fixture, `/v1/invitations/${invitation.id}`, { cookie: bob.cookie }), 200);
    await json(await request(fixture, `/v1/invitations/${invitation.id}/accept`, { method: 'POST', cookie: bob.cookie, revision: invitation.revision,
      body: { token, seat_quote: { subscription_revision: preview.seat_quote.subscription_revision, plan_id: preview.seat_quote.plan_id,
        maximum_monthly_units: preview.seat_quote.monthly_delta_units, maximum_current_period_units: preview.seat_quote.maximum_current_period_units } } }), 200);
    expect(await one(fixture.env.DB, 'SELECT seat_count FROM billing_accounts WHERE account_id=?', organization.id)).toEqual({ seat_count: 2 });
    const outsider = await person(fixture, 'unadmitted-outsider');
    expect((await request(fixture, `/v1/accounts/${organization.id}/grants`, { method: 'POST', cookie: alice.cookie,
      body: { principal_type: 'user', principal_id: outsider.id, role_id: 'reader' } })).status).toBe(422);
    const primary = await primaryContext(fixture, alice);
    // A historical/unpaid grant is not evidence that billing allocated a seat.
    await withAccountAuthorityBarrier(primary, organization.id, 'legacy-fixture', async () => {
      await stmt(fixture.env.DB, `INSERT INTO access_grants(id,account_id,principal_type,principal_id,role_id,created_by,created_at,updated_at)
        VALUES (?,?, 'user',?,'reader',?,?,?)`, newId('grant'), organization.id, outsider.id, alice.id, now(), now()).run();
    });
    expect(await alreadyHasSeat(primary, organization.id, outsider.id)).toBe(false);
    expect((await request(fixture, `/v1/repos/${internal.id}`, { cookie: outsider.cookie })).status).toBe(404);
    const outsiderInvitation = await json<{ seat_quote: { additional_seats: number } }>(await request(fixture, `/v1/orgs/${organization.id}/invitations`, {
      method: 'POST', cookie: alice.cookie, body: { email: outsider.email, role_id: 'member' },
    }), 201);
    expect(outsiderInvitation.seat_quote.additional_seats).toBe(1);
    const team = await json<{ id: string }>(await request(fixture, `/v1/orgs/${organization.id}/teams`, { method: 'POST', cookie: bob.cookie,
      body: { slug: 'denied-team', name: 'Denied team' } }), 201);
    const teamDeny = await json<{ id: string; revision: number }>(await request(fixture, `/v1/accounts/${organization.id}/grants`, { method: 'POST', cookie: alice.cookie,
      body: { principal_type: 'team', principal_id: team.id, capability: '*', effect: 'deny' } }), 201);
    expect((await request(fixture, `/v1/orgs/${organization.id}/teams/${team.id}/members`, { method: 'POST', cookie: alice.cookie,
      body: { principal_id: alice.id } })).status).toBe(409);
    expect(await one(fixture.env.DB, 'SELECT 1 FROM team_members WHERE team_id=? AND principal_id=?', team.id, alice.id)).toBeNull();
    const deny = await json<{ id: string; revision: number }>(await request(fixture, `/v1/accounts/${organization.id}/grants`, { method: 'POST', cookie: alice.cookie,
      body: { principal_type: 'user', principal_id: bob.id, capability: '*', effect: 'deny' } }), 201);
    const lockout = await request(fixture, `/v1/accounts/${organization.id}/grants`, { method: 'POST', cookie: alice.cookie,
      body: { principal_type: 'user', principal_id: alice.id, capability: '*', effect: 'deny' } });
    expect(lockout.status).toBe(409);
    expect((await request(fixture, '/v1/me', { method: 'DELETE', cookie: alice.cookie, revision: await currentRevision(fixture, alice) })).status).toBe(409);
    expect(await one(fixture.env.DB, 'SELECT disabled_at FROM users WHERE id=?', alice.id)).toEqual({ disabled_at: null });
    expect((await request(fixture, `/v1/accounts/${organization.id}/grants/${deny.id}`, { method: 'DELETE', cookie: alice.cookie, revision: deny.revision })).status).toBe(204);
    expect((await request(fixture, `/v1/accounts/${organization.id}/grants/${teamDeny.id}`, { method: 'DELETE', cookie: alice.cookie, revision: teamDeny.revision })).status).toBe(204);
    const responses = await Promise.all([
      request(fixture, `/v1/orgs/${organization.id}/members/${bob.id}`, { method: 'DELETE', cookie: alice.cookie, revision: 1 }),
      request(fixture, `/v1/orgs/${organization.id}/members/${alice.id}`, { method: 'DELETE', cookie: bob.cookie, revision: 1 }),
    ]);
    expect(responses.map(response => response.status).filter(status => status === 204)).toHaveLength(1);
    const owners = fixture.db.sqlite.prepare("SELECT principal_id FROM memberships WHERE account_id=? AND role_id='owner' AND state='active'").all(organization.id) as { principal_id: string }[];
    expect(owners).toHaveLength(1);
    const survivor = owners[0]!.principal_id === alice.id ? alice : bob;
    expect((await request(fixture, `/v1/orgs/${organization.id}/members/${survivor.id}`, { method: 'DELETE', cookie: survivor.cookie, revision: 1 })).status).toBe(409);
    expect(await one(fixture.env.DB, 'SELECT seat_count FROM billing_accounts WHERE account_id=?', organization.id)).toEqual({ seat_count: 1 });
    expect(await one(fixture.env.DB, 'SELECT 1 FROM account_policy_barriers WHERE account_id=?', organization.id)).toBeNull();
  });

  it('keeps provisioning honest, enforces token and fork boundaries, and protects repository revisions', async () => {
    const fixture = await setup();
    const alice = await person(fixture, 'catalog-alice');
    const bob = await person(fixture, 'catalog-bob');
    const create = { owner_id: alice.id, name: 'private-source', visibility: 'private' };
    const repository = await json<{ id: string; revision: number; state: string; operation: { id: string } }>(await request(fixture, '/v1/repos', {
      method: 'POST', cookie: alice.cookie, body: create, key: 'source-repository',
    }), 202);
    expect(repository.state).toBe('provisioning');
    expect(fixture.native.calls).toHaveLength(0);
    expect((await request(fixture, `/v1/repos/${repository.id}`, { cookie: bob.cookie })).status).toBe(404);
    await expect(provision(fixture, repository.operation.id)).rejects.toThrow();
    expect((await one<Repository>(fixture.env.DB, 'SELECT * FROM repositories WHERE id=?', repository.id))!.state).toBe('provisioning');
    fixture.native.ready = true;
    await provision(fixture, repository.operation.id);
    expect(fixture.native.calls.filter(path => path.endsWith('/provision'))).toHaveLength(1);
    const catalog = await json<{ revision: number }>(await request(fixture, `/v1/repos/${repository.id}`, { cookie: alice.cookie }), 200);
    expect(JSON.stringify(catalog)).not.toMatch(/storage_name|cell_id|shard_id|namespace|provider/i);
    expect((await request(fixture, `/v1/repos/${repository.id}`, { method: 'PATCH', cookie: alice.cookie, revision: 1, body: { name: 'stale-name' } })).status).toBe(412);
    const renamed = await json<{ id: string; revision: number }>(await request(fixture, `/v1/repos/${repository.id}`, { method: 'PATCH', cookie: alice.cookie,
      revision: catalog.revision, body: { name: 'renamed-source' } }), 200);
    expect(renamed.id).toBe(repository.id);
    const viewerBody = { name: 'Viewer', kind: 'viewer', capabilities: ['contents.read', 'repositories.read'], repository_ids: [repository.id],
      expires_at: new Date(Date.now() + 3600_000).toISOString() };
    const oldViewer = await json<{ id: string; revision: number }>(await request(fixture, '/v1/tokens', { method: 'POST', cookie: alice.cookie, body: viewerBody }), 201);
    const readDeny = await json<{ id: string; revision: number }>(await request(fixture, `/v1/repos/${repository.id}/collaborators`, { method: 'POST', cookie: alice.cookie,
      body: { principal_type: 'user', principal_id: alice.id, capability: 'contents.read', effect: 'deny' } }), 201);
    expect((await request(fixture, '/v1/tokens', { method: 'POST', cookie: alice.cookie, body: viewerBody })).status).toBe(403);
    expect((await request(fixture, `/v1/tokens/${oldViewer.id}/rotate`, { method: 'POST', cookie: alice.cookie, revision: oldViewer.revision, body: {} })).status).toBe(403);
    expect((await request(fixture, `/v1/repos/${repository.id}/collaborators/${readDeny.id}`, { method: 'DELETE', cookie: alice.cookie, revision: readDeny.revision })).status).toBe(204);
    const readonly = await json<{ token: string }>(await request(fixture, '/v1/tokens', { method: 'POST', cookie: alice.cookie,
      body: { name: 'Read-only repository token', capabilities: ['contents.read'], repository_ids: [repository.id], expires_at: new Date(Date.now() + 3600_000).toISOString() } }), 201);
    const spareResponse = await request(fixture, '/v1/auth/login', { method: 'POST', body: { login: alice.username, password: alice.password } });
    const spare = await json<{ session: { id: string } }>(spareResponse, 200);
    expect((await request(fixture, '/v1/auth/sessions', { token: readonly.token })).status).toBe(403);
    expect((await request(fixture, `/v1/auth/sessions/${spare.session.id}`, { method: 'DELETE', token: readonly.token, revision: 1 })).status).toBe(403);
    expect((await request(fixture, '/v1/me', { cookie: cookie(spareResponse) })).status).toBe(200);
    const sessionAdmin = await json<{ token: string }>(await request(fixture, '/v1/tokens', { method: 'POST', cookie: alice.cookie,
      body: { name: 'Session administration', capabilities: ['tokens.read', 'tokens.revoke'], account_ids: [alice.id], expires_at: new Date(Date.now() + 3600_000).toISOString() } }), 201);
    expect((await request(fixture, '/v1/auth/sessions', { token: sessionAdmin.token })).status).toBe(200);
    expect((await request(fixture, `/v1/auth/sessions/${spare.session.id}`, { method: 'DELETE', token: sessionAdmin.token, revision: 1 })).status).toBe(204);
    const token = await json<{ id: string; token: string; revision: number }>(await request(fixture, '/v1/tokens', { method: 'POST', cookie: alice.cookie,
      body: { name: 'Scoped source writer', capabilities: ['contents.read', 'repositories.read', 'contents.push'], repository_ids: [repository.id],
        ref_patterns: ['refs/heads/automation/**'], path_patterns: ['src/**'], expires_at: new Date(Date.now() + 3600_000).toISOString() } }), 201);
    expect((await request(fixture, `/v1/repos/${repository.id}`, { token: token.token })).status).toBe(200);
    const allowed = await json(await request(fixture, `/v1/repos/${repository.id}/permissions/explain`, { method: 'POST', token: token.token,
      body: { capability: 'contents.push', ref: 'refs/heads/automation/update', paths: ['src/dependencies.ts'] } }), 200);
    expect(allowed.allowed).toBe(true);
    const deniedPath = await json(await request(fixture, `/v1/repos/${repository.id}/permissions/explain`, { method: 'POST', token: token.token,
      body: { capability: 'contents.push', ref: 'refs/heads/automation/update', paths: ['src/dependencies.ts', 'secrets/key.txt'] } }), 200);
    expect(deniedPath.allowed).toBe(false);
    const deniedRef = await json(await request(fixture, `/v1/repos/${repository.id}/permissions/explain`, { method: 'POST', token: token.token,
      body: { capability: 'contents.push', ref: 'refs/heads/main', paths: ['src/dependencies.ts'] } }), 200);
    expect(deniedRef.allowed).toBe(false);
    const publicRepo = await json<{ id: string; operation: { id: string } }>(await request(fixture, '/v1/repos', { method: 'POST', cookie: bob.cookie,
      body: { owner_id: bob.id, name: 'public-project', visibility: 'public' } }), 202);
    await provision(fixture, publicRepo.operation.id);
    expect((await request(fixture, `/v1/repos/${publicRepo.id}`)).status).toBe(200);
    expect((await request(fixture, `/v1/repos/${publicRepo.id}`, { token: token.token })).status).toBe(404);
    const invitation = await json<{ id: string; revision: number }>(await request(fixture, `/v1/repos/${repository.id}/invitations`, { method: 'POST', cookie: alice.cookie,
      body: { email: bob.email, role_id: 'reader' } }), 201);
    const invitationRow = (await one<{ key_id: string; expires_at: string }>(fixture.env.DB, 'SELECT key_id,expires_at FROM invitations WHERE id=?', invitation.id))!;
    const inviteToken = await actionToken(fixture.env, { id: invitation.id, purpose: 'invitation', ...invitationRow });
    const preview = await json<{ seat_quote: { subscription_revision: number; plan_id: string; monthly_delta_units: string; maximum_current_period_units: string } }>(await request(fixture, `/v1/invitations/${invitation.id}`, { cookie: bob.cookie }), 200);
    await json(await request(fixture, `/v1/invitations/${invitation.id}/accept`, { method: 'POST', cookie: bob.cookie, revision: invitation.revision,
      body: { token: inviteToken, seat_quote: { subscription_revision: preview.seat_quote.subscription_revision, plan_id: preview.seat_quote.plan_id,
        maximum_monthly_units: preview.seat_quote.monthly_delta_units, maximum_current_period_units: preview.seat_quote.maximum_current_period_units } } }), 200);
    const fork = await json<{ id: string; visibility: string; operation: { id: string } }>(await request(fixture, '/v1/repos', { method: 'POST', cookie: bob.cookie,
      body: { owner_id: bob.id, name: 'private-workspace', fork_source_id: repository.id } }), 202);
    expect(fork.visibility).toBe('private');
    await provision(fixture, fork.operation.id);
    expect((await request(fixture, `/v1/repos/${fork.id}`, { cookie: bob.cookie })).status).toBe(200);
    const grant = (await one<{ id: string; revision: number }>(fixture.env.DB, "SELECT id,revision FROM access_grants WHERE repo_id=? AND principal_id=? AND effect='allow' AND revoked_at IS NULL", repository.id, bob.id))!;
    const finishPublishing = await publishing(fixture, repository.id, alice);
    expect((await request(fixture, `/v1/repos/${repository.id}/collaborators/${grant.id}`, { method: 'DELETE', cookie: alice.cookie, revision: grant.revision })).status).toBe(409);
    expect((await request(fixture, `/v1/repos/${fork.id}`, { cookie: bob.cookie })).status).toBe(200);
    expect(await one(fixture.env.DB, 'SELECT revoked_at FROM access_grants WHERE id=?', grant.id)).toEqual({ revoked_at: null });
    await finishPublishing();
    expect((await request(fixture, `/v1/repos/${repository.id}/collaborators/${grant.id}`, { method: 'DELETE', cookie: alice.cookie, revision: grant.revision })).status).toBe(204);
    expect((await request(fixture, `/v1/repos/${fork.id}`, { cookie: bob.cookie })).status).toBe(404);
    const unlisted = await json<{ id: string; operation: { id: string } }>(await request(fixture, '/v1/repos', { method: 'POST', cookie: alice.cookie,
      body: { owner_id: alice.id, name: 'unlisted-project', visibility: 'unlisted' } }), 202);
    await provision(fixture, unlisted.operation.id);
    expect((await request(fixture, `/v1/repos/${unlisted.id}`)).status).toBe(200);
    const directory = await json<{ items: { id: string }[] }>(await request(fixture, '/v1/repos'), 200);
    expect(directory.items.map(item => item.id)).not.toContain(unlisted.id);
    expect(directory.items.map(item => item.id)).not.toContain(repository.id);
    const filteredIds = async (visibility: string, ownerCookie?: string) => {
      const ids: string[] = [];
      let cursor: string | null = null;
      for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
        const query = new URLSearchParams({ visibility, limit: '1', ...(cursor ? { cursor } : {}) });
        const result = await json<{ items: { id: string; visibility: string }[]; next_cursor: string | null }>(
          await request(fixture, `/v1/repos?${query}`, { cookie: ownerCookie }), 200);
        expect(result.items.every(item => item.visibility === visibility)).toBe(true);
        ids.push(...result.items.map(item => item.id));
        if (!result.next_cursor) return ids;
        expect(result.next_cursor).not.toBe(cursor);
        cursor = result.next_cursor;
      }
      throw new Error('Filtered repository pagination did not finish.');
    };
    expect(await filteredIds('public')).toEqual([publicRepo.id]);
    expect(await filteredIds('private')).toEqual([]);
    expect(await filteredIds('unlisted')).toEqual([]);
    expect(await filteredIds('private', alice.cookie)).toEqual([repository.id]);
    expect(await filteredIds('unlisted', alice.cookie)).toEqual([unlisted.id]);
    expect(await json(await request(fixture, '/v1/repos?visibility=confidential'), 422))
      .toMatchObject({ error: { code: 'invalid_repository_visibility' } });
    expect(fixture.native.barriers.size).toBe(0);
    const actor = await authenticate(new Request(`${fixture.env.API_ORIGIN}/v1/me`, { headers: { cookie: alice.cookie } }), fixture.env);
    expect(actor?.id).toBe(alice.id);
    expect((await one(fixture.env.DB, 'SELECT id FROM credentials WHERE token_hash=?', createHash('sha256').update(token.token).digest('hex')))).not.toBeNull();
    expect((await request(fixture, `/v1/tokens/${token.id}`, { method: 'DELETE', cookie: alice.cookie, revision: token.revision })).status).toBe(204);
    expect((await request(fixture, `/v1/repos/${repository.id}`, { token: token.token })).status).toBe(404);
    const replay = await json<{ id: string }>(await request(fixture, '/v1/repos', { method: 'POST', cookie: alice.cookie, body: create, key: 'source-repository' }), 202);
    expect(replay.id).toBe(repository.id);
  });

  it('keeps real federation assurances on rotated sessions and derived tokens without exposing public repositories or local recovery', async () => {
    const fixture = await setup();
    fixture.env.FEDERATION_IDENTITY_CONTRACT = FEDERATION_IDENTITY_CONTRACT;
    fixture.native.ready = true;
    const owner = await person(fixture, 'federated-owner');
    const org = await json<{ id: string }>(await request(fixture, '/v1/orgs', { method: 'POST', cookie: owner.cookie,
      body: { slug: 'federated-org', name: 'Federated organization' } }), 201);
    const createRepo = async (name: string, visibility: string) => {
      const repo = await json<{ id: string; operation: { id: string } }>(await request(fixture, '/v1/repos', { method: 'POST', cookie: owner.cookie,
        body: { owner_id: org.id, name, visibility } }), 202);
      await provision(fixture, repo.operation.id);
      return repo;
    };
    const privateRepo = await createRepo('federated-private', 'private');
    const publicRepo = await createRepo('federated-public', 'public');
    const providerId = newId('idp');
    const subjectId = newId('fs');
    const authenticatedAt = new Date(Date.now() - 60_000).toISOString();
    const assuranceExpiry = new Date(Date.now() + 600_000).toISOString();
    const config = providerConfigSchema.parse({ protocol: 'oidc', issuer: 'https://identity.example.net', authorization_endpoint: 'https://identity.example.net/authorize',
      token_endpoint: 'https://identity.example.net/token', jwks_uri: 'https://identity.example.net/jwks', client_id: 'gitknot', token_endpoint_auth_method: 'none',
      tenant_claim: 'tid', tenant_values: ['tenant-a'], external_id_claim: 'oid', provisioning: 'jit',
      mappings: { default_role_id: 'reader', role_ceiling: ['reader'], capability_ceiling: ['*'], denied_capabilities: ['rules.manage'] } });
    const sso = await prepareCredential(fixture.env.DB, { principal_id: owner.id, user_id: owner.id, kind: 'session', name: 'Verified organization SSO',
      capabilities: null, repository_ids: null, account_ids: null, auth_revision: 1, mfa: true, authenticated_at: authenticatedAt,
      expires_at: new Date(Date.now() + 3600_000).toISOString(), created_by: owner.id });
    const authority = await primaryContext(fixture, owner);
    // This is the verified protocol exchange's durable output. The separate
    // federation suite validates the cryptographic exchange in actual workerd.
    // Policy changes fence both the organization and the human credential home;
    // credential and assurance insertion still share one transaction.
    await withAccountAuthorityBarriers(authority, [org.id, owner.id], 'test.federation_setup', () => fixture.env.DB.batch([
      stmt(fixture.env.DB, 'INSERT INTO federation_providers(id,account_id,protocol,name,config_json,enabled,created_by,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,?)',
        providerId, org.id, 'oidc', 'Organization SSO', JSON.stringify(config), owner.id, now(), now()),
      stmt(fixture.env.DB, 'INSERT INTO federation_org_policies(account_id,config_json,revision,updated_by,updated_at) VALUES (?,?,1,?,?)',
        org.id, JSON.stringify({ required: true, session_max_age_seconds: 3600, machine_access: 'scoped' }), owner.id, now()),
      stmt(fixture.env.DB, "INSERT INTO federation_subjects(id,account_id,provider_id,issuer,subject,tenant,user_id,external_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'active',?,?)",
        subjectId, org.id, providerId, config.issuer, 'immutable-subject', 'tenant-a', owner.id, 'external-user', now(), now()),
      sso.statement,
      stmt(fixture.env.DB, 'INSERT INTO federation_session_grants(account_id,credential_id,provider_id,provider_revision,policy_revision,subject_id,user_id,authenticated_at,mfa,expires_at) VALUES (?,?,?,1,1,?,?,?,1,?)',
        org.id, sso.credential.id, providerId, subjectId, owner.id, authenticatedAt, assuranceExpiry),
    ]));
    const ssoCookie = `gitknot_session=${sso.token}`;
    expect((await request(fixture, `/v1/repos/${privateRepo.id}`, { cookie: owner.cookie })).status).toBe(404);
    expect((await request(fixture, `/v1/repos/${publicRepo.id}`, { cookie: owner.cookie })).status).toBe(200);
    expect((await request(fixture, `/v1/repos/${publicRepo.id}`)).status).toBe(200);
    expect((await request(fixture, `/v1/repos/${privateRepo.id}`, { cookie: ssoCookie })).status).toBe(200);
    const explanation = await json<{ allowed: boolean; reasons: { code: string }[] }>(await request(fixture, `/v1/repos/${privateRepo.id}/permissions/explain`, {
      method: 'POST', cookie: ssoCookie, body: { capability: 'rules.manage' },
    }), 200);
    expect(explanation.allowed).toBe(false);
    expect(explanation.reasons.some(reason => reason.code === 'federation_capability_denied')).toBe(true);
    expect(await json(await request(fixture, '/v1/auth/passkeys/registration/options', { method: 'POST', cookie: ssoCookie, body: { name: 'Untrusted enrollment' } }), 403))
      .toMatchObject({ error: { code: 'independent_authentication_required' } });
    const token = await json<{ id: string; token: string; revision: number }>(await request(fixture, '/v1/tokens', { method: 'POST', cookie: ssoCookie, key: 'sso-derived-token',
      body: { name: 'SSO source reader', capabilities: ['contents.read', 'repositories.read'], repository_ids: [privateRepo.id], account_ids: [org.id],
        expires_at: new Date(Date.now() + 3600_000).toISOString() } }), 201);
    expect(await one(fixture.env.DB, 'SELECT authenticated_at,expires_at FROM federation_session_grants WHERE credential_id=?', token.id))
      .toEqual({ authenticated_at: authenticatedAt, expires_at: assuranceExpiry });
    expect((await request(fixture, `/v1/tokens/${token.id}/rotate`, { method: 'POST', cookie: owner.cookie, revision: token.revision, body: {} })).status).toBe(403);
    const rotated = await json<{ id: string; token: string }>(await request(fixture, `/v1/tokens/${token.id}/rotate`, { method: 'POST', token: token.token,
      revision: token.revision, body: {} }), 201);
    expect(await one(fixture.env.DB, 'SELECT authenticated_at,expires_at FROM federation_session_grants WHERE credential_id=?', rotated.id))
      .toEqual({ authenticated_at: authenticatedAt, expires_at: assuranceExpiry });
    expect((await request(fixture, `/v1/repos/${privateRepo.id}`, { token: token.token })).status).toBe(404);
    expect((await request(fixture, `/v1/repos/${privateRepo.id}`, { token: rotated.token })).status).toBe(200);
    const refreshed = await request(fixture, '/v1/auth/session/refresh', { method: 'POST', cookie: ssoCookie, body: {}, revision: 1 });
    const session = await json<{ id: string }>(refreshed, 200);
    const currentCookie = cookie(refreshed);
    expect(await one(fixture.env.DB, 'SELECT authenticated_at,expires_at FROM federation_session_grants WHERE credential_id=?', session.id))
      .toEqual({ authenticated_at: authenticatedAt, expires_at: assuranceExpiry });
    expect((await request(fixture, '/v1/auth/session', { cookie: ssoCookie })).status).toBe(401);
    expect((await request(fixture, `/v1/repos/${privateRepo.id}`, { cookie: currentCookie })).status).toBe(200);
    expect(await json(await request(fixture, '/v1/tokens/current', { cookie: currentCookie }), 200)).toMatchObject({ account_ids: [org.id] });
    await withAccountAuthorityBarriers(authority, [org.id, owner.id], 'test.federation_expiry', () =>
      stmt(fixture.env.DB, 'UPDATE federation_session_grants SET expires_at=? WHERE account_id=?', new Date(Date.now() - 1000).toISOString(), org.id).run());
    expect((await request(fixture, '/v1/auth/session', { cookie: currentCookie })).status).toBe(401);
    expect((await request(fixture, `/v1/repos/${privateRepo.id}`, { token: rotated.token })).status).toBe(404);
    expect((await request(fixture, `/v1/repos/${publicRepo.id}`)).status).toBe(200);
  });

  it('hides complete exports and stops streaming when access to a historical source is revoked', async () => {
    const fixture = await setup();
    fixture.native.ready = true;
    const alice = await person(fixture, 'archive-alice');
    const bob = await person(fixture, 'archive-bob');
    const createRepository = async (owner: Person, name: string) => {
      const created = await json<{ id: string; operation: { id: string } }>(await request(fixture, '/v1/repos', { method: 'POST', cookie: owner.cookie,
        body: { owner_id: owner.id, name, visibility: 'private' } }), 202);
      await provision(fixture, created.operation.id);
      return (await one<Repository>(fixture.env.DB, 'SELECT * FROM repositories WHERE id=?', created.id))!;
    };
    const base = await createRepository(alice, 'archive-base');
    const source = await createRepository(bob, 'restricted-source');
    await inviteAndAccept(fixture, bob, alice, `/v1/repos/${source.id}/invitations`);
    const exported = await json<{ id: string; operation: { id: string } }>(await request(fixture, `/v1/repos/${base.id}/exports`, {
      method: 'POST', cookie: alice.cookie, body: {},
    }), 202);
    await verifiedExport(fixture, base, source.id, exported);
    const path = `/v1/repos/${base.id}/exports/${exported.id}`;
    expect((await request(fixture, path, { cookie: alice.cookie })).status).toBe(200);
    const complete = await request(fixture, `${path}/download`, { cookie: alice.cookie });
    expect(complete.status).toBe(200);
    expect(await complete.text()).toContain('Restricted historical patch contents');
    const streaming = await request(fixture, `${path}/download`, { cookie: alice.cookie });
    expect(streaming.status).toBe(200);
    const reader = streaming.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('manifest.json');
    const grant = (await one<{ id: string; revision: number }>(fixture.env.DB,
      "SELECT id,revision FROM access_grants WHERE repo_id=? AND principal_id=? AND revoked_at IS NULL AND effect='allow'", source.id, alice.id))!;
    expect((await request(fixture, `/v1/repos/${source.id}/collaborators/${grant.id}`, {
      method: 'DELETE', cookie: bob.cookie, revision: grant.revision,
    })).status).toBe(204);
    await expect(reader.read()).rejects.toMatchObject({ status: 404 });
    reader.releaseLock();
    expect((await request(fixture, `/v1/repos/${base.id}`, { cookie: alice.cookie })).status).toBe(200);
    expect((await request(fixture, path, { cookie: alice.cookie })).status).toBe(404);
    const denied = await request(fixture, `${path}/download`, { cookie: alice.cookie });
    expect(denied.status).toBe(404);
    expect(denied.headers.has('content-disposition')).toBe(false);
    const list = await json<{ items: { id: string }[] }>(await request(fixture, `/v1/repos/${base.id}/exports`, { cookie: alice.cookie }), 200);
    expect(list.items).toEqual([]);
  });

  it('reads and mutates the routed authoritative repository instead of its retained source copy', async () => {
    const fixture = await setup();
    fixture.native.ready = true;
    const owner = await person(fixture, 'routed-owner');
    const repository = await json<{ id: string; operation: { id: string } }>(await request(fixture, '/v1/repos', { method: 'POST', cookie: owner.cookie,
      body: { owner_id: owner.id, name: 'routed-project', visibility: 'public' } }), 202);
    await provision(fixture, repository.operation.id);
    const target = await createTestDatabase();
    try {
      for (const [table, field] of [['users', 'id'], ['accounts', 'id'], ['principals', 'id'], ['memberships', 'principal_id'], ['account_policies', 'account_id'], ['credentials', 'principal_id']]) {
        const rows = fixture.db.sqlite.prepare(`SELECT * FROM ${table} WHERE ${field}=?`).all(owner.id);
        for (const row of rows) {
          const fields = Object.keys(row);
          await stmt(target.binding(), `INSERT INTO ${table}(${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`, ...Object.values(row)).run();
        }
      }
      const retained = (await one<Repository>(fixture.env.DB, 'SELECT * FROM repositories WHERE id=?', repository.id))!;
      const current = { ...retained, visibility: 'private', routing_epoch: 2, shard_id: 'next', revision: 7, description: 'Authoritative repository' };
      const fields = Object.keys(current);
      await stmt(target.binding(), `INSERT INTO repositories(${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`, ...Object.values(current)).run();
      await stmt(fixture.env.DB, "UPDATE repositories SET state='moving',description='Retained source copy' WHERE id=?", repository.id).run();
      await stmt(fixture.env.DB, "UPDATE resource_routes SET shard_id='next',epoch=2 WHERE resource_id=?", repository.id).run();
      fixture.env.SHARD_BINDINGS_JSON = JSON.stringify({ next: 'NEXT_DB' });
      fixture.env.NEXT_DB = target.binding();
      await registerRepositoryPlacement(fixture.env, { repo_id: repository.id, account_id: owner.id, cell_id: fixture.env.CELL_ID, shard_id: 'next', epoch: 2 });
      expect((await request(fixture, `/v1/repos/${repository.id}`)).status).toBe(404);
      expect((await request(fixture, `/v1/repos/resolve/${owner.username}/routed-project`)).status).toBe(404);
      const unrelated = await person(fixture, 'routed-outsider');
      const listed = await json<{ items: { id: string }[] }>(await request(fixture, '/v1/repos', { cookie: unrelated.cookie }), 200);
      expect(listed.items.some(row => row.id === repository.id)).toBe(false);
      for (const path of ['/v1/repos', `/v1/users/${owner.id}/repos`]) {
        expect(await json(await request(fixture, `${path}?visibility=public`, { cookie: owner.cookie }), 200)).toMatchObject({ items: [] });
        const privatePage = await json<{ items: { id: string; visibility: string; revision: number }[] }>(
          await request(fixture, `${path}?visibility=private`, { cookie: owner.cookie }), 200);
        expect(privatePage.items).toMatchObject([{ id: repository.id, visibility: 'private', revision: 7 }]);
      }
      expect(await json(await request(fixture, `/v1/repos/${repository.id}`, { cookie: owner.cookie }), 200))
        .toMatchObject({ description: 'Authoritative repository', revision: 7 });
      await json(await request(fixture, `/v1/repos/${repository.id}`, { method: 'PATCH', cookie: owner.cookie, revision: 7,
        key: 'routed-description', body: { description: 'Edited on the authoritative shard' } }), 200);
      expect(await one(target.binding(), 'SELECT description,revision FROM repositories WHERE id=?', repository.id))
        .toEqual({ description: 'Edited on the authoritative shard', revision: 8 });
      expect(await one(fixture.env.DB, 'SELECT description FROM repositories WHERE id=?', repository.id)).toEqual({ description: 'Retained source copy' });
      expect(await one(target.binding(), "SELECT resource_revision FROM outbox WHERE repo_id=? AND type='repository.updated'", repository.id)).toEqual({ resource_revision: 8 });
      expect(await one(fixture.env.DB, "SELECT 1 FROM outbox WHERE repo_id=? AND type='repository.updated'", repository.id)).toBeNull();
    } finally { target.close(); }
  });
});
