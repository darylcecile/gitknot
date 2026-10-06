import { ApiError, bytes, canonicalJson, fromBase64url, one } from '@gitknot/core';
import type { Database } from '@gitknot/core';
import { loadKeyring, secretBinding } from './crypto.ts';
import type { KeyMaterial, SecretsBrokerBindings } from './types.ts';

/** Federation authenticates its own purpose before it asks this lazy binding for any KEK material. */
export function federationVaultBindings(env: SecretsBrokerBindings, request: Request): SecretsBrokerBindings {
  const path = new URL(request.url).pathname;
  const writing = path === '/internal/federation/secrets' || path === '/internal/federation/rewrap';
  return { ...env, SECRETS_KEK_KEYRING_JSON: { async get() {
    const ring = await loadKeyring(env);
    const control = await one<{ active_key_id: string; fingerprint: string; state: string; write_fenced: number }>(env.DB,
      'SELECT c.active_key_id,c.write_fenced,k.fingerprint,k.state FROM vault_key_control c JOIN vault_key_registry k ON k.id=c.active_key_id WHERE c.id=1');
    const current = control ? ring.keys.get(control.active_key_id) : undefined;
    if (!control || !current || current.fingerprint !== control.fingerprint || control.active_key_id !== ring.current_id
      || control.state !== 'active' || (writing && control.write_fenced)) {
      throw new ApiError(503, 'vault_key_unavailable', 'The shared private-vault key registry is not current.');
    }
    return secretBinding(env.SECRETS_KEK_KEYRING_JSON);
  } } };
}

export interface FederationCipher {
  id: string; account_id: string; provider_id: string; kind: string; version: number; context_json: string;
  ciphertext: string; iv: string; wrapped_key: string; wrap_iv: string; kek_id: string; created_at: string;
}

export async function verifyFederationCipher(db: Database, row: FederationCipher, key: KeyMaterial): Promise<string> {
  const wrap = await one<{ kek_id: string; wrapped_key: string; wrap_iv: string; version: number }>(db,
    'SELECT kek_id,wrapped_key,wrap_iv,version FROM federation_secret_wraps WHERE secret_id=? AND account_id=? AND provider_id=? ORDER BY version DESC LIMIT 1',
    row.id, row.account_id, row.provider_id) ?? { kek_id: row.kek_id, wrapped_key: row.wrapped_key, wrap_iv: row.wrap_iv, version: 1 };
  if (wrap.kek_id !== key.id) throw new ApiError(409, 'federation_rewrap_required', 'Rewrap every retained federation secret with the replacement key before retiring its predecessor.');
  const context = JSON.parse(row.context_json) as Record<string, unknown>;
  if (context.purpose !== 'GitKnot federation secret' || context.account_id !== row.account_id || context.provider_id !== row.provider_id
    || context.secret_id !== row.id || context.secret_version !== row.version || context.kind !== row.kind) {
    throw new ApiError(503, 'federation_ciphertext_integrity', 'Federation ciphertext identity requires recovery.');
  }
  let raw: Uint8Array<ArrayBuffer> | undefined;
  let plaintext: Uint8Array<ArrayBuffer> | undefined;
  try {
    raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64url(wrap.wrap_iv),
      additionalData: bytes(`wrap\n${row.context_json}`), tagLength: 128 }, key.key, fromBase64url(wrap.wrapped_key)));
    if (raw.length !== 32) throw new Error('Invalid data key');
    const dek = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64url(row.iv),
      additionalData: bytes(`payload\n${row.context_json}`), tagLength: 128 }, dek, fromBase64url(row.ciphertext)));
    return canonicalJson([row, wrap]);
  } catch { throw new ApiError(503, 'federation_ciphertext_integrity', 'Federation ciphertext failed recovery integrity verification.'); }
  finally { raw?.fill(0); plaintext?.fill(0); }
}
