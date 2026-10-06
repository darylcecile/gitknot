import { ApiError, many, newId, now, one, prepareCredential, stmt } from '@gitknot/core';
import type { Bindings, CredentialRecord, Database, Principal, UserRecord } from '@gitknot/core';
import { mappedRole, mappedTeams, validateEntitlements } from './claims.ts';
import { authenticationFailed } from './errors.ts';
import { credentialGuard } from './integration.ts';
import { cancelMembershipAdmission, prepareMembershipFinance } from './seats.ts';
import { condition, federationAudit, federationBatch, getOrganizationPolicy, guarded, providerGuard, replayStatements } from './store.ts';
import type { AuthenticationFlow, FederatedSubject, Provider, ScimUserRow, VerifiedIdentity } from './types.ts';

export interface PreparedManagedUser {
  user: Pick<UserRecord, 'id' | 'username' | 'email' | 'email_verified_at' | 'auth_revision' | 'display_name'>;
  statements: D1PreparedStatement[];
}

/** Organization-managed humans do not get an unrelated personal account or a fabricated password. */
export async function prepareManagedUser(db: Database, input: { email: string; display_name: string; verified: boolean; actor_id: string; user_id?: string }): Promise<PreparedManagedUser> {
  const duplicate = await one<{ id: string }>(db, 'SELECT id FROM users WHERE email=? COLLATE NOCASE', input.email);
  if (duplicate) throw new ApiError(409, 'identity_link_required', 'This email is already associated with a GitKnot account. Its owner must explicitly link the organization identity while independently signed in.');
  const id = input.user_id ?? newId('u');
  const timestamp = now();
  const user = { id, username: `managed-${id.slice(2, 26)}`, email: input.email,
    email_verified_at: input.verified ? timestamp : null, auth_revision: 1, display_name: input.display_name.slice(0, 120) };
  return { user, statements: [
    stmt(db, `INSERT INTO users(id,username,email,display_name,password_hash,email_verified_at,mfa_required,auth_revision,created_at,updated_at)
      VALUES (?,?,?,?,NULL,?,1,1,?,?)`, id, user.username, user.email, user.display_name, user.email_verified_at, timestamp, timestamp),
    stmt(db, `INSERT INTO principals(id,kind,user_id,name,created_by,created_at,updated_at) VALUES (?,'user',?,?,?,?,?)`,
      id, id, user.display_name || user.username, input.actor_id, timestamp, timestamp),
  ] };
}

export function membershipStatements(db: Database, accountId: string, userId: string, roleId: string, active: boolean, actorId: string): D1PreparedStatement[] {
  const timestamp = now();
  return [stmt(db, `INSERT INTO memberships(account_id,principal_id,role_id,state,created_by,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id,principal_id) DO UPDATE SET
    role_id=CASE WHEN memberships.role_id='owner' THEN 'owner' ELSE excluded.role_id END,
    state=excluded.state,revision=memberships.revision+1,updated_at=excluded.updated_at
    WHERE memberships.state<>excluded.state OR (memberships.role_id<>'owner' AND memberships.role_id<>excluded.role_id)`,
  accountId, userId, roleId, active ? 'active' : 'suspended', actorId, timestamp, timestamp)];
}

/** Revoke the affected organization's assurance and bounded credential families. */
export function revokeUserCredentials(db: Database, accountId: string, userId: string): D1PreparedStatement[] {
  return [stmt(db, `INSERT INTO federation_revocation_targets(id,account_id,principal_id,revoked_at) VALUES (?,?,?,?)`,
    newId('frevoke'), accountId, userId, now())];
}

export async function synchronizeSsoTeams(db: Database, provider: Provider, userId: string, teamIds: string[], subjectId: string): Promise<D1PreparedStatement[]> {
  const old = await many<{ team_id: string }>(db, `SELECT DISTINCT team_id FROM federation_team_memberships
    WHERE account_id=? AND provider_id=? AND user_id=? AND source='sso'`, provider.account_id, provider.id, userId);
  const unmanaged = await one<{ team_id: string }>(db, `SELECT tm.team_id FROM team_members tm WHERE tm.account_id=? AND tm.principal_id=?
    AND tm.team_id IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM federation_team_memberships fm
      WHERE fm.account_id=tm.account_id AND fm.user_id=tm.principal_id AND fm.team_id=tm.team_id) LIMIT 1`,
  provider.account_id, userId, JSON.stringify(teamIds));
  if (unmanaged) throw new ApiError(409, 'federation_team_conflict', 'A mapped team membership is locally managed. Reconcile its source before enabling provider management.');
  const timestamp = now();
  return [
    ...condition(db, `(SELECT COUNT(DISTINCT team_id) FROM federation_team_memberships WHERE account_id=? AND provider_id=? AND user_id=? AND source='sso')=?
      AND NOT EXISTS (SELECT 1 FROM federation_team_memberships WHERE account_id=? AND provider_id=? AND user_id=? AND source='sso'
        AND team_id NOT IN (SELECT value FROM json_each(?)))`, provider.account_id, provider.id, userId, old.length,
    provider.account_id, provider.id, userId, JSON.stringify(old.map(value => value.team_id))),
    ...condition(db, `NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.account_id=? AND tm.principal_id=?
      AND tm.team_id IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM federation_team_memberships fm
        WHERE fm.account_id=tm.account_id AND fm.user_id=tm.principal_id AND fm.team_id=tm.team_id))`, provider.account_id, userId, JSON.stringify(teamIds)),
    stmt(db, `DELETE FROM federation_team_memberships WHERE account_id=? AND provider_id=? AND user_id=? AND source='sso'`, provider.account_id, provider.id, userId),
    stmt(db, `INSERT INTO federation_team_memberships(account_id,provider_id,user_id,team_id,source,source_id)
      SELECT ?,?,?,value,'sso',? FROM json_each(?)`, provider.account_id, provider.id, userId, subjectId, JSON.stringify(teamIds)),
    stmt(db, `DELETE FROM team_members WHERE account_id=? AND principal_id=? AND team_id IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM federation_team_memberships fm WHERE fm.account_id=team_members.account_id
        AND fm.user_id=team_members.principal_id AND fm.team_id=team_members.team_id)`, provider.account_id, userId, JSON.stringify(old.map(row => row.team_id))),
    stmt(db, `INSERT INTO team_members(account_id,team_id,principal_id,role,created_at,updated_at)
      SELECT ?,value,?,'member',?,? FROM json_each(?) WHERE 1 ON CONFLICT(team_id,principal_id) DO NOTHING`,
    provider.account_id, userId, timestamp, timestamp, JSON.stringify(teamIds)),
  ];
}

async function resolveUser(db: Database, provider: Provider, flow: AuthenticationFlow, identity: VerifiedIdentity,
  subject: FederatedSubject | null, scim: ScimUserRow | null): Promise<PreparedManagedUser & { existing: boolean }> {
  const userId = subject?.user_id ?? scim?.user_id ?? flow.link_user_id;
  if (flow.link_user_id && userId !== flow.link_user_id) throw new ApiError(409, 'identity_already_linked', 'This organization identity is already linked to another GitKnot account.');
  if (userId) {
    const user = await one<UserRecord>(db, `SELECT u.* FROM users u JOIN principals p ON p.id=u.id
      WHERE u.id=? AND u.disabled_at IS NULL AND p.kind='user' AND p.disabled_at IS NULL`, userId);
    if (!user) throw authenticationFailed();
    const statements = condition(db, `EXISTS (SELECT 1 FROM users u JOIN principals p ON p.id=u.id
      WHERE u.id=? AND u.auth_revision=? AND u.disabled_at IS NULL AND p.disabled_at IS NULL)`, userId, user.auth_revision);
    if (!user.email_verified_at) {
      if (!scim || !identity.email_verified || identity.email?.toLowerCase() !== user.email.toLowerCase()) {
        throw new ApiError(403, 'verified_identity_required', 'The provider must verify the provisioned email before the first sign-in.');
      }
      const verified = now();
      statements.push(...guarded(db, stmt(db, `UPDATE users SET email_verified_at=?,revision=revision+1,updated_at=?
        WHERE id=? AND auth_revision=? AND disabled_at IS NULL AND email_verified_at IS NULL AND email=? COLLATE NOCASE`,
      verified, verified, userId, user.auth_revision, user.email)));
      user.email_verified_at = verified;
    }
    return { user, statements, existing: true };
  }
  if (provider.config.provisioning !== 'jit' || !identity.email || !identity.email_verified) {
    throw new ApiError(403, 'organization_provisioning_required', 'An active provisioned identity or explicitly permitted verified JIT enrollment is required.');
  }
  return { ...await prepareManagedUser(db, { email: identity.email, display_name: identity.display_name, verified: true, actor_id: provider.created_by }), existing: false };
}

async function resolveSubject(db: Database, provider: Provider, flow: AuthenticationFlow, identity: VerifiedIdentity): Promise<{
  subject: FederatedSubject; user: PreparedManagedUser['user']; statements: D1PreparedStatement[]; scim: ScimUserRow | null; role_id: string;
}> {
  if (identity.issuer !== provider.config.issuer || identity.protocol !== provider.protocol || !provider.config.tenant_values.includes(identity.tenant)) throw authenticationFailed();
  const previous = await one<FederatedSubject>(db, 'SELECT * FROM federation_subjects WHERE account_id=? AND provider_id=? AND subject=?',
    provider.account_id, provider.id, identity.subject);
  const scim = identity.external_id ? await one<ScimUserRow>(db, 'SELECT * FROM federation_scim_users WHERE account_id=? AND provider_id=? AND external_id=?',
    provider.account_id, provider.id, identity.external_id) : null;
  if (previous && (previous.state !== 'active' || previous.issuer !== identity.issuer || previous.tenant !== identity.tenant
    || previous.external_id !== identity.external_id)) throw authenticationFailed();
  if ((scim && (scim.active !== 1 || scim.deleted_at !== null)) || (provider.config.provisioning === 'scim_only' && !scim)) {
    throw new ApiError(403, 'organization_provisioning_required', 'This identity must be active in organization provisioning before sign-in.');
  }
  if (previous && scim && previous.user_id !== scim.user_id) throw new ApiError(409, 'identity_link_conflict', 'The SSO subject and SCIM external ID refer to different accounts.');
  if (previous?.scim_user_id && previous.scim_user_id !== scim?.id) throw authenticationFailed();
  if (scim) {
    const groups = await many<{ external_id: string; team_id: string }>(db, `SELECT g.external_id,g.team_id FROM federation_scim_groups g
      JOIN federation_scim_group_members gm ON gm.account_id=g.account_id AND gm.provider_id=g.provider_id AND gm.group_id=g.id
      WHERE gm.account_id=? AND gm.provider_id=? AND gm.scim_user_id=? AND g.deleted_at IS NULL LIMIT 65`, provider.account_id, provider.id, scim.id);
    if (groups.length > 64 || groups.some(group => !provider.config.mappings.team_ceiling.includes(group.team_id)
      || !provider.config.mappings.scim_group_mappings.some(mapping => mapping.external_id === group.external_id && mapping.team_id === group.team_id))) {
      throw new ApiError(403, 'federation_team_ceiling', 'Existing provisioned groups must be reconciled with the current organization team ceiling before sign-in.');
    }
  }
  const prepared = await resolveUser(db, provider, flow, identity, previous, scim);
  const timestamp = now();
  const subject: FederatedSubject = previous ?? {
    id: newId('fs'), account_id: provider.account_id, provider_id: provider.id, issuer: identity.issuer, subject: identity.subject,
    tenant: identity.tenant, user_id: prepared.user.id, external_id: identity.external_id, scim_user_id: scim?.id ?? null,
    state: 'active', revision: 1, created_at: timestamp, updated_at: timestamp,
  };
  const statements = prepared.statements;
  if (flow.link_user_id) {
    statements.push(...credentialGuard(db, flow.link_credential_id!), ...condition(db,
      'EXISTS (SELECT 1 FROM users WHERE id=? AND auth_revision=? AND email_verified_at IS NOT NULL AND disabled_at IS NULL)',
      flow.link_user_id, flow.link_auth_revision));
  }
  if (scim) statements.push(...condition(db, `EXISTS (SELECT 1 FROM federation_scim_users WHERE account_id=? AND provider_id=?
    AND id=? AND user_id=? AND revision=? AND active=1 AND deleted_at IS NULL)`, provider.account_id, provider.id, scim.id, prepared.user.id, scim.revision));
  if (previous) statements.push(...condition(db, 'EXISTS (SELECT 1 FROM federation_subjects WHERE account_id=? AND provider_id=? AND id=? AND revision=? AND state=?)',
    provider.account_id, provider.id, previous.id, previous.revision, 'active'));
  else statements.push(stmt(db, `INSERT INTO federation_subjects
    (id,account_id,provider_id,issuer,subject,tenant,user_id,external_id,scim_user_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'active',?,?)`,
  subject.id, subject.account_id, subject.provider_id, subject.issuer, subject.subject, subject.tenant, subject.user_id,
  subject.external_id, subject.scim_user_id, subject.created_at, subject.updated_at));
  const membership = await one<{ role_id: string; state: string; revision: number }>(db, 'SELECT role_id,state,revision FROM memberships WHERE account_id=? AND principal_id=?',
    provider.account_id, prepared.user.id);
  if (membership?.state === 'suspended' || (previous && !membership)) throw new ApiError(403, 'organization_membership_inactive', 'The organization membership is inactive. Contact an organization administrator.');
  statements.push(...condition(db, membership ? 'EXISTS (SELECT 1 FROM memberships WHERE account_id=? AND principal_id=? AND revision=? AND state=?)'
    : 'NOT EXISTS (SELECT 1 FROM memberships WHERE account_id=? AND principal_id=?)', provider.account_id, prepared.user.id,
  ...(membership ? [membership.revision, 'active'] : [])));
  const roleValues = scim ? scimRoles(JSON.parse(scim.attributes_json) as Record<string, unknown>) : identity.role_values;
  return { subject, user: prepared.user, statements, scim, role_id: mappedRole(provider.config, roleValues) };
}

export function scimRoles(attributes: Record<string, unknown>): string[] {
  if (!Array.isArray(attributes.roles)) return [];
  return attributes.roles.map(value => (value as { value: string }).value);
}

export type FederationExchangeResult = { credential: CredentialRecord; token: string; user_id: string }
  | { pending_provisioning: true; user_id: string };

/** A verified local account can pre-link its immutable provider ID without bypassing SCIM-only enrollment. */
async function linkPendingProvisioning(db: Database, provider: Provider, flow: AuthenticationFlow, identity: VerifiedIdentity,
  requestId: string): Promise<FederationExchangeResult> {
  if (!flow.link_user_id || !flow.link_credential_id || !identity.external_id) throw authenticationFailed();
  const previous = await one<FederatedSubject>(db, 'SELECT * FROM federation_subjects WHERE account_id=? AND provider_id=? AND subject=?',
    provider.account_id, provider.id, identity.subject);
  if (previous && (previous.user_id !== flow.link_user_id || previous.state === 'suspended' || previous.external_id !== identity.external_id
    || previous.issuer !== identity.issuer || previous.tenant !== identity.tenant || previous.scim_user_id !== null)) {
    throw new ApiError(409, 'identity_link_conflict', 'This provider identity cannot be linked to the signed-in account.');
  }
  const id = previous?.id ?? newId('fs');
  const revision = (previous?.revision ?? 0) + 1;
  const actor: Principal = { id: flow.link_user_id, kind: 'user', user_id: flow.link_user_id, credential_id: flow.link_credential_id,
    capabilities: null, repository_ids: null, account_ids: null, mfa: true };
  await federationBatch(db, [
    ...providerGuard(db, provider), ...credentialGuard(db, flow.link_credential_id),
    ...condition(db, 'EXISTS (SELECT 1 FROM users WHERE id=? AND auth_revision=? AND disabled_at IS NULL AND email_verified_at IS NOT NULL)', flow.link_user_id, flow.link_auth_revision),
    ...guarded(db, stmt(db, `UPDATE federation_auth_flows SET completed_at=?,pkce_verifier=NULL WHERE account_id=? AND provider_id=? AND id=?
      AND provider_revision=? AND consumed_at IS NOT NULL AND completed_at IS NULL AND expires_at>?`, now(), provider.account_id, provider.id, flow.id, provider.revision, now())),
    ...await replayStatements(db, provider, identity),
    ...(previous ? guarded(db, stmt(db, "UPDATE federation_subjects SET state='pending',revision=revision+1,updated_at=? WHERE account_id=? AND provider_id=? AND id=? AND revision=?", now(), provider.account_id, provider.id, id, previous.revision))
      : [stmt(db, `INSERT INTO federation_subjects(id,account_id,provider_id,issuer,subject,tenant,user_id,external_id,state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'pending',?,?)`, id, provider.account_id, provider.id, identity.issuer, identity.subject, identity.tenant, flow.link_user_id, identity.external_id, now(), now())]),
    ...federationAudit(db, actor, requestId, provider.account_id, 'federation.identity.linked', id, revision, { provider_id: provider.id, pending_provisioning: true }),
  ]);
  return { pending_provisioning: true, user_id: flow.link_user_id };
}

/** Atomic link/provision + replay admission + core credential + SSO assurance. No email lookup ever selects the account. */
export async function exchangeFederatedIdentity(db: Database, provider: Provider, flow: AuthenticationFlow, identity: VerifiedIdentity,
  requestId: string, env?: Bindings): Promise<FederationExchangeResult> {
  if (identity.issuer !== provider.config.issuer || identity.protocol !== provider.protocol || !provider.config.tenant_values.includes(identity.tenant)) throw authenticationFailed();
  await validateEntitlements(db, provider.account_id, provider.config);
  if (flow.link_user_id && provider.config.provisioning === 'scim_only' && identity.external_id
    && !await one(db, 'SELECT id FROM federation_scim_users WHERE account_id=? AND provider_id=? AND external_id=?', provider.account_id, provider.id, identity.external_id)) {
    return linkPendingProvisioning(db, provider, flow, identity, requestId);
  }
  const prepared = await resolveSubject(db, provider, flow, identity);
  const policy = await getOrganizationPolicy(db, provider.account_id);
  const expiry = Math.min(Date.parse(identity.authenticated_at) + policy.config.session_max_age_seconds * 1000,
    identity.session_expires_at ? Date.parse(identity.session_expires_at) : Infinity);
  if (expiry <= Date.now()) throw authenticationFailed();
  const session = await prepareCredential(db, {
    principal_id: prepared.user.id, user_id: prepared.user.id, kind: 'session', name: `${provider.name} SSO`,
    capabilities: null, repository_ids: null, account_ids: null, auth_revision: prepared.user.auth_revision,
    mfa: true, authenticated_at: identity.authenticated_at, expires_at: new Date(expiry).toISOString(), created_by: prepared.user.id,
  });
  const actor: Principal = { id: prepared.user.id, kind: 'user', user_id: prepared.user.id, credential_id: session.credential.id,
    capabilities: null, repository_ids: null, account_ids: [provider.account_id], mfa: true };
  const teams = await synchronizeSsoTeams(db, provider, prepared.user.id,
    provider.config.mappings.group_claim === null ? [] : mappedTeams(provider.config, identity.group_values), prepared.subject.id);
  const finance = await prepareMembershipFinance(db, env, provider, prepared.user.id, true, {
    kind: 'flow', id: flow.id, generation: 1, attempt_id: flow.id, expires_at: flow.expires_at, actor_id: prepared.user.id,
  });
  const statements = [
    ...providerGuard(db, provider), ...condition(db, policy.revision === 0 ? 'NOT EXISTS (SELECT 1 FROM federation_org_policies WHERE account_id=?)'
      : 'EXISTS (SELECT 1 FROM federation_org_policies WHERE account_id=? AND revision=?)', provider.account_id, ...(policy.revision ? [policy.revision] : [])), ...finance.guards,
    ...guarded(db, stmt(db, `UPDATE federation_auth_flows SET completed_at=?,pkce_verifier=NULL WHERE account_id=? AND provider_id=? AND id=?
      AND provider_revision=? AND consumed_at IS NOT NULL AND completed_at IS NULL AND expires_at>?`, now(), provider.account_id, provider.id, flow.id, provider.revision, now())),
    ...await replayStatements(db, provider, identity), ...prepared.statements, ...finance.statements,
    ...membershipStatements(db, provider.account_id, prepared.user.id, prepared.role_id, true, prepared.user.id), ...teams, session.statement,
    stmt(db, `INSERT INTO federation_session_grants(account_id,credential_id,provider_id,provider_revision,policy_revision,subject_id,user_id,authenticated_at,mfa,expires_at)
      VALUES (?,?,?,?,?,?,?,?,1,?)`, provider.account_id, session.credential.id, provider.id, provider.revision, policy.revision,
    prepared.subject.id, prepared.user.id, identity.authenticated_at, session.credential.expires_at),
    ...federationAudit(db, actor, requestId, provider.account_id, flow.link_user_id ? 'federation.identity.linked' : 'federation.session.created',
      prepared.subject.id, prepared.subject.revision, { provider_id: provider.id, user_id: prepared.user.id, mfa: true }),
  ];
  try { await federationBatch(db, statements); }
  catch (error) { await cancelMembershipAdmission(db, finance.admission_id); throw error; }
  return { credential: session.credential, token: session.token, user_id: prepared.user.id };
}
