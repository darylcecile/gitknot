import type { Sandbox } from '@cloudflare/sandbox';
import { ApiError, execute, many, now, one, sha256 } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import { EXECUTION_LIMITS } from '../config.ts';
import { putObjectBytes } from '../objects.ts';
import { StreamingRedactor, redactText } from '../redaction.ts';
import { bounded } from '../transport.ts';
import type { AttemptIdentity } from '../types.ts';
import { primary } from '../store.ts';
import { localAttemptEnvironment, localFenced } from './local-runtime.ts';

interface LogChunk {
  attempt_id: string; repo_id: string; account_id: string; generation: number; sequence: number;
  sha256: string; size_bytes: number; data_base64: string | null; object_id: string | null;
}

async function deliver(env: Bindings, identity: AttemptIdentity, chunk: LogChunk): Promise<void> {
  if (chunk.object_id) return;
  if (chunk.data_base64 === null) throw new ApiError(503, 'hosted_log_incomplete', 'A durable sanitized log chunk is unavailable.');
  const bytes = Buffer.from(chunk.data_base64, 'base64');
  if (bytes.length !== chunk.size_bytes || bytes.toString('base64') !== chunk.data_base64 || await sha256(bytes) !== chunk.sha256) {
    throw new ApiError(503, 'hosted_log_corrupt', 'A durable sanitized log chunk failed integrity verification.');
  }
  const stored = await putObjectBytes(env, { ...identity, kind: 'log', name: 'combined', sequence: chunk.sequence,
    content_type: 'text/plain; charset=utf-8', retention_seconds: EXECUTION_LIMITS.log_retention_seconds }, bytes);
  await execute(primary(env), `UPDATE local_hosted_log_chunks SET object_id=?,data_base64=NULL WHERE attempt_id=? AND repo_id=? AND account_id=? AND generation=? AND sequence=? AND sha256=?`,
    stored.id, identity.attempt_id, chunk.repo_id, chunk.account_id, identity.generation, chunk.sequence, chunk.sha256);
}

export async function flushHostedLogs(env: Bindings, identity: AttemptIdentity): Promise<void> {
  const selected = await localAttemptEnvironment(env, identity), a = selected.context.attempt;
  if (a.plan_digest !== identity.plan_digest || a.producer_id !== identity.runner_id) throw localFenced();
  for (;;) {
    const chunks = await many<LogChunk>(primary(selected.env), `SELECT * FROM local_hosted_log_chunks WHERE attempt_id=? AND repo_id=? AND account_id=? AND generation=? AND object_id IS NULL ORDER BY sequence LIMIT 64`,
      a.id, a.repo_id, a.account_id, a.generation);
    if (!chunks.length) return;
    for (const chunk of chunks) await deliver(selected.env, identity, chunk);
  }
}

export class HostedLogs {
  private sequence = 0;
  private total = 0;
  private readonly offsets = new Map<string, number>();
  private readonly masks = new Map<string, StreamingRedactor>();
  private readonly pending: Array<{ sequence: number; bytes: Uint8Array }> = [];
  exceeded = false;

  constructor(private readonly env: Bindings, private readonly identity: AttemptIdentity, private readonly sandbox: Sandbox, private readonly maximum = EXECUTION_LIMITS.log_bytes) {}

  async read(file: string, secrets: string[], final = false): Promise<void> {
    await this.flush();
    if (this.exceeded) { if (final) return; throw new ApiError(413, 'log_quota_exceeded', 'The attempt exceeded its retained log quota.'); }
    if (!/^\/tmp\/gitknot-control\/step-\d+\.(?:out|err)$/.test(file)) throw new Error('Invalid hosted log path.');
    const redactor = this.masks.get(file) ?? new StreamingRedactor(secrets);
    this.masks.set(file, redactor);
    let position = this.offsets.get(file) ?? 0;
    for (;;) {
      const result = await bounded(this.sandbox.exec(`dd if=${file} bs=65536 skip=${Math.floor(position / 65536)} count=1 iflag=fullblock 2>/dev/null | base64 -w0`, { timeout: 10_000 }), 15_000, 'The log reader timed out.');
      if (!result.success) throw new ApiError(503, 'log_read_failed', 'The executor could not read its complete logs.');
      const data = Buffer.from(result.stdout.trim(), 'base64');
      if (data.toString('base64') !== result.stdout.trim()) throw new ApiError(503, 'log_read_failed', 'The log reader returned invalid bytes.');
      const bytes = data.subarray(position % 65536);
      if (!bytes.length) break;
      position += bytes.length;
      this.offsets.set(file, position);
      await this.write(redactor.push(bytes));
      if (data.length < 65536) break;
    }
    if (final) { const tail = redactor.finish(); this.masks.delete(file); await this.write(tail); }
  }

  async message(message: string, secrets: string[] = []): Promise<void> { await this.write(new TextEncoder().encode(redactText(message, secrets))); }

  async flush(): Promise<void> {
    while (this.pending.length) {
      const chunk = this.pending[0]!, selected = await localAttemptEnvironment(this.env, this.identity), a = selected.context.attempt;
      const sum = await sha256(chunk.bytes), db = primary(selected.env);
      await execute(db, `INSERT OR IGNORE INTO local_hosted_log_chunks
        (attempt_id,repo_id,account_id,generation,sequence,sha256,size_bytes,data_base64,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      a.id, a.repo_id, a.account_id, a.generation, chunk.sequence, sum, chunk.bytes.length, Buffer.from(chunk.bytes).toString('base64'), now());
      const stored = await one<LogChunk>(db, 'SELECT * FROM local_hosted_log_chunks WHERE attempt_id=? AND repo_id=? AND generation=? AND sequence=?', a.id, a.repo_id, a.generation, chunk.sequence);
      if (!stored || stored.sha256 !== sum || stored.size_bytes !== chunk.bytes.length) throw new ApiError(409, 'hosted_log_conflict', 'A log sequence cannot change on replay.');
      await deliver(selected.env, this.identity, stored);
      this.pending.shift();
    }
  }

  private async write(bytes: Uint8Array): Promise<void> {
    if (!bytes.length) return;
    if (this.total + bytes.length > this.maximum) { this.exceeded = true; bytes = bytes.slice(0, Math.max(0, this.maximum - this.total)); }
    this.total += bytes.length;
    for (let offset = 0; offset < bytes.length; offset += EXECUTION_LIMITS.log_chunk_bytes) {
      this.pending.push({ sequence: this.sequence++, bytes: bytes.slice(offset, offset + EXECUTION_LIMITS.log_chunk_bytes) });
    }
    await this.flush();
    if (this.exceeded) throw new ApiError(413, 'log_quota_exceeded', 'The attempt exceeded its retained log quota.');
  }
}
