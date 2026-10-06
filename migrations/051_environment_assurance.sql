ALTER TABLE environment_approvals ADD COLUMN approver_credential_id TEXT;
ALTER TABLE environment_approvals ADD COLUMN approver_mfa INTEGER NOT NULL DEFAULT 0 CHECK(approver_mfa IN (0,1));
ALTER TABLE environment_approvals ADD COLUMN operation_id TEXT;
CREATE UNIQUE INDEX environment_approval_operation ON environment_approvals(operation_id) WHERE operation_id IS NOT NULL;
CREATE TRIGGER environment_approval_immutable BEFORE UPDATE ON environment_approvals BEGIN
  SELECT RAISE(ABORT,'environment approval evidence is immutable');
END;
ALTER TABLE workflow_promotions ADD COLUMN requester_credential_id TEXT;
ALTER TABLE workflow_versions ADD COLUMN approved_credential_id TEXT;
CREATE TRIGGER workflow_promotion_provenance_immutable BEFORE UPDATE OF
  id,repo_id,account_id,run_id,job_id,environment_id,environment_revision,artifact_id,artifact_digest,commit_sha,plan_digest,destination,target_ref,requested_by,requester_credential_id,request_key,request_hash
ON workflow_promotions BEGIN
  SELECT RAISE(ABORT,'artifact promotion provenance is immutable');
END;
