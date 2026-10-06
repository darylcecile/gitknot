import { stmt } from '../db.ts';
import { ApiError } from '../errors.ts';
import type { AppContext, Database } from '../types.ts';
import { selectedRepositoryScope } from './cells.ts';

/** Acquisition identity returned by the placement-local metadata fence owner. */
export interface RepositoryMetadataFence {
  repo_id: string;
  operation_id: string;
  routing_epoch: number;
  fence_id: string;
}

const owners = new WeakMap<AppContext, RepositoryMetadataFence>();
const guards = new WeakMap<D1PreparedStatement, { repo_id: string; owner: boolean }>();

function rememberGuard(statement: D1PreparedStatement, repoId: string, owner: boolean): D1PreparedStatement {
  guards.set(statement, { repo_id: repoId, owner });
  return statement;
}

/** Only known ordinary guards for one repository can defer a prepared batch. */
export function ordinaryMetadataFenceScope(statements: readonly D1PreparedStatement[]): string | null {
  let repoId: string | null = null;
  for (const statement of statements) {
    const guard = guards.get(statement);
    if (!guard) continue;
    if (guard.owner || repoId !== null && repoId !== guard.repo_id) return null;
    repoId = guard.repo_id;
  }
  return repoId;
}

/** Trusted operation context; never inferred from an actor, URL, or request header. */
export async function inRepositoryMetadataFence<T>(c: AppContext, fence: RepositoryMetadataFence, action: () => Promise<T>): Promise<T> {
  if (selectedRepositoryScope(c) !== fence.repo_id || !fence.operation_id || !fence.fence_id
    || !Number.isSafeInteger(fence.routing_epoch) || fence.routing_epoch < 1
    || c.get('routing')?.epoch !== fence.routing_epoch) {
    throw new ApiError(409, 'metadata_fence_context_changed', 'The operation does not own this repository metadata placement.');
  }
  if (owners.has(c)) throw new Error('Nested repository metadata fence owner context.');
  owners.set(c, structuredClone(fence));
  try { return await action(); }
  finally { owners.delete(c); }
}

export function currentRepositoryMetadataFence(c: AppContext, repoId: string): RepositoryMetadataFence | undefined {
  const owner = owners.get(c);
  return owner?.repo_id === repoId ? structuredClone(owner) : undefined;
}

/** This statement belongs in the same D1 batch as the metadata write. */
export function repositoryMetadataFenceGuard(db: Database, repoId: string, id: string,
  owner?: RepositoryMetadataFence): D1PreparedStatement {
  if (owner && owner.repo_id !== repoId) throw new TypeError('The metadata fence belongs to a different repository.');
  if (owner) {
    // A released/replaced acquisition cannot silently become an ordinary writer.
    return rememberGuard(stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN EXISTS (
      SELECT 1 FROM repository_metadata_fences WHERE repo_id=? AND operation_id=? AND routing_epoch=? AND fence_id=? AND state='held'
    ) THEN 1 ELSE 0 END`, id, repoId, owner.operation_id, owner.routing_epoch, owner.fence_id), repoId, true);
  }
  // Migration 097 converts this reserved failure marker into a named ABORT.
  // Owner failures deliberately remain ordinary compare-and-swap conflicts.
  return rememberGuard(stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN NOT EXISTS (
    SELECT 1 FROM repository_metadata_fences WHERE repo_id=? AND state='held'
  ) THEN 1 ELSE -1 END`, id, repoId), repoId, false);
}
