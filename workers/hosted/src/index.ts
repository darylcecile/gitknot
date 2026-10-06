import { ApiError } from '@gitknot/core';
import { requireRemoteOrigin, verifyRemoteRequest } from '@gitknot/execution/remote/protocol';
import { attemptController, reapHosted } from './controller.ts';
import { hostedError } from './errors.ts';
import { allowLoopback } from './validation.ts';
import type { HostedEnv } from './types.ts';

export { HostedAttemptWorkflow } from './workflow.ts';
export { RemoteAttemptController } from './controller.ts';
export { HostedSandbox } from './sandbox.ts';
export { ContainerProxy } from '@cloudflare/sandbox';
export type { HostedEnv } from './types.ts';

export default {
  async fetch(request: Request, env: HostedEnv): Promise<Response> {
    try {
      const url = new URL(request.url);
      requireRemoteOrigin(url.origin, allowLoopback(env));
      await verifyRemoteRequest(request, env.HOSTED_CONTROL_KEY);
      const match = /^\/internal\/hosted\/attempts\/([A-Za-z0-9_-]{1,128})\/(accept|status|cancel)$/.exec(url.pathname);
      if (request.method !== 'POST' || !match || url.search) throw new ApiError(404, 'not_found', 'The hosted operation was not found.');
      return attemptController(env, match[1]!).fetch(request);
    } catch (error) { return hostedError(error); }
  },
  async scheduled(_event: ScheduledController, env: HostedEnv): Promise<void> { await reapHosted(env); },
} satisfies ExportedHandler<HostedEnv>;
