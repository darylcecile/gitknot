import { build } from 'esbuild';

// A local bundle only. Deployment and resource configuration belong to infra.
await build({
  entryPoints: [new URL('./src/index.ts', import.meta.url).pathname],
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
