import { ApiError, now } from '@gitknot/core';
import { OPERATION_PREFIX, RUNTIME_KEY } from './types.ts';
import type { HostedEnv } from './types.ts';
import type { RuntimeJournal } from './runtime-journal.ts';

interface EgressRequest { bytes: number; upload_bytes: number; expires: number }

export class RuntimeEgress {
  constructor(private readonly journal: RuntimeJournal) {}

  async authorize(url: string, method: string): Promise<{ request_id: string; expires: number }> {
    const record = this.journal.active(), destination = new URL(url);
    const source = record.source_url ? new URL(record.source_url) : null;
    const checkout = source && destination.origin === source.origin && ['GET', 'POST'].includes(method)
      && (destination.pathname === `${source.pathname}/info/refs` && destination.search === '?service=git-upload-pack'
        || destination.pathname === `${source.pathname}/git-upload-pack` && !destination.search);
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)
      || !['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password
      || destination.port && !['80', '443'].includes(destination.port)
      || !checkout && !record.egress.hosts.includes(destination.hostname)) {
      throw new ApiError(403, 'egress_denied', 'The destination is outside the frozen egress policy.');
    }
    if (record.egress_requests >= record.egress.max_requests) {
      this.journal.ctx.storage.kv.put(RUNTIME_KEY, { ...record, egress_exhausted: true });
      throw new ApiError(429, 'egress_quota_exceeded', 'The attempt exhausted its egress request quota.');
    }
    const requestId = crypto.randomUUID(), expires = Math.min(Date.parse(record.lease_expires_at), Date.parse(record.deadline_at), Date.now() + 30_000);
    this.journal.ctx.storage.kv.put(RUNTIME_KEY, { ...record, egress_requests: record.egress_requests + 1 });
    this.journal.ctx.storage.kv.put(`hosted:egress:${requestId}`, { bytes: 0, upload_bytes: 0, expires } satisfies EgressRequest);
    this.journal.ctx.storage.kv.put(`${OPERATION_PREFIX}egress-${requestId}`, { kind: 'egress', started_at: now() });
    await this.journal.ctx.storage.sync();
    return { request_id: requestId, expires };
  }

  async consume(requestId: string, bytes: number, upload: boolean): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 65536) throw new TypeError('Invalid egress metering size.');
    const record = this.journal.active(), key = `hosted:egress:${requestId}`;
    const request = this.journal.ctx.storage.kv.get<EgressRequest>(key);
    if (!request || request.expires <= Date.now()) throw new ApiError(403, 'egress_denied', 'This egress request is no longer leased.');
    if (record.egress_bytes + bytes > record.egress.max_bytes || upload && request.upload_bytes + bytes > record.egress.max_request_bytes) {
      this.journal.ctx.storage.kv.put(RUNTIME_KEY, { ...record, egress_exhausted: true });
      throw new ApiError(429, 'egress_quota_exceeded', 'The attempt exhausted its egress byte quota.');
    }
    this.journal.ctx.storage.kv.put(RUNTIME_KEY, { ...record, egress_bytes: record.egress_bytes + bytes });
    this.journal.ctx.storage.kv.put(key, { ...request, bytes: request.bytes + bytes, upload_bytes: request.upload_bytes + (upload ? bytes : 0) });
    await this.journal.ctx.storage.sync();
  }

  async finish(requestId: string): Promise<void> {
    this.journal.ctx.storage.kv.delete(`hosted:egress:${requestId}`);
    this.journal.ctx.storage.kv.delete(`${OPERATION_PREFIX}egress-${requestId}`);
    await this.journal.ctx.storage.sync();
  }
}

/** No environment/platform credentials are ever attached to customer requests. */
export async function hostedOutbound(request: Request, env: HostedEnv, context: { containerId: string }): Promise<Response> {
  if (request.headers.has('upgrade') || request.method === 'CONNECT') return new Response('GitKnot egress denied.', { status: 403 });
  const runtime = env.SANDBOX.get(env.SANDBOX.idFromString(context.containerId));
  let authorization: Awaited<ReturnType<typeof runtime.authorizeOutbound>>;
  try { authorization = await runtime.authorizeOutbound(request.url, request.method); }
  catch { return new Response('GitKnot egress denied.', { status: 403 }); }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), Math.max(1, authorization.expires - Date.now()));
  let finished = false;
  const finish = async () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    await runtime.finishOutbound(authorization.request_id);
  };
  const meter = (source: ReadableStream<Uint8Array>, upload: boolean) => source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      for (let offset = 0; offset < chunk.length; offset += 65536) {
        const part = chunk.subarray(offset, offset + 65536);
        await runtime.consumeOutbound(authorization.request_id, part.length, upload);
        controller.enqueue(part);
      }
    },
  }));
  const chargeMetadata = async (firstLine: string, headers: Headers, upload: boolean) => {
    let bytes = new TextEncoder().encode(`${firstLine}\r\n`).length;
    for (const [name, value] of headers) bytes += new TextEncoder().encode(`${name}: ${value}\r\n`).length;
    bytes += 2;
    while (bytes > 0) {
      const part = Math.min(bytes, 65536);
      await runtime.consumeOutbound(authorization.request_id, part, upload);
      bytes -= part;
    }
  };
  try {
    await chargeMetadata(`${request.method} ${request.url}`, request.headers, true);
    const response = await fetch(new Request(request, { body: request.body ? meter(request.body, true) : null,
      redirect: 'manual', signal: abort.signal, duplex: 'half' } as RequestInit));
    await chargeMetadata(`${response.status} ${response.statusText}`, response.headers, false);
    if (!response.body) { await finish(); return response; }
    const reader = meter(response.body, false).getReader();
    abort.signal.addEventListener('abort', () => { void reader.cancel().finally(finish).catch(() => undefined); }, { once: true });
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) { await finish(); controller.close(); }
          else controller.enqueue(next.value);
        } catch { abort.abort(); await finish(); controller.error(new Error('GitKnot egress stream closed.')); }
      },
      async cancel(reason) { try { await reader.cancel(reason); abort.abort(); } finally { await finish(); } },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch { abort.abort(); await finish(); return new Response('GitKnot egress request failed.', { status: 502 }); }
}
