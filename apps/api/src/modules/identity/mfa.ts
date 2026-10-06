import { z } from 'zod';
import { identityDatabase as database } from '@gitknot/core/authority';
import { ApiError, expectedRevision, jsonBody, now, one, randomToken, route, stmt, type App } from '@gitknot/core';
import { afterSeconds, base32, checkedWrite, identityKeys, identityRateLimit, mfaSecret, prepareRecoveryCodes, requireHuman,
  verifySecondFactor, verifyTotp, type MfaRecord } from '@gitknot/core/auth';
import { commitIdentity, emptySchema, newSession, noStore, proofSchema, revisionResponse, setSession } from './shared.ts';

const confirmSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
const requireMfaSchema = z.object({ required: z.boolean(), ...proofSchema.shape }).strict();

export function registerMfaRoutes(app: App): void {
  route(app, 'GET', '/v1/auth/mfa', { summary: 'List configured authentication factors', tags: ['identity'] }, async c => {
    const user = await requireHuman(c, { verified: false });
    const mfa = await one<{ enabled_at: string | null }>(database(c), 'SELECT enabled_at FROM user_mfa WHERE user_id=?', user.id);
    const passkeys = await one<{ count: number }>(database(c), 'SELECT COUNT(*) AS count FROM passkeys WHERE user_id=?', user.id);
    const recovery = await one<{ count: number }>(database(c), 'SELECT COUNT(*) AS count FROM recovery_codes WHERE user_id=? AND consumed_at IS NULL', user.id);
    return revisionResponse(c, { required: user.mfa_required === 1, totp_enabled: !!mfa?.enabled_at,
      passkeys: passkeys?.count ?? 0, recovery_codes_remaining: recovery?.count ?? 0, revision: user.revision });
  });

  route(app, 'POST', '/v1/auth/mfa/totp/setup', { summary: 'Start authenticator-app enrollment', tags: ['identity'], body: emptySchema, sensitive: true }, async c => {
    const user = await requireHuman(c, { recent: true, independent: true });
    const revision = expectedRevision(c);
    await identityRateLimit(c, 'mfa_setup', user.id);
    const existing = await one<MfaRecord>(database(c), 'SELECT * FROM user_mfa WHERE user_id=?', user.id);
    if (existing?.enabled_at) throw new ApiError(409, 'factor_already_enabled', 'Remove the existing authenticator factor before replacing it.');
    const record: MfaRecord = { user_id: user.id, salt: randomToken(), key_id: identityKeys(c.env).current, last_counter: -1,
      enabled_at: null, setup_expires_at: afterSeconds(600), revision: (existing?.revision ?? 0) + 1, created_at: now() };
    const secret = await mfaSecret(c.env, record);
    const encoded = base32(secret);
    secret.fill(0);
    await commitIdentity(c, [
      ...checkedWrite(database(c), stmt(database(c), 'UPDATE users SET revision=revision+1,updated_at=? WHERE id=? AND revision=?', now(), user.id, revision)),
      stmt(database(c), `INSERT INTO user_mfa(user_id,salt,key_id,setup_expires_at,created_at,revision) VALUES (?,?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET salt=excluded.salt,key_id=excluded.key_id,setup_expires_at=excluded.setup_expires_at,
        last_counter=-1,revision=excluded.revision WHERE user_mfa.enabled_at IS NULL`,
      user.id, record.salt, record.key_id, record.setup_expires_at, record.created_at, record.revision),
    ], { type: 'identity.mfa_enrollment_started', resource_id: user.id, resource_revision: revision + 1, account_id: user.id });
    noStore(c);
    return revisionResponse(c, { secret: encoded, otpauth_uri: `otpauth://totp/${encodeURIComponent(`GitKnot:${user.email}`)}?secret=${encoded}&issuer=GitKnot&algorithm=SHA1&digits=6&period=30`,
      expires_at: record.setup_expires_at, revision: revision + 1 });
  });

  route(app, 'POST', '/v1/auth/mfa/totp/verify', { summary: 'Verify and enable an authenticator app', tags: ['identity'], body: confirmSchema, sensitive: true }, async c => {
    const user = await requireHuman(c, { recent: true, independent: true });
    const revision = expectedRevision(c);
    const body = await jsonBody(c, confirmSchema);
    await identityRateLimit(c, 'mfa_verify', user.id);
    const mfa = await one<MfaRecord>(database(c), 'SELECT * FROM user_mfa WHERE user_id=? AND enabled_at IS NULL AND setup_expires_at>?', user.id, now());
    const counter = mfa ? await verifyTotp(c.env, mfa, body.code) : null;
    if (!mfa || counter === null) throw new ApiError(401, 'invalid_second_factor', 'The authenticator code is incorrect or enrollment expired.');
    const recovery = await prepareRecoveryCodes(database(c), user.id);
    const updated = { ...user, mfa_required: 1, auth_revision: user.auth_revision + 1, revision: revision + 1 };
    const session = await newSession(c, updated, true);
    await commitIdentity(c, [
      ...checkedWrite(database(c), stmt(database(c), 'UPDATE user_mfa SET enabled_at=?,last_counter=?,revision=revision+1 WHERE user_id=? AND revision=? AND enabled_at IS NULL AND setup_expires_at>?',
        now(), counter, user.id, mfa.revision, now())),
      ...checkedWrite(database(c), stmt(database(c), 'UPDATE users SET mfa_required=1,auth_revision=auth_revision+1,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND auth_revision=?', now(), user.id, revision, user.auth_revision)),
      ...recovery.statements,
      stmt(database(c), 'UPDATE credentials SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE user_id=?', now(), user.id),
      session.statement,
    ], { type: 'identity.mfa_enabled', resource_id: user.id, resource_revision: revision + 1, account_id: user.id });
    setSession(c, session.token, session.credential);
    return revisionResponse(c, { enabled: true, recovery_codes: recovery.codes, revision: revision + 1 });
  });

  route(app, 'DELETE', '/v1/auth/mfa/totp', { summary: 'Remove an authenticator-app factor', tags: ['identity'], body: proofSchema, sensitive: true }, async c => {
    const user = await requireHuman(c, { recent: true, mfa: true, independent: true });
    const revision = expectedRevision(c);
    const body = await jsonBody(c, proofSchema);
    await identityRateLimit(c, 'mfa_remove', user.id);
    const factor = await verifySecondFactor(c.env, user.id, body);
    const keys = await one<{ count: number }>(database(c), 'SELECT COUNT(*) AS count FROM passkeys WHERE user_id=?', user.id);
    const required = (keys?.count ?? 0) > 0 ? user.mfa_required : 0;
    const updated = { ...user, mfa_required: required, auth_revision: user.auth_revision + 1 };
    const session = await newSession(c, updated, required === 1);
    await commitIdentity(c, [
      ...factor,
      ...checkedWrite(database(c), stmt(database(c), 'UPDATE users SET mfa_required=?,auth_revision=auth_revision+1,revision=revision+1,updated_at=? WHERE id=? AND revision=?', required, now(), user.id, revision)),
      stmt(database(c), 'DELETE FROM user_mfa WHERE user_id=?', user.id),
      ...(required ? [] : [stmt(database(c), 'DELETE FROM recovery_codes WHERE user_id=?', user.id)]),
      stmt(database(c), 'UPDATE credentials SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE user_id=?', now(), user.id), session.statement,
    ], { type: 'identity.mfa_factor_removed', resource_id: user.id, resource_revision: revision + 1, account_id: user.id });
    setSession(c, session.token, session.credential);
    return revisionResponse(c, { totp_enabled: false, mfa_required: required === 1, revision: revision + 1 });
  });

  route(app, 'POST', '/v1/auth/mfa/recovery-codes', { summary: 'Rotate one-use MFA recovery codes', tags: ['identity'], body: emptySchema, sensitive: true }, async c => {
    const user = await requireHuman(c, { recent: true, mfa: true, independent: true });
    const revision = expectedRevision(c);
    if (!user.mfa_required) throw new ApiError(409, 'mfa_not_enabled', 'Enable multifactor authentication before creating recovery codes.');
    const recovery = await prepareRecoveryCodes(database(c), user.id);
    await commitIdentity(c, [...checkedWrite(database(c), stmt(database(c), 'UPDATE users SET revision=revision+1,updated_at=? WHERE id=? AND revision=?', now(), user.id, revision)),
      ...recovery.statements], { type: 'identity.recovery_codes_rotated', resource_id: user.id, resource_revision: revision + 1, account_id: user.id });
    noStore(c);
    return revisionResponse(c, { recovery_codes: recovery.codes, revision: revision + 1 });
  });

  route(app, 'PUT', '/v1/auth/mfa', { summary: 'Require a second factor for password sign-in', tags: ['identity'], body: requireMfaSchema, sensitive: true }, async c => {
    const user = await requireHuman(c, { recent: true, independent: true });
    const body = await jsonBody(c, requireMfaSchema);
    const revision = expectedRevision(c);
    const factors = await one<{ count: number }>(database(c), `SELECT (SELECT COUNT(*) FROM passkeys WHERE user_id=?)
      +(SELECT COUNT(*) FROM user_mfa WHERE user_id=? AND enabled_at IS NOT NULL) AS count`, user.id, user.id);
    if (body.required && !factors?.count) throw new ApiError(409, 'factor_required', 'Register a passkey or authenticator app first.');
    if (body.required && !c.get('principal')!.mfa) throw new ApiError(403, 'mfa_required', 'Confirm identity with your passkey or authenticator app.');
    const factor = !body.required && user.mfa_required === 1 && (body.code || body.recovery_code) ? await verifySecondFactor(c.env, user.id, body) : [];
    const recovery = body.required && user.mfa_required === 0 ? await prepareRecoveryCodes(database(c), user.id) : null;
    const session = await newSession(c, { ...user, mfa_required: Number(body.required), auth_revision: user.auth_revision + 1 }, body.required);
    await commitIdentity(c, [...factor, ...checkedWrite(database(c), stmt(database(c),
      'UPDATE users SET mfa_required=?,auth_revision=auth_revision+1,revision=revision+1,updated_at=? WHERE id=? AND revision=?',
      Number(body.required), now(), user.id, revision)), ...(recovery?.statements ?? []),
    stmt(database(c), 'UPDATE credentials SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE user_id=?', now(), user.id), session.statement],
    { type: 'identity.mfa_requirement_changed', resource_id: user.id, resource_revision: revision + 1, account_id: user.id });
    setSession(c, session.token, session.credential);
    return revisionResponse(c, { required: body.required, ...(recovery ? { recovery_codes: recovery.codes } : {}), revision: revision + 1 });
  });
}
