import { z } from 'zod';
import { ApiError, readBounded, requirePrincipal, signInternalRequest } from '@gitknot/core';
import type { AppContext } from '@gitknot/core';
import type { GitMutation } from '@gitknot/git';
import { gitPath, identifier, oid } from './common.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const patchFileSchema = z.strictObject({
  path: gitPath, old_path: gitPath.nullable(),
  change_kind: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'type_changed']),
  old_oid: oid.nullable(), new_oid: oid.nullable(), patch_fingerprint: digest,
  old_lines: z.number().int().nonnegative(), new_lines: z.number().int().nonnegative(), binary: z.boolean(),
  hunks: z.array(z.strictObject({ old_start: z.number().int().nonnegative(), old_lines: z.number().int().nonnegative(),
    new_start: z.number().int().nonnegative(), new_lines: z.number().int().nonnegative() })).max(10000),
});
export const patchInspectionSchema = z.strictObject({
  version: z.literal(1), repo_id: identifier, head_repo_id: identifier, base_oid: oid, head_oid: oid,
  fingerprint_algorithm: z.literal('git-patch-id-verbatim-v1'),
  merge_base_oid: oid, patch_fingerprint: digest, native_evidence_id: identifier,
  complete: z.literal(true), files: z.array(patchFileSchema).max(10000),
});
export type NativePatch = z.infer<typeof patchInspectionSchema>;
export type NativePatchFile = z.infer<typeof patchFileSchema>;

export const scanRequestSchema = z.strictObject({
  kind: z.literal('scan'), commit_oid: oid, query: z.string().min(1).max(512).refine(value => !/[\r\n\0]/.test(value)),
  case_sensitive: z.boolean(), include_globs: z.array(z.string().min(1).max(256)).max(50),
  exclude_globs: z.array(z.string().min(1).max(256)).max(50), cursor: z.string().max(8192).nullable(),
  max_results: z.number().int().min(1).max(1000).default(500),
});
export const scanPageSchema = z.strictObject({
  version: z.literal(1), repo_id: identifier, commit_oid: oid,
  matches: z.array(z.strictObject({ path: gitPath, line: z.number().int().positive(), column: z.number().int().positive(),
    preview: z.string().max(2000), preview_truncated: z.boolean(), blob_oid: oid })).max(1000),
  scanned_files: z.number().int().nonnegative(), total_files: z.number().int().nonnegative(),
  excluded_files: z.number().int().nonnegative(),
  exclusions: z.array(z.strictObject({ path: gitPath, reason: z.enum(['binary', 'submodule', 'path_filter', 'blob_limit', 'invalid_utf8']) })).max(500),
  next_cursor: z.string().max(8192).nullable(), enumeration_complete: z.literal(true),
});
export type NativeScanPage = z.infer<typeof scanPageSchema>;

export const suggestionInspectionSchema = z.strictObject({ repo_id: identifier, head_oid: oid,
  edit: z.strictObject({ path: gitPath, content_base64: z.string().max(2_000_000), mode: z.enum(['100644', '100755']) }) });

export const restackMutationSchema = z.strictObject({ kind: z.literal('restack'), ref: z.string(), expected_oid: oid,
  old_base_oid: oid, onto_oid: oid, onto_repo_id: identifier, pull_request_id: identifier });

export const inspectionRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('patch'), head_repo_id: identifier, base_oid: oid, head_oid: oid }),
  z.strictObject({ kind: z.literal('diff'), head_repo_id: identifier, base_oid: oid, head_oid: oid,
    pull_id: identifier.optional(), from_patch_id: identifier.nullable().optional(), to_patch_id: identifier.optional() }),
  scanRequestSchema,
  z.strictObject({ kind: z.literal('suggestion'), head_oid: oid, path: gitPath, start_line: z.number().int().positive(),
    end_line: z.number().int().positive(), replacement: z.string().max(500_000) }),
  z.strictObject({ kind: z.literal('resolve'), ref: z.string().min(1).max(1024) }),
]);
export type NativeInspection = z.infer<typeof inspectionRequestSchema>;

export const nativeOperationSchema = z.object({
  id: z.string().optional(), operation_id: z.string().optional(),
  state: z.enum(['receiving', 'validated', 'publishing', 'uncertain', 'committed', 'rejected']),
  finalized: z.boolean(),
  result: z.object({ outcome: z.enum(['committed', 'rejected', 'uncertain']), operation_id: z.string(),
    refs: z.array(z.object({ ref: z.string(), old_oid: oid, new_oid: oid })),
    marker_oid: oid.nullable(), report_status: z.array(z.object({ ref: z.string(), status: z.string() })),
  }).nullable().optional(),
  error: z.object({ code: z.string(), message: z.string().optional() }).nullable().optional(),
});
export type NativeOperation = z.infer<typeof nativeOperationSchema>;

export async function nativeJSON<S extends z.ZodType>(c: AppContext, repoId: string, suffix: string, schema: S, payload?: unknown): Promise<z.infer<S>> {
  if (!c.env.GIT_SERVICE?.fetch) throw new ApiError(503, 'git_service_unavailable', 'Git processing is temporarily unavailable.');
  const request = new Request(`https://internal.gitknot.com/internal/git/repositories/${encodeURIComponent(repoId)}/${suffix}`, {
    method: payload === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(180_000),
  });
  const response = await c.env.GIT_SERVICE.fetch(await signInternalRequest(request, c.env.INTERNAL_SERVICE_KEY, 'git-service'));
  const bytes = await readBounded(response.body, 4 * 1024 * 1024);
  let body: unknown;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ApiError(503, 'git_result_unavailable', 'Git processing returned an unreadable result. The operation can be retried.'); }
  if (!response.ok) {
    const result = z.object({ error: z.object({ code: z.string() }) }).safeParse(body);
    const code = result.success ? result.data.error.code : '';
    const known: Record<string, string> = {
      merge_conflict: 'The proposed change has merge conflicts.', stale_ref: 'The branch changed. Refresh the head revision.',
      stale_base: 'The target branch changed. Rebuild this candidate.', object_not_found: 'The requested revision is not available to this repository.',
      ref_not_found: 'The requested Git ref does not exist.',
      git_output_limit: 'This operation exceeds the configured Git processing limit.',
    };
    if (known[code]) throw new ApiError(response.status >= 500 ? 503 : response.status, code, known[code]);
    throw new ApiError(response.status >= 500 || response.status === 404 ? 503 : 409, 'git_operation_unavailable',
      'Git processing could not complete this step. Its durable operation remains available for recovery.');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError(503, 'invalid_git_evidence', 'Git processing did not return complete, verifiable evidence.');
  return parsed.data;
}

export async function inspectPatch(c: AppContext, repoId: string, headRepoId: string, baseOid: string, headOid: string, retain = true, candidateId?: string): Promise<NativePatch> {
  const result = await nativeJSON(c, repoId, 'collaboration/inspect', patchInspectionSchema, {
    actor: c.get('principal'), retain, inspection: { kind: 'patch', head_repo_id: headRepoId, base_oid: baseOid, head_oid: headOid },
    ...(candidateId ? { candidate_id: candidateId } : {}),
  });
  if (result.repo_id !== repoId || result.head_repo_id !== headRepoId || result.base_oid !== baseOid || result.head_oid !== headOid
    || new Set(result.files.map(file => file.path)).size !== result.files.length) {
    throw new ApiError(503, 'git_evidence_mismatch', 'The Git evidence does not belong to the requested revisions.');
  }
  return result;
}

export async function resolveNativeCommit(c: AppContext, repoId: string, ref: string): Promise<string> {
  const value = await nativeJSON(c, repoId, 'collaboration/inspect', z.strictObject({ repo_id: identifier, commit_oid: oid }), {
    actor: c.get('principal'), inspection: { kind: 'resolve', ref },
  });
  if (value.repo_id !== repoId) throw new ApiError(503, 'git_evidence_mismatch', 'The Git revision does not belong to this repository.');
  return value.commit_oid;
}

export async function runNativeMutation(c: AppContext, repoId: string, operationId: string, mutation: GitMutation): Promise<NativeOperation> {
  return nativeJSON(c, repoId, 'mutate', nativeOperationSchema, { operation_id: operationId, actor: requirePrincipal(c), mutation });
}
export async function readNativeOperation(c: AppContext, repoId: string, operationId: string): Promise<NativeOperation> {
  return nativeJSON(c, repoId, `operations/${encodeURIComponent(operationId)}`, nativeOperationSchema);
}
