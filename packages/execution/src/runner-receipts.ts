import { resolveAttemptSecrets } from '@gitknot/secrets';
import { ApiError, canonicalJson, execute, many, now, one, sha256 } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import type { z } from 'zod';
import { EXECUTION_LIMITS } from './config.ts';
import { completeObjectManifest, putObjectBytes, streamManifest } from './objects.ts';
import { redactText, secretVariants } from './redaction.ts';
import { primary } from './store.ts';
import { attemptRequest } from './transport.ts';
import type { ReceiptAuth } from './attempt-machine.ts';
import type { AttemptContext, AttemptIdentity, CompletionReceipt, ExecutionObject, JobRecord } from './types.ts';
import type { completionSchema, logUploadSchema, outputUploadSchema, stepSecretsSchema, terminationSchema } from './receipt-schemas.ts';
import { withEnvironmentSecrets } from './environments.ts';
import { reportFailed } from './reports.ts';
import { fenceMachineAuthority } from './authorization.ts';

export async function authorizeAttempt(env: Bindings, attemptId: string, auth: ReceiptAuth, allowClosed = false): Promise<AttemptContext> {
  return attemptRequest<AttemptContext>(env, attemptId, allowClosed ? 'authorize-closed' : 'authorize', auth);
}

export function receiptIdentity(context: AttemptContext): AttemptIdentity {
  return { attempt_id: context.attempt.id, generation: context.attempt.generation, plan_digest: context.attempt.plan_digest, runner_id: context.attempt.runner_id ?? context.attempt.producer_id };
}

async function decodedChunk(input: { data_base64: string; digest: string; size_bytes: number }): Promise<Uint8Array> {
  const bytes = Uint8Array.from(atob(input.data_base64), value => value.charCodeAt(0));
  if (bytes.length !== input.size_bytes || `sha256:${await sha256(bytes)}` !== input.digest) throw new ApiError(422, 'checksum_mismatch', 'The upload does not match its declared checksum and byte length.');
  return bytes;
}

async function logMasks(env: Bindings, context: AttemptContext): Promise<string[]> {
  const values: string[] = [];
  // Resolve only already-requested steps. The broker has the authoritative
  // selection/version policy; neither names nor Worker binding names come from logs.
  const used = await many<{ step_id: string }>(primary(env), 'SELECT step_id FROM execution_secret_steps WHERE attempt_id=? AND repo_id=? AND generation=?', context.attempt.id, context.attempt.repo_id, context.attempt.generation);
  for (const usage of used) {
    const step = context.job.steps.find(value => (value.secret_step_id ?? value.id) === usage.step_id);
    if (!step?.secrets.length) continue;
    const resolved = await withEnvironmentSecrets(env, context, () => resolveAttemptSecrets(env, { attempt_id: context.attempt.id, generation: context.attempt.generation, step_id: usage.step_id, names: step.secrets.map(value => value.name) }));
    values.push(...Object.values(resolved.values));
  }
  return values;
}

function maskNetworkChunk(bytes: Uint8Array, values: string[]): Uint8Array {
  let value: string;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ApiError(422, 'invalid_log_encoding', 'Log chunks must contain complete UTF-8 text.'); }
  // Legitimate runners apply a stateful redactor before uploading. Conservatively
  // mask boundary fragments too, so independent HTTP chunks cannot bypass masking.
  for (const secret of secretVariants(values)) {
    if (value && value.length < secret.length && secret.includes(value)) { value = '[REDACTED]'; continue; }
    for (let split = 1; split < secret.length; split++) {
      const prefix = secret.slice(0, split), suffix = secret.slice(split);
      if (value.endsWith(prefix)) value = value.slice(0, -prefix.length) + '[REDACTED]';
      if (value.startsWith(suffix)) value = '[REDACTED]' + value.slice(suffix.length);
    }
  }
  return new TextEncoder().encode(redactText(value, values));
}

export async function uploadRunnerLog(env: Bindings, attemptId: string, auth: ReceiptAuth, input: z.infer<typeof logUploadSchema>): Promise<Record<string, unknown>> {
  const context = await authorizeAttempt(env, attemptId, auth);
  await storeAttemptLog(env, context, input);
  return { accepted: true, sequence: input.sequence, digest: input.digest };
}

export async function storeAttemptLog(env: Bindings, context: AttemptContext, input: { sequence: number; data_base64: string; digest: string; size_bytes: number }): Promise<ExecutionObject> {
  const decoded = await decodedChunk(input);
  const masked = maskNetworkChunk(decoded, await logMasks(env, context));
  return putObjectBytes(env, { ...receiptIdentity(context), kind: 'log', name: 'combined', sequence: input.sequence,
    content_type: 'text/plain; charset=utf-8', retention_seconds: EXECUTION_LIMITS.log_retention_seconds, source_digest: input.digest.replace(/^sha256:/, ''), source_size_bytes: decoded.length,
    machine_authority: context.machine_authority }, masked);
}

export async function uploadRunnerOutput(env: Bindings, attemptId: string, auth: ReceiptAuth, input: z.infer<typeof outputUploadSchema>): Promise<Record<string, unknown>> {
  const context = await authorizeAttempt(env, attemptId, auth);
  await storeAttemptOutput(env, context, input);
  return { accepted: true, name: input.name, sequence: input.sequence, digest: input.digest };
}

export async function storeAttemptOutput(env: Bindings, context: AttemptContext, input: { name: string; kind: 'artifact' | 'report' | 'value'; retention_seconds: number; sequence: number; final: boolean; media_type: string; data_base64: string; digest: string; size_bytes: number }): Promise<ExecutionObject> {
  const attemptId = context.attempt.id;
  const definition = context.job.outputs[input.name];
  if (!definition || input.retention_seconds !== definition.retention_seconds || input.kind !== (definition.kind ?? 'artifact')) throw new ApiError(403, 'undeclared_output', 'Output type and retention must match the immutable plan.');
  const bytes = await decodedChunk(input);
  const sum = await one<{ bytes: number }>(primary(env), `SELECT COALESCE(SUM(size_bytes),0) AS bytes FROM execution_objects WHERE attempt_id=? AND repo_id=? AND kind='output' AND name=? AND sequence!=? AND state!='deleted'`, attemptId, context.attempt.repo_id, input.name, input.sequence);
  if ((sum?.bytes ?? 0) + bytes.length > definition.max_bytes) throw new ApiError(413, 'output_quota_exceeded', 'The declared output byte limit was exceeded.');
  return putObjectBytes(env, { ...receiptIdentity(context), kind: 'output', name: input.name, sequence: input.sequence, final: input.final,
    content_type: input.media_type, retention_seconds: input.retention_seconds, source_digest: input.digest.replace(/^sha256:/, ''), machine_authority: context.machine_authority }, bytes);
}

export async function runnerStepSecrets(env: Bindings, attemptId: string, auth: ReceiptAuth, input: z.infer<typeof stepSecretsSchema>): Promise<Record<string, unknown>> {
  const context = await authorizeAttempt(env, attemptId, auth);
  const step = context.job.steps.find(value => (value.secret_step_id ?? value.id) === input.step_id);
  if (!step || input.names.some(name => !step.secrets.some(secret => secret.name === name))) throw new ApiError(403, 'undeclared_secret', 'The requested secret is not declared for this exact step.');
  const values = await withEnvironmentSecrets(env, context, () => resolveAttemptSecrets(env, { attempt_id: attemptId, generation: auth.generation, step_id: input.step_id, names: input.names }));
  await fenceMachineAuthority(env, context, 'secret-release');
  await execute(primary(env), 'INSERT OR IGNORE INTO execution_secret_steps (attempt_id,repo_id,account_id,generation,step_id,created_at) VALUES (?,?,?,?,?,?)', attemptId, context.attempt.repo_id, context.attempt.account_id, auth.generation, input.step_id, now());
  return { ...values };
}

export async function completeRunnerAttempt(env: Bindings, attemptId: string, auth: ReceiptAuth, input: z.infer<typeof completionSchema>): Promise<Record<string, unknown>> {
  const context = await authorizeAttempt(env, attemptId, auth, true), receipt = input.receipt;
  if (`sha256:${await sha256(canonicalJson(receipt))}` !== input.receipt_digest) throw new ApiError(422, 'receipt_checksum_mismatch', 'The completion receipt checksum did not match.');
  const manifest = context.plan.portable_manifest as { digest: string; jobs: Array<{ id: string; steps: Array<{ id: string }> }> };
  if (receipt.attempt_id !== attemptId || receipt.run_id !== context.run.id || receipt.job_id !== context.job.key || receipt.runner_id !== auth.runner_id || receipt.generation !== auth.generation
    || receipt.manifest_digest !== manifest.digest || receipt.commit !== context.run.commit_sha || receipt.toolchain_fingerprint !== context.attempt.toolchain_digest) throw new ApiError(409, 'attempt_fenced', 'Receipt provenance differs from the assigned manifest.');
  const previous = context.attempt.outcome_json ? JSON.parse(context.attempt.outcome_json) as CompletionReceipt : null;
  if (previous?.protocol_receipt_digest === input.receipt_digest) {
    await attemptRequest(env, attemptId, 'complete', { auth, receipt: previous });
    return { accepted: true, receipt_digest: input.receipt_digest };
  }
  if (['cancelling', 'runner_unreachable'].includes(context.attempt.status) && ['cancelled', 'timed_out'].includes(receipt.outcome)) {
    await attemptRequest(env, attemptId, 'customer-terminated', { auth, receipt_digest: input.receipt_digest });
    throw new ApiError(409, 'attempt_fenced', 'Termination was recorded; cancelled attempts cannot publish results.');
  }
  await authorizeAttempt(env, attemptId, auth);
  if (receipt.outcome === 'not_applicable') throw new ApiError(403, 'untrusted_inapplicability', 'Only the trusted planner can declare a requirement inapplicable.');
  const expectedSteps = manifest.jobs.find(job => job.id === context.job.key)!.steps;
  if (receipt.outcome === 'passed' && (receipt.exit_code !== 0 || receipt.signal || expectedSteps.length !== receipt.steps.length
    || expectedSteps.some(step => !receipt.steps.some(actual => actual.id === step.id && actual.outcome === 'passed' && actual.exit_code === 0 && actual.signal === null)))) throw new ApiError(409, 'incomplete_verification', 'Every declared step must pass before verification can succeed.');
  const objects = await many<ExecutionObject>(primary(env), `SELECT * FROM execution_objects WHERE attempt_id=? AND repo_id=? AND generation=? AND state='sealed' AND kind IN ('log','output')`, attemptId, context.attempt.repo_id, auth.generation);
  const logs = objects.filter(object => object.kind === 'log');
  if (logs.length !== receipt.logs.length || receipt.logs.some((log, index) => log.sequence !== index || !logs.some(stored => stored.sequence === index && (stored.source_digest ?? stored.sha256) === log.digest.slice(7)
    && (stored.source_size_bytes ?? stored.size_bytes) === log.size_bytes))) throw new ApiError(409, 'logs_incomplete', 'The completion receipt does not match the accepted log chunks.');
  const identity = receiptIdentity(context), outputs: CompletionReceipt['outputs'] = [];
  if (new Set(receipt.outputs.map(output => output.name)).size !== receipt.outputs.length) throw new ApiError(409, 'duplicate_output', 'Each declared output may appear once in a completion receipt.');
  let reportsFailed = false;
  for (const output of receipt.outputs) {
    if (output.kind !== (context.job.outputs[output.name]?.kind ?? 'artifact')) throw new ApiError(409, 'output_type_mismatch', 'The receipt changed the declared output or report type.');
    const stored = objects.filter(object => object.kind === 'output' && object.name === output.name);
    if (!context.job.outputs[output.name] || stored.length !== output.chunks.length || stored.reduce((bytes, object) => bytes + object.size_bytes, 0) !== output.size_bytes
      || output.chunks.some((chunk, index) => chunk.sequence !== index || !stored.some(object => object.sequence === index && object.sha256 === chunk.digest.slice(7) && object.size_bytes === chunk.size_bytes))) throw new ApiError(409, 'outputs_incomplete', 'The completion receipt does not match the accepted output chunks.');
    const object = await completeObjectManifest(env, identity, output.name, 'output', output.digest, context.machine_authority);
    if (output.kind === 'report') {
      const data = new Uint8Array(await new Response(await streamManifest(env, object)).arrayBuffer());
      if (data.length > context.job.outputs[output.name]!.max_bytes) throw new ApiError(413, 'report_limit', 'The report exceeded its byte quota.');
      reportsFailed ||= reportFailed(data, context.job.outputs[output.name]!.format!);
    }
    outputs.push({ name: output.name, sha256: object.source_digest!, size_bytes: output.size_bytes });
  }
  const logManifest = await completeObjectManifest(env, identity, 'logs', 'logs', undefined, context.machine_authority);
  const internal: CompletionReceipt = { ...identity, protocol_receipt_digest: input.receipt_digest, conclusion: reportsFailed ? 'failed' : receipt.outcome === 'passed' ? 'succeeded' : receipt.outcome === 'dependency_blocked' ? 'failed' : receipt.outcome,
    exit_code: receipt.exit_code, signal: receipt.signal, resource_exhaustion: null, toolchain_digest: receipt.toolchain_fingerprint,
    outputs, log_manifest_digest: logManifest.sha256, process_group_stopped: receipt.cleanup_confirmed, started_at: receipt.started_at, finished_at: receipt.finished_at };
  await attemptRequest(env, attemptId, 'complete', { auth, receipt: internal });
  return { accepted: true, receipt_digest: input.receipt_digest };
}

export async function runnerInput(env: Bindings, attemptId: string, auth: ReceiptAuth, objectId: string): Promise<Response> {
  const context = await authorizeAttempt(env, attemptId, auth);
  await fenceMachineAuthority(env, context, 'input-download');
  const object = await one<ExecutionObject>(primary(env), `SELECT * FROM execution_objects WHERE id=? AND repo_id=? AND kind='manifest' AND state='sealed' AND expires_at>?`, objectId, context.run.repo_id, now());
  if (!object) throw new ApiError(404, 'not_found', 'The input was not found.');
  const dependencies = await many<JobRecord>(primary(env), 'SELECT * FROM workflow_jobs WHERE run_id=? AND repo_id=?', context.run.id, context.run.repo_id);
  if (!context.job.inputs.some(input => object.name === `output:${input.output}` && dependencies.some(job => job.job_key === input.job && job.status === 'succeeded' && (job.current_attempt_id ?? job.reused_attempt_id) === object.attempt_id))) throw new ApiError(404, 'not_found', 'The input is not declared by this attempt.');
  return new Response(await streamManifest(env, object), { headers: { 'content-type': 'application/octet-stream', 'content-digest': `sha-256=:${Buffer.from(object.source_digest!, 'hex').toString('base64')}:`, 'cache-control': 'private, no-store' } });
}

export async function confirmRunnerTermination(env: Bindings, attemptId: string, auth: ReceiptAuth, input: z.infer<typeof terminationSchema>): Promise<Record<string, unknown>> {
  const context = await attemptRequest<AttemptContext>(env, attemptId, 'authorize-cleanup', auth), proof = input.termination;
  const manifest = context.plan.portable_manifest as { digest: string };
  if (`sha256:${await sha256(canonicalJson(proof))}` !== input.termination_digest) throw new ApiError(422, 'termination_checksum_mismatch', 'The termination receipt checksum did not match.');
  if (proof.attempt_id !== attemptId || proof.runner_id !== auth.runner_id || proof.generation !== auth.generation || proof.manifest_digest !== manifest.digest
    || proof.commit !== context.run.commit_sha || Date.parse(proof.finished_at) > Date.now() + 30_000
    || Date.parse(proof.finished_at) < Date.parse(context.attempt.allocated_at!) - 30_000) throw new ApiError(409, 'attempt_fenced', 'The cleanup receipt does not match the original allocation.');
  await attemptRequest(env, attemptId, 'customer-terminated', { auth, receipt_digest: input.termination_digest });
  return { accepted: true, termination_digest: input.termination_digest };
}
