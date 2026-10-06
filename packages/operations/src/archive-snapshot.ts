import { canonicalJson, many, now, one, stmt } from '@gitknot/core';
import type { Bindings, Database, Repository } from '@gitknot/core';
import { ownerBatch } from './metadata-fence.ts';
import { requireClassifiedDocumentHistory, requireSharedArchiveSnapshot, sharedHistoryPredicate } from './archive-privacy.ts';

export const portableTables = [
  'operations', 'repository_aliases', 'repository_rules', 'object_manifests', 'git_lfs_objects', 'git_candidates', 'git_review_snapshots',
  'labels', 'milestones', 'issue_statuses', 'issue_templates', 'issue_template_labels',
  'collaboration_items', 'collaboration_document_versions', 'collaboration_comments', 'collaboration_history', 'collaboration_attachments',
  'issues', 'issue_assignees', 'collaboration_item_labels', 'issue_dependencies', 'issue_pull_links',
  'pull_requests', 'pull_patches', 'pull_patch_files', 'pull_reviews', 'pull_review_files', 'pull_review_validity', 'pull_review_dismissals',
  'pull_review_requests', 'pull_review_threads', 'pull_suggestions', 'pull_dependencies', 'pull_merge_queue',
  'discussion_categories', 'discussions', 'tasks', 'task_contributors', 'task_claims', 'task_claim_paths', 'task_workspaces', 'task_pull_links',
  'workflows', 'workflow_versions', 'workflow_runs', 'workflow_jobs', 'workflow_job_dependencies', 'execution_attempts', 'execution_objects', 'workflow_verifications',
  'workflow_environments', 'workflow_promotions', 'environment_approvals', 'workflow_releases',
];

export async function availableArchiveTables(db: Database): Promise<string[]> {
  const available = new Set((await many<{ name: string }>(db, "SELECT name FROM sqlite_schema WHERE type='table'")).map(row => row.name));
  return portableTables.filter(table => available.has(table));
}

function expression(table: string, field: string): string {
  if (table === 'operations') {
    if (field === 'input_json') return "'{}'";
    if (['result_json', 'error_json', 'workflow_id', 'lease_expires_at'].includes(field)) return 'NULL';
    if (field === 'status') return "CASE WHEN status IN ('completed','failed','cancelled') THEN status ELSE 'cancelled' END";
    if (field === 'phase') return "'archived_reference'";
  }
  if (table === 'execution_attempts' && ['credential_hash', 'runtime_id', 'runtime_name', 'process_id', 'runner_id',
    'runner_credential_generation', 'runner_credential_hash', 'runner_slot_fence'].includes(field)) return 'NULL';
  return `"${field}"`;
}

export async function rowJsonExpression(db: Database, table: string, sanitize = false, omitted: readonly string[] = []): Promise<string> {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error('snapshot_table_invalid');
  const columns = (await many<{ name: string }>(db, `PRAGMA table_info(${table})`)).filter(column => !omitted.includes(column.name));
  const chunks: string[] = [];
  for (let offset = 0; offset < columns.length; offset += 16) {
    const object = `json_object(${columns.slice(offset, offset + 16).map(column => `'${column.name}',${sanitize ? expression(table, column.name) : `"${column.name}"`}`).join(',')})`;
    chunks.push(`substr(${object},2,length(${object})-2)`);
  }
  return `('{'||${chunks.join("||','||")}||'}')`;
}

function selection(table: string): string {
  if (table === 'operations') return `id IN(SELECT operation_id FROM task_workspaces WHERE repo_id=?
    UNION SELECT operation_id FROM pull_merge_queue WHERE repo_id=? UNION SELECT operation_id FROM pull_suggestions WHERE repo_id=? AND operation_id IS NOT NULL)`;
  if (table === 'object_manifests') return "repo_id=? AND kind NOT IN ('archive_chunk','scan_chunk','collaboration_code_scan','cache','snapshot')";
  if (table === 'execution_objects') return "repo_id=? AND kind IN ('log','output','manifest')";
  if (table === 'collaboration_document_versions' || table === 'collaboration_history') return `repo_id=? AND ${sharedHistoryPredicate(table)}`;
  return 'repo_id=?';
}

export async function materializeArchiveSnapshot(env: Bindings, operationId: string, archiveId: string, repository: Repository,
  refs: { ref: string; oid: string }[]): Promise<string[]> {
  const db = env.DB.withSession('first-primary');
  const existing = await one<{ tables_json: string; refs_json: string }>(db, 'SELECT tables_json,refs_json FROM archive_snapshots WHERE archive_id=?', archiveId);
  if (existing) {
    if (existing.refs_json !== canonicalJson(refs)) throw new Error('archive_snapshot_refs_changed');
    await requireSharedArchiveSnapshot(db, archiveId);
    return JSON.parse(existing.tables_json) as string[];
  }
  const tables = await availableArchiveTables(db);
  await requireClassifiedDocumentHistory(db, repository.id);
  const statements: D1PreparedStatement[] = [];
  for (const table of tables) statements.push(stmt(db, `INSERT INTO archive_snapshot_rows(archive_id,table_name,row_key,data_json)
    SELECT ?,?,rowid,${await rowJsonExpression(db, table, true)} FROM ${table} WHERE ${selection(table)}`,
  archiveId, table, ...Array.from({ length: table === 'operations' ? 3 : 1 }, () => repository.id)));
  statements.push(stmt(db, 'INSERT INTO archive_snapshots(archive_id,repository_json,refs_json,tables_json,captured_at) VALUES(?,?,?,?,?)',
    archiveId, canonicalJson(repository), canonicalJson(refs), canonicalJson(tables), now()));
  try { await ownerBatch(env, repository.id, operationId, statements); }
  catch (error) { if (!await one(db, 'SELECT 1 FROM archive_snapshots WHERE archive_id=?', archiveId)) throw error; }
  await verifySnapshotClosure(db, 'archive_snapshot_rows', 'archive_id', archiveId, tables);
  await requireSharedArchiveSnapshot(db, archiveId);
  return tables;
}

/** Validate composite foreign keys against the immutable rowset, including operation summaries. */
export async function verifySnapshotClosure(db: Database, rowsTable: 'archive_snapshot_rows' | 'repository_restore_rows',
  ownerField: 'archive_id' | 'operation_id', id: string, tables: string[]): Promise<void> {
  for (const table of tables) {
    const foreign = await many<{ id: number; seq: number; table: string; from: string; to: string }>(db, `PRAGMA foreign_key_list(${table})`);
    const groups = new Map<number, typeof foreign>();
    for (const key of foreign) { const group = groups.get(key.id) ?? []; group.push(key); groups.set(key.id, group); }
    for (const keys of groups.values()) {
      const parent = keys[0]!.table;
      if (!tables.includes(parent)) continue; // Identity and cross-repository IDs are independently rehydrated FK material.
      const eligible = keys.map(key => `json_extract(r.data_json,'$.${key.from}') IS NOT NULL`).join(' AND ');
      const match = keys.map(key => `json_extract(p.data_json,'$.${key.to}') IS json_extract(r.data_json,'$.${key.from}')`).join(' AND ');
      const missing = await one(db, `SELECT 1 FROM ${rowsTable} r WHERE r.${ownerField}=? AND r.table_name=? AND ${eligible}
        AND NOT EXISTS(SELECT 1 FROM ${rowsTable} p WHERE p.${ownerField}=r.${ownerField} AND p.table_name=? AND ${match}) LIMIT 1`, id, table, parent);
      if (missing) throw new Error(`archive_dependency_missing:${table}:${parent}`);
    }
  }
}
