import { createHash } from 'node:crypto';
import { hex, internalFetch, now, verifyInternalRequest } from '@gitknot/core';
import { z } from 'zod';
import { activeSlice } from './catalog.ts';
import { invariant } from './errors.ts';
import { storageBucket } from './physical-storage.ts';
import { billingCellService } from './storage-policy.ts';
import { localPlacementAuthority, placementCopy, placementDb, saveCopy, storagePlacement } from './placement-state.ts';
import type { BillingBindings } from './types.ts';
import type { PlacementCopy, StoragePlacementInput } from './placement-types.ts';

const identity = z.object({ operation_id: z.string().min(1).max(128), object_id: z.string().min(1).max(128) }).strict();
const checksum = (head: R2Object) => head.checksums.sha256 ? hex(new Uint8Array(head.checksums.sha256)) : head.customMetadata?.sha256;

function verifiedCopy(copy: PlacementCopy, head: R2Object | null): asserts head is R2Object {
  invariant(head && String(head.size) === copy.source.bytes && checksum(head) === copy.source.checksum
    && head.customMetadata?.billing_placement_writer === copy.writer_id, 'placement_copy_unverified', 'Destination checksum, size and immutable writer identity must match.');
}

export async function observePlacementCopy(env: BillingBindings, copy: PlacementCopy): Promise<PlacementCopy> {
  const head = await storageBucket(env, copy.destination.bucket).head(copy.destination.key);
  if (!head) {
    invariant(!['verified','stored','active','cleaned'].includes(copy.state), 'placement_destination_missing', 'A previously verified destination disappeared.', 503);
    return copy;
  }
  verifiedCopy(copy, head);
  if (['verified','stored','active','cleaned'].includes(copy.state)) return copy;
  return saveCopy(env, copy, 'verified', { receipt: { etag: head.etag, uploaded_at: head.uploaded.toISOString(), checksum: copy.source.checksum!, bytes: String(head.size) } });
}

async function copyBytes(env: BillingBindings, copy: PlacementCopy): Promise<PlacementCopy> {
  const p = await storagePlacement(env, copy.operation_id);
  invariant(p.state === 'prepared' && p.target_cell_id === env.CELL_ID, 'placement_copy_fenced', 'This cell has no current physical copy grant.');
  if (copy.state === 'verified' || copy.state === 'active' || copy.state === 'cleaned') return copy;
  if (copy.state === 'writing') {
    const observed = await observePlacementCopy(env, copy);
    invariant(observed.state === 'verified', 'placement_copy_uncertain', 'The original writer has no verified outcome; its hold remains active.', 503);
    return observed;
  }
  invariant(copy.state === 'reserved', 'placement_copy_fenced', 'This copy generation is not available for writing.');
  const existing = await storageBucket(env, copy.destination.bucket).head(copy.destination.key);
  invariant(!existing, 'placement_destination_occupied', 'A physical destination key already exists outside this copy generation.');
  const claimed = await saveCopy(env, copy, 'writing');
  if (claimed.state !== 'writing') return claimed;
  // Only the successful CAS may issue a PUT; a replay must observe that PUT's original outcome.
  const claim = await placementDb(env).prepare('INSERT OR IGNORE INTO billing_placement_receipts(operation_id,step,receipt_json,created_at) VALUES (?,?,?,?)')
    .bind(copy.operation_id, `writer:${copy.object_id}`, JSON.stringify({ writer_id: copy.writer_id }), now()).run();
  invariant(claim.meta.changes === 1, 'placement_copy_uncertain', 'The original copy writer must be reconciled.', 503);
  let source: Response;
  try {
    source = await internalFetch(billingCellService(env, copy.source.storage_cell_id!), env.INTERNAL_SERVICE_KEY, 'billing.placement', '/internal/billing/placement/source',
      { operation_id: copy.operation_id, object_id: copy.object_id });
    invariant(source.ok && source.body, 'placement_source_unavailable', 'The declared physical source could not be read.', 503);
  } catch (error) { await saveCopy(env, claimed, 'failed'); throw error; }
  const metadata = JSON.parse(source.headers.get('x-gitknot-object-metadata') ?? '{}') as Record<string, string>;
  const httpMetadata = JSON.parse(source.headers.get('x-gitknot-http-metadata') ?? '{}') as R2HTTPMetadata;
  if (httpMetadata.cacheExpiry) httpMetadata.cacheExpiry = new Date(httpMetadata.cacheExpiry);
  const digest = createHash('sha256'); let received = 0, ended = false;
  const reader = source.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) { received += chunk.length; invariant(BigInt(received) <= BigInt(copy.source.bytes), 'placement_copy_size', 'Copy exceeded its byte reservation.'); digest.update(chunk); controller.enqueue(chunk); },
    flush() { ended = true; invariant(String(received) === copy.source.bytes, 'placement_copy_size', 'Copy ended before its declared length.'); },
  }));
  const length = Number(copy.source.bytes);
  invariant(Number.isSafeInteger(length) && length >= 0, 'placement_copy_size', 'The declared copy length cannot be represented by R2.');
  const body = typeof FixedLengthStream === 'undefined' ? reader : reader.pipeThrough(new FixedLengthStream(length));
  try {
    await storageBucket(env, copy.destination.bucket).put(copy.destination.key, body, { onlyIf: { etagDoesNotMatch: '*' }, sha256: copy.source.checksum!,
      customMetadata: { ...metadata, sha256: copy.source.checksum!, billing_placement_writer: copy.writer_id },
      httpMetadata });
    return observePlacementCopy(env, claimed);
  } catch (error) {
    // A complete invalid input cannot become a valid atomic R2 object. Other failures remain uncertain.
    if (ended && (String(received) !== copy.source.bytes || digest.digest('hex') !== copy.source.checksum)) await saveCopy(env, claimed, 'failed');
    throw error;
  }
}

export async function handleStoragePlacementRequest(request: Request, env: BillingBindings): Promise<Response> {
  await verifyInternalRequest(request, env.INTERNAL_SERVICE_KEY, 'billing.placement');
  const action = new URL(request.url).pathname.split('/').at(-1);
  const raw = await request.json();
  if (action === 'configuration') {
    const slice = typeof env.BILLING_PLATFORM_SLICE_ID === 'string' ? await activeSlice(env, env.BILLING_PLATFORM_SLICE_ID) : null;
    const git = typeof (env.BILLING_GIT_STORAGE_SLICE_ID ?? env.BILLING_PLATFORM_SLICE_ID) === 'string'
      ? await activeSlice(env, (env.BILLING_GIT_STORAGE_SLICE_ID ?? env.BILLING_PLATFORM_SLICE_ID)!) : null;
    invariant(slice?.cell_id === env.CELL_ID && git?.cell_id === env.CELL_ID && slice.purpose === 'discretionary' && git.purpose === 'discretionary',
      'placement_capacity_missing', 'The destination needs its explicitly funded physical storage slices.', 503);
    return Response.json({ cell_id: env.CELL_ID, slice_id: slice.id, git_slice_id: git.id });
  }
  if (action === 'authority') return Response.json(await localPlacementAuthority(env, raw as StoragePlacementInput));
  const input = identity.parse(raw), p = await storagePlacement(env, input.operation_id), copy = await placementCopy(env, input.operation_id, input.object_id);
  if (action === 'source') {
    invariant(['prepared','committing'].includes(p.state) && env.CELL_ID === copy.source.storage_cell_id && copy.state === 'writing', 'placement_source_fenced', 'The source read is outside its exact handoff.');
    const object = await storageBucket(env, copy.source.bucket).get(copy.source.key, { onlyIf: { etagMatches: copy.source.etag! } });
    invariant(object && 'body' in object && String(object.size) === copy.source.bytes, 'placement_source_changed', 'The frozen physical source changed.');
    return new Response(object.body, { headers: { 'content-length': String(object.size), 'x-gitknot-object-metadata': JSON.stringify(object.customMetadata ?? {}), 'x-gitknot-http-metadata': JSON.stringify(object.httpMetadata ?? {}) } });
  }
  if (action === 'copy' || action === 'observe') {
    invariant(env.CELL_ID === p.target_cell_id && !['aborted','complete'].includes(p.state), 'placement_cell_changed', 'This request belongs to the declared destination.');
    return Response.json(action === 'copy' ? await copyBytes(env, copy) : await observePlacementCopy(env, copy));
  }
  if (action === 'cleanup') {
    const source = p.state === 'active';
    invariant(source || p.state === 'aborting', 'placement_cleanup_fenced', 'Physical cleanup has no committed or aborted handoff decision.');
    const physical = source ? copy.source : copy.destination;
    invariant(env.CELL_ID === physical.storage_cell_id, 'placement_cell_changed', 'Cleanup must use the recorded physical cell.');
    if (copy.deleted_at) return Response.json(copy);
    const bucket = storageBucket(env, physical.bucket), head = await bucket.head(physical.key);
    if (!source) invariant(copy.state !== 'writing', 'placement_copy_uncertain', 'An uncertain destination writer retains its hold.', 503);
    if (head) {
      if (source) invariant(String(head.size) === copy.source.bytes && head.etag === copy.source.etag, 'placement_source_changed', 'The retained source differs from its original receipt.');
      else verifiedCopy(copy, head);
      await bucket.delete(physical.key);
    }
    invariant(!await bucket.head(physical.key), 'placement_cleanup_unconfirmed', 'The original physical copy is still retained.', 503);
    return Response.json(await saveCopy(env, copy, copy.state, { deleted_at: now() }));
  }
  throw new Error('Unknown physical placement operation');
}
