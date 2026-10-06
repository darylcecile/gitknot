import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ApiError, base64url, canonicalJson, execute, hashPassword, makeEvent, many, now, one, prepareCredential, routeResourceRequest, sha256, stmt } from '../../packages/core/src/index.ts';
import type { AppEnv, Bindings, Principal } from '../../packages/core/src/types.ts';
import { createRun, advanceRun, acceptDispatch, dispatchFairly, handleWorkflowEvent, rerun } from '../../packages/execution/src/control-plane.ts';
import { AttemptMachine, attemptLeaseToken } from '../../packages/execution/src/attempt-machine.ts';
import type { AttemptStorage } from '../../packages/execution/src/attempt-machine.ts';
import { putObjectBytes, putObjectStream, reserveObject, sealObject, completeObjectManifest, streamManifest, byteStream } from '../../packages/execution/src/objects.ts';
import { expireExecutionObjects } from '../../packages/execution/src/recovery.ts';
import { StreamingRedactor } from '../../packages/execution/src/redaction.ts';
import { createEnrollment, registerRunner, authenticateRunner, rotateRunner } from '../../packages/execution/src/runner-service.ts';
import { runnerMatches } from '../../packages/execution/src/state.ts';
import { createPromotion, decidePromotion, promoteArtifact } from '../../packages/execution/src/environments.ts';
import type { EnvironmentRecord, PromotionRecord } from '../../packages/execution/src/environments.ts';
import { registerWorkflowsRoutes } from '../../apps/api/src/modules/workflows.ts';
import { registerRunnersRoutes } from '../../apps/api/src/modules/runners.ts';
import type { AttemptRecord, CompletionReceipt, ExecutionObject, ExecutionPlan, JobRecord, PlanJob, RunRecord, RunnerPool, RunnerRecord } from '../../packages/execution/src/types.ts';
import { createTestEnvironment } from '../support/environment.ts';
import type { TestEnvironment } from '../support/environment.ts';
import { TestQueue } from '../support/storage.ts';
import { definitionDigest, planRun, validatedDefinition } from '../../packages/execution/src/planning.ts';
import type { WorkflowRecord, WorkflowVersion } from '../../packages/execution/src/planning.ts';
import { moduleDigest } from '../../packages/workflows/src/index.ts';
import type { Repository } from '../../packages/core/src/types.ts';
import { createCredentialExchange } from '../../packages/runner/src/credential-exchange.ts';
import { repositoryExecutionContext } from '../../packages/execution/src/authorization.ts';
import { executeWorkflowOperation } from '../../packages/execution/src/operations.ts';
import { checkoutCapability } from '../../packages/execution/src/checkout.ts';
import { attemptContext } from '../../packages/execution/src/store.ts';
import { reproduceRun } from '../../packages/execution/src/reproduce.ts';
import { evaluateVerification } from '../../apps/api/src/modules/collaboration/verification-policy.ts';
import type { MergeBlocker } from '../../apps/api/src/modules/collaboration/merge.ts';
import executionWorker from '../../workers/execution/src/index.ts';
import { brokerRequest, createSecretsBroker, writeVaultEntry } from '../../packages/secrets/src/index.ts';
import type { SecretsBrokerBindings } from '../../packages/secrets/src/types.ts';

// These HTTP journeys exercise the real Worker routes. Provider allocation is
// unavailable; neither a mocked SDK execution nor a VM acceptance is produced.
vi.mock('../../workers/execution/src/sandbox.ts', () => ({ Sandbox: class {}, SANDBOX: class {} }));
vi.mock('@cloudflare/sandbox', () => ({ ContainerProxy: class {} }));

const opened: TestEnvironment[] = [];
afterEach(() => { for (const fixture of opened.splice(0)) fixture.close(); });
const oid = 'a'.repeat(40), toolchain = `sha256:${'b'.repeat(64)}`;

class MemoryAttemptStorage implements AttemptStorage {
  data = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string) { return structuredClone(this.data.get(key)) as T | undefined; }
  async put<T>(key: string, value: T) { this.data.set(key, structuredClone(value)); }
  async setAlarm(value: number) { this.alarm = value; }
  async deleteAlarm() { this.alarm = null; }
}

function job(key: string, needs: string[] = []): PlanJob {
  return { key, needs, executor: { type: 'hosted', profile: 'linux-small' }, toolchain: { name: 'node-fixture', digest: toolchain, image: `example.invalid/image@sha256:${'f'.repeat(64)}`, os: 'linux', architecture: 'amd64' },
    producer_id: 'hosted:linux-small', timeout_ms: 600_000, infrastructure_retries: 1, applicable: true, inapplicable_reason: null,
    steps: [{ id: 'verify', run: 'exit 0', shell: 'sh', working_directory: '.', env: {}, secrets: [], timeout_ms: 60_000 }],
    outputs: {}, inputs: [], cache: null, environment: null, egress: { hosts: [], max_bytes: 1024, max_requests: 5, max_request_bytes: 512 } };
}

function plan(jobs: PlanJob[], suffix = 'owner'): ExecutionPlan {
  return { version: 1, repo_id: `r_${suffix}`, account_id: `u_${suffix}`, commit_sha: oid, source_ref: 'refs/heads/main', workflow_digest: 'c'.repeat(64),
    workflow_version_id: `wfv_${suffix}`, policy_revision: 1, trust: 'trusted', trigger: { type: 'workflow.dispatch', id: 'manual' }, concurrency: { key: null, supersede: false },
    jobs, portable_manifest: { version: 1, digest: `sha256:${'d'.repeat(64)}`, jobs: jobs.map(value => ({ id: value.key, steps: [{ id: 'verify' }] })) },
    actor: { id: `u_${suffix}`, kind: 'user', user_id: `u_${suffix}`, credential_id: null }, routing_epoch: 1 };
}

async function seed(fixture: TestEnvironment, suffix: string) {
  const db = fixture.env.DB, at = now();
  await fixture.db.batch([
    stmt(db, 'INSERT INTO users (id,username,email,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?)', `u_${suffix}`, suffix, `${suffix}@example.net`, at, at, at),
    stmt(db, `INSERT INTO accounts (id,type,slug,name,owner_user_id,created_at,updated_at) VALUES (?,'user',?,?,?,?,?)`, `u_${suffix}`, suffix, suffix, `u_${suffix}`, at, at),
    stmt(db, `INSERT INTO principals (id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES (?,'user',?,?,?,?,?,?)`, `u_${suffix}`, `u_${suffix}`, `u_${suffix}`, suffix, `u_${suffix}`, at, at),
    stmt(db, `INSERT INTO repositories (id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at) VALUES (?,?,?,?,'private','active','local','core',?,?,?,?)`,
      `r_${suffix}`, `u_${suffix}`, suffix, suffix, `storage_${suffix}`, `u_${suffix}`, at, at),
    stmt(db, 'INSERT INTO workflows (id,repo_id,account_id,name,path,current_version_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', `wf_${suffix}`, `r_${suffix}`, `u_${suffix}`, 'verify', '.gitknot/workflows/verify.yaml', `wfv_${suffix}`, `u_${suffix}`, at, at),
    stmt(db, `INSERT INTO workflow_versions (id,workflow_id,repo_id,account_id,source_commit,definition_digest,definition,definition_json,policy_revision,approved_by,created_at) VALUES (?,?,?,?,?,?,?,'{}',1,?,?)`,
      `wfv_${suffix}`, `wf_${suffix}`, `r_${suffix}`, `u_${suffix}`, oid, 'c'.repeat(64), 'trusted test definition', `u_${suffix}`, at),
  ]);
}

async function fixture() {
  const test = await createTestEnvironment(); opened.push(test);
  await seed(test, 'owner'); await seed(test, 'other');
  const stores = new Map<string, MemoryAttemptStorage>(), machines = new Map<string, AttemptMachine>();
  const queue = new TestQueue<{ attempt_id: string; run_id?: string; generation?: number }>();
  test.env.DISPATCH = queue.binding();
  let executorCalls = 0, deleteFails = false;
  const storageReservations = new Map<string, { key: string; bucket: string }>();
  const settlements: Record<string, unknown>[] = [];
  test.env.EXECUTOR = { fetch: async () => { executorCalls++; throw new Error('A provider executor was not selected in this local scenario.'); } } as unknown as Fetcher;
  const machine = (id: string) => {
    if (!stores.has(id)) stores.set(id, new MemoryAttemptStorage());
    if (!machines.has(id)) machines.set(id, new AttemptMachine(test.env, stores.get(id)!));
    return machines.get(id)!;
  };
  // Explicit test transport: production SQL, checksum checks, and controller state
  // run unchanged. No hosted VM or provider teardown is claimed by these fixtures.
  test.env.ATTEMPTS = {
    idFromName: (id: string) => ({ toString: () => id }),
    get: (id: { toString(): string }) => ({ fetch: async (request: Request) => {
      const action = new URL(request.url).pathname.split('/').at(-1), body = await request.json() as Record<string, unknown>;
      try {
        return await machine(id.toString()).exclusive(async () => {
          if (action === 'accept') return Response.json(await machine(id.toString()).accept(body as { attempt_id: string }));
          if (action === 'reserve-object') return Response.json(await reserveObject(test.env, body as never));
          if (action === 'seal-object') return Response.json(await sealObject(test.env, body.identity as never, body.object_id as string, body.machine_authority as never));
          if (action === 'cancel') { await machine(id.toString()).cancel(id.toString(), String(body.reason)); return Response.json({ cancelled: true }); }
          if (action === 'authorize') return Response.json(await machine(id.toString()).authenticate(id.toString(), body as never));
          if (action === 'authorize-closed') return Response.json(await machine(id.toString()).authenticate(id.toString(), body as never, true));
          if (action === 'authorize-cleanup') return Response.json(await machine(id.toString()).authenticateCleanup(id.toString(), body as never));
          if (action === 'customer-terminated') { await machine(id.toString()).confirmCustomerTermination(id.toString(), body.auth as never, String(body.receipt_digest)); return Response.json({ recorded: true }); }
          if (action === 'heartbeat') return Response.json(await machine(id.toString()).heartbeat(id.toString(), body as never));
          if (action === 'complete') return Response.json(await machine(id.toString()).complete(id.toString(), body.receipt as CompletionReceipt, body.auth as never));
          throw new Error(`Unexpected test controller action ${action}`);
        });
      } catch (error) { return Response.json({ error: { code: error instanceof ApiError ? error.code : 'fixture_failure', message: error instanceof Error ? error.message : 'Test failure' } }, { status: error instanceof ApiError ? error.status : 503 }); }
    } }),
  } as unknown as DurableObjectNamespace;
  test.env.ADMISSION = {
    idFromName: (id: string) => ({ toString: () => id }),
    get: () => ({ fetch: async (request: Request) => {
      const body = await request.json() as Record<string, unknown>, action = new URL(request.url).pathname.split('/').at(-1);
      if (action === 'storage-reserve') storageReservations.set(String(body.object_id), { key: String(body.key), bucket: String(body.bucket) });
      else if (action === 'storage-commit') {
        if (!/^[a-f0-9]{64}$/.test(String(body.checksum))) throw new Error('The billing storage contract requires an unprefixed SHA-256 checksum.');
        const reservation = storageReservations.get(String(body.object_id));
        if (!reservation || !(await test.blobs.head(reservation.key))) throw new Error('Storage commit preceded an actual upload.');
      } else if (action === 'storage-delete') {
        if (deleteFails) return Response.json({ error: { code: 'storage_unavailable', message: 'Injected deletion failure.' } }, { status: 503 });
        const reservation = storageReservations.get(String(body.object_id));
        if (!reservation) throw new Error('Unreserved storage deletion.');
        await test.blobs.delete(reservation.key);
      } else if (action === 'settle') {
        settlements.push(body);
        return Response.json({ id: body.reservation_id, fence: body.fence, state: 'settled', ticket: 1, deadline_at: null, actual_units: '0',
          quote: { attribution: { account_id: body.account_id }, maximum_charge_units: '100', maximum_platform_units: '100' } });
      } else throw new Error(`Unexpected billing action ${action}`);
      return Response.json({ state: action === 'storage-delete' ? 'deleted' : 'stored' });
    } }),
  } as unknown as DurableObjectNamespace;
  return { ...test, queue, stores, machine, machines, settlements, executorCalls: () => executorCalls, failDeletion: (value: boolean) => { deleteFails = value; } };
}

async function run(test: Awaited<ReturnType<typeof fixture>>, jobs: PlanJob[], key = 'one', suffix = 'owner') {
  return createRun(test.env, test.env.DB, { workflow_id: `wf_${suffix}`, plan: plan(jobs, suffix), actor_id: `u_${suffix}`, request_key: key, request_hash: key });
}

async function liveAttempt(test: Awaited<ReturnType<typeof fixture>>, record: RunRecord, jobKey?: string, runner?: RunnerRecord): Promise<AttemptRecord> {
  await advanceRun(test.env, record.id);
  const attempt = (await one<AttemptRecord>(test.env.DB, `SELECT a.* FROM execution_attempts a JOIN workflow_jobs j ON j.id=a.job_id WHERE a.run_id=? AND (? IS NULL OR j.job_key=?)`, record.id, jobKey ?? null, jobKey ?? null))!;
  await test.machine(attempt.id).accept({ attempt_id: attempt.id });
  const at = now(), deadline = new Date(Date.now() + 600_000).toISOString(), lease = new Date(Date.now() + 90_000).toISOString();
  const assigned = { ...attempt, runner_id: runner?.id ?? null, runner_credential_generation: runner?.credential_generation ?? null };
  const leaseHash = runner ? await sha256(await attemptLeaseToken(test.env, assigned)) : null;
  await execute(test.env.DB, `UPDATE execution_attempts SET status='running',reservation_id='bres_fixture',reservation_fence='bf_fixture',credential_hash=?,cleanup_lease_hash=?,
    runner_id=?,runner_credential_generation=?,runner_credential_hash=?,runtime_id=?,runtime_name=?,allocated_at=?,started_at=?,lease_expires_at=?,deadline_at=?,cleanup_state='required' WHERE id=?`,
  leaseHash ?? 'test-hash', leaseHash, assigned.runner_id, assigned.runner_credential_generation, runner?.credential_hash ?? null, `runtime-${attempt.id}`, attempt.id, at, at, lease, deadline, attempt.id);
  return (await one<AttemptRecord>(test.env.DB, 'SELECT * FROM execution_attempts WHERE id=?', attempt.id))!;
}

async function recordDestruction(test: Awaited<ReturnType<typeof fixture>>, attempt: AttemptRecord) {
  const receipt = { runtime_id: attempt.runtime_id!, attempt_id: attempt.id, generation: attempt.generation, receipt_id: `proof-${attempt.id}`, destroyed_at: now(), running: false as const, sealed: true as const };
  await expect(test.machine(attempt.id).recordDestruction(attempt.id, receipt)).rejects.toMatchObject({ code: 'destruction_unverified' });
  await execute(test.env.DB, `INSERT INTO execution_runtime_receipts (runtime_id,attempt_id,repo_id,account_id,generation,receipt_id,state,armed_at,destroyed_at,updated_at) VALUES (?,?,?,?,?,?,'destroyed',?,?,?)`,
    attempt.runtime_id, attempt.id, attempt.repo_id, attempt.account_id, attempt.generation, receipt.receipt_id, attempt.allocated_at, receipt.destroyed_at, receipt.destroyed_at);
  await test.machine(attempt.id).recordDestruction(attempt.id, receipt);
}

const owner: Principal = { id: 'u_owner', kind: 'user', user_id: 'u_owner', credential_id: null, capabilities: null, repository_ids: null, account_ids: null, mfa: false };

function api(test: Awaited<ReturnType<typeof fixture>>, principal: Principal | null = owner) {
  const app = new Hono<AppEnv>();
  app.onError(error => Response.json({ error: { code: error instanceof ApiError ? error.code : 'unexpected' } }, { status: error instanceof ApiError ? error.status : 500 }));
  app.use('*', async (c, next) => {
    c.set('principal', principal); c.set('requestId', 'req_execution');
    const forwarded = await routeResourceRequest(c);
    if (forwarded) return forwarded;
    await next();
  });
  registerWorkflowsRoutes(app); registerRunnersRoutes(app);
  return app;
}

async function configuredWorkflow(test: Awaited<ReturnType<typeof fixture>>, triggers = ['workflow.dispatch']) {
  const source = JSON.stringify({ version: 1, name: 'verify', triggers, source: 'event.commit', access: { repository: 'read' },
    defaults: { executor: { type: 'hosted', profile: 'linux-small' }, toolchain: 'fixture', timeout: '10m' }, jobs: { test: { steps: [{ id: '_verify', run: 'exit 9' }] } } });
  const definition = validatedDefinition(source), digest = await definitionDigest(definition), at = now();
  await test.db.batch([
    stmt(test.env.DB, `INSERT INTO workflow_versions(id,workflow_id,repo_id,account_id,source_commit,definition_digest,definition,definition_json,policy_revision,approved_by,created_at)
      VALUES ('wfv_compiled','wf_owner','r_owner','u_owner',?,?,?,?,1,'u_owner',?)`, oid, digest, source, JSON.stringify(definition), at),
    stmt(test.env.DB, `UPDATE workflows SET current_version_id='wfv_compiled' WHERE id='wf_owner'`),
    stmt(test.env.DB, `INSERT INTO workflow_execution_policy(repo_id,account_id,policy_json,toolchains_json,modules_json,egress_json,updated_by,updated_at) VALUES ('r_owner','u_owner',?,?,'{}',?,'u_owner',?)`,
      JSON.stringify({ access: { repository: 'read', capabilities: [], secrets: [] }, hosted_profiles: ['linux-small'], self_hosted_pools: {}, inapplicable_jobs: [] }),
      JSON.stringify({ fixture: { os: 'linux', arch: 'x64', tools: { node: '24.18.0' } } }), JSON.stringify({ hosts: [], max_bytes: 1024, max_requests: 5, max_request_bytes: 512 }), at),
  ]);
  test.env.GIT_SERVICE = { fetch: async () => Response.json({ repo_id: 'r_owner', commit_oid: oid }), connect() { throw new Error('This fixture exposes HTTP only.'); } };
  return { repository: (await one<Repository>(test.env.DB, `SELECT * FROM repositories WHERE id='r_owner'`))!,
    workflow: (await one<WorkflowRecord>(test.env.DB, `SELECT * FROM workflows WHERE id='wf_owner'`))!,
    version: (await one<WorkflowVersion>(test.env.DB, `SELECT * FROM workflow_versions WHERE id='wfv_compiled'`))! };
}

describe('durable execution control plane', () => {
  it('conceals every private-source execution representation from a public target reader', async () => {
    const test = await fixture(), build = job('build');
    await execute(test.env.DB, `UPDATE repositories SET visibility='public' WHERE id='r_owner'`);
    await execute(test.env.DB, `INSERT INTO access_grants(id,account_id,repo_id,principal_type,principal_id,capability,created_by,created_at,updated_at)
      VALUES ('grant_execution_source','u_other','r_other','user','u_owner','contents.read','u_other',?,?)`, now(), now());
    build.outputs = { bundle: { path: 'dist', retention_seconds: 3600, max_bytes: 1024, kind: 'artifact' } };
    const record = await createRun(test.env, test.env.DB, { workflow_id: 'wf_owner', actor_id: owner.id, request_key: 'private-source', request_hash: 'private-source',
      plan: { ...plan([build]), source_repo_id: 'r_other', related_repo_ids: ['r_owner', 'r_other'], trust: 'untrusted' } });
    const attempt = await liveAttempt(test, record), identity = { attempt_id: attempt.id, generation: attempt.generation, plan_digest: attempt.plan_digest, runner_id: attempt.producer_id };
    const log = await putObjectBytes(test.env, { ...identity, kind: 'log', name: 'combined', sequence: 0, final: true, content_type: 'text/plain', retention_seconds: 3600 }, new TextEncoder().encode('private fork log'));
    const chunk = await putObjectBytes(test.env, { ...identity, kind: 'output', name: 'bundle', sequence: 0, final: true, content_type: 'application/octet-stream', retention_seconds: 3600 }, new TextEncoder().encode('private fork artifact'));
    const output = await completeObjectManifest(test.env, identity, 'bundle', 'output'), logs = await completeObjectManifest(test.env, identity, 'logs', 'logs');
    await recordDestruction(test, attempt);
    await test.machine(attempt.id).complete(attempt.id, { ...identity, conclusion: 'succeeded', exit_code: 0, signal: null, resource_exhaustion: null,
      toolchain_digest: attempt.toolchain_digest, outputs: [{ name: 'bundle', sha256: output.source_digest!, size_bytes: new TextEncoder().encode('private fork artifact').length }], log_manifest_digest: logs.sha256,
      process_group_stopped: true, started_at: attempt.started_at!, finished_at: now() });
    const outsider = api(test, null), paths = ['', '/jobs', '/attempts', '/logs', '/outputs', '/manifest', `/outputs/${output.id}`, `/reproduction-inputs/${output.id}`, '/reproduce', '/approvals', '/promotions/promotion_hidden'];
    for (const suffix of paths) {
      const response = await outsider.fetch(new Request(`https://api.gitknot.com/v1/runs/${record.id}${suffix}`, { headers: { 'if-none-match': `"${record.plan_digest}"` } }), test.env, test.context);
      expect.soft(response.status, suffix || 'run detail').toBe(404);
      expect.soft(response.headers.get('etag'), suffix || 'run detail').toBeNull();
      await response.body?.cancel();
    }
    const listed = await outsider.fetch(new Request('https://api.gitknot.com/v1/repos/r_owner/runs'), test.env, test.context);
    expect.soft(await listed.json()).toMatchObject({ items: [], next_cursor: null });
    const allowed = api(test), url = `https://api.gitknot.com/v1/runs/${record.id}/outputs/${output.id}`;
    const complete = await allowed.fetch(new Request(url), test.env, test.context);
    expect(complete.status).toBe(200); expect(await complete.text()).toBe('private fork artifact');
    expect(complete.headers.get('cache-control')).toBe('private, no-store');
    const original = test.blobs.get.bind(test.blobs);
    const streaming = vi.spyOn(test.blobs, 'get').mockImplementation(async (key, options) => {
      const object = await original(key, options);
      if (!object || key !== chunk.object_key || !('body' in object)) return object;
      const parts = [new TextEncoder().encode('private '), new TextEncoder().encode('fork artifact')];
      return Object.assign(object, { body: new ReadableStream<Uint8Array>({ pull(controller) {
        const part = parts.shift(); if (part) controller.enqueue(part); else controller.close();
      } }, { highWaterMark: 0 }) });
    });
    const response = await allowed.fetch(new Request(url), test.env, test.context), reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('private ');
    await execute(test.env.DB, `UPDATE access_grants SET revoked_at=?,revision=revision+1 WHERE id='grant_execution_source'`, now());
    await expect(reader.read()).rejects.toMatchObject({ status: 404, code: 'not_found' });
    streaming.mockRestore();
    const cached = await allowed.fetch(new Request(url, { headers: { 'if-none-match': complete.headers.get('etag')! } }), test.env, test.context);
    expect(cached.status).toBe(404); expect(cached.headers.get('etag')).toBeNull();
    await execute(test.env.DB, `UPDATE access_grants SET revoked_at=NULL,revision=revision+1 WHERE id='grant_execution_source'`);
    const delayed = vi.spyOn(test.blobs, 'get').mockImplementation(async (key, options) => {
      const object = await original(key, options);
      if (key === log.object_key) await execute(test.env.DB, `UPDATE access_grants SET revoked_at=?,revision=revision+1 WHERE id='grant_execution_source'`, now());
      return object;
    });
    const withheld = await allowed.fetch(new Request(`https://api.gitknot.com/v1/runs/${record.id}/logs`), test.env, test.context);
    expect(withheld.status).toBe(404); expect(await withheld.text()).not.toContain('private fork log');
    delayed.mockRestore();
    expect(test.executorCalls()).toBe(0);
  });

  it('normalizes the actual patch_updated producer event into one pinned verification run', async () => {
    const test = await fixture(); await configuredWorkflow(test, ['pull_request.updated']);
    const at = now(), base = 'e'.repeat(40);
    await test.db.batch([
      stmt(test.env.DB, `INSERT INTO collaboration_items(id,repo_id,kind,number,title,markdown,author_id,state,created_at,updated_at)
        VALUES ('pr_execution','r_owner','pull_request',1,'Patch event','','u_owner','open',?,?)`, at, at),
      stmt(test.env.DB, `INSERT INTO pull_requests(id,repo_id,head_repo_id,base_ref,head_ref,base_oid,head_oid,current_patch_id)
        VALUES ('pr_execution','r_owner','r_owner','refs/heads/main','refs/heads/feature',?,?,'patch_execution')`, base, oid),
      stmt(test.env.DB, `INSERT INTO pull_patches(id,repo_id,pull_id,version,head_repo_id,base_oid,head_oid,merge_base_oid,patch_fingerprint,native_evidence_id,created_by,created_at)
        VALUES ('patch_execution','r_owner','pr_execution',1,'r_owner',?,?,?,'patch-fingerprint','native-retained-evidence','u_owner',?)`, base, oid, base, at),
      stmt(test.env.DB, `INSERT INTO pull_patch_files(repo_id,pull_id,patch_id,path,old_path,change_kind,old_oid,new_oid,patch_fingerprint,old_lines,new_lines,binary,hunks_json)
        VALUES ('r_owner','pr_execution','patch_execution','src/new.ts','src/old.ts','renamed',?,?,'file-fingerprint',1,1,0,'[]')`, base, oid),
    ]);
    const event = makeEvent({ type: 'pull_request.patch_updated', resource_id: 'pr_execution', resource_revision: 2, repo_id: 'r_owner', account_id: owner.id,
      actor_id: owner.id, data: { patch_id: 'patch_execution', previous_patch_id: 'patch_prior', head_oid: oid, base_oid: base } });
    await handleWorkflowEvent(test.env, event); await handleWorkflowEvent(test.env, event);
    const rows = await many<RunRecord>(test.env.DB, `SELECT * FROM workflow_runs WHERE trigger_id=?`, event.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.plan_json)).toMatchObject({ commit_sha: oid, trigger: { type: 'pull_request.updated', id: event.id, pull_request_id: 'pr_execution' },
      source_evidence: { pull_patch_id: 'patch_execution', head_oid: oid, target_oid: base, native_evidence_id: 'native-retained-evidence', patch_fingerprint: 'patch-fingerprint' },
      portable_manifest: { trust: { producer_id: 'gitknot-control-plane' }, event: { changed_paths: ['src/new.ts', 'src/old.ts'] } } });
    const nextOid = 'f'.repeat(40);
    await test.db.batch([
      stmt(test.env.DB, `INSERT INTO pull_patches(id,repo_id,pull_id,version,head_repo_id,base_oid,head_oid,merge_base_oid,patch_fingerprint,native_evidence_id,created_by,created_at)
        VALUES ('patch_execution_next','r_owner','pr_execution',2,'r_owner',?,?,?,'next-fingerprint','next-native-evidence','u_owner',?)`, base, nextOid, base, now()),
      stmt(test.env.DB, `UPDATE pull_requests SET current_patch_id='patch_execution_next',head_oid=? WHERE id='pr_execution'`, nextOid),
    ]);
    await handleWorkflowEvent(test.env, event);
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM workflow_runs WHERE trigger_id=?', event.id)).toEqual({ count: 1 });
    const forged = makeEvent({ ...event, id: 'evt_wrong_patch', data: { patch_id: 'patch_execution_next', head_oid: oid, base_oid: base } });
    await handleWorkflowEvent(test.env, forged);
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM workflow_runs WHERE trigger_id=?', forged.id)).toEqual({ count: 0 });
    const updated = makeEvent({ ...event, id: 'evt_current_patch', data: { patch_id: 'patch_execution_next', head_oid: nextOid, base_oid: base } });
    await handleWorkflowEvent(test.env, updated); await handleWorkflowEvent(test.env, updated);
    expect(await one(test.env.DB, 'SELECT commit_sha FROM workflow_runs WHERE trigger_id=?', updated.id)).toEqual({ commit_sha: nextOid });
    await execute(test.env.DB, `UPDATE workflow_runs SET status='failed',revision=revision+1 WHERE id=?`, rows[0]!.id);
    const frozen = (await one<RunRecord>(test.env.DB, 'SELECT * FROM workflow_runs WHERE id=?', rows[0]!.id))!;
    const replay = await rerun(test.env, test.env.DB, frozen, [], owner.id, 'old-patch-rerun', 'old-patch-rerun');
    expect(replay.commit_sha).toBe(oid);
    expect(JSON.parse(replay.plan_json).source_evidence.pull_patch_id).toBe('patch_execution');
    expect(test.executorCalls()).toBe(0);
  });

  it('lets a repository-scoped runner administrator list the same pools they can create and read', async () => {
    const test = await fixture(), limited: Principal = { ...owner, capabilities: ['runners.manage'], repository_ids: ['r_owner'] }, app = api(test, limited);
    const created = await app.fetch(new Request('https://api.gitknot.com/v1/runner-pools', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: owner.id, repo_id: 'r_owner', name: 'repository-admin', os: 'linux', architecture: 'amd64', toolchains: [toolchain], trust: 'trusted', isolation: 'persistent' }) }), test.env, test.context);
    const pool = await created.json() as { id: string };
    expect(created.status, JSON.stringify(pool)).toBe(201);
    expect((await app.fetch(new Request(`https://api.gitknot.com/v1/runner-pools/${pool.id}`), test.env, test.context)).status).toBe(200);
    const listed = await app.fetch(new Request(`https://api.gitknot.com/v1/runner-pools?account_id=${owner.id}&repo_id=r_owner`), test.env, test.context);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ items: [{ id: pool.id, repo_id: 'r_owner' }] });
    const scoped = await app.fetch(new Request('https://api.gitknot.com/v1/runner-pools?repo_id=r_owner'), test.env, test.context);
    expect(scoped.status).toBe(200); expect(await scoped.json()).toMatchObject({ items: [{ id: pool.id }] });
    expect((await app.fetch(new Request('https://api.gitknot.com/v1/runner-pools?account_id=u_owner'), test.env, test.context)).status).toBe(403);
    expect((await app.fetch(new Request('https://api.gitknot.com/v1/runner-pools?repo_id=r_owner&account_id=u_other'), test.env, test.context)).status).toBe(404);
    expect((await app.fetch(new Request('https://api.gitknot.com/v1/runner-pools?repo_id=r_other'), test.env, test.context)).status).toBe(404);
  });

  it('serves advertised workflow versions and durably tombstones a deleted environment', async () => {
    const test = await fixture(), app = api(test);
    const versions = await app.fetch(new Request('https://api.gitknot.com/v1/repos/r_owner/workflows/wf_owner/versions'), test.env, test.context);
    expect.soft(versions.status).toBe(200);
    if (versions.ok) expect(await versions.json()).toMatchObject({ items: [{ id: 'wfv_owner', workflow_id: 'wf_owner' }] });
    const created = await app.fetch(new Request('https://api.gitknot.com/v1/repos/r_owner/environments', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'retired', destination: 'release:retired', target_ref: 'refs/heads/main' }) }), test.env, test.context);
    const environment = await created.json() as { id: string; revision: number };
    expect(created.status).toBe(201);
    const target = `https://api.gitknot.com/v1/repos/r_owner/environments/${environment.id}`;
    const deletion = () => new Request(target, { method: 'DELETE', headers: { 'if-match': `"${environment.revision}"`, 'idempotency-key': 'environment-delete' } });
    const original = test.db.batch.bind(test.db);
    let lost = false;
    test.db.batch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      const result = await original<T>(statements);
      if (!lost && statements.some(statement => /UPDATE workflow_environments SET state='deleted'/.test((statement as unknown as { sql: string }).sql))) {
        lost = true; throw new Error('Lost environment retirement acknowledgment after commit.');
      }
      return result;
    };
    expect((await app.fetch(deletion(), test.env, test.context)).status).toBe(500);
    test.db.batch = original;
    const manager = api(test, { ...owner, capabilities: ['environments.manage'], repository_ids: ['r_owner'] });
    const removed = await manager.fetch(deletion(), test.env, test.context);
    expect(removed.status).toBe(204);
    const tombstone = await app.fetch(new Request(`https://api.gitknot.com/v1/repos/r_owner/environments/${environment.id}`), test.env, test.context);
    expect(await tombstone.json()).toMatchObject({ id: environment.id, state: 'deleted', revision: environment.revision + 1, deleted_at: expect.any(String) });
    expect(await one(test.env.DB, `SELECT COUNT(*) AS count FROM outbox WHERE type='workflow.environment.deleted' AND resource_id=?`, environment.id)).toEqual({ count: 1 });
    expect(await one(test.env.DB, `SELECT COUNT(*) AS count FROM account_policy_barriers`)).toEqual({ count: 0 });
    expect((await app.fetch(new Request(target, { method: 'PUT', headers: { 'content-type': 'application/json', 'if-match': `"${environment.revision + 1}"` },
      body: JSON.stringify({ name: 'retired', destination: 'release:retired', target_ref: 'refs/heads/main' }) }), test.env, test.context)).status).toBe(410);
    expect(await (await app.fetch(new Request('https://api.gitknot.com/v1/repos/r_owner/environments'), test.env, test.context)).json()).toMatchObject({ items: [] });
    expect(await (await app.fetch(new Request('https://api.gitknot.com/v1/repos/r_owner/environments?state=deleted'), test.env, test.context)).json()).toMatchObject({ items: [{ id: environment.id, state: 'deleted' }] });
  });

  it('applies run filters before audience-safe paging and intersects job and attempt log filters', async () => {
    const test = await fixture(); await configuredWorkflow(test);
    await execute(test.env.DB, `UPDATE repositories SET visibility='public' WHERE id='r_owner'`);
    const first = await run(test, [job('alpha'), job('beta')], 'filter-first'), second = await run(test, [job('alpha')], 'filter-second');
    const failed = await run(test, [job('alpha')], 'filter-failed');
    await execute(test.env.DB, `UPDATE workflow_runs SET status='failed',revision=revision+1 WHERE id=?`, failed.id);
    const otherCommit = await createRun(test.env, test.env.DB, { workflow_id: 'wf_owner', actor_id: owner.id, request_key: 'other-commit', request_hash: 'other-commit',
      plan: { ...plan([job('alpha')]), commit_sha: 'f'.repeat(40) } });
    const app = api(test), get = async (path: string) => app.fetch(new Request(`https://api.gitknot.com${path}`), test.env, test.context);
    const path = `/v1/repos/r_owner/runs?workflow_id=wf_owner&status=queued&commit=${oid}&limit=1`;
    const pageOne = await (await get(path)).json() as { items: RunRecord[]; next_cursor: string };
    const pageTwo = await (await get(`${path}&cursor=${pageOne.next_cursor}`)).json() as { items: RunRecord[]; next_cursor: null };
    expect(new Set([...pageOne.items, ...pageTwo.items].map(value => value.id))).toEqual(new Set([first.id, second.id]));
    expect(pageOne.next_cursor).toMatch(/^ex1\./); expect(pageTwo.next_cursor).toBeNull();
    expect((await get(`/v1/repos/r_owner/runs?status=failed&cursor=${pageOne.next_cursor}`)).status).toBe(422);
    expect(await (await get('/v1/repos/r_owner/runs?workflow_id=wf_other')).json()).toMatchObject({ items: [] });
    expect(await (await get('/v1/repos/r_owner/runs?status=failed')).json()).toMatchObject({ items: [{ id: failed.id }] });
    expect(await (await get(`/v1/repos/r_owner/runs?commit=${otherCommit.commit_sha}`)).json()).toMatchObject({ items: [{ id: otherCommit.id }] });
    for (const invalid of ['status=unknown', 'commit=not-a-commit', 'workflow_id=wf_owner&workflow_id=wf_other', 'ignored=value']) {
      expect((await get(`/v1/repos/r_owner/runs?${invalid}`)).status).toBe(422);
    }
    const accepted = await app.fetch(new Request('https://api.gitknot.com/v1/repos/r_owner/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'filtered-planning' },
      body: JSON.stringify({ workflow_id: 'wf_owner', commit: oid, ref: 'refs/heads/main' }) }), test.env, test.context);
    const pending = await accepted.json() as { id: string; operation_id: string };
    expect(accepted.status).toBe(202);
    const planning = await (await get(`/v1/repos/r_owner/runs?workflow_id=wf_owner&status=planning&commit=${oid}`)).json() as { items: Array<Record<string, unknown>> };
    expect(planning.items).toHaveLength(1);
    expect(planning.items[0]).toMatchObject({ id: pending.id, requested_commit_sha: oid, status: 'planning', plan_digest: null });
    expect(planning.items[0]).not.toHaveProperty('commit_sha');
    await execute(test.env.DB, `UPDATE workflow_run_requests SET status='failed',error_json='{"code":"fixture_planning_failure"}',revision=revision+1 WHERE id=?`, pending.operation_id);
    const failures = await (await get(`/v1/repos/r_owner/runs?workflow_id=wf_owner&status=failed&commit=${oid}`)).json() as { items: Array<{ id: string }> };
    expect(new Set(failures.items.map(value => value.id))).toEqual(new Set([failed.id, pending.id]));
    const alpha = await liveAttempt(test, first, 'alpha'), beta = await liveAttempt(test, first, 'beta');
    for (const [attempt, text] of [[alpha, 'alpha-only'], [beta, 'beta-only']] as const) {
      await putObjectBytes(test.env, { attempt_id: attempt.id, generation: attempt.generation, plan_digest: attempt.plan_digest, runner_id: attempt.producer_id,
        kind: 'log', name: 'combined', sequence: 0, final: true, content_type: 'text/plain', retention_seconds: 3600 }, new TextEncoder().encode(text));
    }
    const logs = (query: string) => get(`/v1/runs/${first.id}/logs?${query}`);
    expect(await (await logs('job_id=alpha')).json()).toMatchObject({ items: [{ attempt_id: alpha.id, text: 'alpha-only' }] });
    expect(await (await logs(`job_id=${beta.job_id}`)).json()).toMatchObject({ items: [{ attempt_id: beta.id, text: 'beta-only' }] });
    expect(await (await logs(`job_id=alpha&attempt_id=${beta.id}`)).json()).toMatchObject({ items: [] });
    expect(await (await logs(`job_id=alpha&attempt_id=${alpha.id}`)).json()).toMatchObject({ items: [{ attempt_id: alpha.id }] });
    expect(await (await logs('job_id=missing')).json()).toMatchObject({ items: [] });
    expect((await logs('job_id=alpha&job_id=beta')).status).toBe(422);
    expect(test.executorCalls()).toBe(0);
  });

  it('keeps private preview, planning and failed-trigger audiences after the live source changes', async () => {
    const test = await fixture(); await configuredWorkflow(test);
    await test.db.batch([
      stmt(test.env.DB, `UPDATE repositories SET visibility='public' WHERE id='r_owner'`),
      stmt(test.env.DB, `INSERT INTO access_grants(id,account_id,repo_id,principal_type,principal_id,capability,created_by,created_at,updated_at)
        VALUES ('grant_preview_source','u_other','r_other','user','u_owner','contents.read','u_other',?,?)`, now(), now()),
      stmt(test.env.DB, `INSERT INTO git_candidates(repo_id,id,source_repo_id,source_oid,target_ref,target_oid,candidate_oid,internal_ref,strategy,policy_revision,actor_id,state,operation_id,created_at,updated_at)
        VALUES ('r_owner','candidate_private','r_other',?,'refs/heads/main',?,?,?,'merge',1,'u_owner','ready','native_private',?,?)`, oid, oid, oid, 'refs/gitknot/candidates/private', now(), now()),
    ]);
    const app = api(test), outsider = api(test, null);
    const preview = await app.fetch(new Request('https://api.gitknot.com/v1/repos/r_owner/workflows/wf_owner/plan', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'private-preview' },
      body: JSON.stringify({ commit_oid: oid, ref: 'refs/heads/main', merge_candidate_id: 'candidate_private', inputs: {} }) }), test.env, test.context);
    const saved = await preview.json() as { id: string; source: { related_repository_ids: string[] } };
    expect(preview.status).toBe(201); expect(saved.source.related_repository_ids).toEqual(['r_owner', 'r_other']);
    const accepted = await app.fetch(new Request('https://api.gitknot.com/v1/repos/r_owner/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'private-planning' },
      body: JSON.stringify({ workflow_id: 'wf_owner', commit: oid, ref: 'refs/heads/main', event: { type: 'workflow.dispatch', merge_candidate_id: 'candidate_private' } }) }), test.env, test.context);
    const pending = await accepted.json() as { id: string; operation_id: string };
    expect(accepted.status).toBe(202);
    for (const path of [`/v1/runs/${pending.id}`, `/v1/workflow-operations/${pending.operation_id}`]) {
      expect((await outsider.fetch(new Request(`https://api.gitknot.com${path}`), test.env, test.context)).status).toBe(404);
    }
    expect(await (await outsider.fetch(new Request('https://api.gitknot.com/v1/repos/r_owner/runs?status=planning'), test.env, test.context)).json()).toMatchObject({ items: [] });
    await execute(test.env.DB, `INSERT INTO workflow_trigger_failures(event_id,workflow_id,repo_id,account_id,commit_sha,code,message,created_at,audience_json)
      VALUES ('evt_private_failure','wf_owner','r_owner','u_owner',?,'workflow_plan_invalid','Private source compilation failed.',?,'["r_owner","r_other"]')`, oid, now());
    expect(await (await outsider.fetch(new Request('https://api.gitknot.com/v1/repos/r_owner/workflow-trigger-failures'), test.env, test.context)).json()).toMatchObject({ items: [] });
    await execute(test.env.DB, `UPDATE access_grants SET revoked_at=?,revision=revision+1 WHERE id='grant_preview_source'`, now());
    const denied = await app.fetch(new Request(`https://api.gitknot.com/v1/repos/r_owner/plans/${saved.id}`, { headers: { 'if-none-match': preview.headers.get('etag')! } }), test.env, test.context);
    expect(denied.status).toBe(404); expect(denied.headers.get('etag')).toBeNull();
    expect((await app.fetch(new Request(`https://api.gitknot.com/v1/runs/${pending.id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json', 'if-match': '"999"' }, body: '{}' }), test.env, test.context)).status).toBe(404);
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM workflow_runs')).toEqual({ count: 0 });
  });

  it('selects reproduction job data only through the canonical job query', async () => {
    const test = await fixture(), selected = job('_selected'); selected.variables = { REGION: 'selected-region' };
    const other = job('other'); other.variables = { REGION: 'other-region' };
    const record = await run(test, [selected, other]), app = api(test);
    const response = await app.fetch(new Request(`https://api.gitknot.com/v1/runs/${record.id}/reproduce?job=_selected`), test.env, test.context);
    expect(response.status).toBe(200);
    const reproduction = await response.json() as { variables: Record<string, string> };
    expect(reproduction.variables).toEqual({ REGION: 'selected-region' });
    expect((await app.fetch(new Request(`https://api.gitknot.com/v1/runs/${record.id}/reproduce?job_id=_selected`), test.env, test.context)).status).toBe(422);
    expect((await app.fetch(new Request(`https://api.gitknot.com/v1/runs/${record.id}/reproduce?job=missing`), test.env, test.context)).status).toBe(404);
    expect(test.executorCalls()).toBe(0);
  });

  it('refuses environment retirement with active execution or configuration and preserves retired history', async () => {
    const test = await fixture(), app = api(test), at = now();
    await execute(test.env.DB, `INSERT INTO workflow_environments(id,repo_id,account_id,name,destination,target_ref,required_approvals,allow_self_approval,allowed_approvers_json,created_at,updated_at)
      VALUES ('env_retire','r_owner','u_owner','retire','release:retire','refs/heads/main',1,0,'[]',?,?)`, at, at);
    const build = job('build'), deploy = job('deploy', ['build']);
    build.outputs = { bundle: { path: 'dist', retention_seconds: 3600, max_bytes: 1024, kind: 'artifact' } };
    deploy.inputs = [{ job: 'build', output: 'bundle', path: 'inputs/bundle' }];
    deploy.environment = { id: 'env_retire', artifact_job: 'build', artifact_name: 'bundle' };
    const record = await run(test, [build, deploy], 'environment-active');
    const remove = (key: string) => app.fetch(new Request('https://api.gitknot.com/v1/repos/r_owner/environments/env_retire', { method: 'DELETE', headers: { 'if-match': '"1"', 'idempotency-key': key } }), test.env, test.context);
    const busy = await remove('environment-busy');
    expect(busy.status).toBe(409); expect(await busy.json()).toMatchObject({ error: { code: 'environment_in_use' } });
    const cancellation = await app.fetch(new Request(`https://api.gitknot.com/v1/runs/${record.id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json', 'if-match': `"${record.revision}"` }, body: '{}' }), test.env, test.context);
    expect(cancellation.status).toBe(202);
    await executeWorkflowOperation(test.env, (await cancellation.json() as { operation_id: string }).operation_id);
    await test.db.batch([
      stmt(test.env.DB, `INSERT INTO vault_entries(id,account_id,repo_id,environment_id,scope_type,scope_id,kind,name,policy_json,current_version_id,created_by,created_at,updated_at)
        VALUES ('var_retire','u_owner','r_owner','env_retire','environment','env_retire','variable','REGION','{}','varv_retire','u_owner',?,?)`, at, at),
      stmt(test.env.DB, `INSERT INTO vault_versions(id,entry_id,account_id,version,plain_value,created_at,created_by) VALUES ('varv_retire','var_retire','u_owner',1,'retained-history',?,'u_owner')`, at),
    ]);
    const configured = await remove('environment-configured');
    expect(configured.status).toBe(409); expect(await configured.json()).toMatchObject({ error: { code: 'environment_configuration_active' } });
    await execute(test.env.DB, `UPDATE vault_entries SET deleted_at=?,revision=revision+1 WHERE id='var_retire'`, now());
    expect((await remove('environment-retired')).status).toBe(204);
    expect(await one(test.env.DB, "SELECT state,revision FROM workflow_environments WHERE id='env_retire'")).toEqual({ state: 'deleted', revision: 2 });
    expect(await one(test.env.DB, "SELECT COUNT(*) AS count FROM vault_versions WHERE entry_id='var_retire'")).toEqual({ count: 1 });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM workflow_jobs WHERE run_id=?', record.id)).toEqual({ count: 2 });
    await expect(run(test, [build, deploy], 'environment-after-retirement')).rejects.toMatchObject({ code: 'execution_conflict' });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM account_policy_barriers')).toEqual({ count: 0 });
    expect(test.executorCalls()).toBe(0);
  });

  it('invalidates pending release decisions on environment retirement without deleting approvals or published artifacts', async () => {
    const test = await fixture(), build = job('build'), at = now();
    build.outputs = { bundle: { path: 'dist', retention_seconds: 3600, max_bytes: 1024, kind: 'artifact' } };
    const record = await run(test, [build], 'retirement-history'), attempt = await liveAttempt(test, record);
    const identity = { attempt_id: attempt.id, generation: attempt.generation, plan_digest: attempt.plan_digest, runner_id: attempt.producer_id };
    await putObjectBytes(test.env, { ...identity, kind: 'output', name: 'bundle', sequence: 0, final: true, content_type: 'application/octet-stream', retention_seconds: 3600 }, new TextEncoder().encode('artifact'));
    const artifact = await completeObjectManifest(test.env, identity, 'bundle', 'output'), logs = await completeObjectManifest(test.env, identity, 'logs', 'logs');
    await recordDestruction(test, attempt);
    await test.machine(attempt.id).complete(attempt.id, { ...identity, conclusion: 'succeeded', exit_code: 0, signal: null, resource_exhaustion: null,
      toolchain_digest: attempt.toolchain_digest, outputs: [{ name: 'bundle', sha256: artifact.source_digest!, size_bytes: 8 }], log_manifest_digest: logs.sha256,
      process_group_stopped: true, started_at: attempt.started_at!, finished_at: now() });
    await advanceRun(test.env, record.id);
    await execute(test.env.DB, `INSERT INTO workflow_environments(id,repo_id,account_id,name,destination,target_ref,required_approvals,allow_self_approval,allowed_approvers_json,created_at,updated_at)
      VALUES ('env_history','r_owner','u_owner','history','release:history','refs/heads/main',1,1,'[]',?,?)`, at, at);
    const environment = (await one<EnvironmentRecord>(test.env.DB, "SELECT * FROM workflow_environments WHERE id='env_history'"))!;
    const currentRun = (await one<RunRecord>(test.env.DB, 'SELECT * FROM workflow_runs WHERE id=?', record.id))!;
    test.env.GIT_SERVICE = { fetch: async () => Response.json({ repo_id: 'r_owner', commit_oid: oid, held: true }), connect() { throw new Error('Fixture HTTP only.'); } };
    const published = await createPromotion(test.env.DB, currentRun, environment, artifact, owner.id, 'published-before-retirement', 'published-before-retirement');
    await decidePromotion(test.env, test.env.DB, published, owner.id, 'approved');
    const release = await promoteArtifact(test.env, published.id);
    expect(release.released).toBe(true);
    const waiting = await createPromotion(test.env.DB, currentRun, environment, artifact, owner.id, 'pending-retirement', 'pending-retirement');
    await decidePromotion(test.env, test.env.DB, waiting, owner.id, 'approved');
    const current = (await one<PromotionRecord>(test.env.DB, 'SELECT * FROM workflow_promotions WHERE id=?', waiting.id))!;
    const app = api(test), requested = await app.fetch(new Request(`https://api.gitknot.com/v1/runs/${record.id}/promotions/${waiting.id}/promote`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': `"${current.revision}"`, 'idempotency-key': 'pending-environment-publication' }, body: '{}' }), test.env, test.context);
    expect(requested.status).toBe(202);
    const operation = await requested.json() as { id: string };
    const approvals = await many(test.env.DB, 'SELECT * FROM environment_approvals ORDER BY id');
    const deleted = await app.fetch(new Request('https://api.gitknot.com/v1/repos/r_owner/environments/env_history', { method: 'DELETE', headers: { 'if-match': '"1"', 'idempotency-key': 'retire-history' } }), test.env, test.context);
    expect(deleted.status).toBe(204);
    expect(await many(test.env.DB, 'SELECT * FROM environment_approvals ORDER BY id')).toEqual(approvals);
    expect(await one(test.env.DB, 'SELECT status FROM workflow_promotions WHERE id=?', published.id)).toEqual({ status: 'released' });
    expect(await one(test.env.DB, 'SELECT status FROM workflow_promotions WHERE id=?', waiting.id)).toEqual({ status: 'invalidated' });
    expect(await executeWorkflowOperation(test.env, operation.id)).toMatchObject({ status: 'failed' });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM workflow_releases')).toEqual({ count: 1 });
    const history = await app.fetch(new Request(`https://api.gitknot.com/v1/repos/r_owner/releases/${release.release_id}`), test.env, test.context);
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ id: release.release_id, artifact_digest: artifact.source_digest, environment_id: environment.id });
    expect(test.executorCalls()).toBe(0);
  });

  it('serves authorized validation and immutable priced previews through the UI contracts without execution, budget holds or secret values', async () => {
    const test = await fixture(); await configuredWorkflow(test);
    const issued = await prepareCredential(test.env.DB, { principal_id: owner.id, user_id: owner.user_id, kind: 'personal', name: 'Compiler preview fixture',
      capabilities: ['*'], repository_ids: null, account_ids: null, auth_revision: 1, mfa: false, expires_at: new Date(Date.now() + 4 * 3600_000).toISOString(), created_by: owner.id });
    await issued.statement.run();
    const actor = { ...owner, credential_id: issued.credential.id, capabilities: ['*'] };
    const source = JSON.stringify({ version: 1, name: 'verify', triggers: ['workflow.dispatch'], source: 'event.commit', access: { repository: 'read', secrets: ['TOKEN'] },
      defaults: { executor: { type: 'hosted', profile: 'linux-small' }, toolchain: 'fixture', timeout: '10m' }, jobs: { test: {
        env: { REGION: { variable: 'REGION' } }, steps: [{ id: '_preview', run: 'node --version', env: { TOKEN: { secret: 'TOKEN' } } }] } } });
    const definition = validatedDefinition(source), definitionHash = await definitionDigest(definition);
    await test.db.batch([
      stmt(test.env.DB, `UPDATE workflow_execution_policy SET policy_json=? WHERE repo_id='r_owner'`, JSON.stringify({ access: { repository: 'read', capabilities: [], secrets: ['TOKEN'] },
        hosted_profiles: ['linux-small'], self_hosted_pools: {}, inapplicable_jobs: [] })),
      stmt(test.env.DB, `INSERT INTO workflow_versions(id,workflow_id,repo_id,account_id,source_commit,definition_digest,definition,definition_json,policy_revision,approved_by,approved_credential_id,created_at)
        VALUES ('wfv_preview','wf_owner','r_owner','u_owner',?,?,?,?,1,'u_owner',?,?)`, oid, definitionHash, source, JSON.stringify(definition), issued.credential.id, now()),
      stmt(test.env.DB, `UPDATE workflows SET current_version_id='wfv_preview',revision=revision+1 WHERE id='wf_owner'`),
    ]);
    const serviceKey = base64url(crypto.getRandomValues(new Uint8Array(32))), envelopeKey = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const broker = createSecretsBroker(), brokerEnv: SecretsBrokerBindings = { ...test.env, SECRETS_KEK_CURRENT_ID: 'kek_preview',
      SECRETS_KEK_KEYRING_JSON: JSON.stringify({ kek_preview: envelopeKey }), SECRETS_SERVICE_KEYS_JSON: JSON.stringify({ preview: { key: serviceKey, scopes: ['vault.manage', 'vault.plan', 'vault.rotate'] } }) };
    test.env.SECRETS_CLIENT_ID = 'preview'; test.env.SECRETS_CLIENT_KEY = serviceKey;
    test.env.SECRETS = { fetch: (input, init) => Promise.resolve(broker.fetch(new Request(input, init), brokerEnv, test.context)), connect() { throw new Error('This fixture exposes HTTP only.'); } };
    await brokerRequest(test.env, 'vault.rotate', '/internal/vault/keys/register', { expected_revision: 0 });
    const secret = 'preview-secret-must-never-appear', variable = 'preview-variable-must-never-appear', privateInput = 'preview-input-value-must-never-appear';
    await writeVaultEntry(test.env, { principal: actor, scope: { repo_id: 'r_owner' }, kind: 'secret', name: 'TOKEN', value: secret, expected_revision: null, operation_id: 'preview-secret',
      policy: { version: 1, enabled: true, repository_ids: ['r_owner'], workflow_ids: ['wf_owner'], actor_ids: null, environment_ids: null, refs: ['refs/heads/main'],
        allow_cross_account: false, allow_self_hosted: false, runner_pool_ids: [], require_environment: false, not_before: null, expires_at: null } });
    await writeVaultEntry(test.env, { principal: actor, scope: { repo_id: 'r_owner' }, kind: 'variable', name: 'REGION', value: variable, expected_revision: null, operation_id: 'preview-variable' });
    brokerEnv.SECRETS_KEK_KEYRING_JSON = 'preview-must-not-load-decryption-keys';
    let currentHead = oid, admissionCalls = 0, workflowStarts = 0;
    test.env.GIT_SERVICE = { fetch: async () => Response.json({ repo_id: 'r_owner', commit_oid: currentHead }), connect() { throw new Error('This fixture exposes HTTP only.'); } };
    test.env.ADMISSION = { idFromName: (value: string) => ({ toString: () => value }), get: () => { admissionCalls++; throw new Error('Previews must not invoke admission.'); } } as unknown as DurableObjectNamespace;
    test.env.RUN_WORKFLOW = { create: async () => { workflowStarts++; throw new Error('Previews must not start Workflows.'); } } as unknown as Workflow;
    const noEffects = () => Object.fromEntries(['workflow_runs', 'workflow_jobs', 'execution_attempts', 'billing_accounts', 'billing_credits', 'billing_reservations', 'billing_ledger', 'billing_controls', 'vault_selections', 'vault_use_events', 'credentials']
      .map(table => [table, Number(test.db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count)]));
    const before = noEffects(), app = api(test, actor);
    const post = (path: string, body: unknown, key: string) => app.fetch(new Request(`https://api.gitknot.com${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) }), test.env, test.context);
    const invalid = await post('/v1/repos/r_owner/workflows/validate', { source: 'version: [invalid' }, 'validate-invalid');
    expect(invalid.status).toBe(200); expect(await invalid.json()).toMatchObject({ kind: 'validation', valid: false, executable: false, diagnostics: expect.any(Array) });
    const validated = await post('/v1/repos/r_owner/workflows/validate', { source }, 'validate-preview');
    expect(validated.status, await validated.clone().text()).toBe(200);
    expect(await validated.json()).toMatchObject({ kind: 'validation', valid: true, executable: false, definition: { origin: 'submitted_draft', source_commit: null } });
    const input = { commit_oid: oid, ref: 'refs/heads/main', inputs: { private_input: privateInput } };
    const planned = await post('/v1/repos/r_owner/workflows/wf_owner/plan', input, 'immutable-preview');
    const data = await planned.json() as { id: string; expires_at: string; cost: { maximum_cost_units: string }; [key: string]: unknown };
    expect(planned.status, JSON.stringify(data)).toBe(201);
    expect(data).toMatchObject({ kind: 'plan', valid: true, executable: false, payer: { account_id: 'u_owner' }, definition: { workflow_id: 'wf_owner', workflow_version_id: 'wfv_preview', digest: definitionHash },
      jobs: [{ id: 'test', configuration: { status: 'verified_metadata', steps: [{ step_id: '_preview', secrets: [{ name: 'TOKEN', version: 1 }], variables: [{ name: 'REGION', version: 1 }] }] },
        cost: { rates: { compute: { meter: 'hosted.linux-small' } }, availability: { admission_required: true } } }] });
    expect(BigInt(data.cost.maximum_cost_units)).toBeGreaterThan(0n);
    const path = `/v1/repos/r_owner/plans/${data.id}`, etag = planned.headers.get('etag')!;
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    const read = await app.fetch(new Request(`https://api.gitknot.com${path}`), test.env, test.context);
    expect(read.status).toBe(200); expect(await read.json()).toEqual(data); expect(read.headers.get('etag')).toBe(etag);
    expect((await app.fetch(new Request(`https://api.gitknot.com${path}`, { headers: { 'if-none-match': etag } }), test.env, test.context)).status).toBe(304);
    const replay = await post('/v1/repos/r_owner/workflows/wf_owner/plan', input, 'immutable-preview');
    expect(replay.status).toBe(200); expect(await replay.json()).toMatchObject({ id: data.id });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM workflow_plan_previews')).toEqual({ count: 3 });
    await expect(execute(test.env.DB, `UPDATE workflow_plan_previews SET result_json='{}' WHERE id=?`, data.id)).rejects.toThrow('immutable');
    const stored = (await one<{ result_json: string }>(test.env.DB, 'SELECT result_json FROM workflow_plan_previews WHERE id=?', data.id))!;
    for (const value of [secret, variable, privateInput]) { expect(JSON.stringify(data)).not.toContain(value); expect(stored.result_json).not.toContain(value); }
    expect((await api(test, { ...owner, id: 'u_other', user_id: 'u_other' }).fetch(new Request(`https://api.gitknot.com${path}`), test.env, test.context)).status).toBe(404);
    await execute(test.env.DB, `INSERT INTO git_candidates(repo_id,id,source_repo_id,source_oid,target_ref,target_oid,candidate_oid,internal_ref,strategy,policy_revision,actor_id,state,operation_id,created_at,updated_at)
      VALUES ('r_owner','candidate_preview','r_owner',?,'refs/heads/main',?,?,'refs/gitknot/candidates/preview','merge',1,'u_owner','ready','preview-candidate-op',?,?)`, oid, 'b'.repeat(40), 'c'.repeat(40), now(), now());
    expect((await post('/v1/repos/r_owner/workflows/wf_owner/plan', { ...input, commit_oid: 'c'.repeat(40), merge_candidate_id: 'candidate_preview' }, 'stale-candidate-preview')).status).toBe(409);
    expect((await post('/v1/repos/r_owner/workflows/wf_owner/plan', { ...input, event: { type: 'review.unsubscribed' } }, 'forged-preview-event')).status).toBe(422);
    expect(noEffects()).toEqual(before); expect(admissionCalls).toBe(0); expect(workflowStarts).toBe(0); expect(test.executorCalls()).toBe(0); expect(test.queue.messages).toEqual([]);
    currentHead = 'e'.repeat(40);
    expect((await app.fetch(new Request(`https://api.gitknot.com${path}`), test.env, test.context)).status).toBe(409);
    currentHead = oid;
    brokerEnv.SECRETS_KEK_KEYRING_JSON = JSON.stringify({ kek_preview: envelopeKey });
    await writeVaultEntry(test.env, { principal: actor, scope: { repo_id: 'r_owner' }, kind: 'variable', name: 'REGION', value: 'new-private-value', expected_revision: 1, operation_id: 'preview-variable-changed' });
    brokerEnv.SECRETS_KEK_KEYRING_JSON = 'preview-must-not-load-decryption-keys';
    expect((await app.fetch(new Request(`https://api.gitknot.com${path}`), test.env, test.context)).status).toBe(409);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(Date.parse(data.expires_at) + 1));
      expect((await app.fetch(new Request(`https://api.gitknot.com${path}`), test.env, test.context)).status).toBe(410);
    } finally { vi.useRealTimers(); }
  });

  it('rejects forged manual event classifications before a valid candidate can bypass verification, and the real merge gate stays blocking', async () => {
    const test = await fixture(), configured = await configuredWorkflow(test, ['pull_request.updated', 'merge_candidate.created']);
    await execute(test.env.DB, `INSERT INTO git_candidates(repo_id,id,source_repo_id,source_oid,target_ref,target_oid,candidate_oid,internal_ref,strategy,policy_revision,actor_id,state,operation_id,created_at,updated_at)
      VALUES ('r_owner','candidate_manual','r_owner',?,'refs/heads/main',?,?,?,'merge',1,'u_owner','ready','operation_candidate',?,?)`, oid, oid, oid, 'refs/gitknot/candidates/manual', now(), now());
    const input = { commit: oid, ref: 'refs/heads/main', event: { id: 'manual_candidate', type: 'review.unsubscribed', merge_candidate_id: 'candidate_manual' } };
    await expect(planRun(test.env, configured.repository, configured.workflow, configured.version, owner, input)).rejects.toMatchObject({ code: 'event_untrusted' });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM workflow_runs')).toEqual({ count: 0 });
    const frozen = await planRun(test.env, configured.repository, configured.workflow, configured.version, owner, { ...input, event: { ...input.event, type: 'workflow.dispatch' } });
    expect(frozen.jobs[0]).toMatchObject({ applicable: true, blocked_reason: null, steps: [expect.objectContaining({ id: '_verify', run: 'exit 9' })] });
    const record = await createRun(test.env, test.env.DB, { plan: frozen, workflow_id: configured.workflow.id, actor_id: owner.id, request_key: 'manual-safe', request_hash: 'manual-safe' });
    const attempt = await liveAttempt(test, record), identity = { attempt_id: attempt.id, generation: attempt.generation, plan_digest: attempt.plan_digest, runner_id: attempt.producer_id };
    const logs = await completeObjectManifest(test.env, identity, 'logs', 'logs');
    await recordDestruction(test, attempt);
    await test.machine(attempt.id).complete(attempt.id, { ...identity, conclusion: 'failed', exit_code: 9, signal: null, resource_exhaustion: null,
      toolchain_digest: attempt.toolchain_digest, outputs: [], log_manifest_digest: logs.sha256, process_group_stopped: true, started_at: attempt.started_at!, finished_at: now() });
    await advanceRun(test.env, record.id);
    const blockers: MergeBlocker[] = [];
    const evidence = await evaluateVerification(await repositoryExecutionContext(test.env, owner, 'r_owner'), configured.repository, oid, [],
      [{ target: 'refs/heads/main', verification: { required: ['verify.test'], trusted_producers: ['hosted:linux-small'] } }], blockers);
    expect(evidence).toMatchObject([{ satisfied: false, applicable: true, conclusion: 'failed' }]);
    expect(blockers).toMatchObject([{ code: 'required_verification' }]);
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM execution_attempts WHERE run_id=?', record.id)).toEqual({ count: 1 });
    const candidateEvent = makeEvent({ type: 'merge_candidate.created', resource_id: 'candidate_manual', resource_revision: 1, repo_id: 'r_owner', account_id: owner.id,
      data: { candidate_id: 'candidate_manual', commit_sha: oid, policy_revision: 1, head_oid: oid, target_oid: oid, target_ref: 'refs/heads/main', changed_paths: ['old/name.ts', 'src/change.ts'] } });
    await handleWorkflowEvent(test.env, candidateEvent);
    await handleWorkflowEvent(test.env, candidateEvent);
    const automatic = await one<{ plan_json: string }>(test.env.DB, `SELECT plan_json FROM workflow_runs WHERE repo_id='r_owner' AND trigger_type='merge_candidate.created'`);
    expect(automatic && JSON.parse(automatic.plan_json)).toMatchObject({ trigger: { type: 'merge_candidate.created' }, portable_manifest: { event: { changed_paths: ['old/name.ts', 'src/change.ts'] } } });
    expect(await one(test.env.DB, `SELECT COUNT(*) AS count FROM workflow_runs WHERE trigger_type='merge_candidate.created'`)).toEqual({ count: 1 });
    expect(test.executorCalls()).toBe(0);
  });

  it.each(['before', 'after'] as const)('recovers the same operation and run after a response is lost %s the atomic request intent', async point => {
    const test = await fixture(); await configuredWorkflow(test);
    const app = api(test), original = test.db.batch.bind(test.db);
    let failed = false;
    test.db.batch = async statements => {
      if (!failed && statements.some(statement => /INSERT INTO workflow_run_requests/.test((statement as unknown as { sql: string }).sql))) {
        failed = true;
        if (point === 'after') await original(statements);
        throw new Error('Injected lost request commit acknowledgment.');
      }
      return original(statements);
    };
    const request = () => new Request('https://api.gitknot.com/v1/repos/r_owner/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `lost-${point}` },
      body: JSON.stringify({ workflow_id: 'wf_owner', commit: oid, ref: 'refs/heads/main' }) });
    expect((await app.fetch(request(), test.env, test.context)).status).toBe(500);
    const receipt = (await one<{ operation_id: string }>(test.env.DB, 'SELECT operation_id FROM idempotency_keys WHERE principal_id=? AND key=?', owner.id, `lost-${point}`))!;
    expect(receipt.operation_id).toMatch(/^op_/);
    await execute(test.env.DB, `UPDATE idempotency_keys SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE principal_id=? AND key=?`, owner.id, `lost-${point}`);
    const recovered = await app.fetch(request(), test.env, test.context), body = await recovered.json() as { id: string; operation_id: string };
    expect(recovered.status, JSON.stringify(body)).toBe(202);
    expect(body.operation_id).toBe(receipt.operation_id);
    expect((await app.fetch(new Request(`https://api.gitknot.com/v1/runs/${body.id}`), test.env, test.context)).status).toBe(200);
    await executeWorkflowOperation(test.env, receipt.operation_id);
    await executeWorkflowOperation(test.env, receipt.operation_id);
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM workflow_runs WHERE id=?', body.id)).toEqual({ count: 1 });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM workflow_run_requests')).toEqual({ count: 1 });
    expect(await one(test.env.DB, `SELECT COUNT(*) AS count FROM outbox WHERE type='workflow.operation.requested'`)).toEqual({ count: 1 });
    const manifest = await app.fetch(new Request(`https://api.gitknot.com/v1/runs/${body.id}/manifest`), test.env, test.context);
    expect(manifest.status).toBe(200);
    expect(await manifest.json()).toMatchObject({ jobs: [{ id: 'test', steps: [{ id: '_verify' }] }] });
    expect(test.executorCalls()).toBe(0);
  });

  it('advances the run ETag across planning and materialization without ever reusing a planning version', async () => {
    const test = await fixture(); await configuredWorkflow(test);
    const app = api(test);
    const response = await app.fetch(new Request('https://api.gitknot.com/v1/repos/r_owner/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'run-versions' },
      body: JSON.stringify({ workflow_id: 'wf_owner', commit: oid, ref: 'refs/heads/main' }) }), test.env, test.context);
    const initial = await response.json() as { id: string; revision: number; operation_id: string };
    expect(response.status).toBe(202);
    const url = `https://api.gitknot.com/v1/runs/${initial.id}`;
    const read = () => app.fetch(new Request(url), test.env, test.context);
    const cancel = (etag: string, key: string) => app.fetch(new Request(`${url}/cancel`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key, 'if-match': etag }, body: '{}' }), test.env, test.context);
    expect((await read()).headers.get('etag')).toBe(`"${initial.revision}"`);
    const planning: number[] = [];
    test.env.GIT_SERVICE = { fetch: async () => {
      const current = await read(), body = await current.json() as { status: string; revision: number };
      expect(body.status).toBe('planning');
      expect(current.headers.get('etag')).toBe(`"${body.revision}"`);
      planning.push(body.revision);
      return Response.json({ repo_id: 'r_owner', commit_oid: oid });
    }, connect() { throw new Error('This fixture exposes HTTP only.'); } };
    await executeWorkflowOperation(test.env, initial.operation_id);
    expect(planning.length).toBeGreaterThan(0);
    expect(Math.min(...planning)).toBeGreaterThan(initial.revision);
    const queued = await read(), materialized = await queued.json() as RunRecord;
    expect(materialized.status).toBe('queued');
    expect(materialized.revision).toBeGreaterThan(Math.max(...planning));
    expect(queued.headers.get('etag')).toBe(`"${materialized.revision}"`);
    expect(await one(test.env.DB, `SELECT resource_revision FROM outbox WHERE type='workflow.run.created' AND resource_id=?`, initial.id)).toEqual({ resource_revision: materialized.revision });
    await executeWorkflowOperation(test.env, initial.operation_id);
    expect((await read()).headers.get('etag')).toBe(queued.headers.get('etag'));
    const stale = `"${Math.max(...planning)}"`;
    expect((await cancel(stale, 'stale-planning-before-schedule')).status).toBe(412);
    await advanceRun(test.env, initial.id);
    const waiting = await read(), scheduled = await waiting.json() as RunRecord;
    expect(scheduled.status).toBe('waiting');
    expect(scheduled.revision).toBeGreaterThan(materialized.revision);
    expect((await cancel(stale, 'stale-planning-after-schedule')).status).toBe(412);
    const confirmed = await cancel(waiting.headers.get('etag')!, 'reviewed-run-version');
    expect(confirmed.status).toBe(202);
    expect(await confirmed.json()).toMatchObject({ id: initial.id, status: 'cancelling', revision: scheduled.revision + 1 });
    expect(await one(test.env.DB, 'SELECT plan_digest,orchestration_generation FROM workflow_runs WHERE id=?', initial.id)).toEqual({
      plan_digest: materialized.plan_digest, orchestration_generation: materialized.orchestration_generation,
    });
    expect(await one(test.env.DB, `SELECT COUNT(*) AS count FROM workflow_run_requests WHERE kind='cancel'`)).toEqual({ count: 1 });
    expect(test.executorCalls()).toBe(0);
  });

  it.each(['planning', 'materialization', 'scheduler'] as const)('aborts cancellation and its receipt when %s changes after the HTTP preflight', async phase => {
    const test = await fixture(); await configuredWorkflow(test);
    const app = api(test);
    const created = await app.fetch(new Request('https://api.gitknot.com/v1/repos/r_owner/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `cancel-race-${phase}` },
      body: JSON.stringify({ workflow_id: 'wf_owner', commit: oid, ref: 'refs/heads/main' }) }), test.env, test.context);
    const initial = await created.json() as { id: string; operation_id: string };
    expect(created.status).toBe(202);
    if (phase === 'scheduler') await executeWorkflowOperation(test.env, initial.operation_id);
    const url = `https://api.gitknot.com/v1/runs/${initial.id}`, reviewed = await app.fetch(new Request(url), test.env, test.context);
    const original = test.db.batch.bind(test.db);
    let raced = false;
    test.db.batch = async statements => {
      if (!raced && statements.some(statement => /INSERT INTO workflow_run_revision_guards/.test((statement as unknown as { sql: string }).sql))) {
        raced = true;
        if (phase === 'planning') await execute(test.env.DB, `UPDATE workflow_run_requests SET status='running',revision=revision+1 WHERE id=?`, initial.operation_id);
        else if (phase === 'materialization') await executeWorkflowOperation(test.env, initial.operation_id);
        else await advanceRun(test.env, initial.id);
      }
      return original(statements);
    };
    const key = `stale-cancel-${phase}`;
    const cancelled = await app.fetch(new Request(`${url}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key, 'if-match': reviewed.headers.get('etag')! }, body: '{}' }), test.env, test.context);
    test.db.batch = original;
    expect(raced).toBe(true);
    expect(cancelled.status).toBe(412);
    expect(await cancelled.json()).toMatchObject({ error: { code: 'revision_conflict' } });
    expect(await one(test.env.DB, `SELECT COUNT(*) AS count FROM workflow_run_requests WHERE kind='cancel'`)).toEqual({ count: 0 });
    expect(await one(test.env.DB, `SELECT COUNT(*) AS count FROM outbox WHERE type='workflow.operation.requested' AND json_extract(payload_json,'$.kind')='cancel'`)).toEqual({ count: 0 });
    expect(await one(test.env.DB, `SELECT COUNT(*) AS count FROM audit_log WHERE action='workflows.cancel.requested'`)).toEqual({ count: 0 });
    expect(await one(test.env.DB, 'SELECT committed_at,event_id,audit_id,resource_id FROM idempotency_keys WHERE principal_id=? AND key=?', owner.id, key)).toEqual({ committed_at: null, event_id: null, audit_id: null, resource_id: null });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM workflow_run_revision_guards')).toEqual({ count: 0 });
    const current = await app.fetch(new Request(url), test.env, test.context);
    expect(current.headers.get('etag')).not.toBe(reviewed.headers.get('etag'));
    const confirmed = await app.fetch(new Request(`${url}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `reviewed-cancel-${phase}`, 'if-match': current.headers.get('etag')! }, body: '{}' }), test.env, test.context);
    expect(confirmed.status).toBe(202);
    expect(test.executorCalls()).toBe(0);
  });

  it('cancels a planning run durably and completes cleanup after the requesting actor is revoked', async () => {
    const test = await fixture(); await configuredWorkflow(test);
    const app = api(test);
    const created = await app.fetch(new Request('https://api.gitknot.com/v1/repos/r_owner/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'planning-cancel' },
      body: JSON.stringify({ workflow_id: 'wf_owner', commit: oid, ref: 'refs/heads/main' }) }), test.env, test.context);
    const initial = await created.json() as { id: string; revision: number; operation_id: string };
    expect(created.status).toBe(202);
    const cancelled = await app.fetch(new Request(`https://api.gitknot.com/v1/runs/${initial.id}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'cancel-planning', 'if-match': `"${initial.revision}"` }, body: '{}' }), test.env, test.context);
    const cancellation = await cancelled.json() as { operation_id: string; status: string; revision: number };
    expect(cancelled.status, JSON.stringify(cancellation)).toBe(202);
    expect(cancellation).toMatchObject({ status: 'cancelled', revision: initial.revision + 1 });
    expect((await app.fetch(new Request(`https://api.gitknot.com/v1/runs/${initial.id}`), test.env, test.context)).headers.get('etag')).toBe(`"${cancellation.revision}"`);
    await execute(test.env.DB, 'UPDATE users SET disabled_at=?,auth_revision=auth_revision+1 WHERE id=?', now(), owner.id);
    expect(await executeWorkflowOperation(test.env, initial.operation_id)).toMatchObject({ status: 'cancelled' });
    expect(await executeWorkflowOperation(test.env, cancellation.operation_id)).toMatchObject({ status: 'completed' });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM workflow_runs')).toEqual({ count: 0 });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM execution_attempts')).toEqual({ count: 0 });
    expect(test.executorCalls()).toBe(0);
  });

  it('freezes compiler, producer and per-command secret selection identities without resolving secret values while planning', async () => {
    const test = await fixture();
    const module = { version: 1, name: 'fixture/multi', module_version: '1.0.0', access: { repository: 'none', capabilities: [], secrets: ['A', 'B'] },
      steps: [{ run: 'printf first', env: { TOKEN: { secret: 'A' } } }, { run: 'printf second', env: { TOKEN: { secret: 'B' } } }] };
    const reference = 'fixture/multi@1.0.0', modules = { [reference]: module };
    const source = JSON.stringify({ version: 1, name: 'verify', triggers: ['workflow.dispatch'], source: 'event.commit',
      access: { repository: 'read', secrets: ['A', 'B'] }, defaults: { executor: { type: 'hosted', profile: 'linux-small' }, toolchain: 'fixture', timeout: '10m' },
      modules: { [reference]: await moduleDigest(module) }, jobs: { test: { steps: [{ id: 'module', uses: reference }] } } });
    const definition = validatedDefinition(source, modules);
    await execute(test.env.DB, `INSERT INTO workflow_execution_policy (repo_id,account_id,policy_json,toolchains_json,modules_json,egress_json,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      'r_owner', 'u_owner', JSON.stringify({ access: { repository: 'read', capabilities: [], secrets: ['A', 'B'] }, hosted_profiles: ['linux-small'], self_hosted_pools: {}, inapplicable_jobs: [] }),
      JSON.stringify({ fixture: { os: 'linux', arch: 'x64', tools: { node: '24.18.0' } } }), JSON.stringify(modules), JSON.stringify({ hosts: [], max_bytes: 1024, max_requests: 5, max_request_bytes: 512 }), 'u_owner', now());
    test.env.GIT_SERVICE = { fetch: async () => Response.json({ repo_id: 'r_owner', commit_oid: oid }) } as unknown as Fetcher;
    test.env.SECRETS_CLIENT_ID = 'execution-fixture'; test.env.SECRETS_CLIENT_KEY = 'x'.repeat(43);
    let boundDigest: string | null = null;
    test.env.SECRETS = { fetch: async (request: Request) => {
      const body = await request.json() as { steps?: Array<{ step_id: string; secrets: string[] }>; selection_id?: string; plan_digest?: string };
      if (new URL(request.url).pathname.endsWith('/bind-plan')) { expect(body.selection_id).toBe('selection_fixture'); boundDigest = body.plan_digest!; return Response.json({ bound: true }); }
      if (!new URL(request.url).pathname.endsWith('/select')) throw new Error('Planning must never resolve plaintext secrets.');
      expect(body.steps?.[0]?.secrets).toEqual(['A', 'B']);
      return Response.json({ selection_id: 'selection_fixture', selection_digest: 'e'.repeat(64), context: {}, steps: [{ step_id: 'module',
        secrets: ['A', 'B'].map(name => ({ name, secret_id: `secret_${name}`, version_id: `version_${name}`, environment_id: null })), variables: [] }] });
    } } as unknown as Fetcher;
    const repository = (await one<Repository>(test.env.DB, 'SELECT * FROM repositories WHERE id=?', 'r_owner'))!;
    const workflow = (await one<WorkflowRecord>(test.env.DB, 'SELECT * FROM workflows WHERE id=?', 'wf_owner'))!;
    const version = { ...(await one<WorkflowVersion>(test.env.DB, 'SELECT * FROM workflow_versions WHERE id=?', 'wfv_owner'))!, definition: source, definition_digest: await definitionDigest(definition) };
    const actor: Principal = { id: 'u_owner', kind: 'user', user_id: 'u_owner', credential_id: null, capabilities: null, repository_ids: null, account_ids: null, mfa: false };
    const frozen = await planRun(test.env, repository, workflow, version, actor, { commit: oid, ref: 'refs/heads/main', event: { type: 'workflow.dispatch', id: 'manual' } });
    expect(frozen.jobs[0]?.steps).toHaveLength(2);
    expect(frozen.jobs[0]?.steps.every(step => step.secrets.map(secret => secret.name).join(',') === 'A,B')).toBe(true);
    expect(frozen.jobs[0]?.producer_id).toBe('hosted:linux-small');
    expect(frozen.portable_manifest).toMatchObject({ configuration: { selection_id: expect.stringMatching(/^bundle_/), selection_digest: expect.stringMatching(/^sha256:/) } });
    expect(boundDigest).toBe(await sha256(JSON.stringify(frozen)));
    expect(test.executorCalls()).toBe(0);
  });
  it('survives duplicate dispatch and a lost projection response without acknowledging an unaccepted attempt or allocating a VM', async () => {
    const test = await fixture(), record = await run(test, [job('test')]);
    await advanceRun(test.env, record.id);
    const attempt = (await one<AttemptRecord>(test.env.DB, 'SELECT * FROM execution_attempts WHERE run_id=?', record.id))!;
    const originalBatch = test.db.batch.bind(test.db);
    let failed = false;
    test.db.batch = async statements => { if (!failed) { failed = true; throw new Error('Injected D1 projection loss.'); } return originalBatch(statements); };
    await expect(acceptDispatch(test.env, { attempt_id: attempt.id, generation: 1 })).rejects.toThrow();
    expect(test.stores.get(attempt.id)?.data.get('accepted')).toMatchObject({ attempt_id: attempt.id, generation: 1 });
    expect(test.stores.get(attempt.id)?.alarm).not.toBeNull();
    test.machines.delete(attempt.id); // Simulate object restart with durable storage retained.
    await Promise.all(Array.from({ length: 8 }, () => acceptDispatch(test.env, { attempt_id: attempt.id, generation: 1 })));
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM execution_attempts WHERE run_id=?', record.id)).toEqual({ count: 1 });
    expect(await one(test.env.DB, 'SELECT accepted_at FROM execution_dispatches WHERE attempt_id=?', attempt.id)).toMatchObject({ accepted_at: expect.any(String) });
    await expect(acceptDispatch(test.env, { attempt_id: attempt.id, generation: 2 })).rejects.toMatchObject({ code: 'attempt_fenced' });
    await expect(test.machine(attempt.id).tick()).rejects.toMatchObject({ code: 'hosted_profile_unavailable' });
    expect(test.executorCalls()).toBe(0);
  });

  it('bounds fair dispatch across tenants and stores an immutable, request-deduplicated run plan', async () => {
    const test = await fixture();
    const first = await run(test, [job('test')], 'request-a');
    expect((await run(test, [job('test')], 'request-a')).id).toBe(first.id);
    const records = [first, await run(test, [job('test')], 'request-b'), await run(test, [job('test')], 'request-c'), await run(test, [job('test')], 'other-a', 'other')];
    for (const record of records) await advanceRun(test.env, record.id);
    expect(await dispatchFairly(test.env)).toBe(2);
    const accounts = await Promise.all(test.queue.messages.map(message => one<{ account_id: string }>(test.env.DB, 'SELECT account_id FROM execution_attempts WHERE id=?', message.attempt_id)));
    expect(new Set(accounts.map(account => account!.account_id))).toEqual(new Set(['u_owner', 'u_other']));
    await expect(execute(test.env.DB, 'UPDATE workflow_runs SET commit_sha=? WHERE id=?', 'e'.repeat(40), first.id)).rejects.toThrow('immutable');
    const stored = (await one<RunRecord>(test.env.DB, 'SELECT * FROM workflow_runs WHERE id=?', first.id))!;
    expect(await sha256(stored.plan_json)).toBe(stored.plan_digest);
    expect(records[2]!.enqueue_sequence).toBeGreaterThan(first.enqueue_sequence);
  });

  it('keeps a stable queued concurrency group through approval waiting, exact release ordering and executor cleanup', async () => {
    const test = await fixture(), build = job('build'), deploy = job('deploy', ['build']);
    build.outputs = { bundle: { path: 'dist', retention_seconds: 3600, max_bytes: 1024, kind: 'artifact' } };
    deploy.inputs = [{ job: 'build', output: 'bundle', path: '.gitknot-inputs/build/bundle' }];
    deploy.environment = { id: 'env_queue', artifact_job: 'build', artifact_name: 'bundle' };
    await execute(test.env.DB, `INSERT INTO workflow_environments(id,repo_id,account_id,name,destination,target_ref,required_approvals,allow_self_approval,allowed_approvers_json,created_at,updated_at)
      VALUES ('env_queue','r_owner','u_owner','queue','release:queue','refs/heads/main',1,1,'[]',?,?)`, now(), now());
    test.env.GIT_SERVICE = { fetch: async () => Response.json({ repo_id: 'r_owner', commit_oid: oid, held: true }), connect() { throw new Error('This fixture exposes HTTP only.'); } };
    const make = (key: string) => createRun(test.env, test.env.DB, { workflow_id: 'wf_owner', actor_id: owner.id, request_key: key, request_hash: key,
      plan: { ...plan([build, deploy]), trigger: { type: 'workflow.dispatch', id: key }, concurrency: { key: 'stable-release-group', supersede: false } } });
    const records = (await Promise.all([make('queue-first'), make('queue-second')])).sort((a, b) => a.enqueue_sequence - b.enqueue_sequence);
    const first = records[0]!, second = records[1]!;
    expect(first.concurrency_key).toBe(second.concurrency_key);
    await Promise.all([advanceRun(test.env, first.id), advanceRun(test.env, second.id)]);
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM execution_attempts WHERE run_id=?', second.id)).toEqual({ count: 0 });
    const waitingVersion = await one(test.env.DB, 'SELECT revision,updated_at FROM workflow_runs WHERE id=?', second.id);
    expect(waitingVersion).toMatchObject({ revision: second.revision + 1 });
    await advanceRun(test.env, second.id);
    expect(await one(test.env.DB, 'SELECT revision,updated_at FROM workflow_runs WHERE id=?', second.id)).toEqual(waitingVersion);
    const completed = async (key: string) => {
      const a = await liveAttempt(test, first, key), identity = { attempt_id: a.id, generation: a.generation, plan_digest: a.plan_digest, runner_id: a.producer_id };
      const outputs: CompletionReceipt['outputs'] = [];
      if (key === 'build') {
        const data = Buffer.from('exact queued release');
        await putObjectBytes(test.env, { ...identity, kind: 'output', name: 'bundle', sequence: 0, final: true, content_type: 'application/octet-stream', retention_seconds: 3600 }, data);
        const output = await completeObjectManifest(test.env, identity, 'bundle', 'output', await sha256(data));
        outputs.push({ name: 'bundle', sha256: output.source_digest!, size_bytes: data.length });
      }
      const logs = await completeObjectManifest(test.env, identity, 'logs', 'logs');
      await recordDestruction(test, a);
      await test.machine(a.id).complete(a.id, { ...identity, conclusion: 'succeeded', exit_code: 0, signal: null, resource_exhaustion: null, outputs,
        toolchain_digest: a.toolchain_digest, log_manifest_digest: logs.sha256, process_group_stopped: true, started_at: a.started_at!, finished_at: now() });
    };
    await completed('build');
    await advanceRun(test.env, first.id);
    expect(await one(test.env.DB, 'SELECT status FROM workflow_runs WHERE id=?', first.id)).toEqual({ status: 'waiting_approval' });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM execution_attempts WHERE run_id=?', first.id)).toEqual({ count: 1 });
    await advanceRun(test.env, second.id);
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM execution_attempts WHERE run_id=?', second.id)).toEqual({ count: 0 });
    const promotion = (await one<PromotionRecord>(test.env.DB, 'SELECT * FROM workflow_promotions WHERE run_id=?', first.id))!;
    await decidePromotion(test.env, test.env.DB, promotion, owner.id, 'approved');
    await completed('deploy');
    await advanceRun(test.env, first.id);
    expect(await one(test.env.DB, 'SELECT status FROM workflow_promotions WHERE id=?', promotion.id)).toEqual({ status: 'released' });
    await advanceRun(test.env, second.id);
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM execution_attempts WHERE run_id=?', second.id)).toEqual({ count: 1 });
    expect(test.executorCalls()).toBe(0);
  });

  it('retains complete redacted failure chunks, requires destruction proof, blocks dependents, fences late uploads, and actually deletes expired R2 objects', async () => {
    const test = await fixture();
    const documentation = { ...job('documentation'), applicable: false, inapplicable_reason: 'Trusted policy excludes unchanged documentation.' };
    const record = await run(test, [job('test'), job('build', ['test']), documentation]);
    const attempt = await liveAttempt(test, record);
    const identity = { attempt_id: attempt.id, generation: attempt.generation, plan_digest: attempt.plan_digest, runner_id: attempt.producer_id };
    const secret = 'vault-super-secret';
    const raw = `start 🌎\n${'failure detail\n'.repeat(6000)}${secret}\nfull failure trailer\n`;
    const redactor = new StreamingRedactor([secret]);
    const bytes = new TextEncoder().encode(raw), chunks: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.length; offset += 97) chunks.push(redactor.push(bytes.subarray(offset, offset + 97)));
    chunks.push(redactor.finish());
    const redacted = Buffer.concat(chunks).toString('utf8');
    expect(redacted).toBe(raw.replaceAll(secret, '[REDACTED]'));
    const object = await putObjectBytes(test.env, { ...identity, kind: 'log', name: 'combined', sequence: 0, content_type: 'text/plain', retention_seconds: 3600 }, Buffer.from(redacted));
    const manifest = await completeObjectManifest(test.env, identity, 'logs', 'logs');
    const receipt: CompletionReceipt = { ...identity, conclusion: 'failed', exit_code: 2, signal: null, resource_exhaustion: null,
      toolchain_digest: toolchain, outputs: [], log_manifest_digest: manifest.sha256, process_group_stopped: true, started_at: attempt.started_at!, finished_at: now() };
    await expect(test.machine(attempt.id).complete(attempt.id, receipt)).rejects.toMatchObject({ code: 'destruction_unverified' });
    expect(await one(test.env.DB, 'SELECT receipt_hash FROM execution_attempts WHERE id=?', attempt.id)).toEqual({ receipt_hash: null });
    await recordDestruction(test, attempt);
    await test.machine(attempt.id).complete(attempt.id, receipt);
    await test.machine(attempt.id).complete(attempt.id, receipt);
    await advanceRun(test.env, record.id);
    expect(await many(test.env.DB, 'SELECT job_key,status FROM workflow_jobs WHERE run_id=? ORDER BY job_key', record.id)).toEqual([
      { job_key: 'build', status: 'dependency_blocked' }, { job_key: 'documentation', status: 'not_applicable' }, { job_key: 'test', status: 'failed' },
    ]);
    expect(test.settlements).toHaveLength(1);
    expect(test.settlements[0]).toMatchObject({ termination_proof: { kind: 'hosted_destroyed' }, outcome: 'failure' });
    expect(await new Response(await streamManifest(test.env, manifest)).text()).toBe(redacted);
    expect((await test.blobs.get(object.object_key) as R2ObjectBody).size).toBeGreaterThan(28_000);
    await expect(putObjectBytes(test.env, { ...identity, kind: 'log', name: 'combined', sequence: 1, content_type: 'text/plain', retention_seconds: 3600 }, Buffer.from('late'))).rejects.toMatchObject({ code: 'attempt_closed' });
    await execute(test.env.DB, `UPDATE execution_objects SET expires_at='2000-01-01T00:00:00.000Z' WHERE attempt_id=?`, attempt.id);
    test.failDeletion(true);
    await expect(expireExecutionObjects(test.env)).rejects.toThrow();
    expect(await test.blobs.head(object.object_key)).not.toBeNull();
    test.failDeletion(false);
    await expireExecutionObjects(test.env);
    expect(await test.blobs.head(object.object_key)).toBeNull();
    expect(await one(test.env.DB, 'SELECT state FROM execution_objects WHERE id=?', object.id)).toEqual({ state: 'deleted' });
    const finished = (await one<RunRecord>(test.env.DB, 'SELECT * FROM workflow_runs WHERE id=?', record.id))!;
    const repeated = await rerun(test.env, test.env.DB, finished, ['test'], 'u_owner', 'rerun-a', 'rerun-a');
    expect((await many<JobRecord>(test.env.DB, 'SELECT * FROM workflow_jobs WHERE run_id=?', repeated.id)).filter(value => value.status === 'not_applicable')).toHaveLength(1);
    expect(repeated.plan_digest).toBe(finished.plan_digest);
  });

  it('makes checksummed output identities immutable and does not leak private run records through the API', async () => {
    const test = await fixture(), build = job('build');
    build.outputs = { bundle: { path: 'dist', retention_seconds: 3600, max_bytes: 64, kind: 'artifact' } };
    const record = await run(test, [build]), attempt = await liveAttempt(test, record);
    const identity = { attempt_id: attempt.id, generation: 1, plan_digest: attempt.plan_digest, runner_id: attempt.producer_id };
    const body = Buffer.from('verified artifact');
    const object = await putObjectBytes(test.env, { ...identity, kind: 'output', name: 'bundle', sequence: 0, final: true, content_type: 'application/octet-stream', retention_seconds: 3600 }, body);
    await expect(putObjectBytes(test.env, { ...identity, kind: 'output', name: 'bundle', sequence: 0, final: true, content_type: 'application/octet-stream', retention_seconds: 3600 }, Buffer.from('tampered'))).rejects.toMatchObject({ code: 'chunk_conflict' });
    await expect(putObjectBytes(test.env, { ...identity, kind: 'output', name: 'other', sequence: 0, final: true, content_type: 'application/octet-stream', retention_seconds: 3600 }, body)).rejects.toMatchObject({ code: 'undeclared_output' });
    await expect(completeObjectManifest(test.env, identity, 'bundle', 'output', 'f'.repeat(64))).rejects.toMatchObject({ code: 'output_checksum_mismatch' });
    const output = await completeObjectManifest(test.env, identity, 'bundle', 'output', await sha256(body));
    expect(await new Response(await streamManifest(test.env, output)).text()).toBe(body.toString());
    let principal: Principal = { id: 'u_other', kind: 'user', user_id: 'u_other', credential_id: null, capabilities: null, repository_ids: null, account_ids: null, mfa: false };
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => { c.set('principal', principal); c.set('requestId', 'req_test'); c.set('database', test.env.DB.withSession('first-primary')); await next(); });
    registerWorkflowsRoutes(app);
    expect((await app.fetch(new Request(`https://api.gitknot.com/v1/runs/${record.id}`), test.env, test.context)).status).toBe(404);
    principal = { ...principal, id: 'u_owner', user_id: 'u_owner' };
    const response = await app.fetch(new Request(`https://api.gitknot.com/v1/runs/${record.id}/attempts`), test.env, test.context);
    const text = await response.text();
    expect(response.status).toBe(200); expect(text).not.toContain('credential_hash'); expect(text).not.toContain(attempt.runtime_id);
    expect(await test.blobs.head(object.object_key)).not.toBeNull();
  });

  it('consumes runner enrollment once, prevents cross-tenant and persistent-untrusted matching, and rotates machine credentials atomically', async () => {
    const test = await fixture(), at = now();
    await execute(test.env.DB, `INSERT INTO runner_pools (id,account_id,repo_id,name,os,architecture,toolchains_json,trust,isolation,max_runners,max_slots,created_at,updated_at)
      VALUES ('pool_owner','u_owner','r_owner','linux','linux','amd64',?,'trusted','persistent',2,1,?,?)`, JSON.stringify([toolchain]), at, at);
    const pool = (await one<RunnerPool>(test.env.DB, 'SELECT * FROM runner_pools WHERE id=?', 'pool_owner'))!;
    const enrollment = await createEnrollment(test.env, pool, 'u_owner');
    const registration = { enrollment_token: enrollment.enrollment_token as string, exchange: createCredentialExchange(0), name: 'machine', capabilities: { os: 'linux' as const, arch: 'x64' as const, toolchains: { node: toolchain }, labels: [] }, slots: 1, disposable: false };
    const registered = await registerRunner(test.env, registration);
    expect(await registerRunner(test.env, registration)).toEqual(registered);
    await expect(registerRunner(test.env, { ...registration, exchange: createCredentialExchange(0) })).rejects.toMatchObject({ code: 'enrollment_invalid' });
    const runner = await authenticateRunner(test.env, String(registered.runner_id), String(registered.machine_token));
    const definition = { ...job('test'), executor: { type: 'self_hosted' as const, pool: pool.id }, producer_id: `pool:${pool.id}` };
    expect(runnerMatches(pool, runner, { account_id: 'u_owner', repo_id: 'r_owner', trust: 'trusted', job: definition })).toBeNull();
    expect(runnerMatches(pool, runner, { account_id: 'u_other', repo_id: 'r_other', trust: 'trusted', job: definition })).toBe('tenant_mismatch');
    expect(runnerMatches({ ...pool, trust: 'untrusted' }, runner, { account_id: 'u_owner', repo_id: 'r_owner', trust: 'untrusted', job: definition })).toBe('trust_mismatch');
    const exchange = createCredentialExchange(1);
    const rotation = await rotateRunner(test.env, runner.id, String(registered.machine_token), exchange);
    expect(await rotateRunner(test.env, runner.id, String(registered.machine_token), exchange)).toEqual(rotation);
    await expect(authenticateRunner(test.env, runner.id, String(registered.machine_token))).rejects.toMatchObject({ code: 'runner_revoked' });
    expect((await authenticateRunner(test.env, runner.id, String(rotation.machine_token))).credential_generation).toBe(2);
  });

  it('commits one-time enrollment issuance with the core request-recovery receipt without retaining its plaintext token', async () => {
    const test = await fixture(), at = now();
    await execute(test.env.DB, `INSERT INTO runner_pools (id,account_id,repo_id,name,os,architecture,toolchains_json,trust,isolation,max_runners,max_slots,created_at,updated_at)
      VALUES ('pool_owner','u_owner','r_owner','linux','linux','amd64',?,'trusted','persistent',2,1,?,?)`, JSON.stringify([toolchain]), at, at);
    const actor: Principal = { id: 'u_owner', kind: 'user', user_id: 'u_owner', credential_id: null, capabilities: null, repository_ids: null, account_ids: null, mfa: false };
    const app = api(test, actor);
    const request = () => new Request('https://api.gitknot.com/v1/runner-enrollments', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'one-enrollment' }, body: JSON.stringify({ pool_id: 'pool_owner' }) });
    const first = await app.fetch(request(), test.env, test.context);
    const value = await first.json() as { id: string; enrollment_token: string };
    expect(first.status).toBe(201);
    const replay = await app.fetch(request(), test.env, test.context);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ error: { code: 'one_time_value_already_issued' } });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM runner_enrollments')).toEqual({ count: 1 });
    const recovery = await one<{ resource_id: string; committed_at: string | null; response_body: string | null }>(test.env.DB, 'SELECT resource_id,committed_at,response_body FROM idempotency_keys WHERE principal_id=? AND key=?', actor.id, 'one-enrollment');
    expect(recovery).toMatchObject({ resource_id: value.id, committed_at: expect.any(String), response_body: null });
    expect(JSON.stringify(recovery)).not.toContain(value.enrollment_token);
  });

  it('accepts cleanup-only SDK termination after deadline and machine revocation, fences uploads, and never frees an unconfirmed disposable slot', async () => {
    const test = await fixture(), at = now();
    await execute(test.env.DB, `INSERT INTO runner_pools(id,account_id,repo_id,name,os,architecture,toolchains_json,trust,isolation,max_runners,max_slots,created_at,updated_at)
      VALUES ('pool_cleanup','u_owner','r_owner','cleanup','linux','amd64',?,'trusted','ephemeral',2,1,?,?)`, JSON.stringify([toolchain]), at, at);
    const pool = (await one<RunnerPool>(test.env.DB, `SELECT * FROM runner_pools WHERE id='pool_cleanup'`))!;
    const enrollment = await createEnrollment(test.env, pool, owner.id);
    const registration = await registerRunner(test.env, { enrollment_token: String(enrollment.enrollment_token), exchange: createCredentialExchange(0), name: 'cleanup',
      capabilities: { os: 'linux', arch: 'x64', toolchains: { node: toolchain }, labels: [] }, slots: 1, disposable: true });
    const runner = await authenticateRunner(test.env, String(registration.runner_id), String(registration.machine_token));
    const definition = { ...job('_job'), executor: { type: 'self_hosted' as const, pool: pool.id }, producer_id: `pool:${pool.id}` };
    const frozen = { ...plan([definition]), concurrency: { key: 'cleanup-queue', supersede: false } };
    const record = await createRun(test.env, test.env.DB, { workflow_id: 'wf_owner', plan: frozen, actor_id: owner.id, request_key: 'cleanup-first', request_hash: 'cleanup-first' });
    const attempt = await liveAttempt(test, record, undefined, runner);
    await execute(test.env.DB, `UPDATE execution_attempts SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?`, attempt.id);
    const originalLease = await attemptLeaseToken(test.env, (await attemptContext(test.env.DB, attempt.id)).attempt);
    await execute(test.env.DB, `UPDATE runners SET assignment_attempt_id=?,disposable_consumed_at=? WHERE id=?`, attempt.id, at, runner.id);
    await execute(test.env.DB, `INSERT INTO runner_slot_reservations(attempt_id,runner_id,repo_id,account_id,generation,fence,state,expires_at,assigned_at,created_at,updated_at)
      VALUES (?,?,'r_owner','u_owner',1,?,'leased','2000-01-01T00:00:00.000Z',?,?,?)`, attempt.id, runner.id, `legacy:${attempt.id}`, at, at, at);
    const app = api(test);
    const disabled = await app.fetch(new Request(`https://api.gitknot.com/v1/runners/${runner.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'if-match': `"${runner.revision}"` }, body: '{"state":"revoked"}' }), test.env, test.context);
    expect(disabled.status, await disabled.clone().text()).toBe(200);
    await test.machine(attempt.id).cancel(attempt.id, 'Runner deadline expired.', 'timed_out');
    expect(await one(test.env.DB, 'SELECT status,cleanup_state FROM execution_attempts WHERE id=?', attempt.id)).toEqual({ status: 'runner_unreachable', cleanup_state: 'unreachable' });
    expect(await one(test.env.DB, 'SELECT state FROM runner_slot_reservations WHERE attempt_id=?', attempt.id)).toEqual({ state: 'leased' });
    expect(test.settlements).toHaveLength(0);
    await advanceRun(test.env, record.id);
    const successor = await createRun(test.env, test.env.DB, { workflow_id: 'wf_owner', plan: frozen, actor_id: owner.id, request_key: 'cleanup-next', request_hash: 'cleanup-next' });
    await advanceRun(test.env, successor.id);
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM execution_attempts WHERE run_id=?', successor.id)).toEqual({ count: 0 });
    const auth = { runner_id: runner.id, generation: 1, lease_token: originalLease };
    const termination = { version: 1 as const, attempt_id: attempt.id, runner_id: runner.id, generation: 1, manifest_digest: (plan([definition]).portable_manifest as { digest: string }).digest,
      commit: oid, finished_at: now(), cleanup_confirmed: true as const };
    const body = { ...auth, termination, termination_digest: `sha256:${await sha256(canonicalJson(termination))}` };
    test.env.INTERNAL_SERVICE_KEY = 'rotated-control-plane-key-'.repeat(3);
    test.env.EXECUTOR = { fetch: (request: Request) => executionWorker.fetch(request, test.env) } as Fetcher;
    const post = (action: string, payload: object) => app.fetch(new Request(`https://api.gitknot.com/v1/attempts/${attempt.id}/${action}`, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer ${registration.machine_token}` }, body: JSON.stringify(payload) }), test.env, test.context);
    expect((await post('terminated', { ...body, generation: 2 })).status).toBe(401);
    const first = await post('terminated', body);
    expect(first.status, await first.clone().text()).toBe(200);
    expect((await post('terminated', body)).status).toBe(200);
    expect(await one(test.env.DB, 'SELECT cleanup_state,outcome_json FROM execution_attempts WHERE id=?', attempt.id)).toEqual({ cleanup_state: 'verified', outcome_json: null });
    expect(await one(test.env.DB, 'SELECT state FROM runner_slot_reservations WHERE attempt_id=?', attempt.id)).toEqual({ state: 'closed' });
    expect(test.settlements).toHaveLength(1);
    expect(test.settlements[0]).toMatchObject({ termination_proof: { kind: 'customer_process_exited' } });
    await advanceRun(test.env, successor.id);
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM execution_attempts WHERE run_id=?', successor.id)).toEqual({ count: 1 });
    const late = await post('logs', { ...auth, sequence: 0, data_base64: '', size_bytes: 0, digest: `sha256:${await sha256('')}` });
    expect([401, 403, 409]).toContain(late.status);
    expect(await one(test.env.DB, `SELECT COUNT(*) AS count FROM workflow_verifications WHERE run_id=? AND conclusion='succeeded'`, record.id)).toEqual({ count: 0 });
    const machineRead = await app.fetch(new Request(`https://api.gitknot.com/v1/runners/${runner.id}`), test.env, test.context);
    const publicMachine = await machineRead.text();
    expect(machineRead.status).toBe(200); expect(publicMachine).not.toContain(runner.credential_hash); expect(publicMachine).not.toContain(String(registration.machine_token));
  });

  it('accepts shared underscore job/step/output identifiers through the real receipt routes and acknowledges an already-completed stop after retirement', async () => {
    const test = await fixture(), at = now();
    await execute(test.env.DB, `INSERT INTO runner_pools(id,account_id,repo_id,name,os,architecture,toolchains_json,trust,isolation,max_runners,max_slots,created_at,updated_at)
      VALUES ('pool_wire','u_owner','r_owner','wire','linux','amd64',?,'trusted','persistent',2,1,?,?)`, JSON.stringify([toolchain]), at, at);
    const pool = (await one<RunnerPool>(test.env.DB, `SELECT * FROM runner_pools WHERE id='pool_wire'`))!;
    const enrollment = await createEnrollment(test.env, pool, owner.id);
    const registration = await registerRunner(test.env, { enrollment_token: String(enrollment.enrollment_token), exchange: createCredentialExchange(0), name: 'wire',
      capabilities: { os: 'linux', arch: 'x64', toolchains: { node: toolchain }, labels: [] }, slots: 1, disposable: false });
    const runner = await authenticateRunner(test.env, String(registration.runner_id), String(registration.machine_token));
    const definition: PlanJob = { ...job('_job'), executor: { type: 'self_hosted', pool: pool.id }, producer_id: `pool:${pool.id}`,
      steps: [{ ...job('_job').steps[0]!, id: '_step' }], outputs: { _result: { path: 'value.json', type: 'string', kind: 'value', retention_seconds: 3600, max_bytes: 1024 } } };
    const frozen = { ...plan([definition]), portable_manifest: { version: 1, digest: `sha256:${'d'.repeat(64)}`, jobs: [{ id: '_job', steps: [{ id: '_step' }] }] } };
    const record = await createRun(test.env, test.env.DB, { workflow_id: 'wf_owner', plan: frozen, actor_id: owner.id, request_key: 'underscore-wire', request_hash: 'underscore-wire' });
    const attempt = await liveAttempt(test, record, undefined, runner);
    const lease = await attemptLeaseToken(test.env, (await attemptContext(test.env.DB, attempt.id)).attempt);
    await execute(test.env.DB, `INSERT INTO runner_slot_reservations(attempt_id,runner_id,repo_id,account_id,generation,fence,state,expires_at,assigned_at,created_at,updated_at)
      VALUES (?,?,'r_owner','u_owner',1,?,'leased',?,?,?,?)`, attempt.id, runner.id, `legacy:${attempt.id}`, attempt.lease_expires_at, at, at, at);
    test.env.EXECUTOR = { fetch: (request: Request) => executionWorker.fetch(request, test.env) } as Fetcher;
    const app = api(test), auth = { runner_id: runner.id, generation: 1, lease_token: lease };
    const post = (action: string, payload: object) => app.fetch(new Request(`https://api.gitknot.com/v1/attempts/${attempt.id}/${action}`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${registration.machine_token}` }, body: JSON.stringify({ ...auth, ...payload }) }), test.env, test.context);
    const logDigest = `sha256:${await sha256('')}`, data = Buffer.from('"verified"'), outputDigest = `sha256:${await sha256(data)}`;
    const logged = await post('logs', { sequence: 0, size_bytes: 0, digest: logDigest, data_base64: '' });
    expect(logged.status, await logged.clone().text()).toBe(200);
    const uploaded = await post('outputs', { name: '_result', kind: 'value', sequence: 0, size_bytes: data.length, digest: outputDigest,
      data_base64: data.toString('base64'), final: true, media_type: 'application/json', retention_seconds: 3600 });
    expect(uploaded.status, await uploaded.clone().text()).toBe(200);
    const receipt = { version: 1, attempt_id: attempt.id, run_id: record.id, job_id: '_job', runner_id: runner.id, generation: 1, manifest_digest: frozen.portable_manifest.digest,
      commit: oid, toolchain_fingerprint: toolchain, outcome: 'passed', started_at: attempt.started_at, finished_at: now(), exit_code: 0, signal: null, reason: '',
      logs: [{ sequence: 0, digest: logDigest, size_bytes: 0 }], outputs: [{ name: '_result', kind: 'value', digest: outputDigest, size_bytes: data.length, chunks: [{ sequence: 0, digest: outputDigest, size_bytes: data.length }] }],
      steps: [{ id: '_step', outcome: 'passed', exit_code: 0, signal: null }], cleanup_confirmed: true };
    const finished = await post('complete', { receipt, receipt_digest: `sha256:${await sha256(canonicalJson(receipt))}` });
    expect(finished.status, await finished.clone().text()).toBe(200);
    const accepted = await one<{ receipt_hash: string; outcome_json: string }>(test.env.DB, 'SELECT receipt_hash,outcome_json FROM execution_attempts WHERE id=?', attempt.id);
    const retired = await app.fetch(new Request(`https://api.gitknot.com/v1/runners/${runner.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'if-match': `"${runner.revision}"` }, body: '{"state":"revoked"}' }), test.env, test.context);
    expect(retired.status, await retired.clone().text()).toBe(200);
    const termination = { version: 1, attempt_id: attempt.id, runner_id: runner.id, generation: 1, manifest_digest: frozen.portable_manifest.digest, commit: oid, finished_at: now(), cleanup_confirmed: true };
    const acknowledged = await post('terminated', { termination, termination_digest: `sha256:${await sha256(canonicalJson(termination))}` });
    expect(acknowledged.status, await acknowledged.clone().text()).toBe(200);
    expect(await one(test.env.DB, 'SELECT receipt_hash,outcome_json FROM execution_attempts WHERE id=?', attempt.id)).toEqual(accepted);
    expect(test.settlements).toHaveLength(1);
  });

  it('serializes approved releases, promotes the identical digest, and invalidates approval when the accepted target changes', async () => {
    const test = await fixture(), definition = job('build');
    definition.outputs = { bundle: { path: 'dist', retention_seconds: 3600, max_bytes: 1024, kind: 'artifact' } };
    const record = await run(test, [definition]), attempt = await liveAttempt(test, record);
    const identity = { attempt_id: attempt.id, generation: 1, plan_digest: attempt.plan_digest, runner_id: attempt.producer_id };
    const data = Buffer.from('the exact verified release artifact');
    await putObjectBytes(test.env, { ...identity, kind: 'output', name: 'bundle', sequence: 0, final: true, content_type: 'application/octet-stream', retention_seconds: 3600 }, data);
    const artifact = await completeObjectManifest(test.env, identity, 'bundle', 'output', await sha256(data));
    const logs = await completeObjectManifest(test.env, identity, 'logs', 'logs');
    await recordDestruction(test, attempt);
    await test.machine(attempt.id).complete(attempt.id, { ...identity, conclusion: 'succeeded', exit_code: 0, signal: null, resource_exhaustion: null,
      toolchain_digest: toolchain, outputs: [{ name: 'bundle', sha256: artifact.source_digest!, size_bytes: data.length }], log_manifest_digest: logs.sha256,
      process_group_stopped: true, started_at: attempt.started_at!, finished_at: now() });
    await advanceRun(test.env, record.id);
    const finished = (await one<RunRecord>(test.env.DB, 'SELECT * FROM workflow_runs WHERE id=?', record.id))!;
    await execute(test.env.DB, `INSERT INTO workflow_environments (id,repo_id,account_id,name,destination,target_ref,required_approvals,allow_self_approval,allowed_approvers_json,created_at,updated_at)
      VALUES ('env_production','r_owner','u_owner','production','release:production','refs/heads/main',1,1,'[]',?,?)`, now(), now());
    const environment = (await one<EnvironmentRecord>(test.env.DB, 'SELECT * FROM workflow_environments WHERE id=?', 'env_production'))!;
    let acceptedCommit = oid, held = false;
    test.env.GIT_SERVICE = { fetch: async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/barrier')) { held = request.method !== 'DELETE'; return Response.json({ held }); }
      if (!path.endsWith('/collaboration/inspect') || !held) throw new Error('Target verification must hold the Git publication barrier.');
      return Response.json({ repo_id: 'r_owner', commit_oid: acceptedCommit });
    } } as unknown as Fetcher;
    const first = await createPromotion(test.env.DB, finished, environment, artifact, 'u_owner', 'release-first', 'release-first');
    const second = await createPromotion(test.env.DB, finished, environment, artifact, 'u_owner', 'release-second', 'release-second');
    expect(second.enqueue_sequence).toBeGreaterThan(first.enqueue_sequence);
    await decidePromotion(test.env, test.env.DB, first, 'u_owner', 'approved');
    await decidePromotion(test.env, test.env.DB, second, 'u_owner', 'approved');
    expect(await promoteArtifact(test.env, second.id)).toEqual({ released: false });
    expect(await promoteArtifact(test.env, first.id)).toMatchObject({ released: true });
    const released = await one<{ artifact_id: string; artifact_digest: string; commit_sha: string; plan_digest: string }>(test.env.DB, 'SELECT artifact_id,artifact_digest,commit_sha,plan_digest FROM workflow_releases WHERE promotion_id=?', first.id);
    expect(released).toEqual({ artifact_id: artifact.id, artifact_digest: await sha256(data), commit_sha: oid, plan_digest: finished.plan_digest });
    acceptedCommit = 'e'.repeat(40);
    await expect(promoteArtifact(test.env, second.id)).rejects.toMatchObject({ code: 'approval_invalidated' });
    expect(await one(test.env.DB, 'SELECT status FROM workflow_promotions WHERE id=?', second.id)).toEqual({ status: 'invalidated' });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM workflow_releases')).toEqual({ count: 1 });
    expect(held).toBe(false);
    expect(test.executorCalls()).toBe(0);
  });

  it('retains the actual MFA approver credential in the vault authority view and blocks release after that credential is revoked', async () => {
    const test = await fixture(), at = now();
    const issue = () => prepareCredential(test.env.DB, { principal_id: owner.id, user_id: owner.user_id, kind: 'personal', name: 'MFA release evidence',
      capabilities: ['*'], repository_ids: null, account_ids: null, auth_revision: 1, mfa: true, authenticated_at: at, expires_at: new Date(Date.now() + 600_000).toISOString(), created_by: owner.id });
    const requester = await issue(), approver = await issue();
    await test.db.batch([requester.statement, approver.statement,
      stmt(test.env.DB, `INSERT INTO account_policies(account_id,config_json,updated_by,updated_at) VALUES ('u_owner','{"require_mfa":true}','u_owner',?)`, at)]);
    const definition = job('build'); definition.outputs = { bundle: { path: 'dist', retention_seconds: 3600, max_bytes: 1024, kind: 'artifact' } };
    const frozen = { ...plan([definition]), actor: { ...plan([definition]).actor, credential_id: requester.credential.id } };
    const record = await createRun(test.env, test.env.DB, { workflow_id: 'wf_owner', plan: frozen, actor_id: owner.id, request_key: 'mfa-release', request_hash: 'mfa-release' });
    const attempt = await liveAttempt(test, record), identity = { attempt_id: attempt.id, generation: 1, plan_digest: attempt.plan_digest, runner_id: attempt.producer_id };
    const bytes = Buffer.from('approved exact artifact');
    await putObjectBytes(test.env, { ...identity, kind: 'output', name: 'bundle', sequence: 0, final: true, content_type: 'application/octet-stream', retention_seconds: 3600 }, bytes);
    const artifact = await completeObjectManifest(test.env, identity, 'bundle', 'output', await sha256(bytes)), logs = await completeObjectManifest(test.env, identity, 'logs', 'logs');
    await recordDestruction(test, attempt);
    await test.machine(attempt.id).complete(attempt.id, { ...identity, conclusion: 'succeeded', exit_code: 0, signal: null, resource_exhaustion: null, toolchain_digest: toolchain,
      outputs: [{ name: 'bundle', sha256: artifact.source_digest!, size_bytes: bytes.length }], log_manifest_digest: logs.sha256, process_group_stopped: true, started_at: attempt.started_at!, finished_at: now() });
    await execute(test.env.DB, `INSERT INTO workflow_environments(id,repo_id,account_id,name,destination,target_ref,required_approvals,allow_self_approval,allowed_approvers_json,created_at,updated_at)
      VALUES ('env_mfa','r_owner','u_owner','mfa','release:mfa','refs/heads/main',1,1,'[]',?,?)`, at, at);
    const environment = (await one<EnvironmentRecord>(test.env.DB, `SELECT * FROM workflow_environments WHERE id='env_mfa'`))!;
    const promotion = await createPromotion(test.env.DB, record, environment, artifact, owner.id, 'mfa-promotion', 'mfa-promotion', attempt.job_id);
    test.env.GIT_SERVICE = { fetch: async () => Response.json({ repo_id: 'r_owner', commit_oid: oid, held: true }), connect() { throw new Error('This fixture exposes HTTP only.'); } };
    await expect(decidePromotion(test.env, test.env.DB, promotion, owner.id, 'approved')).rejects.toMatchObject({ code: 'approver_revoked' });
    const authority = await repositoryExecutionContext(test.env, { ...owner, credential_id: approver.credential.id, mfa: true }, 'r_owner');
    await decidePromotion(test.env, test.env.DB, promotion, owner.id, 'approved', authority);
    expect(await one(test.env.DB, 'SELECT approver_id,approver_credential_id,approver_mfa FROM secret_environment_authorizations WHERE attempt_id=?', attempt.id)).toEqual({ approver_id: owner.id, approver_credential_id: approver.credential.id, approver_mfa: 1 });
    await execute(test.env.DB, 'UPDATE credentials SET revoked_at=?,revision=revision+1 WHERE id=?', now(), approver.credential.id);
    await expect(promoteArtifact(test.env, promotion.id)).rejects.toMatchObject({ code: 'approval_invalidated' });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM workflow_releases')).toEqual({ count: 0 });
    expect(test.executorCalls()).toBe(0);
  });

  it('derives deterministic checkout and reproduction credentials from the real issuer and preserves existing federation assurance atomically', async () => {
    const test = await fixture(), at = now(), expires = new Date(Date.now() + 600_000).toISOString();
    const source = await prepareCredential(test.env.DB, { principal_id: owner.id, user_id: owner.user_id, kind: 'personal', name: 'Federated issuer',
      capabilities: ['*'], repository_ids: ['r_owner'], account_ids: ['org_execution'], auth_revision: 1, mfa: true, authenticated_at: at, expires_at: expires, created_by: owner.id });
    const provider = { protocol: 'oidc', issuer: 'https://idp.example.net', authorization_endpoint: 'https://idp.example.net/authorize', token_endpoint: 'https://idp.example.net/token',
      jwks_uri: 'https://idp.example.net/jwks', client_id: 'execution-fixture', tenant_claim: 'tid', tenant_values: ['fixture'], external_id_claim: 'oid',
      mappings: { capability_ceiling: ['*'], default_role_id: 'reader', role_ceiling: ['reader'] } };
    await test.db.batch([
      stmt(test.env.DB, 'UPDATE users SET password_hash=? WHERE id=?', await hashPassword('independent-execution-fixture-recovery-password'), owner.id),
      stmt(test.env.DB, `INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES ('org_execution','organization','execution','Execution','u_owner',?,?)`, at, at),
      stmt(test.env.DB, `INSERT INTO memberships(account_id,principal_id,role_id,state,created_by,created_at,updated_at) VALUES ('org_execution','u_owner','owner','active','u_owner',?,?)`, at, at),
      stmt(test.env.DB, `UPDATE repositories SET owner_id='org_execution' WHERE id='r_owner'`),
      stmt(test.env.DB, `INSERT INTO workflows(id,repo_id,account_id,name,path,current_version_id,created_by,created_at,updated_at) VALUES ('wf_federated','r_owner','org_execution','federated','.gitknot/workflows/federated.yaml','wfv_federated','u_owner',?,?)`, at, at),
      stmt(test.env.DB, `INSERT INTO workflow_versions(id,workflow_id,repo_id,account_id,source_commit,definition_digest,definition,definition_json,policy_revision,approved_by,created_at)
        VALUES ('wfv_federated','wf_federated','r_owner','org_execution',?,?,'fixture','{}',1,'u_owner',?)`, oid, 'c'.repeat(64), at),
      source.statement,
      stmt(test.env.DB, `INSERT INTO federation_providers(id,account_id,name,protocol,config_json,enabled,created_by,created_at,updated_at) VALUES ('idp_execution','org_execution','Fixture','oidc',?,1,'u_owner',?,?)`, JSON.stringify(provider), at, at),
      stmt(test.env.DB, `INSERT INTO federation_subjects(id,account_id,provider_id,issuer,subject,tenant,user_id,state,created_at,updated_at)
        VALUES ('subject_execution','org_execution','idp_execution','https://idp.example.net','immutable-subject','fixture','u_owner','active',?,?)`, at, at),
      stmt(test.env.DB, `INSERT INTO federation_org_policies(account_id,config_json,updated_by,updated_at) VALUES ('org_execution','{"required":true}','u_owner',?)`, at),
      stmt(test.env.DB, `INSERT INTO federation_session_grants(account_id,credential_id,provider_id,provider_revision,policy_revision,subject_id,user_id,authenticated_at,mfa,expires_at)
        VALUES ('org_execution',?,'idp_execution',1,1,'subject_execution','u_owner',?,1,?)`, source.credential.id, at, expires),
    ]);
    const frozen: ExecutionPlan = { ...plan([job('test')]), account_id: 'org_execution', workflow_version_id: 'wfv_federated', actor: { ...plan([job('test')]).actor, credential_id: source.credential.id } };
    const record = await createRun(test.env, test.env.DB, { workflow_id: 'wf_federated', plan: frozen, actor_id: owner.id, request_key: 'federated-checkout', request_hash: 'federated-checkout' });
    const attempt = await liveAttempt(test, record), context = await attemptContext(test.env.DB, attempt.id);
    const checkout = await checkoutCapability(test.env, context);
    expect(await checkoutCapability(test.env, context)).toEqual(checkout);
    const actor = { ...owner, credential_id: source.credential.id, account_ids: ['org_execution'], repository_ids: ['r_owner'], mfa: true };
    const reproduction = await reproduceRun(await repositoryExecutionContext(test.env, actor, 'r_owner'), record, 'test');
    const reproductionToken = (reproduction.source as { token: string }).token;
    const credentials = await many<{ id: string; user_id: string; parent_id: string; auth_revision: number; mfa: number; authenticated_at: string }>(test.env.DB,
      'SELECT id,user_id,parent_id,auth_revision,mfa,authenticated_at FROM credentials WHERE token_hash IN (?,?)', await sha256(checkout.token), await sha256(reproductionToken));
    expect(credentials).toHaveLength(2);
    for (const credential of credentials) {
      expect(credential).toMatchObject({ user_id: owner.user_id, parent_id: source.credential.id, auth_revision: 1, mfa: 1, authenticated_at: at });
      expect(await one(test.env.DB, 'SELECT user_id,subject_id,authenticated_at,mfa FROM federation_session_grants WHERE credential_id=?', credential.id)).toEqual({ user_id: owner.user_id, subject_id: 'subject_execution', authenticated_at: at, mfa: 1 });
    }
    await execute(test.env.DB, `UPDATE federation_providers SET enabled=0,revision=revision+1 WHERE id='idp_execution'`);
    await expect(checkoutCapability(test.env, context)).rejects.toBeInstanceOf(ApiError);
    await expect(reproduceRun(await repositoryExecutionContext(test.env, actor, 'r_owner'), record, 'test')).rejects.toBeInstanceOf(ApiError);
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM credentials')).toEqual({ count: 3 });
  });
});
