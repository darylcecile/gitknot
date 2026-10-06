import { z } from 'zod';
import { ApiError } from '@gitknot/core';
import type { IdentityProvider, OrganizationPolicy, Provider, ProviderConfig } from './types.ts';

const text = z.string().trim().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/);
const claimName = z.string().min(1).max(256).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value));
const capability = z.string().min(1).max(120).regex(/^(?:\*|[a-z][a-z0-9_]*(?:\.[a-z0-9_*]+)+)$/);
const roleId = z.string().min(1).max(100).refine(value => value !== 'owner', 'Federation cannot assign organization ownership.');
const teamId = z.string().regex(/^team_[a-zA-Z0-9_-]{8,100}$/);
const endpoint = z.url().max(2048);

export const mappingsSchema = z.object({
  role_claim: claimName.nullable().default(null),
  group_claim: claimName.nullable().default(null),
  default_role_id: roleId.default('member'),
  role_mappings: z.array(z.object({ value: text, role_id: roleId }).strict()).max(64).default([]),
  role_ceiling: z.array(roleId).min(1).max(64).default(['member']),
  capability_ceiling: z.array(capability).min(1).max(128).default(['accounts.read', 'members.read', 'teams.read', 'repositories.create']),
  denied_capabilities: z.array(capability).max(128).default([]),
  denied_role_values: z.array(text).max(64).default([]),
  team_mappings: z.array(z.object({ value: text, team_id: teamId }).strict()).max(64).default([]),
  scim_group_mappings: z.array(z.object({ external_id: text, team_id: teamId }).strict()).max(64).default([]),
  team_ceiling: z.array(teamId).max(64).default([]),
  deny_unmapped_roles: z.boolean().default(true),
  deny_unmapped_groups: z.boolean().default(true),
}).strict();

const common = {
  tenant_claim: claimName,
  tenant_values: z.array(text).min(1).max(32),
  external_id_claim: claimName,
  email_claim: claimName.default('email'),
  email_verified_claim: claimName.default('email_verified'),
  name_claim: claimName.default('name'),
  provisioning: z.enum(['scim_only', 'jit']).default('scim_only'),
  max_authentication_age_seconds: z.number().int().min(60).max(900).default(300),
  mappings: mappingsSchema.default(() => mappingsSchema.parse({})),
};

export const providerConfigSchema = z.discriminatedUnion('protocol', [
  z.object({
    ...common, protocol: z.literal('oidc'),
    issuer: endpoint,
    authorization_endpoint: endpoint,
    token_endpoint: endpoint,
    jwks_uri: endpoint,
    client_id: text,
    token_endpoint_auth_method: z.enum(['client_secret_basic', 'client_secret_post', 'none']).default('client_secret_basic'),
    scopes: z.array(z.string().regex(/^[A-Za-z0-9_:./-]{1,128}$/)).min(1).max(16).default(['openid', 'profile', 'email']),
    signing_algorithms: z.array(z.enum(['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384'])).min(1).max(8).default(['RS256']),
    mfa_acr_values: z.array(text).max(16).default([]),
    require_authorization_response_issuer: z.boolean().default(true),
  }).strict(),
  z.object({
    ...common, protocol: z.literal('saml'),
    issuer: text,
    sso_url: endpoint,
    signing_certificates: z.array(z.string().min(100).max(16_384)).min(1).max(3),
    response_signature_required: z.boolean().default(true),
    sign_authn_requests: z.boolean().default(true),
    name_id_format: z.enum(['urn:oasis:names:tc:SAML:2.0:nameid-format:persistent', 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified'])
      .default('urn:oasis:names:tc:SAML:2.0:nameid-format:persistent'),
    mfa_contexts: z.array(text).min(1).max(16).default(['https://refeds.org/profile/mfa']),
  }).strict(),
]);

export const createProviderSchema = z.object({ name: z.string().trim().min(1).max(120), config: providerConfigSchema }).strict();
export const updateProviderSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(), config: providerConfigSchema.optional(), enabled: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0);

export const organizationPolicySchema = z.object({
  required: z.boolean().default(false),
  session_max_age_seconds: z.number().int().min(300).max(43_200).default(3600),
  machine_access: z.enum(['deny', 'scoped']).default('scoped'),
}).strict();

export function parseProvider(row: IdentityProvider): Provider {
  try {
    const config = providerConfigSchema.parse(JSON.parse(row.config_json));
    if (row.protocol !== config.protocol) throw new Error('Protocol mismatch');
    return { ...row, config };
  } catch { throw new ApiError(503, 'federation_configuration_unavailable', 'The organization identity configuration could not be verified.'); }
}

export function parseOrganizationPolicy(value?: string): OrganizationPolicy {
  try { return organizationPolicySchema.parse(value ? JSON.parse(value) : {}); }
  catch { throw new ApiError(503, 'federation_configuration_unavailable', 'The organization sign-in policy could not be verified.'); }
}

function unique(values: string[], field: string): void {
  if (new Set(values).size !== values.length) throw new ApiError(422, 'ambiguous_federation_mapping', `${field} must not contain duplicate values.`);
}

export function validateMappingConfiguration(config: ProviderConfig): void {
  const mapping = config.mappings;
  unique(config.tenant_values, 'tenant_values');
  unique(mapping.role_mappings.map(value => value.value), 'role_mappings');
  unique(mapping.team_mappings.map(value => value.value), 'team_mappings');
  unique(mapping.scim_group_mappings.map(value => value.external_id), 'scim_group_mappings');
  unique(mapping.scim_group_mappings.map(value => value.team_id), 'SCIM-managed teams');
  unique(mapping.role_ceiling, 'role_ceiling');
  unique(mapping.team_ceiling, 'team_ceiling');
  if (![mapping.default_role_id, ...mapping.role_mappings.map(value => value.role_id)].every(id => mapping.role_ceiling.includes(id))) {
    throw new ApiError(422, 'federation_role_ceiling', 'Every mapped/default role must be explicitly included in the role ceiling.');
  }
  if (![...mapping.team_mappings, ...mapping.scim_group_mappings].every(value => mapping.team_ceiling.includes(value.team_id))) {
    throw new ApiError(422, 'federation_team_ceiling', 'Every mapped team must be explicitly included in the team ceiling.');
  }
  if (config.protocol === 'oidc' && !config.scopes.includes('openid')) {
    throw new ApiError(422, 'oidc_scope_required', 'The openid scope is required.');
  }
  if (config.protocol === 'saml' && config.mfa_contexts.some(value => /(?:Password|PasswordProtectedTransport|unspecified)$/i.test(value))) {
    throw new ApiError(422, 'mfa_assurance_required', 'A password-only SAML authentication context cannot establish MFA assurance.');
  }
  if ([config.email_claim, config.email_verified_claim].includes(config.external_id_claim)) {
    throw new ApiError(422, 'immutable_external_id_required', 'Use an immutable provider object ID, rather than an email claim, for SCIM identity linking.');
  }
}

export function sameProviderIdentity(old: ProviderConfig, next: ProviderConfig): boolean {
  if (old.protocol !== next.protocol || old.issuer !== next.issuer || old.tenant_claim !== next.tenant_claim
    || old.external_id_claim !== next.external_id_claim) return false;
  if (JSON.stringify([...old.tenant_values].sort()) !== JSON.stringify([...next.tenant_values].sort())) return false;
  return old.protocol !== 'oidc' || (next.protocol === 'oidc' && old.client_id === next.client_id && old.token_endpoint === next.token_endpoint);
}
