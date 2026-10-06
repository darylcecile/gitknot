import { createHash } from 'node:crypto';
import { ApiError, canonicalJson, eventStatement, identityBinding, identityDatabaseLocation, many, mutationGuard, mutationStatements, newId, now, one, requestPolicies, stmt } from '@gitknot/core';
import type { Principal } from '@gitknot/core';
import { accountExport, accountExportPrincipal, authorizeAccountExport } from './account-export-state.ts';
import { materializeAccountExport, verifyAccountRepositorySet } from './account-export-snapshot.ts';
import { accountRepositoryCall, accountRepositoryRequest } from './account-export-repositories.ts';
import { accountAssetRequest, accountExportPartBytes, captureAccountAssets, putAccountExportPart, writeAccountMetadata } from './account-export-parts.ts';
import type { AccountExport, AccountExportManifest, AccountExportPart, AccountExportRepository, AccountRepositoryReceipt } from './account-export-types.ts';
import { accountExportCapabilities } from './account-export-types.ts';
import { backgroundContext } from './authorization.ts';
import { chunks, tarHeader } from './archive.ts';
import { deleteOperationObject, recoverOperationObjects } from './objects.ts';
import type { StoredObject } from './objects.ts';
import { claimOperationRuntime } from './durable.ts';
import { isIdentityPlacement } from './ownership.ts';
import { backgroundCell, shardEnvironment } from './placement.ts';
import { privateRequest, recordDiagnostic } from './private.ts';
import type { Operation, OperationsBindings } from './types.ts';

export async function runAccountExport(env: OperationsBindings, operation: Operation): Promise<Record<string, unknown>> {
  if (!isIdentityPlacement(env) || operation.kind !== 'account.export' || operation.repo_id !== null) throw new Error('account_export_authority_mismatch');
  let exported = await accountExport(env, operation.resource_id);
  if (exported.operation_id !== operation.id || exported.account_id !== operation.account_id || exported.created_by !== operation.actor_id) throw new Error('account_export_operation_mismatch');
  if (exported.state === 'completed') return { account_export_id: exported.id, sha256: exported.checksum_sha256, complete: true };
  if (['deleting', 'deleted', 'expired'].includes(exported.state) || exported.expires_at <= now()) throw new ApiError(409, 'account_export_closed', 'This account export is closed.');
  if (exported.state === 'failed' && exported.error_code === 'account_export_incomplete') throw new ApiError(409, 'account_export_incomplete', 'Create a new account export to capture a complete authorized snapshot.');
  await claimOperationRuntime(env, operation.id, 'account-export');
  const principal = await accountExportPrincipal(env, exported);
  try {
    await authorizeAccountExport(env, principal, exported);
    if (exported.state === 'failed') {
      await stmt(identityBinding(env), "UPDATE account_exports SET state='capturing',error_code=NULL,revision=revision+1,updated_at=? WHERE id=? AND state='failed'", now(), exported.id).run();
      exported = await accountExport(env, exported.id);
    }
    exported = await materializeAccountExport(env, exported, principal);
    await captureAccountAssets(env, exported, principal);
    await captureRepositories(env, exported);
    await writeAccountMetadata(env, exported, principal);
    await verifyAccountRepositorySet(env, exported, principal);
    await authorizeAccountExport(env, principal, exported, true);
    await stmt(identityBinding(env), "UPDATE account_exports SET state='verifying',revision=revision+1,updated_at=? WHERE id=? AND state='capturing'", now(), exported.id).run();
    exported = await accountExport(env, exported.id);
    const manifest = await accountManifest(env, exported);
    const part = await putAccountExportPart(env, exported, 'manifest.json', new TextEncoder().encode(canonicalJson(manifest)), null);
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of chunks(accountExportStream(env, exported, manifest, part, principal))) { hash.update(chunk); bytes += chunk.byteLength; }
    const digest = hash.digest('hex');
    await verifyAccountRepositorySet(env, exported, principal);
    await authorizeAccountExport(env, principal, exported, true);
    const context = backgroundContext(env, principal), guard = newId('guard');
    await requestPolicies(context, accountExportCapabilities.map(capability => ({ capability, scope: { account_id: exported.account_id } })));
    await identityBinding(env).batch(await mutationStatements(context, { statements: [
      stmt(identityBinding(env), `UPDATE account_exports SET state='completed',manifest_key=?,manifest_sha256=?,checksum_sha256=?,size_bytes=?,error_code=NULL,
        revision=revision+1,updated_at=? WHERE id=? AND state='verifying' AND expires_at>?`, part.object_key, part.sha256, digest, bytes, now(), exported.id, now()),
      mutationGuard(identityBinding(env), guard), stmt(identityBinding(env), 'DELETE FROM mutation_guards WHERE id=?', guard),
    ], event: { id: `evt_ax_${exported.id}`, type: 'account.export.completed', resource_id: exported.id, resource_revision: exported.revision + 1,
      account_id: exported.account_id, actor_id: exported.created_by, data: { operation_id: operation.id, complete: true, sha256: digest, bytes } } }));
    const completed = await accountExport(env, exported.id);
    if (completed.state !== 'completed' || completed.checksum_sha256 !== digest || completed.size_bytes !== bytes) throw new Error('account_export_completion_unconfirmed');
    return { account_export_id: exported.id, sha256: digest, complete: true };
  } catch (error) {
    if (error instanceof ApiError && [401, 403, 404, 409, 422].includes(error.status)) {
      await failAccountExport(env, operation, error, true);
      throw new ApiError(409, 'account_export_incomplete', 'A complete authorized account export could not be captured. Request a new export after resolving access or source availability.');
    }
    throw error;
  }
}

async function captureRepositories(env: OperationsBindings, exported: AccountExport): Promise<void> {
  let after = '';
  for (;;) {
    const rows = await many<AccountExportRepository>(identityBinding(env), 'SELECT * FROM account_export_repositories WHERE export_id=? AND repo_id>? ORDER BY repo_id LIMIT 25', exported.id, after);
    if (!rows.length) return;
    for (const child of rows) {
      if (child.state === 'verified') continue;
      const response = await accountRepositoryCall(env, 'capture', { export_id: exported.id, repo_id: child.repo_id });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ApiError(response.status < 500 ? response.status : 503, 'account_export_repository_unconfirmed', 'An included repository could not confirm its complete export.');
      }
      const receipt = await response.json() as AccountRepositoryReceipt;
      if (receipt.repo_id !== child.repo_id || receipt.operation_id !== child.operation_id || receipt.archive_id !== child.archive_id
        || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0 || !/^[a-f0-9]{64}$/.test(receipt.sha256)
        || receipt.expires_at < exported.expires_at || !receipt.audience_repo_ids.includes(child.repo_id)) throw new Error('account_export_repository_receipt_invalid');
      const db = identityBinding(env);
      await db.batch([
        stmt(db, "UPDATE account_export_repositories SET state='verified',receipt_json=? WHERE export_id=? AND repo_id=? AND state='pending'", canonicalJson(receipt), exported.id, child.repo_id),
        ...receipt.audience_repo_ids.map(repoId => stmt(db, "INSERT OR IGNORE INTO account_export_audiences(export_id,repo_id,capability) VALUES(?,?,'contents.read')", exported.id, repoId)),
        stmt(db, `UPDATE operations SET progress=10+80*(SELECT COUNT(*) FROM account_export_repositories WHERE export_id=? AND state='verified')/
          MAX(1,(SELECT COUNT(*) FROM account_export_repositories WHERE export_id=?)),revision=revision+1,updated_at=? WHERE id=? AND status='running'`, exported.id, exported.id, now(), exported.operation_id),
      ]);
    }
    after = rows.at(-1)!.repo_id;
  }
}

async function accountManifest(env: OperationsBindings, exported: AccountExport): Promise<AccountExportManifest> {
  const db = identityBinding(env);
  const parts = await many<AccountExportPart>(db, 'SELECT path,object_id,object_key,bytes,sha256,row_count FROM account_export_parts WHERE export_id=? ORDER BY path LIMIT 20001', exported.id);
  if (parts.length > 20000) throw new ApiError(422, 'account_export_part_limit', 'The complete account archive exceeds its supported part envelope.');
  const repositories = await many<AccountExportRepository>(db, 'SELECT * FROM account_export_repositories WHERE export_id=? ORDER BY repo_id', exported.id);
  if (repositories.some(row => row.state !== 'verified' || !row.receipt_json)) throw new Error('account_export_repository_coverage_incomplete');
  const assets = await many<{ object_id: string; bytes: number; sha256: string }>(db, 'SELECT object_id,bytes,sha256 FROM account_export_assets WHERE export_id=? ORDER BY object_id', exported.id);
  return { format: 'gitknot.account', version: 1, export_id: exported.id, account_id: exported.account_id, created_at: exported.created_at,
    account_snapshot_at: exported.account_snapshot_at!, coverage: { complete: true, repository_count: repositories.length, consistency: 'individually-fenced-snapshots-v1' },
    metadata: parts.filter(part => part.path.startsWith('metadata/')).map(({ path, bytes, sha256, row_count }) => ({ path, bytes, sha256, row_count: row_count! })),
    assets: assets.map(asset => ({ ...asset, parts: parts.filter(part => part.path.startsWith(`assets/${asset.object_id}/`)).map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) })),
    repositories: repositories.map(row => ({ ...JSON.parse(row.receipt_json!) as AccountRepositoryReceipt, path: `repositories/${row.repo_id}.gitknot.tar` })),
    protected_data: ['passwords, bearer tokens and token hashes', 'private authentication keys, MFA seeds and recovery codes', 'secret values, ciphertext and wrapped keys', 'provider client credentials'],
    exclusions: ['other users\' personal accounts and private collaboration state', 'ephemeral runner disks and caches', 'rebuildable search indexes', 'raw provider diagnostics', 'previous derived export containers', 'live credential restoration authority'] };
}

export function accountExportStream(env: OperationsBindings, exported: AccountExport, manifest: AccountExportManifest, manifestPart: AccountExportPart, principal: Principal): ReadableStream<Uint8Array> {
  const authorize = async (all = false) => {
    const current = await accountExport(env, exported.id);
    if (!['verifying', 'completed'].includes(current.state) || current.expires_at <= now()) throw new ApiError(410, 'account_export_expired', 'The account export is no longer available.');
    await authorizeAccountExport(env, principal, current, all);
  };
  async function* content(): AsyncGenerator<Uint8Array> {
    const time = Math.floor(Date.parse(exported.created_at) / 1000);
    const entries = [manifestPart, ...await many<AccountExportPart>(identityBinding(env), 'SELECT path,object_id,object_key,bytes,sha256,row_count FROM account_export_parts WHERE export_id=? AND path<>? ORDER BY path', exported.id, 'manifest.json')];
    for (const part of entries) {
      const bytes = await accountExportPartBytes(env, part, exported.account_id);
      const framed = new Uint8Array(512 + Math.ceil(bytes.byteLength / 512) * 512);
      framed.set(tarHeader(part.path, bytes.byteLength, time)); framed.set(bytes, 512);
      // The outer pull reauthorizes after the storage read and immediately before
      // releasing this bounded header/data/padding frame.
      yield framed;
    }
    for (const repository of manifest.repositories) {
      const response = await accountRepositoryCall(env, 'download', { export_id: exported.id, repo_id: repository.repo_id, principal });
      if (!response.ok || !response.body || response.headers.get('content-length') !== String(repository.bytes)
        || response.headers.get('x-gitknot-content-sha256') !== repository.sha256) { await response.body?.cancel(); throw new Error('account_export_repository_stream_unverified'); }
      const hash = createHash('sha256'); let bytes = 0;
      yield tarHeader(repository.path, repository.bytes, time);
      for await (const chunk of chunks(response.body)) {
        bytes += chunk.byteLength; if (bytes > repository.bytes) throw new Error('account_export_repository_size');
        hash.update(chunk); yield chunk;
      }
      if (bytes !== repository.bytes || hash.digest('hex') !== repository.sha256) throw new Error('account_export_repository_checksum');
      if (bytes % 512) yield new Uint8Array(512 - bytes % 512);
    }
    yield new Uint8Array(1024);
  }
  const iterator = content();
  return new ReadableStream({ async pull(controller) {
    try { const value = await iterator.next(); if (value.done) controller.close(); else { await authorize(true); controller.enqueue(value.value); } }
    catch (error) { controller.error(error); }
  }, async cancel() { await iterator.return(undefined); } }, { highWaterMark: 0 });
}

export async function accountExportPrivate(env: OperationsBindings, path: string, body: Record<string, unknown>): Promise<Response> {
  if (typeof body.export_id !== 'string' || !/^aexport_[A-Za-z0-9_-]+$/.test(body.export_id)) throw new ApiError(400, 'invalid_account_export', 'An account export ID is required.');
  if (path.includes('/repositories/')) {
    if (typeof body.repo_id !== 'string' || !/^r_[A-Za-z0-9_-]+$/.test(body.repo_id)) throw new ApiError(400, 'invalid_repository', 'A repository ID is required.');
    return accountRepositoryRequest(env, path.split('/').at(-1)!, { export_id: body.export_id, repo_id: body.repo_id, principal: body.principal as Principal | undefined });
  }
  if (path.endsWith('/asset')) {
    if (typeof body.object_id !== 'string') throw new ApiError(400, 'invalid_object', 'An account asset ID is required.');
    return accountAssetRequest(env, { export_id: body.export_id, object_id: body.object_id });
  }
  const home = identityDatabaseLocation(env);
  if (env.CELL_ID !== home.cell_id) return privateRequest(env, backgroundCell(env, home.cell_id), 'operations.maintenance', path, body);
  env = shardEnvironment(env, home.shard_id);
  const exported = await accountExport(env, body.export_id);
  if (!path.endsWith('/download') || !body.principal || exported.state !== 'completed' || exported.expires_at <= now()) throw new ApiError(409, 'account_export_not_ready', 'The account export is not ready.');
  const principal = body.principal as Principal;
  await authorizeAccountExport(env, principal, exported, true);
  const part = await one<AccountExportPart>(identityBinding(env), 'SELECT path,object_id,object_key,bytes,sha256,row_count FROM account_export_parts WHERE export_id=? AND path=?', exported.id, 'manifest.json');
  if (!part || part.sha256 !== exported.manifest_sha256) throw new Error('account_export_manifest_unverified');
  const manifest = JSON.parse(new TextDecoder().decode(await accountExportPartBytes(env, part, exported.account_id))) as AccountExportManifest;
  if (manifest.format !== 'gitknot.account' || manifest.version !== 1 || manifest.export_id !== exported.id || manifest.account_id !== exported.account_id || !manifest.coverage.complete) throw new Error('account_export_manifest_invalid');
  await authorizeAccountExport(env, principal, exported, true);
  return new Response(accountExportStream(env, exported, manifest, part, principal), { headers: { 'content-type': 'application/x-tar',
    'content-length': String(exported.size_bytes), etag: `"${exported.checksum_sha256}"`, 'cache-control': 'private, no-store' } });
}

export async function failAccountExport(env: OperationsBindings, operation: Operation, error: unknown, permanent = false): Promise<void> {
  await recordDiagnostic(env, 'account-export', operation.id, error);
  const existing = await accountExport(env, operation.resource_id);
  permanent ||= existing.error_code === 'account_export_incomplete';
  const code = permanent ? 'account_export_incomplete' : 'account_export_unconfirmed', db = identityBinding(env);
  await db.batch([
    stmt(db, "UPDATE account_exports SET state='failed',error_code=?,revision=revision+1,updated_at=? WHERE operation_id=? AND state IN ('queued','capturing','verifying')", code, now(), operation.id),
    stmt(db, "UPDATE operations SET status='failed',error_json=?,revision=revision+1,updated_at=? WHERE id=? AND status NOT IN ('completed','cancelled')", JSON.stringify({ code, retryable: !permanent }), now(), operation.id),
  ]);
}

export async function cleanupAccountExport(env: OperationsBindings, exported: AccountExport): Promise<void> {
  if (!isIdentityPlacement(env) || !['deleting', 'expired', 'failed'].includes(exported.state)) throw new Error('account_export_cleanup_fenced');
  const db = identityBinding(env), prefix = `${exported.account_id}/assets/exports/${exported.id}/`;
  await recoverOperationObjects(env);
  let after = '';
  for (;;) {
    const rows = await many<AccountExportRepository>(db, "SELECT * FROM account_export_repositories WHERE export_id=? AND repo_id>? AND state<>'deleted' ORDER BY repo_id LIMIT 25", exported.id, after);
    if (!rows.length) break;
    for (const child of rows) {
      const response = await accountRepositoryCall(env, 'cleanup', { export_id: exported.id, repo_id: child.repo_id });
      if (!response.ok || (await response.json() as { verified?: boolean }).verified !== true) throw new Error('account_export_child_cleanup_unconfirmed');
      await stmt(db, "UPDATE account_export_repositories SET state='deleted' WHERE export_id=? AND repo_id=?", exported.id, child.repo_id).run();
    }
    after = rows.at(-1)!.repo_id;
  }
  await stmt(db, `UPDATE object_manifests SET reference_count=0,retention_until=?,revision=revision+1,updated_at=? WHERE account_id=? AND repo_id IS NULL
    AND kind='account_export_chunk' AND substr(object_key,1,?)=? AND state<>'deleted'`, now(), now(), exported.account_id, prefix.length, prefix).run();
  after = '';
  for (;;) {
    const rows = await many<StoredObject>(db, "SELECT * FROM object_manifests WHERE account_id=? AND kind='account_export_chunk' AND substr(object_key,1,?)=? AND id>? ORDER BY id LIMIT 50", exported.account_id, prefix.length, prefix, after);
    if (!rows.length) break;
    for (const row of rows) await deleteOperationObject(env, row.id);
    after = rows.at(-1)!.id;
  }
  await db.batch([
    stmt(db, 'DELETE FROM account_export_rows WHERE export_id=?', exported.id),
    stmt(db, 'DELETE FROM account_export_repository_rows WHERE export_id=?', exported.id),
    stmt(db, "UPDATE account_exports SET state=CASE WHEN state='deleting' THEN 'deleted' ELSE state END,deleted_at=?,revision=revision+1,updated_at=? WHERE id=? AND deleted_at IS NULL", now(), now(), exported.id),
    eventStatement(db, { id: `evt_ax_deleted_${exported.id}`, type: 'account.export.storage_deleted', resource_id: exported.id, resource_revision: exported.revision + 1,
      account_id: exported.account_id, data: { physical_deletion_verified: true } }),
  ]);
}

export async function sweepAccountExports(env: OperationsBindings): Promise<void> {
  if (!isIdentityPlacement(env)) return;
  const db = identityBinding(env);
  if (!await one(db, "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='account_exports'")) return;
  await stmt(db, "UPDATE account_exports SET state='expired',revision=revision+1,updated_at=? WHERE expires_at<=? AND state NOT IN ('expired','deleted','deleting')", now(), now()).run();
  for (const row of await many<AccountExport>(db, "SELECT * FROM account_exports WHERE deleted_at IS NULL AND (state IN ('deleting','expired') OR state='failed' AND error_code='account_export_incomplete') ORDER BY updated_at,id LIMIT 10")) {
    try { await cleanupAccountExport(env, row); }
    catch (error) { await recordDiagnostic(env, 'account-export-cleanup', row.id, error); }
  }
}
