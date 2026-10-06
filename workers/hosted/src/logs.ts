import type { Sandbox } from '@cloudflare/sandbox';
import { ApiError } from '@gitknot/core';
import { StreamingRedactor, redactText } from '@gitknot/execution/redaction';
import { LIMITS } from './types.ts';
import type { HostedEnv, HostedWorkflowParams } from './types.ts';
import { attemptController } from './controller.ts';

/** Redaction carry never leaves Workflow memory; only sanitized chunks persist. */
export class RemoteLogs {
  private readonly offsets = new Map<string, number>();
  private readonly redactors = new Map<string, StreamingRedactor>();
  private sequence = 0;
  private total = 0;
  private readonly pending: Array<{ id: string; bytes: Uint8Array }> = [];
  exceeded = false;

  constructor(private readonly env: HostedEnv, private readonly params: HostedWorkflowParams, private readonly sandbox: Sandbox,
    private readonly secrets: string[], private readonly maximum = LIMITS.log_bytes) {}

  async read(file: string, final = false): Promise<void> {
    await this.flush();
    if (this.exceeded) { if (final) return; throw new ApiError(413, 'log_quota_exceeded', 'The attempt exhausted its retained log quota.'); }
    if (!/^\/tmp\/gitknot-control\/step-[0-9]{1,3}\.(out|err)$/.test(file)) throw new TypeError('Invalid hosted log path.');
    const redactor = this.redactors.get(file) ?? new StreamingRedactor(this.secrets);
    this.redactors.set(file, redactor);
    let position = this.offsets.get(file) ?? 0;
    for (;;) {
      const result = await this.sandbox.exec(`dd if=${file} bs=65536 skip=${Math.floor(position / 65536)} count=1 iflag=fullblock 2>/dev/null | base64 -w0`, { timeout: 5000 });
      if (!result.success) throw new ApiError(503, 'log_read_failed', 'The hosted executor could not read its full logs.');
      const data = Buffer.from(result.stdout.trim(), 'base64');
      if (data.toString('base64') !== result.stdout.trim()) throw new ApiError(503, 'log_read_failed', 'The hosted log reader returned invalid data.');
      const bytes = data.subarray(position % 65536);
      if (!bytes.length) break;
      position += bytes.length;
      this.offsets.set(file, position);
      await this.write(redactor.push(bytes));
      if (data.length < 65536) break;
    }
    if (final) { const tail = redactor.finish(); this.redactors.delete(file); await this.write(tail); }
  }

  async message(text: string): Promise<void> {
    await this.write(new TextEncoder().encode(redactText(text, this.secrets)));
  }

  private async write(bytes: Uint8Array): Promise<void> {
    if (!bytes.length) return;
    if (this.total + bytes.length > this.maximum) { this.exceeded = true; bytes = bytes.subarray(0, Math.max(0, this.maximum - this.total)); }
    this.total += bytes.length;
    for (let offset = 0; offset < bytes.length; offset += LIMITS.chunk_bytes) {
      const chunk = bytes.slice(offset, offset + LIMITS.chunk_bytes);
      this.pending.push({ id: `stream:${this.sequence++}`, bytes: chunk });
    }
    await this.flush();
    if (this.exceeded) throw new ApiError(413, 'log_quota_exceeded', 'The attempt exhausted its retained log quota.');
  }

  private async flush(): Promise<void> {
    while (this.pending.length) {
      const chunk = this.pending[0]!;
      await attemptController(this.env, this.params.attempt_id).appendLog(this.params, chunk.id, chunk.bytes);
      this.pending.shift();
    }
  }
}
