import type { StorageObject } from './types.ts';
import type { CanonicalGitMeter } from './git-types.ts';

export interface StoragePlacementInput {
  operation_id: string; repo_id: string; source_cell_id: string; source_shard_id: string;
  target_cell_id: string; target_shard_id: string; source_epoch: number;
}
export interface StoragePlacement extends StoragePlacementInput {
  account_id: string; actor_id: string; target_epoch: number; fence: string; request_hash: string;
  state: 'preparing' | 'prepared' | 'committing' | 'active' | 'complete' | 'aborting' | 'aborted';
  target_slice_id: string | null; target_git_slice_id: string | null; source_storage_name: string; target_storage_name: string;
  effective_at: string | null; created_at: string; revision: number;
  purpose?: 'move' | 'archive_restore'; archive_id?: string | null; archive_manifest_sha256?: string | null;
  archive_refs?: Array<{ ref: string; oid: string }> | null; archive_git_bytes?: string | null;
}
export interface PlacementCopy {
  operation_id: string; object_id: string; copy_id: string; source_id: string; source: StorageObject;
  destination: StorageObject; state: 'preparing' | 'reserved' | 'writing' | 'failed' | 'verified' | 'stored' | 'active' | 'cleaned' | 'aborted' | 'released';
  writer_id: string; receipt: { etag: string; uploaded_at: string; checksum: string; bytes: string } | null;
  deleted_at: string | null;
}
export interface PlacementGitHold {
  operation_id: string; account_id: string; repo_id: string; actor_id: string; storage_name: string; slice_id: string;
  bytes: string; maximum_units: string; maximum_platform_units: string; created_at: string;
  commitment_until: string; source: CanonicalGitMeter | null;
  rates: CanonicalGitMeter['rates'];
  scratch_rate: StorageObject['rate']; scratch_platform_units: string;
  repository_limit_bytes: string;
  scratch_bytes?: string;
  state: 'reserved' | 'consumed' | 'cancelled';
}
export interface PlacementProgress { operation_id: string; state: StoragePlacement['state']; processed: number; remaining: boolean; fence: string }

export interface PlacementPublicationFence {
  version: 1; operation_id: string; repo_id: string; storage_name: string; placement_fence: string; side: 'source' | 'target';
  source_epoch: number; target_epoch: number;
  state: 'not_started' | 'committed' | 'rejected'; finalized: true; writer_fenced: true;
}

/** Provider-observed creation metadata, bound to the private marker in the original grant. */
export interface PlacementGitCreationProof {
  version: 1; marker: string; provider_id: string; storage_name: string; provider: 'local' | 'artifacts';
}

export interface PlacementNamespaceCleanup {
  version: 1; operation_id: string; repo_id: string; storage_name: string; placement_fence: string;
  side: 'source' | 'target'; outcome: 'deleted' | 'unallocated'; observed_at: string; existed: boolean;
}
