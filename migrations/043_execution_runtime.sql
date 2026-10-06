ALTER TABLE execution_attempts ADD COLUMN reservation_fence TEXT;
ALTER TABLE execution_attempts ADD COLUMN checkout_credential_id TEXT;
ALTER TABLE execution_attempts ADD COLUMN execution_started_at TEXT;
ALTER TABLE execution_attempts ADD COLUMN egress_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE execution_attempts ADD COLUMN egress_requests INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runners ADD COLUMN disposable INTEGER NOT NULL DEFAULT 0 CHECK (disposable IN (0,1));
ALTER TABLE execution_objects ADD COLUMN source_digest TEXT;
ALTER TABLE execution_objects ADD COLUMN final INTEGER NOT NULL DEFAULT 0 CHECK (final IN (0,1));
CREATE TABLE execution_runtime_receipts (
  runtime_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES execution_attempts(id),
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  generation INTEGER NOT NULL,
  receipt_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('armed','destroying','destroyed')),
  armed_at TEXT NOT NULL,
  destroyed_at TEXT,
  updated_at TEXT NOT NULL
);
