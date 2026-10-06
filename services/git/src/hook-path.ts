import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitError } from '../../../packages/git/src/errors.ts';

/** Executables are filesystem artifacts. Vite treats static new-URL expressions as assets. */
export async function nativeHookPath(): Promise<string> {
  const explicit = process.env.GITKNOT_NATIVE_HOOK_ENTRY;
  if (explicit) {
    if (!isAbsolute(explicit) || !(await regularFile(explicit))) throw new GitError('native_hook_unavailable', 'The configured trusted Git hook entrypoint is unavailable.', 503);
    return explicit;
  }
  const moduleDirectory = import.meta.url.startsWith('file:') ? dirname(fileURLToPath(import.meta.url)) : undefined;
  const entryDirectory = process.argv[1] ? dirname(resolve(process.argv[1])) : undefined;
  const directories = [...new Set([moduleDirectory, entryDirectory, moduleDirectory ? dirname(moduleDirectory) : undefined].filter((value): value is string => !!value))];
  for (const directory of directories) {
    for (const filename of ['hooks.ts', 'hooks.mjs', 'hooks.js']) {
      const path = join(directory, filename);
      if (await regularFile(path)) return path;
    }
  }
  throw new GitError('native_hook_unavailable', 'The trusted native Git hook artifact is unavailable.', 503);
}

async function regularFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
    throw error;
  }
}
