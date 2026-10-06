import { canonicalJson, limits, many, now, one, sha256 } from '@gitknot/core';
import type { Repository } from '@gitknot/core';
import { z } from 'zod';
import { billingEnvironment } from './authority.ts';
import { activeSlice, ensureBillingAccount, currentRate } from './catalog.ts';
import { storagePolicy, storageFundingWindow, billingMetadata } from './storage-policy.ts';
import { invariant } from './errors.ts';
import { maximumCharge, units } from './money.ts';
import type { Rate } from './money.ts';
import { admissionRequest } from './transport.ts';
import type { BillingBindings } from './types.ts';
import type { PlacementGitHold } from './placement-types.ts';
import { placementStorageName } from './placement-state.ts';
import type { CanonicalGitAbort, CanonicalGitCommit, CanonicalGitMeter, CanonicalGitQuote, CanonicalGitReservation, CanonicalGitStorageInput,
  EssentialServiceIdentity, EssentialServiceInput, EssentialServiceSettlement, GitPublicationAuthority, GitPurgeAuthority, HelperQuote, HelperReservation } from './git-types.ts';

const id = z.string().min(1).max(256);
const quantity = z.string().regex(/^(0|[1-9][0-9]{0,62})$/);
export const essentialInputSchema = z.object({ service: z.literal('git-helper'), allocation_id: id, profile: id,
  maximum_duration_ms: z.number().int().positive().max(3_600_000), maximum_egress_bytes: quantity }).strict();
export const essentialIdentitySchema = z.object({ service: z.literal('git-helper'), allocation_id: id, reservation_id: id, fence: id }).strict();
export const essentialSettlementSchema = essentialIdentitySchema.extend({ event_id: id, duration_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), egress_bytes: quantity,
  termination_proof: z.object({ kind: z.enum(['container_destroyed', 'never_allocated']), receipt_id: id, verified_at: z.iso.datetime() }).strict() });
export const canonicalInputSchema = z.object({ account_id: id, repo_id: id, actor_id: id, operation_id: id, storage_name: id,
  routing_epoch: z.number().int().positive(), maximum_growth_bytes: quantity, retention_until: z.null() }).strict();
export const canonicalCommitSchema = z.object({ account_id: id, repo_id: id, operation_id: id, reservation_id: id, fence: id,
  reachable_bytes: quantity, new_object_bytes: quantity, object_count: quantity, evidence_digest: z.string().regex(/^[a-f0-9]{64}$/),
  marker_oid: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/), verified_at: z.iso.datetime() }).strict();
export const canonicalAbortSchema = z.object({ account_id: id, repo_id: id, operation_id: id, reservation_id: id.optional(), fence: id.optional(), rejection_evidence_id: id }).strict();

interface HelperIntent { allocation_id: string; reservation_id: string; slice_id: string; input_json: string; quote_json: string; request_hash: string; created_at: string }
interface GitIntent { repo_id: string; operation_id: string; account_id: string; reservation_id: string; slice_id: string; fence: string; request_hash: string; input_json: string; quote_json: string | null; created_at: string }

export async function helperIntent(env: BillingBindings, allocationId: string): Promise<HelperIntent> {
  const row = await one<HelperIntent>(billingEnvironment(env).DB, 'SELECT * FROM billing_helper_intents WHERE allocation_id=?', allocationId);
  invariant(row, 'helper_intent_missing', 'The trusted-helper allocation intent is not recorded.', 404);
  return row;
}

export async function helperQuote(env: BillingBindings, allocationId: string): Promise<HelperQuote> {
  return JSON.parse((await helperIntent(env, allocationId)).quote_json) as HelperQuote;
}

async function quoteHelper(env: BillingBindings, input: EssentialServiceInput, sliceId: string, hash: string): Promise<HelperQuote> {
  const profile = await one<{ version: string; maximum_duration_ms: number; maximum_egress_bytes: string; maximum_operations: number; compute_price_id: string; egress_price_id: string; operations_price_id: string }>(env.DB,
    'SELECT * FROM billing_helper_profiles WHERE id=? AND version<=? ORDER BY version DESC LIMIT 1', input.profile, now().slice(0, 10));
  invariant(profile && input.maximum_duration_ms <= profile.maximum_duration_ms && units(input.maximum_egress_bytes) <= units(profile.maximum_egress_bytes),
    'helper_profile_unavailable', 'The helper requires a versioned, bounded trusted profile.', 503);
  const maximumOperations = Number(env.GIT_HELPER_OPERATIONS ?? 1024);
  invariant(Number.isSafeInteger(maximumOperations) && maximumOperations > 0 && maximumOperations <= profile.maximum_operations,
    'helper_operation_limit', 'The helper operation allowance exceeds its immutable profile.', 503);
  const rates = await many<Rate>(env.DB, 'SELECT * FROM billing_prices WHERE id IN (?,?,?)', profile.compute_price_id, profile.egress_price_id, profile.operations_price_id);
  const find = (id: string) => { const value = rates.find(r => r.id === id); invariant(value, 'helper_price_missing', 'A trusted helper price version is unavailable.', 503); return value; };
  const price = { compute: find(profile.compute_price_id), egress: find(profile.egress_price_id), operations: find(profile.operations_price_id) };
  const maximum = units(maximumCharge(((BigInt(input.maximum_duration_ms) + 9n) / 10n * 10n).toString(), price.compute, true))
    + units(maximumCharge(input.maximum_egress_bytes, price.egress, true)) + units(maximumCharge(String(maximumOperations), price.operations, true));
  const reservationId = `hres_${await sha256(input.allocation_id)}`;
  return { input, reservation_id: reservationId, request_hash: hash, fence: `hf_${await sha256(`${reservationId}:${hash}`)}`,
    slice_id: sliceId, created_at: now(), maximum_operations: maximumOperations, profile_version: profile.version, rates: price, maximum_units: maximum.toString() };
}

export async function requireEssentialSlice(env: BillingBindings, sliceId: string): Promise<void> {
  const slice = await activeSlice(env, sliceId);
  const purpose = await one<{ purpose: string; pool_purpose: string }>(billingEnvironment(env).DB,
    'SELECT s.purpose,p.purpose AS pool_purpose FROM billing_capacity_slices s JOIN billing_platform_pools p ON p.id=s.pool_id WHERE s.id=?', sliceId);
  invariant(slice.cell_id === env.CELL_ID && purpose?.purpose === 'essential' && purpose.pool_purpose === 'essential',
    'essential_allocation_required', 'Trusted Git reads and helpers require a separately funded essential platform pool/slice.', 503);
}

export async function reserveEssentialService(env: BillingBindings, raw: EssentialServiceInput): Promise<{ reservation_id: string; fence: string; maximum_duration_ms: number }> {
  env = billingEnvironment(env);
  const input = essentialInputSchema.parse(raw), hash = await sha256(canonicalJson(input));
  const existing = await one<HelperIntent>(env.DB, 'SELECT * FROM billing_helper_intents WHERE allocation_id=?', input.allocation_id);
  if (!existing) {
    const slice = env.BILLING_ESSENTIAL_SLICE_ID;
    invariant(typeof slice === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(slice), 'essential_allocation_missing', 'No funded essential Git service slice is configured.', 503);
    await requireEssentialSlice(env, slice);
    const quote = await quoteHelper(env, input, slice, hash);
    await env.DB.prepare(`INSERT OR IGNORE INTO billing_helper_intents(allocation_id,reservation_id,slice_id,service,input_json,quote_json,request_hash,created_at) VALUES (?,?,?,?,?,?,?,?)`)
      .bind(input.allocation_id, quote.reservation_id, slice, input.service, canonicalJson(input), JSON.stringify(quote), hash, quote.created_at).run();
  }
  const intent = await helperIntent(env, input.allocation_id);
  invariant(intent.request_hash === hash, 'helper_intent_conflict', 'This allocation ID already has different limits.');
  const reservation = await admissionRequest<HelperReservation>(env, `capacity:${intent.slice_id}`, 'essential-reserve', { allocation_id: input.allocation_id });
  invariant(reservation.state !== 'settled', 'helper_allocation_settled', 'This allocation generation already settled.');
  return { reservation_id: reservation.reservation_id, fence: reservation.fence, maximum_duration_ms: reservation.input.maximum_duration_ms };
}

export async function startEssentialService(env: BillingBindings, input: EssentialServiceIdentity): Promise<void> {
  essentialIdentitySchema.parse(input);
  const intent = await helperIntent(env, input.allocation_id);
  invariant(intent.reservation_id === input.reservation_id, 'helper_fenced', 'This helper reservation belongs to another allocation.');
  await admissionRequest(env, `capacity:${intent.slice_id}`, 'essential-start', input);
}

export async function settleEssentialService(env: BillingBindings, input: EssentialServiceSettlement): Promise<void> {
  essentialSettlementSchema.parse(input);
  const intent = await helperIntent(env, input.allocation_id);
  invariant(intent.reservation_id === input.reservation_id, 'helper_fenced', 'This helper reservation belongs to another allocation.');
  verifyHelperReceipt(input);
  await admissionRequest(env, `capacity:${intent.slice_id}`, 'essential-settle', input);
}

export function verifyHelperReceipt(input: EssentialServiceSettlement): void {
  const containerId = /^git_([a-f0-9]{64})_[a-f0-9-]{36}$/i.exec(input.allocation_id)?.[1];
  if (input.termination_proof.kind === 'container_destroyed') invariant(containerId && input.termination_proof.receipt_id === `container:${containerId}:${input.allocation_id}:destroyed`,
    'helper_teardown_receipt', 'The destruction receipt does not identify this exact helper generation.');
}

interface Evidence {
  version: number; policy_revision: number; digest: string; marker_oid: string; marker_object_bytes?: string;
  updates: Array<{ ref: string; old_oid: string; new_oid: string }>;
  storage: { model: string; baseline_bytes: string; reachable_bytes: string; new_object_bytes: string; object_count: string; maximum_growth_bytes: string };
}
export async function publication(env: BillingBindings, repoId: string, operationId: string): Promise<{ row: GitPublicationAuthority; context: { repository: { owner_id: string; storage_name: string }; storage_admission?: { requested: boolean; reservation_id?: string; fence?: string } }; evidence: Evidence; result: { outcome: string; operation_id: string; marker_oid: string | null; proof?: string; refs: unknown[] } | null }> {
  const row = await billingMetadata<GitPublicationAuthority>(env, { repo_id: repoId, git_operation_id: operationId });
  invariant(row, 'git_publication_missing', 'The authoritative Git publication journal is unavailable.', 503);
  const context = JSON.parse(row.context_json) as { repository: { owner_id: string; storage_name: string }; storage_admission?: { requested: boolean; reservation_id?: string; fence?: string } };
  const evidence = JSON.parse(row.evidence_json ?? 'null') as Evidence;
  const result = JSON.parse(row.result_json ?? 'null') as { outcome: string; operation_id: string; marker_oid: string | null; proof?: string; refs: unknown[] } | null;
  return { row, context, evidence, result };
}

export async function canonicalIntent(env: BillingBindings, repo: string, operation: string): Promise<GitIntent | null> {
  return one<GitIntent>(billingEnvironment(env).DB, 'SELECT * FROM billing_git_intents WHERE repo_id=? AND operation_id=?', repo, operation);
}

export async function canonicalQuote(env: BillingBindings, input: CanonicalGitStorageInput, meter: CanonicalGitMeter | null): Promise<CanonicalGitQuote> {
  env = billingEnvironment(env);
  const pub = await publication(env, input.repo_id, input.operation_id);
  const repo = await billingMetadata<Repository>(env, { repo_id: input.repo_id, git_repository_operation_id: input.operation_id });
  invariant(pub.row.state === 'validated' && pub.context.storage_admission?.requested && repo && repo.owner_id === input.account_id
    && pub.context.repository.owner_id === input.account_id && pub.context.repository.storage_name === input.storage_name
    && await canonicalStorageMatches(repo, pub.row, input.storage_name) && repo.routing_epoch === input.routing_epoch && pub.row.routing_epoch === input.routing_epoch
    && pub.row.policy_revision === repo.policy_revision && pub.row.actor_id === input.actor_id,
  'git_admission_scope_changed', 'Git owner, routing epoch, policy or publication state changed before storage admission.');
  const evidence = pub.evidence;
  invariant(evidence?.version === 1 && evidence.storage?.model === 'logical-reachable-v1' && evidence.storage.maximum_growth_bytes === input.maximum_growth_bytes,
    'git_storage_evidence', 'Canonical storage requires its complete, native logical-object evidence.', 503);
  const { digest, marker_oid, marker_object_bytes: markerBytes, ...body } = evidence;
  invariant(await sha256(JSON.stringify(body)) === digest, 'git_evidence_digest', 'Native Git evidence integrity could not be verified.', 503);
  for (const value of [evidence.storage.baseline_bytes, evidence.storage.reachable_bytes, evidence.storage.new_object_bytes, evidence.storage.object_count, evidence.storage.maximum_growth_bytes, markerBytes ?? '0']) units(value);
  invariant(units(evidence.storage.new_object_bytes) + units(markerBytes ?? '0') <= units(input.maximum_growth_bytes), 'git_growth_bound', 'The native Git object growth exceeds its declared admission bound.', 422);
  const account = await ensureBillingAccount(env, input.account_id);
  invariant(account.state === 'active', 'subscription_inactive', 'This account does not admit new canonical storage.');
  const intent = await canonicalIntent(env, input.repo_id, input.operation_id);
  invariant(intent, 'git_intent_missing', 'Canonical storage has no durable admission intent.', 503);
  invariant(meter || evidence.storage.baseline_bytes === '0', 'git_baseline_unverified', 'An existing unmetered Git baseline requires a verified retained-storage reconciliation.', 503);
  const config = storagePolicy(env);
  const policy = meter?.renewal_policy ?? { commitment_seconds: config.commitment_seconds, renew_before_seconds: config.renew_before_seconds,
    deletion_grace_seconds: config.deletion_grace_seconds, on_renewal_failure: 'notify_block_writes_then_delete' as const };
  const window = storageFundingWindow(intent.created_at, null, policy);
  const days = Math.floor((Date.parse(window.commitment_until.slice(0, 10)) - Date.parse(intent.created_at.slice(0, 10))) / 86_400_000) + 1;
  const placements = await one(env.DB, "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='billing_placement_git'");
  const placementRow = placements ? await one<{ body_json: string; state: string }>(env.DB, `SELECT g.body_json,p.state FROM billing_placement_git g JOIN billing_storage_placements p ON p.operation_id=g.operation_id WHERE g.operation_id=?`, input.operation_id) : null;
  const hold = placementRow ? JSON.parse(placementRow.body_json) as PlacementGitHold : null;
  if (hold) invariant(['prepared','preparing'].includes(placementRow!.state) && hold.storage_name === input.storage_name && hold.account_id === input.account_id,
    'placement_git_fenced', 'The canonical copy grant is outside its physical handoff.');
  const rates = meter?.rates ?? hold?.rates ?? { logical: await currentRate(env.DB, 'git.storage.logical'), peak: await currentRate(env.DB, 'git.storage.daily-peak-bound') };
  const retained = units(meter?.retained_bound_bytes ?? '0');
  return { input, reservation_id: intent.reservation_id, fence: intent.fence, request_hash: intent.request_hash, slice_id: intent.slice_id,
    created_at: intent.created_at, repository_revision: repo.revision, policy_revision: repo.policy_revision,
    baseline_bytes: evidence.storage.baseline_bytes, reachable_bytes: evidence.storage.reachable_bytes, object_count: evidence.storage.object_count,
    evidence_digest: digest, marker_oid, funding_days: days, rates, retained_baseline_bytes: retained.toString(),
    ...window, renew_after: window.renew_after!, renewal_policy: policy, storage_cell_id: repo.cell_id, ...(hold ? { placement_operation_id: hold.operation_id } : {}),
    maximum_units: (units(maximumCharge((units(evidence.storage.reachable_bytes) * BigInt(Date.parse(window.commitment_until) - Date.parse(intent.created_at))).toString(), rates.logical)) + 1n).toString(),
    maximum_platform_units: (units(maximumCharge(((retained + units(input.maximum_growth_bytes)) * BigInt(days)).toString(), rates.peak, true)) + 1n).toString(),
    repository_limit_bytes: String(limits(env).repository_storage_bytes) };
}

export async function assertCanonicalAdmission(env: BillingBindings, quote: CanonicalGitQuote): Promise<void> {
  const i = quote.input;
  const [repo, pub, account] = await Promise.all([billingMetadata<Repository>(env, { repo_id: i.repo_id, git_repository_operation_id: i.operation_id }), publication(env, i.repo_id, i.operation_id), ensureBillingAccount(env, i.account_id)]);
  invariant(repo && repo.owner_id === i.account_id && repo.revision === quote.repository_revision && repo.routing_epoch === i.routing_epoch
    && repo.policy_revision === quote.policy_revision && await canonicalStorageMatches(repo, pub.row, i.storage_name) && account.state === 'active'
    && ['validated', 'publishing', 'uncertain'].includes(pub.row.state) && pub.evidence?.digest === quote.evidence_digest
    && pub.evidence.marker_oid === quote.marker_oid && pub.context.storage_admission?.requested,
  'git_admission_scope_changed', 'Canonical admission requires the original current owner, repository revision and publication evidence.');
  invariant(!await one(billingEnvironment(env).DB, 'SELECT 1 FROM billing_git_rejections WHERE repo_id=? AND operation_id=?', i.repo_id, i.operation_id), 'git_operation_aborted', 'This rejected publication cannot reacquire a grant.');
}

async function canonicalStorageMatches(repo: Repository, publication: GitPublicationAuthority, storageName: string): Promise<boolean> {
  return repo.storage_name === storageName || publication.kind === 'restore'
    && storageName === await placementStorageName(repo.id, publication.id);
}

export async function reserveCanonicalGitStorage(env: BillingBindings, raw: CanonicalGitStorageInput): Promise<{ reservation_id: string; fence: string }> {
  env = billingEnvironment(env);
  const input = canonicalInputSchema.parse(raw), hash = await sha256(canonicalJson(input));
  invariant(!await one(env.DB, 'SELECT operation_id FROM billing_git_rejections WHERE repo_id=? AND operation_id=?', input.repo_id, input.operation_id), 'git_operation_aborted', 'This rejected Git intent cannot be admitted.');
  if (!await canonicalIntent(env, input.repo_id, input.operation_id)) {
    const sliceId = env.BILLING_GIT_STORAGE_SLICE_ID ?? env.BILLING_PLATFORM_SLICE_ID;
    invariant(typeof sliceId === 'string', 'git_storage_allocation_missing', 'Canonical storage requires a funded platform slice.', 503);
    const slice = await activeSlice(env, sliceId);
    invariant(slice.purpose !== 'essential' && slice.cell_id === env.CELL_ID, 'git_storage_allocation_scope', 'Canonical retained storage requires this cell’s discretionary storage slice.');
    const reservationId = `gres_${await sha256(`${input.account_id}:${input.repo_id}:${input.operation_id}`)}`;
    await env.DB.prepare('INSERT OR IGNORE INTO billing_git_intents(repo_id,operation_id,account_id,reservation_id,slice_id,fence,request_hash,input_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(input.repo_id, input.operation_id, input.account_id, reservationId, sliceId, `gf_${await sha256(`${reservationId}:${hash}`)}`, hash, canonicalJson(input), now()).run();
  }
  const intent = (await canonicalIntent(env, input.repo_id, input.operation_id))!;
  invariant(intent.account_id === input.account_id && intent.request_hash === hash, 'git_intent_conflict', 'The canonical operation already has different storage admission inputs.');
  const result = await admissionRequest<CanonicalGitReservation>(env, `account:${input.account_id}`, 'git-reserve', input);
  invariant(result.state === 'reserved' || result.state === 'committed', 'git_storage_not_admitted', 'The canonical storage reservation is not ready.');
  return { reservation_id: result.reservation_id, fence: result.fence };
}

export async function verifyCanonicalCommit(env: BillingBindings, input: CanonicalGitCommit): Promise<{ effective_at: string; hash: string }> {
  canonicalCommitSchema.parse(input);
  env = billingEnvironment(env);
  const { verified_at: _ignored, ...fixed } = input;
  const hash = await sha256(canonicalJson(fixed));
  const previous = await one<{ receipt_hash: string; effective_at: string }>(env.DB, 'SELECT receipt_hash,effective_at FROM billing_git_receipts WHERE repo_id=? AND operation_id=?', input.repo_id, input.operation_id);
  if (previous) { invariant(previous.receipt_hash === hash, 'git_receipt_conflict', 'This publication already has a different immutable receipt.'); return { effective_at: previous.effective_at, hash }; }
  const p = await publication(env, input.repo_id, input.operation_id), s = p.evidence?.storage;
  invariant(p.row.state === 'committed' && p.context.repository.owner_id === input.account_id && p.result?.outcome === 'committed'
    && ['marker', 'report_status'].includes(p.result.proof ?? '') && p.result.operation_id === input.operation_id
    && p.result.marker_oid === input.marker_oid && p.evidence.marker_oid === input.marker_oid && p.evidence.digest === input.evidence_digest
    && p.context.storage_admission?.reservation_id === input.reservation_id && p.context.storage_admission.fence === input.fence
    && s?.reachable_bytes === input.reachable_bytes && s.object_count === input.object_count
    && (units(s.new_object_bytes) + units(p.evidence.marker_object_bytes ?? '0')).toString() === input.new_object_bytes,
  'git_commit_unverified', 'Canonical storage settlement requires the matching durable marker/publication receipt.');
  const refs = p.evidence.updates.map(({ ref, old_oid, new_oid }) => ({ ref, old_oid, new_oid }));
  invariant(canonicalJson(refs) === canonicalJson(p.result.refs), 'git_commit_manifest_changed', 'Canonical publication receipt changed its exact ref manifest.');
  invariant(input.verified_at >= p.row.updated_at && input.verified_at <= now(), 'git_verification_time', 'Canonical verification time is invalid.', 422);
  await env.DB.prepare('INSERT OR IGNORE INTO billing_git_receipts(repo_id,operation_id,account_id,reservation_id,receipt_hash,effective_at,source_revision,evidence_json) VALUES (?,?,?,?,?,?,?,?)')
    .bind(input.repo_id, input.operation_id, input.account_id, input.reservation_id, hash, p.row.updated_at, p.row.revision, JSON.stringify({ input: fixed, source: p.row })).run();
  const saved = (await one<{ receipt_hash: string; effective_at: string }>(env.DB, 'SELECT receipt_hash,effective_at FROM billing_git_receipts WHERE repo_id=? AND operation_id=?', input.repo_id, input.operation_id))!;
  invariant(saved.receipt_hash === hash, 'git_receipt_conflict', 'This publication already has a different immutable receipt.');
  return { effective_at: saved.effective_at, hash };
}

export async function commitCanonicalGitStorage(env: BillingBindings, input: CanonicalGitCommit): Promise<void> {
  canonicalCommitSchema.parse(input);
  await admissionRequest(env, `account:${input.account_id}`, 'git-commit', input);
}

export async function verifyCanonicalRejection(env: BillingBindings, input: CanonicalGitAbort): Promise<{ proof: 'not_started' | 'report_status'; effective_at: string }> {
  canonicalAbortSchema.parse(input);
  env = billingEnvironment(env);
  const old = await one<{ account_id: string; evidence_id: string; proof: 'not_started' | 'report_status'; effective_at: string }>(env.DB,
    'SELECT * FROM billing_git_rejections WHERE repo_id=? AND operation_id=?', input.repo_id, input.operation_id);
  if (old) { invariant(old.account_id === input.account_id && old.evidence_id === input.rejection_evidence_id, 'git_rejection_conflict', 'This Git rejection already has another receipt.'); return old; }
  const p = await publication(env, input.repo_id, input.operation_id);
  invariant(p.row.state === 'rejected' && p.context.repository.owner_id === input.account_id
    && input.rejection_evidence_id === `git-publication:${input.operation_id}:${p.row.publisher_id}:rejected`,
  'git_rejection_unverified', 'Only a definitive rejection in the authoritative Git journal may abort storage admission.');
  let proof: 'not_started' | 'report_status' = 'not_started';
  if (p.result) {
    invariant(p.result.outcome === 'rejected' && ['not_started', 'report_status'].includes(p.result.proof ?? ''), 'git_rejection_uncertain', 'An uncertain publisher cannot release storage holds.');
    proof = p.result.proof as 'not_started' | 'report_status';
  } else {
    invariant(p.row.error_json && JSON.parse(p.row.error_json).code, 'git_rejection_uncertain', 'A pre-publication rejection needs its durable error receipt.');
  }
  await env.DB.prepare('INSERT OR IGNORE INTO billing_git_rejections(repo_id,operation_id,account_id,evidence_id,proof,effective_at,created_at) VALUES (?,?,?,?,?,?,?)')
    .bind(input.repo_id, input.operation_id, input.account_id, input.rejection_evidence_id, proof, p.row.updated_at, now()).run();
  return verifyCanonicalRejection(env, input);
}

export async function abortCanonicalGitStorage(env: BillingBindings, input: CanonicalGitAbort): Promise<void> {
  env = billingEnvironment(env);
  await verifyCanonicalRejection(env, input);
  await admissionRequest(env, `account:${input.account_id}`, 'git-rejection-fence', input);
  const intent = await canonicalIntent(env, input.repo_id, input.operation_id);
  if (!intent) return;
  invariant(intent.account_id === input.account_id && (!input.reservation_id || intent.reservation_id === input.reservation_id) && (!input.fence || intent.fence === input.fence), 'git_rejection_scope', 'The rejected reservation identity changed.');
  await admissionRequest(env, `capacity:${intent.slice_id}`, 'git-rejection-fence', input);
  await admissionRequest(env, `account:${input.account_id}`, 'git-abort', { ...input, reservation_id: intent.reservation_id, fence: intent.fence });
}

export async function canonicalPurgeReceipt(env: BillingBindings, repoId: string, storageName: string): Promise<{ confirmed_at: string; operation_id: string } | null> {
  env = billingEnvironment(env);
  const old = await one<{ confirmed_at: string; operation_id: string }>(env.DB, 'SELECT confirmed_at,operation_id FROM billing_git_purges WHERE repo_id=? AND storage_name=?', repoId, storageName);
  if (old) return old;
  const proof = await billingMetadata<GitPurgeAuthority>(env, { repo_id: repoId, git_purge_storage_name: storageName });
  if (!proof) return null;
  invariant(proof.repo_id === repoId && proof.storage_name === storageName && proof.confirmed_at <= now(), 'git_purge_unverified', 'Canonical purge must bind the exact retained provider repository.');
  await env.DB.prepare('INSERT OR IGNORE INTO billing_git_purges(repo_id,storage_name,operation_id,confirmed_at,source_confirmed_at,receipt_json) VALUES (?,?,?,?,?,?)')
    .bind(repoId, storageName, proof.operation_id, now(), proof.confirmed_at, JSON.stringify(proof)).run();
  return one(env.DB, 'SELECT confirmed_at,operation_id FROM billing_git_purges WHERE repo_id=? AND storage_name=?', repoId, storageName);
}
