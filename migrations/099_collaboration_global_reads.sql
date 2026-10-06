-- Private user state belongs to the identity authority. Repository references
-- are locators, not local foreign keys or repository-owned export/move rows.
CREATE TABLE collaboration_user_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  context_account_id TEXT REFERENCES accounts(id),
  repository_id TEXT NOT NULL,
  subject_id TEXT,
  mode TEXT NOT NULL CHECK(mode IN ('watching','participating','ignored')),
  muted_until TEXT,
  digest TEXT NOT NULL DEFAULT 'inherit' CHECK(digest IN ('inherit','off','daily','weekly')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX collaboration_user_subscription_repo ON collaboration_user_subscriptions(user_id,COALESCE(context_account_id,''),repository_id) WHERE subject_id IS NULL;
CREATE UNIQUE INDEX collaboration_user_subscription_subject ON collaboration_user_subscriptions(user_id,COALESCE(context_account_id,''),repository_id,subject_id) WHERE subject_id IS NOT NULL;
CREATE INDEX collaboration_user_subscription_page ON collaboration_user_subscriptions(user_id,created_at DESC,id DESC);
CREATE INDEX collaboration_user_subscription_context ON collaboration_user_subscriptions(context_account_id,user_id,id);
INSERT INTO collaboration_user_subscriptions
  (id,user_id,context_account_id,repository_id,subject_id,mode,muted_until,digest,revision,created_at,updated_at)
  SELECT s.id,s.user_id,(SELECT id FROM accounts WHERE type='user' AND owner_user_id=s.user_id),
    s.repo_id,s.item_id,s.mode,s.muted_until,s.digest,s.revision,s.created_at,s.updated_at FROM collaboration_subscriptions s;

CREATE TABLE collaboration_user_saved_filters (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  context_account_id TEXT REFERENCES accounts(id),
  repository_id TEXT,
  name TEXT NOT NULL,
  surface TEXT NOT NULL CHECK(surface IN ('issues','pulls','discussions','tasks','feed','inbox','search')),
  filter_json TEXT NOT NULL CHECK(json_valid(filter_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX collaboration_user_filter_name ON collaboration_user_saved_filters(user_id,COALESCE(context_account_id,''),name);
CREATE INDEX collaboration_user_filter_page ON collaboration_user_saved_filters(user_id,created_at DESC,id DESC);
CREATE INDEX collaboration_user_filter_context ON collaboration_user_saved_filters(context_account_id,user_id,id);
INSERT INTO collaboration_user_saved_filters
  (id,user_id,context_account_id,repository_id,name,surface,filter_json,revision,created_at,updated_at)
  SELECT f.id,f.user_id,(SELECT id FROM accounts WHERE type='user' AND owner_user_id=f.user_id),
    f.repo_id,f.name,f.surface,f.filter_json,f.revision,f.created_at,f.updated_at FROM collaboration_saved_filters f;

-- Notifications and their source actions stay repository-local and atomic.
-- The user's overlay applies only to the recorded source event; a new event
-- cannot inherit an old acknowledgment, read mark or snooze.
CREATE TABLE collaboration_user_inbox_state (
  notification_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  context_account_id TEXT NOT NULL REFERENCES accounts(id),
  repository_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  read_at TEXT,
  snoozed_until TEXT,
  state_override TEXT CHECK(state_override IN ('outstanding','completed')),
  acknowledged_at TEXT,
  revision INTEGER NOT NULL CHECK(revision>0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,context_account_id,notification_id)
);
CREATE INDEX collaboration_user_inbox_context ON collaboration_user_inbox_state(context_account_id,user_id,notification_id);
