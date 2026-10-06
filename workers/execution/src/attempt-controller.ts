import { DurableObject } from 'cloudflare:workers';
import { ApiError, cellDatabase, identityAuthorityBindings, verifyInternalRequest } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import { AttemptMachine } from '@gitknot/execution/attempt-machine';
import type { ReceiptAuth, DestructionReceipt } from '@gitknot/execution/attempt-machine';
import { reserveObject, sealObject } from '@gitknot/execution/objects';
import type { ObjectRequest } from '@gitknot/execution/objects';
import type { AttemptIdentity, CompletionReceipt, DispatchMessage } from '@gitknot/execution/types';
import { executionError } from './errors.ts';
import { executionResourceEnvironment } from '@gitknot/execution/store';
import type { RunnerAuthorityWitness } from '@gitknot/execution/runner-authority';

export class AttemptController extends DurableObject<Bindings> {
  private machine!: AttemptMachine;
  private placement: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(ctx: DurableObjectState, env: Bindings) { super(ctx, env); }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(run, run); this.queue = result.catch(() => undefined); return result;
  }

  private scoped<T>(id: string, run: (env: Bindings) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const env = await executionResourceEnvironment(this.env, id, 'attempt');
      const placement = `${env.CELL_ID}:${env.SHARD_ID}`;
      if (this.placement !== placement) { this.placement = placement; this.machine = new AttemptMachine(env, this.ctx.storage); }
      await this.ctx.storage.put('metadata-scope', { attempt_id: id, shard_id: env.SHARD_ID });
      return run(env);
    });
  }

  override async fetch(request: Request): Promise<Response> {
    try {
      await verifyInternalRequest(request, this.env.INTERNAL_SERVICE_KEY, 'execution');
      const match = /^\/internal\/attempts\/(att_[a-zA-Z0-9_-]+)\/([a-z-]+)$/.exec(new URL(request.url).pathname);
      if (!match || request.method !== 'POST') throw new ApiError(404, 'not_found', 'The controller operation was not found.');
      const [, id, action] = match;
      if (this.ctx.id.toString() !== this.env.ATTEMPTS.idFromName(id!).toString()) throw new ApiError(409, 'attempt_fenced', 'The controller identity does not match the request.');
      const body = await request.json<Record<string, unknown>>();
      return await this.scoped(id!, async env => {
        switch (action) {
          case 'accept': return Response.json(await this.machine.accept(body as unknown as DispatchMessage));
          case 'reconcile': await this.machine.tick(id); return Response.json({ reconciled: true });
          case 'assign': return Response.json(await this.machine.assign(id!, String(body.runner_id)));
          case 'assignment': return Response.json({ assignment: await this.machine.assignment(id!, String(body.runner_id)) });
          case 'runner-status': return Response.json(await this.machine.runnerStatus(id!, String(body.runner_id), Number(body.generation)));
          case 'begin-hosted': return Response.json(await this.machine.beginHosted(id!));
          case 'authorize': return Response.json(await this.machine.authenticate(id!, body as unknown as ReceiptAuth));
          case 'authorize-closed': return Response.json(await this.machine.authenticate(id!, body as unknown as ReceiptAuth, true));
          case 'authorize-cleanup': return Response.json(await this.machine.authenticateCleanup(id!, body as unknown as ReceiptAuth));
          case 'heartbeat': return Response.json(await this.machine.heartbeat(id!, body as unknown as ReceiptAuth));
          case 'hosted-heartbeat': return Response.json(await this.machine.heartbeat(id!));
          case 'process': await this.machine.process(id!, String(body.process_id)); return Response.json({ recorded: true });
          case 'complete': return Response.json(await this.machine.complete(id!, body.receipt as CompletionReceipt, body.auth as ReceiptAuth));
          case 'hosted-complete': return Response.json(await this.machine.complete(id!, body as unknown as CompletionReceipt));
          case 'remote-checkpoint': return Response.json(await this.machine.checkpointRemote(id!, body as unknown as CompletionReceipt));
          case 'customer-terminated': await this.machine.confirmCustomerTermination(id!, body.auth as ReceiptAuth, String(body.receipt_digest)); return Response.json({ recorded: true });
          case 'destroyed': await this.machine.recordDestruction(id!, body as unknown as DestructionReceipt); return Response.json({ recorded: true });
          case 'cancel': await this.machine.cancel(id!, typeof body.reason === 'string' ? body.reason.slice(0, 512) : 'Cancellation requested.', body.outcome === 'infrastructure_failed' ? 'infrastructure_failed' : body.outcome === 'failed' ? 'failed' : body.outcome === 'timed_out' ? 'timed_out' : 'cancelled'); return Response.json({ cancelled: true });
          case 'reserve-object': {
            if (body.attempt_id !== id) throw new ApiError(409, 'attempt_fenced', 'Upload attempt identity mismatch.');
            return Response.json(await reserveObject(env, body as unknown as ObjectRequest));
          }
          case 'seal-object': {
            const identity = body.identity as AttemptIdentity;
            if (identity.attempt_id !== id) throw new ApiError(409, 'attempt_fenced', 'Upload attempt identity mismatch.');
            return Response.json(await sealObject(env, identity, String(body.object_id), body.machine_authority as RunnerAuthorityWitness | undefined));
          }
          default: throw new ApiError(404, 'not_found', 'The controller operation was not found.');
        }
      });
    } catch (error) { return executionError(error); }
  }

  override async alarm(): Promise<void> {
    const scope = await this.ctx.storage.get<{ attempt_id: string; shard_id: string }>('metadata-scope');
    if (!scope) return;
    try { await this.scoped(scope.attempt_id, () => this.machine.tick(scope.attempt_id)); }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'execution_cell_changed') throw error;
      await this.enqueue(async () => {
        const env = { ...this.env, ...identityAuthorityBindings(this.env), ROOT_DB: this.env.ROOT_DB ?? this.env.DB,
          DB: cellDatabase(this.env, scope.shard_id), SHARD_ID: scope.shard_id };
        await new AttemptMachine(env, this.ctx.storage).cancel(scope.attempt_id, 'Repository execution moved to another control-plane cell.');
      });
    }
  }
}
