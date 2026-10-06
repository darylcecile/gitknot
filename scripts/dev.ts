import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { localKeys } from '../infra/cloudflare.ts';
import { LOCAL_STATE, ROOT } from '../infra/environment.ts';
import { createProjects, projectDirectory } from '../infra/projects.ts';
import { watchLocalNativeGit } from '../infra/native-build.ts';
import { backgroundHttp } from '../infra/recovery/move.ts';
import { CF_BIN, main, offlineEnvironment } from '../infra/process.ts';
import { initializeLocalVault } from '../infra/local/vault.ts';

async function requirePort(port: number): Promise<void> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()));
  });
}

function gitProxy() {
  return createHttpServer({ requestTimeout: 0, headersTimeout: 15_000 }, (incoming, outgoing) => {
    const upstream = httpRequest({
      hostname: '127.0.0.1', port: 8787, method: incoming.method, path: incoming.url,
      headers: { ...incoming.headers, 'x-gitknot-local-service': 'git' },
    }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
      response.once('error', () => outgoing.destroy());
    });
    upstream.once('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'text/plain' });
      outgoing.end('GitKnot local gateway is starting or unavailable.\n');
    });
    incoming.once('aborted', () => upstream.destroy());
    outgoing.once('close', () => { if (!outgoing.writableFinished) upstream.destroy(); });
    incoming.pipe(upstream);
  });
}

async function dev(): Promise<void> {
  const { values } = parseArgs({ options: { containers: { type: 'boolean', default: false }, 'no-web': { type: 'boolean', default: false } }, strict: true });
  if (!existsSync(join(ROOT, '.gitknot/local/keys.json'))) throw new Error('Run npm run setup before npm run dev.');
  await Promise.all([8787, 8788, 8790, 8791, 8792, ...(values['no-web'] ? [] : [5173])].map(requirePort));
  await createProjects();
  const nativeBuild = await watchLocalNativeGit();
  const keys = localKeys();
  const env = offlineEnvironment({ GITKNOT_MODE: 'development', GITKNOT_LOCAL_CONTAINERS: String(values.containers) });
  const children: ChildProcess[] = [];
  const proxy = gitProxy();
  let stopping = false;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(sweepTimer);
    void nativeBuild.close().catch(error => console.error(`Native watcher shutdown failed: ${String(error)}`));
    proxy.close();
    proxy.closeAllConnections();
    for (const child of children) {
      if (!child.pid || child.exitCode !== null) continue;
      try { process.platform === 'win32' ? child.kill('SIGTERM') : process.kill(-child.pid, 'SIGTERM'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') console.error('Could not stop a local development process.'); }
    }
  };
  const launch = (name: string, executable: string, args: string[], cwd = ROOT, additional: NodeJS.ProcessEnv = {}) => {
    const child = spawn(executable, args, { cwd, env: { ...env, ...additional }, stdio: 'inherit', detached: process.platform !== 'win32', shell: false });
    children.push(child);
    child.once('error', error => { console.error(`${name}: ${error.message}`); process.exitCode = 1; stop(); });
    child.once('exit', (code, signal) => {
      if (!stopping) { console.error(`${name} stopped (${signal ?? code}).`); process.exitCode = code || 1; stop(); }
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('exit', stop);
  proxy.on('error', error => { console.error(error.message); process.exitCode = 1; stop(); });
  proxy.listen(8788, '127.0.0.1');
  launch('native Git', process.execPath, ['--watch', '--watch-preserve-output', nativeBuild.entrypoint], ROOT, {
    INTERNAL_SERVICE_KEY: keys.git.INTERNAL_SERVICE_KEY,
    ENVIRONMENT: 'development', PORT: '8790', HOST: '127.0.0.1',
    GIT_STORAGE_MODE: 'local', GIT_LOCAL_ROOT: join(ROOT, '.gitknot/git/repositories'), GIT_SESSION_ROOT: join(ROOT, '.gitknot/git/sessions'),
    GIT_CALLBACK_ORIGIN: 'http://localhost:8788',
  });
  launch('webhook transport', process.execPath, [join(ROOT, 'ops/egress/server.ts')], ROOT, {
    INTERNAL_SERVICE_KEY: keys.background.INTERNAL_SERVICE_KEY, PORT: '8791', ENVIRONMENT: 'development',
  });
  launch('Cloudflare local services', process.execPath, [CF_BIN, 'dev', '--mode', 'development'], projectDirectory('development'));
  try { await initializeLocalVault(keys.secrets.SECRETS_SERVICE_KEYS_JSON!, () => stopping); }
  catch (error) { stop(); throw error; }
  if (!values['no-web']) launch('web', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev', '--workspace', '@gitknot/web']);
  console.log('GitKnot: web http://localhost:5173 · API http://localhost:8787 · Git http://localhost:8788');
  console.log(`Durable local state: ${LOCAL_STATE}/v3. Hosted Linux Containers: ${values.containers ? 'real Docker runtime' : 'not allocated; pass --containers to enable Docker'}.`);
  // Local scheduled triggers are not an automatic production cron service.
  // Drive the same authenticated sweeper so outbox/queues/recovery work in dev.
  const background = backgroundHttp('http://localhost:8787', keys.background.INTERNAL_SERVICE_KEY!);
  let sweeping = false;
  let lastFailure = '';
  sweepTimer = setInterval(() => {
    if (stopping || sweeping) return;
    sweeping = true;
    void background.fetch(new Request('https://internal.gitknot.com/internal/operations/sweep', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).then(async response => {
      await response.body?.cancel();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      lastFailure = '';
    }).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      if (!stopping && message !== lastFailure) console.error(`Local background sweeper unavailable: ${message}`);
      lastFailure = message;
    }).finally(() => { sweeping = false; });
  }, 15_000);
}

main(dev);
