import { Hono } from 'hono';
import { authenticate, authorize, getRepository, newId, now, one, sha256, signInternalRequest, stmt } from '@gitknot/core';
import type { AppContext, AppEnv, Principal, Repository } from '@gitknot/core';
import type { CandidateContext, GitMutationRequest, GitOperation, GitPolicy, GitRepositoryContext, NativeSessionSpec, PublicationResult } from '../../../packages/git/src/types.ts';
import { GIT_COORDINATOR_SCOPE, GIT_NATIVE_SCOPE, GIT_SERVICE_SCOPE } from '../../../packages/git/src/types.ts';
import { boundedJson, digestJson, limitStream, safeGitProtocol } from '../../../packages/git/src/protocol.ts';
import { GitError, gitErrorResponse, requireValue } from '../../../packages/git/src/errors.ts';
import { readGitLimits } from '../../../packages/git/src/policy.ts';
import { handleLfs, copyLfsPage } from '../../../packages/git/src/lfs.ts';
import { currentActor, internalContext, loadPolicy, authorizePushDiscovery } from './policy.ts';
import { artifacts } from './storage.ts';
import { createNativeSession, nativeAction, nativeJson } from './native.ts';
import type { GitBindings } from './types.ts';
import { lifecycleOperation, lifecycleRepository, readPolicy, restoreLifecycleGit, retainedRefs, verifyLifecycleGit, purgeLifecycleGit, exportMaintenanceGit } from './lifecycle.ts';
import { lfsImportRoute } from './lfs-import.ts';
import { historicalReviewRefs, retainReviewInspection } from './reviews.ts';
import { queuedPublication } from './merge-authorization.ts';
import { routePrivateGit, routePublicGit } from './routing.ts';
import type { GitTransport } from './routing.ts';
import { repositoryReadRemote } from './source.ts';
import { sourceMoveAuthority } from './maintenance.ts';
import { gitStoragePlacement } from './storage-placement.ts';

const app = new Hono<AppEnv>();

app.all('*', async c => {
  c.set('requestId', crypto.randomUUID());
  c.set('database', c.env.DB.withSession('first-primary'));
  try {
    const url = new URL(c.req.url);
    let env = c.env as GitBindings;
    if (url.pathname === '/health') return Response.json({ service: 'gitknot-git', status: 'ok' });
    if (url.pathname === '/internal/git/storage-placement') return await gitStoragePlacement(c.req.raw, env);
    if (url.pathname.startsWith('/internal/')) {
      const forwarded = await routePrivateGit(c);
      if (forwarded) return forwarded;
      env = c.env as GitBindings;
      if (url.pathname.startsWith('/internal/git/lfs-import/')) return await lfsImportRoute(c, env);
      if (/^\/internal\/git\/repositories\/[^/]+\/restore$/u.test(url.pathname)) return await restoreLifecycleGit(c, env);
      if (url.pathname.startsWith('/internal/git/native/')) return await nativeCallback(c, env);
      return await internalRoute(c, env);
    }
    requireValue(url.protocol === 'https:' || ['test', 'development'].includes(env.ENVIRONMENT), 'https_required', 'Use the HTTPS GitKnot remote.', 400);
    if (env.GIT_RATE_LIMIT) {
      const ip = c.req.header('cf-connecting-ip') ?? 'local';
      const admitted = await env.GIT_RATE_LIMIT.limit({ key: await sha256(`git-ingress:${ip}`) });
      requireValue(admitted.success, 'git_rate_limit', 'Git request rate limit reached. Retry after one minute.', 429);
    } else requireValue(env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test', 'git_rate_limit_unavailable', 'Git ingress admission is not configured.', 503);
    const routed = await routePublicGit(c);
    if ('response' in routed) return routed.response;
    env = c.env as GitBindings;
    const actor = await authenticate(c.req.raw, env);
    requireValue(!c.req.header('authorization') || actor, 'authentication_required', 'The GitKnot credential is invalid or expired.', 401);
    c.set('principal', actor);
    return await publicGit(c, env, routed.transport);
  } catch (error) {
    if (c.req.path.startsWith('/internal/')) return gitErrorResponse(error, c.get('requestId'));
    const known = error instanceof GitError || error instanceof Error && 'status' in error;
    const originalStatus = known ? Number((error as GitError).status) : 503;
    const status = originalStatus === 404 && !c.get('principal') ? 401 : originalStatus;
    if (c.req.path.includes('/info/lfs/') || new URL(c.req.url).searchParams.get('target')?.includes('/info/lfs/')) return Response.json({ message: known ? (error as Error).message : 'Git LFS storage is temporarily unavailable.', request_id: c.get('requestId') }, {
      status, headers: { 'content-type': 'application/vnd.git-lfs+json', 'cache-control': 'no-store',
        ...(status === 401 ? { 'www-authenticate': 'Basic realm="GitKnot"', 'lfs-authenticate': 'Basic realm="GitKnot LFS"' } : {}) },
    });
    return new Response(`GitKnot: ${known ? (error as Error).message : 'Git storage is temporarily unavailable.'}\nRequest: ${c.get('requestId')}\n`, {
      status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-gitknot-request-id': c.get('requestId'),
        ...(status === 401 ? { 'www-authenticate': 'Basic realm="GitKnot"' } : {}), ...(status === 429 ? { 'retry-after': '60' } : {}),
      },
    });
  }
});

export default app;

async function publicGit(c: AppContext, env: GitBindings, transport: GitTransport): Promise<Response> {
  const repository = await getRepository(c, transport.repo_id);
  const { suffix } = transport;
  let candidateRef: string | undefined;
  if (transport.candidate_id) {
    const candidate = await authorizedCandidate(c, repository.id, transport.candidate_id);
    candidateRef = candidate.internal_ref;
  }
  if (suffix.startsWith('info/lfs/')) {
    requireValue(!candidateRef, 'lfs_candidate', 'Use the source repository LFS endpoint for a private candidate.', 404);
    return handleLfs(c, repository, suffix.slice('info/lfs/'.length), `${env.GIT_ORIGIN}${transport.url.pathname.slice(0, transport.url.pathname.indexOf('/info/lfs/'))}/info/lfs`);
  }
  const service = suffix === 'info/refs' ? transport.url.searchParams.get('service') : suffix;
  requireValue(service === 'git-upload-pack' || service === 'git-receive-pack', 'git_service', 'Only Git smart HTTPS services are supported.', 400);
  requireValue(!candidateRef || service === 'git-upload-pack', 'candidate_read_only', 'Merge-candidate remotes are read-only.', 403);
  if (service === 'git-receive-pack') await authorizePushDiscovery(c, repository.id);
  const discovery = suffix === 'info/refs';
  requireValue(c.req.method === (discovery ? 'GET' : 'POST'), 'method_not_allowed', 'Unsupported Git transport method.', 405);
  if (!discovery) requireValue((c.req.header('content-type') ?? '').split(';')[0] === `application/x-${service}-request`, 'git_content_type', 'Invalid Git smart HTTPS request type.', 415);
  if (service === 'git-receive-pack' && !discovery) {
    const probe = await receiveProbe(c);
    return probe ?? receivePush(c, env, repository);
  }
  const policy = readPolicy(env);
  const session = await createNativeSession(env, { repository: snapshot(repository), policy, mode: 'read',
    remote: await artifacts(env).access(repository.storage_name, 'read'), ...(candidateRef ? { candidate_read_ref: candidateRef } : {}) });
  const action = discovery ? service === 'git-upload-pack' ? 'upload-advertise' : 'receive-advertise' : 'upload';
  const response = await nativeAction(session, action, { method: discovery ? 'GET' : 'POST',
    body: discovery ? undefined : gitBody(c.req.raw, Math.min(policy.limits.max_pack_bytes, 4 * 1024 * 1024)),
    headers: { 'git-protocol': service === 'git-upload-pack' ? safeGitProtocol(c.req.header('git-protocol') ?? null) : '' },
  });
  return publicResponse(response, c.get('requestId'));
}

/** Stock Git probes authentication with exactly one flush packet before a chunked push. */
async function receiveProbe(c: AppContext): Promise<Response | null> {
  if (c.req.header('content-length') !== '4') return null;
  const bytes = new Uint8Array(await new Response(gitBody(c.req.raw, 4)).arrayBuffer());
  requireValue(bytes.length === 4 && bytes.every(value => value === 0x30), 'protocol_error', 'Invalid Git receive probe.', 400);
  return new Response(null, { headers: { 'content-type': 'application/x-git-receive-pack-result',
    'cache-control': 'private, no-store', 'x-gitknot-request-id': c.get('requestId') } });
}

async function receivePush(c: AppContext, env: GitBindings, repository: Repository): Promise<Response> {
  const actor = c.get('principal')!;
  const id = newId('gop');
  const publisher = newId('pub');
  const fence = randomCapability();
  const opened = await coordinatorJson<{ repository: GitRepositoryContext; policy: GitPolicy }>(env, repository.id, '/begin', {
    repo_id: repository.id, operation_id: id, actor, kind: 'push', publisher_id: publisher, fence,
  });
  try {
    const native = await createNativeSession(env, { repository: opened.repository, policy: opened.policy, mode: 'receive',
      remote: await artifacts(env).access(repository.storage_name, 'read'), operation_id: id, publisher_id: publisher, fence, actor_id: actor.id, kind: 'push',
      callback_url: `${env.GIT_ORIGIN}/internal/git/native/${repository.id}/${id}` });
    const response = await nativeAction(native, 'receive', { method: 'POST', body: gitBody(c.req.raw, opened.policy.limits.max_pack_bytes),
      headers: { 'content-type': 'application/x-git-receive-pack-request' } });
    return publicResponse(response, c.get('requestId'), id);
  } catch (error) {
    await coordinatorJson(env, repository.id, `/operations/${id}/rejected`, { publisher_id: publisher, fence }).catch(() => {});
    throw error;
  }
}

async function internalRoute(c: AppContext, env: GitBindings): Promise<Response> {
  const match = /^\/internal\/git\/repositories\/([\w-]+)\/(.+)$/u.exec(c.req.path);
  requireValue(match, 'not_found', 'Git service endpoint not found.', 404);
  const [, repoId, action] = match;
  if (action.startsWith('operations/') && c.req.method === 'GET') return coordinatorRequest(env, repoId, `/${action}`);
  const body = c.req.method === 'GET' ? {} : await boundedJson<Record<string, unknown>>(c.req.raw, 4 * 1024 * 1024);
  if (action === 'reconcile') return coordinatorRequest(env, repoId, '/reconcile', {});
  if (action === 'move-publication') return coordinatorRequest(env, repoId, '/move-publication', body);
  if (action === 'barrier') return coordinatorRequest(env, repoId, '/barrier', { ...body, issued_at: body.issued_at ?? Number(c.req.header('x-gitknot-internal-time')) * 1000 }, c.req.method);
  if (action === 'verify') return verifyLifecycleGit(c, env, repoId, body);
  if (action === 'purge') return purgeLifecycleGit(env, repoId, body);
  if (action === 'move-restore-authority') {
    requireValue(typeof body.operation_id === 'string' && typeof body.archive_id === 'string', 'maintenance_move_scope', 'The move and archive identities are required.', 400);
    return Response.json(await sourceMoveAuthority(env, repoId, body.operation_id, body.archive_id), { headers: { 'cache-control': 'no-store' } });
  }
  if (action === 'export' && !body.actor && body.operation_id) return exportMaintenanceGit(env, repoId, body);
  const actor = body.actor ? await currentActor(env, body.actor as Principal) : null;
  c.set('principal', actor);
  if (action === 'provision') {
    requireValue(actor, 'authentication_required', 'Provisioning requires a current actor.', 401);
    const operation = await lifecycleOperation(env, repoId, String(body.operation_id), ['provision', 'import', 'fork']);
    const repository = await one<Repository>(env.DB, 'SELECT * FROM repositories WHERE id=?', repoId);
    requireValue(repository && operation.actor_id === actor.id && ['provisioning', 'active'].includes(repository.state),
      'provisioning_scope', 'The repository is outside this provisioning operation.', 403);
    await authorize(c, 'repositories.create', { account_id: repository.owner_id });
    await artifacts(env).provision(repository.storage_name, repository.default_branch);
    return Response.json({ repo_id: repoId, ready: true });
  }
  const mutationKind = (body.mutation as { kind?: string } | undefined)?.kind;
  const copying = action === 'copy-lfs' && actor ? await one<{ operation_id: string }>(env.DB,
    `SELECT l.operation_id FROM repository_lifecycle l JOIN repositories r ON r.id=l.repo_id
     WHERE l.repo_id=? AND l.kind='fork' AND l.created_by=? AND l.state IN ('queued','running','waiting') AND r.state='provisioning'`, repoId, actor.id) : null;
  const repository = copying ? await lifecycleRepository(c, repoId, copying.operation_id, 'fork')
    : action === 'mutate' && (mutationKind === 'import' || mutationKind === 'fork')
    ? await lifecycleRepository(c, repoId, String(body.operation_id), mutationKind)
    : await getRepository(c, repoId, action === 'export' ? 'repositories.export' : 'contents.read');
  if (action === 'read-remote') return Response.json({ repo_id: repoId, routing_epoch: repository.routing_epoch,
    storage_name: repository.storage_name, remote: await artifacts(env).access(repository.storage_name, 'read') }, { headers: { 'cache-control': 'no-store' } });
  if (action === 'mutate') return internalMutation(c, env, repository, body as unknown as GitMutationRequest);
  if (action === 'copy-lfs') {
    requireValue(actor && typeof body.source_repo_id === 'string', 'invalid_lfs_copy', 'An authenticated LFS copy source is required.');
    requireValue(!copying || repository.fork_source_id === body.source_repo_id, 'fork_source', 'The LFS source is outside this provisioning operation.', 403);
    await getRepository(c, body.source_repo_id);
    if (!copying) await authorize(c, 'lfs.write', { repo_id: repoId, paths: [] });
    return Response.json(await copyLfsPage(env, actor, body.source_repo_id, repoId, typeof body.cursor === 'string' ? body.cursor : ''));
  }
  const policy = readPolicy(env);
  const inspection = action === 'collaboration/inspect' ? body.inspection as { kind: string; head_repo_id: string; base_oid: string; head_oid: string;
    pull_id?: string; from_patch_id?: string | null; to_patch_id?: string } : undefined;
  requireValue(body.retain === undefined || typeof body.retain === 'boolean', 'invalid_inspection', 'Review retention must be a boolean.');
  if (inspection?.kind === 'patch' && body.retain !== false) return retainReviewInspection(c, env, repository, inspection,
    request => internalMutation(c, env, repository, request), () => coordinatorJson(env, repoId, '/reconcile', {}));
  let candidateRef: string | undefined;
  if (typeof body.candidate_id === 'string') candidateRef = (await authorizedCandidate(c, repoId, body.candidate_id)).internal_ref;
  const retained = inspection?.kind === 'diff' ? await historicalReviewRefs(c, repository, inspection)
    : action === 'export' && body.include_retained_refs === true ? await retainedRefs(c, repoId) : undefined;
  let source;
  if (!retained && inspection && ['patch', 'diff'].includes(inspection.kind)) {
    const headRepo = await getRepository(c, inspection.head_repo_id);
    if (headRepo.id !== repoId) source = await repositoryReadRemote(c, headRepo);
  }
  const session = await createNativeSession(env, { repository: snapshot(repository), policy, mode: 'read',
    remote: await artifacts(env).access(repository.storage_name, 'read'), ...(candidateRef ? { candidate_read_ref: candidateRef } : {}),
    ...(retained ? { retained_refs: retained } : {}) });
  if (action === 'export') {
    await authorize(c, 'repositories.export', { repo_id: repoId });
    return nativeAction(session, 'bundle');
  }
  if (action === 'collaboration/inspect') {
    requireValue(inspection && typeof inspection.kind === 'string', 'invalid_inspection', 'A native inspection request is required.');
    return nativeAction(session, 'collaboration', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inspection, source, retained_refs: retained }) });
  }
  const browseMatch = /^browse\/(refs|commits|commit|tree|raw|diff|compare|archive)$/u.exec(action);
  requireValue(browseMatch, 'not_found', 'Git service endpoint not found.', 404);
  const params = new URLSearchParams();
  if (body.query && typeof body.query === 'object') for (const [key, value] of Object.entries(body.query)) if (typeof value === 'string') params.set(key, value);
  return nativeAction(session, browseMatch[1], { query: params });
}

async function internalMutation(c: AppContext, env: GitBindings, repository: Repository, body: GitMutationRequest): Promise<Response> {
  const actor = c.get('principal');
  requireValue(actor && body.mutation && /^[\w-]{8,128}$/u.test(body.operation_id), 'invalid_mutation', 'An authenticated, idempotent Git mutation is required.');
  const existing = await one<{ actor_id: string; request_digest: string }>(env.DB, 'SELECT actor_id,request_digest FROM git_publications WHERE repo_id=? AND id=?', repository.id, body.operation_id);
  if (existing) {
    requireValue(existing.actor_id === actor.id, 'operation_not_found', 'Git operation not found.', 404);
    requireValue(existing.request_digest === await digestJson(body.mutation), 'idempotency_conflict', 'This Git operation ID was used with a different mutation.', 409);
    return coordinatorRequest(env, repository.id, `/operations/${body.operation_id}`);
  }
  const mutation = structuredClone(body.mutation);
  if (mutation.kind === 'fork') {
    requireValue(repository.fork_source_id, 'fork_source', 'Fork source must be set by the repository catalog.');
    const source = await getRepository(c, repository.fork_source_id);
    requireValue(!['private', 'internal'].includes(source.visibility) || !['public', 'unlisted'].includes(repository.visibility), 'fork_visibility', 'This fork must retain its source access boundary.');
    mutation.source = await repositoryReadRemote(c, source);
  }
  const candidate = mutation.kind === 'candidate' || mutation.kind === 'merge' ? mutation.candidate : undefined;
  if (candidate) {
    requireValue(/^[\w-]{8,128}$/u.test(candidate.id), 'invalid_candidate', 'Invalid merge candidate identity.');
    const source = await getRepository(c, candidate.source_repo_id);
    if (mutation.kind === 'candidate') {
      const queued = await queuedPublication(c, repository, body.operation_id, mutation.kind, candidate);
      await authorize(c, queued ? 'pull_requests.merge' : 'pull_requests.write', {
        repo_id: repository.id, ref: candidate.target_ref, ...(queued ? { paths: queued.paths } : {}),
      });
      mutation.source = source.id === repository.id ? undefined : await repositoryReadRemote(c, source);
      await createCandidateRecord(env, repository, actor, body.operation_id, candidate);
    }
  }
  let sourceRepoId: string | undefined = candidate?.source_repo_id;
  if (mutation.kind === 'retain') {
    await authorize(c, 'pull_requests.write', { repo_id: repository.id });
    const source = await getRepository(c, mutation.review.source_repo_id);
    sourceRepoId = source.id;
    mutation.source = source.id === repository.id ? undefined : await repositoryReadRemote(c, source);
  }
  if (mutation.kind === 'restack') {
    const source = await getRepository(c, mutation.onto_repo_id);
    sourceRepoId = source.id;
    mutation.source = source.id === repository.id ? undefined : await repositoryReadRemote(c, source);
  }
  const publisher = newId('pub');
  const fence = randomCapability();
  const opened = await coordinatorJson<{ repository: GitRepositoryContext; policy: GitPolicy }>(env, repository.id, '/begin', {
    repo_id: repository.id, operation_id: body.operation_id, actor, kind: mutation.kind, publisher_id: publisher, fence,
    request_digest: await digestJson(body.mutation), candidate, source_repo_id: sourceRepoId,
    restack: mutation.kind === 'restack' ? { ref: mutation.ref, expected_oid: mutation.expected_oid, old_base_oid: mutation.old_base_oid,
      onto_oid: mutation.onto_oid, onto_repo_id: mutation.onto_repo_id, pull_request_id: mutation.pull_request_id } : undefined,
    review: mutation.kind === 'retain' ? mutation.review : undefined,
  });
  try {
    const session = await createNativeSession(env, { repository: opened.repository, policy: opened.policy,
      remote: await artifacts(env).access(repository.storage_name, 'read'), mode: 'mutate', operation_id: body.operation_id,
      publisher_id: publisher, fence, actor_id: actor.id, kind: mutation.kind, candidate, ...(mutation.kind === 'retain' ? { review: mutation.review } : {}),
      callback_url: `${env.GIT_ORIGIN}/internal/git/native/${repository.id}/${body.operation_id}` });
    const response = await nativeAction(session, 'mutate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mutation) });
    await nativeJson<PublicationResult>(response);
    return coordinatorRequest(env, repository.id, `/operations/${body.operation_id}`);
  } catch (error) {
    await coordinatorJson(env, repository.id, `/operations/${body.operation_id}/rejected`, { publisher_id: publisher, fence }).catch(() => {});
    throw error;
  }
}

async function nativeCallback(c: AppContext, env: GitBindings): Promise<Response> {
  const match = /^\/internal\/git\/native\/([\w-]+)\/([\w-]+)\/(validated|permit|result|rejected)$/u.exec(c.req.path);
  requireValue(match && c.req.method === 'POST', 'not_found', 'Native publication callback not found.', 404);
  return coordinatorRequest(env, match[1], `/operations/${match[2]}/${match[3]}`, await boundedJson(c.req.raw));
}

export async function coordinatorRequest(env: GitBindings, repoId: string, path: string, payload?: unknown, method?: string): Promise<Response> {
  const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(repoId));
  const request = new Request(`https://coordinator.gitknot.internal${path}?repo_id=${encodeURIComponent(repoId)}`, {
    method: method ?? (payload === undefined ? 'GET' : 'POST'), headers: { 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return stub.fetch(await signInternalRequest(request, env.INTERNAL_SERVICE_KEY, GIT_COORDINATOR_SCOPE));
}

async function coordinatorJson<T>(env: GitBindings, repoId: string, path: string, payload?: unknown): Promise<T> {
  return nativeJson<T>(await coordinatorRequest(env, repoId, path, payload));
}

function snapshot(repository: Repository): GitRepositoryContext {
  const { id, owner_id, storage_name, default_branch, policy_revision, routing_epoch } = repository;
  return { id, owner_id, storage_name, default_branch, policy_revision, routing_epoch };
}

function gitBody(request: Request, max: number): ReadableStream<Uint8Array> {
  requireValue(request.body, 'git_body_required', 'Git smart HTTPS requires a request body.', 400);
  const length = request.headers.get('content-length');
  requireValue(!length || /^\d+$/u.test(length) && Number(length) <= max, 'pack_limit', 'Git request exceeds its byte limit.', 413);
  const encoding = request.headers.get('content-encoding');
  requireValue(!encoding || encoding === 'identity' || encoding === 'gzip', 'git_encoding', 'Unsupported Git HTTP content encoding.', 415);
  let body = limitStream(request.body, max);
  if (encoding === 'gzip') body = limitStream(body.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>), max);
  return body;
}

async function publicResponse(response: Response, requestId: string, operationId?: string): Promise<Response> {
  if (!response.ok) await nativeJson(response);
  const headers = new Headers();
  for (const key of ['content-type', 'content-length', 'etag', 'content-disposition', 'x-content-type-options', 'content-security-policy']) {
    const value = response.headers.get(key);
    if (value) headers.set(key, value);
  }
  headers.set('cache-control', 'private, no-store');
  headers.set('x-gitknot-request-id', requestId);
  if (operationId) headers.set('x-gitknot-operation-id', operationId);
  return new Response(response.body, { status: response.status, headers });
}

function randomCapability(): string { return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''); }

async function authorizedCandidate(c: AppContext, repoId: string, id: string): Promise<{ internal_ref: string }> {
  const candidate = await one<{ internal_ref: string; source_repo_id: string }>(c.env.DB,
    'SELECT internal_ref,source_repo_id FROM git_candidates WHERE repo_id=? AND id=? AND candidate_oid IS NOT NULL', repoId, id);
  requireValue(candidate, 'candidate_not_found', 'Merge candidate not found.', 404);
  await getRepository(c, candidate.source_repo_id);
  return candidate;
}

async function createCandidateRecord(env: GitBindings, repository: Repository, actor: Principal, operationId: string, candidate: CandidateContext): Promise<void> {
  await stmt(env.DB, `INSERT INTO git_candidates(repo_id,id,source_repo_id,pull_request_id,source_oid,target_ref,target_oid,internal_ref,
    strategy,policy_revision,actor_id,state,operation_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'building',?,?,?) ON CONFLICT(repo_id,id) DO NOTHING`,
  repository.id, candidate.id, candidate.source_repo_id, candidate.pull_request_id ?? null, candidate.source_oid, candidate.target_ref,
  candidate.target_oid, `refs/gitknot/candidates/${candidate.id}`, candidate.strategy, repository.policy_revision, actor.id, operationId, now(), now()).run();
  const saved = await one<CandidateContext & { operation_id: string; actor_id: string; policy_revision: number }>(env.DB,
    'SELECT * FROM git_candidates WHERE repo_id=? AND id=?', repository.id, candidate.id);
  requireValue(saved && saved.operation_id === operationId && saved.actor_id === actor.id && saved.policy_revision === repository.policy_revision
    && saved.source_repo_id === candidate.source_repo_id && saved.source_oid === candidate.source_oid && saved.target_ref === candidate.target_ref
    && saved.target_oid === candidate.target_oid && saved.strategy === candidate.strategy && (saved.pull_request_id ?? null) === (candidate.pull_request_id ?? null),
  'candidate_intent_conflict', 'This candidate identity already belongs to another exact publication intent.', 409);
}
