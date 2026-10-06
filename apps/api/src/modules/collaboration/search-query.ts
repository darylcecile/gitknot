import { getRepository, sha256 } from '@gitknot/core';
import type { AppContext, Repository } from '@gitknot/core';
import { coverageSource, globalPage, repositoryDenied, withinReadBudget } from './global-read.ts';
import type { GlobalReference } from './global-read-schema.ts';

interface SearchInput { query: string; expression: string; repo_ids: string[]; kind?: string; state?: string; limit: number; cursor: string | null }
interface SearchHit extends Record<string, unknown> { id: string; repo_id: string; item_id: string }

/** Source authorization precedes literal matching; stale/missing indexes never hide current source rows. */
export async function searchAuthorized(c: AppContext, input: SearchInput) {
  const terms = input.query.trim().split(/\s+/).filter(Boolean);
  return globalPage<SearchHit>(c, { surface: 'search', filters: { repo_ids: input.repo_ids,
    kind: input.kind as 'issue' | 'pull_request' | 'discussion' | 'task' | 'comment' | undefined, state: input.state },
  terms, parameters: { query: input.query }, limit: input.limit, cursor: input.cursor, prefix: 's1.' }, async (source, candidate) => {
    if (!source.search?.matches || input.state && source.item.state !== input.state) return null;
    const { examined_bytes: _examined, matches: _matches, ...snippet } = source.search;
    return { id: candidate.id, repo_id: candidate.repo_id, item_id: candidate.item_id, kind: candidate.kind,
      title: source.item.title, state: source.item.state, revision: source.source_revision, ...snippet,
      indexed_at: source.index?.indexed_at ?? null, source: 'current_authority' };
  });
}

function indexCurrent(source: GlobalReference, kind: string): boolean {
  return source.index_available && source.index !== null && source.index.revision === source.source_revision
    && source.index.kind === kind && source.index.policy_revision === source.policy_revision;
}

async function repositoryCoverage(c: AppContext, repo: Repository, budget: number): Promise<Record<string, unknown>> {
  const deadline = performance.now() + budget;
  const cursor = c.req.path.endsWith('/search/coverage') ? c.req.query('cursor') ?? null : null;
  const before = await withinReadBudget(deadline, coverageSource(c, repo.id));
  let sourceDigest = '', indexDigest = '', sourceCount = 0, indexCount = 0;
  let sourceAt = repo.created_at, indexedAt: string | null = null, current = true, indexAvailable = true;
  const scanned = await globalPage(c, { surface: 'search', filters: { repo_ids: [repo.id] }, terms: [],
    parameters: { coverage: true }, limit: 200, cursor, budget_ms: Math.max(0, Math.floor(deadline - performance.now())) }, async (source, candidate) => {
    sourceCount++;
    sourceDigest = await sha256(`${sourceDigest}\n${JSON.stringify([candidate.id, source.source_revision])}`);
    if (source.source_updated_at > sourceAt) sourceAt = source.source_updated_at;
    indexAvailable &&= source.index_available;
    if (source.index) {
      indexCount++;
      indexDigest = await sha256(`${indexDigest}\n${JSON.stringify([source.index.id, source.index.revision])}`);
      if (!indexedAt || source.index.indexed_at > indexedAt) indexedAt = source.index.indexed_at;
    }
    current &&= indexCurrent(source, candidate.kind);
    return null;
  });
  const after = await withinReadBudget(deadline, coverageSource(c, repo.id));
  const stable = before.revision === after.revision && before.policy_revision === after.policy_revision && before.watermark === after.watermark;
  const indexState = after.index_state;
  const projectionCurrent = after.index_available && indexState?.state === 'complete'
    && indexState.revision >= after.watermark && indexState.policy_revision === after.policy_revision;
  const countsComplete = stable && scanned.source_coverage.complete && cursor === null;
  const unknown = !stable || !indexAvailable || !after.index_available || scanned.source_coverage.status === 'unknown';
  const verified = countsComplete && current && projectionCurrent;
  return { repo_id: repo.id, source_revision: sourceDigest || await sha256(''), indexed_revision: indexDigest || await sha256(''),
    revision_scope: 'authorized_documents', policy_revision: after.policy_revision, source_updated_at: sourceAt, indexed_at: indexedAt,
    authoritative_documents: sourceCount, indexed_documents: indexCount, counts_complete: countsComplete,
    count_scope: cursor ? 'continuation_window' : countsComplete ? 'authorized_repository' : 'scanned_prefix',
    current: verified ? true : unknown || !countsComplete ? null : false, status: unknown ? 'unknown' : verified ? 'complete' : 'partial',
    next_cursor: scanned.next_cursor, source_scan: scanned.source_coverage };
}

/** Bounded, viewer-scoped coverage. Unavailable authorities produce unknowns, never zero-document success. */
export async function authorizedSearchCoverage(c: AppContext, repos: Repository[]): Promise<{
  complete: boolean; status: 'complete' | 'partial' | 'unknown'; repositories: Record<string, unknown>[];
}> {
  const repositories: Record<string, unknown>[] = [];
  const deadline = performance.now() + 5000;
  for (const original of repos) {
    try {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) throw new Error('coverage budget');
      const repo = await withinReadBudget(deadline, getRepository(c, original.id));
      repositories.push(await repositoryCoverage(c, repo, remaining));
    } catch (error) {
      if (repositoryDenied(error)) throw error;
      repositories.push({ repo_id: original.id, current: null, status: 'unknown', counts_complete: false,
        authoritative_documents: null, indexed_documents: null, reason: 'source_unavailable_or_changed' });
    }
  }
  const complete = repositories.length > 0 && repositories.every(row => row.current === true);
  return { complete, status: complete ? 'complete' : !repositories.length || repositories.some(row => row.status === 'unknown') ? 'unknown' : 'partial', repositories };
}
