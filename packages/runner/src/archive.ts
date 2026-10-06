import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { canonicalJson, isSafeRelativePath } from '../../workflows/src/index.ts';
import { RunnerError, throwIfAborted } from './errors.ts';
import { isFsError, safeWorkspacePath, within } from './files.ts';
import { containsSecret, secretVariants } from './redaction.ts';

export const ARCHIVE_MEDIA_TYPE = 'application/vnd.gitknot.files+ndjson';
const FILE_CHUNK_BYTES = 49_152;

export interface FileDigest { digest: string; size_bytes: number }
export interface ArchiveDigest extends FileDigest { file_count: number }
export interface ArchiveLimits { max_bytes: number; max_files: number; signal?: AbortSignal; secrets?: string[] }

class SecretScanner {
  private tail = Buffer.alloc(0);
  private readonly needles: Buffer[];
  private readonly width: number;
  constructor(secrets: string[]) {
    this.needles = secretVariants(secrets).map((value) => Buffer.from(value));
    this.width = Math.max(1, ...this.needles.map((value) => value.length));
  }
  check(bytes: Buffer): void {
    if (!this.needles.length) return;
    const current = Buffer.concat([this.tail, bytes]);
    if (this.needles.some((needle) => current.includes(needle))) throw new RunnerError('output_contains_secret', 'An output or cache contains a protected credential or secret.');
    this.tail = Buffer.from(current.subarray(Math.max(0, current.length - this.width + 1)));
  }
}

export async function fileDigest(path: string, maximum: number, signal?: AbortSignal): Promise<FileDigest> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const hash = createHash('sha256');
  let size = 0;
  try {
    if (!(await handle.stat()).isFile()) throw new RunnerError('unsafe_output', 'Expected a regular file.');
    for await (const data of handle.createReadStream({ autoClose: false })) {
      throwIfAborted(signal);
      size += (data as Buffer).byteLength;
      if (size > maximum) throw new RunnerError('output_limit', 'The file exceeds its byte limit.');
      hash.update(data as Buffer);
    }
    return { digest: `sha256:${hash.digest('hex')}`, size_bytes: size };
  } finally { await handle.close(); }
}

async function collectEntries(root: string, paths: string[], limits: ArchiveLimits): Promise<Array<{ path: string; directory: boolean }>> {
  const entries = new Map<string, boolean>();
  let visited = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    throwIfAborted(limits.signal);
    visited += 1;
    if (visited > limits.max_files * 4 + paths.length) throw new RunnerError('output_file_limit', 'The output contains too many filesystem entries.');
    if (depth > 64) throw new RunnerError('output_depth', 'Output directory nesting exceeds 64 levels.');
    const full = await safeWorkspacePath(root, path);
    const info = await lstat(full);
    if (info.isDirectory()) {
      const children = (await readdir(full)).filter(name => name.toLowerCase() !== '.git').sort();
      if (!children.length) entries.set(relative(root, full).split(sep).join('/') || '.', true);
      for (const name of children) {
        await visit(path === '.' ? name : `${path.replace(/\/$/, '')}/${name}`, depth + 1);
      }
    } else {
      if (!info.isFile() || info.nlink > 1) throw new RunnerError('unsafe_output', 'Outputs must contain regular files, without links or special devices.');
      const normalized = relative(root, full).split(sep).join('/');
      entries.set(normalized, false);
    }
    if (entries.size > limits.max_files) throw new RunnerError('output_file_limit', 'The output contains too many files or empty directories.');
  };
  for (const path of paths) await visit(path, 0);
  return [...entries.keys()].sort().map(path => ({ path, directory: entries.get(path)! }));
}

/** Streaming, deterministic archive creation. No host filenames or credential-bearing metadata. */
export async function createArchive(root: string, paths: string[], destination: string, limits: ArchiveLimits, stripBase = '.'): Promise<ArchiveDigest> {
  const entries = await collectEntries(root, paths, limits);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const target = await open(temporary, 'wx', 0o600);
  const hash = createHash('sha256');
  let size = 0;
  const names = new Set<string>();
  const write = async (value: unknown): Promise<void> => {
    throwIfAborted(limits.signal);
    const data = Buffer.from(`${canonicalJson(value)}\n`);
    size += data.byteLength;
    if (size > limits.max_bytes) throw new RunnerError('output_limit', 'The archive exceeds its encoded byte limit.');
    hash.update(data);
    await target.writeFile(data);
  };
  try {
    await write({ format: 'gitknot.files', version: 1 });
    for (const entry of entries) {
      const path = entry.path;
      const name = relative(resolve(root, stripBase), resolve(root, path)).split(sep).join('/') || '.';
      if (!(entry.directory && name === '.' || archivePath(name)) || names.has(name.toLowerCase())) throw new RunnerError('unsafe_output', 'An output path is ambiguous or escapes the artifact root.');
      if (containsSecret(Buffer.from(name), limits.secrets ?? [])) throw new RunnerError('output_contains_secret', 'An output filename contains a protected credential or secret.');
      names.add(name.toLowerCase());
      if (entry.directory) {
        const directory = await safeWorkspacePath(root, path);
        if (!(await lstat(directory)).isDirectory() || (await readdir(directory)).some(child => child.toLowerCase() !== '.git')) throw new RunnerError('output_changed', 'An empty output directory changed during capture.');
        await write({ type: 'directory', path: name, mode: 0o755 });
        continue;
      }
      const file = await open(await safeWorkspacePath(root, path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await file.stat();
        if (!before.isFile() || before.nlink > 1) throw new RunnerError('unsafe_output', 'Output files cannot be links or special devices.');
        const mode = before.mode & 0o111 ? 0o755 : 0o644;
        const scanner = new SecretScanner(limits.secrets ?? []);
        let position = 0;
        let sequence = 0;
        do {
          const data = Buffer.alloc(Math.min(FILE_CHUNK_BYTES, Math.max(0, before.size - position)));
          const { bytesRead } = await file.read(data, 0, data.length, position);
          if (bytesRead !== data.length) throw new RunnerError('output_changed', 'An output changed while it was being archived.');
          scanner.check(data);
          position += bytesRead;
          await write({ path: name, mode, sequence, final: position === before.size, data_base64: data.toString('base64') });
          sequence += 1;
        } while (position < before.size);
        const after = await file.stat();
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) throw new RunnerError('output_changed', 'An output changed while it was being archived.');
      } finally { await file.close(); }
    }
    await target.sync();
    await target.close();
    await rename(temporary, destination);
    return { digest: `sha256:${hash.digest('hex')}`, size_bytes: size, file_count: entries.length };
  } catch (error) {
    await target.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
}

function archivePath(path: string): boolean {
  return isSafeRelativePath(path) && path !== '.' && path.split('/').every((part) => part !== '.' && !part.endsWith('.') && !part.endsWith(' '));
}

const archiveFileSchema = z.strictObject({
  path: z.string().refine(archivePath), mode: z.union([z.literal(0o644), z.literal(0o755)]),
  sequence: z.number().int().min(0), final: z.boolean(),
  data_base64: z.string().max(FILE_CHUNK_BYTES * 4 / 3).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
const archiveEntrySchema = z.union([archiveFileSchema, z.strictObject({ type: z.literal('directory'), path: z.string().refine(path => path === '.' || archivePath(path)), mode: z.literal(0o755) })]);

async function* archiveLines(path: string, maximum: number, signal?: AbortSignal): AsyncGenerator<string> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let pending = '';
  let bytes = 0;
  const decoder = new StringDecoder('utf8');
  try {
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      throwIfAborted(signal);
      bytes += (chunk as Buffer).byteLength;
      if (bytes > maximum) throw new RunnerError('input_limit', 'The input archive exceeds its byte limit.');
      pending += decoder.write(chunk as Buffer);
      for (;;) {
        const end = pending.indexOf('\n');
        if (end < 0) break;
        if (end > 70_000) throw new RunnerError('archive_invalid', 'Archive record exceeds its limit.');
        yield pending.slice(0, end);
        pending = pending.slice(end + 1);
      }
      if (pending.length > 70_000) throw new RunnerError('archive_invalid', 'Archive record exceeds its limit.');
    }
    pending += decoder.end();
    if (pending) throw new RunnerError('archive_invalid', 'Archive has an incomplete final record.');
  } finally { await file.close(); }
}

/** Extracts into a new directory, publishing it only after all checks pass. */
export async function restoreArchive(archive: string, destination: string, expected: FileDigest, limits: ArchiveLimits, allowedPaths?: string[]): Promise<void> {
  const actual = await fileDigest(archive, limits.max_bytes, limits.signal);
  if (actual.digest !== expected.digest || actual.size_bytes !== expected.size_bytes) throw new RunnerError('input_checksum', 'Input archive checksum or length does not match its manifest.');
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  let header = false;
  let active: { path: string; mode: number; sequence: number; handle: Awaited<ReturnType<typeof open>> } | undefined;
  const completed = new Set<string>();
  const emptyDirectories = new Set<string>();
  let expandedBytes = 0;
  try {
    for await (const line of archiveLines(archive, limits.max_bytes, limits.signal)) {
      let value: unknown;
      try { value = JSON.parse(line); } catch { throw new RunnerError('archive_invalid', 'Archive contains invalid JSON.'); }
      if (!header) {
        if (canonicalJson(value) !== canonicalJson({ format: 'gitknot.files', version: 1 })) throw new RunnerError('archive_invalid', 'Unsupported archive version.');
        header = true;
        continue;
      }
      const parsed = archiveEntrySchema.safeParse(value);
      if (!parsed.success) throw new RunnerError('archive_invalid', 'Archive contains an invalid file record.');
      const entry = parsed.data;
      if (allowedPaths && !allowedPaths.some((path) => within(resolve(temporary, path), resolve(temporary, entry.path)))) throw new RunnerError('cache_scope', 'Cache content is outside its declared paths.');
      const folded = entry.path.toLowerCase();
      if ([...emptyDirectories].some(path => path === '.' || folded === path || folded.startsWith(`${path}/`))) throw new RunnerError('archive_invalid', 'An empty directory record conflicts with another archive entry.');
      if ('type' in entry) {
        if (active || completed.has(folded) || completed.size >= limits.max_files || [...completed].some(path => entry.path === '.' || path.startsWith(`${folded}/`))) throw new RunnerError('archive_invalid', 'Directory record repeats a path, contains entries, or exceeds the file count.');
        const target = await safeWorkspacePath(temporary, entry.path, true);
        await mkdir(target, { recursive: true, mode: 0o700 });
        if ((await readdir(target)).length) throw new RunnerError('archive_invalid', 'Declared empty directory is not empty.');
        await chmod(target, entry.mode);
        completed.add(folded); emptyDirectories.add(folded);
        continue;
      }
      if (!active) {
        if (entry.sequence !== 0 || completed.has(entry.path.toLowerCase()) || completed.size >= limits.max_files) throw new RunnerError('archive_invalid', 'Archive repeats a file or exceeds its file count.');
        const target = await safeWorkspacePath(temporary, entry.path, true);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        active = { path: entry.path, mode: entry.mode, sequence: 0, handle: await open(target, 'wx', 0o600) };
      }
      if (entry.path !== active.path || entry.mode !== active.mode || entry.sequence !== active.sequence) throw new RunnerError('archive_invalid', 'Archive file chunks are out of order.');
      const data = Buffer.from(entry.data_base64, 'base64');
      if (data.toString('base64') !== entry.data_base64 || (!entry.final && data.length !== FILE_CHUNK_BYTES)) throw new RunnerError('archive_invalid', 'Archive has a malformed file chunk.');
      expandedBytes += data.byteLength;
      if (expandedBytes > limits.max_bytes) throw new RunnerError('input_limit', 'Expanded input exceeds its byte limit.');
      await active.handle.writeFile(data);
      active.sequence += 1;
      if (entry.final) {
        await active.handle.chmod(entry.mode);
        await active.handle.sync();
        await active.handle.close();
        completed.add(entry.path.toLowerCase());
        active = undefined;
      }
    }
    if (!header || active) throw new RunnerError('archive_invalid', 'Archive is incomplete.');
    try { await lstat(destination); throw new RunnerError('input_exists', 'Input destination already exists.'); }
    catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
    await rename(temporary, destination);
  } catch (error) {
    await active?.handle.close().catch(() => {});
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function makeReadOnly(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await makeReadOnly(path);
    else if (entry.isFile()) await chmod(path, (await lstat(path)).mode & 0o111 ? 0o555 : 0o444);
    else throw new RunnerError('unsafe_input', 'Inputs must contain regular files and directories.');
  }
  await chmod(root, 0o555);
}
