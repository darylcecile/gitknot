import { createHash } from 'node:crypto';
import { ApiError } from '@gitknot/core/errors';

export interface UploadInput {
  body: ReadableStream<Uint8Array>;
  readonly complete: boolean;
  readonly received: number;
  stop(reason?: unknown): void;
}

/** Withhold the final byte until EOF and SHA-256 are verified, using constant-size tail storage. */
export function validatedUploadInput(source: ReadableStream<Uint8Array> | null, size: number, checksum: string): UploadInput {
  const reader = (source ?? new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } })).getReader();
  const digest = createHash('sha256');
  let received = 0;
  let complete = false;
  let stopped = false;
  let tail: Uint8Array | null = null;
  let output: ReadableStreamDefaultController<Uint8Array>;

  function stop(reason: unknown = new ApiError(422, 'upload_input_incomplete', 'The input stream did not complete.')): void {
    if (stopped) return;
    stopped = true;
    if (!complete) output.error(reason);
    // There is one reader, not a tee. The synchronous stopped flag also excludes
    // a pending pull from ever releasing its tail after a failed storage call.
    void reader.cancel(reason).catch(() => undefined);
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) { output = controller; },
    async pull(controller) {
      try {
        while (!stopped) {
          const chunk = await reader.read();
          if (stopped) return;
          if (chunk.done) {
            if (received !== size) throw new ApiError(422, 'size_mismatch', 'The uploaded byte count does not match its manifest.');
            if (digest.digest('hex') !== checksum) throw new ApiError(422, 'checksum_mismatch', 'The upload checksum does not match its manifest.');
            complete = true;
            if (tail) controller.enqueue(tail);
            controller.close();
            reader.releaseLock();
            return;
          }
          if (chunk.value.byteLength === 0) continue;
          if (received + chunk.value.byteLength > size) throw new ApiError(413, 'payload_too_large', 'The upload exceeds its reserved size.');
          received += chunk.value.byteLength;
          digest.update(chunk.value);
          const emitted = tail !== null || chunk.value.byteLength > 1;
          if (tail) controller.enqueue(tail);
          if (chunk.value.byteLength > 1) controller.enqueue(chunk.value.subarray(0, -1));
          tail = chunk.value.slice(-1);
          if (emitted) return;
        }
      } catch (error) { stop(error); }
    },
    cancel(reason) { stop(reason); },
  });
  return { body, get complete() { return complete; }, get received() { return received; }, stop };
}
