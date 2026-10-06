import { z } from 'zod';
import { database, getRepository, jsonBody, many, newId, now, one, route, stmt } from '@gitknot/core';
import type { App, AppContext } from '@gitknot/core';
import {
  checkRevision, commit, conflict, currentUser, documentStatement, getItem, identifier, markdown,
  notFound, pageBindings, pagedResponse, pageSql, pagination, respond,
} from './common.ts';
import type { DocumentVersion } from './common.ts';

interface Draft {
  id: string; repo_id: string; user_id: string; item_id: string | null; kind: string; title: string;
  markdown: string; base_document_revision: number | null; revision: number; document_revision: number;
  created_at: string; updated_at: string;
}
const schema = z.strictObject({ kind: z.enum(['issue', 'pull_request', 'discussion', 'task', 'comment']),
  item_id: identifier.optional(), title: z.string().max(300).default(''), markdown: markdown.default(''),
  base_document_revision: z.number().int().positive().optional() });
const edit = z.strictObject({ title: z.string().max(300).optional(), markdown: markdown.optional(),
  base_document_revision: z.number().int().positive().optional() }).refine(value => Object.keys(value).length > 0, 'Supply at least one field.');

async function readDraft(c: AppContext): Promise<Draft> {
  const userId = currentUser(c);
  const repo = await getRepository(c, c.req.param('repoId') ?? '');
  const value = await one<Draft>(database(c), 'SELECT * FROM collaboration_drafts WHERE repo_id=? AND user_id=? AND id=? AND deleted_at IS NULL',
    repo.id, userId, c.req.param('id'));
  if (!value) notFound();
  if (value.item_id) await getItem(c, undefined, value.item_id, 'contents.read', repo.id);
  return value;
}

export function registerDraftRoutes(app: App): void {
  const path = '/v1/repos/:repoId/drafts';
  route(app, 'GET', path, { summary: 'List your private Markdown drafts', tags: ['markdown'], capability: 'contents.read' }, async c => {
    const repo = await getRepository(c, c.req.param('repoId') ?? '');
    const userId = currentUser(c);
    const p = pagination(c, `${repo.id}:${userId}:drafts`);
    const rows = await many<Draft>(database(c), `SELECT * FROM collaboration_drafts WHERE repo_id=? AND user_id=? AND deleted_at IS NULL
      AND ${pageSql()} ORDER BY created_at DESC,id DESC LIMIT ?`, repo.id, userId, ...pageBindings(p));
    for (const row of rows) if (row.item_id) await getItem(c, undefined, row.item_id, 'contents.read', repo.id);
    return pagedResponse(c, rows, p);
  });
  route(app, 'GET', `${path}/:id`, { summary: 'Read your private Markdown draft', tags: ['markdown'], capability: 'contents.read' }, async c => respond(c, await readDraft(c)));
  route(app, 'POST', path, { summary: 'Save a private canonical Markdown draft', tags: ['markdown'], capability: 'contents.read', body: schema }, async c => {
    const repo = await getRepository(c, c.req.param('repoId') ?? '');
    const userId = currentUser(c);
    const input = await jsonBody(c, schema);
    if (input.item_id) {
      const { item } = await getItem(c, undefined, input.item_id, 'contents.read', repo.id);
      if (input.base_document_revision !== undefined && input.base_document_revision !== item.document_revision) {
        conflict('draft_base_changed', 'The source document changed. Save against its current document revision.');
      }
    }
    const id = newId('draft');
    const at = now();
    const draft: Draft = { ...input, id, repo_id: repo.id, user_id: userId, item_id: input.item_id ?? null,
      base_document_revision: input.base_document_revision ?? null, revision: 1, document_revision: 1, created_at: at, updated_at: at };
    await commit(c, { repo, resource_id: id, revision: 1, type: 'draft.created',
      sql: `INSERT INTO collaboration_drafts(id,repo_id,user_id,item_id,kind,title,markdown,base_document_revision,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, bindings: [id, repo.id, userId, draft.item_id, input.kind, input.title, input.markdown, draft.base_document_revision, at, at],
      after: [await documentStatement(database(c), { ...draft, resource_kind: 'draft', resource_id: id, actor_id: userId })] });
    return respond(c, draft, 201);
  });
  route(app, 'PATCH', `${path}/:id`, { summary: 'Update your draft with concurrent-edit protection', tags: ['markdown'], capability: 'contents.read', body: edit }, async c => {
    const old = await readDraft(c);
    checkRevision(c, old);
    const repo = await getRepository(c, old.repo_id);
    const input = await jsonBody(c, edit);
    if (input.base_document_revision !== undefined && old.item_id) {
      const { item } = await getItem(c, undefined, old.item_id, 'contents.read', repo.id);
      if (input.base_document_revision !== item.document_revision) conflict('draft_base_changed', 'The source document changed again.');
    }
    const value = { ...old, ...input, revision: old.revision + 1, document_revision: old.document_revision + 1, updated_at: now() };
    await commit(c, { repo, resource_id: old.id, revision: value.revision, type: 'draft.updated',
      sql: `UPDATE collaboration_drafts SET title=?,markdown=?,base_document_revision=?,revision=revision+1,document_revision=document_revision+1,updated_at=?
        WHERE repo_id=? AND user_id=? AND id=? AND revision=? AND deleted_at IS NULL`,
      bindings: [value.title, value.markdown, value.base_document_revision, value.updated_at, repo.id, old.user_id, old.id, old.revision],
      after: [await documentStatement(database(c), { ...value, resource_kind: 'draft', resource_id: old.id, actor_id: old.user_id })] });
    return respond(c, value);
  });
  route(app, 'DELETE', `${path}/:id`, { summary: 'Discard your draft', tags: ['markdown'], capability: 'contents.read' }, async c => {
    const old = await readDraft(c);
    checkRevision(c, old);
    const repo = await getRepository(c, old.repo_id);
    const at = now();
    await commit(c, { repo, resource_id: old.id, revision: old.revision + 1, type: 'draft.deleted',
      sql: 'UPDATE collaboration_drafts SET deleted_at=?,revision=revision+1,updated_at=? WHERE repo_id=? AND user_id=? AND id=? AND revision=?',
      bindings: [at, at, repo.id, old.user_id, old.id, old.revision] });
    return respond(c, { id: old.id, revision: old.revision + 1, deleted_at: at });
  });
  route(app, 'GET', `${path}/:id/versions`, { summary: 'Read your immutable draft history', tags: ['markdown'], capability: 'contents.read' }, async c => {
    const draft = await readDraft(c);
    const p = pagination(c, `${draft.repo_id}:${draft.user_id}:${draft.id}:versions`);
    const rows = await many<DocumentVersion>(database(c), `SELECT * FROM collaboration_document_versions WHERE repo_id=? AND resource_kind='draft'
      AND resource_id=? AND ${pageSql()} ORDER BY created_at DESC,id DESC LIMIT ?`, draft.repo_id, draft.id, ...pageBindings(p));
    return pagedResponse(c, rows, p);
  });
  const restore = z.strictObject({ document_revision: z.number().int().positive() });
  route(app, 'POST', `${path}/:id/restore`, { summary: 'Restore a private draft revision', tags: ['markdown'], capability: 'contents.read', body: restore }, async c => {
    const draft = await readDraft(c);
    checkRevision(c, draft);
    const repo = await getRepository(c, draft.repo_id);
    const input = await jsonBody(c, restore);
    const version = await one<DocumentVersion>(database(c), `SELECT * FROM collaboration_document_versions
      WHERE repo_id=? AND resource_kind='draft' AND resource_id=? AND document_revision=?`, repo.id, draft.id, input.document_revision);
    if (!version) notFound();
    const value = { ...draft, title: version.title ?? '', markdown: version.markdown,
      revision: draft.revision + 1, document_revision: draft.document_revision + 1, updated_at: now() };
    await commit(c, { repo, resource_id: draft.id, revision: value.revision, type: 'draft.restored',
      sql: `UPDATE collaboration_drafts SET title=?,markdown=?,revision=revision+1,document_revision=document_revision+1,updated_at=?
        WHERE repo_id=? AND user_id=? AND id=? AND revision=? AND deleted_at IS NULL`,
      bindings: [value.title, value.markdown, value.updated_at, repo.id, draft.user_id, draft.id, draft.revision],
      after: [await documentStatement(database(c), { ...value, resource_kind: 'draft', resource_id: draft.id, actor_id: draft.user_id, restored_from: version.document_revision })] });
    return respond(c, value);
  });
}
