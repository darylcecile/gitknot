import { currentPolicyBarrier, inPolicyBarrier } from '../auth.ts';
import { canonicalJson, newId, now } from '../crypto.ts';
import { execute, many, one, stmt } from '../db.ts';
import { ApiError } from '../errors.ts';
import { cellDatabase, maximumPlacements, routingRpc, validPlacementId } from '../routing/cells.ts';
import type { AccountAuthorityVersion, AppContext, Bindings, Database } from '../types.ts';
import { identityBinding, separateIdentityAuthority } from './identity.ts';

interface AuthorityEpoch extends Omit<AccountAuthorityVersion, 'phase'> {
  phase: 'active' | 'fencing' | 'fenced' | 'releasing';
}
interface Placement { cell_id: string; shard_id: string }
export interface RepositoryAuthorityPlacement extends Placement { repo_id: string; account_id: string; epoch: number }
const ownedFences = new WeakMap<AppContext, Map<string, AccountAuthorityVersion>>();

function changed(): ApiError {
  return new ApiError(409, 'account_authority_changed', 'The account authority changed. Retry against its current state.');
}
function pending(): ApiError {
  return new ApiError(409, 'account_policy_pending', 'An account access change is being coordinated. Retry shortly.');
}

async function checkedBatch(db: Database, statements: D1PreparedStatement[]): Promise<void> {
  try { await db.batch(statements); }
  catch (error) {
    if (/mutation_requires_one_row|account_authority_epoch_regression/.test(String(error))) throw changed();
    throw error;
  }
}

function condition(db: Database, sql: string, ...values: unknown[]): D1PreparedStatement[] {
  const id = newId('guard');
  return [stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN ${sql} THEN 1 ELSE 0 END`, id, ...values),
    stmt(db, 'DELETE FROM mutation_guards WHERE id=?', id)];
}

async function epochRecord(env: Bindings, accountId: string): Promise<AuthorityEpoch> {
  const db = identityBinding(env).withSession('first-primary');
  let record = await one<AuthorityEpoch>(db, 'SELECT * FROM account_authority_epochs WHERE account_id=?', accountId);
  if (!record) {
    await execute(db, `INSERT INTO account_authority_epochs(account_id,epoch,policy_revision,phase,updated_at)
      SELECT id,1,policy_revision,'active',? FROM accounts WHERE id=? ON CONFLICT(account_id) DO NOTHING`, now(), accountId);
    record = await one<AuthorityEpoch>(db, 'SELECT * FROM account_authority_epochs WHERE account_id=?', accountId);
  }
  if (!record) throw new ApiError(404, 'not_found', 'The requested account was not found.');
  return record;
}

function version(record: AuthorityEpoch, phase: AccountAuthorityVersion['phase']): AccountAuthorityVersion {
  return { account_id: record.account_id, epoch: record.epoch, policy_revision: record.policy_revision,
    phase, barrier_id: phase === 'active' ? null : record.barrier_id };
}

/** Fresh primary snapshot; a changed policy can never be attached to an old epoch. */
export async function currentAccountAuthority(env: Bindings, accountId: string): Promise<AccountAuthorityVersion> {
  await epochRecord(env, accountId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const db = identityBinding(env).withSession('first-primary');
    const row = await one<AuthorityEpoch & { current_revision: number; disabled_at: string | null; pending_id: string | null }>(db,
      `SELECT e.*,a.policy_revision AS current_revision,a.disabled_at,b.id AS pending_id FROM account_authority_epochs e
        JOIN accounts a ON a.id=e.account_id LEFT JOIN account_policy_barriers b ON b.account_id=e.account_id WHERE e.account_id=?`, accountId);
    if (!row || row.disabled_at !== null) throw new ApiError(404, 'not_found', 'The requested account was not found.');
    if (row.phase !== 'active' || row.pending_id !== null) throw pending();
    if (row.current_revision === row.policy_revision) return version(row, 'active');
    // No enrolled writer means the account still has the original single-D1
    // authority. Adopt its current revision with a monotonic epoch, atomically.
    await checkedBatch(db, [
      ...condition(db, `NOT EXISTS (SELECT 1 FROM account_authority_placements WHERE account_id=?)`, accountId),
      stmt(db, `UPDATE account_authority_epochs SET epoch=epoch+1,policy_revision=?,updated_at=?
        WHERE account_id=? AND epoch=? AND phase='active' AND NOT EXISTS (SELECT 1 FROM account_policy_barriers WHERE account_id=?)`,
      row.current_revision, now(), accountId, row.epoch, accountId),
    ]);
  }
  throw changed();
}

export function ownedAccountAuthority(c: AppContext, accountId: string): AccountAuthorityVersion | undefined {
  const fence = ownedFences.get(c)?.get(accountId);
  return fence && currentPolicyBarrier(c, accountId) === fence.barrier_id ? fence : undefined;
}

/** Retain the first account epoch for this request, never refresh an old grant. */
export async function captureAccountAuthority(c: AppContext, accountId: string, policyRevision?: number | null): Promise<AccountAuthorityVersion> {
  const authority = c.get('mutation_authority');
  const owned = ownedAccountAuthority(c, accountId);
  const prior = authority?.account_versions?.find(item => item.account_id === accountId);
  const captured = owned ?? prior ?? await currentAccountAuthority(c.env, accountId);
  if (policyRevision != null && captured.policy_revision !== policyRevision) throw changed();
  if (!prior && captured.phase === 'active' && separateIdentityAuthority(c)) {
    const placement = c.get('routing');
    if (!placement) throw new ApiError(503, 'routing_unavailable', 'This repository mutation has no current placement.');
    await registerAccountAuthorityPlacement(c.env, accountId, placement, captured);
  }
  if (authority && !prior) (authority.account_versions ??= []).push(captured);
  return captured;
}

export async function installAccountAuthorityFence(env: Bindings, shardId: string, fence: AccountAuthorityVersion): Promise<AccountAuthorityVersion> {
  const db = cellDatabase(env, shardId).withSession('first-primary');
  try {
    await execute(db, `INSERT INTO account_authority_fences(account_id,epoch,policy_revision,phase,barrier_id,updated_at)
      VALUES (?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET epoch=excluded.epoch,policy_revision=excluded.policy_revision,
        phase=excluded.phase,barrier_id=excluded.barrier_id,updated_at=excluded.updated_at
      WHERE account_authority_fences.epoch<=excluded.epoch`, fence.account_id, fence.epoch, fence.policy_revision,
    fence.phase, fence.barrier_id, now());
  } catch (error) {
    if (/account_authority_epoch_regression/.test(String(error))) throw changed();
    throw error;
  }
  const receipt = await one<AccountAuthorityVersion>(db,
    'SELECT account_id,epoch,policy_revision,phase,barrier_id FROM account_authority_fences WHERE account_id=?', fence.account_id);
  if (canonicalJson(receipt) !== canonicalJson(fence)) throw changed();
  return receipt!;
}

async function installPlacement(env: Bindings, placement: Placement, fence: AccountAuthorityVersion): Promise<void> {
  let receipt: AccountAuthorityVersion;
  try {
    receipt = placement.cell_id === env.CELL_ID
      ? await installAccountAuthorityFence(env, placement.shard_id, fence)
      : await routingRpc<AccountAuthorityVersion>(env, placement.cell_id, { action: 'authority.install',
        cell_id: placement.cell_id, shard_id: placement.shard_id, fence });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'account_authority_unconfirmed', 'GitKnot could not confirm a repository placement authority fence. Retry the same request.');
  }
  if (canonicalJson(receipt) !== canonicalJson(fence)) {
    throw new ApiError(503, 'account_authority_unconfirmed', 'A repository placement did not acknowledge the account authority fence.');
  }
  const result = await execute(identityBinding(env), `UPDATE account_authority_placements SET acknowledged_epoch=?,acknowledged_phase=?,updated_at=?
    WHERE account_id=? AND cell_id=? AND shard_id=? AND EXISTS (
      SELECT 1 FROM account_authority_epochs WHERE account_id=? AND epoch=? AND policy_revision=?)`,
  fence.epoch, fence.phase, now(), fence.account_id, placement.cell_id, placement.shard_id, fence.account_id, fence.epoch, fence.policy_revision);
  if (result.meta.changes !== 1) throw changed();
}

async function placements(env: Bindings, accountId: string): Promise<Placement[]> {
  const result = await many<Placement>(identityBinding(env).withSession('first-primary'),
    'SELECT cell_id,shard_id FROM account_authority_placements WHERE account_id=? ORDER BY cell_id,shard_id LIMIT ?', accountId, maximumPlacements + 1);
  if (result.length > maximumPlacements) throw new ApiError(503, 'account_placements_unavailable', 'The account placement set exceeds the configured routing bound.');
  return result;
}

async function installEveryPlacement(env: Bindings, fence: AccountAuthorityVersion): Promise<void> {
  const targets = await placements(env, fence.account_id);
  for (let offset = 0; offset < targets.length; offset += 8) {
    // Await every acknowledgement, including failures, before a recovery phase
    // starts. A timed-out remote request is still fenced by monotonic epochs.
    const results = await Promise.allSettled(targets.slice(offset, offset + 8).map(target => installPlacement(env, target, fence)));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}

const allAcknowledged = `NOT EXISTS (SELECT 1 FROM account_authority_placements p WHERE p.account_id=account_authority_epochs.account_id
  AND (p.acknowledged_epoch<>account_authority_epochs.epoch OR p.acknowledged_phase IS NOT ?))`;

/** Call after creating the explicit account_policy_barriers row on IDENTITY_DB. */
export async function fenceAccountAuthority(c: AppContext, accountId: string, barrierId: string): Promise<AccountAuthorityVersion> {
  const db = identityBinding(c.env).withSession('first-primary');
  let record = await epochRecord(c.env, accountId);
  if (record.phase === 'active') {
    const result = await execute(db, `UPDATE account_authority_epochs SET epoch=epoch+1,
      policy_revision=(SELECT policy_revision FROM accounts WHERE id=?),phase='fencing',barrier_id=?,updated_at=?
      WHERE account_id=? AND epoch=? AND phase='active' AND EXISTS (SELECT 1 FROM account_policy_barriers WHERE account_id=? AND id=?)`,
    accountId, barrierId, now(), accountId, record.epoch, accountId, barrierId);
    if (result.meta.changes !== 1) throw changed();
    record = await epochRecord(c.env, accountId);
  }
  if (record.barrier_id !== barrierId || !['fencing', 'fenced'].includes(record.phase)) throw changed();
  const fence = version(record, 'fenced');
  await installEveryPlacement(c.env, fence);
  const result = await execute(db, `UPDATE account_authority_epochs SET phase='fenced',updated_at=?
    WHERE account_id=? AND epoch=? AND barrier_id=? AND phase IN ('fencing','fenced') AND ${allAcknowledged}
      AND EXISTS (SELECT 1 FROM account_policy_barriers WHERE account_id=? AND id=?)`,
  now(), accountId, fence.epoch, barrierId, 'fenced', accountId, barrierId);
  if (result.meta.changes !== 1) throw changed();
  const owned = ownedFences.get(c) ?? new Map<string, AccountAuthorityVersion>();
  owned.set(accountId, fence);
  ownedFences.set(c, owned);
  return fence;
}

/** An uncertain release remains closed on the primary and can be resumed. */
export async function releaseAccountAuthority(env: Bindings, accountId: string, barrierId: string): Promise<void> {
  const db = identityBinding(env).withSession('first-primary');
  let record = await epochRecord(env, accountId);
  if (record.phase === 'active' && record.barrier_id === null) {
    await execute(db, 'DELETE FROM account_policy_barriers WHERE account_id=? AND id=?', accountId, barrierId);
    return;
  }
  if (record.barrier_id !== barrierId) throw changed();
  if (record.phase !== 'releasing') {
    const result = await execute(db, `UPDATE account_authority_epochs SET epoch=epoch+1,
      policy_revision=(SELECT policy_revision FROM accounts WHERE id=?),phase='releasing',updated_at=?
      WHERE account_id=? AND epoch=? AND barrier_id=? AND phase IN ('fencing','fenced')`,
    accountId, now(), accountId, record.epoch, barrierId);
    if (result.meta.changes !== 1) throw changed();
    record = await epochRecord(env, accountId);
  }
  await installEveryPlacement(env, version(record, 'active'));
  const guard = newId('guard');
  await checkedBatch(db, [
    stmt(db, `UPDATE account_authority_epochs SET phase='active',barrier_id=NULL,updated_at=?
      WHERE account_id=? AND epoch=? AND barrier_id=? AND phase='releasing' AND ${allAcknowledged}`,
    now(), accountId, record.epoch, barrierId, 'active'),
    stmt(db, 'INSERT INTO mutation_guards(id,ok) VALUES (?,changes())', guard),
    stmt(db, 'DELETE FROM account_policy_barriers WHERE account_id=? AND id=?', accountId, barrierId),
    stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard),
  ]);
}

/** Reuse the existing account barrier; do not create a second lock domain. */
export async function withAccountAuthorityBarrier<T>(c: AppContext, accountId: string, reason: string, action: () => Promise<T>): Promise<T> {
  const existing = currentPolicyBarrier(c, accountId);
  if (existing) {
    if (!ownedAccountAuthority(c, accountId)) await fenceAccountAuthority(c, accountId, existing);
    return action();
  }
  const db = identityBinding(c.env).withSession('first-primary');
  const id = newId('policy_barrier');
  const account = await one<{ policy_revision: number }>(db, 'SELECT policy_revision FROM accounts WHERE id=?', accountId);
  if (!account) throw new ApiError(404, 'not_found', 'The requested account was not found.');
  await checkedBatch(db, [
    ...condition(db, `EXISTS (SELECT 1 FROM accounts WHERE id=? AND policy_revision=?)
      AND NOT EXISTS (SELECT 1 FROM account_policy_barriers WHERE account_id=?)`, accountId, account.policy_revision, accountId),
    stmt(db, `INSERT INTO account_policy_barriers(account_id,id,reason,previous_policy_revision,recover_after,created_at) VALUES (?,?,?,?,?,?)`,
      accountId, id, reason, account.policy_revision, new Date(Date.now() + 120_000).toISOString(), now()),
  ]);
  try {
    return await inPolicyBarrier(c, accountId, id, async () => {
      await fenceAccountAuthority(c, accountId, id);
      return action();
    });
  } finally {
    await releaseAccountAuthority(c.env, accountId, id);
    ownedFences.get(c)?.delete(accountId);
  }
}

/** Enrollment commits before installing a usable fence. Revocation serializes with it. */
export async function registerAccountAuthorityPlacement(env: Bindings, accountId: string, placement: Placement,
  captured?: AccountAuthorityVersion): Promise<AccountAuthorityVersion> {
  if (!validPlacementId(placement.cell_id) || !validPlacementId(placement.shard_id)) throw new TypeError('Invalid account authority placement.');
  const fence = captured ?? await currentAccountAuthority(env, accountId);
  if (fence.account_id !== accountId || fence.phase !== 'active' || fence.barrier_id !== null) throw pending();
  const db = identityBinding(env).withSession('first-primary');
  await checkedBatch(db, [
    ...condition(db, `EXISTS (SELECT 1 FROM account_authority_epochs e JOIN accounts a ON a.id=e.account_id
      WHERE e.account_id=? AND e.epoch=? AND e.phase='active' AND a.policy_revision=? AND a.disabled_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM account_policy_barriers WHERE account_id=?)`, accountId, fence.epoch, fence.policy_revision, accountId),
    ...condition(db, `(SELECT COUNT(*) FROM account_authority_placements WHERE account_id=?)<?
      OR EXISTS (SELECT 1 FROM account_authority_placements WHERE account_id=? AND cell_id=? AND shard_id=?)`,
    accountId, maximumPlacements, accountId, placement.cell_id, placement.shard_id),
    stmt(db, `INSERT INTO account_authority_placements(account_id,cell_id,shard_id,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(account_id,cell_id,shard_id) DO NOTHING`, accountId, placement.cell_id, placement.shard_id, now()),
  ]);
  await installPlacement(env, placement, fence);
  return fence;
}

export async function registerRepositoryPlacement(env: Bindings, placement: RepositoryAuthorityPlacement): Promise<void> {
  if (!Number.isSafeInteger(placement.epoch) || placement.epoch < 1 || !/^r_[A-Za-z0-9_-]+$/.test(placement.repo_id)) {
    throw new TypeError('Invalid repository authority placement.');
  }
  const fence = await registerAccountAuthorityPlacement(env, placement.account_id, placement);
  const db = identityBinding(env).withSession('first-primary');
  await checkedBatch(db, [
    ...condition(db, `EXISTS (SELECT 1 FROM account_authority_epochs WHERE account_id=? AND epoch=? AND phase='active')
      AND NOT EXISTS (SELECT 1 FROM account_policy_barriers WHERE account_id=?)`, placement.account_id, fence.epoch, placement.account_id),
    stmt(db, `INSERT INTO account_authority_repositories(account_id,repo_id,cell_id,shard_id,epoch,created_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(account_id,repo_id,cell_id,shard_id,epoch) DO NOTHING`,
    placement.account_id, placement.repo_id, placement.cell_id, placement.shard_id, placement.epoch, now()),
  ]);
}

export async function recoverAccountAuthorityBarriers(env: Bindings, limit = 50): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid authority recovery limit.');
  const rows = await many<{ account_id: string; id: string }>(identityBinding(env).withSession('first-primary'),
    'SELECT account_id,id FROM account_policy_barriers WHERE recover_after<=? ORDER BY account_id LIMIT ?', now(), limit);
  let recovered = 0;
  for (const row of rows) {
    try { await releaseAccountAuthority(env, row.account_id, row.id); recovered++; }
    catch (error) {
      if (!(error instanceof ApiError) || error.status < 409) throw error;
      // Keep the durable fence available for the next bounded recovery pass.
    }
  }
  return recovered;
}
