import { ApiError, one } from '@gitknot/core';
import type { Database } from '@gitknot/core';

// Draft revisions share the document table, but not its repository-reader audience.
// New document kinds require an explicit ownership classification here.
const sharedDocumentKinds = ['issue', 'pull_request', 'discussion', 'task', 'comment', 'review', 'suggestion', 'task_decision', 'milestone', 'issue_template'];
const sharedKindsSql = sharedDocumentKinds.map(kind => `'${kind}'`).join(',');

export function sharedHistoryPredicate(table: 'collaboration_document_versions' | 'collaboration_history'): string {
  const classification = table === 'collaboration_document_versions' ? `resource_kind IN (${sharedKindsSql})` : "event_type NOT GLOB 'draft.*'";
  return `${classification} AND resource_id NOT GLOB 'draft_*' AND NOT EXISTS (
    SELECT 1 FROM collaboration_drafts private_draft WHERE private_draft.repo_id=${table}.repo_id AND private_draft.id=${table}.resource_id)`;
}

export async function requireClassifiedDocumentHistory(db: Database, repoId: string): Promise<void> {
  if (await one(db, `SELECT 1 FROM collaboration_document_versions WHERE repo_id=? AND resource_kind NOT IN (${sharedKindsSql},'draft') LIMIT 1`, repoId)) {
    throw new ApiError(422, 'archive_private_state_unverified', 'A document history has no verified export ownership classification.');
  }
}

/** Cached materializations cannot bypass the privacy boundary on retry or download. */
export async function requireSharedArchiveSnapshot(db: Database, archiveId: string): Promise<void> {
  const snapshot = await one(db, 'SELECT 1 FROM archive_snapshots WHERE archive_id=?', archiveId);
  const privateRows = await one(db, `SELECT 1 FROM archive_snapshot_rows WHERE archive_id=? AND (
    table_name='collaboration_drafts' OR
    (table_name='collaboration_document_versions' AND (json_extract(data_json,'$.resource_kind') NOT IN (${sharedKindsSql}) OR json_extract(data_json,'$.resource_id') GLOB 'draft_*')) OR
    (table_name='collaboration_history' AND (json_extract(data_json,'$.event_type') GLOB 'draft.*' OR json_extract(data_json,'$.resource_id') GLOB 'draft_*'))
  ) LIMIT 1`, archiveId);
  if (!snapshot || privateRows) throw new ApiError(422, 'archive_private_state_unverified', 'This archive needs a new privacy-scoped capture before it can be used.');
}

/** Private account pages require the captured draft owner, not repository administration. */
export async function requireAccountDraftClosure(db: Database, exportId: string, userId: string | null): Promise<void> {
  const unsafe = await one(db, `SELECT 1 FROM account_export_repository_rows r WHERE r.export_id=? AND (
    (r.table_name='collaboration_drafts' AND json_extract(r.data_json,'$.user_id') IS NOT ?) OR
    (r.table_name IN ('collaboration_document_versions','audit_log') AND NOT EXISTS (
      SELECT 1 FROM account_export_repository_rows d WHERE d.export_id=r.export_id AND d.repository_id=r.repository_id AND d.table_name='collaboration_drafts'
        AND json_extract(d.data_json,'$.id')=json_extract(r.data_json,'$.resource_id') AND json_extract(d.data_json,'$.user_id') IS ?))
  ) LIMIT 1`, exportId, userId, userId);
  const unscopedAudit = await one(db, `SELECT 1 FROM account_export_rows WHERE export_id=? AND table_name='audit_log'
    AND (json_extract(data_json,'$.action') GLOB 'draft.*' OR json_extract(data_json,'$.resource_id') GLOB 'draft_*') LIMIT 1`, exportId);
  if (unsafe || unscopedAudit) throw new ApiError(409, 'account_export_private_state_unverified', 'Private draft history requires its captured user-owner boundary.');
}
