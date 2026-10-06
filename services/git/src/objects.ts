import { readdir } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { createReadStream } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import type { Readable } from 'node:stream';
import { NativeGit } from './process.ts';
import type { GitStream } from './process.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';

export interface ObjectInfo { oid: string; type: 'blob' | 'tree' | 'commit' | 'tag'; size: number }

class ByteReader {
  private readonly source: AsyncIterator<Buffer>;
  private buffer = Buffer.alloc(0);
  constructor(stream: Readable) { this.source = stream[Symbol.asyncIterator](); }

  async exact(length: number): Promise<Buffer> {
    const result = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      if (!this.buffer.length) {
        const next = await this.source.next();
        requireValue(!next.done, 'invalid_object', 'Git object data is incomplete.');
        this.buffer = next.value;
      }
      const size = Math.min(length - offset, this.buffer.length);
      this.buffer.copy(result, offset, 0, size);
      this.buffer = this.buffer.subarray(size);
      offset += size;
    }
    return result;
  }

  async line(): Promise<string> {
    const bytes: number[] = [];
    while (bytes.length < 256) {
      const byte = (await this.exact(1))[0];
      if (byte === 10) return Buffer.from(bytes).toString('ascii');
      bytes.push(byte);
    }
    throw new Error('Invalid native object header.');
  }
}

/** One native cat-file process, one bounded object in memory at a time. */
export class ObjectReader {
  private readonly git: NativeGit;
  private readonly input = new PassThrough();
  private readonly child: GitStream;
  private readonly reader: ByteReader;

  constructor(git: NativeGit) {
    this.git = git;
    this.child = git.stream(['cat-file', '--batch'], { input: this.input, max_output: git.limits.max_inflated_bytes + git.limits.max_objects * 128 });
    this.reader = new ByteReader(this.child.output);
  }

  async read(info: ObjectInfo): Promise<Buffer> {
    requireValue(info.size <= this.git.limits.max_blob_bytes, 'object_size_limit', 'A Git object exceeds the configured size limit.', 413);
    this.input.write(`${info.oid}\n`);
    const header = await this.reader.line();
    requireValue(header === `${info.oid} ${info.type} ${info.size}`, 'invalid_object', 'Git object metadata does not match its contents.');
    const result = await this.reader.exact(info.size);
    requireValue((await this.reader.exact(1))[0] === 10, 'invalid_object', 'Git object data has an invalid terminator.');
    return result;
  }

  async close(): Promise<void> {
    this.input.end();
    this.child.output.resume();
    const result = await this.child.completion;
    requireValue(result.code === 0, 'invalid_object', 'Git object inspection failed.');
  }

  abort(): void { this.input.destroy(); this.child.stop(); }
}

export async function objectInfo(git: NativeGit, oids: Iterable<string>): Promise<Map<string, ObjectInfo>> {
  const unique = [...new Set(oids)];
  requireValue(unique.length <= git.limits.max_objects, 'object_limit', 'Git object inspection exceeds its object limit.', 413);
  if (!unique.length) return new Map();
  const output = await git.text(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
    input: `${unique.join('\n')}\n`, max_output: git.limits.max_objects * 100,
  });
  const result = new Map<string, ObjectInfo>();
  for (const line of output.split('\n')) {
    const match = /^([a-f0-9]{40}) (blob|tree|commit|tag) (\d+)$/u.exec(line);
    requireValue(match, 'invalid_object', 'A referenced Git object is missing or invalid.');
    const size = Number(match[3]);
    requireValue(Number.isSafeInteger(size), 'invalid_object', 'Git object size is invalid.');
    result.set(match[1], { oid: match[1], type: match[2] as ObjectInfo['type'], size });
  }
  requireValue(result.size === unique.length, 'invalid_object', 'Git object inspection is incomplete.');
  return result;
}

export async function suppliedObjects(git: NativeGit, quarantine: string | undefined): Promise<string[]> {
  if (!quarantine) return [];
  const root = resolve(quarantine);
  requireValue(dirname(root) === resolve(git.directory, 'objects') && /^(?:tmp_objdir-)?incoming-[A-Za-z0-9]+$/u.test(basename(root)),
    'invalid_quarantine', 'Invalid native Git quarantine.', 503);
  const objects = new Set<string>();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && /^[a-f0-9]{2}$/u.test(entry.name)) {
      for (const file of await readdir(join(root, entry.name))) {
        if (/^[a-f0-9]{38}$/u.test(file)) objects.add(entry.name + file);
        requireValue(objects.size <= git.limits.max_objects, 'object_limit', 'The incoming pack contains too many objects.', 413);
      }
    }
    if (entry.name !== 'pack' || !entry.isDirectory()) continue;
    for (const file of await readdir(join(root, 'pack'))) {
      if (!/^pack-[a-f0-9]{40}\.idx$/u.test(file)) continue;
      const index = await git.text(['show-index'], { input: createReadStream(join(root, 'pack', file)), max_output: git.limits.max_objects * 100 });
      for (const line of index.split('\n').filter(Boolean)) {
        const oid = line.split(' ')[1];
        requireValue(/^[a-f0-9]{40}$/u.test(oid ?? ''), 'invalid_pack', 'Git pack index is invalid.');
        objects.add(oid);
        requireValue(objects.size <= git.limits.max_objects, 'object_limit', 'The incoming pack contains too many objects.', 413);
      }
    }
  }
  return [...objects];
}

export async function reachableObjects(git: NativeGit, newOid: string, oldOid?: string): Promise<Map<string, ObjectInfo>> {
  const args = ['rev-list', '--objects', '--no-object-names', newOid];
  if (oldOid) args.push(`^${oldOid}`);
  const output = await git.text(args, { max_output: git.limits.max_objects * 41 });
  const oids = output ? output.split('\n') : [];
  // Include an annotated tag even if its target was already reachable.
  if (!oids.includes(newOid)) oids.push(newOid);
  return objectInfo(git, oids);
}

export function totalObjectBytes(objects: Map<string, ObjectInfo>, limit: number): number {
  let size = 0;
  for (const info of objects.values()) {
    size += info.size;
    requireValue(Number.isSafeInteger(size) && size <= limit, 'inflated_limit', 'The incoming history exceeds its inflated byte limit.', 413);
  }
  return size;
}
