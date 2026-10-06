import { ApiError } from './errors.ts';
import { hmac, now, randomToken, sha256, verifyHmac } from './crypto.ts';
import { execute } from './db.ts';
import { readBounded } from './limits.ts';
import type { Database } from './types.ts';

const maxAgeSeconds = 60;
const signatureHeader = 'x-gitknot-internal-signature';

function serviceKey(key: string): void {
  if (typeof key !== 'string' || new TextEncoder().encode(key).length < 32) {
    throw new ApiError(503, 'service_unavailable', 'The GitKnot service is temporarily unavailable.');
  }
}

function signatureInput(request: Request, scope: string, timestamp: string, nonce: string, digest: string): string {
  const url = new URL(request.url);
  const routing = ['resource', 'cell', 'shard', 'epoch', 'hops'].map(name => request.headers.get(`x-gitknot-routing-${name}`) ?? '');
  return [request.method.toUpperCase(), url.host, url.pathname + url.search, scope, timestamp, nonce, digest, ...routing].join('\n');
}

async function requestDigest(request: Request): Promise<string> {
  try { return await sha256(await readBounded(request.clone().body, 4 * 1024 ** 2)); }
  catch (error) {
    if (request.body && !request.body.locked) void request.body.cancel('Internal request rejected.').catch(() => undefined);
    throw error;
  }
}

/** Internal JSON requests are content-bound. Streaming transports must supply a verified digest. */
export async function signInternalRequest(request: Request, key: string, scope: string): Promise<Request> {
  serviceKey(key);
  if (!/^[a-z][a-z0-9_.:/-]{0,127}$/.test(scope)) throw new TypeError('Invalid internal request scope.');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomToken(24);
  const declared = request.headers.get('x-gitknot-content-sha256');
  let digest = declared;
  if (!digest) digest = await requestDigest(request);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError('Internal requests require a SHA-256 content digest.');
  const headers = new Headers(request.headers);
  headers.set('x-gitknot-internal-scope', scope);
  headers.set('x-gitknot-internal-time', timestamp);
  headers.set('x-gitknot-internal-nonce', nonce);
  headers.set('x-gitknot-content-sha256', digest);
  headers.set(signatureHeader, await hmac(key, signatureInput(request, scope, timestamp, nonce, digest)));
  return new Request(request, { headers });
}

export interface InternalVerification {
  /** Use for externally reachable cross-account requests to reject replay, in the target's authoritative shard. */
  database?: Database;
  /** Only valid when the caller consumes and verifies the declared body digest itself before effects. */
  streaming?: boolean;
}

export async function verifyInternalRequest(request: Request, key: string, scope: string, options: InternalVerification = {}): Promise<void> {
  serviceKey(key);
  const timestamp = request.headers.get('x-gitknot-internal-time') ?? '';
  const nonce = request.headers.get('x-gitknot-internal-nonce') ?? '';
  const digest = request.headers.get('x-gitknot-content-sha256') ?? '';
  const signature = request.headers.get(signatureHeader) ?? '';
  const receivedScope = request.headers.get('x-gitknot-internal-scope');
  const seconds = Number(timestamp);
  const invalid = receivedScope !== scope || !/^\d{10,12}$/.test(timestamp) || !/^[\w-]{32}$/.test(nonce)
    || !/^[a-f0-9]{64}$/.test(digest) || Math.abs(Date.now() / 1000 - seconds) > maxAgeSeconds;
  if (invalid || !await verifyHmac(key, signatureInput(request, scope, timestamp, nonce, digest), signature)) {
    throw new ApiError(401, 'invalid_service_credential', 'This internal service request could not be authenticated.');
  }
  if (!options.streaming && await requestDigest(request) !== digest) {
    throw new ApiError(401, 'invalid_service_body', 'The internal service request body was altered.');
  }
  if (options.database) {
    try {
      await execute(options.database, 'INSERT INTO internal_nonces (scope,nonce,expires_at) VALUES (?,?,?)',
        scope, nonce, new Date(Date.now() + 2 * maxAgeSeconds * 1000).toISOString());
    } catch (error) {
      if (/UNIQUE constraint failed/i.test(String(error))) throw new ApiError(409, 'service_request_replayed', 'This service request has already been received.');
      throw error;
    }
  }
}

export async function internalFetch(service: Fetcher, key: string, scope: string, path: string, payload?: unknown): Promise<Response> {
  const request = new Request(`https://internal.gitknot.com${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-gitknot-request-time': now() },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return service.fetch(await signInternalRequest(request, key, scope));
}
