import { z } from 'zod';
import { DEFAULT_GIT_LIMITS, INTERNAL_REFS, ZERO_OID } from './types.ts';
import type { GitCheckExpression, GitLimits, GitRule, RefUpdate } from './types.ts';
import { GitError, requireValue } from './errors.ts';

const patterns = z.array(z.string().min(1).max(512)).max(100);
const strategy = z.enum(['merge', 'squash', 'rebase', 'ff-only']);

const checkExpression: z.ZodType<GitCheckExpression> = z.lazy(() => z.union([
  z.object({ type: z.literal('check'), key: z.string().min(1).max(128), producers: z.array(z.string().max(128)).min(1).max(100),
    workflow_digest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    paths: z.object({ include: patterns, exclude: patterns }).strict().optional() }).strict(),
  z.object({ type: z.enum(['all', 'any']), checks: z.array(checkExpression).min(1).max(64) }).strict(),
]));

export const gitCheckExpressionSchema = checkExpression.refine(value => {
  let leaves = 0;
  const walk = (node: GitCheckExpression, depth: number): boolean => depth <= 8 && (node.type === 'check' ? ++leaves <= 64 : node.checks.every(child => walk(child, depth + 1)));
  return walk(value, 1);
}, 'Verification expressions allow at most 8 levels and 64 leaves.');

export const gitRuleSchema = z.object({
  version: z.literal(1).default(1),
  id: z.string().max(128).optional(),
  target: z.union([z.string().min(1).max(512), patterns.min(1)]),
  updates: z.enum(['any', 'pull_request_only', 'blocked']).optional(),
  history: z.object({
    allow_force_push: z.boolean().optional(), allow_deletion: z.boolean().optional(),
    allow_creation: z.boolean().optional(), linear: z.boolean().optional(),
  }).strict().optional(),
  files: z.object({
    denied_paths: patterns.optional(), allowed_paths: patterns.optional(),
    max_bytes: z.number().int().positive().optional(), block_secrets: z.boolean().optional(),
    secret_literals: z.array(z.string().min(4).max(256)).max(100).optional(),
    inspect_all_supplied_objects: z.boolean().optional(),
  }).strict().optional(),
  signatures: z.object({
    commits: z.boolean().optional(), tags: z.boolean().optional(), annotated_tags: z.boolean().optional(),
  }).strict().optional(),
  reviews: z.object({
    minimum: z.number().int().min(0).max(100).optional(),
    disallow_author_approval: z.boolean().optional(), resolved_threads: z.boolean().optional(),
    required_owners: z.record(z.string().max(512), z.array(z.string().max(128)).max(100)).optional(),
    required_reviewers: z.array(z.string().min(1).max(128)).max(100).optional(),
  }).strict().optional(),
  verification: z.object({
    required: z.array(z.string().min(1).max(128)).max(100),
    revision: z.literal('merge_candidate').optional(), trusted_producers: z.array(z.string().max(128)).max(100).optional(),
    expression: gitCheckExpressionSchema.optional(),
  }).strict().optional(),
  merge_strategies: z.array(strategy).min(1).max(4).optional(),
  push: z.object({ allowed_principals: z.array(z.string().min(1).max(128)).min(1).max(100) }).strict().optional(),
  bypass: z.object({ capability: z.literal('rules.break_glass'), reason_required: z.literal(true), maximum_duration_seconds: z.number().int().min(1).max(1800) }).strict().optional(),
}).strict();

/** Bounded glob matching. '*' stays within a segment; '**' also crosses '/'. */
export function matchGitPattern(pattern: string, value: string): boolean {
  if (pattern.length > 512 || value.length > 4096) return false;
  const tokens = pattern.match(/\*\*\/|\*\*|\*|\?|[^*?]/gu) ?? [];
  let previous = new Uint8Array(value.length + 1);
  previous[0] = 1;
  for (const token of tokens) {
    const next = new Uint8Array(value.length + 1);
    let prefixMatched = previous[0] === 1;
    const star = token.startsWith('*');
    if (star) next[0] = previous[0];
    for (let i = 1; i <= value.length; i++) {
      if (token === '**/') {
        // '**/' can consume nothing, or any prefix ending in '/'.
        next[i] = previous[i] || (value[i - 1] === '/' && prefixMatched) ? 1 : 0;
      } else if (star) {
        next[i] = previous[i] || (next[i - 1] && (token === '**' || value[i - 1] !== '/')) ? 1 : 0;
      } else {
        next[i] = previous[i - 1] && (token === '?' ? value[i - 1] !== '/' : token === value[i - 1]) ? 1 : 0;
      }
      prefixMatched ||= previous[i] === 1;
    }
    previous = next;
  }
  return previous[value.length] === 1;
}

export function rulesForRef(rules: GitRule[], ref: string): GitRule[] {
  return rules.filter(rule => (Array.isArray(rule.target) ? rule.target : [rule.target]).some(pattern => matchGitPattern(pattern, ref)));
}

export function validateRef(ref: string, internal = false): void {
  requireValue(ref.length <= 1024 && ref.startsWith('refs/') && !/[\x00-\x20\x7f~^:?*\[\\]/u.test(ref), 'invalid_ref', 'Invalid full Git ref name.');
  requireValue(!ref.includes('..') && !ref.includes('@{') && !ref.endsWith('.') && !ref.endsWith('/'), 'invalid_ref', 'Invalid full Git ref name.');
  requireValue(ref.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock')), 'invalid_ref', 'Invalid full Git ref name.');
  requireValue(internal || !ref.startsWith(INTERNAL_REFS), 'reserved_ref', 'This ref namespace is reserved.');
}

export function validateOid(oid: string, allowZero = true): void {
  requireValue(/^[a-f0-9]{40}$/u.test(oid) && (allowZero || oid !== ZERO_OID), 'invalid_oid', 'Expected a full SHA-1 Git object ID.');
}

export function validateUpdates(updates: RefUpdate[], max: number, internal = false): void {
  requireValue(updates.length > 0 && updates.length <= max, 'ref_limit', 'The number of ref updates exceeds this repository limit.');
  const refs = new Set<string>();
  for (const update of updates) {
    validateRef(update.ref, internal);
    validateOid(update.old_oid);
    validateOid(update.new_oid);
    requireValue(!refs.has(update.ref) && update.old_oid !== update.new_oid, 'invalid_updates', 'Ref updates must be unique and change an OID.');
    refs.add(update.ref);
  }
}

export function validatePath(path: string): void {
  requireValue(path.length > 0 && path.length <= 4096 && !/[\x00-\x1f\x7f\\]/u.test(path), 'invalid_path', 'Invalid repository-relative path.');
  requireValue(path.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git'), 'invalid_path', 'Invalid repository-relative path.');
}

export function checkPaths(rules: GitRule[], paths: string[]): void {
  for (const rule of rules) {
    for (const path of paths) {
      if (rule.files?.denied_paths?.some(pattern => matchGitPattern(pattern, path))) {
        throw new GitError('path_denied', `Repository policy does not allow changes to ${path.slice(0, 160)}.`);
      }
      if (rule.files?.allowed_paths && !rule.files.allowed_paths.some(pattern => matchGitPattern(pattern, path))) {
        throw new GitError('path_scope', `The path ${path.slice(0, 160)} is outside the permitted write scope.`);
      }
    }
  }
}

export function readGitLimits(json?: string): GitLimits {
  if (!json) return { ...DEFAULT_GIT_LIMITS };
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new GitError('invalid_limits', 'Git limits configuration is invalid.', 503); }
  const source = parsed as { git?: Partial<GitLimits> };
  const limits = { ...DEFAULT_GIT_LIMITS, ...(source.git ?? {}) };
  for (const [key, value] of Object.entries(limits)) {
    requireValue(key in DEFAULT_GIT_LIMITS && Number.isSafeInteger(value) && value > 0, 'invalid_limits', 'Git limits configuration is invalid.', 503);
  }
  return limits;
}
