import { z } from 'zod';
import { identityDatabase as database, readRepositoryAuthority } from '@gitknot/core/authority';
import { ApiError, authorize, capabilityCovered, capabilityPatternSchema, expectedRevision, jsonBody, listResponse, many, newId, now, one, page, requirePrincipal, route, stmt,
  type App, type AppContext, type Repository } from '@gitknot/core';
import { afterSeconds, checkedWrite } from '@gitknot/core/auth';
import { commitIdentity, idSchema, revisionResponse } from '../identity/shared.ts';
import { accountAccess, assertDelegable, bumpAccountPolicy } from './shared.ts';

const capabilities = z.array(capabilityPatternSchema.refine(value => !value.includes('*'), 'Use explicit capabilities.')).min(1).max(64);
const identitySchema = z.object({ name: z.string().trim().min(1).max(100), kind: z.enum(['service', 'agent']), capabilities,
  repository_ids: z.array(idSchema).max(50).default([]), expires_at: z.iso.datetime().nullable().optional() }).strict();
const identityPatchSchema = z.object({ name: z.string().trim().min(1).max(100).optional(), expires_at: z.iso.datetime().nullable().optional() }).strict()
  .refine(value => Object.keys(value).length > 0, 'Supply at least one identity field.');
const applicationSchema = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(1000).default(''),
  homepage_url: z.url().max(2048).refine(value => new URL(value).protocol === 'https:', 'Use an HTTPS homepage.').nullable().default(null), capabilities }).strict();
const installationSchema = z.object({ application_id: idSchema, repository_ids: z.array(idSchema).min(1).max(100), capabilities }).strict();
const installationPatchSchema = z.object({ repository_ids: z.array(idSchema).min(1).max(100).optional(), capabilities: capabilities.optional(), suspended: z.boolean().optional() }).strict()
  .refine(value => Object.keys(value).length > 0, 'Supply at least one installation field.');

interface Application { id: string; account_id: string; name: string; description: string; homepage_url: string | null; capabilities_json: string;
  disabled_at: string | null; revision: number; created_by: string; created_at: string; updated_at: string }
interface Installation { id: string; application_id: string; account_id: string; capabilities_json: string; repository_ids_json: string; suspended_at: string | null;
  revision: number; installed_by: string; created_at: string; updated_at: string }
interface Machine { id: string; account_id: string; kind: 'service' | 'agent'; name: string; disabled_at: string | null; expires_at: string | null; revision: number; created_by: string; created_at: string; updated_at: string }

function publicApplication(row: Application): Record<string, unknown> & { revision: number } {
  return { id: row.id, account_id: row.account_id, name: row.name, description: row.description, homepage_url: row.homepage_url,
    capabilities: JSON.parse(row.capabilities_json) as string[], disabled_at: row.disabled_at, revision: row.revision,
    created_at: row.created_at, updated_at: row.updated_at };
}
function publicInstallation(row: Installation): Record<string, unknown> & { revision: number } {
  return { id: row.id, application_id: row.application_id, account_id: row.account_id, capabilities: JSON.parse(row.capabilities_json) as string[],
    repository_ids: JSON.parse(row.repository_ids_json) as string[], suspended: row.suspended_at !== null, revision: row.revision,
    installed_by: row.installed_by, created_at: row.created_at, updated_at: row.updated_at };
}

async function scopedRepositories(c: AppContext, accountId: string, ids: string[], requested: string[]): Promise<Repository[]> {
  const repositories: Repository[] = [];
  for (const id of new Set(ids)) {
    const repo = await readRepositoryAuthority(c, id);
    if (!repo || repo.owner_id !== accountId || repo.state !== 'active') throw new ApiError(404, 'not_found', 'An included repository is unavailable in this account.');
    await authorize(c, 'permissions.manage', { repo_id: id });
    await assertDelegable(c, requested.map(capability => ({ capability, effect: 'allow' })), { repo_id: id });
    repositories.push(repo);
  }
  return repositories;
}

function principalGrants(c: AppContext, input: { account_id: string; principal_id: string; kind: string; repository_ids: string[]; capabilities: string[]; expires_at?: string | null }): D1PreparedStatement[] {
  return (input.repository_ids.length ? input.repository_ids : [null]).flatMap(repoId => input.capabilities.map(capability => stmt(database(c),
    'INSERT INTO access_grants(id,account_id,repo_id,principal_type,principal_id,capability,expires_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    newId('grant'), input.account_id, repoId, input.kind, input.principal_id, capability, input.expires_at ?? null, requirePrincipal(c).id, now(), now())));
}

function registerMachineScope(app: App, path: string): void {
  route(app, 'GET', path, { summary: 'List account service and agent identities', tags: ['identities'], capability: 'identities.read' }, async c => {
    const { account } = await accountAccess(c, c.req.param('id'), 'identities.read');
    const { limit, cursor } = page(c);
    const rows = await many<Machine>(database(c), "SELECT id,account_id,kind,name,disabled_at,expires_at,revision,created_by,created_at,updated_at FROM principals WHERE account_id=? AND kind IN ('service','agent') AND id>? ORDER BY id LIMIT ?", account.id, cursor ?? '', limit + 1);
    return listResponse(c, rows.slice(0, limit), rows.length > limit ? rows[limit - 1]!.id : null);
  });
  route(app, 'POST', path, { summary: 'Create a scoped automation identity', tags: ['identities'], body: identitySchema, capability: 'identities.manage' }, async c => {
    const { account, authorization } = await accountAccess(c, c.req.param('id'), 'identities.manage');
    const body = await jsonBody(c, identitySchema);
    const expiresAt = body.expires_at ?? (body.kind === 'agent' ? afterSeconds(7 * 86400) : null);
    if (expiresAt && (expiresAt <= now() || expiresAt > afterSeconds(366 * 86400))) throw new ApiError(422, 'invalid_identity_expiry', 'Identity expiration must be within the next year.');
    await scopedRepositories(c, account.id, body.repository_ids, body.capabilities);
    if (!body.repository_ids.length) await assertDelegable(c, body.capabilities.map(capability => ({ capability, effect: 'allow' })), { account_id: account.id });
    const id = newId(body.kind === 'agent' ? 'agent' : 'svc');
    const timestamp = now();
    await commitIdentity(c, [stmt(database(c), 'INSERT INTO principals(id,kind,account_id,name,expires_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      id, body.kind, account.id, body.name, expiresAt, requirePrincipal(c).id, timestamp, timestamp),
    ...principalGrants(c, { account_id: account.id, principal_id: id, kind: body.kind, repository_ids: body.repository_ids, capabilities: body.capabilities, expires_at: expiresAt }),
    bumpAccountPolicy(c, account.id)], { type: 'identity.automation_created', resource_id: id, resource_revision: 1, account_id: account.id }, { authorizations: [authorization] });
    return revisionResponse(c, { id, account_id: account.id, kind: body.kind, name: body.name, capabilities: body.capabilities,
      repository_ids: body.repository_ids, expires_at: expiresAt, revision: 1, created_at: timestamp, updated_at: timestamp }, 201);
  });
  route(app, 'PATCH', `${path}/:principalId`, { summary: 'Update an automation identity', tags: ['identities'], body: identityPatchSchema, capability: 'identities.manage' }, async c => {
    const { account, authorization } = await accountAccess(c, c.req.param('id'), 'identities.manage');
    const body = await jsonBody(c, identityPatchSchema);
    const revision = expectedRevision(c);
    const principal = await one<Machine>(database(c), "SELECT * FROM principals WHERE id=? AND account_id=? AND kind IN ('service','agent') AND disabled_at IS NULL", c.req.param('principalId'), account.id);
    if (!principal) throw new ApiError(404, 'not_found', 'The requested identity was not found.');
    const expiresAt = body.expires_at === undefined ? principal.expires_at : body.expires_at;
    if (principal.kind === 'agent' && !expiresAt || expiresAt && (expiresAt <= now() || expiresAt > afterSeconds(366 * 86400))) throw new ApiError(422, 'invalid_identity_expiry', 'Agents require a future bounded expiration within one year.');
    await commitIdentity(c, [...checkedWrite(database(c), stmt(database(c), 'UPDATE principals SET name=?,expires_at=?,revision=revision+1,updated_at=? WHERE id=? AND account_id=? AND revision=? AND disabled_at IS NULL',
      body.name ?? principal.name, expiresAt, now(), principal.id, account.id, revision)), bumpAccountPolicy(c, account.id)],
    { type: 'identity.automation_updated', resource_id: principal.id, resource_revision: revision + 1, account_id: account.id }, { authorizations: [authorization] });
    return revisionResponse(c, { id: principal.id, account_id: account.id, kind: principal.kind, name: body.name ?? principal.name,
      expires_at: expiresAt, revision: revision + 1, updated_at: now() });
  });
  route(app, 'DELETE', `${path}/:principalId`, { summary: 'Disable an automation identity and revoke all its credentials', tags: ['identities'], capability: 'identities.manage' }, async c => {
    const { account, authorization } = await accountAccess(c, c.req.param('id'), 'identities.manage');
    const revision = expectedRevision(c);
    await commitIdentity(c, [...checkedWrite(database(c), stmt(database(c), "UPDATE principals SET disabled_at=?,revision=revision+1,updated_at=? WHERE id=? AND account_id=? AND revision=? AND kind IN ('service','agent')",
      now(), now(), c.req.param('principalId'), account.id, revision)),
    stmt(database(c), 'UPDATE credentials SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE principal_id=?', now(), c.req.param('principalId')),
    stmt(database(c), 'UPDATE access_grants SET revoked_at=COALESCE(revoked_at,?),revision=revision+1,updated_at=? WHERE account_id=? AND principal_id=?', now(), now(), account.id, c.req.param('principalId')),
    bumpAccountPolicy(c, account.id)], { type: 'identity.automation_disabled', resource_id: c.req.param('principalId')!, resource_revision: revision + 1, account_id: account.id }, { authorizations: [authorization] });
    return c.body(null, 204);
  });
}

function registerApplicationScope(app: App, path: string): void {
  route(app, 'GET', path, { summary: 'List applications owned by an account', tags: ['applications'], capability: 'identities.read' }, async c => {
    const { account } = await accountAccess(c, c.req.param('id'), 'identities.read');
    const { limit, cursor } = page(c);
    const rows = await many<Application>(database(c), 'SELECT * FROM applications WHERE account_id=? AND id>? ORDER BY id LIMIT ?', account.id, cursor ?? '', limit + 1);
    return listResponse(c, rows.slice(0, limit).map(publicApplication), rows.length > limit ? rows[limit - 1]!.id : null);
  });
  route(app, 'POST', path, { summary: 'Register a GitKnot application and its declared permissions', tags: ['applications'], body: applicationSchema, capability: 'identities.manage' }, async c => {
    const { account, authorization } = await accountAccess(c, c.req.param('id'), 'identities.manage');
    const body = await jsonBody(c, applicationSchema);
    const id = newId('app');
    const timestamp = now();
    await commitIdentity(c, [stmt(database(c), 'INSERT INTO applications(id,account_id,name,description,homepage_url,capabilities_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, account.id, body.name, body.description, body.homepage_url, JSON.stringify(body.capabilities), requirePrincipal(c).id, timestamp, timestamp)],
    { type: 'application.created', resource_id: id, resource_revision: 1, account_id: account.id }, { authorizations: [authorization] });
    return revisionResponse(c, { id, account_id: account.id, ...body, revision: 1, created_at: timestamp, updated_at: timestamp }, 201);
  });
  route(app, 'PUT', `${path}/:applicationId`, { summary: 'Update application metadata and declared permissions', tags: ['applications'], body: applicationSchema, capability: 'identities.manage' }, async c => {
    const { account, authorization } = await accountAccess(c, c.req.param('id'), 'identities.manage');
    const body = await jsonBody(c, applicationSchema);
    const revision = expectedRevision(c);
    await commitIdentity(c, checkedWrite(database(c), stmt(database(c), `UPDATE applications SET name=?,description=?,homepage_url=?,capabilities_json=?,revision=revision+1,updated_at=?
      WHERE id=? AND account_id=? AND revision=? AND disabled_at IS NULL`, body.name, body.description, body.homepage_url, JSON.stringify(body.capabilities), now(), c.req.param('applicationId'), account.id, revision)),
    { type: 'application.updated', resource_id: c.req.param('applicationId')!, resource_revision: revision + 1, account_id: account.id,
      data: { installations_require_explicit_scope_changes: true } }, { authorizations: [authorization] });
    return revisionResponse(c, { id: c.req.param('applicationId'), account_id: account.id, ...body, revision: revision + 1, updated_at: now() });
  });
  route(app, 'DELETE', `${path}/:applicationId`, { summary: 'Disable an application and all installations', tags: ['applications'], capability: 'identities.manage' }, async c => {
    const { account, authorization } = await accountAccess(c, c.req.param('id'), 'identities.manage');
    const revision = expectedRevision(c);
    const id = c.req.param('applicationId')!;
    await commitIdentity(c, [...checkedWrite(database(c), stmt(database(c), 'UPDATE applications SET disabled_at=?,revision=revision+1,updated_at=? WHERE id=? AND account_id=? AND revision=?', now(), now(), id, account.id, revision)),
      stmt(database(c), 'UPDATE principals SET disabled_at=?,revision=revision+1,updated_at=? WHERE id IN (SELECT id FROM installations WHERE application_id=?)', now(), now(), id),
      stmt(database(c), 'UPDATE credentials SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE principal_id IN (SELECT id FROM installations WHERE application_id=?)', now(), id),
      stmt(database(c), 'UPDATE accounts SET policy_revision=policy_revision+1,revision=revision+1,updated_at=? WHERE id IN (SELECT account_id FROM installations WHERE application_id=?)', now(), id)],
    { type: 'application.disabled', resource_id: id, resource_revision: revision + 1, account_id: account.id }, { authorizations: [authorization] });
    return c.body(null, 204);
  });
}

function registerInstallationScope(app: App, path: string): void {
  route(app, 'GET', path, { summary: 'List account application installations', tags: ['applications'], capability: 'installations.read' }, async c => {
    const { account } = await accountAccess(c, c.req.param('id'), 'installations.read');
    const { limit, cursor } = page(c);
    const rows = await many<Installation>(database(c), 'SELECT * FROM installations WHERE account_id=? AND id>? ORDER BY id LIMIT ?', account.id, cursor ?? '', limit + 1);
    return listResponse(c, rows.slice(0, limit).map(publicInstallation), rows.length > limit ? rows[limit - 1]!.id : null);
  });
  route(app, 'POST', path, { summary: 'Install an application with explicit repository and capability scopes', tags: ['applications'], body: installationSchema, capability: 'installations.manage' }, async c => {
    const { account, authorization } = await accountAccess(c, c.req.param('id'), 'installations.manage');
    const body = await jsonBody(c, installationSchema);
    const application = await one<Application>(database(c), 'SELECT * FROM applications WHERE id=? AND disabled_at IS NULL', body.application_id);
    if (!application) throw new ApiError(404, 'not_found', 'The requested application was not found.');
    const declared = JSON.parse(application.capabilities_json) as string[];
    if (body.capabilities.some(capability => !capabilityCovered(declared, capability))) throw new ApiError(422, 'application_scope_mismatch', 'The application did not declare one of the requested capabilities.');
    await scopedRepositories(c, account.id, body.repository_ids, body.capabilities);
    const id = newId('inst');
    const timestamp = now();
    await commitIdentity(c, [stmt(database(c), "INSERT INTO principals(id,kind,account_id,name,created_by,created_at,updated_at) VALUES (?,'application',?,?,?,?,?)",
      id, account.id, application.name, requirePrincipal(c).id, timestamp, timestamp),
    stmt(database(c), 'INSERT INTO installations(id,application_id,account_id,capabilities_json,repository_ids_json,installed_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      id, application.id, account.id, JSON.stringify(body.capabilities), JSON.stringify(body.repository_ids), requirePrincipal(c).id, timestamp, timestamp),
    ...principalGrants(c, { account_id: account.id, principal_id: id, kind: 'application', repository_ids: body.repository_ids, capabilities: body.capabilities }), bumpAccountPolicy(c, account.id)],
    { type: 'application.installed', resource_id: id, resource_revision: 1, account_id: account.id }, { authorizations: [authorization] });
    return revisionResponse(c, { id, account_id: account.id, application_id: application.id, capabilities: body.capabilities, repository_ids: body.repository_ids,
      suspended: false, revision: 1, created_at: timestamp, updated_at: timestamp }, 201);
  });
  route(app, 'GET', `${path}/:installationId`, { summary: 'Read an installation and its scopes', tags: ['applications'], capability: 'installations.read' }, async c => {
    const { account } = await accountAccess(c, c.req.param('id'), 'installations.read');
    const installation = await one<Installation>(database(c), 'SELECT * FROM installations WHERE id=? AND account_id=?', c.req.param('installationId'), account.id);
    if (!installation) throw new ApiError(404, 'not_found', 'The requested installation was not found.');
    return revisionResponse(c, publicInstallation(installation));
  });
  route(app, 'PATCH', `${path}/:installationId`, { summary: 'Explicitly change or suspend an installation scope', tags: ['applications'], body: installationPatchSchema, capability: 'installations.manage' }, async c => {
    const { account, authorization } = await accountAccess(c, c.req.param('id'), 'installations.manage');
    const body = await jsonBody(c, installationPatchSchema);
    const revision = expectedRevision(c);
    const installation = await one<Installation>(database(c), 'SELECT * FROM installations WHERE id=? AND account_id=?', c.req.param('installationId'), account.id);
    const application = installation ? await one<Application>(database(c), 'SELECT * FROM applications WHERE id=? AND disabled_at IS NULL', installation.application_id) : null;
    if (!installation || !application) throw new ApiError(404, 'not_found', 'The requested installation was not found.');
    const repositoryIds = body.repository_ids ?? JSON.parse(installation.repository_ids_json) as string[];
    const requested = body.capabilities ?? JSON.parse(installation.capabilities_json) as string[];
    if (requested.some(capability => !capabilityCovered(JSON.parse(application.capabilities_json) as string[], capability))) throw new ApiError(422, 'application_scope_mismatch', 'Requested capabilities exceed the application declaration.');
    await scopedRepositories(c, account.id, repositoryIds, requested);
    const suspendedAt = body.suspended === undefined ? installation.suspended_at : body.suspended ? now() : null;
    await commitIdentity(c, [...checkedWrite(database(c), stmt(database(c), 'UPDATE installations SET capabilities_json=?,repository_ids_json=?,suspended_at=?,revision=revision+1,updated_at=? WHERE id=? AND account_id=? AND revision=?',
      JSON.stringify(requested), JSON.stringify(repositoryIds), suspendedAt, now(), installation.id, account.id, revision)),
    stmt(database(c), 'UPDATE credentials SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE principal_id=?', now(), installation.id),
    stmt(database(c), 'UPDATE access_grants SET revoked_at=COALESCE(revoked_at,?),revision=revision+1,updated_at=? WHERE account_id=? AND principal_id=?', now(), now(), account.id, installation.id),
    ...principalGrants(c, { account_id: account.id, principal_id: installation.id, kind: 'application', repository_ids: repositoryIds, capabilities: requested }), bumpAccountPolicy(c, account.id)],
    { type: 'application.installation_updated', resource_id: installation.id, resource_revision: revision + 1, account_id: account.id }, { authorizations: [authorization] });
    return revisionResponse(c, { ...publicInstallation(installation), capabilities: requested, repository_ids: repositoryIds, suspended: suspendedAt !== null, revision: revision + 1, updated_at: now() });
  });
  route(app, 'DELETE', `${path}/:installationId`, { summary: 'Uninstall an application and revoke its access', tags: ['applications'], capability: 'installations.manage' }, async c => {
    const { account, authorization } = await accountAccess(c, c.req.param('id'), 'installations.manage');
    const revision = expectedRevision(c);
    const id = c.req.param('installationId')!;
    await commitIdentity(c, [...checkedWrite(database(c), stmt(database(c), 'UPDATE installations SET suspended_at=?,revision=revision+1,updated_at=? WHERE id=? AND account_id=? AND revision=?', now(), now(), id, account.id, revision)),
      stmt(database(c), 'UPDATE principals SET disabled_at=?,revision=revision+1,updated_at=? WHERE id=? AND account_id=?', now(), now(), id, account.id),
      stmt(database(c), 'UPDATE credentials SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE principal_id=?', now(), id),
      stmt(database(c), 'UPDATE access_grants SET revoked_at=COALESCE(revoked_at,?),revision=revision+1,updated_at=? WHERE account_id=? AND principal_id=?', now(), now(), account.id, id), bumpAccountPolicy(c, account.id)],
    { type: 'application.uninstalled', resource_id: id, resource_revision: revision + 1, account_id: account.id }, { authorizations: [authorization] });
    return c.body(null, 204);
  });
}

export function registerMachineIdentityRoutes(app: App): void {
  registerMachineScope(app, '/v1/accounts/:id/identities');
  registerMachineScope(app, '/v1/orgs/:id/identities');
  registerApplicationScope(app, '/v1/accounts/:id/applications');
  registerInstallationScope(app, '/v1/accounts/:id/installations');
  registerInstallationScope(app, '/v1/orgs/:id/installations');
  route(app, 'GET', '/v1/applications/:applicationId', { summary: 'Inspect an application declaration before installation', tags: ['applications'] }, async c => {
    requirePrincipal(c);
    const application = await one<Application>(database(c), 'SELECT * FROM applications WHERE id=? AND disabled_at IS NULL', c.req.param('applicationId'));
    if (!application) throw new ApiError(404, 'not_found', 'The requested application was not found.');
    return revisionResponse(c, publicApplication(application));
  });
}
