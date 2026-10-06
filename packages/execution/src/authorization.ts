import { Context } from 'hono';
import { ApiError, authorize, credentialIsCurrent, credentialScope, mutationStatements, now, one, principalForExplanation, resolveRepositoryPlacement, selectRepositoryDatabase, stmt } from '@gitknot/core';
import type { AppContext, AppEnv, Bindings, CredentialRecord, Principal } from '@gitknot/core';
import { guardedBatch, identityPrimary, primary } from './store.ts';
import type { AttemptContext, ExecutionPlan } from './types.ts';
import { bindRunnerAuthority } from './runner-authority.ts';
import type { RunnerAuthorityWitness } from './runner-authority.ts';
import { restrictFederatedPrincipal } from '@gitknot/federation/integration';
import { authorizeExecutionAudience, executionAudience } from './reads.ts';

export function executionContext(env: Bindings, principal: Principal | null): AppContext {
  const context = new Context<AppEnv>(new Request('https://internal.gitknot.com/internal/execution/policy', { method: 'POST' }), { env });
  context.set('principal', principal); context.set('requestId', crypto.randomUUID()); context.set('database', primary(env));
  return context;
}

export async function repositoryExecutionContext(env: Bindings, principal: Principal | null, repoId: string): Promise<AppContext> {
  const context = executionContext(env, principal), placement = await resolveRepositoryPlacement(env, repoId);
  if (!placement) throw new ApiError(404, 'not_found', 'The execution repository was not found.');
  selectRepositoryDatabase(context, placement);
  context.set('routing', { resource_id: repoId, cell_id: placement.cell_id, shard_id: placement.shard_id, epoch: placement.epoch });
  return context;
}

export async function currentExecutionActor(env: Bindings, actor: ExecutionPlan['actor']): Promise<Principal> {
  const db = identityPrimary(env), principal = await principalForExplanation(db, actor.id);
  if (!principal || principal.kind !== actor.kind || principal.user_id !== actor.user_id) throw new ApiError(403, 'execution_actor_revoked', 'The initiating execution identity is no longer active.');
  if (!actor.credential_id) return principal;
  const credential = await one<CredentialRecord>(db, 'SELECT * FROM credentials WHERE id=? AND principal_id=?', actor.credential_id, actor.id);
  if (!credential || !await credentialIsCurrent(db, credential)) throw new ApiError(403, 'execution_actor_revoked', 'The initiating execution credential is no longer current.');
  const restricted = await restrictFederatedPrincipal(db, { ...principal, credential_id: credential.id, capabilities: credentialScope(credential.capabilities_json),
    repository_ids: credentialScope(credential.repository_ids_json), account_ids: credentialScope(credential.account_ids_json), mfa: credential.mfa === 1 });
  if (!restricted) throw new ApiError(403, 'execution_actor_revoked', 'The initiating federation authorization is no longer current.');
  return restricted;
}

export async function authorizeExecutionActor(env: Bindings, plan: ExecutionPlan): Promise<AppContext> {
  const actor = await currentExecutionActor(env, plan.actor);
  const context = await repositoryExecutionContext(env, actor, plan.repo_id);
  await authorize(context, 'workflows.run', { repo_id: plan.repo_id, ref: plan.source_ref });
  await authorizeExecutionAudience(context, plan.repo_id, executionAudience(plan), 'workflows.run');
  return context;
}

/** Fence a captured actor/policy decision before a raw Worker performs external I/O. */
export async function fenceExecutionAuthority(env: Bindings, attempt: AttemptContext, authority: AppContext, phase: string): Promise<void> {
  const a = attempt.attempt, db = primary(env);
  await guardedBatch(db, stmt(db, `UPDATE execution_attempts SET revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND generation=?
    AND status IN ('accepted','admitting','leased','running') AND EXISTS (SELECT 1 FROM workflow_jobs j WHERE j.id=execution_attempts.job_id AND j.current_attempt_id=execution_attempts.id AND j.generation=execution_attempts.generation)
    AND EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id=execution_attempts.run_id AND r.status NOT IN ('cancelling','cancelled'))`, now(), a.id, a.repo_id, a.generation), [], {
    context: authority, event: { type: 'execution.authority.used', resource_id: a.id, resource_revision: a.revision + 1, repo_id: a.repo_id, account_id: a.account_id,
      data: { run_id: a.run_id, generation: a.generation, phase } },
  });
}

/** Preserve the machine/pool observation across Worker I/O and metadata transactions. */
export async function machineAuthorityStatements(env: Bindings, context: AttemptContext, witness: RunnerAuthorityWitness | undefined, phase: string): Promise<D1PreparedStatement[]> {
  if (!witness) {
    if (context.attempt.executor === 'self_hosted') throw new ApiError(401, 'attempt_fenced', 'A captured current machine authority is required.');
    return [];
  }
  const a = context.attempt;
  if (a.executor !== 'self_hosted' || a.runner_id !== witness.runner_id || a.runner_credential_generation !== witness.credential_generation
    || a.account_id !== witness.account.account_id || a.pool_id !== witness.pool_id || a.runner_credential_hash && a.runner_credential_hash !== witness.credential_hash) {
    throw new ApiError(409, 'attempt_fenced', 'The machine authority witness does not belong to this allocation.');
  }
  const authority = await repositoryExecutionContext(env, { id: witness.runner_id, kind: 'runner', user_id: null, credential_id: witness.credential_id,
    capabilities: ['runners.poll', 'runners.heartbeat'], account_ids: [a.account_id], repository_ids: [a.repo_id], mfa: false }, a.repo_id);
  await bindRunnerAuthority(authority, witness);
  if (!authority.get('mutation_authority')?.credential_versions.some(credential => credential.id === witness.credential_id && credential.revision === witness.credential_revision)) {
    throw new ApiError(409, 'attempt_fenced', 'The original machine credential changed before publication.');
  }
  return mutationStatements(authority, { statements: [], event: { type: 'execution.machine_authority.used', resource_id: a.id, resource_revision: a.revision,
    repo_id: a.repo_id, account_id: a.account_id, data: { generation: a.generation, phase } } });
}

export async function fenceMachineAuthority(env: Bindings, context: AttemptContext, phase: string): Promise<void> {
  const statements = await machineAuthorityStatements(env, context, context.machine_authority, phase);
  if (statements.length) await primary(env).batch(statements);
}

export async function currentApprover(env: Bindings, repoId: string, actorId: string, credentialId?: string | null): Promise<boolean> {
  return await currentApproverAuthority(env, repoId, actorId, credentialId) !== null;
}

export async function currentApproverAuthority(env: Bindings, repoId: string, actorId: string, credentialId?: string | null): Promise<AppContext | null> {
  let principal = await principalForExplanation(identityPrimary(env), actorId);
  if (!principal) return null;
  try {
    if (credentialId) principal = await currentExecutionActor(env, { id: principal.id, kind: principal.kind, user_id: principal.user_id, credential_id: credentialId });
    const context = await repositoryExecutionContext(env, principal, repoId);
    await authorize(context, 'environments.approve', { repo_id: repoId }); return context;
  }
  catch (error) { if (error instanceof ApiError && error.status < 500) return null; throw error; }
}
