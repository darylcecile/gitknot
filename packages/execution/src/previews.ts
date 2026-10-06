import { ApiError, authorize, canonicalJson, database, execute, newId, now, one, readRepositoryAuthority, requirePrincipal, sha256, stmt } from '@gitknot/core';
import type { AppContext, Bindings, IdempotencyOptions, Repository } from '@gitknot/core';
import { formatDollars } from '@gitknot/billing';
import { previewSecretsForPlan } from '@gitknot/secrets';
import { validateWorkflow } from '@gitknot/workflows';
import { z } from 'zod';
import { bindHostedManifest, compilePreparedWorkflow, definitionDigest, prepareWorkflowCompilation } from './planning.ts';
import type { ExecutionPolicyRow, WorkflowRecord, WorkflowVersion } from './planning.ts';
import { previewCompiledJobs, previewDiagnostic, previewVersionSteps } from './preview-jobs.ts';
import { inspectPreviewSource, previewAuthorization, previewRepository } from './preview-source.ts';
import type { PreviewSource, PreviewSourceInput, workflowValidationSchema } from './preview-source.ts';
import type { PreviewDiagnostic, WorkflowPreviewRecord, WorkflowPreviewSnapshot } from './preview-types.ts';
import { executionEnabled } from './config.ts';
import { executionRequestEnvironment, guardedBatch, primary } from './store.ts';
import { authorizeExecutionAudience, executionAudience, executionNotFound, executionReadResponse, freshExecutionReader, visibleExecutionRecord } from './reads.ts';

const previewLifetimeMs = 15 * 60_000;
const metadataLimit = 512 * 1024;
const maximumActivePreviews = 128;
const requirementsSchema = z.array(z.object({ capability: z.string().min(1).max(100), scope: z.object({ repo_id: z.string().optional(), account_id: z.string().optional(), ref: z.string().optional(), paths: z.array(z.string()).optional() }).strict() }).strict()).max(32);

interface PreviewDefinition { source: string; workflow: WorkflowRecord | null; version: WorkflowVersion | null }

export const workflowPreviewRecovery: IdempotencyOptions = {
  authorization: c => previewAuthorization(c),
  recover: async (c, record) => record.resource_id ? readWorkflowPreview(c, record.resource_id) : null,
};

function initialSnapshot(repository: Repository, kind: WorkflowPreviewSnapshot['kind'], input: PreviewSourceInput, ref: string, definition: PreviewDefinition): WorkflowPreviewSnapshot {
  return { kind, valid: false, executable: false,
    definition: { origin: kind === 'plan' ? 'approved_workflow' : 'submitted_draft', digest: null, workflow_id: definition.workflow?.id ?? null,
      workflow_version_id: definition.version?.id ?? null, source_commit: definition.version?.source_commit ?? null },
    source: { commit: input.commit_oid ?? null, ref, repository_id: repository.id, related_repository_ids: [repository.id], head_repository_id: repository.id,
      head_oid: null, target_oid: null, pull_request_id: input.pull_request_id ?? null, merge_candidate_id: input.merge_candidate_id ?? null, verified: false },
    policy_revision: repository.policy_revision, routing_epoch: repository.routing_epoch, trust: null, manifest_digest: null,
    payer: { account_id: repository.owner_id, source: 'repository_owner' },
    cost: { currency: 'USD', maximum_cost_units: null, maximum_cost: null, admission_required: true, includes_infrastructure_retries: true },
    inputs: Object.entries(input.inputs).map(([name, value]) => ({ name, type: value === null ? 'null' : typeof value })), order: [], concurrency: null,
    jobs: [], diagnostics: [], permissions: [] };
}

async function currentDefinition(c: AppContext, repository: Repository, workflowId: string): Promise<PreviewDefinition> {
  const workflow = await one<WorkflowRecord>(database(c), 'SELECT * FROM workflows WHERE repo_id=? AND account_id=? AND (id=? OR name=?)', repository.id, repository.owner_id, workflowId, workflowId);
  if (!workflow) throw new ApiError(404, 'not_found', 'The workflow was not found.');
  const version = await one<WorkflowVersion>(database(c), 'SELECT * FROM workflow_versions WHERE id=? AND workflow_id=? AND repo_id=? AND account_id=?', workflow.current_version_id, workflow.id, repository.id, repository.owner_id);
  if (!version || workflow.state !== 'active' || version.policy_revision !== repository.policy_revision) throw new ApiError(409, 'workflow_approval_outdated', 'Approve the workflow against the current policy before previewing its execution.');
  return { source: version.definition, workflow, version };
}

export async function createWorkflowPlanPreview(c: AppContext, workflowId: string, input: PreviewSourceInput): Promise<Response> {
  const { repository, ref } = await previewRepository(c, input);
  return createPreview(c, repository, ref, 'plan', input, await currentDefinition(c, repository, workflowId));
}

export async function validateWorkflowSource(c: AppContext, input: z.infer<typeof workflowValidationSchema>): Promise<Response> {
  const { repository, ref } = await previewRepository(c, input);
  return createPreview(c, repository, ref, 'validation', input, { source: input.source, workflow: null, version: null });
}

function compilationDiagnostics(error: ApiError): PreviewDiagnostic[] {
  const issues = error.details && typeof error.details === 'object' && 'issues' in error.details ? error.details.issues : null;
  if (Array.isArray(issues)) return issues.map(issue => {
    const row = issue as { code?: unknown; message?: unknown; path?: unknown };
    return { code: String(row.code ?? error.code), message: String(row.message ?? error.message).slice(0, 512), path: String(row.path ?? 'workflow').slice(0, 512), severity: 'error' };
  });
  return [previewDiagnostic(error, 'workflow')];
}

async function compileSnapshot(c: AppContext, repository: Repository, source: PreviewSource, definition: PreviewDefinition, snapshot: WorkflowPreviewSnapshot): Promise<void> {
  const env = executionRequestEnvironment(c);
  const prepared = await prepareWorkflowCompilation(env, repository, requirePrincipal(c), source.input, definition.version?.source_commit ?? source.input.commit);
  snapshot.trust = prepared.context.trust.level;
  const manifest = await bindHostedManifest(env, await compilePreparedWorkflow(definition.source, prepared.context));
  if (definition.version && manifest.workflow.definition_digest.replace(/^sha256:/, '') !== definition.version.definition_digest) throw new ApiError(409, 'workflow_digest_mismatch', 'The approved definition does not match its compiled digest.');
  // Draft validation has no approved definition commit or executable manifest.
  snapshot.manifest_digest = definition.version ? manifest.digest : null;
  snapshot.order = manifest.order; snapshot.concurrency = manifest.concurrency;
  const jobs = await previewCompiledJobs(c, repository, source, definition.workflow?.id ?? null, prepared, manifest);
  snapshot.jobs = jobs.jobs; snapshot.permissions = jobs.permissions; snapshot.diagnostics.push(...jobs.diagnostics);
  snapshot.cost.maximum_cost_units = jobs.maximum_cost_units;
  snapshot.cost.maximum_cost = jobs.maximum_cost_units === null ? null : formatDollars(jobs.maximum_cost_units);
  try { executionEnabled(env); }
  catch (error) { snapshot.diagnostics.push(previewDiagnostic(error, 'admission', 'blocked')); }
  snapshot.valid = !snapshot.diagnostics.some(diagnostic => diagnostic.severity === 'error');
}

async function createPreview(c: AppContext, repository: Repository, ref: string, kind: WorkflowPreviewSnapshot['kind'], input: PreviewSourceInput, definition: PreviewDefinition): Promise<Response> {
  const id = newId('plan'), at = now(), expires = new Date(Date.now() + previewLifetimeMs).toISOString(), db = database(c);
  const active = await one<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM workflow_plan_previews WHERE repo_id=? AND expires_at>?', repository.id, at);
  if ((active?.count ?? 0) >= maximumActivePreviews) throw new ApiError(429, 'preview_limit', 'This repository has reached its active compiler-preview limit.');
  const snapshot = initialSnapshot(repository, kind, input, ref, definition);
  const configured = await one<ExecutionPolicyRow>(db, 'SELECT * FROM workflow_execution_policy WHERE repo_id=? AND account_id=?', repository.id, repository.owner_id);
  const structural = validateWorkflow(definition.source, { modules: configured ? JSON.parse(configured.modules_json) as Record<string, unknown> : {} });
  let source: PreviewSource | null = null;
  if (!structural.valid || !structural.definition) {
    snapshot.diagnostics = structural.issues.map(issue => ({ code: issue.code, message: issue.message.slice(0, 512), path: issue.path, severity: 'error' }));
  } else {
    snapshot.definition.digest = await definitionDigest(structural.definition);
    source = await inspectPreviewSource(c, repository, { ...input, ref }, id);
    snapshot.source = { commit: source.input.commit, ref, repository_id: source.source_repo_id, related_repository_ids: source.related_repo_ids,
      head_repository_id: source.observation.source_repo_id, head_oid: source.observation.head_oid, target_oid: source.observation.target_oid,
      pull_request_id: source.input.event.pull_request_id ?? null, merge_candidate_id: source.input.event.merge_candidate_id ?? null, verified: true };
    try { await compileSnapshot(c, repository, source, definition, snapshot); }
    catch (error) {
      if (!(error instanceof ApiError) || ![409, 422].includes(error.status)) throw error;
      snapshot.diagnostics.push(...compilationDiagnostics(error)); snapshot.valid = false;
    }
  }
  if (source) {
    const current = await inspectPreviewSource(c, repository, { ...input, ref }, id);
    if (canonicalJson(current.observation) !== canonicalJson(source.observation)) throw new ApiError(409, 'preview_source_changed', 'The accepted source changed while this preview was being compiled.');
  }
  const result = canonicalJson(snapshot), digest = await sha256(result);
  if (new TextEncoder().encode(result).length > metadataLimit) throw new ApiError(422, 'preview_too_large', 'The complete compiler preview exceeds its 512-KiB metadata limit.');
  const requirements = requirementsSchema.parse((c.get('mutation_authority')?.policies ?? []).map(({ capability, scope }) => ({ capability, scope })));
  c.header('location', `/v1/repos/${repository.id}/plans/${id}`);
  await guardedBatch(db, stmt(db, `INSERT INTO workflow_plan_previews(id,repo_id,account_id,kind,workflow_id,workflow_version_id,source_commit,source_ref,policy_revision,routing_epoch,created_by,result_json,result_digest,requirements_json,created_at,expires_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM repositories WHERE id=? AND owner_id=? AND state='active' AND policy_revision=? AND routing_epoch=?)
      AND (? IS NULL OR EXISTS (SELECT 1 FROM workflows WHERE id=? AND repo_id=? AND state='active' AND current_version_id=? AND revision=?))
      AND (SELECT COUNT(*) FROM workflow_plan_previews WHERE repo_id=? AND expires_at>?)<?`, id, repository.id, repository.owner_id, kind,
  definition.workflow?.id ?? null, definition.version?.id ?? null, snapshot.source.commit, ref, repository.policy_revision, repository.routing_epoch,
  requirePrincipal(c).id, result, digest, canonicalJson(requirements), at, expires, repository.id, repository.owner_id, repository.policy_revision, repository.routing_epoch,
  definition.workflow?.id ?? null, definition.workflow?.id ?? null, repository.id, definition.version?.id ?? null, definition.workflow?.revision ?? null,
  repository.id, now(), maximumActivePreviews), [], { context: c, event: { type: kind === 'plan' ? 'workflow.plan.previewed' : 'workflow.definition.validated', resource_id: id, resource_revision: 1,
    repo_id: repository.id, account_id: repository.owner_id, data: { preview_id: id, kind, valid: snapshot.valid, result_digest: digest, expires_at: expires } } });
  const stored = await one<WorkflowPreviewRecord>(db, 'SELECT * FROM workflow_plan_previews WHERE id=? AND repo_id=?', id, repository.id);
  if (!stored) throw new ApiError(503, 'preview_commit_unconfirmed', 'The immutable preview could not be read after publication.');
  return executionReadResponse(c, previewResponse(c, stored, kind === 'validation' ? 200 : 201), previewReadAuthorizer(c, stored));
}

function previewResponse(c: AppContext, row: WorkflowPreviewRecord, status = 200): Response {
  c.header('etag', `"${row.result_digest}"`); c.header('cache-control', 'private, no-store');
  const snapshot = JSON.parse(row.result_json) as WorkflowPreviewSnapshot;
  return c.json({ id: row.id, repo_id: row.repo_id, account_id: row.account_id, revision: row.revision, created_by: row.created_by, created_at: row.created_at,
    expires_at: row.expires_at, preview_digest: row.result_digest, status: !snapshot.valid ? 'invalid' : snapshot.diagnostics.some(diagnostic => diagnostic.severity === 'blocked') ? 'blocked' : 'compiled', ...snapshot }, status as 200 | 201);
}

function previewReadAuthorizer(c: AppContext, row: WorkflowPreviewRecord): () => Promise<void> {
  const snapshot = JSON.parse(row.result_json) as WorkflowPreviewSnapshot;
  const audience = executionAudience({ repo_id: row.repo_id, source_repo_id: snapshot.source.repository_id,
    related_repo_ids: [...new Set([row.repo_id, snapshot.source.head_repository_id, ...snapshot.source.related_repository_ids])],
    trigger: { type: 'preview', id: row.id, ...(snapshot.source.pull_request_id ? { pull_request_id: snapshot.source.pull_request_id } : {}) },
    ...(snapshot.source.merge_candidate_id ? { checkout_candidate_id: snapshot.source.merge_candidate_id } : {}) });
  const requirements = requirementsSchema.parse(JSON.parse(row.requirements_json));
  return async () => {
    const fresh = freshExecutionReader(c);
    await authorizeExecutionAudience(fresh, row.repo_id, audience, 'workflows.run');
    const allowed = await visibleExecutionRecord(async () => {
      for (const requirement of requirements) await authorize(fresh, requirement.capability, requirement.scope);
    });
    if (!allowed) executionNotFound();
    if (row.expires_at <= now()) throw new ApiError(410, 'preview_expired', 'The compiler preview expired; create a new preview.');
  };
}

export async function readWorkflowPreview(c: AppContext, previewId: string): Promise<Response> {
  requirePrincipal(c);
  const row = await one<WorkflowPreviewRecord>(database(c), 'SELECT * FROM workflow_plan_previews WHERE id=? AND repo_id=?', previewId, c.req.param('repoId'));
  if (!row) executionNotFound();
  const requirements = requirementsSchema.parse(JSON.parse(row.requirements_json));
  if (!requirements.length) throw new ApiError(503, 'preview_authority_missing', 'The preview has no retained authorization requirements.');
  const recheck = previewReadAuthorizer(c, row);
  await recheck();
  for (const requirement of requirements) await authorize(c, requirement.capability, requirement.scope);
  const repository = await readRepositoryAuthority(c, row.repo_id);
  if (!repository || repository.owner_id !== row.account_id) executionNotFound();
  if (row.expires_at <= now()) throw new ApiError(410, 'preview_expired', 'The compiler preview expired; create a new preview against current authority.');
  if (repository.policy_revision !== row.policy_revision || repository.routing_epoch !== row.routing_epoch || repository.state !== 'active') throw new ApiError(409, 'preview_stale', 'The repository policy or placement changed after this preview.');
  if (row.workflow_id && !await one(database(c), `SELECT id FROM workflows WHERE id=? AND repo_id=? AND current_version_id=? AND state='active'`, row.workflow_id, row.repo_id, row.workflow_version_id)) {
    throw new ApiError(409, 'preview_stale', 'The approved workflow changed after this preview.');
  }
  if (await sha256(row.result_json) !== row.result_digest) throw new ApiError(503, 'preview_corrupt', 'The immutable compiler preview failed integrity verification.');
  const snapshot = JSON.parse(row.result_json) as WorkflowPreviewSnapshot;
  if (snapshot.source.verified) {
    const current = await inspectPreviewSource(c, repository, { commit_oid: row.source_commit!, ref: row.source_ref, inputs: {},
      ...(snapshot.source.pull_request_id ? { pull_request_id: snapshot.source.pull_request_id } : {}), ...(snapshot.source.merge_candidate_id ? { merge_candidate_id: snapshot.source.merge_candidate_id } : {}) }, row.id);
    if (current.observation.head_oid !== snapshot.source.head_oid || current.observation.target_oid !== snapshot.source.target_oid) throw new ApiError(409, 'preview_stale', 'The accepted source changed after this preview.');
  }
  await verifyPreviewConfiguration(c, row, snapshot);
  c.header('etag', `"${row.result_digest}"`); c.header('cache-control', 'private, no-store');
  if (c.req.method === 'GET' && c.req.header('if-none-match') === `"${row.result_digest}"`) return executionReadResponse(c, c.body(null, 304), recheck);
  return executionReadResponse(c, previewResponse(c, row), recheck);
}

const configurationSchema = z.object({ executor: z.object({ type: z.enum(['hosted', 'self_hosted']) }), runner_pool_id: z.string().nullable(),
  environment: z.object({ id: z.string() }).nullable(), configuration: z.object({ status: z.literal('verified_metadata'), metadata_digest: z.string().regex(/^[a-f0-9]{64}$/),
    declared: z.array(z.object({ step_id: z.string(), secrets: z.array(z.string()), variables: z.array(z.string()) })).max(512) }) });

async function verifyPreviewConfiguration(c: AppContext, row: WorkflowPreviewRecord, snapshot: WorkflowPreviewSnapshot): Promise<void> {
  if (!row.workflow_id || !row.source_commit || !snapshot.trust) return;
  for (const data of snapshot.jobs) {
    if ((data.configuration as { status?: string } | undefined)?.status !== 'verified_metadata') continue;
    const job = configurationSchema.parse(data);
    const current = await previewSecretsForPlan(c.env, { principal: requirePrincipal(c), repo_id: row.repo_id, workflow_id: row.workflow_id,
      commit_oid: row.source_commit, ref: row.source_ref, executor: job.executor.type, trust_class: snapshot.trust, runner_pool_id: job.runner_pool_id,
      environment_id: job.environment?.id ?? null, steps: job.configuration.declared });
    if (await sha256(canonicalJson(previewVersionSteps(current))) !== job.configuration.metadata_digest) throw new ApiError(409, 'preview_stale', 'The current configuration versions or grants changed after this preview.');
  }
}

/** Keep expired identities briefly for explicit 410 responses, then remove their metadata. */
export async function expireWorkflowPreviews(env: Bindings): Promise<number> {
  const result = await execute(primary(env), `DELETE FROM workflow_plan_previews WHERE id IN
    (SELECT id FROM workflow_plan_previews WHERE expires_at<? ORDER BY expires_at,id LIMIT 64)`, new Date(Date.now() - 86400_000).toISOString());
  return result.meta.changes;
}
