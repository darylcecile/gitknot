import { identityBinding, identityAuthorityBindings } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import type { BillingBindings } from './types.ts';

/** Financial/account state never follows a repository's seeded identity copy. */
export function billingEnvironment<T extends Pick<Bindings, 'DB'>>(env: T): T & BillingBindings {
  const source = env as T & BillingBindings;
  const primary = identityBinding(source);
  if (!source.CELL_ID || !source.SHARD_ID) return { ...source, DB: primary };
  const identity = identityAuthorityBindings(source);
  if (source.CELL_ID === identity.IDENTITY_CELL_ID && source.SHARD_ID === identity.IDENTITY_SHARD_ID) return { ...source, ...identity, DB: primary };
  const shards = typeof source.SHARD_BINDINGS_JSON === 'string' ? JSON.parse(source.SHARD_BINDINGS_JSON) as Record<string, string> : {};
  if (source.SHARD_ID && !shards[source.SHARD_ID]) shards[source.SHARD_ID] = 'BILLING_SOURCE_DB';
  return { ...source, ...identity, ROOT_DB: source.ROOT_DB ?? source.DB,
    ROOT_SHARD_ID: source.ROOT_SHARD_ID ?? source.SHARD_ID, BILLING_SOURCE_DB: source.DB,
    SHARD_BINDINGS_JSON: JSON.stringify(shards), DB: primary, SHARD_ID: 'billing-authority' };
}
