import { z } from 'zod';
import { database } from '@gitknot/core/db';
import { identityDatabase } from '@gitknot/core/authority';
import { ApiError, authorize, canonicalJson, capabilityPatternSchema, expectedRevision, explainAuthorization, getRepository, jsonBody, listResponse, many,
  newId, now, one, page, principalForExplanation, readAccountPolicy, requirePrincipal, route, sha256, stmt,
  type App, type AppContext, type Principal, type Repository } from '@gitknot/core';
import { checkedWrite, credentialScope, requireHuman, type CredentialRecord } from '@gitknot/core/auth';
import { alreadyHasSeat, seatRemovalStatements } from '../accounts/billing.ts';
import { grantSchema, publicGrant, validateGrant, type GrantRecord } from '../accounts/roles-policy.ts';
import { bumpAccountPolicy } from '../accounts/shared.ts';
import { commitIdentity, idSchema, revisionResponse } from '../identity/shared.ts';
import { effectiveRepositoryRules, ruleObligations } from './rules.ts';
import { withRepositoryBarrier } from './shared.ts';

const explainSchema = z.object({ capability: capabilityPatternSchema.refine(value => !value.includes('*'), 'Explain a concrete capability.').default('contents.read'),
  principal_id: idSchema.optional(), credential_id: idSchema.optional(), ref: z.string().min(1).max(1024).optional(),
  paths: z.array(z.string().min(1).max(4096)).max(1000).optional() }).strict();
const reviewSchema = z.object({ note: z.string().trim().min(1).max(2000) }).strict();

async function reviewSnapshot(c: AppContext, repo: Repository) {
  const [grants, memberships, teamMembers] = await Promise.all([
    many(identityDatabase(c), 'SELECT id,principal_type,principal_id,role_id,capability,effect,conditions_json,expires_at,revision FROM access_grants WHERE account_id=? AND (repo_id=? OR repo_id IS NULL) AND revoked_at IS NULL ORDER BY id', repo.owner_id, repo.id),
    many(identityDatabase(c), "SELECT principal_id,role_id,state,revision FROM memberships WHERE account_id=? AND state='active' ORDER BY principal_id", repo.owner_id),
    many(identityDatabase(c), `SELECT team_id,principal_id,role,revision FROM team_members WHERE account_id=? AND team_id IN (
      SELECT principal_id FROM access_grants WHERE account_id=? AND (repo_id=? OR repo_id IS NULL) AND principal_type='team' AND revoked_at IS NULL) ORDER BY team_id,principal_id`, repo.owner_id, repo.owner_id, repo.id),
  ]);
  return { grants, memberships, team_members: teamMembers };
}

async function explain(c: AppContext, body: z.infer<typeof explainSchema>): Promise<Response> {
  const repo = await getRepository(c, c.req.param('id'), 'repositories.read');
  const caller = c.get('principal');
  let principal = caller;
  if (body.principal_id && body.principal_id !== caller?.id) {
    await authorize(c, 'permissions.explain', { repo_id: repo.id });
    principal = await principalForExplanation(identityDatabase(c), body.principal_id);
    if (!principal) throw new ApiError(404, 'not_found', 'The requested principal was not found.');
  }
  if (body.credential_id) {
    const credential = await one<CredentialRecord>(identityDatabase(c), 'SELECT * FROM credentials WHERE id=?', body.credential_id);
    if (!credential || body.principal_id && credential.principal_id !== body.principal_id) throw new ApiError(404, 'not_found', 'The requested credential was not found.');
    if (credential.principal_id !== caller?.id) await authorize(c, 'permissions.explain', { repo_id: repo.id });
    const owner = await principalForExplanation(identityDatabase(c), credential.principal_id);
    if (!owner) throw new ApiError(404, 'not_found', 'The requested credential was not found.');
    principal = { ...owner, credential_id: credential.id, capabilities: credentialScope(credential.capabilities_json), repository_ids: credentialScope(credential.repository_ids_json),
      account_ids: credentialScope(credential.account_ids_json), mfa: credential.mfa === 1 } satisfies Principal;
  }
  const result = await explainAuthorization(c, body.capability, { repo_id: repo.id, ref: body.ref, paths: body.paths }, principal);
  const rules = await effectiveRepositoryRules(c, repo);
  return c.json({ ...result, branch_rules: ruleObligations(rules, body), publication_requires_current_native_evidence: true });
}

function bumpRepositoryPolicy(c: AppContext, repo: Repository): D1PreparedStatement[] {
  return [bumpAccountPolicy(c, repo.owner_id)];
}

async function requireCollaboratorConsent(c: AppContext, repo: Repository, body: z.infer<typeof grantSchema>): Promise<void> {
  if (body.principal_type !== 'user' || body.effect === 'deny') return;
  if (!await alreadyHasSeat(c, repo.owner_id, body.principal_id)) throw new ApiError(422, 'invitation_required', 'Invite this outside collaborator so they can accept access and review the seat cost.');
  const { policy } = await readAccountPolicy(identityDatabase(c), repo.owner_id);
  if (!policy.allow_outside_collaborators && !await one(identityDatabase(c), "SELECT 1 FROM memberships WHERE account_id=? AND principal_id=? AND state='active'", repo.owner_id, body.principal_id)) {
    throw new ApiError(403, 'outside_collaborators_disabled', 'Account policy does not permit outside collaborators.');
  }
  if (repo.fork_source_id) {
    const principal = await principalForExplanation(identityDatabase(c), body.principal_id);
    if (!principal || !(await explainAuthorization(c, 'contents.read', { repo_id: repo.fork_source_id }, { ...principal, mfa: true })).allowed) {
      throw new ApiError(422, 'fork_source_access_required', 'A restricted fork collaborator must remain in the source repository audience.');
    }
  }
}

export function registerRepositoryPermissionRoutes(app: App): void {
  route(app, 'POST', '/v1/repos/:id/permissions/explain', { summary: 'Explain effective repository permission and branch obligations', tags: ['permissions'], body: explainSchema, public: true }, async c => explain(c, await jsonBody(c, explainSchema)));
  route(app, 'GET', '/v1/repos/:id/permissions/explain', { summary: 'Explain the caller’s effective repository capability', tags: ['permissions'], public: true }, async c => {
    const result = explainSchema.safeParse({ capability: c.req.query('capability') ?? 'contents.read', ...(c.req.query('ref') ? { ref: c.req.query('ref') } : {}) });
    if (!result.success) throw new ApiError(422, 'invalid_permission_query', 'Supply a concrete capability and optional full ref.');
    return explain(c, result.data);
  });

  route(app, 'GET', '/v1/repos/:id/collaborators', { summary: 'List explicit repository collaborators and denials', tags: ['permissions'], capability: 'permissions.read' }, async c => {
    const repo = await getRepository(c, c.req.param('id'), 'permissions.read');
    const { limit, cursor } = page(c);
    const rows = await many<GrantRecord>(identityDatabase(c), 'SELECT * FROM access_grants WHERE repo_id=? AND account_id=? AND revoked_at IS NULL AND id>? ORDER BY id LIMIT ?', repo.id, repo.owner_id, cursor ?? '', limit + 1);
    return listResponse(c, rows.slice(0, limit).map(publicGrant), rows.length > limit ? rows[limit - 1]!.id : null);
  });

  route(app, 'POST', '/v1/repos/:id/collaborators', { summary: 'Grant a current member or identity scoped repository access', tags: ['permissions'], body: grantSchema, capability: 'permissions.manage' }, async c => {
    const repo = await getRepository(c, c.req.param('id'), 'permissions.manage');
    const authorization = await authorize(c, 'permissions.manage', { repo_id: repo.id });
    const body = await jsonBody(c, grantSchema);
    await validateGrant(c, body, { account_id: repo.owner_id, repo_id: repo.id });
    await requireCollaboratorConsent(c, repo, body);
    const id = newId('grant');
    const timestamp = now();
    await withRepositoryBarrier(c, repo.id, 'repository.collaborator_create', async () => commitIdentity(c, [stmt(identityDatabase(c),
      'INSERT INTO access_grants(id,account_id,repo_id,principal_type,principal_id,role_id,capability,effect,conditions_json,expires_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, repo.owner_id, repo.id, body.principal_type, body.principal_id, body.role_id ?? null, body.capability ?? null, body.effect,
      JSON.stringify(body.conditions), body.expires_at, requirePrincipal(c).id, timestamp, timestamp), ...bumpRepositoryPolicy(c, repo)],
    { type: 'repository.collaborator_added', resource_id: id, resource_revision: 1, repo_id: repo.id, account_id: repo.owner_id,
      data: { principal_id: body.principal_id, effect: body.effect } }, { authorizations: [authorization] }));
    return revisionResponse(c, { id, repo_id: repo.id, account_id: repo.owner_id, ...body, revision: 1, created_at: timestamp, updated_at: timestamp }, 201);
  });

  route(app, 'PUT', '/v1/repos/:id/collaborators/:grantId', { summary: 'Replace a collaborator’s scoped grant', tags: ['permissions'], body: grantSchema, capability: 'permissions.manage' }, async c => {
    const repo = await getRepository(c, c.req.param('id'), 'permissions.manage');
    const authorization = await authorize(c, 'permissions.manage', { repo_id: repo.id });
    const body = await jsonBody(c, grantSchema);
    const revision = expectedRevision(c);
    const existing = await one<GrantRecord>(identityDatabase(c), 'SELECT * FROM access_grants WHERE id=? AND repo_id=? AND account_id=? AND revoked_at IS NULL', c.req.param('grantId'), repo.id, repo.owner_id);
    if (!existing) throw new ApiError(404, 'not_found', 'The requested collaborator grant was not found.');
    if (existing.principal_id !== body.principal_id || existing.principal_type !== body.principal_type) throw new ApiError(422, 'grant_principal_immutable', 'Create a new grant when changing its principal.');
    await validateGrant(c, body, { account_id: repo.owner_id, repo_id: repo.id });
    await requireCollaboratorConsent(c, repo, body);
    await withRepositoryBarrier(c, repo.id, 'repository.collaborator_update', async () => commitIdentity(c, [...checkedWrite(identityDatabase(c), stmt(identityDatabase(c),
      'UPDATE access_grants SET role_id=?,capability=?,effect=?,conditions_json=?,expires_at=?,revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND account_id=? AND revision=? AND revoked_at IS NULL',
      body.role_id ?? null, body.capability ?? null, body.effect, JSON.stringify(body.conditions), body.expires_at, now(), existing.id, repo.id, repo.owner_id, revision)), ...bumpRepositoryPolicy(c, repo)],
    { type: 'repository.collaborator_updated', resource_id: existing.id, resource_revision: revision + 1, repo_id: repo.id, account_id: repo.owner_id }, { authorizations: [authorization] }));
    return revisionResponse(c, { ...publicGrant({ ...existing, role_id: body.role_id ?? null, capability: body.capability ?? null, effect: body.effect,
      conditions_json: JSON.stringify(body.conditions), expires_at: body.expires_at, revision: revision + 1, updated_at: now() }), revision: revision + 1 });
  });

  route(app, 'DELETE', '/v1/repos/:id/collaborators/:grantId', { summary: 'Revoke a collaborator grant or explicit denial', tags: ['permissions'], capability: 'permissions.manage' }, async c => {
    const repo = await getRepository(c, c.req.param('id'), 'permissions.manage');
    const authorization = await authorize(c, 'permissions.manage', { repo_id: repo.id });
    const revision = expectedRevision(c);
    const grant = await one<GrantRecord>(identityDatabase(c), 'SELECT * FROM access_grants WHERE id=? AND repo_id=? AND account_id=? AND revoked_at IS NULL', c.req.param('grantId'), repo.id, repo.owner_id);
    if (!grant) throw new ApiError(404, 'not_found', 'The requested collaborator grant was not found.');
    const otherAccess = await one(identityDatabase(c), `SELECT 1 FROM memberships WHERE account_id=? AND principal_id=? AND state='active' UNION ALL
      SELECT 1 FROM access_grants WHERE account_id=? AND principal_id=? AND id!=? AND effect='allow' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?) LIMIT 1`,
    repo.owner_id, grant.principal_id, repo.owner_id, grant.principal_id, grant.id, now());
    const seats = grant.effect === 'allow' && grant.principal_type === 'user' && !otherAccess ? await seatRemovalStatements(c, repo.owner_id, grant.principal_id) : [];
    await withRepositoryBarrier(c, repo.id, 'repository.collaborator_revoke', async () => commitIdentity(c, [...checkedWrite(identityDatabase(c), stmt(identityDatabase(c),
      'UPDATE access_grants SET revoked_at=?,revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND account_id=? AND revision=? AND revoked_at IS NULL', now(), now(), grant.id, repo.id, repo.owner_id, revision)),
    ...seats, ...bumpRepositoryPolicy(c, repo)], { type: 'repository.collaborator_removed', resource_id: grant.id, resource_revision: revision + 1, repo_id: repo.id, account_id: repo.owner_id,
      data: { principal_id: grant.principal_id } }, { authorizations: [authorization] }));
    return c.body(null, 204);
  });

  route(app, 'GET', '/v1/repos/:id/access-review', { summary: 'Inspect direct, organization, and team access together', tags: ['permissions'], capability: 'permissions.read' }, async c => {
    const repo = await getRepository(c, c.req.param('id'), 'permissions.read');
    const authorization = await authorize(c, 'permissions.read', { repo_id: repo.id });
    const snapshot = await reviewSnapshot(c, repo);
    return revisionResponse(c, { repo_id: repo.id, policy_revision: repo.policy_revision, account_policy_revision: authorization.account_policy_revision,
      snapshot, snapshot_sha256: await sha256(canonicalJson(snapshot)), revision: repo.revision });
  });
  route(app, 'POST', '/v1/repos/:id/access-reviews', { summary: 'Record a revision-bound repository access review', tags: ['permissions'], body: reviewSchema, capability: 'permissions.manage' }, async c => {
    const user = await requireHuman(c, { recent: true });
    const repo = await getRepository(c, c.req.param('id'), 'permissions.manage');
    const authorization = await authorize(c, 'permissions.manage', { repo_id: repo.id });
    const body = await jsonBody(c, reviewSchema);
    const revision = expectedRevision(c);
    const snapshot = await reviewSnapshot(c, repo);
    const digest = await sha256(canonicalJson(snapshot));
    const id = newId('access_review');
    await commitIdentity(c, [...checkedWrite(database(c), stmt(database(c), 'UPDATE repositories SET revision=revision+1,updated_at=? WHERE id=? AND revision=? AND policy_revision=?', now(), repo.id, revision, repo.policy_revision)),
      stmt(database(c), 'INSERT INTO repository_access_reviews(id,repo_id,account_id,reviewer_id,policy_revision,account_policy_revision,snapshot_sha256,snapshot_json,note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        id, repo.id, repo.owner_id, user.id, repo.policy_revision, authorization.account_policy_revision, digest, canonicalJson(snapshot), body.note, now())],
    { type: 'repository.access_reviewed', resource_id: id, resource_revision: 1, repo_id: repo.id, account_id: repo.owner_id }, { authorizations: [authorization] });
    return revisionResponse(c, { id, repo_id: repo.id, reviewer_id: user.id, policy_revision: repo.policy_revision,
      account_policy_revision: authorization.account_policy_revision, snapshot_sha256: digest, note: body.note, revision: 1 }, 201);
  });
  route(app, 'GET', '/v1/repos/:id/access-reviews', { summary: 'List repository access-review history', tags: ['permissions'], capability: 'permissions.read' }, async c => {
    const repo = await getRepository(c, c.req.param('id'), 'permissions.read');
    const { limit, cursor } = page(c);
    const rows = await many<{ id: string }>(database(c), 'SELECT id,repo_id,account_id,reviewer_id,policy_revision,account_policy_revision,snapshot_sha256,note,revision,created_at FROM repository_access_reviews WHERE repo_id=? AND id>? ORDER BY id LIMIT ?', repo.id, cursor ?? '', limit + 1);
    return listResponse(c, rows.slice(0, limit), rows.length > limit ? rows[limit - 1]!.id : null);
  });
}
