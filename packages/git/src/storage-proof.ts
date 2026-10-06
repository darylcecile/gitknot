import { requireValue } from './errors.ts';
import type { GitStorageCreationEvidence } from './types.ts';

export function validateOwnershipMarker(value: unknown): asserts value is string {
  requireValue(typeof value === 'string' && value.length >= 32 && value.length <= 512 && /^[\x21-\x7e]+$/u.test(value),
    'storage_creation_marker', 'An exact bounded provider ownership marker is required.', 503);
}

export function creationEvidence(value: unknown, name: string, provider: GitStorageCreationEvidence['provider']): GitStorageCreationEvidence {
  const proof = value as Partial<GitStorageCreationEvidence> | null;
  requireValue(proof && proof.version === 1 && proof.provider === provider && proof.storage_name === name
    && typeof proof.provider_id === 'string' && proof.provider_id.length > 0 && proof.provider_id.length <= 256
    && /^[\x21-\x7e]+$/u.test(proof.provider_id), 'storage_creation_unverified', 'The provider creation receipt has a different namespace identity.', 503);
  validateOwnershipMarker(proof.marker);
  return { version: 1, provider, storage_name: name, provider_id: proof.provider_id, marker: proof.marker };
}
