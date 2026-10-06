import { z } from 'zod';
import {
  auditStatement, authorize, database, eventStatement, getRepository, jsonBody, mutationGuard,
  newId, now, one, requirePrincipal, route, stmt,
} from '@gitknot/core';
import type { App, AppContext } from '@gitknot/core';
import {
  checkRevision, commit, conflict, createItem, documentStatement, eventFor, getItem, identifier,
  itemFence, itemInsert, listItems, markdown, mentionStatements, newItem, notFound,
  related, respond, title, unlocked, updateItem,
} from './common.ts';
import type { Comment, Item } from './common.ts';
import { registerDiscussionCategories } from './catalogs.ts';

interface Category { id: string; name: string; format: 'discussion' | 'question' | 'announcement' }
interface Discussion { id: string; repo_id: string; category_id: string; accepted_comment_id: string | null;
  accepted_by: string | null; accepted_at: string | null; converted_issue_id: string | null; pinned: number }
const create = z.strictObject({ title, markdown: markdown.default(''), category_id: identifier });
const patch = z.strictObject({ title: title.optional(), markdown: markdown.optional(), category_id: identifier.optional(),
  state: z.enum(['open', 'closed']).optional() }).refine(value => Object.keys(value).length > 0, 'Supply at least one field.');

async function details(c: AppContext, item: Item): Promise<Discussion> {
  const discussion = await one<Discussion>(database(c), 'SELECT * FROM discussions WHERE repo_id=? AND id=?', item.repo_id, item.id);
  if (!discussion) notFound();
  return discussion;
}
async function readDiscussion(c: AppContext, id = c.req.param('id')): Promise<Record<string, unknown> & { revision: number }> {
  const { item, repo } = await getItem(c, 'discussion', id);
  const discussion = await details(c, item);
  const category = await related<Category>(c, 'discussion_categories', repo.id, discussion.category_id);
  const answer = discussion.accepted_comment_id ? await one<Comment>(database(c),
    "SELECT * FROM collaboration_comments WHERE repo_id=? AND item_id=? AND id=? AND state='visible'", repo.id, item.id, discussion.accepted_comment_id) : null;
  if (discussion.converted_issue_id) await getItem(c, 'issue', discussion.converted_issue_id, 'contents.read', repo.id);
  return { ...item, ...discussion, pinned: Boolean(discussion.pinned), category, accepted_answer: answer };
}

async function authorOrModerator(c: AppContext, item: Item): Promise<void> {
  if (item.author_id !== requirePrincipal(c).id) await authorize(c, 'discussions.moderate', { repo_id: item.repo_id });
}

export function registerDiscussionRoutes(app: App): void {
  registerDiscussionCategories(app);
  const path = '/v1/repos/:repoId/discussions';
  route(app, 'GET', path, { summary: 'List discussions', tags: ['discussions'], capability: 'contents.read' }, c => listItems(c, 'discussion'));
  route(app, 'GET', `${path}/:id`, { summary: 'Read a discussion and accepted answer', tags: ['discussions'], capability: 'contents.read' }, async c => respond(c, await readDiscussion(c)));
  route(app, 'POST', path, { summary: 'Start a discussion', tags: ['discussions'], capability: 'discussions.write', body: create }, async c => {
    const repo = await getRepository(c, c.req.param('repoId') ?? '', 'discussions.write');
    const input = await jsonBody(c, create);
    const category = await related<Category>(c, 'discussion_categories', repo.id, input.category_id);
    if (category?.format === 'announcement') await authorize(c, 'discussions.moderate', { repo_id: repo.id });
    const item = newItem(c, repo.id, 'discussion', { ...input, state: 'open' });
    await createItem(c, repo, item, [stmt(database(c), 'INSERT INTO discussions(id,repo_id,category_id) VALUES (?,?,?)', item.id, repo.id, input.category_id)]);
    return respond(c, await readDiscussion(c, item.id), 201);
  });
  route(app, 'PATCH', `${path}/:id`, { summary: 'Edit or recategorize a discussion', tags: ['discussions'], capability: 'discussions.write', body: patch }, async c => {
    const { item, repo } = await getItem(c, 'discussion', c.req.param('id'), 'discussions.write');
    checkRevision(c, item);
    await authorOrModerator(c, item);
    const input = await jsonBody(c, patch);
    const discussion = await details(c, item);
    const after: D1PreparedStatement[] = [];
    if (input.category_id) {
      const category = await related<Category>(c, 'discussion_categories', repo.id, input.category_id);
      await authorize(c, 'discussions.moderate', { repo_id: repo.id });
      if (discussion.accepted_comment_id && category?.format !== 'question') conflict('answer_requires_question', 'Clear the accepted answer before moving this discussion out of a question category.');
      after.push(stmt(database(c), 'UPDATE discussions SET category_id=? WHERE repo_id=? AND id=?', input.category_id, repo.id, item.id));
    }
    const fields: Record<string, string> = {};
    for (const key of ['title', 'markdown', 'state'] as const) if (input[key] !== undefined) fields[key] = input[key]!;
    if (input.state === 'open' && discussion.accepted_comment_id) fields.state = 'answered';
    await updateItem(c, repo, item, 'discussion.updated', fields, after, { changed_fields: Object.keys(input) });
    return respond(c, await readDiscussion(c));
  });
  const answer = z.strictObject({ comment_id: identifier.nullable() });
  route(app, 'PUT', `${path}/:id/answer`, { summary: 'Accept or clear a question answer', tags: ['discussions'], capability: 'discussions.write', body: answer }, async c => {
    const { item, repo } = await getItem(c, 'discussion', c.req.param('id'), 'discussions.write');
    checkRevision(c, item);
    await authorOrModerator(c, item);
    unlocked(item);
    const discussion = await details(c, item);
    const category = await related<Category>(c, 'discussion_categories', repo.id, discussion.category_id);
    if (category?.format !== 'question') conflict('not_a_question', 'Only question discussions can accept an answer.');
    const { comment_id } = await jsonBody(c, answer);
    const after: D1PreparedStatement[] = [];
    if (comment_id) {
      const comment = await one<Comment>(database(c), "SELECT * FROM collaboration_comments WHERE repo_id=? AND item_id=? AND id=? AND state='visible'", repo.id, item.id, comment_id);
      if (!comment) notFound();
      const guard = newId('guard');
      after.push(stmt(database(c), `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN EXISTS (
        SELECT 1 FROM collaboration_comments WHERE repo_id=? AND item_id=? AND id=? AND revision=? AND state='visible') THEN 1 ELSE 0 END`,
      guard, repo.id, item.id, comment.id, comment.revision), stmt(database(c), 'DELETE FROM mutation_guards WHERE id=?', guard));
    }
    after.push(stmt(database(c), 'UPDATE discussions SET accepted_comment_id=?,accepted_by=?,accepted_at=? WHERE repo_id=? AND id=?',
      comment_id, comment_id ? requirePrincipal(c).id : null, comment_id ? now() : null, repo.id, item.id));
    await updateItem(c, repo, item, 'discussion.answer_changed', { state: comment_id ? 'answered' : 'open' }, after, { comment_id });
    return respond(c, await readDiscussion(c));
  });
  const pin = z.strictObject({ pinned: z.boolean() });
  route(app, 'PUT', `${path}/:id/pin`, { summary: 'Pin or unpin a discussion', tags: ['discussions'], capability: 'discussions.moderate', body: pin }, async c => {
    const { item, repo } = await getItem(c, 'discussion', c.req.param('id'), 'discussions.moderate');
    const input = await jsonBody(c, pin);
    await updateItem(c, repo, item, 'discussion.pin_changed', {}, [stmt(database(c), 'UPDATE discussions SET pinned=? WHERE repo_id=? AND id=?', Number(input.pinned), repo.id, item.id)], input);
    return respond(c, await readDiscussion(c));
  });
  registerConversion(app, path);
}

function registerConversion(app: App, path: string): void {
  const convert = z.strictObject({ title: title.optional() });
  route(app, 'POST', `${path}/:id/convert`, { summary: 'Convert discussion to an issue without losing the conversation', tags: ['discussions'], capability: 'discussions.write', body: convert }, async c => {
    const { item, repo } = await getItem(c, 'discussion', c.req.param('id'), 'discussions.write');
    checkRevision(c, item);
    await authorOrModerator(c, item);
    await authorize(c, 'issues.write', { repo_id: repo.id });
    const discussion = await details(c, item);
    if (discussion.converted_issue_id) conflict('already_converted', 'This discussion is already linked to an issue.', { issue_id: discussion.converted_issue_id });
    const input = await jsonBody(c, convert);
    const issue = newItem(c, repo.id, 'issue', { title: input.title ?? item.title, state: 'open',
      markdown: `${item.markdown}\n\n---\n\nContinued from [discussion #${item.number}](/repos/${repo.id}/discussions/${item.id}). The original thread and accepted answer remain available there.\n` });
    const issueEvent = eventFor(c, 'issue.created', issue.id, 1, repo, { item_id: issue.id, kind: 'issue', discussion_id: item.id });
    const insertion = itemInsert(issue);
    const guard = newId('guard');
    await commit(c, { repo, item, resource_id: item.id, revision: item.revision + 1, type: 'discussion.converted',
      sql: 'UPDATE collaboration_items SET revision=revision+1,updated_at=? WHERE repo_id=? AND id=? AND revision=? AND deleted_at IS NULL',
      bindings: [now(), repo.id, item.id, item.revision], after: [
        stmt(database(c), insertion.sql, ...insertion.bindings),
        stmt(database(c), 'INSERT INTO issues(id,repo_id,priority) VALUES (?,?,?)', issue.id, repo.id, 'normal'),
        stmt(database(c), 'UPDATE discussions SET converted_issue_id=? WHERE repo_id=? AND id=? AND converted_issue_id IS NULL', issue.id, repo.id, item.id),
        mutationGuard(database(c), guard), stmt(database(c), 'DELETE FROM mutation_guards WHERE id=?', guard),
        await documentStatement(database(c), { ...issue, resource_kind: 'issue', resource_id: issue.id, actor_id: issue.author_id }),
        ...await mentionStatements(c, issue, issue.id, 1, issue.markdown, issueEvent.id),
        eventStatement(database(c), issueEvent), auditStatement(database(c), { action: issueEvent.type, repo_id: repo.id, account_id: repo.owner_id,
          resource_id: issue.id, resource_revision: 1, actor_id: requirePrincipal(c).id, request_id: c.get('requestId'), details: issueEvent.data }),
        stmt(database(c), `INSERT INTO collaboration_history(id,repo_id,item_id,resource_id,resource_revision,event_type,actor_id,data_json,created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`, issueEvent.id, repo.id, issue.id, issue.id, 1, issueEvent.type, issue.author_id, JSON.stringify(issueEvent.data), issue.created_at),
      ], data: { item_id: item.id, issue_id: issue.id } });
    const created = (await getItem(c, 'issue', issue.id, 'contents.read', repo.id)).item;
    return respond(c, { ...created, discussion_id: item.id, discussion_revision: item.revision + 1 }, 201);
  });
  const link = z.strictObject({ issue_id: identifier.nullable() });
  route(app, 'PUT', `${path}/:id/issue`, { summary: 'Link a discussion to an existing issue', tags: ['discussions'], capability: 'discussions.write', body: link }, async c => {
    const { item, repo } = await getItem(c, 'discussion', c.req.param('id'), 'discussions.write');
    await authorOrModerator(c, item);
    const { issue_id } = await jsonBody(c, link);
    const target = issue_id ? (await getItem(c, 'issue', issue_id, 'contents.read', repo.id)).item : null;
    await updateItem(c, repo, item, 'discussion.issue_linked', {}, [
      ...(target ? itemFence(database(c), target) : []),
      stmt(database(c), 'UPDATE discussions SET converted_issue_id=? WHERE repo_id=? AND id=?', issue_id, repo.id, item.id),
    ], { issue_id });
    return respond(c, await readDiscussion(c));
  });
}
