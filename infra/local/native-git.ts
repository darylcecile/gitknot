import { createServer } from 'node:http';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { signInternalRequest, verifyInternalRequest } from '../../packages/core/src/internal.ts';
import { startNativeServer } from '../../services/git/src/server.ts';
import { GIT_NATIVE_SCOPE } from '../../packages/git/src/types.ts';
import type { GitStorageCreationEvidence, NativeSessionSpec, PublicationPermit } from '../../packages/git/src/types.ts';
import { GitError } from '../../packages/git/src/errors.ts';
import { provisionFilesystemRepository, readFilesystemCreation } from '../../services/git/src/filesystem-store.ts';

const root = process.env.GIT_LOCAL_ROOT;
const cache = process.env.GIT_SESSION_ROOT;
const key = process.env.INTERNAL_SERVICE_KEY;
const callbackOrigin = process.env.GIT_CALLBACK_ORIGIN;
if (process.env.ENVIRONMENT !== 'development' || !root || !cache || !key || key.length < 32 || callbackOrigin !== 'http://localhost:8788') {
  throw new Error('The local Git process needs explicit development roots, a local callback origin, and a signing key.');
}
const repositoryRoot = resolve(root);
await mkdir(repositoryRoot, { recursive: true, mode: 0o700 });
const nonces = new Map<string, number>();

async function authenticate(request: Request, scope: string, origin: string): Promise<void> {
  const url = new URL(request.url);
  const copy = request.clone();
  const canonical = new Request(new URL(url.pathname + url.search, origin), {
    method: copy.method, headers: copy.headers, body: copy.body, ...(copy.body ? { duplex: 'half' } : {}),
  } as RequestInit);
  await verifyInternalRequest(canonical, key!, scope);
  const nonce = request.headers.get('x-gitknot-internal-nonce')!;
  const now = Date.now();
  for (const [value, expires] of nonces) if (expires < now) nonces.delete(value);
  if (nonces.has(nonce) || nonces.size > 10_000) throw new Error('Local native request replayed.');
  nonces.set(nonce, now + 120_000);
}

async function callback<T>(spec: NativeSessionSpec, action: string, payload: unknown): Promise<T> {
  if (!spec.callback_url || new URL(spec.callback_url).origin !== callbackOrigin) throw new Error('Invalid local Git callback.');
  const request = new Request(`${spec.callback_url}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publisher_id: spec.publisher_id, fence: spec.fence, ...payload as object }),
  });
  const response = await fetch(await signInternalRequest(request, key!, GIT_NATIVE_SCOPE), { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Local publication callback rejected (${response.status}).`); }
  return response.json() as Promise<T>;
}

const native = await startNativeServer({
  configuration: { mode: 'development', cache_root: cache, local_authority_root: repositoryRoot, max_sessions: 4, callback_origin: callbackOrigin },
  authenticate: request => authenticate(request, GIT_NATIVE_SCOPE, 'http://git-native.internal'),
  callbacks: {
    async validated(spec, evidence) { await callback(spec, 'validated', { evidence }); },
    permit: (spec, evidence) => callback<PublicationPermit>(spec, 'permit', { evidence_digest: evidence.digest }),
    async result(spec, result) { await callback(spec, 'result', { result }); },
    async rejected(spec, reason) { await callback(spec, 'rejected', { reason }); },
  },
}, 8790, '127.0.0.1');

const storage = createServer({ requestTimeout: 30_000 }, async (incoming, outgoing) => {
  try {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const part of incoming) {
      const bytes = Buffer.from(part); size += bytes.byteLength;
      if (size > 8192) throw new Error('Local storage body is too large.');
      parts.push(bytes);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(name, value);
    const request = new Request(`http://git-local.internal${incoming.url}`, { method: incoming.method, headers, ...(size ? { body: Buffer.concat(parts) } : {}) });
    await authenticate(request, 'git-local-storage', 'http://git-local.internal');
    const match = /^\/repositories\/([A-Za-z0-9_-]{1,128})$/.exec(new URL(request.url).pathname);
    if (!match) { outgoing.writeHead(404).end(); return; }
    const directory = join(repositoryRoot, `${match[1]}.git`);
    let created: true | undefined;
    let creation: GitStorageCreationEvidence | undefined | null;
    if (request.method === 'PUT') {
      const body = await request.json() as { default_branch?: unknown; create_only?: unknown; ownership_marker?: unknown };
      if (typeof body.default_branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(body.default_branch)) throw new Error('Invalid default branch.');
      if (body.create_only !== undefined && typeof body.create_only !== 'boolean') throw new Error('Invalid create-only option.');
      if (body.ownership_marker !== undefined && typeof body.ownership_marker !== 'string') throw new Error('Invalid creation marker.');
      ({ created, creation } = await provisionFilesystemRepository(directory, body.default_branch,
        { create_only: body.create_only, ownership_marker: body.ownership_marker }));
    } else if (request.method === 'DELETE') await rm(directory, { recursive: true, force: true });
    else if (request.method !== 'GET') { outgoing.writeHead(405).end(); return; }
    if (request.method !== 'DELETE') {
      try { await stat(join(directory, 'HEAD')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { outgoing.writeHead(404).end(); return; } throw error; }
      if (request.method === 'GET') creation = await readFilesystemCreation(directory);
    }
    outgoing.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ remote: pathToFileURL(directory).href,
      ...(created ? { created } : {}), ...(creation ? { creation } : {}) }));
  } catch (error) {
    if (error instanceof GitError && error.code === 'storage_namespace_exists' && (error.cause as { proof?: string } | undefined)?.proof === 'not_started') {
      outgoing.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: error.code, proof: 'not_started' } }));
      return;
    }
    console.error(JSON.stringify({ component: 'local-git-authority', code: error && typeof error === 'object' && 'code' in error ? String(error.code) : error instanceof Error ? error.name : 'request_failed' }));
    if (!outgoing.headersSent) outgoing.writeHead(400, { 'content-type': 'application/json' });
    outgoing.end(JSON.stringify({ error: { code: 'local_storage_request_failed' } }));
  }
});
await new Promise<void>((done, reject) => { storage.once('error', reject); storage.listen(8792, '127.0.0.1', done); });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await native.close();
  storage.closeAllConnections();
  await new Promise<void>((done, reject) => storage.close(error => error ? reject(error) : done()));
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void stop().catch(error => { console.error(String(error)); process.exitCode = 1; }); });
console.log('Native local Git and filesystem authority listening on 127.0.0.1:8790/8792.');
