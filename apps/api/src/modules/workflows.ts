import { z } from 'zod';
import { toolchainSchema } from '@gitknot/workflows';
import { ApiError, auditStatement, authorize, database, eventStatement, expectedRevision, getRepository, jsonBody, listResponse, many, mutate, newId, now, one, page, requirePrincipal, resourceResponse, route, sha256, stmt } from '@gitknot/core';
import type { App, AppContext } from '@gitknot/core';
import { cancelRun, createRun, rerun } from '@gitknot/execution/control-plane';
import { EXECUTION_LIMITS, hostedProfiles } from '@gitknot/execution/config';
import { createPromotion, decidePromotion, promoteArtifact } from '@gitknot/execution/environments';
import type { EnvironmentRecord, PromotionRecord } from '@gitknot/execution/environments';
import { definitionDigest, planRun, validatedDefinition } from '@gitknot/execution/planning';
import type { ExecutionPolicyRow, WorkflowRecord, WorkflowVersion } from '@gitknot/execution/planning';
import { readWorkflowSource } from '@gitknot/execution/source';
import { streamManifest } from '@gitknot/execution/objects';
import { executionRequestEnvironment } from '@gitknot/execution/store';
import type { AttemptRecord, ExecutionObject, ExecutionPlan, JobRecord, RunRecord } from '@gitknot/execution/types';
import { reproduceRun } from '@gitknot/execution/reproduce';
import { authorizeWorkflowOperation, operationAuthorization, operationResponse, planningRunRepresentation, publicWorkflowOperation, recoverWorkflowOperation, requestWorkflowOperation, workflowOperationAuthorizer } from '@gitknot/execution/operations';
import type { WorkflowOperation } from '@gitknot/execution/operations';
import type { IdempotencyOptions } from '@gitknot/core';
import { createWorkflowPlanPreview, readWorkflowPreview, validateWorkflowSource, workflowPreviewRecovery } from '@gitknot/execution/previews';
import { workflowPreviewSchema, workflowValidationSchema } from '@gitknot/execution/preview-source';
import { authorizedRun as readAuthorizedRun, authorizeRunRead, executionNotFound, executionReadPage, executionReadResponse, freshExecutionReader, repositoryReadAuthorizer, runReadAuthorizer, visibleExecutionRecord } from '@gitknot/execution/reads';
import { deleteWorkflowEnvironment, environmentDeletionRecovery } from '@gitknot/execution/environment-lifecycle';

const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const definitionSchema = z.object({ path: z.string().regex(/^\.gitknot\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/), source_commit: commit }).strict();
const runSchema = z.object({ workflow_id: z.string().min(1), commit, ref: z.string().regex(/^refs\/(heads|tags)\/[^\s\x00-\x1f]+$/),
  event: z.object({ type: z.enum(['workflow.dispatch', 'workflow.manual', 'workflow_dispatch.requested']).default('workflow.dispatch'), pull_request_id: z.string().optional(), merge_candidate_id: z.string().optional(), inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional() }).strict().default({ type: 'workflow.dispatch' }),
}).strict();
const rerunSchema = z.object({ jobs: z.array(z.string()).max(128).default([]) }).strict();
const runListSchema = z.object({ workflow_id: z.string().regex(/^wf_[A-Za-z0-9_-]+$/).optional(), commit: commit.optional(),
  status: z.enum(['planning', 'queued', 'running', 'waiting', 'waiting_approval', 'cancelling', 'succeeded', 'failed', 'cancelled', 'timed_out', 'not_applicable', 'runner_unreachable']).optional(),
  cursor: z.string().optional(), limit: z.string().optional() }).strict();
const logListSchema = z.object({ attempt_id: z.string().regex(/^att_[A-Za-z0-9_-]+$/).optional(),
  job_id: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/).optional(), cursor: z.string().optional(), limit: z.string().optional() }).strict();
const environmentSchema = z.object({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/), destination: z.string().regex(/^release:[a-zA-Z0-9][a-zA-Z0-9_./-]{0,127}$/),
  target_ref: z.string().regex(/^refs\/heads\/[^\s\x00-\x1f]+$/), required_approvals: z.number().int().min(0).max(10).default(1), allow_self_approval: z.boolean().default(false), allowed_approvers: z.array(z.string()).max(100).default([]) }).strict();
const promotionSchema = z.object({ environment_id: z.string(), artifact_id: z.string() }).strict();
const approvalSchema = z.object({ promotion_id: z.string(), decision: z.enum(['approved', 'rejected']) }).strict();
const policySchema = z.object({
  policy: z.object({ access: z.object({ repository: z.enum(['none', 'read']), capabilities: z.array(z.string()).max(128).default([]), secrets: z.array(z.string()).max(64).default([]) }).strict(),
    hosted_profiles: z.array(z.string()).max(16), self_hosted_pools: z.record(z.string(), z.object({ trust: z.enum(['trusted', 'untrusted']), disposable: z.boolean() }).strict()),
    inapplicable_jobs: z.array(z.string()).max(128), allowed_toolchains: z.array(z.string()).max(128).optional(), allowed_modules: z.record(z.string(), z.string()).optional(),
    environments: z.record(z.string(), z.object({ approval_required: z.boolean(), allowed_jobs: z.array(z.string()).optional() }).strict()).optional(),
  }).strict(), toolchains: z.record(z.string(), toolchainSchema), modules: z.record(z.string(), z.json()).default({}),
  infrastructure_retries: z.number().int().min(0).max(2).default(1),
  egress: z.object({ hosts: z.array(z.string().regex(/^(?!.*\.internal$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/)).max(64),
    max_requests: z.number().int().min(0).max(EXECUTION_LIMITS.egress_requests), max_bytes: z.number().int().min(0).max(EXECUTION_LIMITS.egress_bytes),
    max_request_bytes: z.number().int().min(0).max(EXECUTION_LIMITS.egress_request_bytes) }).strict(),
}).strict();

function publicRun(run: RunRecord): Record<string, unknown> {
  const { plan_json, request_key, request_hash, ...publicFields } = run;
  void plan_json; void request_key; void request_hash;
  return publicFields;
}
function publicAttempt(attempt: AttemptRecord): Record<string, unknown> {
  const { credential_hash, cleanup_lease_hash, runner_credential_hash, runner_slot_fence, reservation_fence, runtime_name, runtime_id, checkout_credential_id, ...publicFields } = attempt;
  void credential_hash; void cleanup_lease_hash; void runner_credential_hash; void runner_slot_fence; void reservation_fence; void runtime_name; void runtime_id; void checkout_credential_id;
  return { ...publicFields, outcome: attempt.outcome_json ? JSON.parse(attempt.outcome_json) : null, outcome_json: undefined };
}
function publicObject(object: ExecutionObject): Record<string, unknown> {
  const { object_key, ...publicFields } = object; void object_key;
  return { ...publicFields, download_path: `/v1/runs/${object.run_id}/outputs/${object.id}` };
}

async function authorizedRun(c: AppContext, capability = 'runs.read'): Promise<RunRecord> {
  return readAuthorizedRun(c, c.req.param('id') ?? '', capability);
}

function runRead(handler: (c: AppContext, run: RunRecord) => Promise<Response> | Response): (c: AppContext) => Promise<Response> {
  return async c => {
    const run = await authorizedRun(c), recheck = runReadAuthorizer(c, run);
    let response: Response;
    try { response = await handler(c, run); }
    catch (error) { await recheck(); throw error; }
    return executionReadResponse(c, response, recheck);
  };
}

function queryInput<S extends z.ZodType>(c: AppContext, schema: S): z.infer<S> {
  const result = schema.safeParse(c.req.query());
  if (!result.success || Object.values(c.req.queries()).some(values => values.length !== 1)) {
    throw new ApiError(422, 'invalid_query', 'Use the documented execution filters with one valid value per parameter.');
  }
  return result.data;
}

async function listRuns(c: AppContext): Promise<Response> {
  const repo = await getRepository(c, c.req.param('repoId'), 'runs.read'), input = queryInput(c, runListSchema), db = database(c);
  const filters = { workflow_id: input.workflow_id ?? null, status: input.status ?? null, commit: input.commit ?? null };
  const shown = new Map<string, { body: Record<string, unknown>; recheck: () => Promise<void> }>();
  const result = await executionReadPage(c, `runs:${repo.id}:${JSON.stringify(filters)}`, (after, limit) => many<{ id: string }>(db, `
    SELECT r.id FROM workflow_runs r WHERE r.repo_id=? AND r.id>? AND (? IS NULL OR r.workflow_id=?) AND (? IS NULL OR r.status=?) AND (? IS NULL OR r.commit_sha=?)
    UNION SELECT q.run_id AS id FROM workflow_run_requests q LEFT JOIN workflow_runs parent ON parent.id=json_extract(q.input_json,'$.input.parent_run_id') AND parent.repo_id=q.repo_id
      WHERE q.repo_id=? AND q.run_id>? AND q.kind IN ('run','rerun') AND q.status IN ('pending','running','failed','cancelled')
        AND NOT EXISTS (SELECT 1 FROM workflow_runs actual WHERE actual.id=q.run_id AND actual.repo_id=q.repo_id)
        AND (? IS NULL OR COALESCE(json_extract(q.input_json,'$.input.workflow_id'),parent.workflow_id)=?)
        AND (? IS NULL OR CASE WHEN q.status IN ('pending','running') THEN 'planning' ELSE q.status END=?)
        AND (? IS NULL OR COALESCE(json_extract(q.input_json,'$.input.spec.commit'),parent.commit_sha)=?)
    ORDER BY id LIMIT ?`, repo.id, after, filters.workflow_id, filters.workflow_id, filters.status, filters.status, filters.commit, filters.commit,
  repo.id, after, filters.workflow_id, filters.workflow_id, filters.status, filters.status, filters.commit, filters.commit, limit), row => visibleExecutionRecord(async () => {
    const operation = await one<WorkflowOperation>(db, `SELECT * FROM workflow_run_requests WHERE run_id=? AND repo_id=? AND kind IN ('run','rerun') ORDER BY created_at LIMIT 1`, row.id, repo.id);
    const run = await one<RunRecord>(db, 'SELECT * FROM workflow_runs WHERE id=? AND repo_id=?', row.id, repo.id);
    if (run) {
      await authorizeRunRead(freshExecutionReader(c), run);
      if (filters.workflow_id && run.workflow_id !== filters.workflow_id || filters.status && run.status !== filters.status || filters.commit && run.commit_sha !== filters.commit) executionNotFound();
      shown.set(row.id, { body: publicRun(run), recheck: runReadAuthorizer(c, run) });
    } else {
      if (!operation) executionNotFound();
      await authorizeWorkflowOperation(freshExecutionReader(c), operation);
      const body = await planningRunRepresentation(db, operation);
      if (filters.workflow_id && body.workflow_id !== filters.workflow_id || filters.status && body.status !== filters.status || filters.commit && body.requested_commit_sha !== filters.commit) executionNotFound();
      shown.set(row.id, { body, recheck: workflowOperationAuthorizer(c, operation) });
    }
  }));
  const recheck = async () => {
    await repositoryReadAuthorizer(c, repo.id, 'runs.read')();
    for (const row of result.items) await shown.get(row.id)!.recheck();
  };
  return executionReadResponse(c, listResponse(c, result.items.map(row => shown.get(row.id)!.body), result.next_cursor), recheck);
}

interface TriggerFailure { id: string; event_id: string; workflow_id: string; repo_id: string; audience_json: string | null }

function failureAuthorizer(c: AppContext, failure: TriggerFailure): () => Promise<void> {
  let audience: unknown;
  try { audience = failure.audience_json ? JSON.parse(failure.audience_json) : null; } catch { executionNotFound(); }
  if (!Array.isArray(audience) || !audience.includes(failure.repo_id) || audience.length > 32
    || audience.some(id => typeof id !== 'string' || !/^r_[A-Za-z0-9_-]+$/.test(id))) executionNotFound();
  return repositoryReadAuthorizer(c, failure.repo_id, 'workflows.read', audience as string[]);
}

function requireRevision(c: AppContext, revision: number): number {
  const expected = expectedRevision(c);
  if (revision !== expected) throw new ApiError(412, 'revision_conflict', 'The resource changed. Refresh its ETag and retry.');
  return expected;
}

async function idempotency(c: AppContext, body: unknown): Promise<{ key: string; hash: string }> {
  const key = c.req.header('idempotency-key');
  if (!key || !/^[\x21-\x7e]{1,128}$/.test(key)) throw new ApiError(400, 'idempotency_required', 'Provide a stable Idempotency-Key for this operation.');
  return { key: `${requirePrincipal(c).id}:${key}`, hash: await sha256(JSON.stringify({ path: c.req.path, body })) };
}

export function registerWorkflowsRoutes(app: App): void {
  registerWorkflowPreviews(app);
  registerDefinitions(app);
  registerRuns(app);
  registerEnvironments(app);
  route(app, 'GET', '/v1/workflow-operations/:operationId', { summary: 'Read a durable workflow operation', capability: 'runs.read' }, async c => {
    const operation = await one<WorkflowOperation>(database(c), 'SELECT * FROM workflow_run_requests WHERE id=?', c.req.param('operationId'));
    if (!operation) executionNotFound();
    await authorizeWorkflowOperation(c, operation);
    return executionReadResponse(c, resourceResponse(c, { ...publicWorkflowOperation(operation), revision: operation.revision }), workflowOperationAuthorizer(c, operation));
  });
  route(app, 'GET', '/v1/hosted-profiles', { summary: 'List measured hosted execution profiles', public: true }, c => listResponse(c, hostedProfiles(c.env).map(profile => ({
    name: profile.name, os: 'linux', architecture: 'amd64', vcpu: profile.vcpu, memory_mib: profile.memory_mib, disk_mb: profile.disk_mb,
    maximum_job_ms: profile.max_job_ms, toolchain_digest: profile.toolchain_digest, measurement: profile.measurement,
  }))));
}

function registerWorkflowPreviews(app: App): void {
  route(app, 'POST', '/v1/repos/:repoId/workflows/validate', { summary: 'Validate workflow source, current policy and cost without execution',
    body: workflowValidationSchema, capability: 'workflows.run', idempotency: workflowPreviewRecovery }, async c =>
    validateWorkflowSource(c, await jsonBody(c, workflowValidationSchema)));
  route(app, 'POST', '/v1/repos/:repoId/workflows/:workflowId/plan', { summary: 'Create an immutable, expiring execution plan preview',
    body: workflowPreviewSchema, capability: 'workflows.run', idempotency: workflowPreviewRecovery }, async c =>
    createWorkflowPlanPreview(c, c.req.param('workflowId')!, await jsonBody(c, workflowPreviewSchema)));
  route(app, 'GET', '/v1/repos/:repoId/plans/:planId', { summary: 'Read a current-authorized immutable compiler preview', capability: 'workflows.run' }, c =>
    readWorkflowPreview(c, c.req.param('planId')!));
}

function registerDefinitions(app: App): void {
  route(app, 'GET', '/v1/repos/:repoId/workflow-trigger-failures', { summary: 'Explain rejected automatic workflow plans', capability: 'workflows.read' }, async c => {
    const repo = await getRepository(c, c.req.param('repoId'), 'workflows.read');
    const result = await executionReadPage(c, `workflow-failures:${repo.id}`, (after, limit) => many<TriggerFailure>(database(c), `SELECT *,event_id||':'||workflow_id||':'||commit_sha AS id
      FROM workflow_trigger_failures WHERE repo_id=? AND event_id||':'||workflow_id||':'||commit_sha>? ORDER BY id LIMIT ?`, repo.id, after, limit),
    failure => visibleExecutionRecord(() => failureAuthorizer(c, failure)()));
    const recheck = async () => {
      await repositoryReadAuthorizer(c, repo.id, 'workflows.read')();
      for (const failure of result.items) await failureAuthorizer(c, failure)();
    };
    return executionReadResponse(c, listResponse(c, result.items.map(({ id, audience_json, ...failure }) => { void id; void audience_json; return failure; }), result.next_cursor), recheck);
  });
  route(app, 'GET', '/v1/repos/:repoId/workflows', { summary: 'List trusted workflow definitions', capability: 'workflows.read' }, async c => {
    const repo = await getRepository(c, c.req.param('repoId'), 'workflows.read'), pagination = page(c);
    const rows = await many<WorkflowRecord>(database(c), 'SELECT * FROM workflows WHERE repo_id=? AND id>? ORDER BY id LIMIT ?', repo.id, pagination.cursor ?? '', pagination.limit + 1);
    return executionReadResponse(c, listResponse(c, rows.slice(0, pagination.limit), rows.length > pagination.limit ? rows[pagination.limit - 1]!.id : null), repositoryReadAuthorizer(c, repo.id, 'workflows.read'));
  });
  route(app, 'POST', '/v1/repos/:repoId/workflows', { summary: 'Approve an immutable workflow revision', body: definitionSchema, capability: 'workflows.manage' }, async c => {
    const repo = await getRepository(c, c.req.param('repoId'), 'workflows.manage'), input = await jsonBody(c, definitionSchema), actor = requirePrincipal(c), db = database(c);
    const policy = await one<ExecutionPolicyRow>(db, 'SELECT * FROM workflow_execution_policy WHERE repo_id=?', repo.id);
    const source = await readWorkflowSource(c.env, repo.id, input.source_commit, input.path, actor), definition = validatedDefinition(source, policy ? JSON.parse(policy.modules_json) : {});
    const digest = await definitionDigest(definition), id = newId('wf'), versionId = newId('wfv'), at = now();
    await mutate(c, { sql: `INSERT INTO workflows (id,repo_id,account_id,name,path,current_version_id,created_by,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM repositories WHERE id=? AND owner_id=? AND state='active' AND policy_revision=?)`,
      bindings: [id, repo.id, repo.owner_id, definition.name, input.path, versionId, actor.id, at, at, repo.id, repo.owner_id, repo.policy_revision], after: [
      stmt(db, `INSERT INTO workflow_versions (id,workflow_id,repo_id,account_id,source_commit,definition_digest,definition,definition_json,policy_revision,approved_by,approved_credential_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        versionId, id, repo.id, repo.owner_id, input.source_commit, digest, source, JSON.stringify(definition), repo.policy_revision, actor.id, actor.credential_id, at),
      ], event: { type: 'workflow.definition.approved', resource_id: id, resource_revision: 1, repo_id: repo.id, account_id: repo.owner_id, actor_id: actor.id, data: { workflow_version_id: versionId, definition_digest: digest, source_commit: input.source_commit } },
      audit: { action: 'workflows.approve', resource_id: id, repo_id: repo.id, account_id: repo.owner_id, actor_id: actor.id, details: { workflow_version_id: versionId, policy_revision: repo.policy_revision, definition_digest: digest } } });
    return resourceResponse(c, { id, repo_id: repo.id, name: definition.name, path: input.path, current_version_id: versionId, revision: 1, definition_digest: digest }, 201);
  });
  route(app, 'GET', '/v1/repos/:repoId/workflows/:workflowId', { summary: 'Read the approved workflow source', capability: 'workflows.read' }, async c => {
    const repo = await getRepository(c, c.req.param('repoId'), 'workflows.read');
    const workflow = await one<WorkflowRecord>(database(c), 'SELECT * FROM workflows WHERE id=? AND repo_id=?', c.req.param('workflowId'), repo.id);
    if (!workflow) throw new ApiError(404, 'not_found', 'The workflow was not found.');
    const version = await one<WorkflowVersion>(database(c), 'SELECT * FROM workflow_versions WHERE id=? AND repo_id=?', workflow.current_version_id, repo.id);
    return executionReadResponse(c, resourceResponse(c, { ...workflow, version }), repositoryReadAuthorizer(c, repo.id, 'workflows.read'));
  });
  route(app, 'GET', '/v1/repos/:repoId/workflows/:workflowId/versions', { summary: 'List immutable approved workflow version history', capability: 'workflows.read' }, async c => {
    const repo = await getRepository(c, c.req.param('repoId'), 'workflows.read'), pagination = page(c), db = database(c);
    const workflow = await one<WorkflowRecord>(db, 'SELECT * FROM workflows WHERE id=? AND repo_id=?', c.req.param('workflowId'), repo.id);
    if (!workflow) executionNotFound();
    const rows = await many<WorkflowVersion>(db, 'SELECT * FROM workflow_versions WHERE workflow_id=? AND repo_id=? AND id>? ORDER BY id LIMIT ?',
      workflow.id, repo.id, pagination.cursor ?? '', pagination.limit + 1);
    return executionReadResponse(c, listResponse(c, rows.slice(0, pagination.limit), rows.length > pagination.limit ? rows[pagination.limit - 1]!.id : null),
      repositoryReadAuthorizer(c, repo.id, 'workflows.read'));
  });
  route(app, 'PUT', '/v1/repos/:repoId/workflows/:workflowId', { summary: 'Approve a new immutable workflow version', body: definitionSchema, capability: 'workflows.manage' }, async c => {
    const repo = await getRepository(c, c.req.param('repoId'), 'workflows.manage'), db = database(c), input = await jsonBody(c, definitionSchema), actor = requirePrincipal(c);
    const workflow = await one<WorkflowRecord>(db, 'SELECT * FROM workflows WHERE id=? AND repo_id=?', c.req.param('workflowId'), repo.id);
    if (!workflow) throw new ApiError(404, 'not_found', 'The workflow was not found.');
    const revision = requireRevision(c, workflow.revision), source = await readWorkflowSource(c.env, repo.id, input.source_commit, input.path, actor);
    const policy = await one<ExecutionPolicyRow>(db, 'SELECT * FROM workflow_execution_policy WHERE repo_id=?', repo.id);
    const definition = validatedDefinition(source, policy ? JSON.parse(policy.modules_json) : {}), digest = await definitionDigest(definition), versionId = newId('wfv'), at = now();
    await mutate(c, { sql: `UPDATE workflows SET name=?,path=?,current_version_id=?,state='active',revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND revision=?`,
      bindings: [definition.name, input.path, versionId, at, workflow.id, repo.id, revision], event: { type: 'workflow.definition.approved', resource_id: workflow.id, resource_revision: revision + 1, repo_id: repo.id, account_id: repo.owner_id,
        data: { workflow_version_id: versionId, definition_digest: digest } }, after: [stmt(db, `INSERT INTO workflow_versions (id,workflow_id,repo_id,account_id,source_commit,definition_digest,definition,definition_json,policy_revision,approved_by,approved_credential_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        versionId, workflow.id, repo.id, repo.owner_id, input.source_commit, digest, source, JSON.stringify(definition), repo.policy_revision, actor.id, actor.credential_id, at)] });
    return resourceResponse(c, { id: workflow.id, current_version_id: versionId, revision: revision + 1, definition_digest: digest });
  });
  route(app, 'DELETE', '/v1/repos/:repoId/workflows/:workflowId', { summary: 'Disable future workflow runs', capability: 'workflows.manage' }, async c => {
    const repo = await getRepository(c, c.req.param('repoId'), 'workflows.manage'), revision = expectedRevision(c);
    await mutate(c, { sql: `UPDATE workflows SET state='disabled',revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND revision=?`, bindings: [now(), c.req.param('workflowId'), repo.id, revision],
      event: { type: 'workflow.disabled', resource_id: c.req.param('workflowId')!, resource_revision: revision + 1, repo_id: repo.id, account_id: repo.owner_id } });
    return c.body(null, 204);
  });
  route(app, 'GET', '/v1/repos/:repoId/workflow-policy', { summary: 'Read trusted workflow execution policy', capability: 'rules.read' }, async c => {
    const repo = await getRepository(c, c.req.param('repoId'), 'rules.read'), row = await one<ExecutionPolicyRow>(database(c), 'SELECT * FROM workflow_execution_policy WHERE repo_id=?', repo.id);
    return executionReadResponse(c, resourceResponse(c, row ? { repo_id: repo.id, policy: JSON.parse(row.policy_json), toolchains: JSON.parse(row.toolchains_json), modules: JSON.parse(row.modules_json), egress: JSON.parse(row.egress_json), infrastructure_retries: row.infrastructure_retries, revision: repo.revision, policy_revision: repo.policy_revision }
      : { repo_id: repo.id, configured: false, revision: repo.revision, policy_revision: repo.policy_revision }), repositoryReadAuthorizer(c, repo.id, 'rules.read'));
  });
  route(app, 'PUT', '/v1/repos/:repoId/workflow-policy', { summary: 'Configure trusted toolchains, modules, access and egress', body: policySchema, capability: 'rules.manage' }, async c => {
    const repo = await getRepository(c, c.req.param('repoId'), 'rules.manage'), input = await jsonBody(c, policySchema), revision = requireRevision(c, repo.revision), at = now();
    await mutate(c, { sql: 'UPDATE repositories SET policy_revision=policy_revision+1,revision=revision+1,updated_at=? WHERE id=? AND revision=?', bindings: [at, repo.id, revision],
      event: { type: 'workflow.policy.updated', resource_id: repo.id, resource_revision: revision + 1, repo_id: repo.id, account_id: repo.owner_id }, after: [
        stmt(database(c), `INSERT INTO workflow_execution_policy (repo_id,account_id,policy_json,toolchains_json,modules_json,egress_json,infrastructure_retries,updated_by,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(repo_id) DO UPDATE SET policy_json=excluded.policy_json,toolchains_json=excluded.toolchains_json,modules_json=excluded.modules_json,egress_json=excluded.egress_json,infrastructure_retries=excluded.infrastructure_retries,revision=revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
        repo.id, repo.owner_id, JSON.stringify(input.policy), JSON.stringify(input.toolchains), JSON.stringify(input.modules), JSON.stringify(input.egress), input.infrastructure_retries, requirePrincipal(c).id, at),
      ] });
    return resourceResponse(c, { ...input, repo_id: repo.id, revision: revision + 1, policy_revision: repo.policy_revision + 1 });
  });
}

function registerRuns(app: App): void {
  route(app, 'POST', '/v1/repos/:repoId/workflows/:workflowId/runs', { summary: 'Run an approved workflow by ID or name', body: runSchema.omit({ workflow_id: true }), capability: 'workflows.run', idempotency: externalWorkflowRecovery(async c => {
    const body = await jsonBody(c, runSchema.omit({ workflow_id: true })); return queueRunResponse(c, { ...body, workflow_id: c.req.param('workflowId')! });
  }) }, async c => {
    const body = await jsonBody(c, runSchema.omit({ workflow_id: true }));
    return queueRunResponse(c, { ...body, workflow_id: c.req.param('workflowId')! });
  });
  route(app, 'GET', '/v1/repos/:repoId/runs', { summary: 'List audience-authorized runs and planning requests by workflow_id, status and commit', capability: 'runs.read' }, listRuns);
  route(app, 'POST', '/v1/repos/:repoId/runs', { summary: 'Compile and queue an immutable trusted workflow plan', body: runSchema, capability: 'workflows.run', idempotency: externalWorkflowRecovery(async c => queueRunResponse(c, await jsonBody(c, runSchema))) }, async c => {
    return queueRunResponse(c, await jsonBody(c, runSchema));
  });
  route(app, 'GET', '/v1/runs/:id', { summary: 'Read durable run status and provenance', capability: 'runs.read' }, async c => {
    const request = await one<WorkflowOperation>(database(c), `SELECT * FROM workflow_run_requests WHERE run_id=? AND kind IN ('run','rerun') ORDER BY created_at LIMIT 1`, c.req.param('id'));
    const existing = await one<RunRecord>(database(c), 'SELECT * FROM workflow_runs WHERE id=?', c.req.param('id'));
    if (!existing && request) {
      await authorizeWorkflowOperation(c, request);
      return executionReadResponse(c, resourceResponse(c, { id: request.run_id, repo_id: request.repo_id, operation_id: request.id, status: request.status === 'failed' ? 'failed' : request.status === 'cancelled' ? 'cancelled' : 'planning',
        revision: request.revision, created_at: request.created_at, ...(request.error_json ? { error: JSON.parse(request.error_json) } : {}) }), workflowOperationAuthorizer(c, request));
    }
    const run = await authorizedRun(c);
    return executionReadResponse(c, resourceResponse(c, { ...publicRun(run), revision: run.revision }), runReadAuthorizer(c, run));
  });
  route(app, 'GET', '/v1/runs/:id/jobs', { summary: 'Read every explicit dependency graph outcome', capability: 'runs.read' }, runRead(async (c, run) => {
    const pagination = page(c);
    const rows = await many<JobRecord>(database(c), 'SELECT * FROM workflow_jobs WHERE run_id=? AND repo_id=? AND job_key>? ORDER BY job_key LIMIT ?', run.id, run.repo_id, pagination.cursor ?? '', pagination.limit + 1);
    return listResponse(c, rows.slice(0, pagination.limit).map(({ definition_json, ...job }) => ({ ...job, definition: JSON.parse(definition_json) })), rows.length > pagination.limit ? rows[pagination.limit - 1]!.job_key : null);
  }));
  route(app, 'GET', '/v1/runs/:id/manifest', { summary: 'Read the immutable portable run manifest', capability: 'runs.read' }, runRead((c, run) => {
    const plan = JSON.parse(run.plan_json) as ExecutionPlan;
    c.header('etag', `"${run.plan_digest}"`);
    return c.json(plan.portable_manifest);
  }));
  route(app, 'GET', '/v1/runs/:id/attempts', { summary: 'Read fenced attempt and cleanup history', capability: 'runs.read' }, runRead(async (c, run) => {
    const pagination = page(c);
    const rows = await many<AttemptRecord>(database(c), 'SELECT * FROM execution_attempts WHERE run_id=? AND repo_id=? AND id>? ORDER BY id LIMIT ?', run.id, run.repo_id, pagination.cursor ?? '', pagination.limit + 1);
    return listResponse(c, rows.slice(0, pagination.limit).map(publicAttempt), rows.length > pagination.limit ? rows[pagination.limit - 1]!.id : null);
  }));
  route(app, 'GET', '/v1/runs/:id/logs', { summary: 'Read numbered, redacted, checksummed log chunks', capability: 'runs.read' }, runRead(async (c, run) => {
    const input = queryInput(c, logListSchema), pagination = page(c), db = database(c);
    const jobs = input.job_id ? await many<{ id: string }>(db, 'SELECT id FROM workflow_jobs WHERE run_id=? AND repo_id=? AND (id=? OR job_key=?) LIMIT 2', run.id, run.repo_id, input.job_id, input.job_id) : [];
    if (jobs.length > 1) throw new ApiError(422, 'ambiguous_job', 'Select this log job by its unambiguous immutable job ID.');
    const rows = await many<ExecutionObject>(db, `SELECT o.* FROM execution_objects o JOIN execution_attempts a ON a.id=o.attempt_id AND a.repo_id=o.repo_id AND a.run_id=o.run_id
      WHERE o.run_id=? AND o.repo_id=? AND o.kind='log' AND o.state='sealed' AND o.expires_at>?
      AND (? IS NULL OR o.attempt_id=?) AND (? IS NULL OR a.job_id=?) AND o.id>? ORDER BY o.id LIMIT ?`,
    run.id, run.repo_id, now(), input.attempt_id ?? null, input.attempt_id ?? null, input.job_id ?? null, jobs[0]?.id ?? null, pagination.cursor ?? '', pagination.limit + 1);
    const items = await Promise.all(rows.slice(0, pagination.limit).map(async object => {
      const data = await c.env.BLOBS.get(object.object_key);
      if (!data) throw new ApiError(410, 'log_expired', 'A retained log chunk is no longer available.');
      return { ...publicObject(object), text: await data.text() };
    }));
    return listResponse(c, items, rows.length > pagination.limit ? rows[pagination.limit - 1]!.id : null);
  }));
  route(app, 'GET', '/v1/runs/:id/outputs', { summary: 'List verified output manifests and provenance', capability: 'runs.read' }, runRead(async (c, run) => {
    const pagination = page(c);
    const rows = await many<ExecutionObject>(database(c), `SELECT o.* FROM execution_objects o JOIN execution_attempts a ON a.id=o.attempt_id AND a.repo_id=o.repo_id
      WHERE o.run_id=? AND o.repo_id=? AND o.kind='manifest' AND o.name LIKE 'output:%' AND o.state='sealed' AND a.receipt_hash IS NOT NULL AND a.status IN ('succeeded','failed','timed_out') AND o.id>? ORDER BY o.id LIMIT ?`, run.id, run.repo_id, pagination.cursor ?? '', pagination.limit + 1);
    return listResponse(c, rows.slice(0, pagination.limit).map(publicObject), rows.length > pagination.limit ? rows[pagination.limit - 1]!.id : null);
  }));
  route(app, 'GET', '/v1/runs/:id/outputs/:objectId', { summary: 'Stream an authorized checksummed run artifact', capability: 'runs.read', streaming: true }, runRead(async (c, run) => {
    const object = await one<ExecutionObject>(database(c), `SELECT o.* FROM execution_objects o JOIN execution_attempts a ON a.id=o.attempt_id AND a.repo_id=o.repo_id
      WHERE o.id=? AND o.repo_id=? AND o.run_id=? AND o.kind='manifest' AND o.state='sealed' AND o.expires_at>? AND a.receipt_hash IS NOT NULL AND a.status IN ('succeeded','failed','timed_out')`, c.req.param('objectId'), run.repo_id, run.id, now());
    if (!object) throw new ApiError(404, 'not_found', 'The retained output was not found.');
    return new Response(await streamManifest(executionRequestEnvironment(c), object), { headers: { 'content-type': 'application/octet-stream', 'etag': `"sha256:${object.source_digest}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
  }));
  route(app, 'POST', '/v1/runs/:id/cancel', { summary: 'Fence credentials and request verified executor termination', body: z.object({}).strict(), capability: 'workflows.run', idempotency: externalWorkflowRecovery(requestCancellation) }, requestCancellation);
  route(app, 'POST', '/v1/runs/:id/rerun', { summary: 'Rerun selected jobs and affected dependents with frozen inputs', body: rerunSchema, capability: 'workflows.run', idempotency: externalWorkflowRecovery(requestRerun) }, requestRerun);
  route(app, 'GET', '/v1/runs/:id/reproduce', { summary: 'Retrieve pinned inputs and toolchains for local reproduction', capability: 'runs.read', sensitive: true }, runRead(async (c, run) => {
    c.header('cache-control', 'no-store');
    if (c.req.query('job_id') !== undefined) throw new ApiError(422, 'invalid_query', 'Select the reproduction job with the canonical job query parameter.');
    return c.json(await reproduceRun(c, run, c.req.query('job')));
  }));
  route(app, 'GET', '/v1/runs/:id/reproduction-inputs/:objectId', { summary: 'Stream an immutable reproduction dependency', capability: 'runs.read', streaming: true }, runRead(async (c, run) => {
    const object = await one<ExecutionObject>(database(c), `SELECT o.* FROM execution_objects o JOIN workflow_jobs j ON COALESCE(j.current_attempt_id,j.reused_attempt_id)=o.attempt_id
      WHERE j.run_id=? AND j.repo_id=? AND o.repo_id=j.repo_id AND j.status='succeeded' AND o.id=? AND o.kind='manifest' AND o.name LIKE 'output:%' AND o.state='sealed' AND o.expires_at>?`, run.id, run.repo_id, c.req.param('objectId'), now());
    if (!object) throw new ApiError(404, 'not_found', 'The retained reproduction input was not found.');
    return new Response(await streamManifest(executionRequestEnvironment(c), object), { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store' } });
  }));
}

async function queueRunResponse(c: AppContext, input: z.infer<typeof runSchema>): Promise<Response> {
  const repo = await getRepository(c, c.req.param('repoId'), 'workflows.run'), db = database(c);
  const workflow = await one<WorkflowRecord>(db, 'SELECT * FROM workflows WHERE repo_id=? AND (id=? OR name=?)', repo.id, input.workflow_id, input.workflow_id);
  if (!workflow) throw new ApiError(404, 'not_found', 'The workflow was not found.');
  const version = await one<WorkflowVersion>(db, 'SELECT * FROM workflow_versions WHERE id=? AND repo_id=?', workflow.current_version_id, repo.id);
  if (!version) throw new ApiError(409, 'workflow_version_missing', 'The approved workflow version is missing.');
  const operation = await requestWorkflowOperation(c, repo.id, repo.owner_id, { kind: 'run', workflow_id: workflow.id, workflow_version_id: version.id,
    spec: { commit: input.commit, ref: input.ref, event: { ...input.event, id: c.get('idempotency')?.operation_id ?? newId('evt') } } });
  return operationResponse(c, operation);
}

function externalWorkflowRecovery(startIntent: (c: AppContext) => Promise<Response>, capability = 'workflows.run'): IdempotencyOptions {
  return { strategy: 'external', authorization: (c, record) => operationAuthorization(c, record, capability), recover: async (c, record) => {
    const recovered = await recoverWorkflowOperation(c, record);
    if (recovered) return recovered;
    if (record.committed_at) throw new ApiError(503, 'workflow_journal_missing', 'The original committed workflow operation requires recovery.');
    return startIntent(c);
  } };
}

async function requestCancellation(c: AppContext): Promise<Response> {
  const run = await one<RunRecord>(database(c), 'SELECT * FROM workflow_runs WHERE id=?', c.req.param('id'));
  const pending = run ? null : await one<WorkflowOperation>(database(c), `SELECT * FROM workflow_run_requests WHERE run_id=? AND kind IN ('run','rerun')`, c.req.param('id'));
  const target = run ?? (pending ? { id: pending.run_id, repo_id: pending.repo_id, account_id: pending.account_id, revision: pending.revision } : null);
  if (!target) executionNotFound();
  if (run) await authorizeRunRead(c, run, 'workflows.run');
  else await authorizeWorkflowOperation(c, pending!, 'workflows.run');
  const revision = requireRevision(c, target.revision);
  return operationResponse(c, await requestWorkflowOperation(c, target.repo_id, target.account_id, {
    kind: 'cancel', reason: 'Cancellation requested.', run_revision: revision, planning_operation_id: pending?.id ?? null,
  }, target.id));
}

async function requestRerun(c: AppContext): Promise<Response> {
  const run = await authorizedRun(c, 'workflows.run'); requireRevision(c, run.revision);
  const input = await jsonBody(c, rerunSchema);
  return operationResponse(c, await requestWorkflowOperation(c, run.repo_id, run.account_id, { kind: 'rerun', parent_run_id: run.id, jobs: input.jobs }));
}

async function requestApproval(c: AppContext): Promise<Response> {
  const run = await authorizedRun(c, 'environments.approve'), input = await jsonBody(c, approvalSchema);
  const promotion = await one<PromotionRecord>(database(c), 'SELECT * FROM workflow_promotions WHERE id=? AND run_id=? AND repo_id=?', input.promotion_id, run.id, run.repo_id);
  if (!promotion) throw new ApiError(404, 'not_found', 'The approval request was not found.');
  requireRevision(c, promotion.revision);
  return operationResponse(c, await requestWorkflowOperation(c, run.repo_id, run.account_id, { kind: 'approve', promotion_id: promotion.id, promotion_revision: promotion.revision, decision: input.decision }, run.id));
}

async function requestPromotion(c: AppContext): Promise<Response> {
  const run = await authorizedRun(c, 'workflows.run');
  const promotion = await one<PromotionRecord>(database(c), 'SELECT * FROM workflow_promotions WHERE id=? AND run_id=? AND repo_id=?', c.req.param('promotionId'), run.id, run.repo_id);
  if (!promotion) throw new ApiError(404, 'not_found', 'The promotion was not found.');
  requireRevision(c, promotion.revision);
  return operationResponse(c, await requestWorkflowOperation(c, run.repo_id, run.account_id, { kind: 'promote', promotion_id: promotion.id, promotion_revision: promotion.revision }, run.id));
}

function registerEnvironments(app: App): void {
  route(app, 'GET', '/v1/repos/:repoId/environments/:envId', { summary: 'Read a protected artifact environment', capability: 'environments.read' }, async c => {
    const repo = await getRepository(c, c.req.param('repoId'), 'environments.read');
    const environment = await one<EnvironmentRecord>(database(c), 'SELECT * FROM workflow_environments WHERE id=? AND repo_id=?', c.req.param('envId'), repo.id);
    if (!environment) throw new ApiError(404, 'not_found', 'The environment was not found.');
    const { allowed_approvers_json, ...value } = environment;
    return executionReadResponse(c, resourceResponse(c, { ...value, allowed_approvers: JSON.parse(allowed_approvers_json) }), repositoryReadAuthorizer(c, repo.id, 'environments.read'));
  });
  route(app, 'GET', '/v1/repos/:repoId/environments', { summary: 'List protected artifact destinations', capability: 'environments.read' }, async c => {
    const repo = await getRepository(c, c.req.param('repoId'), 'environments.read'), pagination = page(c);
    const state = c.req.query('state') ?? 'active';
    if (!['active', 'deleted', 'all'].includes(state)) throw new ApiError(422, 'invalid_query', 'Environment state must be active, deleted or all.');
    const rows = await many<EnvironmentRecord>(database(c), 'SELECT * FROM workflow_environments WHERE repo_id=? AND (?=\'all\' OR state=?) AND id>? ORDER BY id LIMIT ?', repo.id, state, state, pagination.cursor ?? '', pagination.limit + 1);
    return executionReadResponse(c, listResponse(c, rows.slice(0, pagination.limit).map(({ allowed_approvers_json, ...env }) => ({ ...env, allowed_approvers: JSON.parse(allowed_approvers_json) })), rows.length > pagination.limit ? rows[pagination.limit - 1]!.id : null), repositoryReadAuthorizer(c, repo.id, 'environments.read'));
  });
  route(app, 'POST', '/v1/repos/:repoId/environments', { summary: 'Create a serialized protected artifact destination', body: environmentSchema, capability: 'environments.manage' }, async c => {
    const repo = await getRepository(c, c.req.param('repoId'), 'environments.manage'), input = await jsonBody(c, environmentSchema), id = newId('env'), at = now(), actor = requirePrincipal(c);
    await mutate(c, { sql: 'INSERT INTO workflow_environments (id,repo_id,account_id,name,destination,target_ref,required_approvals,allow_self_approval,allowed_approvers_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      bindings: [id, repo.id, repo.owner_id, input.name, input.destination, input.target_ref, input.required_approvals, input.allow_self_approval ? 1 : 0, JSON.stringify(input.allowed_approvers), at, at],
      event: { type: 'workflow.environment.created', resource_id: id, resource_revision: 1, repo_id: repo.id, account_id: repo.owner_id, actor_id: actor.id } });
    return resourceResponse(c, { id, repo_id: repo.id, ...input, state: 'active', deleted_at: null, deleted_by: null, revision: 1 }, 201);
  });
  route(app, 'PUT', '/v1/repos/:repoId/environments/:envId', { summary: 'Revise a protected environment and invalidate prior approvals', body: environmentSchema, capability: 'environments.manage' }, async c => {
    const repo = await getRepository(c, c.req.param('repoId'), 'environments.manage'), input = await jsonBody(c, environmentSchema), revision = expectedRevision(c), id = c.req.param('envId')!;
    const current = await one<EnvironmentRecord>(database(c), 'SELECT * FROM workflow_environments WHERE id=? AND repo_id=?', id, repo.id);
    if (!current) executionNotFound();
    if (current.state === 'deleted') throw new ApiError(410, 'environment_deleted', 'A retired environment cannot be changed or reactivated.');
    await mutate(c, { sql: 'UPDATE workflow_environments SET name=?,destination=?,target_ref=?,required_approvals=?,allow_self_approval=?,allowed_approvers_json=?,revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND revision=? AND state=\'active\'',
      bindings: [input.name, input.destination, input.target_ref, input.required_approvals, input.allow_self_approval ? 1 : 0, JSON.stringify(input.allowed_approvers), now(), id, repo.id, revision],
      event: { type: 'workflow.environment.updated', resource_id: id, resource_revision: revision + 1, repo_id: repo.id, account_id: repo.owner_id },
      after: [stmt(database(c), `UPDATE workflow_promotions SET status='invalidated',revision=revision+1,updated_at=? WHERE environment_id=? AND repo_id=? AND status IN ('waiting','waiting_approval','approved')`, now(), id, repo.id)] });
    return resourceResponse(c, { id, ...input, revision: revision + 1 });
  });
  route(app, 'DELETE', '/v1/repos/:repoId/environments/:envId', { summary: 'Retire an idle environment and retain immutable approval, release and vault history',
    capability: 'environments.manage', idempotency: environmentDeletionRecovery }, async c => {
    await deleteWorkflowEnvironment(c, c.req.param('envId')!);
    return c.body(null, 204);
  });
  route(app, 'GET', '/v1/runs/:id/approvals', { summary: 'Read exact artifact approval requests and decisions', capability: 'runs.read' }, runRead(async (c, run) => {
    const pagination = page(c);
    const rows = await many<PromotionRecord>(database(c), 'SELECT * FROM workflow_promotions WHERE run_id=? AND repo_id=? AND id>? ORDER BY id LIMIT ?', run.id, run.repo_id, pagination.cursor ?? '', pagination.limit + 1);
    const items = await Promise.all(rows.slice(0, pagination.limit).map(async row => ({ ...row,
      approvals: await many(database(c), 'SELECT * FROM environment_approvals WHERE promotion_id=? AND repo_id=? ORDER BY created_at,id', row.id, run.repo_id) })));
    return listResponse(c, items, rows.length > pagination.limit ? rows[pagination.limit - 1]!.id : null);
  }));
  route(app, 'POST', '/v1/runs/:id/promotions', { summary: 'Request promotion of an identical verified artifact', body: promotionSchema, capability: 'workflows.run', authorization: (c, record) => operationAuthorization(c, record) }, async c => {
    const run = await authorizedRun(c, 'workflows.run'), input = await jsonBody(c, promotionSchema), key = await idempotency(c, input), db = database(c);
    const environment = await one<EnvironmentRecord>(db, 'SELECT * FROM workflow_environments WHERE id=? AND repo_id=?', input.environment_id, run.repo_id);
    const artifact = await one<ExecutionObject>(db, 'SELECT * FROM execution_objects WHERE id=? AND repo_id=? AND run_id=?', input.artifact_id, run.repo_id, run.id);
    if (!environment || !artifact) throw new ApiError(404, 'not_found', 'The environment or verified artifact was not found.');
    const promotion = await createPromotion(db, run, environment, artifact, requirePrincipal(c).id, key.key, key.hash, null, c);
    return executionReadResponse(c, resourceResponse(c, promotion, 202), runReadAuthorizer(c, run, 'workflows.run'));
  });
  route(app, 'GET', '/v1/runs/:id/promotions/:promotionId', { summary: 'Read the current exact-artifact promotion', capability: 'runs.read' }, runRead(async (c, run) => {
    const promotion = await one<PromotionRecord>(database(c), 'SELECT * FROM workflow_promotions WHERE id=? AND run_id=? AND repo_id=?', c.req.param('promotionId'), run.id, run.repo_id);
    if (!promotion) throw new ApiError(404, 'not_found', 'The promotion was not found.');
    return resourceResponse(c, promotion);
  }));
  route(app, 'POST', '/v1/runs/:id/approvals', { summary: 'Approve or reject the exact artifact, commit, plan and destination', body: approvalSchema, capability: 'environments.approve', idempotency: externalWorkflowRecovery(requestApproval, 'environments.approve') }, requestApproval);
  route(app, 'POST', '/v1/runs/:id/promotions/:promotionId/promote', { summary: 'Publish the approved artifact after current accepted-target checks', body: z.object({}).strict(), capability: 'workflows.run', idempotency: externalWorkflowRecovery(requestPromotion) }, requestPromotion);
  route(app, 'GET', '/v1/repos/:repoId/releases', { summary: 'List immutable releases and artifact provenance', capability: 'releases.read' }, async c => {
    const repo = await getRepository(c, c.req.param('repoId'), 'releases.read');
    const result = await executionReadPage(c, `releases:${repo.id}`, (after, limit) => many<{ id: string; run_id: string }>(database(c),
      'SELECT * FROM workflow_releases WHERE repo_id=? AND id>? ORDER BY id LIMIT ?', repo.id, after, limit),
    release => visibleExecutionRecord(() => readAuthorizedRun(freshExecutionReader(c), release.run_id, 'releases.read')));
    const recheck = async () => {
      await repositoryReadAuthorizer(c, repo.id, 'releases.read')();
      for (const release of result.items) await readAuthorizedRun(freshExecutionReader(c), release.run_id, 'releases.read');
    };
    return executionReadResponse(c, listResponse(c, result.items, result.next_cursor), recheck);
  });
  route(app, 'GET', '/v1/repos/:repoId/releases/:releaseId', { summary: 'Read immutable release provenance', capability: 'releases.read' }, async c => {
    const repo = await getRepository(c, c.req.param('repoId'), 'releases.read');
    const release = await one<Record<string, unknown> & { run_id: string }>(database(c), 'SELECT * FROM workflow_releases WHERE id=? AND repo_id=?', c.req.param('releaseId'), repo.id);
    if (!release) executionNotFound();
    const run = await readAuthorizedRun(c, release.run_id, 'releases.read');
    return executionReadResponse(c, c.json(release), runReadAuthorizer(c, run, 'releases.read'));
  });
}
