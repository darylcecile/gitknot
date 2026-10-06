import { chmod, readFile } from 'node:fs/promises';

const executable = new URL('../dist/cli/src/index.js', import.meta.url);
if (!(await readFile(executable, 'utf8')).startsWith('#!/usr/bin/env node\n')) {
  throw new Error('Compiled gitknot executable is missing its Node shebang.');
}
await chmod(executable, 0o755);
