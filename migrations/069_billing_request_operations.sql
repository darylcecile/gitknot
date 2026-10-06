CREATE TABLE billing_api_operations (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('budget','stop','subscription','seat','credit','collection')),
  input_json TEXT NOT NULL CHECK(json_valid(input_json)), request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','complete')), resource_id TEXT, dispatched_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX billing_api_operations_account ON billing_api_operations(account_id,created_at,id);
