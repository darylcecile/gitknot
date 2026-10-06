import { requireValue } from '../../../packages/git/src/errors.ts';

const versions = new Set(['https://git-lfs.github.com/spec/v1', 'https://hawser.github.com/spec/v1', 'http://git-media.io/v/2']);
const extensionKey = /^ext-[0-9]-[A-Za-z0-9_][A-Za-z0-9_.-]*$/u;
// Go bytes.TrimSpace, as used by the reference Git LFS decoder, including NEL.
const surroundingSpace = /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu;

/** Bounded reference-compatible decoding; unsupported pointer-like encodings fail closed. */
export function lfsPointer(raw: Uint8Array): { oid: string; size: number } | null {
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(raw.subarray(0, 1024)).replace(surroundingSpace, '');
  const lines = text.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line).filter(Boolean);
  const version = lines.findIndex(line => line.startsWith('version ') && versions.has(line.slice(8)));
  if (version < 0 || lines.slice(0, version).some(line => !extensionKey.test(line.split(' ')[0]))) return null;
  requireValue(raw.length < 1024, 'invalid_lfs_pointer', 'A Git LFS pointer must be smaller than 1024 bytes.');
  const keys = ['version', 'oid', 'size'] as const;
  const fields = new Map<string, string>();
  const priorities = new Set<string>();
  let index = 0;
  for (const line of lines) {
    const separator = line.indexOf(' ');
    requireValue(separator > 0 && index < keys.length, 'invalid_lfs_pointer', 'An introduced Git LFS pointer is invalid.');
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === keys[index]) { fields.set(key, value); index++; continue; }
    requireValue(extensionKey.test(key) && /^sha256:[a-f0-9]{64}$/u.test(value) && !priorities.has(key.split('-')[1]),
      'invalid_lfs_pointer', 'An introduced Git LFS pointer has an invalid or unsupported extension.');
    priorities.add(key.split('-')[1]);
  }
  const oid = /^sha256:([a-f0-9]{64})$/u.exec(fields.get('oid') ?? '')?.[1];
  const sizeText = fields.get('size') ?? '';
  const size = Number(sizeText);
  requireValue(index === keys.length && versions.has(fields.get('version') ?? '') && oid && /^[+-]?[0-9]+$/u.test(sizeText)
    && Number.isSafeInteger(size) && size >= 0, 'invalid_lfs_pointer', 'An introduced Git LFS pointer has an invalid checksum or size.');
  return { oid, size };
}
