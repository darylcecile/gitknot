import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import root from '../../vitest.config.ts';

export default defineConfig({
  ...root,
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    ...root.test,
    include: ['tests/high-level/execution-remote-host.test.ts'],
    server: { deps: { inline: [/@cloudflare\/(?:ci|sandbox|containers)/] } },
  },
});
