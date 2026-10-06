import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { normalizeDirectoryName, readBuildOutput } from '@cloudflare/build-output-utils';
import { CF_VERSION, ROOT, VITE_PLUGIN_VERSION, environment, workerAccount, workerRoles } from '../infra/environment.ts';
import { assembleAccountBuilds, type WorkerBuild } from '../infra/build-output.ts';
import { createProjects, projectDirectory } from '../infra/projects.ts';
import { cf, command, main, offlineEnvironment, writeJson } from '../infra/process.ts';

async function requiredVersion(packageName: string, version: string): Promise<void> {
  const file = JSON.parse(await readFile(join(ROOT, 'node_modules', packageName, 'package.json'), 'utf8')) as { version: string };
  if (file.version !== version) throw new Error(`${packageName}@${version} is required; installed ${file.version}. Run npm install after updating the root manifest.`);
}

async function build(): Promise<void> {
  const { values } = parseArgs({ options: { mode: { type: 'string', default: 'production' }, 'skip-workspaces': { type: 'boolean', default: false }, 'save-images': { type: 'boolean', default: false } }, strict: true });
  const env = environment(values.mode);
  await requiredVersion('cf', CF_VERSION);
  await requiredVersion('@cloudflare/vite-plugin', VITE_PLUGIN_VERSION);
  await createProjects();
  const offline = offlineEnvironment({ GITKNOT_MODE: env.mode });
  if (!values['skip-workspaces']) {
    // Worker workspaces may expose their own `cf build` script. They are built
    // through the generated cf/Vite projects below, not through a second pass
    // that cannot resolve the monorepo's build implementation or web assets.
    await command(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build', '--workspace', '@gitknot/web', '--workspace', '@gitknot/cli', '--workspace', '@gitknot/runner', '--if-present'], { env: offline, timeout: 600_000 });
  }
  await readFile(join(ROOT, 'apps/web/dist/index.html'));
  const built: WorkerBuild[] = [];
  for (const role of workerRoles(env)) {
    const project = projectDirectory(role);
    await cf(['build', '--mode', env.mode], { cwd: project, env: offline, timeout: 900_000 });
    const parsed = await readBuildOutput(project);
    if (parsed.rootConfig.buildContext.mode !== env.mode) throw new Error(`Build mode mismatch for ${role}.`);
    built.push({ role, account: workerAccount(role), output: parsed });
  }
  const assembled = await assembleAccountBuilds(env, built);
  const containers = assembled.accounts.flatMap(account => account.output.containers);
  const images: { container: string; local_reference: string; path: string; sha256: string }[] = [];
  const directory = join(ROOT, '.cloudflare', 'images');
  await rm(directory, { recursive: true, force: true });
  if (values['save-images']) {
    await mkdir(directory, { recursive: true });
    for (const { config } of containers) {
      if (!('image' in config) || !('localReference' in config.image)) continue;
      const file = join(directory, `${normalizeDirectoryName(config.name)}.tar`);
      await command('docker', ['image', 'save', '--output', file, config.image.localReference], { env: offline, timeout: 600_000 });
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      images.push({ container: config.name, local_reference: config.image.localReference, path: file, sha256: hash.digest('hex') });
    }
  }
  await writeJson(join(ROOT, '.cloudflare/build-manifest.json'), {
    version: 1, mode: env.mode, cell_id: env.cell, execution_cell_id: env.executionCell,
    built_at: new Date().toISOString(), cf: CF_VERSION, vite_plugin: VITE_PLUGIN_VERSION,
    workers: assembled.workers, containers: containers.map(container => container.config),
    account_outputs: assembled.accounts.map(account => ({ account: account.account, account_id: env.accounts[account.account], root: relative(ROOT, account.root) || '.' })),
    images,
    provider_operations_performed: [],
  });
  console.log(`Built ${built.length} Workers, web assets, and ${containers.length} Container definitions in ${assembled.accounts.length} account-isolated output root(s) (${env.mode}).`);
}

main(build);
