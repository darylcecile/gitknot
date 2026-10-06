import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { compileWorkflow, digestJson, sha256, type RunManifest } from '../../packages/workflows/src/index.ts';
import { GitKnotHttpClient, RunnerClient, createCredentialExchange, credentialExchangeSchema, decodeUtf8, deriveRunnerCredential, recoverRunnerCredential, registerRunner, rotateRunnerCredential, runRunner, type Assignment, type CompletionReceipt } from '../../packages/runner/src/index.ts';
import { command, gitFixture, ociFixture, projectRoot, shellNode, workflow, type GitFixture } from '../../packages/runner/tests/support.ts';

interface Harness {
  fixture: GitFixture;
  origin: string;
  ownerToken: string;
  enrollmentToken: string;
  machineToken: string;
  assignments: Assignment[];
  logs: Map<number, Buffer>;
  uploads: number;
  receipts: Map<string, CompletionReceipt>;
  completionDigests: string[];
  loseCompletions: boolean;
  loseCredentialResponses: Set<'register' | 'rotate'>;
  credentialGeneration: number;
  credentialExchanges: Map<string, { operation: string; request_digest: string; nonce_hash: string; old_hash: string; new_hash: string; metadata: Record<string, unknown> }>;
  assertExchangePersisted: boolean;
  secrets: Record<string, string>;
  secretStepId: string;
  mode: 'normal' | 'cancelled' | 'expired' | 'revoked';
  close(): Promise<void>;
}

async function harness(fixture: GitFixture): Promise<Harness> {
  let consumed = false;
  let queued = 0;
  const state = {
    fixture, origin: '', ownerToken: `owner_${randomUUID().replaceAll('-', '')}`, enrollmentToken: `enroll_${randomUUID().replaceAll('-', '')}`, machineToken: `machine_${randomUUID().replaceAll('-', '')}`,
    assignments: [] as Assignment[], logs: new Map<number, Buffer>(), uploads: 0, receipts: new Map<string, CompletionReceipt>(), completionDigests: [] as string[], loseCompletions: false,
    loseCredentialResponses: new Set<'register' | 'rotate'>(), credentialGeneration: 0, credentialExchanges: new Map<string, { operation: string; request_digest: string; nonce_hash: string; old_hash: string; new_hash: string; metadata: Record<string, unknown> }>(), assertExchangePersisted: false,
    secrets: { TOKEN: 'split-protocol-secret-123456789' } as Record<string, string>, secretStepId: 'step_1', mode: 'normal' as Harness['mode'], close: async () => {},
  };
  const json = (res: ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '0' }); res.end(JSON.stringify(value)); };
  const failure = (res: ServerResponse, status: number, code: string) => json(res, { error: { code, message: 'GitKnot fixture request was rejected.', request_id: 'req_fixture' } }, status);
  const read = async (req: IncomingMessage): Promise<Record<string, any>> => {
    const parts: Buffer[] = []; for await (const part of req) parts.push(part as Buffer);
    return parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, any> : {};
  };
  const exchangeCredential = async (operation: 'register' | 'rotate', body: Record<string, any>, secret: string, res: ServerResponse) => {
    const parsed = credentialExchangeSchema.safeParse(body.exchange);
    if (!parsed.success) return failure(res, 422, 'exchange_required');
    const exchange = parsed.data;
    const request = operation === 'register' ? { name: body.name, capabilities: body.capabilities, slots: body.slots, disposable: body.disposable } : {};
    const requestDigest = await digestJson(request), nonceHash = await sha256(exchange.nonce), oldHash = await sha256(secret);
    if (state.assertExchangePersisted) {
      const pendingPath = join(state.fixture.root, 'config', 'runner.json.exchange.json');
      const pending = JSON.parse(await readFile(pendingPath, 'utf8'));
      expect(pending.exchange).toEqual(exchange);
      expect((await stat(pendingPath)).mode & 0o077).toBe(0);
    }
    let existing = state.credentialExchanges.get(exchange.id);
    if (existing) {
      if (existing.operation !== operation || existing.request_digest !== requestDigest || existing.nonce_hash !== nonceHash || existing.old_hash !== oldHash) return failure(res, 409, 'exchange_conflict');
      if (existing.metadata.credential_generation !== state.credentialGeneration || existing.new_hash !== await sha256(state.machineToken)) return failure(res, 401, 'exchange_retired');
    } else {
      if (operation === 'register' && (consumed || secret !== state.enrollmentToken || exchange.expected_generation !== 0 || body.slots !== 1)) return failure(res, 401, 'enrollment_invalid');
      if (operation === 'rotate' && (secret !== state.machineToken || exchange.expected_generation !== state.credentialGeneration)) return failure(res, 401, 'runner_revoked');
      const next = await deriveRunnerCredential(secret, { api_origin: state.origin, operation, subject: operation === 'register' ? 'enrollment' : 'runner_fixture', request, exchange });
      const metadata = { exchange_id: exchange.id, credential_generation: exchange.expected_generation + 1, credential_expires_at: new Date(Date.now() + 86_400_000).toISOString(), ...(operation === 'register' ? { runner_id: 'runner_fixture', pool_id: 'pool_fixture', pool_name: 'pool_fixture', account_id: 'org_fixture', repository_ids: ['r_fixture'], trust: 'trusted', disposable: false, heartbeat_interval_seconds: 1, poll_timeout_seconds: 1 } : {}) };
      existing = { operation, request_digest: requestDigest, nonce_hash: nonceHash, old_hash: oldHash, new_hash: await sha256(next), metadata };
      state.credentialExchanges.set(exchange.id, existing); state.machineToken = next; state.credentialGeneration = exchange.expected_generation + 1;
      if (operation === 'register') consumed = true;
    }
    if (state.loseCredentialResponses.has(operation)) { res.destroy(); return; }
    const token = await deriveRunnerCredential(secret, { api_origin: state.origin, operation, subject: operation === 'register' ? 'enrollment' : 'runner_fixture', request, exchange });
    return json(res, { ...existing.metadata, machine_token: token }, operation === 'register' ? 201 : 200);
  };
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url!, state.origin).pathname;
      const body = await read(req);
      if (path === '/v1/runner-enrollments') {
        if (req.headers.authorization !== `Bearer ${state.ownerToken}` || body.pool_id !== 'pool_fixture') return failure(res, 403, 'scope_denied');
        return json(res, { id: 'enr_fixture', pool_id: 'pool_fixture', enrollment_token: state.enrollmentToken, expires_at: new Date(Date.now() + 60_000).toISOString() }, 201);
      }
      if (path === '/v1/runners/register') {
        return await exchangeCredential('register', body, String(body.enrollment_token), res);
      }
      if (path === '/v1/runners/runner_fixture/rotate') return await exchangeCredential('rotate', body, String(req.headers.authorization ?? '').replace(/^Bearer /, ''), res);
      const ready = [...state.logs.values()].some((bytes) => decodeUtf8(bytes).includes('READY'));
      if (req.headers.authorization !== `Bearer ${state.machineToken}` || state.mode === 'revoked' && ready) return failure(res, 401, 'runner_revoked');
      if (path === '/v1/runners/runner_fixture/heartbeat') return json(res, { status: 'active', cancel_attempt_ids: [] });
      if (path === '/v1/runners/runner_fixture/poll') {
        if (body.pool_id !== 'pool_fixture' || body.available_slots !== 1) return failure(res, 403, 'scope_denied');
        return json(res, { assignment: state.assignments[queued++] ?? null });
      }
      const assignment = state.assignments[0]!;
      if (!assignment || body.runner_id !== 'runner_fixture' || body.generation !== assignment.generation || body.lease_token !== assignment.lease_token) return failure(res, 409, 'attempt_fenced');
      if (path.endsWith('/heartbeat')) {
        if (state.mode === 'expired') return failure(res, 503, 'network_partition');
        if (state.mode === 'cancelled' && ready) return json(res, { status: 'cancelled' });
        return json(res, { status: 'active', lease_expires_at: assignment.lease_expires_at });
      }
      if (Date.now() >= Date.parse(assignment.lease_expires_at)) return failure(res, 410, 'attempt_fenced');
      if (path.endsWith('/secrets')) {
        if (body.step_id !== state.secretStepId || JSON.stringify(body.names) !== JSON.stringify(Object.keys(state.secrets).sort())) return failure(res, 403, 'secret_scope');
        return json(res, { values: state.secrets, expires_at: new Date(Date.now() + 20_000).toISOString() });
      }
      if (path.endsWith('/logs') || path.endsWith('/outputs')) {
        const bytes = Buffer.from(body.data_base64, 'base64');
        if (bytes.length !== body.size_bytes || await sha256(bytes) !== body.digest) return failure(res, 422, 'checksum');
        if (path.endsWith('/logs')) {
          try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return failure(res, 422, 'invalid_utf8_log'); }
          const previous = state.logs.get(body.sequence);
          if (previous && (previous.byteLength !== bytes.byteLength || !previous.every((value, index) => value === bytes[index]))) return failure(res, 409, 'log_conflict');
          state.logs.set(body.sequence, bytes);
          return json(res, { accepted: true, sequence: body.sequence, digest: body.digest });
        }
        state.uploads += 1;
        return json(res, { accepted: true, name: body.name, sequence: body.sequence, digest: body.digest });
      }
      if (path.endsWith('/complete')) {
        if (await digestJson(body.receipt) !== body.receipt_digest || !body.receipt.cleanup_confirmed) return failure(res, 422, 'receipt_invalid');
        const previous = state.receipts.get(body.receipt.attempt_id);
        if (previous && await digestJson(previous) !== body.receipt_digest) return failure(res, 409, 'receipt_conflict');
        state.receipts.set(body.receipt.attempt_id, body.receipt);
        state.completionDigests.push(body.receipt_digest);
        if (state.loseCompletions) return failure(res, 503, 'reply_lost');
        return json(res, { accepted: true, receipt_digest: body.receipt_digest });
      }
      return failure(res, 404, 'not_found');
    } catch { if (!res.headersSent) failure(res, 500, 'fixture_error'); else res.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  state.origin = `http://127.0.0.1:${address.port}`;
  state.close = async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await fixture.close(); };
  return state;
}

async function enroll(state: Harness) {
  const owner = new GitKnotHttpClient({ origin: state.origin, token: state.ownerToken, allow_loopback_http: true });
  const enrollment = await owner.request<{ enrollment_token: string }>('POST', '/v1/runner-enrollments', { body: { pool_id: 'pool_fixture' } });
  return registerRunner({ api_origin: state.origin, enrollment_token: enrollment.data.enrollment_token, name: 'fixture', toolchains: { 'fixture@1.0.0': state.fixture.toolchain }, isolation: (await ociFixture()).isolation, configuration_path: join(state.fixture.root, 'config', 'runner.json'), state_directory: join(state.fixture.root, 'state'), work_directory: join(state.fixture.root, 'work'), allow_loopback_http: true });
}

function assignment(state: Harness, manifest: RunManifest, leaseMs = 30_000): Assignment {
  return { attempt_id: 'att_fixture', run_id: 'run_fixture', job_id: 'test', generation: 1, lease_token: `lease_${randomUUID().replaceAll('-', '')}`, lease_expires_at: new Date(Date.now() + leaseMs).toISOString(), deadline_at: new Date(Date.now() + 30_000).toISOString(), manifest, source: { url: state.fixture.repo, commit: state.fixture.commit, token: 'source_capability_never_in_checkout_12345' } };
}

describe('customer-owned runner over real outbound HTTP and native Git/shell', () => {
  const harnesses: Harness[] = [];
  beforeAll(async () => { await ociFixture(); }, 180_000);
  afterEach(async () => { await Promise.all(harnesses.splice(0).map((value) => value.close())); });
  const create = async () => { const fixture = await gitFixture(); fixture.toolchain = (await ociFixture()).toolchain; const value = await harness(fixture); harnesses.push(value); return value; };

  it('consumes scoped enrollment once, verifies clean source, masks chunk boundaries, uploads checksums and rotates machine credentials', async () => {
    const state = await create();
    const context = state.fixture.context(); context.policy.access.secrets = ['TOKEN']; context.configuration = { selection_id: 'selection_fixture', selection_digest: await sha256('versioned secret selection') };
    const plan = await compileWorkflow({ ...workflow({ test: { steps: [{ env: { TOKEN: { secret: 'TOKEN' } }, run: shellNode(String.raw`const fs=require('node:fs');const git=fs.readFileSync('.git/config','utf8');if(/machine_|source_capability|lease_/.test(git)||process.env.GITKNOT_TOKEN||process.env.GITKNOT_SOURCE_TOKEN)throw Error('credential leak');const secret=process.env.TOKEN;process.stdout.write(secret.slice(0,6));setTimeout(()=>{process.stdout.write(secret.slice(6)+'\n');fs.mkdirSync('dist');fs.writeFileSync('dist/output.txt','safe artifact');},25);`) }], outputs: { bundle: { path: 'dist/' } } } }), access: { repository: 'read', secrets: ['TOKEN'] } }, context);
    const registration = await enroll(state);
    const leased = assignment(state, plan);
    state.assignments = [leased, leased];
    const replay = new RunnerClient({ origin: state.origin, allow_loopback_http: true });
    await expect(replay.register({ enrollment_token: state.enrollmentToken, name: 'duplicate', capabilities: registration.configuration.capabilities, slots: 1, disposable: false, exchange: createCredentialExchange(0) })).rejects.toMatchObject({ status: 401 });
    const result = await runRunner(registration.path, { max_assignments: 2, allow_local_source: true, grace_ms: 50 });
    expect(result.completed).toBe(2); expect(state.uploads).toBeGreaterThan(0);
    expect(state.completionDigests).toHaveLength(1);
    const logs = Buffer.concat([...state.logs.values()]).toString('utf8');
    expect(logs).toContain('[REDACTED]'); expect(logs).not.toContain('split-protocol-secret');
    expect(state.receipts.get('att_fixture')).toMatchObject({ outcome: 'passed', commit: state.fixture.commit, manifest_digest: plan.digest, cleanup_confirmed: true });
    expect(await readdir(join(state.fixture.root, 'work'))).toEqual([]);
    expect((await stat(registration.path)).mode & 0o077).toBe(0);
    const oldToken = state.machineToken;
    await rotateRunnerCredential(registration.path);
    expect(state.machineToken).not.toBe(oldToken);
    await expect(new GitKnotHttpClient({ origin: state.origin, token: oldToken, allow_loopback_http: true }).request('POST', '/v1/runners/runner_fixture/heartbeat', { body: {} })).rejects.toMatchObject({ status: 401 });
  });

  it('replays the exact durable completion after a lost response without running commands twice', async () => {
    const state = await create();
    const plan = await compileWorkflow(workflow({ test: { steps: [{ run: shellNode(String.raw`process.stdout.write('executed\n')`) }] } }), state.fixture.context());
    const registration = await enroll(state);
    state.assignments = [assignment(state, plan)]; state.loseCompletions = true;
    await expect(runRunner(registration.path, { once: true, allow_local_source: true, grace_ms: 50 })).rejects.toMatchObject({ status: 503 });
    const journalPath = join(state.fixture.root, 'state', 'attempts', 'att_fixture.1', 'journal.json');
    expect(JSON.parse(await readFile(journalPath, 'utf8')).state).toBe('ready');
    state.loseCompletions = false;
    const recovered = await runRunner(registration.path, { once: true, allow_local_source: true, grace_ms: 50 });
    expect(recovered.recovered).toBe(1);
    expect(new Set(state.completionDigests).size).toBe(1);
    expect(Buffer.concat([...state.logs.values()]).toString('utf8')).toBe('executed\n');
    expect(JSON.parse(await readFile(journalPath, 'utf8')).state).toBe('accepted');
  });

  it.each(['cancelled', 'expired', 'revoked'] as const)('kills the process group and rejects late publication when %s', async (mode) => {
    const state = await create();
    const escaped = join(state.fixture.root, 'late-side-effect');
    const childScript = `process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync('/gitknot/source/late-side-effect','escaped'),4000);setInterval(()=>{},1000);`;
    const parentScript = String.raw`const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore',detached:true}).unref();process.stdout.write('READY\n');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
    const plan = await compileWorkflow(workflow({ test: { steps: [{ run: shellNode(parentScript) }] } }), state.fixture.context());
    const registration = await enroll(state);
    state.mode = mode; state.assignments = [assignment(state, plan, mode === 'expired' ? 900 : 30_000)];
    try {
      expect((await runRunner(registration.path, { once: true, allow_local_source: true, grace_ms: 50 })).fenced).toBe(1);
    } catch (error) {
      if (mode !== 'revoked') throw error;
      expect(error).toMatchObject({ code: 'runner_revoked' });
    }
    expect(state.receipts.size).toBe(0); expect(state.uploads).toBe(0);
    const journal = JSON.parse(await readFile(join(state.fixture.root, 'state', 'attempts', 'att_fixture.1', 'journal.json'), 'utf8'));
    for (const allocation of journal.isolation_allocations ?? []) await expect(command('docker', ['container', 'inspect', allocation.id], projectRoot)).rejects.toBeDefined();
    await delay(4_100);
    await expect(stat(escaped)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(join(state.fixture.root, 'work'))).toEqual([]);
  });

  it('rejects another repository before checkout or shell execution', async () => {
    const state = await create();
    const context = state.fixture.context({ repo_id: 'r_foreign' }); context.policy.self_hosted_pools.pool_fixture!.repository_ids = ['r_foreign'];
    const plan = await compileWorkflow(workflow({ test: { steps: [{ run: 'echo unauthorized' }] } }), context);
    const registration = await enroll(state); state.assignments = [assignment(state, plan)];
    await expect(runRunner(registration.path, { once: true, allow_local_source: true })).rejects.toMatchObject({ code: 'assignment_scope' });
    expect(state.logs.size).toBe(0); expect(state.receipts.size).toBe(0);
  });

  it('prevents malicious shell code from reading supervisor machine credentials, host configuration, and daemon access', async () => {
    const state = await create();
    const registration = await enroll(state);
    const sentinel = join(state.fixture.root, 'private-config'); await writeFile(sentinel, 'supervisor-only-canary', { mode: 0o600 });
    const attack = `const fs=require('node:fs');const paths=${JSON.stringify([registration.path, sentinel, join(state.fixture.root, 'state'), '/var/run/docker.sock', '/run/podman/podman.sock','/proc/1/environ'])};for(const p of paths){try{fs.readFileSync(p);throw Error('supervisor file accessible')}catch(e){if(!['ENOENT','EACCES','EPERM','EISDIR'].includes(e.code))throw e}}for(const name of ['GITKNOT_TOKEN','GITKNOT_CONFIG_DIR','GITKNOT_STATE_DIR','GITKNOT_SOURCE_TOKEN','DOCKER_HOST','DOCKER_CONFIG','NODE_OPTIONS','SSH_AUTH_SOCK'])if(process.env[name])throw Error('inherited credential config');if(process.getuid()===0)throw Error('root job');try{process.kill(1,'SIGUSR1');throw Error('supervisor signal allowed')}catch(e){if(e.code!=='EPERM')throw e}fs.writeFileSync('proof.txt','boundary enforced');process.stdout.write('malicious probes denied');`;
    const sabotage = `require('node:fs').mkdirSync('.cache');require('node:fs').writeFileSync('.cache/dependency','safe cache');require('node:fs').writeFileSync('.git/config','job-controlled invalid Git configuration');`;
    const plan = await compileWorkflow(workflow({ test: { cache: { paths: ['.cache'], key_files: ['README.md'] }, steps: [{ id: 'attack', run: shellNode(attack + sabotage), outputs: { proof: { type: 'string', path: 'proof.txt' } } }, { run: 'test "$PROOF" = "boundary enforced"', env: { PROOF: { output: 'steps.attack.proof' } } }], outputs: { proof: { type: 'string', path: 'proof.txt' } } } }), state.fixture.context());
    state.assignments = [assignment(state, plan)];
    expect((await runRunner(registration.path, { once: true, allow_local_source: true, grace_ms: 50 })).completed).toBe(1);
    expect(state.receipts.get('att_fixture')?.outcome).toBe('passed');
    expect(Buffer.concat([...state.logs.values()]).toString('utf8')).toContain('malicious probes denied');
    expect(await readFile(sentinel, 'utf8')).toBe('supervisor-only-canary');
    expect(JSON.parse(await readFile(registration.path, 'utf8')).registration.machine_token).toBe(state.machineToken);
    await expect(runRunner({ ...registration.configuration, isolation: undefined as never }, { once: true, allow_local_source: true })).rejects.toMatchObject({ code: 'isolation_required' });
  });

  it('recovers committed enrollment and rotation after lost responses and uploads complete UTF-8 chunks with logical underscore IDs', async () => {
    const state = await create(); state.assertExchangePersisted = true;
    const path = join(state.fixture.root, 'config', 'runner.json');
    state.loseCredentialResponses.add('register');
    await expect(enroll(state)).rejects.toMatchObject({ code: 'api_unavailable' });
    const registrationJournal = JSON.parse(await readFile(`${path}.exchange.json`, 'utf8'));
    expect(state.credentialExchanges.size).toBe(1); expect(state.credentialGeneration).toBe(1);
    state.loseCredentialResponses.clear();
    const recovered = await recoverRunnerCredential(path);
    expect(recovered.registration.exchange_id).toBe(registrationJournal.exchange.id);
    expect(recovered.registration.machine_token).toBe(state.machineToken);
    await expect(stat(`${path}.exchange.json`)).rejects.toMatchObject({ code: 'ENOENT' });
    const old = state.machineToken;
    state.loseCredentialResponses.add('rotate');
    await expect(rotateRunnerCredential(path)).rejects.toMatchObject({ code: 'api_unavailable' });
    const rotationJournal = JSON.parse(await readFile(`${path}.exchange.json`, 'utf8'));
    expect(state.credentialGeneration).toBe(2); expect(state.credentialExchanges.size).toBe(2);
    expect(JSON.parse(await readFile(path, 'utf8')).registration.machine_token).toBe(old);
    state.loseCredentialResponses.clear();
    const rotated = await recoverRunnerCredential(path);
    expect(rotated.registration.credential_generation).toBe(2); expect(rotated.registration.machine_token).not.toBe(old);
    expect(rotated.registration.exchange_id).toBe(rotationJournal.exchange.id);
    expect(JSON.stringify([...state.credentialExchanges.values()])).not.toContain(rotationJournal.exchange.nonce);
    state.assertExchangePersisted = false;
    const forged = { ...rotationJournal.exchange, nonce: createCredentialExchange(1).nonce };
    await expect(new RunnerClient({ origin: state.origin, token: old, allow_loopback_http: true }).rotate('runner_fixture', forged)).rejects.toMatchObject({ status: 409 });
    await expect(new GitKnotHttpClient({ origin: state.origin, token: old, allow_loopback_http: true }).request('POST', '/v1/runners/runner_fixture/heartbeat', { body: {} })).rejects.toMatchObject({ status: 401 });
    state.secrets = { LONG: '\u0001'.repeat(15000) + 'z', ONE: '1', ZERO: '0' }; state.secretStepId = '_step';
    const context = state.fixture.context(); context.policy.access.secrets = Object.keys(state.secrets); context.configuration = { selection_id: 'selection_utf8', selection_digest: await sha256('utf8 fixture') };
    const plan = await compileWorkflow({ ...workflow({ _test: { steps: [{ id: '_step', env: { LONG: { secret: 'LONG' }, ONE: { secret: 'ONE' }, ZERO: { secret: 'ZERO' } }, run: shellNode(`process.stdout.write('%01'.repeat(12483));setTimeout(()=>{process.stdout.write('€');require('node:fs').writeFileSync('value','valid');},40);`) }], outputs: { _output: { type: 'string', path: 'value' } } } }), access: { repository: 'read', secrets: Object.keys(state.secrets) } }, context);
    expect(plan.limits.max_chunk_bytes).toBe(262144);
    state.assignments = [{ ...assignment(state, plan), job_id: '_test' }];
    const result = await runRunner(path, { once: true, allow_local_source: true });
    expect(result.completed).toBe(1);
    const chunks = [...state.logs.values()];
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(() => new TextDecoder('utf-8', { fatal: true }).decode(chunk)).not.toThrow();
    expect(decodeUtf8(Buffer.concat(chunks))).toBe('%[REDACTED][REDACTED]'.repeat(12483) + '€');
    expect(state.receipts.get('att_fixture')).toMatchObject({ job_id: '_test', outcome: 'passed', steps: [expect.objectContaining({ id: '_step' })], outputs: [expect.objectContaining({ name: '_output' })] });
  });
});
