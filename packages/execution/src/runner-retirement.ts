import { ApiError, auditStatement, eventStatement, identityDatabaseLocation, many, newId, now, one, ownedAccountAuthority, releaseAccountAuthority, sha256, stmt, withAccountAuthorityBarrier } from '@gitknot/core';
import type { AccountAuthorityVersion, Bindings, Database } from '@gitknot/core';
import { assertRunnerFence, enrollRunnerMetadataAuthority, readRunnerRecord, runnerFencePredicate, runnerIdentityContext } from './runner-authority.ts';
import { runnerCondition } from './runner-guards.ts';
import { runnerMetadataRequest, runnerPlacementPredicate, runnerResourcePlacement, sameRunnerDatabase } from './runner-placement.ts';
import type { RunnerPlacement } from './runner-placement.ts';
import { guardedBatch, identityPrimary } from './store.ts';
import type { RunnerPool, RunnerRecord } from './types.ts';

interface RunnerRetirement {
  runner_id: string; pool_id: string; account_id: string; metadata_authority: 'identity' | 'repository'; metadata_repo_id: string | null;
  credential_generation: number; credential_hash: string; kind: 'revoked' | 'disposable'; attempt_id: string | null;
  attempt_generation: number | null; slot_fence: string | null; state: 'pending' | 'committed'; created_at: string; committed_at: string | null;
}
interface RetirementReceipt {
  runner_id: string; repo_id: string | null; account_id: string; credential_generation: number; credential_hash: string; applied_at: string;
}
interface Consumption { attempt_id: string; consumed_at: string }
export interface RunnerAuthorityReconciliation { id: string; pool_id: string; account_id: string; state: 'pending' | 'committed' }
interface CleanupSlot {
  attempt_id: string; runner_id: string; pool_id: string | null; repo_id: string; account_id: string; generation: number; fence: string;
  runner_credential_generation: number | null; runner_credential_hash: string | null; assigned_at: string | null;
  cleanup_proof_json: string | null; cleanup_proof_hash: string | null; cleanup_verified_at: string | null;
}

function readRetirement(env: Bindings, runnerId: string): Promise<RunnerRetirement | null> {
  return one(identityPrimary(env), 'SELECT * FROM runner_retirements WHERE runner_id=?', runnerId);
}

function identityFence(env: Bindings, placement: RunnerPlacement, fence: AccountAuthorityVersion): { sql: string; values: unknown[] } {
  return runnerFencePredicate(env, { ...placement, location: identityDatabaseLocation(env) }, fence);
}

async function cleanupFence<T>(env: Bindings, placement: RunnerPlacement, accountId: string, reason: string, action: (fence: AccountAuthorityVersion) => Promise<T>): Promise<T> {
  await enrollRunnerMetadataAuthority(env, placement, accountId);
  const existing = await one<AccountAuthorityVersion>(identityPrimary(env), `SELECT e.* FROM account_authority_epochs e JOIN account_policy_barriers b ON b.account_id=e.account_id AND b.id=e.barrier_id
    WHERE e.account_id=? AND e.phase='fenced'`, accountId);
  // Retirement only removes authority. It can finish inside another verified
  // account fence, including account disablement, without owning its release.
  if (existing) { await assertRunnerFence(env, accountId, existing); return action(existing); }
  const abandoned = await one<{ id: string; reason: string; recover_after: string }>(identityPrimary(env), 'SELECT id,reason,recover_after FROM account_policy_barriers WHERE account_id=?', accountId);
  if (abandoned?.reason.startsWith('runner-') && abandoned.recover_after <= now()) await releaseAccountAuthority(env, accountId, abandoned.id);
  const context = runnerIdentityContext(env);
  return withAccountAuthorityBarrier(context, accountId, reason, async () => {
    const fence = ownedAccountAuthority(context, accountId);
    if (!fence) throw new ApiError(503, 'runner_retirement_pending', 'The retirement account fence could not be established.');
    return action(fence);
  });
}

async function recordRetirement(env: Bindings, runner: RunnerRecord, placement: RunnerPlacement, fence: AccountAuthorityVersion, slot?: CleanupSlot): Promise<RunnerRetirement> {
  const existing = await readRetirement(env, runner.id);
  if (existing) {
    if (existing.account_id !== runner.account_id || existing.pool_id !== runner.pool_id || existing.credential_generation !== runner.credential_generation
      || existing.credential_hash !== runner.credential_hash || slot && existing.attempt_id !== null && existing.attempt_id !== slot.attempt_id) throw new ApiError(409, 'runner_retirement_conflict', 'This machine already has a different immutable retirement intent.');
    return existing;
  }
  if (!slot && runner.state !== 'revoked') throw new ApiError(409, 'runner_retirement_unproven', 'Permanent retirement requires revocation or verified disposable cleanup.');
  const row: RunnerRetirement = { runner_id: runner.id, pool_id: runner.pool_id, account_id: runner.account_id,
    metadata_authority: placement.locator.authority, metadata_repo_id: placement.locator.repo_id, credential_generation: runner.credential_generation,
    credential_hash: runner.credential_hash, kind: slot ? 'disposable' : 'revoked', attempt_id: slot?.attempt_id ?? null,
    attempt_generation: slot?.generation ?? null, slot_fence: slot?.fence ?? null, state: 'pending', created_at: now(), committed_at: null };
  const db = identityPrimary(env), authority = identityFence(env, placement, fence);
  const statements = runnerCondition(db, authority.sql, authority.values);
  if (slot) {
    statements.push(...runnerCondition(db, `EXISTS (SELECT 1 FROM runner_slot_reservations WHERE attempt_id=? AND runner_id=? AND generation=? AND fence=?
      AND assigned_at IS NOT NULL AND cleanup_proof_hash=? AND cleanup_verified_at=?)`,
    [slot.attempt_id, slot.runner_id, slot.generation, slot.fence, slot.cleanup_proof_hash, slot.cleanup_verified_at]));
    statements.push(stmt(db, `INSERT INTO runner_disposable_consumption(runner_id,attempt_id,account_id,generation,credential_generation,consumed_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(runner_id) DO NOTHING`, runner.id, slot.attempt_id, runner.account_id, slot.generation, runner.credential_generation, slot.assigned_at));
    statements.push(...runnerCondition(db, 'EXISTS (SELECT 1 FROM runner_disposable_consumption WHERE runner_id=? AND attempt_id=? AND generation=? AND credential_generation=?)',
      [runner.id, slot.attempt_id, slot.generation, runner.credential_generation]));
  }
  statements.push(stmt(db, `INSERT INTO runner_retirements(runner_id,pool_id,account_id,metadata_authority,metadata_repo_id,credential_generation,credential_hash,kind,attempt_id,attempt_generation,slot_fence,state,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?) ON CONFLICT(runner_id) DO NOTHING`, row.runner_id, row.pool_id, row.account_id, row.metadata_authority, row.metadata_repo_id,
  row.credential_generation, row.credential_hash, row.kind, row.attempt_id, row.attempt_generation, row.slot_fence, row.created_at));
  await db.batch(statements);
  const recorded = await readRetirement(env, runner.id);
  if (!recorded || recorded.account_id !== row.account_id || recorded.credential_hash !== row.credential_hash || recorded.credential_generation !== row.credential_generation) throw new ApiError(409, 'runner_retirement_conflict', 'The retirement intent changed concurrently.');
  return recorded;
}

function retirementMetadataStatements(env: Bindings, db: Database, placement: RunnerPlacement, row: RunnerRetirement, fence: AccountAuthorityVersion, consumption: Consumption | null): D1PreparedStatement[] {
  const authority = runnerFencePredicate(env, placement, fence), location = runnerPlacementPredicate(placement, true), at = now();
  return [...runnerCondition(db, authority.sql, authority.values), ...runnerCondition(db, location.sql, location.values),
    ...runnerCondition(db, `EXISTS (SELECT 1 FROM runners WHERE id=? AND account_id=? AND pool_id=? AND credential_generation=? AND credential_hash=?)`,
      [row.runner_id, row.account_id, row.pool_id, row.credential_generation, row.credential_hash]),
    stmt(db, `UPDATE runners SET state='revoked',revision=revision+1,updated_at=?,
      assignment_attempt_id=CASE WHEN disposable=1 THEN COALESCE(assignment_attempt_id,?) ELSE assignment_attempt_id END,
      disposable_consumed_at=CASE WHEN disposable=1 THEN COALESCE(disposable_consumed_at,?) ELSE disposable_consumed_at END
      WHERE id=? AND (state<>'revoked' OR (disposable=1 AND assignment_attempt_id IS NULL AND ? IS NOT NULL))`,
    at, consumption?.attempt_id ?? null, consumption?.consumed_at ?? null, row.runner_id, consumption?.attempt_id ?? null),
    stmt(db, `INSERT INTO runner_retirement_projections(runner_id,repo_id,account_id,credential_generation,credential_hash,applied_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(runner_id) DO NOTHING`, row.runner_id, placement.locator.authority === 'repository' ? placement.locator.repo_id : null,
    row.account_id, row.credential_generation, row.credential_hash, at),
  ];
}

async function verifyRetirement(env: Bindings, placement: RunnerPlacement, row: RunnerRetirement): Promise<RetirementReceipt> {
  const [receipt, runner] = await Promise.all([
    runnerMetadataRequest<RetirementReceipt | null>(env, placement, { action: 'retirement' }),
    runnerMetadataRequest<RunnerRecord | null>(env, placement, { action: 'read' }),
  ]);
  if (!receipt || receipt.runner_id !== row.runner_id || receipt.account_id !== row.account_id || receipt.credential_generation !== row.credential_generation || receipt.credential_hash !== row.credential_hash
    || !runner || runner.id !== row.runner_id || runner.account_id !== row.account_id || runner.pool_id !== row.pool_id || runner.state !== 'revoked'
    || runner.credential_generation !== row.credential_generation || runner.credential_hash !== row.credential_hash) throw new ApiError(409, 'runner_retirement_changed', 'The actual machine metadata does not confirm its original retirement.');
  return receipt;
}

/** The RPC accepts only an ID and fence; its immutable intent stays on IDENTITY_DB. */
export async function retireRunnerProjection(env: Bindings, placement: RunnerPlacement, fence: AccountAuthorityVersion): Promise<RetirementReceipt> {
  const row = await readRetirement(env, placement.locator.resource_id);
  if (!row || row.metadata_authority !== placement.locator.authority || row.metadata_repo_id !== placement.locator.repo_id) throw new ApiError(409, 'runner_retirement_unproven', 'This placement has no matching identity retirement intent.');
  await assertRunnerFence(env, row.account_id, fence);
  const consumption = await one<Consumption>(identityPrimary(env), 'SELECT attempt_id,consumed_at FROM runner_disposable_consumption WHERE runner_id=?', row.runner_id);
  if (row.kind === 'disposable' && consumption?.attempt_id !== row.attempt_id) throw new ApiError(409, 'runner_retirement_unproven', 'Disposable retirement requires its original assignment history.');
  const db = placement.binding!.withSession('first-primary');
  await db.batch(retirementMetadataStatements(env, db, placement, row, fence, consumption));
  return verifyRetirement(env, placement, row);
}

function revokeMachineStatements(env: Bindings, db: Database, placement: RunnerPlacement, row: RunnerRetirement, fence: AccountAuthorityVersion): D1PreparedStatement[] {
  const authority = identityFence(env, placement, fence);
  return [...runnerCondition(db, authority.sql, authority.values),
    ...runnerCondition(db, `EXISTS (SELECT 1 FROM runner_retirements WHERE runner_id=? AND account_id=? AND credential_generation=? AND credential_hash=?)
      AND NOT EXISTS (SELECT 1 FROM principals WHERE id=? AND (account_id IS NOT ? OR kind<>'runner'))`,
    [row.runner_id, row.account_id, row.credential_generation, row.credential_hash, row.runner_id, row.account_id]),
    stmt(db, `UPDATE credentials SET revoked_at=?,revision=revision+1 WHERE principal_id=? AND kind='runner' AND revoked_at IS NULL`, now(), row.runner_id),
  ];
}

function retirementCommitStatements(db: Database, row: RunnerRetirement): D1PreparedStatement[] {
  const at = now();
  return [stmt(db, "UPDATE runner_retirements SET state='committed',committed_at=? WHERE runner_id=? AND state='pending'", at, row.runner_id),
    eventStatement(db, { type: 'runner.retired', resource_id: row.runner_id, resource_revision: row.credential_generation, account_id: row.account_id,
      repo_id: row.metadata_repo_id, data: { pool_id: row.pool_id, attempt_id: row.attempt_id, credential_generation: row.credential_generation, reason: row.kind } }),
    auditStatement(db, { action: 'runners.retired', resource_id: row.runner_id, account_id: row.account_id, repo_id: row.metadata_repo_id,
      details: { attempt_id: row.attempt_id, credential_generation: row.credential_generation, reason: row.kind } }),
  ];
}

async function finishRetirement(env: Bindings, row: RunnerRetirement, placement: RunnerPlacement, fence: AccountAuthorityVersion): Promise<void> {
  if (row.metadata_authority !== placement.locator.authority || row.metadata_repo_id !== placement.locator.repo_id) throw new ApiError(409, 'runner_retirement_changed', 'The runner retirement storage authority changed.');
  const db = identityPrimary(env), current = await readRetirement(env, row.runner_id);
  if (current?.state === 'committed') { await verifyRetirement(env, placement, row); return; }
  const first = stmt(db, "UPDATE runner_retirements SET state='pending' WHERE runner_id=? AND state='pending'", row.runner_id);
  if (sameRunnerDatabase(env, placement)) {
    const consumed = await one<Consumption>(identityPrimary(env), 'SELECT attempt_id,consumed_at FROM runner_disposable_consumption WHERE runner_id=?', row.runner_id);
    await guardedBatch(db, first, [...revokeMachineStatements(env, db, placement, row, fence),
      ...retirementMetadataStatements(env, db, placement, row, fence, consumed), ...retirementCommitStatements(db, row)]);
    return;
  }
  await db.batch(revokeMachineStatements(env, db, placement, row, fence));
  await runnerMetadataRequest(env, placement, { action: 'retire', fence: { ...fence, phase: 'fenced', barrier_id: fence.barrier_id! } });
  await verifyRetirement(env, placement, row);
  const authority = identityFence(env, placement, fence);
  await guardedBatch(db, first, [...runnerCondition(db, authority.sql, authority.values), ...retirementCommitStatements(db, row)]);
}

/** Event/recovery hook. A disabled machine is deliberately reversible. */
export async function reconcileRunnerState(env: Bindings, runnerId: string): Promise<{ retired: boolean }> {
  const runner = await readRunnerRecord(env, runnerId), pending = await readRetirement(env, runnerId);
  if (!pending && runner.state !== 'revoked') return { retired: false };
  const placement = await runnerResourcePlacement(env, runnerId, 'runner');
  if (pending?.state === 'committed') { await verifyRetirement(env, placement, pending); return { retired: true }; }
  await cleanupFence(env, placement, runner.account_id, `runner-retirement:${runnerId}`, async fence => {
    const row = pending ?? await recordRetirement(env, runner, placement, fence);
    await finishRetirement(env, row, placement, fence);
  });
  return { retired: true };
}

/** closeRunnerSlot first journals a verified, immutable proof while retaining the lease. */
export async function retireDisposableRunner(env: Bindings, attemptId: string, generation: number): Promise<void> {
  const slot = await one<CleanupSlot>(identityPrimary(env), 'SELECT * FROM runner_slot_reservations WHERE attempt_id=? AND generation=?', attemptId, generation);
  if (!slot?.assigned_at || !slot.cleanup_proof_json || !slot.cleanup_proof_hash || !slot.cleanup_verified_at
    || await sha256(slot.cleanup_proof_json) !== slot.cleanup_proof_hash) throw new ApiError(409, 'runner_cleanup_unverified', 'Disposable retirement requires verified original assignment cleanup.');
  const runner = await readRunnerRecord(env, slot.runner_id);
  if (!runner.disposable || runner.account_id !== slot.account_id || slot.pool_id !== null && runner.pool_id !== slot.pool_id
    || slot.runner_credential_generation !== null && runner.credential_generation !== slot.runner_credential_generation
    || slot.runner_credential_hash !== null && runner.credential_hash !== slot.runner_credential_hash
    || runner.assignment_attempt_id !== null && runner.assignment_attempt_id !== slot.attempt_id) throw new ApiError(409, 'runner_retirement_changed', 'The machine does not match the disposable assignment being retired.');
  const placement = await runnerResourcePlacement(env, runner.id, 'runner');
  const committed = await readRetirement(env, runner.id);
  if (committed?.state === 'committed') { await verifyRetirement(env, placement, committed); return; }
  await cleanupFence(env, placement, runner.account_id, `runner-retirement:${runner.id}`, async fence => {
    const row = await recordRetirement(env, runner, placement, fence, slot);
    await finishRetirement(env, row, placement, fence);
  });
}

export async function enqueueRunnerAuthorityReconciliation(env: Bindings, pool: RunnerPool, fence: AccountAuthorityVersion): Promise<RunnerAuthorityReconciliation> {
  const intent: RunnerAuthorityReconciliation = { id: newId('rrecon'), pool_id: pool.id, account_id: pool.account_id, state: 'pending' };
  const db = identityPrimary(env), placement = await runnerResourcePlacement(env, pool.id, 'runner_pool'), authority = identityFence(env, placement, fence);
  await db.batch([...runnerCondition(db, authority.sql, authority.values), stmt(db, `INSERT INTO runner_authority_reconciliations(id,pool_id,account_id,created_at) VALUES (?,?,?,?)`, intent.id, pool.id, pool.account_id, now())]);
  return intent;
}

/** Bounded page; unfinished work stays durable for the scheduled hook. */
export async function reconcileRunnerPoolState(env: Bindings, intent: RunnerAuthorityReconciliation, fence: AccountAuthorityVersion): Promise<void> {
  await assertRunnerFence(env, intent.account_id, fence);
  const placement = await runnerResourcePlacement(env, intent.pool_id, 'runner_pool');
  const revoked = await runnerMetadataRequest<RunnerRecord[]>(env, placement, { action: 'revoked-runners' });
  for (const runner of revoked) {
    if (runner.pool_id !== intent.pool_id || runner.account_id !== intent.account_id) throw new ApiError(409, 'runner_retirement_changed', 'The pool retirement scope changed.');
    const actual = await runnerResourcePlacement(env, runner.id, 'runner');
    const row = await recordRetirement(env, runner, actual, fence);
    await finishRetirement(env, row, actual, fence);
  }
  const pending = await many<RunnerRetirement>(identityPrimary(env), "SELECT * FROM runner_retirements WHERE pool_id=? AND account_id=? AND state='pending' ORDER BY runner_id LIMIT 50", intent.pool_id, intent.account_id);
  for (const row of pending) await finishRetirement(env, row, await runnerResourcePlacement(env, row.runner_id, 'runner'), fence);
  if (revoked.length === 50 || pending.length === 50) return;
  const db = identityPrimary(env), authority = identityFence(env, placement, fence);
  await db.batch([...runnerCondition(db, authority.sql, authority.values), stmt(db, "UPDATE runner_authority_reconciliations SET state='committed',committed_at=? WHERE id=? AND account_id=? AND state='pending'", now(), intent.id, intent.account_id)]);
}

/** Scheduled recovery on the current identity authority; never scans seeded runner copies. */
export async function reconcileRunnerAuthorityChanges(env: Bindings, limit = 50): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Runner reconciliation limit must be between 1 and 100.');
  let reconciled = 0;
  const retirements = await many<{ runner_id: string }>(identityPrimary(env), "SELECT runner_id FROM runner_retirements WHERE state='pending' ORDER BY created_at,runner_id LIMIT ?", limit);
  for (const row of retirements) { await reconcileRunnerState(env, row.runner_id); reconciled++; }
  const intents = await many<RunnerAuthorityReconciliation>(identityPrimary(env), "SELECT * FROM runner_authority_reconciliations WHERE state='pending' ORDER BY created_at,id LIMIT ?", limit);
  for (const intent of intents) {
    const placement = await runnerResourcePlacement(env, intent.pool_id, 'runner_pool');
    await enrollRunnerMetadataAuthority(env, placement, intent.account_id);
    const context = runnerIdentityContext(env);
    // Management reconciliation must own a new barrier. Reusing an in-progress
    // manager's fence could finish its journal before its metadata write arrives.
    await withAccountAuthorityBarrier(context, intent.account_id, `runner-reconcile:${intent.id}`, async () => {
      const fence = ownedAccountAuthority(context, intent.account_id);
      if (!fence) throw new ApiError(503, 'runner_retirement_pending', 'The reconciliation account fence could not be established.');
      await reconcileRunnerPoolState(env, intent, fence);
    });
    reconciled++;
  }
  return reconciled;
}
