import { database, getRepository, identityDatabase, many, one, requirePrincipal } from '@gitknot/core';
import type { App, AppContext } from '@gitknot/core';
import { canReadEventReferences, currentUser, getItem, notFound } from './common.ts';
import { filterReferences, projectionReferenceVisible, savedFilterSchema } from './personal.ts';
import { readGlobalInbox, readGlobalItem } from './global-read.ts';
import { filterColumns, subscriptionColumns, userScope } from './user-state.ts';
import type { UserSavedFilter, UserSubscription } from './user-state.ts';

/** Core owns deduplication. This middleware adds subject/fork authorization before a cached body can be replayed. */
export function registerCollaborationReplayGuard(app: App): void {
  app.use('*', async (c, next) => {
    if (!/^\/v1\/(?:repos\/[^/]+\/(?:issues|pulls|discussions|tasks|labels|milestones|drafts|search)(?:\/|$)|inbox(?:\/|$)|subscriptions(?:\/|$)|saved-filters(?:\/|$)|search(?:\/|$)|collaboration\/|users\/[^/]+\/(?:following|followers|preferences)(?:\/|$))/.test(c.req.path)) return next();
    const key = c.req.header('idempotency-key');
    const principal = c.get('principal');
    if (!key || !principal || ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next();
    const existing = await one<{ resource_id: string | null; event_id: string | null; strategy: string }>(database(c),
      'SELECT resource_id,event_id,strategy FROM idempotency_keys WHERE principal_id=? AND key=?', principal.id, key);
    // External adapters bind their exact subject and generation, including cleanup
    // of a soft-deleted parent. Core reruns their complete authorization resolver.
    if (existing?.strategy === 'external') return next();
    if (existing?.resource_id) await reauthorizeResource(c, existing.resource_id);
    if (existing?.event_id) {
      const event = await one<{ payload_json: string; repo_id: string | null }>(database(c), 'SELECT payload_json,repo_id FROM outbox WHERE id=?', existing.event_id);
      if (event) {
        const data = JSON.parse(event.payload_json) as Record<string, unknown>;
        if (event.repo_id && !await canReadEventReferences(c, event.repo_id, data)) notFound();
        if (typeof data.workspace_repo_id === 'string') await getRepository(c, data.workspace_repo_id, 'repositories.read');
        if (typeof data.operation_id === 'string') await reauthorizeOperation(c, data.operation_id);
      }
    }
    return next();
  });
}

async function reauthorizeOperation(c: AppContext, id: string): Promise<void> {
  const context = await one<{ item_id: string | null; repo_id: string | null }>(database(c), 'SELECT item_id,repo_id FROM collaboration_operation_contexts WHERE operation_id=?', id);
  if (context?.item_id && context.repo_id) await getItem(c, undefined, context.item_id, 'contents.read', context.repo_id);
  const scan = await one<{ id: string; user_id: string }>(database(c), 'SELECT id,user_id FROM collaboration_code_scans WHERE operation_id=?', id);
  if (scan) await reauthorizeResource(c, scan.id);
}

async function reauthorizeResource(c: AppContext, id: string): Promise<void> {
  if (c.req.path.startsWith('/v1/inbox/')) {
    const scope = await userScope(c, 'inbox.write');
    if (!await readGlobalInbox(c, scope.user_id, id)) notFound();
    return;
  }
  if (c.req.path.startsWith('/v1/subscriptions')) {
    const scope = await userScope(c, 'subscriptions.manage');
    const value = await one<UserSubscription>(identityDatabase(c), `SELECT ${subscriptionColumns} FROM collaboration_user_subscriptions
      WHERE user_id=? AND context_account_id=? AND id=?`, scope.user_id, scope.account_id, id);
    if (!value) notFound();
    await getRepository(c, value.repo_id);
    if (value.item_id) await readGlobalItem(c, value.repo_id, value.item_id);
    return;
  }
  if (c.req.path.startsWith('/v1/saved-filters')) {
    const scope = await userScope(c, 'saved_filters.manage');
    const value = await one<UserSavedFilter>(identityDatabase(c), `SELECT ${filterColumns} FROM collaboration_user_saved_filters
      WHERE user_id=? AND context_account_id=? AND id=?`, scope.user_id, scope.account_id, id);
    if (!value) notFound();
    await filterReferences(c, value.repo_id, savedFilterSchema.parse(JSON.parse(value.filter_json)));
    return;
  }
  const item = await one<{ repo_id: string }>(database(c), 'SELECT repo_id FROM collaboration_items WHERE id=?', id);
  if (item) { await getItem(c, undefined, id, 'contents.read', item.repo_id); return; }
  const child = await one<{ repo_id: string; item_id: string }>(database(c), `SELECT repo_id,item_id FROM collaboration_comments WHERE id=?
    UNION ALL SELECT repo_id,pull_id FROM pull_reviews WHERE id=?
    UNION ALL SELECT repo_id,pull_id FROM pull_review_threads WHERE id=?
    UNION ALL SELECT repo_id,pull_id FROM pull_suggestions WHERE id=?
    UNION ALL SELECT repo_id,item_id FROM collaboration_attachments WHERE id=?
    UNION ALL SELECT repo_id,pull_id FROM pull_merge_queue WHERE id=? LIMIT 1`, id, id, id, id, id, id);
  if (child) {
    const { item } = await getItem(c, undefined, child.item_id, 'contents.read', child.repo_id);
    if (!await projectionReferenceVisible(c, item, id)) notFound();
    return;
  }
  const draft = await one<{ repo_id: string; user_id: string; item_id: string | null; deleted_at: string | null }>(database(c), 'SELECT repo_id,user_id,item_id,deleted_at FROM collaboration_drafts WHERE id=?', id);
  if (draft) {
    if (draft.user_id !== currentUser(c) || draft.deleted_at) notFound();
    await getRepository(c, draft.repo_id);
    if (draft.item_id) await getItem(c, undefined, draft.item_id, 'contents.read', draft.repo_id);
    return;
  }
  const scan = await one<{ principal_id: string }>(database(c), 'SELECT principal_id FROM collaboration_code_scans WHERE id=?', id);
  if (scan) {
    if (scan.principal_id !== requirePrincipal(c).id) notFound();
    for (const repo of await many<{ repo_id: string }>(database(c), 'SELECT repo_id FROM collaboration_code_scan_repositories WHERE scan_id=?', id)) await getRepository(c, repo.repo_id);
    return;
  }
  const inbox = await one<{ user_id: string; repo_id: string; item_id: string }>(database(c), 'SELECT user_id,repo_id,item_id FROM collaboration_inbox WHERE id=?', id);
  if (inbox) {
    if (inbox.user_id !== currentUser(c)) notFound();
    await getItem(c, undefined, inbox.item_id, 'contents.read', inbox.repo_id);
  }
}
