import type { Bindings } from '@gitknot/core';
import type { Rate } from './money.ts';
import type { CanonicalGitMeter, CanonicalGitReservation, HelperReservation } from './git-types.ts';

export interface BillingBindings extends Bindings {
  BILLING_PLATFORM_SLICE_ID?: string;
  BILLING_ESSENTIAL_SLICE_ID?: string;
  BILLING_GIT_STORAGE_SLICE_ID?: string;
  PAYMENTS?: Fetcher;
  PAYMENTS_SERVICE_KEY?: string;
  BACKUP_BUCKET?: R2Bucket;
}

export interface Attribution {
  account_id: string;
  repo_id: string | null;
  actor_id: string;
  workflow_id: string | null;
  team_id: string | null;
  run_id: string | null;
  attempt_id: string | null;
  generation: number | null;
}

export interface ExecutionAttribution extends Attribution { repo_id: string; run_id: string; attempt_id: string; generation: number }

export interface ReserveExecutionInput {
  account_id: string;
  repo_id: string;
  actor_id: string;
  workflow_id?: string | null;
  team_id?: string | null;
  run_id: string;
  attempt_id: string;
  generation: number;
  executor: 'hosted' | 'self_hosted';
  profile: string;
  maximum_duration_ms: number;
  maximum_storage_bytes?: string;
  storage_retention_seconds?: number;
  maximum_egress_bytes?: string;
}

export interface ExecutionQuote {
  execution_cell_id?: string;
  attribution: ExecutionAttribution;
  repository_storage_limit_bytes?: string;
  executor: ReserveExecutionInput['executor'];
  profile: string;
  duration_ms: number;
  storage_bytes: string;
  storage_retention_ms: number;
  storage_cleanup_grace_ms: number;
  maximum_objects: number;
  egress_bytes: string;
  rates: { compute: Rate; storage: Rate; egress: Rate };
  maximum_charge_units: string;
  maximum_platform_units: string;
  storage_charge_units: string;
  platform_storage_units: string;
  slice_id: string;
  routing_epoch: number;
  quoted_at: string;
}

export type PreviewExecutionInput = Omit<ReserveExecutionInput, 'run_id' | 'attempt_id' | 'generation'>;
export interface ExecutionQuotePreview extends Omit<ExecutionQuote, 'attribution' | 'slice_id'> {
  kind: 'preview';
  currency: 'USD';
  payer_account_id: string;
  attribution: Attribution & { repo_id: string; run_id: null; attempt_id: null; generation: null };
  slice_id: string | null;
  repository_revision: number;
  subscription: { initialized: boolean; plan_id: string; plan_version: string; revision: number | null;
    state: 'active' | 'past_due' | 'suspended' | 'cancelled' | 'uninitialized' };
  availability: { state: 'eligible' | 'unavailable'; admission_required: true; reasons: Array<{ code: string; message: string }> };
}

export type BudgetScope = 'account' | 'repository' | 'team' | 'workflow' | 'actor';

export interface Budget {
  id: string;
  account_id: string;
  scope: BudgetScope;
  scope_id: string;
  limit_units: string;
  safety_buffer_units: string;
  settled_units: string;
  reserved_units: string;
  commitment_units: string;
  period_start: string;
  period_end: string | null;
  threshold_percentages: number[];
  revision: number;
  stopped: boolean;
}

export interface AdmissionControl {
  id: string;
  kind: 'account' | 'capacity';
  account_id: string | null;
  revision: number;
  epoch: number;
  stopped: boolean;
  stop_reason: string | null;
  valid_until: string;
  max_concurrency: number;
  max_queue: number;
  max_storage_bytes: string;
  object_count?: number;
  max_objects?: number;
  active_slots: number;
  reserved_bytes: string;
  stored_bytes: string;
  budget_ids: string[];
  plan_budget_id?: string;
  next_ticket: number;
  next_event: number;
  closed_through?: string;
  coordinator_cell_id?: string;
}

export type ReservationState = 'queued' | 'preparing' | 'prepared' | 'reserved' | 'starting' | 'running' | 'settled' | 'cancelled';

export interface Reservation {
  id: string;
  fence: string;
  request_hash: string;
  state: ReservationState;
  quote: ExecutionQuote;
  budget_ids: string[];
  held_units: string;
  unassigned_storage_units: string;
  unassigned_storage_bytes: string;
  object_count: number;
  ticket: number;
  fair_key: string;
  runtime_id: string | null;
  started_at: string | null;
  deadline_at: string | null;
  settled_at: string | null;
  settlement_hash: string | null;
  actual_units: string | null;
  created_at: string;
  held_at: string | null;
  revision: number;
}

export interface ReservationResult {
  status: 'reserved' | 'queued' | 'running' | 'settled' | 'cancelled';
  account_id: string;
  reservation_id: string;
  fence: string;
  ticket: number;
  reason?: string;
  maximum_charge_units: string;
  maximum_platform_units: string;
  deadline_at: string | null;
}

export interface ReservationIdentity {
  account_id: string;
  reservation_id: string;
  fence: string;
}

export interface StartExecutionInput extends ReservationIdentity {
  runtime_id: string;
}

export interface TerminationProof {
  kind: 'hosted_destroyed' | 'customer_process_exited' | 'never_allocated';
  receipt_id: string;
  verified_at: string;
}

export interface SettleExecutionInput extends StartExecutionInput {
  event_id: string;
  duration_ms: number;
  egress_bytes?: string;
  termination_proof: TerminationProof;
  outcome: 'success' | 'failure' | 'cancelled' | 'timed_out' | 'infrastructure_failure';
}

export interface LedgerEntry extends Attribution {
  id: string;
  event_id: string;
  reservation_id: string | null;
  object_id: string | null;
  kind: 'usage' | 'infrastructure_refund' | 'subscription' | 'seat' | 'adjustment';
  operating_cost: boolean;
  quantity: string;
  amount_units: string;
  currency: 'USD';
  price_id: string;
  price_version: string;
  meter: string;
  meter_version: number;
  unit_price_units: string;
  unit_quantity: string;
  remainder_before: string;
  remainder_after: string;
  closing_remainder_before?: string;
  closing_remainder_after?: string;
  occurred_at: string;
  recorded_at: string;
  evidence_id: string;
}

export interface StorageObject {
  id: string;
  account_id: string;
  reservation_id: string;
  fence: string;
  key: string;
  bucket: 'blobs' | 'backups' | 'snapshots';
  state: 'uploading' | 'stored' | 'deleting' | 'deleted' | 'transferring' | 'transfer_pending' | 'transferred';
  source?: 'execution' | 'standalone';
  slice_id?: string;
  request_hash?: string;
  repository_limit_bytes?: string | null;
  admission_state?: 'preparing' | 'ready' | 'cancelled';
  maximum_bytes: string;
  bytes: string;
  commitment_units: string;
  budget_ids: string[];
  attribution: Attribution;
  rate: Rate;
  etag: string | null;
  checksum: string | null;
  created_at: string;
  budget_started_at: string;
  accrued_at: string;
  retention_until: string | null;
  funded_until?: string;
  renew_after?: string | null;
  renewal_policy?: StorageRenewalPolicy;
  funding_failure_at?: string | null;
  delete_after?: string | null;
  pending_renewal?: StorageRenewal | null;
  last_renewal_id?: string;
  transfer_operation_id?: string;
  destination_account_id?: string;
  transferred_at?: string;
  platform_object_id?: string;
  storage_cell_id?: string;
  storage_epoch?: number;
  placement_handoff_id?: string;
  placement_shadow?: boolean;
  billable_from?: string;
  billable_until?: string;
  import_source?: StorageImport;
  quota_handed_off?: boolean;
  deletion_request_id?: string;
  deletion_started_at?: string;
  commitment_until: string;
  deleted_at: string | null;
  revision: number;
}

export interface ReserveStorageInput extends ReservationIdentity {
  object_id: string;
  key: string;
  bucket: 'blobs' | 'backups' | 'snapshots';
  maximum_bytes: string;
  retention_until: string;
}

export interface CommitStorageInput extends ReservationIdentity {
  object_id: string;
  bytes: string;
  etag: string;
  checksum: string;
  uploaded_at?: string;
}

export interface StandaloneStorageInput {
  account_id: string; repo_id?: string | null; actor_id: string; object_id: string; key: string;
  bucket: 'blobs' | 'backups' | 'snapshots'; maximum_bytes: string; retention_until: string | null;
}

export interface StorageRenewalPolicy {
  commitment_seconds: number; renew_before_seconds: number; deletion_grace_seconds: number;
  on_renewal_failure: 'notify_block_writes_then_delete';
}

export interface StandaloneStorageTerms {
  input: StandaloneStorageInput; reservation_id: string; fence: string; request_hash: string; attribution: Attribution;
  slice_id: string; rate: Rate; repository_limit_bytes: string | null; maximum_units: string; maximum_platform_units: string;
  storage_cell_id: string;
  funded_until: string; commitment_until: string; renew_after: string | null; renewal_policy: StorageRenewalPolicy; created_at: string;
}

export interface StorageRenewal {
  id: string; delta_units: string; commitment_until: string; funded_until: string; renew_after: string | null;
  budget_ids: string[]; created_at: string;
}

export interface StorageImport {
  operation_id: string; source_account_id: string; source_object_id: string; source_platform_object_id: string;
  source_slice_id: string; platform_object_id: string; etag: string; checksum: string; reuse_physical_quota?: boolean;
}

export interface Journal {
  id: string;
  coordinator_id: string;
  sequence: number;
  created_at: string;
  control: AdmissionControl;
  budgets: Budget[];
  reservation?: Reservation;
  object?: StorageObject;
  ledger: LedgerEntry[];
  rollups: UsageRollup[];
  event_type: string;
  deletion_request?: StorageDeletionRequest;
  helper?: HelperReservation;
  git_operation?: CanonicalGitReservation;
  git_meters?: CanonicalGitMeter[];
}

export interface StorageDeletionRequest {
  id: string; account_id: string; repo_id: string | null; object_id: string; reservation_id: string; fence: string;
  reason: 'retention' | 'funding'; state: 'pending' | 'claimed' | 'financially_deleted' | 'cancelled';
  requested_at: string; delete_after: string;
  revision: number;
}

export interface CancelStorageIntentInput { account_id: string; object_id: string; repo_id?: string | null }
export interface StorageIntentCancellation {
  id: string; account_id: string; repo_id: string | null; key: string; bucket: StorageObject['bucket'];
  source: 'standalone'; state: 'cancelling' | 'cancelled'; reservation_id: string | null; fence: string | null;
}

export interface UsageRollup {
  account_id: string; period: string; dimension: 'account' | 'repository' | 'workflow' | 'team' | 'actor';
  dimension_id: string; meter: string; operating_cost: boolean; quantity: string; amount_units: string; revision: number;
}

export interface BillingTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options?: { prefix?: string; limit?: number; startAfter?: string }): Promise<Map<string, T>>;
}

export interface BillingCommand { id: string; request_hash: string }
export interface BillingCommandReceipt extends BillingCommand { kind: 'budget' | 'stop'; resource_id: string; revision: number }

export interface BillingStore extends BillingTransaction {
  transaction<T>(callback: (transaction: BillingTransaction) => Promise<T>): Promise<T>;
}
