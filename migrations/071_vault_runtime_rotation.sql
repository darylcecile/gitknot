CREATE TABLE vault_selections (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, repo_id TEXT NOT NULL, actor_id TEXT NOT NULL, actor_credential_id TEXT,
  workflow_id TEXT NOT NULL, selection_digest TEXT NOT NULL, context_json TEXT NOT NULL CHECK(json_valid(context_json)),
  steps_json TEXT NOT NULL CHECK(json_valid(steps_json)), plan_digest TEXT, created_at TEXT NOT NULL, bound_at TEXT
);
CREATE INDEX vault_selections_plan ON vault_selections(repo_id,plan_digest,selection_digest);
CREATE TABLE vault_use_events (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, repo_id TEXT NOT NULL, attempt_id TEXT NOT NULL, generation INTEGER NOT NULL,
  step_id TEXT NOT NULL, plan_digest TEXT NOT NULL, selection_digest TEXT NOT NULL, actor_id TEXT NOT NULL,
  version_ids_json TEXT NOT NULL CHECK(json_valid(version_ids_json)), service_client_id TEXT NOT NULL,
  authorization_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX vault_use_attempt ON vault_use_events(repo_id,attempt_id,generation,created_at,id);
CREATE TABLE vault_key_rotations (
  id TEXT PRIMARY KEY, target_key_id TEXT NOT NULL REFERENCES vault_key_registry(id), cursor TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK(state IN ('running','complete','failed')), rewrapped_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE vault_recovery_verifications (
  id TEXT PRIMARY KEY, key_id TEXT NOT NULL REFERENCES vault_key_registry(id), cursor TEXT NOT NULL DEFAULT '',
  catalog_revision INTEGER NOT NULL, verified_count INTEGER NOT NULL DEFAULT 0, chain_hash TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK(state IN ('running','complete','failed')), created_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE vault_webhook_keys (
  id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, account_id TEXT NOT NULL, repo_id TEXT NOT NULL,
  ciphertext_id TEXT NOT NULL REFERENCES vault_ciphertexts(id), created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  revoked_at TEXT, UNIQUE(webhook_id,id)
);
CREATE INDEX vault_webhook_keys_hook ON vault_webhook_keys(webhook_id,id);
