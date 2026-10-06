import { Context } from 'hono';
import { z } from 'zod';
import { identityDatabase as database, readRepositoryAuthority } from '@gitknot/core/authority';
import { ApiError, authorize, expectedRevision, explainAuthorization, getRepository, jsonBody, listResponse, many, newId, now, one, page,
  principalForExplanation, readAccountPolicy, requirePrincipal, route, sha256, stmt,
  type App, type AppContext, type AppEnv, type Principal, type Repository } from '@gitknot/core';
import { actionToken, afterSeconds, checkedWrite, identityKeys, requireHuman, type UserRecord } from '@gitknot/core/auth';
import { commitIdentity, emailSchema, emptySchema, idSchema, revisionResponse, tokenSchema } from '../identity/shared.ts';
import { abandonInvitationSeat, invitationSeatPreview, reserveInvitationSeat } from './billing.ts';
import { accountAccess, assertDelegable, bumpAccountPolicy, scopedRole } from './shared.ts';

interface Invitation {
  id: string; account_id: string; repo_id: string | null; email: string; role_id: string; team_id: string | null;
  token_hash: string; key_id: string; principal_json: string; state: 'pending' | 'accepted' | 'revoked' | 'expired';
  expires_at: string; accepted_by: string | null; accepted_at: string | null; seat_quote_json: string;
  revision: number; created_by: string; created_at: string; updated_at: string;
}
const invitationSchema = z.object({ email: emailSchema, role_id: z.string().min(1).max(128).optional(), team_id: idSchema.optional(),
  expires_in_seconds: z.number().int().min(300).max(604800).default(604800) }).strict();
const acceptSchema = z.object({ token: tokenSchema, seat_quote: z.object({ subscription_revision: z.number().int().positive(), plan_id: z.string().min(1).max(128),
  maximum_monthly_units: z.string().regex(/^\d{1,30}$/), maximum_current_period_units: z.string().regex(/^\d{1,30}$/) }).strict() }).strict();
const declineSchema = z.object({ token: tokenSchema }).strict();

function publicInvitation(invitation: Invitation): Record<string, unknown> & { revision: number } {
  return { id: invitation.id, account_id: invitation.account_id, repo_id: invitation.repo_id, email: invitation.email,
    role_id: invitation.role_id, team_id: invitation.team_id, state: invitation.expires_at <= now() && invitation.state === 'pending' ? 'expired' : invitation.state,
    expires_at: invitation.expires_at, accepted_by: invitation.accepted_by, accepted_at: invitation.accepted_at,
    seat_quote: JSON.parse(invitation.seat_quote_json) as unknown, payer_account_id: invitation.account_id,
    revision: invitation.revision, created_at: invitation.created_at, updated_at: invitation.updated_at };
}

async function invitationScope(c: AppContext, repository: boolean, capability: string) {
  if (repository) {
    const repo = await getRepository(c, c.req.param('id'), capability);
    return { account_id: repo.owner_id, repo_id: repo.id, authorization: await authorize(c, capability, { repo_id: repo.id }) };
  }
  const { account, authorization } = await accountAccess(c, c.req.param('id'), capability, true);
  return { account_id: account.id, repo_id: null, authorization };
}

async function validateInvitationPolicy(c: AppContext, accountId: string, email: string, outside: boolean): Promise<void> {
  const { policy } = await readAccountPolicy(database(c), accountId);
  if (outside && !policy.allow_outside_collaborators) throw new ApiError(403, 'outside_collaborators_disabled', 'This account does not permit outside collaborators.');
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  if (policy.allowed_email_domains.length && !policy.allowed_email_domains.some(allowed => allowed.toLowerCase() === domain)) {
    throw new ApiError(422, 'email_domain_not_allowed', 'The invitation email domain is excluded by account policy.');
  }
}

async function recipientInvitation(c: AppContext, user: UserRecord, token?: string, pending = true): Promise<Invitation> {
  const invitation = await one<Invitation>(database(c), 'SELECT * FROM invitations WHERE id=? AND (email=? COLLATE NOCASE OR accepted_by=?)', c.req.param('invitationId'), user.email, user.id);
  if (!invitation || token !== undefined && await sha256(token) !== invitation.token_hash) throw new ApiError(404, 'not_found', 'The requested invitation was not found.');
  const principal = requirePrincipal(c);
  if (principal.account_ids !== null && !principal.account_ids.includes(invitation.account_id)
    || principal.repository_ids !== null && (!invitation.repo_id || !principal.repository_ids.includes(invitation.repo_id))) {
    throw new ApiError(404, 'not_found', 'The requested invitation was not found.');
  }
  if (pending && (invitation.state !== 'pending' || invitation.expires_at <= now())) throw new ApiError(409, 'invitation_inactive', 'This invitation expired or has already been used.');
  return invitation;
}

async function currentInviterContext(c: AppContext, invitation: Invitation): Promise<AppContext> {
  const current = await principalForExplanation(database(c), invitation.created_by);
  const snapshot = JSON.parse(invitation.principal_json) as Principal;
  if (!current || snapshot.id !== current.id) throw new ApiError(409, 'invitation_authority_changed', 'The invitation issuer is no longer authorized.');
  const context = new Context<AppEnv>(new Request('https://internal.gitknot.com/invitation-policy'), { env: c.env });
  context.set('principal', { ...current, capabilities: snapshot.capabilities, repository_ids: snapshot.repository_ids,
    account_ids: snapshot.account_ids, mfa: snapshot.mfa });
  context.set('requestId', c.get('requestId'));
  context.set('database', database(c));
  return context;
}

function registerInvitationScope(app: App, path: string, repository: boolean): void {
  route(app, 'GET', path, { summary: 'List scoped invitations', tags: ['invitations'], capability: 'invitations.read' }, async c => {
    const scope = await invitationScope(c, repository, 'invitations.read');
    const { limit, cursor } = page(c);
    const rows = await many<Invitation>(database(c), 'SELECT * FROM invitations WHERE account_id=? AND repo_id IS ? AND id>? ORDER BY id LIMIT ?', scope.account_id, scope.repo_id, cursor ?? '', limit + 1);
    return listResponse(c, rows.slice(0, limit).map(publicInvitation), rows.length > limit ? rows[limit - 1]!.id : null);
  });

  route(app, 'POST', path, { summary: 'Invite a member or outside collaborator with a seat-cost preview', tags: ['invitations'], body: invitationSchema, capability: 'invitations.manage' }, async c => {
    const scope = await invitationScope(c, repository, 'invitations.manage');
    const body = await jsonBody(c, invitationSchema);
    const roleId = body.role_id ?? (repository ? 'reader' : 'member');
    const role = await scopedRole(c, roleId, scope.account_id, scope.repo_id);
    await assertDelegable(c, role.capabilities, scope.repo_id ? { repo_id: scope.repo_id } : { account_id: scope.account_id });
    if (roleId === 'owner') {
      if (repository) throw new ApiError(422, 'owner_membership_required', 'Repository collaborators cannot receive account ownership.');
      await requireHuman(c, { recent: true, independent: true });
      await authorize(c, 'owners.manage', { account_id: scope.account_id });
    }
    await validateInvitationPolicy(c, scope.account_id, body.email, repository);
    if (body.team_id && (repository || !await one(database(c), 'SELECT id FROM teams WHERE id=? AND account_id=?', body.team_id, scope.account_id))) {
      throw new ApiError(422, 'team_outside_scope', 'Only organization invitations may assign one of the organization teams.');
    }
    const recipient = await one<{ id: string }>(database(c), 'SELECT id FROM users WHERE email=? AND disabled_at IS NULL', body.email);
    const seatQuote = await invitationSeatPreview(c, scope.account_id, recipient?.id ?? null);
    const id = newId('inv');
    const keyId = identityKeys(c.env).current;
    const expiresAt = afterSeconds(body.expires_in_seconds);
    const token = await actionToken(c.env, { id, purpose: 'invitation', key_id: keyId, expires_at: expiresAt });
    const timestamp = now();
    const principal = requirePrincipal(c);
    await commitIdentity(c, [
      stmt(database(c), "UPDATE invitations SET state='expired',revision=revision+1,updated_at=? WHERE account_id=? AND repo_id IS ? AND email=? AND state='pending' AND expires_at<=?",
        timestamp, scope.account_id, scope.repo_id, body.email, timestamp),
      stmt(database(c), `INSERT INTO invitations(id,account_id,repo_id,email,role_id,team_id,token_hash,key_id,expires_at,seat_quote_json,created_by,created_at,updated_at,principal_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, scope.account_id, scope.repo_id, body.email, roleId, body.team_id ?? null, await sha256(token), keyId,
      expiresAt, JSON.stringify(seatQuote), principal.id, timestamp, timestamp, JSON.stringify(principal)),
    ], { type: 'invitation.created', resource_id: id, resource_revision: 1, account_id: scope.account_id, repo_id: scope.repo_id }, { authorizations: [scope.authorization] });
    return revisionResponse(c, { id, account_id: scope.account_id, repo_id: scope.repo_id, email: body.email, role_id: roleId, team_id: body.team_id ?? null,
      state: 'pending', expires_at: expiresAt, seat_quote: seatQuote, payer_account_id: scope.account_id, revision: 1, created_at: timestamp, updated_at: timestamp }, 201);
  });

  route(app, 'DELETE', `${path}/:invitationId`, { summary: 'Revoke a pending invitation', tags: ['invitations'], capability: 'invitations.manage' }, async c => {
    const scope = await invitationScope(c, repository, 'invitations.manage');
    const revision = expectedRevision(c);
    await commitIdentity(c, checkedWrite(database(c), stmt(database(c),
      "UPDATE invitations SET state='revoked',revision=revision+1,updated_at=? WHERE id=? AND account_id=? AND repo_id IS ? AND revision=? AND state='pending'",
      now(), c.req.param('invitationId'), scope.account_id, scope.repo_id, revision)), { type: 'invitation.revoked', resource_id: c.req.param('invitationId')!,
      resource_revision: revision + 1, account_id: scope.account_id, repo_id: scope.repo_id }, { authorizations: [scope.authorization] });
    return c.body(null, 204);
  });

  route(app, 'POST', `${path}/:invitationId/resend`, { summary: 'Rotate and resend an invitation link', tags: ['invitations'], body: emptySchema, capability: 'invitations.manage' }, async c => {
    const scope = await invitationScope(c, repository, 'invitations.manage');
    const revision = expectedRevision(c);
    const invitation = await one<Invitation>(database(c), 'SELECT * FROM invitations WHERE id=? AND account_id=? AND repo_id IS ?', c.req.param('invitationId'), scope.account_id, scope.repo_id);
    if (!invitation || !['pending', 'expired'].includes(invitation.state)) throw new ApiError(404, 'not_found', 'The requested invitation was not found.');
    const role = await scopedRole(c, invitation.role_id, scope.account_id, scope.repo_id);
    await assertDelegable(c, role.capabilities, scope.repo_id ? { repo_id: scope.repo_id } : { account_id: scope.account_id });
    const keyId = identityKeys(c.env).current;
    const expiresAt = afterSeconds(604800);
    const token = await actionToken(c.env, { id: invitation.id, purpose: 'invitation', key_id: keyId, expires_at: expiresAt });
    await commitIdentity(c, checkedWrite(database(c), stmt(database(c),
      "UPDATE invitations SET token_hash=?,key_id=?,expires_at=?,state='pending',principal_json=?,created_by=?,revision=revision+1,updated_at=? WHERE id=? AND account_id=? AND revision=? AND state IN ('pending','expired')",
      await sha256(token), keyId, expiresAt, JSON.stringify(requirePrincipal(c)), requirePrincipal(c).id, now(), invitation.id, scope.account_id, revision)),
    { type: 'invitation.resent', resource_id: invitation.id, resource_revision: revision + 1, account_id: scope.account_id, repo_id: scope.repo_id }, { authorizations: [scope.authorization] });
    return revisionResponse(c, { ...publicInvitation({ ...invitation, expires_at: expiresAt, revision: revision + 1, state: 'pending' }), revision: revision + 1 });
  });
}

export function registerInvitationRoutes(app: App): void {
  registerInvitationScope(app, '/v1/orgs/:id/invitations', false);
  registerInvitationScope(app, '/v1/repos/:id/invitations', true);

  route(app, 'GET', '/v1/invitations', { summary: 'List invitations addressed to your verified account', tags: ['invitations'] }, async c => {
    const user = await requireHuman(c);
    const principal = requirePrincipal(c);
    const { limit, cursor } = page(c);
    const rows = await many<Invitation>(database(c), `SELECT * FROM invitations WHERE email=? AND state='pending' AND expires_at>? AND id>?
      AND (? IS NULL OR account_id IN (SELECT value FROM json_each(?)))
      AND (? IS NULL OR repo_id IN (SELECT value FROM json_each(?))) ORDER BY id LIMIT ?`, user.email, now(), cursor ?? '',
    principal.account_ids === null ? null : JSON.stringify(principal.account_ids), JSON.stringify(principal.account_ids ?? []),
    principal.repository_ids === null ? null : JSON.stringify(principal.repository_ids), JSON.stringify(principal.repository_ids ?? []), limit + 1);
    return listResponse(c, rows.slice(0, limit).map(publicInvitation), rows.length > limit ? rows[limit - 1]!.id : null);
  });

  route(app, 'GET', '/v1/invitations/:invitationId', { summary: 'Review an invitation and its current seat cost', tags: ['invitations'] }, async c => {
    const user = await requireHuman(c);
    const invitation = await recipientInvitation(c, user, undefined, false);
    const seatQuote = await invitationSeatPreview(c, invitation.account_id, user.id);
    return revisionResponse(c, { ...publicInvitation(invitation), seat_quote: seatQuote, revision: invitation.revision });
  });

  route(app, 'POST', '/v1/invitations/:invitationId/accept', { summary: 'Accept an invitation with explicit seat-cost acknowledgment', tags: ['invitations'], body: acceptSchema }, async c => {
    const user = await requireHuman(c, { recent: true });
    const body = await jsonBody(c, acceptSchema);
    const revision = expectedRevision(c);
    const invitation = await recipientInvitation(c, user, body.token);
    if (invitation.role_id === 'owner') await requireHuman(c, { recent: true, independent: true });
    const inviterContext = await currentInviterContext(c, invitation);
    const scope = invitation.repo_id ? { repo_id: invitation.repo_id } : { account_id: invitation.account_id };
    const authority = await explainAuthorization(inviterContext, 'invitations.manage', scope);
    if (!authority.allowed) throw new ApiError(409, 'invitation_authority_changed', 'The invitation issuer is no longer authorized.');
    const role = await scopedRole(c, invitation.role_id, invitation.account_id, invitation.repo_id);
    await assertDelegable(inviterContext, role.capabilities, scope);
    await validateInvitationPolicy(c, invitation.account_id, user.email, !!invitation.repo_id);
    const { policy } = await readAccountPolicy(database(c), invitation.account_id);
    if (policy.require_mfa && !requirePrincipal(c).mfa) throw new ApiError(403, 'mfa_required', 'Confirm a passkey or second factor before joining this account.');
    if (invitation.role_id === 'owner' && !(await explainAuthorization(inviterContext, 'owners.manage', scope)).allowed) throw new ApiError(409, 'invitation_authority_changed', 'The issuer can no longer assign owners.');
    let repository: Repository | null = null;
    if (invitation.repo_id) {
      repository = await readRepositoryAuthority(c, invitation.repo_id);
      if (!repository || repository.owner_id !== invitation.account_id || repository.state !== 'active') throw new ApiError(409, 'repository_unavailable', 'This repository cannot accept collaborators in its current state.');
      if (repository.fork_source_id && !(await explainAuthorization(c, 'contents.read', { repo_id: repository.fork_source_id })).allowed) {
        throw new ApiError(403, 'fork_source_access_required', 'Access to a restricted fork also requires access to its source.');
      }
    }
    const seat = await reserveInvitationSeat(c, invitation.account_id, user.id, invitation.id, body.seat_quote);
    const timestamp = now();
    const membership = invitation.repo_id ? [] : [stmt(database(c), `INSERT INTO memberships(account_id,principal_id,role_id,state,created_by,created_at,updated_at)
      VALUES (?,?,?,'active',?,?,?) ON CONFLICT(account_id,principal_id) DO UPDATE SET role_id=excluded.role_id,state='active',revision=memberships.revision+1,updated_at=excluded.updated_at`,
    invitation.account_id, user.id, invitation.role_id, invitation.created_by, timestamp, timestamp)];
    const grant = invitation.repo_id ? [stmt(database(c), `INSERT INTO access_grants(id,account_id,repo_id,principal_type,principal_id,role_id,created_by,created_at,updated_at)
      VALUES (?,?,?,'user',?,?,?,?,?)`, newId('grant'), invitation.account_id, invitation.repo_id, user.id, invitation.role_id, invitation.created_by, timestamp, timestamp)] : [];
    try {
      await commitIdentity(c, [
        ...checkedWrite(database(c), stmt(database(c), "UPDATE invitations SET state='accepted',accepted_by=?,accepted_at=?,revision=revision+1,updated_at=? WHERE id=? AND account_id=? AND email=? AND revision=? AND state='pending' AND expires_at>?",
          user.id, timestamp, timestamp, invitation.id, invitation.account_id, user.email, revision, timestamp)),
        ...seat.statements, ...membership, ...grant,
        ...(invitation.team_id ? [stmt(database(c), "INSERT INTO team_members(account_id,team_id,principal_id,role,created_at,updated_at) VALUES (?,?,?,'member',?,?) ON CONFLICT(team_id,principal_id) DO NOTHING",
          invitation.account_id, invitation.team_id, user.id, timestamp, timestamp)] : []), bumpAccountPolicy(c, invitation.account_id),
      ], { type: 'invitation.accepted', resource_id: invitation.id, resource_revision: revision + 1, account_id: invitation.account_id, repo_id: invitation.repo_id,
        data: { principal_id: user.id, role_id: invitation.role_id } }, { authorizations: [authority] });
    } catch (error) {
      try { await abandonInvitationSeat(c, invitation.account_id, seat.reservation_id); }
      catch { console.error(JSON.stringify({ event: 'invitation.seat_cleanup_pending', invitation_id: invitation.id, request_id: c.get('requestId') })); }
      throw error;
    }
    return revisionResponse(c, { ...publicInvitation({ ...invitation, state: 'accepted', accepted_by: user.id, accepted_at: timestamp, revision: revision + 1, updated_at: timestamp }), revision: revision + 1 });
  });

  route(app, 'POST', '/v1/invitations/:invitationId/decline', { summary: 'Decline an invitation', tags: ['invitations'], body: declineSchema, sensitive: true }, async c => {
    const user = await requireHuman(c);
    const body = await jsonBody(c, declineSchema);
    const invitation = await recipientInvitation(c, user, body.token);
    const revision = expectedRevision(c);
    await commitIdentity(c, checkedWrite(database(c), stmt(database(c), "UPDATE invitations SET state='revoked',revision=revision+1,updated_at=? WHERE id=? AND email=? AND revision=? AND state='pending'", now(), invitation.id, user.email, revision)),
      { type: 'invitation.declined', resource_id: invitation.id, resource_revision: revision + 1, account_id: invitation.account_id, repo_id: invitation.repo_id });
    return c.body(null, 204);
  });
}
