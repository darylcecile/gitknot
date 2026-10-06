import { ApiError, hex, internalFetch, now, verifyInternalRequest } from '@gitknot/core';
import { z } from 'zod';
import { billingCellService } from './storage-policy.ts';
import { invariant } from './errors.ts';
import type { BillingBindings, StorageObject } from './types.ts';

export interface PhysicalHead { size: number; etag: string; uploaded: Date; checksum: string | null }
const physicalSchema = z.object({ action: z.enum(['head', 'delete']), bucket: z.enum(['blobs', 'backups', 'snapshots']),
  key: z.string().min(1).max(1024), object_id: z.string().min(1).max(128), account_id: z.string().min(1).max(128) }).strict();

export function storageBucket(env: BillingBindings, bucket: StorageObject['bucket']): R2Bucket {
  const selected = bucket === 'blobs' ? env.BLOBS : bucket === 'backups' ? env.BACKUPS : env.BACKUP_BUCKET;
  invariant(selected, 'storage_binding_unavailable', 'The physical storage binding is not configured in its recorded cell.', 503);
  return selected;
}

type PhysicalObject = Pick<StorageObject, 'id' | 'account_id' | 'key' | 'bucket' | 'storage_cell_id'>;

async function remotePhysical(env: BillingBindings, object: PhysicalObject, action: 'head' | 'delete'): Promise<Record<string, unknown> | null> {
  const response = await internalFetch(billingCellService(env, object.storage_cell_id!), env.INTERNAL_SERVICE_KEY, 'billing.physical', '/internal/billing/physical', {
    action, bucket: object.bucket, key: object.key, object_id: object.id, account_id: object.account_id,
  });
  invariant(response.ok, 'physical_storage_unavailable', 'The physical storage outcome could not be verified.', 503);
  return response.json() as Promise<Record<string, unknown> | null>;
}

export async function headStorageObject(env: BillingBindings, object: PhysicalObject): Promise<PhysicalHead | null> {
  if (object.storage_cell_id && object.storage_cell_id !== env.CELL_ID) {
    const value = await remotePhysical(env, object, 'head');
    if (!value) return null;
    invariant(typeof value.size === 'number' && Number.isSafeInteger(value.size) && typeof value.etag === 'string' && typeof value.uploaded_at === 'string',
      'physical_storage_invalid', 'Storage returned an invalid metering observation.', 503);
    return { size: value.size, etag: value.etag, uploaded: new Date(value.uploaded_at), checksum: typeof value.checksum === 'string' ? value.checksum : null };
  }
  const head = await storageBucket(env, object.bucket).head(object.key);
  return head ? { size: head.size, etag: head.etag, uploaded: head.uploaded,
    checksum: head.checksums.sha256 ? hex(new Uint8Array(head.checksums.sha256)) : head.customMetadata?.sha256 ?? null } : null;
}

export async function deletePhysicalStorage(env: BillingBindings, object: StorageObject): Promise<string> {
  if (object.storage_cell_id && object.storage_cell_id !== env.CELL_ID) {
    const value = await remotePhysical(env, object, 'delete');
    invariant(value?.deleted === true && typeof value.verified_at === 'string', 'deletion_unverified', 'Physical deletion has not been confirmed.', 503);
    return value.verified_at;
  }
  const bucket = storageBucket(env, object.bucket);
  await bucket.delete(object.key);
  invariant(!await bucket.head(object.key), 'deletion_unverified', 'The object remains present; its quota and financial hold are retained.', 503);
  return now();
}

/** Mount on the cell's private API; the execution Worker can mount it for its SNAPSHOTS binding. */
export async function handleBillingPhysicalRequest(request: Request, env: BillingBindings): Promise<Response> {
  await verifyInternalRequest(request, env.INTERNAL_SERVICE_KEY, 'billing.physical');
  const input = physicalSchema.parse(await request.json());
  const bucket = storageBucket(env, input.bucket);
  if (input.action === 'delete') {
    await bucket.delete(input.key);
    if (await bucket.head(input.key)) throw new ApiError(503, 'deletion_unverified', 'Object deletion is not yet confirmed.');
    return Response.json({ deleted: true, verified_at: now() });
  }
  const object = await bucket.head(input.key);
  return Response.json(object ? { size: object.size, etag: object.etag, uploaded_at: object.uploaded.toISOString(),
    checksum: object.checksums.sha256 ? hex(new Uint8Array(object.checksums.sha256)) : object.customMetadata?.sha256 ?? null } : null);
}
