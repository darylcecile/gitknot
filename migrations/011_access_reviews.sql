CREATE TABLE repository_access_reviews (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  policy_revision INTEGER NOT NULL,
  account_policy_revision INTEGER NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  note TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX repository_access_reviews_cursor ON repository_access_reviews(repo_id,id);
