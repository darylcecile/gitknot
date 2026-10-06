import { ApiError, auditStatement, canonicalJson, many, newId, now, one, sha256, stmt } from '@gitknot/core';
import type { AppContext, Database } from '@gitknot/core';
import { ciphertextIdentity, loadKeyring, openValue, rewrapValue } from './crypto.ts';
import { vaultBatch } from './database.ts';
import type { BrokerClient, CipherIdentity, Ciphertext, KeyMaterial, Keyring, KeyWrap, SecretsBrokerBindings } from './types.ts';
import { verifyFederationCipher } from './federation.ts';
import type { FederationCipher } from './federation.ts';

export async function activeEncryptionKey(env: SecretsBrokerBindings): Promise<KeyMaterial> {
  const ring = await loadKeyring(env);
  const control = await one<{ active_key_id: string; fingerprint: string; state: string; write_fenced: number }>(env.DB,
    'SELECT c.active_key_id,c.write_fenced,k.fingerprint,k.state FROM vault_key_control c JOIN vault_key_registry k ON k.id=c.active_key_id WHERE c.id=1');
  const key = control ? ring.keys.get(control.active_key_id) : null;
  if (!control || !key || control.active_key_id !== ring.current_id || key.fingerprint !== control.fingerprint || control.state !== 'active' || control.write_fenced) {
    throw new ApiError(503, 'vault_write_fenced', 'Vault encryption is unavailable until its key registry and recovery state are current.');
  }
  return key;
}

/** Explicit operator bootstrap. A missing registry on a nonempty vault is recovery, never first installation. */
export async function initializeKeyring(c: AppContext, env: SecretsBrokerBindings, client: BrokerClient): Promise<{ active_key_id: string; initialized: boolean }> {
  const control = await one<{ active_key_id: string }>(env.DB, 'SELECT active_key_id FROM vault_key_control WHERE id=1');
  if (control) { await activeEncryptionKey(env); return { active_key_id: control.active_key_id, initialized: false }; }
  const retained = await one(env.DB, `SELECT 1 FROM vault_key_registry UNION ALL SELECT 1 FROM vault_ciphertexts
    UNION ALL SELECT 1 FROM federation_client_secrets LIMIT 1`);
  if (retained) throw new ApiError(409, 'vault_registry_recovery_required', 'Restore and verify the existing key registry before reopening encrypted writes.');
  const result = await registerKeyring(c, env, client, 0);
  return { active_key_id: result.active_key_id, initialized: true };
}

export async function usableWrap(db: Database, ciphertextId: string, ring: Keyring): Promise<{ wrap: KeyWrap; key: KeyMaterial }> {
  const wraps = await many<KeyWrap & { fingerprint: string }>(db, `SELECT w.*,r.fingerprint FROM vault_key_wraps w JOIN vault_key_registry r ON r.id=w.key_id
    WHERE w.ciphertext_id=? AND r.state IN ('active','decrypt_only') ORDER BY CASE WHEN w.key_id=? THEN 0 ELSE 1 END,w.created_at DESC,w.key_id`, ciphertextId, ring.current_id);
  for (const wrap of wraps) {
    const key = ring.keys.get(wrap.key_id);
    if (key && key.fingerprint === wrap.fingerprint) return { wrap, key };
  }
  throw new ApiError(503, 'vault_key_unavailable', 'No current recovery key can unwrap this version.');
}

export async function decryptCiphertext(db: Database, ring: Keyring, ciphertext: Ciphertext, expectedIdentity: CipherIdentity): Promise<Uint8Array<ArrayBuffer>> {
  const { wrap, key } = await usableWrap(db, ciphertext.id, ring);
  return openValue(ciphertext, wrap, key, expectedIdentity);
}

/** Called only by a separately scoped maintenance identity. It never accepts key bytes in an HTTP body. */
export async function registerKeyring(c: AppContext, env: SecretsBrokerBindings, client: BrokerClient, expectedRevision: number): Promise<{ active_key_id: string; revision: number }> {
  const ring = await loadKeyring(env);
  const control = await one<{ active_key_id: string; revision: number }>(env.DB, 'SELECT * FROM vault_key_control WHERE id=1');
  if ((control?.revision ?? 0) !== expectedRevision) throw new ApiError(412, 'key_registry_changed', 'The key registry changed.');
  const after: D1PreparedStatement[] = [];
  for (const material of ring.keys.values()) {
    const existing = await one<{ fingerprint: string; state: string }>(env.DB, 'SELECT fingerprint,state FROM vault_key_registry WHERE id=?', material.id);
    if (existing && (existing.fingerprint !== material.fingerprint || (existing.state === 'retired' && material.id === ring.current_id))) {
      throw new ApiError(409, 'key_identity_conflict', 'Key IDs are immutable and retired keys cannot be reactivated.');
    }
    if (!existing) after.push(stmt(env.DB, 'INSERT INTO vault_key_registry (id,fingerprint,state,created_at) VALUES (?,?,?,?)', material.id, material.fingerprint, 'decrypt_only', now()));
  }
  // Register key identities before the control row; activation and its audit share one batch.
  const guard = newId('vault_guard');
  const statements = [...(!control ? [stmt(env.DB, `INSERT INTO vault_write_guards(id,valid) SELECT ?,CASE WHEN
    NOT EXISTS(SELECT 1 FROM vault_ciphertexts) AND NOT EXISTS(SELECT 1 FROM federation_client_secrets) THEN 1 ELSE 0 END`, `${guard}:fresh`)] : []), ...after,
    control ? stmt(env.DB, 'UPDATE vault_key_control SET active_key_id=?,revision=revision+1 WHERE id=1 AND revision=? AND write_fenced=0', ring.current_id, expectedRevision)
      : stmt(env.DB, 'INSERT INTO vault_key_control (id,active_key_id,revision) VALUES (1,?,1)', ring.current_id),
    stmt(env.DB, 'INSERT INTO vault_write_guards (id,valid) VALUES (?,changes())', guard),
    stmt(env.DB, "UPDATE vault_key_registry SET state='decrypt_only' WHERE state='active' AND id!=?", ring.current_id),
    stmt(env.DB, "UPDATE vault_key_registry SET state='active',activated_at=COALESCE(activated_at,?) WHERE id=? AND state!='retired'", now(), ring.current_id),
    auditStatement(env.DB, { action: 'vault.key.activated', resource_id: ring.current_id, request_id: c.get('requestId'), actor_id: `service:${client.id}`,
      details: { previous_key_id: control?.active_key_id ?? null, key_ids: [...ring.keys.keys()] } }),
    stmt(env.DB, 'DELETE FROM vault_write_guards WHERE id IN (?,?)', guard, `${guard}:fresh`)];
  await env.DB.batch(statements);
  return { active_key_id: ring.current_id, revision: expectedRevision + 1 };
}

interface Rotation { id: string; target_key_id: string; cursor: string; state: string; rewrapped_count: number }

export async function rotateKeyBatch(c: AppContext, env: SecretsBrokerBindings, client: BrokerClient, input: { rotation_id: string; target_key_id: string; limit: number }): Promise<Rotation> {
  const target = await activeEncryptionKey(env);
  if (target.id !== input.target_key_id) throw new ApiError(409, 'rotation_target_inactive', 'Rotate to the currently active encryption key.');
  const ring = await loadKeyring(env);
  let rotation = await one<Rotation>(env.DB, 'SELECT * FROM vault_key_rotations WHERE id=?', input.rotation_id);
  if (rotation?.target_key_id !== undefined && rotation.target_key_id !== target.id) throw new ApiError(409, 'rotation_conflict', 'The rotation ID has a different target key.');
  if (rotation?.state === 'complete') return rotation;
  if (!rotation) {
    await env.DB.prepare("INSERT OR IGNORE INTO vault_key_rotations (id,target_key_id,state,created_at,updated_at) VALUES (?,?,'running',?,?)")
      .bind(input.rotation_id, target.id, now(), now()).run();
    rotation = (await one<Rotation>(env.DB, 'SELECT * FROM vault_key_rotations WHERE id=?', input.rotation_id))!;
  }
  const ciphertexts = await many<Ciphertext>(env.DB, `SELECT c.* FROM vault_ciphertexts c WHERE c.id>? AND NOT EXISTS
    (SELECT 1 FROM vault_key_wraps w WHERE w.ciphertext_id=c.id AND w.key_id=?) ORDER BY c.id LIMIT ?`, rotation.cursor, target.id, input.limit);
  for (const ciphertext of ciphertexts) {
    const existing = await usableWrap(env.DB, ciphertext.id, ring);
    const wrapped = await rewrapValue(ciphertext, existing.wrap, existing.key, target);
    await env.DB.batch([
      stmt(env.DB, 'INSERT OR IGNORE INTO vault_key_wraps (ciphertext_id,key_id,iv,wrapped_dek,created_at) VALUES (?,?,?,?,?)', wrapped.ciphertext_id, wrapped.key_id, wrapped.iv, wrapped.wrapped_dek, wrapped.created_at),
      auditStatement(env.DB, { action: 'vault.key.rewrapped', resource_id: ciphertext.id, account_id: ciphertext.account_id, actor_id: `service:${client.id}`,
        request_id: c.get('requestId'), details: { rotation_id: rotation.id, source_key_id: existing.key.id, target_key_id: target.id } }),
    ]);
  }
  const cursor = ciphertexts.at(-1)?.id ?? rotation.cursor;
  const missing = await one(env.DB, `SELECT c.id FROM vault_ciphertexts c WHERE NOT EXISTS
    (SELECT 1 FROM vault_key_wraps w WHERE w.ciphertext_id=c.id AND w.key_id=?) LIMIT 1`, target.id);
  // A concurrently started old-key write is fenced by key-control. New writes already have a target wrap.
  await env.DB.prepare('UPDATE vault_key_rotations SET cursor=?,state=?,rewrapped_count=rewrapped_count+?,updated_at=?,completed_at=? WHERE id=? AND cursor=?')
    .bind(missing ? (ciphertexts.length ? cursor : '') : cursor, missing ? 'running' : 'complete', ciphertexts.length, now(), missing ? null : now(), rotation.id, rotation.cursor).run();
  return (await one<Rotation>(env.DB, 'SELECT * FROM vault_key_rotations WHERE id=?', rotation.id))!;
}

interface Recovery { id: string; key_id: string; cursor: string; catalog_revision: number; verified_count: number; chain_hash: string; state: string; phase: 'vault' | 'federation'; created_at: string; completed_at: string | null }

export async function verifyRecoveryBatch(c: AppContext, env: SecretsBrokerBindings, client: BrokerClient, input: { verification_id: string; key_id: string; limit: number }): Promise<Recovery> {
  const ring = await loadKeyring(env);
  const key = ring.keys.get(input.key_id);
  if (!key) throw new ApiError(503, 'recovery_key_missing', 'The recovery verification key is not bound to this broker.');
  let recovery = await one<Recovery>(env.DB, 'SELECT * FROM vault_recovery_verifications WHERE id=?', input.verification_id);
  if (recovery && recovery.key_id !== input.key_id) throw new ApiError(409, 'recovery_conflict', 'The verification ID has a different key.');
  if (recovery?.state === 'complete') return recovery;
  if (!recovery) {
    const control = await one<{ revision: number; catalog_revision: number }>(env.DB, 'SELECT * FROM vault_key_control WHERE id=1');
    if (!control) throw new ApiError(503, 'key_registry_unavailable', 'Initialize the key registry before recovery verification.');
    await vaultBatch(env.DB, stmt(env.DB, 'UPDATE vault_key_control SET write_fenced=1,revision=revision+1 WHERE id=1 AND revision=?', control.revision), [
      stmt(env.DB, "INSERT INTO vault_recovery_verifications (id,key_id,catalog_revision,state,created_at) VALUES (?,?,?,'running',?)", input.verification_id, key.id, control.catalog_revision, now()),
      auditStatement(env.DB, { action: 'vault.recovery.started', resource_id: input.verification_id, actor_id: `service:${client.id}`, request_id: c.get('requestId'), details: { key_id: key.id } }),
    ]);
    recovery = (await one<Recovery>(env.DB, 'SELECT * FROM vault_recovery_verifications WHERE id=?', input.verification_id))!;
  }
  const rows = recovery.phase === 'vault'
    ? await many<Ciphertext>(env.DB, 'SELECT * FROM vault_ciphertexts WHERE id>? ORDER BY id LIMIT ?', recovery.cursor, input.limit)
    : await many<FederationCipher>(env.DB, 'SELECT * FROM federation_client_secrets WHERE id>? ORDER BY id LIMIT ?', recovery.cursor, input.limit);
  let chain = recovery.chain_hash;
  for (const ciphertext of rows) {
    if (recovery.phase === 'federation') {
      chain = await sha256(canonicalJson([chain, await verifyFederationCipher(env.DB, ciphertext as FederationCipher, key)]));
      continue;
    }
    const payload = ciphertext as Ciphertext;
    const wrap = await one<KeyWrap>(env.DB, 'SELECT * FROM vault_key_wraps WHERE ciphertext_id=? AND key_id=?', ciphertext.id, key.id);
    if (!wrap) throw new ApiError(409, 'recovery_wrap_missing', 'Finish rewrapping every retained ciphertext before verifying recovery.');
    const verified = await openValue(payload, wrap, key, ciphertextIdentity(payload));
    verified.fill(0);
    chain = await sha256(canonicalJson([chain, ciphertext, wrap]));
  }
  const phaseFinished = rows.length < input.limit;
  const complete = phaseFinished && recovery.phase === 'federation';
  const nextPhase = phaseFinished && recovery.phase === 'vault' ? 'federation' : recovery.phase;
  const cursor = nextPhase !== recovery.phase ? '' : rows.at(-1)?.id ?? recovery.cursor;
  const after: D1PreparedStatement[] = [];
  if (complete) after.push(
    stmt(env.DB, 'UPDATE vault_key_registry SET recovery_verified_at=? WHERE id=?', now(), key.id),
    stmt(env.DB, 'UPDATE vault_key_control SET write_fenced=0,revision=revision+1 WHERE id=1'),
    auditStatement(env.DB, { action: 'vault.recovery.verified', resource_id: input.verification_id, actor_id: `service:${client.id}`, request_id: c.get('requestId'),
      details: { key_id: key.id, chain_hash: chain, verified_count: recovery.verified_count + rows.length } }),
  );
  await vaultBatch(env.DB, stmt(env.DB, `UPDATE vault_recovery_verifications SET cursor=?,chain_hash=?,verified_count=verified_count+?,state=?,completed_at=?,phase=?
    WHERE id=? AND cursor=? AND state='running' AND catalog_revision=(SELECT catalog_revision FROM vault_key_control WHERE id=1)`,
  cursor, chain, rows.length, complete ? 'complete' : 'running', complete ? now() : null, nextPhase, recovery.id, recovery.cursor), after);
  return (await one<Recovery>(env.DB, 'SELECT * FROM vault_recovery_verifications WHERE id=?', recovery.id))!;
}

export async function retireKey(c: AppContext, env: SecretsBrokerBindings, client: BrokerClient, keyId: string): Promise<{ retired: true }> {
  const control = await one<{ active_key_id: string; revision: number }>(env.DB, 'SELECT * FROM vault_key_control WHERE id=1');
  const old = await one<{ state: string; last_wrapped_at: string | null; activated_at: string | null }>(env.DB, 'SELECT * FROM vault_key_registry WHERE id=?', keyId);
  if (!control || !old || keyId === control.active_key_id) throw new ApiError(409, 'key_retirement_denied', 'The active key cannot be retired.');
  if (old.state === 'retired') return { retired: true };
  if (!['test', 'development'].includes(env.ENVIRONMENT) && env.SECRETS_BACKUP_RETENTION_SECONDS === undefined) {
    throw new ApiError(503, 'key_retention_unconfigured', 'Configure the actual maximum backup retention before retiring a production KEK.');
  }
  const retainedSeconds = Number(env.SECRETS_BACKUP_RETENTION_SECONDS ?? 32 * 86_400);
  if (!Number.isSafeInteger(retainedSeconds) || retainedSeconds < 30 * 86_400) throw new ApiError(503, 'recovery_retention_invalid', 'Key retention must cover D1 recovery and independent backups.');
  await activeEncryptionKey(env);
  const verified = await one<{ id: string; completed_at: string }>(env.DB, "SELECT id,completed_at FROM vault_recovery_verifications WHERE key_id=? AND state='complete' AND phase='federation' ORDER BY completed_at DESC LIMIT 1", control.active_key_id);
  if (!verified || verified.completed_at < (old.last_wrapped_at ?? '')) throw new ApiError(409, 'recovery_verification_required', 'Verify recovery with the replacement key before retirement.');
  // A fresh backup can still contain an old wrap decades after that wrap was created.
  // Only a completed full-catalog replacement verification starts the backup grace clock.
  if (Date.parse(verified.completed_at) + retainedSeconds * 1000 > Date.now()) {
    throw new ApiError(409, 'key_backup_retention', 'Keep this KEK for the full backup retention window after replacement-key recovery verification completed.');
  }
  const federation = await one(env.DB, `SELECT s.id FROM federation_client_secrets s WHERE COALESCE(
    (SELECT w.kek_id FROM federation_secret_wraps w WHERE w.secret_id=s.id ORDER BY w.version DESC LIMIT 1),s.kek_id)=? LIMIT 1`, keyId);
  if (federation) throw new ApiError(409, 'federation_rewrap_required', 'Retained federation versions still depend on this KEK.');
  await vaultBatch(env.DB, stmt(env.DB, `UPDATE vault_key_registry SET state='retired',retired_at=? WHERE id=? AND state='decrypt_only'
    AND COALESCE(last_wrapped_at,'')<=?
    AND EXISTS (SELECT 1 FROM vault_key_control WHERE id=1 AND active_key_id=? AND revision=? AND write_fenced=0)
    AND EXISTS (SELECT 1 FROM vault_recovery_verifications WHERE id=? AND key_id=? AND state='complete' AND phase='federation' AND completed_at=?)
    AND NOT EXISTS (SELECT 1 FROM vault_ciphertexts c WHERE NOT EXISTS
      (SELECT 1 FROM vault_key_wraps w WHERE w.ciphertext_id=c.id AND w.key_id=?))
    AND NOT EXISTS (SELECT 1 FROM federation_client_secrets s WHERE COALESCE(
      (SELECT w.kek_id FROM federation_secret_wraps w WHERE w.secret_id=s.id ORDER BY w.version DESC LIMIT 1),s.kek_id)<>?)`,
  now(), keyId, verified.completed_at, control.active_key_id, control.revision, verified.id, control.active_key_id, verified.completed_at,
  control.active_key_id, control.active_key_id), [
    auditStatement(env.DB, { action: 'vault.key.retired', resource_id: keyId, actor_id: `service:${client.id}`, request_id: c.get('requestId'),
      details: { replacement_key_id: control.active_key_id, recovery_verification_id: verified.id, recovery_completed_at: verified.completed_at, backup_retention_seconds: retainedSeconds } }),
  ]);
  return { retired: true };
}

export async function abortRecovery(c: AppContext, env: SecretsBrokerBindings, client: BrokerClient, verificationId: string): Promise<{ aborted: true }> {
  await vaultBatch(env.DB, stmt(env.DB, "UPDATE vault_recovery_verifications SET state='failed' WHERE id=? AND state='running'", verificationId), [
    stmt(env.DB, 'UPDATE vault_key_control SET write_fenced=0,revision=revision+1 WHERE id=1'),
    auditStatement(env.DB, { action: 'vault.recovery.aborted', resource_id: verificationId, actor_id: `service:${client.id}`, request_id: c.get('requestId'),
      details: { key_retirement_remains_blocked: true } }),
  ]);
  return { aborted: true };
}
