import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { createTestDatabase, projectRoot } from '../support/database.ts';
import { base64url, now, prepareCredential, sha256, signInternalRequest, stmt, verifyInternalRequest } from '../../packages/core/src/index.ts';
import { startNativeServer } from '../../services/git/src/server.ts';
import { provisionFilesystemRepository, readFilesystemCreation } from '../../services/git/src/filesystem-store.ts';
import { GIT_NATIVE_SCOPE, ZERO_OID } from '../../packages/git/src/types.ts';
import type { GitStorageCreationEvidence, GitStorageProvisionOptions, NativeSessionSpec } from '../../packages/git/src/types.ts';
import { GitError } from '../../packages/git/src/errors.ts';

it('moves funded Git/R2 and exports the complete account through the composed API across real workerd cells', async () => {
  const [{ build }, { Miniflare, convertV4MiniflareOptions }] = await Promise.all([import('esbuild'), import('miniflare')]);
  const directory = await mkdtemp('/private/var/folders/zh/l70grz9n3ll9j9c_f1ghp7gr0000gn/T/opencode/move-workerd-');
  const command = promisify(execFile), key = 'workerd-physical-move-internal-key-0000000000000000';
  const git = async (...args: string[]) => (await command('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: directory,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
  const sourceName = 'workerd_source', sourcePath = join(directory, `${sourceName}.git`), stores = new Map([[sourceName, sourcePath]]);
  let runtime: InstanceType<typeof Miniflare> | undefined, native: Awaited<ReturnType<typeof startNativeServer>> | undefined;
  try {
    await git('init', '--bare', '--template=', '--initial-branch=main', sourcePath);
    const script = await build({ absWorkingDir: projectRoot, bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2023',
      conditions: ['workerd', 'browser'], mainFields: ['module', 'main'], external: ['node:*', 'cloudflare:*'], alias: { util: 'node:util', crypto: 'node:crypto' },
      banner: { js: "import {createRequire as __createRequire} from 'node:module';const require=__createRequire('/move-worker.js');" },
      stdin: { resolveDir: projectRoot, contents: `
        import {DurableObject} from 'cloudflare:workers';
        import {createApp} from './apps/api/src/index.ts';
        import background from './workers/background/src/ops/handler.ts';
        import git from './workers/git/src/gateway.ts';
        import {runShardMove} from './packages/operations/src/movement.ts';
        import {completeOperation,operationById} from './packages/operations/src/lifecycle.ts';
        import {runAccountExport} from './packages/operations/src/account-export.ts';
        import {reserveStandaloneStorage,commitStorageObject} from './packages/billing/src/index.ts';
        import {sha256} from './packages/core/src/index.ts';
        export {AdmissionController} from './packages/billing/src/controller.ts';
        export {RepositoryCoordinator} from './workers/git/src/coordinator.ts';
        export class NativeBridge extends DurableObject {fetch(request) {return this.env.NATIVE.fetch(request);}}
        const app=createApp();
        export default {async fetch(request,env,ctx) {
          const path=new URL(request.url).pathname;
          if(path==='/test/object') {
            const bytes=new TextEncoder().encode('Real R2 physical placement'),key='u_move/r_move/retained';
            const admitted=await reserveStandaloneStorage(env,{account_id:'u_move',repo_id:'r_move',actor_id:'u_move',object_id:'obj_retained',key,bucket:'blobs',maximum_bytes:String(bytes.length),retention_until:null});
            const checksum=await sha256(bytes),head=await env.BLOBS.put(key,bytes,{sha256:checksum,customMetadata:{object_id:'obj_retained',sha256:checksum}});
            await commitStorageObject(env,{account_id:'u_move',object_id:'obj_retained',reservation_id:admitted.reservation_id,fence:admitted.fence,bytes:String(bytes.length),etag:head.etag,checksum});
            return Response.json({stored:true});
          }
          if(path==='/test/move') {const {id}=await request.json();return Response.json(await runShardMove(env,await operationById(env,id)));}
          if(path==='/test/account-export') {const {id}=await request.json(),operation=await operationById(env,id),result=await runAccountExport(env,operation);await completeOperation(env,operation,result);return Response.json(result);}
          if(path.startsWith('/internal/git/')) return git.fetch(request,env);
          if(path.startsWith('/internal/operations/')||path.startsWith('/internal/moves/')||path.startsWith('/internal/account-exports/')) return background.fetch(request,env);
          return app.fetch(request,env,ctx);
        }};` } });
    const call = async (worker: string, request: Request) => (await runtime!.getWorker(worker)).fetch(request.url, { method: request.method,
      headers: Object.fromEntries(request.headers), ...(request.body ? { body: await request.arrayBuffer() } : {}) });
    const callback = async <T>(spec: NativeSessionSpec, action: string, input: unknown): Promise<T> => {
      const response = await call('source', await signInternalRequest(new Request(`${spec.callback_url}/${action}`, { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ publisher_id: spec.publisher_id, fence: spec.fence, ...input as object }) }), key, GIT_NATIVE_SCOPE));
      const value = await response.json() as T & { error?: { code: string; message: string } };
      if (!response.ok) throw new GitError(value.error?.code ?? 'callback_failed', value.error?.message ?? 'Native callback failed', response.status);
      return value;
    };
    native = await startNativeServer({ configuration: { mode: 'test', cache_root: join(directory, 'cache'), local_authority_root: directory,
      max_sessions: 8, callback_origin: 'https://git.gitknot.com' }, authenticate: request => verifyInternalRequest(request, key, GIT_NATIVE_SCOPE),
      callbacks: { validated: (spec, evidence) => callback(spec, 'validated', { evidence }), permit: (spec, evidence) => callback(spec, 'permit', { evidence_digest: evidence.digest }),
        result: (spec, result) => callback(spec, 'result', { result }), rejected: (spec, reason, code) => callback(spec, 'rejected', { reason, code }) },
    }, 0, '127.0.0.1');
    const shared = { ENVIRONMENT: 'development', SHARD_ID: 'core', SHARD_BINDINGS_JSON: '{"core":"DB"}', IDENTITY_CELL_ID: 'local', IDENTITY_SHARD_ID: 'core',
      INTERNAL_SERVICE_KEY: key, API_ORIGIN: 'https://api.gitknot.com', APP_ORIGIN: 'https://gitknot.com', GIT_ORIGIN: 'https://git.gitknot.com', GIT_STORAGE_MODE: 'local',
      IDENTITY_KEYS_JSON: JSON.stringify({ current: 'test', keys: { test: base64url(new Uint8Array(32).fill(9)) } }),
      CELL_BINDINGS_JSON: '{"local":"SOURCE","remote":"DESTINATION"}', CELL_GIT_BINDINGS_JSON: '{"local":"SOURCE","remote":"DESTINATION"}',
      CELL_BACKGROUND_BINDINGS_JSON: '{"local":"SOURCE","remote":"DESTINATION"}' };
    runtime = new Miniflare(convertV4MiniflareOptions({ cf: false, workers: ['source', 'destination'].map((name, index) => ({ name, modules: true,
      script: script.outputFiles[0]!.text, compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: `move-${name}`, IDENTITY_DB: 'move-source', DIRECTORY_DB: 'move-source' },
      r2Buckets: { BLOBS: `move-${name}-blobs`, BACKUPS: `move-${name}-backups`, BACKUP_BUCKET: `move-${name}-snapshots` },
      durableObjects: { ADMISSION: { className: 'AdmissionController', useSQLite: true }, REPO_COORDINATOR: { className: 'RepositoryCoordinator', useSQLite: true }, GIT_CONTAINERS: { className: 'NativeBridge', useSQLite: true } },
      bindings: { ...shared, CELL_ID: index ? 'remote' : 'local', BILLING_PLATFORM_SLICE_ID: `slice_${index ? 'remote' : 'local'}` },
      serviceBindings: { SOURCE: 'source', DESTINATION: 'destination', API: name, GIT_SERVICE: name, BACKGROUND: name,
        NATIVE: async request => native!.service.fetch(new Request(request.url, { method: request.method, headers: Object.fromEntries(request.headers),
          ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: await request.arrayBuffer() }) })) },
      outboundService: async request => {
        const url = new URL(request.url);
        if (url.origin !== 'http://127.0.0.1:8792') throw new Error('Unexpected provider network request');
        const incoming = new Request(`http://git-local.internal${url.pathname}`, { method: request.method, headers: Object.fromEntries(request.headers),
          ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: await request.arrayBuffer() }) });
        await verifyInternalRequest(incoming, key, 'git-local-storage');
        const storage = /^\/repositories\/([\w-]+)$/.exec(url.pathname)?.[1];
        if (!storage) return new Response(null, { status: 404 });
        const path = stores.get(storage) ?? join(directory, 'target', `${storage}.git`);
        let created: true | undefined, creation: GitStorageCreationEvidence | undefined;
        if (request.method === 'PUT') {
          const body = await incoming.json() as { default_branch: string } & GitStorageProvisionOptions;
          await mkdir(join(directory, 'target'), { recursive: true });
          try {
            ({ created, creation } = await provisionFilesystemRepository(path, body.default_branch, body));
          } catch (error) {
            if (error instanceof GitError && error.code === 'storage_namespace_exists' && (error.cause as { proof?: string } | undefined)?.proof === 'not_started') {
              return Response.json({ error: { code: error.code, proof: 'not_started' } }, { status: 409 });
            }
            throw error;
          }
          stores.set(storage, path);
        }
        if (request.method === 'DELETE') { await rm(path, { recursive: true, force: true }); stores.delete(storage); }
        else {
          try { await stat(join(path, 'HEAD')); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response(null, { status: 404 }); throw error; }
          creation ??= await readFilesystemCreation(path) ?? undefined;
        }
        return Response.json({ remote: pathToFileURL(path).href, ...(created ? { created } : {}), ...(creation ? { creation } : {}) });
      },
    })) }));
    await runtime.ready;
    const db = await runtime.getD1Database('DB', 'source') as unknown as D1Database;
    const target = await runtime.getD1Database('DB', 'destination') as unknown as D1Database;
    const schema = await createTestDatabase();
    try {
      const definitions = schema.sqlite.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as { sql: string }[];
      const tables = schema.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
      for (const binding of [db, target]) {
        for (const definition of definitions) await binding.prepare(definition.sql).run();
        const seed = [binding.prepare('PRAGMA defer_foreign_keys=ON')];
        for (const { name } of tables) for (const row of schema.sqlite.prepare(`SELECT * FROM ${name}`).all()) {
          const fields = Object.keys(row); seed.push(stmt(binding, `INSERT INTO ${name}(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`, ...Object.values(row)));
        }
        await binding.batch(seed);
      }
    } finally { schema.close(); }
    const at = now(), until = new Date(Date.now() + 60 * 86400_000).toISOString();
    await db.batch([
      stmt(db, "INSERT INTO users(id,username,email,email_verified_at,created_at,updated_at) VALUES('u_move','move','move@example.net',?,?,?)", at, at, at),
      stmt(db, "INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES('u_move','user','move','Move','u_move',?,?)", at, at),
      stmt(db, "INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES('u_move','user','u_move','u_move','Move','u_move',?,?)", at, at),
      stmt(db, `INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
        VALUES('r_move','u_move','move','move','private','active','local','core','workerd_source','u_move',?,?)`, at, at),
      stmt(db, "INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,epoch,state,updated_at) VALUES('r_move','repository','local','core',1,'active',?)", at),
      stmt(db, "INSERT INTO billing_platform_pools(id,period_start,period_end,limit_units,safety_buffer_units,baseline_commitment_units,max_instances,state) VALUES('pool_move',?,?,'1000000000000','0','0',10,'active')", at, until),
      ...['local', 'remote'].map(cell => stmt(db, "INSERT INTO billing_capacity_slices(id,pool_id,cell_id,limit_units,max_instances,max_storage_bytes,valid_until,state,created_at) VALUES(?,'pool_move',?,'500000000000',5,'10000000000',?,'active',?)", `slice_${cell}`, cell, until, at)),
    ]);
    const credential = await prepareCredential(db, { principal_id: 'u_move', user_id: 'u_move', kind: 'personal', name: 'Initial Git publication', capabilities: ['*'],
      repository_ids: null, account_ids: null, auth_revision: 1, mfa: false, expires_at: until, created_by: 'u_move' });
    await credential.statement.run();
    const actor = { id: 'u_move', kind: 'user', user_id: 'u_move', credential_id: credential.credential.id, capabilities: ['*'], repository_ids: null, account_ids: null, mfa: false };
    const signed = async (path: string, value: unknown, scope: string) => call('source', await signInternalRequest(new Request(`https://internal.gitknot.com${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }), key, scope));
    const initial = await signed('/internal/git/repositories/r_move/mutate', { operation_id: 'gop_seed', actor, mutation: { kind: 'edit', ref: 'refs/heads/main', expected_oid: ZERO_OID,
      message: 'Workerd source', author: { name: 'Move fixture', email: 'move@example.net' }, edits: [{ path: 'README.md', content_base64: Buffer.from('Workerd native graph\n').toString('base64') }] } }, 'git-service');
    expect(initial.status, await initial.clone().text()).toBe(200);
    const oid = await git('--git-dir', sourcePath, 'rev-parse', 'refs/heads/main');
    expect((await runtime.dispatchFetch('https://test.invalid/test/object', { method: 'POST' })).status).toBe(200);
    const accepted = await signed('/internal/operations/move', { repo_id: 'r_move', target_cell_id: 'remote', target_shard_id: 'core', expected_epoch: 1 }, 'operations.maintenance');
    expect(accepted.status, await accepted.clone().text()).toBe(202);
    const { id } = await accepted.json() as { id: string };
    const moved = await runtime.dispatchFetch('https://test.invalid/test/move', { method: 'POST', body: JSON.stringify({ id }) });
    expect(moved.status, await moved.clone().text()).toBe(200);
    expect(await moved.json()).toMatchObject({ moved: true, routing_epoch: 2 });
    const control = await db.prepare('SELECT * FROM repository_move_controls WHERE operation_id=?').bind(id).first<{ state: string; target_storage_name: string; effective_at: string }>();
    expect(control?.state).toBe('completed');
    expect(stores.has(sourceName)).toBe(false);
    expect(await git('--git-dir', stores.get(control!.target_storage_name)!, 'rev-parse', 'refs/heads/main')).toBe(oid);
    const sourceBucket = await runtime.getR2Bucket('BLOBS', 'source'), targetBucket = await runtime.getR2Bucket('BLOBS', 'destination');
    expect(await sourceBucket.head('u_move/r_move/retained')).toBeNull();
    expect(await (await targetBucket.get('u_move/r_move/retained'))!.text()).toBe('Real R2 physical placement');
    for (const binding of [db, target]) expect(await binding.prepare("SELECT state FROM repository_metadata_fences WHERE repo_id='r_move'").first()).toEqual({ state: 'released' });
    expect((await target.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    const api = await runtime.getWorker('source');
    const exported = await api.fetch('https://api.gitknot.com/v1/accounts/u_move/exports', { method: 'POST', headers: {
      authorization: `Bearer ${credential.token}`, 'content-type': 'application/json', 'idempotency-key': 'workerd-account-export' }, body: '{}' });
    expect(exported.status, await exported.clone().text()).toBe(202);
    const account = await exported.json() as { id: string; operation: { id: string } };
    const captured = await runtime.dispatchFetch('https://test.invalid/test/account-export', { method: 'POST', body: JSON.stringify({ id: account.operation.id }) });
    expect(captured.status, await captured.clone().text()).toBe(200);
    const downloaded = await api.fetch(`https://api.gitknot.com/v1/accounts/u_move/exports/${account.id}/download`, { headers: { authorization: `Bearer ${credential.token}` } });
    expect(downloaded.status).toBe(200);
    const accountBytes = new Uint8Array(await downloaded.arrayBuffer());
    expect(downloaded.headers.get('etag')).toBe(`"${await sha256(accountBytes)}"`);
    const manifestBytes = accountBytes.slice(512, 512 + Number.parseInt(new TextDecoder().decode(accountBytes.slice(124, 136)).replace(/\0/g, '').trim(), 8));
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as { format: string; coverage: { complete: boolean; repository_count: number }; repositories: { repo_id: string }[] };
    expect(manifest).toMatchObject({ format: 'gitknot.account', coverage: { complete: true, repository_count: 1 }, repositories: [{ repo_id: 'r_move' }] });
  } finally { await native?.close(); await runtime?.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 120_000);
