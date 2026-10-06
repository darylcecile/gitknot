import { fingerprintToolchain, type ResolvedToolchain, type ToolchainDescriptor } from '../../workflows/src/index.ts';
import { Buffer } from 'node:buffer';
import { RunnerError } from './errors.ts';
import { captureProcess, cleanEnvironment, type ProcessGroup, type ProcessOptions, type ProcessResult } from './process.ts';

export interface ToolchainInspectionOptions {
  cwd: string;
  home: string;
  signal?: AbortSignal;
  onGroup?: (group: ProcessGroup) => Promise<void>;
  execute?: (executable: string, args: string[], options: ProcessOptions) => Promise<ProcessResult>;
  platform?: { os: ToolchainDescriptor['os']; arch: ToolchainDescriptor['arch']; image?: string };
  environment?: NodeJS.ProcessEnv;
}

function normalizeVersion(tool: string, output: string): string {
  const first = output.trim().split(/\r?\n/, 1)[0] ?? '';
  if (tool === 'node') return first.replace(/^v/, '');
  if (tool === 'git') return first.replace(/^git version /, '');
  if (tool === 'python' || tool === 'python3') return first.replace(/^Python /, '');
  return first;
}

export async function inspectToolchain(tools: string[], options: ToolchainInspectionOptions): Promise<ToolchainDescriptor> {
  const platform = options.platform ?? { os: process.platform, arch: process.arch };
  if (!['linux', 'darwin', 'win32'].includes(platform.os) || !['x64', 'arm64'].includes(platform.arch)) throw new RunnerError('platform_unsupported', 'This runner supports Linux, macOS, or Windows on x64/arm64.');
  const versions: Record<string, string> = {};
  for (const tool of [...new Set(tools)].sort()) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(tool)) throw new RunnerError('toolchain_invalid', 'Tool names must be executable names without paths or arguments.');
    let command = tool;
    let args = [tool === 'java' ? '-version' : '--version'];
    // Windows .cmd launchers require cmd.exe; tool names above cannot inject shell syntax.
    if (platform.os === 'win32' && ['npm', 'pnpm', 'yarn'].includes(tool)) {
      command = process.env.COMSPEC ?? 'cmd.exe'; args = ['/d', '/s', '/c', `${tool}.cmd --version`];
    }
    let result: Awaited<ReturnType<typeof captureProcess>>;
    try {
      const execution = { cwd: options.cwd, env: options.environment ?? cleanEnvironment(options.home), signal: options.signal, timeout_ms: 30_000, onGroup: options.onGroup, max_output_bytes: 65_536 };
      if (options.execute) {
        let output = '';
        const executed = await options.execute(command, args, { ...execution, onLog: async (bytes) => { output += Buffer.from(bytes).toString('utf8'); } });
        result = { ...executed, output };
      } else result = await captureProcess(command, args, execution);
    }
    catch (error) {
      if (error instanceof RunnerError && error.code === 'process_start_failed') throw new RunnerError('toolchain_unavailable', `Required tool ${tool} is not available on this host.`);
      throw error;
    }
    if (result.exit_code !== 0 || result.signal) throw new RunnerError('toolchain_unavailable', `Required tool ${tool} could not report its version.`);
    const version = normalizeVersion(tool, result.output);
    if (!version || version.length > 256) throw new RunnerError('toolchain_unavailable', `Required tool ${tool} returned an invalid version.`);
    versions[tool] = version;
  }
  return { os: platform.os as ToolchainDescriptor['os'], arch: platform.arch as ToolchainDescriptor['arch'], tools: versions, ...(options.platform?.image ? { image: options.platform.image } : {}) };
}

export async function matchToolchain(expected: ResolvedToolchain, options: ToolchainInspectionOptions): Promise<void> {
  if (options.platform?.image && !expected.image) throw new RunnerError('toolchain_mismatch', 'OCI execution requires the approved toolchain descriptor to include the exact image identity.');
  const actual = await inspectToolchain(Object.keys(expected.tools), options);
  const mismatches: string[] = [];
  if (actual.os !== expected.os) mismatches.push(`OS: expected ${expected.os}, found ${actual.os}`);
  if (actual.arch !== expected.arch) mismatches.push(`architecture: expected ${expected.arch}, found ${actual.arch}`);
  for (const [name, version] of Object.entries(expected.tools)) if (actual.tools[name] !== version) mismatches.push(`${name}: expected ${version}, found ${actual.tools[name] ?? 'missing'}`);
  if (expected.image && expected.image !== actual.image) mismatches.push('the toolchain requires an image identity that does not match the selected isolated image');
  if (mismatches.length) throw new RunnerError('toolchain_mismatch', `Toolchain ${expected.name} does not match this host. ${mismatches.join('; ')}.`, { mismatches });
  const { image, ...host } = actual;
  if (await fingerprintToolchain(expected.image ? actual : host) !== expected.fingerprint) throw new RunnerError('toolchain_mismatch', 'The toolchain descriptor does not match its expected fingerprint.');
}
