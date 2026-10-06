import { z } from 'zod';
import { identityDatabase as database, readRepositoryAuthority } from '@gitknot/core/authority';
import { ApiError, expectedRevision, jsonBody, listResponse, many, now, one, page, route, stmt, type App, type AppContext } from '@gitknot/core';
import { checkedWrite, createIdentityAction, findIdentityAction, identityRateLimit, requireHuman, type UserRecord } from '@gitknot/core/auth';
import { clearSession, commitIdentity, consumeAction, emailSchema, publicUser, requireActionEpoch, revisionResponse, tokenSchema, usernameSchema } from './shared.ts';
import { seatRemovalStatements } from '../accounts/billing.ts';

const profileSchema = z.object({
  username: usernameSchema.optional(), display_name: z.string().trim().max(100).optional(), bio: z.string().max(1000).optional(),
  avatar_url: z.url().max(2048).refine(value => new URL(value).protocol === 'https:', 'Avatar URLs must use HTTPS.').nullable().optional(),
  profile_visibility: z.enum(['public', 'private']).optional(), show_email: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'Supply at least one profile field.');
const changeEmailSchema = z.object({ email: emailSchema }).strict();
const confirmEmailSchema = z.object({ token: tokenSchema }).strict();

async function assertNoOwnedRepositories(c: AppContext, userId: string): Promise<void> {
  const hints = await many<{ id: string }>(database(c), `SELECT id FROM repositories WHERE owner_id=?
    UNION SELECT repo_id AS id FROM account_authority_repositories WHERE account_id=?`, userId, userId);
  for (const hint of hints) {
    const repo = await readRepositoryAuthority(c, hint.id);
    if (repo?.owner_id === userId && repo.state !== 'deleted') throw new ApiError(409, 'repositories_remaining', 'Transfer or delete your personal repositories before disabling your account.');
  }
}

export function registerProfileRoutes(app: App): void {
  route(app, 'GET', '/v1/me', { summary: 'Read your GitKnot profile', tags: ['identity'] }, async c => {
    const user = await requireHuman(c, { verified: false });
    return revisionResponse(c, { ...publicUser(user, true), revision: user.revision });
  });

  route(app, 'PATCH', '/v1/me', { summary: 'Update your profile and privacy', tags: ['identity'], body: profileSchema }, async c => {
    const user = await requireHuman(c, { verified: false, recent: true, independent: true });
    const body = await jsonBody(c, profileSchema);
    const revision = expectedRevision(c);
    const username = body.username ?? user.username;
    const timestamp = now();
    await commitIdentity(c, [
      ...checkedWrite(database(c), stmt(database(c), `UPDATE users SET username=?,display_name=?,bio=?,avatar_url=?,profile_visibility=?,show_email=?,revision=revision+1,updated_at=?
        WHERE id=? AND revision=?`, username, body.display_name ?? user.display_name, body.bio ?? user.bio,
      body.avatar_url === undefined ? user.avatar_url : body.avatar_url, body.profile_visibility ?? user.profile_visibility,
      body.show_email === undefined ? user.show_email : Number(body.show_email), timestamp, user.id, revision)),
      ...(username === user.username ? [] : [
        stmt(database(c), 'INSERT INTO account_aliases(slug,account_id,created_at) VALUES (?,?,?) ON CONFLICT(slug) DO NOTHING', user.username, user.id, timestamp),
        stmt(database(c), `INSERT INTO repository_aliases(owner_slug,repository_slug,repo_id,created_at)
          SELECT ?,slug,id,? FROM repositories WHERE owner_id=? ON CONFLICT(owner_slug,repository_slug) DO NOTHING`, user.username, timestamp, user.id),
      ]),
      stmt(database(c), 'UPDATE accounts SET slug=?,name=?,revision=revision+1,updated_at=? WHERE id=? AND owner_user_id=?', username, body.display_name ?? user.display_name, timestamp, user.id, user.id),
      stmt(database(c), 'UPDATE principals SET name=?,revision=revision+1,updated_at=? WHERE id=?', body.display_name ?? user.display_name, timestamp, user.id),
    ], { type: 'identity.profile_updated', resource_id: user.id, resource_revision: revision + 1, account_id: user.id,
      data: { username, profile_visibility: body.profile_visibility ?? user.profile_visibility } });
    const updated = await one<UserRecord>(database(c), 'SELECT * FROM users WHERE id=?', user.id);
    return revisionResponse(c, { ...publicUser(updated!, true), revision: updated!.revision });
  });

  route(app, 'GET', '/v1/users/:id', { summary: 'Read a visible user profile', tags: ['identity'], public: true }, async c => {
    const user = await one<UserRecord>(database(c), 'SELECT * FROM users WHERE (id=? OR username=? COLLATE NOCASE) AND disabled_at IS NULL', c.req.param('id'), c.req.param('id'));
    const self = user?.id === c.get('principal')?.user_id;
    if (!user || (!self && (user.profile_visibility !== 'public' || user.email_verified_at === null))) throw new ApiError(404, 'not_found', 'The requested user was not found.');
    return revisionResponse(c, { ...publicUser(user, self), revision: user.revision });
  });

  route(app, 'GET', '/v1/users', { summary: 'Find public GitKnot profiles', tags: ['identity'], public: true }, async c => {
    const { limit, cursor } = page(c);
    const query = c.req.query('q') ?? '';
    if (query.length > 100) throw new ApiError(422, 'invalid_query', 'The profile query is too long.');
    const pattern = `${query.replace(/[\\%_]/g, value => `\\${value}`)}%`;
    const rows = await many<UserRecord>(database(c), `SELECT * FROM users WHERE profile_visibility='public' AND disabled_at IS NULL
      AND email_verified_at IS NOT NULL AND username LIKE ? ESCAPE '\\' AND id>? ORDER BY id LIMIT ?`, pattern, cursor ?? '', limit + 1);
    const items = rows.slice(0, limit);
    return listResponse(c, items.map(user => publicUser(user)), rows.length > limit ? items.at(-1)!.id : null);
  });

  route(app, 'POST', '/v1/auth/email', { summary: 'Request a verified email-address change', tags: ['identity'], body: changeEmailSchema, sensitive: true }, async c => {
    const user = await requireHuman(c, { recent: true, independent: true });
    const body = await jsonBody(c, changeEmailSchema);
    const revision = expectedRevision(c);
    await identityRateLimit(c, 'email_change', user.id);
    const action = await createIdentityAction(c.env, { purpose: 'change_email', user_id: user.id, email: body.email, seconds: 1800,
      auth_revision: user.auth_revision, data: { previous_email: user.email } });
    await commitIdentity(c, [...checkedWrite(database(c), stmt(database(c),
      'UPDATE users SET revision=revision+1,updated_at=? WHERE id=? AND revision=?', now(), user.id, revision)), action.statement],
    { type: 'identity.email_change_requested', resource_id: action.action.id, resource_revision: 1, account_id: user.id,
      data: { action_id: action.action.id, user_id: user.id } });
    return revisionResponse(c, { accepted: true, verification_required: true, revision: revision + 1 }, 202);
  });

  route(app, 'POST', '/v1/auth/email/verify', { summary: 'Confirm a new email address', tags: ['identity'], body: confirmEmailSchema, sensitive: true }, async c => {
    const user = await requireHuman(c, { recent: true, independent: true });
    const body = await jsonBody(c, confirmEmailSchema);
    const revision = expectedRevision(c);
    const action = await findIdentityAction(database(c), body.token, 'change_email');
    requireActionEpoch(action, user);
    if (action.user_id !== user.id) throw new ApiError(400, 'invalid_authentication_action', 'This email change belongs to another account.');
    await commitIdentity(c, [...consumeAction(c, action), ...checkedWrite(database(c), stmt(database(c),
      'UPDATE users SET email=?,email_verified_at=?,auth_revision=auth_revision+1,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND auth_revision=?',
      action.email, now(), now(), user.id, revision, user.auth_revision)),
    stmt(database(c), 'UPDATE credentials SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE user_id=?', now(), user.id),
    stmt(database(c), 'UPDATE identity_actions SET consumed_at=COALESCE(consumed_at,?) WHERE user_id=?', now(), user.id)],
    { type: 'identity.email_changed', resource_id: user.id, resource_revision: revision + 1, account_id: user.id });
    clearSession(c);
    return c.json({ changed: true, sign_in_required: true });
  });

  route(app, 'DELETE', '/v1/me', { summary: 'Disable your account and revoke its credentials', tags: ['identity'] }, async c => {
    const user = await requireHuman(c, { recent: true, independent: true });
    const revision = expectedRevision(c);
    await assertNoOwnedRepositories(c, user.id);
    const memberships = await many<{ account_id: string }>(database(c), `SELECT account_id FROM memberships WHERE principal_id=? AND account_id!=? AND state='active'
      UNION SELECT account_id FROM access_grants WHERE principal_id=? AND principal_type='user' AND account_id!=? AND revoked_at IS NULL`, user.id, user.id, user.id, user.id);
    const seats: D1PreparedStatement[] = [];
    for (const membership of memberships) seats.push(...await seatRemovalStatements(c, membership.account_id, user.id));
    const timestamp = now();
    await commitIdentity(c, [...checkedWrite(database(c), stmt(database(c),
      'UPDATE users SET disabled_at=?,auth_revision=auth_revision+1,revision=revision+1,updated_at=? WHERE id=? AND revision=?', timestamp, timestamp, user.id, revision)),
    stmt(database(c), 'UPDATE principals SET disabled_at=?,revision=revision+1,updated_at=? WHERE id=?', timestamp, timestamp, user.id),
    stmt(database(c), 'UPDATE accounts SET disabled_at=?,policy_revision=policy_revision+1,revision=revision+1,updated_at=? WHERE id=?', timestamp, timestamp, user.id),
    stmt(database(c), "UPDATE memberships SET state='suspended',revision=revision+1,updated_at=? WHERE principal_id=? AND account_id!=?", timestamp, user.id, user.id),
    stmt(database(c), "UPDATE access_grants SET revoked_at=?,revision=revision+1,updated_at=? WHERE principal_id=? AND principal_type='user' AND revoked_at IS NULL", timestamp, timestamp, user.id),
    ...seats,
    stmt(database(c), 'UPDATE credentials SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE user_id=?', timestamp, user.id)],
    { type: 'identity.account_disabled', resource_id: user.id, resource_revision: revision + 1, account_id: user.id },
    { before_commit: () => assertNoOwnedRepositories(c, user.id) });
    clearSession(c);
    return c.body(null, 204);
  });
}
