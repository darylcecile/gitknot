CREATE TABLE execution_secret_steps (
  attempt_id TEXT NOT NULL REFERENCES execution_attempts(id),
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  generation INTEGER NOT NULL,
  step_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(attempt_id,generation,step_id)
);
