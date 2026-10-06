import { ApiError, execute, now, one, readBounded, sha256 } from '@gitknot/core';
import type { AppContext, Bindings } from '@gitknot/core';
import { resolveAttemptSecrets } from '@gitknot/secrets';
import { z } from 'zod';
import { authorizeExecutionActor, fenceExecutionAuthority } from '../authorization.ts';
import { checkoutCapability, revokeCheckout } from '../checkout.ts';
import { withEnvironmentSecrets } from '../environments.ts';
import { completeObjectManifest } from '../objects.ts';
import { receiptIdentity, storeAttemptLog, storeAttemptOutput } from '../runner-receipts.ts';
import { assertCurrentReceipt, TERMINAL_ATTEMPTS } from '../state.ts';
import { assertActiveRepository, attemptContext, currentGeneration, primary } from '../store.ts';
import { attemptRequest } from '../transport.ts';
import type { AttemptContext, CompletionReceipt, ExecutionObject } from '../types.ts';
import { remoteDispatch, verifyRemoteDestruction } from './control.ts';
import type { RemoteDispatch } from './control.ts';
import { verifyCallbackRequest } from './protocol.ts';
import { commitRemoteSnapshot, getRemoteCache, receiveRemoteSnapshot, remoteCacheBody, remoteInputBody, remoteInputs } from './storage.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/), identifier = z.string().min(1).max(256);
const identity = { generation: z.number().int().positive(), plan_digest: digest };
const chunk = { sequence: z.number().int().min(0).max(65535), data_base64: z.string().max(349528).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/), sha256: digest, size_bytes: z.number().int().min(0).max(262144) };
const receiptSchema = z.object({ attempt_id: identifier, generation: z.number().int().positive(), plan_digest: digest, runner_id: identifier,
  protocol_receipt_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), conclusion: z.enum(['succeeded', 'failed', 'cancelled', 'timed_out', 'infrastructure_failed']),
  exit_code: z.number().int().nullable(), signal: z.string().max(64).nullable(), resource_exhaustion: z.enum(['memory', 'disk', 'processes', 'logs', 'outputs', 'egress']).nullable(),
  toolchain_digest: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/), outputs: z.array(z.object({ name: identifier, sha256: digest, size_bytes: z.number().int().nonnegative() }).strict()).max(128),
  log_manifest_digest: digest, process_group_stopped: z.boolean(), started_at: z.iso.datetime(), finished_at: z.iso.datetime(),
}).strict();

const actionSchemas = {
  begin: z.object(identity).strict(),
  heartbeat: z.object({ ...identity, egress_bytes: z.number().int().nonnegative(), egress_requests: z.number().int().nonnegative() }).strict(),
  'checkout-complete': z.object(identity).strict(),
  process: z.object({ ...identity, process_id: identifier }).strict(),
  secrets: z.object({ ...identity, step_id: identifier, names: z.array(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/)).max(64) }).strict(),
  log: z.object({ ...identity, ...chunk }).strict(),
  output: z.object({ ...identity, ...chunk, name: identifier, final: z.boolean(), content_type: z.string().max(128) }).strict(),
  'log-manifest': z.object(identity).strict(),
  'output-manifest': z.object({ ...identity, name: identifier, sha256: digest }).strict(),
  checkpoint: z.object({ ...identity, receipt: receiptSchema }).strict(),
  complete: z.object({ ...identity, receipt: receiptSchema }).strict(),
  destroyed: z.object(identity).strict(),
  'cache-get': z.object({ ...identity, cache_key: digest }).strict(),
  'snapshot-commit': z.object({ ...identity, snapshot: z.object({ id: z.string().regex(/^[a-f0-9-]{36}$/), dir: z.literal('/tmp/gitknot-snapshot'), localBucket: z.literal(true) }).strict(),
    archive_object_id: identifier, metadata_object_id: identifier, cache_key: digest.nullable() }).strict(),
} as const;

export interface AuthenticatedRemoteCallback { context: AttemptContext; dispatch: RemoteDispatch; authority?: AppContext }

export async function authenticateRemoteCallback(env: Bindings, request: Request, attemptId: string, input: { generation: number; plan_digest: string }, allowClosed = false, streaming = false): Promise<AuthenticatedRemoteCallback> {
  const token = /^Bearer (ghc_[A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token) throw new ApiError(401, 'remote_callback_unauthorized', 'An attempt-scoped remote capability is required.');
  const row = await remoteDispatch(env, attemptId);
  if (await sha256(token) !== row.callback_token_hash || new URL(request.url).origin !== row.callback_origin) throw new ApiError(401, 'remote_callback_unauthorized', 'The remote callback capability does not match this attempt.');
  const context = await attemptContext(primary(env), attemptId), a = context.attempt;
  const grant = JSON.parse(row.grant_json) as { plan_digest: string };
  if (a.execution_backend !== 'remote' || a.remote_executor_id !== row.executor_id || a.producer_id !== row.producer_id || a.runtime_id !== row.runtime_id
    || input.generation !== a.generation || input.generation !== row.generation || input.plan_digest !== a.plan_digest || grant.plan_digest !== a.plan_digest) {
    throw new ApiError(409, 'attempt_fenced', 'The remote callback is not bound to the current immutable allocation.');
  }
  let authority: AppContext | undefined;
  if (!allowClosed) {
    if (a.cleanup_state === 'verified') throw new ApiError(409, 'attempt_fenced', 'The remote runtime is already closed.');
    assertCurrentReceipt(a, receiptIdentity(context), await currentGeneration(primary(env), a));
    if (context.run.status === 'cancelling') throw new ApiError(409, 'attempt_fenced', 'The run is cancelling.');
    await assertActiveRepository(primary(env), context);
    authority = await authorizeExecutionActor(env, context.plan);
  }
  await verifyCallbackRequest(request, token, streaming);
  return { context, dispatch: row, authority };
}

function storedObject(object: ExecutionObject) { return { id: object.id, sha256: object.sha256, source_digest: object.source_digest, size_bytes: object.size_bytes }; }

/** No callback can submit SQL, an ACL, an actor, an arbitrary key, or a new job. */
export async function handleRemoteCallback(request: Request, env: Bindings): Promise<Response> {
  const url = new URL(request.url), match = /^\/internal\/hosted\/attempts\/(att_[a-zA-Z0-9_-]+)\/([a-z-]+)$/.exec(url.pathname);
  if (!match) throw new ApiError(404, 'not_found', 'The remote callback route was not found.');
  const [, attemptId, action] = match;
  if (!/^Bearer ghc_[A-Za-z0-9_-]{43}$/.test(request.headers.get('authorization') ?? '')) throw new ApiError(401, 'remote_callback_unauthorized', 'An attempt-scoped remote capability is required.');
  if (action === 'snapshot-upload') {
    if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Snapshot uploads require POST.');
    const fields = z.object(identity).parse({ generation: Number(request.headers.get('x-gitknot-generation')), plan_digest: request.headers.get('x-gitknot-plan-digest') });
    for (const [query, header] of [['generation', 'x-gitknot-generation'], ['plan_digest', 'x-gitknot-plan-digest'], ['snapshot_id', 'x-gitknot-snapshot-id'], ['snapshot_part', 'x-gitknot-snapshot-part']] as const) {
      if (!url.searchParams.get(query) || url.searchParams.get(query) !== request.headers.get(header)) throw new ApiError(401, 'snapshot_signature_context', 'Snapshot identity must match the signed URL context.');
    }
    const { context, authority } = await authenticateRemoteCallback(env, request, attemptId!, fields, false, true);
    await fenceExecutionAuthority(env, context, authority!, 'remote-snapshot-upload');
    return Response.json(storedObject(await receiveRemoteSnapshot(env, context, request, authority!)));
  }
  if (action === 'input' || action === 'cache-read') {
    if (request.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'Input reads require GET.');
    const fields = z.object({ ...identity, object_id: identifier }).strict().parse({ generation: Number(url.searchParams.get('generation')), plan_digest: url.searchParams.get('plan_digest'), object_id: url.searchParams.get('object_id') });
    const { context, authority } = await authenticateRemoteCallback(env, request, attemptId!, fields);
    await fenceExecutionAuthority(env, context, authority!, 'remote-input-read');
    return action === 'input' ? remoteInputBody(env, context, fields.object_id) : remoteCacheBody(env, context, fields.object_id);
  }
  if (request.method !== 'POST' || !Object.hasOwn(actionSchemas, action!)) throw new ApiError(404, 'not_found', 'The remote callback operation is not supported.');
  const schema = actionSchemas[action as keyof typeof actionSchemas];
  const row = await remoteDispatch(env, attemptId!);
  const trustedIdentity = { generation: row.generation, plan_digest: (JSON.parse(row.grant_json) as { plan_digest: string }).plan_digest };
  const authorized = await authenticateRemoteCallback(env, request, attemptId!, trustedIdentity, action === 'destroyed' || action === 'complete');
  const parsed = schema.safeParse(JSON.parse(new TextDecoder().decode(await readBounded(request.body, 1024 * 1024))));
  if (!parsed.success) throw new ApiError(422, 'remote_callback_invalid', 'The callback does not match the typed attempt protocol.');
  const body = parsed.data;
  if (body.generation !== trustedIdentity.generation || body.plan_digest !== trustedIdentity.plan_digest) throw new ApiError(409, 'attempt_fenced', 'The callback generation or plan changed.');
  const context = authorized.context, a = context.attempt, id = receiptIdentity(context);
  if (authorized.authority) await fenceExecutionAuthority(env, context, authorized.authority, `remote-${action}`);
  let result: unknown;
  switch (action) {
    case 'begin': {
      const begun = await attemptRequest<{ execute: boolean }>(env, a.id, 'begin-hosted', {});
      if (!begun.execute) { result = { execute: false, status: a.status }; break; }
      const current = await attemptContext(primary(env), a.id), source = await checkoutCapability(env, current);
      result = { execute: true, status: 'running', lease_expires_at: current.attempt.lease_expires_at,
        source: { url: source.url, commit: source.commit, token: source.token }, inputs: await remoteInputs(env, current) };
      break;
    }
    case 'heartbeat': {
      const input = actionSchemas.heartbeat.parse(body);
      if (input.egress_bytes > context.job.egress.max_bytes || input.egress_requests > context.job.egress.max_requests) throw new ApiError(429, 'egress_quota_exceeded', 'The attempt exceeded its declared egress quota.');
      await execute(primary(env), 'UPDATE execution_attempts SET egress_bytes=MAX(egress_bytes,?),egress_requests=MAX(egress_requests,?) WHERE id=? AND repo_id=? AND generation=?', input.egress_bytes, input.egress_requests, a.id, a.repo_id, a.generation);
      result = await attemptRequest(env, a.id, 'hosted-heartbeat', {}); break;
    }
    case 'checkout-complete': await revokeCheckout(env, a.id); result = { revoked: true }; break;
    case 'process': result = await attemptRequest(env, a.id, 'process', { process_id: actionSchemas.process.parse(body).process_id }); break;
    case 'secrets': {
      const input = actionSchemas.secrets.parse(body), step = context.job.steps.find(step => (step.secret_step_id ?? step.id) === input.step_id);
      if (!step || input.names.some(name => !step.secrets.some(secret => secret.name === name))) throw new ApiError(403, 'undeclared_secret', 'The remote attempt may resolve only exact declared step versions.');
      result = await withEnvironmentSecrets(env, context, () => resolveAttemptSecrets(env, { attempt_id: a.id, generation: a.generation, step_id: input.step_id, names: input.names }));
      await execute(primary(env), 'INSERT OR IGNORE INTO execution_secret_steps (attempt_id,repo_id,account_id,generation,step_id,created_at) VALUES (?,?,?,?,?,?)', a.id, a.repo_id, a.account_id, a.generation, input.step_id, now());
      break;
    }
    case 'log': {
      const input = actionSchemas.log.parse(body);
      result = storedObject(await storeAttemptLog(env, context, { ...input, digest: `sha256:${input.sha256}` })); break;
    }
    case 'output': {
      const input = actionSchemas.output.parse(body), definition = context.job.outputs[input.name];
      if (!definition) throw new ApiError(403, 'undeclared_output', 'The remote output is not declared in this plan.');
      result = storedObject(await storeAttemptOutput(env, context, { ...input, digest: `sha256:${input.sha256}`, kind: definition.kind ?? 'artifact', retention_seconds: definition.retention_seconds, media_type: input.content_type })); break;
    }
    case 'log-manifest': result = storedObject(await completeObjectManifest(env, id, 'logs', 'logs')); break;
    case 'output-manifest': { const input = actionSchemas['output-manifest'].parse(body); result = storedObject(await completeObjectManifest(env, id, input.name, 'output', input.sha256)); break; }
    case 'cache-get': result = await getRemoteCache(env, context, actionSchemas['cache-get'].parse(body).cache_key); break;
    case 'snapshot-commit': result = await commitRemoteSnapshot(env, context, actionSchemas['snapshot-commit'].parse(body), authorized.authority!); break;
    case 'checkpoint': result = await attemptRequest(env, a.id, 'remote-checkpoint', actionSchemas.checkpoint.parse(body).receipt); break;
    case 'destroyed': {
      const proof = await verifyRemoteDestruction(env, a.id);
      await attemptRequest(env, a.id, 'destroyed', proof); result = { recorded: true }; break;
    }
    case 'complete': {
      const receipt = actionSchemas.complete.parse(body).receipt as CompletionReceipt;
      if (TERMINAL_ATTEMPTS.has(a.status) && a.receipt_hash === await sha256(JSON.stringify(receipt))) { result = { accepted: true }; break; }
      assertCurrentReceipt(a, id, await currentGeneration(primary(env), a));
      const authority = await authorizeExecutionActor(env, context.plan);
      await fenceExecutionAuthority(env, context, authority, 'remote-completion');
      if (authorized.dispatch.draft_hash !== await sha256(JSON.stringify(receipt))) throw new ApiError(409, 'receipt_not_checkpointed', 'The exact completion draft must be durably checkpointed before finalization.');
      const proof = await verifyRemoteDestruction(env, a.id);
      await attemptRequest(env, a.id, 'destroyed', proof);
      result = await attemptRequest(env, a.id, 'hosted-complete', receipt); break;
    }
    default: throw new ApiError(404, 'not_found', 'The remote callback operation is not supported.');
  }
  return Response.json(result, { headers: { 'cache-control': 'no-store' } });
}
