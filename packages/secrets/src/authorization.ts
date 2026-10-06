import { ApiError, explainAuthorization, many, now, one, patternMatches, stmt, identityDatabase, readRepositoryAuthority, currentAccountAuthority } from '@gitknot/core';
import type { AppContext, Bindings, Database, Principal } from '@gitknot/core';
import { vaultPolicySchema } from './schema.ts';
import type { BrokerClient, ScopeSelector, SelectionContext, VaultEntry, VaultScope } from './types.ts';
import { vaultMetadata } from './authority.ts';

interface EnvironmentScope { account_id: string; repo_id: string; state: string; deleted_at: string | null }

function requireActiveEnvironment(environment: EnvironmentScope): void {
  if (environment.state !== 'active' || environment.deleted_at !== null) throw new ApiError(409, 'environment_deleted', 'This environment is retired and cannot accept new vault writes or selections.');
}

export async function assertActiveVaultEnvironment(env: Bindings, scope: Pick<VaultScope, 'account_id' | 'repo_id' | 'environment_id'>): Promise<void> {
  if (!scope.environment_id) return;
  const environment = await vaultMetadata<EnvironmentScope | null>(env, { action: 'environment', resource_id: scope.environment_id, repo_id: scope.repo_id! });
  if (!environment || environment.account_id !== scope.account_id || environment.repo_id !== scope.repo_id) throw new ApiError(404, 'not_found', 'The requested environment was not found.');
  requireActiveEnvironment(environment);
}

export async function resolveVaultScope(c: AppContext, selector: ScopeSelector, allowRetiredEnvironment = false): Promise<VaultScope> {
  const db = identityDatabase(c);
  if (selector.repo_id) {
    const repo = await readRepositoryAuthority(c, selector.repo_id);
    if (!repo) throw new ApiError(404, 'not_found', 'The requested resource was not found.');
    if (selector.environment_id) {
      const environment = await vaultMetadata<EnvironmentScope | null>(c.env, { action: 'environment', resource_id: selector.environment_id, repo_id: repo.id });
      if (!environment || environment.account_id !== repo.owner_id || environment.repo_id !== repo.id) throw new ApiError(404, 'not_found', 'The requested environment was not found.');
      if (!allowRetiredEnvironment) requireActiveEnvironment(environment);
    }
    return { account_id: repo.owner_id, repo_id: repo.id, environment_id: selector.environment_id ?? null,
      scope_type: selector.environment_id ? 'environment' : 'repository', scope_id: selector.environment_id ?? repo.id };
  }
  const account = await one<{ id: string; type: 'user' | 'organization' }>(db, 'SELECT id,type FROM accounts WHERE id=? AND disabled_at IS NULL', selector.account_id);
  if (!account) throw new ApiError(404, 'not_found', 'The requested account was not found.');
  return { account_id: account.id, repo_id: null, environment_id: null, scope_type: account.type, scope_id: account.id };
}

export function checkClientScope(client: BrokerClient, scope: Pick<VaultScope, 'account_id' | 'repo_id'>): void {
  if ((client.account_ids !== null && !client.account_ids.includes(scope.account_id))
    || (client.repository_ids !== null && (!scope.repo_id || !client.repository_ids.includes(scope.repo_id)))) {
    throw new ApiError(403, 'service_scope_denied', 'This service identity is not allowed to operate on the requested resource.');
  }
}

export async function authorizeVault(c: AppContext, principal: Principal, capability: string, scope: Pick<VaultScope, 'account_id' | 'repo_id'>, revocation = false): Promise<void> {
  const current = scope.repo_id ? await readRepositoryAuthority(c, scope.repo_id) : null;
  if (scope.repo_id && (!current || current.owner_id !== scope.account_id)) throw new ApiError(404, 'not_found', 'The requested resource was not found.');
  const explanation = await explainAuthorization(c, capability, { account_id: scope.account_id, ...(scope.repo_id ? { repo_id: scope.repo_id } : {}) }, principal);
  if (current && (explanation.routing_epoch !== current.routing_epoch || explanation.repository_revision !== current.revision)) {
    throw new ApiError(503, 'authorization_authority_changed', 'The current authorization authority could not be verified.');
  }
  if (explanation.allowed) return;
  // Revocation remains available through archive/transfer fencing, but only if the capability itself is still granted.
  if (revocation && explanation.matched_grants.some((grant) => grant.effect === 'allow')
    && explanation.reasons.every((reason) => ['repository_archived', 'transfer_pending', 'repository_deleted', 'repository_unavailable'].includes(reason.code))) return;
  throw new ApiError(scope.repo_id ? 404 : 403, scope.repo_id ? 'not_found' : 'permission_denied',
    scope.repo_id ? 'The requested resource was not found.' : 'Current permissions do not permit this vault operation.');
}

export function assertUsePolicy(entry: VaultEntry, context: SelectionContext, at = now()): void {
  const result = vaultPolicySchema.safeParse(JSON.parse(entry.policy_json));
  if (!result.success) throw new ApiError(503, 'vault_policy_unavailable', 'A vault access policy could not be verified.');
  const p = result.data;
  const matches = (list: string[] | null, value: string | null) => list === null || (value !== null && list.includes(value));
  const denied = !p.enabled || entry.deleted_at !== null || !p.repository_ids.includes(context.repo_id)
    || !matches(p.workflow_ids, context.workflow_id) || !matches(p.actor_ids, context.actor_id) || !matches(p.environment_ids, context.environment_id)
    || (p.refs !== null && !p.refs.some((ref) => patternMatches(ref, context.ref)))
    || (!!p.not_before && at < p.not_before) || (!!p.expires_at && at >= p.expires_at)
    || (p.require_environment && !context.environment_id)
    || (entry.environment_id !== null && entry.environment_id !== context.environment_id)
    || (entry.repo_id !== null && entry.repo_id !== context.repo_id)
    || (entry.account_id !== context.account_id && (!p.allow_cross_account || entry.scope_type !== 'user'));
  const secretDenied = entry.kind === 'secret' && (context.trust_class !== 'trusted'
    || (context.executor === 'self_hosted' && (!p.allow_self_hosted || !context.runner_pool_id || !p.runner_pool_ids.includes(context.runner_pool_id))));
  if (denied || secretDenied) throw new ApiError(403, 'secret_policy_denied', 'A selected name is unavailable under the current execution policy.');
}

/** A single SQL value witnesses every mutable input to core authorization for this account/principal. */
const witnessSql = `WITH RECURSIVE args AS (SELECT ? AS account_id,? AS principal_id,? AS user_id,? AS credential_id,? AS repo_id),
  chain AS (SELECT c.*,0 AS depth FROM credentials c,args WHERE c.id=args.credential_id
    UNION ALL SELECT c.*,chain.depth+1 FROM credentials c JOIN chain ON c.id=chain.parent_id WHERE chain.depth<8)
  SELECT json_object(
    'account',(SELECT json_array(id,revision,policy_revision,disabled_at,owner_user_id) FROM accounts,args WHERE id=args.account_id),
    'epoch',(SELECT json_array(e.epoch,e.policy_revision,e.phase,e.barrier_id) FROM account_authority_epochs e,args WHERE e.account_id=args.account_id),
    'principal',(SELECT json_array(p.id,p.kind,p.user_id,p.revision,p.disabled_at,p.expires_at,
      p.expires_at IS NULL OR p.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) FROM principals p,args WHERE p.id=args.principal_id),
    'user',(SELECT json_array(id,revision,auth_revision,disabled_at,email_verified_at) FROM users,args WHERE id=args.user_id),
    'policy',(SELECT json_array(revision,config_json) FROM account_policies,args WHERE account_policies.account_id=args.account_id),
    'barrier',(SELECT json_array(b.id,b.previous_policy_revision,b.recover_after,b.created_at) FROM account_policy_barriers b,args WHERE b.account_id=args.account_id),
    'sso_policy',(SELECT json_array(p.revision,p.config_json) FROM federation_org_policies p,args WHERE p.account_id=args.account_id),
    'sso_grants',(SELECT json_group_array(json_array(g.credential_id,g.provider_id,g.provider_revision,g.policy_revision,g.revoked_at,g.expires_at,
      g.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'),p.revision,p.enabled,p.deleted_at))
      FROM federation_session_grants g JOIN federation_providers p ON p.id=g.provider_id,args
      WHERE g.account_id=args.account_id AND g.credential_id IN (SELECT id FROM chain)),
    'memberships',(SELECT json_group_array(json_array(account_id,principal_id,role_id,state,revision)) FROM
      (SELECT m.* FROM memberships m,args WHERE m.account_id=args.account_id AND m.principal_id=args.principal_id ORDER BY m.account_id)),
    'teams',(SELECT json_group_array(json_array(team_id,principal_id,role,revision)) FROM
      (SELECT tm.* FROM team_members tm,args WHERE tm.account_id=args.account_id AND tm.principal_id=args.principal_id ORDER BY tm.team_id)),
    'grants',(SELECT json_group_array(json_array(id,principal_id,role_id,capability,effect,conditions_json,expires_at,revoked_at,revision,
      expires_at IS NULL OR expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      COALESCE(json_extract(conditions_json,'$.not_before'),'')<=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      COALESCE(json_extract(conditions_json,'$.expires_at'),'9999')>strftime('%Y-%m-%dT%H:%M:%fZ','now'))) FROM
      (SELECT g.* FROM access_grants g,args WHERE g.account_id=args.account_id AND (g.repo_id IS NULL OR g.repo_id=args.repo_id)
        AND (g.principal_id=args.principal_id OR g.principal_id IN (SELECT team_id FROM team_members tm WHERE tm.account_id=args.account_id AND tm.principal_id=args.principal_id)) ORDER BY g.id)),
    'roles',(SELECT json_group_array(json_array(role_id,capability,effect,revision)) FROM
      (SELECT rc.*,r.revision FROM role_capabilities rc JOIN roles r ON r.id=rc.role_id,args
        WHERE r.built_in=1 OR r.account_id=args.account_id ORDER BY rc.role_id,rc.capability,rc.effect)),
    'credentials',(SELECT json_group_array(json_array(c.id,c.revision,c.principal_id,c.parent_id,c.revoked_at,c.expires_at,c.mfa,c.capabilities_json,c.account_ids_json,c.repository_ids_json,
      c.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      p.revision,p.disabled_at,p.expires_at,u.auth_revision,u.disabled_at,a.disabled_at)) FROM chain c
      JOIN principals p ON p.id=c.principal_id LEFT JOIN users u ON u.id=c.user_id LEFT JOIN accounts a ON a.id=p.account_id),
    'installation',(SELECT json_array(i.revision,i.suspended_at,i.capabilities_json,i.repository_ids_json,a.revision,a.disabled_at)
      FROM installations i JOIN applications a ON a.id=i.application_id,args WHERE i.id=args.principal_id)
  ) AS witness`;

export interface AuthorizationWitness { sql: string; bindings: unknown[]; value: string; dependencies?: AuthorizationWitness[] }

export async function authorizationWitness(c: AppContext, principal: Principal, scope: Pick<VaultScope, 'account_id' | 'repo_id'>,
  visited = new Set<string>(), options: { readOnly?: boolean } = {}): Promise<AuthorizationWitness> {
  const db = identityDatabase(c);
  if (!options.readOnly) await currentAccountAuthority(c.env, scope.account_id);
  const bindings = [scope.account_id, principal.id, principal.user_id, principal.credential_id, scope.repo_id];
  const row = await one<{ witness: string }>(db, witnessSql, ...bindings);
  if (!row) throw new ApiError(503, 'authorization_unavailable', 'Current authorization state could not be witnessed.');
  if (options.readOnly) {
    const state = JSON.parse(row.witness) as { account: [string, number, number, string | null] | null; epoch: [number, number, string, string | null] | null; barrier: unknown };
    if (!state.account || state.account[3] !== null || state.barrier || state.epoch && (state.epoch[2] !== 'active' || state.epoch[3] !== null || state.epoch[1] !== state.account[2])) {
      throw new ApiError(409, 'preview_authority_unavailable', 'The current account authority must be reconciled before preview.');
    }
  }
  const witness: AuthorizationWitness = { sql: witnessSql, bindings, value: row.witness };
  if (scope.repo_id) {
    if (visited.has(scope.repo_id) || visited.size >= 32) throw new ApiError(503, 'fork_authority_unavailable', 'The current fork audience could not be verified.');
    const repository = await readRepositoryAuthority(c, scope.repo_id);
    if (!repository || repository.owner_id !== scope.account_id) throw new ApiError(409, 'repository_authority_changed', 'The repository authority changed.');
    if (repository.fork_source_id) {
      const source = await readRepositoryAuthority(c, repository.fork_source_id);
      if (!source) throw new ApiError(404, 'not_found', 'The current fork source was not found.');
      witness.dependencies = [await authorizationWitness(c, principal, { account_id: source.owner_id, repo_id: source.id }, new Set(visited).add(repository.id), options)];
    }
  }
  return witness;
}

export function witnessStatement(db: Database, id: string, witness: AuthorizationWitness): D1PreparedStatement {
  return stmt(db, `INSERT INTO vault_write_guards (id,valid) SELECT ?,CASE WHEN (?=(${witness.sql})) THEN 1 ELSE 0 END`, id, witness.value, ...witness.bindings);
}

export async function currentRuntimePrincipal(db: Database, actor: { actor_id: string; actor_kind: Principal['kind']; actor_user_id: string | null; actor_credential_id: string | null }): Promise<Principal> {
  const principal = await one<{ id: string; kind: Principal['kind']; user_id: string | null }>(db,
    'SELECT id,kind,user_id FROM principals WHERE id=? AND kind=? AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at>?)', actor.actor_id, actor.actor_kind, now());
  if (!principal || principal.user_id !== actor.actor_user_id) throw new ApiError(403, 'actor_inactive', 'The execution actor is no longer current.');
  const credential = actor.actor_credential_id ? await one<{ mfa: number }>(db, 'SELECT mfa FROM credentials WHERE id=? AND principal_id=?', actor.actor_credential_id, actor.actor_id) : null;
  if (actor.actor_credential_id && !credential) throw new ApiError(403, 'credential_inactive', 'The initiating credential is no longer available.');
  return { ...principal, credential_id: actor.actor_credential_id, capabilities: null, repository_ids: null, account_ids: null, mfa: credential?.mfa === 1 };
}
