import { identityDatabase as database } from '@gitknot/core/authority';
import { ApiError, authorize, expectedRevision, jsonBody, listResponse, many, now, one, page, route, stmt, type App } from '@gitknot/core';
import { checkedWrite, prepareDerivedCredential, publicCredential, requireHuman, type CredentialRecord } from '@gitknot/core/auth';
import { clearSession, commitIdentity, emptySchema, publicUser, revisionResponse, setSession } from './shared.ts';

export function registerSessionRoutes(app: App): void {
  route(app, 'GET', '/v1/auth/session', { summary: 'Read the current authenticated session', tags: ['identity'] }, async c => {
    const user = await requireHuman(c, { verified: false });
    const credential = await one<CredentialRecord>(database(c), "SELECT * FROM credentials WHERE id=? AND kind='session' AND user_id=?", c.get('principal')!.credential_id, user.id);
    if (!credential) throw new ApiError(401, 'session_required', 'Sign in using a GitKnot session.');
    return revisionResponse(c, { ...publicCredential(credential), account_ids: c.get('principal')!.account_ids, user: publicUser(user, true), mfa: credential.mfa === 1,
      authenticated_at: credential.authenticated_at, csrf: '1', revision: credential.revision });
  });

  route(app, 'GET', '/v1/auth/sessions', { summary: 'List current account sessions', tags: ['identity'] }, async c => {
    const user = await requireHuman(c, { verified: false, independent: true });
    await authorize(c, 'tokens.read', { account_id: user.id });
    const { limit, cursor } = page(c);
    const sessions = await many<CredentialRecord>(database(c), `SELECT * FROM credentials WHERE user_id=? AND kind='session'
      AND revoked_at IS NULL AND expires_at>? AND id>? ORDER BY id LIMIT ?`, user.id, now(), cursor ?? '', limit + 1);
    const items = sessions.slice(0, limit);
    return listResponse(c, items.map(row => ({ ...publicCredential(row), current: row.id === c.get('principal')!.credential_id })), sessions.length > limit ? items.at(-1)!.id : null);
  });

  route(app, 'DELETE', '/v1/auth/sessions/:id', { summary: 'Revoke an account session', tags: ['identity'] }, async c => {
    const user = await requireHuman(c, { verified: false, independent: c.req.param('id') !== c.get('principal')?.credential_id });
    if (c.req.param('id') !== c.get('principal')!.credential_id) await authorize(c, 'tokens.revoke', { account_id: user.id });
    const revision = expectedRevision(c);
    await commitIdentity(c, checkedWrite(database(c), stmt(database(c),
      "UPDATE credentials SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE id=? AND user_id=? AND kind='session' AND revision=?",
      now(), c.req.param('id'), user.id, revision)), { type: 'identity.session_revoked', resource_id: c.req.param('id')!, resource_revision: revision + 1, account_id: user.id });
    if (c.req.param('id') === c.get('principal')!.credential_id) clearSession(c);
    return c.body(null, 204);
  });

  route(app, 'POST', '/v1/auth/session/refresh', { summary: 'Rotate a session without extending its authentication lifetime', tags: ['identity'], body: emptySchema, sensitive: true }, async c => {
    await jsonBody(c, emptySchema);
    const user = await requireHuman(c, { verified: false });
    const revision = expectedRevision(c);
    const previous = await one<CredentialRecord>(database(c), "SELECT * FROM credentials WHERE id=? AND user_id=? AND kind='session'", c.get('principal')!.credential_id, user.id);
    if (!previous) throw new ApiError(401, 'session_required', 'Sign in using a GitKnot session.');
    const next = await prepareDerivedCredential(database(c), c.get('principal')!, { principal_id: user.id, user_id: user.id, kind: 'session', name: previous.name,
      capabilities: null, repository_ids: null, account_ids: null, mfa: previous.mfa === 1, auth_revision: user.auth_revision,
      authenticated_at: previous.authenticated_at, expires_at: previous.expires_at, rotation_of_id: previous.id, created_by: user.id });
    await commitIdentity(c, [...next.statements, ...checkedWrite(database(c), stmt(database(c),
      'UPDATE credentials SET revoked_at=?,revision=revision+1 WHERE id=? AND user_id=? AND revision=? AND revoked_at IS NULL', now(), previous.id, user.id, revision))],
    { type: 'identity.session_rotated', resource_id: next.credential.id, resource_revision: 1, account_id: user.id });
    setSession(c, next.token, next.credential);
    return revisionResponse(c, { id: next.credential.id, expires_at: next.credential.expires_at, authenticated_at: next.credential.authenticated_at,
      mfa: next.credential.mfa === 1, csrf: '1', revision: next.credential.revision });
  });
}
