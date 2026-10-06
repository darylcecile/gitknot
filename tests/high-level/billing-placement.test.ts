import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { AdmissionController, admissionRequest, billingMetadata, commitStorageObject, deleteStorageObject, handleBillingAdmissionRequest,
  handleBillingPhysicalRequest, handleStoragePlacementRequest, reserveCanonicalGitStorage, commitCanonicalGitStorage, reserveStandaloneStorage,
  prepareRepositoryStoragePlacement, copyRepositoryStoragePlacement, commitRepositoryStoragePlacement, finalizeRepositoryStoragePlacement,
  abortRepositoryStoragePlacement, storagePlacement } from '../../packages/billing/src/index.ts';
import { beginPlacementGitProvision, placementGitProvisionMarker, confirmPlacementGitProvision, handlePlacementGitRequest } from '../../packages/billing/src/placement-git.ts';
import { beginPlacementScratch, confirmPlacementScratch, deletePlacementScratch } from '../../packages/billing/src/placement-scratch.ts';
import { PlacementAdmissionBook } from '../../packages/billing/src/placement-book.ts';
import { placementStorageName } from '../../packages/billing/src/placement-state.ts';
import type { PlacementGitHold } from '../../packages/billing/src/placement-types.ts';
import type { CanonicalGitMeter } from '../../packages/billing/src/git-types.ts';
import { provisionFilesystemRepository, readFilesystemCreation } from '../../services/git/src/filesystem-store.ts';
import type { AdmissionControl, BillingBindings, Budget, StorageObject } from '../../packages/billing/src/types.ts';
import { ApiError, canonicalJson, handleRoutingRpc, now, one, sha256, stmt } from '../../packages/core/src/index.ts';
import { createTestEnvironment } from '../support/environment.ts';
import { createTestDatabase } from '../support/database.ts';
import { TestBucket } from '../support/storage.ts';

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanups.splice(0).reverse()) await close(); });
const oid = 'op_physical_move', repoId = 'r_placement', accountId = 'u_placement';
const temp = '/private/var/folders/zh/l70grz9n3ll9j9c_f1ghp7gr0000gn/T/opencode';
type Totals = { control: AdmissionControl; budgets: Budget[] };

class MemoryStorage {
  private data = new Map<string, unknown>();
  private tail: Promise<unknown> = Promise.resolve();
  async get<T>(key: string): Promise<T | undefined> { return structuredClone(this.data.get(key)) as T | undefined; }
  async put(key: string, value: unknown): Promise<void> { this.data.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.data.delete(key); }
  async list<T>(options: { prefix?: string; limit?: number; startAfter?: string } = {}): Promise<Map<string, T>> {
    return new Map([...this.data].filter(([key]) => key.startsWith(options.prefix ?? '') && key > (options.startAfter ?? '')).sort(([a], [b]) => a < b ? -1 : 1)
      .slice(0, options.limit ?? Infinity).map(([key, value]) => [key, structuredClone(value) as T]));
  }
  async transaction<T>(run: (tx: MemoryStorage) => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => { const before = structuredClone(this.data); try { return await run(this); } catch (error) { this.data = before; throw error; } });
    this.tail = next.catch(() => undefined); return next;
  }
  async setAlarm(): Promise<void> {}
}

function namespace(env: BillingBindings) {
  const objects = new Map<string, AdmissionController>();
  const binding = { idFromName: (id: string) => ({ toString: () => id }), get(id: { toString(): string }) {
    const name = id.toString();
    if (!objects.has(name)) objects.set(name, new AdmissionController({ storage: new MemoryStorage(), blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn() } as unknown as DurableObjectState, env));
    return { fetch: (request: Request) => objects.get(name)!.fetch(request) };
  } } as unknown as DurableObjectNamespace;
  return { binding, objects };
}

function git(directory: string, args: string[], input?: string): string {
  return execFileSync('git', ['--git-dir', directory, ...args], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Placement test', GIT_AUTHOR_EMAIL: 'placement@example.test', GIT_COMMITTER_NAME: 'Placement test', GIT_COMMITTER_EMAIL: 'placement@example.test' } }).trim();
}
function refs(directory: string) {
  return git(directory, ['for-each-ref', '--format=%(refname) %(objectname)']).split('\n').filter(line => line && !line.startsWith('refs/gitknot/transactions/'))
    .map(line => { const [ref, oid] = line.split(' '); return { ref: ref!, oid: oid! }; });
}

async function exists(directory: string): Promise<boolean> {
  try { await stat(join(directory, 'HEAD')); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function fixture(options: { sameCell?: boolean; operationId?: string; archive?: boolean } = {}) {
  const sameCell = options.sameCell ?? false, oid = options.operationId ?? 'op_physical_move';
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-05T12:00:00.000Z');
  const test = await createTestEnvironment(), targetDb = await createTestDatabase(); cleanups.push(() => test.close(), () => targetDb.close());
  const root = await mkdtemp(join(temp, 'gitknot-placement-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const sourceGit = join(root, 'source.git'), targetGit = join(root, `${await placementStorageName(repoId, oid)}.git`);
  const storageDirectory = (name: string) => name === 'canonical_source' ? sourceGit : join(root, `${name}.git`);
  execFileSync('git', ['init', '--bare', sourceGit], { stdio: 'pipe' });
  const blob = git(sourceGit, ['hash-object', '-w', '--stdin'], 'physical source\n');
  const tree = git(sourceGit, ['mktree'], `100644 blob ${blob}\tfile.txt\n`);
  const commit = git(sourceGit, ['commit-tree', tree], 'source\n'); git(sourceGit, ['update-ref', 'refs/heads/main', commit]);
  const archiveGit = options.archive ? join(root, 'archive.git') : sourceGit;
  let archiveHead = commit;
  if (options.archive) {
    execFileSync('git', ['init', '--bare', archiveGit], { stdio: 'pipe' });
    const archivedBlob = git(archiveGit, ['hash-object', '-w', '--stdin'], 'historical archive bytes\n'.repeat(150000));
    const archivedTree = git(archiveGit, ['mktree'], `100644 blob ${archivedBlob}\tarchive.txt\n`);
    archiveHead = git(archiveGit, ['commit-tree', archivedTree], 'historical archive\n');
    git(archiveGit, ['update-ref', 'refs/heads/main', archiveHead]);
  }
  const bundle = execFileSync('git', ['--git-dir', archiveGit, 'bundle', 'create', '-', '--all'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const targetBlobs = new TestBucket(), targetBackups = new TestBucket(), sourceSnapshots = new TestBucket(), targetSnapshots = new TestBucket();
  const source = { ...test.env, IDENTITY_DB: test.env.DB, IDENTITY_CELL_ID: 'local', IDENTITY_SHARD_ID: 'core',
    BACKUP_BUCKET: sourceSnapshots.binding(), BILLING_PLATFORM_SLICE_ID: 'slice_source', BILLING_GIT_STORAGE_SLICE_ID: 'slice_source' } as BillingBindings;
  const targetCell = sameCell ? 'local' : 'target', targetShard = sameCell ? 'next' : 'target';
  const target = { ...source, DB: targetDb.binding(), CELL_ID: targetCell, SHARD_ID: targetShard, BLOBS: sameCell ? source.BLOBS : targetBlobs.binding(), BACKUPS: sameCell ? source.BACKUPS : targetBackups.binding(), BACKUP_BUCKET: sameCell ? source.BACKUP_BUCKET : targetSnapshots.binding(),
    BILLING_PLATFORM_SLICE_ID: 'slice_target', BILLING_GIT_STORAGE_SLICE_ID: 'slice_target' } as BillingBindings;
  const sourceNetwork = namespace(source), targetNetwork = namespace(target); source.ADMISSION = sourceNetwork.binding; target.ADMISSION = targetNetwork.binding;
  if (sameCell) {
    source.SHARD_BINDINGS_JSON = '{"next":"TARGET_METADATA"}'; source.TARGET_METADATA = targetDb.binding();
    Object.assign(target, { ADMISSION: source.ADMISSION, BILLING_PLATFORM_SLICE_ID: 'slice_source', BILLING_GIT_STORAGE_SLICE_ID: 'slice_source',
      SHARD_BINDINGS_JSON: '{"core":"SOURCE_METADATA","next":"DB"}', SOURCE_METADATA: source.DB });
  }
  const api = (env: BillingBindings) => ({ fetch: async (request: Request) => {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/internal/routing') return (await handleRoutingRpc(request, env))!;
      if (path === '/internal/billing/admission') return await handleBillingAdmissionRequest(request, env);
      if (path === '/internal/billing/physical') return await handleBillingPhysicalRequest(request, env);
      if (path === '/internal/billing/metadata') return Response.json(await billingMetadata(env, await request.json() as { repo_id: string }));
      return await handleStoragePlacementRequest(request, env);
    } catch (error) { return Response.json({ error: { code: error instanceof ApiError ? error.code : 'test_transport_error', message: String(error) } }, { status: error instanceof ApiError ? error.status : 503 }); }
  } }) as unknown as Fetcher;
  const sourceApi = api(source), targetApi = api(target);
  const closedPublishers = new Set<string>();
  const native = (env: BillingBindings) => ({ fetch: async (request: Request) => {
    try { return await handlePlacementGitRequest(request, env, {
      exists: name => exists(storageDirectory(name)),
      observeCreation: p => readFilesystemCreation(storageDirectory(p.target_storage_name)),
      async verify(_placement, name) { const directory = storageDirectory(name); git(directory, ['fsck', '--full']); return { verified: true, objects_verified: true, refs: refs(directory) }; },
      async reconcilePublisher(p, side) {
        closedPublishers.add(`${p.operation_id}:${side}`);
        const journal = await one<{ state: string; finalized: number }>(side === 'source' ? source.DB : target.DB,
          'SELECT state,finalized FROM git_publications WHERE repo_id=? AND id=?', p.repo_id, p.operation_id);
        if (journal && (!journal.finalized || !['committed','rejected'].includes(journal.state))) throw new ApiError(409, 'publication_in_progress', 'The original publication is not finalized.');
        return { version: 1, operation_id: p.operation_id, repo_id: p.repo_id, storage_name: p[`${side}_storage_name`], placement_fence: p.fence,
          side, source_epoch: p.source_epoch, target_epoch: p.target_epoch, state: journal ? journal.state as 'committed' | 'rejected' : 'not_started', finalized: true, writer_fenced: true };
      },
      async delete(name) { await rm(storageDirectory(name), { recursive: true, force: true }); },
    }); } catch (error) { return Response.json({ error: { code: error instanceof ApiError ? error.code : 'test_native_error', message: String(error) } }, { status: error instanceof ApiError ? error.status : 503 }); }
  } }) as unknown as Fetcher;
  source.GIT_SERVICE = native(source); target.GIT_SERVICE = native(target);
  for (const env of [source, target]) Object.assign(env, { CELL_BINDINGS_JSON: '{"local":"API_SOURCE","target":"API_TARGET"}', API_SOURCE: sourceApi, API_TARGET: targetApi,
    CELL_GIT_BINDINGS_JSON: '{"local":"GIT_SOURCE","target":"GIT_TARGET"}', GIT_SOURCE: source.GIT_SERVICE, GIT_TARGET: target.GIT_SERVICE });
  const at = now();
  await source.DB.batch([
    stmt(source.DB, "INSERT INTO users(id,username,email,email_verified_at,created_at,updated_at) VALUES (?,'placement','placement@example.test',?,?,?)", accountId, at, at, at),
    stmt(source.DB, "INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES (?,'user','placement','Placement',?,?,?)", accountId, accountId, at, at),
    stmt(source.DB, "INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES (?,'user',?,?,'Placement',?,?,?)", accountId, accountId, accountId, accountId, at, at),
    stmt(source.DB, "INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at) VALUES (?,?,'placement','placement','private','active','local','core','canonical_source',?,?,?)", repoId, accountId, accountId, at, at),
    stmt(source.DB, "INSERT INTO billing_platform_pools(id,period_start,period_end,limit_units,safety_buffer_units,baseline_commitment_units,max_instances,state) VALUES('pool',?,'2099-01-01T00:00:00.000Z','1000000000000','1000000','1000000',4,'active')", at),
    ...[['slice_source','local'], ['slice_target','target']].map(([id, cell]) => stmt(source.DB, "INSERT INTO billing_capacity_slices(id,pool_id,cell_id,limit_units,max_instances,max_storage_bytes,valid_until,state,created_at) VALUES (?,'pool',?,'100000000000',2,'100000000000','2099-01-01T00:00:00.000Z','active',?)", id, cell, at)),
  ]);
  const publish = async (env: BillingBindings, directory: string, operation: string, epoch: number, name: string, perform?: () => void,
    graph = sourceGit, head = commit, beforeAccept?: () => Promise<void>) => {
    if (closedPublishers.has(`${operation}:target`)) throw new ApiError(409, 'publisher_closed', 'The original publisher is permanently closed.');
    const objects = git(graph, ['rev-list', '--objects', '--no-object-names', head]).split('\n');
    const bytes = objects.reduce((n, object) => n + BigInt(git(graph, ['cat-file', '-s', object])), 0n).toString();
    const empty = git(directory, ['mktree'], ''), marker = git(directory, ['commit-tree', empty], `transaction ${operation}\n`), markerBytes = git(directory, ['cat-file', '-s', marker]);
    const updates = [{ ref: 'refs/heads/main', old_oid: '0'.repeat(40), new_oid: head }];
    const body = { version: 1, policy_revision: 1, updates, storage: { model: 'logical-reachable-v1', baseline_bytes: '0', reachable_bytes: bytes,
      new_object_bytes: bytes, object_count: String(objects.length), object_manifest_digest: await sha256(objects.join('\n')), maximum_growth_bytes: (BigInt(bytes) + BigInt(markerBytes) + 2048n).toString() } };
    const evidence = { ...body, digest: await sha256(JSON.stringify(body)), marker_oid: marker, marker_object_bytes: markerBytes };
    const context = { repository: { owner_id: accountId, storage_name: name }, storage_admission: { requested: true } as Record<string, unknown> };
    await env.DB.prepare(`INSERT INTO git_publications(repo_id,id,actor_id,actor_json,kind,state,routing_epoch,policy_revision,publisher_id,context_json,evidence_json,created_at,updated_at)
      VALUES(?,?,?,'{}',?,'validated',?,1,'publication',?,?,?,?)`).bind(repoId, operation, accountId, epoch === 1 ? 'push' : 'restore', epoch, JSON.stringify(context), JSON.stringify(evidence), now(), now()).run();
    const grant = await reserveCanonicalGitStorage(env, { account_id: accountId, repo_id: repoId, actor_id: accountId, operation_id: operation,
      storage_name: name, routing_epoch: epoch, maximum_growth_bytes: body.storage.maximum_growth_bytes, retention_until: null });
    context.storage_admission = { requested: true, ...grant };
    await env.DB.prepare("UPDATE git_publications SET state='publishing',context_json=? WHERE repo_id=? AND id=?").bind(JSON.stringify(context), repoId, operation).run();
    await beforeAccept?.();
    perform?.(); git(directory, ['update-ref', `refs/gitknot/transactions/${operation}`, marker]);
    await env.DB.prepare("UPDATE git_publications SET state='committed',context_json=?,result_json=?,updated_at=? WHERE repo_id=? AND id=?")
      .bind(JSON.stringify(context), JSON.stringify({ operation_id: operation, outcome: 'committed', marker_oid: marker, proof: 'marker', refs: updates }), now(), repoId, operation).run();
    await commitCanonicalGitStorage(env, { account_id: accountId, repo_id: repoId, operation_id: operation, ...grant, reachable_bytes: bytes,
      new_object_bytes: (BigInt(bytes) + BigInt(markerBytes)).toString(), object_count: body.storage.object_count, evidence_digest: evidence.digest, marker_oid: marker, verified_at: now() });
    await env.DB.prepare('UPDATE git_publications SET finalized=1 WHERE repo_id=? AND id=?').bind(repoId, operation).run();
  };
  await publish(source, sourceGit, 'initial_publication', 1, 'canonical_source');
  const objects: StorageObject[] = [];
  for (const [i, bucket] of ['blobs','backups','snapshots'].entries()) {
    const object = await reserveStandaloneStorage(source, { account_id: accountId, repo_id: repoId, actor_id: accountId, object_id: `obj_place_${i}`,
      key: `${accountId}/${repoId}/objects/${i}`, bucket: bucket as StorageObject['bucket'], maximum_bytes: '16', retention_until: null });
    const store = bucket === 'blobs' ? test.blobs : bucket === 'backups' ? test.backups : sourceSnapshots;
    const value = `stored-${i}`, head = await store.put(object.key, value);
    objects.push(await commitStorageObject(source, { account_id: accountId, object_id: object.id, reservation_id: object.reservation_id, fence: object.fence,
      bytes: String(value.length), etag: head!.etag, checksum: await sha256(value) }));
  }
  for (const table of ['users','accounts','principals','repositories']) for (const row of test.db.sqlite.prepare(`SELECT * FROM ${table}`).all()) {
    await targetDb.prepare(`INSERT OR IGNORE INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).bind(...Object.values(row)).run();
  }
  await targetDb.prepare("UPDATE repositories SET cell_id=?,shard_id=?,routing_epoch=2,state='moving' WHERE id=?").bind(targetCell, targetShard, repoId).run();
  const input = { operation_id: oid, repo_id: repoId, source_cell_id: 'local', source_shard_id: 'core', target_cell_id: targetCell, target_shard_id: targetShard, source_epoch: 1 };
  const archiveId = options.archive ? 'archive_placement_history' : null;
  if (archiveId) {
    const manifestKey = `${accountId}/${repoId}/archive/manifest.json`;
    const manifest = canonicalJson({ archive_id: archiveId, repository: { id: repoId }, git: { bytes: bundle.length, sha256: await sha256(bundle), refs: refs(archiveGit) } });
    await test.backups.put(manifestKey, manifest);
    await source.DB.batch([
      stmt(source.DB, "INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,status,created_at,updated_at) VALUES('op_archive_placement','repository.backup',?,?,?,?,'completed',?,?)", repoId, repoId, accountId, accountId, at, at),
      stmt(source.DB, `INSERT INTO repository_archives(id,operation_id,repo_id,account_id,kind,state,routing_epoch,revision,created_at,expires_at,manifest_key,manifest_sha256)
        VALUES(?,'op_archive_placement',?,?,'backup','verified',1,1,?,'2099-01-01T00:00:00.000Z',?,?)`, archiveId, repoId, accountId, at, manifestKey, await sha256(manifest)),
    ]);
  }
  await source.DB.batch([
    stmt(source.DB, "UPDATE repositories SET state='moving' WHERE id=?", repoId),
    stmt(source.DB, "INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,status,input_json,created_at,updated_at) VALUES(?,'repository.move',?,?,?,?,'running',?,?,?)", oid, repoId, repoId, accountId, accountId, canonicalJson(archiveId ? { archive_id: archiveId } : {}), at, at),
    stmt(source.DB, "INSERT INTO repository_move_requests(operation_id,repo_id,expected_epoch,request_sha256,source_cell_id,source_shard_id,target_cell_id,target_shard_id,source_state,created_at) VALUES(?,?,1,?,'local','core',?,?,'active',?)", oid, repoId,
      await sha256(canonicalJson({ repo_id: repoId, target_cell_id: targetCell, target_shard_id: targetShard, expected_epoch: 1, archive_id: archiveId, actor_id: accountId })), targetCell, targetShard, at),
    stmt(source.DB, "INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,epoch,state,destination_cell_id,destination_shard_id,operation_id,updated_at) VALUES(?,'repository','local','core',1,'fenced',?,?,?,?)", repoId, targetCell, targetShard, oid, at),
    stmt(source.DB, "INSERT INTO repository_metadata_fence_receipts(operation_id,repo_id,routing_epoch,fence_id,acquired_at) VALUES(?,?,1,'metadata_placement',?)", oid, repoId, at),
    stmt(source.DB, "INSERT INTO repository_metadata_fences(repo_id,operation_id,routing_epoch,fence_id,state,updated_at) VALUES(?,?,1,'metadata_placement','held',?)", repoId, oid, at),
  ]);
  const nativeCopy = async (beforeAccept?: () => Promise<void>) => {
    const p = await storagePlacement(source, oid);
    const digest = await sha256(bundle);
    const scratch = await beginPlacementScratch(target, { operation_id: oid, bytes: String(bundle.length), checksum: digest });
    expect(scratch?.write).toBe(true);
    await (sameCell ? test.blobs : targetBlobs).put(scratch!.key, bundle, { sha256: digest, customMetadata: { billing_placement_scratch: oid } });
    await confirmPlacementScratch(target, oid);
    expect(await beginPlacementGitProvision(target, oid, p.target_storage_name, () => exists(targetGit))).toBe(true);
    const created = await provisionFilesystemRepository(targetGit, 'main', { create_only: true,
      ownership_marker: await placementGitProvisionMarker(target, oid, p.target_storage_name) });
    expect(created.created).toBe(true); expect(created.creation).toBeDefined();
    await confirmPlacementGitProvision(target, oid, p.target_storage_name, created.creation!);
    await publish(target, targetGit, oid, 2, p.target_storage_name, () => { git(targetGit, ['fetch', archiveGit, '+refs/heads/*:refs/heads/*']); }, archiveGit, archiveHead, beforeAccept);
    await deletePlacementScratch(target, oid);
  };
  const cutover = async () => {
    await targetDb.prepare("UPDATE repositories SET state='active',storage_name=? WHERE id=?").bind((await storagePlacement(source, oid)).target_storage_name, repoId).run();
    await source.DB.prepare("UPDATE resource_routes SET cell_id=?,shard_id=?,epoch=2,state='active',operation_id=NULL,destination_cell_id=NULL,destination_shard_id=NULL WHERE resource_id=?").bind(targetCell, targetShard, repoId).run();
  };
  return { ...test, source, target, sourceNetwork, targetNetwork, targetBlobs, targetBackups, sourceSnapshots, targetSnapshots, objects, input, sourceGit, targetGit,
    nativeCopy, cutover, storageDirectory, archiveGit, bundle };
}

describe('two-cell physical billing handoff', () => {
  it('moves metadata within a cell without duplicating storage or inventing a capacity allocation', async () => {
    const t = await fixture({ sameCell: true });
    const before = await admissionRequest<Totals>(t.source, `account:${accountId}`, 'snapshot');
    const ledger = await one(t.source.DB, 'SELECT COUNT(*) AS count FROM billing_ledger');
    await prepareRepositoryStoragePlacement(t.source, t.input); await copyRepositoryStoragePlacement(t.source, { operation_id: oid });
    await commitRepositoryStoragePlacement(t.source, { operation_id: oid }); await t.cutover(); await finalizeRepositoryStoragePlacement(t.source, { operation_id: oid });
    expect((await storagePlacement(t.source, oid)).target_slice_id).toBeNull();
    const after = await admissionRequest<Totals>(t.source, `account:${accountId}`, 'snapshot');
    expect(after.control.stored_bytes).toBe(before.control.stored_bytes); expect(after.control.reserved_bytes).toBe('0');
    expect(await one(t.source.DB, 'SELECT COUNT(*) AS count FROM billing_ledger')).toEqual(ledger);
    expect((await admissionRequest<StorageObject>(t.source, `account:${accountId}`, 'get-object', { object_id: t.objects[0]!.id }))).toMatchObject({ storage_cell_id: 'local', storage_epoch: 2 });
    expect(await t.blobs.head(t.objects[0]!.key)).not.toBeNull();
  });

  it('keeps case-distinct operation and repository namespaces separate and deletes only an owned creation', async () => {
    const operationA = 'op_A0123456789abcdef0123456789abcdef', operationB = 'op_B0123456789abcdef0123456789abcdef';
    const t = await fixture({ operationId: operationA });
    await prepareRepositoryStoragePlacement(t.source, t.input);
    const p = await storagePlacement(t.source, operationA), otherName = await placementStorageName(repoId, operationB);
    expect(p.target_storage_name).not.toBe(otherName);
    expect(p.target_storage_name).not.toBe(await placementStorageName('R_placement', operationA));
    const foreign = t.storageDirectory(otherName);
    await provisionFilesystemRepository(foreign, 'foreign', { create_only: true });
    await expect(beginPlacementGitProvision(t.target, operationA, otherName, () => exists(foreign))).rejects.toMatchObject({ code: 'placement_git_fenced' });
    expect(await beginPlacementGitProvision(t.target, operationA, p.target_storage_name, () => exists(t.targetGit))).toBe(true);
    const created = await provisionFilesystemRepository(t.targetGit, 'owned', { create_only: true,
      ownership_marker: await placementGitProvisionMarker(t.target, operationA, p.target_storage_name) });
    expect(created.creation).toBeDefined();
    await confirmPlacementGitProvision(t.target, operationA, p.target_storage_name, created.creation!);
    expect(await beginPlacementGitProvision(t.target, operationA, p.target_storage_name, () => exists(t.targetGit))).toBe(false);
    await abortRepositoryStoragePlacement(t.source, { operation_id: operationA });
    expect(await exists(t.targetGit)).toBe(false);
    expect(git(foreign, ['symbolic-ref', 'HEAD'])).toBe('refs/heads/foreign');
    expect(await one(t.source.DB, 'SELECT state FROM billing_placement_namespaces WHERE operation_id=?', operationA)).toEqual({ state: 'deleted' });
    expect(await one(t.source.DB, 'SELECT COUNT(*) AS count FROM billing_git_rejections WHERE operation_id=?', operationA)).toEqual({ count: 0 });
    await expect(beginPlacementGitProvision(t.target, operationA, p.target_storage_name, () => exists(t.targetGit))).rejects.toMatchObject({ code: 'placement_git_fenced' });
  });

  it('closes every participant before compensation so an already-captured source grant cannot re-fence after abort', async () => {
    const t = await fixture(), before = await admissionRequest<Totals>(t.source, `account:${accountId}`, 'snapshot');
    const original = PlacementAdmissionBook.prototype.fencePlacementGit;
    let reached!: () => void, release!: () => void, delayed = false;
    const captured = new Promise<void>(resolve => { reached = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    const intercept = vi.spyOn(PlacementAdmissionBook.prototype, 'fencePlacementGit').mockImplementation(async function (this: PlacementAdmissionBook, p, cell) {
      if (!delayed && p.operation_id === oid && (await this.store.get<AdmissionControl>('control'))?.id === 'capacity:slice_source') {
        delayed = true; reached(); await resume;
      }
      return original.call(this, p, cell);
    });
    try {
      const preparing = prepareRepositoryStoragePlacement(t.source, t.input);
      const rejected = expect(preparing).rejects.toMatchObject({ code: 'placement_fenced' });
      await captured;
      expect((await abortRepositoryStoragePlacement(t.source, { operation_id: oid })).state).toBe('aborted');
      release(); await rejected;
      for (const participant of [`account:${accountId}`, 'capacity:slice_source']) {
        const meter = await admissionRequest<CanonicalGitMeter>(t.source, participant, 'git-meter', { repo_id: repoId, storage_name: 'canonical_source' });
        expect(meter.state).toBe('stored'); expect(meter.placement_handoff_id).toBeUndefined();
      }
      const after = await admissionRequest<Totals>(t.source, `account:${accountId}`, 'snapshot');
      expect(after.control.reserved_bytes).toBe('0'); expect(after.control.stored_bytes).toBe(before.control.stored_bytes);
      expect(await exists(t.targetGit)).toBe(false);
      await expect(admissionRequest(t.source, 'capacity:slice_source', 'placement-git-source', { operation_id: oid })).rejects.toMatchObject({ code: 'placement_fenced' });
    } finally { release(); intercept.mockRestore(); }
  });

  it('preserves stores and financial holds until a delayed permitted publisher settles its actual committed outcome', async () => {
    const t = await fixture();
    await prepareRepositoryStoragePlacement(t.source, t.input); await copyRepositoryStoragePlacement(t.source, { operation_id: oid });
    let reached!: () => void, release!: () => void;
    const permitted = new Promise<void>(resolve => { reached = resolve; }), resume = new Promise<void>(resolve => { release = resolve; });
    const publishing = t.nativeCopy(async () => { reached(); await resume; });
    try {
      await permitted;
      const before = await admissionRequest<Totals>(t.source, `account:${accountId}`, 'snapshot');
      await expect(abortRepositoryStoragePlacement(t.source, { operation_id: oid })).rejects.toMatchObject({ code: 'placement_git_unconfirmed' });
      expect(await one(t.source.DB, 'SELECT COUNT(*) AS count FROM billing_placement_namespace_cleanup')).toEqual({ count: 0 });
      expect((await admissionRequest<Totals>(t.source, `account:${accountId}`, 'snapshot')).control.reserved_bytes).toBe(before.control.reserved_bytes);
      expect(await t.targetBlobs.head(t.objects[0]!.key)).not.toBeNull(); expect(await exists(t.targetGit)).toBe(true);
      const scratch = (await one<{ object_key: string }>(t.source.DB, 'SELECT object_key FROM billing_placement_scratch WHERE operation_id=?', oid))!;
      expect(await t.targetBlobs.head(scratch.object_key)).not.toBeNull();
      release(); await publishing;
      expect(git(t.targetGit, ['rev-parse', `refs/gitknot/transactions/${oid}`])).toMatch(/^[a-f0-9]{40}$/);
      await abortRepositoryStoragePlacement(t.source, { operation_id: oid });
      const receipt = (await one<{ receipt_json: string }>(t.source.DB, "SELECT receipt_json FROM billing_placement_publications WHERE operation_id=? AND side='target'", oid))!;
      expect(JSON.parse(receipt.receipt_json)).toMatchObject({ state: 'committed', finalized: true, writer_fenced: true });
      expect(await one(t.source.DB, 'SELECT COUNT(*) AS count FROM billing_git_rejections WHERE operation_id=?', oid)).toEqual({ count: 0 });
      expect(await exists(t.targetGit)).toBe(false); expect(await exists(t.sourceGit)).toBe(true);
      expect((await admissionRequest<Totals>(t.source, `account:${accountId}`, 'snapshot')).control.reserved_bytes).toBe('0');
    } finally { release(); await publishing; }
  });

  it('funds a same-cell archive restore as fresh Git and exact scratch storage, then verifies the historical refs', async () => {
    const t = await fixture({ sameCell: true, archive: true });
    const before = await admissionRequest<Totals>(t.source, `account:${accountId}`, 'snapshot'), budget = before.budgets[0]!;
    const exposure = BigInt(budget.reserved_units) + BigInt(budget.commitment_units) + BigInt(budget.settled_units);
    await admissionRequest(t.source, `account:${accountId}`, 'budget', { budget: { ...budget, limit_units: exposure.toString() }, expected_revision: budget.revision });
    await expect(prepareRepositoryStoragePlacement(t.source, t.input)).rejects.toMatchObject({ code: 'placement_budget_exhausted' });
    expect(await exists(t.targetGit)).toBe(false);
    expect(await one(t.source.DB, 'SELECT COUNT(*) AS count FROM billing_placement_scratch')).toEqual({ count: 0 });
    const current = (await admissionRequest<Totals>(t.source, `account:${accountId}`, 'snapshot')).budgets[0]!;
    await admissionRequest(t.source, `account:${accountId}`, 'budget', { budget: { ...current, limit_units: budget.limit_units }, expected_revision: current.revision });
    await prepareRepositoryStoragePlacement(t.source, t.input);
    const p = await storagePlacement(t.source, oid);
    expect(p).toMatchObject({ purpose: 'archive_restore', target_git_slice_id: 'slice_source', archive_git_bytes: String(t.bundle.length), archive_refs: refs(t.archiveGit) });
    expect(p.target_storage_name).not.toBe(p.source_storage_name); expect(p.archive_refs).not.toEqual(refs(t.sourceGit));
    const row = (await one<{ body_json: string }>(t.source.DB, 'SELECT body_json FROM billing_placement_git WHERE operation_id=?', oid))!;
    const hold = JSON.parse(row.body_json) as PlacementGitHold;
    expect(hold.scratch_bytes).toBe(String(t.bundle.length)); expect(BigInt(hold.bytes)).toBeGreaterThan(3600000n);
    const funded = await admissionRequest<Totals>(t.source, `account:${accountId}`, 'snapshot');
    expect(BigInt(funded.control.reserved_bytes)).toBe(BigInt(hold.bytes) + BigInt(hold.scratch_bytes!));
    await expect(beginPlacementScratch(t.target, { operation_id: oid, bytes: String(t.bundle.length + 1), checksum: await sha256(t.bundle) })).rejects.toMatchObject({ code: 'placement_scratch_quota' });
    await copyRepositoryStoragePlacement(t.source, { operation_id: oid }); await t.nativeCopy();
    await commitRepositoryStoragePlacement(t.source, { operation_id: oid }); await t.cutover(); await finalizeRepositoryStoragePlacement(t.source, { operation_id: oid });
    expect(refs(t.targetGit)).toEqual(p.archive_refs); expect(await exists(t.sourceGit)).toBe(false);
    const after = await admissionRequest<Totals>(t.source, `account:${accountId}`, 'snapshot');
    expect(after.control.reserved_bytes).toBe('0'); expect(after.control.active_slots).toBe(0);
    expect(await one(t.source.DB, 'SELECT COUNT(*) AS count FROM execution_attempts')).toEqual({ count: 0 });
    expect(await t.blobs.head(t.objects[0]!.key)).not.toBeNull();
  });

  it('funds real duplicate stores, verifies Git refs, switches one payer, and deletes only the recorded source', async () => {
    const t = await fixture();
    const initial = await admissionRequest<Totals>(t.source, `account:${accountId}`, 'snapshot'), budget = initial.budgets[0]!;
    const exposure = BigInt(budget.reserved_units) + BigInt(budget.commitment_units) + BigInt(budget.settled_units);
    await admissionRequest(t.source, `account:${accountId}`, 'budget', { budget: { ...budget, limit_units: exposure.toString() }, expected_revision: budget.revision });
    await expect(prepareRepositoryStoragePlacement(t.source, t.input)).rejects.toMatchObject({ code: 'placement_budget_exhausted' });
    expect(t.targetBlobs.objects.size).toBe(0); await expect(stat(t.targetGit)).rejects.toMatchObject({ code: 'ENOENT' });
    const current = (await admissionRequest<Totals>(t.source, `account:${accountId}`, 'snapshot')).budgets[0]!;
    await admissionRequest(t.source, `account:${accountId}`, 'budget', { budget: { ...current, limit_units: budget.limit_units }, expected_revision: current.revision });
    expect((await prepareRepositoryStoragePlacement(t.source, t.input)).state).toBe('prepared');
    const reserved = await admissionRequest<Totals>(t.source, `account:${accountId}`, 'snapshot');
    expect(BigInt(reserved.control.reserved_bytes)).toBeGreaterThan(0n);
    expect((await copyRepositoryStoragePlacement(t.source, { operation_id: oid })).remaining).toBe(false);
    await t.nativeCopy(); vi.setSystemTime(Date.now() + 60000);
    expect((await commitRepositoryStoragePlacement(t.source, { operation_id: oid })).state).toBe('active');
    for (const object of t.objects) expect(await admissionRequest<StorageObject>(t.target, `account:${accountId}`, 'get-object', { object_id: object.id })).toMatchObject({ storage_cell_id: 'target', storage_epoch: 2, account_id: accountId, fence: object.fence });
    expect(t.targetNetwork.objects.has(`account:${accountId}`)).toBe(false);
    await t.cutover(); vi.setSystemTime(Date.now() + 60000);
    expect((await finalizeRepositoryStoragePlacement(t.source, { operation_id: oid })).state).toBe('complete');
    expect((await admissionRequest<Totals>(t.source, 'capacity:slice_source', 'snapshot')).control.stored_bytes).toBe('0');
    for (const [i, store] of [t.blobs, t.backups, t.sourceSnapshots].entries()) expect(await store.head(t.objects[i]!.key)).toBeNull();
    for (const [i, store] of [t.targetBlobs, t.targetBackups, t.targetSnapshots].entries()) expect(await (await store.get(t.objects[i]!.key) as R2ObjectBody).text()).toBe(`stored-${i}`);
    await expect(stat(t.sourceGit)).rejects.toMatchObject({ code: 'ENOENT' }); expect(refs(t.targetGit)).toHaveLength(1);
    const count = await one(t.source.DB, 'SELECT COUNT(*) AS count FROM billing_ledger');
    await finalizeRepositoryStoragePlacement(t.target, { operation_id: oid }); expect(await one(t.source.DB, 'SELECT COUNT(*) AS count FROM billing_ledger')).toEqual(count);
    const extra = await reserveStandaloneStorage(t.target, { account_id: accountId, repo_id: repoId, actor_id: accountId, object_id: 'obj_after_move', key: `${accountId}/${repoId}/after`, bucket: 'blobs', maximum_bytes: '4', retention_until: null });
    expect(extra).toMatchObject({ slice_id: 'slice_target', storage_cell_id: 'target' });
    await deleteStorageObject(t.target, { account_id: accountId, object_id: t.objects[0]!.id });
    expect(await t.targetBlobs.head(t.objects[0]!.key)).toBeNull();
    expect(await one(t.source.DB, 'SELECT COUNT(*) AS count FROM execution_attempts')).toEqual({ count: 0 });
  });

  it('retains an unknown PUT through abort, then reconciles its positive delayed receipt and compensates once', async () => {
    const t = await fixture(); await prepareRepositoryStoragePlacement(t.source, t.input);
    const put = t.targetBlobs.put.bind(t.targetBlobs); let delayed!: () => Promise<R2Object | null>;
    t.targetBlobs.put = async (key, value, options) => {
      const bytes = await new Response(value as BodyInit).arrayBuffer(); delayed = () => put(key, bytes, options); throw new Error('uncertain provider acceptance');
    };
    await expect(copyRepositoryStoragePlacement(t.source, { operation_id: oid })).rejects.toThrow();
    const before = await admissionRequest<Totals>(t.source, `account:${accountId}`, 'snapshot');
    await expect(abortRepositoryStoragePlacement(t.source, { operation_id: oid })).rejects.toThrow();
    expect((await admissionRequest<Totals>(t.source, `account:${accountId}`, 'snapshot')).control.reserved_bytes).toBe(before.control.reserved_bytes);
    t.targetBlobs.put = put; await delayed(); vi.setSystemTime(Date.now() + 60000);
    expect((await abortRepositoryStoragePlacement(t.source, { operation_id: oid })).state).toBe('aborted');
    expect((await admissionRequest<Totals>(t.source, `account:${accountId}`, 'snapshot')).control.reserved_bytes).toBe('0');
    expect((await admissionRequest<Totals>(t.target, 'capacity:slice_target', 'snapshot')).control.stored_bytes).toBe('0');
    expect(await t.blobs.head(t.objects[0]!.key)).not.toBeNull(); expect(await t.targetBlobs.head(t.objects[0]!.key)).toBeNull();
    await abortRepositoryStoragePlacement(t.source, { operation_id: oid });
    await expect(copyRepositoryStoragePlacement(t.source, { operation_id: oid })).rejects.toThrow();
  });

  it('keeps activation and source deletion fenced by real ref verification and cleanup failures', async () => {
    const t = await fixture(); await prepareRepositoryStoragePlacement(t.source, t.input); await copyRepositoryStoragePlacement(t.source, { operation_id: oid }); await t.nativeCopy();
    const head = git(t.targetGit, ['rev-parse', 'refs/heads/main']); git(t.targetGit, ['update-ref', 'refs/heads/unexpected', head]);
    await expect(commitRepositoryStoragePlacement(t.source, { operation_id: oid })).rejects.toThrow(/ref|inventory|preserve/i);
    expect((await admissionRequest<StorageObject>(t.source, `account:${accountId}`, 'get-object', { object_id: t.objects[0]!.id })).storage_cell_id).toBe('local');
    git(t.targetGit, ['update-ref', '-d', 'refs/heads/unexpected']); await commitRepositoryStoragePlacement(t.source, { operation_id: oid }); await t.cutover();
    const remove = t.blobs.delete.bind(t.blobs); t.blobs.delete = async () => { throw new Error('source provider cleanup unavailable'); };
    await expect(finalizeRepositoryStoragePlacement(t.source, { operation_id: oid })).rejects.toThrow();
    expect(await t.blobs.head(t.objects[0]!.key)).not.toBeNull();
    expect(BigInt((await admissionRequest<Totals>(t.source, 'capacity:slice_source', 'snapshot')).control.stored_bytes)).toBeGreaterThan(0n);
    t.blobs.delete = remove; await finalizeRepositoryStoragePlacement(t.source, { operation_id: oid });
    expect((await admissionRequest<Totals>(t.source, 'capacity:slice_source', 'snapshot')).control.stored_bytes).toBe('0');
  });
});
