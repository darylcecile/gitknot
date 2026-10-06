import type { Principal } from '@gitknot/core';

export interface AccountExport {
  id: string; operation_id: string; account_id: string; created_by: string; principal_json: string; schema_version: 1;
  state: 'queued' | 'capturing' | 'verifying' | 'completed' | 'failed' | 'deleting' | 'deleted' | 'expired'; revision: number;
  account_snapshot_at: string | null; tables_json: string | null; repository_set_sha256: string | null;
  manifest_key: string | null; manifest_sha256: string | null; checksum_sha256: string | null; size_bytes: number | null;
  error_code: string | null; expires_at: string; created_at: string; updated_at: string; deleted_at: string | null;
}

export interface AccountExportPart { path: string; object_id: string; object_key: string; bytes: number; sha256: string; row_count: number | null }
export interface AccountRepositoryReceipt {
  repo_id: string; archive_id: string; operation_id: string; bytes: number; sha256: string; manifest_sha256: string;
  repository_revision: number; captured_at: string; expires_at: string; audience_repo_ids: string[];
}
export interface AccountExportRepository {
  export_id: string; repo_id: string; operation_id: string; archive_id: string;
  state: 'pending' | 'verified' | 'deleting' | 'deleted'; receipt_json: string | null;
}
export interface AccountExportManifest {
  format: 'gitknot.account'; version: 1; export_id: string; account_id: string; created_at: string;
  account_snapshot_at: string; coverage: { complete: true; repository_count: number; consistency: 'individually-fenced-snapshots-v1' };
  metadata: Array<{ path: string; bytes: number; sha256: string; row_count: number }>;
  assets: Array<{ object_id: string; bytes: number; sha256: string; parts: Array<{ path: string; bytes: number; sha256: string }> }>;
  repositories: Array<AccountRepositoryReceipt & { path: string }>;
  protected_data: string[]; exclusions: string[];
}
export interface AccountExportRepositoryRequest { export_id: string; repo_id: string; principal?: Principal }

export const accountExportReadCapabilities = ['repositories.export', 'contents.read', 'issues.read', 'pull_requests.read', 'discussions.read',
  'tasks.read', 'workflows.read', 'runs.read', 'attachments.read', 'lfs.read', 'rules.read', 'environments.read'] as const;
export const accountExportCapabilities = ['accounts.manage', 'billing.read', 'members.read', 'teams.read', 'roles.read', 'policy.read',
  'identities.read', 'tokens.read', 'installations.read', 'runners.read', 'secrets.manage', 'variables.read', 'audit.read'] as const;
