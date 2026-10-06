const encoder = new TextEncoder();

export function now(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix.replace(/_+$/, '')}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function bytes(value: string | Uint8Array): Uint8Array<ArrayBuffer> {
  return typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value);
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(value))));
}

export function hex(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function fromHex(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[a-fA-F0-9]{2})*$/.test(value)) throw new TypeError('Invalid hexadecimal encoding.');
  return Uint8Array.from(value.match(/.{2}/g) ?? [], byte => Number.parseInt(byte, 16));
}

export function base64url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[a-zA-Z0-9_-]*$/.test(value)) throw new TypeError('Invalid base64url encoding.');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(padded + '='.repeat((4 - padded.length % 4) % 4)), c => c.charCodeAt(0));
}

export function randomToken(size = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(size)));
}

export async function hmac(key: string | Uint8Array, message: string): Promise<string> {
  const imported = await crypto.subtle.importKey('raw', bytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', imported, bytes(message))));
}

export async function verifyHmac(key: string | Uint8Array, message: string, signature: string): Promise<boolean> {
  let signatureBytes: Uint8Array<ArrayBuffer>;
  try { signatureBytes = fromBase64url(signature); } catch { return false; }
  const imported = await crypto.subtle.importKey('raw', bytes(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', imported, signatureBytes, bytes(message));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Undefined values are not canonical JSON.');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
