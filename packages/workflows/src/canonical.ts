import { invalid } from './errors.ts';

/** A JSON-only, key-sorted representation shared by manifests, caches and receipts. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown, depth: number): string {
    if (depth > 100) invalid('json_depth', '', 'JSON nesting exceeds the supported limit.');
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || item === undefined) {
      return invalid('json_type', '', 'Expected finite JSON values.');
    }
    if (ancestors.has(item)) return invalid('json_cycle', '', 'Cyclic values are not supported.');
    ancestors.add(item);
    let result: string;
    if (Array.isArray(item)) {
      result = `[${item.map((entry) => encode(entry, depth + 1)).join(',')}]`;
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== null && prototype !== Object.prototype) {
        return invalid('json_type', '', 'Only plain JSON objects are supported.');
      }
      const record = item as Record<string, unknown>;
      result = `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${encode(record[key], depth + 1)}`).join(',')}}`;
    }
    ancestors.delete(item);
    return result;
  }
  return encode(value, 0);
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function digestJson(value: unknown): Promise<string> {
  return sha256(canonicalJson(value));
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
