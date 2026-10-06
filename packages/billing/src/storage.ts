import { commitStorageObject } from './execution.ts';
import { admissionRequest } from './transport.ts';
import type { BillingBindings, StandaloneStorageInput, StorageObject, CancelStorageIntentInput, StorageIntentCancellation } from './types.ts';

/** Server-only: authorize attachments.write / accounts.manage / the relevant import or backup operation before calling. */
export function reserveStandaloneStorage(env: BillingBindings, input: StandaloneStorageInput): Promise<StorageObject> {
  return admissionRequest(env, `account:${input.account_id}`, 'standalone-reserve', { ...input, repo_id: input.repo_id ?? null });
}

export function renewStorageCommitment(env: BillingBindings, input: { account_id: string; object_id: string }): Promise<StorageObject> {
  return admissionRequest(env, `account:${input.account_id}`, 'storage-renew', { object_id: input.object_id });
}

/** A primary manifest deleting fence plus an absent physical object proves the unused upload cannot enter R2. */
export function abortStandaloneStorage(env: BillingBindings, input: { account_id: string; object_id: string }): Promise<StorageObject> {
  return admissionRequest(env, `account:${input.account_id}`, 'storage-delete', { object_id: input.object_id });
}

export function cancelStandaloneStorageIntent(env: BillingBindings, input: CancelStorageIntentInput): Promise<StorageIntentCancellation> {
  return admissionRequest(env, `account:${input.account_id}`, 'storage-cancel-intent', input);
}

export const reserveStoredObject = reserveStandaloneStorage;
export const commitStoredObject = commitStorageObject;
