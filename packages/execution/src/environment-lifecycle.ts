import { ApiError, database, expectedRevision, getRepository, identityDatabase, mutate, now, one, registerRepositoryPlacement, requirePrincipal, stmt, withAccountAuthorityBarrier } from '@gitknot/core';
import type { AppContext, IdempotencyOptions } from '@gitknot/core';
import type { EnvironmentRecord } from './environments.ts';

const idleEnvironment = `NOT EXISTS (SELECT 1 FROM workflow_jobs j WHERE j.repo_id=workflow_environments.repo_id
    AND json_extract(j.definition_json,'$.environment.id')=workflow_environments.id
    AND j.status IN ('waiting','ready','queued','admitting','running','waiting_approval','cancelling'))
  AND NOT EXISTS (SELECT 1 FROM execution_attempts a JOIN workflow_jobs j ON j.id=a.job_id AND j.repo_id=a.repo_id
    WHERE a.repo_id=workflow_environments.repo_id AND json_extract(j.definition_json,'$.environment.id')=workflow_environments.id
    AND (a.status IN ('queued','accepted','admitting','leased','running','cancelling') OR a.cleanup_state NOT IN ('none','verified')))
  AND NOT EXISTS (SELECT 1 FROM workflow_promotion_barriers b JOIN workflow_promotions p ON p.id=b.promotion_id AND p.repo_id=b.repo_id
    WHERE p.repo_id=workflow_environments.repo_id AND p.environment_id=workflow_environments.id AND b.state!='released')
  AND NOT EXISTS (SELECT 1 FROM workflow_promotions p WHERE p.repo_id=workflow_environments.repo_id AND p.environment_id=workflow_environments.id AND p.status='promoting')`;

export const environmentDeletionRecovery: IdempotencyOptions = {
  recover: async (c, record) => {
    const repository = await getRepository(c, c.req.param('repoId'), 'environments.manage');
    if (record.repo_id !== repository.id || record.resource_id !== c.req.param('envId') || !record.committed_at || !record.event_id) return null;
    const retired = await one(database(c), `SELECT e.id FROM workflow_environments e JOIN outbox o ON o.resource_id=e.id AND o.repo_id=e.repo_id
      WHERE e.id=? AND e.repo_id=? AND e.state='deleted' AND e.deleted_by=? AND o.id=? AND o.type='workflow.environment.deleted'`,
    record.resource_id, repository.id, record.principal_id, record.event_id);
    if (!retired) throw new ApiError(503, 'environment_deletion_unconfirmed', 'The original environment deletion receipt must be reconciled.');
    return c.body(null, 204);
  },
};

/** Retire policy authority while retaining immutable approvals, releases and vault history. */
export async function deleteWorkflowEnvironment(c: AppContext, id: string): Promise<void> {
  const repository = await getRepository(c, c.req.param('repoId'), 'environments.manage'), db = database(c);
  const environment = await one<EnvironmentRecord>(db, 'SELECT * FROM workflow_environments WHERE id=? AND repo_id=?', id, repository.id);
  if (!environment || environment.account_id !== repository.owner_id) throw new ApiError(404, 'not_found', 'The requested resource was not found.');
  const revision = expectedRevision(c);
  if (environment.revision !== revision) throw new ApiError(412, 'revision_conflict', 'The environment changed. Refresh its ETag before deleting it.');
  if (environment.state === 'deleted') throw new ApiError(410, 'environment_deleted', 'This environment has already been retired. Its history is retained.');
  await registerRepositoryPlacement(c.env, { repo_id: repository.id, account_id: repository.owner_id, cell_id: repository.cell_id,
    shard_id: repository.shard_id, epoch: repository.routing_epoch });
  await withAccountAuthorityBarrier(c, repository.owner_id, `environment.delete:${id}`, async () => {
    // The identity-primary barrier rejects both fresh vault writes and older
    // writes whose captured epoch predates it, including separate metadata cells.
    const configured = await one(identityDatabase(c), 'SELECT id FROM vault_entries WHERE repo_id=? AND environment_id=? AND deleted_at IS NULL LIMIT 1', repository.id, id);
    if (configured) throw new ApiError(409, 'environment_configuration_active', 'Revoke this environment’s secrets and variables before retiring it.');
    const busy = await one(db, `SELECT id FROM workflow_environments WHERE id=? AND repo_id=? AND NOT (${idleEnvironment})`, id, repository.id);
    if (busy) throw new ApiError(409, 'environment_in_use', 'Finish or cancel this environment’s jobs and reconcile executor cleanup and active release decisions before deleting it.');
    const at = now(), actor = requirePrincipal(c);
    await mutate(c, { sql: `UPDATE workflow_environments SET state='deleted',deleted_at=?,deleted_by=?,revision=revision+1,updated_at=?
      WHERE id=? AND repo_id=? AND account_id=? AND revision=? AND state='active' AND ${idleEnvironment}`,
    bindings: [at, actor.id, at, id, repository.id, repository.owner_id, revision], after: [
      stmt(db, `UPDATE workflow_promotions SET status='invalidated',revision=revision+1,updated_at=? WHERE repo_id=? AND environment_id=? AND status IN ('waiting','waiting_approval','approved')`, at, repository.id, id),
      stmt(db, `UPDATE workflow_run_requests SET status='failed',error_json=?,revision=revision+1,completed_at=?,updated_at=?
        WHERE repo_id=? AND kind IN ('approve','promote') AND status IN ('pending','running') AND json_extract(input_json,'$.input.promotion_id') IN
          (SELECT id FROM workflow_promotions WHERE repo_id=? AND environment_id=?)`,
      JSON.stringify({ code: 'environment_deleted', message: 'The environment was retired before this decision completed.' }), at, at, repository.id, repository.id, id),
    ], event: { type: 'workflow.environment.deleted', resource_id: id, resource_revision: revision + 1, repo_id: repository.id, account_id: repository.owner_id,
      actor_id: actor.id, data: { state: 'deleted' } }, audit: { action: 'workflow.environment.deleted', resource_id: id, resource_revision: revision + 1,
      repo_id: repository.id, account_id: repository.owner_id, actor_id: actor.id, details: { state: 'deleted', history_retained: true } } });
  });
}
