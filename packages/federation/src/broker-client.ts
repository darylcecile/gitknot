import { ApiError, readBounded, signInternalRequest } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import { integrationUnavailable } from './errors.ts';
import type { OidcTokens } from './oidc.ts';
import type { AuthenticationFlow, Provider } from './types.ts';

export type FederationBrokerScope = 'federation.manage' | 'federation.exchange' | 'federation.sign' | 'federation.rotate';

export async function federationBrokerCall<T>(env: Bindings, path: string, scope: FederationBrokerScope, payload: unknown): Promise<T> {
  const id = env.SECRETS_CLIENT_ID;
  const key = env.SECRETS_CLIENT_KEY;
  if (!env.SECRETS || typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id) || typeof key !== 'string' || !/^[\w-]{43,128}$/.test(key)) throw integrationUnavailable();
  const request = await signInternalRequest(new Request(`https://internal.gitknot.com/internal/federation/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-gitknot-service-client': id }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
  }), key, scope);
  let response: Response;
  try { response = await env.SECRETS.fetch(request); }
  catch { throw integrationUnavailable(); }
  let result: unknown;
  try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(response.body, 65_536))); }
  catch { throw integrationUnavailable(); }
  if (!response.ok) {
    if (response.status === 409 || response.status === 412) throw new ApiError(response.status, 'federation_state_changed', 'The identity configuration or request changed. Retrieve its current state and start again.');
    if (response.status === 422) throw new ApiError(422, 'federation_secret_invalid', 'The identity provider secret or signing certificate could not be accepted.');
    throw integrationUnavailable();
  }
  return result as T;
}

export async function exchangeConfidentialOidcCode(env: Bindings, provider: Provider, flow: AuthenticationFlow, code: string): Promise<OidcTokens> {
  const result = await federationBrokerCall<OidcTokens>(env, 'exchange', 'federation.exchange', {
    account_id: provider.account_id, provider_id: provider.id, flow_id: flow.id, code,
  });
  if (typeof result?.id_token !== 'string' || result.id_token.length > 32_768
    || (result.access_token !== undefined && typeof result.access_token !== 'string')) throw integrationUnavailable();
  return result;
}

export async function signSamlRedirect(env: Bindings, provider: Provider, flow: AuthenticationFlow, state: string): Promise<string> {
  const result = await federationBrokerCall<{ redirect_url: string }>(env, 'sign', 'federation.sign', {
    account_id: provider.account_id, provider_id: provider.id, flow_id: flow.id, state,
  });
  if (typeof result?.redirect_url !== 'string' || result.redirect_url.length > 16_384) throw integrationUnavailable();
  // The broker is private, but a bad response must still not become an open redirect.
  const expected = provider.config.protocol === 'saml' ? new URL(provider.config.sso_url) : null;
  const returned = new URL(result.redirect_url);
  if (!expected || returned.origin !== expected.origin || returned.pathname !== expected.pathname || returned.hash) throw integrationUnavailable();
  return result.redirect_url;
}
