import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT } from './environment.ts';

export interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  capture?: boolean;
  signal?: AbortSignal;
  timeout?: number;
}

export function offlineEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (/^(CLOUDFLARE_(API_TOKEN|API_KEY|EMAIL|ACCOUNT_ID|ZONE_ID)|CF_API_(TOKEN|KEY))$/.test(key)
      || /^GITKNOT_.*(?:API_TOKEN|OPERATOR_TOKEN|LOAD_TOKEN|SERVICE_KEY)$/.test(key)) delete env[key];
  }
  return { ...env, CLOUDFLARE_SEND_METRICS: 'false', CLOUDFLARE_VITE_FORCE_LOCAL: 'true', WRANGLER_SEND_METRICS: 'false', CI: env.CI ?? 'true' };
}

export function start(command: string, args: readonly string[], options: CommandOptions = {}): ChildProcess {
  return spawn(command, [...args], {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', options.capture ? 'pipe' : 'inherit', options.capture ? 'pipe' : 'inherit'],
    signal: options.signal,
    timeout: options.timeout,
    shell: false,
  });
}

export async function command(commandName: string, args: readonly string[], options: CommandOptions = {}): Promise<string> {
  const child = start(commandName, args, options);
  let output = '';
  let errors = '';
  child.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
  child.stderr?.on('data', (data: Buffer) => { errors += data.toString(); });
  if (options.input !== undefined) child.stdin?.end(options.input);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${commandName} exited ${signal ?? code ?? 'without a status'}${errors ? `: ${errors.slice(-8_000)}` : ''}`));
    });
  });
  return output;
}

export const CF_BIN = join(ROOT, 'node_modules', 'cf', 'bin', 'cf');

export function cf(args: readonly string[], options: CommandOptions = {}): Promise<string> {
  return command(process.execPath, [CF_BIN, ...args], options);
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export function main(run: () => Promise<void>): void {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
