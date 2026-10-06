-- Distinguish a run If-Match failure from policy, routing, request-generation or
-- metadata-fence failures while aborting the entire cancellation transaction.
CREATE TABLE workflow_run_revision_guards (
  id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CONSTRAINT workflow_run_revision_current CHECK (ok = 1)
);

-- Older materializations restarted at revision 1 after exposing the creator's
-- planning revisions through the same run URL. Retire that overlapping range.
UPDATE workflow_runs SET revision = (
  SELECT MAX(request.revision) + 1 FROM workflow_run_requests request
  WHERE request.run_id=workflow_runs.id AND request.repo_id=workflow_runs.repo_id
    AND request.account_id=workflow_runs.account_id AND request.kind IN ('run','rerun')
)
WHERE EXISTS (
  SELECT 1 FROM workflow_run_requests request
  WHERE request.run_id=workflow_runs.id AND request.repo_id=workflow_runs.repo_id
    AND request.account_id=workflow_runs.account_id AND request.kind IN ('run','rerun')
    AND request.revision>=workflow_runs.revision
);
