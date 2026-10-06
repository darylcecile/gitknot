import { database, explainAuthorization, identityDatabase, many, one, principalForExplanation } from '@gitknot/core';
import type { AppContext, Principal, Repository } from '@gitknot/core';
import { matchGitPattern } from '../../../../../packages/git/src/policy.ts';
import type { GitRule } from '../../../../../packages/git/src/types.ts';
import type { Item } from './common.ts';
import type { Pull } from './patches.ts';
import type { NativePatchFile } from './native.ts';
import type { MergeBlocker } from './merge.ts';

export interface ReviewEvidence {
  id: string; reviewer_id: string; decision: string; validity: string; authorized: boolean;
  paths: string[]; invalidated_paths: string[];
}
interface Decision {
  id: string; reviewer_id: string; reviewer_json: string; decision: 'approve' | 'changes_requested';
  scope: 'all' | 'files'; patch_id: string; fingerprint_algorithm: string;
}

async function currentReviewer(c: AppContext, row: Decision, pull: Pull): Promise<boolean> {
  const current = await principalForExplanation(identityDatabase(c), row.reviewer_id);
  if (!current) return false;
  let snapshot: Principal;
  try { snapshot = JSON.parse(row.reviewer_json) as Principal; } catch { return false; }
  if (snapshot.id !== current.id || snapshot.kind !== current.kind || snapshot.user_id !== current.user_id) return false;
  for (const value of [snapshot.capabilities, snapshot.repository_ids, snapshot.account_ids]) {
    if (value !== null && (!Array.isArray(value) || value.some(entry => typeof entry !== 'string'))) return false;
  }
  if (typeof snapshot.mfa !== 'boolean') return false;
  const principal = { ...current, capabilities: snapshot.capabilities, repository_ids: snapshot.repository_ids,
    account_ids: snapshot.account_ids, mfa: snapshot.mfa, credential_id: null };
  if (!(await explainAuthorization(c, 'pull_requests.review', { repo_id: pull.repo_id }, principal)).allowed) return false;
  return pull.head_repo_id === pull.repo_id || (await explainAuthorization(c, 'contents.read', { repo_id: pull.head_repo_id }, principal)).allowed;
}

/** Canonical IDs and the human-readable rule aliases resolve against current ownership/membership. */
export async function reviewOwnerMatches(c: AppContext, repo: Repository, owner: string, reviewerId: string): Promise<boolean> {
  if (owner === reviewerId || owner === `user/${reviewerId}`) return true;
  const team = owner.startsWith('team/') ? owner.slice(5) : owner.startsWith('team_') ? owner : null;
  if (team) return !!await one(identityDatabase(c), `SELECT 1 FROM teams t JOIN team_members tm ON tm.team_id=t.id AND tm.account_id=t.account_id
    JOIN memberships m ON m.account_id=tm.account_id AND m.principal_id=tm.principal_id AND m.state='active'
    WHERE t.account_id=? AND (t.id=? OR t.slug=?) AND tm.principal_id=?`, repo.owner_id, team, team, reviewerId);
  const user = owner.replace(/^user\//, '');
  return !!await one(identityDatabase(c), `SELECT 1 FROM users u JOIN principals p ON p.user_id=u.id
    WHERE p.id=? AND (u.id=? OR u.username=?) AND u.disabled_at IS NULL AND p.disabled_at IS NULL`, reviewerId, user, user);
}

async function latestFileDecisions(c: AppContext, item: Item, pull: Pull, files: NativePatchFile[]): Promise<ReviewEvidence[]> {
  const rows = await many<Decision>(database(c), `SELECT r.id,r.reviewer_id,r.reviewer_json,r.decision,r.scope,r.patch_id,p.fingerprint_algorithm
    FROM pull_reviews r JOIN pull_patches p ON p.repo_id=r.repo_id AND p.id=r.patch_id
    WHERE r.repo_id=? AND r.pull_id=? AND r.decision<>'comment'
      AND NOT EXISTS(SELECT 1 FROM pull_review_dismissals d WHERE d.repo_id=r.repo_id AND d.review_id=r.id)
    ORDER BY r.submitted_revision DESC,r.created_at DESC,r.id DESC`, item.repo_id, item.id);
  const references = await many<{ review_id: string; path: string; patch_fingerprint: string }>(database(c), `SELECT f.review_id,f.path,f.patch_fingerprint
    FROM pull_review_files f JOIN pull_reviews r ON r.repo_id=f.repo_id AND r.id=f.review_id WHERE r.repo_id=? AND r.pull_id=?`, item.repo_id, item.id);
  const reviewed = new Map<string, Map<string, string>>();
  for (const file of references) {
    const paths = reviewed.get(file.review_id) ?? new Map<string, string>();
    paths.set(file.path, file.patch_fingerprint); reviewed.set(file.review_id, paths);
  }
  const current = new Map(files.map(file => [file.path, file.patch_fingerprint]));
  const seen = new Map<string, Set<string>>();
  const evidence: ReviewEvidence[] = [];
  for (const row of rows) {
    const scope = reviewed.get(row.id) ?? new Map<string, string>();
    const claimed = seen.get(row.reviewer_id) ?? new Set<string>();
    const applicable = [...(row.scope === 'all' ? current.keys() : scope.keys())].filter(path => current.has(path) && !claimed.has(path));
    for (const path of applicable) claimed.add(path);
    seen.set(row.reviewer_id, claimed);
    if (!applicable.length) continue;
    const valid = applicable.filter(path => row.fingerprint_algorithm === 'git-patch-id-verbatim-v1' && scope.get(path) === current.get(path));
    evidence.push({ id: row.id, reviewer_id: row.reviewer_id, decision: row.decision,
      validity: valid.length === applicable.length ? row.patch_id === pull.current_patch_id ? 'current' : 'preserved'
        : valid.length ? 'partially_preserved' : 'invalidated',
      authorized: await currentReviewer(c, row, pull), paths: row.decision === 'changes_requested' ? applicable : valid,
      invalidated_paths: applicable.filter(path => !valid.includes(path)) });
  }
  return evidence;
}

export async function evaluateReviews(c: AppContext, repo: Repository, item: Item, pull: Pull, files: NativePatchFile[], rules: GitRule[], blockers: MergeBlocker[]): Promise<ReviewEvidence[]> {
  const evidence = await latestFileDecisions(c, item, pull, files);
  const disallowAuthor = !rules.some(rule => rule.reviews?.disallow_author_approval === false)
    || rules.some(rule => rule.reviews?.disallow_author_approval === true);
  const author = await principalForExplanation(identityDatabase(c), item.author_id);
  const approvals: ReviewEvidence[] = [];
  for (const row of evidence.filter(value => value.authorized && value.decision === 'approve' && value.paths.length)) {
    const reviewer = await principalForExplanation(identityDatabase(c), row.reviewer_id);
    if (disallowAuthor && (row.reviewer_id === item.author_id || (author?.user_id && author.user_id === reviewer?.user_id))) continue;
    approvals.push(row);
  }
  if (evidence.some(row => row.authorized && row.decision === 'changes_requested' && row.paths.length)) {
    blockers.push({ code: 'changes_requested', message: 'A current reviewer has outstanding requested changes.' });
  }
  const minimum = Math.max(0, ...rules.map(rule => rule.reviews?.minimum ?? 0));
  const missing = files.filter(file => new Set(approvals.filter(row => row.paths.includes(file.path)).map(row => row.reviewer_id)).size < minimum);
  if (missing.length) blockers.push({ code: 'required_reviews', message: 'Some changed files do not have the required current approvals.', details: { minimum, paths: missing.map(file => file.path) } });
  const owners = new Map<string, string[]>();
  const reviewers = [...new Set(approvals.map(row => row.reviewer_id))];
  async function matching(owner: string): Promise<string[]> {
    const old = owners.get(owner); if (old) return old;
    const matched: string[] = [];
    for (const reviewer of reviewers) if (await reviewOwnerMatches(c, repo, owner, reviewer)) matched.push(reviewer);
    owners.set(owner, matched); return matched;
  }
  for (const rule of rules) {
    for (const owner of rule.reviews?.required_reviewers ?? []) {
      const candidates = await matching(owner);
      const satisfied = candidates.some(reviewer => files.every(file => approvals.some(row => row.reviewer_id === reviewer && row.paths.includes(file.path))));
      if (!satisfied) blockers.push({ code: 'required_reviewer', message: 'A required reviewer must approve the complete current change.', details: { reviewer: owner, rule_id: rule.id } });
    }
    for (const [pattern, required] of Object.entries(rule.reviews?.required_owners ?? {})) {
      const paths = files.filter(file => matchGitPattern(pattern, file.path) || !!file.old_path && matchGitPattern(pattern, file.old_path));
      for (const owner of required) {
        const candidates = await matching(owner);
        const uncovered = paths.filter(file => !approvals.some(row => candidates.includes(row.reviewer_id) && row.paths.includes(file.path)));
        if (uncovered.length) blockers.push({ code: 'required_owner', message: 'A required path owner must review the changed files.', details: { owner, pattern, paths: uncovered.map(file => file.path), rule_id: rule.id } });
      }
    }
  }
  if (rules.some(rule => rule.reviews?.resolved_threads)) {
    const unresolved = await one<{ count: number }>(database(c), 'SELECT COUNT(*) AS count FROM pull_review_threads WHERE repo_id=? AND pull_id=? AND resolved_at IS NULL', repo.id, item.id);
    if (unresolved?.count) blockers.push({ code: 'unresolved_threads', message: 'Review conversations must be resolved.', details: { count: unresolved.count } });
  }
  return evidence;
}
