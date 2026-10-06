import { ApiError, authorize, database, execute, many, newId, now, one, principalForExplanation, randomToken, sha256, stmt } from '@gitknot/core';
import type { AppContext, Bindings, Database } from '@gitknot/core';
import { z } from 'zod';
import { checkoutCapability } from './checkout.ts';
import { attemptContext, guardedBatch, identityPrimary, primary } from './store.ts';
import { attemptRequest } from './transport.ts';
import type { ExecutionObject, JobRecord, RunnerPool, RunnerRecord } from './types.ts';
import { activeRunnerSlots } from './runner-slots.ts';
import { prepareRunnerExchange, recoverRunnerExchange, runnerExchangeSchema } from './runner-exchanges.ts';
import type { RunnerEnrollment } from './runner-exchanges.ts';
import type { CredentialExchange } from '@gitknot/runner/credential-exchange';
import { assertRunnerPoolScope, loadRunnerAuthority, readRunnerPool, runnerIdentityContext } from './runner-authority.ts';
import { assertRunnerRequestPlacement, registerRunnerChildLocator, runnerMetadataRequest, runnerResourcePlacement, sameRunnerPlacement, selectRunnerMetadata } from './runner-placement.ts';
import type { RunnerEnrollmentIntent, RunnerPlacement } from './runner-placement.ts';
import { databaseClock } from './runner-guards.ts';
import { runnerCapabilitiesSchema, runnerStatusSchema, runnerToolchains } from './runner-protocol.ts';
import type { RunnerStatus } from './runner-protocol.ts';

export { runnerCapabilitiesSchema } from './runner-protocol.ts';
export const registrationSchema = runnerExchangeSchema.extend({ enrollment_token: z.string().min(32).max(256), name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  capabilities: runnerCapabilitiesSchema, slots: z.number().int().min(1).max(16).default(1), disposable: z.boolean().default(false) }).strict();
export const runnerPollSchema = runnerStatusSchema.extend({ wait_seconds: z.number().int().min(0).max(50).default(25) }).strict();
export const runnerHeartbeatSchema = runnerStatusSchema.extend({
  active_attempts: z.array(z.object({ attempt_id: z.string(), generation: z.number().int().positive() }).strict()).max(16) }).strict();

export function bearerToken(request: Request): string {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(request.headers.get('authorization') ?? '');
  if (!match) throw new ApiError(401, 'runner_authentication_required', 'A current runner machine credential is required.');
  return match[1]!;
}

export async function authenticateRunner(env: Bindings, id: string, token: string): Promise<RunnerRecord> {
  const { runner } = await loadRunnerAuthority(env, id);
  if (runner.credential_hash !== await sha256(token)) throw new ApiError(401, 'runner_revoked', 'The runner machine credential is no longer current.');
  return runner;
}

export async function createEnrollment(env: Bindings, pool: RunnerPool, actorId: string, seconds = 600, context?: AppContext): Promise<Record<string, unknown>> {
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 3600) throw new ApiError(422, 'enrollment_expiry_invalid', 'Enrollment expiry must be between 60 and 3600 seconds.');
  const placement = await runnerResourcePlacement(env, pool.id, 'runner_pool');
  const current = await readRunnerPool(env, pool.id);
  if (current.account_id !== pool.account_id || current.revision !== pool.revision) throw new ApiError(409, 'runner_pool_changed', 'The enrollment pool changed before issuance.');
  await assertRunnerPoolScope(env, current);
  const id = newId('enr'), token = `gkenr_${id}_${randomToken()}`, at = now();
  await registerRunnerChildLocator(env, placement, id, 'runner_enrollment');
  const expires = new Date(Date.now() + seconds * 1000).toISOString();
  const enrollment: RunnerEnrollmentIntent = { id, account_id: pool.account_id, repo_id: pool.repo_id, pool_id: pool.id,
    token_hash: await sha256(token), expires_at: expires, created_by: actorId, created_at: at };
  if (context || placement.binding) await createEnrollmentProjection(env, placement, enrollment, context);
  else await runnerMetadataRequest(env, placement, { action: 'enrollment-create', enrollment });
  return { id, pool_id: pool.id, enrollment_token: token, expires_at: expires };
}

export async function createEnrollmentProjection(env: Bindings, placement: RunnerPlacement, intent: RunnerEnrollmentIntent, context?: AppContext): Promise<{ created: true }> {
  if (!placement.binding || placement.locator.resource_type !== 'runner_pool' || placement.locator.resource_id !== intent.pool_id) throw new ApiError(409, 'runner_placement_mismatch', 'The enrollment does not belong to this pool placement.');
  const pool = await readRunnerPool(env, intent.pool_id);
  if (pool.account_id !== intent.account_id || pool.repo_id !== intent.repo_id || intent.expires_at <= now()) throw new ApiError(409, 'enrollment_invalid', 'The enrollment intent no longer matches its pool.');
  await assertRunnerPoolScope(env, pool);
  if (!sameRunnerPlacement(placement, await runnerResourcePlacement(env, intent.id, 'runner_enrollment'))) throw new ApiError(409, 'runner_placement_mismatch', 'The enrollment must inherit its pool storage authority.');
  const actor = context?.get('principal') ?? await principalForExplanation(identityPrimary(env), intent.created_by);
  if (!actor || actor.id !== intent.created_by) throw new ApiError(401, 'enrollment_invalid', 'The enrollment creator is no longer current.');
  const authority = context ?? runnerIdentityContext(env, actor);
  if (context) assertRunnerRequestPlacement(context, placement);
  else await selectRunnerMetadata(authority, placement);
  const decision = await authorize(authority, 'runners.manage', pool.repo_id ? { repo_id: pool.repo_id } : { account_id: pool.account_id });
  if (decision.account_id !== pool.account_id) throw new ApiError(404, 'runner_pool_scope_changed', 'The repository no longer belongs to this runner pool account.');
  await assertRunnerPoolScope(env, pool);
  const db = database(authority);
  await guardedBatch(db, stmt(db, `INSERT INTO runner_enrollments(id,account_id,repo_id,pool_id,token_hash,expires_at,created_by,created_at)
    SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM runner_pools WHERE id=? AND account_id=? AND repo_id IS ? AND revision=? AND state='active')`,
  intent.id, intent.account_id, intent.repo_id, intent.pool_id, intent.token_hash, intent.expires_at, intent.created_by, intent.created_at,
  pool.id, pool.account_id, pool.repo_id, pool.revision), [], {
    context: authority, event: { type: 'runner.enrollment.created', resource_id: intent.id, resource_revision: 1, repo_id: placement.locator.repo_id, account_id: pool.account_id, actor_id: actor.id },
    audit: { action: 'runners.enroll', resource_id: intent.id, repo_id: pool.repo_id, account_id: pool.account_id, actor_id: actor.id, details: { pool_id: pool.id, expires_at: intent.expires_at } },
  });
  return { created: true };
}

async function currentEnrollment(env: Bindings, token: string): Promise<{ enrollment: RunnerEnrollment; pool: RunnerPool; placement: RunnerPlacement }> {
  const hash = await sha256(token);
  // Legacy token lookup supplies only an ID hint. The actual metadata is reread.
  const id = /^gkenr_(enr_[a-f0-9]{32})_[A-Za-z0-9_-]{43}$/.exec(token)?.[1]
    ?? (await one<{ id: string }>(identityPrimary(env), 'SELECT id FROM runner_enrollments WHERE token_hash=?', hash))?.id;
  if (!id) throw new ApiError(401, 'enrollment_invalid', 'The enrollment is invalid, expired, or already consumed.');
  const placement = await runnerResourcePlacement(env, id, 'runner_enrollment');
  const enrollment = await runnerMetadataRequest<RunnerEnrollment | null>(env, placement, { action: 'read' });
  if (!enrollment || enrollment.id !== id || enrollment.token_hash !== hash || enrollment.consumed_at !== null || enrollment.expires_at <= now()) throw new ApiError(401, 'enrollment_invalid', 'The enrollment is invalid, expired, or already consumed.');
  const pool = await readRunnerPool(env, enrollment.pool_id);
  if (pool.account_id !== enrollment.account_id || pool.repo_id !== enrollment.repo_id
    || !sameRunnerPlacement(placement, await runnerResourcePlacement(env, pool.id, 'runner_pool'))) throw new ApiError(401, 'enrollment_invalid', 'The enrollment no longer belongs to this pool authority.');
  await assertRunnerPoolScope(env, pool);
  return { enrollment, pool, placement };
}

export async function registerRunner(env: Bindings, input: z.infer<typeof registrationSchema>): Promise<Record<string, unknown>> {
  const { enrollment_token: token, exchange, ...request } = registrationSchema.parse(input);
  if (exchange.expected_generation !== 0) throw new ApiError(409, 'credential_generation_mismatch', 'Enrollment begins at credential generation zero.');
  const recovered = await recoverRunnerExchange(env, exchange, 'register', token, request);
  if (recovered) return recovered;
  const { enrollment, pool, placement } = await currentEnrollment(env, token);
  const os = request.capabilities.os === 'win32' ? 'windows' : request.capabilities.os;
  const architecture = request.capabilities.arch === 'x64' ? 'amd64' : request.capabilities.arch;
  const toolchains = runnerToolchains(request.capabilities);
  const allowed: string[] = JSON.parse(pool.toolchains_json);
  if (pool.os !== os || pool.architecture !== architecture || !allowed.some(value => toolchains.includes(value)) || request.slots > pool.max_slots
    || pool.trust === 'untrusted' && (!request.disposable || pool.isolation !== 'ephemeral')) throw new ApiError(422, 'runner_capability_mismatch', 'The machine does not meet the enrolled pool platform, trust, or toolchain requirements.');
  if (request.disposable && request.slots !== 1) throw new ApiError(422, 'disposable_single_assignment', 'Disposable machines receive exactly one single-slot assignment.');
  const id = `runner_${exchange.id.slice(4)}`, at = now(), expires = new Date(Date.now() + 30 * 86400_000).toISOString();
  const runner: RunnerRecord = { id, account_id: pool.account_id, repo_id: pool.repo_id, pool_id: pool.id, name: request.name, os, architecture,
    toolchains_json: JSON.stringify(toolchains), slots: request.slots, credential_hash: '', credential_generation: 1, credential_expires_at: expires,
    state: 'active', last_seen_at: at, revision: 1, created_at: at, updated_at: at, disposable: request.disposable ? 1 : 0, assignment_attempt_id: null, disposable_consumed_at: null };
  await prepareRunnerExchange(env, exchange, 'register', token, request, pool, placement, runner, enrollment, null, null);
  const result = await recoverRunnerExchange(env, exchange, 'register', token, request);
  if (!result) throw new ApiError(503, 'credential_exchange_pending', 'The durable enrollment exchange is unavailable. Retry the same exchange.');
  return result;
}

export async function updateRunnerCapabilities(db: Database, runner: RunnerRecord, input: RunnerStatus): Promise<void> {
  if (input.pool_id !== runner.pool_id || input.available_slots > runner.slots || (input.capabilities.os === 'win32' ? 'windows' : input.capabilities.os) !== runner.os
    || (input.capabilities.arch === 'x64' ? 'amd64' : input.capabilities.arch) !== runner.architecture
    || JSON.stringify(runnerToolchains(input.capabilities)) !== JSON.stringify([...new Set(JSON.parse(runner.toolchains_json) as string[])].sort())) throw new ApiError(422, 'runner_capability_mismatch', 'The machine cannot change its enrolled platform, fingerprints or slot limit through a heartbeat.');
  const result = await execute(db, `UPDATE runners SET last_seen_at=?,updated_at=? WHERE id=? AND account_id=? AND pool_id=? AND credential_generation=?
    AND credential_hash=? AND toolchains_json=? AND state='active' AND credential_expires_at>${databaseClock}`,
  now(), now(), runner.id, runner.account_id, runner.pool_id, runner.credential_generation, runner.credential_hash, runner.toolchains_json);
  if (result.meta.changes !== 1) throw new ApiError(401, 'runner_revoked', 'The machine changed before its heartbeat was recorded.');
}

export async function pollRunner(env: Bindings, runner: RunnerRecord, input: z.infer<typeof runnerPollSchema>): Promise<Record<string, unknown>> {
  const authority = await loadRunnerAuthority(env, runner.id), pool = authority.pool;
  if (authority.runner.credential_generation !== runner.credential_generation || authority.runner.credential_hash !== runner.credential_hash) throw new ApiError(401, 'runner_revoked', 'The machine credential changed before polling.');
  runner = authority.runner;
  const placement = await runnerResourcePlacement(env, runner.id, 'runner');
  await runnerMetadataRequest(env, placement, { action: 'heartbeat', credential_hash: runner.credential_hash, credential_generation: runner.credential_generation,
    status: { pool_id: input.pool_id, capabilities: input.capabilities, available_slots: input.available_slots } });
  if (!input.available_slots) return { assignment: null, retry_after_seconds: 3 };
  const active = await activeRunnerSlots(env, runner.id);
  for (const slot of active) {
    const response = await attemptRequest<{ assignment: Record<string, unknown> | null }>(env, slot.attempt_id, 'assignment', { runner_id: runner.id });
    if (response.assignment) return response;
  }
  const db = identityPrimary(env);
  if (runner.disposable && (runner.assignment_attempt_id || await one(db, 'SELECT attempt_id FROM runner_slot_reservations WHERE runner_id=? AND assigned_at IS NOT NULL LIMIT 1', runner.id))) return { assignment: null, retry_after_seconds: 30 };
  if (active.length >= Math.min(runner.slots, pool.max_slots)) return { assignment: null, retry_after_seconds: 3 };
  const candidates = await many<{ attempt_id: string }>(db, `SELECT attempt_id FROM runner_job_offers WHERE account_id=? AND pool_id=? AND state='offered' ORDER BY updated_at,created_at,attempt_id LIMIT 32`, runner.account_id, pool.id);
  for (const candidate of candidates) {
    const result = await attemptRequest<{ assigned: boolean }>(env, candidate.attempt_id, 'assign', { runner_id: runner.id });
    if (result.assigned) return attemptRequest(env, candidate.attempt_id, 'assignment', { runner_id: runner.id });
    await execute(db, `UPDATE runner_job_offers SET updated_at=? WHERE attempt_id=? AND state='offered'`, now(), candidate.attempt_id);
  }
  return { assignment: null, retry_after_seconds: 3 };
}

export async function runnerAssignment(env: Bindings, attemptId: string, leaseToken: string): Promise<Record<string, unknown>> {
  const db = primary(env), context = await attemptContext(db, attemptId), source = await checkoutCapability(env, context);
  const inputs: Record<string, unknown>[] = [];
  for (const input of context.job.inputs) {
    const dependency = await one<JobRecord>(db, `SELECT * FROM workflow_jobs WHERE run_id=? AND repo_id=? AND job_key=? AND status='succeeded'`, context.run.id, context.run.repo_id, input.job);
    const object = dependency && await one<ExecutionObject>(db, `SELECT * FROM execution_objects WHERE attempt_id=? AND repo_id=? AND kind='manifest' AND name=? AND state='sealed' AND expires_at>?`,
      dependency.current_attempt_id ?? dependency.reused_attempt_id, context.run.repo_id, `output:${input.output}`, now());
    if (!object) throw new ApiError(409, 'input_unavailable', 'A dependency output is missing or expired.');
    const raw = await env.BLOBS.get(object.object_key);
    if (!raw) throw new ApiError(409, 'input_unavailable', 'A dependency output manifest is unavailable.');
    const data = await raw.json<{ size_bytes: number }>();
    const producer = context.plan.jobs.find(job => job.key === input.job)!;
    inputs.push({ job_id: input.job, name: input.output, type: producer.outputs[input.output]?.type ?? 'artifact', digest: `sha256:${object.source_digest}`,
      size_bytes: data.size_bytes, download_path: `/v1/attempts/${attemptId}/inputs/${object.id}` });
  }
  return { attempt_id: context.attempt.id, run_id: context.attempt.run_id, job_id: context.job.key, generation: context.attempt.generation,
    lease_token: leaseToken, lease_expires_at: context.attempt.lease_expires_at, deadline_at: context.attempt.deadline_at,
    manifest: context.plan.portable_manifest, source: { url: source.url, commit: source.commit, token: source.token }, inputs, variables: context.job.variables ?? {},
    ...(context.job.environment ? { approved_environment: { name: (context.plan.portable_manifest as { jobs: Array<{ id: string; environment?: { name: string } }> }).jobs.find(job => job.id === context.job.key)?.environment?.name,
      manifest_digest: (context.plan.portable_manifest as { digest: string }).digest, commit: context.run.commit_sha } } : {}),
  };
}

export async function rotateRunner(env: Bindings, runnerId: string, source: string, exchange: CredentialExchange): Promise<Record<string, unknown>> {
  exchange = runnerExchangeSchema.parse({ exchange }).exchange;
  const recovered = await recoverRunnerExchange(env, exchange, 'rotate', source, {}, runnerId);
  if (recovered) return recovered;
  const { runner, pool, credential } = await loadRunnerAuthority(env, runnerId);
  if (runner.credential_hash !== await sha256(source)) throw new ApiError(401, 'runner_revoked', 'The machine credential is no longer current.');
  if (exchange.expected_generation !== runner.credential_generation) throw new ApiError(409, 'credential_generation_mismatch', 'The rotation must name the current credential generation.');
  if (runner.disposable && (runner.assignment_attempt_id || await one(identityPrimary(env), 'SELECT attempt_id FROM runner_slot_reservations WHERE runner_id=? AND assigned_at IS NOT NULL LIMIT 1', runner.id))) throw new ApiError(409, 'disposable_consumed', 'A disposable machine receives one historical assignment and cannot rotate afterward.');
  if ((await activeRunnerSlots(env, runner.id)).length) throw new ApiError(409, 'runner_busy', 'Machine credentials cannot rotate while a slot is active or cleanup is unconfirmed.');
  const expires = new Date(Date.now() + 30 * 86400_000).toISOString();
  const next = { ...runner, credential_generation: runner.credential_generation + 1, credential_expires_at: expires, revision: runner.revision + 1, updated_at: now() };
  await prepareRunnerExchange(env, exchange, 'rotate', source, {}, pool, await runnerResourcePlacement(env, runner.id, 'runner'), next, null, runner, credential);
  const result = await recoverRunnerExchange(env, exchange, 'rotate', source, {}, runner.id);
  if (!result) throw new ApiError(503, 'credential_exchange_pending', 'The durable rotation exchange is unavailable. Retry the same exchange.');
  return result;
}
