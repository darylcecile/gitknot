import type { Bindings, Database } from '@gitknot/core';
import type { RunnerAuthorityWitness } from './runner-authority.ts';
import type { WorkflowSourceIdentity } from './source-identity.ts';

export type Trust = 'trusted' | 'untrusted';
export type Executor = { type: 'hosted'; profile: string } | { type: 'self_hosted'; pool: string };
export type JobStatus = 'waiting' | 'ready' | 'queued' | 'admitting' | 'running' | 'waiting_approval' | 'cancelling'
  | 'succeeded' | 'failed' | 'dependency_blocked' | 'cancelled' | 'timed_out' | 'not_applicable' | 'runner_unreachable';
export type RunStatus = 'queued' | 'running' | 'waiting' | 'waiting_approval' | 'cancelling' | 'succeeded' | 'failed'
  | 'cancelled' | 'timed_out' | 'not_applicable' | 'runner_unreachable';
export type AttemptStatus = 'queued' | 'accepted' | 'admitting' | 'leased' | 'running' | 'cancelling'
  | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'runner_unreachable' | 'infrastructure_failed';

export interface SecretVersion {
  name: string;
  secret_id: string;
  version_id: string;
  environment_id?: string;
}

export interface PlanStep {
  id: string;
  run: string;
  shell: 'sh' | 'bash' | 'pwsh' | 'cmd';
  working_directory: string;
  env: Record<string, string>;
  values?: Record<string, unknown>;
  outputs?: Record<string, { path: string; type: string; required: boolean }>;
  secrets: SecretVersion[];
  variable_names?: string[];
  secret_step_id?: string;
  timeout_ms: number;
}

export interface PlanJob {
  key: string;
  needs: string[];
  executor: Executor;
  toolchain: { name: string; digest: string; image: string; os: 'linux' | 'darwin' | 'windows'; architecture: 'amd64' | 'arm64' };
  producer_id: string;
  execution_backend?: 'local' | 'remote';
  remote_executor_id?: string;
  timeout_ms: number;
  infrastructure_retries: number;
  applicable: boolean;
  blocked_reason?: string | null;
  inapplicable_reason: string | null;
  steps: PlanStep[];
  cache: { key: string; paths: string[]; key_files: string[]; retention_seconds: number; mode?: 'read' | 'read_write' } | null;
  outputs: Record<string, { path: string; retention_seconds: number; max_bytes: number; type?: string; required?: boolean; format?: string; kind?: 'artifact' | 'report' | 'value' }>;
  inputs: Array<{ job: string; output: string; path: string }>;
  egress: { hosts: string[]; max_requests: number; max_bytes: number; max_request_bytes: number };
  environment: { id: string; artifact_job: string; artifact_name: string } | null;
  secret_selection_id?: string;
  secret_selection_digest?: string;
  variables?: Record<string, string>;
  limits?: { log_bytes: number; output_bytes: number; input_bytes: number; cache_bytes: number; chunk_bytes: number };
}

/** Only the trusted compiler adapter creates this; no API accepts a client plan. */
export interface ExecutionPlan {
  version: 1;
  repo_id: string;
  account_id: string;
  source_repo_id?: string;
  related_repo_ids?: string[];
  checkout_candidate_id?: string;
  source_evidence?: WorkflowSourceIdentity;
  commit_sha: string;
  source_ref: string;
  workflow_digest: string;
  workflow_version_id: string;
  policy_revision: number;
  trust: Trust;
  trigger: { type: string; id: string; pull_request_id?: string };
  concurrency: { key: string | null; supersede: boolean };
  jobs: PlanJob[];
  portable_manifest: unknown;
  actor: { id: string; kind: string; user_id: string | null; credential_id: string | null };
  routing_epoch: number;
}

export interface RunRecord {
  id: string; repo_id: string; account_id: string; workflow_id: string; workflow_version_id: string;
  commit_sha: string; source_ref: string; workflow_digest: string; plan_digest: string; plan_json: string;
  policy_revision: number; trigger_type: string; trigger_id: string; trust: Trust; concurrency_key: string | null;
  supersede: number; status: RunStatus; reason: string | null; requested_by: string; rerun_of: string | null;
  request_key: string; request_hash: string; revision: number; created_at: string; updated_at: string; completed_at: string | null;
  orchestration_generation: number;
  enqueue_sequence: number;
}

export interface JobRecord {
  id: string; repo_id: string; account_id: string; run_id: string; job_key: string; definition_json: string;
  status: JobStatus; reason: string | null; generation: number; current_attempt_id: string | null;
  reused_attempt_id: string | null; revision: number; created_at: string; updated_at: string; completed_at: string | null;
}

export interface AttemptRecord {
  id: string; repo_id: string; account_id: string; run_id: string; job_id: string; generation: number;
  plan_digest: string; toolchain_digest: string; producer_id: string; executor: 'hosted' | 'self_hosted';
  profile: string | null; pool_id: string | null; runner_id: string | null; runner_credential_generation: number | null;
  status: AttemptStatus; reason: string | null; reservation_id: string | null; credential_hash: string | null;
  lease_expires_at: string | null; deadline_at: string | null; queue_deadline_at: string;
  runtime_name: string | null; runtime_id: string | null; process_id: string | null; allocated_at: string | null;
  destruction_verified_at: string | null; cleanup_state: 'none' | 'required' | 'destroying' | 'verified' | 'unreachable';
  outcome_json: string | null; receipt_hash: string | null; started_at: string | null; completed_at: string | null;
  settled_at: string | null; revision: number; created_at: string; updated_at: string;
  reservation_fence: string | null; checkout_credential_id: string | null; execution_started_at: string | null;
  egress_bytes: number; egress_requests: number;
  execution_backend: 'local' | 'remote'; remote_executor_id: string | null;
  runner_slot_fence: string | null;
  runner_credential_hash: string | null;
  cleanup_lease_hash: string | null;
}

export interface AttemptIdentity {
  attempt_id: string;
  generation: number;
  plan_digest: string;
  runner_id: string;
}

export interface CompletionReceipt extends AttemptIdentity {
  protocol_receipt_digest?: string;
  conclusion: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'infrastructure_failed';
  exit_code: number | null;
  signal: string | null;
  resource_exhaustion: 'memory' | 'disk' | 'processes' | 'logs' | 'outputs' | 'egress' | null;
  toolchain_digest: string;
  outputs: Array<{ name: string; sha256: string; size_bytes: number }>;
  log_manifest_digest: string;
  process_group_stopped: boolean;
  started_at: string;
  finished_at: string;
}

export interface RunnerPool {
  id: string; account_id: string; repo_id: string | null; name: string;
  os: 'linux' | 'darwin' | 'windows'; architecture: 'amd64' | 'arm64'; toolchains_json: string;
  trust: Trust; isolation: 'persistent' | 'ephemeral'; max_runners: number; max_slots: number;
  state: 'active' | 'disabled'; revision: number; created_at: string; updated_at: string;
}

export interface RunnerRecord {
  id: string; account_id: string; repo_id: string | null; pool_id: string; name: string;
  os: string; architecture: string; toolchains_json: string; slots: number;
  credential_hash: string; credential_generation: number; credential_expires_at: string;
  state: 'active' | 'disabled' | 'revoked'; last_seen_at: string; revision: number; created_at: string; updated_at: string;
  disposable: number;
  assignment_attempt_id: string | null;
  disposable_consumed_at: string | null;
}

export interface ExecutionObject {
  id: string; repo_id: string; account_id: string; run_id: string; attempt_id: string; generation: number;
  kind: 'log' | 'output' | 'manifest' | 'cache' | 'snapshot'; name: string; sequence: number;
  object_key: string; sha256: string; size_bytes: number; content_type: string;
  state: 'uploading' | 'sealed' | 'deleting' | 'deleted'; expires_at: string; created_at: string; deleted_at: string | null;
  source_digest: string | null; final: number;
  source_size_bytes: number | null;
}

export interface AttemptContext { attempt: AttemptRecord; run: RunRecord; job: PlanJob; plan: ExecutionPlan; machine_authority?: RunnerAuthorityWitness }
export interface DispatchMessage { attempt_id: string; run_id?: string; generation?: number; shard_id?: string; cell_id?: string }
export interface RunWorkflowParams { mode: 'run' | 'attempt' | 'operation'; run_id: string; attempt_id?: string; operation_id?: string; orchestration_generation?: number; shard_id?: string }
export interface ExecutionServices { env: Bindings; db: Database }

export interface HostedProfile {
  name: 'linux-small';
  image: string;
  toolchain_digest: string;
  sdk_version: '0.2.0';
  sandbox_version: '0.12.1';
  vcpu: number;
  memory_mib: number;
  disk_mb: number;
  max_instances: number;
  max_job_ms: number;
  measurement: {
    evidence_sha256: string;
    measured_at: string;
    cold_start_p95_ms: number;
    teardown_p99_ms: number;
    isolation_verified: true;
    egress_verified: true;
    destruction_verified: true;
  };
}
