import { ApiError, newId, stmt } from '@gitknot/core';
import type { Database } from '@gitknot/core';
import { witnessStatement } from './authorization.ts';
import type { AuthorizationWitness } from './authorization.ts';
import type { CipherIdentity, Envelope, VaultEntry, VaultVersion } from './types.ts';

export function entryIdentity(entry: VaultEntry, version: VaultVersion): CipherIdentity {
  return { format: 1, purpose: 'tenant_secret', account_id: entry.account_id, repo_id: entry.repo_id, environment_id: entry.environment_id,
    scope_type: entry.scope_type, scope_id: entry.scope_id, entry_id: entry.id, name: entry.name, version_id: version.id, version: version.version };
}

export function publicEntry(entry: VaultEntry, version?: VaultVersion): Record<string, unknown> {
  return { id: entry.id, account_id: entry.account_id, repo_id: entry.repo_id, environment_id: entry.environment_id, scope_type: entry.scope_type,
    scope_id: entry.scope_id, kind: entry.kind, name: entry.name, description: entry.description, policy: JSON.parse(entry.policy_json),
    policy_revision: entry.policy_revision, current_version_id: entry.current_version_id, version: version?.version,
    revision: entry.revision, created_at: entry.created_at, updated_at: entry.updated_at, deleted_at: entry.deleted_at,
    ...(entry.kind === 'variable' && version ? { value: version.plain_value } : {}) };
}

export function envelopeStatements(db: Database, envelope: Envelope): D1PreparedStatement[] {
  const c = envelope.ciphertext, w = envelope.wrap;
  const guard = newId('vault_guard');
  return [
    stmt(db, `INSERT INTO vault_write_guards (id,valid) SELECT ?,CASE WHEN EXISTS
      (SELECT 1 FROM vault_key_control c JOIN vault_key_registry k ON k.id=c.active_key_id
      WHERE c.id=1 AND c.write_fenced=0 AND c.active_key_id=? AND k.state='active') THEN 1 ELSE 0 END`, guard, w.key_id),
    stmt(db, 'INSERT INTO vault_ciphertexts (id,account_id,purpose,context_json,iv,ciphertext,created_at) VALUES (?,?,?,?,?,?,?)', c.id, c.account_id, c.purpose, c.context_json, c.iv, c.ciphertext, c.created_at),
    stmt(db, 'INSERT INTO vault_key_wraps (ciphertext_id,key_id,iv,wrapped_dek,created_at) VALUES (?,?,?,?,?)', w.ciphertext_id, w.key_id, w.iv, w.wrapped_dek, w.created_at),
    stmt(db, 'DELETE FROM vault_write_guards WHERE id=?', guard),
  ];
}

export async function vaultBatch(db: Database, first: D1PreparedStatement, after: D1PreparedStatement[], witnesses: AuthorizationWitness[] = []): Promise<void> {
  witnesses = expandWitnesses(witnesses);
  const guard = newId('vault_guard');
  const witnessIds = witnesses.map(() => newId('vault_guard'));
  try {
    await db.batch([first, stmt(db, 'INSERT INTO vault_write_guards (id,valid) VALUES (?,changes())', guard),
      ...witnesses.map((witness, i) => witnessStatement(db, witnessIds[i]!, witness)), ...after,
      stmt(db, `DELETE FROM vault_write_guards WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify([guard, ...witnessIds]))]);
  } catch (error) {
    if (/CHECK constraint failed.*valid/i.test(String(error))) throw new ApiError(412, 'vault_state_changed', 'The vault or authorization state changed; refresh and retry.');
    if (/UNIQUE constraint failed/i.test(String(error))) throw new ApiError(409, 'vault_conflict', 'An immutable vault resource or operation already exists.');
    throw error;
  }
}

function expandWitnesses(witnesses: AuthorizationWitness[]): AuthorizationWitness[] {
  const expanded: AuthorizationWitness[] = [];
  const visit = (witness: AuthorizationWitness): void => { expanded.push(witness); for (const dependency of witness.dependencies ?? []) visit(dependency); };
  witnesses.forEach(visit);
  if (expanded.length > 128) throw new ApiError(422, 'vault_authorization_scope_limit', 'The vault operation exceeds its bounded authority dependencies.');
  return expanded;
}

/** SELECT-only consistency check for a metadata preview; no guard rows or authority initialization. */
export async function vaultReadGuard(db: Database, witnesses: AuthorizationWitness[], probes: D1PreparedStatement[]): Promise<void> {
  const statements = expandWitnesses(witnesses).map(witness => stmt(db, `SELECT CASE WHEN ?=(${witness.sql}) THEN 1 ELSE 0 END AS valid`, witness.value, ...witness.bindings));
  const results = await db.batch<{ valid: number }>([...statements, ...probes]);
  if (results.some(result => result.results[0]?.valid !== 1)) throw new ApiError(412, 'vault_state_changed', 'The vault or authorization state changed during preview; refresh and retry.');
}
