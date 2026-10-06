import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, Response as WorkerResponse, convertV4MiniflareOptions } from 'miniflare';
import type { Request as WorkerRequest } from 'miniflare';
import { createHash, createVerify, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { actionToken, base64url, bytes, newId, now, prepareCredential, randomToken, signInternalRequest, stmt } from '../../packages/core/src/index.ts';
import type { Bindings } from '../../packages/core/src/types.ts';
import { ensureBillingAccount, previewSeatChange } from '../../packages/billing/src/index.ts';
import { createTestDatabase, projectRoot } from '../support/database.ts';
import { FEDERATION_IDENTITY_CONTRACT, SCIM_ENTERPRISE_SCHEMA, SCIM_GROUP_SCHEMA, SCIM_PATCH_SCHEMA, SCIM_USER_SCHEMA } from '../../packages/federation/src/types.ts';
import type { ScimObject } from '../../packages/federation/src/types.ts';
import type { ProviderConfig } from '../../packages/federation/src/types.ts';
import { oidcJwks, samlResponseXml, signOidcToken, signSamlXml, testIssuer } from '../../packages/federation/testing/issuer.ts';
import type { SamlEvidence } from '../../packages/federation/testing/issuer.ts';

const apiOrigin = 'https://api.gitknot.com';
const appOrigin = 'https://gitknot.com';
const clientId = 'enterprise-client';
const secret = 'confidential-oidc-client-secret-not-stored-as-plaintext';
const serviceKey = randomToken();
const rotationKey = randomToken();
const kek = randomToken();
const nextKek = randomToken();

interface CodeGrant { nonce: string; challenge: string; redirect: string; claims: Record<string, unknown>; wrongKey?: boolean; confidential: boolean }
interface Organization { id: string; user_id: string; cookie: string; credential_id: string; team_id: string }
interface ConfiguredProvider { organization: Organization; id: string; revision: number; protocol: 'oidc' | 'saml'; confidential: boolean }
interface BrowserFlow { state: string; cookie: string; authorization: URL; request_id?: string }

describe('enterprise federation and SCIM in Cloudflare workerd', () => {
  let runtime: Miniflare;
  let db: D1Database;
  let temporary: string;
  let idpKey: string;
  let idpCertificate: string;
  let spKey: string;
  let spCertificate: string;
  const grants = new Map<string, CodeGrant>();
  const calls: { url: string; authorization: string | null; body: string }[] = [];

  const responseJson = (value: unknown, status = 200) => new WorkerResponse(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const outbound = async (request: WorkerRequest): Promise<WorkerResponse> => {
    const url = new URL(request.url);
    const body = await request.text();
    calls.push({ url: request.url, authorization: request.headers.get('authorization'), body });
    if (url.origin !== testIssuer) throw new Error(`Unexpected external request: ${url.origin}`);
    if (url.pathname === '/jwks') return responseJson(await oidcJwks());
    if (url.pathname === '/.well-known/openid-configuration') return responseJson({ issuer: testIssuer, authorization_endpoint: `${testIssuer}/authorize`,
      token_endpoint: `${testIssuer}/token`, jwks_uri: `${testIssuer}/jwks`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
      id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic'], authorization_response_iss_parameter_supported: true });
    if (url.pathname !== '/token' || request.method !== 'POST') return responseJson({ error: 'unsupported_request' }, 400);
    const form = new URLSearchParams(body);
    const code = form.get('code') ?? '';
    const grant = grants.get(code);
    if (!grant) return responseJson({ error: 'invalid_grant' }, 400);
    grants.delete(code);
    const pkce = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
    const basic = `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
    if (pkce !== grant.challenge || form.get('redirect_uri') !== grant.redirect || form.get('client_id') !== clientId
      || form.get('grant_type') !== 'authorization_code' || (grant.confidential && request.headers.get('authorization') !== basic)) {
      return responseJson({ error: 'invalid_grant' }, 400);
    }
    const seconds = Math.floor(Date.now() / 1000);
    return responseJson({ access_token: randomToken(24), token_type: 'Bearer', id_token: await signOidcToken({
      iss: testIssuer, aud: clientId, sub: newId('subject'), iat: seconds, exp: seconds + 300, auth_time: seconds,
      nonce: grant.nonce, amr: ['pwd', 'mfa'], tid: 'tenant-a', oid: newId('object'), email: `${newId('person')}@example.com`, email_verified: true, name: 'Enterprise person', ...grant.claims,
    }, grant.wrongKey) });
  };

  async function certificate(prefix: string): Promise<{ key: string; certificate: string }> {
    const keyPath = join(temporary, `${prefix}.key`);
    const certPath = join(temporary, `${prefix}.crt`);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '3650', '-subj', `/CN=${prefix}.example.com`], { stdio: 'ignore' });
    return { key: await readFile(keyPath, 'utf8'), certificate: await readFile(certPath, 'utf8') };
  }

  async function bundle(entry: string, broker = false): Promise<string> {
    const result = await build({ absWorkingDir: projectRoot, bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2023',
      ...(broker ? { stdin: { contents: `import {handleFederationBrokerRequest} from './packages/federation/src/broker.ts'; export default {fetch:handleFederationBrokerRequest};`, resolveDir: projectRoot } } : { entryPoints: [entry] }),
      banner: { js: "import {createRequire as __nodeCreateRequire} from 'node:module'; const require = __nodeCreateRequire('/federation-worker.js');" },
    });
    return result.outputFiles[0]!.text;
  }

  beforeAll(async () => {
    temporary = await mkdtemp(join(process.env.OPENCODE_TMP_DIR ?? tmpdir(), 'gitknot-federation-'));
    const [idp, sp, apiScript, brokerScript, admissionScript] = await Promise.all([certificate('idp'), certificate('sp'),
      bundle('packages/federation/testing/worker.ts'), bundle('', true), bundle('packages/federation/testing/admission.ts')]);
    idpKey = idp.key; idpCertificate = idp.certificate; spKey = sp.key; spCertificate = sp.certificate;
    const bindings = { ENVIRONMENT: 'test', APP_ORIGIN: appOrigin, API_ORIGIN: apiOrigin, GIT_ORIGIN: 'https://git.gitknot.com',
      CELL_ID: 'test', SHARD_ID: 'test', FEDERATION_IDENTITY_CONTRACT, FEDERATION_TRUSTED_ORIGINS_JSON: JSON.stringify([testIssuer]),
      SECRETS_CLIENT_ID: 'api', SECRETS_CLIENT_KEY: serviceKey, INTERNAL_SERVICE_KEY: randomToken() };
    const sessionKey = randomToken();
    const apiBindings = { ...bindings, SESSION_KEY: sessionKey,
      // Retain the legacy derivation bytes; decoding SESSION_KEY itself would change them.
      IDENTITY_KEYS_JSON: JSON.stringify({ current: 'session-v1', keys: { 'session-v1': base64url(bytes(sessionKey)) } }) };
    const brokerBindings = { ...bindings, SECRETS_KEK_KEYRING_JSON: JSON.stringify({ original: kek, current: nextKek }),
      SECRETS_KEK_CURRENT_ID: 'original', SECRETS_FEDERATION_SERVICE_KEYS_JSON: JSON.stringify({
        api: { key: serviceKey, scopes: ['federation.manage', 'federation.exchange', 'federation.sign'] },
        rotation: { key: rotationKey, scopes: ['federation.rotate'] },
      }) };
    runtime = new Miniflare(convertV4MiniflareOptions({ cf: false, workers: [
      { name: 'api', modules: true, script: apiScript, compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: 'federation-tests' }, bindings: apiBindings, serviceBindings: { SECRETS: 'secrets' },
        durableObjects: { ADMISSION: { className: 'AdmissionController', scriptName: 'admission', useSQLite: true } }, outboundService: outbound },
      { name: 'secrets', modules: true, script: brokerScript, compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: 'federation-tests' }, bindings: brokerBindings, outboundService: outbound },
      { name: 'rewrapper', modules: true, script: brokerScript, compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: 'federation-tests' }, bindings: { ...brokerBindings, SECRETS_KEK_CURRENT_ID: 'current' }, outboundService: outbound },
      { name: 'admission', modules: true, script: admissionScript, compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: 'federation-tests' }, bindings,
        durableObjects: { ADMISSION: { className: 'AdmissionController', useSQLite: true } }, outboundService: outbound },
    ] }));
    await runtime.ready;
    db = await runtime.getD1Database('DB', 'api') as unknown as D1Database;
    const identityMigrations = (await readdir(join(projectRoot, 'migrations')))
      .filter(name => /^(?:00\d|01\d|06\d)_.*\.sql$/.test(name) || name === '091_request_fingerprints.sql').sort();
    const source = await createTestDatabase({ migrations: identityMigrations });
    try {
      const schema = source.sqlite.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as { sql: string }[];
      for (let index = 0; index < schema.length; index += 40) await db.batch(schema.slice(index, index + 40).map(row => db.prepare(row.sql)));
      for (const table of ['roles', 'role_capabilities', 'billing_prices', 'billing_plans']) {
        const rows = source.sqlite.prepare(`SELECT * FROM ${table}`).all();
        for (let index = 0; index < rows.length; index += 40) await db.batch(rows.slice(index, index + 40).map(row => stmt(db,
          `INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, ...Object.values(row))));
      }
    } finally { source.close(); }
  }, 60_000);

  afterAll(async () => { await runtime?.dispose(); if (temporary) await rm(temporary, { recursive: true, force: true }); });

  async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    return runtime.dispatchFetch(`${apiOrigin}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }), redirect: 'manual' });
  }

  function cookie(response: { headers: Headers }, prefix: string): string {
    const values = response.headers.getSetCookie();
    const match = values.find(value => value.startsWith(prefix) && !value.includes('Max-Age=0'));
    if (!match) throw new Error(`Missing cookie ${prefix}: ${values.join(', ')}`);
    return match.split(';')[0]!;
  }

  async function result<T = ScimObject>(response: Awaited<ReturnType<typeof request>>, status: number): Promise<T> {
    const value = await response.json();
    expect(response.status, JSON.stringify(value)).toBe(status);
    return value as T;
  }

  async function organization(): Promise<Organization> {
    const id = newId('org');
    const userId = newId('u');
    const teamId = newId('team');
    const timestamp = now();
    await db.batch([
      stmt(db, 'INSERT INTO users(id,username,email,display_name,password_hash,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)', userId, userId, `${userId}@example.com`, 'Recovery owner', 'independent-recovery-test-fixture', timestamp, timestamp, timestamp),
      stmt(db, "INSERT INTO principals(id,kind,user_id,name,created_by,created_at,updated_at) VALUES (?,'user',?,?,?,?,?)", userId, userId, 'Recovery owner', userId, timestamp, timestamp),
      stmt(db, "INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES (?,'organization',?,?,?,?,?)", id, id, id, userId, timestamp, timestamp),
      stmt(db, "INSERT INTO memberships(account_id,principal_id,role_id,state,created_by,created_at,updated_at) VALUES (?,?,'owner','active',?,?,?)", id, userId, userId, timestamp, timestamp),
      stmt(db, 'INSERT INTO teams(id,account_id,slug,name,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', teamId, id, teamId, 'Engineering', userId, timestamp, timestamp),
    ]);
    const credential = await prepareCredential(db, { principal_id: userId, user_id: userId, kind: 'session', name: 'Local MFA', capabilities: null,
      repository_ids: null, account_ids: null, auth_revision: 1, mfa: true, created_by: userId, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    await credential.statement.run();
    await ensureBillingAccount({ DB: db }, id);
    return { id, user_id: userId, cookie: `__Host-gitknot_session=${credential.token}`, credential_id: credential.credential.id, team_id: teamId };
  }

  const adminHeaders = (org: Organization, revision?: number) => ({ cookie: org.cookie, origin: appOrigin, 'x-gitknot-csrf': '1', ...(revision === undefined ? {} : { 'if-match': `"${revision}"` }) });
  const providerBase = (provider: ConfiguredProvider) => `/v1/orgs/${provider.organization.id}/identity-providers/${provider.id}`;

  async function paidSeats(org: Organization, maximum: number, budget = '1000000000000'): Promise<void> {
    const planId = newId('plan');
    await db.batch([
      stmt(db, `INSERT INTO billing_plans(id,name,version,currency,monthly_base_units,seat_units,included_usage_units,default_budget_units,
        max_concurrency,max_storage_bytes,max_seats,entitlements_json,created_at)
        SELECT ?,'Paid seat fixture',?,'USD','0','12000000000','0',?,max_concurrency,max_storage_bytes,?,entitlements_json,?
        FROM billing_plans WHERE id='plan_team_202610'`, planId, planId, budget, maximum, now()),
      stmt(db, 'UPDATE billing_accounts SET plan_id=?,revision=revision+1 WHERE account_id=?', planId, org.id),
      stmt(db, 'UPDATE billing_plan_segments SET ended_at=? WHERE account_id=? AND ended_at IS NULL', now(), org.id),
      stmt(db, `INSERT INTO billing_plan_segments(id,account_id,plan_id,seat_count,started_at,created_at)
        SELECT ?,account_id,plan_id,seat_count,?,? FROM billing_accounts WHERE account_id=?`, newId('segment'), now(), now(), org.id),
    ]);
  }

  async function updateMappings(configured: ConfiguredProvider, changes: Partial<ProviderConfig['mappings']>): Promise<void> {
    const current = await result<{ config: ProviderConfig; revision: number }>(await request(providerBase(configured), 'GET', undefined, adminHeaders(configured.organization)), 200);
    const updated = await result<{ revision: number }>(await request(providerBase(configured), 'PATCH',
      { config: { ...current.config, mappings: { ...current.config.mappings, ...changes } } }, adminHeaders(configured.organization, current.revision)), 200);
    configured.revision = updated.revision;
  }

  async function provider(protocol: 'oidc' | 'saml' = 'oidc', overrides: Record<string, unknown> = {}, org?: Organization): Promise<ConfiguredProvider> {
    const organizationRecord = org ?? await organization();
    const config: Record<string, unknown> = { tenant_claim: 'tid', tenant_values: ['tenant-a'], external_id_claim: 'oid', provisioning: 'jit',
      mappings: { default_role_id: 'reader', role_ceiling: ['reader'], capability_ceiling: ['*'], denied_capabilities: ['contents.push'],
        team_ceiling: [organizationRecord.team_id], scim_group_mappings: [{ external_id: 'engineering', team_id: organizationRecord.team_id }] },
      ...(protocol === 'oidc' ? { protocol, issuer: testIssuer, client_id: clientId, authorization_endpoint: `${testIssuer}/authorize`, token_endpoint: `${testIssuer}/token`,
        jwks_uri: `${testIssuer}/jwks`, token_endpoint_auth_method: 'client_secret_basic' }
        : { protocol, issuer: testIssuer, sso_url: `${testIssuer}/sso`, signing_certificates: [idpCertificate], sign_authn_requests: true }), ...overrides };
    const created = await result<{ id: string; revision: number }>(await request(`/v1/orgs/${organizationRecord.id}/identity-providers`, 'POST', { name: 'Enterprise', config }, adminHeaders(organizationRecord)), 201);
    const configured: ConfiguredProvider = { ...created, organization: organizationRecord, protocol, confidential: protocol === 'oidc' && config.token_endpoint_auth_method !== 'none' };
    if (protocol === 'saml' || configured.confidential) {
      const kind = protocol === 'saml' ? 'saml_signing_key' : 'oidc_client_secret';
      const rotated = await result<{ provider_revision: number }>(await request(`${providerBase(configured)}/secrets/${kind}`, 'PUT',
        protocol === 'saml' ? { secret: spKey, public_certificate: spCertificate } : { secret }, adminHeaders(organizationRecord, configured.revision)), 200);
      configured.revision = rotated.provider_revision;
    }
    const enabled = await result<{ revision: number }>(await request(providerBase(configured), 'PATCH', { enabled: true }, adminHeaders(organizationRecord, configured.revision)), 200);
    configured.revision = enabled.revision;
    return configured;
  }

  async function browserFlow(configured: ConfiguredProvider, link = false, linkingCookie?: string): Promise<BrowserFlow> {
    const path = `/v1/auth/${configured.protocol}/${configured.id}/start`;
    const response = link ? await request(path, 'POST', { intent: 'link', return_to: '/settings/identity' }, { ...adminHeaders(configured.organization), ...(linkingCookie ? { cookie: linkingCookie } : {}) })
      : await request(`${path}?return_to=%2Forganizations`);
    const location = link ? (await result<{ authorization_url: string }>(response, 200)).authorization_url : response.headers.get('location');
    if (!link) expect(response.status, await response.clone().text()).toBe(302);
    const authorization = new URL(location!);
    const flow: BrowserFlow = { authorization, state: authorization.searchParams.get(configured.protocol === 'saml' ? 'RelayState' : 'state')!,
      cookie: cookie(response as unknown as { headers: Headers }, '__Host-gitknot_federation_') };
    if (configured.protocol === 'saml') {
      const xml = Buffer.from(inflateRawSync(Buffer.from(authorization.searchParams.get('SAMLRequest')!, 'base64'))).toString('utf8');
      flow.request_id = /\bID="([^"]+)"/.exec(xml)![1]!;
    }
    return flow;
  }

  function authorizeCode(configured: ConfiguredProvider, flow: BrowserFlow, claims: Record<string, unknown> = {}, wrongKey = false): string {
    const code = randomToken(24);
    grants.set(code, { nonce: flow.authorization.searchParams.get('nonce')!, challenge: flow.authorization.searchParams.get('code_challenge')!,
      redirect: flow.authorization.searchParams.get('redirect_uri')!, claims, wrongKey, confidential: configured.confidential });
    return code;
  }

  async function oidcCallback(configured: ConfiguredProvider, flow: BrowserFlow, claims: Record<string, unknown> = {}, wrongKey = false) {
    const code = authorizeCode(configured, flow, claims, wrongKey);
    return request(`/v1/auth/oidc/${configured.id}/callback?${new URLSearchParams({ code, state: flow.state, iss: testIssuer })}`, 'GET', undefined, { cookie: flow.cookie });
  }

  async function provisioningToken(configured: ConfiguredProvider, capabilities?: string[]): Promise<string> {
    const body = await result<{ token: string }>(await request(`${providerBase(configured)}/provisioning-tokens`, 'POST', { name: 'Directory', ...(capabilities ? { capabilities } : {}) }, adminHeaders(configured.organization)), 201);
    return body.token;
  }

  function scim(configured: ConfiguredProvider, token: string, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    return request(`/scim/v2/${configured.organization.id}${path}`, method, body, { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json', ...headers });
  }

  async function createUser(configured: ConfiguredProvider, token: string, externalId = newId('external'), userName = newId('person')): Promise<ScimObject & { id: string; externalId: string; userName: string }> {
    return result(await scim(configured, token, '/Users', 'POST', { schemas: [SCIM_USER_SCHEMA], externalId, userName,
      emails: [{ value: `${userName}@example.com`, primary: true, type: 'work' }], active: true }), 201) as Promise<ScimObject & { id: string; externalId: string; userName: string }>;
  }

  function evidence(configured: ConfiguredProvider, flow: BrowserFlow, changes: Partial<SamlEvidence> = {}): SamlEvidence {
    return { request_id: flow.request_id!, acs: `${apiOrigin}/v1/auth/saml/${configured.id}/acs`, audience: `${apiOrigin}/v1/auth/saml/${configured.id}/metadata`,
      subject: newId('persistent'), external_id: newId('external'), email: `${newId('user')}@example.com`, ...changes };
  }

  function samlAcs(configured: ConfiguredProvider, flow: BrowserFlow, xml: string) {
    return request(`/v1/auth/saml/${configured.id}/acs`, 'POST', new URLSearchParams({ RelayState: flow.state, SAMLResponse: Buffer.from(xml).toString('base64') }).toString(),
      { cookie: flow.cookie, origin: testIssuer, 'content-type': 'application/x-www-form-urlencoded' });
  }

  it('fails closed without the core contract, requires verified MFA administration, and refuses unapproved discovery destinations', async () => {
    const org = await organization();
    const response = await request(`/v1/orgs/${org.id}/identity-providers`, 'GET', undefined, { 'x-actor-id': org.user_id });
    expect(response.status).toBe(401);
    expect((await request('/test/missing-contract')).status).toBe(503);
    const before = calls.length;
    await result(await request(`/v1/orgs/${org.id}/identity-providers/discovery`, 'POST', { issuer: 'https://169.254.169.254' }, adminHeaders(org)), 422);
    await result(await request(`/v1/orgs/${org.id}/identity-providers/discovery`, 'POST', { issuer: 'https://attacker.example.com' }, adminHeaders(org)), 422);
    expect(calls).toHaveLength(before);
    const found = await result(await request(`/v1/orgs/${org.id}/identity-providers/discovery`, 'POST', { issuer: testIssuer }, adminHeaders(org)), 200);
    expect(found).toMatchObject({ issuer: testIssuer, signing_algorithms: ['RS256'] });
    const configured = await provider('oidc', {}, org);
    expect((await request(`/v1/auth/oidc/${configured.id}/start?return_to=https%3A%2F%2Fattacker.example.com`)).status).toBe(422);
  }, 20_000);

  it('exchanges an OIDC code with PKCE, nonce and a private encrypted client secret, then scopes the core session to the organization', async () => {
    const configured = await provider();
    const stored = await db.prepare('SELECT * FROM federation_client_secrets WHERE provider_id=?').bind(configured.id).first<Record<string, unknown>>();
    expect(stored).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain(secret);
    const flow = await browserFlow(configured);
    expect(flow.authorization.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.authorization.searchParams.get('code_verifier')).toBeNull();
    const response = await oidcCallback(configured, flow);
    expect(response.status, await response.clone().text()).toBe(303);
    const session = cookie(response as unknown as { headers: Headers }, '__Host-gitknot_session=');
    const principal = await result(await request('/test/principal', 'GET', undefined, { cookie: session }), 200);
    expect(principal).toMatchObject({ kind: 'user', mfa: true, account_ids: [configured.organization.id] });
    expect((await request(`/test/organizations/${configured.organization.id}/permission`, 'GET', undefined, { cookie: session })).status).toBe(200);
    expect((await request(`/test/organizations/${configured.organization.id}/permission?capability=contents.push`, 'GET', undefined, { cookie: session })).status).toBe(403);
    const other = await organization();
    expect((await request(`/test/organizations/${other.id}/permission`, 'GET', undefined, { cookie: session })).status).toBe(403);
    const terminal = await db.prepare('SELECT pkce_verifier,consumed_at,completed_at FROM federation_auth_flows WHERE provider_id=?').bind(configured.id).first<Record<string, unknown>>();
    expect(terminal).toMatchObject({ pkce_verifier: null, consumed_at: expect.any(String), completed_at: expect.any(String) });
  }, 20_000);

  it('commits metadata retry receipts atomically and replays broker rotations without issuing duplicate secrets or tokens', async () => {
    const configured = await provider();
    const existing = await result<{ config: Record<string, unknown> }>(await request(providerBase(configured), 'GET', undefined, adminHeaders(configured.organization)), 200);
    const collection = `/v1/orgs/${configured.organization.id}/identity-providers`;
    const headers = { ...adminHeaders(configured.organization), 'idempotency-key': 'create-provider-once' };
    const input = { name: 'Retry-safe provider', config: existing.config };
    const created = await result<{ id: string }>(await request(collection, 'POST', input, headers), 201);
    const replay = await request(collection, 'POST', input, headers);
    expect(await result(replay, 201)).toMatchObject({ id: created.id });
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    expect(await db.prepare('SELECT resource_id,committed_at,event_id,audit_id FROM idempotency_keys WHERE principal_id=? AND key=?')
      .bind(configured.organization.user_id, 'create-provider-once').first()).toMatchObject({ resource_id: created.id,
      committed_at: expect.any(String), event_id: expect.any(String), audit_id: expect.any(String) });

    const secretHeaders = { ...adminHeaders(configured.organization, configured.revision), 'idempotency-key': 'rotate-secret-once' };
    const first = await result<{ version: number; provider_revision: number }>(await request(`${providerBase(configured)}/secrets/oidc_client_secret`, 'PUT', { secret }, secretHeaders), 200);
    const repeated = await result(await request(`${providerBase(configured)}/secrets/oidc_client_secret`, 'PUT', { secret }, secretHeaders), 200);
    expect(repeated).toMatchObject(first);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM federation_client_secrets WHERE provider_id=?').bind(configured.id).first()).toMatchObject({ count: 2 });
    const operation = await db.prepare('SELECT request_hash,response_json FROM federation_secret_operations WHERE provider_id=? ORDER BY created_at DESC LIMIT 1').bind(configured.id).first();
    expect(JSON.stringify(operation)).not.toContain(secret);

    const tokenHeaders = { ...adminHeaders(configured.organization), 'idempotency-key': 'issue-token-once' };
    await result(await request(`${providerBase(configured)}/provisioning-tokens`, 'POST', { name: 'One-time directory credential' }, tokenHeaders), 201);
    expect(await result(await request(`${providerBase(configured)}/provisioning-tokens`, 'POST', { name: 'One-time directory credential' }, tokenHeaders), 409))
      .toMatchObject({ error: { code: 'one_time_value_already_issued' } });
  }, 20_000);

  it('binds state to the initiating browser and admits only one simultaneous callback', async () => {
    const configured = await provider('oidc', { token_endpoint_auth_method: 'none' });
    const flow = await browserFlow(configured);
    const code = authorizeCode(configured, flow);
    const path = `/v1/auth/oidc/${configured.id}/callback?${new URLSearchParams({ state: flow.state, code, iss: testIssuer })}`;
    expect((await request(path, 'GET', undefined, { cookie: flow.cookie.replace(/=.+$/, `=${randomToken()}`) })).status).toBe(401);
    const results = await Promise.all([request(path, 'GET', undefined, { cookie: flow.cookie }), request(path, 'GET', undefined, { cookie: flow.cookie })]);
    expect(results.map(value => value.status).sort()).toEqual([303, 401]);
    expect(calls.filter(value => new URLSearchParams(value.body).get('code') === code)).toHaveLength(1);
  }, 20_000);

  it('rejects issuer/audience/nonce/tenant/MFA/time/signature confusion without creating identities', async () => {
    const configured = await provider('oidc', { token_endpoint_auth_method: 'none' });
    const seconds = Math.floor(Date.now() / 1000);
    for (const claims of [{ iss: 'https://other.example.com' }, { aud: 'other-client' }, { aud: [clientId, 'other'], azp: 'other' },
      { nonce: 'other-nonce' }, { tid: 'unconfigured-tenant' }, { amr: ['pwd'] }, { nbf: seconds + 300 }, { exp: seconds - 120 },
      { auth_time: seconds - 3600 }, { auth_time: seconds + 600 }]) {
      const response = await oidcCallback(configured, await browserFlow(configured), claims);
      expect([401, 403], JSON.stringify(claims)).toContain(response.status);
    }
    expect((await oidcCallback(configured, await browserFlow(configured), {}, true)).status).toBe(401);
    const count = await db.prepare('SELECT COUNT(*) AS count FROM federation_subjects WHERE provider_id=?').bind(configured.id).first<{ count: number }>();
    expect(count?.count).toBe(0);
  }, 30_000);

  it('does not auto-link an existing email and supports explicit local-MFA pre-linking followed by SCIM external-ID provisioning', async () => {
    const org = await organization();
    const configured = await provider('oidc', { token_endpoint_auth_method: 'none' }, org);
    const claims = { email: `${org.user_id}@example.com`, sub: 'existing-person', oid: 'stable-object-existing' };
    const hijack = await oidcCallback(configured, await browserFlow(configured), claims);
    expect(hijack.status).toBe(409);
    const scimProvider = await provider('oidc', { token_endpoint_auth_method: 'none', provisioning: 'scim_only' }, org);
    expect((await request(`/v1/auth/oidc/${scimProvider.id}/start`, 'POST', { intent: 'link' }, { cookie: org.cookie, origin: testIssuer })).status).toBe(403);
    const linked = await oidcCallback(scimProvider, await browserFlow(scimProvider, true), claims);
    expect(linked.status, await linked.clone().text()).toBe(303);
    expect(linked.headers.get('location')).toContain('provisioning_required=true');
    expect(linked.headers.getSetCookie().some(value => value.startsWith('__Host-gitknot_session='))).toBe(false);
    const token = await provisioningToken(scimProvider);
    const created = await createUser(scimProvider, token, claims.oid, 'existing-person-directory');
    const record = await db.prepare('SELECT user_id FROM federation_scim_users WHERE id=?').bind(created.id).first<{ user_id: string }>();
    expect(record?.user_id).toBe(org.user_id);
    const loggedIn = await oidcCallback(scimProvider, await browserFlow(scimProvider), claims);
    expect(loggedIn.status, await loggedIn.clone().text()).toBe(303);
    const inactive = await scim(scimProvider, token, `/Users/${created.id}`, 'PATCH', { schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: 'replace', path: 'active', value: false }] });
    expect(inactive.status).toBe(409);
    expect(await inactive.json()).toMatchObject({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], scimType: 'mutability' });
    expect((await db.prepare('SELECT state FROM memberships WHERE account_id=? AND principal_id=?').bind(org.id, org.user_id).first<{ state: string }>())?.state).toBe('active');
    expect((await scim(scimProvider, token, `/Users/${created.id}`)).status).toBe(200);
  }, 30_000);

  it('signs SAML Redirect requests in the private broker and verifies both XML signatures natively in workerd', async () => {
    const configured = await provider('saml', { signing_certificates: [spCertificate, idpCertificate] });
    const metadata = await request(`/v1/auth/saml/${configured.id}/metadata`);
    expect(metadata.headers.get('content-type')).toContain('application/samlmetadata+xml');
    expect(await metadata.text()).toContain('WantAssertionsSigned="true"');
    const flow = await browserFlow(configured);
    const p = flow.authorization.searchParams;
    const signedInput = `SAMLRequest=${encodeURIComponent(p.get('SAMLRequest')!)}&RelayState=${encodeURIComponent(p.get('RelayState')!)}&SigAlg=${encodeURIComponent(p.get('SigAlg')!)}`;
    expect(createVerify('RSA-SHA256').update(signedInput).verify(spCertificate, p.get('Signature')!, 'base64')).toBe(true);
    const xml = signSamlXml(samlResponseXml(evidence(configured, flow)), idpKey, idpCertificate);
    const response = await samlAcs(configured, flow, xml);
    expect(response.status, await response.clone().text()).toBe(303);
    const session = cookie(response as unknown as { headers: Headers }, '__Host-gitknot_session=');
    expect(await result(await request('/test/principal', 'GET', undefined, { cookie: session }), 200)).toMatchObject({ mfa: true, account_ids: [configured.organization.id] });
  }, 20_000);

  it('rejects signed SAML responses with wrong request/recipient/issuer/audience/time/MFA bindings', async () => {
    const configured = await provider('saml');
    const changes: Partial<SamlEvidence>[] = [{ destination: `${apiOrigin}/other` }, { recipient: `${apiOrigin}/other` },
      { response_in_response_to: '_not_requested' }, { subject_in_response_to: '_not_requested' }, { issuer: 'https://other.example.com' },
      { audience: 'https://other.example.com' }, { not_before: new Date(Date.now() + 120_000).toISOString() },
      { expires_at: new Date(Date.now() - 120_000).toISOString() }, { authn_at: new Date(Date.now() - 3600_000).toISOString() },
      { context: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport' }];
    for (const change of changes) {
      const flow = await browserFlow(configured);
      const response = await samlAcs(configured, flow, signSamlXml(samlResponseXml(evidence(configured, flow, change)), idpKey, idpCertificate));
      expect([401, 403], JSON.stringify(change)).toContain(response.status);
    }
  }, 30_000);

  it('rejects SAML wrapping, tampered claims, untrusted KeyInfo, XXE and oversized inputs', async () => {
    const configured = await provider('saml');
    for (const mutation of ['tamper', 'wrap', 'untrusted-key', 'xxe', 'oversize']) {
      const flow = await browserFlow(configured);
      let xml = samlResponseXml(evidence(configured, flow));
      if (mutation === 'untrusted-key') xml = signSamlXml(xml, spKey, spCertificate);
      else xml = signSamlXml(xml, idpKey, idpCertificate);
      if (mutation === 'tamper') xml = xml.replace('Enterprise member', 'Administrator');
      if (mutation === 'wrap') xml = xml.replace('</samlp:Response>', `<saml:Assertion ID="_wrapper" Version="2.0"/></samlp:Response>`);
      if (mutation === 'xxe') xml = `<!DOCTYPE samlp:Response [<!ENTITY probe SYSTEM "https://169.254.169.254/latest/meta-data">]>${xml}`;
      if (mutation === 'oversize') xml = 'x'.repeat(140_000);
      const response = await samlAcs(configured, flow, xml);
      expect([401, 413], mutation).toContain(response.status);
    }
    expect(calls.some(value => value.url.includes('169.254.169.254'))).toBe(false);
  }, 20_000);

  it('supports assertion-only signatures with signed request/recipient binding and durable assertion replay prevention', async () => {
    const configured = await provider('saml', { response_signature_required: false });
    const first = await browserFlow(configured);
    const common = { assertion_id: '_single_use_assertion', subject: newId('subject'), external_id: newId('external'), email: `${newId('person')}@example.com` };
    const accepted = await samlAcs(configured, first, signSamlXml(samlResponseXml(evidence(configured, first, common)), idpKey, idpCertificate, false));
    expect(accepted.status, await accepted.clone().text()).toBe(303);
    const second = await browserFlow(configured);
    const replay = await samlAcs(configured, second, signSamlXml(samlResponseXml(evidence(configured, second, common)), idpKey, idpCertificate, false));
    expect(replay.status).toBe(409);
  }, 20_000);

  it('implements SCIM Users/Groups pagination, complex filters, projections, atomic PATCH and idempotent creation', async () => {
    const configured = await provider('oidc', { token_endpoint_auth_method: 'none', provisioning: 'scim_only' });
    const token = await provisioningToken(configured);
    const user = await createUser(configured, token);
    const second = await createUser(configured, token);
    const body = { schemas: [SCIM_USER_SCHEMA, SCIM_ENTERPRISE_SCHEMA], externalId: 'idempotent-user', userName: 'Ångström',
      emails: [{ value: 'angstrom-directory@example.com', type: 'work' }], [SCIM_ENTERPRISE_SCHEMA]: { department: 'Engineering' } };
    const created = await result<{ id: string }>(await scim(configured, token, '/Users', 'POST', body, { 'idempotency-key': 'directory-create-1' }), 201);
    const replay = await scim(configured, token, '/Users', 'POST', body, { 'idempotency-key': 'directory-create-1' });
    expect(await result(replay, 201)).toMatchObject({ id: created.id });
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    const filtered = await result(await scim(configured, token, `/Users?${new URLSearchParams({ filter: 'userName eq "ångström" and emails[type eq "work" and value co "directory"]', attributes: 'userName' })}`), 200);
    expect(filtered).toMatchObject({ totalResults: 1, Resources: [{ id: created.id, userName: 'Ångström' }] });
    const countOnly = await result(await scim(configured, token, '/Users?count=0'), 200);
    expect(countOnly).toMatchObject({ totalResults: 3, itemsPerPage: 0, Resources: [] });
    const page = await result(await scim(configured, token, '/Users?startIndex=2&count=1'), 200);
    expect(page).toMatchObject({ totalResults: 3, startIndex: 2, itemsPerPage: 1 });
    const group = await result<{ id: string }>(await scim(configured, token, '/Groups', 'POST', { schemas: [SCIM_GROUP_SCHEMA], externalId: 'engineering', displayName: 'Engineering', members: [{ value: user.id }] }), 201);
    await result(await scim(configured, token, `/Groups/${group.id}`, 'PATCH', { schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: 'add', path: 'members', value: [{ value: second.id }] }] }), 200);
    const groupList = await result(await scim(configured, token, `/Groups?${new URLSearchParams({ filter: `members[value eq "${second.id}"]` })}`), 200);
    expect(groupList).toMatchObject({ totalResults: 1 });
    const invalid = await scim(configured, token, `/Users/${user.id}`, 'PATCH', { schemas: [SCIM_PATCH_SCHEMA], Operations: [
      { op: 'replace', path: 'active', value: false }, { op: 'replace', path: 'externalId', value: 'takeover' }] });
    expect(invalid.status).toBe(400);
    expect(await result(await scim(configured, token, `/Users/${user.id}`), 200)).toMatchObject({ active: true });
    const stale = await scim(configured, token, `/Groups/${group.id}`, 'DELETE', undefined, { 'if-match': '"1"' });
    expect(stale.status).toBe(412);
    const badFilter = await scim(configured, token, '/Users?filter=active%20gt%20true');
    expect(badFilter.headers.get('content-type')).toContain('application/scim+json');
    expect(await result(badFilter, 400)).toMatchObject({ scimType: 'invalidFilter', status: '400' });
    const invalidPath = await scim(configured, token, `/Users/${user.id}`, 'PATCH', { schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: 'add', path: 'name.unsupported', value: 'ignored' }] });
    expect(await result(invalidPath, 400)).toMatchObject({ scimType: 'invalidPath' });
    const unknown = await scim(configured, token, '/does-not-exist');
    expect(unknown.headers.get('content-type')).toContain('application/scim+json');
    expect(unknown.status).toBe(404);
    for (const path of ['/ServiceProviderConfig', '/Schemas', '/ResourceTypes', '/ResourceTypes/User']) expect((await scim(configured, token, path)).status).toBe(200);
  }, 30_000);

  it('revokes sessions on team changes and prevents stale team access when activation races with group removal', async () => {
    const configured = await provider('oidc', { token_endpoint_auth_method: 'none', provisioning: 'scim_only' });
    const token = await provisioningToken(configured);
    const user = await createUser(configured, token);
    const signedIn = await oidcCallback(configured, await browserFlow(configured), { oid: user.externalId, email: `${user.userName}@example.com` });
    expect(signedIn.status, await signedIn.clone().text()).toBe(303);
    const session = cookie(signedIn as unknown as { headers: Headers }, '__Host-gitknot_session=');
    const principal = await result<{ id: string }>(await request('/test/principal', 'GET', undefined, { cookie: session }), 200);
    const group = await result<{ id: string }>(await scim(configured, token, '/Groups', 'POST', {
      schemas: [SCIM_GROUP_SCHEMA], externalId: 'engineering', displayName: 'Engineering', members: [{ value: user.id }],
    }), 201);
    expect((await request('/test/principal', 'GET', undefined, { cookie: session })).status).toBe(401);
    const setActive = (active: boolean) => scim(configured, token, `/Users/${user.id}`, 'PATCH', {
      schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: 'replace', path: 'active', value: active }],
    });
    await result(await setActive(false), 200);
    const removeMember = () => scim(configured, token, `/Groups/${group.id}`, 'PATCH', {
      schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: 'remove', path: `members[value eq "${user.id}"]` }],
    });
    const [activated, removed] = await Promise.all([setActive(true), removeMember()]);
    expect([200, 412]).toContain(activated.status);
    expect([200, 412]).toContain(removed.status);
    if (activated.status === 412) await result(await setActive(true), 200);
    if (removed.status === 412) await result(await removeMember(), 200);
    expect(await result(await scim(configured, token, `/Groups/${group.id}`), 200)).toMatchObject({ members: [] });
    const remaining = await db.prepare('SELECT COUNT(*) AS count FROM team_members WHERE account_id=? AND principal_id=?').bind(configured.organization.id, principal.id).first<{ count: number }>();
    expect(remaining?.count).toBe(0);
  }, 20_000);

  it('authorizes a personal credential only through fresh scoped SSO and expires that assurance independently', async () => {
    const configured = await provider('oidc', { token_endpoint_auth_method: 'none' });
    const signedIn = await oidcCallback(configured, await browserFlow(configured));
    expect(signedIn.status, await signedIn.clone().text()).toBe(303);
    const session = cookie(signedIn as unknown as { headers: Headers }, '__Host-gitknot_session=');
    const principal = await result<{ id: string }>(await request('/test/principal', 'GET', undefined, { cookie: session }), 200);
    const prepared = await prepareCredential(db, { principal_id: principal.id, user_id: principal.id, kind: 'personal', name: 'Git client',
      capabilities: ['contents.read'], repository_ids: null, account_ids: [configured.organization.id], auth_revision: 1,
      mfa: false, created_by: principal.id, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    await prepared.statement.run();
    const permission = `/test/organizations/${configured.organization.id}/permission`;
    expect((await request(permission, 'GET', undefined, { authorization: `Bearer ${prepared.token}` })).status).toBe(403);
    await result(await request(`${providerBase(configured)}/credentials/${prepared.credential.id}/authorize`, 'POST', undefined,
      { cookie: session, origin: appOrigin, 'x-gitknot-csrf': '1', 'if-match': '"1"' }), 200);
    expect((await request(permission, 'GET', undefined, { authorization: `Bearer ${prepared.token}` })).status).toBe(200);
    await db.prepare('UPDATE federation_session_grants SET expires_at=? WHERE credential_id=?').bind(new Date(Date.now() - 1000).toISOString(), prepared.credential.id).run();
    expect((await request(permission, 'GET', undefined, { authorization: `Bearer ${prepared.token}` })).status).toBe(401);
  }, 20_000);

  it('deprovisions atomically, revokes sessions and personal credentials, and reactivates only with fresh provider evidence', async () => {
    const configured = await provider('oidc', { token_endpoint_auth_method: 'none', provisioning: 'scim_only' });
    const token = await provisioningToken(configured);
    const user = await createUser(configured, token);
    const claims = { oid: user.externalId, sub: newId('subject'), email: `${user.userName}@example.com` };
    const signedIn = await oidcCallback(configured, await browserFlow(configured), claims);
    expect(signedIn.status, await signedIn.clone().text()).toBe(303);
    const session = cookie(signedIn as unknown as { headers: Headers }, '__Host-gitknot_session=');
    const principal = await result<{ id: string; credential_id: string }>(await request('/test/principal', 'GET', undefined, { cookie: session }), 200);
    const personal = await prepareCredential(db, { principal_id: principal.id, user_id: principal.id, kind: 'personal', name: 'Scoped automation',
      capabilities: ['contents.read'], repository_ids: [], account_ids: [configured.organization.id], auth_revision: 1, mfa: false,
      created_by: principal.id, parent_id: principal.credential_id, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    await personal.statement.run();
    await result(await scim(configured, token, `/Users/${user.id}`, 'PATCH', { schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: 'replace', path: 'active', value: false }] }), 200);
    expect((await request('/test/principal', 'GET', undefined, { cookie: session })).status).toBe(401);
    expect((await request('/test/principal', 'GET', undefined, { authorization: `Bearer ${personal.token}` })).status).toBe(401);
    const credential = await db.prepare('SELECT revoked_at FROM credentials WHERE id=?').bind(personal.credential.id).first<{ revoked_at: string | null }>();
    expect(credential?.revoked_at).toEqual(expect.any(String));
    expect((await oidcCallback(configured, await browserFlow(configured), claims)).status).toBe(401);
    await result(await scim(configured, token, `/Users/${user.id}`, 'PATCH', { schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: 'replace', path: 'active', value: true }] }), 200);
    expect((await request('/test/principal', 'GET', undefined, { cookie: session })).status).toBe(401);
    expect((await oidcCallback(configured, await browserFlow(configured), claims)).status).toBe(303);
    expect((await scim(configured, token, `/Users/${user.id}`, 'DELETE')).status).toBe(204);
    expect((await scim(configured, token, `/Users/${user.id}`)).status).toBe(404);
    expect(await db.prepare('SELECT id FROM users WHERE id=?').bind(principal.id).first()).not.toBeNull();
  }, 30_000);

  it('keeps provisioning tokens provider/organization-bound and unable to manage identity or obtain user sessions', async () => {
    const configured = await provider('oidc', { token_endpoint_auth_method: 'none', provisioning: 'scim_only' });
    const token = await provisioningToken(configured, ['scim.users.read', 'scim.discovery.read']);
    const denied = await scim(configured, token, '/Users', 'POST', { schemas: [SCIM_USER_SCHEMA], userName: 'blocked', externalId: 'blocked' });
    expect(denied.status).toBe(403);
    const other = await organization();
    expect((await request(`/scim/v2/${other.id}/Users`, 'GET', undefined, { authorization: `Bearer ${token}` })).status).toBe(401);
    expect([401, 403]).toContain((await request(providerBase(configured), 'PATCH', { enabled: false }, { authorization: `Bearer ${token}`, 'if-match': `"${configured.revision}"` })).status);
    expect((await request(`/scim/v2/${configured.organization.id}/Users`, 'GET', undefined, { cookie: configured.organization.cookie })).status).toBe(401);
  }, 20_000);

  it('enforces paid seat and budget admission on SCIM creation/reactivation and JIT without approving each person', async () => {
    const org = await organization();
    await paidSeats(org, 1);
    const configured = await provider('oidc', { token_endpoint_auth_method: 'none', provisioning: 'scim_only' }, org);
    const token = await provisioningToken(configured);
    const makeBody = (active: boolean) => ({ schemas: [SCIM_USER_SCHEMA], externalId: newId('external'), userName: newId('directory'),
      emails: [{ value: `${newId('seat')}@example.com` }], active });
    const blocked = await scim(configured, token, '/Users', 'POST', makeBody(true));
    expect(blocked.status).toBe(422);
    expect(blocked.headers.get('content-type')).toContain('application/scim+json');
    const inactive = await result<{ id: string }>(await scim(configured, token, '/Users', 'POST', makeBody(false)), 201);
    expect((await scim(configured, token, `/Users/${inactive.id}`, 'PATCH', { schemas: [SCIM_PATCH_SCHEMA],
      Operations: [{ op: 'replace', path: 'active', value: true }] })).status).toBe(422);
    expect(await result(await scim(configured, token, `/Users/${inactive.id}`), 200)).toMatchObject({ active: false });
    const jit = await provider('oidc', { token_endpoint_auth_method: 'none', provisioning: 'jit' }, org);
    expect((await oidcCallback(jit, await browserFlow(jit))).status).toBe(422);
    expect(await db.prepare('SELECT seat_count FROM billing_accounts WHERE account_id=?').bind(org.id).first()).toMatchObject({ seat_count: 1 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM memberships WHERE account_id=? AND state='active'").bind(org.id).first()).toMatchObject({ count: 1 });

    const funded = await organization();
    await paidSeats(funded, 10, '12000000000');
    const overBudget = await provider('oidc', { token_endpoint_auth_method: 'none', provisioning: 'scim_only' }, funded);
    const budgetResponse = await scim(overBudget, await provisioningToken(overBudget), '/Users', 'POST', makeBody(true));
    expect(budgetResponse.status).toBeGreaterThanOrEqual(400);
    expect(await db.prepare('SELECT seat_count FROM billing_accounts WHERE account_id=?').bind(funded.id).first()).toMatchObject({ seat_count: 1 });
  }, 30_000);

  it('shares the final paid seat between concurrent SCIM, JIT and invitation acceptance', async () => {
    const org = await organization();
    await paidSeats(org, 2);
    const directory = await provider('oidc', { token_endpoint_auth_method: 'none', provisioning: 'scim_only' }, org);
    const jit = await provider('oidc', { token_endpoint_auth_method: 'none', provisioning: 'jit' }, org);
    const token = await provisioningToken(directory);
    const invitee = await organization();
    const invitation = await result<{ id: string; revision: number }>(await request(`/v1/orgs/${org.id}/invitations`, 'POST',
      { email: `${invitee.user_id}@example.com`, role_id: 'reader' }, adminHeaders(org)), 201);
    const stored = await db.prepare('SELECT key_id,expires_at FROM invitations WHERE id=?').bind(invitation.id).first<{ key_id: string; expires_at: string }>();
    const env = await runtime.getBindings<Bindings>('api');
    const invitationToken = await actionToken(env, { id: invitation.id, purpose: 'invitation', key_id: stored!.key_id, expires_at: stored!.expires_at });
    const quote = await previewSeatChange({ DB: db }, { account_id: org.id, additional_seats: 1 });
    const flow = await browserFlow(jit);
    const acceptInvitation = () => request(`/v1/invitations/${invitation.id}/accept`, 'POST', { token: invitationToken,
      seat_quote: { subscription_revision: quote.subscription_revision, plan_id: quote.plan_id,
        maximum_monthly_units: quote.monthly_delta_units, maximum_current_period_units: quote.maximum_current_period_units } }, adminHeaders(invitee, invitation.revision));
    const responses = await Promise.all([
      scim(directory, token, '/Users', 'POST', { schemas: [SCIM_USER_SCHEMA], externalId: newId('external'), userName: newId('directory'), emails: [{ value: `${newId('person')}@example.com` }] }),
      oidcCallback(jit, flow),
      acceptInvitation(),
    ]);
    expect(responses.filter(response => [200, 201, 303].includes(response.status))).toHaveLength(1);
    for (const response of responses.slice(0, 2)) expect([201, 303, 409, 412, 422, 429], await response.clone().text()).toContain(response.status);
    const inviteResponse = responses[2]!;
    if (inviteResponse.status === 403) {
      // The winner changes the account policy revision while invitation role
      // delegation is being evaluated. Verify its stable retry reaches the seat cap.
      expect(await inviteResponse.json()).toMatchObject({ error: { code: 'role_delegation_denied' } });
      expect((await acceptInvitation()).status).toBe(422);
    } else expect([200, 409, 412, 422, 429], await inviteResponse.clone().text()).toContain(inviteResponse.status);
    expect(await db.prepare('SELECT seat_count FROM billing_accounts WHERE account_id=?').bind(org.id).first()).toMatchObject({ seat_count: 2 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM memberships WHERE account_id=? AND state='active'").bind(org.id).first()).toMatchObject({ count: 2 });
  }, 30_000);

  it('takes over crashed SCIM generations, releases their held seat and fences the old writer', async () => {
    const org = await organization();
    await paidSeats(org, 2);
    const configured = await provider('oidc', { token_endpoint_auth_method: 'none', provisioning: 'scim_only' }, org);
    const token = await provisioningToken(configured);
    const key = 'crashed-directory-create';
    const body = { schemas: [SCIM_USER_SCHEMA], externalId: newId('external'), userName: newId('directory'), emails: [{ value: `${newId('person')}@example.com` }] };
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json', 'idempotency-key': key, 'x-test-after-seat': '1' };
    expect((await request(`/test/scim/${org.id}/crash`, 'POST', body, headers)).status).toBe(503);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM billing_seat_reservations WHERE account_id=? AND state='reserved'").bind(org.id).first()).toMatchObject({ count: 1 });
    const held = await db.prepare('SELECT planned_resource_id FROM federation_scim_requests WHERE account_id=? AND request_key=?').bind(org.id, key).first<{ planned_resource_id: string }>();
    await db.prepare('UPDATE federation_scim_requests SET lease_expires_at=? WHERE account_id=? AND request_key=?')
      .bind(new Date(Date.now() - 1000).toISOString(), org.id, key).run();
    const recovered = await result<{ id: string }>(await scim(configured, token, '/Users', 'POST', body, { 'idempotency-key': key }), 201);
    expect(recovered.id).toBe(held!.planned_resource_id);
    expect(await db.prepare('SELECT generation,status,committed_at,event_id,audit_id FROM federation_scim_requests WHERE account_id=? AND request_key=?').bind(org.id, key).first())
      .toMatchObject({ generation: 2, status: 'complete', committed_at: expect.any(String), event_id: expect.any(String), audit_id: expect.any(String) });
    expect((await request(`/test/scim/${org.id}/stale-writer`, 'POST', undefined, headers)).status).toBe(412);
    expect(await db.prepare('SELECT name FROM federation_providers WHERE id=?').bind(configured.id).first()).toMatchObject({ name: 'Enterprise' });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE type='test.stale_writer'").first()).toMatchObject({ count: 0 });
    expect(await db.prepare('SELECT seat_count FROM billing_accounts WHERE account_id=?').bind(org.id).first()).toMatchObject({ seat_count: 2 });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM billing_seat_reservations WHERE account_id=? AND state='reserved'").bind(org.id).first()).toMatchObject({ count: 0 });
    expect(await result(await scim(configured, token, '/Users', 'POST', body, { 'idempotency-key': key }), 201)).toMatchObject({ id: recovered.id });

    await result(await scim(configured, token, `/Users/${recovered.id}`, 'PATCH', { schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: 'replace', path: 'active', value: false }] }), 200);
    const sweptKey = 'swept-directory-create';
    const sweptBody = { ...body, externalId: newId('external'), userName: newId('directory'), emails: [{ value: `${newId('person')}@example.com` }] };
    const sweptHeaders = { ...headers, 'idempotency-key': sweptKey };
    expect((await request(`/test/scim/${org.id}/crash`, 'POST', sweptBody, sweptHeaders)).status).toBe(503);
    const expired = new Date(Date.now() - 1000).toISOString();
    await db.batch([
      stmt(db, 'UPDATE federation_scim_requests SET lease_expires_at=? WHERE account_id=? AND request_key=?', expired, org.id, sweptKey),
      stmt(db, `UPDATE federation_seat_admissions SET expires_at=? WHERE source_id IN
        (SELECT id FROM federation_scim_requests WHERE account_id=? AND request_key=?)`, expired, org.id, sweptKey),
    ]);
    expect((await request('/test/sweep', 'POST')).status).toBe(204);
    expect(await db.prepare('SELECT generation,status FROM federation_scim_requests WHERE account_id=? AND request_key=?').bind(org.id, sweptKey).first())
      .toMatchObject({ generation: 2, status: 'uncertain' });
    expect((await request(`/test/scim/${org.id}/stale-writer`, 'POST', undefined, sweptHeaders)).status).toBe(412);
    await result(await scim(configured, token, '/Users', 'POST', sweptBody, { 'idempotency-key': sweptKey }), 201);
    expect(await db.prepare('SELECT seat_count FROM billing_accounts WHERE account_id=?').bind(org.id).first()).toMatchObject({ seat_count: 2 });
  }, 30_000);

  it('advances directory ETags for relationship and display changes and releases deleted Group team bindings', async () => {
    const configured = await provider('oidc', { token_endpoint_auth_method: 'none', provisioning: 'scim_only' });
    const token = await provisioningToken(configured);
    const user = await createUser(configured, token);
    const other = await createUser(configured, token);
    const beforeUser = await scim(configured, token, `/Users/${user.id}`);
    const beforeOther = await scim(configured, token, `/Users/${other.id}`);
    const group = await result<{ id: string }>(await scim(configured, token, '/Groups', 'POST', { schemas: [SCIM_GROUP_SCHEMA], externalId: 'engineering', displayName: 'Engineering', members: [{ value: user.id }] }), 201);
    const joined = await scim(configured, token, `/Users/${user.id}`, 'GET', undefined, { 'if-none-match': beforeUser.headers.get('etag')! });
    expect(await result(joined, 200)).toMatchObject({ groups: [{ value: group.id }] });
    expect(joined.headers.get('etag')).not.toBe(beforeUser.headers.get('etag'));
    await result(await scim(configured, token, `/Groups/${group.id}`, 'PATCH', { schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: 'add', path: 'members', value: [{ value: other.id }] }] }), 200);
    expect((await scim(configured, token, `/Users/${other.id}`, 'GET', undefined, { 'if-none-match': beforeOther.headers.get('etag')! })).status).toBe(200);
    await result(await scim(configured, token, `/Groups/${group.id}`, 'PATCH', { schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: 'replace', path: 'displayName', value: 'Renamed Engineering' }] }), 200);
    expect(await result(await scim(configured, token, `/Users/${user.id}`, 'GET', undefined, { 'if-none-match': joined.headers.get('etag')! }), 200))
      .toMatchObject({ groups: [{ display: 'Renamed Engineering' }] });
    const oldGroup = await scim(configured, token, `/Groups/${group.id}`);
    const userName = newId('renamed');
    await result(await scim(configured, token, `/Users/${user.id}`, 'PATCH', { schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: 'replace', path: 'userName', value: userName }] }), 200);
    const renamed = await scim(configured, token, `/Groups/${group.id}`, 'GET', undefined, { 'if-none-match': oldGroup.headers.get('etag')! });
    const renamedBody = await result<{ members: { value: string; display: string }[] }>(renamed, 200);
    expect(renamedBody.members.find(member => member.value === user.id)?.display).toBe(userName);
    expect((await scim(configured, token, `/Users/${user.id}`, 'DELETE')).status).toBe(204);
    expect(await result(await scim(configured, token, `/Groups/${group.id}`, 'GET', undefined, { 'if-none-match': renamed.headers.get('etag')! }), 200))
      .toMatchObject({ members: [{ value: other.id }] });
    const occupied = await scim(configured, token, `/Users/${other.id}`);
    expect((await scim(configured, token, `/Groups/${group.id}`, 'DELETE')).status).toBe(204);
    expect(await result(await scim(configured, token, `/Users/${other.id}`, 'GET', undefined, { 'if-none-match': occupied.headers.get('etag')! }), 200)).toMatchObject({ groups: [] });
    const replacement = await result<{ id: string }>(await scim(configured, token, '/Groups', 'POST', { schemas: [SCIM_GROUP_SCHEMA], externalId: 'engineering', displayName: 'Replacement', members: [{ value: other.id }] }), 201);
    expect(replacement.id).not.toBe(group.id);
    expect((await scim(configured, token, `/Groups/${replacement.id}`, 'DELETE')).status).toBe(204);
    await db.prepare('DELETE FROM teams WHERE id=? AND account_id=?').bind(configured.organization.team_id, configured.organization.id).run();
    expect(await db.prepare('SELECT team_id FROM federation_scim_groups WHERE id=?').bind(group.id).first()).toMatchObject({ team_id: configured.organization.team_id });
  }, 30_000);

  it('normalizes PATCH primary values between operations and projects complex arrays without leaking sibling fields', async () => {
    const configured = await provider('oidc', { token_endpoint_auth_method: 'none', provisioning: 'scim_only' });
    const token = await provisioningToken(configured);
    const work = `${newId('work')}@example.com`;
    const home = `${newId('home')}@example.com`;
    const user = await result<{ id: string }>(await scim(configured, token, '/Users', 'POST', { schemas: [SCIM_USER_SCHEMA], externalId: newId('external'), userName: newId('directory'),
      emails: [{ value: work, type: 'work', primary: true }, { value: home, type: 'home', primary: false }] }), 201);
    const changed = await result<{ emails: ScimObject[] }>(await scim(configured, token, `/Users/${user.id}`, 'PATCH', { schemas: [SCIM_PATCH_SCHEMA], Operations: [
      { op: 'replace', path: 'emails[type eq "home"].primary', value: true },
      { op: 'replace', path: 'emails[primary eq false].type', value: 'other' },
    ] }), 200);
    expect(changed.emails).toEqual([{ value: work, type: 'other', primary: false }, { value: home, type: 'home', primary: true }]);
    const included = await result<{ emails: ScimObject[] }>(await scim(configured, token, `/Users/${user.id}?attributes=emails.value`), 200);
    expect(included.emails).toEqual([{ value: work }, { value: home }]);
    const excluded = await result<{ emails: ScimObject[] }>(await scim(configured, token, `/Users/${user.id}?excludedAttributes=emails.primary`), 200);
    expect(excluded.emails).toEqual([{ value: work, type: 'other' }, { value: home, type: 'home' }]);
    const list = await result<{ Resources: { emails: ScimObject[] }[] }>(await scim(configured, token, '/Users?attributes=emails.value,emails.type'), 200);
    expect(list.Resources[0]!.emails).toEqual(excluded.emails);
  }, 20_000);

  it('removes cleared SSO team mappings and deprovisions only the affected organization credential families', async () => {
    const orgA = await organization();
    const orgB = await organization();
    const a = await provider('oidc', { token_endpoint_auth_method: 'none', mappings: { default_role_id: 'member', role_ceiling: ['member'], capability_ceiling: ['*'],
      group_claim: 'groups', team_ceiling: [orgA.team_id], team_mappings: [{ value: 'engineering', team_id: orgA.team_id }] } }, orgA);
    const claims = { sub: newId('subject'), oid: newId('external'), email: `${newId('shared')}@example.com`, groups: ['engineering'] };
    const loggedA = await oidcCallback(a, await browserFlow(a), claims);
    expect(loggedA.status, await loggedA.clone().text()).toBe(303);
    const cookieA = cookie(loggedA as unknown as { headers: Headers }, '__Host-gitknot_session=');
    const user = await result<{ id: string }>(await request('/test/principal', 'GET', undefined, { cookie: cookieA }), 200);
    const local = await prepareCredential(db, { principal_id: user.id, user_id: user.id, kind: 'session', name: 'Independent MFA fixture', capabilities: null,
      repository_ids: null, account_ids: null, auth_revision: 1, mfa: true, created_by: user.id, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    await db.batch([stmt(db, 'UPDATE users SET password_hash=? WHERE id=?', 'independent-recovery-fixture', user.id), local.statement]);
    const b = await provider('oidc', { token_endpoint_auth_method: 'none', provisioning: 'scim_only' }, orgB);
    const link = await oidcCallback(b, await browserFlow(b, true, `__Host-gitknot_session=${local.token}`), claims);
    expect(link.status, await link.clone().text()).toBe(303);
    const tokenB = await provisioningToken(b);
    await result(await scim(b, tokenB, '/Users', 'POST', { schemas: [SCIM_USER_SCHEMA], externalId: claims.oid, userName: newId('directory'), emails: [{ value: claims.email }] }), 201);
    const loggedB = await oidcCallback(b, await browserFlow(b), claims);
    expect(loggedB.status, await loggedB.clone().text()).toBe(303);
    const cookieB = cookie(loggedB as unknown as { headers: Headers }, '__Host-gitknot_session=');
    const pat = await prepareCredential(db, { principal_id: user.id, user_id: user.id, kind: 'personal', name: 'B-only automation', capabilities: ['contents.read'],
      repository_ids: null, account_ids: [orgB.id], auth_revision: 1, mfa: true, created_by: user.id, parent_id: local.credential.id,
      expires_at: new Date(Date.now() + 3600_000).toISOString() });
    await pat.statement.run();
    await result(await request(`${providerBase(b)}/credentials/${pat.credential.id}/authorize`, 'POST', undefined,
      { cookie: cookieB, origin: appOrigin, 'x-gitknot-csrf': '1', 'if-match': '"1"' }), 200);
    const repoId = newId('r');
    await db.batch([
      stmt(db, `INSERT INTO repositories(id,owner_id,name,slug,description,visibility,default_branch,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,'private','main','active','test','test',?,?,?,?)`, repoId, orgA.id, 'Team private', repoId, '', repoId, orgA.user_id, now(), now()),
      stmt(db, `INSERT INTO access_grants(id,account_id,repo_id,principal_type,principal_id,role_id,effect,conditions_json,created_by,created_at,updated_at)
        VALUES (?,?,?,'team',?,'reader','allow','{}',?,?,?)`, newId('grant'), orgA.id, repoId, orgA.team_id, orgA.user_id, now(), now()),
    ]);
    expect((await request(`/test/repositories/${repoId}/permission`, 'GET', undefined, { cookie: cookieA })).status).toBe(200);
    await updateMappings(a, { group_claim: null, team_mappings: [], team_ceiling: [] });
    const freshA = await oidcCallback(a, await browserFlow(a), claims);
    expect(freshA.status, await freshA.clone().text()).toBe(303);
    const renewedA = cookie(freshA as unknown as { headers: Headers }, '__Host-gitknot_session=');
    expect([403, 404]).toContain((await request(`/test/repositories/${repoId}/permission`, 'GET', undefined, { cookie: renewedA })).status);
    const tokenA = await provisioningToken(a);
    const directoryA = await result<{ id: string }>(await scim(a, tokenA, '/Users', 'POST', { schemas: [SCIM_USER_SCHEMA], externalId: claims.oid,
      userName: newId('directory'), emails: [{ value: claims.email }] }), 201);
    const deactivate = { schemas: [SCIM_PATCH_SCHEMA], Operations: [{ op: 'replace', path: 'active', value: false }] };
    await result(await scim(a, tokenA, `/Users/${directoryA.id}`, 'PATCH', deactivate), 200);
    await result(await scim(a, tokenA, `/Users/${directoryA.id}`, 'PATCH', deactivate), 200);
    expect((await scim(a, tokenA, `/Users/${directoryA.id}`, 'DELETE')).status).toBe(204);
    expect((await request('/test/principal', 'GET', undefined, { cookie: renewedA })).status).toBe(401);
    expect((await request(`/test/organizations/${orgB.id}/permission`, 'GET', undefined, { cookie: cookieB })).status).toBe(200);
    expect((await request(`/test/organizations/${orgB.id}/permission`, 'GET', undefined, { authorization: `Bearer ${pat.token}` })).status).toBe(200);
    expect(await db.prepare('SELECT seat_count FROM billing_accounts WHERE account_id=?').bind(orgA.id).first()).toMatchObject({ seat_count: 1 });
    expect(await db.prepare('SELECT seat_count FROM billing_accounts WHERE account_id=?').bind(orgB.id).first()).toMatchObject({ seat_count: 2 });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM billing_seat_events WHERE account_id=? AND principal_id=? AND delta=-1').bind(orgA.id, user.id).first()).toMatchObject({ count: 1 });
    await db.prepare('UPDATE credentials SET revoked_at=?,revision=revision+1 WHERE id=?').bind(now(), local.credential.id).run();
    expect((await request('/test/principal', 'GET', undefined, { authorization: `Bearer ${pat.token}` })).status).toBe(401);
    expect((await request('/test/principal', 'GET', undefined, { cookie: cookieB })).status).toBe(200);
  }, 30_000);

  it('authenticates private broker purpose/body/nonces and rejects ciphertext transplant', async () => {
    const configured = await provider();
    const privateWorker = await runtime.getWorker('rewrapper');
    const privateCall = async (request: { url: string; method: string; headers: Headers; text(): Promise<string> }) => privateWorker.fetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() });
    const before = await db.prepare('SELECT id,ciphertext FROM federation_client_secrets WHERE provider_id=? AND revoked_at IS NULL').bind(configured.id).first<{ id: string; ciphertext: string }>();
    const body = { after: '', limit: 100 };
    const signed = await signInternalRequest(new Request('https://internal.gitknot.com/internal/federation/rewrap', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gitknot-service-client': 'rotation' }, body: JSON.stringify(body) }), rotationKey, 'federation.rotate');
    const accepted = await privateCall(signed.clone());
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect((await accepted.json() as { rewrapped: number }).rewrapped).toBeGreaterThan(0);
    expect(await db.prepare('SELECT ciphertext FROM federation_client_secrets WHERE id=?').bind(before!.id).first()).toMatchObject({ ciphertext: before!.ciphertext });
    expect(await db.prepare('SELECT kek_id FROM federation_secret_wraps WHERE secret_id=? ORDER BY version DESC LIMIT 1').bind(before!.id).first()).toMatchObject({ kek_id: 'current' });
    const rewrappedSignIn = await oidcCallback(configured, await browserFlow(configured));
    expect(rewrappedSignIn.status, await rewrappedSignIn.clone().text()).toBe(303);
    expect((await privateCall(signed.clone())).status).toBe(409);
    const forged = new Request(signed, { body: JSON.stringify({ limit: 1 }) });
    expect([401, 409]).toContain((await privateCall(forged)).status);
    await db.prepare('UPDATE federation_client_secrets SET context_json=? WHERE provider_id=?').bind('{}', configured.id).run();
    const response = await oidcCallback(configured, await browserFlow(configured));
    expect(response.status).toBe(503);
    expect((await db.prepare('SELECT COUNT(*) AS count FROM federation_subjects WHERE provider_id=?').bind(configured.id).first<{ count: number }>())?.count).toBe(1);
  }, 20_000);
});
