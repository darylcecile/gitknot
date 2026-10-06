import { ApiError, authorize, canonicalJson, getRepository, identityBinding, many, mutationStatements, now, one, registerResourceLocator,
  requestPolicies, resolveRepositoryPlacement, sha256, stmt } from '@gitknot/core';
import type { Principal, Repository } from '@gitknot/core';
import { authorizeArchive, archiveAuthorizer, portableArchiveStream, readArchive } from './archive.ts';
import { backgroundContext } from './authorization.ts';
import { accountExport, accountExportPrincipal, authorizeAccountExport, authorizeExportRepository } from './account-export-state.ts';
import type { AccountExport, AccountExportRepository, AccountExportRepositoryRequest, AccountRepositoryReceipt } from './account-export-types.ts';
import { completeOperation, operationById, runLifecycle } from './lifecycle.ts';
import { abandonReadOnlySnapshot } from './snapshot-abandonment.ts';
import { deleteOperationObject } from './objects.ts';
import type { StoredObject } from './objects.ts';
import { localRepository, placementGuard } from './ownership.ts';
import { backgroundCell, shardEnvironment } from './placement.ts';
import { privateRequest } from './private.ts';
import type { Operation, OperationsBindings } from './types.ts';
import { metadataFenceGuard, operationFence } from './metadata-fence.ts';
import { rowJsonExpression } from './archive-snapshot.ts';
import { sourceEvent } from './durable.ts';
import { executionEventRequirements } from './execution-audience.ts';
import { getItem } from '../../../apps/api/src/modules/collaboration/common.ts';

export async function accountRepositoryCall(env: OperationsBindings, action: string, input: AccountExportRepositoryRequest): Promise<Response> {
  const placement = await resolveRepositoryPlacement(env, input.repo_id);
  if (!placement) throw new ApiError(503, 'account_export_repository_unavailable', 'An included repository is unavailable.');
  if (placement.cell_id === env.CELL_ID) return accountRepositoryRequest(shardEnvironment(env, placement.shard_id), action, input);
  return privateRequest(env, backgroundCell(env, placement.cell_id), 'operations.maintenance', `/internal/account-exports/repositories/${action}`, input);
}

async function parent(env: OperationsBindings, input: AccountExportRepositoryRequest): Promise<{ exported: AccountExport; child: AccountExportRepository }> {
  const exported = await accountExport(env, input.export_id);
  const child = await one<AccountExportRepository>(identityBinding(env), 'SELECT * FROM account_export_repositories WHERE export_id=? AND repo_id=?', exported.id, input.repo_id);
  if (!child || child.operation_id !== `op_axr_${(await sha256(`${exported.id}:${input.repo_id}`)).slice(0, 48)}`) throw new Error('account_export_repository_identity');
  return { exported, child };
}

export async function accountRepositoryRequest(env: OperationsBindings, action: string, input: AccountExportRepositoryRequest): Promise<Response> {
  const placement = await resolveRepositoryPlacement(env, input.repo_id);
  if (!placement || placement.cell_id !== env.CELL_ID) throw new ApiError(409, 'account_export_placement_changed', 'Retry the current repository placement.');
  env = shardEnvironment(env, placement.shard_id);
  const { exported, child } = await parent(env, input);
  if (action === 'cleanup') return cleanupRepositoryArchive(env, exported, child);
  if (action === 'capture') {
    if (!['queued', 'capturing'].includes(exported.state) || exported.expires_at <= now()) throw new ApiError(409, 'account_export_closed', 'This account capture is closed.');
    const principal = await accountExportPrincipal(env, exported);
    await authorizeAccountExport(env, principal, exported);
    const repository = await authorizeExportRepository(env, principal, child.repo_id);
    if (repository.owner_id !== exported.account_id) throw new ApiError(409, 'account_export_owner_changed', 'Repository ownership changed during account capture.');
    await captureRepository(env, exported, child, principal, repository);
    return Response.json(await repositoryReceipt(env, child));
  }
  if (action !== 'download' || !input.principal || !['verifying', 'completed'].includes(exported.state) || exported.expires_at <= now()) {
    throw new ApiError(409, 'account_export_not_ready', 'The account export is not ready for streaming.');
  }
  const authorizePart = async () => {
    const current = await accountExport(env, exported.id);
    if (!['verifying', 'completed'].includes(current.state) || current.expires_at <= now()) throw new ApiError(410, 'account_export_expired', 'The account export is no longer available.');
    if (current.created_by !== input.principal!.id) throw new ApiError(404, 'not_found', 'The account export was not found.');
    const repository = await authorizeExportRepository(env, input.principal!, child.repo_id);
    const reader = backgroundContext(env, input.principal!, repository);
    await authorize(reader, 'accounts.manage', { account_id: current.account_id });
    await authorizeArchive(reader, child.archive_id);
  };
  await authorizePart();
  const receipt = await repositoryReceipt(env, child);
  if (!child.receipt_json || canonicalJson(receipt) !== canonicalJson(JSON.parse(child.receipt_json))) throw new Error('account_export_repository_receipt_changed');
  const manifest = await readArchive(env, child.archive_id, child.repo_id);
  await authorizePart();
  return new Response(portableArchiveStream(env, manifest, authorizePart), { headers: {
    'content-type': 'application/x-tar', 'content-length': String(receipt.bytes), 'x-gitknot-content-sha256': receipt.sha256, 'cache-control': 'private, no-store',
  } });
}

async function captureRepository(env: OperationsBindings, exported: AccountExport, child: AccountExportRepository, principal: Principal, repository: Repository): Promise<void> {
  const db = env.DB.withSession('first-primary');
  let operation = await one<Operation>(db, 'SELECT * FROM operations WHERE id=?', child.operation_id);
  if (!operation) {
    const context = backgroundContext(env, principal, repository);
    await requestPolicies(context, [{ capability: 'repositories.export', scope: { repo_id: child.repo_id } }]);
    await registerResourceLocator(env, { resource_id: child.operation_id, resource_type: 'operation', repo_id: child.repo_id });
    await db.batch(await mutationStatements(context, { statements: [
      stmt(db, `INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,input_json,created_at,updated_at)
        VALUES(?,'repository.export',?,?,?,?,?,?,?)`, child.operation_id, child.repo_id, child.repo_id, exported.account_id, principal.id,
      canonicalJson({ principal, account_export_id: exported.id }), now(), now()),
    ], event: { type: 'operation.requested', resource_id: child.operation_id, resource_revision: 1, repo_id: child.repo_id,
      account_id: exported.account_id, actor_id: principal.id, data: { kind: 'repository.export', account_export_id: exported.id } } }));
    operation = await operationById(env, child.operation_id);
  }
  if (operation.repo_id !== child.repo_id || operation.account_id !== exported.account_id || operation.actor_id !== principal.id
    || JSON.parse(operation.input_json).account_export_id !== exported.id) throw new Error('account_export_child_conflict');
  if (operation.status === 'completed') return;
  if (operation.status === 'cancelled' || operation.phase === 'snapshot_abandoned') throw new ApiError(409, 'account_export_capture_abandoned', 'This account export needs a new capture operation.');
  const result = await runLifecycle(env, operation, { async do(name, _options, callback) {
    if (name === 'archive' && !await one(db, "SELECT 1 FROM operation_steps WHERE operation_id=? AND name='archive' AND state='completed'", child.operation_id)) {
      await capturePersonalRepositoryRows(env, exported, child, principal);
    }
    return callback();
  } });
  await completeOperation(env, operation, result);
}

async function capturePersonalRepositoryRows(env: OperationsBindings, exported: AccountExport, child: AccountExportRepository, principal: Principal): Promise<void> {
  const db = env.DB.withSession('first-primary'), parentDb = identityBinding(env);
  const fence = await operationFence(db, child.operation_id);
  if (!fence) throw new Error('account_export_personal_fence_missing');
  const ownedDraft = `EXISTS(SELECT 1 FROM collaboration_drafts d WHERE d.repo_id=collaboration_document_versions.repo_id
    AND d.id=collaboration_document_versions.resource_id AND d.user_id=?)`;
  const scopes: Array<{ table: string; personal: boolean; capability: string | null; omitted: string[]; owner?: string }> = [
    { table: 'collaboration_inbox', personal: true, capability: null, omitted: [] },
    { table: 'collaboration_drafts', personal: true, capability: 'contents.read', omitted: [] },
    { table: 'collaboration_document_versions', personal: true, capability: 'contents.read', omitted: [], owner: `resource_kind='draft' AND ${ownedDraft}` },
    { table: 'audit_log', personal: true, capability: 'contents.read', omitted: ['details_json', 'credential_id'], owner: `action GLOB 'draft.*'
      AND EXISTS(SELECT 1 FROM collaboration_drafts d WHERE d.repo_id=audit_log.repo_id AND d.id=audit_log.resource_id AND d.user_id=?)` },
    { table: 'workflow_execution_policy', personal: false, capability: 'workflows.read', omitted: [] },
    { table: 'git_signing_keys', personal: false, capability: 'rules.read', omitted: [] },
    { table: 'webhooks', personal: false, capability: 'webhooks.manage', omitted: ['principal_json'] },
  ];
  for (const scope of scopes) {
    const { table } = scope;
    if (scope.personal && !principal.user_id) continue;
    const expression = await rowJsonExpression(db, table, false, scope.omitted); let after = 0;
    for (;;) {
      const page = await db.batch<{ row_key: number; data_json: string }>([...metadataFenceGuard(db, child.repo_id, fence), stmt(db,
        `SELECT rowid AS row_key,${expression} AS data_json FROM ${table} WHERE ${scope.personal ? `(${scope.owner ?? 'user_id=?'}) AND ` : ''}repo_id=? AND rowid>? ORDER BY rowid LIMIT 10`,
      ...(scope.personal ? [principal.user_id] : []), child.repo_id, after)]);
      const rows = page.at(-1)!.results;
      if (!rows.length) break;
      if (scope.capability) {
        const repository = await localRepository(env, child.repo_id, child.operation_id);
        if (!repository) throw new Error('account_export_personal_placement_changed');
        await getRepository(backgroundContext(env, principal, repository), child.repo_id, scope.capability);
        await stmt(parentDb, 'INSERT OR IGNORE INTO account_export_audiences(export_id,repo_id,capability) VALUES(?,?,?)', exported.id, child.repo_id, scope.capability).run();
      }
      for (const row of rows) {
        const data = JSON.parse(row.data_json) as { source_event_id?: string; item_id?: string | null };
        if (table === 'collaboration_drafts' && data.item_id) {
          const repository = await localRepository(env, child.repo_id, child.operation_id);
          if (!repository) throw new Error('account_export_personal_placement_changed');
          await getItem(backgroundContext(env, principal, repository), undefined, data.item_id, 'contents.read', child.repo_id);
        }
        if (table === 'collaboration_inbox') {
          const event = data.source_event_id ? await sourceEvent(db, data.source_event_id) : null;
          if (!event || await executionEventRequirements(env, principal, event) === null) throw new ApiError(403, 'account_export_incomplete', 'The complete notification source audience could not be verified.');
        }
        await stmt(parentDb, `INSERT OR IGNORE INTO account_export_repository_rows(export_id,repository_id,table_name,row_key,data_json)
          SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM account_exports WHERE id=? AND state='capturing')`, exported.id, child.repo_id, table, row.row_key, row.data_json, exported.id).run();
        const saved = await one<{ data_json: string }>(parentDb, 'SELECT data_json FROM account_export_repository_rows WHERE export_id=? AND repository_id=? AND table_name=? AND row_key=?', exported.id, child.repo_id, table, row.row_key);
        if (!saved || saved.data_json !== row.data_json) throw new Error('account_export_personal_snapshot_changed');
      }
      after = rows.at(-1)!.row_key;
    }
  }
}

async function repositoryReceipt(env: OperationsBindings, child: AccountExportRepository): Promise<AccountRepositoryReceipt> {
  const row = await one<{ bytes: number; archive_sha256: string; manifest_sha256: string; expires_at: string; captured_at: string; repository_json: string }>(env.DB,
    `SELECT a.bytes,a.archive_sha256,a.manifest_sha256,a.expires_at,s.captured_at,s.repository_json FROM repository_archives a JOIN archive_snapshots s ON s.archive_id=a.id
      WHERE a.id=? AND a.operation_id=? AND a.repo_id=? AND a.state='verified' AND a.expires_at>?`, child.archive_id, child.operation_id, child.repo_id, now());
  if (!row?.archive_sha256) throw new Error('account_export_archive_unverified');
  const audience = await many<{ repository_id: string }>(env.DB, 'SELECT repository_id FROM archive_audiences WHERE archive_id=? ORDER BY repository_id', child.archive_id);
  return { repo_id: child.repo_id, archive_id: child.archive_id, operation_id: child.operation_id, bytes: row.bytes, sha256: row.archive_sha256,
    manifest_sha256: row.manifest_sha256, repository_revision: (JSON.parse(row.repository_json) as { revision: number }).revision,
    captured_at: row.captured_at, expires_at: row.expires_at, audience_repo_ids: audience.map(row => row.repository_id) };
}

async function cleanupRepositoryArchive(env: OperationsBindings, exported: AccountExport, child: AccountExportRepository): Promise<Response> {
  if (!['deleting', 'expired', 'failed'].includes(exported.state)) throw new Error('account_export_cleanup_not_requested');
  const db = env.DB.withSession('first-primary');
  const operation = await one<Operation>(db, 'SELECT * FROM operations WHERE id=?', child.operation_id);
  if (!operation) return Response.json({ deleted: true, verified: true });
  if (!['completed', 'cancelled'].includes(operation.status)) {
    if (!await abandonReadOnlySnapshot(env, operation)) {
      if (await one(db, "SELECT 1 FROM repository_metadata_fences WHERE repo_id=? AND operation_id=? AND state='held'", child.repo_id, child.operation_id)) throw new Error('account_export_child_capture_pending');
    }
  }
  const repository = await localRepository(env, child.repo_id);
  if (!repository) throw new Error('account_export_child_cleanup_fenced');
  if (await one(db, "SELECT 1 FROM repository_restore_plans WHERE archive_id=? AND state IN ('staging','prepared') LIMIT 1", child.archive_id)) throw new Error('account_export_archive_in_use');
  const prefix = `${exported.account_id}/${child.repo_id}/archives/${child.archive_id}/`;
  await db.batch([
    ...placementGuard(db, repository),
    stmt(db, "UPDATE repository_archives SET state='expired' WHERE id=? AND operation_id=?", child.archive_id, child.operation_id),
    stmt(db, `UPDATE object_manifests SET reference_count=0,retention_until=?,revision=revision+1,updated_at=? WHERE repo_id=? AND kind='archive_chunk'
      AND substr(object_key,1,?)=? AND state<>'deleted'`, now(), now(), child.repo_id, prefix.length, prefix),
    stmt(db, "UPDATE operations SET status='cancelled',phase='export_deleted',revision=revision+1,updated_at=? WHERE id=? AND status NOT IN ('completed','cancelled')", now(), child.operation_id),
  ]);
  let after = '';
  for (;;) {
    const rows = await many<StoredObject>(db, `SELECT * FROM object_manifests WHERE repo_id=? AND kind='archive_chunk' AND substr(object_key,1,?)=? AND id>? ORDER BY id LIMIT 50`,
      child.repo_id, prefix.length, prefix, after);
    if (!rows.length) break;
    for (const row of rows) await deleteOperationObject(env, row.id);
    after = rows.at(-1)!.id;
  }
  await db.batch([...placementGuard(db, repository),
    stmt(db, 'DELETE FROM archive_snapshot_rows WHERE archive_id=?', child.archive_id),
    stmt(db, 'DELETE FROM archive_snapshots WHERE archive_id=?', child.archive_id),
  ]);
  return Response.json({ deleted: true, verified: true });
}
