ALTER TABLE workflow_environments ADD COLUMN state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','deleted'));
ALTER TABLE workflow_environments ADD COLUMN deleted_at TEXT;
ALTER TABLE workflow_environments ADD COLUMN deleted_by TEXT;
CREATE TRIGGER workflow_environment_retirement_terminal BEFORE UPDATE OF state ON workflow_environments
WHEN OLD.state='deleted' AND NEW.state!='deleted' BEGIN
  SELECT RAISE(ABORT,'a retired workflow environment cannot be reactivated');
END;
CREATE INDEX workflow_environments_state ON workflow_environments(repo_id,state,id);

-- Failed compilation is also a source-derived representation. Older failures
-- without retained source evidence remain concealed rather than inheriting the
-- current PR head's audience.
ALTER TABLE workflow_trigger_failures ADD COLUMN audience_json TEXT CHECK(audience_json IS NULL OR json_valid(audience_json));
CREATE TRIGGER workflow_trigger_failure_immutable BEFORE UPDATE ON workflow_trigger_failures BEGIN
  SELECT RAISE(ABORT,'workflow trigger failure evidence is immutable');
END;
CREATE INDEX workflow_runs_trigger_origin ON workflow_runs(repo_id,workflow_id,trigger_id,trigger_type);
