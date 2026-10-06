import { z } from 'zod';
import { Context } from 'hono';
import { database } from '@gitknot/core/db';
import { identityDatabase, readRepositoryAuthority, recoverAccountAuthorityBarriers } from '@gitknot/core/authority';
import { ApiError, auditStatement, authorize, eventStatement, expectedRevision, explainAuthorization, getRepository, jsonBody, limits, listResponse, many, newId, now, one, page,
  registerResourceLocator, requirePrincipal, route, stmt, type AccountRecord, type App, type AppContext, type AppEnv, type Bindings, type Repository } from '@gitknot/core';
import { afterSeconds, checkedWrite, identityBatch, requireHuman, sweepIdentity } from '@gitknot/core/auth';
import { authorizeArchive, portableArchiveStream, readArchive } from '../../../../../packages/operations/src/archive.ts';
import { requestDatabaseAuthority, requestDatabaseBinding, setRequestDatabase } from '@gitknot/core/routing/cells';
import type { OperationsBindings } from '../../../../../packages/operations/src/types.ts';
import { commitIdentity, databaseBindings, emptySchema, idSchema, revisionResponse } from '../identity/shared.ts';
import { enforceVisibility, repositoryNameSchema } from './catalog.ts';
import { operationResponse, prepareRepositoryOperation, publicRepository, recoverCatalogBarriers, withRepositoryBarrier, type CatalogOperation } from './shared.ts';

const archiveSchema = z.object({ archived: z.boolean().default(true) }).strict();
const restoreSchema = z.object({ archive_id: z.string().min(1).max(128).optional() }).strict();
const transferSchema = z.object({ destination_owner_id: idSchema, destination_name: repositoryNameSchema.optional(),
  expires_in_seconds: z.number().int().min(300).max(604800).default(604800) }).strict();
interface Transfer { id: string; repo_id: string; source_owner_id: string; destination_owner_id: string; destination_name: string; previous_state: 'active' | 'archived';
  state: 'awaiting_acceptance' | 'accepted' | 'moving' | 'completed' | 'cancelled' | 'expired' | 'failed'; operation_id: string; expires_at: string;
  accepted_by: string | null; accepted_at: string | null; revision: number; created_by: string; created_at: string; updated_at: string }
interface ExportRow { id: string; repo_id: string; account_id: string; operation_id: string; schema_version: number; state: string; checksum_sha256: string | null;
  size_bytes: number | null; expires_at: string; revision: number; created_by: string; created_at: string; completed_at: string | null;
  archive_id: string | null; archive_bytes: number | null; operation_status: string }

function publicTransfer(row: Transfer): Transfer {
  return { id: row.id, repo_id: row.repo_id, source_owner_id: row.source_owner_id, destination_owner_id: row.destination_owner_id,
    destination_name: row.destination_name, previous_state: row.previous_state, state: row.state, operation_id: row.operation_id,
    expires_at: row.expires_at, accepted_by: row.accepted_by, accepted_at: row.accepted_at, revision: row.revision,
    created_by: row.created_by, created_at: row.created_at, updated_at: row.updated_at };
}

function publicExport(row: ExportRow): Record<string, unknown> & { revision: number } {
  const state = row.expires_at <= now() ? 'expired' : row.operation_status === 'failed' && row.state !== 'completed' ? 'failed' : row.state;
  return { id: row.id, repo_id: row.repo_id, account_id: row.account_id, operation_id: row.operation_id, schema_version: row.schema_version,
    state, checksum_sha256: row.checksum_sha256, size_bytes: row.archive_bytes ?? row.size_bytes, expires_at: row.expires_at,
    download_url: state === 'completed' ? `/v1/repos/${row.repo_id}/exports/${row.id}/download` : null,
    revision: row.revision, created_by: row.created_by, created_at: row.created_at, completed_at: row.completed_at };
}

function currentArchiveReader(c: AppContext, archiveId: string): () => Promise<void> {
  const binding = requestDatabaseBinding(c);
  const authority = requestDatabaseAuthority(c);
  return async () => {
    // A stream may outlive the original D1 session snapshot. Each part starts a
    // new primary-backed identity and metadata read before releasing any bytes.
    const fresh = new Context<AppEnv>(new Request(c.req.url), { env: c.env });
    fresh.set('principal', c.get('principal'));
    fresh.set('requestId', c.get('requestId'));
    setRequestDatabase(fresh, binding, authority);
    await authorizeArchive(fresh, archiveId);
  };
}

function authorizedArchiveStream(stream: ReadableStream<Uint8Array>, authorizePart: () => Promise<void>): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { reader.releaseLock(); controller.close(); return; }
        // R2 can wait after the archive reader's prefetch authorization. Check
        // again after that wait, immediately before releasing this chunk.
        await authorizePart();
        controller.enqueue(value);
      } catch (error) {
        try { await reader.cancel(error); } catch { /* The upstream may already have failed. */ }
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
  }, { highWaterMark: 0 });
}

async function exportVisible(c: AppContext, row: ExportRow): Promise<boolean> {
  if (!row.archive_id) return row.created_by === c.get('principal')?.id;
  try { await currentArchiveReader(c, row.archive_id)(); return true; }
  catch (error) {
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) return false;
    throw error;
  }
}

async function exportRecord(c: AppContext, repositoryId: string, exportId: string | undefined): Promise<ExportRow> {
  if (!exportId) throw new ApiError(404, 'not_found', 'The requested export was not found.');
  const row = await one<ExportRow>(database(c), `SELECT e.*,a.id AS archive_id,a.bytes AS archive_bytes,o.status AS operation_status
    FROM repository_exports e JOIN operations o ON o.id=e.operation_id LEFT JOIN repository_archives a ON a.operation_id=e.operation_id AND a.state='verified'
    WHERE e.id=? AND e.repo_id=?`, exportId, repositoryId);
  if (!row) throw new ApiError(404, 'not_found', 'The requested export was not found.');
  return row;
}

async function archiveRepository(c: AppContext, archived: boolean): Promise<Response> {
  const kind = archived ? 'archive' : 'unarchive';
  const repo = await getRepository(c, c.req.param('id'), `repositories.${kind}`);
  const authorization = await authorize(c, `repositories.${kind}`, { repo_id: repo.id });
  const revision = expectedRevision(c);
  if (archived ? repo.state !== 'active' : repo.state !== 'archived') throw new ApiError(409, 'invalid_repository_state', archived ? 'Only active repositories can be archived.' : 'Only archived repositories can be unarchived.');
  const updated: Repository = { ...repo, state: 'archived', revision: revision + 1, policy_revision: repo.policy_revision + 1, updated_at: now() };
  const prepared = prepareRepositoryOperation(c, updated, kind, { previous_state: repo.state, desired_state: archived ? 'archived' : 'active' });
  await withRepositoryBarrier(c, repo.id, prepared.operation.kind, async () => commitIdentity(c, [
    ...checkedWrite(database(c), stmt(database(c), "UPDATE repositories SET state='archived',revision=revision+1,policy_revision=policy_revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND state=?",
      now(), repo.id, repo.owner_id, revision, repo.state)), ...prepared.statements,
  ], { type: 'operation.requested', resource_id: prepared.operation.id, resource_revision: 1, repo_id: repo.id, account_id: repo.owner_id,
    data: { kind: prepared.operation.kind } }, { authorizations: [authorization], events: [{ type: `repository.${kind}_requested`, resource_id: repo.id,
      resource_revision: revision + 1, repo_id: repo.id, account_id: repo.owner_id, data: { operation_id: prepared.operation.id, state: 'archived' } }] }));
  operationResponse(c, prepared.operation);
  return revisionResponse(c, { ...await publicRepository(c, updated), operation: prepared.operation, revision: revision + 1 }, 202);
}

async function transferRecord(c: AppContext): Promise<Transfer> {
  const row = await one<Transfer>(database(c), 'SELECT * FROM repository_transfers WHERE id=? AND repo_id=?', c.req.param('transferId'), c.req.param('id'));
  if (!row) throw new ApiError(404, 'not_found', 'The requested transfer was not found.');
  const source = await explainAuthorization(c, 'repositories.transfer', { repo_id: row.repo_id });
  const destination = await explainAuthorization(c, 'repositories.transfer', { account_id: row.destination_owner_id });
  if (!source.allowed && !destination.allowed) throw new ApiError(404, 'not_found', 'The requested transfer was not found.');
  return row;
}

export function registerRepositoryLifecycleRoutes(app: App): void {
  route(app, 'POST', '/v1/repos/:id/archive', { summary: 'Archive or unarchive a repository through durable coordination', tags: ['repositories'], body: archiveSchema }, async c =>
    archiveRepository(c, (await jsonBody(c, archiveSchema)).archived));
  route(app, 'DELETE', '/v1/repos/:id/archive', { summary: 'Unarchive a repository', tags: ['repositories'], capability: 'repositories.unarchive' }, async c => archiveRepository(c, false));

  route(app, 'DELETE', '/v1/repos/:id', { summary: 'Immediately remove repository access and begin recoverable deletion', tags: ['repositories'], capability: 'repositories.delete' }, async c => {
    const repo = await getRepository(c, c.req.param('id'), 'repositories.delete');
    const authorization = await authorize(c, 'repositories.delete', { repo_id: repo.id });
    const revision = expectedRevision(c);
    if (!['active', 'archived', 'provisioning'].includes(repo.state)) throw new ApiError(409, 'repository_busy', 'Resolve the current repository operation before deleting it.');
    const timestamp = now();
    const recoveryUntil = afterSeconds(limits(c.env).deleted_repository_retention_days * 86400);
    const updated: Repository = { ...repo, state: 'deleted', revision: revision + 1, policy_revision: repo.policy_revision + 1,
      updated_at: timestamp, deleted_at: timestamp, recovery_until: recoveryUntil };
    const prepared = prepareRepositoryOperation(c, updated, 'delete', { previous_state: repo.state, desired_state: 'deleted',
      input: { recovery_until: recoveryUntil } });
    await withRepositoryBarrier(c, repo.id, 'repository.delete', async () => commitIdentity(c, [
      ...checkedWrite(database(c), stmt(database(c), `UPDATE repositories SET state='deleted',deleted_at=?,recovery_until=?,revision=revision+1,policy_revision=policy_revision+1,updated_at=?
        WHERE id=? AND owner_id=? AND revision=? AND state=?`, timestamp, recoveryUntil, timestamp, repo.id, repo.owner_id, revision, repo.state)),
      // The authoritative deleted state and acknowledged account fence revoke
      // access immediately. The lifecycle worker cleans primary identity grants
      // and credentials after its storage-retention step is durably confirmed.
      stmt(database(c), "UPDATE repository_retention_pins SET expires_at=? WHERE repo_id=? AND kind='fork'", recoveryUntil, repo.id),
      ...prepared.statements,
    ], { type: 'operation.requested', resource_id: prepared.operation.id, resource_revision: 1, repo_id: repo.id, account_id: repo.owner_id,
      data: { kind: prepared.operation.kind } }, { authorizations: [authorization], events: [{ type: 'repository.deleted', resource_id: repo.id,
        resource_revision: revision + 1, repo_id: repo.id, account_id: repo.owner_id, data: { recovery_until: recoveryUntil, operation_id: prepared.operation.id } }] }));
    operationResponse(c, prepared.operation);
    return revisionResponse(c, { id: repo.id, state: 'deleted', recovery_until: recoveryUntil, operation: prepared.operation, revision: revision + 1 }, 202);
  });

  route(app, 'POST', '/v1/repos/:id/restore', { summary: 'Restore a retained deleted repository after native verification', tags: ['repositories'], body: restoreSchema, capability: 'repositories.restore' }, async c => {
    const repo = await getRepository(c, c.req.param('id'), 'repositories.restore');
    const authorization = await authorize(c, 'repositories.restore', { repo_id: repo.id });
    const body = await jsonBody(c, restoreSchema);
    const revision = expectedRevision(c);
    if (repo.state !== 'deleted' || !repo.recovery_until || repo.recovery_until <= now()) throw new ApiError(409, 'recovery_window_closed', 'This repository is outside its recovery window.');
    if (body.archive_id && !await one(database(c), "SELECT id FROM repository_archives WHERE id=? AND repo_id=? AND state='verified' AND expires_at>?", body.archive_id, repo.id, now())) {
      throw new ApiError(404, 'not_found', 'The requested recovery archive was not found.');
    }
    const prepared = prepareRepositoryOperation(c, { ...repo, revision: revision + 1 }, 'restore', { previous_state: 'deleted', desired_state: 'active', input: { ...body } });
    await commitIdentity(c, [...checkedWrite(database(c), stmt(database(c), "UPDATE repositories SET revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND state='deleted' AND recovery_until>?",
      now(), repo.id, repo.owner_id, revision, now())),
    stmt(database(c), "UPDATE repository_retention_pins SET expires_at=NULL WHERE repo_id=? AND kind='fork'", repo.id), ...prepared.statements], { type: 'operation.requested', resource_id: prepared.operation.id,
      resource_revision: 1, repo_id: repo.id, account_id: repo.owner_id, data: { kind: prepared.operation.kind } }, { authorizations: [authorization] });
    operationResponse(c, prepared.operation);
    return revisionResponse(c, { id: repo.id, state: repo.state, operation: prepared.operation, revision: revision + 1 }, 202);
  });

  route(app, 'POST', '/v1/repos/:id/exports', { summary: 'Create a complete versioned repository export', tags: ['repositories'], body: emptySchema, capability: 'repositories.export' }, async c => {
    const repo = await getRepository(c, c.req.param('id'), 'repositories.export');
    const authorization = await authorize(c, 'repositories.export', { repo_id: repo.id });
    if (!['active', 'archived'].includes(repo.state)) throw new ApiError(409, 'repository_busy', 'Wait for the current lifecycle operation before exporting.');
    const id = newId('export');
    const prepared = prepareRepositoryOperation(c, repo, 'export', { input: { export_id: id, format_version: 1 } });
    const timestamp = now();
    const expiresAt = afterSeconds(7 * 86400);
    await commitIdentity(c, [...prepared.statements, stmt(database(c), 'INSERT INTO repository_exports(id,repo_id,account_id,operation_id,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
      id, repo.id, repo.owner_id, prepared.operation.id, expiresAt, requirePrincipal(c).id, timestamp)],
    { type: 'operation.requested', resource_id: prepared.operation.id, resource_revision: 1, repo_id: repo.id, account_id: repo.owner_id,
      data: { kind: prepared.operation.kind, export_id: id } }, { authorizations: [authorization] });
    operationResponse(c, prepared.operation);
    return revisionResponse(c, { id, repo_id: repo.id, account_id: repo.owner_id, schema_version: 1, state: 'queued', expires_at: expiresAt,
      operation: prepared.operation, revision: 1, created_at: timestamp }, 202);
  });

  route(app, 'GET', '/v1/repos/:id/exports', { summary: 'List repository exports', tags: ['repositories'], capability: 'repositories.export' }, async c => {
    const repo = await getRepository(c, c.req.param('id'), 'repositories.export');
    const { limit, cursor } = page(c);
    const rows = await many<ExportRow>(database(c), `SELECT e.*,a.id AS archive_id,a.bytes AS archive_bytes,o.status AS operation_status
      FROM repository_exports e JOIN operations o ON o.id=e.operation_id LEFT JOIN repository_archives a ON a.operation_id=e.operation_id AND a.state='verified'
      WHERE e.repo_id=? AND e.id>? ORDER BY e.id LIMIT ?`, repo.id, cursor ?? '', limit + 1);
    const visible = await Promise.all(rows.slice(0, limit).map(async row => await exportVisible(c, row) ? publicExport(row) : null));
    return listResponse(c, visible.filter(row => row !== null), rows.length > limit ? rows[limit - 1]!.id : null);
  });
  route(app, 'GET', '/v1/repos/:id/exports/:exportId', { summary: 'Read export progress and checksum', tags: ['repositories'], capability: 'repositories.export' }, async c => {
    const repo = await getRepository(c, c.req.param('id'), 'repositories.export');
    const row = await exportRecord(c, repo.id, c.req.param('exportId'));
    if (!await exportVisible(c, row)) throw new ApiError(404, 'not_found', 'The requested export was not found.');
    return revisionResponse(c, publicExport(row));
  });
  route(app, 'GET', '/v1/repos/:id/exports/:exportId/download', { summary: 'Download an authorized complete GitKnot archive', tags: ['repositories'], streaming: true, capability: 'repositories.export' }, async c => {
    const repo = await getRepository(c, c.req.param('id'), 'repositories.export');
    const exported = await exportRecord(c, repo.id, c.req.param('exportId'));
    if (exported.expires_at <= now()) throw new ApiError(410, 'export_expired', 'This export expired. Create a new export.');
    if (exported.state !== 'completed' || !exported.archive_id) throw new ApiError(409, 'export_not_ready', 'The export is not yet verified and ready for download.');
    const authorizePart = currentArchiveReader(c, exported.archive_id);
    await authorizePart();
    const env = databaseBindings(c) as OperationsBindings;
    const manifest = await readArchive(env, exported.archive_id, repo.id);
    await authorizePart();
    return new Response(authorizedArchiveStream(portableArchiveStream(env, manifest, authorizePart), authorizePart), { headers: {
      'content-type': 'application/x-tar', 'content-disposition': `attachment; filename="${repo.id}.gitknot.tar"`,
      'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', etag: `"${exported.checksum_sha256}"`,
    } });
  });

  route(app, 'POST', '/v1/repos/:id/transfers', { summary: 'Request a repository transfer for receiving-owner acceptance', tags: ['repositories'], body: transferSchema, capability: 'repositories.transfer' }, async c => {
    const repo = await getRepository(c, c.req.param('id'), 'repositories.transfer');
    const authorization = await authorize(c, 'repositories.transfer', { repo_id: repo.id });
    const body = await jsonBody(c, transferSchema);
    const revision = expectedRevision(c);
    if (!['active', 'archived'].includes(repo.state)) throw new ApiError(409, 'repository_busy', 'Wait for the current repository operation before transferring.');
    if (body.destination_owner_id === repo.owner_id) throw new ApiError(422, 'same_repository_owner', 'Choose a different receiving owner.');
    const destination = await one<AccountRecord>(identityDatabase(c), 'SELECT * FROM accounts WHERE id=? AND disabled_at IS NULL', body.destination_owner_id);
    if (!destination) throw new ApiError(404, 'not_found', 'The receiving account was not found.');
    const source = repo.fork_source_id ? await readRepositoryAuthority(c, repo.fork_source_id) : null;
    await enforceVisibility(c, destination, repo.visibility === 'internal' && destination.type === 'user' ? 'private' : repo.visibility, source);
    const id = newId('transfer');
    const timestamp = now();
    const expiresAt = afterSeconds(body.expires_in_seconds);
    const updated = { ...repo, state: 'transfer_pending' as const, revision: revision + 1, policy_revision: repo.policy_revision + 1, updated_at: timestamp };
    const prepared = prepareRepositoryOperation(c, updated, 'transfer', { previous_state: repo.state, desired_state: repo.state,
      status: 'waiting', phase: 'awaiting_acceptance', input: { transfer_id: id, destination_owner_id: destination.id, destination_name: body.destination_name ?? repo.name } });
    await registerResourceLocator(c.env, { resource_id: prepared.operation.id, resource_type: 'operation', repo_id: repo.id });
    await withRepositoryBarrier(c, repo.id, 'repository.transfer_request', async () => commitIdentity(c, [
      ...checkedWrite(database(c), stmt(database(c), "UPDATE repositories SET state='transfer_pending',revision=revision+1,policy_revision=policy_revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND state=?", timestamp, repo.id, repo.owner_id, revision, repo.state)),
      ...prepared.statements,
      stmt(database(c), `INSERT INTO repository_transfers(id,repo_id,source_owner_id,destination_owner_id,destination_name,previous_state,state,operation_id,expires_at,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'awaiting_acceptance',?,?,?,?,?)`, id, repo.id, repo.owner_id, destination.id, body.destination_name ?? repo.name, repo.state, prepared.operation.id, expiresAt, requirePrincipal(c).id, timestamp, timestamp),
      // A waiting transfer must not allocate a Workflow or acquire its native
      // lifecycle fence before the receiving owner accepts it.
      stmt(database(c), 'INSERT INTO operation_dispatches(operation_id,workflow_id,next_attempt_at) VALUES (?,?,?)', prepared.operation.id, prepared.operation.id, '9999-12-31T23:59:59.999Z'),
    ], { type: 'repository.transfer_requested', resource_id: repo.id, resource_revision: revision + 1, repo_id: repo.id, account_id: repo.owner_id,
      data: { transfer_id: id, operation_id: prepared.operation.id, destination_owner_id: destination.id } }, { authorizations: [authorization] }));
    operationResponse(c, prepared.operation);
    return revisionResponse(c, { id, repo_id: repo.id, source_owner_id: repo.owner_id, destination_owner_id: destination.id,
      destination_name: body.destination_name ?? repo.name, state: 'awaiting_acceptance', expires_at: expiresAt,
      repository_revision: revision + 1, operation: prepared.operation, revision: 1 }, 202);
  });

  route(app, 'GET', '/v1/repos/:id/transfers', { summary: 'List repository transfer history', tags: ['repositories'], capability: 'repositories.transfer' }, async c => {
    const repo = await getRepository(c, c.req.param('id'), 'repositories.transfer');
    const { limit, cursor } = page(c);
    const rows = await many<Transfer>(database(c), 'SELECT id,repo_id,source_owner_id,destination_owner_id,destination_name,previous_state,state,operation_id,expires_at,accepted_by,accepted_at,revision,created_by,created_at,updated_at FROM repository_transfers WHERE repo_id=? AND id>? ORDER BY id LIMIT ?', repo.id, cursor ?? '', limit + 1);
    return listResponse(c, rows.slice(0, limit), rows.length > limit ? rows[limit - 1]!.id : null);
  });
  route(app, 'GET', '/v1/repos/:id/transfers/:transferId', { summary: 'Review a transfer as sender or receiving owner', tags: ['repositories'] }, async c => {
    const transfer = await transferRecord(c);
    const operation = await one<CatalogOperation>(database(c), 'SELECT id,kind,resource_id,repo_id,account_id,actor_id,status,phase,progress,revision,created_at,updated_at,completed_at FROM operations WHERE id=?', transfer.operation_id);
    return revisionResponse(c, { ...publicTransfer(transfer), operation });
  });

  route(app, 'POST', '/v1/repos/:id/transfers/:transferId/accept', { summary: 'Accept repository ownership and start fenced transfer', tags: ['repositories'], body: emptySchema }, async c => {
    const user = await requireHuman(c, { recent: true });
    const transfer = await transferRecord(c);
    const revision = expectedRevision(c);
    const destinationAuthority = await authorize(c, 'repositories.transfer', { account_id: transfer.destination_owner_id });
    const creationAuthority = await authorize(c, 'repositories.create', { account_id: transfer.destination_owner_id });
    if (transfer.state !== 'awaiting_acceptance' || transfer.expires_at <= now()) throw new ApiError(409, 'transfer_inactive', 'This transfer expired or has already been accepted.');
    const repo = await one<Repository>(database(c), "SELECT * FROM repositories WHERE id=? AND owner_id=? AND state='transfer_pending'", transfer.repo_id, transfer.source_owner_id);
    const destination = await one<AccountRecord>(identityDatabase(c), 'SELECT * FROM accounts WHERE id=? AND disabled_at IS NULL', transfer.destination_owner_id);
    if (!repo || !destination) throw new ApiError(409, 'transfer_unavailable', 'The repository or receiving owner changed.');
    if (repo.fork_source_id && !(await explainAuthorization(c, 'contents.read', { repo_id: repo.fork_source_id })).allowed) throw new ApiError(403, 'fork_source_access_required', 'The receiving owner must retain access to the fork source.');
    const source = repo.fork_source_id ? await readRepositoryAuthority(c, repo.fork_source_id) : null;
    await enforceVisibility(c, destination, repo.visibility === 'internal' && destination.type === 'user' ? 'private' : repo.visibility, source);
    if (await one(database(c), 'SELECT id FROM repositories WHERE owner_id=? AND slug=? COLLATE NOCASE', destination.id, transfer.destination_name.toLowerCase())) throw new ApiError(409, 'name_unavailable', 'The receiving owner already has a repository with this name.');
    const timestamp = now();
    await withRepositoryBarrier(c, repo.id, 'repository.transfer_accept', async () => commitIdentity(c, [
      ...checkedWrite(database(c), stmt(database(c), `UPDATE repository_transfers SET state='accepted',accepted_by=?,accepted_at=?,accepted_principal_json=?,destination_policy_revision=?,revision=revision+1,updated_at=?
        WHERE id=? AND repo_id=? AND revision=? AND state='awaiting_acceptance' AND expires_at>?`, user.id, timestamp, JSON.stringify(requirePrincipal(c)), destination.policy_revision, timestamp, transfer.id, repo.id, revision, timestamp)),
      ...checkedWrite(database(c), stmt(database(c), "UPDATE repositories SET state='moving',revision=revision+1,policy_revision=policy_revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND state='transfer_pending'",
        timestamp, repo.id, repo.owner_id, repo.revision)),
      stmt(database(c), 'INSERT INTO repository_name_reservations(account_id,slug,repo_id,transfer_id,created_at) VALUES (?,?,?,?,?)', destination.id, transfer.destination_name.toLowerCase(), repo.id, transfer.id, timestamp),
      stmt(database(c), "UPDATE operations SET status='pending',phase='queued',revision=revision+1,updated_at=? WHERE id=? AND status='waiting'", timestamp, transfer.operation_id),
      stmt(database(c), "UPDATE repository_lifecycle SET state='queued',expected_repository_revision=?,updated_at=? WHERE operation_id=? AND state='waiting'", repo.revision + 1, timestamp, transfer.operation_id),
      stmt(database(c), 'UPDATE operation_dispatches SET next_attempt_at=?,attempts=0 WHERE operation_id=?', timestamp, transfer.operation_id),
    ], { type: 'operation.requested', resource_id: transfer.operation_id, resource_revision: 2, repo_id: repo.id, account_id: repo.owner_id,
      data: { kind: 'repository.transfer', accepted_by: user.id } }, { authorizations: [destinationAuthority, creationAuthority] }), [transfer.destination_owner_id]);
    c.header('location', `/v1/repos/${repo.id}/transfers/${transfer.id}`);
    return revisionResponse(c, { ...publicTransfer(transfer), state: 'accepted', accepted_by: user.id, accepted_at: timestamp, revision: revision + 1 }, 202);
  });

  route(app, 'DELETE', '/v1/repos/:id/transfers/:transferId', { summary: 'Cancel or decline an unaccepted repository transfer', tags: ['repositories'] }, async c => {
    const transfer = await transferRecord(c);
    const revision = expectedRevision(c);
    if (transfer.state !== 'awaiting_acceptance') throw new ApiError(409, 'transfer_already_started', 'An accepted transfer must finish or be recovered before another ownership change.');
    const timestamp = now();
    await withRepositoryBarrier(c, transfer.repo_id, 'repository.transfer_cancel', async () => commitIdentity(c, [
      ...checkedWrite(database(c), stmt(database(c), "UPDATE repository_transfers SET state='cancelled',revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND revision=? AND state='awaiting_acceptance'", timestamp, transfer.id, transfer.repo_id, revision)),
      ...checkedWrite(database(c), stmt(database(c), "UPDATE repositories SET state=?,revision=revision+1,policy_revision=policy_revision+1,updated_at=? WHERE id=? AND owner_id=? AND state='transfer_pending'", transfer.previous_state, timestamp, transfer.repo_id, transfer.source_owner_id)),
      stmt(database(c), "UPDATE operations SET status='cancelled',phase='cancelled',revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND status='waiting'", timestamp, timestamp, transfer.operation_id),
      stmt(database(c), "UPDATE repository_lifecycle SET state='completed',updated_at=? WHERE operation_id=? AND state='waiting'", timestamp, transfer.operation_id),
    ], { type: 'repository.transfer_cancelled', resource_id: transfer.repo_id, resource_revision: revision + 1, repo_id: transfer.repo_id, account_id: transfer.source_owner_id,
      data: { transfer_id: transfer.id } }));
    return c.body(null, 204);
  });
}

/** Run from the background scheduled handler alongside lifecycle recovery. */
export async function sweepRepositoryCatalog(env: Bindings): Promise<void> {
  await sweepIdentity(env);
  await recoverCatalogBarriers(env);
  await recoverAccountAuthorityBarriers(env);
  const transfers = await many<Transfer>(env.DB, "SELECT * FROM repository_transfers WHERE state='awaiting_acceptance' AND expires_at<=? ORDER BY id LIMIT 50", now());
  for (const transfer of transfers) {
    const timestamp = now();
    const repository = await one<{ revision: number }>(env.DB, 'SELECT revision FROM repositories WHERE id=? AND owner_id=?', transfer.repo_id, transfer.source_owner_id);
    if (!repository) continue;
    try { await identityBatch(env.DB, [
      ...checkedWrite(env.DB, stmt(env.DB, "UPDATE repository_transfers SET state='expired',revision=revision+1,updated_at=? WHERE id=? AND state='awaiting_acceptance' AND expires_at<=?", timestamp, transfer.id, timestamp)),
      ...checkedWrite(env.DB, stmt(env.DB, "UPDATE repositories SET state=?,revision=revision+1,policy_revision=policy_revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND state='transfer_pending'", transfer.previous_state, timestamp, transfer.repo_id, transfer.source_owner_id, repository.revision)),
      stmt(env.DB, "UPDATE operations SET status='cancelled',phase='expired',revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND status='waiting'", timestamp, timestamp, transfer.operation_id),
      stmt(env.DB, "UPDATE repository_lifecycle SET state='completed',updated_at=? WHERE operation_id=? AND state='waiting'", timestamp, transfer.operation_id),
      eventStatement(env.DB, { type: 'repository.transfer_expired', resource_id: transfer.repo_id, resource_revision: repository.revision + 1,
        repo_id: transfer.repo_id, account_id: transfer.source_owner_id, data: { transfer_id: transfer.id, operation_id: transfer.operation_id } }),
      auditStatement(env.DB, { action: 'repository.transfer_expired', resource_id: transfer.repo_id, resource_revision: repository.revision + 1,
        repo_id: transfer.repo_id, account_id: transfer.source_owner_id, details: { transfer_id: transfer.id } }),
    ]); } catch (error) {
      if (!(error instanceof ApiError && error.status === 412)) throw error;
    }
  }
  await stmt(env.DB, "DELETE FROM repository_name_reservations WHERE transfer_id IN (SELECT id FROM repository_transfers WHERE state IN ('completed','cancelled','expired'))").run();
}
