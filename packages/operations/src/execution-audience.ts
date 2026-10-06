import { ApiError, authorize, canonicalJson, database, many, one, resolveRepositoryPlacement, sha256 } from '@gitknot/core';
import type { AppContext, Database, EventRecord, Principal, Repository, RequestAuthorization } from '@gitknot/core';
import { z } from 'zod';
import { authorizeExecutionAudience, executionAudience, executionNotFound, readRunPlan } from '../../execution/src/reads.ts';
import { workflowOperationAudience } from '../../execution/src/operations.ts';
import type { WorkflowOperation } from '../../execution/src/operations.ts';
import type { RunRecord } from '../../execution/src/types.ts';
import type { WorkflowPreviewRecord, WorkflowPreviewSnapshot } from '../../execution/src/preview-types.ts';
import { backgroundContext } from './authorization.ts';
import { sourceEvent } from './durable.ts';
import { backgroundCell, shardEnvironment } from './placement.ts';
import { privateJSON } from './private.ts';
import type { OperationsBindings } from './types.ts';

const requirementsSchema = z.array(z.object({ capability: z.string().min(1).max(100), scope: z.object({ repo_id: z.string().optional(), account_id: z.string().optional(),
  ref: z.string().optional(), paths: z.array(z.string()).optional() }).strict() }).strict()).max(32);
interface Audience { repositories: string[]; capability: string; requirements?: RequestAuthorization[] }
const runTables: Record<string, string> = { attempt: 'execution_attempts', checkout: 'execution_attempts', job: 'workflow_jobs', promotion: 'workflow_promotions',
  approval: 'workflow_promotions', release: 'workflow_releases', verification: 'workflow_verifications', object: 'execution_objects', remote: 'execution_attempts' };

async function previewAudience(row: WorkflowPreviewRecord): Promise<Audience> {
  if (await sha256(row.result_json) !== row.result_digest) executionNotFound();
  const snapshot = JSON.parse(row.result_json) as WorkflowPreviewSnapshot;
  const repositories = executionAudience({ repo_id: row.repo_id, source_repo_id: snapshot.source.repository_id,
    related_repo_ids: [...new Set([row.repo_id, snapshot.source.head_repository_id, ...snapshot.source.related_repository_ids])],
    trigger: { type: 'preview', id: row.id, ...(snapshot.source.pull_request_id ? { pull_request_id: snapshot.source.pull_request_id } : {}) },
    ...(snapshot.source.merge_candidate_id ? { checkout_candidate_id: snapshot.source.merge_candidate_id } : {}) });
  return { repositories, capability: 'workflows.run', requirements: requirementsSchema.parse(JSON.parse(row.requirements_json)) };
}

async function forRun(db: Database, repoId: string, runId: string): Promise<Audience> {
  const run = await one<RunRecord>(db, 'SELECT * FROM workflow_runs WHERE id=? AND repo_id=?', runId, repoId);
  if (run) return { repositories: executionAudience(await readRunPlan(run)), capability: 'runs.read' };
  const planning = await one<WorkflowOperation>(db, "SELECT * FROM workflow_run_requests WHERE run_id=? AND repo_id=? AND kind IN ('run','rerun')", runId, repoId);
  if (!planning) executionNotFound();
  return { repositories: await workflowOperationAudience(db, planning), capability: 'runs.read' };
}

/** Payload IDs are consistency checks only. The committed resource selects its immutable producer record. */
async function eventAudience(db: Database, event: EventRecord): Promise<Audience | null> {
  if (!event.repo_id) return null;
  const repoId = event.repo_id;
  if (event.type === 'workflow.plan.previewed' || event.type === 'workflow.definition.validated') {
    const preview = await one<WorkflowPreviewRecord>(db, 'SELECT * FROM workflow_plan_previews WHERE id=? AND repo_id=?', event.resource_id, repoId);
    if (!preview || event.data.preview_id !== undefined && event.data.preview_id !== preview.id) executionNotFound();
    return previewAudience(preview);
  }
  if (event.type.startsWith('workflow.operation.')) {
    const operation = await one<WorkflowOperation>(db, 'SELECT * FROM workflow_run_requests WHERE id=? AND repo_id=?', event.resource_id, repoId);
    if (!operation || event.data.run_id !== undefined && event.data.run_id !== operation.run_id) executionNotFound();
    return { repositories: await workflowOperationAudience(db, operation), capability: 'runs.read' };
  }
  if (/^(?:workflow\.run\.|run\.|workflow\.reproduction\.)/.test(event.type)) {
    if (event.data.run_id !== undefined && event.data.run_id !== event.resource_id) executionNotFound();
    return forRun(db, repoId, event.resource_id);
  }
  const family = /^(?:workflow|execution)\.([a-z_]+)\./.exec(event.type)?.[1], table = family ? runTables[family] : undefined;
  if (table) {
    const owner = await one<{ run_id: string }>(db, `SELECT run_id FROM ${table} WHERE id=? AND repo_id=?`, event.resource_id, repoId);
    if (!owner || event.data.run_id !== undefined && event.data.run_id !== owner.run_id) executionNotFound();
    return forRun(db, repoId, owner.run_id);
  }
  if (event.data.run_id !== undefined) executionNotFound();
  if (/^workflow\.(?:trigger|failure)/.test(event.type)) {
    const failures = await many<{ event_id: string; audience_json: string | null }>(db, `SELECT event_id,audience_json FROM workflow_trigger_failures WHERE repo_id=?
      AND (event_id||':'||workflow_id||':'||commit_sha=? OR event_id=?)`, repoId, event.resource_id, event.resource_id);
    if (!failures.length) executionNotFound();
    const repositories = new Set<string>();
    for (const failure of failures) {
      const retained = failure.audience_json ? JSON.parse(failure.audience_json) : null;
      if (!Array.isArray(retained)) executionNotFound();
      for (const source of executionAudience({ repo_id: repoId, related_repo_ids: retained, trigger: { id: failure.event_id, type: 'failure' } })) repositories.add(source);
    }
    return { repositories: [...repositories], capability: 'workflows.read' };
  }
  if (/^workflow\.(?:definition|policy)\./.test(event.type)) return { repositories: [repoId], capability: 'workflows.read' };
  if (event.type.startsWith('workflow.environment.')) return { repositories: [repoId], capability: 'environments.read' };
  if (/^(?:workflow|run|execution)\./.test(event.type)) executionNotFound();
  return null;
}

export async function executionEventRequirements(env: OperationsBindings, principal: Principal, event: EventRecord): Promise<RequestAuthorization[] | null> {
  if (!event.repo_id || !/^(?:workflow|run|execution)\./.test(event.type) && event.data.run_id === undefined) return [];
  const placement = await resolveRepositoryPlacement(env, event.repo_id);
  if (!placement) throw new ApiError(503, 'event_audience_unavailable', 'The current execution audience is unavailable.');
  if (placement.cell_id !== env.CELL_ID) return privateJSON(env, backgroundCell(env, placement.cell_id), 'operations.events', '/internal/events/audience',
    { repo_id: event.repo_id, event_id: event.id, principal });
  const local = shardEnvironment(env, placement.shard_id);
  const source = await sourceEvent(local.DB, event.id);
  if (!source || source.repo_id !== event.repo_id || canonicalJson(source) !== canonicalJson(event)) throw new ApiError(503, 'event_source_unconfirmed', 'The committed execution event could not be confirmed.');
  try {
    const audience = await eventAudience(local.DB, source);
    if (!audience) return [];
    const repository = await one<Repository>(local.DB, 'SELECT * FROM repositories WHERE id=?', source.repo_id);
    if (!repository) executionNotFound();
    const context = backgroundContext(local, principal, repository);
    await authorizeExecutionAudience(context, source.repo_id!, audience.repositories, audience.capability);
    for (const requirement of audience.requirements ?? []) await authorize(context, requirement.capability, requirement.scope);
    return [{ capability: audience.capability, scope: { repo_id: source.repo_id! } },
      ...audience.repositories.filter(repoId => repoId !== source.repo_id).map(repoId => ({ capability: 'contents.read', scope: { repo_id: repoId } })),
      ...audience.requirements ?? []];
  } catch (error) {
    if (error instanceof ApiError && [401, 403, 404, 410].includes(error.status)) return null;
    throw error;
  }
}

export async function executionEventVisible(c: AppContext, eventId: string): Promise<boolean> {
  const event = await sourceEvent(database(c), eventId), principal = c.get('principal');
  if (!event || !principal) return false;
  return await executionEventRequirements(c.env as OperationsBindings, principal, event) !== null;
}

/** Fenced archive capture uses the same immutable execution provenance as API reads. */
export async function executionArchiveAudience(db: Database, repoId: string): Promise<string[]> {
  const result = new Set<string>([repoId]);
  for (const table of ['workflow_runs', 'workflow_run_requests', 'workflow_plan_previews', 'workflow_trigger_failures']) {
    let cursor = 0;
    for (;;) {
      const rows = await many<Record<string, unknown> & { __cursor: number }>(db, `SELECT rowid AS __cursor,* FROM ${table} WHERE repo_id=? AND rowid>? ORDER BY rowid LIMIT 50`, repoId, cursor);
      if (!rows.length) break;
      for (const row of rows) {
        let audience: string[];
        if (table === 'workflow_runs') audience = executionAudience(await readRunPlan(row as unknown as RunRecord));
        else if (table === 'workflow_run_requests') audience = await workflowOperationAudience(db, row as unknown as WorkflowOperation);
        else if (table === 'workflow_plan_previews') audience = (await previewAudience(row as unknown as WorkflowPreviewRecord)).repositories;
        else {
          const retained = row.audience_json ? JSON.parse(String(row.audience_json)) : null;
          if (!Array.isArray(retained)) executionNotFound();
          audience = executionAudience({ repo_id: repoId, related_repo_ids: retained, trigger: { id: String(row.event_id), type: 'failure' } });
        }
        for (const source of audience) result.add(source);
      }
      cursor = rows.at(-1)!.__cursor;
    }
  }
  return [...result].sort();
}
