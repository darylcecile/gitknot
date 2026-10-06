import { ApiError, many } from '@gitknot/core';
import type { Database } from '@gitknot/core';
import { authenticationFailed } from './errors.ts';
import type { ProviderConfig, VerifiedIdentity } from './types.ts';

export function scalarClaim(claims: Record<string, unknown>, key: string, required = false): string | null {
  const value = Object.hasOwn(claims, key) ? claims[key] : undefined;
  if (value === undefined && !required) return null;
  if (typeof value !== 'string' || !value.length || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw authenticationFailed();
  return value;
}

export function arrayClaim(claims: Record<string, unknown>, key: string | null): string[] {
  if (key === null) return [];
  if (!Object.hasOwn(claims, key)) throw authenticationFailed();
  const raw = claims[key];
  const values = typeof raw === 'string' ? [raw] : raw;
  if (!Array.isArray(values) || values.length > 64 || values.some(value => typeof value !== 'string' || !value.length || value.length > 512)) {
    throw authenticationFailed();
  }
  return [...new Set(values as string[])];
}

export function identityClaims(config: ProviderConfig, claims: Record<string, unknown>): Pick<VerifiedIdentity,
  'tenant' | 'external_id' | 'email' | 'email_verified' | 'display_name' | 'role_values' | 'group_values'> {
  const tenant = scalarClaim(claims, config.tenant_claim, true)!;
  if (!config.tenant_values.includes(tenant)) throw new ApiError(403, 'organization_tenant_mismatch', 'This identity does not belong to a configured organization tenant.');
  const email = scalarClaim(claims, config.email_claim);
  const verified = Object.hasOwn(claims, config.email_verified_claim) ? claims[config.email_verified_claim] : undefined;
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw authenticationFailed();
  return {
    tenant, external_id: scalarClaim(claims, config.external_id_claim, config.provisioning === 'scim_only'),
    email, email_verified: verified === true || (config.protocol === 'saml' && verified === 'true'),
    display_name: scalarClaim(claims, config.name_claim) ?? '',
    role_values: arrayClaim(claims, config.mappings.role_claim), group_values: arrayClaim(claims, config.mappings.group_claim),
  };
}

export function capabilityMatches(pattern: string, capability: string): boolean {
  return pattern === '*' || pattern === capability || (pattern.endsWith('.*') && capability.startsWith(pattern.slice(0, -1)));
}

export function capabilityWithinCeiling(config: ProviderConfig, capability: string): boolean {
  return config.mappings.capability_ceiling.some(pattern => capabilityMatches(pattern, capability))
    && !config.mappings.denied_capabilities.some(pattern => capabilityMatches(pattern, capability));
}

export function mappedRole(config: ProviderConfig, values: string[]): string {
  const mapping = config.mappings;
  if (values.some(value => mapping.denied_role_values.includes(value))) throw new ApiError(403, 'federation_mapping_denied', 'Organization role policy explicitly denies this identity.');
  const roles = new Set<string>();
  for (const value of values) {
    const match = mapping.role_mappings.find(item => item.value === value);
    if (match) roles.add(match.role_id);
    else if (mapping.deny_unmapped_roles) throw new ApiError(403, 'federation_role_unmapped', 'An asserted role has no approved organization mapping.');
  }
  if (roles.size > 1) throw new ApiError(403, 'federation_role_ambiguous', 'The provider asserted conflicting organization roles.');
  const role = [...roles][0] ?? mapping.default_role_id;
  if (role === 'owner' || !mapping.role_ceiling.includes(role)) throw new ApiError(403, 'federation_role_ceiling', 'The organization role exceeds its federation ceiling.');
  return role;
}

export function mappedTeams(config: ProviderConfig, values: string[]): string[] {
  const teams = new Set<string>();
  for (const value of values) {
    const match = config.mappings.team_mappings.find(item => item.value === value);
    if (!match && config.mappings.deny_unmapped_groups) throw new ApiError(403, 'federation_group_unmapped', 'An asserted group has no approved organization team mapping.');
    if (match) {
      if (!config.mappings.team_ceiling.includes(match.team_id)) throw new ApiError(403, 'federation_team_ceiling', 'The organization team exceeds its federation ceiling.');
      teams.add(match.team_id);
    }
  }
  return [...teams];
}

/** Current role definitions are checked again at exchange/provisioning time, not only at configuration. */
export async function validateEntitlements(db: Database, accountId: string, config: ProviderConfig): Promise<void> {
  const roles = await many<{ id: string; account_id: string | null; repo_id: string | null; capability: string | null; effect: string | null }>(db,
    `SELECT r.id,r.account_id,r.repo_id,c.capability,c.effect FROM roles r LEFT JOIN role_capabilities c ON c.role_id=r.id
     WHERE r.id IN (SELECT value FROM json_each(?))`, JSON.stringify(config.mappings.role_ceiling));
  if (new Set(roles.map(row => row.id)).size !== config.mappings.role_ceiling.length
    || roles.some(row => row.id === 'owner' || row.repo_id !== null || (row.account_id !== null && row.account_id !== accountId))) {
    throw new ApiError(422, 'federation_role_invalid', 'Every federation role must be a current organization or built-in role.');
  }
  if (roles.some(row => row.effect === 'allow' && row.capability && !config.mappings.capability_ceiling.some(pattern => capabilityMatches(pattern, row.capability!)))) {
    throw new ApiError(403, 'federation_capability_ceiling', 'A mapped role grants capabilities outside the explicitly approved federation ceiling.');
  }
  const teams = await many<{ id: string }>(db, 'SELECT id FROM teams WHERE account_id=? AND id IN (SELECT value FROM json_each(?))',
    accountId, JSON.stringify(config.mappings.team_ceiling));
  if (teams.length !== config.mappings.team_ceiling.length) throw new ApiError(422, 'federation_team_invalid', 'Every federation team must belong to this organization.');
}
