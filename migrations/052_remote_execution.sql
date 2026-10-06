ALTER TABLE execution_attempts ADD COLUMN execution_backend TEXT NOT NULL DEFAULT 'local' CHECK(execution_backend IN ('local','remote'));
ALTER TABLE execution_attempts ADD COLUMN remote_executor_id TEXT;
CREATE TABLE remote_execution_dispatches (
  attempt_id TEXT PRIMARY KEY REFERENCES execution_attempts(id),
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  generation INTEGER NOT NULL,
  executor_id TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  callback_origin TEXT NOT NULL,
  key_binding TEXT NOT NULL,
  callback_token_hash TEXT NOT NULL,
  callback_key_binding TEXT NOT NULL,
  grant_digest TEXT NOT NULL,
  grant_json TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  sandbox_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','accepted','running','destroyed','failed')),
  draft_json TEXT,
  draft_hash TEXT,
  termination_json TEXT,
  last_dispatch_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX remote_execution_pending ON remote_execution_dispatches(state,updated_at,attempt_id);
CREATE TRIGGER remote_execution_grant_immutable BEFORE UPDATE OF
  attempt_id,repo_id,account_id,run_id,generation,executor_id,producer_id,origin,callback_origin,key_binding,callback_token_hash,callback_key_binding,grant_digest,grant_json,runtime_id,created_at
ON remote_execution_dispatches BEGIN
  SELECT RAISE(ABORT,'remote execution grants are immutable');
END;
CREATE TRIGGER remote_execution_sandbox_pinned BEFORE UPDATE OF sandbox_id ON remote_execution_dispatches
WHEN OLD.sandbox_id IS NOT NULL AND NEW.sandbox_id IS NOT OLD.sandbox_id BEGIN
  SELECT RAISE(ABORT,'remote Sandbox identity is immutable');
END;
CREATE TABLE remote_execution_snapshots (
  attempt_id TEXT PRIMARY KEY REFERENCES execution_attempts(id),
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  generation INTEGER NOT NULL,
  snapshot_id TEXT NOT NULL,
  archive_object_id TEXT REFERENCES execution_objects(id),
  metadata_object_id TEXT REFERENCES execution_objects(id),
  namespace TEXT NOT NULL,
  cache_key TEXT,
  snapshot_json TEXT,
  state TEXT NOT NULL CHECK(state IN ('uploading','sealed','deleted')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(attempt_id,snapshot_id)
);
CREATE TABLE remote_execution_caches (
  namespace TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  snapshot_attempt_id TEXT NOT NULL REFERENCES remote_execution_snapshots(attempt_id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(namespace,cache_key)
);
