import { canonicalJson, hmac, randomToken, sha256, verifyHmac } from '../crypto.ts';
import { execute } from '../db.ts';
import { ApiError } from '../errors.ts';
import type { Database } from '../types.ts';
import type { RepositoryPlacement } from './repositories.ts';

const purpose = 'GitKnot public cell routing v1';
const lifetimeSeconds = 60;
const signedHeaders = ['authorization', 'cookie', 'origin', 'x-gitknot-csrf', 'content-type',
  'if-match', 'if-none-match', 'idempotency-key', 'range', 'if-range', 'x-content-sha256'];
const placementHeaders = ['resource', 'cell', 'shard', 'epoch', 'hops', 'issued', 'deadline', 'nonce'];

function signingKey(key: string): void {
  if (typeof key !== 'string' || new TextEncoder().encode(key).length < 32) {
    throw new ApiError(503, 'routing_unavailable', 'The repository routing service is unavailable.');
  }
}

function routable(request: Request): void {
  const path = new URL(request.url).pathname;
  const callback = /^\/internal\/hosted\/attempts\/[A-Za-z0-9_-]+\/[a-z-]+$/.test(path);
  if (!path.startsWith('/v1/') && !callback) {
    throw new ApiError(401, 'invalid_routing_envelope', 'This path does not accept public repository routing credentials.');
  }
}

async function signatureInput(request: Request): Promise<string> {
  const url = new URL(request.url);
  const callbacks = [...request.headers.keys()].filter(name => name.startsWith('x-gitknot-callback-')).sort();
  const authenticated = canonicalJson([...signedHeaders, ...callbacks].map(name => [name, request.headers.get(name)]));
  if (authenticated.length > 32 * 1024) throw new ApiError(431, 'request_headers_too_large', 'The routing authentication headers exceed the supported limit.');
  return canonicalJson([purpose, request.method.toUpperCase(), url.origin, url.pathname + url.search,
    await sha256(authenticated), ...placementHeaders.map(name => request.headers.get(`x-gitknot-routing-${name}`))]);
}

export function hasRoutingEnvelope(request: Request): boolean {
  return [...request.headers.keys()].some(name => name.startsWith('x-gitknot-routing-'));
}

/** Authenticate only routing metadata. The public body stays a backpressured stream. */
export async function signRoutingEnvelope(request: Request, key: string, placement: RepositoryPlacement, hops: number): Promise<Request> {
  signingKey(key);
  routable(request);
  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) {
    if (name.startsWith('x-gitknot-routing-') || name.startsWith('x-gitknot-internal-')) headers.delete(name);
  }
  const issued = Math.floor(Date.now() / 1000);
  headers.set('x-gitknot-routing-resource', placement.repo_id);
  headers.set('x-gitknot-routing-cell', placement.cell_id);
  headers.set('x-gitknot-routing-shard', placement.shard_id);
  headers.set('x-gitknot-routing-epoch', String(placement.epoch));
  headers.set('x-gitknot-routing-hops', String(hops));
  headers.set('x-gitknot-routing-issued', String(issued));
  headers.set('x-gitknot-routing-deadline', String(issued + lifetimeSeconds));
  headers.set('x-gitknot-routing-nonce', randomToken(24));
  const forwarded = new Request(request, { headers });
  forwarded.headers.set('x-gitknot-routing-signature', await hmac(key, await signatureInput(forwarded)));
  return forwarded;
}

/** This proves placement forwarding, never actor identity or a valid body digest. */
export async function verifyRoutingEnvelope(request: Request, key: string, db: Database): Promise<void> {
  signingKey(key);
  routable(request);
  const issuedText = request.headers.get('x-gitknot-routing-issued') ?? '';
  const deadlineText = request.headers.get('x-gitknot-routing-deadline') ?? '';
  const issued = Number(issuedText);
  const deadline = Number(deadlineText);
  const nonce = request.headers.get('x-gitknot-routing-nonce') ?? '';
  const signature = request.headers.get('x-gitknot-routing-signature') ?? '';
  const clock = Date.now() / 1000;
  if (!/^\d{10,12}$/.test(issuedText) || !/^\d{10,12}$/.test(deadlineText) || !/^[A-Za-z0-9_-]{32}$/.test(nonce)
    || !/^[A-Za-z0-9_-]{43}$/.test(signature) || deadline <= clock || issued > clock + 30
    || deadline <= issued || deadline - issued > lifetimeSeconds
    || !await verifyHmac(key, await signatureInput(request), signature)) {
    throw new ApiError(401, 'invalid_routing_envelope', 'The repository routing envelope could not be authenticated.');
  }
  try {
    await execute(db, 'INSERT INTO internal_nonces(scope,nonce,expires_at) VALUES (?,?,?)',
      'cell.route.public.v1', nonce, new Date((deadline + 60) * 1000).toISOString());
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error))) throw new ApiError(409, 'routing_request_replayed', 'This routed request has already been admitted.');
    throw error;
  }
}
