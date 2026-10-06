import type { Mode } from './environment.ts';

// Product admission limits are intentionally below provider hard ceilings.
// Their enforcement belongs to the shared admission/storage adapters.
export const PROVIDER_LIMITS = {
  reviewed_at: '2026-10-04',
  d1_database_bytes: 10_000_000_000,
  artifacts_repository_bytes: 1_000_000_000,
  artifacts_blob_bytes: 32_000_000,
  artifacts_account_bytes: 1_000_000_000_000,
  artifacts_namespace_requests_per_10_seconds: 2_000,
  artifacts_repository_git_requests_per_10_seconds: 2_000,
  worker_memory_bytes: 128 * 1024 * 1024,
  queue_message_bytes: 128 * 1024,
  queue_max_retention_seconds: 14 * 24 * 60 * 60,
  workflow_result_bytes: 1024 * 1024,
  workflow_paid_active_instances: 50_000,
  container_account_concurrent_vcpu: 1_500,
} as const;

export function limits(mode: Mode) {
  return {
    repository_bytes: PROVIDER_LIMITS.artifacts_repository_bytes,
    blob_bytes: PROVIDER_LIMITS.artifacts_blob_bytes,
    git_blob_bytes: PROVIDER_LIMITS.artifacts_blob_bytes,
    git_push_bytes: 90 * 1024 * 1024,
    git_inflated_bytes: 1024 * 1024 * 1024,
    git_object_count: 250_000,
    git_max_refs: 128,
    git_deadline_seconds: 120,
    d1_move_threshold_bytes: 6_500_000_000,
    tenant_concurrency: mode === 'production' ? 3 : 1,
    hosted_max_instances: mode === 'production' ? 10 : 2,
    git_max_instances: mode === 'production' ? 3 : 1,
    hosted_deadline_seconds: 15 * 60,
    hosted_shutdown_grace_seconds: 30,
    infrastructure_retries: 1,
    log_bytes_per_attempt: 64 * 1024 * 1024,
    output_bytes_per_attempt: 512 * 1024 * 1024,
    cache_bytes_per_repository: 1024 * 1024 * 1024,
    hosted_egress_bytes_per_attempt: 1024 * 1024 * 1024,
    workflow_jobs: 128,
    workflow_fanout: 16,
    queue_payload_bytes: 64 * 1024,
    source_event_retention_days: 30,
    backup_retention_days: 35,
    deletion_recovery_days: 30,
    platform_safety_buffer_basis_points: 1_000,
    git: {
      max_pack_bytes: 90 * 1024 * 1024,
      max_blob_bytes: PROVIDER_LIMITS.artifacts_blob_bytes,
      max_repository_bytes: PROVIDER_LIMITS.artifacts_repository_bytes,
      max_inflated_bytes: 1024 * 1024 * 1024,
      max_work_ms: 120_000,
      max_concurrent_sessions: 4,
    },
  };
}

export const LINUX_SMALL = {
  id: 'linux-small',
  architecture: 'linux/amd64',
  instance_type: 'standard-2',
  vcpu: 1,
  memory_mib: 6 * 1024,
  disk_mb: 12_000,
  ci_sdk: '0.2.0',
  sandbox_sdk: '0.12.1',
  base_image: 'docker.io/cloudflare/sandbox:0.12.1@sha256:ea9b35e61c800eddbc4450fad333e5dd26033a06f7d36624388b0711bef9f8c5',
  dockerfile: 'packages/execution/hosted/Dockerfile',
  scheduling_policy: 'default',
} as const;
