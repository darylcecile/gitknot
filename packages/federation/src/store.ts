import {
  ApiError, auditStatement, database, eventStatement, mutationStatements, newId, now, one, randomToken, sha256, stmt,
} from '@gitknot/core';
import type { AppContext, Bindings, Database, MutationBatch, Principal } from '@gitknot/core';
import { parseOrganizationPolicy, parseProvider } from './config.ts';
import { authenticationFailed } from './errors.ts';
import { safeReturnPath } from './network.ts';
import { FLOW_SECONDS } from './types.ts';
import type { AuthenticationFlow, IdentityProvider, OrganizationPolicyRecord, Provider, VerifiedIdentity } from './types.ts';

export function guarded(db: Database, statement: D1PreparedStatement): D1PreparedStatement[] {
  const id = newId('fg');
  return [statement, stmt(db, 'INSERT INTO federation_write_guards(id,ok) VALUES (?,changes()=1)', id),
    stmt(db, 'DELETE FROM federation_write_guards WHERE id=?', id)];
}

export function condition(db: Database, sql: string, ...bindings: unknown[]): D1PreparedStatement[] {
  const id = newId('fg');
  return [stmt(db, `INSERT INTO federation_write_guards(id,ok) SELECT ?,CASE WHEN (${sql}) THEN 1 ELSE 0 END`, id, ...bindings),
    stmt(db, 'DELETE FROM federation_write_guards WHERE id=?', id)];
}

export async function federationBatch(db: Database, statements: D1PreparedStatement[]): Promise<void> {
  try { await db.batch(statements); }
  catch (error) {
    if (/idempotency_generation_current/.test(String(error))) {
      throw new ApiError(409, 'idempotency_request_superseded', 'This request generation can no longer write. Retry with the same idempotency key.');
    }
    if (/last_recoverable_owner|owner_must_be_recoverable|last_authenticator/.test(String(error))) {
      throw new ApiError(409, 'recovery_path_required', 'Keep another verified, active organization owner with an independent recovery method.');
    }
    if (/federation_guard|CHECK constraint failed.*ok|mutation_requires_one_row/.test(String(error))) {
      throw new ApiError(412, 'federation_state_changed', 'The identity, provider configuration, or credential changed. Start again.');
    }
    if (/UNIQUE constraint failed/.test(String(error))) throw new ApiError(409, 'federation_conflict', 'This identity or request has already been registered.');
    throw error;
  }
}

/** Core fences request generations and records the effect, audit and recovery receipt together. */
export async function federationMutation(c: AppContext, mutation: MutationBatch): Promise<void> {
  await federationBatch(database(c), await mutationStatements(c, mutation));
}

export async function getProvider(db: Database, id: string, accountId?: string, enabled = false): Promise<Provider> {
  const row = await one<IdentityProvider>(db, `SELECT p.* FROM federation_providers p JOIN accounts a ON a.id=p.account_id
    WHERE p.id=? AND p.deleted_at IS NULL AND a.type='organization' AND a.disabled_at IS NULL
      ${accountId ? 'AND p.account_id=?' : ''} ${enabled ? 'AND p.enabled=1' : ''}`, id, ...(accountId ? [accountId] : []));
  if (!row) throw new ApiError(404, 'identity_provider_not_found', 'The organization identity provider was not found.');
  return parseProvider(row);
}

export async function getOrganizationPolicy(db: Database, accountId: string): Promise<OrganizationPolicyRecord & { config: ReturnType<typeof parseOrganizationPolicy> }> {
  const row = await one<OrganizationPolicyRecord>(db, 'SELECT * FROM federation_org_policies WHERE account_id=?', accountId);
  return row ? { ...row, config: parseOrganizationPolicy(row.config_json) } : {
    account_id: accountId, config_json: '{}', revision: 0, updated_by: '', updated_at: '', config: parseOrganizationPolicy(),
  };
}

export function providerGuard(db: Database, provider: Provider, enabled = true): D1PreparedStatement[] {
  return condition(db, `EXISTS (SELECT 1 FROM federation_providers p JOIN accounts a ON a.id=p.account_id
    WHERE p.account_id=? AND p.id=? AND p.revision=? AND p.deleted_at IS NULL ${enabled ? 'AND p.enabled=1' : ''}
      AND a.type='organization' AND a.disabled_at IS NULL)`, provider.account_id, provider.id, provider.revision);
}

export function federationAudit(db: Database, actor: Principal | null, requestId: string, accountId: string,
  type: string, resourceId: string, revision: number, data: Record<string, unknown> = {}): D1PreparedStatement[] {
  return [eventStatement(db, { type, resource_id: resourceId, resource_revision: revision, account_id: accountId, actor_id: actor?.id, data }),
    auditStatement(db, { action: type, resource_id: resourceId, resource_revision: revision, account_id: accountId,
      actor_id: actor?.id, credential_id: actor?.credential_id, request_id: requestId, details: data })];
}

function cookieName(flow: Pick<AuthenticationFlow, 'id'>): string { return `__Host-gitknot_federation_${flow.id}`; }

export function flowCookie(flow: AuthenticationFlow, value: string): string {
  return `${cookieName(flow)}=${value}; Path=/; HttpOnly; Secure; SameSite=${flow.protocol === 'saml' ? 'None' : 'Lax'}; Max-Age=${FLOW_SECONDS}`;
}

export function clearFlowCookie(flow: AuthenticationFlow): string {
  return `${cookieName(flow)}=; Path=/; HttpOnly; Secure; SameSite=${flow.protocol === 'saml' ? 'None' : 'Lax'}; Max-Age=0`;
}

function browserCookie(request: Request, flow: AuthenticationFlow): string {
  const prefix = `${cookieName(flow)}=`;
  const values = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(prefix));
  if (values.length !== 1) throw authenticationFailed();
  const value = values[0]!.slice(prefix.length);
  if (!/^[\w-]{43}$/.test(value)) throw authenticationFailed();
  return value;
}

export async function createFlow(db: Database, provider: Provider, returnTo: string | undefined,
  link?: { user_id: string; credential_id: string; auth_revision: number }): Promise<{
    flow: AuthenticationFlow; state: string; nonce: string; browser: string;
  }> {
  const state = randomToken();
  const browser = randomToken();
  const nonce = randomToken();
  const timestamp = now();
  const flow: AuthenticationFlow = {
    id: newId('ff'), account_id: provider.account_id, provider_id: provider.id, provider_revision: provider.revision,
    protocol: provider.protocol, state_hash: await sha256(state), browser_hash: await sha256(browser),
    nonce_hash: provider.protocol === 'oidc' ? await sha256(nonce) : null,
    pkce_verifier: provider.protocol === 'oidc' ? randomToken(48) : null,
    saml_request_id: provider.protocol === 'saml' ? `_${newId('saml')}` : null,
    return_path: safeReturnPath(returnTo), link_user_id: link?.user_id ?? null,
    link_credential_id: link?.credential_id ?? null, link_auth_revision: link?.auth_revision ?? null,
    created_at: timestamp, expires_at: new Date(Date.now() + FLOW_SECONDS * 1000).toISOString(),
    consumed_at: null, exchange_started_at: null, completed_at: null,
  };
  await federationBatch(db, [...providerGuard(db, provider), stmt(db, `INSERT INTO federation_auth_flows
    (id,account_id,provider_id,provider_revision,protocol,state_hash,browser_hash,nonce_hash,pkce_verifier,saml_request_id,
     return_path,link_user_id,link_credential_id,link_auth_revision,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  flow.id, flow.account_id, flow.provider_id, flow.provider_revision, flow.protocol, flow.state_hash, flow.browser_hash,
  flow.nonce_hash, flow.pkce_verifier, flow.saml_request_id, flow.return_path, flow.link_user_id, flow.link_credential_id,
  flow.link_auth_revision, flow.created_at, flow.expires_at)]);
  return { flow, state, nonce, browser };
}

/** Atomic consume occurs before any external exchange. Concurrent callbacks cannot both succeed. */
export async function consumeFlow(db: Database, request: Request, provider: Provider, state: string): Promise<AuthenticationFlow> {
  if (!/^[\w-]{43}$/.test(state)) throw authenticationFailed();
  const hash = await sha256(state);
  const flow = await one<AuthenticationFlow>(db, `SELECT * FROM federation_auth_flows WHERE state_hash=? AND account_id=?
    AND provider_id=? AND provider_revision=? AND protocol=? AND expires_at>? AND consumed_at IS NULL`,
  hash, provider.account_id, provider.id, provider.revision, provider.protocol, now());
  if (!flow) throw authenticationFailed();
  const browserHash = await sha256(browserCookie(request, flow));
  const consumed = await one<AuthenticationFlow>(db, `UPDATE federation_auth_flows SET consumed_at=? WHERE id=? AND state_hash=?
    AND browser_hash=? AND account_id=? AND provider_id=? AND provider_revision=? AND expires_at>? AND consumed_at IS NULL
    AND EXISTS (SELECT 1 FROM federation_providers p WHERE p.id=federation_auth_flows.provider_id AND p.account_id=federation_auth_flows.account_id
      AND p.revision=federation_auth_flows.provider_revision AND p.enabled=1 AND p.deleted_at IS NULL) RETURNING *`,
  now(), flow.id, hash, browserHash, provider.account_id, provider.id, provider.revision, now());
  if (!consumed) throw authenticationFailed();
  return consumed;
}

export async function replayStatements(db: Database, provider: Provider, identity: VerifiedIdentity): Promise<D1PreparedStatement[]> {
  return Promise.all(identity.replays.map(async replay => stmt(db,
    'INSERT INTO federation_replays(account_id,provider_id,kind,nonce_hash,expires_at) VALUES (?,?,?,?,?)',
    provider.account_id, provider.id, replay.kind, await sha256(replay.value), replay.expires_at)));
}

export async function federationRateLimit(c: AppContext, action: string, providerId: string): Promise<void> {
  const windowStart = Math.floor(Date.now() / 300_000) * 300;
  const ip = c.req.header('cf-connecting-ip') ?? 'unattributed';
  const buckets = [{ value: `ip:${action}:${ip}`, max: 100 }, { value: `provider:${action}:${providerId}`, max: 10_000 }];
  const statements = await Promise.all(buckets.map(async bucket => stmt(c.env.DB, `INSERT INTO federation_rate_limits
    (bucket,window_start,attempts,expires_at) VALUES (?,?,1,?) ON CONFLICT(bucket,window_start)
    DO UPDATE SET attempts=attempts+1 RETURNING attempts`, await sha256(bucket.value), windowStart,
  new Date((windowStart + 600) * 1000).toISOString())));
  const result = await c.env.DB.batch<{ attempts: number }>(statements);
  if (result.some((row, index) => (row.results[0]?.attempts ?? Infinity) > buckets[index]!.max)) {
    c.header('retry-after', String(Math.max(1, windowStart + 300 - Math.floor(Date.now() / 1000))));
    throw new ApiError(429, 'federation_rate_limited', 'Too many organization identity requests. Try again after the indicated delay.');
  }
}

/** Scheduled maintenance is bounded and is never required for expiry/replay correctness. */
export async function sweepFederationState(db: Database, maximum = 1000): Promise<void> {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 1000) throw new TypeError('Invalid sweep limit');
  const { recoverSeatAdmissions } = await import('./seats.ts');
  await recoverSeatAdmissions(db, maximum);
  const timestamp = now();
  await db.batch([
    stmt(db, 'DELETE FROM federation_auth_flows WHERE id IN (SELECT id FROM federation_auth_flows WHERE expires_at<? ORDER BY expires_at LIMIT ?)', timestamp, maximum),
    stmt(db, 'DELETE FROM federation_replays WHERE rowid IN (SELECT rowid FROM federation_replays WHERE expires_at<? ORDER BY expires_at LIMIT ?)', timestamp, maximum),
    stmt(db, 'DELETE FROM federation_rate_limits WHERE rowid IN (SELECT rowid FROM federation_rate_limits WHERE expires_at<? ORDER BY expires_at LIMIT ?)', timestamp, maximum),
    stmt(db, 'DELETE FROM federation_scim_requests WHERE rowid IN (SELECT rowid FROM federation_scim_requests WHERE expires_at<? ORDER BY expires_at LIMIT ?)', timestamp, maximum),
  ]);
}

export function publicOrigins(env: Pick<Bindings, 'APP_ORIGIN' | 'API_ORIGIN'>): { app: string; api: string } {
  for (const value of [env.APP_ORIGIN, env.API_ORIGIN]) {
    const url = new URL(value);
    if (url.origin !== value || url.protocol !== 'https:' || url.username || url.password) {
      throw new ApiError(503, 'federation_origin_unavailable', 'Organization sign-in requires configured HTTPS application and API origins.');
    }
  }
  return { app: env.APP_ORIGIN, api: env.API_ORIGIN };
}
