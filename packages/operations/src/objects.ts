import { ApiError, eventStatement, execute, hex, limits, many, mutationGuard, newId, now, one, registerResourceLocator, sha256, stmt } from '@gitknot/core';
import type { Database } from '@gitknot/core';
import { cancelStandaloneStorageIntent, reserveStandaloneStorage } from '../../billing/src/storage.ts';
import { accrueStorage, commitStorageObject, deleteStorageObject } from '../../billing/src/execution.ts';
import { storageAccrualCheckpoint, storagePolicy } from '../../billing/src/configuration.ts';
import { claimStorageDeletion, releaseStorageDeletionClaim } from '../../billing/src/retention.ts';
import type { StorageDeletionRequest, StorageObject } from '../../billing/src/types.ts';
import { genericObjectDeletionMutation } from '../../../apps/api/src/modules/storage.ts';
import { consumeOnce } from './durable.ts';
import { isIdentityPlacement, isPlacementRace, localRepository, placementGuard, requireLocalAuthority } from './ownership.ts';
import type { Operation, OperationsBindings } from './types.ts';
import { invalidateCodeScanObject } from './scan-results.ts';
import { operationFence, ownerBatch } from './metadata-fence.ts';
import { readGitLimits } from '../../git/src/policy.ts';

export interface StoredObject {
  id: string; repo_id: string | null; account_id: string; kind: string; object_key: string;
  bucket: 'blobs' | 'backups'; filename: string; content_type: string; bytes: number; sha256: string;
  state: string; reference_count: number; retention_until: string | null; requested_retention_until: string | null;
  storage_accrued_at: string | null; billing_reservation_id: string | null; billing_fence: string | null;
  upload_generation: number; upload_bytes_received: number; upload_failure: string | null;
  revision: number; created_by: string; created_at: string; updated_at: string;
}

const ownedKinds = new Set(['archive_chunk', 'account_export_chunk', 'collaboration_code_scan', 'scan_chunk', 'restore_execution']);
const genericKinds = new Set(['attachment', 'avatar']);

function checked(db: Database, statement: D1PreparedStatement): D1PreparedStatement[] {
  const guard = newId('guard');
  return [statement, mutationGuard(db, guard), stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard)];
}

function accountExportWriteGuard(db: Database, value: { kind: string; account_id: string; object_key: string; created_by: string }, operationId?: string): D1PreparedStatement[] {
  if (value.kind !== 'account_export_chunk') return [];
  if (!operationId) throw new Error('account_export_operation_required');
  const guard = newId('guard');
  return [stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM account_exports
    WHERE operation_id=? AND account_id=? AND created_by=? AND state IN ('capturing','verifying') AND expires_at>?
      AND substr(?,1,length(account_id||'/assets/exports/'||id||'/'))=account_id||'/assets/exports/'||id||'/') THEN 1 ELSE 0 END`,
  guard, operationId, value.account_id, value.created_by, now(), value.object_key), stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard)];
}

function quotaReservation(db: Database, scope: string, bytes: number, maximum: number): D1PreparedStatement[] {
  return [
    stmt(db, 'INSERT INTO storage_quotas(scope_id,limit_bytes,updated_at) VALUES(?,?,?) ON CONFLICT(scope_id) DO NOTHING', scope, maximum, now()),
    ...checked(db, stmt(db, `UPDATE storage_quotas SET reserved_bytes=reserved_bytes+?,revision=revision+1,updated_at=?
      WHERE scope_id=? AND used_bytes+reserved_bytes+?<=limit_bytes`, bytes, now(), scope, bytes)),
  ];
}

function billingMatches(value: StoredObject, receipt: StorageObject): boolean {
  return receipt.id === value.id && receipt.account_id === value.account_id && receipt.key === value.object_key
    && receipt.bucket === value.bucket && receipt.source === 'standalone' && receipt.attribution.repo_id === value.repo_id
    && receipt.maximum_bytes === String(value.bytes) && !!receipt.reservation_id && !!receipt.fence;
}

function storedMatches(value: StoredObject, object: R2Object): boolean {
  return object.size === value.bytes && !!object.checksums.sha256 && hex(new Uint8Array(object.checksums.sha256)) === value.sha256
    && object.customMetadata?.object_id === value.id && (object.customMetadata?.repo_id ?? null) === value.repo_id
    && object.customMetadata?.upload_generation === String(value.upload_generation);
}

async function loadObject(env: OperationsBindings, id: string): Promise<StoredObject> {
  const object = await one<StoredObject>(env.DB.withSession('first-primary'), 'SELECT * FROM object_manifests WHERE id=?', id);
  if (!object) throw new Error('operation_object_missing');
  return object;
}

async function admitObject(env: OperationsBindings, value: StoredObject, operationId?: string): Promise<StoredObject> {
  if (value.state !== 'reserving') return value;
  const receipt = await reserveStandaloneStorage(env, { account_id: value.account_id, repo_id: value.repo_id,
    actor_id: value.created_by, object_id: value.id, key: value.object_key, bucket: value.bucket,
    maximum_bytes: String(value.bytes), retention_until: value.requested_retention_until });
  if (!billingMatches(value, receipt) || receipt.state !== 'uploading' || receipt.admission_state !== 'ready') throw new Error('object_admission_unconfirmed');
  const repository = await requireLocalAuthority(env, value.repo_id, operationId);
  await env.DB.batch([...placementGuard(env.DB, repository, operationId ? await operationFence(env.DB, operationId) : null), ...accountExportWriteGuard(env.DB, value, operationId), stmt(env.DB,
    `UPDATE object_manifests SET state='pending',billing_reservation_id=?,billing_fence=?,revision=revision+1,updated_at=?
    WHERE id=? AND state='reserving' AND revision=?`, receipt.reservation_id, receipt.fence, now(), value.id, value.revision)]);
  return loadObject(env, value.id);
}

/** An ambiguous generation only reconciles positive R2 evidence; it never issues another write. */
async function completeObject(env: OperationsBindings, value: StoredObject, operationId?: string): Promise<StoredObject> {
  if (value.state === 'ready') return value;
  if (value.state !== 'uploading' || value.upload_bytes_received !== value.bytes || !['write_pending', 'write_uncertain'].includes(value.upload_failure ?? '')
    || !value.billing_reservation_id || !value.billing_fence) throw new Error('object_upload_unconfirmed');
  const bucket = value.bucket === 'backups' ? env.BACKUPS : env.BLOBS;
  const head = await bucket.head(value.object_key);
  if (!head || !storedMatches(value, head)) throw new Error('object_upload_unconfirmed');
  const receipt = await commitStorageObject(env, { account_id: value.account_id, reservation_id: value.billing_reservation_id,
    fence: value.billing_fence, object_id: value.id, bytes: String(value.bytes), etag: head.etag, checksum: value.sha256 });
  if (!billingMatches(value, receipt) || receipt.state !== 'stored' || receipt.bytes !== String(value.bytes)
    || receipt.reservation_id !== value.billing_reservation_id || receipt.fence !== value.billing_fence) throw new Error('object_commitment_unconfirmed');
  const db = env.DB.withSession('first-primary');
  const repository = await requireLocalAuthority(env, value.repo_id, operationId);
  await consumeOnce(db, 'operations-object-commit', value.id, [
    ...placementGuard(db, repository, operationId ? await operationFence(db, operationId) : null),
    ...checked(db, stmt(db, `UPDATE object_manifests SET state='ready',storage_accrued_at=?,upload_failure=NULL,
      retention_until=requested_retention_until,revision=revision+1,updated_at=? WHERE id=? AND state='uploading' AND revision=? AND upload_generation=? AND billing_fence=?`,
    receipt.accrued_at, now(), value.id, value.revision, value.upload_generation, value.billing_fence)),
    ...(value.repo_id ? checked(db, stmt(db, `UPDATE storage_quotas SET reserved_bytes=reserved_bytes-?,used_bytes=used_bytes+?,revision=revision+1,updated_at=?
      WHERE scope_id=? AND reserved_bytes>=?`, value.bytes, value.bytes, now(), value.repo_id, value.bytes)) : []),
    ...(value.kind === 'git_lfs' && await one(db, 'SELECT 1 FROM repository_restore_objects WHERE object_id=?', value.id) ? checked(db,
      stmt(db, 'UPDATE git_lfs_quotas SET reserved_bytes=reserved_bytes-?,used_bytes=used_bytes+?,revision=revision+1,updated_at=? WHERE repo_id=? AND reserved_bytes>=?',
        value.bytes, value.bytes, now(), value.repo_id, value.bytes)) : []),
    eventStatement(db, { id: `evt_${value.id}_stored`, type: 'object.created', resource_id: value.id, resource_revision: value.revision + 1,
      repo_id: value.repo_id, account_id: value.account_id, actor_id: value.created_by, data: { bytes: value.bytes, sha256: value.sha256, kind: value.kind } }),
  ]);
  return loadObject(env, value.id);
}

/** Immutable bounded chunks use the same account-wide admission authority as API uploads. */
export async function putObject(env: OperationsBindings, input: {
  id: string; repo_id: string | null; account_id: string; actor_id: string; kind: string; key: string;
  data: Uint8Array; content_type: string; retention_until: string; bucket?: 'blobs' | 'backups'; referenced?: boolean; operation_id?: string;
}): Promise<StoredObject> {
  if (input.data.byteLength > 8 * 1024 * 1024 || !ownedKinds.has(input.kind)) throw new Error('operation_object_scope');
  if (input.repo_id === null && input.kind !== 'account_export_chunk') throw new Error('operation_object_scope');
  if (!input.key.startsWith(`${input.account_id}/${input.repo_id ?? 'assets'}/`)) throw new Error('operation_object_key_scope');
  await registerResourceLocator(env, { resource_id: input.id, resource_type: 'object', repo_id: input.repo_id });
  const db = env.DB.withSession('first-primary');
  const repository = await requireLocalAuthority(env, input.repo_id, input.operation_id);
  const digest = await sha256(input.data);
  const size = input.data.byteLength;
  const existing = await one<StoredObject>(db, 'SELECT * FROM object_manifests WHERE id=?', input.id);
  if (existing && (existing.sha256 !== digest || existing.bytes !== size || existing.object_key !== input.key || existing.repo_id !== input.repo_id
    || existing.account_id !== input.account_id || existing.kind !== input.kind || existing.bucket !== (input.bucket ?? 'blobs'))) throw new Error('immutable_object_conflict');
  if (existing?.state === 'ready') return existing;
  if (!existing) await consumeOnce(db, 'operations-object-reserve', input.id, [
    ...placementGuard(db, repository, input.operation_id ? await operationFence(db, input.operation_id) : null),
    ...accountExportWriteGuard(db, { kind: input.kind, account_id: input.account_id, created_by: input.actor_id, object_key: input.key }, input.operation_id),
    ...(input.repo_id ? quotaReservation(db, input.repo_id, size, limits(env).repository_storage_bytes) : []),
    stmt(db, `INSERT INTO object_manifests(id,repo_id,account_id,kind,object_key,bucket,filename,content_type,bytes,sha256,state,
      created_by,retention_until,requested_retention_until,reference_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'reserving',?,?,?,?,?,?)`,
    input.id, input.repo_id, input.account_id, input.kind, input.key, input.bucket ?? 'blobs', input.key.split('/').at(-1)!, input.content_type,
    size, digest, input.actor_id, input.retention_until, input.retention_until, input.referenced ? 1 : 0, now(), now()),
  ]);
  let value = await admitObject(env, await loadObject(env, input.id), input.operation_id);
  if (value.state === 'ready') return value;
  if (value.state === 'uploading') return completeObject(env, value, input.operation_id);
  if (value.state !== 'pending' || !value.billing_reservation_id || !value.billing_fence) throw new Error('operation_object_not_writable');
  const currentRepository = await requireLocalAuthority(env, value.repo_id, input.operation_id);
  const claims = await db.batch<StoredObject>([...placementGuard(db, currentRepository, input.operation_id ? await operationFence(db, input.operation_id) : null),
    ...accountExportWriteGuard(db, value, input.operation_id), stmt(db, `UPDATE object_manifests SET state='uploading',upload_generation=upload_generation+1,
    upload_bytes_received=?,upload_failure='write_pending',revision=revision+1,updated_at=? WHERE id=? AND state='pending' AND revision=? RETURNING *`,
  size, now(), value.id, value.revision)]);
  const claimed = claims.at(-1)?.results[0];
  if (!claimed) return completeObject(env, await loadObject(env, value.id), input.operation_id);
  value = claimed;
  try {
    const bucket = value.bucket === 'backups' ? env.BACKUPS : env.BLOBS;
    const stored = await bucket.put(value.object_key, input.data, { sha256: value.sha256, onlyIf: { etagDoesNotMatch: '*' },
      customMetadata: { sha256: value.sha256, object_id: value.id, ...(input.repo_id ? { repo_id: input.repo_id } : {}), upload_generation: String(value.upload_generation) },
      httpMetadata: { contentType: value.content_type } });
    if (!stored || !storedMatches(value, stored)) throw new Error('operation_object_write_unconfirmed');
  } catch (error) {
    await db.batch([...placementGuard(db, currentRepository, input.operation_id ? await operationFence(db, input.operation_id) : null),
      stmt(db, `UPDATE object_manifests SET upload_failure='write_uncertain',revision=revision+1,updated_at=?
      WHERE id=? AND state='uploading' AND upload_generation=?`, now(), value.id, value.upload_generation)]);
    throw error;
  }
  return completeObject(env, await loadObject(env, value.id), input.operation_id);
}

export interface RestoreObjectPlan {
  operation_id: string; original_id: string; object_id: string; repo_id: string; account_id: string; kind: string;
  object_key: string; bucket: 'blobs' | 'backups'; bytes: number; sha256: string; content_type: string; filename: string;
  reference_count: number; retention_until: string | null; archive_prefix: string;
}

/** Fresh restore IDs use normal standalone admission; a deleted reservation is never revived. */
export async function putRestoreObject(env: OperationsBindings, operation: Operation, plan: RestoreObjectPlan,
  open: () => Promise<ReadableStream<Uint8Array>>): Promise<StoredObject> {
  const db = env.DB.withSession('first-primary');
  if (!await one(db, `SELECT 1 FROM repository_restore_objects p JOIN repository_restore_plans r ON r.operation_id=p.operation_id
    WHERE p.operation_id=? AND p.object_id=? AND p.object_key=? AND p.sha256=? AND p.bytes=? AND p.repo_id=? AND r.state IN ('staging','prepared')`,
  operation.id, plan.object_id, plan.object_key, plan.sha256, plan.bytes, operation.repo_id)) throw new Error('restore_object_not_declared');
  const repo = await requireLocalAuthority(env, plan.repo_id, operation.id);
  if (!repo || repo.owner_id !== plan.account_id || !plan.object_key.startsWith(`${plan.account_id}/${plan.repo_id}/restores/${operation.id}/`)
    || !['attachment', 'avatar', 'collaboration_attachment', 'git_lfs', 'restore_execution'].includes(plan.kind)) throw new Error('restore_object_scope');
  await registerResourceLocator(env, { resource_id: plan.object_id, resource_type: 'object', repo_id: plan.repo_id });
  if (!await one(db, 'SELECT 1 FROM object_manifests WHERE id=?', plan.object_id)) await consumeOnce(db, 'restore-object-reserve', plan.object_id, [
    ...placementGuard(db, repo, await operationFence(db, operation.id)),
    ...quotaReservation(db, repo.id, plan.bytes, limits(env).repository_storage_bytes),
    ...(plan.kind === 'git_lfs' ? [
      stmt(db, 'INSERT INTO git_lfs_quotas(repo_id,byte_limit,updated_at) VALUES(?,?,?) ON CONFLICT(repo_id) DO NOTHING', repo.id, readGitLimits(env.LIMITS_JSON).lfs_repository_bytes, now()),
      ...checked(db, stmt(db, `UPDATE git_lfs_quotas SET reserved_bytes=reserved_bytes+?,revision=revision+1,updated_at=?
        WHERE repo_id=? AND used_bytes+reserved_bytes+?<=byte_limit`, plan.bytes, now(), repo.id, plan.bytes)),
    ] : []),
    stmt(db, `INSERT INTO object_manifests(id,repo_id,account_id,kind,object_key,bucket,filename,content_type,bytes,sha256,state,created_by,
      retention_until,requested_retention_until,reference_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'reserving',?,?,?,0,?,?)`,
    plan.object_id, repo.id, plan.account_id, plan.kind, plan.object_key, plan.bucket, plan.filename, plan.content_type, plan.bytes, plan.sha256,
    operation.actor_id, plan.retention_until, plan.retention_until, now(), now()),
  ]);
  let value = await admitObject(env, await loadObject(env, plan.object_id), operation.id);
  if (value.sha256 !== plan.sha256 || value.bytes !== plan.bytes || value.object_key !== plan.object_key) throw new Error('restore_object_conflict');
  if (value.state === 'ready') return value;
  if (value.state === 'pending') {
    await ownerBatch(env, repo.id, operation.id, checked(db, stmt(db, `UPDATE object_manifests SET state='uploading',upload_generation=upload_generation+1,
      upload_failure='write_pending',upload_bytes_received=0,revision=revision+1,updated_at=? WHERE id=? AND state='pending' AND revision=?`, now(), value.id, value.revision)));
    value = await loadObject(env, value.id);
    const bucket = value.bucket === 'backups' ? env.BACKUPS : env.BLOBS;
    try {
      let body = await open();
      if (typeof FixedLengthStream !== 'undefined') body = body.pipeThrough(new FixedLengthStream(value.bytes));
      const stored = await bucket.put(value.object_key, body, { sha256: value.sha256, onlyIf: { etagDoesNotMatch: '*' },
        customMetadata: { sha256: value.sha256, object_id: value.id, repo_id: repo.id, upload_generation: String(value.upload_generation) },
        httpMetadata: { contentType: value.content_type } });
      if (!stored || !storedMatches(value, stored)) throw new Error('restore_object_upload_unconfirmed');
    } catch (error) {
      await ownerBatch(env, repo.id, operation.id, [stmt(db, "UPDATE object_manifests SET upload_failure='write_uncertain' WHERE id=? AND state='uploading' AND upload_generation=?", value.id, value.upload_generation)]);
      throw error;
    }
  }
  const head = await (value.bucket === 'backups' ? env.BACKUPS : env.BLOBS).head(value.object_key);
  if (value.state !== 'uploading' || !head || !storedMatches(value, head)) throw new Error('restore_object_upload_unconfirmed');
  await ownerBatch(env, repo.id, operation.id, [stmt(db, `UPDATE object_manifests SET upload_bytes_received=bytes WHERE id=? AND state='uploading' AND upload_generation=?`, value.id, value.upload_generation)]);
  return completeObject(env, await loadObject(env, value.id), operation.id);
}

/** A verified restore owns removal of the previous, now-unreferenced physical objects. */
export async function deleteRestorePreviousObject(env: OperationsBindings, operation: Operation, objectId: string): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const declared = await one(db, `SELECT 1 FROM repository_restore_previous_rows p JOIN repository_restore_plans r ON r.operation_id=p.operation_id
    WHERE p.operation_id=? AND p.table_name='object_manifests' AND json_extract(p.data_json,'$.id')=? AND r.state='verified'`, operation.id, objectId);
  if (!declared) throw new Error('restore_previous_object_not_declared');
  let object = await loadObject(env, objectId);
  if (object.state === 'deleted') return;
  if (object.repo_id !== operation.repo_id || object.reference_count !== 0) throw new Error('restore_previous_object_referenced');
  if (object.state === 'uploading') {
    const head = await (object.bucket === 'backups' ? env.BACKUPS : env.BLOBS).head(object.object_key);
    if (!head || !storedMatches(object, head) || !object.billing_reservation_id || !object.billing_fence) throw new Error('restore_previous_upload_unconfirmed');
    await commitStorageObject(env, { account_id: object.account_id, object_id: object.id, reservation_id: object.billing_reservation_id,
      fence: object.billing_fence, bytes: String(object.bytes), etag: head.etag, checksum: object.sha256 });
  }
  await ownerBatch(env, object.repo_id!, operation.id, [stmt(db, "UPDATE object_manifests SET state='deleting',revision=revision+1,updated_at=? WHERE id=? AND state<>'deleted' AND reference_count=0", now(), object.id)]);
  object = await loadObject(env, object.id);
  if (object.billing_reservation_id && object.billing_fence) {
    const receipt = await deleteStorageObject(env, { account_id: object.account_id, object_id: object.id });
    if (!billingMatches(object, receipt) || receipt.state !== 'deleted' || receipt.fence !== object.billing_fence
      || await (object.bucket === 'backups' ? env.BACKUPS : env.BLOBS).head(object.object_key)) throw new Error('restore_previous_deletion_unconfirmed');
  } else {
    const receipt = await cancelStandaloneStorageIntent(env, { account_id: object.account_id, object_id: object.id, repo_id: object.repo_id });
    if (receipt.state !== 'cancelled' || receipt.id !== object.id || receipt.account_id !== object.account_id) throw new Error('restore_previous_cancellation_unconfirmed');
  }
  const column = object.storage_accrued_at ? 'used_bytes' : 'reserved_bytes';
  const restored = await one(db, 'SELECT 1 FROM repository_restore_objects WHERE object_id=?', object.id);
  await consumeOnce(db, 'restore-previous-object-delete', object.id, [
    ...placementGuard(db, await requireLocalAuthority(env, object.repo_id, operation.id), await operationFence(db, operation.id)),
    ...checked(db, stmt(db, "UPDATE object_manifests SET state='deleted',revision=revision+1,updated_at=? WHERE id=? AND state='deleting' AND revision=? AND reference_count=0", now(), object.id, object.revision)),
    ...(object.kind !== 'git_lfs' || restored ? checked(db, stmt(db, `UPDATE storage_quotas SET ${column}=${column}-?,revision=revision+1,updated_at=? WHERE scope_id=? AND ${column}>=?`, object.bytes, now(), object.repo_id, object.bytes)) : []),
    ...(object.kind === 'git_lfs' ? checked(db, stmt(db, `UPDATE git_lfs_quotas SET ${column}=${column}-?,revision=revision+1,updated_at=? WHERE repo_id=? AND ${column}>=?`, object.bytes, now(), object.repo_id, object.bytes)) : []),
    eventStatement(db, { type: 'object.deleted', resource_id: object.id, resource_revision: object.revision + 1, repo_id: object.repo_id,
      account_id: object.account_id, actor_id: operation.actor_id, data: { operation_id: operation.id, physical_deletion_verified: true } }),
  ]);
}

export async function recoverOperationObjects(env: OperationsBindings, repoId?: string, operationId?: string): Promise<void> {
  const rows = await many<StoredObject>(env.DB, `SELECT * FROM object_manifests WHERE kind IN ('archive_chunk','account_export_chunk','collaboration_code_scan','scan_chunk')
    AND state='uploading' AND upload_bytes_received=bytes AND upload_failure IN ('write_pending','write_uncertain')
    AND (? IS NULL OR repo_id=?) ORDER BY updated_at,id LIMIT 50`, repoId ?? null, repoId ?? null);
  for (const row of rows) {
    if (row.repo_id && !await localRepository(env, row.repo_id, operationId)) continue;
    try { await completeObject(env, row, operationId); }
    catch (error) { console.error(JSON.stringify({ component: 'operation-object-recovery', object_id: row.id, code: error instanceof ApiError ? error.code : 'upload_unconfirmed' })); }
  }
}

export async function accrueObjects(env: OperationsBindings, repoId?: string): Promise<number> {
  const db = env.DB.withSession('first-primary');
  const until = repoId ? now() : storageAccrualCheckpoint(now(), storagePolicy(env).periodic_accrual_seconds);
  const rows = await many<StoredObject>(db, `SELECT * FROM object_manifests WHERE state='ready' AND billing_fence IS NOT NULL
    AND storage_accrued_at IS NOT NULL AND storage_accrued_at<? AND (? IS NULL OR repo_id=?) ORDER BY storage_accrued_at,id LIMIT 100`, until, repoId ?? null, repoId ?? null);
  for (const row of rows) {
    const repository = row.repo_id ? await localRepository(env, row.repo_id) : null;
    if (row.repo_id ? !repository : !isIdentityPlacement(env)) continue;
    const receipt = await accrueStorage(env, { account_id: row.account_id, object_id: row.id, through: until });
    if (receipt.state !== 'stored') continue;
    if (!billingMatches(row, receipt) || receipt.fence !== row.billing_fence) throw new Error('storage_meter_scope_changed');
    await db.batch([...placementGuard(db, repository), stmt(db, `UPDATE object_manifests SET storage_accrued_at=? WHERE id=? AND state='ready' AND billing_fence=? AND storage_accrued_at=?`,
      receipt.accrued_at, row.id, row.billing_fence, row.storage_accrued_at)]);
  }
  return rows.length;
}

async function finishOwnedDeletion(env: OperationsBindings, value: StoredObject, operationId?: string): Promise<void> {
  const current = await loadObject(env, value.id);
  if (current.state === 'deleted') return;
  const db = env.DB.withSession('first-primary');
  const repository = await requireLocalAuthority(env, current.repo_id, operationId);
  const column = current.storage_accrued_at ? 'used_bytes' : 'reserved_bytes';
  await consumeOnce(db, 'operations-object-delete', current.id, [
    ...placementGuard(db, repository, operationId ? await operationFence(db, operationId) : null),
    ...checked(db, stmt(db, `UPDATE object_manifests SET state='deleted',revision=revision+1,updated_at=? WHERE id=? AND state='deleting'
       AND revision=? AND billing_fence IS ? AND reference_count=0`, now(), current.id, current.revision, current.billing_fence)),
    ...(current.repo_id ? checked(db, stmt(db, `UPDATE storage_quotas SET ${column}=${column}-?,revision=revision+1,updated_at=? WHERE scope_id=? AND ${column}>=?`,
      current.bytes, now(), current.repo_id, current.bytes)) : []),
    ...(current.kind === 'restore_execution' ? [stmt(db, "UPDATE execution_objects SET state='deleted',deleted_at=? WHERE id=? AND repo_id=?", now(), current.id, current.repo_id)] : []),
    eventStatement(db, { id: `evt_${current.id}_deleted`, type: 'object.deleted', resource_id: current.id, resource_revision: current.revision + 1,
      repo_id: current.repo_id, account_id: current.account_id, data: { bytes: current.bytes, physical_deletion_verified: true } }),
  ]);
}

/** Billed objects are physically deleted and financially released by the account authority. */
export async function deleteExpiredObjects(env: OperationsBindings, repoId?: string, operationId?: string): Promise<number> {
  const rows = await many<StoredObject>(env.DB, `SELECT * FROM object_manifests m
    WHERE m.kind IN ('attachment','avatar','archive_chunk','account_export_chunk','collaboration_code_scan','scan_chunk','restore_execution') AND m.reference_count=0
    AND (m.state='deleting' OR (m.retention_until IS NOT NULL AND m.retention_until<=? AND m.state IN ('reserving','ready','pending','failed')))
    AND (m.storage_accrued_at IS NOT NULL OR m.upload_generation=0 OR m.upload_failure='input_incomplete')
    AND (? IS NULL OR m.repo_id=?) AND NOT EXISTS(SELECT 1 FROM git_lfs_objects l WHERE l.storage_key=m.object_key AND l.state='available')
    ORDER BY m.retention_until,m.id LIMIT 100`, now(), repoId ?? null, repoId ?? null);
  for (const row of rows) {
    try { await deleteBilledObject(env, row, operationId); }
    catch (error) { if (!isPlacementRace(error)) throw error; }
  }
  return rows.length;
}

async function fenceDeletion(env: OperationsBindings, row: StoredObject, operationId?: string): Promise<StoredObject> {
  const repository = await requireLocalAuthority(env, row.repo_id, operationId);
  if (!ownedKinds.has(row.kind) && !genericKinds.has(row.kind)) throw new Error('object_owner_required');
  if (row.state === 'deleted' || row.state === 'deleting') return row;
  if (row.reference_count !== 0 || !['reserving', 'ready', 'pending', 'failed'].includes(row.state)
    || !row.storage_accrued_at && row.upload_generation !== 0 && row.upload_failure !== 'input_incomplete') throw new Error('object_upload_unconfirmed');
  const db = env.DB.withSession('first-primary');
  await db.batch([
    ...placementGuard(db, repository, operationId ? await operationFence(db, operationId) : null),
    ...checked(db, stmt(db, `UPDATE object_manifests SET state='deleting',retention_until=?,revision=revision+1,updated_at=?
      WHERE id=? AND revision=? AND state=? AND reference_count=0 AND billing_fence IS ?`, now(), now(), row.id, row.revision, row.state, row.billing_fence)),
    eventStatement(db, { type: 'object.deleting', resource_id: row.id, resource_revision: row.revision + 1,
      repo_id: row.repo_id, account_id: row.account_id, data: { was_ready: row.storage_accrued_at !== null } }),
  ]);
  return loadObject(env, row.id);
}

async function finishGenericDeletion(env: OperationsBindings, row: StoredObject, operationId?: string): Promise<void> {
  const current = await loadObject(env, row.id);
  if (current.state === 'deleted') return;
  if (current.state !== 'deleting') throw new Error('object_deletion_fence_missing');
  const db = env.DB.withSession('first-primary');
  const repository = await requireLocalAuthority(env, current.repo_id, operationId);
  const mutation = genericObjectDeletionMutation(db, { ...current, state: current.state });
  await consumeOnce(db, 'operations-generic-object-delete', current.id, [
    ...placementGuard(db, repository, operationId ? await operationFence(db, operationId) : null), ...checked(db, stmt(db, mutation.sql, ...(mutation.bindings ?? []))),
    ...(mutation.after ?? []), eventStatement(db, mutation.event),
  ]);
}

async function deleteBilledObject(env: OperationsBindings, value: StoredObject, operationId?: string): Promise<void> {
  await registerResourceLocator(env, { resource_id: value.id, resource_type: 'object', repo_id: value.repo_id });
  const row = await fenceDeletion(env, value, operationId);
  if (row.state === 'deleted') return;
  if (!row.billing_reservation_id) {
    const proof = await cancelStandaloneStorageIntent(env, { account_id: row.account_id, object_id: row.id, repo_id: row.repo_id });
    if (proof.state !== 'cancelled' || proof.id !== row.id || proof.account_id !== row.account_id || proof.repo_id !== row.repo_id
      || proof.key !== row.object_key || proof.bucket !== row.bucket) throw new Error('object_intent_cancellation_unconfirmed');
  } else {
    if (!row.billing_fence) throw new Error('object_billing_unconfirmed');
    const receipt = await deleteStorageObject(env, { account_id: row.account_id, object_id: row.id });
    if (!billingMatches(row, receipt) || receipt.state !== 'deleted' || receipt.reservation_id !== row.billing_reservation_id || receipt.fence !== row.billing_fence
      || await (row.bucket === 'backups' ? env.BACKUPS : env.BLOBS).head(row.object_key)) throw new Error('object_deletion_unconfirmed');
  }
  if (ownedKinds.has(row.kind)) await finishOwnedDeletion(env, row, operationId);
  else await finishGenericDeletion(env, row, operationId);
}

/** A final move snapshot cannot retain an old placement's unfinished deletion. */
export async function drainRepositoryObjects(env: OperationsBindings, repoId: string, operationId: string): Promise<void> {
  await requireLocalAuthority(env, repoId, operationId);
  await recoverOperationObjects(env, repoId, operationId);
  for (let page = 0; page < 100; page++) {
    if (await deleteExpiredObjects(env, repoId, operationId) < 100) break;
  }
  if (await one(env.DB, `SELECT 1 FROM object_manifests WHERE repo_id=? AND kind IN ('attachment','avatar','archive_chunk','collaboration_code_scan','scan_chunk')
    AND state IN ('reserving','pending','uploading','deleting') LIMIT 1`, repoId)) throw new Error('move_object_work_draining');
}

export async function deleteOperationObject(env: OperationsBindings, id: string, operationId?: string): Promise<void> {
  const row = await loadObject(env, id);
  if (!ownedKinds.has(row.kind) || row.reference_count !== 0) throw new Error('operation_object_retained');
  if (row.state === 'deleted') return;
  await deleteBilledObject(env, row, operationId);
}

/** Billing owns the physical meter; each feature owns the logical references it expires. */
export async function deleteRequestedObject(env: OperationsBindings, request: StorageDeletionRequest): Promise<boolean> {
  const value = await one<StoredObject>(env.DB.withSession('first-primary'), 'SELECT * FROM object_manifests WHERE id=?', request.object_id);
  if (!value || !ownedKinds.has(value.kind) && !genericKinds.has(value.kind)) return false;
  const repository = await requireLocalAuthority(env, value.repo_id);
  if (value.account_id !== request.account_id || value.repo_id !== request.repo_id || value.billing_fence !== request.fence
    || value.billing_reservation_id !== request.reservation_id) throw new Error('storage_deletion_request_scope');
  if (value.state === 'deleted') return true;
  if (genericKinds.has(value.kind) && value.reference_count !== 0) return false;
  const receipt = await claimStorageDeletion(env, { account_id: value.account_id, object_id: value.id, request_id: request.id });
  if (!billingMatches(value, receipt) || receipt.fence !== request.fence || !['deleting', 'deleted'].includes(receipt.state)) throw new Error('storage_deletion_claim_unconfirmed');
  if (value.kind === 'collaboration_code_scan') await invalidateCodeScanObject(env, value);
  const db = env.DB.withSession('first-primary');
  try {
    await consumeOnce(db, 'operations-storage-expiry', request.id, [
      ...placementGuard(db, repository),
      ...(value.kind === 'account_export_chunk' ? [stmt(db, `UPDATE account_exports SET state='expired',error_code='storage_expired',revision=revision+1,updated_at=?
        WHERE id IN (SELECT export_id FROM account_export_parts WHERE object_id=?) AND state NOT IN ('deleted','deleting','expired')`, now(), value.id)] : []),
      ...(value.kind === 'archive_chunk' ? [
        stmt(db, `UPDATE repository_archives SET state='expired',revision=revision+1 WHERE state IN ('writing','verified')
          AND id IN (SELECT archive_id FROM archive_parts WHERE object_key=?)`, value.object_key),
        stmt(db, `UPDATE repository_exports SET state='expired',revision=revision+1 WHERE operation_id IN (
          SELECT a.operation_id FROM repository_archives a JOIN archive_parts p ON p.archive_id=a.id WHERE p.object_key=?)`, value.object_key),
        stmt(db, `UPDATE object_manifests SET reference_count=0,retention_until=?,revision=revision+1,updated_at=? WHERE kind='archive_chunk' AND state<>'deleted'
          AND object_key IN (SELECT p.object_key FROM archive_parts p WHERE p.archive_id IN (SELECT archive_id FROM archive_parts WHERE object_key=?))`, now(), now(), value.object_key),
      ] : []),
      stmt(db, `UPDATE object_manifests SET reference_count=0,retention_until=?,revision=revision+1,updated_at=?
        WHERE id=? AND billing_fence=? AND state<>'deleted'`, now(), now(), value.id, request.fence),
      eventStatement(db, { type: 'object.retention_expired', resource_id: value.id, resource_revision: value.revision + 1,
        repo_id: value.repo_id, account_id: value.account_id, data: { reason: request.reason, request_id: request.id } }),
    ]);
  } catch (error) {
    if (!await one(db, `SELECT 1 FROM processed_events WHERE consumer='operations-storage-expiry' AND event_id=?`, request.id)) {
      await releaseStorageDeletionClaim(env, { account_id: value.account_id, object_id: value.id, request_id: request.id });
    }
    throw error;
  }
  await deleteBilledObject(env, await loadObject(env, value.id));
  return true;
}
