import { ApiError } from '../errors.ts';
import type { Bindings, DatabaseLocation } from '../types.ts';

function location(cell: unknown, shard: unknown): DatabaseLocation {
  const valid = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
  if (!valid(cell) || !valid(shard)) {
    throw new ApiError(503, 'database_location_unavailable', 'The configured database authority location is unavailable.');
  }
  return { cell_id: cell, shard_id: shard };
}

export function cellDatabaseLocation(env: Bindings, shardId = env.SHARD_ID): DatabaseLocation {
  return location(env.CELL_ID, shardId);
}

/** A configured IDENTITY_DB requires a configured physical descriptor, not JS equality. */
export function identityDatabaseLocation(env: Bindings): DatabaseLocation {
  if (env.IDENTITY_DB !== undefined || env.IDENTITY_CELL_ID !== undefined || env.IDENTITY_SHARD_ID !== undefined) {
    return location(env.IDENTITY_CELL_ID, env.IDENTITY_SHARD_ID);
  }
  if (env.ROOT_DB !== undefined) return location(env.ROOT_CELL_ID ?? env.CELL_ID, env.ROOT_SHARD_ID);
  return cellDatabaseLocation(env);
}

export function sameDatabaseLocation(left: DatabaseLocation, right: DatabaseLocation): boolean {
  return left.cell_id === right.cell_id && left.shard_id === right.shard_id;
}
