CREATE TABLE workflow_environments (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  destination TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  required_approvals INTEGER NOT NULL DEFAULT 1 CHECK (required_approvals BETWEEN 0 AND 10),
  allow_self_approval INTEGER NOT NULL DEFAULT 0 CHECK (allow_self_approval IN (0,1)),
  allowed_approvers_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repo_id, name)
);
CREATE TABLE workflow_promotions (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  job_id TEXT REFERENCES workflow_jobs(id),
  environment_id TEXT NOT NULL REFERENCES workflow_environments(id),
  environment_revision INTEGER NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES execution_objects(id),
  artifact_digest TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  destination TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting','waiting_approval','approved','promoting','released','rejected','invalidated','cancelled')),
  requested_by TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  released_at TEXT,
  UNIQUE(repo_id, request_key)
);
CREATE INDEX workflow_promotions_environment ON workflow_promotions(repo_id, environment_id, status, created_at, id);
CREATE TABLE environment_approvals (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  promotion_id TEXT NOT NULL REFERENCES workflow_promotions(id),
  approver_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  destination TEXT NOT NULL,
  environment_revision INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  created_at TEXT NOT NULL,
  UNIQUE(promotion_id, approver_id)
);
CREATE TABLE workflow_releases (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  promotion_id TEXT NOT NULL UNIQUE REFERENCES workflow_promotions(id),
  environment_id TEXT NOT NULL REFERENCES workflow_environments(id),
  artifact_id TEXT NOT NULL REFERENCES execution_objects(id),
  artifact_digest TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  destination TEXT NOT NULL,
  accepted_target_commit TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER workflow_releases_immutable BEFORE UPDATE ON workflow_releases BEGIN
  SELECT RAISE(ABORT, 'released artifacts are immutable');
END;
