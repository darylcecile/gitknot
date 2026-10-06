PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE mutation_guards (
  id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CONSTRAINT mutation_requires_one_row CHECK (ok = 1)
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  occurred_at TEXT NOT NULL,
  actor_id TEXT,
  resource_id TEXT NOT NULL,
  resource_revision INTEGER NOT NULL,
  repo_id TEXT,
  account_id TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  last_error TEXT
);
CREATE INDEX outbox_dispatch ON outbox(status, next_attempt_at, id);
CREATE INDEX outbox_repo_history ON outbox(repo_id, occurred_at DESC, id DESC);
CREATE INDEX outbox_account_history ON outbox(account_id, occurred_at DESC, id DESC);

CREATE TABLE processed_events (
  consumer TEXT NOT NULL,
  event_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (consumer, event_id)
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  repo_id TEXT,
  actor_id TEXT,
  credential_id TEXT,
  action TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_revision INTEGER,
  request_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  created_at TEXT NOT NULL
);
CREATE INDEX audit_account ON audit_log(account_id, created_at DESC, id DESC);
CREATE INDEX audit_repository ON audit_log(repo_id, created_at DESC, id DESC);

CREATE TABLE idempotency_keys (
  principal_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','complete','uncertain')),
  response_status INTEGER,
  response_body TEXT,
  response_headers_json TEXT,
  replayable INTEGER NOT NULL DEFAULT 1 CHECK (replayable IN (0,1)),
  resource_id TEXT,
  repo_id TEXT,
  account_id TEXT,
  event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, key)
);
CREATE INDEX idempotency_expiry ON idempotency_keys(status, expires_at);

CREATE TABLE resource_routes (
  resource_id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 1 CHECK (epoch > 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','moving','fenced','deleted')),
  destination_cell_id TEXT,
  destination_shard_id TEXT,
  operation_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX resource_routes_cell ON resource_routes(cell_id, shard_id, state);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  repo_id TEXT,
  account_id TEXT,
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','waiting','running','completed','failed','cancelled')),
  phase TEXT NOT NULL DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  revision INTEGER NOT NULL DEFAULT 1,
  input_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(input_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  workflow_id TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX operations_account ON operations(account_id, created_at DESC, id DESC);
CREATE INDEX operations_repository ON operations(repo_id, created_at DESC, id DESC);
CREATE INDEX operations_pending ON operations(status, updated_at, id);

CREATE TABLE object_manifests (
  id TEXT PRIMARY KEY,
  repo_id TEXT,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  object_key TEXT NOT NULL,
  bucket TEXT NOT NULL DEFAULT 'blobs' CHECK (bucket IN ('blobs','backups')),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  sha256 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('reserving','pending','uploading','ready','deleting','deleted','failed')),
  created_by TEXT NOT NULL,
  retention_until TEXT,
  requested_retention_until TEXT,
  billing_reservation_id TEXT,
  billing_fence TEXT,
  upload_generation INTEGER NOT NULL DEFAULT 0,
  upload_bytes_received INTEGER NOT NULL DEFAULT 0,
  upload_failure TEXT,
  reference_count INTEGER NOT NULL DEFAULT 0 CHECK (reference_count >= 0),
  revision INTEGER NOT NULL DEFAULT 1,
  storage_accrued_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (bucket, object_key)
);
CREATE INDEX objects_repository ON object_manifests(repo_id, kind, created_at DESC, id DESC);
CREATE INDEX objects_expiry ON object_manifests(state, retention_until, id);
CREATE INDEX objects_account ON object_manifests(account_id, state, id);

CREATE TABLE storage_quotas (
  scope_id TEXT PRIMARY KEY,
  limit_bytes INTEGER NOT NULL CHECK (limit_bytes >= 0),
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  CHECK (used_bytes + reserved_bytes <= limit_bytes)
);

CREATE TABLE internal_nonces (
  scope TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (scope, nonce)
);
CREATE INDEX internal_nonce_expiry ON internal_nonces(expires_at);
