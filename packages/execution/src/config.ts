import { ApiError } from '@gitknot/core';
import { z } from 'zod';
import type { Bindings } from '@gitknot/core';
import type { HostedProfile, PlanJob } from './types.ts';
import { remoteControlKey, remoteExecutor } from './remote/config.ts';

export const EXECUTION_LIMITS = Object.freeze({
  jobs: 128, steps: 128, ready_batch: 16, dispatch_batch: 16, per_account_queue: 1000,
  lease_ms: 90_000, heartbeat_ms: 20_000, queue_ms: 24 * 60 * 60 * 1000,
  run_wait_ms: 7 * 24 * 60 * 60 * 1000, cleanup_ms: 30_000, sdk_rpc_ms: 60_000,
  log_chunk_bytes: 256 * 1024, log_bytes: 64 * 1024 ** 2, output_bytes: 1024 ** 3,
  cache_bytes: 256 * 1024 ** 2, max_secret_bytes: 16 * 1024, max_secrets: 64,
  log_retention_seconds: 30 * 86400, max_retention_seconds: 90 * 86400,
  egress_requests: 10_000, egress_bytes: 512 * 1024 ** 2, egress_request_bytes: 16 * 1024 ** 2,
});

const profileSchema = z.object({
  name: z.literal('linux-small'), image: z.string().regex(/@sha256:[a-f0-9]{64}$/),
  toolchain_digest: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/),
  sdk_version: z.literal('0.2.0'), sandbox_version: z.literal('0.12.1'),
  vcpu: z.number().positive().max(1), memory_mib: z.number().int().positive().max(6144),
  disk_mb: z.number().int().positive().max(12000), max_instances: z.number().int().min(1).max(10),
  max_job_ms: z.number().int().min(60_000).max(3_600_000),
  measurement: z.object({
    evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/), measured_at: z.iso.datetime(),
    cold_start_p95_ms: z.number().positive().max(300_000), teardown_p99_ms: z.number().positive().max(30_000),
    isolation_verified: z.literal(true), egress_verified: z.literal(true), destruction_verified: z.literal(true),
  }).strict(),
}).strict();

export function hostedProfiles(env: Bindings): HostedProfile[] {
  let data: unknown;
  try { data = JSON.parse(typeof env.HOSTED_PROFILES_JSON === 'string' ? env.HOSTED_PROFILES_JSON : '[]'); }
  catch { throw new ApiError(503, 'hosted_configuration_invalid', 'Hosted profiles are not available.'); }
  const parsed = z.array(profileSchema).max(1).safeParse(data);
  if (!parsed.success) throw new ApiError(503, 'hosted_configuration_invalid', 'Hosted profiles require measured, pinned configuration.');
  return parsed.data;
}

export function requireHostedProfile(env: Bindings, job: PlanJob): HostedProfile {
  if (job.executor.type !== 'hosted') throw new TypeError('Expected a hosted job.');
  const requested = job.executor.profile;
  const profile = hostedProfiles(env).find(value => value.name === requested);
  if (!profile) throw new ApiError(503, 'hosted_profile_unavailable', 'The requested hosted profile is not admitted in this cell.');
  if (job.execution_backend === 'remote') {
    const remote = remoteExecutor(env);
    if (!remote || remote.id !== job.remote_executor_id || remote.producer_id !== job.producer_id) throw new ApiError(409, 'remote_executor_changed', 'The remote executor is not the producer bound by this plan.');
    remoteControlKey(env, remote.key_binding);
  } else {
    const snapshots = env.BACKUP_BUCKET as R2Bucket | undefined;
    const sandbox = env.SANDBOX as DurableObjectNamespace | undefined;
    if (!snapshots?.put || !sandbox?.idFromName || !env.BLOBS?.put) throw new ApiError(503, 'hosted_bindings_unavailable', 'The admitted hosted profile is missing required execution bindings.');
  }
  if (profile.toolchain_digest !== job.toolchain.digest || profile.image !== job.toolchain.image
    || job.toolchain.os !== 'linux' || job.toolchain.architecture !== 'amd64' || job.timeout_ms > profile.max_job_ms) {
    throw new ApiError(409, 'hosted_toolchain_unavailable', 'The measured hosted profile does not match this immutable plan.');
  }
  return profile;
}

export function executionEnabled(env: Bindings): void {
  let config: Record<string, unknown>;
  try { config = JSON.parse(env.LIMITS_JSON ?? '{}'); }
  catch { throw new ApiError(503, 'execution_paused', 'Execution admission cannot be verified.'); }
  if (config.execution_paused === true) throw new ApiError(503, 'execution_paused', 'New execution is paused.');
}
