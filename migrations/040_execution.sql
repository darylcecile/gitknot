-- Workflow definitions are versioned separately from mutable catalog pointers.
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  current_version_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','disabled')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(repo_id, name),
  UNIQUE(repo_id, path)
);
CREATE TABLE workflow_versions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) DEFERRABLE INITIALLY DEFERRED,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  source_commit TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  definition TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  approved_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workflow_id, source_commit, definition_digest, policy_revision)
);
CREATE TRIGGER workflow_versions_immutable BEFORE UPDATE ON workflow_versions BEGIN
  SELECT RAISE(ABORT, 'workflow versions are immutable');
END;
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id),
  commit_sha TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  workflow_digest TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  trust TEXT NOT NULL CHECK (trust IN ('trusted','untrusted')),
  concurrency_key TEXT,
  supersede INTEGER NOT NULL DEFAULT 0 CHECK (supersede IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('queued','running','waiting','waiting_approval','cancelling','succeeded','failed','cancelled','timed_out','not_applicable','runner_unreachable')),
  reason TEXT,
  requested_by TEXT NOT NULL,
  rerun_of TEXT REFERENCES workflow_runs(id),
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(repo_id, request_key)
);
CREATE TRIGGER workflow_run_plan_immutable BEFORE UPDATE OF repo_id, account_id, workflow_id, workflow_version_id, commit_sha, source_ref, workflow_digest, plan_digest, plan_json, policy_revision, trigger_type, trigger_id, trust ON workflow_runs BEGIN
  SELECT RAISE(ABORT, 'run provenance is immutable');
END;
CREATE INDEX workflow_runs_repository ON workflow_runs(repo_id, created_at DESC, id DESC);
CREATE INDEX workflow_runs_concurrency ON workflow_runs(repo_id, concurrency_key, status, created_at);
CREATE INDEX workflow_runs_recovery ON workflow_runs(status, updated_at, id);
CREATE TABLE workflow_jobs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  job_key TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting','ready','queued','admitting','running','waiting_approval','cancelling','succeeded','failed','dependency_blocked','cancelled','timed_out','not_applicable','runner_unreachable')),
  reason TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  current_attempt_id TEXT,
  reused_attempt_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(run_id, job_key)
);
CREATE INDEX workflow_jobs_run ON workflow_jobs(repo_id, run_id, job_key);
CREATE INDEX workflow_jobs_ready ON workflow_jobs(status, account_id, created_at, id);
CREATE TABLE workflow_job_dependencies (
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  job_id TEXT NOT NULL REFERENCES workflow_jobs(id),
  dependency_id TEXT NOT NULL REFERENCES workflow_jobs(id),
  PRIMARY KEY(job_id, dependency_id)
);
CREATE TABLE runner_pools (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  repo_id TEXT REFERENCES repositories(id),
  name TEXT NOT NULL,
  os TEXT NOT NULL CHECK (os IN ('linux','darwin','windows')),
  architecture TEXT NOT NULL CHECK (architecture IN ('amd64','arm64')),
  toolchains_json TEXT NOT NULL,
  trust TEXT NOT NULL CHECK (trust IN ('trusted','untrusted')),
  isolation TEXT NOT NULL CHECK (isolation IN ('persistent','ephemeral')),
  max_runners INTEGER NOT NULL CHECK (max_runners BETWEEN 1 AND 1000),
  max_slots INTEGER NOT NULL DEFAULT 1 CHECK (max_slots BETWEEN 1 AND 16),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','disabled')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, name)
);
CREATE TABLE runner_enrollments (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  repo_id TEXT REFERENCES repositories(id),
  pool_id TEXT NOT NULL REFERENCES runner_pools(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  runner_id TEXT,
  registration_hash TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE runners (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  repo_id TEXT REFERENCES repositories(id),
  pool_id TEXT NOT NULL REFERENCES runner_pools(id),
  name TEXT NOT NULL,
  os TEXT NOT NULL,
  architecture TEXT NOT NULL,
  toolchains_json TEXT NOT NULL,
  slots INTEGER NOT NULL DEFAULT 1 CHECK (slots BETWEEN 1 AND 16),
  credential_hash TEXT NOT NULL UNIQUE,
  credential_generation INTEGER NOT NULL DEFAULT 1,
  credential_expires_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','disabled','revoked')),
  last_seen_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX runners_pool ON runners(account_id, pool_id, state, last_seen_at);
CREATE TABLE execution_attempts (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  job_id TEXT NOT NULL REFERENCES workflow_jobs(id),
  generation INTEGER NOT NULL CHECK (generation > 0),
  plan_digest TEXT NOT NULL,
  toolchain_digest TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  executor TEXT NOT NULL CHECK (executor IN ('hosted','self_hosted')),
  profile TEXT,
  -- Machine identities are authoritative on IDENTITY_DB, not replicated here.
  pool_id TEXT,
  runner_id TEXT,
  runner_credential_generation INTEGER,
  status TEXT NOT NULL CHECK (status IN ('queued','accepted','admitting','leased','running','cancelling','succeeded','failed','cancelled','timed_out','runner_unreachable','infrastructure_failed')),
  reason TEXT,
  reservation_id TEXT,
  credential_hash TEXT,
  lease_expires_at TEXT,
  deadline_at TEXT,
  queue_deadline_at TEXT NOT NULL,
  runtime_name TEXT,
  runtime_id TEXT,
  process_id TEXT,
  allocated_at TEXT,
  destruction_verified_at TEXT,
  cleanup_state TEXT NOT NULL DEFAULT 'none' CHECK (cleanup_state IN ('none','required','destroying','verified','unreachable')),
  outcome_json TEXT,
  receipt_hash TEXT,
  started_at TEXT,
  completed_at TEXT,
  settled_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, generation)
);
CREATE TRIGGER attempt_provenance_immutable BEFORE UPDATE OF repo_id, account_id, run_id, job_id, generation, plan_digest, toolchain_digest, producer_id, executor, profile, pool_id ON execution_attempts BEGIN
  SELECT RAISE(ABORT, 'attempt provenance is immutable');
END;
CREATE INDEX execution_attempts_run ON execution_attempts(repo_id, run_id, created_at, id);
CREATE INDEX execution_attempts_queue ON execution_attempts(status, account_id, created_at, id);
CREATE INDEX execution_attempts_runner ON execution_attempts(runner_id, status, lease_expires_at);
CREATE INDEX execution_attempts_reaper ON execution_attempts(cleanup_state, deadline_at, id);
CREATE TABLE execution_dispatches (
  attempt_id TEXT PRIMARY KEY REFERENCES execution_attempts(id),
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  generation INTEGER NOT NULL,
  accepted_at TEXT,
  published_at TEXT,
  publication_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX execution_dispatches_pending ON execution_dispatches(accepted_at, published_at, account_id, created_at);
CREATE TABLE execution_fairness (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  last_dispatched_at TEXT NOT NULL,
  dispatch_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE execution_objects (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  attempt_id TEXT NOT NULL REFERENCES execution_attempts(id),
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('log','output','manifest','cache','snapshot')),
  name TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  content_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('uploading','sealed','deleting','deleted')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(attempt_id, kind, name, sequence)
);
CREATE INDEX execution_objects_run ON execution_objects(repo_id, run_id, kind, name, sequence);
CREATE INDEX execution_objects_retention ON execution_objects(state, expires_at, id);
CREATE TABLE execution_caches (
  cache_key TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  trust TEXT NOT NULL CHECK (trust IN ('trusted','untrusted')),
  toolchain_digest TEXT NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES execution_attempts(id),
  snapshot_json TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE execution_snapshots (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  attempt_id TEXT NOT NULL REFERENCES execution_attempts(id),
  runtime_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  archive_key TEXT NOT NULL UNIQUE,
  metadata_key TEXT NOT NULL UNIQUE,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('sealed','deleting','deleted')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX execution_snapshots_retention ON execution_snapshots(state, expires_at, id);
CREATE TABLE workflow_verifications (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  job_id TEXT NOT NULL REFERENCES workflow_jobs(id),
  attempt_id TEXT REFERENCES execution_attempts(id),
  commit_sha TEXT NOT NULL,
  workflow_digest TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  producer_id TEXT NOT NULL,
  toolchain_digest TEXT NOT NULL,
  conclusion TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, job_id)
);
CREATE INDEX workflow_verifications_commit ON workflow_verifications(repo_id, commit_sha, policy_revision, workflow_digest, producer_id);
