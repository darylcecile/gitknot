import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { build, type InlineConfig } from 'vite';
import { ROOT } from './environment.ts';

/** Emit runnable Node ESM, including the separately spawned Git receive hooks. */
function nativeBuildConfig(watch = false): InlineConfig {
  const directory = join(ROOT, '.gitknot/native');
  return {
    configFile: false, root: ROOT, envDir: false, publicDir: false,
    build: {
      target: 'node24', outDir: directory, emptyOutDir: true, minify: false, sourcemap: true,
      ...(watch ? { watch: {} } : {}),
      lib: { entry: { native: join(ROOT, 'infra/local/native-git.ts'), hooks: join(ROOT, 'services/git/src/hooks.ts') }, formats: ['es'] },
      rollupOptions: {
        external: [...builtinModules, ...builtinModules.map(name => `node:${name}`)],
        output: { entryFileNames: chunk => chunk.name === 'hooks' ? 'hooks.ts' : '[name].mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' },
      },
    },
  };
}

export async function buildLocalNativeGit(): Promise<string> {
  await build(nativeBuildConfig());
  return join(ROOT, '.gitknot/native/native.mjs');
}

export async function watchLocalNativeGit(): Promise<{ entrypoint: string; close(): Promise<void> }> {
  const watcher = await build(nativeBuildConfig(true));
  if (Array.isArray(watcher) || !('on' in watcher) || !('close' in watcher)) throw new Error('Vite did not start the native Git watcher.');
  try {
    await new Promise<void>((done, reject) => {
      let ready = false;
      watcher.on('event', event => {
        if (event.code === 'ERROR') {
          if (!ready) reject(event.error);
          else console.error('Native Git rebuild failed. Fix the reported compiler error before retrying native work.');
        }
        if (event.code === 'END' && !ready) { ready = true; done(); }
      });
    });
    return { entrypoint: join(ROOT, '.gitknot/native/native.mjs'), close: async () => { await watcher.close(); } };
  } catch (error) { await watcher.close(); throw error; }
}
