import { z } from 'zod';
import {
  ApiError, database, getRepository, identityDatabase, jsonBody, listResponse, many, newId, now,
  one, requirePrincipal, route,
} from '@gitknot/core';
import type { App, AppContext, RequestAuthorization } from '@gitknot/core';
import {
  checkRevision, commit, conflict, identifier,
  nextCursor, notFound, pageBindings, pagedResponse, pageSql, pagination, respond,
} from './common.ts';
import { filterColumns, profileVisible, subscriptionColumns, userScope } from './user-state.ts';
import type { UserSavedFilter, UserSubscription } from './user-state.ts';
import { globalCatalogReference, readGlobalItem, repositoryDenied } from './global-read.ts';
export { projectionReferenceVisible } from './global-read.ts';
import { registerFeed } from './personal-feed.ts';
import { registerInbox } from './personal-inbox.ts';
export { readInboxForDelivery } from './personal-inbox.ts';

interface ProfilePreferences { user_id: string; activity_visibility: 'public' | 'followers' | 'private';
  show_follow_graph: number; digest: 'off' | 'daily' | 'weekly'; revision: number; created_at: string; updated_at: string }
interface Follow { id: string; follower_id: string; following_id: string; revision: number; created_at: string }
export interface InboxItem { id: string; user_id: string; repo_id: string; item_id: string;
  reason: 'mention' | 'assignment' | 'review_request' | 'task_accountability'; source_id: string; source_event_id: string;
  state: 'outstanding' | 'completed'; read_at: string | null; completed_at: string | null; snoozed_until: string | null;
  revision: number; created_at: string; updated_at: string }
type Subscription = UserSubscription;

async function personal(c: AppContext, capability: string): Promise<string> {
  return (await userScope(c, capability)).user_id;
}

function personalAdmission(capability: string, resource?: 'subscription' | 'filter') {
  return async (c: AppContext): Promise<RequestAuthorization[]> => {
    const scope = await userScope(c, capability);
    const requirements = [...scope.requirements];
    const input = c.get('input') as { repo_id?: string | null; item_id?: string | null; filters?: z.infer<typeof savedFilterSchema> } | undefined;
    let target: { repo_id: string | null; item_id?: string | null; filter_json?: string } | null = null;
    if (resource && c.req.param('id')) {
      const tables = { subscription: 'collaboration_user_subscriptions', filter: 'collaboration_user_saved_filters' };
      const columns = resource === 'subscription' ? subscriptionColumns : filterColumns;
      target = await one(identityDatabase(c), `SELECT ${columns} FROM ${tables[resource]} WHERE id=? AND user_id=? AND context_account_id=?`,
        c.req.param('id'), scope.user_id, scope.account_id);
      if (!target) notFound();
    }
    const repoId = target?.repo_id ?? input?.repo_id;
    if (repoId) {
      requirements.push({ capability: 'contents.read', scope: { repo_id: repoId } });
      const itemId = target?.item_id ?? input?.item_id;
      if (itemId) await readGlobalItem(c, repoId, itemId);
    }
    const filters = input?.filters ?? (target?.filter_json ? savedFilterSchema.parse(JSON.parse(target.filter_json)) : undefined);
    for (const id of new Set(filters?.repo_ids ?? [])) {
      if (id !== repoId) requirements.push({ capability: 'contents.read', scope: { repo_id: id } });
    }
    return requirements;
  };
}

function validateFuture(value: string | null | undefined, field: string): void {
  if (value && (value <= now() || Date.parse(value) > Date.now() + 90 * 86400_000)) {
    throw new ApiError(422, 'invalid_deadline', `${field} must be within the next 90 days.`);
  }
}

export function registerPersonalRoutes(app: App): void {
  registerFollows(app);
  registerPreferences(app);
  registerFeed(app);
  registerInbox(app);
  registerSubscriptions(app);
  registerSavedFilters(app);
}

function registerFollows(app: App): void {
  for (const direction of ['followers', 'following'] as const) {
    route(app, 'GET', `/v1/users/:id/${direction}`, { summary: `List profile ${direction}`, tags: ['profiles'], public: true }, async c => {
      const userId = c.req.param('id') ?? '';
      await profileVisible(c, userId);
      const prefs = await one<ProfilePreferences>(database(c), 'SELECT * FROM collaboration_profile_preferences WHERE user_id=?', userId);
      if (prefs?.show_follow_graph === 0 && c.get('principal')?.user_id !== userId) notFound();
      const p = pagination(c, `${userId}:${direction}`);
      const column = direction === 'followers' ? 'following_id' : 'follower_id';
      const other = direction === 'followers' ? 'follower_id' : 'following_id';
      const rows = await many<Follow & { username: string; display_name: string; avatar_url: string | null }>(database(c),
        `SELECT f.*,u.username,u.display_name,u.avatar_url FROM user_follows f JOIN users u ON u.id=f.${other}
         WHERE f.${column}=? AND u.disabled_at IS NULL AND (u.profile_visibility='public' OR u.id=?)
         AND ${pageSql('f')} ORDER BY f.created_at DESC,f.id DESC LIMIT ?`, userId, c.get('principal')?.user_id ?? '', ...pageBindings(p));
      return pagedResponse(c, rows, p);
    });
  }
  const schema = z.strictObject({ user_id: identifier });
  route(app, 'POST', '/v1/users/:id/following', { summary: 'Follow a user', tags: ['profiles'], capability: 'users.follow', authorization: personalAdmission('users.follow'), body: schema }, async c => {
    const followerId = await personal(c, 'users.follow');
    if (followerId !== c.req.param('id')) notFound();
    const { user_id } = await jsonBody(c, schema);
    await profileVisible(c, user_id);
    if (user_id === followerId) conflict('self_follow', 'You cannot follow yourself.');
    const id = newId('follow');
    const at = now();
    await commit(c, { resource_id: id, revision: 1, type: 'user.followed',
      sql: 'INSERT INTO user_follows(id,follower_id,following_id,created_at) VALUES (?,?,?,?)',
      bindings: [id, followerId, user_id, at], data: { follower_id: followerId, following_id: user_id } });
    return respond(c, { id, follower_id: followerId, following_id: user_id, revision: 1, created_at: at }, 201);
  });
  route(app, 'DELETE', '/v1/users/:userId/following/:id', { summary: 'Remove your follow relationship', tags: ['profiles'], capability: 'users.follow', authorization: personalAdmission('users.follow') }, async c => {
    const userId = await personal(c, 'users.follow');
    if (userId !== c.req.param('userId')) notFound();
    const value = await one<Follow>(database(c), 'SELECT * FROM user_follows WHERE follower_id=? AND id=?', userId, c.req.param('id'));
    if (!value) notFound();
    checkRevision(c, value);
    await commit(c, { resource_id: value.id, revision: value.revision + 1, type: 'user.unfollowed',
      sql: 'DELETE FROM user_follows WHERE follower_id=? AND id=? AND revision=?', bindings: [userId, value.id, value.revision],
      data: { follower_id: userId, following_id: value.following_id } });
    return respond(c, { id: value.id, revision: value.revision + 1, deleted: true });
  });
}

function registerPreferences(app: App): void {
  const path = '/v1/users/:id/preferences';
  async function read(c: AppContext): Promise<ProfilePreferences> {
    const userId = await personal(c, 'users.profile.write');
    if (userId !== c.req.param('id')) notFound();
    const value = await one<ProfilePreferences>(database(c), 'SELECT * FROM collaboration_profile_preferences WHERE user_id=?', userId);
    return value ?? { user_id: userId, activity_visibility: 'public', show_follow_graph: 1, digest: 'off', revision: 1, created_at: '', updated_at: '' };
  }
  route(app, 'GET', path, { summary: 'Read your activity and notification privacy preferences', tags: ['profiles'], capability: 'users.profile.write' }, async c => respond(c, await read(c)));
  const schema = z.strictObject({ activity_visibility: z.enum(['public', 'followers', 'private']).optional(), show_follow_graph: z.boolean().optional(),
    digest: z.enum(['off', 'daily', 'weekly']).optional() }).refine(value => Object.keys(value).length > 0, 'Supply at least one field.');
  route(app, 'PATCH', path, { summary: 'Set activity privacy and digest preferences', tags: ['profiles'], capability: 'users.profile.write', authorization: personalAdmission('users.profile.write'), body: schema }, async c => {
    const old = await read(c);
    checkRevision(c, old);
    const input = await jsonBody(c, schema);
    const at = now();
    const value = { ...old, ...input, show_follow_graph: input.show_follow_graph === undefined ? old.show_follow_graph : Number(input.show_follow_graph),
      revision: old.revision + 1, created_at: old.created_at || at, updated_at: at };
    await commit(c, { resource_id: old.user_id, revision: value.revision, type: 'user.collaboration_preferences_changed',
      sql: `INSERT INTO collaboration_profile_preferences(user_id,activity_visibility,show_follow_graph,digest,revision,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET activity_visibility=excluded.activity_visibility,
        show_follow_graph=excluded.show_follow_graph,digest=excluded.digest,revision=excluded.revision,updated_at=excluded.updated_at
        WHERE collaboration_profile_preferences.revision=?`,
      bindings: [old.user_id, value.activity_visibility, value.show_follow_graph, value.digest, value.revision, value.created_at, at, old.revision] });
    return respond(c, value);
  });
}

function registerSubscriptions(app: App): void {
  const schema = z.strictObject({ repo_id: identifier, item_id: identifier.nullable().default(null), mode: z.enum(['watching', 'participating', 'ignored']),
    muted_until: z.iso.datetime().nullable().default(null), digest: z.enum(['inherit', 'off', 'daily', 'weekly']).default('inherit') });
  route(app, 'GET', '/v1/subscriptions', { summary: 'List your thread and repository subscriptions', tags: ['inbox'], capability: 'subscriptions.manage' }, async c => {
    const scope = await userScope(c, 'subscriptions.manage');
    const p = pagination(c, `${scope.user_id}:${scope.account_id}:subscriptions`);
    const rows = await many<Subscription>(identityDatabase(c), `SELECT ${subscriptionColumns} FROM collaboration_user_subscriptions
      WHERE user_id=? AND context_account_id=? AND ${pageSql()} ORDER BY created_at DESC,id DESC LIMIT ?`, scope.user_id, scope.account_id, ...pageBindings(p));
    const visible = [];
    for (const row of rows.slice(0, p.limit)) {
      try { await getRepository(c, row.repo_id); if (row.item_id) await readGlobalItem(c, row.repo_id, row.item_id); visible.push(row); }
      catch (error) { if (!repositoryDenied(error)) throw error; }
    }
    return listResponse(c, visible, rows.length > p.limit ? nextCursor(p, rows[p.limit - 1]) : null);
  });
  route(app, 'POST', '/v1/subscriptions', { summary: 'Subscribe to or mute a repository or conversation', tags: ['inbox'], capability: 'subscriptions.manage', authorization: personalAdmission('subscriptions.manage', 'subscription'), body: schema }, async c => {
    const scope = await userScope(c, 'subscriptions.manage');
    const input = await jsonBody(c, schema);
    const repo = await getRepository(c, input.repo_id);
    if (input.item_id) await readGlobalItem(c, repo.id, input.item_id);
    validateFuture(input.muted_until, 'muted_until');
    const id = newId('subscription');
    const at = now();
    await commit(c, { account_id: scope.account_id, resource_id: id, revision: 1, type: 'subscription.created',
      sql: 'INSERT INTO collaboration_user_subscriptions(id,user_id,context_account_id,repository_id,subject_id,mode,muted_until,digest,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      bindings: [id, scope.user_id, scope.account_id, repo.id, input.item_id, input.mode, input.muted_until, input.digest, at, at],
      data: { user_id: scope.user_id, context_account_id: scope.account_id, repository_id: repo.id, item_id: input.item_id, mode: input.mode } });
    return respond(c, { id, user_id: scope.user_id, context_account_id: scope.account_id, ...input, revision: 1, created_at: at, updated_at: at }, 201);
  });
  const patch = z.strictObject({ mode: z.enum(['watching', 'participating', 'ignored']).optional(), muted_until: z.iso.datetime().nullable().optional(),
    digest: z.enum(['inherit', 'off', 'daily', 'weekly']).optional() }).refine(value => Object.keys(value).length > 0, 'Supply at least one field.');
  async function read(c: AppContext): Promise<Subscription> {
    const scope = await userScope(c, 'subscriptions.manage');
    const value = await one<Subscription>(identityDatabase(c), `SELECT ${subscriptionColumns} FROM collaboration_user_subscriptions
      WHERE user_id=? AND context_account_id=? AND id=?`, scope.user_id, scope.account_id, c.req.param('id'));
    if (!value) notFound();
    await getRepository(c, value.repo_id);
    if (value.item_id) await readGlobalItem(c, value.repo_id, value.item_id);
    return value;
  }
  route(app, 'GET', '/v1/subscriptions/:id', { summary: 'Read your subscription', tags: ['inbox'], capability: 'subscriptions.manage' }, async c => respond(c, await read(c)));
  route(app, 'PATCH', '/v1/subscriptions/:id', { summary: 'Change a subscription, mute or digest', tags: ['inbox'], capability: 'subscriptions.manage', authorization: personalAdmission('subscriptions.manage', 'subscription'), body: patch }, async c => {
    const value = await read(c);
    checkRevision(c, value);
    const input = await jsonBody(c, patch);
    validateFuture(input.muted_until, 'muted_until');
    const updated = { ...value, ...input, revision: value.revision + 1, updated_at: now() };
    await getRepository(c, value.repo_id);
    await commit(c, { account_id: value.context_account_id, resource_id: value.id, revision: updated.revision, type: 'subscription.updated',
      sql: 'UPDATE collaboration_user_subscriptions SET mode=?,muted_until=?,digest=?,revision=revision+1,updated_at=? WHERE user_id=? AND context_account_id=? AND id=? AND revision=?',
      bindings: [updated.mode, updated.muted_until, updated.digest, updated.updated_at, value.user_id, value.context_account_id, value.id, value.revision],
      data: { user_id: value.user_id, context_account_id: value.context_account_id, repository_id: value.repo_id } });
    return respond(c, updated);
  });
  route(app, 'DELETE', '/v1/subscriptions/:id', { summary: 'Delete your subscription', tags: ['inbox'], capability: 'subscriptions.manage', authorization: personalAdmission('subscriptions.manage', 'subscription') }, async c => {
    const value = await read(c);
    checkRevision(c, value);
    await getRepository(c, value.repo_id);
    await commit(c, { account_id: value.context_account_id, resource_id: value.id, revision: value.revision + 1, type: 'subscription.deleted',
      sql: 'DELETE FROM collaboration_user_subscriptions WHERE user_id=? AND context_account_id=? AND id=? AND revision=?',
      bindings: [value.user_id, value.context_account_id, value.id, value.revision],
      data: { user_id: value.user_id, context_account_id: value.context_account_id, repository_id: value.repo_id } });
    return respond(c, { id: value.id, revision: value.revision + 1, deleted: true });
  });
}

export const savedFilterSchema = z.strictObject({
  repo_ids: z.array(identifier).max(50).optional(), query: z.string().max(512).optional(), state: z.string().max(30).optional(),
  kind: z.enum(['issue', 'pull_request', 'discussion', 'task', 'comment']).optional(),
  author_id: identifier.optional(), assignee_id: identifier.optional(), label_ids: z.array(identifier).max(50).optional(),
  milestone_id: identifier.optional(), reason: z.enum(['mention', 'assignment', 'review_request', 'task_accountability']).optional(), unread: z.boolean().optional(),
});
type SavedFilter = UserSavedFilter;
export async function filterReferences(c: AppContext, repoId: string | null, filters: z.infer<typeof savedFilterSchema>): Promise<void> {
  const repos = new Set([...(filters.repo_ids ?? []), ...(repoId ? [repoId] : [])]);
  for (const id of repos) await getRepository(c, id);
  for (const id of [filters.author_id, filters.assignee_id].filter((value): value is string => !!value)) {
    if (!await one(identityDatabase(c), 'SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL', id)) notFound();
  }
  if ((filters.label_ids?.length || filters.milestone_id) && !repoId) throw new ApiError(422, 'repository_required', 'Label and milestone filters require a repository scope.');
  for (const id of filters.label_ids ?? []) await globalCatalogReference(c, repoId!, 'labels', id);
  if (filters.milestone_id) await globalCatalogReference(c, repoId!, 'milestones', filters.milestone_id);
}

function registerSavedFilters(app: App): void {
  const schema = z.strictObject({ name: z.string().trim().min(1).max(100), repo_id: identifier.nullable().default(null),
    surface: z.enum(['issues', 'pulls', 'discussions', 'tasks', 'feed', 'inbox', 'search']), filters: savedFilterSchema });
  route(app, 'GET', '/v1/saved-filters', { summary: 'List your authorized saved views', tags: ['search'], capability: 'saved_filters.manage' }, async c => {
    const scope = await userScope(c, 'saved_filters.manage');
    const p = pagination(c, `${scope.user_id}:${scope.account_id}:saved-filters`);
    const rows = await many<SavedFilter>(identityDatabase(c), `SELECT ${filterColumns} FROM collaboration_user_saved_filters
      WHERE user_id=? AND context_account_id=? AND ${pageSql()} ORDER BY created_at DESC,id DESC LIMIT ?`, scope.user_id, scope.account_id, ...pageBindings(p));
    const visible = [];
    for (const { filter_json, ...row } of rows.slice(0, p.limit)) {
      const filters = savedFilterSchema.parse(JSON.parse(filter_json));
      try { await filterReferences(c, row.repo_id, filters); visible.push({ ...row, filters }); }
      catch (error) { if (!repositoryDenied(error)) throw error; }
    }
    return listResponse(c, visible, rows.length > p.limit ? nextCursor(p, rows[p.limit - 1]) : null);
  });
  route(app, 'POST', '/v1/saved-filters', { summary: 'Save a stable, authorized filter', tags: ['search'], capability: 'saved_filters.manage', authorization: personalAdmission('saved_filters.manage', 'filter'), body: schema }, async c => {
    const scope = await userScope(c, 'saved_filters.manage');
    const input = await jsonBody(c, schema);
    await filterReferences(c, input.repo_id, input.filters);
    const id = newId('filter');
    const at = now();
    await commit(c, { account_id: scope.account_id, resource_id: id, revision: 1, type: 'saved_filter.created',
      sql: 'INSERT INTO collaboration_user_saved_filters(id,user_id,context_account_id,repository_id,name,surface,filter_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      bindings: [id, scope.user_id, scope.account_id, input.repo_id, input.name, input.surface, JSON.stringify(input.filters), at, at],
      data: { user_id: scope.user_id, context_account_id: scope.account_id, repository_id: input.repo_id } });
    return respond(c, { id, user_id: scope.user_id, context_account_id: scope.account_id, ...input, revision: 1, created_at: at, updated_at: at }, 201);
  });
  async function read(c: AppContext): Promise<SavedFilter> {
    const scope = await userScope(c, 'saved_filters.manage');
    const value = await one<SavedFilter>(identityDatabase(c), `SELECT ${filterColumns} FROM collaboration_user_saved_filters
      WHERE user_id=? AND context_account_id=? AND id=?`, scope.user_id, scope.account_id, c.req.param('id'));
    if (!value) notFound();
    await filterReferences(c, value.repo_id, savedFilterSchema.parse(JSON.parse(value.filter_json)));
    return value;
  }
  route(app, 'GET', '/v1/saved-filters/:id', { summary: 'Read your saved filter', tags: ['search'], capability: 'saved_filters.manage' }, async c => {
    const { filter_json, ...value } = await read(c);
    return respond(c, { ...value, filters: JSON.parse(filter_json) as unknown });
  });
  const patch = z.strictObject({ name: z.string().trim().min(1).max(100).optional(), filters: savedFilterSchema.optional() })
    .refine(value => Object.keys(value).length > 0, 'Supply at least one field.');
  route(app, 'PATCH', '/v1/saved-filters/:id', { summary: 'Update your saved filter', tags: ['search'], capability: 'saved_filters.manage', authorization: personalAdmission('saved_filters.manage', 'filter'), body: patch }, async c => {
    const value = await read(c);
    checkRevision(c, value);
    const input = await jsonBody(c, patch);
    const filters = input.filters ?? savedFilterSchema.parse(JSON.parse(value.filter_json));
    await filterReferences(c, value.repo_id, filters);
    const at = now();
    await commit(c, { account_id: value.context_account_id, resource_id: value.id, revision: value.revision + 1, type: 'saved_filter.updated',
      sql: 'UPDATE collaboration_user_saved_filters SET name=?,filter_json=?,revision=revision+1,updated_at=? WHERE user_id=? AND context_account_id=? AND id=? AND revision=?',
      bindings: [input.name ?? value.name, JSON.stringify(filters), at, value.user_id, value.context_account_id, value.id, value.revision],
      data: { user_id: value.user_id, context_account_id: value.context_account_id, repository_id: value.repo_id } });
    const { filter_json, ...publicValue } = value;
    return respond(c, { ...publicValue, name: input.name ?? value.name, filters, revision: value.revision + 1, updated_at: at });
  });
  route(app, 'DELETE', '/v1/saved-filters/:id', { summary: 'Delete your saved filter', tags: ['search'], capability: 'saved_filters.manage', authorization: personalAdmission('saved_filters.manage', 'filter') }, async c => {
    const value = await read(c);
    checkRevision(c, value);
    await commit(c, { account_id: value.context_account_id, resource_id: value.id, revision: value.revision + 1, type: 'saved_filter.deleted',
      sql: 'DELETE FROM collaboration_user_saved_filters WHERE user_id=? AND context_account_id=? AND id=? AND revision=?',
      bindings: [value.user_id, value.context_account_id, value.id, value.revision],
      data: { user_id: value.user_id, context_account_id: value.context_account_id, repository_id: value.repo_id } });
    return respond(c, { id: value.id, revision: value.revision + 1, deleted: true });
  });
}
