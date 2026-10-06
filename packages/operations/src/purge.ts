import { eventStatement, execute, many, mutationGuard, newId, now, one, sha256, stmt } from '@gitknot/core';
import { deleteStorageObject } from '../../billing/src/execution.ts';
import { attachmentSelect, deleteAttachment } from '../../../apps/api/src/modules/collaboration/attachment-storage.ts';
import type { Attachment } from '../../../apps/api/src/modules/collaboration/attachment-storage.ts';
import { backgroundContext } from '../../../apps/api/src/modules/collaboration/operation-runtime.ts';
import { consumeOnce } from './durable.ts';
import type { OperationsBindings } from './types.ts';
import { assertMaintenanceAuthority, maintenancePrincipal } from '../../../apps/api/src/modules/collaboration/maintenance.ts';
import { requireLocalAuthority } from './ownership.ts';
import { backgroundContext as operationContext } from './authorization.ts';
import { operationFenceGuard, ownerExecute, withOperationMetadataFence } from './metadata-fence.ts';

export async function drainRepositoryAttachmentDeletions(env: OperationsBindings, repoId: string, operationId: string): Promise<void> {
  const repository = await requireLocalAuthority(env, repoId, operationId);
  if (!repository) throw new Error('repository_cleanup_authority_missing');
  await assertMaintenanceAuthority(env);
  const context = operationContext(env, maintenancePrincipal, repository);
  for (let page = 0; page < 100; page++) {
    const rows = await many<Attachment>(env.DB, `${attachmentSelect} WHERE a.repo_id=? AND o.state='deleting' ORDER BY a.id LIMIT 50`, repoId);
    if (!rows.length) return;
    for (const row of rows) await withOperationMetadataFence(context, operationId, () => deleteAttachment(context, row));
  }
  throw new Error('attachment_cleanup_page_limit');
}

export async function purgeRepositoryAttachments(env: OperationsBindings, repoId: string, operationId: string): Promise<void> {
  const repo = await requireLocalAuthority(env, repoId, operationId);
  if (!repo) throw new Error('repository_cleanup_authority_missing');
  await assertMaintenanceAuthority(env);
  const context = operationContext(env, maintenancePrincipal, repo);
  while (true) {
    const rows = await many<Attachment>(env.DB, `${attachmentSelect} WHERE a.repo_id=? AND o.state<>'deleted' ORDER BY a.id LIMIT 50`, repoId);
    if (!rows.length) return;
    for (const row of rows) await withOperationMetadataFence(context, operationId, () => deleteAttachment(context, row));
  }
}

export async function purgeRepositoryLfs(env: OperationsBindings, repoId: string, operationId: string): Promise<void> {
  const db = env.DB.withSession('first-primary');
  while (true) {
    const rows = await many<{ oid: string; object_id: string; size: number; storage_key: string; account_id: string; billing_reservation_id: string | null; billing_fence: string | null }>(db,
      `SELECT l.*,m.account_id,m.billing_reservation_id,m.billing_fence FROM git_lfs_objects l JOIN object_manifests m ON m.id=l.object_id AND m.repo_id=l.repo_id
        WHERE l.repo_id=? AND l.state='available' ORDER BY l.oid LIMIT 50`, repoId);
    if (!rows.length) return;
    for (const row of rows) {
      if (!row.billing_reservation_id || !row.billing_fence) throw new Error('lfs_billing_unconfirmed');
      if (await one(db, `SELECT 1 FROM git_lfs_objects WHERE storage_key=? AND repo_id<>? AND state='available' LIMIT 1`, row.storage_key, repoId)) throw new Error('lfs_retention_pinned');
      await ownerExecute(env, repoId, operationId, `UPDATE object_manifests SET state='deleting',reference_count=0,retention_until=NULL,revision=revision+1,updated_at=?
        WHERE id=? AND repo_id=? AND state='ready' AND billing_fence=?`, now(), row.object_id, repoId, row.billing_fence);
      const receipt = await deleteStorageObject(env, { account_id: row.account_id, object_id: row.object_id });
      if (receipt.state !== 'deleted' || receipt.id !== row.object_id || receipt.account_id !== row.account_id
        || receipt.reservation_id !== row.billing_reservation_id || receipt.fence !== row.billing_fence || await env.BLOBS.head(row.storage_key)) throw new Error('lfs_deletion_unconfirmed');
      const guard = newId('guard');
      await consumeOnce(db, 'lfs-object-purge', row.object_id, [
        ...await operationFenceGuard(db, repoId, operationId),
        stmt(db, `UPDATE git_lfs_objects SET state='deleted',revision=revision+1 WHERE repo_id=? AND oid=? AND object_id=? AND state='available'`, repoId, row.oid, row.object_id),
        mutationGuard(db, guard),
        stmt(db, `UPDATE object_manifests SET state='deleted',revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND state='deleting'`, now(), row.object_id, repoId),
        stmt(db, `UPDATE git_lfs_quotas SET used_bytes=used_bytes-?,revision=revision+1,updated_at=? WHERE repo_id=? AND used_bytes>=?`, row.size, now(), repoId, row.size),
        mutationGuard(db, `${guard}_quota`),
        ...(await one(db, 'SELECT 1 FROM repository_restore_objects WHERE object_id=?', row.object_id) ? [
          stmt(db, 'UPDATE storage_quotas SET used_bytes=used_bytes-?,revision=revision+1,updated_at=? WHERE scope_id=? AND used_bytes>=?', row.size, now(), repoId, row.size),
          mutationGuard(db, `${guard}_storage`), stmt(db, 'DELETE FROM mutation_guards WHERE id=?', `${guard}_storage`),
        ] : []),
        eventStatement(db, { type: 'git.lfs_object.deleted', resource_id: `lfs_${row.oid}`, resource_revision: 1, repo_id: repoId, account_id: row.account_id,
          data: { object_id: row.object_id, bytes: row.size, physical_deletion_verified: true } }),
        stmt(db, 'DELETE FROM mutation_guards WHERE id IN (?,?)', guard, `${guard}_quota`),
      ]);
    }
  }
}

export async function purgeExecutionArtifacts(env: OperationsBindings, repoId: string, operationId: string): Promise<void> {
  const db = env.DB.withSession('first-primary');
  while (true) {
    const objects = await many<{ id: string; account_id: string; object_key: string }>(db, `SELECT id,account_id,object_key FROM execution_objects
      WHERE repo_id=? AND state<>'deleted' ORDER BY id LIMIT 50`, repoId);
    if (!objects.length) break;
    for (const object of objects) {
      await deleteStorageObject(env, { account_id: object.account_id, object_id: object.id });
      if (await env.BLOBS.head(object.object_key)) throw new Error('execution_object_purge_unconfirmed');
      await ownerExecute(env, repoId, operationId, `UPDATE execution_objects SET state='deleted',deleted_at=? WHERE id=? AND repo_id=?`, now(), object.id, repoId);
    }
  }
  const snapshots = await many<{ id: string; account_id: string; archive_key: string; metadata_key: string }>(db,
    `SELECT id,account_id,archive_key,metadata_key FROM execution_snapshots WHERE repo_id=? AND state<>'deleted' ORDER BY id`, repoId);
  const bucket = env.BACKUP_BUCKET as R2Bucket | undefined;
  if (snapshots.length && !bucket?.head) throw new Error('snapshot_bucket_unavailable');
  for (const snapshot of snapshots) {
    for (const key of [snapshot.archive_key, snapshot.metadata_key]) {
      await deleteStorageObject(env, { account_id: snapshot.account_id, object_id: `sdk_${(await sha256(key)).slice(0, 48)}` });
      if (await bucket!.head(key)) throw new Error('execution_snapshot_purge_unconfirmed');
    }
    await ownerExecute(env, repoId, operationId, `UPDATE execution_snapshots SET state='deleted',deleted_at=? WHERE id=? AND repo_id=?`, now(), snapshot.id, repoId);
  }
}

/** Delete canonical content in foreign-key order while retaining identity, billing, audit, and recovery summaries. */
export async function purgeCollaborationMetadata(env: OperationsBindings, repoId: string, operationId: string): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const candidates = await many<{ name: string }>(db, `SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name`);
  const names = new Set<string>();
  for (const { name } of candidates) {
    if (!/^[a-z_][a-z_0-9]*$/.test(name) || !/^(?:collaboration_|issue|pull_|discussion|task|label|milestone|workflow|execution_|git_candidates$|repository_rules$|rule_bypasses$)/.test(name)) continue;
    const columns = await many<{ name: string }>(db, `PRAGMA table_info(${name})`);
    if (columns.some((column) => column.name === 'repo_id')) names.add(name);
  }
  const dependencies = new Map<string, Set<string>>();
  for (const name of names) {
    const refs = await many<{ table: string }>(db, `PRAGMA foreign_key_list(${name})`);
    dependencies.set(name, new Set(refs.map((ref) => ref.table).filter((table) => table !== name && names.has(table))));
  }
  while (names.size) {
    const leaves = [...names].filter((name) => ![...names].some((other) => dependencies.get(other)!.has(name)));
    if (!leaves.length) throw new Error('repository_purge_schema_cycle');
    for (const name of leaves) {
      await ownerExecute(env, repoId, operationId, `DELETE FROM ${name} WHERE repo_id=?`, repoId);
      names.delete(name);
    }
  }
  await ownerExecute(env, repoId, operationId, `UPDATE operations SET input_json='{}',result_json=NULL WHERE repo_id=? AND kind LIKE 'collaboration.%' AND status IN ('completed','cancelled','failed')`, repoId);
  if (env.SEARCH_DB) {
    await execute(env.SEARCH_DB, 'DELETE FROM search_documents WHERE repo_id=?', repoId);
    await execute(env.SEARCH_DB, `UPDATE search_repository_state SET state='deleted',indexed_at=? WHERE repo_id=?`, now(), repoId);
  }
}
