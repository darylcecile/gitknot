-- Executor-owned facts. CP completion and destruction receipts remain authoritative.
CREATE TABLE local_hosted_checkpoints (
  attempt_id TEXT PRIMARY KEY REFERENCES execution_attempts(id),
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  generation INTEGER NOT NULL CHECK (generation > 0),
  plan_digest TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  toolchain_digest TEXT NOT NULL,
  runtime_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  draft_json TEXT,
  draft_hash TEXT,
  receipt_json TEXT,
  receipt_hash TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((draft_json IS NULL) = (draft_hash IS NULL)),
  CHECK ((receipt_json IS NULL) = (receipt_hash IS NULL))
);
CREATE INDEX local_hosted_checkpoints_repository ON local_hosted_checkpoints(repo_id, attempt_id, generation);
CREATE TRIGGER local_hosted_claim_immutable
BEFORE UPDATE OF attempt_id, repo_id, account_id, generation, plan_digest, producer_id, toolchain_digest, runtime_id, claim_id, claimed_at
ON local_hosted_checkpoints BEGIN SELECT RAISE(ABORT, 'local hosted claim is immutable'); END;
CREATE TRIGGER local_hosted_draft_immutable BEFORE UPDATE OF draft_json, draft_hash ON local_hosted_checkpoints
WHEN OLD.draft_hash IS NOT NULL AND (NEW.draft_hash IS NOT OLD.draft_hash OR NEW.draft_json IS NOT OLD.draft_json)
BEGIN SELECT RAISE(ABORT, 'local hosted draft is immutable'); END;
CREATE TRIGGER local_hosted_receipt_immutable BEFORE UPDATE OF receipt_json, receipt_hash ON local_hosted_checkpoints
WHEN OLD.receipt_hash IS NOT NULL AND (NEW.receipt_hash IS NOT OLD.receipt_hash OR NEW.receipt_json IS NOT OLD.receipt_json)
BEGIN SELECT RAISE(ABORT, 'local hosted receipt is immutable'); END;

CREATE TABLE local_hosted_log_chunks (
  attempt_id TEXT NOT NULL REFERENCES local_hosted_checkpoints(attempt_id),
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  generation INTEGER NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 0 AND 65535),
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 262144),
  data_base64 TEXT,
  object_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, generation, sequence)
);
CREATE INDEX local_hosted_logs_pending ON local_hosted_log_chunks(attempt_id, object_id, sequence);
