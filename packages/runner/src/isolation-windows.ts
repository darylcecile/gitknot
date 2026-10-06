import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { RunnerError } from './errors.ts';
import { decodeUtf8 } from './encoding.ts';
import { assertOutsideRepository, atomicWrite, readJsonFile } from './files.ts';
import { captureProcess, cleanEnvironment, runProcess, type ProcessOptions, type ProcessResult } from './process.ts';
import type { IsolationContext, IsolationRecord, JobIsolation, RunnerIsolation } from './isolation-types.ts';
import { windowsHelper } from './windows-helper.ts';

type WindowsConfiguration = Extract<RunnerIsolation, { type: 'windows_user' }>;
const credentialsSchema = z.strictObject({ username: z.string().regex(/^[^\\/@\x00-\x1f]{1,128}$/), domain: z.string().regex(/^[a-zA-Z0-9_.-]{1,128}$/).default('.'), password: z.string().min(1).max(1024) });
type WindowsCredentials = z.infer<typeof credentialsSchema>;

function powershell(): string { return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'); }
async function helperArguments(action: 'Keeper' | 'Command' | 'Inspect' | 'Recover', control: string): Promise<string[]> {
  const script = join(control, `windows-${action.toLowerCase()}.ps1`);
  await atomicWrite(script, windowsHelper(action));
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];
}

async function credentials(config: WindowsConfiguration): Promise<WindowsCredentials> {
  if (process.platform !== 'win32') throw new RunnerError('isolation_platform', 'Windows native isolation requires a Windows service supervisor.');
  if (!isAbsolute(config.credential_file)) throw new RunnerError('credential_location', 'The Windows execution credential file must use an absolute private path.');
  await assertOutsideRepository(config.credential_file);
  const parsed = credentialsSchema.safeParse(await readJsonFile(config.credential_file, 16_384, true));
  if (!parsed.success) throw new RunnerError('isolation_account', 'The Windows batch-logon account credential file is invalid.');
  return parsed.data;
}

async function invoke(action: 'Inspect' | 'Recover', credential: WindowsCredentials, more: Record<string, unknown>, control: string): Promise<string> {
  const result = await captureProcess(powershell(), await helperArguments(action, control), { cwd: control, env: cleanEnvironment(control), stdin: JSON.stringify({ ...credential, ...more }) + '\n', timeout_ms: 30_000, secrets: [credential.password], max_output_bytes: 65_536 });
  if (result.exit_code !== 0) throw new RunnerError('isolation_account', 'Windows native isolation could not verify the dedicated nonadministrator batch-logon account and service privileges.');
  return result.output.trim();
}

async function grant(path: string, sid: string, rights: string, control: string, recursive = false): Promise<void> {
  const result = await captureProcess(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [path, '/grant:r', `*${sid}:${rights}`, ...(recursive ? ['/T'] : []), '/Q'], { cwd: control, env: cleanEnvironment(control), timeout_ms: 30_000 });
  if (result.exit_code !== 0) throw new RunnerError('isolation_permissions', 'The supervisor could not set execution-user access to the job files.');
}

async function executablePath(executable: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (isAbsolute(executable)) return executable;
  if (/[/\\]/.test(executable)) throw new RunnerError('isolation_executable', 'Native executable names must be absolute or ordinary PATH commands.');
  for (const path of (env.PATH ?? '').split(';').filter(isAbsolute)) {
    for (const extension of executable.endsWith('.exe') ? [''] : ['.exe', '']) {
      const candidate = join(path, executable + extension);
      try { await access(candidate, constants.R_OK); return candidate; } catch {}
    }
  }
  throw new RunnerError('process_start_failed', 'A required Windows executable could not be resolved from its toolchain.');
}

export class WindowsUserIsolation implements JobIsolation {
  private readonly id = `Local\\gitknot-${randomUUID()}`;
  private credential: WindowsCredentials | undefined;
  private sid = '';
  private keeper: ChildProcessWithoutNullStreams | undefined;
  private exit: Promise<number | null> | undefined;
  private stopping: Promise<void> | undefined;
  constructor(private readonly configuration: WindowsConfiguration, private readonly context: IsolationContext) {}
  path(path: string): string { return path; }
  environment(): NodeJS.ProcessEnv { return cleanEnvironment(this.context.home); }

  async prepare(): Promise<void> {
    this.credential = await credentials(this.configuration);
    this.sid = await invoke('Inspect', this.credential, {}, this.context.control);
    if (!/^S-1-[0-9-]+$/.test(this.sid)) throw new RunnerError('isolation_account', 'Windows returned an invalid job account identity.');
    await mkdir(this.context.inputs, { recursive: true });
    await grant(dirname(this.context.directory), this.sid, '(RX)', this.context.control);
    await grant(this.context.directory, this.sid, '(RX)', this.context.control);
    await grant(this.context.workspace, this.sid, '(OI)(CI)M', this.context.control, true);
    await grant(this.context.home, this.sid, '(OI)(CI)M', this.context.control, true);
    await this.context.onRecord?.({ type: 'windows_user', id: this.id });
    const child = spawn(powershell(), await helperArguments('Keeper', this.context.control), { cwd: this.context.control, env: cleanEnvironment(this.context.control), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.keeper = child;
    this.exit = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', () => reject(new RunnerError('isolation_unavailable', 'The Windows Job Object supervisor could not start.'))); });
    this.exit.catch(() => {});
    child.stdin.on('error', () => {}); child.stdin.write(`${JSON.stringify({ ...this.credential, job_name: this.id, deadline_at: this.context.deadline_at })}\n`);
    await new Promise<void>((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new RunnerError('isolation_unavailable', 'The Windows Job Object supervisor did not become ready.')), 20_000);
      child.stdout.on('data', (bytes: Buffer) => { text += decodeUtf8(bytes); if (text.trim() === 'ready') { clearTimeout(timer); resolve(); } else if (text.length > 1024) { clearTimeout(timer); reject(new RunnerError('isolation_unavailable', 'Invalid Windows supervisor response.')); } });
      child.stderr.resume();
      this.exit!.then(() => { clearTimeout(timer); reject(new RunnerError('isolation_unavailable', 'The Windows Job Object supervisor failed before execution.')); }, reject);
    });
  }

  async grantInputs(): Promise<void> { await grant(this.context.inputs, this.sid, '(OI)(CI)RX', this.context.control, true); }

  async run(executable: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
    if (!this.credential || !this.keeper || this.keeper.exitCode !== null || this.stopping) throw new RunnerError('isolation_stopped', 'The Windows Job Object supervisor is not running.');
    const app = await executablePath(executable, options.env);
    const timeout = AbortSignal.timeout(options.timeout_ms);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    let stopping: Promise<void> | undefined;
    const stop = () => { stopping ??= this.stop(); stopping.catch(() => {}); };
    signal.addEventListener('abort', stop, { once: true });
    try {
      return await runProcess(powershell(), await helperArguments('Command', this.context.control), { ...options, signal, cwd: this.context.control, env: cleanEnvironment(this.context.control), secrets: [...(options.secrets ?? []), this.credential.password], stdin: JSON.stringify({ ...this.credential, job_name: this.id, executable: app, args, env: options.env, cwd: options.cwd }) + '\n' });
    } finally { signal.removeEventListener('abort', stop); await stopping; }
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.keeper?.stdin.end('stop\n');
      if (this.exit && await this.exit !== 0) throw new RunnerError('cleanup_failed', 'The Windows supervisor could not confirm native process cleanup.');
      if (this.credential) await invoke('Recover', this.credential, { job_name: this.id }, this.context.control);
      await this.context.onRecord?.(null);
    })();
    return this.stopping;
  }
}

export async function recoverWindowsUser(config: WindowsConfiguration, record: IsolationRecord, control: string): Promise<void> {
  if (record.type !== 'windows_user' || !/^Local\\gitknot-[a-f0-9-]{36}$/.test(record.id)) throw new RunnerError('isolation_identity', 'Invalid Windows Job Object journal identity.');
  await invoke('Recover', await credentials(config), { job_name: record.id }, control);
}
