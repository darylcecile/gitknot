export { identityAuthorityBindings, identityBinding, identityDatabase, selectIdentityDatabase, separateIdentityAuthority } from './authority/identity.ts';
export { identityDatabaseLocation, sameDatabaseLocation } from './routing/locations.ts';
export { captureAccountAuthority, currentAccountAuthority, fenceAccountAuthority, installAccountAuthorityFence,
  ownedAccountAuthority, recoverAccountAuthorityBarriers, registerAccountAuthorityPlacement,
  registerRepositoryPlacement, releaseAccountAuthority, withAccountAuthorityBarrier } from './authority/epochs.ts';
export type { RepositoryAuthorityPlacement } from './authority/epochs.ts';
export { readRepositoryAuthority, resolveRepositoryPlacement } from './routing/repositories.ts';
export type { RepositoryPlacement } from './routing/repositories.ts';
