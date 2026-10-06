import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: [
      { find: /^cloudflare:(?:workers|workflows|sockets)$/, replacement: fileURLToPath(new URL('./tests/support/cloudflare.ts', import.meta.url)) },
    ],
  },
  test: {
    server: { deps: { inline: ['@cloudflare/containers', '@cloudflare/sandbox', '@cloudflare/ci'] } },
    include: ['tests/high-level/**/*.test.ts', 'packages/*/tests/**/*.test.ts', 'services/*/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/unit/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    maxWorkers: 4,
    environment: 'node',
  },
});
