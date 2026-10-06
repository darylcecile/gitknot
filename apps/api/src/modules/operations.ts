import { z } from 'zod';
import {
  ApiError, authorize, database, etag, expectedRevision, getRepository, listResponse, many,
  identityBinding, mutate, newId, now, one, page, requirePrincipal, route, stmt,
} from '@gitknot/core';
import type { App, AppContext } from '@gitknot/core';
import { archiveAuthorizer, authorizeArchive, portableArchiveStream, readArchive } from '../../../../packages/operations/src/archive.ts';
import { authorizeCodeScanObject } from '../../../../packages/operations/src/search.ts';
import type { Operation } from '../../../../packages/operations/src/types.ts';
import { requestOperationsEnvironment } from '../../../../packages/operations/src/placement.ts';
import { readCodeScanResult } from '../../../../packages/operations/src/scan-results.ts';
import { registerAccountExportRoutes } from './account-exports.ts';

function publicOperation(row: Operation): Record<string, unknown> {
  const result = row.result_json ? JSON.parse(row.result_json) as Record<string, unknown> : null;
  const fields = result ? Object.fromEntries(Object.entries(result).filter(([name]) => ['repository_id', 'archive_id', 'account_export_id', 'sha256', 'restored', 'deleted', 'state', 'scan_id', 'complete', 'matched_count', 'scanned_files', 'excluded_files', 'destination_owner_id', 'verified'].includes(name))) : null;
  const error = row.error_json ? JSON.parse(row.error_json) as { code?: string; retryable?: boolean } : null;
  return { id: row.id, kind: row.kind, resource_id: row.resource_id, repo_id: row.repo_id, account_id: row.account_id,
    status: row.status, phase: row.phase, progress: row.progress, revision: row.revision, result: fields,
    error: error ? { code: error.code ?? 'operation_failed', message: 'The operation could not confirm its current step.', retryable: !!error.retryable } : null,
    created_at: row.created_at, updated_at: row.updated_at, completed_at: row.completed_at };
}

async function readOperation(c: AppContext): Promise<Operation> {
  const row = await one<Operation>(database(c), 'SELECT * FROM operations WHERE id=?', c.req.param('id'));
  if (!row) throw new ApiError(404, 'not_found', 'The operation was not found.');
  if (row.kind === 'collaboration.code_scan' && c.get('principal')?.id !== row.actor_id) throw new ApiError(404, 'not_found', 'The operation was not found.');
  if (row.kind === 'collaboration.code_scan') {
    const repositories = await many<{ repo_id: string }>(identityBinding(c.env), `SELECT r.repo_id FROM collaboration_code_scan_repositories r
      JOIN collaboration_code_scans s ON s.id=r.scan_id WHERE s.operation_id=? AND s.principal_id=?`, row.id, row.actor_id);
    for (const repository of repositories) await getRepository(c, repository.repo_id, 'contents.read');
    return row;
  }
  if (row.repo_id) {
    const repo = await one<{ state: string }>(database(c), 'SELECT state FROM repositories WHERE id=?', row.repo_id);
    await authorize(c, repo?.state === 'deleted' ? 'repositories.restore' : 'repositories.read', { repo_id: row.repo_id });
  } else if (row.account_id) await authorize(c, 'accounts.read', { account_id: row.account_id });
  else if (row.actor_id !== requirePrincipal(c).id) throw new ApiError(404, 'not_found', 'The operation was not found.');
  return row;
}

export function registerOperationsRoutes(app: App): void {
  registerAccountExportRoutes(app);
  route(app, 'GET', '/v1/objects/:id/scan-content', { summary: 'Read a principal-owned scan result at its current placement', tags: ['Operations'], streaming: true }, async c => {
    const bytes = await readCodeScanResult(c, c.req.param('id')!);
    return new Response(bytes, { headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
  });
  for (const path of ['/v1/objects/*', '/v1/uploads/*']) app.use(path, async (c, next) => {
    const id = /^\/v1\/(?:objects|uploads)\/([^/]+)(?:\/|$)/.exec(c.req.path)?.[1];
    if (id) {
      const object = await one<{ kind: string; repo_id: string | null }>(database(c), 'SELECT kind,repo_id FROM object_manifests WHERE id=?', id);
      if (object?.kind === 'collaboration_code_scan') {
        if (!['GET', 'HEAD'].includes(c.req.method)) throw new ApiError(409, 'scan_result_immutable', 'Manage this result through its code-scan resource.');
        await authorizeCodeScanObject(c, id);
      }
      if (object && ['archive_chunk', 'account_export_chunk'].includes(object.kind)) throw new ApiError(404, 'not_found', 'The requested object was not found.');
    }
    await next();
  });
  route(app, 'GET', '/v1/operations/:id', { summary: 'Read durable operation progress', tags: ['Operations'] }, async (c) => {
    const row = await readOperation(c); c.header('etag', etag(row.revision)); return c.json(publicOperation(row));
  });
  route(app, 'GET', '/v1/repos/:repoId/operations', { summary: 'List repository operations', tags: ['Operations'], capability: 'repositories.read' }, async (c) => {
    const repo = await getRepository(c, c.req.param('repoId')!, 'repositories.read');
    const { limit, cursor } = page(c);
    const rows = await many<Operation>(database(c), `SELECT * FROM operations WHERE repo_id=? AND id>?
      AND (kind<>'collaboration.code_scan' OR actor_id=?) ORDER BY id LIMIT ?`, repo.id, cursor ?? '', c.get('principal')?.id ?? '', limit + 1);
    return listResponse(c, rows.slice(0, limit).map(publicOperation), rows.length > limit ? rows[limit - 1]!.id : null);
  });
  route(app, 'POST', '/v1/operations/:id/retry', { summary: 'Resume a failed operation from its durable steps', tags: ['Operations'], body: z.object({}).strict() }, async (c) => {
    const operation = await readOperation(c); const revision = expectedRevision(c);
    if (operation.actor_id !== requirePrincipal(c).id) throw new ApiError(403, 'initiator_required', 'The initiating principal must resume this operation.');
    if (operation.status !== 'failed') throw new ApiError(409, 'operation_not_failed', 'Only failed operations can be resumed.');
    if (operation.phase === 'snapshot_abandoned') throw new ApiError(409, 'new_snapshot_required', 'This capture released its write fence. Request a new snapshot to capture current repository state.');
    await mutate(c, {
      sql: `UPDATE operations SET status='pending',error_json=NULL,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status='failed'`,
      bindings: [now(), operation.id, revision],
      after: [stmt(database(c), 'UPDATE operation_dispatches SET attempts=0,next_attempt_at=? WHERE operation_id=?', now(), operation.id)],
      event: { type: 'operation.retry_requested', resource_id: operation.id, resource_revision: revision + 1, repo_id: operation.repo_id, account_id: operation.account_id },
    });
    c.header('etag', etag(revision + 1)); return c.json(publicOperation((await one<Operation>(database(c), 'SELECT * FROM operations WHERE id=?', operation.id))!), 202);
  });
  route(app, 'POST', '/v1/operations/:id/cancel', { summary: 'Cancel an operation before external work starts', tags: ['Operations'], body: z.object({}).strict() }, async (c) => {
    const operation = await readOperation(c); const revision = expectedRevision(c);
    if (operation.kind.startsWith('collaboration.')) throw new ApiError(409, 'resource_cancellation_required', 'Cancel this operation from its collaboration resource so its producer and result fences are updated together.');
    if (operation.kind === 'repository.move') throw new ApiError(409, 'placement_recovery_required', 'A move has already reserved its source epoch. Resume its durable placement operation.');
    if (operation.actor_id !== requirePrincipal(c).id) throw new ApiError(403, 'initiator_required', 'The initiating principal must cancel this operation.');
    await mutate(c, { sql: `UPDATE operations SET status='cancelled',phase='cancelled',revision=revision+1,updated_at=?,completed_at=?
      WHERE id=? AND revision=? AND status IN ('pending','waiting') AND NOT EXISTS(SELECT 1 FROM operation_steps WHERE operation_id=? AND name<>'authorize')`,
    bindings: [now(), now(), operation.id, revision, operation.id],
    event: { type: 'operation.cancelled', resource_id: operation.id, resource_revision: revision + 1, repo_id: operation.repo_id, account_id: operation.account_id } });
    c.header('etag', etag(revision + 1)); return c.json({ id: operation.id, status: 'cancelled', revision: revision + 1 });
  });
  route(app, 'POST', '/v1/repos/:repoId/backups', { summary: 'Create a verified repository backup', tags: ['Operations'], body: z.object({}).strict(), capability: 'repositories.export' }, async (c) => {
    const repo = await getRepository(c, c.req.param('repoId')!, 'repositories.export'); const actor = requirePrincipal(c); const id = newId('op');
    await authorize(c, 'accounts.manage', { account_id: repo.owner_id });
    await mutate(c, { sql: `INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,input_json,created_at,updated_at)
      VALUES(?,'repository.backup',?,?,?,?,?,?,?)`, bindings: [id, repo.id, repo.id, repo.owner_id, actor.id, JSON.stringify({ principal: actor }), now(), now()],
    event: { type: 'operation.requested', resource_id: id, resource_revision: 1, repo_id: repo.id, account_id: repo.owner_id, data: { kind: 'repository.backup' } } });
    c.header('location', `/v1/operations/${id}`); c.header('etag', etag(1));
    return c.json({ id, status: 'pending', revision: 1 }, 202);
  });
  route(app, 'GET', '/v1/repos/:repoId/backups', { summary: 'List verified backup and recovery archives', tags: ['Operations'], capability: 'repositories.export' }, async (c) => {
    const repo = await getRepository(c, c.req.param('repoId')!, 'repositories.export'); const { limit, cursor } = page(c);
    const rows = await many<{ id: string }>(database(c), `SELECT id,kind,state,format_version,revision,bytes,archive_sha256 AS checksum_sha256,created_at,expires_at,verified_at
      FROM repository_archives WHERE repo_id=? AND id>? ORDER BY id LIMIT ?`, repo.id, cursor ?? '', limit + 1);
    const visible = [];
    for (const row of rows.slice(0, limit)) {
      try { await authorizeArchive(c, row.id); visible.push(row); }
      catch (error) { if (!(error instanceof ApiError && [403, 404].includes(error.status))) throw error; }
    }
    return listResponse(c, visible, rows.length > limit ? rows[limit - 1]!.id : null);
  });
  route(app, 'GET', '/v1/archives/:id/content', { summary: 'Download a complete portable checksummed repository archive', tags: ['Operations'], streaming: true, capability: 'repositories.export' }, async (c) => {
    const archive = await one<{ repo_id: string; archive_sha256: string | null }>(database(c), 'SELECT repo_id,archive_sha256 FROM repository_archives WHERE id=?', c.req.param('id'));
    if (!archive) throw new ApiError(404, 'not_found', 'The archive was not found.');
    await authorizeArchive(c, c.req.param('id')!);
    const env = requestOperationsEnvironment(c);
    const manifest = await readArchive(env, c.req.param('id')!, archive.repo_id);
    if (!archive.archive_sha256) throw new ApiError(503, 'archive_checksum_unavailable', 'The archive download checksum is being verified.');
    return new Response(portableArchiveStream(env, manifest, archiveAuthorizer(c, c.req.param('id')!)), { headers: {
      'content-type': 'application/x-tar', 'content-disposition': `attachment; filename="${archive.repo_id}.gitknot.tar"`,
      'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', etag: etag(archive.archive_sha256),
    } });
  });
}
