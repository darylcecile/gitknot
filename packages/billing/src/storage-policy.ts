import { cellDatabase, internalFetch, limits, now, one, resolveRepositoryPlacement, resolveResourceLocator, resolveRoute, readRepositoryAuthority, identityBinding, sha256, canonicalJson } from '@gitknot/core';
import { Context } from 'hono';
import type { AppEnv } from '@gitknot/core';
import type { Database, Repository, RepositoryPlacement } from '@gitknot/core';
import { z } from 'zod';
import { activeSlice, currentRate, ensureBillingAccount, getPlan } from './catalog.ts';
import { invariant } from './errors.ts';
import { storagePolicy } from './configuration.ts';
export { storagePolicy } from './configuration.ts';
import { maximumCharge, units } from './money.ts';
import { billingEnvironment } from './authority.ts';
import type { BillingBindings, StandaloneStorageInput, StandaloneStorageTerms, StorageObject, StorageRenewalPolicy } from './types.ts';
import type { GitPublicationAuthority, GitPurgeAuthority } from './git-types.ts';

export const standaloneStorageSchema = z.object({
  account_id: z.string().min(1).max(128), repo_id: z.string().min(1).max(128).nullable().optional(), actor_id: z.string().min(1).max(128),
  object_id: z.string().min(1).max(128), key: z.string().min(1).max(1024), bucket: z.enum(['blobs', 'backups', 'snapshots']),
  maximum_bytes: z.string().regex(/^(0|[1-9][0-9]{0,62})$/), retention_until: z.iso.datetime().nullable(),
}).strict();
export function storageFundingWindow(at: string, retention: string | null, policy: StorageRenewalPolicy): {
  funded_until: string; commitment_until: string; renew_after: string | null;
} {
  const end = Math.min(Date.parse(at) + policy.commitment_seconds * 1000, retention ? Date.parse(retention) : Infinity);
  const renewable = retention === null || end < Date.parse(retention);
  return { funded_until: new Date(end).toISOString(), commitment_until: new Date(end + policy.deletion_grace_seconds * 1000).toISOString(),
    renew_after: renewable ? new Date(end - policy.renew_before_seconds * 1000).toISOString() : null };
}

export function billingCellService(env: BillingBindings, cellId: string): Fetcher {
  let cells: Record<string, string>;
  try { cells = JSON.parse(String(env.CELL_BINDINGS_JSON ?? '{}')) as Record<string, string>; }
  catch { throw new Error('billing_repository_routing_unavailable'); }
  const binding = cells[cellId];
  invariant(typeof binding === 'string' && /^[A-Z][A-Z0-9_]+$/.test(binding), 'billing_repository_unavailable', 'The storage cell authority is not bound in this cell.', 503);
  const service = env[binding] as Fetcher | undefined;
  invariant(service?.fetch, 'billing_repository_unavailable', 'The storage cell authority is not available.', 503);
  return service;
}

export async function repositoryLocation(env: BillingBindings, repoId: string | null, gitOperationId?: string): Promise<{ db: Database; placement?: RepositoryPlacement } | { service: Fetcher; placement: RepositoryPlacement }> {
  if (!repoId) return { db: identityBinding(env).withSession('first-primary') };
  const staged = gitOperationId ? await resolveRoute(env, repoId) : null;
  const route = staged?.state === 'fenced' && staged.operation_id === gitOperationId && staged.destination_cell_id && staged.destination_shard_id
    ? { repo_id: repoId, cell_id: staged.destination_cell_id, shard_id: staged.destination_shard_id, epoch: staged.epoch + 1, state: 'fenced' as const, operation_id: gitOperationId }
    : await resolveRepositoryPlacement(env, repoId);
  invariant(route, 'repository_authority_missing', 'The current repository placement could not be verified.', 503);
  if (route.cell_id === env.CELL_ID) return { db: cellDatabase(env, route.shard_id).withSession('first-primary'), placement: route };
  return { service: billingCellService(env, route.cell_id), placement: route };
}

export interface BillingManifest {
  id: string; account_id: string; repo_id: string | null; object_key: string; state: string; revision: number;
  billing_reservation_id: string | null; billing_fence: string | null; upload_generation: number; upload_failure: string | null;
  upload_bytes_received: number; bytes: number; sha256: string; reference_count: number;
  storage_accrued_at: string | null;
  bucket: StorageObject['bucket']; created_by: string; requested_retention_until: string | null;
}

export interface StorageTransferAuthority {
  id: string; repo_id: string; operation_id: string; source_owner_id: string; destination_owner_id: string;
  state: string; accepted_by: string | null; accepted_at: string | null; expires_at: string; revision: number;
}
export interface BillingWorkflowAuthority { id: string; repo_id: string; account_id: string }

/** Reads repo/manifest metadata at its primary, while financial counters remain in the one account object. */
export async function billingMetadata<T extends Repository | BillingManifest | StorageTransferAuthority | BillingWorkflowAuthority | GitPublicationAuthority | GitPurgeAuthority>(env: BillingBindings, input: {
  repo_id: string | null; object_id?: string; account_id?: string; transfer_operation_id?: string; workflow_id?: string; git_operation_id?: string; git_repository_operation_id?: string; git_purge_storage_name?: string;
}): Promise<T | null> {
  if (!input.object_id && !input.transfer_operation_id && !input.workflow_id && !input.git_operation_id && !input.git_repository_operation_id && !input.git_purge_storage_name && input.repo_id) {
    const c = new Context<AppEnv>(new Request('https://internal.gitknot.com/billing-authority'), { env });
    return readRepositoryAuthority(c, input.repo_id) as Promise<T | null>;
  }
  if (input.object_id) {
    const locator = await resolveResourceLocator(env, input.object_id, 'object');
    invariant(locator && locator.repo_id === input.repo_id, 'storage_locator_changed', 'The object must be read at its current immutable repository locator.', 409);
  }
  const location = await repositoryLocation(env, input.repo_id, input.git_operation_id ?? input.git_repository_operation_id);
  if ('service' in location) {
    const response = await internalFetch(location.service, env.INTERNAL_SERVICE_KEY, 'billing.metadata', '/internal/billing/metadata', input);
    invariant(response.ok, 'billing_repository_unavailable', 'Authoritative storage metadata could not be verified.', 503);
    return response.json() as Promise<T | null>;
  }
  if (input.git_repository_operation_id || input.git_operation_id) {
    const repo = await one<Repository>(location.db, 'SELECT * FROM repositories WHERE id=?', input.repo_id);
    invariant(repo && location.placement && repo.cell_id === location.placement.cell_id && repo.shard_id === location.placement.shard_id
      && repo.routing_epoch === location.placement.epoch, 'git_metadata_placement_changed', 'Canonical publication metadata is outside its current or explicitly staged placement.');
    if (input.git_repository_operation_id) return repo as T;
  }
  if (input.transfer_operation_id) return one<T>(location.db, 'SELECT * FROM repository_transfers WHERE repo_id=? AND operation_id=?', input.repo_id, input.transfer_operation_id);
  if (input.workflow_id) return one<T>(location.db, 'SELECT id,repo_id,account_id FROM workflows WHERE id=? AND repo_id=?', input.workflow_id, input.repo_id);
  if (input.git_operation_id) return one<T>(location.db, 'SELECT * FROM git_publications WHERE repo_id=? AND id=?', input.repo_id, input.git_operation_id);
  if (input.git_purge_storage_name) return one<T>(location.db, `SELECT o.id AS operation_id,o.repo_id,o.account_id,
    json_extract(f.receipt_json,'$.repository.storage_name') AS storage_name,p.completed_at AS confirmed_at,p.receipt_json
    FROM operations o JOIN operation_steps p ON p.operation_id=o.id AND p.name='purge-storage' AND p.state='completed'
    JOIN operation_steps f ON f.operation_id=o.id AND f.name='fence-writes' AND f.state='completed'
    WHERE o.repo_id=? AND o.kind='repository.purge' AND json_extract(f.receipt_json,'$.repository.storage_name')=?
      AND json_extract(p.receipt_json,'$.deleted')=1 AND json_extract(p.receipt_json,'$.storage_verified')=1
    ORDER BY p.completed_at LIMIT 1`, input.repo_id, input.git_purge_storage_name);
  if (input.object_id) return one<T>(location.db, `SELECT id,account_id,repo_id,object_key,state,revision,billing_reservation_id,billing_fence,
    upload_generation,upload_failure,upload_bytes_received,bytes,sha256,reference_count,storage_accrued_at,bucket,created_by,requested_retention_until FROM object_manifests WHERE id=? AND account_id=?`, input.object_id, input.account_id);
  return one<T>(location.db, 'SELECT * FROM repositories WHERE id=?', input.repo_id);
}

export async function quoteStandaloneStorage(env: BillingBindings, raw: StandaloneStorageInput, acceptedTransfer?: { operation_id: string; source: StorageObject }): Promise<StandaloneStorageTerms> {
  env = billingEnvironment(env);
  const input = standaloneStorageSchema.parse({ ...raw, repo_id: raw.repo_id ?? null });
  invariant((input.key.startsWith(`${input.account_id}/${input.repo_id ?? 'assets'}/`) || (acceptedTransfer?.source.key === input.key
    && acceptedTransfer.source.attribution.repo_id === input.repo_id)) && !/[\u0000-\u001f\u007f]/.test(input.key),
    'storage_key_scope', 'Storage keys must use the account/repository or account/assets namespace.', 422);
  const account = await ensureBillingAccount(env, input.account_id);
  invariant(account.state === 'active', 'subscription_inactive', 'The billing account does not permit new storage commitments.');
  const plan = await getPlan(env.DB, account.plan_id);
  invariant(units(input.maximum_bytes) <= units(plan.max_storage_bytes), 'storage_quota', 'The object exceeds this plan storage entitlement.', 422);
  const actor = await one(env.DB, 'SELECT id FROM principals WHERE id=? AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at>?)', input.actor_id, now());
  invariant(actor, 'actor_unavailable', 'Storage attribution requires a current actor.', 403);
  let storageCell = env.CELL_ID;
  if (input.repo_id) {
    const repo = await billingMetadata<Repository>(env, { repo_id: input.repo_id });
    // Billing admission grants no content access. Authorized deletion/restore
    // workflows still need bounded backups while the catalog is tombstoned.
    invariant(repo && (repo.owner_id === input.account_id || repo.owner_id === acceptedTransfer?.source.account_id), 'billing_owner_changed', 'The repository owner must be current before reserving storage.');
    storageCell = acceptedTransfer?.source.storage_cell_id ?? repo.cell_id;
  }
  const config = storagePolicy(env);
  const at = now();
  invariant(input.retention_until === null || (Date.parse(input.retention_until) > Date.parse(at)
    && Date.parse(input.retention_until) - Date.parse(at) <= config.maximum_retention_seconds * 1000),
  'retention_limit', 'The requested retention exceeds the configured public retention limit.', 422);
  let sliceId = env.BILLING_PLATFORM_SLICE_ID;
  if (storageCell !== env.CELL_ID) {
    const response = await internalFetch(billingCellService(env, storageCell), env.INTERNAL_SERVICE_KEY, 'billing.placement', '/internal/billing/placement/configuration', {});
    invariant(response.ok, 'capacity_unconfigured', 'The physical storage cell could not confirm its operating allocation.', 503);
    const configured = await response.json() as { cell_id: string; slice_id: string };
    invariant(configured.cell_id === storageCell, 'capacity_cell', 'The physical storage allocation belongs to another cell.', 503);
    sliceId = configured.slice_id;
  }
  invariant(typeof sliceId === 'string', 'capacity_unconfigured', 'Retained storage requires an allocated operating-cost slice.', 503);
  const slice = await activeSlice(env, sliceId);
  invariant(slice.cell_id === storageCell, 'capacity_cell', 'The retained-storage allocation is not assigned to its physical cell.', 503);
  invariant(slice.purpose === 'discretionary', 'capacity_purpose', 'Retained uploads require a discretionary storage allocation.', 503);
  const rate = await currentRate(env.DB, 'storage.blobs');
  const policy: StorageRenewalPolicy = { commitment_seconds: config.commitment_seconds, renew_before_seconds: config.renew_before_seconds,
    deletion_grace_seconds: config.deletion_grace_seconds, on_renewal_failure: 'notify_block_writes_then_delete' };
  const window = storageFundingWindow(at, input.retention_until, policy);
  const quantity = (units(input.maximum_bytes) * BigInt(Date.parse(window.commitment_until) - Date.parse(at))).toString();
  const hash = await sha256(canonicalJson(acceptedTransfer ? { input, operation_id: acceptedTransfer.operation_id, source_fence: acceptedTransfer.source.fence } : input));
  const id = `sres_${(await sha256(`${input.account_id}:${input.object_id}${acceptedTransfer ? `:${acceptedTransfer.operation_id}` : ''}`)).slice(0, 48)}`;
  return { input, reservation_id: id, request_hash: hash, fence: `sf_${await sha256(`${id}:${hash}`)}`, slice_id: sliceId, rate,
    attribution: { account_id: input.account_id, repo_id: input.repo_id ?? null, actor_id: input.actor_id, workflow_id: null, team_id: null, run_id: null, attempt_id: null, generation: null },
    repository_limit_bytes: input.repo_id ? String(limits(env).repository_storage_bytes) : null,
    storage_cell_id: acceptedTransfer?.source.storage_cell_id ?? storageCell,
    maximum_units: maximumCharge(quantity, rate), maximum_platform_units: maximumCharge(quantity, rate, true),
    ...window, renewal_policy: policy, created_at: at };
}

export function standaloneTerms(object: StorageObject): StandaloneStorageTerms {
  invariant(object.source === 'standalone' && object.slice_id && object.request_hash && object.renewal_policy && object.funded_until,
    'storage_state_unavailable', 'The standalone storage admission journal is incomplete.', 503);
  const quantity = (units(object.maximum_bytes) * BigInt(Date.parse(object.commitment_until) - Date.parse(object.created_at))).toString();
  return { input: { account_id: object.account_id, repo_id: object.attribution.repo_id, actor_id: object.attribution.actor_id, object_id: object.id,
    key: object.key, bucket: object.bucket, maximum_bytes: object.maximum_bytes, retention_until: object.retention_until },
    reservation_id: object.reservation_id, fence: object.fence, request_hash: object.request_hash, slice_id: object.slice_id, rate: object.rate,
    storage_cell_id: object.storage_cell_id!,
    attribution: object.attribution, repository_limit_bytes: object.repository_limit_bytes ?? null,
    maximum_units: maximumCharge(quantity, object.rate), maximum_platform_units: maximumCharge(quantity, object.rate, true),
    funded_until: object.funded_until, commitment_until: object.commitment_until, renew_after: object.renew_after ?? null,
    renewal_policy: object.renewal_policy, created_at: object.created_at };
}
