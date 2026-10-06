import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { ApiError, base64url, bytes, sha256 } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import { identityClaims } from './claims.ts';
import { authenticationFailed } from './errors.ts';
import { federationEndpoint, fetchFederationJson, trustedFederationOrigins } from './network.ts';
import type { FederationFetch } from './network.ts';
import { publicOrigins } from './store.ts';
import { CLOCK_SKEW_SECONDS, FLOW_SECONDS } from './types.ts';
import type { AuthenticationFlow, OidcConfig, Provider, VerifiedIdentity } from './types.ts';

type RemoteKeys = ReturnType<typeof createRemoteJWKSet>;
const keySets = new Map<string, RemoteKeys>();

export interface OidcTokens { id_token: string; access_token?: string }

function oidcConfig(provider: Provider): OidcConfig {
  if (provider.config.protocol !== 'oidc') throw authenticationFailed();
  return provider.config;
}

export function oidcCallbackUrl(env: Bindings, providerId: string): string {
  return `${publicOrigins(env).api}/v1/auth/oidc/${providerId}/callback`;
}

export async function oidcAuthorizationUrl(env: Bindings, provider: Provider, flow: AuthenticationFlow, state: string, nonce: string): Promise<string> {
  const config = oidcConfig(provider);
  if (!flow.pkce_verifier) throw authenticationFailed();
  const url = federationEndpoint(config.authorization_endpoint, trustedFederationOrigins(env));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(flow.pkce_verifier))));
  const params: Record<string, string> = {
    client_id: config.client_id, redirect_uri: oidcCallbackUrl(env, provider.id), response_type: 'code',
    response_mode: 'query', scope: [...new Set(config.scopes)].join(' '), state, nonce,
    code_challenge: challenge, code_challenge_method: 'S256', prompt: 'login', max_age: '0',
  };
  if (config.mfa_acr_values.length) params.acr_values = config.mfa_acr_values.join(' ');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

/** Called by the broker for confidential clients; by the API only for explicitly public PKCE clients. */
export async function requestOidcTokens(env: Bindings, provider: Provider, flow: AuthenticationFlow, code: string,
  clientSecret: string | null, fetcher: FederationFetch = fetch): Promise<OidcTokens> {
  const config = oidcConfig(provider);
  if (!flow.pkce_verifier || code.length < 1 || code.length > 4096) throw authenticationFailed();
  if ((config.token_endpoint_auth_method === 'none') !== (clientSecret === null)) throw authenticationFailed();
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: oidcCallbackUrl(env, provider.id),
    client_id: config.client_id, code_verifier: flow.pkce_verifier });
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
  if (config.token_endpoint_auth_method === 'client_secret_basic') {
    // RFC 6749 section 2.3.1: form-encode each component before constructing Basic credentials.
    const form = (value: string) => new URLSearchParams({ x: value }).toString().slice(2);
    headers.set('authorization', `Basic ${btoa(`${form(config.client_id)}:${form(clientSecret!)}`)}`);
  } else if (clientSecret !== null) body.set('client_secret', clientSecret);
  const origins = trustedFederationOrigins(env);
  const raw = await fetchFederationJson(federationEndpoint(config.token_endpoint, origins), origins, { method: 'POST', headers, body }, fetcher);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw authenticationFailed();
  const value = raw as Record<string, unknown>;
  if (Object.hasOwn(value, 'error') || typeof value.id_token !== 'string' || value.id_token.length > 32_768
    || (value.access_token !== undefined && (typeof value.access_token !== 'string' || value.access_token.length > 16_384))) throw authenticationFailed();
  // Refresh tokens and unrelated response data are discarded before crossing the broker boundary.
  return { id_token: value.id_token, ...(typeof value.access_token === 'string' ? { access_token: value.access_token } : {}) };
}

function remoteKeys(provider: Provider, origins: ReadonlySet<string>, fetcher: FederationFetch): RemoteKeys {
  const config = oidcConfig(provider);
  const url = federationEndpoint(config.jwks_uri, origins);
  const cacheKey = `${provider.id}:${provider.revision}:${url.href}`;
  if (fetcher === fetch && keySets.has(cacheKey)) return keySets.get(cacheKey)!;
  const keys = createRemoteJWKSet(url, {
    timeoutDuration: 5000, cooldownDuration: 30_000, cacheMaxAge: 300_000,
    [customFetch]: async (input, options) => {
      if (input !== url.href || options.method !== 'GET') throw authenticationFailed();
      const document = await fetchFederationJson(url, origins, { method: 'GET' }, fetcher);
      if (!document || typeof document !== 'object' || !Array.isArray((document as { keys?: unknown }).keys)) throw authenticationFailed();
      const jwks = document as { keys: unknown[] };
      if (jwks.keys.length < 1 || jwks.keys.length > 32 || jwks.keys.some(key => !key || typeof key !== 'object'
        || !['RSA', 'EC'].includes(String((key as { kty?: unknown }).kty)) || Object.hasOwn(key, 'd') || Object.hasOwn(key, 'k'))) throw authenticationFailed();
      return new Response(JSON.stringify(jwks), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  if (fetcher === fetch) {
    if (keySets.size >= 128) keySets.delete(keySets.keys().next().value!);
    keySets.set(cacheKey, keys);
  }
  return keys;
}

async function verifyTokenHash(hash: unknown, input: string | undefined, algorithm: string): Promise<void> {
  if (hash === undefined) return;
  if (typeof hash !== 'string' || input === undefined) throw authenticationFailed();
  const digest = new Uint8Array(await crypto.subtle.digest(`SHA-${algorithm.slice(-3)}`, bytes(input)));
  if (base64url(digest.slice(0, digest.length / 2)) !== hash) throw authenticationFailed();
}

export async function verifyOidcIdentity(env: Bindings, provider: Provider, flow: AuthenticationFlow, tokens: OidcTokens,
  code: string, fetcher: FederationFetch = fetch): Promise<VerifiedIdentity> {
  const config = oidcConfig(provider);
  try {
    if (tokens.id_token.length > 32_768 || tokens.id_token.split('.').length !== 3) throw authenticationFailed();
    const { payload, protectedHeader } = await jwtVerify(tokens.id_token, remoteKeys(provider, trustedFederationOrigins(env), fetcher), {
      issuer: config.issuer, audience: config.client_id, algorithms: config.signing_algorithms,
      requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'nonce', 'auth_time'],
      maxTokenAge: FLOW_SECONDS, clockTolerance: CLOCK_SKEW_SECONDS,
    });
    if (typeof payload.sub !== 'string' || !payload.sub.length || payload.sub.length > 512 || typeof payload.nonce !== 'string'
      || await sha256(payload.nonce) !== flow.nonce_hash || payload.iat! < Date.parse(flow.created_at) / 1000 - CLOCK_SKEW_SECONDS) throw authenticationFailed();
    if ((Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.client_id)
      || (payload.azp !== undefined && payload.azp !== config.client_id)) throw authenticationFailed();
    const authTime = payload.auth_time;
    const current = Date.now() / 1000;
    if (typeof authTime !== 'number' || !Number.isSafeInteger(authTime) || authTime > current + CLOCK_SKEW_SECONDS
      || authTime < current - config.max_authentication_age_seconds - CLOCK_SKEW_SECONDS
      || authTime < Date.parse(flow.created_at) / 1000 - CLOCK_SKEW_SECONDS) throw authenticationFailed();
    const mfa = (Array.isArray(payload.amr) && payload.amr.length <= 32 && payload.amr.includes('mfa'))
      || (typeof payload.acr === 'string' && config.mfa_acr_values.includes(payload.acr));
    if (!mfa) throw new ApiError(403, 'organization_mfa_required', 'The identity provider must attest a fresh multi-factor authentication.');
    await verifyTokenHash(payload.at_hash, tokens.access_token, protectedHeader.alg);
    await verifyTokenHash(payload.c_hash, code, protectedHeader.alg);
    return {
      ...identityClaims(config, payload), protocol: 'oidc', issuer: config.issuer, subject: payload.sub,
      authenticated_at: new Date(authTime * 1000).toISOString(), mfa: true, session_expires_at: null,
      replays: [{ kind: 'oidc_token', value: tokens.id_token,
        expires_at: new Date((Math.min(payload.exp!, payload.iat! + FLOW_SECONDS) + CLOCK_SKEW_SECONDS) * 1000).toISOString() }],
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw authenticationFailed();
  }
}

export async function discoverOidcConfiguration(env: Bindings, issuer: string): Promise<Record<string, unknown>> {
  const origins = trustedFederationOrigins(env);
  const base = federationEndpoint(issuer, origins);
  if (base.search) throw new ApiError(422, 'oidc_issuer_invalid', 'An OIDC issuer cannot contain a query string.');
  const raw = await fetchFederationJson(new URL(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`), origins);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw authenticationFailed();
  const value = raw as Record<string, unknown>;
  if (value.issuer !== issuer || !Array.isArray(value.response_types_supported) || !value.response_types_supported.includes('code')
    || (value.code_challenge_methods_supported !== undefined && (!Array.isArray(value.code_challenge_methods_supported)
      || !value.code_challenge_methods_supported.includes('S256')))) throw authenticationFailed();
  const result: Record<string, unknown> = { issuer };
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    if (typeof value[key] !== 'string') throw authenticationFailed();
    const url = federationEndpoint(value[key], origins);
    if (url.search) throw authenticationFailed();
    result[key] = url.href;
  }
  result.signing_algorithms = Array.isArray(value.id_token_signing_alg_values_supported)
    ? value.id_token_signing_alg_values_supported.filter(value => ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384'].includes(String(value))) : [];
  result.token_endpoint_auth_methods = Array.isArray(value.token_endpoint_auth_methods_supported)
    ? value.token_endpoint_auth_methods_supported.filter(value => ['client_secret_basic', 'client_secret_post', 'none'].includes(String(value))) : ['client_secret_basic'];
  result.authorization_response_iss_parameter_supported = value.authorization_response_iss_parameter_supported === true;
  return result;
}
