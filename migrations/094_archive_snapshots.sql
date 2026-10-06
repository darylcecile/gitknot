CREATE TABLE archive_snapshots (
  archive_id TEXT PRIMARY KEY REFERENCES repository_archives(id),
  repository_json TEXT NOT NULL CHECK(json_valid(repository_json)),
  refs_json TEXT NOT NULL CHECK(json_valid(refs_json)),
  tables_json TEXT NOT NULL CHECK(json_valid(tables_json)),
  captured_at TEXT NOT NULL
);
CREATE TABLE archive_snapshot_rows (
  archive_id TEXT NOT NULL REFERENCES repository_archives(id),
  table_name TEXT NOT NULL,
  row_key INTEGER NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  PRIMARY KEY(archive_id,table_name,row_key)
);
CREATE TABLE repository_restore_plans (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id),
  archive_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('staging','prepared','applied','verified')),
  tables_json TEXT NOT NULL CHECK(json_valid(tables_json)),
  repository_json TEXT NOT NULL CHECK(json_valid(repository_json)),
  metadata_sha256 TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE repository_restore_rows (
  operation_id TEXT NOT NULL REFERENCES repository_restore_plans(operation_id),
  table_name TEXT NOT NULL,
  row_key INTEGER NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  PRIMARY KEY(operation_id,table_name,row_key)
);
CREATE TABLE repository_restore_objects (
  operation_id TEXT NOT NULL REFERENCES repository_restore_plans(operation_id),
  original_id TEXT NOT NULL,
  object_id TEXT NOT NULL UNIQUE,
  repo_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  object_key TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK(bucket IN ('blobs','backups')),
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  filename TEXT NOT NULL,
  reference_count INTEGER NOT NULL,
  retention_until TEXT,
  archive_prefix TEXT NOT NULL,
  PRIMARY KEY(operation_id,original_id)
);
CREATE TABLE repository_restore_previous_rows (
  operation_id TEXT NOT NULL REFERENCES repository_restore_plans(operation_id),
  table_name TEXT NOT NULL,
  row_key INTEGER NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  PRIMARY KEY(operation_id,table_name,row_key)
);
CREATE TABLE move_source_rows (
  operation_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_key INTEGER NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  PRIMARY KEY(operation_id,table_name,row_key)
);
CREATE TABLE move_source_snapshots (
  operation_id TEXT PRIMARY KEY,
  tables_json TEXT NOT NULL CHECK(json_valid(tables_json)),
  captured_at TEXT NOT NULL
);
