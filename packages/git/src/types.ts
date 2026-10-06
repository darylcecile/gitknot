import type { Principal } from '@gitknot/core';

export const ZERO_OID = '0'.repeat(40);
export const INTERNAL_REFS = 'refs/gitknot/';
export const GIT_SERVICE_SCOPE = 'git-service';
export const GIT_NATIVE_SCOPE = 'git-native';
export const GIT_COORDINATOR_SCOPE = 'git-coordinator';

export interface GitLimits {
  max_pack_bytes: number;
  max_inflated_bytes: number;
  max_blob_bytes: number;
  max_objects: number;
  max_commits: number;
  max_refs: number;
  max_paths: number;
  max_tree_entries: number;
  max_metadata_bytes: number;
  max_output_bytes: number;
  max_repository_bytes: number;
  max_work_ms: number;
  max_process_memory_bytes: number;
  max_concurrent_sessions: number;
  lfs_object_bytes: number;
  lfs_repository_bytes: number;
  lfs_batch_objects: number;
}

export const DEFAULT_GIT_LIMITS: Readonly<GitLimits> = Object.freeze({
  max_pack_bytes: 96 * 1024 * 1024,
  max_inflated_bytes: 512 * 1024 * 1024,
  max_blob_bytes: 32 * 1024 * 1024,
  max_objects: 250_000,
  max_commits: 10_000,
  max_refs: 128,
  max_paths: 20_000,
  max_tree_entries: 500_000,
  max_metadata_bytes: 2 * 1024 * 1024,
  max_output_bytes: 1024 * 1024 * 1024,
  max_repository_bytes: 1024 * 1024 * 1024,
  max_work_ms: 180_000,
  max_process_memory_bytes: 2 * 1024 * 1024 * 1024,
  max_concurrent_sessions: 4,
  lfs_object_bytes: 512 * 1024 * 1024,
  lfs_repository_bytes: 10 * 1024 * 1024 * 1024,
  lfs_batch_objects: 100,
});

export type MergeStrategy = 'merge' | 'squash' | 'rebase' | 'ff-only';

export type GitCheckExpression =
  | { type: 'check'; key: string; producers: string[]; workflow_digest?: string; paths?: { include: string[]; exclude: string[] } }
  | { type: 'all' | 'any'; checks: GitCheckExpression[] };

export interface GitRule {
  version?: 1;
  id?: string;
  target: string | string[];
  updates?: 'any' | 'pull_request_only' | 'blocked';
  history?: {
    allow_force_push?: boolean;
    allow_deletion?: boolean;
    allow_creation?: boolean;
    linear?: boolean;
  };
  files?: {
    denied_paths?: string[];
    allowed_paths?: string[];
    max_bytes?: number;
    block_secrets?: boolean;
    secret_literals?: string[];
    inspect_all_supplied_objects?: boolean;
  };
  signatures?: { commits?: boolean; tags?: boolean; annotated_tags?: boolean };
  reviews?: {
    minimum?: number;
    disallow_author_approval?: boolean;
    required_owners?: Record<string, string[]>;
    resolved_threads?: boolean;
    required_reviewers?: string[];
  };
  verification?: {
    required: string[];
    revision?: 'merge_candidate';
    trusted_producers?: string[];
    expression?: GitCheckExpression;
  };
  merge_strategies?: MergeStrategy[];
  push?: { allowed_principals: string[] };
  bypass?: { capability: 'rules.break_glass'; reason_required: true; maximum_duration_seconds: number };
}

export interface SignatureTrust {
  ssh_signers: string[];
  openpgp_keys: string[];
  openpgp_fingerprints: string[];
}

export interface GitPolicy {
  revision: number;
  digest?: string;
  rules: GitRule[];
  signatures: SignatureTrust;
  limits: GitLimits;
  bypasses?: Array<{ id: string; reason: string; rule_ids: string[]; refs: string[]; expires_at: string }>;
}

export interface RefUpdate {
  ref: string;
  old_oid: string;
  new_oid: string;
}

export interface RefEvidence extends RefUpdate {
  policy_ref: string;
  paths: string[];
  new_commits: string[];
  fast_forward: boolean;
  object_count: number;
  inflated_bytes: number;
  lfs_objects: Array<{ oid: string; size: number }>;
  pathless?: boolean;
}

export interface GitEvidence {
  version: 1;
  updates: RefEvidence[];
  supplied_objects: number;
  supplied_bytes: number;
  policy_revision: number;
  policy_digest?: string;
  digest: string;
  marker_oid: string;
  marker_object_bytes?: string;
  storage?: GitStorageEvidence;
  review?: Record<string, unknown>;
}

export interface GitStorageEvidence {
  model: 'logical-reachable-v1';
  baseline_bytes: string;
  reachable_bytes: string;
  new_object_bytes: string;
  object_count: string;
  object_manifest_digest: string;
  maximum_growth_bytes: string;
}

export interface GitRemote {
  url: string;
  authorization?: string;
  /** Local paths/file:// are accepted only by the explicit test/development authority. */
  authority: 'artifacts' | 'local';
}

/** Observed creation-time provider metadata, not an inference from a remote URL. */
export interface GitStorageCreationEvidence {
  version: 1;
  provider: 'artifacts' | 'local';
  storage_name: string;
  provider_id: string;
  marker: string;
}

export interface GitStorageProvisionOptions {
  create_only?: boolean;
  ownership_marker?: string;
}

export interface GitRepositoryContext {
  id: string;
  owner_id: string;
  storage_name: string;
  default_branch: string;
  policy_revision: number;
  routing_epoch: number;
}

export type GitOperationKind = 'push' | 'refs' | 'edit' | 'import' | 'fork' | 'candidate' | 'merge' | 'restore' | 'restack' | 'retain';
export type GitOperationState = 'receiving' | 'validated' | 'publishing' | 'uncertain' | 'committed' | 'rejected';

export interface GitOperation {
  id: string;
  repo_id: string;
  repository: GitRepositoryContext;
  actor: Principal;
  kind: GitOperationKind;
  state: GitOperationState;
  routing_epoch: number;
  policy_revision: number;
  policy_digest?: string;
  publisher_id: string;
  request_digest?: string;
  fence_hash: string;
  created_at: string;
  updated_at: string;
  deadline_at: string;
  evidence?: GitEvidence;
  result?: PublicationResult;
  error?: { code: string; message: string };
  finalized: boolean;
  candidate?: CandidateContext;
  bypasses?: Array<{ id: string; reason: string }>;
  restore?: GitRestoreContext;
  source_repo_id?: string;
  restack?: GitRestackContext;
  storage_admission?: { requested: true; reservation_id?: string; fence?: string; settled: boolean };
  review?: GitReviewContext;
  merge_queue?: GitMergeQueueContext;
  placement?: { cell_id: string; shard_id: string };
  maintenance?: GitMaintenanceMove;
  move?: GitMoveRestore;
}

/** Server-derived physical-move proof. The original credential remains the actor. */
export interface GitMoveRestore {
  operation_id: string;
  repo_id: string;
  account_id: string;
  actor_id: string;
  actor_sha256: string;
  request_sha256: string;
  placement_fence: string;
  placement_request_sha256: string;
  source: { cell_id: string; shard_id: string; epoch: number; storage_name: string; fence_id: string };
  destination: { cell_id: string; shard_id: string; epoch: number; storage_name: string; fence_id: string };
  snapshot_sha256: string;
  repository_sha256: string;
  repository_revision: number;
  archive_id: string;
  manifest_sha256: string;
  restore_sha256: string;
}

/** Server-derived authority for a byte-identical, credentialless storage move. */
export interface GitMaintenanceMove {
  purpose: 'repository.move';
  operation_id: string;
  repo_id: string;
  account_id: string;
  actor_id: 'system:operations';
  source: { cell_id: string; shard_id: string; epoch: number };
  destination: { cell_id: string; shard_id: string; epoch: number };
  archive_id: string;
  manifest_sha256: string;
  request_sha256: string;
  snapshot_sha256: string;
  barrier_token_hash: string;
  restore: GitRestoreContext;
  repository: { visibility: 'public' | 'private' | 'internal' | 'unlisted'; fork_source_id: string | null;
    default_branch: string; policy_revision: number; storage_name: string };
}

export interface GitMergeQueueContext { id: string; operation_id: string; patch_id: string }

export interface CandidateContext {
  id: string;
  source_repo_id: string;
  source_oid: string;
  target_ref: string;
  target_oid: string;
  strategy: MergeStrategy;
  pull_request_id?: string;
}

export interface PublicationResult {
  outcome: 'committed' | 'rejected' | 'uncertain';
  operation_id: string;
  refs: RefUpdate[];
  marker_oid: string | null;
  report_status: Array<{ ref: string; status: string }>;
  proof?: 'not_started' | 'report_status' | 'marker';
  reason?: string;
}

export interface PublicationPermit {
  operation_id: string;
  publisher_id: string;
  evidence_digest: string;
  marker_oid: string;
  remote: GitRemote;
}

export interface PublicGitOperation {
  id: string;
  operation_id: string;
  repo_id: string;
  actor_id: string;
  kind: GitOperationKind;
  state: GitOperationState;
  policy_revision: number;
  routing_epoch: number;
  result: PublicationResult | null;
  error: { code: string; message: string } | null;
  finalized: boolean;
  created_at: string;
  updated_at: string;
}

export interface GitMovePublisherRequest {
  operation_id: string;
  side: 'source' | 'target';
  action: 'read' | 'settle';
}

export interface GitMovePublisherState {
  operation_id: string;
  repo_id: string;
  storage_name: string;
  cell_id: string;
  shard_id: string;
  state: GitOperationState | 'not_started';
  terminal: boolean;
  finalized: boolean;
  closed: boolean;
}

export interface NativeSessionSpec {
  repository: GitRepositoryContext;
  remote: GitRemote;
  policy: GitPolicy;
  mode: 'read' | 'receive' | 'mutate' | 'inspect';
  operation_id?: string;
  publisher_id?: string;
  fence?: string;
  actor_id?: string;
  kind?: GitOperationKind;
  callback_url?: string;
  candidate?: CandidateContext;
  candidate_read_ref?: string;
  retained_refs?: string[];
  restore?: GitRestoreContext;
  review?: GitReviewContext;
}

export interface GitRestoreContext {
  archive_id: string;
  bundle_sha256: string;
  bundle_bytes: number;
  expected_refs: Array<{ ref: string; oid: string }>;
}

export interface NativeSessionTicket {
  id: string;
  token: string;
  expires_at: string;
}

export interface BrowserEdit {
  path: string;
  content_base64?: string;
  delete?: boolean;
  mode?: '100644' | '100755';
}

export type GitMutation =
  | { kind: 'refs'; updates: RefUpdate[] }
  | { kind: 'edit'; ref: string; expected_oid: string; message: string; edits: BrowserEdit[]; author: GitAuthor }
  | { kind: 'import' | 'fork'; source: GitRemote }
  | { kind: 'candidate'; candidate: CandidateContext; source?: GitRemote; author: GitAuthor; message: string }
  | { kind: 'merge'; candidate: CandidateContext; candidate_oid: string }
  | ({ kind: 'restack'; source?: GitRemote } & GitRestackContext)
  | { kind: 'retain'; review: GitReviewContext; source?: GitRemote };

export interface GitReviewContext {
  id: string;
  source_repo_id: string;
  base_oid: string;
  head_oid: string;
}

export interface GitRestackContext {
  ref: string;
  expected_oid: string;
  old_base_oid: string;
  onto_oid: string;
  onto_repo_id: string;
  pull_request_id: string;
}

export interface GitAuthor { name: string; email: string }

export interface GitMutationRequest {
  operation_id: string;
  actor: Principal;
  mutation: GitMutation;
}

export interface GitCapabilitiesAttestation {
  version: 1;
  authority: 'artifacts';
  account_id: string;
  namespace: string;
  native_image: string;
  tested_at: string;
  expires_at: string;
  atomic: true;
  conditional: true;
  failed_atomic_unchanged: true;
  stale_publisher_excluded: true;
  acceptance_recovery: true;
  max_pack_bytes: number;
  evidence_key: string;
}
