import { identityDatabase as database } from '@gitknot/core/authority';
import { ApiError, authorize, capabilityCatalog, capabilityCovered, capabilityMatches, explainAuthorization, many, now, one, readAccountPolicy, recordRequestPolicy, stmt,
  type AccountRecord, type AppContext, type AuthorizationScope, type PermissionExplanation } from '@gitknot/core';
import { requireHuman } from '@gitknot/core/auth';

export interface RoleRecord { id: string; account_id: string | null; repo_id: string | null; name: string; description: string; built_in: number; revision: number; created_at: string; updated_at: string }
export interface RoleCapability { capability: string; effect: 'allow' | 'deny' }
export interface MembershipRecord { account_id: string; principal_id: string; role_id: string; state: 'active' | 'suspended'; revision: number; created_by: string; created_at: string; updated_at: string }

export async function accountAccess(c: AppContext, id: string | undefined, capability: string, organization = false): Promise<{ account: AccountRecord; authorization: PermissionExplanation }> {
  if (!id) throw new ApiError(404, 'not_found', 'The requested account was not found.');
  const authorization = await authorize(c, capability, { account_id: id });
  const account = await one<AccountRecord>(database(c), 'SELECT * FROM accounts WHERE id=? AND disabled_at IS NULL', id);
  if (!account || organization && account.type !== 'organization') throw new ApiError(404, 'not_found', 'The requested account was not found.');
  return { account, authorization };
}

export function publicAccount(account: AccountRecord): Record<string, unknown> & { revision: number } {
  return { id: account.id, type: account.type, slug: account.slug, name: account.name, description: account.description,
    policy_revision: account.policy_revision, revision: account.revision, created_at: account.created_at, updated_at: account.updated_at };
}

export function bumpAccountPolicy(c: AppContext, id: string): D1PreparedStatement {
  return stmt(database(c), 'UPDATE accounts SET policy_revision=policy_revision+1,revision=revision+1,updated_at=? WHERE id=?', now(), id);
}

export async function scopedRole(c: AppContext, id: string | undefined, accountId: string, repoId: string | null = null): Promise<RoleRecord & { capabilities: RoleCapability[] }> {
  if (!id) throw new ApiError(422, 'role_required', 'Choose a scoped role.');
  const role = await one<RoleRecord>(database(c), 'SELECT * FROM roles WHERE id=? AND (built_in=1 OR (account_id=? AND (repo_id IS NULL OR repo_id=?)))', id, accountId, repoId);
  if (!role || role.repo_id !== null && role.repo_id !== repoId) throw new ApiError(422, 'role_outside_scope', 'Choose a role defined for this account and repository.');
  const capabilities = await many<RoleCapability>(database(c), 'SELECT capability,effect FROM role_capabilities WHERE role_id=? ORDER BY capability,effect', id);
  return { ...role, capabilities };
}

export async function assertDelegable(c: AppContext, capabilities: RoleCapability[], scope: AuthorizationScope): Promise<void> {
  const checks = new Set<string>();
  for (const entry of capabilities) {
    if (entry.effect === 'deny') continue;
    if (entry.capability === '*') { checks.add('owners.manage'); continue; }
    if (entry.capability.endsWith('.*')) {
      for (const capability of capabilityCatalog) if (capabilityMatches(entry.capability, capability)) checks.add(capability);
    } else checks.add(entry.capability);
  }
  // A bounded number of current-state evaluations; every resulting mutation also
  // fences the account policy revision in the same transaction as its grants.
  let retained = false;
  for (const capability of checks) {
    const explanation = await explainAuthorization(c, capability, scope);
    if (!explanation.allowed) throw new ApiError(403, 'role_delegation_denied', 'You cannot delegate a capability outside your current access.', { capability });
    // Every capability in this scope shares these authority versions. Retaining
    // the first decision also fences delegation-only scopes during rotation.
    if (!retained) { recordRequestPolicy(c, { capability, scope }, explanation); retained = true; }
  }
}

export async function requireOwnerAssignment(c: AppContext, roleId: string, principalId: string, accountId: string): Promise<void> {
  if (roleId !== 'owner') return;
  await requireHuman(c, { recent: true, independent: true });
  await authorize(c, 'owners.manage', { account_id: accountId });
  const user = await one(database(c), `SELECT u.id FROM users u JOIN principals p ON p.id=u.id
    WHERE u.id=? AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL AND p.disabled_at IS NULL
      AND p.kind='user' AND p.user_id=u.id AND p.expires_at IS NULL
      AND (u.password_hash IS NOT NULL OR EXISTS (SELECT 1 FROM passkeys k WHERE k.user_id=u.id))`, principalId);
  if (!user) throw new ApiError(422, 'recoverable_owner_required', 'An owner must be an active, verified person with a usable authentication method.');
}

export const recoveryCapabilities = ['owners.manage', 'accounts.manage', 'members.manage', 'roles.manage', 'policy.manage', 'permissions.manage', 'tokens.manage', 'identities.manage', 'identities.read'];

export async function guardOwnerDenial(c: AppContext, accountId: string, principalType: string, principalId: string, capabilities: RoleCapability[], repoId: string | null = null): Promise<void> {
  if (!capabilities.some(entry => entry.effect === 'deny' && recoveryCapabilities.some(capability => capabilityMatches(entry.capability, capability)))) return;
  const owners = await many<{ principal_id: string }>(database(c), `SELECT m.principal_id FROM memberships m JOIN users u ON u.id=m.principal_id
    JOIN principals p ON p.id=u.id WHERE m.account_id=? AND m.role_id='owner' AND m.state='active'
    AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL AND p.disabled_at IS NULL
    AND (u.password_hash IS NOT NULL OR EXISTS (SELECT 1 FROM passkeys k WHERE k.user_id=u.id))`, accountId);
  const affected = principalType === 'team'
    ? await many<{ principal_id: string }>(database(c), 'SELECT principal_id FROM team_members WHERE account_id=? AND team_id=?', accountId, principalId)
    : [{ principal_id: principalId }];
  if (!owners.some(owner => affected.some(subject => subject.principal_id === owner.principal_id))) return;
  const { policy } = await readAccountPolicy(database(c), accountId);
  for (const owner of owners.filter(owner => !affected.some(subject => subject.principal_id === owner.principal_id))) {
    if (policy.require_mfa && !await one(database(c), `SELECT 1 FROM passkeys WHERE user_id=? UNION ALL
      SELECT 1 FROM user_mfa WHERE user_id=? AND enabled_at IS NOT NULL LIMIT 1`, owner.principal_id, owner.principal_id)) continue;
    // Include future denials: a delayed deny must not silently remove the final
    // recovery path later. Expired conditions are no longer candidates.
    const denials = await many<{ capability: string; conditions_json: string }>(database(c), `SELECT COALESCE(g.capability,rc.capability) AS capability,g.conditions_json
      FROM access_grants g LEFT JOIN role_capabilities rc ON rc.role_id=g.role_id
      WHERE g.account_id=? AND (g.repo_id IS NULL OR g.repo_id=?) AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at>?) AND (g.effect='deny' OR rc.effect='deny')
        AND (g.principal_id=? OR (g.principal_type='team' AND EXISTS (SELECT 1 FROM team_members tm WHERE tm.account_id=? AND tm.team_id=g.principal_id AND tm.principal_id=?)))`,
    accountId, repoId, now(), owner.principal_id, accountId, owner.principal_id);
    const blocked = denials.some(denial => {
      const conditions = JSON.parse(denial.conditions_json) as { expires_at?: string };
      return (!conditions.expires_at || conditions.expires_at > now()) && recoveryCapabilities.some(capability => capabilityMatches(denial.capability, capability));
    });
    if (!blocked) return;
  }
  throw new ApiError(409, 'recovery_path_required', 'This change would remove the last effective organization recovery path.');
}

export function concreteCapabilities(values: RoleCapability[]): boolean {
  return values.every(value => !value.capability.includes('*'));
}

export function capabilitySubset(requested: string[], allowed: string[]): boolean {
  return requested.every(capability => capabilityCovered(allowed, capability));
}
