import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, rm, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { ROOT } from '../environment.ts';
import { command, offlineEnvironment } from '../process.ts';

const partSchema = z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(), media_type: z.string() }).passthrough();
const manifestSchema = z.object({
  format: z.literal('gitknot.repository'), version: z.literal(1), archive_id: z.string(), created_at: z.string(),
  repository: z.object({ id: z.string().regex(/^r_[\w-]+$/), owner_id: z.string(), revision: z.number().int().positive(), routing_epoch: z.number().int().positive() }).passthrough(),
  parts: z.array(partSchema).max(20_000),
  git: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive(), refs: z.array(z.object({ ref: z.string(), oid: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/) })) }).passthrough(),
}).passthrough();
export type ArchiveManifest = z.infer<typeof manifestSchema>;
interface Entry { name: string; bytes: number; offset: number }
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

async function exact(file: FileHandle, offset: number, size: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const next = await file.read(buffer, read, size - read, offset + read);
    if (!next.bytesRead) throw new Error('Archive is truncated.');
    read += next.bytesRead;
  }
  return buffer;
}

function number(buffer: Buffer): number {
  const value = decode(buffer).replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(value)) throw new Error('Unsupported archive numeric encoding.');
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Archive numeric field is out of range.');
  return parsed;
}

function header(block: Buffer, offset: number): Entry {
  const name = decode(block.subarray(0, 100)).replace(/\0.*$/, '');
  if (!/^[A-Za-z0-9_./-]+$/.test(name) || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '')) throw new Error('Unsafe or unsupported archive path.');
  if (![0, 48].includes(block[156]!) || decode(block.subarray(257, 262)) !== 'ustar') throw new Error('Only regular GitKnot USTAR entries are accepted.');
  const expected = number(block.subarray(148, 156));
  const checksum = block.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
  if (checksum !== expected) throw new Error('Archive header checksum mismatch.');
  return { name, bytes: number(block.subarray(124, 136)), offset: offset + 512 };
}

async function hashRange(file: FileHandle, entry: Entry): Promise<string> {
  const hash = createHash('sha256');
  for (let offset = 0; offset < entry.bytes; offset += 128 * 1024) hash.update(await exact(file, entry.offset + offset, Math.min(128 * 1024, entry.bytes - offset)));
  return hash.digest('hex');
}

async function verifyGit(path: string, entry: Entry, manifest: ArchiveManifest): Promise<void> {
  const directory = join(ROOT, '.gitknot', 'restore-checks', randomUUID());
  const repository = join(directory, 'repository');
  const bundle = join(directory, 'repository.bundle');
  await mkdir(repository, { recursive: true, mode: 0o700 });
  const env = offlineEnvironment({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  const git = (args: string[]) => command('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', ...args], { cwd: repository, env, capture: true, timeout: 300_000 });
  try {
    await pipeline(createReadStream(path, { start: entry.offset, end: entry.offset + entry.bytes - 1 }), createWriteStream(bundle, { flags: 'wx', mode: 0o600 }));
    await git(['init', '--bare', '--template=', '.']);
    await git(['bundle', 'verify', bundle]);
    await git(['fetch', '--no-tags', bundle, 'refs/*:refs/*']);
    await git(['fsck', '--full', '--strict', '--no-reflogs']);
    const actual = (await git(['for-each-ref', '--format=%(refname) %(objectname)'])).trim().split('\n').filter(Boolean).sort();
    const expected = manifest.git.refs.map(ref => `${ref.ref} ${ref.oid}`).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Restored Git refs differ from the backup manifest.');
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function verifyPortableArchive(path: string, expectedSha256?: string): Promise<{ manifest: ArchiveManifest; sha256: string; bytes: number; git_verified: true }> {
  if (!(await lstat(path)).isFile()) throw new Error('Choose a regular archive file, not a symbolic link or special file.');
  const wholeHash = createHash('sha256');
  for await (const chunk of createReadStream(path)) wholeHash.update(chunk);
  const sha256 = wholeHash.digest('hex');
  if (expectedSha256 && expectedSha256 !== sha256) throw new Error('Archive SHA-256 differs from the independently retained backup receipt.');
  const size = (await stat(path)).size;
  const file = await open(path, 'r');
  let manifest: ArchiveManifest | undefined;
  let bundle: Entry | undefined;
  const seen = new Set<string>();
  let terminated = false;
  try {
    let position = 0;
    while (position < size) {
      const block = await exact(file, position, 512);
      if (block.every(value => value === 0)) {
        const end = await exact(file, position + 512, 512);
        if (!end.every(value => value === 0) || position + 1024 !== size) throw new Error('Unexpected data after archive terminator.');
        terminated = true;
        break;
      }
      const entry = header(block, position);
      if (entry.offset + entry.bytes > size || seen.has(entry.name)) throw new Error('Archive contains a duplicate or truncated entry.');
      seen.add(entry.name);
      if (entry.name === 'manifest.json') {
        if (position !== 0 || entry.bytes > 8 * 1024 * 1024) throw new Error('The bounded manifest must be the first archive entry.');
        manifest = manifestSchema.parse(JSON.parse(decode(await exact(file, entry.offset, entry.bytes))));
        if (new Set(manifest.parts.map(part => part.path)).size !== manifest.parts.length) throw new Error('Duplicate manifest paths.');
      } else {
        if (!manifest) throw new Error('Archive manifest missing.');
        const expected = entry.name === 'repository.bundle' ? manifest.git : manifest.parts.find(part => part.path === entry.name);
        if (!expected || expected.bytes !== entry.bytes || await hashRange(file, entry) !== expected.sha256) throw new Error(`Archive content mismatch: ${entry.name}`);
        if (entry.name === 'repository.bundle') bundle = entry;
      }
      position = entry.offset + Math.ceil(entry.bytes / 512) * 512;
    }
    if (!terminated || !manifest || !bundle || manifest.parts.some(part => !part.path.startsWith('git/') && !seen.has(part.path))) throw new Error('Archive is missing declared parts or its terminator.');
  } finally { await file.close(); }
  await verifyGit(path, bundle, manifest);
  return { manifest, sha256, bytes: size, git_verified: true };
}
