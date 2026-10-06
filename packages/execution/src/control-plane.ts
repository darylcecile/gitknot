import { ApiError, auditStatement, eventStatement, execute, many, newId, now, one, registerResourceLocator, sha256, stmt } from '@gitknot/core';
import type { AppContext, Bindings, Database, EventRecord } from '@gitknot/core';
import { EXECUTION_LIMITS, executionEnabled } from './config.ts';
import { affectedJobs, concurrencyKey, nextJobState, summarizeRun, TERMINAL_ATTEMPTS, TERMINAL_JOBS, TERMINAL_RUNS } from './state.ts';
import { executionResourceEnvironment, guardedBatch, identityPrimary, primary, runJobs } from './store.ts';
import { attemptRequest } from './transport.ts';
import { jobEnvironmentReady, promoteArtifact } from './environments.ts';
import { authorizeExecutionActor } from './authorization.ts';
import { assertRunnerPoolScope, readRunnerPool, readRunnerRecord, reconcileRunnerState } from './runner-authority.ts';
import { activeRunnerSlots } from './runner-slots.ts';
import { authorizeExecutionAudience, executionAudience } from './reads.ts';
import { workflowSourcePredicate } from './source-identity.ts';
import type { AttemptRecord, DispatchMessage, ExecutionPlan, JobRecord, PlanJob, RunRecord, RunnerPool } from './types.ts';

export interface CreateRunInput {
  run_id?: string;
  authority?: AppContext;
  operation_id?: string;
  workflow_id: string;
  plan: ExecutionPlan;
  actor_id: string;
  request_key: string;
  request_hash: string;
  rerun_of?: string;
  reuse?: Map<string, JobRecord>;
}

export async function createRun(env: Bindings, db: Database, input: CreateRunInput): Promise<RunRecord> {
  executionEnabled(env);
  const existing = await one<RunRecord>(db, 'SELECT * FROM workflow_runs WHERE repo_id=? AND request_key=?', input.plan.repo_id, input.request_key);
  if (existing) {
    if (existing.request_hash !== input.request_hash) throw new ApiError(409, 'idempotency_conflict', 'The idempotency key was used with different inputs.');
    await registerResourceLocator(env, { resource_id: existing.id, resource_type: 'run', repo_id: existing.repo_id, authority: 'repository' });
    return existing;
  }
  validateFrozenPlan(input.plan);
  const authority = input.authority ?? await authorizeExecutionActor(env, input.plan);
  await authorizeExecutionAudience(authority, input.plan.repo_id, executionAudience(input.plan), 'workflows.run');
  const queue = await one<{ count: number }>(db, `SELECT COUNT(*) AS count FROM workflow_runs WHERE account_id=? AND status IN ('queued','running','waiting','waiting_approval','cancelling')`, input.plan.account_id);
  if ((queue?.count ?? 0) >= EXECUTION_LIMITS.per_account_queue) throw new ApiError(429, 'execution_queue_full', 'The account execution queue is full. Retry after queued work completes.');
  const at = now();
  const id = input.run_id ?? newId('run');
  await registerResourceLocator(env, { resource_id: id, resource_type: 'run', repo_id: input.plan.repo_id, authority: 'repository' });
  const planJson = JSON.stringify(input.plan);
  const digest = await sha256(planJson);
  const key = concurrencyKey(input.plan);
  const operation = input.operation_id ? await one<{ revision: number }>(db, `SELECT revision FROM workflow_run_requests
    WHERE id=? AND run_id=? AND repo_id=? AND account_id=? AND kind IN ('run','rerun') AND status IN ('pending','running')`,
  input.operation_id, id, input.plan.repo_id, input.plan.account_id) : null;
  // /runs/:id already exposes the planning operation's revision. The handoff
  // must advance it, and the insert must still own that exact planning version.
  const revision = (operation?.revision ?? 0) + 1;
  const source = workflowSourcePredicate(input.plan.repo_id, input.plan.source_evidence, !input.rerun_of);
  const jobIds = new Map(input.plan.jobs.map(job => [job.key, newId('job')]));
  const statements: D1PreparedStatement[] = [];
  for (const job of input.plan.jobs) {
    const reused = input.reuse?.get(job.key);
    const initial = reused ? { status: reused.status, reason: 'Reusing an immutable successful dependency.' }
      : nextJobState(job, job.needs.map(dependency => ({ job_key: dependency, status: 'waiting' })));
    statements.push(stmt(db, `INSERT INTO workflow_jobs (id,repo_id,account_id,run_id,job_key,definition_json,status,reason,reused_attempt_id,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, jobIds.get(job.key), input.plan.repo_id, input.plan.account_id, id, job.key, JSON.stringify(job), initial.status, initial.reason,
    reused?.current_attempt_id ?? reused?.reused_attempt_id ?? null, at, at, TERMINAL_JOBS.has(initial.status) ? at : null));
    for (const dependency of job.needs) statements.push(stmt(db,
      'INSERT INTO workflow_job_dependencies (repo_id,account_id,run_id,job_id,dependency_id) VALUES (?,?,?,?,?)',
      input.plan.repo_id, input.plan.account_id, id, jobIds.get(job.key), jobIds.get(dependency)));
  }
  try {
    await guardedBatch(db, stmt(db, `INSERT INTO workflow_runs
      (id,repo_id,account_id,workflow_id,workflow_version_id,commit_sha,source_ref,workflow_digest,plan_digest,plan_json,policy_revision,trigger_type,trigger_id,trust,concurrency_key,supersede,status,requested_by,rerun_of,request_key,request_hash,created_at,updated_at,revision,enqueue_sequence)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,?,?,?,(SELECT COALESCE(MAX(enqueue_sequence),0)+1 FROM workflow_runs WHERE repo_id=?)
      WHERE EXISTS (SELECT 1 FROM repositories WHERE id=? AND owner_id=? AND state='active' AND policy_revision=? AND routing_epoch=?)
        AND ${source.sql}
        AND NOT EXISTS (SELECT 1 FROM json_each(?) selected WHERE NOT EXISTS (
          SELECT 1 FROM workflow_environments e WHERE e.id=selected.value AND e.repo_id=? AND e.state='active'))
        AND (? IS NULL OR EXISTS (SELECT 1 FROM workflow_run_requests WHERE id=? AND run_id=? AND repo_id=? AND account_id=?
          AND kind IN ('run','rerun') AND status IN ('pending','running') AND revision=?))
        AND (SELECT COUNT(*) FROM workflow_runs WHERE account_id=? AND status IN ('queued','running','waiting','waiting_approval','cancelling'))<?`,
    id, input.plan.repo_id, input.plan.account_id, input.workflow_id, input.plan.workflow_version_id, input.plan.commit_sha, input.plan.source_ref,
    input.plan.workflow_digest, digest, planJson, input.plan.policy_revision, input.plan.trigger.type, input.plan.trigger.id, input.plan.trust, key,
    input.plan.concurrency.supersede ? 1 : 0, input.actor_id, input.rerun_of ?? null, input.request_key, input.request_hash, at, at, revision, input.plan.repo_id,
    input.plan.repo_id, input.plan.account_id, input.plan.policy_revision, input.plan.routing_epoch, ...source.values,
    JSON.stringify(input.plan.jobs.flatMap(job => job.environment ? [job.environment.id] : [])), input.plan.repo_id, input.operation_id ?? null, input.operation_id ?? null, id,
    input.plan.repo_id, input.plan.account_id, operation?.revision ?? null,
    input.plan.account_id, EXECUTION_LIMITS.per_account_queue), statements, {
      context: authority, event: { type: 'workflow.run.created', resource_id: id, resource_revision: revision, repo_id: input.plan.repo_id, account_id: input.plan.account_id,
        actor_id: input.actor_id, data: { run_id: id, plan_digest: digest, commit_sha: input.plan.commit_sha } },
      audit: { action: 'workflows.run', resource_id: id, repo_id: input.plan.repo_id, account_id: input.plan.account_id, actor_id: input.actor_id,
        details: { plan_digest: digest, workflow_version_id: input.plan.workflow_version_id } },
    });
  } catch (error) {
    const raced = await one<RunRecord>(db, 'SELECT * FROM workflow_runs WHERE repo_id=? AND request_key=?', input.plan.repo_id, input.request_key);
    if (raced?.request_hash === input.request_hash) return raced;
    throw error;
  }
  const run = await one<RunRecord>(db, 'SELECT * FROM workflow_runs WHERE id=? AND repo_id=?', id, input.plan.repo_id);
  if (!run) throw new Error('Committed workflow run could not be read.');
  return run;
}

function validateFrozenPlan(plan: ExecutionPlan): void {
  if (plan.version !== 1 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(plan.commit_sha) || !/^[a-f0-9]{64}$/.test(plan.workflow_digest)) {
    throw new ApiError(422, 'invalid_plan', 'The plan requires immutable source and workflow digests.');
  }
  if (plan.jobs.length === 0 || plan.jobs.length > EXECUTION_LIMITS.jobs || plan.jobs.reduce((sum, job) => sum + job.needs.length, 0) > 512) {
    throw new ApiError(422, 'plan_too_large', 'The plan exceeds the bounded job graph limits.');
  }
  const keys = new Set(plan.jobs.map(job => job.key));
  if (keys.size !== plan.jobs.length || plan.jobs.some(job => job.needs.some(key => !keys.has(key)))) throw new ApiError(422, 'invalid_graph', 'Job keys and dependencies must form a complete graph.');
  const visited = new Set<string>();
  for (let pass = 0; pass < plan.jobs.length; pass++) for (const job of plan.jobs) if (job.needs.every(key => visited.has(key))) visited.add(job.key);
  if (visited.size !== keys.size) throw new ApiError(422, 'graph_cycle', 'The workflow contains a dependency cycle.');
  for (const job of plan.jobs) {
    if (job.steps.length > EXECUTION_LIMITS.steps || job.infrastructure_retries < 0 || job.infrastructure_retries > 2 || job.timeout_ms < 1 || job.timeout_ms > 3_600_000) throw new ApiError(422, 'invalid_job_limits', 'The job exceeds execution limits.');
    if (plan.trust === 'untrusted' && job.steps.some(step => step.secrets.length > 0)) throw new ApiError(403, 'untrusted_secret_access', 'Untrusted runs cannot receive trusted secrets.');
  }
  concurrencyKey(plan);
}

export async function ensureRunWorkflow(env: Bindings, runId: string): Promise<void> {
  env = await executionResourceEnvironment(env, runId, 'run');
  const run = await one<RunRecord>(primary(env), 'SELECT * FROM workflow_runs WHERE id=?', runId);
  if (!run || TERMINAL_RUNS.has(run.status)) return;
  const id = runWorkflowId(run);
  try { await env.RUN_WORKFLOW.create({ id, params: { mode: 'run', run_id: runId, orchestration_generation: run.orchestration_generation, shard_id: env.SHARD_ID } }); }
  catch (creationError) {
    // An existing durable instance is the sole permissible duplicate-create recovery.
    const instance = await env.RUN_WORKFLOW.get(id);
    const status = await instance.status();
    if (!status || status.status === 'unknown') throw creationError;
    if (['errored', 'terminated'].includes(status.status)) await instance.restart();
  }
}

export function runWorkflowId(run: Pick<RunRecord, 'id' | 'orchestration_generation'>): string {
  return run.orchestration_generation ? `run-${run.id}-${run.orchestration_generation}` : `run-${run.id}`;
}

export async function continueRunWorkflow(env: Bindings, runId: string, generation: number): Promise<void> {
  env = await executionResourceEnvironment(env, runId, 'run');
  await execute(primary(env), `UPDATE workflow_runs SET orchestration_generation=orchestration_generation+1,revision=revision+1,updated_at=? WHERE id=? AND orchestration_generation=?
    AND status IN ('queued','running','waiting','waiting_approval','cancelling')`, now(), runId, generation);
  await ensureRunWorkflow(env, runId);
}

export async function advanceRun(env: Bindings, runId: string): Promise<RunStatusResult> {
  env = await executionResourceEnvironment(env, runId, 'run');
  const db = primary(env);
  const run = await one<RunRecord>(db, 'SELECT * FROM workflow_runs WHERE id=?', runId);
  if (!run) throw new ApiError(404, 'not_found', 'The run was not found.');
  if (TERMINAL_RUNS.has(run.status)) return { status: run.status, terminal: true };
  if (Date.parse(run.created_at) + EXECUTION_LIMITS.run_wait_ms <= Date.now() && run.status !== 'cancelling') {
    await cancelRun(env, db, run, run.requested_by, 'The maximum durable run waiting period expired.');
    return { status: 'cancelling', terminal: false };
  }
  await supersedeOlderRuns(env, db, run);
  if (run.concurrency_key && run.status !== 'cancelling' && await priorRunBlocks(db, run)) {
    const reason = 'An earlier run or its executor cleanup owns this concurrency group.';
    await execute(db, `UPDATE workflow_runs SET status='waiting',reason=?,revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND revision=?
      AND status NOT IN ('cancelling','cancelled') AND (status<>'waiting' OR reason IS NOT ?)`, reason, now(), run.id, run.repo_id, run.revision, reason);
    return { status: 'waiting', terminal: false };
  }
  const jobs = await runJobs(db, run);
  const plan = JSON.parse(run.plan_json) as ExecutionPlan;
  const attempts = await many<AttemptRecord>(db, 'SELECT * FROM execution_attempts WHERE run_id=? AND repo_id=?', run.id, run.repo_id);
  let admitted = 0;
  for (const job of jobs) {
    if (TERMINAL_JOBS.has(job.status) || run.status === 'cancelling') continue;
    const definition = plan.jobs.find(value => value.key === job.job_key);
    if (!definition) throw new Error('Frozen job definition is missing.');
    if (job.current_attempt_id) {
      const attempt = attempts.find(value => value.id === job.current_attempt_id);
      if (attempt?.status === 'infrastructure_failed' && attempt.generation <= definition.infrastructure_retries && ['none', 'verified'].includes(attempt.cleanup_state)) {
        await execute(db, `UPDATE workflow_jobs SET status='ready',current_attempt_id=NULL,reason='Retrying a bounded infrastructure failure.',revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND current_attempt_id=? AND revision=?`, now(), job.id, run.repo_id, attempt.id, job.revision);
      }
      continue;
    }
    const state = nextJobState(definition, jobs.filter(value => definition.needs.includes(value.job_key)));
    if (state.status === 'ready' && admitted < EXECUTION_LIMITS.ready_batch) {
      try { await queueJob(env, db, run, job, definition); admitted++; }
      catch (error) { if (!(error instanceof ApiError && error.code === 'execution_conflict')) throw error; }
    } else if (state.status !== 'ready' && state.status !== job.status) {
      await execute(db, 'UPDATE workflow_jobs SET status=?,reason=?,completed_at=?,revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND revision=?',
        state.status, state.reason, TERMINAL_JOBS.has(state.status) ? now() : null, now(), job.id, run.repo_id, job.revision);
    }
  }
  const currentJobs = await runJobs(db, run);
  const promotions = await many<{ id: string }>(db, `SELECT id FROM workflow_promotions WHERE run_id=? AND repo_id=? AND status='approved'`, run.id, run.repo_id);
  for (const promotion of promotions) await promoteArtifact(env, promotion.id);
  await recordTerminalVerifications(db, run, currentJobs, plan);
  const status = summarizeRun(currentJobs, run.status === 'cancelling');
  if (status !== run.status) {
    const at = now();
    try {
      await guardedBatch(db, stmt(db, 'UPDATE workflow_runs SET status=?,revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND repo_id=? AND revision=?',
        status, at, TERMINAL_RUNS.has(status) ? at : null, run.id, run.repo_id, run.revision), [eventStatement(db, {
        type: TERMINAL_RUNS.has(status) ? 'workflow.run.completed' : 'workflow.run.updated', resource_id: run.id, resource_revision: run.revision + 1,
        repo_id: run.repo_id, account_id: run.account_id, data: { run_id: run.id, status, commit_sha: run.commit_sha, plan_digest: run.plan_digest },
      })]);
    } catch (error) { if (!(error instanceof ApiError && error.code === 'execution_conflict')) throw error; }
  }
  return { status, terminal: TERMINAL_RUNS.has(status) };
}

interface RunStatusResult { status: RunRecord['status']; terminal: boolean }

const precedingRunPredicate = `NOT EXISTS (SELECT 1 FROM workflow_runs prior WHERE prior.repo_id=? AND prior.concurrency_key=? AND prior.enqueue_sequence<? AND (
  prior.status NOT IN ('succeeded','failed','cancelled','timed_out','not_applicable','runner_unreachable')
  OR EXISTS (SELECT 1 FROM execution_attempts a WHERE a.run_id=prior.id AND a.repo_id=prior.repo_id AND
    (a.status IN ('queued','accepted','admitting','leased','running','cancelling') OR a.cleanup_state NOT IN ('none','verified')))
  OR EXISTS (SELECT 1 FROM workflow_promotions p WHERE p.run_id=prior.id AND p.repo_id=prior.repo_id AND p.status IN ('waiting','waiting_approval','approved','promoting'))))`;

async function priorRunBlocks(db: Database, run: RunRecord): Promise<boolean> {
  const available = await one<{ ready: number }>(db, `SELECT CASE WHEN ${precedingRunPredicate} THEN 1 ELSE 0 END AS ready`, run.repo_id, run.concurrency_key, run.enqueue_sequence);
  return available?.ready !== 1;
}

async function queueJob(env: Bindings, db: Database, run: RunRecord, job: JobRecord, definition: PlanJob): Promise<void> {
  executionEnabled(env);
  if (!await jobEnvironmentReady(env, run, job, definition)) return;
  let pool: RunnerPool | null = null;
  if (definition.executor.type === 'self_hosted') {
    try {
      pool = await readRunnerPool(env, definition.producer_id.replace(/^pool:/, ''));
      await assertRunnerPoolScope(env, pool);
    } catch (error) { if (!(error instanceof ApiError) || error.status >= 500) throw error; pool = null; }
    if (!pool || pool.account_id !== run.account_id || pool.repo_id && pool.repo_id !== run.repo_id || ![pool.id, pool.name].includes(definition.executor.pool)
      || pool.trust !== run.trust || (run.trust === 'untrusted' && pool.isolation !== 'ephemeral') || definition.producer_id !== `pool:${pool.id}`) {
      await execute(db, `UPDATE workflow_jobs SET reason='No authorized runner pool matches the frozen trust and producer requirements.',updated_at=? WHERE id=? AND repo_id=? AND revision=?`, now(), job.id, run.repo_id, job.revision);
      return;
    }
  }
  const at = now();
  const id = newId('att');
  await registerResourceLocator(env, { resource_id: id, resource_type: 'attempt', repo_id: run.repo_id, authority: 'repository' });
  const generation = job.generation + 1;
  const concurrency = run.concurrency_key ? { sql: precedingRunPredicate, values: [run.repo_id, run.concurrency_key, run.enqueue_sequence] } : { sql: '1', values: [] };
  await guardedBatch(db, stmt(db, `UPDATE workflow_jobs SET current_attempt_id=?,generation=?,status='queued',reason='Waiting for fair admission.',completed_at=NULL,revision=revision+1,updated_at=?
    WHERE id=? AND repo_id=? AND revision=? AND current_attempt_id IS NULL AND EXISTS (SELECT 1 FROM workflow_runs WHERE id=? AND status NOT IN ('cancelling','cancelled'))
    AND ${concurrency.sql}`,
  id, generation, at, job.id, run.repo_id, job.revision, run.id, ...concurrency.values), [
    stmt(db, `INSERT INTO execution_attempts (id,repo_id,account_id,run_id,job_id,generation,plan_digest,toolchain_digest,producer_id,executor,profile,pool_id,status,queue_deadline_at,created_at,updated_at,execution_backend,remote_executor_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,?)`, id, run.repo_id, run.account_id, run.id, job.id, generation, run.plan_digest,
    definition.toolchain.digest, definition.producer_id, definition.executor.type, definition.executor.type === 'hosted' ? definition.executor.profile : null,
    pool?.id ?? null, new Date(Date.now() + EXECUTION_LIMITS.queue_ms).toISOString(), at, at, definition.execution_backend ?? 'local', definition.remote_executor_id ?? null),
    stmt(db, 'INSERT INTO execution_dispatches (attempt_id,repo_id,account_id,run_id,generation,created_at) VALUES (?,?,?,?,?,?)', id, run.repo_id, run.account_id, run.id, generation, at),
    eventStatement(db, { type: 'workflow.attempt.queued', resource_id: id, resource_revision: 1, repo_id: run.repo_id, account_id: run.account_id,
      data: { run_id: run.id, attempt_id: id, generation } }),
  ]);
}

async function supersedeOlderRuns(env: Bindings, db: Database, run: RunRecord): Promise<void> {
  if (!run.supersede || !run.concurrency_key || !run.trigger_type.startsWith('pull_request.')) return;
  const older = await many<RunRecord>(db, `SELECT * FROM workflow_runs WHERE repo_id=? AND concurrency_key=? AND enqueue_sequence<?
    AND status IN ('queued','running','waiting','waiting_approval') ORDER BY enqueue_sequence LIMIT 32`, run.repo_id, run.concurrency_key, run.enqueue_sequence);
  for (const previous of older) await cancelRun(env, db, previous, run.requested_by, `Superseded by ${run.id}.`);
}

export async function cancelRun(env: Bindings, db: Database, run: RunRecord, actorId: string, reason = 'Cancellation requested.'): Promise<void> {
  if (TERMINAL_RUNS.has(run.status)) return;
  if (run.status !== 'cancelling') await guardedBatch(db,
    stmt(db, `UPDATE workflow_runs SET status='cancelling',reason=?,revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND revision=?`, reason, now(), run.id, run.repo_id, run.revision), [
      stmt(db, `UPDATE workflow_jobs SET status='cancelled',reason=?,revision=revision+1,updated_at=?,completed_at=? WHERE run_id=? AND repo_id=? AND current_attempt_id IS NULL AND status IN ('waiting','ready','waiting_approval')`, reason, now(), now(), run.id, run.repo_id),
      stmt(db, `UPDATE workflow_promotions SET status='cancelled',revision=revision+1,updated_at=? WHERE run_id=? AND repo_id=? AND status IN ('waiting','waiting_approval','approved')`, now(), run.id, run.repo_id),
      eventStatement(db, { type: 'workflow.run.cancel_requested', resource_id: run.id, resource_revision: run.revision + 1, repo_id: run.repo_id, account_id: run.account_id,
        actor_id: actorId, data: { run_id: run.id, reason } }),
      auditStatement(db, { action: 'workflows.cancel', resource_id: run.id, repo_id: run.repo_id, account_id: run.account_id, actor_id: actorId, details: { reason } }),
    ]);
  else await db.batch([
    stmt(db, `UPDATE workflow_jobs SET status='cancelled',reason=?,revision=revision+1,updated_at=?,completed_at=? WHERE run_id=? AND repo_id=? AND current_attempt_id IS NULL AND status IN ('waiting','ready','waiting_approval')`, reason, now(), now(), run.id, run.repo_id),
    stmt(db, `UPDATE workflow_promotions SET status='cancelled',revision=revision+1,updated_at=? WHERE run_id=? AND repo_id=? AND status IN ('waiting','waiting_approval','approved')`, now(), run.id, run.repo_id),
  ]);
  const attempts = await many<AttemptRecord>(db, `SELECT * FROM execution_attempts WHERE run_id=? AND repo_id=? AND status IN ('queued','accepted','admitting','leased','running','cancelling')`, run.id, run.repo_id);
  await Promise.all(attempts.map(attempt => attemptRequest(env, attempt.id, 'cancel', { reason })));
}

export async function rerun(env: Bindings, db: Database, run: RunRecord, selected: string[], actorId: string, requestKey: string, requestHash: string, targetRunId?: string, authority?: AppContext, operationId?: string): Promise<RunRecord> {
  if (!TERMINAL_RUNS.has(run.status)) throw new ApiError(409, 'run_active', 'Cancel or finish the run before rerunning it.');
  const plan = JSON.parse(run.plan_json) as ExecutionPlan;
  const jobs = await runJobs(db, run);
  const keys = selected.length ? selected : jobs.filter(job => !['succeeded', 'not_applicable'].includes(job.status)).map(job => job.job_key);
  const affected = affectedJobs(plan.jobs, keys.length ? keys : plan.jobs.map(job => job.key));
  const reuse = new Map(jobs.filter(job => !affected.has(job.job_key) && ['succeeded', 'not_applicable'].includes(job.status)).map(job => [job.job_key, job]));
  for (const original of reuse.values()) {
    const attemptId = original.current_attempt_id ?? original.reused_attempt_id;
    if (!attemptId) continue;
    const missing = await one<{ count: number }>(db, `SELECT COUNT(*) AS count FROM execution_objects WHERE repo_id=? AND attempt_id=? AND kind='output' AND (state!='sealed' OR expires_at<=?)`, run.repo_id, attemptId, now());
    if ((missing?.count ?? 0) > 0) throw new ApiError(409, 'rerun_inputs_expired', 'A successful dependency output has expired; rerun that dependency too.');
  }
  return createRun(env, db, { run_id: targetRunId, authority, operation_id: operationId, workflow_id: run.workflow_id, plan, actor_id: actorId, request_key: requestKey, request_hash: requestHash, rerun_of: run.id, reuse });
}

async function recordTerminalVerifications(db: Database, run: RunRecord, jobs: JobRecord[], plan: ExecutionPlan): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const job of jobs.filter(value => TERMINAL_JOBS.has(value.status))) {
    const definition = plan.jobs.find(value => value.key === job.job_key)!;
    statements.push(stmt(db, `INSERT OR IGNORE INTO workflow_verifications
      (id,repo_id,account_id,run_id,job_id,attempt_id,commit_sha,workflow_digest,plan_digest,policy_revision,producer_id,toolchain_digest,conclusion,reason,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, newId('check'), run.repo_id, run.account_id, run.id, job.id, job.current_attempt_id ?? job.reused_attempt_id,
    run.commit_sha, run.workflow_digest, run.plan_digest, run.policy_revision, job.status === 'not_applicable' ? `policy:${run.policy_revision}` : definition.producer_id,
    definition.toolchain.digest, job.status, job.reason, now()));
  }
  if (statements.length) await db.batch(statements);
}

/** One oldest dispatch per account per pass; attempts, not VM lifetimes, occupy queue consumers. */
export async function dispatchFairly(env: Bindings): Promise<number> {
  const db = primary(env);
  const cutoff = new Date(Date.now() - 30_000).toISOString();
  const accounts = await many<{ account_id: string }>(db, `SELECT d.account_id FROM execution_dispatches d LEFT JOIN execution_fairness f ON f.account_id=d.account_id
    WHERE d.accepted_at IS NULL AND (d.published_at IS NULL OR d.published_at<?)
    GROUP BY d.account_id ORDER BY COALESCE(f.last_dispatched_at,''),MIN(d.created_at),d.account_id LIMIT ?`, cutoff, EXECUTION_LIMITS.dispatch_batch);
  let count = 0;
  for (const account of accounts) {
    const message = await one<DispatchMessage>(db, `SELECT attempt_id,run_id,generation FROM execution_dispatches WHERE account_id=? AND accepted_at IS NULL
      AND (published_at IS NULL OR published_at<?) ORDER BY created_at,attempt_id LIMIT 1`, account.account_id, cutoff);
    if (!message) continue;
    const delivery = { ...message, shard_id: env.SHARD_ID };
    await env.DISPATCH.send(delivery);
    const at = now();
    await db.batch([
      stmt(db, 'UPDATE execution_dispatches SET published_at=?,publication_count=publication_count+1 WHERE attempt_id=? AND account_id=? AND accepted_at IS NULL', at, message.attempt_id, account.account_id),
      stmt(db, `INSERT INTO execution_fairness (account_id,last_dispatched_at,dispatch_count) VALUES (?,?,1)
        ON CONFLICT(account_id) DO UPDATE SET last_dispatched_at=excluded.last_dispatched_at,dispatch_count=dispatch_count+1`, account.account_id, at),
    ]);
    count++;
  }
  return count;
}

export async function acceptDispatch(env: Bindings, message: DispatchMessage): Promise<void> {
  const result = await attemptRequest<{ accepted: boolean }>(env, message.attempt_id, 'accept', message);
  if (!result.accepted) throw new Error('The attempt controller did not durably accept dispatch.');
}

export async function handleWorkflowEvent(env: Bindings, event: EventRecord): Promise<void> {
  if (event.type === 'runner.updated') {
    await reconcileRunnerState(env, event.resource_id);
    const runner = await readRunnerRecord(env, event.resource_id);
    if (runner.state !== 'active') for (const slot of await activeRunnerSlots(env, runner.id)) await attemptRequest(env, slot.attempt_id, 'cancel', { reason: 'Runner authority was retired or disabled.' });
    return;
  }
  if (event.type === 'runner.pool.updated') {
    const pool = await readRunnerPool(env, event.resource_id);
    if (pool.state !== 'active') {
      const slots = await many<{ attempt_id: string }>(identityPrimary(env), `SELECT attempt_id FROM runner_slot_reservations WHERE pool_id=? AND account_id=? AND state IN ('reserved','leased') ORDER BY created_at,attempt_id LIMIT 64`, pool.id, pool.account_id);
      for (const slot of slots) await attemptRequest(env, slot.attempt_id, 'cancel', { reason: 'Runner pool authority was disabled.' });
    }
    return;
  }
  if (event.type === 'workflow.operation.requested') {
    const { ensureWorkflowOperation } = await import('./operations.ts');
    await ensureWorkflowOperation(env, event.resource_id); return;
  }
  if (event.type === 'git.refs.updated' || event.type === 'merge_candidate.created' || event.type.startsWith('pull_request.')) {
    const { triggerWorkflows } = await import('./triggers.ts');
    await triggerWorkflows(env, event);
    return;
  }
  if (event.type === 'workflow.run.created') { await ensureRunWorkflow(env, event.resource_id); return; }
  if (event.type === 'workflow.run.cancel_requested') {
    const db = primary(env);
    const run = await one<RunRecord>(db, 'SELECT * FROM workflow_runs WHERE id=? AND repo_id=?', event.resource_id, event.repo_id);
    if (run) await cancelRun(env, db, run, event.actor_id ?? run.requested_by, run.reason ?? undefined);
    return;
  }
  if (event.type.startsWith('workflow.attempt.')) {
    const runId = typeof event.data.run_id === 'string' ? event.data.run_id : null;
    if (runId) {
      await advanceRun(env, runId);
      const run = await one<RunRecord>(primary(env), 'SELECT * FROM workflow_runs WHERE id=?', runId);
      if (run && !TERMINAL_RUNS.has(run.status)) {
        const instance = await env.RUN_WORKFLOW.get(runWorkflowId(run));
        await instance.sendEvent({ type: 'execution-updated', payload: { run_id: runId } });
      }
    }
    return;
  }
  if (event.type === 'workflow.approval.decided') {
    const runId = typeof event.data.run_id === 'string' ? event.data.run_id : null;
    if (runId) await advanceRun(env, runId);
  }
}
