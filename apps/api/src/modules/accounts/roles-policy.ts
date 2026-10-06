import { z } from 'zod';
import { identityDatabase as database, readRepositoryAuthority } from '@gitknot/core/authority';
import { ApiError, accountPolicySchema, authorize, capabilityCatalog, capabilityCovered, capabilityPatternSchema, expectedRevision, getRepository, grantConditionsSchema,
  jsonBody, listResponse, many, newId, now, one, page, readAccountPolicy, requirePrincipal, route, stmt,
  type AccountPolicy, type App, type AppContext, type AuthorizationScope } from '@gitknot/core';
import { checkedWrite } from '@gitknot/core/auth';
import { commitIdentity, idSchema, revisionResponse } from '../identity/shared.ts';
import { accountAccess, assertDelegable, bumpAccountPolicy, guardOwnerDenial, recoveryCapabilities, scopedRole, type RoleCapability, type RoleRecord } from './shared.ts';
import { requireAccountGrantAdmission } from './billing.ts';

const roleCapabilitiesSchema = z.array(z.object({ capability: capabilityPatternSchema.refine(value => !value.includes('*'), 'Custom roles use explicit capabilities.'),
  effect: z.enum(['allow', 'deny']).default('allow') }).strict()).min(1).max(64);
const roleSchema = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(1000).default(''), capabilities: roleCapabilitiesSchema }).strict();
export const grantSchema = z.object({
  principal_type: z.enum(['user', 'team', 'application', 'service', 'agent', 'runner', 'job', 'viewer']), principal_id: idSchema,
  role_id: z.string().min(1).max(128).optional(), capability: capabilityPatternSchema.optional(), effect: z.enum(['allow', 'deny']).default('allow'),
  conditions: grantConditionsSchema.default({}), expires_at: z.iso.datetime().nullable().default(null),
}).strict().refine(value => !!value.role_id !== !!value.capability, 'Supply exactly one role_id or capability.');
export type GrantInput = z.infer<typeof grantSchema>;
export interface GrantRecord { id: string; account_id: string; repo_id: string | null; principal_type: string; principal_id: string; role_id: string | null;
  capability: string | null; effect: 'allow' | 'deny'; conditions_json: string; expires_at: string | null; revoked_at: string | null;
  revision: number; created_by: string; created_at: string; updated_at: string }

export function publicGrant(row: GrantRecord): Record<string, unknown> & { revision: number } {
  return { id: row.id, account_id: row.account_id, repo_id: row.repo_id, principal_type: row.principal_type, principal_id: row.principal_id,
    role_id: row.role_id, capability: row.capability, effect: row.effect, conditions: JSON.parse(row.conditions_json) as unknown,
    expires_at: row.expires_at, revision: row.revision, created_at: row.created_at, updated_at: row.updated_at };
}

export async function validateGrant(c: AppContext, body: GrantInput, scope: { account_id: string; repo_id?: string }): Promise<RoleCapability[]> {
  if (body.expires_at && body.expires_at <= now()) throw new ApiError(422, 'grant_expired', 'The grant expiration must be in the future.');
  if (body.principal_type === 'team') {
    if (!await one(database(c), 'SELECT id FROM teams WHERE id=? AND account_id=?', body.principal_id, scope.account_id)) throw new ApiError(422, 'team_outside_scope', 'The team must belong to this account.');
  } else {
    const principal = await one<{ account_id: string | null; kind: string }>(database(c), 'SELECT account_id,kind FROM principals WHERE id=? AND kind=? AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at>?)',
      body.principal_id, body.principal_type, now());
    if (!principal || principal.kind !== 'user' && principal.account_id !== scope.account_id) throw new ApiError(422, 'principal_outside_scope', 'The principal must be an active person or an identity of this account.');
  }
  if (body.role_id === 'owner') throw new ApiError(422, 'owner_membership_required', 'Account owners must be assigned through verified organization membership.');
  const role = body.role_id ? await scopedRole(c, body.role_id, scope.account_id, scope.repo_id ?? null) : null;
  const capabilities: RoleCapability[] = role ? role.capabilities.map(entry => ({ capability: entry.capability, effect: body.effect === 'deny' ? 'deny' : entry.effect }))
    : [{ capability: body.capability!, effect: body.effect }];
  await assertDelegable(c, capabilities, scope);
  await guardOwnerDenial(c, scope.account_id, body.principal_type, body.principal_id, capabilities, scope.repo_id ?? null);
  return capabilities;
}

async function roleScope(c: AppContext, repository: boolean, capability: string): Promise<{ account_id: string; repo_id?: string; authorization: Awaited<ReturnType<typeof authorize>> }> {
  if (repository) {
    const repo = await getRepository(c, c.req.param('id'), capability);
    return { account_id: repo.owner_id, repo_id: repo.id, authorization: await authorize(c, capability, { repo_id: repo.id }) };
  }
  const { account, authorization } = await accountAccess(c, c.req.param('id'), capability);
  return { account_id: account.id, authorization };
}

function scopeChanges(c: AppContext, scope: AuthorizationScope): D1PreparedStatement[] {
  return [bumpAccountPolicy(c, scope.account_id!)];
}

function registerRoleScope(app: App, path: string, repository: boolean): void {
  route(app, 'GET', path, { summary: 'List built-in and scoped custom roles', tags: ['permissions'], capability: 'roles.read' }, async c => {
    const scope = await roleScope(c, repository, 'roles.read');
    const { limit, cursor } = page(c);
    const rows = await many<RoleRecord>(database(c), 'SELECT * FROM roles WHERE (built_in=1 OR (account_id=? AND (repo_id IS NULL OR repo_id=?))) AND id>? ORDER BY id LIMIT ?',
      scope.account_id, scope.repo_id ?? null, cursor ?? '', limit + 1);
    const items = await Promise.all(rows.slice(0, limit).map(row => scopedRole(c, row.id, scope.account_id, scope.repo_id ?? null)));
    return listResponse(c, items.map(role => ({ ...role, built_in: role.built_in === 1 })), rows.length > limit ? rows[limit - 1]!.id : null);
  });

  route(app, 'POST', path, { summary: 'Create a scoped custom role', tags: ['permissions'], body: roleSchema, capability: 'roles.manage' }, async c => {
    const scope = await roleScope(c, repository, 'roles.manage');
    const body = await jsonBody(c, roleSchema);
    await assertDelegable(c, body.capabilities, scope);
    const id = newId('role');
    const timestamp = now();
    await commitIdentity(c, [stmt(database(c), 'INSERT INTO roles(id,account_id,repo_id,name,description,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      id, scope.account_id, scope.repo_id ?? null, body.name, body.description, requirePrincipal(c).id, timestamp, timestamp),
    ...body.capabilities.map(entry => stmt(database(c), 'INSERT INTO role_capabilities(role_id,capability,effect) VALUES (?,?,?)', id, entry.capability, entry.effect)),
    ...scopeChanges(c, scope)], { type: 'role.created', resource_id: id, resource_revision: 1, account_id: scope.account_id, repo_id: scope.repo_id }, { authorizations: [scope.authorization] });
    return revisionResponse(c, { id, account_id: scope.account_id, repo_id: scope.repo_id ?? null, ...body, built_in: false, revision: 1, created_at: timestamp, updated_at: timestamp }, 201);
  });

  route(app, 'GET', `${path}/:roleId`, { summary: 'Read a role and its explicit capabilities', tags: ['permissions'], capability: 'roles.read' }, async c => {
    const scope = await roleScope(c, repository, 'roles.read');
    const role = await scopedRole(c, c.req.param('roleId'), scope.account_id, scope.repo_id ?? null);
    return revisionResponse(c, { ...role, built_in: role.built_in === 1 });
  });

  route(app, 'PUT', `${path}/:roleId`, { summary: 'Replace a scoped custom role', tags: ['permissions'], body: roleSchema, capability: 'roles.manage' }, async c => {
    const scope = await roleScope(c, repository, 'roles.manage');
    const role = await scopedRole(c, c.req.param('roleId'), scope.account_id, scope.repo_id ?? null);
    if (role.built_in || role.account_id !== scope.account_id || role.repo_id !== (scope.repo_id ?? null)) throw new ApiError(403, 'role_immutable', 'Built-in and inherited roles cannot be edited here.');
    const body = await jsonBody(c, roleSchema);
    const revision = expectedRevision(c);
    await assertDelegable(c, body.capabilities, scope);
    if (body.capabilities.some(entry => entry.effect === 'deny')) {
      const grants = await many<{ principal_type: string; principal_id: string }>(database(c), 'SELECT principal_type,principal_id FROM access_grants WHERE account_id=? AND role_id=? AND revoked_at IS NULL', scope.account_id, role.id);
      for (const grant of grants) await guardOwnerDenial(c, scope.account_id, grant.principal_type, grant.principal_id, body.capabilities);
    }
    await commitIdentity(c, [...checkedWrite(database(c), stmt(database(c), 'UPDATE roles SET name=?,description=?,revision=revision+1,updated_at=? WHERE id=? AND account_id=? AND revision=? AND built_in=0',
      body.name, body.description, now(), role.id, scope.account_id, revision)), stmt(database(c), 'DELETE FROM role_capabilities WHERE role_id=?', role.id),
    ...body.capabilities.map(entry => stmt(database(c), 'INSERT INTO role_capabilities(role_id,capability,effect) VALUES (?,?,?)', role.id, entry.capability, entry.effect)),
    ...scopeChanges(c, scope)], { type: 'role.updated', resource_id: role.id, resource_revision: revision + 1, account_id: scope.account_id, repo_id: scope.repo_id }, { authorizations: [scope.authorization] });
    return revisionResponse(c, { ...role, ...body, built_in: false, revision: revision + 1, updated_at: now() });
  });

  route(app, 'DELETE', `${path}/:roleId`, { summary: 'Delete an unused custom role', tags: ['permissions'], capability: 'roles.manage' }, async c => {
    const scope = await roleScope(c, repository, 'roles.manage');
    const role = await scopedRole(c, c.req.param('roleId'), scope.account_id, scope.repo_id ?? null);
    if (role.built_in || role.repo_id !== (scope.repo_id ?? null)) throw new ApiError(403, 'role_immutable', 'Built-in and inherited roles cannot be deleted here.');
    const used = await one(database(c), `SELECT 1 FROM memberships WHERE role_id=? UNION ALL SELECT 1 FROM access_grants WHERE role_id=?
      UNION ALL SELECT 1 FROM invitations WHERE role_id=? LIMIT 1`, role.id, role.id, role.id);
    if (used) throw new ApiError(409, 'role_in_use', 'Reassign memberships, grants, and invitations before deleting this role.');
    const revision = expectedRevision(c);
    await commitIdentity(c, [...checkedWrite(database(c), stmt(database(c), 'DELETE FROM roles WHERE id=? AND account_id=? AND revision=? AND built_in=0', role.id, scope.account_id, revision)),
      ...scopeChanges(c, scope)], { type: 'role.deleted', resource_id: role.id, resource_revision: revision + 1, account_id: scope.account_id, repo_id: scope.repo_id }, { authorizations: [scope.authorization] });
    return c.body(null, 204);
  });
}

async function policyProblems(c: AppContext, accountId: string, policy: AccountPolicy): Promise<Array<{ code: string; message: string }>> {
  const problems: Array<{ code: string; message: string }> = [];
  if (!policy.allowed_credential_kinds.includes('session') || recoveryCapabilities.some(capability =>
    capabilityCovered(policy.denied_capabilities, capability) || policy.allowed_capabilities !== null && !capabilityCovered(policy.allowed_capabilities, capability))) {
    problems.push({ code: 'recovery_path_required', message: 'The policy must preserve owner recovery capabilities and human session access.' });
  }
  const hints = await many<{ id: string }>(database(c), `SELECT id FROM repositories WHERE owner_id=?
    UNION SELECT repo_id AS id FROM account_authority_repositories WHERE account_id=?`, accountId, accountId);
  const current = await Promise.all(hints.map(row => readRepositoryAuthority(c, row.id)));
  if (current.some(row => row?.owner_id === accountId && row.state !== 'deleted' && !policy.allowed_repository_visibilities.includes(row.visibility))) {
    problems.push({ code: 'existing_visibility_conflict', message: 'Update existing repositories before excluding their visibility modes.' });
  }
  if (policy.require_mfa) {
    const owner = await one(database(c), `SELECT 1 FROM memberships m JOIN users u ON u.id=m.principal_id JOIN principals p ON p.id=u.id
      WHERE m.account_id=? AND m.role_id='owner' AND m.state='active' AND u.disabled_at IS NULL AND p.disabled_at IS NULL
        AND u.email_verified_at IS NOT NULL AND (EXISTS (SELECT 1 FROM passkeys k WHERE k.user_id=u.id)
        OR EXISTS (SELECT 1 FROM user_mfa f WHERE f.user_id=u.id AND f.enabled_at IS NOT NULL)) LIMIT 1`, accountId);
    if (!owner) problems.push({ code: 'owner_mfa_required', message: 'At least one recoverable owner must register a passkey or authenticator before requiring MFA.' });
  }
  return problems;
}

function registerPolicyScope(app: App, path: string): void {
  route(app, 'GET', path, { summary: 'Read account policy and credential ceilings', tags: ['permissions'], capability: 'policy.read' }, async c => {
    const { account } = await accountAccess(c, c.req.param('id'), 'policy.read');
    const result = await readAccountPolicy(database(c), account.id);
    return revisionResponse(c, { account_id: account.id, ...result, account_policy_revision: account.policy_revision });
  });
  route(app, 'POST', `${path}/preview`, { summary: 'Validate an account policy before publication', tags: ['permissions'], body: accountPolicySchema, capability: 'policy.manage' }, async c => {
    const { account } = await accountAccess(c, c.req.param('id'), 'policy.manage');
    const policy = await jsonBody(c, accountPolicySchema);
    const problems = await policyProblems(c, account.id, policy);
    return c.json({ valid: !problems.length, policy, problems, account_policy_revision: account.policy_revision });
  });
  route(app, 'PUT', path, { summary: 'Publish an account policy with a revision precondition', tags: ['permissions'], body: accountPolicySchema, capability: 'policy.manage' }, async c => {
    const { account, authorization } = await accountAccess(c, c.req.param('id'), 'policy.manage');
    const policy = await jsonBody(c, accountPolicySchema);
    const revision = expectedRevision(c);
    const problems = await policyProblems(c, account.id, policy);
    if (problems.length) throw new ApiError(422, 'policy_conflict', 'This policy has conflicting or unrecoverable requirements.', { problems });
    await commitIdentity(c, [...checkedWrite(database(c), stmt(database(c),
      'UPDATE account_policies SET config_json=?,revision=revision+1,updated_by=?,updated_at=? WHERE account_id=? AND revision=?',
      JSON.stringify(policy), requirePrincipal(c).id, now(), account.id, revision)), bumpAccountPolicy(c, account.id)],
    { type: 'account.policy_updated', resource_id: account.id, resource_revision: account.revision + 1, account_id: account.id,
      data: { policy_revision: account.policy_revision + 1 } }, { authorizations: [authorization], before_commit: async () => {
        const currentProblems = await policyProblems(c, account.id, policy);
        if (currentProblems.length) throw new ApiError(422, 'policy_conflict', 'This policy has conflicting or unrecoverable requirements.', { problems: currentProblems });
      } });
    return revisionResponse(c, { account_id: account.id, policy, revision: revision + 1, account_policy_revision: account.policy_revision + 1 });
  });
}

export function registerAccountPermissionRoutes(app: App): void {
  route(app, 'GET', '/v1/capabilities', { summary: 'Discover GitKnot capabilities and permission semantics', tags: ['permissions'], public: true }, c =>
    c.json({ items: capabilityCatalog.map(capability => ({ capability })), next_cursor: null,
      explicit_denials_win: true, content_reads_include_history: true, credential_scopes_intersect_grants: true }));
  registerRoleScope(app, '/v1/accounts/:id/roles', false);
  registerRoleScope(app, '/v1/orgs/:id/roles', false);
  registerRoleScope(app, '/v1/repos/:id/roles', true);
  registerPolicyScope(app, '/v1/accounts/:id/policy');
  registerPolicyScope(app, '/v1/orgs/:id/policy');

  route(app, 'GET', '/v1/accounts/:id/grants', { summary: 'List explicit account grants and denials', tags: ['permissions'], capability: 'permissions.read' }, async c => {
    const { account } = await accountAccess(c, c.req.param('id'), 'permissions.read');
    const { limit, cursor } = page(c);
    const rows = await many<GrantRecord>(database(c), 'SELECT * FROM access_grants WHERE account_id=? AND repo_id IS NULL AND revoked_at IS NULL AND id>? ORDER BY id LIMIT ?', account.id, cursor ?? '', limit + 1);
    return listResponse(c, rows.slice(0, limit).map(publicGrant), rows.length > limit ? rows[limit - 1]!.id : null);
  });
  route(app, 'POST', '/v1/accounts/:id/grants', { summary: 'Create an explicit scoped account grant or denial', tags: ['permissions'], body: grantSchema, capability: 'permissions.manage' }, async c => {
    const { account, authorization } = await accountAccess(c, c.req.param('id'), 'permissions.manage');
    const body = await jsonBody(c, grantSchema);
    const capabilities = await validateGrant(c, body, { account_id: account.id });
    const admission = body.principal_type === 'user' && capabilities.some(value => value.effect === 'allow')
      ? await requireAccountGrantAdmission(c, account.id, body.principal_id) : [];
    const id = newId('grant');
    const timestamp = now();
    await commitIdentity(c, [...admission, stmt(database(c), `INSERT INTO access_grants(id,account_id,principal_type,principal_id,role_id,capability,effect,conditions_json,expires_at,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, id, account.id, body.principal_type, body.principal_id, body.role_id ?? null, body.capability ?? null,
    body.effect, JSON.stringify(body.conditions), body.expires_at, requirePrincipal(c).id, timestamp, timestamp), bumpAccountPolicy(c, account.id)],
    { type: 'account.grant_created', resource_id: id, resource_revision: 1, account_id: account.id }, { authorizations: [authorization] });
    return revisionResponse(c, { id, account_id: account.id, repo_id: null, ...body, revision: 1, created_at: timestamp, updated_at: timestamp }, 201);
  });
  route(app, 'DELETE', '/v1/accounts/:id/grants/:grantId', { summary: 'Revoke an account grant or denial', tags: ['permissions'], capability: 'permissions.manage' }, async c => {
    const { account, authorization } = await accountAccess(c, c.req.param('id'), 'permissions.manage');
    const revision = expectedRevision(c);
    await commitIdentity(c, [...checkedWrite(database(c), stmt(database(c), 'UPDATE access_grants SET revoked_at=?,revision=revision+1,updated_at=? WHERE id=? AND account_id=? AND repo_id IS NULL AND revision=? AND revoked_at IS NULL',
      now(), now(), c.req.param('grantId'), account.id, revision)), bumpAccountPolicy(c, account.id)],
    { type: 'account.grant_revoked', resource_id: c.req.param('grantId')!, resource_revision: revision + 1, account_id: account.id }, { authorizations: [authorization] });
    return c.body(null, 204);
  });
}
