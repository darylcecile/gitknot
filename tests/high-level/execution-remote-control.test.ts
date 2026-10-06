import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { ApiError, execute, now, one, sha256, stmt, verifyInternalRequest } from '../../packages/core/src/index.ts';
import { createRun, advanceRun } from '../../packages/execution/src/control-plane.ts';
import { AttemptMachine } from '../../packages/execution/src/attempt-machine.ts';
import type { AttemptStorage } from '../../packages/execution/src/attempt-machine.ts';
import { attemptContext } from '../../packages/execution/src/store.ts';
import { handleRemoteCallback } from '../../packages/execution/src/remote/callbacks.ts';
import { dispatchRemoteAttempt, inspectRemoteAttempt, prepareRemoteDispatch, remoteDispatch, verifyRemoteDestruction } from '../../packages/execution/src/remote/control.ts';
import { grantDigest, remoteRuntimeId, signCallbackRequest, signRemoteStatus, verifyRemoteRequest } from '../../packages/execution/src/remote/protocol.ts';
import type { RemoteAttemptGrant, RemoteRuntimeStatus } from '../../packages/execution/src/remote/protocol.ts';
import type { AttemptContext, ExecutionPlan, PlanJob } from '../../packages/execution/src/types.ts';
import { createTestEnvironment } from '../support/environment.ts';

const disposers: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of disposers.splice(0).reverse()) await close(); });

async function http(handler: (request: Request) => Promise<Response>) {
  let origin = '';
  const server = createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const body = ['GET', 'HEAD'].includes(incoming.method!) ? undefined : Readable.toWeb(incoming);
      const response = await handler(new Request(`${origin}${incoming.url}`, { method: incoming.method, headers, body, duplex: 'half' } as RequestInit));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) for await (const bytes of Readable.fromWeb(response.body as never)) outgoing.write(bytes);
      outgoing.end();
    } catch (error) {
      if (!outgoing.headersSent) outgoing.writeHead(error instanceof ApiError ? error.status : 500, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ error: { code: error instanceof ApiError ? error.code : 'isolated_http_failure' } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  disposers.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  return origin;
}

class LocalAttemptStorage implements AttemptStorage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string) { return structuredClone(this.values.get(key)) as T | undefined; }
  async put<T>(key: string, value: T) { this.values.set(key, structuredClone(value)); }
  async setAlarm() {}
  async deleteAlarm() {}
}

async function fixture() {
  const test = await createTestEnvironment({ GIT_ORIGIN: 'https://git.gitknot.com' }); disposers.push(() => test.close());
  const at = now(), commit = 'a'.repeat(40), fingerprint = `sha256:${'b'.repeat(64)}`, key = 'dedicated-remote-control-key-'.repeat(3);
  const remote = { grant: null as RemoteAttemptGrant | null, digest: '', calls: [] as string[], change: {} as Partial<RemoteRuntimeStatus> };
  // A disjoint HTTP command peer. It has no trusted D1, ACL, billing, vault or
  // provider binding, and deliberately supplies no successful VM execution.
  const executorOrigin = await http(async request => {
    await verifyRemoteRequest(request, key);
    const action = new URL(request.url).pathname.split('/').at(-1)!;
    const body = await request.json() as Record<string, unknown>;
    remote.calls.push(action);
    if (action === 'accept') { remote.grant = body as unknown as RemoteAttemptGrant; remote.digest = await grantDigest(remote.grant); }
    if (!remote.grant) return new Response('No accepted execution grant.', { status: 404 });
    const grant = remote.grant;
    const status: RemoteRuntimeStatus = { version: 1, executor_id: grant.executor_id, producer_id: grant.producer_id, deadline_at: grant.deadline_at,
      attempt_id: grant.attempt_id, generation: grant.generation, grant_digest: remote.digest, runtime_id: grant.runtime_id, sandbox_id: 'd'.repeat(64),
      state: 'accepted', accepted_at: at, started_at: null, destroyed_at: null, sealed: false, running: null,
      in_flight: 0, ephemeral_objects: 0, egress_bytes: 0, egress_requests: 0, receipt_id: null,
      challenge: action === 'accept' ? remote.digest : String(body.challenge), ...remote.change };
    return Response.json(await signRemoteStatus(status, key));
  });
  const callbackOrigin = await http(request => handleRemoteCallback(request, test.env));
  test.env.HOSTED_ALLOW_LOOPBACK_HTTP = 'true';
  test.env.HOSTED_CONTROL_KEY = key;
  test.env.HOSTED_CALLBACK_KEY_V1 = 'retained-callback-key-v1-'.repeat(3);
  test.env.HOSTED_REMOTE_EXECUTOR_JSON = JSON.stringify({ id: 'separate-account', origin: executorOrigin, callback_origin: callbackOrigin,
    producer_id: 'hosted:separate-account:linux-small', callback_key_binding: 'HOSTED_CALLBACK_KEY_V1' });
  test.env.HOSTED_TEST_HTTP = { fetch: (request: Request) => fetch(request) } as Fetcher;
  const machines = new Map<string, AttemptMachine>();
  const machine = (id: string) => { if (!machines.has(id)) machines.set(id, new AttemptMachine(test.env, new LocalAttemptStorage())); return machines.get(id)!; };
  test.env.ATTEMPTS = { idFromName: (name: string) => ({ toString: () => name }), get: (id: DurableObjectId) => ({ fetch: async (request: Request) => {
    await verifyInternalRequest(request, test.env.INTERNAL_SERVICE_KEY, 'execution');
    const action = new URL(request.url).pathname.split('/').at(-1)!, body = await request.json() as Record<string, unknown>;
    const controller = machine(id.toString());
    return controller.exclusive(async () => {
      if (action === 'begin-hosted') return Response.json(await controller.beginHosted(id.toString()));
      if (action === 'hosted-heartbeat') return Response.json(await controller.heartbeat(id.toString()));
      if (action === 'destroyed') { await controller.recordDestruction(id.toString(), body as never); return Response.json({ recorded: true }); }
      throw new Error(`Unexpected test command ${action}`);
    });
  } }) } as unknown as DurableObjectNamespace;
  await test.db.batch([
    stmt(test.env.DB, `INSERT INTO users(id,username,email,email_verified_at,created_at,updated_at) VALUES ('u_remote','remote','remote@example.net',?,?,?)`, at, at, at),
    stmt(test.env.DB, `INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES ('u_remote','user','remote','Remote','u_remote',?,?)`, at, at),
    stmt(test.env.DB, `INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES ('u_remote','user','u_remote','u_remote','Remote','u_remote',?,?)`, at, at),
    stmt(test.env.DB, `INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
      VALUES ('r_remote','u_remote','remote','remote','private','active','local','core','remote-store','u_remote',?,?)`, at, at),
    stmt(test.env.DB, `INSERT INTO workflows(id,repo_id,account_id,name,path,current_version_id,created_by,created_at,updated_at)
      VALUES ('wf_remote','r_remote','u_remote','verify','.gitknot/workflows/verify.yaml','wfv_remote','u_remote',?,?)`, at, at),
    stmt(test.env.DB, `INSERT INTO workflow_versions(id,workflow_id,repo_id,account_id,source_commit,definition_digest,definition,definition_json,policy_revision,approved_by,created_at)
      VALUES ('wfv_remote','wf_remote','r_remote','u_remote',?,?,'frozen fixture','{}',1,'u_remote',?)`, commit, 'c'.repeat(64), at),
  ]);
  const job: PlanJob = { key: '_verify', needs: [], executor: { type: 'hosted', profile: 'linux-small' }, execution_backend: 'remote', remote_executor_id: 'separate-account', producer_id: 'hosted:separate-account:linux-small',
    toolchain: { name: 'fixture', digest: fingerprint, image: `registry.example.net/image@sha256:${'e'.repeat(64)}`, os: 'linux', architecture: 'amd64' }, timeout_ms: 600_000, infrastructure_retries: 0,
    applicable: true, inapplicable_reason: null, steps: [{ id: '_step', run: 'exit 9', shell: 'sh', working_directory: '.', env: {}, secrets: [], timeout_ms: 60_000 }],
    cache: null, environment: null, inputs: [], outputs: {}, egress: { hosts: [], max_bytes: 1024, max_requests: 10, max_request_bytes: 512 } };
  const plan: ExecutionPlan = { version: 1, repo_id: 'r_remote', account_id: 'u_remote', commit_sha: commit, source_ref: 'refs/heads/main', workflow_digest: 'c'.repeat(64), workflow_version_id: 'wfv_remote',
    policy_revision: 1, trust: 'trusted', trigger: { type: 'workflow.dispatch', id: 'remote-http-fixture' }, concurrency: { key: null, supersede: false }, jobs: [job], routing_epoch: 1,
    actor: { id: 'u_remote', kind: 'user', user_id: 'u_remote', credential_id: null }, portable_manifest: { jobs: [{ id: job.key, toolchain: { ...job.toolchain, fingerprint, arch: 'x64', tools: { node: '24.18.0' } } }] } };
  const record = await createRun(test.env, test.env.DB, { workflow_id: 'wf_remote', plan, actor_id: 'u_remote', request_key: 'remote-http-fixture', request_hash: 'remote-http-fixture' });
  await advanceRun(test.env, record.id);
  const row = (await one<{ id: string }>(test.env.DB, 'SELECT id FROM execution_attempts WHERE run_id=?', record.id))!;
  const deadline = new Date(Date.now() + 600_000).toISOString(), lease = new Date(Date.now() + 90_000).toISOString();
  await execute(test.env.DB, `UPDATE execution_attempts SET status='leased',runtime_name=?,runtime_id=?,deadline_at=?,lease_expires_at=?,allocated_at=?,cleanup_state='required',credential_hash='scoped-test-lease' WHERE id=?`,
    `${row.id}-g1`, remoteRuntimeId('separate-account', row.id, 1), deadline, lease, at, row.id);
  const context = await attemptContext(test.env.DB, row.id);
  await dispatchRemoteAttempt(test.env, context);
  const grant = remote.grant!;
  const request = async (action: string, body: object = {}, token = grant.callback.token, attemptId = grant.attempt_id) => fetch(await signCallbackRequest(new Request(`${callbackOrigin}/internal/hosted/attempts/${attemptId}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ generation: grant.generation, plan_digest: grant.plan_digest, ...body }),
  }), token));
  return { ...test, remote, grant, context, request, callbackOrigin, machine };
}

describe('isolated hosted control-plane HTTP capability boundary', () => {
  it('dispatches only frozen attempt material and begins once without exposing control-plane credentials or asserting VM execution', async () => {
    const test = await fixture();
    const encoded = JSON.stringify(test.grant), stored = await remoteDispatch(test.env, test.grant.attempt_id);
    expect(encoded).not.toContain(test.env.INTERNAL_SERVICE_KEY);
    expect(encoded).not.toContain(String(test.env.HOSTED_CONTROL_KEY));
    for (const key of ['actor', 'principal', 'credentials', 'DB', 'ADMISSION', 'SECRETS', 'sql']) expect(Object.hasOwn(test.grant, key)).toBe(false);
    expect(stored.grant_json).not.toContain(test.grant.callback.token);
    test.env.HOSTED_CALLBACK_KEY_V2 = 'new-callback-key-v2-'.repeat(3);
    test.env.HOSTED_REMOTE_EXECUTOR_JSON = JSON.stringify({ ...JSON.parse(String(test.env.HOSTED_REMOTE_EXECUTOR_JSON)), callback_key_binding: 'HOSTED_CALLBACK_KEY_V2' });
    await dispatchRemoteAttempt(test.env, test.context);
    expect(test.remote.grant?.callback.token).toBe(test.grant.callback.token);
    expect((await remoteDispatch(test.env, test.grant.attempt_id)).callback_key_binding).toBe('HOSTED_CALLBACK_KEY_V1');
    const first = await test.request('begin'), begun = await first.json() as { execute: boolean; source?: { token: string } };
    expect(first.status).toBe(200); expect(begun.execute).toBe(true); expect(begun.source?.token).toMatch(/^gkt_/);
    expect(await (await test.request('begin')).json()).toMatchObject({ execute: false });
    expect(await one(test.env.DB, `SELECT COUNT(*) AS count FROM credentials WHERE name LIKE 'checkout %'`)).toEqual({ count: 1 });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM execution_runtime_receipts')).toEqual({ count: 0 });
    expect(test.remote.calls).toEqual(['accept', 'accept']);
  });

  it('rejects forged, widened and cross-attempt callbacks and keeps late results fenced', async () => {
    const test = await fixture();
    expect((await test.request('begin', {}, `ghc_${'x'.repeat(43)}`)).status).toBe(401);
    expect((await test.request('begin', { actor: { id: 'u_remote' }, sql: 'SELECT * FROM credentials' })).status).toBe(422);
    expect((await test.request('sql', { query: 'SELECT * FROM credentials' })).status).toBe(404);
    await test.request('begin');
    expect((await test.request('secrets', { step_id: '_step', names: ['UNDECLARED'] })).status).toBe(403);
    const altered = await signCallbackRequest(new Request(`${test.callbackOrigin}/internal/hosted/attempts/${test.grant.attempt_id}/heartbeat`, { method: 'POST', body: JSON.stringify({ generation: 1, plan_digest: test.grant.plan_digest, egress_bytes: 0, egress_requests: 0 }) }), test.grant.callback.token);
    expect((await fetch(new Request(altered, { body: JSON.stringify({ generation: 1, plan_digest: test.grant.plan_digest, egress_bytes: 1, egress_requests: 0 }) }))).status).toBe(401);
    const other = { ...test.context, attempt: { ...test.context.attempt, id: 'att_other_callback' } };
    // A second immutable grant has its own capability; IDs never confer access.
    await test.db.batch([
      stmt(test.env.DB, `INSERT INTO execution_attempts(id,repo_id,account_id,run_id,job_id,generation,plan_digest,toolchain_digest,producer_id,executor,status,queue_deadline_at,created_at,updated_at,execution_backend,remote_executor_id,runtime_name,runtime_id,deadline_at,lease_expires_at)
        VALUES (?,'r_remote','u_remote',?,?,2,?,?,?,'hosted','leased',?,?,?,'remote','separate-account',?,?,?,?)`, other.attempt.id, other.run.id, other.attempt.job_id,
        other.attempt.plan_digest, other.attempt.toolchain_digest, other.attempt.producer_id, other.attempt.queue_deadline_at, now(), now(), `${other.attempt.id}-g2`, remoteRuntimeId('separate-account', other.attempt.id, 2), other.attempt.deadline_at, other.attempt.lease_expires_at),
    ]);
    await execute(test.env.DB, `UPDATE workflow_jobs SET generation=2,current_attempt_id=? WHERE id=?`, other.attempt.id, other.attempt.job_id);
    await prepareRemoteDispatch(test.env, await attemptContext(test.env.DB, other.attempt.id));
    expect((await test.request('begin', { generation: 2 }, test.grant.callback.token, other.attempt.id)).status).toBe(401);
    expect((await test.request('log', { sequence: 0, data_base64: '', sha256: await sha256(''), size_bytes: 0 })).status).toBe(409);
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM execution_objects')).toEqual({ count: 0 });
  });

  it('binds snapshot identity to signed URL context and rejects unverifiable teardown despite claimed destruction', async () => {
    const test = await fixture(); await test.request('begin');
    const url = new URL(`${test.callbackOrigin}/internal/hosted/attempts/${test.grant.attempt_id}/snapshot-upload`), snapshot = crypto.randomUUID();
    for (const [key, value] of Object.entries({ generation: '1', plan_digest: test.grant.plan_digest, snapshot_id: snapshot, snapshot_part: 'archive' })) url.searchParams.set(key, value);
    const signed = await signCallbackRequest(new Request(url, { method: 'POST', body: 'x', headers: { 'content-length': '1', 'x-gitknot-content-sha256': await sha256('x'),
      'x-gitknot-generation': '1', 'x-gitknot-plan-digest': test.grant.plan_digest, 'x-gitknot-snapshot-id': snapshot, 'x-gitknot-snapshot-part': 'archive' } }), test.grant.callback.token);
    signed.headers.set('x-gitknot-snapshot-part', 'metadata');
    expect((await fetch(signed)).status).toBe(401);
    expect((await test.request('destroyed', { destroyed: true, running: false })).status).toBe(422);
    expect((await test.request('destroyed')).status).toBe(503);
    for (const remaining of [{ in_flight: 1, ephemeral_objects: 0 }, { in_flight: 0, ephemeral_objects: 1 }]) {
      test.remote.change = { state: 'destroyed', sealed: true, running: false, destroyed_at: now(), receipt_id: 'http-fixture-only', ...remaining };
      await expect(verifyRemoteDestruction(test.env, test.grant.attempt_id)).rejects.toMatchObject({ code: 'destruction_unverified' });
    }
    expect(await one(test.env.DB, 'SELECT cleanup_state FROM execution_attempts WHERE id=?', test.grant.attempt_id)).toEqual({ cleanup_state: 'required' });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM execution_runtime_receipts')).toEqual({ count: 0 });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM execution_objects')).toEqual({ count: 0 });
  });

  it('requires the original producer, deadline, concrete Sandbox and fresh caller challenge in every signed status', async () => {
    const test = await fixture();
    for (const change of [{ producer_id: 'hosted:other' }, { deadline_at: new Date(Date.now() + 3_600_000).toISOString() }, { challenge: 'recorded-old-response' }, { sandbox_id: 'e'.repeat(64) }]) {
      test.remote.change = change;
      await expect(inspectRemoteAttempt(test.env, test.grant.attempt_id)).rejects.toMatchObject({ code: Object.hasOwn(change, 'sandbox_id') ? 'remote_runtime_changed' : 'remote_status_unverified' });
    }
    test.remote.change = { destroyed_at: 'not-a-provider-time' };
    await expect(inspectRemoteAttempt(test.env, test.grant.attempt_id)).rejects.toMatchObject({ code: 'remote_status_unverified' });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM execution_runtime_receipts')).toEqual({ count: 0 });
  });
});
