import { ApiError } from '@gitknot/core';
import { fingerprintToolchain, toolchainSchema } from '@gitknot/workflows';
import { remoteRuntimeId, requireRemoteOrigin } from '@gitknot/execution/remote/protocol';
import type { RemoteAttemptGrant } from '@gitknot/execution/remote/protocol';
import { z } from 'zod';
import { LIMITS } from './types.ts';
import type { HostedEnv } from './types.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/);
const path = z.string().min(1).max(1024).refine(value => !value.startsWith('/') && !/[\x00-\x1f\\:]/.test(value)
  && !value.split('/').some(part => part === '..' || part.toLowerCase() === '.git'));
const dependencyPath = path.refine(value => value !== '.' && value.split('/').every(Boolean));
const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const size = (max: number) => z.number().int().min(0).max(max);
const secret = z.object({ name: envName, secret_id: id, version_id: id, environment_id: id.optional() }).strict();
const output = z.object({ path, retention_seconds: z.number().int().positive().max(90 * 86400), max_bytes: size(LIMITS.output_bytes),
  type: z.enum(['artifact', 'string', 'number', 'boolean', 'json']).optional(), required: z.boolean().optional(),
  format: z.enum(['junit', 'sarif', 'json']).optional(), kind: z.enum(['artifact', 'report', 'value']).optional() }).strict();
const step = z.object({
  id, run: z.string().min(1).max(131072), shell: z.enum(['sh', 'bash']), working_directory: path,
  env: z.record(envName, z.string().max(131072)), values: z.record(envName, z.unknown()).optional(),
  outputs: z.record(id, z.object({ path, type: z.enum(['artifact', 'string', 'number', 'boolean', 'json']), required: z.boolean() }).strict()).optional(),
  secrets: z.array(secret).max(64), variable_names: z.array(envName).optional(), secret_step_id: id.optional(),
  timeout_ms: z.number().int().positive().max(3_600_000),
}).strict();
const jobSchema = z.object({
  key: id, needs: z.array(id).max(128), executor: z.object({ type: z.literal('hosted'), profile: z.literal('linux-small') }).strict(),
  toolchain: z.object({ name: z.string().min(1).max(128), digest, image: z.string().regex(/@sha256:[a-f0-9]{64}$/), os: z.literal('linux'), architecture: z.literal('amd64') }).strict(),
  producer_id: z.string().min(1).max(256), timeout_ms: z.number().int().positive().max(3_600_000),
  execution_backend: z.literal('remote').optional(), remote_executor_id: id.optional(),
  infrastructure_retries: size(10), applicable: z.literal(true), blocked_reason: z.string().nullable().optional(), inapplicable_reason: z.null(),
  steps: z.array(step).min(1).max(128),
  cache: z.object({ key: z.string().min(1).max(1024), paths: z.array(dependencyPath).min(1).max(128), key_files: z.array(dependencyPath).min(1).max(128),
    retention_seconds: z.number().int().min(60).max(90 * 86400), mode: z.enum(['read', 'read_write']).optional() }).strict().nullable(),
  outputs: z.record(id, output), inputs: z.array(z.object({ job: id, output: id, path }).strict()).max(128),
  egress: z.object({ hosts: z.array(z.string().max(253).refine(exactPublicHost)).max(128), max_requests: size(10_000),
    max_bytes: size(512 * 1024 ** 2), max_request_bytes: size(16 * 1024 ** 2) }).strict(),
  environment: z.object({ id, artifact_job: id, artifact_name: id }).strict().nullable(),
  secret_selection_id: id.optional(), secret_selection_digest: digest.optional(), variables: z.record(envName, z.string()).optional(),
  limits: z.object({ log_bytes: size(LIMITS.log_bytes), output_bytes: size(LIMITS.output_bytes), input_bytes: size(LIMITS.input_bytes),
    cache_bytes: size(LIMITS.cache_bytes), chunk_bytes: z.number().int().positive().max(LIMITS.chunk_bytes) }).strict().optional(),
}).strict();
const grantSchema = z.object({
  version: z.literal(1), executor_id: id, attempt_id: id, generation: z.number().int().positive(), run_id: id, job_id: id, repo_id: id, account_id: id,
  plan_digest: digest, workflow_digest: digest, policy_revision: z.number().int().nonnegative(), commit_sha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
  source_ref: z.string().min(1).max(1024), producer_id: z.string().min(1).max(256), runtime_name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,61}[a-z0-9_]$/),
  runtime_id: z.string().min(1).max(512), deadline_at: z.iso.datetime(), lease_expires_at: z.iso.datetime(), job: jobSchema, toolchain: toolchainSchema,
  callback: z.object({ origin: z.string().max(2048), token: z.string().min(32).max(4096) }).strict(),
}).strict();

export const controlSchema = z.object({ generation: z.number().int().positive(), grant_digest: z.string().regex(/^[a-f0-9]{64}$/),
  challenge: z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/), reason: z.string().max(1024).optional() }).strict();

export function allowLoopback(env: HostedEnv): boolean {
  return env.ENVIRONMENT === 'test' && env.HOSTED_TEST_ALLOW_LOOPBACK === true;
}

/** The deployment pins callback authority; a grant cannot select a destination. */
export function requireCallbackOrigin(env: HostedEnv, requested?: string): string {
  if (typeof env.HOSTED_CALLBACK_ORIGIN !== 'string' || !env.HOSTED_CALLBACK_ORIGIN) {
    throw new ApiError(503, 'hosted_callback_origin_unavailable', 'The hosted control-plane callback origin is not configured.');
  }
  const origin = requireRemoteOrigin(env.HOSTED_CALLBACK_ORIGIN, allowLoopback(env));
  if (requested !== undefined && requireRemoteOrigin(requested, allowLoopback(env)) !== origin) {
    throw new ApiError(409, 'callback_origin_mismatch', 'The grant callback origin does not match the configured control plane.');
  }
  return origin;
}

export function exactPublicHost(host: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)
    && !/^(?:[\d.]+)$/.test(host) && !/(?:^|\.)(?:localhost|internal|local|test|invalid)$/.test(host);
}

export async function validateGrant(value: unknown, env: HostedEnv): Promise<RemoteAttemptGrant> {
  const parsed = grantSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(422, 'invalid_remote_grant', 'The immutable hosted grant is invalid.');
  const grant = parsed.data as RemoteAttemptGrant;
  requireCallbackOrigin(env, grant.callback.origin);
  if (grant.executor_id !== env.HOSTED_EXECUTOR_ID || grant.producer_id !== grant.job.producer_id
    || grant.job.remote_executor_id !== undefined && grant.job.remote_executor_id !== grant.executor_id
    || grant.runtime_id !== remoteRuntimeId(grant.executor_id, grant.attempt_id, grant.generation)
    || grant.toolchain.os !== 'linux' || grant.toolchain.arch !== 'x64' || grant.toolchain.image !== grant.job.toolchain.image
    || await fingerprintToolchain(grant.toolchain) !== grant.job.toolchain.digest) {
    throw new ApiError(409, 'remote_grant_mismatch', 'The hosted identity or toolchain does not match the frozen grant.');
  }
  if (Date.parse(grant.lease_expires_at) > Date.parse(grant.deadline_at)) throw new ApiError(422, 'invalid_remote_lease', 'The execution lease exceeds its absolute deadline.');
  return grant;
}

export function requireBindings(env: HostedEnv): void {
  requireCallbackOrigin(env);
  if (!env.HOSTED_WORKFLOW?.create || !env.HOSTED_WORKFLOW?.get || !env.HOSTED_ATTEMPTS?.idFromName
    || !env.SANDBOX?.idFromName || !env.BACKUP_BUCKET?.put || !env.BACKUP_BUCKET?.head || !env.BACKUP_BUCKET?.delete
    || !env.HOSTED_EXECUTOR_ID || typeof env.HOSTED_CONTROL_KEY !== 'string' || env.HOSTED_CONTROL_KEY.length < 32) {
    throw new ApiError(503, 'hosted_bindings_unavailable', 'The remote hosted executor is not fully configured.');
  }
}

export function requireProfile(env: HostedEnv, grant: RemoteAttemptGrant): void {
  if (grant.job.executor.type !== 'hosted') throw new ApiError(409, 'hosted_profile_unavailable', 'The frozen job is not a hosted job.');
  const requested = grant.job.executor.profile;
  let profiles: unknown;
  try { profiles = JSON.parse(env.HOSTED_PROFILES_JSON); } catch { profiles = null; }
  const schema = z.array(z.object({
    name: z.literal('linux-small'), image: z.string().regex(/@sha256:[a-f0-9]{64}$/), toolchain_digest: digest,
    sdk_version: z.literal('0.2.0'), sandbox_version: z.literal('0.12.1'), vcpu: z.number().positive().max(1),
    memory_mib: z.number().int().positive().max(6144), disk_mb: z.number().int().positive().max(12000),
    max_instances: z.number().int().min(1).max(10), max_job_ms: z.number().int().min(60_000).max(3_600_000),
    measurement: z.object({ evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/), measured_at: z.iso.datetime(),
      cold_start_p95_ms: z.number().positive().max(300_000), teardown_p99_ms: z.number().positive().max(30_000),
      isolation_verified: z.literal(true), egress_verified: z.literal(true), destruction_verified: z.literal(true) }).strict(),
  }).strict()).max(1).safeParse(profiles);
  const profile = schema.success ? schema.data.find(candidate => candidate.name === requested) : undefined;
  if (!profile || profile.image !== grant.job.toolchain.image || profile.toolchain_digest !== grant.job.toolchain.digest
    || grant.job.timeout_ms > profile.max_job_ms || Date.parse(grant.deadline_at) - Date.now() > profile.max_job_ms) {
    throw new ApiError(503, 'hosted_profile_unavailable', 'This attempt requires a matching measured, pinned hosted profile.');
  }
}
