import { ApiError } from '@gitknot/core';
import { SCIM_ERROR_SCHEMA, SCIM_MEDIA_TYPE } from './types.ts';

export type ScimErrorType = 'invalidFilter' | 'tooMany' | 'uniqueness' | 'mutability' | 'invalidSyntax'
  | 'invalidPath' | 'noTarget' | 'invalidValue' | 'invalidVers' | 'sensitive';

export class ScimError extends Error {
  constructor(readonly status: number, message: string, readonly scimType?: ScimErrorType, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = 'ScimError';
  }
}

export function authenticationFailed(): ApiError {
  return new ApiError(401, 'federation_verification_failed', 'The organization sign-in could not be verified. Start a new sign-in.');
}

export function integrationUnavailable(): ApiError {
  return new ApiError(503, 'federation_unavailable', 'Organization identity is temporarily unavailable.');
}

export function scimErrorResponse(error: unknown, requestId: string): Response {
  const known = error instanceof ScimError || error instanceof ApiError;
  const status = known ? error.status : 503;
  const detail = known ? error.message : 'Organization provisioning is temporarily unavailable.';
  const type = error instanceof ScimError ? error.scimType : undefined;
  const headers = new Headers({
    'content-type': `${SCIM_MEDIA_TYPE}; charset=utf-8`, 'cache-control': 'no-store',
    'x-gitknot-request-id': requestId,
  });
  if (status === 401) headers.set('www-authenticate', 'Bearer realm="GitKnot SCIM"');
  if (error instanceof ScimError && error.retryAfterSeconds) headers.set('retry-after', String(error.retryAfterSeconds));
  return new Response(JSON.stringify({ schemas: [SCIM_ERROR_SCHEMA], status: String(status),
    ...(type ? { scimType: type } : {}), detail }), { status, headers });
}

export function translateScimMutationError(error: unknown): never {
  if (error instanceof ScimError) throw error;
  const text = String(error);
  if (/last_recoverable_owner|owner_must_be_recoverable|personal_owner_immutable|last_authenticator/.test(text)) {
    throw new ScimError(409, 'Keep another verified, active organization owner with an independent recovery method before deprovisioning this owner.', 'mutability');
  }
  if (/UNIQUE constraint failed/.test(text)) throw new ScimError(409, 'A resource with this user name, external ID, or identity already exists.', 'uniqueness');
  if (/federation_guard|CHECK constraint failed.*ok|mutation_requires_one_row/.test(text)) {
    throw new ScimError(412, 'The resource, provider policy, or provisioning credential changed. Retrieve it again before retrying.');
  }
  throw error;
}
