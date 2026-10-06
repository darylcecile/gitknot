-- Queue envelopes identify the physical committed source; imported copies only
-- host current-placement effects and never replace that source's retry authority.
CREATE TABLE event_source_links (
  event_id TEXT PRIMARY KEY REFERENCES outbox(id) DEFERRABLE INITIALLY DEFERRED,
  repo_id TEXT,
  source_cell_id TEXT NOT NULL,
  source_shard_id TEXT NOT NULL,
  event_sha256 TEXT NOT NULL,
  imported INTEGER NOT NULL CHECK(imported IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX event_source_links_repo ON event_source_links(repo_id,event_id);

ALTER TABLE event_replays ADD COLUMN source_cell_id TEXT;
ALTER TABLE event_replays ADD COLUMN source_shard_id TEXT;

CREATE TABLE storage_cleanup_receipts (
  request_id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL,
  repo_id TEXT,
  account_id TEXT NOT NULL,
  completed_at TEXT NOT NULL
);

CREATE TABLE operations_sweep_cursors (
  name TEXT PRIMARY KEY,
  after_id TEXT NOT NULL
);
