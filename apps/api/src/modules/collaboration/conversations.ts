import { z } from 'zod';
import {
  ApiError, database, jsonBody, listResponse, many, newId, now, one, requirePrincipal, route, sha256, stmt,
} from '@gitknot/core';
import type { App, AppContext } from '@gitknot/core';
import {
  canReadEventReferences, checkRevision, commentCapability, commit, completeInbox, conflict, documentStatement, ensureCanEditDocument, ensureCanModerate, eventFor,
  getItem, identifier, itemFence, itemTouch, manageCapability, markdown, mentionStatements,
  nextCursor, notFound, pageBindings, pagedResponse, pageSql, pagination, respond, unlocked,
  updateItem, writeCapability,
} from './common.ts';
import type { Comment, DocumentVersion, Item, ItemKind } from './common.ts';
import { registerAttachmentRoutes } from './attachments.ts';
import { queueAttachmentCleanup } from './attachment-storage.ts';
import { registerDraftRoutes } from './drafts.ts';

const passageAnchor = z.strictObject({ document_revision: z.number().int().positive(), start: z.number().int().nonnegative(),
  end: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const commentCreate = z.strictObject({ markdown: markdown.min(1), parent_id: identifier.optional(),
  review_thread_id: identifier.optional(), anchor: passageAnchor.optional() });
const commentPatch = z.strictObject({ markdown: markdown.min(1) });
const moderation = z.strictObject({ state: z.enum(['visible', 'hidden']), reason: z.string().trim().min(1).max(2000) });

async function readComment(c: AppContext, item: Item, id = c.req.param('id')): Promise<Comment> {
  const value = await one<Comment>(database(c), 'SELECT * FROM collaboration_comments WHERE repo_id=? AND item_id=? AND id=?', item.repo_id, item.id, id);
  if (!value || value.state === 'deleted') notFound();
  if (value.state === 'hidden' && requirePrincipal(c).id !== value.author_id) await ensureCanModerate(c, item);
  return value;
}

async function validateAnchor(c: AppContext, item: Item, anchor: z.infer<typeof passageAnchor> | undefined): Promise<void> {
  if (!anchor) return;
  const version = await one<DocumentVersion>(database(c), `SELECT * FROM collaboration_document_versions
    WHERE repo_id=? AND resource_kind=? AND resource_id=? AND document_revision=?`, item.repo_id, item.kind, item.id, anchor.document_revision);
  if (!version) notFound();
  if (anchor.end <= anchor.start || anchor.end > version.markdown.length
    || await sha256(version.markdown.slice(anchor.start, anchor.end)) !== anchor.sha256) {
    throw new ApiError(422, 'anchor_mismatch', 'The passage anchor does not match the canonical Markdown revision.');
  }
}

export function registerConversationRoutes(app: App): void {
  for (const [collection, kind] of [['issues', 'issue'], ['pulls', 'pull_request'], ['discussions', 'discussion'], ['tasks', 'task']] as const) {
    registerComments(app, collection, kind);
    registerDocuments(app, collection, kind);
    registerModeration(app, collection, kind);
    registerAttachmentRoutes(app, collection, kind);
  }
  registerDraftRoutes(app);
}

function registerComments(app: App, collection: string, kind: ItemKind): void {
  const path = `/v1/repos/:repoId/${collection}/:itemId/comments`;
  route(app, 'GET', path, { summary: 'List threaded comments', tags: [collection], capability: 'contents.read' }, async c => {
    const { item, repo } = await getItem(c, kind, c.req.param('itemId'));
    const parentId = c.req.query('parent_id');
    if (parentId) await readComment(c, item, parentId);
    const threadId = c.req.query('review_thread_id');
    if (threadId && !await one(database(c), 'SELECT 1 FROM pull_review_threads WHERE repo_id=? AND pull_id=? AND id=?', repo.id, item.id, threadId)) notFound();
    const p = pagination(c, `${repo.id}:${item.id}:comments:${parentId ?? ''}:${threadId ?? ''}`);
    const rows = await many<Comment>(database(c), `SELECT * FROM collaboration_comments WHERE repo_id=? AND item_id=?
      ${parentId ? 'AND parent_id=?' : ''} ${threadId ? 'AND review_thread_id=?' : ''} AND ${pageSql()}
      ORDER BY created_at DESC,id DESC LIMIT ?`, repo.id, item.id, ...(parentId ? [parentId] : []), ...(threadId ? [threadId] : []), ...pageBindings(p));
    const items = rows.slice(0, p.limit).map(value => ({ ...value,
      ...(value.state === 'visible' || c.get('principal')?.id === value.author_id ? {} : { markdown: null, moderation_reason: null }),
      anchor_outdated: value.anchor_document_revision !== null && value.anchor_document_revision !== item.document_revision,
    }));
    return listResponse(c, items, rows.length > p.limit ? nextCursor(p, rows[p.limit - 1]) : null);
  });
  route(app, 'GET', `${path}/:id`, { summary: 'Read comment', tags: [collection], capability: 'contents.read' }, async c => {
    const { item } = await getItem(c, kind, c.req.param('itemId'));
    return respond(c, await readComment(c, item));
  });
  route(app, 'POST', path, { summary: 'Add a revision-safe threaded comment', tags: [collection], capability: commentCapability[kind], body: commentCreate }, async c => {
    const { item, repo } = await getItem(c, kind, c.req.param('itemId'), commentCapability[kind]);
    checkRevision(c, item);
    unlocked(item);
    const input = await jsonBody(c, commentCreate);
    if (input.parent_id) {
      const parent = await readComment(c, item, input.parent_id);
      if (parent.state !== 'visible') conflict('parent_unavailable', 'Replies require a visible parent comment.');
      if (parent.review_thread_id !== (input.review_thread_id ?? null)) conflict('thread_mismatch', 'A reply must remain in its parent review thread.');
    }
    if (input.review_thread_id && (kind !== 'pull_request' || !await one(database(c),
      'SELECT 1 FROM pull_review_threads WHERE repo_id=? AND pull_id=? AND id=?', repo.id, item.id, input.review_thread_id))) notFound();
    await validateAnchor(c, item, input.anchor);
    const id = newId('comment');
    const at = now();
    const event = eventFor(c, `${kind}.comment_created`, id, 1, repo, { item_id: item.id, comment_id: id, kind });
    const value: Comment = { id, repo_id: repo.id, item_id: item.id, parent_id: input.parent_id ?? null,
      review_thread_id: input.review_thread_id ?? null, author_id: requirePrincipal(c).id, markdown: input.markdown,
      state: 'visible', anchor_document_revision: input.anchor?.document_revision ?? null,
      anchor_start: input.anchor?.start ?? null, anchor_end: input.anchor?.end ?? null, anchor_sha256: input.anchor?.sha256 ?? null,
      moderation_reason: null, revision: 1, document_revision: 1, created_at: at, updated_at: at };
    await commit(c, { repo, item, resource_id: id, revision: 1, type: event.type, event,
      sql: 'UPDATE collaboration_items SET revision=revision+1,updated_at=? WHERE repo_id=? AND id=? AND revision=? AND locked_at IS NULL AND deleted_at IS NULL',
      bindings: [at, repo.id, item.id, item.revision], after: [
        stmt(database(c), `INSERT INTO collaboration_comments(id,repo_id,item_id,parent_id,review_thread_id,author_id,markdown,
          anchor_document_revision,anchor_start,anchor_end,anchor_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, repo.id, item.id, value.parent_id, value.review_thread_id, value.author_id, value.markdown,
        value.anchor_document_revision, value.anchor_start, value.anchor_end, value.anchor_sha256, at, at),
        await documentStatement(database(c), { ...value, resource_kind: 'comment', resource_id: id, actor_id: value.author_id }),
        ...await mentionStatements(c, item, id, 1, value.markdown, event.id),
      ] });
    return respond(c, { ...value, item_revision: item.revision + 1 }, 201);
  });
  route(app, 'PATCH', `${path}/:id`, { summary: 'Edit canonical comment Markdown', tags: [collection], capability: commentCapability[kind], body: commentPatch }, async c => {
    const { item, repo } = await getItem(c, kind, c.req.param('itemId'), commentCapability[kind]);
    unlocked(item);
    const comment = await readComment(c, item);
    checkRevision(c, comment);
    if (comment.author_id !== requirePrincipal(c).id) await ensureCanModerate(c, item);
    if (comment.state !== 'visible') conflict('comment_moderated', 'Restore this comment before editing it.');
    const input = await jsonBody(c, commentPatch);
    const updated = { ...comment, markdown: input.markdown, revision: comment.revision + 1, document_revision: comment.document_revision + 1, updated_at: now() };
    const event = eventFor(c, `${kind}.comment_updated`, comment.id, updated.revision, repo, { item_id: item.id, comment_id: comment.id, kind });
    await commit(c, { repo, item, resource_id: comment.id, revision: updated.revision, type: event.type, event,
      sql: `UPDATE collaboration_comments SET markdown=?,revision=revision+1,document_revision=document_revision+1,updated_at=?
        WHERE repo_id=? AND item_id=? AND id=? AND revision=? AND state='visible'`,
      bindings: [input.markdown, updated.updated_at, repo.id, item.id, comment.id, comment.revision], after: [
        ...itemFence(database(c), item), itemTouch(database(c), item),
        await documentStatement(database(c), { ...updated, resource_kind: 'comment', resource_id: comment.id, actor_id: requirePrincipal(c).id }),
        ...await mentionStatements(c, item, comment.id, updated.document_revision, updated.markdown, event.id),
      ] });
    return respond(c, { ...updated, item_revision: item.revision + 1 });
  });
  route(app, 'DELETE', `${path}/:id`, { summary: 'Delete comment while retaining its immutable history', tags: [collection], capability: commentCapability[kind] }, async c => {
    const { item, repo } = await getItem(c, kind, c.req.param('itemId'), commentCapability[kind]);
    const comment = await readComment(c, item);
    checkRevision(c, comment);
    if (comment.author_id !== requirePrincipal(c).id) await ensureCanModerate(c, item);
    const after = [...itemFence(database(c), item), itemTouch(database(c), item), completeInbox(database(c), item, 'mention', comment.id)];
    after.push(...clearAcceptedAnswer(c, item, comment.id));
    await commit(c, { repo, item, resource_id: comment.id, revision: comment.revision + 1, type: `${kind}.comment_deleted`,
      sql: "UPDATE collaboration_comments SET state='deleted',revision=revision+1,updated_at=? WHERE repo_id=? AND item_id=? AND id=? AND revision=?",
      bindings: [now(), repo.id, item.id, comment.id, comment.revision], after, data: { item_id: item.id, comment_id: comment.id } });
    return respond(c, { id: comment.id, revision: comment.revision + 1, state: 'deleted' });
  });
  route(app, 'PUT', `${path}/:id/moderation`, { summary: 'Hide or restore a comment with an audited reason', tags: [collection], capability: manageCapability[kind], body: moderation }, async c => {
    const { item, repo } = await getItem(c, kind, c.req.param('itemId'), manageCapability[kind]);
    const comment = await readComment(c, item);
    checkRevision(c, comment);
    const input = await jsonBody(c, moderation);
    await commit(c, { repo, item, resource_id: comment.id, revision: comment.revision + 1, type: `${kind}.comment_moderated`,
      sql: 'UPDATE collaboration_comments SET state=?,moderation_reason=?,revision=revision+1,updated_at=? WHERE repo_id=? AND item_id=? AND id=? AND revision=?',
      bindings: [input.state, input.reason, now(), repo.id, item.id, comment.id, comment.revision],
      after: [...itemFence(database(c), item), itemTouch(database(c), item), ...(input.state === 'hidden' ? clearAcceptedAnswer(c, item, comment.id) : [])],
      data: { item_id: item.id, state: input.state, reason: input.reason } });
    return respond(c, { ...comment, ...input, moderation_reason: input.reason, revision: comment.revision + 1 });
  });
  route(app, 'GET', `${path}/:id/versions`, { summary: 'Read canonical comment versions', tags: ['markdown'], capability: 'contents.read' }, async c => {
    const { item } = await getItem(c, kind, c.req.param('itemId'));
    const comment = await readComment(c, item);
    return versionList(c, item, 'comment', comment.id);
  });
}

function clearAcceptedAnswer(c: AppContext, item: Item, commentId: string): D1PreparedStatement[] {
  if (item.kind !== 'discussion') return [];
  return [
    stmt(database(c), `UPDATE collaboration_items SET state='open' WHERE repo_id=? AND id=? AND state='answered'
      AND EXISTS(SELECT 1 FROM discussions WHERE repo_id=? AND id=? AND accepted_comment_id=?)`, item.repo_id, item.id, item.repo_id, item.id, commentId),
    stmt(database(c), 'UPDATE discussions SET accepted_comment_id=NULL,accepted_by=NULL,accepted_at=NULL WHERE repo_id=? AND id=? AND accepted_comment_id=?', item.repo_id, item.id, commentId),
  ];
}

async function versionList(c: AppContext, item: Item, resourceKind: string, resourceId: string): Promise<Response> {
  const p = pagination(c, `${item.repo_id}:${resourceKind}:${resourceId}:versions`);
  const rows = await many<DocumentVersion>(database(c), `SELECT * FROM collaboration_document_versions WHERE repo_id=? AND resource_kind=? AND resource_id=?
    AND ${pageSql()} ORDER BY created_at DESC,id DESC LIMIT ?`, item.repo_id, resourceKind, resourceId, ...pageBindings(p));
  return pagedResponse(c, rows, p);
}

function registerDocuments(app: App, collection: string, kind: ItemKind): void {
  const path = `/v1/repos/:repoId/${collection}/:id`;
  route(app, 'GET', `${path}/versions`, { summary: 'Read immutable canonical Markdown revisions', tags: ['markdown'], capability: 'contents.read' }, async c => {
    const { item } = await getItem(c, kind);
    return versionList(c, item, kind, item.id);
  });
  const restore = z.strictObject({ document_revision: z.number().int().positive() });
  route(app, 'POST', `${path}/restore`, { summary: 'Restore Markdown as a new revision', tags: ['markdown'], capability: writeCapability[kind], body: restore }, async c => {
    const { item, repo } = await getItem(c, kind, c.req.param('id'), writeCapability[kind]);
    unlocked(item);
    checkRevision(c, item);
    await ensureCanEditDocument(c, item);
    const input = await jsonBody(c, restore);
    const version = await one<DocumentVersion>(database(c), `SELECT * FROM collaboration_document_versions
      WHERE repo_id=? AND resource_kind=? AND resource_id=? AND document_revision=?`, repo.id, kind, item.id, input.document_revision);
    if (!version) notFound();
    return respond(c, await updateItem(c, repo, item, `${kind}.document_restored`, { title: version.title ?? item.title, markdown: version.markdown }, [],
      { restored_from: version.document_revision }, version.document_revision));
  });
  route(app, 'GET', `${path}/history`, { summary: 'Read immutable collaboration event history', tags: [collection], capability: 'contents.read' }, async c => {
    const { item, repo } = await getItem(c, kind);
    const p = pagination(c, `${repo.id}:${item.id}:history`);
    const rows = await many<{ id: string; created_at: string; data_json: string }>(database(c), `SELECT * FROM collaboration_history
      WHERE repo_id=? AND item_id=? AND ${pageSql()} ORDER BY created_at DESC,id DESC LIMIT ?`, repo.id, item.id, ...pageBindings(p));
    const visible = [];
    for (const { data_json, ...row } of rows.slice(0, p.limit)) {
      const data = JSON.parse(data_json) as Record<string, unknown>;
      if (await canReadEventReferences(c, repo.id, data)) visible.push({ ...row, data });
    }
    return listResponse(c, visible, rows.length > p.limit ? nextCursor(p, rows[p.limit - 1]) : null);
  });
}

function registerModeration(app: App, collection: string, kind: ItemKind): void {
  const path = `/v1/repos/:repoId/${collection}/:id`;
  const lock = z.strictObject({ locked: z.boolean(), reason: z.string().trim().min(1).max(2000) });
  route(app, 'PUT', `${path}/lock`, { summary: 'Lock or unlock a conversation', tags: [collection], capability: manageCapability[kind], body: lock }, async c => {
    const { item, repo } = await getItem(c, kind, c.req.param('id'), manageCapability[kind]);
    const input = await jsonBody(c, lock);
    return respond(c, await updateItem(c, repo, item, `${kind}.lock_changed`, {
      locked_at: input.locked ? now() : null, locked_by: input.locked ? requirePrincipal(c).id : null,
    }, [], { locked: input.locked, reason: input.reason }));
  });
  route(app, 'DELETE', path, { summary: 'Soft-delete collaboration content', tags: [collection], capability: manageCapability[kind] }, async c => {
    const { item, repo } = await getItem(c, kind, c.req.param('id'), manageCapability[kind]);
    if (kind === 'pull_request' && await one(database(c), "SELECT 1 FROM pull_merge_queue WHERE repo_id=? AND pull_id=? AND state='publishing'", repo.id, item.id)) {
      conflict('publication_in_progress', 'Resolve the in-flight Git publication before deleting this pull request.');
    }
    const after = [completeInbox(database(c), item), queueAttachmentCleanup(c, item, requirePrincipal(c).id)];
    if (kind === 'pull_request') after.push(stmt(database(c), `UPDATE pull_merge_queue SET state='cancelled',revision=revision+1,updated_at=?
      WHERE repo_id=? AND pull_id=? AND state IN ('queued','preparing','verifying','ready','blocked')`, now(), repo.id, item.id));
    const deleted = await updateItem(c, repo, item, `${kind}.deleted`, { deleted_at: now() }, after);
    return respond(c, { id: item.id, repo_id: repo.id, revision: deleted.revision, deleted_at: deleted.deleted_at });
  });
}
