import type { MiddlewareHandler, Next } from 'hono';
import { authenticate } from './auth.ts';
import { ApiError } from './errors.ts';
import { database } from './db.ts';
import { sha256 } from './crypto.ts';
import type { AppContext, AppEnv } from './types.ts';

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const allowedHeaders = 'Authorization, Content-Type, If-Match, If-None-Match, Idempotency-Key, X-GitKnot-CSRF, X-GitKnot-Bookmark, X-Content-SHA256';

function responseHeaders(c: AppContext): void {
  c.header('x-gitknot-request-id', c.get('requestId'));
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'strict-origin-when-cross-origin');
  c.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  if (!c.res.headers.has('content-security-policy')) {
    const apiOrigin = new URL(c.env.API_ORIGIN).origin;
    c.header('content-security-policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: ${apiOrigin}; font-src 'self'; connect-src 'self' ${apiOrigin}; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`);
  }
  if (c.env.ENVIRONMENT === 'production' || c.env.ENVIRONMENT === 'staging') {
    c.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
  if ((c.req.path.startsWith('/v1/') || c.req.path.startsWith('/scim/')) && !c.res.headers.has('cache-control')) c.header('cache-control', 'no-store');
}

export const requestContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('requestId', `req_${crypto.randomUUID().replaceAll('-', '')}`);
  c.set('principal', null);
  await next();
  responseHeaders(c);
  const session = c.get('database');
  const bookmark = session?.getBookmark();
  if (bookmark) c.header('x-gitknot-bookmark', bookmark);
};

export const browserBoundary: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header('origin');
  const allowed = origin === c.env.APP_ORIGIN || origin === c.env.API_ORIGIN;
  if (origin && allowed) {
    c.header('access-control-allow-origin', origin);
    c.header('access-control-allow-credentials', 'true');
    c.header('access-control-expose-headers', 'ETag, Link, X-GitKnot-Request-ID, X-GitKnot-Bookmark, Retry-After, Idempotency-Replayed');
    c.header('vary', 'Origin');
  }
  if (c.req.method === 'OPTIONS') {
    if (!allowed) throw new ApiError(403, 'origin_not_allowed', 'This browser origin is not authorized.');
    c.header('access-control-allow-methods', 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    c.header('access-control-allow-headers', allowedHeaders);
    c.header('access-control-max-age', '600');
    return c.body(null, 204);
  }
  if (unsafeMethods.has(c.req.method)) {
    if (origin && !allowed) throw new ApiError(403, 'origin_not_allowed', 'This browser origin is not authorized.');
    const cookieAuthenticated = c.req.header('cookie') && !c.req.header('authorization');
    if (cookieAuthenticated && (!allowed || c.req.header('x-gitknot-csrf') !== '1')) {
      throw new ApiError(403, 'csrf_required', 'Browser mutations require the GitKnot origin and X-GitKnot-CSRF: 1.');
    }
  }
  await next();
  if (origin && allowed) {
    c.header('access-control-allow-origin', origin);
    c.header('access-control-allow-credentials', 'true');
    c.header('access-control-expose-headers', 'ETag, Link, X-GitKnot-Request-ID, X-GitKnot-Bookmark, Retry-After, Idempotency-Replayed');
    const vary = c.res.headers.get('vary');
    if (!vary?.split(/,\s*/).some(value => value.toLowerCase() === 'origin')) c.header('vary', vary ? `${vary}, Origin` : 'Origin');
  }
};

async function applyRequestLimit(c: AppContext, next: Next): Promise<void> {
  database(c);
  const limiter = c.env.API_RATE_LIMITER as RateLimit | undefined;
  if (limiter) {
    const principal = c.get('principal');
    const key = principal?.id ?? `anon:${await sha256(c.req.header('cf-connecting-ip') ?? 'local')}`;
    const result = await limiter.limit({ key });
    if (!result.success) {
      c.header('retry-after', '60');
      throw new ApiError(429, 'rate_limited', 'Too many requests. Retry after the indicated delay.');
    }
  }
  await next();
}

export const identityContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('principal', await authenticate(c.req.raw, c.env));
  await applyRequestLimit(c, next);
};

/** Protocol handlers authenticate their exact enrollment/exchange/termination capability themselves. */
export const protocolIdentityContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('principal', null);
  await applyRequestLimit(c, next);
};
