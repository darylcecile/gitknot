import { ApiError, canonicalJson, sha256 } from '@gitknot/core';
import { z } from 'zod';
import type { RemoteStoredObject } from '@gitknot/execution/remote/protocol';
import { RemoteCallbacks } from './callback.ts';
import { LIMITS } from './types.ts';
import type { CompletionDraft } from './types.ts';

export type DurableAction = 'log' | 'output' | 'log-manifest' | 'output-manifest' | 'process' | 'checkout-complete' | 'checkpoint' | 'complete' | 'destroyed' | 'snapshot-commit';
interface OutboxEntry { action: DurableAction; body: Record<string, unknown>; digest: string; result?: unknown; delivered: boolean }
const prefix = 'hosted:outbox:';
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const declaredDigest = z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);

export const draftSchema = z.object({
  attempt_id: identifier, generation: z.number().int().positive(), plan_digest: declaredDigest, runner_id: z.string().min(1).max(256),
  conclusion: z.enum(['succeeded', 'failed', 'cancelled', 'timed_out', 'infrastructure_failed']),
  exit_code: z.number().int().min(0).max(255).nullable(),
  signal: z.string().regex(/^(?:SIG[A-Z0-9]{1,16}|UNKNOWN)$/).nullable(),
  resource_exhaustion: z.enum(['memory', 'disk', 'processes', 'logs', 'outputs', 'egress']).nullable(), toolchain_digest: declaredDigest,
  outputs: z.array(z.object({ name: identifier, sha256: declaredDigest, size_bytes: z.number().int().min(0).max(LIMITS.output_bytes) }).strict()).max(128),
  log_manifest_digest: checksum.nullable(), process_group_stopped: z.boolean(), started_at: z.iso.datetime(), finished_at: z.iso.datetime(),
}).strict();

/** Only already-redacted payloads and object/fact responses may enter this log. */
export class CallbackOutbox {
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly storage: DurableObjectStorage, private readonly callbacks: RemoteCallbacks) {}

  async publish<T>(action: DurableAction, id: string, body: Record<string, unknown>): Promise<T> {
    if (!/^[a-zA-Z0-9_.:-]{1,200}$/.test(id)) throw new TypeError('Invalid callback journal key.');
    validateAction(action, body);
    const key = `${prefix}${id}`, digest = await sha256(canonicalJson({ action, body }));
    const prior = this.storage.kv.get<OutboxEntry>(key);
    if (prior && prior.digest !== digest) throw new ApiError(409, 'callback_replay_mismatch', 'A durable callback cannot change on replay.');
    if (prior?.delivered) return prior.result as T;
    if (!prior) {
      this.storage.kv.put(key, { action, body, digest, delivered: false } satisfies OutboxEntry);
      await this.storage.sync();
    }
    const existing = this.pending.get(key);
    if (existing) return existing as Promise<T>;
    const send = this.deliver<T>(key);
    this.pending.set(key, send);
    try { return await send; }
    finally { if (this.pending.get(key) === send) this.pending.delete(key); }
  }

  async flushData(): Promise<void> {
    const entries = [...this.storage.kv.list<OutboxEntry>({ prefix })];
    // Log keys contain padded sequence numbers; replay retains contiguous order.
    for (const [key, entry] of entries) {
      if (!entry.delivered && !['complete', 'destroyed', 'checkpoint'].includes(entry.action)) await this.publish(entry.action, key.slice(prefix.length), entry.body);
    }
  }

  result<T>(id: string): T | undefined {
    const entry = this.storage.kv.get<OutboxEntry>(`${prefix}${id}`);
    return entry?.delivered ? entry.result as T : undefined;
  }

  private async deliver<T>(key: string): Promise<T> {
    const entry = this.storage.kv.get<OutboxEntry>(key)!;
    const result = await this.callbacks.json<unknown>(entry.action, entry.body);
    const retained = retainedResult(entry.action, result);
    this.storage.kv.put(key, { ...entry, body: {}, result: retained, delivered: true });
    await this.storage.sync();
    return retained as T;
  }
}

export function normalizeDraft(input: unknown): CompletionDraft {
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(422, 'completion_invalid', 'The hosted completion facts are invalid.');
  if (parsed.data.conclusion === 'succeeded' && (parsed.data.exit_code !== 0 || parsed.data.signal || parsed.data.resource_exhaustion || !parsed.data.process_group_stopped)) {
    throw new ApiError(422, 'completion_invalid', 'Successful execution requires a clean, confirmed process exit.');
  }
  return parsed.data;
}

function validateAction(action: DurableAction, body: Record<string, unknown>): void {
  if (!['log', 'output', 'log-manifest', 'output-manifest', 'process', 'checkout-complete', 'checkpoint', 'complete', 'destroyed', 'snapshot-commit'].includes(action)) throw new TypeError('Unsupported durable callback.');
  if (['log', 'output'].includes(action)) {
    const bytes = typeof body.data_base64 === 'string' ? Buffer.from(body.data_base64, 'base64') : null;
    if (!bytes || bytes.toString('base64') !== body.data_base64 || bytes.length > LIMITS.chunk_bytes || bytes.length !== body.size_bytes
      || !checksum.safeParse(body.sha256).success || !Number.isSafeInteger(body.sequence) || Number(body.sequence) < 0) {
      throw new ApiError(422, 'callback_chunk_invalid', 'The callback chunk is malformed or too large.');
    }
  }
  if (action === 'checkpoint' || action === 'complete') normalizeDraft(body.receipt);
  if (Buffer.byteLength(JSON.stringify(body)) > 512 * 1024) throw new ApiError(413, 'callback_limit', 'The durable callback exceeds its size limit.');
}

function retainedResult(action: DurableAction, value: unknown): unknown {
  if (['log', 'output', 'log-manifest', 'output-manifest'].includes(action)) {
    const parsed = z.object({ id: identifier, sha256: checksum, source_digest: declaredDigest.nullable(), size_bytes: z.number().int().nonnegative() }).safeParse(value);
    if (!parsed.success) throw new ApiError(502, 'callback_invalid', 'The control plane returned invalid stored-object facts.');
    return parsed.data satisfies RemoteStoredObject;
  }
  // Successful acknowledgements need no returned body in durable storage. In
  // particular, never retain an accidentally included capability or secret.
  return { acknowledged: true };
}
