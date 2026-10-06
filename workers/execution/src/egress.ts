import { ApiError, now } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import { authorizeExecutionActor, fenceExecutionAuthority } from '@gitknot/execution/authorization';
import { LOCAL_SCOPE_KEY, localAttemptEnvironment, localFenced } from '@gitknot/execution/hosted/local-runtime';
import type { LocalRuntimeScope } from '@gitknot/execution/hosted/local-runtime';
import { RuntimeJournal } from '@gitknot/execution/hosted/runtime-journal';
import { OPERATION_PREFIX, RUNTIME_KEY } from '@gitknot/execution/hosted/runtime-types';

interface EgressRequest { bytes: number; uploaded: number; expires: number }
export interface EgressRuntime {
  authorizeOutbound(url: string, method: string): Promise<{ request_id: string; expires: number }>;
  consumeOutbound(requestId: string, bytes: number, upload: boolean): Promise<void>;
  finishOutbound(requestId: string): Promise<void>;
}

export async function authorizeEgress(env: Bindings, state: DurableObjectState, url: string, method: string): Promise<{ request_id: string; expires: number }> {
  const journal = new RuntimeJournal(state), record = journal.active();
  const scope = state.storage.kv.get<LocalRuntimeScope>(LOCAL_SCOPE_KEY);
  if (!scope?.activated) throw localFenced();
  const selected = await localAttemptEnvironment(env, scope, true);
  await fenceExecutionAuthority(selected.env, selected.context, await authorizeExecutionActor(selected.env, selected.context.plan), 'local-egress');
  const destination = new URL(url), source = record.source_url ? new URL(record.source_url) : null;
  const checkout = source && source.origin === destination.origin && ['GET', 'POST'].includes(method)
    && (destination.pathname === `${source.pathname}/info/refs` && destination.search === '?service=git-upload-pack'
      || destination.pathname === `${source.pathname}/git-upload-pack` && !destination.search);
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)
    || !['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password
    || destination.port && !['80', '443'].includes(destination.port) || !checkout && !record.egress.hosts.includes(destination.hostname)) {
    throw new ApiError(403, 'egress_denied', 'The destination is outside the declared egress policy.');
  }
  const current = journal.active();
  if (current.egress_requests >= current.egress.max_requests) {
    state.storage.kv.put(RUNTIME_KEY, { ...current, egress_exhausted: true });
    throw new ApiError(429, 'egress_quota_exceeded', 'The attempt exhausted its egress request quota.');
  }
  const id = crypto.randomUUID(), expires = Math.min(Date.parse(current.deadline_at), Date.parse(current.lease_expires_at), Date.now() + 30_000);
  state.storage.kv.put(RUNTIME_KEY, { ...current, egress_requests: current.egress_requests + 1 });
  state.storage.kv.put(`hosted:egress:${id}`, { bytes: 0, uploaded: 0, expires } satisfies EgressRequest);
  state.storage.kv.put(`${OPERATION_PREFIX}egress-${id}`, { kind: 'egress', started_at: now() });
  await state.storage.sync();
  return { request_id: id, expires };
}

export async function chargeEgress(state: DurableObjectState, requestId: string, bytes: number, upload: boolean): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 65536) throw new TypeError('Invalid egress metering chunk.');
  const record = new RuntimeJournal(state).active(), key = `hosted:egress:${requestId}`;
  const request = state.storage.kv.get<EgressRequest>(key);
  if (!request || request.expires <= Date.now()) throw localFenced();
  if (record.egress_bytes + bytes > record.egress.max_bytes || upload && request.uploaded + bytes > record.egress.max_request_bytes) {
    state.storage.kv.put(RUNTIME_KEY, { ...record, egress_exhausted: true });
    throw new ApiError(429, 'egress_quota_exceeded', 'The attempt exhausted its egress byte quota.');
  }
  state.storage.kv.put(RUNTIME_KEY, { ...record, egress_bytes: record.egress_bytes + bytes });
  state.storage.kv.put(key, { ...request, bytes: request.bytes + bytes, uploaded: request.uploaded + (upload ? bytes : 0) });
  await state.storage.sync();
}

export async function finishEgress(state: DurableObjectState, requestId: string): Promise<void> {
  state.storage.kv.delete(`hosted:egress:${requestId}`); state.storage.kv.delete(`${OPERATION_PREFIX}egress-${requestId}`);
  await state.storage.sync();
}

/** Trusted proxy: exact-host policy, bounded metadata/body bytes, no credentials. */
export async function outbound(request: Request, env: Bindings, context: { containerId: string }): Promise<Response> {
  if (request.headers.has('upgrade') || request.method === 'CONNECT') return new Response('GitKnot egress denied.', { status: 403 });
  const namespace = env.SANDBOX as DurableObjectNamespace;
  const runtime = namespace.get(namespace.idFromString(context.containerId)) as unknown as EgressRuntime;
  let grant: Awaited<ReturnType<EgressRuntime['authorizeOutbound']>>;
  try { grant = await runtime.authorizeOutbound(request.url, request.method); }
  catch { return new Response('GitKnot egress denied.', { status: 403 }); }
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), Math.max(1, grant.expires - Date.now()));
  let finished = false;
  const finish = async () => { if (finished) return; finished = true; clearTimeout(timer); await runtime.finishOutbound(grant.request_id); };
  const charge = async (bytes: number, upload: boolean) => {
    while (bytes > 0) { const part = Math.min(bytes, 65536); await runtime.consumeOutbound(grant.request_id, part, upload); bytes -= part; }
  };
  const headers = async (line: string, values: Headers, upload: boolean) => {
    let bytes = new TextEncoder().encode(`${line}\r\n\r\n`).length;
    for (const [name, value] of values) bytes += new TextEncoder().encode(`${name}: ${value}\r\n`).length;
    await charge(bytes, upload);
  };
  const meter = (source: ReadableStream<Uint8Array>, upload: boolean) => source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      for (let offset = 0; offset < chunk.length; offset += 65536) {
        const part = chunk.subarray(offset, offset + 65536); await charge(part.length, upload); controller.enqueue(part);
      }
    },
  }));
  try {
    await headers(`${request.method} ${request.url}`, request.headers, true);
    const response = await fetch(new Request(request, { body: request.body ? meter(request.body, true) : null,
      redirect: 'manual', signal: abort.signal, duplex: 'half' } as RequestInit));
    await headers(`${response.status} ${response.statusText}`, response.headers, false);
    if (!response.body) { await finish(); return response; }
    const reader = meter(response.body, false).getReader();
    abort.signal.addEventListener('abort', () => { void reader.cancel().finally(finish).catch(() => undefined); }, { once: true });
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try { const item = await reader.read(); if (item.done) { await finish(); controller.close(); } else controller.enqueue(item.value); }
        catch { abort.abort(); await finish(); controller.error(new Error('GitKnot egress stream closed.')); }
      },
      async cancel(reason) { try { await reader.cancel(reason); abort.abort(); } finally { await finish(); } },
    }), { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch { abort.abort(); await finish(); return new Response('GitKnot egress request failed.', { status: 502 }); }
}
