CREATE TABLE discussion_categories (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  name TEXT NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL CHECK (format IN ('discussion','question','announcement')),
  position INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, id)
);
CREATE UNIQUE INDEX discussion_categories_name ON discussion_categories(repo_id, name) WHERE deleted_at IS NULL;
CREATE INDEX discussion_categories_list ON discussion_categories(repo_id, created_at DESC, id DESC);

CREATE TABLE discussions (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  accepted_comment_id TEXT,
  accepted_by TEXT,
  accepted_at TEXT,
  converted_issue_id TEXT,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  UNIQUE (repo_id, id),
  FOREIGN KEY (repo_id, id) REFERENCES collaboration_items(repo_id, id),
  FOREIGN KEY (repo_id, category_id) REFERENCES discussion_categories(repo_id, id),
  FOREIGN KEY (repo_id, id, accepted_comment_id) REFERENCES collaboration_comments(repo_id, item_id, id),
  FOREIGN KEY (repo_id, converted_issue_id) REFERENCES issues(repo_id, id)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  issue_id TEXT,
  accountable_user_id TEXT NOT NULL REFERENCES users(id),
  base_oid TEXT NOT NULL,
  decision_markdown TEXT NOT NULL DEFAULT '',
  decision_revision INTEGER NOT NULL DEFAULT 1,
  completed_at TEXT,
  UNIQUE (repo_id, id),
  FOREIGN KEY (repo_id, id) REFERENCES collaboration_items(repo_id, id),
  FOREIGN KEY (repo_id, issue_id) REFERENCES issues(repo_id, id)
);
CREATE INDEX tasks_issue ON tasks(repo_id, issue_id, id);

CREATE TABLE task_contributors (
  repo_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, task_id, principal_id),
  FOREIGN KEY (repo_id, task_id) REFERENCES tasks(repo_id, id)
);
CREATE TABLE task_claims (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  description TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','released','expired')),
  lease_seconds INTEGER NOT NULL CHECK (lease_seconds BETWEEN 30 AND 3600),
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, id),
  FOREIGN KEY (repo_id, task_id) REFERENCES tasks(repo_id, id)
);
CREATE INDEX task_claims_active ON task_claims(repo_id, task_id, state, expires_at, id);
CREATE INDEX task_claims_expiry ON task_claims(state, expires_at, id);
CREATE TABLE task_claim_paths (
  repo_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (repo_id, claim_id, path),
  FOREIGN KEY (repo_id, claim_id) REFERENCES task_claims(repo_id, id)
);

CREATE TABLE task_workspaces (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  workspace_repo_id TEXT NOT NULL REFERENCES repositories(id),
  owner_principal_id TEXT NOT NULL,
  base_oid TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES operations(id) DEFERRABLE INITIALLY DEFERRED,
  state TEXT NOT NULL CHECK (state IN ('provisioning','active','expiring','deleted','failed')),
  retention_until TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, id),
  UNIQUE (workspace_repo_id),
  FOREIGN KEY (repo_id, task_id) REFERENCES tasks(repo_id, id)
);
CREATE INDEX task_workspaces_list ON task_workspaces(repo_id, task_id, created_at DESC, id DESC);
CREATE INDEX task_workspaces_retention ON task_workspaces(state, retention_until, id);

CREATE TABLE task_pull_links (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  pull_id TEXT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'proposed' CHECK (disposition IN ('proposed','accepted','abandoned')),
  summary_markdown TEXT NOT NULL DEFAULT '',
  evidence_markdown TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  document_revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, task_id, pull_id),
  FOREIGN KEY (repo_id, task_id) REFERENCES tasks(repo_id, id),
  FOREIGN KEY (repo_id, pull_id) REFERENCES pull_requests(repo_id, id)
);
