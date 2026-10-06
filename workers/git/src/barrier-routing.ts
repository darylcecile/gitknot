import { identityBinding, now, one, sha256, stmt } from '@gitknot/core';
import type { RepositoryPlacement } from '@gitknot/core';
import { requireValue } from '../../../packages/git/src/errors.ts';
import { gitPlacement } from './placement.ts';
import type { GitBindings } from './types.ts';

interface BarrierRoute { repo_id: string; operation_id: string; token_hash: string; cell_id: string; shard_id: string; epoch: number }

/** Release-before-acquire and post-move release must reach the same durable journal. */
export async function barrierPlacement(env: GitBindings, repoId: string, body: Record<string, unknown>): Promise<RepositoryPlacement> {
  requireValue(typeof body.operation_id === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/u.test(body.operation_id)
    && typeof body.token === 'string' && body.token.length >= 32, 'invalid_barrier', 'The exact maintenance operation and token are required.', 400);
  const db = identityBinding(env).withSession('first-primary');
  const hash = await sha256(body.token);
  let saved = await one<BarrierRoute>(db, 'SELECT * FROM git_barrier_routes WHERE repo_id=? AND operation_id=?', repoId, body.operation_id);
  if (!saved) {
    const current = await gitPlacement(env, repoId);
    await stmt(db, `INSERT INTO git_barrier_routes(repo_id,operation_id,token_hash,cell_id,shard_id,epoch,created_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(repo_id,operation_id) DO NOTHING`, repoId, body.operation_id, hash,
    current.cell_id, current.shard_id, current.epoch, now()).run();
    saved = await one<BarrierRoute>(db, 'SELECT * FROM git_barrier_routes WHERE repo_id=? AND operation_id=?', repoId, body.operation_id);
  }
  requireValue(saved?.token_hash === hash, 'invalid_barrier', 'This maintenance operation belongs to another token.', 403);
  return { repo_id: repoId, cell_id: saved.cell_id, shard_id: saved.shard_id, epoch: saved.epoch, state: 'active', operation_id: body.operation_id };
}
