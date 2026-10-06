import { createHash } from 'node:crypto';
import { ApiError, canonicalJson, eventStatement, execute, identityBinding, many, now, one, registerRepositoryPlacement, registerRepositoryResourceLocators, registerResourceLocator, resolveResourceLocator, sha256, stmt } from '@gitknot/core';
import type { Database, Repository } from '@gitknot/core';
import { backgroundCell, shardEnvironment } from './placement.ts';
import { createArchive, readArchive, verifiedPart } from './archive.ts';
import type { ArchiveManifest } from './archive.ts';
import { quiesceExecution, restoreGit, revokeRepositoryIdentity } from './lifecycle.ts';
import { claimOperationRuntime } from './durable.ts';
import { privateJSON } from './private.ts';
import type { Operation, OperationsBindings } from './types.ts';
import { drainRepositoryObjects } from './objects.ts';
import { drainRepositoryAttachmentDeletions } from './purge.ts';
import { verifyMovedStorageBilling } from './storage-evidence.ts';
import { MoveReferences } from './move-references.ts';
import { acquireMetadataFence, metadataFenceGuard, operationFence, ownerBatch, ownerExecute, releaseMetadataFence } from './metadata-fence.ts';
import { rowJsonExpression } from './archive-snapshot.ts';
import { prepareRepositoryStoragePlacement, copyRepositoryStoragePlacement, commitRepositoryStoragePlacement,
  finalizeRepositoryStoragePlacement, abortRepositoryStoragePlacement } from '../../billing/src/storage-placement.ts';
import { advanceMoveControl, bindDestinationFence, initializeMoveControl, moveControl, sameMovePlacement } from './move-control.ts';
import type { MoveControl } from './move-control.ts';
import { acceptMoveObjects, applyMoveStorageReceipts, materializeMoveObjects, moveInventory, movedStorageRow, readMoveObjects,
  verifyMoveObjects, verifyMoveSourceCleanup } from './move-objects.ts';
import type { MovePhysicalObject } from './move-objects.ts';
import { storagePlacement } from '../../billing/src/placement-state.ts';
import type { PlacementProgress } from '../../billing/src/placement-types.ts';

interface MoveInput {
  operation_id: string; repo_id: string; source_cell_id: string; source_shard_id: string;
  target_cell_id: string; target_shard_id: string; source_epoch: number; phase: 'initial' | 'final';
}
interface SnapshotRow { row_key: number; data: Record<string, unknown>; sha256: string }
interface Column { name: string; pk: number }

const identifier = /^[a-z_][a-z0-9_]*$/;
const sharedTables = /^(?:billing_|identity_|schema_|sqlite_|mutation_|storage_quotas$|internal_nonces$)/;
const identityOwnedTables = new Set(['roles', 'role_capabilities', 'access_grants',
  'runner_slot_reservations', 'runner_job_offers', 'runner_credential_exchanges',
  'invitations', 'collaboration_code_scan_repositories', 'collaboration_code_scan_chunks',
  'accounts', 'users', 'principals', 'credentials', 'memberships', 'teams', 'team_members', 'account_policies', 'account_policy_barriers',
  'applications', 'installations', 'resource_locators', 'repository_move_controls', 'git_barrier_routes']);
const repositoryRunnerTables = { runner_pools: 'runner_pool', runner_enrollments: 'runner_enrollment', runners: 'runner' } as const;
const runnerProjections = new Set(['runner_exchange_projections', 'runner_retirement_projections']);
const joins: Record<string, string> = {
  storage_quotas: 'scope_id=?',
  runner_pools: "id IN (SELECT resource_id FROM move_repository_resources WHERE repo_id=? AND resource_type='runner_pool')",
  runner_enrollments: "id IN (SELECT resource_id FROM move_repository_resources WHERE repo_id=? AND resource_type='runner_enrollment')",
  runners: "id IN (SELECT resource_id FROM move_repository_resources WHERE repo_id=? AND resource_type='runner')",
  idempotency_keys: `EXISTS(SELECT 1 FROM (SELECT ? AS repo) scope WHERE idempotency_keys.repo_id=scope.repo OR
    (idempotency_keys.repo_id IS NULL AND EXISTS(SELECT 1 FROM json_each(idempotency_keys.policy_json) p
      WHERE json_extract(p.value,'$.repo_id')=scope.repo OR json_extract(p.value,'$.scope.repo_id')=scope.repo)))`,
  processed_events: `EXISTS(SELECT 1 FROM (SELECT ? AS repo) s WHERE processed_events.event_id IN (
    SELECT id FROM outbox WHERE repo_id=s.repo UNION SELECT id FROM operations WHERE repo_id=s.repo
    UNION SELECT id FROM object_manifests WHERE repo_id=s.repo UNION SELECT id FROM repository_archives WHERE repo_id=s.repo))`,
  event_publications: 'event_id IN (SELECT id FROM outbox WHERE repo_id=?)',
  event_consumer_jobs: 'event_id IN (SELECT id FROM outbox WHERE repo_id=?)',
  operation_steps: 'operation_id IN (SELECT id FROM operations WHERE repo_id=?)',
  operation_dispatches: 'operation_id IN (SELECT id FROM operations WHERE repo_id=?)',
  webhook_keys: 'webhook_id IN (SELECT id FROM webhooks WHERE repo_id=?)',
  archive_parts: 'archive_id IN (SELECT id FROM repository_archives WHERE repo_id=?)',
  archive_components: 'archive_id IN (SELECT id FROM repository_archives WHERE repo_id=?)',
  archive_audiences: 'archive_id IN (SELECT id FROM repository_archives WHERE repo_id=?)',
  archive_ref_audiences: 'archive_id IN (SELECT id FROM repository_archives WHERE repo_id=?)',
  archive_snapshots: 'archive_id IN (SELECT id FROM repository_archives WHERE repo_id=?)',
  archive_snapshot_rows: 'archive_id IN (SELECT id FROM repository_archives WHERE repo_id=?)',
  repository_restore_rows: 'operation_id IN (SELECT operation_id FROM repository_restore_plans WHERE repo_id=?)',
  repository_restore_previous_rows: 'operation_id IN (SELECT operation_id FROM repository_restore_plans WHERE repo_id=?)',
  mail_provider_events: 'delivery_id IN (SELECT id FROM mail_deliveries WHERE repo_id=?)',
  mail_fanouts: "repo_id=? AND authority='repository'",
  mail_recipients: "event_id IN (SELECT event_id FROM mail_fanouts WHERE repo_id=? AND authority='repository')",
  vault_versions: 'entry_id IN (SELECT id FROM vault_entries WHERE repo_id=?)',
  vault_version_revocations: 'entry_id IN (SELECT id FROM vault_entries WHERE repo_id=?)',
  vault_ciphertexts: "json_extract(context_json,'$.repo_id')=?",
  vault_key_wraps: "ciphertext_id IN (SELECT id FROM vault_ciphertexts WHERE json_extract(context_json,'$.repo_id')=?)",
  vault_operations: 'resource_id IN (SELECT id FROM vault_entries WHERE repo_id=?)',
};

async function tableScopes(db: Database): Promise<{ name: string; predicate: string }[]> {
  const result = [{ name: 'repositories', predicate: 'id=?' }];
  const tables = await many<{ name: string }>(db, `SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name`);
  for (const { name } of tables) {
    if (name.startsWith('account_authority_') || name.startsWith('account_export') || name.startsWith('repository_metadata_fence')
      || name.startsWith('runner_') && !Object.hasOwn(repositoryRunnerTables, name) && !runnerProjections.has(name) || name.startsWith('vault_')
      || ['catalog_barriers', 'usage_projection_entries'].includes(name) || identityOwnedTables.has(name)) continue;
    if (!identifier.test(name) || name === 'repositories' || sharedTables.test(name) && !joins[name] || name.startsWith('move_') || name === 'shard_moves') continue;
    const columns = await many<Column>(db, `PRAGMA table_info(${name})`);
    const predicate = joins[name] ?? (columns.some((column) => column.name === 'repo_id') ? 'repo_id=?' : undefined);
    if (predicate) result.push({ name, predicate });
  }
  return result;
}

async function stageStart(env: OperationsBindings, input: MoveInput): Promise<void> {
  if (input.target_cell_id !== env.CELL_ID || input.target_shard_id !== env.SHARD_ID || input.source_epoch < 1) throw new Error('move_destination_mismatch');
  const db = env.DB.withSession('first-primary');
  const control = await targetControl(env, input);
  if (['aborting', 'aborted'].includes(control.state)) throw new Error('move_destination_aborted');
  const existing = await one<MoveInput & { state: string }>(db, 'SELECT * FROM move_staging WHERE operation_id=?', input.operation_id);
  if (existing && (existing.repo_id !== input.repo_id || existing.source_cell_id !== input.source_cell_id || existing.source_shard_id !== input.source_shard_id
    || existing.source_epoch !== input.source_epoch || existing.target_shard_id !== input.target_shard_id)) throw new Error('move_identity_conflict');
  if (existing?.phase === 'final' && input.phase === 'initial') return;
  if (existing?.state === 'active') return;
  if (!existing) {
    const repository = await one(db, 'SELECT 1 FROM repositories WHERE id=?', input.repo_id);
    if (repository) throw new Error('move_requires_fresh_repository_destination');
  }
  const receipt = await acquireMetadataFence(env, input.repo_id, input.operation_id, control.target_epoch);
  await bindDestinationFence(env, control, receipt);
  await db.batch([
    ...metadataFenceGuard(db, input.repo_id, receipt),
    stmt(db, `INSERT INTO move_staging(operation_id,repo_id,source_cell_id,source_shard_id,target_shard_id,source_epoch,phase,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'receiving',?,?) ON CONFLICT(operation_id) DO UPDATE SET phase=excluded.phase,updated_at=excluded.updated_at`,
    input.operation_id, input.repo_id, input.source_cell_id, input.source_shard_id, input.target_shard_id, input.source_epoch, input.phase, now(), now()),
    ...(existing && existing.phase !== input.phase ? [stmt(db, 'DELETE FROM move_snapshot_rows WHERE operation_id=?', input.operation_id)] : []),
  ]);
}

async function stageRows(env: OperationsBindings, input: MoveInput, table: string, rows: SnapshotRow[]): Promise<void> {
  if (rows.length > 20 || !identifier.test(table)) throw new Error('move_batch_invalid');
  const scopes = await tableScopes(env.DB);
  if (!scopes.some((entry) => entry.name === table)) throw new Error('move_table_not_allowed');
  const columns = new Set((await many<Column>(env.DB, `PRAGMA table_info(${table})`)).map((column) => column.name));
  const staging = await one<{ phase: string; state: string }>(env.DB, 'SELECT phase,state FROM move_staging WHERE operation_id=?', input.operation_id);
  if (!staging || staging.phase !== input.phase) throw new Error('move_snapshot_phase_changed');
  for (const row of rows) {
    if (Object.keys(row.data).some((column) => !columns.has(column)) || await sha256(canonicalJson(row.data)) !== row.sha256) throw new Error('move_row_invalid');
    const requestScopes = table === 'idempotency_keys' && row.data.repo_id === null ? JSON.parse(String(row.data.policy_json)) as { repo_id?: string; scope?: { repo_id?: string } }[] : [];
    const pendingRequest = requestScopes.some((policy) => policy.repo_id === input.repo_id || policy.scope?.repo_id === input.repo_id);
    const runnerType = repositoryRunnerTables[table as keyof typeof repositoryRunnerTables];
    const runner = runnerType ? await resolveResourceLocator(env, String(row.data.id), runnerType) : null;
    const runnerScope = runner?.authority === 'repository' && runner.repo_id === input.repo_id;
    if (runnerType && !runnerScope) throw new Error('move_runner_authority_mismatch');
    if (table === 'repositories' ? row.data.id !== input.repo_id : 'repo_id' in row.data && row.data.repo_id !== input.repo_id && !pendingRequest && !runnerScope) throw new Error('move_row_scope_mismatch');
    if (staging.state !== 'receiving') {
      const existing = await one<{ sha256: string }>(env.DB, 'SELECT sha256 FROM move_snapshot_rows WHERE operation_id=? AND table_name=? AND row_key=?', input.operation_id, table, row.row_key);
      if (existing?.sha256 !== row.sha256) throw new Error('move_snapshot_frozen');
    }
  }
  if (staging.state !== 'receiving') return;
  await ownerBatch(env, input.repo_id, input.operation_id, rows.map((row) => stmt(env.DB, `INSERT INTO move_snapshot_rows(operation_id,table_name,row_key,data_json,sha256)
    VALUES(?,?,?,?,?) ON CONFLICT(operation_id,table_name,row_key) DO UPDATE SET data_json=excluded.data_json,sha256=excluded.sha256`,
  input.operation_id, table, row.row_key, canonicalJson(row.data), row.sha256)));
}

function controlInput(control: MoveControl): MoveInput {
  return { operation_id: control.operation_id, repo_id: control.repo_id, source_cell_id: control.source_cell_id, source_shard_id: control.source_shard_id,
    target_cell_id: control.target_cell_id, target_shard_id: control.target_shard_id, source_epoch: control.source_epoch, phase: 'final' };
}

async function targetControl(env: OperationsBindings, input: MoveInput): Promise<MoveControl> {
  const control = await moveControl(env, input.operation_id);
  const expected = controlInput(control);
  if (!sameMovePlacement(control, env, 'target') || Object.keys(expected).some(key => key !== 'phase'
    && expected[key as keyof MoveInput] !== input[key as keyof MoveInput])) throw new Error('move_destination_identity_changed');
  return control;
}

async function destinationJSON<T>(env: OperationsBindings, input: MoveInput, action: string, extra: Record<string, unknown> = {}): Promise<T> {
  if (input.target_cell_id === env.CELL_ID) return moveAction(shardEnvironment(env, input.target_shard_id), action, { ...input, ...extra }) as Promise<T>;
  return privateJSON<T>(env, backgroundCell(env, input.target_cell_id), 'operations.move', `/internal/moves/${action}`, { ...input, ...extra });
}

async function copyMetadata(env: OperationsBindings, input: MoveInput): Promise<string> {
  await destinationJSON(env, input, 'begin');
  let resourceCursor = '';
  for (;;) {
    const resources = await many<{ resource_id: string; resource_type: string }>(identityBinding(env), `SELECT resource_id,resource_type FROM resource_locators
      WHERE authority='repository' AND repo_id=? AND resource_type IN ('runner_pool','runner_enrollment','runner') AND resource_id>? ORDER BY resource_id LIMIT 100`, input.repo_id, resourceCursor);
    if (!resources.length) break;
    await env.DB.batch(resources.map(row => stmt(env.DB, 'INSERT OR IGNORE INTO move_repository_resources(repo_id,resource_id,resource_type) VALUES(?,?,?)', input.repo_id, row.resource_id, row.resource_type)));
    resourceCursor = resources.at(-1)!.resource_id;
  }
  let snapshot = await one<{ tables_json: string }>(env.DB, 'SELECT tables_json FROM move_source_snapshots WHERE operation_id=?', input.operation_id);
  if (!snapshot) {
    const scopes = await tableScopes(env.DB);
    const statements: D1PreparedStatement[] = [];
    for (const { name, predicate } of scopes) statements.push(stmt(env.DB,
      `INSERT INTO move_source_rows(operation_id,table_name,row_key,data_json) SELECT ?,?,rowid,${await rowJsonExpression(env.DB, name)} FROM ${name} WHERE ${predicate}`,
      input.operation_id, name, input.repo_id));
    statements.push(stmt(env.DB, 'INSERT INTO move_source_snapshots(operation_id,tables_json,captured_at) VALUES(?,?,?)', input.operation_id,
      JSON.stringify(scopes.map(row => row.name)), now()));
    await ownerBatch(env, input.repo_id, input.operation_id, statements);
    snapshot = (await one<{ tables_json: string }>(env.DB, 'SELECT tables_json FROM move_source_snapshots WHERE operation_id=?', input.operation_id))!;
  }
  const hash = createHash('sha256');
  for (const name of JSON.parse(snapshot.tables_json) as string[]) {
    let cursor = 0;
    while (true) {
      const saved = await many<{ row_key: number; data_json: string }>(env.DB,
        'SELECT row_key,data_json FROM move_source_rows WHERE operation_id=? AND table_name=? AND row_key>? ORDER BY row_key LIMIT 20', input.operation_id, name, cursor);
      const values = saved.map<Record<string, unknown> & { __cursor: number }>(row => ({
        ...JSON.parse(row.data_json) as Record<string, unknown>, __cursor: row.row_key,
      }));
      if (!values.length) break;
      const rows: SnapshotRow[] = [];
      for (const { __cursor, ...data } of values) {
        const digest = await sha256(canonicalJson(data));
        rows.push({ row_key: Number(__cursor), data, sha256: digest });
        hash.update(`${name}:${__cursor}:${digest}\n`);
      }
      await sendSnapshotRows(env, input, name, rows);
      cursor = Number(values.at(-1)!.__cursor);
      await ownerExecute(env, input.repo_id, input.operation_id, 'UPDATE shard_moves SET copy_cursor=?,updated_at=? WHERE operation_id=?', `${name}:${cursor}`, now(), input.operation_id);
    }
  }
  return hash.digest('hex');
}

async function sendSnapshotRows(env: OperationsBindings, input: MoveInput, table: string, rows: SnapshotRow[]): Promise<void> {
  let batch: SnapshotRow[] = [];
  let size = 0;
  for (const row of rows) {
    const bytes = new TextEncoder().encode(JSON.stringify(row)).byteLength;
    if (bytes > 3 * 1024 * 1024) throw new Error('move_row_size_limit');
    if (batch.length && size + bytes > 3 * 1024 * 1024) { await destinationJSON(env, input, 'rows', { table, rows: batch }); batch = []; size = 0; }
    batch.push(row); size += bytes;
  }
  if (batch.length) await destinationJSON(env, input, 'rows', { table, rows: batch });
}

async function* backupRows(env: OperationsBindings, manifest: ArchiveManifest, table: string, operation: Operation, repo: Repository): AsyncGenerator<Record<string, unknown>> {
  if (table === 'repositories') {
    yield { ...manifest.repository, owner_id: repo.owner_id, visibility: repo.visibility, policy_revision: repo.policy_revision,
      revision: repo.revision, routing_epoch: repo.routing_epoch, cell_id: repo.cell_id, shard_id: repo.shard_id, state: 'moving' };
    return;
  }
  if (table === 'operations') {
    const row = await one<Record<string, unknown>>(env.DB, 'SELECT * FROM operations WHERE id=?', operation.id);
    if (row) yield row;
    const backup = await one<Record<string, unknown>>(env.DB, 'SELECT o.* FROM operations o JOIN repository_archives a ON a.operation_id=o.id WHERE a.id=? AND o.id<>?', manifest.archive_id, operation.id);
    if (backup) yield backup;
    for (const part of manifest.parts.filter(entry => entry.path.startsWith('metadata/operations/'))) {
      const rows = JSON.parse(new TextDecoder().decode(await verifiedPart(env, part))) as Record<string, unknown>[];
      for (const row of rows) if (row.id !== operation.id && row.id !== backup?.id) yield row;
    }
    return;
  }
  if (table === 'repository_archives') {
    const row = await one<Record<string, unknown>>(env.DB, 'SELECT * FROM repository_archives WHERE id=?', manifest.archive_id);
    if (row) yield row;
    return;
  }
  if (table === 'archive_parts') {
    for (const row of await many<Record<string, unknown>>(env.DB, 'SELECT * FROM archive_parts WHERE archive_id=? ORDER BY path', manifest.archive_id)) yield row;
    return;
  }
  if (table === 'archive_audiences') {
    for (const row of await many<Record<string, unknown>>(env.DB, 'SELECT * FROM archive_audiences WHERE archive_id=? ORDER BY repository_id', manifest.archive_id)) yield row;
    return;
  }
  if (table === 'archive_ref_audiences') {
    for (const row of await many<Record<string, unknown>>(env.DB, 'SELECT * FROM archive_ref_audiences WHERE archive_id=? ORDER BY ref', manifest.archive_id)) yield row;
    return;
  }
  for (const part of manifest.parts.filter((entry) => entry.path.startsWith(`metadata/${table}/`)).sort((a, b) => a.path.localeCompare(b.path))) {
    const rows = JSON.parse(new TextDecoder().decode(await verifiedPart(env, part))) as Record<string, unknown>[];
    for (const row of rows) {
      if (['object_manifests', 'repository_rules', 'workflows'].includes(table)) row.account_id = repo.owner_id;
      yield row;
    }
  }
  if (table === 'object_manifests') {
    let cursor = '';
    while (true) {
      const rows = await many<Record<string, unknown>>(env.DB, `SELECT * FROM object_manifests WHERE id>? AND kind='archive_chunk'
        AND object_key IN(SELECT object_key FROM archive_parts WHERE archive_id=?) ORDER BY id LIMIT 50`, cursor, manifest.archive_id);
      if (!rows.length) break;
      for (const row of rows) yield row;
      cursor = String(rows.at(-1)!.id);
    }
  }
}

async function copyBackupMetadata(env: OperationsBindings, input: MoveInput, archiveId: string, operation: Operation, repo: Repository): Promise<string> {
  const manifest = await readArchive(env, archiveId, repo.id);
  if (!await one(env.DB, 'SELECT 1 FROM move_source_snapshots WHERE operation_id=?', operation.id)) {
    const scopes = await tableScopes(env.DB);
    for (const { name } of scopes) {
      let key = 0, rows: D1PreparedStatement[] = [];
      for await (const data of backupRows(env, manifest, name, operation, repo)) {
        rows.push(stmt(env.DB, 'INSERT OR IGNORE INTO move_source_rows(operation_id,table_name,row_key,data_json) VALUES(?,?,?,?)', operation.id, name, ++key, canonicalJson(data)));
        if (rows.length === 10) { await ownerBatch(env, repo.id, operation.id, rows); rows = []; }
      }
      if (rows.length) await ownerBatch(env, repo.id, operation.id, rows);
    }
    await ownerExecute(env, repo.id, operation.id, 'INSERT OR IGNORE INTO move_source_snapshots(operation_id,tables_json,captured_at) VALUES(?,?,?)',
      operation.id, canonicalJson(scopes.map(row => row.name)), now());
  }
  return copyMetadata(env, input);
}

async function applySnapshot(env: OperationsBindings, input: MoveInput): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const staging = await one<{ phase: string; state: string; native_storage_name: string | null }>(db, 'SELECT phase,state,native_storage_name FROM move_staging WHERE operation_id=?', input.operation_id);
  if (staging?.phase !== 'final') throw new Error('move_final_snapshot_required');
  if (['verified', 'active'].includes(staging.state)) return;
  await validateSnapshotScopes(env, input);
  const references = new MoveReferences(env, input.repo_id);
  const names = (await many<{ table_name: string }>(db, 'SELECT DISTINCT table_name FROM move_snapshot_rows WHERE operation_id=?', input.operation_id)).map((row) => row.table_name);
  const all: D1PreparedStatement[] = [stmt(db, 'PRAGMA defer_foreign_keys=ON')];
  for (const table of names) {
    const keys = (await many<Column>(db, `PRAGMA table_info(${table})`)).filter((column) => column.pk).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    if (!keys.length) throw new Error('move_table_key_missing');
    let cursor = 0;
    while (true) {
      const rows = await many<{ row_key: number; data_json: string }>(db,
        'SELECT row_key,data_json FROM move_snapshot_rows WHERE operation_id=? AND table_name=? AND row_key>? ORDER BY row_key LIMIT 20', input.operation_id, table, cursor);
      if (!rows.length) break;
      await references.forRows(table, rows.map(record => JSON.parse(record.data_json) as Record<string, unknown>));
      for (const record of rows) {
        const data = JSON.parse(record.data_json) as Record<string, unknown>;
        if (table === 'repositories') {
          data.cell_id = env.CELL_ID; data.shard_id = env.SHARD_ID; data.routing_epoch = input.source_epoch + 1; data.state = 'moving';
          if (staging.native_storage_name) data.storage_name = staging.native_storage_name;
        }
        const existing = await one<Record<string, unknown>>(db, `SELECT * FROM ${table} WHERE ${keys.map((key) => `${key} IS ?`).join(' AND ')}`, ...keys.map((key) => data[key]));
        if (existing) {
          if (canonicalJson(existing) !== canonicalJson(data)) throw new Error(`move_target_conflict:${table}`);
          continue;
        }
      }
      cursor = rows.at(-1)!.row_key;
    }
    const first = await one<{ data_json: string }>(db, 'SELECT data_json FROM move_snapshot_rows WHERE operation_id=? AND table_name=? ORDER BY row_key LIMIT 1', input.operation_id, table);
    if (!first) continue;
    const fields = Object.keys(JSON.parse(first.data_json) as Record<string, unknown>);
    const values: unknown[] = [];
    const expressions = fields.map(field => {
      if (table === 'repositories') {
        const replacements: Record<string, unknown> = { cell_id: env.CELL_ID, shard_id: env.SHARD_ID, routing_epoch: input.source_epoch + 1, state: 'moving',
          ...(staging.native_storage_name ? { storage_name: staging.native_storage_name } : {}) };
        if (Object.hasOwn(replacements, field)) { values.push(replacements[field]); return '?'; }
      }
      return `json_extract(data_json,'$.${field}')`;
    });
    all.push(stmt(db, `INSERT INTO ${table}(${fields.join(',')}) SELECT ${expressions.join(',')} FROM move_snapshot_rows
      WHERE operation_id=? AND table_name=? ON CONFLICT(${keys.join(',')}) DO NOTHING`, ...values, input.operation_id, table));
  }
  all.push(stmt(db, `UPDATE move_staging SET state='applying',updated_at=? WHERE operation_id=?`, now(), input.operation_id));
  await ownerBatch(env, input.repo_id, input.operation_id, all);
}

async function validateSnapshotScopes(env: OperationsBindings, input: MoveInput): Promise<void> {
  const parents: Record<string, { field: string; table: string; context?: boolean; key?: string }> = {
    role_capabilities: { field: 'role_id', table: 'roles' },
    event_publications: { field: 'event_id', table: 'outbox' }, event_consumer_jobs: { field: 'event_id', table: 'outbox' },
    operation_steps: { field: 'operation_id', table: 'operations' }, operation_dispatches: { field: 'operation_id', table: 'operations' },
    webhook_keys: { field: 'webhook_id', table: 'webhooks' }, archive_parts: { field: 'archive_id', table: 'repository_archives' },
    archive_components: { field: 'archive_id', table: 'repository_archives' }, mail_provider_events: { field: 'delivery_id', table: 'mail_deliveries' },
    archive_audiences: { field: 'archive_id', table: 'repository_archives' },
    archive_ref_audiences: { field: 'archive_id', table: 'repository_archives' },
    archive_snapshots: { field: 'archive_id', table: 'repository_archives' },
    archive_snapshot_rows: { field: 'archive_id', table: 'repository_archives' },
    repository_restore_rows: { field: 'operation_id', table: 'repository_restore_plans', key: 'operation_id' },
    repository_restore_previous_rows: { field: 'operation_id', table: 'repository_restore_plans', key: 'operation_id' },
    vault_versions: { field: 'entry_id', table: 'vault_entries' }, vault_version_revocations: { field: 'entry_id', table: 'vault_entries' },
    vault_key_wraps: { field: 'ciphertext_id', table: 'vault_ciphertexts', context: true }, vault_operations: { field: 'resource_id', table: 'vault_entries' },
  };
  for (const [table, parent] of Object.entries(parents)) {
    const scope = parent.context ? "json_extract(json_extract(p.data_json,'$.context_json'),'$.repo_id')" : "json_extract(p.data_json,'$.repo_id')";
    const invalid = await one(env.DB, `SELECT 1 FROM move_snapshot_rows r WHERE r.operation_id=? AND r.table_name=?
      AND NOT EXISTS(SELECT 1 FROM move_snapshot_rows p WHERE p.operation_id=r.operation_id AND p.table_name=?
        AND json_extract(p.data_json,'$.${parent.key ?? 'id'}')=json_extract(r.data_json,?) AND ${scope}=?) LIMIT 1`, input.operation_id, table, parent.table, `$.${parent.field}`, input.repo_id);
    if (invalid) throw new Error('move_related_row_scope_mismatch');
  }
  const invalidReceipt = await one(env.DB, `SELECT 1 FROM move_snapshot_rows r WHERE r.operation_id=? AND r.table_name='processed_events'
    AND NOT EXISTS(SELECT 1 FROM move_snapshot_rows p WHERE p.operation_id=r.operation_id
      AND p.table_name IN ('outbox','operations','object_manifests','repository_archives')
      AND json_extract(p.data_json,'$.id')=json_extract(r.data_json,'$.event_id') AND json_extract(p.data_json,'$.repo_id')=?) LIMIT 1`,
  input.operation_id, input.repo_id);
  if (invalidReceipt) throw new Error('move_receipt_scope_mismatch');
  if (await one(env.DB, `SELECT 1 FROM move_snapshot_rows WHERE operation_id=? AND
    ((table_name='storage_quotas' AND json_extract(data_json,'$.scope_id')<>?) OR
     (table_name='vault_ciphertexts' AND json_extract(json_extract(data_json,'$.context_json'),'$.repo_id')<>?)) LIMIT 1`, input.operation_id, input.repo_id, input.repo_id)) throw new Error('move_row_scope_mismatch');
}

async function verifySnapshot(env: OperationsBindings, input: MoveInput, expected: string, applied: boolean): Promise<{ verified: true; sha256: string }> {
  const db = env.DB.withSession('first-primary');
  const hash = createHash('sha256');
  const placement = await one<{ native_storage_name: string | null; state: string; repository_state: string | null; updated_at: string }>(db,
    'SELECT native_storage_name,state,repository_state,updated_at FROM move_staging WHERE operation_id=?', input.operation_id);
  // Source emits repositories first, then alphabetical table order.
  const tables = await tableScopes(db);
  for (const { name } of tables) {
    const columns = await many<Column>(db, `PRAGMA table_info(${name})`);
    const keys = columns.filter((column) => column.pk).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    let cursor = 0;
    while (true) {
      const rows = await many<{ row_key: number; data_json: string; sha256: string }>(db,
        'SELECT row_key,data_json,sha256 FROM move_snapshot_rows WHERE operation_id=? AND table_name=? AND row_key>? ORDER BY row_key LIMIT 20', input.operation_id, name, cursor);
      if (!rows.length) break;
      for (const row of rows) {
        const original = await movedStorageRow(env, input.operation_id, name, JSON.parse(row.data_json) as Record<string, unknown>);
        hash.update(`${name}:${row.row_key}:${row.sha256}\n`);
        if (!applied) continue;
        if (!keys.length) throw new Error('move_table_key_missing');
        const actual = await one<Record<string, unknown>>(db, `SELECT * FROM ${name} WHERE ${keys.map((key) => `${key} IS ?`).join(' AND ')}`, ...keys.map((key) => original[key]));
        if (!actual) throw new Error('move_row_missing');
        if (name === 'repositories') {
          original.cell_id = env.CELL_ID; original.shard_id = env.SHARD_ID; original.routing_epoch = input.source_epoch + 1; original.state = 'moving';
          if (placement?.native_storage_name) original.storage_name = placement.native_storage_name;
          if (placement?.state === 'active') {
            original.state = placement.repository_state;
            original.revision = Number(original.revision) + 1;
            original.updated_at = placement.updated_at;
          }
        }
        if (canonicalJson(actual) !== canonicalJson(original)) throw new Error(`move_row_verification_failed:${name}`);
      }
      cursor = rows.at(-1)!.row_key;
    }
  }
  const digest = hash.digest('hex');
  if (digest !== expected) throw new Error('move_snapshot_checksum_mismatch');
  if (applied) await ownerExecute(env, input.repo_id, input.operation_id, `UPDATE move_staging SET state='verified',snapshot_sha256=?,updated_at=? WHERE operation_id=? AND state<>'active'`, digest, now(), input.operation_id);
  return { verified: true, sha256: digest };
}

export async function moveAction(env: OperationsBindings, action: string, value: Record<string, unknown>): Promise<unknown> {
  const input = value as unknown as MoveInput;
  if (input.target_cell_id !== env.CELL_ID || input.target_shard_id !== env.SHARD_ID) throw new Error('move_destination_mismatch');
  const control = await targetControl(env, input);
  if (action === 'discard') return discardDestination(env, control);
  if (['aborting', 'aborted'].includes(control.state)) throw new Error('move_destination_aborted');
  if (action === 'begin') { await stageStart(env, input); return { accepted: true }; }
  if (action === 'abort-physical') return abortRepositoryStoragePlacement(env, { operation_id: input.operation_id });
  const staging = await one<{ repo_id: string; source_epoch: number }>(env.DB, 'SELECT repo_id,source_epoch FROM move_staging WHERE operation_id=?', input.operation_id);
  if (!staging || staging.repo_id !== input.repo_id || staging.source_epoch !== input.source_epoch) throw new Error('move_not_staged');
  if (action === 'declare-objects') { await acceptMoveObjects(env, control, value.objects as MovePhysicalObject[]); return { accepted: true }; }
  if (action === 'inventory') return moveInventory(env, control.operation_id);
  if (action === 'verify-objects') { await verifyMoveObjects(env, control); return { verified: true }; }
  if (action === 'storage-receipts') {
    if (!['committed', 'cleaning', 'active'].includes(control.state)) throw new Error('move_storage_not_committed');
    await applyMoveStorageReceipts(env, control);
    return { applied: true };
  }
  if (action === 'rows') { await stageRows(env, input, String(value.table), value.rows as SnapshotRow[]); return { accepted: true }; }
  if (action === 'apply') { await applySnapshot(env, input); return { applied: true }; }
  if (action === 'restore-git') {
    const operation = await one<Operation>(env.DB, 'SELECT * FROM operations WHERE id=? AND repo_id=?', input.operation_id, input.repo_id);
    if (!operation) throw new Error('move_operation_missing');
    const completed = await one<{ native_storage_name: string | null; native_receipt_json: string | null }>(env.DB,
      'SELECT native_storage_name,native_receipt_json FROM move_staging WHERE operation_id=?', input.operation_id);
    if (completed?.native_storage_name && completed.native_receipt_json) {
      const receipt = JSON.parse(completed.native_receipt_json) as { archive_id: string; storage_name: string };
      if (receipt.archive_id !== value.archive_id || receipt.storage_name !== completed.native_storage_name) throw new Error('move_native_receipt_conflict');
      return { verified: true };
    }
    const restored = await restoreGit(env, operation, String(value.archive_id));
    await ownerBatch(env, input.repo_id, input.operation_id, [
      stmt(env.DB, `UPDATE repositories SET storage_name=? WHERE id=? AND routing_epoch=? AND state='moving'`, restored.storage_name, input.repo_id, input.source_epoch + 1),
      stmt(env.DB, 'UPDATE move_staging SET native_storage_name=?,native_receipt_json=? WHERE operation_id=?', restored.storage_name, JSON.stringify({ ...restored, archive_id: value.archive_id }), input.operation_id),
    ]);
    return { verified: true };
  }
  if (action === 'verify') {
    if (!control.snapshot_sha256 || value.sha256 !== control.snapshot_sha256) throw new Error('move_source_snapshot_changed');
    return verifySnapshot(env, input, control.snapshot_sha256, value.applied === true);
  }
  if (action === 'finalize') {
    if (!control.snapshot_sha256 || value.sha256 !== control.snapshot_sha256) throw new Error('move_source_snapshot_changed');
    if (control.state !== 'active' && control.state !== 'completed') throw new Error('move_settlement_pending');
    const finance = await storagePlacement(env, control.operation_id);
    if (finance.state !== 'complete' || finance.effective_at !== control.effective_at) throw new Error('move_settlement_unverified');
    const verified = await one<{ state: string; repository_state: string | null }>(env.DB,
      `SELECT state,repository_state FROM move_staging WHERE operation_id=? AND state IN ('verified','active') AND snapshot_sha256=?`, input.operation_id, value.sha256);
    if (!verified) throw new Error('move_not_verified');
    const finalState = value.repository_state === 'archived' ? 'archived' : 'active';
    if (verified.state === 'active') {
      if (verified.repository_state !== finalState || !await one(env.DB, 'SELECT 1 FROM repositories WHERE id=? AND state=? AND routing_epoch=?',
        input.repo_id, finalState, input.source_epoch + 1)) throw new Error('move_finalization_receipt_changed');
      return { active: true, epoch: input.source_epoch + 1 };
    }
    const repository = await one<{ owner_id: string }>(env.DB, 'SELECT owner_id FROM repositories WHERE id=? AND routing_epoch=?', input.repo_id, input.source_epoch + 1);
    if (!repository) throw new Error('move_repository_missing');
    await registerRepositoryPlacement(env, { repo_id: input.repo_id, account_id: repository.owner_id,
      cell_id: env.CELL_ID, shard_id: env.SHARD_ID, epoch: input.source_epoch + 1 });
    const finalizedAt = now();
    await ownerBatch(env, input.repo_id, input.operation_id, [
      ...(value.restore === true ? [
        stmt(env.DB, `UPDATE workflows SET state='disabled',revision=revision+1,updated_at=? WHERE repo_id=? AND state='active'`, now(), input.repo_id),
        stmt(env.DB, `UPDATE workflow_runs SET status='cancelled',reason='repository_restored',revision=revision+1,updated_at=?,completed_at=? WHERE repo_id=? AND status IN ('queued','running','waiting','waiting_approval','cancelling')`, now(), now(), input.repo_id),
        stmt(env.DB, `UPDATE execution_attempts SET status='cancelled',credential_hash=NULL,revision=revision+1,updated_at=? WHERE repo_id=? AND status IN ('queued','accepted','admitting','leased','running','cancelling')`, now(), input.repo_id),
      ] : []),
      stmt(env.DB, `UPDATE repositories SET state=?,revision=revision+1,updated_at=? WHERE id=? AND routing_epoch=? AND state='moving'`, finalState, finalizedAt, input.repo_id, input.source_epoch + 1),
      stmt(env.DB, `UPDATE move_staging SET state='active',repository_state=?,updated_at=? WHERE operation_id=?`, finalState, finalizedAt, input.operation_id),
    ]);
    return { active: true, epoch: input.source_epoch + 1 };
  }
  if (action === 'confirm') {
    if (control.state !== 'active' && control.state !== 'completed') throw new Error('move_confirmation_fenced');
    if (!control.source_barrier_released_at) throw new Error('move_source_barrier_held');
    const eventId = `evt_move_${input.operation_id}`;
    const receipt = await operationFence(env.DB, input.operation_id);
    if (!receipt || receipt.fence_id !== control.target_fence_id) throw new Error('move_destination_fence_missing');
    if (await one(env.DB, 'SELECT 1 FROM outbox WHERE id=?', eventId)) {
      await releaseMetadataFence(env, receipt);
      return { confirmed: true };
    }
    const directory = (env.DIRECTORY_DB ?? identityBinding(env)).withSession('first-primary');
    const route = await one(directory, `SELECT 1 FROM resource_routes WHERE resource_id=? AND cell_id=? AND shard_id=? AND epoch=? AND state='active'`, input.repo_id, env.CELL_ID, env.SHARD_ID, input.source_epoch + 1);
    if (!route) throw new Error('move_directory_not_confirmed');
    const repository = await one<{ revision: number; owner_id: string }>(env.DB, 'SELECT revision,owner_id FROM repositories WHERE id=?', input.repo_id);
    if (!repository) throw new Error('move_repository_missing');
    if (!await one(env.DB, 'SELECT 1 FROM outbox WHERE id=?', eventId)) {
      await ownerBatch(env, input.repo_id, input.operation_id, [
        stmt(env.DB, `UPDATE operations SET status='completed',phase='completed',progress=100,revision=revision+1,result_json=?,updated_at=?,completed_at=? WHERE id=? AND status<>'completed'`,
          JSON.stringify({ repository_id: input.repo_id, moved: true, restored: value.restore === true }), now(), now(), input.operation_id),
        eventStatement(env.DB, { id: eventId, type: value.restore === true ? 'repository.restored' : 'repository.moved', resource_id: input.repo_id,
          resource_revision: repository.revision, repo_id: input.repo_id, account_id: repository.owner_id, data: { operation_id: input.operation_id } }),
      ]);
    }
    await releaseMetadataFence(env, receipt);
    return { confirmed: true };
  }
  throw new Error('unknown_move_action');
}

async function discardDestination(env: OperationsBindings, control: MoveControl): Promise<{ discarded: true }> {
  if (control.state !== 'aborting' && control.state !== 'aborted') throw new Error('move_abort_not_decided');
  const receipt = await operationFence(env.DB, control.operation_id);
  if (!receipt) {
    if (await one(env.DB, 'SELECT 1 FROM repositories WHERE id=?', control.repo_id)) throw new Error('move_destination_unowned');
    return { discarded: true };
  }
  if (await one(env.DB, 'SELECT 1 FROM repository_metadata_fence_receipts WHERE operation_id=? AND released_at IS NOT NULL', control.operation_id)) {
    if (await one(env.DB, 'SELECT 1 FROM repositories WHERE id=?', control.repo_id)) throw new Error('move_destination_discard_changed');
    return { discarded: true };
  }
  const finance = await one<{ state: string }>(identityBinding(env), 'SELECT state FROM billing_storage_placements WHERE operation_id=?', control.operation_id);
  if (finance && finance.state !== 'aborted') throw new Error('move_abort_storage_unconfirmed');
  const db = env.DB.withSession('first-primary'), statements: D1PreparedStatement[] = [stmt(db, 'PRAGMA defer_foreign_keys=ON')];
  for (const { name } of (await tableScopes(db)).reverse()) {
    const columns = await many<Column>(db, `PRAGMA table_info(${name})`);
    if (name === 'repositories') statements.push(stmt(db, 'DELETE FROM repositories WHERE id=? AND cell_id=? AND shard_id=? AND routing_epoch=? AND state=\'moving\'',
      control.repo_id, control.target_cell_id, control.target_shard_id, control.target_epoch));
    else if (columns.some(column => column.name === 'repo_id') && !Object.hasOwn(repositoryRunnerTables, name)) statements.push(stmt(db, `DELETE FROM ${name} WHERE repo_id=?`, control.repo_id));
    else {
      const keys = columns.filter(column => column.pk).map(column => column.name);
      if (!keys.length) throw new Error('move_table_key_missing');
      statements.push(stmt(db, `DELETE FROM ${name} WHERE EXISTS(SELECT 1 FROM move_snapshot_rows s WHERE s.operation_id=? AND s.table_name=?
        AND ${keys.map(key => `${name}.${key} IS json_extract(s.data_json,'$.${key}')`).join(' AND ')})`, control.operation_id, name));
    }
  }
  await ownerBatch(env, control.repo_id, control.operation_id, statements);
  await releaseMetadataFence(env, receipt);
  return { discarded: true };
}

export async function receiveMoveObject(env: OperationsBindings, request: Request): Promise<Response> {
  // Old callers can recover their operation, but cannot bypass the billing-owned writer generation.
  await request.body?.cancel();
  const operationId = new URL(request.url).searchParams.get('operation_id');
  if (!operationId) throw new Error('move_object_not_declared');
  const result = await copyRepositoryStoragePlacement(env, { operation_id: operationId });
  return Response.json({ verified: !result.remaining });
}

export async function runShardMove(env: OperationsBindings, operation: Operation): Promise<Record<string, unknown>> {
  let control = await one<MoveControl>(identityBinding(env), 'SELECT * FROM repository_move_controls WHERE operation_id=?', operation.id);
  if (control && !sameMovePlacement(control, env, 'source')) return recoverShardMove(env, operation.id);
  if (control?.state === 'aborting' || control?.state === 'aborted') return abortShardMove(env, operation.id);
  const params = JSON.parse(operation.input_json) as MoveParameters;
  if (!control || control.state === 'preparing' || control.state === 'copying') {
    control = await holdMoveSource(env, operation, params);
    control = await prepareMoveCopies(env, operation, control, params);
  }
  if (control.state === 'verified') control = await advanceMoveControl(env, control, 'cutover', { effective_at: now() });
  if (control.state === 'cutover') {
    await billingPages('commit', () => commitRepositoryStoragePlacement(env, { operation_id: control!.operation_id, effective_at: control!.effective_at! }));
    await verifyMovedStorageBilling(env, control.repo_id, control.target_cell_id);
    control = await advanceMoveControl(env, control, 'committed');
  }
  if (control.state === 'committed') {
    await destinationJSON(env, controlInput(control), 'storage-receipts');
    await destinationJSON(env, controlInput(control), 'verify', { sha256: control.snapshot_sha256, applied: true });
    await switchMoveDirectory(env, operation, control, !!params.archive_id);
    control = await advanceMoveControl(env, control, 'cleaning');
  }
  if (control.state === 'cleaning') {
    await billingPages('cleanup', () => finalizeRepositoryStoragePlacement(env, { operation_id: control!.operation_id }));
    await verifyMoveSourceCleanup(env, control);
    control = await advanceMoveControl(env, control, 'active', { cleanup_verified_at: now(), source_retained_until: new Date(Date.now() + 30 * 86400_000).toISOString() });
  }
  if (control.state === 'active') control = await finishMove(env, operation, control, !!params.archive_id);
  if (control.state !== 'completed') throw new Error('move_completion_unconfirmed');
  return moveResult(control, !!params.archive_id);
}

interface MoveParameters { target_cell_id: string; target_shard_id: string; archive_id?: string; expected_epoch: number; source_state: MoveControl['source_state'] }

function moveResult(control: MoveControl, restored = false): Record<string, unknown> {
  return { repository_id: control.repo_id, moved: control.state !== 'aborted', restored, routing_epoch: control.state === 'aborted' ? control.abort_epoch : control.target_epoch };
}

async function billingPages(phase: string, action: () => Promise<PlacementProgress>): Promise<void> {
  for (let page = 0; page < 10000; page++) {
    const result = await action();
    if (!result.remaining) return;
    if (!result.processed && !['complete', 'aborted'].includes(result.state)) throw new Error(`move_physical_${phase}_pending`);
  }
  throw new Error(`move_physical_${phase}_page_limit`);
}

async function holdMoveSource(env: OperationsBindings, operation: Operation, params: MoveParameters): Promise<MoveControl> {
  const repo = await one<Repository>(env.DB, 'SELECT * FROM repositories WHERE id=?', operation.repo_id);
  if (!repo || repo.owner_id !== operation.account_id || repo.cell_id !== env.CELL_ID || repo.shard_id !== env.SHARD_ID
    || repo.routing_epoch !== params.expected_epoch || !['active', 'archived', 'deleted'].includes(params.source_state)
    || params.target_cell_id === env.CELL_ID && params.target_shard_id === env.SHARD_ID) throw new Error('invalid_move_destination');
  await claimOperationRuntime(env, operation.id, 'move-shard');
  await ownerExecute(env, repo.id, operation.id, `INSERT OR IGNORE INTO shard_moves(operation_id,repo_id,source_cell_id,source_shard_id,target_cell_id,target_shard_id,source_epoch,target_epoch,source_state,state,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,'copying',?)`, operation.id, repo.id, env.CELL_ID, env.SHARD_ID, params.target_cell_id, params.target_shard_id,
  repo.routing_epoch, repo.routing_epoch + 1, params.source_state, now());
  const token = `move_${operation.id}`;
  const barrier = await privateJSON<{ held: boolean }>(env, env.GIT_SERVICE, 'git-service', `/internal/git/repositories/${repo.id}/barrier`, { operation_id: operation.id, owner: operation.id, token });
  if (barrier.held !== true) throw new Error('move_barrier_missing');
  await ownerExecute(env, repo.id, operation.id, `UPDATE operations_maintenance_intents SET barrier_token_hash=?,barrier_held_at=COALESCE(barrier_held_at,?)
    WHERE operation_id=? AND barrier_released_at IS NULL`, await sha256(token), now(), operation.id);
  const changed = await execute(env.DIRECTORY_DB ?? identityBinding(env), `UPDATE resource_routes SET state='fenced',updated_at=? WHERE resource_id=? AND cell_id=?
    AND shard_id=? AND epoch=? AND operation_id=? AND destination_cell_id=? AND destination_shard_id=? AND state IN ('moving','fenced')`,
  now(), repo.id, env.CELL_ID, env.SHARD_ID, repo.routing_epoch, operation.id, params.target_cell_id, params.target_shard_id);
  if (changed.meta.changes !== 1) throw new Error('move_directory_conflict');
  await quiesceExecution(env, operation);
  await drainRepositoryObjects(env, repo.id, operation.id);
  await drainRepositoryAttachmentDeletions(env, repo.id, operation.id);
  if (await one(env.DB, "SELECT 1 FROM object_manifests WHERE repo_id=? AND state IN ('reserving','pending','uploading','deleting') LIMIT 1", repo.id)) throw new Error('move_storage_work_draining');
  if (await one(env.DB, `SELECT 1 FROM webhook_deliveries WHERE repo_id=? AND state='sending' AND lease_until>?
    UNION ALL SELECT 1 FROM mail_deliveries WHERE repo_id=? AND state='sending' AND lease_until>?
    UNION ALL SELECT 1 FROM event_consumer_jobs j JOIN outbox o ON o.id=j.event_id WHERE o.repo_id=? AND j.state='running' AND j.lease_until>? LIMIT 1`,
  repo.id, now(), repo.id, now(), repo.id, now())) throw new Error('move_background_work_draining');
  const metadata = await acquireMetadataFence(env, repo.id, operation.id, repo.routing_epoch);
  await ownerExecute(env, repo.id, operation.id, "UPDATE shard_moves SET state='fenced',updated_at=? WHERE operation_id=?", now(), operation.id);
  await ownerExecute(env, repo.id, operation.id, 'UPDATE event_replays SET source_cell_id=COALESCE(source_cell_id,?),source_shard_id=COALESCE(source_shard_id,?) WHERE repo_id=?', env.CELL_ID, env.SHARD_ID, repo.id);
  return initializeMoveControl(env, { operation_id: operation.id, repository: repo, target_cell_id: params.target_cell_id, target_shard_id: params.target_shard_id,
    source_state: params.source_state, metadata_fence: metadata, archive_id: params.archive_id ?? `archive_${operation.id}` });
}

async function prepareMoveCopies(env: OperationsBindings, operation: Operation, control: MoveControl, params: MoveParameters): Promise<MoveControl> {
  const input = controlInput(control), repo = (await one<Repository>(env.DB, 'SELECT * FROM repositories WHERE id=?', control.repo_id))!;
  if (!control.snapshot_sha256) {
    if (control.source_cell_id !== control.target_cell_id && !params.archive_id) {
      const proof = await privateJSON<{ verified: boolean; objects_verified: boolean; refs: { ref: string; oid: string }[] }>(env, env.GIT_SERVICE,
        'git-service', `/internal/git/repositories/${repo.id}/verify`, { operation_id: operation.id });
      if (!proof.verified || !proof.objects_verified || !Array.isArray(proof.refs)) throw new Error('move_source_git_unverified');
      await createArchive(env, operation, repo, proof.refs, 'move');
    }
    const digest = params.archive_id ? await copyBackupMetadata(env, input, params.archive_id, operation, repo) : await copyMetadata(env, input);
    await ownerExecute(env, repo.id, operation.id, 'UPDATE shard_moves SET manifest_sha256=?,updated_at=? WHERE operation_id=? AND (manifest_sha256 IS NULL OR manifest_sha256=?)', digest, now(), operation.id, digest);
    const archive = await one<{ manifest_sha256: string }>(env.DB, "SELECT manifest_sha256 FROM repository_archives WHERE id=? AND state='verified'", control.archive_id);
    control = await advanceMoveControl(env, control, 'copying', { snapshot_sha256: digest, archive_manifest_sha256: archive?.manifest_sha256 ?? null });
  }
  await materializeMoveObjects(env, control);
  const inventory = await moveInventory(env, control.operation_id);
  control = await advanceMoveControl(env, control, 'copying', { physical_sha256: inventory.sha256, physical_count: inventory.count });
  const { phase: _phase, ...physical } = input;
  await billingPages('prepare', () => prepareRepositoryStoragePlacement(env, physical));
  let after = '';
  for (;;) {
    const objects = await readMoveObjects(env, operation.id, after);
    if (!objects.length) break;
    await destinationJSON(env, input, 'declare-objects', { objects }); after = objects.at(-1)!.object_id;
  }
  const received = await destinationJSON<{ sha256: string; count: number }>(env, input, 'inventory');
  if (received.sha256 !== inventory.sha256 || received.count !== inventory.count) throw new Error('move_destination_inventory_mismatch');
  await billingPages('copy', () => copyRepositoryStoragePlacement(env, { operation_id: operation.id }));
  await destinationJSON(env, input, 'verify-objects');
  await destinationJSON(env, input, 'apply');
  if (control.source_cell_id !== control.target_cell_id || params.archive_id) {
    await destinationJSON(env, input, 'restore-git', { archive_id: control.archive_id });
  } else {
    const proof = await privateJSON<{ verified: boolean; objects_verified: boolean }>(env, env.GIT_SERVICE, 'git-service', `/internal/git/repositories/${repo.id}/verify`, { operation_id: operation.id });
    if (!proof.verified || !proof.objects_verified) throw new Error('move_git_verification_unconfirmed');
  }
  await destinationJSON(env, input, 'verify', { sha256: control.snapshot_sha256, applied: true });
  return advanceMoveControl(env, control, 'verified');
}

async function switchMoveDirectory(env: OperationsBindings, operation: Operation, control: MoveControl, restored: boolean): Promise<void> {
  if (restored) await revokeRepositoryIdentity(env, operation);
  await registerRepositoryResourceLocators(env, env.DB.withSession('first-primary'), control.repo_id);
  for (const replay of await many<{ id: string }>(env.DB, 'SELECT id FROM event_replays WHERE repo_id=?', control.repo_id)) {
    await registerResourceLocator(env, { resource_id: replay.id, resource_type: 'operation', repo_id: control.repo_id });
  }
  await registerRepositoryPlacement(env, { repo_id: control.repo_id, account_id: control.account_id, cell_id: control.target_cell_id,
    shard_id: control.target_shard_id, epoch: control.target_epoch });
  const directory = env.DIRECTORY_DB ?? identityBinding(env);
  try {
    await execute(directory, `UPDATE resource_routes SET cell_id=?,shard_id=?,epoch=?,state='active',operation_id=NULL,
      destination_cell_id=NULL,destination_shard_id=NULL,updated_at=? WHERE resource_id=? AND cell_id=? AND shard_id=? AND epoch=? AND operation_id=? AND state='fenced'`,
    control.target_cell_id, control.target_shard_id, control.target_epoch, now(), control.repo_id, control.source_cell_id, control.source_shard_id, control.source_epoch, control.operation_id);
  } catch (error) {
    if (!await one(directory, "SELECT 1 FROM resource_routes WHERE resource_id=? AND cell_id=? AND shard_id=? AND epoch=? AND state='active'",
      control.repo_id, control.target_cell_id, control.target_shard_id, control.target_epoch)) throw error;
  }
  if (!await one(directory, "SELECT 1 FROM resource_routes WHERE resource_id=? AND cell_id=? AND shard_id=? AND epoch=? AND state='active'",
    control.repo_id, control.target_cell_id, control.target_shard_id, control.target_epoch)) throw new Error('move_epoch_switch_unconfirmed');
  // The destination repository is still moving and holds its exact local fence.
  await ownerExecute(env, control.repo_id, control.operation_id, "UPDATE shard_moves SET state='finalizing',updated_at=? WHERE operation_id=?", now(), control.operation_id);
}

async function releaseMoveBarrier(env: OperationsBindings, control: MoveControl): Promise<MoveControl> {
  if (control.source_barrier_released_at) return control;
  const token = `move_${control.operation_id}`;
  const released = await privateJSON<{ held: boolean }>(env, env.GIT_SERVICE, 'git-service', `/internal/git/repositories/${control.repo_id}/barrier`, { token, operation_id: control.operation_id }, 'DELETE');
  if (released.held !== false) throw new Error('move_barrier_release_unconfirmed');
  const at = now();
  await ownerExecute(env, control.repo_id, control.operation_id, 'UPDATE operations_maintenance_intents SET barrier_released_at=? WHERE operation_id=? AND barrier_token_hash=?', at, control.operation_id, await sha256(token));
  return advanceMoveControl(env, control, control.state, { source_barrier_released_at: at });
}

async function finishMove(env: OperationsBindings, operation: Operation, control: MoveControl, restored: boolean): Promise<MoveControl> {
  const input = controlInput(control);
  if (!control.activated_at) {
    await destinationJSON(env, input, 'finalize', { sha256: control.snapshot_sha256, repository_state: restored ? 'active' : control.source_state, restore: restored });
    control = await advanceMoveControl(env, control, 'active', { activated_at: now() });
  }
  control = await releaseMoveBarrier(env, control);
  await destinationJSON(env, input, 'confirm', { restore: restored });
  const receipt = await operationFence(env.DB, control.operation_id);
  if (!receipt || receipt.fence_id !== control.source_fence_id) throw new Error('move_source_fence_missing');
  if (!await one(env.DB, "SELECT 1 FROM operations WHERE id=? AND status='completed'", operation.id)) {
    await ownerBatch(env, control.repo_id, control.operation_id, [
      stmt(env.DB, `UPDATE operations SET status='completed',phase='completed',progress=100,result_json=?,error_json=NULL,revision=revision+1,updated_at=?,completed_at=? WHERE id=?`,
        canonicalJson(moveResult(control, restored)), now(), now(), operation.id),
      stmt(env.DB, "UPDATE shard_moves SET state='completed',source_retained_until=?,updated_at=? WHERE operation_id=?", control.source_retained_until, now(), operation.id),
    ]);
  }
  await releaseMetadataFence(env, receipt);
  return advanceMoveControl(env, control, 'completed');
}

export async function recoverShardMove(env: OperationsBindings, id: string): Promise<Record<string, unknown>> {
  const control = await moveControl(env, id);
  if (control.source_cell_id !== env.CELL_ID) return privateJSON(env, backgroundCell(env, control.source_cell_id), 'operations.maintenance', '/internal/operations/move-recover', { operation_id: id });
  const source = shardEnvironment(env, control.source_shard_id);
  const operation = await one<Operation>(source.DB, 'SELECT * FROM operations WHERE id=? AND kind=\'repository.move\' AND repo_id=?', id, control.repo_id);
  if (!operation) throw new Error('move_source_operation_missing');
  return runShardMove(source, operation);
}

export async function abortShardMove(env: OperationsBindings, id: string): Promise<Record<string, unknown>> {
  let control = await moveControl(env, id);
  if (!sameMovePlacement(control, env, 'source')) {
    if (control.source_cell_id !== env.CELL_ID) return privateJSON(env, backgroundCell(env, control.source_cell_id), 'operations.maintenance', '/internal/operations/move-abort', { operation_id: id });
    return abortShardMove(shardEnvironment(env, control.source_shard_id), id);
  }
  if (control.state === 'aborted') return { ...moveResult(control), aborted: true };
  if (control.effective_at || !['preparing', 'copying', 'verified', 'aborting'].includes(control.state)) throw new ApiError(409, 'move_cutover_committed', 'This move has committed its cutover and must finish at the destination.');
  if (control.state !== 'aborting') control = await advanceMoveControl(env, control, 'aborting', { abort_epoch: control.target_epoch + 1, abort_requested_at: now() });
  if (await one(identityBinding(env), 'SELECT 1 FROM billing_storage_placements WHERE operation_id=?', id)) await billingPages('abort', () => abortRepositoryStoragePlacement(env, { operation_id: id }));
  control = await releaseMoveBarrier(env, control);
  await destinationJSON(env, controlInput(control), 'discard');
  const receipt = await operationFence(env.DB, id);
  if (!receipt || receipt.fence_id !== control.source_fence_id) throw new Error('move_source_fence_missing');
  const sourceRepository = await one<{ revision: number }>(env.DB, 'SELECT revision FROM repositories WHERE id=?', control.repo_id);
  if (!sourceRepository) throw new Error('move_source_repository_missing');
  if (!await one(env.DB, "SELECT 1 FROM operations WHERE id=? AND status='cancelled'", id)) await ownerBatch(env, control.repo_id, id, [
    stmt(env.DB, `UPDATE repositories SET state=?,routing_epoch=?,revision=revision+1,updated_at=? WHERE id=? AND routing_epoch=? AND state='moving'`, control.source_state, control.abort_epoch, now(), control.repo_id, control.source_epoch),
    stmt(env.DB, `UPDATE operations SET status='cancelled',phase='aborted',error_json=NULL,result_json=?,revision=revision+1,updated_at=?,completed_at=? WHERE id=?`,
      canonicalJson({ repository_id: control.repo_id, aborted: true, routing_epoch: control.abort_epoch }), now(), now(), id),
    stmt(env.DB, "UPDATE shard_moves SET state='failed',updated_at=? WHERE operation_id=?", now(), id),
    eventStatement(env.DB, { id: `evt_move_aborted_${id}`, type: 'repository.move_aborted', resource_id: control.repo_id, repo_id: control.repo_id,
      resource_revision: sourceRepository.revision + 1, account_id: control.account_id, data: { operation_id: id, routing_epoch: control.abort_epoch } }),
  ]);
  await registerRepositoryPlacement(env, { repo_id: control.repo_id, account_id: control.account_id, cell_id: control.source_cell_id,
    shard_id: control.source_shard_id, epoch: control.abort_epoch! });
  const directory = env.DIRECTORY_DB ?? identityBinding(env);
  await execute(directory, `UPDATE resource_routes SET epoch=?,state=?,operation_id=NULL,destination_cell_id=NULL,destination_shard_id=NULL,updated_at=?
    WHERE resource_id=? AND cell_id=? AND shard_id=? AND epoch=? AND operation_id=? AND state='fenced'`, control.abort_epoch,
  control.source_state === 'deleted' ? 'deleted' : 'active', now(), control.repo_id, control.source_cell_id, control.source_shard_id, control.source_epoch, id);
  if (!await one(directory, 'SELECT 1 FROM resource_routes WHERE resource_id=? AND cell_id=? AND shard_id=? AND epoch=? AND operation_id IS NULL',
    control.repo_id, control.source_cell_id, control.source_shard_id, control.abort_epoch)) throw new Error('move_abort_route_unconfirmed');
  await releaseMetadataFence(env, receipt);
  control = await advanceMoveControl(env, control, 'aborted', { aborted_at: now() });
  return { ...moveResult(control), aborted: true };
}
