import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { beforeAll, expect, it } from 'vitest';
import { command, projectRoot, temporaryDirectory } from '../../packages/runner/tests/support.ts';
import { moveFixture } from '../support/move-fixture.ts';
import type { AuthConfiguration } from '../../packages/cli/src/config.ts';
import { signInternalRequest, verifyInternalRequest } from '../../packages/core/src/index.ts';
import { GIT_NATIVE_SCOPE } from '../../packages/git/src/types.ts';
import type { NativeSessionSpec, PublicationPermit } from '../../packages/git/src/types.ts';
import { startNativeServer } from '../../services/git/src/server.ts';

interface ProcessResult { code: number | null; stdout: string; stderr: string }
function processResult(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input = ''): Promise<ProcessResult> {
  const child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const out = new StringDecoder('utf8'), err = new StringDecoder('utf8');
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += out.write(chunk); });
    child.stderr.on('data', chunk => { stderr += err.write(chunk); });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout: stdout + out.end(), stderr: stderr + err.end() }));
    child.stdin.end(input);
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing native HTTP fixture port.');
  return `http://127.0.0.1:${address.port}`;
}

async function incoming(request: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks), headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
  return new Request(new URL(request.url!, origin), { method: request.method, headers, ...(body.byteLength ? { body: Uint8Array.from(body) } : {}) });
}

async function outgoing(response: ServerResponse, result: Response): Promise<void> {
  response.writeHead(result.status, Object.fromEntries(result.headers));
  if (result.body) await pipeline(Readable.fromWeb(result.body as unknown as NodeReadableStream<Uint8Array>), response);
  else response.end();
}

async function installCli(directory: string): Promise<string> {
  const [packed] = JSON.parse(await command('npm', ['pack', '--workspace', '@gitknot/cli', '--ignore-scripts', '--json', '--pack-destination', directory], projectRoot)) as Array<{ filename: string }>;
  const install = join(directory, 'installed'); await mkdir(install);
  await command('tar', ['-xzf', join(directory, packed!.filename), '-C', install], directory);
  const dependencies = join(install, 'package', 'node_modules'); await mkdir(dependencies);
  const require = createRequire(join(projectRoot, 'packages', 'cli', 'package.json'));
  for (const name of ['yaml', 'zod', 'fast-xml-parser']) {
    let source = dirname(require.resolve(name));
    for (;;) {
      try { if (JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).name === name) break; } catch {}
      if (dirname(source) === source) throw new Error(`Missing CLI dependency ${name}.`);
      source = dirname(source);
    }
    await symlink(source, join(dependencies, name), 'dir');
  }
  const executable = join(install, 'gitknot');
  await symlink(join(install, 'package', 'dist', 'cli', 'src', 'index.js'), executable);
  return executable;
}

async function httpNative(test: Awaited<ReturnType<typeof moveFixture>>, origin: string, directory: string) {
  const env = test.env, key = env.INTERNAL_SERVICE_KEY;
  const callback = async <T>(spec: NativeSessionSpec, action: string, value: Record<string, unknown>): Promise<T> => {
    const response = await env.GIT_SERVICE.fetch(await signInternalRequest(new Request(`${spec.callback_url}/${action}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publisher_id: spec.publisher_id, fence: spec.fence, ...value }) }), key, GIT_NATIVE_SCOPE));
    if (!response.ok) throw new Error(`Native HTTP callback ${action}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<T>;
  };
  const native = await startNativeServer({ configuration: { mode: 'test', cache_root: join(directory, 'http-native-cache'),
    local_authority_root: dirname(dirname(test.sourceStores.get(test.storageName)!)), max_sessions: 8, callback_origin: origin },
    authenticate: request => verifyInternalRequest(request, key, GIT_NATIVE_SCOPE), callbacks: {
      validated: async (spec, evidence) => { await callback(spec, 'validated', { evidence }); },
      permit: (spec, evidence) => callback<PublicationPermit>(spec, 'permit', { evidence_digest: evidence.digest }),
      result: async (spec, result) => { await callback(spec, 'result', { result }); },
      rejected: async (spec, reason, code) => { await callback(spec, 'rejected', { reason, code }); },
    }, on_error: error => { test.diagnostics.push(error); } }, 0, '127.0.0.1');
  env.GIT_ORIGIN = origin;
  env.GIT_CONTAINERS = { idFromName: (id: string) => id, get: () => ({ fetch: (request: Request) => native.service.fetch(request) }) } as unknown as DurableObjectNamespace;
  return native;
}

beforeAll(async () => { await command('npm', ['run', 'build', '--workspace', '@gitknot/cli'], projectRoot); }, 180_000);

it('clones and pushes through the configured installed helper on distinct API/Git HTTP ports without releasing credentials to another origin', async () => {
  const directory = await temporaryDirectory('cli-native-git'), home = join(directory, 'home'); await mkdir(home);
  const executable = await installCli(directory);
  let test: Awaited<ReturnType<typeof moveFixture>> | undefined;
  let native: Awaited<ReturnType<typeof httpNative>> | undefined;
  let apiOrigin = '', gitOrigin = '', foreignOrigin = '', redirect = false, foreignRequests = 0;
  const apiAuthentication: string[] = [], gitAuthentication: string[] = [], apiPaths: string[] = [];
  const failures: unknown[] = [];
  const failed = (response: ServerResponse, error: unknown) => {
    failures.push(error);
    if (response.headersSent) response.destroy(); else { response.writeHead(503); response.end(); }
  };
  const api = createServer(async (request, response) => {
    try {
      if (!test) throw new Error('API fixture is not ready.');
      if (request.headers.authorization) apiAuthentication.push(request.headers.authorization.split(' ')[0]!);
      apiPaths.push(new URL(request.url!, apiOrigin).pathname);
      await outgoing(response, await (test.env.API as Fetcher).fetch(await incoming(request, apiOrigin)));
    } catch (error) { failed(response, error); }
  });
  const git = createServer(async (request, response) => {
    try {
      if (!test) throw new Error('Git fixture is not ready.');
      if (request.headers.authorization) gitAuthentication.push(request.headers.authorization.split(' ')[0]!);
      const result = await test.env.GIT_SERVICE.fetch(await incoming(request, gitOrigin));
      if (redirect && request.headers.authorization && result.ok) {
        await result.body?.cancel(); response.writeHead(302, { location: `${foreignOrigin}${request.url}` }); response.end(); return;
      }
      await outgoing(response, result);
    } catch (error) { failed(response, error); }
  });
  const foreign = createServer((_request, response) => { foreignRequests++; response.writeHead(401, { 'www-authenticate': 'Basic realm="foreign"' }); response.end(); });
  [apiOrigin, gitOrigin, foreignOrigin] = await Promise.all([listen(api), listen(git), listen(foreign)]);
  try {
    test = await moveFixture();
    native = await httpNative(test, gitOrigin, directory);
    expect(test.env.GIT_ORIGIN).toBe(gitOrigin);
    test.env.API_ORIGIN = apiOrigin; test.env.APP_ORIGIN = apiOrigin;
    const original = await test.initializeGit();
    const globalConfig = join(home, '.gitconfig');
    const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0',
      GIT_TERMINAL_PROMPT: '0', GITKNOT_API_URL: apiOrigin, GITKNOT_CONFIG_DIR: join(directory, 'config'), GITKNOT_TOKEN: undefined, GITKNOT_ALLOW_LOOPBACK_HTTP: undefined };
    const cli = (args: string[], input = '') => processResult(process.execPath, [executable, ...args], directory, env, input);
    const login = await cli(['auth', 'login', '--with-token', '--allow-loopback-http', '--json'], `${test.token}\n`);
    expect(login.code, login.stderr).toBe(0);
    const setup = await cli(['auth', 'setup-git', '--allow-loopback-http', '--json']);
    expect(setup.code, setup.stderr).toBe(0); expect(JSON.parse(setup.stdout).git_origin).toBe(gitOrigin);
    const helper = await command('git', ['config', '--global', '--get', `credential.${gitOrigin}.helper`], directory, env);
    expect(helper).toContain(`--api-url '${apiOrigin}'`); expect(helper).toContain(`--git-url '${gitOrigin}'`); expect(helper).toContain('--allow-loopback-http');
    expect(helper).not.toContain(test.token); expect(helper).not.toContain('GITKNOT_TOKEN=');
    expect(await command('git', ['config', '--global', '--get-urlmatch', 'http.followRedirects', `${gitOrigin}/physical/physical.git`], directory, env)).toBe('false');
    const saved = JSON.parse(await readFile(join(directory, 'config', 'auth.json'), 'utf8')) as AuthConfiguration;
    expect(saved.git_origins?.[apiOrigin]).toEqual({ origin: gitOrigin, allow_loopback_http: true });
    expect((await stat(join(directory, 'config', 'auth.json'))).mode & 0o077).toBe(0);

    const noOptIn = await cli(['repo', 'clone', 'physical/physical', 'not-cloned', '--json']);
    expect(noOptIn.code).toBe(1); expect(noOptIn.stderr).toContain('https_required');
    const cloned = await cli(['repo', 'clone', 'physical/physical', 'checkout', '--allow-loopback-http', '--json']);
    expect(cloned.code, cloned.stderr).toBe(0);
    const checkout = join(directory, 'checkout'), remote = `${gitOrigin}/physical/physical.git`;
    expect(JSON.parse(cloned.stdout)).toMatchObject({ cloned: true, remote });
    expect(await command('git', ['remote', 'get-url', 'origin'], checkout, env)).toBe(remote);
    expect(await command('git', ['rev-parse', 'HEAD'], checkout, env)).toBe(original);
    expect(await readFile(join(checkout, 'README.md'), 'utf8')).toContain('Actual native graph across cells');
    expect(apiPaths).toContain('/v1/meta'); expect(apiPaths).toContain('/v1/repos/resolve/physical/physical');

    // These are stock Git invocations. Their only credential source is the
    // globally configured, origin-bound CLI helper; no loopback env flag remains.
    expect(await command('git', ['ls-remote', 'origin', 'refs/heads/main'], checkout, env)).toContain(original);
    await writeFile(join(checkout, 'from-cli.txt'), 'Published through the installed GitKnot helper\n');
    await command('git', ['add', 'from-cli.txt'], checkout, env);
    await command('git', ['-c', 'user.name=CLI transport fixture', '-c', 'user.email=cli@example.net', '-c', 'commit.gpgsign=false', 'commit', '-m', 'CLI HTTP publication'], checkout, env);
    const pushed = await command('git', ['rev-parse', 'HEAD'], checkout, env);
    const publication = await processResult('git', ['push', 'origin', 'HEAD:refs/heads/main'], checkout, env);
    expect(publication.code, publication.stderr).toBe(0);
    expect(await test.git(test.sourceStores.get(test.storageName)!, 'rev-parse', 'refs/heads/main')).toBe(pushed);
    expect(await command('git', ['ls-remote', 'origin', 'refs/heads/main'], checkout, env)).toContain(pushed);

    for (const target of [foreignOrigin, apiOrigin, gitOrigin.replace('127.0.0.1', 'localhost'), gitOrigin.replace('http:', 'https:')]) {
      const url = new URL(target), input = `protocol=${url.protocol.slice(0, -1)}\nhost=${url.host}\npath=physical/physical.git\n\n`;
      const rejected = await processResult('git', ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`, 'credential', 'fill'], checkout, env, input);
      expect(rejected.code).not.toBe(0); expect(rejected.stdout).not.toContain('password='); expect(rejected.stdout + rejected.stderr).not.toContain(test.token);
    }
    const forged = await cli(['auth', 'git-credential', 'get', '--git-url', foreignOrigin, '--allow-loopback-http'], `protocol=http\nhost=${new URL(foreignOrigin).host}\n\n`);
    expect(forged.code).toBe(0); expect(forged.stdout).toBe('');
    redirect = true;
    const redirected = await processResult('git', ['ls-remote', 'origin'], checkout, env);
    expect(redirected.code).not.toBe(0); expect(foreignRequests).toBe(0);
    redirect = false;
    test.env.GIT_ORIGIN = 'http://outside.example';
    const invalid = await cli(['auth', 'setup-git', '--allow-loopback-http', '--json']);
    expect(invalid.code).toBe(1); expect(invalid.stderr).toContain('git_origin_invalid');
    test.env.GIT_ORIGIN = gitOrigin;
    expect((JSON.parse(await readFile(join(directory, 'config', 'auth.json'), 'utf8')) as AuthConfiguration).git_origins?.[apiOrigin]?.origin).toBe(gitOrigin);
    expect(await readFile(globalConfig, 'utf8')).not.toContain(test.token);
    expect(await readFile(join(checkout, '.git', 'config'), 'utf8')).not.toContain(test.token);
    expect(login.stdout + setup.stdout + cloned.stdout + cloned.stderr + publication.stderr).not.toContain(test.token);
    expect(apiAuthentication.length).toBeGreaterThan(0); expect(apiAuthentication.every(value => value === 'Bearer')).toBe(true);
    expect(gitAuthentication.length).toBeGreaterThan(0); expect(gitAuthentication.every(value => value === 'Basic')).toBe(true);
    expect(failures).toEqual([]);
  } finally {
    for (const server of [api, git, foreign]) server.closeAllConnections();
    await Promise.all([api, git, foreign].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await native?.close(); await test?.close(); await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
