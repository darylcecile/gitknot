CREATE TABLE user_follows (
  id TEXT PRIMARY KEY,
  follower_id TEXT NOT NULL REFERENCES users(id),
  following_id TEXT NOT NULL REFERENCES users(id),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (follower_id, following_id),
  CHECK (follower_id <> following_id)
);
CREATE INDEX user_followers_list ON user_follows(following_id, created_at DESC, id DESC);
CREATE INDEX user_following_list ON user_follows(follower_id, created_at DESC, id DESC);
CREATE TABLE collaboration_profile_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  activity_visibility TEXT NOT NULL DEFAULT 'public' CHECK (activity_visibility IN ('public','followers','private')),
  show_follow_graph INTEGER NOT NULL DEFAULT 1 CHECK (show_follow_graph IN (0,1)),
  digest TEXT NOT NULL DEFAULT 'off' CHECK (digest IN ('off','daily','weekly')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE collaboration_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  item_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('watching','participating','ignored')),
  muted_until TEXT,
  digest TEXT NOT NULL DEFAULT 'inherit' CHECK (digest IN ('inherit','off','daily','weekly')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (repo_id, item_id) REFERENCES collaboration_items(repo_id, id)
);
CREATE UNIQUE INDEX collaboration_subscriptions_repo ON collaboration_subscriptions(user_id, repo_id) WHERE item_id IS NULL;
CREATE UNIQUE INDEX collaboration_subscriptions_item ON collaboration_subscriptions(user_id, repo_id, item_id) WHERE item_id IS NOT NULL;
CREATE INDEX collaboration_subscriptions_list ON collaboration_subscriptions(user_id, created_at DESC, id DESC);

CREATE TABLE collaboration_activity (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_revision INTEGER NOT NULL,
  group_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (repo_id, item_id) REFERENCES collaboration_items(repo_id, id)
);
CREATE INDEX collaboration_activity_feed ON collaboration_activity(created_at DESC, id DESC);
CREATE INDEX collaboration_activity_repo ON collaboration_activity(repo_id, created_at DESC, id DESC);
CREATE INDEX collaboration_activity_actor ON collaboration_activity(actor_id, created_at DESC, id DESC);
CREATE INDEX collaboration_activity_group ON collaboration_activity(group_key, created_at DESC, id DESC);

CREATE TABLE collaboration_inbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  repo_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('mention','assignment','review_request','task_accountability')),
  source_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'outstanding' CHECK (state IN ('outstanding','completed')),
  read_at TEXT,
  completed_at TEXT,
  snoozed_until TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, repo_id, item_id, reason, source_id),
  FOREIGN KEY (repo_id, item_id) REFERENCES collaboration_items(repo_id, id)
);
CREATE INDEX collaboration_inbox_list ON collaboration_inbox(user_id, state, created_at DESC, id DESC);
CREATE INDEX collaboration_inbox_source ON collaboration_inbox(repo_id, item_id, reason, source_id, state);

CREATE TABLE collaboration_mentions (
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  resource_id TEXT NOT NULL,
  document_revision INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, resource_id, document_revision, user_id)
);

CREATE TABLE collaboration_saved_filters (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  repo_id TEXT REFERENCES repositories(id),
  name TEXT NOT NULL,
  surface TEXT NOT NULL CHECK (surface IN ('issues','pulls','discussions','tasks','feed','inbox','search')),
  filter_json TEXT NOT NULL CHECK (json_valid(filter_json)),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, name)
);
CREATE INDEX collaboration_saved_filters_list ON collaboration_saved_filters(user_id, created_at DESC, id DESC);

-- A source watermark detects skipped/out-of-order index delivery without relying on queue order.
CREATE TABLE collaboration_search_watermarks (
  repo_id TEXT PRIMARY KEY REFERENCES repositories(id),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE collaboration_code_scans (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  user_id TEXT REFERENCES users(id),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) DEFERRABLE INITIALLY DEFERRED,
  query TEXT NOT NULL,
  case_sensitive INTEGER NOT NULL CHECK (case_sensitive IN (0,1)),
  include_globs_json TEXT NOT NULL CHECK (json_valid(include_globs_json)),
  exclude_globs_json TEXT NOT NULL CHECK (json_valid(exclude_globs_json)),
  state TEXT NOT NULL CHECK (state IN ('queued','scanning','completed','failed','cancelled')),
  revision INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX collaboration_code_scans_list ON collaboration_code_scans(principal_id, created_at DESC, id DESC);
CREATE TABLE collaboration_code_scan_repositories (
  scan_id TEXT NOT NULL REFERENCES collaboration_code_scans(id),
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  commit_oid TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','scanning','completed','failed')),
  scanned_files INTEGER NOT NULL DEFAULT 0,
  total_files INTEGER,
  match_count INTEGER NOT NULL DEFAULT 0,
  excluded_files INTEGER NOT NULL DEFAULT 0,
  exclusions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(exclusions_json)),
  native_cursor TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scan_id, repo_id)
);
CREATE TABLE collaboration_code_scan_chunks (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES collaboration_code_scans(id),
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  sequence INTEGER NOT NULL,
  object_id TEXT NOT NULL REFERENCES object_manifests(id),
  match_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (scan_id, repo_id, sequence)
);
