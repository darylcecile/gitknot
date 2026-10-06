import { cancelExecutionReservation, reserveExecution, settleExecution, startExecution } from '@gitknot/billing';
import { ApiError, credentialIsCurrent, eventStatement, execute, hmac, many, mutationGuard, newId, now, one, sha256, stmt } from '@gitknot/core';
import type { Bindings, CredentialRecord } from '@gitknot/core';
import { EXECUTION_LIMITS, executionEnabled, requireHostedProfile } from './config.ts';
import { authorizeExecutionActor, fenceExecutionAuthority, fenceMachineAuthority, machineAuthorityStatements } from './authorization.ts';
import { withEnvironmentSecrets } from './environments.ts';
import { assertCurrentReceipt, runnerMatches, TERMINAL_ATTEMPTS } from './state.ts';
import { assertActiveRepository, attemptContext, currentGeneration, guardedBatch, identityPrimary, primary } from './store.ts';
import { bounded, executionRequest } from './transport.ts';
import type { AttemptContext, AttemptIdentity, AttemptRecord, CompletionReceipt, DispatchMessage, ExecutionObject, RunnerPool, RunnerRecord } from './types.ts';
import { dispatchRemoteAttempt, inspectRemoteAttempt, prepareRemoteDispatch, remoteDispatch, verifyRemoteDestruction } from './remote/control.ts';
import { remoteRuntimeId } from './remote/protocol.ts';
import { revokeExecutionCredentials } from './credentials.ts';
import { activateRunnerSlot, closeRunnerSlot, offerRunnerJob, releaseUnassignedRunnerSlot, reserveRunnerSlot } from './runner-slots.ts';
import { runnerAssignment } from './runner-service.ts';
import { loadRunnerAuthority, readRunnerRecord } from './runner-authority.ts';
import { readLocalHostedDraft } from './hosted/checkpoints.ts';

export interface AttemptStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
export interface ReceiptAuth { runner_id: string; generation: number; lease_token: string; machine_token: string }
interface DurableAcceptance { attempt_id: string; generation: number; plan_digest: string; accepted_at: string }
type StopOutcome = 'cancelled' | 'timed_out' | 'failed' | 'infrastructure_failed';
export interface DestructionReceipt { runtime_id: string; attempt_id: string; generation: number; receipt_id: string; destroyed_at: string; running: false; sealed: true; proof_kind?: 'hosted_destroyed' | 'never_allocated' }

/** A controller owns one immutable attempt; no external wait holds the dispatch queue open. */
export class AttemptMachine {
  private serial: Promise<unknown> = Promise.resolve();

  constructor(private readonly env: Bindings, private readonly storage: AttemptStorage) {}

  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.serial.then(fn, fn);
    this.serial = result.catch(() => undefined);
    return result;
  }

  async accept(message: DispatchMessage): Promise<{ accepted: true; generation: number }> {
    const db = primary(this.env);
    const context = await attemptContext(db, message.attempt_id);
    const { attempt } = context;
    if ((message.generation !== undefined && message.generation !== attempt.generation) || (message.run_id && message.run_id !== attempt.run_id)) {
      throw new ApiError(409, 'attempt_fenced', 'The dispatch does not match the immutable attempt.');
    }
    const accepted = await this.storage.get<DurableAcceptance>('accepted');
    if (accepted && (accepted.attempt_id !== attempt.id || accepted.generation !== attempt.generation || accepted.plan_digest !== attempt.plan_digest)) {
      throw new ApiError(409, 'attempt_fenced', 'The controller already owns a different attempt.');
    }
    if (!accepted) await this.storage.put('accepted', { attempt_id: attempt.id, generation: attempt.generation, plan_digest: attempt.plan_digest, accepted_at: now() });
    // Alarm is durable before acknowledgment, including after a lost D1 projection response.
    await this.storage.setAlarm(Date.now() + 1000);
    const at = now();
    await db.batch([
      stmt(db, `UPDATE execution_attempts SET status=CASE WHEN status='queued' THEN 'accepted' ELSE status END,updated_at=?,revision=revision+1 WHERE id=? AND repo_id=? AND generation=?`, at, attempt.id, attempt.repo_id, attempt.generation),
      stmt(db, 'UPDATE execution_dispatches SET accepted_at=COALESCE(accepted_at,?) WHERE attempt_id=? AND repo_id=? AND generation=?', at, attempt.id, attempt.repo_id, attempt.generation),
    ]);
    if (attempt.executor === 'self_hosted' && !TERMINAL_ATTEMPTS.has(attempt.status)) await offerRunnerJob(this.env, attempt);
    return { accepted: true, generation: attempt.generation };
  }

  async tick(attemptId?: string): Promise<void> {
    const accepted = await this.storage.get<DurableAcceptance>('accepted');
    const id = attemptId ?? accepted?.attempt_id;
    if (!id) return;
    const context = await attemptContext(primary(this.env), id);
    const a = context.attempt;
    // Persist the next retry before external calls. Platform alarm retries are bounded;
    // the scheduled D1 reaper supplies independent recovery after those retries stop.
    await this.storage.setAlarm(Date.now() + 15_000);
    if (TERMINAL_ATTEMPTS.has(a.status)) {
      if (a.cleanup_state === 'required' || a.cleanup_state === 'destroying') await this.destroy(context);
      const latest = await attemptContext(primary(this.env), id);
      if (['none', 'verified'].includes(latest.attempt.cleanup_state)) await this.retireAttemptCredentials(latest.attempt);
      await this.settle(await attemptContext(primary(this.env), id));
      if (a.settled_at || (!a.reservation_id && ['none', 'verified'].includes(a.cleanup_state))) await this.storage.deleteAlarm();
      return;
    }
    const deadline = a.deadline_at ? Date.parse(a.deadline_at) : Date.parse(a.queue_deadline_at);
    const expired = deadline <= Date.now() || (a.lease_expires_at !== null && Date.parse(a.lease_expires_at) <= Date.now());
    if (context.run.status === 'cancelling' || a.status === 'cancelling' || expired) {
      const prior = a.status === 'cancelling' ? await this.storage.get<StopOutcome>('cancel_outcome') : undefined;
      const outcome = context.run.status === 'cancelling' ? 'cancelled' : prior ?? (expired ? 'timed_out' : 'cancelled');
      await this.cancel(id, a.status === 'cancelling' ? a.reason ?? 'Termination is being reconciled.' : expired ? 'The whole-job deadline or execution lease expired.' : 'Cancellation requested.', outcome);
      return;
    }
    if (a.executor === 'self_hosted' && ['accepted', 'admitting'].includes(a.status) && !a.runner_id) await offerRunnerJob(this.env, a);
    if (['accepted', 'admitting'].includes(a.status) && (a.executor === 'hosted' || a.runner_id)) {
      try {
        const runner = a.runner_id ? (await loadRunnerAuthority(this.env, a.runner_id)).runner : undefined;
        if (a.executor === 'self_hosted' && !runner) { await this.cancel(a.id, 'The assigned machine is no longer active.'); return; }
        const ready = await this.admit(context, runner ?? undefined);
        if (!ready && a.executor === 'self_hosted' && !a.runtime_id) await execute(primary(this.env), `UPDATE execution_attempts SET status='accepted',runner_id=NULL,runner_credential_generation=NULL WHERE id=? AND repo_id=? AND status='admitting' AND runtime_id IS NULL`, a.id, a.repo_id);
      }
      catch (error) {
        if (error instanceof ApiError && error.status < 500 && ![429, 402].includes(error.status)) {
          await this.cancel(a.id, error.message, 'failed');
          return;
        }
        await execute(primary(this.env), 'UPDATE execution_attempts SET reason=?,updated_at=? WHERE id=? AND repo_id=?',
          'Waiting for verified budget, capacity, and profile admission.', now(), a.id, a.repo_id);
        throw error;
      }
    }
    if (a.executor === 'hosted' && a.status === 'leased' && !a.execution_started_at) {
      if (a.execution_backend === 'remote') await dispatchRemoteAttempt(this.env, context);
      else {
        await executionRequest(this.env, '/internal/runtime/arm', { attempt_id: a.id, generation: a.generation });
        await this.ensureAttemptWorkflow(a);
      }
    }
    if (a.executor === 'hosted' && a.execution_backend === 'local' && a.status === 'running') {
      const draft = await readLocalHostedDraft(this.env, a.id, a.generation);
      if (draft) { await this.destroy(context); await this.complete(a.id, draft); return; }
    }
    if (a.execution_backend === 'remote' && a.status === 'running') {
      if (a.cleanup_state === 'verified') {
        const dispatch = await remoteDispatch(this.env, a.id);
        if (dispatch.draft_json) await this.complete(a.id, JSON.parse(dispatch.draft_json) as CompletionReceipt);
        else await this.cancel(a.id, 'Remote execution ended without a completion draft.', 'infrastructure_failed');
        return;
      }
      const remote = await inspectRemoteAttempt(this.env, a.id);
      if (remote.state === 'destroyed') {
        const receipt = await verifyRemoteDestruction(this.env, a.id);
        await this.recordDestruction(a.id, receipt);
        const dispatch = await remoteDispatch(this.env, a.id);
        if (dispatch.draft_json) await this.complete(a.id, JSON.parse(dispatch.draft_json) as CompletionReceipt);
        else await this.cancel(a.id, 'Remote execution ended without a completion draft.', 'infrastructure_failed');
      } else if (remote.state === 'failed') await this.cancel(a.id, 'Remote executor infrastructure failed.', 'infrastructure_failed');
    }
  }

  private async admit(context: AttemptContext, runner?: RunnerRecord): Promise<boolean> {
    executionEnabled(this.env);
    const db = primary(this.env);
    await assertActiveRepository(db, context);
    const authority = await authorizeExecutionActor(this.env, context.plan);
    await fenceExecutionAuthority(this.env, context, authority, 'admission');
    await withEnvironmentSecrets(this.env, context, async () => undefined);
    const a = context.attempt;
    if (context.run.status === 'cancelling' || await currentGeneration(db, a) !== a.generation) throw new ApiError(409, 'attempt_fenced', 'This attempt is no longer current.');
    if (a.executor === 'hosted') requireHostedProfile(this.env, context.job);
    const machine = runner ? await loadRunnerAuthority(this.env, runner.id) : null;
    const pool = machine?.pool ?? null;
    if (runner && (machine!.runner.credential_generation !== runner.credential_generation || machine!.runner.credential_hash !== runner.credential_hash)) throw new ApiError(409, 'attempt_fenced', 'The machine changed before allocation.');
    if (runner && (!pool || runnerMatches(pool, runner, { ...context.run, job: context.job }))) throw new ApiError(409, 'runner_capability_changed', 'The assigned machine no longer matches the frozen job.');
    const slot = runner ? await reserveRunnerSlot(this.env, a, runner, pool!) : null;
    if (runner && !slot) return false;
    const maximumStorage = (context.job.limits?.log_bytes ?? EXECUTION_LIMITS.log_bytes) + (context.job.limits?.output_bytes ?? EXECUTION_LIMITS.output_bytes)
      + (context.job.limits?.cache_bytes ?? EXECUTION_LIMITS.cache_bytes) + 32 * 1024 * 1024;
    const reservation = await reserveExecution(this.env, {
      account_id: a.account_id, repo_id: a.repo_id, run_id: a.run_id, attempt_id: a.id, generation: a.generation,
      actor_id: context.run.requested_by, workflow_id: context.run.workflow_id, executor: a.executor, profile: a.profile ?? 'customer-owned',
      maximum_duration_ms: context.job.timeout_ms, maximum_storage_bytes: String(maximumStorage),
      storage_retention_seconds: Math.max(EXECUTION_LIMITS.log_retention_seconds, context.job.cache?.retention_seconds ?? 3600, ...Object.values(context.job.outputs).map(output => output.retention_seconds)),
      maximum_egress_bytes: String(context.job.egress.max_bytes),
    });
    await execute(db, `UPDATE execution_attempts SET reservation_id=?,reservation_fence=?,status='admitting',reason=?,revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND status IN ('accepted','admitting')`,
      reservation.reservation_id, reservation.fence, reservation.reason ?? 'Waiting for allocation grant.', now(), a.id, a.repo_id);
    if (reservation.status === 'queued') { if (runner) await releaseUnassignedRunnerSlot(this.env, a.id); return false; }
    if (!['reserved', 'running'].includes(reservation.status)) throw new ApiError(409, 'admission_closed', 'The reservation no longer permits this attempt.');
    const runtimeName = `${a.id}-g${a.generation}`;
    const namespace = this.env.SANDBOX as DurableObjectNamespace | undefined;
    const runtimeId = a.execution_backend === 'remote' ? remoteRuntimeId(context.job.remote_executor_id!, a.id, a.generation)
      : a.executor === 'hosted' ? namespace?.idFromName(runtimeName).toString() : `${runner?.id}:${runtimeName}`;
    if (!runtimeId || (a.executor === 'self_hosted' && !runner)) throw new ApiError(503, 'executor_unavailable', 'The configured executor is unavailable.');
    // Allocation intent precedes startExecution and every Sandbox RPC. Retries attach
    // to this exact ID; a timeout never authorizes allocating a replacement runtime.
    await execute(db, `UPDATE execution_attempts SET runtime_name=?,runtime_id=?,runner_id=?,runner_credential_generation=?,runner_slot_fence=?,runner_credential_hash=?,cleanup_state='required',updated_at=?
      WHERE id=? AND repo_id=? AND generation=? AND status='admitting'`, runtimeName, runtimeId, runner?.id ?? null, runner?.credential_generation ?? null, slot?.fence ?? null, runner?.credential_hash ?? null, now(), a.id, a.repo_id, a.generation);
    const grant = await startExecution(this.env, { account_id: a.account_id, reservation_id: reservation.reservation_id, fence: reservation.fence, runtime_id: runtimeId });
    const at = now();
    const deadline = grant.deadline_at;
    if (!deadline || Date.parse(deadline) <= Date.now()) throw new ApiError(409, 'allocation_expired', 'The allocation deadline has expired.');
    const credential = await attemptLeaseToken(this.env, { ...a, runner_id: runner?.id ?? null, runner_credential_generation: runner?.credential_generation ?? null });
    const lease = new Date(Math.min(Date.parse(deadline), Date.now() + EXECUTION_LIMITS.lease_ms)).toISOString();
    if (runner && slot) await activateRunnerSlot(this.env, a, runner, slot, lease);
    const allocated = await attemptContext(db, a.id);
    await guardedBatch(db, stmt(db, `UPDATE execution_attempts SET status='leased',credential_hash=?,cleanup_lease_hash=COALESCE(cleanup_lease_hash,?),allocated_at=COALESCE(allocated_at,?),deadline_at=?,lease_expires_at=?,reason=NULL,revision=revision+1,updated_at=?
      WHERE id=? AND repo_id=? AND generation=? AND status='admitting' AND runtime_id=?`, await sha256(credential), await sha256(credential), at, deadline, lease, at, a.id, a.repo_id, a.generation, runtimeId), [
      stmt(db, `UPDATE workflow_jobs SET status='admitting',reason='Starting the allocated executor.',revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND current_attempt_id=?`, at, a.job_id, a.repo_id, a.id),
      ...await machineAuthorityStatements(this.env, allocated, machine?.witness, 'allocation'),
    ], { context: authority, event: { type: 'workflow.attempt.allocated', resource_id: a.id, resource_revision: a.revision + 1, repo_id: a.repo_id, account_id: a.account_id, data: { run_id: a.run_id, generation: a.generation } } });
    await this.storage.setAlarm(Math.min(Date.parse(deadline), Date.now() + 20_000));
    if (a.executor === 'hosted') {
      if (a.execution_backend === 'remote') await dispatchRemoteAttempt(this.env, await attemptContext(primary(this.env), a.id));
      else {
        await executionRequest(this.env, '/internal/runtime/arm', { attempt_id: a.id, generation: a.generation });
        await this.ensureAttemptWorkflow(a);
      }
    }
    return true;
  }

  private async ensureAttemptWorkflow(attempt: AttemptRecord): Promise<void> {
    const id = `attempt-${attempt.id}`;
    try { await this.env.RUN_WORKFLOW.create({ id, params: { mode: 'attempt', run_id: attempt.run_id, attempt_id: attempt.id } }); }
    catch (error) {
      const instance = await this.env.RUN_WORKFLOW.get(id);
      const status = await instance.status();
      if (!status || status.status === 'unknown') throw error;
      // A crashed job instance is never restarted into shell execution. The lease
      // reaper terminates the known runtime; bounded retries use a new generation.
    }
  }

  async assign(attemptId: string, runnerId: string): Promise<{ assigned: boolean; lease_token?: string }> {
    const db = primary(this.env);
    let context = await attemptContext(db, attemptId);
    if (TERMINAL_ATTEMPTS.has(context.attempt.status)) {
      if (['none', 'verified'].includes(context.attempt.cleanup_state)) await closeRunnerSlot(this.env, context.attempt);
      return { assigned: false };
    }
    const { runner, pool } = await loadRunnerAuthority(this.env, runnerId);
    if (!runner || !pool || runnerMatches(pool, runner, { ...context.run, job: context.job })) return { assigned: false };
    if (runner.credential_expires_at <= now() || (context.run.trust === 'untrusted' && !runner.disposable)) return { assigned: false };
    if (runner.disposable && (runner.assignment_attempt_id && runner.assignment_attempt_id !== attemptId
      || await one(db, 'SELECT id FROM execution_attempts WHERE runner_id=? AND id!=? AND allocated_at IS NOT NULL LIMIT 1', runner.id, attemptId))) return { assigned: false };
    if (context.attempt.runner_id === runner.id && ['leased', 'running'].includes(context.attempt.status)) return { assigned: true, lease_token: await this.assignmentLease(context.attempt) };
    if (!['accepted', 'admitting'].includes(context.attempt.status)) return { assigned: false };
    // SQL is the cross-controller slot gate; each controller is only per attempt.
    const claimed = await execute(db, `UPDATE execution_attempts SET status='admitting',runner_id=?,runner_credential_generation=?,revision=revision+1,updated_at=?
      WHERE id=? AND repo_id=? AND status IN ('accepted','admitting') AND (runner_id IS NULL OR runner_id=?)`,
    runner.id, runner.credential_generation, now(), attemptId, context.attempt.repo_id, runner.id);
    if (!claimed.meta.changes) return { assigned: false };
    context = await attemptContext(primary(this.env), attemptId);
    const admitted = await this.admit(context, runner);
    if (!admitted) {
      await execute(primary(this.env), `UPDATE execution_attempts SET status='accepted',runner_id=NULL,runner_credential_generation=NULL WHERE id=? AND repo_id=? AND status='admitting' AND runtime_id IS NULL`, attemptId, context.attempt.repo_id);
      return { assigned: false };
    }
    return { assigned: true, lease_token: await this.assignmentLease((await attemptContext(primary(this.env), attemptId)).attempt) };
  }

  private async assignmentLease(attempt: AttemptRecord): Promise<string> {
    const token = await attemptLeaseToken(this.env, attempt);
    if (attempt.cleanup_lease_hash && attempt.cleanup_lease_hash !== await sha256(token)) throw new ApiError(503, 'lease_key_unavailable', 'The original signing key is required to replay this assignment.');
    return token;
  }

  async assignment(attemptId: string, runnerId: string): Promise<Record<string, unknown> | null> {
    const context = await attemptContext(primary(this.env), attemptId), a = context.attempt;
    const { runner, pool, witness } = await loadRunnerAuthority(this.env, runnerId);
    if (!runner || !pool || a.runner_id !== runner.id || a.runner_credential_generation !== runner.credential_generation || a.status !== 'leased'
      || runnerMatches(pool, runner, { ...context.run, job: context.job })) return null;
    assertCurrentReceipt(a, { attempt_id: a.id, generation: a.generation, plan_digest: a.plan_digest, runner_id: runner.id }, await currentGeneration(primary(this.env), a));
    context.machine_authority = witness;
    await fenceMachineAuthority(this.env, context, 'assignment');
    const assignment = await runnerAssignment(this.env, a.id, await this.assignmentLease(a));
    await fenceMachineAuthority(this.env, context, 'assignment-response');
    return assignment;
  }

  async runnerStatus(attemptId: string, runnerId: string, generation: number): Promise<{ active: boolean }> {
    const { attempt: a, run } = await attemptContext(primary(this.env), attemptId);
    return { active: a.runner_id === runnerId && a.generation === generation && ['leased', 'running'].includes(a.status) && run.status !== 'cancelling'
      && !!a.deadline_at && !!a.lease_expires_at && a.deadline_at > now() && a.lease_expires_at > now() };
  }

  async beginHosted(attemptId: string): Promise<{ execute: boolean }> {
    const db = primary(this.env);
    const context = await attemptContext(db, attemptId);
    if (context.attempt.executor !== 'hosted') throw new ApiError(409, 'executor_mismatch', 'This is not a hosted attempt.');
    await assertActiveRepository(db, context);
    const authority = await authorizeExecutionActor(this.env, context.plan);
    await withEnvironmentSecrets(this.env, context, async () => undefined);
    if (context.attempt.execution_started_at) return { execute: false };
    if (context.run.status === 'cancelling' || context.attempt.status !== 'leased' || !context.attempt.deadline_at || Date.parse(context.attempt.deadline_at) <= Date.now()
      || !context.attempt.lease_expires_at || context.attempt.lease_expires_at <= now() || await currentGeneration(db, context.attempt) !== context.attempt.generation) return { execute: false };
    const at = now();
    await guardedBatch(db, stmt(db, `UPDATE execution_attempts SET status='running',execution_started_at=?,started_at=?,revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND execution_started_at IS NULL AND status='leased'
      AND lease_expires_at>? AND deadline_at>? AND EXISTS (SELECT 1 FROM workflow_jobs j WHERE j.id=execution_attempts.job_id AND j.current_attempt_id=execution_attempts.id AND j.generation=execution_attempts.generation)`, at, at, at, attemptId, context.attempt.repo_id, at, at), [
      stmt(db, `UPDATE workflow_jobs SET status='running',reason=NULL,revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND current_attempt_id=?`, at, context.attempt.job_id, context.attempt.repo_id, attemptId),
    ], { context: authority, event: { type: 'workflow.attempt.started', resource_id: attemptId, resource_revision: context.attempt.revision + 1, repo_id: context.attempt.repo_id, account_id: context.attempt.account_id, data: { run_id: context.run.id } } });
    return { execute: true };
  }

  async authenticate(attemptId: string, auth: ReceiptAuth, allowClosed = false): Promise<AttemptContext> {
    const db = primary(this.env);
    const context = await attemptContext(db, attemptId);
    const a = context.attempt;
    if (allowClosed && a.receipt_hash && TERMINAL_ATTEMPTS.has(a.status)) return this.authenticateCleanup(attemptId, auth);
    const { runner, pool, witness } = await loadRunnerAuthority(this.env, auth.runner_id);
    if (runner.credential_hash !== await sha256(auth.machine_token)
      || a.runner_id !== runner.id || runner.credential_generation !== a.runner_credential_generation || auth.generation !== a.generation
      || await sha256(auth.lease_token) !== (a.cleanup_lease_hash ?? a.credential_hash ?? await sha256(await attemptLeaseToken(this.env, a)))) {
      throw new ApiError(401, 'attempt_fenced', 'The runner credential or attempt lease is not current.');
    }
    if (runnerMatches(pool, runner, { ...context.run, job: context.job })) throw new ApiError(403, 'attempt_fenced', 'This runner no longer matches the attempt scope.');
    context.machine_authority = witness;
    if (!allowClosed) {
      if (a.credential_hash !== await sha256(auth.lease_token)) throw new ApiError(401, 'attempt_fenced', 'The attempt credential was revoked.');
      await assertActiveRepository(db, context);
      if (context.run.status === 'cancelling') throw new ApiError(409, 'attempt_fenced', 'This run is cancelling.');
      assertCurrentReceipt(a, { attempt_id: a.id, generation: auth.generation, runner_id: auth.runner_id, plan_digest: a.plan_digest }, await currentGeneration(db, a));
    }
    return context;
  }

  /** Original allocation proof only: no lease extension, secrets, output or new work. */
  async authenticateCleanup(attemptId: string, auth: ReceiptAuth): Promise<AttemptContext> {
    const context = await attemptContext(primary(this.env), attemptId), a = context.attempt;
    const hash = await sha256(auth.machine_token);
    const legacy = a.runner_credential_hash || !a.runner_id ? null : await readRunnerRecord(this.env, a.runner_id);
    if (a.executor !== 'self_hosted' || !a.allocated_at || a.runner_id !== auth.runner_id || a.generation !== auth.generation
      || hash !== (a.runner_credential_hash ?? (legacy?.credential_generation === a.runner_credential_generation ? legacy.credential_hash : null))
      || await sha256(auth.lease_token) !== (a.cleanup_lease_hash ?? a.credential_hash ?? await sha256(await attemptLeaseToken(this.env, a)))) {
      throw new ApiError(401, 'attempt_fenced', 'Cleanup proof does not match the original machine allocation.');
    }
    return context;
  }

  async heartbeat(attemptId: string, auth?: ReceiptAuth): Promise<{ status: string; lease_expires_at?: string }> {
    const db = primary(this.env);
    const context = auth ? await this.authenticate(attemptId, auth, true) : await attemptContext(db, attemptId);
    const a = context.attempt;
    if (!auth && a.executor !== 'hosted') throw new ApiError(409, 'executor_mismatch', 'A hosted heartbeat cannot renew a customer lease.');
    if (context.run.status === 'cancelling' || a.status === 'cancelling' || a.status === 'cancelled') return { status: 'cancelled' };
    if (!a.deadline_at || !a.lease_expires_at || Date.parse(a.deadline_at) <= Date.now() || Date.parse(a.lease_expires_at) <= Date.now()) return { status: 'expired' };
    if (!['leased', 'running'].includes(a.status) || await currentGeneration(db, a) !== a.generation) return { status: 'revoked' };
    await assertActiveRepository(db, context);
    const authority = await authorizeExecutionActor(this.env, context.plan);
    await withEnvironmentSecrets(this.env, context, async () => undefined);
    const lease = new Date(Math.min(Date.parse(a.deadline_at), Date.now() + EXECUTION_LIMITS.lease_ms)).toISOString();
    await guardedBatch(db,
      stmt(db, `UPDATE execution_attempts SET status='running',started_at=COALESCE(started_at,?),lease_expires_at=?,updated_at=?,revision=revision+1 WHERE id=? AND repo_id=? AND generation=? AND status IN ('leased','running')
        AND deadline_at>? AND lease_expires_at>? AND EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id=execution_attempts.run_id AND r.status NOT IN ('cancelling','cancelled'))`, now(), lease, now(), a.id, a.repo_id, a.generation, now(), now()), [
      stmt(db, `UPDATE workflow_jobs SET status='running',reason=NULL,updated_at=?,revision=revision+1 WHERE id=? AND repo_id=? AND current_attempt_id=?`, now(), a.job_id, a.repo_id, a.id),
      ...await machineAuthorityStatements(this.env, context, context.machine_authority, 'heartbeat'),
    ], { context: authority, event: { type: 'execution.lease.renewed', resource_id: a.id, resource_revision: a.revision + 1, repo_id: a.repo_id, account_id: a.account_id, data: { generation: a.generation, lease_expires_at: lease } } });
    await this.storage.setAlarm(Math.min(Date.parse(lease), Date.now() + 20_000));
    return { status: 'active', lease_expires_at: lease };
  }

  async process(attemptId: string, processId: string): Promise<void> {
    const context = await attemptContext(primary(this.env), attemptId);
    if (context.attempt.executor !== 'hosted' || context.attempt.status !== 'running') throw new ApiError(409, 'attempt_fenced', 'The attempt cannot start another process.');
    assertCurrentReceipt(context.attempt, { attempt_id: attemptId, generation: context.attempt.generation, plan_digest: context.attempt.plan_digest, runner_id: context.attempt.producer_id }, await currentGeneration(primary(this.env), context.attempt));
    await fenceExecutionAuthority(this.env, context, await authorizeExecutionActor(this.env, context.plan), 'process-record');
    await execute(primary(this.env), 'UPDATE execution_attempts SET process_id=?,updated_at=? WHERE id=? AND repo_id=? AND status=?', processId, now(), attemptId, context.attempt.repo_id, 'running');
  }

  async complete(attemptId: string, receipt: CompletionReceipt, auth?: ReceiptAuth): Promise<{ accepted: true }> {
    const db = primary(this.env);
    const context = auth ? await this.authenticate(attemptId, auth, true) : await attemptContext(db, attemptId);
    const a = context.attempt;
    if (!auth && a.executor !== 'hosted') throw new ApiError(409, 'executor_mismatch', 'A hosted receipt cannot complete a customer attempt.');
    const digest = await sha256(JSON.stringify(receipt));
    if (a.receipt_hash === digest && TERMINAL_ATTEMPTS.has(a.status)) { await this.retireAttemptCredentials(a); await this.settle(context); return { accepted: true }; }
    if (a.receipt_hash && a.receipt_hash !== digest) throw new ApiError(409, 'receipt_conflict', 'This attempt already has a different receipt.');
    const identity: AttemptIdentity = { attempt_id: a.id, generation: receipt.generation, runner_id: receipt.runner_id, plan_digest: receipt.plan_digest };
    assertCurrentReceipt(a, identity, await currentGeneration(db, a));
    await assertActiveRepository(db, context);
    const authority = await authorizeExecutionActor(this.env, context.plan);
    await withEnvironmentSecrets(this.env, context, async () => undefined);
    if (context.run.status === 'cancelling') throw new ApiError(409, 'attempt_fenced', 'This run no longer accepts results.');
    await this.validateCompletion(context, receipt);
    if (a.executor === 'hosted' && a.cleanup_state !== 'verified') throw new ApiError(409, 'destruction_unverified', 'Hosted termination has not been verified.');
    const at = now();
    const terminal = receipt.conclusion;
    await guardedBatch(db, stmt(db, `UPDATE execution_attempts SET status=?,receipt_hash=?,outcome_json=?,completed_at=?,cleanup_state='verified',destruction_verified_at=COALESCE(destruction_verified_at,?),credential_hash=NULL,revision=revision+1,updated_at=?
      WHERE id=? AND repo_id=? AND generation=? AND status IN ('leased','running') AND receipt_hash IS NULL AND lease_expires_at>? AND deadline_at>?`,
    terminal, digest, JSON.stringify(receipt), at, at, at, a.id, a.repo_id, a.generation, at, at), [
      stmt(db, `UPDATE workflow_jobs SET status=?,reason=?,completed_at=?,revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND current_attempt_id=? AND generation=?`,
        terminal === 'infrastructure_failed' ? (a.generation <= context.job.infrastructure_retries ? 'waiting' : 'failed') : terminal,
         terminal === 'infrastructure_failed' ? 'Executor infrastructure failed.' : null, at, at, a.job_id, a.repo_id, a.id, a.generation),
      ...await machineAuthorityStatements(this.env, context, context.machine_authority, 'completion'),
    ], { context: authority, event: { type: 'workflow.attempt.completed', resource_id: a.id, resource_revision: a.revision + 1, repo_id: a.repo_id, account_id: a.account_id,
      data: { run_id: a.run_id, attempt_id: a.id, generation: a.generation, conclusion: terminal, plan_digest: a.plan_digest } } });
    await this.retireAttemptCredentials(a);
    await this.settle(await attemptContext(primary(this.env), a.id));
    return { accepted: true };
  }

  async checkpointRemote(attemptId: string, receipt: CompletionReceipt): Promise<{ recorded: true }> {
    const db = primary(this.env), context = await attemptContext(db, attemptId), a = context.attempt;
    if (a.execution_backend !== 'remote') throw new ApiError(409, 'executor_mismatch', 'A remote draft cannot complete a local allocation.');
    assertCurrentReceipt(a, receipt, await currentGeneration(db, a));
    await assertActiveRepository(db, context);
    const authority = await authorizeExecutionActor(this.env, context.plan);
    await this.validateCompletion(context, receipt);
    const hash = await sha256(JSON.stringify(receipt));
    const row = await remoteDispatch(this.env, a.id);
    if (row.draft_hash && row.draft_hash !== hash) throw new ApiError(409, 'receipt_conflict', 'This remote attempt already checkpointed a different completion.');
    await guardedBatch(db, stmt(db, `UPDATE remote_execution_dispatches SET draft_json=?,draft_hash=?,updated_at=? WHERE attempt_id=? AND generation=? AND (draft_hash IS NULL OR draft_hash=?)
      AND EXISTS (SELECT 1 FROM execution_attempts a WHERE a.id=remote_execution_dispatches.attempt_id AND a.status='running' AND a.deadline_at>? AND a.lease_expires_at>?)`, JSON.stringify(receipt), hash, now(), a.id, a.generation, hash, now(), now()), [], {
      context: authority, event: { type: 'execution.remote_receipt.checkpointed', resource_id: a.id, resource_revision: a.revision, repo_id: a.repo_id, account_id: a.account_id, data: { generation: a.generation, receipt_digest: hash } },
    });
    return { recorded: true };
  }

  private async validateCompletion(context: AttemptContext, receipt: CompletionReceipt): Promise<void> {
    const started = Date.parse(receipt.started_at), finished = Date.parse(receipt.finished_at);
    if (receipt.toolchain_digest !== context.attempt.toolchain_digest || !receipt.process_group_stopped || receipt.attempt_id !== context.attempt.id
      || !Number.isFinite(started) || !Number.isFinite(finished) || finished < started || finished > Date.now() + 30_000
      || context.attempt.allocated_at && started < Date.parse(context.attempt.allocated_at) - 30_000) {
      throw new ApiError(409, 'receipt_invalid', 'The receipt does not prove the expected toolchain and process termination.');
    }
    if (receipt.conclusion === 'succeeded' && (receipt.exit_code !== 0 || receipt.signal || receipt.resource_exhaustion
      || context.attempt.egress_bytes > context.job.egress.max_bytes || context.attempt.egress_requests > context.job.egress.max_requests)) throw new ApiError(409, 'receipt_invalid', 'A failed or over-quota command cannot produce a successful receipt.');
    const objects = await many<ExecutionObject>(primary(this.env), `SELECT * FROM execution_objects WHERE attempt_id=? AND repo_id=? AND state='sealed'`, context.attempt.id, context.attempt.repo_id);
    if (new Set(receipt.outputs.map(output => output.name)).size !== receipt.outputs.length || receipt.outputs.some(output => !context.job.outputs[output.name]
      || !Number.isSafeInteger(output.size_bytes) || output.size_bytes < 0 || !objects.some(object => object.kind === 'manifest' && object.name === `output:${output.name}` && object.source_digest === output.sha256))) {
      throw new ApiError(409, 'outputs_incomplete', 'The receipt contains an undeclared or unverified output.');
    }
    if (!objects.some(object => object.kind === 'manifest' && object.name === 'logs' && object.sha256 === receipt.log_manifest_digest)) throw new ApiError(409, 'logs_incomplete', 'The durable log manifest is missing or does not match the receipt.');
    if (receipt.conclusion === 'succeeded') for (const name of Object.keys(context.job.outputs)) {
      const output = receipt.outputs.find(item => item.name === name);
      if (context.job.outputs[name]?.required === false && !output) continue;
      if (!output || !objects.some(object => object.kind === 'manifest' && object.name === `output:${name}` && object.source_digest === output.sha256)) {
        throw new ApiError(409, 'outputs_incomplete', `Declared output ${name} has no verified manifest.`);
      }
    }
  }

  async recordDestruction(attemptId: string, receipt: DestructionReceipt): Promise<void> {
    const context = await attemptContext(primary(this.env), attemptId);
    const a = context.attempt;
    if (a.executor !== 'hosted' || receipt.runtime_id !== a.runtime_id || receipt.attempt_id !== a.id || receipt.generation !== a.generation || receipt.running !== false || receipt.sealed !== true) {
      throw new ApiError(409, 'destruction_identity_mismatch', 'The destruction receipt does not belong to this allocation.');
    }
    const durable = await one<{ receipt_id: string; state: string; destroyed_at: string; proof_kind: 'hosted_destroyed' | 'never_allocated' }>(primary(this.env), 'SELECT receipt_id,state,destroyed_at,proof_kind FROM execution_runtime_receipts WHERE runtime_id=? AND attempt_id=? AND generation=?', receipt.runtime_id, a.id, a.generation);
    if (!durable || durable.state !== 'destroyed' || durable.receipt_id !== receipt.receipt_id || durable.proof_kind !== (receipt.proof_kind ?? 'hosted_destroyed')) throw new ApiError(409, 'destruction_unverified', 'No authoritative runtime destruction record exists.');
    await this.storage.put('destruction', { ...receipt, destroyed_at: durable.destroyed_at, proof_kind: durable.proof_kind });
    await execute(primary(this.env), `UPDATE execution_attempts SET cleanup_state='verified',destruction_verified_at=COALESCE(destruction_verified_at,?),updated_at=?,revision=revision+1 WHERE id=? AND repo_id=? AND runtime_id=?`, durable.destroyed_at, now(), a.id, a.repo_id, a.runtime_id);
  }

  async confirmCustomerTermination(attemptId: string, auth: ReceiptAuth, receiptDigest: string): Promise<void> {
    let context = await this.authenticateCleanup(attemptId, auth);
    let a = context.attempt;
    if (a.cleanup_state === 'verified' && (a.receipt_hash === receiptDigest || a.outcome_json !== null)) {
      // A completion acknowledgment can be lost after a disposable credential
      // retires. The cleanup endpoint can acknowledge its already-proven stop
      // without changing the accepted outcome or requiring a live work grant.
      if (a.status === 'cancelling') await this.finishCancelled(context, await this.storage.get<StopOutcome>('cancel_outcome') ?? 'cancelled', 'verified');
      else { await this.retireAttemptCredentials(a); await this.settle(context); }
      return;
    }
    if (['leased', 'running'].includes(a.status) && (context.run.status === 'cancelling' || !a.lease_expires_at || a.lease_expires_at <= now() || !a.deadline_at || a.deadline_at <= now())) {
      await this.cancel(a.id, 'The customer runner confirmed cleanup after fencing.', context.run.status === 'cancelling' ? 'cancelled' : 'timed_out');
      context = await attemptContext(primary(this.env), a.id); a = context.attempt;
    }
    if (['leased', 'running'].includes(a.status)) {
      // A machine may be fenced by account/pool/credential revocation before its
      // cancellation projection arrives. Cleanup must still acknowledge that stop.
      try { await this.authenticate(attemptId, auth); await assertActiveRepository(primary(this.env), context); await authorizeExecutionActor(this.env, context.plan); }
      catch (error) {
        if (!(error instanceof ApiError) || error.status >= 500) throw error;
        await this.cancel(a.id, 'The runner confirmed cleanup after authority revocation.');
        context = await attemptContext(primary(this.env), a.id); a = context.attempt;
      }
    }
    if (!['cancelling', 'runner_unreachable'].includes(a.status)) throw new ApiError(409, 'attempt_fenced', 'Termination confirmation does not match an outstanding cancellation.');
    if (a.receipt_hash && a.receipt_hash !== receiptDigest) throw new ApiError(409, 'receipt_conflict', 'The allocation already has a different cleanup receipt.');
    await execute(primary(this.env), `UPDATE execution_attempts SET cleanup_state='verified',destruction_verified_at=?,receipt_hash=COALESCE(receipt_hash,?),updated_at=? WHERE id=? AND repo_id=? AND generation=?`, now(), receiptDigest, now(), a.id, a.repo_id, a.generation);
    const current = await attemptContext(primary(this.env), a.id);
    if (a.status === 'cancelling') await this.finishCancelled(current, await this.storage.get<StopOutcome>('cancel_outcome') ?? 'cancelled', 'verified');
    else {
      await this.retireAttemptCredentials(a);
      await this.settle(current);
    }
  }

  async cancel(attemptId: string, reason: string, outcome: StopOutcome = 'cancelled'): Promise<void> {
    let context = await attemptContext(primary(this.env), attemptId);
    if (TERMINAL_ATTEMPTS.has(context.attempt.status)) {
      if (context.attempt.executor === 'hosted' && !['none', 'verified'].includes(context.attempt.cleanup_state)) await this.destroy(context);
      const latest = await attemptContext(primary(this.env), attemptId);
      if (['none', 'verified'].includes(latest.attempt.cleanup_state)) await this.retireAttemptCredentials(latest.attempt);
      await this.settle(latest);
      return;
    }
    await this.storage.put('cancel_outcome', outcome);
    await this.storage.setAlarm(Date.now() + 15_000);
    const a = context.attempt;
    const db = primary(this.env);
    await db.batch([
      stmt(db, `UPDATE execution_attempts SET status='cancelling',reason=?,credential_hash=NULL,revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND status NOT IN ('succeeded','failed','cancelled','timed_out','runner_unreachable','infrastructure_failed')`, reason, now(), a.id, a.repo_id),
      stmt(db, `UPDATE workflow_jobs SET status='cancelling',reason=?,revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND current_attempt_id=?`, reason, now(), a.job_id, a.repo_id, a.id),
    ]);
    await revokeExecutionCredentials(this.env, [`cred_checkout_${a.id}_${a.generation}`], 'Attempt cancellation revoked source access.');
    context = await attemptContext(primary(this.env), attemptId);
    if (!a.runtime_id) {
      if (a.reservation_id && a.reservation_fence) await cancelExecutionReservation(this.env, { account_id: a.account_id, reservation_id: a.reservation_id, fence: a.reservation_fence });
      await this.finishCancelled(context, outcome, 'none');
      return;
    }
    if (a.executor === 'hosted') {
      await this.destroy(context);
      await this.finishCancelled(await attemptContext(primary(this.env), a.id), outcome, 'verified');
    } else if (a.allocated_at === null) {
      // A customer manifest is issued only after the guarded leased write sets
      // allocated_at. Its absence behind the cancelling fence is positive
      // controller evidence of no assignment, not an expired-lease assumption.
      await execute(db, `UPDATE execution_attempts SET cleanup_state='verified',destruction_verified_at=?,receipt_hash=? WHERE id=? AND repo_id=? AND allocated_at IS NULL AND status='cancelling'`,
        now(), await sha256(`never-assigned:${a.id}:${a.generation}`), a.id, a.repo_id);
      await this.finishCancelled(await attemptContext(primary(this.env), a.id), outcome, 'verified');
    } else if (a.cleanup_state === 'verified') await this.finishCancelled(context, outcome, 'verified');
    else if (a.lease_expires_at ? Date.parse(a.lease_expires_at) <= Date.now() : Date.parse(a.queue_deadline_at) <= Date.now()) {
      await this.finishCancelled(context, 'runner_unreachable', 'unreachable');
    }
  }

  private async destroy(context: AttemptContext): Promise<void> {
    const a = context.attempt;
    if (a.cleanup_state === 'verified' || !a.runtime_id) return;
    if (a.executor !== 'hosted') return;
    await execute(primary(this.env), `UPDATE execution_attempts SET cleanup_state='destroying',updated_at=? WHERE id=? AND repo_id=?`, now(), a.id, a.repo_id);
    const receipt = a.execution_backend === 'remote'
      ? await verifyRemoteDestruction(this.env, a.id, true)
      : await bounded(executionRequest<DestructionReceipt>(this.env, '/internal/runtime/destroy', { attempt_id: a.id, generation: a.generation }), EXECUTION_LIMITS.cleanup_ms, 'Runtime destruction has not been confirmed.');
    await this.recordDestruction(a.id, receipt);
  }

  private async finishCancelled(context: AttemptContext, outcome: StopOutcome | 'runner_unreachable', cleanup: 'none' | 'verified' | 'unreachable'): Promise<void> {
    const db = primary(this.env);
    const a = context.attempt;
    const at = now();
    const jobStatus = outcome === 'infrastructure_failed' ? a.generation <= context.job.infrastructure_retries ? 'waiting' : 'failed' : outcome;
    await guardedBatch(db, stmt(db, `UPDATE execution_attempts SET status=?,cleanup_state=?,completed_at=?,revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND status='cancelling'`, outcome, cleanup, at, at, a.id, a.repo_id), [
      stmt(db, 'UPDATE workflow_jobs SET status=?,completed_at=?,revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND current_attempt_id=?', jobStatus, at, at, a.job_id, a.repo_id, a.id),
      eventStatement(db, { type: 'workflow.attempt.completed', resource_id: a.id, resource_revision: a.revision + 1, repo_id: a.repo_id, account_id: a.account_id, data: { run_id: a.run_id, attempt_id: a.id, conclusion: outcome } }),
    ]);
    if (cleanup === 'verified' || cleanup === 'none') await this.retireAttemptCredentials(a);
    await this.settle(await attemptContext(primary(this.env), a.id));
  }

  private async retireAttemptCredentials(attempt: AttemptRecord): Promise<void> {
    await closeRunnerSlot(this.env, attempt);
    await revokeExecutionCredentials(this.env, [`cred_checkout_${attempt.id}_${attempt.generation}`], 'The execution assignment is closed.');
  }

  private async settle(context: AttemptContext): Promise<void> {
    const a = context.attempt;
    if (!a.reservation_id || !a.reservation_fence || a.settled_at || !TERMINAL_ATTEMPTS.has(a.status)) return;
    if (!a.runtime_id) {
      await cancelExecutionReservation(this.env, { account_id: a.account_id, reservation_id: a.reservation_id, fence: a.reservation_fence });
    } else {
      if (a.cleanup_state !== 'verified' || !a.destruction_verified_at) return;
      const receipt = await this.storage.get<DestructionReceipt>('destruction') ?? (a.executor === 'hosted' ? await one<{ receipt_id: string; proof_kind: 'hosted_destroyed' | 'never_allocated' }>(primary(this.env),
        `SELECT receipt_id,proof_kind FROM execution_runtime_receipts WHERE runtime_id=? AND attempt_id=? AND generation=? AND state='destroyed'`, a.runtime_id, a.id, a.generation) : null);
      if (a.executor === 'hosted' && !receipt) throw new ApiError(503, 'destruction_unverified', 'Settlement requires the durable hosted teardown receipt.');
      const kind = a.executor === 'hosted' ? receipt?.proof_kind ?? 'hosted_destroyed' : a.allocated_at ? 'customer_process_exited' : 'never_allocated';
      await settleExecution(this.env, {
        account_id: a.account_id, reservation_id: a.reservation_id, fence: a.reservation_fence, runtime_id: a.runtime_id,
        event_id: `settlement:${a.id}:${a.generation}`, duration_ms: kind !== 'never_allocated' && a.allocated_at ? Math.max(0, Date.parse(a.destruction_verified_at) - Date.parse(a.allocated_at)) : 0,
        egress_bytes: String(a.egress_bytes), outcome: a.status === 'succeeded' ? 'success' : a.status === 'infrastructure_failed' ? 'infrastructure_failure' : a.status === 'timed_out' ? 'timed_out' : a.status === 'cancelled' ? 'cancelled' : 'failure',
        termination_proof: { kind, receipt_id: receipt?.receipt_id ?? a.receipt_hash!, verified_at: a.destruction_verified_at },
      });
    }
    await execute(primary(this.env), 'UPDATE execution_attempts SET settled_at=?,updated_at=? WHERE id=? AND repo_id=? AND settled_at IS NULL', now(), now(), a.id, a.repo_id);
  }
}

export async function attemptLeaseToken(env: Bindings, attempt: Pick<AttemptRecord, 'id' | 'generation' | 'plan_digest' | 'runner_id' | 'producer_id' | 'runner_credential_generation'>): Promise<string> {
  if (env.INTERNAL_SERVICE_KEY.length < 32) throw new ApiError(503, 'execution_unavailable', 'Execution signing keys are unavailable.');
  return `gkl_${await hmac(env.INTERNAL_SERVICE_KEY, ['GitKnot attempt v1', attempt.id, attempt.generation, attempt.plan_digest, attempt.runner_id ?? attempt.producer_id, attempt.runner_credential_generation ?? 0].join('\n'))}`;
}
