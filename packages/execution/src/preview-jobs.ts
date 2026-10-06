import { ApiError, authorize, canonicalJson, database, one, requirePrincipal, sha256 } from '@gitknot/core';
import type { AppContext, Repository } from '@gitknot/core';
import { formatDollars, previewExecutionQuote, units } from '@gitknot/billing';
import type { Rate } from '@gitknot/billing';
import { previewSecretsForPlan } from '@gitknot/secrets';
import type { PlanSelectionPreview, SelectedVersion } from '@gitknot/secrets';
import type { CompiledJob, RunManifest, Value } from '@gitknot/workflows';
import { EXECUTION_LIMITS, hostedProfiles } from './config.ts';
import { normalizeCompiledJob, workflowJobConfiguration } from './planning.ts';
import type { PreparedWorkflowCompilation } from './planning.ts';
import type { PreviewDiagnostic, WorkflowPreviewSnapshot } from './preview-types.ts';
import type { PreviewSource } from './preview-source.ts';
import type { JobStatus, PlanJob } from './types.ts';
import { nextJobState } from './state.ts';
import { remoteExecutor } from './remote/config.ts';
import { executionRequestEnvironment } from './store.ts';

interface EnvironmentPreview { id: string; name: string; revision: number; destination: string; target_ref: string; required_approvals: number }
interface PreviewJobs { jobs: Record<string, unknown>[]; diagnostics: PreviewDiagnostic[]; permissions: WorkflowPreviewSnapshot['permissions']; maximum_cost_units: string | null }

export function previewDiagnostic(error: unknown, path: string, severity: PreviewDiagnostic['severity'] = 'error'): PreviewDiagnostic {
  if (!(error instanceof ApiError)) throw error;
  return { code: error.code, message: error.message.slice(0, 512), path, severity };
}

async function permission(c: AppContext, result: PreviewJobs, capability: string, repoId: string, ref: string, path: string): Promise<boolean> {
  const scope = { repo_id: repoId, ref };
  try { await authorize(c, capability, scope); result.permissions.push({ capability, scope, allowed: true }); return true; }
  catch (error) {
    if (!(error instanceof ApiError) || error.status >= 500) throw error;
    result.permissions.push({ capability, scope, allowed: false });
    result.diagnostics.push({ code: 'preview_permission_denied', message: `The current credential cannot use ${capability} for this source.`, path, severity: 'error' });
    return false;
  }
}

function references(environment: Record<string, Value>): Array<{ name: string; kind: string; reference?: string; type?: string }> {
  return Object.entries(environment).map(([name, value]) => {
    if (value !== null && typeof value === 'object') {
      if ('secret' in value) return { name, kind: 'secret', reference: value.secret };
      if ('variable' in value) return { name, kind: 'variable', reference: value.variable };
      if ('output' in value) return { name, kind: 'output', reference: value.output };
    }
    return { name, kind: 'literal', type: value === null ? 'null' : typeof value };
  });
}

function versionMetadata(version: Omit<SelectedVersion, 'value'>): Record<string, unknown> {
  return { name: version.name, kind: version.kind, entry_id: version.entry_id, version_id: version.version_id, version: version.version,
    policy_revision: version.policy_revision, account_id: version.account_id, repo_id: version.repo_id, environment_id: version.environment_id,
    scope_type: version.scope_type, scope_id: version.scope_id };
}

export function previewVersionSteps(selected: PlanSelectionPreview): Array<{ step_id: string; secrets: Record<string, unknown>[]; variables: Record<string, unknown>[] }> {
  return selected.steps.map(step => ({ step_id: step.step_id, secrets: step.secrets.map(versionMetadata), variables: step.variables.map(versionMetadata) }));
}

async function configuration(c: AppContext, repository: Repository, source: PreviewSource, workflowId: string | null, job: CompiledJob,
  environmentId: string | null, poolId: string | null, trust: 'trusted' | 'untrusted', result: PreviewJobs): Promise<Record<string, unknown>> {
  const declared = workflowJobConfiguration(job), secrets = declared.some(step => step.secrets.length), variables = declared.some(step => step.variables.length);
  if (!secrets && !variables) return { status: 'not_required', declared, steps: [] };
  let permitted = true;
  if (secrets) permitted = await permission(c, result, 'secrets.use', repository.id, source.input.ref, `jobs.${job.id}.secrets`) && permitted;
  if (variables) permitted = await permission(c, result, 'variables.read', repository.id, source.input.ref, `jobs.${job.id}.variables`) && permitted;
  if (!permitted) return { status: 'unavailable', declared, steps: [] };
  if (!workflowId) {
    result.diagnostics.push({ code: 'workflow_approval_required', message: 'Versioned vault grants can be checked after this draft has an approved workflow identity.', path: `jobs.${job.id}.configuration`, severity: 'requirement' });
    return { status: 'declared_only', declared, steps: [] };
  }
  try {
    const selected: PlanSelectionPreview = await previewSecretsForPlan(c.env, { principal: requirePrincipal(c), repo_id: repository.id, workflow_id: workflowId,
      commit_oid: source.input.commit, ref: source.input.ref, trust_class: trust, executor: job.executor.type, runner_pool_id: poolId,
      environment_id: environmentId, steps: declared });
    for (const step of selected.steps) for (const version of [...step.secrets, ...step.variables]) {
      if (version.account_id !== repository.owner_id) await authorize(c, version.kind === 'secret' ? 'secrets.use' : 'variables.read', { account_id: version.account_id });
    }
    const steps = previewVersionSteps(selected);
    return { status: 'verified_metadata', declared, selection_digest: selected.selection_digest, metadata_digest: await sha256(canonicalJson(steps)), steps };
  } catch (error) {
    result.diagnostics.push(previewDiagnostic(error, `jobs.${job.id}.configuration`, error instanceof ApiError && error.status >= 500 ? 'blocked' : 'error'));
    return { status: 'unavailable', declared, steps: [] };
  }
}

function publicRate(rate: Rate) {
  return { id: rate.id, meter: rate.meter, meter_version: rate.meter_version, version: rate.version, currency: rate.currency,
    unit_name: rate.unit_name, unit_quantity: rate.unit_quantity, unit_price_units: rate.unit_price_units };
}

async function cost(c: AppContext, repository: Repository, workflowId: string | null, job: PlanJob, attempts: number, result: PreviewJobs): Promise<Record<string, unknown>> {
  if (!attempts) return { currency: 'USD', maximum_cost_units: '0', maximum_cost: formatDollars('0'), maximum_attempts: 0, admission_required: true };
  try {
    const quote = await previewExecutionQuote(executionRequestEnvironment(c), { account_id: repository.owner_id, repo_id: repository.id,
      actor_id: requirePrincipal(c).id, workflow_id: workflowId, executor: job.executor.type, profile: job.executor.type === 'hosted' ? job.executor.profile : 'customer-owned',
      maximum_duration_ms: job.timeout_ms, maximum_storage_bytes: String((job.limits?.log_bytes ?? EXECUTION_LIMITS.log_bytes)
        + (job.limits?.output_bytes ?? EXECUTION_LIMITS.output_bytes) + (job.limits?.cache_bytes ?? EXECUTION_LIMITS.cache_bytes) + 32 * 1024 * 1024),
      storage_retention_seconds: Math.max(EXECUTION_LIMITS.log_retention_seconds, job.cache?.retention_seconds ?? 3600, ...Object.values(job.outputs).map(output => output.retention_seconds)),
      maximum_egress_bytes: String(job.egress.max_bytes) });
    const maximum = (units(quote.maximum_charge_units) * BigInt(attempts)).toString();
    if (result.maximum_cost_units !== null) result.maximum_cost_units = (units(result.maximum_cost_units) + units(maximum)).toString();
    result.diagnostics.push(...quote.availability.reasons.map(reason => ({ ...reason, path: `jobs.${job.key}.cost`, severity: 'blocked' as const })));
    return { currency: quote.currency, payer_account_id: quote.payer_account_id, maximum_attempts: attempts, maximum_cost_units: maximum, maximum_cost: formatDollars(maximum),
      per_attempt_units: quote.maximum_charge_units, quoted_at: quote.quoted_at, subscription: quote.subscription, availability: quote.availability,
      storage_bytes: quote.storage_bytes, storage_retention_ms: quote.storage_retention_ms, storage_cleanup_grace_ms: quote.storage_cleanup_grace_ms,
      maximum_objects: quote.maximum_objects, egress_bytes: quote.egress_bytes,
      rates: { compute: publicRate(quote.rates.compute), storage: publicRate(quote.rates.storage), egress: publicRate(quote.rates.egress) } };
  } catch (error) {
    result.maximum_cost_units = null;
    result.diagnostics.push(previewDiagnostic(error, `jobs.${job.key}.cost`, 'blocked'));
    return { currency: 'USD', maximum_cost_units: null, maximum_cost: null, maximum_attempts: attempts, admission_required: true };
  }
}

function profile(c: AppContext, job: PlanJob, result: PreviewJobs): Record<string, unknown> | null {
  if (job.executor.type !== 'hosted') return null;
  const requested = job.executor.profile;
  try {
    const current = hostedProfiles(c.env).find(profile => profile.name === requested);
    if (!current) throw new ApiError(503, 'hosted_profile_unavailable', 'The hosted profile has no admitted measurement in this cell.');
    if (current.toolchain_digest !== job.toolchain.digest || current.image !== job.toolchain.image || job.timeout_ms > current.max_job_ms) throw new ApiError(409, 'hosted_toolchain_unavailable', 'The measured hosted profile does not match this toolchain and deadline.');
    return { name: current.name, image: current.image, measurement_evidence: current.measurement.evidence_sha256, measured_at: current.measurement.measured_at, matched: true };
  } catch (error) { result.diagnostics.push(previewDiagnostic(error, `jobs.${job.key}.executor`, 'blocked')); return null; }
}

/** Projects only program structure, declared bindings and current pricing/version metadata. */
export async function previewCompiledJobs(c: AppContext, repository: Repository, source: PreviewSource, workflowId: string | null,
  prepared: PreparedWorkflowCompilation, manifest: RunManifest): Promise<PreviewJobs> {
  const result: PreviewJobs = { jobs: [], diagnostics: [], permissions: [], maximum_cost_units: '0' };
  const states = new Map<string, JobStatus>(), remote = remoteExecutor(c.env);
  for (const jobId of manifest.order) {
    const compiled = manifest.jobs.find(job => job.id === jobId)!;
    const poolName = compiled.executor.type === 'self_hosted' ? compiled.executor.pool : null;
    const pool = poolName ? prepared.pools.find(pool => [pool.id, pool.name].includes(poolName)) : null;
    const environment = compiled.environment ? await one<EnvironmentPreview>(database(c), "SELECT id,name,revision,destination,target_ref,required_approvals FROM workflow_environments WHERE repo_id=? AND name=? AND state='active'", repository.id, compiled.environment.name) : null;
    if (compiled.environment && !environment) result.diagnostics.push({ code: 'environment_unavailable', message: 'The protected environment is not configured.', path: `jobs.${compiled.id}.environment`, severity: 'error' });
    const job = normalizeCompiledJob(compiled, pool, environment?.id ?? null, prepared.configured, null, manifest.limits, remote);
    const state = nextJobState(job, job.needs.map(job_key => ({ job_key, status: states.get(job_key) ?? 'waiting' })));
    states.set(job.key, state.status === 'ready' ? 'succeeded' : state.status);
    if (state.status !== 'ready') result.diagnostics.push({ code: state.status, message: state.reason ?? 'This job will not execute for the requested source.', path: `jobs.${job.key}`, severity: 'blocked' });
    for (const capability of compiled.access.capabilities) await permission(c, result, capability, repository.id, source.input.ref, `jobs.${job.key}.access`);
    const selected = await configuration(c, repository, source, workflowId, compiled, environment?.id ?? null, pool?.id ?? null, prepared.context.trust.level, result);
    const measured = profile(c, job, result), quoted = await cost(c, repository, workflowId, job, state.status === 'ready' ? job.infrastructure_retries + 1 : 0, result);
    const steps = await Promise.all(compiled.steps.map(async step => ({ id: step.id, module: step.module, timeout_ms: step.timeout_ms, outputs: step.outputs,
      environment: references(step.env), commands: await Promise.all(step.commands.map(async (command, index) => ({ index, script_digest: await sha256(command.run),
        shell: command.shell, working_directory: command.working_directory, timeout_ms: command.timeout_ms, environment: references(command.env) }))) })));
    result.jobs.push({ id: job.key, needs: job.needs, producer_id: job.producer_id, executor: job.executor, runner_pool_id: pool?.id ?? null, toolchain: compiled.toolchain, measured_profile: measured,
      timeout_ms: job.timeout_ms, condition: compiled.condition, possible_outcome: state.status, access: compiled.access, environment: environment,
      environment_bindings: references(compiled.env), steps, inputs: job.inputs, outputs: job.outputs, cache: job.cache, limits: job.limits,
      configuration: selected, cost: quoted, definition_digest: await sha256(canonicalJson(compiled)) });
  }
  return result;
}
