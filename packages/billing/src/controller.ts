import { ApiError, canonicalJson, diagnostic, many, now, one, readBounded, sha256, verifyInternalRequest, resolveResourceLocator, readRepositoryAuthority } from '@gitknot/core';
import type { Repository } from '@gitknot/core';
import { z } from 'zod';
import { PlacementAdmissionBook } from './placement-book.ts';
import { placementController } from './placement-controller.ts';
import { placementParticipants, storagePlacement } from './placement-state.ts';
import { activeSlice, ensureBillingAccount, getPlan, initialControl, subscriptionCommitmentUnits } from './catalog.ts';
import { invariant } from './errors.ts';
import { flushBillingJournal } from './projection.ts';
import { admissionRequest } from './transport.ts';
import { billingMetadata, quoteStandaloneStorage, standaloneStorageSchema, standaloneTerms, storageFundingWindow } from './storage-policy.ts';
import type { BillingManifest } from './storage-policy.ts';
import { verifyStorageHandoff } from './storage-transfer.ts';
import { headStorageObject, deletePhysicalStorage } from './physical-storage.ts';
import { billingEnvironment } from './authority.ts';
import { handleGitTransfer } from './git-transfer.ts';
import { helperQuote, helperIntent, requireEssentialSlice, essentialIdentitySchema, essentialSettlementSchema, canonicalInputSchema, canonicalQuote,
  canonicalIntent, verifyCanonicalCommit, verifyCanonicalRejection, canonicalCommitSchema, canonicalAbortSchema, assertCanonicalAdmission, verifyHelperReceipt, canonicalPurgeReceipt } from './git.ts';
import type { CanonicalGitAbort, CanonicalGitCommit, CanonicalGitMeter, CanonicalGitQuote, CanonicalGitReservation, EssentialServiceIdentity, EssentialServiceSettlement, GitFundingWindow, HelperReservation } from './git-types.ts';
import type {
  AdmissionControl, BillingBindings, BillingStore, BillingTransaction, Budget, CommitStorageInput, ExecutionQuote,
  Reservation, ReserveStorageInput, SettleExecutionInput, StorageObject, StandaloneStorageInput, StandaloneStorageTerms, StorageRenewal, StorageImport, BillingCommand, CancelStorageIntentInput, StorageIntentCancellation,
} from './types.ts';

type Prepare = { id: string; fence: string; request_hash: string; quote: ExecutionQuote };
type Pending = { action: string; body: unknown };
const identifier = z.string().min(1).max(256);
const gitMeterSchema = z.object({ repo_id: identifier, storage_name: identifier });
const gitRenewalSchema = gitMeterSchema.extend({ renewal_id: identifier, window: z.object({ funded_until: z.iso.datetime(), commitment_until: z.iso.datetime(), renew_after: z.iso.datetime() }) });
const identitySchema = z.object({ reservation_id: identifier, fence: identifier, account_id: identifier }).passthrough();
const startSchema = identitySchema.extend({ runtime_id: identifier });
const settleSchema = startSchema.extend({
  event_id: identifier, duration_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), egress_bytes: z.string().regex(/^(0|[1-9][0-9]{0,62})$/).optional(),
  outcome: z.enum(['success', 'failure', 'cancelled', 'timed_out', 'infrastructure_failure']),
  termination_proof: z.object({ kind: z.enum(['hosted_destroyed', 'customer_process_exited', 'never_allocated']), receipt_id: identifier.min(8), verified_at: z.iso.datetime() }).strict(),
});

function transactionAdapter(storage: DurableObjectTransaction | DurableObjectStorage): BillingTransaction {
  return {
    get: <T>(key: string) => storage.get<T>(key),
    put: async <T>(key: string, value: T) => { await storage.put(key, value); },
    delete: (key: string) => storage.delete(key),
    list: <T>(options?: { prefix?: string; limit?: number; startAfter?: string }) => storage.list<T>(options),
  };
}

function storeAdapter(storage: DurableObjectStorage): BillingStore {
  return { ...transactionAdapter(storage), transaction: <T>(callback: (tx: BillingTransaction) => Promise<T>) => storage.transaction((tx) => callback(transactionAdapter(tx))) };
}

/** SQLite-backed DO, instantiated per billing account or preallocated operating-cost slice. */
export class AdmissionController {
  private readonly store: BillingStore;
  private readonly book: PlacementAdmissionBook;
  private initializing?: Promise<void>;
  private target?: string;
  private readonly env: BillingBindings;

  constructor(private readonly ctx: DurableObjectState, env: BillingBindings) {
    this.env = billingEnvironment(env);
    this.store = storeAdapter(ctx.storage);
    this.book = new PlacementAdmissionBook(this.store);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const path = /^\/internal\/billing\/(account|capacity)\/([A-Za-z0-9_-]{1,128})\/([a-z-]+)$/.exec(new URL(request.url).pathname);
      invariant(request.method === 'POST' && path, 'not_found', 'Admission endpoint not found.', 404);
      const [, kind, id, action] = path;
      await verifyInternalRequest(request, this.env.INTERNAL_SERVICE_KEY, `billing:${kind}:${action}`);
      const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(request.body, 128 * 1024))) as unknown;
      if (['git-rejection-fence', 'git-meter', 'git-operation'].includes(action!)) {
        invariant(!this.target || this.target === `${kind}:${id}`, 'coordinator_scope', 'The request reached another coordinator.', 404);
        this.target = `${kind}:${id}`;
        if (action === 'git-rejection-fence') {
          const input = canonicalAbortSchema.parse(body);
          await verifyCanonicalRejection(this.env, input);
          const intent = await canonicalIntent(this.env, input.repo_id, input.operation_id);
          invariant(kind === 'account' ? id === input.account_id : intent?.slice_id === id, 'git_fence_scope', 'The rejected intent belongs to another coordinator.');
          await this.book.abortGitIntent(input.repo_id, input.operation_id);
          return Response.json({ fenced: true });
        }
        if (action === 'git-meter') {
          const input = z.object({ repo_id: identifier, storage_name: identifier }).parse(body);
          return Response.json(await this.book.gitMeter(input.repo_id, input.storage_name));
        }
        const input = z.object({ reservation_id: identifier }).parse(body);
        return Response.json(await this.store.get(`git-operation:${input.reservation_id}`) ?? null);
      }
      if (action === 'git-cancel' && kind === 'capacity' && !await this.store.get('control')) {
        const quote = body as CanonicalGitQuote;
        const intent = await canonicalIntent(this.env, quote.input.repo_id, quote.input.operation_id);
        invariant(intent && intent.slice_id === id && intent.fence === quote.fence, 'git_cancel_scope', 'The canonical compensation belongs to another slice.');
        await this.book.abortGitIntent(quote.input.repo_id, quote.input.operation_id);
        return Response.json({ cancelled: true });
      }
      if (action === 'placement-close') {
        invariant(!this.target || this.target === `${kind}:${id}`, 'coordinator_scope', 'The request reached another coordinator.', 404);
        this.target = `${kind}:${id}`;
        const input = z.object({ operation_id: identifier }).strict().parse(body);
        const placement = await storagePlacement(this.env, input.operation_id);
        invariant((await placementParticipants(this.env, placement)).includes(`${kind}:${id}`), 'placement_scope', 'This coordinator is outside the placement.');
        await this.book.closePlacement(placement);
        return Response.json({ closed: true, fence: placement.fence });
      }
      await this.initialize(`${kind}:${id}`);
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      if (kind === 'capacity') await this.checkObjectFence(action!, body);
      const result = await this.dispatch(action!, body);
      await this.flush();
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      if (this.target) { try { await this.flush(); } catch { /* The alarm retains and retries the durable financial journal. */ } }
      const known = error instanceof ApiError;
      if (!known) console.error(JSON.stringify({ event: 'billing.admission.failed', coordinator_id: this.target ?? null, diagnostic: diagnostic(error) }));
      return Response.json({ error: { code: known ? error.code : 'admission_unavailable',
        message: known ? error.message : 'Admission state could not be verified.',
        ...(known && error.details ? { details: error.details } : {}) } }, { status: known ? error.status : 503, headers: { 'cache-control': 'no-store' } });
    }
  }

  async alarm(): Promise<void> {
    const control = await this.store.get<AdmissionControl>('control');
    if (!control) return;
    this.target = control.id;
    try {
      await this.flush();
      const pending = await this.store.list<Pending>({ prefix: 'pending:', limit: 32 });
      for (const [key, command] of pending) {
        try { await this.dispatch(command.action, command.body); await this.store.delete(key); }
        catch { /* The durable intent and all uncertain holds remain for the next bounded retry. */ }
      }
      await this.stopOverdueRuntimes();
      await this.stopOverdueGit();
      await this.flush();
    } finally {
      const active = await this.store.list({ prefix: 'active:', limit: 1 });
      const pending = await this.store.list({ prefix: 'pending:', limit: 1 });
      const journals = await this.store.list({ prefix: 'journal:', limit: 1 });
      const git = await this.store.list({ prefix: 'git-active:', limit: 1 });
      const helpers = await this.store.list({ prefix: 'helper-active:', limit: 1 });
      if (active.size || pending.size || journals.size || git.size || helpers.size) await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  private async initialize(target: string): Promise<void> {
    invariant(!this.target || this.target === target, 'coordinator_scope', 'The request reached a different billing account.', 404);
    this.target = target;
    this.initializing ??= this.ctx.blockConcurrencyWhile(async () => {
      const existing = await this.store.get<AdmissionControl>('control');
      if (existing) { invariant(existing.id === target, 'coordinator_scope', 'Stored coordinator identity is inconsistent.', 503); return; }
      const initial = await initialControl(this.env, target);
      await this.book.initialize(initial.control, initial.budgets, initial.subscription);
    });
    await this.initializing;
  }

  private async dispatch(action: string, input: unknown): Promise<unknown> {
    if (action.startsWith('placement-')) return placementController(this.env, this.book, this.target!, action,
      z.object({ operation_id: identifier, object_id: identifier.optional() }).parse(input));
    if (['git-transfer-fence', 'git-transfer-prepare', 'git-transfer-activate', 'git-transfer-settle', 'git-transfer-abort', 'git-transfer-resume'].includes(action)) {
      return handleGitTransfer(this.env, this.book, this.target!, action, input);
    }
    switch (action) {
      case 'snapshot': return this.book.snapshot();
      case 'flush': await this.flush(); return { flushed: true };
      case 'close-period': return this.closePeriod(z.object({ through: z.iso.datetime() }).parse(input).through);
      case 'fixed-cost': await this.book.standingCommitment(z.object({ id: identifier, amount_units: z.string(), settle_units: z.string().optional() }).parse(input)); return { committed: true };
      case 'rollover': { const i = z.object({ period_start: z.iso.datetime(), period_end: z.iso.datetime() }).parse(input); return this.rollover(i.period_start, i.period_end); }
      case 'reserve': return this.reserve(input as Prepare);
      case 'commit': { const i = identitySchema.parse(input); return this.book.markReserved(i.reservation_id, i.fence); }
      case 'start': return this.start(startSchema.parse(input));
      case 'running': { const i = identitySchema.parse(input); return this.book.markRunning(i.reservation_id, i.fence); }
      case 'cancel': return this.cancel(input as { account_id: string; reservation_id: string; fence: string; request_hash?: string; quote?: ExecutionQuote });
      case 'settle': return this.settle(settleSchema.parse(input));
      case 'get-reservation': return this.book.reservation(z.object({ reservation_id: identifier }).parse(input).reservation_id);
      case 'get-command': return this.book.command(z.object({ command_id: identifier }).parse(input).command_id);
      case 'essential-reserve': return this.essentialReserve(z.object({ allocation_id: identifier }).parse(input).allocation_id);
      case 'essential-start': return this.essentialStart(essentialIdentitySchema.parse(input));
      case 'essential-settle': return this.essentialSettle(essentialSettlementSchema.parse(input));
      case 'git-reserve': return this.gitReserve(input);
      case 'git-admit': { const i = z.object({ reservation_id: identifier, fence: identifier }).parse(input); return this.book.admitGit(i.reservation_id, i.fence); }
      case 'git-commit': return this.gitCommit(canonicalCommitSchema.parse(input));
      case 'git-abort': return this.gitAbort(canonicalAbortSchema.parse(input));
      case 'git-cancel': return this.gitCancel(input as CanonicalGitQuote);
      case 'git-accrue': { const i = gitMeterSchema.extend({ through: z.iso.datetime() }).parse(input); return this.gitAccrue(i); }
      case 'git-renew': return this.gitRenew(gitMeterSchema.parse(input));
      case 'git-purge': return this.gitPurge(gitMeterSchema.parse(input));
      case 'git-renew-prepare': { const i = gitRenewalSchema.parse(input); await this.book.prepareGitRenewal(i.repo_id, i.storage_name, i.renewal_id, i.window); return { prepared: true }; }
      case 'git-renew-commit': { const i = z.object({ repo_id: identifier, storage_name: identifier, renewal_id: identifier }).parse(input); await this.book.commitGitRenewal(i.repo_id, i.storage_name, i.renewal_id); return { committed: true }; }
      case 'git-renew-abort': { const i = z.object({ repo_id: identifier, storage_name: identifier, renewal_id: identifier }).parse(input); await this.book.abortGitRenewal(i.repo_id, i.storage_name, i.renewal_id); return { aborted: true }; }
      case 'get-budget': return this.book.budget(z.object({ budget_id: identifier }).parse(input).budget_id);
      case 'storage-reserve': return this.storageReserve(input as ReserveStorageInput);
      case 'storage-commit': return this.storageCommit(input as CommitStorageInput);
      case 'storage-accrue': return this.storageAccrue(z.object({ object_id: identifier, through: z.iso.datetime() }).parse(input));
      case 'storage-delete': return this.storageDelete(z.object({ object_id: identifier, confirmed_at: z.iso.datetime().optional() }).parse(input));
      case 'storage-expire': return this.storageExpire(z.object({ object_id: identifier }).parse(input).object_id);
      case 'storage-claim-deletion': { const i = z.object({ object_id: identifier, request_id: identifier }).parse(input); return this.book.claimStorageDeletion(i.object_id, i.request_id); }
      case 'storage-release-deletion': { const i = z.object({ object_id: identifier, request_id: identifier }).parse(input); return this.book.releaseStorageDeletion(i.object_id, i.request_id); }
      case 'storage-cancel-intent': return this.cancelStorageIntent(z.object({ account_id: identifier, object_id: identifier, repo_id: identifier.nullable().optional() }).parse(input));
      case 'storage-begin-delete': return this.book.beginDelete(z.object({ object_id: identifier }).parse(input).object_id);
      case 'get-object': return this.book.object(z.object({ object_id: identifier }).parse(input).object_id);
      case 'standalone-reserve': return this.standaloneReserve(input);
      case 'standalone-commit': { const i = z.object({ object_id: identifier, fence: identifier }).parse(input); return this.book.commitStandaloneAdmission(i.object_id, i.fence); }
      case 'standalone-cancel': return this.standaloneCancel(input as StandaloneStorageTerms);
      case 'storage-abort': { const i = z.object({ object_id: identifier, fence: identifier, receipt: identifier }).parse(input); invariant(!this.isAccount(), 'manifest_proof_required', 'Upload abort requires a verified primary manifest fence.', 403); return this.book.abortUnuploadedObject(i.object_id, i.fence, i.receipt); }
      case 'storage-renew': return this.storageRenew(z.object({ object_id: identifier }).parse(input).object_id);
      case 'renewal-prepare': { const i = input as { object_id: string; renewal: StorageRenewal }; return this.book.prepareRenewal(i.object_id, i.renewal); }
      case 'renewal-commit': { const i = z.object({ object_id: identifier, renewal_id: identifier }).parse(input); return this.book.finishRenewal(i.object_id, i.renewal_id, true); }
      case 'renewal-abort': { const i = z.object({ object_id: identifier, renewal_id: identifier }).parse(input); return this.book.finishRenewal(i.object_id, i.renewal_id, false); }
      case 'transfer-out': return this.transferOut(input as { object_id: string; operation_id: string });
      case 'transfer-in': return this.transferIn(input as { object_id: string; operation_id: string; terms?: StandaloneStorageTerms; imported?: StorageImport });
      case 'transfer-activate': return this.transferActivate(input as { object_id: string; operation_id: string; effective_at: string });
      case 'transfer-settle': return this.transferSettle(input as { object_id: string; operation_id: string; effective_at: string });
      case 'transfer-abort-in': return this.transferAbortIn(input as { object_id: string; operation_id: string });
      case 'transfer-resume': return this.transferResume(input as { object_id: string; operation_id: string });
      case 'stop': { const i = z.object({ stopped: z.boolean(), reason: z.string().max(1000).nullable(), revision: z.number().int(), command: z.object({ id: identifier, request_hash: z.string() }).optional() }).parse(input); return this.book.setStop(i.stopped, i.reason, i.revision, i.command); }
      case 'budget': { const i = input as { budget: Budget; expected_revision: number | null; command?: BillingCommand }; return this.book.putBudget(i.budget, i.expected_revision, i.command); }
      case 'limits': { invariant(this.isAccount(), 'capacity_allocation_immutable', 'Capacity limits require a separately allocated immutable slice.', 403); const i = input as { max_concurrency: number; max_storage_bytes: string; valid_until?: string; revision: number }; return this.book.updateLimits(i, i.revision); }
      default: throw new ApiError(404, 'not_found', 'Admission operation not found.');
    }
  }

  private isAccount(): boolean { return this.target!.startsWith('account:'); }

  private async reserve(input: Prepare): Promise<Reservation> {
    invariant(input && typeof input.id === 'string' && typeof input.fence === 'string' && typeof input.request_hash === 'string'
      && input.quote && input.quote.attribution, 'invalid_admission', 'Admission requires a validated immutable cost quote.', 422);
    await this.assertCurrent(input.quote);
    let r = await this.book.prepare(input);
    if (!this.isAccount() || r.state !== 'preparing') return r;
    const command = { ...input, quote: r.quote, fence: r.fence, request_hash: r.request_hash };
    await this.store.put(`pending:reserve:${r.id}`, { action: 'reserve', body: command });
    try {
      const participant = await this.remote<Reservation>(r, 'reserve', command);
      if (participant.state === 'queued') return r;
      invariant(participant.state !== 'cancelled', 'reservation_cancelled', 'This generation was already cancelled.');
      await this.remote(r, 'commit', this.identity(r));
      r = await this.book.markReserved(r.id, r.fence);
      await this.store.delete(`pending:reserve:${r.id}`);
      return r;
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) await this.cancel({ ...this.identity(r), quote: r.quote, request_hash: r.request_hash });
      throw error;
    }
  }

  private async start(input: { account_id: string; reservation_id: string; fence: string; runtime_id: string }): Promise<Reservation> {
    let r = await this.book.reservation(input.reservation_id);
    this.assertAccount(input.account_id, r);
    await this.assertCurrent(r.quote);
    r = await this.book.beginStart(input.reservation_id, input.fence, input.runtime_id);
    if (this.isAccount()) {
      await this.store.put(`pending:start:${r.id}`, { action: 'start', body: input });
      await this.remote(r, 'start', input);
    }
    r = await this.book.markRunning(r.id, r.fence);
    if (this.isAccount()) await this.store.delete(`pending:start:${r.id}`);
    return r;
  }

  private async essentialReserve(allocationId: string): Promise<unknown> {
    const quote = await helperQuote(this.env, allocationId);
    invariant(this.target === `capacity:${quote.slice_id}`, 'essential_scope', 'The helper allocation belongs to another essential slice.');
    await requireEssentialSlice(this.env, quote.slice_id);
    return this.book.reserveHelper(quote);
  }

  private async essentialStart(input: EssentialServiceIdentity): Promise<{ started: true }> {
    const intent = await helperIntent(this.env, input.allocation_id);
    invariant(this.target === `capacity:${intent.slice_id}` && input.reservation_id === intent.reservation_id, 'essential_scope', 'The helper allocation identity changed.');
    await requireEssentialSlice(this.env, intent.slice_id);
    await this.book.startHelper(input.reservation_id, input.fence);
    return { started: true };
  }

  private async essentialSettle(input: EssentialServiceSettlement): Promise<{ settled: true }> {
    const intent = await helperIntent(this.env, input.allocation_id);
    invariant(this.target === `capacity:${intent.slice_id}`, 'essential_scope', 'The helper allocation belongs to another essential slice.');
    verifyHelperReceipt(input);
    await this.book.settleHelper(input, await sha256(canonicalJson(input)));
    return { settled: true };
  }

  private async gitReserve(raw: unknown): Promise<CanonicalGitReservation> {
    if (!this.isAccount()) {
      const quote = raw as CanonicalGitQuote;
      invariant(quote.slice_id && this.target === `capacity:${quote.slice_id}`, 'git_slice_scope', 'The canonical storage slice changed.');
      const intent = await canonicalIntent(this.env, quote.input.repo_id, quote.input.operation_id);
      invariant(intent?.quote_json && canonicalJson(JSON.parse(intent.quote_json)) === canonicalJson(quote), 'git_quote_changed', 'Canonical participants require the same immutable quote.');
      invariant((await activeSlice(this.env, quote.slice_id)).purpose === 'discretionary', 'git_slice_scope', 'Canonical storage requires its dedicated discretionary allocation.');
      await assertCanonicalAdmission(this.env, quote);
      return this.book.reserveGit(quote);
    }
    const input = canonicalInputSchema.parse(raw);
    invariant(this.target === `account:${input.account_id}`, 'git_account_scope', 'The canonical publication payer changed.');
    const intent = await canonicalIntent(this.env, input.repo_id, input.operation_id);
    invariant(intent && intent.account_id === input.account_id, 'git_intent_missing', 'Canonical storage has no current account intent.');
    invariant(intent.request_hash === await sha256(canonicalJson(input)), 'git_intent_conflict', 'The canonical intent has different admission inputs.');
    const previous = await this.store.get<CanonicalGitReservation>(`git-operation:${intent.reservation_id}`);
    if (previous?.state === 'committed') return previous;
    invariant(previous?.state !== 'aborted', 'git_operation_aborted', 'A rejected storage generation cannot be admitted.');
    if (!intent.quote_json) {
      const quote = await canonicalQuote(this.env, input, await this.book.gitMeter(input.repo_id, input.storage_name));
      await this.env.DB.prepare('UPDATE billing_git_intents SET quote_json=? WHERE repo_id=? AND operation_id=? AND quote_json IS NULL')
        .bind(JSON.stringify(quote), input.repo_id, input.operation_id).run();
    }
    const quote = JSON.parse((await canonicalIntent(this.env, input.repo_id, input.operation_id))!.quote_json!) as CanonicalGitQuote;
    await assertCanonicalAdmission(this.env, quote);
    if (previous?.state === 'reserved') return previous;
    const reserved = await this.book.reserveGit(quote);
    await this.store.put(`pending:git-reserve:${reserved.reservation_id}`, { action: 'git-reserve', body: input });
    const target = `capacity:${reserved.slice_id}`;
    try {
      await admissionRequest(this.env, target, 'git-reserve', quote);
      await admissionRequest(this.env, target, 'git-admit', { reservation_id: reserved.reservation_id, fence: reserved.fence });
      await assertCanonicalAdmission(this.env, quote);
      const admitted = await this.book.admitGit(reserved.reservation_id, reserved.fence);
      await this.store.delete(`pending:git-reserve:${reserved.reservation_id}`);
      return admitted;
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) await this.gitCancel(quote);
      throw error;
    }
  }

  private async gitCommit(input: CanonicalGitCommit): Promise<{ committed: true }> {
    const intent = await canonicalIntent(this.env, input.repo_id, input.operation_id);
    invariant(intent && intent.account_id === input.account_id && intent.reservation_id === input.reservation_id && intent.fence === input.fence,
      'git_commit_scope', 'Canonical storage commit does not match its immutable admission.');
    invariant(this.target === (this.isAccount() ? `account:${input.account_id}` : `capacity:${intent.slice_id}`), 'git_commit_scope', 'Canonical commit reached the wrong coordinator.');
    const { verified_at: _time, ...stable } = input;
    const hash = await sha256(canonicalJson(stable));
    const existing = await this.book.gitOperation(input.reservation_id);
    invariant(existing.evidence_digest === input.evidence_digest && existing.marker_oid === input.marker_oid && existing.reachable_bytes === input.reachable_bytes
      && existing.object_count === input.object_count, 'git_receipt_changed', 'Canonical settlement does not match the admitted evidence.');
    if (existing.state === 'committed') { invariant(existing.receipt_hash === hash, 'git_receipt_conflict', 'The operation already has another canonical receipt.'); return { committed: true }; }
    const verified = await verifyCanonicalCommit(this.env, input);
    if (this.isAccount()) {
      await this.store.put(`pending:git-commit:${input.reservation_id}`, { action: 'git-commit', body: input });
      await admissionRequest(this.env, `capacity:${intent.slice_id}`, 'git-commit', input);
    }
    await this.book.commitGit(input.reservation_id, input.fence, verified.hash, verified.effective_at, true);
    if (this.isAccount()) await this.store.delete(`pending:git-commit:${input.reservation_id}`);
    return { committed: true };
  }

  private async gitAbort(input: CanonicalGitAbort): Promise<{ aborted: true }> {
    const rejection = await verifyCanonicalRejection(this.env, input);
    const intent = await canonicalIntent(this.env, input.repo_id, input.operation_id);
    if (!intent) return { aborted: true };
    invariant(intent.account_id === input.account_id && this.target === (this.isAccount() ? `account:${input.account_id}` : `capacity:${intent.slice_id}`)
      && (!input.reservation_id || input.reservation_id === intent.reservation_id) && (!input.fence || input.fence === intent.fence), 'git_rejection_scope', 'Canonical rejection reached another financial owner.');
    await this.book.abortGitIntent(input.repo_id, input.operation_id);
    const existing = await this.store.get<CanonicalGitReservation>(`git-operation:${intent.reservation_id}`);
    if (this.isAccount()) {
      await this.store.put(`pending:git-abort:${intent.reservation_id}`, { action: 'git-abort', body: input });
      await admissionRequest(this.env, `capacity:${intent.slice_id}`, 'git-abort', input);
    }
    if (existing && existing.receipt_hash !== `admission-denied:${existing.reservation_id}`) {
      const hash = await sha256(canonicalJson({ account_id: input.account_id, repo_id: input.repo_id, operation_id: input.operation_id, rejection_evidence_id: input.rejection_evidence_id }));
      await this.book.commitGit(existing.reservation_id, existing.fence, hash, rejection.effective_at, false, rejection.proof === 'report_status');
    }
    if (this.isAccount()) {
      await this.store.delete(`pending:git-abort:${intent.reservation_id}`);
      await this.store.delete(`pending:git-reserve:${intent.reservation_id}`);
    }
    return { aborted: true };
  }

  private async gitCancel(quote: CanonicalGitQuote): Promise<{ cancelled: true }> {
    await this.book.cancelGitPrepare(quote, !this.isAccount());
    if (this.isAccount()) {
      await this.store.put(`pending:git-cancel:${quote.reservation_id}`, { action: 'git-cancel', body: quote });
      await admissionRequest(this.env, `capacity:${quote.slice_id}`, 'git-cancel', quote);
      await this.store.delete(`pending:git-cancel:${quote.reservation_id}`);
      await this.store.delete(`pending:git-reserve:${quote.reservation_id}`);
    }
    return { cancelled: true };
  }

  private async gitAccrue(input: { repo_id: string; storage_name: string; through: string }): Promise<CanonicalGitMeter> {
    const meter = await this.book.gitMeter(input.repo_id, input.storage_name);
    invariant(meter, 'git_meter_missing', 'The canonical meter is unavailable.', 404);
    if (this.isAccount()) await admissionRequest(this.env, `capacity:${meter.slice_id}`, 'git-accrue', input);
    return this.book.accrueGit(input.repo_id, input.storage_name, input.through);
  }

  private async gitRenew(input: { repo_id: string; storage_name: string }): Promise<CanonicalGitMeter> {
    invariant(this.isAccount(), 'git_renewal_scope', 'Only the owning account coordinates retained Git funding.');
    let meter = await this.book.gitMeter(input.repo_id, input.storage_name);
    invariant(meter, 'git_meter_missing', 'The canonical meter is unavailable.', 404);
    const key = `pending:git-renew:${meter.id}`;
    const pending = await this.store.get<Pending & { renewal_id: string; window: GitFundingWindow; phase: 'preparing' | 'committing' | 'aborting' }>(key);
    if (!pending && (meter.state !== 'stored' || meter.renew_after > now())) return meter;
    if (!pending) meter = await this.gitAccrue({ ...input, through: now() });
    const window = pending?.window ?? { ...storageFundingWindow(now(), null, meter.renewal_policy), renew_after: storageFundingWindow(now(), null, meter.renewal_policy).renew_after! };
    const id = pending?.renewal_id ?? `gren_${await sha256(`${meter.id}:${window.commitment_until}`)}`;
    const command = pending ?? { action: 'git-renew', body: input, renewal_id: id, window, phase: 'preparing' as const };
    const target = `capacity:${meter.slice_id}`, payload = { ...input, renewal_id: id, window };
    await this.store.put(key, command);
    if (command.phase === 'preparing') {
      try {
        invariant((await ensureBillingAccount(this.env, meter.account_id)).state === 'active', 'subscription_inactive', 'Continuing canonical retention requires active funding.');
        await activeSlice(this.env, meter.slice_id, true);
        await this.book.prepareGitRenewal(input.repo_id, input.storage_name, id, window);
        await admissionRequest(this.env, target, 'git-renew-prepare', payload);
        command.phase = 'committing'; await this.store.put(key, command);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status >= 500 && error.code !== 'platform_stopped') throw error;
        command.phase = 'aborting'; await this.store.put(key, command);
      }
    }
    if (command.phase === 'aborting') {
      await this.book.abortGitRenewal(input.repo_id, input.storage_name, id);
      await admissionRequest(this.env, target, 'git-renew-abort', payload);
      await this.store.delete(key);
      return this.book.gitFundingFailure(input.repo_id, input.storage_name);
    }
    await admissionRequest(this.env, target, 'git-renew-commit', payload);
    await this.book.commitGitRenewal(input.repo_id, input.storage_name, id);
    await this.store.delete(key);
    return (await this.book.gitMeter(input.repo_id, input.storage_name))!;
  }

  private async gitPurge(input: { repo_id: string; storage_name: string }): Promise<CanonicalGitMeter> {
    const proof = await canonicalPurgeReceipt(this.env, input.repo_id, input.storage_name);
    invariant(proof, 'git_purge_unverified', 'Only a verified native purge receipt can release retained canonical exposure.');
    const meter = await this.book.gitMeter(input.repo_id, input.storage_name);
    invariant(meter, 'git_meter_missing', 'Canonical storage has no retained meter.', 404);
    if (this.isAccount()) {
      if (await this.store.get(`pending:git-renew:${meter.id}`)) await this.gitRenew(input);
      await this.store.put(`pending:git-purge:${meter.id}`, { action: 'git-purge', body: input });
      await admissionRequest(this.env, `capacity:${meter.slice_id}`, 'git-purge', input);
    }
    const result = await this.book.purgeGit(input.repo_id, input.storage_name, proof.confirmed_at, proof.operation_id);
    if (this.isAccount()) await this.store.delete(`pending:git-purge:${meter.id}`);
    return result;
  }

  private async cancel(input: { account_id: string; reservation_id: string; fence: string; request_hash?: string; quote?: ExecutionQuote }): Promise<Reservation> {
    identitySchema.parse(input);
    const r = await this.book.cancel(input.reservation_id, input.fence, input.quote && input.request_hash ? { quote: input.quote, request_hash: input.request_hash } : undefined);
    this.assertAccount(input.account_id, r);
    if (this.isAccount()) {
      const body = { ...this.identity(r), quote: r.quote, request_hash: r.request_hash };
      await this.store.put(`pending:cancel:${r.id}`, { action: 'cancel', body });
      await this.remote(r, 'cancel', body);
      await this.store.delete(`pending:cancel:${r.id}`);
      await this.store.delete(`pending:reserve:${r.id}`);
    }
    return r;
  }

  private async settle(input: SettleExecutionInput): Promise<Reservation> {
    const prior = await this.book.reservation(input.reservation_id);
    this.assertAccount(input.account_id, prior);
    if (this.isAccount()) await this.store.put(`pending:settle:${prior.id}`, { action: 'settle', body: input });
    const r = await this.book.settle(input, await sha256(JSON.stringify(input)));
    if (this.isAccount()) {
      await this.remote(r, 'settle', input);
      await this.store.delete(`pending:settle:${r.id}`);
      await this.store.delete(`pending:start:${r.id}`);
    }
    return r;
  }

  private async storageReserve(input: ReserveStorageInput): Promise<StorageObject> {
    const r = await this.book.reservation(input.reservation_id);
    this.assertAccount(input.account_id, r);
    const scoped = input.key.startsWith(`${input.account_id}/${r.quote.attribution.repo_id}/`)
      || input.key.startsWith(`execution/${input.account_id}/${r.quote.attribution.repo_id}/${r.quote.attribution.run_id}/${r.quote.attribution.attempt_id}/`)
      || (input.bucket === 'snapshots' && input.object_id.startsWith('sdk_') && /^backups\/[a-f0-9-]{36}\/(data\.sqsh|meta\.json)$/.test(input.key));
    invariant(scoped && input.key.length <= 1024
      && !/[\u0000-\u001f]/.test(input.key), 'storage_key_scope', 'Storage keys must be immutable and account/repository scoped.', 422);
    const object = await this.book.reserveObject(input);
    if (this.isAccount()) {
      await this.env.DB.prepare('INSERT OR IGNORE INTO billing_storage_keys (bucket,object_key,account_id,object_id,reservation_id) VALUES (?,?,?,?,?)')
        .bind(input.bucket, input.key, input.account_id, input.object_id, input.reservation_id).run();
      const owner = await one<{ account_id: string; object_id: string; reservation_id: string }>(this.env.DB,
        'SELECT account_id,object_id,reservation_id FROM billing_storage_keys WHERE bucket=? AND object_key=?', input.bucket, input.key);
      invariant(owner?.account_id === input.account_id && owner.object_id === input.object_id && owner.reservation_id === input.reservation_id,
        'immutable_object_key', 'This storage key belongs to a different immutable upload.');
      await this.store.put(`pending:object:${object.id}`, { action: 'storage-reserve', body: input });
      await this.remote(r, 'storage-reserve', input);
      await this.store.delete(`pending:object:${object.id}`);
    }
    return object;
  }

  private async storageCommit(input: CommitStorageInput): Promise<StorageObject> {
    const object = await this.book.object(input.object_id);
    invariant(object.account_id === input.account_id && object.reservation_id === input.reservation_id && object.fence === input.fence,
      'storage_not_found', 'The scoped storage reservation was not found.', 404);
    if (this.isAccount() && object.state === 'uploading') {
      const head = await headStorageObject(this.env, object);
      invariant(head && String(head.size) === input.bytes && head.etag === input.etag, 'upload_unverified', 'Uploaded bytes must be verified in object storage before committing their meter.');
      invariant(head.checksum === null || head.checksum === input.checksum, 'upload_unverified', 'The stored checksum does not match the metering receipt.');
      input = { ...input, uploaded_at: head.uploaded.toISOString() };
    }
    if (this.isAccount()) {
      await this.store.put(`pending:commit:${object.id}`, { action: 'storage-commit', body: input });
      await this.objectRemote(object, 'storage-commit', input);
    }
    const result = await this.book.commitObject(input);
    if (this.isAccount()) await this.store.delete(`pending:commit:${object.id}`);
    return result;
  }

  private async storageAccrue(input: { object_id: string; through: string }): Promise<StorageObject> {
    const object = await this.book.object(input.object_id);
    if (this.isAccount()) await this.objectRemote(object, 'storage-accrue', input);
    return this.book.accrueObject(object.id, input.through);
  }

  private async storageDelete(input: { object_id: string; confirmed_at?: string }): Promise<StorageObject> {
    let current = await this.book.object(input.object_id);
    if (current.state === 'deleted') return current;
    if (current.state === 'transferred' && current.destination_account_id) return admissionRequest(this.env, `account:${current.destination_account_id}`, 'storage-delete', { object_id: current.id });
    if (this.isAccount() && current.source === 'standalone' && current.state === 'uploading') return this.abortStandalone(current);
    if (!this.isAccount()) {
      const object = await this.book.beginDelete(input.object_id);
      invariant(input.confirmed_at, 'deletion_unverified', 'A physical-deletion observation is required.', 422);
      return this.book.accrueObject(object.id, input.confirmed_at, true);
    }
    const object = await this.book.beginDelete(input.object_id);
    const previous = await this.store.get<Pending>(`pending:delete:${object.id}`);
    const saved = previous?.body as { object_id: string; confirmed_at: string } | undefined;
    const proof = saved ?? { object_id: object.id, confirmed_at: await deletePhysicalStorage(this.env, object) };
    await this.store.put(`pending:delete:${object.id}`, { action: 'storage-delete', body: proof });
    if (current.pending_renewal) {
      const renewalId = current.pending_renewal.id;
      await this.book.finishRenewal(current.id, renewalId, false);
      await this.objectRemote(current, 'renewal-abort', { object_id: current.id, renewal_id: renewalId });
      current = await this.book.object(current.id);
    }
    await this.objectRemote(object, 'storage-begin-delete', { object_id: object.id });
    const participant = await this.objectRemote<StorageObject>(object, 'storage-delete', proof);
    invariant(participant.state === 'deleted', 'storage_settlement_pending', 'Physical deletion is verified; financial settlement is still reconciling.', 503);
    const result = await this.book.accrueObject(object.id, proof.confirmed_at, true);
    await this.store.delete(`pending:delete:${object.id}`);
    return result;
  }

  private async storageExpire(id: string): Promise<StorageObject> {
    return this.book.requestStorageDeletion(id);
  }

  private async cancelStorageIntent(input: CancelStorageIntentInput): Promise<StorageIntentCancellation> {
    invariant(this.isAccount() && this.target === `account:${input.account_id}`, 'storage_scope', 'Only the account authority cancels this storage intent.', 403);
    const locator = await resolveResourceLocator(this.env, input.object_id, 'object');
    invariant(locator && (input.repo_id === undefined || input.repo_id === locator.repo_id), 'storage_locator_changed', 'The object locator could not be verified.', 409);
    const manifest = await billingMetadata<BillingManifest>(this.env, { account_id: input.account_id, repo_id: locator.repo_id, object_id: input.object_id });
    invariant(manifest && manifest.state === 'deleting' && manifest.reference_count === 0
      && (manifest.upload_generation === 0 || manifest.upload_failure === 'input_incomplete'),
    'upload_termination_required', 'A primary deleting fence and unused or definitively failed generation are required.');
    const receipt = await this.book.cancelStorageIntent({ id: manifest.id, account_id: manifest.account_id, repo_id: manifest.repo_id,
      key: manifest.object_key, bucket: manifest.bucket, source: 'standalone' });
    if (receipt.state === 'cancelled') return receipt;
    await this.store.put(`pending:cancel-intent:${manifest.id}`, { action: 'storage-cancel-intent', body: input });
    const object = await this.store.get<StorageObject>(`object:${manifest.id}`);
    if (object) {
      if (object.state === 'uploading') {
        const head = await headStorageObject(this.env, object);
        if (head) {
          await this.storageCommit({ account_id: object.account_id, reservation_id: object.reservation_id, fence: object.fence,
            object_id: object.id, bytes: String(head.size), etag: head.etag, checksum: manifest.sha256 });
          await this.storageDelete({ object_id: object.id });
        } else {
          await this.objectRemote(object, 'standalone-cancel', standaloneTerms(object));
          await this.book.abortUnuploadedObject(object.id, object.fence, `manifest-fence:${manifest.id}:${manifest.revision}:${manifest.upload_generation}`);
        }
      } else if (object.state !== 'deleted') await this.storageDelete({ object_id: object.id });
    } else {
      const repository = manifest.repo_id ? await billingMetadata<Repository>(this.env, { repo_id: manifest.repo_id }) : null;
      const head = await headStorageObject(this.env, { id: manifest.id, account_id: manifest.account_id, key: manifest.object_key,
        bucket: manifest.bucket, storage_cell_id: repository?.cell_id ?? this.env.CELL_ID });
      invariant(!head, 'storage_reconciliation_required', 'Unmetered physical bytes require reconciliation; the intent remains fenced.', 503);
    }
    const result = await this.book.completeStorageIntentCancellation(manifest.id);
    await this.store.delete(`pending:cancel-intent:${manifest.id}`);
    await this.store.delete(`pending:standalone:${manifest.id}`);
    return result;
  }

  private identity(r: Reservation): { account_id: string; reservation_id: string; fence: string } {
    return { account_id: r.quote.attribution.account_id, reservation_id: r.id, fence: r.fence };
  }

  private async objectRemote<T = unknown>(object: StorageObject, action: string, body: unknown): Promise<T> {
    const sliceId = object.slice_id ?? (await this.book.reservation(object.reservation_id)).quote.slice_id;
    const payload = { ...(body as Record<string, unknown>), object_id: object.platform_object_id ?? object.id,
      account_id: object.account_id, reservation_id: object.reservation_id, fence: object.fence };
    return admissionRequest<T>(this.env, `capacity:${sliceId}`, action, payload);
  }

  private async checkObjectFence(action: string, raw: unknown): Promise<void> {
    if (['standalone-reserve', 'transfer-in', 'standalone-cancel', 'transfer-abort-in'].includes(action) || !raw || typeof raw !== 'object') return;
    const value = raw as { object_id?: string; account_id?: string; fence?: string };
    if (!value.object_id || !value.fence || !value.account_id) return;
    const object = await this.store.get<StorageObject>(`object:${value.object_id}`);
    if (object) invariant(object.account_id === value.account_id && object.fence === value.fence, 'storage_fenced', 'The physical storage ownership fence changed.');
  }

  private async standaloneReserve(raw: unknown): Promise<StorageObject> {
    if (!this.isAccount()) {
      const terms = raw as StandaloneStorageTerms;
      invariant(terms?.slice_id && this.target === `capacity:${terms.slice_id}`, 'storage_scope', 'Storage slice mismatch.', 404);
      await activeSlice(this.env, terms.slice_id);
      return this.book.reserveStandalone(terms);
    }
    const input = standaloneStorageSchema.parse(raw);
    invariant(this.target === `account:${input.account_id}`, 'storage_scope', 'Storage account mismatch.', 404);
    const existing = await this.store.get<StorageObject>(`object:${input.object_id}`);
    const terms = existing ? standaloneTerms(existing) : await quoteStandaloneStorage(this.env, input);
    invariant(terms.request_hash === await sha256(canonicalJson({ ...input, repo_id: input.repo_id ?? null })),
      'storage_conflict', 'The object ID has a different immutable admission request.');
    let object = await this.book.reserveStandalone(terms);
    invariant(object.admission_state !== 'cancelled', 'storage_cancelled', 'This storage reservation was cancelled.');
    if (object.admission_state === 'ready') return object;
    await this.store.put(`pending:standalone:${object.id}`, { action: 'standalone-reserve', body: input });
    try {
      await this.claimStorageKey(object);
      await this.objectRemote(object, 'standalone-reserve', terms);
      await this.objectRemote(object, 'standalone-commit', { object_id: object.id, fence: object.fence });
      object = await this.book.commitStandaloneAdmission(object.id, object.fence);
      await this.store.delete(`pending:standalone:${object.id}`);
      return object;
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) {
        await this.book.cancelStandalone(terms);
        await this.store.put(`pending:standalone-cancel:${object.id}`, { action: 'standalone-cancel', body: terms });
        await this.objectRemote(object, 'standalone-cancel', terms);
        await this.store.delete(`pending:standalone-cancel:${object.id}`);
        await this.store.delete(`pending:standalone:${object.id}`);
      }
      throw error;
    }
  }

  private async standaloneCancel(terms: StandaloneStorageTerms): Promise<unknown> {
    const result = await this.book.cancelStandalone(terms, !this.isAccount());
    if (this.isAccount()) {
      const object = await this.book.object(terms.input.object_id);
      await this.objectRemote(object, 'standalone-cancel', terms);
      await this.store.delete(`pending:standalone-cancel:${object.id}`);
      await this.store.delete(`pending:standalone:${object.id}`);
    }
    return result;
  }

  private async transferOut(input: { object_id: string; operation_id: string }): Promise<StorageObject> {
    const handoff = await verifyStorageHandoff(this.env, input.operation_id, 'prepare');
    const object = await this.book.object(input.object_id);
    invariant(object.account_id === handoff.from_account_id && object.attribution.repo_id === handoff.repo_id, 'transfer_scope', 'Storage is outside this repository handoff.');
    if (this.isAccount()) {
      await this.storageAccrue({ object_id: object.id, through: now() });
      await this.objectRemote(object, 'transfer-out', input);
    }
    return this.book.fenceStorageTransfer(object.id, input.operation_id, handoff.to_account_id);
  }

  private async transferIn(input: { object_id: string; operation_id: string; terms?: StandaloneStorageTerms; imported?: StorageImport }): Promise<StorageObject> {
    const handoff = await verifyStorageHandoff(this.env, input.operation_id, 'prepare');
    if (!this.isAccount()) {
      invariant(input.terms && input.imported && this.target === `capacity:${input.terms.slice_id}`, 'transfer_scope', 'The imported operating-cost slice is invalid.');
      const imported = { ...input.imported, reuse_physical_quota: input.imported.source_slice_id === input.terms.slice_id };
      const terms = { ...input.terms, input: { ...input.terms.input, object_id: input.imported.platform_object_id } };
      return this.book.reserveStandalone(terms, imported);
    }
    invariant(this.target === `account:${handoff.to_account_id}`, 'transfer_scope', 'The storage receiver is incorrect.');
    const source = await admissionRequest<StorageObject>(this.env, `account:${handoff.from_account_id}`, 'get-object', { object_id: input.object_id });
    invariant(source.state === 'transferring' && source.transfer_operation_id === handoff.operation_id && source.destination_account_id === handoff.to_account_id,
      'transfer_source_not_fenced', 'The former owner must fence storage before the receiver reserves it.');
    const existing = await this.store.get<StorageObject>(`object:${input.object_id}`);
    let object: StorageObject, terms: StandaloneStorageTerms;
    if (existing?.import_source?.operation_id === handoff.operation_id) { object = existing; terms = standaloneTerms(existing); }
    else {
      const head = await headStorageObject(this.env, source);
      invariant(head && String(head.size) === source.bytes && head.etag === source.etag && source.checksum, 'transfer_object_unverified', 'The retained object must be physically verified before handoff.');
      terms = await quoteStandaloneStorage(this.env, { account_id: handoff.to_account_id, repo_id: handoff.repo_id, actor_id: handoff.actor_id,
        object_id: source.id, key: source.key, bucket: source.bucket, maximum_bytes: source.bytes, retention_until: source.retention_until }, { operation_id: handoff.operation_id, source });
      const imported: StorageImport = { operation_id: handoff.operation_id, source_account_id: handoff.from_account_id, source_object_id: source.id,
        source_platform_object_id: source.platform_object_id ?? source.id, source_slice_id: source.slice_id!,
        platform_object_id: `pobj_${await sha256(`${handoff.operation_id}:${source.id}`)}`, etag: head.etag, checksum: source.checksum };
      object = await this.book.reserveStandalone(terms, imported);
    }
    invariant(object.state === 'transfer_pending', 'transfer_import_cancelled', 'The receiving storage reservation is no longer pending.');
    await this.objectRemote(object, 'transfer-in', { object_id: object.id, operation_id: handoff.operation_id, terms, imported: object.import_source });
    await this.objectRemote(object, 'standalone-commit', { object_id: object.id, fence: object.fence });
    return this.book.commitStandaloneAdmission(object.id, object.fence);
  }

  private async transferActivate(input: { object_id: string; operation_id: string; effective_at: string }): Promise<StorageObject> {
    const handoff = await verifyStorageHandoff(this.env, input.operation_id, 'commit');
    const object = await this.book.object(input.object_id);
    invariant(object.account_id === handoff.to_account_id && handoff.effective_at === input.effective_at, 'transfer_scope', 'The receiving consumption boundary is not committed.');
    if (this.isAccount()) await this.objectRemote(object, 'transfer-activate', input);
    return this.book.activateStorageImport(object.id, input.operation_id, input.effective_at);
  }

  private async transferSettle(input: { object_id: string; operation_id: string; effective_at: string }): Promise<StorageObject> {
    const handoff = await verifyStorageHandoff(this.env, input.operation_id, 'commit');
    const object = await this.book.object(input.object_id);
    invariant(object.account_id === handoff.from_account_id && handoff.effective_at === input.effective_at, 'transfer_scope', 'The former owner settlement boundary is invalid.');
    if (this.isAccount()) await this.objectRemote(object, 'transfer-settle', input);
    return this.book.accrueObject(object.id, input.effective_at, false, input.operation_id);
  }

  private async transferAbortIn(input: { object_id: string; operation_id: string }): Promise<unknown> {
    await verifyStorageHandoff(this.env, input.operation_id, 'abort');
    const object = await this.store.get<StorageObject>(`object:${input.object_id}`);
    const result = await this.book.abortStorageImport(input.object_id, input.operation_id);
    if (this.isAccount() && object?.import_source?.operation_id === input.operation_id) await this.objectRemote(object, 'transfer-abort-in', input);
    return result;
  }

  private async transferResume(input: { object_id: string; operation_id: string }): Promise<StorageObject> {
    await verifyStorageHandoff(this.env, input.operation_id, 'abort');
    const object = await this.book.object(input.object_id);
    if (this.isAccount()) await this.objectRemote(object, 'transfer-resume', input);
    return this.book.resumeStorageOwner(input.object_id, input.operation_id);
  }

  private async claimStorageKey(object: StorageObject): Promise<void> {
    await this.env.DB.prepare('INSERT OR IGNORE INTO billing_storage_keys (bucket,object_key,account_id,object_id,reservation_id) VALUES (?,?,?,?,?)')
      .bind(object.bucket, object.key, object.account_id, object.id, object.reservation_id).run();
    const owner = await one<{ account_id: string; object_id: string; reservation_id: string }>(this.env.DB,
      'SELECT account_id,object_id,reservation_id FROM billing_storage_keys WHERE bucket=? AND object_key=?', object.bucket, object.key);
    invariant(owner?.account_id === object.account_id && owner.object_id === object.id && owner.reservation_id === object.reservation_id,
      'immutable_object_key', 'This key belongs to another immutable object.');
  }

  private async abortStandalone(object: StorageObject): Promise<StorageObject> {
    const manifest = await billingMetadata<BillingManifest>(this.env, { repo_id: object.attribution.repo_id, account_id: object.account_id, object_id: object.id });
    const receiptMatches = manifest?.billing_reservation_id === object.reservation_id && manifest?.billing_fence === object.fence;
    const neverAdmitted = manifest?.upload_generation === 0 && manifest.billing_reservation_id === null && manifest.billing_fence === null;
    invariant(manifest && manifest.state === 'deleting' && manifest.reference_count === 0 && manifest.object_key === object.key
      && manifest.repo_id === object.attribution.repo_id && (receiptMatches || neverAdmitted)
      && (manifest.upload_generation === 0 || manifest.upload_failure === 'input_incomplete'),
    'upload_termination_required', 'Only a primary-fenced, never-started or provably invalid upload can release an unused reservation.');
    const head = await headStorageObject(this.env, object);
    if (head) {
      invariant(String(head.size) === String(manifest.bytes), 'upload_reconciliation_required', 'Unexpected stored bytes require upload reconciliation.');
      await this.storageCommit({ account_id: object.account_id, reservation_id: object.reservation_id, fence: object.fence,
        object_id: object.id, bytes: String(head.size), etag: head.etag, checksum: manifest.sha256 });
      return this.storageDelete({ object_id: object.id });
    }
    const receipt = `manifest-fence:${manifest.id}:${manifest.revision}:${manifest.upload_generation}`;
    await this.store.put(`pending:abort:${object.id}`, { action: 'storage-delete', body: { object_id: object.id } });
    await this.objectRemote(object, 'storage-abort', { object_id: object.id, fence: object.fence, receipt });
    const result = await this.book.abortUnuploadedObject(object.id, object.fence, receipt);
    await this.store.delete(`pending:abort:${object.id}`);
    return result;
  }

  private async storageRenew(id: string): Promise<StorageObject> {
    invariant(this.isAccount(), 'storage_scope', 'Only the owning account coordinates storage renewal.', 403);
    let object = await this.book.object(id);
    if (object.source !== 'standalone' || object.state !== 'stored' || (!object.pending_renewal && (!object.renew_after || object.renew_after > now()))) return object;
    await this.storageAccrue({ object_id: id, through: now() });
    object = await this.book.object(id);
    const window = object.pending_renewal ?? storageFundingWindow(now(), object.retention_until, object.renewal_policy!);
    const renewal = { id: object.pending_renewal?.id ?? `renew_${await sha256(`${object.account_id}:${id}:${window.commitment_until}`)}`,
      funded_until: window.funded_until, commitment_until: window.commitment_until, renew_after: window.renew_after };
    try {
      await activeSlice(this.env, object.slice_id!, true);
      await this.book.prepareRenewal(id, renewal);
      await this.store.put(`pending:renew:${id}`, { action: 'storage-renew', body: { object_id: id } });
      await this.objectRemote(object, 'renewal-prepare', { object_id: id, renewal });
      await this.objectRemote(object, 'renewal-commit', { object_id: id, renewal_id: renewal.id });
      const renewed = await this.book.finishRenewal(id, renewal.id, true);
      await this.store.delete(`pending:renew:${id}`);
      return renewed;
    } catch (error) {
      if (error instanceof ApiError && (error.status < 500 || error.code === 'platform_stopped')) {
        const current = await this.book.object(id);
        if (current.pending_renewal?.id === renewal.id) {
          await this.book.finishRenewal(id, renewal.id, false);
          await this.objectRemote(object, 'renewal-abort', { object_id: id, renewal_id: renewal.id });
        }
        await this.store.delete(`pending:renew:${id}`);
        return this.book.fundingFailure(id);
      }
      await this.book.fundingFailure(id);
      throw error;
    }
  }


  private assertAccount(accountId: string, r: Reservation): void {
    invariant(r.quote.attribution.account_id === accountId && (!this.isAccount() || this.target === `account:${accountId}`),
      'reservation_not_found', 'Reservation not found.', 404);
  }

  private async assertCurrent(quote: ExecutionQuote): Promise<void> {
    const a = quote.attribution;
    if (this.isAccount()) invariant(this.target === `account:${a.account_id}`, 'admission_scope', 'The billing account is incorrect.', 404);
    else invariant(this.target === `capacity:${quote.slice_id}`, 'admission_scope', 'The operating slice is incorrect.', 404);
    await activeSlice(this.env, quote.slice_id);
    const account = await one<{ state: string }>(this.env.DB, 'SELECT state FROM billing_accounts WHERE account_id=?', a.account_id);
    invariant(account?.state === 'active', 'subscription_inactive', 'The subscription does not permit new paid work.');
    const repository = await billingMetadata<Repository>(this.env, { repo_id: a.repo_id });
    invariant(repository?.owner_id === a.account_id && repository.state === 'active' && repository.routing_epoch === quote.routing_epoch,
      'billing_owner_changed', 'Ownership or placement changed; replan before allocating work.');
  }

  private remote<T = unknown>(r: Reservation, action: string, body: unknown): Promise<T> {
    return admissionRequest<T>(this.env, `capacity:${r.quote.slice_id}`, action, body);
  }

  private async flush(): Promise<void> {
    await flushBillingJournal(this.env.DB, this.store);
  }

  private async stopOverdueRuntimes(): Promise<void> {
    const active = await this.store.list<string>({ prefix: 'active:', limit: 10_000 });
    for (const id of active.values()) {
      const r = await this.book.reservation(id);
      if (!r.deadline_at || r.deadline_at > now() || !['starting', 'running'].includes(r.state)) continue;
      const { control } = await this.book.snapshot();
      if (control.stopped) return;
      await this.book.setStop(true, `Runtime ${r.runtime_id} exceeded its deadline without verified termination. Financial holds remain active.`, control.revision);
      return;
    }
  }

  private async closePeriod(through: string): Promise<{ closed: true }> {
    await this.flush();
    const { control } = await this.book.snapshot();
    const placing = await one(this.env.DB, `SELECT operation_id FROM billing_storage_placements WHERE account_id=? AND state NOT IN ('complete','aborted')
      AND json_extract(body_json,'$.created_at')<? LIMIT 1`, control.account_id, through);
    invariant(!placing, 'unsettled_physical_placement', 'Reconcile the physical duplication before closing this invoice period.');
    const unsettled = await one(this.env.DB, `SELECT id FROM billing_reservations WHERE coordinator_id=?
      AND created_at<? AND state IN ('preparing','prepared','reserved','starting','running') LIMIT 1`, this.target, through);
    invariant(!unsettled, 'unsettled_usage', 'Settle earlier execution before closing its invoice period.');
    const storage = await one(this.env.DB, `SELECT id FROM billing_storage_objects WHERE coordinator_id=? AND state NOT IN ('deleted','transferred')
      AND json_extract(body_json,'$.created_at')<? AND (state IN ('uploading','transfer_pending','transferring') OR accrued_at<?
        OR json_type(body_json,'$.pending_renewal')='object') LIMIT 1`, this.target, through, through);
    invariant(!storage, 'unsettled_storage', 'Accrue retained storage and reconcile incomplete uploads before closing this invoice period.');
    const git = await one(this.env.DB, `SELECT reservation_id AS id FROM billing_git_operations WHERE coordinator_id=? AND state IN ('prepared','reserved')
      AND json_extract(body_json,'$.created_at')<? UNION ALL SELECT id FROM billing_git_repositories WHERE coordinator_id=?
      AND json_extract(body_json,'$.state') NOT IN ('purged','transferred') AND (accrued_at<? OR json_type(body_json,'$.pending_renewal')='object') LIMIT 1`, this.target, through, this.target, through);
    invariant(!git, 'unsettled_git_storage', 'Reconcile canonical publications and accrue their retained storage before closing the period.');
    await this.book.closePeriod(through, control.revision);
    return { closed: true };
  }

  private async stopOverdueGit(): Promise<void> {
    const helpers = await this.store.list<string>({ prefix: 'helper-active:', limit: 10000 });
    const operations = await this.store.list<string>({ prefix: 'git-active:', limit: 10000 });
    let overdue = false;
    for (const id of helpers.values()) {
      const helper = await this.book.helperReservation(id);
      if (Date.parse(helper.created_at) + helper.input.maximum_duration_ms <= Date.now()) { overdue = true; break; }
    }
    let uncertain = false;
    for (const id of operations.values()) if ((await this.book.gitOperation(id)).commitment_until <= now()) { uncertain = true; break; }
    if (!overdue && !uncertain) return;
    const { control } = await this.book.snapshot();
    if (!control.stopped) await this.book.setStop(true, 'Git allocation exceeded its funded bound without a verified outcome. Financial holds remain active.', control.revision);
  }

  private async rollover(start: string, end: string): Promise<{ renewed: true }> {
    invariant(this.isAccount(), 'period_scope', 'Only accounts have subscription periods.');
    const account = await ensureBillingAccount(this.env, this.target!.slice('account:'.length));
    const receipt = await one<{ period_start: string; fixed_cost_units: string }>(this.env.DB,
      'SELECT period_start,fixed_cost_units FROM billing_invoice_finalizations WHERE account_id=? AND next_period_start=? AND next_period_end=?', account.account_id, start, end);
    invariant(receipt, 'period_finalization_missing', 'The new period requires its committed invoice finalization.');
    const recurring = await subscriptionCommitmentUnits(this.env.DB, account, await getPlan(this.env.DB, account.plan_id));
    await this.book.rolloverPeriod(start, end, recurring, { id: `subscription:${receipt.period_start}`, amount_units: receipt.fixed_cost_units });
    return { renewed: true };
  }
}
