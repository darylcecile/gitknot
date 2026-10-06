import { compileWorkflow, digestJson, validateWorkflow, verifyManifest, WorkflowValidationError } from '@gitknot/workflows';
import type { CompiledJob, CompileContext, RunManifest, Value, WorkflowDefinition, WorkflowPolicy, ToolchainDescriptor, WorkflowLimits } from '@gitknot/workflows';
import { bindSecretPlan, selectSecretsForPlan } from '@gitknot/secrets';
import { ApiError, many, one, sha256 } from '@gitknot/core';
import type { Bindings, Principal, Repository } from '@gitknot/core';
import { EXECUTION_LIMITS, hostedProfiles } from './config.ts';
import { identityPrimary, primary } from './store.ts';
import { resolveSourceRef } from './source.ts';
import type { ExecutionPlan, PlanJob, PlanStep, RunnerPool, SecretVersion } from './types.ts';
import { remoteExecutor } from './remote/config.ts';
import type { RemoteExecutorConfiguration } from './remote/config.ts';
import { assertRunnerPoolScope, readRunnerPool } from './runner-authority.ts';
import { pinWorkflowSource } from './source-identity.ts';
import type { WorkflowSourceIdentity } from './source-identity.ts';
import { repositoryExecutionContext } from './authorization.ts';
import { authorizeExecutionAudience } from './reads.ts';

export interface WorkflowRecord { id: string; repo_id: string; account_id: string; name: string; path: string; current_version_id: string; state: string; revision: number; created_at: string; updated_at: string }
export interface WorkflowVersion { id: string; workflow_id: string; repo_id: string; account_id: string; source_commit: string; definition_digest: string; definition: string; definition_json: string; policy_revision: number; approved_by: string; approved_credential_id: string | null; created_at: string }
export interface ExecutionPolicyRow { repo_id: string; policy_json: string; toolchains_json: string; modules_json: string; egress_json: string; infrastructure_retries: number; revision: number }
export interface PlanRunInput { commit: string; ref: string; event: { type: string; id: string; pull_request_id?: string; merge_candidate_id?: string; inputs?: Record<string, string | number | boolean | null> }; changed_paths?: string[]; source?: WorkflowSourceIdentity }
export interface PreparedWorkflowCompilation {
  input: PlanRunInput;
  configured: ExecutionPolicyRow | null;
  pools: RunnerPool[];
  context: CompileContext;
}

export function validatedDefinition(source: string, modules: Record<string, unknown> = {}): WorkflowDefinition {
  const result = validateWorkflow(source, { modules });
  if (!result.valid || !result.definition) throw new ApiError(422, 'workflow_invalid', 'The workflow definition is invalid.', { issues: result.issues });
  return result.definition;
}

export async function definitionDigest(definition: WorkflowDefinition): Promise<string> { return (await digestJson(definition)).replace(/^sha256:/, ''); }

function planningInput(input: PlanRunInput, trustedEvent: boolean): PlanRunInput {
  if (!trustedEvent) {
    if (!['workflow.dispatch', 'workflow.manual', 'workflow_dispatch.requested'].includes(input.event.type)) throw new ApiError(403, 'event_untrusted', 'Manual requests cannot assert a repository event type.');
    return { ...input, event: { ...input.event, type: 'workflow.dispatch' } };
  }
  return input;
}

/** Shared current-policy compiler input, with no run, vault selection or admission effects. */
export async function prepareWorkflowCompilation(env: Bindings, repository: Repository, actor: Principal, input: PlanRunInput,
  workflowRevision: string, trustedEvent = false): Promise<PreparedWorkflowCompilation> {
  input = planningInput(input, trustedEvent);
  const db = primary(env);
  input = { ...input, source: await pinWorkflowSource(db, repository, input) };
  const configured = await one<ExecutionPolicyRow>(db, 'SELECT * FROM workflow_execution_policy WHERE repo_id=? AND account_id=?', repository.id, repository.owner_id);
  const trust = await sourceTrust(env, repository, input, trustedEvent, actor);
  const policy = configured ? JSON.parse(configured.policy_json) as WorkflowPolicy : {
    revision: repository.policy_revision, allowed_workflow_revisions: [workflowRevision], access: { repository: 'read', secrets: [], capabilities: [] },
    hosted_profiles: hostedProfiles(env).map(profile => profile.name), self_hosted_pools: {}, inapplicable_jobs: [],
  } satisfies WorkflowPolicy;
  policy.revision = repository.policy_revision;
  policy.allowed_workflow_revisions = [workflowRevision];
  if (!trustedEvent) policy.inapplicable_jobs = [];
  const pools = await planningRunnerPools(env, repository, Object.keys(policy.self_hosted_pools));
  policy.self_hosted_pools = Object.fromEntries(pools.flatMap(pool => [pool.id, pool.name].filter(key => Object.hasOwn(policy.self_hosted_pools, key)).map(key => [key, {
    trust: pool.trust, disposable: pool.isolation === 'ephemeral', ...(pool.repo_id ? { repository_ids: [pool.repo_id] } : {}), producer_id: `pool:${pool.id}`,
  }])));
  const toolchains = configured ? JSON.parse(configured.toolchains_json) as Record<string, ToolchainDescriptor> : parseTrustedJson<Record<string, ToolchainDescriptor>>(env.WORKFLOW_TOOLCHAINS_JSON, {});
  const modules = configured ? JSON.parse(configured.modules_json) as Record<string, unknown> : {};
  const context: CompileContext = { repo_id: repository.id, commit: input.commit, workflow_revision: workflowRevision,
    event: { type: input.event.type, ref: input.ref, ...(input.event.pull_request_id ? { pull_request_id: input.event.pull_request_id } : {}),
      ...(input.event.merge_candidate_id ? { merge_candidate_id: input.event.merge_candidate_id } : {}), inputs: input.event.inputs ?? {},
      ...(trustedEvent && input.changed_paths ? { changed_paths: input.changed_paths } : {}) },
     trust: { level: trust, fork: trust === 'untrusted', producer_id: 'gitknot-control-plane' }, policy, toolchains, modules };
  return { input, configured, pools, context };
}

export async function compilePreparedWorkflow(source: string, context: CompileContext): Promise<RunManifest> {
  try { return await compileWorkflow(source, context); }
  catch (error) {
    if (error instanceof WorkflowValidationError) throw new ApiError(422, 'workflow_plan_invalid', 'The workflow cannot run under current trusted policy.', { issues: error.issues });
    throw error;
  }
}

export async function bindHostedManifest(env: Bindings, portable: RunManifest): Promise<RunManifest> {
  const remote = remoteExecutor(env);
  if (!remote) return portable;
  const { digest: _digest, ...unsigned } = portable;
  const bound = { ...unsigned, jobs: unsigned.jobs.map(job => job.executor.type === 'hosted' ? { ...job, producer_id: remote.producer_id } : job) };
  return verifyManifest({ ...bound, digest: await digestJson(bound) });
}

export async function planRun(env: Bindings, repository: Repository, workflow: WorkflowRecord, version: WorkflowVersion, actor: Principal, input: PlanRunInput, trustedEvent = false): Promise<ExecutionPlan> {
  input = planningInput(input, trustedEvent);
  if (version.policy_revision !== repository.policy_revision || workflow.state !== 'active') throw new ApiError(409, 'workflow_approval_outdated', 'Approve the workflow against the current repository policy before running it.');
  const { configured, pools, context: compileContext, input: pinned } = await prepareWorkflowCompilation(env, repository, actor, input, version.source_commit, trustedEvent);
  input = pinned;
  await authorizeExecutionAudience(await repositoryExecutionContext(env, actor, repository.id), repository.id, input.source!.related_repo_ids, 'workflows.run');
  const trust = compileContext.trust.level, db = primary(env);
  let portable = await compilePreparedWorkflow(version.definition, compileContext);
  if (portable.workflow.definition_digest.replace(/^sha256:/, '') !== version.definition_digest) throw new ApiError(409, 'workflow_digest_mismatch', 'The approved definition no longer matches the compiled manifest.');
  const jobs: PlanJob[] = [];
  const remote = remoteExecutor(env);
  const selections: string[] = [];
  for (const job of portable.jobs) {
    const executor = job.executor;
    const executorPool = executor.type === 'self_hosted' ? pools.find(pool => pool.name === executor.pool || pool.id === executor.pool) : null;
    if (job.executor.type === 'self_hosted' && !executorPool) throw new ApiError(409, 'runner_pool_unavailable', 'The selected runner pool is unavailable.');
    const environment = job.environment ? await one<{ id: string }>(db, "SELECT id FROM workflow_environments WHERE repo_id=? AND name=? AND state='active'", repository.id, job.environment.name) : null;
    if (job.environment && !environment) throw new ApiError(409, 'environment_unavailable', 'The protected environment is not configured.');
    const selection = await selectForJob(env, repository, workflow, actor, input, trust, job, executorPool?.id ?? null, environment?.id ?? null);
    if (selection) selections.push(selection.selection_id);
    jobs.push(normalizeCompiledJob(job, executorPool, environment?.id ?? null, configured, selection, portable.limits, remote));
  }
  if (selections.length) {
    const digest = await digestJson(jobs.map(job => ({ job: job.key, selection_id: job.secret_selection_id ?? null, selection_digest: job.secret_selection_digest ?? null })));
    portable = await compileWorkflow(version.definition, { ...compileContext, configuration: { selection_id: `bundle_${digest.slice(7, 39)}`, selection_digest: digest } });
  }
  portable = await bindHostedManifest(env, portable);
  const source = await pinWorkflowSource(db, repository, input);
  const plan: ExecutionPlan = { version: 1, repo_id: repository.id, account_id: repository.owner_id, commit_sha: input.commit, source_ref: input.ref,
    source_repo_id: source.source_repo_id, related_repo_ids: source.related_repo_ids, source_evidence: source,
    ...(input.event.merge_candidate_id ? { checkout_candidate_id: input.event.merge_candidate_id } : {}),
    workflow_digest: version.definition_digest, workflow_version_id: version.id, policy_revision: repository.policy_revision,
    trust, trigger: { type: input.event.type, id: input.event.id, ...(input.event.pull_request_id ? { pull_request_id: input.event.pull_request_id } : {}) },
    concurrency: { key: portable.concurrency?.group ?? null, supersede: portable.concurrency?.supersede === 'cancel' && input.event.type.startsWith('pull_request.') && !input.event.merge_candidate_id }, jobs,
    portable_manifest: portable, actor: { id: actor.id, kind: actor.kind, user_id: actor.user_id, credential_id: actor.credential_id }, routing_epoch: repository.routing_epoch };
  const digest = await sha256(JSON.stringify(plan));
  for (const selectionId of selections) await bindSecretPlan(env, { selection_id: selectionId, plan_digest: digest, principal: actor });
  return plan;
}

async function planningRunnerPools(env: Bindings, repository: Repository, selected: string[]): Promise<RunnerPool[]> {
  if (!selected.length) return [];
  if (selected.length > 128) throw new ApiError(422, 'runner_pool_limit', 'A workflow policy may select at most 128 runner pools.');
  const candidates = (await Promise.all([primary(env), identityPrimary(env)].map(db => many<{ id: string }>(db,
    `SELECT id FROM runner_pools WHERE account_id=? AND (repo_id IS NULL OR repo_id=?) AND state='active'
      AND (id IN (SELECT value FROM json_each(?)) OR name IN (SELECT value FROM json_each(?))) ORDER BY id LIMIT 129`, repository.owner_id, repository.id, JSON.stringify(selected), JSON.stringify(selected))))).flat();
  const ids = [...new Set(candidates.map(pool => pool.id))];
  if (ids.length > 128) throw new ApiError(422, 'runner_pool_limit', 'The runner pool catalog exceeds the supported planning bound.');
  const pools: RunnerPool[] = [];
  for (const id of ids) {
    const pool = await readRunnerPool(env, id);
    if (pool.account_id !== repository.owner_id || pool.repo_id && pool.repo_id !== repository.id || pool.state !== 'active') continue;
    await assertRunnerPoolScope(env, pool);
    if (pools.some(existing => existing.name === pool.name)) throw new ApiError(409, 'runner_pool_ambiguous', 'Runner pool names must resolve to one authoritative producer.');
    pools.push(pool);
  }
  return pools;
}

async function sourceTrust(env: Bindings, repository: Repository, input: PlanRunInput, trustedEvent: boolean, actor: Principal): Promise<'trusted' | 'untrusted'> {
  if (!trustedEvent && input.event.type !== 'workflow.dispatch') throw new ApiError(403, 'event_untrusted', 'Only the server may supply trusted event classifications.');
  if (input.event.merge_candidate_id) {
    return input.source!.head_repo_id === repository.id ? 'trusted' : 'untrusted';
  }
  if (input.event.pull_request_id) {
    // The PR authority validates current head/base. Fork submissions are always
    // untrusted here; caller-supplied actor or changed-path fields grant nothing.
    return input.source!.head_repo_id === repository.id ? 'trusted' : 'untrusted';
  }
  if (await resolveSourceRef(env, repository.id, input.ref, actor) !== input.commit) throw new ApiError(409, 'source_ref_changed', 'The requested source commit is no longer the accepted ref target.');
  return 'trusted';
}

interface Selection { selection_id: string; selection_digest: string; steps: Array<{ step_id: string; secrets: SecretVersion[]; variables?: Record<string, string> }> }

export function workflowJobConfiguration(job: CompiledJob): Array<{ step_id: string; secrets: string[]; variables: string[] }> {
  return job.steps.map(step => {
    const values = [job.env, step.env, ...step.commands.map(command => command.env)].flatMap(environment => Object.values(environment)) as Value[];
    return { step_id: step.id, secrets: [...new Set(values.flatMap(value => value && typeof value === 'object' && 'secret' in value ? [value.secret] : []))],
      variables: [...new Set(values.flatMap(value => value && typeof value === 'object' && 'variable' in value ? [value.variable] : []))] };
  });
}

async function selectForJob(env: Bindings, repository: Repository, workflow: WorkflowRecord, principal: Principal, input: PlanRunInput, trust: 'trusted' | 'untrusted', job: CompiledJob, poolId: string | null, environmentId: string | null): Promise<Selection | null> {
  const steps = workflowJobConfiguration(job);
  if (!steps.some(step => step.secrets.length || step.variables.length)) return null;
  const selected = await selectSecretsForPlan(env, { principal, repo_id: repository.id, workflow_id: workflow.id, commit_oid: input.commit, ref: input.ref,
    trust_class: trust, executor: job.executor.type, runner_pool_id: poolId, environment_id: environmentId, steps });
  return { selection_id: selected.selection_id, selection_digest: selected.selection_digest, steps: selected.steps.map(step => ({
    step_id: step.step_id, secrets: step.secrets.map(secret => ({ name: secret.name, secret_id: secret.secret_id, version_id: secret.version_id,
      ...(secret.environment_id ? { environment_id: secret.environment_id } : {}) })),
    variables: Object.fromEntries(step.variables.map(variable => { if (variable.value === undefined) throw new ApiError(503, 'variable_unavailable', 'A selected variable version has no value.'); return [variable.name, variable.value]; })),
  })) };
}

export function normalizeCompiledJob(job: CompiledJob, pool: RunnerPool | null | undefined, environmentId: string | null, configured: ExecutionPolicyRow | null, selection: Selection | null, limits: WorkflowLimits, remote: RemoteExecutorConfiguration | null): PlanJob {
  const references = new Map<string, { job: string; output: string; path: string }>();
  const steps: PlanStep[] = [];
  for (const step of job.steps) for (let index = 0; index < step.commands.length; index++) {
    const command = step.commands[index]!;
    const values = { ...job.env, ...step.env, ...command.env };
    for (const value of Object.values(values)) if (value && typeof value === 'object' && 'output' in value && value.output.startsWith('jobs.')) {
      const [, dependency, name] = value.output.split('.'); references.set(value.output, { job: dependency!, output: name!, path: `.gitknot-inputs/${dependency}/${name}` });
    }
    const selected = selection?.steps.find(value => value.step_id === step.id);
    const resolvedValues = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value && typeof value === 'object' && 'variable' in value && selected?.variables && Object.hasOwn(selected.variables, value.variable) ? selected.variables[value.variable] : value]));
    steps.push({ id: step.commands.length === 1 ? step.id : `${step.id}-${index}`, secret_step_id: step.id, run: command.run, shell: command.shell,
      working_directory: command.working_directory, env: {}, values: resolvedValues, secrets: selected?.secrets ?? [], timeout_ms: Math.min(command.timeout_ms, step.timeout_ms),
      ...(index === step.commands.length - 1 ? { outputs: Object.fromEntries(Object.entries(step.outputs).map(([name, output]) => [name, { path: output.path, type: output.type, required: output.required }])) } : {}) });
  }
  let egress = configured ? JSON.parse(configured.egress_json) as PlanJob['egress'] : { hosts: [], max_requests: EXECUTION_LIMITS.egress_requests, max_bytes: EXECUTION_LIMITS.egress_bytes, max_request_bytes: EXECUTION_LIMITS.egress_request_bytes };
  egress = { ...egress, max_bytes: Math.min(egress.max_bytes, EXECUTION_LIMITS.egress_bytes), max_requests: Math.min(egress.max_requests, EXECUTION_LIMITS.egress_requests), max_request_bytes: Math.min(egress.max_request_bytes, EXECUTION_LIMITS.egress_request_bytes) };
  const firstArtifact = [...references.values()].find(value => job.needs.includes(value.job));
  if (environmentId && !firstArtifact) throw new ApiError(422, 'environment_artifact_required', 'An environment job must consume an explicit verified dependency artifact.');
  return { key: job.id, needs: job.needs, executor: job.executor, toolchain: { name: job.toolchain.name, digest: job.toolchain.fingerprint, image: job.toolchain.image ?? '',
    os: job.toolchain.os === 'win32' ? 'windows' : job.toolchain.os, architecture: job.toolchain.arch === 'x64' ? 'amd64' : 'arm64' },
    producer_id: job.executor.type === 'hosted' ? remote?.producer_id ?? `hosted:${job.executor.profile}` : `pool:${pool!.id}`,
    ...(job.executor.type === 'hosted' && remote ? { execution_backend: 'remote' as const, remote_executor_id: remote.id } : { execution_backend: 'local' as const }),
    timeout_ms: job.timeout_ms, infrastructure_retries: configured?.infrastructure_retries ?? 1, applicable: job.condition.outcome !== 'not_applicable',
    blocked_reason: job.condition.outcome === 'blocked' ? job.condition.reason : null, inapplicable_reason: job.condition.outcome === 'not_applicable' ? job.condition.reason : null,
    steps, cache: job.cache ? { key: job.cache.namespace, paths: job.cache.paths, key_files: job.cache.key_files, mode: job.cache.mode, retention_seconds: 7 * 86400 } : null,
    outputs: { ...Object.fromEntries(Object.entries(job.outputs).map(([name, output]) => [name, { ...output, kind: output.type === 'artifact' ? 'artifact' as const : 'value' as const, max_bytes: Math.min(limits.max_output_bytes, EXECUTION_LIMITS.output_bytes) }])),
      ...Object.fromEntries(Object.entries(job.reports).map(([name, output]) => [name, { ...output, kind: 'report' as const, type: 'json', max_bytes: 16 * 1024 ** 2 }])) },
    inputs: [...references.values()], egress,
    limits: { log_bytes: Math.min(limits.max_log_bytes, EXECUTION_LIMITS.log_bytes), output_bytes: Math.min(limits.max_output_bytes, EXECUTION_LIMITS.output_bytes),
      input_bytes: Math.min(limits.max_input_bytes, EXECUTION_LIMITS.output_bytes), cache_bytes: Math.min(limits.max_cache_bytes, EXECUTION_LIMITS.cache_bytes), chunk_bytes: Math.min(limits.max_chunk_bytes, EXECUTION_LIMITS.log_chunk_bytes) },
    environment: environmentId ? { id: environmentId, artifact_job: firstArtifact!.job, artifact_name: firstArtifact!.output } : null,
    ...(selection ? { secret_selection_id: selection.selection_id, secret_selection_digest: selection.selection_digest,
      variables: Object.assign({}, ...selection.steps.map(step => step.variables ?? {})) as Record<string, string> } : {}),
  };
}

function parseTrustedJson<T>(value: unknown, fallback: T): T {
  if (value === undefined) return fallback;
  try { return JSON.parse(String(value)) as T; } catch { throw new ApiError(503, 'workflow_catalog_unavailable', 'The trusted workflow catalog is unavailable.'); }
}
