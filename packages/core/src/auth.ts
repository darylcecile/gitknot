import { scrypt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { identityBinding, identityDatabase } from './authority/identity.ts';
import { assertFederationIdentityContract, federationCredentialStatements, isFederationSession, restrictFederatedPrincipal } from '@gitknot/federation/integration';
import { base64url, bytes, fromBase64url, hmac, newId, now, randomToken, sha256 } from './crypto.ts';
import { many, one, stmt } from './db.ts';
import { ApiError } from './errors.ts';
import type { AppContext, Bindings, Database, Principal, PrincipalKind } from './types.ts';

export { federationCredentialStatements, isFederationSession } from '@gitknot/federation/integration';

export const credentialKinds = ['session', 'personal', 'installation', 'service', 'agent', 'runner', 'job', 'viewer'] as const;
export type CredentialKind = typeof credentialKinds[number];

export interface UserRecord {
  id: string;
  username: string;
  email: string;
  display_name: string;
  bio: string;
  avatar_url: string | null;
  password_hash: string | null;
  email_verified_at: string | null;
  disabled_at: string | null;
  profile_visibility: 'public' | 'private';
  show_email: number;
  mfa_required: number;
  auth_revision: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface CredentialRecord {
  id: string;
  principal_id: string;
  user_id: string | null;
  kind: CredentialKind;
  name: string;
  token_hash: string;
  token_prefix: string;
  capabilities_json: string | null;
  repository_ids_json: string | null;
  account_ids_json: string | null;
  ref_patterns_json: string | null;
  path_patterns_json: string | null;
  parent_id: string | null;
  rotation_of_id: string | null;
  auth_revision: number | null;
  mfa: number;
  authenticated_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
  revision: number;
  created_by: string;
  created_at: string;
}

export interface IdentityAction {
  id: string;
  user_id: string | null;
  purpose: 'verify_email' | 'recover_password' | 'change_email' | 'login_mfa' | 'passkey_register' | 'passkey_authenticate' | 'reauthenticate';
  token_hash: string | null;
  key_id: string | null;
  email: string | null;
  credential_id: string | null;
  challenge: string | null;
  data_json: string;
  auth_revision: number | null;
  expires_at: string;
  consumed_at: string | null;
  attempts: number;
  revision: number;
  created_at: string;
}

export interface MfaRecord {
  user_id: string;
  salt: string;
  key_id: string;
  last_counter: number;
  enabled_at: string | null;
  setup_expires_at: string;
  revision: number;
  created_at: string;
}

const policyBarrierContexts = new WeakMap<AppContext, Map<string, string>>();

/** Trusted in-process capability; never derived from a request header or body. */
export function currentPolicyBarrier(c: AppContext, accountId: string): string | undefined {
  return policyBarrierContexts.get(c)?.get(accountId);
}

export async function inPolicyBarrier<T>(c: AppContext, accountId: string, id: string, action: () => Promise<T>): Promise<T> {
  const contexts = policyBarrierContexts.get(c) ?? new Map<string, string>();
  policyBarrierContexts.set(c, contexts);
  if (contexts.has(accountId)) throw new Error('Nested account policy barrier.');
  contexts.set(accountId, id);
  try { return await action(); }
  finally { contexts.delete(accountId); }
}

const stringArray = z.array(z.string().min(1).max(512)).max(256);

/** Invalid persisted scope data must never turn into an unrestricted credential. */
export function credentialScope(value: string | null): string[] | null {
  if (value === null) return null;
  try { return stringArray.parse(JSON.parse(value)); }
  catch { throw new ApiError(503, 'credential_state_unavailable', 'GitKnot could not verify this credential.'); }
}

export function sessionCookieName(env: Bindings): string {
  const secure = new URL(env.API_ORIGIN).protocol === 'https:';
  if (!secure && env.ENVIRONMENT !== 'development' && env.ENVIRONMENT !== 'test') {
    throw new ApiError(503, 'identity_unavailable', 'GitKnot sign-in is temporarily unavailable.');
  }
  return secure ? '__Host-gitknot_session' : 'gitknot_session';
}

function presentedCredential(request: Request, env: Bindings): { value: string; cookie: boolean } | null {
  const authorization = request.headers.get('authorization');
  if (authorization !== null) {
    const bearer = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(authorization);
    if (bearer) return { value: bearer[1]!, cookie: false };
    const basic = /^Basic ([A-Za-z0-9+/=]{1,1024})$/i.exec(authorization);
    if (!basic) return null;
    try {
      const decoded = atob(basic[1]!);
      const separator = decoded.indexOf(':');
      const value = decoded.slice(separator + 1);
      return separator > 0 && /^gkt_[A-Za-z0-9_-]{43}$/.test(value) ? { value, cookie: false } : null;
    } catch { return null; }
  }
  const name = sessionCookieName(env);
  const values = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim())
    .filter(value => value.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0]!.slice(name.length + 1);
  return /^gks_[A-Za-z0-9_-]{43}$/.test(value) ? { value, cookie: true } : null;
}

export async function currentCredentialChain(db: Database, id: string): Promise<CredentialRecord[]> {
  return many<CredentialRecord>(db, `WITH RECURSIVE chain AS (
    SELECT c.*,0 AS depth FROM credentials c WHERE c.id=?
    UNION ALL SELECT c.*,chain.depth+1 FROM credentials c JOIN chain ON c.id=chain.parent_id WHERE chain.depth<8
  ) SELECT chain.* FROM chain ORDER BY depth`, id);
}

/** Runs on the authoritative primary, including every ancestor's revocation. */
export async function credentialIsCurrent(db: Database, credential: CredentialRecord): Promise<boolean> {
  const chain = await currentCredentialChain(db, credential.id);
  if (!chain.length || chain.at(-1)!.parent_id !== null) return false;
  const timestamp = now();
  if (chain.some(item => item.revoked_at !== null || item.expires_at <= timestamp)) return false;
  const users = [...new Set(chain.flatMap(item => item.user_id ? [item.user_id] : []))];
  for (const userId of users) {
    const user = await one<Pick<UserRecord, 'disabled_at' | 'auth_revision'>>(db,
      'SELECT disabled_at,auth_revision FROM users WHERE id=?', userId);
    if (!user || user.disabled_at !== null || chain.some(item => item.user_id === userId && item.auth_revision !== user.auth_revision)) return false;
  }
  for (const principalId of new Set(chain.map(item => item.principal_id))) {
    const principal = await one<{ disabled_at: string | null; expires_at: string | null; account_disabled: string | null }>(db,
      `SELECT p.disabled_at,p.expires_at,a.disabled_at AS account_disabled FROM principals p
       LEFT JOIN accounts a ON a.id=p.account_id WHERE p.id=?`, principalId);
    if (!principal || principal.disabled_at !== null || principal.account_disabled !== null
      || (principal.expires_at !== null && principal.expires_at <= timestamp)) return false;
  }
  return true;
}

/** No provider credentials, caller-supplied actor headers, or cached ACL grants. */
export async function authenticate(request: Request, env: Bindings): Promise<Principal | null> {
  const presented = presentedCredential(request, env);
  if (!presented) return null;
  const db = identityBinding(env);
  const credential = await one<CredentialRecord>(db, 'SELECT * FROM credentials WHERE token_hash=?', await sha256(presented.value));
  if (!credential || (credential.kind === 'session') !== presented.cookie || !await credentialIsCurrent(db, credential)) return null;
  if (presented.cookie && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const origin = request.headers.get('origin');
    if ((origin !== env.APP_ORIGIN && origin !== env.API_ORIGIN) || request.headers.get('x-gitknot-csrf') !== '1') {
      throw new ApiError(403, 'csrf_required', 'Browser mutations require the GitKnot origin and X-GitKnot-CSRF: 1.');
    }
  }
  const principal = await one<{ id: string; kind: PrincipalKind; user_id: string | null }>(db,
    'SELECT id,kind,user_id FROM principals WHERE id=? AND disabled_at IS NULL', credential.principal_id);
  if (!principal) return null;
  // A sparse last-used write reduces primary contention without caching authentication.
  const cutoff = new Date(Date.now() - 60_000).toISOString();
  if (!credential.last_used_at || credential.last_used_at < cutoff) {
    await stmt(db, 'UPDATE credentials SET last_used_at=? WHERE id=? AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at<?)',
      now(), credential.id, cutoff).run();
  }
  const authenticated: Principal = {
    ...principal, credential_id: credential.id,
    capabilities: credentialScope(credential.capabilities_json),
    repository_ids: credentialScope(credential.repository_ids_json),
    account_ids: credentialScope(credential.account_ids_json), mfa: credential.mfa === 1,
  };
  const chain = await currentCredentialChain(db, credential.id);
  let restricted = authenticated;
  for (const ancestor of chain) {
    if (await isFederationSession(db, ancestor.id)) await assertFederationIdentityContract({ ...env, DB: db });
    const current = await restrictFederatedPrincipal(db, { ...restricted, credential_id: ancestor.id });
    if (!current) return null;
    restricted = { ...restricted, account_ids: current.account_ids };
  }
  return restricted;
}

// OWASP's memory-constrained scrypt profile: 16 MiB, five passes. Native scrypt is
// supported by Workers; native Argon2 is not. These parameters are persisted.
const passwordParameters = { N: 16384, r: 8, p: 5, maxmem: 24 * 1024 * 1024 };
const dummyPasswordHash = '$scrypt$16384$8$5$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function derivePassword(password: string, salt: Uint8Array, parameters = passwordParameters): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, parameters, (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await derivePassword(password, salt);
  return `$scrypt$${passwordParameters.N}$${passwordParameters.r}$${passwordParameters.p}$${base64url(salt)}$${base64url(key)}`;
}

export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  const match = /^\$scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/.exec(hash ?? dummyPasswordHash);
  if (!match) throw new ApiError(503, 'identity_unavailable', 'GitKnot could not verify this password.');
  const [N, r, p] = match.slice(1, 4).map(Number);
  if (N !== passwordParameters.N || r !== passwordParameters.r || p !== passwordParameters.p) {
    throw new ApiError(503, 'identity_unavailable', 'GitKnot could not verify this password.');
  }
  const expected = fromBase64url(match[5]!);
  const actual = await derivePassword(password, fromBase64url(match[4]!));
  return timingSafeEqual(actual, expected) && hash !== null;
}

export function afterSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

const keyRingSchema = z.object({ current: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/), keys: z.record(z.string(), z.string().min(43).max(128)) }).strict();
type IdentityKeyBindings = { SESSION_KEY?: string; IDENTITY_KEYS_JSON?: unknown };

export function identityKeys(env: IdentityKeyBindings): { current: string; keys: Record<string, Uint8Array<ArrayBuffer>> } {
  try {
    if (typeof env.IDENTITY_KEYS_JSON === 'string') {
      const value = keyRingSchema.parse(JSON.parse(env.IDENTITY_KEYS_JSON));
      const keys = Object.fromEntries(Object.entries(value.keys).map(([id, key]) => {
        const decoded = fromBase64url(key);
        if (decoded.byteLength < 32) throw new Error('short key');
        return [id, decoded];
      }));
      if (!keys[value.current]) throw new Error('missing current key');
      return { current: value.current, keys };
    }
    if (typeof env.SESSION_KEY === 'string' && bytes(env.SESSION_KEY).byteLength >= 32) {
      return { current: 'session-v1', keys: { 'session-v1': bytes(env.SESSION_KEY) } };
    }
  } catch { /* Public failure deliberately contains no key material or parser details. */ }
  throw new ApiError(503, 'identity_unavailable', 'GitKnot sign-in is temporarily unavailable.');
}

function identityKey(env: IdentityKeyBindings, keyId: string): Uint8Array<ArrayBuffer> {
  const key = identityKeys(env).keys[keyId];
  if (!key) throw new ApiError(503, 'identity_key_unavailable', 'GitKnot could not verify this authentication method.');
  return key;
}

export async function actionToken(env: IdentityKeyBindings, action: { id: string; purpose: string; key_id: string; expires_at: string }): Promise<string> {
  return `gka_${action.id}_${await hmac(identityKey(env, action.key_id), ['GitKnot action v1', action.purpose, action.id, action.expires_at].join('\n'))}`;
}

export async function createIdentityAction(env: Bindings, value: {
  user_id?: string | null; purpose: IdentityAction['purpose']; email?: string | null; seconds?: number;
  credential_id?: string | null; challenge?: string | null; data?: Record<string, unknown>; auth_revision?: number | null;
}): Promise<{ action: IdentityAction; token: string; statement: D1PreparedStatement }> {
  const action: IdentityAction = {
    id: newId('act'), user_id: value.user_id ?? null, purpose: value.purpose, token_hash: null,
    key_id: identityKeys(env).current, email: value.email ?? null, credential_id: value.credential_id ?? null,
    challenge: value.challenge ?? null, data_json: JSON.stringify(value.data ?? {}), auth_revision: value.auth_revision ?? null,
    expires_at: afterSeconds(value.seconds ?? 900), consumed_at: null, attempts: 0, revision: 1, created_at: now(),
  };
  const token = await actionToken(env, { ...action, key_id: action.key_id! });
  action.token_hash = await sha256(token);
  return { action, token, statement: stmt(identityBinding(env), `INSERT INTO identity_actions
    (id,user_id,purpose,token_hash,key_id,email,credential_id,challenge,data_json,auth_revision,expires_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, action.id, action.user_id, action.purpose, action.token_hash, action.key_id,
  action.email, action.credential_id, action.challenge, action.data_json, action.auth_revision, action.expires_at, action.created_at) };
}

export async function findIdentityAction(db: Database, token: string, purpose: IdentityAction['purpose']): Promise<IdentityAction> {
  const action = await one<IdentityAction>(db,
    'SELECT * FROM identity_actions WHERE token_hash=? AND purpose=? AND consumed_at IS NULL AND expires_at>? AND attempts<10',
    await sha256(token), purpose, now());
  if (!action) throw new ApiError(400, 'invalid_authentication_action', 'This authentication request expired or has already been used. Start again.');
  return action;
}

export interface NewCredential {
  principal_id: string; user_id: string | null; kind: CredentialKind; name: string;
  capabilities: string[] | null; repository_ids: string[] | null; account_ids: string[] | null;
  ref_patterns?: string[] | null; path_patterns?: string[] | null; parent_id?: string | null;
  rotation_of_id?: string | null; auth_revision: number | null; mfa: boolean;
  expires_at: string; created_by: string; authenticated_at?: string;
}

export async function prepareCredential(db: Database, value: NewCredential): Promise<{ credential: CredentialRecord; token: string; statement: D1PreparedStatement }> {
  const token = `${value.kind === 'session' ? 'gks' : 'gkt'}_${randomToken()}`;
  const encode = (scope: string[] | null | undefined) => scope == null ? null : JSON.stringify(scope);
  const credential: CredentialRecord = {
    id: newId('cred'), principal_id: value.principal_id, user_id: value.user_id, kind: value.kind, name: value.name,
    token_hash: await sha256(token), token_prefix: token.slice(0, 12), capabilities_json: encode(value.capabilities),
    repository_ids_json: encode(value.repository_ids), account_ids_json: encode(value.account_ids),
    ref_patterns_json: encode(value.ref_patterns), path_patterns_json: encode(value.path_patterns),
    parent_id: value.parent_id ?? null, rotation_of_id: value.rotation_of_id ?? null, auth_revision: value.auth_revision,
    mfa: value.mfa ? 1 : 0, authenticated_at: value.authenticated_at ?? now(), expires_at: value.expires_at,
    revoked_at: null, last_used_at: null, revision: 1, created_by: value.created_by, created_at: now(),
  };
  return { credential, token, statement: stmt(db, `INSERT INTO credentials
    (id,principal_id,user_id,kind,name,token_hash,token_prefix,capabilities_json,repository_ids_json,account_ids_json,
     ref_patterns_json,path_patterns_json,parent_id,rotation_of_id,auth_revision,mfa,authenticated_at,expires_at,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, credential.id, credential.principal_id, credential.user_id,
  credential.kind, credential.name, credential.token_hash, credential.token_prefix, credential.capabilities_json,
  credential.repository_ids_json, credential.account_ids_json, credential.ref_patterns_json, credential.path_patterns_json,
  credential.parent_id, credential.rotation_of_id, credential.auth_revision, credential.mfa, credential.authenticated_at,
  credential.expires_at, credential.created_by, credential.created_at) };
}

/** Commit every returned statement together, before revoking a rotated source. */
export async function prepareDerivedCredential(db: Database, source: Principal, value: NewCredential): Promise<{
  credential: CredentialRecord; token: string; statements: D1PreparedStatement[];
}> {
  const prepared = await prepareCredential(db, value);
  const federation = await federationCredentialStatements(db, source, prepared.credential);
  return { credential: prepared.credential, token: prepared.token, statements: [prepared.statement, ...federation] };
}

export function publicCredential(credential: CredentialRecord): Record<string, unknown> {
  return {
    id: credential.id, principal_id: credential.principal_id, kind: credential.kind, name: credential.name,
    token_prefix: credential.token_prefix, capabilities: credentialScope(credential.capabilities_json),
    repository_ids: credentialScope(credential.repository_ids_json), account_ids: credentialScope(credential.account_ids_json),
    ref_patterns: credentialScope(credential.ref_patterns_json), path_patterns: credentialScope(credential.path_patterns_json),
    expires_at: credential.expires_at, revoked_at: credential.revoked_at, last_used_at: credential.last_used_at,
    revision: credential.revision, created_at: credential.created_at,
  };
}

export async function requireHuman(c: AppContext, options: { verified?: boolean; recent?: boolean; mfa?: boolean; independent?: boolean } = {}): Promise<UserRecord> {
  const principal = c.get('principal');
  if (!principal?.user_id || principal.kind !== 'user') throw new ApiError(401, 'human_authentication_required', 'Sign in to your GitKnot account to continue.');
  const user = await one<UserRecord>(identityDatabase(c), 'SELECT * FROM users WHERE id=? AND disabled_at IS NULL', principal.user_id);
  if (!user) throw new ApiError(401, 'authentication_required', 'Sign in to GitKnot to continue.');
  if (options.verified !== false && !user.email_verified_at) throw new ApiError(403, 'email_verification_required', 'Verify your email address to continue.');
  if (options.mfa && !principal.mfa) throw new ApiError(403, 'mfa_required', 'Confirm your identity with a passkey or second factor.');
  if (options.independent && principal.credential_id) {
    const chain = await currentCredentialChain(identityDatabase(c), principal.credential_id);
    for (const credential of chain) if (await isFederationSession(identityDatabase(c), credential.id)) {
      throw new ApiError(403, 'independent_authentication_required', 'Confirm your GitKnot account with an independent passkey or local password and MFA before changing account security.');
    }
  }
  if (options.recent) {
    const credential = principal.credential_id ? await one<CredentialRecord>(identityDatabase(c), 'SELECT * FROM credentials WHERE id=?', principal.credential_id) : null;
    if (!credential || credential.kind !== 'session' || credential.authenticated_at < afterSeconds(-600)
      || !await credentialIsCurrent(identityDatabase(c), credential) || (user.mfa_required === 1 && !principal.mfa)) {
      throw new ApiError(403, 'reauthentication_required', 'Confirm your identity again before changing account security.');
    }
  }
  return user;
}

export async function identityRateLimit(c: AppContext, action: string, subject?: string): Promise<void> {
  const seconds = 900;
  const windowStart = Math.floor(Date.now() / (seconds * 1000)) * seconds;
  const ip = c.req.header('cf-connecting-ip') ?? (c.env.ENVIRONMENT === 'development' || c.env.ENVIRONMENT === 'test' ? 'local' : 'unattributed');
  const buckets = [{ key: `ip:${action}:${ip}`, maximum: 100 }, ...(subject ? [{ key: `subject:${action}:${subject.toLowerCase()}`, maximum: 10 }] : [])];
  const prepared = await Promise.all(buckets.map(async bucket => ({ ...bucket, key: await sha256(bucket.key) })));
  const results = await identityDatabase(c).batch(prepared.map(bucket => stmt(identityDatabase(c), `INSERT INTO identity_rate_limits
    (bucket,window_start,attempts,expires_at) VALUES (?,?,1,?)
    ON CONFLICT(bucket,window_start) DO UPDATE SET attempts=attempts+1 RETURNING attempts`,
  bucket.key, windowStart, new Date((windowStart + 2 * seconds) * 1000).toISOString())));
  if (results.some((result, index) => Number((result.results[0] as { attempts: number } | undefined)?.attempts ?? Infinity) > prepared[index]!.maximum)) {
    const retry = Math.max(1, windowStart + seconds - Math.floor(Date.now() / 1000));
    c.header('retry-after', String(retry));
    throw new ApiError(429, 'authentication_rate_limited', 'Too many authentication attempts. Try again after the indicated delay.', { retry_after_seconds: retry });
  }
}

export function checkedWrite(db: Database, statement: D1PreparedStatement): D1PreparedStatement[] {
  const id = newId('guard');
  return [statement, stmt(db, 'INSERT INTO identity_write_guards(id,ok) VALUES (?,changes()=1)', id),
    stmt(db, 'DELETE FROM identity_write_guards WHERE id=?', id)];
}

export async function identityBatch(db: Database, statements: D1PreparedStatement[]): Promise<D1Result[]> {
  try { return await db.batch(statements); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/idempotency_generation_current/.test(message)) {
      throw new ApiError(409, 'idempotency_request_superseded', 'This request generation can no longer write. Retry with the same idempotency key.');
    }
    if (/last_recoverable_owner|last_effective_owner|owner_must_be_recoverable|personal_owner_immutable|last_authenticator/.test(message)) {
      throw new ApiError(409, 'recovery_path_required', 'Keep a verified, active owner and a usable account authentication method before making this change.');
    }
    if (/account_authority_barrier_required|account_authority_release_required/.test(message)) {
      throw new ApiError(409, 'account_authority_changed', 'An affected account authority changed. Retry against its current state.');
    }
    if (/CHECK constraint failed.*(?:ok|identity_write_guards)|mutation_requires_one_row/.test(message)) {
      throw new ApiError(412, 'revision_conflict', 'This resource changed or the authentication request was already used. Refresh and retry.');
    }
    if (/UNIQUE constraint failed/.test(message)) throw new ApiError(409, 'already_exists', 'A resource with these details already exists.');
    if (/account_name_reserved|repository_name_reserved/.test(message)) throw new ApiError(409, 'name_unavailable', 'This name is reserved by an existing account or repository operation.');
    throw error;
  }
}

export async function mfaSecret(env: Bindings, record: Pick<MfaRecord, 'user_id' | 'salt' | 'key_id'>): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', identityKey(env, record.key_id), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: fromBase64url(record.salt),
    info: bytes(`GitKnot TOTP v1\n${record.user_id}`) }, key, 160));
}

export function base32(value: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let buffer = 0;
  let bits = 0;
  let output = '';
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; output += alphabet[(buffer >>> bits) & 31]; }
  }
  if (bits) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

async function totp(secret: Uint8Array<ArrayBuffer>, counter: number): Promise<string> {
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = mac.at(-1)! & 15;
  const number = new DataView(mac.buffer).getUint32(offset) & 0x7fff_ffff;
  return (number % 1_000_000).toString().padStart(6, '0');
}

export async function verifyTotp(env: Bindings, record: MfaRecord, code: string): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = await mfaSecret(env, record);
  try {
    const current = Math.floor(Date.now() / 30_000);
    for (const counter of [current, current - 1, current + 1]) {
      if (counter > record.last_counter && timingSafeEqual(bytes(await totp(secret, counter)), bytes(code))) return counter;
    }
    return null;
  } finally { secret.fill(0); }
}

export async function recoveryCodeHash(code: string): Promise<string> {
  return sha256(code.replaceAll('-', '').replaceAll(' ', '').toUpperCase());
}

/** Returns atomic, single-use factor consumption statements, not a reusable flag. */
export async function verifySecondFactor(env: Bindings, userId: string, proof: { code?: string; recovery_code?: string }): Promise<D1PreparedStatement[]> {
  const db = identityBinding(env);
  if (proof.code) {
    const mfa = await one<MfaRecord>(db, 'SELECT * FROM user_mfa WHERE user_id=? AND enabled_at IS NOT NULL', userId);
    const counter = mfa ? await verifyTotp(env, mfa, proof.code) : null;
    if (mfa && counter !== null) return checkedWrite(db, stmt(db,
      'UPDATE user_mfa SET last_counter=?,revision=revision+1 WHERE user_id=? AND revision=? AND last_counter<? AND enabled_at IS NOT NULL',
      counter, userId, mfa.revision, counter));
  }
  if (proof.recovery_code) {
    const hash = await recoveryCodeHash(proof.recovery_code);
    const code = await one<{ id: string }>(db, 'SELECT id FROM recovery_codes WHERE user_id=? AND code_hash=? AND consumed_at IS NULL', userId, hash);
    if (code) return checkedWrite(db, stmt(db, 'UPDATE recovery_codes SET consumed_at=? WHERE id=? AND user_id=? AND consumed_at IS NULL', now(), code.id, userId));
  }
  throw new ApiError(401, 'invalid_second_factor', 'The authentication code is invalid, expired, or already used.');
}

export async function prepareRecoveryCodes(db: Database, userId: string): Promise<{ codes: string[]; statements: D1PreparedStatement[] }> {
  const codes = Array.from({ length: 10 }, () => Array.from(crypto.getRandomValues(new Uint8Array(10)), value => value.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{4}/g)!.join('-'));
  const statements = await Promise.all(codes.map(async code => stmt(db,
    'INSERT INTO recovery_codes(id,user_id,code_hash,created_at) VALUES (?,?,?,?)', newId('rc'), userId, await recoveryCodeHash(code), now())));
  return { codes, statements: [stmt(db, 'DELETE FROM recovery_codes WHERE user_id=?', userId), ...statements] };
}

/** Bounded maintenance; expiry is also enforced synchronously on every request. */
export async function sweepIdentity(env: Bindings): Promise<void> {
  const db = identityBinding(env);
  await db.batch([
    stmt(db, 'DELETE FROM identity_rate_limits WHERE rowid IN (SELECT rowid FROM identity_rate_limits WHERE expires_at<=? LIMIT 500)', now()),
    stmt(db, 'UPDATE identity_actions SET consumed_at=? WHERE id IN (SELECT id FROM identity_actions WHERE expires_at<=? AND consumed_at IS NULL LIMIT 500)', now(), now()),
    stmt(db, "UPDATE invitations SET state='expired',revision=revision+1,updated_at=? WHERE id IN (SELECT id FROM invitations WHERE state='pending' AND expires_at<=? LIMIT 500)", now(), now()),
    stmt(db, 'DELETE FROM identity_actions WHERE id IN (SELECT id FROM identity_actions WHERE consumed_at IS NOT NULL AND expires_at<? LIMIT 500)', afterSeconds(-30 * 86400)),
  ]);
}
