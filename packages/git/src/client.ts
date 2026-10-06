import { signInternalRequest } from '@gitknot/core';
import type { Bindings, Principal } from '@gitknot/core';
import { GIT_SERVICE_SCOPE } from './types.ts';
import type { GitMutationRequest, PublicGitOperation } from './types.ts';
import { GitError, requireValue } from './errors.ts';
import { boundedJson } from './protocol.ts';

export async function gitServiceRequest(env: Pick<Bindings, 'GIT_SERVICE' | 'INTERNAL_SERVICE_KEY'>, path: string, payload?: unknown, method?: string): Promise<Response> {
  requireValue(path.startsWith('/internal/git/') && !path.includes('#'), 'invalid_service_path', 'Invalid Git service path.', 500);
  requireValue(env.GIT_SERVICE?.fetch, 'git_service_unavailable', 'Git processing is temporarily unavailable.', 503);
  const request = new Request(`https://internal.gitknot.com${path}`, {
    method: method ?? (payload === undefined ? 'GET' : 'POST'), headers: { 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return env.GIT_SERVICE.fetch(await signInternalRequest(request, env.INTERNAL_SERVICE_KEY, GIT_SERVICE_SCOPE));
}

export async function gitServiceJson<T>(env: Pick<Bindings, 'GIT_SERVICE' | 'INTERNAL_SERVICE_KEY'>, path: string, payload?: unknown, method?: string): Promise<T> {
  const response = await gitServiceRequest(env, path, payload, method);
  const body = await boundedJson<T & { error?: { code: string; message: string } }>(response, 4 * 1024 * 1024);
  if (!response.ok) throw new GitError(body.error?.code ?? 'git_service_unavailable', body.error?.message ?? 'Git processing is temporarily unavailable.', response.status);
  return body;
}

export async function runGitOperation(env: Pick<Bindings, 'GIT_SERVICE' | 'INTERNAL_SERVICE_KEY'>, repoId: string, request: GitMutationRequest): Promise<PublicGitOperation> {
  return gitServiceJson<PublicGitOperation>(env, `/internal/git/repositories/${encodeURIComponent(repoId)}/mutate`, request);
}

export async function provisionGitRepository(env: Pick<Bindings, 'GIT_SERVICE' | 'INTERNAL_SERVICE_KEY'>, repoId: string, actor: Principal, operationId: string): Promise<void> {
  await gitServiceJson(env, `/internal/git/repositories/${encodeURIComponent(repoId)}/provision`, { actor, operation_id: operationId });
}
