import { z } from 'zod';
import {
  ApiError, authorize, database, decodeCursor, encodeCursor, getRepository, jsonBody, listResponse,
  many, newId, now, one, page, readBounded, requirePrincipal, route, sha256, stmt,
} from '@gitknot/core';
import type { App, AppContext, Repository } from '@gitknot/core';
import {
  checkRevision, commit, identifier, nextCursor, notFound, oid,
  pageBindings, pageSql, pagination, respond,
} from './common.ts';
import { prepareOperation, publicOperation } from './operation-model.ts';
import { scanPageSchema } from './native.ts';
import { authorizedSearchCoverage, searchAuthorized } from './search-query.ts';

export interface CodeScan { id: string; principal_id: string; user_id: string | null; operation_id: string; query: string; case_sensitive: number;
  include_globs_json: string; exclude_globs_json: string; state: string; revision: number; expires_at: string; created_at: string; updated_at: string }
interface ScanRepository { scan_id: string; repo_id: string; commit_oid: string; state: string; scanned_files: number;
  total_files: number | null; match_count: number; excluded_files: number; exclusions_json: string; updated_at: string }
interface ScanChunk { id: string; scan_id: string; repo_id: string; sequence: number; object_id: string;
  object_key: string; sha256: string; bytes: number; match_count: number; created_at: string }

const codeScanCreate = z.strictObject({
  repositories: z.array(z.strictObject({ repo_id: identifier, commit_oid: oid })).min(1).max(50),
  query: z.string().min(1).max(512).refine(value => !/[\r\n\0]/.test(value), 'Code scans match a literal query within one line.'),
  case_sensitive: z.boolean().default(false), include_globs: z.array(z.string().min(1).max(256)).max(50).default([]),
  exclude_globs: z.array(z.string().min(1).max(256)).max(50).default([]), retention_days: z.number().int().min(1).max(7).default(1),
}).refine(value => new Set(value.repositories.map(repo => repo.repo_id)).size === value.repositories.length, 'List each repository once.');

function literalFts(query: string): string {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 20) throw new ApiError(422, 'invalid_search_query', 'Use between 1 and 20 search terms.');
  return words.map(word => `"${word.replaceAll('"', '""')}"`).join(' AND ');
}

export const searchCoverage = authorizedSearchCoverage;

export function registerSearchRoutes(app: App): void {
  route(app, 'GET', '/v1/search', { summary: 'Search current authorized collaboration content with explicit index coverage', tags: ['search'], public: true }, async c => {
    const query = c.req.query('q') ?? c.req.query('query') ?? '';
    if (query.length > 512) throw new ApiError(422, 'invalid_search_query', 'Search queries may contain at most 512 characters.');
    const expression = literalFts(query);
    const repoIds = [...new Set([...(c.req.queries('repo_id') ?? []), ...(c.req.query('repo_ids')?.split(',') ?? [])])];
    if (repoIds.length > 50 || repoIds.some(id => !identifier.safeParse(id).success)) throw new ApiError(422, 'invalid_search_scope', 'Search at most 50 explicit repository IDs.');
    const repos: Repository[] = [];
    for (const id of repoIds) repos.push(await getRepository(c, id));
    const kind = c.req.query('kind');
    if (kind && !['issue', 'pull_request', 'discussion', 'task', 'comment'].includes(kind)) throw new ApiError(422, 'invalid_filter', 'Unknown searchable resource kind.');
    const state = c.req.query('state');
    if (state && state.length > 30) throw new ApiError(422, 'invalid_filter', 'Invalid state filter.');
    const { limit, cursor } = page(c);
    const result = await searchAuthorized(c, { query, expression, repo_ids: repoIds, kind, state, limit, cursor });
    const coverage = await searchCoverage(c, repos);
    return c.json({ items: result.items, next_cursor: result.next_cursor,
      query, semantics: 'literal_terms_all', ordering: 'stable_resource_id', snapshot_mode: 'created_before_cursor_live_authorized',
      coverage: { ...coverage, complete: coverage.complete && result.source_coverage.status !== 'unknown',
        status: result.source_coverage.status === 'unknown' ? 'unknown' : coverage.status,
        source_scan: result.source_coverage, scope: repoIds.length ? 'explicit_repositories' : 'authorized_global',
        scope_enumerated: repoIds.length > 0,
        exclusions: ['code_requires_complete_scan', 'private_drafts', 'hidden_comments', 'deleted_resources',
          ...(repoIds.length ? [] : ['unlisted_repositories', 'global_repository_coverage_not_enumerated'])] } });
  });
  route(app, 'GET', '/v1/repos/:repoId/search/coverage', { summary: 'Inspect authoritative search-index freshness', tags: ['search'], capability: 'contents.read' }, async c => {
    const repo = await getRepository(c, c.req.param('repoId') ?? '');
    return c.json(await searchCoverage(c, [repo]));
  });
  route(app, 'POST', '/v1/repos/:repoId/search/reindex', { summary: 'Request a durable search projection rebuild', tags: ['search'], capability: 'search.scan', body: z.strictObject({}) }, async c => {
    const repo = await getRepository(c, c.req.param('repoId') ?? '', 'search.scan');
    checkRevision(c, repo);
    await commit(c, { repo, resource_id: repo.id, revision: repo.revision, type: 'search.reindex_requested',
      sql: `INSERT INTO collaboration_search_watermarks(repo_id,revision,updated_at) VALUES (?,1,?)
        ON CONFLICT(repo_id) DO UPDATE SET revision=revision+1,updated_at=excluded.updated_at`, bindings: [repo.id, now()] });
    return c.json({ repo_id: repo.id, state: 'indexing_requested', coverage_url: `/v1/repos/${repo.id}/search/coverage` }, 202);
  });
  registerCodeScans(app);
}

async function readScan(c: AppContext): Promise<{ scan: CodeScan; repositories: ScanRepository[] }> {
  const principal = requirePrincipal(c);
  const scan = await one<CodeScan>(database(c), 'SELECT * FROM collaboration_code_scans WHERE principal_id=? AND id=?', principal.id, c.req.param('id'));
  if (!scan || scan.expires_at <= now()) notFound();
  const repositories = await many<ScanRepository>(database(c), 'SELECT * FROM collaboration_code_scan_repositories WHERE scan_id=? ORDER BY repo_id', scan.id);
  for (const repo of repositories) await getRepository(c, repo.repo_id);
  return { scan, repositories };
}
function scanCoverage(scan: CodeScan, repositories: ScanRepository[]): object {
  const enumerated = scan.state === 'completed' && repositories.every(repo => repo.state === 'completed' && repo.total_files !== null && repo.scanned_files + repo.excluded_files === repo.total_files);
  return { enumeration_complete: enumerated, complete: enumerated && repositories.every(repo => repo.excluded_files === 0),
    complete_for_eligible_text: enumerated, repositories: repositories.map(({ exclusions_json, ...repo }) => ({ ...repo,
      recent_exclusions: JSON.parse(exclusions_json) as unknown })), exclusions_url: `/v1/search/code-scans/${scan.id}/exclusions` };
}
function publicScan(scan: CodeScan, repositories: ScanRepository[]): Record<string, unknown> & { revision: number } {
  const { include_globs_json, exclude_globs_json, ...value } = scan;
  return { ...value, case_sensitive: Boolean(scan.case_sensitive), include_globs: JSON.parse(include_globs_json) as string[],
    exclude_globs: JSON.parse(exclude_globs_json) as string[], coverage: scanCoverage(scan, repositories),
    operation_url: `/v1/operations/${scan.operation_id}`, results_url: `/v1/search/code-scans/${scan.id}/results` };
}

function registerCodeScans(app: App): void {
  const path = '/v1/search/code-scans';
  route(app, 'POST', path, { summary: 'Start a complete revision-pinned asynchronous code scan', tags: ['search'], capability: 'search.scan', body: codeScanCreate }, async c => {
    const principal = requirePrincipal(c);
    const input = await jsonBody(c, codeScanCreate);
    const repos: Repository[] = [];
    for (const value of input.repositories) {
      const repo = await getRepository(c, value.repo_id, 'search.scan');
      await authorize(c, 'contents.read', { repo_id: repo.id });
      repos.push(repo);
    }
    const id = newId('scan');
    const at = now();
    const expires = new Date(Date.now() + input.retention_days * 86400_000).toISOString();
    const prepared = await prepareOperation(c, { repo: repos[0], kind: 'code_scan', resource_id: id,
      input: { scan_id: id, repositories: input.repositories, query: input.query } });
    const after = [...prepared.statements, ...input.repositories.map(value => stmt(database(c), `INSERT INTO collaboration_code_scan_repositories
      (scan_id,repo_id,commit_oid,state,updated_at) VALUES (?,?,?,'pending',?)`, id, value.repo_id, value.commit_oid, at))];
    for (const repo of repos.slice(1)) {
      const guard = newId('guard');
      after.push(stmt(database(c), `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN EXISTS
        (SELECT 1 FROM repositories WHERE id=? AND revision=? AND policy_revision=? AND state='active') THEN 1 ELSE 0 END`, guard, repo.id, repo.revision, repo.policy_revision),
      stmt(database(c), 'DELETE FROM mutation_guards WHERE id=?', guard));
    }
    await commit(c, { repo: repos[0], resource_id: id, revision: 1, type: 'search.code_scan_requested',
      sql: `INSERT INTO collaboration_code_scans(id,principal_id,user_id,operation_id,query,case_sensitive,include_globs_json,exclude_globs_json,state,expires_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'queued',?,?,?)`, bindings: [id, principal.id, principal.user_id, prepared.operation.id, input.query, Number(input.case_sensitive), JSON.stringify(input.include_globs),
      JSON.stringify(input.exclude_globs), expires, at, at], after, data: { scan_id: id, operation_id: prepared.operation.id } });
    c.header('location', `/v1/operations/${prepared.operation.id}`);
    return respond(c, { id, principal_id: principal.id, user_id: principal.user_id, state: 'queued', revision: 1, expires_at: expires, repositories: input.repositories,
      operation: publicOperation(prepared.operation), results_url: `${path}/${id}/results` }, 202);
  });
  route(app, 'GET', path, { summary: 'List your authorized code-scan operations', tags: ['search'], capability: 'contents.read' }, async c => {
    const principal = requirePrincipal(c);
    const p = pagination(c, `${principal.id}:code-scans`);
    const rows = await many<CodeScan>(database(c), `SELECT * FROM collaboration_code_scans WHERE principal_id=? AND expires_at>? AND ${pageSql()} ORDER BY created_at DESC,id DESC LIMIT ?`, principal.id, now(), ...pageBindings(p));
    const visible = [];
    for (const row of rows.slice(0, p.limit)) {
      const repos = await many<ScanRepository>(database(c), 'SELECT * FROM collaboration_code_scan_repositories WHERE scan_id=? ORDER BY repo_id', row.id);
      try { for (const repo of repos) await getRepository(c, repo.repo_id); visible.push(publicScan(row, repos)); }
      catch (error) { if (!(error instanceof ApiError && [401, 403, 404].includes(error.status))) throw error; }
    }
    return listResponse(c, visible, rows.length > p.limit ? nextCursor(p, rows[p.limit - 1]) : null);
  });
  route(app, 'GET', `${path}/:id`, { summary: 'Read code-scan progress, revisions and coverage', tags: ['search'], capability: 'contents.read' }, async c => {
    const { scan, repositories } = await readScan(c);
    return respond(c, publicScan(scan, repositories));
  });
  route(app, 'DELETE', `${path}/:id`, { summary: 'Cancel a code scan and fence further result production', tags: ['search'], capability: 'search.scan' }, async c => {
    const { scan, repositories } = await readScan(c);
    checkRevision(c, scan);
    for (const repo of repositories) await authorize(c, 'search.scan', { repo_id: repo.repo_id });
    const at = now();
    await commit(c, { resource_id: scan.id, revision: scan.revision + 1, type: 'search.code_scan_cancelled',
      sql: "UPDATE collaboration_code_scans SET state='cancelled',revision=revision+1,updated_at=? WHERE principal_id=? AND id=? AND revision=? AND state IN ('queued','scanning','failed')",
      bindings: [at, scan.principal_id, scan.id, scan.revision], after: [stmt(database(c), `UPDATE operations SET status='cancelled',phase='cancelled',revision=revision+1,updated_at=?,completed_at=?
        WHERE id=? AND status IN ('pending','waiting','running','failed')`, at, at, scan.operation_id)] });
    return respond(c, { id: scan.id, state: 'cancelled', revision: scan.revision + 1 });
  });
  for (const mode of ['results', 'exclusions'] as const) {
    route(app, 'GET', `${path}/:id/${mode}`, { summary: `Read authorized, checksummed code-scan ${mode}`, tags: ['search'], capability: 'contents.read' }, c => scanPage(c, mode));
  }
}

async function scanPage(c: AppContext, mode: 'results' | 'exclusions'): Promise<Response> {
  const { scan, repositories } = await readScan(c);
  const { cursor, limit } = page(c);
  const parsed = z.strictObject({ scan_id: identifier, mode: z.enum(['results', 'exclusions']), repo_id: z.string(),
    sequence: z.number().int().nonnegative(), offset: z.number().int().min(0).max(1000) }).safeParse(decodeCursor(cursor,
  { scan_id: scan.id, mode, repo_id: '', sequence: 0, offset: 0 }));
  if (!parsed.success || parsed.data.scan_id !== scan.id || parsed.data.mode !== mode) throw new ApiError(422, 'invalid_cursor', 'This cursor does not belong to this scan result stream.');
  let position = parsed.data;
  const items: object[] = [];
  let exhausted = false;
  for (let count = 0; count < 10 && items.length < limit; count++) {
    const chunk = await one<ScanChunk>(database(c), `SELECT c.*,o.object_key,o.sha256,o.bytes FROM collaboration_code_scan_chunks c
      JOIN object_manifests o ON o.id=c.object_id AND o.repo_id=c.repo_id AND o.state='ready'
      WHERE c.scan_id=? AND (c.repo_id>? OR (c.repo_id=? AND c.sequence>=?))
      ORDER BY c.repo_id,c.sequence LIMIT 1`, scan.id, position.repo_id, position.repo_id, position.sequence);
    if (!chunk) { exhausted = true; break; }
    const repo = await getRepository(c, chunk.repo_id);
    const revision = repositories.find(value => value.repo_id === repo.id);
    if (!revision) notFound();
    const object = await c.env.BLOBS.get(chunk.object_key);
    if (!object || object.size !== chunk.bytes || object.customMetadata?.repo_id !== repo.id) throw new ApiError(503, 'scan_result_unavailable', 'A retained scan result chunk is unavailable.');
    const bytes = await readBounded(object.body, 8 * 1024 * 1024);
    if (await sha256(bytes) !== chunk.sha256) throw new ApiError(503, 'scan_result_corrupt', 'A scan result chunk failed checksum verification.');
    const content = scanPageSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (!content.success || content.data.repo_id !== repo.id || content.data.commit_oid !== revision.commit_oid) throw new ApiError(503, 'scan_result_mismatch', 'This scan result does not match its repository revision.');
    const offset = chunk.repo_id === position.repo_id && chunk.sequence === position.sequence ? position.offset : 0;
    const values = mode === 'results' ? content.data.matches : content.data.exclusions;
    const take = values.slice(offset, offset + limit - items.length);
    items.push(...take.map(value => ({ repo_id: repo.id, commit_oid: revision.commit_oid, ...value })));
    position = { scan_id: scan.id, mode, repo_id: chunk.repo_id, sequence: chunk.sequence, offset: offset + take.length };
    if (position.offset >= values.length) { position.sequence++; position.offset = 0; }
  }
  const pending = ['queued', 'scanning'].includes(scan.state);
  return c.json({ items, next_cursor: exhausted && !pending ? null : encodeCursor(position), pending,
    coverage: scanCoverage(scan, repositories), ...(pending ? { retry_after_seconds: 3 } : {}) });
}
