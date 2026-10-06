import { identityBinding, many, one } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import { admissionRequest } from '../../billing/src/transport.ts';
import type { StorageObject } from '../../billing/src/types.ts';
import { verifiedPlacementStorageObject } from '../../billing/src/storage-placement.ts';

export async function retainedStorageReceipt(env: Bindings, input: { id: string; repo_id: string; account_id: string; key: string;
  bytes: number; sha256: string; bucket: StorageObject['bucket'] }): Promise<StorageObject> {
  let receipt = await admissionRequest<StorageObject>(env, `account:${input.account_id}`, 'get-object', { object_id: input.id });
  if (receipt.storage_cell_id !== env.CELL_ID && receipt.placement_handoff_id) receipt = await verifiedPlacementStorageObject(env,
    { operation_id: receipt.placement_handoff_id, object_id: input.id });
  if (receipt.id !== input.id || receipt.account_id !== input.account_id || receipt.attribution.repo_id !== input.repo_id
    || receipt.key !== input.key || receipt.bucket !== input.bucket || receipt.bytes !== String(input.bytes)
    || receipt.checksum !== input.sha256 || receipt.state !== 'stored' || !receipt.reservation_id || !receipt.fence) {
    throw new Error('retained_storage_receipt_unconfirmed');
  }
  return receipt;
}

/** A cross-cell copy cannot open reads/deletes against a different physical billing authority. */
export async function verifyMovedStorageBilling(env: Bindings, repoId: string, targetCellId: string): Promise<void> {
  if (targetCellId === env.CELL_ID) return;
  const owner = await one<{ owner_id: string }>(env.DB, 'SELECT owner_id FROM repositories WHERE id=?', repoId);
  if (!owner) throw new Error('move_repository_missing');
  let cursor = '';
  for (;;) {
    const rows = await many<{ id: string }>(identityBinding(env).withSession('first-primary'), `SELECT id FROM billing_storage_objects
      WHERE coordinator_id=? AND repo_id=? AND state NOT IN ('deleted','transferred') AND COALESCE(json_extract(body_json,'$.placement_shadow'),0)=0
      AND id>? ORDER BY id LIMIT 100`, `account:${owner.owner_id}`, repoId, cursor);
    for (const row of rows) {
      const receipt = await admissionRequest<StorageObject>(env, `account:${owner.owner_id}`, 'get-object', { object_id: row.id });
      if (receipt.state !== 'stored' || receipt.storage_cell_id !== targetCellId || receipt.attribution.repo_id !== repoId) {
        throw new Error('move_physical_billing_handoff_unconfirmed');
      }
    }
    if (rows.length < 100) return;
    cursor = rows.at(-1)!.id;
  }
}
