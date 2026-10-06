import { ApiError, diagnostic, execute, newId, now, signInternalRequest } from '@gitknot/core';
import { readBounded } from './security.ts';
import type { OperationsBindings } from './types.ts';
import type { Bindings } from '@gitknot/core';

export async function recordDiagnostic(env: OperationsBindings, component: string, resourceId: string | null, error: unknown): Promise<void> {
  const id = newId('diag');
  const details = { diagnostic: diagnostic(error), ...(error instanceof Error && 'code' in error ? { code: String(error.code) } : {}) };
  console.error(JSON.stringify({ id, component, resource_id: resourceId, ...details }));
  env.METRICS?.writeDataPoint({ indexes: [env.CELL_ID], blobs: [component, 'failure'], doubles: [1] });
  await execute(env.DB, `INSERT INTO operations_diagnostics(id,component,resource_id,error_code,detail_json,created_at,expires_at)
    VALUES(?,?,?,'operation_error',?,?,?)`, id, component, resourceId, JSON.stringify(details), now(), new Date(Date.now() + 30 * 86400_000).toISOString());
}

export async function privateRequest(env: Pick<Bindings, 'INTERNAL_SERVICE_KEY'>, service: Fetcher, scope: string, path: string, payload?: unknown, method?: string): Promise<Response> {
  if (!service?.fetch) throw new ApiError(503, 'service_unavailable', 'This GitKnot operation is temporarily unavailable.');
  const request = new Request(`https://internal.gitknot.com${path}`, {
    method: method ?? (payload === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(scope === 'git-service' ? 900_000 : 30_000),
  });
  return service.fetch(await signInternalRequest(request, env.INTERNAL_SERVICE_KEY, scope));
}

export async function privateJSON<T>(env: OperationsBindings, service: Fetcher, scope: string, path: string, payload?: unknown, method?: string): Promise<T> {
  const response = await privateRequest(env, service, scope, path, payload, method);
  const body = await readBounded(response, 1024 * 1024);
  if (!response.ok) {
    await recordDiagnostic(env, scope, null, new Error(`status=${response.status} ${body}`));
    throw new ApiError(response.status >= 500 ? 503 : 409, 'operation_unavailable', 'The operation could not complete its current step. Its durable state is retained for recovery.');
  }
  if (response.status === 204 && !body) return {} as T;
  try { return JSON.parse(body) as T; }
  catch { throw new Error('invalid_internal_response'); }
}
