import { ApiError, identityBinding, now, one, sha256 } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';

export interface MaintenanceAuthority {
  operation_id: string; repo_id: string; account_id: string;
  purpose: 'repository.backup' | 'repository.purge' | 'repository.move';
  routing_epoch: number; repository_revision: number;
  barrier_token_hash: string | null; barrier_held_at: string | null; barrier_released_at: string | null;
}

/** Private purpose authority is created with the operation, never inferred from a caller's maintenance flag. */
export async function requireMaintenanceAuthority(env: Bindings, repoId: string, operationId: string,
  purpose: MaintenanceAuthority['purpose'], barrierToken?: string): Promise<MaintenanceAuthority> {
  const row = await one<MaintenanceAuthority>(env.DB.withSession('first-primary'), `SELECT i.* FROM operations_maintenance_intents i
    JOIN operations o ON o.id=i.operation_id JOIN repositories r ON r.id=i.repo_id
    WHERE i.operation_id=? AND i.repo_id=? AND i.purpose=? AND i.authority_id='svc_operations_maintenance'
      AND o.actor_id='system:operations' AND o.kind=i.purpose AND o.repo_id=i.repo_id AND o.account_id=i.account_id
      AND o.status IN ('pending','waiting','running','failed') AND json_extract(o.input_json,'$.maintenance')=1
      AND r.owner_id=i.account_id AND r.routing_epoch=i.routing_epoch AND r.revision>=i.repository_revision`, operationId, repoId, purpose);
  const authority = await one(identityBinding(env).withSession('first-primary'), `SELECT 1 FROM principals p JOIN accounts a ON a.id=p.account_id
    WHERE p.id='svc_operations_maintenance' AND p.kind='service' AND p.user_id IS NULL AND p.account_id='acc_operations_system'
      AND p.disabled_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?) AND a.disabled_at IS NULL`, now());
  if (!row || !authority || barrierToken !== undefined && (!row.barrier_held_at || row.barrier_released_at
    || row.barrier_token_hash !== await sha256(barrierToken))) {
    throw new ApiError(403, 'maintenance_authority_required', 'This operation has no current registered maintenance purpose authority.');
  }
  return row;
}
