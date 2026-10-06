import { ApiError, auditStatement, canonicalJson, many, newId, now, one, sha256, stmt } from '@gitknot/core';
import type { AppContext, Principal } from '@gitknot/core';
import { assertUsePolicy, authorizationWitness, authorizeVault, checkClientScope, currentRuntimePrincipal } from './authorization.ts';
import type { AuthorizationWitness } from './authorization.ts';
import { loadKeyring } from './crypto.ts';
import { entryIdentity, vaultBatch } from './database.ts';
import { decryptCiphertext } from './keys.ts';
import { selectedVersion } from './plans.ts';
import type { SelectionRow } from './plans.ts';
import type { BrokerClient, Ciphertext, PlanSelection, ResolveAttemptInput, ResolvedSecrets, RuntimeContext, SecretsBrokerBindings, SelectedVersion, VaultEntry, VaultVersion } from './types.ts';
import { vaultMetadata } from './authority.ts';
import type { RuntimeSnapshot } from './authority.ts';
import { identityRunnerPredicate } from '../../execution/src/runner-authority.ts';

interface Approval {
  repo_id: string; environment_id: string; attempt_id: string; generation: number; plan_digest: string; commit_oid: string;
  artifact_digest: string; destination: string; policy_revision: number; approver_id: string; approved_at: string;
  expires_at: string; revoked_at: string | null; current_commit_oid: string | null; approver_credential_id: string | null; approver_mfa: number;
}
interface Environment { id: string; repo_id: string; account_id: string; destination: string; target_ref: string; revision: number; required_approvals: number; allow_self_approval: number; allowed_approvers_json: string; state: string; deleted_at: string | null }

function contextMatches(selection: PlanSelection['context'], current: RuntimeContext): boolean {
  return Object.entries(selection).every(([key, value]) => current[key as keyof RuntimeContext] === value);
}

export function assertRuntimeContext(context: RuntimeContext, input: ResolveAttemptInput, at = now()): void {
  if (context.attempt_id !== input.attempt_id || context.generation !== input.generation || context.state !== 'running'
    || !context.lease_expires_at || Date.parse(context.lease_expires_at) <= Date.parse(at) || context.credentials_revoked_at !== null
    || context.trust_class !== 'trusted') throw new ApiError(403, 'attempt_not_authorized', 'This attempt generation is not currently authorized to receive secrets.');
}

function approvalMatches(approval: Approval, context: RuntimeContext, at: string): boolean {
  return approval.repo_id === context.repo_id && approval.environment_id === context.environment_id && approval.attempt_id === context.attempt_id
    && approval.generation === context.generation && approval.plan_digest === context.plan_digest && approval.commit_oid === context.commit_oid
    && approval.current_commit_oid === context.commit_oid && approval.artifact_digest === context.artifact_digest && approval.destination === context.destination
    && approval.policy_revision === context.policy_revision && approval.revoked_at === null && approval.expires_at > at && approval.approved_at <= at;
}

async function authorizeEnvironment(c: AppContext, context: RuntimeContext, snapshot: RuntimeSnapshot, witnesses: AuthorizationWitness[]): Promise<void> {
  if (!context.environment_id) return;
  const environment = snapshot.environment as unknown as Environment | null;
  if (!environment || environment.state !== 'active' || environment.deleted_at !== null || environment.account_id !== context.account_id
    || environment.destination !== context.destination || !context.artifact_digest) throw new ApiError(403, 'environment_denied', 'The environment, destination or exact approved artifact is no longer current.');
  const approvalRows = snapshot.approvals as unknown as Approval[];
  const allowed = JSON.parse(environment.allowed_approvers_json) as string[];
  const authorized = new Set<string>();
  for (const approval of approvalRows) {
    if (!approvalMatches(approval, context, now()) || (!environment.allow_self_approval && approval.approver_id === context.actor_id)
      || (allowed.length && !allowed.includes(approval.approver_id))) continue;
    const person = await one<{ id: string; kind: Principal['kind']; user_id: string | null }>(c.env.DB, 'SELECT id,kind,user_id FROM principals WHERE id=?', approval.approver_id);
    if (!person) continue;
    const principal = await currentRuntimePrincipal(c.env.DB, { actor_id: person.id, actor_kind: person.kind,
      actor_user_id: person.user_id, actor_credential_id: approval.approver_credential_id ?? null });
    principal.mfa = principal.mfa && approval.approver_mfa === 1;
    const witness = await authorizationWitness(c, principal, context);
    try { await authorizeVault(c, principal, 'environments.approve', context); }
    catch (error) { if (error instanceof ApiError && error.status < 500) continue; throw error; }
    witnesses.push(witness);
    authorized.add(principal.id);
  }
  if (authorized.size < environment.required_approvals) throw new ApiError(403, 'environment_approval_required', 'Current authorized approvals must bind this exact artifact, commit, plan and destination.');
}

async function getSelection(c: AppContext, context: RuntimeContext): Promise<PlanSelection> {
  const row = await one<SelectionRow>(c.env.DB, 'SELECT * FROM vault_selections WHERE repo_id=? AND account_id=? AND plan_digest=? AND selection_digest=? ORDER BY id LIMIT 1',
    context.repo_id, context.account_id, context.plan_digest, context.selection_digest);
  if (!row) throw new ApiError(403, 'plan_selection_missing', 'The frozen execution plan has no authorized vault selection.');
  const selection = { selection_id: row.id, selection_digest: row.selection_digest,
    context: JSON.parse(row.context_json), steps: JSON.parse(row.steps_json) } as PlanSelection;
  if (await sha256(canonicalJson({ context: selection.context, steps: selection.steps })) !== context.selection_digest || !contextMatches(selection.context, context)) {
    throw new ApiError(403, 'plan_selection_changed', 'The attempt does not match the frozen vault selection.');
  }
  return selection;
}

function authorizeExecutor(context: RuntimeContext, snapshot: RuntimeSnapshot, witnesses: AuthorizationWitness[]): void {
  if (context.executor !== 'self_hosted') return;
  const row = snapshot.runner;
  if (!row || row.id !== context.runner_pool_id || row.account_id !== context.account_id || row.state !== 'active' || row.trust !== 'trusted'
    || row.runner_id !== context.runner_id || row.runner_state !== 'active' || row.pool_id !== row.id
    || !context.runner_credential_hash || !context.runner_credential_generation
    || row.credential_generation !== context.runner_credential_generation || row.credential_hash !== context.runner_credential_hash
    || row.credential_expires_at <= now() || (row.repo_id !== null && row.repo_id !== context.repo_id)
    || (row.runner_repo_id !== null && row.runner_repo_id !== context.repo_id)) throw new ApiError(403, 'runner_trust_changed', 'The selected runner pool or original machine credential is no longer authorized.');
  const predicate = identityRunnerPredicate(row.witness);
  witnesses.push({ sql: `SELECT CASE WHEN ${predicate.sql} THEN '1' ELSE '0' END`, bindings: predicate.values, value: '1' });
}

function stableSnapshot(snapshot: RuntimeSnapshot): string {
  const context = snapshot.context ? { ...snapshot.context, lease_expires_at: null } : null;
  return canonicalJson({ ...snapshot, context });
}

export async function resolveRuntime(c: AppContext, env: SecretsBrokerBindings, client: BrokerClient, input: ResolveAttemptInput): Promise<ResolvedSecrets> {
  const snapshot = await vaultMetadata<RuntimeSnapshot>(env, { action: 'runtime', resource_id: input.attempt_id, generation: input.generation });
  const context = snapshot.context;
  if (!context) throw new ApiError(403, 'attempt_not_authorized', 'The authoritative attempt is unavailable.');
  assertRuntimeContext(context, input);
  checkClientScope(client, context);
  const principal = await currentRuntimePrincipal(env.DB, context);
  const witnesses = [await authorizationWitness(c, principal, context)];
  await authorizeVault(c, principal, 'secrets.use', context);
  authorizeExecutor(context, snapshot, witnesses);
  const selection = await getSelection(c, context);
  const step = selection.steps.find((s) => s.step_id === input.step_id);
  if (!step || new Set(input.names).size !== input.names.length || input.names.some((name) => !step.secrets.some((s) => s.name === name))) {
    throw new ApiError(403, 'undeclared_secret', 'Only exact per-step names declared by the frozen plan may be released.');
  }
  await authorizeEnvironment(c, context, snapshot, witnesses);
  const ring = await loadKeyring(env);
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  const versions: SelectedVersion[] = [];
  const entries: VaultEntry[] = [];
  const buffers: Uint8Array<ArrayBuffer>[] = [];
  const originAccounts = new Set<string>();
  try {
    for (const name of input.names) {
      const selected = step.secrets.find((s) => s.name === name)!;
      const entry = await one<VaultEntry>(env.DB, 'SELECT * FROM vault_entries WHERE id=? AND account_id=? AND kind=?', selected.entry_id, selected.account_id, 'secret');
      if (!entry || entry.name !== name || entry.policy_revision !== selected.policy_revision) throw new ApiError(403, 'secret_policy_changed', 'Replan after a vault scope or policy change.');
      assertUsePolicy(entry, context);
      if (entry.account_id !== context.account_id) {
        const origin = { account_id: entry.account_id, repo_id: null };
        if (!originAccounts.has(entry.account_id)) {
          witnesses.push(await authorizationWitness(c, principal, origin));
          await authorizeVault(c, principal, 'secrets.use', origin);
          originAccounts.add(entry.account_id);
        }
      }
      const version = await one<VaultVersion>(env.DB, `SELECT v.* FROM vault_versions v WHERE v.id=? AND v.entry_id=? AND v.account_id=?
        AND NOT EXISTS (SELECT 1 FROM vault_version_revocations r WHERE r.version_id=v.id)`, selected.version_id, entry.id, entry.account_id);
      if (!version?.ciphertext_id || version.version !== selected.version) throw new ApiError(403, 'secret_version_revoked', 'The pinned secret version is unavailable.');
      const ciphertext = await one<Ciphertext>(env.DB, 'SELECT * FROM vault_ciphertexts WHERE id=? AND account_id=? AND purpose=?', version.ciphertext_id, entry.account_id, 'tenant_secret');
      if (!ciphertext) throw new ApiError(503, 'secret_ciphertext_missing', 'An encrypted version requires recovery.');
      const plaintext = await decryptCiphertext(env.DB, ring, ciphertext, entryIdentity(entry, version));
      buffers.push(plaintext);
      values[name] = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
      versions.push(selectedVersion(entry, version));
      entries.push(entry);
    }
    const finalSnapshot = await vaultMetadata<RuntimeSnapshot>(env, { action: 'runtime', resource_id: input.attempt_id, generation: input.generation });
    const finalContext = finalSnapshot.context;
    if (!finalContext) throw new ApiError(403, 'attempt_fenced', 'The attempt changed before secret release.');
    assertRuntimeContext(finalContext, input);
    if (stableSnapshot(snapshot) !== stableSnapshot(finalSnapshot)) throw new ApiError(409, 'attempt_fenced', 'The current attempt, approval or runner authority changed before release.');
    const auditId = newId('vuse');
    const at = now();
    const guardIds = entries.map(() => newId('vault_guard'));
    await vaultBatch(env.DB, stmt(env.DB, `INSERT INTO vault_use_events
      (id,account_id,repo_id,attempt_id,generation,step_id,plan_digest,selection_digest,actor_id,version_ids_json,service_client_id,authorization_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    auditId, context.account_id, context.repo_id, context.attempt_id, context.generation, input.step_id, context.plan_digest, context.selection_digest,
    principal.id, JSON.stringify(versions.map((v) => v.version_id)), client.id, await sha256(canonicalJson(witnesses.map((w) => w.value))), at), [
      ...entries.map((entry, i) => stmt(env.DB, `INSERT INTO vault_write_guards (id,valid) SELECT ?,CASE WHEN EXISTS
        (SELECT 1 FROM vault_entries WHERE id=? AND account_id=? AND revision=? AND policy_revision=? AND deleted_at IS NULL
          AND COALESCE(json_extract(policy_json,'$.not_before'),'')<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND COALESCE(json_extract(policy_json,'$.expires_at'),'9999')>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        AND NOT EXISTS(SELECT 1 FROM vault_version_revocations WHERE version_id=?) THEN 1 ELSE 0 END`, guardIds[i], entry.id, entry.account_id,
      entry.revision, entry.policy_revision, versions[i]!.version_id)),
      auditStatement(env.DB, { id: `audit:${auditId}`, action: 'secrets.used', resource_id: context.attempt_id, account_id: context.account_id, repo_id: context.repo_id,
        actor_id: principal.id, credential_id: principal.credential_id, request_id: c.get('requestId'), details: { use_id: auditId, generation: context.generation,
          step_id: input.step_id, plan_digest: context.plan_digest, selection_digest: context.selection_digest, version_ids: versions.map((v) => v.version_id), service_client_id: client.id } }),
      stmt(env.DB, 'DELETE FROM vault_write_guards WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(guardIds)),
    ], witnesses);
    return { values, versions, expires_at: context.lease_expires_at!, audit_id: auditId };
  } catch (error) {
    for (const name of Object.keys(values)) delete values[name];
    // A denial audit is a separate durable event; it never contains plaintext or a full untrusted request.
    await auditStatement(env.DB, { action: 'secrets.use_denied', resource_id: context.attempt_id, account_id: context.account_id, repo_id: context.repo_id,
      actor_id: principal.id, request_id: c.get('requestId'), details: { generation: input.generation, step_id: input.step_id, code: error instanceof ApiError ? error.code : 'vault_unavailable' } }).run();
    throw error;
  } finally { for (const buffer of buffers) buffer.fill(0); }
}
