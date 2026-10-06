import {
  ApiError, authorize, credentialIsCurrent, credentialScope, many, now, one, requireHuman, requirePrincipal, stmt,
} from '@gitknot/core';
import type { AppContext, Bindings, CredentialRecord, Database, Principal, UserRecord } from '@gitknot/core';
import { capabilityWithinCeiling, capabilityMatches } from './claims.ts';
import { parseProvider } from './config.ts';
import { integrationUnavailable } from './errors.ts';
import { condition, getOrganizationPolicy } from './store.ts';
import { FEDERATION_IDENTITY_CONTRACT } from './types.ts';
import type { IdentityProvider } from './types.ts';

const administrationRevisions = new WeakMap<Principal, Map<string, number>>();

export async function assertFederationIdentityContract(env: Bindings): Promise<void> {
  if (env.FEDERATION_IDENTITY_CONTRACT !== FEDERATION_IDENTITY_CONTRACT) throw integrationUnavailable();
  const safeguards = await one<{ count: number }>(env.DB, `SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger'
    AND name IN ('memberships_last_owner_update','memberships_last_owner_delete','federation_member_changed','federation_member_removed')`);
  if (safeguards?.count !== 4) throw integrationUnavailable();
}

export async function requireFederationAdministrator(c: AppContext, accountId: string, write = false): Promise<UserRecord> {
  await assertFederationIdentityContract(c.env);
  const user = await requireHuman(c, { verified: true, recent: write, mfa: true });
  const member = await one<{ role_id: string }>(c.env.DB, `SELECT m.role_id FROM memberships m JOIN accounts a ON a.id=m.account_id
    WHERE m.account_id=? AND m.principal_id=? AND m.state='active' AND a.type='organization' AND a.disabled_at IS NULL`, accountId, user.id);
  if (!member || !['owner', 'administrator'].includes(member.role_id)) throw new ApiError(404, 'organization_not_found', 'The organization was not found.');
  const actor = requirePrincipal(c);
  if ((actor.account_ids !== null && !actor.account_ids.includes(accountId)) || actor.repository_ids !== null) {
    throw new ApiError(403, 'federation_credential_scope', 'An organization-scoped human session is required for identity administration.');
  }
  const explanation = await authorize(c, write ? 'identities.manage' : 'identities.read', { account_id: accountId });
  if (write) {
    if (explanation.account_policy_revision === null) throw integrationUnavailable();
    const revisions = administrationRevisions.get(actor) ?? new Map<string, number>();
    revisions.set(accountId, explanation.account_policy_revision);
    administrationRevisions.set(actor, revisions);
  }
  if (write) {
    const credential = await one<CredentialRecord>(c.env.DB, 'SELECT * FROM credentials WHERE id=?', actor.credential_id);
    if (!credential || Date.parse(credential.authenticated_at) < Date.now() - 300_000) {
      throw new ApiError(403, 'reauthentication_required', 'Reauthenticate with MFA within five minutes before changing organization identity.');
    }
  }
  return user;
}

export function credentialGuard(db: Database, credentialId: string): D1PreparedStatement[] {
  return condition(db, `EXISTS (SELECT 1 FROM credentials c JOIN principals p ON p.id=c.principal_id
    LEFT JOIN users u ON u.id=c.user_id WHERE c.id=? AND c.revoked_at IS NULL AND c.expires_at>?
      AND p.disabled_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?)
      AND (c.user_id IS NULL OR (u.disabled_at IS NULL AND u.auth_revision=c.auth_revision)))
    AND NOT EXISTS (WITH RECURSIVE ancestors AS (
      SELECT id,parent_id,revoked_at,expires_at,0 AS depth FROM credentials WHERE id=?
      UNION ALL SELECT c.id,c.parent_id,c.revoked_at,c.expires_at,a.depth+1 FROM credentials c
      JOIN ancestors a ON c.id=a.parent_id WHERE a.depth<8)
      SELECT 1 FROM ancestors a WHERE a.revoked_at IS NOT NULL OR a.expires_at<=?
        OR (a.parent_id IS NOT NULL AND (a.depth=8 OR NOT EXISTS (SELECT 1 FROM credentials WHERE id=a.parent_id))))`,
  credentialId, now(), now(), credentialId, now());
}

export function administratorGuard(db: Database, principal: Principal, accountId: string): D1PreparedStatement[] {
  if (!principal.credential_id || !principal.user_id || principal.kind !== 'user' || !principal.mfa) throw integrationUnavailable();
  const revision = administrationRevisions.get(principal)?.get(accountId);
  if (revision === undefined) throw integrationUnavailable();
  return [...credentialGuard(db, principal.credential_id), ...condition(db, `EXISTS (SELECT 1 FROM accounts WHERE id=? AND policy_revision=? AND disabled_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM account_policy_barriers WHERE account_id=?)`, accountId, revision, accountId), ...condition(db, `EXISTS (SELECT 1 FROM memberships m JOIN users u ON u.id=m.principal_id
    JOIN credentials c ON c.id=? WHERE m.account_id=? AND m.principal_id=? AND m.state='active'
      AND m.role_id IN ('owner','administrator') AND u.email_verified_at IS NOT NULL AND u.disabled_at IS NULL
      AND c.kind='session' AND c.mfa=1 AND c.authenticated_at>=?)`, principal.credential_id, accountId, principal.user_id,
  new Date(Date.now() - 300_000).toISOString())];
}

interface SessionGrant {
  account_id: string;
  credential_id: string;
  provider_id: string;
  provider_revision: number;
  policy_revision: number;
  subject_id: string;
  user_id: string;
  authenticated_at: string;
  mfa: number;
  expires_at: string;
  revoked_at: string | null;
}

async function currentGrant(db: Database, principal: Principal, accountId: string): Promise<{ grant: SessionGrant; provider: ReturnType<typeof parseProvider> } | null> {
  if (!principal.credential_id || !principal.user_id) return null;
  const grant = await one<SessionGrant>(db, `SELECT g.* FROM federation_session_grants g
    JOIN federation_subjects s ON s.id=g.subject_id AND s.account_id=g.account_id AND s.provider_id=g.provider_id
    JOIN memberships m ON m.account_id=g.account_id AND m.principal_id=g.user_id
    JOIN users u ON u.id=g.user_id JOIN accounts a ON a.id=g.account_id
    WHERE g.account_id=? AND g.credential_id=? AND g.user_id=? AND g.revoked_at IS NULL AND g.expires_at>?
      AND g.mfa=1 AND s.state='active' AND s.user_id=g.user_id AND m.state='active'
      AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL AND a.disabled_at IS NULL
      AND (s.scim_user_id IS NULL OR EXISTS (SELECT 1 FROM federation_scim_users su
        WHERE su.id=s.scim_user_id AND su.account_id=s.account_id AND su.provider_id=s.provider_id
          AND su.user_id=s.user_id AND su.active=1 AND su.deleted_at IS NULL))`,
  accountId, principal.credential_id, principal.user_id, now());
  if (!grant) return null;
  const row = await one<IdentityProvider>(db, 'SELECT * FROM federation_providers WHERE account_id=? AND id=? AND revision=? AND enabled=1 AND deleted_at IS NULL',
    accountId, grant.provider_id, grant.provider_revision);
  if (!row) return null;
  const policy = await getOrganizationPolicy(db, accountId);
  if (policy.revision !== grant.policy_revision || Date.parse(grant.authenticated_at) + policy.config.session_max_age_seconds * 1000 <= Date.now()) return null;
  return { grant, provider: parseProvider(row) };
}

async function independentOwnerRecovery(db: Database, principal: Principal, accountId: string, capability: string): Promise<boolean> {
  if (!['identities.manage', 'identities.read'].includes(capability) || principal.kind !== 'user' || !principal.mfa || !principal.credential_id) return false;
  const found = await one<{ id: string }>(db, `SELECT u.id FROM users u JOIN memberships m ON m.principal_id=u.id
    JOIN credentials c ON c.user_id=u.id WHERE u.id=? AND m.account_id=? AND m.state='active' AND m.role_id='owner'
      AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL AND c.id=? AND c.kind='session'
      AND c.mfa=1 AND c.authenticated_at>=? AND c.revoked_at IS NULL AND c.expires_at>?
      AND (u.password_hash IS NOT NULL OR EXISTS (SELECT 1 FROM passkeys WHERE user_id=u.id))
      AND NOT EXISTS (SELECT 1 FROM federation_session_grants WHERE credential_id=c.id)`,
  principal.user_id, accountId, principal.credential_id, new Date(Date.now() - 300_000).toISOString(), now());
  return found !== null;
}

/** Core policy calls this for every organization capability decision, including repository owners. */
export async function enforceOrganizationSso(db: Database, principal: Principal, accountId: string, capability: string): Promise<void> {
  const policy = await getOrganizationPolicy(db, accountId);
  const anyGrant = principal.credential_id ? await one<{ credential_id: string }>(db,
    'SELECT credential_id FROM federation_session_grants WHERE credential_id=? LIMIT 1', principal.credential_id) : null;
  const current = await currentGrant(db, principal, accountId);
  if (current) {
    if (!capabilityWithinCeiling(current.provider.config, capability)) {
      throw new ApiError(403, 'federation_capability_denied', 'This capability is outside the organization federation ceiling or is explicitly denied.');
    }
    return;
  }
  if (anyGrant) throw new ApiError(403, 'organization_sso_expired', 'Reauthenticate with this organization identity provider.');
  if (await independentOwnerRecovery(db, principal, accountId, capability)) return;
  const managed = principal.user_id ? await one(db, `SELECT user_id FROM federation_scim_users WHERE account_id=? AND user_id=?
    UNION SELECT user_id FROM federation_subjects WHERE account_id=? AND user_id=? LIMIT 1`, accountId, principal.user_id, accountId, principal.user_id) : null;
  // A provisioned identity cannot evade its provider's ceilings by using an independent local session.
  if (!policy.config.required && !managed) return;
  if (principal.kind !== 'user' && principal.user_id === null && policy.config.machine_access === 'scoped'
    && principal.account_ids?.includes(accountId) && principal.repository_ids !== null && principal.capabilities !== null
    && principal.capabilities.every(value => !value.includes('*'))) return;
  throw new ApiError(403, 'organization_sso_required', 'A current organization SSO authorization with verified MFA is required.');
}

/** Core authenticate must apply this before returning an SSO-originated Principal. */
export async function restrictFederatedPrincipal(db: Database, principal: Principal): Promise<Principal | null> {
  if (!principal.credential_id) return principal;
  const rows = await many<{ account_id: string }>(db, 'SELECT account_id FROM federation_session_grants WHERE credential_id=? LIMIT 33', principal.credential_id);
  if (!rows.length) return principal;
  if (rows.length > 32) return null;
  const accounts: string[] = [];
  for (const row of rows) {
    if (principal.account_ids !== null && !principal.account_ids.includes(row.account_id)) continue;
    if (await currentGrant(db, principal, row.account_id)) accounts.push(row.account_id);
  }
  return accounts.length ? { ...principal, account_ids: accounts } : null;
}

/** Derived credentials retain SSO scope/expiry. Caller commits these with prepareCredential().statement. */
export async function federationCredentialStatements(db: Database, source: Principal, target: CredentialRecord): Promise<D1PreparedStatement[]> {
  if (!source.credential_id) return [];
  const rows = await many<SessionGrant>(db, 'SELECT * FROM federation_session_grants WHERE credential_id=? LIMIT 33', source.credential_id);
  if (!rows.length) return [];
  if (rows.length > 32 || !source.user_id || source.user_id !== target.user_id) throw new ApiError(403, 'federation_credential_scope', 'An SSO credential cannot delegate outside its verified human identity.');
  const accounts = credentialScope(target.account_ids_json);
  const capabilities = credentialScope(target.capabilities_json);
  const repositories = credentialScope(target.repository_ids_json);
  if ((source.capabilities !== null && (capabilities === null || capabilities.some(value => !source.capabilities!.some(pattern => capabilityMatches(pattern, value)))))
    || (source.repository_ids !== null && (repositories === null || repositories.some(id => !source.repository_ids!.includes(id))))) {
    throw new ApiError(403, 'federation_credential_scope', 'The derived credential exceeds its source credential scope.');
  }
  const result: D1PreparedStatement[] = [...credentialGuard(db, source.credential_id)];
  let copied = 0;
  for (const row of rows) {
    if (accounts !== null && !accounts.includes(row.account_id)) continue;
    if (source.account_ids !== null && !source.account_ids.includes(row.account_id)) continue;
    const current = await currentGrant(db, source, row.account_id);
    if (!current || (capabilities && capabilities.some(value => !capabilityWithinCeiling(current.provider.config, value)
      || current.provider.config.mappings.denied_capabilities.some(deny => capabilityMatches(value, deny))))) {
      throw new ApiError(403, 'federation_credential_scope', 'The derived credential exceeds the current SSO authorization.');
    }
    result.push(...condition(db, `EXISTS (SELECT 1 FROM federation_session_grants WHERE account_id=? AND credential_id=?
      AND revoked_at IS NULL AND expires_at>? AND provider_revision=?)`, row.account_id, source.credential_id, now(), row.provider_revision));
    result.push(stmt(db, `INSERT INTO federation_session_grants
      (account_id,credential_id,provider_id,provider_revision,policy_revision,subject_id,user_id,authenticated_at,mfa,expires_at)
      VALUES (?,?,?,?,?,?,?,?,1,?)`, row.account_id, target.id, row.provider_id, row.provider_revision, row.policy_revision,
    row.subject_id, row.user_id, row.authenticated_at, target.expires_at < row.expires_at ? target.expires_at : row.expires_at));
    copied++;
  }
  if (!copied) throw new ApiError(403, 'federation_credential_scope', 'The credential has no authorized organization scope.');
  return result;
}

export async function isFederationSession(db: Database, credentialId: string): Promise<boolean> {
  return await one(db, 'SELECT credential_id FROM federation_session_grants WHERE credential_id=? LIMIT 1', credentialId) !== null;
}

export async function requireLinkingSession(c: AppContext): Promise<UserRecord> {
  await assertFederationIdentityContract(c.env);
  const user = await requireHuman(c, { verified: true, recent: true, mfa: true });
  const principal = requirePrincipal(c);
  const credential = principal.credential_id ? await one<CredentialRecord>(c.env.DB, 'SELECT * FROM credentials WHERE id=?', principal.credential_id) : null;
  if (!credential || Date.parse(credential.authenticated_at) < Date.now() - 300_000 || !await credentialIsCurrent(c.env.DB, credential)
    || await isFederationSession(c.env.DB, credential.id)) {
    throw new ApiError(403, 'independent_authentication_required', 'Confirm your existing GitKnot account with a passkey or local MFA before linking an organization identity.');
  }
  return user;
}
