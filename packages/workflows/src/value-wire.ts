import { canonicalJson } from './canonical.ts';
import { invalid } from './errors.ts';
import type { DataType } from './schema.ts';

/** All producers and consumers limit the canonical JSON wire bytes, not source-file characters. */
export const MAX_TYPED_OUTPUT_WIRE_BYTES = 65_536;

function checkType(value: unknown, type: Exclude<DataType, 'artifact'>): void {
  if (type !== 'json' && (typeof value !== type || type === 'number' && !Number.isFinite(value))) invalid('output_type', 'output', `Expected a ${type} output value.`);
}

export function encodeTypedValue(value: unknown, type: Exclude<DataType, 'artifact'>): Uint8Array {
  checkType(value, type);
  const bytes = new TextEncoder().encode(canonicalJson(value));
  if (bytes.byteLength > MAX_TYPED_OUTPUT_WIRE_BYTES) invalid('typed_value_limit', 'output', `Canonical typed output exceeds ${MAX_TYPED_OUTPUT_WIRE_BYTES} wire bytes.`);
  return bytes;
}

export function decodeTypedValue(bytes: Uint8Array, type: Exclude<DataType, 'artifact'>): unknown {
  if (bytes.byteLength > MAX_TYPED_OUTPUT_WIRE_BYTES) invalid('typed_value_limit', 'output', `Typed input exceeds ${MAX_TYPED_OUTPUT_WIRE_BYTES} wire bytes.`);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return invalid('output_type', 'output', 'Typed output must be valid UTF-8 JSON.'); }
  checkType(value, type);
  encodeTypedValue(value, type);
  return value;
}
