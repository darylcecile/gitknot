-- A timeout permits a new guarded D1 generation, never a replacement external
-- publisher. Every guarded mutation compares both generation and attempt_id in
-- the transaction containing its source event, audit record, and business effects.
ALTER TABLE idempotency_keys ADD COLUMN strategy TEXT NOT NULL DEFAULT 'legacy'
  CHECK (strategy IN ('legacy','mutation','external'));
ALTER TABLE idempotency_keys ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0);
ALTER TABLE idempotency_keys ADD COLUMN attempt_id TEXT;
ALTER TABLE idempotency_keys ADD COLUMN lease_expires_at TEXT;
ALTER TABLE idempotency_keys ADD COLUMN operation_id TEXT;
ALTER TABLE idempotency_keys ADD COLUMN audit_id TEXT;
ALTER TABLE idempotency_keys ADD COLUMN committed_at TEXT;
ALTER TABLE idempotency_keys ADD COLUMN policy_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(policy_json));
ALTER TABLE idempotency_keys ADD COLUMN recovery_path TEXT;

CREATE TABLE idempotency_write_guards (
  id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CONSTRAINT idempotency_generation_current CHECK (ok = 1)
);
CREATE INDEX idempotency_recovery ON idempotency_keys(strategy, status, lease_expires_at);

-- Earlier records did not establish fenced execution or current response
-- authorization. Retain their deduplication tombstones, not their cached data.
UPDATE idempotency_keys SET response_body=NULL,response_headers_json=NULL;
