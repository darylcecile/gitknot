ALTER TABLE execution_attempts ADD COLUMN runner_slot_fence TEXT;
ALTER TABLE execution_attempts ADD COLUMN runner_credential_hash TEXT;
-- Historical cleanup proof is captured at allocation. A seeded runner replica
-- cannot establish a historical machine credential, so no replica backfill runs.
CREATE TABLE runner_slot_reservations (
  attempt_id TEXT PRIMARY KEY,
  runner_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  generation INTEGER NOT NULL,
  pool_id TEXT,
  runner_credential_generation INTEGER,
  runner_credential_hash TEXT,
  credential_id TEXT,
  credential_revision INTEGER,
  authority_epoch INTEGER,
  authority_policy_revision INTEGER,
  runner_revision INTEGER,
  pool_revision INTEGER,
  slot_limit INTEGER NOT NULL DEFAULT 1 CHECK(slot_limit BETWEEN 1 AND 16),
  disposable INTEGER NOT NULL DEFAULT 0 CHECK(disposable IN (0,1)),
  fence TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','leased','closed')),
  expires_at TEXT NOT NULL,
  assigned_at TEXT,
  cleanup_proof_json TEXT CHECK(cleanup_proof_json IS NULL OR json_valid(cleanup_proof_json)),
  cleanup_proof_hash TEXT,
  cleanup_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX runner_slots_active ON runner_slot_reservations(runner_id,state,expires_at);
INSERT INTO runner_slot_reservations(attempt_id,runner_id,repo_id,account_id,generation,pool_id,runner_credential_generation,fence,state,expires_at,assigned_at,created_at,updated_at)
SELECT a.id,a.runner_id,a.repo_id,a.account_id,a.generation,a.pool_id,a.runner_credential_generation,'legacy:'||a.id,
  -- A retained attempt is historical evidence, not current cleanup authority.
  -- Reconciliation must verify cleanup at its actual locator before closing it.
  'leased',
  COALESCE(a.lease_expires_at,a.queue_deadline_at),a.allocated_at,a.created_at,a.updated_at
FROM execution_attempts a WHERE a.runner_id IS NOT NULL AND a.allocated_at IS NOT NULL;
CREATE TRIGGER runner_slot_identity_immutable BEFORE UPDATE ON runner_slot_reservations
WHEN NEW.attempt_id<>OLD.attempt_id OR NEW.repo_id<>OLD.repo_id OR NEW.account_id<>OLD.account_id OR NEW.generation<>OLD.generation
  OR (OLD.assigned_at IS NOT NULL AND (NEW.runner_id<>OLD.runner_id OR NEW.fence<>OLD.fence OR NEW.assigned_at IS NOT OLD.assigned_at
    OR NEW.pool_id IS NOT OLD.pool_id OR NEW.disposable<>OLD.disposable OR NEW.credential_id IS NOT OLD.credential_id
    OR NEW.runner_credential_generation IS NOT OLD.runner_credential_generation OR NEW.runner_credential_hash IS NOT OLD.runner_credential_hash
    OR NEW.state='reserved'))
  OR (OLD.state='closed' AND OLD.assigned_at IS NOT NULL AND NEW.state<>'closed')
  OR (OLD.cleanup_proof_hash IS NOT NULL AND (NEW.cleanup_proof_hash IS NOT OLD.cleanup_proof_hash
    OR NEW.cleanup_proof_json IS NOT OLD.cleanup_proof_json OR NEW.cleanup_verified_at IS NOT OLD.cleanup_verified_at))
BEGIN SELECT RAISE(ABORT,'runner_slot_identity_immutable'); END;
CREATE TRIGGER runner_slot_cleanup_required BEFORE UPDATE ON runner_slot_reservations
WHEN OLD.state='leased' AND NEW.state='closed' AND (NEW.cleanup_proof_hash IS NULL OR NEW.cleanup_proof_json IS NULL OR NEW.cleanup_verified_at IS NULL)
BEGIN SELECT RAISE(ABORT,'runner_slot_cleanup_required'); END;
CREATE TRIGGER runner_slot_history_retained BEFORE DELETE ON runner_slot_reservations
WHEN OLD.assigned_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'runner_slot_history_retained'); END;
CREATE TABLE runner_disposable_consumption (
  runner_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  credential_generation INTEGER NOT NULL,
  consumed_at TEXT NOT NULL
);
CREATE TRIGGER runner_disposable_consumption_immutable BEFORE UPDATE ON runner_disposable_consumption
BEGIN SELECT RAISE(ABORT,'runner_disposable_consumption_immutable'); END;
CREATE TRIGGER runner_disposable_consumption_retained BEFORE DELETE ON runner_disposable_consumption
BEGIN SELECT RAISE(ABORT,'runner_disposable_consumption_retained'); END;
CREATE TABLE runner_job_offers (
  attempt_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  pool_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('offered','closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX runner_offers_pool ON runner_job_offers(account_id,pool_id,state,created_at,attempt_id);
CREATE TRIGGER runner_offer_identity_immutable BEFORE UPDATE ON runner_job_offers
WHEN NEW.attempt_id<>OLD.attempt_id OR NEW.repo_id<>OLD.repo_id OR NEW.account_id<>OLD.account_id OR NEW.pool_id<>OLD.pool_id OR NEW.generation<>OLD.generation
BEGIN SELECT RAISE(ABORT,'runner_offer_identity_immutable'); END;
-- Machine proof survives lease revocation, credential rotation and late cleanup.
CREATE TRIGGER attempt_runner_identity_retained BEFORE UPDATE ON execution_attempts
WHEN OLD.executor='self_hosted' AND (OLD.allocated_at IS NOT NULL OR OLD.cleanup_state='verified')
 AND (NEW.runner_id IS NOT OLD.runner_id OR NEW.runner_credential_generation IS NOT OLD.runner_credential_generation
   OR NEW.runner_credential_hash IS NOT OLD.runner_credential_hash OR NEW.runner_slot_fence IS NOT OLD.runner_slot_fence
   OR NEW.allocated_at IS NOT OLD.allocated_at OR NEW.runtime_id IS NOT OLD.runtime_id)
BEGIN SELECT RAISE(ABORT,'attempt_runner_identity_retained'); END;
CREATE TRIGGER attempt_runner_cleanup_retained BEFORE UPDATE ON execution_attempts
WHEN OLD.executor='self_hosted' AND OLD.cleanup_state='verified'
 AND (NEW.cleanup_state<>'verified' OR NEW.destruction_verified_at IS NOT OLD.destruction_verified_at
   OR NEW.receipt_hash IS NOT OLD.receipt_hash OR NEW.status IN ('queued','accepted','admitting','leased','running'))
BEGIN SELECT RAISE(ABORT,'attempt_runner_cleanup_retained'); END;
