import { database, identityDatabase, many, one } from '@gitknot/core';
import type { AppContext, Repository } from '@gitknot/core';
import { compileWorkflow, evaluateCondition, matchesPath, parseWorkflow, verifyManifest } from '@gitknot/workflows';
import type { RunManifest, ToolchainDescriptor, WorkflowDefinition, WorkflowPolicy } from '@gitknot/workflows';

export interface CandidateVerificationContext {
  candidate_id: string;
  target_ref: string;
  pull_id: string;
  changed_paths: string[];
}
export interface ApplicabilitySource {
  job_key: string; workflow_name: string; definition: string; definition_digest: string;
  definition_source_commit: string; trigger_type: string; source_ref: string;
  toolchain_digest: string | null;
}
interface PolicyRecord { policy_json: string; toolchains_json: string; modules_json: string }
interface Pool { id: string; name: string; repo_id: string | null; trust: 'trusted' | 'untrusted'; isolation: string }
interface ApplicabilityPlan { portable_manifest?: unknown; checkout_candidate_id?: string; trigger?: { type?: string; pull_request_id?: string } }
const digestValue = (value: string) => value.replace(/^sha256:/, '');
const pathsEqual = (left: string[], right: string[]) => JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());

function matchesCandidate(repo: Repository, oid: string, context: CandidateVerificationContext, source: ApplicabilitySource,
  manifest: RunManifest, plan: ApplicabilityPlan): boolean {
  return manifest.repo_id === repo.id && manifest.source.commit === oid
    && manifest.source.workflow_revision === source.definition_source_commit
    && digestValue(manifest.workflow.definition_digest) === source.definition_digest
    && manifest.workflow.name === source.workflow_name && manifest.policy.revision === String(repo.policy_revision)
    && manifest.trust.level === 'trusted' && !manifest.trust.fork && manifest.trust.producer_id === 'gitknot-control-plane'
    && manifest.event.type === 'merge_candidate.created' && source.trigger_type === manifest.event.type && plan.trigger?.type === manifest.event.type
    && manifest.event.merge_candidate_id === context.candidate_id && plan.checkout_candidate_id === context.candidate_id
    && manifest.event.pull_request_id === context.pull_id && plan.trigger.pull_request_id === context.pull_id
    && manifest.event.ref === context.target_ref && source.source_ref === context.target_ref
    && !!manifest.event.changed_paths && pathsEqual(manifest.event.changed_paths, context.changed_paths);
}

function excludesCandidatePaths(definition: WorkflowDefinition, key: string, context: CandidateVerificationContext): boolean {
  // A trigger/ref mismatch cannot excuse a required candidate verification.
  if (!definition.triggers.includes('merge_candidate.created')) return false;
  const when = definition.jobs[key]?.when;
  if (!when?.paths || when.events && !when.events.includes('merge_candidate.created')) return false;
  if (when.refs && !when.refs.some(pattern => matchesPath(pattern, context.target_ref))) return false;
  return evaluateCondition({ paths: when.paths }, { type: 'merge_candidate.created', ref: context.target_ref,
    changed_paths: context.changed_paths }, true).outcome === 'not_applicable';
}

/** Re-evaluate trusted path policy against native candidate paths, never a stored NA reason. */
export async function policyProvesInapplicable(c: AppContext, repo: Repository, candidateOid: string,
  context: CandidateVerificationContext | undefined, source: ApplicabilitySource, rawPlan: unknown): Promise<boolean> {
  if (!context || !rawPlan || typeof rawPlan !== 'object') return false;
  const plan = rawPlan as ApplicabilityPlan;
  const record = await one<PolicyRecord>(database(c), 'SELECT policy_json,toolchains_json,modules_json FROM workflow_execution_policy WHERE repo_id=? AND account_id=?', repo.id, repo.owner_id);
  if (!record) return false; // The default execution policy authorizes no inapplicable jobs.
  const pools = await many<Pool>(identityDatabase(c), `SELECT id,name,repo_id,trust,isolation FROM runner_pools
    WHERE account_id=? AND (repo_id IS NULL OR repo_id=?) AND state='active'`, repo.owner_id, repo.id);
  try {
    const manifest = await verifyManifest(plan.portable_manifest);
    if (!matchesCandidate(repo, candidateOid, context, source, manifest, plan)) return false;
    const definition = parseWorkflow(source.definition);
    if (!excludesCandidatePaths(definition, source.job_key, context)) return false;
    const recordedJob = manifest.jobs.find(value => value.id === source.job_key);
    if (recordedJob?.condition.outcome !== 'not_applicable' || recordedJob.toolchain.fingerprint !== source.toolchain_digest) return false;
    const policy = JSON.parse(record.policy_json) as WorkflowPolicy;
    if (!Array.isArray(policy.inapplicable_jobs) || !policy.inapplicable_jobs.includes(source.job_key)) return false;
    policy.revision = repo.policy_revision;
    policy.allowed_workflow_revisions = [source.definition_source_commit];
    policy.self_hosted_pools = Object.fromEntries(pools.filter(pool => Object.hasOwn(policy.self_hosted_pools ?? {}, pool.name)).map(pool => [pool.name, {
      trust: pool.trust, disposable: pool.isolation === 'ephemeral', ...(pool.repo_id ? { repository_ids: [pool.repo_id] } : {}), producer_id: `pool:${pool.id}`,
    }]));
    const independentlyCompiled = await compileWorkflow(source.definition, {
      repo_id: repo.id, commit: candidateOid, workflow_revision: source.definition_source_commit,
      event: { type: 'merge_candidate.created', ref: context.target_ref, pull_request_id: context.pull_id,
        merge_candidate_id: context.candidate_id, changed_paths: context.changed_paths, inputs: manifest.event.inputs ?? {} },
      trust: { level: 'trusted', fork: false, producer_id: 'gitknot-control-plane' }, policy,
      toolchains: JSON.parse(record.toolchains_json) as Record<string, ToolchainDescriptor>,
      modules: JSON.parse(record.modules_json) as Record<string, unknown>,
    });
    const currentJob = independentlyCompiled.jobs.find(value => value.id === source.job_key);
    return independentlyCompiled.policy.digest === manifest.policy.digest
      && digestValue(independentlyCompiled.workflow.definition_digest) === source.definition_digest
      && currentJob?.toolchain.fingerprint === recordedJob.toolchain.fingerprint && currentJob.condition.outcome === 'not_applicable';
  } catch { return false; }
}
