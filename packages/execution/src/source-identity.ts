import { ApiError, canonicalJson, one } from '@gitknot/core';
import type { Database, Repository } from '@gitknot/core';
import type { PlanRunInput } from './planning.ts';

export interface WorkflowSourceIdentity {
  source_repo_id: string; related_repo_ids: string[]; head_repo_id: string; head_oid: string; head_ref: string;
  target_oid: string | null; target_ref: string | null; pull_request_id: string | null; pull_patch_id: string | null;
  patch_fingerprint: string | null; native_evidence_id: string | null; candidate_id: string | null;
  candidate_oid: string | null; candidate_policy_revision: number | null;
}

interface PullSource { id: string; head_repo_id: string; head_oid: string; head_ref: string; base_oid: string; base_ref: string; current_patch_id: string | null }
interface PatchSource { id: string; head_repo_id: string; head_oid: string; base_oid: string; patch_fingerprint: string; native_evidence_id: string }
interface CandidateSource { id: string; source_repo_id: string; source_oid: string; target_oid: string; target_ref: string; candidate_oid: string | null; pull_request_id: string | null; policy_revision: number; state: string }

/** Capture once, then compare the same immutable native evidence at every handoff. */
export async function pinWorkflowSource(db: Database, repository: Pick<Repository, 'id' | 'policy_revision'>, input: PlanRunInput): Promise<WorkflowSourceIdentity> {
  const source: WorkflowSourceIdentity = { source_repo_id: repository.id, related_repo_ids: [repository.id], head_repo_id: repository.id,
    head_oid: input.commit, head_ref: input.ref, target_oid: null, target_ref: null, pull_request_id: input.event.pull_request_id ?? null,
    pull_patch_id: null, patch_fingerprint: null, native_evidence_id: null, candidate_id: input.event.merge_candidate_id ?? null,
    candidate_oid: null, candidate_policy_revision: null };
  if (source.candidate_id) {
    const candidate = await one<CandidateSource>(db, 'SELECT * FROM git_candidates WHERE repo_id=? AND id=?', repository.id, source.candidate_id);
    if (!candidate || !['ready', 'published'].includes(candidate.state) || candidate.policy_revision !== repository.policy_revision
      || candidate.candidate_oid !== input.commit || candidate.target_ref !== input.ref
      || source.pull_request_id && source.pull_request_id !== candidate.pull_request_id) changed('candidate_stale');
    Object.assign(source, { head_repo_id: candidate.source_repo_id, head_oid: candidate.source_oid, target_oid: candidate.target_oid,
      target_ref: candidate.target_ref, pull_request_id: candidate.pull_request_id, candidate_oid: candidate.candidate_oid, candidate_policy_revision: candidate.policy_revision });
  }
  if (source.pull_request_id) {
    const pull = await one<PullSource>(db, 'SELECT * FROM pull_requests WHERE repo_id=? AND id=?', repository.id, source.pull_request_id);
    const patchId = input.source?.pull_patch_id ?? pull?.current_patch_id;
    const patch = patchId ? await one<PatchSource>(db, 'SELECT * FROM pull_patches WHERE repo_id=? AND pull_id=? AND id=?', repository.id, source.pull_request_id, patchId) : null;
    if (!pull || !patch || pull.current_patch_id !== patch.id || pull.head_repo_id !== patch.head_repo_id || pull.head_oid !== patch.head_oid || pull.base_oid !== patch.base_oid
      || source.candidate_id && (source.head_repo_id !== patch.head_repo_id || source.head_oid !== patch.head_oid || source.target_oid !== patch.base_oid)
      || !source.candidate_id && (patch.head_oid !== input.commit || pull.head_ref !== input.ref)) changed('pull_request_stale');
    Object.assign(source, { head_repo_id: patch.head_repo_id, head_oid: patch.head_oid, head_ref: pull.head_ref,
      target_oid: patch.base_oid, target_ref: pull.base_ref, pull_patch_id: patch.id, patch_fingerprint: patch.patch_fingerprint, native_evidence_id: patch.native_evidence_id });
  }
  source.source_repo_id = source.candidate_id ? repository.id : source.head_repo_id;
  source.related_repo_ids = [...new Set([repository.id, source.head_repo_id])];
  if (input.source && canonicalJson(input.source) !== canonicalJson(source)) changed('workflow_source_changed');
  return source;
}

function changed(code: string): never {
  throw new ApiError(409, code, 'The immutable workflow source no longer matches its accepted patch or candidate.');
}

export function workflowSourcePredicate(repoId: string, source?: WorkflowSourceIdentity, current = true): { sql: string; values: unknown[] } {
  const clauses: string[] = [], values: unknown[] = [];
  if (source?.pull_request_id && current) {
    clauses.push(`EXISTS (SELECT 1 FROM pull_requests p JOIN pull_patches v ON v.id=p.current_patch_id AND v.repo_id=p.repo_id AND v.pull_id=p.id
      WHERE p.repo_id=? AND p.id=? AND p.current_patch_id=? AND p.head_repo_id=? AND p.head_oid=? AND p.base_oid=? AND p.head_ref=? AND p.base_ref=?
      AND v.patch_fingerprint=? AND v.native_evidence_id=?)`);
    values.push(repoId, source.pull_request_id, source.pull_patch_id, source.head_repo_id, source.head_oid, source.target_oid,
      source.head_ref, source.target_ref, source.patch_fingerprint, source.native_evidence_id);
  } else if (source?.pull_request_id) {
    clauses.push(`EXISTS (SELECT 1 FROM pull_patches WHERE repo_id=? AND pull_id=? AND id=? AND head_repo_id=? AND head_oid=? AND base_oid=?
      AND patch_fingerprint=? AND native_evidence_id=?)`);
    values.push(repoId, source.pull_request_id, source.pull_patch_id, source.head_repo_id, source.head_oid, source.target_oid, source.patch_fingerprint, source.native_evidence_id);
  }
  if (source?.candidate_id) {
    clauses.push(`EXISTS (SELECT 1 FROM git_candidates WHERE repo_id=? AND id=? AND source_repo_id=? AND source_oid=? AND target_oid=? AND target_ref=?
      AND candidate_oid=? AND policy_revision=? AND state IN ('ready','published'))`);
    values.push(repoId, source.candidate_id, source.head_repo_id, source.head_oid, source.target_oid, source.target_ref, source.candidate_oid, source.candidate_policy_revision);
  }
  return { sql: clauses.length ? clauses.join(' AND ') : '1', values };
}
