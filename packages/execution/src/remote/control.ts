import { ApiError, canonicalJson, execute, hmac, now, one, randomToken, readBounded, sha256, stmt } from '@gitknot/core';
import type { AppContext, Bindings } from '@gitknot/core';
import { assertActiveRepository, attemptContext, currentGeneration, guardedBatch, primary } from '../store.ts';
import { attemptRequest } from '../transport.ts';
import { remoteControlKey, remoteExecutor } from './config.ts';
import { grantDigest, remoteRuntimeId, signRemoteRequest, verifyRemoteStatus } from './protocol.ts';
import type { RemoteAttemptGrant, RemoteRuntimeStatus, SignedRemoteStatus } from './protocol.ts';
import type { AttemptContext } from '../types.ts';
import type { RunManifest } from '@gitknot/workflows';
import { assertCurrentReceipt } from '../state.ts';
import { authorizeExecutionActor, fenceExecutionAuthority } from '../authorization.ts';
import type { DestructionReceipt } from '../attempt-machine.ts';

export interface RemoteDispatch {
  attempt_id: string; repo_id: string; account_id: string; run_id: string; generation: number;
  executor_id: string; producer_id: string; origin: string; callback_origin: string; key_binding: string;
  callback_token_hash: string; callback_key_binding: string; grant_digest: string; grant_json: string; runtime_id: string; sandbox_id: string | null;
  state: 'pending' | 'accepted' | 'running' | 'destroyed' | 'failed'; draft_json: string | null; draft_hash: string | null;
  termination_json: string | null; created_at: string; updated_at: string;
}

export async function callbackToken(env: Bindings, context: AttemptContext, binding = typeof env.HOSTED_CALLBACK_KEY === 'string' ? 'HOSTED_CALLBACK_KEY' : 'INTERNAL_SERVICE_KEY'): Promise<string> {
  if (binding !== 'INTERNAL_SERVICE_KEY' && !/^HOSTED_CALLBACK_KEY(?:_[A-Z0-9]+)*$/.test(binding)) throw new ApiError(503, 'callback_key_unavailable', 'The retained callback key binding is invalid.');
  const key = env[binding];
  if (typeof key !== 'string' || new TextEncoder().encode(key).length < 32) throw new ApiError(503, 'callback_key_unavailable', 'The original callback key is unavailable.');
  return `ghc_${await hmac(key, canonicalJson({ purpose: 'GitKnot remote callback v1', attempt_id: context.attempt.id, generation: context.attempt.generation,
    plan_digest: context.attempt.plan_digest, producer_id: context.attempt.producer_id }))}`;
}

export async function remoteDispatch(env: Bindings, attemptId: string): Promise<RemoteDispatch> {
  const row = await one<RemoteDispatch>(primary(env), 'SELECT * FROM remote_execution_dispatches WHERE attempt_id=?', attemptId);
  if (!row) throw new ApiError(404, 'remote_attempt_not_found', 'This attempt has no remote execution grant.');
  return row;
}

export async function prepareRemoteDispatch(env: Bindings, context: AttemptContext, authority?: AppContext): Promise<RemoteDispatch> {
  const db = primary(env), a = context.attempt;
  const prior = await one<RemoteDispatch>(db, 'SELECT * FROM remote_execution_dispatches WHERE attempt_id=?', a.id);
  if (prior) return prior;
  authority ??= await authorizeExecutionActor(env, context.plan);
  const config = remoteExecutor(env);
  if (!config || context.job.remote_executor_id !== config.id || a.producer_id !== config.producer_id || a.execution_backend !== 'remote') throw new ApiError(409, 'remote_executor_changed', 'The remote executor differs from this immutable plan.');
  remoteControlKey(env, config.key_binding);
  if (!a.runtime_name || !a.runtime_id || !a.deadline_at || !a.lease_expires_at) throw new ApiError(409, 'remote_allocation_missing', 'A fenced allocation grant is required before remote dispatch.');
  const toolchain = (context.plan.portable_manifest as RunManifest).jobs.find(job => job.id === context.job.key)?.toolchain;
  if (!toolchain || toolchain.fingerprint !== context.job.toolchain.digest) throw new ApiError(409, 'toolchain_mismatch', 'The remote toolchain is not bound by the frozen manifest.');
  const callbackKey = config.callback_key_binding ?? (typeof env.HOSTED_CALLBACK_KEY === 'string' ? 'HOSTED_CALLBACK_KEY' : 'INTERNAL_SERVICE_KEY');
  const token = await callbackToken(env, context, callbackKey);
  const grant: RemoteAttemptGrant = { version: 1, executor_id: config.id, attempt_id: a.id, generation: a.generation, run_id: a.run_id, job_id: context.job.key,
    repo_id: a.repo_id, account_id: a.account_id, plan_digest: a.plan_digest, workflow_digest: context.run.workflow_digest, policy_revision: context.run.policy_revision,
    commit_sha: context.run.commit_sha, source_ref: context.run.source_ref, producer_id: a.producer_id, runtime_name: a.runtime_name,
    runtime_id: remoteRuntimeId(config.id, a.id, a.generation), deadline_at: a.deadline_at, lease_expires_at: a.lease_expires_at, job: context.job,
    toolchain: { os: toolchain.os, arch: toolchain.arch, tools: toolchain.tools, ...(toolchain.image ? { image: toolchain.image } : {}) }, callback: { origin: config.callback_origin, token } };
  if (grant.runtime_id !== a.runtime_id) throw new ApiError(409, 'runtime_identity_mismatch', 'The remote runtime differs from the admission grant.');
  const digest = await grantDigest(grant), at = now();
  const stored = { ...grant, callback: { origin: grant.callback.origin } };
  await guardedBatch(db, stmt(db, `INSERT INTO remote_execution_dispatches
    (attempt_id,repo_id,account_id,run_id,generation,executor_id,producer_id,origin,callback_origin,key_binding,callback_token_hash,callback_key_binding,grant_digest,grant_json,runtime_id,state,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,? WHERE EXISTS (SELECT 1 FROM execution_attempts a JOIN workflow_jobs j ON j.id=a.job_id
      WHERE a.id=? AND a.generation=? AND a.status IN ('leased','running') AND a.execution_backend='remote' AND j.current_attempt_id=a.id AND j.generation=a.generation)`,
  a.id, a.repo_id, a.account_id, a.run_id, a.generation, config.id, a.producer_id, config.origin, config.callback_origin, config.key_binding, await sha256(token), callbackKey, digest, JSON.stringify(stored), a.runtime_id, at, at, a.id, a.generation), [], {
    context: authority, event: { type: 'execution.remote_grant.created', resource_id: a.id, resource_revision: a.revision, repo_id: a.repo_id, account_id: a.account_id,
      data: { generation: a.generation, grant_digest: digest, executor_id: config.id } },
  });
  return remoteDispatch(env, a.id);
}

export async function remoteHttp(env: Bindings, origin: string, request: Request): Promise<Response> {
  // Explicit HTTP test transport keeps the two environments disjoint; production
  // always uses authenticated HTTPS, never a cross-account private binding.
  const transport = env.HOSTED_TEST_HTTP as Fetcher | undefined;
  if (transport && env.ENVIRONMENT === 'test') return transport.fetch(request);
  if (new URL(request.url).origin !== origin || new URL(origin).protocol !== 'https:') throw new ApiError(503, 'remote_origin_invalid', 'Remote execution requires the configured HTTPS origin.');
  return fetch(request);
}

async function invoke(env: Bindings, row: RemoteDispatch, action: 'accept' | 'status' | 'cancel', payload: unknown, challenge: string): Promise<RemoteRuntimeStatus> {
  const key = remoteControlKey(env, row.key_binding);
  const request = new Request(`${row.origin}/internal/hosted/attempts/${row.attempt_id}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(action === 'cancel' ? 45_000 : 20_000) });
  const response = await remoteHttp(env, row.origin, await signRemoteRequest(request, key));
  if (!response.ok) { await response.body?.cancel(); throw new ApiError(503, 'remote_execution_unavailable', 'The remote execution operation could not be confirmed.'); }
  let value: SignedRemoteStatus;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(response.body, 64 * 1024))) as SignedRemoteStatus; }
  catch { throw new ApiError(502, 'remote_status_unverified', 'The remote lifecycle response was not a bounded status receipt.'); }
  const grant = JSON.parse(row.grant_json) as RemoteAttemptGrant;
  const status = await verifyRemoteStatus(value, key, { executor_id: row.executor_id, producer_id: row.producer_id, deadline_at: grant.deadline_at, attempt_id: row.attempt_id, generation: row.generation,
    grant_digest: row.grant_digest, runtime_id: row.runtime_id, challenge });
  if (!/^[a-f0-9]{64}$/.test(status.sandbox_id) || (row.sandbox_id && row.sandbox_id !== status.sandbox_id)) throw new ApiError(502, 'remote_runtime_changed', 'The remote Sandbox identity changed for an existing allocation.');
  for (const quantity of [status.egress_bytes, status.egress_requests, status.in_flight, status.ephemeral_objects]) if (!Number.isSafeInteger(quantity) || quantity < 0) throw new ApiError(502, 'remote_metrics_invalid', 'The remote runtime returned invalid bounded counters.');
  const pinned = await execute(primary(env), `UPDATE remote_execution_dispatches SET sandbox_id=COALESCE(sandbox_id,?),state=CASE WHEN state='destroyed' THEN state ELSE ? END,updated_at=?
    WHERE attempt_id=? AND generation=? AND grant_digest=? AND (sandbox_id IS NULL OR sandbox_id=?)`,
    status.sandbox_id, status.state === 'destroyed' ? 'destroyed' : status.state === 'running' ? 'running' : status.state === 'failed' ? 'failed' : 'accepted', now(), row.attempt_id, row.generation, row.grant_digest, status.sandbox_id);
  if (pinned.meta.changes !== 1) throw new ApiError(502, 'remote_runtime_changed', 'A different Sandbox was already pinned for this allocation.');
  await execute(primary(env), `UPDATE execution_attempts SET egress_bytes=MAX(egress_bytes,?),egress_requests=MAX(egress_requests,?) WHERE id=? AND repo_id=? AND generation=?`, status.egress_bytes, status.egress_requests, row.attempt_id, row.repo_id, row.generation);
  return status;
}

export async function dispatchRemoteAttempt(env: Bindings, context: AttemptContext): Promise<RemoteRuntimeStatus> {
  const a = context.attempt;
  assertCurrentReceipt(a, { attempt_id: a.id, generation: a.generation, plan_digest: a.plan_digest, runner_id: a.producer_id }, await currentGeneration(primary(env), a));
  await assertActiveRepository(primary(env), context);
  const authority = await authorizeExecutionActor(env, context.plan);
  await fenceExecutionAuthority(env, context, authority, 'remote-dispatch');
  const row = await prepareRemoteDispatch(env, context, authority), token = await callbackToken(env, context, row.callback_key_binding);
  if (await sha256(token) !== row.callback_token_hash) throw new ApiError(503, 'callback_key_changed', 'The original callback signing key is required to recover this dispatch.');
  const grant = JSON.parse(row.grant_json) as RemoteAttemptGrant;
  grant.callback.token = token;
  if (await grantDigest(grant) !== row.grant_digest) throw new ApiError(409, 'remote_grant_changed', 'The durable remote grant failed integrity verification.');
  const result = await invoke(env, row, 'accept', grant, row.grant_digest);
  await execute(primary(env), 'UPDATE remote_execution_dispatches SET last_dispatch_at=?,updated_at=? WHERE attempt_id=?', now(), now(), row.attempt_id);
  return result;
}

export async function inspectRemoteAttempt(env: Bindings, attemptId: string, cancel = false): Promise<RemoteRuntimeStatus> {
  const row = await remoteDispatch(env, attemptId), challenge = randomToken();
  return invoke(env, row, cancel ? 'cancel' : 'status', { generation: row.generation, grant_digest: row.grant_digest, challenge, ...(cancel ? { reason: 'GitKnot attempt termination.' } : {}) }, challenge);
}

export async function verifyRemoteDestruction(env: Bindings, attemptId: string, cancel = false): Promise<import('../attempt-machine.ts').DestructionReceipt> {
  const context = await attemptContext(primary(env), attemptId), a = context.attempt;
  if (a.execution_backend !== 'remote') throw new ApiError(409, 'executor_mismatch', 'This is not a remote hosted allocation.');
  const dispatch = await one<RemoteDispatch>(primary(env), 'SELECT * FROM remote_execution_dispatches WHERE attempt_id=? AND generation=?', a.id, a.generation);
  if (!dispatch && cancel) return neverDispatched(env, context);
  const status = await inspectRemoteAttempt(env, attemptId, cancel);
  if (status.state !== 'destroyed' || !status.sealed || status.running !== false || status.in_flight !== 0 || status.ephemeral_objects !== 0
    || !status.destroyed_at || !status.receipt_id || Date.parse(status.destroyed_at) < Date.parse(status.accepted_at)
    || Date.parse(status.destroyed_at) > Date.now() + 30_000) throw new ApiError(503, 'destruction_unverified', 'Remote process, SDK, or ephemeral-object cleanup has not been verified.');
  const verifiedAt = now();
  const previous = await one<{ receipt_id: string; state: string; destroyed_at: string }>(primary(env), 'SELECT receipt_id,state,destroyed_at FROM execution_runtime_receipts WHERE runtime_id=? AND attempt_id=? AND generation=?', a.runtime_id, a.id, a.generation);
  if (previous?.state === 'destroyed' && previous.receipt_id !== status.receipt_id) throw new ApiError(502, 'remote_runtime_changed', 'The remote executor changed its immutable destruction receipt.');
  const receipt = { attempt_id: a.id, generation: a.generation, runtime_id: a.runtime_id!, receipt_id: status.receipt_id, destroyed_at: previous?.state === 'destroyed' ? previous.destroyed_at : verifiedAt, running: false as const, sealed: true as const };
  await primary(env).batch([
    stmt(primary(env), `INSERT INTO execution_runtime_receipts (runtime_id,attempt_id,repo_id,account_id,generation,receipt_id,state,armed_at,destroyed_at,updated_at)
      VALUES (?,?,?,?,?,?,'destroyed',?,?,?) ON CONFLICT(runtime_id) DO UPDATE SET state='destroyed',receipt_id=excluded.receipt_id,destroyed_at=COALESCE(execution_runtime_receipts.destroyed_at,excluded.destroyed_at),updated_at=excluded.updated_at`,
      receipt.runtime_id, a.id, a.repo_id, a.account_id, a.generation, receipt.receipt_id, a.allocated_at ?? verifiedAt, receipt.destroyed_at, verifiedAt),
    stmt(primary(env), 'UPDATE remote_execution_dispatches SET termination_json=?,state=?,updated_at=? WHERE attempt_id=? AND generation=?', JSON.stringify(status), 'destroyed', verifiedAt, a.id, a.generation),
  ]);
  return receipt;
}

/** Cancellation + absence of a dispatch journal proves that no remote send was permitted. */
async function neverDispatched(env: Bindings, context: AttemptContext): Promise<DestructionReceipt> {
  const db = primary(env), a = context.attempt, at = now();
  const receipt: DestructionReceipt = { attempt_id: a.id, generation: a.generation, runtime_id: a.runtime_id!, receipt_id: `never-dispatched:${a.id}:${a.generation}`,
    destroyed_at: at, running: false, sealed: true, proof_kind: 'never_allocated' };
  await guardedBatch(db, stmt(db, `UPDATE execution_attempts SET cleanup_state='verified',destruction_verified_at=COALESCE(destruction_verified_at,?),updated_at=?
    WHERE id=? AND repo_id=? AND generation=? AND runtime_id=? AND status='cancelling' AND execution_started_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM remote_execution_dispatches WHERE attempt_id=execution_attempts.id)`, at, at, a.id, a.repo_id, a.generation, a.runtime_id), [
    stmt(db, `INSERT INTO execution_runtime_receipts(runtime_id,attempt_id,repo_id,account_id,generation,receipt_id,state,armed_at,destroyed_at,updated_at,proof_kind)
      VALUES (?,?,?,?,?,?,'destroyed',?,?,?,'never_allocated') ON CONFLICT(runtime_id) DO NOTHING`, a.runtime_id, a.id, a.repo_id, a.account_id, a.generation, receipt.receipt_id, a.allocated_at ?? at, at, at),
  ], { event: { type: 'execution.remote.never_dispatched', resource_id: a.id, resource_revision: a.revision, repo_id: a.repo_id, account_id: a.account_id, data: { generation: a.generation, runtime_id: a.runtime_id } } });
  const stored = await one<{ destroyed_at: string }>(db, 'SELECT destroyed_at FROM execution_runtime_receipts WHERE runtime_id=? AND receipt_id=? AND proof_kind=?', a.runtime_id, receipt.receipt_id, 'never_allocated');
  if (!stored) throw new ApiError(503, 'destruction_unverified', 'The undispatched allocation fence was not confirmed.');
  return { ...receipt, destroyed_at: stored.destroyed_at };
}
