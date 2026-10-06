import { DurableObject } from 'cloudflare:workers';
import { ApiError, canonicalJson, now, readBounded, sha256 } from '@gitknot/core';
import { grantDigest, signRemoteStatus, verifyRemoteRequest } from '@gitknot/execution/remote/protocol';
import type { RemoteAttemptGrant, RemoteCompletion, RemoteRuntimeStatus, RemoteStoredObject, SignedRemoteStatus } from '@gitknot/execution/remote/protocol';
import { RemoteCallbacks } from './callback.ts';
import { CallbackOutbox, normalizeDraft } from './outbox.ts';
import type { DurableAction } from './outbox.ts';
import { bounded, fenced, hostedError } from './errors.ts';
import { ATTEMPT_KEY, LIMITS } from './types.ts';
import type { AttemptJournal, CompletionDraft, HostedEnv, HostedWorkflowParams, RuntimeFacts, RuntimeIdentity } from './types.ts';
import { controlSchema, requireBindings, requireProfile, validateGrant } from './validation.ts';

interface ReaperPointer extends HostedWorkflowParams { runtime_name: string }
interface LogEntry { sequence: number; sha256: string; data_base64?: string; size_bytes: number }
const registryPrefix = 'hosted:reaper:';

export function attemptController(env: HostedEnv, attemptId: string) {
  return env.HOSTED_ATTEMPTS.get(env.HOSTED_ATTEMPTS.idFromName(attemptId));
}

export function runtimeIdentity(env: HostedEnv, grant: RemoteAttemptGrant, digest: string): RuntimeIdentity {
  return { attempt_id: grant.attempt_id, generation: grant.generation, grant_digest: digest,
    executor_id: grant.executor_id, producer_id: grant.producer_id, runtime_name: grant.runtime_name, runtime_id: grant.runtime_id,
    sandbox_id: env.SANDBOX.idFromName(grant.runtime_name).toString(), deadline_at: grant.deadline_at };
}

function registry(env: HostedEnv, digest: string) {
  return env.HOSTED_ATTEMPTS.get(env.HOSTED_ATTEMPTS.idFromName(`hosted-reaper-${digest[0]}`));
}

/** Durable acceptance, one-shot execution, sanitized outbox and recovery journal. */
export class RemoteAttemptController extends DurableObject<HostedEnv> {
  private outbox: CallbackOutbox | null = null;
  private workflowCreation: Promise<void> | null = null;
  private reconciliation: Promise<boolean> | null = null;

  private read(): AttemptJournal {
    const state = this.ctx.storage.kv.get<AttemptJournal>(ATTEMPT_KEY);
    if (!state) throw new ApiError(404, 'attempt_not_found', 'This hosted attempt has not been accepted.');
    return state;
  }
  private async update(values: Partial<AttemptJournal>): Promise<AttemptJournal> {
    const state = { ...this.read(), ...values };
    this.ctx.storage.kv.put(ATTEMPT_KEY, state);
    await this.ctx.storage.sync();
    return state;
  }
  private identify(params: HostedWorkflowParams): AttemptJournal {
    const state = this.read();
    if (state.grant.attempt_id !== params.attempt_id || state.grant.generation !== params.generation || state.grant_digest !== params.grant_digest) throw fenced();
    return state;
  }
  private callbacks(): CallbackOutbox {
    return this.outbox ??= new CallbackOutbox(this.ctx.storage, new RemoteCallbacks(this.env, this.read().grant));
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await verifyRemoteRequest(request, this.env.HOSTED_CONTROL_KEY);
      const url = new URL(request.url), match = /^\/internal\/hosted\/attempts\/([A-Za-z0-9_-]{1,128})\/(accept|status|cancel)$/.exec(url.pathname);
      if (request.method !== 'POST' || !match || url.search || this.env.HOSTED_ATTEMPTS.idFromName(match[1]!).toString() !== this.ctx.id.toString()) {
        throw new ApiError(404, 'not_found', 'The hosted operation was not found.');
      }
      const data = JSON.parse(new TextDecoder().decode(await readBounded(request.body, LIMITS.grant_bytes)));
      await this.consumeNonce(request);
      if (match[2] === 'accept') return Response.json(await this.accept(await validateGrant(data, this.env), match[1]!), { status: 202, headers: { 'cache-control': 'no-store' } });
      const body = controlSchema.safeParse(data);
      if (!body.success) throw new ApiError(422, 'invalid_remote_control', 'The hosted control request is invalid.');
      this.identify({ attempt_id: match[1]!, ...body.data });
      if (match[2] === 'cancel') {
        await this.close('cancelled');
        // The caller may hold its attempt controller while awaiting this reply.
        // Physical cleanup can finish independently; callback delivery is alarm-
        // driven so it never waits back on that same control-plane controller.
        try { await this.destroyRuntime(); } catch { /* Signed status retains uncertain cleanup. */ }
      }
      return Response.json(await this.status(body.data.challenge), { headers: { 'cache-control': 'no-store' } });
    } catch (error) { return hostedError(error); }
  }

  private async consumeNonce(request: Request): Promise<void> {
    const key = `hosted:nonce:${request.headers.get('x-gitknot-internal-nonce')!}`;
    if (this.ctx.storage.kv.get(key)) throw new ApiError(409, 'service_request_replayed', 'This signed control request has already been received.');
    this.ctx.storage.kv.put(key, Date.now() + 120_000);
    for (const [name, expires] of this.ctx.storage.kv.list<number>({ prefix: 'hosted:nonce:' })) if (expires <= Date.now()) this.ctx.storage.kv.delete(name);
    await this.ctx.storage.sync();
  }

  private async accept(grant: RemoteAttemptGrant, attemptId: string): Promise<SignedRemoteStatus> {
    if (grant.attempt_id !== attemptId) throw fenced();
    const digest = await grantDigest(grant), workflowId = `hosted-${await sha256(grant.runtime_id)}`;
    const created = this.ctx.storage.transactionSync(() => {
      const previous = this.ctx.storage.kv.get<AttemptJournal>(ATTEMPT_KEY);
      if (previous) { if (previous.grant_digest !== digest) throw fenced(); return false; }
      requireBindings(this.env); requireProfile(this.env, grant);
      if (Math.min(Date.parse(grant.deadline_at), Date.parse(grant.lease_expires_at)) <= Date.now()) throw fenced();
      this.ctx.storage.kv.put(ATTEMPT_KEY, { grant, grant_digest: digest, workflow_id: workflowId, accepted_at: now(), started_at: null,
        claimed: false, sealed: false, state: 'accepted', lease_expires_at: grant.lease_expires_at, draft: null,
        completed: false, destroyed_delivered: false, next_log: 0 } satisfies AttemptJournal);
      return true;
    });
    if (created) await this.ctx.storage.setAlarm(Math.min(Date.parse(grant.lease_expires_at), Date.now() + 5000));
    await this.ctx.storage.sync();
    // Index is durable before any allocation can occur. Alarms also recover a
    // journal whose Workflow create or index acknowledgement was lost.
    await registry(this.env, digest).register({ attempt_id: grant.attempt_id, generation: grant.generation, grant_digest: digest, runtime_name: grant.runtime_name });
    const state = this.read();
    if (!state.sealed && !state.claimed) await this.ensureWorkflow();
    return this.status(digest);
  }

  private async ensureWorkflow(): Promise<void> {
    if (this.workflowCreation) return this.workflowCreation;
    const state = this.read();
    if (state.sealed || state.claimed || this.ctx.storage.kv.get('hosted:workflow-created')) return;
    if (Math.min(Date.parse(state.grant.deadline_at), Date.parse(state.lease_expires_at)) <= Date.now()) { await this.close('timed_out'); return; }
    const params = { attempt_id: state.grant.attempt_id, generation: state.grant.generation, grant_digest: state.grant_digest };
    const create = (async () => {
      try { await this.env.HOSTED_WORKFLOW.create({ id: state.workflow_id, params }); }
      catch {
        // A lost create response or a duplicate may refer to the same instance.
        // Never choose a replacement ID and never restart an existing Workflow.
        const instance = await this.env.HOSTED_WORKFLOW.get(state.workflow_id);
        const status = await instance.status();
        if (status.status === 'unknown') throw new ApiError(503, 'workflow_unconfirmed', 'Workflow creation has not been confirmed.');
      }
      this.ctx.storage.kv.put('hosted:workflow-created', true);
      await this.ctx.storage.sync();
    })();
    this.workflowCreation = create;
    try { await bounded(create, 15_000); }
    finally { if (this.workflowCreation === create) this.workflowCreation = null; }
  }

  // JSON keeps the frozen plan's arbitrary literal values RPC-serializable.
  // This private RPC result must never be returned from a Workflow step.
  async load(params: HostedWorkflowParams): Promise<string> { return JSON.stringify(this.identify(params)); }

  /** Called only inside the actual SDK source-provider step. No replay grants. */
  async claim(params: HostedWorkflowParams): Promise<boolean> {
    const state = this.identify(params);
    if (state.claimed || state.sealed || Math.min(Date.parse(state.grant.deadline_at), Date.parse(state.lease_expires_at)) <= Date.now()) return false;
    await this.update({ claimed: true, state: 'claiming', started_at: now() });
    await this.ctx.storage.setAlarm(Math.min(Date.parse(state.lease_expires_at), Date.now() + LIMITS.heartbeat_ms));
    return true;
  }

  async renew(params: HostedWorkflowParams, lease: string): Promise<void> {
    const state = this.identify(params), end = Date.parse(lease);
    if (state.sealed || !state.claimed || Date.parse(state.lease_expires_at) <= Date.now() || !Number.isFinite(end)
      || end <= Date.now() || end > Date.parse(state.grant.deadline_at)) throw fenced();
    if (end >= Date.parse(state.lease_expires_at)) await this.update({ lease_expires_at: lease, state: 'running' });
    await this.ctx.storage.setAlarm(Math.min(end, Date.now() + LIMITS.heartbeat_ms));
  }

  async saveDraft(params: HostedWorkflowParams, input: CompletionDraft): Promise<void> {
    const state = this.identify(params), draft = normalizeDraft(input), grant = state.grant;
    if (draft.attempt_id !== grant.attempt_id || draft.generation !== grant.generation || draft.plan_digest !== grant.plan_digest
      || draft.runner_id !== grant.producer_id || draft.toolchain_digest !== grant.job.toolchain.digest
      || draft.outputs.some(output => !Object.hasOwn(grant.job.outputs, output.name))) throw fenced();
    if (state.draft && canonicalJson(state.draft) !== canonicalJson(draft)) throw new ApiError(409, 'completion_replay_mismatch', 'The sanitized completion draft is already durable.');
    if (!state.draft) await this.update({ draft });
  }

  async publish(params: HostedWorkflowParams, action: DurableAction, id: string, payload: Record<string, unknown>): Promise<void> {
    this.identify(params);
    if (action === 'log-manifest') await this.flushLogs();
    await this.callbacks().publish(action, id, payload);
  }

  async publishObject(params: HostedWorkflowParams, action: 'log' | 'output' | 'log-manifest' | 'output-manifest', id: string, payload: Record<string, unknown>): Promise<RemoteStoredObject> {
    this.identify(params);
    if (action === 'log-manifest') await this.flushLogs();
    return this.callbacks().publish<RemoteStoredObject>(action, id, payload);
  }

  async appendLog(params: HostedWorkflowParams, id: string, bytes: Uint8Array): Promise<RemoteStoredObject> {
    const state = this.identify(params);
    if (!bytes.length || bytes.length > LIMITS.chunk_bytes || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(id)) throw new ApiError(422, 'invalid_log_chunk', 'The hosted log chunk is invalid.');
    const sum = await sha256(bytes), key = `hosted:log-key:${id}`;
    let assigned = this.ctx.storage.kv.get<LogEntry>(key);
    if (assigned && assigned.sha256 !== sum) throw new ApiError(409, 'log_replay_mismatch', 'A log chunk changed on replay.');
    if (!assigned) {
      const current = this.read(), total = (this.ctx.storage.kv.get<number>('hosted:log-bytes') ?? 0) + bytes.length;
      if (total > (current.grant.job.limits?.log_bytes ?? LIMITS.log_bytes)) throw new ApiError(413, 'log_quota_exceeded', 'The attempt exhausted its retained log quota.');
      assigned = { sequence: current.next_log, sha256: sum, size_bytes: bytes.length, data_base64: Buffer.from(bytes).toString('base64') };
      this.ctx.storage.kv.put(key, assigned);
      this.ctx.storage.kv.put('hosted:log-bytes', total);
      this.ctx.storage.kv.put(ATTEMPT_KEY, { ...current, next_log: assigned.sequence + 1 });
      await this.ctx.storage.sync();
    }
    if (assigned.sequence > 65535 || state.completed) throw fenced();
    return this.deliverLog(key, { ...assigned, data_base64: assigned.data_base64 ?? Buffer.from(bytes).toString('base64') });
  }

  private async deliverLog(key: string, log: LogEntry): Promise<RemoteStoredObject> {
    const id = `log:${String(log.sequence).padStart(8, '0')}`;
    const previous = this.callbacks().result<RemoteStoredObject>(id);
    if (previous) return previous;
    if (log.data_base64 === undefined) throw new ApiError(503, 'log_journal_incomplete', 'A durable log chunk is unavailable.');
    const result = await this.callbacks().publish<RemoteStoredObject>('log', id, {
      sequence: log.sequence, data_base64: log.data_base64, sha256: log.sha256, size_bytes: log.size_bytes,
    });
    this.ctx.storage.kv.put(key, { sequence: log.sequence, sha256: log.sha256, size_bytes: log.size_bytes } satisfies LogEntry);
    await this.ctx.storage.sync();
    return result;
  }

  async checkpoint(params: HostedWorkflowParams): Promise<RemoteCompletion> {
    this.identify(params);
    const finalized = this.ctx.storage.kv.get<RemoteCompletion>('hosted:completion');
    if (finalized) {
      await this.callbacks().publish('checkpoint', 'receipt:checkpoint', { receipt: finalized });
      return finalized;
    }
    await this.flushLogs();
    await this.callbacks().flushData();
    const manifest = await this.callbacks().publish<RemoteStoredObject>('log-manifest', 'manifest:logs', {});
    const state = this.read();
    if (!state.draft) throw new ApiError(409, 'completion_missing', 'The normalized completion draft is not durable.');
    let stopped = state.draft.process_group_stopped;
    if (!stopped) {
      const identity = runtimeIdentity(this.env, state.grant, state.grant_digest);
      const facts = await this.env.SANDBOX.get(this.env.SANDBOX.idFromName(state.grant.runtime_name)).runtimeStatus(identity);
      stopped = facts.sealed && facts.running === false && facts.in_flight === 0 && facts.ephemeral_objects === 0 && !!facts.receipt_id;
    }
    if (!stopped) throw new ApiError(503, 'process_stop_unconfirmed', 'A completion checkpoint requires observed process termination.');
    const receipt = { ...state.draft, process_group_stopped: stopped, log_manifest_digest: manifest.sha256 };
    this.ctx.storage.kv.put('hosted:completion', receipt);
    await this.ctx.storage.sync();
    await this.callbacks().publish('checkpoint', 'receipt:checkpoint', { receipt });
    return receipt;
  }

  private async flushLogs(): Promise<void> {
    const logs = [...this.ctx.storage.kv.list<LogEntry>({ prefix: 'hosted:log-key:' })].sort((a, b) => a[1].sequence - b[1].sequence);
    for (const [key, log] of logs) await this.deliverLog(key, log);
  }

  async status(challenge: string): Promise<SignedRemoteStatus> {
    const state = this.read(), identity = runtimeIdentity(this.env, state.grant, state.grant_digest);
    let facts: RuntimeFacts | null = null;
    try { facts = await bounded(this.env.SANDBOX.get(this.env.SANDBOX.idFromName(state.grant.runtime_name)).runtimeStatus(identity), 5000); }
    catch { /* Unknown is explicit; it is never a stopped/destroyed assertion. */ }
    const destroyed = facts?.sealed && facts.running === false && facts.in_flight === 0 && facts.ephemeral_objects === 0 && facts.receipt_id && facts.destroyed_at;
    const status: RemoteRuntimeStatus & { producer_id: string; deadline_at: string } = {
      version: 1, ...identity, state: destroyed ? 'destroyed' : state.sealed ? 'stopping' : state.state,
      accepted_at: state.accepted_at, started_at: facts?.started_at ?? state.started_at,
      destroyed_at: destroyed ? facts!.destroyed_at : null, sealed: facts?.sealed ?? state.sealed, running: facts?.running ?? null,
      in_flight: facts?.in_flight ?? 1, ephemeral_objects: facts?.ephemeral_objects ?? 0,
      egress_requests: facts?.egress_requests ?? 0, egress_bytes: facts?.egress_bytes ?? 0,
      receipt_id: destroyed ? facts!.receipt_id : null, challenge,
    };
    return signRemoteStatus(status, this.env.HOSTED_CONTROL_KEY);
  }

  private async close(outcome: CompletionDraft['conclusion']): Promise<void> {
    const state = this.read();
    await this.update({ sealed: true, state: 'stopping' });
    if (!state.draft) {
      const grant = state.grant;
      await this.update({ draft: { attempt_id: grant.attempt_id, generation: grant.generation, plan_digest: grant.plan_digest, runner_id: grant.producer_id,
        conclusion: outcome, exit_code: null, signal: null, resource_exhaustion: null, toolchain_digest: grant.job.toolchain.digest, outputs: [],
        log_manifest_digest: null, process_group_stopped: false, started_at: state.started_at ?? state.accepted_at, finished_at: now() } });
    }
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  async reconcile(): Promise<boolean> {
    if (this.reconciliation) return this.reconciliation;
    const promise = this.doReconcile(); this.reconciliation = promise;
    try { return await promise; }
    finally { if (this.reconciliation === promise) this.reconciliation = null; }
  }

  private async destroyRuntime(): Promise<void> {
    const state = this.read(), identity = runtimeIdentity(this.env, state.grant, state.grant_digest);
    const sandbox = this.env.SANDBOX.get(this.env.SANDBOX.idFromName(state.grant.runtime_name));
    const facts = await bounded(sandbox.sealAndDestroy(identity), LIMITS.cleanup_ms, 'destruction_unverified');
    if (!facts.sealed || facts.running !== false || facts.in_flight || facts.ephemeral_objects || !facts.receipt_id) throw new ApiError(503, 'destruction_unverified', 'The hosted cleanup proof is incomplete.');
    await this.update({ state: 'destroyed' });
  }

  private async doReconcile(): Promise<boolean> {
    let state = this.read();
    if (!state.sealed && Math.min(Date.parse(state.grant.deadline_at), Date.parse(state.lease_expires_at)) <= Date.now()) {
      await this.close(Date.parse(state.grant.deadline_at) <= Date.now() ? 'timed_out' : 'infrastructure_failed');
      state = this.read();
    }
    if (!state.sealed && !state.draft) {
      if (!state.claimed) await this.ensureWorkflow();
      else {
        const workflow = await this.env.HOSTED_WORKFLOW.get(state.workflow_id);
        const status = await workflow.status();
        if (['errored', 'terminated', 'complete'].includes(status.status)) await this.close('infrastructure_failed');
      }
      state = this.read();
      if (!state.sealed && !state.draft) return false;
    }
    await this.update({ sealed: true, state: 'stopping' });
    await this.destroyRuntime();
    const params = { attempt_id: state.grant.attempt_id, generation: state.grant.generation, grant_digest: state.grant_digest };
    // Revocation/expiry cannot block physical cleanup. Results remain fenced by CP.
    if (!this.read().completed && (this.ctx.storage.kv.get('hosted:completion') || Date.parse(state.grant.deadline_at) > Date.now() && Date.parse(state.lease_expires_at) > Date.now())) {
      try {
        const receipt = await this.checkpoint(params);
        await this.callbacks().publish('complete', 'receipt:complete', { receipt });
        await this.update({ completed: true });
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'attempt_fenced') throw error;
        this.ctx.storage.kv.put('hosted:results-fenced', true);
      }
    }
    if (!this.read().destroyed_delivered) {
      await this.callbacks().publish('destroyed', 'receipt:destroyed', {});
      await this.update({ destroyed_delivered: true });
    }
    await this.ctx.storage.deleteAlarm();
    await registry(this.env, state.grant_digest).retire(params);
    return true;
  }

  async alarm(): Promise<void> {
    if (this.ctx.storage.kv.get('hosted:registry')) { await this.reapPage(); return; }
    try { if (await this.reconcile()) return; }
    catch { /* Persist a new alarm: provider automatic retries are finite. */ }
    const state = this.read();
    await this.ctx.storage.setAlarm(state.sealed ? Date.now() + 5000 : Math.min(Date.now() + LIMITS.heartbeat_ms, Date.parse(state.lease_expires_at)));
  }

  async register(pointer: ReaperPointer): Promise<void> {
    if (this.ctx.storage.kv.get(ATTEMPT_KEY) || this.env.HOSTED_ATTEMPTS.idFromName(`hosted-reaper-${pointer.grant_digest[0]}`).toString() !== this.ctx.id.toString()) throw fenced();
    this.ctx.storage.kv.put('hosted:registry', true);
    this.ctx.storage.kv.put(`${registryPrefix}${pointer.attempt_id}`, pointer);
    await this.ctx.storage.setAlarm(Date.now() + LIMITS.heartbeat_ms);
    await this.ctx.storage.sync();
  }

  async retire(params: HostedWorkflowParams): Promise<void> {
    const key = `${registryPrefix}${params.attempt_id}`, pointer = this.ctx.storage.kv.get<ReaperPointer>(key);
    if (pointer && pointer.grant_digest === params.grant_digest && pointer.generation === params.generation) this.ctx.storage.kv.delete(key);
    await this.ctx.storage.sync();
  }

  async reapPage(): Promise<void> {
    const after = this.ctx.storage.kv.get<string>('hosted:reaper-cursor');
    let page = [...this.ctx.storage.kv.list<ReaperPointer>({ prefix: registryPrefix, limit: 16, ...(after ? { startAfter: after } : {}) })];
    if (!page.length && after) page = [...this.ctx.storage.kv.list<ReaperPointer>({ prefix: registryPrefix, limit: 16 })];
    for (let offset = 0; offset < page.length; offset += 4) {
      const batch = page.slice(offset, offset + 4);
      await Promise.all(batch.map(async ([, pointer]) => {
        try { await bounded(attemptController(this.env, pointer.attempt_id).reconcile(), LIMITS.cleanup_ms); }
        catch { /* Each attempt also has its own alarm and remains indexed. */ }
      }));
      this.ctx.storage.kv.put('hosted:reaper-cursor', batch.at(-1)![0]);
      await this.ctx.storage.sync();
    }
    if (page.length) {
      await this.ctx.storage.setAlarm(Date.now() + LIMITS.heartbeat_ms);
    } else await this.ctx.storage.deleteAlarm();
  }
}

export async function reapHosted(env: HostedEnv): Promise<void> {
  for (let offset = 0; offset < LIMITS.reaper_shards; offset += 4) {
    await Promise.all(Array.from({ length: 4 }, (_, index) => registry(env, (offset + index).toString(16)).reapPage()));
  }
}
