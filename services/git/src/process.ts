import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable } from 'node:stream';
import type { GitLimits } from '../../../packages/git/src/types.ts';
import { GitError, requireValue } from '../../../packages/git/src/errors.ts';

export interface GitProcessOptions {
  env?: Record<string, string>;
  input?: Uint8Array | string | Readable;
  max_output?: number;
  allow_failure?: boolean;
  hooks?: string;
  config?: string[];
  signal?: AbortSignal;
}

export interface GitProcessResult { code: number; stdout: Buffer; stderr: Buffer }
export interface GitStream { process: ChildProcessWithoutNullStreams; output: Readable; completion: Promise<GitProcessResult>; stop: () => void }

const baseConfig = [
  'core.fsmonitor=false', 'core.untrackedCache=false', 'core.useReplaceRefs=false',
  'credential.helper=', 'protocol.allow=never', 'protocol.https.allow=always',
  'http.followRedirects=false', 'http.maxRequests=2', 'http.lowSpeedLimit=128', 'http.lowSpeedTime=30',
  'gc.auto=0', 'maintenance.auto=false', 'fetch.writeCommitGraph=false',
  'transfer.fsckObjects=true', 'fetch.fsckObjects=true', 'receive.fsckObjects=true',
  'pack.threads=1', 'index.threads=1', 'pack.windowMemory=32m', 'core.bigFileThreshold=32m',
  'submodule.recurse=false', 'fetch.recurseSubmodules=false', 'push.recurseSubmodules=no',
];

export class NativeGit {
  readonly directory: string;
  readonly limits: GitLimits;
  readonly deadline: number;
  readonly development: boolean;
  readonly environment: Record<string, string>;

  constructor(directory: string, limits: GitLimits, deadline: number, development = false, environment: Record<string, string> = {}) {
    this.directory = directory;
    this.limits = limits;
    this.deadline = deadline;
    this.development = development;
    this.environment = environment;
  }

  withEnvironment(environment: Record<string, string>): NativeGit {
    return new NativeGit(this.directory, this.limits, this.deadline, this.development, { ...this.environment, ...environment });
  }

  async run(args: string[], options: GitProcessOptions = {}): Promise<GitProcessResult> {
    const task = this.start(args, options, true);
    const result = await task.completion;
    if (result.code !== 0 && !options.allow_failure) {
      throw new GitError('git_command_failed', 'Native Git could not complete this operation.', 422, { cause: result.stderr.toString().slice(0, 2048) });
    }
    return result;
  }

  async text(args: string[], options: GitProcessOptions = {}): Promise<string> {
    return (await this.run(args, options)).stdout.toString().trimEnd();
  }

  stream(args: string[], options: GitProcessOptions = {}): GitStream {
    return this.start(args, options, false);
  }

  private start(args: string[], options: GitProcessOptions, capture: boolean): GitStream {
    requireValue(Date.now() < this.deadline, 'git_deadline', 'Git processing exceeded its time limit.', 413);
    const environment: Record<string, string> = {
      PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', HOME: this.directory,
      LANG: 'C.UTF-8', LC_ALL: 'C', TZ: 'UTC', GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1',
      GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1',
      ...this.environment, ...options.env,
    };
    const config = [...baseConfig, `core.hooksPath=${options.hooks ?? '/dev/null'}`, ...(options.config ?? [])];
    if (this.development) config.push('protocol.file.allow=always', 'protocol.http.allow=always');
    const command = ['--no-pager', ...config.flatMap(value => ['-c', value]), ...args];
    const linux = process.platform === 'linux';
    const executable = linux ? '/usr/bin/prlimit' : 'git';
    const seconds = Math.ceil(Math.max(1000, this.deadline - Date.now()) / 1000);
    const argv = linux ? [
      // A Node hook needs V8's reserved virtual address cage. Its actual memory is bounded
      // by the helper container and Node heap; object-only Git subprocesses also get RLIMIT_AS.
      ...(options.hooks || args[0] === 'receive-pack' ? [] : [`--as=${this.limits.max_process_memory_bytes}`]),
      `--cpu=${seconds + 1}`, `--fsize=${this.limits.max_repository_bytes}`,
      '--', '/usr/bin/git', ...command,
    ] : command;
    const child = spawn(executable, argv, { cwd: this.directory, env: environment, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stop = (): void => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
      }
    };
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let failure: Error | undefined;
    const maxOutput = options.max_output ?? (capture ? this.limits.max_metadata_bytes : this.limits.max_output_bytes);
    const timer = setTimeout(() => { failure = new GitError('git_deadline', 'Git processing exceeded its time limit.', 413); stop(); }, this.deadline - Date.now());
    timer.unref();
    const abort = (): void => { failure = new GitError('git_cancelled', 'Git transfer was interrupted.', 499); stop(); };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutput) { failure = new GitError('git_output_limit', 'Git output exceeds the configured limit.', 413); stop(); }
      else if (capture) output.push(chunk);
    });
    // For a streaming child, do not attach a flowing consumer before its destination exists.
    if (!capture) child.stdout.pause();
    child.stderr.on('data', (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes <= 64 * 1024) errors.push(chunk);
    });
    child.stdin.on('error', error => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') { failure = error; stop(); }
    });
    if (options.input instanceof Readable) {
      options.input.once('error', error => { failure = error; stop(); });
      options.input.pipe(child.stdin);
    } else child.stdin.end(options.input);
    const completion = new Promise<GitProcessResult>((resolve, reject) => {
      child.once('error', error => { failure = error; });
      child.once('close', code => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (options.input instanceof Readable) options.input.unpipe(child.stdin);
        if (failure) reject(failure);
        else resolve({ code: code ?? 128, stdout: Buffer.concat(output), stderr: Buffer.concat(errors) });
      });
    });
    // Streaming consumers await completion after draining; rejection must also be observed immediately.
    void completion.catch(() => {});
    return { process: child, output: child.stdout, completion, stop };
  }
}
