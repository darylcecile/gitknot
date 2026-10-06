import { z } from 'zod';
import {
  ApiError, authorize, database, decodeCursor, encodeCursor, etag, expectedRevision,
  getRepository, identityDatabase, listResponse, makeEvent, many, mutate, newId, now, one, page,
  requirePrincipal, separateIdentityAuthority, sha256, stmt,
} from '@gitknot/core';
import type { AppContext, Database, EventRecord, Repository, RequestAuthorization } from '@gitknot/core';
import { referencedUser, requireCurrentUserReference } from './identity-references.ts';

export const identifier = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.:-]+$/);
export const title = z.string().trim().min(1).max(300);
export const markdown = z.string().max(500_000);
export const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const color = z.string().regex(/^[a-fA-F0-9]{6}$/).transform(value => value.toLowerCase());
export const timestamp = z.iso.datetime({ precision: 3 });
export const gitPath = z.string().min(1).max(4096).refine(value =>
  !value.startsWith('/') && !value.includes('\0') && !value.split('/').some(part => part === '..' || part === '.'),
'Use a repository-relative path without dot segments.');
export const ref = z.string().max(1024).regex(/^refs\/heads\/[^\s~^:?*\[\\]+$/).refine(value =>
  !value.includes('..') && !value.includes('@{') && !value.includes('//') && !value.endsWith('/')
  && !value.endsWith('.') && !value.split('/').some(part => part.startsWith('.') || part.endsWith('.lock')),
'Use a valid full branch ref.');
export const uniqueIds = z.array(identifier).max(100).refine(ids => new Set(ids).size === ids.length, 'Remove duplicate IDs.');

interface ReferenceFence { table: string; repo_id?: string; id: string; revision?: number; active_column: 'deleted_at' | 'disabled_at'; identity?: boolean }
const referenceFences = new WeakMap<AppContext, Map<string, ReferenceFence>>();
function rememberReference(c: AppContext, value: ReferenceFence): void {
  const references = referenceFences.get(c) ?? new Map<string, ReferenceFence>();
  references.set(`${value.table}:${value.id}`, value);
  referenceFences.set(c, references);
}

export type ItemKind = 'issue' | 'pull_request' | 'discussion' | 'task';
export interface Item {
  id: string; repo_id: string; kind: ItemKind; number: number; title: string; markdown: string;
  author_id: string; state: string; revision: number; document_revision: number;
  locked_at: string | null; locked_by: string | null; deleted_at: string | null;
  created_at: string; updated_at: string;
}
export interface Comment {
  id: string; repo_id: string; item_id: string; parent_id: string | null; review_thread_id: string | null;
  author_id: string; markdown: string; state: 'visible' | 'hidden' | 'deleted';
  anchor_document_revision: number | null; anchor_start: number | null; anchor_end: number | null;
  anchor_sha256: string | null; moderation_reason: string | null;
  revision: number; document_revision: number; created_at: string; updated_at: string;
}
export interface DocumentVersion {
  id: string; repo_id: string; resource_kind: string; resource_id: string;
  document_revision: number; title: string | null; markdown: string; sha256: string;
  actor_id: string; restored_from: number | null; created_at: string;
}

export const writeCapability: Record<ItemKind, string> = {
  issue: 'issues.write', pull_request: 'pull_requests.write', discussion: 'discussions.write', task: 'tasks.manage',
};
export const manageCapability: Record<ItemKind, string> = {
  issue: 'issues.triage', pull_request: 'pull_requests.manage', discussion: 'discussions.moderate', task: 'tasks.manage',
};
export const commentCapability: Record<ItemKind, string> = {
  issue: 'issues.write', pull_request: 'pull_requests.review', discussion: 'discussions.write', task: 'tasks.write',
};

/** Return the complete audience, including a PR's source repository, for route admission. */
export async function subjectAuthorizations(c: AppContext, repoId: string, itemId?: string, capability = 'contents.read'): Promise<RequestAuthorization[]> {
  const requirements: RequestAuthorization[] = [{ capability, scope: { repo_id: repoId } }];
  if (capability !== 'contents.read') requirements.push({ capability: 'contents.read', scope: { repo_id: repoId } });
  if (!itemId) return requirements;
  const item = await one<{ kind: ItemKind }>(database(c), 'SELECT kind FROM collaboration_items WHERE repo_id=? AND id=?', repoId, itemId);
  if (!item) notFound();
  if (item.kind === 'pull_request') {
    const pull = await one<{ head_repo_id: string }>(database(c), 'SELECT head_repo_id FROM pull_requests WHERE repo_id=? AND id=?', repoId, itemId);
    if (!pull) notFound();
    if (pull.head_repo_id !== repoId) requirements.push({ capability: 'contents.read', scope: { repo_id: pull.head_repo_id } });
  }
  return requirements;
}

export function notFound(): never {
  throw new ApiError(404, 'not_found', 'This resource does not exist or is not accessible.');
}
export function conflict(code: string, message: string, details?: Record<string, unknown>): never {
  throw new ApiError(409, code, message, details);
}
export function checkRevision(c: AppContext, resource: { revision: number }): number {
  const revision = expectedRevision(c);
  if (revision !== resource.revision) {
    throw new ApiError(412, 'revision_conflict', 'This resource changed. Refresh it before applying your edit.');
  }
  return revision;
}
export function respond<T extends { revision: number }>(c: AppContext, resource: T, status: 200 | 201 | 202 = 200): Response {
  c.header('etag', etag(resource.revision));
  c.header('cache-control', 'private, no-store');
  return c.json(resource, status);
}
export function currentUser(c: AppContext): string {
  const principal = requirePrincipal(c);
  if (!principal.user_id) throw new ApiError(403, 'user_required', 'This action requires a user identity.');
  return principal.user_id;
}

/** All representations, including projections, go through this current-state check. */
export async function getItem(c: AppContext, kind?: ItemKind, id = c.req.param('id'), capability = 'contents.read', repoId = c.req.param('repoId'), includeDeleted = false): Promise<{ item: Item; repo: Repository }> {
  const repo = await getRepository(c, repoId ?? '', capability);
  const item = await one<Item>(database(c), `SELECT * FROM collaboration_items
    WHERE repo_id=? AND id=?${includeDeleted ? '' : ' AND deleted_at IS NULL'}${kind ? ' AND kind=?' : ''}`, repo.id, id, ...(kind ? [kind] : []));
  if (!item) notFound();
  if (item.kind === 'pull_request') {
    const pull = await one<{ head_repo_id: string }>(database(c), 'SELECT head_repo_id FROM pull_requests WHERE repo_id=? AND id=?', repo.id, item.id);
    if (!pull) notFound();
    if (pull.head_repo_id !== repo.id) await getRepository(c, pull.head_repo_id);
  }
  return { item, repo };
}

export async function canReadItem(c: AppContext, repoId: string, itemId: string): Promise<Item | null> {
  try { return (await getItem(c, undefined, itemId, 'contents.read', repoId)).item; }
  catch (error) {
    if (error instanceof ApiError && [401, 403, 404, 410].includes(error.status)) return null;
    throw error;
  }
}

export async function assertUser(c: AppContext, id: string): Promise<{ id: string; username: string; display_name: string; avatar_url: string | null }> {
  const user = await referencedUser(c, id);
  rememberReference(c, { table: 'users', id, active_column: 'disabled_at', identity: true });
  return user;
}

const relatedTables = new Set(['labels', 'milestones', 'issue_statuses', 'issue_templates', 'discussion_categories']);
export async function related<T = Record<string, unknown>>(c: AppContext, table: string, repoId: string, id: string | null | undefined): Promise<T | null> {
  if (!id) return null;
  if (!relatedTables.has(table)) throw new TypeError('Unknown collaboration reference.');
  const value = await one<T>(database(c), `SELECT * FROM ${table} WHERE repo_id=? AND id=? AND deleted_at IS NULL`, repoId, id);
  if (!value) notFound();
  const revision = (value as { revision?: unknown }).revision;
  rememberReference(c, { table, repo_id: repoId, id, revision: typeof revision === 'number' ? revision : undefined, active_column: 'deleted_at' });
  return value;
}

export function unlocked(item: Item): void {
  if (item.locked_at) conflict('thread_locked', 'This conversation is locked. A moderator must unlock it before new contributions.');
}

export interface Change {
  repo?: Repository;
  repo_id?: string | null;
  account_id?: string | null;
  item?: Item;
  resource_id: string;
  revision: number;
  type: string;
  sql: string;
  bindings?: unknown[];
  after?: D1PreparedStatement[];
  data?: Record<string, unknown>;
  event?: EventRecord;
  allow_archived?: boolean;
  authorizations?: RequestAuthorization[];
}

export function eventFor(c: AppContext, type: string, id: string, revision: number, repo?: Repository, data: Record<string, unknown> = {}): EventRecord {
  return makeEvent({ type, resource_id: id, resource_revision: revision, actor_id: requirePrincipal(c).id,
    repo_id: repo?.id, account_id: repo?.owner_id, data });
}

/** Core mutate prepares one guarded batch and defers that exact batch for brief metadata fences. */
export async function commit(c: AppContext, change: Change): Promise<void> {
  const db = database(c);
  const event = change.event ?? eventFor(c, change.type, change.resource_id, change.revision, change.repo, change.data);
  if (change.repo_id !== undefined) event.repo_id = change.repo_id;
  if (change.account_id !== undefined) event.account_id = change.account_id;
  const after = [...(change.after ?? [])];
  for (const reference of referenceFences.get(c)?.values() ?? []) {
    if (reference.identity && separateIdentityAuthority(c)) {
      await requireCurrentUserReference(c, reference.id);
      continue; // The captured identity-account epoch is guarded by core mutate.
    }
    const guard = newId('guard');
    after.push(stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN EXISTS (SELECT 1 FROM ${reference.table}
      WHERE id=? AND ${reference.active_column} IS NULL${reference.repo_id ? ' AND repo_id=?' : ''}${reference.revision === undefined ? '' : ' AND revision=?'}) THEN 1 ELSE 0 END`,
    guard, reference.id, ...(reference.repo_id ? [reference.repo_id] : []), ...(reference.revision === undefined ? [] : [reference.revision])),
    stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard));
  }
  if (change.repo) {
    const guard = newId('guard');
    after.push(stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN EXISTS (
      SELECT 1 FROM repositories WHERE id=? AND revision=? AND policy_revision=? AND routing_epoch=?
      AND state IN (${change.allow_archived ? "'active','archived'" : "'active'"})) THEN 1 ELSE 0 END`,
    guard, change.repo.id, change.repo.revision, change.repo.policy_revision, change.repo.routing_epoch));
    after.push(stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard));
  }
  if (change.item) {
    const principal = requirePrincipal(c);
    after.push(stmt(db, `INSERT INTO collaboration_history
      (id,repo_id,item_id,resource_id,resource_revision,event_type,actor_id,data_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    event.id, change.item.repo_id, change.item.id, change.resource_id, change.revision, change.type,
    principal.id, JSON.stringify(event.data), event.occurred_at));
    after.push(stmt(db, `INSERT INTO collaboration_activity
      (id,repo_id,item_id,event_type,actor_id,actor_kind,resource_id,resource_revision,group_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    event.id, change.item.repo_id, change.item.id, change.type, principal.id, principal.kind, change.resource_id, change.revision,
    `${change.item.repo_id}:${change.item.id}:${principal.id}:${event.occurred_at.slice(0, 10)}`, event.occurred_at));
    after.push(stmt(db, `INSERT INTO collaboration_search_watermarks(repo_id,revision,updated_at) VALUES (?,1,?)
      ON CONFLICT(repo_id) DO UPDATE SET revision=revision+1,updated_at=excluded.updated_at`, change.item.repo_id, event.occurred_at));
  }
  await mutate(c, { sql: change.sql, bindings: change.bindings, event, after, authorizations: change.authorizations,
    audit: { action: event.type, resource_id: event.resource_id,
      details: { ...event.data, ...(change.item ? { item_id: change.item.id, item_kind: change.item.kind } : {}) } } });
  referenceFences.delete(c);
}

export async function documentStatement(db: Database, value: {
  repo_id: string; resource_kind: string; resource_id: string; document_revision: number;
  markdown: string; title?: string | null; actor_id: string; restored_from?: number;
}): Promise<D1PreparedStatement> {
  return stmt(db, `INSERT INTO collaboration_document_versions
    (id,repo_id,resource_kind,resource_id,document_revision,title,markdown,sha256,actor_id,restored_from,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, newId('docv'), value.repo_id, value.resource_kind, value.resource_id,
  value.document_revision, value.title ?? null, value.markdown, await sha256(value.markdown), value.actor_id,
  value.restored_from ?? null, now());
}

export function itemInsert(item: Item): { sql: string; bindings: unknown[] } {
  return {
    sql: `INSERT INTO collaboration_items(id,repo_id,kind,number,title,markdown,author_id,state,revision,document_revision,created_at,updated_at)
      SELECT ?,?,?,COALESCE(MAX(number),0)+1,?,?,?,?,1,1,?,? FROM collaboration_items WHERE repo_id=? AND kind=?`,
    bindings: [item.id, item.repo_id, item.kind, item.title, item.markdown, item.author_id, item.state,
      item.created_at, item.updated_at, item.repo_id, item.kind],
  };
}
export function newItem(c: AppContext, repoId: string, kind: ItemKind, data: { title: string; markdown: string; state: string }): Item {
  const created = now();
  const prefix: Record<ItemKind, string> = { issue: 'iss', pull_request: 'pr', discussion: 'disc', task: 'task' };
  return { id: newId(prefix[kind]), repo_id: repoId, kind, number: 0, ...data,
    author_id: requirePrincipal(c).id, revision: 1, document_revision: 1, locked_at: null, locked_by: null,
    deleted_at: null, created_at: created, updated_at: created };
}

export async function createItem(c: AppContext, repo: Repository, item: Item, after: D1PreparedStatement[], data: Record<string, unknown> = {}, eventOverride?: EventRecord): Promise<Item> {
  const event = eventOverride ?? eventFor(c, `${item.kind}.created`, item.id, 1, repo, { item_id: item.id, kind: item.kind, ...data });
  after.push(await documentStatement(database(c), { ...item, resource_kind: item.kind, resource_id: item.id, actor_id: item.author_id }));
  after.push(...await mentionStatements(c, item, item.id, 1, item.markdown, event.id));
  await commit(c, { repo, item, resource_id: item.id, revision: 1, type: event.type, event, ...itemInsert(item), after });
  return (await getItem(c, item.kind, item.id, 'contents.read', item.repo_id)).item;
}

const itemFields = new Set(['title', 'markdown', 'state', 'locked_at', 'locked_by', 'deleted_at']);
export async function updateItem(c: AppContext, repo: Repository, item: Item, type: string,
  fields: Record<string, string | null>, after: D1PreparedStatement[] = [], data: Record<string, unknown> = {}, restoredFrom?: number, eventOverride?: EventRecord): Promise<Item> {
  checkRevision(c, item);
  const keys = Object.keys(fields);
  if (keys.some(key => !itemFields.has(key))) throw new TypeError('Invalid collaboration item field.');
  const edited = Object.hasOwn(fields, 'markdown') || Object.hasOwn(fields, 'title');
  const updated = { ...item, ...fields, revision: item.revision + 1,
    document_revision: item.document_revision + Number(edited), updated_at: now() } as Item;
  const event = eventOverride ?? eventFor(c, type, item.id, updated.revision, repo, { item_id: item.id, kind: item.kind, ...data });
  if (edited) {
    after.push(await documentStatement(database(c), { ...updated, resource_kind: item.kind, resource_id: item.id,
      actor_id: requirePrincipal(c).id, restored_from: restoredFrom }));
    after.push(...await mentionStatements(c, updated, item.id, updated.document_revision, updated.markdown, event.id));
  }
  await commit(c, { repo, item, resource_id: item.id, revision: updated.revision, type, event,
    sql: `UPDATE collaboration_items SET ${keys.map(key => `${key}=?`).join(',')}${keys.length ? ',' : ''}
      revision=revision+1,document_revision=document_revision+?,updated_at=? WHERE repo_id=? AND id=? AND revision=? AND deleted_at IS NULL`,
    bindings: [...keys.map(key => fields[key]), Number(edited), updated.updated_at, repo.id, item.id, item.revision], after });
  return updated;
}

export function itemTouch(db: Database, item: Item, timestampValue = now()): D1PreparedStatement {
  return stmt(db, 'UPDATE collaboration_items SET revision=revision+1,updated_at=? WHERE repo_id=? AND id=? AND deleted_at IS NULL',
    timestampValue, item.repo_id, item.id);
}
export function itemFence(db: Database, item: Item): D1PreparedStatement[] {
  const guard = newId('guard');
  return [stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN EXISTS (
    SELECT 1 FROM collaboration_items WHERE repo_id=? AND id=? AND revision=? AND deleted_at IS ?) THEN 1 ELSE 0 END`,
  guard, item.repo_id, item.id, item.revision, item.deleted_at), stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard)];
}

const cursorSchema = z.strictObject({ scope: z.string(), at: z.string(), id: z.string(), as_of: z.string() });
export interface Pagination { limit: number; scope: string; at: string; id: string; as_of: string }
export function pagination(c: AppContext, scope: string): Pagination {
  const { limit, cursor } = page(c);
  const asOf = now();
  const parsed = cursorSchema.safeParse(decodeCursor(cursor, { scope, at: asOf, id: '\uffff', as_of: asOf }));
  if (!parsed.success || parsed.data.scope !== scope || !Number.isFinite(Date.parse(parsed.data.at))
    || !Number.isFinite(Date.parse(parsed.data.as_of))) throw new ApiError(422, 'invalid_cursor', 'This cursor does not belong to this query.');
  return { ...parsed.data, limit };
}
export function nextCursor(p: Pagination, row: { id: string; created_at: string } | undefined): string | null {
  return row ? encodeCursor({ scope: p.scope, at: row.created_at, id: row.id, as_of: p.as_of }) : null;
}
export function pagedResponse<T extends { id: string; created_at: string }>(c: AppContext, rows: T[], p: Pagination): Response {
  return listResponse(c, rows.slice(0, p.limit), rows.length > p.limit ? nextCursor(p, rows[p.limit - 1]) : null);
}
export function pageSql(alias = ''): string {
  const prefix = alias ? `${alias}.` : '';
  return `${prefix}created_at<=? AND (${prefix}created_at<? OR (${prefix}created_at=? AND ${prefix}id<?))`;
}
export function pageBindings(p: Pagination): unknown[] { return [p.as_of, p.at, p.at, p.id, p.limit + 1]; }

export async function listItems(c: AppContext, kind: ItemKind): Promise<Response> {
  const repo = await getRepository(c, c.req.param('repoId') ?? '');
  const filters = z.strictObject({ state: z.string().max(30).optional(), author: identifier.optional(),
    label: identifier.optional(), assignee: identifier.optional(), milestone: identifier.optional(), q: z.string().max(200).optional() })
    .safeParse(Object.fromEntries(['state', 'author', 'label', 'assignee', 'milestone', 'q']
      .flatMap(key => c.req.query(key) === undefined ? [] : [[key, c.req.query(key)]])));
  if (!filters.success) throw new ApiError(422, 'invalid_filter', 'One or more filters are invalid.');
  const f = filters.data;
  const p = pagination(c, `${repo.id}:${kind}:${JSON.stringify(f)}`);
  const where = ['i.repo_id=?', 'i.kind=?', 'i.deleted_at IS NULL'];
  const values: unknown[] = [repo.id, kind];
  if (f.state) { where.push('i.state=?'); values.push(f.state); }
  if (f.author) { await assertUser(c, f.author); where.push('i.author_id=?'); values.push(f.author); }
  if (f.label) {
    await related(c, 'labels', repo.id, f.label);
    where.push('EXISTS (SELECT 1 FROM collaboration_item_labels l WHERE l.repo_id=i.repo_id AND l.item_id=i.id AND l.label_id=?)'); values.push(f.label);
  }
  if (f.assignee) {
    await assertUser(c, f.assignee);
    where.push('EXISTS (SELECT 1 FROM issue_assignees a WHERE a.repo_id=i.repo_id AND a.issue_id=i.id AND a.user_id=?)'); values.push(f.assignee);
  }
  if (f.milestone) {
    await related(c, 'milestones', repo.id, f.milestone);
    where.push(`EXISTS (SELECT 1 FROM ${kind === 'pull_request' ? 'pull_requests' : 'issues'} m WHERE m.repo_id=i.repo_id AND m.id=i.id AND m.milestone_id=?)`);
    values.push(f.milestone);
  }
  if (f.q) { where.push("(i.title LIKE ? ESCAPE '\\' OR i.markdown LIKE ? ESCAPE '\\')"); const like = `%${f.q.replace(/[\\%_]/g, '\\$&')}%`; values.push(like, like); }
  const rows = await many<Item>(database(c), `SELECT i.* FROM collaboration_items i WHERE ${where.join(' AND ')}
    AND ${pageSql('i')} ORDER BY i.created_at DESC,i.id DESC LIMIT ?`, ...values, ...pageBindings(p));
  const candidates = rows.slice(0, p.limit);
  const items: Item[] = [];
  for (const item of candidates) if (await canReadItem(c, repo.id, item.id)) items.push(item);
  return listResponse(c, items, rows.length > p.limit ? nextCursor(p, candidates.at(-1)) : null);
}

export function inboxStatement(db: Database, value: {
  user_id: string; item: Item; reason: 'mention' | 'assignment' | 'review_request' | 'task_accountability'; source_id: string; event_id: string;
}): D1PreparedStatement {
  const at = now();
  return stmt(db, `INSERT INTO collaboration_inbox(id,user_id,repo_id,item_id,reason,source_id,source_event_id,state,revision,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'outstanding',1,?,?) ON CONFLICT(user_id,repo_id,item_id,reason,source_id)
    DO UPDATE SET source_event_id=excluded.source_event_id,state='outstanding',read_at=NULL,completed_at=NULL,
    snoozed_until=NULL,revision=revision+1,updated_at=excluded.updated_at`, newId('inbox'), value.user_id,
  value.item.repo_id, value.item.id, value.reason, value.source_id, value.event_id, at, at);
}
export function completeInbox(db: Database, item: Item, reason?: string, sourceId?: string, userId?: string): D1PreparedStatement {
  return stmt(db, `UPDATE collaboration_inbox SET state='completed',completed_at=?,revision=revision+1,updated_at=?
    WHERE repo_id=? AND item_id=? AND state='outstanding'${reason ? ' AND reason=?' : ''}${sourceId ? ' AND source_id=?' : ''}${userId ? ' AND user_id=?' : ''}`,
  now(), now(), item.repo_id, item.id, ...(reason ? [reason] : []), ...(sourceId ? [sourceId] : []), ...(userId ? [userId] : []));
}
export async function mentionStatements(c: AppContext, item: Item, resourceId: string, revision: number, text: string, eventId: string): Promise<D1PreparedStatement[]> {
  // Mentions in code are literal source; a mention never grants repository access.
  const prose = text.replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2[^\n]*(?=\n|$)/g, '\n').replace(/`+[^`]*`+/g, '');
  const usernames = [...new Set([...prose.matchAll(/(?:^|[^\w@])@([a-zA-Z0-9][a-zA-Z0-9_-]{0,38})\b/g)].map(match => match[1]!.toLowerCase()))];
  if (usernames.length > 50) throw new ApiError(422, 'too_many_mentions', 'A document may mention at most 50 users.');
  const db = database(c);
  const users = usernames.length ? await many<{ id: string }>(identityDatabase(c), `SELECT id FROM users WHERE lower(username) IN (${usernames.map(() => '?').join(',')}) AND disabled_at IS NULL`, ...usernames) : [];
  for (const user of users) await assertUser(c, user.id);
  const after = [stmt(db, `UPDATE collaboration_inbox SET state='completed',completed_at=?,updated_at=?,revision=revision+1
    WHERE repo_id=? AND item_id=? AND source_id=? AND reason='mention' AND state='outstanding'
    ${users.length ? `AND user_id NOT IN (${users.map(() => '?').join(',')})` : ''}`, now(), now(), item.repo_id, item.id, resourceId, ...users.map(user => user.id))];
  return [...after, ...users.flatMap(user => [
    stmt(db, `INSERT INTO collaboration_mentions(repo_id,resource_id,document_revision,user_id,created_at) VALUES (?,?,?,?,?)`, item.repo_id, resourceId, revision, user.id, now()),
    ...(user.id === requirePrincipal(c).user_id ? [] : [inboxStatement(db, { user_id: user.id, item, reason: 'mention', source_id: resourceId, event_id: eventId })]),
  ])];
}

export async function ensureCanModerate(c: AppContext, item: Item): Promise<void> {
  await authorize(c, manageCapability[item.kind], { repo_id: item.repo_id });
}

export async function ensureCanEditDocument(c: AppContext, item: Item): Promise<void> {
  if (item.author_id !== requirePrincipal(c).id) await ensureCanModerate(c, item);
}

export async function canReadEventReferences(c: AppContext, repoId: string, data: Record<string, unknown>): Promise<boolean> {
  try {
    for (const key of ['workspace_repo_id', 'head_repo_id', 'source_repo_id']) {
      if (typeof data[key] === 'string') await getRepository(c, data[key], key === 'workspace_repo_id' ? 'repositories.read' : 'contents.read');
    }
    const ids = ['pull_id', 'issue_id', 'discussion_id', 'task_id', 'duplicate_of_id', 'depends_on_id']
      .flatMap(key => typeof data[key] === 'string' ? [data[key]] : []);
    if (Array.isArray(data.affected_pull_ids)) ids.push(...data.affected_pull_ids.filter((id): id is string => typeof id === 'string'));
    for (const id of new Set(ids)) await getItem(c, undefined, id, 'contents.read', repoId);
    return true;
  } catch (error) {
    if (error instanceof ApiError && [401, 403, 404, 410].includes(error.status)) return false;
    throw error;
  }
}

export async function assertAcyclic(c: AppContext, type: 'issue' | 'pull', repoId: string, from: string, to: string): Promise<void> {
  if (from === to) conflict('dependency_cycle', 'A change cannot depend on itself.');
  const table = type === 'issue' ? 'issue_dependencies' : 'pull_dependencies';
  const column = type === 'issue' ? 'issue_id' : 'pull_id';
  const cycle = await one(database(c), `WITH RECURSIVE ancestors(id) AS (
    SELECT ? UNION SELECT d.depends_on_id FROM ${table} d JOIN ancestors a ON d.${column}=a.id WHERE d.repo_id=?
    ) SELECT id FROM ancestors WHERE id=? LIMIT 1`, to, repoId, from);
  if (cycle) conflict('dependency_cycle', 'This dependency would create a cycle.');
}

/** Repeat the graph check inside the transaction to handle opposite concurrent edges. */
export function dependencyFence(db: Database, type: 'issue' | 'pull', repoId: string, from: string, to: string): D1PreparedStatement[] {
  const table = type === 'issue' ? 'issue_dependencies' : 'pull_dependencies';
  const column = type === 'issue' ? 'issue_id' : 'pull_id';
  const guard = newId('guard');
  return [stmt(db, `WITH RECURSIVE ancestors(id) AS (SELECT ? UNION
    SELECT d.depends_on_id FROM ${table} d JOIN ancestors a ON d.${column}=a.id WHERE d.repo_id=?)
    INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM ancestors WHERE id=?) THEN 0 ELSE 1 END`,
  to, repoId, guard, from), stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard)];
}
