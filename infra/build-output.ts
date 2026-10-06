import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { normalizeDirectoryName, readBuildOutput, type BuildOutput } from '@cloudflare/build-output-utils';
import { ROOT, buildOutputRoot, type AccountRole, type Environment, type WorkerRole } from './environment.ts';

export interface WorkerBuild { role: WorkerRole; account: AccountRole; output: BuildOutput }
export interface AccountBuild { account: AccountRole; root: string; output: BuildOutput }
export interface WorkerArtifact { role: WorkerRole; account: AccountRole; worker: string; output: string }

async function accountConfig(root: string, accountId: string | undefined, mode: string): Promise<void> {
  if (root === ROOT) return;
  const settings = accountId ? { accountId } : {};
  await writeFile(join(root, 'cloudflare.config.ts'), `import { defineConfig } from 'cf/config';\nexport default defineConfig(({ mode }) => {\n  if (mode && mode !== ${JSON.stringify(mode)}) throw new Error('Use the mode recorded in this account build.');\n  return ${JSON.stringify(settings)};\n});\n`);
}

/** One Build Output root may contain only Workers owned by its selected account. */
export async function assembleAccountBuilds(env: Environment, builds: WorkerBuild[]): Promise<{ accounts: AccountBuild[]; workers: WorkerArtifact[] }> {
  const accounts: AccountBuild[] = [];
  const workers: WorkerArtifact[] = [];
  for (const account of ['trusted', 'execution'] as const) {
    const group = builds.filter(build => build.account === account);
    const root = buildOutputRoot(account);
    const output = join(root, '.cloudflare/output/v0');
    if (!group.length) {
      if (account === 'execution') await rm(root, { recursive: true, force: true });
      continue;
    }
    const primary = group.find(build => build.role === 'api') ?? group[0]!;
    for (const build of group) {
      if (build.output.rootConfig.accountId !== env.accounts[account] || build.output.rootConfig.buildContext.mode !== env.mode) {
        throw new Error(`${build.role}: build account or mode differs from its assigned output root.`);
      }
    }
    await rm(output, { recursive: true, force: true });
    await mkdir(join(output, 'workers'), { recursive: true });
    await cp(join(primary.output.root, '.cloudflare/output/v0/config.json'), join(output, 'config.json'));
    for (const build of group) {
      const worker = build.output.workers.default;
      const directory = build === primary ? 'default' : normalizeDirectoryName(worker.config.name);
      const target = join(output, 'workers', directory);
      await cp(dirname(worker.configPath), target, { recursive: true });
      for (const container of build.output.containers) {
        await cp(dirname(container.configPath), join(output, 'containers', normalizeDirectoryName(container.config.name)), { recursive: true });
      }
      workers.push({ role: build.role, account, worker: worker.config.name, output: relative(ROOT, target) });
    }
    await accountConfig(root, env.accounts[account], env.mode);
    const verified = await readBuildOutput(root);
    if (Object.keys(verified.workers).length !== group.length) throw new Error(`${account}: assembled output is missing a Worker.`);
    if (account === 'trusted') {
      const assets = verified.workers.default.assetsDir;
      if (!assets) throw new Error('The API output is missing web assets.');
      await readFile(join(assets, 'index.html'));
    }
    accounts.push({ account, root, output: verified });
  }
  return { accounts, workers };
}
