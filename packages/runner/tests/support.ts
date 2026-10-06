import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectToolchain } from '../src/toolchain.ts';
import type { CompileContext, ToolchainDescriptor } from '../../workflows/src/index.ts';
import type { RunnerIsolation } from '../src/index.ts';

const exec = promisify(execFile);
export const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));

export async function temporaryDirectory(prefix: string): Promise<string> {
  const base = join(tmpdir(), 'opencode');
  await mkdir(base, { recursive: true, mode: 0o700 });
  return mkdtemp(join(base, `gitknot-${prefix}-`));
}

export async function command(executable: string, args: string[], cwd: string, env = process.env): Promise<string> {
  const result = await exec(executable, args, { cwd, env, timeout: 30_000, maxBuffer: 4_194_304 });
  return result.stdout.trim();
}

export function shellNode(script: string): string {
  return `node -e '${script.replaceAll("'", "'\\''")}'`;
}

export interface GitFixture {
  root: string;
  repo: string;
  readonly commit: string;
  toolchain: ToolchainDescriptor;
  context(overrides?: Partial<CompileContext>): CompileContext;
  commitFiles(files: Record<string, string | null>): Promise<string>;
  close(): Promise<void>;
}

export async function gitFixture(files: Record<string, string> = {}): Promise<GitFixture> {
  const root = await temporaryDirectory('source');
  const repo = join(root, 'repository');
  const home = join(root, 'probe');
  await mkdir(repo, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  await command('git', ['init', '--quiet', '--initial-branch=main'], repo);
  await command('git', ['config', 'user.name', 'GitKnot workflow fixture'], repo);
  await command('git', ['config', 'user.email', 'workflow-fixture@example.invalid'], repo);
  let commit = '';
  const commitFiles = async (changes: Record<string, string | null>) => {
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) await rm(join(repo, path), { force: true });
      else { await mkdir(dirname(join(repo, path)), { recursive: true }); await writeFile(join(repo, path), text); }
    }
    await command('git', ['add', '--all'], repo);
    await command('git', ['-c', `core.hooksPath=${home}`, 'commit', '--quiet', '--allow-empty', '-m', 'Pinned workflow fixture'], repo);
    commit = await command('git', ['rev-parse', 'HEAD'], repo);
    return commit;
  };
  await commitFiles({ 'README.md': 'Pinned workflow fixture\n', ...files });
  const toolchain = await inspectToolchain(['node', 'git'], { cwd: root, home });
  const fixture: GitFixture = {
    root, repo, get commit() { return commit; }, toolchain, commitFiles,
    context(overrides = {}) {
      return {
        repo_id: 'r_fixture', commit, workflow_revision: commit,
        event: { type: 'workflow.dispatch', ref: 'refs/heads/main' },
        trust: { level: 'trusted', fork: false, producer_id: 'gitknot-control-plane' },
        policy: { revision: '1', allowed_workflow_revisions: [commit], access: { repository: 'read' }, hosted_profiles: [], self_hosted_pools: { pool_fixture: { trust: 'trusted', disposable: false, repository_ids: ['r_fixture'] } }, inapplicable_jobs: [] },
        toolchains: { 'fixture@1.0.0': fixture.toolchain }, modules: {}, ...overrides,
      };
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
  return fixture;
}

export function workflow(jobs: Record<string, unknown>): Record<string, unknown> {
  return { version: 1, name: 'fixture', triggers: ['workflow.dispatch'], source: 'event.commit', defaults: { executor: { type: 'self_hosted', pool: 'pool_fixture' }, toolchain: 'fixture@1.0.0', timeout: '30s' }, access: { repository: 'read' }, jobs };
}

let oci: Promise<{ isolation: RunnerIsolation; toolchain: ToolchainDescriptor }> | undefined;
export function ociFixture(): Promise<{ isolation: RunnerIsolation; toolchain: ToolchainDescriptor }> {
  oci ??= (async () => {
    const tag = 'gitknot-runner-high-level:node24';
    await exec('docker', ['build', '--quiet', '--tag', tag, join(projectRoot, 'packages', 'runner', 'tests')], { cwd: projectRoot, timeout: 180_000, maxBuffer: 4_194_304 });
    const image = await command('docker', ['image', 'inspect', '--format', '{{.Id}}', tag], projectRoot);
    const script = `const c=require('node:child_process');console.log(JSON.stringify({os:process.platform,arch:process.arch,tools:{node:process.versions.node,git:c.execFileSync('git',['--version'],{encoding:'utf8'}).trim().replace(/^git version /,'')},image:${JSON.stringify(image)}}))`;
    const toolchain = JSON.parse(await command('docker', ['run', '--rm', '--network=none', '--read-only', '--cap-drop=ALL', '--entrypoint', 'node', image, '-e', script], projectRoot)) as ToolchainDescriptor;
    return { isolation: { type: 'oci', engine: 'docker', image, network: 'none', cpus: 1, memory_mb: 512, pids: 128 }, toolchain };
  })();
  return oci;
}
