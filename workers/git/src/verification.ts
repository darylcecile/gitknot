import { many, one, sha256 } from '@gitknot/core';
import type { AppContext } from '@gitknot/core';
import type { GitCheckExpression, GitRule } from '../../../packages/git/src/types.ts';
import { evaluateGitChecks } from '../../../packages/git/src/verification.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';

interface Verification {
  id: string | null; commit_sha: string; workflow_digest: string; plan_digest: string; policy_revision: number; plan_json: string;
  trust: string; run_status: string; definition_digest: string; approved_by: string; job_key: string; job_status: string;
  current_attempt_id: string | null; reused_attempt_id: string | null; conclusion: string | null; attempt_id: string | null;
  producer_id: string | null; toolchain_digest: string | null; verification_commit: string | null; verification_policy: number | null;
  verification_workflow: string | null; verification_plan: string | null; attempt_status: string | null; attempt_plan: string | null;
  attempt_producer: string | null; attempt_toolchain: string | null; receipt_hash: string | null;
}

export async function verifyAdditionalMergeRules(c: AppContext, repoId: string, pullId: string, commit: string, policyRevision: number, paths: string[], rules: GitRule[], reviews: Array<{ reviewer_id: string; decision: string; authorized: boolean; validity: string; paths: string[] }>): Promise<void> {
  const author = await one<{ author_id: string }>(c.env.DB, 'SELECT author_id FROM collaboration_items WHERE repo_id=? AND id=?', repoId, pullId);
  for (const rule of rules) {
    for (const reviewer of rule.reviews?.required_reviewers ?? []) {
      let found = false;
      for (const review of reviews) {
        if (!review.authorized || review.decision !== 'approve' || !['current', 'preserved'].includes(review.validity)) continue;
        if (rule.reviews?.disallow_author_approval !== false && review.reviewer_id === author?.author_id) continue;
        if (await reviewerMatches(c, repoId, reviewer, review.reviewer_id)) { found = true; break; }
      }
      requireValue(found, 'required_reviewer', 'A required current reviewer has not approved this patch.', 409);
    }
    if (rule.verification?.expression) {
      const result = await evaluateGitChecks(rule.verification.expression, paths, check => trustedCheck(c, repoId, commit, policyRevision, check));
      requireValue(result.satisfied, 'verification_expression', 'The required all/any verification expression is not satisfied by trusted candidate results.', 409);
    }
  }
}

async function reviewerMatches(c: AppContext, repoId: string, required: string, principalId: string): Promise<boolean> {
  if (required === principalId || required === `user/${principalId}`) return true;
  if (required.startsWith('team/')) return !!await one(c.env.DB, `SELECT 1 FROM team_members tm JOIN teams t ON t.id=tm.team_id AND t.account_id=tm.account_id
    JOIN repositories r ON r.owner_id=t.account_id JOIN memberships m ON m.account_id=tm.account_id AND m.principal_id=tm.principal_id AND m.state='active'
    WHERE r.id=? AND (t.id=? OR t.slug=?) AND tm.principal_id=?`, repoId, required.slice(5), required.slice(5), principalId);
  return !!await one(c.env.DB, 'SELECT 1 FROM users u JOIN principals p ON p.user_id=u.id WHERE p.id=? AND u.username=? AND u.disabled_at IS NULL', principalId, required.replace(/^user\//u, ''));
}

async function trustedCheck(c: AppContext, repoId: string, commit: string, policyRevision: number, check: Extract<GitCheckExpression, { type: 'check' }>): Promise<boolean> {
  const row = await one<Verification>(c.env.DB, `SELECT v.id,r.commit_sha,r.workflow_digest,r.plan_digest,r.policy_revision,r.plan_json,r.trust,r.status AS run_status,
    d.definition_digest,d.approved_by,j.job_key,j.status AS job_status,j.current_attempt_id,j.reused_attempt_id,
    v.conclusion,v.attempt_id,v.producer_id,v.toolchain_digest,v.commit_sha AS verification_commit,v.policy_revision AS verification_policy,
    v.workflow_digest AS verification_workflow,v.plan_digest AS verification_plan,a.status AS attempt_status,
    a.plan_digest AS attempt_plan,a.producer_id AS attempt_producer,a.toolchain_digest AS attempt_toolchain,a.receipt_hash
    FROM workflow_runs r JOIN workflows w ON w.id=r.workflow_id AND w.repo_id=r.repo_id AND w.state='active' AND w.current_version_id=r.workflow_version_id
    JOIN workflow_versions d ON d.id=r.workflow_version_id AND d.repo_id=r.repo_id
    JOIN workflow_jobs j ON j.run_id=r.id AND j.repo_id=r.repo_id
    LEFT JOIN workflow_verifications v ON v.run_id=r.id AND v.job_id=j.id AND v.repo_id=r.repo_id
    LEFT JOIN execution_attempts a ON a.id=v.attempt_id AND a.repo_id=r.repo_id
    WHERE r.repo_id=? AND r.commit_sha=? AND r.policy_revision=? AND (w.name||'.'||j.job_key)=?
    ORDER BY r.created_at DESC,r.id DESC LIMIT 1`, repoId, commit, policyRevision, check.key);
  if (!row?.id || row.trust !== 'trusted' || ['cancelled', 'cancelling', 'runner_unreachable'].includes(row.run_status)
    || row.verification_commit !== commit || row.verification_policy !== policyRevision || row.verification_workflow !== row.workflow_digest
    || row.verification_plan !== row.plan_digest || row.workflow_digest !== row.definition_digest || !row.approved_by
    || check.workflow_digest && check.workflow_digest !== row.workflow_digest || await sha256(row.plan_json) !== row.plan_digest) return false;
  let plan: { repo_id?: string; commit_sha?: string; workflow_digest?: string; policy_revision?: number;
    jobs?: Array<{ key: string; producer_id: string; applicable: boolean; inapplicable_reason?: string | null; blocked_reason?: string | null; toolchain?: { digest: string } }> };
  try { plan = JSON.parse(row.plan_json) as typeof plan; } catch { return false; }
  if (plan.repo_id !== repoId || plan.commit_sha !== commit || plan.workflow_digest !== row.workflow_digest || plan.policy_revision !== policyRevision) return false;
  const job = plan.jobs?.find(job => job.key === row.job_key);
  if (!job || job.toolchain?.digest !== row.toolchain_digest) return false;
  if (row.conclusion === 'not_applicable') return row.job_status === 'not_applicable' && !job.applicable && !!job.inapplicable_reason
    && !job.blocked_reason && row.producer_id === `policy:${policyRevision}` && row.attempt_id === null;
  return row.conclusion === 'succeeded' && row.job_status === 'succeeded' && row.attempt_status === 'succeeded'
    && row.attempt_id === (row.current_attempt_id ?? row.reused_attempt_id) && !!row.receipt_hash
    && row.attempt_plan === row.plan_digest && row.attempt_producer === row.producer_id && row.attempt_toolchain === row.toolchain_digest
    && job.producer_id === row.producer_id && check.producers.includes(row.producer_id!);
}
