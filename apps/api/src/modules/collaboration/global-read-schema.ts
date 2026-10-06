import { z } from 'zod';
import { identifier, timestamp } from './common.ts';

export const globalWindowSize = 50;
export const globalReadRounds = 4;
export const globalContentBudget = 8 * 1024 * 1024;
export const globalReadScope = 'collaboration.read';
export const globalReadPath = '/internal/collaboration/read';
const location = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
export const keySchema = z.strictObject({ id: identifier, at: z.string().max(40) });
export type GlobalKey = z.infer<typeof keySchema>;
export const surfaceSchema = z.enum(['search', 'feed', 'inbox']);
export type GlobalSurface = z.infer<typeof surfaceSchema>;
export const filtersSchema = z.strictObject({
  repo_ids: z.array(identifier).max(50).default([]), kind: z.enum(['issue', 'pull_request', 'discussion', 'task', 'comment']).optional(),
  state: z.string().max(30).optional(), actor_id: identifier.optional(), user_id: identifier.optional(),
  public_only: z.boolean().default(false), grouped: z.boolean().default(true),
});
export type GlobalFilters = z.infer<typeof filtersSchema>;
const position = { cell_id: location, shard_id: location, repo_id: identifier, epoch: z.number().int().positive() };
export const candidateSchema = z.strictObject({ id: identifier, repo_id: identifier, item_id: identifier,
  resource_id: identifier, kind: z.string().max(40), revision: z.number().int().positive(),
  created_at: timestamp, head_repo_id: identifier.nullable(), workspace_repo_id: identifier.nullable() });
export type GlobalCandidate = z.infer<typeof candidateSchema>;
export const windowRequestSchema = z.strictObject({ version: z.literal(1), action: z.literal('window'), cell_id: location,
  surface: surfaceSchema, as_of: timestamp, after: keySchema.nullable(), filters: filtersSchema });
export type WindowRequest = z.infer<typeof windowRequestSchema>;
export const referenceRequestSchema = z.strictObject({ version: z.literal(1), action: z.literal('reference'), ...position,
  surface: surfaceSchema, candidate: candidateSchema, terms: z.array(z.string().min(1).max(512)).max(20).default([]),
  user_id: identifier.optional(), include_markdown: z.boolean().default(false) });
export type ReferenceRequest = z.infer<typeof referenceRequestSchema>;
export const privateReadSchema = z.discriminatedUnion('action', [windowRequestSchema, referenceRequestSchema,
  z.strictObject({ version: z.literal(1), action: z.literal('inbox-locate'), cell_id: location, user_id: identifier, id: identifier }),
  z.strictObject({ version: z.literal(1), action: z.literal('subject'), ...position, id: identifier }),
  z.strictObject({ version: z.literal(1), action: z.literal('resource'), ...position, item_id: identifier, id: identifier }),
  z.strictObject({ version: z.literal(1), action: z.literal('catalog'), ...position, table: z.enum(['labels', 'milestones']), id: identifier }),
  z.strictObject({ version: z.literal(1), action: z.literal('coverage-source'), ...position }),
]);
export type PrivateRead = z.infer<typeof privateReadSchema>;
export const windowResponseSchema = z.strictObject({ version: z.literal(1), cell_id: location, shards: z.array(location).max(66),
  candidates: z.array(candidateSchema).max(globalWindowSize + 1), more: z.boolean() });
export type WindowResponse = z.infer<typeof windowResponseSchema>;
export const itemSchema = z.object({ id: identifier, repo_id: identifier, kind: z.enum(['issue', 'pull_request', 'discussion', 'task']),
  number: z.number().int().positive(), title: z.string().max(300), markdown: z.string().max(500_000), author_id: identifier,
  state: z.string().max(40), revision: z.number().int().positive(), document_revision: z.number().int().positive(),
  locked_at: z.string().nullable(), locked_by: z.string().nullable(), deleted_at: z.string().nullable(), created_at: timestamp, updated_at: timestamp });
export const inboxSchema = z.object({ id: identifier, user_id: identifier, repo_id: identifier, item_id: identifier,
  reason: z.enum(['mention', 'assignment', 'review_request', 'task_accountability']), source_id: identifier, source_event_id: identifier,
  state: z.enum(['outstanding', 'completed']), read_at: z.string().nullable(), completed_at: z.string().nullable(), snoozed_until: z.string().nullable(),
  revision: z.number().int().positive(), created_at: timestamp, updated_at: timestamp });
export const activitySchema = z.object({ id: identifier, repo_id: identifier, item_id: identifier, event_type: z.string().max(160),
  actor_id: identifier, actor_kind: z.string().max(40), resource_id: identifier, resource_revision: z.number().int().positive(),
  group_key: z.string().max(600), created_at: timestamp, group_count: z.number().int().nonnegative() });
export const referenceSchema = z.object({ version: z.literal(1), ...position, repository_revision: z.number().int().positive(),
  policy_revision: z.number().int().positive(), item: itemSchema, head_repo_id: identifier.nullable(), workspace_repo_id: identifier.nullable(),
  source_revision: z.number().int().positive(), source_updated_at: timestamp,
  comment: z.object({ state: z.enum(['visible', 'hidden', 'deleted']), author_id: identifier }).nullable(),
  activity: activitySchema.nullable(), notification: inboxSchema.nullable(), action_outstanding: z.boolean().nullable(),
  search: z.object({ matches: z.boolean(), snippet: z.string().max(500), snippet_offset: z.number().int().nonnegative(),
    snippet_truncated: z.boolean(), examined_bytes: z.number().int().nonnegative() }).nullable(),
  index_available: z.boolean(), index: z.object({ id: identifier, kind: z.string(), revision: z.number().int().positive(),
    policy_revision: z.number().int().positive(), indexed_at: timestamp }).nullable(),
});
export type GlobalReference = z.infer<typeof referenceSchema>;
export const referenceReplySchema = z.union([referenceSchema, z.strictObject({ changed: z.literal(true), candidate: candidateSchema }), z.null()]);
export type ReferenceReply = z.infer<typeof referenceReplySchema>;

export function keyOf(row: Pick<GlobalCandidate, 'id' | 'created_at'>): GlobalKey { return { id: row.id, at: row.created_at }; }
export function compareKeys(left: GlobalKey, right: GlobalKey, surface: GlobalSurface): number {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return surface === 'search' ? compare(left.id, right.id) : compare(right.at, left.at) || compare(right.id, left.id);
}

/** Keep one bounded global prefix. Immutable keys survive repository moves. */
export function mergeWindows(rows: GlobalCandidate[][], surface: GlobalSurface): GlobalCandidate[] {
  let prefix: GlobalCandidate[] = [];
  for (const batch of rows) {
    const unique = new Map<string, GlobalCandidate>();
    for (const row of [...prefix, ...batch]) {
      const previous = unique.get(row.id);
      if (!previous || row.revision > previous.revision) unique.set(row.id, row);
    }
    prefix = [...unique.values()].sort((a, b) => compareKeys(keyOf(a), keyOf(b), surface)).slice(0, globalWindowSize + 1);
  }
  return prefix;
}
