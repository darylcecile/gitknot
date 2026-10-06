import { z } from 'zod';
import {
  ApiError, authorize, database, decodeCursor, encodeCursor, etag, getRepository, jsonBody,
  listResponse, many, one, page, requirePrincipal, route, stmt,
} from '@gitknot/core';
import type { App, AppContext } from '@gitknot/core';
import {
  checkRevision, conflict, createItem, ensureCanEditDocument, getItem, identifier, itemFence, listItems, markdown,
  newItem, notFound, oid, pageBindings, pageSql, pagination, nextCursor, ref, related,
  respond, title, updateItem,
} from './common.ts';
import { uniqueIds } from './common.ts';
import { labelStatements } from './issues.ts';
import { registerDependencies } from './dependencies.ts';
import { inspectPatch, nativeJSON } from './native.ts';
import { inspectTargetPatch, mutablePull, preparePatch, pullDetails, readPatch, readPatchFiles } from './patches.ts';
import type { Patch, PatchFile } from './patches.ts';
import { registerReviewRoutes } from './reviews.ts';
import { registerMergeRoutes } from './merge.ts';
import { prepareOperation, publicOperation } from './operation-model.ts';

const create = z.strictObject({ title, markdown: markdown.default(''), draft: z.boolean().default(false),
  head_repo_id: identifier.optional(), base_ref: ref, head_ref: ref, base_oid: oid, head_oid: oid,
  milestone_id: identifier.nullable().optional(), task_id: identifier.optional() });
const edit = z.strictObject({ title: title.optional(), markdown: markdown.optional(),
  state: z.enum(['open', 'draft', 'closed']).optional(), milestone_id: identifier.nullable().optional(),
}).refine(value => Object.keys(value).length > 0, 'Supply at least one field.');
const patchUpdate = z.strictObject({ base_oid: oid, head_oid: oid, base_ref: ref.optional(), head_ref: ref.optional() });

export async function readPull(c: AppContext, id = c.req.param('id')): Promise<Record<string, unknown> & { revision: number }> {
  const { item, repo } = await getItem(c, 'pull_request', id);
  const pull = await pullDetails(c, item);
  const patch = await readPatch(c, item, pull.current_patch_id);
  const milestone = await related(c, 'milestones', repo.id, pull.milestone_id);
  const labels = await many(database(c), `SELECT l.* FROM labels l JOIN collaboration_item_labels il ON il.repo_id=l.repo_id AND il.label_id=l.id
    WHERE il.repo_id=? AND il.item_id=? AND l.deleted_at IS NULL ORDER BY l.name LIMIT 100`, repo.id, item.id);
  if (pull.task_id) await getItem(c, 'task', pull.task_id, 'contents.read', repo.id);
  const queue = await one(database(c), `SELECT id,patch_id,state,candidate_oid,operation_id,reason_json,revision,created_at,updated_at
    FROM pull_merge_queue WHERE repo_id=? AND pull_id=? ORDER BY created_at DESC,id DESC LIMIT 1`, repo.id, item.id);
  return { ...item, ...pull, patch, milestone, labels, merge_queue: queue };
}

export function registerPullRoutes(app: App): void {
  const path = '/v1/repos/:repoId/pulls';
  registerDependencies(app, 'pull');
  registerReviewRoutes(app);
  registerMergeRoutes(app);
  route(app, 'GET', path, { summary: 'List pull requests', tags: ['pulls'], capability: 'contents.read' }, c => listItems(c, 'pull_request'));
  route(app, 'GET', `${path}/:id`, { summary: 'Read pull request and patch state', tags: ['pulls'], capability: 'contents.read' }, async c => respond(c, await readPull(c)));
  route(app, 'POST', path, { summary: 'Open a pull request with verified immutable patch evidence', tags: ['pulls'], capability: 'pull_requests.write', body: create }, async c => {
    const repo = await getRepository(c, c.req.param('repoId') ?? '', 'pull_requests.write');
    const input = await jsonBody(c, create);
    const headRepo = await getRepository(c, input.head_repo_id ?? repo.id);
    if (headRepo.id === repo.id && input.base_ref === input.head_ref) conflict('same_branch', 'A pull request requires different source and target branches.');
    await related(c, 'milestones', repo.id, input.milestone_id);
    const task = input.task_id ? (await getItem(c, 'task', input.task_id, 'contents.read', repo.id)).item : null;
    const evidence = await inspectTargetPatch(c, { repo_id: repo.id, head_repo_id: headRepo.id, base_ref: input.base_ref, head_ref: input.head_ref,
      expected_base_oid: input.base_oid, expected_head_oid: input.head_oid, retain: true });
    if (!evidence.files.length) conflict('empty_patch', 'These revisions contain no proposed file changes.');
    await getRepository(c, repo.id, 'pull_requests.write');
    await getRepository(c, headRepo.id);
    const item = newItem(c, repo.id, 'pull_request', { title: input.title, markdown: input.markdown, state: input.draft ? 'draft' : 'open' });
    const prepared = await preparePatch(c, item, evidence, 1);
    await createItem(c, repo, item, [
      ...(task ? itemFence(database(c), task) : []),
      stmt(database(c), `INSERT INTO pull_requests(id,repo_id,head_repo_id,base_ref,head_ref,base_oid,head_oid,current_patch_id,milestone_id,task_id)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, item.id, repo.id, headRepo.id, input.base_ref, input.head_ref, input.base_oid, input.head_oid,
      prepared.patch.id, input.milestone_id ?? null, task?.id ?? null), ...prepared.statements,
    ], { patch_id: prepared.patch.id, head_oid: input.head_oid, base_oid: input.base_oid, task_id: task?.id ?? null });
    return respond(c, await readPull(c, item.id), 201);
  });
  route(app, 'PATCH', `${path}/:id`, { summary: 'Edit or transition a pull request', tags: ['pulls'], capability: 'pull_requests.write', body: edit }, async c => {
    const { item, repo } = await getItem(c, 'pull_request', c.req.param('id'), 'pull_requests.write');
    const input = await jsonBody(c, edit);
    await ensureCanEditDocument(c, item);
    if (item.state === 'merged' && input.state !== undefined) conflict('already_merged', 'A merged pull request cannot be reopened.');
    await related(c, 'milestones', repo.id, input.milestone_id);
    const fields: Record<string, string> = {};
    for (const key of ['title', 'markdown', 'state'] as const) if (input[key] !== undefined) fields[key] = input[key]!;
    const after: D1PreparedStatement[] = [];
    if (input.milestone_id !== undefined) after.push(stmt(database(c), 'UPDATE pull_requests SET milestone_id=? WHERE repo_id=? AND id=?', input.milestone_id, repo.id, item.id));
    if (input.state && input.state !== 'open') {
      if (await one(database(c), "SELECT 1 FROM pull_merge_queue WHERE repo_id=? AND pull_id=? AND state='publishing'", repo.id, item.id)) {
        conflict('publication_in_progress', 'Reconcile the active publication before changing pull-request state.');
      }
      after.push(stmt(database(c), `UPDATE pull_merge_queue SET state='cancelled',revision=revision+1,updated_at=? WHERE repo_id=? AND pull_id=?
        AND state IN ('queued','preparing','verifying','ready','blocked')`, new Date().toISOString(), repo.id, item.id));
    }
    await updateItem(c, repo, item, 'pull_request.updated', fields, after, { changed_fields: Object.keys(input) });
    return respond(c, await readPull(c));
  });
  route(app, 'POST', `${path}/:id/patches`, { summary: 'Record a new native-backed patch and explicit approval invalidation', tags: ['pulls'], capability: 'pull_requests.write', body: patchUpdate }, async c => {
    const { item, repo } = await getItem(c, 'pull_request', c.req.param('id'), 'pull_requests.write');
    checkRevision(c, item);
    mutablePull(item);
    await ensureCanEditDocument(c, item);
    const input = await jsonBody(c, patchUpdate);
    const pull = await pullDetails(c, item);
    if (input.head_oid === pull.head_oid && input.base_oid === pull.base_oid && (input.base_ref ?? pull.base_ref) === pull.base_ref && (input.head_ref ?? pull.head_ref) === pull.head_ref) {
      conflict('patch_unchanged', 'This is already the current patch.');
    }
    if (await one(database(c), "SELECT 1 FROM pull_merge_queue WHERE repo_id=? AND pull_id=? AND state='publishing'", repo.id, item.id)) conflict('publication_in_progress', 'Wait for publication reconciliation before replacing this patch.');
    const evidence = await inspectTargetPatch(c, { repo_id: repo.id, head_repo_id: pull.head_repo_id,
      base_ref: input.base_ref ?? pull.base_ref, head_ref: input.head_ref ?? pull.head_ref,
      expected_base_oid: input.base_oid, expected_head_oid: input.head_oid, retain: true });
    const old = await readPatch(c, item, pull.current_patch_id);
    const next = await preparePatch(c, item, evidence, old.version + 1);
    await getItem(c, 'pull_request', item.id, 'pull_requests.write', repo.id);
    const changed = await updateItem(c, repo, item, 'pull_request.patch_updated', {}, [
      ...next.statements, stmt(database(c), 'UPDATE pull_requests SET base_oid=?,head_oid=?,base_ref=?,head_ref=?,current_patch_id=? WHERE repo_id=? AND id=?',
        input.base_oid, input.head_oid, input.base_ref ?? pull.base_ref, input.head_ref ?? pull.head_ref, next.patch.id, repo.id, item.id),
    ], { patch_id: next.patch.id, previous_patch_id: old.id, head_oid: input.head_oid, base_oid: input.base_oid, review_validity_recomputed: true });
    return respond(c, { ...next.patch, revision: 1, pull_revision: changed.revision }, 201);
  });
  registerPatchReads(app, path);
  registerRestack(app, path);
  const labels = z.strictObject({ label_ids: uniqueIds });
  route(app, 'PUT', `${path}/:id/labels`, { summary: 'Set pull-request labels', tags: ['pulls'], capability: 'pull_requests.write', body: labels }, async c => {
    const { item, repo } = await getItem(c, 'pull_request', c.req.param('id'), 'pull_requests.write');
    await ensureCanEditDocument(c, item);
    const input = await jsonBody(c, labels);
    await updateItem(c, repo, item, 'pull_request.labels_changed', {}, await labelStatements(c, item, input.label_ids), input);
    return respond(c, await readPull(c));
  });
}

function registerPatchReads(app: App, path: string): void {
  route(app, 'GET', `${path}/:id/patches`, { summary: 'List immutable patch versions', tags: ['pulls'], capability: 'contents.read' }, async c => {
    const { item, repo } = await getItem(c, 'pull_request');
    const p = pagination(c, `${repo.id}:${item.id}:patches`);
    const rows = await many<Patch>(database(c), `SELECT * FROM pull_patches WHERE repo_id=? AND pull_id=? AND ${pageSql()}
      ORDER BY created_at DESC,id DESC LIMIT ?`, repo.id, item.id, ...pageBindings(p));
    return listResponse(c, rows.slice(0, p.limit), rows.length > p.limit ? nextCursor(p, rows[p.limit - 1]) : null);
  });
  route(app, 'GET', `${path}/:pullId/patches/:id`, { summary: 'Read an immutable patch version', tags: ['pulls'], capability: 'contents.read' }, async c => {
    const { item } = await getItem(c, 'pull_request', c.req.param('pullId'));
    const patch = await readPatch(c, item, c.req.param('id') ?? '');
    c.header('etag', etag(patch.patch_fingerprint));
    return c.json(patch);
  });
  route(app, 'GET', `${path}/:pullId/patches/:id/files`, { summary: 'Page native patch files and immutable hunk anchors', tags: ['pulls'], capability: 'contents.read' }, async c => {
    const { item, repo } = await getItem(c, 'pull_request', c.req.param('pullId'));
    const patch = await readPatch(c, item, c.req.param('id') ?? '');
    const { cursor, limit } = page(c);
    const parsed = z.strictObject({ patch_id: identifier, offset: z.number().int().min(0).max(10000) }).safeParse(decodeCursor(cursor, { patch_id: patch.id, offset: 0 }));
    if (!parsed.success || parsed.data.patch_id !== patch.id) throw new ApiError(422, 'invalid_cursor', 'This cursor belongs to a different patch.');
    const rows = await many<PatchFile>(database(c), `SELECT * FROM pull_patch_files WHERE repo_id=? AND pull_id=? AND patch_id=? ORDER BY path LIMIT ? OFFSET ?`,
      repo.id, item.id, patch.id, limit + 1, parsed.data.offset);
    return listResponse(c, rows.slice(0, limit).map(({ hunks_json, binary, ...row }) => ({ ...row, binary: Boolean(binary), hunks: JSON.parse(hunks_json) as unknown })),
      rows.length > limit ? encodeCursor({ patch_id: patch.id, offset: parsed.data.offset + limit }) : null);
  });
  route(app, 'GET', `${path}/:id/compare`, { summary: 'Compare native patch versions and review impact', tags: ['pulls'], capability: 'contents.read' }, async c => {
    const { item } = await getItem(c, 'pull_request');
    const pull = await pullDetails(c, item);
    const from = await readPatch(c, item, c.req.query('from_patch') ?? '');
    const to = await readPatch(c, item, c.req.query('to_patch') ?? pull.current_patch_id);
    const [oldFiles, newFiles] = await Promise.all([readPatchFiles(c, item, from.id), readPatchFiles(c, item, to.id)]);
    const old = new Map(oldFiles.map(file => [file.path, file.patch_fingerprint]));
    const next = new Map(newFiles.map(file => [file.path, file.patch_fingerprint]));
    const changed = [...new Set([...old.keys(), ...next.keys()])].sort().filter(path => old.get(path) !== next.get(path));
    const reviews = await many(database(c), `SELECT v.review_id,v.state,v.changed_paths_json FROM pull_review_validity v
      JOIN pull_reviews r ON r.repo_id=v.repo_id AND r.id=v.review_id WHERE v.repo_id=? AND r.pull_id=? AND v.patch_id=?`, item.repo_id, item.id, to.id);
    return c.json({ from, to, unchanged_patch: from.patch_fingerprint === to.patch_fingerprint, changed_paths: changed,
      reviews, diff_url: `/v1/repos/${item.repo_id}/pulls/${item.id}/diff?from_patch=${from.id}&to_patch=${to.id}` });
  });
  route(app, 'GET', `${path}/:id/diff`, { summary: 'Read an exact native Git diff between patch versions', tags: ['pulls'], capability: 'contents.read' }, async c => {
    const { item, repo } = await getItem(c, 'pull_request');
    const pull = await pullDetails(c, item);
    const to = await readPatch(c, item, c.req.query('to_patch') ?? pull.current_patch_id);
    const from = c.req.query('from_patch') ? await readPatch(c, item, c.req.query('from_patch')!) : null;
    const value = await nativeJSON(c, repo.id, 'collaboration/inspect', z.strictObject({ repo_id: identifier, base_oid: oid, head_oid: oid,
      complete: z.literal(true), diff: z.string() }), { actor: c.get('principal'), inspection: { kind: 'diff', pull_id: item.id,
      from_patch_id: from?.id ?? null, to_patch_id: to.id, base_oid: from?.head_oid ?? to.merge_base_oid,
      head_oid: to.head_oid, head_repo_id: to.head_repo_id } });
    if (value.repo_id !== repo.id || value.head_oid !== to.head_oid || value.base_oid !== (from?.head_oid ?? to.merge_base_oid)) {
      throw new ApiError(503, 'git_evidence_mismatch', 'The diff does not match the requested patch versions.');
    }
    c.header('cache-control', 'private, no-store');
    c.header('x-content-type-options', 'nosniff');
    return c.text(value.diff);
  });
}

function registerRestack(app: App, path: string): void {
  const schema = z.strictObject({ onto_pull_id: identifier.optional(), onto_oid: oid.optional(), include_dependents: z.boolean().default(true) })
    .refine(value => Boolean(value.onto_pull_id) !== Boolean(value.onto_oid), 'Supply one target pull request or exact base OID.');
  route(app, 'POST', `${path}/:id/restack`, { summary: 'Queue a native restack with explicit revision and review invalidation', tags: ['pulls'], capability: 'pull_requests.write', body: schema }, async c => {
    const { item, repo } = await getItem(c, 'pull_request', c.req.param('id'), 'pull_requests.write');
    checkRevision(c, item);
    mutablePull(item);
    const input = await jsonBody(c, schema);
    const pull = await pullDetails(c, item);
    await authorize(c, 'contents.push', { repo_id: pull.head_repo_id, ref: pull.head_ref,
      paths: (await readPatchFiles(c, item, pull.current_patch_id)).map(file => file.path) });
    const onto = input.onto_pull_id ? (await getItem(c, 'pull_request', input.onto_pull_id, 'contents.read', repo.id)).item : null;
    if (onto && !await one(database(c), 'SELECT 1 FROM pull_dependencies WHERE repo_id=? AND pull_id=? AND depends_on_id=?', repo.id, item.id, onto.id)) {
      conflict('restack_dependency_required', 'Declare the target pull request as a dependency before restacking.');
    }
    const ids = input.include_dependents ? await many<{ id: string }>(database(c), `WITH RECURSIVE dependents(id) AS (SELECT ? UNION
      SELECT d.pull_id FROM pull_dependencies d JOIN dependents p ON d.depends_on_id=p.id WHERE d.repo_id=?) SELECT id FROM dependents LIMIT 101`, item.id, repo.id) : [{ id: item.id }];
    if (ids.length > 100) throw new ApiError(422, 'stack_too_large', 'Restack at most 100 dependent pull requests per operation.');
    const snapshots = [];
    for (const { id } of ids) {
      const dependent = (await getItem(c, 'pull_request', id, 'pull_requests.write', repo.id)).item;
      mutablePull(dependent);
      const value = await pullDetails(c, dependent);
      await authorize(c, 'contents.push', { repo_id: value.head_repo_id, ref: value.head_ref,
        paths: (await readPatchFiles(c, dependent, value.current_patch_id)).map(file => file.path) });
      snapshots.push({ pull_id: id, revision: dependent.revision + Number(id === item.id), ...value });
    }
    const prepared = await prepareOperation(c, { repo, kind: 'restack', resource_id: item.id, item_id: item.id,
      expected_item_revision: item.revision + 1, input: { ...input, root_pull_id: item.id, snapshots } });
    await updateItem(c, repo, item, 'pull_request.restack_requested', {}, prepared.statements,
      { operation_id: prepared.operation.id, affected_pull_ids: ids.map(value => value.id) });
    c.header('location', `/v1/operations/${prepared.operation.id}`);
    return respond(c, publicOperation(prepared.operation), 202);
  });
}
