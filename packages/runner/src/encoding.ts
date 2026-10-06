/** Preserve UTF-8 BOMs exactly, matching Node Buffer decoding in mixed Worker/Node type environments. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}

/** Split already-redacted UTF-8 without cutting a code point or changing its bytes. */
export function* utf8Chunks(bytes: Uint8Array, maximum: number): Generator<Uint8Array> {
  if (!Number.isSafeInteger(maximum) || maximum < 4) throw new RangeError('UTF-8 log chunks require at least four bytes.');
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  for (let start = 0; start < bytes.byteLength;) {
    let end = Math.min(start + maximum, bytes.byteLength);
    while (end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    yield bytes.slice(start, end);
    start = end;
  }
}
