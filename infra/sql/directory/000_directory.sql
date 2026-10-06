-- DIRECTORY_DB is its own routing authority. The core-shard copy is a
-- transaction-local fence; both schemas use the same epoch/state contract.
CREATE TABLE IF NOT EXISTS resource_routes (
  resource_id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 1 CHECK (epoch > 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','moving','fenced','deleted')),
  destination_cell_id TEXT,
  destination_shard_id TEXT,
  operation_id TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS resource_routes_cell ON resource_routes(cell_id, shard_id, state);
