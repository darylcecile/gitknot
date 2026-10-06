import { z } from 'zod';
import { identityDatabase as database } from '@gitknot/core/authority';
import { ApiError, authorize, expectedRevision, explainAuthorization, jsonBody, listResponse, many, newId, now, one, page, requirePrincipal, route, stmt,
  type App, type AppContext, type PermissionExplanation } from '@gitknot/core';
import { checkedWrite, requireHuman } from '@gitknot/core/auth';
import { commitIdentity, idSchema, revisionResponse, usernameSchema } from '../identity/shared.ts';
import { accountAccess, assertDelegable, bumpAccountPolicy, guardOwnerDenial, requireOwnerAssignment, scopedRole, type MembershipRecord } from './shared.ts';
import { seatRemovalStatements } from './billing.ts';

const membershipSchema = z.object({ role_id: z.string().min(1).max(128).optional(), state: z.enum(['active', 'suspended']).optional() }).strict()
  .refine(value => Object.keys(value).length > 0, 'Supply a role or membership state.');
const teamSchema = z.object({ slug: usernameSchema, name: z.string().trim().min(1).max(100), description: z.string().max(1000).default(''),
  visibility: z.enum(['members', 'secret']).default('members') }).strict();
const teamPatchSchema = z.object({ slug: usernameSchema.optional(), name: z.string().trim().min(1).max(100).optional(), description: z.string().max(1000).optional(),
  visibility: z.enum(['members', 'secret']).optional() }).strict().refine(value => Object.keys(value).length > 0, 'Supply at least one team field.');
const teamMemberSchema = z.object({ principal_id: idSchema, role: z.enum(['member', 'maintainer']).default('member') }).strict();
const teamMemberPatchSchema = z.object({ role: z.enum(['member', 'maintainer']) }).strict();

interface Team { id: string; account_id: string; slug: string; name: string; description: string; visibility: 'members' | 'secret'; revision: number; created_by: string; created_at: string; updated_at: string }

async function getTeam(c: AppContext): Promise<Team> {
  const team = await one<Team>(database(c), 'SELECT * FROM teams WHERE id=? AND account_id=?', c.req.param('teamId'), c.req.param('id'));
  if (!team) throw new ApiError(404, 'not_found', 'The requested team was not found.');
  return team;
}

async function teamAccess(c: AppContext, team: Team, manage: boolean): Promise<PermissionExplanation> {
  const capability = manage ? 'teams.manage' : 'teams.read';
  const explanation = await explainAuthorization(c, capability, { account_id: team.account_id });
  const membership = await one<{ role: string }>(database(c), `SELECT tm.role FROM team_members tm JOIN memberships m
    ON m.account_id=tm.account_id AND m.principal_id=tm.principal_id WHERE tm.team_id=? AND tm.account_id=? AND tm.principal_id=? AND m.state='active'`,
  team.id, team.account_id, requirePrincipal(c).id);
  if (manage && !explanation.allowed && membership?.role === 'maintainer' && explanation.reasons.every(reason => reason.code === 'no_matching_grant')) {
    return { ...explanation, allowed: true, reasons: [{ code: 'allowed', message: 'A current team maintainer may manage this team.' }],
      matched_grants: [{ id: `team:${team.id}:maintainer`, source: 'grant', capability, effect: 'allow' }] };
  }
  if (!explanation.allowed) throw new ApiError(404, 'not_found', 'The requested team was not found.');
  if (!manage && team.visibility === 'secret' && !membership && !(await explainAuthorization(c, 'teams.manage', { account_id: team.account_id })).allowed) {
    throw new ApiError(404, 'not_found', 'The requested team was not found.');
  }
  return explanation;
}

export function registerMembershipRoutes(app: App): void {
  route(app, 'GET', '/v1/orgs/:id/members', { summary: 'List current organization memberships', tags: ['organizations'], capability: 'members.read' }, async c => {
    const { account } = await accountAccess(c, c.req.param('id'), 'members.read', true);
    const { limit, cursor } = page(c);
    const rows = await many<MembershipRecord & { name: string; username: string | null; kind: string }>(database(c),
      `SELECT m.*,p.name,p.kind,u.username FROM memberships m JOIN principals p ON p.id=m.principal_id LEFT JOIN users u ON u.id=p.user_id
       WHERE m.account_id=? AND m.principal_id>? ORDER BY m.principal_id LIMIT ?`, account.id, cursor ?? '', limit + 1);
    return listResponse(c, rows.slice(0, limit), rows.length > limit ? rows[limit - 1]!.principal_id : null);
  });
  route(app, 'GET', '/v1/orgs/:id/members/:principalId', { summary: 'Read an organization membership', tags: ['organizations'], capability: 'members.read' }, async c => {
    const { account } = await accountAccess(c, c.req.param('id'), 'members.read', true);
    const row = await one<MembershipRecord>(database(c), 'SELECT * FROM memberships WHERE account_id=? AND principal_id=?', account.id, c.req.param('principalId'));
    if (!row) throw new ApiError(404, 'not_found', 'The requested membership was not found.');
    return revisionResponse(c, { ...row });
  });

  route(app, 'PATCH', '/v1/orgs/:id/members/:principalId', { summary: 'Change a membership role or suspend its access', tags: ['organizations'], body: membershipSchema, capability: 'members.manage' }, async c => {
    const { account, authorization } = await accountAccess(c, c.req.param('id'), 'members.manage', true);
    const body = await jsonBody(c, membershipSchema);
    const revision = expectedRevision(c);
    const member = await one<MembershipRecord>(database(c), 'SELECT * FROM memberships WHERE account_id=? AND principal_id=?', account.id, c.req.param('principalId'));
    if (!member) throw new ApiError(404, 'not_found', 'The requested membership was not found.');
    if (member.state === 'suspended' && body.state === 'active') throw new ApiError(409, 'invitation_required', 'Issue a new invitation with a current seat quote to reactivate membership.');
    const roleId = body.role_id ?? member.role_id;
    const role = await scopedRole(c, roleId, account.id);
    if (role.repo_id) throw new ApiError(422, 'role_outside_scope', 'Repository-scoped roles cannot grant organization membership.');
    await assertDelegable(c, role.capabilities, { account_id: account.id });
    if (member.role_id === 'owner') { await requireHuman(c, { recent: true, independent: true }); await authorize(c, 'owners.manage', { account_id: account.id }); }
    await requireOwnerAssignment(c, roleId, member.principal_id, account.id);
    const state = body.state ?? member.state;
    if (member.role_id === 'owner' && (state !== 'active' || roleId !== 'owner')) {
      await guardOwnerDenial(c, account.id, 'user', member.principal_id, [{ capability: '*', effect: 'deny' }]);
    }
    const removed = member.state === 'active' && state === 'suspended';
    const seats = removed ? await seatRemovalStatements(c, account.id, member.principal_id) : [];
    await commitIdentity(c, [...checkedWrite(database(c), stmt(database(c),
      'UPDATE memberships SET role_id=?,state=?,revision=revision+1,updated_at=? WHERE account_id=? AND principal_id=? AND revision=?', roleId, state, now(), account.id, member.principal_id, revision)),
    ...(removed ? [stmt(database(c), 'UPDATE access_grants SET revoked_at=COALESCE(revoked_at,?),revision=revision+1,updated_at=? WHERE account_id=? AND principal_id=?', now(), now(), account.id, member.principal_id)] : []),
    ...seats, bumpAccountPolicy(c, account.id)], { type: 'membership.updated', resource_id: member.principal_id, resource_revision: revision + 1, account_id: account.id,
      data: { role_id: roleId, state } }, { authorizations: [authorization] });
    return revisionResponse(c, { ...member, role_id: roleId, state, revision: revision + 1, updated_at: now() });
  });

  route(app, 'DELETE', '/v1/orgs/:id/members/:principalId', { summary: 'Remove organization membership and inherited access', tags: ['organizations'], capability: 'members.manage' }, async c => {
    const { account, authorization } = await accountAccess(c, c.req.param('id'), 'members.manage', true);
    const revision = expectedRevision(c);
    const member = await one<MembershipRecord>(database(c), 'SELECT * FROM memberships WHERE account_id=? AND principal_id=?', account.id, c.req.param('principalId'));
    if (!member) throw new ApiError(404, 'not_found', 'The requested membership was not found.');
    if (member.role_id === 'owner') { await requireHuman(c, { recent: true, independent: true }); await authorize(c, 'owners.manage', { account_id: account.id }); }
    if (member.role_id === 'owner') await guardOwnerDenial(c, account.id, 'user', member.principal_id, [{ capability: '*', effect: 'deny' }]);
    const seats = member.state === 'active' ? await seatRemovalStatements(c, account.id, member.principal_id) : [];
    await commitIdentity(c, [...checkedWrite(database(c), stmt(database(c), 'DELETE FROM memberships WHERE account_id=? AND principal_id=? AND revision=?', account.id, member.principal_id, revision)),
      stmt(database(c), 'UPDATE access_grants SET revoked_at=COALESCE(revoked_at,?),revision=revision+1,updated_at=? WHERE account_id=? AND principal_id=?', now(), now(), account.id, member.principal_id),
      ...seats, bumpAccountPolicy(c, account.id)], { type: 'membership.removed', resource_id: member.principal_id, resource_revision: revision + 1, account_id: account.id }, { authorizations: [authorization] });
    return c.body(null, 204);
  });
}

export function registerTeamRoutes(app: App): void {
  route(app, 'GET', '/v1/orgs/:id/teams', { summary: 'List visible organization teams', tags: ['teams'], capability: 'teams.read' }, async c => {
    const { account } = await accountAccess(c, c.req.param('id'), 'teams.read', true);
    const { limit, cursor } = page(c);
    const admin = (await explainAuthorization(c, 'teams.manage', { account_id: account.id })).allowed;
    const rows = await many<Team>(database(c), `SELECT t.* FROM teams t WHERE t.account_id=? AND t.id>? AND
      (t.visibility='members' OR ?=1 OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id=t.id AND tm.principal_id=?)) ORDER BY t.id LIMIT ?`,
    account.id, cursor ?? '', Number(admin), requirePrincipal(c).id, limit + 1);
    return listResponse(c, rows.slice(0, limit), rows.length > limit ? rows[limit - 1]!.id : null);
  });

  route(app, 'POST', '/v1/orgs/:id/teams', { summary: 'Create an organization team', tags: ['teams'], body: teamSchema, capability: 'teams.manage' }, async c => {
    const { account, authorization } = await accountAccess(c, c.req.param('id'), 'teams.manage', true);
    const body = await jsonBody(c, teamSchema);
    const principal = requirePrincipal(c);
    if (!await one(database(c), "SELECT 1 FROM memberships WHERE account_id=? AND principal_id=? AND state='active'", account.id, principal.id)) throw new ApiError(403, 'membership_required', 'Join the organization before creating a team.');
    const id = newId('team');
    const timestamp = now();
    await commitIdentity(c, [stmt(database(c), 'INSERT INTO teams(id,account_id,slug,name,description,visibility,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, account.id, body.slug, body.name, body.description, body.visibility, principal.id, timestamp, timestamp),
    stmt(database(c), "INSERT INTO team_members(account_id,team_id,principal_id,role,created_at,updated_at) VALUES (?,?,?,'maintainer',?,?)", account.id, id, principal.id, timestamp, timestamp),
    bumpAccountPolicy(c, account.id)], { type: 'team.created', resource_id: id, resource_revision: 1, account_id: account.id }, { authorizations: [authorization] });
    return revisionResponse(c, { id, account_id: account.id, ...body, revision: 1, created_at: timestamp, updated_at: timestamp }, 201);
  });

  route(app, 'GET', '/v1/orgs/:id/teams/:teamId', { summary: 'Read a visible team', tags: ['teams'] }, async c => {
    const team = await getTeam(c);
    await teamAccess(c, team, false);
    return revisionResponse(c, { ...team });
  });

  route(app, 'PATCH', '/v1/orgs/:id/teams/:teamId', { summary: 'Update a team', tags: ['teams'], body: teamPatchSchema }, async c => {
    const team = await getTeam(c);
    const authorization = await teamAccess(c, team, true);
    const body = await jsonBody(c, teamPatchSchema);
    const revision = expectedRevision(c);
    await commitIdentity(c, [...checkedWrite(database(c), stmt(database(c),
      'UPDATE teams SET slug=?,name=?,description=?,visibility=?,revision=revision+1,updated_at=? WHERE id=? AND account_id=? AND revision=?',
      body.slug ?? team.slug, body.name ?? team.name, body.description ?? team.description, body.visibility ?? team.visibility, now(), team.id, team.account_id, revision)),
    bumpAccountPolicy(c, team.account_id)], { type: 'team.updated', resource_id: team.id, resource_revision: revision + 1, account_id: team.account_id }, { authorizations: [authorization] });
    return revisionResponse(c, { ...team, ...body, revision: revision + 1, updated_at: now() });
  });

  route(app, 'DELETE', '/v1/orgs/:id/teams/:teamId', { summary: 'Delete a team and revoke its grants', tags: ['teams'], capability: 'teams.manage' }, async c => {
    const team = await getTeam(c);
    const authorization = await authorize(c, 'teams.manage', { account_id: team.account_id });
    const revision = expectedRevision(c);
    await commitIdentity(c, [stmt(database(c), 'UPDATE access_grants SET revoked_at=COALESCE(revoked_at,?),revision=revision+1,updated_at=? WHERE account_id=? AND principal_type=\'team\' AND principal_id=?',
      now(), now(), team.account_id, team.id), stmt(database(c), 'UPDATE invitations SET team_id=NULL WHERE team_id=? AND account_id=?', team.id, team.account_id),
    ...checkedWrite(database(c), stmt(database(c), 'DELETE FROM teams WHERE id=? AND account_id=? AND revision=?', team.id, team.account_id, revision)), bumpAccountPolicy(c, team.account_id)],
    { type: 'team.deleted', resource_id: team.id, resource_revision: revision + 1, account_id: team.account_id }, { authorizations: [authorization] });
    return c.body(null, 204);
  });

  route(app, 'GET', '/v1/orgs/:id/teams/:teamId/members', { summary: 'List team members and maintainers', tags: ['teams'] }, async c => {
    const team = await getTeam(c);
    await teamAccess(c, team, false);
    const { limit, cursor } = page(c);
    const rows = await many<{ principal_id: string }>(database(c), `SELECT tm.*,p.name,p.kind FROM team_members tm JOIN principals p ON p.id=tm.principal_id
      JOIN memberships m ON m.account_id=tm.account_id AND m.principal_id=tm.principal_id WHERE tm.account_id=? AND tm.team_id=?
      AND m.state='active' AND tm.principal_id>? ORDER BY tm.principal_id LIMIT ?`, team.account_id, team.id, cursor ?? '', limit + 1);
    return listResponse(c, rows.slice(0, limit), rows.length > limit ? rows[limit - 1]!.principal_id : null);
  });

  route(app, 'POST', '/v1/orgs/:id/teams/:teamId/members', { summary: 'Add an organization member to a team', tags: ['teams'], body: teamMemberSchema }, async c => {
    const team = await getTeam(c);
    const authorization = await teamAccess(c, team, true);
    const body = await jsonBody(c, teamMemberSchema);
    if (!await one(database(c), "SELECT 1 FROM memberships WHERE account_id=? AND principal_id=? AND state='active'", team.account_id, body.principal_id)) throw new ApiError(422, 'membership_required', 'Only active organization members can join a team.');
    const timestamp = now();
    await commitIdentity(c, [...checkedWrite(database(c), stmt(database(c), `INSERT INTO team_members(account_id,team_id,principal_id,role,created_at,updated_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM memberships WHERE account_id=? AND principal_id=? AND state='active')`,
    team.account_id, team.id, body.principal_id, body.role, timestamp, timestamp, team.account_id, body.principal_id)), bumpAccountPolicy(c, team.account_id)],
    { type: 'team.member_added', resource_id: team.id, resource_revision: team.revision, account_id: team.account_id, data: { principal_id: body.principal_id, role: body.role } }, { authorizations: [authorization] });
    return revisionResponse(c, { account_id: team.account_id, team_id: team.id, ...body, revision: 1, created_at: timestamp, updated_at: timestamp }, 201);
  });

  route(app, 'PATCH', '/v1/orgs/:id/teams/:teamId/members/:principalId', { summary: 'Change a team member role', tags: ['teams'], body: teamMemberPatchSchema }, async c => {
    const team = await getTeam(c);
    const authorization = await teamAccess(c, team, true);
    const body = await jsonBody(c, teamMemberPatchSchema);
    const revision = expectedRevision(c);
    await commitIdentity(c, [...checkedWrite(database(c), stmt(database(c), `UPDATE team_members SET role=?,revision=revision+1,updated_at=?
      WHERE account_id=? AND team_id=? AND principal_id=? AND revision=? AND (role!='maintainer' OR ?='maintainer' OR EXISTS
        (SELECT 1 FROM team_members others WHERE others.team_id=team_members.team_id AND others.principal_id!=team_members.principal_id AND others.role='maintainer'))`,
    body.role, now(), team.account_id, team.id, c.req.param('principalId'), revision, body.role)), bumpAccountPolicy(c, team.account_id)],
    { type: 'team.member_updated', resource_id: team.id, resource_revision: team.revision, account_id: team.account_id,
      data: { principal_id: c.req.param('principalId'), role: body.role } }, { authorizations: [authorization] });
    return revisionResponse(c, { account_id: team.account_id, team_id: team.id, principal_id: c.req.param('principalId'), role: body.role, revision: revision + 1 });
  });

  route(app, 'DELETE', '/v1/orgs/:id/teams/:teamId/members/:principalId', { summary: 'Remove a team member', tags: ['teams'] }, async c => {
    const team = await getTeam(c);
    const authorization = await teamAccess(c, team, true);
    const revision = expectedRevision(c);
    await commitIdentity(c, [...checkedWrite(database(c), stmt(database(c), `DELETE FROM team_members WHERE account_id=? AND team_id=? AND principal_id=? AND revision=?
      AND (role!='maintainer' OR EXISTS (SELECT 1 FROM team_members others WHERE others.team_id=team_members.team_id AND others.principal_id!=team_members.principal_id AND others.role='maintainer'))`,
    team.account_id, team.id, c.req.param('principalId'), revision)), bumpAccountPolicy(c, team.account_id)],
    { type: 'team.member_removed', resource_id: team.id, resource_revision: team.revision, account_id: team.account_id,
      data: { principal_id: c.req.param('principalId') } }, { authorizations: [authorization] });
    return c.body(null, 204);
  });
}
