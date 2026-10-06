import { z } from 'zod';
import { ApiError, authorize, database, getRepository, many, now, one, requirePrincipal, stmt } from '@gitknot/core';
import type { Repository } from '@gitknot/core';
import { getItem, identifier, oid } from './common.ts';
import type { Item } from './common.ts';
import { inspectPatch, nativeJSON, nativeOperationSchema, resolveNativeCommit, suggestionInspectionSchema } from './native.ts';
import type { NativeOperation } from './native.ts';
import { preparePatch, pullDetails, readPatch, readPatchFiles } from './patches.ts';
import type { Pull } from './patches.ts';
import type { Suggestion } from './reviews.ts';
import { checked, committedPublication, domainStatements, nativeMutation, nativeWaiting, requiredString } from './operation-runtime.ts';
import type { OperationState, OperationStep } from './operation-runtime.ts';

function verifiedHead(native: NativeOperation, nativeId: string, ref: string, oldOid: string): string | null {
  if (native.state === 'rejected') throw new ApiError(409, native.error?.code ?? 'git_change_rejected', 'Native Git rejected the proposed source-branch update.');
  if (!committedPublication(native, nativeId)) return null;
  const change = native.result!.refs.find(value => value.ref === ref);
  if (!change || change.old_oid !== oldOid || native.result!.refs.length !== 1) throw new ApiError(503, 'publication_result_mismatch', 'The source publication did not match its exact expected ref.');
  return change.new_oid;
}

async function refreshedPatch(state: OperationState, item: Item, repo: Repository, pull: Pull, baseOid: string, headOid: string): Promise<{ patch_id: string; effects: D1PreparedStatement[] }> {
  // Restack ancestry is not the reviewed base. Reviews always cover the complete
  // change relative to the trusted target branch, including unmerged dependencies.
  baseOid = await resolveNativeCommit(state.c, repo.id, pull.base_ref);
  if (pull.head_oid === headOid && pull.base_oid === baseOid) return { patch_id: pull.current_patch_id, effects: [] };
  const evidence = await inspectPatch(state.c, repo.id, pull.head_repo_id, baseOid, headOid);
  const prior = await readPatch(state.c, item, pull.current_patch_id);
  const next = await preparePatch(state.c, item, evidence, prior.version + 1);
  return { patch_id: next.patch.id, effects: [
    ...next.statements,
    ...checked(state.c, stmt(database(state.c), 'UPDATE pull_requests SET head_oid=?,base_oid=?,current_patch_id=? WHERE repo_id=? AND id=? AND current_patch_id=?', headOid, baseOid, next.patch.id, repo.id, item.id, pull.current_patch_id)),
    ...checked(state.c, stmt(database(state.c), 'UPDATE collaboration_items SET revision=revision+1,updated_at=? WHERE repo_id=? AND id=? AND revision=? AND deleted_at IS NULL', now(), repo.id, item.id, item.revision)),
    ...domainStatements(state.c, repo, item, 'pull_request.patch_updated', item.revision + 1,
      { patch_id: next.patch.id, previous_patch_id: prior.id, head_oid: headOid, base_oid: baseOid, operation_id: state.operation.id, review_validity_recomputed: true }),
  ] };
}

export async function stepSuggestion(state: OperationState): Promise<OperationStep> {
  const { c, operation, input } = state;
  const { item, repo } = await getItem(c, 'pull_request', requiredString(input, 'pull_id'), 'pull_requests.write', operation.repo_id!);
  const suggestion = await one<Suggestion>(database(c), 'SELECT * FROM pull_suggestions WHERE repo_id=? AND pull_id=? AND id=? AND operation_id=?', repo.id, item.id, requiredString(input, 'suggestion_id'), operation.id);
  if (!suggestion) throw new ApiError(404, 'suggestion_unavailable', 'The applying suggestion is unavailable.');
  if (suggestion.state === 'applied') return { status: 'completed', phase: 'applied', result: { suggestion_id: suggestion.id, patch_id: suggestion.applied_patch_id } };
  if (suggestion.state !== 'applying') return { status: 'cancelled', phase: 'suggestion_cancelled' };
  const pull = await pullDetails(c, item);
  const nativeId = `${operation.id}_apply`;
  const priorNative = await one(database(c), 'SELECT 1 FROM git_publications WHERE repo_id=? AND id=?', requiredString(input, 'head_repo_id'), nativeId);
  let native: NativeOperation;
  if (priorNative) native = await nativeJSON(c, pull.head_repo_id, `operations/${nativeId}`, nativeOperationSchema);
  else {
    if (!['open', 'draft'].includes(item.state) || pull.current_patch_id !== input.patch_id || pull.head_oid !== input.head_oid) {
      throw new ApiError(409, 'suggestion_stale', 'The pull request changed before its suggestion could be applied.');
    }
    await authorize(c, 'contents.push', { repo_id: pull.head_repo_id, ref: pull.head_ref, paths: [requiredString(input, 'path')] });
    const prepared = await nativeJSON(c, pull.head_repo_id, 'collaboration/inspect', suggestionInspectionSchema, {
      actor: requirePrincipal(c), inspection: { kind: 'suggestion', head_oid: pull.head_oid, path: input.path,
        start_line: input.start_line, end_line: input.end_line, replacement: input.replacement },
    });
    if (prepared.repo_id !== pull.head_repo_id || prepared.head_oid !== input.head_oid || prepared.edit.path !== input.path) {
      throw new ApiError(503, 'suggestion_evidence_mismatch', 'The native replacement did not match its immutable anchor.');
    }
    native = await nativeMutation(state, pull.head_repo_id, nativeId, { kind: 'edit', ref: requiredString(input, 'head_ref'), expected_oid: requiredString(input, 'head_oid'),
      edits: [prepared.edit], message: requiredString(input, 'message'), author: { name: 'GitKnot', email: 'git@gitknot.com' } });
  }
  const headOid = verifiedHead(native, nativeId, requiredString(input, 'head_ref'), requiredString(input, 'head_oid'));
  if (!headOid) return nativeWaiting(state, 'reconciling_suggestion');
  if (pull.head_oid !== input.head_oid && pull.head_oid !== headOid) {
    throw new ApiError(409, 'suggestion_follow_up_required', 'The suggestion was published, but another source update needs reconciliation before recording its patch.');
  }
  const patch = await refreshedPatch(state, item, repo, pull, requiredString(input, 'base_oid'), headOid);
  const at = now();
  return { status: 'completed', phase: 'applied', result: { suggestion_id: suggestion.id, pull_id: item.id, patch_id: patch.patch_id,
    head_oid: headOid, canonical_publication_verified: true }, effects: [
    ...patch.effects,
    ...checked(c, stmt(database(c), `UPDATE pull_suggestions SET state='applied',applied_patch_id=?,revision=revision+1,updated_at=?
      WHERE repo_id=? AND pull_id=? AND id=? AND revision=? AND state='applying' AND operation_id=?`, patch.patch_id, at, repo.id, item.id, suggestion.id, suggestion.revision, operation.id)),
    stmt(database(c), 'UPDATE pull_review_threads SET resolved_at=?,resolved_by=?,revision=revision+1,updated_at=? WHERE repo_id=? AND pull_id=? AND id=?', at, requirePrincipal(c).id, at, repo.id, item.id, suggestion.thread_id),
    ...domainStatements(c, repo, item, 'pull_request.suggestion_applied', suggestion.revision + 1,
      { suggestion_id: suggestion.id, patch_id: patch.patch_id, head_oid: headOid, operation_id: operation.id }, suggestion.id),
  ] };
}

const snapshotSchema = z.object({ id: identifier, pull_id: identifier, revision: z.number().int().positive(), head_repo_id: identifier,
  current_patch_id: identifier, head_oid: oid, base_oid: oid, head_ref: z.string(), base_ref: z.string() });
type StackSnapshot = z.infer<typeof snapshotSchema>;
interface Restacked { pull_id: string; head_oid: string; base_oid: string; patch_id: string; head_repo_id: string }

export async function stepRestack(state: OperationState): Promise<OperationStep> {
  const { c, input, operation } = state;
  const snapshots = z.array(snapshotSchema).min(1).max(100).parse(input.snapshots);
  const completed = (state.checkpoint.completed ?? []) as Restacked[];
  if (completed.length === snapshots.length) return { status: 'completed', phase: 'restacked', result: { changes: completed, canonical_publications_verified: true } };
  const selected = new Set(snapshots.map(value => value.pull_id));
  const remaining = snapshots.filter(snapshot => !completed.some(value => value.pull_id === snapshot.pull_id));
  let chosen: StackSnapshot | undefined;
  let parentIds: string[] = [];
  for (const snapshot of remaining) {
    const dependencies = await many<{ depends_on_id: string }>(database(c), 'SELECT depends_on_id FROM pull_dependencies WHERE repo_id=? AND pull_id=? ORDER BY depends_on_id', operation.repo_id, snapshot.pull_id);
    const internal = dependencies.map(value => value.depends_on_id).filter(id => selected.has(id));
    if (internal.every(id => completed.some(done => done.pull_id === id))) { chosen = snapshot; parentIds = internal; break; }
  }
  if (!chosen) throw new ApiError(409, 'restack_graph_changed', 'The stack dependency graph changed and cannot be restacked in the accepted order.');
  if (parentIds.length > 1) throw new ApiError(409, 'ambiguous_stack_parent', 'This dependent change has multiple stack parents. Choose a linear restack target explicitly.');
  const { item, repo } = await getItem(c, 'pull_request', chosen.pull_id, 'pull_requests.write', operation.repo_id!);
  const pull = await pullDetails(c, item);
  const nativeId = `${operation.id}_restack_${snapshots.findIndex(value => value.pull_id === chosen!.pull_id)}`;
  const existing = await one(database(c), 'SELECT 1 FROM git_publications WHERE repo_id=? AND id=?', chosen.head_repo_id, nativeId);
  let ontoOid: string;
  let ontoRepoId: string;
  if (parentIds.length) {
    const parent = completed.find(value => value.pull_id === parentIds[0])!;
    ontoOid = parent.head_oid; ontoRepoId = parent.head_repo_id;
  } else if (typeof input.onto_pull_id === 'string') {
    const parent = await getItem(c, 'pull_request', input.onto_pull_id, 'contents.read', repo.id);
    const parentPull = await pullDetails(c, parent.item);
    ontoOid = parentPull.head_oid; ontoRepoId = parentPull.head_repo_id;
  } else { ontoOid = requiredString(input, 'onto_oid'); ontoRepoId = repo.id; }
  if (existing && state.checkpoint.active_pull_id === chosen.pull_id) {
    ontoOid = requiredString(state.checkpoint, 'active_onto_oid');
    ontoRepoId = requiredString(state.checkpoint, 'active_onto_repo_id');
  }
  await getRepository(c, ontoRepoId);
  await authorize(c, 'contents.push', { repo_id: chosen.head_repo_id, ref: chosen.head_ref,
    paths: (await readPatchFiles(c, item, chosen.current_patch_id)).map(file => file.path) });
  if (!existing && (item.revision !== chosen.revision || pull.current_patch_id !== chosen.current_patch_id || !['open', 'draft'].includes(item.state))) {
    throw new ApiError(409, 'restack_patch_changed', 'A selected pull request changed after the restack was accepted.');
  }
  if (state.checkpoint.active_pull_id !== chosen.pull_id) {
    return { status: 'waiting', phase: 'restack_planned', progress: Math.floor(completed.length / snapshots.length * 90),
      checkpoint: { active_pull_id: chosen.pull_id, active_onto_oid: ontoOid, active_onto_repo_id: ontoRepoId, active_native_id: nativeId } };
  }
  const patch = await readPatch(c, item, chosen.current_patch_id);
  const parentId = parentIds[0] ?? (typeof input.onto_pull_id === 'string' ? input.onto_pull_id : null);
  const lineage = parentId ? await one<{ id: string; base_oid: string | null; revision: number }>(database(c),
    'SELECT id,base_oid,revision FROM pull_dependencies WHERE repo_id=? AND pull_id=? AND depends_on_id=?', repo.id, item.id, parentId) : null;
  let oldBase = patch.merge_base_oid;
  if (lineage?.base_oid) {
    try { oldBase = (await inspectPatch(c, repo.id, chosen.head_repo_id, lineage.base_oid, chosen.head_oid, false)).merge_base_oid; }
    catch (error) { if (!(error instanceof ApiError && error.code === 'object_not_found')) throw error; }
  }
  const native = existing ? await nativeJSON(c, chosen.head_repo_id, `operations/${nativeId}`, nativeOperationSchema)
    : await nativeJSON(c, chosen.head_repo_id, 'mutate', nativeOperationSchema, {
      operation_id: nativeId, actor: requirePrincipal(c), mutation: { kind: 'restack', ref: chosen.head_ref, expected_oid: chosen.head_oid,
        old_base_oid: oldBase, onto_oid: ontoOid, onto_repo_id: ontoRepoId, pull_request_id: item.id },
    });
  const newHead = verifiedHead(native, nativeId, chosen.head_ref, chosen.head_oid);
  if (!newHead) return nativeWaiting(state, 'reconciling_restack');
  if (pull.head_oid !== chosen.head_oid && pull.head_oid !== newHead) throw new ApiError(409, 'restack_follow_up_required', 'A restacked source branch has a later update that must be reconciled.');
  const nextPatch = await refreshedPatch(state, item, repo, pull, ontoOid, newHead);
  const result = { pull_id: item.id, head_oid: newHead, base_oid: ontoOid, patch_id: nextPatch.patch_id, head_repo_id: chosen.head_repo_id };
  return { status: completed.length + 1 === snapshots.length ? 'completed' : 'waiting', phase: completed.length + 1 === snapshots.length ? 'restacked' : 'restacking',
    progress: Math.floor((completed.length + 1) / snapshots.length * 100), checkpoint: { completed: [...completed, result], active_pull_id: null },
    result: { changes: [...completed, result], canonical_publications_verified: true }, effects: [
      ...nextPatch.effects,
      ...(lineage ? checked(c, stmt(database(c), 'UPDATE pull_dependencies SET base_oid=?,revision=revision+1 WHERE repo_id=? AND id=? AND revision=?',
        ontoOid, repo.id, lineage.id, lineage.revision)) : []),
    ] };
}
