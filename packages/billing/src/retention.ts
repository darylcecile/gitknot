import { many } from '@gitknot/core';
import { billingEnvironment } from './authority.ts';
import { admissionRequest } from './transport.ts';
import type { BillingBindings, StorageDeletionRequest, StorageObject } from './types.ts';
import { invariant } from './errors.ts';

/** Feature owners claim before changing their own associations/manifests/history. No raw feature SQL lives here. */
export function claimStorageDeletion(env: BillingBindings, input: { account_id: string; object_id: string; request_id: string }): Promise<StorageObject> {
  return admissionRequest(env, `account:${input.account_id}`, 'storage-claim-deletion', input);
}

export function releaseStorageDeletionClaim(env: BillingBindings, input: { account_id: string; object_id: string; request_id: string }): Promise<StorageObject> {
  return admissionRequest(env, `account:${input.account_id}`, 'storage-release-deletion', input);
}

export async function storageDeletionRequests(env: BillingBindings, input: { account_id?: string; after?: string; limit?: number } = {}): Promise<{ items: StorageDeletionRequest[]; next_cursor: string | null }> {
  env = billingEnvironment(env);
  const limit = input.limit ?? 100;
  invariant(Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'invalid_page', 'Deletion request pages contain at most 100 entries.', 422);
  const rows = await many<StorageDeletionRequest>(env.DB, `SELECT * FROM billing_storage_deletion_requests WHERE state IN ('pending','claimed','financially_deleted')
    AND (? IS NULL OR account_id=?) AND id>? ORDER BY id LIMIT ?`, input.account_id ?? null, input.account_id ?? null, input.after ?? '', limit + 1);
  return { items: rows.slice(0, limit), next_cursor: rows.length > limit ? rows[limit - 1]!.id : null };
}
