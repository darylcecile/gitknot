import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { readBounded } from '../../packages/core/src/limits.ts';

export const operationSchema = z.object({
  id: z.string().min(1), status: z.enum(['pending', 'waiting', 'running', 'completed', 'failed', 'cancelled']),
  revision: z.number().int().positive(), phase: z.string().optional(), result: z.record(z.string(), z.unknown()).nullable().optional(),
  error: z.record(z.string(), z.unknown()).nullable().optional(),
}).passthrough();
export type OperationReceipt = z.infer<typeof operationSchema>;

export interface OperationRequest { path: string; body: Record<string, unknown>; revision?: number; idempotency_key: string }

export class OperationsClient {
  readonly origin: string;
  readonly token: string;

  constructor(origin: string, token: string) {
    const url = new URL(origin);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Operations require an HTTPS origin, or an explicit loopback HTTP origin.');
    if (!token) throw new Error('Set GITKNOT_OPERATOR_TOKEN to an authorized GitKnot product token.');
    this.origin = url.origin;
    this.token = token;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, accept: 'application/json', ...extra };
  }

  async json(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!path.startsWith('/v1/')) throw new Error('Operations must use a versioned GitKnot API path.');
    const response = await fetch(new URL(path, this.origin), { ...init, headers: this.headers(init.headers as Record<string, string> | undefined), redirect: 'error', signal: AbortSignal.timeout(60_000) });
    const text = new TextDecoder().decode(await readBounded(response.body, 8 * 1024 * 1024));
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new Error(`Operations API returned invalid JSON (${response.status}).`); }
    if (!response.ok) {
      const parsed = z.object({ error: z.object({ code: z.string(), request_id: z.string().optional() }) }).safeParse(body);
      throw new Error(`GitKnot operation failed: ${response.status}${parsed.success ? ` ${parsed.data.error.code} (${parsed.data.error.request_id ?? 'no request ID'})` : ''}.`);
    }
    return body;
  }

  async create(request: OperationRequest): Promise<OperationReceipt> {
    const result = await this.json(request.path, {
      method: 'POST', headers: {
        'content-type': 'application/json', 'idempotency-key': request.idempotency_key,
        ...(request.revision ? { 'if-match': `"${request.revision}"` } : {}),
      }, body: JSON.stringify(request.body),
    });
    const envelope = z.object({ operation: operationSchema }).passthrough().safeParse(result);
    return envelope.success ? envelope.data.operation : operationSchema.parse(result);
  }

  async wait(id: string, seconds = 1800): Promise<OperationReceipt> {
    const deadline = Date.now() + seconds * 1000;
    let lastPhase: string | undefined;
    while (Date.now() < deadline) {
      const operation = operationSchema.parse(await this.json(`/v1/operations/${encodeURIComponent(id)}`));
      if (operation.phase !== lastPhase) { console.log(`${id}: ${operation.phase ?? operation.status}`); lastPhase = operation.phase; }
      if (operation.status === 'completed') return operation;
      if (operation.status === 'failed' || operation.status === 'cancelled') throw new Error(`${id} is ${operation.status}; its durable phase is retained. Resume that operation rather than creating a replacement.`);
      await delay(2000);
    }
    throw new Error(`Operation ${id} is still pending after ${seconds}s. It was not cancelled; resume monitoring its existing ID.`);
  }

  async downloadArchive(id: string, output: string): Promise<{ sha256: string; bytes: number }> {
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    const temporary = `${output}.${randomUUID()}.partial`;
    const response = await fetch(`${this.origin}/v1/archives/${encodeURIComponent(id)}/content`, { headers: this.headers(), redirect: 'error', signal: AbortSignal.timeout(30 * 60_000) });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Archive download failed (${response.status}).`); }
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      await pipeline(Readable.fromWeb(response.body as never), new Transform({
        transform(chunk: Buffer, _encoding, done) { hash.update(chunk); bytes += chunk.byteLength; done(null, chunk); },
      }), createWriteStream(temporary, { mode: 0o600, flags: 'wx' }));
      await link(temporary, output);
      await rm(temporary);
      return { sha256: hash.digest('hex'), bytes };
    } catch (error) { await rm(temporary, { force: true }); throw error; }
  }
}
