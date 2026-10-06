import { z } from 'zod';
import { identityDatabase as database, readRepositoryAuthority } from '@gitknot/core/authority';
import { ApiError, authorize, expectedRevision, jsonBody, listResponse, many, newId, now, one, page, principalForExplanation, requirePrincipal, route, stmt,
  type App, type AppContext, type PermissionExplanation, type PrincipalKind, type Repository } from '@gitknot/core';
import { afterSeconds, checkedWrite, credentialScope, isFederationSession, prepareDerivedCredential, publicCredential, requireHuman,
  type CredentialKind, type CredentialRecord, type UserRecord } from '@gitknot/core/auth';
import { capabilityPatternSchema, readAccountPolicy, resourcePatternSchema } from '@gitknot/core/policy';
import { commitIdentity, idSchema, noStore, revisionResponse } from './shared.ts';
import { assertDelegable } from '../accounts/shared.ts';

const scopesSchema = z.object({
  name: z.string().trim().min(1).max(100), kind: z.enum(['personal', 'service', 'agent', 'installation', 'viewer']).default('personal'),
  principal_id: idSchema.optional(), capabilities: z.array(capabilityPatternSchema.refine(value => !value.includes('*'), 'Credentials require concrete capabilities.')).min(1).max(64),
  repository_ids: z.array(idSchema).max(100).default([]), account_ids: z.array(idSchema).max(20).default([]),
  ref_patterns: z.array(resourcePatternSchema).min(1).max(64).optional(), path_patterns: z.array(resourcePatternSchema).min(1).max(64).optional(),
  expires_at: z.iso.datetime(),
}).strict().refine(value => value.repository_ids.length + value.account_ids.length > 0, 'Explicit repository or account scopes are required.');
const renameSchema = z.object({ name: z.string().trim().min(1).max(100) }).strict();
const rotateSchema = z.object({ expires_at: z.iso.datetime().optional() }).strict();
type TokenInput = z.infer<typeof scopesSchema>;
interface ScopedPrincipal { id: string; kind: PrincipalKind; account_id: string | null; disabled_at: string | null; expires_at: string | null }

function validExpiry(value: string, maximumSeconds: number): void {
  const duration = Date.parse(value) - Date.now();
  if (duration < 60_000 || duration > maximumSeconds * 1000) throw new ApiError(422, 'invalid_token_expiry', `Token expiration must be between one minute and ${maximumSeconds} seconds from now.`);
}

async function scopesForToken(c: AppContext, body: TokenInput): Promise<{ account_ids: string[]; repositories: Repository[]; authorizations: PermissionExplanation[] }> {
  const accountIds = new Set(body.account_ids);
  const repositories: Repository[] = [];
  const authorizations: PermissionExplanation[] = [];
  for (const id of new Set(body.repository_ids)) {
    const repository = await readRepositoryAuthority(c, id);
    if (!repository) throw new ApiError(404, 'not_found', 'The requested repository was not found.');
    if (body.account_ids.length && !accountIds.has(repository.owner_id)) throw new ApiError(422, 'token_scope_mismatch', 'Every repository must belong to an included account.');
    accountIds.add(repository.owner_id);
    authorizations.push(await authorize(c, body.kind === 'viewer' ? 'permissions.manage' : 'repositories.read', { repo_id: id }));
    repositories.push(repository);
  }
  for (const id of accountIds) {
    if (body.account_ids.includes(id)) authorizations.push(await authorize(c, 'accounts.read', { account_id: id }));
    // A repository-scoped credential need not have account-wide token-management
    // authority to derive a child: its parent chain remains an enforced ceiling.
    const scope = body.account_ids.includes(id) ? { account_id: id } : { repo_id: repositories.find(repository => repository.owner_id === id)!.id };
    const actor = requirePrincipal(c);
    const session = actor.credential_id ? await one<{ kind: string }>(database(c), 'SELECT kind FROM credentials WHERE id=?', actor.credential_id) : null;
    const federatedSelf = actor.kind === 'user' && session?.kind === 'session' && actor.credential_id
      && await isFederationSession(database(c), actor.credential_id);
    if (!federatedSelf) authorizations.push(await authorize(c, 'tokens.manage', actor.user_id && session?.kind === 'session' && body.kind !== 'viewer'
      ? { account_id: actor.user_id } : scope));
    const { policy } = await readAccountPolicy(database(c), id);
    if (!policy.allowed_credential_kinds.includes(body.kind)) throw new ApiError(403, 'credential_kind_denied', 'Account policy does not permit this credential type.');
    validExpiry(body.expires_at, policy.maximum_token_lifetime_seconds);
    if (body.kind === 'viewer' && !policy.allow_outside_collaborators) throw new ApiError(403, 'viewer_grants_disabled', 'Account policy does not allow shared viewer grants.');
  }
  return { account_ids: [...accountIds], repositories, authorizations };
}

function subset(requested: string[], ceiling: string[] | null, message: string): void {
  if (ceiling !== null && requested.some(value => !ceiling.includes(value))) throw new ApiError(403, 'credential_scope_exceeded', message);
}

async function tokenActor(c: AppContext): Promise<{ parent: CredentialRecord; user: UserRecord | null }> {
  const actor = requirePrincipal(c);
  const parent = await one<CredentialRecord>(database(c), 'SELECT * FROM credentials WHERE id=? AND principal_id=?', actor.credential_id, actor.id);
  if (!parent) throw new ApiError(401, 'authentication_required', 'A current GitKnot credential is required.');
  const user = actor.kind === 'user' ? await requireHuman(c, { recent: parent.kind === 'session' }) : null;
  return { parent, user };
}

async function ownedToken(c: AppContext, id: string | undefined, recent = true): Promise<CredentialRecord> {
  if (!id) throw new ApiError(404, 'not_found', 'The requested credential was not found.');
  const actor = requirePrincipal(c);
  const token = await one<CredentialRecord>(database(c), "SELECT * FROM credentials WHERE id=? AND kind!='session' AND (created_by=? OR principal_id=?)", id, actor.id, actor.id);
  if (!token) throw new ApiError(404, 'not_found', 'The requested credential was not found.');
  if (actor.kind === 'user') {
    if (token.id === actor.credential_id) await requireHuman(c);
    else {
      await requireHuman(c, { recent });
      if (actor.credential_id && await isFederationSession(database(c), actor.credential_id)) {
        const accounts = credentialScope(token.account_ids_json);
        if (token.principal_id !== actor.id || accounts === null || actor.account_ids === null
          || accounts.some(id => !actor.account_ids!.includes(id))) {
          throw new ApiError(404, 'not_found', 'The requested credential was not found.');
        }
      } else await authorize(c, recent ? 'tokens.manage' : 'tokens.revoke', { account_id: actor.user_id! });
    }
  }
  else if (token.id !== actor.credential_id) {
    const accountIds = credentialScope(token.account_ids_json) ?? [];
    if (!accountIds.length) throw new ApiError(403, 'credential_scope_exceeded', 'This credential cannot manage another identity.');
    for (const accountId of accountIds) await authorize(c, 'tokens.manage', { account_id: accountId });
  }
  return token;
}

export function registerTokenRoutes(app: App): void {
  route(app, 'GET', '/v1/tokens', { summary: 'List your token credentials without secret values', tags: ['credentials'], capability: 'tokens.read' }, async c => {
    const user = await requireHuman(c, { recent: true, independent: true });
    const { limit, cursor } = page(c);
    const tokens = await many<CredentialRecord>(database(c), "SELECT * FROM credentials WHERE created_by=? AND kind!='session' AND id>? ORDER BY id LIMIT ?", user.id, cursor ?? '', limit + 1);
    const items = tokens.slice(0, limit);
    return listResponse(c, items.map(publicCredential), tokens.length > limit ? items.at(-1)!.id : null);
  });

  route(app, 'GET', '/v1/tokens/current', { summary: 'Inspect the credential used for this request', tags: ['credentials'] }, async c => {
    const actor = requirePrincipal(c);
    const token = await one<CredentialRecord>(database(c), 'SELECT * FROM credentials WHERE id=? AND principal_id=?', actor.credential_id, actor.id);
    if (!token) throw new ApiError(401, 'authentication_required', 'A GitKnot credential is required.');
    return revisionResponse(c, { ...publicCredential(token), account_ids: actor.account_ids, revision: token.revision });
  });

  route(app, 'POST', '/v1/tokens', { summary: 'Issue a scoped, expiring token or private viewer grant', tags: ['credentials'], body: scopesSchema, sensitive: true }, async c => {
    const actor = requirePrincipal(c);
    const body = await jsonBody(c, scopesSchema);
    const { parent, user } = await tokenActor(c);
    if (body.kind === 'personal' && body.principal_id && body.principal_id !== actor.id) {
      throw new ApiError(403, 'personal_credential_owner_required', 'Personal tokens can only represent the authenticated user.');
    }
    if (await isFederationSession(database(c), parent.id) && body.kind !== 'personal') {
      throw new ApiError(403, 'federation_credential_scope', 'SSO-derived credentials must remain personal tokens for the verified user.');
    }
    validExpiry(body.expires_at, body.kind === 'installation' ? 3600 : body.kind === 'viewer' ? 7 * 86400 : body.kind === 'personal' ? 365 * 86400 : 86400);
    const scope = await scopesForToken(c, body);
    const statements: D1PreparedStatement[] = [];
    let principalId = body.principal_id ?? actor.id;
    if (parent.kind !== 'session') {
      if (Date.parse(body.expires_at) > Date.parse(parent.expires_at)) throw new ApiError(403, 'credential_lifetime_exceeded', 'A derived credential cannot outlive its parent.');
      subset(body.capabilities, credentialScope(parent.capabilities_json), 'A derived credential cannot request capabilities outside its parent.');
      subset(body.repository_ids, credentialScope(parent.repository_ids_json), 'A derived credential cannot include additional repositories.');
      subset(scope.account_ids, credentialScope(parent.account_ids_json), 'A derived credential cannot include additional accounts.');
      if (credentialScope(parent.repository_ids_json) !== null && !body.repository_ids.length) throw new ApiError(403, 'credential_scope_exceeded', 'A repository-scoped parent cannot issue an account-wide credential.');
    }
    if (body.kind === 'viewer') {
      if (body.repository_ids.length !== 1 || body.account_ids.length || body.principal_id || body.ref_patterns || body.path_patterns
        || body.capabilities.some(capability => !['contents.read', 'repositories.read', 'issues.read', 'pull_requests.read', 'discussions.read', 'workflows.read', 'runs.read', 'releases.read', 'lfs.read', 'attachments.read', 'search.read'].includes(capability))) {
        throw new ApiError(422, 'invalid_viewer_scope', 'A viewer grant must contain one repository and read-only capabilities.');
      }
      await assertDelegable(c, body.capabilities.map(capability => ({ capability, effect: 'allow' })), { repo_id: body.repository_ids[0] });
      principalId = newId('viewer');
      statements.push(stmt(database(c), "INSERT INTO principals(id,kind,account_id,name,expires_at,created_by,created_at,updated_at) VALUES (?,'viewer',?,?,?,?,?,?)",
        principalId, scope.account_ids[0], body.name, body.expires_at, actor.id, now(), now()),
      ...[...new Set(body.capabilities)].map(capability => stmt(database(c), `INSERT INTO access_grants(id,account_id,repo_id,principal_type,principal_id,capability,expires_at,created_by,created_at,updated_at)
        VALUES (?,?,?,'viewer',?,?,?,?,?,?)`, newId('grant'), scope.account_ids[0], body.repository_ids[0], principalId, capability, body.expires_at, actor.id, now(), now())));
    } else {
      const principal = await one<ScopedPrincipal>(database(c), 'SELECT id,kind,account_id,disabled_at,expires_at FROM principals WHERE id=?', principalId);
      if (!principal || principal.disabled_at !== null) throw new ApiError(404, 'not_found', 'The credential principal was not found.');
      const kindMatches = body.kind === 'personal' ? principal.kind === 'user' : body.kind === 'installation' ? principal.kind === 'application' : body.kind === principal.kind;
      if (!kindMatches) throw new ApiError(422, 'credential_kind_mismatch', 'The credential type does not match its principal.');
      if (principal.id !== actor.id) {
        if (!principal.account_id || !scope.account_ids.includes(principal.account_id)) throw new ApiError(403, 'credential_scope_exceeded', 'This identity belongs to a different account.');
        scope.authorizations.push(await authorize(c, 'identities.manage', { account_id: principal.account_id }));
        for (const repository of scope.repositories) await assertDelegable(c, body.capabilities.map(capability => ({ capability, effect: 'allow' })), { repo_id: repository.id });
        if (!scope.repositories.length) await assertDelegable(c, body.capabilities.map(capability => ({ capability, effect: 'allow' })), { account_id: principal.account_id });
      }
      if (principal.expires_at !== null && principal.expires_at < body.expires_at) throw new ApiError(422, 'credential_lifetime_exceeded', 'The credential cannot outlive its principal.');
    }
    const credential = await prepareDerivedCredential(database(c), actor, { principal_id: principalId, user_id: user?.id ?? parent.user_id, kind: body.kind,
      name: body.name, capabilities: [...new Set(body.capabilities)], repository_ids: body.repository_ids.length ? [...new Set(body.repository_ids)] : null,
      account_ids: scope.account_ids, ref_patterns: body.ref_patterns, path_patterns: body.path_patterns,
      auth_revision: user?.auth_revision ?? parent.auth_revision, mfa: actor.mfa, parent_id: parent.kind === 'session' ? null : parent.id,
      expires_at: body.expires_at, created_by: actor.id });
    await commitIdentity(c, [...statements, ...credential.statements], { type: 'identity.credential_created', resource_id: credential.credential.id, resource_revision: 1,
      account_id: scope.account_ids.length === 1 ? scope.account_ids[0] : user?.id, repo_id: body.repository_ids.length === 1 ? body.repository_ids[0] : null,
      data: { principal_id: principalId, kind: body.kind } }, { authorizations: scope.authorizations });
    noStore(c);
    return revisionResponse(c, { ...publicCredential(credential.credential), token: credential.token, revision: 1 }, 201);
  });

  route(app, 'GET', '/v1/tokens/:id', { summary: 'Inspect an owned credential', tags: ['credentials'] }, async c => {
    const token = await ownedToken(c, c.req.param('id'));
    return revisionResponse(c, { ...publicCredential(token), revision: token.revision });
  });

  route(app, 'PATCH', '/v1/tokens/:id', { summary: 'Rename a credential', tags: ['credentials'], body: renameSchema }, async c => {
    const token = await ownedToken(c, c.req.param('id'));
    const body = await jsonBody(c, renameSchema);
    const revision = expectedRevision(c);
    await commitIdentity(c, checkedWrite(database(c), stmt(database(c), 'UPDATE credentials SET name=?,revision=revision+1 WHERE id=? AND revision=?', body.name, token.id, revision)),
      { type: 'identity.credential_updated', resource_id: token.id, resource_revision: revision + 1, account_id: token.user_id });
    return revisionResponse(c, { ...publicCredential({ ...token, name: body.name, revision: revision + 1 }), revision: revision + 1 });
  });

  route(app, 'DELETE', '/v1/tokens/:id', { summary: 'Revoke a credential and its derived credentials', tags: ['credentials'] }, async c => {
    const token = await ownedToken(c, c.req.param('id'), false);
    const revision = expectedRevision(c);
    await commitIdentity(c, checkedWrite(database(c), stmt(database(c),
      'UPDATE credentials SET revoked_at=COALESCE(revoked_at,?),revision=revision+1 WHERE id=? AND revision=?', now(), token.id, revision)),
    { type: 'identity.credential_revoked', resource_id: token.id, resource_revision: revision + 1, account_id: token.user_id });
    return c.body(null, 204);
  });

  route(app, 'POST', '/v1/tokens/:id/rotate', { summary: 'Atomically replace a credential with the same scopes', tags: ['credentials'], body: rotateSchema, sensitive: true }, async c => {
    const previous = await ownedToken(c, c.req.param('id'));
    const body = await jsonBody(c, rotateSchema);
    const revision = expectedRevision(c);
    if (previous.revoked_at || previous.expires_at <= now()) throw new ApiError(409, 'credential_inactive', 'Create a new credential instead of rotating an inactive one.');
    if (previous.kind === 'job' || previous.kind === 'runner') {
      throw new ApiError(409, 'credential_lifecycle_managed', 'This credential is rotated by its job or runner lifecycle.');
    }
    const expiresAt = body.expires_at ?? previous.expires_at;
    validExpiry(expiresAt, previous.kind === 'installation' ? 3600 : previous.kind === 'personal' ? 365 * 86400 : previous.kind === 'viewer' ? 7 * 86400 : 86400);
    const actor = requirePrincipal(c);
    if (previous.principal_id !== actor.id) {
      const capabilities = (credentialScope(previous.capabilities_json) ?? []).map(capability => ({ capability, effect: 'allow' as const }));
      const repositories = credentialScope(previous.repository_ids_json);
      if (repositories?.length) for (const repo_id of repositories) await assertDelegable(c, capabilities, { repo_id });
      else for (const account_id of credentialScope(previous.account_ids_json) ?? []) await assertDelegable(c, capabilities, { account_id });
    }
    const sourceFederated = actor.credential_id ? await isFederationSession(database(c), actor.credential_id) : false;
    if (await isFederationSession(database(c), previous.id) && !sourceFederated) {
      throw new ApiError(403, 'organization_sso_required', 'Use a current organization SSO authorization to rotate this credential.');
    }
    if (sourceFederated && previous.principal_id !== actor.id) {
      throw new ApiError(403, 'federation_credential_scope', 'An SSO credential cannot rotate another principal’s credentials.');
    }
    const current = await one<CredentialRecord>(database(c), 'SELECT * FROM credentials WHERE id=?', actor.credential_id);
    if (!current || current.kind !== 'session' && expiresAt > previous.expires_at) throw new ApiError(403, 'credential_lifetime_exceeded', 'Only a recent account session may extend a credential lifetime.');
    const accountIds = credentialScope(previous.account_ids_json) ?? [];
    for (const accountId of accountIds) validExpiry(expiresAt, (await readAccountPolicy(database(c), accountId)).policy.maximum_token_lifetime_seconds);
    if (!await principalForExplanation(database(c), previous.principal_id)) throw new ApiError(404, 'not_found', 'The credential principal is no longer active.');
    const next = await prepareDerivedCredential(database(c), actor, { principal_id: previous.principal_id, user_id: previous.user_id, kind: previous.kind as CredentialKind,
      name: previous.name, capabilities: credentialScope(previous.capabilities_json), repository_ids: credentialScope(previous.repository_ids_json), account_ids: credentialScope(previous.account_ids_json),
      ref_patterns: credentialScope(previous.ref_patterns_json), path_patterns: credentialScope(previous.path_patterns_json), parent_id: previous.parent_id,
      rotation_of_id: previous.id, auth_revision: previous.auth_revision, mfa: previous.mfa === 1, expires_at: expiresAt, created_by: previous.created_by });
    await commitIdentity(c, [...next.statements, ...checkedWrite(database(c), stmt(database(c), 'UPDATE credentials SET revoked_at=?,revision=revision+1 WHERE id=? AND revision=? AND revoked_at IS NULL AND expires_at>?',
      now(), previous.id, revision, now()))], { type: 'identity.credential_rotated', resource_id: next.credential.id, resource_revision: 1, account_id: previous.user_id,
      data: { previous_id: previous.id } });
    noStore(c);
    return revisionResponse(c, { ...publicCredential(next.credential), token: next.token, revision: 1 }, 201);
  });
}
