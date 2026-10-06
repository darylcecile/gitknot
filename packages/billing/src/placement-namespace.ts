import { canonicalJson, hex, now, one, sha256, stmt } from '@gitknot/core';
import { z } from 'zod';
import { invariant } from './errors.ts';
import { placementDb, placementStorageName, storagePlacement } from './placement-state.ts';
import type { BillingBindings } from './types.ts';
import type { PlacementGitCreationProof, StoragePlacement } from './placement-types.ts';

export interface PlacementNamespace {
  cell_id: string; storage_name: string; operation_id: string; repo_id: string; account_id: string; placement_fence: string;
  creation_marker: string; creation_receipt_json: string | null;
  state: 'creating' | 'owned' | 'not_started' | 'deleted'; absence_observed_at: string; owned_at: string | null; not_started_at: string | null; deleted_at: string | null;
}

const creationSchema = z.object({ version: z.literal(1), marker: z.string().min(1).max(256), provider_id: z.string().min(1).max(256),
  storage_name: z.string().min(1).max(128), provider: z.enum(['local','artifacts']) }).strict();

export async function placementNamespace(env: BillingBindings, p: StoragePlacement, side: 'source' | 'target'): Promise<PlacementNamespace | null> {
  return one(placementDb(env), 'SELECT * FROM billing_placement_namespaces WHERE cell_id=? AND storage_name=?',
    side === 'source' ? p.source_cell_id : p.target_cell_id, side === 'source' ? p.source_storage_name : p.target_storage_name);
}

function requireOwner(row: PlacementNamespace | null, p: StoragePlacement): asserts row is PlacementNamespace {
  invariant(row && row.operation_id === p.operation_id && row.repo_id === p.repo_id && row.account_id === p.account_id
    && row.placement_fence === p.fence && row.cell_id === p.target_cell_id && row.storage_name === p.target_storage_name,
  'placement_namespace_owner_mismatch', 'This provider namespace is not owned by this immutable placement.');
}

/** The grant follows an actual absent observation. The caller must perform create-only, never adopt-existing. */
export async function beginPlacementGitProvision(env: BillingBindings, operationId: string, storageName: string,
  exists: () => Promise<boolean>): Promise<boolean | null> {
  const db = placementDb(env);
  if (!await one(db, "SELECT 1 FROM sqlite_schema WHERE name='billing_storage_placements'")) return null;
  if (!await one(db, 'SELECT 1 FROM billing_storage_placements WHERE operation_id=?', operationId)) return null;
  const p = await storagePlacement(env, operationId);
  invariant(p.state === 'prepared' && p.target_cell_id === env.CELL_ID && storageName === p.target_storage_name
    && storageName === await placementStorageName(p.repo_id, operationId), 'placement_git_fenced', 'Provisioning requires the exact digest-bound placement namespace.');
  const prior = await placementNamespace(env, p, 'target');
  if (prior) {
    requireOwner(prior, p);
    invariant(prior.state === 'creating' || prior.state === 'owned', 'placement_namespace_fenced', 'A refused or deleted placement namespace cannot be reacquired.');
    return false;
  }
  invariant(typeof exists === 'function' && !await exists(), 'placement_namespace_occupied', 'An existing provider namespace cannot be adopted by this placement.');
  const at = now();
  const marker = `gk-placement-v1:${await sha256(canonicalJson([p.operation_id, p.repo_id, p.account_id, p.target_cell_id,
    storageName, p.fence, hex(crypto.getRandomValues(new Uint8Array(32)))]))}`;
  const results = await db.batch([
    stmt(db, `INSERT OR IGNORE INTO billing_placement_namespaces(cell_id,storage_name,operation_id,repo_id,account_id,placement_fence,creation_marker,state,absence_observed_at)
      SELECT ?,?,operation_id,repo_id,account_id,?,?,'creating',? FROM billing_storage_placements WHERE operation_id=? AND state='prepared'`,
    p.target_cell_id, storageName, p.fence, marker, at, operationId),
    stmt(db, `INSERT OR IGNORE INTO billing_placement_receipts(operation_id,step,receipt_json,created_at)
      SELECT operation_id,'git-provision',?,? FROM billing_placement_namespaces WHERE operation_id=? AND repo_id=? AND placement_fence=? AND state='creating'`,
    JSON.stringify({ storage_name: storageName, repo_id: p.repo_id, placement_fence: p.fence }), at, operationId, p.repo_id, p.fence),
  ]);
  requireOwner(await placementNamespace(env, p, 'target'), p);
  return results[0]!.meta.changes === 1;
}

/** Read the original unpredictable marker; this never grants another provider write. */
export async function placementGitProvisionMarker(env: BillingBindings, operationId: string, storageName: string): Promise<string> {
  const p = await storagePlacement(env, operationId), row = await placementNamespace(env, p, 'target');
  requireOwner(row, p);
  invariant(p.target_cell_id === env.CELL_ID && storageName === row.storage_name && (row.state === 'creating' || row.state === 'owned'),
    'placement_namespace_fenced', 'This namespace creation grant is no longer usable.');
  return row.creation_marker;
}

function creationProof(row: PlacementNamespace, raw: unknown): PlacementGitCreationProof {
  const proof = creationSchema.parse(raw);
  invariant(proof.marker === row.creation_marker && proof.storage_name === row.storage_name,
    'placement_namespace_owner_mismatch', 'Provider creation evidence does not match this operation-bound namespace grant.');
  invariant(!row.creation_receipt_json || row.creation_receipt_json === canonicalJson(proof),
    'placement_namespace_outcome_conflict', 'The original provider creation identity changed.');
  return proof;
}

/** Existence is never ownership. Only actual creation-bound provider evidence can confirm this grant. */
export async function confirmPlacementGitProvision(env: BillingBindings, operationId: string, storageName: string,
  raw: PlacementGitCreationProof): Promise<void> {
  const p = await storagePlacement(env, operationId), row = await placementNamespace(env, p, 'target');
  requireOwner(row, p);
  invariant(p.target_cell_id === env.CELL_ID && storageName === row.storage_name && (row.state === 'creating' || row.state === 'owned'),
    'placement_namespace_unconfirmed', 'The original provider creation has no live exclusive grant.', 503);
  const receipt = canonicalJson(creationProof(row, raw));
  await placementDb(env).prepare(`UPDATE billing_placement_namespaces SET state='owned',owned_at=COALESCE(owned_at,?),creation_receipt_json=COALESCE(creation_receipt_json,?)
    WHERE operation_id=? AND placement_fence=? AND creation_marker=? AND state IN ('creating','owned') AND (creation_receipt_json IS NULL OR creation_receipt_json=?)`)
    .bind(now(), receipt, operationId, p.fence, row.creation_marker, receipt).run();
  // A conclusive create-only refusal may race persistence. Its tombstone wins.
  const confirmed = await ownedPlacementNamespace(env, p);
  invariant(confirmed.creation_receipt_json === receipt, 'placement_namespace_outcome_conflict', 'Another provider creation identity was confirmed concurrently.');
}

/** Called only for a provider's conclusive create-only rejection, never a timeout or missing ACK. */
export async function recordPlacementGitProvisionNotStarted(env: BillingBindings, operationId: string, storageName: string): Promise<void> {
  const p = await storagePlacement(env, operationId), row = await placementNamespace(env, p, 'target');
  requireOwner(row, p);
  invariant(p.target_cell_id === env.CELL_ID && storageName === row.storage_name && (row.state === 'creating' || row.state === 'not_started') && row.owned_at === null,
    'placement_namespace_outcome_conflict', 'A successful or uncertain-owned namespace cannot be reclassified as an unstarted create.');
  await placementDb(env).prepare("UPDATE billing_placement_namespaces SET state='not_started',not_started_at=COALESCE(not_started_at,?) WHERE operation_id=? AND placement_fence=? AND state='creating' AND owned_at IS NULL")
    .bind(now(), operationId, p.fence).run();
  const current = await placementNamespace(env, p, 'target');
  invariant(current?.state === 'not_started', 'placement_namespace_outcome_conflict', 'The original create outcome changed.');
}

export async function ownedPlacementNamespace(env: BillingBindings, p: StoragePlacement): Promise<PlacementNamespace> {
  const row = await placementNamespace(env, p, 'target');
  requireOwner(row, p);
  invariant(row.state === 'owned' && row.owned_at && row.creation_receipt_json, 'placement_namespace_unconfirmed', 'Physical cleanup requires a positive operation-bound creation receipt.', 503);
  creationProof(row, JSON.parse(row.creation_receipt_json));
  return row;
}
