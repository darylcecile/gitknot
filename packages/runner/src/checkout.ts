import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { RunnerError } from './errors.ts';
import { atomicWrite } from './files.ts';
import { captureProcess, cleanEnvironment, type ProcessGroup } from './process.ts';

export interface SourceLocation { url: string; commit: string; token?: string }
export interface CheckoutOptions {
  source: SourceLocation;
  workspace: string;
  private_directory: string;
  signal?: AbortSignal;
  deadline_at: number;
  allow_local_source?: boolean;
  allowed_git_origins?: string[];
  onGroup?: (group: ProcessGroup) => Promise<void>;
  grace_ms?: number;
}

export function validateSourceLocation(source: SourceLocation, options: Pick<CheckoutOptions, 'allow_local_source' | 'allowed_git_origins'>): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commit)) throw new RunnerError('source_invalid', 'Source must use a full pinned Git commit ID.');
  if (options.allow_local_source && isAbsolute(source.url)) return resolve(source.url);
  let url: URL;
  try { url = new URL(source.url); } catch { throw new RunnerError('source_invalid', 'Source must use a GitKnot HTTPS remote.'); }
  if (url.username || url.password || url.search || url.hash) throw new RunnerError('source_credentials', 'Source URLs cannot contain credentials, query strings, or fragments.');
  if (url.protocol !== 'https:' || !(options.allowed_git_origins ?? ['https://git.gitknot.com', 'https://git.staging.gitknot.com']).includes(url.origin)) throw new RunnerError('source_origin', 'Source must use an allowed GitKnot HTTPS Git origin.');
  return url.href;
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export async function checkoutSource(options: CheckoutOptions): Promise<void> {
  const sourceUrl = validateSourceLocation(options.source, options);
  const home = join(options.private_directory, 'home');
  const hooks = join(options.private_directory, 'empty-hooks');
  const template = join(options.private_directory, 'empty-template');
  await Promise.all([mkdir(options.workspace, { recursive: true, mode: 0o700 }), mkdir(home, { recursive: true, mode: 0o700 }), mkdir(hooks, { recursive: true, mode: 0o700 }), mkdir(template, { recursive: true, mode: 0o700 })]);
  const env = cleanEnvironment(home);
  const git = async (args: string[], environment = env): Promise<string> => {
    const remaining = options.deadline_at - Date.now();
    if (remaining <= 0) throw new RunnerError('timed_out', 'Checkout exceeded the job deadline.');
    const result = await captureProcess('git', [
      '-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false', '-c', 'credential.helper=',
      '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
      ...(options.allow_local_source ? ['-c', 'protocol.file.allow=always'] : []), ...args,
    ], { cwd: options.workspace, env: environment, signal: options.signal, timeout_ms: remaining, grace_ms: options.grace_ms, secrets: options.source.token ? [options.source.token] : [], onGroup: options.onGroup, max_output_bytes: 262_144 });
    if (result.exit_code !== 0 || result.signal) throw new RunnerError('checkout_failed', 'Git could not fetch and check out the pinned source commit. Check repository access and source availability.');
    return result.output.trim();
  };
  const askpassJs = join(options.private_directory, 'source-askpass.cjs');
  const askpass = join(options.private_directory, process.platform === 'win32' ? 'source-askpass.cmd' : 'source-askpass');
  try {
    await git(['init', '--quiet', `--template=${template}`, ...(options.source.commit.length === 64 ? ['--object-format=sha256'] : [])]);
    const fetchEnv = { ...env };
    if (options.source.token) {
      await atomicWrite(askpassJs, "const prompt = process.argv[2] || ''; process.stdout.write(/username/i.test(prompt) ? 'gitknot\\n' : (process.env.GITKNOT_SOURCE_TOKEN || '') + '\\n');\n");
      const launcher = process.platform === 'win32'
        ? `@echo off\r\n"${process.execPath}" "${askpassJs}" %*\r\n`
        : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(askpassJs)} "$@"\n`;
      await atomicWrite(askpass, launcher, 0o700);
      fetchEnv.GIT_ASKPASS = askpass;
      fetchEnv.GITKNOT_SOURCE_TOKEN = options.source.token;
    }
    await git(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--depth=1', '--', sourceUrl, options.source.commit], fetchEnv);
    const fetched = await git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
    if (fetched !== options.source.commit) throw new RunnerError('source_mismatch', 'The fetched source differs from the immutable manifest.');
    await git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', '--force', options.source.commit]);
    if (await git(['rev-parse', '--verify', 'HEAD']) !== options.source.commit) throw new RunnerError('source_mismatch', 'Checkout did not produce the pinned source commit.');
  } finally {
    await Promise.all([rm(askpass, { force: true }), rm(askpassJs, { force: true })]);
  }
}

export async function resolveLocalRepository(path: string, revision = 'HEAD', signal?: AbortSignal): Promise<{ root: string; commit: string }> {
  if (!revision || /[\x00-\x20]/.test(revision) || revision.startsWith('-')) throw new RunnerError('revision_invalid', 'Revision must be a commit or ref name.');
  const run = async (args: string[]): Promise<string> => {
    const result = await captureProcess('git', args, { cwd: resolve(path), env: cleanEnvironment(homedir()), signal, timeout_ms: 30_000 });
    if (result.exit_code !== 0) throw new RunnerError('repository_invalid', 'The directory or revision is not a valid local Git repository.');
    return result.output.trim();
  };
  const root = await run(['rev-parse', '--show-toplevel']);
  const commit = await run(['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`]);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new RunnerError('revision_invalid', 'Git did not resolve a full commit ID.');
  return { root, commit };
}

export async function readPinnedFile(repository: string, commit: string, path: string, signal?: AbortSignal): Promise<string> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) || !path || path.includes('\0') || path.startsWith('/') || path.split('/').includes('..')) throw new RunnerError('source_invalid', 'Invalid pinned file location.');
  const result = await captureProcess('git', ['show', `${commit}:${path}`], { cwd: repository, env: cleanEnvironment(homedir()), signal, timeout_ms: 30_000, max_output_bytes: 1_048_576 });
  if (result.exit_code !== 0) throw new RunnerError('definition_unavailable', 'The workflow file does not exist at the pinned definition revision.');
  return result.output;
}
