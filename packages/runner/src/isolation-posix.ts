import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { lstatSync, realpathSync } from 'node:fs';
import { chmod, chown, lstat, mkdir, readdir } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { RunnerError } from './errors.ts';
import { decodeUtf8 } from './encoding.ts';
import { captureProcess, cleanEnvironment, runProcess, type ProcessOptions, type ProcessResult } from './process.ts';
import type { IsolationContext, IsolationRecord, JobIsolation, RunnerIsolation } from './isolation-types.ts';

type PosixConfiguration = Extract<RunnerIsolation, { type: 'posix_user' }>;

export function requireRootSupervisor(config: PosixConfiguration): void {
  if (process.platform === 'win32' || process.geteuid?.() !== 0 || config.uid === process.geteuid() || config.gid === 0) throw new RunnerError('isolation_identity', 'Native POSIX execution requires a root supervisor and a distinct dedicated unprivileged job UID/GID.');
  for (const executable of [process.execPath, fileURLToPath(import.meta.url), ...(process.argv[1] ? [resolve(process.argv[1])] : [])]) {
    let path = executable;
    for (;;) {
      const info = lstatSync(path);
      const stickyDirectory = info.isDirectory() && (info.mode & 0o1000) !== 0;
      if (info.uid === config.uid || !info.isSymbolicLink() && !stickyDirectory && (info.mode & 0o002 || info.gid === config.gid && info.mode & 0o020)) throw new RunnerError('isolation_supervisor_writable', 'The execution account must not own or be able to replace supervisor code or its executable-path ancestors.');
      const parent = dirname(path); if (parent === path) break; path = parent;
    }
  }
  for (const path of (process.env.PATH ?? '/usr/bin:/bin').split(delimiter)) {
    if (!isAbsolute(path)) throw new RunnerError('isolation_supervisor_path', 'The native supervisor PATH cannot include the current directory or relative entries.');
    let directory;
    try { directory = realpathSync(path); } catch { continue; }
    const info = lstatSync(directory);
    if (info.uid === config.uid || info.mode & 0o002 || info.gid === config.gid && info.mode & 0o020) throw new RunnerError('isolation_supervisor_path', 'The execution account must not be able to modify supervisor executable search paths.');
  }
}

async function userProcesses(uid: number): Promise<number[]> {
  const result = await captureProcess('/bin/ps', ['-axo', 'uid=,pid=,stat='], { cwd: '/', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout_ms: 10_000, max_output_bytes: 4_194_304 });
  if (result.exit_code !== 0) throw new RunnerError('isolation_processes', 'The supervisor could not inspect the dedicated execution account.');
  return result.output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    return match && Number(match[1]) === uid && !match[3]!.startsWith('Z') ? [Number(match[2])] : [];
  });
}

export async function stopUserProcesses(configuration: PosixConfiguration, graceMs: number): Promise<void> {
  requireRootSupervisor(configuration);
  const grace = Date.now() + graceMs;
  const deadline = grace + 3_000;
  for (;;) {
    const pids = await userProcesses(configuration.uid);
    if (!pids.length) return;
    if (Date.now() >= deadline) throw new RunnerError('cleanup_failed', 'The dedicated execution user still owns live processes after cleanup.');
    for (const pid of pids) {
      try { process.kill(pid, Date.now() < grace ? 'SIGTERM' : 'SIGKILL'); }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) throw new RunnerError('cleanup_failed', 'An execution-user process could not be terminated.'); }
    }
    await delay(40);
  }
}

async function changeOwner(root: string, uid: number, gid: number): Promise<void> {
  const info = await lstat(root);
  if (info.isSymbolicLink()) return;
  await chown(root, uid, gid);
  if (info.isDirectory()) {
    await chmod(root, 0o700);
    for (const entry of await readdir(root)) await changeOwner(join(root, entry), uid, gid);
  }
}

async function readableInputs(root: string, gid: number): Promise<void> {
  const info = await lstat(root);
  if (info.isSymbolicLink()) throw new RunnerError('unsafe_input', 'Input tree contains a symbolic link.');
  await chown(root, 0, gid);
  await chmod(root, info.isDirectory() || info.mode & 0o111 ? 0o550 : 0o440);
  if (info.isDirectory()) for (const entry of await readdir(root)) await readableInputs(join(root, entry), gid);
}

async function safeExecutionPath(configuration: PosixConfiguration): Promise<string> {
  const paths: string[] = [];
  for (const path of (process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(delimiter)) {
    if (!isAbsolute(path)) continue;
    let info;
    try { info = await lstat(path); } catch { continue; }
    if (info.isSymbolicLink()) continue;
    if (!info.isDirectory() || info.uid === configuration.uid || info.mode & 0o002 || (info.gid === configuration.gid && info.mode & 0o020)) continue;
    paths.push(path);
  }
  if (!paths.length) throw new RunnerError('isolation_toolchain_path', 'No supervisor-controlled executable directories are available to the job.');
  return paths.join(delimiter);
}

function watchdogScript(uid: number, deadline: number, graceMs: number): string {
  return String.raw`const {execFileSync}=require('node:child_process');const uid=${uid};let stopping=false;const list=()=>execFileSync('/bin/ps',['-axo','uid=,pid=,stat='],{encoding:'utf8',maxBuffer:4194304,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}}).split('\n').flatMap(s=>{const m=/^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(s);return m&&Number(m[1])===uid&&!m[3].startsWith('Z')?[Number(m[2])]:[]});async function stop(){if(stopping)return;stopping=true;const soft=Date.now()+${graceMs};const hard=soft+3000;try{for(;;){const ids=list();if(!ids.length)process.exit(0);if(Date.now()>hard)process.exit(1);for(const id of ids){try{process.kill(id,Date.now()<soft?'SIGTERM':'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e}}await new Promise(r=>setTimeout(r,40))}}catch{process.exit(1)}}process.stdin.resume();process.stdin.on('end',stop);process.stdin.on('data',stop);process.on('SIGTERM',stop);process.on('SIGINT',stop);setInterval(()=>{if(Date.now()>=${Math.floor(deadline)})stop()},100);process.stdout.write('ready\n');`;
}

export class PosixUserIsolation implements JobIsolation {
  private watchdog: ChildProcessWithoutNullStreams | undefined;
  private watchdogExit: Promise<number | null> | undefined;
  private executionPath = '';
  private stopping: Promise<void> | undefined;
  constructor(private readonly configuration: PosixConfiguration, private readonly context: IsolationContext) {}
  path(path: string): string { return path; }
  environment(): NodeJS.ProcessEnv { return { ...cleanEnvironment(this.context.home), PATH: this.executionPath }; }

  async prepare(): Promise<void> {
    requireRootSupervisor(this.configuration);
    if ((await userProcesses(this.configuration.uid)).length) throw new RunnerError('isolation_user_busy', 'The dedicated job account already owns processes. Recover its prior attempt or use an unused execution account.');
    this.executionPath = await safeExecutionPath(this.configuration);
    await mkdir(this.context.inputs, { recursive: true, mode: 0o755 });
    // Only these two parents gain traversal; supervisor state and control remain private.
    await chmod(dirname(this.context.directory), 0o711); await chmod(this.context.directory, 0o711);
    await Promise.all([changeOwner(this.context.workspace, this.configuration.uid, this.configuration.gid), changeOwner(this.context.home, this.configuration.uid, this.configuration.gid)]);
    let ancestor = dirname(dirname(this.context.directory));
    for (;;) {
      const info = await lstat(ancestor);
      const execute = info.uid === this.configuration.uid ? 0o100 : info.gid === this.configuration.gid ? 0o010 : 0o001;
      if (!(info.mode & execute)) throw new RunnerError('isolation_permissions', 'The execution account cannot traverse the configured work-directory ancestors. Provision a separate work root with traversal access.');
      const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
    }
    await this.context.onRecord?.({ type: 'posix_user', id: `${this.configuration.uid}:${this.configuration.gid}` });
    this.watchdog = spawn(process.execPath, ['-e', watchdogScript(this.configuration.uid, this.context.deadline_at, this.context.grace_ms)], { cwd: this.context.control, env: cleanEnvironment(this.context.control), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const child = this.watchdog;
    child.stdin.on('error', () => {});
    child.stderr.resume();
    this.watchdogExit = new Promise((resolve, reject) => { child.once('error', () => reject(new RunnerError('isolation_watchdog', 'The privileged execution watchdog could not start.'))); child.once('exit', resolve); });
    this.watchdogExit.catch(() => {});
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new RunnerError('isolation_watchdog', 'The execution watchdog did not become ready.')), 5_000);
      child.stdout.once('data', (bytes: Buffer) => { clearTimeout(timeout); if (decodeUtf8(bytes) === 'ready\n') resolve(); else reject(new RunnerError('isolation_watchdog', 'Invalid watchdog startup response.')); });
      this.watchdogExit!.then(() => { clearTimeout(timeout); reject(new RunnerError('isolation_watchdog', 'The execution watchdog stopped unexpectedly.')); }, reject);
    });
  }

  async grantInputs(): Promise<void> { await readableInputs(this.context.inputs, this.configuration.gid); }

  run(executable: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
    if (!this.watchdog || this.watchdog.exitCode !== null || this.stopping) throw new RunnerError('isolation_stopped', 'The credential-protecting supervisor is not active.');
    if (process.platform === 'linux') {
      const environment = Object.entries({ ...this.environment(), ...options.env }).filter((entry): entry is [string, string] => entry[1] !== undefined).map(([name, value]) => `${name}=${value}`);
      // No job-controlled loader setting (LD_PRELOAD, LD_AUDIT, etc.) reaches the privileged setpriv executable.
      return runProcess('/usr/bin/setpriv', ['--no-new-privs', '--reuid', String(this.configuration.uid), '--regid', String(this.configuration.gid), '--clear-groups', '--bounding-set=-all', '--inh-caps=-all', '--ambient-caps=-all', '--', '/usr/bin/env', '-i', '--', ...environment, executable, ...args], { ...options, env: cleanEnvironment(this.context.control) });
    }
    return runProcess(executable, args, { ...options, uid: this.configuration.uid, gid: this.configuration.gid, env: { ...this.environment(), ...options.env } });
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      if (this.watchdog) this.watchdog.stdin.end('stop\n');
      await stopUserProcesses(this.configuration, this.context.grace_ms);
      if (this.watchdogExit && await this.watchdogExit !== 0) throw new RunnerError('cleanup_failed', 'The isolated native process watchdog could not confirm cleanup.');
      await this.context.onRecord?.(null);
    })();
    return this.stopping;
  }
}

export async function recoverPosixUser(configuration: PosixConfiguration, record: IsolationRecord, graceMs: number): Promise<void> {
  if (record.type !== 'posix_user' || record.id !== `${configuration.uid}:${configuration.gid}`) throw new RunnerError('isolation_identity', 'Execution-user recovery identity differs from its journal.');
  await stopUserProcesses(configuration, graceMs);
}
