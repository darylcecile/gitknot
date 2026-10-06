import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { endpointURL, isPublicAddress } from '../../packages/operations/src/security.ts';
import type { OutboundResponse } from '../../packages/operations/src/types.ts';

const MAX_RESPONSE = 16_384;
const MAX_BODY = 262_144;
const TIMEOUT_MS = 20_000;
const allowedHeaders = new Set(['webhook-id', 'webhook-timestamp', 'webhook-signature', 'x-gitknot-delivery', 'content-type', 'user-agent']);

export async function resolveEndpoint(value: string, signal: AbortSignal): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  const url = endpointURL(value);
  signal.throwIfAborted();
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  ]);
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('endpoint_not_public');
  const selected = addresses.find(({ family }) => family === 4) ?? addresses[0]!;
  if (selected.family !== 4 && selected.family !== 6) throw new Error('endpoint_not_public');
  return { url, address: selected.address, family: selected.family };
}

export async function sendWebhook(input: { url: string; body: string; headers: Record<string, string> }): Promise<OutboundResponse> {
  if (Buffer.byteLength(input.body) > MAX_BODY) throw new Error('payload_too_large');
  const started = Date.now();
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const { url, address, family } = await resolveEndpoint(input.url, signal);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) {
    if (!allowedHeaders.has(name.toLowerCase()) || value.length > 4096 || /[\r\n]/.test(value)) throw new Error('invalid_header');
    headers[name.toLowerCase()] = value;
  }
  headers.host = url.host;
  headers['content-type'] = 'application/json';
  headers['content-length'] = String(Buffer.byteLength(input.body));
  headers['accept-encoding'] = 'identity';

  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: address, family, port: 443, servername: url.hostname,
      path: `${url.pathname}${url.search}`, method: 'POST', headers,
      agent: false, rejectUnauthorized: true, minVersion: 'TLSv1.2', signal,
      maxHeaderSize: 16_384,
    }, (incoming) => {
      let size = 0;
      let settled = false;
      const chunks: Buffer[] = [];
      const finish = (truncated: boolean) => {
        if (settled) return;
        settled = true;
        resolve({
          status: incoming.statusCode ?? 502,
          retry_after: incoming.headers['retry-after'] ?? null,
          response_excerpt: new TextDecoder().decode(Buffer.concat(chunks)),
          response_truncated: truncated,
          duration_ms: Date.now() - started,
        });
      };
      incoming.on('data', (chunk: Buffer) => {
        const remaining = MAX_RESPONSE - size;
        chunks.push(chunk.subarray(0, Math.max(0, remaining)));
        size += chunk.byteLength;
        if (size > MAX_RESPONSE) { finish(true); incoming.destroy(); outgoing.destroy(); }
      });
      incoming.once('end', () => finish(false));
      incoming.once('error', reject);
      incoming.once('aborted', () => { if (!settled) reject(new Error('response_aborted')); });
    });
    outgoing.once('error', reject);
    outgoing.end(input.body);
  });
}
