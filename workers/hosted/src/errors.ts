import { ApiError } from '@gitknot/core';

export function hostedError(error: unknown): Response {
  const known = error instanceof ApiError;
  return Response.json({ error: {
    code: known ? error.code : 'hosted_unavailable',
    message: known ? error.message : 'The hosted executor could not confirm this operation.',
  } }, { status: known ? error.status : 503, headers: { 'cache-control': 'no-store' } });
}

export function fenced(): ApiError {
  return new ApiError(409, 'attempt_fenced', 'This hosted allocation is closed, expired, or already consumed.');
}

/** Timing out a wait does not cancel its effects or clear its durable operation. */
export async function bounded<T>(promise: Promise<T>, milliseconds: number, code = 'hosted_operation_unconfirmed'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ApiError(503, code, 'The hosted operation has not been confirmed.')), Math.max(1, milliseconds));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
