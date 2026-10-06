import { ApiError, auditStatement, canonicalJson, many, newId, now, one, sha256, stmt, identityDatabase, readRepositoryAuthority } from '@gitknot/core';
import type { AppContext } from '@gitknot/core';
import { assertActiveVaultEnvironment, assertUsePolicy, authorizationWitness, authorizeVault, checkClientScope, resolveVaultScope } from './authorization.ts';
import type { AuthorizationWitness } from './authorization.ts';
import { vaultBatch, vaultReadGuard } from './database.ts';
import type { BrokerClient, PlanSelection, PlanSelectionInput, PlanSelectionPreview, SelectedVersion, SelectionContext, VaultEntry, VaultKind, VaultScope, VaultVersion } from './types.ts';

function scopeKey(scope: VaultScope): string { return `${scope.account_id}:${scope.scope_type}:${scope.scope_id}`; }

export interface SelectionRow {
  id: string; account_id: string; repo_id: string; actor_id: string; actor_credential_id: string | null; workflow_id: string;
  selection_digest: string; context_json: string; steps_json: string; plan_digest: string | null; created_at: string; bound_at: string | null;
}

interface PlanResolution {
  context: SelectionContext; steps: PlanSelection['steps']; selection_digest: string;
  entries: VaultEntry[]; witnesses: AuthorizationWitness[]; repository_revision: number;
}

async function resolvePlan(c: AppContext, client: BrokerClient, input: PlanSelectionInput, readOnly: boolean): Promise<PlanResolution> {
  const db = identityDatabase(c);
  const repository = await readRepositoryAuthority(c, input.repo_id);
  if (!repository || repository.state !== 'active') throw new ApiError(404, 'not_found', 'The repository is not available.');
  const context: SelectionContext = {
    account_id: repository.owner_id, repo_id: input.repo_id, actor_id: input.principal.id, actor_credential_id: input.principal.credential_id,
    workflow_id: input.workflow_id, commit_oid: input.commit_oid, ref: input.ref, trust_class: input.trust_class, executor: input.executor,
    runner_pool_id: input.runner_pool_id, environment_id: input.environment_id, policy_revision: repository.policy_revision, routing_epoch: repository.routing_epoch,
  };
  checkClientScope(client, context);
  const witness = (scope: Pick<VaultScope, 'account_id' | 'repo_id'>) => authorizationWitness(c, input.principal, scope, new Set(), { readOnly });
  const witnesses: AuthorizationWitness[] = [await witness(context)];
  await authorizeVault(c, input.principal, 'workflows.run', context);
  const scopes: VaultScope[] = [];
  const personal = input.principal.user_id ? await one<{ id: string }>(db, "SELECT id FROM accounts WHERE type='user' AND owner_user_id=?", input.principal.user_id) : null;
  if (personal && personal.id !== context.account_id) scopes.push(await resolveVaultScope(c, { account_id: personal.id }));
  scopes.push(await resolveVaultScope(c, { account_id: context.account_id }));
  scopes.push(await resolveVaultScope(c, { repo_id: input.repo_id }));
  if (input.environment_id) scopes.push(await resolveVaultScope(c, { repo_id: input.repo_id, environment_id: input.environment_id }));
  const names = {
    secret: [...new Set(input.steps.flatMap((step) => step.secrets))],
    variable: [...new Set(input.steps.flatMap((step) => step.variables))],
  };
  if (names.secret.length > 64 || names.variable.length > 128 || new Set(input.steps.map((s) => s.step_id)).size !== input.steps.length) {
    throw new ApiError(422, 'selection_limit', 'A plan selection requires unique steps and at most 64 secrets / 128 variables.');
  }
  const selected = new Map<string, SelectedVersion>();
  const entries: VaultEntry[] = [];
  const originWitnesses = new Set<string>();
  const originAuthorizations = new Set<string>();
  for (const kind of ['secret', 'variable'] as const) {
    const capability = kind === 'secret' ? 'secrets.use' : 'variables.read';
    if (names[kind].length) await authorizeVault(c, input.principal, capability, context);
    const candidates = names[kind].length ? await many<VaultEntry>(db, `SELECT e.* FROM vault_entries e WHERE e.kind=? AND e.deleted_at IS NULL
      AND e.name IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM json_each(?) s
        WHERE e.account_id=json_extract(s.value,'$.account_id') AND e.scope_type=json_extract(s.value,'$.scope_type') AND e.scope_id=json_extract(s.value,'$.scope_id'))`,
    kind, JSON.stringify(names[kind]), JSON.stringify(scopes)) : [];
    for (const name of names[kind]) {
      const entry = candidates.filter((e) => e.name === name).sort((a, b) => scopes.findIndex((s) => scopeKey(s) === scopeKey(b)) - scopes.findIndex((s) => scopeKey(s) === scopeKey(a)))[0];
      if (!entry) throw new ApiError(403, 'declared_name_unavailable', 'A declared secret or variable is unavailable in the applicable scopes.');
      // A denied high-precedence entry never falls back to a more permissive lower scope.
      assertUsePolicy(entry, context);
      if (entry.account_id !== context.account_id) {
        const origin = { account_id: entry.account_id, repo_id: null };
        if (!originWitnesses.has(entry.account_id)) witnesses.push(await witness(origin));
        originWitnesses.add(entry.account_id);
        const authorization = `${entry.account_id}:${capability}`;
        if (!originAuthorizations.has(authorization)) {
          await authorizeVault(c, input.principal, capability, origin);
          originAuthorizations.add(authorization);
        }
      }
      const version = await one<VaultVersion>(db, `SELECT v.* FROM vault_versions v WHERE v.id=? AND v.entry_id=? AND v.account_id=?
        AND NOT EXISTS(SELECT 1 FROM vault_version_revocations x WHERE x.version_id=v.id)`, entry.current_version_id, entry.id, entry.account_id);
      if (!version) throw new ApiError(403, 'secret_version_revoked', 'A selected value version is unavailable.');
      selected.set(`${kind}:${name}`, selectedVersion(entry, version));
      entries.push(entry);
    }
  }
  const steps = input.steps.map((step) => ({ step_id: step.step_id,
    secrets: step.secrets.map((name) => selected.get(`secret:${name}`)!), variables: step.variables.map((name) => selected.get(`variable:${name}`)!) }));
  const sizes = new Map([...selected.entries()].map(([key, value]) => [key, new TextEncoder().encode(canonicalJson(value)).byteLength]));
  let selectedBytes = 4096;
  for (const step of input.steps) {
    selectedBytes += step.step_id.length + 128;
    for (const name of step.secrets) selectedBytes += sizes.get(`secret:${name}`)! + 1;
    for (const name of step.variables) selectedBytes += sizes.get(`variable:${name}`)! + 1;
  }
  if (selectedBytes > 512 * 1024) throw new ApiError(422, 'selection_too_large', 'The expanded per-step vault selection must fit 512 KiB.');
  return { context, steps, selection_digest: await sha256(canonicalJson({ context, steps })), entries, witnesses, repository_revision: repository.revision };
}

export async function selectPlan(c: AppContext, client: BrokerClient, input: PlanSelectionInput): Promise<PlanSelection> {
  const db = identityDatabase(c);
  const { context, steps, selection_digest, entries, witnesses } = await resolvePlan(c, client, input, false);
  await assertActiveVaultEnvironment(c.env, context);
  const selection: PlanSelection = { selection_id: newId('vsel'), selection_digest, context, steps };
  const guards = entries.map(() => newId('vault_guard'));
  await vaultBatch(db, stmt(db, `INSERT INTO vault_selections (id,account_id,repo_id,actor_id,actor_credential_id,workflow_id,selection_digest,context_json,steps_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, selection.selection_id, context.account_id, context.repo_id, context.actor_id, context.actor_credential_id, context.workflow_id,
  selection.selection_digest, canonicalJson(context), canonicalJson(steps), now()), [
    ...entries.map((entry, i) => stmt(db, `INSERT INTO vault_write_guards (id,valid) SELECT ?,CASE WHEN EXISTS
      (SELECT 1 FROM vault_entries WHERE id=? AND account_id=? AND current_version_id=? AND revision=? AND deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM vault_version_revocations WHERE version_id=?) THEN 1 ELSE 0 END`, guards[i], entry.id, entry.account_id, entry.current_version_id, entry.revision, entry.current_version_id)),
    auditStatement(db, { action: 'vault.plan.selected', resource_id: selection.selection_id, account_id: context.account_id, repo_id: context.repo_id,
      actor_id: input.principal.id, credential_id: input.principal.credential_id, request_id: c.get('requestId'), details: { selection_digest: selection.selection_digest,
        versions: entries.map(entry => ({ entry_id: entry.id, version_id: entry.current_version_id, scope_type: entry.scope_type })) } }),
    stmt(db, 'DELETE FROM vault_write_guards WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(guards)),
  ], witnesses);
  return selection;
}

export async function previewPlan(c: AppContext, client: BrokerClient, input: PlanSelectionInput): Promise<PlanSelectionPreview> {
  const result = await resolvePlan(c, client, input, true);
  const repository = await readRepositoryAuthority(c, input.repo_id);
  if (!repository || repository.revision !== result.repository_revision || repository.owner_id !== result.context.account_id
    || repository.routing_epoch !== result.context.routing_epoch) throw new ApiError(409, 'preview_authority_changed', 'The repository changed during vault preview.');
  if (input.environment_id) await resolveVaultScope(c, { repo_id: input.repo_id, environment_id: input.environment_id });
  for (const entry of result.entries) assertUsePolicy(entry, result.context);
  const db = identityDatabase(c);
  await vaultReadGuard(db, result.witnesses, result.entries.map(entry => stmt(db, `SELECT CASE WHEN EXISTS
    (SELECT 1 FROM vault_entries WHERE id=? AND account_id=? AND current_version_id=? AND revision=? AND deleted_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM vault_version_revocations WHERE version_id=?) THEN 1 ELSE 0 END AS valid`,
  entry.id, entry.account_id, entry.current_version_id, entry.revision, entry.current_version_id)));
  const metadata = ({ value: _value, ...version }: SelectedVersion): Omit<SelectedVersion, 'value'> => version;
  return { selection_digest: result.selection_digest, context: result.context, steps: result.steps.map(step => ({ step_id: step.step_id,
    secrets: step.secrets.map(metadata), variables: step.variables.map(metadata) })) };
}

export function selectedVersion(entry: VaultEntry, version: VaultVersion): SelectedVersion {
  return { name: entry.name, kind: entry.kind, secret_id: entry.id, entry_id: entry.id, version_id: version.id, version: version.version,
    policy_revision: entry.policy_revision, account_id: entry.account_id, repo_id: entry.repo_id, environment_id: entry.environment_id,
    scope_type: entry.scope_type, scope_id: entry.scope_id, ...(entry.kind === 'variable' ? { value: version.plain_value! } : {}) };
}

export async function bindPlan(c: AppContext, client: BrokerClient, input: { selection_id: string; plan_digest: string; principal: PlanSelectionInput['principal'] }): Promise<{ bound: true }> {
  const selection = await one<SelectionRow>(c.env.DB, 'SELECT * FROM vault_selections WHERE id=?', input.selection_id);
  if (!selection || selection.actor_id !== input.principal.id || selection.actor_credential_id !== input.principal.credential_id) throw new ApiError(404, 'not_found', 'The selection was not found.');
  checkClientScope(client, selection);
  const witness = await authorizationWitness(c, input.principal, selection);
  await authorizeVault(c, input.principal, 'workflows.run', selection);
  await assertActiveVaultEnvironment(c.env, JSON.parse(selection.context_json) as SelectionContext);
  if (selection.plan_digest === input.plan_digest) return { bound: true };
  if (selection.plan_digest !== null) throw new ApiError(409, 'selection_already_bound', 'A selection cannot be rebound to a different plan.');
  await vaultBatch(c.env.DB, stmt(c.env.DB, 'UPDATE vault_selections SET plan_digest=?,bound_at=? WHERE id=? AND plan_digest IS NULL', input.plan_digest, now(), selection.id), [
    auditStatement(c.env.DB, { action: 'vault.plan.bound', resource_id: selection.id, account_id: selection.account_id, repo_id: selection.repo_id,
      actor_id: input.principal.id, request_id: c.get('requestId'), details: { plan_digest: input.plan_digest, selection_digest: selection.selection_digest } }),
  ], [witness]);
  return { bound: true };
}
