import { ApiError } from '../errors.ts';
import { signInternalRequest } from '../internal.ts';
import { readBounded } from '../limits.ts';
import { cellDatabaseLocation, sameDatabaseLocation } from './locations.ts';
import type { RepositoryPlacement } from './repositories.ts';
import type { AppContext, Bindings, DatabaseLocation, RequestDatabaseAuthority } from '../types.ts';

const selectedDatabases = new WeakMap<AppContext, { binding: D1Database; authority: RequestDatabaseAuthority }>();
const placementId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const maximumPlacements = 256;

export function validPlacementId(value: string): boolean { return placementId.test(value); }

/** Only bounded, operator-selected bindings are addressable. */
export function routingBindings(value: unknown, maximum = 64): Record<string, string> {
  if (value === undefined) return {};
  let parsed: unknown;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : null; }
  catch { throw new ApiError(503, 'routing_unavailable', 'Repository routing is temporarily unavailable.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).length > maximum
    || Object.entries(parsed).some(([id, name]) => !validPlacementId(id) || typeof name !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(name))) {
    throw new ApiError(503, 'routing_unavailable', 'Repository routing is temporarily unavailable.');
  }
  return parsed as Record<string, string>;
}

export function cellDatabase(env: Bindings, shardId: string): D1Database {
  if (!validPlacementId(shardId)) throw new ApiError(503, 'shard_unavailable', 'The repository metadata is temporarily unavailable.');
  if (shardId === env.SHARD_ID) return env.DB;
  if (shardId === env.ROOT_SHARD_ID && isDatabase(env.ROOT_DB)) return env.ROOT_DB;
  const name = routingBindings(env.SHARD_BINDINGS_JSON)[shardId];
  const binding = name === 'DB' ? env.ROOT_DB ?? env.DB : name ? env[name] : undefined;
  if (!isDatabase(binding)) throw new ApiError(503, 'shard_unavailable', 'The repository metadata is temporarily unavailable.');
  return binding;
}

export function isDatabase(value: unknown): value is D1Database {
  return !!value && typeof value === 'object' && 'withSession' in value && typeof value.withSession === 'function';
}

export function cellService(env: Bindings, cellId: string): Fetcher {
  const name = routingBindings(env.CELL_BINDINGS_JSON, 32)[cellId];
  const service = name ? env[name] as Fetcher | undefined : undefined;
  if (!service?.fetch) throw new ApiError(503, 'cell_unavailable', 'The repository cell is temporarily unavailable.');
  return service;
}

export function requestDatabaseBinding(c: AppContext): D1Database {
  return selectedDatabases.get(c)?.binding ?? c.env.DB;
}

export function requestDatabaseAuthority(c: AppContext): RequestDatabaseAuthority {
  const selected = selectedDatabases.get(c)?.authority;
  return selected ? structuredClone(selected) : { kind: 'cell', location: cellDatabaseLocation(c.env) };
}

export function requestDatabaseLocation(c: AppContext): DatabaseLocation {
  return requestDatabaseAuthority(c).location;
}

/** Permission scopes do not determine storage ownership. */
export function selectedRepositoryScope(c: AppContext): string | null {
  const selected = requestDatabaseAuthority(c);
  return selected.kind === 'repository' ? selected.repo_id : null;
}

/** Selection must precede identity capture, admission and idempotency ownership. */
export function setRequestDatabase(c: AppContext, binding: D1Database, authority: RequestDatabaseAuthority): void {
  if (!authority || !authority.location || !['identity', 'repository', 'cell'].includes(authority.kind)
    || !validPlacementId(authority.location.cell_id) || !validPlacementId(authority.location.shard_id)
    || authority.kind === 'repository' && !/^r_[A-Za-z0-9_-]+$/.test(authority.repo_id)) {
    throw new ApiError(503, 'database_authority_unavailable', 'The request database authority was not explicitly selected.');
  }
  const previous = requestDatabaseAuthority(c);
  const sameLocation = sameDatabaseLocation(previous.location, authority.location);
  const sameOwner = previous.kind === authority.kind && (previous.kind !== 'repository'
    || authority.kind === 'repository' && previous.repo_id === authority.repo_id);
  if (sameLocation && sameOwner && c.get('database')) {
    selectedDatabases.set(c, { binding, authority: structuredClone(authority) });
    return;
  }
  if (c.get('mutation_authority') || c.get('idempotency')) {
    throw new ApiError(503, 'request_authority_already_captured', 'GitKnot could not safely route this request. Retry the request.');
  }
  selectedDatabases.set(c, { binding, authority: structuredClone(authority) });
  c.set('database', binding.withSession('first-primary'));
}

export function selectRepositoryDatabase(c: AppContext, placement: RepositoryPlacement): void {
  if (placement.cell_id !== c.env.CELL_ID) throw new ApiError(503, 'cell_unavailable', 'This cell cannot directly select another cell database.');
  setRequestDatabase(c, cellDatabase(c.env, placement.shard_id), { kind: 'repository', repo_id: placement.repo_id,
    location: { cell_id: placement.cell_id, shard_id: placement.shard_id } });
}

export async function routingRpc<T>(env: Bindings, cellId: string, input: unknown): Promise<T> {
  const request = new Request('https://internal.gitknot.com/internal/routing', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    signal: AbortSignal.timeout(20_000),
  });
  let response: Response;
  try { response = await cellService(env, cellId).fetch(await signInternalRequest(request, env.INTERNAL_SERVICE_KEY, 'cell.authority')); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'cell_authority_unavailable', 'GitKnot could not confirm the repository cell authority.');
  }
  let body: { error?: { code?: string }; result?: T };
  try { body = JSON.parse(new TextDecoder().decode(await readBounded(response.body, 64 * 1024))) as typeof body; }
  catch { throw new ApiError(503, 'cell_authority_unavailable', 'GitKnot could not verify the repository cell response.'); }
  if (!response.ok) {
    if (response.status === 409) throw new ApiError(409, 'routing_epoch_changed', 'The repository authority changed. Retry using the same resource ID.');
    throw new ApiError(503, 'cell_authority_unavailable', 'GitKnot could not confirm the repository cell authority.');
  }
  if (!Object.hasOwn(body, 'result')) throw new ApiError(503, 'cell_authority_unavailable', 'The repository cell returned no authority receipt.');
  return body.result as T;
}
