import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { abortError, RunnerError, throwIfAborted } from './errors.ts';
import { SecretRedactor } from './redaction.ts';
import { createHash } from 'node:crypto';

export interface ProcessResult {
  exit_code: number | null;
  signal: string | null;
}

export interface ProcessGroup {
  pid: number;
  identity: string | null;
}

export interface ProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeout_ms: number;
  grace_ms?: number;
  secrets?: string[];
  onLog?: (bytes: Uint8Array) => Promise<void>;
  onGroup?: (group: ProcessGroup) => Promise<void>;
  max_output_bytes?: number;
  stdin?: string | Uint8Array;
  uid?: number;
  gid?: number;
}

export function cleanEnvironment(home: string, temporary = home): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? (process.platform === 'win32' ? '' : '/usr/local/bin:/usr/bin:/bin'),
    HOME: home, USERPROFILE: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', CI: 'true',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1',
  };
  for (const key of ['SystemRoot', 'WINDIR', 'PATHEXT', 'COMSPEC']) if (process.env[key]) result[key] = process.env[key];
  return result;
}

async function windowsKill(pid: number, force: boolean): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { stdio: 'ignore', windowsHide: true });
    child.once('error', () => reject(new RunnerError('termination_failed', 'Windows process-tree termination could not start.')));
    child.once('exit', () => resolve());
  });
}

export function groupAlive(pid: number): boolean {
  try { process.kill(process.platform === 'win32' ? pid : -pid, 0); return true; }
  catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return false;
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'EPERM') return true;
    const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
    throw new RunnerError('termination_failed', `Unable to inspect the job process group (${/^[A-Z0-9_]+$/.test(code) ? code : 'unknown'}).`);
  }
}

async function signalGroup(pid: number, force: boolean): Promise<boolean> {
  if (!groupAlive(pid)) return true;
  if (process.platform === 'win32') { await windowsKill(pid, force); return true; }
  try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); return true; }
  catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error) {
      if (error.code === 'ESRCH') return true;
      if (error.code === 'EPERM') return false;
    }
    throw new RunnerError('termination_failed', 'Unable to terminate the job process group.');
  }
}

export async function terminateGroup(pid: number, graceMs = 5_000): Promise<void> {
  if (!groupAlive(pid)) return;
  let signalled = await signalGroup(pid, false);
  const deadline = Date.now() + graceMs;
  while (groupAlive(pid) && Date.now() < deadline) {
    if (!signalled) signalled = await signalGroup(pid, false);
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  const killedDeadline = Date.now() + 1_000;
  while (groupAlive(pid) && Date.now() < killedDeadline) {
    await signalGroup(pid, true);
    await delay(20);
  }
  if (groupAlive(pid)) throw new RunnerError('termination_failed', 'The job process group is still present after forceful termination.');
}

/** Used only to establish identity for crash recovery, never to interpret job output. */
export async function processIdentity(pid: number): Promise<string | null> {
  if (process.platform === 'win32') return null;
  return new Promise((resolve) => {
    const child = spawn('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
    let output = '';
    const decoder = new StringDecoder('utf8');
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 1_000);
    child.stdout.on('data', (data: Buffer) => { if (output.length < 16_384) output += decoder.write(data); });
    child.once('error', () => { clearTimeout(timer); resolve(null); });
    child.once('close', (code) => { clearTimeout(timer); output += decoder.end(); resolve(code === 0 && output.trim() ? createHash('sha256').update(output.trim()).digest('hex') : null); });
  });
}

export async function runProcess(executable: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  throwIfAborted(options.signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal ? abortError(options.signal) : new RunnerError('cancelled', 'Execution was cancelled.'));
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new RunnerError('timed_out', 'A command exceeded its deadline.')), Math.max(1, options.timeout_ms));
  const child = spawn(executable, args, {
    cwd: options.cwd, env: options.env, detached: process.platform !== 'win32',
    stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true,
    uid: options.uid, gid: options.gid,
  });
  child.stdin?.on('error', () => {}); // An exited child may close its control input before it is flushed.
  if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  let termination: Promise<void> | undefined;
  const stop = () => {
    if (!child.pid || termination) return;
    termination = terminateGroup(child.pid, options.grace_ms);
    termination.catch(() => {});
  };
  controller.signal.addEventListener('abort', stop, { once: true });
  let rawBytes = 0;
  let outputQueue: Promise<void> = Promise.resolve();
  const emit = async (text: string) => {
    if (!text || !options.onLog) return;
    const bytes = Buffer.from(text);
    outputQueue = outputQueue.then(() => options.onLog!(bytes));
    await outputQueue;
  };
  const consume = async (stream: NodeJS.ReadableStream) => {
    const decoder = new StringDecoder('utf8');
    const redactor = new SecretRedactor(options.secrets);
    for await (const data of stream) {
      const bytes = data as Buffer;
      rawBytes += bytes.byteLength;
      if (rawBytes > (options.max_output_bytes ?? 16_777_216)) throw new RunnerError('log_limit', 'The command exceeded its log byte limit.');
      await emit(redactor.write(decoder.write(bytes)));
    }
    await emit(redactor.write(decoder.end()) + redactor.finish());
  };
  const exited = new Promise<ProcessResult>((resolve, reject) => {
    child.once('error', () => reject(new RunnerError('process_start_failed', 'A required executable could not be started.')));
    child.once('exit', (code, signal) => resolve({ exit_code: code, signal }));
  });
  const streams = Promise.all([consume(child.stdout!), consume(child.stderr!)]).catch((error: unknown) => {
    controller.abort(error instanceof RunnerError ? error : new RunnerError('log_upload_failed', 'Command output could not be delivered.'));
    throw error;
  });
  // Both promises have rejection handlers before any awaited journal I/O.
  const completion = Promise.all([exited, streams]);
  completion.catch(() => {});
  try {
    if (child.pid && options.onGroup) await options.onGroup({ pid: child.pid, identity: await processIdentity(child.pid) });
    if (controller.signal.aborted) stop();
    const [result] = await completion;
    if (controller.signal.aborted) throw abortError(controller.signal);
    return result;
  } catch (error) {
    stop();
    await termination;
    if (controller.signal.aborted) {
      const reason = abortError(controller.signal);
      const result = await exited.catch(() => ({ exit_code: null, signal: null }));
      throw new RunnerError(reason.code, reason.message, { ...reason.details, exit_code: result.exit_code, signal: result.signal });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    controller.signal.removeEventListener('abort', stop);
    await termination;
    // Readers must be closed even when spawn or journal persistence fails.
    child.stdout?.destroy();
    child.stderr?.destroy();
    await completion.catch(() => {});
  }
}

export async function captureProcess(executable: string, args: string[], options: Omit<ProcessOptions, 'onLog'>): Promise<{ output: string } & ProcessResult> {
  let output = '';
  const result = await runProcess(executable, args, { ...options, max_output_bytes: options.max_output_bytes ?? 65_536, onLog: async (bytes) => { output += Buffer.from(bytes).toString('utf8'); } });
  return { ...result, output };
}

export function shellCommand(shell: 'sh' | 'bash' | 'pwsh' | 'cmd', script: string): [string, string[]] {
  if (shell === 'bash') return ['bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script]];
  if (shell === 'pwsh') return ['pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop';\n${script}\nif ($LASTEXITCODE) { exit $LASTEXITCODE }`]];
  if (shell === 'cmd') return [process.env.COMSPEC ?? 'cmd.exe', ['/d', '/s', '/c', script]];
  return ['sh', ['-e', '-c', script]];
}
