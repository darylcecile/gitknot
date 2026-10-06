import type { RequestAuthorization } from '@gitknot/core';

export interface PreviewDiagnostic {
  code: string;
  message: string;
  path: string;
  severity: 'error' | 'blocked' | 'requirement';
}

export interface WorkflowPreviewRecord {
  id: string; repo_id: string; account_id: string; kind: 'validation' | 'plan'; workflow_id: string | null; workflow_version_id: string | null;
  source_commit: string | null; source_ref: string; policy_revision: number; routing_epoch: number; created_by: string;
  result_json: string; result_digest: string; requirements_json: string; revision: 1; created_at: string; expires_at: string;
}

export interface WorkflowPreviewSnapshot {
  kind: 'validation' | 'plan'; valid: boolean; executable: false;
  definition: { origin: 'submitted_draft' | 'approved_workflow'; digest: string | null; workflow_id: string | null; workflow_version_id: string | null; source_commit: string | null };
  source: { commit: string | null; ref: string; repository_id: string; related_repository_ids: string[]; head_repository_id: string; head_oid: string | null; target_oid: string | null;
    pull_request_id: string | null; merge_candidate_id: string | null; verified: boolean };
  policy_revision: number; routing_epoch: number;
  trust: 'trusted' | 'untrusted' | null;
  manifest_digest: string | null;
  payer: { account_id: string; source: 'repository_owner' };
  cost: { currency: 'USD'; maximum_cost_units: string | null; maximum_cost: string | null; admission_required: true; includes_infrastructure_retries: true };
  inputs: Array<{ name: string; type: string }>;
  order: string[]; concurrency: { group: string; supersede: 'cancel' | 'queue' } | null;
  jobs: Record<string, unknown>[];
  diagnostics: PreviewDiagnostic[];
  permissions: Array<RequestAuthorization & { allowed: boolean }>;
}
