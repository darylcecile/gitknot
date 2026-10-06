import { createHash } from 'node:crypto';
import { commitStorageObject, deleteStorageObject, reserveStorageObject } from '@gitknot/billing';
import { ApiError, cellDatabase, execute, hex, identityAuthorityBindings, now, one, readBounded, sha256, stmt } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import type { DirectoryBackup } from '@cloudflare/sandbox';
import { EXECUTION_LIMITS } from '@gitknot/execution/config';
import { authorizeExecutionActor, fenceExecutionAuthority } from '@gitknot/execution/authorization';
import { guardedBatch, primary } from '@gitknot/execution/store';
import { LOCAL_SCOPE_KEY, localAttemptEnvironment, localFenced } from '@gitknot/execution/hosted/local-runtime';
import type { LocalRuntimeScope } from '@gitknot/execution/hosted/local-runtime';
import { RuntimeJournal } from '@gitknot/execution/hosted/runtime-journal';
import type { RuntimeOperation } from '@gitknot/execution/hosted/runtime-journal';
import { OBJECT_PREFIX, OPERATION_PREFIX } from '@gitknot/execution/hosted/runtime-types';
import { SNAPSHOT_DIR } from '@gitknot/execution/hosted/scripts';

const objectPrefix = 'hosted:local-snapshot:';
const keyPattern = /^backups\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/(data\.sqsh|meta\.json)$/;
interface SnapshotObject {
  key: string; snapshot_id: string; object_id: string; reserve_issued: boolean; reserved: boolean;
  size_bytes: number | null; sha256: string | null; etag: string | null; expires_at: string;
  retained: boolean; commit_intent: boolean;
}
interface SnapshotMetadata { id: string; dir: string; sizeBytes: number; ttl: number; createdAt: string }

/** Trusted-account SDK objects: uncommitted objects are ephemeral, sealed ones retained. */
export class LocalSnapshotStore {
  private readonly allowedReads = new Set<string>();
  constructor(private readonly env: Bindings, private readonly journal: RuntimeJournal) {}

  private scope(): LocalRuntimeScope {
    const scope = this.journal.ctx.storage.kv.get<LocalRuntimeScope>(LOCAL_SCOPE_KEY);
    if (!scope) throw localFenced();
    return scope;
  }
  private bucket(): R2Bucket {
    const bucket = this.env.BACKUP_BUCKET as R2Bucket | undefined;
    if (!bucket?.put || !bucket.get || !bucket.head || !bucket.delete) throw new ApiError(503, 'snapshot_storage_unavailable', 'The trusted snapshot bucket is unavailable.');
    return bucket;
  }
  private record(key: string): SnapshotObject | undefined { return this.journal.ctx.storage.kv.get<SnapshotObject>(`${objectPrefix}${key}`); }
  private async save(object: SnapshotObject): Promise<void> {
    this.journal.ctx.storage.kv.put(`${objectPrefix}${object.key}`, object);
    if (object.retained) this.journal.ctx.storage.kv.delete(`${OBJECT_PREFIX}${object.key}`);
    else this.journal.ctx.storage.kv.put(`${OBJECT_PREFIX}${object.key}`, { key: object.key });
    await this.journal.ctx.storage.sync();
  }

  async put(key: string, value: ReadableStream<Uint8Array> | string | ArrayBuffer | Uint8Array): Promise<R2Object> {
    const match = keyPattern.exec(key), scope = this.scope();
    this.journal.active();
    if (!match || this.record(key)) throw new ApiError(409, 'snapshot_conflict', 'The SDK snapshot key is invalid or already consumed.');
    const selected = await localAttemptEnvironment(this.env, scope, true);
    if (selected.env.CELL_ID !== scope.cell_id || selected.env.SHARD_ID !== scope.shard_id) throw localFenced();
    await fenceExecutionAuthority(selected.env, selected.context, await authorizeExecutionActor(selected.env, selected.context.plan), 'local-snapshot-upload');
    const object: SnapshotObject = { key, snapshot_id: match[1]!, object_id: `sdk_${(await sha256(key)).slice(0, 48)}`,
      reserve_issued: false, reserved: false, size_bytes: null, sha256: null, etag: null,
      expires_at: new Date(Date.now() + scope.retention_seconds * 1000).toISOString(), retained: false, commit_intent: false };
    const maximum = key.endsWith('meta.json') ? 65536 : this.journal.active().cache_bytes + 16 * 1024 * 1024;
    await this.save(object); // The reaper learns every key BEFORE a reservation or R2 byte.
    return this.journal.operation('snapshot-upload', async () => {
      object.reserve_issued = true; await this.save(object);
      await reserveStorageObject(selected.env, { account_id: scope.account_id, reservation_id: scope.reservation_id, fence: scope.reservation_fence,
        object_id: object.object_id, key, bucket: 'backups', maximum_bytes: String(maximum), retention_until: object.expires_at });
      object.reserved = true; await this.save(object);
      const source = value instanceof ReadableStream ? value : new Response(value as BodyInit).body!;
      const hash = createHash('sha256'); let size = 0, complete = false;
      const journal = this.journal;
      const stream = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          journal.active(); size += chunk.length;
          if (size > maximum) throw new ApiError(413, 'snapshot_quota_exceeded', 'The SDK snapshot exceeded its byte allowance.');
          hash.update(chunk); controller.enqueue(chunk);
        },
        flush() { complete = true; },
      }));
      const stored = await this.journal.operation(`snapshot-r2-put:${key}`, () => this.bucket().put(key, stream), { uncertainOnReject: true });
      const digest = hash.digest('hex'), head = await this.bucket().head(key);
      if (!complete || !stored || !head || head.size !== size || head.etag !== stored.etag
        || head.checksums.sha256 && hex(new Uint8Array(head.checksums.sha256)) !== digest) throw new ApiError(503, 'snapshot_upload_unverified', 'The complete SDK snapshot bytes were not verified.');
      object.size_bytes = size; object.sha256 = digest; object.etag = head.etag; await this.save(object);
      await commitStorageObject(selected.env, { account_id: scope.account_id, reservation_id: scope.reservation_id, fence: scope.reservation_fence,
        object_id: object.object_id, bytes: String(size), etag: head.etag, checksum: digest });
      return stored;
    });
  }

  async permitRestore(backup: DirectoryBackup): Promise<void> {
    if (backup.dir !== SNAPSHOT_DIR || backup.localBucket !== true || !keyPattern.test(`backups/${backup.id}/data.sqsh`)) throw localFenced();
    const selected = await localAttemptEnvironment(this.env, this.scope(), true), { attempt: a, run, job } = selected.context;
    if (!job.cache) throw localFenced();
    const snapshot = await one(primary(selected.env), `SELECT s.id FROM execution_caches c JOIN execution_snapshots s ON s.id=json_extract(c.snapshot_json,'$.id')
      WHERE c.repo_id=? AND c.account_id=? AND c.trust=? AND c.toolchain_digest=? AND c.expires_at>?
        AND s.id=? AND s.repo_id=c.repo_id AND s.account_id=c.account_id AND s.state='sealed' AND s.expires_at>?`,
    a.repo_id, a.account_id, run.trust, job.toolchain.digest, now(), backup.id, now());
    if (!snapshot) throw new ApiError(409, 'cache_unavailable', 'The snapshot is outside the declared retained dependency cache.');
    this.allowedReads.add(`backups/${backup.id}/data.sqsh`); this.allowedReads.add(`backups/${backup.id}/meta.json`);
  }
  finishRestore(backup: DirectoryBackup): void {
    this.allowedReads.delete(`backups/${backup.id}/data.sqsh`); this.allowedReads.delete(`backups/${backup.id}/meta.json`);
  }

  async retain(backup: DirectoryBackup, cacheKey: string | null): Promise<void> {
    const scope = this.scope(), selected = await localAttemptEnvironment(this.env, scope, true), { attempt: a, run, job } = selected.context;
    if (selected.env.CELL_ID !== scope.cell_id || selected.env.SHARD_ID !== scope.shard_id) throw localFenced();
    if (backup.dir !== SNAPSHOT_DIR || backup.localBucket !== true || cacheKey !== null && (!/^[a-f0-9]{64}$/.test(cacheKey)
      || !job.cache || job.cache.mode === 'read' || job.steps.some(step => step.secrets.length))) throw localFenced();
    const archive = this.record(`backups/${backup.id}/data.sqsh`), metadata = this.record(`backups/${backup.id}/meta.json`);
    if (!archive?.sha256 || archive.size_bytes === null || !metadata?.sha256) throw new ApiError(503, 'snapshot_incomplete', 'Both SDK snapshot objects must be verified before retention.');
    const info = await this.metadata(metadata, archive);
    const expires = new Date(Math.min(Date.parse(archive.expires_at), Date.parse(metadata.expires_at), Date.parse(info.createdAt) + info.ttl * 1000)).toISOString();
    if (expires <= now()) throw new ApiError(409, 'snapshot_expired', 'The SDK snapshot has expired.');
    const authority = await authorizeExecutionActor(selected.env, selected.context.plan);
    await fenceExecutionAuthority(selected.env, selected.context, authority, 'local-snapshot-retention');
    await this.save({ ...archive, commit_intent: true, expires_at: expires });
    await this.save({ ...metadata, commit_intent: true, expires_at: expires });
    const db = primary(selected.env), snapshotJson = JSON.stringify({ id: backup.id, dir: SNAPSHOT_DIR, localBucket: true });
    const statements = cacheKey ? [stmt(db, `INSERT INTO execution_caches
      (cache_key,repo_id,account_id,trust,toolchain_digest,attempt_id,snapshot_json,size_bytes,expires_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET attempt_id=excluded.attempt_id,snapshot_json=excluded.snapshot_json,
      size_bytes=excluded.size_bytes,expires_at=excluded.expires_at,created_at=excluded.created_at
      WHERE execution_caches.repo_id=excluded.repo_id AND execution_caches.account_id=excluded.account_id
        AND execution_caches.trust=excluded.trust AND execution_caches.toolchain_digest=excluded.toolchain_digest AND execution_caches.created_at<=excluded.created_at`,
    cacheKey, a.repo_id, a.account_id, run.trust, job.toolchain.digest, a.id, snapshotJson, archive.size_bytes, expires, info.createdAt)] : [];
    await guardedBatch(db, stmt(db, `INSERT INTO execution_snapshots
      (id,repo_id,account_id,attempt_id,runtime_id,snapshot_json,archive_key,metadata_key,size_bytes,sha256,state,expires_at,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,'sealed',?,? WHERE EXISTS (SELECT 1 FROM execution_runtime_receipts r
        JOIN execution_attempts a ON a.id=r.attempt_id WHERE r.runtime_id=? AND r.attempt_id=? AND r.state='armed'
          AND a.status='running' AND a.generation=? AND a.lease_expires_at>? AND a.deadline_at>?)
      ON CONFLICT(id) DO UPDATE SET id=excluded.id WHERE execution_snapshots.attempt_id=excluded.attempt_id
        AND execution_snapshots.repo_id=excluded.repo_id AND execution_snapshots.account_id=excluded.account_id
        AND execution_snapshots.runtime_id=excluded.runtime_id AND execution_snapshots.sha256=excluded.sha256 AND execution_snapshots.state='sealed'`,
    backup.id, a.repo_id, a.account_id, a.id, a.runtime_id, snapshotJson, archive.key, metadata.key, archive.size_bytes, archive.sha256, expires, info.createdAt,
    a.runtime_id, a.id, a.generation, now(), now()), statements);
    await this.save({ ...archive, commit_intent: true, retained: true, expires_at: expires });
    await this.save({ ...metadata, commit_intent: true, retained: true, expires_at: expires });
  }

  private async metadata(object: SnapshotObject, archive: SnapshotObject): Promise<SnapshotMetadata> {
    const blob = await this.bucket().get(object.key);
    if (!blob) throw new ApiError(503, 'snapshot_incomplete', 'SDK metadata is missing.');
    const bytes = await readBounded(blob.body, 65536);
    if (await sha256(bytes) !== object.sha256) throw new ApiError(503, 'snapshot_checksum_mismatch', 'SDK metadata changed after upload.');
    const info = JSON.parse(new TextDecoder().decode(bytes)) as SnapshotMetadata;
    if (info.id !== object.snapshot_id || info.dir !== SNAPSHOT_DIR || info.sizeBytes !== archive.size_bytes
      || !Number.isInteger(info.ttl) || info.ttl < 1 || info.ttl > this.scope().retention_seconds || !Number.isFinite(Date.parse(info.createdAt))) {
      throw new ApiError(409, 'snapshot_invalid', 'SDK metadata does not match the bounded retained snapshot.');
    }
    return info;
  }

  /** Close the producer SQL fence before resolving a lost snapshot publication. */
  async fencePublication(): Promise<Bindings> {
    const scope = this.scope();
    const env = { ...this.env, ...identityAuthorityBindings(this.env), DB: cellDatabase(this.env, scope.shard_id), SHARD_ID: scope.shard_id };
    await execute(primary(env), `UPDATE execution_runtime_receipts SET state=CASE WHEN state='destroyed' THEN state ELSE 'destroying' END,updated_at=?
      WHERE runtime_id=? AND attempt_id=? AND repo_id=? AND account_id=? AND generation=?`, now(), scope.runtime_id, scope.attempt_id, scope.repo_id, scope.account_id, scope.generation);
    return env;
  }

  async reap(): Promise<void> {
    const objects = [...this.journal.ctx.storage.kv.list<SnapshotObject>({ prefix: objectPrefix })].map(([, value]) => value);
    let fenced: Bindings | undefined;
    for (let object of objects) {
      if (object.retained && object.expires_at > now()) continue;
      if (!object.retained && object.commit_intent) {
        fenced ??= await this.fencePublication();
        const scope = this.scope();
        const retained = await one<{ expires_at: string }>(primary(fenced), `SELECT expires_at FROM execution_snapshots
          WHERE id=? AND attempt_id=? AND repo_id=? AND account_id=? AND runtime_id=? AND state='sealed'`,
        object.snapshot_id, scope.attempt_id, scope.repo_id, scope.account_id, scope.runtime_id);
        if (retained) {
          object = { ...object, retained: true, expires_at: retained.expires_at }; await this.save(object);
          if (object.expires_at > now()) continue;
        }
      }
      await this.remove(object);
    }
  }

  private async remove(object: SnapshotObject): Promise<void> {
    const bucket = this.bucket();
    await bucket.delete(object.key);
    if (await bucket.head(object.key)) throw new ApiError(503, 'snapshot_deletion_unverified', 'An uncommitted or expired SDK snapshot is still present.');
    if ([...this.journal.ctx.storage.kv.list<RuntimeOperation>({ prefix: OPERATION_PREFIX })].some(([, operation]) => operation.kind === `snapshot-r2-put:${object.key}`)) {
      // Physically remove an unknown partial, but retain its journal/financial
      // hold and retry deletion while an old write may still arrive.
      return;
    }
    if (object.reserve_issued) await deleteStorageObject(this.env, { account_id: this.scope().account_id, object_id: object.object_id });
    if (await bucket.head(object.key)) throw new ApiError(503, 'snapshot_deletion_unverified', 'Snapshot deletion is not stable.');
    this.journal.ctx.storage.kv.delete(`${objectPrefix}${object.key}`);
    this.journal.ctx.storage.kv.delete(`${OBJECT_PREFIX}${object.key}`);
    await this.journal.ctx.storage.sync();
  }

  nextWakeup(): number | null {
    const objects = [...this.journal.ctx.storage.kv.list<SnapshotObject>({ prefix: objectPrefix })].map(([, value]) => value);
    if (!objects.length) return null;
    return Math.min(...objects.map(value => value.retained ? Date.parse(value.expires_at) : Date.now() + 5000));
  }

  binding(): R2Bucket | undefined {
    const raw = this.env.BACKUP_BUCKET as R2Bucket | undefined;
    if (!raw?.put) return undefined;
    const store = this;
    return new Proxy(raw, { get(target, property) {
      if (property === 'put') return (key: string, value: Parameters<LocalSnapshotStore['put']>[1]) => store.put(key, value);
      if (property === 'get' || property === 'head') return (key: string) => {
        store.journal.active();
        if (!keyPattern.test(key) || !store.record(key) && !store.allowedReads.has(key)) throw localFenced();
        return property === 'get' ? target.get(key) : target.head(key);
      };
      if (property === 'delete') return async (keys: string | string[]) => {
        for (const key of typeof keys === 'string' ? [keys] : keys) {
          const object = store.record(key);
          if (!object) continue;
          if (object.retained || object.commit_intent) throw new ApiError(409, 'snapshot_retained', 'The SDK cannot delete a retained snapshot.');
          await store.remove(object);
        }
      };
      if (['list', 'createMultipartUpload', 'resumeMultipartUpload'].includes(String(property))) return () => { throw new ApiError(403, 'snapshot_operation_denied', 'The SDK cannot enumerate or presign snapshot storage.'); };
      const value = Reflect.get(target, property, target); return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
}

export function snapshotBucket(env: Bindings, state: DurableObjectState): R2Bucket | undefined {
  return new LocalSnapshotStore(env, new RuntimeJournal(state)).binding();
}
