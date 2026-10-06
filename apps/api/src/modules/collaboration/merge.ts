import { z } from 'zod';
import { ApiError, authorize, database, getRepository, identityDatabase, jsonBody, many, newId, now, one, requirePrincipal, route, stmt } from '@gitknot/core';
import type { App, AppContext, Repository, RequestAuthorization } from '@gitknot/core';
import { gitRuleSchema, rulesForRef } from '../../../../../packages/git/src/policy.ts';
import type { GitRule } from '../../../../../packages/git/src/types.ts';
import { checkRevision, commit, conflict, getItem, itemFence, itemTouch, notFound, pageBindings, pagedResponse,
  pageSql, pagination, respond, subjectAuthorizations, updateItem } from './common.ts';
import { inspectTargetPatch, pullDetails, readPatch, readPatchFiles, sameReviewedPatch } from './patches.ts';
import { evaluateReviews } from './review-policy.ts';
import type { ReviewEvidence } from './review-policy.ts';
import { evaluateVerification } from './verification-policy.ts';
import { prepareOperation, publicOperation } from './operation-model.ts';
import { inspectPatch } from './native.ts';

export interface MergeQueueEntry {
  id: string; repo_id: string; pull_id: string; patch_id: string; target_ref: string; head_oid: string;
  base_oid: string; strategy: 'merge' | 'squash' | 'rebase'; policy_revision: number;
  candidate_id: string | null; candidate_oid: string | null; operation_id: string; state: string;
  reason_json: string; requested_by: string; revision: number; created_at: string; updated_at: string;
}
export interface Candidate {
  id: string; repo_id: string; source_repo_id: string; pull_request_id: string | null; source_oid: string;
  target_ref: string; target_oid: string; candidate_oid: string | null; strategy: string;
  policy_revision: number; state: string; revision: number;
}
export interface MergeBlocker { code: string; message: string; details?: Record<string, unknown> }
export interface MergeEligibility {
  repo_id: string; pull_id: string; revision: number; patch_id: string; policy_revision: number;
  head_oid: string; target_ref: string; target_oid: string; candidate_id: string | null; candidate_oid: string | null;
  strategy: string; eligible: boolean; queueable: boolean; blockers: MergeBlocker[];
  reviews: ReviewEvidence[]; verifications: Record<string, unknown>[]; evaluated_at: string;
}

export async function effectiveMergeRules(c: AppContext, repo: Repository, target: string): Promise<GitRule[]> {
  type RuleRow = { id: string; config_json: string; target_json: string };
  const [accountRules, repositoryRules] = await Promise.all([
    many<RuleRow>(identityDatabase(c), "SELECT id,config_json,target_json FROM repository_rules WHERE account_id=? AND repo_id IS NULL AND enforcement='active' ORDER BY id", repo.owner_id),
    many<RuleRow>(database(c), "SELECT id,config_json,target_json FROM repository_rules WHERE account_id=? AND repo_id=? AND enforcement='active' ORDER BY id", repo.owner_id, repo.id),
  ]);
  const rows = [...accountRules, ...repositoryRules].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  try {
    return rulesForRef(rows.map(row => gitRuleSchema.parse({ ...JSON.parse(row.config_json) as object, target: JSON.parse(row.target_json), id: row.id })), target);
  } catch { throw new ApiError(503, 'merge_policy_unavailable', 'The current merge policy could not be evaluated.'); }
}

/** Used before route admission, so ref/path-scoped credentials never see an unscoped merge check. */
export async function mergeAuthorizations(c: AppContext, pullId?: string, repoId?: string): Promise<RequestAuthorization[]> {
  const { item, repo } = await getItem(c, 'pull_request', pullId ?? c.req.param('pullId') ?? c.req.param('id'), 'contents.read', repoId ?? c.req.param('repoId'));
  const pull = await pullDetails(c, item);
  const trusted = await inspectTargetPatch(c, { ...pull, repo_id: repo.id, retain: false });
  return [...await subjectAuthorizations(c, repo.id, item.id), { capability: 'pull_requests.merge', scope: {
    repo_id: repo.id, ref: pull.base_ref, paths: [...new Set(trusted.files.flatMap(file => file.old_path ? [file.path, file.old_path] : [file.path]))],
  } }];
}

/** Review coverage is re-derived from the current trusted target, never from a caller-selected ancestor. */
export async function getMergeEligibility(c: AppContext, pullId: string, options: {
  repo_id?: string; candidate_id?: string; strategy?: 'merge' | 'squash' | 'rebase';
} = {}): Promise<MergeEligibility> {
  const { item, repo } = await getItem(c, 'pull_request', pullId, 'contents.read', options.repo_id ?? c.req.param('repoId'));
  const pull = await pullDetails(c, item);
  const [patch, files, trusted] = await Promise.all([
    readPatch(c, item, pull.current_patch_id), readPatchFiles(c, item, pull.current_patch_id),
    inspectTargetPatch(c, { ...pull, repo_id: repo.id, retain: false }),
  ]);
  const strategy = options.strategy ?? 'merge';
  const rules = await effectiveMergeRules(c, repo, pull.base_ref);
  const blockers: MergeBlocker[] = [];
  if (repo.state !== 'active') blockers.push({ code: 'repository_read_only', message: 'The repository is not accepting changes.' });
  if (item.state !== 'open') blockers.push({ code: item.state === 'draft' ? 'draft' : 'pull_not_open', message: 'Only an open, ready-for-review pull request can merge.' });
  if (rules.some(rule => rule.updates === 'blocked')) blockers.push({ code: 'target_blocked', message: 'Current branch policy blocks updates.' });
  if (rules.some(rule => rule.merge_strategies && !rule.merge_strategies.includes(strategy))) blockers.push({ code: 'merge_strategy_denied', message: 'This strategy is excluded by current branch policy.' });
  if (trusted.head_oid !== pull.head_oid) blockers.push({ code: 'head_changed', message: 'The source branch changed. Record its current patch before merging.' });
  if (!sameReviewedPatch(patch, files, trusted)) blockers.push({ code: 'reviewed_patch_outdated',
    message: 'The recorded patch does not cover the current target-relative change. Record a fresh patch before merging.' });
  if (!trusted.files.length) blockers.push({ code: 'empty_patch', message: 'The current target already contains this proposed change.' });
  const dependencies = await many<{ depends_on_id: string }>(database(c), 'SELECT depends_on_id FROM pull_dependencies WHERE repo_id=? AND pull_id=?', repo.id, item.id);
  for (const dependency of dependencies) {
    const target = (await getItem(c, 'pull_request', dependency.depends_on_id, 'contents.read', repo.id)).item;
    if (target.state !== 'merged') blockers.push({ code: 'dependency_unmerged', message: 'A prerequisite pull request has not merged.', details: { pull_id: target.id } });
  }
  const reviews = await evaluateReviews(c, repo, item, pull, trusted.files, rules, blockers);
  const queueable = blockers.length === 0;
  const candidate = options.candidate_id ? await one<Candidate>(database(c),
    'SELECT * FROM git_candidates WHERE repo_id=? AND id=? AND pull_request_id=?', repo.id, options.candidate_id, item.id) : null;
  if (options.candidate_id && !candidate) notFound();
  const valid = candidate?.state === 'ready' && candidate.candidate_oid !== null && candidate.source_repo_id === pull.head_repo_id
    && candidate.source_oid === trusted.head_oid && candidate.source_oid === pull.head_oid && candidate.target_ref === pull.base_ref
    && candidate.target_oid === trusted.base_oid && candidate.policy_revision === repo.policy_revision && candidate.strategy === strategy;
  if (!valid) blockers.push({ code: candidate ? 'candidate_stale' : 'candidate_missing', message: 'Build and verify a retained merge candidate against the current target.' });
  const candidatePatch = valid ? await inspectPatch(c, repo.id, repo.id, candidate!.target_oid, candidate!.candidate_oid!, false, candidate!.id) : null;
  if (candidatePatch && candidatePatch.merge_base_oid !== candidate!.target_oid) {
    blockers.push({ code: 'candidate_graph_mismatch', message: 'The candidate is not based on the accepted target revision.' });
  }
  const reviewedPaths = new Set(trusted.files.flatMap(file => file.old_path ? [file.path, file.old_path] : [file.path]));
  const candidatePaths = candidatePatch ? [...new Set(candidatePatch.files.flatMap(file => file.old_path ? [file.path, file.old_path] : [file.path]))].sort() : [];
  if (candidatePaths.some(path => !reviewedPaths.has(path))) blockers.push({ code: 'candidate_review_paths_changed',
    message: 'The actual candidate changes paths outside the reviewed patch. Rebase and refresh the review before merging.' });
  const candidateGraphVerified = candidatePatch?.merge_base_oid === candidate?.target_oid && !!candidatePatch;
  const verifications = await evaluateVerification(c, repo, candidateGraphVerified ? candidate!.candidate_oid : null,
    candidatePatch?.files ?? trusted.files, rules, blockers, candidatePatch ? {
      candidate_id: candidate!.id, target_ref: candidate!.target_ref, pull_id: item.id, changed_paths: candidatePaths,
    } : undefined);
  return { repo_id: repo.id, pull_id: item.id, revision: item.revision, patch_id: pull.current_patch_id, policy_revision: repo.policy_revision,
    head_oid: pull.head_oid, target_ref: pull.base_ref, target_oid: trusted.base_oid, candidate_id: candidate?.id ?? null,
    candidate_oid: candidate?.candidate_oid ?? null, strategy, eligible: blockers.length === 0, queueable, blockers, reviews, verifications, evaluated_at: now() };
}

export function registerMergeRoutes(app: App): void {
  const base = '/v1/repos/:repoId/pulls';
  route(app, 'GET', `${base}/merge-queue`, { summary: 'Read repository merge queue order and blocking reasons', tags: ['pulls'], capability: 'contents.read' }, async c => {
    const repo = await getRepository(c, c.req.param('repoId') ?? '');
    const p = pagination(c, `${repo.id}:merge-queue`);
    const rows = await many<MergeQueueEntry>(database(c), `SELECT * FROM pull_merge_queue WHERE repo_id=? AND ${pageSql()} ORDER BY created_at DESC,id DESC LIMIT ?`, repo.id, ...pageBindings(p));
    for (const row of rows) await getItem(c, 'pull_request', row.pull_id, 'contents.read', repo.id);
    return pagedResponse(c, rows.map(({ reason_json, ...row }) => ({ ...row, reasons: JSON.parse(reason_json) as unknown })), p);
  });
  route(app, 'GET', `${base}/:id/merge-eligibility`, { summary: 'Explain merge eligibility from current trusted evidence', tags: ['pulls'], capability: 'contents.read' }, async c => {
    const strategy = z.enum(['merge', 'squash', 'rebase']).safeParse(c.req.query('strategy') ?? 'merge');
    if (!strategy.success) throw new ApiError(422, 'invalid_strategy', 'Choose merge, squash, or rebase.');
    return respond(c, await getMergeEligibility(c, c.req.param('id') ?? '', { candidate_id: c.req.query('candidate_id'), strategy: strategy.data }));
  });
  const schema = z.strictObject({ strategy: z.enum(['merge', 'squash', 'rebase']).default('merge') });
  route(app, 'POST', `${base}/:id/merge-queue`, { summary: 'Queue exact-candidate verification and canonical merge publication', tags: ['pulls'],
    capability: 'pull_requests.merge', authorization: c => mergeAuthorizations(c), body: schema }, async c => {
    const { item, repo } = await getItem(c, 'pull_request');
    checkRevision(c, item);
    const pull = await pullDetails(c, item);
    const input = await jsonBody(c, schema);
    const eligibility = await getMergeEligibility(c, item.id, { strategy: input.strategy });
    if (!eligibility.queueable) conflict('merge_blocked', 'Resolve the current merge prerequisites before entering the queue.', { blockers: eligibility.blockers });
    const id = newId('mergeq');
    const prepared = await prepareOperation(c, { repo, kind: 'merge', resource_id: id, item_id: item.id,
      expected_item_revision: item.revision + 1, input: { queue_id: id, pull_id: item.id, patch_id: pull.current_patch_id, strategy: input.strategy } });
    const at = now();
    await updateItem(c, repo, item, 'pull_request.merge_queued', {}, [...prepared.statements,
      stmt(database(c), `INSERT INTO pull_merge_queue(id,repo_id,pull_id,patch_id,target_ref,head_oid,base_oid,strategy,policy_revision,operation_id,state,requested_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)`, id, repo.id, item.id, pull.current_patch_id, pull.base_ref, pull.head_oid,
      eligibility.target_oid, input.strategy, repo.policy_revision, prepared.operation.id, requirePrincipal(c).id, at, at),
    ], { queue_id: id, operation_id: prepared.operation.id, patch_id: pull.current_patch_id, target_oid: eligibility.target_oid });
    c.header('location', `/v1/operations/${prepared.operation.id}`);
    return respond(c, { id, repo_id: repo.id, pull_id: item.id, revision: 1, state: 'queued', strategy: input.strategy, operation: publicOperation(prepared.operation) }, 202);
  });
  route(app, 'GET', `${base}/:pullId/merge-queue/:id`, { summary: 'Read a merge queue entry', tags: ['pulls'], capability: 'contents.read' }, async c => {
    const { item, repo } = await getItem(c, 'pull_request', c.req.param('pullId'));
    const value = await one<MergeQueueEntry>(database(c), 'SELECT * FROM pull_merge_queue WHERE repo_id=? AND pull_id=? AND id=?', repo.id, item.id, c.req.param('id'));
    if (!value) notFound();
    const { reason_json, ...row } = value;
    return respond(c, { ...row, reasons: JSON.parse(reason_json) as unknown });
  });
  route(app, 'DELETE', `${base}/:pullId/merge-queue/:id`, { summary: 'Remove an unpublished merge queue entry', tags: ['pulls'],
    capability: 'pull_requests.merge', authorization: c => mergeAuthorizations(c) }, async c => {
    const { item, repo } = await getItem(c, 'pull_request', c.req.param('pullId'));
    const value = await one<MergeQueueEntry>(database(c), 'SELECT * FROM pull_merge_queue WHERE repo_id=? AND pull_id=? AND id=?', repo.id, item.id, c.req.param('id'));
    if (!value) notFound();
    checkRevision(c, value);
    if (['publishing', 'merged'].includes(value.state)) conflict('publication_in_progress', 'A publishing or merged candidate cannot be removed. Reconcile the native operation.');
    const at = now();
    await commit(c, { repo, item, resource_id: value.id, revision: value.revision + 1, type: 'pull_request.merge_dequeued',
      sql: "UPDATE pull_merge_queue SET state='cancelled',revision=revision+1,updated_at=? WHERE repo_id=? AND pull_id=? AND id=? AND revision=? AND state NOT IN ('publishing','merged')",
      bindings: [at, repo.id, item.id, value.id, value.revision], after: [...itemFence(database(c), item), itemTouch(database(c), item),
        stmt(database(c), "UPDATE operations SET status='cancelled',phase='cancelled',revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND status IN ('pending','waiting','running')", at, at, value.operation_id),
      ], data: { item_id: item.id, operation_id: value.operation_id } });
    return respond(c, { ...value, state: 'cancelled', revision: value.revision + 1, updated_at: at });
  });
}
