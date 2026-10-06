import { z } from 'zod';
import { database } from '@gitknot/core/db';
import { identityDatabase } from '@gitknot/core/authority';
import { ApiError, authorize, expectedRevision, getRepository, jsonBody, listResponse, many, newId, now, one, page, requirePrincipal, route, stmt,
  type App, type AppContext, type Repository } from '@gitknot/core';
import { afterSeconds, checkedWrite, requireHuman } from '@gitknot/core/auth';
import { gitRuleSchema, matchGitPattern } from '../../../../../packages/git/src/policy.ts';
import type { GitCheckExpression, GitRule } from '../../../../../packages/git/src/types.ts';
import { accountAccess, bumpAccountPolicy } from '../accounts/shared.ts';
import { commitIdentity, idSchema, revisionResponse } from '../identity/shared.ts';
import { withAccountPolicyBarrier, withRepositoryBarrier } from './shared.ts';

export const repositoryRuleSchema = gitRuleSchema.superRefine((rule, context) => {
  const targets = Array.isArray(rule.target) ? rule.target : [rule.target];
  if (targets.some(target => !/^refs\/(heads|tags|notes)\/.+/.test(target) || /[\x00-\x20\x7f\\]/.test(target) || target.length > 256)) {
    context.addIssue({ code: 'custom', path: ['target'], message: 'Use bounded full branch, tag, or notes ref patterns.' });
  }
  if (rule.id !== undefined) context.addIssue({ code: 'custom', path: ['id'], message: 'The server assigns stable rule IDs.' });
  if (rule.files?.secret_literals?.length) context.addIssue({ code: 'custom', path: ['files', 'secret_literals'], message: 'Use the managed secret scanner; secret values must not be stored in readable rule configuration.' });
  if (rule.verification?.required.length && !rule.verification.trusted_producers?.length) {
    context.addIssue({ code: 'custom', path: ['verification', 'trusted_producers'], message: 'Required verification keys must name trusted producers.' });
  }
  for (const [path, owners] of Object.entries(rule.reviews?.required_owners ?? {})) {
    if (!path || path.length > 256 || /[\x00-\x1f\x7f\\]/.test(path) || !owners.length) context.addIssue({ code: 'custom', path: ['reviews', 'required_owners', path], message: 'Every valid path-owner pattern needs at least one owner.' });
  }
});
const createSchema = z.object({ name: z.string().trim().min(1).max(100), enforcement: z.enum(['active', 'evaluate', 'disabled']).default('active'), config: repositoryRuleSchema }).strict();
const previewSchema = z.object({ rule: createSchema, replace_rule_id: idSchema.optional(), ref: z.string().min(1).max(1024).optional(),
  paths: z.array(z.string().min(1).max(4096)).max(1000).optional() }).strict();
const bypassSchema = z.object({ rule_ids: z.array(idSchema).min(1).max(100), refs: z.array(z.string().min(1).max(1024)).min(1).max(100),
  reason: z.string().trim().min(10).max(2000), duration_seconds: z.number().int().min(1).max(1800) }).strict();
export interface RuleRecord { id: string; account_id: string; repo_id: string | null; name: string; enforcement: 'active' | 'evaluate' | 'disabled';
  target_json: string; config_json: string; revision: number; created_by: string; created_at: string; updated_at: string }
export interface EffectiveRule { id: string; account_id: string; repo_id: string | null; name: string; enforcement: RuleRecord['enforcement']; revision: number; mandatory: boolean; config: GitRule }

export function publicRule(row: RuleRecord): EffectiveRule {
  const config = gitRuleSchema.parse(JSON.parse(row.config_json));
  // Legacy/internal scanner material is not part of the readable API contract.
  if (config.files?.secret_literals) delete config.files.secret_literals;
  return { id: row.id, account_id: row.account_id, repo_id: row.repo_id, name: row.name,
    enforcement: row.enforcement, revision: row.revision, mandatory: row.repo_id === null, config };
}

export async function effectiveRepositoryRules(c: AppContext, repository: Repository): Promise<EffectiveRule[]> {
  return (await scopedRules(c, repository.owner_id, repository.id)).filter(row => row.enforcement !== 'disabled').map(publicRule);
}

async function scopedRules(c: AppContext, accountId: string, repoId: string | null, cursor = '', limit?: number): Promise<RuleRecord[]> {
  const sql = `SELECT * FROM repository_rules WHERE account_id=? AND repo_id IS ? AND id>? ORDER BY id${limit === undefined ? '' : ' LIMIT ?'}`;
  const values = limit === undefined ? [] : [limit];
  const [mandatory, local] = await Promise.all([
    many<RuleRecord>(identityDatabase(c), sql, accountId, null, cursor, ...values),
    repoId ? many<RuleRecord>(database(c), sql, accountId, repoId, cursor, ...values) : Promise.resolve([]),
  ]);
  return [...mandatory, ...local].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function targetPatterns(rule: GitRule): string[] { return Array.isArray(rule.target) ? rule.target : [rule.target]; }
function overlap(left: GitRule, right: GitRule): boolean {
  return targetPatterns(left).some(a => targetPatterns(right).some(b => a === b || matchGitPattern(a, b) || matchGitPattern(b, a)));
}

function leaves(expression: GitCheckExpression): Array<Extract<GitCheckExpression, { type: 'check' }>> {
  return expression.type === 'check' ? [expression] : expression.checks.flatMap(leaves);
}

export function ruleConflicts(rules: EffectiveRule[]): Array<{ code: string; rule_ids: string[]; message: string }> {
  const conflicts: Array<{ code: string; rule_ids: string[]; message: string }> = [];
  const active = rules.filter(rule => rule.enforcement === 'active');
  for (let index = 0; index < active.length; index++) for (const other of active.slice(index + 1)) {
    const current = active[index]!;
    if (!overlap(current.config, other.config)) continue;
    const strategies = current.config.merge_strategies;
    if (strategies && other.config.merge_strategies && !strategies.some(strategy => other.config.merge_strategies!.includes(strategy))) {
      conflicts.push({ code: 'merge_strategy_conflict', rule_ids: [current.id, other.id], message: 'Overlapping rules have no allowed merge strategy in common.' });
    }
    const actors = current.config.push?.allowed_principals;
    if (actors && other.config.push?.allowed_principals && !actors.some(actor => other.config.push!.allowed_principals.includes(actor))) {
      // Teams can overlap even with different IDs; only reject provably disjoint human/machine lists.
      if (![...actors, ...other.config.push.allowed_principals].some(id => id.startsWith('team_'))) conflicts.push({ code: 'push_scope_conflict', rule_ids: [current.id, other.id], message: 'Overlapping push restrictions allow no common principal.' });
    }
  }
  for (const rule of active) {
    const seen = new Map<string, string>();
    for (const check of rule.config.verification?.expression ? leaves(rule.config.verification.expression) : []) {
      const signature = JSON.stringify({ producers: [...check.producers].sort(), workflow_digest: check.workflow_digest ?? null });
      const previous = seen.get(check.key);
      if (previous && previous !== signature) conflicts.push({ code: 'verification_provenance_conflict', rule_ids: [rule.id], message: 'The same verification key has incompatible trusted provenance in this expression.' });
      seen.set(check.key, signature);
    }
  }
  return conflicts;
}

export function ruleObligations(rules: EffectiveRule[], scope: { ref?: string; paths?: string[] }): Array<Record<string, unknown>> {
  return rules.map(rule => {
    const matches = scope.ref === undefined || targetPatterns(rule.config).some(pattern => matchGitPattern(pattern, scope.ref!));
    const owners = Object.entries(rule.config.reviews?.required_owners ?? {}).filter(([pattern]) => scope.paths === undefined || scope.paths.some(path => matchGitPattern(pattern, path)));
    return { rule_id: rule.id, name: rule.name, mandatory: rule.mandatory, enforcement: rule.enforcement,
      applicable: matches, reason: matches ? 'The ref matches the rule target.' : 'The ref does not match the rule target.',
      ...(matches ? { updates: rule.config.updates ?? 'any', reviews: rule.config.reviews ?? null, required_owners: Object.fromEntries(owners),
        verification: rule.config.verification ?? null, merge_strategies: rule.config.merge_strategies ?? null,
        history: rule.config.history ?? null, signatures: rule.config.signatures ?? null, files: rule.config.files ?? null,
        push: rule.config.push ?? null, requires_native_evidence: true } : {}) };
  });
}

async function validateRulePrincipals(c: AppContext, accountId: string, rule: GitRule): Promise<void> {
  const ids = [...new Set([...(rule.reviews?.required_reviewers ?? []), ...Object.values(rule.reviews?.required_owners ?? {}).flat(), ...(rule.push?.allowed_principals ?? [])])];
  for (const id of ids) {
    const exists = id.startsWith('team_') ? await one(identityDatabase(c), 'SELECT 1 FROM teams WHERE id=? AND account_id=?', id, accountId)
      : await one(identityDatabase(c), "SELECT 1 FROM principals WHERE id=? AND disabled_at IS NULL AND (kind='user' OR account_id=?) AND (expires_at IS NULL OR expires_at>?)", id, accountId, now());
    if (!exists) throw new ApiError(422, 'rule_principal_outside_scope', 'Rule principals must be current people or teams/identities of this account.', { principal_id: id });
  }
}

async function ruleScope(c: AppContext, organization: boolean, capability: string) {
  if (organization) {
    const { account, authorization } = await accountAccess(c, c.req.param('id'), capability, true);
    return { account_id: account.id, repo_id: null, repository: null, authorization };
  }
  const repository = await getRepository(c, c.req.param('id'), capability);
  return { account_id: repository.owner_id, repo_id: repository.id, repository, authorization: await authorize(c, capability, { repo_id: repository.id }) };
}

async function relevantRules(c: AppContext, accountId: string, repoId: string | null): Promise<EffectiveRule[]> {
  return (await scopedRules(c, accountId, repoId)).map(publicRule);
}

function rulesRevision(c: AppContext, accountId: string, repoId: string | null): D1PreparedStatement[] {
  return repoId ? [stmt(database(c), 'UPDATE repositories SET policy_revision=policy_revision+1,revision=revision+1,updated_at=? WHERE id=? AND owner_id=?', now(), repoId, accountId)]
    : [bumpAccountPolicy(c, accountId)];
}

async function guardedRuleMutation<T>(c: AppContext, accountId: string, repoId: string | null, mutation: () => Promise<T>): Promise<T> {
  if (repoId) return withRepositoryBarrier(c, repoId, 'repository.rules', mutation);
  return withAccountPolicyBarrier(c, accountId, 'organization.rules', undefined, mutation);
}

function registerRuleScope(app: App, path: string, organization: boolean): void {
  route(app, 'GET', path, { summary: 'Read repository rules and inherited mandatory constraints', tags: ['rules'], capability: 'rules.read' }, async c => {
    const scope = await ruleScope(c, organization, 'rules.read');
    const { limit, cursor } = page(c);
    const rows = await scopedRules(c, scope.account_id, scope.repo_id, cursor ?? '', limit + 1);
    return listResponse(c, rows.slice(0, limit).map(publicRule), rows.length > limit ? rows[limit - 1]!.id : null);
  });

  route(app, 'POST', `${path}/preview`, { summary: 'Explain a proposed rule and reject conflicting composition', tags: ['rules'], body: previewSchema, capability: 'rules.manage' }, async c => {
    const scope = await ruleScope(c, organization, 'rules.manage');
    const body = await jsonBody(c, previewSchema);
    await validateRulePrincipals(c, scope.account_id, body.rule.config);
    if (organization && body.rule.config.bypass) throw new ApiError(422, 'mandatory_rule_bypass', 'Mandatory organization rules cannot be bypassed at repository scope.');
    const existing = (await relevantRules(c, scope.account_id, scope.repo_id)).filter(rule => rule.id !== body.replace_rule_id);
    const rules: EffectiveRule[] = [...existing, { id: body.replace_rule_id ?? 'proposed', account_id: scope.account_id, repo_id: scope.repo_id,
      name: body.rule.name, enforcement: body.rule.enforcement, mandatory: organization, revision: 1, config: body.rule.config }];
    const conflicts = ruleConflicts(rules);
    return c.json({ valid: conflicts.length === 0, conflicts, obligations: ruleObligations(rules, body), policy_revision: scope.repository?.policy_revision ?? scope.authorization.account_policy_revision });
  });

  route(app, 'POST', path, { summary: 'Publish a versioned repository or organization rule', tags: ['rules'], body: createSchema, capability: 'rules.manage' }, async c => {
    const scope = await ruleScope(c, organization, 'rules.manage');
    const body = await jsonBody(c, createSchema);
    await validateRulePrincipals(c, scope.account_id, body.config);
    if (organization && body.config.bypass) throw new ApiError(422, 'mandatory_rule_bypass', 'Mandatory organization rules cannot declare repository bypass.');
    const id = newId('rule');
    const candidate: EffectiveRule = { id, account_id: scope.account_id, repo_id: scope.repo_id, name: body.name,
      enforcement: body.enforcement, revision: 1, mandatory: organization, config: body.config };
    const conflicts = ruleConflicts([...await relevantRules(c, scope.account_id, scope.repo_id), candidate]);
    if (conflicts.length) throw new ApiError(422, 'rule_conflict', 'The proposed rule conflicts with existing mandatory constraints.', { conflicts });
    const timestamp = now();
    await guardedRuleMutation(c, scope.account_id, scope.repo_id, async () => commitIdentity(c, [stmt(database(c),
      'INSERT INTO repository_rules(id,account_id,repo_id,name,enforcement,target_json,config_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      id, scope.account_id, scope.repo_id, body.name, body.enforcement, JSON.stringify(targetPatterns(body.config)), JSON.stringify(body.config), requirePrincipal(c).id, timestamp, timestamp),
    ...rulesRevision(c, scope.account_id, scope.repo_id)], { type: 'repository.rule_created', resource_id: id, resource_revision: 1, account_id: scope.account_id, repo_id: scope.repo_id }, { authorizations: [scope.authorization] }));
    return revisionResponse(c, candidate, 201);
  });

  route(app, 'GET', `${path}/:ruleId`, { summary: 'Read a repository rule', tags: ['rules'], capability: 'rules.read' }, async c => {
    const scope = await ruleScope(c, organization, 'rules.read');
    const row = scope.repo_id
      ? await one<RuleRecord>(database(c), 'SELECT * FROM repository_rules WHERE id=? AND account_id=? AND repo_id=?', c.req.param('ruleId'), scope.account_id, scope.repo_id)
        ?? await one<RuleRecord>(identityDatabase(c), 'SELECT * FROM repository_rules WHERE id=? AND account_id=? AND repo_id IS NULL', c.req.param('ruleId'), scope.account_id)
      : await one<RuleRecord>(identityDatabase(c), 'SELECT * FROM repository_rules WHERE id=? AND account_id=? AND repo_id IS NULL', c.req.param('ruleId'), scope.account_id);
    if (!row) throw new ApiError(404, 'not_found', 'The requested rule was not found.');
    return revisionResponse(c, publicRule(row));
  });

  route(app, 'PUT', `${path}/:ruleId`, { summary: 'Replace a repository rule with a revision precondition', tags: ['rules'], body: createSchema, capability: 'rules.manage' }, async c => {
    const scope = await ruleScope(c, organization, 'rules.manage');
    const body = await jsonBody(c, createSchema);
    const revision = expectedRevision(c);
    const row = await one<RuleRecord>(database(c), 'SELECT * FROM repository_rules WHERE id=? AND account_id=? AND repo_id IS ?', c.req.param('ruleId'), scope.account_id, scope.repo_id);
    if (!row) throw new ApiError(404, 'not_found', 'Only rules owned by this scope can be edited here.');
    await validateRulePrincipals(c, scope.account_id, body.config);
    if (organization && body.config.bypass) throw new ApiError(422, 'mandatory_rule_bypass', 'Mandatory organization rules cannot declare repository bypass.');
    const candidate: EffectiveRule = { ...publicRule(row), config: body.config, name: body.name, enforcement: body.enforcement, revision: revision + 1 };
    const conflicts = ruleConflicts([...(await relevantRules(c, scope.account_id, scope.repo_id)).filter(rule => rule.id !== row.id), candidate]);
    if (conflicts.length) throw new ApiError(422, 'rule_conflict', 'The proposed rule conflicts with existing constraints.', { conflicts });
    await guardedRuleMutation(c, scope.account_id, scope.repo_id, async () => commitIdentity(c, [...checkedWrite(database(c), stmt(database(c),
      'UPDATE repository_rules SET name=?,enforcement=?,target_json=?,config_json=?,revision=revision+1,updated_at=? WHERE id=? AND account_id=? AND repo_id IS ? AND revision=?',
      body.name, body.enforcement, JSON.stringify(targetPatterns(body.config)), JSON.stringify(body.config), now(), row.id, scope.account_id, scope.repo_id, revision)),
    ...rulesRevision(c, scope.account_id, scope.repo_id)], { type: 'repository.rule_updated', resource_id: row.id, resource_revision: revision + 1, account_id: scope.account_id, repo_id: scope.repo_id }, { authorizations: [scope.authorization] }));
    return revisionResponse(c, candidate);
  });

  route(app, 'DELETE', `${path}/:ruleId`, { summary: 'Delete a rule owned by this scope', tags: ['rules'], capability: 'rules.manage' }, async c => {
    const scope = await ruleScope(c, organization, 'rules.manage');
    const revision = expectedRevision(c);
    await guardedRuleMutation(c, scope.account_id, scope.repo_id, async () => commitIdentity(c, [...checkedWrite(database(c), stmt(database(c),
      'DELETE FROM repository_rules WHERE id=? AND account_id=? AND repo_id IS ? AND revision=?', c.req.param('ruleId'), scope.account_id, scope.repo_id, revision)),
    ...rulesRevision(c, scope.account_id, scope.repo_id)], { type: 'repository.rule_deleted', resource_id: c.req.param('ruleId')!, resource_revision: revision + 1, account_id: scope.account_id, repo_id: scope.repo_id }, { authorizations: [scope.authorization] }));
    return c.body(null, 204);
  });
}

export function registerRepositoryRuleRoutes(app: App): void {
  registerRuleScope(app, '/v1/repos/:id/rules', false);
  registerRuleScope(app, '/v1/orgs/:id/rules', true);
  route(app, 'POST', '/v1/repos/:id/rule-bypasses', { summary: 'Request an audited, time-bounded emergency rule bypass', tags: ['rules'], body: bypassSchema, capability: 'rules.break_glass' }, async c => {
    const user = await requireHuman(c, { recent: true, mfa: true });
    const repo = await getRepository(c, c.req.param('id'), 'rules.break_glass');
    const authorization = await authorize(c, 'rules.break_glass', { repo_id: repo.id });
    const body = await jsonBody(c, bypassSchema);
    const revision = expectedRevision(c);
    if (revision !== repo.revision) throw new ApiError(412, 'revision_conflict', 'Refresh repository rules before requesting a bypass.');
    const rules = await effectiveRepositoryRules(c, repo);
    for (const id of new Set(body.rule_ids)) {
      const rule = rules.find(rule => rule.id === id);
      if (!rule || rule.mandatory || !rule.config.bypass || body.duration_seconds > rule.config.bypass.maximum_duration_seconds) throw new ApiError(422, 'rule_not_bypassable', 'Every selected rule must explicitly permit this repository-scoped bypass.');
      if (body.refs.some(ref => /[*?\x00-\x20]/.test(ref) || !targetPatterns(rule.config).some(pattern => matchGitPattern(pattern, ref)))) throw new ApiError(422, 'bypass_ref_scope', 'Bypasses require exact refs covered by every selected rule.');
    }
    const id = newId('bypass');
    const expiresAt = afterSeconds(body.duration_seconds);
    await withRepositoryBarrier(c, repo.id, 'repository.rule_bypass', async () => commitIdentity(c, [
      ...checkedWrite(database(c), stmt(database(c), 'UPDATE repositories SET revision=revision+1,updated_at=? WHERE id=? AND revision=? AND policy_revision=?', now(), repo.id, revision, repo.policy_revision)),
      stmt(database(c), 'INSERT INTO rule_bypasses(id,account_id,repo_id,principal_id,rule_ids_json,refs_json,reason,policy_revision,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        id, repo.owner_id, repo.id, user.id, JSON.stringify(body.rule_ids), JSON.stringify(body.refs), body.reason, repo.policy_revision, expiresAt, now()),
    ], { type: 'repository.rule_bypass_created', resource_id: id, resource_revision: 1, account_id: repo.owner_id, repo_id: repo.id,
      data: { rule_ids: body.rule_ids, refs: body.refs, reason: body.reason, expires_at: expiresAt } }, { authorizations: [authorization] }));
    return revisionResponse(c, { id, repo_id: repo.id, principal_id: user.id, rule_ids: body.rule_ids, refs: body.refs, reason: body.reason,
      policy_revision: repo.policy_revision, expires_at: expiresAt, revision: 1 }, 201);
  });
  route(app, 'GET', '/v1/repos/:id/rule-bypasses', { summary: 'List current and historical emergency bypasses', tags: ['rules'], capability: 'rules.read' }, async c => {
    const repo = await getRepository(c, c.req.param('id'), 'rules.read');
    const { limit, cursor } = page(c);
    const rows = await many<{ id: string; rule_ids_json: string; refs_json: string; [field: string]: unknown }>(database(c), 'SELECT * FROM rule_bypasses WHERE repo_id=? AND id>? ORDER BY id LIMIT ?', repo.id, cursor ?? '', limit + 1);
    return listResponse(c, rows.slice(0, limit).map(({ rule_ids_json, refs_json, ...row }) => ({ ...row, rule_ids: JSON.parse(rule_ids_json) as string[], refs: JSON.parse(refs_json) as string[] })), rows.length > limit ? rows[limit - 1]!.id : null);
  });
  route(app, 'DELETE', '/v1/repos/:id/rule-bypasses/:bypassId', { summary: 'Revoke an emergency rule bypass', tags: ['rules'], capability: 'rules.manage' }, async c => {
    const repo = await getRepository(c, c.req.param('id'), 'rules.manage');
    const authorization = await authorize(c, 'rules.manage', { repo_id: repo.id });
    const revision = expectedRevision(c);
    await withRepositoryBarrier(c, repo.id, 'repository.rule_bypass_revoke', async () => commitIdentity(c, checkedWrite(database(c), stmt(database(c),
      'UPDATE rule_bypasses SET revoked_at=?,revision=revision+1 WHERE id=? AND repo_id=? AND revision=? AND revoked_at IS NULL', now(), c.req.param('bypassId'), repo.id, revision)),
    { type: 'repository.rule_bypass_revoked', resource_id: c.req.param('bypassId')!, resource_revision: revision + 1, repo_id: repo.id, account_id: repo.owner_id }, { authorizations: [authorization] }));
    return c.body(null, 204);
  });
}
