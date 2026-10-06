import { join } from 'node:path';
import { defineConfig, type UserConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { resolveAndParseConfig } from '@cloudflare/config';
import { configuration, localWorker } from './cloudflare.ts';
import { LOCAL_STATE, ROOT, environment, workerRoles } from './environment.ts';
import { projectDirectory, type ProjectRole } from './projects.ts';

export function projectViteConfig(role: ProjectRole) {
  return defineConfig(async ({ command, mode }): Promise<UserConfig> => {
    if (role === 'development' && (mode !== 'development' || command !== 'serve')) {
      throw new Error('The local router is development-only. Build the authored Worker projects instead.');
    }
    const auxiliaryWorkers = [];
    if (role === 'development') {
      const containers = process.env.GITKNOT_LOCAL_CONTAINERS === 'true';
      for (const workerRole of workerRoles(environment('development'))) {
        const authored = configuration(workerRole, 'development');
        const parsed = await resolveAndParseConfig({
          worker: localWorker(workerRole, containers), containers: containers && workerRole === 'execution' ? authored.containers : [],
        }, { mode: 'development', isPreview: false });
        if (!parsed.success || !parsed.data.worker) throw new Error(`Invalid local ${workerRole} configuration: ${parsed.success ? 'worker missing' : parsed.error.message}`);
        auxiliaryWorkers.push({ config: parsed.data.worker });
      }
    }
    return {
      root: projectDirectory(role),
      envDir: command === 'serve' && role !== 'development' ? projectDirectory(role) : false,
      publicDir: role === 'api' ? join(ROOT, 'apps/web/dist') : false,
      plugins: [cloudflare({
        remoteBindings: false, tunnel: false, inspectorPort: false,
        persistState: { path: LOCAL_STATE },
        types: { generate: false, includeRuntime: false },
        auxiliaryWorkers,
      })],
      server: { host: '127.0.0.1', port: 8787, strictPort: true, fs: { allow: [ROOT] } },
      build: { sourcemap: true, minify: true },
    };
  });
}
