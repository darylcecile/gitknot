import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { z } from 'zod';
import { identityDatabase as database } from '@gitknot/core/authority';
import { ApiError, base64url, bytes, expectedRevision, fromBase64url, jsonBody, listResponse, many, newId, now, one, page, route, stmt, type App } from '@gitknot/core';
import { checkedWrite, createIdentityAction, findIdentityAction, identityRateLimit, prepareRecoveryCodes, requireHuman, type UserRecord } from '@gitknot/core/auth';
import { commitIdentity, consumeAction, failedAction, newSession, noStore, publicUser, requireActionEpoch, revisionResponse, setSession, tokenSchema, userEpochFence } from './shared.ts';

interface Passkey {
  id: string; user_id: string; credential_id: string; public_key: string; counter: number; transports_json: string;
  device_type: 'singleDevice' | 'multiDevice'; backed_up: number; name: string; revision: number; created_at: string; last_used_at: string | null;
}

const encoded = z.string().min(1).max(131072).regex(/^[A-Za-z0-9_-]+$/);
const extensions = z.record(z.string(), z.unknown());
const registerOptionsSchema = z.object({ name: z.string().trim().min(1).max(100), require_mfa: z.boolean().default(true) }).strict();
const registerResponseSchema = z.object({ id: encoded, rawId: encoded, type: z.literal('public-key'),
  response: z.object({ clientDataJSON: encoded, attestationObject: encoded, transports: z.array(z.string().max(32)).max(10).optional(),
    authenticatorData: encoded.optional(), publicKey: encoded.optional(), publicKeyAlgorithm: z.number().int().optional() }).strict(),
  clientExtensionResults: extensions, authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
}).strict();
const authenticateResponseSchema = z.object({ id: encoded, rawId: encoded, type: z.literal('public-key'),
  response: z.object({ clientDataJSON: encoded, authenticatorData: encoded, signature: encoded, userHandle: encoded.optional() }).strict(),
  clientExtensionResults: extensions, authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
}).strict();
const registerVerifySchema = z.object({ token: tokenSchema, response: registerResponseSchema }).strict();
const authenticateOptionsSchema = z.object({ reauthenticate: z.boolean().default(false) }).strict();
const authenticateVerifySchema = z.object({ token: tokenSchema, response: authenticateResponseSchema }).strict();
const renameSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();

function publicPasskey(key: Passkey): Record<string, unknown> & { revision: number } {
  return { id: key.id, name: key.name, device_type: key.device_type, backed_up: key.backed_up === 1,
    created_at: key.created_at, last_used_at: key.last_used_at, revision: key.revision };
}

function relyingParty(origin: string): { rpID: string; origin: string } {
  const url = new URL(origin);
  return { rpID: url.hostname, origin: url.origin };
}

export function registerPasskeyRoutes(app: App): void {
  route(app, 'GET', '/v1/auth/passkeys', { summary: 'List registered passkeys', tags: ['identity'] }, async c => {
    const user = await requireHuman(c, { verified: false });
    const { limit, cursor } = page(c);
    const keys = await many<Passkey>(database(c), 'SELECT * FROM passkeys WHERE user_id=? AND id>? ORDER BY id LIMIT ?', user.id, cursor ?? '', limit + 1);
    const items = keys.slice(0, limit);
    return listResponse(c, items.map(publicPasskey), keys.length > limit ? items.at(-1)!.id : null);
  });

  route(app, 'POST', '/v1/auth/passkeys/registration/options', { summary: 'Start passkey registration', tags: ['identity'], body: registerOptionsSchema, sensitive: true }, async c => {
    const user = await requireHuman(c, { recent: true, independent: true });
    const body = await jsonBody(c, registerOptionsSchema);
    await identityRateLimit(c, 'passkey_register', user.id);
    const keys = await many<Passkey>(database(c), 'SELECT * FROM passkeys WHERE user_id=? ORDER BY id LIMIT 21', user.id);
    if (keys.length >= 20) throw new ApiError(409, 'passkey_limit', 'Remove an unused passkey before registering another.');
    const { rpID } = relyingParty(c.env.APP_ORIGIN);
    const options = await generateRegistrationOptions({ rpName: 'GitKnot', rpID, userID: bytes(user.id), userName: user.username,
      userDisplayName: user.display_name, timeout: 60000, attestationType: 'none', supportedAlgorithmIDs: [-7, -257, -8],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: keys.map(key => ({ id: key.credential_id, transports: JSON.parse(key.transports_json) as string[] })) });
    const action = await createIdentityAction(c.env, { purpose: 'passkey_register', user_id: user.id,
      credential_id: c.get('principal')!.credential_id, challenge: options.challenge, seconds: 300, auth_revision: user.auth_revision,
      data: { name: body.name, require_mfa: body.require_mfa } });
    await commitIdentity(c, [...userEpochFence(c, user), action.statement], { type: 'identity.passkey_registration_requested', resource_id: action.action.id,
      resource_revision: 1, account_id: user.id });
    noStore(c);
    return c.json({ options, token: action.token, expires_at: action.action.expires_at });
  });

  route(app, 'POST', '/v1/auth/passkeys/registration/verify', { summary: 'Verify and save a new passkey', tags: ['identity'], body: registerVerifySchema, sensitive: true }, async c => {
    const user = await requireHuman(c, { recent: true, independent: true });
    const revision = expectedRevision(c);
    const body = await jsonBody(c, registerVerifySchema);
    await identityRateLimit(c, 'passkey_register_verify', user.id);
    const action = await findIdentityAction(database(c), body.token, 'passkey_register');
    requireActionEpoch(action, user);
    if (action.user_id !== user.id || action.credential_id !== c.get('principal')!.credential_id || !action.challenge) {
      throw new ApiError(400, 'invalid_authentication_action', 'Start passkey registration again in this session.');
    }
    await failedAction(c, action.id);
    const { rpID, origin } = relyingParty(c.env.APP_ORIGIN);
    let verification;
    try { verification = await verifyRegistrationResponse({ response: body.response as RegistrationResponseJSON, expectedChallenge: action.challenge,
      expectedOrigin: origin, expectedRPID: rpID, requireUserPresence: true, requireUserVerification: true, supportedAlgorithmIDs: [-7, -257, -8] }); }
    catch { throw new ApiError(401, 'invalid_passkey_response', 'GitKnot could not verify this passkey registration.'); }
    if (!verification.verified) throw new ApiError(401, 'invalid_passkey_response', 'GitKnot could not verify this passkey registration.');
    const info = verification.registrationInfo;
    const metadata = registerOptionsSchema.parse(JSON.parse(action.data_json));
    const id = newId('pk');
    const required = user.mfa_required === 1 || metadata.require_mfa;
    const recovery = required && user.mfa_required === 0 ? await prepareRecoveryCodes(database(c), user.id) : null;
    const session = await newSession(c, { ...user, mfa_required: Number(required), auth_revision: user.auth_revision + 1 }, true);
    await commitIdentity(c, [
      ...consumeAction(c, action),
      stmt(database(c), `INSERT INTO passkeys(id,user_id,credential_id,public_key,counter,transports_json,device_type,backed_up,name,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, id, user.id, info.credential.id, base64url(info.credential.publicKey), info.credential.counter,
      JSON.stringify(info.credential.transports ?? []), info.credentialDeviceType, Number(info.credentialBackedUp), metadata.name, now()),
      ...checkedWrite(database(c), stmt(database(c), 'UPDATE users SET mfa_required=?,auth_revision=auth_revision+1,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND auth_revision=?',
        Number(required), now(), user.id, revision, user.auth_revision)),
      ...(recovery?.statements ?? []),
      stmt(database(c), 'UPDATE credentials SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE user_id=?', now(), user.id), session.statement,
    ], { type: 'identity.passkey_registered', resource_id: id, resource_revision: 1, account_id: user.id });
    setSession(c, session.token, session.credential);
    return revisionResponse(c, { id, name: metadata.name, mfa_required: required, ...(recovery ? { recovery_codes: recovery.codes } : {}),
      user_revision: revision + 1, revision: 1 }, 201);
  });

  route(app, 'POST', '/v1/auth/passkeys/authentication/options', { summary: 'Start passkey sign-in or session confirmation', tags: ['identity'], body: authenticateOptionsSchema, public: true, sensitive: true }, async c => {
    const body = await jsonBody(c, authenticateOptionsSchema);
    await identityRateLimit(c, 'passkey_authenticate');
    const user = body.reauthenticate ? await requireHuman(c, { verified: false }) : null;
    const { rpID } = relyingParty(c.env.APP_ORIGIN);
    const options = await generateAuthenticationOptions({ rpID, timeout: 60000, userVerification: 'required' });
    const action = await createIdentityAction(c.env, { purpose: 'passkey_authenticate', user_id: user?.id,
      credential_id: body.reauthenticate ? c.get('principal')!.credential_id : null, auth_revision: user?.auth_revision,
      challenge: options.challenge, seconds: 300 });
    await commitIdentity(c, [action.statement], { type: 'identity.passkey_authentication_requested', resource_id: action.action.id,
      resource_revision: 1, account_id: user?.id }, { credential_fence: body.reauthenticate });
    noStore(c);
    return c.json({ options, token: action.token, expires_at: action.action.expires_at });
  });

  route(app, 'POST', '/v1/auth/passkeys/authentication/verify', { summary: 'Verify a passkey and create a session', tags: ['identity'], body: authenticateVerifySchema, public: true, sensitive: true }, async c => {
    const body = await jsonBody(c, authenticateVerifySchema);
    await identityRateLimit(c, 'passkey_authenticate_verify');
    const action = await findIdentityAction(database(c), body.token, 'passkey_authenticate');
    const passkey = await one<Passkey>(database(c), 'SELECT * FROM passkeys WHERE credential_id=?', body.response.id);
    const user = passkey ? await one<UserRecord>(database(c), 'SELECT * FROM users WHERE id=? AND disabled_at IS NULL', passkey.user_id) : null;
    if (!user || !passkey || !action.challenge || body.response.response.userHandle !== base64url(bytes(user.id))) {
      throw new ApiError(401, 'invalid_passkey_response', 'GitKnot could not verify this passkey sign-in.');
    }
    if (action.user_id && (action.user_id !== user.id || action.auth_revision !== user.auth_revision
      || action.credential_id !== c.get('principal')?.credential_id)) throw new ApiError(401, 'invalid_passkey_response', 'Confirm the account signed in to this session.');
    await identityRateLimit(c, 'passkey_user', user.id);
    await failedAction(c, action.id);
    const { rpID, origin } = relyingParty(c.env.APP_ORIGIN);
    let verification;
    try { verification = await verifyAuthenticationResponse({ response: body.response as AuthenticationResponseJSON,
      expectedChallenge: action.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
      credential: { id: passkey.credential_id, publicKey: fromBase64url(passkey.public_key), counter: passkey.counter,
        transports: JSON.parse(passkey.transports_json) as string[] } }); }
    catch { throw new ApiError(401, 'invalid_passkey_response', 'GitKnot could not verify this passkey sign-in.'); }
    if (!verification.verified || !verification.authenticationInfo.userVerified) throw new ApiError(401, 'invalid_passkey_response', 'The passkey did not verify your identity.');
    const session = await newSession(c, user, true);
    await commitIdentity(c, [
      ...userEpochFence(c, user), ...consumeAction(c, action),
      ...checkedWrite(database(c), stmt(database(c), 'UPDATE passkeys SET counter=?,backed_up=?,last_used_at=?,revision=revision+1 WHERE id=? AND user_id=? AND revision=? AND counter=?',
        verification.authenticationInfo.newCounter, Number(verification.authenticationInfo.credentialBackedUp), now(), passkey.id, user.id, passkey.revision, passkey.counter)),
      ...(action.credential_id ? [stmt(database(c), 'UPDATE credentials SET revoked_at=?,revision=revision+1 WHERE id=? AND user_id=?', now(), action.credential_id, user.id)] : []), session.statement,
    ], { type: 'identity.session_created', actor_id: user.id, resource_id: session.credential.id, resource_revision: 1, account_id: user.id }, { credential_fence: !!action.credential_id });
    setSession(c, session.token, session.credential);
    return c.json({ user: publicUser(user, true), session: { id: session.credential.id, expires_at: session.credential.expires_at, mfa: true }, csrf: '1' });
  });

  route(app, 'PATCH', '/v1/auth/passkeys/:id', { summary: 'Rename a passkey', tags: ['identity'], body: renameSchema }, async c => {
    const user = await requireHuman(c, { recent: true, independent: true });
    const body = await jsonBody(c, renameSchema);
    const revision = expectedRevision(c);
    await commitIdentity(c, checkedWrite(database(c), stmt(database(c), 'UPDATE passkeys SET name=?,revision=revision+1 WHERE id=? AND user_id=? AND revision=?',
      body.name, c.req.param('id'), user.id, revision)), { type: 'identity.passkey_renamed', resource_id: c.req.param('id')!, resource_revision: revision + 1, account_id: user.id });
    const key = await one<Passkey>(database(c), 'SELECT * FROM passkeys WHERE id=? AND user_id=?', c.req.param('id'), user.id);
    return revisionResponse(c, publicPasskey(key!));
  });

  route(app, 'DELETE', '/v1/auth/passkeys/:id', { summary: 'Remove a registered passkey', tags: ['identity'] }, async c => {
    const user = await requireHuman(c, { recent: true, independent: true });
    const revision = expectedRevision(c);
    const factors = await one<{ count: number }>(database(c), `SELECT (SELECT COUNT(*) FROM passkeys WHERE user_id=? AND id!=?)
      +(SELECT COUNT(*) FROM user_mfa WHERE user_id=? AND enabled_at IS NOT NULL) AS count`, user.id, c.req.param('id'), user.id);
    if (user.mfa_required === 1 && !factors?.count) throw new ApiError(409, 'last_mfa_factor', 'Add another factor or explicitly disable MFA before removing the last factor.');
    const session = await newSession(c, { ...user, auth_revision: user.auth_revision + 1 }, c.get('principal')!.mfa);
    await commitIdentity(c, [
      ...checkedWrite(database(c), stmt(database(c), 'DELETE FROM passkeys WHERE id=? AND user_id=? AND revision=?', c.req.param('id'), user.id, revision)),
      ...checkedWrite(database(c), stmt(database(c), 'UPDATE users SET auth_revision=auth_revision+1,revision=revision+1,updated_at=? WHERE id=? AND auth_revision=?', now(), user.id, user.auth_revision)),
      stmt(database(c), 'UPDATE credentials SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE user_id=?', now(), user.id), session.statement,
    ], { type: 'identity.passkey_removed', resource_id: c.req.param('id')!, resource_revision: revision + 1, account_id: user.id });
    setSession(c, session.token, session.credential);
    return c.body(null, 204);
  });
}
