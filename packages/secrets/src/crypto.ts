import { ApiError, base64url, bytes, canonicalJson, fromBase64url, now, sha256 } from '@gitknot/core';
import type { CipherIdentity, Ciphertext, Envelope, KeyMaterial, Keyring, KeyWrap, SecretsBrokerBindings } from './types.ts';

function unavailable(): never { throw new ApiError(503, 'vault_key_unavailable', 'The vault key configuration could not be verified.'); }

export async function secretBinding(value: string | { get(): Promise<string> } | undefined): Promise<string> {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object' && typeof value.get === 'function') {
    const result = await value.get();
    if (typeof result === 'string' && result.length > 0) return result;
  }
  return unavailable();
}

export function randomKeyBytes(): Uint8Array<ArrayBuffer> { return crypto.getRandomValues(new Uint8Array(32)); }

function rawKey(encoded: unknown): Uint8Array<ArrayBuffer> {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) return unavailable();
  let raw: Uint8Array<ArrayBuffer>;
  try { raw = fromBase64url(encoded); } catch { return unavailable(); }
  if (raw.length !== 32 || base64url(raw) !== encoded || new Set(raw).size < 16) return unavailable();
  return raw;
}

export async function loadKeyring(env: Pick<SecretsBrokerBindings, 'SECRETS_KEK_CURRENT_ID' | 'SECRETS_KEK_KEYRING_JSON'>): Promise<Keyring> {
  let data: unknown;
  try { data = JSON.parse(await secretBinding(env.SECRETS_KEK_KEYRING_JSON)); } catch { return unavailable(); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return unavailable();
  const entries = Object.entries(data);
  if (!entries.length || entries.length > 16 || !/^[A-Za-z0-9_-]{1,64}$/.test(env.SECRETS_KEK_CURRENT_ID)) return unavailable();
  const keys = new Map<string, KeyMaterial>();
  const fingerprints = new Set<string>();
  for (const [id, encoded] of entries) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return unavailable();
    const raw = rawKey(encoded);
    try {
      const fingerprint = await sha256(raw);
      if (fingerprints.has(fingerprint)) return unavailable();
      fingerprints.add(fingerprint);
      keys.set(id, { id, fingerprint, key: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']) });
    } finally { raw.fill(0); }
  }
  if (!keys.has(env.SECRETS_KEK_CURRENT_ID)) return unavailable();
  return { current_id: env.SECRETS_KEK_CURRENT_ID, keys };
}

function aad(identity: CipherIdentity, purpose: 'payload' | 'wrap', keyId?: string): Uint8Array<ArrayBuffer> {
  return bytes(canonicalJson({ application: 'gitknot-vault', algorithm: 'AES-256-GCM', purpose, identity, ...(keyId ? { key_id: keyId } : {}) }));
}

function decode(value: string, length?: number): Uint8Array<ArrayBuffer> {
  try {
    const decoded = fromBase64url(value);
    if (base64url(decoded) !== value || (length !== undefined && decoded.length !== length)) return unavailable();
    return decoded;
  } catch { return unavailable(); }
}

export function ciphertextIdentity(ciphertext: Ciphertext): CipherIdentity {
  let value: CipherIdentity;
  try { value = JSON.parse(ciphertext.context_json) as CipherIdentity; } catch { return unavailable(); }
  if (value.format !== 1 || value.version_id !== ciphertext.id || value.account_id !== ciphertext.account_id || value.purpose !== ciphertext.purpose
    || typeof value.entry_id !== 'string' || typeof value.name !== 'string' || !Number.isSafeInteger(value.version) || value.version < 1) return unavailable();
  return value;
}

async function wrapDek(raw: Uint8Array<ArrayBuffer>, identity: CipherIdentity, kek: KeyMaterial): Promise<KeyWrap> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(identity, 'wrap', kek.id), tagLength: 128 }, kek.key, raw);
  return { ciphertext_id: identity.version_id, key_id: kek.id, iv: base64url(iv), wrapped_dek: base64url(new Uint8Array(wrapped)), created_at: now() };
}

async function unwrapDek(ciphertext: Ciphertext, wrap: KeyWrap, kek: KeyMaterial, identity: CipherIdentity): Promise<Uint8Array<ArrayBuffer>> {
  if (wrap.ciphertext_id !== ciphertext.id || wrap.key_id !== kek.id || canonicalJson(identity) !== ciphertext.context_json) return unavailable();
  try {
    const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(wrap.iv, 12), additionalData: aad(identity, 'wrap', kek.id), tagLength: 128 },
      kek.key, decode(wrap.wrapped_dek, 48)));
    if (raw.length !== 32) return unavailable();
    return raw;
  } catch { throw new ApiError(503, 'vault_integrity_failed', 'The encrypted secret failed its authenticated integrity check.'); }
}

export async function sealValue(value: string | Uint8Array<ArrayBuffer>, identity: CipherIdentity, kek: KeyMaterial): Promise<Envelope> {
  const plaintext = typeof value === 'string' ? bytes(value) : new Uint8Array(value);
  if (plaintext.length > 16_384) throw new ApiError(422, 'secret_too_large', 'Values are limited to 16 KiB of UTF-8 data.');
  const raw = randomKeyBytes();
  try {
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(identity, 'payload'), tagLength: 128 }, key, plaintext);
    return {
      ciphertext: { id: identity.version_id, account_id: identity.account_id, purpose: identity.purpose, context_json: canonicalJson(identity), iv: base64url(iv),
        ciphertext: base64url(new Uint8Array(encrypted)), created_at: now() },
      wrap: await wrapDek(raw, identity, kek),
    };
  } finally { raw.fill(0); plaintext.fill(0); }
}

/** Broker-only primitive. The expected identity is constructed from authorized rows, never caller ciphertext. */
export async function openValue(ciphertext: Ciphertext, wrap: KeyWrap, kek: KeyMaterial, identity: CipherIdentity): Promise<Uint8Array<ArrayBuffer>> {
  const raw = await unwrapDek(ciphertext, wrap, kek, identity);
  try {
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(ciphertext.iv, 12), additionalData: aad(identity, 'payload'), tagLength: 128 }, key, decode(ciphertext.ciphertext)));
  } catch { throw new ApiError(503, 'vault_integrity_failed', 'The encrypted secret failed its authenticated integrity check.'); }
  finally { raw.fill(0); }
}

export async function rewrapValue(ciphertext: Ciphertext, existing: KeyWrap, source: KeyMaterial, target: KeyMaterial): Promise<KeyWrap> {
  const identity = ciphertextIdentity(ciphertext);
  const raw = await unwrapDek(ciphertext, existing, source, identity);
  try {
    const wrap = await wrapDek(raw, identity, target);
    const verification = await openValue(ciphertext, wrap, target, identity);
    verification.fill(0);
    return wrap;
  } finally { raw.fill(0); }
}
