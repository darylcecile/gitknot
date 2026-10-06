import { constants } from 'node:fs';
import { Buffer } from 'node:buffer';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isSafeRelativePath } from '../../workflows/src/index.ts';
import { RunnerError } from './errors.ts';
import { decodeUtf8 } from './encoding.ts';

const runFile = promisify(execFile);
let windowsSid: string | undefined;

async function restrictWindowsAccess(path: string, directory: boolean): Promise<void> {
  if (process.platform !== 'win32') return;
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  try {
    if (!windowsSid) {
      const result = await runFile(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { timeout: 5_000, maxBuffer: 16_384, windowsHide: true });
      windowsSid = result.stdout.match(/S-1-[0-9]+(?:-[0-9]+)+/)?.[0];
      if (!windowsSid) throw new Error('SID unavailable');
    }
    const executable = join(system, 'icacls.exe');
    await runFile(executable, [path, '/reset', '/q'], { timeout: 5_000, maxBuffer: 16_384, windowsHide: true });
    await runFile(executable, [path, '/inheritancelevel:r', '/grant:r', `*${windowsSid}:${directory ? '(OI)(CI)' : ''}F`, '/q'], { timeout: 5_000, maxBuffer: 16_384, windowsHide: true });
  } catch { throw new RunnerError('unsafe_credential_permissions', 'GitKnot could not establish a current-user-only Windows access control list.'); }
}

export function within(parent: string, child: string): boolean {
  const path = relative(resolve(parent), resolve(child));
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

export async function assertOutsideRepository(path: string): Promise<void> {
  let cursor = resolve(path);
  for (;;) {
    try {
      await lstat(join(cursor, '.git'));
      throw new RunnerError('credential_location', 'Credentials and runner state must be outside a Git workspace.');
    } catch (error) {
      if (!isFsError(error, 'ENOENT') && !isFsError(error, 'ENOTDIR')) throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

export function configDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GITKNOT_CONFIG_DIR) return resolve(env.GITKNOT_CONFIG_DIR);
  if (process.platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'GitKnot');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'gitknot');
}

export function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GITKNOT_STATE_DIR) return resolve(env.GITKNOT_STATE_DIR);
  if (process.platform === 'win32') return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'GitKnot');
  return join(env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'gitknot');
}

export function isFsError(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}

export async function privateDirectory(path: string, outsideRepository = true): Promise<string> {
  const absolute = resolve(path);
  if (outsideRepository) await assertOutsideRepository(absolute);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const info = await lstat(absolute);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new RunnerError('unsafe_state_directory', 'GitKnot state must be a real, owner-controlled directory.');
  if (process.getuid && info.uid !== process.getuid()) throw new RunnerError('unsafe_state_owner', 'GitKnot state is owned by another user.');
  await chmod(absolute, 0o700);
  await restrictWindowsAccess(absolute, true);
  const canonical = await realpath(absolute);
  if (outsideRepository) await assertOutsideRepository(canonical);
  return canonical;
}

export async function atomicWrite(path: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new RunnerError('unsafe_state_file', 'Refusing to replace a symbolic-link state file.');
  } catch (error) {
    if (!isFsError(error, 'ENOENT')) throw error;
  }
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
  try {
    await restrictWindowsAccess(temporary, false);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    await chmod(path, mode);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  }
}

export function atomicJson(path: string, value: unknown): Promise<void> {
  return atomicWrite(path, `${JSON.stringify(value)}\n`);
}

export async function readBounded(path: string, maximum: number, privateFile = false): Promise<Buffer> {
  if ((await lstat(path)).isSymbolicLink()) throw new RunnerError('unsafe_state_file', 'Symbolic-link input files are not accepted.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum) throw new RunnerError('file_limit', 'Expected a regular file within the declared byte limit.');
    if (privateFile && info.nlink > 1) throw new RunnerError('unsafe_credential_permissions', 'Private credential and state files cannot have additional hard links.');
    if (privateFile) await restrictWindowsAccess(path, false);
    if (privateFile && process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))) throw new RunnerError('unsafe_credential_permissions', 'Credential files must be owned by the current user with mode 0600.');
    const pieces: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += (chunk as Buffer).byteLength;
      if (bytes > maximum) throw new RunnerError('file_limit', 'File grew beyond its declared byte limit.');
      pieces.push(chunk as Buffer);
    }
    return Buffer.concat(pieces);
  } finally { await handle.close(); }
}

export async function readJsonFile(path: string, maximum = 1_048_576, privateFile = false): Promise<unknown> {
  const content = await readBounded(path, maximum, privateFile);
  try { return JSON.parse(decodeUtf8(content)); }
  catch { throw new RunnerError('json_invalid', 'Expected a valid JSON document.'); }
}

/** Checks every existing path component; realpath alone would follow an output symlink. */
export async function safeWorkspacePath(root: string, path: string, allowMissing = false): Promise<string> {
  if (!isSafeRelativePath(path)) throw new RunnerError('unsafe_path', 'Expected a safe workspace-relative path.');
  const target = resolve(root, path);
  if (!within(root, target)) throw new RunnerError('unsafe_path', 'Path escapes the workspace.');
  let cursor = resolve(root);
  for (const segment of relative(root, target).split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new RunnerError('unsafe_symlink', 'Symbolic links cannot be used for working directories, caches, inputs, or outputs.');
    } catch (error) {
      if (allowMissing && isFsError(error, 'ENOENT')) continue;
      throw error;
    }
  }
  return target;
}

export async function removeAndVerify(path: string): Promise<void> {
  const writable = async (directory: string): Promise<void> => {
    let info;
    try { info = await lstat(directory); } catch (error) { if (isFsError(error, 'ENOENT')) return; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await writable(join(directory, entry.name));
  };
  await writable(path);
  await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  try { await lstat(path); }
  catch (error) { if (isFsError(error, 'ENOENT')) return; throw error; }
  throw new RunnerError('cleanup_failed', 'The job workspace could not be removed.');
}

export async function directoryEntries(path: string): Promise<string[]> {
  try { return (await readdir(path)).sort(); }
  catch (error) { if (isFsError(error, 'ENOENT')) return []; throw error; }
}

export async function takeLock(directory: string): Promise<() => Promise<void>> {
  await privateDirectory(directory);
  const path = join(directory, 'runner.lock');
  const guardPath = join(directory, 'runner.acquire.lock');
  const owner = { pid: process.pid, nonce: randomUUID() };
  let guard;
  try { guard = await open(guardPath, 'wx', 0o600); }
  catch (error) {
    if (isFsError(error, 'EEXIST')) throw new RunnerError('runner_locked', 'Another process is acquiring the runner lock. If acquisition was interrupted, inspect and remove the stale acquisition lock before restarting.');
    throw error;
  }
  try {
    await guard.writeFile(JSON.stringify(owner)); await guard.sync();
    try {
      const current = await readJsonFile(path, 4096, true) as { pid?: unknown };
      if (!Number.isSafeInteger(current.pid) || Number(current.pid) < 1) throw new RunnerError('runner_locked', 'Runner state has an invalid lock; inspect it before restarting.');
      try { process.kill(Number(current.pid), 0); throw new RunnerError('runner_locked', 'Another runner process already owns this state directory.'); }
      catch (error) { if (!isFsError(error, 'ESRCH')) throw error; }
      await rm(path);
    } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
    try {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); } finally { await handle.close(); }
      return async () => {
        const current = await readJsonFile(path, 4096, true) as { nonce?: string };
        if (current.nonce !== owner.nonce) throw new RunnerError('lock_lost', 'Runner state lock ownership changed.');
        await rm(path);
      };
    } catch (error) {
      if (isFsError(error, 'EEXIST')) throw new RunnerError('runner_locked', 'Another runner process already owns this state directory.');
      throw error;
    }
  } finally {
    await guard.close(); await rm(guardPath);
  }
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}
