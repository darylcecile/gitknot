import { z } from 'zod';
import { deleteCookie, setCookie } from 'hono/cookie';
import { ApiError, database, etag, eventStatement, makeEvent, mutationStatements, newId, now, one, stmt, type AppContext, type Bindings, type EventInput, type PermissionExplanation, type RequestPolicy } from '@gitknot/core';
import { identityAuthorityBindings, identityBinding, identityDatabase, readRepositoryAuthority, separateIdentityAuthority } from '@gitknot/core/authority';
import { requestDatabaseAuthority, requestDatabaseBinding, selectedRepositoryScope } from '@gitknot/core/routing/cells';
import { afterSeconds, checkedWrite, identityBatch, prepareCredential, sessionCookieName, type CredentialRecord, type IdentityAction, type UserRecord } from '@gitknot/core/auth';
import { withAccountAuthorityBarriers, withAccountPolicyBarrier, withRepositoryBarrier } from '../repositories/shared.ts';
import { affectedIdentityAccounts, changesIdentityAuthority, effectiveOwnerChecks } from './guards.ts';

export const idSchema = z.string().min(3).max(128).regex(/^[a-z][a-z0-9]*_[A-Za-z0-9_-]+$/);
export const usernameSchema = z.string().min(2).max(39).regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/)
  .transform(value => value.toLowerCase()).refine(value => !['admin', 'api', 'auth', 'git', 'gitknot', 'help', 'security', 'settings', 'support', 'www'].includes(value), 'This name is reserved.');
export const emailSchema = z.email().max(254).transform(value => value.toLowerCase());
export const passwordSchema = z.string().min(15).max(256).refine(value => new TextEncoder().encode(value).byteLength <= 1024, 'The password is too long.');
export const tokenSchema = z.string().min(32).max(512).regex(/^[A-Za-z0-9_-]+$/);
export const proofSchema = z.object({ code: z.string().regex(/^\d{6}$/).optional(), recovery_code: z.string().min(20).max(32).optional() }).strict();
export const emptySchema = z.object({}).strict();

export function noStore(c: AppContext): void {
  c.header('cache-control', 'no-store');
  c.header('referrer-policy', 'no-referrer');
}

export function databaseBindings(c: AppContext): Bindings {
  const authority = requestDatabaseAuthority(c);
  return { ...c.env, ...identityAuthorityBindings(c.env), DB: requestDatabaseBinding(c),
    CELL_ID: authority.location.cell_id, SHARD_ID: authority.location.shard_id };
}

export function identityBindings(c: AppContext): Bindings {
  const identity = identityAuthorityBindings(c.env);
  return { ...c.env, ...identity, DB: identityBinding(c.env), CELL_ID: String(identity.IDENTITY_CELL_ID), SHARD_ID: String(identity.IDENTITY_SHARD_ID) };
}

export function publicUser(user: UserRecord, self = false): Record<string, unknown> {
  return { id: user.id, username: user.username, display_name: user.display_name, bio: user.bio,
    avatar_url: user.avatar_url, created_at: user.created_at, updated_at: user.updated_at, revision: user.revision,
    ...(self || user.show_email === 1 ? { email: user.email } : {}),
    ...(self ? { email_verified: user.email_verified_at !== null, email_verified_at: user.email_verified_at,
      profile_visibility: user.profile_visibility, show_email: user.show_email === 1, mfa_required: user.mfa_required === 1 } : {}) };
}

async function delegatedAuthorityChecks(c: AppContext, decisions: PermissionExplanation[]): Promise<D1PreparedStatement[]> {
  const delegated = decisions.filter(value => value.principal_id !== c.get('principal')?.id);
  if (!delegated.length) return [];
  if (separateIdentityAuthority(c) || selectedRepositoryScope(c) !== null) throw new ApiError(503, 'identity_authority_required', 'Delegated identity changes must commit on the identity authority.');
  const db = identityDatabase(c);
  const checks: D1PreparedStatement[] = [];
  for (const decision of delegated) {
    if (decision.repo_id) {
      const repo = await readRepositoryAuthority(c, decision.repo_id);
      if (!repo || repo.owner_id !== decision.account_id || repo.revision !== decision.repository_revision
        || repo.routing_epoch !== decision.routing_epoch) throw new ApiError(412, 'revision_conflict', 'The delegated repository authority changed.');
    }
    if (!decision.account_id) continue;
    const guard = newId('guard');
    checks.push(stmt(db, `INSERT INTO identity_write_guards(id,ok) SELECT ?,CASE WHEN EXISTS
      (SELECT 1 FROM accounts WHERE id=? AND policy_revision=? AND disabled_at IS NULL) THEN 1 ELSE 0 END`,
    guard, decision.account_id, decision.account_policy_revision), stmt(db, 'DELETE FROM identity_write_guards WHERE id=?', guard));
  }
  return checks;
}

export async function commitIdentity(c: AppContext, statements: D1PreparedStatement[], event: EventInput, options: {
  authorizations?: PermissionExplanation[]; events?: EventInput[]; audit_details?: Record<string, unknown>; credential_fence?: boolean;
  barrier_handled?: boolean; affected_accounts?: string[]; before_commit?: () => Promise<void>;
} = {}): Promise<void> {
  const changesAccess = changesIdentityAuthority(event.type);
  if (changesAccess && !options.barrier_handled) {
    const accounts = await affectedIdentityAccounts(c, event, options.affected_accounts);
    const mutation = () => commitIdentity(c, statements, event, { ...options, barrier_handled: true, affected_accounts: accounts });
    return withAccountAuthorityBarriers(c, accounts, event.type, async () => {
      if (event.repo_id) return withRepositoryBarrier(c, event.repo_id, event.type, mutation);
      if (!event.account_id || !accounts.includes(event.account_id)) return mutation();
      const revision = options.authorizations?.find(value => value.account_id === event.account_id)?.account_policy_revision;
      return withAccountPolicyBarrier(c, event.account_id, event.type, revision, mutation);
    });
  }
  const actor = c.get('principal');
  const record = makeEvent({ ...event, actor_id: event.actor_id ?? actor?.id ?? null });
  const db = database(c);
  await options.before_commit?.();
  const request = c.get('idempotency');
  if (request?.capability && !request.policies.length && options.authorizations?.length) {
    const policies = new Map<string, RequestPolicy>();
    for (const decision of options.authorizations.filter(value => value.allowed && value.capability === request.capability)) {
      const scope = decision.repo_id ? { repo_id: decision.repo_id } : { account_id: decision.account_id! };
      policies.set(JSON.stringify(scope), { capability: decision.capability, scope, repo_id: decision.repo_id, account_id: decision.account_id,
        policy_revision: decision.policy_revision, account_policy_revision: decision.account_policy_revision, routing_epoch: decision.routing_epoch });
    }
    request.policies = [...policies.values()];
  }
  const batch = await mutationStatements(c, { event: record, audit: { action: record.type, resource_id: record.resource_id, details: options.audit_details }, statements: [
    ...await delegatedAuthorityChecks(c, options.authorizations ?? []),
    ...statements,
    ...(changesAccess && !separateIdentityAuthority(c) && selectedRepositoryScope(c) === null ? effectiveOwnerChecks(c, options.affected_accounts ?? (event.account_id ? [event.account_id] : [])) : []),
    ...(options.events ?? []).map(value => eventStatement(db, { ...value, actor_id: value.actor_id ?? actor?.id ?? null })),
  ] });
  await identityBatch(db, batch);
}

export function consumeAction(c: AppContext, action: IdentityAction): D1PreparedStatement[] {
  return checkedWrite(identityDatabase(c), stmt(identityDatabase(c), `UPDATE identity_actions SET consumed_at=?,revision=revision+1
    WHERE id=? AND revision=? AND consumed_at IS NULL AND expires_at>? AND attempts<10`, now(), action.id, action.revision, now()));
}

export function userEpochFence(c: AppContext, user: UserRecord): D1PreparedStatement[] {
  return checkedWrite(identityDatabase(c), stmt(identityDatabase(c),
    'UPDATE users SET auth_revision=auth_revision WHERE id=? AND auth_revision=? AND disabled_at IS NULL', user.id, user.auth_revision));
}

export function setSession(c: AppContext, token: string, credential: CredentialRecord): void {
  noStore(c);
  setCookie(c, sessionCookieName(c.env), token, { httpOnly: true, secure: new URL(c.env.API_ORIGIN).protocol === 'https:',
    sameSite: 'Lax', path: '/', expires: new Date(credential.expires_at), priority: 'High' });
}

export function clearSession(c: AppContext): void {
  noStore(c);
  deleteCookie(c, sessionCookieName(c.env), { httpOnly: true, secure: new URL(c.env.API_ORIGIN).protocol === 'https:', sameSite: 'Lax', path: '/' });
}

export async function newSession(c: AppContext, user: UserRecord, mfa: boolean) {
  return prepareCredential(identityDatabase(c), { principal_id: user.id, user_id: user.id, kind: 'session', name: 'Web session', capabilities: null,
    repository_ids: null, account_ids: null, auth_revision: user.auth_revision, mfa, expires_at: afterSeconds(30 * 86400), created_by: user.id });
}

export function revisionResponse<T extends { revision: number }>(c: AppContext, value: T, status: 200 | 201 | 202 = 200): Response {
  c.header('etag', etag(value.revision));
  return c.json(value, status);
}

export function requireActionEpoch(action: IdentityAction, user: UserRecord): void {
  if (action.auth_revision !== user.auth_revision || user.disabled_at !== null) {
    throw new ApiError(400, 'invalid_authentication_action', 'This authentication request expired. Start again.');
  }
}

export async function failedAction(c: AppContext, id: string): Promise<void> {
  await stmt(identityDatabase(c), 'UPDATE identity_actions SET attempts=attempts+1 WHERE id=? AND consumed_at IS NULL', id).run();
}
