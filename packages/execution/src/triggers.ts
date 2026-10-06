import { ApiError, authorize, execute, many, now, one, principalForExplanation, sha256 } from '@gitknot/core';
import type { Bindings, EventRecord, Repository } from '@gitknot/core';
import { currentExecutionActor, repositoryExecutionContext } from './authorization.ts';
import { createRun } from './control-plane.ts';
import { planRun } from './planning.ts';
import type { PlanRunInput, WorkflowRecord, WorkflowVersion } from './planning.ts';
import { identityPrimary, primary } from './store.ts';
import { pinWorkflowSource } from './source-identity.ts';

export async function triggerWorkflows(env: Bindings, event: EventRecord): Promise<void> {
  const inputs = await triggerInputs(env, event);
  for (const input of inputs) {
    const db = primary(env), repo = await one<Repository>(db, 'SELECT * FROM repositories WHERE id=? AND state=?', input.repo_id, 'active');
    if (!repo) continue;
    const workflows = await many<WorkflowRecord>(db, `SELECT * FROM workflows WHERE repo_id=? AND account_id=? AND state='active' ORDER BY id LIMIT 128`, repo.id, repo.owner_id);
    for (const workflow of workflows) {
      const version = await one<WorkflowVersion>(db, 'SELECT * FROM workflow_versions WHERE id=? AND repo_id=?', workflow.current_version_id, repo.id);
      if (!version || !(JSON.parse(version.definition_json) as { triggers: string[] }).triggers.includes(input.event.type)) continue;
      const key = `event:${workflow.id}:${input.event.type}:${input.event.id}`;
      if (await one(db, 'SELECT id FROM workflow_runs WHERE repo_id=? AND workflow_id=? AND trigger_id=? AND trigger_type=?', repo.id, workflow.id, input.event.id, input.event.type)) continue;
      let principal = await principalForExplanation(identityPrimary(env), version.approved_by);
      try {
        if (!principal) throw new ApiError(403, 'workflow_identity_revoked', 'The approving workflow identity is no longer active.');
        principal = await currentExecutionActor(env, { id: principal.id, kind: principal.kind, user_id: principal.user_id, credential_id: version.approved_credential_id });
        const authority = await repositoryExecutionContext(env, principal, repo.id);
        await authorize(authority, 'workflows.run', { repo_id: repo.id, ref: input.ref });
        input.source ??= await pinWorkflowSource(db, repo, input);
        const plan = await planRun(env, repo, workflow, version, principal, input, true);
        await createRun(env, db, { authority, workflow_id: workflow.id, plan, actor_id: principal.id, request_key: key, request_hash: await sha256(JSON.stringify(input)) });
      } catch (error) {
        if (!(error instanceof ApiError) || error.status >= 500 || error.status === 429) throw error;
        const audience = input.source?.related_repo_ids ?? (!input.event.pull_request_id && !input.event.merge_candidate_id ? [repo.id] : null);
        await execute(db, `INSERT OR IGNORE INTO workflow_trigger_failures (event_id,workflow_id,repo_id,account_id,commit_sha,code,message,created_at,audience_json) VALUES (?,?,?,?,?,?,?,?,?)`,
          event.id, workflow.id, repo.id, repo.owner_id, input.commit, error.code, error.message, now(), audience ? JSON.stringify(audience) : null);
      }
    }
  }
}

async function triggerInputs(env: Bindings, event: EventRecord): Promise<Array<PlanRunInput & { repo_id: string }>> {
  if (!event.repo_id) return [];
  const db = primary(env);
  if (event.type === 'merge_candidate.created') {
    const id = typeof event.data.candidate_id === 'string' ? event.data.candidate_id : event.resource_id;
    const candidate = await one<{ id: string; candidate_oid: string; target_ref: string; source_oid: string; target_oid: string; policy_revision: number; pull_request_id: string | null }>(db,
      `SELECT * FROM git_candidates WHERE repo_id=? AND id=? AND state='ready'`, event.repo_id, id);
    if (!candidate || candidate.candidate_oid !== event.data.commit_sha || candidate.policy_revision !== event.data.policy_revision
      || candidate.target_ref !== event.data.target_ref || candidate.target_oid !== event.data.target_oid || candidate.source_oid !== event.data.head_oid) return [];
    const paths = event.data.changed_paths;
    const validPaths = Array.isArray(paths) && paths.length <= 10000 && paths.every(path => typeof path === 'string' && path.length <= 4096);
    return [{ repo_id: event.repo_id, commit: candidate.candidate_oid, ref: candidate.target_ref,
      event: { type: event.type, id: event.id, merge_candidate_id: candidate.id, ...(candidate.pull_request_id ? { pull_request_id: candidate.pull_request_id } : {}) },
      ...(validPaths ? { changed_paths: paths as string[] } : {}) }];
  }
  if (event.type === 'git.refs.updated') {
    const operation = await one<{ kind: string; state: string; finalized: number; result_json: string; evidence_json: string | null }>(db,
      'SELECT kind,state,finalized,result_json,evidence_json FROM git_publications WHERE repo_id=? AND id=?', event.repo_id, event.data.operation_id);
    if (!operation || operation.state !== 'committed' || !operation.finalized) return [];
    if (operation.kind === 'candidate' && typeof event.data.candidate_id === 'string') {
      const candidate = await one<{ id: string; candidate_oid: string; target_ref: string; pull_request_id: string | null }>(db, 'SELECT * FROM git_candidates WHERE repo_id=? AND id=? AND state=?', event.repo_id, event.data.candidate_id, 'ready');
      return candidate ? [{ repo_id: event.repo_id, commit: candidate.candidate_oid, ref: candidate.target_ref,
        event: { type: 'merge_candidate.created', id: event.id, merge_candidate_id: candidate.id, ...(candidate.pull_request_id ? { pull_request_id: candidate.pull_request_id } : {}) } }] : [];
    }
    const result = JSON.parse(operation.result_json) as { refs: Array<{ ref: string; new_oid: string }> };
    const evidence = operation.evidence_json ? JSON.parse(operation.evidence_json) as { updates: Array<{ ref: string; paths: string[] }> } : null;
    return result.refs.filter(ref => /^refs\/(heads|tags)\//.test(ref.ref) && !/^0+$/.test(ref.new_oid)).flatMap(ref => [
      { repo_id: event.repo_id!, commit: ref.new_oid, ref: ref.ref, event: { type: 'repository.pushed', id: `${event.id}:${ref.ref}` }, changed_paths: evidence?.updates.find(update => update.ref === ref.ref)?.paths },
      { repo_id: event.repo_id!, commit: ref.new_oid, ref: ref.ref, event: { type: 'git.refs.updated', id: `${event.id}:${ref.ref}` }, changed_paths: evidence?.updates.find(update => update.ref === ref.ref)?.paths },
    ]);
  }
  if (['pull_request.created', 'pull_request.updated', 'pull_request.patch_updated', 'pull_request.patch_created', 'pull_request.patch_recorded', 'pull_request.head_updated'].includes(event.type)) {
    const id = typeof event.data.pull_id === 'string' ? event.data.pull_id : typeof event.data.item_id === 'string' ? event.data.item_id : event.resource_id;
    const pull = await one<{ id: string; head_ref: string; current_patch_id: string | null; revision: number }>(db,
      `SELECT p.id,p.head_ref,p.current_patch_id,i.revision FROM pull_requests p JOIN collaboration_items i ON i.id=p.id AND i.repo_id=p.repo_id
       WHERE p.id=? AND p.repo_id=? AND i.deleted_at IS NULL AND i.state IN ('open','draft')`, id, event.repo_id);
    const patchId = typeof event.data.patch_id === 'string' ? event.data.patch_id : pull?.current_patch_id;
    if (!pull || !patchId || patchId !== pull.current_patch_id || !event.data.patch_id && pull.revision !== event.resource_revision) return [];
    const patch = await one<{ head_oid: string; base_oid: string }>(db, 'SELECT head_oid,base_oid FROM pull_patches WHERE repo_id=? AND pull_id=? AND id=?', event.repo_id, pull.id, patchId);
    if (!patch || event.type === 'pull_request.patch_updated' && (patch.head_oid !== event.data.head_oid || patch.base_oid !== event.data.base_oid)
      || event.data.head_oid !== undefined && patch.head_oid !== event.data.head_oid || event.data.base_oid !== undefined && patch.base_oid !== event.data.base_oid) return [];
    const repository = await one<Repository>(db, 'SELECT * FROM repositories WHERE id=?', event.repo_id);
    if (!repository) return [];
    const input: PlanRunInput & { repo_id: string } = { repo_id: event.repo_id, commit: patch.head_oid, ref: pull.head_ref,
      event: { type: 'pull_request.updated', id: event.id, pull_request_id: pull.id } };
    input.source = await pinWorkflowSource(db, repository, input);
    const paths = await many<{ path: string; old_path: string | null }>(db, 'SELECT path,old_path FROM pull_patch_files WHERE repo_id=? AND pull_id=? AND patch_id=? ORDER BY path LIMIT 10001', event.repo_id, pull.id, patchId);
    if (paths.length > 10000) throw new ApiError(422, 'workflow_patch_limit', 'The complete workflow patch exceeds its file limit.');
    input.changed_paths = [...new Set(paths.flatMap(path => path.old_path ? [path.path, path.old_path] : [path.path]))];
    return [input];
  }
  return [];
}
