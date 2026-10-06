import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isolationRoot = resolve(root, '.gitknot/e2e');
const state = resolve(
  root,
  process.env.GITKNOT_LOCAL_STATE ||
    `.gitknot/e2e/run-${Date.now()}-${randomUUID().slice(0, 8)}`,
);
if (!state.startsWith(`${isolationRoot}${sep}`))
  throw new Error('E2E state must be isolated beneath .gitknot/e2e/.');
process.env.GITKNOT_LOCAL_STATE = state;
process.env.GITKNOT_E2E_FIXTURE_FILE = resolve(state, 'fixtures.json');
process.env.GITKNOT_MODE = 'development';

const children = new Set<ChildProcess>();
const stopController = new AbortController();
let stopping = false;
let tail = '';

function stopChild(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.platform === 'win32'
      ? child.kill(signal)
      : process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function stop() {
  if (stopping) return;
  stopping = true;
  stopController.abort();
  const active = [...children].filter((child) => child.exitCode === null);
  for (const child of active) stopChild(child, 'SIGTERM');
  await Promise.race([
    Promise.all(
      active.map(
        (child) =>
          new Promise<void>((done) => child.once('close', () => done())),
      ),
    ),
    delay(8_000),
  ]);
  for (const child of active) stopChild(child, 'SIGKILL');
}

async function requirePort(port: number) {
  const socket = createServer();
  await new Promise<void>((done, reject) => {
    socket.once('error', () =>
      reject(
        new Error(
          `E2E cannot start: localhost:${port} is already in use. An existing stack will not be reused.`,
        ),
      ),
    );
    socket.listen(port, '127.0.0.1', () =>
      socket.close((error) => (error ? reject(error) : done())),
    );
  });
}

async function waitFor(
  name: string,
  url: string,
  validate: (response: Response, body: string) => boolean,
) {
  const deadline = Date.now() + 90_000;
  let reason = 'not listening';
  while (Date.now() < deadline && !stopController.signal.aborted) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([
          stopController.signal,
          AbortSignal.timeout(3_000),
        ]),
      });
      const body = await response.text();
      if (validate(response, body)) return;
      reason = `HTTP ${response.status}: ${body.slice(0, 500)}`;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    await delay(500, undefined, { signal: stopController.signal });
  }
  throw new Error(`${name} did not become ready at ${url}: ${reason}\n${tail}`);
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) !== 24)
    throw new Error('The real E2E stack requires Node 24.');
  await Promise.all([5173, 8787, 8788, 8790, 8791, 8792].map(requirePort));
  await mkdir(state, { recursive: true, mode: 0o700 });
  const output = createWriteStream(resolve(state, 'stack.log'), {
    flags: 'a',
    mode: 0o600,
  });
  const { offlineEnvironment } = await import('../infra/process.ts');
  const env = offlineEnvironment({
    GITKNOT_LOCAL_STATE: state,
    GITKNOT_MODE: 'development',
    GITKNOT_E2E_FIXTURE_FILE: process.env.GITKNOT_E2E_FIXTURE_FILE,
    VITE_API_ORIGIN: '',
    GITKNOT_DEV_API_URL: 'http://127.0.0.1:8787',
  });
  const launch = (name: string, args: string[], cwd = root) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    children.add(child);
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (chunk: Buffer) => {
        output.write(chunk);
        tail = (tail + chunk.toString()).slice(-16_000);
      });
    const completion = new Promise<void>((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        children.delete(child);
        if (code === 0 || stopping) done();
        else
          reject(
            new Error(
              `${name} exited (${signal || code}). Inspect ${resolve(state, 'stack.log')}.\n${tail}`,
            ),
          );
      });
    });
    return { child, completion };
  };
  process.once('SIGTERM', () => {
    void stop().finally(() => process.exit(0));
  });
  process.once('SIGINT', () => {
    void stop().finally(() => process.exit(0));
  });
  console.log(`[GitKnot E2E] preparing isolated workerd state: ${state}`);
  await launch('Local setup', ['scripts/setup.ts', '--skip-install'])
    .completion;
  await launch('CLI production build', [
    resolve(root, 'node_modules/typescript/bin/tsc'),
    '-p',
    'packages/cli/tsconfig.build.json',
  ]).completion;
  await launch(
    'CLI executable preparation',
    [resolve(root, 'packages/cli/scripts/executable.mjs')],
    resolve(root, 'packages/cli'),
  ).completion;
  const vite = resolve(root, 'node_modules/vite/bin/vite.js');
  const webRoot = resolve(root, 'apps/web');
  await launch(
    'Web production build',
    [vite, 'build', '--logLevel', 'error'],
    webRoot,
  ).completion;
  const server = launch('Multiworker development stack', [
    '--import',
    'tsx',
    'scripts/dev.ts',
    '--no-web',
  ]);
  const web = launch(
    'Built web application',
    [vite, 'preview', '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
    webRoot,
  );
  const stackExit = Promise.race([server.completion, web.completion]).then(
    () => {
      throw new Error('The E2E stack exited before verification finished.');
    },
  );
  const readiness = Promise.all([
    waitFor(
      'API',
      'http://localhost:8787/health/ready',
      (response, body) => response.ok && JSON.parse(body).status === 'ready',
    ),
    waitFor(
      'Native Git helper',
      'http://127.0.0.1:8790/ready',
      (response, body) => response.ok && body === 'ready',
    ),
    waitFor(
      'Web application',
      'http://localhost:5173/auth/login',
      (response, body) => response.ok && body.includes('id="root"'),
    ),
  ]);
  await Promise.race([readiness, stackExit]);
  const { localKeys } = await import('../infra/cloudflare.ts');
  const { signInternalRequest } =
    await import('../packages/core/src/internal.ts');
  const privateRequest = await signInternalRequest(
    new Request('https://internal.gitknot.com/internal/webhooks/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1/forbidden' }),
    }),
    localKeys().egress.INTERNAL_SERVICE_KEY!,
    'webhook-egress',
  );
  const egress = await fetch(
    'http://127.0.0.1:8791/internal/webhooks/validate',
    {
      method: 'POST',
      headers: privateRequest.headers,
      body: await privateRequest.text(),
      signal: AbortSignal.timeout(5_000),
    },
  );
  const egressResult = (await egress.json()) as { error?: { code?: string } };
  if (
    egress.status !== 422 ||
    egressResult.error?.code !== 'endpoint_not_allowed'
  )
    throw new Error(
      `The real webhook helper failed its signed local-boundary probe: HTTP ${egress.status}.`,
    );
  const seed = launch('Production-schema E2E fixtures', [
    '--import',
    'tsx',
    'scripts/seed-e2e.ts',
  ]);
  await Promise.race([seed.completion, stackExit]);
  console.log(
    `[GitKnot E2E] ready — built web assets, six local Workers, real native helpers, isolated D1/R2/DO/Queues/Workflows. Evidence: ${state}`,
  );
  await stackExit;
  output.end();
}

main().catch(async (error) => {
  if (stopping) return;
  console.error(error instanceof Error ? error.message : String(error));
  await stop();
  process.exitCode = 1;
});
