import { z } from 'zod';
import {
  ApiError, database, decodeCursor, encodeCursor, etag, expectedRevision, jsonBody, listResponse, many, newId, now,
  one, page, readBounded, requirePrincipal, route, sessionCookieName, sha256, stmt,
} from '@gitknot/core';
import type { App, AppContext, CredentialRecord } from '@gitknot/core';
import {
  administratorGuard, assertFederationIdentityContract, authenticateScim, authenticationFailed, clearFlowCookie, condition,
  consumeFlow, createFlow, createProviderSchema, createProvisioningToken, createProvisioningTokenSchema, createScimGroup,
  createScimUser, deleteScimGroup, deleteScimUser, discoverOidcConfiguration, exchangeConfidentialOidcCode, exchangeFederatedIdentity,
  federationBrokerCall, federationCredentialStatements, federationDiscovery, federationMutation,
  federationRateLimit, flowCookie, getOrganizationPolicy, getProvider, guarded, idempotentScimCreate, listScimResources, organizationPolicySchema,
  providerGuard, publicOrigins, readScimResource, requestOidcTokens, requireFederationAdministrator, requireLinkingSession,
  sameProviderIdentity, samlMetadata, samlRedirectParameters, samlRedirectUrl, scimDiscovery, scimErrorResponse, scimInputJsonSchema,
  signSamlRedirect, trustedFederationOrigins, updateProviderSchema, updateScimGroup, updateScimUser, ScimError,
  validateEntitlements, validateMappingConfiguration, validateProviderEndpoints, verifyOidcIdentity, verifySamlIdentity,
  oidcAuthorizationUrl, SCIM_ERROR_SCHEMA, SCIM_MEDIA_TYPE, SCIM_SEARCH_SCHEMA,
} from '../../../../packages/federation/src/index.ts';
import type { AuthenticationFlow, FederationSecretKind, IdentityProvider, Provider, ProvisioningContext, ScimObject } from '../../../../packages/federation/src/index.ts';
import { validateSigningCertificate } from '../../../../packages/federation/src/xml.ts';

const base = '/v1/orgs/:orgId/identity-providers';
const startSchema = z.object({ intent: z.enum(['login', 'link']).default('login'), return_to: z.string().max(1024).optional() }).strict();
const secretSchema = z.object({ secret: z.string().min(1).max(16_384), public_certificate: z.string().max(16_384).optional() }).strict();
const discoverySchema = z.object({ issuer: z.url().max(2048) }).strict();
const secretKinds = z.enum(['oidc_client_secret', 'saml_signing_key']);

async function providerResponse(c: AppContext, provider: Provider, status = 200): Promise<Response> {
  const secrets = await many<{ kind: FederationSecretKind; version: number; public_certificate: string | null }>(c.env.DB,
    'SELECT kind,version,public_certificate FROM federation_client_secrets WHERE account_id=? AND provider_id=? AND revoked_at IS NULL', provider.account_id, provider.id);
  c.header('etag', etag(provider.revision));
  c.header('location', `/v1/orgs/${provider.account_id}/identity-providers/${provider.id}`);
  return c.json({ id: provider.id, account_id: provider.account_id, name: provider.name, protocol: provider.protocol,
    enabled: provider.enabled === 1, config: provider.config, revision: provider.revision, created_at: provider.created_at,
    updated_at: provider.updated_at, secrets: secrets.map(secret => ({ kind: secret.kind, version: secret.version, configured: true,
      ...(secret.public_certificate ? { public_certificate: secret.public_certificate } : {}) })) }, status as 200);
}

async function validateConfiguration(c: AppContext, accountId: string, config: Provider['config']): Promise<void> {
  validateMappingConfiguration(config);
  validateProviderEndpoints(config, trustedFederationOrigins(c.env));
  if (config.protocol === 'saml') config.signing_certificates.forEach(validateSigningCertificate);
  await validateEntitlements(c.env.DB, accountId, config);
}

function ownerRecoveryGuard(c: AppContext, accountId: string): D1PreparedStatement[] {
  return condition(c.env.DB, `EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id=m.principal_id
    JOIN principals p ON p.id=u.id WHERE m.account_id=? AND m.role_id='owner' AND m.state='active'
      AND u.email_verified_at IS NOT NULL AND u.disabled_at IS NULL AND p.disabled_at IS NULL
      AND (u.password_hash IS NOT NULL OR EXISTS (SELECT 1 FROM passkeys WHERE user_id=u.id)))`, accountId);
}

async function createProvider(c: AppContext): Promise<Response> {
  const accountId = c.req.param('orgId')!;
  await requireFederationAdministrator(c, accountId, true);
  const input = await jsonBody(c, createProviderSchema);
  await validateConfiguration(c, accountId, input.config);
  const actor = requirePrincipal(c);
  const id = newId('idp');
  const timestamp = now();
  await federationMutation(c, { event: { type: 'federation.provider.created', resource_id: id, resource_revision: 1,
    account_id: accountId, data: { protocol: input.config.protocol } }, statements: [
    ...administratorGuard(c.env.DB, actor, accountId), ...ownerRecoveryGuard(c, accountId),
    ...condition(c.env.DB, '(SELECT COUNT(*) FROM federation_providers WHERE account_id=? AND deleted_at IS NULL)<16', accountId),
    stmt(c.env.DB, `INSERT INTO federation_providers(id,account_id,name,protocol,config_json,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`, id, accountId, input.name, input.config.protocol, JSON.stringify(input.config), actor.id, timestamp, timestamp),
  ] });
  return providerResponse(c, await getProvider(c.env.DB, id, accountId), 201);
}

async function listProviders(c: AppContext): Promise<Response> {
  const accountId = c.req.param('orgId')!;
  await requireFederationAdministrator(c, accountId);
  const pagination = page(c);
  const cursor = decodeCursor<unknown>(pagination.cursor, '');
  if (typeof cursor !== 'string' || cursor.length > 128) throw new ApiError(422, 'invalid_cursor', 'The identity provider cursor is invalid.');
  const rows = await many<IdentityProvider>(database(c), 'SELECT * FROM federation_providers WHERE account_id=? AND id>? AND deleted_at IS NULL ORDER BY id LIMIT ?',
    accountId, cursor, pagination.limit + 1);
  return listResponse(c, rows.slice(0, pagination.limit).map(row => ({ id: row.id, account_id: row.account_id, name: row.name, protocol: row.protocol,
    enabled: row.enabled === 1, revision: row.revision, created_at: row.created_at, updated_at: row.updated_at })),
  rows.length > pagination.limit ? encodeCursor(rows[pagination.limit - 1]!.id) : null);
}

async function enabledSecretGuard(c: AppContext, provider: Provider): Promise<D1PreparedStatement[]> {
  const kind = provider.config.protocol === 'oidc' ? (provider.config.token_endpoint_auth_method !== 'none' ? 'oidc_client_secret' : null)
    : (provider.config.sign_authn_requests ? 'saml_signing_key' : null);
  if (!kind) return [];
  const row = await one<{ id: string; public_certificate: string | null }>(c.env.DB,
    'SELECT id,public_certificate FROM federation_client_secrets WHERE account_id=? AND provider_id=? AND kind=? AND revoked_at IS NULL', provider.account_id, provider.id, kind);
  if (!row) throw new ApiError(409, 'federation_secret_required', 'Configure the required client secret or SAML signing key through the private broker before enabling this provider.');
  if (kind === 'saml_signing_key') validateSigningCertificate(row.public_certificate ?? '');
  return condition(c.env.DB, 'EXISTS (SELECT 1 FROM federation_client_secrets WHERE account_id=? AND provider_id=? AND id=? AND revoked_at IS NULL)', provider.account_id, provider.id, row.id);
}

function preserveEnabledProvider(c: AppContext, provider: Provider): D1PreparedStatement[] {
  return condition(c.env.DB, `NOT EXISTS (SELECT 1 FROM federation_org_policies WHERE account_id=? AND json_extract(config_json,'$.required')=1)
    OR EXISTS (SELECT 1 FROM federation_providers WHERE account_id=? AND id<>? AND enabled=1 AND deleted_at IS NULL)`,
  provider.account_id, provider.account_id, provider.id);
}

async function updateProvider(c: AppContext): Promise<Response> {
  const accountId = c.req.param('orgId')!;
  await requireFederationAdministrator(c, accountId, true);
  const current = await getProvider(c.env.DB, c.req.param('providerId')!, accountId);
  const input = await jsonBody(c, updateProviderSchema);
  const revision = expectedRevision(c);
  const config = input.config ?? current.config;
  if (!sameProviderIdentity(current.config, config)) throw new ApiError(422, 'provider_identity_immutable', 'Create a new provider when changing its issuer, client, tenant trust, or SCIM identity key.');
  await validateConfiguration(c, accountId, config);
  const enabled = input.enabled === undefined ? current.enabled === 1 : input.enabled;
  const secret = enabled ? await enabledSecretGuard(c, { ...current, config }) : [];
  const actor = requirePrincipal(c);
  await federationMutation(c, { event: { type: 'federation.provider.updated', resource_id: current.id, resource_revision: revision + 1,
    account_id: accountId, data: { enabled } }, statements: [
    ...administratorGuard(c.env.DB, actor, accountId), ...ownerRecoveryGuard(c, accountId), ...secret,
    ...(!enabled && current.enabled === 1 ? preserveEnabledProvider(c, current) : []),
    ...guarded(c.env.DB, stmt(c.env.DB, 'UPDATE federation_providers SET name=?,config_json=?,enabled=?,revision=revision+1,updated_at=? WHERE account_id=? AND id=? AND revision=? AND deleted_at IS NULL',
      input.name ?? current.name, JSON.stringify(config), Number(enabled), now(), accountId, current.id, revision)),
  ] });
  return providerResponse(c, await getProvider(c.env.DB, current.id, accountId));
}

async function deleteProvider(c: AppContext): Promise<Response> {
  const accountId = c.req.param('orgId')!;
  await requireFederationAdministrator(c, accountId, true);
  const provider = await getProvider(c.env.DB, c.req.param('providerId')!, accountId);
  const revision = expectedRevision(c);
  const actor = requirePrincipal(c);
  await federationMutation(c, { event: { type: 'federation.provider.deleted', resource_id: provider.id, resource_revision: revision + 1,
    account_id: accountId }, statements: [
    ...administratorGuard(c.env.DB, actor, accountId), ...preserveEnabledProvider(c, provider),
    ...guarded(c.env.DB, stmt(c.env.DB, 'UPDATE federation_providers SET enabled=0,deleted_at=?,revision=revision+1,updated_at=? WHERE account_id=? AND id=? AND revision=? AND deleted_at IS NULL',
      now(), now(), accountId, provider.id, revision)),
    stmt(c.env.DB, 'UPDATE federation_client_secrets SET revoked_at=COALESCE(revoked_at,?) WHERE account_id=? AND provider_id=?', now(), accountId, provider.id),
    stmt(c.env.DB, 'UPDATE federation_provisioning_tokens SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE account_id=? AND provider_id=? AND revoked_at IS NULL', now(), accountId, provider.id),
  ] });
  return c.body(null, 204);
}

async function getPolicy(c: AppContext): Promise<Response> {
  const accountId = c.req.param('orgId')!;
  await requireFederationAdministrator(c, accountId);
  const policy = await getOrganizationPolicy(c.env.DB, accountId);
  c.header('etag', etag(policy.revision));
  return c.json({ account_id: accountId, ...policy.config, revision: policy.revision });
}

async function updatePolicy(c: AppContext): Promise<Response> {
  const accountId = c.req.param('orgId')!;
  await requireFederationAdministrator(c, accountId, true);
  const input = await jsonBody(c, organizationPolicySchema);
  const revision = c.req.header('if-match') === '"0"' ? 0 : expectedRevision(c);
  const actor = requirePrincipal(c);
  const statements = [...administratorGuard(c.env.DB, actor, accountId), ...ownerRecoveryGuard(c, accountId)];
  if (input.required) statements.push(...condition(c.env.DB, 'EXISTS (SELECT 1 FROM federation_providers WHERE account_id=? AND enabled=1 AND deleted_at IS NULL)', accountId));
  statements.push(...guarded(c.env.DB, revision === 0
    ? stmt(c.env.DB, 'INSERT INTO federation_org_policies(account_id,config_json,revision,updated_by,updated_at) VALUES (?,?,1,?,?) ON CONFLICT(account_id) DO NOTHING', accountId, JSON.stringify(input), actor.id, now())
    : stmt(c.env.DB, 'UPDATE federation_org_policies SET config_json=?,revision=revision+1,updated_by=?,updated_at=? WHERE account_id=? AND revision=?', JSON.stringify(input), actor.id, now(), accountId, revision)));
  await federationMutation(c, { event: { type: 'federation.policy.updated', resource_id: accountId, resource_revision: revision + 1,
    account_id: accountId, data: { required: input.required } }, statements });
  c.header('etag', etag(revision + 1));
  return c.json({ account_id: accountId, ...input, revision: revision + 1 });
}

async function manageSecret(c: AppContext, revoke: boolean): Promise<Response> {
  const accountId = c.req.param('orgId')!;
  await requireFederationAdministrator(c, accountId, true);
  const provider = await getProvider(c.env.DB, c.req.param('providerId')!, accountId);
  const kind = secretKinds.safeParse(c.req.param('kind'));
  if (!kind.success) throw new ApiError(422, 'federation_secret_kind', 'Use oidc_client_secret or saml_signing_key.');
  const input = revoke ? {} : await jsonBody(c, secretSchema);
  const key = c.req.header('idempotency-key') ?? newId('request');
  if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new ApiError(400, 'invalid_idempotency_key', 'Use 1–128 visible ASCII characters for Idempotency-Key.');
  const operationId = await sha256([c.req.method, c.req.path, requirePrincipal(c).id, key].join('\n'));
  const result = await federationBrokerCall<{ provider_revision: number }>(c.env, revoke ? 'secrets/revoke' : 'secrets', 'federation.manage', {
    ...input, account_id: accountId, provider_id: provider.id, credential_id: requirePrincipal(c).credential_id,
    expected_revision: expectedRevision(c), kind: kind.data, operation_id: operationId,
  });
  c.header('etag', etag(result.provider_revision));
  return c.json(result);
}

async function listTokens(c: AppContext): Promise<Response> {
  const accountId = c.req.param('orgId')!;
  await requireFederationAdministrator(c, accountId);
  const provider = await getProvider(c.env.DB, c.req.param('providerId')!, accountId);
  const pagination = page(c);
  const cursor = decodeCursor<unknown>(pagination.cursor, '');
  if (typeof cursor !== 'string' || cursor.length > 128) throw new ApiError(422, 'invalid_cursor', 'The provisioning token cursor is invalid.');
  const rows = await many<Record<string, unknown> & { id: string }>(c.env.DB, `SELECT t.id,t.name,t.provider_id,t.revision,t.created_at,
    COALESCE(t.revoked_at,c.revoked_at) AS revoked_at,c.expires_at,c.last_used_at,c.token_prefix,c.capabilities_json
    FROM federation_provisioning_tokens t JOIN credentials c ON c.id=t.credential_id
    WHERE t.account_id=? AND t.provider_id=? AND t.id>? ORDER BY t.id LIMIT ?`, accountId, provider.id, cursor, pagination.limit + 1);
  return listResponse(c, rows.slice(0, pagination.limit).map(({ capabilities_json, ...row }) => ({ ...row, capabilities: JSON.parse(String(capabilities_json)) })),
    rows.length > pagination.limit ? encodeCursor(rows[pagination.limit - 1]!.id) : null);
}

async function revokeToken(c: AppContext): Promise<Response> {
  const accountId = c.req.param('orgId')!;
  await requireFederationAdministrator(c, accountId, true);
  const provider = await getProvider(c.env.DB, c.req.param('providerId')!, accountId);
  const tokenId = c.req.param('tokenId')!;
  const revision = expectedRevision(c);
  const actor = requirePrincipal(c);
  await federationMutation(c, { event: { type: 'federation.provisioning_token.revoked', resource_id: tokenId, resource_revision: revision + 1,
    account_id: accountId, data: { provider_id: provider.id } }, statements: [
    ...administratorGuard(c.env.DB, actor, accountId),
    ...guarded(c.env.DB, stmt(c.env.DB, 'UPDATE federation_provisioning_tokens SET revoked_at=?,revision=revision+1 WHERE account_id=? AND provider_id=? AND id=? AND revision=? AND revoked_at IS NULL',
      now(), accountId, provider.id, tokenId, revision)),
    stmt(c.env.DB, `UPDATE credentials SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE id IN
      (SELECT credential_id FROM federation_provisioning_tokens WHERE account_id=? AND provider_id=? AND id=?)`, now(), accountId, provider.id, tokenId),
  ] });
  return c.body(null, 204);
}

async function authorizeExistingCredential(c: AppContext): Promise<Response> {
  const accountId = c.req.param('orgId')!;
  await assertFederationIdentityContract(c.env);
  const principal = requirePrincipal(c);
  const provider = await getProvider(c.env.DB, c.req.param('providerId')!, accountId, true);
  const target = await one<CredentialRecord>(c.env.DB, 'SELECT * FROM credentials WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?', c.req.param('credentialId')!, principal.user_id, now());
  if (!target || target.kind !== 'personal' || target.principal_id !== principal.id || principal.kind !== 'user') throw new ApiError(404, 'credential_not_found', 'The credential was not found.');
  const source = principal.credential_id ? await one<CredentialRecord>(c.env.DB, 'SELECT * FROM credentials WHERE id=?', principal.credential_id) : null;
  const grant = await one(c.env.DB, `SELECT g.credential_id FROM federation_session_grants g WHERE g.account_id=? AND g.provider_id=?
    AND g.credential_id=? AND g.revoked_at IS NULL AND g.expires_at>? AND g.authenticated_at>=?`, accountId, provider.id, principal.credential_id,
  now(), new Date(Date.now() - 300_000).toISOString());
  if (!source || source.kind !== 'session' || !principal.mfa || !grant) throw new ApiError(403, 'fresh_organization_sso_required', 'Use a fresh organization SSO session with MFA to authorize this personal token.');
  const revision = expectedRevision(c);
  const constrained = { ...target, account_ids_json: JSON.stringify([accountId]) };
  const grants = await federationCredentialStatements(c.env.DB, principal, constrained);
  await federationMutation(c, { event: { type: 'federation.credential.authorized', resource_id: target.id, resource_revision: revision + 1,
    account_id: accountId, data: { provider_id: provider.id } }, statements: [
    ...providerGuard(c.env.DB, provider),
    ...guarded(c.env.DB, stmt(c.env.DB, `UPDATE credentials SET account_ids_json=?,mfa=1,authenticated_at=?,revision=revision+1
      WHERE id=? AND user_id=? AND revision=? AND revoked_at IS NULL AND expires_at>?`, JSON.stringify([accountId]), source.authenticated_at, target.id, principal.user_id, revision, now())),
    stmt(c.env.DB, 'DELETE FROM federation_session_grants WHERE credential_id=?', target.id), ...grants,
  ] });
  c.header('etag', etag(revision + 1));
  return c.json({ credential_id: target.id, account_ids: [accountId], revision: revision + 1, authorized: true });
}

function browserLinkIntent(c: AppContext): void {
  const origin = c.req.header('origin');
  if (![c.env.APP_ORIGIN, c.env.API_ORIGIN].includes(origin ?? '') || c.req.header('x-gitknot-csrf') !== '1') {
    throw new ApiError(403, 'csrf_required', 'Identity linking requires the GitKnot origin and X-GitKnot-CSRF: 1.');
  }
}

async function start(c: AppContext, protocol: 'oidc' | 'saml', post: boolean): Promise<Response> {
  await assertFederationIdentityContract(c.env);
  publicOrigins(c.env);
  const provider = await getProvider(c.env.DB, c.req.param('providerId')!, undefined, true);
  if (provider.protocol !== protocol) throw authenticationFailed();
  await federationRateLimit(c, 'start', provider.id);
  const input = post ? await jsonBody(c, startSchema) : { intent: 'login', return_to: c.req.query('return_to') };
  let link: { user_id: string; credential_id: string; auth_revision: number } | undefined;
  if (input.intent === 'link') {
    browserLinkIntent(c);
    const user = await requireLinkingSession(c);
    link = { user_id: user.id, credential_id: requirePrincipal(c).credential_id!, auth_revision: user.auth_revision };
  }
  const created = await createFlow(c.env.DB, provider, input.return_to, link);
  let url: string;
  if (protocol === 'oidc') url = await oidcAuthorizationUrl(c.env, provider, created.flow, created.state, created.nonce);
  else url = provider.config.protocol === 'saml' && provider.config.sign_authn_requests
    ? await signSamlRedirect(c.env, provider, created.flow, created.state)
    : samlRedirectUrl(c.env, provider, samlRedirectParameters(c.env, provider, created.flow, created.state, false));
  c.header('set-cookie', flowCookie(created.flow, created.browser), { append: true });
  c.header('cache-control', 'no-store');
  c.header('referrer-policy', 'no-referrer');
  return post ? c.json({ authorization_url: url, expires_at: created.flow.expires_at }) : c.redirect(url, 302);
}

function singleParameter(params: URLSearchParams, name: string, required = true): string | undefined {
  const values = params.getAll(name);
  if (values.length > 1 || (required && (values.length !== 1 || !values[0]))) throw authenticationFailed();
  return values[0];
}

async function finishSignIn(c: AppContext, provider: Provider, flow: AuthenticationFlow, identity: Parameters<typeof exchangeFederatedIdentity>[3]): Promise<Response> {
  const result = await exchangeFederatedIdentity(c.env.DB, provider, flow, identity, c.get('requestId'), c.env);
  if ('pending_provisioning' in result) {
    const location = new URL(flow.return_path, publicOrigins(c.env).app);
    location.searchParams.set('identity_linked', 'true');
    location.searchParams.set('provisioning_required', 'true');
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    return c.redirect(location.href, 303);
  }
  c.header('set-cookie', `${sessionCookieName(c.env)}=${result.token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(1, Math.floor((Date.parse(result.credential.expires_at) - Date.now()) / 1000))}`, { append: true });
  c.header('cache-control', 'no-store');
  c.header('referrer-policy', 'no-referrer');
  return c.redirect(new URL(flow.return_path, publicOrigins(c.env).app).href, 303);
}

async function oidcCallback(c: AppContext): Promise<Response> {
  await assertFederationIdentityContract(c.env);
  const provider = await getProvider(c.env.DB, c.req.param('providerId')!, undefined, true);
  if (provider.config.protocol !== 'oidc') throw authenticationFailed();
  await federationRateLimit(c, 'callback', provider.id);
  const params = new URL(c.req.url).searchParams;
  const state = singleParameter(params, 'state')!;
  const flow = await consumeFlow(c.env.DB, c.req.raw, provider, state);
  c.header('set-cookie', clearFlowCookie(flow), { append: true });
  try {
    if (singleParameter(params, 'error', false) !== undefined) throw authenticationFailed();
    const code = singleParameter(params, 'code')!;
    const issuer = singleParameter(params, 'iss', provider.config.require_authorization_response_issuer);
    if (issuer !== undefined && issuer !== provider.config.issuer) throw authenticationFailed();
    const tokens = provider.config.token_endpoint_auth_method === 'none'
      ? await requestOidcTokens(c.env, provider, flow, code, null) : await exchangeConfidentialOidcCode(c.env, provider, flow, code);
    const identity = await verifyOidcIdentity(c.env, provider, flow, tokens, code);
    return await finishSignIn(c, provider, flow, identity);
  } finally {
    await stmt(c.env.DB, 'UPDATE federation_auth_flows SET pkce_verifier=NULL WHERE account_id=? AND provider_id=? AND id=?', provider.account_id, provider.id, flow.id).run();
  }
}

async function samlAcs(c: AppContext): Promise<Response> {
  await assertFederationIdentityContract(c.env);
  const provider = await getProvider(c.env.DB, c.req.param('providerId')!, undefined, true);
  if (provider.protocol !== 'saml') throw authenticationFailed();
  await federationRateLimit(c, 'callback', provider.id);
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(c.req.header('content-type') ?? '')) throw new ApiError(415, 'saml_form_required', 'Use the SAML HTTP-POST form binding.');
  if (Number(c.req.header('content-length')) > 524_288) throw new ApiError(413, 'saml_response_too_large', 'The SAML response exceeds the supported size.');
  let params: URLSearchParams;
  try { params = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(c.req.raw.body, 524_288))); }
  catch { throw authenticationFailed(); }
  if ([...params.keys()].some(key => !['SAMLResponse', 'RelayState'].includes(key))) throw authenticationFailed();
  const state = singleParameter(params, 'RelayState')!;
  const response = singleParameter(params, 'SAMLResponse')!;
  const flow = await consumeFlow(c.env.DB, c.req.raw, provider, state);
  c.header('set-cookie', clearFlowCookie(flow), { append: true });
  return finishSignIn(c, provider, flow, verifySamlIdentity(c.env, provider, flow, response));
}

/** Composition exempts only this form callback from ambient session/CSRF middleware. */
export function isFederationProtocolCallback(request: Request): boolean {
  return request.method === 'POST' && /^\/v1\/auth\/saml\/idp_[\w-]{8,100}\/acs$/.test(new URL(request.url).pathname);
}

const scimError = { description: 'SCIM Error resource (RFC 7644).', content: { [SCIM_MEDIA_TYPE]: { schema: {
  type: 'object', required: ['schemas', 'status', 'detail'], properties: {
    schemas: { type: 'array', items: { const: SCIM_ERROR_SCHEMA } }, status: { type: 'string' }, scimType: { type: 'string' }, detail: { type: 'string' },
  },
} } } };
const scimResponses = {
  '200': { description: 'SCIM resource or ListResponse. See the organization /Schemas endpoint.', content: { [SCIM_MEDIA_TYPE]: { schema: { type: 'object' } } } },
  '201': { description: 'Created SCIM resource with Location and ETag.', content: { [SCIM_MEDIA_TYPE]: { schema: { type: 'object' } } } },
  '204': { description: 'Resource deprovisioned.' },
  ...Object.fromEntries(['400', '401', '403', '404', '409', '412', '413', '415', '422', '429', '503'].map(status => [status, scimError])),
};

function scimRequestBody(schema: Record<string, unknown>): Record<string, unknown> {
  return { required: true, content: { [SCIM_MEDIA_TYPE]: { schema }, 'application/json': { schema } } };
}

type ScimHandler = (c: AppContext, context: ProvisioningContext) => Promise<Response> | Response;
const scimContexts = new WeakMap<AppContext, ProvisioningContext>();
function scimHandler(capability: Parameters<typeof authenticateScim>[1], handler: ScimHandler): (c: AppContext) => Promise<Response> {
  return async c => {
    try { return await handler(c, scimContexts.get(c) ?? await authenticateScim(c, capability)); }
    catch (error) { return scimErrorResponse(error, c.get('requestId')); }
  };
}

function registerScimRoutes(app: App): void {
  const root = '/scim/v2/:orgId';
  app.use(`${root}/*`, async (c, next) => {
    const resource = c.req.path.split('/')[4];
    const search = c.req.method === 'POST' && c.req.path.endsWith('/.search');
    const writing = !search && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method);
    const capability = resource === 'Users' ? writing ? 'scim.users.write' : 'scim.users.read'
      : resource === 'Groups' ? writing ? 'scim.groups.write' : 'scim.groups.read'
      : ['ServiceProviderConfig', 'Schemas', 'ResourceTypes'].includes(resource ?? '') ? 'scim.discovery.read' : null;
    try {
      // SCIM's provider-bound credential registry is its authorization authority.
      // Authenticate it before core captures the immutable mutation principal.
      if (capability) scimContexts.set(c, await authenticateScim(c, capability));
      await next();
    } catch (error) { return scimErrorResponse(error, c.get('requestId')); }
    if (c.res.status >= 400 && !c.res.headers.get('content-type')?.startsWith(SCIM_MEDIA_TYPE)) {
      let detail = 'Organization provisioning could not complete this request.';
      try {
        const failure = JSON.parse(new TextDecoder().decode(await readBounded(c.res.clone().body, 65_536))) as { error?: { message?: string } };
        if (typeof failure.error?.message === 'string') detail = failure.error.message;
      } catch { /* Keep infrastructure/parser failures within SCIM error/media semantics. */ }
      c.res = scimErrorResponse(new ScimError(c.res.status, detail), c.get('requestId'));
    }
  });
  for (const kind of ['User', 'Group'] as const) {
    const segment = `${root}/${kind}s`;
    const readCapability = kind === 'User' ? 'scim.users.read' : 'scim.groups.read';
    const writeCapability = kind === 'User' ? 'scim.users.write' : 'scim.groups.write';
    const options = { tags: ['Enterprise provisioning'], idempotent: false, responses: scimResponses,
      description: 'SCIM 2.0 JSON/media/error semantics. Only a provider-bound provisioning bearer token is accepted. If-Match is optional and honored; writes always use atomic revision guards.' };
    route(app, 'GET', segment, { ...options, summary: `List provisioned ${kind}s`, capability: readCapability,
      parameters: [{ name: 'filter', in: 'query', schema: { type: 'string', maxLength: 2048 } },
        { name: 'startIndex', in: 'query', schema: { type: 'integer', default: 1 } }, { name: 'count', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 100 } }] },
    scimHandler(readCapability, (c, context) => listScimResources(c, context, kind)));
    route(app, 'POST', `${segment}/.search`, { ...options, summary: `Search provisioned ${kind}s`, capability: readCapability,
      requestBody: scimRequestBody({ type: 'object', required: ['schemas'], properties: { schemas: { type: 'array', items: { const: SCIM_SEARCH_SCHEMA } },
        filter: { type: 'string', maxLength: 2048 }, startIndex: { type: 'integer', default: 1 }, count: { type: 'integer', minimum: 0, maximum: 100 },
        attributes: { type: 'array', items: { type: 'string' } }, excludedAttributes: { type: 'array', items: { type: 'string' } } } }) },
      scimHandler(readCapability, (c, context) => listScimResources(c, context, kind, true)));
    route(app, 'GET', `${segment}/:id`, { ...options, summary: `Get a provisioned ${kind}`, capability: readCapability },
      scimHandler(readCapability, (c, context) => readScimResource(c, context, kind)));
    route(app, 'POST', segment, { ...options, summary: `Provision a ${kind}`, requestBody: scimRequestBody(scimInputJsonSchema(kind)),
      parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string', maxLength: 128 }, description: 'Provider/credential-bound create retry key.' }] },
      scimHandler(writeCapability, (c, context) => idempotentScimCreate(c, context, kind, () => kind === 'User' ? createScimUser(c, context) : createScimGroup(c, context))));
    for (const method of ['PUT', 'PATCH']) route(app, method, `${segment}/:id`, { ...options, summary: `${method === 'PUT' ? 'Replace' : 'Patch'} a provisioned ${kind}`,
      requestBody: scimRequestBody(scimInputJsonSchema(method === 'PATCH' ? 'Patch' : kind)) },
      scimHandler(writeCapability, (c, context) => kind === 'User' ? updateScimUser(c, context, method === 'PATCH') : updateScimGroup(c, context, method === 'PATCH')));
    route(app, 'DELETE', `${segment}/:id`, { ...options, summary: `Deprovision a ${kind}` },
      scimHandler(writeCapability, kind === 'User' ? deleteScimUser : deleteScimGroup));
  }
  for (const name of ['ServiceProviderConfig', 'Schemas', 'ResourceTypes'] as const) {
    route(app, 'GET', `${root}/${name}`, { summary: `Discover SCIM ${name}`, tags: ['Enterprise provisioning'], responses: scimResponses, idempotent: false },
      scimHandler('scim.discovery.read', c => scimDiscovery(c, name)));
    if (name !== 'ServiceProviderConfig') route(app, 'GET', `${root}/${name}/:id`, { summary: `Get a SCIM ${name} definition`, tags: ['Enterprise provisioning'], responses: scimResponses, idempotent: false },
      scimHandler('scim.discovery.read', c => scimDiscovery(c, name, c.req.param('id'))));
  }
  // Protocol fallbacks must not reach the web application's HTML/asset fallback.
  app.all(`${root}/*`, c => scimErrorResponse(new ScimError(404, 'The SCIM endpoint or method is not supported.'), c.get('requestId')));
  app.all(root, c => scimErrorResponse(new ScimError(404, 'Select a SCIM resource endpoint.'), c.get('requestId')));
}

export function registerFederationRoutes(app: App): void {
  const options = { tags: ['Enterprise identity'], capability: 'identities.manage' };
  route(app, 'GET', '/v1/auth/federation/discovery', { summary: 'Discover versioned organization identity protocols', public: true }, c => c.json(federationDiscovery(c)));
  route(app, 'GET', `${base}/policy`, { ...options, summary: 'Read the organization SSO policy' }, getPolicy);
  route(app, 'PUT', `${base}/policy`, { ...options, summary: 'Set organization SSO and fresh-session policy', body: organizationPolicySchema }, updatePolicy);
  route(app, 'POST', `${base}/discovery`, { ...options, summary: 'Discover an approved OIDC issuer', body: discoverySchema, idempotent: false }, async c => {
    await requireFederationAdministrator(c, c.req.param('orgId')!, true);
    return c.json(await discoverOidcConfiguration(c.env, (await jsonBody(c, discoverySchema)).issuer));
  });
  route(app, 'GET', base, { ...options, summary: 'List organization identity providers' }, listProviders);
  route(app, 'POST', base, { ...options, summary: 'Configure a disabled organization identity provider', body: createProviderSchema }, createProvider);
  route(app, 'GET', `${base}/:providerId`, { ...options, summary: 'Read an organization identity provider' }, async c => {
    await requireFederationAdministrator(c, c.req.param('orgId')!);
    return providerResponse(c, await getProvider(c.env.DB, c.req.param('providerId')!, c.req.param('orgId')!));
  });
  route(app, 'PATCH', `${base}/:providerId`, { ...options, summary: 'Update or enable an organization identity provider', body: updateProviderSchema }, updateProvider);
  route(app, 'DELETE', `${base}/:providerId`, { ...options, summary: 'Disable and remove an organization identity provider' }, deleteProvider);
  route(app, 'PUT', `${base}/:providerId/secrets/:kind`, { ...options, summary: 'Rotate an envelope-encrypted federation secret', body: secretSchema, sensitive: true, idempotent: false }, c => manageSecret(c, false));
  route(app, 'DELETE', `${base}/:providerId/secrets/:kind`, { ...options, summary: 'Revoke a federation secret and disable its provider', idempotent: false }, c => manageSecret(c, true));
  route(app, 'GET', `${base}/:providerId/provisioning-tokens`, { ...options, summary: 'List scoped SCIM provisioning credentials' }, listTokens);
  route(app, 'POST', `${base}/:providerId/provisioning-tokens`, { ...options, summary: 'Issue an expiring SCIM-only provisioning credential', body: createProvisioningTokenSchema, sensitive: true }, async c => {
    await requireFederationAdministrator(c, c.req.param('orgId')!, true);
    const provider = await getProvider(c.env.DB, c.req.param('providerId')!, c.req.param('orgId')!, true);
    const created = await createProvisioningToken(c, provider, await jsonBody(c, createProvisioningTokenSchema));
    c.header('etag', etag(1));
    c.header('location', `/v1/orgs/${provider.account_id}/identity-providers/${provider.id}/provisioning-tokens/${created.id}`);
    return c.json(created, 201);
  });
  route(app, 'DELETE', `${base}/:providerId/provisioning-tokens/:tokenId`, { ...options, summary: 'Revoke a SCIM provisioning credential' }, revokeToken);
  route(app, 'POST', `${base}/:providerId/credentials/:credentialId/authorize`, { summary: 'Bind a personal token to fresh organization SSO', tags: options.tags, idempotent: false }, authorizeExistingCredential);
  for (const protocol of ['oidc', 'saml'] as const) {
    route(app, 'GET', `/v1/auth/${protocol}/:providerId/start`, { summary: `Start browser-bound ${protocol.toUpperCase()} organization sign-in`, public: true, idempotent: false }, c => start(c, protocol, false));
    route(app, 'POST', `/v1/auth/${protocol}/:providerId/start`, { summary: `Start or explicitly link ${protocol.toUpperCase()} organization identity`, public: true, body: startSchema, idempotent: false }, c => start(c, protocol, true));
  }
  route(app, 'GET', '/v1/auth/oidc/:providerId/callback', { summary: 'Verify an OIDC code, PKCE and identity assertion', public: true, idempotent: false }, oidcCallback);
  route(app, 'GET', '/v1/auth/saml/:providerId/metadata', { summary: 'Read organization SAML service-provider metadata', public: true,
    responses: { '200': { description: 'SAML service-provider metadata.', content: { 'application/samlmetadata+xml': { schema: { type: 'string' } } } } } }, async c => {
    const provider = await getProvider(c.env.DB, c.req.param('providerId')!);
    const key = await one<{ public_certificate: string }>(c.env.DB,
      "SELECT public_certificate FROM federation_client_secrets WHERE account_id=? AND provider_id=? AND kind='saml_signing_key' AND revoked_at IS NULL", provider.account_id, provider.id);
    return new Response(samlMetadata(c.env, provider, key?.public_certificate ?? null), { headers: { 'content-type': 'application/samlmetadata+xml; charset=utf-8', 'cache-control': 'public, max-age=300' } });
  });
  route(app, 'POST', '/v1/auth/saml/:providerId/acs', { summary: 'Verify a browser-bound, signed SAML Web SSO response', public: true, idempotent: false,
    requestBody: { required: true, content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', required: ['SAMLResponse', 'RelayState'], additionalProperties: false,
      properties: { SAMLResponse: { type: 'string', contentEncoding: 'base64', maxLength: 174764 }, RelayState: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } } } } } },
    responses: { '303': { description: 'Verified sign-in or link; navigate to the application.', headers: { Location: { schema: { type: 'string', format: 'uri' } } } } } }, samlAcs);
  registerScimRoutes(app);
}
