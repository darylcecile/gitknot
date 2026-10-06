import { ApiError, database, eventStatement, execute, getRepository, identityBinding, many, mutationGuard, mutationStatements, newId,
  now, one, requestPolicies, requirePrincipal, resolveRepositoryPlacement, selectIdentityDatabase, sha256, stmt } from '@gitknot/core';
import type { AppContext, Principal, Repository } from '@gitknot/core';
import { nativeJSON, scanPageSchema } from '../../../apps/api/src/modules/collaboration/native.ts';
import { backgroundContext, rehydrateOperationPrincipal } from './authorization.ts';
import { claimOperationRuntime, consumeOnce } from './durable.ts';
import { deleteOperationObject, putObject } from './objects.ts';
import type { StoredObject } from './objects.ts';
import { backgroundCell, financialEnvironment, shardEnvironment } from './placement.ts';
import { requireLocalAuthority } from './ownership.ts';
import { privateJSON } from './private.ts';
import type { Operation, OperationsBindings } from './types.ts';

interface Scan {
  id: string; principal_id: string; user_id: string | null; operation_id: string; query: string; case_sensitive: number;
  include_globs_json: string; exclude_globs_json: string; state: string; revision: number; expires_at: string; failure_code: string | null;
}
interface ScanRepository { repo_id: string; commit_oid: string; native_cursor: string | null; state: string; scanned_files: number; excluded_files: number; total_files: number | null }
type ScanPage = ReturnType<typeof scanPageSchema.parse>;

async function loadScan(env: OperationsBindings, operationId: string): Promise<{ scan: Scan; operation: Operation; principal: Principal }> {
  const db = identityBinding(env).withSession('first-primary');
  const operation = await one<Operation>(db, 'SELECT * FROM operations WHERE id=?', operationId);
  const scan = await one<Scan>(db, 'SELECT * FROM collaboration_code_scans WHERE operation_id=?', operationId);
  if (!operation || !scan || scan.expires_at <= now() || scan.state === 'cancelled' || scan.failure_code || operation.status === 'cancelled') throw new Error('scan_unavailable');
  const context = await one<{ principal_json: string; input_digest: string }>(db, 'SELECT principal_json,input_digest FROM collaboration_operation_contexts WHERE operation_id=?', operation.id);
  if (!context || context.input_digest !== await sha256(operation.input_json)) throw new Error('scan_context_invalid');
  const original = JSON.parse(context.principal_json) as Principal;
  if (original.id !== scan.principal_id || original.id !== operation.actor_id) throw new Error('scan_actor_mismatch');
  return { scan, operation, principal: await rehydrateOperationPrincipal(env, original) };
}

async function scanAuthority(env: OperationsBindings, principal: Principal, repoId: string): Promise<{ context: AppContext; repository: Repository }> {
  const context = backgroundContext(financialEnvironment(env), principal);
  selectIdentityDatabase(context);
  await requestPolicies(context, [{ capability: 'search.scan', scope: { repo_id: repoId } }, { capability: 'contents.read', scope: { repo_id: repoId } }]);
  return { context, repository: await getRepository(context, repoId, 'contents.read') };
}

function verifyScanPage(value: ScanPage, selected: ScanRepository): void {
  if (value.repo_id !== selected.repo_id || value.commit_oid !== selected.commit_oid
    || value.next_cursor === selected.native_cursor && value.next_cursor !== null) throw new Error('scan_evidence_mismatch');
  if (value.scanned_files < selected.scanned_files || value.excluded_files < selected.excluded_files
    || selected.total_files !== null && value.total_files !== selected.total_files || value.matches.length > 500
    || value.scanned_files + value.excluded_files > value.total_files) throw new Error('scan_coverage_regressed');
  if (!value.next_cursor && value.scanned_files + value.excluded_files !== value.total_files) throw new Error('scan_coverage_incomplete');
}

async function publishScanPage(env: OperationsBindings, operationId: string, selected: ScanRepository, pageId: string, page: ScanPage, object: StoredObject): Promise<void> {
  const { scan, operation, principal } = await loadScan(env, operationId);
  const { context } = await scanAuthority(env, principal, selected.repo_id);
  const db = database(context);
  const guard = newId('guard');
  await consumeOnce(db, 'code-scan-page', pageId, await mutationStatements(context, { statements: [
    stmt(db, `UPDATE collaboration_code_scans SET revision=revision+1,updated_at=? WHERE id=? AND principal_id=? AND revision=?
      AND state='scanning' AND failure_code IS NULL AND expires_at>? AND EXISTS(SELECT 1 FROM operations WHERE id=? AND status NOT IN ('cancelled','completed'))`,
    now(), scan.id, principal.id, scan.revision, now(), operation.id), mutationGuard(db, guard),
    stmt(db, `UPDATE collaboration_code_scan_repositories SET state=?,native_cursor=?,scanned_files=?,total_files=?,match_count=match_count+?,
      excluded_files=?,exclusions_json=?,updated_at=? WHERE scan_id=? AND repo_id=? AND commit_oid=? AND native_cursor IS ?
      AND state IN ('pending','scanning','failed') AND scanned_files=? AND excluded_files=?`,
    page.next_cursor ? 'scanning' : 'completed', page.next_cursor, page.scanned_files, page.total_files, page.matches.length,
    page.excluded_files, JSON.stringify(page.exclusions), now(), scan.id, selected.repo_id, selected.commit_oid, selected.native_cursor, selected.scanned_files, selected.excluded_files),
    mutationGuard(db, `${guard}_cursor`),
    stmt(db, `INSERT INTO collaboration_code_scan_chunks(id,scan_id,repo_id,sequence,object_id,match_count,created_at,sha256,bytes)
      SELECT ?,?,?,COALESCE((SELECT MAX(sequence)+1 FROM collaboration_code_scan_chunks WHERE scan_id=? AND repo_id=?),0),?,?,?,?,?`,
    `chunk_${pageId}`, scan.id, selected.repo_id, scan.id, selected.repo_id, object.id, page.matches.length, now(), object.sha256, object.bytes),
    stmt(db, 'DELETE FROM mutation_guards WHERE id IN (?,?)', guard, `${guard}_cursor`),
  ], event: { type: 'search.code_scan_progress', resource_id: scan.id, resource_revision: scan.revision + 1,
    account_id: operation.account_id, data: { scan_id: scan.id, repository_id: selected.repo_id, scanned_files: page.scanned_files, excluded_files: page.excluded_files } } }));
}

/** Fixed private RPC: all query, principal, revision and cursor inputs come from the durable identity-owned scan. */
export async function produceCodeScanPage(env: OperationsBindings, input: { operation_id: string; repo_id: string; cursor: string | null }): Promise<{ accepted: true }> {
  const { scan, principal } = await loadScan(env, input.operation_id);
  const db = identityBinding(env).withSession('first-primary');
  const selected = await one<ScanRepository>(db, 'SELECT * FROM collaboration_code_scan_repositories WHERE scan_id=? AND repo_id=?', scan.id, input.repo_id);
  if (!selected) throw new Error('scan_repository_missing');
  if (selected.state === 'completed' || selected.native_cursor !== input.cursor) return { accepted: true };
  const pageId = await sha256(`${scan.id}:${selected.repo_id}:${selected.native_cursor ?? 'start'}`);
  if (await one(db, "SELECT 1 FROM processed_events WHERE consumer='code-scan-page' AND event_id=?", pageId)) throw new Error('scan_cursor_cycle');
  const repo = await requireLocalAuthority(env, selected.repo_id);
  if (!repo) throw new Error('scan_repository_missing');
  await scanAuthority(env, principal, repo.id);
  const page = await nativeJSON(backgroundContext(env, principal, repo), repo.id, 'collaboration/inspect', scanPageSchema, {
    actor: principal, inspection: { kind: 'scan', commit_oid: selected.commit_oid, query: scan.query, case_sensitive: !!scan.case_sensitive,
      include_globs: JSON.parse(scan.include_globs_json), exclude_globs: JSON.parse(scan.exclude_globs_json), cursor: selected.native_cursor, max_results: 500 },
  });
  verifyScanPage(page, selected);
  const current = await loadScan(env, input.operation_id);
  const authority = await scanAuthority(env, current.principal, repo.id);
  const object = await putObject(env, { id: `obj_scan_${pageId}`, repo_id: repo.id, account_id: authority.repository.owner_id, actor_id: principal.id,
    kind: 'collaboration_code_scan', key: `${authority.repository.owner_id}/${repo.id}/scans/${scan.id}/${pageId}.json`, content_type: 'application/json',
    data: new TextEncoder().encode(JSON.stringify(page)), retention_until: scan.expires_at });
  try { await publishScanPage(env, input.operation_id, selected, pageId, page, object); }
  catch (error) {
    const linked = await one(db, 'SELECT 1 FROM collaboration_code_scan_chunks WHERE object_id=?', object.id);
    if (!linked) await deleteOperationObject(env, object.id);
    throw error;
  }
  return { accepted: true };
}

export async function runCodeScan(base: OperationsBindings, operation: Operation): Promise<Record<string, unknown>> {
  const env = financialEnvironment(base);
  const db = env.DB.withSession('first-primary');
  const { scan } = await loadScan(env, operation.id);
  await claimOperationRuntime(env, operation.id, 'scan-code');
  await execute(db, `UPDATE collaboration_code_scans SET state='scanning',revision=revision+1,updated_at=? WHERE id=? AND state IN ('queued','failed') AND failure_code IS NULL`, now(), scan.id);
  const repositories = await many<ScanRepository>(db, 'SELECT * FROM collaboration_code_scan_repositories WHERE scan_id=? ORDER BY repo_id', scan.id);
  for (const repository of repositories) for (;;) {
    const selected = await one<ScanRepository>(db, 'SELECT * FROM collaboration_code_scan_repositories WHERE scan_id=? AND repo_id=?', scan.id, repository.repo_id);
    if (!selected) throw new Error('scan_repository_missing');
    if (selected.state === 'completed') break;
    await loadScan(env, operation.id);
    const placement = await resolveRepositoryPlacement(base, selected.repo_id);
    if (!placement) throw new Error('scan_repository_authority_missing');
    const input = { operation_id: operation.id, repo_id: selected.repo_id, cursor: selected.native_cursor };
    const receipt = placement.cell_id === base.CELL_ID ? await produceCodeScanPage(shardEnvironment(base, placement.shard_id), input)
      : await privateJSON<{ accepted: boolean }>(base, backgroundCell(base, placement.cell_id), 'operations.events', '/internal/events/scan-page', { ...input, shard_id: placement.shard_id });
    if (!receipt.accepted) throw new Error('scan_page_unconfirmed');
  }
  const current = await loadScan(env, operation.id);
  for (const repo of repositories) await scanAuthority(env, current.principal, repo.repo_id);
  const guard = newId('guard');
  await consumeOnce(db, 'code-scan-complete', scan.id, [
    stmt(db, `UPDATE collaboration_code_scans SET state='completed',revision=revision+1,updated_at=? WHERE id=? AND state='scanning' AND principal_id=?
      AND failure_code IS NULL AND NOT EXISTS(SELECT 1 FROM collaboration_code_scan_repositories WHERE scan_id=? AND state<>'completed')
      AND EXISTS(SELECT 1 FROM operations WHERE id=? AND status NOT IN ('cancelled','completed'))`, now(), scan.id, current.principal.id, scan.id, operation.id),
    mutationGuard(db, guard), stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard),
    eventStatement(db, { type: 'search.code_scan_completed', resource_id: scan.id, resource_revision: current.scan.revision + 1, account_id: operation.account_id }),
  ]);
  const total = await one<{ matched: number; scanned: number; excluded: number }>(db,
    'SELECT SUM(match_count) AS matched,SUM(scanned_files) AS scanned,SUM(excluded_files) AS excluded FROM collaboration_code_scan_repositories WHERE scan_id=?', scan.id);
  return { scan_id: scan.id, complete: true, matched_count: total?.matched ?? 0, scanned_files: total?.scanned ?? 0, excluded_files: total?.excluded ?? 0 };
}

export async function authorizeCodeScanObject(c: AppContext, objectId: string): Promise<void> {
  const principal = requirePrincipal(c);
  const db = identityBinding(c.env).withSession('first-primary');
  const row = await one<{ scan_id: string }>(db, `SELECT k.scan_id FROM collaboration_code_scan_chunks k JOIN collaboration_code_scans s ON s.id=k.scan_id
    WHERE k.object_id=? AND s.principal_id=? AND s.expires_at>? AND s.failure_code IS NULL AND s.state<>'cancelled'`, objectId, principal.id, now());
  if (!row) throw new ApiError(404, 'not_found', 'The scan result was not found.');
  const repositories = await many<{ repo_id: string }>(db, 'SELECT repo_id FROM collaboration_code_scan_repositories WHERE scan_id=?', row.scan_id);
  for (const repository of repositories) await getRepository(c, repository.repo_id, 'contents.read');
}
