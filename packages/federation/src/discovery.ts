import type { AppContext } from '@gitknot/core';
import { ScimError } from './errors.ts';
import { scimResponse } from './scim.ts';
import { publicOrigins } from './store.ts';
import { SCIM_ENTERPRISE_SCHEMA, SCIM_GROUP_SCHEMA, SCIM_LIST_SCHEMA, SCIM_USER_SCHEMA } from './types.ts';
import type { ScimObject } from './types.ts';

interface AttributeOptions {
  required?: boolean; multiValued?: boolean; mutability?: string; returned?: string; caseExact?: boolean;
  uniqueness?: string; subAttributes?: ScimObject[]; description?: string;
}

function attribute(name: string, type = 'string', options: AttributeOptions = {}): ScimObject {
  return { name, type, multiValued: options.multiValued ?? false, required: options.required ?? false,
    mutability: options.mutability ?? 'readWrite', returned: options.returned ?? 'default', caseExact: options.caseExact ?? false,
    uniqueness: options.uniqueness ?? 'none', description: options.description ?? name,
    ...(options.subAttributes ? { subAttributes: options.subAttributes } : {}) };
}

const valueFields = [attribute('value'), attribute('type'), attribute('display'), attribute('primary', 'boolean')];
const common = [
  attribute('id', 'string', { mutability: 'readOnly', returned: 'always', uniqueness: 'server', caseExact: true }),
  attribute('externalId', 'string', { required: true, mutability: 'immutable', uniqueness: 'server', caseExact: true,
    description: 'Immutable provider object ID, scoped to the provisioning token provider. It is never an email-based account linking instruction.' }),
  attribute('schemas', 'string', { required: true, multiValued: true, returned: 'always', caseExact: true }),
  attribute('meta', 'complex', { mutability: 'readOnly', subAttributes: [
    attribute('resourceType', 'string', { mutability: 'readOnly' }), attribute('created', 'dateTime', { mutability: 'readOnly' }),
    attribute('lastModified', 'dateTime', { mutability: 'readOnly' }), attribute('version', 'string', { mutability: 'readOnly', caseExact: true }),
    attribute('location', 'reference', { mutability: 'readOnly', caseExact: true }),
  ] }),
];

const userAttributes = [
  ...common, attribute('userName', 'string', { required: true, uniqueness: 'server' }), attribute('active', 'boolean'),
  attribute('displayName'), attribute('name', 'complex', { subAttributes: ['formatted', 'givenName', 'familyName', 'middleName', 'honorificPrefix', 'honorificSuffix'].map(name => attribute(name)) }),
  ...['nickName', 'title', 'userType', 'preferredLanguage', 'locale', 'timezone'].map(name => attribute(name)),
  attribute('emails', 'complex', { multiValued: true, subAttributes: valueFields,
    description: 'At most 20 email addresses. Initial provisioning requires an email here or an email-shaped userName. SCIM does not verify email ownership.' }),
  attribute('phoneNumbers', 'complex', { multiValued: true, subAttributes: valueFields }),
  attribute('roles', 'complex', { multiValued: true, subAttributes: valueFields,
    description: 'External role values must match approved provider role mappings and ceilings. Ownership is never provisioned.' }),
  attribute('groups', 'complex', { mutability: 'readOnly', multiValued: true, subAttributes: [
    attribute('value', 'string', { mutability: 'readOnly', caseExact: true }), attribute('$ref', 'reference', { mutability: 'readOnly', caseExact: true }),
    attribute('display', 'string', { mutability: 'readOnly' }), attribute('type', 'string', { mutability: 'readOnly' }),
  ] }),
];

const groupAttributes = [...common, attribute('displayName', 'string', { required: true }),
  attribute('members', 'complex', { multiValued: true, subAttributes: [
    attribute('value', 'string', { required: true, caseExact: true }), attribute('$ref', 'reference', { caseExact: true }), attribute('display'), attribute('type'),
  ], description: 'At most 1000 Users from the same organization/provider. Nested Groups are not supported.' }),
];

function base(c: AppContext): string { return `${publicOrigins(c.env).api}/scim/v2/${c.req.param('orgId')}`; }

function schemas(c: AppContext): ScimObject[] {
  return [
    { id: SCIM_USER_SCHEMA, name: 'User', description: 'GitKnot organization-provisioned human identity', attributes: userAttributes },
    { id: SCIM_GROUP_SCHEMA, name: 'Group', description: 'Provider Group explicitly mapped to a GitKnot organization team', attributes: groupAttributes },
    { id: SCIM_ENTERPRISE_SCHEMA, name: 'EnterpriseUser', description: 'Enterprise directory metadata', attributes: [
      ...['employeeNumber', 'costCenter', 'organization', 'division', 'department'].map(name => attribute(name)),
      attribute('manager', 'complex', { subAttributes: [attribute('value', 'string', { required: true, caseExact: true }),
        attribute('$ref', 'reference', { caseExact: true }), attribute('displayName')] }),
    ] },
  ].map(schema => ({ ...schema, schemas: ['urn:ietf:params:scim:schemas:core:2.0:Schema'],
    meta: { resourceType: 'Schema', location: `${base(c)}/Schemas/${encodeURIComponent(schema.id)}` } }));
}

function resourceTypes(c: AppContext): ScimObject[] {
  return [
    { id: 'User', name: 'User', endpoint: '/Users', description: 'Organization-provisioned Users', schema: SCIM_USER_SCHEMA,
      schemaExtensions: [{ schema: SCIM_ENTERPRISE_SCHEMA, required: false }] },
    { id: 'Group', name: 'Group', endpoint: '/Groups', description: 'Organization team Groups', schema: SCIM_GROUP_SCHEMA, schemaExtensions: [] },
  ].map(resource => ({ ...resource, schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
    meta: { resourceType: 'ResourceType', location: `${base(c)}/ResourceTypes/${resource.id}` } }));
}

export function scimDiscovery(c: AppContext, resource: 'ServiceProviderConfig' | 'Schemas' | 'ResourceTypes', id?: string): Response {
  if (resource === 'ServiceProviderConfig') return scimResponse(c, {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'], documentationUri: `${publicOrigins(c.env).app}/docs/federation`,
    patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 100 }, changePassword: { supported: false }, sort: { supported: false }, etag: { supported: true },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'GitKnot scoped provisioning token',
      description: 'Organization/provider-bound, expiring, revocable SCIM-only bearer token.',
      specUri: 'https://www.rfc-editor.org/rfc/rfc6750', primary: true }],
    meta: { resourceType: 'ServiceProviderConfig', location: `${base(c)}/ServiceProviderConfig` },
  });
  const values = resource === 'Schemas' ? schemas(c) : resourceTypes(c);
  if (id) {
    const value = values.find(value => value.id === id);
    if (!value) throw new ScimError(404, `The ${resource === 'Schemas' ? 'Schema' : 'ResourceType'} was not found.`);
    return scimResponse(c, value);
  }
  return scimResponse(c, { schemas: [SCIM_LIST_SCHEMA], totalResults: values.length, itemsPerPage: values.length, startIndex: 1, Resources: values });
}

export function federationDiscovery(c: AppContext): ScimObject {
  const origin = publicOrigins(c.env).api;
  return { version: '1', protocols: ['openid-connect-1.0', 'saml-2.0-web-sso', 'scim-2.0'],
    identity_providers: `${origin}/v1/orgs/{org_id}/identity-providers`,
    oidc: { start: `${origin}/v1/auth/oidc/{provider_id}/start`, callback: `${origin}/v1/auth/oidc/{provider_id}/callback`,
      grant_types: ['authorization_code'], pkce_methods: ['S256'], response_modes: ['query'] },
    saml: { start: `${origin}/v1/auth/saml/{provider_id}/start`, metadata: `${origin}/v1/auth/saml/{provider_id}/metadata`,
      acs: `${origin}/v1/auth/saml/{provider_id}/acs`, request_binding: 'HTTP-Redirect', response_binding: 'HTTP-POST', idp_initiated: false },
    scim: { base: `${origin}/scim/v2/{org_id}`, service_provider_config: `${origin}/scim/v2/{org_id}/ServiceProviderConfig`,
      schemas: `${origin}/scim/v2/{org_id}/Schemas`, resource_types: `${origin}/scim/v2/{org_id}/ResourceTypes` },
    openapi: `${origin}/v1/openapi.json` };
}
