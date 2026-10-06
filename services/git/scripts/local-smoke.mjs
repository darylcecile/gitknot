import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startNativeServer } from '../src/server.ts';
import { signInternalRequest, verifyInternalRequest } from '../../../packages/core/src/internal.ts';
import { DEFAULT_GIT_LIMITS, GIT_NATIVE_SCOPE, ZERO_OID } from '../../../packages/git/src/types.ts';

assert.equal(process.platform, 'linux');
assert.equal(process.versions.node.split('.')[0], '24');
const exec = promisify(execFile);
assert.match((await exec('/usr/bin/git', ['--version'])).stdout, /^git version 2\.54\.0/);
const root = await mkdtemp('/var/lib/gitknot/smoke-');
const canonical = join(root, 'authority', 'repository.git');
await mkdir(join(root, 'authority'));
await exec('/usr/bin/git', ['init', '--bare', '--initial-branch=main', canonical]);
const key = 'e070309216424e06608524e28a40b80d1563d2a2b27f882418e8ad833014dfaf';
const repository = { id: 'r_linux_smoke', owner_id: 'u_linux_smoke', storage_name: 'linux_smoke', default_branch: 'main', policy_revision: 1, routing_epoch: 1 };
const policy = { revision: 1, rules: [], signatures: { ssh_signers: [], openpgp_keys: [], openpgp_fingerprints: [] }, limits: { ...DEFAULT_GIT_LIMITS, max_work_ms: 90_000 } };
let accepted;
let validated;
const native = await startNativeServer({
  configuration: { mode: 'test', cache_root: join(root, 'cache'), local_authority_root: join(root, 'authority'), max_sessions: 2, callback_origin: 'http://127.0.0.1' },
  authenticate: request => verifyInternalRequest(request, key, GIT_NATIVE_SCOPE),
  on_error(error) { console.error(error); },
  callbacks: {
    async validated(_spec, evidence) { validated = evidence; },
    async permit(spec, evidence) { return { operation_id: spec.operation_id, publisher_id: spec.publisher_id, evidence_digest: evidence.digest,
      marker_oid: evidence.marker_oid, remote: { authority: 'local', url: canonical } }; },
    async result(_spec, result) { assert.equal(result.outcome, 'committed'); accepted = result; },
    async rejected() {},
  },
}, 0, '127.0.0.1');

async function session(spec) {
  const request = new Request(`${native.origin}/internal/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) });
  const response = await fetch(await signInternalRequest(request, key, GIT_NATIVE_SCOPE));
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

try {
  const common = { repository, policy, remote: { authority: 'local', url: canonical } };
  const ticket = await session({ ...common, mode: 'mutate', kind: 'edit', operation_id: 'gop_linux_smoke', publisher_id: 'pub_linux_smoke', fence: 'linux-smoke-operation-fence',
    actor_id: 'u_linux_smoke', callback_url: 'http://127.0.0.1/callback' });
  const response = await fetch(`${native.origin}/sessions/${ticket.id}/mutate`, { method: 'POST', headers: { authorization: `GitKnot-Session ${ticket.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'edit', ref: 'refs/heads/main', expected_oid: ZERO_OID, message: 'Linux smoke publication', author: { name: 'Smoke actor', email: 'smoke@example.test' },
      edits: [{ path: 'README.md', content_base64: Buffer.from('Trusted Linux native Git\n').toString('base64') }] }) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(accepted.outcome, 'committed');
  assert.equal((await exec('/usr/bin/git', ['--git-dir', canonical, 'show', 'refs/heads/main:README.md'])).stdout, 'Trusted Linux native Git\n');
  assert.ok(BigInt(validated.storage.reachable_bytes) > 0n);
  const reader = await session({ ...common, mode: 'read' });
  const raw = await fetch(`${native.origin}/sessions/${reader.id}/raw?path=README.md`, { headers: { authorization: `GitKnot-Session ${reader.token}` } });
  assert.equal(raw.status, 200, await raw.clone().text());
  assert.equal(await raw.text(), 'Trusted Linux native Git\n');
  process.stdout.write(JSON.stringify({ verified: true, authority: 'explicit-local-test', git: '2.54.0', node: process.versions.node, commit: accepted.refs[0].new_oid }) + '\n');
} finally { await native.close(); await rm(root, { recursive: true, force: true }); }
