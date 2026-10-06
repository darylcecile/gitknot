import { ApiError, cellDatabase, identityBinding, many, one, readBounded, resolveRepositoryPlacement, verifyInternalRequest } from '@gitknot/core';
import type { App, Bindings, Database, Repository } from '@gitknot/core';
import { routingBindings, validPlacementId } from '../../../../../packages/core/src/routing/cells.ts';
import { assertRepositoryPlacement } from '../../../../../packages/core/src/routing/repositories.ts';
import { candidateSchema, globalReadPath, globalReadScope, globalWindowSize, mergeWindows, privateReadSchema } from './global-read-schema.ts';
import type { GlobalCandidate, GlobalReference, PrivateRead, ReferenceReply, ReferenceRequest, WindowRequest, WindowResponse } from './global-read-schema.ts';
import type { Comment, Item } from './common.ts';
import type { InboxItem } from './personal.ts';

type LocatedRead = Extract<PrivateRead, { repo_id: string }>;
interface SourcePosition { repo_id: string; cell_id: string; shard_id: string; epoch: number }
interface Activity { id: string; repo_id: string; item_id: string; event_type: string; actor_id: string; actor_kind: string;
  resource_id: string; resource_revision: number; group_key: string; created_at: string; group_count: number }
interface Indexed { id: string; kind: string; revision: number; policy_revision: number; indexed_at: string }
type ReadComment = Pick<Comment, 'id' | 'repo_id' | 'item_id' | 'state' | 'author_id' | 'markdown' | 'revision' | 'updated_at'>;
const itemMetadata = "id,repo_id,kind,number,title,'' AS markdown,author_id,state,revision,document_revision,locked_at,locked_by,deleted_at,created_at,updated_at";

/** Enumerate operator-declared locations, never arbitrary bindings or JS object identity. */
export function collaborationShards(env: Bindings): string[] {
  const values = new Set([env.SHARD_ID, ...Object.keys(routingBindings(env.SHARD_BINDINGS_JSON))]);
  if (typeof env.ROOT_SHARD_ID === 'string' && (env.ROOT_CELL_ID ?? env.CELL_ID) === env.CELL_ID) values.add(env.ROOT_SHARD_ID);
  if (values.size > 66 || [...values].some(id => !validPlacementId(id))) throw new ApiError(503, 'collaboration_topology_unavailable', 'The collaboration placement registry is invalid.');
  return [...values].sort();
}

function sourcePredicate(input: WindowRequest, alias: string): { sql: string; values: unknown[] } {
  const where = [`${alias}.created_at<=?`], values: unknown[] = [input.as_of];
  if (input.after) {
    if (input.surface === 'search') { where.push(`${alias}.id>?`); values.push(input.after.id); }
    else { where.push(`(${alias}.created_at<? OR (${alias}.created_at=? AND ${alias}.id<?))`); values.push(input.after.at, input.after.at, input.after.id); }
  }
  if (input.filters.repo_ids.length) { where.push(`${alias}.repo_id IN (SELECT value FROM json_each(?))`); values.push(JSON.stringify(input.filters.repo_ids)); }
  else where.push("r.visibility<>'unlisted'");
  if (input.filters.kind) { where.push('i.kind=?'); values.push(input.filters.kind); }
  if (input.filters.state && input.surface !== 'inbox') { where.push('i.state=?'); values.push(input.filters.state); }
  if (input.filters.public_only) where.push("r.visibility='public'");
  return { sql: where.join(' AND '), values };
}

async function shardWindow(env: Bindings, shard: string, input: WindowRequest): Promise<GlobalCandidate[]> {
  const db = cellDatabase(env, shard).withSession('first-primary');
  const { filters } = input;
  if (input.surface === 'search') {
    const where = ['s.created_at<=?', 'r.cell_id=?', 'r.shard_id=?', "r.state<>'deleted'"], values: unknown[] = [input.as_of, env.CELL_ID, shard];
    if (input.after) { where.push('s.id>?'); values.push(input.after.id); }
    if (filters.repo_ids.length) { where.push('s.repo_id IN (SELECT value FROM json_each(?))'); values.push(JSON.stringify(filters.repo_ids)); }
    else where.push("r.visibility<>'unlisted'");
    if (filters.kind) { where.push('s.kind=?'); values.push(filters.kind); }
    if (filters.state) { where.push('s.state=?'); values.push(filters.state); }
    return many(db, `WITH sources AS (
      SELECT id,repo_id,id AS item_id,id AS resource_id,kind,state,revision,created_at FROM collaboration_items WHERE deleted_at IS NULL
      UNION ALL SELECT c.id,c.repo_id,c.item_id,c.id,'comment',i.state,c.revision,c.created_at FROM collaboration_comments c
        JOIN collaboration_items i ON i.repo_id=c.repo_id AND i.id=c.item_id WHERE c.state='visible' AND i.deleted_at IS NULL
      ) SELECT s.id,s.repo_id,s.item_id,s.resource_id,s.kind,s.revision,s.created_at,p.head_repo_id,NULL AS workspace_repo_id
        FROM sources s JOIN repositories r ON r.id=s.repo_id LEFT JOIN pull_requests p ON p.repo_id=s.repo_id AND p.id=s.item_id
        WHERE ${where.join(' AND ')} ORDER BY s.id LIMIT ?`, ...values, globalWindowSize + 1);
  }
  const alias = input.surface === 'inbox' ? 'n' : 'a';
  const predicate = sourcePredicate(input, alias);
  const where = [predicate.sql, 'r.cell_id=?', 'r.shard_id=?', "r.state<>'deleted'", 'i.deleted_at IS NULL'];
  const values = [...predicate.values, env.CELL_ID, shard];
  if (input.surface === 'inbox') {
    if (!filters.user_id) throw new ApiError(400, 'invalid_collaboration_read', 'Inbox discovery requires its recipient.');
    where.push('n.user_id=?'); values.push(filters.user_id);
  } else {
    if (filters.actor_id) { where.push('a.actor_id=?'); values.push(filters.actor_id); }
    if (filters.grouped) {
      where.push(`(a.actor_kind='user' OR a.id=(SELECT last.id FROM collaboration_activity last
        WHERE last.group_key=a.group_key AND last.created_at<=? ORDER BY last.created_at DESC,last.id DESC LIMIT 1))`);
      values.push(input.as_of);
    }
  }
  const table = input.surface === 'inbox' ? 'collaboration_inbox n' : 'collaboration_activity a';
  const resource = input.surface === 'inbox' ? 'n.source_id' : 'a.resource_id';
  return many(db, `SELECT ${alias}.id,${alias}.repo_id,${alias}.item_id,${resource} AS resource_id,i.kind,
      ${input.surface === 'inbox' ? 'n.revision' : 'a.resource_revision'} AS revision,${alias}.created_at,p.head_repo_id,w.workspace_repo_id
    FROM ${table} JOIN collaboration_items i ON i.repo_id=${alias}.repo_id AND i.id=${alias}.item_id
      JOIN repositories r ON r.id=i.repo_id LEFT JOIN pull_requests p ON p.repo_id=i.repo_id AND p.id=i.id
      LEFT JOIN task_workspaces w ON w.repo_id=i.repo_id AND w.task_id=i.id AND w.id=${resource}
    WHERE ${where.join(' AND ')} ORDER BY ${alias}.created_at DESC,${alias}.id DESC LIMIT ?`, ...values, globalWindowSize + 1);
}

async function cellWindow(env: Bindings, input: WindowRequest): Promise<WindowResponse> {
  const shards = collaborationShards(env);
  let candidates: GlobalCandidate[] = [];
  let more = false;
  // Four concurrent shard reads and a 51-key merge buffer bound memory and fanout.
  for (let start = 0; start < shards.length; start += 4) {
    const batches = await Promise.all(shards.slice(start, start + 4).map(shard => shardWindow(env, shard, input)));
    for (const batch of batches) {
      const parsed = candidateSchema.array().max(globalWindowSize + 1).parse(batch);
      candidates = mergeWindows([candidates, parsed], input.surface);
      more ||= parsed.length > globalWindowSize || candidates.length > globalWindowSize;
    }
  }
  return { version: 1, cell_id: env.CELL_ID, shards, candidates, more };
}

async function locatedDatabase(env: Bindings, input: SourcePosition): Promise<{ db: Database; repo: Repository }> {
  if (!collaborationShards(env).includes(input.shard_id)) throw new ApiError(503, 'collaboration_shard_unavailable', 'The source shard is not configured.');
  const placement = await resolveRepositoryPlacement(env, input.repo_id);
  if (!placement || placement.cell_id !== env.CELL_ID || placement.cell_id !== input.cell_id
    || placement.shard_id !== input.shard_id || placement.epoch !== input.epoch) {
    throw new ApiError(409, 'collaboration_placement_changed', 'The collaboration source moved.');
  }
  const db = cellDatabase(env, input.shard_id).withSession('first-primary');
  const repo = await one<Repository>(db, 'SELECT * FROM repositories WHERE id=?', input.repo_id);
  assertRepositoryPlacement(repo, placement);
  if (!repo) throw new ApiError(503, 'collaboration_source_unavailable', 'The current collaboration authority is unavailable.');
  return { db, repo };
}

async function referenceAudience(db: Database, item: Pick<Item, 'id' | 'repo_id' | 'kind'>, resourceId: string): Promise<{ head_repo_id: string | null; workspace_repo_id: string | null }> {
  const pull = item.kind === 'pull_request' ? await one<{ head_repo_id: string }>(db, 'SELECT head_repo_id FROM pull_requests WHERE repo_id=? AND id=?', item.repo_id, item.id) : null;
  const workspace = await one<{ workspace_repo_id: string }>(db, 'SELECT workspace_repo_id FROM task_workspaces WHERE repo_id=? AND task_id=? AND id=?', item.repo_id, item.id, resourceId);
  return { head_repo_id: pull?.head_repo_id ?? null, workspace_repo_id: workspace?.workspace_repo_id ?? null };
}

async function outstanding(env: Bindings, db: Database, value: InboxItem, item: Item): Promise<boolean> {
  if (value.reason === 'assignment') return item.state === 'open' && !!await one(db,
    'SELECT 1 FROM issue_assignees WHERE repo_id=? AND issue_id=? AND user_id=?', item.repo_id, item.id, value.user_id);
  if (value.reason === 'task_accountability') return item.state === 'active' && !!await one(db,
    'SELECT 1 FROM tasks WHERE repo_id=? AND id=? AND accountable_user_id=?', item.repo_id, item.id, value.user_id);
  if (value.reason === 'review_request') {
    const requested = ['open', 'draft'].includes(item.state) ? await one<{ reviewer_id: string }>(db,
      "SELECT reviewer_id FROM pull_review_requests WHERE repo_id=? AND pull_id=? AND id=? AND state='requested'", item.repo_id, item.id, value.source_id) : null;
    return !!requested && !!await one(identityBinding(env), 'SELECT 1 FROM principals WHERE id=? AND user_id=? AND disabled_at IS NULL', requested.reviewer_id, value.user_id);
  }
  return !!await one(db, `SELECT 1 FROM collaboration_mentions m WHERE m.repo_id=? AND m.resource_id=? AND m.user_id=?
    AND m.document_revision=(SELECT MAX(document_revision) FROM collaboration_document_versions WHERE repo_id=m.repo_id AND resource_id=m.resource_id)`,
  item.repo_id, value.source_id, value.user_id);
}

function searchText(title: string, markdown: string, terms: string[]): NonNullable<GlobalReference['search']> {
  const body = markdown.toLowerCase(), text = `${title.toLowerCase()}\n${body}`;
  const first = terms.length ? body.indexOf(terms[0]!.toLowerCase()) : 0;
  const offset = Math.max(0, first - 80);
  return { matches: terms.every(term => text.includes(term.toLowerCase())), snippet: markdown.slice(offset, offset + 500),
    snippet_offset: offset, snippet_truncated: offset > 0 || markdown.length > offset + 500,
    examined_bytes: new TextEncoder().encode(title + markdown).byteLength };
}

async function indexRecord(env: Bindings, repoId: string, id: string): Promise<{ index_available: boolean; index: Indexed | null }> {
  if (!env.SEARCH_DB) return { index_available: false, index: null };
  try {
    return { index_available: true, index: await one<Indexed>(env.SEARCH_DB.withSession('first-primary'),
      'SELECT id,kind,revision,policy_revision,indexed_at FROM search_documents WHERE repo_id=? AND id=? AND deleted=0', repoId, id) };
  } catch {
    // Canonical source search remains usable; index coverage is explicitly unknown.
    return { index_available: false, index: null };
  }
}

async function readReference(env: Bindings, input: ReferenceRequest): Promise<ReferenceReply> {
  const { db, repo } = await locatedDatabase(env, input);
  const candidate = input.candidate;
  if (candidate.repo_id !== input.repo_id) throw new ApiError(400, 'invalid_collaboration_read', 'The reference is outside this repository.');
  const matching = input.surface === 'search' && input.terms.length > 0;
  const item = await one<Item>(db, `SELECT ${input.include_markdown || matching ? '*' : itemMetadata}
    FROM collaboration_items WHERE repo_id=? AND id=? AND deleted_at IS NULL`, repo.id, candidate.item_id);
  if (!item) return null;
  const audience = await referenceAudience(db, item, candidate.resource_id);
  const comment = candidate.resource_id !== item.id ? await one<ReadComment>(db,
    `SELECT id,repo_id,item_id,state,author_id,${matching ? 'markdown' : "'' AS markdown"},revision,updated_at
      FROM collaboration_comments WHERE repo_id=? AND item_id=? AND id=?`, repo.id, item.id, candidate.resource_id) : null;
  const activity = input.surface === 'feed' ? await one<Activity>(db, `SELECT a.*,CASE WHEN actor_kind='user' THEN 1 ELSE
      (SELECT COUNT(*) FROM collaboration_activity g WHERE g.group_key=a.group_key AND g.created_at<=a.created_at) END AS group_count
    FROM collaboration_activity a WHERE repo_id=? AND item_id=? AND id=? AND resource_id=?`, repo.id, item.id, candidate.id, candidate.resource_id) : null;
  const notification = input.surface === 'inbox' && input.user_id ? await one<InboxItem>(db,
    'SELECT * FROM collaboration_inbox WHERE repo_id=? AND item_id=? AND id=? AND user_id=?', repo.id, item.id, candidate.id, input.user_id) : null;
  if (input.surface === 'feed' && !activity || input.surface === 'inbox' && !notification) return null;
  if (input.surface === 'search' && candidate.kind === 'comment' && comment?.state !== 'visible') return null;
  const sourceRevision = input.surface === 'search' ? comment?.revision ?? item.revision : notification?.revision ?? activity!.resource_revision;
  if (sourceRevision !== candidate.revision || audience.head_repo_id !== candidate.head_repo_id || audience.workspace_repo_id !== candidate.workspace_repo_id) {
    return { changed: true, candidate: { ...candidate, revision: sourceRevision, ...audience } };
  }
  const sourceUpdatedAt = input.surface === 'search' ? comment?.updated_at ?? item.updated_at : notification?.updated_at ?? activity!.created_at;
  const result: GlobalReference = { version: 1, repo_id: repo.id, cell_id: env.CELL_ID, shard_id: input.shard_id, epoch: input.epoch,
    repository_revision: repo.revision, policy_revision: repo.policy_revision,
    item: { ...item, markdown: input.include_markdown ? item.markdown : '' }, ...audience,
    source_revision: sourceRevision, source_updated_at: sourceUpdatedAt,
    comment: comment ? { state: comment.state, author_id: comment.author_id } : null,
    activity, notification, action_outstanding: notification ? await outstanding(env, db, notification, item) : null,
    search: input.surface === 'search' ? matching ? searchText(item.title, comment?.markdown ?? item.markdown, input.terms)
      : { matches: true, snippet: '', snippet_offset: 0, snippet_truncated: false, examined_bytes: 0 } : null,
    ...(input.surface === 'search' ? await indexRecord(env, repo.id, candidate.id) : { index_available: false, index: null }),
  };
  const current = await locatedDatabase(env, input);
  if (current.repo.revision !== repo.revision) throw new ApiError(409, 'collaboration_reference_changed', 'The repository policy changed while reading.');
  return result;
}

async function locateInbox(env: Bindings, userId: string, id: string): Promise<GlobalCandidate[]> {
  const found: GlobalCandidate[] = [];
  for (const shard of collaborationShards(env)) {
    const db = cellDatabase(env, shard).withSession('first-primary');
    const rows = await many<GlobalCandidate>(db, `SELECT n.id,n.repo_id,n.item_id,n.source_id AS resource_id,i.kind,n.revision,n.created_at,p.head_repo_id,w.workspace_repo_id
      FROM collaboration_inbox n JOIN collaboration_items i ON i.repo_id=n.repo_id AND i.id=n.item_id
        JOIN repositories r ON r.id=n.repo_id LEFT JOIN pull_requests p ON p.repo_id=i.repo_id AND p.id=i.id
        LEFT JOIN task_workspaces w ON w.repo_id=i.repo_id AND w.task_id=i.id AND w.id=n.source_id
      WHERE n.user_id=? AND n.id=? AND r.cell_id=? AND r.shard_id=? AND r.state<>'deleted' AND i.deleted_at IS NULL`, userId, id, env.CELL_ID, shard);
    found.push(...rows);
  }
  return mergeWindows([found], 'inbox');
}

async function locatedRead(env: Bindings, input: LocatedRead): Promise<unknown> {
  if (input.action === 'reference') return readReference(env, input);
  const { db, repo } = await locatedDatabase(env, input);
  let result: unknown;
  if (input.action === 'coverage-source') {
    const mark = await one<{ revision: number }>(db, 'SELECT revision FROM collaboration_search_watermarks WHERE repo_id=?', repo.id);
    let indexState: { revision: number; policy_revision: number; state: string } | null = null;
    let available = !!env.SEARCH_DB;
    if (env.SEARCH_DB) {
      try { indexState = await one(env.SEARCH_DB.withSession('first-primary'), 'SELECT revision,policy_revision,state FROM search_repository_state WHERE repo_id=?', repo.id); }
      catch { available = false; }
    }
    result = { revision: repo.revision, policy_revision: repo.policy_revision, watermark: mark?.revision ?? 0,
      index_available: available, index_state: indexState };
  } else if (input.action === 'catalog') {
    result = await one(db, `SELECT id,repo_id,revision FROM ${input.table} WHERE repo_id=? AND id=? AND deleted_at IS NULL`, repo.id, input.id);
  } else if (input.action === 'resource') {
    const item = await one<Pick<Item, 'id' | 'repo_id' | 'kind'>>(db, 'SELECT id,repo_id,kind FROM collaboration_items WHERE repo_id=? AND id=? AND deleted_at IS NULL', repo.id, input.item_id);
    result = item ? { ...await referenceAudience(db, item, input.id), comment: await one(db,
      'SELECT state,author_id FROM collaboration_comments WHERE repo_id=? AND item_id=? AND id=?', repo.id, item.id, input.id) } : null;
  } else {
    const item = await one<Pick<Item, 'id' | 'repo_id' | 'kind' | 'revision' | 'created_at'>>(db,
      'SELECT id,repo_id,kind,revision,created_at FROM collaboration_items WHERE repo_id=? AND id=? AND deleted_at IS NULL', repo.id, input.id);
    result = item ? { id: item.id, repo_id: repo.id, item_id: item.id, resource_id: item.id, kind: item.kind,
      revision: item.revision, created_at: item.created_at, ...await referenceAudience(db, item, item.id) } : null;
  }
  const current = await locatedDatabase(env, input);
  if (current.repo.revision !== repo.revision) throw new ApiError(409, 'collaboration_reference_changed', 'The source changed while being read.');
  return result;
}

export async function readLocalCollaboration(env: Bindings, input: PrivateRead): Promise<unknown> {
  if (input.cell_id !== env.CELL_ID) throw new ApiError(409, 'collaboration_placement_changed', 'This request belongs to another cell.');
  if (input.action === 'window') return cellWindow(env, input);
  if (input.action === 'inbox-locate') return locateInbox(env, input.user_id, input.id);
  return locatedRead(env, input);
}

/** Fixed, signed read operations. Neither SQL nor actor authority is accepted from the caller. */
export function registerGlobalReadRoutes(app: App): void {
  app.post(globalReadPath, async c => {
    await verifyInternalRequest(c.req.raw, c.env.INTERNAL_SERVICE_KEY, globalReadScope, { database: c.env.DB.withSession('first-primary') });
    let input: PrivateRead;
    try { input = privateReadSchema.parse(JSON.parse(new TextDecoder().decode(await readBounded(c.req.raw.body, 16 * 1024)))); }
    catch { throw new ApiError(400, 'invalid_collaboration_read', 'The private collaboration read is invalid.'); }
    return c.json({ result: await readLocalCollaboration(c.env, input) });
  });
}
