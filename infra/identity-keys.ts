export interface IdentityKeyRing { current: string; keys: Record<string, string> }

const versionId = /^[A-Za-z0-9_-]{1,32}$/;
const encodedKey = /^[A-Za-z0-9_-]{43,128}$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidRing(): Error {
  return new Error('IDENTITY_KEYS_JSON must contain a current version and 43–128-character base64url keys of at least 32 bytes; version IDs must be 1–32 ASCII letters, digits, underscores or hyphens.');
}

/** Dependency-free validation shared by bootstrap and explicit secret uploads. */
export function parseIdentityKeyRing(value: unknown): IdentityKeyRing {
  let parsed: unknown;
  try {
    if (typeof value !== 'string') throw invalidRing();
    parsed = JSON.parse(value);
  } catch { throw invalidRing(); }
  if (!record(parsed) || Object.keys(parsed).length !== 2 || typeof parsed.current !== 'string'
    || !versionId.test(parsed.current) || !record(parsed.keys) || !Object.hasOwn(parsed.keys, parsed.current)) throw invalidRing();
  const keys: [string, string][] = [];
  for (const [id, key] of Object.entries(parsed.keys)) {
    if (!versionId.test(id) || typeof key !== 'string' || !encodedKey.test(key) || key.length % 4 === 1
      || Buffer.from(key, 'base64url').byteLength < 32) throw invalidRing();
    keys.push([id, key]);
  }
  return { current: parsed.current, keys: Object.fromEntries(keys) };
}

/** The legacy derivation used the binding's UTF-8 bytes, not decoded base64. */
export function sessionIdentityKeyRing(session: unknown): string {
  if (typeof session !== 'string' || Buffer.byteLength(session, 'utf8') < 32) {
    throw new Error('Restore the existing API SESSION_KEY or IDENTITY_KEYS_JSON before setup; generating replacement identity material would invalidate existing references.');
  }
  const ring = JSON.stringify({ current: 'session-v1', keys: { 'session-v1': Buffer.from(session, 'utf8').toString('base64url') } });
  parseIdentityKeyRing(ring);
  return ring;
}
