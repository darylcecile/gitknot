import { ApiError, identityDatabaseLocation, newId, one, repositoryMetadataFenceGuard, resolveRepositoryPlacement, stmt } from '@gitknot/core';
import type { Database, Repository, RepositoryMetadataFence } from '@gitknot/core';
import type { OperationsBindings } from './types.ts';

/** Retained source rows are enumeration hints, never authority to start another effect. */
export async function localRepository(env: OperationsBindings, repoId: string, operationId?: string): Promise<Repository | null> {
  const placement = await resolveRepositoryPlacement(env, repoId);
  if (!placement) throw new ApiError(503, 'repository_authority_missing', 'The current repository placement is unavailable.');
  if (placement.cell_id !== env.CELL_ID || placement.shard_id !== env.SHARD_ID) return null;
  if (!['active', 'deleted'].includes(placement.state) && placement.operation_id !== operationId) return null;
  const metadata = await one<{ operation_id: string }>(env.DB, "SELECT operation_id FROM repository_metadata_fences WHERE repo_id=? AND state='held'", repoId);
  if (metadata && metadata.operation_id !== operationId) return null;
  const repo = await one<Repository>(env.DB.withSession('first-primary'), 'SELECT * FROM repositories WHERE id=?', repoId);
  if (!repo || repo.routing_epoch !== placement.epoch || repo.cell_id !== placement.cell_id || repo.shard_id !== placement.shard_id) {
    throw new ApiError(409, 'repository_placement_changed', 'The repository placement changed during background work.');
  }
  if (repo.state === 'moving' && placement.operation_id !== operationId) {
    // Accepted lifecycle operations already close the catalog before their
    // Workflow acquires its native/directory barrier. Only that durable owner
    // may advance from this initial state; ordinary sweepers remain fenced.
    const lifecycle = operationId && placement.operation_id === null ? await one(env.DB,
      `SELECT 1 FROM repository_lifecycle l JOIN operations o ON o.id=l.operation_id WHERE l.operation_id=? AND l.repo_id=?
        AND o.repo_id=l.repo_id AND o.kind='repository.'||l.kind AND l.expected_repository_revision<=?
        AND l.state IN ('queued','running','waiting','failed') AND o.status IN ('pending','waiting','running','failed')`, operationId, repo.id, repo.revision) : null;
    if (!lifecycle) return null;
  }
  return repo;
}

export function isIdentityPlacement(env: OperationsBindings): boolean {
  const identity = identityDatabaseLocation(env);
  return identity.cell_id === env.CELL_ID && identity.shard_id === env.SHARD_ID;
}

export async function requireLocalAuthority(env: OperationsBindings, repoId: string | null, operationId?: string): Promise<Repository | null> {
  if (!repoId) {
    if (!isIdentityPlacement(env)) throw new ApiError(409, 'background_placement_changed', 'This work belongs to the identity authority.');
    return null;
  }
  const repo = await localRepository(env, repoId, operationId);
  if (!repo) throw new ApiError(409, 'background_placement_changed', 'This work belongs to another or currently fenced repository placement.');
  return repo;
}

/** Serializes background metadata changes with the mover's local write fence. */
export function placementGuard(db: Database, repo: Repository | null, owner?: RepositoryMetadataFence | null): D1PreparedStatement[] {
  if (!repo) return [];
  const id = newId('guard');
  return [stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN EXISTS (
    SELECT 1 FROM repositories WHERE id=? AND cell_id=? AND shard_id=? AND routing_epoch=? AND state=? AND owner_id=? AND policy_revision=?
  ) THEN 1 ELSE 0 END`, id, repo.id, repo.cell_id, repo.shard_id, repo.routing_epoch, repo.state, repo.owner_id, repo.policy_revision),
  repositoryMetadataFenceGuard(db, repo.id, `${id}_metadata`, owner ?? undefined),
  stmt(db, 'DELETE FROM mutation_guards WHERE id IN (?,?)', id, `${id}_metadata`)];
}

export function isPlacementRace(error: unknown): boolean {
  return error instanceof ApiError && ['background_placement_changed', 'repository_placement_changed'].includes(error.code);
}
