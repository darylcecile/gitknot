import { database, one, sha256 } from '@gitknot/core';
import type { AppContext, Repository } from '@gitknot/core';
import { matchGitPattern } from '../../../../../packages/git/src/policy.ts';
import type { GitCheckExpression, GitRule } from '../../../../../packages/git/src/types.ts';
import type { NativePatchFile } from './native.ts';
import type { MergeBlocker } from './merge.ts';
import { policyProvesInapplicable } from './verification-applicability.ts';
import type { CandidateVerificationContext } from './verification-applicability.ts';

interface VerificationRow {
  id: string | null; run_id: string; job_id: string; job_key: string; conclusion: string | null;
  commit_sha: string; workflow_digest: string; plan_digest: string; policy_revision: number;
  producer_id: string | null; toolchain_digest: string | null; attempt_id: string | null;
  run_trust: string; run_status: string; plan_json: string; job_status: string;
  current_attempt_id: string | null; reused_attempt_id: string | null;
  attempt_status: string | null; attempt_plan_digest: string | null; attempt_producer: string | null;
  attempt_toolchain: string | null; receipt_hash: string | null;
  verification_commit: string | null; verification_workflow: string | null; verification_plan: string | null;
  verification_policy: number | null; definition_digest: string; approved_by: string;
  definition: string; definition_source_commit: string; definition_policy_revision: number;
  workflow_name: string; trigger_type: string; source_ref: string;
}
interface CheckEvidence extends Record<string, unknown> { type: 'check'; name: string; satisfied: boolean; applicable: boolean }
interface ExpressionEvidence extends Record<string, unknown> { type: 'all' | 'any'; satisfied: boolean; applicable: boolean; checks: Array<CheckEvidence | ExpressionEvidence> }

async function verificationRow(c: AppContext, repo: Repository, candidate: string, name: string): Promise<VerificationRow | null> {
  return one<VerificationRow>(database(c), `SELECT v.id,r.id AS run_id,j.id AS job_id,j.job_key,v.conclusion,
    r.commit_sha,r.workflow_digest,r.plan_digest,r.policy_revision,v.producer_id,v.toolchain_digest,v.attempt_id,
    r.trust AS run_trust,r.status AS run_status,r.plan_json,j.status AS job_status,j.current_attempt_id,j.reused_attempt_id,
    a.status AS attempt_status,a.plan_digest AS attempt_plan_digest,a.producer_id AS attempt_producer,a.toolchain_digest AS attempt_toolchain,a.receipt_hash,
    v.commit_sha AS verification_commit,v.workflow_digest AS verification_workflow,v.plan_digest AS verification_plan,v.policy_revision AS verification_policy,
    d.definition_digest,d.approved_by,d.definition,d.source_commit AS definition_source_commit,d.policy_revision AS definition_policy_revision,
    w.name AS workflow_name,r.trigger_type,r.source_ref
    FROM workflow_runs r JOIN workflows w ON w.id=r.workflow_id AND w.repo_id=r.repo_id AND w.account_id=r.account_id AND w.state='active' AND w.current_version_id=r.workflow_version_id
    JOIN workflow_versions d ON d.id=r.workflow_version_id AND d.repo_id=r.repo_id AND d.account_id=r.account_id AND d.workflow_id=w.id
    JOIN workflow_jobs j ON j.run_id=r.id AND j.repo_id=r.repo_id AND j.account_id=r.account_id
    LEFT JOIN workflow_verifications v ON v.repo_id=r.repo_id AND v.account_id=r.account_id AND v.run_id=r.id AND v.job_id=j.id
    LEFT JOIN execution_attempts a ON a.id=v.attempt_id AND a.repo_id=r.repo_id AND a.account_id=r.account_id
    WHERE r.repo_id=? AND r.account_id=? AND r.commit_sha=? AND r.policy_revision=? AND (w.name||'.'||j.job_key)=?
    ORDER BY r.enqueue_sequence DESC,r.created_at DESC,r.id DESC LIMIT 1`, repo.id, repo.owner_id, candidate, repo.policy_revision, name);
}

async function trusted(c: AppContext, row: VerificationRow, repo: Repository, candidate: string, producers: string[][],
  context: CandidateVerificationContext | undefined, workflowDigest?: string): Promise<'passed' | 'not_applicable' | null> {
  if (!row.id || row.run_trust !== 'trusted' || ['cancelled', 'cancelling', 'runner_unreachable'].includes(row.run_status)
    || row.commit_sha !== candidate || row.verification_commit !== candidate || row.policy_revision !== repo.policy_revision
    || row.verification_policy !== repo.policy_revision || row.workflow_digest !== row.definition_digest
    || row.verification_workflow !== row.workflow_digest || row.verification_plan !== row.plan_digest || !row.approved_by
    || row.definition_policy_revision !== repo.policy_revision
    || workflowDigest !== undefined && row.workflow_digest !== workflowDigest || await sha256(row.plan_json) !== row.plan_digest) return null;
  let plan: { repo_id?: string; commit_sha?: string; workflow_digest?: string; policy_revision?: number; trust?: string;
    jobs?: Array<{ key: string; producer_id: string; applicable: boolean; blocked_reason?: string | null; inapplicable_reason?: string | null; toolchain?: { digest: string } }> };
  try { plan = JSON.parse(row.plan_json) as typeof plan; } catch { return null; }
  if (!plan || plan.repo_id !== repo.id || plan.commit_sha !== candidate || plan.workflow_digest !== row.workflow_digest || plan.policy_revision !== repo.policy_revision
    || plan.trust !== 'trusted') return null;
  const job = Array.isArray(plan.jobs) ? plan.jobs.find(value => value?.key === row.job_key) : undefined;
  if (!job || job.toolchain?.digest !== row.toolchain_digest) return null;
  if (row.conclusion === 'not_applicable') {
    if (row.job_status !== 'not_applicable' || job.applicable !== false || job.blocked_reason || !job.inapplicable_reason
      || row.producer_id !== `policy:${repo.policy_revision}` || row.attempt_id !== null || row.current_attempt_id !== null || row.reused_attempt_id !== null) return null;
    return await policyProvesInapplicable(c, repo, candidate, context, row, plan) ? 'not_applicable' : null;
  }
  const passed = job.applicable === true && !job.blocked_reason && row.conclusion === 'succeeded' && row.job_status === 'succeeded' && row.attempt_status === 'succeeded'
    && !!row.receipt_hash && row.attempt_id === (row.current_attempt_id ?? row.reused_attempt_id)
    && row.attempt_plan_digest === row.plan_digest && row.attempt_producer === row.producer_id
    && job.producer_id === row.producer_id && row.attempt_toolchain === row.toolchain_digest
    && producers.every(allowed => allowed.includes(row.producer_id!));
  return passed ? 'passed' : null;
}

export async function evaluateVerification(c: AppContext, repo: Repository, candidate: string | null,
  files: NativePatchFile[], rules: GitRule[], blockers: MergeBlocker[], context?: CandidateVerificationContext): Promise<Record<string, unknown>[]> {
  const cache = new Map<string, Promise<VerificationRow | null>>();
  async function check(name: string, producers: string[][], workflowDigest?: string): Promise<CheckEvidence> {
    if (!candidate) return { type: 'check', name, satisfied: false, applicable: true, reason: 'candidate_missing' };
    let pending = cache.get(name);
    if (!pending) { pending = verificationRow(c, repo, candidate, name); cache.set(name, pending); }
    const row = await pending;
    const outcome = row ? await trusted(c, row, repo, candidate, producers, context, workflowDigest) : null;
    const satisfied = outcome !== null;
    return { type: 'check', name, satisfied, applicable: outcome !== 'not_applicable', passed: outcome === 'passed', conclusion: row?.conclusion ?? null, run_id: row?.run_id ?? null,
      plan_digest: row?.plan_digest ?? null, workflow_digest: row?.workflow_digest ?? null, producer_id: row?.producer_id ?? null,
      reason: outcome === 'not_applicable' ? 'validated_current_path_policy' : satisfied ? null : row?.conclusion === 'not_applicable'
        ? 'unproven_inapplicability' : row ? 'untrusted_or_unsuccessful_result' : 'missing_result' };
  }
  async function expression(node: GitCheckExpression, restrictions: string[][]): Promise<CheckEvidence | ExpressionEvidence> {
    if (node.type !== 'check') {
      const checks = await Promise.all(node.checks.map(child => expression(child, restrictions)));
      const applicable = checks.filter(value => value.applicable);
      return { type: node.type, applicable: applicable.length > 0,
        satisfied: node.type === 'all' ? checks.every(value => value.satisfied) : applicable.some(value => value.satisfied), checks };
    }
    if (node.paths) {
      const paths = files.flatMap(file => file.old_path ? [file.path, file.old_path] : [file.path]);
      const work = paths.reduce((sum, path) => sum + path.length, 0)
        * [...node.paths.include, ...node.paths.exclude].reduce((sum, pattern) => sum + pattern.length, 0);
      if (work > 16_777_216) return { type: 'check', name: node.key, satisfied: false, applicable: true, reason: 'path_condition_coverage_unavailable' };
      const applies = paths.some(path => (!node.paths!.include.length || node.paths!.include.some(pattern => matchGitPattern(pattern, path)))
        && !node.paths!.exclude.some(pattern => matchGitPattern(pattern, path)));
      if (!applies && candidate) return { type: 'check', name: node.key, satisfied: true, applicable: false, passed: false,
        conclusion: 'not_applicable', reason: 'trusted_rule_path_condition' };
    }
    return check(node.key, [...restrictions, node.producers], node.workflow_digest);
  }
  const evidence: Record<string, unknown>[] = [];
  for (const name of new Set(rules.flatMap(rule => rule.verification?.required ?? []))) {
    const producers = rules.filter(rule => rule.verification?.required.includes(name) && rule.verification.trusted_producers !== undefined)
      .map(rule => rule.verification!.trusted_producers!);
    const value = await check(name, producers);
    evidence.push(value);
    if (!value.satisfied) blockers.push({ code: 'required_verification', message: 'A required trusted candidate check has not passed.', details: { name } });
  }
  for (const rule of rules) {
    if (!rule.verification?.expression) continue;
    const restrictions = rule.verification.trusted_producers === undefined ? [] : [rule.verification.trusted_producers];
    const value = await expression(rule.verification.expression, restrictions);
    evidence.push({ ...value, rule_id: rule.id });
    if (!value.satisfied) blockers.push({ code: 'verification_expression', message: 'The current trusted verification expression is not satisfied.', details: { rule_id: rule.id, expression: value } });
  }
  return evidence;
}
