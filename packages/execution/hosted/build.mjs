import { build } from 'esbuild';

// Offline verification of both consumers of the shared pinned SDK integration.
await build({
  entryPoints: {
    'same-account': new URL('../../../workers/execution/src/index.ts', import.meta.url).pathname,
    'remote-account': new URL('../../../workers/hosted/src/index.ts', import.meta.url).pathname,
  },
  outdir: new URL('./dist', import.meta.url).pathname,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2023',
  conditions: ['workerd', 'worker', 'browser'],
  mainFields: ['module', 'main'],
  external: ['cloudflare:*', 'node:*'],
  logLevel: 'info',
});
