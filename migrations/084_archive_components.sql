CREATE TABLE archive_components (
  archive_id TEXT NOT NULL REFERENCES repository_archives(id),
  component TEXT NOT NULL,
  generation TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('writing','complete')),
  sha256 TEXT,
  bytes INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(archive_id,component)
);
