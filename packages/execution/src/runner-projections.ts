import { ApiError, now, one, stmt } from '@gitknot/core';
import type { AccountAuthorityVersion, Bindings, Database } from '@gitknot/core';
import type { RunnerPool, RunnerRecord } from './types.ts';
import { assertRunnerFence, runnerFencePredicate } from './runner-authority.ts';
import { parseRunnerProjection, readRunnerExchange } from './runner-exchanges.ts';
import type { RunnerEnrollment, RunnerExchange, RunnerProjection } from './runner-exchanges.ts';
import { runnerMetadataRequest, runnerPlacementPredicate, runnerResourcePlacement, sameRunnerPlacement } from './runner-placement.ts';
import type { RunnerPlacement } from './runner-placement.ts';
import { databaseClock, runnerCondition } from './runner-guards.ts';
import { guardedBatch, identityPrimary } from './store.ts';

export interface RunnerProjectionReceipt {
  exchange_id: string; repo_id: string | null; runner_id: string; pool_id: string; account_id: string; kind: 'register' | 'rotate';
  projection_hash: string; credential_hash: string; credential_generation: number; applied_at: string;
}
export function readProjection(db: Database, id: string): Promise<RunnerProjectionReceipt | null> {
  return one(db, 'SELECT * FROM runner_exchange_projections WHERE exchange_id=?', id);
}

export function projectionStatements(env: Bindings, db: Database, placement: RunnerPlacement, row: RunnerExchange, projection: RunnerProjection, fence: AccountAuthorityVersion): D1PreparedStatement[] {
  const next = projection.runner, at = now(), authority = runnerFencePredicate(env, placement, fence), location = runnerPlacementPredicate(placement);
  const statements = [...runnerCondition(db, authority.sql, authority.values), ...runnerCondition(db, location.sql, location.values)];
  statements.push(...runnerCondition(db, "EXISTS (SELECT 1 FROM runner_pools WHERE id=? AND account_id=? AND repo_id IS ? AND revision=? AND state='active')",
    [row.pool_id, row.account_id, row.scope_repo_id, projection.pool.revision]));
  if (row.kind === 'register') {
    statements.push(...runnerCondition(db, `EXISTS (SELECT 1 FROM runner_enrollments WHERE id=? AND pool_id=? AND account_id=? AND repo_id IS ? AND token_hash=?
      AND revision=? AND created_by=? AND consumed_at IS NULL AND expires_at=? AND expires_at>${databaseClock})
      AND (SELECT COUNT(*) FROM runners WHERE pool_id=? AND state='active')<?`,
    [row.enrollment_id, row.pool_id, row.account_id, row.scope_repo_id, row.source_hash, projection.enrollment!.revision, projection.created_by,
      projection.enrollment!.expires_at, row.pool_id, projection.pool.max_runners]));
    statements.push(stmt(db, 'UPDATE runner_enrollments SET consumed_at=?,runner_id=?,registration_hash=?,revision=revision+1 WHERE id=? AND token_hash=? AND consumed_at IS NULL',
      at, row.runner_id, row.request_hash, row.enrollment_id, row.source_hash));
    statements.push(stmt(db, `INSERT INTO runners(id,account_id,repo_id,pool_id,name,os,architecture,toolchains_json,slots,credential_hash,credential_generation,credential_expires_at,state,last_seen_at,revision,created_at,updated_at,disposable,assignment_attempt_id,disposable_consumed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?,?,?,NULL,NULL)`, next.id, next.account_id, next.repo_id, next.pool_id, next.name, next.os, next.architecture,
    next.toolchains_json, next.slots, next.credential_hash, next.credential_generation, next.credential_expires_at, next.last_seen_at, next.revision, next.created_at, next.updated_at, next.disposable));
  } else {
    statements.push(...runnerCondition(db, `EXISTS (SELECT 1 FROM runners WHERE id=? AND account_id=? AND pool_id=? AND repo_id IS ? AND credential_generation=?
      AND credential_hash=? AND credential_expires_at=? AND credential_expires_at>${databaseClock} AND revision=? AND state='active'
      AND (disposable=0 OR assignment_attempt_id IS NULL))`,
    [row.runner_id, row.account_id, row.pool_id, row.scope_repo_id, row.expected_generation, row.source_hash, projection.previous!.credential_expires_at, projection.previous!.revision]));
    statements.push(stmt(db, 'UPDATE runners SET credential_hash=?,credential_generation=?,credential_expires_at=?,revision=revision+1,updated_at=? WHERE id=? AND credential_generation=? AND credential_hash=?',
      next.credential_hash, next.credential_generation, next.credential_expires_at, next.updated_at, row.runner_id, row.expected_generation, row.source_hash));
  }
  statements.push(stmt(db, 'INSERT INTO runner_exchange_projections(exchange_id,repo_id,runner_id,pool_id,account_id,kind,projection_hash,credential_hash,credential_generation,applied_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    row.id, placement.locator.authority === 'repository' ? placement.locator.repo_id : null, row.runner_id, row.pool_id, row.account_id, row.kind, row.projection_hash, next.credential_hash, next.credential_generation, at));
  return statements;
}

function matchesRunner(runner: RunnerRecord | null, wanted: RunnerRecord): boolean {
  return !!runner && runner.id === wanted.id && runner.account_id === wanted.account_id && runner.repo_id === wanted.repo_id && runner.pool_id === wanted.pool_id
    && runner.state === 'active' && runner.revision === wanted.revision && runner.credential_hash === wanted.credential_hash
    && runner.credential_generation === wanted.credential_generation && runner.credential_expires_at === wanted.credential_expires_at
    && runner.slots === wanted.slots && runner.disposable === wanted.disposable && runner.os === wanted.os
    && runner.architecture === wanted.architecture && runner.toolchains_json === wanted.toolchains_json;
}

async function verifyEnrollmentProjection(env: Bindings, placement: RunnerPlacement, row: RunnerExchange, projection: RunnerProjection): Promise<void> {
  if (row.kind !== 'register') return;
  const enrollmentPlacement = await runnerResourcePlacement(env, row.enrollment_id!, 'runner_enrollment');
  if (!sameRunnerPlacement(placement, enrollmentPlacement)) throw new ApiError(409, 'runner_exchange_placement', 'Enrollment storage no longer matches its recorded exchange.');
  const enrollment = await runnerMetadataRequest<RunnerEnrollment | null>(env, enrollmentPlacement, { action: 'read' });
  if (!enrollment || enrollment.pool_id !== row.pool_id || enrollment.account_id !== row.account_id || enrollment.repo_id !== row.scope_repo_id
    || enrollment.token_hash !== row.source_hash || enrollment.runner_id !== row.runner_id || enrollment.consumed_at === null
    || enrollment.registration_hash !== row.request_hash || enrollment.revision !== projection.enrollment!.revision + 1
    || enrollment.created_by !== projection.created_by || enrollment.expires_at !== projection.enrollment!.expires_at) throw new ApiError(409, 'runner_projection_changed', 'The consumed enrollment does not match its immutable exchange.');
}

export async function verifyRunnerProjection(env: Bindings, placement: RunnerPlacement, row: RunnerExchange): Promise<RunnerProjectionReceipt> {
  const projection = parseRunnerProjection(row), poolPlacement = await runnerResourcePlacement(env, row.pool_id, 'runner_pool');
  if (!sameRunnerPlacement(placement, poolPlacement)) throw new ApiError(409, 'runner_exchange_placement', 'The exchange pool no longer shares the recorded metadata authority.');
  const [receipt, runner, pool] = await Promise.all([
    runnerMetadataRequest<RunnerProjectionReceipt | null>(env, placement, { action: 'projection', exchange_id: row.id }),
    runnerMetadataRequest<RunnerRecord | null>(env, placement, { action: 'read' }),
    runnerMetadataRequest<RunnerPool | null>(env, poolPlacement, { action: 'read' }),
  ]);
  if (!receipt || receipt.exchange_id !== row.id || receipt.kind !== row.kind || receipt.projection_hash !== row.projection_hash || receipt.runner_id !== row.runner_id
    || receipt.pool_id !== row.pool_id || receipt.account_id !== row.account_id || receipt.credential_generation !== row.credential_generation || receipt.credential_hash !== projection.runner.credential_hash
    || receipt.repo_id !== (placement.locator.authority === 'repository' ? placement.locator.repo_id : null)
    || !matchesRunner(runner, projection.runner) || !pool || pool.account_id !== row.account_id || pool.repo_id !== row.scope_repo_id
    || pool.state !== 'active' || pool.revision !== projection.pool.revision) throw new ApiError(409, 'runner_projection_changed', 'The current runner metadata does not match its immutable credential projection.');
  await verifyEnrollmentProjection(env, placement, row, projection);
  return receipt;
}

export async function projectRunnerExchange(env: Bindings, placement: RunnerPlacement, id: string, fence: AccountAuthorityVersion): Promise<RunnerProjectionReceipt> {
  const row = await readRunnerExchange(env, id);
  if (!row || row.runner_id !== placement.locator.resource_id || row.metadata_authority !== placement.locator.authority || row.metadata_repo_id !== placement.locator.repo_id) throw new ApiError(409, 'runner_exchange_placement', 'The projection does not belong to this runner location.');
  await assertRunnerFence(env, row.account_id, fence);
  const db = placement.binding!.withSession('first-primary');
  if (await readProjection(db, id)) return verifyRunnerProjection(env, placement, row);
  if (row.state !== 'pending' || !await one(identityPrimary(env), `SELECT exchange_id FROM runner_credential_exchange_locks WHERE runner_id=? AND exchange_id=?
    AND NOT EXISTS (SELECT 1 FROM runner_retirements WHERE runner_id=?)`, row.runner_id, id, row.runner_id)) throw new ApiError(409, 'runner_projection_missing', 'The original pending exchange no longer holds this machine.');
  const projection = parseRunnerProjection(row);
  await guardedBatch(db, stmt(db, "UPDATE runner_pools SET updated_at=updated_at WHERE id=? AND account_id=? AND state='active'", row.pool_id, row.account_id),
    projectionStatements(env, db, placement, row, projection, fence));
  return verifyRunnerProjection(env, placement, row);
}
