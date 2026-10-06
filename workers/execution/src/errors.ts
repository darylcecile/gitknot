import { ApiError } from '@gitknot/core';

export function executionError(error: unknown): Response {
  const known = error instanceof ApiError;
  const requestId = crypto.randomUUID();
  // SDK errors can contain raw command output. Only stable codes are emitted.
  if (!known || error.status >= 500) console.error(JSON.stringify({ event: 'execution.request.failed', request_id: requestId, code: known ? error.code : 'execution_failed' }));
  return Response.json({ error: { code: known ? error.code : 'execution_failed', message: known ? error.message : 'GitKnot execution could not complete this operation.', request_id: requestId } },
    { status: known ? error.status : 503, headers: { 'cache-control': 'no-store', 'x-gitknot-request-id': requestId } });
}
