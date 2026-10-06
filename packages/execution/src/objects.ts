import { createHash } from 'node:crypto';
import { commitStorageObject, reserveStorageObject } from '@gitknot/billing';
import { ApiError, fromHex, many, newId, now, one, sha256, stmt } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import { EXECUTION_LIMITS } from './config.ts';
import { assertCurrentReceipt } from './state.ts';
import { attemptContext, currentGeneration, guardedBatch, primary } from './store.ts';
import { attemptRequest } from './transport.ts';
import type { AttemptContext, AttemptIdentity, ExecutionObject } from './types.ts';
import { authorizeExecutionActor, fenceExecutionAuthority, fenceMachineAuthority, machineAuthorityStatements } from './authorization.ts';
import type { RunnerAuthorityWitness } from './runner-authority.ts';

export interface ObjectRequest extends AttemptIdentity {
  kind: 'log' | 'output' | 'manifest';
  name: string;
  sequence: number;
  size_bytes: number;
  sha256: string;
  source_digest?: string;
  source_size_bytes?: number;
  machine_authority?: RunnerAuthorityWitness;
  content_type: string;
  retention_seconds: number;
  final?: boolean;
}

export async function reserveObject(env: Bindings, request: ObjectRequest): Promise<ExecutionObject> {
  const db = primary(env);
  const context = await attemptContext(db, request.attempt_id);
  assertCurrentReceipt(context.attempt, request, await currentGeneration(db, context.attempt));
  if (context.run.status === 'cancelling') throw new ApiError(409, 'attempt_fenced', 'This run is cancelling.');
  const authority = await authorizeExecutionActor(env, context.plan);
  await fenceExecutionAuthority(env, context, authority, 'upload-reservation');
  context.machine_authority = request.machine_authority;
  await fenceMachineAuthority(env, context, 'upload-reservation');
  validateObjectRequest(context, request);
  const existing = await one<ExecutionObject>(db, 'SELECT * FROM execution_objects WHERE attempt_id=? AND repo_id=? AND kind=? AND name=? AND sequence=?', request.attempt_id, context.attempt.repo_id, request.kind, request.name, request.sequence);
  if (existing) {
    if (existing.sha256 !== request.sha256 || existing.size_bytes !== request.size_bytes || existing.source_digest !== (request.source_digest ?? null)
      || existing.source_size_bytes !== (request.source_size_bytes ?? null)) throw new ApiError(409, 'chunk_conflict', 'The chunk identity already has different content.');
    if (['deleting', 'deleted'].includes(existing.state)) throw new ApiError(410, 'chunk_deleted', 'The chunk has expired.');
    return existing;
  }
  if (request.kind !== 'manifest') {
    const completed = await one(db, `SELECT id FROM execution_objects WHERE attempt_id=? AND repo_id=? AND kind='manifest' AND name=? AND state IN ('uploading','sealed')`,
      request.attempt_id, context.attempt.repo_id, request.kind === 'log' ? 'logs' : `output:${request.name}`);
    const finalized = request.kind === 'output' && await one(db, `SELECT id FROM execution_objects WHERE attempt_id=? AND repo_id=? AND kind='output' AND name=? AND final=1 AND state IN ('uploading','sealed')`, request.attempt_id, context.attempt.repo_id, request.name);
    if (completed || finalized) throw new ApiError(409, 'object_finalized', 'Finalized output content cannot receive additional chunks.');
  }
  const identityHash = await sha256(`${request.attempt_id}:${request.kind}:${request.name}:${request.sequence}`);
  const id = `obj_${identityHash.slice(0, 32)}`;
  const key = `execution/${context.attempt.account_id}/${context.attempt.repo_id}/${context.attempt.run_id}/${request.attempt_id}/g${request.generation}/${request.kind}/${identityHash}`;
  const at = now();
  const expires = new Date(Date.now() + request.retention_seconds * 1000).toISOString();
  const a = context.attempt;
  if (!a.reservation_id || !a.reservation_fence) throw new ApiError(409, 'storage_not_reserved', 'The attempt has no storage reservation.');
  await reserveStorageObject(env, { account_id: a.account_id, reservation_id: a.reservation_id, fence: a.reservation_fence,
    object_id: id, key, bucket: 'blobs', maximum_bytes: String(request.size_bytes), retention_until: expires });
  const maximum = request.kind === 'log' ? context.job.limits?.log_bytes ?? EXECUTION_LIMITS.log_bytes
    : request.kind === 'output' ? context.job.limits?.output_bytes ?? EXECUTION_LIMITS.output_bytes : 1024 * 1024;
  await guardedBatch(db, stmt(db, `INSERT INTO execution_objects
    (id,repo_id,account_id,run_id,attempt_id,generation,kind,name,sequence,object_key,sha256,size_bytes,content_type,state,expires_at,created_at,source_digest,source_size_bytes,final)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,'uploading',?,?,?,?,?
    WHERE (SELECT COALESCE(SUM(size_bytes),0) FROM execution_objects WHERE attempt_id=? AND kind=? AND state!='deleted')+?<=?
      AND (SELECT COALESCE(SUM(size_bytes),0) FROM execution_objects WHERE attempt_id=? AND kind=? AND name=? AND state!='deleted')+?<=?
      AND EXISTS (SELECT 1 FROM execution_attempts WHERE id=? AND repo_id=? AND generation=? AND status IN ('leased','running') AND lease_expires_at>? AND deadline_at>?)`,
  id, a.repo_id, a.account_id, a.run_id, a.id, a.generation, request.kind, request.name, request.sequence, key, request.sha256,
  request.size_bytes, request.content_type, expires, at, request.source_digest ?? null, request.source_size_bytes ?? null, request.final ? 1 : 0,
  a.id, request.kind, request.size_bytes, maximum, a.id, request.kind, request.name, request.size_bytes,
   request.kind === 'output' ? context.job.outputs[request.name]!.max_bytes : maximum, a.id, a.repo_id, a.generation, at, at), await machineAuthorityStatements(env, context, request.machine_authority, 'object-reserved'), {
    context: authority, event: { type: 'execution.object.reserved', resource_id: id, resource_revision: 1, repo_id: a.repo_id, account_id: a.account_id, data: { attempt_id: a.id, generation: a.generation } },
  });
  const result = await one<ExecutionObject>(db, 'SELECT * FROM execution_objects WHERE id=? AND repo_id=?', id, a.repo_id);
  if (!result) throw new Error('The reserved object could not be read.');
  return result;
}

function validateObjectRequest(context: AttemptContext, request: ObjectRequest): void {
  if (!/^[a-f0-9]{64}$/.test(request.sha256) || !Number.isSafeInteger(request.size_bytes) || request.size_bytes < 0
    || request.source_size_bytes !== undefined && (!Number.isSafeInteger(request.source_size_bytes) || request.source_size_bytes < 0 || request.source_size_bytes > EXECUTION_LIMITS.log_chunk_bytes)
    || !Number.isSafeInteger(request.sequence) || request.sequence < 0 || request.sequence >= 65536
    || request.retention_seconds < 1 || request.retention_seconds > EXECUTION_LIMITS.max_retention_seconds) throw new ApiError(422, 'invalid_chunk', 'Invalid chunk checksum, size, sequence, or retention.');
  if (request.kind !== 'manifest' && request.size_bytes > (context.job.limits?.chunk_bytes ?? EXECUTION_LIMITS.log_chunk_bytes)) throw new ApiError(413, 'chunk_too_large', 'The chunk exceeds the streaming upload limit.');
  if (request.kind === 'manifest' && request.size_bytes > 1024 * 1024) throw new ApiError(413, 'manifest_too_large', 'The output manifest exceeds the metadata limit.');
  if (request.kind === 'output' && !Object.hasOwn(context.job.outputs, request.name)) throw new ApiError(403, 'undeclared_output', 'The output is not declared by this immutable job.');
  if (request.kind === 'log' && request.name !== 'combined') throw new ApiError(422, 'invalid_log_stream', 'Logs use one immutable attempt-wide sequence.');
  if (request.kind === 'manifest' && request.name !== 'logs' && !request.name.startsWith('output:')) throw new ApiError(422, 'invalid_manifest', 'Unknown execution manifest.');
}

export async function sealObject(env: Bindings, identity: AttemptIdentity, objectId: string, machineAuthority?: RunnerAuthorityWitness): Promise<ExecutionObject> {
  const db = primary(env);
  const context = await attemptContext(db, identity.attempt_id);
  assertCurrentReceipt(context.attempt, identity, await currentGeneration(db, context.attempt));
  if (context.run.status === 'cancelling') throw new ApiError(409, 'attempt_fenced', 'This run is cancelling.');
  const authority = await authorizeExecutionActor(env, context.plan);
  const object = await one<ExecutionObject>(db, 'SELECT * FROM execution_objects WHERE id=? AND attempt_id=? AND repo_id=? AND generation=?', objectId, identity.attempt_id, context.attempt.repo_id, identity.generation);
  if (!object || ['deleted', 'deleting'].includes(object.state)) throw new ApiError(404, 'not_found', 'The reserved object was not found.');
  await fenceExecutionAuthority(env, context, authority, 'upload-finalization');
  const head = await env.BLOBS.head(object.object_key);
  if (!head || head.size !== object.size_bytes || head.customMetadata?.sha256 !== object.sha256) throw new ApiError(409, 'upload_incomplete', 'The uploaded object has not passed checksum verification.');
  const a = context.attempt;
  await commitStorageObject(env, { account_id: a.account_id, reservation_id: a.reservation_id!, fence: a.reservation_fence!, object_id: object.id,
    bytes: String(head.size), etag: head.etag, checksum: object.sha256 });
  if (object.state !== 'sealed') await guardedBatch(db, stmt(db, `UPDATE execution_objects SET state='sealed' WHERE id=? AND repo_id=? AND state='uploading'
    AND EXISTS (SELECT 1 FROM execution_attempts WHERE id=? AND generation=? AND status IN ('leased','running') AND lease_expires_at>? AND deadline_at>?)`, object.id, object.repo_id, a.id, a.generation, now(), now()), await machineAuthorityStatements(env, context, machineAuthority, 'object-sealed'), {
    context: authority, event: { type: 'execution.object.sealed', resource_id: object.id, resource_revision: 1, repo_id: a.repo_id, account_id: a.account_id, data: { run_id: a.run_id, attempt_id: a.id, kind: object.kind } },
  });
  return { ...object, state: 'sealed' };
}

/** Backpressure and incremental hashing bound isolate memory, including unknown-length sources. */
export async function putObjectStream(env: Bindings, request: ObjectRequest, source: ReadableStream<Uint8Array>): Promise<ExecutionObject> {
  const object = await attemptRequest<ExecutionObject>(env, request.attempt_id, 'reserve-object', request);
  if (object.state === 'sealed') { await source.cancel(); return object; }
  const hash = createHash('sha256');
  let bytes = 0;
  const checked = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > request.size_bytes) throw new ApiError(413, 'upload_quota_exceeded', 'The stream exceeded its reserved byte limit.');
      hash.update(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      if (bytes !== request.size_bytes || hash.digest('hex') !== request.sha256) throw new ApiError(422, 'checksum_mismatch', 'The upload does not match its declared checksum and size.');
    },
  }));
  try {
    await env.BLOBS.put(object.object_key, checked, { sha256: fromHex(request.sha256), customMetadata: { sha256: request.sha256, attempt_id: request.attempt_id, generation: String(request.generation) },
      httpMetadata: { contentType: request.content_type } });
    return await attemptRequest<ExecutionObject>(env, request.attempt_id, 'seal-object', { identity: request, object_id: object.id, machine_authority: request.machine_authority });
  } catch (error) {
    // A raced cancellation may leave a physically stored but unaccepted object.
    // Retention/recovery deletes it; its billing hold is not released prematurely.
    throw error;
  }
}

export function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

export async function putObjectBytes(env: Bindings, request: Omit<ObjectRequest, 'size_bytes' | 'sha256'>, bytes: Uint8Array): Promise<ExecutionObject> {
  return putObjectStream(env, { ...request, size_bytes: bytes.length, sha256: await sha256(bytes) }, byteStream(bytes));
}

export interface OutputManifest {
  version: 1;
  repo_id: string;
  run_id: string;
  attempt_id: string;
  generation: number;
  plan_digest: string;
  commit_sha: string;
  toolchain_digest: string;
  name: string;
  kind: 'logs' | 'output';
  digest: string;
  size_bytes: number;
  chunks: Array<{ id: string; sequence: number; sha256: string; size_bytes: number }>;
}

export async function completeObjectManifest(env: Bindings, identity: AttemptIdentity, name: string, kind: 'logs' | 'output', expectedDigest?: string, machineAuthority?: RunnerAuthorityWitness): Promise<ExecutionObject> {
  const context = await attemptContext(primary(env), identity.attempt_id);
  const chunkKind = kind === 'logs' ? 'log' : 'output';
  const chunkName = kind === 'logs' ? 'combined' : name;
  const chunks = await many<ExecutionObject>(primary(env), `SELECT * FROM execution_objects WHERE attempt_id=? AND repo_id=? AND generation=? AND kind=? AND name=? ORDER BY sequence`,
    identity.attempt_id, context.attempt.repo_id, identity.generation, chunkKind, chunkName);
  if (chunks.some((chunk, index) => chunk.sequence !== index || chunk.state !== 'sealed')) throw new ApiError(409, 'chunks_incomplete', 'Chunk sequences must be complete and contiguous before finalization.');
  if (kind === 'output' && (!chunks.length || !chunks.at(-1)?.final)) throw new ApiError(409, 'output_incomplete', 'The final output chunk is missing.');
  const digest = createHash('sha256');
  let bytes = 0;
  for (const chunk of chunks) {
    const object = await env.BLOBS.get(chunk.object_key);
    if (!object || object.size !== chunk.size_bytes) throw new ApiError(409, 'chunk_missing', 'A completed chunk is missing from durable storage.');
    const reader = object.body.getReader();
    const chunkHash = createHash('sha256');
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        digest.update(result.value); chunkHash.update(result.value); bytes += result.value.byteLength;
        if (bytes > (kind === 'logs' ? EXECUTION_LIMITS.log_bytes : EXECUTION_LIMITS.output_bytes)) throw new ApiError(413, 'output_quota_exceeded', 'The complete object exceeded its byte quota.');
      }
    } finally { reader.releaseLock(); }
    if (chunkHash.digest('hex') !== chunk.sha256) throw new ApiError(409, 'stored_checksum_mismatch', 'A stored chunk failed integrity verification.');
  }
  const contentDigest = digest.digest('hex');
  if (expectedDigest && contentDigest !== expectedDigest.replace(/^sha256:/, '')) throw new ApiError(409, 'output_checksum_mismatch', 'The assembled output does not match the completion receipt.');
  const manifest: OutputManifest = { version: 1, repo_id: context.attempt.repo_id, run_id: context.attempt.run_id, attempt_id: identity.attempt_id,
    generation: identity.generation, plan_digest: context.attempt.plan_digest, commit_sha: context.run.commit_sha, toolchain_digest: context.attempt.toolchain_digest,
    name, kind, digest: `sha256:${contentDigest}`, size_bytes: bytes, chunks: chunks.map(chunk => ({ id: chunk.id, sequence: chunk.sequence, sha256: chunk.sha256, size_bytes: chunk.size_bytes })) };
  return putObjectBytes(env, { ...identity, kind: 'manifest', name: kind === 'logs' ? 'logs' : `output:${name}`, sequence: 0, content_type: 'application/vnd.gitknot.manifest+json',
    retention_seconds: kind === 'logs' ? EXECUTION_LIMITS.log_retention_seconds : context.job.outputs[name]!.retention_seconds, source_digest: contentDigest, final: true, machine_authority: machineAuthority }, new TextEncoder().encode(JSON.stringify(manifest)));
}

export async function streamManifest(env: Bindings, manifestObject: ExecutionObject): Promise<ReadableStream<Uint8Array>> {
  const raw = await env.BLOBS.get(manifestObject.object_key);
  if (!raw) throw new ApiError(410, 'output_expired', 'The retained output is no longer available.');
  const bytes = new Uint8Array(await raw.arrayBuffer());
  if (await sha256(bytes) !== manifestObject.sha256) throw new ApiError(503, 'manifest_corrupt', 'The output manifest failed integrity verification.');
  const manifest = JSON.parse(new TextDecoder().decode(bytes)) as OutputManifest;
  let index = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let currentHash = createHash('sha256');
  let currentExpected = '';
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          if (!reader) {
            const chunk = manifest.chunks[index++];
            if (!chunk) { controller.close(); return; }
            const row = await one<ExecutionObject>(primary(env), `SELECT * FROM execution_objects WHERE id=? AND repo_id=? AND attempt_id=? AND generation=? AND state='sealed' AND expires_at>?`,
              chunk.id, manifestObject.repo_id, manifestObject.attempt_id, manifestObject.generation, now());
            if (!row || row.sha256 !== chunk.sha256) throw new ApiError(410, 'output_expired', 'An output chunk is unavailable.');
            const body = await env.BLOBS.get(row.object_key);
            if (!body) throw new ApiError(410, 'output_expired', 'An output chunk is unavailable.');
            reader = body.body.getReader(); currentHash = createHash('sha256'); currentExpected = row.sha256;
          }
          const value = await reader.read();
          if (!value.done) { currentHash.update(value.value); controller.enqueue(value.value); return; }
          reader.releaseLock(); reader = null;
          if (currentHash.digest('hex') !== currentExpected) throw new ApiError(503, 'output_corrupt', 'An output chunk failed integrity verification.');
        }
      } catch (error) { await reader?.cancel(error); controller.error(error); }
    },
    async cancel(reason) { await reader?.cancel(reason); },
  });
}
