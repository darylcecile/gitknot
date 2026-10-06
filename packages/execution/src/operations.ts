import { ApiError, authorize, execute, getRepository, many, newId, now, one, registerResourceLocator, requestDatabaseLocation, requirePrincipal, sha256, stmt } from '@gitknot/core';
import type { AppContext, Bindings, Database, IdempotencyRecord, Principal, RequestAuthorization } from '@gitknot/core';
import { currentExecutionActor, repositoryExecutionContext } from './authorization.ts';
import { advanceRun, cancelRun, createRun, rerun } from './control-plane.ts';
import { decidePromotion, promoteArtifact } from './environments.ts';
import type { PromotionRecord } from './environments.ts';
import { planRun } from './planning.ts';
import type { PlanRunInput, WorkflowRecord, WorkflowVersion } from './planning.ts';
import { executionResourceEnvironment, guardedBatch, primary } from './store.ts';
import { TERMINAL_RUNS } from './state.ts';
import type { RunRecord } from './types.ts';
import { EXECUTION_LIMITS } from './config.ts';
import { authorizeExecutionAudience, executionAudience, executionNotFound, executionReadResponse, freshExecutionReader, readRunPlan } from './reads.ts';
import { pinWorkflowSource, workflowSourcePredicate } from './source-identity.ts';

export type WorkflowOperationInput =
  | { kind: 'run'; workflow_id: string; workflow_version_id: string; spec: PlanRunInput }
  | { kind: 'rerun'; parent_run_id: string; jobs: string[] }
  | { kind: 'cancel'; reason: string; run_revision: number; planning_operation_id: string | null }
  | { kind: 'approve'; promotion_id: string; promotion_revision: number; decision: 'approved' | 'rejected' }
  | { kind: 'promote'; promotion_id: string; promotion_revision: number };

export interface WorkflowOperation {
  id: string; repo_id: string; account_id: string; actor_id: string; kind: WorkflowOperationInput['kind']; run_id: string;
  input_json: string; status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'; result_json: string | null; error_json: string | null;
  attempts: number; next_attempt_at: string; revision: number; created_at: string; updated_at: string; completed_at: string | null;
}

interface WorkflowOperationPayload { principal: Principal; input: WorkflowOperationInput; audience?: string[] }

export async function planningRunRepresentation(db: Database, operation: WorkflowOperation): Promise<Record<string, unknown>> {
  const { input } = JSON.parse(operation.input_json) as WorkflowOperationPayload;
  if (!['pending', 'running', 'failed', 'cancelled'].includes(operation.status)) executionNotFound();
  const parent = input.kind === 'rerun' ? await one<RunRecord>(db, 'SELECT * FROM workflow_runs WHERE id=? AND repo_id=?', input.parent_run_id, operation.repo_id) : null;
  if (input.kind !== 'run' && (input.kind !== 'rerun' || !parent)) executionNotFound();
  return { id: operation.run_id, repo_id: operation.repo_id, account_id: operation.account_id, operation_id: operation.id,
    workflow_id: input.kind === 'run' ? input.workflow_id : parent!.workflow_id,
    workflow_version_id: input.kind === 'run' ? input.workflow_version_id : parent!.workflow_version_id,
    requested_commit_sha: input.kind === 'run' ? input.spec.commit : parent!.commit_sha,
    requested_source_ref: input.kind === 'run' ? input.spec.ref : parent!.source_ref,
    status: operation.status === 'failed' ? 'failed' : operation.status === 'cancelled' ? 'cancelled' : 'planning',
    revision: operation.revision, requested_by: operation.actor_id, created_at: operation.created_at, plan_digest: null,
    ...(operation.error_json ? { error: JSON.parse(operation.error_json) } : {}) };
}

export async function workflowOperationAudience(db: Database, operation: WorkflowOperation): Promise<string[]> {
  const run = await one<RunRecord>(db, 'SELECT * FROM workflow_runs WHERE id=? AND repo_id=?', operation.run_id, operation.repo_id);
  if (run) return executionAudience(await readRunPlan(run));
  const stored = JSON.parse(operation.input_json) as WorkflowOperationPayload;
  if (stored.audience) {
    if (!Array.isArray(stored.audience) || !stored.audience.includes(operation.repo_id)) executionNotFound();
    const pinned = stored.input.kind === 'run' ? stored.input.spec.source : null;
    const audience = [...new Set([...stored.audience, ...(pinned ? [pinned.source_repo_id, pinned.head_repo_id, ...pinned.related_repo_ids] : [])])];
    if (audience.length > 32 || audience.some(id => typeof id !== 'string' || !/^r_[A-Za-z0-9_-]+$/.test(id))) executionNotFound();
    return audience;
  }
  if (stored.input.kind === 'run' && !stored.input.spec.event.pull_request_id && !stored.input.spec.event.merge_candidate_id) return [operation.repo_id];
  if (stored.input.kind === 'rerun') {
    const parent = await one<RunRecord>(db, 'SELECT * FROM workflow_runs WHERE id=? AND repo_id=?', stored.input.parent_run_id, operation.repo_id);
    if (parent) return executionAudience(await readRunPlan(parent));
  }
  if (stored.input.kind === 'cancel') {
    const creator = await one<WorkflowOperation>(db, `SELECT * FROM workflow_run_requests WHERE run_id=? AND repo_id=? AND kind IN ('run','rerun')`, operation.run_id, operation.repo_id);
    if (creator) return workflowOperationAudience(db, creator);
  }
  executionNotFound();
}

export async function authorizeWorkflowOperation(c: AppContext, operation: WorkflowOperation, capability = 'runs.read'): Promise<void> {
  const audience = await workflowOperationAudience(c.get('database') ?? c.env.DB, operation);
  await authorizeExecutionAudience(c, operation.repo_id, audience, capability);
  const repository = await getRepository(c, operation.repo_id, capability), location = requestDatabaseLocation(c);
  if (repository.cell_id !== location.cell_id || repository.shard_id !== location.shard_id) throw new ApiError(409, 'execution_placement_changed', 'The workflow operation moved. Read its current location again.');
}

export function workflowOperationAuthorizer(c: AppContext, operation: WorkflowOperation, capability = 'runs.read'): () => Promise<void> {
  return async () => {
    const fresh = freshExecutionReader(c);
    const current = await one<WorkflowOperation>(fresh.get('database'), 'SELECT * FROM workflow_run_requests WHERE id=? AND repo_id=?', operation.id, operation.repo_id);
    if (!current) executionNotFound();
    await authorizeWorkflowOperation(fresh, current, capability);
  };
}

export function operationRunId(operationId: string): string { return `run_${operationId.replace(/^op_/, '')}`; }

export async function operationAuthorization(c: AppContext, record: IdempotencyRecord | null, capability = 'workflows.run'): Promise<RequestAuthorization[]> {
  if (record?.operation_id) {
    const operation = await one<WorkflowOperation>(c.get('database') ?? c.env.DB, 'SELECT * FROM workflow_run_requests WHERE id=?', record.operation_id);
    if (operation) return (await workflowOperationAudience(c.get('database') ?? c.env.DB, operation)).map(repo_id => ({
      capability: repo_id === operation.repo_id ? capability : 'contents.read', scope: { repo_id },
    }));
  }
  const repoId = c.req.param('repoId') ?? record?.repo_id;
  if (repoId) return [{ capability, scope: { repo_id: repoId } }];
  const run = await one<RunRecord>(c.get('database') ?? c.env.DB, 'SELECT * FROM workflow_runs WHERE id=?', c.req.param('id'));
  const pending = run ? null : await one<{ repo_id: string }>(c.get('database') ?? c.env.DB, `SELECT repo_id FROM workflow_run_requests WHERE run_id=? AND kind IN ('run','rerun')`, c.req.param('id'));
  if (!run && !pending) throw new ApiError(404, 'not_found', 'The workflow run was not found.');
  return [{ capability, scope: { repo_id: (run ?? pending)!.repo_id } }];
}

export async function workflowOperation(env: Bindings, id: string): Promise<WorkflowOperation | null> {
  return one<WorkflowOperation>(primary(env), 'SELECT * FROM workflow_run_requests WHERE id=?', id);
}

export function publicWorkflowOperation(operation: WorkflowOperation): Record<string, unknown> {
  const { input_json, result_json, error_json, ...value } = operation;
  void input_json;
  return { ...value, result: result_json ? JSON.parse(result_json) : null, error: error_json ? JSON.parse(error_json) : null };
}

/** Only this fenced D1 intent runs in HTTP; external work is replayed by its fixed operation ID. */
export async function requestWorkflowOperation(c: AppContext, repoId: string, accountId: string, input: WorkflowOperationInput, targetRunId?: string): Promise<WorkflowOperation> {
  const actor = requirePrincipal(c), request = c.get('idempotency'), id = request?.operation_id ?? newId('op');
  if (request && request.strategy !== 'external') throw new ApiError(500, 'workflow_recovery_contract', 'This operation requires the external recovery strategy.');
  const db = c.get('database') ?? c.env.DB;
  const existing = await one<WorkflowOperation>(db, 'SELECT * FROM workflow_run_requests WHERE id=? AND repo_id=? AND actor_id=?', id, repoId, actor.id);
  if (existing) return existing;
  const runId = input.kind === 'run' || input.kind === 'rerun' ? operationRunId(id) : targetRunId;
  if (!runId) throw new ApiError(422, 'run_required', 'The workflow operation requires a run.');
  const capability = input.kind === 'approve' ? 'environments.approve' : 'workflows.run';
  const repository = await getRepository(c, repoId, capability);
  if (input.kind === 'run') input = { ...input, spec: { ...input.spec, source: await pinWorkflowSource(db, repository, input.spec) } };
  const target = input.kind === 'run' ? null : await one<RunRecord>(db, 'SELECT * FROM workflow_runs WHERE id=? AND repo_id=?', input.kind === 'rerun' ? input.parent_run_id : runId, repoId);
  const creator = input.kind === 'cancel' && !target ? await one<WorkflowOperation>(db, `SELECT * FROM workflow_run_requests WHERE run_id=? AND repo_id=? AND kind IN ('run','rerun')`, runId, repoId) : null;
  const audience = input.kind === 'run' ? input.spec.source!.related_repo_ids : target ? executionAudience(await readRunPlan(target)) : creator ? await workflowOperationAudience(db, creator) : null;
  if (!audience) executionNotFound();
  await authorizeExecutionAudience(c, repoId, audience, capability);
  await registerResourceLocator(c.env, { resource_id: id, resource_type: 'workflow_operation', repo_id: repoId, authority: 'repository' });
  await registerResourceLocator(c.env, { resource_id: runId, resource_type: 'run', repo_id: repoId, authority: 'repository' });
  const at = now();
  const pending = await one<{ count: number }>(db, `SELECT COUNT(*) AS count FROM workflow_run_requests WHERE account_id=? AND status IN ('pending','running')`, accountId);
  if ((pending?.count ?? 0) >= EXECUTION_LIMITS.per_account_queue) throw new ApiError(429, 'workflow_queue_full', 'The account workflow-operation queue is full.');
  const encoded = JSON.stringify({ principal: actor, input, audience } satisfies WorkflowOperationPayload);
  const effects = input.kind === 'cancel' ? cancellationEffects(db, runId, repoId, accountId, input, at) : [];
  const source = workflowSourcePredicate(repoId, input.kind === 'run' ? input.spec.source : undefined);
  try {
    await guardedBatch(db, stmt(db, `INSERT INTO workflow_run_requests (id,repo_id,account_id,actor_id,kind,run_id,input_json,status,next_attempt_at,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,'pending',?,?,? WHERE (SELECT COUNT(*) FROM workflow_run_requests WHERE account_id=? AND status IN ('pending','running'))<? AND ${source.sql}`, id, repoId, accountId, actor.id, input.kind, runId, encoded, at, at, at, accountId, EXECUTION_LIMITS.per_account_queue, ...source.values), effects, {
      context: c, event: { type: 'workflow.operation.requested', resource_id: id, resource_revision: 1, repo_id: repoId, account_id: accountId, actor_id: actor.id, data: { operation_id: id, run_id: runId, kind: input.kind } },
      audit: { action: `workflows.${input.kind}.requested`, resource_id: id, repo_id: repoId, account_id: accountId, actor_id: actor.id, details: { run_id: runId } },
    });
  } catch (error) {
    if (/workflow_run_revision_current/.test(String(error))) throw new ApiError(412, 'revision_conflict', 'The resource changed. Refresh its ETag and retry.');
    throw error;
  }
  return (await one<WorkflowOperation>(db, 'SELECT * FROM workflow_run_requests WHERE id=? AND repo_id=?', id, repoId))!;
}

function cancellationEffects(db: Database, runId: string, repoId: string, accountId: string, input: Extract<WorkflowOperationInput, { kind: 'cancel' }>, at: string): D1PreparedStatement[] {
  const guard = newId('guard');
  const current = input.planning_operation_id === null
    ? { sql: 'EXISTS (SELECT 1 FROM workflow_runs WHERE id=? AND repo_id=? AND account_id=? AND revision=?)', values: [runId, repoId, accountId, input.run_revision] }
    : { sql: `NOT EXISTS (SELECT 1 FROM workflow_runs WHERE id=? AND repo_id=?) AND EXISTS (SELECT 1 FROM workflow_run_requests
        WHERE id=? AND run_id=? AND repo_id=? AND account_id=? AND kind IN ('run','rerun') AND revision=?)`,
      values: [runId, repoId, input.planning_operation_id, runId, repoId, accountId, input.run_revision] };
  return [
    stmt(db, `INSERT INTO workflow_run_revision_guards(id,ok) SELECT ?,CASE WHEN ${current.sql} THEN 1 ELSE 0 END`, guard, ...current.values),
    stmt(db, `UPDATE workflow_runs SET status='cancelling',reason=?,revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND revision=? AND status IN ('queued','running','waiting','waiting_approval')`, input.reason, at, runId, repoId, input.run_revision),
    stmt(db, `UPDATE workflow_run_requests SET status='cancelled',completed_at=?,updated_at=?,revision=revision+1 WHERE id=? AND run_id=? AND repo_id=? AND revision=? AND kind IN ('run','rerun') AND status IN ('pending','running')
      AND NOT EXISTS (SELECT 1 FROM workflow_runs WHERE id=? AND repo_id=?)`, at, at, input.planning_operation_id, runId, repoId, input.run_revision, runId, repoId),
    stmt(db, 'DELETE FROM workflow_run_revision_guards WHERE id=?', guard),
  ];
}

export async function recoverWorkflowOperation(c: AppContext, record: IdempotencyRecord): Promise<Response | null> {
  if (!record.operation_id) throw new ApiError(409, 'operation_identity_missing', 'The original workflow operation must be recovered before retrying.');
  const operation = await one<WorkflowOperation>(c.get('database') ?? c.env.DB, 'SELECT * FROM workflow_run_requests WHERE id=? AND actor_id=?', record.operation_id, record.principal_id);
  if (!operation) return null;
  await getRepository(c, operation.repo_id, operation.kind === 'approve' ? 'environments.approve' : 'workflows.run');
  await authorizeWorkflowOperation(c, operation, operation.kind === 'approve' ? 'environments.approve' : 'workflows.run');
  return operationResponse(c, operation);
}

export async function operationResponse(c: AppContext, operation: WorkflowOperation): Promise<Response> {
  const capability = operation.kind === 'approve' ? 'environments.approve' : 'workflows.run';
  await authorizeWorkflowOperation(c, operation, capability);
  const recheck = workflowOperationAuthorizer(c, operation, capability);
  if (operation.kind === 'run' || operation.kind === 'rerun' || operation.kind === 'cancel') {
    c.header('location', `/v1/runs/${operation.run_id}`);
    const db = c.get('database') ?? c.env.DB;
    // Read the creator before the materialized run, matching GET /runs/:id.
    // A cancellation's own journal counter is not the run's resource version.
    const planning = operation.kind === 'cancel' ? await one<WorkflowOperation>(db,
      `SELECT * FROM workflow_run_requests WHERE run_id=? AND repo_id=? AND kind IN ('run','rerun') ORDER BY created_at LIMIT 1`, operation.run_id, operation.repo_id) : operation;
    const run = await one<RunRecord>(db, 'SELECT * FROM workflow_runs WHERE id=? AND repo_id=?', operation.run_id, operation.repo_id);
    if (!run && !planning) throw new ApiError(503, 'workflow_journal_missing', 'The original workflow operation requires recovery.');
    const error = operation.error_json ?? planning?.error_json;
    return executionReadResponse(c, c.json({ id: operation.run_id, run_id: operation.run_id, operation_id: operation.id, repo_id: operation.repo_id,
      status: run?.status ?? (planning!.status === 'failed' ? 'failed' : planning!.status === 'cancelled' ? 'cancelled' : 'planning'),
      revision: run?.revision ?? planning!.revision, ...(error ? { error: JSON.parse(error) } : {}) }, 202), recheck);
  }
  c.header('location', `/v1/workflow-operations/${operation.id}`);
  return executionReadResponse(c, c.json(publicWorkflowOperation(operation), 202), recheck);
}

export async function ensureWorkflowOperation(env: Bindings, operationId: string): Promise<void> {
  env = await executionResourceEnvironment(env, operationId, 'workflow_operation');
  const operation = await workflowOperation(env, operationId);
  if (!operation || ['completed', 'failed', 'cancelled'].includes(operation.status)) return;
  if (operation.created_at < new Date(Date.now() - 24 * 60 * 60_000).toISOString() || operation.attempts >= 20) {
    await failOperation(env, operation, new ApiError(503, 'workflow_planning_expired', 'The bounded workflow operation could not be completed.')); return;
  }
  const id = `operation-${operation.id}`;
  let started = false;
  try { await env.RUN_WORKFLOW.create({ id, params: { mode: 'operation', run_id: operation.run_id, operation_id: operation.id, shard_id: env.SHARD_ID } }); started = true; }
  catch (error) {
    const existing = await env.RUN_WORKFLOW.get(id), status = await existing.status();
    if (!status || status.status === 'unknown') throw error;
    if (status.status === 'errored' || status.status === 'terminated' || status.status === 'complete') { await existing.restart(); started = true; }
  }
  await execute(primary(env), 'UPDATE workflow_run_requests SET attempts=attempts+?,next_attempt_at=?,updated_at=? WHERE id=?', Number(started), new Date(Date.now() + 60_000).toISOString(), now(), operation.id);
}

async function finishOperation(env: Bindings, operation: WorkflowOperation, result: unknown): Promise<void> {
  await execute(primary(env), `UPDATE workflow_run_requests SET status='completed',result_json=?,error_json=NULL,revision=revision+1,completed_at=?,updated_at=? WHERE id=? AND repo_id=? AND status IN ('pending','running')`, JSON.stringify(result), now(), now(), operation.id, operation.repo_id);
}

async function failOperation(env: Bindings, operation: WorkflowOperation, error: ApiError): Promise<void> {
  await execute(primary(env), `UPDATE workflow_run_requests SET status='failed',error_json=?,revision=revision+1,completed_at=?,updated_at=? WHERE id=? AND repo_id=? AND status IN ('pending','running')`,
    JSON.stringify({ code: error.code, message: error.message }), now(), now(), operation.id, operation.repo_id);
}

export async function executeWorkflowOperation(env: Bindings, id: string): Promise<{ run_id: string; status: string }> {
  env = await executionResourceEnvironment(env, id, 'workflow_operation');
  const operation = await workflowOperation(env, id);
  if (!operation) throw new ApiError(404, 'workflow_operation_not_found', 'The workflow operation was not found.');
  if (['completed', 'failed', 'cancelled'].includes(operation.status)) return { run_id: operation.run_id, status: operation.status };
  const db = primary(env), stored = JSON.parse(operation.input_json) as { principal: Principal; input: WorkflowOperationInput };
  const input = stored.input;
  try {
    const existing = ['run', 'rerun'].includes(input.kind) ? await one<RunRecord>(db, 'SELECT * FROM workflow_runs WHERE id=? AND repo_id=?', operation.run_id, operation.repo_id) : null;
    if (existing) { await finishOperation(env, operation, { run_id: existing.id }); return { run_id: existing.id, status: 'completed' }; }
    const committed = input.kind === 'approve'
      ? await one(db, 'SELECT id FROM environment_approvals WHERE operation_id=? AND promotion_id=? AND repo_id=? AND approver_id=? AND decision=?', operation.id, input.promotion_id, operation.repo_id, operation.actor_id, input.decision)
      : input.kind === 'promote' ? await one(db, 'SELECT id AS release_id FROM workflow_releases WHERE promotion_id=? AND run_id=? AND repo_id=?', input.promotion_id, operation.run_id, operation.repo_id) : null;
    if (committed) { await finishOperation(env, operation, committed); return { run_id: operation.run_id, status: 'completed' }; }
    if (input.kind === 'cancel') {
      const run = await one<RunRecord>(db, 'SELECT * FROM workflow_runs WHERE id=? AND repo_id=?', operation.run_id, operation.repo_id);
      if (!run) {
        const cancelled = await one(db, `SELECT id FROM workflow_run_requests WHERE run_id=? AND repo_id=? AND kind IN ('run','rerun') AND status='cancelled'`, operation.run_id, operation.repo_id);
        if (!cancelled) throw new ApiError(404, 'run_not_found', 'The run is unavailable.');
        await finishOperation(env, operation, { run_id: operation.run_id, status: 'cancelled' });
        return { run_id: operation.run_id, status: 'completed' };
      }
      await cancelRun(env, db, run, operation.actor_id, input.reason);
      const state = await advanceRun(env, run.id);
      if (!state.terminal) return { run_id: run.id, status: 'running' };
      if (state.status === 'runner_unreachable') throw new ApiError(409, 'runner_unreachable', 'The customer machine could not confirm termination.');
      await finishOperation(env, operation, { run_id: run.id, status: state.status });
      return { run_id: run.id, status: 'completed' };
    }
    const actor = await currentExecutionActor(env, { id: stored.principal.id, kind: stored.principal.kind, user_id: stored.principal.user_id, credential_id: stored.principal.credential_id });
    const context = await repositoryExecutionContext(env, actor, operation.repo_id), capability = input.kind === 'approve' ? 'environments.approve' : 'workflows.run';
    const repo = await getRepository(context, operation.repo_id, capability);
    if (repo.owner_id !== operation.account_id) throw new ApiError(409, 'operation_owner_changed', 'Repository ownership changed after this operation was admitted.');
    await execute(db, `UPDATE workflow_run_requests SET status='running',revision=revision+1,updated_at=? WHERE id=? AND status='pending'`, now(), operation.id);
    let result: unknown;
    if (input.kind === 'run') {
      const workflow = await one<WorkflowRecord>(db, 'SELECT * FROM workflows WHERE id=? AND repo_id=?', input.workflow_id, repo.id);
      const version = await one<WorkflowVersion>(db, 'SELECT * FROM workflow_versions WHERE id=? AND workflow_id=? AND repo_id=?', input.workflow_version_id, input.workflow_id, repo.id);
      if (!workflow || !version) throw new ApiError(409, 'workflow_version_missing', 'The approved workflow version is unavailable.');
      const plan = await planRun(env, repo, workflow, version, actor, input.spec);
      const run = await createRun(env, db, { run_id: operation.run_id, authority: context, operation_id: operation.id, workflow_id: workflow.id, plan, actor_id: actor.id, request_key: `operation:${operation.id}`, request_hash: await sha256(operation.input_json) });
      result = { run_id: run.id };
    } else if (input.kind === 'rerun') {
      const parent = await one<RunRecord>(db, 'SELECT * FROM workflow_runs WHERE id=? AND repo_id=?', input.parent_run_id, repo.id);
      if (!parent) throw new ApiError(404, 'run_not_found', 'The original run is unavailable.');
      const run = await rerun(env, db, parent, input.jobs, actor.id, `operation:${operation.id}`, await sha256(operation.input_json), operation.run_id, context, operation.id);
      result = { run_id: run.id };
    } else {
      const promotion = await one<PromotionRecord>(db, 'SELECT * FROM workflow_promotions WHERE id=? AND run_id=? AND repo_id=?', input.promotion_id, operation.run_id, repo.id);
      if (!promotion) throw new ApiError(404, 'promotion_not_found', 'The artifact promotion is unavailable.');
      if (input.kind === 'approve') {
        const previous = await one(db, 'SELECT id FROM environment_approvals WHERE promotion_id=? AND repo_id=? AND approver_id=?', promotion.id, repo.id, actor.id);
        if (previous) throw new ApiError(409, 'approval_already_decided', 'This approver already recorded an immutable decision.');
        if (promotion.revision !== input.promotion_revision) throw new ApiError(412, 'revision_conflict', 'The artifact approval changed before this decision was applied.');
        await decidePromotion(env, db, promotion, actor.id, input.decision, context, operation.id);
        result = { promotion_id: promotion.id, decision: input.decision };
      } else {
        if (promotion.status !== 'released' && promotion.revision !== input.promotion_revision) throw new ApiError(412, 'revision_conflict', 'The artifact promotion changed before publication.');
        const published = await promoteArtifact(env, promotion.id, context);
        if (!published.released) return { run_id: operation.run_id, status: 'running' };
        result = published;
      }
    }
    await finishOperation(env, operation, result);
    return { run_id: operation.run_id, status: 'completed' };
  } catch (error) {
    if (error instanceof ApiError && error.status < 500 && error.status !== 429) {
      await failOperation(env, operation, error); return { run_id: operation.run_id, status: 'failed' };
    }
    throw error;
  }
}

export async function sweepWorkflowOperations(env: Bindings): Promise<void> {
  const operations = await many<WorkflowOperation>(primary(env), `SELECT * FROM workflow_run_requests WHERE status IN ('pending','running') AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT 16`, now());
  for (const operation of operations) await ensureWorkflowOperation(env, operation.id);
}
