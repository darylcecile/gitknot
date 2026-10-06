import { z } from 'zod';
import { enforceOrganizationSso, isFederationSession } from '@gitknot/federation/integration';
import { credentialIsCurrent, credentialScope, currentCredentialChain, type CredentialRecord, type UserRecord } from './auth.ts';
import { now } from './crypto.ts';
import { many, one } from './db.ts';
import { captureAccountAuthority, identityDatabase, readRepositoryAuthority, separateIdentityAuthority } from './authority.ts';
import { ApiError } from './errors.ts';
import { captureMutationAuthority, recordRequestPolicy } from './http.ts';
import type { AppContext, Database, Principal, PrincipalKind, Repository } from './types.ts';

export const capabilityPatternSchema = z.string().max(100).regex(/^(?:\*|[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*(?:\.(?:[a-z][a-z0-9_]*|\*)))$/);
export const resourcePatternSchema = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f\\]/.test(value), 'Patterns must contain printable forward-slash paths.');
export const grantConditionsSchema = z.object({
  refs: z.array(resourcePatternSchema).min(1).max(64).optional(),
  paths: z.array(resourcePatternSchema).min(1).max(64).optional(),
  require_mfa: z.boolean().optional(),
  not_before: z.iso.datetime().optional(),
  expires_at: z.iso.datetime().optional(),
}).strict().refine(value => !value.not_before || !value.expires_at || value.not_before < value.expires_at,
  'expires_at must be later than not_before.');
export type GrantConditions = z.infer<typeof grantConditionsSchema>;

export const accountPolicySchema = z.object({
  version: z.literal(1).default(1),
  allowed_capabilities: z.array(capabilityPatternSchema).max(256).nullable().default(null),
  denied_capabilities: z.array(capabilityPatternSchema).max(256).default([]),
  require_mfa: z.boolean().default(false),
  require_verified_email: z.boolean().default(true),
  allow_outside_collaborators: z.boolean().default(true),
  allowed_repository_visibilities: z.array(z.enum(['public', 'private', 'internal', 'unlisted'])).min(1).max(4).default(['public', 'private', 'internal', 'unlisted']),
  default_repository_visibility: z.enum(['public', 'private', 'internal', 'unlisted']).default('private'),
  default_repository_creator_role: z.enum(['administrator', 'maintainer', 'contributor']).default('administrator'),
  maximum_token_lifetime_seconds: z.number().int().min(300).max(31_536_000).default(7_776_000),
  allowed_credential_kinds: z.array(z.enum(['session', 'personal', 'installation', 'service', 'agent', 'runner', 'job', 'viewer'])).min(1).max(8)
    .default(['session', 'personal', 'installation', 'service', 'agent', 'runner', 'job', 'viewer']),
  allowed_email_domains: z.array(z.string().max(253).regex(/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/)).max(100).default([]),
  allow_public_forks: z.boolean().default(true),
}).strict().refine(value => value.allowed_repository_visibilities.includes(value.default_repository_visibility),
  'The default visibility must be allowed by the policy.');
export type AccountPolicy = z.infer<typeof accountPolicySchema>;

export interface AccountRecord {
  id: string;
  type: 'user' | 'organization';
  slug: string;
  name: string;
  owner_user_id: string | null;
  description: string;
  disabled_at: string | null;
  policy_revision: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface AuthorizationScope { repo_id?: string; account_id?: string; ref?: string; paths?: string[] }
export interface PermissionReason { code: string; message: string; source?: string }
export interface MatchedGrant { id: string; capability: string; effect: 'allow' | 'deny'; source: 'ownership' | 'membership' | 'grant' | 'visibility'; conditions?: GrantConditions }
export interface PermissionExplanation {
  allowed: boolean;
  capability: string;
  principal_id: string | null;
  repo_id: string | null;
  account_id: string | null;
  repository_revision: number | null;
  policy_revision: number | null;
  account_policy_revision: number | null;
  routing_epoch: number | null;
  matched_grants: MatchedGrant[];
  reasons: PermissionReason[];
  requirements: string[];
  evaluated_at: string;
}

const publicReadCapabilities = new Set([
  'repositories.read', 'contents.read', 'issues.read', 'pull_requests.read', 'discussions.read', 'tasks.read',
  'workflows.read', 'runs.read', 'releases.read', 'lfs.read', 'attachments.read', 'search.read', 'rules.read',
  'checks.read', 'logs.read', 'outputs.read', 'environments.read',
]);
const archivedAdministrativeCapabilities = new Set([
  'repositories.manage', 'repositories.unarchive', 'repositories.archive', 'repositories.delete', 'repositories.transfer',
  'repositories.export', 'repositories.restore', 'permissions.manage', 'tokens.revoke', 'webhooks.revoke', 'rules.manage', 'roles.manage',
]);

export function capabilityMatches(pattern: string, capability: string): boolean {
  return pattern === '*' || pattern === capability || (pattern.endsWith('.*') && capability.startsWith(pattern.slice(0, -1)));
}

export function capabilityCovered(patterns: string[], capability: string): boolean {
  return patterns.some(pattern => capabilityMatches(pattern, capability));
}

/** Bounded dynamic programming avoids regex denial-of-service from user globs. */
export function patternMatches(pattern: string, value: string): boolean {
  if (pattern === value || pattern === '**') return true;
  if (pattern.length > 256 || value.length > 8192) return false;
  let previous = new Uint8Array(value.length + 1);
  previous[0] = 1;
  for (const character of pattern.match(/\*\*\/|\*\*|\*|\?|[^*?]/gu) ?? []) {
    const star = character.startsWith('*');
    const recursive = character === '**' || character === '**/';
    const row = new Uint8Array(value.length + 1);
    if (star) row[0] = previous[0]!;
    let prefixMatched = previous[0] === 1;
    for (let offset = 1; offset <= value.length; offset++) {
      const allowed = recursive || value[offset - 1] !== '/';
      row[offset] = character === '**/' ? Number(previous[offset] === 1 || value[offset - 1] === '/' && prefixMatched) : star
        ? Number(previous[offset] === 1 || (allowed && row[offset - 1] === 1))
        : Number(previous[offset - 1] === 1 && (character === '?' ? allowed : character === value[offset - 1]));
      prefixMatched ||= previous[offset] === 1;
    }
    previous = row;
  }
  return previous[value.length] === 1;
}

export function isContentWrite(capability: string): boolean {
  return (capability.startsWith('contents.') && capability !== 'contents.read')
    || capability === 'pull_requests.merge' || capability === 'lfs.write';
}

function conditionResult(conditions: GrantConditions, capability: string, scope: AuthorizationScope, principal: Principal | null, effect: 'allow' | 'deny'): { matches: boolean; missing: string[] } {
  const timestamp = now();
  if ((conditions.not_before && timestamp < conditions.not_before) || (conditions.expires_at && timestamp >= conditions.expires_at)) return { matches: false, missing: [] };
  if (conditions.require_mfa && !principal?.mfa) return { matches: false, missing: ['mfa'] };
  if (!isContentWrite(capability)) return { matches: true, missing: [] };
  const missing: string[] = [];
  if (conditions.refs) {
    if (scope.ref === undefined) missing.push('ref');
    else if (!conditions.refs.some(pattern => patternMatches(pattern, scope.ref!))) return { matches: false, missing };
  }
  if (conditions.paths) {
    if (scope.paths === undefined) missing.push('paths');
    else {
      const matches = (path: string) => conditions.paths!.some(pattern => patternMatches(pattern, path));
      if (effect === 'allow' ? !scope.paths.every(matches) : !scope.paths.some(matches)) return { matches: false, missing };
    }
  }
  return { matches: !missing.length || effect === 'deny', missing };
}

export async function readAccountPolicy(db: Database, accountId: string): Promise<{ policy: AccountPolicy; revision: number }> {
  const row = await one<{ config_json: string; revision: number }>(db, 'SELECT config_json,revision FROM account_policies WHERE account_id=?', accountId);
  try { return { policy: accountPolicySchema.parse(row ? JSON.parse(row.config_json) : {}), revision: row?.revision ?? 1 }; }
  catch { throw new ApiError(503, 'policy_unavailable', 'GitKnot could not verify the current account policy.'); }
}

interface CandidateGrant {
  id: string;
  capability: string;
  effect: 'allow' | 'deny';
  role_effect: 'allow' | 'deny' | null;
  conditions_json: string;
  source: MatchedGrant['source'];
}

interface Membership { role_id: string; state: string }

async function candidateGrants(db: Database, principal: Principal, account: AccountRecord, repo: Repository | null): Promise<{ grants: CandidateGrant[]; membership: Membership | null }> {
  const membership = await one<Membership>(db, 'SELECT role_id,state FROM memberships WHERE account_id=? AND principal_id=? AND state=\'active\'', account.id, principal.id);
  const grants: CandidateGrant[] = [];
  if (membership) {
    const capabilities = await many<{ capability: string; effect: 'allow' | 'deny' }>(db,
      `SELECT rc.capability,rc.effect FROM role_capabilities rc JOIN roles r ON r.id=rc.role_id
       WHERE rc.role_id=? AND (r.built_in=1 OR (r.account_id=? AND (r.repo_id IS NULL OR r.repo_id=?)))`,
      membership.role_id, account.id, repo?.id ?? null);
    grants.push(...capabilities.map(row => ({ ...row, id: `membership:${account.id}:${membership.role_id}`, role_effect: null, conditions_json: '{}', source: 'membership' as const })));
  }
  if (account.type === 'user' && account.owner_user_id === principal.user_id && principal.kind === 'user') {
    grants.push({ id: `owner:${account.id}`, capability: '*', effect: 'allow', role_effect: null, conditions_json: '{}', source: 'ownership' });
  }
  const explicit = await many<CandidateGrant>(db, `SELECT g.id,COALESCE(g.capability,rc.capability) AS capability,
      g.effect,rc.effect AS role_effect,g.conditions_json,'grant' AS source
    FROM access_grants g LEFT JOIN roles r ON r.id=g.role_id LEFT JOIN role_capabilities rc ON rc.role_id=g.role_id
    WHERE g.account_id=? AND (g.repo_id IS NULL OR g.repo_id=?) AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR g.expires_at>?)
      AND (g.role_id IS NULL OR r.built_in=1 OR (r.account_id=g.account_id AND (r.repo_id IS NULL OR r.repo_id=g.repo_id)))
      AND (g.repo_id IS NOT NULL OR g.principal_type!='user' OR g.effect='deny' OR rc.effect='deny'
        OR EXISTS (SELECT 1 FROM memberships admitted WHERE admitted.account_id=g.account_id AND admitted.principal_id=g.principal_id AND admitted.state='active'))
      AND ((g.principal_id=? AND g.principal_type=?) OR (g.principal_type='team' AND EXISTS (
        SELECT 1 FROM team_members tm JOIN memberships m ON m.account_id=tm.account_id AND m.principal_id=tm.principal_id
        WHERE tm.account_id=g.account_id AND tm.team_id=g.principal_id AND tm.principal_id=? AND m.state='active'
      )))`, account.id, repo?.id ?? null, now(), principal.id, principal.kind, principal.id);
  grants.push(...explicit);
  return { grants, membership };
}

function newExplanation(capability: string, scope: AuthorizationScope, principal: Principal | null): PermissionExplanation {
  return { allowed: false, capability, principal_id: principal?.id ?? null, repo_id: scope.repo_id ?? null,
    account_id: scope.account_id ?? null, repository_revision: null, policy_revision: null,
    account_policy_revision: null, routing_epoch: null, matched_grants: [], reasons: [], requirements: [], evaluated_at: now() };
}

function deny(explanation: PermissionExplanation, code: string, message: string, source?: string): void {
  explanation.reasons.push({ code, message, ...(source ? { source } : {}) });
}

function inspectCredentialScopes(explanation: PermissionExplanation, credential: Pick<Principal, 'capabilities' | 'repository_ids' | 'account_ids'>, scope: AuthorizationScope, source: string, audienceOnly = false): void {
  if (credential.capabilities !== null && !capabilityCovered(credential.capabilities, explanation.capability)) {
    deny(explanation, 'credential_capability', 'The credential does not include this capability.', source);
  }
  if (!audienceOnly && credential.repository_ids !== null && (!scope.repo_id || !credential.repository_ids.includes(scope.repo_id))) {
    deny(explanation, 'credential_repository', 'The credential does not include this repository.', source);
  }
  if (!audienceOnly && credential.account_ids !== null && (!scope.account_id || !credential.account_ids.includes(scope.account_id))) {
    deny(explanation, 'credential_account', 'The credential does not include this account.', source);
  }
}

async function inspectCredential(explanation: PermissionExplanation, db: Database, principal: Principal, scope: AuthorizationScope, policy: AccountPolicy, audienceOnly = false): Promise<void> {
  inspectCredentialScopes(explanation, principal, scope, principal.credential_id ?? 'principal', audienceOnly);
  if (principal.kind === 'application') await inspectInstallation(explanation, db, principal, scope);
  if (!principal.credential_id) return;
  const credential = await one<CredentialRecord>(db, 'SELECT * FROM credentials WHERE id=? AND principal_id=?', principal.credential_id, principal.id);
  if (!credential || !await credentialIsCurrent(db, credential)) {
    deny(explanation, 'credential_revoked', 'The credential is no longer current.');
    return;
  }
  const chain = await currentCredentialChain(db, credential.id);
  for (const item of chain) {
    inspectCredentialScopes(explanation, {
      capabilities: credentialScope(item.capabilities_json), repository_ids: credentialScope(item.repository_ids_json), account_ids: credentialScope(item.account_ids_json),
    }, scope, item.id, audienceOnly);
    const conditions = { refs: credentialScope(item.ref_patterns_json) ?? undefined, paths: credentialScope(item.path_patterns_json) ?? undefined };
    const result = conditionResult(conditions, explanation.capability, scope, principal, 'allow');
    if (!result.matches) {
      deny(explanation, 'credential_condition', 'The ref or changed paths are outside the credential scope.', item.id);
      explanation.requirements.push(...result.missing);
    }
    if (!policy.allowed_credential_kinds.includes(item.kind)) deny(explanation, 'credential_kind', 'This credential or an issuing credential type is excluded by account policy.', item.id);
    if (item.kind !== 'session' && Date.parse(item.expires_at) - Date.parse(item.created_at) > policy.maximum_token_lifetime_seconds * 1000) {
      deny(explanation, 'credential_lifetime', 'This credential or its issuer exceeds the account maximum token lifetime.', item.id);
    }
  }
}

async function inspectInstallation(explanation: PermissionExplanation, db: Database, principal: Principal, scope: AuthorizationScope): Promise<void> {
    const installation = await one<{ capabilities_json: string; repository_ids_json: string; application_capabilities: string; suspended_at: string | null; disabled_at: string | null }>(db,
      `SELECT i.capabilities_json,i.repository_ids_json,a.capabilities_json AS application_capabilities,i.suspended_at,a.disabled_at
       FROM installations i JOIN applications a ON a.id=i.application_id WHERE i.id=? AND i.account_id=?`, principal.id, scope.account_id);
    if (!installation || installation.suspended_at !== null || installation.disabled_at !== null) {
      deny(explanation, 'installation_inactive', 'This application installation is not active.');
    } else {
      inspectCredentialScopes(explanation, { capabilities: credentialScope(installation.capabilities_json), repository_ids: credentialScope(installation.repository_ids_json), account_ids: [scope.account_id!] }, scope, principal.id);
      if (!capabilityCovered(credentialScope(installation.application_capabilities) ?? [], explanation.capability)) deny(explanation, 'application_ceiling', 'The application declaration no longer permits this capability.');
    }
}

async function inspectPrincipal(explanation: PermissionExplanation, db: Database, principal: Principal | null, account: AccountRecord, policy: AccountPolicy, publiclyReadable: boolean): Promise<void> {
  if (!principal) return;
  const row = await one<{ disabled_at: string | null; expires_at: string | null }>(db, 'SELECT disabled_at,expires_at FROM principals WHERE id=? AND kind=?', principal.id, principal.kind);
  if (!row || row.disabled_at !== null || (row.expires_at !== null && row.expires_at <= now())) deny(explanation, 'principal_inactive', 'The principal is no longer active.');
  if (principal.user_id) {
    const user = await one<Pick<UserRecord, 'email_verified_at' | 'disabled_at'>>(db, 'SELECT email_verified_at,disabled_at FROM users WHERE id=?', principal.user_id);
    if (!user || user.disabled_at !== null) deny(explanation, 'user_inactive', 'This account is not active.');
    else if (!user.email_verified_at && (!publiclyReadable && policy.require_verified_email || !publicReadCapabilities.has(explanation.capability) && explanation.capability !== 'accounts.read')) {
      deny(explanation, 'email_verification_required', 'A verified email address is required.');
    }
  }
  if (policy.require_mfa && principal.kind === 'user' && !publiclyReadable && !principal.mfa) {
    deny(explanation, 'mfa_required', 'Organization policy requires multifactor authentication.');
  }
}

function inspectGrants(explanation: PermissionExplanation, grants: CandidateGrant[], scope: AuthorizationScope, principal: Principal | null): void {
  for (const grant of grants) {
    if (!capabilityMatches(grant.capability, explanation.capability)) continue;
    const effect = grant.effect === 'deny' || grant.role_effect === 'deny' ? 'deny' : 'allow';
    let conditions: GrantConditions;
    try { conditions = grantConditionsSchema.parse(JSON.parse(grant.conditions_json)); }
    catch { deny(explanation, 'invalid_policy', 'A stored grant could not be evaluated.', grant.id); continue; }
    const condition = conditionResult(conditions, explanation.capability, scope, principal, effect);
    explanation.requirements.push(...condition.missing);
    if (!condition.matches) continue;
    explanation.matched_grants.push({ id: grant.id, capability: grant.capability, effect, source: grant.source,
      ...(Object.keys(conditions).length ? { conditions } : {}) });
    if (effect === 'deny') deny(explanation, 'explicit_deny', 'An explicit denial overrides matching grants.', grant.id);
  }
}

function lifecycleReason(explanation: PermissionExplanation, repo: Repository): void {
  const capability = explanation.capability;
  if (repo.state === 'deleted' && !['repositories.restore', 'repositories.purge', 'repositories.delete'].includes(capability)) {
    deny(explanation, 'repository_deleted', 'This repository is deleted.');
  }
  if (['provisioning', 'moving'].includes(repo.state) && capability !== 'repositories.read'
    && !['repositories.create', 'repositories.delete', 'repositories.export', 'repositories.transfer', 'repositories.restore', 'repositories.archive', 'repositories.unarchive'].includes(capability)) deny(explanation, 'repository_unavailable', 'A repository operation is still in progress.');
  if (repo.state === 'transfer_pending' && !capability.endsWith('.read') && !['repositories.export', 'repositories.transfer', 'permissions.manage', 'tokens.revoke'].includes(capability)) {
    deny(explanation, 'transfer_pending', 'Writes are paused while this transfer is pending.');
  }
  if (repo.state === 'archived' && !capability.endsWith('.read') && !archivedAdministrativeCapabilities.has(capability)) {
    deny(explanation, 'repository_archived', 'This repository is archived and read-only.');
  }
}

/**
 * Internal explanation evaluator. Callers must authorize visibility before
 * returning another principal's explanation or matched grants to an API client.
 */
export async function explainAuthorization(c: AppContext, capability: string, input: AuthorizationScope = {}, principal = c.get('principal'), visited = new Set<string>(), audienceOnly = false): Promise<PermissionExplanation> {
  const scope = { ...input };
  const result = newExplanation(capability, scope, principal);
  if (!capabilityPatternSchema.safeParse(capability).success || capability.includes('*')) {
    deny(result, 'unknown_capability', 'Authorization requires one concrete capability.');
    return result;
  }
  const db = identityDatabase(c);
  const repo = scope.repo_id ? await readRepositoryAuthority(c, scope.repo_id) : null;
  if (scope.repo_id && !repo) { deny(result, 'resource_not_found', 'The requested resource is unavailable.'); return result; }
  if (repo) {
    if (scope.account_id && scope.account_id !== repo.owner_id) { deny(result, 'scope_mismatch', 'The repository does not belong to this account.'); return result; }
    scope.account_id = repo.owner_id;
    result.repository_revision = repo.revision;
    result.policy_revision = repo.policy_revision;
    result.routing_epoch = repo.routing_epoch;
  }
  scope.account_id ??= principal?.user_id ?? undefined;
  result.account_id = scope.account_id ?? null;
  const account = scope.account_id ? await one<AccountRecord>(db, 'SELECT * FROM accounts WHERE id=?', scope.account_id) : null;
  if (!account || account.disabled_at !== null) { deny(result, 'resource_not_found', 'The requested account is unavailable.'); return result; }
  result.account_policy_revision = account.policy_revision;
  if (c.get('mutation_authority') && (separateIdentityAuthority(c)
    || repo && (repo.cell_id !== c.env.CELL_ID || repo.shard_id !== c.env.SHARD_ID))) {
    await captureAccountAuthority(c, account.id, account.policy_revision);
  }
  if (!capability.endsWith('.read') && !['repositories.export', 'tokens.revoke', 'repositories.purge'].includes(capability)
    && await one(db, 'SELECT 1 FROM account_policy_barriers WHERE account_id=?', account.id)) {
    deny(result, 'account_policy_pending', 'An account-wide access change is waiting for admitted Git publications to finish.');
  }
  const { policy } = await readAccountPolicy(db, account.id);
  const { grants, membership } = principal ? await candidateGrants(db, principal, account, repo) : { grants: [], membership: null };
  const publiclyReadable = !!repo && ['public', 'unlisted'].includes(repo.visibility) && publicReadCapabilities.has(capability);
  const billingOnlyMembership = membership?.role_id === 'billing_manager'
    || !!membership && grants.filter(grant => grant.source === 'membership').every(grant => grant.capability.startsWith('billing.') || grant.capability === 'accounts.read');
  const internalReadable = !!repo && repo.visibility === 'internal' && !!membership && !billingOnlyMembership && publicReadCapabilities.has(capability);
  if (publiclyReadable || internalReadable) grants.push({ id: `visibility:${repo!.visibility}`, capability,
    effect: 'allow', role_effect: null, conditions_json: '{}', source: 'visibility' });
  if (!repo && capability === 'accounts.read' && account.type === 'user') {
    const owner = await one<{ profile_visibility: string; email_verified_at: string | null; disabled_at: string | null }>(db,
      'SELECT profile_visibility,email_verified_at,disabled_at FROM users WHERE id=?', account.owner_user_id);
    if (owner?.profile_visibility === 'public' && owner.email_verified_at && owner.disabled_at === null) grants.push({ id: 'visibility:profile', capability,
      effect: 'allow', role_effect: null, conditions_json: '{}', source: 'visibility' });
  }
  await inspectPrincipal(result, db, principal, account, policy, publiclyReadable);
  if (principal) await inspectCredential(result, db, principal, scope, policy, audienceOnly);
  if (account.type === 'organization' && principal && (!publiclyReadable || principal.credential_id && await isFederationSession(db, principal.credential_id))) {
    try { await enforceOrganizationSso(db, principal, account.id, capability); }
    catch (error) {
      if (!(error instanceof ApiError) || ![401, 403].includes(error.status)) throw error;
      deny(result, error.code, error.message, 'organization_sso');
    }
  }
  if (policy.allowed_capabilities !== null && !capabilityCovered(policy.allowed_capabilities, capability)) deny(result, 'organization_ceiling', 'Account policy does not permit this capability.');
  if (capabilityCovered(policy.denied_capabilities, capability)) deny(result, 'organization_deny', 'Account policy explicitly denies this capability.');
  if (repo && principal && ['user', 'viewer'].includes(principal.kind) && !membership && !publiclyReadable && account.type === 'organization'
    && !policy.allow_outside_collaborators && principal.id !== account.owner_user_id) {
    deny(result, 'outside_collaborators_disabled', 'Organization policy does not permit outside collaborators.');
  }
  inspectGrants(result, grants, scope, principal);
  if (!result.matched_grants.some(grant => grant.effect === 'allow')) deny(result, 'no_matching_grant', 'No current role or grant permits this capability.');
  if (repo) lifecycleReason(result, repo);
  if (repo?.fork_source_id && !['repositories.delete', 'repositories.restore', 'repositories.purge'].includes(capability)) {
    if (visited.has(repo.id) || visited.size >= 32) deny(result, 'fork_ancestry_unavailable', 'The fork access boundary could not be verified.');
    else {
      const nextVisited = new Set(visited).add(repo.id);
      // A fork-scoped token need not include its source ID, but its underlying
      // principal must remain in the source's audience. The token is checked above.
      const source = await explainAuthorization(c, 'contents.read', { repo_id: repo.fork_source_id }, principal, nextVisited, true);
      if (!source.allowed) deny(result, 'fork_source_access_required', 'Access to this fork requires current access to its source repository.');
    }
  }
  result.requirements = [...new Set(result.requirements)];
  const currentAccount = await one<{ policy_revision: number }>(db, 'SELECT policy_revision FROM accounts WHERE id=?', account.id);
  if (!currentAccount || currentAccount.policy_revision !== result.account_policy_revision) deny(result, 'policy_changed', 'The account policy changed during evaluation. Retry against current state.');
  if (repo) {
    const currentRepo = await readRepositoryAuthority(c, repo.id);
    if (!currentRepo || currentRepo.revision !== repo.revision) deny(result, 'policy_changed', 'The repository changed during evaluation. Retry against current state.');
  }
  result.allowed = result.reasons.length === 0;
  if (result.allowed) result.reasons.push({ code: 'allowed', message: 'Current grants, credential scope, and account policy permit this action. Branch and content rules still apply to writes.' });
  return result;
}

export async function authorize(c: AppContext, capability: string, scope: AuthorizationScope = {}): Promise<PermissionExplanation> {
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
  if (mutating) await captureMutationAuthority(c);
  const explanation = await explainAuthorization(c, capability, scope);
  if (explanation.allowed) {
    if (mutating) recordRequestPolicy(c, { capability, scope }, explanation);
    return explanation;
  }
  const principal = c.get('principal');
  if (scope.repo_id) {
    const visible = capability === 'contents.read' ? explanation : await explainAuthorization(c, 'contents.read', { repo_id: scope.repo_id });
    // Lifecycle management remains possible for owners after deletion/provisioning.
    const management = ['repositories.restore', 'repositories.purge', 'repositories.delete'].includes(capability);
    if (!visible.allowed && !management) throw new ApiError(404, 'not_found', 'The requested repository was not found.');
  }
  if (!principal) throw new ApiError(401, 'authentication_required', 'Sign in to GitKnot to continue.');
  if (explanation.reasons.some(reason => ['repository_archived', 'repository_unavailable', 'transfer_pending', 'account_policy_pending'].includes(reason.code))) {
    throw new ApiError(409, 'repository_read_only', 'The current repository lifecycle state does not allow this action.', { reasons: explanation.reasons });
  }
  throw new ApiError(scope.repo_id ? 404 : 403, scope.repo_id ? 'not_found' : 'permission_denied', scope.repo_id
    ? 'The requested repository was not found.' : 'Your current permissions do not allow this action.', scope.repo_id ? undefined : { reasons: explanation.reasons, requirements: explanation.requirements });
}

export async function getRepository(c: AppContext, id: string | undefined, capability = 'contents.read'): Promise<Repository> {
  if (!id) throw new ApiError(404, 'not_found', 'The requested repository was not found.');
  const explanation = await authorize(c, capability, { repo_id: id });
  const repository = await readRepositoryAuthority(c, id);
  if (!repository) throw new ApiError(404, 'not_found', 'The requested repository was not found.');
  if (repository.revision !== explanation.repository_revision || repository.owner_id !== explanation.account_id) {
    throw new ApiError(409, 'policy_changed', 'The repository changed during authorization. Retry against current state.');
  }
  // Native publication uses the explanation's policy/epoch revisions as a CAS
  // fence. Other callers receive the same authoritative catalog representation.
  return repository;
}

export async function principalForExplanation(db: Database, id: string): Promise<Principal | null> {
  const row = await one<{ id: string; kind: PrincipalKind; user_id: string | null }>(db,
    'SELECT id,kind,user_id FROM principals WHERE id=? AND disabled_at IS NULL', id);
  return row ? { ...row, credential_id: null, capabilities: null, repository_ids: null, account_ids: null, mfa: false } : null;
}

export const capabilityCatalog = [
  'accounts.read', 'accounts.manage', 'accounts.delete', 'owners.manage', 'members.read', 'members.manage',
  'teams.read', 'teams.manage', 'invitations.read', 'invitations.manage', 'identities.read', 'identities.manage',
  'roles.read', 'roles.manage', 'policy.read', 'policy.manage', 'repositories.create', 'repositories.read',
  'repositories.manage', 'repositories.transfer', 'repositories.archive', 'repositories.unarchive',
  'repositories.delete', 'repositories.restore', 'repositories.purge', 'repositories.export', 'permissions.read',
  'permissions.manage', 'permissions.explain', 'contents.read', 'contents.push', 'contents.write', 'issues.read',
  'issues.write', 'issues.triage', 'issues.manage', 'pull_requests.read', 'pull_requests.write', 'pull_requests.review',
  'pull_requests.merge', 'pull_requests.manage', 'discussions.read', 'discussions.write', 'discussions.moderate',
  'tasks.read', 'tasks.write', 'tasks.manage', 'rules.read', 'rules.manage', 'rules.break_glass', 'workflows.read',
  'workflows.run', 'workflows.manage', 'runs.read', 'runs.cancel', 'runners.read', 'runners.manage',
  'environments.read', 'environments.manage', 'environments.approve', 'secrets.manage', 'secrets.use',
  'variables.read', 'variables.manage', 'webhooks.read', 'webhooks.manage', 'webhooks.revoke', 'releases.read',
  'releases.write', 'lfs.read', 'lfs.write', 'attachments.read', 'attachments.write', 'search.read', 'search.scan',
  'tokens.read', 'tokens.manage', 'tokens.revoke', 'installations.read', 'installations.manage',
  'billing.read', 'billing.manage', 'audit.read', 'exports.read', 'exports.create',
] as const;
