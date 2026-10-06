import { ApiError, internalFetch, resolveRepositoryPlacement, resolveResourceLocator, signInternalRequest } from '@gitknot/core';
import { cellService } from '@gitknot/core/routing/cells';
import type { Bindings } from '@gitknot/core';

export const EXECUTION_SCOPE = 'execution';

export async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const value = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    // Provider/raw bodies are never passed through to callers.
    throw new ApiError(response.status >= 500 ? 503 : response.status, value?.error?.code ?? 'execution_unavailable',
      response.status >= 500 ? 'GitKnot execution is temporarily unavailable.' : value?.error?.message ?? 'The execution request was rejected.');
  }
  return response.json<T>();
}

export async function attemptRequest<T = Record<string, unknown>>(env: Bindings, id: string, action: string, body?: unknown, hops = 0): Promise<T> {
  if (!/^att_[a-zA-Z0-9_-]+$/.test(id)) throw new ApiError(404, 'not_found', 'The attempt was not found.');
  const locator = await resolveResourceLocator(env, id, 'attempt');
  if (!locator?.repo_id || locator.authority !== 'repository') throw new ApiError(404, 'not_found', 'The attempt locator was not found.');
  const placement = await resolveRepositoryPlacement(env, locator.repo_id);
  if (!placement) throw new ApiError(404, 'not_found', 'The attempt repository was not found.');
  if (placement.cell_id !== env.CELL_ID) {
    if (hops >= 2) throw new ApiError(503, 'routing_unavailable', 'The attempt route could not be stabilized.');
    return responseJson<T>(await internalFetch(cellService(env, placement.cell_id), env.INTERNAL_SERVICE_KEY, EXECUTION_SCOPE,
      `/internal/execution/attempts/${id}/${action}?hops=${hops + 1}`, body ?? {}));
  }
  const stub = env.ATTEMPTS.get(env.ATTEMPTS.idFromName(id));
  return responseJson<T>(await internalFetch(stub, env.INTERNAL_SERVICE_KEY, EXECUTION_SCOPE, `/internal/attempts/${id}/${action}?shard_id=${encodeURIComponent(placement.shard_id)}`, body ?? {}));
}

export async function executionRequest<T>(env: Bindings, path: string, body?: unknown): Promise<T> {
  return responseJson<T>(await internalFetch(env.EXECUTOR, env.INTERNAL_SERVICE_KEY, EXECUTION_SCOPE, path, body));
}

export async function forwardAttemptUpload(env: Bindings, request: Request, attemptId: string): Promise<Response> {
  const url = new URL(request.url);
  const target = new URL(`/internal/attempts/${attemptId}/${url.pathname.split('/').at(-1)}`, 'https://internal.gitknot.com');
  target.search = url.search;
  const forwarded = new Request(target, request);
  return env.EXECUTOR.fetch(await signInternalRequest(forwarded, env.INTERNAL_SERVICE_KEY, EXECUTION_SCOPE));
}

export async function bounded<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ApiError(504, 'execution_timeout', message)), milliseconds); })]);
  } finally { clearTimeout(timer); }
}
