CREATE TABLE account_exports (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_by TEXT NOT NULL,
  principal_json TEXT NOT NULL CHECK(json_valid(principal_json)),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version=1),
  state TEXT NOT NULL CHECK(state IN ('queued','capturing','verifying','completed','failed','deleting','deleted','expired')),
  revision INTEGER NOT NULL DEFAULT 1,
  account_snapshot_at TEXT,
  tables_json TEXT CHECK(tables_json IS NULL OR json_valid(tables_json)),
  repository_set_sha256 TEXT,
  manifest_key TEXT,
  manifest_sha256 TEXT,
  checksum_sha256 TEXT,
  size_bytes INTEGER,
  error_code TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX account_exports_account ON account_exports(account_id,created_by,id);
CREATE INDEX account_exports_cleanup ON account_exports(state,expires_at,id);
CREATE INDEX collaboration_inbox_event_retention ON collaboration_inbox(source_event_id,state);
CREATE TABLE account_export_rows (
  export_id TEXT NOT NULL REFERENCES account_exports(id),
  table_name TEXT NOT NULL,
  row_key INTEGER NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  PRIMARY KEY(export_id,table_name,row_key)
);
CREATE TRIGGER account_export_rows_immutable BEFORE UPDATE ON account_export_rows
BEGIN SELECT RAISE(ABORT,'account_export_snapshot_immutable'); END;
CREATE TABLE account_export_repositories (
  export_id TEXT NOT NULL REFERENCES account_exports(id),
  repo_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  archive_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','verified','deleting','deleted')),
  receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  PRIMARY KEY(export_id,repo_id),
  UNIQUE(operation_id),
  UNIQUE(archive_id)
);
CREATE TRIGGER account_export_repository_receipt_immutable BEFORE UPDATE OF receipt_json ON account_export_repositories
WHEN OLD.receipt_json IS NOT NULL AND NEW.receipt_json IS NOT OLD.receipt_json
BEGIN SELECT RAISE(ABORT,'account_export_repository_receipt_immutable'); END;
CREATE TABLE account_export_audiences (
  export_id TEXT NOT NULL REFERENCES account_exports(id),
  repo_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  PRIMARY KEY(export_id,repo_id,capability)
);
CREATE TABLE account_export_parts (
  export_id TEXT NOT NULL REFERENCES account_exports(id),
  path TEXT NOT NULL,
  object_id TEXT NOT NULL REFERENCES object_manifests(id),
  object_key TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes>=0),
  sha256 TEXT NOT NULL,
  row_count INTEGER,
  PRIMARY KEY(export_id,path),
  UNIQUE(object_id)
);
CREATE TRIGGER account_export_parts_immutable BEFORE UPDATE ON account_export_parts
BEGIN SELECT RAISE(ABORT,'account_export_part_immutable'); END;
CREATE TABLE account_export_assets (
  export_id TEXT NOT NULL REFERENCES account_exports(id),
  object_id TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY(export_id,object_id)
);
CREATE TABLE account_export_repository_rows (
  export_id TEXT NOT NULL REFERENCES account_exports(id),
  repository_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_key INTEGER NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  PRIMARY KEY(export_id,repository_id,table_name,row_key)
);
CREATE TRIGGER account_export_repository_rows_immutable BEFORE UPDATE ON account_export_repository_rows
BEGIN SELECT RAISE(ABORT,'account_export_repository_snapshot_immutable'); END;
