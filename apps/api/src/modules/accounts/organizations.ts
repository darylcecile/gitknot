import { z } from 'zod';
import { identityDatabase as database, readRepositoryAuthority } from '@gitknot/core/authority';
import { ApiError, accountPolicySchema, authorize, expectedRevision, explainAuthorization, jsonBody, listResponse, many, newId, now, one, page, requirePrincipal, route, stmt,
  type AccountRecord, type App, type AppContext } from '@gitknot/core';
import { checkedWrite, requireHuman } from '@gitknot/core/auth';
import { commitIdentity, revisionResponse, usernameSchema } from '../identity/shared.ts';
import { accountAccess, publicAccount } from './shared.ts';

const createSchema = z.object({ slug: usernameSchema, name: z.string().trim().min(1).max(100), description: z.string().max(1000).default('') }).strict();
const updateSchema = z.object({ slug: usernameSchema.optional(), name: z.string().trim().min(1).max(100).optional(), description: z.string().max(1000).optional() }).strict()
  .refine(value => Object.keys(value).length > 0, 'Supply at least one account field.');

async function assertEmptyOrganization(c: AppContext, accountId: string): Promise<void> {
  const candidates = await many<{ id: string }>(database(c), `SELECT id FROM repositories WHERE owner_id=?
    UNION SELECT repo_id AS id FROM account_authority_repositories WHERE account_id=?`, accountId, accountId);
  for (const candidate of candidates) {
    if ((await readRepositoryAuthority(c, candidate.id))?.owner_id === accountId) {
      throw new ApiError(409, 'repositories_remaining', 'Transfer repositories or finish their recovery and purge lifecycle before disabling this organization.');
    }
  }
}

export function registerOrganizationRoutes(app: App): void {
  route(app, 'POST', '/v1/orgs', { summary: 'Create an organization owned by your GitKnot account', tags: ['organizations'], body: createSchema, capability: 'accounts.manage' }, async c => {
    const user = await requireHuman(c, { recent: true });
    const body = await jsonBody(c, createSchema);
    const authorization = await authorize(c, 'accounts.manage', { account_id: user.id });
    const id = newId('org');
    const timestamp = now();
    const account: AccountRecord = { id, type: 'organization', slug: body.slug, name: body.name, description: body.description,
      owner_user_id: null, disabled_at: null, revision: 1, policy_revision: 1, created_at: timestamp, updated_at: timestamp };
    await commitIdentity(c, [
      stmt(database(c), "INSERT INTO accounts(id,type,slug,name,description,initial_seat_principal_id,created_at,updated_at) VALUES (?,'organization',?,?,?,?,?,?)", id, body.slug, body.name, body.description, user.id, timestamp, timestamp),
      stmt(database(c), "INSERT INTO memberships(account_id,principal_id,role_id,state,created_by,created_at,updated_at) VALUES (?,?,'owner','active',?,?,?)", id, user.id, user.id, timestamp, timestamp),
      stmt(database(c), 'INSERT INTO account_policies(account_id,config_json,updated_by,updated_at) VALUES (?,?,?,?)', id, JSON.stringify(accountPolicySchema.parse({})), user.id, timestamp),
    ], { type: 'organization.created', resource_id: id, resource_revision: 1, account_id: id }, { authorizations: [authorization] });
    c.header('location', `/v1/orgs/${id}`);
    return revisionResponse(c, publicAccount(account), 201);
  });

  route(app, 'GET', '/v1/orgs', { summary: 'List your organizations', tags: ['organizations'] }, async c => {
    const principal = requirePrincipal(c);
    const { limit, cursor } = page(c);
    const rows = await many<AccountRecord>(database(c), `SELECT a.* FROM accounts a JOIN memberships m ON m.account_id=a.id
      WHERE m.principal_id=? AND m.state='active' AND a.type='organization' AND a.disabled_at IS NULL AND a.id>?
      ORDER BY a.id LIMIT ?`, principal.id, cursor ?? '', limit + 1);
    const visible: AccountRecord[] = [];
    for (const account of rows.slice(0, limit)) if ((await explainAuthorization(c, 'accounts.read', { account_id: account.id })).allowed) visible.push(account);
    return listResponse(c, visible.map(publicAccount), rows.length > limit ? rows[limit - 1]!.id : null);
  });

  route(app, 'GET', '/v1/accounts/:id', { summary: 'Read an authorized account', tags: ['accounts'], capability: 'accounts.read' }, async c => {
    const { account } = await accountAccess(c, c.req.param('id'), 'accounts.read');
    return revisionResponse(c, publicAccount(account));
  });

  route(app, 'GET', '/v1/orgs/:id', { summary: 'Read an organization', tags: ['organizations'], capability: 'accounts.read' }, async c => {
    const { account } = await accountAccess(c, c.req.param('id'), 'accounts.read', true);
    return revisionResponse(c, publicAccount(account));
  });

  route(app, 'PATCH', '/v1/orgs/:id', { summary: 'Update an organization profile', tags: ['organizations'], body: updateSchema, capability: 'accounts.manage' }, async c => {
    const { account, authorization } = await accountAccess(c, c.req.param('id'), 'accounts.manage', true);
    const body = await jsonBody(c, updateSchema);
    const revision = expectedRevision(c);
    const slug = body.slug ?? account.slug;
    const timestamp = now();
    await commitIdentity(c, [
      ...(slug === account.slug ? [] : [
        stmt(database(c), 'INSERT INTO account_aliases(slug,account_id,created_at) VALUES (?,?,?) ON CONFLICT(slug) DO NOTHING', account.slug, account.id, timestamp),
        stmt(database(c), `INSERT INTO repository_aliases(owner_slug,repository_slug,repo_id,created_at) SELECT ?,slug,id,? FROM repositories
          WHERE owner_id=? ON CONFLICT(owner_slug,repository_slug) DO NOTHING`, account.slug, timestamp, account.id),
      ]),
      ...checkedWrite(database(c), stmt(database(c), 'UPDATE accounts SET slug=?,name=?,description=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?',
        slug, body.name ?? account.name, body.description ?? account.description, timestamp, account.id, revision)),
    ], { type: 'organization.updated', resource_id: account.id, resource_revision: revision + 1, account_id: account.id,
      data: { slug } }, { authorizations: [authorization] });
    return revisionResponse(c, publicAccount({ ...account, ...body, slug, revision: revision + 1, updated_at: timestamp }));
  });

  route(app, 'DELETE', '/v1/orgs/:id', { summary: 'Disable an empty organization', tags: ['organizations'], capability: 'accounts.delete' }, async c => {
    await requireHuman(c, { recent: true, independent: true });
    const { account, authorization } = await accountAccess(c, c.req.param('id'), 'accounts.delete', true);
    await authorize(c, 'owners.manage', { account_id: account.id });
    const revision = expectedRevision(c);
    await assertEmptyOrganization(c, account.id);
    await commitIdentity(c, [...checkedWrite(database(c), stmt(database(c),
      'UPDATE accounts SET disabled_at=?,policy_revision=policy_revision+1,revision=revision+1,updated_at=? WHERE id=? AND revision=?', now(), now(), account.id, revision)),
    stmt(database(c), 'UPDATE principals SET disabled_at=?,revision=revision+1,updated_at=? WHERE account_id=? AND kind!=\'user\'', now(), now(), account.id),
    stmt(database(c), "UPDATE invitations SET state='revoked',revision=revision+1,updated_at=? WHERE account_id=? AND state='pending'", now(), account.id)],
    { type: 'organization.disabled', resource_id: account.id, resource_revision: revision + 1, account_id: account.id },
    { authorizations: [authorization], before_commit: () => assertEmptyOrganization(c, account.id) });
    return c.body(null, 204);
  });
}
