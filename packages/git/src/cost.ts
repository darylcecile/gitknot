import type { Bindings } from '@gitknot/core';
import type { CanonicalGitAbort, CanonicalGitStorageInput, EssentialServiceIdentity, EssentialServiceInput } from '@gitknot/billing';
import { GitError } from './errors.ts';

export interface GitCostReservation { reservation_id: string; fence: string; maximum_duration_ms?: number }
export type EssentialGitReservationInput = EssentialServiceInput;
export type EssentialGitIdentity = EssentialServiceIdentity;
export type CanonicalGitReservationInput = CanonicalGitStorageInput;
export type CanonicalGitIdentity = Omit<CanonicalGitAbort, 'rejection_evidence_id'>;

/** The actual billing adapter is mandatory; absent capabilities never become successful admission. */
type GitCostAdapter = Pick<typeof import('@gitknot/billing'), 'reserveEssentialService' | 'startEssentialService' | 'settleEssentialService'
  | 'reserveCanonicalGitStorage' | 'commitCanonicalGitStorage' | 'abortCanonicalGitStorage'>;

async function adapter<K extends keyof GitCostAdapter>(name: K): Promise<GitCostAdapter[K]> {
  const billing = await import('@gitknot/billing');
  const method = billing[name];
  if (typeof method !== 'function') throw new GitError('git_cost_admission_unavailable', 'Git operating-cost admission is not configured.', 503);
  return method as GitCostAdapter[K];
}

export const gitCosts = {
  async reserveHelper(env: Bindings, input: EssentialGitReservationInput) { return (await adapter('reserveEssentialService'))(env, input); },
  async startHelper(env: Bindings, input: EssentialGitIdentity) { return (await adapter('startEssentialService'))(env, input); },
  async settleHelper(env: Bindings, input: Parameters<GitCostAdapter['settleEssentialService']>[1]) { return (await adapter('settleEssentialService'))(env, input); },
  async reserveStorage(env: Bindings, input: CanonicalGitReservationInput) { return (await adapter('reserveCanonicalGitStorage'))(env, input); },
  async commitStorage(env: Bindings, input: Parameters<GitCostAdapter['commitCanonicalGitStorage']>[1]) { return (await adapter('commitCanonicalGitStorage'))(env, input); },
  async abortStorage(env: Bindings, input: Parameters<GitCostAdapter['abortCanonicalGitStorage']>[1]) { return (await adapter('abortCanonicalGitStorage'))(env, input); },
};
