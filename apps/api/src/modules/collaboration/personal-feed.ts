import { ApiError, getRepository, identityDatabase, one, page, route } from '@gitknot/core';
import type { App, AppContext } from '@gitknot/core';
import { globalPage } from './global-read.ts';
import { activityVisible, profileVisible, subscriptionsFor, subscriptionsMuted, userScope } from './user-state.ts';
import { notFound } from './common.ts';

async function feed(c: AppContext, profileId?: string): Promise<Response> {
  const mode = c.req.query('scope') ?? (profileId ? 'profile' : c.get('principal') ? 'following' : 'public');
  if (!['public', 'following', 'subscribed', 'repository', 'profile'].includes(mode)) throw new ApiError(422, 'invalid_filter', 'Unknown feed scope.');
  const scope = c.get('principal')?.user_id || ['following', 'subscribed'].includes(mode) ? await userScope(c, 'feed.read') : null;
  const repoId = c.req.query('repo_id');
  if (mode === 'repository' && !repoId) throw new ApiError(422, 'repository_required', 'Repository feeds require repo_id.');
  if (repoId) await getRepository(c, repoId);
  if (profileId) { await profileVisible(c, profileId); if (!await activityVisible(c, profileId)) notFound(); }
  const actorId = profileId ?? c.req.query('actor_id');
  if (actorId) {
    await profileVisible(c, actorId);
    if (!await activityVisible(c, actorId)) notFound();
  }
  const kind = c.req.query('kind');
  if (kind && !['issue', 'pull_request', 'discussion', 'task'].includes(kind)) throw new ApiError(422, 'invalid_filter', 'Unknown activity resource kind.');
  const grouped = c.req.query('group_automation') !== 'false';
  const paging = page(c);
  const result = await globalPage(c, { surface: 'feed', ...paging, parameters: { mode, context_account_id: scope?.account_id }, filters: {
    repo_ids: repoId ? [repoId] : [], actor_id: actorId, kind: kind as 'issue' | 'pull_request' | 'discussion' | 'task' | undefined,
    user_id: scope?.user_id, public_only: mode === 'public', grouped,
  } }, async reference => {
    const activity = reference.activity!;
    const subscriptions = scope ? await subscriptionsFor(c, scope, reference.item) : [];
    if (subscriptionsMuted(subscriptions)) return null;
    const watched = subscriptions.some(value => value.mode === 'watching');
    if (mode === 'subscribed' && !watched) return null;
    if (mode === 'following' && activity.actor_id !== scope!.user_id && !watched
      && !await one(identityDatabase(c), 'SELECT 1 FROM user_follows WHERE follower_id=? AND following_id=?', scope!.user_id, activity.actor_id)) return null;
    const item = reference.item;
    return { ...activity, group_count: grouped ? activity.group_count : 1,
      item: { id: item.id, kind: item.kind, title: item.title, state: item.state, number: item.number, revision: item.revision } };
  });
  return c.json({ items: result.items, next_cursor: result.next_cursor, coverage: result.source_coverage,
    ordering: 'created_at_desc_id_desc', snapshot_mode: 'created_before_cursor_live_authorized' });
}

export function registerFeed(app: App): void {
  route(app, 'GET', '/v1/feed', { summary: 'Read chronological current-placement activity with bounded coverage', tags: ['activity'], public: true }, c => feed(c));
  route(app, 'GET', '/v1/users/:id/activity', { summary: 'Read authorized current-placement profile activity', tags: ['profiles'], public: true }, c => feed(c, c.req.param('id')));
}
