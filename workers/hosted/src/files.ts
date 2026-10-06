import { createHash } from 'node:crypto';
import { streamFile } from '@cloudflare/sandbox';
import type { Sandbox } from '@cloudflare/sandbox';
import { ApiError } from '@gitknot/core';
import { shellQuote } from '@gitknot/execution/checkout';
import { LIMITS } from './types.ts';

export function decodedFile(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = streamFile(source);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await iterator.next();
        if (chunk.done) controller.close();
        else controller.enqueue(typeof chunk.value === 'string' ? new TextEncoder().encode(chunk.value) : chunk.value);
      } catch { controller.error(new ApiError(503, 'file_read_unconfirmed', 'The SDK file stream did not complete.')); }
    },
    async cancel() { await iterator.return(undefined as never); },
  });
}

export async function writeVerifiedFile(sandbox: Sandbox, path: string, source: ReadableStream<Uint8Array>, expected: { size_bytes: number; sha256: string }, maximum: number): Promise<void> {
  if (expected.size_bytes > maximum || expected.size_bytes < 0) throw new ApiError(413, 'input_limit', 'The input exceeds its declared byte limit.');
  await sandbox.writeFile(path, '', { sessionId: '__DISABLE_SESSION__' });
  const hash = createHash('sha256'), reader = source.getReader();
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      for (let offset = 0; offset < next.value.length; offset += LIMITS.chunk_bytes) {
        const bytes = next.value.subarray(offset, offset + LIMITS.chunk_bytes);
        if (total + bytes.length > expected.size_bytes) throw new ApiError(413, 'input_limit', 'The input stream exceeded its expected size.');
        await sandbox.writeFile(`${path}.chunk`, Buffer.from(bytes).toString('base64'), { encoding: 'base64', sessionId: '__DISABLE_SESSION__' });
        // Offset writes are idempotent even if the SDK retries an uncertain RPC.
        const copied = await sandbox.exec(`dd if=${shellQuote(`${path}.chunk`)} of=${shellQuote(path)} bs=65536 oflag=seek_bytes seek=${total} conv=notrunc status=none && rm -f ${shellQuote(`${path}.chunk`)}`, { timeout: 5000 });
        if (!copied.success) throw new ApiError(503, 'input_write_unconfirmed', 'The executor could not materialize the input.');
        hash.update(bytes); total += bytes.length;
      }
    }
  } finally { await reader.cancel(); }
  if (total !== expected.size_bytes || hash.digest('hex') !== expected.sha256.replace(/^sha256:/, '')) throw new ApiError(409, 'input_checksum_mismatch', 'The input stream failed checksum verification.');
  const verify = await sandbox.exec(`sha256sum ${shellQuote(path)}`, { timeout: 10_000 });
  if (!verify.success || verify.stdout.split(/\s+/)[0] !== expected.sha256.replace(/^sha256:/, '')) throw new ApiError(409, 'input_checksum_mismatch', 'The materialized input failed checksum verification.');
}

export async function chunks(source: ReadableStream<Uint8Array>, maximum: number,
  send: (bytes: Uint8Array, final: boolean) => Promise<void>): Promise<{ size_bytes: number; sha256: string }> {
  const reader = source.getReader(), hash = createHash('sha256');
  let buffered = new Uint8Array(LIMITS.chunk_bytes), used = 0, size = 0;
  const emit = async (part: Uint8Array, final: boolean) => {
    size += part.length;
    if (size > maximum) throw new ApiError(413, 'output_quota_exceeded', 'The output stream exceeded its declared byte limit.');
    hash.update(part); await send(part, final);
  };
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      for (let offset = 0; offset < next.value.length;) {
        if (used === LIMITS.chunk_bytes) { await emit(buffered, false); buffered = new Uint8Array(LIMITS.chunk_bytes); used = 0; }
        const take = Math.min(LIMITS.chunk_bytes - used, next.value.length - offset);
        buffered.set(next.value.subarray(offset, offset + take), used);
        used += take; offset += take;
      }
    }
    await emit(buffered.subarray(0, used), true);
  } finally { await reader.cancel(); }
  return { size_bytes: size, sha256: hash.digest('hex') };
}
