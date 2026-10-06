-- Immutable, non-executable compiler snapshots. These never create a run or hold capacity.
CREATE TABLE workflow_plan_previews (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK(kind IN ('validation','plan')),
  workflow_id TEXT REFERENCES workflows(id),
  workflow_version_id TEXT REFERENCES workflow_versions(id),
  source_commit TEXT,
  source_ref TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  routing_epoch INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  result_digest TEXT NOT NULL,
  requirements_json TEXT NOT NULL CHECK(json_valid(requirements_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision=1),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX workflow_previews_retention ON workflow_plan_previews(repo_id,expires_at,id);
CREATE TRIGGER workflow_preview_immutable BEFORE UPDATE ON workflow_plan_previews BEGIN
  SELECT RAISE(ABORT,'workflow compiler previews are immutable');
END;
