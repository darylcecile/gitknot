import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, symlink, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { command, gitFixture, ociFixture, projectRoot, shellNode, temporaryDirectory, workflow, type GitFixture } from '../../packages/runner/tests/support.ts';
import { decodeUtf8 } from '../../packages/runner/src/index.ts';
import { browserBoundary, errorResponse, execute, hashPassword, identityContext, now, one, prepareCredential, requestContext, routeResourceRequest, sha256, stmt, verifyInternalRequest } from '../../packages/core/src/index.ts';
import type { AppEnv, Bindings } from '../../packages/core/src/index.ts';
import type { AuthConfiguration } from '../../packages/cli/src/config.ts';
import type { ExecutionPlan } from '../../packages/execution/src/types.ts';
import { registerIdentityRoutes } from '../../apps/api/src/modules/identity.ts';
import { registerGitRoutes } from '../../apps/api/src/modules/git.ts';
import { registerRepositoryRoutes } from '../../apps/api/src/modules/repositories.ts';
import { registerCollaborationRoutes } from '../../apps/api/src/modules/collaboration.ts';
import { registerWorkflowsRoutes } from '../../apps/api/src/modules/workflows.ts';
import { registerRunnersRoutes } from '../../apps/api/src/modules/runners.ts';
import { browse } from '../../services/git/src/browse.ts';
import { NativeGit } from '../../services/git/src/process.ts';
import { DEFAULT_GIT_LIMITS } from '../../packages/git/src/types.ts';
import { gitErrorResponse } from '../../packages/git/src/errors.ts';
import { createTestEnvironment } from '../support/environment.ts';

interface CliResult { code: number | null; stdout: string; stderr: string }
const binary = join(projectRoot, 'packages', 'cli', 'dist', 'cli', 'src', 'index.js');

function cli(args: string[], cwd: string, env: NodeJS.ProcessEnv, stdin = '', executable = binary): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [executable, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (bytes: Buffer) => { stdout += decodeUtf8(bytes); });
    child.stderr.on('data', (bytes: Buffer) => { stderr += decodeUtf8(bytes); });
    child.once('error', reject); child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

const password = 'A private CLI session rotation fixture passphrase.';
async function actualApi(fixture: GitFixture, token: string) {
  const test = await createTestEnvironment(), db = test.env.DB, at = now();
  const hash = await hashPassword(password);
  for (const [id, username] of [['u_cli', 'cli-user'], ['u_session', 'cli-session']] as const) await db.batch([
    stmt(db, 'INSERT INTO users(id,username,email,email_verified_at,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', id, username, `${username}@example.net`, at, hash, at, at),
    stmt(db, "INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES (?,'user',?,?,?,?,?)", id, username, username, id, at, at),
    stmt(db, "INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES (?,'user',?,?,?,?,?,?)", id, id, id, username, id, at, at),
  ]);
  await execute(db, `INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
    VALUES ('r_native','u_cli','native','native','private','active','local','core','native','u_cli',?,?)`, at, at);
  const credential = await prepareCredential(db, { principal_id: 'u_cli', user_id: 'u_cli', kind: 'personal', name: 'CLI fixture', capabilities: ['*'],
    repository_ids: null, account_ids: null, auth_revision: 1, mfa: false, expires_at: new Date(Date.now() + 86_400_000).toISOString(), created_by: 'u_cli' });
  await credential.statement.run();
  await execute(db, 'UPDATE credentials SET token_hash=? WHERE id=?', await sha256(token), credential.credential.id);
  test.env.GIT_SERVICE = { fetch: async (request: Request) => {
    await verifyInternalRequest(request, test.env.INTERNAL_SERVICE_KEY, 'git-service');
    const input = await request.json() as { query: Record<string, string> };
    const action = /^\/internal\/git\/repositories\/r_native\/browse\/(compare|raw)$/.exec(new URL(request.url).pathname)?.[1];
    if (!action) throw new Error('Unexpected native fixture operation.');
    try { return await browse(new NativeGit(fixture.repo, DEFAULT_GIT_LIMITS, Date.now() + 30_000), action, new URLSearchParams(input.query)); }
    catch (error) { return gitErrorResponse(error); }
  } } as Fetcher;
  const app = new Hono<AppEnv>();
  app.onError(errorResponse);
  app.use('*', requestContext);
  app.use('/v1/*', browserBoundary);
  app.use('/v1/*', async (c, next) => { const forwarded = await routeResourceRequest(c); if (forwarded) return forwarded; await next(); });
  app.use('/v1/*', identityContext);
  registerIdentityRoutes(app); registerGitRoutes(app); registerRepositoryRoutes(app); registerCollaborationRoutes(app);
  registerWorkflowsRoutes(app); registerRunnersRoutes(app);
  return { ...test, app };
}

async function apiResponse(api: Awaited<ReturnType<typeof actualApi>>, request: IncomingMessage, origin: string, body: Buffer): Promise<Response> {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
  const input = new Request(new URL(request.url!, origin), { method: request.method, headers,
    ...(['GET', 'HEAD'].includes(request.method!) || body.byteLength === 0 ? {} : { body: Uint8Array.from(body) }) });
  const env: Bindings = { ...api.env, API_ORIGIN: origin, APP_ORIGIN: origin };
  return api.app.fetch(input, env, api.context);
}

async function writeResponse(response: ServerResponse, result: Response, extraCookies: string[] = [], loseAcknowledgement = false): Promise<void> {
  const headers = Object.fromEntries([...result.headers].filter(([name]) => name !== 'set-cookie'));
  const cookies = [...result.headers.getSetCookie(), ...extraCookies];
  if (cookies.length) response.setHeader('set-cookie', cookies);
  const replacement = result.headers.getSetCookie().find(value => value.startsWith('__Host-gitknot_session='))?.split(';')[0]?.split('=')[1];
  if (loseAcknowledgement && result.ok && replacement) {
    await result.body?.cancel();
    response.writeHead(400, headers);
    response.end(JSON.stringify({ error: { code: 'fixture_response_lost', message: `Session changed to ${replacement}` } }));
  } else { response.writeHead(result.status, headers); response.end(Buffer.from(await result.arrayBuffer())); }
}

async function retainedRun(api: Awaited<ReturnType<typeof actualApi>>, input: { id: string; workflow_id: string; version_id: string; commit: string; status: 'succeeded' | 'failed' }): Promise<void> {
  const db = api.env.DB, at = now();
  const version = (await one<{ definition_digest: string }>(db, 'SELECT definition_digest FROM workflow_versions WHERE id=?', input.version_id))!;
  const provenance: ExecutionPlan = { version: 1, repo_id: 'r_native', account_id: 'u_cli', source_repo_id: 'r_native', related_repo_ids: ['r_native'],
    commit_sha: input.commit, source_ref: 'refs/heads/main', workflow_digest: version.definition_digest, workflow_version_id: input.version_id,
    policy_revision: 1, trust: 'trusted', trigger: { type: 'workflow.dispatch', id: input.id }, concurrency: { key: null, supersede: false },
    jobs: [], portable_manifest: {}, actor: { id: 'u_cli', kind: 'user', user_id: 'u_cli', credential_id: null }, routing_epoch: 1 };
  const plan = JSON.stringify(provenance);
  await execute(db, `INSERT INTO workflow_runs(id,repo_id,account_id,workflow_id,workflow_version_id,commit_sha,source_ref,workflow_digest,plan_digest,plan_json,policy_revision,trigger_type,trigger_id,trust,status,requested_by,request_key,request_hash,created_at,updated_at,completed_at)
    VALUES (?,'r_native','u_cli',?,?,?,'refs/heads/main',?,?,?,1,'workflow.dispatch',?,'trusted',?,'u_cli',?,?,?,?,?)`,
  input.id, input.workflow_id, input.version_id, input.commit, version.definition_digest, await sha256(plan), plan, input.id, input.status,
  input.id, await sha256(input.id), at, at, at);
}

async function retainedLogs(api: Awaited<ReturnType<typeof actualApi>>, runId: string): Promise<void> {
  const db = api.env.DB, at = now(), expires = new Date(Date.now() + 3600_000).toISOString();
  const run = (await one<{ plan_digest: string }>(db, 'SELECT plan_digest FROM workflow_runs WHERE id=?', runId))!;
  for (const key of ['first', 'second']) {
    const job = `job_cli_${key}`, attempt = `att_cli_${key}`, object = `obj_cli_${key}`, storage = `cli-logs/${key}`, text = `${key} job log\n`;
    await api.env.BLOBS.put(storage, text);
    await db.batch([
      stmt(db, `INSERT INTO workflow_jobs(id,repo_id,account_id,run_id,job_key,definition_json,status,generation,current_attempt_id,created_at,updated_at)
        VALUES (?,'r_native','u_cli',?,?,?,'succeeded',1,?,?,?)`, job, runId, key, JSON.stringify({ key, environment: null }), attempt, at, at),
      stmt(db, `INSERT INTO execution_attempts(id,repo_id,account_id,run_id,job_id,generation,plan_digest,toolchain_digest,producer_id,executor,status,queue_deadline_at,cleanup_state,destruction_verified_at,receipt_hash,created_at,updated_at)
        VALUES (?,'r_native','u_cli',?,?,1,?,?,'hosted:fixture','hosted','succeeded',?,'verified',?,?,?,?)`, attempt, runId, job, run.plan_digest, `sha256:${'f'.repeat(64)}`, expires, at, await sha256(text), at, at),
      stmt(db, `INSERT INTO execution_objects(id,repo_id,account_id,run_id,attempt_id,generation,kind,name,sequence,object_key,sha256,size_bytes,content_type,state,expires_at,created_at)
        VALUES (?,'r_native','u_cli',?,?,1,'log','combined',0,?,?,?,'text/plain','sealed',?,?)`, object, runId, attempt, storage, await sha256(text), Buffer.byteLength(text), expires, at),
    ]);
  }
}

describe('installed compiled gitknot CLI and API/local workflow journeys', () => {
  let fixture: GitFixture;
  let directory: string;
  let origin: string;
  let env: NodeJS.ProcessEnv;
  let actual: Awaited<ReturnType<typeof actualApi>>;
  let compareHead: string;
  let installed: Promise<string> | undefined;
  const token = 'gkt_cli_fixture_token_12345678901234567890';
  const bytes = Buffer.from([0, 1, 2, 0xff, 0x80, 17, 99]);
  const requests: Array<{ method: string; path: string; query: string; body: Buffer; ifMatch?: string }> = [];
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(part as Buffer);
    const body = Buffer.concat(parts); const url = new URL(req.url!, origin);
    requests.push({ method: req.method!, path: url.pathname, query: url.search, body, ifMatch: req.headers['if-match'] as string | undefined });
    if (/^\/v1\/(?:repos\/(?:r_native|r_other|resolve)(?:\/|$)|runner-pools(?:\/|$)|runs\/run_cli_)/.test(url.pathname)
      || url.pathname === '/v1/repos' && url.searchParams.has('visibility')) {
      await writeResponse(res, await apiResponse(actual, req, origin, body)); return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end(JSON.stringify({ error: { code: 'authentication_required', message: 'Sign in.', request_id: 'req_fixture' } })); return; }
    if (url.pathname === '/v1/tokens/current') { res.end(JSON.stringify({ id: 'cred_fixture', expires_at: new Date(Date.now() + 86_400_000).toISOString(), capabilities: ['contents.read', 'issues.write'] })); return; }
    if (url.pathname === '/v1/repos') { res.end(JSON.stringify({ items: [{ id: url.searchParams.has('cursor') ? 'r_second' : 'r_first' }], next_cursor: url.searchParams.has('cursor') ? null : 'next-page' })); return; }
    if (url.pathname === '/v1/repos/r_fixture/runs' && req.method === 'POST') { res.writeHead(202); res.end(JSON.stringify({ id: 'run_pending', run_id: 'run_pending', operation_id: 'op_planning', repo_id: 'r_fixture', status: 'planning' })); return; }
    if (url.pathname === '/v1/runs/run_pending') { res.end(JSON.stringify({ id: 'run_pending', status: 'succeeded', result: 'current-placement-result' })); return; }
    if (url.pathname === '/v1/workflow-operations/op_workflow') { res.end(JSON.stringify({ id: 'op_workflow', kind: 'approve', run_id: 'run_pending', status: 'completed' })); return; }
    if (url.pathname.endsWith('/issues/issue_fixture')) {
      if (req.headers['if-match'] !== '"3"') { res.writeHead(412); res.end(JSON.stringify({ error: { code: 'revision_conflict', message: 'Refresh the resource.', request_id: 'req_conflict' } })); return; }
      res.setHeader('etag', '"4"'); res.end(body); return;
    }
    if (url.pathname === '/v1/upload') { res.end(JSON.stringify({ size_bytes: body.length, digest: `sha256:${createHash('sha256').update(body).digest('hex')}` })); return; }
    if (url.pathname === '/v1/download') { res.setHeader('content-type', 'application/octet-stream'); res.end(bytes); return; }
    res.writeHead(403); res.end(JSON.stringify({ error: { code: 'denied', message: `Denied ${token}`, request_id: 'req_safe' } }));
  });

  beforeAll(async () => {
    await command('npm', ['run', 'build', '--workspace', '@gitknot/cli'], projectRoot);
    fixture = await gitFixture(); directory = await temporaryDirectory('cli');
    compareHead = fixture.commit;
    await command('git', ['branch', 'cli-comparison-head', compareHead], fixture.repo);
    await fixture.commitFiles({ 'comparison.txt': 'A real branch difference.\n' });
    actual = await actualApi(fixture, token);
    const isolated = await ociFixture(); fixture.toolchain = isolated.toolchain;
    await writeFile(join(directory, 'isolation.json'), JSON.stringify(isolated.isolation));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test address');
    origin = `http://127.0.0.1:${address.port}`;
    env = { ...process.env, GITKNOT_TOKEN: undefined, GITKNOT_CONFIG_DIR: join(directory, 'config'), GITKNOT_STATE_DIR: join(directory, 'state'), GITKNOT_API_URL: origin, GITKNOT_ALLOW_LOOPBACK_HTTP: '1' };
  }, 180_000);
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); actual?.close(); await fixture?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

  async function installedCli(): Promise<string> {
    installed ??= installCli();
    return installed;
  }

  async function installCli(): Promise<string> {
    const metadata = JSON.parse(await command('npm', ['pack', '--workspace', '@gitknot/cli', '--ignore-scripts', '--json', '--pack-destination', directory], projectRoot)) as Array<{ filename: string; files: Array<{ path: string }> }>;
    expect(metadata[0]?.files.some((file) => file.path === 'dist/cli/src/index.js')).toBe(true);
    expect(metadata[0]?.files.some((file) => file.path.endsWith('.ts'))).toBe(false);
    const install = join(directory, 'install'); await mkdir(install);
    await command('tar', ['-xzf', join(directory, metadata[0]!.filename), '-C', install], projectRoot);
    const require = createRequire(join(projectRoot, 'packages', 'cli', 'package.json'));
    const dependencies = join(install, 'package', 'node_modules'); await mkdir(dependencies);
    for (const name of ['yaml', 'zod', 'fast-xml-parser']) {
      let source = dirname(require.resolve(name));
      while (dirname(source) !== source) {
        try { if (JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).name === name) break; } catch {}
        source = dirname(source);
      }
      await symlink(source, join(dependencies, name), 'dir');
    }
    const link = join(install, 'gitknot'); await symlink(join(install, 'package', 'dist', 'cli', 'src', 'index.js'), link);
    return link;
  }

  it('packs an actual executable that runs from its npm bin symlink without source TypeScript', async () => {
    const result = await cli(['--help'], directory, env, '', await installedCli());
    expect(result.code, result.stderr).toBe(0); expect(result.stdout).toContain('GitKnot'); expect(result.stdout).toContain('runner'); expect(result.stderr).toBe('');
  });

  it('authenticates safely, preserves cursor/ETag semantics, streams binary bytes, and emits redacted nonzero errors', async () => {
    const login = await cli(['auth', 'login', '--with-token', '--json'], directory, env, `${token}\n`);
    expect(login.code).toBe(0); expect(login.stdout + login.stderr).not.toContain(token);
    expect((await stat(join(directory, 'config', 'auth.json'))).mode & 0o077).toBe(0);
    const pages = await cli(['repo', 'list', '--paginate'], directory, env);
    expect(pages.code).toBe(0); expect(pages.stdout.trim().split('\n').map((line) => JSON.parse(line).items[0].id)).toEqual(['r_first', 'r_second']);
    const edit = await cli(['issue', 'edit', 'issue_fixture', '--repo', 'r_fixture', '--if-match', '"3"', '--title', 'A precise title'], directory, env);
    expect(edit.code).toBe(0); expect(JSON.parse(edit.stdout).title).toBe('A precise title');
    expect(requests.at(-1)?.ifMatch).toBe('"3"');
    const stale = await cli(['issue', 'close', 'issue_fixture', '--repo', 'r_fixture', '--if-match', '"2"'], directory, env);
    expect(stale.code).toBe(1); expect(stale.stderr).toContain('revision_conflict');
    const compared = await cli(['repo', 'compare', 'r_native', '--base', 'refs/heads/main', '--head', 'refs/heads/cli-comparison-head', '--json'], directory, env);
    expect(compared.code, compared.stderr).toBe(0);
    expect(JSON.parse(compared.stdout)).toMatchObject({ base_oid: fixture.commit, head_oid: compareHead, ahead: 0, behind: 1, files: [{ path: 'comparison.txt', additions: 0, deletions: 1 }] });
    const missingRef = await cli(['repo', 'compare', 'r_native', '--base', 'refs/heads/main', '--head', 'refs/heads/does-not-exist', '--json'], directory, env);
    expect(missingRef.code).toBe(1); expect(missingRef.stdout).toBe(''); expect(missingRef.stderr).toContain('ref_not_found');
    const upload = join(directory, 'upload.bin'); await writeFile(upload, bytes);
    const sent = await cli(['api', 'PUT', '/v1/upload', '--binary', '--input', upload], directory, env);
    expect(sent.code).toBe(0); expect(JSON.parse(sent.stdout).size_bytes).toBe(bytes.length); expect(Array.from(requests.at(-1)!.body)).toEqual(Array.from(bytes));
    const destination = join(directory, 'download.bin'); const digest = createHash('sha256').update(bytes).digest('hex');
    const received = await cli(['api', 'GET', '/v1/download', '--output', destination, '--sha256', digest, '--size', String(bytes.length)], directory, env);
    expect(received.code).toBe(0); expect(Array.from(await readFile(destination))).toEqual(Array.from(bytes));
    const denied = await cli(['api', 'GET', '/v1/denied'], directory, env);
    expect(denied.code).toBe(1); expect(denied.stderr).toContain('[REDACTED]'); expect(denied.stderr).not.toContain(token); expect(denied.stderr).not.toContain(' at ');
    const unsafe = await cli(['auth', 'login', '--with-token'], fixture.repo, { ...env, GITKNOT_CONFIG_DIR: join(fixture.repo, 'credentials') }, token);
    expect(unsafe.code).toBe(1); expect(unsafe.stderr).toContain('credential_location');
  });

  it('plans and runs real pinned workflows and fails validation/test commands with useful stack-free errors', async () => {
    const definition = workflow({ test: { steps: [{ run: shellNode(`const fs=require('node:fs');if(process.env.GITKNOT_TOKEN)throw Error('inherited CLI credential');fs.writeFileSync('proof.txt','real shell');`) }], outputs: { proof: { type: 'string', path: 'proof.txt' } } } });
    await fixture.commitFiles({ '.gitknot/workflows/fixture.yaml': JSON.stringify(definition) });
    const tools = join(directory, 'toolchains.json'); await writeFile(tools, JSON.stringify({ 'fixture@1.0.0': fixture.toolchain }));
    const planPath = join(directory, 'plan.json');
    const planned = await cli(['workflow', 'plan', 'fixture', '--toolchains', tools, '--output', planPath, '--json'], fixture.repo, env);
    expect(planned.code).toBe(0); expect(JSON.parse(planned.stdout).source.commit).toBe(fixture.commit);
    const run = await cli(['workflow', 'run', 'fixture', '--local', '--manifest', planPath, '--isolation', join(directory, 'isolation.json'), '--json'], fixture.repo, { ...env, GITKNOT_TOKEN: token });
    expect(run.code).toBe(0); expect(JSON.parse(run.stdout).jobs[0].outputs[0].value).toBe('real shell');
    await writeFile(join(fixture.repo, '.gitknot/workflows/invalid.yaml'), 'version: 1\nversion: 2\n');
    const invalid = await cli(['workflow', 'validate', 'invalid', '--json'], fixture.repo, env);
    expect(invalid.code).toBe(1); expect(JSON.parse(invalid.stdout).valid).toBe(false);
    await fixture.commitFiles({ '.gitknot/workflows/fixture.yaml': JSON.stringify(workflow({ test: { steps: [{ run: 'exit 12' }] } })) });
    const failed = await cli(['workflow', 'run', 'fixture', '--local', '--toolchains', tools, '--isolation', join(directory, 'isolation.json'), '--json'], fixture.repo, env);
    expect(failed.code).toBe(1); expect(JSON.parse(failed.stdout).jobs[0].exit_code).toBe(12);
    const usage = await cli(['workflow', 'run', '--wrong-option', 'x'], fixture.repo, env);
    expect(usage.code).toBe(2); expect(usage.stderr).not.toContain(' at ');
  });

  it('watches a pending global run identity rather than its planning-operation ID and exposes workflow-operation URLs', async () => {
    const authenticated = { ...env, GITKNOT_TOKEN: token };
    const watched = await cli(['workflow', 'run', 'verify', '--repo', 'r_fixture', '--commit', 'a'.repeat(40), '--ref', 'refs/heads/main', '--watch', '--json'], directory, authenticated);
    expect(watched.code, watched.stderr).toBe(0);
    expect(JSON.parse(watched.stdout)).toMatchObject({ id: 'run_pending', status: 'succeeded', result: 'current-placement-result' });
    expect(requests.at(-1)?.path).toBe('/v1/runs/run_pending');
    const operation = await cli(['workflow', 'operation', 'op_workflow', '--json'], directory, authenticated);
    expect(operation.code).toBe(0);
    expect(requests.at(-1)?.path).toBe('/v1/workflow-operations/op_workflow');
    expect(JSON.parse(operation.stdout).status).toBe('completed');
  });

  it('persists real HTTPS session rotation/removal before body handling, rejects unrelated cookies, and reuses the rotated credential in a live client', async () => {
    const cert = join(directory, 'cli-localhost.pem'), key = join(directory, 'cli-localhost.key');
    await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], directory);
    let secureOrigin = '', extraCookies: string[] = [], loseAcknowledgement = false;
    const secure = createSecureServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
      const parts: Buffer[] = []; for await (const part of request) parts.push(part as Buffer);
      await writeResponse(response, await apiResponse(actual, request, secureOrigin, Buffer.concat(parts)), extraCookies, loseAcknowledgement);
    });
    await new Promise<void>(resolve => secure.listen(0, '127.0.0.1', resolve));
    const address = secure.address(); if (!address || typeof address === 'string') throw new Error('Missing HTTPS fixture address.');
    secureOrigin = `https://127.0.0.1:${address.port}`;
    const sessionEnv = { ...env, NODE_EXTRA_CA_CERTS: cert }, selected = ['--api-url', secureOrigin, '--json'];
    const config = async () => JSON.parse(await readFile(join(directory, 'config', 'auth.json'), 'utf8')) as AuthConfiguration;
    const responses: CliResult[] = [], secrets = [password];
    const originalHost = (await config()).hosts[origin];
    try {
      const login = await cli(['auth', 'login', '--input', '-', ...selected], directory, sessionEnv, JSON.stringify({ login: 'cli-session', password }));
      responses.push(login); expect(login.code, login.stderr).toBe(0);
      const initial = (await config()).hosts[secureOrigin]!; secrets.push(initial.token);
      expect(initial).toMatchObject({ kind: 'session', cookie_name: '__Host-gitknot_session', credential_id: expect.any(String) });
      extraCookies = [`unrelated=${'x'.repeat(43)}; Path=/; Secure; HttpOnly`];
      const rotated = await cli(['api', 'POST', '/v1/auth/reauthenticate', '--input', '-', '--include', ...selected], directory, sessionEnv, JSON.stringify({ password }));
      responses.push(rotated); expect(rotated.code, rotated.stderr).toBe(0);
      const next = (await config()).hosts[secureOrigin]!; secrets.push(next.token);
      expect(next.token).not.toBe(initial.token);
      expect(next.credential_id).toBe(JSON.parse(rotated.stdout).body.session.id);
      expect(await one(actual.env.DB, 'SELECT revoked_at FROM credentials WHERE id=?', initial.credential_id)).toEqual({ revoked_at: expect.any(String) });
      expect((await actual.app.fetch(new Request(`${secureOrigin}/v1/me`, { headers: { cookie: `${initial.cookie_name}=${initial.token}` } }),
        { ...actual.env, API_ORIGIN: secureOrigin, APP_ORIGIN: secureOrigin }, actual.context)).status).toBe(401);
      const me = await cli(['user', 'me', ...selected], directory, sessionEnv); responses.push(me);
      expect(me.code, me.stderr).toBe(0); expect(JSON.parse(me.stdout).id).toBe('u_session');
      const poison = `gks_${'z'.repeat(43)}`;
      for (const cookie of [
        `other_session=${poison}; Path=/; Secure; HttpOnly`,
        `gitknot_session=${poison}; Path=/; Secure; HttpOnly`,
        `__Host-gitknot_session=${poison}; Domain=evil.example; Path=/; Secure; HttpOnly`,
        `__Host-gitknot_session=${poison}; Domain=127.0.0.1; Path=/; Secure; HttpOnly`,
        '__Host-gitknot_session=; Max-Age=0; Path=/v1/auth; Secure; HttpOnly',
        `__Host-gitknot_session=${poison}; Path=/; HttpOnly`,
      ]) {
        extraCookies = [cookie];
        const unchanged = await cli(['user', 'me', '--include', ...selected], directory, sessionEnv); responses.push(unchanged);
        expect(unchanged.code, unchanged.stderr).toBe(0); expect((await config()).hosts[secureOrigin]).toEqual(next);
        expect(unchanged.stdout + unchanged.stderr).not.toContain(poison);
      }
      extraCookies = []; loseAcknowledgement = true;
      const lost = await cli(['api', 'POST', '/v1/auth/reauthenticate', '--input', '-', ...selected], directory, sessionEnv, JSON.stringify({ password }));
      responses.push(lost); expect(lost.code).toBe(1); expect(lost.stderr).toContain('[REDACTED]');
      loseAcknowledgement = false;
      const recovered = (await config()).hosts[secureOrigin]!; secrets.push(recovered.token);
      expect(recovered.token).not.toBe(next.token); expect(recovered.credential_id).toBeNull();
      const afterLoss = await cli(['user', 'me', ...selected], directory, sessionEnv); responses.push(afterLoss);
      expect(afterLoss.code, afterLoss.stderr).toBe(0);
      const sameClient = await command(process.execPath, ['--input-type=module', '-e', `
        import {apiClient} from ${JSON.stringify(pathToFileURL(join(dirname(binary), 'config.js')).href)};
        import {parseArguments} from ${JSON.stringify(pathToFileURL(join(dirname(binary), 'args.js')).href)};
        const client=await apiClient(parseArguments(${JSON.stringify(selected)}));
        await client.request('POST','/v1/auth/reauthenticate',{body:{password:process.env.CLI_FIXTURE_PASSWORD}});
        console.log(JSON.stringify((await client.request('GET','/v1/me')).data));
      `], directory, { ...sessionEnv, CLI_FIXTURE_PASSWORD: password });
      expect(JSON.parse(sameClient).id).toBe('u_session');
      secrets.push((await config()).hosts[secureOrigin]!.token);
      const downloaded = await cli(['api', 'POST', '/v1/auth/reauthenticate', '--input', '-', '--output', join(directory, 'session-result.json'), ...selected], directory, sessionEnv, JSON.stringify({ password }));
      responses.push(downloaded); expect(downloaded.code, downloaded.stderr).toBe(0);
      const final = (await config()).hosts[secureOrigin]!; secrets.push(final.token);
      expect(final.token).not.toBe(recovered.token);
      const lastMe = await cli(['user', 'me', ...selected], directory, sessionEnv); responses.push(lastMe); expect(lastMe.code, lastMe.stderr).toBe(0);
      const logout = await cli(['api', 'POST', '/v1/auth/logout', ...selected], directory, sessionEnv); responses.push(logout);
      expect(logout.code, logout.stderr).toBe(0); expect((await config()).hosts[secureOrigin]).toBeUndefined();
      expect((await config()).hosts[origin]).toEqual(originalHost);
      expect((await stat(join(directory, 'config', 'auth.json'))).mode & 0o077).toBe(0);
      const loggedOut = await cli(['user', 'me', ...selected], directory, sessionEnv); responses.push(loggedOut); expect(loggedOut.code).toBe(1);
      const output = responses.map(value => value.stdout + value.stderr).join('\n') + sameClient + await readFile(join(directory, 'session-result.json'), 'utf8');
      for (const secret of secrets) expect(output).not.toContain(secret);
    } finally { secure.closeAllConnections(); await new Promise<void>(resolve => secure.close(() => resolve())); }
  }, 60_000);

  it('honors installed CLI filters, repository-only runner administration, immutable version history, and conditional environment deletion through real handlers', async () => {
    const executable = await installedCli(), db = actual.env.DB;
    const authenticated = { ...env, GITKNOT_TOKEN: token, GITKNOT_ACCOUNT: 'u_cli', GITKNOT_REPO: undefined };
    const run = (args: string[], input?: unknown, overrides: NodeJS.ProcessEnv = {}) => cli([...args, '--json', ...(input === undefined ? [] : ['--input', '-'])],
      directory, { ...authenticated, ...overrides }, input === undefined ? '' : JSON.stringify(input), executable);
    const resource = async <T = Record<string, unknown>>(args: string[], input?: unknown, overrides: NodeJS.ProcessEnv = {}): Promise<T> => {
      const response = await run(args, input, overrides);
      expect(response.code, response.stderr).toBe(0);
      return JSON.parse(response.stdout) as T;
    };
    const labels = await Promise.all(['wanted', 'other'].map(name => resource<{ id: string }>(['label', 'create', '--repo', 'r_native'], { name, color: 'aabbcc' })));
    const first = await resource<{ id: string }>(['issue', 'create', '--repo', 'r_native', '--title', 'First filtered issue'], { assignee_ids: ['u_cli'], label_ids: [labels[0]!.id] });
    const second = await resource<{ id: string }>(['issue', 'create', '--repo', 'r_native', '--title', 'Second filtered issue'], { assignee_ids: ['u_session'], label_ids: [labels[0]!.id] });
    const third = await resource<{ id: string }>(['issue', 'create', '--repo', 'r_native', '--title', 'Third filtered issue'], { assignee_ids: ['u_cli'], label_ids: [labels[1]!.id] });
    const byAssignee = await run(['issue', 'list', '--repo', 'r_native', '--assignee', 'u_cli', '--limit', '1', '--paginate']);
    expect(byAssignee.code, byAssignee.stderr).toBe(0);
    expect(byAssignee.stdout.trim().split('\n').flatMap(line => (JSON.parse(line) as { items: Array<{ id: string }> }).items.map(item => item.id)).sort()).toEqual([first.id, third.id].sort());
    const byLabel = await resource<{ items: Array<{ id: string }> }>(['issue', 'list', '--repo', 'r_native', '--label', labels[0]!.id]);
    expect(byLabel.items.map(item => item.id).sort()).toEqual([first.id, second.id].sort());
    const both = await resource<{ items: Array<{ id: string }> }>(['issue', 'list', '--repo', 'r_native', '--assignee', 'u_cli', '--label', labels[0]!.id]);
    expect(both.items.map(item => item.id)).toEqual([first.id]);
    expect(new URLSearchParams(requests.at(-1)!.query).get('assignee')).toBe('u_cli');
    expect(new URLSearchParams(requests.at(-1)!.query).has('assignee_id')).toBe(false);

    const sourcePath = '.gitknot/workflows/contract.yaml';
    const commitA = await fixture.commitFiles({ [sourcePath]: JSON.stringify({ ...workflow({ check: { steps: [{ run: 'exit 0' }] } }), name: 'contract' }) });
    const workflowA = await resource<{ id: string; current_version_id: string; definition_digest: string }>(['workflow', 'create', '--repo', 'r_native', '--path', sourcePath, '--revision', commitA]);
    const commitB = await fixture.commitFiles({ [sourcePath]: JSON.stringify({ ...workflow({ check: { steps: [{ run: 'exit 1' }] } }), name: 'contract' }) });
    const workflowB = await resource<{ current_version_id: string; definition_digest: string }>(['workflow', 'edit', workflowA.id, '--repo', 'r_native', '--path', sourcePath, '--revision', commitB, '--if-match', '"1"']);
    const history = await run(['workflow', 'versions', workflowA.id, '--repo', 'r_native', '--limit', '1', '--paginate']);
    expect(history.code, history.stderr).toBe(0);
    const versions = history.stdout.trim().split('\n').flatMap(line => (JSON.parse(line) as { items: Array<Record<string, unknown>> }).items);
    expect(versions).toHaveLength(2);
    expect(versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: workflowA.current_version_id, source_commit: commitA, definition_digest: workflowA.definition_digest }),
      expect.objectContaining({ id: workflowB.current_version_id, source_commit: commitB, definition_digest: workflowB.definition_digest }),
    ]));

    await execute(db, `INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
      VALUES ('r_other','u_cli','other','other','public','active','local','core','other','u_cli',?,?)`, now(), now());
    const privateRepos = await resource<{ items: Array<{ id: string }> }>(['repo', 'list', '--owner', 'u_cli', '--visibility', 'private']);
    expect(privateRepos.items.map(item => item.id)).toEqual(['r_native']);
    const publicPages = await run(['repo', 'list', '--owner', 'u_cli', '--visibility', 'public', '--limit', '1', '--paginate']);
    expect(publicPages.code, publicPages.stderr).toBe(0);
    const pages = publicPages.stdout.trim().split('\n').map(line => JSON.parse(line) as { items: Array<{ id: string }>; next_cursor: string | null });
    expect(pages[0]).toMatchObject({ items: [], next_cursor: expect.any(String) });
    expect(pages.flatMap(page => page.items.map(item => item.id))).toEqual(['r_other']);
    expect(pages.at(-1)?.next_cursor).toBeNull();
    const wrongRepo = await run(['workflow', 'versions', workflowA.id, '--repo', 'r_other']);
    expect(wrongRepo.code).toBe(1); expect(wrongRepo.stderr).toContain('not_found');
    const poolInput = { name: 'native-pool', os: 'linux', architecture: 'amd64', toolchains: [`sha256:${'f'.repeat(64)}`], trust: 'trusted', isolation: 'ephemeral' };
    const pool = await resource<{ id: string; repo_id: string; account_id: string }>(['runner', 'pool', 'create', '--repo', 'cli-user/native'], poolInput);
    expect(pool).toMatchObject({ repo_id: 'r_native', account_id: 'u_cli' });
    const otherPool = await resource<{ id: string }>(['runner', 'pool', 'create', '--repo', 'r_other'], { ...poolInput, name: 'other-pool' });
    const capabilities = ['contents.read', 'repositories.read', 'runners.manage', 'workflows.read'];
    for (const [index, capability] of capabilities.entries()) await execute(db, `INSERT INTO access_grants(id,account_id,repo_id,principal_type,principal_id,capability,created_by,created_at,updated_at)
      VALUES (?,'u_cli','r_native','user','u_session',?,'u_cli',?,?)`, `grant_cli_${index}`, capability, now(), now());
    const scoped = await prepareCredential(db, { principal_id: 'u_session', user_id: 'u_session', kind: 'personal', name: 'Repository-only runner administration', capabilities,
      repository_ids: ['r_native'], account_ids: null, auth_revision: 1, mfa: false, expires_at: new Date(Date.now() + 86_400_000).toISOString(), created_by: 'u_session' });
    await scoped.statement.run();
    const repositoryPools = await resource<{ items: Array<{ id: string }> }>(['runner', 'pool', 'list', '--repo', 'cli-user/native'], undefined, { GITKNOT_TOKEN: scoped.token });
    expect(repositoryPools.items.map(item => item.id)).toEqual([pool.id]);
    const defaultPools = await resource<{ items: Array<{ id: string }> }>(['runner', 'pool', 'list'], undefined, { GITKNOT_TOKEN: scoped.token, GITKNOT_REPO: 'cli-user/native' });
    expect(defaultPools.items.map(item => item.id)).toEqual([pool.id]);
    expect(new URLSearchParams(requests.at(-1)!.query).get('repo_id')).toBe('r_native');
    expect(new URLSearchParams(requests.at(-1)!.query).has('account_id')).toBe(false);
    const deniedAccount = await run(['runner', 'pool', 'list', '--account', 'u_cli'], undefined, { GITKNOT_TOKEN: scoped.token, GITKNOT_REPO: 'cli-user/native' });
    expect(deniedAccount.code).toBe(1); expect(deniedAccount.stderr).toContain('permission_denied');
    const accountPools = await resource<{ items: Array<{ id: string }> }>(['runner', 'pool', 'list', '--account', 'u_cli'], undefined, { GITKNOT_REPO: 'nonexistent/repository' });
    expect(accountPools.items.map(item => item.id).sort()).toEqual([pool.id, otherPool.id].sort());
    const authorizedHistory = await resource<{ items: unknown[] }>(['workflow', 'versions', workflowA.id, '--repo', 'r_native'], undefined, { GITKNOT_TOKEN: scoped.token });
    expect(authorizedHistory.items).toHaveLength(2);

    const otherPath = '.gitknot/workflows/other-contract.yaml';
    const commitC = await fixture.commitFiles({ [otherPath]: JSON.stringify({ ...workflow({ check: { steps: [{ run: 'exit 0' }] } }), name: 'other-contract' }) });
    const otherWorkflow = await resource<{ id: string; current_version_id: string }>(['workflow', 'create', '--repo', 'r_native', '--path', otherPath, '--revision', commitC]);
    for (const record of [
      { id: 'run_cli_match', workflow_id: workflowA.id, version_id: workflowB.current_version_id, commit: commitB, status: 'succeeded' as const },
      { id: 'run_cli_other_workflow', workflow_id: otherWorkflow.id, version_id: otherWorkflow.current_version_id, commit: commitB, status: 'succeeded' as const },
      { id: 'run_cli_other_commit', workflow_id: workflowA.id, version_id: workflowA.current_version_id, commit: commitA, status: 'failed' as const },
      { id: 'run_cli_other_status', workflow_id: workflowA.id, version_id: workflowB.current_version_id, commit: commitB, status: 'failed' as const },
    ]) await retainedRun(actual, record);
    const listRuns = (flags: string[]) => resource<{ items: Array<{ id: string }> }>(['run', 'list', '--repo', 'r_native', ...flags]);
    expect((await listRuns(['--workflow', workflowA.id])).items.map(item => item.id).sort()).toEqual(['run_cli_match', 'run_cli_other_commit', 'run_cli_other_status']);
    expect((await listRuns(['--status', 'succeeded'])).items.map(item => item.id).sort()).toEqual(['run_cli_match', 'run_cli_other_workflow']);
    expect((await listRuns(['--commit', commitB])).items.map(item => item.id).sort()).toEqual(['run_cli_match', 'run_cli_other_status', 'run_cli_other_workflow']);
    expect((await listRuns(['--workflow', workflowA.id, '--status', 'succeeded', '--commit', commitB])).items.map(item => item.id)).toEqual(['run_cli_match']);
    await retainedLogs(actual, 'run_cli_match');
    const logs = await resource<{ items: Array<{ text: string; attempt_id: string }> }>(['run', 'logs', 'run_cli_match', '--job', 'job_cli_first']);
    expect(logs.items).toHaveLength(1); expect(logs.items[0]).toMatchObject({ attempt_id: 'att_cli_first', text: 'first job log\n' });

    const environment = await resource<{ id: string }>(['environment', 'create', '--repo', 'r_native'], { name: 'preview', destination: 'release:preview', target_ref: 'refs/heads/main' });
    const missingRevision = await run(['environment', 'delete', environment.id, '--repo', 'r_native']);
    expect(missingRevision.code).toBe(1); expect(missingRevision.stderr).toContain('precondition_required');
    const stale = await run(['environment', 'delete', environment.id, '--repo', 'r_native', '--if-match', '"9"']);
    expect(stale.code).toBe(1); expect(stale.stderr).toContain('revision_conflict');
    await execute(db, "UPDATE repositories SET state='archived' WHERE id='r_native'");
    const archived = await run(['environment', 'delete', environment.id, '--repo', 'r_native', '--if-match', '"1"']);
    expect(archived.code).toBe(1); expect(archived.stderr).toContain('repository_read_only');
    await execute(db, "UPDATE repositories SET state='active' WHERE id='r_native'");
    expect((await resource<{ id: string }>(['environment', 'view', environment.id, '--repo', 'r_native'])).id).toBe(environment.id);
    const deletion = ['environment', 'delete', environment.id, '--repo', 'r_native', '--if-match', '"1"', '--idempotency-key', 'cli-environment-delete', '--include'];
    expect((await resource<{ status: number }>(deletion)).status).toBe(204);
    const tombstone = await resource<{ id: string; state: string; revision: number; deleted_by: string }>(['environment', 'view', environment.id, '--repo', 'r_native']);
    expect(tombstone).toMatchObject({ id: environment.id, state: 'deleted', revision: 2, deleted_by: 'u_cli' });
    expect((await resource<{ status: number }>(deletion)).status).toBe(204);
    expect(await resource(['environment', 'view', environment.id, '--repo', 'r_native'])).toEqual(tombstone);
  }, 60_000);
});
