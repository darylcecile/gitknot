CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL CHECK (visibility IN ('public','private','internal','unlisted')),
  default_branch TEXT NOT NULL DEFAULT 'main',
  state TEXT NOT NULL CHECK (state IN ('provisioning','active','archived','transfer_pending','moving','deleted')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  policy_revision INTEGER NOT NULL DEFAULT 1 CHECK (policy_revision > 0),
  routing_epoch INTEGER NOT NULL DEFAULT 1 CHECK (routing_epoch > 0),
  cell_id TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  storage_name TEXT NOT NULL UNIQUE,
  fork_source_id TEXT REFERENCES repositories(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  recovery_until TEXT,
  UNIQUE (owner_id, slug),
  CHECK (fork_source_id IS NULL OR fork_source_id != id)
);
CREATE INDEX repositories_owner_cursor ON repositories(owner_id, id);
CREATE INDEX repositories_discovery_cursor ON repositories(visibility, state, id);
CREATE INDEX repositories_fork ON repositories(fork_source_id, id);
CREATE INDEX repositories_recovery ON repositories(recovery_until) WHERE state = 'deleted';

CREATE TABLE repository_aliases (
  owner_slug TEXT NOT NULL COLLATE NOCASE,
  repository_slug TEXT NOT NULL COLLATE NOCASE,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_slug, repository_slug)
);
CREATE INDEX repository_aliases_repo ON repository_aliases(repo_id);

CREATE TABLE repository_rules (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  repo_id TEXT REFERENCES repositories(id),
  name TEXT NOT NULL,
  enforcement TEXT NOT NULL DEFAULT 'active' CHECK (enforcement IN ('active','evaluate','disabled')),
  target_json TEXT NOT NULL CHECK (json_valid(target_json)),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX repository_rules_scope ON repository_rules(account_id, repo_id, id);

CREATE TABLE rule_bypasses (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  rule_ids_json TEXT NOT NULL CHECK (json_valid(rule_ids_json)),
  refs_json TEXT NOT NULL CHECK (json_valid(refs_json)),
  reason TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX rule_bypasses_current ON rule_bypasses(repo_id, principal_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE repository_transfers (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  source_owner_id TEXT NOT NULL REFERENCES accounts(id),
  destination_owner_id TEXT NOT NULL REFERENCES accounts(id),
  destination_name TEXT NOT NULL,
  previous_state TEXT NOT NULL CHECK (previous_state IN ('active','archived')),
  state TEXT NOT NULL CHECK (state IN ('awaiting_acceptance','accepted','moving','completed','cancelled','expired','failed')),
  operation_id TEXT,
  expires_at TEXT NOT NULL,
  accepted_by TEXT REFERENCES users(id),
  accepted_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (source_owner_id != destination_owner_id)
);
CREATE UNIQUE INDEX repository_transfers_current ON repository_transfers(repo_id) WHERE state IN ('awaiting_acceptance','accepted','moving');
CREATE INDEX repository_transfers_receiver ON repository_transfers(destination_owner_id, state, id);

CREATE TABLE repository_lifecycle (
  operation_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('provision','import','fork','archive','unarchive','delete','restore','purge','transfer','export')),
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','waiting','completed','failed')),
  previous_state TEXT,
  desired_state TEXT,
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  expected_repository_revision INTEGER NOT NULL,
  failure_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_expires_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX repository_lifecycle_repo ON repository_lifecycle(repo_id, created_at);
CREATE INDEX repository_lifecycle_pending ON repository_lifecycle(state, updated_at);
CREATE UNIQUE INDEX repository_lifecycle_exclusive ON repository_lifecycle(repo_id) WHERE state IN ('queued','running','waiting') AND kind != 'export';

CREATE TABLE repository_exports (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  operation_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','completed','failed','expired')),
  object_key TEXT,
  checksum_sha256 TEXT,
  size_bytes INTEGER,
  manifest_json TEXT CHECK (manifest_json IS NULL OR json_valid(manifest_json)),
  expires_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX repository_exports_cursor ON repository_exports(repo_id, id);
CREATE INDEX repository_exports_expiry ON repository_exports(expires_at, state);
