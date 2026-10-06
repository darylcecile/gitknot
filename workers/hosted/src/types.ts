import type { RemoteAttemptGrant, RemoteCompletion, RemoteRuntimeStatus } from '@gitknot/execution/remote/protocol';
import type { RemoteAttemptController } from './controller.ts';
import type { HostedSandbox } from './sandbox.ts';

/** This account deliberately has no control-plane service or database binding. */
export interface HostedEnv {
  HOSTED_WORKFLOW: Workflow<HostedWorkflowParams>;
  HOSTED_ATTEMPTS: DurableObjectNamespace<RemoteAttemptController>;
  SANDBOX: DurableObjectNamespace<HostedSandbox>;
  BACKUP_BUCKET: R2Bucket;
  HOSTED_EXECUTOR_ID: string;
  HOSTED_CONTROL_KEY: string;
  HOSTED_CALLBACK_ORIGIN: string;
  HOSTED_PROFILES_JSON: string;
  ENVIRONMENT: string;
  HOSTED_TEST_ALLOW_LOOPBACK?: boolean;
}

export interface HostedWorkflowParams {
  attempt_id: string;
  generation: number;
  grant_digest: string;
}

export interface RuntimeIdentity extends HostedWorkflowParams {
  executor_id: string;
  producer_id: string;
  runtime_id: string;
  runtime_name: string;
  sandbox_id: string;
  deadline_at: string;
}

/** Only immutable job limits and transient source location, never credentials. */
export interface RuntimeGrant extends RuntimeIdentity {
  lease_expires_at: string;
  egress: RemoteAttemptGrant['job']['egress'];
  cache_bytes: number;
  source_url: string | null;
}

export interface RuntimeRecord extends RuntimeGrant {
  sealed: boolean;
  launch_claimed: boolean;
  started_at: string | null;
  destroyed_at: string | null;
  receipt_id: string | null;
  process_group_stopped: boolean;
  egress_bytes: number;
  egress_requests: number;
  egress_exhausted: boolean;
}

export interface RuntimeFacts extends RuntimeIdentity {
  sealed: boolean;
  running: boolean | null;
  in_flight: number;
  ephemeral_objects: number;
  started_at: string | null;
  destroyed_at: string | null;
  receipt_id: string | null;
  process_group_stopped: boolean;
  egress_bytes: number;
  egress_requests: number;
  egress_exhausted: boolean;
}

/** All fields are normalized facts. No exception messages or raw SDK results. */
export type CompletionDraft = Omit<RemoteCompletion, 'log_manifest_digest'> & { log_manifest_digest: string | null };

export interface AttemptJournal {
  grant: RemoteAttemptGrant;
  grant_digest: string;
  workflow_id: string;
  accepted_at: string;
  started_at: string | null;
  claimed: boolean;
  sealed: boolean;
  state: RemoteRuntimeStatus['state'];
  lease_expires_at: string;
  draft: CompletionDraft | null;
  completed: boolean;
  destroyed_delivered: boolean;
  next_log: number;
}

export const LIMITS = Object.freeze({
  grant_bytes: 1024 * 1024,
  chunk_bytes: 256 * 1024,
  log_bytes: 64 * 1024 ** 2,
  output_bytes: 1024 ** 3,
  input_bytes: 1024 ** 3,
  cache_bytes: 256 * 1024 ** 2,
  snapshot_overhead: 16 * 1024 ** 2,
  metadata_bytes: 65536,
  heartbeat_ms: 20_000,
  lease_ms: 90_000,
  callback_ms: 15_000,
  cleanup_ms: 30_000,
  reaper_shards: 16,
});

export const RUNTIME_KEY = 'hosted:runtime';
export const OPERATION_PREFIX = 'hosted:operation:';
export const OBJECT_PREFIX = 'hosted:object:';
export const ATTEMPT_KEY = 'hosted:attempt';
