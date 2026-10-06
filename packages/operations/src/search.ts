import { many, now, one, stmt } from '@gitknot/core';
import type { EventRecord, Repository } from '@gitknot/core';
import { completion, consumeOnce } from './durable.ts';
import type { OperationsBindings } from './types.ts';
export { authorizeCodeScanObject, runCodeScan } from './code-scans.ts';
import { requireLocalAuthority } from './ownership.ts';

interface Document { id: string; repo_id: string; kind: string; title: string; body: string; revision: number; deleted: number }

function indexStatement(db: D1DatabaseSession, repository: Repository, watermark: number, document: Document): D1PreparedStatement {
  return stmt(db, `INSERT INTO search_documents(id,repo_id,owner_id,kind,resource_id,revision,policy_revision,source_watermark,visibility,title,body,deleted,indexed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id,kind=excluded.kind,
      revision=excluded.revision,policy_revision=excluded.policy_revision,source_watermark=excluded.source_watermark,
      visibility=excluded.visibility,title=excluded.title,body=excluded.body,deleted=excluded.deleted,indexed_at=excluded.indexed_at
    WHERE search_documents.policy_revision<excluded.policy_revision OR (search_documents.policy_revision=excluded.policy_revision
      AND search_documents.source_watermark<=excluded.source_watermark AND search_documents.revision<=excluded.revision)`,
  document.id, repository.id, repository.owner_id, document.kind, document.id, document.revision, repository.policy_revision,
  watermark, repository.visibility, document.deleted ? '' : document.title, document.deleted ? '' : document.body, document.deleted, now());
}

export async function indexEvent(env: OperationsBindings, event: EventRecord): Promise<void> {
  const source = env.DB.withSession('first-primary');
  if (!event.repo_id || /^(?:storage|object|webhook|notification|mail|email|billing|operation|workflow|runner|application|identity|git)\./.test(event.type)) {
    await consumeOnce(source, 'index', event.id, [completion(source, 'index', event.id)]); return;
  }
  if (!env.SEARCH_DB) throw new Error('search_database_unavailable');
  const target = env.SEARCH_DB.withSession('first-primary');
  const repo = await requireLocalAuthority(env, event.repo_id);
  if (!repo) throw new Error('index_repository_missing');
  const mark = await one<{ revision: number }>(source, 'SELECT revision FROM collaboration_search_watermarks WHERE repo_id=?', repo.id);
  const watermark = mark?.revision ?? 0;
  const visible = ['active', 'archived', 'transfer_pending'].includes(repo.state);
  // A repository visibility/deletion tombstone carries a policy revision, defeating stale in-flight writers.
  await target.batch([
    stmt(target, `INSERT INTO search_repository_state(repo_id,revision,policy_revision,state,indexed_at) VALUES(?,?,?,'indexing',?)
      ON CONFLICT(repo_id) DO UPDATE SET state='indexing',revision=MAX(revision,excluded.revision),policy_revision=excluded.policy_revision,indexed_at=excluded.indexed_at
      WHERE search_repository_state.policy_revision<excluded.policy_revision OR
        (search_repository_state.policy_revision=excluded.policy_revision AND search_repository_state.revision<=excluded.revision)`, repo.id, watermark, repo.policy_revision, now()),
    stmt(target, `UPDATE search_documents SET owner_id=?,visibility=?,policy_revision=?,source_watermark=MAX(source_watermark,?),
      deleted=CASE WHEN ? THEN deleted ELSE 1 END,title=CASE WHEN ? THEN title ELSE '' END,body=CASE WHEN ? THEN body ELSE '' END,indexed_at=?
      WHERE repo_id=? AND policy_revision<=?`, repo.owner_id, repo.visibility, repo.policy_revision, watermark, Number(visible), Number(visible), Number(visible), now(), repo.id, repo.policy_revision),
  ]);
  for (const kind of ['items', 'comments'] as const) {
    let cursor = '';
    while (true) {
      await requireLocalAuthority(env, repo.id);
      const rows = kind === 'items'
        ? await many<Document>(source, `SELECT id,repo_id,kind,title,markdown AS body,revision,CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END AS deleted
          FROM collaboration_items WHERE repo_id=? AND id>? ORDER BY id LIMIT 50`, repo.id, cursor)
        : await many<Document>(source, `SELECT c.id,c.repo_id,'comment' AS kind,i.title,c.markdown AS body,c.revision,
          CASE WHEN c.state='visible' AND i.deleted_at IS NULL THEN 0 ELSE 1 END AS deleted FROM collaboration_comments c
          JOIN collaboration_items i ON i.id=c.item_id AND i.repo_id=c.repo_id WHERE c.repo_id=? AND c.id>? ORDER BY c.id LIMIT 50`, repo.id, cursor);
      if (!rows.length) break;
      await consumeOnce(target, `index:${kind}:${cursor}`, event.id,
        rows.map((document) => indexStatement(target, repo, watermark, { ...document, deleted: visible ? document.deleted : 1 })));
      cursor = rows.at(-1)!.id;
    }
  }
  const latest = await one<{ revision: number }>(source, 'SELECT revision FROM collaboration_search_watermarks WHERE repo_id=?', repo.id);
  await requireLocalAuthority(env, repo.id);
  const complete = (latest?.revision ?? 0) === watermark;
  await consumeOnce(target, 'index', event.id, [stmt(target, `UPDATE search_repository_state SET state=?,revision=MAX(revision,?),indexed_at=?
    WHERE repo_id=? AND policy_revision=? AND revision<=?`, visible ? complete ? 'complete' : 'partial' : 'deleted', watermark, now(), repo.id, repo.policy_revision, watermark)]);
  await consumeOnce(source, 'index', event.id, [completion(source, 'index', event.id)]);
}
