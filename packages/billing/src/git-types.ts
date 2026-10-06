import type { Attribution, StorageRenewalPolicy } from './types.ts';
import type { Rate } from './money.ts';

export interface EssentialServiceInput {
  service: 'git-helper'; allocation_id: string; profile: string; maximum_duration_ms: number; maximum_egress_bytes: string;
}
export interface EssentialServiceIdentity { service: 'git-helper'; allocation_id: string; reservation_id: string; fence: string }
export interface EssentialServiceSettlement extends EssentialServiceIdentity {
  event_id: string; duration_ms: number; egress_bytes: string;
  termination_proof: { kind: 'container_destroyed' | 'never_allocated'; receipt_id: string; verified_at: string };
}
export interface HelperQuote {
  input: EssentialServiceInput; reservation_id: string; fence: string; request_hash: string; slice_id: string; created_at: string;
  maximum_operations: number; rates: { compute: Rate; egress: Rate; operations: Rate }; maximum_units: string;
  profile_version: string;
}
export interface HelperReservation extends HelperQuote {
  state: 'reserved' | 'started' | 'settled'; started_at: string | null; settled_at: string | null;
  actual_units: string | null; settlement_hash: string | null; revision: number;
}

export interface CanonicalGitStorageInput {
  account_id: string; repo_id: string; actor_id: string; operation_id: string; storage_name: string; routing_epoch: number;
  maximum_growth_bytes: string; retention_until: null;
}
export interface CanonicalGitCommit {
  account_id: string; repo_id: string; operation_id: string; reservation_id: string; fence: string;
  reachable_bytes: string; new_object_bytes: string; object_count: string; evidence_digest: string; marker_oid: string; verified_at: string;
}
export interface CanonicalGitAbort {
  account_id: string; repo_id: string; operation_id: string; reservation_id?: string; fence?: string; rejection_evidence_id: string;
}
export interface CanonicalGitQuote {
  input: CanonicalGitStorageInput; reservation_id: string; fence: string; request_hash: string; slice_id: string; created_at: string;
  repository_revision: number; policy_revision: number; baseline_bytes: string; reachable_bytes: string; object_count: string;
  evidence_digest: string; marker_oid: string; maximum_units: string; maximum_platform_units: string;
  funding_days: number; repository_limit_bytes: string; rates: { logical: Rate; peak: Rate };
  retained_baseline_bytes: string;
  funded_until: string; commitment_until: string; renew_after: string; renewal_policy: StorageRenewalPolicy;
  storage_cell_id?: string; placement_operation_id?: string;
}
export interface CanonicalGitReservation extends CanonicalGitQuote {
  state: 'prepared' | 'reserved' | 'committed' | 'aborted'; held_units: string; budget_ids: string[];
  verified_at: string | null; receipt_hash: string | null; revision: number;
}
export interface CanonicalGitMeter {
  id: string; account_id: string; repo_id: string; storage_name: string; routing_epoch: number; attribution: Attribution;
  logical_bytes: string; retained_bound_bytes: string; object_count: string; commitment_units: string; budget_ids: string[];
  budget_started_at: string; accrued_at: string; funded_until: string; commitment_until: string; renew_after: string; peak_day: string; peak_bytes: string;
  rates: { logical: Rate; peak: Rate }; slice_id: string; last_operation_id: string; revision: number;
  renewal_policy: StorageRenewalPolicy; funding_failure_at: string | null; state: 'stored' | 'transferring' | 'transfer_pending' | 'transferred' | 'purged' | 'cancelled';
  pending_renewal?: GitRenewal | null;
  storage_cell_id?: string; placement_handoff_id?: string; billable_from?: string; billable_until?: string;
  transfer_operation_id?: string; destination_account_id?: string; transferred_at?: string; purged_at?: string;
}
export interface GitFundingWindow { funded_until: string; commitment_until: string; renew_after: string }
export interface GitRenewal extends GitFundingWindow { id: string; delta_units: string; prepared_at: string; budget_ids: string[] }
export interface GitPublicationAuthority {
  repo_id: string; id: string; actor_id: string; kind: string; state: string; routing_epoch: number; policy_revision: number; publisher_id: string;
  revision: number; context_json: string; evidence_json: string | null; result_json: string | null; error_json: string | null;
  created_at: string; updated_at: string;
}
export interface GitPurgeAuthority { operation_id: string; repo_id: string; account_id: string; storage_name: string; confirmed_at: string; receipt_json: string }
