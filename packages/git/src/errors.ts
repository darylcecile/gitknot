import { ApiError } from '../../core/src/errors.ts';

export class GitError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 422, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GitError';
    this.code = code;
    this.status = status;
  }
}

export function gitErrorResponse(error: unknown, requestId: string = crypto.randomUUID()): Response {
  const known = error instanceof GitError || error instanceof ApiError;
  return Response.json({ error: {
    code: known ? error.code : 'git_unavailable',
    message: known ? error.message : 'Git storage is temporarily unavailable.',
    request_id: requestId,
  } }, { status: known ? error.status : 503, headers: { 'cache-control': 'no-store', 'x-request-id': requestId } });
}

export function requireValue(condition: unknown, code: string, message: string, status = 422): asserts condition {
  if (!condition) throw new GitError(code, message, status);
}
