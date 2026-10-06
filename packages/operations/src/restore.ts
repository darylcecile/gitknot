import { createHash } from 'node:crypto';
import { canonicalJson, many, mutationGuard, mutationStatements, newId, now, one, registerResourceLocator, sha256, stmt } from '@gitknot/core';
import type { AppContext, Repository } from '@gitknot/core';
import { archiveStream, readArchive, verifiedPart } from './archive.ts';
import type { ArchiveManifest } from './archive.ts';
import { portableTables, rowJsonExpression, verifySnapshotClosure } from './archive-snapshot.ts';
import { consumeOnce } from './durable.ts';
import { MoveReferences } from './move-references.ts';
import { ownerBatch, operationFenceGuard, withOperationMetadataFences } from './metadata-fence.ts';
import { deleteRestorePreviousObject, putRestoreObject } from './objects.ts';
import type { RestoreObjectPlan, StoredObject } from './objects.ts';
import type { Operation, OperationsBindings } from './types.ts';
import { deleteStorageObject } from '../../billing/src/execution.ts';
import { sharedHistoryPredicate } from './archive-privacy.ts';

interface RestorePlan { operation_id: string; archive_id: string; repo_id: string; account_id: string; state: string;
  tables_json: string; repository_json: string; metadata_sha256: string | null; created_at: string }
type Row = Record<string, unknown>;

async function planFor(env: OperationsBindings, operation: Operation, manifest: ArchiveManifest): Promise<RestorePlan> {
  const db = env.DB.withSession('first-primary');
  const existing = await one<RestorePlan>(db, 'SELECT * FROM repository_restore_plans WHERE operation_id=?', operation.id);
  if (existing) {
    if (existing.archive_id !== manifest.archive_id || existing.repo_id !== operation.repo_id) throw new Error('restore_plan_conflict');
    return existing;
  }
  if (!manifest.tables.every(table => portableTables.includes(table))) throw new Error('restore_table_not_allowed');
  const repository = await one<Repository>(db, 'SELECT * FROM repositories WHERE id=?', operation.repo_id);
  if (!repository || repository.state !== 'deleted') throw new Error('restore_repository_not_fenced');
  const at = now();
  await ownerBatch(env, repository.id, operation.id, [
    stmt(db, `INSERT INTO repository_restore_plans(operation_id,archive_id,repo_id,account_id,state,tables_json,repository_json,created_at,updated_at)
      VALUES(?,?,?,?,'staging',?,?,?,?)`, operation.id, manifest.archive_id, repository.id, repository.owner_id,
    canonicalJson(manifest.tables), canonicalJson(manifest.repository), at, at),
    stmt(db, "INSERT INTO repository_restore_previous_rows(operation_id,table_name,row_key,data_json) VALUES(?,'repositories',0,?)", operation.id, canonicalJson(repository)),
  ]);
  return (await one<RestorePlan>(db, 'SELECT * FROM repository_restore_plans WHERE operation_id=?', operation.id))!;
}

async function* metadataRows(env: OperationsBindings, manifest: ArchiveManifest, table: string): AsyncGenerator<Row> {
  for (const part of manifest.parts.filter(part => part.path.startsWith(`metadata/${table}/`)).sort((a, b) => a.path.localeCompare(b.path))) {
    const rows: unknown = JSON.parse(new TextDecoder().decode(await verifiedPart(env, part)));
    if (!Array.isArray(rows)) throw new Error('restore_metadata_invalid');
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || row.repo_id !== manifest.repository.id) throw new Error('restore_metadata_scope');
      yield row as Row;
    }
  }
}

async function objectPlan(env: OperationsBindings, operation: Operation, plan: RestorePlan, row: Row, execution = false): Promise<RestoreObjectPlan> {
  const original = String(row.id);
  const id = `obj_restore_${(await sha256(`${operation.id}:${original}`)).slice(0, 48)}`;
  const expires = typeof row.requested_retention_until === 'string' && row.requested_retention_until > now() ? row.requested_retention_until
    : execution ? new Date(Date.parse(plan.created_at) + 7 * 86400_000).toISOString() : null;
  const value: RestoreObjectPlan = { operation_id: operation.id, original_id: original, object_id: id, repo_id: plan.repo_id, account_id: plan.account_id,
    kind: execution ? 'restore_execution' : String(row.kind), object_key: `${plan.account_id}/${plan.repo_id}/restores/${operation.id}/${id}`,
    bucket: row.bucket === 'backups' ? 'backups' : 'blobs', bytes: Number(execution ? row.size_bytes : row.bytes), sha256: String(row.sha256),
    content_type: String(row.content_type ?? 'application/octet-stream'), filename: String(row.filename ?? row.name ?? original),
    reference_count: execution ? 0 : Number(row.reference_count ?? 0), retention_until: expires,
    archive_prefix: execution ? `execution/${original}/` : `objects/${original}/` };
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0 || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('restore_object_metadata_invalid');
  await ownerBatch(env, plan.repo_id, operation.id, [stmt(env.DB, `INSERT INTO repository_restore_objects
    (operation_id,original_id,object_id,repo_id,account_id,kind,object_key,bucket,bytes,sha256,content_type,filename,reference_count,retention_until,archive_prefix)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id,original_id) DO NOTHING`, ...Object.values(value))]);
  const actual = await one<RestoreObjectPlan>(env.DB, 'SELECT * FROM repository_restore_objects WHERE operation_id=? AND original_id=?', operation.id, original);
  if (!actual || canonicalJson(actual) !== canonicalJson(value)) throw new Error('restore_object_plan_changed');
  return actual;
}

async function restoreObjects(env: OperationsBindings, operation: Operation, plan: RestorePlan, manifest: ArchiveManifest, authorize: () => Promise<void>): Promise<void> {
  for (const table of ['object_manifests', 'execution_objects']) for await (const row of metadataRows(env, manifest, table)) {
    const execution = table === 'execution_objects';
    if (execution ? row.state !== 'sealed' : row.state !== 'ready') continue;
    await authorize();
    const object = await objectPlan(env, operation, plan, row, execution);
    const prefix = object.archive_prefix;
    if (object.bytes && !manifest.parts.some(part => part.path.startsWith(prefix))) throw new Error('restore_object_parts_missing');
    await putRestoreObject(env, operation, object, async () => archiveStream(env, manifest, prefix, authorize));
  }
}

async function normalizeRow(env: OperationsBindings, plan: RestorePlan, table: string, original: Row, objects: Map<string, RestoreObjectPlan>, objectFields: string[]): Promise<Row> {
  const row = { ...original };
  if ('account_id' in row) row.account_id = plan.account_id;
  if (table === 'object_manifests') {
    const mapped = objects.get(String(row.id));
    if (mapped) {
      const manifest = await one<StoredObject>(env.DB, "SELECT * FROM object_manifests WHERE id=? AND state='ready'", mapped.object_id);
      if (!manifest) throw new Error('restore_object_not_ready');
      return { ...manifest, reference_count: mapped.reference_count };
    }
    const id = `obj_restore_${(await sha256(`${plan.operation_id}:${String(row.id)}`)).slice(0, 48)}`;
    await registerResourceLocator(env, { resource_id: id, resource_type: 'object', repo_id: plan.repo_id });
    return { ...row, id, account_id: plan.account_id, object_key: `${plan.account_id}/${plan.repo_id}/restores/${plan.operation_id}/${id}`,
      state: 'deleted', reference_count: 0, billing_reservation_id: null, billing_fence: null, storage_accrued_at: null,
      upload_generation: 0, upload_bytes_received: 0, upload_failure: 'restored_unavailable' };
  }
  for (const [field, value] of Object.entries(row)) {
    if ((field === 'object_id' || objectFields.includes(field)) && typeof value === 'string') row[field] = objects.get(value)?.object_id
      ?? `obj_restore_${(await sha256(`${plan.operation_id}:${value}`)).slice(0, 48)}`;
  }
  if (table === 'execution_objects') {
    const object = objects.get(String(row.id));
    if (!object) throw new Error('restore_execution_object_missing');
    row.id = object.object_id; row.object_key = object.object_key;
  }
  if (table === 'git_lfs_objects') {
    const object = objects.get(String(original.object_id));
    if (object) row.storage_key = object.object_key;
    else row.state = 'deleted';
  }
  if (table === 'operations') Object.assign(row, { status: ['completed', 'failed', 'cancelled'].includes(String(row.status)) ? row.status : 'cancelled',
    phase: 'restored_reference', input_json: '{}', result_json: null, error_json: null, workflow_id: null, lease_expires_at: null });
  if (table === 'workflows') row.state = 'disabled';
  if (table === 'workflow_runs' && ['queued', 'running', 'waiting', 'waiting_approval', 'cancelling'].includes(String(row.status))) row.status = 'cancelled';
  if (table === 'workflow_jobs' && ['waiting', 'ready', 'queued', 'admitting', 'running', 'waiting_approval', 'cancelling'].includes(String(row.status))) row.status = 'cancelled';
  if (table === 'execution_attempts') {
    if (['queued', 'accepted', 'admitting', 'leased', 'running', 'cancelling'].includes(String(row.status))) row.status = 'cancelled';
    for (const field of ['reservation_id', 'reservation_fence', 'credential_hash', 'runtime_id', 'runtime_name', 'process_id', 'runner_id',
      'runner_credential_generation', 'runner_credential_hash', 'runner_slot_fence', 'lease_expires_at']) if (field in row) row[field] = null;
    row.cleanup_state = 'none';
  }
  if (table === 'pull_merge_queue' && !['merged', 'cancelled', 'superseded'].includes(String(row.state))) row.state = 'cancelled';
  if (table === 'pull_suggestions' && row.state === 'applying') row.state = 'failed';
  if (table === 'task_claims' && row.state === 'active') row.state = 'expired';
  if (table === 'task_workspaces' && row.state === 'provisioning') row.state = 'failed';
  return row;
}

async function stageRows(env: OperationsBindings, operation: Operation, plan: RestorePlan, manifest: ArchiveManifest): Promise<string> {
  const objects = new Map((await many<RestoreObjectPlan>(env.DB, 'SELECT * FROM repository_restore_objects WHERE operation_id=?', operation.id)).map(row => [row.original_id, row]));
  const hash = createHash('sha256');
  for (const table of manifest.tables) {
    const columns = new Set((await many<{ name: string }>(env.DB, `PRAGMA table_info(${table})`)).map(column => column.name));
    const objectFields = (await many<{ table: string; from: string }>(env.DB, `PRAGMA foreign_key_list(${table})`))
      .filter(key => ['object_manifests', 'execution_objects'].includes(key.table)).map(key => key.from);
    let key = 0;
    for await (const original of metadataRows(env, manifest, table)) {
      const row = await normalizeRow(env, plan, table, original, objects, objectFields);
      if (Object.keys(row).some(field => !columns.has(field))) throw new Error('restore_schema_mismatch');
      const encoded = canonicalJson(row);
      hash.update(`${table}:${++key}:${encoded}\n`);
      const prior = await one<{ data_json: string }>(env.DB, 'SELECT data_json FROM repository_restore_rows WHERE operation_id=? AND table_name=? AND row_key=?', operation.id, table, key);
      if (prior && prior.data_json !== encoded) throw new Error('restore_snapshot_changed');
      if (!prior) await ownerBatch(env, plan.repo_id, operation.id, [stmt(env.DB,
        'INSERT INTO repository_restore_rows(operation_id,table_name,row_key,data_json) VALUES(?,?,?,?)', operation.id, table, key, encoded)]);
    }
  }
  await verifySnapshotClosure(env.DB, 'repository_restore_rows', 'operation_id', operation.id, manifest.tables);
  return hash.digest('hex');
}

export async function prepareArchiveRestore(env: OperationsBindings, operation: Operation, archiveId: string, authorize: () => Promise<void>): Promise<void> {
  const manifest = await readArchive(env, archiveId, operation.repo_id!);
  const plan = await planFor(env, operation, manifest);
  if (plan.state !== 'staging') return;
  await restoreObjects(env, operation, plan, manifest, authorize);
  const digest = await stageRows(env, operation, plan, manifest);
  await ownerBatch(env, plan.repo_id, operation.id, [stmt(env.DB, "UPDATE repository_restore_plans SET state='prepared',metadata_sha256=?,updated_at=? WHERE operation_id=? AND state='staging'", digest, now(), operation.id)]);
}

async function replacementTables(env: OperationsBindings, tables: string[]): Promise<string[]> {
  const result = new Set(tables.filter(table => !['operations', 'object_manifests'].includes(table)));
  const candidates = await many<{ name: string }>(env.DB, "SELECT name FROM sqlite_schema WHERE type='table'");
  for (let pass = 0; pass < candidates.length; pass++) {
    let changed = false;
    for (const { name } of candidates) {
      if (result.has(name) || !/^(?:collaboration_|issue|pull_|discussion|task|workflow_|execution_|local_hosted_)/.test(name)
        || name.startsWith('collaboration_code_scan') || ['collaboration_operation_contexts', 'collaboration_drafts'].includes(name)) continue;
      const columns = await many<{ name: string }>(env.DB, `PRAGMA table_info(${name})`);
      if (!columns.some(column => column.name === 'repo_id')) continue;
      if ((await many<{ table: string }>(env.DB, `PRAGMA foreign_key_list(${name})`)).some(key => result.has(key.table))) { result.add(name); changed = true; }
    }
    if (!changed) break;
  }
  return [...result];
}

export async function applyArchiveRestore(env: OperationsBindings, operation: Operation, storageName: string, contexts: AppContext[]): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const plan = await one<RestorePlan>(db, 'SELECT * FROM repository_restore_plans WHERE operation_id=?', operation.id);
  if (!plan || !['prepared', 'applied', 'verified'].includes(plan.state)) throw new Error('restore_snapshot_not_prepared');
  if (plan.state !== 'prepared') return;
  const tables = JSON.parse(plan.tables_json) as string[];
  const deleting = await replacementTables(env, tables);
  const references = new MoveReferences(env, plan.repo_id);
  for (const table of tables) {
    let cursor = 0;
    for (;;) {
      const rows = await many<{ row_key: number; data_json: string }>(db, 'SELECT row_key,data_json FROM repository_restore_rows WHERE operation_id=? AND table_name=? AND row_key>? ORDER BY row_key LIMIT 50', operation.id, table, cursor);
      if (!rows.length) break;
      await references.forRows(table, rows.map(row => JSON.parse(row.data_json) as Row));
      cursor = rows.at(-1)!.row_key;
    }
  }
  const statements: D1PreparedStatement[] = [stmt(db, 'PRAGMA defer_foreign_keys=ON')];
  // Private draft bodies/history are user-owned. Preserve them across a shared
  // repository restore; detach only a base item that the restored snapshot lacks.
  statements.push(stmt(db, `UPDATE collaboration_drafts SET item_id=NULL,base_document_revision=NULL,revision=revision+1,updated_at=?
    WHERE repo_id=? AND item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM repository_restore_rows r WHERE r.operation_id=?
      AND r.table_name='collaboration_items' AND json_extract(r.data_json,'$.id')=collaboration_drafts.item_id)`, now(), plan.repo_id, operation.id));
  statements.push(stmt(db, `INSERT INTO repository_restore_previous_rows(operation_id,table_name,row_key,data_json)
    SELECT ?,'object_manifests',rowid,${await rowJsonExpression(db, 'object_manifests')} FROM object_manifests WHERE repo_id=? AND state<>'deleted'
      AND kind NOT IN ('archive_chunk','scan_chunk','collaboration_code_scan','cache','snapshot')
      AND id NOT IN(SELECT object_id FROM repository_restore_objects WHERE operation_id=?)`, operation.id, plan.repo_id, operation.id));
  for (const table of deleting) {
    const scope = `repo_id=?${table === 'collaboration_document_versions' || table === 'collaboration_history' ? ` AND ${sharedHistoryPredicate(table)}` : ''}`;
    statements.push(stmt(db, `INSERT INTO repository_restore_previous_rows(operation_id,table_name,row_key,data_json)
      SELECT ?,?,rowid,${await rowJsonExpression(db, table)} FROM ${table} WHERE ${scope}`, operation.id, table, plan.repo_id));
    statements.push(stmt(db, `DELETE FROM ${table} WHERE ${scope}`, plan.repo_id));
  }
  statements.push(stmt(db, `UPDATE operations SET status='cancelled',phase='repository_restored',revision=revision+1,updated_at=?
    WHERE repo_id=? AND id<>? AND status IN ('pending','running','waiting','failed')`, now(), plan.repo_id, operation.id));
  statements.push(stmt(db, `UPDATE object_manifests SET reference_count=0,revision=revision+1,updated_at=? WHERE id IN (
    SELECT json_extract(data_json,'$.id') FROM repository_restore_previous_rows WHERE operation_id=? AND table_name='object_manifests')`, now(), operation.id));
  for (const table of tables) {
    const first = await one<{ data_json: string }>(db, 'SELECT data_json FROM repository_restore_rows WHERE operation_id=? AND table_name=? ORDER BY row_key LIMIT 1', operation.id, table);
    if (!first) continue;
    const fields = Object.keys(JSON.parse(first.data_json) as Row);
    const conflict = table === 'operations' ? ` ON CONFLICT(id) DO UPDATE SET ${fields.filter(field => field !== 'id').map(field => `${field}=excluded.${field}`).join(',')} WHERE operations.repo_id=excluded.repo_id`
      : table === 'object_manifests' ? ` ON CONFLICT(id) DO UPDATE SET reference_count=excluded.reference_count
        WHERE object_manifests.repo_id=excluded.repo_id AND object_manifests.sha256=excluded.sha256 AND object_manifests.state=excluded.state
          AND object_manifests.billing_fence IS excluded.billing_fence` : '';
    statements.push(stmt(db, `INSERT INTO ${table}(${fields.join(',')}) SELECT ${fields.map(field => `json_extract(data_json,'$.${field}')`).join(',')}
      FROM repository_restore_rows WHERE operation_id=? AND table_name=? ${conflict}`, operation.id, table));
    const inserted = newId('guard');
    statements.push(stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN changes()=(SELECT COUNT(*) FROM repository_restore_rows WHERE operation_id=? AND table_name=?) THEN 1 ELSE 0 END`, inserted, operation.id, table),
      stmt(db, 'DELETE FROM mutation_guards WHERE id=?', inserted));
  }
  const repository = JSON.parse(plan.repository_json) as Repository;
  const current = await one<{ revision: number }>(db, 'SELECT revision FROM repositories WHERE id=?', plan.repo_id);
  if (!current) throw new Error('restore_repository_missing');
  const guard = newId('guard');
  statements.push(stmt(db, `UPDATE repositories SET storage_name=?,default_branch=?,description=?,revision=revision+1,policy_revision=policy_revision+1,updated_at=?
    WHERE id=? AND owner_id=? AND state='deleted'`, storageName, repository.default_branch, repository.description, now(), plan.repo_id, plan.account_id),
  mutationGuard(db, guard), stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard),
  stmt(db, "UPDATE repository_restore_plans SET state='applied',updated_at=? WHERE operation_id=? AND state='prepared'", now(), operation.id),
  stmt(db, `INSERT INTO collaboration_search_watermarks(repo_id,revision,updated_at) VALUES(?,1,?)
    ON CONFLICT(repo_id) DO UPDATE SET revision=revision+1,updated_at=excluded.updated_at`, plan.repo_id, now()));
  await withOperationMetadataFences(contexts, operation.id, async () => {
    let guarded = [...await operationFenceGuard(db, plan.repo_id, operation.id), ...statements];
    for (const context of contexts) guarded = await mutationStatements(context, { statements: guarded,
      event: { type: 'repository.snapshot_restored', resource_id: plan.repo_id, resource_revision: current.revision + 1,
        repo_id: plan.repo_id, account_id: plan.account_id, data: { operation_id: operation.id, archive_id: plan.archive_id, metadata_sha256: plan.metadata_sha256 } } });
    await consumeOnce(db, 'archive-restore-apply', operation.id, guarded);
  });
}

export async function retirePreviousRestoreObjects(env: OperationsBindings, operation: Operation): Promise<void> {
  let cursor = 0;
  for (;;) {
    const rows = await many<{ row_key: number; data_json: string }>(env.DB,
      "SELECT row_key,data_json FROM repository_restore_previous_rows WHERE operation_id=? AND table_name='object_manifests' AND row_key>? ORDER BY row_key LIMIT 50", operation.id, cursor);
    if (!rows.length) break;
    for (const row of rows) await deleteRestorePreviousObject(env, operation, String((JSON.parse(row.data_json) as Row).id));
    cursor = rows.at(-1)!.row_key;
  }
  cursor = 0;
  for (;;) {
    const rows = await many<{ row_key: number; data_json: string }>(env.DB,
      "SELECT row_key,data_json FROM repository_restore_previous_rows WHERE operation_id=? AND table_name='execution_objects' AND row_key>? ORDER BY row_key LIMIT 50", operation.id, cursor);
    if (!rows.length) return;
    for (const row of rows) {
      const object = JSON.parse(row.data_json) as { id: string; account_id: string; object_key: string; state: string };
      if (object.state === 'deleted' || await one(env.DB, 'SELECT 1 FROM object_manifests WHERE id=?', object.id)) continue;
      const receipt = await deleteStorageObject(env, { account_id: object.account_id, object_id: object.id });
      if (receipt.state !== 'deleted' || receipt.id !== object.id || receipt.key !== object.object_key || await env.BLOBS.head(object.object_key)) throw new Error('restore_previous_execution_deletion_unconfirmed');
    }
    cursor = rows.at(-1)!.row_key;
  }
}

export async function verifyArchiveRestore(env: OperationsBindings, operation: Operation): Promise<void> {
  const plan = await one<RestorePlan>(env.DB, 'SELECT * FROM repository_restore_plans WHERE operation_id=?', operation.id);
  if (!plan || !['applied', 'verified'].includes(plan.state)) throw new Error('restore_snapshot_not_applied');
  const hash = createHash('sha256');
  for (const table of JSON.parse(plan.tables_json) as string[]) {
    const keys = (await many<{ name: string; pk: number }>(env.DB, `PRAGMA table_info(${table})`)).filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
    let cursor = 0, count = 0;
    for (;;) {
      const rows = await many<{ row_key: number; data_json: string }>(env.DB, 'SELECT row_key,data_json FROM repository_restore_rows WHERE operation_id=? AND table_name=? AND row_key>? ORDER BY row_key LIMIT 50', operation.id, table, cursor);
      if (!rows.length) break;
      for (const row of rows) {
        const expected = JSON.parse(row.data_json) as Row;
        const actual = await one<Row>(env.DB, `SELECT ${Object.keys(expected).join(',')} FROM ${table} WHERE ${keys.map(key => `${key} IS ?`).join(' AND ')}`, ...keys.map(key => expected[key]));
        if (!actual || canonicalJson(actual) !== row.data_json) throw new Error(`restore_metadata_verification_failed:${table}`);
        hash.update(`${table}:${row.row_key}:${row.data_json}\n`); count++;
      }
      cursor = rows.at(-1)!.row_key;
    }
    if (!['operations', 'object_manifests'].includes(table)) {
      const privateBoundary = table === 'collaboration_document_versions' || table === 'collaboration_history' ? ` AND ${sharedHistoryPredicate(table)}` : '';
      const actual = await one<{ count: number }>(env.DB, `SELECT COUNT(*) AS count FROM ${table} WHERE repo_id=?${privateBoundary}`, plan.repo_id);
      if (actual?.count !== count) throw new Error(`restore_metadata_count_changed:${table}`);
    }
  }
  if (hash.digest('hex') !== plan.metadata_sha256) throw new Error('restore_snapshot_digest_changed');
  await ownerBatch(env, plan.repo_id, operation.id, [stmt(env.DB, "UPDATE repository_restore_plans SET state='verified',updated_at=? WHERE operation_id=?", now(), operation.id)]);
}
