CREATE TABLE runner_credential_exchanges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('register','rotate')),
  runner_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  scope_repo_id TEXT,
  metadata_authority TEXT NOT NULL CHECK(metadata_authority IN ('identity','repository')),
  metadata_repo_id TEXT,
  enrollment_id TEXT,
  source_hash TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  expected_generation INTEGER NOT NULL CHECK(expected_generation>=0),
  credential_id TEXT NOT NULL,
  credential_generation INTEGER NOT NULL,
  credential_json TEXT NOT NULL CHECK(json_valid(credential_json)),
  projection_json TEXT NOT NULL CHECK(json_valid(projection_json)),
  projection_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','committed')),
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  committed_at TEXT,
  CHECK(metadata_authority='identity' OR metadata_repo_id IS NOT NULL),
  CHECK(credential_generation=expected_generation+1),
  CHECK((state='committed')=(committed_at IS NOT NULL)),
  UNIQUE(kind,source_hash,expected_generation),
  UNIQUE(runner_id,credential_generation)
);
CREATE TRIGGER runner_exchanges_immutable BEFORE UPDATE ON runner_credential_exchanges
WHEN NEW.id<>OLD.id OR NEW.kind<>OLD.kind OR NEW.runner_id<>OLD.runner_id OR NEW.pool_id<>OLD.pool_id OR NEW.account_id<>OLD.account_id
 OR NEW.scope_repo_id IS NOT OLD.scope_repo_id OR NEW.metadata_authority<>OLD.metadata_authority OR NEW.metadata_repo_id IS NOT OLD.metadata_repo_id
 OR NEW.enrollment_id IS NOT OLD.enrollment_id OR NEW.source_hash<>OLD.source_hash OR NEW.nonce_hash<>OLD.nonce_hash OR NEW.request_hash<>OLD.request_hash
 OR NEW.expected_generation<>OLD.expected_generation OR NEW.credential_id<>OLD.credential_id OR NEW.credential_generation<>OLD.credential_generation
 OR NEW.credential_json<>OLD.credential_json OR NEW.projection_json<>OLD.projection_json OR NEW.projection_hash<>OLD.projection_hash
 OR NEW.response_json<>OLD.response_json OR NEW.expires_at<>OLD.expires_at OR NEW.created_at<>OLD.created_at
 OR (OLD.state='committed' AND (NEW.state<>OLD.state OR NEW.committed_at<>OLD.committed_at))
BEGIN
  SELECT RAISE(ABORT,'credential exchange records are immutable');
END;
CREATE TRIGGER runner_exchanges_retained BEFORE DELETE ON runner_credential_exchanges
BEGIN SELECT RAISE(ABORT,'credential exchange records are retained'); END;
CREATE TABLE runner_credential_exchange_locks (
  runner_id TEXT PRIMARY KEY,
  exchange_id TEXT NOT NULL UNIQUE REFERENCES runner_credential_exchanges(id),
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- Placement-local typed receipts. They contain hashes/public metadata only and
-- travel with repository-owned runner metadata. They are not identity authority.
CREATE TABLE runner_exchange_projections (
  exchange_id TEXT PRIMARY KEY,
  repo_id TEXT,
  runner_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('register','rotate')),
  projection_hash TEXT NOT NULL,
  credential_hash TEXT NOT NULL,
  credential_generation INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE TRIGGER runner_projection_immutable BEFORE UPDATE ON runner_exchange_projections
BEGIN SELECT RAISE(ABORT,'runner_projection_immutable'); END;
CREATE TRIGGER runner_projection_retained BEFORE DELETE ON runner_exchange_projections
BEGIN SELECT RAISE(ABORT,'runner_projection_retained'); END;
-- Identity-primary retirement intents also fence admission while their metadata
-- acknowledgement is uncertain. No metadata foreign keys cross D1 authorities.
CREATE TABLE runner_retirements (
  runner_id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  metadata_authority TEXT NOT NULL CHECK(metadata_authority IN ('identity','repository')),
  metadata_repo_id TEXT,
  credential_generation INTEGER NOT NULL,
  credential_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('revoked','disposable')),
  attempt_id TEXT,
  attempt_generation INTEGER,
  slot_fence TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','committed')),
  created_at TEXT NOT NULL,
  committed_at TEXT,
  CHECK(metadata_authority='identity' OR metadata_repo_id IS NOT NULL),
  CHECK((state='committed')=(committed_at IS NOT NULL)),
  CHECK(kind='revoked' OR (attempt_id IS NOT NULL AND attempt_generation IS NOT NULL AND slot_fence IS NOT NULL))
);
CREATE TRIGGER runner_retirement_immutable BEFORE UPDATE ON runner_retirements
WHEN NEW.runner_id<>OLD.runner_id OR NEW.pool_id<>OLD.pool_id OR NEW.account_id<>OLD.account_id
 OR NEW.metadata_authority<>OLD.metadata_authority OR NEW.metadata_repo_id IS NOT OLD.metadata_repo_id
 OR NEW.credential_generation<>OLD.credential_generation OR NEW.credential_hash<>OLD.credential_hash OR NEW.kind<>OLD.kind
 OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.attempt_generation IS NOT OLD.attempt_generation OR NEW.slot_fence IS NOT OLD.slot_fence
 OR NEW.created_at<>OLD.created_at OR (OLD.state='committed' AND (NEW.state<>OLD.state OR NEW.committed_at IS NOT OLD.committed_at))
BEGIN SELECT RAISE(ABORT,'runner_retirement_immutable'); END;
CREATE TRIGGER runner_retirement_retained BEFORE DELETE ON runner_retirements
BEGIN SELECT RAISE(ABORT,'runner_retirement_retained'); END;
CREATE TABLE runner_retirement_projections (
  runner_id TEXT PRIMARY KEY,
  repo_id TEXT,
  account_id TEXT NOT NULL,
  credential_generation INTEGER NOT NULL,
  credential_hash TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
CREATE TRIGGER runner_retirement_projection_immutable BEFORE UPDATE ON runner_retirement_projections
BEGIN SELECT RAISE(ABORT,'runner_retirement_projection_immutable'); END;
CREATE TRIGGER runner_retirement_projection_retained BEFORE DELETE ON runner_retirement_projections
BEGIN SELECT RAISE(ABORT,'runner_retirement_projection_retained'); END;
-- Written before a management mutation; a lost cross-D1 acknowledgement leaves
-- a bounded, retryable reconciliation job even when HTTP request replay is done.
CREATE TABLE runner_authority_reconciliations (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','committed')),
  created_at TEXT NOT NULL,
  committed_at TEXT
);
CREATE INDEX runner_authority_reconciliation_pending ON runner_authority_reconciliations(state,created_at,id);
-- Safety-changing metadata writes require the same distributed account barrier
-- used by credential/grant revocation. Heartbeat timestamps do not change authority.
CREATE TRIGGER runner_pool_authority_barrier BEFORE UPDATE OF state,account_id,repo_id,os,architecture,toolchains_json,trust,isolation,max_runners,max_slots ON runner_pools
WHEN (NEW.state<>OLD.state OR NEW.account_id<>OLD.account_id OR NEW.repo_id IS NOT OLD.repo_id OR NEW.os<>OLD.os OR NEW.architecture<>OLD.architecture
 OR NEW.toolchains_json<>OLD.toolchains_json OR NEW.trust<>OLD.trust OR NEW.isolation<>OLD.isolation OR NEW.max_runners<>OLD.max_runners OR NEW.max_slots<>OLD.max_slots)
 AND NOT EXISTS (SELECT 1 FROM account_authority_epochs e JOIN account_policy_barriers b ON b.account_id=e.account_id AND b.id=e.barrier_id WHERE e.account_id=OLD.account_id AND e.phase='fenced')
 AND NOT EXISTS (SELECT 1 FROM account_authority_fences WHERE account_id=OLD.account_id AND phase='fenced')
BEGIN SELECT RAISE(ABORT,'runner_account_authority_barrier_required'); END;
CREATE TRIGGER runner_enrollment_authority_barrier BEFORE UPDATE OF expires_at,account_id,repo_id,pool_id,token_hash,created_by ON runner_enrollments
WHEN (NEW.expires_at<>OLD.expires_at OR NEW.account_id<>OLD.account_id OR NEW.repo_id IS NOT OLD.repo_id OR NEW.pool_id<>OLD.pool_id
 OR NEW.token_hash<>OLD.token_hash OR NEW.created_by<>OLD.created_by)
 AND NOT EXISTS (SELECT 1 FROM account_authority_epochs e JOIN account_policy_barriers b ON b.account_id=e.account_id AND b.id=e.barrier_id WHERE e.account_id=OLD.account_id AND e.phase='fenced')
 AND NOT EXISTS (SELECT 1 FROM account_authority_fences WHERE account_id=OLD.account_id AND phase='fenced')
BEGIN SELECT RAISE(ABORT,'runner_account_authority_barrier_required'); END;
CREATE TRIGGER runner_identity_immutable BEFORE UPDATE ON runners
WHEN NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id OR NEW.repo_id IS NOT OLD.repo_id OR NEW.pool_id<>OLD.pool_id OR NEW.disposable<>OLD.disposable
 OR NEW.credential_generation<OLD.credential_generation
 OR (NEW.credential_hash<>OLD.credential_hash AND NEW.credential_generation<>OLD.credential_generation+1)
 OR (OLD.state='revoked' AND NEW.state<>'revoked')
 OR (OLD.assignment_attempt_id IS NOT NULL AND (NEW.assignment_attempt_id IS NOT OLD.assignment_attempt_id OR NEW.disposable_consumed_at IS NOT OLD.disposable_consumed_at))
BEGIN SELECT RAISE(ABORT,'runner_identity_immutable'); END;
CREATE TRIGGER runner_pool_identity_immutable BEFORE UPDATE ON runner_pools
WHEN NEW.id<>OLD.id OR NEW.account_id<>OLD.account_id OR NEW.repo_id IS NOT OLD.repo_id
BEGIN SELECT RAISE(ABORT,'runner_pool_identity_immutable'); END;
CREATE TRIGGER runner_machine_authority_barrier BEFORE UPDATE OF state,account_id,repo_id,pool_id,credential_hash,credential_generation,credential_expires_at,os,architecture,toolchains_json,slots,disposable ON runners
WHEN (NEW.state<>OLD.state OR NEW.account_id<>OLD.account_id OR NEW.repo_id IS NOT OLD.repo_id OR NEW.pool_id<>OLD.pool_id OR NEW.credential_hash<>OLD.credential_hash
 OR NEW.credential_generation<>OLD.credential_generation OR NEW.credential_expires_at<>OLD.credential_expires_at OR NEW.os<>OLD.os OR NEW.architecture<>OLD.architecture
 OR NEW.toolchains_json<>OLD.toolchains_json OR NEW.slots<>OLD.slots OR NEW.disposable<>OLD.disposable)
 AND NOT EXISTS (SELECT 1 FROM account_authority_epochs e JOIN account_policy_barriers b ON b.account_id=e.account_id AND b.id=e.barrier_id WHERE e.account_id=OLD.account_id AND e.phase='fenced')
 AND NOT EXISTS (SELECT 1 FROM account_authority_fences WHERE account_id=OLD.account_id AND phase='fenced')
BEGIN SELECT RAISE(ABORT,'runner_account_authority_barrier_required'); END;
