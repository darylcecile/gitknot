import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { buildLocalNativeGit } from '../../../infra/native-build.ts';
import { signInternalRequest, verifyInternalRequest } from '../../../packages/core/src/internal.ts';
import { DEFAULT_GIT_LIMITS, GIT_NATIVE_SCOPE, ZERO_OID } from '../../../packages/git/src/types.ts';

const exec = promisify(execFile);
const base = process.platform === 'darwin' ? '/private/var/folders/zh/l70grz9n3ll9j9c_f1ghp7gr0000gn/T/opencode' : tmpdir();
const root = await mkdtemp(join(base, 'git-bundled-smoke-'));
const key = crypto.randomUUID() + crypto.randomUUID();
let evidence;
let accepted;
let remote;
let logs = '';
const callback = createServer(async (incoming, outgoing) => {
  try {
    const parts = [];
    for await (const part of incoming) parts.push(part);
    const request = new Request(`http://localhost:8788${incoming.url}`, { method: incoming.method,
      headers: incoming.headers, body: Buffer.concat(parts) });
    await verifyInternalRequest(request, key, GIT_NATIVE_SCOPE);
    const body = await request.json();
    let result = {};
    if (incoming.url.endsWith('/validated')) evidence = body.evidence;
    else if (incoming.url.endsWith('/permit')) {
      assert.equal(body.evidence_digest, evidence.digest);
      result = { operation_id: 'gop_bundled_smoke', publisher_id: 'pub_bundled_smoke', evidence_digest: evidence.digest, marker_oid: evidence.marker_oid, remote };
    } else if (incoming.url.endsWith('/result')) { assert.equal(body.result.outcome, 'committed'); accepted = body.result; }
    outgoing.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  } catch (error) { outgoing.writeHead(500).end(String(error)); }
});
let child;
try {
  await new Promise((resolve, reject) => { callback.once('error', reject); callback.listen(8788, '127.0.0.1', resolve); });
  const entry = await buildLocalNativeGit();
  child = spawn(process.execPath, [entry], { env: { ...process.env, ENVIRONMENT: 'development', GIT_LOCAL_ROOT: join(root, 'authority'),
    GIT_SESSION_ROOT: join(root, 'cache'), INTERNAL_SERVICE_KEY: key, GIT_CALLBACK_ORIGIN: 'http://localhost:8788' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data.toString()).slice(-16_384); });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(logs);
    try { ready = (await fetch('http://127.0.0.1:8790/ready')).ok; } catch {}
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, logs);
  const provision = await signInternalRequest(new Request('http://git-local.internal/repositories/bundled-smoke', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ default_branch: 'main' }),
  }), key, 'git-local-storage');
  const created = await fetch(new Request('http://127.0.0.1:8792/repositories/bundled-smoke', provision));
  assert.equal(created.status, 200, await created.clone().text());
  remote = { authority: 'local', url: (await created.json()).remote };
  const spec = { repository: { id: 'r_bundled_smoke', owner_id: 'u_bundled_smoke', storage_name: 'bundled-smoke', default_branch: 'main', policy_revision: 1, routing_epoch: 1 },
    remote, policy: { revision: 1, rules: [], signatures: { ssh_signers: [], openpgp_keys: [], openpgp_fingerprints: [] }, limits: DEFAULT_GIT_LIMITS },
    mode: 'mutate', kind: 'edit', operation_id: 'gop_bundled_smoke', publisher_id: 'pub_bundled_smoke', fence: 'bundled-smoke-fence', actor_id: 'u_bundled_smoke', callback_url: 'http://localhost:8788/callback' };
  const request = await signInternalRequest(new Request('http://git-native.internal/internal/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec),
  }), key, GIT_NATIVE_SCOPE);
  const prepared = await fetch(new Request('http://127.0.0.1:8790/internal/sessions', request));
  assert.equal(prepared.status, 200, `${await prepared.clone().text()}\n${logs}`);
  const ticket = await prepared.json();
  const response = await fetch(`http://127.0.0.1:8790/sessions/${ticket.id}/mutate`, { method: 'POST', headers: { authorization: `GitKnot-Session ${ticket.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'edit', ref: 'refs/heads/main', expected_oid: ZERO_OID, author: { name: 'Bundled smoke', email: 'smoke@example.test' }, message: 'Bundled hooks',
      edits: [{ path: 'README.md', content_base64: Buffer.from('Real bundled hook publication\n').toString('base64') }] }) });
  assert.equal(response.status, 200, `${await response.clone().text()}\n${logs}`);
  assert.equal(accepted.outcome, 'committed');
  const file = await exec('git', ['--git-dir', join(root, 'authority', 'bundled-smoke.git'), 'show', 'main:README.md']);
  assert.equal(file.stdout, 'Real bundled hook publication\n');
  console.log(JSON.stringify({ verified: true, bundle: entry, commit: accepted.refs[0].new_oid, authority: 'explicit-local-development' }));
} finally {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('close', resolve)); }
  callback.closeAllConnections(); await new Promise(resolve => callback.close(resolve));
  await rm(root, { recursive: true, force: true });
}
