import type { Principal } from '@gitknot/core';
import type { z } from 'zod';
import type { providerConfigSchema, organizationPolicySchema } from './config.ts';

export const FEDERATION_IDENTITY_CONTRACT = 'gitknot.identity.federation.v1';
export const FLOW_SECONDS = 300;
export const CLOCK_SKEW_SECONDS = 30;
export const SCIM_MEDIA_TYPE = 'application/scim+json';
export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCIM_ENTERPRISE_SCHEMA = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCIM_SEARCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:SearchRequest';

export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type OrganizationPolicy = z.infer<typeof organizationPolicySchema>;
export type OidcConfig = Extract<ProviderConfig, { protocol: 'oidc' }>;
export type SamlConfig = Extract<ProviderConfig, { protocol: 'saml' }>;

export interface IdentityProvider {
  id: string;
  account_id: string;
  name: string;
  protocol: 'oidc' | 'saml';
  config_json: string;
  enabled: number;
  revision: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Provider extends IdentityProvider { config: ProviderConfig }

export interface OrganizationPolicyRecord {
  account_id: string;
  config_json: string;
  revision: number;
  updated_by: string;
  updated_at: string;
}

/** Only hashes of browser/state/nonce are persisted. PKCE verifiers expire with the flow. */
export interface AuthenticationFlow {
  id: string;
  account_id: string;
  provider_id: string;
  provider_revision: number;
  protocol: 'oidc' | 'saml';
  state_hash: string;
  browser_hash: string;
  nonce_hash: string | null;
  pkce_verifier: string | null;
  saml_request_id: string | null;
  return_path: string;
  link_user_id: string | null;
  link_credential_id: string | null;
  link_auth_revision: number | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  exchange_started_at: string | null;
  completed_at: string | null;
}

/** Constructed only by verified OIDC/SAML adapters; never accepted in a public request. */
export interface VerifiedIdentity {
  protocol: 'oidc' | 'saml';
  issuer: string;
  subject: string;
  tenant: string;
  external_id: string | null;
  email: string | null;
  email_verified: boolean;
  display_name: string;
  authenticated_at: string;
  mfa: true;
  session_expires_at: string | null;
  role_values: string[];
  group_values: string[];
  replays: { kind: 'oidc_token' | 'saml_assertion' | 'saml_response'; value: string; expires_at: string }[];
}

export interface FederatedSubject {
  id: string;
  account_id: string;
  provider_id: string;
  issuer: string;
  subject: string;
  tenant: string;
  user_id: string;
  external_id: string | null;
  scim_user_id: string | null;
  state: 'pending' | 'active' | 'suspended';
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface ScimUserRow {
  id: string;
  account_id: string;
  provider_id: string;
  user_id: string;
  external_id: string;
  user_name: string;
  user_name_key: string;
  active: number;
  attributes_json: string;
  search_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ScimGroupRow {
  id: string;
  account_id: string;
  provider_id: string;
  external_id: string;
  display_name: string;
  display_name_key: string;
  team_id: string;
  revision: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ProvisioningToken {
  id: string;
  account_id: string;
  provider_id: string;
  credential_id: string;
  principal_id: string;
  name: string;
  revision: number;
  created_at: string;
  revoked_at: string | null;
}

export interface ProvisioningContext {
  provider: Provider;
  token: ProvisioningToken;
  principal: Principal;
  account_policy_revision?: number;
}

export type ScimObject = Record<string, unknown>;
export type FederationSecretKind = 'oidc_client_secret' | 'saml_signing_key';

export interface FederationSecretRow {
  id: string;
  account_id: string;
  provider_id: string;
  kind: FederationSecretKind;
  version: number;
  context_json: string;
  ciphertext: string;
  iv: string;
  wrapped_key: string;
  wrap_iv: string;
  kek_id: string;
  public_certificate: string | null;
  created_at: string;
  revoked_at: string | null;
}
