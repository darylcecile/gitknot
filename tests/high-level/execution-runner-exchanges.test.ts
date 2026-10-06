import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, database, execute, handleRoutingRpc, many, mutationStatements, now, one, registerResourceLocator, sha256, signInternalRequest, stmt, withAccountAuthorityBarrier } from '../../packages/core/src/index.ts';
import type { AppContext, Bindings, Database, Principal } from '../../packages/core/src/index.ts';
import { createCredentialExchange, deriveRunnerCredential } from '../../packages/runner/src/credential-exchange.ts';
import { authenticateRunner, createEnrollment, registerRunner, rotateRunner, updateRunnerCapabilities } from '../../packages/execution/src/runner-service.ts';
import { authorizeRunnerPool, bindRunnerAuthority, loadRunnerAuthority, readRunnerRecord, reconcileRunnerAuthorityChanges, runnerIdentityContext, runnerPrincipal, withRunnerAuthorityChange } from '../../packages/execution/src/runner-authority.ts';
import { handleRunnerMetadataRequest, runnerResourcePlacement, selectRunnerMetadata } from '../../packages/execution/src/runner-placement.ts';
import { activateRunnerSlot, activeRunnerSlots, closeRunnerSlot, offerRunnerJob, reserveRunnerSlot } from '../../packages/execution/src/runner-slots.ts';
import type { RunnerSlot } from '../../packages/execution/src/runner-slots.ts';
import { repositoryExecutionContext } from '../../packages/execution/src/authorization.ts';
import type { AttemptRecord, RunnerPool, RunnerRecord } from '../../packages/execution/src/types.ts';
import { createTestDatabase } from '../support/database.ts';
import type { SqliteD1 } from '../support/database.ts';
import { createTestEnvironment } from '../support/environment.ts';

const opened: Array<{ close(): void }> = [];
afterEach(() => { for (const fixture of opened.splice(0).reverse()) fixture.close(); });
const fingerprint = `sha256:${'a'.repeat(64)}`, commit = 'b'.repeat(40);
const capabilities = { os: 'linux' as const, arch: 'x64' as const, toolchains: { node: fingerprint }, labels: [] };
const owner: Principal = { id: 'u_owner', kind: 'user', user_id: 'u_owner', credential_id: null, capabilities: null, repository_ids: null, account_ids: null, mfa: false };
const receiver: Principal = { ...owner, id: 'u_receiver', user_id: 'u_receiver' };

async function identities(db: Database): Promise<void> {
  for (const id of [owner.id, receiver.id]) {
    const name = id.slice(2), at = now();
    await db.batch([
      stmt(db, 'INSERT INTO users(id,username,email,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?)', id, name, `${name}@example.net`, at, at, at),
      stmt(db, "INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES (?,'user',?,?,?,?,?)", id, name, name, id, at, at),
      stmt(db, "INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES (?,'user',?,?,?,?,?,?)", id, id, id, name, id, at, at),
    ]);
  }
}

async function repository(db: Database, id: string, cell: string, shard: string, epoch: number): Promise<void> {
  await execute(db, `INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,routing_epoch,storage_name,created_by,created_at,updated_at)
    VALUES (?,'u_owner',?,?,'private','active',?,?,?,?,'u_owner',?,?)`, id, id, id, cell, shard, epoch, `storage_${id}`, now(), now());
}

function alias(db: SqliteD1): D1Database {
  const binding = new Proxy(db.binding(), { get(target, key) {
    if (key === 'withSession') return () => binding as unknown as D1DatabaseSession;
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return binding;
}

function failBatch(db: SqliteD1, match: RegExp, point: 'before' | 'after'): () => void {
  const original = db.batch.bind(db);
  let armed = true;
  db.batch = async statements => {
    if (armed && statements.some(statement => match.test((statement as unknown as { sql: string }).sql))) {
      armed = false;
      if (point === 'after') await original(statements);
      throw new Error(`Injected ${point}-commit acknowledgement loss.`);
    }
    return original(statements);
  };
  return () => { db.batch = original; };
}

type Placement = 'colocated' | 'identity' | 'repository' | 'cell';
async function fixture(mode: Placement, scoped = true) {
  const test = await createTestEnvironment(); opened.push(test);
  await identities(test.env.DB);
  await repository(test.env.DB, 'r_metadata', 'local', 'core', 1);
  const metadata = mode === 'colocated' ? test.db : await createTestDatabase();
  if (metadata !== test.db) { opened.push(metadata); await identities(metadata.binding()); }
  const cell = mode === 'cell' ? 'peer' : 'local', shard = mode === 'cell' || mode === 'colocated' ? 'core' : 'metadata';
  if (mode !== 'colocated') await repository(metadata.binding(), 'r_metadata', cell, shard, 2);
  test.env.DB = alias(test.db);
  test.env.IDENTITY_DB = alias(test.db); test.env.IDENTITY_CELL_ID = 'local'; test.env.IDENTITY_SHARD_ID = 'core';
  test.env.METADATA = metadata.binding();
  if (mode !== 'cell' && mode !== 'colocated') test.env.SHARD_BINDINGS_JSON = JSON.stringify({ core: 'DB', metadata: 'METADATA' });
  await execute(test.env.DB, `INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,epoch,state,updated_at)
    VALUES ('r_metadata','repository',?,?,?,'active',?)`, cell, shard, mode === 'colocated' ? 1 : 2, now());
  const received: Array<Record<string, unknown>> = [];
  let loseProjectionAck = false;
  async function serve(request: Request, env: Bindings): Promise<Response> {
    try {
      return await handleRoutingRpc(request, env) ?? await handleRunnerMetadataRequest(request, env) ?? new Response(null, { status: 404 });
    } catch (error) {
      return Response.json({ error: { code: error instanceof ApiError ? error.code : 'fixture_failure' } }, { status: error instanceof ApiError ? error.status : 503 });
    }
  }
  if (mode === 'cell') {
    const peer: Bindings = { ...test.env, DB: metadata.binding(), CELL_ID: 'peer', SHARD_ID: 'core', SHARD_BINDINGS_JSON: '{}', CELL_BINDINGS_JSON: JSON.stringify({ local: 'ORIGIN_API' }) };
    peer.ORIGIN_API = { fetch: (request: Request) => serve(request, test.env) } as Fetcher;
    test.env.CELL_BINDINGS_JSON = JSON.stringify({ peer: 'PEER_API' });
    test.env.PEER_API = { fetch: async (request: Request) => {
      let command: Record<string, unknown> | null = null;
      if (new URL(request.url).pathname === '/internal/execution/runners/metadata') {
        command = await request.clone().json() as Record<string, unknown>; received.push(command);
      }
      const result = await serve(request, peer);
      if (loseProjectionAck && command?.action === 'project' && result.ok) { loseProjectionAck = false; throw new Error('Injected lost cross-cell projection receipt.'); }
      return result;
    } } as Fetcher;
  }
  const poolDb = mode === 'repository' || mode === 'cell' ? metadata : test.db;
  const pool: RunnerPool = { id: 'pool_fixture', account_id: owner.id, repo_id: scoped ? 'r_metadata' : null, name: 'fixture', os: 'linux', architecture: 'amd64',
    toolchains_json: JSON.stringify([fingerprint]), trust: 'trusted', isolation: 'ephemeral', max_runners: 10, max_slots: 1, state: 'active', revision: 1, created_at: now(), updated_at: now() };
  await execute(poolDb.binding(), `INSERT INTO runner_pools(id,account_id,repo_id,name,os,architecture,toolchains_json,trust,isolation,max_runners,max_slots,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, pool.id, pool.account_id, pool.repo_id, pool.name, pool.os, pool.architecture, pool.toolchains_json, pool.trust, pool.isolation, pool.max_runners, pool.max_slots, pool.created_at, pool.updated_at);
  await registerResourceLocator(test.env, { resource_id: pool.id, resource_type: 'runner_pool', repo_id: poolDb === test.db ? pool.repo_id : 'r_metadata', authority: poolDb === test.db ? 'identity' : 'repository' });
  return { ...test, metadata, poolDb, pool, received, loseProjectionAck: () => { loseProjectionAck = true; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function manager(test: Fixture, actor = owner): Promise<AppContext> {
  const context = runnerIdentityContext(test.env, actor);
  await selectRunnerMetadata(context, await runnerResourcePlacement(test.env, test.pool.id, 'runner_pool'));
  return context;
}

async function enrollment(test: Fixture, name = 'machine', disposable = false) {
  const issued = await createEnrollment(test.env, test.pool, owner.id);
  return { enrollment_token: String(issued.enrollment_token), exchange: createCredentialExchange(0), name, capabilities, slots: 1, disposable };
}

async function copyRow(source: Database, target: Database, table: 'runner_pools' | 'runners', id: string): Promise<void> {
  const row = (await one<Record<string, unknown>>(source, `SELECT * FROM ${table} WHERE id=?`, id))!, columns = Object.keys(row);
  await execute(target, `INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...Object.values(row));
}

async function attempt(test: Fixture, suffix: string, db = test.metadata, repoId = 'r_metadata'): Promise<AttemptRecord> {
  const at = now(), id = `att_${suffix}`, runId = `run_${suffix}`, jobId = `job_${suffix}`;
  await registerResourceLocator(test.env, { resource_id: id, resource_type: 'attempt', repo_id: repoId, authority: 'repository' });
  await db.batch([
    stmt(db.binding(), `INSERT INTO workflows(id,repo_id,account_id,name,path,current_version_id,created_by,created_at,updated_at) VALUES (?,?,'u_owner',?,?,?,'u_owner',?,?)`,
      `wf_${suffix}`, repoId, suffix, `.gitknot/workflows/${suffix}.yaml`, `wfv_${suffix}`, at, at),
    stmt(db.binding(), `INSERT INTO workflow_versions(id,workflow_id,repo_id,account_id,source_commit,definition_digest,definition,definition_json,policy_revision,approved_by,created_at)
      VALUES (?,?,?,'u_owner',?,?,'fixture','{}',1,'u_owner',?)`, `wfv_${suffix}`, `wf_${suffix}`, repoId, commit, 'c'.repeat(64), at),
    stmt(db.binding(), `INSERT INTO workflow_runs(id,repo_id,account_id,workflow_id,workflow_version_id,commit_sha,source_ref,workflow_digest,plan_digest,plan_json,policy_revision,trigger_type,trigger_id,trust,status,requested_by,request_key,request_hash,created_at,updated_at)
      VALUES (?,?,'u_owner',?,?,?,'refs/heads/main',?,?,'{}',1,'workflow.dispatch',?,'trusted','running','u_owner',?,?,?,?)`,
    runId, repoId, `wf_${suffix}`, `wfv_${suffix}`, commit, 'c'.repeat(64), 'd'.repeat(64), suffix, suffix, suffix, at, at),
    stmt(db.binding(), `INSERT INTO workflow_jobs(id,repo_id,account_id,run_id,job_key,definition_json,status,generation,current_attempt_id,created_at,updated_at)
      VALUES (?,?,'u_owner',?,'test','{}','admitting',1,?,?,?)`, jobId, repoId, runId, id, at, at),
    stmt(db.binding(), `INSERT INTO execution_attempts(id,repo_id,account_id,run_id,job_id,generation,plan_digest,toolchain_digest,producer_id,executor,pool_id,status,queue_deadline_at,created_at,updated_at)
      VALUES (?,?,'u_owner',?,?,1,?,?,?,'self_hosted',?,'accepted',?,?,?)`, id, repoId, runId, jobId, 'd'.repeat(64), fingerprint, `pool:${test.pool.id}`, test.pool.id,
    new Date(Date.now() + 600_000).toISOString(), at, at),
  ]);
  return (await one<AttemptRecord>(db.binding(), 'SELECT * FROM execution_attempts WHERE id=?', id))!;
}

async function activate(test: Fixture, current: AttemptRecord, runner: RunnerRecord, slot: RunnerSlot, db = test.metadata): Promise<void> {
  await execute(db.binding(), `UPDATE execution_attempts SET status='admitting',runner_id=?,runner_credential_generation=?,runner_credential_hash=?,runner_slot_fence=?,runtime_id=?,cleanup_state='required' WHERE id=?`,
    runner.id, runner.credential_generation, runner.credential_hash, slot.fence, `${runner.id}:${current.id}`, current.id);
  await activateRunnerSlot(test.env, current, runner, slot, new Date(Date.now() + 90_000).toISOString());
}

async function cleanup(db: Database, id: string): Promise<void> {
  await execute(db, `UPDATE execution_attempts SET status='cancelled',cleanup_state='verified',destruction_verified_at=?,receipt_hash=?,credential_hash=NULL WHERE id=?`,
    now(), await sha256(`verified-process-stop:${id}`), id);
}

describe('recoverable runner credentials and global admission on actual metadata placements', () => {
  it('uses one physical transaction through distinct binding aliases, recovers lost commits, and rejects independent source changes', async () => {
    const test = await fixture('colocated'), input = await enrollment(test);
    const restore = failBatch(test.db, /INSERT INTO runners\(/, 'before');
    await expect(registerRunner(test.env, input)).rejects.toThrow('Injected'); restore();
    expect(await one(test.env.DB, 'SELECT state FROM runner_credential_exchanges WHERE id=?', input.exchange.id)).toEqual({ state: 'pending' });
    expect(await one(test.env.DB, "SELECT COUNT(*) AS count FROM credentials WHERE kind='runner'")).toEqual({ count: 0 });
    expect(await one(test.env.DB, 'SELECT consumed_at FROM runner_enrollments')).toEqual({ consumed_at: null });
    const registered = await registerRunner(test.env, input), runner = await authenticateRunner(test.env, String(registered.runner_id), String(registered.machine_token));
    expect(await registerRunner(test.env, input)).toEqual(registered);
    const { enrollment_token, exchange, ...request } = input;
    expect(registered.machine_token).toBe(await deriveRunnerCredential(enrollment_token, { api_origin: test.env.API_ORIGIN, operation: 'register', subject: 'enrollment', request, exchange }));
    await expect(registerRunner(test.env, { ...input, name: 'changed' })).rejects.toMatchObject({ code: 'credential_recovery_denied' });
    await expect(registerRunner(test.env, { ...input, exchange: { ...input.exchange, nonce: createCredentialExchange(0).nonce } })).rejects.toMatchObject({ code: 'credential_recovery_denied' });
    const rotation = createCredentialExchange(1), restoreLost = failBatch(test.db, /UPDATE runner_credential_exchanges SET state='committed'/, 'after');
    const rotated = await rotateRunner(test.env, runner.id, String(registered.machine_token), rotation); restoreLost();
    expect(await rotateRunner(test.env, runner.id, String(registered.machine_token), rotation)).toEqual(rotated);
    await expect(authenticateRunner(test.env, runner.id, String(registered.machine_token))).rejects.toMatchObject({ code: 'runner_revoked' });
    expect((await authenticateRunner(test.env, runner.id, String(rotated.machine_token))).credential_generation).toBe(2);
    const source = (await one<{ id: string }>(test.env.DB, 'SELECT id FROM credentials WHERE token_hash=?', runner.credential_hash))!;
    await withAccountAuthorityBarrier(runnerIdentityContext(test.env), owner.id, 'independent-revocation', () => execute(test.env.DB, 'UPDATE credentials SET revision=revision+1 WHERE id=?', source.id));
    await expect(rotateRunner(test.env, runner.id, String(registered.machine_token), rotation)).rejects.toMatchObject({ code: 'credential_recovery_denied' });
    expect((await authenticateRunner(test.env, runner.id, String(rotated.machine_token))).credential_generation).toBe(2);
    const journals = JSON.stringify(await many(test.env.DB, 'SELECT * FROM runner_credential_exchanges'));
    for (const secret of [input.enrollment_token, input.exchange.nonce, rotation.nonce, registered.machine_token, rotated.machine_token]) expect(journals).not.toContain(secret);
    await expect(execute(test.env.DB, "UPDATE runner_credential_exchanges SET request_hash='changed' WHERE id=?", input.exchange.id)).rejects.toThrow('immutable');
    expect(await one(test.env.DB, "SELECT COUNT(*) AS count FROM outbox WHERE type='runner.registered'")).toEqual({ count: 1 });
    expect(await one(test.env.DB, "SELECT COUNT(*) AS count FROM outbox WHERE type='runner.credential.rotated'")).toEqual({ count: 1 });
  });

  it.each(['before', 'after'] as const)('recovers a repository metadata projection lost %s its commit without using identity runner replicas', async point => {
    const test = await fixture('repository'), input = await enrollment(test);
    expect(await one(test.env.DB, 'SELECT id FROM runner_enrollments')).toBeNull();
    const restore = failBatch(test.metadata, /INSERT INTO runner_exchange_projections/, point);
    await expect(registerRunner(test.env, input)).rejects.toThrow('Injected'); restore();
    expect(await one(test.env.DB, "SELECT COUNT(*) AS count FROM credentials WHERE kind='runner'")).toEqual({ count: 0 });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM runner_credential_exchange_locks')).toEqual({ count: 1 });
    expect(await one(test.metadata.binding(), 'SELECT COUNT(*) AS count FROM runner_exchange_projections')).toEqual({ count: point === 'after' ? 1 : 0 });
    const registered = await registerRunner(test.env, input), runner = await authenticateRunner(test.env, String(registered.runner_id), String(registered.machine_token));
    expect(await one(test.env.DB, 'SELECT id FROM runners')).toBeNull();
    expect(await one(test.env.DB, 'SELECT authority,repo_id FROM resource_locators WHERE resource_id=?', runner.id)).toEqual({ authority: 'repository', repo_id: 'r_metadata' });
    await copyRow(test.metadata.binding(), test.env.DB, 'runner_pools', test.pool.id);
    await copyRow(test.metadata.binding(), test.env.DB, 'runners', runner.id);
    const rotation = createCredentialExchange(1), failedIdentity = failBatch(test.db, /INSERT INTO credentials /, 'before');
    await expect(rotateRunner(test.env, runner.id, String(registered.machine_token), rotation)).rejects.toThrow('Injected'); failedIdentity();
    expect(await one(test.metadata.binding(), 'SELECT credential_generation FROM runners WHERE id=?', runner.id)).toEqual({ credential_generation: 2 });
    expect(await one(test.env.DB, 'SELECT credential_generation FROM runners WHERE id=?', runner.id)).toEqual({ credential_generation: 1 });
    await expect(loadRunnerAuthority(test.env, runner.id)).rejects.toMatchObject({ code: 'runner_revoked' });
    const rotated = await rotateRunner(test.env, runner.id, String(registered.machine_token), rotation);
    expect((await loadRunnerAuthority(test.env, runner.id)).credential.token_hash).toBe(await sha256(String(rotated.machine_token)));
    await withAccountAuthorityBarrier(runnerIdentityContext(test.env), owner.id, 'stale-replica-test', async () => {
      await execute(test.env.DB, "UPDATE runner_pools SET state='disabled',revision=revision+1 WHERE id=?", test.pool.id);
      await execute(test.env.DB, "UPDATE runners SET state='revoked',revision=revision+1 WHERE id=?", runner.id);
    });
    expect((await authenticateRunner(test.env, runner.id, String(rotated.machine_token))).state).toBe('active');
    expect(await rotateRunner(test.env, runner.id, String(registered.machine_token), rotation)).toEqual(rotated);
    const current = await loadRunnerAuthority(test.env, runner.id);
    await updateRunnerCapabilities(test.metadata.binding(), current.runner, { pool_id: test.pool.id, capabilities, available_slots: 1 });
    await withAccountAuthorityBarrier(runnerIdentityContext(test.env), owner.id, 'credential-expiry', () => execute(test.env.DB, "UPDATE credentials SET expires_at='2000-01-01T00:00:00.000Z',revision=revision+1 WHERE id=?", current.credential.id));
    await expect(authenticateRunner(test.env, runner.id, String(rotated.machine_token))).rejects.toMatchObject({ code: 'runner_revoked' });
    await expect(rotateRunner(test.env, runner.id, String(registered.machine_token), rotation)).rejects.toMatchObject({ code: 'runner_revoked' });
  });

  it('authenticates fixed cross-cell projection commands and recovers only the exact durable exchange after a lost cell acknowledgement', async () => {
    const test = await fixture('cell'), input = await enrollment(test);
    test.loseProjectionAck();
    await expect(registerRunner(test.env, input)).rejects.toMatchObject({ code: 'runner_metadata_unavailable' });
    expect(await one(test.metadata.binding(), 'SELECT COUNT(*) AS count FROM runners')).toEqual({ count: 1 });
    expect(await one(test.env.DB, "SELECT COUNT(*) AS count FROM credentials WHERE kind='runner'")).toEqual({ count: 0 });
    const record = await registerRunner(test.env, input);
    expect((await loadRunnerAuthority(test.env, String(record.runner_id))).runner.credential_generation).toBe(1);
    const commands = test.received.filter(value => value.action === 'project');
    expect(commands).toHaveLength(2);
    expect(commands[0]).toMatchObject({ resource_id: record.runner_id, resource_type: 'runner', exchange_id: input.exchange.id, fence: { account_id: owner.id, phase: 'fenced' } });
    for (const command of commands) expect(Object.keys(command).sort()).toEqual(['action', 'exchange_id', 'fence', 'location', 'resource_id', 'resource_type']);
    expect(JSON.stringify(test.received)).not.toContain(input.enrollment_token);
    expect(JSON.stringify(test.received)).not.toContain(input.exchange.nonce);
    const unsigned = new Request('https://internal.gitknot.com/internal/execution/runners/metadata', { method: 'POST', body: JSON.stringify(commands[0]) });
    await expect(handleRunnerMetadataRequest(unsigned, test.env)).rejects.toMatchObject({ code: 'invalid_service_credential' });
    const invalid = await signInternalRequest(new Request(unsigned.url, { method: 'POST', body: JSON.stringify({ ...commands[0], sql: 'UPDATE runners' }) }), test.env.INTERNAL_SERVICE_KEY, 'execution.runner-metadata');
    await expect(handleRunnerMetadataRequest(invalid, test.env)).rejects.toMatchObject({ code: 'runner_metadata_request' });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM runner_credential_exchanges')).toEqual({ count: 1 });
  });

  it('serializes competing registration and rotation exchanges and never turns a retired source into a general credential', async () => {
    const test = await fixture('repository'), input = await enrollment(test);
    const contender = { ...input, exchange: createCredentialExchange(0) };
    const results = await Promise.allSettled([registerRunner(test.env, input), registerRunner(test.env, contender)]);
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM runner_credential_exchanges')).toEqual({ count: 1 });
    const winner = results[0]!.status === 'fulfilled' ? input : contender;
    const registered = await registerRunner(test.env, winner), runnerId = String(registered.runner_id), token = String(registered.machine_token);
    const exchanges = [createCredentialExchange(1), createCredentialExchange(1)];
    const rotations = await Promise.allSettled(exchanges.map(exchange => rotateRunner(test.env, runnerId, token, exchange)));
    expect(rotations.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    const chosen = exchanges[rotations.findIndex(value => value.status === 'fulfilled')]!;
    const rotated = await rotateRunner(test.env, runnerId, token, chosen);
    expect((await loadRunnerAuthority(test.env, runnerId)).runner.credential_generation).toBe(2);
    await expect(rotateRunner(test.env, runnerId, token, createCredentialExchange(1))).rejects.toMatchObject({ code: 'runner_revoked' });
    await expect(rotateRunner(test.env, runnerId, token, { ...chosen, expected_generation: 2 })).rejects.toMatchObject({ code: 'credential_recovery_denied' });
    const next = await rotateRunner(test.env, runnerId, String(rotated.machine_token), createCredentialExchange(2));
    expect(next.credential_generation).toBe(3);
    await expect(rotateRunner(test.env, runnerId, token, chosen)).rejects.toMatchObject({ code: 'credential_exchange_retired' });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM runner_credential_exchange_locks')).toEqual({ count: 0 });
  });

  it.each(['identity', 'repository'] as const)('requires reenrollment after transfer for a %s-owned pool even when a retained catalog names the old owner', async mode => {
    const test = await fixture(mode), input = await enrollment(test), unused = await enrollment(test, 'unused');
    const registered = await registerRunner(test.env, input), runnerId = String(registered.runner_id), token = String(registered.machine_token);
    const context = runnerIdentityContext(test.env);
    await withAccountAuthorityBarrier(context, owner.id, 'repository-transfer', () => withAccountAuthorityBarrier(context, receiver.id, 'repository-transfer', async () => {
      await execute(test.metadata.binding(), "UPDATE repositories SET owner_id='u_receiver',revision=revision+1,policy_revision=policy_revision+1 WHERE id='r_metadata'");
    }));
    expect(await one(test.env.DB, "SELECT owner_id FROM repositories WHERE id='r_metadata'")).toEqual({ owner_id: owner.id });
    await expect(authorizeRunnerPool(await manager(test, receiver), test.pool.id)).rejects.toMatchObject({ code: 'runner_pool_scope_changed' });
    await expect(registerRunner(test.env, unused)).rejects.toMatchObject({ code: 'runner_pool_scope_changed' });
    await expect(registerRunner(test.env, input)).rejects.toMatchObject({ code: 'runner_pool_scope_changed' });
    await expect(authenticateRunner(test.env, runnerId, token)).rejects.toMatchObject({ code: 'runner_pool_scope_changed' });
    await expect(rotateRunner(test.env, runnerId, token, createCredentialExchange(1))).rejects.toMatchObject({ code: 'runner_pool_scope_changed' });
  });

  it('globally admits one slot across repository shards, retains uncertain allocation, and fences a captured remote machine witness', async () => {
    const test = await fixture('repository', false), registered = await registerRunner(test.env, await enrollment(test));
    const runner = await authenticateRunner(test.env, String(registered.runner_id), String(registered.machine_token));
    const second = await createTestDatabase(); opened.push(second); await identities(second.binding());
    await repository(second.binding(), 'r_work', 'local', 'work', 2);
    test.env.WORK = second.binding(); test.env.SHARD_BINDINGS_JSON = JSON.stringify({ core: 'DB', metadata: 'METADATA', work: 'WORK' });
    await execute(test.env.DB, `INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,epoch,state,updated_at) VALUES ('r_work','repository','local','work',2,'active',?)`, now());
    const attempts = [await attempt(test, 'first'), await attempt(test, 'second', second, 'r_work')];
    await Promise.all(attempts.map(value => offerRunnerJob(test.env, value)));
    const slots = await Promise.all(attempts.map(value => reserveRunnerSlot(test.env, value, runner, test.pool)));
    expect(slots.filter(Boolean)).toHaveLength(1);
    const index = slots.findIndex(Boolean), allocated = attempts[index]!, slot = slots[index]!, db = index === 0 ? test.metadata : second;
    await activate(test, allocated, runner, slot, db);
    await execute(test.env.DB, "UPDATE runner_slot_reservations SET expires_at='2000-01-01T00:00:00.000Z' WHERE attempt_id=?", allocated.id);
    await expect(closeRunnerSlot(test.env, allocated)).rejects.toMatchObject({ code: 'runner_cleanup_unverified' });
    expect(await activeRunnerSlots(test.env, runner.id)).toHaveLength(1);
    expect(await reserveRunnerSlot(test.env, attempts[1 - index]!, runner, test.pool)).toBeNull();
    await expect(rotateRunner(test.env, runner.id, String(registered.machine_token), createCredentialExchange(1))).rejects.toMatchObject({ code: 'runner_busy' });
    await expect(execute(test.env.DB, "UPDATE runner_slot_reservations SET state='closed' WHERE attempt_id=?", allocated.id)).rejects.toThrow('runner_slot_cleanup_required');
    await cleanup(db.binding(), allocated.id);
    await closeRunnerSlot(test.env, allocated);
    const remaining = attempts[1 - index]!, nextSlot = await reserveRunnerSlot(test.env, remaining, runner, test.pool);
    expect(nextSlot).not.toBeNull();
    const witness = await loadRunnerAuthority(test.env, runner.id);
    const authority = await repositoryExecutionContext(test.env, runnerPrincipal(witness), 'r_work');
    await bindRunnerAuthority(authority, witness.witness);
    const statements = await mutationStatements(authority, { statements: [stmt(database(authority), 'UPDATE execution_attempts SET reason=? WHERE id=?', 'stale machine publication', attempts[1]!.id)],
      event: { type: 'execution.machine.test', resource_id: attempts[1]!.id, resource_revision: 1, repo_id: 'r_work', account_id: owner.id } });
    await withRunnerAuthorityChange(await manager(test), test.pool.id, () => execute(test.poolDb.binding(), "UPDATE runner_pools SET state='disabled',revision=revision+1 WHERE id=?", test.pool.id));
    await expect(second.batch(statements)).rejects.toThrow('mutation_requires_one_row');
    expect(await one(second.binding(), 'SELECT reason FROM execution_attempts WHERE id=?', attempts[1]!.id)).toEqual({ reason: null });
    expect(await one(second.binding(), "SELECT COUNT(*) AS count FROM outbox WHERE type='execution.machine.test'")).toEqual({ count: 0 });
    expect(await one(test.metadata.binding(), 'SELECT COUNT(*) AS count FROM runner_slot_reservations')).toEqual({ count: 0 });
  });

  it('retires a disposable machine only after immutable cleanup proof and recovers both retirement authorities after a lost acknowledgement', async () => {
    const test = await fixture('repository'), input = await enrollment(test, 'disposable', true), registered = await registerRunner(test.env, input);
    const runner = await authenticateRunner(test.env, String(registered.runner_id), String(registered.machine_token));
    const first = await attempt(test, 'disposable_first'), next = await attempt(test, 'disposable_next');
    const slot = (await reserveRunnerSlot(test.env, first, runner, test.pool))!;
    await activate(test, first, runner, slot);
    await execute(test.metadata.binding(), "UPDATE execution_attempts SET status='leased',allocated_at=?,credential_hash='original-lease' WHERE id=?", now(), first.id);
    expect((await readRunnerRecord(test.env, runner.id)).assignment_attempt_id).toBe(first.id);
    expect(await reserveRunnerSlot(test.env, next, runner, test.pool)).toBeNull();
    await expect(rotateRunner(test.env, runner.id, String(registered.machine_token), createCredentialExchange(1))).rejects.toMatchObject({ code: 'disposable_consumed' });
    await expect(closeRunnerSlot(test.env, first)).rejects.toMatchObject({ code: 'runner_cleanup_unverified' });
    await cleanup(test.metadata.binding(), first.id);
    const restore = failBatch(test.metadata, /INSERT INTO runner_retirement_projections/, 'after');
    await expect(closeRunnerSlot(test.env, first)).rejects.toThrow('Injected'); restore();
    expect(await one(test.env.DB, 'SELECT state FROM runner_slot_reservations WHERE attempt_id=?', first.id)).toEqual({ state: 'leased' });
    expect(await one(test.env.DB, 'SELECT state FROM runner_retirements WHERE runner_id=?', runner.id)).toEqual({ state: 'pending' });
    expect(await one(test.env.DB, "SELECT COUNT(*) AS count FROM credentials WHERE principal_id=? AND revoked_at IS NULL", runner.id)).toEqual({ count: 0 });
    expect(await one(test.metadata.binding(), 'SELECT state FROM runners WHERE id=?', runner.id)).toEqual({ state: 'revoked' });
    expect(await reconcileRunnerAuthorityChanges(test.env)).toBe(1);
    const epoch = await one(test.env.DB, 'SELECT epoch FROM account_authority_epochs WHERE account_id=?', owner.id);
    await closeRunnerSlot(test.env, first); await closeRunnerSlot(test.env, first);
    expect(await one(test.env.DB, 'SELECT epoch FROM account_authority_epochs WHERE account_id=?', owner.id)).toEqual(epoch);
    expect(await activeRunnerSlots(test.env, runner.id)).toEqual([]);
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM runner_disposable_consumption WHERE runner_id=?', runner.id)).toEqual({ count: 1 });
    expect(await one(test.metadata.binding(), 'SELECT runner_credential_hash,credential_hash FROM execution_attempts WHERE id=?', first.id)).toEqual({ runner_credential_hash: runner.credential_hash, credential_hash: null });
    await expect(execute(test.metadata.binding(), 'UPDATE execution_attempts SET runner_credential_hash=? WHERE id=?', 'f'.repeat(64), first.id)).rejects.toThrow('attempt_runner_identity_retained');
    await expect(execute(test.env.DB, 'DELETE FROM runner_disposable_consumption WHERE runner_id=?', runner.id)).rejects.toThrow('retained');
    await expect(rotateRunner(test.env, runner.id, String(registered.machine_token), createCredentialExchange(1))).rejects.toMatchObject({ code: 'runner_revoked' });
    await expect(registerRunner(test.env, input)).rejects.toMatchObject({ code: 'runner_revoked' });
  });

  it('durably reconciles admin revocation after its metadata commit is acknowledged ambiguously', async () => {
    const test = await fixture('repository'), registered = await registerRunner(test.env, await enrollment(test));
    const runnerId = String(registered.runner_id), authority = await loadRunnerAuthority(test.env, runnerId), context = await manager(test);
    await expect(withRunnerAuthorityChange(context, test.pool.id, async () => {
      await execute(test.metadata.binding(), "UPDATE runners SET state='revoked',revision=revision+1 WHERE id=?", runnerId);
      throw new Error('Lost admin mutation acknowledgement.');
    })).rejects.toThrow('Lost admin');
    expect(await one(test.env.DB, 'SELECT state FROM runner_authority_reconciliations')).toEqual({ state: 'pending' });
    expect(await one(test.env.DB, 'SELECT revoked_at FROM credentials WHERE id=?', authority.credential.id)).toEqual({ revoked_at: null });
    await expect(loadRunnerAuthority(test.env, runnerId)).rejects.toMatchObject({ code: 'runner_revoked' });
    expect(await reconcileRunnerAuthorityChanges(test.env)).toBe(1);
    expect(await one(test.env.DB, 'SELECT state FROM runner_authority_reconciliations')).toEqual({ state: 'committed' });
    expect(await one(test.env.DB, 'SELECT revoked_at FROM credentials WHERE id=?', authority.credential.id)).toEqual({ revoked_at: expect.any(String) });
    expect(await one(test.env.DB, 'SELECT state FROM runner_retirements WHERE runner_id=?', runnerId)).toEqual({ state: 'committed' });
  });
});
