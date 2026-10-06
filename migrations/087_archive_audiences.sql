ALTER TABLE repository_archives ADD COLUMN audience_sha256 TEXT;
CREATE TABLE archive_audiences (
  archive_id TEXT NOT NULL REFERENCES repository_archives(id),
  repository_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(archive_id,repository_id)
);

CREATE TABLE archive_ref_audiences (
  archive_id TEXT NOT NULL REFERENCES repository_archives(id),
  ref TEXT NOT NULL,
  oid TEXT NOT NULL,
  source_repo_id TEXT NOT NULL,
  PRIMARY KEY(archive_id,ref)
);
