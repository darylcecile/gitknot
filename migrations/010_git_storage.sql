CREATE TABLE git_publications (
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_json TEXT NOT NULL CHECK (json_valid(actor_json)),
  kind TEXT NOT NULL CHECK (kind IN ('push','refs','edit','import','fork','candidate','merge','restore','restack','retain')),
  state TEXT NOT NULL CHECK (state IN ('receiving','validated','publishing','uncertain','committed','rejected')),
  routing_epoch INTEGER NOT NULL,
  policy_revision INTEGER NOT NULL,
  publisher_id TEXT NOT NULL,
  request_digest TEXT,
  source_repo_id TEXT,
  context_json TEXT CHECK (context_json IS NULL OR json_valid(context_json)),
  evidence_json TEXT CHECK (evidence_json IS NULL OR json_valid(evidence_json)),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  finalized INTEGER NOT NULL DEFAULT 0 CHECK (finalized IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, id)
);
CREATE INDEX git_publications_cursor ON git_publications(repo_id, created_at DESC, id DESC);
CREATE INDEX git_publications_recovery ON git_publications(finalized, updated_at, repo_id);

CREATE TABLE git_api_commands (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  actor_id TEXT NOT NULL,
  principal_json TEXT NOT NULL CHECK (json_valid(principal_json)),
  command_json TEXT NOT NULL CHECK (json_valid(command_json)),
  command_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX git_api_commands_repository ON git_api_commands(repo_id, created_at, id);

CREATE TABLE git_review_snapshots (
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  id TEXT NOT NULL,
  source_repo_id TEXT NOT NULL,
  base_oid TEXT NOT NULL,
  head_oid TEXT NOT NULL,
  merge_base_oid TEXT,
  operation_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('building','ready','failed')),
  inspection_json TEXT CHECK (inspection_json IS NULL OR json_valid(inspection_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, id),
  UNIQUE (repo_id, operation_id)
);

CREATE TABLE git_candidates (
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  id TEXT NOT NULL,
  source_repo_id TEXT NOT NULL REFERENCES repositories(id),
  pull_request_id TEXT,
  source_oid TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  target_oid TEXT NOT NULL,
  candidate_oid TEXT,
  internal_ref TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('merge','squash','rebase','ff-only')),
  policy_revision INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('building','ready','published','obsolete','failed')),
  operation_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, id),
  UNIQUE (repo_id, internal_ref)
);
CREATE INDEX git_candidates_cursor ON git_candidates(repo_id, created_at DESC, id DESC);
CREATE INDEX git_candidates_pull_request ON git_candidates(repo_id, pull_request_id, state);

CREATE TABLE git_storage_capabilities (
  account_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  native_image TEXT NOT NULL,
  attestation_json TEXT NOT NULL CHECK (json_valid(attestation_json)),
  verified_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (account_id, namespace, native_image)
);

CREATE TABLE git_signing_keys (
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  id TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  kind TEXT NOT NULL CHECK (kind IN ('ssh','openpgp')),
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, id),
  UNIQUE (repo_id, fingerprint)
);

CREATE TABLE git_lfs_quotas (
  repo_id TEXT PRIMARY KEY REFERENCES repositories(id),
  byte_limit INTEGER NOT NULL CHECK (byte_limit >= 0),
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE git_lfs_objects (
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  object_id TEXT NOT NULL REFERENCES object_manifests(id),
  oid TEXT NOT NULL CHECK (length(oid) = 64),
  size INTEGER NOT NULL CHECK (size >= 0),
  storage_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('available','deleted')),
  created_by TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, oid)
);
CREATE INDEX git_lfs_objects_cursor ON git_lfs_objects(repo_id, state, created_at, oid);

CREATE TABLE git_lfs_uploads (
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  object_id TEXT NOT NULL REFERENCES object_manifests(id),
  billing_reservation_id TEXT,
  billing_fence TEXT,
  upload_generation INTEGER NOT NULL DEFAULT 0,
  oid TEXT NOT NULL CHECK (length(oid) = 64),
  size INTEGER NOT NULL CHECK (size >= 0),
  actor_id TEXT NOT NULL,
  credential_id TEXT,
  ref TEXT,
  storage_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserving','reserved','uploading','complete','deleting','expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (repo_id, id)
);
CREATE INDEX git_lfs_upload_expiry ON git_lfs_uploads(state, expires_at, repo_id);
CREATE UNIQUE INDEX git_lfs_upload_active ON git_lfs_uploads(repo_id, oid) WHERE state IN ('reserving','reserved','uploading','deleting');
-- Immutable identity-primary routing for maintenance ownership across cell moves.
-- Repository snapshots must not replace this table's primary records.
CREATE TABLE git_barrier_routes (
  repo_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK (epoch > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, operation_id)
);
CREATE TRIGGER git_barrier_route_immutable BEFORE UPDATE ON git_barrier_routes
BEGIN SELECT RAISE(ABORT, 'git_barrier_route_immutable'); END;
CREATE TRIGGER git_barrier_route_retained BEFORE DELETE ON git_barrier_routes
BEGIN SELECT RAISE(ABORT, 'git_barrier_route_retained'); END;
