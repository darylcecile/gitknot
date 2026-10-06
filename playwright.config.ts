import { randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const root = process.cwd();
const base = resolve(root, '.gitknot/e2e');
const state = resolve(
  root,
  process.env.GITKNOT_LOCAL_STATE ||
    `.gitknot/e2e/run-${Date.now()}-${randomUUID().slice(0, 8)}`,
);
if (!state.startsWith(`${base}${sep}`))
  throw new Error(
    'Playwright requires isolated GITKNOT_LOCAL_STATE beneath .gitknot/e2e/.',
  );
process.env.GITKNOT_LOCAL_STATE = state;
process.env.GITKNOT_E2E_FIXTURE_FILE = resolve(state, 'fixtures.json');

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'web.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  outputDir: resolve(state, 'test-results'),
  reporter: [
    ['list'],
    ['html', { outputFolder: resolve(state, 'report'), open: 'never' }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    acceptDownloads: true,
  },
  webServer: {
    command: 'node --import tsx scripts/e2e.ts',
    wait: { stdout: /\[GitKnot E2E\] ready/ },
    timeout: 360_000,
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      GITKNOT_LOCAL_STATE: state,
      GITKNOT_E2E_FIXTURE_FILE: process.env.GITKNOT_E2E_FIXTURE_FILE,
      GITKNOT_MODE: 'development',
      VITE_API_ORIGIN: '',
    },
  },
});
