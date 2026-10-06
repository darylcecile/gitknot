import { z } from 'zod';
import { ApiError, identityDatabase, jsonBody, newId, now, one, page, route, stmt } from '@gitknot/core';
import type { App, AppContext, Database, RequestAuthorization } from '@gitknot/core';
import { checkRevision, commit, conflict, currentUser, notFound, respond } from './common.ts';
import type { Item } from './common.ts';
import type { InboxItem } from './personal.ts';
import { globalPage, readGlobalInbox } from './global-read.ts';
import { inboxState, inboxView, subscriptionsFor, subscriptionsMuted, userScope } from './user-state.ts';
import type { UserScope } from './user-state.ts';

export interface InboxDeliveryUserState {
  user_id: string; context_account_id: string; notification_id: string; repository_id: string; subject_id: string;
  overlay_revision: number; preferences_revision: number | null; subscriptions: Array<{ id: string; revision: number }>;
}

export async function inboxAdmission(c: AppContext): Promise<RequestAuthorization[]> {
  const scope = await userScope(c, 'inbox.write');
  const source = await readGlobalInbox(c, scope.user_id, c.req.param('id') ?? '');
  if (!source) notFound();
  return scope.requirements;
}

async function detail(c: AppContext, capability: string, includeMarkdown = false) {
  const scope = await userScope(c, capability);
  const source = await readGlobalInbox(c, scope.user_id, c.req.param('id') ?? '', includeMarkdown);
  if (!source) notFound();
  const overlay = await inboxState(c, scope, source.notification!.id);
  return { scope, source, overlay, value: inboxView(source, overlay) };
}

export function registerInbox(app: App): void {
  route(app, 'GET', '/v1/inbox', { summary: 'Read your current-placement decisions and user-owned state', tags: ['inbox'], capability: 'inbox.read' }, async c => {
    const scope = await userScope(c, 'inbox.read');
    const state = c.req.query('state') ?? 'outstanding';
    if (!['outstanding', 'completed', 'all'].includes(state)) throw new ApiError(422, 'invalid_filter', 'Unknown inbox state.');
    const reason = c.req.query('reason');
    if (reason && !['mention', 'assignment', 'review_request', 'task_accountability'].includes(reason)) throw new ApiError(422, 'invalid_filter', 'Unknown inbox reason.');
    const includeSnoozed = c.req.query('include_snoozed') === 'true', unread = c.req.query('unread') === 'true';
    const result = await globalPage(c, { surface: 'inbox', ...page(c), filters: { user_id: scope.user_id },
      parameters: { state, reason, includeSnoozed, unread, context_account_id: scope.account_id } }, async source => {
      const value = inboxView(source, await inboxState(c, scope, source.notification!.id));
      if (state !== 'all' && value.state !== state || reason && value.reason !== reason || unread && value.read_at
        || !includeSnoozed && value.snoozed_until && value.snoozed_until > now()) return null;
      if (subscriptionsMuted(await subscriptionsFor(c, scope, source.item))) return null;
      const item = source.item;
      return { ...value, item: { id: item.id, repo_id: item.repo_id, title: item.title, kind: item.kind, state: item.state, revision: item.revision },
        explanation: { reason: value.reason, source_id: value.source_id, resolution: value.reason === 'mention' ? 'acknowledge' : 'resolve_source_action' } };
    });
    return c.json({ items: result.items, next_cursor: result.next_cursor, coverage: result.source_coverage,
      ordering: 'created_at_desc_id_desc', snapshot_mode: 'created_before_cursor_live_authorized' });
  });
  route(app, 'GET', '/v1/inbox/:id', { summary: 'Read your decision and current authorized source', tags: ['inbox'], capability: 'inbox.read' }, async c => {
    const { source, value } = await detail(c, 'inbox.read', true);
    return respond(c, { ...value, item: source.item });
  });
  const schema = z.strictObject({ read: z.boolean().optional(), snoozed_until: z.iso.datetime().nullable().optional(),
    state: z.enum(['outstanding', 'completed']).optional() }).refine(value => Object.keys(value).length > 0, 'Supply at least one field.');
  route(app, 'PATCH', '/v1/inbox/:id', { summary: 'Read, snooze or acknowledge one source event', tags: ['inbox'], capability: 'inbox.write',
    authorization: c => inboxAdmission(c), body: schema }, async c => {
    const { scope, source, overlay, value } = await detail(c, 'inbox.write');
    checkRevision(c, value);
    const input = await jsonBody(c, schema);
    if (input.snoozed_until && (input.snoozed_until <= now() || Date.parse(input.snoozed_until) > Date.now() + 90 * 86400_000)) {
      throw new ApiError(422, 'invalid_deadline', 'snoozed_until must be within the next 90 days.');
    }
    if (input.state === 'completed' && value.reason !== 'mention' && source.action_outstanding) conflict('source_action_outstanding', 'Resolve the source action before completing its inbox decision.');
    if (input.state === 'outstanding' && !source.action_outstanding) conflict('source_action_resolved', 'This source action is already resolved.');
    const at = now(), current = overlay?.source_event_id === value.source_event_id ? overlay : null;
    const next = { notification_id: value.id, user_id: scope.user_id, context_account_id: scope.account_id, repository_id: value.repo_id,
      source_event_id: value.source_event_id, read_at: input.read === undefined ? value.read_at : input.read ? at : null,
      snoozed_until: input.snoozed_until === undefined ? value.snoozed_until : input.snoozed_until,
      state_override: input.state ?? current?.state_override ?? null,
      acknowledged_at: input.state === 'completed' ? at : input.state === 'outstanding' ? null : current?.acknowledged_at ?? null,
      revision: (overlay?.revision ?? 0) + 1, created_at: overlay?.created_at ?? at, updated_at: at };
    await commit(c, { account_id: scope.account_id, resource_id: value.id, revision: value.revision + 1, type: 'inbox.updated',
      sql: `INSERT INTO collaboration_user_inbox_state(notification_id,user_id,context_account_id,repository_id,source_event_id,read_at,snoozed_until,state_override,acknowledged_at,revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,context_account_id,notification_id) DO UPDATE SET source_event_id=excluded.source_event_id,
        read_at=excluded.read_at,snoozed_until=excluded.snoozed_until,state_override=excluded.state_override,acknowledged_at=excluded.acknowledged_at,
        revision=excluded.revision,updated_at=excluded.updated_at WHERE collaboration_user_inbox_state.revision=?`,
      bindings: [next.notification_id, next.user_id, next.context_account_id, next.repository_id, next.source_event_id, next.read_at, next.snoozed_until,
        next.state_override, next.acknowledged_at, next.revision, next.created_at, at, overlay?.revision ?? 0],
      data: { user_id: scope.user_id, context_account_id: scope.account_id, repository_id: value.repo_id, item_id: value.item_id,
        source_event_id: value.source_event_id, source_revision: source.notification!.revision } });
    return respond(c, inboxView(source, next));
  });
}

/** Delivery uses the supplied, currently authorized recipient context and identity-owned preferences. */
export async function readInboxForDelivery(c: AppContext, inboxId: string): Promise<(InboxItem & {
  item: Item; explanation: string; digest: string; source_revision: number; user_state: InboxDeliveryUserState;
}) | null> {
  const userId = currentUser(c);
  const source = await readGlobalInbox(c, userId, inboxId, true, c.get('routing')?.resource_id);
  if (!source) return null;
  const account = await one<{ id: string }>(identityDatabase(c), "SELECT id FROM accounts WHERE type='user' AND owner_user_id=? AND disabled_at IS NULL", userId);
  const scope: Pick<UserScope, 'user_id' | 'account_id'> = { user_id: userId,
    account_id: c.get('principal')?.account_ids?.[0] ?? account?.id ?? '' };
  if (!scope.account_id) return null;
  const overlay = await inboxState(c, scope, inboxId);
  const value = inboxView(source, overlay);
  const subscriptions = await subscriptionsFor(c, scope, source.item);
  if (!value.actionable || value.snoozed_until && value.snoozed_until > now() || subscriptionsMuted(subscriptions)) return null;
  const preference = await one<{ digest: string; revision: number }>(identityDatabase(c), 'SELECT digest,revision FROM collaboration_profile_preferences WHERE user_id=?', userId);
  const explicit = subscriptions.sort((a, b) => Number(b.item_id !== null) - Number(a.item_id !== null)).find(row => row.digest !== 'inherit');
  const reasons = { mention: 'You were mentioned in this conversation.', assignment: 'You are assigned to this issue.',
    review_request: 'Your review is requested for this proposed change.', task_accountability: 'You are accountable for this task.' };
  return { ...value, item: source.item, explanation: reasons[value.reason], digest: explicit?.digest ?? preference?.digest ?? 'off',
    source_revision: source.notification!.revision, user_state: { user_id: userId, context_account_id: scope.account_id, notification_id: inboxId,
      repository_id: source.repo_id, subject_id: source.item.id, overlay_revision: overlay?.revision ?? 0,
      preferences_revision: preference?.revision ?? null, subscriptions: subscriptions.map(row => ({ id: row.id, revision: row.revision })) } };
}

/** Include on the identity authority in mail's final release transaction. Source revision is fenced separately on its repository. */
export function inboxDeliveryUserStateGuards(db: Database, proof: InboxDeliveryUserState): D1PreparedStatement[] {
  const id = newId('guard');
  return [stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN
    COALESCE((SELECT revision FROM collaboration_user_inbox_state WHERE user_id=? AND context_account_id=? AND notification_id=?),0)=?
    AND (SELECT revision FROM collaboration_profile_preferences WHERE user_id=?) IS ?
    AND (SELECT COUNT(*) FROM collaboration_user_subscriptions WHERE user_id=? AND context_account_id=? AND repository_id=? AND (subject_id IS NULL OR subject_id=?))=?
    AND NOT EXISTS (SELECT 1 FROM collaboration_user_subscriptions s WHERE s.user_id=? AND s.context_account_id=? AND s.repository_id=?
      AND (s.subject_id IS NULL OR s.subject_id=?) AND NOT EXISTS (SELECT 1 FROM json_each(?) p
        WHERE json_extract(p.value,'$.id')=s.id AND json_extract(p.value,'$.revision')=s.revision))
    THEN 1 ELSE 0 END`, id, proof.user_id, proof.context_account_id, proof.notification_id, proof.overlay_revision,
  proof.user_id, proof.preferences_revision, proof.user_id, proof.context_account_id, proof.repository_id, proof.subject_id, proof.subscriptions.length,
  proof.user_id, proof.context_account_id, proof.repository_id, proof.subject_id, JSON.stringify(proof.subscriptions)),
  stmt(db, 'DELETE FROM mutation_guards WHERE id=?', id)];
}
