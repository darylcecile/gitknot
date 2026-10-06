import { ApiError, auditStatement, cellDatabase, eventStatement, execute, executeMutationBatch, identityAuthorityBindings, identityBinding, many, mutationGuard, mutationStatements, newId, one, requestDatabaseBinding, requestDatabaseLocation, resolveRepositoryPlacement, resolveResourceLocator, sha256, stmt } from '@gitknot/core';
import type { AppContext, AuditInput, Bindings, Database, EventInput, GlobalResourceType } from '@gitknot/core';
import type { AttemptContext, AttemptRecord, ExecutionPlan, JobRecord, PlanJob, RunRecord } from './types.ts';

export function primary(env: Pick<Bindings, 'DB'>): D1DatabaseSession { return env.DB.withSession('first-primary'); }
export function identityPrimary(env: Bindings): D1DatabaseSession { return identityBinding(env).withSession('first-primary'); }

export function executionRequestEnvironment(c: AppContext): Bindings {
  const location = requestDatabaseLocation(c);
  return { ...c.env, ...identityAuthorityBindings(c.env), ROOT_DB: c.env.ROOT_DB ?? c.env.DB, ROOT_CELL_ID: c.env.ROOT_CELL_ID ?? c.env.CELL_ID, ROOT_SHARD_ID: c.env.ROOT_SHARD_ID ?? c.env.SHARD_ID,
    DB: requestDatabaseBinding(c), CELL_ID: location.cell_id, SHARD_ID: location.shard_id };
}

export async function executionResourceEnvironment(env: Bindings, id: string, type: GlobalResourceType): Promise<Bindings> {
  const locator = await resolveResourceLocator(env, id, type);
  if (!locator?.repo_id || locator.authority !== 'repository') throw new ApiError(404, 'execution_resource_not_found', 'The repository execution resource was not found.');
  const placement = await resolveRepositoryPlacement(env, locator.repo_id);
  if (!placement) throw new ApiError(404, 'execution_resource_not_found', 'The current execution placement is unavailable.');
  if (placement.cell_id !== env.CELL_ID) throw new ApiError(409, 'execution_cell_changed', 'Execution must resume in the repository’s current control-plane cell.');
  return { ...env, ...identityAuthorityBindings(env), ROOT_DB: env.ROOT_DB ?? env.DB, ROOT_CELL_ID: env.ROOT_CELL_ID ?? env.CELL_ID, ROOT_SHARD_ID: env.ROOT_SHARD_ID ?? env.SHARD_ID,
    DB: cellDatabase(env, placement.shard_id), SHARD_ID: placement.shard_id };
}

/** Guard every dependent D1 effect, including its outbox event, in the same transaction. */
export async function guardedBatch(db: Database, first: D1PreparedStatement, rest: D1PreparedStatement[], metadata?: { context?: AppContext; event: EventInput; audit?: AuditInput }): Promise<void> {
  const guard = newId('guard');
  try {
    const statements = [first, mutationGuard(db, guard), ...rest, stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard)];
    const batch = metadata?.context ? await mutationStatements(metadata.context, { statements, event: metadata.event, audit: metadata.audit })
      : metadata ? [...statements, eventStatement(db, metadata.event), ...(metadata.audit ? [auditStatement(db, metadata.audit)] : [])] : statements;
    if (metadata?.context) await executeMutationBatch(metadata.context, batch);
    else await db.batch(batch);
  } catch (error) {
    if (/mutation_requires_one_row|CHECK constraint failed.*(?:ok|mutation)/i.test(String(error))) {
      throw new ApiError(409, 'execution_conflict', 'Execution state changed; refresh and retry the operation.');
    }
    throw error;
  }
}

export async function attemptContext(db: Database, attemptId: string): Promise<AttemptContext> {
  const attempt = await one<AttemptRecord>(db, 'SELECT * FROM execution_attempts WHERE id=?', attemptId);
  if (!attempt) throw new ApiError(404, 'not_found', 'The attempt was not found.');
  const run = await one<RunRecord>(db, 'SELECT * FROM workflow_runs WHERE id=? AND repo_id=? AND account_id=?', attempt.run_id, attempt.repo_id, attempt.account_id);
  const job = await one<JobRecord>(db, 'SELECT * FROM workflow_jobs WHERE id=? AND run_id=? AND repo_id=?', attempt.job_id, attempt.run_id, attempt.repo_id);
  if (!run || !job) throw new ApiError(409, 'execution_corrupt', 'The attempt provenance could not be verified.');
  const plan = JSON.parse(run.plan_json) as ExecutionPlan;
  if (await sha256(run.plan_json) !== run.plan_digest || run.plan_digest !== attempt.plan_digest) {
    throw new ApiError(409, 'plan_digest_mismatch', 'The immutable plan did not pass integrity verification.');
  }
  const definition = JSON.parse(job.definition_json) as PlanJob;
  if (plan.repo_id !== run.repo_id || plan.account_id !== run.account_id || plan.commit_sha !== run.commit_sha
    || plan.workflow_digest !== run.workflow_digest || plan.policy_revision !== run.policy_revision
    || !plan.jobs.some(value => value.key === definition.key && JSON.stringify(value) === job.definition_json)) {
    throw new ApiError(409, 'plan_provenance_mismatch', 'The job does not belong to the immutable plan.');
  }
  return { attempt, run, job: definition, plan };
}

export async function assertActiveRepository(db: Database, context: AttemptContext): Promise<void> {
  const repository = await one<{ owner_id: string; state: string; policy_revision: number; routing_epoch: number }>(db, 'SELECT owner_id,state,policy_revision,routing_epoch FROM repositories WHERE id=?', context.attempt.repo_id);
  if (!repository || repository.state !== 'active' || repository.owner_id !== context.attempt.account_id) {
    throw new ApiError(409, 'repository_unavailable', 'The repository cannot admit new execution.');
  }
  if (repository.policy_revision !== context.run.policy_revision) {
    throw new ApiError(409, 'policy_changed', 'Repository policy changed; compile a new trusted run.');
  }
  if (repository.routing_epoch !== context.plan.routing_epoch) throw new ApiError(409, 'routing_epoch_changed', 'The repository moved; this execution lease is fenced.');
}

export async function currentGeneration(db: Database, attempt: AttemptRecord): Promise<number> {
  const job = await one<{ generation: number; current_attempt_id: string }>(db,
    'SELECT generation,current_attempt_id FROM workflow_jobs WHERE id=? AND repo_id=? AND run_id=?', attempt.job_id, attempt.repo_id, attempt.run_id);
  return job?.current_attempt_id === attempt.id ? job.generation : -1;
}

export async function runJobs(db: Database, run: Pick<RunRecord, 'id' | 'repo_id'>): Promise<JobRecord[]> {
  return many<JobRecord>(db, 'SELECT * FROM workflow_jobs WHERE run_id=? AND repo_id=? ORDER BY job_key', run.id, run.repo_id);
}

export async function touchAttempt(db: Database, attempt: AttemptRecord, status: string, reason: string | null, at: string): Promise<void> {
  const result = await execute(db, 'UPDATE execution_attempts SET status=?,reason=?,revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND generation=? AND revision=?',
    status, reason, at, attempt.id, attempt.repo_id, attempt.generation, attempt.revision);
  if (result.meta.changes !== 1) throw new ApiError(409, 'execution_conflict', 'The attempt changed concurrently.');
}
