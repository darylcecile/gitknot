import type { Readable } from 'node:stream';
import { Buffer } from 'node:buffer';
import { Transform } from 'node:stream';
import { GitError, requireValue } from '../../../packages/git/src/errors.ts';
import { parseRefCommand } from '../../../packages/git/src/protocol.ts';
import type { GitLimits, RefUpdate } from '../../../packages/git/src/types.ts';
import { validateUpdates } from '../../../packages/git/src/policy.ts';

export class PacketReader {
  private readonly source: AsyncIterator<Buffer>;
  private pending = Buffer.alloc(0);
  constructor(input: Readable) { this.source = input[Symbol.asyncIterator](); }

  async packet(): Promise<string | null> {
    const header = await this.exact(4);
    requireValue(/^[a-f0-9]{4}$/iu.test(header.toString()), 'protocol_error', 'Invalid Git packet header.');
    const size = Number.parseInt(header.toString(), 16);
    if (size === 0) return null;
    requireValue(size >= 4 && size <= 65_520, 'protocol_error', 'Invalid Git packet size.');
    return new TextDecoder('utf-8', { fatal: true }).decode(await this.exact(size - 4)).replace(/\n$/u, '');
  }

  private async exact(size: number): Promise<Buffer> {
    while (this.pending.length < size) {
      const next = await this.source.next();
      requireValue(!next.done, 'protocol_error', 'Unexpected end of Git protocol stream.');
      this.pending = Buffer.concat([this.pending, next.value]);
    }
    const result = this.pending.subarray(0, size);
    this.pending = this.pending.subarray(size);
    return result;
  }
}

/** Inspect just the command prelude and pack header, streaming pack bytes with backpressure. */
export class ReceiveGuard extends Transform {
  private readonly limits: GitLimits;
  private readonly internal: boolean;
  private bytes = 0;
  private prelude = Buffer.alloc(0);
  private phase: 'commands' | 'pack' | 'stream' | 'probe' = 'commands';
  private readonly updates: RefUpdate[] = [];

  constructor(limits: GitLimits, internal = false) { super(); this.limits = limits; this.internal = internal; }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      this.bytes += chunk.length;
      requireValue(this.bytes <= this.limits.max_pack_bytes, 'pack_limit', 'Git push exceeds the configured pack byte limit.', 413);
      requireValue(this.phase !== 'probe' || chunk.length === 0, 'protocol_error', 'A Git authentication probe cannot contain commands or pack bytes.');
      if (this.phase !== 'stream') {
        this.prelude = Buffer.concat([this.prelude, chunk]);
        this.inspect();
      }
      this.push(chunk);
      callback();
    } catch (error) { callback(error instanceof Error ? error : new Error('Invalid Git push.')); }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    if (this.phase === 'commands' || (this.phase === 'pack' && this.prelude.length > 0)) {
      callback(new GitError('protocol_error', 'Truncated Git push.'));
    } else callback();
  }

  private inspect(): void {
    while (this.phase === 'commands' && this.prelude.length >= 4) {
      const header = this.prelude.subarray(0, 4).toString('ascii');
      requireValue(/^[a-f0-9]{4}$/iu.test(header), 'protocol_error', 'Invalid Git push header.');
      const size = Number.parseInt(header, 16);
      if (size === 0) {
        if (!this.updates.length) {
          requireValue(this.prelude.length === 4, 'protocol_error', 'A Git authentication probe must contain exactly one flush packet.');
          this.prelude = Buffer.alloc(0);
          this.phase = 'probe';
          return;
        }
        validateUpdates(this.updates, this.limits.max_refs, this.internal);
        this.prelude = this.prelude.subarray(4);
        this.phase = 'pack';
        break;
      }
      requireValue(size >= 4 && size <= 65_520, 'protocol_error', 'Invalid Git packet length.');
      if (this.prelude.length < size) break;
      const line = new TextDecoder('utf-8', { fatal: true }).decode(this.prelude.subarray(4, size));
      requireValue(!line.startsWith('shallow ') && !line.startsWith('push-cert'), 'unsupported_push', 'Shallow and signed-push certificates are not supported; signed commits are supported.');
      this.updates.push(parseRefCommand(line));
      requireValue(this.updates.length <= this.limits.max_refs, 'ref_limit', 'Too many ref updates.');
      this.prelude = this.prelude.subarray(size);
    }
    if (this.phase === 'pack' && this.prelude.length >= 12) {
      requireValue(this.prelude.subarray(0, 4).toString('ascii') === 'PACK', 'protocol_error', 'Invalid Git pack header.');
      const version = this.prelude.readUInt32BE(4);
      requireValue(version === 2 || version === 3, 'protocol_error', 'Unsupported Git pack version.');
      requireValue(this.prelude.readUInt32BE(8) <= this.limits.max_objects, 'object_limit', 'Git push supplies too many objects.', 413);
      this.prelude = Buffer.alloc(0);
      this.phase = 'stream';
    }
    requireValue(this.prelude.length <= 65_532, 'protocol_error', 'Git command prelude exceeds its limit.');
  }
}
