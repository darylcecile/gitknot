import { ApiError, cellDatabase, identityAuthorityBindings, identityBinding, identityDatabaseLocation, many, one, readBounded, registerResourceLocator, requestDatabaseAuthority, requestDatabaseLocation, resolveRepositoryPlacement, resolveResourceLocator, sameDatabaseLocation, selectIdentityDatabase, selectRepositoryDatabase, signInternalRequest, verifyInternalRequest } from '@gitknot/core';
import type { AppContext, Bindings, DatabaseLocation, GlobalResourceType, ResourceLocator } from '@gitknot/core';
import { cellService } from '@gitknot/core/routing/cells';
import { z } from 'zod';
import { runnerStatusSchema } from './runner-protocol.ts';

export type RunnerResourceType = 'runner_pool' | 'runner_enrollment' | 'runner';
export interface RunnerPlacement {
  locator: ResourceLocator;
  location: DatabaseLocation;
  epoch: number | null;
  env: Bindings;
  binding: D1Database | null;
}

export async function runnerResourcePlacement(env: Bindings, id: string, type: GlobalResourceType): Promise<RunnerPlacement> {
  const locator = await resolveResourceLocator(env, id, type);
  if (!locator) throw new ApiError(404, 'not_found', 'The runner resource was not found.');
  // Keep the executing cell's shard map intact, even when IDENTITY_DB is remote.
  const routed = { ...env, ...identityAuthorityBindings(env) };
  if (locator.authority === 'identity') return { locator, location: identityDatabaseLocation(env), epoch: null, binding: identityBinding(env), env: routed };
  if (!locator.repo_id) throw new ApiError(409, 'runner_locator_invalid', 'Repository storage requires a repository locator.');
  const placement = await resolveRepositoryPlacement(env, locator.repo_id);
  if (!placement) throw new ApiError(404, 'not_found', 'The runner metadata placement was not found.');
  const binding = placement.cell_id === env.CELL_ID ? cellDatabase(env, placement.shard_id) : null;
  return { locator, location: { cell_id: placement.cell_id, shard_id: placement.shard_id }, epoch: placement.epoch, binding, env: routed };
}

export function sameRunnerDatabase(env: Bindings, placement: RunnerPlacement): boolean {
  return sameDatabaseLocation(identityDatabaseLocation(env), placement.location);
}

export function sameRunnerPlacement(left: RunnerPlacement, right: RunnerPlacement): boolean {
  return left.locator.authority === right.locator.authority && left.locator.repo_id === right.locator.repo_id
    && left.epoch === right.epoch && sameDatabaseLocation(left.location, right.location);
}

export async function registerRunnerChildLocator(env: Bindings, placement: RunnerPlacement, id: string, type: RunnerResourceType): Promise<void> {
  await registerResourceLocator(env, { resource_id: id, resource_type: type, repo_id: placement.locator.repo_id, authority: placement.locator.authority });
}

export async function selectRunnerMetadata(c: AppContext, placement: RunnerPlacement): Promise<void> {
  if (!placement.binding) throw new ApiError(409, 'runner_cell_changed', 'Route this request to the current runner metadata cell.');
  if (placement.locator.authority === 'identity') selectIdentityDatabase(c);
  else {
    const current = await resolveRepositoryPlacement(c.env, placement.locator.repo_id!);
    if (!current || current.epoch !== placement.epoch || !sameDatabaseLocation(current, placement.location)) throw new ApiError(409, 'routing_epoch_changed', 'Runner metadata moved before this request.');
    selectRepositoryDatabase(c, current);
    c.set('routing', { resource_id: current.repo_id, cell_id: current.cell_id, shard_id: current.shard_id, epoch: current.epoch });
  }
}

export function assertRunnerRequestPlacement(c: AppContext, placement: RunnerPlacement): void {
  const authority = requestDatabaseAuthority(c);
  if (!sameDatabaseLocation(requestDatabaseLocation(c), placement.location) || authority.kind !== placement.locator.authority
    || authority.kind === 'repository' && authority.repo_id !== placement.locator.repo_id) throw new ApiError(503, 'runner_request_placement', 'Runner request admission must select the locator storage authority before authorization.');
}

/** Include in each placement-local write, in addition to its account fence. */
export function runnerPlacementPredicate(placement: RunnerPlacement, cleanup = false): { sql: string; values: unknown[] } {
  if (placement.locator.authority === 'identity') return { sql: '1', values: [] };
  return { sql: `EXISTS (SELECT 1 FROM repositories WHERE id=? AND cell_id=? AND shard_id=? AND routing_epoch=?${cleanup ? '' : " AND state='active'"})`,
    values: [placement.locator.repo_id, placement.location.cell_id, placement.location.shard_id, placement.epoch] };
}

const resourceId = z.string().regex(/^[a-z][a-z0-9]*_[A-Za-z0-9_-]{1,120}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const locationId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const location = z.object({ cell_id: locationId, shard_id: locationId, epoch: z.number().int().positive().nullable() }).strict();
const fence = z.object({ account_id: resourceId, epoch: z.number().int().positive(), policy_revision: z.number().int().positive(), phase: z.literal('fenced'), barrier_id: resourceId }).strict();
const target = z.object({ resource_id: resourceId, resource_type: z.enum(['runner_pool', 'runner_enrollment', 'runner', 'attempt']), location }).strict();
const exchangeId = z.string().regex(/^rce_[a-f0-9]{32}$/);
const enrollment = z.object({ id: resourceId, account_id: resourceId, repo_id: resourceId.nullable(), pool_id: resourceId,
  token_hash: hash, expires_at: z.string().max(32), created_by: resourceId, created_at: z.string().max(32) }).strict();
export type RunnerEnrollmentIntent = z.infer<typeof enrollment>;
const requestSchema = z.discriminatedUnion('action', [
  target.extend({ action: z.literal('read') }),
  target.extend({ action: z.literal('project'), exchange_id: exchangeId, fence }),
  target.extend({ action: z.literal('projection'), exchange_id: exchangeId }),
  target.extend({ action: z.literal('cleanup-proof'), generation: z.number().int().positive() }),
  target.extend({ action: z.literal('retire'), fence }),
  target.extend({ action: z.literal('retirement') }),
  target.extend({ action: z.literal('revoked-runners') }),
  target.extend({ action: z.literal('enrollment-create'), enrollment }),
  target.extend({ action: z.literal('heartbeat'), credential_hash: hash, credential_generation: z.number().int().positive(), status: runnerStatusSchema }),
]);
type Command<T> = T extends unknown ? Omit<T, 'resource_id' | 'resource_type' | 'location'> : never;
export type RunnerMetadataRequest = Command<z.infer<typeof requestSchema>>;

export async function runnerMetadataRequest<T>(env: Bindings, placement: RunnerPlacement, action: RunnerMetadataRequest): Promise<T> {
  const input = requestSchema.parse({ ...action, resource_id: placement.locator.resource_id, resource_type: placement.locator.resource_type,
    location: { ...placement.location, epoch: placement.epoch } });
  if (placement.binding) return performRunnerMetadata(placement, input) as Promise<T>;
  const request = new Request('https://internal.gitknot.com/internal/execution/runners/metadata', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(30_000) });
  let response: Response;
  try { response = await cellService(env, placement.location.cell_id).fetch(await signInternalRequest(request, env.INTERNAL_SERVICE_KEY, 'execution.runner-metadata')); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'runner_metadata_unavailable', 'The current runner metadata cell could not be reached. Retry the same operation.');
  }
  let body: { result?: T; error?: { code?: string } };
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(response.body, 1024 * 1024))) as typeof body; }
  catch { throw new ApiError(503, 'runner_metadata_unavailable', 'The runner metadata cell returned an invalid receipt.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(503, 'runner_metadata_unavailable', 'The runner metadata cell returned an invalid receipt.');
  if (!response.ok) throw new ApiError(response.status === 409 ? 409 : response.status === 401 ? 401 : 503,
    body.error?.code ?? 'runner_metadata_unavailable', 'The runner metadata operation could not be confirmed. Retry the same operation.');
  if (!Object.hasOwn(body, 'result')) throw new ApiError(503, 'runner_metadata_unavailable', 'The runner metadata cell returned no typed receipt.');
  return body.result as T;
}

function requireResource(input: z.infer<typeof requestSchema>, type: RunnerResourceType | 'attempt'): void {
  if (input.resource_type !== type) throw new ApiError(422, 'runner_metadata_action', 'This metadata action does not match its resource type.');
}

async function performRunnerMetadata(placement: RunnerPlacement, input: z.infer<typeof requestSchema>): Promise<unknown> {
  const current = await runnerResourcePlacement(placement.env, input.resource_id, input.resource_type);
  if (!placement.binding || !sameRunnerPlacement(current, placement) || !sameDatabaseLocation(input.location, placement.location) || input.location.epoch !== placement.epoch) throw new ApiError(409, 'routing_epoch_changed', 'The runner metadata placement changed.');
  const db = placement.binding.withSession('first-primary');
  const scope = runnerPlacementPredicate(placement, true);
  if (!(await one<{ ok: number }>(db, `SELECT (${scope.sql}) AS ok`, ...scope.values))?.ok) throw new ApiError(409, 'routing_epoch_changed', 'The current metadata row does not match the runner placement.');
  if (input.action === 'read') {
    const table = { runner_pool: 'runner_pools', runner_enrollment: 'runner_enrollments', runner: 'runners', attempt: 'execution_attempts' }[input.resource_type];
    return one(db, `SELECT * FROM ${table} WHERE id=?`, input.resource_id);
  }
  if (input.action === 'cleanup-proof') {
    requireResource(input, 'attempt');
    return one(db, `SELECT id,repo_id,account_id,executor,runner_id,generation,runner_slot_fence,runner_credential_generation,runner_credential_hash,
      cleanup_state,status,allocated_at,runtime_id,destruction_verified_at,receipt_hash FROM execution_attempts WHERE id=? AND repo_id=? AND generation=?`,
    input.resource_id, placement.locator.repo_id, input.generation);
  }
  if (input.action === 'enrollment-create') {
    requireResource(input, 'runner_pool');
    const { createEnrollmentProjection } = await import('./runner-service.ts');
    return createEnrollmentProjection(placement.env, placement, input.enrollment);
  }
  if (input.action === 'revoked-runners') {
    requireResource(input, 'runner_pool');
    return many(db, `SELECT r.* FROM runners r WHERE r.pool_id=? AND r.state='revoked'
      AND NOT EXISTS (SELECT 1 FROM runner_retirement_projections p WHERE p.runner_id=r.id) ORDER BY r.id LIMIT 50`, input.resource_id);
  }
  requireResource(input, 'runner');
  if (input.action === 'projection') return one(db, 'SELECT * FROM runner_exchange_projections WHERE exchange_id=? AND runner_id=?', input.exchange_id, input.resource_id);
  if (input.action === 'retirement') return one(db, 'SELECT * FROM runner_retirement_projections WHERE runner_id=?', input.resource_id);
  if (input.action === 'project') {
    const { projectRunnerExchange } = await import('./runner-projections.ts');
    return projectRunnerExchange(placement.env, placement, input.exchange_id, input.fence);
  }
  if (input.action === 'retire') {
    const { retireRunnerProjection } = await import('./runner-retirement.ts');
    return retireRunnerProjection(placement.env, placement, input.fence);
  }
  const { updateRunnerCapabilities } = await import('./runner-service.ts');
  const runner = await one<import('./types.ts').RunnerRecord>(db, 'SELECT * FROM runners WHERE id=? AND credential_hash=? AND credential_generation=?', input.resource_id, input.credential_hash, input.credential_generation);
  if (!runner) throw new ApiError(401, 'runner_revoked', 'The machine credential is no longer current.');
  await updateRunnerCapabilities(db, runner, input.status);
  return { updated: true };
}

/** Fixed authenticated RPC; authority and projection intent are reread by the recipient. */
export async function handleRunnerMetadataRequest(request: Request, env: Bindings): Promise<Response | null> {
  if (new URL(request.url).pathname !== '/internal/execution/runners/metadata') return null;
  if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Runner metadata RPC requires POST.');
  await verifyInternalRequest(request, env.INTERNAL_SERVICE_KEY, 'execution.runner-metadata', { database: identityBinding(env) });
  let input: z.infer<typeof requestSchema>;
  try { input = requestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(request.body, 64 * 1024)))); }
  catch { throw new ApiError(422, 'runner_metadata_request', 'Invalid typed runner metadata request.'); }
  const placement = await runnerResourcePlacement(env, input.resource_id, input.resource_type);
  if (!placement.binding || placement.location.cell_id !== env.CELL_ID) throw new ApiError(409, 'routing_epoch_changed', 'This resource belongs to another cell.');
  return Response.json({ result: await performRunnerMetadata(placement, input) });
}
