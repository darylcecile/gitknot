import { ApiError, canonicalJson, execute, many, newId, now, one, readRepositoryAuthority, sha256, stmt } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import { EXECUTION_LIMITS } from './config.ts';
import { guardedBatch, identityPrimary } from './store.ts';
import type { AttemptRecord, RunnerPool, RunnerRecord } from './types.ts';
import { identityRunnerPredicate, loadRunnerAuthority, readRunnerRecord, runnerIdentityContext } from './runner-authority.ts';
import type { RunnerAuthority } from './runner-authority.ts';
import { databaseClock } from './runner-guards.ts';
import { runnerMetadataRequest, runnerResourcePlacement } from './runner-placement.ts';
import { retireDisposableRunner } from './runner-retirement.ts';
import { TERMINAL_ATTEMPTS } from './state.ts';

export interface RunnerSlot {
  attempt_id: string; runner_id: string; repo_id: string; account_id: string; generation: number; fence: string;
  state: 'reserved' | 'leased' | 'closed'; expires_at: string; assigned_at: string | null;
}
interface StoredRunnerSlot extends RunnerSlot {
  pool_id: string | null; runner_credential_generation: number | null; runner_credential_hash: string | null;
  credential_id: string | null; credential_revision: number | null; authority_epoch: number | null; authority_policy_revision: number | null;
  runner_revision: number | null; pool_revision: number | null; slot_limit: number; disposable: number;
  cleanup_proof_json: string | null; cleanup_proof_hash: string | null; cleanup_verified_at: string | null;
}
type SlotAttempt = Pick<AttemptRecord, 'id' | 'repo_id' | 'account_id' | 'pool_id' | 'generation'>;
type CleanupProof = Pick<AttemptRecord, 'id' | 'repo_id' | 'account_id' | 'executor' | 'generation' | 'runner_id' | 'runner_slot_fence'
  | 'runner_credential_generation' | 'runner_credential_hash' | 'cleanup_state' | 'status' | 'allocated_at' | 'runtime_id' | 'destruction_verified_at' | 'receipt_hash'>;

function storedSlot(env: Bindings, attemptId: string): Promise<StoredRunnerSlot | null> {
  return one(identityPrimary(env), 'SELECT * FROM runner_slot_reservations WHERE attempt_id=?', attemptId);
}

async function currentSlotAttempt(env: Bindings, expected: SlotAttempt): Promise<AttemptRecord> {
  const placement = await runnerResourcePlacement(env, expected.id, 'attempt');
  if (placement.locator.authority !== 'repository' || placement.locator.repo_id !== expected.repo_id) throw new ApiError(409, 'runner_slot_scope', 'The attempt does not belong to this repository placement.');
  const actual = await runnerMetadataRequest<AttemptRecord | null>(env, placement, { action: 'read' });
  if (!actual || actual.id !== expected.id || actual.repo_id !== expected.repo_id || actual.account_id !== expected.account_id
    || actual.pool_id !== expected.pool_id || actual.generation !== expected.generation || actual.executor !== 'self_hosted') throw new ApiError(409, 'runner_slot_scope', 'The immutable attempt allocation changed.');
  const repository = await readRepositoryAuthority(runnerIdentityContext(env), actual.repo_id);
  if (!repository || repository.owner_id !== actual.account_id || repository.state !== 'active') throw new ApiError(409, 'runner_slot_scope', 'The attempt repository no longer belongs to this runner account.');
  return actual;
}

export async function offerRunnerJob(env: Bindings, attempt: SlotAttempt): Promise<void> {
  if (!attempt.pool_id) return;
  const current = await currentSlotAttempt(env, attempt);
  if (!['accepted', 'admitting'].includes(current.status)) return;
  const result = await execute(identityPrimary(env), `INSERT INTO runner_job_offers(attempt_id,repo_id,account_id,pool_id,generation,state,created_at,updated_at)
    VALUES (?,?,?,?,?,'offered',?,?) ON CONFLICT(attempt_id) DO UPDATE SET updated_at=excluded.updated_at
    WHERE runner_job_offers.repo_id=excluded.repo_id AND runner_job_offers.account_id=excluded.account_id
      AND runner_job_offers.pool_id=excluded.pool_id AND runner_job_offers.generation=excluded.generation`,
  attempt.id, attempt.repo_id, attempt.account_id, attempt.pool_id, attempt.generation, now(), now());
  if (result.meta.changes !== 1) throw new ApiError(409, 'runner_slot_scope', 'This job offer already belongs to a different attempt identity.');
}

function sameMachine(authority: RunnerAuthority, runner: RunnerRecord, pool: RunnerPool): boolean {
  return authority.runner.credential_hash === runner.credential_hash && authority.runner.credential_generation === runner.credential_generation
    && authority.runner.revision === runner.revision && authority.pool.id === pool.id && authority.pool.revision === pool.revision;
}

function slotMatches(slot: StoredRunnerSlot, authority: RunnerAuthority): boolean {
  const { runner, pool, credential } = authority;
  return slot.runner_id === runner.id && slot.pool_id === pool.id && slot.account_id === runner.account_id
    && slot.runner_credential_hash === runner.credential_hash && slot.runner_credential_generation === runner.credential_generation
    && slot.credential_id === credential.id && slot.credential_revision === credential.revision
    && slot.runner_revision === runner.revision && slot.pool_revision === pool.revision;
}

function admissionPredicate(authority: RunnerAuthority, attemptId: string): { sql: string; values: unknown[] } {
  const { runner, pool, witness } = authority, identity = identityRunnerPredicate(witness);
  const limit = runner.disposable ? 1 : Math.min(runner.slots, pool.max_slots);
  return { sql: `${identity.sql} AND (SELECT COUNT(*) FROM runner_slot_reservations WHERE runner_id=? AND attempt_id<>?
    AND (state='leased' OR state='reserved' AND expires_at>${databaseClock}))<?
    AND (?=0 OR (? IS NULL AND NOT EXISTS (SELECT 1 FROM runner_disposable_consumption WHERE runner_id=?)
      AND NOT EXISTS (SELECT 1 FROM runner_slot_reservations WHERE runner_id=? AND assigned_at IS NOT NULL)))`,
  values: [...identity.values, runner.id, attemptId, limit, runner.disposable, runner.assignment_attempt_id, runner.id, runner.id] };
}

/** Identity-primary SQL is the global slot gate; no runner/pool replica joins. */
export async function reserveRunnerSlot(env: Bindings, attempt: AttemptRecord, runner: RunnerRecord, pool: RunnerPool): Promise<RunnerSlot | null> {
  const authority = await loadRunnerAuthority(env, runner.id), current = await currentSlotAttempt(env, attempt);
  if (!sameMachine(authority, runner, pool) || authority.runner.account_id !== attempt.account_id || pool.account_id !== attempt.account_id
    || attempt.pool_id !== pool.id || pool.repo_id !== null && pool.repo_id !== attempt.repo_id || runner.repo_id !== null && runner.repo_id !== attempt.repo_id
    || current.runner_id !== null && current.runner_id !== runner.id || TERMINAL_ATTEMPTS.has(current.status)) return null;
  const db = identityPrimary(env), at = now(), existing = await storedSlot(env, attempt.id);
  if (existing?.state === 'leased') return existing.generation === attempt.generation && existing.runner_id === runner.id
    && existing.runner_credential_generation === runner.credential_generation && existing.runner_credential_hash === runner.credential_hash ? existing : null;
  if (existing?.assigned_at || !['accepted', 'admitting'].includes(current.status)) return null;
  if (existing?.state === 'reserved' && existing.expires_at > at && slotMatches(existing, authority)) return existing;
  if (existing?.state === 'reserved' && existing.expires_at > at && existing.runner_id !== runner.id) return null;
  const fence = newId('rslot'), expires = new Date(Date.now() + EXECUTION_LIMITS.lease_ms).toISOString(), eligible = admissionPredicate(authority, attempt.id);
  const result = await execute(db, `INSERT INTO runner_slot_reservations(attempt_id,runner_id,repo_id,account_id,generation,pool_id,
    runner_credential_generation,runner_credential_hash,credential_id,credential_revision,authority_epoch,authority_policy_revision,runner_revision,pool_revision,slot_limit,disposable,
    fence,state,expires_at,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reserved',?,?,? WHERE ${eligible.sql}
    ON CONFLICT(attempt_id) DO UPDATE SET runner_id=excluded.runner_id,pool_id=excluded.pool_id,runner_credential_generation=excluded.runner_credential_generation,
      runner_credential_hash=excluded.runner_credential_hash,credential_id=excluded.credential_id,credential_revision=excluded.credential_revision,
      authority_epoch=excluded.authority_epoch,authority_policy_revision=excluded.authority_policy_revision,runner_revision=excluded.runner_revision,pool_revision=excluded.pool_revision,
      slot_limit=excluded.slot_limit,disposable=excluded.disposable,fence=excluded.fence,state='reserved',expires_at=excluded.expires_at,updated_at=excluded.updated_at
    WHERE runner_slot_reservations.assigned_at IS NULL AND runner_slot_reservations.repo_id=excluded.repo_id AND runner_slot_reservations.account_id=excluded.account_id
      AND runner_slot_reservations.generation=excluded.generation AND (runner_slot_reservations.state='closed'
        OR runner_slot_reservations.expires_at<=${databaseClock} OR runner_slot_reservations.runner_id=excluded.runner_id)`,
  attempt.id, runner.id, attempt.repo_id, attempt.account_id, attempt.generation, pool.id, runner.credential_generation, runner.credential_hash,
  authority.credential.id, authority.credential.revision, authority.witness.account.epoch, authority.witness.account.policy_revision, runner.revision, pool.revision,
  runner.disposable ? 1 : Math.min(runner.slots, pool.max_slots), runner.disposable, fence, expires, at, at, ...eligible.values);
  if (result.meta.changes !== 1) return null;
  return one<RunnerSlot>(identityPrimary(env), 'SELECT * FROM runner_slot_reservations WHERE attempt_id=? AND fence=?', attempt.id, fence);
}

export async function activateRunnerSlot(env: Bindings, attempt: AttemptRecord, runner: RunnerRecord, slot: RunnerSlot, leaseExpires: string): Promise<void> {
  if (!Number.isFinite(Date.parse(leaseExpires)) || leaseExpires <= now()) throw new ApiError(409, 'runner_slot_expired', 'The machine lease has already expired.');
  const authority = await loadRunnerAuthority(env, runner.id), current = await currentSlotAttempt(env, attempt), existing = await storedSlot(env, attempt.id);
  if (!existing || existing.generation !== attempt.generation || existing.fence !== slot.fence || !slotMatches(existing, authority)
    || authority.runner.credential_generation !== runner.credential_generation || authority.runner.credential_hash !== runner.credential_hash
    || current.runner_id !== runner.id || current.runner_slot_fence !== slot.fence || current.runner_credential_generation !== runner.credential_generation
    || current.runner_credential_hash !== runner.credential_hash || !current.runtime_id || !['admitting', 'leased', 'running'].includes(current.status)) throw new ApiError(409, 'runner_slot_changed', 'The machine slot no longer matches its original allocation intent.');
  if (existing.state === 'leased') return;
  const db = identityPrimary(env), at = now(), eligible = admissionPredicate(authority, attempt.id);
  await guardedBatch(db, stmt(db, `UPDATE runner_slot_reservations SET state='leased',expires_at=?,assigned_at=?,updated_at=?
    WHERE attempt_id=? AND generation=? AND runner_id=? AND fence=? AND state='reserved' AND assigned_at IS NULL AND expires_at>${databaseClock}
      AND runner_credential_generation=? AND runner_credential_hash=? AND credential_id=? AND credential_revision=? AND ${eligible.sql}`,
  leaseExpires, at, at, attempt.id, attempt.generation, runner.id, slot.fence, runner.credential_generation, runner.credential_hash, authority.credential.id, authority.credential.revision, ...eligible.values), [
    stmt(db, `INSERT INTO runner_disposable_consumption(runner_id,attempt_id,account_id,generation,credential_generation,consumed_at) SELECT ?,?,?,?,?,? WHERE ?=1`,
      runner.id, attempt.id, runner.account_id, attempt.generation, runner.credential_generation, at, authority.runner.disposable),
    stmt(db, "UPDATE runner_job_offers SET state='closed',updated_at=? WHERE attempt_id=? AND generation=?", at, attempt.id, attempt.generation),
  ]);
}

export async function releaseUnassignedRunnerSlot(env: Bindings, attemptId: string): Promise<void> {
  await execute(identityPrimary(env), "UPDATE runner_slot_reservations SET state='closed',updated_at=? WHERE attempt_id=? AND state='reserved' AND assigned_at IS NULL", now(), attemptId);
}

async function closeOffer(env: Bindings, attempt: Pick<AttemptRecord, 'id' | 'generation'>): Promise<void> {
  await execute(identityPrimary(env), "UPDATE runner_job_offers SET state='closed',updated_at=? WHERE attempt_id=? AND generation=?", now(), attempt.id, attempt.generation);
}

function matchesCleanup(slot: StoredRunnerSlot, proof: CleanupProof | null): proof is CleanupProof {
  const legacy = slot.fence === `legacy:${slot.attempt_id}`;
  return !!proof && proof.id === slot.attempt_id && proof.repo_id === slot.repo_id && proof.account_id === slot.account_id && proof.executor === 'self_hosted'
    && proof.runner_id === slot.runner_id && proof.generation === slot.generation && (proof.runner_slot_fence === slot.fence || legacy && proof.runner_slot_fence === null)
    && (slot.runner_credential_generation === null ? legacy : proof.runner_credential_generation === slot.runner_credential_generation)
    && (slot.runner_credential_hash === null ? legacy : proof.runner_credential_hash === slot.runner_credential_hash)
    && proof.cleanup_state === 'verified' && TERMINAL_ATTEMPTS.has(proof.status) && !!proof.destruction_verified_at
    && !!proof.receipt_hash && /^(?:sha256:)?[a-f0-9]{64}$/.test(proof.receipt_hash);
}

async function journalCleanup(env: Bindings, slot: StoredRunnerSlot): Promise<StoredRunnerSlot> {
  if (slot.cleanup_proof_hash && slot.cleanup_proof_json && slot.cleanup_verified_at) {
    let proof: { attempt: CleanupProof };
    try { proof = JSON.parse(slot.cleanup_proof_json) as typeof proof; }
    catch { throw new ApiError(503, 'runner_cleanup_corrupt', 'The retained runner cleanup receipt is invalid.'); }
    if (await sha256(slot.cleanup_proof_json) !== slot.cleanup_proof_hash || !matchesCleanup(slot, proof.attempt)) throw new ApiError(503, 'runner_cleanup_corrupt', 'The retained runner cleanup receipt does not match its allocation.');
    return slot;
  }
  const placement = await runnerResourcePlacement(env, slot.attempt_id, 'attempt');
  if (placement.locator.authority !== 'repository' || placement.locator.repo_id !== slot.repo_id) throw new ApiError(409, 'runner_cleanup_unverified', 'Cleanup must be confirmed by the attempt’s actual repository placement.');
  const proof = await runnerMetadataRequest<CleanupProof | null>(env, placement, { action: 'cleanup-proof', generation: slot.generation });
  if (!matchesCleanup(slot, proof)) throw new ApiError(409, 'runner_cleanup_unverified', 'A leased machine slot remains occupied until its original allocation has verified cleanup.');
  const json = canonicalJson({ attempt: proof, location: placement.location, epoch: placement.epoch }), hash = await sha256(json);
  const db = identityPrimary(env);
  await guardedBatch(db, stmt(db, `UPDATE runner_slot_reservations SET cleanup_proof_json=?,cleanup_proof_hash=?,cleanup_verified_at=?,updated_at=?
    WHERE attempt_id=? AND generation=? AND runner_id=? AND fence=? AND state='leased' AND cleanup_proof_hash IS NULL`,
  json, hash, proof.destruction_verified_at, now(), slot.attempt_id, slot.generation, slot.runner_id, slot.fence), []);
  return { ...slot, cleanup_proof_json: json, cleanup_proof_hash: hash, cleanup_verified_at: proof.destruction_verified_at };
}

/** Expiry is not cleanup. Disposable retirement completes before the slot closes. */
export async function closeRunnerSlot(env: Bindings, attempt: Pick<AttemptRecord, 'id' | 'generation'>): Promise<void> {
  let slot = await storedSlot(env, attempt.id);
  if (!slot) { await closeOffer(env, attempt); return; }
  if (slot.generation !== attempt.generation) throw new ApiError(409, 'runner_slot_changed', 'The slot belongs to another attempt generation.');
  if (slot.assigned_at === null && slot.state !== 'leased') {
    const released = await execute(identityPrimary(env), "UPDATE runner_slot_reservations SET state='closed',updated_at=? WHERE attempt_id=? AND generation=? AND assigned_at IS NULL AND state<>'leased'", now(), attempt.id, attempt.generation);
    if (released.meta.changes === 1) { await closeOffer(env, attempt); return; }
    slot = (await storedSlot(env, attempt.id))!;
  }
  slot = await journalCleanup(env, slot);
  const disposable = slot.credential_id !== null ? Boolean(slot.disposable) : Boolean((await readRunnerRecord(env, slot.runner_id)).disposable);
  if (disposable) await retireDisposableRunner(env, slot.attempt_id, slot.generation);
  // An exact cleanup acknowledgement is read-only after both durable effects.
  if (slot.state === 'closed') return;
  const db = identityPrimary(env);
  await guardedBatch(db, stmt(db, `UPDATE runner_slot_reservations SET state='closed',updated_at=? WHERE attempt_id=? AND generation=? AND runner_id=? AND fence=?
    AND state IN ('leased','closed') AND cleanup_proof_hash=? AND cleanup_verified_at IS NOT NULL`,
  now(), slot.attempt_id, slot.generation, slot.runner_id, slot.fence, slot.cleanup_proof_hash), [
    stmt(db, "UPDATE runner_job_offers SET state='closed',updated_at=? WHERE attempt_id=? AND generation=?", now(), attempt.id, attempt.generation),
  ]);
}

export async function activeRunnerSlots(env: Bindings, runnerId: string): Promise<RunnerSlot[]> {
  return many<RunnerSlot>(identityPrimary(env), `SELECT * FROM runner_slot_reservations WHERE runner_id=?
    AND (state='leased' OR state='reserved' AND expires_at>${databaseClock}) ORDER BY created_at,attempt_id`, runnerId);
}
