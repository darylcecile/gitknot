CREATE TABLE pull_requests (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  head_repo_id TEXT NOT NULL REFERENCES repositories(id),
  base_ref TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  base_oid TEXT NOT NULL,
  head_oid TEXT NOT NULL,
  current_patch_id TEXT,
  milestone_id TEXT,
  task_id TEXT,
  merged_at TEXT,
  merged_by TEXT,
  merge_oid TEXT,
  merged_patch_id TEXT,
  UNIQUE (repo_id, id),
  FOREIGN KEY (repo_id, id) REFERENCES collaboration_items(repo_id, id),
  FOREIGN KEY (repo_id, milestone_id) REFERENCES milestones(repo_id, id),
  FOREIGN KEY (repo_id, task_id) REFERENCES collaboration_items(repo_id, id)
);
CREATE INDEX pull_requests_heads ON pull_requests(repo_id, head_repo_id, head_ref, head_oid);

CREATE TABLE pull_patches (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  pull_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  head_repo_id TEXT NOT NULL REFERENCES repositories(id),
  base_oid TEXT NOT NULL,
  head_oid TEXT NOT NULL,
  merge_base_oid TEXT NOT NULL,
  patch_fingerprint TEXT NOT NULL,
  fingerprint_algorithm TEXT NOT NULL DEFAULT 'git-patch-id-verbatim-v1' CHECK (fingerprint_algorithm='git-patch-id-verbatim-v1'),
  native_evidence_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (repo_id, id),
  UNIQUE (repo_id, pull_id, id),
  UNIQUE (repo_id, pull_id, version),
  FOREIGN KEY (repo_id, pull_id) REFERENCES pull_requests(repo_id, id)
);
CREATE INDEX pull_patches_list ON pull_patches(repo_id, pull_id, version DESC);
CREATE TRIGGER pull_patches_immutable BEFORE UPDATE ON pull_patches BEGIN
  SELECT RAISE(ABORT, 'patch versions are immutable');
END;

CREATE TABLE pull_patch_files (
  repo_id TEXT NOT NULL,
  pull_id TEXT NOT NULL,
  patch_id TEXT NOT NULL,
  path TEXT NOT NULL,
  old_path TEXT,
  change_kind TEXT NOT NULL CHECK (change_kind IN ('added','modified','deleted','renamed','copied','type_changed')),
  old_oid TEXT,
  new_oid TEXT,
  patch_fingerprint TEXT NOT NULL,
  old_lines INTEGER NOT NULL CHECK (old_lines >= 0),
  new_lines INTEGER NOT NULL CHECK (new_lines >= 0),
  binary INTEGER NOT NULL CHECK (binary IN (0,1)),
  hunks_json TEXT NOT NULL CHECK (json_valid(hunks_json)),
  PRIMARY KEY (repo_id, patch_id, path),
  FOREIGN KEY (repo_id, pull_id, patch_id) REFERENCES pull_patches(repo_id, pull_id, id)
);
CREATE TRIGGER pull_patch_files_immutable BEFORE UPDATE ON pull_patch_files BEGIN
  SELECT RAISE(ABORT, 'patch files are immutable');
END;

CREATE TABLE pull_reviews (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  pull_id TEXT NOT NULL,
  patch_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL REFERENCES principals(id),
  reviewer_json TEXT NOT NULL CHECK (json_valid(reviewer_json)),
  decision TEXT NOT NULL CHECK (decision IN ('approve','changes_requested','comment')),
  scope TEXT NOT NULL CHECK (scope IN ('all','files')),
  markdown TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  document_revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE (repo_id, id),
  FOREIGN KEY (repo_id, pull_id, patch_id) REFERENCES pull_patches(repo_id, pull_id, id)
);
CREATE INDEX pull_reviews_latest ON pull_reviews(repo_id, pull_id, reviewer_id, created_at DESC, id DESC);
CREATE TRIGGER pull_reviews_immutable BEFORE UPDATE ON pull_reviews BEGIN
  SELECT RAISE(ABORT, 'submitted review decisions are immutable');
END;

CREATE TABLE pull_review_files (
  repo_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  path TEXT NOT NULL,
  patch_fingerprint TEXT NOT NULL,
  PRIMARY KEY (repo_id, review_id, path),
  FOREIGN KEY (repo_id, review_id) REFERENCES pull_reviews(repo_id, id)
);
CREATE TABLE pull_review_validity (
  repo_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  patch_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('current','preserved','invalidated')),
  changed_paths_json TEXT NOT NULL CHECK (json_valid(changed_paths_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, review_id, patch_id),
  FOREIGN KEY (repo_id, review_id) REFERENCES pull_reviews(repo_id, id),
  FOREIGN KEY (repo_id, patch_id) REFERENCES pull_patches(repo_id, id)
);
CREATE TABLE pull_review_dismissals (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (repo_id, review_id),
  FOREIGN KEY (repo_id, review_id) REFERENCES pull_reviews(repo_id, id)
);

CREATE TABLE pull_review_requests (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  pull_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL REFERENCES principals(id),
  requested_by TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested','completed','cancelled')),
  review_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (repo_id, pull_id) REFERENCES pull_requests(repo_id, id),
  FOREIGN KEY (repo_id, review_id) REFERENCES pull_reviews(repo_id, id)
);
CREATE UNIQUE INDEX pull_review_requests_active ON pull_review_requests(repo_id, pull_id, reviewer_id) WHERE state='requested';
CREATE INDEX pull_review_requests_list ON pull_review_requests(repo_id, pull_id, created_at DESC, id DESC);

CREATE TABLE pull_review_threads (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  pull_id TEXT NOT NULL,
  patch_id TEXT NOT NULL,
  path TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('old','new')),
  start_line INTEGER NOT NULL CHECK (start_line > 0),
  end_line INTEGER NOT NULL CHECK (end_line >= start_line),
  anchor_fingerprint TEXT NOT NULL,
  created_by TEXT NOT NULL,
  resolved_by TEXT,
  resolved_at TEXT,
  outdated INTEGER NOT NULL DEFAULT 0 CHECK (outdated IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, pull_id, id),
  FOREIGN KEY (repo_id, pull_id, patch_id) REFERENCES pull_patches(repo_id, pull_id, id),
  FOREIGN KEY (repo_id, patch_id, path) REFERENCES pull_patch_files(repo_id, patch_id, path)
);
CREATE INDEX pull_threads_list ON pull_review_threads(repo_id, pull_id, created_at DESC, id DESC);

CREATE TABLE pull_suggestions (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  pull_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  patch_id TEXT NOT NULL,
  replacement TEXT NOT NULL,
  created_by TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','applying','applied','rejected','failed')),
  operation_id TEXT REFERENCES operations(id) DEFERRABLE INITIALLY DEFERRED,
  applied_patch_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (repo_id, pull_id, thread_id) REFERENCES pull_review_threads(repo_id, pull_id, id),
  FOREIGN KEY (repo_id, pull_id, patch_id) REFERENCES pull_patches(repo_id, pull_id, id),
  FOREIGN KEY (repo_id, applied_patch_id) REFERENCES pull_patches(repo_id, id)
);
CREATE INDEX pull_suggestions_list ON pull_suggestions(repo_id, pull_id, created_at DESC, id DESC);

CREATE TABLE pull_dependencies (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  pull_id TEXT NOT NULL,
  depends_on_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  UNIQUE (repo_id, pull_id, depends_on_id),
  FOREIGN KEY (repo_id, pull_id) REFERENCES pull_requests(repo_id, id),
  FOREIGN KEY (repo_id, depends_on_id) REFERENCES pull_requests(repo_id, id),
  CHECK (pull_id <> depends_on_id)
);
CREATE INDEX pull_dependencies_reverse ON pull_dependencies(repo_id, depends_on_id, pull_id);

CREATE TABLE pull_merge_queue (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  pull_id TEXT NOT NULL,
  patch_id TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  head_oid TEXT NOT NULL,
  base_oid TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('merge','squash','rebase')),
  policy_revision INTEGER NOT NULL,
  candidate_id TEXT,
  candidate_oid TEXT,
  operation_id TEXT NOT NULL REFERENCES operations(id),
  state TEXT NOT NULL CHECK (state IN ('queued','preparing','verifying','ready','publishing','merged','blocked','cancelled','superseded')),
  reason_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(reason_json)),
  requested_by TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (repo_id, pull_id, patch_id) REFERENCES pull_patches(repo_id, pull_id, id)
);
CREATE UNIQUE INDEX pull_merge_queue_active ON pull_merge_queue(repo_id, pull_id) WHERE state IN ('queued','preparing','verifying','ready','publishing','blocked');
CREATE INDEX pull_merge_queue_order ON pull_merge_queue(repo_id, target_ref, state, created_at, id);
