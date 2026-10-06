import { z } from 'zod';
import { ApiError, canonicalJson, execute, explainAuthorization, identityBinding, mutationGuard, mutationStatements,
  newId, now, one, registerResourceLocator, requestPolicies, resolveRepositoryPlacement, sha256, stmt } from '@gitknot/core';
import type { Principal, Repository } from '@gitknot/core';
import { principalSchema } from '../../secrets/src/schema.ts';
import { backgroundContext, operationsMaintenanceContext, principalById, rehydrateOperationPrincipal } from './authorization.ts';
import { backgroundCell, shardEnvironment } from './placement.ts';
import { privateJSON } from './private.ts';
import type { Operation, OperationsBindings } from './types.ts';

const place = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const requestSchema = z.object({ repo_id: z.string().regex(/^r_[A-Za-z0-9_-]{1,120}$/),
  target_cell_id: place, target_shard_id: place, expected_epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  operation_id: z.string().regex(/^op_[A-Za-z0-9_-]{1,120}$/).optional(),
  archive_id: z.string().min(1).max(128).optional(), principal: principalSchema.optional(),
}).strict();
type MoveRequest = z.infer<typeof requestSchema>;

async function requestActor(env: OperationsBindings, input: MoveRequest, recovering: boolean): Promise<Principal> {
  if (input.principal) return rehydrateOperationPrincipal(env, input.principal);
  if (recovering) throw new ApiError(403, 'recovery_credential_required', 'Archive recovery requires a current repository credential.');
  // The authenticated operations.maintenance service may change placement, but
  // cannot obtain an ordinary export or change repository ownership/audience.
  const actor = await principalById(env, 'system:operations');
  if (!actor || actor.kind !== 'service' || actor.user_id !== null) throw new Error('maintenance_principal_unavailable');
  return actor;
}

async function priorRequest(env: OperationsBindings, id: string, hash: string, actor: Principal, recovering: boolean): Promise<Operation | null> {
  const request = await one<{ request_sha256: string }>(env.DB.withSession('first-primary'), 'SELECT request_sha256 FROM repository_move_requests WHERE operation_id=?', id);
  if (!request) return null;
  if (request.request_sha256 !== hash) throw new ApiError(409, 'move_request_conflict', 'The operation ID already names a different placement request.');
  const operation = await one<Operation>(env.DB, 'SELECT * FROM operations WHERE id=?', id);
  if (!operation || operation.actor_id !== actor.id) throw new Error('move_request_receipt_missing');
  if (actor.credential_id) {
    const saved = JSON.parse(operation.input_json) as { principal: Principal };
    const original = await rehydrateOperationPrincipal(env, saved.principal);
    const permission = await explainAuthorization(backgroundContext(env, original), recovering ? 'repositories.restore' : 'repositories.manage', { repo_id: operation.repo_id! });
    const lifecycleOnly = permission.matched_grants.some(grant => grant.effect === 'allow')
      && permission.reasons.every(reason => ['repository_unavailable', 'repository_archived'].includes(reason.code));
    if (!permission.allowed && !lifecycleOnly) throw new ApiError(403, 'operation_not_authorized', 'The initiating repository authority is no longer current.');
  }
  return operation;
}

export async function submitShardMove(base: OperationsBindings, value: unknown, recovering: boolean): Promise<Response> {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'invalid_move_request', 'A repository, destination, and positive expected_epoch are required.');
  const input = parsed.data;
  if (recovering !== !!input.archive_id) throw new ApiError(400, 'archive_scope', 'Only a recovery request may name its verified archive.');
  const placement = await resolveRepositoryPlacement(base, input.repo_id);
  if (!placement) throw new ApiError(404, 'not_found', 'The repository was not found.');
  const actor = await requestActor(base, input, recovering);
  const hash = await sha256(canonicalJson({ repo_id: input.repo_id, target_cell_id: input.target_cell_id,
    target_shard_id: input.target_shard_id, expected_epoch: input.expected_epoch, archive_id: input.archive_id ?? null, actor_id: actor.id }));
  const id = input.operation_id ?? `op_move_${hash.slice(0, 48)}`;
  if (placement.cell_id !== base.CELL_ID) {
    const receipt = await privateJSON<{ id: string; status: Operation['status'] }>(base, backgroundCell(base, placement.cell_id), 'operations.maintenance',
      recovering ? '/internal/operations/restore' : '/internal/operations/move', { ...input, operation_id: id });
    if (receipt.id !== id) throw new Error('move_request_receipt_mismatch');
    return Response.json(receipt, { status: 202 });
  }
  const env = shardEnvironment(base, placement.shard_id);
  const previous = await priorRequest(env, id, hash, actor, recovering);
  if (previous) return Response.json({ id, status: previous.status }, { status: 202 });
  if (placement.epoch !== input.expected_epoch || placement.operation_id && placement.operation_id !== id) {
    throw new ApiError(409, 'move_epoch_conflict', 'The expected source epoch is no longer available for this operation.');
  }
  if (input.target_cell_id === env.CELL_ID) {
    if (input.target_shard_id === env.SHARD_ID) throw new ApiError(409, 'move_destination_conflict', 'The destination is already the current placement.');
    shardEnvironment(env, input.target_shard_id);
  } else backgroundCell(env, input.target_cell_id);
  const db = env.DB.withSession('first-primary');
  const repo = await one<Repository>(db, 'SELECT * FROM repositories WHERE id=? AND routing_epoch=?', input.repo_id, input.expected_epoch);
  if (!repo || !(recovering ? ['active', 'archived', 'deleted'] : ['active', 'archived']).includes(repo.state)) {
    throw new ApiError(409, 'move_repository_unavailable', 'The repository is not ready for a new placement request.');
  }
  const context = actor.credential_id ? backgroundContext(env, actor, repo) : await operationsMaintenanceContext(env, repo);
  if (actor.credential_id) await requestPolicies(context, [{ capability: recovering ? 'repositories.restore' : 'repositories.manage', scope: { repo_id: repo.id } }]);
  await registerResourceLocator(env, { resource_id: id, resource_type: 'operation', repo_id: repo.id, authority: 'repository' });
  const guard = newId('guard');
  const timestamp = now();
  const statements = await mutationStatements(context, { statements: [
    stmt(db, `UPDATE repositories SET state='moving',revision=revision+1,updated_at=? WHERE id=? AND routing_epoch=? AND revision=? AND state=?`,
      timestamp, repo.id, input.expected_epoch, repo.revision, repo.state), mutationGuard(db, guard),
    stmt(db, `INSERT INTO repository_move_requests(operation_id,repo_id,expected_epoch,request_sha256,source_cell_id,source_shard_id,target_cell_id,target_shard_id,source_state,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`, id, repo.id, input.expected_epoch, hash, env.CELL_ID, env.SHARD_ID, input.target_cell_id, input.target_shard_id, repo.state, timestamp),
    stmt(db, `INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,input_json,created_at,updated_at)
      VALUES(?,'repository.move',?,?,?,?,?,?,?)`, id, repo.id, repo.id, repo.owner_id, actor.id,
    canonicalJson({ ...(input.principal ? { principal: input.principal } : { maintenance: true }), target_cell_id: input.target_cell_id,
      target_shard_id: input.target_shard_id, expected_epoch: input.expected_epoch, source_state: repo.state, ...(input.archive_id ? { archive_id: input.archive_id } : {}) }), timestamp, timestamp),
    ...(!input.principal ? [stmt(db, `INSERT INTO operations_maintenance_intents(operation_id,repo_id,account_id,purpose,authority_id,routing_epoch,repository_revision,created_at)
      VALUES(?,?,?,'repository.move','svc_operations_maintenance',?,?,?)`, id, repo.id, repo.owner_id, repo.routing_epoch, repo.revision, timestamp)] : []),
    stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard),
  ], event: { type: 'operation.requested', resource_id: id, resource_revision: 1, repo_id: repo.id, account_id: repo.owner_id, actor_id: actor.id,
    data: { kind: 'repository.move', expected_epoch: input.expected_epoch, target_cell_id: input.target_cell_id, target_shard_id: input.target_shard_id } } });
  const directory = (env.DIRECTORY_DB ?? identityBinding(env)).withSession('first-primary');
  await execute(directory, `INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,epoch,state,updated_at)
    VALUES(?,'repository',?,?,?,'active',?) ON CONFLICT(resource_id) DO NOTHING`, repo.id, env.CELL_ID, env.SHARD_ID, repo.routing_epoch, timestamp);
  const claim = await execute(directory, `UPDATE resource_routes SET state='moving',operation_id=?,destination_cell_id=?,destination_shard_id=?,updated_at=?
    WHERE resource_id=? AND cell_id=? AND shard_id=? AND epoch=? AND (operation_id IS NULL OR operation_id=?)`,
    id, input.target_cell_id, input.target_shard_id, timestamp, repo.id, env.CELL_ID, env.SHARD_ID, input.expected_epoch, id);
  if (claim.meta.changes !== 1) throw new ApiError(409, 'move_epoch_conflict', 'The expected source epoch was claimed by another operation.');
  try { await db.batch(statements); }
  catch (error) {
    const recovered = await priorRequest(env, id, hash, actor, recovering);
    if (recovered) return Response.json({ id, status: recovered.status }, { status: 202 });
    await execute(directory, `UPDATE resource_routes SET state=?,operation_id=NULL,destination_cell_id=NULL,destination_shard_id=NULL,updated_at=?
      WHERE resource_id=? AND epoch=? AND operation_id=? AND state='moving'`, repo.state === 'deleted' ? 'deleted' : 'active', now(), repo.id, input.expected_epoch, id);
    throw error;
  }
  return Response.json({ id, status: 'pending' }, { status: 202 });
}
