CREATE TABLE move_staging (
  operation_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  source_cell_id TEXT NOT NULL,
  source_shard_id TEXT NOT NULL,
  target_shard_id TEXT NOT NULL,
  source_epoch INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('initial','final')),
  state TEXT NOT NULL CHECK(state IN ('receiving','applying','verified','active')),
  snapshot_sha256 TEXT,
  native_storage_name TEXT,
  native_receipt_json TEXT CHECK(native_receipt_json IS NULL OR json_valid(native_receipt_json)),
  repository_state TEXT CHECK(repository_state IN ('active','archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE move_snapshot_rows (
  operation_id TEXT NOT NULL REFERENCES move_staging(operation_id),
  table_name TEXT NOT NULL,
  row_key INTEGER NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  sha256 TEXT NOT NULL,
  PRIMARY KEY(operation_id,table_name,row_key)
);
CREATE TABLE move_object_receipts (
  operation_id TEXT NOT NULL REFERENCES move_staging(operation_id),
  object_key TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK(bucket IN ('blobs','backups')),
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  PRIMARY KEY(operation_id,bucket,object_key)
);
CREATE TABLE move_repository_resources (
  repo_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  PRIMARY KEY(repo_id,resource_id)
);
CREATE TABLE usage_projection_entries (
  ledger_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  meter TEXT NOT NULL,
  meter_version INTEGER NOT NULL,
  price_version TEXT NOT NULL,
  quantity TEXT NOT NULL,
  amount_units TEXT NOT NULL,
  operating_cost INTEGER NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX usage_projection_account ON usage_projection_entries(account_id,occurred_at,ledger_id);
