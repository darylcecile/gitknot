import type { AppContext } from './types.ts';
import type { StatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function fail(status: number, code: string, message: string, details?: unknown): never {
  throw new ApiError(status, code, message, details);
}

export function notFound(message = 'The requested resource was not found.'): never {
  return fail(404, 'not_found', message);
}

export function conflict(message: string, details?: unknown): never {
  return fail(409, 'conflict', message, details);
}

export function diagnostic(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message
    .replace(/(?:Bearer|Basic)\s+[^\s"']+/gi, '[credential redacted]')
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[credential redacted]@')
    .replace(/\b(?:gkt|gk)_[A-Za-z0-9_-]{24,}\b/g, '[credential redacted]')
    .slice(0, 4096);
}

export function errorResponse(error: unknown, c: AppContext): Response {
  const publicError = error instanceof ApiError ? error : error instanceof ZodError
    ? new ApiError(422, 'validation_failed', 'Some fields need your attention.', {
      fields: error.issues.map(issue => ({ path: issue.path.map(String).join('.'), code: issue.code, message: issue.message })),
    }) : null;
  const requestId = c.get('requestId') ?? crypto.randomUUID();
  if (!publicError || publicError.status >= 500) {
    console.error(JSON.stringify({
      event: 'request.failed', request_id: requestId,
      method: c.req.method, path: c.req.path, diagnostic: diagnostic(error),
    }));
  }
  return c.newResponse(JSON.stringify({ error: {
    code: publicError?.code ?? 'internal_error',
    message: publicError?.message ?? 'GitKnot could not complete this request. Retry with the same idempotency key, or contact support with the request ID.',
    request_id: requestId,
    ...(publicError?.details !== undefined ? { details: publicError.details } : {}),
  } }), (publicError?.status ?? 500) as StatusCode,
  { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-gitknot-request-id': requestId });
}
