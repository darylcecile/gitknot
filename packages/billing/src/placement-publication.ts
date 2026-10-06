import { canonicalJson, now, one } from '@gitknot/core';
import { z } from 'zod';
import { invariant } from './errors.ts';
import { placementDb } from './placement-state.ts';
import type { BillingBindings } from './types.ts';
import type { PlacementPublicationFence, StoragePlacement } from './placement-types.ts';

const receiptSchema = z.object({ version: z.literal(1), operation_id: z.string(), repo_id: z.string(), storage_name: z.string(), placement_fence: z.string(),
  side: z.enum(['source','target']), source_epoch: z.number().int().positive(), target_epoch: z.number().int().positive(),
  state: z.enum(['not_started','committed','rejected']), finalized: z.literal(true), writer_fenced: z.literal(true) }).strict();

export async function recordPlacementPublication(env: BillingBindings, p: StoragePlacement, side: 'source' | 'target', raw: unknown): Promise<PlacementPublicationFence> {
  const receipt = receiptSchema.parse(raw);
  invariant(receipt.operation_id === p.operation_id && receipt.repo_id === p.repo_id && receipt.placement_fence === p.fence && receipt.side === side
    && receipt.storage_name === (side === 'source' ? p.source_storage_name : p.target_storage_name)
    && receipt.source_epoch === p.source_epoch && receipt.target_epoch === p.target_epoch, 'placement_publication_scope', 'The terminal publisher receipt belongs to another placement.');
  const db = placementDb(env);
  await db.prepare('INSERT OR IGNORE INTO billing_placement_publications(operation_id,side,repo_id,placement_fence,receipt_json,recorded_at) VALUES (?,?,?,?,?,?)')
    .bind(p.operation_id, side, p.repo_id, p.fence, canonicalJson(receipt), now()).run();
  const saved = await one<{ receipt_json: string }>(db, 'SELECT receipt_json FROM billing_placement_publications WHERE operation_id=? AND side=?', p.operation_id, side);
  invariant(saved?.receipt_json === canonicalJson(receipt), 'placement_publication_conflict', 'The original terminal publication receipt changed.');
  return receipt;
}

export async function placementPublication(env: BillingBindings, p: StoragePlacement, side: 'source' | 'target'): Promise<PlacementPublicationFence | null> {
  const row = await one<{ receipt_json: string }>(placementDb(env), 'SELECT receipt_json FROM billing_placement_publications WHERE operation_id=? AND side=? AND repo_id=? AND placement_fence=?',
    p.operation_id, side, p.repo_id, p.fence);
  return row ? receiptSchema.parse(JSON.parse(row.receipt_json)) : null;
}
