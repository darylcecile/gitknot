import { ApiError, cellDatabase, identityAuthorityBindings, identityDatabaseLocation, requestDatabaseBinding, requestDatabaseLocation } from '@gitknot/core';
import type { AppContext, Bindings } from '@gitknot/core';
import { routingBindings } from '../../core/src/routing/cells.ts';
import type { OperationsBindings } from './types.ts';

export function shardEnvironment<Env extends Bindings>(env: Env, shardId: string): Env {
  const identity = identityAuthorityBindings(env);
  const database = identity.IDENTITY_CELL_ID === env.CELL_ID && identity.IDENTITY_SHARD_ID === shardId
    ? identity.IDENTITY_DB : cellDatabase(env, shardId);
  return { ...env, ...identity, ROOT_DB: env.ROOT_DB ?? env.DB, ROOT_CELL_ID: env.ROOT_CELL_ID ?? env.CELL_ID,
    ROOT_SHARD_ID: env.ROOT_SHARD_ID ?? env.SHARD_ID, DB: database, SHARD_ID: shardId };
}

export function financialEnvironment<Env extends Bindings>(env: Env): Env {
  const identity = identityAuthorityBindings(env);
  return { ...env, ...identity, ROOT_DB: env.ROOT_DB ?? env.DB, ROOT_CELL_ID: env.ROOT_CELL_ID ?? env.CELL_ID,
    ROOT_SHARD_ID: env.ROOT_SHARD_ID ?? env.SHARD_ID, DB: identity.IDENTITY_DB,
    CELL_ID: identity.IDENTITY_CELL_ID, SHARD_ID: identity.IDENTITY_SHARD_ID };
}

export function requestOperationsEnvironment(c: AppContext): Bindings {
  const identity = identityAuthorityBindings(c.env);
  const location = requestDatabaseLocation(c);
  return { ...c.env, ...identity, ROOT_DB: c.env.ROOT_DB ?? c.env.DB, ROOT_CELL_ID: c.env.ROOT_CELL_ID ?? c.env.CELL_ID,
    ROOT_SHARD_ID: c.env.ROOT_SHARD_ID ?? c.env.SHARD_ID, DB: requestDatabaseBinding(c),
    CELL_ID: location.cell_id, SHARD_ID: location.shard_id };
}

export function cellShards(env: OperationsBindings): OperationsBindings[] {
  const bindings = routingBindings(env.SHARD_BINDINGS_JSON);
  const identity = identityDatabaseLocation(env);
  const ids = [...new Set([env.SHARD_ID, ...Object.keys(bindings),
    ...(identity.cell_id === env.CELL_ID ? [identity.shard_id] : []),
    ...(typeof env.ROOT_SHARD_ID === 'string' && (env.ROOT_CELL_ID ?? env.CELL_ID) === env.CELL_ID ? [env.ROOT_SHARD_ID] : [])])];
  if (ids.length > 64) throw new ApiError(503, 'shard_limit', 'The configured local metadata shard limit was exceeded.');
  return ids.map((id) => shardEnvironment(env, id));
}

export function backgroundCell(env: OperationsBindings, cellId: string): Fetcher {
  if (cellId === env.CELL_ID && env.BACKGROUND) return env.BACKGROUND;
  const bindings = routingBindings(env.CELL_BACKGROUND_BINDINGS_JSON, 32);
  const name = bindings[cellId];
  const binding = name ? env[name] : null;
  if (!binding || typeof binding !== 'object' || !('fetch' in binding)) throw new Error('background_cell_unavailable');
  return binding as Fetcher;
}
