CREATE TABLE billing_storage_handoffs (
  operation_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, from_account_id TEXT NOT NULL, to_account_id TEXT NOT NULL,
  actor_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('preparing','prepared','committing','complete','aborting','aborted')),
  effective_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE billing_storage_transfers (
  operation_id TEXT NOT NULL REFERENCES billing_storage_handoffs(operation_id), object_id TEXT NOT NULL,
  from_account_id TEXT NOT NULL, to_account_id TEXT NOT NULL, repo_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('preparing','prepared','complete','aborted')),
  source_json TEXT NOT NULL CHECK(json_valid(source_json)), receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  effective_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(operation_id,object_id)
);
CREATE INDEX billing_storage_transfer_pending ON billing_storage_transfers(operation_id,state,object_id);
