import { createPrivateKey, createPublicKey, sign, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  ApiError, base64url, bytes, canonicalJson, credentialIsCurrent, credentialScope, fromBase64url,
  hmac, many, newId, now, one, readBounded, sha256, stmt, verifyInternalRequest,
} from '@gitknot/core';
import type { AppContext, AppEnv, Bindings, CredentialRecord, Database, Principal, PrincipalKind } from '@gitknot/core';
import { administratorGuard, requireFederationAdministrator } from './integration.ts';
import { integrationUnavailable, authenticationFailed } from './errors.ts';
import { requestOidcTokens } from './oidc.ts';
import { samlRedirectParameters, samlRedirectUrl } from './saml.ts';
import { condition, federationAudit, federationBatch, getProvider, guarded, providerGuard } from './store.ts';
import type { FederationBrokerScope } from './broker-client.ts';
import type { AuthenticationFlow, FederationSecretKind, FederationSecretRow, Provider } from './types.ts';
import { validateSigningCertificate } from './xml.ts';
import { secretBinding } from '../../secrets/src/crypto.ts';

const resource = { account_id: z.string().regex(/^org_[\w-]{8,100}$/), provider_id: z.string().regex(/^idp_[\w-]{8,100}$/) };
const management = { ...resource, credential_id: z.string().min(1).max(128), expected_revision: z.number().int().positive(), operation_id: z.string().regex(/^[a-f0-9]{64}$/) };
const sealSchema = z.object({ ...management, kind: z.enum(['oidc_client_secret', 'saml_signing_key']),
  secret: z.string().min(1).max(16_384), public_certificate: z.string().max(16_384).optional() }).strict();
const revokeSchema = z.object({ ...management, kind: z.enum(['oidc_client_secret', 'saml_signing_key']) }).strict();
const exchangeSchema = z.object({ ...resource, flow_id: z.string().max(128), code: z.string().min(1).max(4096) }).strict();
const signSchema = z.object({ ...resource, flow_id: z.string().max(128), state: z.string().regex(/^[\w-]{43}$/) }).strict();
const rotateSchema = z.object({ after: z.string().max(128).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict();

interface Keyring { current: string; keys: Record<string, Uint8Array<ArrayBuffer>> }
interface Wrap { version: number; kek_id: string; wrapped_key: string; wrap_iv: string }
interface BrokerClient { id: string; key: string; scopes: string[]; account_ids: string[] | null; repository_ids: string[] | null }
const callers = new WeakMap<Request, BrokerClient>();

async function privateBinding(value: unknown): Promise<string> {
  if (typeof value === 'string') return secretBinding(value);
  if (value && typeof value === 'object' && 'get' in value && typeof value.get === 'function') return secretBinding(value as { get(): Promise<string> });
  throw integrationUnavailable();
}

async function keyring(env: Bindings): Promise<Keyring> {
  try {
    const raw: unknown = JSON.parse(await privateBinding(env.SECRETS_KEK_KEYRING_JSON));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 32) throw new Error('Invalid keyring');
    const keys: Record<string, Uint8Array<ArrayBuffer>> = Object.create(null) as Record<string, Uint8Array<ArrayBuffer>>;
    for (const [id, value] of Object.entries(raw)) {
      if (!/^[\w-]{1,64}$/.test(id) || typeof value !== 'string') throw new Error('Invalid key');
      const decoded = fromBase64url(value);
      if (decoded.byteLength !== 32 || base64url(decoded) !== value || new Set(decoded).size < 16) throw new Error('Invalid key');
      if (Object.values(keys).some(key => base64url(key) === value)) throw new Error('Duplicate key');
      keys[id] = decoded;
    }
    if (typeof env.SECRETS_KEK_CURRENT_ID !== 'string' || !Object.hasOwn(keys, env.SECRETS_KEK_CURRENT_ID)) throw new Error('Current key missing');
    return { current: env.SECRETS_KEK_CURRENT_ID, keys };
  } catch { throw integrationUnavailable(); }
}

function encryptionContext(provider: Provider, kind: FederationSecretKind, id: string, version: number): string {
  return canonicalJson({ version: 1, purpose: 'GitKnot federation secret', account_id: provider.account_id, provider_id: provider.id,
    secret_id: id, secret_version: version, kind, issuer: provider.config.issuer,
    ...(provider.config.protocol === 'oidc' ? { client_id: provider.config.client_id, token_endpoint: provider.config.token_endpoint } : {}) });
}

async function aesKey(value: Uint8Array<ArrayBuffer>, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', value, 'AES-GCM', false, usage);
}

async function seal(env: Bindings, provider: Provider, kind: FederationSecretKind, version: number, plaintext: string, publicCertificate: string | null): Promise<FederationSecretRow> {
  const ring = await keyring(env);
  const id = newId('fsec');
  const context = encryptionContext(provider, kind, id, version);
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const input = bytes(plaintext);
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: bytes(`payload\n${context}`), tagLength: 128 }, await aesKey(dek, ['encrypt']), input);
    const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv, additionalData: bytes(`wrap\n${context}`), tagLength: 128 }, await aesKey(ring.keys[ring.current]!, ['encrypt']), dek);
    return { id, account_id: provider.account_id, provider_id: provider.id, kind, version, context_json: context,
      ciphertext: base64url(new Uint8Array(ciphertext)), iv: base64url(iv), wrapped_key: base64url(new Uint8Array(wrapped)),
      wrap_iv: base64url(wrapIv), kek_id: ring.current, public_certificate: publicCertificate, created_at: now(), revoked_at: null };
  } finally { dek.fill(0); input.fill(0); }
}

async function currentWrap(db: Database, row: FederationSecretRow): Promise<Wrap> {
  return await one<Wrap>(db, `SELECT version,kek_id,wrapped_key,wrap_iv FROM federation_secret_wraps
    WHERE secret_id=? AND account_id=? AND provider_id=? ORDER BY version DESC LIMIT 1`, row.id, row.account_id, row.provider_id)
    ?? { version: 1, kek_id: row.kek_id, wrapped_key: row.wrapped_key, wrap_iv: row.wrap_iv };
}

async function unwrap(env: Bindings, row: FederationSecretRow, wrap: Wrap): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const ring = await keyring(env);
    if (!Object.hasOwn(ring.keys, wrap.kek_id)) throw new Error('Missing wrapping key');
    const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64url(wrap.wrap_iv),
      additionalData: bytes(`wrap\n${row.context_json}`), tagLength: 128 }, await aesKey(ring.keys[wrap.kek_id]!, ['decrypt']), fromBase64url(wrap.wrapped_key));
    if (raw.byteLength !== 32) throw new Error('Invalid data key');
    return new Uint8Array(raw);
  } catch { throw integrationUnavailable(); }
}

async function open(env: Bindings, provider: Provider, kind: FederationSecretKind): Promise<string> {
  const row = await one<FederationSecretRow>(env.DB, `SELECT * FROM federation_client_secrets
    WHERE account_id=? AND provider_id=? AND kind=? AND revoked_at IS NULL`, provider.account_id, provider.id, kind);
  if (!row || row.context_json !== encryptionContext(provider, row.kind, row.id, row.version)) throw integrationUnavailable();
  const dek = await unwrap(env, row, await currentWrap(env.DB, row));
  let value: Uint8Array<ArrayBuffer> | undefined;
  try {
    value = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64url(row.iv),
      additionalData: bytes(`payload\n${row.context_json}`), tagLength: 128 }, await aesKey(dek, ['decrypt']), fromBase64url(row.ciphertext)));
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch { throw integrationUnavailable(); }
  finally { dek.fill(0); value?.fill(0); }
}

async function authenticateBroker(request: Request, env: Bindings, scope: FederationBrokerScope): Promise<void> {
  const id = request.headers.get('x-gitknot-service-client');
  if (!id || !/^[\w-]{1,64}$/.test(id)) throw new ApiError(401, 'broker_authentication_required', 'Private federation service authentication is required.');
  let configured: BrokerClient;
  try {
    // Separate purpose grants leave the vault's independently validated scope catalog intact.
    const clients: unknown = JSON.parse(await privateBinding(env.SECRETS_FEDERATION_SERVICE_KEYS_JSON));
    if (!clients || typeof clients !== 'object' || Array.isArray(clients) || !Object.hasOwn(clients, id)) throw new Error('Unknown client');
    const schema = z.object({ key: z.string().regex(/^[\w-]{43,128}$/),
      scopes: z.array(z.enum(['federation.manage', 'federation.exchange', 'federation.sign', 'federation.rotate'])).min(1).max(4),
      account_ids: z.array(z.string()).max(256).nullable().default(null), repository_ids: z.array(z.string()).max(256).nullable().default(null) }).strict();
    const entries = Object.entries(clients).map(([clientId, config]) => ({ id: clientId, ...schema.parse(config) }));
    if (entries.length > 32 || new Set(entries.map(value => value.key)).size !== entries.length
      || entries.some(value => new Set(value.key).size < 16 || /placeholder|changeme|example/i.test(value.key))) throw new Error('Invalid client keys');
    configured = entries.find(value => value.id === id)!;
  } catch { throw integrationUnavailable(); }
  if (!configured.scopes.includes(scope)) throw new ApiError(403, 'broker_scope_denied', 'The private service credential does not permit this operation.');
  await verifyInternalRequest(request, configured.key, scope, { database: env.DB });
  callers.set(request, configured);
}

async function brokerBody<S extends z.ZodType>(c: AppContext, schema: S, scope: FederationBrokerScope): Promise<z.infer<S>> {
  c.set('requestId', newId('req'));
  c.set('principal', null);
  if (!/^application\/json(?:;|$)/i.test(c.req.header('content-type') ?? '')) throw new ApiError(415, 'json_required', 'Use JSON for private service requests.');
  await authenticateBroker(c.req.raw, c.env, scope);
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(c.req.raw.body, 65_536))); }
  catch { throw new ApiError(400, 'invalid_json', 'The private service request is invalid.'); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiError(422, 'invalid_federation_request', 'The private service request is invalid.');
  const caller = callers.get(c.req.raw)!;
  const accountId = parsed.data && typeof parsed.data === 'object' && 'account_id' in parsed.data ? parsed.data.account_id : null;
  if (caller.repository_ids !== null || (accountId !== null && caller.account_ids !== null && !caller.account_ids.includes(String(accountId)))) {
    throw new ApiError(403, 'broker_resource_scope_denied', 'The service credential does not permit this organization resource.');
  }
  return parsed.data;
}

async function delegateAdministrator(c: AppContext, accountId: string, credentialId: string): Promise<Principal> {
  const credential = await one<CredentialRecord>(c.env.DB, 'SELECT * FROM credentials WHERE id=?', credentialId);
  if (!credential || credential.kind !== 'session' || !await credentialIsCurrent(c.env.DB, credential)) throw new ApiError(403, 'broker_actor_invalid', 'The authorizing session is no longer current.');
  const actor = await one<{ id: string; kind: PrincipalKind; user_id: string | null }>(c.env.DB,
    'SELECT id,kind,user_id FROM principals WHERE id=? AND disabled_at IS NULL', credential.principal_id);
  if (!actor) throw new ApiError(403, 'broker_actor_invalid', 'The authorizing identity is no longer current.');
  const principal: Principal = { ...actor, credential_id: credential.id, capabilities: credentialScope(credential.capabilities_json),
    repository_ids: credentialScope(credential.repository_ids_json), account_ids: credentialScope(credential.account_ids_json), mfa: credential.mfa === 1 };
  c.set('principal', principal);
  await requireFederationAdministrator(c, accountId, true);
  return principal;
}

function validateSecret(provider: Provider, kind: FederationSecretKind, secret: string, certificate?: string): string | null {
  if (kind === 'oidc_client_secret') {
    if (provider.config.protocol !== 'oidc' || provider.config.token_endpoint_auth_method === 'none' || secret.length > 8192 || /[\x00\r\n]/.test(secret) || certificate !== undefined) {
      throw new ApiError(422, 'oidc_secret_invalid', 'This provider requires a valid confidential OIDC client secret.');
    }
    return null;
  }
  if (provider.config.protocol !== 'saml' || !certificate) throw new ApiError(422, 'saml_key_invalid', 'A SAML private signing key and its public certificate are required.');
  const cert = validateSigningCertificate(certificate);
  try {
    const key = createPrivateKey(secret);
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('Invalid key');
    const a = createPublicKey(key).export({ type: 'spki', format: 'der' });
    const b = cert.publicKey.export({ type: 'spki', format: 'der' });
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Key mismatch');
    return cert.toString();
  } catch { throw new ApiError(422, 'saml_key_invalid', 'The private key must match the currently valid RSA signing certificate.'); }
}

interface BrokerOperation {
  id: string; account_id: string; provider_id: string; actor_id: string; client_id: string; request_hash: string;
}

async function operationReplay(db: Database, operation: BrokerOperation): Promise<Record<string, unknown> | null> {
  const previous = await one<{ request_hash: string; response_json: string }>(db, `SELECT request_hash,response_json FROM federation_secret_operations
    WHERE id=? AND account_id=? AND provider_id=? AND actor_id=? AND client_id=?`, operation.id, operation.account_id, operation.provider_id, operation.actor_id, operation.client_id);
  if (!previous) return null;
  if (previous.request_hash !== operation.request_hash) throw new ApiError(409, 'idempotency_conflict', 'This federation secret operation has different inputs.');
  return JSON.parse(previous.response_json) as Record<string, unknown>;
}

async function brokerOperation(c: AppContext, actor: Principal, action: string,
  input: { account_id: string; provider_id: string; operation_id: string; credential_id: string }): Promise<BrokerOperation> {
  const client = callers.get(c.req.raw);
  if (!client) throw integrationUnavailable();
  // Current administrative authorization is checked separately. The durable
  // outcome survives reauthentication by the same human without storing secrets.
  const { credential_id, ...body } = input;
  void credential_id;
  return { id: `fop_${await sha256([client.id, actor.id, action, input.operation_id].join('\n'))}`,
    account_id: input.account_id, provider_id: input.provider_id, actor_id: actor.id, client_id: client.id,
    request_hash: await hmac(client.key, canonicalJson({ action, ...body })) };
}

async function commitBrokerOperation(c: AppContext, operation: BrokerOperation, response: Record<string, unknown>,
  statements: D1PreparedStatement[]): Promise<Record<string, unknown>> {
  try {
    await federationBatch(c.env.DB, [...statements, stmt(c.env.DB, `INSERT INTO federation_secret_operations
      (id,account_id,provider_id,actor_id,client_id,request_hash,response_json,created_at) VALUES (?,?,?,?,?,?,?,?)`,
    operation.id, operation.account_id, operation.provider_id, operation.actor_id, operation.client_id, operation.request_hash, JSON.stringify(response), now())]);
    return response;
  } catch (error) {
    const previous = await operationReplay(c.env.DB, operation);
    if (previous) return previous;
    throw error;
  }
}

async function storeSecret(c: AppContext): Promise<Response> {
  const body = await brokerBody(c, sealSchema, 'federation.manage');
  const actor = await delegateAdministrator(c, body.account_id, body.credential_id);
  const provider = await getProvider(c.env.DB, body.provider_id, body.account_id);
  const operation = await brokerOperation(c, actor, 'rotate', body);
  const replay = await operationReplay(c.env.DB, operation);
  if (replay) return c.json(replay);
  if (provider.revision !== body.expected_revision) throw new ApiError(412, 'revision_conflict', 'The provider configuration changed.');
  const publicCertificate = validateSecret(provider, body.kind, body.secret, body.public_certificate);
  const previous = await one<{ version: number }>(c.env.DB,
    'SELECT MAX(version) AS version FROM federation_client_secrets WHERE account_id=? AND provider_id=? AND kind=?', body.account_id, body.provider_id, body.kind);
  const row = await seal(c.env, provider, body.kind, (previous?.version ?? 0) + 1, body.secret, publicCertificate);
  const response = { configured: true, kind: body.kind, version: row.version, provider_revision: provider.revision + 1, public_certificate: publicCertificate };
  return c.json(await commitBrokerOperation(c, operation, response, [
    ...administratorGuard(c.env.DB, actor, body.account_id), ...providerGuard(c.env.DB, provider, false),
    ...guarded(c.env.DB, stmt(c.env.DB, 'UPDATE federation_providers SET revision=revision+1,updated_at=? WHERE account_id=? AND id=? AND revision=?', now(), body.account_id, body.provider_id, body.expected_revision)),
    stmt(c.env.DB, 'UPDATE federation_client_secrets SET revoked_at=? WHERE account_id=? AND provider_id=? AND kind=? AND revoked_at IS NULL', now(), body.account_id, body.provider_id, body.kind),
    stmt(c.env.DB, `INSERT INTO federation_client_secrets(id,account_id,provider_id,kind,version,context_json,ciphertext,iv,wrapped_key,wrap_iv,kek_id,public_certificate,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, row.id, row.account_id, row.provider_id, row.kind, row.version, row.context_json, row.ciphertext,
    row.iv, row.wrapped_key, row.wrap_iv, row.kek_id, row.public_certificate, row.created_at),
    ...federationAudit(c.env.DB, actor, c.get('requestId'), body.account_id, 'federation.secret.rotated', body.provider_id, provider.revision + 1, { kind: body.kind, version: row.version }),
  ]));
}

async function revokeSecret(c: AppContext): Promise<Response> {
  const body = await brokerBody(c, revokeSchema, 'federation.manage');
  const actor = await delegateAdministrator(c, body.account_id, body.credential_id);
  await getProvider(c.env.DB, body.provider_id, body.account_id);
  const operation = await brokerOperation(c, actor, 'revoke', body);
  const replay = await operationReplay(c.env.DB, operation);
  if (replay) return c.json(replay);
  return c.json(await commitBrokerOperation(c, operation, { configured: false, provider_revision: body.expected_revision + 1 }, [
    ...administratorGuard(c.env.DB, actor, body.account_id),
    ...guarded(c.env.DB, stmt(c.env.DB, 'UPDATE federation_providers SET enabled=0,revision=revision+1,updated_at=? WHERE account_id=? AND id=? AND revision=? AND deleted_at IS NULL', now(), body.account_id, body.provider_id, body.expected_revision)),
    stmt(c.env.DB, 'UPDATE federation_client_secrets SET revoked_at=? WHERE account_id=? AND provider_id=? AND kind=? AND revoked_at IS NULL', now(), body.account_id, body.provider_id, body.kind),
    ...federationAudit(c.env.DB, actor, c.get('requestId'), body.account_id, 'federation.secret.revoked', body.provider_id, body.expected_revision + 1, { kind: body.kind }),
  ]));
}

async function exchangeCode(c: AppContext): Promise<Response> {
  const body = await brokerBody(c, exchangeSchema, 'federation.exchange');
  const provider = await getProvider(c.env.DB, body.provider_id, body.account_id, true);
  if (provider.config.protocol !== 'oidc' || provider.config.token_endpoint_auth_method === 'none') throw authenticationFailed();
  const flow = await one<AuthenticationFlow>(c.env.DB, `UPDATE federation_auth_flows SET exchange_started_at=?
    WHERE id=? AND account_id=? AND provider_id=? AND provider_revision=? AND protocol='oidc' AND consumed_at IS NOT NULL
      AND completed_at IS NULL AND exchange_started_at IS NULL AND expires_at>? RETURNING *`,
  now(), body.flow_id, body.account_id, body.provider_id, provider.revision, now());
  if (!flow) throw authenticationFailed();
  try {
    const secret = await open(c.env, provider, 'oidc_client_secret');
    return c.json(await requestOidcTokens(c.env, provider, flow, body.code, secret));
  } finally {
    await stmt(c.env.DB, 'UPDATE federation_auth_flows SET pkce_verifier=NULL WHERE id=? AND account_id=? AND provider_id=?', flow.id, flow.account_id, flow.provider_id).run();
  }
}

async function signRequest(c: AppContext): Promise<Response> {
  const body = await brokerBody(c, signSchema, 'federation.sign');
  const provider = await getProvider(c.env.DB, body.provider_id, body.account_id, true);
  if (provider.config.protocol !== 'saml' || !provider.config.sign_authn_requests) throw authenticationFailed();
  const flow = await one<AuthenticationFlow>(c.env.DB, `SELECT * FROM federation_auth_flows WHERE id=? AND account_id=? AND provider_id=?
    AND provider_revision=? AND protocol='saml' AND consumed_at IS NULL AND expires_at>? AND state_hash=?`,
  body.flow_id, body.account_id, body.provider_id, provider.revision, now(), await sha256(body.state));
  if (!flow) throw authenticationFailed();
  const privateKey = await open(c.env, provider, 'saml_signing_key');
  const parameters = samlRedirectParameters(c.env, provider, flow, body.state, true);
  const signature = Buffer.from(sign('RSA-SHA256', bytes(parameters), createPrivateKey(privateKey))).toString('base64');
  return c.json({ redirect_url: samlRedirectUrl(c.env, provider, parameters, signature) });
}

async function rotateWrappingKeys(c: AppContext): Promise<Response> {
  const body = await brokerBody(c, rotateSchema, 'federation.rotate');
  const ring = await keyring(c.env);
  const accounts = callers.get(c.req.raw)!.account_ids;
  const rows = await many<FederationSecretRow>(c.env.DB, `SELECT * FROM federation_client_secrets WHERE id>?
    ${accounts === null ? '' : 'AND account_id IN (SELECT value FROM json_each(?))'} ORDER BY id LIMIT ?`,
  body.after ?? '', ...(accounts === null ? [] : [JSON.stringify(accounts)]), body.limit + 1);
  let rewrapped = 0;
  for (const row of rows.slice(0, body.limit)) {
    const wrap = await currentWrap(c.env.DB, row);
    if (wrap.kek_id === ring.current) continue;
    const dek = await unwrap(c.env, row, wrap);
    try {
      // Verify retained payload integrity before recording a recoverable new wrap.
      const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64url(row.iv),
        additionalData: bytes(`payload\n${row.context_json}`), tagLength: 128 }, await aesKey(dek, ['decrypt']), fromBase64url(row.ciphertext)));
      plaintext.fill(0);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: bytes(`wrap\n${row.context_json}`), tagLength: 128 }, await aesKey(ring.keys[ring.current]!, ['encrypt']), dek);
      await federationBatch(c.env.DB, [
        ...condition(c.env.DB, 'COALESCE((SELECT MAX(version) FROM federation_secret_wraps WHERE secret_id=?),1)=?', row.id, wrap.version),
        stmt(c.env.DB, 'INSERT INTO federation_secret_wraps(id,secret_id,account_id,provider_id,version,kek_id,wrapped_key,wrap_iv,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          newId('fwrap'), row.id, row.account_id, row.provider_id, wrap.version + 1, ring.current, base64url(new Uint8Array(wrapped)), base64url(iv), now()),
        ...federationAudit(c.env.DB, null, c.get('requestId'), row.account_id, 'federation.secret.rewrapped', row.id, wrap.version + 1,
          { provider_id: row.provider_id, key_id: ring.current }),
      ]);
      rewrapped++;
    } finally { dek.fill(0); }
  }
  return c.json({ rewrapped, next_cursor: rows.length > body.limit ? rows[body.limit - 1]!.id : null });
}

const broker = new Hono<AppEnv>();
broker.use('*', async (c, next) => { c.header('cache-control', 'no-store'); await next(); });
broker.post('/internal/federation/secrets', storeSecret);
broker.post('/internal/federation/secrets/revoke', revokeSecret);
broker.post('/internal/federation/exchange', exchangeCode);
broker.post('/internal/federation/sign', signRequest);
broker.post('/internal/federation/rewrap', rotateWrappingKeys);
broker.notFound(c => c.json({ error: { code: 'not_found', message: 'The private service operation was not found.' } }, 404));
broker.onError((error, c) => c.json({ error: { code: error instanceof ApiError ? error.code : 'federation_unavailable',
  message: error instanceof ApiError ? error.message : 'The private federation service is unavailable.' } },
  (error instanceof ApiError ? error.status : 503) as 400));

/** Mount only on the private SECRETS service binding; never on the public API Worker. */
export function handleFederationBrokerRequest(request: Request, env: Bindings, context?: ExecutionContext): Response | Promise<Response> {
  return broker.fetch(request, env, context);
}
