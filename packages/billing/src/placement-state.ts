import { canonicalJson, cellDatabase, identityBinding, internalFetch, many, one, readBounded, resolveRoute, sha256, now } from '@gitknot/core';
import { z } from 'zod';
import { billingCellService } from './storage-policy.ts';
import { invariant } from './errors.ts';
import type { BillingBindings } from './types.ts';
import type { PlacementCopy, StoragePlacement, StoragePlacementInput } from './placement-types.ts';

export const placementDb = (env: BillingBindings) => identityBinding(env).withSession('first-primary');

export async function storagePlacement(env: BillingBindings, id: string): Promise<StoragePlacement> {
  const row = await one<{ body_json: string }>(placementDb(env), 'SELECT body_json FROM billing_storage_placements WHERE operation_id=?', id);
  invariant(row, 'placement_not_found', 'The physical placement intent is unavailable.', 404);
  return JSON.parse(row.body_json) as StoragePlacement;
}
export async function placementCopy(env: BillingBindings, operationId: string, id: string): Promise<PlacementCopy> {
  const row = await one<{ body_json: string }>(placementDb(env), 'SELECT body_json FROM billing_placement_copies WHERE operation_id=? AND object_id=?', operationId, id);
  invariant(row, 'placement_copy_missing', 'The object is not declared by this physical handoff.', 404);
  return JSON.parse(row.body_json) as PlacementCopy;
}
export async function savePlacement(env: BillingBindings, p: StoragePlacement, state: StoragePlacement['state'], effectiveAt = p.effective_at): Promise<StoragePlacement> {
  const next = { ...p, state, effective_at: effectiveAt, revision: p.revision + 1 };
  const result = await placementDb(env).prepare('UPDATE billing_storage_placements SET state=?,body_json=?,revision=? WHERE operation_id=? AND revision=?')
    .bind(state, JSON.stringify(next), next.revision, p.operation_id, p.revision).run();
  if (result.meta.changes !== 1) {
    const current = await storagePlacement(env, p.operation_id);
    invariant(current.state === state && current.effective_at === effectiveAt, 'placement_changed', 'The physical handoff advanced concurrently.');
    return current;
  }
  return next;
}
export async function saveCopy(env: BillingBindings, copy: PlacementCopy, state: PlacementCopy['state'], extra: Partial<PlacementCopy> = {}): Promise<PlacementCopy> {
  const next = { ...copy, ...extra, state };
  const result = await placementDb(env).prepare('UPDATE billing_placement_copies SET state=?,body_json=? WHERE operation_id=? AND object_id=? AND state=?')
    .bind(state, JSON.stringify(next), copy.operation_id, copy.object_id, copy.state).run();
  if (result.meta.changes !== 1) return placementCopy(env, copy.operation_id, copy.object_id);
  return next;
}
export async function placementReceipt(env: BillingBindings, operationId: string, step: string, value: unknown): Promise<void> {
  await placementDb(env).prepare('INSERT OR IGNORE INTO billing_placement_receipts(operation_id,step,receipt_json,created_at) VALUES (?,?,?,?)')
    .bind(operationId, step, canonicalJson(value), now()).run();
}

export async function placementParticipants(env: BillingBindings, p: StoragePlacement): Promise<string[]> {
  const targets = new Set<string>([`account:${p.account_id}`]);
  for (const slice of [p.target_slice_id, p.target_git_slice_id]) if (slice) targets.add(`capacity:${slice}`);
  const copies = await many<{ source: string | null; target: string | null }>(placementDb(env), `SELECT DISTINCT
    json_extract(body_json,'$.source.slice_id') AS source,json_extract(body_json,'$.destination.slice_id') AS target
    FROM billing_placement_copies WHERE operation_id=?`, p.operation_id);
  for (const copy of copies) for (const slice of [copy.source, copy.target]) if (slice) targets.add(`capacity:${slice}`);
  const git = await one<{ source: string | null; target: string | null }>(placementDb(env), `SELECT
    json_extract(body_json,'$.source.slice_id') AS source,json_extract(body_json,'$.slice_id') AS target FROM billing_placement_git WHERE operation_id=?`, p.operation_id);
  for (const slice of [git?.source, git?.target]) if (slice) targets.add(`capacity:${slice}`);
  return [...targets];
}

export async function assertPlacementRoute(env: BillingBindings, p: StoragePlacementInput, afterCutover = false): Promise<void> {
  const route = await resolveRoute(env, p.repo_id);
  const before = route?.cell_id === p.source_cell_id && route.shard_id === p.source_shard_id && route.epoch === p.source_epoch
    && route.state === 'fenced' && route.operation_id === p.operation_id && route.destination_cell_id === p.target_cell_id && route.destination_shard_id === p.target_shard_id;
  const after = route?.cell_id === p.target_cell_id && route.shard_id === p.target_shard_id && route.epoch === p.source_epoch + 1 && route.state === 'active';
  invariant(afterCutover ? after : before, 'placement_epoch_changed', 'The physical handoff does not own this directory epoch.');
}

/** Preserve all operation/repository bytes, including case, in the provider namespace. */
export async function placementStorageName(repoId: string, operationId: string): Promise<string> {
  return `gk_restore_${await sha256(canonicalJson(['gitknot.storage-placement.v1', repoId, operationId]))}`;
}

export function replacesPlacementGit(p: StoragePlacement): boolean {
  return p.source_cell_id !== p.target_cell_id || p.purpose === 'archive_restore';
}

export interface PlacementAuthority { account_id: string; actor_id: string; storage_name: string; metadata_fence: string;
  purpose: 'move' | 'archive_restore'; archive_id: string | null; archive_manifest_sha256: string | null;
  archive_refs: Array<{ ref: string; oid: string }> | null; archive_git_bytes: string | null }

const archiveSchema = z.object({ archive_id: z.string(), repository: z.object({ id: z.string() }),
  git: z.object({ bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    refs: z.array(z.object({ ref: z.string().min(1).max(1024), oid: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/) })).max(65536) }) });

export async function localPlacementAuthority(env: BillingBindings, input: StoragePlacementInput): Promise<PlacementAuthority> {
  invariant(env.CELL_ID === input.source_cell_id, 'placement_cell_changed', 'This is not the declared source cell.');
  await assertPlacementRoute(env, input);
  const db = cellDatabase(env, input.source_shard_id).withSession('first-primary');
  const row = await one<{ account_id: string; actor_id: string; storage_name: string; metadata_fence: string; input_json: string; request_sha256: string }>(db,
    `SELECT r.owner_id AS account_id,o.actor_id,r.storage_name,f.fence_id AS metadata_fence,o.input_json,m.request_sha256
    FROM repositories r JOIN operations o ON o.repo_id=r.id AND o.id=? AND o.kind='repository.move'
    JOIN repository_move_requests m ON m.operation_id=o.id AND m.repo_id=r.id
    JOIN repository_metadata_fences f ON f.repo_id=r.id AND f.operation_id=o.id AND f.state='held'
    WHERE r.id=? AND r.owner_id=o.account_id AND r.cell_id=? AND r.shard_id=? AND r.routing_epoch=? AND r.state='moving'
      AND m.source_cell_id=? AND m.source_shard_id=? AND m.expected_epoch=? AND m.target_cell_id=? AND m.target_shard_id=?
      AND o.status NOT IN ('cancelled','completed')`, input.operation_id, input.repo_id, input.source_cell_id, input.source_shard_id, input.source_epoch,
    input.source_cell_id, input.source_shard_id, input.source_epoch, input.target_cell_id, input.target_shard_id);
  invariant(row, 'placement_authority_unconfirmed', 'The immutable move request and source metadata fence must agree.');
  const declared = JSON.parse(row.input_json) as { archive_id?: string };
  const requestHash = await sha256(canonicalJson({ repo_id: input.repo_id, target_cell_id: input.target_cell_id, target_shard_id: input.target_shard_id,
    expected_epoch: input.source_epoch, archive_id: declared.archive_id ?? null, actor_id: row.actor_id }));
  invariant(requestHash === row.request_sha256, 'placement_request_changed', 'The immutable move request no longer matches its declared purpose.');
  const result: PlacementAuthority = { account_id: row.account_id, actor_id: row.actor_id, storage_name: row.storage_name, metadata_fence: row.metadata_fence,
    purpose: declared.archive_id ? 'archive_restore' : 'move', archive_id: declared.archive_id ?? null, archive_manifest_sha256: null, archive_refs: null, archive_git_bytes: null };
  if (!declared.archive_id) return result;
  const archive = await one<{ manifest_key: string; manifest_sha256: string }>(db,
    "SELECT manifest_key,manifest_sha256 FROM repository_archives WHERE id=? AND repo_id=? AND state='verified' AND expires_at>?", declared.archive_id, input.repo_id, now());
  invariant(archive, 'placement_archive_unavailable', 'Archive recovery requires its immutable verified archive.');
  const stored = await env.BACKUPS.get(archive.manifest_key);
  invariant(stored && stored.size <= 8 * 1024 * 1024, 'placement_archive_unavailable', 'The declared archive manifest is unavailable.');
  const bytes = await readBounded(stored.body, 8 * 1024 * 1024);
  invariant(await sha256(bytes) === archive.manifest_sha256, 'placement_archive_changed', 'The declared archive manifest checksum changed.');
  const manifest = archiveSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  invariant(manifest.archive_id === declared.archive_id && manifest.repository.id === input.repo_id, 'placement_archive_scope', 'The archive does not belong to this recovery.');
  return { ...result, archive_manifest_sha256: archive.manifest_sha256, archive_refs: manifest.git.refs, archive_git_bytes: String(manifest.git.bytes) };
}

export async function placementRpc<T>(env: BillingBindings, cell: string, action: string, input: unknown): Promise<T> {
  const response = await internalFetch(billingCellService(env, cell), env.INTERNAL_SERVICE_KEY, 'billing.placement', `/internal/billing/placement/${action}`, input);
  const body = await response.json() as T & { error?: { code?: string; message?: string } };
  invariant(response.ok, body.error?.code ?? 'placement_unconfirmed', body.error?.message ?? 'The physical placement participant did not confirm its outcome.', 503);
  return body;
}
export async function placementIdentity(input: StoragePlacementInput): Promise<{ request_hash: string; fence: string }> {
  const hash = await sha256(canonicalJson(input));
  return { request_hash: hash, fence: `pf_${await sha256(`${input.operation_id}:${hash}`)}` };
}
