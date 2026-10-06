import { createHash } from 'node:crypto';
import { ApiError } from '@gitknot/core';
import { LIMITS, OBJECT_PREFIX } from './types.ts';
import type { RuntimeJournal } from './runtime-journal.ts';

export interface EphemeralObject {
  key: string;
  logical_key: string;
  sha256: string | null;
  size_bytes: number | null;
  etag: string | null;
}

const backupKey = /^backups\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/(data\.sqsh|meta\.json)$/;

/** Restricts the pinned SDK to two files per backup, in this allocation only. */
export class EphemeralStore {
  constructor(readonly raw: R2Bucket | undefined, readonly journal: RuntimeJournal) {}

  private bucket(): R2Bucket {
    if (!this.raw?.put || !this.raw.head || !this.raw.list || !this.raw.delete) throw new ApiError(503, 'snapshot_storage_unavailable', 'The ephemeral snapshot bucket is unavailable.');
    return this.raw;
  }

  key(logical: string): string {
    if (!backupKey.test(logical)) throw new ApiError(422, 'snapshot_key_invalid', 'The SDK requested an unsupported snapshot object.');
    const state = this.journal.read();
    if (!state) throw new ApiError(409, 'snapshot_unowned', 'This runtime has no snapshot allocation.');
    return `hosted/${state.grant_digest}/${logical}`;
  }

  record(logical: string): EphemeralObject | undefined {
    return this.journal.ctx.storage.kv.get<EphemeralObject>(`${OBJECT_PREFIX}${this.key(logical)}`);
  }

  async put(logical: string, source: ReadableStream<Uint8Array> | string | ArrayBuffer | ArrayBufferView,
    expected?: { sha256: string; size_bytes: number }): Promise<R2Object> {
    const state = this.journal.active(), key = this.key(logical), storageKey = `${OBJECT_PREFIX}${key}`;
    const maximum = logical.endsWith('meta.json') ? LIMITS.metadata_bytes : state.cache_bytes + LIMITS.snapshot_overhead;
    if (this.record(logical) || [...this.journal.ctx.storage.kv.list({ prefix: OBJECT_PREFIX })].length >= 4) {
      throw new ApiError(409, 'snapshot_already_written', 'Snapshot objects cannot be overwritten or multiplied.');
    }
    this.journal.ctx.storage.kv.put(storageKey, { key, logical_key: logical, sha256: null, size_bytes: null, etag: null } satisfies EphemeralObject);
    await this.journal.ctx.storage.sync();
    const stream = source instanceof ReadableStream ? source : new Response(source as BodyInit).body!;
    let size = 0, ended = false;
    const hash = createHash('sha256');
    const journal = this.journal;
    const checked = stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        journal.active();
        size += chunk.byteLength;
        if (size > maximum || expected && size > expected.size_bytes) throw new ApiError(413, 'snapshot_quota_exceeded', 'The ephemeral snapshot exceeds its byte limit.');
        hash.update(chunk); controller.enqueue(chunk);
      },
      flush() { ended = true; },
    }));
    return this.journal.operation('snapshot-put-and-verify', async () => {
      // A failed transport can have an uncertain remote write. Its operation is
      // retained; repeated head/delete alone is not proof that it cannot arrive.
      const bucket = this.bucket();
      const object = await this.journal.operation('r2-put', () => bucket.put(key, checked), { uncertainOnReject: true });
      const sum = hash.digest('hex');
      const head = await bucket.head(key);
      if (!ended || !object || !head || head.size !== size || expected && (size !== expected.size_bytes || sum !== expected.sha256)) {
        throw new ApiError(409, 'snapshot_checksum_mismatch', 'The ephemeral snapshot was not completely verified.');
      }
      this.journal.ctx.storage.kv.put(storageKey, { key, logical_key: logical, size_bytes: size, sha256: sum, etag: head.etag } satisfies EphemeralObject);
      await this.journal.ctx.storage.sync();
      return object;
    });
  }

  async get(logical: string): Promise<R2ObjectBody | null> {
    this.journal.active();
    const record = this.record(logical);
    if (!record?.sha256) throw new ApiError(409, 'snapshot_unverified', 'Only verified snapshot objects can be read.');
    return this.bucket().get(record.key);
  }

  async head(logical: string): Promise<R2Object | null> {
    const record = this.record(logical);
    if (!record) return null;
    return this.bucket().head(record.key);
  }

  async delete(logical: string): Promise<void> {
    const record = this.record(logical);
    if (!record) return;
    const bucket = this.bucket();
    await bucket.delete(record.key);
    if (await bucket.head(record.key)) throw new ApiError(503, 'snapshot_deletion_unverified', 'An ephemeral snapshot object still exists.');
    this.journal.ctx.storage.kv.delete(`${OBJECT_PREFIX}${record.key}`);
    await this.journal.ctx.storage.sync();
  }

  async deleteAll(): Promise<void> {
    for (const [, record] of [...this.journal.ctx.storage.kv.list<EphemeralObject>({ prefix: OBJECT_PREFIX })]) await this.delete(record.logical_key);
    const state = this.journal.read();
    if (!state) throw new ApiError(409, 'snapshot_unowned', 'The runtime identity is unavailable.');
    const remaining = await this.bucket().list({ prefix: `hosted/${state.grant_digest}/`, limit: 1 });
    if (remaining.objects.length || remaining.truncated) throw new ApiError(503, 'snapshot_deletion_unverified', 'The ephemeral runtime prefix is not empty.');
  }

  binding(): R2Bucket | undefined {
    // A binding regression must not prevent sealing and destroying the VM.
    // Object cleanup still fails closed until the bucket is available again.
    if (!this.raw?.put) return undefined;
    const self = this;
    return new Proxy(this.raw, { get(target, property) {
      if (property === 'put') return (key: string, value: Parameters<EphemeralStore['put']>[1]) => self.put(key, value);
      if (property === 'get') return (key: string) => self.get(key);
      if (property === 'head') return (key: string) => self.head(key);
      if (property === 'delete') return async (keys: string | string[]) => { for (const key of typeof keys === 'string' ? [keys] : keys) await self.delete(key); };
      if (['createMultipartUpload', 'resumeMultipartUpload', 'list'].includes(String(property))) return () => { throw new ApiError(403, 'snapshot_operation_denied', 'The SDK cannot list or multipart-upload execution storage.'); };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
}
