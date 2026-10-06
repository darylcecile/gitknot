import { z } from 'zod';
import { identityDatabase as database } from '@gitknot/core/authority';
import { ApiError, auditStatement, expectedRevision, jsonBody, newId, now, one, route, stmt, type App } from '@gitknot/core';
import { accountPolicySchema } from '@gitknot/core/policy';
import { checkedWrite, createIdentityAction, findIdentityAction, hashPassword, identityRateLimit, requireHuman,
  verifyPassword, verifySecondFactor, type UserRecord } from '@gitknot/core/auth';
import { clearSession, commitIdentity, consumeAction, emailSchema, failedAction, newSession, noStore, passwordSchema,
  proofSchema, publicUser, requireActionEpoch, setSession, tokenSchema, userEpochFence, usernameSchema } from './shared.ts';

const signupSchema = z.object({ username: usernameSchema, email: emailSchema, password: passwordSchema,
  display_name: z.string().trim().max(100).optional() }).strict();
const loginSchema = z.object({ login: z.string().min(1).max(254), password: z.string().max(1024) }).strict();
const verifySchema = z.object({ token: tokenSchema }).strict();
const recoverSchema = z.object({ email: emailSchema }).strict();
const resetSchema = z.object({ token: tokenSchema, password: passwordSchema, ...proofSchema.shape }).strict();
const loginMfaSchema = z.object({ token: tokenSchema, ...proofSchema.shape }).strict();
const changePasswordSchema = z.object({ current_password: z.string().max(1024), password: passwordSchema, ...proofSchema.shape }).strict();
const reauthenticateSchema = z.object({ password: z.string().max(1024), ...proofSchema.shape }).strict();
const accepted = { accepted: true, message: 'If the account can receive this request, GitKnot will send an email with the next step.' };

export function registerPasswordRoutes(app: App): void {
  route(app, 'POST', '/v1/auth/signup', { summary: 'Create a GitKnot account and send email verification', tags: ['identity'], body: signupSchema, public: true, sensitive: true }, async c => {
    const body = await jsonBody(c, signupSchema);
    await identityRateLimit(c, 'signup', body.email);
    noStore(c);
    const existing = await one<{ id: string }>(database(c), 'SELECT id FROM users WHERE email=? COLLATE NOCASE', body.email);
    if (existing) return c.json(accepted, 202);
    const occupied = await one<{ id: string }>(database(c), 'SELECT id FROM accounts WHERE slug=? COLLATE NOCASE', body.username);
    if (occupied) throw new ApiError(409, 'name_unavailable', 'This GitKnot username is unavailable.');
    const id = newId('u');
    const timestamp = now();
    const passwordHash = await hashPassword(body.password);
    const action = await createIdentityAction(c.env, { user_id: id, purpose: 'verify_email', email: body.email, seconds: 86400, auth_revision: 1 });
    try {
      await commitIdentity(c, [
        stmt(database(c), 'INSERT INTO users(id,username,email,display_name,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
          id, body.username, body.email, body.display_name ?? body.username, passwordHash, timestamp, timestamp),
        stmt(database(c), "INSERT INTO accounts(id,type,slug,name,owner_user_id,initial_seat_principal_id,created_at,updated_at) VALUES (?,'user',?,?,?,?,?,?)",
          id, body.username, body.display_name ?? body.username, id, id, timestamp, timestamp),
        stmt(database(c), "INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES (?,'user',?,?,?,?,?,?)",
          id, id, id, body.display_name ?? body.username, id, timestamp, timestamp),
        stmt(database(c), 'INSERT INTO account_policies(account_id,config_json,updated_by,updated_at) VALUES (?,?,?,?)',
          id, JSON.stringify(accountPolicySchema.parse({})), id, timestamp),
        action.statement,
      ], { type: 'identity.signup', actor_id: id, resource_id: id, resource_revision: 1, account_id: id }, { credential_fence: false,
        events: [{ type: 'identity.verification_requested', actor_id: id, resource_id: action.action.id, resource_revision: 1, account_id: id,
          data: { action_id: action.action.id, user_id: id } }] });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'already_exists' && await one(database(c), 'SELECT id FROM users WHERE email=?', body.email)) return c.json(accepted, 202);
      throw error;
    }
    return c.json({ ...accepted, verification_required: true }, 202);
  });

  route(app, 'POST', '/v1/auth/verify', { summary: 'Verify a GitKnot email address', tags: ['identity'], body: verifySchema, public: true, sensitive: true }, async c => {
    const body = await jsonBody(c, verifySchema);
    await identityRateLimit(c, 'verify');
    const action = await findIdentityAction(database(c), body.token, 'verify_email');
    const user = await one<UserRecord>(database(c), 'SELECT * FROM users WHERE id=?', action.user_id);
    if (!user || user.email !== action.email) throw new ApiError(400, 'invalid_authentication_action', 'This verification request is no longer valid.');
    requireActionEpoch(action, user);
    const timestamp = now();
    await commitIdentity(c, [
      ...consumeAction(c, action),
      ...checkedWrite(database(c), stmt(database(c), 'UPDATE users SET email_verified_at=COALESCE(email_verified_at,?),revision=revision+1,updated_at=? WHERE id=? AND auth_revision=? AND disabled_at IS NULL',
        timestamp, timestamp, user.id, user.auth_revision)),
      stmt(database(c), "INSERT INTO memberships(account_id,principal_id,role_id,state,created_by,created_at,updated_at) VALUES (?,?,'owner','active',?,?,?) ON CONFLICT(account_id,principal_id) DO NOTHING",
        user.id, user.id, user.id, timestamp, timestamp),
      stmt(database(c), "UPDATE identity_actions SET consumed_at=? WHERE user_id=? AND purpose='verify_email' AND consumed_at IS NULL", timestamp, user.id),
    ], { type: 'identity.email_verified', actor_id: user.id, resource_id: user.id, resource_revision: user.revision + 1, account_id: user.id }, { credential_fence: false });
    noStore(c);
    return c.json({ verified: true });
  });

  route(app, 'POST', '/v1/auth/verify/resend', { summary: 'Resend account verification', tags: ['identity'], body: recoverSchema, public: true, sensitive: true }, async c => {
    const body = await jsonBody(c, recoverSchema);
    await identityRateLimit(c, 'verify_resend', body.email);
    const user = await one<UserRecord>(database(c), 'SELECT * FROM users WHERE email=? AND disabled_at IS NULL AND email_verified_at IS NULL', body.email);
    if (user) {
      const action = await createIdentityAction(c.env, { user_id: user.id, email: user.email, purpose: 'verify_email', seconds: 86400, auth_revision: user.auth_revision });
      await commitIdentity(c, [action.statement], { type: 'identity.verification_requested', resource_id: action.action.id,
        resource_revision: 1, account_id: user.id, data: { action_id: action.action.id, user_id: user.id } }, { credential_fence: false });
    }
    return c.json(accepted, 202);
  });

  route(app, 'POST', '/v1/auth/login', { summary: 'Sign in with a password', tags: ['identity'], body: loginSchema, public: true, sensitive: true }, async c => {
    const body = await jsonBody(c, loginSchema);
    const login = body.login.trim().toLowerCase();
    await identityRateLimit(c, 'login', login);
    noStore(c);
    const user = await one<UserRecord>(database(c), 'SELECT * FROM users WHERE email=? COLLATE NOCASE OR username=? COLLATE NOCASE', login, login);
    const valid = await verifyPassword(body.password, user?.password_hash ?? null);
    if (!valid || !user || user.disabled_at) {
      await auditStatement(database(c), { action: 'identity.login_failed', resource_id: user?.id ?? 'anonymous', actor_id: null,
        request_id: c.get('requestId') }).run();
      throw new ApiError(401, 'invalid_credentials', 'The sign-in details are incorrect.');
    }
    if (user.mfa_required === 1) {
      const action = await createIdentityAction(c.env, { user_id: user.id, purpose: 'login_mfa', seconds: 300, auth_revision: user.auth_revision });
      await commitIdentity(c, [...userEpochFence(c, user), action.statement], { type: 'identity.factor_requested', actor_id: user.id,
        resource_id: action.action.id, resource_revision: 1, account_id: user.id }, { credential_fence: false });
      return c.json({ mfa_required: true, token: action.token, expires_at: action.action.expires_at, methods: ['totp', 'recovery_code', 'passkey'] }, 202);
    }
    const session = await newSession(c, user, false);
    await commitIdentity(c, [...userEpochFence(c, user), session.statement], { type: 'identity.session_created', actor_id: user.id,
      resource_id: session.credential.id, resource_revision: 1, account_id: user.id }, { credential_fence: false });
    setSession(c, session.token, session.credential);
    return c.json({ user: publicUser(user, true), session: { id: session.credential.id, expires_at: session.credential.expires_at, mfa: false }, csrf: '1' });
  });

  route(app, 'POST', '/v1/auth/login/mfa', { summary: 'Complete a password sign-in with a second factor', tags: ['identity'], body: loginMfaSchema, public: true, sensitive: true }, async c => {
    const body = await jsonBody(c, loginMfaSchema);
    await identityRateLimit(c, 'login_mfa');
    const action = await findIdentityAction(database(c), body.token, 'login_mfa');
    const user = await one<UserRecord>(database(c), 'SELECT * FROM users WHERE id=?', action.user_id);
    if (!user) throw new ApiError(401, 'invalid_credentials', 'The sign-in request is invalid.');
    requireActionEpoch(action, user);
    await failedAction(c, action.id);
    const factor = await verifySecondFactor(c.env, user.id, body);
    const session = await newSession(c, user, true);
    await commitIdentity(c, [...userEpochFence(c, user), ...consumeAction(c, action), ...factor, session.statement], {
      type: 'identity.session_created', actor_id: user.id, resource_id: session.credential.id, resource_revision: 1, account_id: user.id,
    }, { credential_fence: false });
    setSession(c, session.token, session.credential);
    return c.json({ user: publicUser(user, true), session: { id: session.credential.id, expires_at: session.credential.expires_at, mfa: true }, csrf: '1' });
  });

  route(app, 'POST', '/v1/auth/logout', { summary: 'Revoke the current session', tags: ['identity'], sensitive: true, idempotent: false }, async c => {
    const principal = c.get('principal');
    if (principal?.credential_id) await commitIdentity(c, [stmt(database(c),
      'UPDATE credentials SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE id=? AND principal_id=?', now(), principal.credential_id, principal.id)],
    { type: 'identity.session_revoked', resource_id: principal.credential_id, resource_revision: 1, account_id: principal.user_id });
    clearSession(c);
    return c.body(null, 204);
  });

  route(app, 'POST', '/v1/auth/recover', { summary: 'Request account recovery', tags: ['identity'], body: recoverSchema, public: true, sensitive: true }, async c => {
    const body = await jsonBody(c, recoverSchema);
    await identityRateLimit(c, 'recover', body.email);
    const user = await one<UserRecord>(database(c), 'SELECT * FROM users WHERE email=? AND email_verified_at IS NOT NULL AND disabled_at IS NULL', body.email);
    if (user) {
      const action = await createIdentityAction(c.env, { user_id: user.id, purpose: 'recover_password', email: user.email, seconds: 1800, auth_revision: user.auth_revision });
      await commitIdentity(c, [action.statement], { type: 'identity.recovery_requested', resource_id: action.action.id,
        resource_revision: 1, account_id: user.id, data: { action_id: action.action.id, user_id: user.id } }, { credential_fence: false });
    }
    noStore(c);
    return c.json(accepted, 202);
  });

  route(app, 'POST', '/v1/auth/reset', { summary: 'Reset a password with a one-use recovery request', tags: ['identity'], body: resetSchema, public: true, sensitive: true }, async c => {
    const body = await jsonBody(c, resetSchema);
    await identityRateLimit(c, 'reset');
    const action = await findIdentityAction(database(c), body.token, 'recover_password');
    const user = await one<UserRecord>(database(c), 'SELECT * FROM users WHERE id=? AND email=?', action.user_id, action.email);
    if (!user) throw new ApiError(400, 'invalid_authentication_action', 'This recovery request is no longer valid.');
    requireActionEpoch(action, user);
    await failedAction(c, action.id);
    const factor = user.mfa_required === 1 ? await verifySecondFactor(c.env, user.id, body) : [];
    const passwordHash = await hashPassword(body.password);
    await commitIdentity(c, [
      ...consumeAction(c, action), ...factor,
      ...checkedWrite(database(c), stmt(database(c), 'UPDATE users SET password_hash=?,auth_revision=auth_revision+1,revision=revision+1,updated_at=? WHERE id=? AND auth_revision=? AND disabled_at IS NULL',
        passwordHash, now(), user.id, user.auth_revision)),
      stmt(database(c), 'UPDATE credentials SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE user_id=?', now(), user.id),
      stmt(database(c), 'UPDATE identity_actions SET consumed_at=COALESCE(consumed_at,?) WHERE user_id=?', now(), user.id),
    ], { type: 'identity.password_reset', actor_id: user.id, resource_id: user.id, resource_revision: user.revision + 1, account_id: user.id }, { credential_fence: false });
    clearSession(c);
    return c.json({ reset: true, sign_in_required: true });
  });

  route(app, 'PUT', '/v1/auth/password', { summary: 'Change the current account password', tags: ['identity'], body: changePasswordSchema, sensitive: true }, async c => {
    const user = await requireHuman(c, { recent: true, independent: true });
    const body = await jsonBody(c, changePasswordSchema);
    const revision = expectedRevision(c);
    await identityRateLimit(c, 'password_change', user.id);
    if (!await verifyPassword(body.current_password, user.password_hash)) throw new ApiError(401, 'invalid_credentials', 'The current password is incorrect.');
    const factor = user.mfa_required === 1 ? await verifySecondFactor(c.env, user.id, body) : [];
    const passwordHash = await hashPassword(body.password);
    await commitIdentity(c, [...factor, ...checkedWrite(database(c), stmt(database(c),
      'UPDATE users SET password_hash=?,auth_revision=auth_revision+1,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND auth_revision=?',
      passwordHash, now(), user.id, revision, user.auth_revision)),
    stmt(database(c), 'UPDATE credentials SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE user_id=?', now(), user.id)],
    { type: 'identity.password_changed', resource_id: user.id, resource_revision: revision + 1, account_id: user.id });
    clearSession(c);
    return c.json({ changed: true, sign_in_required: true });
  });

  route(app, 'POST', '/v1/auth/reauthenticate', { summary: 'Confirm identity and rotate the current session', tags: ['identity'], body: reauthenticateSchema, sensitive: true }, async c => {
    const user = await requireHuman(c, { verified: false });
    const body = await jsonBody(c, reauthenticateSchema);
    await identityRateLimit(c, 'reauthenticate', user.id);
    if (!await verifyPassword(body.password, user.password_hash)) throw new ApiError(401, 'invalid_credentials', 'The password is incorrect.');
    const factor = user.mfa_required === 1 ? await verifySecondFactor(c.env, user.id, body) : [];
    const session = await newSession(c, user, user.mfa_required === 1);
    await commitIdentity(c, [...userEpochFence(c, user), ...factor, session.statement,
      stmt(database(c), 'UPDATE credentials SET revoked_at=?,revision=revision+1 WHERE id=? AND principal_id=?', now(), c.get('principal')!.credential_id, user.id)],
    { type: 'identity.session_reauthenticated', resource_id: session.credential.id, resource_revision: 1, account_id: user.id });
    setSession(c, session.token, session.credential);
    return c.json({ user: publicUser(user, true), session: { id: session.credential.id, expires_at: session.credential.expires_at, mfa: session.credential.mfa === 1 }, csrf: '1' });
  });
}
