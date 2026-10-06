import { z } from 'zod';
import { authorize, database, getRepository, identityDatabase, jsonBody, many, newId, now, one, requirePrincipal, route, stmt } from '@gitknot/core';
import type { App, AppContext } from '@gitknot/core';
import {
  assertUser, checkRevision, commit, completeInbox, conflict, createItem, ensureCanEditDocument, eventFor, getItem,
  identifier, inboxStatement, itemFence, itemTouch, listItems, markdown, newItem, notFound,
  pageBindings, pagedResponse, pageSql, pagination, related, respond, title, uniqueIds, updateItem,
} from './common.ts';
import type { Item } from './common.ts';
import { registerIssueCatalogs } from './catalogs.ts';
import { registerDependencies } from './dependencies.ts';

const priority = z.enum(['none', 'low', 'normal', 'high', 'urgent']);
const issueCreate = z.strictObject({
  title: title.optional(), markdown: markdown.optional(), template_id: identifier.optional(),
  status_id: identifier.nullable().optional(), milestone_id: identifier.nullable().optional(),
  priority: priority.default('normal'), due_at: z.iso.datetime().nullable().default(null),
  label_ids: uniqueIds.optional(), assignee_ids: uniqueIds.max(50).optional(),
}).refine(value => !!value.title || !!value.template_id, 'Supply a title or an issue template.');
const issuePatch = z.strictObject({
  title: title.optional(), markdown: markdown.optional(), state: z.enum(['open', 'closed']).optional(),
  status_id: identifier.nullable().optional(), milestone_id: identifier.nullable().optional(),
  priority: priority.optional(), due_at: z.iso.datetime().nullable().optional(),
}).refine(value => Object.keys(value).length > 0, 'Supply at least one field.');

export interface IssueDetails {
  id: string; repo_id: string; status_id: string | null; milestone_id: string | null;
  template_id: string | null; duplicate_of_id: string | null; priority: string; due_at: string | null;
}
interface Status { id: string; type: string; name: string }
interface Template { id: string; title: string; markdown: string; status_id: string | null; enabled: number }

async function issueAssignees(c: AppContext, item: Item): Promise<Record<string, unknown>[]> {
  const links = await many<{ user_id: string; assigned_at: string }>(database(c), 'SELECT user_id,assigned_at FROM issue_assignees WHERE repo_id=? AND issue_id=? ORDER BY user_id LIMIT 100', item.repo_id, item.id);
  const users = await many<{ id: string; username: string; display_name: string; avatar_url: string | null }>(identityDatabase(c),
    'SELECT id,username,display_name,avatar_url FROM users WHERE id IN (SELECT value FROM json_each(?)) AND disabled_at IS NULL ORDER BY username', JSON.stringify(links.map(row => row.user_id)));
  const assignments = new Map(links.map(row => [row.user_id, row.assigned_at]));
  return users.map(user => ({ ...user, assigned_at: assignments.get(user.id)! }));
}

export async function readIssue(c: AppContext, id = c.req.param('id')): Promise<Item & IssueDetails & Record<string, unknown>> {
  const { item, repo } = await getItem(c, 'issue', id);
  const details = await one<IssueDetails>(database(c), 'SELECT * FROM issues WHERE repo_id=? AND id=?', repo.id, item.id);
  if (!details) notFound();
  const [labels, assignees, status, milestone] = await Promise.all([
    many(database(c), `SELECT l.* FROM labels l JOIN collaboration_item_labels il ON il.label_id=l.id AND il.repo_id=l.repo_id
      WHERE il.repo_id=? AND il.item_id=? AND l.deleted_at IS NULL ORDER BY l.name LIMIT 100`, repo.id, item.id),
    issueAssignees(c, item),
    related(c, 'issue_statuses', repo.id, details.status_id), related(c, 'milestones', repo.id, details.milestone_id),
  ]);
  if (details.duplicate_of_id) await getItem(c, 'issue', details.duplicate_of_id, 'contents.read', repo.id);
  return { ...item, ...details, labels, assignees, status, milestone };
}

export async function labelStatements(c: AppContext, item: Item, ids: string[]): Promise<D1PreparedStatement[]> {
  for (const id of ids) await related(c, 'labels', item.repo_id, id);
  return [stmt(database(c), 'DELETE FROM collaboration_item_labels WHERE repo_id=? AND item_id=?', item.repo_id, item.id),
    ...ids.map(id => stmt(database(c), 'INSERT INTO collaboration_item_labels(repo_id,item_id,label_id) VALUES (?,?,?)', item.repo_id, item.id, id))];
}

async function assignmentStatements(c: AppContext, item: Item, ids: string[], eventId: string): Promise<D1PreparedStatement[]> {
  for (const id of ids) await assertUser(c, id);
  const db = database(c);
  const existing = await many<{ user_id: string }>(db, 'SELECT user_id FROM issue_assignees WHERE repo_id=? AND issue_id=?', item.repo_id, item.id);
  const old = new Set(existing.map(value => value.user_id));
  const after = existing.filter(value => !ids.includes(value.user_id)).flatMap(value => [
    stmt(db, 'DELETE FROM issue_assignees WHERE repo_id=? AND issue_id=? AND user_id=?', item.repo_id, item.id, value.user_id),
    completeInbox(db, item, 'assignment', item.id, value.user_id),
  ]);
  for (const id of ids.filter(id => !old.has(id))) {
    after.push(stmt(db, 'INSERT INTO issue_assignees(repo_id,issue_id,user_id,assigned_by,assigned_at) VALUES (?,?,?,?,?)', item.repo_id, item.id, id, requirePrincipal(c).id, now()));
    after.push(inboxStatement(db, { user_id: id, item, reason: 'assignment', source_id: item.id, event_id: eventId }));
  }
  return after;
}

export function registerIssueRoutes(app: App): void {
  registerIssueCatalogs(app);
  registerDependencies(app, 'issue');
  const base = '/v1/repos/:repoId/issues';
  route(app, 'GET', base, { summary: 'List and filter issues', tags: ['issues'], capability: 'contents.read' }, c => listItems(c, 'issue'));
  route(app, 'GET', `${base}/:id`, { summary: 'Read issue', tags: ['issues'], capability: 'contents.read' }, async c => respond(c, await readIssue(c)));
  route(app, 'POST', base, { summary: 'Create issue from canonical Markdown or a template', tags: ['issues'], capability: 'issues.write', body: issueCreate }, async c => {
    const repo = await getRepository(c, c.req.param('repoId') ?? '', 'issues.write');
    const input = await jsonBody(c, issueCreate);
    if (['status_id', 'milestone_id', 'label_ids', 'assignee_ids'].some(key => Object.hasOwn(input, key))) await authorize(c, 'issues.triage', { repo_id: repo.id });
    const template = await related<Template>(c, 'issue_templates', repo.id, input.template_id);
    if (template && !template.enabled) conflict('template_disabled', 'This template is disabled.');
    const issueTitle = input.title ?? template?.title;
    if (!issueTitle?.trim()) conflict('title_required', 'This template requires a title.');
    const statusId = input.status_id === undefined ? template?.status_id ?? null : input.status_id;
    const status = await related<Status>(c, 'issue_statuses', repo.id, statusId);
    await related(c, 'milestones', repo.id, input.milestone_id);
    const item = newItem(c, repo.id, 'issue', { title: issueTitle, markdown: input.markdown ?? template?.markdown ?? '',
      state: status && ['done', 'cancelled'].includes(status.type) ? 'closed' : 'open' });
    const labels = input.label_ids ?? (template ? (await many<{ label_id: string }>(database(c),
      'SELECT label_id FROM issue_template_labels WHERE repo_id=? AND template_id=?', repo.id, template.id)).map(value => value.label_id) : []);
    const event = eventFor(c, 'issue.created', item.id, 1, repo, { item_id: item.id, kind: 'issue' });
    const after = [stmt(database(c), `INSERT INTO issues(id,repo_id,status_id,milestone_id,template_id,priority,due_at) VALUES (?,?,?,?,?,?,?)`,
      item.id, repo.id, statusId, input.milestone_id ?? null, template?.id ?? null, input.priority, input.due_at),
    ...await labelStatements(c, item, labels), ...await assignmentStatements(c, item, input.assignee_ids ?? [], event.id)];
    await createItem(c, repo, item, after, {}, event);
    return respond(c, await readIssue(c, item.id), 201);
  });
  route(app, 'PATCH', `${base}/:id`, { summary: 'Edit or transition issue', tags: ['issues'], capability: 'issues.write', body: issuePatch }, async c => {
    const { item, repo } = await getItem(c, 'issue', c.req.param('id'), 'issues.write');
    checkRevision(c, item);
    const input = await jsonBody(c, issuePatch);
    if (input.title !== undefined || input.markdown !== undefined) await ensureCanEditDocument(c, item);
    const details = await one<IssueDetails>(database(c), 'SELECT * FROM issues WHERE repo_id=? AND id=?', repo.id, item.id);
    if (!details) notFound();
    const triageKeys = ['state', 'status_id', 'milestone_id', 'priority', 'due_at'];
    if (triageKeys.some(key => Object.hasOwn(input, key))) await authorize(c, 'issues.triage', { repo_id: repo.id });
    const state: Record<string, string | null> = {};
    for (const key of ['title', 'markdown', 'state'] as const) if (input[key] !== undefined) state[key] = input[key]!;
    if (input.status_id !== undefined) {
      const status = await related<Status>(c, 'issue_statuses', repo.id, input.status_id);
      if (status) {
        const statusState = ['done', 'cancelled'].includes(status.type) ? 'closed' : 'open';
        if (input.state && input.state !== statusState) conflict('status_state_conflict', 'The issue state must agree with the typed status.');
        state.state = statusState;
      }
    }
    if (details.duplicate_of_id && state.state === 'open') conflict('duplicate_issue', 'Remove the duplicate relationship before reopening this issue.');
    await related(c, 'milestones', repo.id, input.milestone_id);
    const nextDetails: Record<string, unknown> = {};
    for (const key of ['status_id', 'milestone_id', 'priority', 'due_at'] as const) if (input[key] !== undefined) nextDetails[key] = input[key];
    if (input.state && input.status_id === undefined && details.status_id) nextDetails.status_id = null;
    const keys = Object.keys(nextDetails);
    const after: D1PreparedStatement[] = keys.length ? [stmt(database(c), `UPDATE issues SET ${keys.map(key => `${key}=?`).join(',')} WHERE repo_id=? AND id=?`,
      ...keys.map(key => nextDetails[key]), repo.id, item.id)] : [];
    if (state.state === 'closed') after.push(completeInbox(database(c), item, 'assignment'));
    if (state.state === 'open' && item.state === 'closed') {
      const assignments = await many<{ user_id: string }>(database(c), 'SELECT user_id FROM issue_assignees WHERE repo_id=? AND issue_id=?', repo.id, item.id);
      const event = eventFor(c, 'issue.updated', item.id, item.revision + 1, repo, { item_id: item.id, changed_fields: Object.keys(input) });
      after.push(...assignments.map(value => inboxStatement(database(c), { user_id: value.user_id, item, reason: 'assignment', source_id: item.id, event_id: event.id })));
      await updateItem(c, repo, item, event.type, state, after, {}, undefined, event);
    } else await updateItem(c, repo, item, 'issue.updated', state, after, { changed_fields: Object.keys(input) });
    return respond(c, await readIssue(c));
  });
  const assignment = z.strictObject({ user_ids: uniqueIds.max(50) });
  route(app, 'PUT', `${base}/:id/assignees`, { summary: 'Replace issue assignments', tags: ['issues'], capability: 'issues.triage', body: assignment }, async c => {
    const { item, repo } = await getItem(c, 'issue', c.req.param('id'), 'issues.triage');
    checkRevision(c, item);
    const { user_ids } = await jsonBody(c, assignment);
    const event = eventFor(c, 'issue.assignments_changed', item.id, item.revision + 1, repo, { item_id: item.id, user_ids });
    await updateItem(c, repo, item, event.type, {}, await assignmentStatements(c, item, user_ids, event.id), {}, undefined, event);
    return respond(c, await readIssue(c));
  });
  const labels = z.strictObject({ label_ids: uniqueIds });
  route(app, 'PUT', `${base}/:id/labels`, { summary: 'Replace issue labels', tags: ['issues'], capability: 'issues.triage', body: labels }, async c => {
    const { item, repo } = await getItem(c, 'issue', c.req.param('id'), 'issues.triage');
    const { label_ids } = await jsonBody(c, labels);
    await updateItem(c, repo, item, 'issue.labels_changed', {}, await labelStatements(c, item, label_ids), { label_ids });
    return respond(c, await readIssue(c));
  });
  registerDuplicates(app, base);
  registerIssuePullLinks(app, base);
}

function registerDuplicates(app: App, base: string): void {
  const schema = z.strictObject({ duplicate_of_id: identifier.nullable() });
  route(app, 'PUT', `${base}/:id/duplicate`, { summary: 'Mark or unmark a duplicate while preserving history', tags: ['issues'], capability: 'issues.triage', body: schema }, async c => {
    const { item, repo } = await getItem(c, 'issue', c.req.param('id'), 'issues.triage');
    checkRevision(c, item);
    const { duplicate_of_id } = await jsonBody(c, schema);
    const after: D1PreparedStatement[] = [];
    if (duplicate_of_id) {
      const target = (await getItem(c, 'issue', duplicate_of_id, 'contents.read', repo.id)).item;
      if (target.id === item.id) conflict('duplicate_cycle', 'An issue cannot duplicate itself.');
      const cycleSql = `WITH RECURSIVE chain(id) AS (SELECT ? UNION SELECT i.duplicate_of_id FROM issues i
        JOIN chain c ON i.id=c.id WHERE i.repo_id=? AND i.duplicate_of_id IS NOT NULL) SELECT 1 FROM chain WHERE id=?`;
      if (await one(database(c), cycleSql, target.id, repo.id, item.id)) conflict('duplicate_cycle', 'This duplicate relationship creates a cycle.');
      after.push(...itemFence(database(c), target));
      const guard = newId('guard');
      after.push(stmt(database(c), `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN EXISTS(${cycleSql}) THEN 0 ELSE 1 END`, guard, target.id, repo.id, item.id));
      after.push(stmt(database(c), 'DELETE FROM mutation_guards WHERE id=?', guard));
      after.push(completeInbox(database(c), item, 'assignment'));
    }
    after.push(stmt(database(c), 'UPDATE issues SET duplicate_of_id=?,status_id=NULL WHERE repo_id=? AND id=?', duplicate_of_id, repo.id, item.id));
    await updateItem(c, repo, item, 'issue.duplicate_changed', duplicate_of_id ? { state: 'closed' } : {}, after, { duplicate_of_id });
    return respond(c, await readIssue(c));
  });
}

function registerIssuePullLinks(app: App, base: string): void {
  const path = `${base}/:itemId/pulls`;
  interface Link { id: string; repo_id: string; issue_id: string; pull_id: string; closes_issue: number; revision: number; created_at: string }
  route(app, 'GET', path, { summary: 'List issue-linked changes', tags: ['issues'], capability: 'contents.read' }, async c => {
    const { item, repo } = await getItem(c, 'issue', c.req.param('itemId'));
    const p = pagination(c, `${repo.id}:${item.id}:pulls`);
    const rows = await many<Link>(database(c), `SELECT * FROM issue_pull_links WHERE repo_id=? AND issue_id=? AND ${pageSql()}
      ORDER BY created_at DESC,id DESC LIMIT ?`, repo.id, item.id, ...pageBindings(p));
    for (const row of rows) await getItem(c, 'pull_request', row.pull_id, 'contents.read', repo.id);
    return pagedResponse(c, rows, p);
  });
  const schema = z.strictObject({ pull_id: identifier, closes_issue: z.boolean().default(false) });
  route(app, 'POST', path, { summary: 'Link a proposed change to an issue', tags: ['issues'], capability: 'issues.triage', body: schema }, async c => {
    const { item, repo } = await getItem(c, 'issue', c.req.param('itemId'), 'issues.triage');
    const data = await jsonBody(c, schema);
    const pull = (await getItem(c, 'pull_request', data.pull_id, 'contents.read', repo.id)).item;
    const id = newId('link');
    const at = now();
    const updated = await updateItem(c, repo, item, 'issue.pull_linked', {}, [
      ...itemFence(database(c), pull), stmt(database(c), `INSERT INTO issue_pull_links
        (id,repo_id,issue_id,pull_id,closes_issue,created_by,created_at,revision) VALUES (?,?,?,?,?,?,?,1)`,
      id, repo.id, item.id, pull.id, Number(data.closes_issue), requirePrincipal(c).id, at),
    ], { pull_id: pull.id, closes_issue: data.closes_issue });
    return respond(c, { id, repo_id: repo.id, issue_id: item.id, ...data, revision: 1, item_revision: updated.revision, created_at: at }, 201);
  });
  route(app, 'DELETE', `${path}/:id`, { summary: 'Unlink a proposed change', tags: ['issues'], capability: 'issues.triage' }, async c => {
    const { item, repo } = await getItem(c, 'issue', c.req.param('itemId'), 'issues.triage');
    const link = await one<Link>(database(c), 'SELECT * FROM issue_pull_links WHERE repo_id=? AND issue_id=? AND id=?', repo.id, item.id, c.req.param('id'));
    if (!link) notFound();
    checkRevision(c, link);
    await getItem(c, 'pull_request', link.pull_id, 'contents.read', repo.id);
    await commit(c, { repo, item, resource_id: link.id, revision: link.revision + 1, type: 'issue.pull_unlinked',
      sql: 'DELETE FROM issue_pull_links WHERE repo_id=? AND issue_id=? AND id=? AND revision=?',
      bindings: [repo.id, item.id, link.id, link.revision], after: [...itemFence(database(c), item), itemTouch(database(c), item)], data: { pull_id: link.pull_id } });
    return respond(c, { id: link.id, revision: link.revision + 1, deleted: true });
  });
}
