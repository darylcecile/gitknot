-- One immutable placement request consumes one source epoch. Retrying an
-- uncertain POST always discovers the same operation, including after cutover.
CREATE TABLE repository_move_requests (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id) DEFERRABLE INITIALLY DEFERRED,
  repo_id TEXT NOT NULL,
  expected_epoch INTEGER NOT NULL CHECK(expected_epoch>0),
  request_sha256 TEXT NOT NULL,
  source_cell_id TEXT NOT NULL,
  source_shard_id TEXT NOT NULL,
  target_cell_id TEXT NOT NULL,
  target_shard_id TEXT NOT NULL,
  source_state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(repo_id,expected_epoch)
);
