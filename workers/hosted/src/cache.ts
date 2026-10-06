import { ApiError, canonicalJson, readBounded, sha256 } from '@gitknot/core';
import type { DirectoryBackup, Sandbox } from '@cloudflare/sandbox';
import type { RemoteAttemptGrant, RemoteCache, RemoteInput, RemoteStoredObject } from '@gitknot/execution/remote/protocol';
import { CONTROL_DIR, SNAPSHOT_DIR, dependencyRestoreScript, dependencySnapshotScript } from '@gitknot/execution/hosted/scripts';
import { shellQuote } from '@gitknot/execution/checkout';
import { secretVariants } from '@gitknot/execution/redaction';
import type { RemoteCallbacks } from './callback.ts';
import type { HostedEnv, HostedWorkflowParams } from './types.ts';
import { LIMITS } from './types.ts';
import { attemptController } from './controller.ts';
import type { HostedSandbox } from './sandbox.ts';
import { verifyExactSourceScript } from './job-scripts.ts';

export class RemoteDependencyCache {
  private cacheKey: string | null = null;

  constructor(private readonly env: HostedEnv, private readonly params: HostedWorkflowParams, private readonly grant: RemoteAttemptGrant,
    private readonly sandbox: Sandbox, private readonly runtime: DurableObjectStub<HostedSandbox>, private readonly callbacks: RemoteCallbacks,
    private readonly masks: string[], private readonly remaining: (reserve?: number) => number) {}

  async restore(inputs: RemoteInput[]): Promise<void> {
    const declaration = this.grant.job.cache;
    if (!declaration) return;
    const files = await this.sandbox.exec(`git -C /workspace ls-files -s -- ${declaration.key_files.map(shellQuote).join(' ')}`, { timeout: 10_000 });
    if (!files.success || !files.stdout.trim()) throw new ApiError(409, 'cache_inputs_unavailable', 'Declared cache key files are unavailable in the exact source.');
    this.cacheKey = await sha256(canonicalJson({ version: 1, sdk: '0.2.0', sandbox: '0.12.1',
      declaration: { key: declaration.key, paths: declaration.paths, key_files: declaration.key_files },
      files: files.stdout, workflow: this.grant.workflow_digest, toolchain: this.grant.job.toolchain.digest,
      inputs: inputs.map(input => ({ reference: input.reference, sha256: input.sha256 })).sort((a, b) => a.reference.localeCompare(b.reference)) }));
    const cache = await this.callbacks.json<RemoteCache | null>('cache-get', { cache_key: this.cacheKey });
    if (!cache) return;
    validateCache(cache, this.grant.job.limits?.cache_bytes ?? LIMITS.cache_bytes);
    const logical = (part: 'archive' | 'metadata') => `backups/${cache.snapshot.id}/${part === 'archive' ? 'data.sqsh' : 'meta.json'}`;
    try {
      for (const part of ['archive', 'metadata'] as const) {
        const response = await this.callbacks.download('cache-read', cache[part].object_id);
        if (!response.body) throw new ApiError(409, 'cache_invalid', 'The cache download is incomplete.');
        await this.runtime.importSnapshotObject(logical(part), response.body, cache[part]);
      }
      await this.verifyMetadata(cache.snapshot, cache.archive.size_bytes);
      const restored = await this.sandbox.restoreBackup({ ...cache.snapshot, dir: SNAPSHOT_DIR, localBucket: true });
      if (!restored.success) throw new ApiError(409, 'cache_invalid', 'The SDK could not restore the dependency cache.');
      await this.sandbox.writeFile(`${CONTROL_DIR}/restore-cache.cjs`, dependencyRestoreScript, { sessionId: '__DISABLE_SESSION__' });
      const copied = await this.sandbox.exec(`node ${CONTROL_DIR}/restore-cache.cjs`, { timeout: Math.min(30_000, this.remaining(45_000)),
        env: { GITKNOT_CACHE_SPEC: JSON.stringify({ paths: declaration.paths, max_bytes: this.grant.job.limits?.cache_bytes ?? LIMITS.cache_bytes }) } });
      if (!copied.success) {
        // A dependency cache cannot alter tracked source or leave deleted files.
        const reset = await this.sandbox.exec(`git -C /workspace -c core.hooksPath=/dev/null -c core.fsmonitor=false reset --hard ${shellQuote(this.grant.commit_sha)} && git -C /workspace clean -ffdx`, { timeout: 30_000 });
        if (!reset.success) throw new ApiError(503, 'cache_recovery_failed', 'The exact source could not be recovered after rejecting a dependency cache.');
      }
      const exact = await this.sandbox.exec(verifyExactSourceScript(this.grant.commit_sha), { timeout: 10_000 });
      if (!exact.success) throw new ApiError(409, 'cached_source_mismatch', 'The dependency cache changed tracked source.');
    } finally {
      await this.runtime.deleteSnapshotObject(logical('archive'));
      await this.runtime.deleteSnapshotObject(logical('metadata'));
    }
  }

  async snapshot(): Promise<DirectoryBackup> {
    if (!await this.runtime.stopJobProcesses()) throw new ApiError(503, 'process_stop_unconfirmed', 'A snapshot requires confirmed process termination.');
    const writable = this.grant.job.cache && this.grant.job.cache.mode !== 'read' && !this.grant.job.steps.some(step => step.secrets.length);
    const paths = writable ? this.grant.job.cache!.paths : [];
    await this.sandbox.writeFile(`${CONTROL_DIR}/snapshot.cjs`, dependencySnapshotScript, { sessionId: '__DISABLE_SESSION__' });
    const result = await this.sandbox.exec(`node ${CONTROL_DIR}/snapshot.cjs`, { timeout: Math.min(30_000, this.remaining(20_000)), env: {
      GITKNOT_CACHE_SPEC: JSON.stringify({ paths, max_bytes: this.grant.job.limits?.cache_bytes ?? LIMITS.cache_bytes, masks: paths.length ? secretVariants(this.masks) : [] }),
    } });
    if (!result.success) throw new ApiError(409, 'snapshot_unsafe', 'The dependency snapshot failed sanitization.');
    const snapshot = await this.sandbox.createBackup({ dir: SNAPSHOT_DIR, name: this.grant.attempt_id, ttl: writable ? this.grant.job.cache!.retention_seconds : 3600,
      localBucket: true, multipart: false, compression: { format: 'lz4', threads: 1 } });
    const archive = await this.runtime.snapshotObject(`backups/${snapshot.id}/data.sqsh`);
    await this.verifyMetadata(snapshot, archive.size_bytes!);
    const objects: Partial<Record<'archive' | 'metadata', RemoteStoredObject>> = {};
    for (const part of ['archive', 'metadata'] as const) {
      const logical = `backups/${snapshot.id}/${part === 'archive' ? 'data.sqsh' : 'meta.json'}`;
      const record = await this.runtime.snapshotObject(logical);
      const stored = await this.callbacks.snapshot(snapshot.id, part, await this.runtime.readSnapshotObject(logical), record.size_bytes!, record.sha256!);
      if (stored.sha256 !== record.sha256 || stored.size_bytes !== record.size_bytes) throw new ApiError(409, 'snapshot_copy_unverified', 'The retained snapshot copy was not verified.');
      objects[part] = stored;
    }
    await attemptController(this.env, this.params.attempt_id).publish(this.params, 'snapshot-commit', 'snapshot:commit', {
      snapshot: { id: snapshot.id, dir: SNAPSHOT_DIR, localBucket: true }, archive_object_id: objects.archive!.id,
      metadata_object_id: objects.metadata!.id, cache_key: writable ? this.cacheKey : null,
    });
    return { id: snapshot.id, dir: SNAPSHOT_DIR, localBucket: true };
  }

  private async verifyMetadata(snapshot: DirectoryBackup, size: number): Promise<void> {
    const bytes = await readBounded(await this.runtime.readSnapshotObject(`backups/${snapshot.id}/meta.json`), LIMITS.metadata_bytes);
    let metadata: { id?: string; dir?: string; sizeBytes?: number; ttl?: number; createdAt?: string };
    try { metadata = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ApiError(409, 'snapshot_invalid', 'The SDK snapshot metadata is invalid.'); }
    if (metadata.id !== snapshot.id || metadata.dir !== SNAPSHOT_DIR || metadata.sizeBytes !== size || !Number.isFinite(metadata.ttl)
      || Number(metadata.ttl) <= 0 || !metadata.createdAt || !Number.isFinite(Date.parse(metadata.createdAt))
      || Date.parse(metadata.createdAt) + Number(metadata.ttl) * 1000 <= Date.now() + 60_000) throw new ApiError(409, 'snapshot_invalid', 'The SDK snapshot metadata does not match its retained archive.');
  }
}

function validateCache(cache: RemoteCache, maximum: number): void {
  if (!cache.snapshot || cache.snapshot.dir !== SNAPSHOT_DIR || cache.snapshot.localBucket !== true
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(cache.snapshot.id)
    || !Number.isFinite(Date.parse(cache.expires_at)) || Date.parse(cache.expires_at) <= Date.now() + 60_000) throw new ApiError(409, 'cache_invalid', 'The retained cache handle is invalid or expired.');
  for (const part of ['archive', 'metadata'] as const) {
    const object = cache[part];
    if (!object || !/^[A-Za-z0-9_-]{1,128}$/.test(object.object_id) || !/^[a-f0-9]{64}$/.test(object.sha256) || !Number.isSafeInteger(object.size_bytes)
      || object.size_bytes < 0 || object.size_bytes > (part === 'archive' ? maximum + LIMITS.snapshot_overhead : LIMITS.metadata_bytes)) throw new ApiError(409, 'cache_invalid', 'A retained cache part is invalid or exceeds its quota.');
  }
}
