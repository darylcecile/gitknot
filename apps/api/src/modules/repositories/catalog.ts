import { z } from 'zod';
import { database } from '@gitknot/core/db';
import { identityDatabase, readRepositoryAuthority, withAccountAuthorityBarrier } from '@gitknot/core/authority';
import { requestDatabaseLocation } from '@gitknot/core/routing/cells';
import { ApiError, authorize, decodeCursor, encodeCursor, expectedRevision, explainAuthorization, getRepository, jsonBody, limits, listResponse,
  many, newId, now, one, page, readAccountPolicy, requirePrincipal, route, stmt,
  type AccountRecord, type App, type AppContext, type PermissionExplanation, type Repository } from '@gitknot/core';
import { checkedWrite, identityRateLimit } from '@gitknot/core/auth';
import { commitIdentity, idSchema, revisionResponse } from '../identity/shared.ts';
import { operationResponse, prepareRepositoryOperation, publicRepository, withRepositoryBarrier } from './shared.ts';

export const repositoryNameSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  .refine(value => !value.endsWith('.git') && value !== '.' && value !== '..', 'Repository names must not end in .git.');
const branchSchema = z.string().min(1).max(255).refine(value => !/[\x00-\x20\x7f~^:?*\[\\]/.test(value)
  && !value.includes('..') && !value.includes('@{') && !value.endsWith('.') && !value.endsWith('/')
  && value.split('/').every(part => !!part && !part.startsWith('.') && !part.endsWith('.lock')), 'Use a valid Git branch name.');
const visibilitySchema = z.enum(['public', 'private', 'internal', 'unlisted']);
const visibilityParameter = { name: 'visibility', in: 'query', required: false,
  description: 'Filter current repository visibility. Existing permissions and unlisted discovery restrictions still apply.',
  schema: { type: 'string', enum: visibilitySchema.options } };
const sourceUrlSchema = z.url().max(2048).refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash && (!url.port || url.port === '443')
    && !/^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[)/i.test(url.hostname)
    && !/\.(?:localhost|local|internal)$/i.test(url.hostname);
}, 'Use a public HTTPS source URL without embedded credentials or fragments.');
const createSchema = z.object({ owner_id: idSchema, name: repositoryNameSchema, description: z.string().max(2000).default(''),
  visibility: visibilitySchema.optional(), default_branch: branchSchema.default('main'), fork_source_id: idSchema.optional(),
  import: z.object({ source_url: sourceUrlSchema, source_secret_id: idSchema.optional() }).strict().optional(),
  workspace: z.boolean().default(false),
}).strict().refine(value => !(value.fork_source_id && value.import), 'A repository can be forked or imported, not both.');
const patchSchema = z.object({ name: repositoryNameSchema.optional(), description: z.string().max(2000).optional(), visibility: visibilitySchema.optional(), default_branch: branchSchema.optional() }).strict()
  .refine(value => Object.keys(value).length > 0, 'Supply at least one repository field.');

export async function enforceVisibility(c: AppContext, account: AccountRecord, visibility: Repository['visibility'], source: Repository | null): Promise<void> {
  const { policy } = await readAccountPolicy(identityDatabase(c), account.id);
  if (visibility === 'internal' && account.type !== 'organization') throw new ApiError(422, 'internal_requires_organization', 'Internal repositories must belong to an organization.');
  if (!policy.allowed_repository_visibilities.includes(visibility)) throw new ApiError(403, 'visibility_not_allowed', 'The owning account does not permit this visibility.');
  if (!source) return;
  const sourcePolicy = await readAccountPolicy(identityDatabase(c), source.owner_id);
  if (['public', 'unlisted'].includes(visibility) && (!sourcePolicy.policy.allow_public_forks
    || !(await explainAuthorization(c, 'contents.read', { repo_id: source.id }, null)).allowed)) {
    throw new ApiError(422, 'restricted_fork_visibility', 'A restricted fork must remain private or internal to an authorized organization.');
  }
  if (source.visibility === 'unlisted' && visibility === 'public') throw new ApiError(422, 'unlisted_fork_visibility', 'A fork of an unlisted repository must remain unlisted or restricted.');
}

async function listCatalog(c: AppContext, profileUserId?: string): Promise<Response> {
  const { limit, cursor } = page(c);
  const principal = c.get('principal');
  const ownerId = profileUserId ?? c.req.query('owner_id') ?? null;
  const state = c.req.query('state') ?? null;
  const visibility = c.req.query('visibility');
  if (state && !['active', 'archived', 'provisioning', 'deleted'].includes(state)) throw new ApiError(422, 'invalid_repository_state', 'Use active, archived, provisioning, or deleted for repository listing.');
  if (visibility !== undefined && !visibilitySchema.safeParse(visibility).success) throw new ApiError(422, 'invalid_repository_visibility', 'Use public, private, internal, or unlisted for repository visibility.');
  if (state === 'deleted' && (!ownerId || !principal)) throw new ApiError(403, 'owner_scope_required', 'Deleted repository listing requires an authenticated owner scope.');
  const cursorValue = decodeCursor<{ id?: unknown }>(cursor, {});
  if (cursorValue.id !== undefined && typeof cursorValue.id !== 'string') throw new ApiError(422, 'invalid_cursor', 'The repository cursor is invalid.');
  // The primary catalog and enrollment registry are only ID-discovery hints.
  // Ownership, state, visibility, names and permissions always come from placement.
  const rows = await many<{ id: string }>(identityDatabase(c), `SELECT id FROM (
    SELECT id FROM repositories UNION SELECT repo_id AS id FROM account_authority_repositories
  ) WHERE id>? ORDER BY id LIMIT ?`, cursorValue.id ?? '', limit + 1);
  const capability = state === 'deleted' ? 'repositories.restore' : 'repositories.read';
  const evaluated = await Promise.all(rows.slice(0, limit).map(async ({ id }) => {
    const access = await explainAuthorization(c, capability, { repo_id: id });
    if (!access.allowed) return null;
    const repository = await readRepositoryAuthority(c, id);
    if (!repository || repository.revision !== access.repository_revision || repository.owner_id !== access.account_id
      || repository.routing_epoch !== access.routing_epoch) return null;
    if (ownerId && repository.owner_id !== ownerId || state && repository.state !== state || !state && repository.state === 'deleted') return null;
    if (visibility !== undefined && repository.visibility !== visibility) return null;
    if (repository.visibility === 'unlisted' && !access.matched_grants.some(grant => grant.effect === 'allow' && grant.source !== 'visibility')) return null;
    if (!principal && !['active', 'archived'].includes(repository.state)) return null;
    return publicRepository(c, repository);
  }));
  const items = evaluated.filter(value => value !== null);
  return listResponse(c, items, rows.length > limit ? encodeCursor({ id: rows[limit - 1]!.id }) : null);
}

export function registerCatalogRoutes(app: App): void {
  route(app, 'GET', '/v1/repos', { summary: 'List discoverable and explicitly accessible repositories', tags: ['repositories'], public: true, parameters: [visibilityParameter] }, async c => listCatalog(c));
  route(app, 'GET', '/v1/users/:id/repos', { summary: 'List a visible user profile’s repositories', tags: ['repositories'], public: true, parameters: [visibilityParameter] }, async c => {
    const user = await one<{ id: string; profile_visibility: string; email_verified_at: string | null }>(identityDatabase(c),
      'SELECT id,profile_visibility,email_verified_at FROM users WHERE id=? AND disabled_at IS NULL', c.req.param('id'));
    if (!user || user.id !== c.get('principal')?.user_id && (user.profile_visibility !== 'public' || user.email_verified_at === null)) throw new ApiError(404, 'not_found', 'The requested profile was not found.');
    return listCatalog(c, user.id);
  });
  route(app, 'GET', '/v1/orgs/:id/repos', { summary: 'List organization repositories visible to the caller', tags: ['repositories'], public: true, parameters: [visibilityParameter] }, async c => listCatalog(c, c.req.param('id')));

  route(app, 'POST', '/v1/repos', { summary: 'Create, import, or fork a repository asynchronously', tags: ['repositories'], body: createSchema, capability: 'repositories.create',
    idempotency: { recover: async (_c, record) => record.repo_id ? `/v1/repos/${record.repo_id}` : null } }, async c => {
    const principal = requirePrincipal(c);
    const body = await jsonBody(c, createSchema);
    await identityRateLimit(c, 'repository_create', principal.id);
    const authorizations: PermissionExplanation[] = [await authorize(c, 'repositories.create', { account_id: body.owner_id })];
    const account = await one<AccountRecord>(identityDatabase(c), 'SELECT * FROM accounts WHERE id=? AND disabled_at IS NULL', body.owner_id);
    if (!account) throw new ApiError(404, 'not_found', 'The repository owner was not found.');
    const source = body.fork_source_id ? await getRepository(c, body.fork_source_id, 'contents.read') : null;
    if (source) authorizations.push(await authorize(c, 'contents.read', { repo_id: source.id }));
    if (source && source.state !== 'active' && source.state !== 'archived') throw new ApiError(409, 'fork_source_unavailable', 'Wait for the source repository operation to complete.');
    if (body.import?.source_secret_id) authorizations.push(await authorize(c, 'secrets.use', { account_id: account.id }));
    const { policy } = await readAccountPolicy(identityDatabase(c), account.id);
    const visibility = body.visibility ?? (body.workspace || source && source.visibility !== 'public' ? 'private' : policy.default_repository_visibility);
    if (body.workspace && visibility !== 'private') throw new ApiError(422, 'private_workspace_required', 'Task workspaces are private repositories.');
    await enforceVisibility(c, account, visibility, source);
    const id = newId('r');
    const timestamp = now();
    const location = requestDatabaseLocation(c);
    const repository: Repository = { id, owner_id: account.id, name: body.name, slug: body.name.toLowerCase(), description: body.description,
      visibility, default_branch: body.default_branch, state: 'provisioning', revision: 1, policy_revision: 1, routing_epoch: 1,
      cell_id: location.cell_id, shard_id: location.shard_id, storage_name: `gk_${id}`, fork_source_id: source?.id ?? null,
      created_by: principal.id, created_at: timestamp, updated_at: timestamp, deleted_at: null, recovery_until: null };
    const kind = source ? 'fork' : body.import ? 'import' : 'provision';
    const prepared = prepareRepositoryOperation(c, repository, kind, { desired_state: 'active', input: {
      ...(source ? { source_repo_id: source.id } : {}), ...(body.import ?? {}), workspace: body.workspace,
    } });
    const quotas = limits(c.env);
    await withAccountAuthorityBarrier(c, account.id, 'repository.create', async () => commitIdentity(c, [
      stmt(database(c), `INSERT INTO repositories(id,owner_id,name,slug,description,visibility,default_branch,state,cell_id,shard_id,storage_name,fork_source_id,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'provisioning',?,?,?,?,?,?,?)`, repository.id, repository.owner_id, repository.name, repository.slug, repository.description,
      repository.visibility, repository.default_branch, repository.cell_id, repository.shard_id, repository.storage_name, repository.fork_source_id, repository.created_by, timestamp, timestamp),
      stmt(database(c), `INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,epoch,state,updated_at) VALUES (?,'repository',?,?,1,'active',?)`, id, repository.cell_id, repository.shard_id, timestamp),
      stmt(database(c), 'INSERT INTO storage_quotas(scope_id,limit_bytes,updated_at) VALUES (?,?,?) ON CONFLICT(scope_id) DO NOTHING', id, quotas.repository_storage_bytes, timestamp),
      stmt(database(c), 'INSERT INTO storage_quotas(scope_id,limit_bytes,updated_at) VALUES (?,?,?) ON CONFLICT(scope_id) DO NOTHING', account.id, quotas.account_storage_bytes, timestamp),
      ...(account.type === 'organization' ? [stmt(database(c), `INSERT INTO access_grants(id,account_id,repo_id,principal_type,principal_id,role_id,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`, newId('grant'), account.id, id, principal.kind, principal.id, policy.default_repository_creator_role, principal.id, timestamp, timestamp)] : []),
      ...(source ? [stmt(database(c), "INSERT INTO repository_retention_pins(id,repo_id,source_repo_id,kind,created_at) VALUES (?,?,?,'fork',?)", `pin_${id}`, id, source.id, timestamp)] : []),
      ...prepared.statements,
    ], { type: 'operation.requested', resource_id: prepared.operation.id, resource_revision: 1, repo_id: id, account_id: account.id,
      data: { kind: prepared.operation.kind } }, { authorizations, events: [{ type: 'repository.created', resource_id: id, resource_revision: 1,
        repo_id: id, account_id: account.id, data: { state: 'provisioning', visibility, operation_id: prepared.operation.id } }] }));
    operationResponse(c, prepared.operation);
    return revisionResponse(c, { ...await publicRepository(c, repository), operation: prepared.operation, revision: 1 }, 202);
  });

  route(app, 'GET', '/v1/repos/resolve/:owner/:name', { summary: 'Resolve a current or historical GitKnot repository path', tags: ['repositories'], public: true }, async c => {
    const owner = c.req.param('owner');
    const name = c.req.param('name')!.replace(/\.git$/, '');
    const primary = identityDatabase(c);
    const current = await one<{ id: string }>(primary, 'SELECT r.id FROM repositories r JOIN accounts a ON a.id=r.owner_id WHERE a.slug=? COLLATE NOCASE AND r.slug=? COLLATE NOCASE', owner, name);
    const alias = current ?? await one<{ id: string }>(primary, 'SELECT repo_id AS id FROM repository_aliases WHERE owner_slug=? COLLATE NOCASE AND repository_slug=? COLLATE NOCASE', owner, name);
    let id = alias?.id;
    // A name changed after movement may not be present in the retained hint.
    // Look through the owner's bounded, paginated enrollment set using live rows.
    if (!id) {
      const account = await one<{ id: string }>(primary, 'SELECT id FROM accounts WHERE slug=? COLLATE NOCASE AND disabled_at IS NULL', owner);
      let after = '';
      while (account && !id) {
        const candidates = await many<{ id: string }>(primary, `SELECT repo_id AS id FROM account_authority_repositories
          WHERE account_id=? AND repo_id>? GROUP BY repo_id ORDER BY repo_id LIMIT 100`, account.id, after);
        if (!candidates.length) break;
        const live = await Promise.all(candidates.map(row => readRepositoryAuthority(c, row.id)));
        id = live.find(row => row?.owner_id === account.id && row.slug.toLowerCase() === name.toLowerCase())?.id;
        after = candidates.at(-1)!.id;
      }
    }
    if (!id) throw new ApiError(404, 'not_found', 'The requested repository was not found.');
    const repository = await getRepository(c, id, 'repositories.read');
    return revisionResponse(c, await publicRepository(c, repository));
  });

  route(app, 'GET', '/v1/repos/:id', { summary: 'Read current repository catalog metadata', tags: ['repositories'], public: true, capability: 'repositories.read' }, async c => {
    const repository = await getRepository(c, c.req.param('id'), 'repositories.read');
    return revisionResponse(c, await publicRepository(c, repository));
  });

  route(app, 'PATCH', '/v1/repos/:id', { summary: 'Update repository name, visibility, description, or default branch', tags: ['repositories'], body: patchSchema, capability: 'repositories.manage' }, async c => {
    const repository = await getRepository(c, c.req.param('id'), 'repositories.manage');
    const authorization = await authorize(c, 'repositories.manage', { repo_id: repository.id });
    const body = await jsonBody(c, patchSchema);
    const revision = expectedRevision(c);
    if (!['active', 'archived'].includes(repository.state)) throw new ApiError(409, 'repository_busy', 'Wait for the repository operation to finish before editing its settings.');
    const account = await one<AccountRecord>(identityDatabase(c), 'SELECT * FROM accounts WHERE id=?', repository.owner_id);
    const source = repository.fork_source_id ? await readRepositoryAuthority(c, repository.fork_source_id) : null;
    await enforceVisibility(c, account!, body.visibility ?? repository.visibility, source);
    const timestamp = now();
    const name = body.name ?? repository.name;
    await withRepositoryBarrier(c, repository.id, 'repository.settings', async () => commitIdentity(c, [
      ...checkedWrite(database(c), stmt(database(c), `UPDATE repositories SET name=?,slug=?,description=?,visibility=?,default_branch=?,revision=revision+1,
        policy_revision=policy_revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND state IN ('active','archived')`,
      name, name.toLowerCase(), body.description ?? repository.description, body.visibility ?? repository.visibility, body.default_branch ?? repository.default_branch,
      timestamp, repository.id, repository.owner_id, revision)),
      ...(name.toLowerCase() === repository.slug ? [] : [stmt(database(c), 'INSERT INTO repository_aliases(owner_slug,repository_slug,repo_id,created_at) VALUES (?,?,?,?) ON CONFLICT(owner_slug,repository_slug) DO NOTHING',
        account!.slug, repository.slug, repository.id, timestamp)]),
    ], { type: 'repository.updated', resource_id: repository.id, resource_revision: revision + 1, repo_id: repository.id, account_id: repository.owner_id,
      data: { visibility: body.visibility ?? repository.visibility, previous_visibility: repository.visibility, policy_revision: repository.policy_revision + 1 } }, { authorizations: [authorization] }));
    return revisionResponse(c, await publicRepository(c, { ...repository, ...body, name, slug: name.toLowerCase(), revision: revision + 1,
      policy_revision: repository.policy_revision + 1, updated_at: timestamp }));
  });
}
