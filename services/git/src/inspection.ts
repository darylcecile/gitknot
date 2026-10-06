import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { NativeGit } from './process.ts';
import { associatedObject, readTree, resolveCommit } from './browse.ts';
import { objectInfo } from './objects.ts';
import { remoteConfiguration } from './remote.ts';
import type { GitRemote } from '../../../packages/git/src/types.ts';
import { matchGitPattern, validatePath } from '../../../packages/git/src/policy.ts';
import { GitError, requireValue } from '../../../packages/git/src/errors.ts';
import { reviewEvidenceId } from '../../../packages/git/src/protocol.ts';

const oid = z.string().regex(/^[a-f0-9]{40}$/u);
const inspectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('patch'), head_repo_id: z.string().max(128), base_oid: oid, head_oid: oid }).strict(),
  z.object({ kind: z.literal('diff'), head_repo_id: z.string().max(128), base_oid: oid, head_oid: oid,
    pull_id: z.string().max(128).optional(), from_patch_id: z.string().max(128).nullable().optional(), to_patch_id: z.string().max(128).optional() }).strict(),
  z.object({ kind: z.literal('resolve'), ref: z.string().min(1).max(1024) }).strict(),
  z.object({ kind: z.literal('suggestion'), head_oid: oid, path: z.string().max(4096), start_line: z.number().int().positive(),
    end_line: z.number().int().positive(), replacement: z.string().max(500_000) }).strict(),
  z.object({ kind: z.literal('scan'), commit_oid: oid, query: z.string().min(1).max(512), case_sensitive: z.boolean(),
    include_globs: z.array(z.string().min(1).max(256)).max(50), exclude_globs: z.array(z.string().min(1).max(256)).max(50),
    cursor: z.string().max(8192).nullable(), max_results: z.number().int().min(1).max(1000).default(500) }).strict(),
]);

export async function inspectCollaboration(git: NativeGit, repoId: string, payload: { inspection: unknown; source?: GitRemote; retained_refs?: string[] }, localRoot?: string): Promise<Response> {
  const parsed = inspectionSchema.safeParse(payload.inspection);
  requireValue(parsed.success, 'invalid_inspection', 'Invalid native collaboration inspection.');
  const input = parsed.data;
  if (input.kind === 'resolve') return Response.json({ repo_id: repoId, commit_oid: await resolveCommit(git, input.ref) });
  if (input.kind === 'suggestion') return Response.json(await suggestion(git, repoId, input));
  if (input.kind === 'scan') return Response.json(await scan(git, repoId, input));
  if (payload.retained_refs) {
    await associatedObject(git, input.base_oid, payload.retained_refs);
    await associatedObject(git, input.head_oid, payload.retained_refs);
  } else if (payload.source) {
    const env = await remoteConfiguration(payload.source, git.development, localRoot);
    await git.run(['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', payload.source.url,
      '+refs/heads/*:refs/gitknot/inspection/heads/*', '+refs/tags/*:refs/gitknot/inspection/tags/*'], { env });
    const refs = await git.text(['for-each-ref', '--format=%(objectname)', 'refs/gitknot/inspection/']);
    const history = await git.text(['rev-list', '--stdin'], { input: `${refs}\n`, max_output: git.limits.max_objects * 41 });
    requireValue(history.split('\n').includes(input.head_oid), 'object_not_found', 'Head commit is not associated with the source repository.', 404);
  } else await associatedObject(git, input.head_oid);
  if (!payload.retained_refs) {
    try { await associatedObject(git, input.base_oid); }
    catch (error) {
      if (!(error instanceof GitError) || error.status !== 404) throw error;
      const base = await git.run(['merge-base', '--is-ancestor', input.base_oid, input.head_oid], { allow_failure: true });
      requireValue(base.code === 0, 'object_not_found', 'The base is outside the authorized target and source history.', 404);
    }
  }
  const bases = (await git.text(['merge-base', '--all', input.base_oid, input.head_oid])).split('\n');
  requireValue(bases.length === 1, 'ambiguous_merge_base', 'This comparison requires an unambiguous merge base.', 409);
  const mergeBase = bases[0];
  if (input.kind === 'diff') return Response.json({ repo_id: repoId, base_oid: input.base_oid, head_oid: input.head_oid,
    complete: true, diff: new TextDecoder('utf-8', { fatal: true }).decode(await diff(git, input.base_oid, input.head_oid)) });
  const patch = await diff(git, mergeBase, input.head_oid);
  const patchFingerprint = await fingerprint(git, patch);
  const raw = await git.run(['diff', '--raw', '-z', '--abbrev=40', '--full-index', '--no-ext-diff', '--no-textconv', '--find-renames=50%', '-l1000', mergeBase, input.head_oid, '--']);
  const changes = parseChanges(raw.stdout);
  requireValue(changes.length <= 10_000, 'patch_file_limit', 'This comparison changes too many files.', 413);
  const files = [];
  for (const change of changes) {
    const paths = [...new Set([change.path, change.old_path].filter((value): value is string => !!value))];
    const patch = await diff(git, mergeBase, input.head_oid, paths);
    const hunks = [...patch.toString().matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gmu)].map(match => ({
      old_start: Number(match[1]), old_lines: Number(match[2] ?? 1), new_start: Number(match[3]), new_lines: Number(match[4] ?? 1),
    }));
    requireValue(hunks.length <= 10_000, 'patch_hunk_limit', 'This file has too many diff hunks.', 413);
    const old = await blobStats(git, change.old_oid, change.old_mode);
    const next = await blobStats(git, change.new_oid, change.new_mode);
    const { old_mode: ignoredOld, new_mode: ignoredNew, ...fields } = change;
    void ignoredOld; void ignoredNew;
    files.push({ ...fields, patch_fingerprint: await fingerprint(git, patch), old_lines: old.lines, new_lines: next.lines,
      binary: old.binary || next.binary, hunks });
  }
  const result = { version: 1, repo_id: repoId, head_repo_id: input.head_repo_id, base_oid: input.base_oid, head_oid: input.head_oid,
    fingerprint_algorithm: 'git-patch-id-verbatim-v1',
    merge_base_oid: mergeBase, patch_fingerprint: patchFingerprint, native_evidence_id: await reviewEvidenceId(repoId, input.head_repo_id, input.base_oid, input.head_oid),
    complete: true, files };
  requireValue(Buffer.byteLength(JSON.stringify(result)) <= git.limits.max_metadata_bytes, 'patch_evidence_limit', 'The complete patch evidence exceeds its configured limit.', 413);
  return Response.json(result);
}

interface Change { path: string; old_path: string | null; change_kind: string; old_oid: string | null; new_oid: string | null; old_mode: string; new_mode: string }

function parseChanges(raw: Buffer): Change[] {
  const fields = new TextDecoder('utf-8', { fatal: true }).decode(raw).split('\0');
  const changes: Change[] = [];
  for (let index = 0; index < fields.length && fields[index];) {
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([A-Z])\d*$/u.exec(fields[index++]);
    requireValue(match, 'invalid_diff', 'Native Git returned an invalid raw diff.', 503);
    const first = fields[index++];
    const path = match[5] === 'R' || match[5] === 'C' ? fields[index++] : first;
    validatePath(path);
    const kinds: Record<string, string> = { A: 'added', D: 'deleted', M: 'modified', R: 'renamed', C: 'copied', T: 'type_changed' };
    requireValue(kinds[match[5]], 'invalid_diff', 'Native Git returned an unresolved diff.', 409);
    changes.push({ path, old_path: match[5] === 'A' ? null : first, change_kind: kinds[match[5]],
      old_oid: /^0+$/u.test(match[3]) ? null : match[3], new_oid: /^0+$/u.test(match[4]) ? null : match[4], old_mode: match[1], new_mode: match[2] });
  }
  return changes;
}

async function diff(git: NativeGit, base: string, head: string, paths: string[] = []): Promise<Buffer> {
  return (await git.run(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--full-index', '--binary', '--unified=3', base, head, '--', ...paths], {
    max_output: Math.min(git.limits.max_inflated_bytes, git.limits.max_metadata_bytes * 16),
  })).stdout;
}

async function fingerprint(git: NativeGit, patch: Buffer): Promise<string> {
  const identity = await git.text(['patch-id', '--verbatim'], { input: patch });
  return hash(`git-patch-id-verbatim-v1\n${identity.split(' ')[0] || 'empty'}`);
}

async function blobStats(git: NativeGit, oid: string | null, mode: string): Promise<{ lines: number; binary: boolean }> {
  if (!oid || mode === '000000') return { lines: 0, binary: false };
  if (mode === '160000') return { lines: 0, binary: true };
  const info = (await objectInfo(git, [oid])).get(oid)!;
  requireValue(info.type === 'blob' && info.size <= git.limits.max_blob_bytes, 'blob_limit', 'A compared blob exceeds its byte limit.', 413);
  const raw = (await git.run(['cat-file', 'blob', oid], { max_output: git.limits.max_blob_bytes })).stdout;
  let binary = raw.includes(0);
  try { new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { binary = true; }
  let lines = 0;
  for (const byte of raw) if (byte === 10) lines++;
  if (raw.length && raw.at(-1) !== 10) lines++;
  return { lines, binary };
}

async function suggestion(git: NativeGit, repoId: string, input: Extract<z.infer<typeof inspectionSchema>, { kind: 'suggestion' }>): Promise<Record<string, unknown>> {
  const head = await resolveCommit(git, input.head_oid);
  validatePath(input.path);
  const entry = await fileAt(git, head, input.path);
  const blob = entry.oid;
  const raw = (await git.run(['cat-file', 'blob', blob], { max_output: git.limits.max_metadata_bytes })).stdout;
  requireValue(!raw.includes(0), 'binary_suggestion', 'Suggestions require a UTF-8 text file.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  const lines = text.split('\n');
  const actualLines = lines.length - Number(text.endsWith('\n'));
  requireValue(input.start_line <= input.end_line && input.end_line <= actualLines, 'suggestion_range', 'The suggested line range no longer exists.', 409);
  const replacement = input.replacement.replace(/\n$/u, '').split('\n');
  lines.splice(input.start_line - 1, input.end_line - input.start_line + 1, ...replacement);
  const content = Buffer.from(lines.join('\n'));
  requireValue(content.length <= git.limits.max_metadata_bytes, 'suggestion_limit', 'The suggested file exceeds its byte limit.', 413);
  requireValue(entry.mode === '100644' || entry.mode === '100755', 'suggestion_mode', 'Suggestions apply only to regular text files.');
  return { repo_id: repoId, head_oid: head, edit: { path: input.path, mode: entry.mode, content_base64: content.toString('base64') } };
}

async function fileAt(git: NativeGit, commit: string, path: string): Promise<{ oid: string; mode: string }> {
  let oid = await git.text(['rev-parse', `${commit}^{tree}`]);
  let mode = '';
  const segments = path.split('/');
  for (let index = 0; index < segments.length; index++) {
    const entry = (await readTree(git, oid)).find(entry => entry.name === segments[index]);
    requireValue(entry && entry.type === (index === segments.length - 1 ? 'blob' : 'tree'), 'file_not_found', 'Repository text file not found.', 404);
    oid = entry.oid;
    mode = entry.mode;
  }
  return { oid, mode };
}

interface ScanCursor { file: number; line: number; query: string; excluded: number }
interface ScanFile { path: string; oid: string; type: string; size: number }
interface ScanMatch { path: string; line: number; column: number; preview: string; preview_truncated: boolean; blob_oid: string }

async function scan(git: NativeGit, repoId: string, input: Extract<z.infer<typeof inspectionSchema>, { kind: 'scan' }>): Promise<Record<string, unknown>> {
  await resolveCommit(git, input.commit_oid);
  const queryDigest = hash(JSON.stringify({ ...input, cursor: null, max_results: null }));
  let cursor: ScanCursor = { file: 0, line: 0, query: queryDigest, excluded: 0 };
  if (input.cursor) {
    try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as ScanCursor; }
    catch { throw new GitError('invalid_cursor', 'Invalid native code-scan cursor.', 400); }
    requireValue(cursor.query === queryDigest && [cursor.file, cursor.line, cursor.excluded].every(value => Number.isSafeInteger(value) && value >= 0)
      && cursor.excluded <= cursor.file, 'invalid_cursor', 'This cursor belongs to another code scan.', 400);
  }
  const tree = await git.run(['ls-tree', '-r', '-z', '-l', input.commit_oid], { max_output: git.limits.max_metadata_bytes * 8 });
  const files: ScanFile[] = new TextDecoder('utf-8', { fatal: true }).decode(tree.stdout).split('\0').filter(Boolean).map(row => {
    const tab = row.indexOf('\t');
    const [, type, oid, bytes] = row.slice(0, tab).trim().split(/\s+/u);
    return { type, oid, size: bytes === '-' ? 0 : Number(bytes), path: row.slice(tab + 1) };
  });
  requireValue(files.length <= git.limits.max_tree_entries && cursor.file <= files.length, 'scan_limit', 'Code-scan enumeration exceeds its configured limit.', 413);
  const matches: ScanMatch[] = [];
  const exclusions: Array<{ path: string; reason: string }> = [];
  let file = cursor.file;
  let line = cursor.line;
  let excluded = cursor.excluded;
  for (; file < files.length; file++, line = 0) {
    const entry = files[file];
    let reason = entry.type !== 'blob' ? 'submodule' : entry.size > git.limits.max_blob_bytes ? 'blob_limit'
      : (input.include_globs.length && !input.include_globs.some(pattern => matchGitPattern(pattern, entry.path)))
        || input.exclude_globs.some(pattern => matchGitPattern(pattern, entry.path)) ? 'path_filter' : '';
    let text = '';
    if (!reason) {
      const raw = (await git.run(['cat-file', 'blob', entry.oid], { max_output: git.limits.max_blob_bytes })).stdout;
      if (raw.includes(0)) reason = 'binary';
      else try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { reason = 'invalid_utf8'; }
    }
    if (reason) {
      exclusions.push({ path: entry.path, reason }); excluded++;
      if (exclusions.length === 500) { file++; line = 0; break; }
      continue;
    }
    const lines = text.split('\n');
    for (; line < lines.length; line++) {
      const content = lines[line];
      const column = (input.case_sensitive ? content : content.toLowerCase()).indexOf(input.case_sensitive ? input.query : input.query.toLowerCase());
      if (column < 0) continue;
      matches.push({ path: entry.path, line: line + 1, column: Array.from(content.slice(0, column)).length + 1,
        preview: content.slice(0, 2000), preview_truncated: content.length > 2000, blob_oid: entry.oid });
      if (matches.length === input.max_results) { line++; break; }
    }
    if (matches.length === input.max_results) { if (line >= lines.length) { file++; line = 0; } break; }
  }
  const next = file < files.length ? Buffer.from(JSON.stringify({ file, line, query: queryDigest, excluded })).toString('base64url') : null;
  return { version: 1, repo_id: repoId, commit_oid: input.commit_oid, matches, scanned_files: file - excluded,
    total_files: files.length, excluded_files: excluded, exclusions, next_cursor: next, enumeration_complete: true };
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
