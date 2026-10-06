import { z } from 'zod';
import { ApiError } from './errors.ts';
import type { Bindings } from './types.ts';

const limitsSchema = z.object({
  json_bytes: z.number().int().min(1024).max(4 * 1024 * 1024).default(1024 * 1024),
  page_size: z.number().int().min(1).max(200).default(100),
  upload_bytes: z.number().int().positive().max(5 * 1024 ** 3).default(32 * 1024 ** 2),
  repository_bytes: z.number().int().positive().default(1024 ** 3),
  blob_bytes: z.number().int().positive().default(32 * 1024 ** 2),
  git_push_bytes: z.number().int().positive().default(90 * 1024 ** 2),
  account_storage_bytes: z.number().int().positive().default(10 * 1024 ** 3),
  repository_storage_bytes: z.number().int().positive().default(1024 ** 3),
  deleted_repository_retention_days: z.number().int().min(1).max(365).default(30),
  upload_reservation_minutes: z.number().int().min(5).max(1440).default(60),
  event_replay_days: z.number().int().min(30).max(365).default(30),
}).passthrough();

export type Limits = z.infer<typeof limitsSchema>;

export function limits(env: Pick<Bindings, 'LIMITS_JSON'>): Limits {
  try {
    return limitsSchema.parse(env.LIMITS_JSON ? JSON.parse(env.LIMITS_JSON) : {});
  } catch {
    throw new ApiError(503, 'configuration_unavailable', 'GitKnot resource limits are unavailable. Please retry later.');
  }
}

export async function readBounded(stream: ReadableStream<Uint8Array> | null, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        // A tee branch's cancellation may wait for its unread sibling. Do not delay the 413 on it.
        void reader.cancel('Request size exceeded.').catch(() => undefined);
        throw new ApiError(413, 'payload_too_large', `The request exceeds the ${maximum}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export function boundedStream(stream: ReadableStream<Uint8Array>, maximum: number, exact?: number): ReadableStream<Uint8Array> {
  let received = 0;
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > maximum || (exact !== undefined && received > exact)) {
        throw new ApiError(413, 'payload_too_large', 'The upload exceeds its reserved size.');
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (exact !== undefined && received !== exact) {
        throw new ApiError(422, 'size_mismatch', 'The uploaded byte count does not match its manifest.');
      }
    },
  }));
}
