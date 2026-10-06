import {
  ApiError, authorize, capabilityCovered, credentialScope, currentCredentialChain, identityDatabase, many, one, readAccountPolicy, requirePrincipal,
} from '@gitknot/core';
import type { AppContext, RequestAuthorization } from '@gitknot/core';
import { enforceOrganizationSso } from '@gitknot/federation/integration';
import { currentUser, notFound } from './common.ts';
import type { Item } from './common.ts';
import type { GlobalReference } from './global-read-schema.ts';
import type { InboxItem } from './personal.ts';

export interface UserScope { user_id: string; account_id: string; federated: boolean; requirements: RequestAuthorization[] }
export interface UserSubscription { id: string; user_id: string; context_account_id: string | null; repo_id: string; item_id: string | null;
  mode: 'watching' | 'participating' | 'ignored'; muted_until: string | null; digest: string; revision: number; created_at: string; updated_at: string }
export interface UserSavedFilter { id: string; user_id: string; context_account_id: string | null; repo_id: string | null; name: string; surface: string;
  filter_json: string; revision: number; created_at: string; updated_at: string }
export interface InboxState { notification_id: string; user_id: string; context_account_id: string; repository_id: string; source_event_id: string;
  read_at: string | null; snoozed_until: string | null; state_override: 'outstanding' | 'completed' | null; acknowledged_at: string | null;
  revision: number; created_at: string; updated_at: string }
export const subscriptionColumns = 'id,user_id,context_account_id,repository_id AS repo_id,subject_id AS item_id,mode,muted_until,digest,revision,created_at,updated_at';
export const filterColumns = 'id,user_id,context_account_id,repository_id AS repo_id,name,surface,filter_json,revision,created_at,updated_at';

/** Self-owned state needs identity, not a fabricated personal repository account. */
export async function userScope(c: AppContext, capability: string): Promise<UserScope> {
  const principal = requirePrincipal(c), userId = currentUser(c), db = identityDatabase(c);
  const chain = principal.credential_id ? await currentCredentialChain(db, principal.credential_id) : [];
  const federated = chain.length ? await many<{ account_id: string }>(db, `SELECT DISTINCT account_id FROM federation_session_grants
    WHERE credential_id IN (SELECT value FROM json_each(?)) ORDER BY account_id LIMIT 33`, JSON.stringify(chain.map(row => row.id))) : [];
  if (!federated.length) {
    const account = await one<{ id: string }>(db, "SELECT id FROM accounts WHERE type='user' AND owner_user_id=? AND disabled_at IS NULL", userId);
    if (!account) notFound();
    await authorize(c, capability, { account_id: account.id });
    return { user_id: userId, account_id: account.id, federated: false, requirements: [{ capability, scope: { account_id: account.id } }] };
  }
  const accounts = federated.filter(row => principal.account_ids?.includes(row.account_id));
  if (!accounts.length || accounts.length > 32) throw new ApiError(403, 'user_state_scope', 'This identity has no current organization context.');
  const requested = c.req.query('account_id');
  const accountId = requested ?? accounts[0]!.account_id;
  if (!accounts.some(row => row.account_id === accountId)) throw new ApiError(403, 'user_state_scope', 'The organization context is outside this session.');
  // Membership, MFA, credential kind/lifetime, account scope and SSO freshness use
  // the core decision. The requested private-state capability keeps its ceilings.
  await authorize(c, 'accounts.read', { account_id: accountId });
  await enforceOrganizationSso(db, principal, accountId, capability);
  const ceilings = [principal.capabilities, ...chain.map(row => credentialScope(row.capabilities_json))];
  if (ceilings.some(ceiling => ceiling !== null && !capabilityCovered(ceiling, capability))) {
    throw new ApiError(403, 'user_state_capability', 'The credential does not include this private-state capability.');
  }
  const { policy } = await readAccountPolicy(db, accountId);
  if (policy.allowed_capabilities !== null && !capabilityCovered(policy.allowed_capabilities, capability)
    || capabilityCovered(policy.denied_capabilities, capability)) throw new ApiError(403, 'user_state_capability', 'Organization policy excludes this private-state capability.');
  return { user_id: userId, account_id: accountId, federated: true,
    requirements: [{ capability: 'accounts.read', scope: { account_id: accountId } }] };
}

export async function profileVisible(c: AppContext, userId: string): Promise<void> {
  const user = await one<{ profile_visibility: string }>(identityDatabase(c), 'SELECT profile_visibility FROM users WHERE id=? AND disabled_at IS NULL', userId);
  if (!user || user.profile_visibility === 'private' && c.get('principal')?.user_id !== userId) notFound();
}

export async function activityVisible(c: AppContext, userId: string): Promise<boolean> {
  if (c.get('principal')?.user_id === userId) return true;
  const value = await one<{ profile_visibility: string; activity_visibility: string | null }>(identityDatabase(c), `SELECT u.profile_visibility,p.activity_visibility
    FROM users u LEFT JOIN collaboration_profile_preferences p ON p.user_id=u.id WHERE u.id=? AND u.disabled_at IS NULL`, userId);
  if (!value || value.profile_visibility === 'private' || value.activity_visibility === 'private') return false;
  return value.activity_visibility !== 'followers' || !!await one(identityDatabase(c),
    'SELECT 1 FROM user_follows WHERE follower_id=? AND following_id=?', c.get('principal')?.user_id ?? '', userId);
}

export async function subscriptionsFor(c: AppContext, scope: Pick<UserScope, 'user_id' | 'account_id'>, item: Pick<Item, 'repo_id' | 'id'>): Promise<UserSubscription[]> {
  return many(identityDatabase(c), `SELECT ${subscriptionColumns} FROM collaboration_user_subscriptions
    WHERE user_id=? AND context_account_id=? AND repository_id=? AND (subject_id IS NULL OR subject_id=?)`, scope.user_id, scope.account_id, item.repo_id, item.id);
}
export function subscriptionsMuted(rows: UserSubscription[]): boolean {
  const at = new Date().toISOString();
  return rows.some(row => row.mode === 'ignored' || row.muted_until !== null && row.muted_until > at);
}

export async function inboxState(c: AppContext, scope: Pick<UserScope, 'user_id' | 'account_id'>, id: string): Promise<InboxState | null> {
  return one(identityDatabase(c), 'SELECT * FROM collaboration_user_inbox_state WHERE user_id=? AND context_account_id=? AND notification_id=?', scope.user_id, scope.account_id, id);
}

/** Personal intent is fenced to one source event; new notifications reset it. */
export function inboxView(reference: GlobalReference, overlay: InboxState | null): InboxItem & { actionable: boolean } {
  const source = reference.notification!;
  const current = overlay?.source_event_id === source.source_event_id ? overlay : null;
  const state = reference.action_outstanding ? current?.state_override ?? source.state : 'completed';
  return { ...source, state, read_at: current ? current.read_at : source.read_at,
    snoozed_until: current ? current.snoozed_until : source.snoozed_until,
    completed_at: state === 'completed' ? current?.acknowledged_at ?? source.completed_at : null,
    revision: source.revision + (overlay?.revision ?? 0), updated_at: overlay && overlay.updated_at > source.updated_at ? overlay.updated_at : source.updated_at,
    actionable: state === 'outstanding' && reference.action_outstanding === true };
}

/** Identity/account export adapters must enumerate these by user and context. */
export const collaborationUserStateInventory = Object.freeze([
  { table: 'collaboration_user_subscriptions', user_column: 'user_id', context_column: 'context_account_id',
    repository_columns: ['repository_id'], subject_columns: ['subject_id'], repository_owned: false, owner_kind: 'user', context_is_ownership: false },
  { table: 'collaboration_user_saved_filters', user_column: 'user_id', context_column: 'context_account_id',
    repository_columns: ['repository_id'], json_repository_columns: ['filter_json.repo_ids'], repository_owned: false, owner_kind: 'user', context_is_ownership: false },
  { table: 'collaboration_user_inbox_state', user_column: 'user_id', context_column: 'context_account_id',
    repository_columns: ['repository_id'], notification_columns: ['notification_id'], repository_owned: false, owner_kind: 'user', context_is_ownership: false },
  { table: 'collaboration_profile_preferences', user_column: 'user_id', context_column: null, repository_columns: [], repository_owned: false, owner_kind: 'user', context_is_ownership: false },
  { table: 'user_follows', user_column: 'follower_id', related_user_columns: ['following_id'], context_column: null, repository_columns: [], repository_owned: false, owner_kind: 'user', context_is_ownership: false },
] as const);
