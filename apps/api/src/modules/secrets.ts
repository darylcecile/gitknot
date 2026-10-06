import { ApiError, authorize, identityDatabase as database, decodeCursor, encodeCursor, expectedRevision, jsonBody, listResponse, many, newId, one, requirePrincipal, resourceResponse, route, sha256 } from '@gitknot/core';
import type { App, AppContext } from '@gitknot/core';
import { authorizeVault, brokerRequest, findEntry, publicEntry, resolveVaultScope, vaultNameSchema, vaultPolicySchema, writeVaultEntry } from '@gitknot/secrets';
import type { ScopeSelector, VaultEntry, VaultKind, VaultScope, VaultVersion } from '@gitknot/secrets';
import { z } from 'zod';
import { handleVaultAuthorityRequest } from '@gitknot/secrets/authority';

const writeSchema = z.object({ value: z.string().max(16_384), description: z.string().max(1024).optional(), policy: vaultPolicySchema.optional(), revoke_previous: z.boolean().optional() }).strict();
const createSchema = z.object({ name: vaultNameSchema, ...writeSchema.shape }).strict();
const policySchema = z.object({ policy: vaultPolicySchema }).strict();
const revokeSchema = z.object({ reason: z.string().min(1).max(1000) }).strict();
const routes: Array<{ path: string; selector: (c: AppContext) => ScopeSelector }> = [
  { path: '/v1/accounts/:accountId', selector: (c) => ({ account_id: c.req.param('accountId')! }) },
  { path: '/v1/repos/:repoId', selector: (c) => ({ repo_id: c.req.param('repoId')! }) },
  { path: '/v1/repos/:repoId/environments/:envId', selector: (c) => ({ repo_id: c.req.param('repoId')!, environment_id: c.req.param('envId')! }) },
];

async function scope(c: AppContext, selector: ScopeSelector, kind: VaultKind, write = false, revocation = false): Promise<VaultScope> {
  const result = await resolveVaultScope(c, selector, !write || revocation);
  const capability = kind === 'secret' ? 'secrets.manage' : write ? 'variables.manage' : 'variables.read';
  await authorizeVault(c, requirePrincipal(c), capability, result, revocation);
  c.header('cache-control', 'no-store');
  return result;
}

async function operationId(c: AppContext): Promise<string> {
  const key = c.req.header('idempotency-key') ?? newId('request');
  if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new ApiError(400, 'invalid_idempotency_key', 'Use 1–128 visible ASCII characters for Idempotency-Key.');
  return sha256(`${c.req.method}:${c.req.path}:${key}`);
}

function name(c: AppContext): string { return vaultNameSchema.parse(c.req.param('name')); }

function page(c: AppContext): { limit: number; cursor: string } {
  const limit = Number(c.req.query('limit') ?? 30);
  const cursor = decodeCursor<unknown>(c.req.query('cursor') ?? null, '');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || typeof cursor !== 'string' || cursor.length > 256) {
    throw new ApiError(422, 'invalid_pagination', 'Use a valid cursor and a limit between 1 and 100.');
  }
  return { limit, cursor };
}

export function registerSecretsRoutes(app: App): void {
  app.post('/internal/vault/authority', (c) => handleVaultAuthorityRequest(c.req.raw, c.env));
  for (const definition of routes) for (const kind of ['secret', 'variable'] as const) {
    const base = `${definition.path}/${kind === 'secret' ? 'secrets' : 'variables'}`;
    const options = { tags: ['Secrets and variables'], capability: kind === 'secret' ? 'secrets.manage' : 'variables.read' };
    route(app, 'GET', base, { ...options, summary: `List scoped ${kind} metadata${kind === 'variable' ? ' and values' : ''}` }, async (c) => {
      const selected = await scope(c, definition.selector(c), kind);
      const { limit, cursor } = page(c);
      const rows = await many<VaultEntry & { plain_value: string | null; version: number }>(database(c), `SELECT e.*,v.plain_value,v.version FROM vault_entries e
        JOIN vault_versions v ON v.id=e.current_version_id AND v.entry_id=e.id WHERE e.account_id=? AND e.scope_type=? AND e.scope_id=?
        AND e.kind=? AND e.deleted_at IS NULL AND e.name>? ORDER BY e.name LIMIT ?`, selected.account_id, selected.scope_type, selected.scope_id, kind, cursor, limit + 1);
      return listResponse(c, rows.slice(0, limit).map((entry) => ({ ...publicEntry(entry), version: entry.version, ...(kind === 'variable' ? { value: entry.plain_value } : {}) })),
        rows.length > limit ? encodeCursor(rows[limit - 1]!.name) : null);
    });
    route(app, 'POST', base, { ...options, capability: kind === 'secret' ? 'secrets.manage' : 'variables.manage', summary: `Create an immutable scoped ${kind} version`, body: createSchema,
      idempotent: false, sensitive: kind === 'secret' }, async (c) => {
      const selected = definition.selector(c);
      await scope(c, selected, kind, true);
      const body = await jsonBody(c, createSchema);
      const result = await writeVaultEntry(c.env, { ...body, principal: requirePrincipal(c), scope: selected, kind, expected_revision: null, operation_id: await operationId(c) });
      c.header('location', `${c.req.path}/${body.name}`);
      return resourceResponse(c, result, 201);
    });
    route(app, 'GET', `${base}/:name`, { ...options, summary: kind === 'secret' ? 'Read retained secret metadata, including revocation tombstones' : 'Read a scoped variable' }, async (c) => {
      const selector = definition.selector(c);
      await scope(c, selector, kind);
      const entry = await findEntry(c, selector, kind, name(c));
      if (!entry) throw new ApiError(404, 'not_found', 'The scoped entry was not found.');
      const version = await one<VaultVersion>(database(c), 'SELECT * FROM vault_versions WHERE id=? AND entry_id=? AND account_id=?', entry.current_version_id, entry.id, entry.account_id);
      if (!version) throw new ApiError(503, 'vault_version_unavailable', 'The current version could not be verified.');
      return resourceResponse(c, publicEntry(entry, version));
    });
    route(app, 'PUT', `${base}/:name`, { ...options, capability: kind === 'secret' ? 'secrets.manage' : 'variables.manage', summary: `Rotate the ${kind} value without exposing earlier versions`, body: writeSchema,
      idempotent: false, sensitive: kind === 'secret' }, async (c) => {
      const selector = definition.selector(c);
      await scope(c, selector, kind, true);
      const result = await writeVaultEntry(c.env, { ...await jsonBody(c, writeSchema), name: name(c), kind, principal: requirePrincipal(c), scope: selector,
        expected_revision: expectedRevision(c), operation_id: await operationId(c) });
      return resourceResponse(c, result);
    });
    route(app, 'PATCH', `${base}/:name`, { ...options, capability: kind === 'secret' ? 'secrets.manage' : 'variables.manage', summary: 'Change a vault use policy and invalidate stale plan selections', body: policySchema, idempotent: false }, async (c) => {
      const selector = definition.selector(c);
      await scope(c, selector, kind, true);
      const result = await brokerRequest<Record<string, unknown>>(c.env, 'vault.manage', '/internal/vault/policy', {
        ...await jsonBody(c, policySchema), scope: selector, name: name(c), kind, principal: requirePrincipal(c), expected_revision: expectedRevision(c), operation_id: await operationId(c),
      });
      return resourceResponse(c, result);
    });
    route(app, 'DELETE', `${base}/:name`, { ...options, capability: kind === 'secret' ? 'secrets.manage' : 'variables.manage', summary: 'Revoke a scoped entry while retaining encrypted audit history', idempotent: false }, async (c) => {
      const selector = definition.selector(c);
      await scope(c, selector, kind, true, true);
      await brokerRequest(c.env, 'vault.manage', '/internal/vault/delete', { scope: selector, name: name(c), kind, principal: requirePrincipal(c),
        expected_revision: expectedRevision(c), operation_id: await operationId(c) });
      return c.body(null, 204);
    });
    route(app, 'GET', `${base}/:name/versions`, { ...options, summary: kind === 'secret' ? 'List immutable secret version metadata without values' : 'List immutable variable versions' }, async (c) => {
      const selector = definition.selector(c);
      await scope(c, selector, kind);
      const entry = await findEntry(c, selector, kind, name(c));
      if (!entry) throw new ApiError(404, 'not_found', 'The scoped entry was not found.');
      const { limit, cursor } = page(c);
      const rows = await many<VaultVersion & { revoked_at: string | null }>(database(c), `SELECT v.id,v.entry_id,v.account_id,v.version,v.plain_value,v.created_at,v.created_by,r.revoked_at
        FROM vault_versions v LEFT JOIN vault_version_revocations r ON r.version_id=v.id WHERE v.entry_id=? AND v.account_id=? AND v.id>? ORDER BY v.id LIMIT ?`, entry.id, entry.account_id, cursor, limit + 1);
      return listResponse(c, rows.slice(0, limit).map((row) => ({ id: row.id, entry_id: row.entry_id, version: row.version, created_at: row.created_at,
        created_by: row.created_by, revoked_at: row.revoked_at, ...(kind === 'variable' ? { value: row.plain_value } : {}) })), rows.length > limit ? encodeCursor(rows[limit - 1]!.id) : null);
    });
    route(app, 'POST', `${base}/:name/versions/:versionId/revoke`, { ...options, capability: kind === 'secret' ? 'secrets.manage' : 'variables.manage', summary: 'Revoke a selected immutable version', body: revokeSchema, idempotent: false }, async (c) => {
      const selector = definition.selector(c);
      await scope(c, selector, kind, true, true);
      return resourceResponse(c, await brokerRequest<Record<string, unknown>>(c.env, 'vault.manage', '/internal/vault/revoke-version', {
        ...await jsonBody(c, revokeSchema), principal: requirePrincipal(c), scope: selector, kind, name: name(c), version_id: c.req.param('versionId'),
        expected_revision: expectedRevision(c), operation_id: await operationId(c),
      }));
    });
  }
}
