import { chmod, lstat, mkdir, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunnerError, throwIfAborted } from './errors.ts';
import { within } from './files.ts';
import { captureProcess, cleanEnvironment, runProcess, type ProcessOptions, type ProcessResult } from './process.ts';
import type { IsolationContext, IsolationRecord, JobIsolation, RunnerIsolation } from './isolation-types.ts';

type OciConfiguration = Extract<RunnerIsolation, { type: 'oci' }>;
const LABEL = 'com.gitknot.runner.isolation';

function engineEnvironment(): NodeJS.ProcessEnv {
  // Only the trusted engine CLI receives engine config. It is never mounted or inherited by jobs.
  const env = cleanEnvironment(homedir());
  for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'CONTAINER_HOST', 'XDG_RUNTIME_DIR']) if (process.env[name]) env[name] = process.env[name];
  return env;
}

async function engine(config: OciConfiguration, args: string[], options: { signal?: AbortSignal; timeout_ms?: number } = {}): Promise<{ output: string } & ProcessResult> {
  return captureProcess(config.engine, args, { cwd: homedir(), env: engineEnvironment(), timeout_ms: options.timeout_ms ?? 30_000, signal: options.signal, max_output_bytes: 1_048_576 });
}

async function checked(config: OciConfiguration, args: string[], options: { signal?: AbortSignal; timeout_ms?: number } = {}): Promise<string> {
  const result = await engine(config, args, options);
  if (result.exit_code !== 0 || result.signal) throw new RunnerError('isolation_unavailable', 'The configured container engine could not perform the required isolated operation.');
  return result.output.trim();
}

export async function inspectIsolationImage(configuration: OciConfiguration): Promise<{ image_id: string; os: 'linux'; arch: 'x64' | 'arm64' }> {
  const output = await checked(configuration, ['image', 'inspect', '--format', '{{json .}}', configuration.image]);
  let info: { Id?: string; RepoDigests?: string[]; Os?: string; Architecture?: string };
  try { info = JSON.parse(output) as typeof info; } catch { throw new RunnerError('isolation_image_invalid', 'Container engine returned invalid image metadata.'); }
  const registryDigest = configuration.image.includes('@') ? configuration.image.slice(configuration.image.lastIndexOf('@')) : null;
  if (!info.Id || !/^sha256:[a-f0-9]{64}$/.test(info.Id) || (configuration.image !== info.Id && !info.RepoDigests?.some(reference => registryDigest !== null && reference.endsWith(registryDigest)))) throw new RunnerError('isolation_image_mismatch', 'The local image does not match its configured immutable digest.');
  if (info.Os !== 'linux' || !['amd64', 'arm64'].includes(info.Architecture ?? '')) throw new RunnerError('isolation_platform', 'The OCI backend requires a Linux/x64 or Linux/arm64 image. Native platforms use a dedicated OS user.');
  return { image_id: info.Id, os: 'linux', arch: info.Architecture === 'amd64' ? 'x64' : 'arm64' };
}

async function writableByJob(root: string): Promise<void> {
  const info = await lstat(root);
  if (info.isSymbolicLink()) return;
  await chmod(root, info.isDirectory() ? 0o777 : info.mode & 0o111 ? 0o777 : 0o666);
  if (info.isDirectory()) for (const entry of await readdir(root)) await writableByJob(join(root, entry));
}

async function present(config: OciConfiguration, id: string): Promise<boolean> {
  if (!/^gitknot-[a-f0-9-]{36}$/.test(id)) throw new RunnerError('isolation_identity', 'Invalid durable container identity.');
  const output = await checked(config, ['container', 'ls', '--all', '--filter', `name=^/${id}$`, '--format', '{{.Names}}']);
  if (!output) return false;
  if (output !== id) throw new RunnerError('isolation_identity', 'Container identity lookup is ambiguous.');
  const label = await checked(config, ['container', 'inspect', '--format', `{{index .Config.Labels "${LABEL}"}}`, id]);
  if (label !== id) throw new RunnerError('isolation_identity', 'Container ownership label does not match the journal.');
  return true;
}

export async function removeIsolationContainer(config: OciConfiguration, record: IsolationRecord, graceMs: number): Promise<void> {
  if (record.type !== 'oci') throw new RunnerError('isolation_identity', 'The journal requires a different isolation backend.');
  if (!await present(config, record.id)) return;
  const stopped = await engine(config, ['container', 'stop', '--time', String(Math.ceil(graceMs / 1000)), record.id], { timeout_ms: graceMs + 15_000 });
  if (stopped.exit_code !== 0 && !await present(config, record.id)) return;
  const removed = await engine(config, ['container', 'rm', '--force', '--volumes', record.id]);
  if (removed.exit_code !== 0 || await present(config, record.id)) throw new RunnerError('cleanup_failed', 'Container destruction could not be verified. The runner cannot accept another job.');
}

export class OciIsolation implements JobIsolation {
  private readonly id = `gitknot-${randomUUID()}`;
  private allocated = false;
  private stopped = false;
  private stopping: Promise<void> | undefined;
  private imageId = '';
  constructor(private readonly configuration: OciConfiguration, private readonly context: IsolationContext) {}

  path(path: string): string {
    for (const [host, guest] of [[this.context.workspace, '/gitknot/source'], [this.context.home, '/gitknot/home'], [this.context.inputs, '/gitknot/inputs']] as const) {
      if (within(host, path)) return `${guest}${relative(host, path) ? `/${relative(host, path).split(sep).join('/')}` : ''}`;
    }
    throw new RunnerError('isolation_path', 'A process path is outside the declared job mounts.');
  }

  environment(): NodeJS.ProcessEnv {
    return { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/gitknot/home', USERPROFILE: '/gitknot/home', TMPDIR: '/gitknot/home/tmp', TMP: '/gitknot/home/tmp', TEMP: '/gitknot/home/tmp', CI: 'true', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '/gitknot/source' };
  }

  async prepare(): Promise<void> {
    throwIfAborted(this.context.signal);
    const inspected = await inspectIsolationImage(this.configuration); this.imageId = inspected.image_id;
    await Promise.all([mkdir(this.context.inputs, { recursive: true, mode: 0o755 }), mkdir(join(this.context.home, 'tmp'), { recursive: true, mode: 0o700 })]);
    await writableByJob(this.context.workspace); await writableByJob(this.context.home);
    for (const path of [this.context.workspace, this.context.home, this.context.inputs]) if (/[\r\n,]/.test(path)) throw new RunnerError('isolation_path', 'Container mount paths cannot contain comma or control characters.');
    // The record precedes the create request, so an uncertain create remains recoverable by name.
    await this.context.onRecord?.({ type: 'oci', id: this.id }); this.allocated = true;
    const keeper = `const deadline=${Math.floor(this.context.deadline_at)};const timer=setInterval(()=>{if(Date.now()>=deadline)process.exit(124)},100);process.on('SIGTERM',()=>process.exit(143));`;
    await checked(this.configuration, ['container', 'create', '--name', this.id, '--label', `${LABEL}=${this.id}`, '--pull=never', '--init', '--no-healthcheck', '--read-only', '--cap-drop=ALL', '--security-opt', 'no-new-privileges=true', '--pids-limit', String(this.configuration.pids), '--memory', `${this.configuration.memory_mb}m`, '--memory-swap', `${this.configuration.memory_mb}m`, '--cpus', String(this.configuration.cpus), '--network', this.configuration.network, '--ipc', 'private', '--log-driver', 'none', '--user', '0:0', '--workdir', '/gitknot/source', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=67108864', '--tmpfs', '/run:rw,nosuid,nodev,noexec,size=1048576',
      '--mount', `type=bind,src=${this.context.workspace},dst=/gitknot/source`, '--mount', `type=bind,src=${this.context.home},dst=/gitknot/home`, '--mount', `type=bind,src=${this.context.inputs},dst=/gitknot/inputs,readonly`,
      '--entrypoint', 'node', this.imageId, '-e', keeper], { signal: this.context.signal });
    await checked(this.configuration, ['container', 'start', this.id], { signal: this.context.signal });
  }

  async grantInputs(): Promise<void> { /* The read-only input mount reflects supervisor-created immutable files. */ }

  async run(executable: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
    if (this.stopped || !this.allocated) throw new RunnerError('isolation_stopped', 'The isolated job allocation is no longer running.');
    const timeout = AbortSignal.timeout(Math.max(1, options.timeout_ms));
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    const env = { ...this.environment(), ...options.env };
    const entries = Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined);
    // Direct engine exec makes the engine authoritative for exit status. No job-owned shim can forge a success.
    // The host CLI sees only authorized step secrets; process identities in the journal are hashes.
    let stopping: Promise<void> | undefined;
    const stop = () => { stopping ??= this.stop(); stopping.catch(() => {}); };
    signal.addEventListener('abort', stop, { once: true });
    try {
      const result = await runProcess(this.configuration.engine, ['container', 'exec', '--user', '65532:65532', '--workdir', this.path(options.cwd), this.id, '/usr/bin/env', '-i', '--', ...entries.map(([key, value]) => `${key}=${value}`), executable, ...args], {
        ...options, cwd: homedir(), env: engineEnvironment(), signal,
      });
      if (timeout.aborted) throw new RunnerError('timed_out', 'A command exceeded its deadline.');
      return result;
    } catch (error) {
      if (timeout.aborted) throw new RunnerError('timed_out', 'A command exceeded its deadline.');
      throw error;
    } finally { signal.removeEventListener('abort', stop); await stopping; }
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      if (this.stopped || !this.allocated) return;
      await removeIsolationContainer(this.configuration, { type: 'oci', id: this.id }, this.context.grace_ms);
      this.stopped = true;
      await this.context.onRecord?.(null);
    })();
    return this.stopping;
  }
}
