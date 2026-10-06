import { z } from 'zod';
import { identityBinding, selectIdentityDatabase } from './authority/identity.ts';
import { installAccountAuthorityFence } from './authority/epochs.ts';
import { ApiError } from './errors.ts';
import { one, stmt } from './db.ts';
import { verifyInternalRequest } from './internal.ts';
import { readBounded } from './limits.ts';
import { bodyBytes, isJsonMediaType } from './http.ts';
import { globalResourcePath, resolveResourceLocator } from './locators.ts';
import type { GlobalResourceType } from './locators.ts';
import { cellDatabase, cellService, selectRepositoryDatabase } from './routing/cells.ts';
import { hasRoutingEnvelope, signRoutingEnvelope, verifyRoutingEnvelope } from './routing/envelope.ts';
import { repositoryCleanupRequest } from './routing/lifecycle.ts';
import { assertRepositoryPlacement, resolveRepositoryPlacement } from './routing/repositories.ts';
import type { RepositoryPlacement } from './routing/repositories.ts';
import type { AppContext, Bindings, Database, Repository } from './types.ts';

export { identityAuthorityBindings, identityBinding, identityDatabase, selectIdentityDatabase, separateIdentityAuthority } from './authority/identity.ts';
export { captureAccountAuthority, currentAccountAuthority, fenceAccountAuthority, installAccountAuthorityFence,
  ownedAccountAuthority, recoverAccountAuthorityBarriers, registerAccountAuthorityPlacement,
  registerRepositoryPlacement, releaseAccountAuthority, withAccountAuthorityBarrier } from './authority/epochs.ts';
export { readRepositoryAuthority, resolveRepositoryPlacement } from './routing/repositories.ts';
export type { RepositoryPlacement } from './routing/repositories.ts';
export type { RepositoryAuthorityPlacement } from './authority/epochs.ts';
export * from './locators.ts';
export { cellDatabase, requestDatabaseAuthority, requestDatabaseBinding, requestDatabaseLocation, selectedRepositoryScope,
  selectRepositoryDatabase, setRequestDatabase } from './routing/cells.ts';
export { cellDatabaseLocation, identityDatabaseLocation, sameDatabaseLocation } from './routing/locations.ts';
export { resolveRoute } from './routing/repositories.ts';
export type { ResourceRoute } from './routing/repositories.ts';
export { repositoryCleanupRequest } from './routing/lifecycle.ts';
export { currentRepositoryMetadataFence, inRepositoryMetadataFence, repositoryMetadataFenceGuard } from './routing/metadata-fences.ts';
export type { RepositoryMetadataFence } from './routing/metadata-fences.ts';

function lifecycleRequest(c: AppContext, resourceId: string): boolean {
  if (repositoryCleanupRequest(c.req.raw)) return true;
  const method = c.req.method;
  const suffix = c.req.path.slice(`/v1/repos/${resourceId}`.length);
  if (c.req.path.startsWith(`/v1/repos/${resourceId}`)) {
    if (method === 'POST' && suffix === '/restore' || method === 'DELETE' && suffix === '') return true;
    if (['POST', 'DELETE'].includes(method) && suffix === '/archive') return true;
    if (/^\/transfers(?:\/[^/]+(?:\/accept)?)?$/.test(suffix) && ['GET', 'POST', 'DELETE'].includes(method)) return true;
    if (method === 'GET' && suffix === '/operations') return true;
  }
  return /^\/v1\/operations\/[^/]+(?:\/(?:retry|cancel))?$/.test(c.req.path)
    && (method === 'GET' || method === 'POST' && /\/(?:retry|cancel)$/.test(c.req.path));
}

function sameIncomingPlacement(c: AppContext, placement: RepositoryPlacement): boolean {
  return c.req.header('x-gitknot-routing-resource') === placement.repo_id
    && c.req.header('x-gitknot-routing-cell') === placement.cell_id
    && c.req.header('x-gitknot-routing-shard') === placement.shard_id
    && c.req.header('x-gitknot-routing-epoch') === String(placement.epoch);
}

async function incomingRoute(c: AppContext): Promise<boolean> {
  const incoming = hasRoutingEnvelope(c.req.raw);
  if (incoming) await verifyRoutingEnvelope(c.req.raw, c.env.INTERNAL_SERVICE_KEY, c.env.DB);
  return incoming;
}

async function forwardRepository(c: AppContext, placement: RepositoryPlacement, incoming: boolean): Promise<Response> {
  const hops = incoming ? Number(c.req.header('x-gitknot-routing-hops')) : 0;
  if (!Number.isSafeInteger(hops) || hops < 0 || hops >= 2) throw new ApiError(503, 'routing_unavailable', 'Repository routing is temporarily unavailable.');
  // Actor identity is always reauthenticated by the destination from the real
  // credential. No public actor or policy snapshot header is promoted to trust.
  const forwarded = await signRoutingEnvelope(c.req.raw, c.env.INTERNAL_SERVICE_KEY, placement, hops + 1);
  return cellService(c.env, placement.cell_id).fetch(forwarded);
}

export async function routeRepositoryRequest(c: AppContext, resourceId: string): Promise<Response | null> {
  const incoming = await incomingRoute(c);
  const placement = await resolveRepositoryPlacement(c.env, resourceId);
  if (!placement) {
    if (incoming) throw new ApiError(409, 'routing_epoch_changed', 'The repository route is no longer current.');
    return null;
  }
  if (incoming && !sameIncomingPlacement(c, placement)) {
    throw new ApiError(409, 'routing_epoch_changed', 'The repository moved after this request was routed. Retry using the same resource ID.');
  }
  const lifecycle = lifecycleRequest(c, resourceId);
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) || c.req.path.startsWith('/internal/hosted/attempts/');
  if (!lifecycle && placement.state === 'deleted') throw new ApiError(404, 'not_found', 'The repository was not found.');
  if (!lifecycle && mutating && placement.state !== 'active') {
    throw new ApiError(423, 'repository_moving', 'Repository writes are temporarily fenced during a data move.', { operation_id: placement.operation_id });
  }
  if (placement.cell_id !== c.env.CELL_ID) return forwardRepository(c, placement, incoming);
  selectRepositoryDatabase(c, placement);
  const current = await one<Repository>(c.get('database'), 'SELECT * FROM repositories WHERE id=?', resourceId);
  assertRepositoryPlacement(current, placement);
  if (!current) throw new ApiError(404, 'not_found', 'The repository was not found.');
  if (!lifecycle && mutating && ['moving', 'deleted'].includes(current.state)) {
    throw new ApiError(current.state === 'deleted' ? 404 : 423, current.state === 'deleted' ? 'not_found' : 'repository_moving',
      'The repository is not available for this action.');
  }
  c.set('routing', { resource_id: resourceId, cell_id: placement.cell_id, shard_id: placement.shard_id,
    epoch: placement.epoch, expected_state: current.state, lifecycle });
  return null;
}

/** Must run before route admission, authority capture and idempotency lookup. */
export async function routeResourceRequest(c: AppContext): Promise<Response | null> {
  const repository = /^\/v1\/repos\/(r_[A-Za-z0-9_-]+)(?:\/|$)/.exec(c.req.path)?.[1];
  if (repository) return routeRepositoryRequest(c, repository);
  const global = globalResourcePath(c.req.path);
  if (global) {
    const locator = await resolveResourceLocator(c.env, global.id, global.type);
    if (!locator) throw new ApiError(404, 'not_found', 'The requested resource was not found.');
    if (locator.authority === 'repository' && locator.repo_id) return routeRepositoryRequest(c, locator.repo_id);
  }
  const collection = await collectionRepository(c);
  if (collection) return routeRepositoryRequest(c, collection);
  if (c.req.path === '/v1/deliveries') {
    const repoId = c.req.query('repo_id');
    if (repoId && /^r_[A-Za-z0-9_-]+$/.test(repoId)) return routeRepositoryRequest(c, repoId);
  }
  if (await incomingRoute(c)) throw new ApiError(409, 'routing_epoch_changed', 'The request no longer belongs to this repository placement.');
  selectIdentityDatabase(c);
  return null;
}

async function locatorRepository(c: AppContext, id: string, type: GlobalResourceType): Promise<string | null> {
  const locator = await resolveResourceLocator(c.env, id, type);
  if (!locator) throw new ApiError(404, 'not_found', 'The requested resource was not found.');
  return locator.authority === 'repository' ? locator.repo_id : null;
}

/** Only bounded collection routing hints are read before destination admission. */
async function collectionRepository(c: AppContext): Promise<string | null> {
  if (c.req.method === 'GET' && c.req.path === '/v1/runner-enrollments') {
    const id = c.req.query('pool_id');
    return id ? locatorRepository(c, id, 'runner_pool') : null;
  }
  if (c.req.method !== 'POST' || !['/v1/runner-enrollments', '/v1/runners/register'].includes(c.req.path)) return null;
  if (!isJsonMediaType(c.req.header('content-type'))) return null;
  let input: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bodyBytes(c)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    input = value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_json', 'The request body must be valid UTF-8 JSON.');
  }
  if (c.req.path === '/v1/runner-enrollments') return typeof input.pool_id === 'string' ? locatorRepository(c, input.pool_id, 'runner_pool') : null;
  const enrollment = typeof input.enrollment_token === 'string' ? /^gkenr_(enr_[a-f0-9]{32})_[A-Za-z0-9_-]{43}$/.exec(input.enrollment_token)?.[1] : undefined;
  // A token ID is only a routing hint. The destination still checks its complete
  // token hash, one-use consumption, pool state and registration identity.
  return enrollment ? locatorRepository(c, enrollment, 'runner_enrollment') : null;
}

/** Exact-state lifecycle guards allow restore without weakening normal writes. */
export function routingGuardStatement(db: Database, resourceId: string, epoch: number, id: string,
  expectedState?: Repository['state']): D1PreparedStatement {
  const state = expectedState === undefined ? "state NOT IN ('moving','deleted')" : 'state=?';
  return stmt(db, `INSERT INTO mutation_guards (id,ok) VALUES (?, CASE WHEN EXISTS (
    SELECT 1 FROM repositories WHERE id=? AND routing_epoch=? AND ${state}
  ) THEN 1 ELSE 0 END)`, id, resourceId, epoch, ...(expectedState === undefined ? [] : [expectedState]));
}

/** Call inside a publication transaction immediately before a canonical mutation. */
export async function assertRoutingEpoch(db: Database, resourceId: string, epoch: number): Promise<void> {
  const current = await one<{ routing_epoch: number; state: string }>(db, 'SELECT routing_epoch,state FROM repositories WHERE id=?', resourceId);
  if (!current || current.routing_epoch !== epoch || current.state !== 'active') {
    throw new ApiError(409, 'stale_routing_epoch', 'This mutation belongs to an outdated repository placement.');
  }
}

const locationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const resourceId = z.string().regex(/^[a-z][a-z0-9]*_[A-Za-z0-9_-]{1,120}$/);
const fenceSchema = z.object({ account_id: resourceId, epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  policy_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), phase: z.enum(['active', 'fenced']),
  barrier_id: resourceId.nullable() }).strict().refine(value => (value.phase === 'active') === (value.barrier_id === null));
const rpcSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('repository.read'), repo_id: resourceId, cell_id: locationId, shard_id: locationId,
    epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ action: z.literal('authority.install'), cell_id: locationId, shard_id: locationId, fence: fenceSchema }).strict(),
]);

/** Fixed private protocol: no arbitrary SQL, no caller-provided actor authority. */
export async function handleRoutingRpc(request: Request, env: Bindings): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/internal/routing') return null;
  if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'This private method is not supported.');
  await verifyInternalRequest(request, env.INTERNAL_SERVICE_KEY, 'cell.authority', { database: env.DB });
  let input: z.infer<typeof rpcSchema>;
  try { input = rpcSchema.parse(JSON.parse(new TextDecoder().decode(await readBounded(request.body, 16 * 1024)))); }
  catch { throw new ApiError(400, 'invalid_routing_request', 'The private routing request is invalid.'); }
  if (input.cell_id !== env.CELL_ID) throw new ApiError(409, 'routing_epoch_changed', 'This request targets another repository cell.');
  if (input.action === 'authority.install') {
    const current = await one<{ epoch: number; policy_revision: number; phase: string; barrier_id: string | null }>(identityBinding(env).withSession('first-primary'),
      'SELECT epoch,policy_revision,phase,barrier_id FROM account_authority_epochs WHERE account_id=?', input.fence.account_id);
    const phases = input.fence.phase === 'active' ? ['active', 'releasing'] : ['fencing', 'fenced'];
    if (!current || current.epoch !== input.fence.epoch || current.policy_revision !== input.fence.policy_revision
      || !phases.includes(current.phase) || input.fence.phase === 'fenced' && current.barrier_id !== input.fence.barrier_id) {
      throw new ApiError(409, 'account_authority_changed', 'The account authority installation is no longer current.');
    }
    return Response.json({ result: await installAccountAuthorityFence(env, input.shard_id, input.fence) });
  }
  const placement = await resolveRepositoryPlacement(env, input.repo_id);
  if (!placement || placement.cell_id !== input.cell_id || placement.shard_id !== input.shard_id || placement.epoch !== input.epoch) {
    throw new ApiError(409, 'routing_epoch_changed', 'The repository placement is no longer current.');
  }
  const repository = await one<Repository>(cellDatabase(env, input.shard_id).withSession('first-primary'), 'SELECT * FROM repositories WHERE id=?', input.repo_id);
  assertRepositoryPlacement(repository, placement);
  return Response.json({ result: repository });
}
