import { Context } from 'hono';
import { ApiError, authorize, canonicalJson, database, getRepository, many, now, one, requestDatabaseAuthority, requestDatabaseBinding,
  requestDatabaseLocation, setRequestDatabase, sha256, stmt } from '@gitknot/core';
import type { AppContext, AppEnv, Database } from '@gitknot/core';
import { reviewRefs } from '../../git/src/protocol.ts';
import { metadataFenceGuard, operationFence } from './metadata-fence.ts';
import { executionArchiveAudience } from './execution-audience.ts';

async function captureGuard(db: Database, archiveId: string): Promise<D1PreparedStatement[]> {
  const archive = await one<{ repo_id: string; operation_id: string }>(db, "SELECT repo_id,operation_id FROM repository_archives WHERE id=? AND state='writing'", archiveId);
  if (!archive) throw new Error('archive_capture_closed');
  return metadataFenceGuard(db, archive.repo_id, await operationFence(db, archive.operation_id));
}

export interface ArchiveRefAudience { ref: string; oid: string; source_repo_id: string }

export async function captureArchiveRefAudiences(db: Database, archiveId: string, repoId: string, refs: readonly { ref: string; oid: string }[]): Promise<ArchiveRefAudience[]> {
  const candidates = await many<{ source_repo_id: string; internal_ref: string; candidate_oid: string }>(db,
    'SELECT source_repo_id,internal_ref,candidate_oid FROM git_candidates WHERE repo_id=? AND candidate_oid IS NOT NULL', repoId);
  const reviews = await many<{ id: string; source_repo_id: string; base_oid: string; head_oid: string; merge_base_oid: string | null }>(db,
    "SELECT id,source_repo_id,base_oid,head_oid,merge_base_oid FROM git_review_snapshots WHERE repo_id=? AND state='ready'", repoId);
  const protectedRefs = new Map(candidates.map(row => [row.internal_ref, { oid: row.candidate_oid, source_repo_id: row.source_repo_id }]));
  for (const row of reviews) for (const [index, ref] of reviewRefs(row.id).entries()) {
    const oid = [row.base_oid, row.head_oid, row.merge_base_oid][index];
    if (!oid) throw new Error('archive_review_ref_unverified');
    protectedRefs.set(ref, { oid, source_repo_id: row.source_repo_id });
  }
  const actual = new Map(refs.map(row => [row.ref, row.oid]));
  if (actual.size !== refs.length || [...protectedRefs].some(([ref, source]) => actual.get(ref) !== source.oid)) throw new Error('archive_retained_ref_missing');
  const result = refs.map(({ ref, oid }): ArchiveRefAudience => {
    const source = protectedRefs.get(ref);
    if (ref.startsWith('refs/gitknot/') && !source) throw new Error('archive_ref_audience_missing');
    return { ref, oid, source_repo_id: source?.source_repo_id ?? repoId };
  }).sort((a, b) => a.ref.localeCompare(b.ref));
  const previous = await many<ArchiveRefAudience>(db, 'SELECT ref,oid,source_repo_id FROM archive_ref_audiences WHERE archive_id=? ORDER BY ref', archiveId);
  if (previous.length && canonicalJson(previous.sort((a, b) => a.ref.localeCompare(b.ref))) !== canonicalJson(result)) throw new Error('archive_ref_audience_changed');
  for (let offset = 0; offset < result.length; offset += 50) await db.batch([...await captureGuard(db, archiveId), ...result.slice(offset, offset + 50).map(row => stmt(db,
    'INSERT INTO archive_ref_audiences(archive_id,ref,oid,source_repo_id) VALUES(?,?,?,?) ON CONFLICT(archive_id,ref) DO NOTHING', archiveId, row.ref, row.oid, row.source_repo_id))]);
  await retainArchiveAudiences(db, archiveId, result.map(row => row.source_repo_id));
  return result;
}

export interface ArchiveAccessRecord {
  id: string; repo_id: string; account_id: string; kind: 'export' | 'backup' | 'deletion' | 'move';
  state: string; expires_at: string; audience_sha256: string | null; archive_sha256: string | null;
}

export async function captureArchiveAudiences(db: Database, archiveId: string, repoId: string): Promise<string[]> {
  // workerd deliberately limits compound SELECT terms more tightly than Node's
  // SQLite. Keep the read set transactional without a many-arm UNION.
  const sources = await db.batch<{ id: string | null }>([
    stmt(db, 'SELECT id FROM repositories WHERE id=?', repoId),
    stmt(db, 'SELECT fork_source_id AS id FROM repositories WHERE id=?', repoId),
    stmt(db, 'SELECT DISTINCT head_repo_id AS id FROM pull_requests WHERE repo_id=?', repoId),
    stmt(db, 'SELECT DISTINCT head_repo_id AS id FROM pull_patches WHERE repo_id=?', repoId),
    stmt(db, 'SELECT DISTINCT source_repo_id AS id FROM git_candidates WHERE repo_id=?', repoId),
    stmt(db, 'SELECT DISTINCT source_repo_id AS id FROM git_review_snapshots WHERE repo_id=?', repoId),
    stmt(db, 'SELECT DISTINCT workspace_repo_id AS id FROM task_workspaces WHERE repo_id=?', repoId),
  ]);
  await retainArchiveAudiences(db, archiveId, sources.flatMap(result => result.results.flatMap(source => source.id ? [source.id] : [])));
  await retainArchiveAudiences(db, archiveId, await executionArchiveAudience(db, repoId));
  return archiveAudienceIds(db, archiveId);
}

export async function retainArchiveAudiences(db: Database, archiveId: string, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length > 4096) throw new ApiError(422, 'archive_audience_limit', 'This complete archive exceeds the supported audience scope.');
  for (let offset = 0; offset < unique.length; offset += 50) await db.batch([...await captureGuard(db, archiveId), ...unique.slice(offset, offset + 50).map((id) => stmt(db,
    'INSERT OR IGNORE INTO archive_audiences(archive_id,repository_id,created_at) VALUES(?,?,?)', archiveId, id, now()))]);
}

export async function archiveAudienceIds(db: Database, archiveId: string): Promise<string[]> {
  const rows = await many<{ repository_id: string }>(db, 'SELECT repository_id FROM archive_audiences WHERE archive_id=? ORDER BY repository_id', archiveId);
  if (!rows.length || rows.length > 4096) throw new ApiError(503, 'archive_audience_unavailable', 'The complete archive audience could not be verified.');
  return rows.map((row) => row.repository_id);
}

/** Complete exports retain all protected history, so every historical source audience must authorize the reader. */
export async function authorizeArchiveSources(c: AppContext, repoId: string, sources: readonly string[]): Promise<void> {
  await getRepository(c, repoId, 'repositories.export');
  await getRepository(c, repoId, 'contents.read');
  if (!sources.includes(repoId)) throw new ApiError(503, 'archive_audience_unavailable', 'The complete archive audience could not be verified.');
  for (const source of sources) if (source !== repoId) await getRepository(c, source, 'contents.read');
}

/** Use for both list filtering and download authorization; it never falls back to a base-only ACL. */
export async function authorizeArchive(c: AppContext, archiveId: string): Promise<ArchiveAccessRecord> {
  const db = database(c);
  const row = await one<ArchiveAccessRecord>(db, `SELECT id,repo_id,account_id,kind,state,expires_at,audience_sha256,archive_sha256
    FROM repository_archives WHERE id=?`, archiveId);
  if (!row) throw new ApiError(404, 'not_found', 'The archive was not found.');
  const repo = await getRepository(c, row.repo_id, 'repositories.export');
  const location = requestDatabaseLocation(c);
  if (repo.cell_id !== location.cell_id || repo.shard_id !== location.shard_id) throw new ApiError(409, 'archive_placement_changed', 'The archive moved. Retry its current URL.');
  if (row.state !== 'verified' || row.expires_at <= now()) throw new ApiError(404, 'not_found', 'The archive is not available.');
  if (row.kind !== 'export') {
    if (row.account_id !== repo.owner_id) throw new ApiError(404, 'not_found', 'The protected backup is not owned by this repository account.');
    await authorize(c, 'accounts.manage', { account_id: row.account_id });
  }
  const audiences = await archiveAudienceIds(db, row.id);
  if (!row.audience_sha256 || await sha256(canonicalJson(audiences)) !== row.audience_sha256) {
    throw new ApiError(503, 'archive_audience_unavailable', 'The immutable archive audience could not be verified.');
  }
  await authorizeArchiveSources(c, row.repo_id, audiences);
  if (await one(db, "SELECT 1 FROM archive_snapshot_rows WHERE archive_id=? AND table_name='workflow_runs' LIMIT 1", row.id)) await getRepository(c, row.repo_id, 'runs.read');
  return row;
}

/** Pass this callback to portableArchiveStream; every part rechecks ownership and the full audience. */
export function archiveAuthorizer(c: AppContext, archiveId: string): () => Promise<void> {
  const binding = requestDatabaseBinding(c);
  const authority = requestDatabaseAuthority(c);
  return async () => {
    const fresh = new Context<AppEnv>(new Request(c.req.url), { env: c.env });
    fresh.set('principal', c.get('principal'));
    fresh.set('requestId', c.get('requestId'));
    setRequestDatabase(fresh, binding, authority);
    await authorizeArchive(fresh, archiveId);
  };
}
