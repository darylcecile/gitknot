import { z } from 'zod';
import {
  ApiError, authorize, database, explainAuthorization, jsonBody, many, newId, now, one,
  principalForExplanation, requirePrincipal, route, sha256, stmt,
} from '@gitknot/core';
import type { App, AppContext, Principal } from '@gitknot/core';
import {
  checkRevision, commit, conflict, documentStatement, eventFor, getItem, gitPath, identifier,
  inboxStatement, itemFence, itemTouch, markdown, mentionStatements, notFound, pageBindings,
  pagedResponse, pageSql, pagination, respond, uniqueIds, unlocked, updateItem,
} from './common.ts';
import type { Item } from './common.ts';
import { mutablePull, pullDetails, readPatchFiles } from './patches.ts';
import type { PatchFile } from './patches.ts';
import { prepareOperation, publicOperation } from './operation-model.ts';

export interface Review {
  id: string; repo_id: string; pull_id: string; patch_id: string; reviewer_id: string; reviewer_json: string;
  decision: 'approve' | 'changes_requested' | 'comment'; scope: 'all' | 'files'; markdown: string;
  revision: number; document_revision: number; created_at: string;
}
export interface ReviewThread {
  id: string; repo_id: string; pull_id: string; patch_id: string; path: string; side: 'old' | 'new';
  start_line: number; end_line: number; anchor_fingerprint: string; created_by: string;
  resolved_by: string | null; resolved_at: string | null; outdated: number; revision: number;
  created_at: string; updated_at: string;
}
export interface Suggestion {
  id: string; repo_id: string; pull_id: string; thread_id: string; patch_id: string; replacement: string;
  created_by: string; state: string; operation_id: string | null; applied_patch_id: string | null;
  revision: number; created_at: string; updated_at: string;
}

const review = z.strictObject({ patch_id: identifier, decision: z.enum(['approve', 'changes_requested', 'comment']),
  scope: z.enum(['all', 'files']).default('all'), paths: z.array(gitPath).max(10000).default([]), markdown: markdown.default(''),
}).refine(value => value.scope === 'files' ? value.paths.length > 0 : value.paths.length === 0, 'File-scoped reviews require paths; whole-patch reviews do not.')
  .refine(value => new Set(value.paths).size === value.paths.length, 'Review paths must be unique.');

async function assertReviewer(c: AppContext, item: Item, id: string): Promise<Principal> {
  const principal = await principalForExplanation(c.env.DB, id);
  if (!principal) notFound();
  // The selecting caller already has read access. A request never creates a grant for its recipient.
  const explanation = await explainAuthorization(c, 'pull_requests.review', { repo_id: item.repo_id }, principal);
  if (!explanation.allowed) throw new ApiError(422, 'reviewer_unavailable', 'This principal is not currently permitted to review this repository.');
  const pull = await pullDetails(c, item);
  if (pull.head_repo_id !== item.repo_id && !(await explainAuthorization(c, 'contents.read', { repo_id: pull.head_repo_id }, principal)).allowed) {
    throw new ApiError(422, 'reviewer_unavailable', 'This principal is not currently permitted to read the proposed change.');
  }
  return principal;
}

async function readReview(c: AppContext, item: Item, id = c.req.param('id')): Promise<Review> {
  const value = await one<Review>(database(c), 'SELECT * FROM pull_reviews WHERE repo_id=? AND pull_id=? AND id=?', item.repo_id, item.id, id);
  if (!value) notFound();
  return value;
}
async function readThread(c: AppContext, item: Item, id = c.req.param('id')): Promise<ReviewThread> {
  const value = await one<ReviewThread>(database(c), 'SELECT * FROM pull_review_threads WHERE repo_id=? AND pull_id=? AND id=?', item.repo_id, item.id, id);
  if (!value) notFound();
  return value;
}

export function registerReviewRoutes(app: App): void {
  registerReviews(app);
  registerRequests(app);
  registerThreads(app);
  registerSuggestions(app);
}

function registerReviews(app: App): void {
  const path = '/v1/repos/:repoId/pulls/:pullId/reviews';
  route(app, 'GET', path, { summary: 'List reviews with current patch validity', tags: ['reviews'], capability: 'contents.read' }, async c => {
    const { item, repo } = await getItem(c, 'pull_request', c.req.param('pullId'));
    const pull = await pullDetails(c, item);
    const p = pagination(c, `${repo.id}:${item.id}:reviews`);
    const rows = await many<Review & { validity: string; changed_paths_json: string; dismissed_at: string | null; dismissal_reason: string | null }>(database(c),
      `SELECT r.*,v.state AS validity,v.changed_paths_json,d.created_at AS dismissed_at,d.reason AS dismissal_reason
       FROM pull_reviews r LEFT JOIN pull_review_validity v ON v.repo_id=r.repo_id AND v.review_id=r.id AND v.patch_id=?
       LEFT JOIN pull_review_dismissals d ON d.repo_id=r.repo_id AND d.review_id=r.id
       WHERE r.repo_id=? AND r.pull_id=? AND ${pageSql('r')} ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,
    pull.current_patch_id, repo.id, item.id, ...pageBindings(p));
    return pagedResponse(c, rows.map(({ reviewer_json, changed_paths_json, ...value }) => ({ ...value,
      revision: value.revision + Number(!!value.dismissed_at), changed_paths: JSON.parse(changed_paths_json ?? '[]') as string[] })), p);
  });
  route(app, 'GET', `${path}/:id`, { summary: 'Read immutable review decision and dismissal history', tags: ['reviews'], capability: 'contents.read' }, async c => {
    const { item } = await getItem(c, 'pull_request', c.req.param('pullId'));
    const value = await readReview(c, item);
    const dismissal = await one(database(c), 'SELECT id,actor_id,reason,created_at FROM pull_review_dismissals WHERE repo_id=? AND review_id=?', item.repo_id, value.id);
    const { reviewer_json, ...publicReview } = value;
    return respond(c, { ...publicReview, dismissal, revision: value.revision + Number(!!dismissal) });
  });
  route(app, 'POST', path, { summary: 'Submit a patch-scoped review', tags: ['reviews'], capability: 'pull_requests.review', body: review }, async c => {
    const { item, repo } = await getItem(c, 'pull_request', c.req.param('pullId'), 'pull_requests.review');
    checkRevision(c, item);
    mutablePull(item);
    unlocked(item);
    const input = await jsonBody(c, review);
    const pull = await pullDetails(c, item);
    if (input.patch_id !== pull.current_patch_id) conflict('patch_changed', 'Review the current patch before submitting a decision.');
    const actor = requirePrincipal(c);
    const author = await principalForExplanation(c.env.DB, item.author_id);
    if (input.decision === 'approve' && (actor.id === item.author_id || (actor.user_id && actor.user_id === author?.user_id))) {
      conflict('author_approval', 'An author cannot approve their own proposed change.');
    }
    const files = await readPatchFiles(c, item, pull.current_patch_id);
    const fileByPath = new Map(files.map(file => [file.path, file]));
    if (input.paths.some(path => !fileByPath.has(path))) throw new ApiError(422, 'review_path_missing', 'Review paths must belong to this immutable patch.');
    const scoped = input.scope === 'all' ? files : input.paths.map(path => fileByPath.get(path)!);
    const id = newId('review');
    const at = now();
    const event = eventFor(c, 'pull_request.review_submitted', id, 1, repo, { item_id: item.id, review_id: id, decision: input.decision, patch_id: pull.current_patch_id });
    await commit(c, { repo, item, resource_id: id, revision: 1, type: event.type, event,
      sql: 'UPDATE collaboration_items SET revision=revision+1,updated_at=? WHERE repo_id=? AND id=? AND revision=? AND deleted_at IS NULL AND locked_at IS NULL',
      bindings: [at, repo.id, item.id, item.revision], after: [
        stmt(database(c), `INSERT INTO pull_reviews(id,repo_id,pull_id,patch_id,reviewer_id,reviewer_json,decision,scope,markdown,created_at,submitted_revision)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, repo.id, item.id, pull.current_patch_id, actor.id, JSON.stringify(actor), input.decision, input.scope, input.markdown, at, item.revision + 1),
        ...scoped.map(file => stmt(database(c), 'INSERT INTO pull_review_files(repo_id,review_id,path,patch_fingerprint) VALUES (?,?,?,?)', repo.id, id, file.path, file.patch_fingerprint)),
        stmt(database(c), "INSERT INTO pull_review_validity(repo_id,review_id,patch_id,state,changed_paths_json,created_at) VALUES (?,?,?,'current','[]',?)", repo.id, id, pull.current_patch_id, at),
        await documentStatement(database(c), { repo_id: repo.id, resource_kind: 'review', resource_id: id, document_revision: 1, markdown: input.markdown, actor_id: actor.id }),
        ...await mentionStatements(c, item, id, 1, input.markdown, event.id),
        ...(input.decision === 'comment' ? [] : [
          stmt(database(c), `UPDATE collaboration_inbox SET state='completed',completed_at=?,updated_at=?,revision=revision+1
            WHERE repo_id=? AND item_id=? AND reason='review_request' AND state='outstanding' AND source_id IN
            (SELECT id FROM pull_review_requests WHERE repo_id=? AND pull_id=? AND reviewer_id=? AND state='requested')`, at, at, repo.id, item.id, repo.id, item.id, actor.id),
          stmt(database(c), `UPDATE pull_review_requests SET state='completed',review_id=?,revision=revision+1,updated_at=?
            WHERE repo_id=? AND pull_id=? AND reviewer_id=? AND state='requested'`, id, at, repo.id, item.id, actor.id),
        ]),
      ] });
    return respond(c, { id, repo_id: repo.id, pull_id: item.id, reviewer_id: actor.id, ...input, revision: 1,
      document_revision: 1, validity: 'current', created_at: at, pull_revision: item.revision + 1 }, 201);
  });
  const dismissal = z.strictObject({ reason: z.string().trim().min(1).max(2000) });
  route(app, 'POST', `${path}/:id/dismiss`, { summary: 'Dismiss a review with an immutable reason', tags: ['reviews'], capability: 'pull_requests.manage', body: dismissal }, async c => {
    const { item, repo } = await getItem(c, 'pull_request', c.req.param('pullId'), 'pull_requests.manage');
    const value = await readReview(c, item);
    checkRevision(c, value);
    const input = await jsonBody(c, dismissal);
    const id = newId('dismissal');
    await commit(c, { repo, item, resource_id: value.id, revision: value.revision + 1, type: 'pull_request.review_dismissed',
      sql: `INSERT INTO pull_review_dismissals(id,repo_id,review_id,actor_id,reason,created_at)
        SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM pull_reviews WHERE repo_id=? AND id=? AND revision=?)`,
      bindings: [id, repo.id, value.id, requirePrincipal(c).id, input.reason, now(), repo.id, value.id, value.revision],
      after: [...itemFence(database(c), item), itemTouch(database(c), item)], data: { item_id: item.id, review_id: value.id, reason: input.reason } });
    return respond(c, { id: value.id, revision: value.revision + 1, dismissed: true, reason: input.reason });
  });
}

function registerRequests(app: App): void {
  const path = '/v1/repos/:repoId/pulls/:pullId/review-requests';
  interface Request { id: string; repo_id: string; pull_id: string; reviewer_id: string; state: string; revision: number; created_at: string }
  route(app, 'GET', path, { summary: 'List requested reviewers and their resolution', tags: ['reviews'], capability: 'contents.read' }, async c => {
    const { item, repo } = await getItem(c, 'pull_request', c.req.param('pullId'));
    const p = pagination(c, `${repo.id}:${item.id}:review-requests`);
    const rows = await many<Request>(database(c), `SELECT * FROM pull_review_requests WHERE repo_id=? AND pull_id=? AND ${pageSql()}
      ORDER BY created_at DESC,id DESC LIMIT ?`, repo.id, item.id, ...pageBindings(p));
    return pagedResponse(c, rows, p);
  });
  const schema = z.strictObject({ reviewer_ids: uniqueIds.min(1).max(50) });
  route(app, 'POST', path, { summary: 'Request authorized reviewers and create inbox actions', tags: ['reviews'], capability: 'pull_requests.write', body: schema }, async c => {
    const { item, repo } = await getItem(c, 'pull_request', c.req.param('pullId'), 'pull_requests.write');
    checkRevision(c, item);
    mutablePull(item);
    const input = await jsonBody(c, schema);
    const reviewers = [];
    for (const id of input.reviewer_ids) reviewers.push(await assertReviewer(c, item, id));
    const event = eventFor(c, 'pull_request.review_requested', item.id, item.revision + 1, repo, { item_id: item.id, reviewer_ids: input.reviewer_ids });
    const after: D1PreparedStatement[] = [];
    const requests = reviewers.map(reviewer => ({ id: newId('review_request'), repo_id: repo.id, pull_id: item.id,
      reviewer_id: reviewer.id, revision: 1, state: 'requested', created_at: now() }));
    for (const [index, reviewer] of reviewers.entries()) {
      const request = requests[index]!;
      after.push(stmt(database(c), `INSERT INTO pull_review_requests(id,repo_id,pull_id,reviewer_id,requested_by,state,created_at,updated_at)
        VALUES (?,?,?,?,?,'requested',?,?)`, request.id, repo.id, item.id, reviewer.id, requirePrincipal(c).id, request.created_at, request.created_at));
      if (reviewer.user_id) after.push(inboxStatement(database(c), { user_id: reviewer.user_id, item, reason: 'review_request', source_id: request.id, event_id: event.id }));
    }
    const updated = await updateItem(c, repo, item, event.type, {}, after, {}, undefined, event);
    return respond(c, { id: item.id, revision: updated.revision, requests }, 201);
  });
  route(app, 'DELETE', `${path}/:id`, { summary: 'Cancel a pending review request', tags: ['reviews'], capability: 'pull_requests.write' }, async c => {
    const { item, repo } = await getItem(c, 'pull_request', c.req.param('pullId'), 'pull_requests.write');
    const request = await one<Request>(database(c), 'SELECT * FROM pull_review_requests WHERE repo_id=? AND pull_id=? AND id=?', repo.id, item.id, c.req.param('id'));
    if (!request) notFound();
    checkRevision(c, request);
    if (request.state !== 'requested') conflict('review_request_resolved', 'This review request has already been resolved.');
    await commit(c, { repo, item, resource_id: request.id, revision: request.revision + 1, type: 'pull_request.review_request_cancelled',
      sql: "UPDATE pull_review_requests SET state='cancelled',revision=revision+1,updated_at=? WHERE repo_id=? AND pull_id=? AND id=? AND revision=? AND state='requested'",
      bindings: [now(), repo.id, item.id, request.id, request.revision], after: [
        ...itemFence(database(c), item), itemTouch(database(c), item), stmt(database(c), `UPDATE collaboration_inbox SET state='completed',completed_at=?,updated_at=?,revision=revision+1
          WHERE repo_id=? AND item_id=? AND reason='review_request' AND source_id=? AND state='outstanding'`, now(), now(), repo.id, item.id, request.id),
      ], data: { item_id: item.id, reviewer_id: request.reviewer_id } });
    return respond(c, { ...request, state: 'cancelled', revision: request.revision + 1 });
  });
}

function validateLineAnchor(file: PatchFile, side: 'old' | 'new', start: number, end: number): void {
  const hunks = JSON.parse(file.hunks_json) as Array<{ old_start: number; old_lines: number; new_start: number; new_lines: number }>;
  const count = side === 'old' ? file.old_lines : file.new_lines;
  const withinHunk = hunks.some(hunk => {
    const first = side === 'old' ? hunk.old_start : hunk.new_start;
    const length = side === 'old' ? hunk.old_lines : hunk.new_lines;
    return length > 0 && start >= first && end < first + length;
  });
  if (file.binary || end < start || end > count || !withinHunk) throw new ApiError(422, 'invalid_review_anchor', 'The line range must lie within one verified text-diff hunk.');
}

function registerThreads(app: App): void {
  const path = '/v1/repos/:repoId/pulls/:pullId/threads';
  route(app, 'GET', path, { summary: 'List revision-anchored review conversations', tags: ['reviews'], capability: 'contents.read' }, async c => {
    const { item, repo } = await getItem(c, 'pull_request', c.req.param('pullId'));
    const p = pagination(c, `${repo.id}:${item.id}:threads`);
    const rows = await many<ReviewThread>(database(c), `SELECT * FROM pull_review_threads WHERE repo_id=? AND pull_id=? AND ${pageSql()}
      ORDER BY created_at DESC,id DESC LIMIT ?`, repo.id, item.id, ...pageBindings(p));
    return pagedResponse(c, rows, p);
  });
  route(app, 'GET', `${path}/:id`, { summary: 'Read a review thread anchor', tags: ['reviews'], capability: 'contents.read' }, async c => {
    const { item } = await getItem(c, 'pull_request', c.req.param('pullId'));
    return respond(c, await readThread(c, item));
  });
  const schema = z.strictObject({ patch_id: identifier, path: gitPath, side: z.enum(['old', 'new']),
    start_line: z.number().int().positive(), end_line: z.number().int().positive(), markdown: markdown.min(1) });
  route(app, 'POST', path, { summary: 'Anchor a review thread to verified patch lines', tags: ['reviews'], capability: 'pull_requests.review', body: schema }, async c => {
    const { item, repo } = await getItem(c, 'pull_request', c.req.param('pullId'), 'pull_requests.review');
    checkRevision(c, item);
    unlocked(item);
    const input = await jsonBody(c, schema);
    const pull = await pullDetails(c, item);
    const file = await one<PatchFile>(database(c), 'SELECT * FROM pull_patch_files WHERE repo_id=? AND pull_id=? AND patch_id=? AND path=?', repo.id, item.id, input.patch_id, input.path);
    if (!file) notFound();
    validateLineAnchor(file, input.side, input.start_line, input.end_line);
    const id = newId('thread');
    const commentId = newId('comment');
    const at = now();
    const event = eventFor(c, 'pull_request.thread_created', id, 1, repo, { item_id: item.id, thread_id: id, patch_id: input.patch_id });
    const fingerprint = await sha256(JSON.stringify([input.patch_id, input.path, input.side, input.start_line, input.end_line, file.patch_fingerprint]));
    const after = [stmt(database(c), `INSERT INTO pull_review_threads
      (id,repo_id,pull_id,patch_id,path,side,start_line,end_line,anchor_fingerprint,created_by,outdated,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, repo.id, item.id, input.patch_id, input.path, input.side, input.start_line, input.end_line,
    fingerprint, requirePrincipal(c).id, Number(input.patch_id !== pull.current_patch_id), at, at),
    stmt(database(c), 'INSERT INTO collaboration_comments(id,repo_id,item_id,review_thread_id,author_id,markdown,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      commentId, repo.id, item.id, id, requirePrincipal(c).id, input.markdown, at, at),
    await documentStatement(database(c), { repo_id: repo.id, resource_kind: 'comment', resource_id: commentId, document_revision: 1, markdown: input.markdown, actor_id: requirePrincipal(c).id }),
    ...await mentionStatements(c, item, commentId, 1, input.markdown, event.id)];
    await commit(c, { repo, item, resource_id: id, revision: 1, type: event.type, event,
      sql: 'UPDATE collaboration_items SET revision=revision+1,updated_at=? WHERE repo_id=? AND id=? AND revision=? AND deleted_at IS NULL AND locked_at IS NULL',
      bindings: [at, repo.id, item.id, item.revision], after });
    return respond(c, { id, repo_id: repo.id, pull_id: item.id, ...input, anchor_fingerprint: fingerprint, comment_id: commentId,
      outdated: input.patch_id !== pull.current_patch_id, revision: 1, pull_revision: item.revision + 1, created_at: at }, 201);
  });
  const resolution = z.strictObject({ resolved: z.boolean() });
  route(app, 'PATCH', `${path}/:id`, { summary: 'Resolve or reopen a review thread', tags: ['reviews'], capability: 'pull_requests.review', body: resolution }, async c => {
    const { item, repo } = await getItem(c, 'pull_request', c.req.param('pullId'), 'pull_requests.review');
    const thread = await readThread(c, item);
    checkRevision(c, thread);
    const actor = requirePrincipal(c);
    if (actor.id !== thread.created_by && actor.id !== item.author_id) await authorize(c, 'pull_requests.manage', { repo_id: repo.id });
    const { resolved } = await jsonBody(c, resolution);
    const at = now();
    await commit(c, { repo, item, resource_id: thread.id, revision: thread.revision + 1, type: 'pull_request.thread_resolution_changed',
      sql: 'UPDATE pull_review_threads SET resolved_at=?,resolved_by=?,revision=revision+1,updated_at=? WHERE repo_id=? AND pull_id=? AND id=? AND revision=?',
      bindings: [resolved ? at : null, resolved ? actor.id : null, at, repo.id, item.id, thread.id, thread.revision],
      after: [...itemFence(database(c), item), itemTouch(database(c), item)], data: { item_id: item.id, resolved, thread_id: thread.id } });
    return respond(c, { ...thread, resolved_at: resolved ? at : null, resolved_by: resolved ? actor.id : null, revision: thread.revision + 1, updated_at: at });
  });
}

function registerSuggestions(app: App): void {
  const path = '/v1/repos/:repoId/pulls/:pullId/suggestions';
  route(app, 'GET', path, { summary: 'List suggested changes', tags: ['reviews'], capability: 'contents.read' }, async c => {
    const { item, repo } = await getItem(c, 'pull_request', c.req.param('pullId'));
    const p = pagination(c, `${repo.id}:${item.id}:suggestions`);
    const rows = await many<Suggestion>(database(c), `SELECT * FROM pull_suggestions WHERE repo_id=? AND pull_id=? AND ${pageSql()}
      ORDER BY created_at DESC,id DESC LIMIT ?`, repo.id, item.id, ...pageBindings(p));
    return pagedResponse(c, rows, p);
  });
  const schema = z.strictObject({ thread_id: identifier, replacement: z.string().max(500_000) });
  route(app, 'POST', path, { summary: 'Propose an exact anchored replacement', tags: ['reviews'], capability: 'pull_requests.review', body: schema }, async c => {
    const { item, repo } = await getItem(c, 'pull_request', c.req.param('pullId'), 'pull_requests.review');
    checkRevision(c, item);
    mutablePull(item);
    const input = await jsonBody(c, schema);
    const thread = await readThread(c, item, input.thread_id);
    const pull = await pullDetails(c, item);
    if (thread.patch_id !== pull.current_patch_id || thread.side !== 'new' || thread.outdated || thread.resolved_at) {
      conflict('suggestion_anchor_stale', 'Suggestions require an unresolved new-side thread on the current patch.');
    }
    const id = newId('suggestion');
    const at = now();
    await updateItem(c, repo, item, 'pull_request.suggestion_created', {}, [
      stmt(database(c), `INSERT INTO pull_suggestions(id,repo_id,pull_id,thread_id,patch_id,replacement,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`, id, repo.id, item.id, thread.id, thread.patch_id, input.replacement, requirePrincipal(c).id, at, at),
      await documentStatement(database(c), { repo_id: repo.id, resource_kind: 'suggestion', resource_id: id, document_revision: 1,
        markdown: input.replacement, actor_id: requirePrincipal(c).id }),
    ], { suggestion_id: id, thread_id: thread.id, patch_id: thread.patch_id });
    return respond(c, { id, repo_id: repo.id, pull_id: item.id, ...input, patch_id: thread.patch_id, state: 'proposed', revision: 1, created_at: at }, 201);
  });
  route(app, 'GET', `${path}/:id`, { summary: 'Read suggested change state', tags: ['reviews'], capability: 'contents.read' }, async c => {
    const { item, repo } = await getItem(c, 'pull_request', c.req.param('pullId'));
    const value = await one<Suggestion>(database(c), 'SELECT * FROM pull_suggestions WHERE repo_id=? AND pull_id=? AND id=?', repo.id, item.id, c.req.param('id'));
    if (!value) notFound();
    return respond(c, value);
  });
  const apply = z.strictObject({ pull_revision: z.number().int().positive(), message: z.string().trim().min(1).max(10000).default('Apply suggested change') });
  route(app, 'POST', `${path}/:id/apply`, { summary: 'Apply a suggestion through native Git publication', tags: ['reviews'], capability: 'pull_requests.write', body: apply }, async c => {
    const { item, repo } = await getItem(c, 'pull_request', c.req.param('pullId'), 'pull_requests.write');
    mutablePull(item);
    const value = await one<Suggestion>(database(c), 'SELECT * FROM pull_suggestions WHERE repo_id=? AND pull_id=? AND id=?', repo.id, item.id, c.req.param('id'));
    if (!value) notFound();
    checkRevision(c, value);
    const input = await jsonBody(c, apply);
    const pull = await pullDetails(c, item);
    if (input.pull_revision !== item.revision || value.patch_id !== pull.current_patch_id || !['proposed', 'failed'].includes(value.state)) {
      conflict('suggestion_stale', 'Refresh the pull request and suggestion before applying this change.');
    }
    const thread = await readThread(c, item, value.thread_id);
    await authorize(c, 'contents.push', { repo_id: pull.head_repo_id, ref: pull.head_ref, paths: [thread.path] });
    const prepared = await prepareOperation(c, { repo, kind: 'suggestion', resource_id: value.id, item_id: item.id,
      expected_item_revision: item.revision + 1, input: { suggestion_id: value.id, pull_id: item.id, patch_id: pull.current_patch_id,
        head_repo_id: pull.head_repo_id, head_ref: pull.head_ref, head_oid: pull.head_oid, base_oid: pull.base_oid,
        path: thread.path, start_line: thread.start_line, end_line: thread.end_line, replacement: value.replacement, message: input.message } });
    await commit(c, { repo, item, resource_id: value.id, revision: value.revision + 1, type: 'pull_request.suggestion_apply_requested',
      sql: `UPDATE pull_suggestions SET state='applying',operation_id=?,revision=revision+1,updated_at=? WHERE repo_id=? AND pull_id=? AND id=? AND revision=? AND state IN ('proposed','failed')`,
      bindings: [prepared.operation.id, now(), repo.id, item.id, value.id, value.revision],
      after: [...prepared.statements, ...itemFence(database(c), item), itemTouch(database(c), item)],
      data: { item_id: item.id, suggestion_id: value.id, operation_id: prepared.operation.id } });
    c.header('location', `/v1/operations/${prepared.operation.id}`);
    return respond(c, { id: value.id, revision: value.revision + 1, state: 'applying', operation: publicOperation(prepared.operation) }, 202);
  });
  route(app, 'DELETE', `${path}/:id`, { summary: 'Reject a proposed suggestion', tags: ['reviews'], capability: 'pull_requests.review' }, async c => {
    const { item, repo } = await getItem(c, 'pull_request', c.req.param('pullId'), 'pull_requests.review');
    const value = await one<Suggestion>(database(c), 'SELECT * FROM pull_suggestions WHERE repo_id=? AND pull_id=? AND id=?', repo.id, item.id, c.req.param('id'));
    if (!value) notFound();
    checkRevision(c, value);
    if (!['proposed', 'failed'].includes(value.state)) conflict('suggestion_in_progress', 'An applying or applied suggestion cannot be rejected.');
    if (![value.created_by, item.author_id].includes(requirePrincipal(c).id)) await authorize(c, 'pull_requests.manage', { repo_id: repo.id });
    await commit(c, { repo, item, resource_id: value.id, revision: value.revision + 1, type: 'pull_request.suggestion_rejected',
      sql: "UPDATE pull_suggestions SET state='rejected',revision=revision+1,updated_at=? WHERE repo_id=? AND pull_id=? AND id=? AND revision=? AND state IN ('proposed','failed')",
      bindings: [now(), repo.id, item.id, value.id, value.revision], after: [...itemFence(database(c), item), itemTouch(database(c), item)], data: { item_id: item.id } });
    return respond(c, { id: value.id, revision: value.revision + 1, state: 'rejected' });
  });
}
