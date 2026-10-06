import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { beforeAll, expect, it } from 'vitest';
import { command, projectRoot, temporaryDirectory } from '../../packages/runner/tests/support.ts';
import { moveFixture } from '../support/move-fixture.ts';
import { accountExport } from '../../packages/operations/src/account-export-state.ts';
import { cleanupAccountExport, runAccountExport } from '../../packages/operations/src/account-export.ts';
import { completeOperation, operationById } from '../../packages/operations/src/lifecycle.ts';
import { backgroundContext } from '../../packages/operations/src/authorization.ts';
import type { AccountExportManifest } from '../../packages/operations/src/account-export-types.ts';
import { now, one, sha256, stmt, withAccountAuthorityBarrier } from '../../packages/core/src/index.ts';

interface CliResult { code: number | null; stdout: string; stderr: string }
interface ExportView {
  id: string; account_id: string; state: string; revision: number; checksum_sha256: string | null; size_bytes: number | null;
  coverage: { complete: boolean; repository_count: number; verified_repository_count: number };
  operation: { id: string; status: string }; download_path: string | null;
}

function startCli(executable: string, args: string[], directory: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [executable, ...args], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
  const result = new Promise<CliResult>((resolve, reject) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += stdoutDecoder.write(chunk); });
    child.stderr.on('data', chunk => { stderr += stderrDecoder.write(chunk); });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout: stdout + stdoutDecoder.end(), stderr: stderr + stderrDecoder.end() }));
  });
  return { result, stop() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); } };
}

async function installedCli(directory: string): Promise<string> {
  const metadata = JSON.parse(await command('npm', ['pack', '--workspace', '@gitknot/cli', '--ignore-scripts', '--json', '--pack-destination', directory], projectRoot)) as Array<{ filename: string; files: Array<{ path: string }> }>;
  expect(metadata[0]?.files.some(file => file.path === 'dist/cli/src/account-exports.js')).toBe(true);
  const install = join(directory, 'installed'); await mkdir(install);
  await command('tar', ['-xzf', join(directory, metadata[0]!.filename), '-C', install], directory);
  const require = createRequire(join(projectRoot, 'packages', 'cli', 'package.json'));
  const dependencies = join(install, 'package', 'node_modules'); await mkdir(dependencies);
  for (const name of ['yaml', 'zod', 'fast-xml-parser']) {
    let source = dirname(require.resolve(name));
    for (;;) {
      try { if (JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).name === name) break; } catch {}
      if (dirname(source) === source) throw new Error(`Missing installed dependency ${name}.`);
      source = dirname(source);
    }
    await symlink(source, join(dependencies, name), 'dir');
  }
  const executable = join(install, 'gitknot');
  await symlink(join(install, 'package', 'dist', 'cli', 'src', 'index.js'), executable);
  return executable;
}

beforeAll(async () => { await command('npm', ['run', 'build', '--workspace', '@gitknot/cli'], projectRoot); }, 180_000);

it('runs installed account-export commands through real handlers, native archives, uncertain replies and verified cleanup', async () => {
  const test = await moveFixture(), directory = await temporaryDirectory('account-export-cli');
  const executable = await installedCli(directory), base = `/v1/accounts/${test.accountId}/exports`;
  const requests: Array<{ method: string; path: string; key: string | undefined; ifMatch: string | undefined; body: string }> = [];
  let origin = '', dropCreation = true, incompleteCoverage = false, corruptDownload = false;
  let headerFault: 'content-type' | 'etag' | undefined, observedRead: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks), headers = new Headers();
      for (let index = 0; index < request.rawHeaders.length; index += 2) headers.append(request.rawHeaders[index]!, request.rawHeaders[index + 1]!);
      const url = new URL(request.url!, origin);
      requests.push({ method: request.method!, path: url.pathname, key: request.headers['idempotency-key'] as string | undefined,
        ifMatch: request.headers['if-match'] as string | undefined, body: body.toString('utf8') });
      let result = await (test.env.API as Fetcher).fetch(new Request(url, { method: request.method, headers,
        ...(body.byteLength ? { body: Uint8Array.from(body) } : {}) }));
      if (request.method === 'POST' && url.pathname === base && result.ok && dropCreation) {
        dropCreation = false; await result.body?.cancel(); response.destroy(); return;
      }
      if (request.method === 'GET' && url.pathname.startsWith(`${base}/`) && !url.pathname.endsWith('/download') && result.ok) {
        observedRead?.(); observedRead = undefined;
        if (incompleteCoverage) {
          const value = await result.json() as ExportView;
          const changed = new Headers(result.headers); changed.delete('content-length');
          result = Response.json({ ...value, coverage: { ...value.coverage, complete: false } }, { status: result.status, headers: changed });
        }
      }
      if (url.pathname.endsWith('/download') && result.ok) {
        const changed = new Headers(result.headers);
        if (headerFault) changed.set(headerFault, headerFault === 'etag' ? `"${'0'.repeat(64)}"` : 'application/json');
        let first = true;
        const stream = corruptDownload ? result.body!.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, output) {
          if (first && chunk.byteLength) { const copy = Uint8Array.from(chunk); copy[0] = copy[0]! ^ 1; output.enqueue(copy); first = false; }
          else output.enqueue(chunk);
        } })) : result.body;
        result = new Response(stream, { status: result.status, headers: changed });
      }
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) await pipeline(Readable.fromWeb(result.body as unknown as NodeReadableStream<Uint8Array>), response);
      else response.end();
    } catch {
      if (response.headersSent) response.destroy();
      else { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { code: 'fixture_transport_failed', message: 'The native account-export fixture could not complete this request.' } })); }
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing CLI fixture address.');
  origin = `http://127.0.0.1:${address.port}`; test.env.API_ORIGIN = origin;
  const env = { ...process.env, GITKNOT_API_URL: origin, GITKNOT_ALLOW_LOOPBACK_HTTP: '1', GITKNOT_TOKEN: test.token,
    GITKNOT_CONFIG_DIR: join(directory, 'config'), GITKNOT_ACCOUNT: undefined, GITKNOT_REPO: 'unrelated/ambient-repository' };
  const args = (value: string[], seconds = '30') => [...value, '--account', test.accountId, '--json', '--timeout', seconds];
  const run = (value: string[], seconds?: string) => startCli(executable, args(value, seconds), directory, env).result;
  const successful = async <T>(value: string[]): Promise<T> => {
    const response = await run(value); expect(response.code, response.stderr).toBe(0);
    return JSON.parse(response.stdout) as T;
  };
  try {
    const head = await test.initializeGit();
    await stmt(test.env.DB, "UPDATE users SET bio='Complete account export through the installed CLI' WHERE id=?", test.actor.id).run();
    const issue = await (test.env.API as Fetcher).fetch(new Request(`${origin}/v1/repos/${test.repoId}/issues`, { method: 'POST',
      headers: { authorization: `Bearer ${test.token}`, 'content-type': 'application/json', 'idempotency-key': 'cli-export-issue' },
      body: JSON.stringify({ title: 'CLI export history', markdown: 'Real retained Markdown in the nested native repository archive.' }) }));
    expect(issue.status, await issue.clone().text()).toBe(201);

    const exported = await successful<ExportView>(['export', 'create', '--idempotency-key', 'cli-account-snapshot']);
    expect(dropCreation).toBe(false); expect(exported.state).toBe('queued'); expect(exported.coverage.complete).toBe(false);
    const creations = requests.filter(request => request.method === 'POST' && request.path === base);
    expect(creations).toHaveLength(2); expect(creations.every(request => request.key === 'cli-account-snapshot' && request.body === '{}')).toBe(true);
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM account_exports')).toEqual({ count: 1 });
    const archive = join(directory, 'account.tar');
    const early = await run(['export', 'download', exported.id, '--output', archive]);
    expect(early.code).toBe(1); expect(early.stderr).toContain('account_export_not_ready');
    expect(requests.some(request => request.path.endsWith('/download'))).toBe(false);
    const timedOut = await run(['export', 'watch', exported.id], '1');
    expect(timedOut.code).toBe(1); expect(timedOut.stderr).toContain('watch_timeout');

    let reached!: () => void; const firstPoll = new Promise<void>(resolve => { reached = resolve; }); observedRead = reached;
    const watching = startCli(executable, args(['export', 'create', '--idempotency-key', 'cli-account-snapshot', '--watch'], '90'), directory, env);
    try {
      await Promise.race([firstPoll, watching.result.then(value => { throw new Error(`Watch ended before the native export ran: ${value.stderr}`); })]);
      const operation = await operationById(test.env, exported.operation.id);
      const result = await runAccountExport(test.env, operation);
      await completeOperation(test.env, operation, result);
      const completed = await watching.result;
      expect(completed.code, completed.stderr).toBe(0);
      expect(JSON.parse(completed.stdout)).toMatchObject({ id: exported.id, state: 'completed', coverage: { complete: true, repository_count: 1, verified_repository_count: 1 } });
    } finally { watching.stop(); await watching.result; }
    expect((await successful<ExportView>(['export', 'watch', exported.id])).state).toBe('completed');
    const shown = await successful<{ status: number; headers: { etag: string }; body: ExportView }>(['export', 'show', exported.id, '--include']);
    expect(shown.status).toBe(200); expect(shown.headers.etag).toBe(`"${shown.body.revision}"`);
    expect((await successful<ExportView>(['export', 'view', exported.id])).id).toBe(exported.id);

    incompleteCoverage = true;
    const incomplete = await run(['export', 'download', exported.id, '--output', archive]);
    expect(incomplete.code).toBe(1); expect(incomplete.stderr).toContain('account_export_not_ready');
    expect(requests.some(request => request.path.endsWith('/download'))).toBe(false);
    incompleteCoverage = false;
    await writeFile(archive, 'previous verified output');
    for (const fault of ['content-type', 'etag'] as const) {
      headerFault = fault;
      const invalid = await run(['export', 'download', exported.id, '--output', archive]);
      expect(invalid.code).toBe(1); expect(invalid.stderr).toContain('input_metadata_mismatch');
      expect(await readFile(archive, 'utf8')).toBe('previous verified output');
    }
    headerFault = undefined; corruptDownload = true;
    const corrupt = await run(['export', 'download', exported.id, '--output', archive]);
    expect(corrupt.code).toBe(1); expect(corrupt.stderr).toContain('input_checksum');
    expect(await readFile(archive, 'utf8')).toBe('previous verified output');
    expect((await readdir(directory)).some(name => name.endsWith('.download'))).toBe(false);
    corruptDownload = false;
    const downloaded = await successful<{ digest: string; size_bytes: number }>(['export', 'download', exported.id, '--output', archive]);
    expect(downloaded).toMatchObject({ digest: `sha256:${shown.body.checksum_sha256}`, size_bytes: shown.body.size_bytes });
    expect(await sha256(await readFile(archive))).toBe(shown.body.checksum_sha256);
    expect((await stat(archive)).mode & 0o077).toBe(0);
    const extracted = join(directory, 'extracted'); await mkdir(extracted);
    await command('tar', ['-xf', archive, '-C', extracted], directory);
    const manifest = JSON.parse(await readFile(join(extracted, 'manifest.json'), 'utf8')) as AccountExportManifest;
    expect(manifest).toMatchObject({ format: 'gitknot.account', version: 1, export_id: exported.id, account_id: test.accountId, coverage: { complete: true, repository_count: 1 } });
    let metadata = '';
    for (const part of manifest.metadata) {
      const bytes = await readFile(join(extracted, part.path)); expect(await sha256(bytes)).toBe(part.sha256); metadata += new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    expect(metadata).toContain('Complete account export through the installed CLI'); expect(metadata).not.toContain(test.token);
    const repository = manifest.repositories[0]!, nested = join(directory, 'repository'); await mkdir(nested);
    expect(await sha256(await readFile(join(extracted, repository.path)))).toBe(repository.sha256);
    await command('tar', ['-xf', join(extracted, repository.path), '-C', nested], directory);
    expect(await test.git(test.sourceStores.get(test.storageName)!, 'bundle', 'list-heads', join(nested, 'repository.bundle'))).toContain(`${head} refs/heads/main`);
    const itemDirectory = join(nested, 'metadata', 'collaboration_items', 'snapshot-v2');
    expect((await Promise.all((await readdir(itemDirectory)).map(file => readFile(join(itemDirectory, file), 'utf8')))).join('')).toContain('Real retained Markdown');

    const deniedExport = await successful<ExportView>(['export', 'create', '--idempotency-key', 'cli-account-denied']);
    const listed = await run(['export', 'list', '--limit', '1', '--paginate']);
    expect(listed.code, listed.stderr).toBe(0);
    const pages = listed.stdout.trim().split('\n').map(line => JSON.parse(line) as { items: ExportView[]; next_cursor: string | null });
    expect(pages.flatMap(page => page.items.map(item => item.id)).sort()).toEqual([exported.id, deniedExport.id].sort());
    expect(pages.at(-1)?.next_cursor).toBeNull();
    await withAccountAuthorityBarrier(backgroundContext(test.env, test.actor), test.accountId, 'cli-export-denial', async () => {
      await stmt(test.env.DB, `INSERT INTO access_grants(id,account_id,repo_id,principal_type,principal_id,capability,effect,created_by,created_at,updated_at)
        VALUES('cli_export_deny',?,?,'user',?,'contents.read','deny',?,?,?)`, test.accountId, test.repoId, test.actor.id, test.actor.id, now(), now()).run();
    });
    await expect(runAccountExport(test.env, await operationById(test.env, deniedExport.operation.id))).rejects.toMatchObject({ code: 'account_export_incomplete' });
    const failed = await run(['export', 'watch', deniedExport.id]);
    expect(failed.code).toBe(1); expect(JSON.parse(failed.stdout)).toMatchObject({ state: 'failed', coverage: { complete: false }, download_path: null });
    const revoked = await run(['export', 'download', exported.id, '--output', join(directory, 'revoked.tar')]);
    expect(revoked.code).toBe(1); expect(revoked.stderr).toContain('not_found');

    const missingEtag = await run(['export', 'delete', exported.id]);
    expect(missingEtag.code).toBe(2); expect(missingEtag.stderr).toContain('if-match');
    const stale = await run(['export', 'delete', exported.id, '--if-match', '"1"', '--idempotency-key', 'cli-account-stale']);
    expect(stale.code).toBe(1); expect(stale.stderr).toContain('revision_conflict');
    expect((await accountExport(test.env, exported.id)).state).toBe('completed');
    const deletion = ['export', 'delete', exported.id, '--if-match', shown.headers.etag, '--idempotency-key', 'cli-account-delete'];
    let deletionPoll!: () => void; const deleting = new Promise<void>(resolve => { deletionPoll = resolve; }); observedRead = deletionPoll;
    const cleanup = startCli(executable, args([...deletion, '--watch'], '60'), directory, env);
    try {
      await Promise.race([deleting, cleanup.result.then(value => { throw new Error(`Cleanup watch ended early: ${value.stderr}`); })]);
      expect((await accountExport(test.env, exported.id)).state).toBe('deleting');
      await cleanupAccountExport(test.env, await accountExport(test.env, exported.id));
      const deleted = await cleanup.result; expect(deleted.code, deleted.stderr).toBe(0); expect(JSON.parse(deleted.stdout).state).toBe('deleted');
    } finally { cleanup.stop(); await cleanup.result; }
    expect((await successful<ExportView>(deletion)).state).toBe('deleted');
    const expired = await run(['export', 'download', exported.id, '--output', archive]);
    expect(expired.code).toBe(1); expect(expired.stderr).toContain('account_export_not_ready');
    expect(requests.filter(request => request.method === 'DELETE' && request.key === 'cli-account-delete').every(request => request.ifMatch === shown.headers.etag)).toBe(true);
    expect(listed.stdout + failed.stdout + revoked.stderr).not.toContain(test.token);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await test.close(); await rm(directory, { recursive: true, force: true });
  }
}, 180_000);
