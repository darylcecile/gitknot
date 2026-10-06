-- Canonical collaboration content. Repository ownership is part of every relation.
CREATE TABLE collaboration_items (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  kind TEXT NOT NULL CHECK (kind IN ('issue','pull_request','discussion','task')),
  number INTEGER NOT NULL CHECK (number > 0),
  title TEXT NOT NULL,
  markdown TEXT NOT NULL DEFAULT '',
  author_id TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  document_revision INTEGER NOT NULL DEFAULT 1 CHECK (document_revision > 0),
  locked_at TEXT,
  locked_by TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, id),
  UNIQUE (repo_id, kind, number)
);
CREATE INDEX collaboration_items_list ON collaboration_items(repo_id, kind, deleted_at, created_at DESC, id DESC);
CREATE INDEX collaboration_items_author ON collaboration_items(author_id, created_at DESC, id DESC);

CREATE TABLE collaboration_document_versions (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  document_revision INTEGER NOT NULL CHECK (document_revision > 0),
  title TEXT,
  markdown TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  restored_from INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (repo_id, resource_kind, resource_id, document_revision)
);
CREATE INDEX collaboration_document_history ON collaboration_document_versions(repo_id, resource_id, document_revision DESC);
CREATE TRIGGER collaboration_document_versions_immutable BEFORE UPDATE ON collaboration_document_versions BEGIN
  SELECT RAISE(ABORT, 'document versions are immutable');
END;

CREATE TABLE collaboration_comments (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  parent_id TEXT,
  review_thread_id TEXT,
  author_id TEXT NOT NULL,
  markdown TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'visible' CHECK (state IN ('visible','hidden','deleted')),
  anchor_document_revision INTEGER,
  anchor_start INTEGER,
  anchor_end INTEGER,
  anchor_sha256 TEXT,
  moderation_reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  document_revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, id),
  UNIQUE (repo_id, item_id, id),
  FOREIGN KEY (repo_id, item_id) REFERENCES collaboration_items(repo_id, id),
  FOREIGN KEY (repo_id, item_id, parent_id) REFERENCES collaboration_comments(repo_id, item_id, id),
  CHECK ((anchor_document_revision IS NULL AND anchor_start IS NULL AND anchor_end IS NULL AND anchor_sha256 IS NULL)
    OR (anchor_document_revision > 0 AND anchor_start >= 0 AND anchor_end > anchor_start AND length(anchor_sha256) = 64))
);
CREATE INDEX collaboration_comments_thread ON collaboration_comments(repo_id, item_id, created_at DESC, id DESC);
CREATE INDEX collaboration_comments_replies ON collaboration_comments(repo_id, parent_id, created_at, id);

CREATE TABLE collaboration_history (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_revision INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (repo_id, item_id) REFERENCES collaboration_items(repo_id, id)
);
CREATE INDEX collaboration_history_item ON collaboration_history(repo_id, item_id, created_at DESC, id DESC);
CREATE TRIGGER collaboration_history_immutable BEFORE UPDATE ON collaboration_history BEGIN
  SELECT RAISE(ABORT, 'collaboration history is immutable');
END;

CREATE TABLE collaboration_attachments (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  object_id TEXT NOT NULL REFERENCES object_manifests(id) DEFERRABLE INITIALLY DEFERRED,
  created_by TEXT NOT NULL,
  sealed_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, item_id, id),
  FOREIGN KEY (repo_id, item_id) REFERENCES collaboration_items(repo_id, id)
);
CREATE INDEX collaboration_attachments_item ON collaboration_attachments(repo_id, item_id, created_at DESC, id DESC);

CREATE TABLE collaboration_operation_contexts (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id),
  repo_id TEXT REFERENCES repositories(id),
  item_id TEXT,
  principal_json TEXT NOT NULL CHECK (json_valid(principal_json)),
  expected_item_revision INTEGER,
  input_digest TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(checkpoint_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
