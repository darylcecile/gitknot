import { signInternalRequest } from '@gitknot/core';
import { GIT_NATIVE_SCOPE } from '../../../packages/git/src/types.ts';
import type { NativeSessionSpec, NativeSessionTicket } from '../../../packages/git/src/types.ts';
import { boundedJson } from '../../../packages/git/src/protocol.ts';
import { GitError, requireValue } from '../../../packages/git/src/errors.ts';
import type { GitBindings } from './types.ts';

export function nativeHelper(env: GitBindings, repoId: string): DurableObjectStub {
  const size = Number(env.GIT_HELPER_POOL_SIZE ?? '4');
  requireValue(Number.isInteger(size) && size > 0 && size <= 64, 'git_pool_configuration', 'The trusted Git helper pool is not configured.', 503);
  let hash = 2166136261;
  for (const value of new TextEncoder().encode(repoId)) hash = Math.imul(hash ^ value, 16777619);
  return env.GIT_CONTAINERS.get(env.GIT_CONTAINERS.idFromName(`trusted-git-${(hash >>> 0) % size}`));
}

export async function createNativeSession(env: GitBindings, spec: NativeSessionSpec): Promise<{ ticket: NativeSessionTicket; helper: DurableObjectStub }> {
  const helper = nativeHelper(env, spec.repository.storage_name);
  const request = new Request('http://git-native.internal/internal/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec),
  });
  const response = await helper.fetch(await signInternalRequest(request, env.INTERNAL_SERVICE_KEY, GIT_NATIVE_SCOPE));
  const ticket = await nativeJson<NativeSessionTicket>(response);
  return { ticket, helper };
}

export async function admitGitControlOperation(env: GitBindings, storageName: string, count: number): Promise<void> {
  const request = new Request('http://git-native.internal/internal/control-operation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count }) });
  const response = await nativeHelper(env, storageName).fetch(await signInternalRequest(request, env.INTERNAL_SERVICE_KEY, GIT_NATIVE_SCOPE));
  const result = await nativeJson<{ admitted: boolean }>(response);
  requireValue(result.admitted === true, 'git_cost_admission_unavailable', 'Git control-plane operating cost was not admitted.', 503);
}

export async function nativeAction(session: { ticket: NativeSessionTicket; helper: DurableObjectStub }, action: string, options: {
  method?: string; body?: BodyInit | null; headers?: HeadersInit; query?: URLSearchParams;
} = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set('authorization', `GitKnot-Session ${session.ticket.token}`);
  const url = `http://git-native.internal/sessions/${session.ticket.id}/${action}${options.query?.size ? `?${options.query}` : ''}`;
  return session.helper.fetch(new Request(url, { method: options.method ?? 'GET', headers, body: options.body,
    ...(options.body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit));
}

export async function nativeJson<T>(response: Response): Promise<T> {
  const result = await boundedJson<T & { error?: { code: string; message: string } }>(response, 4 * 1024 * 1024);
  if (!response.ok) throw new GitError(result.error?.code ?? 'git_unavailable', result.error?.message ?? 'Native Git processing is temporarily unavailable.', response.status);
  return result;
}
