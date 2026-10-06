-- Identity-primary control state. Physical placement is independent of account
-- ownership and survives the repository's directory cutover.
CREATE TABLE repository_move_controls (
  operation_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  source_cell_id TEXT NOT NULL,
  source_shard_id TEXT NOT NULL,
  source_epoch INTEGER NOT NULL CHECK(source_epoch>0),
  target_cell_id TEXT NOT NULL,
  target_shard_id TEXT NOT NULL,
  target_epoch INTEGER NOT NULL CHECK(target_epoch=source_epoch+1),
  source_storage_name TEXT NOT NULL,
  target_storage_name TEXT NOT NULL,
  source_state TEXT NOT NULL CHECK(source_state IN ('active','archived','deleted')),
  source_fence_id TEXT NOT NULL,
  target_fence_id TEXT,
  snapshot_sha256 TEXT,
  physical_sha256 TEXT,
  physical_count INTEGER CHECK(physical_count IS NULL OR physical_count>=0),
  archive_id TEXT NOT NULL,
  archive_manifest_sha256 TEXT,
  state TEXT NOT NULL CHECK(state IN ('preparing','copying','verified','cutover','committed','active','cleaning','completed','aborting','aborted')),
  effective_at TEXT,
  activated_at TEXT,
  source_barrier_released_at TEXT,
  source_retained_until TEXT,
  abort_epoch INTEGER,
  abort_requested_at TEXT,
  aborted_at TEXT,
  cleanup_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX repository_move_controls_cleanup ON repository_move_controls(source_cell_id,state,source_retained_until,operation_id);
CREATE TRIGGER repository_move_participants_immutable BEFORE UPDATE OF repo_id,account_id,source_cell_id,source_shard_id,source_epoch,
  target_cell_id,target_shard_id,target_epoch,source_storage_name,target_storage_name,source_state,source_fence_id,archive_id
  ON repository_move_controls
WHEN NEW.repo_id<>OLD.repo_id OR NEW.account_id<>OLD.account_id OR NEW.source_cell_id<>OLD.source_cell_id OR NEW.source_shard_id<>OLD.source_shard_id
  OR NEW.source_epoch<>OLD.source_epoch OR NEW.target_cell_id<>OLD.target_cell_id OR NEW.target_shard_id<>OLD.target_shard_id
  OR NEW.target_epoch<>OLD.target_epoch OR NEW.source_storage_name<>OLD.source_storage_name OR NEW.target_storage_name<>OLD.target_storage_name
  OR NEW.source_state<>OLD.source_state OR NEW.source_fence_id<>OLD.source_fence_id OR NEW.archive_id<>OLD.archive_id
BEGIN SELECT RAISE(ABORT,'move_participants_immutable'); END;
CREATE TRIGGER repository_move_boundary_immutable BEFORE UPDATE OF effective_at ON repository_move_controls
WHEN OLD.effective_at IS NOT NULL AND NEW.effective_at IS NOT OLD.effective_at
BEGIN SELECT RAISE(ABORT,'move_boundary_immutable'); END;
CREATE TRIGGER repository_move_snapshot_immutable BEFORE UPDATE OF snapshot_sha256,archive_manifest_sha256,physical_sha256,physical_count,target_fence_id ON repository_move_controls
WHEN (OLD.snapshot_sha256 IS NOT NULL AND NEW.snapshot_sha256 IS NOT OLD.snapshot_sha256)
  OR (OLD.archive_manifest_sha256 IS NOT NULL AND NEW.archive_manifest_sha256 IS NOT OLD.archive_manifest_sha256)
  OR (OLD.physical_sha256 IS NOT NULL AND NEW.physical_sha256 IS NOT OLD.physical_sha256)
  OR (OLD.physical_count IS NOT NULL AND NEW.physical_count IS NOT OLD.physical_count)
  OR (OLD.target_fence_id IS NOT NULL AND NEW.target_fence_id IS NOT OLD.target_fence_id)
BEGIN SELECT RAISE(ABORT,'move_snapshot_immutable'); END;

-- Placement-local physical-copy declarations and write receipts. These are not
-- canonical object manifests or account quota mirrors.
CREATE TABLE move_physical_objects (
  operation_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK(bucket IN ('blobs','backups','snapshots')),
  object_key TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes>=0),
  sha256 TEXT NOT NULL,
  source_etag TEXT NOT NULL,
  source_uploaded_at TEXT NOT NULL,
  custom_metadata_json TEXT NOT NULL CHECK(json_valid(custom_metadata_json)),
  http_metadata_json TEXT NOT NULL CHECK(json_valid(http_metadata_json)),
  state TEXT NOT NULL CHECK(state IN ('declared','writing','stored','deleting','deleted')),
  copy_fence TEXT,
  write_id TEXT,
  target_etag TEXT,
  target_uploaded_at TEXT,
  source_deleted_at TEXT,
  verified_at TEXT,
  PRIMARY KEY(operation_id,object_id),
  UNIQUE(operation_id,bucket,object_key)
);
CREATE INDEX move_physical_objects_scope ON move_physical_objects(repo_id,operation_id,state,object_id);
CREATE TRIGGER move_physical_identity_immutable BEFORE UPDATE OF operation_id,object_id,repo_id,account_id,bucket,object_key,bytes,sha256,
  source_etag,source_uploaded_at,custom_metadata_json,http_metadata_json ON move_physical_objects
BEGIN SELECT RAISE(ABORT,'move_physical_identity_immutable'); END;

CREATE TABLE move_applied_storage_receipts (
  operation_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
  applied_at TEXT NOT NULL,
  PRIMARY KEY(operation_id,object_id)
);
CREATE TRIGGER move_applied_storage_receipts_immutable BEFORE UPDATE ON move_applied_storage_receipts
BEGIN SELECT RAISE(ABORT,'move_storage_receipt_immutable'); END;
