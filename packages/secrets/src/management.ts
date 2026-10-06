import { ApiError, auditStatement, canonicalJson, eventStatement, hmac, many, newId, now, one, sha256, stmt, identityDatabase, readRepositoryAuthority } from '@gitknot/core';
import type { AppContext, Principal } from '@gitknot/core';
import { assertActiveVaultEnvironment, authorizationWitness, authorizeVault, checkClientScope, resolveVaultScope } from './authorization.ts';
import { entryIdentity, envelopeStatements, publicEntry, vaultBatch } from './database.ts';
import { sealValue } from './crypto.ts';
import { activeEncryptionKey } from './keys.ts';
import { defaultVaultPolicy, vaultPolicySchema } from './schema.ts';
import { vaultMetadata } from './authority.ts';
import type { BrokerClient, ScopeSelector, SecretsBrokerBindings, VaultEntry, VaultKind, VaultPolicy, VaultVersion, WriteEntryInput } from './types.ts';

export async function findEntry(c: AppContext, selector: ScopeSelector, kind: VaultKind, name: string): Promise<VaultEntry | null> {
  const scope = await resolveVaultScope(c, selector, true);
  return one<VaultEntry>(identityDatabase(c), 'SELECT * FROM vault_entries WHERE account_id=? AND scope_type=? AND scope_id=? AND kind=? AND name=?', scope.account_id, scope.scope_type, scope.scope_id, kind, name);
}

function manager(kind: VaultKind): string { return kind === 'secret' ? 'secrets.manage' : 'variables.manage'; }

function encodedPolicy(policy: VaultPolicy): string {
  const value = canonicalJson(policy);
  if (new TextEncoder().encode(value).byteLength > 16_384) throw new ApiError(422, 'vault_policy_too_large', 'A vault policy must fit 16 KiB of canonical JSON.');
  return value;
}

async function operation(c: AppContext, client: BrokerClient, principal: Principal, id: string, input: unknown): Promise<{ id: string; hash: string; resource_id: string | null }> {
  const operationId = `vault_op_${await sha256(`${client.id}:${principal.id}:${id}`)}`;
  // A keyed fingerprint prevents an offline dictionary attack against low-entropy secret values in an idempotency journal.
  const source = input as Record<string, unknown>;
  const hash = await hmac(client.key, canonicalJson({ ...source, principal: { id: principal.id, kind: principal.kind, user_id: principal.user_id } }));
  const previous = await one<{ request_hash: string; resource_id: string }>(c.env.DB, 'SELECT request_hash,resource_id FROM vault_operations WHERE id=? AND principal_id=?', operationId, principal.id);
  if (previous && previous.request_hash !== hash) throw new ApiError(409, 'idempotency_conflict', 'This vault operation ID has different inputs.');
  return { id: operationId, hash, resource_id: previous?.resource_id ?? null };
}

async function operationResult(c: AppContext, resourceId: string, scope: Awaited<ReturnType<typeof resolveVaultScope>>, kind: VaultKind): Promise<Record<string, unknown>> {
  const entry = await one<VaultEntry>(c.env.DB, 'SELECT * FROM vault_entries WHERE id=? AND account_id=? AND scope_type=? AND scope_id=? AND kind=?', resourceId, scope.account_id, scope.scope_type, scope.scope_id, kind);
  if (!entry) throw new ApiError(404, 'not_found', 'The currently authorized vault entry was not found.');
  const version = await one<{ version: number }>(c.env.DB, 'SELECT version FROM vault_versions WHERE id=? AND entry_id=? AND account_id=?', entry.current_version_id, entry.id, scope.account_id);
  return { ...publicEntry(entry), version: version?.version };
}

export async function writeEntry(c: AppContext, env: SecretsBrokerBindings, client: BrokerClient, input: WriteEntryInput): Promise<Record<string, unknown>> {
  const scope = await resolveVaultScope(c, input.scope);
  checkClientScope(client, scope);
  const witness = await authorizationWitness(c, input.principal, scope);
  await authorizeVault(c, input.principal, manager(input.kind), scope);
  // Capture the account epoch before the last active-environment observation. Retirement
  // between this read and the guarded write changes that epoch and aborts the whole batch.
  await assertActiveVaultEnvironment(env, scope);
  if (new TextEncoder().encode(input.value).length > 16_384 || (input.kind === 'secret' && input.value.length === 0)) {
    throw new ApiError(422, 'invalid_value_size', 'A secret must be nonempty and values must fit 16 KiB of UTF-8 data.');
  }
  const op = await operation(c, client, input.principal, input.operation_id, input);
  if (op.resource_id) return operationResult(c, op.resource_id, scope, input.kind);
  const previous = await findEntry(c, input.scope, input.kind, input.name);
  if ((previous?.revision ?? null) !== input.expected_revision) throw new ApiError(412, 'revision_conflict', 'The vault entry changed; refresh its metadata before writing.');
  const current = previous ? await one<VaultVersion>(env.DB, 'SELECT * FROM vault_versions WHERE id=? AND entry_id=? AND account_id=?', previous.current_version_id, previous.id, scope.account_id) : null;
  if (previous && !current) throw new ApiError(503, 'vault_version_missing', 'The vault version requires reconciliation.');
  const policy = input.policy ?? (previous ? vaultPolicySchema.parse(JSON.parse(previous.policy_json)) : defaultVaultPolicy(scope.repo_id));
  if (policy.allow_cross_account && scope.scope_type !== 'user') throw new ApiError(422, 'invalid_cross_account_policy', 'Only a personal secret may opt into named cross-account repositories.');
  const at = now();
  const policyJson = encodedPolicy(policy);
  const id = previous?.id ?? newId(input.kind === 'secret' ? 'secret' : 'var');
  const version: VaultVersion = { id: newId('vver'), entry_id: id, account_id: scope.account_id, version: (current?.version ?? 0) + 1,
    ciphertext_id: null, plain_value: null, created_at: at, created_by: input.principal.id };
  if (input.kind === 'secret') version.ciphertext_id = version.id;
  else version.plain_value = input.value;
  const entry: VaultEntry = { ...scope, id, kind: input.kind, name: input.name, description: input.description ?? previous?.description ?? '',
    policy_json: policyJson, policy_revision: (previous?.policy_revision ?? 1) + Number(!!previous && policyJson !== previous.policy_json),
    current_version_id: version.id, revision: (previous?.revision ?? 0) + 1, deleted_at: null, created_by: previous?.created_by ?? input.principal.id,
    created_at: previous?.created_at ?? at, updated_at: at };
  const response = publicEntry(entry, version);
  const after: D1PreparedStatement[] = [];
  if (input.kind === 'secret') after.push(...envelopeStatements(env.DB, await sealValue(input.value, entryIdentity(entry, version), await activeEncryptionKey(env))));
  after.push(stmt(env.DB, 'INSERT INTO vault_versions (id,entry_id,account_id,version,ciphertext_id,plain_value,created_at,created_by) VALUES (?,?,?,?,?,?,?,?)',
    version.id, id, scope.account_id, version.version, version.ciphertext_id, version.plain_value, at, input.principal.id));
  if (previous && input.revoke_previous !== false) after.push(stmt(env.DB,
    'INSERT OR IGNORE INTO vault_version_revocations (version_id,account_id,entry_id,revoked_at,revoked_by,reason) VALUES (?,?,?,?,?,?)',
    previous.current_version_id, scope.account_id, id, at, input.principal.id, 'Superseded by a new immutable value version.'));
  after.push(stmt(env.DB, 'INSERT INTO vault_operations (id,account_id,principal_id,request_hash,resource_id,response_json,created_at) VALUES (?,?,?,?,?,?,?)',
    op.id, scope.account_id, input.principal.id, op.hash, id, JSON.stringify({ resource_id: id, version_id: version.id, revision: entry.revision }), at),
  auditStatement(env.DB, { action: `${input.kind}.${previous ? 'rotated' : 'created'}`, resource_id: id, resource_revision: entry.revision,
    account_id: scope.account_id, repo_id: scope.repo_id, actor_id: input.principal.id, credential_id: input.principal.credential_id,
    request_id: c.get('requestId'), details: { name: input.name, version_id: version.id, scope_type: scope.scope_type, policy_revision: entry.policy_revision } }),
  eventStatement(env.DB, { type: `${input.kind}.${previous ? 'rotated' : 'created'}`, resource_id: id, resource_revision: entry.revision,
    account_id: scope.account_id, repo_id: scope.repo_id, actor_id: input.principal.id, data: { name: input.name, version_id: version.id } }));
  const first = previous
    ? stmt(env.DB, 'UPDATE vault_entries SET current_version_id=?,description=?,policy_json=?,policy_revision=?,deleted_at=NULL,revision=revision+1,updated_at=? WHERE id=? AND account_id=? AND revision=?',
      version.id, entry.description, entry.policy_json, entry.policy_revision, at, id, scope.account_id, input.expected_revision)
    : stmt(env.DB, `INSERT INTO vault_entries (id,account_id,repo_id,environment_id,scope_type,scope_id,kind,name,description,policy_json,policy_revision,current_version_id,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, scope.account_id, scope.repo_id, scope.environment_id, scope.scope_type, scope.scope_id, input.kind, input.name,
    entry.description, entry.policy_json, entry.policy_revision, version.id, input.principal.id, at, at);
  try { await vaultBatch(env.DB, first, after, [witness]); }
  catch (error) {
    const replay = await operation(c, client, input.principal, input.operation_id, input);
    if (replay.resource_id) return operationResult(c, replay.resource_id, scope, input.kind);
    throw error;
  }
  return response;
}

export interface ManageEntryInput {
  principal: Principal; scope: ScopeSelector; kind: VaultKind; name: string; expected_revision: number; operation_id: string;
  policy?: VaultPolicy; version_id?: string; reason?: string;
}

export async function changeEntry(c: AppContext, client: BrokerClient, action: 'delete' | 'policy' | 'revoke-version', input: ManageEntryInput): Promise<Record<string, unknown>> {
  const scope = await resolveVaultScope(c, input.scope, action !== 'policy');
  checkClientScope(client, scope);
  const witness = await authorizationWitness(c, input.principal, scope);
  await authorizeVault(c, input.principal, manager(input.kind), scope, action !== 'policy');
  if (action === 'policy') await assertActiveVaultEnvironment(c.env, scope);
  const op = await operation(c, client, input.principal, input.operation_id, { action, ...input });
  if (op.resource_id) return operationResult(c, op.resource_id, scope, input.kind);
  const entry = await findEntry(c, input.scope, input.kind, input.name);
  if (!entry) throw new ApiError(404, 'not_found', 'The vault entry was not found.');
  if (entry.revision !== input.expected_revision) throw new ApiError(412, 'revision_conflict', 'The vault entry changed.');
  const at = now();
  const updated = { ...entry, revision: entry.revision + 1, updated_at: at };
  if (action === 'delete') updated.deleted_at = at;
  if (action === 'policy') {
    updated.policy_json = encodedPolicy(vaultPolicySchema.parse(input.policy));
    updated.policy_revision += 1;
  }
  const after: D1PreparedStatement[] = [];
  if (action === 'revoke-version') {
    const version = await one(c.env.DB, 'SELECT id FROM vault_versions WHERE id=? AND entry_id=? AND account_id=?', input.version_id, entry.id, scope.account_id);
    if (!version) throw new ApiError(404, 'not_found', 'The scoped secret version was not found.');
    after.push(stmt(c.env.DB, 'INSERT OR IGNORE INTO vault_version_revocations (version_id,account_id,entry_id,revoked_at,revoked_by,reason) VALUES (?,?,?,?,?,?)',
      input.version_id, scope.account_id, entry.id, at, input.principal.id, input.reason ?? 'Revoked by a secret manager.'));
  }
  const response = publicEntry(updated);
  after.push(stmt(c.env.DB, 'INSERT INTO vault_operations (id,account_id,principal_id,request_hash,resource_id,response_json,created_at) VALUES (?,?,?,?,?,?,?)',
    op.id, scope.account_id, input.principal.id, op.hash, entry.id, JSON.stringify({ resource_id: entry.id, revision: updated.revision }), at),
  auditStatement(c.env.DB, { action: `${entry.kind}.${action}`, resource_id: entry.id, resource_revision: updated.revision, account_id: scope.account_id,
    repo_id: scope.repo_id, actor_id: input.principal.id, credential_id: input.principal.credential_id, request_id: c.get('requestId'),
    details: { version_id: input.version_id ?? null, policy_revision: updated.policy_revision, reason: input.reason ?? null } }),
  eventStatement(c.env.DB, { type: `${entry.kind}.${action.replace('-', '_')}`, resource_id: entry.id, resource_revision: updated.revision,
    account_id: scope.account_id, repo_id: scope.repo_id, actor_id: input.principal.id }));
  await vaultBatch(c.env.DB, stmt(c.env.DB, 'UPDATE vault_entries SET policy_json=?,policy_revision=?,deleted_at=?,revision=revision+1,updated_at=? WHERE id=? AND account_id=? AND revision=?',
    updated.policy_json, updated.policy_revision, updated.deleted_at, at, entry.id, scope.account_id, input.expected_revision), after, [witness]);
  return response;
}

/** A transfer revokes the old owner's repository/environment namespace; it never hands those values to the receiver. */
export async function fenceRepositoryVault(c: AppContext, client: BrokerClient, input: { repo_id: string; previous_account_id: string; operation_id: string }): Promise<{ revoked: true }> {
  checkClientScope(client, { account_id: input.previous_account_id, repo_id: input.repo_id });
  const receipt = await one(c.env.DB, 'SELECT id FROM audit_log WHERE id=? AND repo_id=? AND account_id=?', `audit:vault-transfer:${input.operation_id}`, input.repo_id, input.previous_account_id);
  const active = await one(c.env.DB, 'SELECT id FROM vault_entries WHERE repo_id=? AND account_id=? AND deleted_at IS NULL LIMIT 1', input.repo_id, input.previous_account_id);
  if (receipt && !active) return { revoked: true };
  const repo = await readRepositoryAuthority(c, input.repo_id);
  const lifecycle = await vaultMetadata<{ operation: { kind: string; status: string; account_id: string } | null; fenced: boolean }>(c.env,
    { action: 'lifecycle', resource_id: input.operation_id, repo_id: input.repo_id });
  const operation = lifecycle.operation?.account_id === input.previous_account_id ? lifecycle.operation : null;
  const fence = lifecycle.fenced;
  if (!repo || !operation || !/(?:^|\.)(?:delete|transfer|restore|purge)$/.test(operation.kind)
    || !['pending', 'running', 'waiting'].includes(operation.status) || (!fence && !['transfer_pending', 'moving', 'deleted'].includes(repo.state))) {
    throw new ApiError(409, 'repository_not_fenced', 'An authoritative lifecycle operation must fence the repository before revoking its vault namespace.');
  }
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE vault_entries SET deleted_at=?,revision=revision+1,updated_at=? WHERE repo_id=? AND account_id=? AND deleted_at IS NULL', now(), now(), input.repo_id, input.previous_account_id),
    auditStatement(c.env.DB, { id: receipt ? newId('audit') : `audit:vault-transfer:${input.operation_id}`, action: 'vault.repository.fenced', resource_id: input.repo_id, account_id: input.previous_account_id,
      repo_id: input.repo_id, actor_id: `service:${client.id}`, details: { operation_id: input.operation_id } }),
  ]);
  return { revoked: true };
}
