import { Context } from 'hono';
import { ApiError, cellDatabase, identityBinding, newId, now, one, resolveRepositoryPlacement, selectRepositoryDatabase } from '@gitknot/core';
import type { AppContext, AppEnv, Bindings, Principal, Repository } from '@gitknot/core';

export const maintenancePrincipal: Principal = {
  id: 'svc_collaboration_maintenance', kind: 'service', user_id: null, credential_id: null,
  capabilities: [], repository_ids: [], account_ids: [], mfa: false,
};
export const retentionPrincipal: Principal = { ...maintenancePrincipal, id: 'system:collaboration-retention' };

export async function assertMaintenanceAuthority(env: Bindings): Promise<void> {
  const exists = await one(identityBinding(env), `SELECT 1 FROM principals p JOIN accounts a ON a.id=p.account_id WHERE p.id=? AND p.kind='service'
    AND p.user_id IS NULL AND p.account_id='acc_collaboration_system' AND p.disabled_at IS NULL AND a.disabled_at IS NULL
    AND (p.expires_at IS NULL OR p.expires_at>?)`, maintenancePrincipal.id, now());
  if (!exists) throw new ApiError(503, 'maintenance_authority_unavailable', 'Collaboration maintenance authority is unavailable.');
}

/** Only internal workers call this. No user-supplied principal or capability enters this context. */
export async function maintenanceContext(env: Bindings, repoId?: string | null): Promise<AppContext> {
  await assertMaintenanceAuthority(env);
  const c = new Context<AppEnv>(new Request('https://internal.gitknot.com/collaboration/maintenance'), { env });
  c.set('principal', { ...maintenancePrincipal });
  c.set('requestId', newId('maintenance'));
  if (repoId) {
    const placement = await resolveRepositoryPlacement(env, repoId);
    if (!placement || placement.cell_id !== env.CELL_ID) throw new ApiError(503, 'maintenance_routing_changed', 'The current repository authority must perform this maintenance.');
    if (placement.state === 'moving' || placement.state === 'fenced') throw new ApiError(423, 'maintenance_repository_fenced', 'Maintenance will resume after the repository authority fence is released.');
    const binding = cellDatabase(env, placement.shard_id);
    selectRepositoryDatabase(c, placement);
    const repository = await one<Pick<Repository, 'state'>>(binding,
      'SELECT state FROM repositories WHERE id=? AND routing_epoch=?', repoId, placement.epoch);
    if (!repository) throw new ApiError(503, 'maintenance_routing_changed', 'The repository authority changed before maintenance.');
    if (repository.state === 'moving') throw new ApiError(423, 'maintenance_repository_fenced', 'Maintenance will resume after the repository move.');
    c.set('routing', { resource_id: repoId, cell_id: placement.cell_id, shard_id: placement.shard_id, epoch: placement.epoch,
      expected_state: repository.state, lifecycle: true });
  } else c.set('database', env.DB.withSession('first-primary'));
  return c;
}

/** A core identity/policy guard failure must not be mistaken for an expired-row race. */
export async function isMaintenanceRace(env: Bindings, error: unknown, stillEligible: () => Promise<boolean>): Promise<boolean> {
  if (!(error instanceof ApiError) || error.status !== 412) return false;
  await assertMaintenanceAuthority(env);
  return !await stillEligible();
}
