import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { ROOT, VITE_PLUGIN_VERSION, WORKERS, workerConfigPath, type WorkerRole } from './environment.ts';

export type ProjectRole = WorkerRole | 'development';

export function projectDirectory(role: ProjectRole): string {
  return join(ROOT, '.gitknot', 'projects', role);
}

function importPath(from: string, to: string): string {
  const path = relative(from, to).replaceAll('\\', '/');
  return path.startsWith('.') ? path : `./${path}`;
}

async function writeProjectFile(path: string, content: string): Promise<void> {
  try { if (await readFile(path, 'utf8') === content) return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await writeFile(path, content, { mode: 0o600 });
}

export async function createProjects(): Promise<void> {
  for (const role of [...WORKERS, 'development'] as const) {
    const directory = projectDirectory(role);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const config = role === 'development'
      ? `import { defineConfig } from 'cf/config';\nimport { developmentConfiguration } from '${importPath(directory, join(ROOT, 'infra/cloudflare.ts'))}';\nexport default defineConfig(() => developmentConfiguration(process.env.GITKNOT_LOCAL_CONTAINERS === 'true'));\n`
      : `export { default } from '${importPath(directory, workerConfigPath(role))}';\n`;
    await writeProjectFile(join(directory, 'cloudflare.config.ts'), config);
    await writeProjectFile(join(directory, 'vite.config.ts'), `import { projectViteConfig } from '${importPath(directory, join(ROOT, 'infra/vite.ts'))}';\nexport default projectViteConfig('${role}');\n`);
    // cf detects the actual installed project implementation from this local
    // manifest. Node resolves packages from the monorepo's installed modules.
    await writeProjectFile(join(directory, 'package.json'), `${JSON.stringify({
      name: `gitknot-local-tooling-${role}`, private: true, type: 'module',
      devDependencies: { '@cloudflare/vite-plugin': VITE_PLUGIN_VERSION, vite: '8.3.2' },
    }, null, 2)}\n`);
  }
}
