CREATE TABLE catalog_barriers (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  token TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('acquiring','held','releasing','released')),
  recover_after TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX catalog_barriers_recovery ON catalog_barriers(state,recover_after,id);
