import { z } from 'zod';
import {
  ApiError, authorize, database, explainAuthorization, getRepository, jsonBody, listResponse, many,
  newId, now, one, principalForExplanation, readAccountPolicy, requirePrincipal, route, stmt,
} from '@gitknot/core';
import type { App, AppContext, Principal, Repository } from '@gitknot/core';
import {
  assertUser, checkRevision, commit, completeInbox, conflict, createItem, documentStatement, eventFor,
  getItem, gitPath, identifier, inboxStatement, itemFence, itemTouch, listItems, markdown, newItem,
  nextCursor, notFound, oid, pageBindings, pagedResponse, pageSql, pagination, respond, title,
  uniqueIds, updateItem,
} from './common.ts';
import type { DocumentVersion, Item } from './common.ts';
import { resolveNativeCommit } from './native.ts';
import { prepareOperation, publicOperation } from './operation-model.ts';

export interface Task { id: string; repo_id: string; issue_id: string | null; accountable_user_id: string;
  base_oid: string; decision_markdown: string; decision_revision: number; completed_at: string | null }
export interface TaskClaim { id: string; repo_id: string; task_id: string; principal_id: string; description: string;
  state: string; lease_seconds: number; heartbeat_at: string; expires_at: string; revision: number; created_at: string; updated_at: string }
export interface Workspace { id: string; repo_id: string; task_id: string; workspace_repo_id: string; owner_principal_id: string;
  base_oid: string; operation_id: string; state: string; retention_until: string; last_active_at: string;
  revision: number; created_at: string; updated_at: string }

const create = z.strictObject({ title, markdown: markdown.default(''), issue_id: identifier.optional(), accountable_user_id: identifier,
  base_oid: oid, contributor_ids: uniqueIds.default([]) });
const edit = z.strictObject({ title: title.optional(), markdown: markdown.optional(), issue_id: identifier.nullable().optional(),
  accountable_user_id: identifier.optional(), state: z.enum(['active', 'completed', 'cancelled']).optional(),
  decision_markdown: markdown.optional() }).refine(value => Object.keys(value).length > 0, 'Supply at least one field.');

async function taskDetails(c: AppContext, item: Item): Promise<Task> {
  const task = await one<Task>(database(c), 'SELECT * FROM tasks WHERE repo_id=? AND id=?', item.repo_id, item.id);
  if (!task) notFound();
  return task;
}
async function taskParticipant(c: AppContext, item: Item): Promise<void> {
  const actor = requirePrincipal(c);
  const task = await taskDetails(c, item);
  if (actor.user_id === task.accountable_user_id || actor.id === item.author_id || await one(database(c),
    'SELECT 1 FROM task_contributors WHERE repo_id=? AND task_id=? AND principal_id=?', item.repo_id, item.id, actor.id)) return;
  await authorize(c, 'tasks.manage', { repo_id: item.repo_id });
}
async function assertContributor(c: AppContext, repo: Repository, id: string): Promise<Principal> {
  const principal = await principalForExplanation(c.env.DB, id);
  if (!principal || !(await explainAuthorization(c, 'contents.read', { repo_id: repo.id }, principal)).allowed) {
    throw new ApiError(422, 'contributor_unavailable', 'Contributors must be active principals with current access to the source repository.');
  }
  return principal;
}
async function readTask(c: AppContext, id = c.req.param('id')): Promise<Record<string, unknown> & { revision: number }> {
  const { item, repo } = await getItem(c, 'task', id);
  const task = await taskDetails(c, item);
  if (task.issue_id) await getItem(c, 'issue', task.issue_id, 'contents.read', repo.id);
  const accountable = await assertUser(c, task.accountable_user_id);
  const contributors = await many<{ principal_id: string }>(database(c), 'SELECT principal_id FROM task_contributors WHERE repo_id=? AND task_id=? ORDER BY principal_id', repo.id, item.id);
  return { ...item, ...task, accountable, contributor_ids: contributors.map(value => value.principal_id) };
}

export function registerTaskRoutes(app: App): void {
  const path = '/v1/repos/:repoId/tasks';
  route(app, 'GET', path, { summary: 'List coordination tasks', tags: ['tasks'], capability: 'contents.read' }, c => listItems(c, 'task'));
  route(app, 'GET', `${path}/:id`, { summary: 'Read task accountability and decision', tags: ['tasks'], capability: 'contents.read' }, async c => respond(c, await readTask(c)));
  route(app, 'GET', `${path}/:id/decision/versions`, { summary: 'Read immutable task decision Markdown', tags: ['tasks', 'markdown'], capability: 'contents.read' }, async c => {
    const { item, repo } = await getItem(c, 'task');
    const p = pagination(c, `${repo.id}:${item.id}:decision-versions`);
    const rows = await many<DocumentVersion>(database(c), `SELECT * FROM collaboration_document_versions WHERE repo_id=? AND resource_id=?
      AND resource_kind='task_decision' AND ${pageSql()} ORDER BY created_at DESC,id DESC LIMIT ?`, repo.id, item.id, ...pageBindings(p));
    return pagedResponse(c, rows, p);
  });
  route(app, 'POST', path, { summary: 'Create a revision-pinned coordination task', tags: ['tasks'], capability: 'tasks.manage', body: create }, async c => {
    const repo = await getRepository(c, c.req.param('repoId') ?? '', 'tasks.manage');
    const input = await jsonBody(c, create);
    const accountable = await assertUser(c, input.accountable_user_id);
    const issue = input.issue_id ? (await getItem(c, 'issue', input.issue_id, 'contents.read', repo.id)).item : null;
    for (const id of input.contributor_ids) await assertContributor(c, repo, id);
    await resolveNativeCommit(c, repo.id, input.base_oid);
    const item = newItem(c, repo.id, 'task', { title: input.title, markdown: input.markdown, state: 'active' });
    const event = eventFor(c, 'task.created', item.id, 1, repo, { item_id: item.id, kind: 'task', accountable_user_id: accountable.id });
    await createItem(c, repo, item, [
      ...(issue ? itemFence(database(c), issue) : []),
      stmt(database(c), 'INSERT INTO tasks(id,repo_id,issue_id,accountable_user_id,base_oid) VALUES (?,?,?,?,?)', item.id, repo.id, issue?.id ?? null, accountable.id, input.base_oid),
      ...input.contributor_ids.map(id => stmt(database(c), 'INSERT INTO task_contributors(repo_id,task_id,principal_id,added_by,created_at) VALUES (?,?,?,?,?)', repo.id, item.id, id, requirePrincipal(c).id, now())),
      inboxStatement(database(c), { user_id: accountable.id, item, reason: 'task_accountability', source_id: item.id, event_id: event.id }),
      await documentStatement(database(c), { repo_id: repo.id, resource_kind: 'task_decision', resource_id: item.id, document_revision: 1, markdown: '', actor_id: requirePrincipal(c).id }),
    ], {}, event);
    return respond(c, await readTask(c, item.id), 201);
  });
  route(app, 'PATCH', `${path}/:id`, { summary: 'Update accountability or record a durable task decision', tags: ['tasks'], capability: 'tasks.manage', body: edit }, async c => {
    const { item, repo } = await getItem(c, 'task', c.req.param('id'), 'tasks.manage');
    checkRevision(c, item);
    const input = await jsonBody(c, edit);
    const task = await taskDetails(c, item);
    if (input.accountable_user_id) await assertUser(c, input.accountable_user_id);
    const issue = input.issue_id ? (await getItem(c, 'issue', input.issue_id, 'contents.read', repo.id)).item : null;
    const decision = input.decision_markdown ?? task.decision_markdown;
    if (input.state === 'completed' && !decision.trim()) conflict('decision_required', 'Record the outcome and decision before completing this task.');
    const fields: Record<string, string> = {};
    for (const key of ['title', 'markdown', 'state'] as const) if (input[key] !== undefined) fields[key] = input[key]!;
    const event = eventFor(c, 'task.updated', item.id, item.revision + 1, repo, { item_id: item.id, changed_fields: Object.keys(input) });
    const after: D1PreparedStatement[] = [
      ...(issue ? itemFence(database(c), issue) : []),
      stmt(database(c), `UPDATE tasks SET issue_id=?,accountable_user_id=?,decision_markdown=?,decision_revision=decision_revision+?,completed_at=? WHERE repo_id=? AND id=?`,
        input.issue_id === undefined ? task.issue_id : input.issue_id, input.accountable_user_id ?? task.accountable_user_id,
        decision, Number(input.decision_markdown !== undefined), (input.state ?? item.state) === 'completed' ? task.completed_at ?? now() : null, repo.id, item.id),
    ];
    if (input.decision_markdown !== undefined) after.push(await documentStatement(database(c), {
      repo_id: repo.id, resource_kind: 'task_decision', resource_id: item.id, document_revision: task.decision_revision + 1,
      markdown: input.decision_markdown, actor_id: requirePrincipal(c).id,
    }));
    if (input.accountable_user_id && input.accountable_user_id !== task.accountable_user_id) {
      after.push(completeInbox(database(c), item, 'task_accountability', item.id, task.accountable_user_id));
      after.push(inboxStatement(database(c), { user_id: input.accountable_user_id, item, reason: 'task_accountability', source_id: item.id, event_id: event.id }));
    }
    if (input.state && input.state !== 'active') {
      after.push(completeInbox(database(c), item, 'task_accountability'));
      after.push(stmt(database(c), "UPDATE task_claims SET state='released',revision=revision+1,updated_at=? WHERE repo_id=? AND task_id=? AND state='active'", now(), repo.id, item.id));
    }
    if (input.state === 'active' && item.state !== 'active') after.push(inboxStatement(database(c), {
      user_id: input.accountable_user_id ?? task.accountable_user_id, item, reason: 'task_accountability', source_id: item.id, event_id: event.id,
    }));
    await updateItem(c, repo, item, event.type, fields, after, {}, undefined, event);
    return respond(c, await readTask(c));
  });
  const contributors = z.strictObject({ principal_ids: uniqueIds });
  route(app, 'PUT', `${path}/:id/contributors`, { summary: 'Set scoped task contributors', tags: ['tasks'], capability: 'tasks.manage', body: contributors }, async c => {
    const { item, repo } = await getItem(c, 'task', c.req.param('id'), 'tasks.manage');
    const { principal_ids } = await jsonBody(c, contributors);
    for (const id of principal_ids) await assertContributor(c, repo, id);
    const after = [stmt(database(c), 'DELETE FROM task_contributors WHERE repo_id=? AND task_id=?', repo.id, item.id),
      ...principal_ids.map(id => stmt(database(c), 'INSERT INTO task_contributors(repo_id,task_id,principal_id,added_by,created_at) VALUES (?,?,?,?,?)', repo.id, item.id, id, requirePrincipal(c).id, now())),
      stmt(database(c), `UPDATE task_claims SET state='released',revision=revision+1,updated_at=? WHERE repo_id=? AND task_id=? AND state='active'
        AND principal_id NOT IN (SELECT principal_id FROM task_contributors WHERE repo_id=? AND task_id=?)
        AND principal_id<>? AND principal_id NOT IN (SELECT p.id FROM principals p JOIN tasks t ON t.accountable_user_id=p.user_id WHERE t.repo_id=? AND t.id=?)`,
      now(), repo.id, item.id, repo.id, item.id, item.author_id, repo.id, item.id)];
    await updateItem(c, repo, item, 'task.contributors_changed', {}, after, { principal_ids });
    return respond(c, await readTask(c));
  });
  registerClaims(app, path);
  registerWorkspaces(app, path);
  registerProposals(app, path);
}

async function claimOverlaps(c: AppContext, repoId: string, paths: string[], omitId?: string): Promise<{ items: object[]; truncated: boolean }> {
  const conditions = paths.map(() => '(p.path=? OR substr(p.path,1,length(?)+1)=?||\'/\' OR substr(?,1,length(p.path)+1)=p.path||\'/\')');
  const rows = await many<TaskClaim & { path: string }>(database(c), `SELECT DISTINCT c.*,p.path FROM task_claims c JOIN task_claim_paths p
    ON p.repo_id=c.repo_id AND p.claim_id=c.id WHERE c.repo_id=? AND c.state='active' AND c.expires_at>? AND c.id<>?
    AND (${conditions.join(' OR ')}) ORDER BY c.created_at DESC,c.id DESC LIMIT 101`, repoId, now(), omitId ?? '', ...paths.flatMap(path => [path, path, path, path]));
  return { items: rows.slice(0, 100), truncated: rows.length > 100 };
}

function registerClaims(app: App, base: string): void {
  const path = `${base}/:taskId/claims`;
  route(app, 'GET', path, { summary: 'List advisory task claims and live lease state', tags: ['tasks'], capability: 'contents.read' }, async c => {
    const { item, repo } = await getItem(c, 'task', c.req.param('taskId'));
    const p = pagination(c, `${repo.id}:${item.id}:claims`);
    const rows = await many<TaskClaim>(database(c), `SELECT * FROM task_claims WHERE repo_id=? AND task_id=? AND ${pageSql()}
      ORDER BY created_at DESC,id DESC LIMIT ?`, repo.id, item.id, ...pageBindings(p));
    const values = [];
    for (const row of rows) values.push({ ...row, live: row.state === 'active' && row.expires_at > now(), paths: (await many<{ path: string }>(database(c),
      'SELECT path FROM task_claim_paths WHERE repo_id=? AND claim_id=? ORDER BY path', repo.id, row.id)).map(value => value.path) });
    return pagedResponse(c, values, p);
  });
  const claim = z.strictObject({ description: z.string().trim().min(1).max(2000),
    paths: z.array(gitPath.refine(value => !/[?*]/.test(value), 'Claims use literal path prefixes, not globs.')).min(1).max(50),
    lease_seconds: z.number().int().min(30).max(3600).default(300) });
  route(app, 'POST', path, { summary: 'Declare an advisory claim and report overlapping work', tags: ['tasks'], capability: 'tasks.write', body: claim }, async c => {
    const { item, repo } = await getItem(c, 'task', c.req.param('taskId'), 'tasks.write');
    checkRevision(c, item);
    await taskParticipant(c, item);
    if (item.state !== 'active') conflict('task_not_active', 'Only active tasks accept work claims.');
    const input = await jsonBody(c, claim);
    const paths = [...new Set(input.paths.map(path => path.replace(/\/$/, '')))];
    const id = newId('claim');
    const at = now();
    const expires = new Date(Date.now() + input.lease_seconds * 1000).toISOString();
    await updateItem(c, repo, item, 'task.claim_created', {}, [
      stmt(database(c), `INSERT INTO task_claims(id,repo_id,task_id,principal_id,description,lease_seconds,heartbeat_at,expires_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, id, repo.id, item.id, requirePrincipal(c).id, input.description, input.lease_seconds, at, expires, at, at),
      ...paths.map(path => stmt(database(c), 'INSERT INTO task_claim_paths(repo_id,claim_id,path) VALUES (?,?,?)', repo.id, id, path)),
    ], { claim_id: id, paths, expires_at: expires });
    return respond(c, { id, repo_id: repo.id, task_id: item.id, principal_id: requirePrincipal(c).id, ...input, paths,
      revision: 1, state: 'active', expires_at: expires, heartbeat_at: at, created_at: at, overlaps: await claimOverlaps(c, repo.id, paths, id) }, 201);
  });
  const heartbeat = z.strictObject({ lease_seconds: z.number().int().min(30).max(3600).optional() });
  route(app, 'POST', `${path}/:id/heartbeat`, { summary: 'Renew your unexpired advisory claim', tags: ['tasks'], capability: 'tasks.write', body: heartbeat }, async c => {
    const { item, repo } = await getItem(c, 'task', c.req.param('taskId'), 'tasks.write');
    await taskParticipant(c, item);
    const value = await one<TaskClaim>(database(c), 'SELECT * FROM task_claims WHERE repo_id=? AND task_id=? AND id=? AND principal_id=?', repo.id, item.id, c.req.param('id'), requirePrincipal(c).id);
    if (!value) notFound();
    checkRevision(c, value);
    if (value.state !== 'active' || value.expires_at <= now() || item.state !== 'active') conflict('claim_expired', 'This claim is no longer live. Create a new claim to resume work.');
    const input = await jsonBody(c, heartbeat);
    const seconds = input.lease_seconds ?? value.lease_seconds;
    const at = now();
    const expires = new Date(Date.now() + seconds * 1000).toISOString();
    await commit(c, { repo, item, resource_id: value.id, revision: value.revision + 1, type: 'task.claim_heartbeat',
      sql: `UPDATE task_claims SET lease_seconds=?,heartbeat_at=?,expires_at=?,revision=revision+1,updated_at=?
        WHERE repo_id=? AND task_id=? AND id=? AND principal_id=? AND revision=? AND state='active' AND expires_at>?`,
      bindings: [seconds, at, expires, at, repo.id, item.id, value.id, requirePrincipal(c).id, value.revision, at],
      after: itemFence(database(c), item), data: { item_id: item.id, claim_id: value.id, expires_at: expires } });
    const paths = (await many<{ path: string }>(database(c), 'SELECT path FROM task_claim_paths WHERE repo_id=? AND claim_id=?', repo.id, value.id)).map(row => row.path);
    return respond(c, { ...value, revision: value.revision + 1, lease_seconds: seconds, heartbeat_at: at, expires_at: expires, updated_at: at,
      overlaps: await claimOverlaps(c, repo.id, paths, value.id) });
  });
  route(app, 'DELETE', `${path}/:id`, { summary: 'Release an advisory work claim', tags: ['tasks'], capability: 'tasks.write' }, async c => {
    const { item, repo } = await getItem(c, 'task', c.req.param('taskId'), 'tasks.write');
    const value = await one<TaskClaim>(database(c), 'SELECT * FROM task_claims WHERE repo_id=? AND task_id=? AND id=?', repo.id, item.id, c.req.param('id'));
    if (!value) notFound();
    checkRevision(c, value);
    if (value.principal_id !== requirePrincipal(c).id) await authorize(c, 'tasks.manage', { repo_id: repo.id });
    await commit(c, { repo, item, resource_id: value.id, revision: value.revision + 1, type: 'task.claim_released',
      sql: "UPDATE task_claims SET state='released',revision=revision+1,updated_at=? WHERE repo_id=? AND task_id=? AND id=? AND revision=?",
      bindings: [now(), repo.id, item.id, value.id, value.revision], after: itemFence(database(c), item), data: { item_id: item.id, claim_id: value.id } });
    return respond(c, { id: value.id, state: 'released', revision: value.revision + 1 });
  });
}

function registerWorkspaces(app: App, base: string): void {
  const path = `${base}/:taskId/workspaces`;
  route(app, 'GET', path, { summary: 'List task workspaces visible to you', tags: ['tasks'], capability: 'contents.read' }, async c => {
    const { item, repo } = await getItem(c, 'task', c.req.param('taskId'));
    const p = pagination(c, `${repo.id}:${item.id}:workspaces`);
    const rows = await many<Workspace>(database(c), `SELECT * FROM task_workspaces WHERE repo_id=? AND task_id=? AND ${pageSql()}
      ORDER BY created_at DESC,id DESC LIMIT ?`, repo.id, item.id, ...pageBindings(p));
    const visible = [];
    for (const row of rows.slice(0, p.limit)) {
      try { await getRepository(c, row.workspace_repo_id, 'repositories.read'); visible.push(row); }
      catch (error) { if (!(error instanceof ApiError && [401, 403, 404].includes(error.status))) throw error; }
    }
    return listResponse(c, visible, rows.length > p.limit ? nextCursor(p, rows[p.limit - 1]) : null);
  });
  const schema = z.strictObject({ owner_id: identifier.optional(), principal_id: identifier.optional(),
    name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).optional(),
    retention_days: z.number().int().min(1).max(90).default(14) });
  route(app, 'POST', path, { summary: 'Provision a private revision-pinned task workspace', tags: ['tasks'], capability: 'tasks.manage', body: schema }, async c => {
    const { item, repo } = await getItem(c, 'task', c.req.param('taskId'), 'tasks.manage');
    checkRevision(c, item);
    if (item.state !== 'active') conflict('task_not_active', 'Only active tasks can create workspaces.');
    const input = await jsonBody(c, schema);
    const task = await taskDetails(c, item);
    const actor = requirePrincipal(c);
    const contributor = await assertContributor(c, repo, input.principal_id ?? actor.id);
    const owner = input.owner_id ? await one<{ id: string }>(database(c), 'SELECT id FROM accounts WHERE id=? AND disabled_at IS NULL', input.owner_id)
      : await one<{ id: string }>(database(c), "SELECT id FROM accounts WHERE type='user' AND owner_user_id=? AND disabled_at IS NULL", actor.user_id);
    if (!owner) notFound();
    await authorize(c, 'repositories.create', { account_id: owner.id });
    const { policy } = await readAccountPolicy(c.env.DB, owner.id);
    if (!policy.allowed_repository_visibilities.includes('private')) conflict('private_workspace_required', 'The receiving account must allow private repositories.');
    const id = newId('workspace');
    const workspaceRepoId = newId('r');
    const at = now();
    const name = input.name ?? `task-${id.slice(-12)}`;
    const retention = new Date(Date.now() + input.retention_days * 86400_000).toISOString();
    const prepared = await prepareOperation(c, { repo, kind: 'workspace', resource_id: id, item_id: item.id,
      expected_item_revision: item.revision + 1, input: { workspace_id: id, source_repo_id: repo.id, workspace_repo_id: workspaceRepoId,
        owner_id: owner.id, principal_id: contributor.id, base_oid: task.base_oid } });
    await updateItem(c, repo, item, 'task.workspace_requested', {}, [
      ...prepared.statements,
      stmt(database(c), `INSERT INTO repositories(id,owner_id,name,slug,description,visibility,default_branch,state,cell_id,shard_id,storage_name,
        fork_source_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'private',?,'provisioning',?,?,?,?,?,?,?)`,
      workspaceRepoId, owner.id, name, name.toLowerCase(), `Private workspace for task ${item.id}`, 'work',
      c.env.CELL_ID, c.env.SHARD_ID, workspaceRepoId, repo.id, actor.id, at, at),
      stmt(database(c), `INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,epoch,state,updated_at) VALUES (?,'repository',?,?,1,'active',?)`, workspaceRepoId, c.env.CELL_ID, c.env.SHARD_ID, at),
      stmt(database(c), `INSERT INTO task_workspaces(id,repo_id,task_id,workspace_repo_id,owner_principal_id,base_oid,operation_id,state,retention_until,last_active_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'provisioning',?,?,?,?)`, id, repo.id, item.id, workspaceRepoId, contributor.id, task.base_oid, prepared.operation.id, retention, at, at, at),
      stmt(database(c), `INSERT INTO access_grants(id,account_id,repo_id,principal_id,principal_type,role_id,effect,conditions_json,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,'contributor','allow','{}',?,?,?)`, newId('grant'), owner.id, workspaceRepoId, contributor.id, contributor.kind, actor.id, at, at),
      ...(contributor.id === actor.id ? [] : [stmt(database(c), `INSERT INTO access_grants(id,account_id,repo_id,principal_id,principal_type,role_id,effect,conditions_json,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,'contributor','allow','{}',?,?,?)`, newId('grant'), owner.id, workspaceRepoId, actor.id, actor.kind, actor.id, at, at)]),
    ], { workspace_id: id, workspace_repo_id: workspaceRepoId, operation_id: prepared.operation.id, visibility: 'private' });
    c.header('location', `/v1/operations/${prepared.operation.id}`);
    return respond(c, { id, repo_id: repo.id, task_id: item.id, workspace_repo_id: workspaceRepoId, visibility: 'private',
      state: 'provisioning', revision: 1, retention_until: retention, operation: publicOperation(prepared.operation) }, 202);
  });
  const retention = z.strictObject({ retention_days: z.number().int().min(1).max(90) });
  route(app, 'PATCH', `${path}/:id`, { summary: 'Extend a visible workspace retention lease', tags: ['tasks'], capability: 'tasks.manage', body: retention }, async c => {
    const { item, repo } = await getItem(c, 'task', c.req.param('taskId'), 'tasks.manage');
    const value = await one<Workspace>(database(c), 'SELECT * FROM task_workspaces WHERE repo_id=? AND task_id=? AND id=?', repo.id, item.id, c.req.param('id'));
    if (!value) notFound();
    await getRepository(c, value.workspace_repo_id);
    checkRevision(c, value);
    if (value.state !== 'active') conflict('workspace_not_active', 'Only an active workspace lease can be extended.');
    const input = await jsonBody(c, retention);
    const until = new Date(Date.now() + input.retention_days * 86400_000).toISOString();
    await commit(c, { repo, item, resource_id: value.id, revision: value.revision + 1, type: 'task.workspace_retention_changed',
      sql: 'UPDATE task_workspaces SET retention_until=?,last_active_at=?,revision=revision+1,updated_at=? WHERE repo_id=? AND task_id=? AND id=? AND revision=?',
      bindings: [until, now(), now(), repo.id, item.id, value.id, value.revision], after: itemFence(database(c), item), data: { item_id: item.id, retention_until: until } });
    return respond(c, { ...value, retention_until: until, revision: value.revision + 1 });
  });
  route(app, 'DELETE', `${path}/:id`, { summary: 'Retire a workspace while retaining referenced review commits', tags: ['tasks'], capability: 'tasks.manage' }, async c => {
    const { item, repo } = await getItem(c, 'task', c.req.param('taskId'), 'tasks.manage');
    const value = await one<Workspace>(database(c), 'SELECT * FROM task_workspaces WHERE repo_id=? AND task_id=? AND id=?', repo.id, item.id, c.req.param('id'));
    if (!value) notFound();
    await getRepository(c, value.workspace_repo_id);
    checkRevision(c, value);
    const prepared = await prepareOperation(c, { repo, kind: 'workspace_retire', resource_id: value.id, item_id: item.id,
      input: { workspace_id: value.id, workspace_repo_id: value.workspace_repo_id } });
    await commit(c, { repo, item, resource_id: value.id, revision: value.revision + 1, type: 'task.workspace_retirement_requested',
      sql: "UPDATE task_workspaces SET state='expiring',retention_until=?,operation_id=?,revision=revision+1,updated_at=? WHERE repo_id=? AND task_id=? AND id=? AND revision=? AND state IN ('active','failed')",
      bindings: [now(), prepared.operation.id, now(), repo.id, item.id, value.id, value.revision], after: [...prepared.statements, ...itemFence(database(c), item)],
      data: { item_id: item.id, operation_id: prepared.operation.id } });
    return respond(c, { id: value.id, state: 'expiring', revision: value.revision + 1, operation: publicOperation(prepared.operation) }, 202);
  });
}

function registerProposals(app: App, base: string): void {
  const path = `${base}/:taskId/proposals`;
  interface Proposal { id: string; repo_id: string; task_id: string; pull_id: string; disposition: string;
    summary_markdown: string; evidence_markdown: string; created_by: string; revision: number; document_revision: number; created_at: string; updated_at: string }
  async function proposal(c: AppContext, item: Item): Promise<Proposal> {
    const value = await one<Proposal>(database(c), 'SELECT * FROM task_pull_links WHERE repo_id=? AND task_id=? AND id=?', item.repo_id, item.id, c.req.param('id'));
    if (!value) notFound();
    await getItem(c, 'pull_request', value.pull_id, 'contents.read', item.repo_id);
    return value;
  }
  route(app, 'GET', `${path}/:id`, { summary: 'Read task proposal and evidence', tags: ['tasks'], capability: 'contents.read' }, async c => {
    const { item } = await getItem(c, 'task', c.req.param('taskId'));
    return respond(c, await proposal(c, item));
  });
  route(app, 'GET', `${path}/:id/versions`, { summary: 'Read immutable task proposal Markdown history', tags: ['tasks', 'markdown'], capability: 'contents.read' }, async c => {
    const { item, repo } = await getItem(c, 'task', c.req.param('taskId'));
    const value = await proposal(c, item);
    const p = pagination(c, `${repo.id}:${value.id}:proposal-versions`);
    const rows = await many<DocumentVersion>(database(c), `SELECT * FROM collaboration_document_versions WHERE repo_id=? AND resource_id=?
      AND resource_kind IN ('task_proposal_summary','task_proposal_evidence') AND ${pageSql()} ORDER BY created_at DESC,id DESC LIMIT ?`, repo.id, value.id, ...pageBindings(p));
    return pagedResponse(c, rows, p);
  });
  route(app, 'GET', path, { summary: 'List attributed proposals and evidence for a task', tags: ['tasks'], capability: 'contents.read' }, async c => {
    const { item, repo } = await getItem(c, 'task', c.req.param('taskId'));
    const p = pagination(c, `${repo.id}:${item.id}:proposals`);
    const rows = await many<Proposal>(database(c), `SELECT * FROM task_pull_links WHERE repo_id=? AND task_id=? AND ${pageSql()} ORDER BY created_at DESC,id DESC LIMIT ?`, repo.id, item.id, ...pageBindings(p));
    for (const row of rows) await getItem(c, 'pull_request', row.pull_id, 'contents.read', repo.id);
    return pagedResponse(c, rows, p);
  });
  const schema = z.strictObject({ pull_id: identifier, summary_markdown: markdown.min(1), evidence_markdown: markdown.default('') });
  route(app, 'POST', path, { summary: 'Attach an attributed proposed change and evidence', tags: ['tasks'], capability: 'tasks.write', body: schema }, async c => {
    const { item, repo } = await getItem(c, 'task', c.req.param('taskId'), 'tasks.write');
    await taskParticipant(c, item);
    const input = await jsonBody(c, schema);
    const pull = (await getItem(c, 'pull_request', input.pull_id, 'contents.read', repo.id)).item;
    const id = newId('proposal');
    const at = now();
    await updateItem(c, repo, item, 'task.proposal_created', {}, [
      ...itemFence(database(c), pull),
      stmt(database(c), `INSERT INTO task_pull_links(id,repo_id,task_id,pull_id,summary_markdown,evidence_markdown,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`, id, repo.id, item.id, pull.id, input.summary_markdown, input.evidence_markdown, requirePrincipal(c).id, at, at),
      ...await proposalVersions(c, repo.id, id, 1, input),
    ], { proposal_id: id, pull_id: pull.id });
    return respond(c, { id, repo_id: repo.id, task_id: item.id, ...input, disposition: 'proposed', revision: 1, document_revision: 1, created_at: at }, 201);
  });
  const patch = z.strictObject({ summary_markdown: markdown.optional(), evidence_markdown: markdown.optional(),
    disposition: z.enum(['proposed', 'accepted', 'abandoned']).optional() }).refine(value => Object.keys(value).length > 0, 'Supply at least one field.');
  route(app, 'PATCH', `${path}/:id`, { summary: 'Update a proposal or record its disposition', tags: ['tasks'], capability: 'tasks.write', body: patch }, async c => {
    const { item, repo } = await getItem(c, 'task', c.req.param('taskId'), 'tasks.write');
    await taskParticipant(c, item);
    const value = await proposal(c, item);
    checkRevision(c, value);
    const input = await jsonBody(c, patch);
    if (value.created_by !== requirePrincipal(c).id) await authorize(c, 'tasks.manage', { repo_id: repo.id });
    if (input.disposition) await authorize(c, 'tasks.manage', { repo_id: repo.id });
    const edited = input.summary_markdown !== undefined || input.evidence_markdown !== undefined;
    const updated = { ...value, ...input, revision: value.revision + 1, document_revision: value.document_revision + Number(edited), updated_at: now() };
    await commit(c, { repo, item, resource_id: value.id, revision: updated.revision, type: 'task.proposal_updated',
      sql: `UPDATE task_pull_links SET summary_markdown=?,evidence_markdown=?,disposition=?,revision=revision+1,document_revision=document_revision+?,updated_at=?
        WHERE repo_id=? AND task_id=? AND id=? AND revision=?`,
      bindings: [updated.summary_markdown, updated.evidence_markdown, updated.disposition, Number(edited), updated.updated_at, repo.id, item.id, value.id, value.revision],
      after: [...itemFence(database(c), item), itemTouch(database(c), item), ...(edited ? await proposalVersions(c, repo.id, value.id, updated.document_revision, updated) : [])],
      data: { item_id: item.id, pull_id: value.pull_id, disposition: updated.disposition } });
    return respond(c, updated);
  });
  route(app, 'DELETE', `${path}/:id`, { summary: 'Abandon a proposal while preserving its evidence history', tags: ['tasks'], capability: 'tasks.write' }, async c => {
    const { item, repo } = await getItem(c, 'task', c.req.param('taskId'), 'tasks.write');
    await taskParticipant(c, item);
    const value = await proposal(c, item);
    checkRevision(c, value);
    if (value.created_by !== requirePrincipal(c).id || value.disposition === 'accepted') await authorize(c, 'tasks.manage', { repo_id: repo.id });
    await commit(c, { repo, item, resource_id: value.id, revision: value.revision + 1, type: 'task.proposal_abandoned',
      sql: "UPDATE task_pull_links SET disposition='abandoned',revision=revision+1,updated_at=? WHERE repo_id=? AND task_id=? AND id=? AND revision=?",
      bindings: [now(), repo.id, item.id, value.id, value.revision], after: [...itemFence(database(c), item), itemTouch(database(c), item)],
      data: { item_id: item.id, proposal_id: value.id, pull_id: value.pull_id } });
    return respond(c, { id: value.id, disposition: 'abandoned', revision: value.revision + 1 });
  });
}

async function proposalVersions(c: AppContext, repoId: string, id: string, revision: number, value: { summary_markdown: string; evidence_markdown: string }): Promise<D1PreparedStatement[]> {
  return Promise.all([['task_proposal_summary', value.summary_markdown], ['task_proposal_evidence', value.evidence_markdown]].map(([kind, text]) =>
    documentStatement(database(c), { repo_id: repoId, resource_kind: kind!, resource_id: id, document_revision: revision, markdown: text!, actor_id: requirePrincipal(c).id })));
}
