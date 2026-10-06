import { Container } from '@cloudflare/containers';
import { signInternalRequest, verifyInternalRequest } from '@gitknot/core';
import { GIT_NATIVE_SCOPE } from '../../../packages/git/src/types.ts';
import { gitErrorResponse, requireValue } from '../../../packages/git/src/errors.ts';
import { boundedJson } from '../../../packages/git/src/protocol.ts';
import type { GitBindings } from './types.ts';
import { HelperBudget } from './helper-budget.ts';
import type { HelperAllocation } from './helper-budget.ts';
import { gitOutbound, meteredGitStream } from './helper-egress.ts';

export class GitContainer extends Container<GitBindings> {
  defaultPort = 8080;
  sleepAfter = '5s';
  enableInternet = false;
  interceptHttps = true;
  envVars = {
    NODE_ENV: 'production', INTERNAL_SERVICE_KEY: this.env.INTERNAL_SERVICE_KEY,
    GIT_CALLBACK_ORIGIN: this.env.GIT_ORIGIN, GIT_MAX_SESSIONS: this.env.GIT_MAX_SESSIONS ?? '4',
    GIT_EGRESS_INTERCEPTED: '1', NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt',
    ...(this.env.GIT_SIGNING_PRIVATE_KEY ? { GIT_SIGNING_PRIVATE_KEY: this.env.GIT_SIGNING_PRIVATE_KEY } : {}),
  };
  private readonly budget = new HelperBudget(this.ctx.storage, this.env, this.ctx.id.toString());
  private preparing?: Promise<HelperAllocation>;

  override async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/internal/control-operation' || path === '/internal/sessions') {
        await verifyInternalRequest(request, this.env.INTERNAL_SERVICE_KEY, GIT_NATIVE_SCOPE);
        const allocation = await this.ensureFunded();
        if (path === '/internal/control-operation') {
          const input = await boundedJson<{ count: number }>(request);
          requireValue(Number.isInteger(input.count) && input.count > 0 && input.count <= 10, 'git_control_cost', 'Invalid Git control-plane allowance.');
          await this.budget.operation(allocation.id, input.count);
          return Response.json({ admitted: true, allocation_id: allocation.id });
        }
        await this.budget.operation(allocation.id, 1, true);
      } else {
        const allocation = await this.budget.read();
        requireValue(path.startsWith('/sessions/') && allocation?.phase === 'running' && this.ctx.container?.running,
          'native_session_lost', 'The previous native session is no longer running. Reconcile its operation.', 410);
      }
      const allocation = await this.budget.read();
      requireValue(allocation?.phase === 'running', 'git_budget_unconfirmed', 'Native Git has no current financial grant.', 503);
      const response = await this.containerFetch(request);
      return new Response(response.body ? meteredGitStream(response.body, this, allocation.id) : null, { status: response.status, headers: response.headers });
    } catch (error) { return gitErrorResponse(error); }
  }

  async debitBytes(allocationId: string, streamId: string, bytes: number): Promise<void> { await this.budget.bytes(allocationId, streamId, bytes); }
  async finishBytes(allocationId: string, streamId: string, bytes: number): Promise<void> { await this.budget.finishStream(allocationId, streamId, bytes); }
  async outboundOperation(allocationId: string): Promise<void> {
    await this.budget.operation(allocationId);
    // Explicit protocol allowance, not asserted provider usage; it bounds request/TLS overhead.
    const stream = `headers_${crypto.randomUUID()}`;
    await this.budget.bytes(allocationId, stream, 65_536);
    await this.budget.finishStream(allocationId, stream, 65_536);
  }

  override async onStart(): Promise<void> {
    await this.budget.running();
    const allocation = (await this.budget.read())!;
    await this.schedule(new Date(allocation.work_deadline_at), 'hardDeadline', { allocation_id: allocation.id });
  }

  async hardDeadline(payload: { allocation_id: string }): Promise<void> {
    if ((await this.budget.read())?.id === payload.allocation_id) await this.destroyFunded();
  }

  override async onActivityExpired(): Promise<void> {
    const allocation = await this.budget.read();
    if (allocation?.phase === 'running' && Date.now() < Date.parse(allocation.work_deadline_at)) {
      try {
        const request = await signInternalRequest(new Request('http://git-native.internal/internal/activity'), this.env.INTERNAL_SERVICE_KEY, GIT_NATIVE_SCOPE);
        const response = await this.containerFetch(request);
        const activity = await response.json() as { active_sessions?: number };
        if (response.ok && (activity.active_sessions ?? 0) > 0) { this.renewActivityTimeout(); return; }
      } catch { /* A nonresponsive helper is terminated; publication uncertainty stays fenced. */ }
    }
    await this.destroyFunded();
  }

  private async ensureFunded(): Promise<HelperAllocation> {
    const current = await this.budget.read();
    if (current?.phase === 'running' && this.ctx.container?.running && Date.now() < Date.parse(current.work_deadline_at)) return current;
    this.preparing ??= this.prepare().finally(() => { this.preparing = undefined; });
    return this.preparing;
  }

  private async prepare(): Promise<HelperAllocation> {
    const previous = await this.budget.read();
    if (previous && !['reserving', 'admitted', 'settled'].includes(previous.phase)) await this.destroyFunded();
    else if (this.ctx.container?.running) await this.destroyFunded();
    const allocation = await this.budget.reserve();
    await this.setOutboundHandler('gitTraffic', { allocation_id: allocation.id });
    await this.applyOutboundInterceptionPromise;
    try {
      await this.startAndWaitForPorts({ ports: [8080], startOptions: { envVars: { ...this.envVars, GIT_HELPER_DEADLINE: allocation.work_deadline_at } },
        cancellationOptions: { instanceGetTimeoutMS: 10_000, portReadyTimeoutMS: 30_000 } });
    } catch (error) { await this.destroyFunded(); throw error; }
    return (await this.budget.read())!;
  }

  private async destroyFunded(): Promise<void> {
    await this.destroy();
    const state = await this.getState();
    requireValue(!this.ctx.container?.running && ['stopped', 'stopped_with_code'].includes(state.status), 'git_teardown_unconfirmed', 'Native helper teardown has not been verified.', 503);
    const allocation = await this.budget.read();
    if (!allocation || allocation.phase === 'settled') return;
    await this.budget.stopped(`container:${this.ctx.id.toString()}:${allocation.id}:destroyed`);
    await this.budget.settle();
  }
}

GitContainer.outboundHandlers = { gitTraffic: gitOutbound };
