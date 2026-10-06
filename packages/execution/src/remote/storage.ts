import { createHash } from 'node:crypto';
import { commitStorageObject, reserveStorageObject } from '@gitknot/billing';
import { ApiError, canonicalJson, execute, fromHex, many, now, one, sha256, stmt } from '@gitknot/core';
import type { AppContext, Bindings } from '@gitknot/core';
import { EXECUTION_LIMITS } from '../config.ts';
import { streamManifest } from '../objects.ts';
import { guardedBatch, primary } from '../store.ts';
import type { AttemptContext, ExecutionObject, JobRecord } from '../types.ts';
import type { RemoteCache, RemoteInput, RemoteSnapshotCommit } from './protocol.ts';

interface SnapshotRow {
  attempt_id: string; repo_id: string; account_id: string; generation: number; snapshot_id: string;
  archive_object_id: string | null; metadata_object_id: string | null; namespace: string; cache_key: string | null;
  snapshot_json: string | null; state: 'uploading' | 'sealed' | 'deleted'; expires_at: string; created_at: string;
}

export async function remoteInputs(env: Bindings, context: AttemptContext): Promise<RemoteInput[]> {
  const result: RemoteInput[] = [];
  for (const input of context.job.inputs) {
    const producer = await one<JobRecord>(primary(env), `SELECT * FROM workflow_jobs WHERE run_id=? AND repo_id=? AND job_key=? AND status='succeeded'`, context.run.id, context.run.repo_id, input.job);
    const object = producer && await one<ExecutionObject>(primary(env), `SELECT * FROM execution_objects WHERE attempt_id=? AND repo_id=? AND kind='manifest' AND name=? AND state='sealed' AND expires_at>?`,
      producer.current_attempt_id ?? producer.reused_attempt_id, context.run.repo_id, `output:${input.output}`, now());
    if (!object?.source_digest) throw new ApiError(409, 'input_unavailable', 'A declared verified input is unavailable.');
    const blob = await env.BLOBS.get(object.object_key);
    if (!blob) throw new ApiError(410, 'input_expired', 'A declared input manifest is no longer retained.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (await sha256(bytes) !== object.sha256) throw new ApiError(503, 'input_corrupt', 'The declared input manifest failed integrity verification.');
    const manifest = JSON.parse(new TextDecoder().decode(bytes)) as { size_bytes: number };
    const type = context.plan.jobs.find(job => job.key === input.job)?.outputs[input.output]?.type ?? 'artifact';
    if (!['artifact', 'string', 'number', 'boolean', 'json'].includes(type)) throw new ApiError(409, 'input_type', 'The declared input has an unsupported type.');
    result.push({ reference: `jobs.${input.job}.${input.output}`, object_id: object.id, type: type as RemoteInput['type'], sha256: object.source_digest, size_bytes: manifest.size_bytes });
  }
  return result;
}

export async function remoteInputBody(env: Bindings, context: AttemptContext, objectId: string): Promise<Response> {
  const permitted = (await remoteInputs(env, context)).find(input => input.object_id === objectId);
  if (!permitted) throw new ApiError(404, 'input_not_declared', 'This object is not a declared input of the attempt.');
  const object = await one<ExecutionObject>(primary(env), `SELECT * FROM execution_objects WHERE id=? AND repo_id=? AND state='sealed' AND expires_at>?`, objectId, context.run.repo_id, now());
  if (!object) throw new ApiError(410, 'input_expired', 'The input is no longer retained.');
  return new Response(await streamManifest(env, object), { headers: { 'content-type': 'application/octet-stream', 'content-length': String(permitted.size_bytes), 'x-gitknot-content-sha256': permitted.sha256, 'cache-control': 'no-store' } });
}

export function snapshotRetention(context: AttemptContext): number {
  return context.job.cache && context.job.cache.mode !== 'read' && !context.job.steps.some(step => step.secrets.length)
    ? context.job.cache.retention_seconds : 3600;
}

export function remoteCacheNamespace(context: AttemptContext): Promise<string> {
  return sha256(canonicalJson({ repo_id: context.run.repo_id, account_id: context.run.account_id, trust: context.run.trust,
    producer_id: context.attempt.producer_id, toolchain_digest: context.attempt.toolchain_digest, workflow_digest: context.run.workflow_digest,
    declaration: context.job.cache ? { key: context.job.cache.key, paths: context.job.cache.paths, key_files: context.job.cache.key_files } : null }));
}

export async function receiveRemoteSnapshot(env: Bindings, context: AttemptContext, request: Request, authority: AppContext): Promise<ExecutionObject> {
  const snapshotId = request.headers.get('x-gitknot-snapshot-id') ?? '', part = request.headers.get('x-gitknot-snapshot-part') ?? '';
  const size = Number(request.headers.get('content-length')), digest = request.headers.get('x-gitknot-content-sha256') ?? '';
  if (!/^[a-f0-9-]{36}$/.test(snapshotId) || !['archive', 'metadata'].includes(part) || !Number.isSafeInteger(size) || size < 1 || !/^[a-f0-9]{64}$/.test(digest)) throw new ApiError(422, 'snapshot_invalid', 'A snapshot requires exact identity, length and checksum.');
  const maximum = part === 'metadata' ? 65536 : (context.job.limits?.cache_bytes ?? EXECUTION_LIMITS.cache_bytes) + 16 * 1024 * 1024;
  if (size > maximum) throw new ApiError(413, 'snapshot_quota_exceeded', 'The snapshot exceeds this attempt’s byte allowance.');
  const db = primary(env), a = context.attempt, namespace = await remoteCacheNamespace(context), at = now();
  const expires = new Date(Date.now() + snapshotRetention(context) * 1000).toISOString();
  await execute(db, `INSERT OR IGNORE INTO remote_execution_snapshots (attempt_id,repo_id,account_id,generation,snapshot_id,namespace,state,expires_at,created_at)
    VALUES (?,?,?,?,?,?,'uploading',?,?)`, a.id, a.repo_id, a.account_id, a.generation, snapshotId, namespace, expires, at);
  const snapshot = await one<SnapshotRow>(db, 'SELECT * FROM remote_execution_snapshots WHERE attempt_id=? AND repo_id=?', a.id, a.repo_id);
  if (!snapshot || snapshot.snapshot_id !== snapshotId || snapshot.generation !== a.generation || snapshot.namespace !== namespace) throw new ApiError(409, 'snapshot_conflict', 'This attempt is already bound to another SDK snapshot.');
  const id = `obj_${(await sha256(`${a.id}:${snapshotId}:${part}`)).slice(0, 32)}`, name = `${snapshotId}:${part}`;
  const existing = await one<ExecutionObject>(db, 'SELECT * FROM execution_objects WHERE id=? AND attempt_id=? AND repo_id=?', id, a.id, a.repo_id);
  if (existing && (existing.sha256 !== digest || existing.size_bytes !== size)) throw new ApiError(409, 'snapshot_conflict', 'The immutable snapshot part already has different content.');
  if (existing?.state === 'sealed') { await request.body?.cancel(); return existing; }
  if (existing && ['deleting', 'deleted'].includes(existing.state)) throw new ApiError(410, 'snapshot_expired', 'The snapshot part is no longer available.');
  if (!a.reservation_id || !a.reservation_fence) throw new ApiError(409, 'storage_not_reserved', 'The attempt has no retained storage reservation.');
  const key = `execution/${a.account_id}/${a.repo_id}/${a.run_id}/${a.id}/g${a.generation}/remote-snapshots/${snapshotId}/${part}`;
  await reserveStorageObject(env, { account_id: a.account_id, reservation_id: a.reservation_id, fence: a.reservation_fence, object_id: id, key, bucket: 'blobs', maximum_bytes: String(size), retention_until: expires });
  if (!existing) await execute(db, `INSERT INTO execution_objects (id,repo_id,account_id,run_id,attempt_id,generation,kind,name,sequence,object_key,sha256,size_bytes,content_type,state,expires_at,created_at,source_digest,final)
    VALUES (?,?,?,?,?,?,'snapshot',?,0,?,?,?,?,'uploading',?,?,?,1)`, id, a.repo_id, a.account_id, a.run_id, a.id, a.generation, name, key, digest, size, part === 'metadata' ? 'application/json' : 'application/vnd.squashfs', expires, at, digest);
  const hash = createHash('sha256'); let received = 0;
  if (!request.body) throw new ApiError(422, 'snapshot_body_missing', 'The snapshot body is missing.');
  const body = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) { received += bytes.length; if (received > size || Date.now() >= Date.parse(a.deadline_at!)) throw new ApiError(413, 'snapshot_quota_exceeded', 'The snapshot exceeded its byte or lifetime allowance.'); hash.update(bytes); controller.enqueue(bytes); },
    flush() { if (received !== size || hash.digest('hex') !== digest) throw new ApiError(422, 'snapshot_checksum_mismatch', 'The snapshot bytes do not match the declared checksum.'); },
  }));
  await env.BLOBS.put(key, body, { sha256: fromHex(digest), customMetadata: { sha256: digest, attempt_id: a.id, generation: String(a.generation) } });
  const head = await env.BLOBS.head(key);
  if (!head || head.size !== size) throw new ApiError(503, 'snapshot_upload_unverified', 'The retained snapshot upload could not be verified.');
  await commitStorageObject(env, { account_id: a.account_id, reservation_id: a.reservation_id, fence: a.reservation_fence, object_id: id, bytes: String(size), etag: head.etag, checksum: digest });
  await guardedBatch(db, stmt(db, `UPDATE execution_objects SET state='sealed' WHERE id=? AND attempt_id=? AND generation=? AND state='uploading'
    AND EXISTS (SELECT 1 FROM execution_attempts a JOIN workflow_jobs j ON j.id=a.job_id WHERE a.id=? AND a.generation=? AND j.current_attempt_id=a.id AND j.generation=a.generation
      AND a.status='running' AND a.deadline_at>? AND a.lease_expires_at>?)`, id, a.id, a.generation, a.id, a.generation, now(), now()), [
    stmt(db, `UPDATE remote_execution_snapshots SET ${part === 'archive' ? 'archive_object_id' : 'metadata_object_id'}=? WHERE attempt_id=? AND repo_id=? AND generation=? AND snapshot_id=?`, id, a.id, a.repo_id, a.generation, snapshotId),
  ], { context: authority, event: { type: 'execution.remote_snapshot.stored', resource_id: id, resource_revision: 1, repo_id: a.repo_id, account_id: a.account_id,
    data: { attempt_id: a.id, generation: a.generation, snapshot_id: snapshotId, part } } });
  return (await one<ExecutionObject>(db, 'SELECT * FROM execution_objects WHERE id=? AND repo_id=?', id, a.repo_id))!;
}

export async function commitRemoteSnapshot(env: Bindings, context: AttemptContext, input: RemoteSnapshotCommit, authority: AppContext): Promise<RemoteCache> {
  const db = primary(env), a = context.attempt, row = await one<SnapshotRow>(db, 'SELECT * FROM remote_execution_snapshots WHERE attempt_id=? AND repo_id=? AND generation=?', a.id, a.repo_id, a.generation);
  if (!row || row.snapshot_id !== input.snapshot.id || row.archive_object_id !== input.archive_object_id || row.metadata_object_id !== input.metadata_object_id
    || input.snapshot.dir !== '/tmp/gitknot-snapshot' || input.snapshot.localBucket !== true) throw new ApiError(409, 'snapshot_identity_mismatch', 'The snapshot does not match the two retained SDK parts.');
  if (row.state === 'sealed' && (row.cache_key !== input.cache_key || row.snapshot_json !== JSON.stringify(input.snapshot))) throw new ApiError(409, 'snapshot_conflict', 'A published dependency snapshot is immutable.');
  const [archive, metadata] = await Promise.all([input.archive_object_id, input.metadata_object_id].map(id => one<ExecutionObject>(db, `SELECT * FROM execution_objects WHERE id=? AND attempt_id=? AND repo_id=? AND generation=? AND kind='snapshot' AND state='sealed' AND expires_at>?`, id, a.id, a.repo_id, a.generation, now())));
  if (!archive || !metadata) throw new ApiError(409, 'snapshot_incomplete', 'Both snapshot parts must be verified before publication.');
  const raw = await env.BLOBS.get(metadata.object_key);
  if (!raw) throw new ApiError(409, 'snapshot_incomplete', 'Snapshot metadata is unavailable.');
  const bytes = new Uint8Array(await raw.arrayBuffer());
  if (await sha256(bytes) !== metadata.sha256) throw new ApiError(409, 'snapshot_checksum_mismatch', 'Snapshot metadata failed integrity verification.');
  const info = JSON.parse(new TextDecoder().decode(bytes)) as { id: string; dir: string; sizeBytes: number; ttl: number; createdAt: string };
  if (info.id !== row.snapshot_id || info.dir !== input.snapshot.dir || info.sizeBytes !== archive.size_bytes || !Number.isInteger(info.ttl) || info.ttl < 1
    || info.ttl > snapshotRetention(context) || !Number.isFinite(Date.parse(info.createdAt))) throw new ApiError(422, 'snapshot_metadata_invalid', 'The SDK snapshot metadata exceeds its declared scope or retention.');
  const expires = new Date(Math.min(Date.parse(row.expires_at), Date.parse(info.createdAt) + info.ttl * 1000)).toISOString();
  if (expires <= now()) throw new ApiError(410, 'snapshot_expired', 'The SDK snapshot already expired.');
  if (input.cache_key && (!context.job.cache || context.job.cache.mode === 'read' || context.job.steps.some(step => step.secrets.length) || !/^[a-f0-9]{64}$/.test(input.cache_key))) throw new ApiError(403, 'cache_write_denied', 'This attempt may not publish a writable dependency cache.');
  const first = stmt(db, `UPDATE remote_execution_snapshots SET state='sealed',snapshot_json=?,cache_key=?,expires_at=? WHERE attempt_id=? AND repo_id=? AND generation=?
    AND EXISTS (SELECT 1 FROM execution_attempts a WHERE a.id=? AND a.generation=? AND a.status='running' AND a.lease_expires_at>? AND a.deadline_at>?)`, JSON.stringify(input.snapshot), input.cache_key, expires, a.id, a.repo_id, a.generation, a.id, a.generation, now(), now());
  const statements = [stmt(db, 'UPDATE execution_objects SET expires_at=? WHERE attempt_id=? AND repo_id=? AND id IN (?,?)', expires, a.id, a.repo_id, archive.id, metadata.id)];
  if (input.cache_key) statements.push(stmt(db, `INSERT INTO remote_execution_caches (namespace,cache_key,repo_id,account_id,snapshot_attempt_id,expires_at,created_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(namespace,cache_key) DO UPDATE SET snapshot_attempt_id=excluded.snapshot_attempt_id,expires_at=excluded.expires_at,created_at=excluded.created_at`, row.namespace, input.cache_key, a.repo_id, a.account_id, a.id, expires, now()));
  await guardedBatch(db, first, statements, { context: authority, event: { type: 'execution.remote_snapshot.published', resource_id: a.id, resource_revision: a.revision + 1, repo_id: a.repo_id, account_id: a.account_id,
    data: { snapshot_id: row.snapshot_id, generation: a.generation } } });
  return { snapshot: input.snapshot, archive: { object_id: archive.id, sha256: archive.sha256, size_bytes: archive.size_bytes }, metadata: { object_id: metadata.id, sha256: metadata.sha256, size_bytes: metadata.size_bytes }, expires_at: expires };
}

export async function getRemoteCache(env: Bindings, context: AttemptContext, key: string): Promise<RemoteCache | null> {
  if (!context.job.cache || !/^[a-f0-9]{64}$/.test(key)) throw new ApiError(403, 'cache_not_declared', 'The attempt has no matching declared cache.');
  const namespace = await remoteCacheNamespace(context);
  const row = await one<SnapshotRow>(primary(env), `SELECT s.* FROM remote_execution_caches c JOIN remote_execution_snapshots s ON s.attempt_id=c.snapshot_attempt_id
    JOIN execution_attempts a ON a.id=s.attempt_id AND a.repo_id=s.repo_id
    WHERE c.namespace=? AND c.cache_key=? AND c.repo_id=? AND c.account_id=? AND c.expires_at>? AND s.state='sealed' AND a.status='succeeded'`, namespace, key, context.run.repo_id, context.run.account_id, now());
  if (!row?.snapshot_json) return null;
  const parts = await many<ExecutionObject>(primary(env), `SELECT * FROM execution_objects WHERE attempt_id=? AND repo_id=? AND id IN (?,?) AND state='sealed' AND expires_at>?`, row.attempt_id, context.run.repo_id, row.archive_object_id, row.metadata_object_id, now());
  const archive = parts.find(part => part.id === row.archive_object_id), metadata = parts.find(part => part.id === row.metadata_object_id);
  if (!archive || !metadata) return null;
  return { snapshot: JSON.parse(row.snapshot_json) as RemoteCache['snapshot'], archive: { object_id: archive.id, sha256: archive.sha256, size_bytes: archive.size_bytes }, metadata: { object_id: metadata.id, sha256: metadata.sha256, size_bytes: metadata.size_bytes }, expires_at: row.expires_at };
}

export async function remoteCacheBody(env: Bindings, context: AttemptContext, objectId: string): Promise<Response> {
  const namespace = await remoteCacheNamespace(context);
  const object = await one<ExecutionObject>(primary(env), `SELECT o.* FROM remote_execution_caches c JOIN remote_execution_snapshots s ON s.attempt_id=c.snapshot_attempt_id
    JOIN execution_attempts a ON a.id=s.attempt_id AND a.repo_id=s.repo_id AND a.status='succeeded'
    JOIN execution_objects o ON o.id=s.archive_object_id OR o.id=s.metadata_object_id WHERE c.namespace=? AND c.repo_id=? AND c.account_id=? AND c.expires_at>?
      AND s.state='sealed' AND o.id=? AND o.repo_id=c.repo_id AND o.state='sealed' AND o.expires_at>?`, namespace, context.run.repo_id, context.run.account_id, now(), objectId, now());
  if (!object) throw new ApiError(404, 'cache_not_declared', 'The object is not in this attempt’s declared cache namespace.');
  const body = await env.BLOBS.get(object.object_key);
  if (!body) throw new ApiError(410, 'cache_expired', 'The cache object is no longer retained.');
  return new Response(body.body, { headers: { 'content-type': object.content_type, 'content-length': String(object.size_bytes), 'x-gitknot-content-sha256': object.sha256, 'cache-control': 'no-store' } });
}
