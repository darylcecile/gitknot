import { z } from 'zod';
import {
  ApiError, canonicalJson, credentialIsCurrent, credentialScope, many, newId, now, one,
  capabilityCovered, prepareCredential, readAccountPolicy, readBounded, requirePrincipal, sha256, stmt,
} from '@gitknot/core';
import type { AppContext, CredentialRecord, Database, Principal, UserRecord } from '@gitknot/core';
import { mappedRole, validateEntitlements } from './claims.ts';
import { ScimError } from './errors.ts';
import { directoryColumns, directoryRelations, touchGroupUsers, touchUserGroups } from './directory.ts';
import type { DirectoryGroup, DirectoryUser } from './directory.ts';
import { bindScimUser, claimScimRequest, commitScimMutation, currentScimRequest, failScimRequest } from './scim-requests.ts';
import { cancelMembershipAdmission, cancelOlderScimSeatAdmissions, prepareMembershipFinance } from './seats.ts';
import type { SeatSource } from './seats.ts';
import { membershipStatements, prepareManagedUser, revokeUserCredentials } from './identity.ts';
import { administratorGuard, assertFederationIdentityContract, credentialGuard } from './integration.ts';
import {
  applyScimPatch, canonicalScimInput, parseScimGroup, parseScimUser, projectScimResource, scimManagedEmail, scimSearchDocument,
} from './scim-document.ts';
import type { ScimGroup, ScimUser } from './scim-document.ts';
import { compileScimFilter, scimFold } from './scim-filter.ts';
import { condition, federationMutation, getProvider, guarded, providerGuard, publicOrigins } from './store.ts';
import { SCIM_LIST_SCHEMA, SCIM_MEDIA_TYPE, SCIM_SEARCH_SCHEMA } from './types.ts';
import type { FederatedSubject, Provider, ProvisioningContext, ProvisioningToken, ScimGroupRow, ScimObject, ScimUserRow } from './types.ts';

export const SCIM_CAPABILITIES = ['scim.users.read', 'scim.users.write', 'scim.groups.read', 'scim.groups.write', 'scim.discovery.read'] as const;
const bodies = new WeakMap<Request, Promise<unknown>>();
export const createProvisioningTokenSchema = z.object({
  name: z.string().trim().min(1).max(120),
  capabilities: z.array(z.enum(SCIM_CAPABILITIES)).min(1).max(5).default([...SCIM_CAPABILITIES]),
  expires_in_seconds: z.number().int().min(300).max(31_536_000).default(7_776_000),
}).strict();

export async function createProvisioningToken(c: AppContext, provider: Provider, input: z.infer<typeof createProvisioningTokenSchema>): Promise<ScimObject> {
  const principal = requirePrincipal(c);
  const id = newId('scim_token');
  const principalId = newId('svc');
  const timestamp = now();
  const credential = await prepareCredential(c.env.DB, {
    principal_id: principalId, user_id: null, kind: 'service', name: input.name,
    capabilities: [...new Set(input.capabilities)], repository_ids: [], account_ids: [provider.account_id],
    auth_revision: null, mfa: false, expires_at: new Date(Date.now() + input.expires_in_seconds * 1000).toISOString(), created_by: principal.id,
  });
  await federationMutation(c, { event: { type: 'federation.provisioning_token.created', resource_id: id, resource_revision: 1,
    account_id: provider.account_id, data: { provider_id: provider.id, capabilities: input.capabilities, expires_at: credential.credential.expires_at } }, statements: [
    ...administratorGuard(c.env.DB, principal, provider.account_id), ...providerGuard(c.env.DB, provider),
    stmt(c.env.DB, `INSERT INTO principals(id,kind,account_id,name,created_by,created_at,updated_at) VALUES (?,'service',?,?,?,?,?)`,
      principalId, provider.account_id, `SCIM: ${input.name}`, principal.id, timestamp, timestamp),
    credential.statement,
    stmt(c.env.DB, `INSERT INTO federation_provisioning_tokens(id,account_id,provider_id,credential_id,principal_id,name,created_at)
      VALUES (?,?,?,?,?,?,?)`, id, provider.account_id, provider.id, credential.credential.id, principalId, input.name, timestamp),
  ] });
  return { id, provider_id: provider.id, name: input.name, revision: 1, token: credential.token,
    capabilities: input.capabilities, expires_at: credential.credential.expires_at, created_at: timestamp };
}

export async function authenticateScim(c: AppContext, capability: typeof SCIM_CAPABILITIES[number]): Promise<ProvisioningContext> {
  await assertFederationIdentityContract(c.env);
  const authorization = c.req.header('authorization');
  const match = /^Bearer (gkt_[\w-]{43})$/i.exec(authorization ?? '');
  if (!match) throw new ScimError(401, 'Use an organization provisioning bearer token.');
  const credential = await one<CredentialRecord>(c.env.DB, 'SELECT * FROM credentials WHERE token_hash=?', await sha256(match[1]!));
  if (!credential || credential.kind !== 'service' || credential.user_id !== null || credential.parent_id !== null
    || !await credentialIsCurrent(c.env.DB, credential)) throw new ScimError(401, 'The provisioning token is invalid, expired, or revoked.');
  const accountId = c.req.param('orgId')!;
  const token = await one<ProvisioningToken>(c.env.DB, `SELECT * FROM federation_provisioning_tokens
    WHERE account_id=? AND credential_id=? AND principal_id=? AND revoked_at IS NULL`, accountId, credential.id, credential.principal_id);
  if (!token) throw new ScimError(401, 'The provisioning token does not belong to this organization.');
  const capabilities = credentialScope(credential.capabilities_json);
  const accounts = credentialScope(credential.account_ids_json);
  const repositories = credentialScope(credential.repository_ids_json);
  if (!capabilities || !capabilities.includes(capability) || capabilities.some(value => !SCIM_CAPABILITIES.includes(value as typeof SCIM_CAPABILITIES[number]))
    || accounts?.length !== 1 || accounts[0] !== accountId || repositories?.length !== 0) throw new ScimError(403, 'The provisioning credential scope does not permit this operation.');
  const provider = await getProvider(c.env.DB, token.provider_id, accountId, true);
  const account = await one<{ policy_revision: number }>(c.env.DB, 'SELECT policy_revision FROM accounts WHERE id=? AND disabled_at IS NULL', accountId);
  if (!account) throw new ScimError(403, 'This organization is not active.');
  const { policy } = await readAccountPolicy(c.env.DB, accountId);
  if (!policy.allowed_credential_kinds.includes('service')
    || Date.parse(credential.expires_at) - Date.parse(credential.created_at) > policy.maximum_token_lifetime_seconds * 1000
    || (policy.allowed_capabilities !== null && !capabilityCovered(policy.allowed_capabilities, capability)) || capabilityCovered(policy.denied_capabilities, capability)) {
    throw new ScimError(403, 'Organization policy does not permit this provisioning operation.');
  }
  const principal: Principal = { id: token.principal_id, kind: 'service', user_id: null, credential_id: credential.id,
    account_ids: accounts, repository_ids: repositories, capabilities, mfa: false };
  c.set('principal', principal);
  return { provider, token, principal, account_policy_revision: account.policy_revision };
}

export function provisioningGuard(db: Database, context: ProvisioningContext): D1PreparedStatement[] {
  if (context.account_policy_revision === undefined) throw new ScimError(503, 'The provisioning policy snapshot is unavailable.');
  return [...providerGuard(db, context.provider), ...condition(db, `EXISTS (SELECT 1 FROM accounts WHERE id=? AND policy_revision=? AND disabled_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM account_policy_barriers WHERE account_id=?)`, context.provider.account_id, context.account_policy_revision, context.provider.account_id),
    ...credentialGuard(db, context.token.credential_id), ...condition(db,
    'EXISTS (SELECT 1 FROM federation_provisioning_tokens WHERE account_id=? AND provider_id=? AND id=? AND revision=? AND revoked_at IS NULL)',
    context.provider.account_id, context.provider.id, context.token.id, context.token.revision), ...condition(db,
    `EXISTS (SELECT 1 FROM credentials WHERE id=? AND kind='service' AND user_id IS NULL AND parent_id IS NULL
      AND principal_id=? AND capabilities_json=? AND account_ids_json=? AND repository_ids_json='[]')`,
    context.token.credential_id, context.principal.id, JSON.stringify(context.principal.capabilities), JSON.stringify(context.principal.account_ids))];
}

export function readScimBody(c: AppContext): Promise<unknown> {
  let value = bodies.get(c.req.raw);
  if (!value) { value = readBody(c); bodies.set(c.req.raw, value); }
  return value;
}

async function readBody(c: AppContext): Promise<unknown> {
  if (!/^application\/(?:scim\+json|json)(?:;|$)/i.test(c.req.header('content-type') ?? '')) {
    throw new ScimError(415, 'Use Content-Type: application/scim+json.');
  }
  if (Number(c.req.header('content-length')) > 262_144) throw new ScimError(413, 'The SCIM request exceeds 256 KiB.', 'tooMany');
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(c.req.raw.body, 262_144))); }
  catch (error) {
    if (error instanceof ApiError && error.status === 413) throw new ScimError(413, 'The SCIM request exceeds 256 KiB.', 'tooMany');
    throw new ScimError(400, 'The request must contain valid UTF-8 JSON.', 'invalidSyntax');
  }
}

/** A committed create is replayed from its durable resource, never guessed successful after a timeout. */
export async function idempotentScimCreate(c: AppContext, context: ProvisioningContext, kind: 'User' | 'Group',
  handler: () => Promise<Response>): Promise<Response> {
  const previous = await claimScimRequest(c, context, kind, await readScimBody(c));
  if (previous) {
    const row = kind === 'User' ? await userRow(c.env.DB, context.provider, previous.resource_id!) : await groupRow(c.env.DB, context.provider, previous.resource_id!);
    const resource = kind === 'User' ? userRepresentation(c, row as DirectoryUser) : groupRepresentation(c, row as DirectoryGroup);
    const response = scimResponse(c, projection(c, resource), 201, resourceLocation(c, kind, row.id), row.revision);
    response.headers.set('idempotency-replayed', 'true');
    return response;
  }
  const claimed = currentScimRequest(c);
  try {
    await cancelOlderScimSeatAdmissions(c.env.DB, claimed.id, claimed.generation);
    return await handler();
  }
  catch (error) {
    await failScimRequest(c);
    throw error;
  }
}

function seatSource(c: AppContext, resourceId: string, revision: number, creation = false): SeatSource {
  const request = creation ? currentScimRequest(c) : null;
  return { kind: creation ? 'scim' : 'membership', id: request?.id ?? `${resourceId}:${revision}`,
    generation: request?.generation ?? revision, attempt_id: request?.attempt_id ?? c.get('requestId'),
    expires_at: request?.lease_expires_at ?? new Date(Date.now() + 300_000).toISOString(), actor_id: requirePrincipal(c).id };
}

function scimVersion(revision: number): string { return `"${revision}"`; }

function expectedScimRevision(c: AppContext, current: number): number {
  const header = c.req.header('if-match');
  if (header === undefined) return current;
  if (header !== scimVersion(current)) throw new ScimError(412, 'The resource version changed. Retrieve the current resource before retrying.');
  return current;
}

function resourceLocation(c: AppContext, type: 'User' | 'Group', id: string): string {
  return `${publicOrigins(c.env).api}/scim/v2/${c.req.param('orgId')}/${type}s/${id}`;
}

function metadata(c: AppContext, type: 'User' | 'Group', row: { id: string; revision: number; created_at: string; updated_at: string }): ScimObject {
  return { resourceType: type, created: row.created_at, lastModified: row.updated_at, version: scimVersion(row.revision), location: resourceLocation(c, type, row.id) };
}

export function scimResponse(c: AppContext, value: unknown, status = 200, location?: string, revision?: number): Response {
  const headers = new Headers({ 'content-type': `${SCIM_MEDIA_TYPE}; charset=utf-8`, 'cache-control': 'no-store', 'x-gitknot-request-id': c.get('requestId') });
  if (location) headers.set('location', location);
  if (revision !== undefined) headers.set('etag', scimVersion(revision));
  return new Response(status === 204 ? null : JSON.stringify(value), { status, headers });
}

async function userRow(db: Database, provider: Provider, id: string): Promise<DirectoryUser> {
  const row = await one<DirectoryUser>(db, `SELECT ${directoryColumns('User')} FROM federation_scim_users r WHERE r.account_id=? AND r.provider_id=? AND r.id=? AND r.deleted_at IS NULL`,
    provider.account_id, provider.id, id);
  if (!row) throw new ScimError(404, 'The User was not found.');
  return row;
}

async function groupRow(db: Database, provider: Provider, id: string): Promise<DirectoryGroup> {
  const row = await one<DirectoryGroup>(db, `SELECT ${directoryColumns('Group')} FROM federation_scim_groups r WHERE r.account_id=? AND r.provider_id=? AND r.id=? AND r.deleted_at IS NULL`,
    provider.account_id, provider.id, id);
  if (!row) throw new ScimError(404, 'The Group was not found.');
  return row;
}

function userRepresentation(c: AppContext, row: DirectoryUser): ScimObject {
  const groups = directoryRelations(row);
  return { ...JSON.parse(row.attributes_json) as ScimObject, id: row.id, externalId: row.external_id, userName: row.user_name, active: row.active === 1,
    groups: groups.map(group => ({ value: group.id, display: group.display, type: 'direct', $ref: resourceLocation(c, 'Group', group.id) })), meta: metadata(c, 'User', row) };
}

function groupRepresentation(c: AppContext, row: DirectoryGroup): ScimObject {
  const members = directoryRelations(row);
  return { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], id: row.id, externalId: row.external_id, displayName: row.display_name,
    members: members.map(member => ({ value: member.id, display: member.display, type: 'User', $ref: resourceLocation(c, 'User', member.id) })), meta: metadata(c, 'Group', row) };
}

function projection(c: AppContext, resource: ScimObject, parameters?: SearchParameters): ScimObject {
  return projectScimResource(resource, parameters?.attributes ?? c.req.query('attributes'), parameters?.excludedAttributes ?? c.req.query('excludedAttributes'));
}

interface SearchParameters { filter?: string; startIndex: number; count: number; attributes?: string; excludedAttributes?: string }

function searchParameters(raw: unknown): SearchParameters {
  const parsed = z.object({ filter: z.string().max(2048).optional(), startIndex: z.coerce.number().int().default(1), count: z.coerce.number().int().default(100),
    attributes: z.union([z.string(), z.array(z.string())]).transform(value => Array.isArray(value) ? value.join(',') : value).optional(),
    excludedAttributes: z.union([z.string(), z.array(z.string())]).transform(value => Array.isArray(value) ? value.join(',') : value).optional(),
  }).safeParse(raw);
  if (!parsed.success) throw new ScimError(400, 'The SCIM pagination or projection parameters are invalid.', 'invalidValue');
  if (parsed.data.startIndex > 1_000_000) throw new ScimError(400, 'Use a selective filter before requesting an offset above one million.', 'tooMany');
  return { ...parsed.data, startIndex: Math.max(1, parsed.data.startIndex), count: Math.min(100, Math.max(0, parsed.data.count)) };
}

export async function listScimResources(c: AppContext, context: ProvisioningContext, kind: 'User' | 'Group', search = false): Promise<Response> {
  let raw: unknown = c.req.query();
  if (search) {
    raw = canonicalScimInput(await readScimBody(c));
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as ScimObject).schemas)
      || (raw as { schemas: string[] }).schemas.length !== 1 || (raw as { schemas: string[] }).schemas[0] !== SCIM_SEARCH_SCHEMA) {
      throw new ScimError(400, 'A SCIM SearchRequest schema is required.', 'invalidValue');
    }
  }
  const parameters = searchParameters(raw);
  const filter = compileScimFilter(parameters.filter, kind);
  const table = kind === 'User' ? 'federation_scim_users' : 'federation_scim_groups';
  const where = `r.account_id=? AND r.provider_id=? AND r.deleted_at IS NULL AND (${filter.sql})`;
  const bindings = [context.provider.account_id, context.provider.id, ...filter.bindings];
  // Count and page are one D1 transaction, so totalResults describes the same snapshot.
  const [total, page] = await c.env.DB.batch([
    stmt(c.env.DB, `SELECT COUNT(*) AS total FROM ${table} r WHERE ${where}`, ...bindings),
    stmt(c.env.DB, `SELECT ${directoryColumns(kind)} FROM ${table} r WHERE ${where} ORDER BY r.id LIMIT ? OFFSET ?`, ...bindings, parameters.count, parameters.startIndex - 1),
  ]);
  const rows = page!.results as unknown as (DirectoryUser | DirectoryGroup)[];
  const resources = rows.map(row => projection(c,
    kind === 'User' ? userRepresentation(c, row as DirectoryUser) : groupRepresentation(c, row as DirectoryGroup), parameters));
  return scimResponse(c, { schemas: [SCIM_LIST_SCHEMA], totalResults: Number((total!.results[0] as { total: number }).total),
    startIndex: parameters.startIndex, itemsPerPage: resources.length, Resources: resources });
}

export async function readScimResource(c: AppContext, context: ProvisioningContext, kind: 'User' | 'Group'): Promise<Response> {
  const id = c.req.param('id')!;
  const row = kind === 'User' ? await userRow(c.env.DB, context.provider, id) : await groupRow(c.env.DB, context.provider, id);
  const resource = kind === 'User' ? userRepresentation(c, row as DirectoryUser) : groupRepresentation(c, row as DirectoryGroup);
  if (c.req.header('if-none-match') === scimVersion(row.revision)) return new Response(null, { status: 304, headers: { etag: scimVersion(row.revision), 'cache-control': 'no-store' } });
  return scimResponse(c, projection(c, resource), 200, resourceLocation(c, kind, id), row.revision);
}

async function validateManager(c: AppContext, provider: Provider, user: ScimUser): Promise<D1PreparedStatement[]> {
  const extension = user['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'];
  if (!extension?.manager) return [];
  const manager = await userRow(c.env.DB, provider, extension.manager.value);
  if (extension.manager.$ref && extension.manager.$ref !== resourceLocation(c, 'User', manager.id)) throw new ScimError(400, 'The manager reference must name a User in this organization.', 'invalidValue');
  extension.manager.$ref = resourceLocation(c, 'User', manager.id);
  return condition(c.env.DB, 'EXISTS (SELECT 1 FROM federation_scim_users WHERE account_id=? AND provider_id=? AND id=? AND deleted_at IS NULL)', provider.account_id, provider.id, manager.id);
}

export async function createScimUser(c: AppContext, context: ProvisioningContext): Promise<Response> {
  const user = parseScimUser(await readScimBody(c));
  const provider = context.provider;
  await validateEntitlements(c.env.DB, provider.account_id, provider.config);
  const role = mappedRole(provider.config, user.roles?.map(value => value.value) ?? []);
  const manager = await validateManager(c, provider, user);
  const linked = await one<FederatedSubject>(c.env.DB, `SELECT * FROM federation_subjects WHERE account_id=? AND provider_id=?
    AND external_id=? AND scim_user_id IS NULL AND state IN ('pending','active')`, provider.account_id, provider.id, user.externalId);
  let prepared: Awaited<ReturnType<typeof prepareManagedUser>>;
  try {
    if (linked) {
      const existing = await one<UserRecord>(c.env.DB, `SELECT u.* FROM users u JOIN principals p ON p.id=u.id
        WHERE u.id=? AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL AND p.kind='user' AND p.disabled_at IS NULL`, linked.user_id);
      if (!existing) throw new ScimError(409, 'The explicitly linked GitKnot account is not currently verified and active.', 'mutability');
      prepared = { user: existing, statements: condition(c.env.DB, 'EXISTS (SELECT 1 FROM users WHERE id=? AND auth_revision=? AND email_verified_at IS NOT NULL AND disabled_at IS NULL)', existing.id, existing.auth_revision) };
    } else prepared = await prepareManagedUser(c.env.DB, { email: scimManagedEmail(user), display_name: user.displayName ?? user.userName, verified: false,
      actor_id: context.principal.id, user_id: currentScimRequest(c).planned_user_id ?? undefined });
  }
  catch (error) {
    if (error instanceof ApiError && error.code === 'identity_link_required') throw new ScimError(409, error.message, 'uniqueness');
    throw error;
  }
  await bindScimUser(c, prepared.user.id);
  const id = currentScimRequest(c).planned_resource_id;
  const timestamp = now();
  const finance = await prepareMembershipFinance(c.env.DB, c.env, provider, prepared.user.id, user.active, seatSource(c, id, 1, true));
  try { await commitScimMutation(c, context, { type: 'scim.user.created', resource_id: id, resource_revision: 1, data: { user_id: prepared.user.id, active: user.active } }, [
    ...provisioningGuard(c.env.DB, context), ...manager, ...finance.guards, ...prepared.statements, ...finance.statements,
    ...membershipStatements(c.env.DB, provider.account_id, prepared.user.id, role, user.active, context.principal.id),
    stmt(c.env.DB, `INSERT INTO federation_scim_users(id,account_id,provider_id,user_id,external_id,user_name,user_name_key,active,attributes_json,search_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, id, provider.account_id, provider.id, prepared.user.id, user.externalId, user.userName, scimFold(user.userName), Number(user.active),
    JSON.stringify(user), JSON.stringify(scimSearchDocument(user)), timestamp, timestamp),
    ...(linked ? guarded(c.env.DB, stmt(c.env.DB, `UPDATE federation_subjects SET scim_user_id=?,state=?,revision=revision+1,updated_at=?
      WHERE account_id=? AND provider_id=? AND id=? AND revision=? AND scim_user_id IS NULL AND state IN ('pending','active')`,
    id, user.active ? 'active' : 'suspended', timestamp, provider.account_id, provider.id, linked.id, linked.revision)) : []),
  ]); } catch (error) { await cancelMembershipAdmission(c.env.DB, finance.admission_id); throw error; }
  const row = await userRow(c.env.DB, provider, id);
  return scimResponse(c, projection(c, userRepresentation(c, row)), 201, resourceLocation(c, 'User', id), row.revision);
}

async function userTeamTransition(db: Database, provider: Provider, row: ScimUserRow, active: boolean): Promise<D1PreparedStatement[]> {
  const groups = active ? await many<ScimGroupRow>(db, `SELECT g.* FROM federation_scim_groups g JOIN federation_scim_group_members gm
    ON gm.account_id=g.account_id AND gm.provider_id=g.provider_id AND gm.group_id=g.id
    WHERE gm.account_id=? AND gm.provider_id=? AND gm.scim_user_id=? AND g.deleted_at IS NULL LIMIT 1001`, provider.account_id, provider.id, row.id) : [];
  if (groups.length > 1000) throw new ScimError(400, 'The identity has too many group memberships.', 'tooMany');
  for (const group of groups) {
    if (!provider.config.mappings.team_ceiling.includes(group.team_id) || !provider.config.mappings.scim_group_mappings.some(value => value.external_id === group.external_id && value.team_id === group.team_id)) {
      throw new ScimError(403, 'An existing group is outside the current provisioning team ceiling.', 'invalidValue');
    }
  }
  const mappings = JSON.stringify(groups.map(group => ({ team_id: group.team_id, source_id: group.id })));
  return [
    ...(active ? condition(db, `(SELECT COUNT(*) FROM federation_scim_groups g JOIN federation_scim_group_members gm
      ON gm.account_id=g.account_id AND gm.provider_id=g.provider_id AND gm.group_id=g.id WHERE gm.account_id=? AND gm.provider_id=?
      AND gm.scim_user_id=? AND g.deleted_at IS NULL)=? AND NOT EXISTS (SELECT 1 FROM federation_scim_groups g JOIN federation_scim_group_members gm
      ON gm.account_id=g.account_id AND gm.provider_id=g.provider_id AND gm.group_id=g.id WHERE gm.account_id=? AND gm.provider_id=?
      AND gm.scim_user_id=? AND g.deleted_at IS NULL AND g.id NOT IN (SELECT value FROM json_each(?)))`,
    provider.account_id, provider.id, row.id, groups.length, provider.account_id, provider.id, row.id, JSON.stringify(groups.map(group => group.id))) : []),
    stmt(db, `DELETE FROM team_members WHERE account_id=? AND principal_id=?
      AND EXISTS (SELECT 1 FROM federation_team_memberships fm WHERE fm.account_id=team_members.account_id AND fm.user_id=team_members.principal_id
        AND fm.team_id=team_members.team_id AND fm.provider_id=?)
      AND NOT EXISTS (SELECT 1 FROM federation_team_memberships fm WHERE fm.account_id=team_members.account_id AND fm.user_id=team_members.principal_id
        AND fm.team_id=team_members.team_id AND fm.provider_id<>?)`, provider.account_id, row.user_id, provider.id, provider.id),
    stmt(db, 'DELETE FROM federation_team_memberships WHERE account_id=? AND provider_id=? AND user_id=?', provider.account_id, provider.id, row.user_id),
    stmt(db, `INSERT INTO federation_team_memberships(account_id,provider_id,user_id,team_id,source,source_id)
      SELECT ?,?,?,json_extract(value,'$.team_id'),'scim',json_extract(value,'$.source_id') FROM json_each(?)`, provider.account_id, provider.id, row.user_id, mappings),
    stmt(db, `INSERT INTO team_members(account_id,team_id,principal_id,role,created_at,updated_at)
      SELECT DISTINCT ?,json_extract(value,'$.team_id'),?,'member',?,? FROM json_each(?) WHERE 1 ON CONFLICT(team_id,principal_id) DO NOTHING`,
    provider.account_id, row.user_id, now(), now(), mappings),
  ];
}

export async function updateScimUser(c: AppContext, context: ProvisioningContext, patch: boolean): Promise<Response> {
  const provider = context.provider;
  const row = await userRow(c.env.DB, provider, c.req.param('id')!);
  const revision = expectedScimRevision(c, row.revision);
  const previous = parseScimUser(JSON.parse(row.attributes_json));
  const input = await readScimBody(c);
  const user = parseScimUser(patch ? applyScimPatch(previous as ScimObject, input, 'User') : input, previous);
  const manager = await validateManager(c, provider, user);
  if (user.active) await validateEntitlements(c.env.DB, provider.account_id, provider.config);
  const existing = await one<{ role_id: string; revision: number; state: string }>(c.env.DB, 'SELECT role_id,revision,state FROM memberships WHERE account_id=? AND principal_id=?', provider.account_id, row.user_id);
  if (!existing) throw new ScimError(409, 'The organization membership was removed outside provisioning.', 'mutability');
  const role = user.active ? mappedRole(provider.config, user.roles?.map(value => value.value) ?? []) : existing.role_id;
  const desiredRole = existing.role_id === 'owner' ? 'owner' : role;
  const desiredState = user.active ? 'active' : 'suspended';
  if (canonicalJson(user) === canonicalJson(previous) && existing.role_id === desiredRole && existing.state === desiredState) {
    return scimResponse(c, projection(c, userRepresentation(c, row)), 200, resourceLocation(c, 'User', row.id), row.revision);
  }
  const timestamp = now();
  const changedAccess = Number(user.active) !== row.active || role !== existing.role_id;
  const transition = Number(user.active) !== row.active || existing.state !== desiredState ? await userTeamTransition(c.env.DB, provider, row, user.active) : [];
  const finance = await prepareMembershipFinance(c.env.DB, c.env, provider, row.user_id, user.active, seatSource(c, row.id, row.revision + 1));
  const statements = [
    ...provisioningGuard(c.env.DB, context), ...manager, ...finance.guards,
    ...condition(c.env.DB, 'EXISTS (SELECT 1 FROM memberships WHERE account_id=? AND principal_id=? AND revision=?)', provider.account_id, row.user_id, existing.revision),
    ...guarded(c.env.DB, stmt(c.env.DB, `UPDATE federation_scim_users SET user_name=?,user_name_key=?,active=?,attributes_json=?,search_json=?,revision=revision+1,updated_at=?
      WHERE account_id=? AND provider_id=? AND id=? AND revision=? AND deleted_at IS NULL`, user.userName, scimFold(user.userName), Number(user.active), JSON.stringify(user),
    JSON.stringify(scimSearchDocument(user)), timestamp, provider.account_id, provider.id, row.id, revision)),
    ...(user.userName !== row.user_name ? [touchUserGroups(c.env.DB, provider, row.id, timestamp)] : []),
    ...finance.statements, ...membershipStatements(c.env.DB, provider.account_id, row.user_id, role, user.active, context.principal.id), ...transition,
    stmt(c.env.DB, `UPDATE federation_subjects SET state=?,revision=revision+1,updated_at=? WHERE account_id=? AND provider_id=? AND scim_user_id=? AND state<>?`,
      user.active ? 'active' : 'suspended', timestamp, provider.account_id, provider.id, row.id, user.active ? 'active' : 'suspended'),
    ...(changedAccess || !user.active ? revokeUserCredentials(c.env.DB, provider.account_id, row.user_id) : []),
  ];
  // Provisioning can correct an unverified address, but cannot take over a globally verified account email.
  const managed = await one<Pick<UserRecord, 'email' | 'email_verified_at'>>(c.env.DB, 'SELECT email,email_verified_at FROM users WHERE id=?', row.user_id);
  if (managed && managed.email_verified_at === null) {
    statements.push(stmt(c.env.DB, 'UPDATE users SET email=?,display_name=?,revision=revision+1,updated_at=? WHERE id=? AND email_verified_at IS NULL AND disabled_at IS NULL',
      scimManagedEmail(user), user.displayName ?? user.userName, timestamp, row.user_id));
  }
  try { await commitScimMutation(c, context, { type: user.active ? 'scim.user.updated' : 'scim.user.deprovisioned', resource_id: row.id,
    resource_revision: row.revision + 1, data: { user_id: row.user_id, active: user.active } }, statements);
  } catch (error) { await cancelMembershipAdmission(c.env.DB, finance.admission_id); throw error; }
  const updated = await userRow(c.env.DB, provider, row.id);
  return scimResponse(c, projection(c, await userRepresentation(c, updated)), 200, resourceLocation(c, 'User', row.id), updated.revision);
}

export async function deleteScimUser(c: AppContext, context: ProvisioningContext): Promise<Response> {
  const provider = context.provider;
  const row = await userRow(c.env.DB, provider, c.req.param('id')!);
  const revision = expectedScimRevision(c, row.revision);
  const timestamp = now();
  const transition = await userTeamTransition(c.env.DB, provider, row, false);
  const finance = await prepareMembershipFinance(c.env.DB, c.env, provider, row.user_id, false, seatSource(c, row.id, row.revision + 1));
  await commitScimMutation(c, context, { type: 'scim.user.deleted', resource_id: row.id, resource_revision: row.revision + 1, data: { user_id: row.user_id } }, [
    ...provisioningGuard(c.env.DB, context), ...finance.guards,
    ...guarded(c.env.DB, stmt(c.env.DB, `UPDATE federation_scim_users SET active=0,deleted_at=?,revision=revision+1,updated_at=?
      WHERE account_id=? AND provider_id=? AND id=? AND revision=? AND deleted_at IS NULL`, timestamp, timestamp, provider.account_id, provider.id, row.id, revision)),
    ...finance.statements, stmt(c.env.DB, `UPDATE memberships SET state='suspended',revision=revision+1,updated_at=? WHERE account_id=? AND principal_id=? AND state<>'suspended'`, timestamp, provider.account_id, row.user_id),
    stmt(c.env.DB, "UPDATE federation_subjects SET state='suspended',revision=revision+1,updated_at=? WHERE account_id=? AND provider_id=? AND scim_user_id=?", timestamp, provider.account_id, provider.id, row.id),
    ...transition,
    touchUserGroups(c.env.DB, provider, row.id, timestamp),
    stmt(c.env.DB, 'DELETE FROM federation_scim_group_members WHERE account_id=? AND provider_id=? AND scim_user_id=?', provider.account_id, provider.id, row.id),
    ...revokeUserCredentials(c.env.DB, provider.account_id, row.user_id),
  ]);
  return scimResponse(c, null, 204);
}

function mappedScimTeam(provider: Provider, externalId: string): string {
  const mapping = provider.config.mappings.scim_group_mappings.find(value => value.external_id === externalId);
  if (!mapping || !provider.config.mappings.team_ceiling.includes(mapping.team_id)) throw new ScimError(403, 'The Group externalId has no approved organization team mapping.', 'invalidValue');
  return mapping.team_id;
}

async function groupMembershipStatements(c: AppContext, provider: Provider, groupId: string, teamId: string, members: ScimGroup['members'], renamed = false): Promise<D1PreparedStatement[]> {
  const ids = members.map(member => member.value);
  for (const member of members) if (member.$ref && member.$ref !== resourceLocation(c, 'User', member.value)) throw new ScimError(400, 'Every member reference must belong to this organization and provider.', 'invalidValue');
  const valid = await many<ScimUserRow>(c.env.DB, `SELECT * FROM federation_scim_users WHERE account_id=? AND provider_id=?
    AND id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL`, provider.account_id, provider.id, JSON.stringify(ids));
  if (valid.length !== ids.length) throw new ScimError(400, 'Every Group member must be an existing User provisioned by this provider.', 'invalidValue');
  const unmanaged = await one(c.env.DB, `SELECT tm.principal_id FROM team_members tm WHERE tm.account_id=? AND tm.team_id=?
    AND tm.principal_id IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM federation_team_memberships fm
      WHERE fm.account_id=tm.account_id AND fm.team_id=tm.team_id AND fm.user_id=tm.principal_id) LIMIT 1`,
  provider.account_id, teamId, JSON.stringify(valid.filter(value => value.active).map(value => value.user_id)));
  if (unmanaged) throw new ScimError(409, 'A mapped team membership is locally managed. Reconcile its source before assigning SCIM ownership.', 'mutability');
  const serialized = JSON.stringify(ids);
  return [
    ...condition(c.env.DB, `NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.account_id=? AND tm.team_id=?
      AND tm.principal_id IN (SELECT user_id FROM federation_scim_users WHERE account_id=? AND provider_id=?
        AND id IN (SELECT value FROM json_each(?)) AND active=1 AND deleted_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM federation_team_memberships fm WHERE fm.account_id=tm.account_id AND fm.team_id=tm.team_id AND fm.user_id=tm.principal_id))`,
    provider.account_id, teamId, provider.account_id, provider.id, serialized),
    ...condition(c.env.DB, `(SELECT COUNT(*) FROM federation_scim_users WHERE account_id=? AND provider_id=?
      AND id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL)=?`, provider.account_id, provider.id, serialized, ids.length),
    touchGroupUsers(c.env.DB, provider, groupId, ids, renamed, now()),
    stmt(c.env.DB, 'DELETE FROM federation_scim_group_members WHERE account_id=? AND provider_id=? AND group_id=?', provider.account_id, provider.id, groupId),
    stmt(c.env.DB, `INSERT INTO federation_scim_group_members(account_id,provider_id,group_id,scim_user_id) SELECT ?,?,?,value FROM json_each(?)`, provider.account_id, provider.id, groupId, serialized),
    stmt(c.env.DB, `DELETE FROM team_members WHERE account_id=? AND team_id=?
      AND EXISTS (SELECT 1 FROM federation_team_memberships fm WHERE fm.account_id=team_members.account_id AND fm.team_id=team_members.team_id
        AND fm.user_id=team_members.principal_id AND fm.provider_id=? AND fm.source='scim' AND fm.source_id=?)
      AND NOT EXISTS (SELECT 1 FROM federation_team_memberships fm WHERE fm.account_id=team_members.account_id AND fm.team_id=team_members.team_id
        AND fm.user_id=team_members.principal_id AND (fm.provider_id<>? OR fm.source<>'scim' OR fm.source_id<>?))
      AND principal_id NOT IN (SELECT user_id FROM federation_scim_users WHERE account_id=? AND provider_id=?
        AND id IN (SELECT value FROM json_each(?)) AND active=1 AND deleted_at IS NULL)`,
    provider.account_id, teamId, provider.id, groupId, provider.id, groupId, provider.account_id, provider.id, serialized),
    stmt(c.env.DB, `DELETE FROM federation_team_memberships WHERE account_id=? AND provider_id=? AND team_id=? AND source='scim' AND source_id=?`, provider.account_id, provider.id, teamId, groupId),
    stmt(c.env.DB, `INSERT INTO federation_team_memberships(account_id,provider_id,user_id,team_id,source,source_id)
      SELECT account_id,provider_id,user_id,?,'scim',? FROM federation_scim_users WHERE account_id=? AND provider_id=?
      AND id IN (SELECT value FROM json_each(?)) AND active=1 AND deleted_at IS NULL`, teamId, groupId, provider.account_id, provider.id, serialized),
    stmt(c.env.DB, `INSERT INTO team_members(account_id,team_id,principal_id,role,created_at,updated_at)
      SELECT account_id,?,user_id,'member',?,? FROM federation_scim_users WHERE account_id=? AND provider_id=?
        AND id IN (SELECT value FROM json_each(?)) AND active=1 AND deleted_at IS NULL AND 1
      ON CONFLICT(team_id,principal_id) DO NOTHING`, teamId, now(), now(), provider.account_id, provider.id, serialized),
  ];
}

export async function createScimGroup(c: AppContext, context: ProvisioningContext): Promise<Response> {
  const group = parseScimGroup(await readScimBody(c));
  const provider = context.provider;
  await validateEntitlements(c.env.DB, provider.account_id, provider.config);
  const teamId = mappedScimTeam(provider, group.externalId);
  const id = currentScimRequest(c).planned_resource_id;
  const timestamp = now();
  const members = await groupMembershipStatements(c, provider, id, teamId, group.members);
  await commitScimMutation(c, context, { type: 'scim.group.created', resource_id: id, resource_revision: 1, data: { team_id: teamId, member_count: group.members.length } }, [
    ...provisioningGuard(c.env.DB, context),
    stmt(c.env.DB, `INSERT INTO federation_scim_groups(id,account_id,provider_id,external_id,display_name,display_name_key,team_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, id, provider.account_id, provider.id, group.externalId, group.displayName, scimFold(group.displayName), teamId, timestamp, timestamp),
    ...members,
  ]);
  const row = await groupRow(c.env.DB, provider, id);
  return scimResponse(c, projection(c, await groupRepresentation(c, row)), 201, resourceLocation(c, 'Group', id), row.revision);
}

export async function updateScimGroup(c: AppContext, context: ProvisioningContext, patch: boolean): Promise<Response> {
  const provider = context.provider;
  const row = await groupRow(c.env.DB, provider, c.req.param('id')!);
  const revision = expectedScimRevision(c, row.revision);
  const previous = parseScimGroup(await groupRepresentation(c, row));
  const input = await readScimBody(c);
  const group = parseScimGroup(patch ? applyScimPatch(previous as ScimObject, input, 'Group') : input, previous);
  await validateEntitlements(c.env.DB, provider.account_id, provider.config);
  const teamId = mappedScimTeam(provider, group.externalId);
  if (teamId !== row.team_id) throw new ScimError(409, 'A provisioned Group cannot be rebound to a different organization team.', 'mutability');
  const members = await groupMembershipStatements(c, provider, row.id, teamId, group.members, group.displayName !== row.display_name);
  await commitScimMutation(c, context, { type: 'scim.group.updated', resource_id: row.id, resource_revision: row.revision + 1,
    data: { team_id: teamId, member_count: group.members.length } }, [
    ...provisioningGuard(c.env.DB, context),
    ...guarded(c.env.DB, stmt(c.env.DB, `UPDATE federation_scim_groups SET display_name=?,display_name_key=?,revision=revision+1,updated_at=?
      WHERE account_id=? AND provider_id=? AND id=? AND revision=? AND deleted_at IS NULL`, group.displayName, scimFold(group.displayName), now(), provider.account_id, provider.id, row.id, revision)),
    ...members,
  ]);
  const updated = await groupRow(c.env.DB, provider, row.id);
  return scimResponse(c, projection(c, await groupRepresentation(c, updated)), 200, resourceLocation(c, 'Group', row.id), updated.revision);
}

export async function deleteScimGroup(c: AppContext, context: ProvisioningContext): Promise<Response> {
  const provider = context.provider;
  const row = await groupRow(c.env.DB, provider, c.req.param('id')!);
  const revision = expectedScimRevision(c, row.revision);
  const members = await groupMembershipStatements(c, provider, row.id, row.team_id, []);
  await commitScimMutation(c, context, { type: 'scim.group.deleted', resource_id: row.id, resource_revision: row.revision + 1, data: { team_id: row.team_id } }, [
    ...provisioningGuard(c.env.DB, context),
    ...guarded(c.env.DB, stmt(c.env.DB, `UPDATE federation_scim_groups SET deleted_at=?,updated_at=?,revision=revision+1
      WHERE account_id=? AND provider_id=? AND id=? AND revision=? AND deleted_at IS NULL`, now(), now(), provider.account_id, provider.id, row.id, revision)),
    ...members,
  ]);
  return scimResponse(c, null, 204);
}
