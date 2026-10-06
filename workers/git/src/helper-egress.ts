import type { OutboundHandler } from '@cloudflare/containers';
import type { GitBindings } from './types.ts';
import { gitErrorResponse, requireValue } from '../../../packages/git/src/errors.ts';
import { limitStream } from '../../../packages/git/src/protocol.ts';
import type { GitContainer } from './container.ts';

interface Meter {
  debitBytes(allocationId: string, streamId: string, bytes: number): Promise<void>;
  finishBytes(allocationId: string, streamId: string, bytes: number): Promise<void>;
}

/** 64 KiB durable admission quanta, refunded to observed payload size on positive completion. */
export function meteredGitStream(body: ReadableStream<Uint8Array>, meter: Meter, allocationId: string): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const streamId = crypto.randomUUID();
  let bytes = 0;
  let admitted = 0;
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    await meter.finishBytes(allocationId, streamId, bytes);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { await finish(); controller.close(); return; }
        const total = bytes + next.value.byteLength;
        if (total > admitted) {
          admitted = Math.ceil(total / 65_536) * 65_536;
          await meter.debitBytes(allocationId, streamId, admitted);
        }
        bytes = total;
        controller.enqueue(next.value);
      } catch (error) { await reader.cancel(error).catch(() => {}); await finish().catch(() => {}); controller.error(error); }
    },
    async cancel(reason) { await reader.cancel(reason); await finish(); },
  });
}

export const gitOutbound: OutboundHandler<GitBindings, { allocation_id: string }> = async (request, env, ctx) => {
  try {
    requireValue(ctx.className === 'GitContainer' && ctx.params?.allocation_id, 'git_egress_context', 'Unfunded native egress was rejected.', 403);
    const stub = env.GIT_CONTAINERS.get(env.GIT_CONTAINERS.idFromString(ctx.containerId)) as DurableObjectStub<GitContainer>;
    await stub.outboundOperation(ctx.params.allocation_id);
    const url = new URL(request.url);
    requireValue((url.protocol === 'https:' || url.origin === new URL(env.GIT_ORIGIN).origin) && (!url.port || url.port === '443')
      && !url.username && !url.password && !url.hostname.endsWith('.local') && !/^\[|^\d+(?:\.|$)/u.test(url.hostname),
    'git_egress_destination', 'Native Git egress requires a public HTTPS destination.', 403);
    const headers = new Headers(request.headers);
    headers.delete('host');
    const body = request.body ? meteredGitStream(request.body, stub, ctx.params.allocation_id) : undefined;
    const outgoing = new Request(request.url, { method: request.method, headers, body, redirect: 'error' });
    const response = url.origin === new URL(env.GIT_ORIGIN).origin && url.pathname.startsWith('/internal/git/')
      ? await env.GIT_SERVICE.fetch(outgoing)
      : await fetch(outgoing, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
    const maximum = url.pathname.endsWith('/info/refs') ? 4 * 1024 * 1024 : 2 * 1024 ** 3;
    return new Response(response.body ? limitStream(response.body, maximum, 'git_origin_byte_limit') : null, { status: response.status, headers: response.headers });
  } catch (error) { return gitErrorResponse(error); }
};
