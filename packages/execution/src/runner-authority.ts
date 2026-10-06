import { Context } from 'hono';
import { ApiError, authorize, captureMutationAuthority, credentialIsCurrent, credentialScope, currentAccountAuthority, identityDatabaseLocation, now, one, ownedAccountAuthority, readRepositoryAuthority, registerRepositoryPlacement, resolveRepositoryPlacement, sameDatabaseLocation, selectIdentityDatabase, withAccountAuthorityBarrier } from '@gitknot/core';
import type { AccountAuthorityVersion, AppContext, AppEnv, Bindings, CredentialRecord, Principal } from '@gitknot/core';
import { identityPrimary } from './store.ts';
import type { RunnerPool, RunnerRecord } from './types.ts';
import { assertRunnerRequestPlacement, runnerMetadataRequest, runnerResourcePlacement, sameRunnerDatabase, sameRunnerPlacement, type RunnerPlacement } from './runner-placement.ts';
import { databaseClock } from './runner-guards.ts';

export { databaseClock } from './runner-guards.ts';
export { reconcileRunnerState, reconcileRunnerAuthorityChanges } from './runner-retirement.ts';

export interface RunnerAuthorityWitness {
  runner_id: string; credential_id: string; credential_hash: string; credential_generation: number; credential_revision: number;
  runner_revision: number; pool_id: string; pool_revision: number; account: AccountAuthorityVersion;
}
export interface RunnerAuthority { runner: RunnerRecord; pool: RunnerPool; credential: CredentialRecord; witness: RunnerAuthorityWitness }

export function runnerIdentityContext(env: Bindings, principal: Principal | null = null): AppContext {
  const context = new Context<AppEnv>(new Request('https://internal.gitknot.com/internal/execution/runners/authority', { method: 'POST' }), { env });
  context.set('principal', principal); context.set('requestId', crypto.randomUUID()); selectIdentityDatabase(context);
  return context;
}

export async function readRunnerRecord(env: Bindings, id: string): Promise<RunnerRecord> {
  const placement = await runnerResourcePlacement(env, id, 'runner');
  const runner = await runnerMetadataRequest<RunnerRecord | null>(env, placement, { action: 'read' });
  if (!runner || runner.id !== id) throw new ApiError(404, 'not_found', 'The enrolled machine was not found.');
  const consumed = await one<{ attempt_id: string; consumed_at: string }>(identityPrimary(env), 'SELECT attempt_id,consumed_at FROM runner_disposable_consumption WHERE runner_id=?', id);
  return consumed ? { ...runner, assignment_attempt_id: consumed.attempt_id, disposable_consumed_at: consumed.consumed_at } : runner;
}

export async function readRunnerPool(env: Bindings, id: string): Promise<RunnerPool> {
  const placement = await runnerResourcePlacement(env, id, 'runner_pool');
  const pool = await runnerMetadataRequest<RunnerPool | null>(env, placement, { action: 'read' });
  if (!pool || pool.id !== id) throw new ApiError(404, 'not_found', 'The runner pool was not found.');
  return pool;
}

/** Scope is reread from current repository authority, never a catalog seed on the metadata database. */
export async function assertRunnerPoolScope(env: Bindings, pool: RunnerPool, active = true): Promise<void> {
  const account = await one<{ disabled_at: string | null }>(identityPrimary(env), 'SELECT disabled_at FROM accounts WHERE id=?', pool.account_id);
  if (!account || account.disabled_at !== null || active && pool.state !== 'active') throw new ApiError(403, 'pool_disabled', 'The owning account or runner pool is unavailable.');
  const location = await runnerResourcePlacement(env, pool.id, 'runner_pool');
  for (const repoId of new Set([pool.repo_id, location.locator.authority === 'repository' ? location.locator.repo_id : null].filter((id): id is string => id !== null))) {
    const placement = await resolveRepositoryPlacement(env, repoId);
    const repository = await readRepositoryAuthority(runnerIdentityContext(env), repoId);
    if (!repository || repository.owner_id !== pool.account_id) throw new ApiError(404, 'runner_pool_scope_changed', 'The repository no longer belongs to this runner pool account. Re-enroll in a currently owned pool.');
    if (active && (repository.state !== 'active' || placement?.state !== 'active')) throw new ApiError(409, 'repository_unavailable', 'The scoped repository cannot admit runner execution.');
  }
}

export async function authorizeRunnerPool(c: AppContext, id: string): Promise<RunnerPool> {
  assertRunnerRequestPlacement(c, await runnerResourcePlacement(c.env, id, 'runner_pool'));
  const pool = await readRunnerPool(c.env, id);
  await assertRunnerPoolScope(c.env, pool, false);
  const decision = await authorize(c, 'runners.manage', pool.repo_id ? { repo_id: pool.repo_id } : { account_id: pool.account_id });
  if (decision.account_id !== pool.account_id) throw new ApiError(404, 'runner_pool_scope_changed', 'The repository no longer belongs to this runner pool account.');
  await assertRunnerPoolScope(c.env, pool, false);
  return pool;
}

export async function enrollRunnerMetadataAuthority(env: Bindings, placement: RunnerPlacement, accountId: string): Promise<void> {
  if (placement.locator.authority !== 'repository' || sameRunnerDatabase(env, placement)) return;
  // Existing permanent enrollment also permits cleanup after account disablement.
  if (await one(identityPrimary(env), `SELECT 1 FROM account_authority_repositories WHERE account_id=? AND repo_id=? AND cell_id=? AND shard_id=? AND epoch=?`,
    accountId, placement.locator.repo_id, placement.location.cell_id, placement.location.shard_id, placement.epoch)) return;
  await registerRepositoryPlacement(env, { repo_id: placement.locator.repo_id!, account_id: accountId, ...placement.location, epoch: placement.epoch! });
}

/** All safety-changing HTTP pool/machine mutations must call this wrapper. */
export async function withRunnerAuthorityChange<T>(c: AppContext, poolId: string, action: () => Promise<T>): Promise<T> {
  const pool = await authorizeRunnerPool(c, poolId);
  const placement = await runnerResourcePlacement(c.env, pool.id, 'runner_pool');
  await enrollRunnerMetadataAuthority(c.env, placement, pool.account_id);
  return withAccountAuthorityBarrier(c, pool.account_id, `runner-authority:${pool.id}`, async () => {
    const fence = ownedAccountAuthority(c, pool.account_id);
    if (!fence) throw new ApiError(503, 'runner_authority_unconfirmed', 'The machine account fence could not be established.');
    const current = await readRunnerPool(c.env, pool.id);
    if (current.revision !== pool.revision) throw new ApiError(409, 'runner_pool_changed', 'The runner pool changed before the account fence was acquired.');
    await assertRunnerPoolScope(c.env, current, false);
    const { enqueueRunnerAuthorityReconciliation, reconcileRunnerPoolState } = await import('./runner-retirement.ts');
    const intent = await enqueueRunnerAuthorityReconciliation(c.env, pool, fence);
    const result = await action();
    await reconcileRunnerPoolState(c.env, intent, fence);
    return result;
  });
}

export async function loadRunnerAuthority(env: Bindings, runnerId: string): Promise<RunnerAuthority> {
  let runner = await readRunnerRecord(env, runnerId);
  const placement = await runnerResourcePlacement(env, runnerId, 'runner');
  await enrollRunnerMetadataAuthority(env, placement, runner.account_id);
  const account = await currentAccountAuthority(env, runner.account_id);
  runner = await readRunnerRecord(env, runnerId);
  const pool = await readRunnerPool(env, runner.pool_id);
  const poolPlacement = await runnerResourcePlacement(env, pool.id, 'runner_pool');
  if (!sameRunnerPlacement(placement, poolPlacement)) throw new ApiError(409, 'runner_placement_mismatch', 'The machine and its pool do not share their declared metadata authority.');
  if (runner.account_id !== account.account_id || pool.account_id !== runner.account_id || runner.repo_id !== pool.repo_id || runner.state !== 'active' || runner.credential_expires_at <= now()) throw new ApiError(401, 'runner_revoked', 'The enrolled machine is no longer current.');
  await assertRunnerPoolScope(env, pool);
  const db = identityPrimary(env);
  const credential = await one<CredentialRecord>(db, 'SELECT * FROM credentials WHERE principal_id=? AND token_hash=? AND kind=?', runner.id, runner.credential_hash, 'runner');
  const principal = await one<{ account_id: string; kind: string }>(db, 'SELECT account_id,kind FROM principals WHERE id=?', runner.id);
  if (!credential || principal?.account_id !== runner.account_id || principal.kind !== 'runner' || !await credentialIsCurrent(db, credential)) throw new ApiError(401, 'runner_revoked', 'The primary machine credential has been revoked or expired.');
  if (await one(identityPrimary(env), 'SELECT runner_id FROM runner_retirements WHERE runner_id=?', runner.id)) throw new ApiError(401, 'runner_revoked', 'The machine is being permanently retired.');
  if (await one(identityPrimary(env), 'SELECT exchange_id FROM runner_credential_exchange_locks WHERE runner_id=?', runner.id)) throw new ApiError(409, 'runner_exchange_pending', 'A durable machine credential exchange is still pending.');
  const current = await currentAccountAuthority(env, account.account_id);
  if (current.epoch !== account.epoch || current.policy_revision !== account.policy_revision
    || !sameRunnerPlacement(placement, await runnerResourcePlacement(env, runnerId, 'runner'))) throw new ApiError(409, 'runner_authority_changed', 'Runner authority changed during validation.');
  return { runner, pool, credential, witness: { runner_id: runner.id, credential_id: credential.id, credential_hash: credential.token_hash, credential_generation: runner.credential_generation,
    credential_revision: credential.revision, runner_revision: runner.revision, pool_id: pool.id, pool_revision: pool.revision, account } };
}

export function runnerPrincipal(authority: RunnerAuthority): Principal {
  const c = authority.credential;
  return { id: authority.runner.id, kind: 'runner', user_id: null, credential_id: c.id, capabilities: credentialScope(c.capabilities_json), repository_ids: credentialScope(c.repository_ids_json), account_ids: credentialScope(c.account_ids_json), mfa: false };
}

/** Bind the OLD witness before final mutationStatements; never refresh a stale pool/runner observation. */
export async function bindRunnerAuthority(c: AppContext, witness: RunnerAuthorityWitness): Promise<void> {
  const actor = c.get('principal');
  if (actor?.id !== witness.runner_id || actor.credential_id !== witness.credential_id) throw new ApiError(401, 'runner_authority_mismatch', 'The machine authority witness belongs to another credential.');
  const authority = await captureMutationAuthority(c);
  if (witness.account.phase !== 'active' || witness.account.barrier_id !== null
    || !authority.credential_versions.some(credential => credential.id === witness.credential_id && credential.revision === witness.credential_revision)) throw new ApiError(409, 'runner_authority_changed', 'The original machine credential changed before publication.');
  const current = await currentAccountAuthority(c.env, witness.account.account_id);
  const prior = authority.account_versions?.find(version => version.account_id === current.account_id);
  if (current.epoch !== witness.account.epoch || current.policy_revision !== witness.account.policy_revision
    || prior && (prior.epoch !== witness.account.epoch || prior.policy_revision !== witness.account.policy_revision)) throw new ApiError(409, 'runner_authority_changed', 'Machine or pool authority changed before publication.');
  if (!prior) (authority.account_versions ??= []).push(structuredClone(witness.account));
}

export function identityRunnerPredicate(witness: RunnerAuthorityWitness): { sql: string; values: unknown[] } {
  return { sql: `EXISTS (SELECT 1 FROM credentials c JOIN principals p ON p.id=c.principal_id JOIN accounts a ON a.id=p.account_id
    JOIN account_authority_epochs e ON e.account_id=a.id WHERE c.id=? AND c.principal_id=? AND c.token_hash=? AND c.revision=?
      AND c.kind='runner' AND c.parent_id IS NULL AND c.revoked_at IS NULL AND c.expires_at>${databaseClock} AND p.kind='runner' AND p.disabled_at IS NULL
      AND (p.expires_at IS NULL OR p.expires_at>${databaseClock}) AND a.id=? AND a.disabled_at IS NULL AND e.epoch=? AND e.phase='active'
      AND a.policy_revision=? AND e.policy_revision=a.policy_revision
      AND NOT EXISTS (SELECT 1 FROM account_policy_barriers b WHERE b.account_id=a.id))
    AND NOT EXISTS (SELECT 1 FROM runner_credential_exchange_locks WHERE runner_id=?)
    AND NOT EXISTS (SELECT 1 FROM runner_retirements WHERE runner_id=?)`, values: [witness.credential_id, witness.runner_id, witness.credential_hash,
    witness.credential_revision, witness.account.account_id, witness.account.epoch, witness.account.policy_revision, witness.runner_id, witness.runner_id] };
}

export async function assertRunnerFence(env: Bindings, accountId: string, fence: AccountAuthorityVersion): Promise<void> {
  const row = await one<AccountAuthorityVersion>(identityPrimary(env), `SELECT e.* FROM account_authority_epochs e JOIN account_policy_barriers b ON b.account_id=e.account_id AND b.id=e.barrier_id
    WHERE e.account_id=? AND NOT EXISTS (SELECT 1 FROM account_authority_placements p WHERE p.account_id=e.account_id AND (p.acknowledged_epoch<>e.epoch OR p.acknowledged_phase IS NOT 'fenced'))`, accountId);
  if (fence.account_id !== accountId || fence.phase !== 'fenced' || row?.phase !== 'fenced' || row.epoch !== fence.epoch
    || row.policy_revision !== fence.policy_revision || row.barrier_id !== fence.barrier_id) throw new ApiError(409, 'runner_authority_changed', 'The runner account fence is no longer current.');
}

export function runnerFencePredicate(env: Bindings, placement: RunnerPlacement, fence: AccountAuthorityVersion): { sql: string; values: unknown[] } {
  const local = sameDatabaseLocation(identityDatabaseLocation(env), placement.location);
  const table = local ? 'account_authority_epochs' : 'account_authority_fences';
  return { sql: `EXISTS (SELECT 1 FROM ${table} e WHERE account_id=? AND epoch=? AND policy_revision=? AND phase='fenced' AND barrier_id=?${local
    ? " AND EXISTS (SELECT 1 FROM account_policy_barriers b WHERE b.account_id=e.account_id AND b.id=e.barrier_id) AND NOT EXISTS (SELECT 1 FROM account_authority_placements p WHERE p.account_id=e.account_id AND (p.acknowledged_epoch<>e.epoch OR p.acknowledged_phase IS NOT 'fenced'))" : ''})`,
  values: [fence.account_id, fence.epoch, fence.policy_revision, fence.barrier_id] };
}
