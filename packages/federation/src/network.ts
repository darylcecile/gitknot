import { ApiError, readBounded } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import type { ProviderConfig } from './types.ts';

export type FederationFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Tenant configuration cannot extend this operator-controlled, exact-origin allowlist. */
export function trustedFederationOrigins(env: Bindings): ReadonlySet<string> {
  try {
    const values: unknown = JSON.parse(String(env.FEDERATION_TRUSTED_ORIGINS_JSON));
    if (!Array.isArray(values) || values.length < 1 || values.length > 128) throw new Error('Invalid origins');
    const origins = values.map(value => {
      if (typeof value !== 'string') throw new Error('Invalid origin');
      const url = publicHttpsUrl(value);
      if (url.origin !== value) throw new Error('Only exact origins are supported');
      return value;
    });
    return new Set(origins);
  } catch { throw new ApiError(503, 'federation_network_unavailable', 'Organization identity network access has not been configured.'); }
}

function publicHttpsUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (value.length > 2048 || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
    || hostname.endsWith('.') || !hostname.includes('.') || /^[\d.]+$/.test(hostname) || hostname.includes(':')
    || /(?:^|\.)(?:localhost|local|internal|test|invalid|home|lan|onion)$/.test(hostname)
    || /[\s\\\x00-\x1f\x7f]/.test(value)) throw new Error('An approved public HTTPS endpoint is required');
  return url;
}

export function federationEndpoint(value: string, origins: ReadonlySet<string>): URL {
  try {
    const url = publicHttpsUrl(value);
    if (!origins.has(url.origin)) throw new Error('Unapproved origin');
    return url;
  } catch { throw new ApiError(422, 'federation_endpoint_not_allowed', 'Use an HTTPS identity endpoint on an operator-approved origin.'); }
}

export function validateProviderEndpoints(config: ProviderConfig, origins: ReadonlySet<string>): void {
  const urls = config.protocol === 'oidc'
    ? [config.issuer, config.authorization_endpoint, config.token_endpoint, config.jwks_uri] : [config.sso_url];
  for (const value of urls) {
    const url = federationEndpoint(value, origins);
    if (url.search) throw new ApiError(422, 'federation_endpoint_query', 'Configure an identity endpoint without query parameters.');
  }
}

/** Redirects, response bytes, and total request time are all bounded, including streamed bodies. */
export async function fetchFederationJson(url: URL, origins: ReadonlySet<string>, init: RequestInit = {}, fetcher: FederationFetch = fetch): Promise<unknown> {
  federationEndpoint(url.href, origins);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetcher(url, { ...init, redirect: 'manual', signal: controller.signal,
      headers: { accept: 'application/json', ...Object.fromEntries(new Headers(init.headers)) } });
    if (response.status !== 200 || response.redirected || !/^application\/(?:[a-z0-9.+-]+\+)?json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      throw new Error('Identity response rejected');
    }
    if (Number(response.headers.get('content-length')) > 65_536) {
      await response.body?.cancel();
      throw new Error('Identity response too large');
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(response.body, 65_536)));
  } catch {
    throw new ApiError(502, 'identity_provider_unavailable', 'The identity provider did not return a valid response. Start a new sign-in or contact the organization administrator.');
  } finally { clearTimeout(timer); }
}

export function safeReturnPath(value: string | undefined): string {
  const path = value ?? '/';
  if (path.length > 1024 || !path.startsWith('/') || path.startsWith('//') || /[\\\x00-\x20\x7f]/.test(path)
    || /%(?:00|0[ad]|2f|5c)/i.test(path)) throw new ApiError(422, 'invalid_return_path', 'return_to must be a local GitKnot application path.');
  const url = new URL(path, 'https://gitknot.com');
  if (url.origin !== 'https://gitknot.com') throw new ApiError(422, 'invalid_return_path', 'return_to must be a local GitKnot application path.');
  return url.pathname + url.search + url.hash;
}
