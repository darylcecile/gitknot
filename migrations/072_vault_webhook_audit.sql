CREATE TABLE vault_webhook_signatures (
  id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, event_id TEXT NOT NULL, webhook_id TEXT NOT NULL,
  account_id TEXT NOT NULL, repo_id TEXT NOT NULL, timestamp INTEGER NOT NULL, body_sha256 TEXT NOT NULL,
  key_ids_json TEXT NOT NULL CHECK(json_valid(key_ids_json)), service_client_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX vault_webhook_signature_delivery ON vault_webhook_signatures(delivery_id,created_at,id);
CREATE UNIQUE INDEX vault_one_running_recovery ON vault_recovery_verifications(state) WHERE state='running';
