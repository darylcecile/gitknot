CREATE TABLE repository_metadata_fences (
  repo_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  routing_epoch INTEGER NOT NULL CHECK(routing_epoch>0),
  fence_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('held','released')),
  updated_at TEXT NOT NULL
);

-- Immutable acquisition identity survives an interrupted acknowledgement. An
-- old owner may never turn a released receipt into an ordinary write exemption.
CREATE TABLE repository_metadata_fence_receipts (
  operation_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  routing_epoch INTEGER NOT NULL CHECK(routing_epoch>0),
  fence_id TEXT NOT NULL UNIQUE,
  acquired_at TEXT NOT NULL,
  released_at TEXT
);
