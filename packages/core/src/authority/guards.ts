import type { CredentialRecord } from '../auth.ts';
import { currentPolicyBarrier } from '../auth.ts';
import { many, one, stmt } from '../db.ts';
import { ApiError } from '../errors.ts';
import { requestDatabaseBinding, requestDatabaseLocation } from '../routing/cells.ts';
import { sameDatabaseLocation } from '../routing/locations.ts';
import { readRepositoryAuthority, resolveRepositoryPlacement } from '../routing/repositories.ts';
import type { AccountAuthorityVersion, AppContext, Database, MutationAuthority, PrincipalAuthorityVersion, RequestPolicy } from '../types.ts';
import { captureAccountAuthority, ownedAccountAuthority, registerAccountAuthorityPlacement } from './epochs.ts';
import { identityBinding, separateIdentityAuthority } from './identity.ts';

function authenticatedActor(c: AppContext, authority: MutationAuthority) {
  const actor = c.get('principal');
  const original = authority.principal;
  if (!actor || !original || actor.id !== original.id || actor.kind !== original.kind
    || actor.user_id !== original.user_id || actor.credential_id !== original.credential_id) {
    throw new ApiError(401, 'authentication_required', 'Authenticate the principal that owns this request.');
  }
  if (actor.credential_id && (!authority.credential_versions.length || authority.credential_versions.at(-1)!.parent_id !== null)) {
    throw new ApiError(401, 'authentication_required', 'This credential is no longer current.');
  }
  return actor;
}

function identityConditions(c: AppContext, authority: MutationAuthority): { sql: string; values: unknown[] } {
  const actor = authenticatedActor(c, authority);
  const chain = authority.credential_versions;
  const clock = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  const conditions: string[] = [];
  const values: unknown[] = [];
  conditions.push('EXISTS (SELECT 1 FROM principals WHERE id=? AND kind=? AND user_id IS ?)');
  values.push(actor.id, actor.kind, actor.user_id);
  for (const principalId of new Set([actor.id, ...chain.map(value => value.principal_id)])) {
    conditions.push(`EXISTS (SELECT 1 FROM principals p LEFT JOIN accounts a ON a.id=p.account_id
      WHERE p.id=? AND p.disabled_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>${clock})
        AND (p.account_id IS NULL OR (a.id IS NOT NULL AND a.disabled_at IS NULL)))`);
    values.push(principalId);
  }
  for (const principal of authority.principal_versions ?? []) {
    conditions.push('EXISTS (SELECT 1 FROM principals WHERE id=? AND kind=? AND user_id IS ? AND account_id IS ?)');
    values.push(principal.id, principal.kind, principal.user_id, principal.account_id);
  }
  if (actor.user_id) {
    conditions.push('EXISTS (SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL)');
    values.push(actor.user_id);
  }
  for (const credential of chain) {
    conditions.push(`EXISTS (SELECT 1 FROM credentials WHERE id=? AND revision=? AND parent_id IS ?
      AND revoked_at IS NULL AND expires_at>${clock})`);
    values.push(credential.id, credential.revision, credential.parent_id);
    if (credential.user_id) {
      conditions.push('EXISTS (SELECT 1 FROM users WHERE id=? AND auth_revision=? AND disabled_at IS NULL)');
      values.push(credential.user_id, credential.auth_revision);
    }
  }
  return { sql: conditions.join(' AND '), values };
}

/** Used only on the identity primary, where these rows really are authoritative. */
export function primaryIdentityGuard(c: AppContext, authority: MutationAuthority, db: Database, id: string): D1PreparedStatement {
  const check = identityConditions(c, authority);
  return stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN ${check.sql} THEN 1 ELSE 0 END`, id, ...check.values);
}

/** Capture credential dependencies before authorization/stream admission. */
export async function captureIdentityAuthority(c: AppContext, authority: MutationAuthority, chain: CredentialRecord[]): Promise<void> {
  if (!authority.principal) return;
  const actor = authenticatedActor(c, authority);
  const ids = [...new Set([actor.id, ...chain.map(item => item.principal_id)])];
  const db = identityBinding(c.env).withSession('first-primary');
  const principals = await many<PrincipalAuthorityVersion & { expires_at: string | null }>(db,
    `SELECT id,kind,account_id,user_id,expires_at FROM principals WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  if (principals.length !== ids.length) throw new ApiError(401, 'authentication_required', 'This principal is no longer current.');
  authority.principal_versions = principals.map(({ expires_at, ...principal }) => { void expires_at; return principal; });
  if (!separateIdentityAuthority(c)) return;
  if (principals.some(item => !item.account_id && !item.user_id)) {
    throw new ApiError(401, 'authentication_required', 'This principal has no current account authority.');
  }
  const accounts = [...new Set([actor.user_id, ...chain.map(item => item.user_id),
    ...principals.flatMap(item => [item.account_id, item.user_id])].filter((value): value is string => value !== null))];
  for (const accountId of accounts) await captureAccountAuthority(c, accountId);
  const expires = [...chain.map(item => item.expires_at), ...principals.map(item => item.expires_at)].filter((value): value is string => value !== null).sort();
  authority.identity_expires_at = expires[0] ?? null;
  // Epochs precede this final primary check. If revocation ran between reading
  // the chain and enrolling a placement, its old credential versions are denied.
  const check = identityConditions(c, authority);
  const current = await one<{ ok: number }>(identityBinding(c.env).withSession('first-primary'), `SELECT (${check.sql}) AS ok`, ...check.values);
  if (current?.ok !== 1) throw new ApiError(401, 'authentication_required', 'This credential is no longer current.');
}

export function remoteIdentityGuard(c: AppContext, authority: MutationAuthority, db: Database, id: string): D1PreparedStatement {
  authenticatedActor(c, authority);
  if (!authority.account_versions?.length) throw new ApiError(503, 'identity_authority_unavailable', 'The original identity authority could not be verified.');
  return stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN ? IS NULL OR ?>strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 1 ELSE 0 END`,
    id, authority.identity_expires_at ?? null, authority.identity_expires_at ?? null);
}

function authorityChanged(): ApiError {
  return new ApiError(412, 'revision_conflict', 'The authorization authority changed while this request was in flight. Refresh and retry.');
}

export async function repositoryPolicyIsLocal(c: AppContext, policy: RequestPolicy): Promise<boolean> {
  if (!policy.repo_id) return false;
  const routed = c.get('routing');
  if (routed?.resource_id === policy.repo_id) {
    return sameDatabaseLocation(routed, requestDatabaseLocation(c));
  }
  const placement = await resolveRepositoryPlacement(c.env, policy.repo_id);
  if (!placement) throw authorityChanged();
  return sameDatabaseLocation(placement, requestDatabaseLocation(c));
}

/** Prepare cross-D1 dependencies; the returned SQL fences the captured epochs. */
export async function prepareAccountAuthority(c: AppContext, authority: MutationAuthority,
  policies: { policy: RequestPolicy; local: boolean }[]): Promise<AccountAuthorityVersion[]> {
  const remote = separateIdentityAuthority(c);
  for (const { policy, local } of policies) {
    if (!policy.account_id || !remote && (!policy.repo_id || local) && !ownedAccountAuthority(c, policy.account_id)) continue;
    await captureAccountAuthority(c, policy.account_id, policy.account_policy_revision);
    if (policy.repo_id && !local) {
      const repository = await readRepositoryAuthority(c, policy.repo_id);
      if (!repository || repository.owner_id !== policy.account_id || repository.policy_revision !== policy.policy_revision
        || repository.routing_epoch !== policy.routing_epoch
        || policy.repository_revision != null && repository.revision !== policy.repository_revision) throw authorityChanged();
    }
  }
  const versions = (authority.account_versions ?? []).map(item => ownedAccountAuthority(c, item.account_id) ?? item);
  if (remote) {
    const placement = c.get('routing');
    if (!placement) throw new ApiError(503, 'routing_unavailable', 'This repository mutation has no current placement.');
    for (const captured of versions) {
      if (captured.phase === 'active') {
        // Idempotent enrollment cannot refresh a previously captured epoch.
        await registerAccountAuthorityPlacement(c.env, captured.account_id, placement, captured);
      } else {
        const local = await one<AccountAuthorityVersion>(requestDatabaseBinding(c).withSession('first-primary'),
          'SELECT account_id,epoch,policy_revision,phase,barrier_id FROM account_authority_fences WHERE account_id=?', captured.account_id);
        if (!local || local.epoch !== captured.epoch || local.barrier_id !== captured.barrier_id || local.phase !== 'fenced') throw authorityChanged();
      }
    }
  }
  return versions;
}

export function accountAuthorityGuard(c: AppContext, db: Database, captured: AccountAuthorityVersion, id: string): D1PreparedStatement {
  if (separateIdentityAuthority(c)) {
    return stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN EXISTS (
      SELECT 1 FROM account_authority_fences WHERE account_id=? AND epoch=? AND policy_revision=? AND phase=? AND barrier_id IS ?
    ) THEN 1 ELSE 0 END`, id, captured.account_id, captured.epoch, captured.policy_revision, captured.phase, captured.barrier_id);
  }
  const barrier = currentPolicyBarrier(c, captured.account_id);
  return stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN EXISTS (
    SELECT 1 FROM account_authority_epochs e WHERE e.account_id=? AND e.epoch=? AND e.phase=? AND e.barrier_id IS ?
      AND (e.phase='active' OR NOT EXISTS (SELECT 1 FROM account_authority_placements p WHERE p.account_id=e.account_id
        AND (p.acknowledged_epoch<>e.epoch OR p.acknowledged_phase IS NOT 'fenced')))
  ) AND ${barrier ? 'EXISTS (SELECT 1 FROM account_policy_barriers WHERE account_id=? AND id=?)'
    : 'NOT EXISTS (SELECT 1 FROM account_policy_barriers WHERE account_id=?)'} THEN 1 ELSE 0 END`,
  id, captured.account_id, captured.epoch, captured.phase, captured.barrier_id, captured.account_id, ...(barrier ? [barrier] : []));
}
