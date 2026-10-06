import { z } from 'zod';
import { ApiError, authorize, auditStatement, database, eventStatement, getRepository, makeEvent, newId, now, one, requirePrincipal, stmt } from '@gitknot/core';
import type { Repository } from '@gitknot/core';
import { getItem } from './common.ts';
import type { Item } from './common.ts';
import { nativeJSON, resolveNativeCommit } from './native.ts';
import { checked, committedPublication, domainStatements, nativeMutation, nativeWaiting, requiredString } from './operation-runtime.ts';
import type { OperationState, OperationStep } from './operation-runtime.ts';
import type { CollaborationOperation } from './operation-model.ts';
import type { Workspace } from './tasks.ts';

async function workspace(state: OperationState): Promise<Workspace> {
  const value = await one<Workspace>(database(state.c), 'SELECT * FROM task_workspaces WHERE repo_id=? AND id=?', state.operation.repo_id, requiredString(state.input, 'workspace_id'));
  if (!value) throw new ApiError(404, 'workspace_unavailable', 'The task workspace is unavailable.');
  return value;
}

function lifecycleOperation(state: OperationState, repo: Repository, kind: 'fork' | 'archive' | 'delete', data: Record<string, unknown>, automatic = false): { id: string; effects: D1PreparedStatement[] } {
  const { c } = state;
  const id = newId('op');
  const at = now();
  const actor = requirePrincipal(c);
  const input = JSON.stringify({ ...data, principal: actor, parent_operation_id: state.operation.id,
    ...(automatic ? { maintenance: true, maintenance_kind: 'task_workspace_retention', workspace_id: state.input.workspace_id } : {}) });
  const event = makeEvent({ type: `repository.${kind}_requested`, resource_id: repo.id, resource_revision: repo.revision,
    repo_id: repo.id, account_id: repo.owner_id, actor_id: actor.id, data: { operation_id: id, kind, parent_operation_id: state.operation.id } });
  return { id, effects: [
    stmt(database(c), `INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,input_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      id, `repository.${kind}`, repo.id, repo.id, repo.owner_id, actor.id, input, at, at),
    stmt(database(c), `INSERT INTO repository_lifecycle(operation_id,repo_id,account_id,kind,state,previous_state,desired_state,input_json,expected_repository_revision,created_by,created_at,updated_at)
      VALUES (?,?,?,?,'queued',?,?,?,?,?,?,?)`, id, repo.id, repo.owner_id, kind, repo.state,
      kind === 'fork' ? 'active' : kind === 'archive' ? 'archived' : 'deleted', input, repo.revision, actor.id, at, at),
    eventStatement(database(c), event), auditStatement(database(c), { action: event.type, resource_id: repo.id,
      resource_revision: repo.revision, repo_id: repo.id, account_id: repo.owner_id, actor_id: actor.id, details: event.data }),
  ] };
}

export async function stepWorkspace(state: OperationState): Promise<OperationStep> {
  const { c, input, operation, checkpoint } = state;
  const value = await workspace(state);
  const { item, repo } = await getItem(c, 'task', value.task_id, 'tasks.manage', value.repo_id);
  const target = await one<Repository>(database(c), 'SELECT * FROM repositories WHERE id=?', value.workspace_repo_id);
  if (!target || target.visibility !== 'private' || target.fork_source_id !== repo.id) throw new ApiError(409, 'workspace_scope_changed', 'The private workspace source or visibility changed.');
  await authorize(c, 'repositories.create', { account_id: target.owner_id });
  if (value.state === 'active') return { status: 'completed', phase: 'workspace_ready', result: { workspace_id: value.id, workspace_repo_id: target.id, base_oid: value.base_oid } };
  if (!checkpoint.fork_operation_id) {
    const child = lifecycleOperation(state, target, 'fork', { source_repo_id: repo.id, base_oid: value.base_oid });
    return { status: 'waiting', phase: 'provisioning_private_fork', checkpoint: { fork_operation_id: child.id }, effects: child.effects, progress: 5 };
  }
  const fork = await one<CollaborationOperation>(database(c), 'SELECT * FROM operations WHERE id=? AND repo_id=?', checkpoint.fork_operation_id, target.id);
  if (!fork || fork.status === 'failed' || fork.status === 'cancelled') throw new ApiError(409, 'workspace_fork_failed', 'The workspace fork did not complete. Inspect its repository operation before retrying.');
  if (fork.status !== 'completed') return nativeWaiting(state, 'provisioning_private_fork');
  if (target.state !== 'active') throw new ApiError(503, 'workspace_fork_unconfirmed', 'The completed fork has not activated its repository.');
  const branch = 'refs/heads/work';
  await authorize(c, 'contents.push', { repo_id: target.id, ref: branch, paths: [] });
  if (!checkpoint.work_ref_old_oid) {
    let old: string;
    try { old = await resolveNativeCommit(c, target.id, branch); }
    catch (error) { if (error instanceof ApiError && error.code === 'ref_not_found') old = '0'.repeat(value.base_oid.length); else throw error; }
    return { status: 'waiting', phase: 'pinning_workspace_base', progress: 80, checkpoint: { work_ref_old_oid: old } };
  }
  const oldOid = requiredString(checkpoint, 'work_ref_old_oid');
  if (oldOid !== value.base_oid) {
    const nativeId = `${operation.id}_pin`;
    const native = await nativeMutation(state, target.id, nativeId, { kind: 'refs', updates: [{ ref: branch, old_oid: oldOid, new_oid: value.base_oid }] });
    if (native.state === 'rejected') throw new ApiError(409, 'workspace_base_rejected', 'Branch policy rejected the exact workspace base.');
    if (!committedPublication(native, nativeId)) return nativeWaiting(state, 'reconciling_workspace_base');
    if (!native.result?.refs.some(ref => ref.ref === branch && ref.old_oid === oldOid && ref.new_oid === value.base_oid)) throw new ApiError(503, 'workspace_base_mismatch', 'The published workspace base did not match its task.');
  }
  if (await resolveNativeCommit(c, target.id, branch) !== value.base_oid) throw new ApiError(409, 'workspace_base_changed', 'The workspace branch changed before initialization was finalized.');
  return { status: 'completed', phase: 'workspace_ready', result: { workspace_id: value.id, workspace_repo_id: target.id,
    base_oid: value.base_oid, branch, visibility: 'private', fork_operation_id: fork.id, canonical_publication_verified: true }, effects: [
    ...checked(c, stmt(database(c), "UPDATE task_workspaces SET state='active',last_active_at=?,revision=revision+1,updated_at=? WHERE repo_id=? AND id=? AND revision=? AND state='provisioning'",
      now(), now(), repo.id, value.id, value.revision)),
    ...domainStatements(c, repo, item, 'task.workspace_ready', value.revision + 1,
      { workspace_id: value.id, workspace_repo_id: target.id, base_oid: value.base_oid, operation_id: operation.id }, value.id),
  ] };
}

export async function stepRetireWorkspace(state: OperationState): Promise<OperationStep> {
  const { c, checkpoint } = state;
  const value = await workspace(state);
  const target = await one<Repository>(database(c), 'SELECT * FROM repositories WHERE id=?', value.workspace_repo_id);
  const item = await one<Item>(database(c), "SELECT * FROM collaboration_items WHERE repo_id=? AND id=? AND kind='task'", value.repo_id, value.task_id);
  const repo = await one<Repository>(database(c), 'SELECT * FROM repositories WHERE id=?', value.repo_id);
  if (!target || !item || !repo) throw new ApiError(404, 'workspace_unavailable', 'The workspace retention context is unavailable.');
  const automatic = state.input.automatic === true;
  if (automatic) {
    if (value.retention_until > now() || target.visibility !== 'private' || value.state !== 'expiring') {
      throw new ApiError(409, 'retention_precondition_changed', 'This private workspace is no longer due for retirement.');
    }
  } else {
    await getItem(c, 'task', item.id, 'tasks.manage', repo.id);
    await getRepository(c, target.id, 'repositories.read');
  }
  const retained = await one<{ count: number }>(database(c), 'SELECT COUNT(*) AS count FROM pull_patches WHERE head_repo_id=?', target.id);
  const kind = (retained?.count ?? 0) > 0 ? 'archive' : 'delete';
  if (!checkpoint.retirement_operation_id) {
    if (!automatic) await authorize(c, `repositories.${kind}`, { repo_id: target.id });
    const child = lifecycleOperation(state, target, kind, { reason: 'Task workspace retention expired.', retain_review_commits: kind === 'archive' }, automatic);
    return { status: 'waiting', phase: kind === 'archive' ? 'archiving_retained_workspace' : 'deleting_abandoned_workspace',
      checkpoint: { retirement_operation_id: child.id, retirement_kind: kind }, effects: child.effects, progress: 15 };
  }
  const child = await one<CollaborationOperation>(database(c), 'SELECT * FROM operations WHERE id=? AND repo_id=?', checkpoint.retirement_operation_id, target.id);
  if (!child || child.status === 'failed' || child.status === 'cancelled') throw new ApiError(409, 'workspace_retirement_failed', 'The repository retention operation needs attention. Its current state and references are retained.');
  if (child.status !== 'completed') return nativeWaiting(state, 'waiting_workspace_retirement');
  const expectedState = checkpoint.retirement_kind === 'archive' ? 'archived' : 'deleted';
  if (target.state !== expectedState) throw new ApiError(503, 'workspace_retirement_unconfirmed', 'The repository retirement result has not been confirmed.');
  return { status: 'completed', phase: expectedState === 'archived' ? 'retained_for_reviews' : 'retired',
    result: { workspace_id: value.id, workspace_repo_id: target.id, repository_state: target.state,
      retained_for_review_commits: expectedState === 'archived', retirement_operation_id: child.id }, effects: [
      ...checked(c, stmt(database(c), 'UPDATE task_workspaces SET state=?,revision=revision+1,updated_at=? WHERE repo_id=? AND id=? AND revision=?',
        expectedState === 'deleted' ? 'deleted' : 'expiring', now(), repo.id, value.id, value.revision)),
      ...domainStatements(c, repo, item, 'task.workspace_retired', value.revision + 1,
        { workspace_id: value.id, workspace_repo_id: target.id, retained_for_reviews: expectedState === 'archived' }, value.id),
    ] };
}
