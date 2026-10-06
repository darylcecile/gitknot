import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createTestDatabase, projectRoot } from '../support/database.ts';
import { base64url, now, prepareCredential, signInternalRequest, stmt, verifyInternalRequest } from '../../packages/core/src/index.ts';

it.each(['complete', 'capture-failure'] as const)('releases a real workerd backup fence after %s and permits ordinary API, vault and preview writes', async outcome => {
  const [{ build }, { Miniflare, convertV4MiniflareOptions }] = await Promise.all([import('esbuild'), import('miniflare')]);
  const directory = await mkdtemp('/private/var/folders/zh/l70grz9n3ll9j9c_f1ghp7gr0000gn/T/opencode/events-workerd-');
  const execute = promisify(execFile);
  const git = (...args: string[]) => execute('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: directory, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  });
  const key = '7'.repeat(64);
  const serviceKey = base64url(randomBytes(32)), envelopeKey = base64url(randomBytes(32));
  let runtime: InstanceType<typeof Miniflare> | undefined;
  try {
    await git('init', '--template=', '--initial-branch=main');
    await writeFile(join(directory, 'README.md'), 'Automatic backup through workerd\n');
    await git('add', 'README.md');
    await git('-c', 'user.name=Backup fixture', '-c', 'user.email=backup@example.net', 'commit', '-m', 'Backup source');
    const oid = (await git('rev-parse', 'HEAD')).stdout.trim();
    await git('bundle', 'create', 'source.bundle', 'refs/heads/main');
    await git('bundle', 'verify', 'source.bundle');
    const bundle = await readFile(join(directory, 'source.bundle'));
    const buildOptions = { absWorkingDir: projectRoot, bundle: true, write: false as const, format: 'esm' as const, platform: 'neutral' as const, target: 'es2023',
      conditions: ['workerd', 'browser'], mainFields: ['module', 'main'], external: ['node:*', 'cloudflare:*'],
      alias: { crypto: 'node:crypto', util: 'node:util' },
      banner: { js: "import {createRequire as __createRequire} from 'node:module';const require=__createRequire('/backup-worker.js');" } };
    const [script, api, vault] = await Promise.all([build({ ...buildOptions,
      stdin: { resolveDir: projectRoot, contents: `
        import {scheduleMaintenance,dispatchOperations} from './packages/operations/src/dispatch.ts';
        import {one} from './packages/core/src/index.ts';
        export {AdmissionController} from './packages/billing/src/controller.ts';
        export {OperationWorkflow} from './workers/background/src/ops/operation-workflow.ts';
        export default {async fetch(request,env) {
          if(new URL(request.url).pathname==='/start') {await scheduleMaintenance(env);await dispatchOperations(env);}
          const operation=await one(env.DB,"SELECT id,status,phase,error_json FROM operations WHERE kind='repository.backup' AND repo_id='r_backup' ORDER BY created_at LIMIT 1");
          const fence=await one(env.DB,"SELECT state FROM repository_metadata_fences WHERE repo_id='r_backup'");
          const archive=await one(env.DB,"SELECT state,bytes FROM repository_archives WHERE repo_id='r_backup'");
          return Response.json({operation,fence,archive});
        }};` } }), build({ ...buildOptions, entryPoints: ['apps/api/src/index.ts'] }), build({ ...buildOptions, entryPoints: ['workers/secrets/src/index.ts'] })]);
    const held = new Set<string>();
    const placement = { DB: 'backup-primary', IDENTITY_DB: 'backup-primary', DIRECTORY_DB: 'backup-primary' };
    const shared = { ENVIRONMENT: 'test', CELL_ID: 'local', SHARD_ID: 'core', IDENTITY_CELL_ID: 'local', IDENTITY_SHARD_ID: 'core',
      API_ORIGIN: 'https://api.gitknot.com', APP_ORIGIN: 'https://gitknot.com', GIT_ORIGIN: 'https://git.gitknot.com',
      INTERNAL_SERVICE_KEY: key, BILLING_PLATFORM_SLICE_ID: 'slice_backup' };
    const nativeRead = async (request: { url: string; method: string; headers: Headers; arrayBuffer(): Promise<ArrayBuffer> }) => {
      const incoming = new Request(request.url, { method: request.method, headers: new Headers(request.headers), body: await request.arrayBuffer() });
      await verifyInternalRequest(incoming, key, 'git-service');
      const action = new URL(incoming.url).pathname.split('/').at(-1);
      const body = await incoming.json() as { operation_id: string };
      if (action === 'inspect') return Response.json({ repo_id: 'r_backup', commit_oid: (await git('rev-parse', 'refs/heads/main')).stdout.trim() });
      if (action === 'barrier') {
        if (request.method === 'DELETE') held.delete(body.operation_id); else held.add(body.operation_id);
        return Response.json({ held: request.method === 'POST', operation_id: body.operation_id });
      }
      if (!held.has(body.operation_id)) throw new Error('Native read has no held backup barrier');
      if (action === 'verify') return Response.json({ verified: true, objects_verified: true, refs: [{ ref: 'refs/heads/main', oid }] });
      if (action === 'export') return new Response(bundle, { headers: { 'content-length': String(bundle.byteLength) } });
      throw new Error('Unexpected native backup call');
    };
    runtime = new Miniflare(convertV4MiniflareOptions({ cf: false, workers: [{ name: 'backup', modules: true,
      script: script.outputFiles[0]!.text, compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
      d1Databases: placement,
      r2Buckets: { BLOBS: 'backup-blobs', BACKUPS: 'backup-archives' },
      durableObjects: { ADMISSION: { className: 'AdmissionController', useSQLite: true } },
      workflows: { OPERATIONS: { name: 'automatic-backups', className: 'OperationWorkflow' } },
      bindings: shared, serviceBindings: { GIT_SERVICE: nativeRead },
    }, { name: 'api', modules: true, script: api.outputFiles[0]!.text, compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
      d1Databases: placement, bindings: { ...shared, SESSION_KEY: key,
        IDENTITY_KEYS_JSON: JSON.stringify({ current: 'test', keys: { test: base64url(new Uint8Array(32).fill(2)) } }),
        SECRETS_CLIENT_ID: 'api', SECRETS_CLIENT_KEY: serviceKey }, serviceBindings: { GIT_SERVICE: nativeRead, SECRETS: 'vault' },
    }, { name: 'vault', modules: true, script: vault.outputFiles[0]!.text, compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
      d1Databases: placement, bindings: { ...shared, SECRETS_KEK_CURRENT_ID: 'test', SECRETS_KEK_KEYRING_JSON: JSON.stringify({ test: envelopeKey }),
        SECRETS_SERVICE_KEYS_JSON: JSON.stringify({ api: { key: serviceKey, scopes: ['vault.manage', 'vault.plan', 'vault.rotate'] } }) },
    }] }));
    await runtime.ready;
    const db = await runtime.getD1Database('DB', 'backup') as unknown as D1Database;
    const source = await createTestDatabase();
    try {
      const schema = source.sqlite.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as { sql: string }[];
      for (const definition of schema) await db.prepare(definition.sql).run();
      const tables = source.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
      const seed: D1PreparedStatement[] = [db.prepare('PRAGMA defer_foreign_keys=ON')];
      for (const { name } of tables) for (const row of source.sqlite.prepare(`SELECT * FROM ${name}`).all()) {
        const fields = Object.keys(row);
        seed.push(stmt(db, `INSERT INTO ${name}(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`, ...Object.values(row)));
      }
      await db.batch(seed);
    } finally { source.close(); }
    const at = now(), until = new Date(Date.now() + 60 * 86400_000).toISOString();
    await db.batch([
      stmt(db, "INSERT INTO users(id,username,email,email_verified_at,created_at,updated_at) VALUES('u_backup','backup','backup@example.net',?,?,?)", at, at, at),
      stmt(db, "INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES('u_backup','user','backup','Backup','u_backup',?,?)", at, at),
      stmt(db, "INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES('u_backup','user','u_backup','u_backup','Backup','u_backup',?,?)", at, at),
      stmt(db, `INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
        VALUES('r_backup','u_backup','backup','backup','private','active','local','core','source','u_backup',?,?)`, at, at),
      stmt(db, "INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,epoch,state,updated_at) VALUES('r_backup','repository','local','core',1,'active',?)", at),
      stmt(db, `INSERT INTO billing_platform_pools(id,period_start,period_end,limit_units,safety_buffer_units,baseline_commitment_units,max_instances,state)
        VALUES('pool_backup',?,?,'1000000000000','0','0',10,'active')`, at, until),
      stmt(db, `INSERT INTO billing_capacity_slices(id,pool_id,cell_id,limit_units,max_instances,max_storage_bytes,valid_until,state,created_at)
        VALUES('slice_backup','pool_backup','local','1000000000000',10,'10000000000',?,'active',?)`, until, at),
    ]);
    const historicalSources = ['fork', 'pull', 'patch', 'candidate', 'review', 'workspace'].map(kind => `r_${kind}`);
    for (const id of historicalSources) await db.batch([
      stmt(db, `INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
        VALUES(?,'u_backup',?,?,'private','archived','local','core',?,'u_backup',?,?)`, id, id, id, id, at, at),
      stmt(db, `INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,status,created_at,updated_at)
        VALUES(?,'repository.backup',?,?,'u_backup','u_backup','completed',?,?)`, `op_${id}`, id, id, at, at),
    ]);
    await db.batch([
      stmt(db, "UPDATE repositories SET fork_source_id='r_fork' WHERE id='r_backup'"),
      stmt(db, `INSERT INTO collaboration_items(id,repo_id,kind,number,title,author_id,state,created_at,updated_at)
        VALUES('pr_backup','r_backup','pull_request',1,'Historical pull','u_backup','closed',?,?),('task_backup','r_backup','task',1,'Historical workspace','u_backup','open',?,?)`, at, at, at, at),
      stmt(db, "INSERT INTO pull_requests(id,repo_id,head_repo_id,base_ref,head_ref,base_oid,head_oid) VALUES('pr_backup','r_backup','r_pull','refs/heads/main','refs/heads/main',?,?)", oid, oid),
      stmt(db, `INSERT INTO pull_patches(id,repo_id,pull_id,version,head_repo_id,base_oid,head_oid,merge_base_oid,patch_fingerprint,native_evidence_id,created_by,created_at)
        VALUES('patch_backup','r_backup','pr_backup',1,'r_patch',?,?,?,'historical','review_backup','u_backup',?)`, oid, oid, oid, at),
      stmt(db, `INSERT INTO git_candidates(repo_id,id,source_repo_id,source_oid,target_ref,target_oid,internal_ref,strategy,policy_revision,actor_id,state,operation_id,created_at,updated_at)
        VALUES('r_backup','candidate_backup','r_candidate',?,'refs/heads/main',?,'refs/gitknot/candidates/historical','merge',1,'u_backup','failed','op_candidate',?,?)`, oid, oid, at, at),
      stmt(db, `INSERT INTO git_review_snapshots(repo_id,id,source_repo_id,base_oid,head_oid,operation_id,actor_id,state,created_at,updated_at)
        VALUES('r_backup','review_backup','r_review',?,?,'op_review','u_backup','failed',?,?)`, oid, oid, at, at),
      stmt(db, "INSERT INTO tasks(id,repo_id,accountable_user_id,base_oid) VALUES('task_backup','r_backup','u_backup',?)", oid),
      stmt(db, `INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,status,created_at,updated_at)
        VALUES('op_workspace','collaboration.workspace','r_backup','r_backup','u_backup','u_backup','completed',?,?)`, at, at),
      stmt(db, `INSERT INTO task_workspaces(id,repo_id,task_id,workspace_repo_id,owner_principal_id,base_oid,operation_id,state,retention_until,last_active_at,created_at,updated_at)
        VALUES('workspace_backup','r_backup','task_backup','r_workspace','u_backup',?,'op_workspace','deleted',?,?,?,?)`, oid, until, at, at, at),
      stmt(db, `INSERT INTO workflow_execution_policy(repo_id,account_id,policy_json,toolchains_json,modules_json,egress_json,updated_by,updated_at)
        VALUES('r_backup','u_backup',?,?,'{}',?,'u_backup',?)`, JSON.stringify({ access: { repository: 'read', capabilities: [], secrets: [] }, hosted_profiles: ['linux-small'], self_hosted_pools: {}, inapplicable_jobs: [] }),
      JSON.stringify({ fixture: { os: 'linux', arch: 'x64', tools: { node: '24.18.0' } } }), JSON.stringify({ hosts: [], max_bytes: 1024, max_requests: 5, max_request_bytes: 512 }), at),
    ]);
    if (outcome === 'capture-failure') await db.prepare('DROP TABLE git_review_snapshots').run();
    await runtime.dispatchFetch('https://test.invalid/start', { method: 'POST' });
    await expect.poll(async () => {
      const response = await runtime!.dispatchFetch('https://test.invalid/status');
      return response.json();
    }, { timeout: 20_000, interval: 100 }).toMatchObject({ operation: outcome === 'complete' ? { status: 'completed' } : { status: 'failed', phase: 'snapshot_abandoned' },
      fence: { state: 'released' }, archive: { state: outcome === 'complete' ? 'verified' : 'expired' } });
    expect(held.size).toBe(0);
    expect(await db.prepare("SELECT epoch,state,operation_id FROM resource_routes WHERE resource_id='r_backup'").first()).toEqual({ epoch: 1, state: 'active', operation_id: null });
    if (outcome === 'complete') expect((await db.prepare(`SELECT repository_id FROM archive_audiences WHERE archive_id IN
      (SELECT id FROM repository_archives WHERE repo_id='r_backup') ORDER BY repository_id`).all()).results.map(row => row.repository_id)).toEqual(['r_backup', ...historicalSources].sort());
    else expect(await db.prepare("SELECT COUNT(*) AS n FROM archive_snapshots").first()).toEqual({ n: 0 });
    const credential = await prepareCredential(db, { principal_id: 'u_backup', user_id: 'u_backup', kind: 'personal', name: 'Post-backup writes',
      capabilities: ['*'], repository_ids: null, account_ids: null, auth_revision: 1, mfa: false, expires_at: until, created_by: 'u_backup' });
    await credential.statement.run();
    const initialize = await signInternalRequest(new Request('https://internal.gitknot.com/internal/vault/keys/initialize', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gitknot-service-client': 'api' }, body: '{}' }), serviceKey, 'vault.rotate');
    expect((await (await runtime.getWorker('vault')).fetch(initialize.url, { method: 'POST', headers: Object.fromEntries(initialize.headers), body: '{}' })).status).toBe(200);
    const publicApi = await runtime.getWorker('api');
    const post = (path: string, body: unknown) => publicApi.fetch(`https://api.gitknot.com${path}`, { method: 'POST', headers: {
      authorization: `Bearer ${credential.token}`, 'content-type': 'application/json', 'idempotency-key': `after-${outcome}-${path.split('/').at(-1)}` }, body: JSON.stringify(body) });
    const label = await post('/v1/repos/r_backup/labels', { name: 'After backup', color: '123456' });
    expect(label.status, await label.clone().text()).toBe(201);
    const secret = await post('/v1/repos/r_backup/secrets', { name: 'AFTER_BACKUP', value: 'post-backup-private-value' });
    expect(secret.status, await secret.clone().text()).toBe(201);
    const preview = await post('/v1/repos/r_backup/workflows/validate', { source: JSON.stringify({ version: 1, name: 'verify', triggers: ['workflow.dispatch'], source: 'event.commit',
      access: { repository: 'read' }, defaults: { executor: { type: 'hosted', profile: 'linux-small' }, toolchain: 'fixture', timeout: '10m' }, jobs: { test: { steps: [{ id: '_verify', run: 'node --version' }] } } }) });
    expect(preview.status, await preview.clone().text()).toBe(200);
    expect(await preview.json()).toMatchObject({ kind: 'validation', valid: true, executable: false });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM execution_attempts').first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM vault_selections').first()).toEqual({ n: 0 });
  } finally { await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 60_000);
