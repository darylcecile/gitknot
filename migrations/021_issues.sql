CREATE TABLE labels (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  name TEXT NOT NULL COLLATE NOCASE,
  color TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, id)
);
CREATE UNIQUE INDEX labels_name ON labels(repo_id, name) WHERE deleted_at IS NULL;
CREATE INDEX labels_list ON labels(repo_id, created_at DESC, id DESC);

CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  title TEXT NOT NULL,
  markdown TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),
  due_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  document_revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, id)
);
CREATE INDEX milestones_list ON milestones(repo_id, state, created_at DESC, id DESC);

CREATE TABLE issue_statuses (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  name TEXT NOT NULL COLLATE NOCASE,
  type TEXT NOT NULL CHECK (type IN ('backlog','open','in_progress','blocked','done','cancelled')),
  color TEXT NOT NULL DEFAULT '808080',
  position INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, id)
);
CREATE UNIQUE INDEX issue_statuses_name ON issue_statuses(repo_id, name) WHERE deleted_at IS NULL;
CREATE INDEX issue_statuses_list ON issue_statuses(repo_id, created_at DESC, id DESC);

CREATE TABLE issue_templates (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  name TEXT NOT NULL COLLATE NOCASE,
  title TEXT NOT NULL DEFAULT '',
  markdown TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1,
  document_revision INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, id),
  FOREIGN KEY (repo_id, status_id) REFERENCES issue_statuses(repo_id, id)
);
CREATE UNIQUE INDEX issue_templates_name ON issue_templates(repo_id, name) WHERE deleted_at IS NULL;
CREATE INDEX issue_templates_list ON issue_templates(repo_id, created_at DESC, id DESC);

CREATE TABLE issue_template_labels (
  repo_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (repo_id, template_id, label_id),
  FOREIGN KEY (repo_id, template_id) REFERENCES issue_templates(repo_id, id),
  FOREIGN KEY (repo_id, label_id) REFERENCES labels(repo_id, id)
);

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  status_id TEXT,
  milestone_id TEXT,
  template_id TEXT,
  duplicate_of_id TEXT,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('none','low','normal','high','urgent')),
  due_at TEXT,
  UNIQUE (repo_id, id),
  FOREIGN KEY (repo_id, id) REFERENCES collaboration_items(repo_id, id),
  FOREIGN KEY (repo_id, status_id) REFERENCES issue_statuses(repo_id, id),
  FOREIGN KEY (repo_id, milestone_id) REFERENCES milestones(repo_id, id),
  FOREIGN KEY (repo_id, template_id) REFERENCES issue_templates(repo_id, id),
  FOREIGN KEY (repo_id, duplicate_of_id) REFERENCES issues(repo_id, id),
  CHECK (id <> duplicate_of_id)
);
CREATE INDEX issues_status ON issues(repo_id, status_id, id);
CREATE INDEX issues_milestone ON issues(repo_id, milestone_id, id);

CREATE TABLE collaboration_item_labels (
  repo_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  PRIMARY KEY (repo_id, item_id, label_id),
  FOREIGN KEY (repo_id, item_id) REFERENCES collaboration_items(repo_id, id),
  FOREIGN KEY (repo_id, label_id) REFERENCES labels(repo_id, id)
);
CREATE INDEX collaboration_labels_reverse ON collaboration_item_labels(repo_id, label_id, item_id);

CREATE TABLE issue_assignees (
  repo_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  assigned_by TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, issue_id, user_id),
  FOREIGN KEY (repo_id, issue_id) REFERENCES issues(repo_id, id)
);
CREATE INDEX issue_assignees_user ON issue_assignees(user_id, repo_id, issue_id);

CREATE TABLE issue_dependencies (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  depends_on_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE (repo_id, issue_id, depends_on_id),
  FOREIGN KEY (repo_id, issue_id) REFERENCES issues(repo_id, id),
  FOREIGN KEY (repo_id, depends_on_id) REFERENCES issues(repo_id, id),
  CHECK (issue_id <> depends_on_id)
);
CREATE INDEX issue_dependencies_reverse ON issue_dependencies(repo_id, depends_on_id, issue_id);

CREATE TABLE issue_pull_links (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  pull_id TEXT NOT NULL,
  closes_issue INTEGER NOT NULL DEFAULT 0 CHECK (closes_issue IN (0,1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE (repo_id, issue_id, pull_id),
  FOREIGN KEY (repo_id, issue_id) REFERENCES issues(repo_id, id),
  FOREIGN KEY (repo_id, pull_id) REFERENCES collaboration_items(repo_id, id)
);
