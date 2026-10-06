CREATE TABLE webhook_key_operations (
  operation_id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id),
  repo_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  key_id TEXT NOT NULL UNIQUE,
  expected_revision INTEGER NOT NULL,
  overlap_seconds INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','completed','unattached')),
  secret_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX webhook_key_operations_scope ON webhook_key_operations(webhook_id,created_at,operation_id);
