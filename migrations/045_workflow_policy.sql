CREATE TABLE workflow_execution_policy (
  repo_id TEXT PRIMARY KEY REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
  toolchains_json TEXT NOT NULL CHECK(json_valid(toolchains_json)),
  modules_json TEXT NOT NULL CHECK(json_valid(modules_json)),
  egress_json TEXT NOT NULL CHECK(json_valid(egress_json)),
  infrastructure_retries INTEGER NOT NULL DEFAULT 1 CHECK(infrastructure_retries BETWEEN 0 AND 2),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE workflow_promotion_barriers (
  promotion_id TEXT PRIMARY KEY REFERENCES workflow_promotions(id),
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  state TEXT NOT NULL CHECK(state IN ('acquiring','held','releasing','released')),
  owner_id TEXT NOT NULL,
  checked_commit TEXT,
  checked_at TEXT,
  updated_at TEXT NOT NULL
);
