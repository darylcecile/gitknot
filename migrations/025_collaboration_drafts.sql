CREATE TABLE collaboration_drafts (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  item_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('issue','pull_request','discussion','task','comment')),
  title TEXT NOT NULL DEFAULT '',
  markdown TEXT NOT NULL DEFAULT '',
  base_document_revision INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  document_revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (repo_id, item_id) REFERENCES collaboration_items(repo_id, id)
);
CREATE INDEX collaboration_drafts_owner ON collaboration_drafts(user_id, repo_id, created_at DESC, id DESC);
