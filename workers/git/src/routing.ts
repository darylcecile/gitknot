import { signInternalRequest, verifyInternalRequest } from '@gitknot/core';
import type { AppContext, RepositoryPlacement } from '@gitknot/core';
import { hasRoutingEnvelope, signRoutingEnvelope, verifyRoutingEnvelope } from '@gitknot/core/routing/envelope';
import { boundedJson } from '../../../packages/git/src/protocol.ts';
import { GIT_NATIVE_SCOPE, GIT_SERVICE_SCOPE } from '../../../packages/git/src/types.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';
import { barrierPlacement } from './barrier-routing.ts';
import { gitCell, gitPlacement, gitShardEnvironment, sameGitPlacement, selectGitPlacement } from './placement.ts';
import { gitName, localGitNames, resolveGitName } from './namespace.ts';
import type { GitName } from './namespace.ts';
import type { GitBindings } from './types.ts';
import { movePublisherPlacement } from './move-publication.ts';
import type { GitMovePublisherRequest } from '../../../packages/git/src/types.ts';

export interface GitTransport { repo_id: string; suffix: string; url: URL; candidate_id?: string }
const relay = /^\/v1\/repos\/([\w-]+)\/git-transport$/u;
const transportHeaders = ['git-protocol', 'content-encoding', 'content-length'] as const;

function hops(request: Request): number {
  const value = request.headers.get('x-gitknot-routing-hops');
  const count = value === null ? 0 : Number(value);
  requireValue(Number.isSafeInteger(count) && count >= 0 && count < 2, 'git_routing_loop', 'Git repository routing changed. Retry the request.', 409);
  return count;
}

function transportUrl(request: Request): { url: URL; repo_id?: string } {
  const url = new URL(request.url);
  const match = relay.exec(url.pathname);
  if (!match) {
    requireValue(!hasRoutingEnvelope(request), 'invalid_routing_envelope', 'This Git endpoint requires a verified routing handoff.', 401);
    return { url };
  }
  requireValue(hasRoutingEnvelope(request), 'invalid_routing_envelope', 'This Git endpoint requires a verified routing handoff.', 401);
  const target = url.searchParams.get('target');
  requireValue(target && target.length <= 8192 && target.startsWith('/') && !target.startsWith('//'), 'invalid_git_route', 'Invalid Git routing target.', 400);
  for (const name of transportHeaders) requireValue(url.searchParams.get(name) === (request.headers.get(name) ?? ''),
    'invalid_routing_envelope', 'Git transport headers changed during routing.', 401);
  const original = new URL(target, url.origin);
  requireValue(original.origin === url.origin && !original.hash && !relay.test(original.pathname), 'invalid_git_route', 'Invalid Git routing target.', 400);
  return { url: original, repo_id: match[1] };
}

async function transport(env: GitBindings, url: URL): Promise<GitTransport> {
  const candidate = /^\/repositories\/([\w-]+)\/candidates\/([\w-]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack|info\/lfs\/.+)$/u.exec(url.pathname);
  if (candidate) return { repo_id: candidate[1], candidate_id: candidate[2], suffix: candidate[3], url };
  const match = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack|info\/lfs\/.+)$/u.exec(url.pathname);
  requireValue(match, 'not_found', 'Git remote not found.', 404);
  let name: GitName;
  try { name = gitName(decodeURIComponent(match[1]), decodeURIComponent(match[2])); }
  catch { requireValue(false, 'not_found', 'Git remote not found.', 404); }
  return { repo_id: await resolveGitName(env, name), suffix: match[3], url };
}

export async function routePublicGit(c: AppContext): Promise<{ response: Response } | { transport: GitTransport }> {
  const env = c.env as GitBindings;
  const request = c.req.raw;
  const incoming = transportUrl(request);
  if (incoming.repo_id) await verifyRoutingEnvelope(request, env.INTERNAL_SERVICE_KEY, env.DB.withSession('first-primary'));
  hops(request);
  const target = await transport(env, incoming.url);
  requireValue(!incoming.repo_id || incoming.repo_id === target.repo_id, 'git_namespace_changed', 'The Git repository namespace changed. Retry the request.', 409);
  const placement = await gitPlacement(env, target.repo_id);
  requireValue(!incoming.repo_id || sameGitPlacement(request, placement), 'routing_epoch_changed', 'The Git repository moved after this request was routed.', 409);
  requireValue(placement.state !== 'deleted', 'not_found', 'Git remote not found.', 404);
  const writing = target.suffix === 'git-receive-pack' || target.url.searchParams.get('service') === 'git-receive-pack'
    || target.suffix.startsWith('info/lfs/') && !['GET', 'HEAD'].includes(request.method);
  requireValue(!writing || placement.state === 'active', 'repository_moving', 'Git writes are fenced while this repository moves.', 423);
  if (placement.cell_id !== env.CELL_ID) {
    const url = new URL(request.url);
    url.pathname = `/v1/repos/${target.repo_id}/git-transport`;
    url.search = new URLSearchParams({ target: target.url.pathname + target.url.search,
      ...Object.fromEntries(transportHeaders.map(name => [name, request.headers.get(name) ?? ''])) }).toString();
    const forwarded = new Request(url, request);
    return { response: await gitCell(env, placement.cell_id).fetch(await signRoutingEnvelope(forwarded, env.INTERNAL_SERVICE_KEY, placement, hops(request) + 1)) };
  }
  await selectGitPlacement(c, placement, false);
  return { transport: target };
}

/** Private JSON remains content-bound; restore/LFS streams retain their independently verified digest. */
export async function routePrivateGit(c: AppContext): Promise<Response | null> {
  const env = c.env as GitBindings;
  const request = c.req.raw;
  const url = new URL(request.url);
  const native = /^\/internal\/git\/native\/([\w-]+)\/([\w-]+)\/(validated|permit|result|rejected)$/u.exec(url.pathname);
  const lfs = /^\/internal\/git\/lfs-import\/([\w-]+)\/([\w-]+)\/([\w-]+)\/(batch|uploads\/[\w-]+)$/u.exec(url.pathname);
  const repository = /^\/internal\/git\/repositories\/([\w-]+)\/(.+)$/u.exec(url.pathname);
  const scope = native || lfs ? GIT_NATIVE_SCOPE : GIT_SERVICE_SCOPE;
  const streaming = repository?.[2] === 'restore' || !!lfs?.[4].startsWith('uploads/');
  await verifyInternalRequest(request, env.INTERNAL_SERVICE_KEY, scope, { database: env.DB.withSession('first-primary'), streaming });
  if (url.pathname === '/internal/git/namespace') {
    requireValue(request.method === 'POST', 'invalid_method', 'Namespace resolution requires POST.', 405);
    return Response.json({ matches: await localGitNames(env, await boundedJson<GitName>(request, 2048)) });
  }
  const repoId = (native ?? lfs ?? repository)?.[1];
  requireValue(repoId, 'not_found', 'Git service endpoint not found.', 404);
  let barrier: Record<string, unknown> | undefined;
  if (repository?.[2] === 'barrier') {
    barrier = await boundedJson<Record<string, unknown>>(request.clone(), 4096);
    barrier.issued_at ??= Number(request.headers.get('x-gitknot-internal-time')) * 1000;
  }
  const stagedId = repository?.[2] === 'restore' ? url.searchParams.get('operation_id') ?? undefined
    : native?.[2] ?? /^operations\/([\w-]+)$/u.exec(repository?.[2] ?? '')?.[1];
  const movePublisher = repository?.[2] === 'move-publication' ? await boundedJson<GitMovePublisherRequest>(request.clone(), 4096) : undefined;
  const placement = barrier ? await barrierPlacement(env, repoId, barrier) : movePublisher ? await movePublisherPlacement(env, repoId, movePublisher)
    : await gitPlacement(env, repoId, stagedId);
  const incoming = request.headers.has('x-gitknot-routing-resource');
  requireValue(!incoming || sameGitPlacement(request, placement), 'routing_epoch_changed', 'The Git repository route changed during this private request.', 409);
  if (placement.cell_id !== env.CELL_ID) return forwardPrivateGit(request, env, placement, scope, barrier);
  if (movePublisher || repository?.[2].startsWith('operations/') || repository?.[2] === 'reconcile') c.env = gitShardEnvironment(env, placement.shard_id);
  else if (!barrier) await selectGitPlacement(c, placement, true);
  return null;
}

async function forwardPrivateGit(request: Request, env: GitBindings, placement: RepositoryPlacement, scope: string, body?: Record<string, unknown>): Promise<Response> {
  const headers = new Headers(request.headers);
  const count = hops(request) + 1;
  for (const name of [...headers.keys()]) if (name.startsWith('x-gitknot-routing-')) headers.delete(name);
  for (const [key, value] of Object.entries({ resource: placement.repo_id, cell: placement.cell_id, shard: placement.shard_id, epoch: placement.epoch, hops: count })) {
    headers.set(`x-gitknot-routing-${key}`, String(value));
  }
  if (body) headers.delete('x-gitknot-content-sha256');
  const forwarded = new Request(request, { headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return gitCell(env, placement.cell_id).fetch(await signInternalRequest(forwarded, env.INTERNAL_SERVICE_KEY, scope));
}
