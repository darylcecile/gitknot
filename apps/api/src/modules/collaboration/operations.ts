import { z } from 'zod';
import {
  ApiError, authorize, database, diagnostic, jsonBody, many, now, one, requirePrincipal, resolveResourceLocator, route, routeRepositoryRequest, sha256, stmt,
} from '@gitknot/core';
import type { App, Bindings, Principal, Repository } from '@gitknot/core';
import { checkRevision, commit, getItem, notFound, respond } from './common.ts';
import type { Item } from './common.ts';
import { prepareOperation, publicOperation } from './operation-model.ts';
import type { CollaborationOperation } from './operation-model.ts';
import { stepSuggestion, stepRestack } from './change-operations.ts';
import { reconcileMergedPublication, stepMerge } from './merge-operations.ts';
import { stepRetireWorkspace, stepWorkspace } from './workspace-operations.ts';
import {
  acceptedWriteReceipts, backgroundContext, checked, domainStatements, loadOperation, rehydratePrincipal, saveStep,
} from './operation-runtime.ts';
import type { OperationState, OperationStep, OperationContext } from './operation-runtime.ts';
import type { TaskClaim, Workspace } from './tasks.ts';
import { pullDetails, readPatchFiles } from './patches.ts';
import { sweepAttachmentStorage } from './attachment-storage.ts';
import { isMaintenanceRace, maintenanceContext, retentionPrincipal } from './maintenance.ts';
import { mergeAuthorizations } from './merge.ts';

export async function runCollaborationOperation(env: Bindings, id: string): Promise<void> {
  const state = await loadOperation(env, id);
  if (!state) return;
  try {
    const reconciled = await reconcileMergedPublication(state);
    if (reconciled) { await saveStep(state, reconciled); return; }
    state.accepted_writes = await acceptedWriteReceipts(state);
    const automaticRetention = state.operation.kind === 'collaboration.workspace_retire' && state.input.automatic === true
      && state.operation.actor_id === retentionPrincipal.id;
    if (!automaticRetention) state.c.set('principal', await rehydratePrincipal(state.c, requirePrincipal(state.c)));
    const handlers: Record<string, (value: OperationState) => Promise<OperationStep>> = {
      'collaboration.merge': stepMerge, 'collaboration.suggestion': stepSuggestion,
      'collaboration.restack': stepRestack, 'collaboration.workspace': stepWorkspace,
      'collaboration.workspace_retire': stepRetireWorkspace,
    };
    const handler = handlers[state.operation.kind];
    if (!handler) throw new ApiError(422, 'unsupported_collaboration_operation', 'This collaboration operation kind is not supported by this dispatcher.');
    await saveStep(state, await handler(state));
  } catch (error) {
    console.error(JSON.stringify({ event: 'collaboration.operation_step_failed', operation_id: id, diagnostic: diagnostic(error) }));
    const current = await one<CollaborationOperation>(database(state.internal), 'SELECT * FROM operations WHERE id=?', id);
    if (!current || current.status === 'cancelled' || current.status === 'completed' || current.revision !== state.operation.revision) return;
    const accepted = await one<{ state: string }>(database(state.internal), `SELECT state FROM git_publications WHERE actor_id=?
      AND substr(id,1,length(?)+1)=?||'_' AND state IN ('publishing','uncertain','committed') LIMIT 1`, current.actor_id, id, id);
    const failures = Number(state.checkpoint.failures ?? 0) + 1;
    const denied = error instanceof ApiError && [401, 403].includes(error.status);
    const retryable = !(error instanceof ApiError && error.status >= 400 && error.status < 500 && ![412, 429].includes(error.status));
    const waiting = denied || !!accepted || (retryable && failures < 10);
    const effects: D1PreparedStatement[] = [];
    if (!waiting && state.operation.kind === 'collaboration.suggestion') {
      effects.push(stmt(database(state.c), `UPDATE pull_suggestions SET state='failed',revision=revision+1,updated_at=?
        WHERE operation_id=? AND state='applying'`, now(), id));
    }
    await saveStep(state, { status: waiting ? 'waiting' : 'failed', phase: denied && state.accepted_writes?.length ? 'publication_committed_authorization_required'
      : denied ? 'authorization_required' : accepted ? 'reconciling_native_outcome' : waiting ? 'retrying_step' : 'failed',
      checkpoint: { failures }, effects,
      ...(state.accepted_writes?.length ? { result: { ...(state.operation.result_json ? JSON.parse(state.operation.result_json) as Record<string, unknown> : {}),
        accepted_native_writes: state.accepted_writes, canonical_publication_verified: true, metadata_refresh_pending: true } } : {}),
      error: { code: error instanceof ApiError ? error.code : 'collaboration_step_unconfirmed',
        message: denied ? 'The initiating credential is no longer current. Reauthorize this operation to continue.'
          : accepted ? 'Native work was accepted. Its outcome and metadata are being reconciled.'
            : 'This step could not be completed. Its durable inputs and completed steps are retained.', retryable: waiting || retryable } });
  }
}

/** Bounded sweeps record expiry as real state changes; object deletion remains in the shared manifest reaper. */
export async function sweepCollaboration(env: Bindings): Promise<void> {
  const enumeration = await maintenanceContext(env);
  const db = database(enumeration);
  const claims = await many<TaskClaim>(db, "SELECT * FROM task_claims WHERE state='active' AND expires_at<=? ORDER BY expires_at,id LIMIT 50", now());
  for (const claim of claims) {
    const c = await maintenanceContext(env, claim.repo_id);
    const local = database(c);
    const repo = await one<Repository>(local, 'SELECT * FROM repositories WHERE id=?', claim.repo_id);
    const item = await one<Item>(local, 'SELECT * FROM collaboration_items WHERE repo_id=? AND id=?', claim.repo_id, claim.task_id);
    if (!repo || !item) continue;
    try {
      await commit(c, { resource_id: claim.id, revision: claim.revision + 1, type: 'task.claim_expired',
        sql: "UPDATE task_claims SET state='expired',revision=revision+1,updated_at=? WHERE repo_id=? AND id=? AND revision=? AND state='active' AND expires_at<=?",
        bindings: [now(), claim.repo_id, claim.id, claim.revision, now()],
        after: domainStatements(c, repo, item, 'task.claim_lease_expired', claim.revision + 1, { claim_id: claim.id }, claim.id) });
    } catch (error) {
      if (!await isMaintenanceRace(env, error, async () => !!await one(database(c),
        "SELECT 1 FROM task_claims WHERE repo_id=? AND id=? AND revision=? AND state='active' AND expires_at<=?", claim.repo_id, claim.id, claim.revision, now()))) throw error;
    }
  }
  await sweepAttachmentStorage(env);
  const workspaces = await many<Workspace>(db, "SELECT * FROM task_workspaces WHERE state='active' AND retention_until<=? ORDER BY retention_until,id LIMIT 25", now());
  for (const workspace of workspaces) {
    const c = await maintenanceContext(env, workspace.repo_id);
    const repo = await one<Repository>(database(c), 'SELECT * FROM repositories WHERE id=?', workspace.repo_id);
    if (!repo) continue;
    const prepared = await prepareOperation(backgroundContext(env, retentionPrincipal), { repo, kind: 'workspace_retire', resource_id: workspace.id, item_id: workspace.task_id,
      input: { automatic: true, workspace_id: workspace.id, workspace_repo_id: workspace.workspace_repo_id } });
    try {
      await commit(c, { resource_id: workspace.id, revision: workspace.revision + 1, type: 'task.workspace_expired',
        sql: `UPDATE task_workspaces SET state='expiring',operation_id=?,revision=revision+1,updated_at=?
          WHERE repo_id=? AND id=? AND revision=? AND state='active' AND retention_until<=?`,
        bindings: [prepared.operation.id, now(), workspace.repo_id, workspace.id, workspace.revision, now()], after: prepared.statements,
        data: { workspace_id: workspace.id, operation_id: prepared.operation.id } });
    } catch (error) {
      if (!await isMaintenanceRace(env, error, async () => !!await one(database(c),
        "SELECT 1 FROM task_workspaces WHERE repo_id=? AND id=? AND revision=? AND state='active' AND retention_until<=?", workspace.repo_id, workspace.id, workspace.revision, now()))) throw error;
    }
  }
}

export function registerCollaborationOperationRoutes(app: App): void {
  app.use('/v1/collaboration/operations/:id/*', async (c, next) => {
    const locator = await resolveResourceLocator(c.env, c.req.param('id') ?? '', 'operation');
    if (!locator) notFound();
    if (locator.repo_id) {
      const forwarded = await routeRepositoryRequest(c, locator.repo_id);
      if (forwarded) return forwarded;
    }
    return next();
  });
  route(app, 'POST', '/v1/collaboration/operations/:id/resume', {
    summary: 'Reauthorize a durable collaboration operation after credential renewal', tags: ['collaboration'], body: z.strictObject({}),
  }, async c => {
    await jsonBody(c, z.strictObject({}));
    const principal = requirePrincipal(c);
    const operation = await one<CollaborationOperation & { lease_expires_at: string | null }>(database(c), "SELECT * FROM operations WHERE id=? AND actor_id=? AND kind LIKE 'collaboration.%'", c.req.param('id'), principal.id);
    const context = operation ? await one<OperationContext>(database(c), 'SELECT * FROM collaboration_operation_contexts WHERE operation_id=?', operation.id) : null;
    if (!operation || !context) notFound();
    checkRevision(c, operation);
    if (!['pending', 'waiting', 'failed'].includes(operation.status) || (operation.lease_expires_at && operation.lease_expires_at > now())) {
      throw new ApiError(409, 'operation_not_resumable', 'Only an unleased pending, waiting or failed operation can be reauthorized.');
    }
    if (await sha256(operation.input_json) !== context.input_digest) throw new ApiError(503, 'operation_context_invalid', 'The immutable operation input could not be verified.');
    const input = JSON.parse(operation.input_json) as Record<string, unknown>;
    if (context.item_id && operation.repo_id) {
      const { item } = await getItem(c, undefined, context.item_id, operation.kind.includes('workspace') ? 'tasks.manage'
        : operation.kind === 'collaboration.merge' ? 'contents.read' : 'pull_requests.write', operation.repo_id);
      if (item.kind === 'pull_request') {
        if (operation.kind === 'collaboration.merge') {
          for (const requirement of await mergeAuthorizations(c, item.id, item.repo_id)) await authorize(c, requirement.capability, requirement.scope);
        } else {
          const pull = await pullDetails(c, item);
          await authorize(c, 'contents.push', { repo_id: pull.head_repo_id, ref: pull.head_ref,
            paths: (await readPatchFiles(c, item, pull.current_patch_id)).map(file => file.path) });
        }
      }
    }
    if (operation.kind === 'collaboration.code_scan') {
      const repositories = await many<{ repo_id: string }>(database(c), 'SELECT repo_id FROM collaboration_code_scan_repositories WHERE scan_id=?', input.scan_id);
      for (const repo of repositories) await authorize(c, 'search.scan', { repo_id: repo.repo_id });
    }
    const at = now();
    await commit(c, { repo_id: operation.repo_id, account_id: operation.account_id, resource_id: operation.id, revision: operation.revision + 1, type: 'collaboration.operation_reauthorized',
      sql: "UPDATE operations SET status='pending',error_json=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=? WHERE id=? AND actor_id=? AND revision=? AND status IN ('pending','waiting','failed') AND (lease_expires_at IS NULL OR lease_expires_at<=?)",
      bindings: [at, operation.id, principal.id, operation.revision, at], after: [
        stmt(database(c), "UPDATE collaboration_operation_contexts SET principal_json=?,checkpoint_json=json_set(checkpoint_json,'$.failures',0),updated_at=? WHERE operation_id=?",
          JSON.stringify(principal), at, operation.id),
        stmt(database(c), "UPDATE pull_suggestions SET state='applying',revision=revision+1,updated_at=? WHERE operation_id=? AND state='failed'", at, operation.id),
      ] });
    return respond(c, publicOperation({ ...operation, status: 'pending', revision: operation.revision + 1, updated_at: at }), 202);
  });
}
