import { createServer } from 'node:http';
import { verifyInternalRequest } from '../../packages/core/src/internal.ts';
import { resolveEndpoint, sendWebhook } from './transport.ts';

const key = process.env.INTERNAL_SERVICE_KEY;
if (!key || Buffer.byteLength(key) < 32) throw new Error('INTERNAL_SERVICE_KEY is required');
const seen = new Map<string, number>();

const server = createServer({ maxHeaderSize: 16_384, requestTimeout: 30_000 }, async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const value of incoming) {
      const chunk = Buffer.from(value);
      length += chunk.byteLength;
      if (length > 320_000) throw new Error('request_too_large');
      chunks.push(chunk);
    }
    const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (typeof value === 'string') headers.set(name, value);
    }
    const request = new Request(`https://internal.gitknot.com${incoming.url}`, { method: incoming.method, headers, body });
    await verifyInternalRequest(request, key, 'webhook-egress');
    const nonce = headers.get('x-gitknot-internal-nonce')!;
    const timestamp = Date.now();
    for (const [existing, expires] of seen) if (expires < timestamp) seen.delete(existing);
    if (seen.has(nonce) || seen.size >= 100_000) throw new Error('request_replayed');
    seen.set(nonce, timestamp + 120_000);
    const data = JSON.parse(body) as { url: string; body: string; headers: Record<string, string> };
    if (request.method !== 'POST' || typeof data.url !== 'string') throw new Error('invalid_request');
    let result: unknown;
    if (new URL(request.url).pathname === '/internal/webhooks/validate') {
      await resolveEndpoint(data.url, AbortSignal.timeout(5000));
      result = { valid: true };
    } else if (new URL(request.url).pathname === '/internal/webhooks/send' && typeof data.body === 'string' && data.headers && typeof data.headers === 'object') {
      result = await sendWebhook(data);
    } else {
      outgoing.writeHead(404).end();
      return;
    }
    outgoing.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(result));
  } catch (error) {
    const code = error instanceof Error ? error.message : 'egress_failed';
    console.error(JSON.stringify({ component: 'webhook-egress', error: code }));
    const invalid = ['endpoint_not_allowed', 'endpoint_not_public', 'invalid_header', 'payload_too_large', 'invalid_request', 'request_too_large'].includes(code);
    outgoing.writeHead(invalid ? 422 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: invalid ? 'endpoint_not_allowed' : 'egress_unavailable' } }));
  }
});

server.headersTimeout = 5000;
server.keepAliveTimeout = 1000;
server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0');
