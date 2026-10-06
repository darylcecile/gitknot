import { describe, expect, it } from 'vitest';
import { admissionRequest } from '../../packages/billing/src/transport.ts';
import type { AdmissionControl, Budget, StorageObject } from '../../packages/billing/src/types.ts';
import type { CanonicalGitMeter } from '../../packages/billing/src/git-types.ts';
import type { PlacementCopy, PlacementGitHold } from '../../packages/billing/src/placement-types.ts';
import { copyRepositoryStoragePlacement } from '../../packages/billing/src/storage-placement.ts';
import { storagePlacement } from '../../packages/billing/src/placement-state.ts';
import { many, now, one, sha256, stmt } from '../../packages/core/src/index.ts';
import { abortShardMove, runShardMove } from '../../packages/operations/src/movement.ts';
import { moveControl } from '../../packages/operations/src/move-control.ts';
import { submitShardMove } from '../../packages/operations/src/move-request.ts';
import { completeOperation, operationById, runLifecycle } from '../../packages/operations/src/lifecycle.ts';
import { readArchive } from '../../packages/operations/src/archive.ts';
import { metadataFenceGuard, operationFence } from '../../packages/operations/src/metadata-fence.ts';
import { moveFixture } from '../support/move-fixture.ts';

type Fixture = Awaited<ReturnType<typeof moveFixture>>;

async function moveRequest(test: Fixture) {
  const response = await submitShardMove(test.env, { repo_id: test.repoId, target_cell_id: 'remote', target_shard_id: 'destination', expected_epoch: 1 }, false);
  expect(response.status).toBe(202);
  const { id } = await response.json() as { id: string };
  return operationById(test.env, id);
}

async function objects(test: Fixture, head: string) {
  const prefix = `${test.accountId}/${test.repoId}`, at = now(), expires = new Date(Date.now() + 86400_000).toISOString();
  const uploaded = await test.fundObject('obj_physical', 'blobs', `${prefix}/uploads/physical`, 'Immutable attachment bytes');
  const billed = await admissionRequest<StorageObject>(test.env, `account:${test.accountId}`, 'get-object', { object_id: uploaded.id });
  const attachment = { id: uploaded.id, object_key: uploaded.key };
  await test.env.DB.batch([
    stmt(test.env.DB, `INSERT INTO object_manifests(id,repo_id,account_id,kind,object_key,filename,bytes,sha256,state,created_by,reference_count,
      billing_reservation_id,billing_fence,storage_accrued_at,created_at,updated_at)
      VALUES(?,'r_physical','u_physical','attachment',?,'physical.txt',?,?,'ready','u_physical',1,?,?,?,?,?)`, uploaded.id, uploaded.key, uploaded.bytes, uploaded.sha256,
    billed.reservation_id, billed.fence, billed.accrued_at, at, at),
    stmt(test.env.DB, "INSERT INTO storage_quotas(scope_id,limit_bytes,used_bytes,updated_at) VALUES('r_physical',1000000000,?,?)", uploaded.bytes, at),
  ]);
  const output = await test.fundObject('obj_output', 'blobs', `${prefix}/runs/completed/output`, 'Retained execution output');
  const orphan = await test.fundObject('obj_unlinked', 'blobs', `${prefix}/unlinked/retained`, 'Stored financial object before feature-link receipt');
  const archiveKey = `${prefix}/sdk/archive`, metadataKey = `${prefix}/sdk/metadata`;
  const snapshotArchive = await test.fundObject(`sdk_${(await sha256(archiveKey)).slice(0, 48)}`, 'snapshots', archiveKey, 'SDK snapshot bytes');
  const snapshotMetadata = await test.fundObject(`sdk_${(await sha256(metadataKey)).slice(0, 48)}`, 'snapshots', metadataKey, '{"snapshot":"retained"}');
  const retainedPlan = JSON.stringify({ repo_id: test.repoId, account_id: test.accountId, source_repo_id: test.repoId, related_repo_ids: [test.repoId],
    commit_sha: head, source_ref: 'refs/heads/main', workflow_digest: 'retained', workflow_version_id: 'wfv_physical', policy_revision: 1, trust: 'trusted',
    trigger: { type: 'workflow.dispatch', id: 'retained' } });
  await test.env.DB.batch([
    stmt(test.env.DB, `INSERT INTO workflows(id,repo_id,account_id,name,path,current_version_id,created_by,created_at,updated_at)
      VALUES('wf_physical','r_physical','u_physical','retained','.gitknot/workflows/retained.yaml','wfv_physical','u_physical',?,?)`, at, at),
    stmt(test.env.DB, `INSERT INTO workflow_versions(id,workflow_id,repo_id,account_id,source_commit,definition_digest,definition,definition_json,policy_revision,approved_by,created_at)
      VALUES('wfv_physical','wf_physical','r_physical','u_physical',?,'retained','retained','{}',1,'u_physical',?)`, head, at),
    stmt(test.env.DB, `INSERT INTO workflow_runs(id,repo_id,account_id,workflow_id,workflow_version_id,commit_sha,source_ref,workflow_digest,plan_digest,plan_json,policy_revision,
      trigger_type,trigger_id,trust,status,requested_by,request_key,request_hash,created_at,updated_at,completed_at)
      VALUES('run_physical','r_physical','u_physical','wf_physical','wfv_physical',?,'refs/heads/main','retained',?,?,1,'workflow.dispatch','retained','trusted','succeeded','u_physical','retained','retained',?,?,?)`, head, await sha256(retainedPlan), retainedPlan, at, at, at),
    stmt(test.env.DB, `INSERT INTO workflow_jobs(id,repo_id,account_id,run_id,job_key,definition_json,status,created_at,updated_at,completed_at)
      VALUES('job_physical','r_physical','u_physical','run_physical','retained','{}','succeeded',?,?,?)`, at, at, at),
    stmt(test.env.DB, `INSERT INTO execution_attempts(id,repo_id,account_id,run_id,job_id,generation,plan_digest,toolchain_digest,producer_id,executor,status,queue_deadline_at,
      cleanup_state,settled_at,created_at,updated_at,completed_at) VALUES('att_physical','r_physical','u_physical','run_physical','job_physical',1,'retained','retained','retained','hosted','succeeded',?,'verified',?,?,?,?)`, expires, at, at, at, at),
    stmt(test.env.DB, `INSERT INTO execution_objects(id,repo_id,account_id,run_id,attempt_id,generation,kind,name,object_key,sha256,size_bytes,content_type,state,expires_at,created_at)
      VALUES('obj_output','r_physical','u_physical','run_physical','att_physical',1,'output','retained',?,?,?,'text/plain','sealed',?,?)`, output.key, output.sha256, output.bytes, expires, at),
    stmt(test.env.DB, `INSERT INTO execution_snapshots(id,repo_id,account_id,attempt_id,runtime_id,snapshot_json,archive_key,metadata_key,size_bytes,sha256,state,expires_at,created_at)
      VALUES('snap_physical','r_physical','u_physical','att_physical','runtime_retained','{}',?,?,?,?,'sealed',?,?)`, archiveKey, metadataKey, snapshotArchive.bytes, snapshotArchive.sha256, expires, at),
  ]);
  return { attachment, output, orphan, snapshotArchive, snapshotMetadata };
}

describe('funded same-owner physical placement', () => {
  it('restores an actual historical archive into another shard in the same cell with fresh canonical and scratch funding', async () => {
    const test = await moveFixture();
    try {
      const { env, target } = test;
      Object.assign(env, { SHARD_BINDINGS_JSON: '{"core":"DB","destination":"LOCAL_DESTINATION"}', LOCAL_DESTINATION: target.DB });
      Object.assign(target, { CELL_ID: env.CELL_ID, SHARD_BINDINGS_JSON: '{"core":"LOCAL_SOURCE","destination":"DB"}', LOCAL_SOURCE: env.DB,
        BLOBS: env.BLOBS, BACKUPS: env.BACKUPS, BACKUP_BUCKET: env.BACKUP_BUCKET, ADMISSION: env.ADMISSION, REPO_COORDINATOR: env.REPO_COORDINATOR,
        BILLING_PLATFORM_SLICE_ID: env.BILLING_PLATFORM_SLICE_ID, BILLING_GIT_STORAGE_SLICE_ID: env.BILLING_GIT_STORAGE_SLICE_ID });
      const historical = await test.initializeGit();
      const backupResponse = await (env.API as Fetcher).fetch(new Request(`${env.API_ORIGIN}/v1/repos/${test.repoId}/backups`, { method: 'POST',
        headers: { authorization: `Bearer ${test.token}`, 'content-type': 'application/json', 'idempotency-key': 'same-cell-historical-backup' }, body: '{}' }));
      expect(backupResponse.status, await backupResponse.clone().text()).toBe(202);
      const backup = await operationById(env, (await backupResponse.json() as { id: string }).id);
      const archived = await runLifecycle(env, backup, { do: async <T>(_name: string, _options: unknown, action: () => Promise<T>) => action() });
      await completeOperation(env, backup, archived);
      const archiveId = String(archived.archive_id), manifest = await readArchive(env, archiveId, test.repoId);
      expect(manifest.git.refs).toEqual([{ ref: 'refs/heads/main', oid: historical }]);
      await test.internalGit('mutate', { operation_id: 'gop_after_historical_backup', actor: test.actor, mutation: { kind: 'edit', ref: 'refs/heads/main', expected_oid: historical,
        message: 'Newer live state', author: { name: 'Archive recovery', email: 'physical@example.net' },
        edits: [{ path: 'README.md', content_base64: Buffer.from('Newer live state must not replace the selected archive\n').toString('base64') }] } });
      expect(await test.git(test.sourceStores.get(test.storageName)!, 'rev-parse', 'main')).not.toBe(historical);
      const accepted = await submitShardMove(env, { repo_id: test.repoId, target_cell_id: env.CELL_ID, target_shard_id: target.SHARD_ID,
        expected_epoch: 1, archive_id: archiveId, principal: test.actor }, true);
      expect(accepted.status).toBe(202);
      const operation = await operationById(env, (await accepted.json() as { id: string }).id);
      const native = env.GIT_SERVICE;
      let fundedBeforeCreate = false;
      env.GIT_SERVICE = { fetch: async (request: Request) => {
        if (new URL(request.url).pathname.endsWith('/restore')) {
          const p = await storagePlacement(env, operation.id);
          expect(p).toMatchObject({ purpose: 'archive_restore', archive_id: archiveId, archive_manifest_sha256: expect.any(String),
            source_cell_id: env.CELL_ID, target_cell_id: env.CELL_ID, target_git_slice_id: env.BILLING_GIT_STORAGE_SLICE_ID, archive_refs: manifest.git.refs });
          expect(p.target_storage_name).not.toBe(p.source_storage_name);
          expect(test.destinationStores.has(p.target_storage_name)).toBe(false);
          const row = (await one<{ body_json: string }>(env.DB, 'SELECT body_json FROM billing_placement_git WHERE operation_id=?', operation.id))!;
          const hold = JSON.parse(row.body_json) as PlacementGitHold;
          expect(hold.scratch_bytes).toBe(String(manifest.git.bytes));
          for (const participant of [`account:${test.accountId}`, `capacity:${p.target_git_slice_id}`]) {
            const totals = await admissionRequest<{ control: AdmissionControl; budgets: Budget[] }>(env, participant, 'snapshot');
            expect(BigInt(totals.control.reserved_bytes)).toBeGreaterThanOrEqual(BigInt(hold.bytes) + BigInt(hold.scratch_bytes!));
            expect(totals.budgets.some(budget => BigInt(budget.reserved_units) > 0n)).toBe(true);
          }
          fundedBeforeCreate = true;
        }
        return native.fetch(request);
      } } as Fetcher;
      expect(await runShardMove(env, operation)).toMatchObject({ moved: true, restored: true, routing_epoch: 2 });
      expect(fundedBeforeCreate).toBe(true);
      const p = await storagePlacement(env, operation.id), control = await moveControl(env, operation.id);
      expect(p.state).toBe('complete'); expect(control.state).toBe('completed'); expect(control.target_storage_name).toBe(p.target_storage_name);
      const path = test.destinationStores.get(p.target_storage_name)!;
      expect(await test.git(path, 'rev-parse', 'main')).toBe(historical);
      expect(await test.git(path, 'show', 'main:README.md')).toBe('Actual native graph across cells');
      expect(await test.git(path, 'fsck', '--strict', '--full', '--no-dangling')).toBe('');
      expect(test.sourceStores.has(test.storageName)).toBe(false); expect(test.provisions.get(p.target_storage_name)).toBe(1);
      expect(await one(env.DB, 'SELECT state FROM billing_placement_scratch WHERE operation_id=?', operation.id)).toEqual({ state: 'deleted' });
      expect(await one(target.DB, 'SELECT cell_id,shard_id,state,storage_name FROM repositories WHERE id=?', test.repoId))
        .toEqual({ cell_id: env.CELL_ID, shard_id: target.SHARD_ID, state: 'active', storage_name: p.target_storage_name });
      for (const bindings of [env, target]) expect(await one(bindings.DB, 'SELECT state FROM repository_metadata_fences WHERE repo_id=?', test.repoId)).toEqual({ state: 'released' });
      const capacity = await admissionRequest<{ control: AdmissionControl }>(env, `capacity:${p.target_git_slice_id}`, 'snapshot');
      expect(capacity.control.reserved_bytes).toBe('0'); expect(capacity.control.active_slots).toBe(0);
      expect(await one(env.DB, 'SELECT COUNT(*) AS n FROM execution_attempts')).toEqual({ n: 0 });
    } finally { await test.close(); }
  }, 180_000);

  it('moves actual native Git, manifests, execution and SDK objects through lost R2, native and billing replies, then cleans the source', async () => {
    const test = await moveFixture();
    try {
      const head = await test.initializeGit(), stored = await objects(test, head);
      const originalObject = await admissionRequest<StorageObject>(test.env, `account:${test.accountId}`, 'get-object', { object_id: stored.attachment.id });
      const operation = await moveRequest(test);
      const { env, target } = test;
      let r2Lost = true, nativeLost = true, billingLost = true, directoryLost = true, writes = 0;
      const directory = env.DIRECTORY_DB!;
      const loseRouteReply = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(current, property) {
        if (property === 'bind') return (...parameters: unknown[]) => loseRouteReply(current.bind(...parameters));
        if (property === 'run') return async () => {
          const result = await current.run();
          if (directoryLost && result.meta.changes) { directoryLost = false; throw new Error('Lost directory CAS acknowledgement'); }
          return result;
        };
        const value = Reflect.get(current, property);
        return typeof value === 'function' ? value.bind(current) : value;
      } });
      env.DIRECTORY_DB = new Proxy(directory, { get(current, property) {
        if (property === 'prepare') return (sql: string) => /^UPDATE resource_routes SET cell_id=/.test(sql) ? loseRouteReply(current.prepare(sql)) : current.prepare(sql);
        const value = Reflect.get(current, property);
        return typeof value === 'function' ? value.bind(current) : value;
      } });
      const originalPut = test.destination.blobs.put.bind(test.destination.blobs);
      test.destination.blobs.put = async (...args) => {
        const result = await originalPut(...args);
        if (args[0] === stored.attachment.object_key) {
          writes++;
          if (r2Lost) { r2Lost = false; throw new Error('Lost R2 PUT acknowledgement'); }
        }
        return result;
      };
      const nativeService = target.GIT_SERVICE;
      target.GIT_SERVICE = { fetch: async (request: Request) => {
        const response = await nativeService.fetch(request);
        if (nativeLost && new URL(request.url).pathname.endsWith('/restore') && response.ok) { nativeLost = false; throw new Error('Lost native restore acknowledgement'); }
        return response;
      } } as Fetcher;
      const namespace = env.ADMISSION;
      env.ADMISSION = { idFromName: namespace.idFromName.bind(namespace), get(id: DurableObjectId) {
        const stub = namespace.get(id);
        return { fetch: async (request: Request) => {
          const response = await stub.fetch(request);
          if (billingLost && new URL(request.url).pathname.endsWith('/placement-switch') && response.ok) { billingLost = false; throw new Error('Lost account cutover acknowledgement'); }
          return response;
        } };
      } } as unknown as DurableObjectNamespace;
      await expect(runShardMove(env, operation)).rejects.toThrow();
      expect(r2Lost).toBe(false); expect(writes).toBe(1);
      const frozen = await moveControl(env, operation.id);
      expect(frozen).toMatchObject({ state: 'copying', source_epoch: 1, target_epoch: 2, effective_at: null, physical_count: expect.any(Number) });
      expect(frozen.physical_count!).toBeGreaterThan(5);
      expect(await one(env.DB, "SELECT state,epoch FROM resource_routes WHERE resource_id='r_physical'")).toEqual({ state: 'fenced', epoch: 1 });
      for (const bindings of [env, target]) await expect(bindings.DB.batch([...metadataFenceGuard(bindings.DB, test.repoId, null),
        stmt(bindings.DB, "UPDATE repositories SET description='unfenced' WHERE id='r_physical'")])).rejects.toThrow();
      await expect(runShardMove(env, operation)).rejects.toThrow();
      expect(nativeLost, test.diagnostics.map(String).join('\n')).toBe(false);
      expect(await one(target.DB, 'SELECT state,finalized FROM git_publications WHERE id=?', operation.id)).toEqual({ state: 'committed', finalized: 1 });
      await expect(runShardMove(env, operation)).rejects.toThrow();
      expect(billingLost).toBe(false);
      const decision = await moveControl(env, operation.id);
      expect(decision.state).toBe('cutover'); expect(decision.effective_at).not.toBeNull();
      const completed = await runShardMove(env, operation);
      expect(directoryLost).toBe(false);
      expect(completed).toMatchObject({ moved: true, routing_epoch: 2, repository_id: test.repoId });
      expect(await runShardMove(env, operation)).toEqual(completed);
      const control = await moveControl(env, operation.id);
      expect(control).toMatchObject({ state: 'completed', effective_at: decision.effective_at, snapshot_sha256: frozen.snapshot_sha256,
        physical_sha256: frozen.physical_sha256, physical_count: frozen.physical_count });
      expect(control.cleanup_verified_at).not.toBeNull(); expect(control.source_fence_id).not.toBe(control.target_fence_id);
      expect(writes).toBe(1); expect(test.provisions.get(control.target_storage_name)).toBe(1);
      expect(test.sourceStores.size).toBe(0);
      const path = test.destinationStores.get(control.target_storage_name)!;
      expect(await test.git(path, 'rev-parse', 'refs/heads/main')).toBe(head);
      expect(await test.git(path, 'show', 'refs/heads/main:README.md')).toBe('Actual native graph across cells');
      expect(await test.git(path, 'fsck', '--full')).not.toContain('error');
      expect(test.source.blobs.objects.size + test.source.backups.objects.size + test.sourceSnapshots.objects.size).toBe(0);
      expect(await (await test.destination.blobs.get(stored.output.key) as R2ObjectBody).text()).toBe(stored.output.content);
      expect(await (await test.destination.blobs.get(stored.orphan.key) as R2ObjectBody).text()).toBe(stored.orphan.content);
      for (const object of [stored.snapshotArchive, stored.snapshotMetadata]) expect(await (await test.destinationSnapshots.get(object.key) as R2ObjectBody).text()).toBe(object.content);
      const metadata = await test.destination.blobs.head(stored.output.key);
      expect(metadata?.customMetadata).toMatchObject({ immutable_source: 'retained', object_id: stored.output.id, sha256: stored.output.sha256 });
      expect(metadata?.httpMetadata).toEqual({ contentType: 'application/octet-stream', cacheControl: 'private, max-age=0' });
      for (const bindings of [env, target]) expect(await one(bindings.DB, "SELECT state FROM repository_metadata_fences WHERE repo_id='r_physical'")).toEqual({ state: 'released' });
      expect(await one(target.DB, 'SELECT COUNT(*) AS n FROM move_applied_storage_receipts WHERE operation_id=?', operation.id)).toEqual({ n: control.physical_count });
      expect(await many(target.DB, 'PRAGMA foreign_key_check')).toEqual([]);
      expect(test.admissionHomes.get('remote')!.has(`account:${test.accountId}`)).toBe(false);
      expect(test.admissionHomes.get('remote')!.has('capacity:slice_remote')).toBe(true);
      const logical = await admissionRequest<StorageObject>(target, `account:${test.accountId}`, 'get-object', { object_id: stored.attachment.id });
      expect(logical).toMatchObject({ state: 'stored', storage_cell_id: 'remote', storage_epoch: 2, billable_from: control.effective_at });
      expect(logical.placement_handoff_id).toBeUndefined();
      const sourceMeter = await admissionRequest<CanonicalGitMeter>(target, `account:${test.accountId}`, 'git-meter', { repo_id: test.repoId, storage_name: test.storageName });
      const targetMeter = await admissionRequest<CanonicalGitMeter>(target, `account:${test.accountId}`, 'git-meter', { repo_id: test.repoId, storage_name: control.target_storage_name });
      expect(sourceMeter).toMatchObject({ state: 'purged', billable_until: control.effective_at });
      expect(targetMeter).toMatchObject({ state: 'stored', storage_cell_id: 'remote', billable_from: control.effective_at });
      expect(targetMeter.placement_handoff_id).toBeUndefined();
      const through = now();
      await admissionRequest(target, `account:${test.accountId}`, 'storage-accrue', { object_id: stored.attachment.id, through });
      const physical = JSON.parse((await one<{ body_json: string }>(env.DB, 'SELECT body_json FROM billing_placement_copies WHERE operation_id=? AND object_id=?',
        operation.id, stored.attachment.id))!.body_json) as PlacementCopy;
      const quantities = await many<{ operating_cost: number; quantity: string }>(env.DB, `SELECT operating_cost,quantity FROM billing_ledger
        WHERE object_id IN (?,?,?) AND meter='storage.blobs'`, physical.object_id, physical.copy_id, physical.source_id);
      const sum = (platform: number) => quantities.filter(row => row.operating_cost === platform).reduce((total, row) => total + BigInt(row.quantity), 0n);
      const bytes = BigInt(originalObject.bytes), milliseconds = (end: string, start: string) => BigInt(Date.parse(end) - Date.parse(start));
      expect(sum(0)).toBe(bytes * milliseconds(through, originalObject.accrued_at));
      expect(sum(1)).toBe(bytes * (milliseconds(physical.deleted_at!, originalObject.accrued_at) + milliseconds(through, physical.receipt!.uploaded_at)));
      expect(await one(env.DB, "SELECT COUNT(*) AS n FROM repository_transfers")).toEqual({ n: 0 });
    } finally { await test.close(); }
  }, 120_000);

  it('rolls back a verified pre-cutover destination, frees duplicate holds and tombstones its old epochs', async () => {
    const test = await moveFixture();
    try {
      const head = await test.initializeGit(), retained = await test.fundObject('obj_retained', 'blobs', `${test.accountId}/${test.repoId}/retained`, 'Kept at source');
      const operation = await moveRequest(test), batch = test.destination.db.batch.bind(test.destination.db);
      let lost = true;
      test.destination.db.batch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
        const result = await batch<T>(statements);
        if (lost && statements.some(statement => /UPDATE move_staging SET state='verified'/.test((statement as unknown as { sql: string }).sql))) {
          lost = false; throw new Error('Interrupt after complete destination verification');
        }
        return result;
      };
      await expect(runShardMove(test.env, operation)).rejects.toThrow();
      expect(lost, test.diagnostics.map(String).join('\n')).toBe(false);
      const control = await moveControl(test.env, operation.id), receipt = (await operationFence(test.env.DB, operation.id))!;
      expect(control.effective_at).toBeNull(); expect(test.destinationStores.has(control.target_storage_name)).toBe(true);
      expect(await abortShardMove(test.env, operation.id)).toMatchObject({ aborted: true, routing_epoch: 3 });
      expect(await abortShardMove(test.target, operation.id)).toMatchObject({ aborted: true });
      expect(await one(test.env.DB, "SELECT state,routing_epoch,storage_name FROM repositories WHERE id='r_physical'")).toEqual({ state: 'active', routing_epoch: 3, storage_name: test.storageName });
      expect(await one(test.target.DB, "SELECT id FROM repositories WHERE id='r_physical'")).toBeNull();
      expect(test.destinationStores.size + test.destination.blobs.objects.size + test.destination.backups.objects.size).toBe(0);
      expect(await test.git(test.sourceStores.get(test.storageName)!, 'rev-parse', 'refs/heads/main')).toBe(head);
      expect(await (await test.source.blobs.get(retained.key) as R2ObjectBody).text()).toBe(retained.content);
      await expect(copyRepositoryStoragePlacement(test.target, { operation_id: operation.id })).rejects.toThrow();
      await expect(test.env.DB.batch(metadataFenceGuard(test.env.DB, test.repoId, receipt))).rejects.toThrow();
      const logical = await admissionRequest<StorageObject>(test.env, `account:${test.accountId}`, 'get-object', { object_id: retained.id });
      expect(logical).toMatchObject({ state: 'stored', storage_cell_id: 'local' }); expect(logical.placement_handoff_id).toBeUndefined();
      const targetCapacity = await admissionRequest<{ control: { stored_bytes: string; reserved_bytes: string } }>(test.env, 'capacity:slice_remote', 'snapshot');
      expect(targetCapacity.control).toMatchObject({ stored_bytes: '0', reserved_bytes: '0' });
      const write = await (test.env.API as Fetcher).fetch(new Request(`${test.env.API_ORIGIN}/v1/repos/${test.repoId}/labels`, { method: 'POST',
        headers: { authorization: `Bearer ${test.token}`, 'content-type': 'application/json', 'idempotency-key': 'after-physical-rollback' },
        body: JSON.stringify({ name: 'After rollback', color: '123456' }) }));
      expect(write.status, await write.clone().text()).toBe(201);
    } finally { await test.close(); }
  }, 120_000);

  it('retains both fences and all holds for an absent ambiguous writer, then reconciles that original writer before rollback', async () => {
    const test = await moveFixture(); let release!: () => void, writer: Promise<unknown> | undefined;
    try {
      await test.initializeGit();
      const retained = await test.fundObject('obj_ambiguous', 'blobs', `${test.accountId}/${test.repoId}/ambiguous`, 'Original delayed writer');
      const operation = await moveRequest(test), original = test.destination.blobs.put.bind(test.destination.blobs);
      const gate = new Promise<void>(resolve => { release = resolve; }); let writes = 0;
      test.destination.blobs.put = async (key, value, options) => {
        if (key !== retained.key) return original(key, value, options);
        writes++;
        const stream = (value as ReadableStream<Uint8Array>).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ async transform(bytes, controller) { await gate; controller.enqueue(bytes); } }));
        writer = original(key, stream, options);
        throw new Error('Ambiguous accepted PUT with its original writer still running');
      };
      await expect(runShardMove(test.env, operation)).rejects.toThrow();
      expect(writes).toBe(1); expect(await test.destination.blobs.head(retained.key)).toBeNull();
      const copyRow = (await one<{ copy_id: string }>(test.env.DB, 'SELECT copy_id FROM billing_placement_copies WHERE operation_id=? AND object_id=?', operation.id, retained.id))!;
      const before = await admissionRequest(test.env, `account:${test.accountId}`, 'get-object', { object_id: copyRow.copy_id });
      const sourceBefore = await admissionRequest(test.env, `account:${test.accountId}`, 'get-object', { object_id: retained.id });
      await expect(abortShardMove(test.env, operation.id)).rejects.toThrow();
      await expect(abortShardMove(test.env, operation.id)).rejects.toThrow();
      expect(await admissionRequest(test.env, `account:${test.accountId}`, 'get-object', { object_id: copyRow.copy_id })).toEqual(before);
      expect(await admissionRequest(test.env, `account:${test.accountId}`, 'get-object', { object_id: retained.id })).toEqual(sourceBefore);
      for (const bindings of [test.env, test.target]) expect(await one(bindings.DB, "SELECT state FROM repository_metadata_fences WHERE repo_id='r_physical'")).toEqual({ state: 'held' });
      expect((await moveControl(test.env, operation.id)).state).toBe('aborting');
      release(); await writer;
      expect(await abortShardMove(test.env, operation.id)).toMatchObject({ aborted: true });
      expect(writes).toBe(1); expect(await test.destination.blobs.head(retained.key)).toBeNull();
      expect(await test.source.blobs.head(retained.key)).not.toBeNull();
      const copies = await many<{ body_json: string }>(test.env.DB, 'SELECT body_json FROM billing_placement_copies WHERE operation_id=?', operation.id);
      expect(copies.map(row => JSON.parse(row.body_json).state)).toEqual(copies.map(() => 'released'));
    } finally { release?.(); await writer; await test.close(); }
  }, 120_000);
});
