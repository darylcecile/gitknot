import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { NativeSessionSpec, RefUpdate } from '../../../packages/git/src/types.ts';
import { ZERO_OID } from '../../../packages/git/src/types.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';
import { createWorkingRepository } from './repository.ts';
import type { NativeConfiguration, WorkingRepository } from './repository.ts';

export async function receiveRestore(stage: WorkingRepository, spec: NativeSessionSpec, body: ReadableStream<Uint8Array>, hooks: string, config: NativeConfiguration): Promise<void> {
  const context = spec.restore;
  requireValue(context && spec.kind === 'restore', 'invalid_restore', 'A scoped restore manifest is required.');
  const producer = await createWorkingRepository(config, spec.policy.limits, stage.git.deadline);
  const file = join(producer.path, 'restore.bundle');
  let bytes = 0;
  const hash = createHash('sha256');
  try {
    await pipeline(Readable.fromWeb(body as never), new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > context.bundle_bytes || bytes > spec.policy.limits.max_pack_bytes) { callback(new Error('Restore bundle exceeds its declared byte limit.')); return; }
        hash.update(chunk);
        callback(null, chunk);
      },
    }), createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal: AbortSignal.timeout(Math.max(1, stage.git.deadline - Date.now())) });
    requireValue(bytes === context.bundle_bytes && hash.digest('hex') === context.bundle_sha256, 'restore_checksum', 'Restore bundle checksum or size does not match its verified archive.');
    requireValue(bytes > 0 || context.expected_refs.length === 0, 'restore_empty', 'An empty Git archive cannot declare refs.');
    if (!bytes) return;
    await producer.git.run(['bundle', 'verify', file]);
    await producer.git.run(['fetch', '--no-tags', '--no-recurse-submodules', file, '+refs/*:refs/*'], { config: ['protocol.file.allow=always'] });
    await producer.git.run(['fsck', '--strict', '--no-reflogs', '--no-dangling']);
    const actual = (await producer.git.text(['for-each-ref', '--format=%(refname)%09%(objectname)'])).split('\n').filter(Boolean).map(line => {
      const [ref, oid] = line.split('\t'); return { ref, oid };
    });
    const sort = (refs: Array<{ ref: string; oid: string }>) => JSON.stringify(refs.toSorted((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0).map(({ ref, oid }) => [ref, oid]));
    requireValue(sort(actual) === sort(context.expected_refs), 'restore_refs', 'Restore bundle does not contain the exact archived refs.');
    const updates: RefUpdate[] = actual.map(ref => ({ ref: ref.ref, old_oid: ZERO_OID, new_oid: ref.oid }));
    await producer.git.run(['push', '--porcelain', '--atomic', '--no-follow-tags',
      ...updates.map(update => `--force-with-lease=${update.ref}:`), pathToFileURL(stage.path).href,
      ...updates.map(update => `${update.new_oid}:${update.ref}`)], { hooks, config: ['protocol.file.allow=always'] });
  } finally { await producer.cleanup(); }
}
