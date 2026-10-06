import { z } from 'zod';
import { ApiError, authorize, expectedRevision, identityBinding, identityDatabase, listResponse, many, mutate, now, one, page,
  registerResourceLocator, requirePrincipal, resourceResponse, route, sha256, stmt } from '@gitknot/core';
import type { App, AppContext } from '@gitknot/core';
import { accountExport, authorizeAccountExport } from '../../../../packages/operations/src/account-export-state.ts';
import { accountExportCapabilities } from '../../../../packages/operations/src/account-export-types.ts';
import type { AccountExport } from '../../../../packages/operations/src/account-export-types.ts';
import { accountExportPrivate } from '../../../../packages/operations/src/account-export.ts';
import type { Operation, OperationsBindings } from '../../../../packages/operations/src/types.ts';

const base = '/v1/accounts/:accountId/exports';
const env = (c: AppContext) => c.env as OperationsBindings;

async function read(c: AppContext, id = c.req.param('exportId')!, cleanup = false): Promise<AccountExport> {
  const row = await accountExport(env(c), id);
  if (row.account_id !== c.req.param('accountId') || row.created_by !== requirePrincipal(c).id) throw new ApiError(404, 'not_found', 'The account export was not found.');
  if (cleanup) await authorize(c, 'accounts.manage', { account_id: row.account_id });
  else await authorizeAccountExport(env(c), requirePrincipal(c), row);
  return row;
}

async function view(c: AppContext, row: AccountExport): Promise<Record<string, unknown>> {
  const operation = await one<Operation>(identityDatabase(c), 'SELECT * FROM operations WHERE id=?', row.operation_id);
  const coverage = await one<{ repository_count: number; verified_repository_count: number }>(identityDatabase(c), `SELECT COUNT(*) AS repository_count,
    COALESCE(SUM(CASE WHEN state='verified' THEN 1 ELSE 0 END),0) AS verified_repository_count FROM account_export_repositories WHERE export_id=?`, row.id);
  const state = row.expires_at <= now() && !['deleted', 'deleting'].includes(row.state) ? 'expired' : row.state;
  return { id: row.id, account_id: row.account_id, schema_version: row.schema_version, state, revision: row.revision,
    created_at: row.created_at, expires_at: row.expires_at, checksum_sha256: row.checksum_sha256, size_bytes: row.size_bytes,
    error: row.error_code ? { code: row.error_code, message: 'The complete export could not be confirmed.' } : null,
    coverage: { complete: state === 'completed', repository_count: coverage?.repository_count ?? 0, verified_repository_count: coverage?.verified_repository_count ?? 0,
      account_snapshot_at: row.account_snapshot_at },
    operation: operation ? { id: operation.id, kind: operation.kind, status: operation.status, phase: operation.phase, revision: operation.revision } : null,
    download_path: state === 'completed' ? `/v1/accounts/${row.account_id}/exports/${row.id}/download` : null };
}

export function registerAccountExportRoutes(app: App): void {
  route(app, 'POST', base, { summary: 'Create a complete versioned account export with repository content', tags: ['Operations'], body: z.object({}).strict(), capability: 'accounts.manage',
    idempotency: { authorization: c => accountExportCapabilities.map(capability => ({ capability, scope: { account_id: c.req.param('accountId')! } })),
      recover: async (c, receipt) => receipt.resource_id ? resourceResponse(c, await view(c, await read(c, receipt.resource_id))) : null },
  }, async c => {
    const accountId = c.req.param('accountId')!, principal = requirePrincipal(c), db = identityDatabase(c);
    const key = c.req.header('idempotency-key');
    if (!key) throw new ApiError(400, 'idempotency_required', 'Provide an Idempotency-Key for an account export.');
    for (const capability of accountExportCapabilities) await authorize(c, capability, { account_id: accountId });
    const account = await one<{ type: string; owner_user_id: string | null }>(db, 'SELECT type,owner_user_id FROM accounts WHERE id=? AND disabled_at IS NULL', accountId);
    if (!account || account.type === 'user' && account.owner_user_id !== principal.user_id) throw new ApiError(403, 'account_export_owner_required', 'Personal account data requires its current user owner.');
    const hash = (await sha256(`${accountId}:${principal.id}:${c.get('idempotency')?.operation_id ?? key}`)).slice(0, 48);
    const id = `aexport_${hash}`, operationId = `op_ax_${hash}`, at = now(), expires = new Date(Date.now() + 7 * 86400_000).toISOString();
    await registerResourceLocator(c.env, { resource_id: operationId, resource_type: 'operation', repo_id: null, authority: 'identity' });
    await mutate(c, { sql: `INSERT INTO operations(id,kind,resource_id,account_id,actor_id,input_json,created_at,updated_at) VALUES(?,'account.export',?,?,?,?,?,?)`,
      bindings: [operationId, id, accountId, principal.id, JSON.stringify({ principal, account_export_id: id }), at, at],
      after: [stmt(db, `INSERT INTO account_exports(id,operation_id,account_id,created_by,principal_json,state,expires_at,created_at,updated_at)
        VALUES(?,?,?,?,?,'queued',?,?,?)`, id, operationId, accountId, principal.id, JSON.stringify(principal), expires, at, at)],
      event: { type: 'account.export.requested', resource_id: id, resource_revision: 1, account_id: accountId, data: { operation_id: operationId } } });
    c.header('location', `/v1/accounts/${accountId}/exports/${id}`);
    return resourceResponse(c, await view(c, await read(c, id)), 202);
  });
  route(app, 'GET', base, { summary: 'List the caller’s durable account exports', tags: ['Operations'], capability: 'accounts.manage' }, async c => {
    const accountId = c.req.param('accountId')!, principal = requirePrincipal(c), paging = page(c);
    await authorize(c, 'accounts.manage', { account_id: accountId });
    const rows = await many<AccountExport>(identityDatabase(c), 'SELECT * FROM account_exports WHERE account_id=? AND created_by=? AND id>? ORDER BY id LIMIT ?', accountId, principal.id, paging.cursor ?? '', paging.limit + 1);
    const items = [];
    for (const row of rows.slice(0, paging.limit)) { await authorizeAccountExport(env(c), principal, row); items.push(await view(c, row)); }
    return listResponse(c, items, rows.length > paging.limit ? rows[paging.limit - 1]!.id : null);
  });
  route(app, 'GET', `${base}/:exportId`, { summary: 'Read complete account export progress and coverage', tags: ['Operations'], capability: 'accounts.manage' }, async c =>
    resourceResponse(c, await view(c, await read(c))));
  route(app, 'GET', `${base}/:exportId/download`, { summary: 'Download a verified complete account archive', tags: ['Operations'], capability: 'accounts.manage', streaming: true }, async c => {
    const row = await read(c);
    if (row.expires_at <= now()) throw new ApiError(410, 'account_export_expired', 'This account export expired.');
    if (row.state !== 'completed' || !row.checksum_sha256) throw new ApiError(409, 'account_export_not_ready', 'The complete account export is not ready.');
    await authorizeAccountExport(env(c), requirePrincipal(c), row, true);
    const response = await accountExportPrivate(env(c), '/internal/account-exports/download', { export_id: row.id, principal: requirePrincipal(c) });
    if (!response.ok) { await response.body?.cancel(); throw new ApiError(503, 'account_export_storage_unavailable', 'The account archive could not be verified.'); }
    return new Response(response.body, { headers: { 'content-type': 'application/x-tar', 'content-disposition': `attachment; filename="${row.account_id}.gitknot-account.tar"`,
      'content-length': String(row.size_bytes), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', etag: `"${row.checksum_sha256}"` } });
  });
  route(app, 'DELETE', `${base}/:exportId`, { summary: 'Delete an account export after verified storage cleanup', tags: ['Operations'], capability: 'accounts.manage' }, async c => {
    const row = await read(c, undefined, true), revision = expectedRevision(c), at = now();
    if (row.state === 'deleted') return resourceResponse(c, await view(c, row));
    await mutate(c, { sql: "UPDATE account_exports SET state='deleting',revision=revision+1,updated_at=? WHERE id=? AND revision=? AND state<>'deleted'",
      bindings: [at, row.id, revision], after: [stmt(identityDatabase(c), "UPDATE operations SET status='cancelled',phase='export_deleting',revision=revision+1,updated_at=? WHERE id=? AND status NOT IN ('completed','cancelled')", at, row.operation_id)],
      event: { type: 'account.export.deletion_requested', resource_id: row.id, resource_revision: revision + 1, account_id: row.account_id } });
    return resourceResponse(c, await view(c, await accountExport(env(c), row.id)), 202);
  });
}
