import { z } from 'zod';
import { ApiError, database, jsonBody, limits, many, now, one, registerResourceLocator, requirePrincipal, route, stmt } from '@gitknot/core';
import type { App, AppContext, IdempotencyOptions, IdempotencyRecord, RouteAuthorization } from '@gitknot/core';
import { checkRevision, commit, ensureCanModerate, getItem, itemFence, itemTouch, manageCapability, notFound, pageBindings,
  pagedResponse, pageSql, pagination, respond, subjectAuthorizations, unlocked } from './common.ts';
import type { ItemKind } from './common.ts';
import { admitAttachment, attachmentDisposition, attachmentSelect, completeAttachment, deleteAttachment,
  publicAttachment, readAttachment, receiveAttachment, reserveAttachmentRepositoryBytes } from './attachment-storage.ts';
import type { Attachment } from './attachment-storage.ts';
import { attachmentIdentity, beginAttachmentSaga, newAttachmentSaga, recoverySaga, sagaStatement } from './attachment-sagas.ts';
import type { AttachmentAction } from './attachment-sagas.ts';

const schema = z.strictObject({
  filename: z.string().min(1).max(255).refine(value => !/[\x00-\x1f\x7f/\\]/.test(value), 'Use a filename without control characters or directories.'),
  content_type: z.string().max(150).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
  bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const empty = z.strictObject({});

async function createAttachment(c: AppContext, kind: ItemKind, collection: string): Promise<Response> {
  const { item, repo } = await getItem(c, kind, c.req.param('itemId'), 'attachments.write');
  checkRevision(c, item);
  unlocked(item);
  const input = await jsonBody(c, schema);
  const maximum = Math.min(limits(c.env).upload_bytes, limits(c.env).blob_bytes, 16 * 1024 * 1024);
  if (input.bytes > maximum) throw new ApiError(413, 'attachment_too_large', `Attachments may contain at most ${maximum} bytes.`);
  const identity = await attachmentIdentity(c);
  await registerResourceLocator(c.env, { resource_id: identity.object_id, resource_type: 'object', repo_id: repo.id });
  const at = now();
  const expires = new Date(Date.now() + limits(c.env).upload_reservation_minutes * 60_000).toISOString();
  const saga = newAttachmentSaga(c, { ...identity, repo_id: repo.id, item_id: item.id, revision: 1, upload_generation: 0 }, 'create', identity.operation_id);
  await commit(c, { repo, item, resource_id: identity.id, revision: 1, type: 'attachment.reserving',
    sql: 'INSERT INTO collaboration_attachments(id,repo_id,item_id,object_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    bindings: [identity.id, repo.id, item.id, identity.object_id, requirePrincipal(c).id, at, at], after: [
      ...itemFence(database(c), item), itemTouch(database(c), item), ...reserveAttachmentRepositoryBytes(c, repo, input.bytes),
      stmt(database(c), `INSERT INTO object_manifests(id,repo_id,account_id,kind,object_key,filename,content_type,bytes,sha256,state,
        created_by,retention_until,requested_retention_until,reference_count,created_at,updated_at)
        VALUES (?,?,?,'collaboration_attachment',?,?,?,?,?,'reserving',?,?,NULL,1,?,?)`,
      identity.object_id, repo.id, repo.owner_id, `${repo.owner_id}/${repo.id}/attachments/${identity.id}/${input.sha256}`,
      input.filename, input.content_type, input.bytes, input.sha256, requirePrincipal(c).id, expires, at, at), sagaStatement(c, saga),
    ], data: { item_id: item.id, attachment_id: identity.id, bytes: input.bytes } });
  c.header('location', `/v1/repos/${repo.id}/${collection}/${item.id}/attachments/${identity.id}`);
  const value = await readAttachment(c, repo.id, item.id, identity.id);
  try { return respond(c, publicAttachment(await admitAttachment(c, value, kind)), 201); }
  catch (error) {
    throw new ApiError(error instanceof ApiError ? error.status : 503, error instanceof ApiError ? error.code : 'storage_admission_unconfirmed',
      error instanceof ApiError ? error.message : 'The storage admission remains available for recovery.',
      { attachment_id: identity.id, prepare_url: `/v1/repos/${repo.id}/${collection}/${item.id}/attachments/${identity.id}/prepare` });
  }
}

async function actionResult(c: AppContext, kind: ItemKind, action: Exclude<AttachmentAction, 'create'>, value: Attachment): Promise<Response> {
  if (action === 'delete') {
    const authority = await getItem(c, kind, value.item_id, 'attachments.write', value.repo_id, true);
    if (value.created_by !== requirePrincipal(c).id) await ensureCanModerate(c, authority.item);
    const deleted = await deleteAttachment(c, value, authority);
    return respond(c, { id: deleted.id, revision: deleted.revision, state: deleted.state });
  }
  await getItem(c, kind, value.item_id, 'attachments.write', value.repo_id);
  const result = action === 'prepare' ? await admitAttachment(c, value, kind) : await completeAttachment(c, value, kind);
  return respond(c, publicAttachment(result));
}

function externalAttachment(kind: ItemKind, collection: string, action: AttachmentAction): { authorization: RouteAuthorization; idempotency: IdempotencyOptions } {
  const authorization: RouteAuthorization = async c => {
    const requirements = await subjectAuthorizations(c, c.req.param('repoId') ?? '', c.req.param('itemId'), 'attachments.write');
    if (action === 'delete') {
      const value = await readAttachment(c, c.req.param('repoId') ?? '', c.req.param('itemId') ?? '', c.req.param('id'), true);
      if (value.created_by !== requirePrincipal(c).id) requirements.push({ capability: manageCapability[kind], scope: { repo_id: value.repo_id } });
    }
    return requirements;
  };
  return { authorization, idempotency: { strategy: 'external', recover: async (c, record: IdempotencyRecord) => {
    const identity = action === 'create' ? await attachmentIdentity(c) : null;
    const id = identity?.id ?? c.req.param('id') ?? '';
    if (record.resource_id && record.resource_id !== id) throw new ApiError(409, 'attachment_intent_mismatch', 'This request is bound to another attachment.');
    const exists = await one(database(c), 'SELECT 1 FROM collaboration_attachments WHERE repo_id=? AND item_id=? AND id=?', c.req.param('repoId'), c.req.param('itemId'), id);
    if (!exists) {
      if (action !== 'create' || record.committed_at || record.resource_id) notFound();
      // No external work can precede this same deterministic D1 intent.
      return createAttachment(c, kind, collection);
    }
    const value = await readAttachment(c, c.req.param('repoId') ?? '', c.req.param('itemId') ?? '', id, true);
    const binding = await recoverySaga(c, record, value, action);
    if (!binding) {
      if (action === 'create') throw new ApiError(503, 'attachment_recovery_unavailable', 'The creation intent is missing its binding.');
      checkRevision(c, value);
      await beginAttachmentSaga(c, value, action);
    }
    if (action !== 'delete') await getItem(c, kind, value.item_id, 'attachments.write', value.repo_id);
    if (record.status === 'complete' || value.state === 'deleted') {
      if (value.state === 'deleted' && action !== 'delete') notFound();
      return respond(c, action === 'delete' ? { id: value.id, revision: value.revision, state: value.state } : publicAttachment(value), action === 'create' ? 201 : 200);
    }
    if (action === 'create') return respond(c, publicAttachment(await admitAttachment(c, value, kind)), 201);
    return actionResult(c, kind, action, value);
  } } };
}

export function registerAttachmentRoutes(app: App, collection: string, kind: ItemKind): void {
  const path = `/v1/repos/:repoId/${collection}/:itemId/attachments`;
  route(app, 'GET', path, { summary: 'List authorized attachment manifests', tags: ['attachments'], capability: 'contents.read' }, async c => {
    const { item, repo } = await getItem(c, kind, c.req.param('itemId'));
    const p = pagination(c, `${repo.id}:${item.id}:attachments`);
    const rows = await many<Attachment>(database(c), `${attachmentSelect} WHERE a.repo_id=? AND a.item_id=? AND o.state<>'deleted'
      AND ${pageSql('a')} ORDER BY a.created_at DESC,a.id DESC LIMIT ?`, repo.id, item.id, ...pageBindings(p));
    return pagedResponse(c, rows.map(row => ({ ...publicAttachment(row), id: row.id, created_at: row.created_at })), p);
  });
  route(app, 'GET', `${path}/:id`, { summary: 'Read an attachment and its current upload fence', tags: ['attachments'], capability: 'contents.read' }, async c => {
    const { item, repo } = await getItem(c, kind, c.req.param('itemId'));
    return respond(c, publicAttachment(await readAttachment(c, repo.id, item.id, c.req.param('id'))));
  });
  route(app, 'POST', path, { summary: 'Reserve an account-financed checksummed attachment', tags: ['attachments'], capability: 'attachments.write',
    body: schema, ...externalAttachment(kind, collection, 'create') }, c => createAttachment(c, kind, collection));
  for (const action of ['prepare', 'complete', 'delete'] as const) {
    const method = action === 'delete' ? 'DELETE' : 'POST';
    const target = action === 'delete' ? `${path}/:id` : `${path}/:id/${action}`;
    route(app, method, target, { summary: `${action} a manifest-bound attachment operation`, tags: ['attachments'], capability: 'attachments.write',
      ...(action === 'delete' ? {} : { body: empty }), ...externalAttachment(kind, collection, action) }, async c => {
      const { item, repo } = await getItem(c, kind, c.req.param('itemId'), 'attachments.write', c.req.param('repoId'), action === 'delete');
      const value = await readAttachment(c, repo.id, item.id, c.req.param('id'), action === 'delete');
      checkRevision(c, value);
      await beginAttachmentSaga(c, value, action);
      return actionResult(c, kind, action, value);
    });
  }
  route(app, 'PUT', `${path}/:id/content`, { summary: 'Upload exact bytes under an exclusive, financed generation', tags: ['attachments'],
    capability: 'attachments.write', streaming: true,
    authorization: c => subjectAuthorizations(c, c.req.param('repoId') ?? '', c.req.param('itemId'), 'attachments.write') }, async c => {
    const { item, repo } = await getItem(c, kind, c.req.param('itemId'), 'attachments.write');
    const value = await readAttachment(c, repo.id, item.id, c.req.param('id'));
    checkRevision(c, value);
    return respond(c, publicAttachment(await receiveAttachment(c, value, kind)));
  });
  route(app, 'GET', `${path}/:id/content`, { summary: 'Download an authorized, financially committed attachment', tags: ['attachments'], capability: 'contents.read', streaming: true }, async c => {
    const { item, repo } = await getItem(c, kind, c.req.param('itemId'));
    const value = await readAttachment(c, repo.id, item.id, c.req.param('id'));
    if (value.state !== 'ready') notFound();
    const object = await c.env.BLOBS.get(value.object_key);
    if (!object || object.size !== value.bytes || object.customMetadata?.repo_id !== repo.id || object.customMetadata?.object_id !== value.object_id) notFound();
    await getItem(c, kind, item.id, 'contents.read', repo.id);
    const headers = new Headers({ 'content-type': value.content_type, 'content-length': String(value.bytes),
      'content-disposition': attachmentDisposition(value.filename), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox", etag: `"${value.sha256}"` });
    if (c.req.header('if-none-match') === headers.get('etag')) return new Response(null, { status: 304, headers });
    return new Response(object.body, { headers });
  });
}
