-- Core outbox/processed_events remain the committed source and receipt authority.
CREATE TABLE IF NOT EXISTS event_publications (
  event_id TEXT PRIMARY KEY REFERENCES outbox(id),
  last_enqueued_at TEXT,
  next_attempt_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS event_publications_due ON event_publications(next_attempt_at, event_id);

CREATE TABLE IF NOT EXISTS event_consumer_jobs (
  event_id TEXT NOT NULL REFERENCES outbox(id),
  consumer TEXT NOT NULL CHECK (consumer IN ('webhooks','mail','index','meter','operations')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  due_at TEXT NOT NULL,
  enqueued_at TEXT,
  lease_token TEXT,
  lease_until TEXT,
  cursor TEXT,
  error_code TEXT,
  completed_at TEXT,
  PRIMARY KEY(event_id,consumer)
);
CREATE INDEX IF NOT EXISTS event_consumer_jobs_due ON event_consumer_jobs(consumer,state,due_at,event_id);

CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  installation_id TEXT REFERENCES installations(id),
  principal_id TEXT NOT NULL,
  principal_json TEXT NOT NULL CHECK(json_valid(principal_json)),
  url TEXT NOT NULL,
  events_json TEXT NOT NULL CHECK(json_valid(events_json)),
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','disabled','revoked')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS webhooks_scope ON webhooks(repo_id,state,id);
CREATE INDEX IF NOT EXISTS webhooks_installation ON webhooks(installation_id,state);

CREATE TABLE IF NOT EXISTS webhook_keys (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id),
  secret_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','retiring','revoked')),
  valid_until TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_one_active_key ON webhook_keys(webhook_id) WHERE state='active';

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES outbox(id),
  webhook_id TEXT NOT NULL REFERENCES webhooks(id),
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  replay_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','succeeded','failed','cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  enqueued_at TEXT,
  lease_token TEXT,
  lease_until TEXT,
  last_status INTEGER,
  error_code TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(webhook_id,event_id,generation)
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(state,next_attempt_at,id);
CREATE INDEX IF NOT EXISTS webhook_deliveries_list ON webhook_deliveries(webhook_id,id);
CREATE INDEX IF NOT EXISTS webhook_deliveries_repo ON webhook_deliveries(repo_id,id);

CREATE TABLE IF NOT EXISTS webhook_attempts (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(id),
  repo_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('sending','succeeded','failed','uncertain','cancelled')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status INTEGER,
  error_code TEXT,
  duration_ms INTEGER,
  response_excerpt TEXT,
  response_truncated INTEGER NOT NULL DEFAULT 0,
  UNIQUE(delivery_id,attempt)
);

CREATE TABLE IF NOT EXISTS event_replays (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  webhook_id TEXT NOT NULL REFERENCES webhooks(id),
  actor_id TEXT NOT NULL,
  since_at TEXT NOT NULL,
  until_at TEXT NOT NULL,
  through_rowid INTEGER NOT NULL CHECK(through_rowid>=0),
  cursor TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','completed','cancelled')),
  delivered_count INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS event_replays_due ON event_replays(state,id);

CREATE TABLE IF NOT EXISTS email_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  transactional INTEGER NOT NULL DEFAULT 1 CHECK(transactional IN (0,1)),
  digest TEXT NOT NULL DEFAULT 'off' CHECK(digest IN ('off','daily','weekly')),
  next_digest_at TEXT,
  unsubscribe_token_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_deliveries (
  id TEXT PRIMARY KEY,
  event_id TEXT REFERENCES outbox(id),
  user_id TEXT REFERENCES users(id),
  account_id TEXT,
  repo_id TEXT,
  template TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','accepted','delivered','failed','cancelled','bounced','complained')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  enqueued_at TEXT,
  lease_token TEXT,
  lease_until TEXT,
  provider_message_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(template,reference_id,generation)
);
CREATE INDEX IF NOT EXISTS mail_deliveries_due ON mail_deliveries(state,next_attempt_at,id);
CREATE INDEX IF NOT EXISTS mail_deliveries_provider ON mail_deliveries(provider_message_id);

CREATE TABLE IF NOT EXISTS mail_provider_events (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES mail_deliveries(id),
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mail_suppressions (
  email_hash TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operation_steps (
  operation_id TEXT NOT NULL REFERENCES operations(id),
  name TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','running','completed','failed')),
  idempotency_key TEXT NOT NULL UNIQUE,
  receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  started_at TEXT,
  completed_at TEXT,
  PRIMARY KEY(operation_id,name)
);

CREATE TABLE IF NOT EXISTS operation_dispatches (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id),
  workflow_id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL DEFAULT 0,
  last_started_at TEXT,
  next_attempt_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT
);

CREATE TABLE IF NOT EXISTS repository_retention_pins (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  source_repo_id TEXT NOT NULL REFERENCES repositories(id),
  kind TEXT NOT NULL CHECK(kind IN ('fork','review','archive','legal_hold')),
  object_id TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS repository_retention_pins_source ON repository_retention_pins(source_repo_id,expires_at);

CREATE TABLE IF NOT EXISTS repository_archives (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id),
  repo_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('export','backup','deletion','move')),
  state TEXT NOT NULL CHECK(state IN ('writing','verified','expired')),
  format_version INTEGER NOT NULL DEFAULT 1,
  manifest_key TEXT,
  manifest_sha256 TEXT,
  archive_sha256 TEXT,
  routing_epoch INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  verified_at TEXT
);
CREATE INDEX IF NOT EXISTS repository_archives_scope ON repository_archives(repo_id,kind,created_at);

CREATE TABLE IF NOT EXISTS archive_parts (
  archive_id TEXT NOT NULL REFERENCES repository_archives(id),
  path TEXT NOT NULL,
  object_key TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK(bucket IN ('BLOBS','BACKUPS')),
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  PRIMARY KEY(archive_id,path)
);

CREATE TABLE IF NOT EXISTS shard_moves (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id),
  repo_id TEXT NOT NULL,
  source_cell_id TEXT NOT NULL,
  source_shard_id TEXT NOT NULL,
  target_cell_id TEXT NOT NULL,
  target_shard_id TEXT NOT NULL,
  source_epoch INTEGER NOT NULL,
  target_epoch INTEGER NOT NULL,
  source_state TEXT NOT NULL DEFAULT 'active',
  state TEXT NOT NULL CHECK(state IN ('copying','verifying','fenced','finalizing','completed','failed')),
  copy_cursor TEXT,
  manifest_sha256 TEXT,
  source_retained_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS storage_meter_cursors (
  manifest_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  repo_id TEXT,
  bytes INTEGER NOT NULL,
  metered_until TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS budget_alert_receipts (
  budget_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  threshold INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(budget_id,period_start,threshold)
);

CREATE TABLE IF NOT EXISTS operations_diagnostics (
  id TEXT PRIMARY KEY,
  component TEXT NOT NULL,
  resource_id TEXT,
  error_code TEXT NOT NULL,
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS operations_diagnostics_expiry ON operations_diagnostics(expires_at,id);
