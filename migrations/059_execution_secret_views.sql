-- Broker views are the read-only runtime authorization boundary. The broker still
-- rechecks current identities, memberships, policies, secret versions and grants.
CREATE VIEW secret_runtime_context AS
SELECT a.id AS attempt_id,a.generation,a.run_id,a.repo_id,a.account_id,
  json_extract(r.plan_json,'$.actor.id') AS actor_id,
  json_extract(r.plan_json,'$.actor.kind') AS actor_kind,
  json_extract(r.plan_json,'$.actor.user_id') AS actor_user_id,
  json_extract(r.plan_json,'$.actor.credential_id') AS actor_credential_id,
  r.workflow_id,a.plan_digest,
  json_extract(j.definition_json,'$.secret_selection_digest') AS selection_digest,
  r.commit_sha AS commit_oid,r.source_ref AS ref,r.trust AS trust_class,
  a.executor,a.pool_id AS runner_pool_id,a.runner_id,a.runner_credential_generation,a.runner_credential_hash,
  json_extract(j.definition_json,'$.environment.id') AS environment_id,
  p.artifact_digest,p.destination,
  CASE WHEN j.current_attempt_id=a.id AND j.generation=a.generation
    AND a.cleanup_state!='verified' AND a.deadline_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND r.status NOT IN ('cancelling','cancelled','failed','timed_out','runner_unreachable')
    AND repos.owner_id=a.account_id AND repos.state='active' AND repos.policy_revision=r.policy_revision AND repos.routing_epoch=json_extract(r.plan_json,'$.routing_epoch')
    THEN a.status ELSE 'revoked' END AS state,
  a.lease_expires_at,
  CASE WHEN a.credential_hash IS NULL OR a.status NOT IN ('leased','running') THEN a.updated_at ELSE NULL END AS credentials_revoked_at,
  r.policy_revision,json_extract(r.plan_json,'$.routing_epoch') AS routing_epoch
FROM execution_attempts a
JOIN workflow_runs r ON r.id=a.run_id AND r.repo_id=a.repo_id
JOIN workflow_jobs j ON j.id=a.job_id AND j.repo_id=a.repo_id
JOIN repositories repos ON repos.id=a.repo_id
LEFT JOIN workflow_promotions p ON p.job_id=j.id AND p.run_id=r.id AND p.repo_id=r.repo_id
  AND p.status IN ('approved','promoting','released');

CREATE VIEW secret_environment_authorizations AS
SELECT p.repo_id,p.environment_id,a.id AS attempt_id,a.generation,p.plan_digest,
  p.commit_sha AS commit_oid,p.artifact_digest,p.destination,r.policy_revision,
  approval.approver_id,approval.approver_credential_id,approval.approver_mfa,approval.created_at AS approved_at,a.deadline_at AS expires_at,
  CASE WHEN p.status NOT IN ('approved','promoting','released') OR e.revision!=p.environment_revision
    OR a.status!='running' OR j.current_attempt_id!=a.id OR r.status='cancelling' THEN a.updated_at ELSE NULL END AS revoked_at,
  CASE WHEN e.revision=p.environment_revision AND p.status IN ('approved','promoting','released') AND barrier.state='held'
    AND barrier.checked_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds')
    THEN barrier.checked_commit ELSE NULL END AS current_commit_oid
FROM workflow_promotions p
JOIN environment_approvals approval ON approval.promotion_id=p.id AND approval.repo_id=p.repo_id AND approval.decision='approved'
  AND approval.account_id=p.account_id AND approval.run_id=p.run_id AND approval.artifact_digest=p.artifact_digest
  AND approval.commit_sha=p.commit_sha AND approval.plan_digest=p.plan_digest AND approval.destination=p.destination AND approval.environment_revision=p.environment_revision
JOIN workflow_environments e ON e.id=p.environment_id AND e.repo_id=p.repo_id
JOIN workflow_runs r ON r.id=p.run_id AND r.repo_id=p.repo_id
LEFT JOIN workflow_promotion_barriers barrier ON barrier.promotion_id=p.id AND barrier.repo_id=p.repo_id
JOIN workflow_jobs j ON j.id=p.job_id AND j.run_id=p.run_id
JOIN execution_attempts a ON a.job_id=j.id AND a.repo_id=p.repo_id;
