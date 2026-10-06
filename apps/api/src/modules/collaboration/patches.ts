import { ApiError, database, many, newId, now, one, requirePrincipal, stmt } from '@gitknot/core';
import type { AppContext } from '@gitknot/core';
import type { Item } from './common.ts';
import { conflict, notFound } from './common.ts';
import type { NativePatch, NativePatchFile } from './native.ts';
import { inspectPatch, resolveNativeCommit } from './native.ts';

export interface Pull {
  id: string; repo_id: string; head_repo_id: string; base_ref: string; head_ref: string; base_oid: string; head_oid: string;
  current_patch_id: string; milestone_id: string | null; task_id: string | null;
  merged_at: string | null; merged_by: string | null; merge_oid: string | null;
}
export interface Patch {
  id: string; repo_id: string; pull_id: string; version: number; head_repo_id: string;
  base_oid: string; head_oid: string; merge_base_oid: string; patch_fingerprint: string;
  fingerprint_algorithm: 'git-patch-id-verbatim-v1';
  native_evidence_id: string; created_by: string; created_at: string;
}
export interface PatchFile extends Omit<NativePatchFile, 'binary' | 'hunks'> {
  repo_id: string; pull_id: string; patch_id: string; binary: number; hunks_json: string;
}

export async function pullDetails(c: AppContext, item: Item): Promise<Pull> {
  const pull = await one<Pull>(database(c), 'SELECT * FROM pull_requests WHERE repo_id=? AND id=?', item.repo_id, item.id);
  if (!pull) notFound();
  return pull;
}
export async function readPatch(c: AppContext, item: Item, id: string): Promise<Patch> {
  const patch = await one<Patch>(database(c), 'SELECT * FROM pull_patches WHERE repo_id=? AND pull_id=? AND id=?', item.repo_id, item.id, id);
  if (!patch) notFound();
  return patch;
}
export async function readPatchFiles(c: AppContext, item: Item, patchId: string): Promise<PatchFile[]> {
  return many<PatchFile>(database(c), 'SELECT * FROM pull_patch_files WHERE repo_id=? AND pull_id=? AND patch_id=? ORDER BY path', item.repo_id, item.id, patchId);
}
export function mutablePull(item: Item): void {
  if (!['open', 'draft'].includes(item.state)) conflict('pull_not_open', 'Reopen this pull request before updating its patch.');
}

/** A caller-provided commit is a precondition, never authority to shrink a review's diff. */
export async function inspectTargetPatch(c: AppContext, input: {
  repo_id: string; head_repo_id: string; base_ref: string; head_ref: string;
  expected_base_oid?: string; expected_head_oid?: string; retain?: boolean;
}): Promise<NativePatch> {
  const [target, head] = await Promise.all([
    resolveNativeCommit(c, input.repo_id, input.base_ref), resolveNativeCommit(c, input.head_repo_id, input.head_ref),
  ]);
  if (input.expected_base_oid !== undefined && target !== input.expected_base_oid) {
    throw new ApiError(412, 'review_target_changed', 'The review base must be the current target branch revision. Refresh the target before recording a patch.');
  }
  if (input.expected_head_oid !== undefined && head !== input.expected_head_oid) {
    throw new ApiError(412, 'review_head_changed', 'The source branch no longer matches the proposed head. Refresh it before recording a patch.');
  }
  const evidence = await inspectPatch(c, input.repo_id, input.head_repo_id, target, head, input.retain ?? false);
  if (input.retain) {
    // Durable retention can outlive the initial ref reads. It preserves objects,
    // not a grant to publish collaboration metadata against a changed branch.
    const [currentTarget, currentHead] = await Promise.all([
      resolveNativeCommit(c, input.repo_id, input.base_ref), resolveNativeCommit(c, input.head_repo_id, input.head_ref),
    ]);
    if (currentTarget !== target) throw new ApiError(412, 'review_target_changed', 'The target branch changed while retaining the patch. Refresh it before recording a patch.');
    if (currentHead !== head) throw new ApiError(412, 'review_head_changed', 'The source branch changed while retaining the patch. Refresh it before recording a patch.');
  }
  return evidence;
}

export function sameReviewedPatch(patch: Patch, files: PatchFile[], trusted: NativePatch): boolean {
  if (patch.head_oid !== trusted.head_oid || patch.head_repo_id !== trusted.head_repo_id
    || patch.fingerprint_algorithm !== trusted.fingerprint_algorithm || patch.patch_fingerprint !== trusted.patch_fingerprint
    || files.length !== trusted.files.length) return false;
  const expected = new Map(trusted.files.map(file => [file.path, file]));
  return files.every(file => {
    const actual = expected.get(file.path);
    return actual && actual.patch_fingerprint === file.patch_fingerprint && actual.change_kind === file.change_kind
      && actual.old_path === file.old_path;
  });
}

export async function preparePatch(c: AppContext, item: Item, evidence: NativePatch, version: number): Promise<{ patch: Patch; statements: D1PreparedStatement[] }> {
  if (evidence.repo_id !== item.repo_id) throw new ApiError(503, 'git_evidence_mismatch', 'Patch evidence belongs to a different repository.');
  const patch: Patch = { id: newId('patch'), repo_id: item.repo_id, pull_id: item.id, version,
    head_repo_id: evidence.head_repo_id, base_oid: evidence.base_oid, head_oid: evidence.head_oid,
    merge_base_oid: evidence.merge_base_oid, patch_fingerprint: evidence.patch_fingerprint,
    fingerprint_algorithm: evidence.fingerprint_algorithm,
    native_evidence_id: evidence.native_evidence_id, created_by: requirePrincipal(c).id, created_at: now() };
  const db = database(c);
  const statements = [stmt(db, `INSERT INTO pull_patches
    (id,repo_id,pull_id,version,head_repo_id,base_oid,head_oid,merge_base_oid,patch_fingerprint,native_evidence_id,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, patch.id, patch.repo_id, patch.pull_id, patch.version, patch.head_repo_id,
  patch.base_oid, patch.head_oid, patch.merge_base_oid, patch.patch_fingerprint, patch.native_evidence_id, patch.created_by, patch.created_at),
  ...evidence.files.map(file => stmt(db, `INSERT INTO pull_patch_files
    (repo_id,pull_id,patch_id,path,old_path,change_kind,old_oid,new_oid,patch_fingerprint,old_lines,new_lines,binary,hunks_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, item.repo_id, item.id, patch.id, file.path, file.old_path, file.change_kind,
  file.old_oid, file.new_oid, file.patch_fingerprint, file.old_lines, file.new_lines, Number(file.binary), JSON.stringify(file.hunks)))];
  if (version > 1) statements.push(...reviewPreservationStatements(c, item, patch));
  return { patch, statements };
}

function reviewPreservationStatements(c: AppContext, item: Item, patch: Patch): D1PreparedStatement[] {
  const db = database(c);
  // Compare with the exact original review scope. A name, commit author, or moved line number is not approval evidence.
  return [
    stmt(db, `INSERT INTO pull_review_validity(repo_id,review_id,patch_id,state,changed_paths_json,created_at)
      SELECT r.repo_id,r.id,?,CASE WHEN
        (r.scope='all' AND old.patch_fingerprint=?) OR
        (r.scope='files' AND EXISTS(SELECT 1 FROM pull_review_files rf WHERE rf.repo_id=r.repo_id AND rf.review_id=r.id)
          AND NOT EXISTS(SELECT 1 FROM pull_review_files rf LEFT JOIN pull_patch_files nf
            ON nf.repo_id=rf.repo_id AND nf.patch_id=? AND nf.path=rf.path
            WHERE rf.repo_id=r.repo_id AND rf.review_id=r.id AND (nf.path IS NULL OR nf.patch_fingerprint<>rf.patch_fingerprint)))
        THEN 'preserved' ELSE 'invalidated' END,
      (SELECT COALESCE(json_group_array(path),'[]') FROM (
        SELECT rf.path AS path FROM pull_review_files rf LEFT JOIN pull_patch_files nf
          ON nf.repo_id=rf.repo_id AND nf.patch_id=? AND nf.path=rf.path
          WHERE rf.repo_id=r.repo_id AND rf.review_id=r.id AND (nf.path IS NULL OR nf.patch_fingerprint<>rf.patch_fingerprint)
        UNION SELECT nf.path FROM pull_patch_files nf WHERE nf.repo_id=r.repo_id AND nf.patch_id=? AND r.scope='all'
          AND NOT EXISTS(SELECT 1 FROM pull_review_files rf WHERE rf.repo_id=r.repo_id AND rf.review_id=r.id AND rf.path=nf.path))),?
      FROM pull_reviews r JOIN pull_patches old ON old.repo_id=r.repo_id AND old.id=r.patch_id
      WHERE r.repo_id=? AND r.pull_id=?`, patch.id, patch.patch_fingerprint, patch.id, patch.id, patch.id, now(), item.repo_id, item.id),
    stmt(db, `UPDATE pull_review_threads SET outdated=CASE WHEN EXISTS (
      SELECT 1 FROM pull_patch_files old JOIN pull_patch_files current ON current.repo_id=old.repo_id AND current.path=old.path
      WHERE old.repo_id=pull_review_threads.repo_id AND old.patch_id=pull_review_threads.patch_id AND old.path=pull_review_threads.path
        AND current.patch_id=? AND current.patch_fingerprint=old.patch_fingerprint) THEN 0 ELSE 1 END,
      revision=revision+1,updated_at=? WHERE repo_id=? AND pull_id=?`, patch.id, now(), item.repo_id, item.id),
    stmt(db, `UPDATE pull_merge_queue SET state='superseded',reason_json='["patch_changed"]',revision=revision+1,updated_at=?
      WHERE repo_id=? AND pull_id=? AND state IN ('queued','preparing','verifying','ready','blocked')`, now(), item.repo_id, item.id),
  ];
}
