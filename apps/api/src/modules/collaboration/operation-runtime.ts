import { Context } from 'hono';
import {
  ApiError, auditStatement, credentialIsCurrent, database, eventStatement, identityDatabase, makeEvent, many, mutationGuard,
  newId, now, one, requestDatabaseAuthority, requestDatabaseBinding, requirePrincipal, setRequestDatabase, sha256, stmt,
} from '@gitknot/core';
import type { AppContext, AppEnv, Bindings, CredentialRecord, EventRecord, Principal, Repository } from '@gitknot/core';
import { commit } from './common.ts';
import type { Item } from './common.ts';
import type { CollaborationOperation } from './operation-model.ts';
import type { NativeOperation } from './native.ts';
import { nativeOperationSchema, nativeJSON, runNativeMutation } from './native.ts';
import type { GitMutation } from '@gitknot/git';
import { isMaintenanceRace, maintenanceContext } from './maintenance.ts';

export interface OperationContext {
  operation_id: string; repo_id: string | null; item_id: string | null; principal_json: string;
  expected_item_revision: number | null; input_digest: string; checkpoint_json: string;
}
export interface OperationState {
  c: AppContext; internal: AppContext; operation: CollaborationOperation; context: OperationContext;
  input: Record<string, unknown>; checkpoint: Record<string, unknown>;
  accepted_writes?: Array<{ operation_id: string; head_oid: string; pull_id: string }>;
}
export interface OperationStep {
  status: 'waiting' | 'completed' | 'failed' | 'cancelled';
  phase: string; progress?: number; checkpoint?: Record<string, unknown>;
  result?: Record<string, unknown>; error?: { code: string; message: string; retryable: boolean };
  effects?: D1PreparedStatement[];
}

export function backgroundContext(env: Bindings, principal: Principal): AppContext {
  const c = new Context<AppEnv>(new Request('https://internal.gitknot.com/collaboration/operation'), { env });
  c.set('principal', principal);
  c.set('database', env.DB.withSession('first-primary'));
  c.set('requestId', newId('collaboration'));
  return c;
}

export async function rehydratePrincipal(c: AppContext, snapshot: Principal): Promise<Principal> {
  if (!snapshot || !snapshot.id || !snapshot.credential_id) throw new ApiError(401, 'operation_credential_required', 'The operation requires its initiating credential.');
  const identity = identityDatabase(c);
  const credential = await one<CredentialRecord>(identity, 'SELECT * FROM credentials WHERE id=? AND principal_id=?', snapshot.credential_id, snapshot.id);
  if (!credential || !await credentialIsCurrent(identity, credential)) throw new ApiError(403, 'operation_access_revoked', 'The initiating credential expired or was revoked.');
  const current = await one<Pick<Principal, 'id' | 'kind' | 'user_id'>>(identity, 'SELECT id,kind,user_id FROM principals WHERE id=? AND disabled_at IS NULL', snapshot.id);
  if (!current || current.kind !== snapshot.kind || current.user_id !== snapshot.user_id) throw new ApiError(403, 'operation_access_revoked', 'The initiating principal is no longer active.');
  // authorize() intersects these original ceilings with the current credential and every ancestor.
  return { ...snapshot, ...current, mfa: snapshot.mfa && credential.mfa === 1 };
}

export async function loadOperation(env: Bindings, id: string): Promise<OperationState | null> {
  const db = env.DB.withSession('first-primary');
  let operation = await one<CollaborationOperation & { lease_expires_at: string | null }>(db, 'SELECT * FROM operations WHERE id=? AND kind LIKE ?', id, 'collaboration.%');
  if (!operation || operation.status === 'completed' || (operation.lease_expires_at && operation.lease_expires_at > now())) return null;
  const internal = await maintenanceContext(env, operation.repo_id);
  operation = await one<CollaborationOperation & { lease_expires_at: string | null }>(database(internal), 'SELECT * FROM operations WHERE id=? AND kind LIKE ?', id, 'collaboration.%');
  if (!operation || operation.status === 'completed' || (operation.lease_expires_at && operation.lease_expires_at > now())) return null;
  const accepted = await one(database(internal), `SELECT 1 FROM git_publications WHERE actor_id=? AND substr(id,1,length(?)+1)=?||'_'
    AND state IN ('publishing','uncertain','committed') LIMIT 1`, operation.actor_id, id, id);
  if (['failed', 'cancelled'].includes(operation.status) && !accepted) return null;
  const context = await one<OperationContext>(database(internal), 'SELECT * FROM collaboration_operation_contexts WHERE operation_id=?', id);
  if (!context || await sha256(operation.input_json) !== context.input_digest) throw new ApiError(503, 'operation_context_invalid', 'The durable operation input failed integrity verification.');
  const principal = JSON.parse(context.principal_json) as Principal;
  if (principal.id !== operation.actor_id) throw new ApiError(503, 'operation_actor_mismatch', 'The durable operation actor failed integrity verification.');
  const c = backgroundContext(env, principal);
  setRequestDatabase(c, requestDatabaseBinding(internal), requestDatabaseAuthority(internal));
  const routing = internal.get('routing');
  if (routing) c.set('routing', routing);
  const observed = operation;
  const lease = new Date(Date.now() + 4 * 60_000).toISOString();
  try {
    await commit(internal, { repo_id: operation.repo_id, account_id: operation.account_id,
      resource_id: operation.id, revision: operation.revision + 1, type: 'collaboration.operation_resumed',
      sql: `UPDATE operations SET status='running',lease_expires_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?
        AND status IN ('pending','waiting','running'${accepted ? ",'failed','cancelled'" : ''}) AND (lease_expires_at IS NULL OR lease_expires_at<=?)`,
      bindings: [lease, now(), operation.id, operation.revision, now()], data: { kind: operation.kind, phase: operation.phase } });
  } catch (error) {
    if (await isMaintenanceRace(env, error, async () => !!await one(database(internal),
      'SELECT 1 FROM operations WHERE id=? AND revision=?', observed.id, observed.revision))) return null;
    throw error;
  }
  return { c, internal, operation: { ...operation, status: 'running', revision: operation.revision + 1 }, context,
    input: JSON.parse(operation.input_json) as Record<string, unknown>, checkpoint: JSON.parse(context.checkpoint_json) as Record<string, unknown> };
}

export async function saveStep(state: OperationState, step: OperationStep): Promise<void> {
  const { internal: c, operation } = state;
  const at = now();
  const terminal = ['completed', 'failed', 'cancelled'].includes(step.status);
  const checkpoint = { ...state.checkpoint, ...step.checkpoint };
  await commit(c, { repo_id: operation.repo_id, account_id: operation.account_id, resource_id: operation.id, revision: operation.revision + 1,
    type: step.status === 'completed' ? 'operation.completed' : step.status === 'failed' ? 'operation.failed' : 'collaboration.operation_progress',
    sql: `UPDATE operations SET status=?,phase=?,progress=?,result_json=?,error_json=?,lease_expires_at=NULL,
      revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND revision=? AND status='running'`,
    bindings: [step.status, step.phase, step.status === 'completed' ? 100 : step.progress ?? operation.progress,
      step.result ? JSON.stringify(step.result) : operation.result_json, step.error ? JSON.stringify(step.error) : null,
      at, terminal ? at : null, operation.id, operation.revision], after: [
      ...(step.effects ?? []), stmt(database(c), 'UPDATE collaboration_operation_contexts SET checkpoint_json=?,updated_at=? WHERE operation_id=?', JSON.stringify(checkpoint), at, operation.id),
    ], data: { kind: operation.kind, resource_id: operation.resource_id, phase: step.phase, ...(state.context.item_id ? { item_id: state.context.item_id } : {}) } });
}

export function checked(c: AppContext, statement: D1PreparedStatement): D1PreparedStatement[] {
  const guard = newId('guard');
  return [statement, mutationGuard(database(c), guard), stmt(database(c), 'DELETE FROM mutation_guards WHERE id=?', guard)];
}

export function domainStatements(c: AppContext, repo: Repository, item: Item, type: string, revision: number, data: Record<string, unknown>, resourceId = item.id): D1PreparedStatement[] {
  const actor = requirePrincipal(c);
  const event: EventRecord = makeEvent({ type, resource_id: resourceId, resource_revision: revision, repo_id: repo.id,
    account_id: repo.owner_id, actor_id: actor.id, data: { item_id: item.id, kind: item.kind, ...data } });
  return [eventStatement(database(c), event), auditStatement(database(c), { action: type, resource_id: resourceId,
    resource_revision: revision, repo_id: repo.id, account_id: repo.owner_id, actor_id: actor.id,
    credential_id: actor.credential_id, request_id: c.get('requestId'), details: event.data }),
  stmt(database(c), `INSERT INTO collaboration_history(id,repo_id,item_id,resource_id,resource_revision,event_type,actor_id,data_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, event.id, repo.id, item.id, resourceId, revision, type, actor.id, JSON.stringify(event.data), event.occurred_at),
  stmt(database(c), `INSERT INTO collaboration_activity(id,repo_id,item_id,event_type,actor_id,actor_kind,resource_id,resource_revision,group_key,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, event.id, repo.id, item.id, type, actor.id, actor.kind, resourceId, revision,
  `${repo.id}:${item.id}:${actor.id}:${event.occurred_at.slice(0, 10)}`, event.occurred_at),
  stmt(database(c), `INSERT INTO collaboration_search_watermarks(repo_id,revision,updated_at) VALUES (?,1,?)
    ON CONFLICT(repo_id) DO UPDATE SET revision=revision+1,updated_at=excluded.updated_at`, repo.id, event.occurred_at)];
}

/** Reads a committed journal before retrying. The native operation ID is stable across crashes. */
export async function nativeMutation(state: OperationState, repoId: string, nativeId: string, mutation: GitMutation | { kind: 'fork'; source_repo_id: string }): Promise<NativeOperation> {
  const existing = await one<{ state: string }>(database(state.c), 'SELECT state FROM git_publications WHERE repo_id=? AND id=?', repoId, nativeId);
  if (existing) return nativeJSON(state.c, repoId, `operations/${nativeId}`, nativeOperationSchema);
  if (mutation.kind === 'fork') return nativeJSON(state.c, repoId, 'mutate', nativeOperationSchema,
    { operation_id: nativeId, actor: requirePrincipal(state.c), mutation });
  return runNativeMutation(state.c, repoId, nativeId, mutation);
}

export function committedPublication(value: NativeOperation, operationId: string): boolean {
  return value.state === 'committed' && value.finalized === true && value.result?.outcome === 'committed'
    && value.result.operation_id === operationId && !!value.result.marker_oid;
}

/** Receipt inspection is internal bookkeeping, not authority to run another Git mutation. */
export async function acceptedWriteReceipts(state: OperationState): Promise<NonNullable<OperationState['accepted_writes']>> {
  if (!['collaboration.suggestion', 'collaboration.restack'].includes(state.operation.kind)) return [];
  const rows = await many<{ id: string; repo_id: string }>(database(state.internal), `SELECT id,repo_id FROM git_publications
    WHERE actor_id=? AND substr(id,1,length(?)+1)=?||'_' AND state IN ('publishing','uncertain','committed')`,
  state.operation.actor_id, state.operation.id, state.operation.id);
  const receipts: NonNullable<OperationState['accepted_writes']> = [];
  for (const row of rows) {
    let expected: { head_ref: string; head_oid: string; pull_id: string; head_repo_id: string } | undefined;
    if (state.operation.kind === 'collaboration.suggestion' && row.id === `${state.operation.id}_apply`) {
      expected = { head_ref: requiredString(state.input, 'head_ref'), head_oid: requiredString(state.input, 'head_oid'),
        pull_id: requiredString(state.input, 'pull_id'), head_repo_id: requiredString(state.input, 'head_repo_id') };
    } else if (row.id.startsWith(`${state.operation.id}_restack_`)) {
      const index = Number(row.id.slice(`${state.operation.id}_restack_`.length));
      if (Number.isInteger(index) && index >= 0 && Array.isArray(state.input.snapshots)) expected = state.input.snapshots[index] as typeof expected;
    }
    if (!expected || row.repo_id !== expected.head_repo_id) continue;
    const native = await nativeJSON(state.internal, row.repo_id, `operations/${row.id}`, nativeOperationSchema);
    if (!committedPublication(native, row.id)) continue;
    const update = native.result!.refs[0];
    if (native.result!.refs.length !== 1 || !update || update.ref !== expected.head_ref || update.old_oid !== expected.head_oid) {
      throw new ApiError(503, 'publication_result_mismatch', 'The accepted source publication does not match its durable intent.');
    }
    receipts.push({ operation_id: row.id, head_oid: update.new_oid, pull_id: expected.pull_id });
  }
  return receipts;
}

export function nativeWaiting(state: OperationState, phase: string, extra: Record<string, unknown> = {}): OperationStep {
  return { status: 'waiting', phase, checkpoint: { failures: 0, ...extra }, progress: state.operation.progress };
}

export function requiredString(value: Record<string, unknown>, key: string): string {
  if (typeof value[key] !== 'string' || !value[key]) throw new ApiError(503, 'operation_input_invalid', 'The durable operation input is incomplete.');
  return value[key];
}
