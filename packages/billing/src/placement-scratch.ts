import { hex, now, one } from '@gitknot/core';
import { admissionRequest } from './transport.ts';
import { invariant } from './errors.ts';
import { placementDb, storagePlacement } from './placement-state.ts';
import type { BillingBindings } from './types.ts';
import type { PlacementGitHold } from './placement-types.ts';

export interface PlacementScratch { operation_id: string; object_key: string; bytes: string; checksum: string;
  state: 'writing' | 'stored' | 'deleted'; started_at: string; uploaded_at: string | null; deleted_at: string | null }

async function scratch(env: BillingBindings, operationId: string): Promise<PlacementScratch | null> {
  return one(placementDb(env), 'SELECT * FROM billing_placement_scratch WHERE operation_id=?', operationId);
}
export async function beginPlacementScratch(env: BillingBindings, input: { operation_id: string; bytes: string; checksum: string }): Promise<{ key: string; write: boolean } | null> {
  if (!await one(placementDb(env), "SELECT 1 FROM sqlite_schema WHERE name='billing_storage_placements'")) return null;
  if (!await one(placementDb(env), 'SELECT 1 FROM billing_storage_placements WHERE operation_id=?', input.operation_id)) return null;
  const p = await storagePlacement(env, input.operation_id);
  invariant(p.state === 'prepared' && p.target_cell_id === env.CELL_ID, 'placement_scratch_fenced', 'The scratch upload is outside its prepared physical handoff.');
  invariant(!await one(placementDb(env), "SELECT 1 FROM billing_placement_receipts WHERE operation_id=? AND step='scratch-unused'", p.operation_id), 'placement_scratch_fenced', 'The unused scratch grant was permanently cancelled.');
  const row = await one<{ body_json: string }>(placementDb(env), 'SELECT body_json FROM billing_placement_git WHERE operation_id=?', p.operation_id);
  const hold = row ? JSON.parse(row.body_json) as PlacementGitHold : null;
  invariant(hold && /^[a-f0-9]{64}$/.test(input.checksum) && BigInt(input.bytes) <= BigInt(hold.scratch_bytes ?? hold.bytes), 'placement_scratch_quota', 'The scratch upload exceeds its declared duplication bound.');
  const key = `${p.account_id}/${p.repo_id}/placement/${p.operation_id}/git.bundle`;
  const inserted = await placementDb(env).prepare(`INSERT OR IGNORE INTO billing_placement_scratch(operation_id,object_key,bytes,checksum,state,started_at)
    SELECT operation_id,?,?,?,'writing',? FROM billing_storage_placements p WHERE operation_id=? AND state='prepared'
      AND NOT EXISTS (SELECT 1 FROM billing_placement_receipts r WHERE r.operation_id=p.operation_id AND r.step='scratch-unused')`)
    .bind(key, input.bytes, input.checksum, now(), p.operation_id).run();
  const current = await scratch(env, p.operation_id);
  invariant(current?.checksum === input.checksum && current.bytes === input.bytes && current.object_key === key, 'placement_scratch_conflict', 'The immutable scratch generation changed.');
  if (inserted.meta.changes === 1) return { key, write: true };
  if (current.state === 'writing') await confirmPlacementScratch(env, p.operation_id);
  return { key, write: false };
}

export async function confirmPlacementScratch(env: BillingBindings, operationId: string): Promise<void> {
  const current = await scratch(env, operationId);
  invariant(current, 'placement_scratch_missing', 'The scratch generation is unavailable.');
  if (current.state !== 'writing') return;
  const head = await env.BLOBS.head(current.object_key);
  invariant(head && String(head.size) === current.bytes && head.checksums.sha256 && hex(new Uint8Array(head.checksums.sha256)) === current.checksum
    && head.customMetadata?.billing_placement_scratch === operationId, 'placement_scratch_uncertain', 'The original scratch writer has no verified positive outcome.', 503);
  await placementDb(env).prepare("UPDATE billing_placement_scratch SET state='stored',uploaded_at=? WHERE operation_id=? AND state='writing'").bind(head.uploaded.toISOString(), operationId).run();
}

export async function deletePlacementScratch(env: BillingBindings, operationId: string): Promise<void> {
  const p = await storagePlacement(env, operationId);
  invariant(env.CELL_ID === p.target_cell_id, 'placement_scratch_cell', 'Scratch cleanup must use its original physical cell.');
  let current = await scratch(env, operationId);
  if (current?.state === 'writing') { await confirmPlacementScratch(env, operationId); current = await scratch(env, operationId); }
  if (current && current.state !== 'deleted') {
    await env.BLOBS.delete(current.object_key);
    invariant(!await env.BLOBS.head(current.object_key), 'placement_scratch_retained', 'The scratch object is still physically retained.', 503);
    await placementDb(env).prepare("UPDATE billing_placement_scratch SET state='deleted',deleted_at=? WHERE operation_id=? AND state='stored'").bind(now(), operationId).run();
  }
  await admissionRequest(env, `account:${p.account_id}`, 'placement-git-scratch', { operation_id: operationId });
  await admissionRequest(env, `capacity:${p.target_git_slice_id}`, 'placement-git-scratch', { operation_id: operationId });
}
