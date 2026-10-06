CREATE TABLE workflow_trigger_failures (
  event_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  commit_sha TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(event_id,workflow_id,commit_sha)
);
CREATE INDEX workflow_trigger_failures_repo ON workflow_trigger_failures(repo_id,created_at,event_id);
