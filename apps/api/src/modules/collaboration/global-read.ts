import { z } from 'zod';
import { ApiError, base64url, fromBase64url, getRepository, identityDatabase, one, readBounded, resolveRepositoryPlacement, sha256, signInternalRequest } from '@gitknot/core';
import type { AppContext, Repository } from '@gitknot/core';
import { cellService, routingBindings } from '../../../../../packages/core/src/routing/cells.ts';
import { readLocalCollaboration } from './global-read-source.ts';
import {
  candidateSchema, filtersSchema, globalContentBudget, globalReadPath, globalReadRounds, globalReadScope, globalWindowSize,
  keyOf, keySchema, mergeWindows, privateReadSchema, referenceReplySchema, windowResponseSchema,
} from './global-read-schema.ts';
import type { GlobalCandidate, GlobalFilters, GlobalKey, GlobalReference, GlobalSurface, PrivateRead, WindowResponse } from './global-read-schema.ts';
import { identifier, notFound, timestamp } from './common.ts';
import type { Item } from './common.ts';
import { activityVisible } from './user-state.ts';

const cursorSchema = z.strictObject({ version: z.literal(2), scope: z.string(), topology: z.string(), as_of: timestamp,
  after: keySchema.nullable(), expires: z.number().int(), padding: z.string().max(2048) });
export type GlobalCursor = Omit<z.infer<typeof cursorSchema>, 'padding'>;
export interface SourceCoverage { status: 'complete' | 'partial' | 'unknown'; complete: boolean; topology_complete: boolean; reason: string | null }
export interface GlobalPage<T> { items: T[]; next_cursor: string | null; source_coverage: SourceCoverage }
const readDeadline = 10_000;
const privateReadBytes = 4 * 1024 * 1024;

/** These operations are reads; a timed-out result is discarded, never published as empty coverage. */
export async function withinReadBudget<T>(deadline: number, work: Promise<T>): Promise<T> {
  const remaining = deadline - performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ApiError(503, 'collaboration_read_budget', 'The bounded collaboration read needs another page.')), Math.max(0, remaining));
    })]);
  } finally { clearTimeout(timer); }
}

export function repositoryDenied(error: unknown): boolean {
  return error instanceof ApiError && [401, 403, 404, 410].includes(error.status);
}

async function privateRead<S extends z.ZodType>(c: AppContext, input: PrivateRead, schema: S): Promise<z.infer<S>> {
  const parsed = privateReadSchema.parse(input);
  let result: unknown;
  if (parsed.cell_id === c.env.CELL_ID) result = await readLocalCollaboration(c.env, parsed);
  else {
    const request = new Request(`https://internal.gitknot.com${globalReadPath}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(parsed), signal: AbortSignal.timeout(3000) });
    let response: Response;
    try { response = await cellService(c.env, parsed.cell_id).fetch(await signInternalRequest(request, c.env.INTERNAL_SERVICE_KEY, globalReadScope)); }
    catch { throw new ApiError(503, 'collaboration_read_unavailable', 'A collaboration source is temporarily unavailable.'); }
    let body: { result?: unknown };
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(response.body, privateReadBytes))) as typeof body; }
    catch { throw new ApiError(503, 'collaboration_read_unavailable', 'A collaboration source returned an incomplete response.'); }
    if (!response.ok) throw new ApiError(response.status === 409 ? 409 : 503,
      response.status === 409 ? 'collaboration_placement_changed' : 'collaboration_read_unavailable', 'The current collaboration source could not be confirmed.');
    if (!Object.hasOwn(body, 'result')) throw new ApiError(503, 'collaboration_read_unavailable', 'The collaboration source returned no receipt.');
    result = body.result;
  }
  const value = schema.safeParse(result);
  if (!value.success) throw new ApiError(503, 'collaboration_read_invalid', 'The collaboration source returned unverifiable data.');
  return value.data;
}

function configuredCells(c: AppContext): string[] {
  return [...new Set([c.env.CELL_ID, ...Object.keys(routingBindings(c.env.CELL_BINDINGS_JSON, 32))])].sort();
}

async function sourceWindow(c: AppContext, surface: GlobalSurface, filters: GlobalFilters, cursor: GlobalCursor, deadline: number): Promise<{
  candidates: GlobalCandidate[]; more: boolean; topology: string;
}> {
  const registry = configuredCells(c);
  let cells = registry;
  if (filters.repo_ids.length) {
    const selected = new Set<string>();
    for (const id of filters.repo_ids) selected.add((await getRepository(c, id)).cell_id);
    if ([...selected].some(cell => !registry.includes(cell))) throw new ApiError(503, 'collaboration_read_unavailable', 'A repository placement is not configured.');
    cells = [...selected].sort();
  }
  const receipts: WindowResponse[] = [];
  for (let start = 0; start < cells.length; start += 8) {
    if (performance.now() >= deadline) throw new ApiError(503, 'collaboration_read_budget', 'The source discovery budget was reached.');
    const next = await Promise.all(cells.slice(start, start + 8).map(cell_id => privateRead(c, {
      version: 1, action: 'window', cell_id, surface, filters, as_of: cursor.as_of, after: cursor.after,
    }, windowResponseSchema)));
    if (next.some((value, index) => value.cell_id !== cells[start + index])) throw new ApiError(503, 'collaboration_read_invalid', 'A source returned another cell’s data.');
    receipts.push(...next);
  }
  const topology = await sha256(JSON.stringify({ registry,
    shards: filters.repo_ids.length ? 'current_explicit_repository_placements' : receipts.map(value => [value.cell_id, value.shards]) }));
  if (cursor.topology && cursor.topology !== topology) throw new ApiError(409, 'collaboration_cursor_topology_changed', 'The configured source set changed. Restart this listing.');
  const candidates = mergeWindows(receipts.map(value => value.candidates), surface);
  return { candidates, more: candidates.length > globalWindowSize || receipts.some(value => value.more), topology };
}

async function cursorKey(c: AppContext): Promise<CryptoKey> {
  if (typeof c.env.INTERNAL_SERVICE_KEY !== 'string' || c.env.INTERNAL_SERVICE_KEY.length < 32) throw new ApiError(503, 'pagination_unavailable', 'Collaboration pagination is unavailable.');
  const material = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`GitKnot collaboration cursor v2\n${c.env.INTERNAL_SERVICE_KEY}`));
  return crypto.subtle.importKey('raw', material, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encodeGlobalCursor(c: AppContext, value: GlobalCursor, prefix = 'g1.'): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = { ...value, padding: '' };
  // A private scan boundary must not reveal even its resource-ID length.
  plain.padding = ' '.repeat(Math.max(0, 1024 - new TextEncoder().encode(JSON.stringify(plain)).byteLength));
  const bytes = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cursorKey(c), new TextEncoder().encode(JSON.stringify(plain))));
  const packed = new Uint8Array(iv.length + bytes.length); packed.set(iv); packed.set(bytes, iv.length);
  return prefix + base64url(packed);
}

export async function decodeGlobalCursor(c: AppContext, scope: string, cursor: string | null, prefix = 'g1.'): Promise<GlobalCursor> {
  if (!cursor) return { version: 2, scope, topology: '', as_of: new Date().toISOString(), after: null, expires: Date.now() + 3600_000 };
  const key = await cursorKey(c);
  try {
    if (!cursor.startsWith(prefix) || cursor.length > 8192) throw new Error('cursor version');
    const bytes = fromBase64url(cursor.slice(prefix.length));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
    const { padding: _padding, ...value } = cursorSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)));
    if (value.scope !== scope || value.expires <= Date.now()) throw new Error('cursor scope');
    return value;
  } catch { throw new ApiError(422, 'invalid_cursor', 'This cursor is invalid, expired or belongs to another authorized view.'); }
}

export async function globalScope(c: AppContext, input: unknown): Promise<string> {
  const principal = c.get('principal');
  return sha256(JSON.stringify({ input, principal: principal ? [principal.id, principal.credential_id,
    principal.capabilities === null ? null : [...principal.capabilities].sort(),
    principal.repository_ids === null ? null : [...principal.repository_ids].sort(),
    principal.account_ids === null ? null : [...principal.account_ids].sort()] : null }));
}

interface DiscoveryEligibility { filters: GlobalFilters; surface: GlobalSurface; reference?: GlobalReference }

/** A discovery hint grants neither listing eligibility nor current owner/profile visibility. */
async function currentAuthorityEligible(c: AppContext, repo: Repository, request: DiscoveryEligibility): Promise<boolean> {
  const { filters, reference, surface } = request;
  if (filters.repo_ids.length ? !filters.repo_ids.includes(repo.id) : repo.visibility === 'unlisted') return false;
  if (filters.public_only && repo.visibility !== 'public') return false;
  if (!reference) return true;
  const kind = surface === 'search' && reference.comment ? 'comment' : reference.item.kind;
  if (filters.kind && kind !== filters.kind || filters.state && surface !== 'inbox' && reference.item.state !== filters.state) return false;
  if (surface === 'inbox' && filters.user_id && reference.notification?.user_id !== filters.user_id) return false;
  if (surface !== 'feed') return true;
  const actorId = reference.activity?.actor_id;
  if (!actorId || filters.actor_id && actorId !== filters.actor_id) return false;
  const actor = await one<{ user_id: string | null }>(identityDatabase(c), 'SELECT user_id FROM principals WHERE id=? AND disabled_at IS NULL', actorId);
  return !!actor && (!actor.user_id || await activityVisible(c, actor.user_id));
}

async function authorizeAudience(c: AppContext, candidate: GlobalCandidate, request?: DiscoveryEligibility): Promise<Repository> {
  // getRepository resolves current placement and owner grants; the window's
  // copied repository row is never an authorization or discovery authority.
  const repo = await getRepository(c, candidate.repo_id);
  if (request && !await currentAuthorityEligible(c, repo, request)) notFound();
  if (candidate.head_repo_id && candidate.head_repo_id !== repo.id) await getRepository(c, candidate.head_repo_id);
  if (candidate.workspace_repo_id) await getRepository(c, candidate.workspace_repo_id, 'repositories.read');
  return repo;
}

/** Always resolves the current repository placement; copied source rows are discovery hints only. */
export async function readGlobalReference(c: AppContext, original: GlobalCandidate, surface: GlobalSurface,
  options: { user_id?: string; terms?: string[]; include_markdown?: boolean; filters?: GlobalFilters } = {}): Promise<GlobalReference | null> {
  let candidate = original;
  const eligibility = options.filters ? { filters: options.filters, surface } : undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const repo = await authorizeAudience(c, candidate, eligibility);
      const placement = await resolveRepositoryPlacement(c.env, repo.id);
      if (!placement || placement.epoch !== repo.routing_epoch) throw new ApiError(409, 'collaboration_placement_changed', 'The repository moved while reading.');
      const value = await privateRead(c, { version: 1, action: 'reference', repo_id: repo.id, cell_id: placement.cell_id,
        shard_id: placement.shard_id, epoch: placement.epoch, surface, candidate, terms: options.terms ?? [],
        include_markdown: options.include_markdown ?? false, ...(options.user_id ? { user_id: options.user_id } : {}) }, referenceReplySchema);
      if (!value) return null;
      if ('changed' in value) {
        if (value.candidate.id !== original.id || value.candidate.repo_id !== original.repo_id
          || value.candidate.item_id !== original.item_id || value.candidate.resource_id !== original.resource_id) {
          throw new ApiError(503, 'collaboration_read_invalid', 'The source changed its immutable reference identity.');
        }
        candidate = value.candidate;
        continue;
      }
      if (value.repo_id !== repo.id || value.item.id !== candidate.item_id || value.epoch !== placement.epoch
        || value.cell_id !== placement.cell_id || value.shard_id !== placement.shard_id
        || value.repository_revision !== repo.revision || value.policy_revision !== repo.policy_revision) {
        throw new ApiError(409, 'collaboration_reference_changed', 'The source changed while reading.');
      }
      if (value.comment && value.comment.state !== 'visible'
        && !(surface !== 'search' && value.comment.state === 'hidden' && value.comment.author_id === c.get('principal')?.id)) return null;
      const current = await authorizeAudience(c, candidate, eligibility ? { ...eligibility, reference: value } : undefined);
      if (current.revision !== value.repository_revision || current.routing_epoch !== value.epoch) continue;
      return value;
    } catch (error) {
      if (repositoryDenied(error)) return null;
      if (!(error instanceof ApiError) || error.status !== 409 || attempt === 1) throw error;
    }
  }
  throw new ApiError(409, 'collaboration_reference_changed', 'The collaboration source changed while reading. Retry this page.');
}

export async function globalPage<T>(c: AppContext, input: {
  surface: GlobalSurface; filters: Partial<GlobalFilters>; parameters?: unknown; limit: number; cursor: string | null; prefix?: string;
  terms?: string[]; include_markdown?: boolean; budget_ms?: number;
}, select: (value: GlobalReference, candidate: GlobalCandidate) => Promise<T | null>): Promise<GlobalPage<T>> {
  const filters = filtersSchema.parse(input.filters);
  filters.repo_ids = [...new Set(filters.repo_ids)].sort();
  const scope = await globalScope(c, { surface: input.surface, filters, parameters: input.parameters, terms: input.terms });
  const position = await decodeGlobalCursor(c, scope, input.cursor, input.prefix);
  const initialAfter = position.after;
  const found: Array<{ value: T; key: GlobalKey; candidate: GlobalCandidate; reference: GlobalReference }> = [];
  const deadline = performance.now() + Math.min(readDeadline, input.budget_ms ?? readDeadline);
  let bytes = 0, complete = false, topologyComplete = false, reason: string | null = 'work_budget';
  let status: SourceCoverage['status'] = 'partial';
  outer: for (let round = 0; round < globalReadRounds; round++) {
    let window: Awaited<ReturnType<typeof sourceWindow>>;
    try { window = await withinReadBudget(deadline, sourceWindow(c, input.surface, filters, position, deadline)); }
    catch (error) {
      if (error instanceof ApiError && error.code === 'collaboration_cursor_topology_changed') throw error;
      status = 'unknown'; reason = 'placement_unavailable'; break;
    }
    position.topology = window.topology; topologyComplete = true;
    const candidates = window.candidates.slice(0, globalWindowSize);
    for (let index = 0; index < candidates.length; index++) {
      if (performance.now() >= deadline || bytes >= globalContentBudget) break outer;
      const candidate = candidates[index]!;
      let reference: GlobalReference | null;
      try { reference = await withinReadBudget(deadline, readGlobalReference(c, candidate, input.surface, {
        user_id: filters.user_id, terms: input.terms, include_markdown: input.include_markdown, filters,
      })); }
      catch { status = 'unknown'; reason = 'source_changed_or_unavailable'; break outer; }
      if (reference) {
        bytes += reference.search?.examined_bytes ?? 0;
        const selected = await select(reference, candidate);
        if (selected !== null) found.push({ value: selected, reference, key: keyOf(candidate), candidate: { ...candidate,
          head_repo_id: reference.head_repo_id, workspace_repo_id: reference.workspace_repo_id, revision: reference.source_revision } });
      }
      position.after = keyOf(candidate);
      if (found.length > input.limit) {
        complete = !window.more && index === candidates.length - 1;
        reason = 'page_limit';
        break outer;
      }
    }
    if (!window.more) { complete = true; break; }
  }
  // Recheck the current audience AND discovery eligibility for every returned
  // row and the lookahead. An unlisted URL can remain readable without being listed.
  const current: typeof found = [];
  const authorizationDeadline = performance.now() + 3000;
  for (const row of found) {
    try {
      await withinReadBudget(authorizationDeadline, authorizeAudience(c, row.candidate, { filters, surface: input.surface, reference: row.reference }));
      current.push(row);
    }
    catch (error) {
      if (!repositoryDenied(error)) {
        status = 'unknown'; reason = 'authorization_unavailable'; complete = false;
        position.after = current.at(-1)?.key ?? initialAfter;
        break;
      }
    }
  }
  if (complete && status !== 'unknown') { status = 'complete'; reason = null; }
  const hasMore = current.length > input.limit || !complete;
  const after = current.length > input.limit ? current[input.limit - 1]!.key : position.after;
  return { items: current.slice(0, input.limit).map(row => row.value), next_cursor: hasMore
    ? await encodeGlobalCursor(c, { ...position, after }, input.prefix) : null,
    source_coverage: { status, complete: status === 'complete', topology_complete: topologyComplete, reason } };
}

export async function readGlobalItem(c: AppContext, repoId: string, itemId: string, includeMarkdown = false): Promise<GlobalReference> {
  const repo = await getRepository(c, repoId);
  const placement = await resolveRepositoryPlacement(c.env, repoId);
  if (!placement) notFound();
  const candidate = await privateRead(c, { version: 1, action: 'subject', repo_id: repoId, cell_id: placement.cell_id,
    shard_id: placement.shard_id, epoch: placement.epoch, id: itemId }, candidateSchema.nullable());
  if (!candidate) notFound();
  if (repo.routing_epoch !== placement.epoch) throw new ApiError(409, 'collaboration_placement_changed', 'The source moved. Retry the request.');
  const value = await readGlobalReference(c, candidate, 'search', { include_markdown: includeMarkdown });
  if (!value) notFound();
  return value;
}

export async function readGlobalInbox(c: AppContext, userId: string, id: string, includeMarkdown = false, repositoryHint?: string): Promise<GlobalReference | null> {
  const found: GlobalCandidate[] = [];
  let cells = configuredCells(c);
  if (repositoryHint) {
    try { cells = [(await getRepository(c, repositoryHint)).cell_id]; }
    catch (error) { if (repositoryDenied(error)) return null; throw error; }
  }
  for (let start = 0; start < cells.length; start += 8) {
    const values = await Promise.all(cells.slice(start, start + 8).map(cell_id => privateRead(c,
      { version: 1, action: 'inbox-locate', cell_id, user_id: userId, id }, candidateSchema.array().max(1))));
    found.push(...values.flat());
  }
  const candidates = mergeWindows([found], 'inbox');
  if (!candidates.length) return null;
  if (repositoryHint && candidates[0]!.repo_id !== repositoryHint) return null;
  return readGlobalReference(c, candidates[0]!, 'inbox', { user_id: userId, include_markdown: includeMarkdown });
}

export async function globalCatalogReference(c: AppContext, repoId: string, table: 'labels' | 'milestones', id: string): Promise<void> {
  await getRepository(c, repoId);
  const placement = await resolveRepositoryPlacement(c.env, repoId);
  if (!placement) notFound();
  const value = await privateRead(c, { version: 1, action: 'catalog', repo_id: repoId, cell_id: placement.cell_id,
    shard_id: placement.shard_id, epoch: placement.epoch, table, id }, z.object({ id: identifier, repo_id: identifier, revision: z.number().int().positive() }).nullable());
  if (!value || value.id !== id || value.repo_id !== repoId) notFound();
}

export async function projectionReferenceVisible(c: AppContext, item: Pick<Item, 'repo_id' | 'id'>, resourceId: string): Promise<boolean> {
  try {
    await readGlobalItem(c, item.repo_id, item.id);
    const placement = await resolveRepositoryPlacement(c.env, item.repo_id);
    if (!placement) return false;
    const value = await privateRead(c, { version: 1, action: 'resource', repo_id: item.repo_id, cell_id: placement.cell_id,
      shard_id: placement.shard_id, epoch: placement.epoch, item_id: item.id, id: resourceId }, z.object({
      head_repo_id: identifier.nullable(), workspace_repo_id: identifier.nullable(),
      comment: z.object({ state: z.string(), author_id: identifier }).nullable(),
    }).nullable());
    if (!value) return false;
    if (value.head_repo_id) await getRepository(c, value.head_repo_id);
    if (value.workspace_repo_id) await getRepository(c, value.workspace_repo_id, 'repositories.read');
    return !value.comment || value.comment.state === 'visible' || value.comment.state === 'hidden' && value.comment.author_id === c.get('principal')?.id;
  } catch (error) { if (repositoryDenied(error)) return false; throw error; }
}

const coverageSourceSchema = z.object({ revision: z.number().int().positive(), policy_revision: z.number().int().positive(), watermark: z.number().int().nonnegative(),
  index_available: z.boolean(), index_state: z.object({ revision: z.number().int(), policy_revision: z.number().int(), state: z.string() }).nullable() });
export async function coverageSource(c: AppContext, repoId: string): Promise<z.infer<typeof coverageSourceSchema>> {
  await getRepository(c, repoId);
  const placement = await resolveRepositoryPlacement(c.env, repoId);
  if (!placement) notFound();
  return privateRead(c, { version: 1, action: 'coverage-source', repo_id: repoId, cell_id: placement.cell_id,
    shard_id: placement.shard_id, epoch: placement.epoch }, coverageSourceSchema);
}
