-- Multi-repository scans remain principal-owned on the identity primary. Their
-- immutable result IDs refer to current repository storage via global locators.
ALTER TABLE collaboration_code_scans ADD COLUMN failure_code TEXT;

CREATE TABLE collaboration_code_scan_repositories_v2 (
  scan_id TEXT NOT NULL REFERENCES collaboration_code_scans(id),
  repo_id TEXT NOT NULL,
  commit_oid TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','scanning','completed','failed')),
  scanned_files INTEGER NOT NULL DEFAULT 0,
  total_files INTEGER,
  match_count INTEGER NOT NULL DEFAULT 0,
  excluded_files INTEGER NOT NULL DEFAULT 0,
  exclusions_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(exclusions_json)),
  native_cursor TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(scan_id,repo_id)
);
INSERT INTO collaboration_code_scan_repositories_v2 SELECT * FROM collaboration_code_scan_repositories;
DROP TABLE collaboration_code_scan_repositories;
ALTER TABLE collaboration_code_scan_repositories_v2 RENAME TO collaboration_code_scan_repositories;

CREATE TABLE collaboration_code_scan_chunks_v2 (
  id TEXT PRIMARY KEY,
  scan_id TEXT NOT NULL REFERENCES collaboration_code_scans(id),
  repo_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  object_id TEXT NOT NULL UNIQUE,
  match_count INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes>=0),
  UNIQUE(scan_id,repo_id,sequence)
);
INSERT INTO collaboration_code_scan_chunks_v2(id,scan_id,repo_id,sequence,object_id,match_count,created_at,sha256,bytes)
  SELECT c.id,c.scan_id,c.repo_id,c.sequence,c.object_id,c.match_count,c.created_at,o.sha256,o.bytes
  FROM collaboration_code_scan_chunks c JOIN object_manifests o ON o.id=c.object_id;
DROP TABLE collaboration_code_scan_chunks;
ALTER TABLE collaboration_code_scan_chunks_v2 RENAME TO collaboration_code_scan_chunks;
