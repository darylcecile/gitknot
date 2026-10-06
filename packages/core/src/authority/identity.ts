import { database } from '../db.ts';
import { ApiError } from '../errors.ts';
import { isDatabase, requestDatabaseLocation, routingBindings, setRequestDatabase } from '../routing/cells.ts';
import { identityDatabaseLocation, sameDatabaseLocation } from '../routing/locations.ts';
import type { AppContext, Bindings } from '../types.ts';

const sessions = new WeakMap<AppContext, D1DatabaseSession>();

/** Repository movement never changes the account/credential authority. */
export function identityBinding(env: Bindings): D1Database {
  if (env.IDENTITY_DB !== undefined) {
    if (!isDatabase(env.IDENTITY_DB)) throw new ApiError(503, 'identity_authority_unavailable', 'The current identity authority is unavailable.');
    identityDatabaseLocation(env);
    return env.IDENTITY_DB;
  }
  if (typeof env.IDENTITY_CELL_ID === 'string' && env.IDENTITY_CELL_ID !== env.CELL_ID) {
    throw new ApiError(503, 'identity_authority_unavailable', 'The current identity authority is unavailable.');
  }
  if (Object.keys(routingBindings(env.CELL_BINDINGS_JSON, 32)).some(cell => cell !== env.CELL_ID)
    && env.IDENTITY_CELL_ID !== env.CELL_ID) {
    throw new ApiError(503, 'identity_authority_unavailable', 'Multi-cell routing requires an explicit current identity authority.');
  }
  if (isDatabase(env.ROOT_DB)) { identityDatabaseLocation(env); return env.ROOT_DB; }
  return env.DB;
}

export function identityDatabase(c: AppContext): D1DatabaseSession {
  const binding = identityBinding(c.env);
  if (!separateIdentityAuthority(c)) return database(c);
  let session = sessions.get(c);
  if (!session) { session = binding.withSession('first-primary'); sessions.set(c, session); }
  return session;
}

export function separateIdentityAuthority(c: AppContext): boolean {
  return !sameDatabaseLocation(identityDatabaseLocation(c.env), requestDatabaseLocation(c));
}

export function selectIdentityDatabase(c: AppContext): void {
  setRequestDatabase(c, identityBinding(c.env), { kind: 'identity', location: identityDatabaseLocation(c.env) });
}

/** Preserve this descriptor together with the binding before replacing DB/SHARD_ID. */
export function identityAuthorityBindings(env: Bindings): Required<Pick<Bindings, 'IDENTITY_DB' | 'IDENTITY_CELL_ID' | 'IDENTITY_SHARD_ID'>> {
  const source = identityDatabaseLocation(env);
  return { IDENTITY_DB: identityBinding(env), IDENTITY_CELL_ID: source.cell_id, IDENTITY_SHARD_ID: source.shard_id };
}
