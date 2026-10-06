CREATE TABLE workflow_run_requests (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('run','rerun','cancel','approve','promote')),
  run_id TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','cancelled')),
  result_json TEXT,
  error_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX workflow_run_requests_pending ON workflow_run_requests(status,next_attempt_at,id);
CREATE INDEX workflow_run_requests_run ON workflow_run_requests(repo_id,run_id,kind);
CREATE TRIGGER workflow_request_identity_immutable BEFORE UPDATE OF id,repo_id,account_id,actor_id,kind,run_id,input_json ON workflow_run_requests BEGIN
  SELECT RAISE(ABORT,'workflow operation identity is immutable');
END;
