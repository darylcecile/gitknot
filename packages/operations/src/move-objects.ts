import { createHash } from 'node:crypto';
import { canonicalJson, hex, identityBinding, many, mutationGuard, newId, now, one, sha256, stmt } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import { admissionRequest } from '../../billing/src/transport.ts';
import type { StorageObject } from '../../billing/src/types.ts';
import { placementCopy, storagePlacement } from '../../billing/src/placement-state.ts';
import { ownerBatch } from './metadata-fence.ts';
import type { MoveControl } from './move-control.ts';

export interface MovePhysicalObject {
  operation_id: string; object_id: string; repo_id: string; account_id: string;
  bucket: 'blobs' | 'backups' | 'snapshots'; object_key: string; bytes: number; sha256: string;
  source_etag: string; source_uploaded_at: string; custom_metadata_json: string; http_metadata_json: string;
  state: 'declared' | 'writing' | 'stored' | 'deleting' | 'deleted'; copy_fence: string | null; write_id: string | null;
  target_etag: string | null; target_uploaded_at: string | null; source_deleted_at: string | null; verified_at: string | null;
}
interface ObjectHint { id: string; key: string; bucket: MovePhysicalObject['bucket']; bytes?: number; sha256?: string }

export function moveBucket(env: Bindings, bucket: MovePhysicalObject['bucket']): R2Bucket {
  if (bucket === 'blobs') return env.BLOBS;
  if (bucket === 'backups') return env.BACKUPS;
  const snapshots = env.BACKUP_BUCKET;
  if (!snapshots || typeof snapshots !== 'object' || !('head' in snapshots) || !('put' in snapshots) || !('delete' in snapshots)) {
    throw new Error('move_snapshot_bucket_unavailable');
  }
  return snapshots as R2Bucket;
}

function immutable(value: MovePhysicalObject): Record<string, unknown> {
  return { operation_id: value.operation_id, object_id: value.object_id, repo_id: value.repo_id, account_id: value.account_id,
    bucket: value.bucket, object_key: value.object_key, bytes: value.bytes, sha256: value.sha256, source_etag: value.source_etag,
    source_uploaded_at: value.source_uploaded_at, custom_metadata_json: value.custom_metadata_json, http_metadata_json: value.http_metadata_json };
}

async function declareObject(env: Bindings, control: MoveControl, hint: ObjectHint): Promise<void> {
  const prior = await one<MovePhysicalObject>(env.DB, 'SELECT * FROM move_physical_objects WHERE operation_id=? AND object_id=?', control.operation_id, hint.id);
  if (prior) {
    if (prior.object_key !== hint.key || prior.bucket !== hint.bucket || hint.bytes !== undefined && prior.bytes !== hint.bytes
      || hint.sha256 !== undefined && prior.sha256 !== hint.sha256) throw new Error('move_object_inventory_conflict');
    return;
  }
  const receipt = await admissionRequest<StorageObject>(env, `account:${control.account_id}`, 'get-object', { object_id: hint.id });
  if (receipt.id !== hint.id || receipt.account_id !== control.account_id || receipt.attribution.repo_id !== control.repo_id
    || receipt.state !== 'stored' || receipt.key !== hint.key || receipt.bucket !== hint.bucket || receipt.storage_cell_id !== control.source_cell_id
    || !receipt.checksum || !receipt.etag || hint.bytes !== undefined && receipt.bytes !== String(hint.bytes)
    || hint.sha256 !== undefined && receipt.checksum !== hint.sha256) throw new Error('move_source_billing_evidence_changed');
  const head = await moveBucket(env, hint.bucket).head(hint.key);
  const bytes = Number(receipt.bytes);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || !head || head.size !== bytes || head.etag !== receipt.etag
    || head.checksums.sha256 && hex(new Uint8Array(head.checksums.sha256)) !== receipt.checksum) throw new Error('move_source_object_unverified');
  const value = { operation_id: control.operation_id, object_id: hint.id, repo_id: control.repo_id, account_id: control.account_id,
    bucket: hint.bucket, object_key: hint.key, bytes, sha256: receipt.checksum, source_etag: head.etag,
    source_uploaded_at: head.uploaded.toISOString(), custom_metadata_json: canonicalJson(head.customMetadata ?? {}),
    http_metadata_json: canonicalJson(JSON.parse(JSON.stringify(head.httpMetadata ?? {}))) };
  const fields = Object.keys(value);
  await ownerBatch(env, control.repo_id, control.operation_id, [stmt(env.DB,
    `INSERT INTO move_physical_objects(${fields.join(',')},state) VALUES(${fields.map(() => '?').join(',')},'declared') ON CONFLICT(operation_id,object_id) DO NOTHING`,
    ...Object.values(value))]);
  const current = await one<MovePhysicalObject>(env.DB, 'SELECT * FROM move_physical_objects WHERE operation_id=? AND object_id=?', control.operation_id, hint.id);
  if (!current || canonicalJson(immutable(current)) !== canonicalJson(value)) throw new Error('move_object_inventory_conflict');
}

async function declareMetadataObjects(env: Bindings, control: MoveControl, table: 'object_manifests' | 'execution_objects' | 'execution_snapshots'): Promise<void> {
  let cursor = 0;
  for (;;) {
    const rows = await many<{ row_key: number; data_json: string }>(env.DB,
      'SELECT row_key,data_json FROM move_source_rows WHERE operation_id=? AND table_name=? AND row_key>? ORDER BY row_key LIMIT 50', control.operation_id, table, cursor);
    if (!rows.length) return;
    for (const row of rows) {
      const data = JSON.parse(row.data_json) as Record<string, unknown>;
      if (data.state !== (table === 'object_manifests' ? 'ready' : 'sealed')) continue;
      if (data.account_id !== control.account_id || data.repo_id !== control.repo_id) throw new Error('move_object_owner_changed');
      if (table === 'execution_snapshots') {
        for (const key of [String(data.archive_key), String(data.metadata_key)]) await declareObject(env, control,
          { id: `sdk_${(await sha256(key)).slice(0, 48)}`, key, bucket: 'snapshots' });
      } else await declareObject(env, control, { id: String(data.id), key: String(data.object_key),
        bucket: data.bucket === 'backups' ? 'backups' : 'blobs', bytes: Number(table === 'object_manifests' ? data.bytes : data.size_bytes), sha256: String(data.sha256) });
    }
    cursor = rows.at(-1)!.row_key;
  }
}

/** Inventory is frozen before placement admission, including retained financial objects without a finished feature link. */
export async function materializeMoveObjects(env: Bindings, control: MoveControl): Promise<void> {
  if (!control.snapshot_sha256 || !await one(env.DB, 'SELECT 1 FROM move_source_snapshots WHERE operation_id=?', control.operation_id)) throw new Error('move_source_snapshot_required');
  for (const table of ['object_manifests', 'execution_objects', 'execution_snapshots'] as const) await declareMetadataObjects(env, control, table);
  let cursor = '';
  for (;;) {
    const rows = await many<{ id: string; object_key: string; bucket: MovePhysicalObject['bucket']; body_json: string }>(identityBinding(env).withSession('first-primary'),
      `SELECT id,object_key,bucket,body_json FROM billing_storage_objects WHERE coordinator_id=? AND repo_id=? AND state='stored' AND id>? ORDER BY id LIMIT 100`,
      `account:${control.account_id}`, control.repo_id, cursor);
    if (!rows.length) return;
    for (const row of rows) {
      const source = JSON.parse(row.body_json) as StorageObject;
      if (source.storage_cell_id === control.source_cell_id && !source.placement_shadow) await declareObject(env, control, { id: row.id, key: row.object_key, bucket: row.bucket });
    }
    cursor = rows.at(-1)!.id;
  }
}

export async function readMoveObjects(env: Bindings, operationId: string, after = '', limit = 50): Promise<MovePhysicalObject[]> {
  return many(env.DB.withSession('first-primary'), 'SELECT * FROM move_physical_objects WHERE operation_id=? AND object_id>? ORDER BY object_id LIMIT ?', operationId, after, limit);
}

export async function moveInventory(env: Bindings, operationId: string): Promise<{ sha256: string; count: number }> {
  const hash = createHash('sha256'); let after = '', count = 0;
  for (;;) {
    const rows = await readMoveObjects(env, operationId, after);
    if (!rows.length) return { sha256: hash.digest('hex'), count };
    for (const row of rows) { hash.update(`${canonicalJson(immutable(row))}\n`); count++; }
    after = rows.at(-1)!.object_id;
  }
}

export async function acceptMoveObjects(env: Bindings, control: MoveControl, rows: MovePhysicalObject[]): Promise<void> {
  if (!Array.isArray(rows) || rows.length > 50 || control.state !== 'copying') throw new Error('move_object_declarations_closed');
  for (const row of rows) {
    if (row.operation_id !== control.operation_id || row.repo_id !== control.repo_id || row.account_id !== control.account_id
      || !['blobs', 'backups', 'snapshots'].includes(row.bucket) || !Number.isSafeInteger(row.bytes) || row.bytes < 0
      || !/^[a-f0-9]{64}$/.test(row.sha256)) throw new Error('move_object_declaration_invalid');
    const data = immutable(row), fields = Object.keys(data);
    await ownerBatch(env, control.repo_id, control.operation_id, [stmt(env.DB, `INSERT INTO move_physical_objects(${fields.join(',')},state)
      VALUES(${fields.map(() => '?').join(',')},'declared') ON CONFLICT(operation_id,object_id) DO NOTHING`, ...Object.values(data))]);
    const saved = await one<MovePhysicalObject>(env.DB, 'SELECT * FROM move_physical_objects WHERE operation_id=? AND object_id=?', control.operation_id, row.object_id);
    if (!saved || canonicalJson(immutable(saved)) !== canonicalJson(data)) throw new Error('move_object_declaration_conflict');
  }
}

async function requireInventory(env: Bindings, control: MoveControl): Promise<void> {
  const inventory = await moveInventory(env, control.operation_id);
  if (inventory.sha256 !== control.physical_sha256 || inventory.count !== control.physical_count) throw new Error('move_physical_inventory_changed');
}

/** Observe Billing's one writer. Operations never issues a second destination PUT. */
export async function verifyMoveObjects(env: Bindings, control: MoveControl): Promise<void> {
  await requireInventory(env, control);
  let after = '';
  for (;;) {
    const rows = await readMoveObjects(env, control.operation_id, after);
    if (!rows.length) return;
    for (const row of rows) {
      const copy = await placementCopy(env, control.operation_id, row.object_id);
      if (!['stored', 'active', 'cleaned', 'released'].includes(copy.state) || copy.source.key !== row.object_key
        || copy.source.checksum !== row.sha256 || copy.source.bytes !== String(row.bytes) || copy.source.etag !== row.source_etag) throw new Error('move_copy_receipt_changed');
      const head = await moveBucket(env, row.bucket).head(row.object_key);
      const sameCell = control.source_cell_id === control.target_cell_id;
      const expectedMetadata = JSON.parse(row.custom_metadata_json) as Record<string, string>;
      if (!sameCell) Object.assign(expectedMetadata, { sha256: row.sha256, billing_placement_writer: copy.writer_id });
      if (!head || head.size !== row.bytes || !head.checksums.sha256 || hex(new Uint8Array(head.checksums.sha256)) !== row.sha256
        || head.etag !== (sameCell ? row.source_etag : copy.receipt?.etag)
        || canonicalJson(head.customMetadata ?? {}) !== canonicalJson(expectedMetadata)
        || canonicalJson(JSON.parse(JSON.stringify(head.httpMetadata ?? {}))) !== row.http_metadata_json) throw new Error('move_destination_object_unverified');
      await ownerBatch(env, control.repo_id, control.operation_id, [stmt(env.DB, `UPDATE move_physical_objects SET state='stored',copy_fence=?,write_id=?,
        target_etag=?,target_uploaded_at=?,verified_at=COALESCE(verified_at,?) WHERE operation_id=? AND object_id=? AND state IN ('declared','stored')`,
      (await storagePlacement(env, control.operation_id)).fence, copy.writer_id, head.etag, head.uploaded.toISOString(), now(), control.operation_id, row.object_id)]);
    }
    after = rows.at(-1)!.object_id;
  }
}

interface AppliedReceipt {
  reservation_id: string; fence: string; accrued_at: string; storage_cell_id: string; storage_epoch: number;
  bytes: string; checksum: string; etag: string; manifest_revision: number | null; manifest_updated_at: string;
}

export async function applyMoveStorageReceipts(env: Bindings, control: MoveControl): Promise<void> {
  await requireInventory(env, control);
  const db = env.DB.withSession('first-primary'); let after = '';
  for (;;) {
    const rows = await readMoveObjects(env, control.operation_id, after);
    if (!rows.length) return;
    for (const row of rows) {
      if (await one(db, 'SELECT 1 FROM move_applied_storage_receipts WHERE operation_id=? AND object_id=?', control.operation_id, row.object_id)) continue;
      const receipt = await admissionRequest<StorageObject>(env, `account:${control.account_id}`, 'get-object', { object_id: row.object_id });
      if (receipt.state !== 'stored' || receipt.account_id !== control.account_id || receipt.attribution.repo_id !== control.repo_id
        || receipt.key !== row.object_key || receipt.bucket !== row.bucket || receipt.bytes !== String(row.bytes) || receipt.checksum !== row.sha256
        || receipt.storage_cell_id !== control.target_cell_id || receipt.storage_epoch !== control.target_epoch || !receipt.etag) throw new Error('move_financial_receipt_unverified');
      const original = await one<{ data_json: string }>(db, `SELECT data_json FROM move_snapshot_rows WHERE operation_id=? AND table_name='object_manifests'
        AND json_extract(data_json,'$.id')=?`, control.operation_id, row.object_id);
      const manifest = original ? JSON.parse(original.data_json) as { revision: number; billing_reservation_id: string; billing_fence: string } : null;
      const at = now(), saved: AppliedReceipt = { reservation_id: receipt.reservation_id, fence: receipt.fence, accrued_at: receipt.accrued_at,
        storage_cell_id: control.target_cell_id, storage_epoch: control.target_epoch, bytes: receipt.bytes, checksum: row.sha256, etag: receipt.etag,
        manifest_revision: manifest ? manifest.revision + 1 : null, manifest_updated_at: at };
      const statements: D1PreparedStatement[] = [];
      if (manifest) {
        const guard = newId('guard');
        statements.push(stmt(db, `UPDATE object_manifests SET billing_reservation_id=?,billing_fence=?,storage_accrued_at=?,revision=?,updated_at=?
          WHERE id=? AND repo_id=? AND state='ready' AND revision=? AND billing_reservation_id=? AND billing_fence=?`, receipt.reservation_id, receipt.fence,
        receipt.accrued_at, saved.manifest_revision, at, row.object_id, control.repo_id, manifest.revision, manifest.billing_reservation_id, manifest.billing_fence),
        mutationGuard(db, guard), stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard));
      }
      statements.push(stmt(db, `UPDATE git_lfs_uploads SET billing_reservation_id=?,billing_fence=? WHERE repo_id=? AND object_id=? AND state='complete'`,
        receipt.reservation_id, receipt.fence, control.repo_id, row.object_id),
      stmt(db, 'INSERT INTO move_applied_storage_receipts(operation_id,object_id,receipt_json,applied_at) VALUES(?,?,?,?)', control.operation_id, row.object_id, canonicalJson(saved), at));
      await ownerBatch(env, control.repo_id, control.operation_id, statements);
    }
    after = rows.at(-1)!.object_id;
  }
}

/** Only these receipt-backed fields may differ from the immutable source rowset. */
export async function movedStorageRow(env: Bindings, operationId: string, table: string, row: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (table !== 'object_manifests' && table !== 'git_lfs_uploads') return row;
  const saved = await one<{ receipt_json: string }>(env.DB, 'SELECT receipt_json FROM move_applied_storage_receipts WHERE operation_id=? AND object_id=?',
    operationId, table === 'object_manifests' ? row.id : row.object_id);
  if (!saved) return row;
  const receipt = JSON.parse(saved.receipt_json) as AppliedReceipt;
  return { ...row, billing_reservation_id: receipt.reservation_id, billing_fence: receipt.fence, ...(table === 'object_manifests'
    ? { storage_accrued_at: receipt.accrued_at, revision: receipt.manifest_revision, updated_at: receipt.manifest_updated_at } : {}) };
}

export async function verifyMoveSourceCleanup(env: Bindings, control: MoveControl): Promise<void> {
  if (control.source_cell_id === control.target_cell_id) return;
  const billing = await storagePlacement(env, control.operation_id);
  if (billing.state !== 'complete' || billing.effective_at !== control.effective_at) throw new Error('move_billing_cleanup_unconfirmed');
  let after = '';
  for (;;) {
    const rows = await readMoveObjects(env, control.operation_id, after);
    if (!rows.length) return;
    for (const row of rows) {
      const copy = await placementCopy(env, control.operation_id, row.object_id);
      if (copy.state !== 'released' || !copy.deleted_at || await moveBucket(env, row.bucket).head(row.object_key)) throw new Error('move_source_cleanup_unverified');
      await ownerBatch(env, control.repo_id, control.operation_id, [stmt(env.DB,
        "UPDATE move_physical_objects SET state='deleted',source_deleted_at=? WHERE operation_id=? AND object_id=?", copy.deleted_at, control.operation_id, row.object_id)]);
    }
    after = rows.at(-1)!.object_id;
  }
}
