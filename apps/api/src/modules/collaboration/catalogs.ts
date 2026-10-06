import { z } from 'zod';
import { database, getRepository, jsonBody, many, newId, now, one, requirePrincipal, route, stmt } from '@gitknot/core';
import type { App, AppContext, Repository } from '@gitknot/core';
import {
  checkRevision, color, commit, conflict, documentStatement, identifier, markdown,
  notFound, pageBindings, pagedResponse, pageSql, pagination, related, respond, title, uniqueIds,
} from './common.ts';

interface CatalogRow extends Record<string, unknown> {
  id: string; repo_id: string; revision: number; document_revision?: number; created_at: string; updated_at: string;
}
interface Catalog {
  path: string; table: string; prefix: string; capability: string; schema: z.ZodObject<z.ZodRawShape>;
  columns: string[]; versioned?: boolean; inUse?: string;
  validate?: (c: AppContext, repo: Repository, input: Record<string, unknown>, old?: CatalogRow) => Promise<void>;
  after?: (c: AppContext, repo: Repository, id: string, input: Record<string, unknown>) => D1PreparedStatement[];
}

async function readCatalog(c: AppContext, config: Catalog, repo: Repository): Promise<CatalogRow> {
  const row = await one<CatalogRow>(database(c), `SELECT * FROM ${config.table} WHERE repo_id=? AND id=? AND deleted_at IS NULL`, repo.id, c.req.param('id'));
  if (!row) notFound();
  return row;
}

function stored(value: unknown): unknown { return typeof value === 'boolean' ? Number(value) : value ?? null; }

function registerCatalog(app: App, config: Catalog): void {
  const path = `/v1/repos/:repoId/${config.path}`;
  const tags = ['collaboration'];
  route(app, 'GET', path, { summary: `List ${config.table}`, tags, capability: 'contents.read' }, async c => {
    const repo = await getRepository(c, c.req.param('repoId') ?? '');
    const p = pagination(c, `${repo.id}:${config.table}`);
    const rows = await many<CatalogRow>(database(c), `SELECT * FROM ${config.table} WHERE repo_id=? AND deleted_at IS NULL
      AND ${pageSql()} ORDER BY created_at DESC,id DESC LIMIT ?`, repo.id, ...pageBindings(p));
    return pagedResponse(c, rows, p);
  });
  route(app, 'GET', `${path}/:id`, { summary: `Read ${config.prefix}`, tags, capability: 'contents.read' }, async c => {
    const repo = await getRepository(c, c.req.param('repoId') ?? '');
    const value = await readCatalog(c, config, repo);
    if (config.table === 'issue_templates') value.label_ids = (await many<{ label_id: string }>(database(c),
      'SELECT label_id FROM issue_template_labels WHERE repo_id=? AND template_id=? ORDER BY label_id', repo.id, value.id)).map(row => row.label_id);
    return respond(c, value);
  });
  route(app, 'POST', path, { summary: `Create ${config.prefix}`, tags, capability: config.capability, body: config.schema }, async c => {
    const repo = await getRepository(c, c.req.param('repoId') ?? '', config.capability);
    const input = await jsonBody(c, config.schema) as Record<string, unknown>;
    await config.validate?.(c, repo, input);
    const id = newId(config.prefix);
    const at = now();
    const after = config.after?.(c, repo, id, input) ?? [];
    if (config.versioned) after.push(await documentStatement(database(c), {
      repo_id: repo.id, resource_kind: config.prefix, resource_id: id, document_revision: 1,
      title: String(input.title ?? input.name ?? ''), markdown: String(input.markdown ?? ''), actor_id: requirePrincipal(c).id,
    }));
    await commit(c, { repo, resource_id: id, revision: 1, type: `${config.prefix}.created`,
      sql: `INSERT INTO ${config.table}(id,repo_id,${config.columns.join(',')},revision,created_at,updated_at) VALUES (?,?,${config.columns.map(() => '?').join(',')},1,?,?)`,
      bindings: [id, repo.id, ...config.columns.map(key => stored(input[key])), at, at], after });
    return respond(c, { ...input, id, repo_id: repo.id, revision: 1, ...(config.versioned ? { document_revision: 1 } : {}), created_at: at, updated_at: at }, 201);
  });
  // Zod 4 applies defaults inside optional fields; remove create defaults before accepting PATCH.
  const patchShape = Object.fromEntries(Object.entries(config.schema.shape).map(([key, field]) =>
    [key, z.optional(field instanceof z.ZodDefault ? field.removeDefault() : field)]));
  const patchSchema = z.strictObject(patchShape).refine(value => Object.keys(value).length > 0, 'Supply at least one field.');
  route(app, 'PATCH', `${path}/:id`, { summary: `Update ${config.prefix}`, tags, capability: config.capability, body: patchSchema }, async c => {
    const repo = await getRepository(c, c.req.param('repoId') ?? '', config.capability);
    const value = await readCatalog(c, config, repo);
    checkRevision(c, value);
    const input = await jsonBody(c, patchSchema) as Record<string, unknown>;
    await config.validate?.(c, repo, input, value);
    const fields = config.columns.filter(key => Object.hasOwn(input, key));
    const at = now();
    const docChanged = config.versioned && ['title', 'name', 'markdown'].some(key => Object.hasOwn(input, key));
    const updated: CatalogRow = { ...value, ...input, revision: value.revision + 1, updated_at: at,
      ...(config.versioned ? { document_revision: Number(value.document_revision) + Number(docChanged) } : {}) };
    const after = config.after?.(c, repo, value.id, input) ?? [];
    if (config.inUse && ['type', 'format'].some(key => input[key] !== undefined && input[key] !== value[key])) {
      const guard = newId('guard');
      after.push(stmt(database(c), `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN EXISTS(${config.inUse}) THEN 0 ELSE 1 END`, guard, repo.id, value.id),
        stmt(database(c), 'DELETE FROM mutation_guards WHERE id=?', guard));
    }
    if (docChanged) after.push(await documentStatement(database(c), {
      repo_id: repo.id, resource_kind: config.prefix, resource_id: value.id, document_revision: updated.document_revision!,
      title: String(updated.title ?? updated.name ?? ''), markdown: String(updated.markdown ?? ''), actor_id: requirePrincipal(c).id,
    }));
    await commit(c, { repo, resource_id: value.id, revision: updated.revision, type: `${config.prefix}.updated`,
      sql: `UPDATE ${config.table} SET ${fields.map(field => `${field}=?`).join(',')}${fields.length ? ',' : ''}
        revision=revision+1,updated_at=?${docChanged ? ',document_revision=document_revision+1' : ''} WHERE repo_id=? AND id=? AND revision=? AND deleted_at IS NULL`,
      bindings: [...fields.map(key => stored(input[key])), at, repo.id, value.id, value.revision], after,
      data: { changed_fields: Object.keys(input) } });
    return respond(c, updated);
  });
  route(app, 'DELETE', `${path}/:id`, { summary: `Delete ${config.prefix}`, tags, capability: config.capability }, async c => {
    const repo = await getRepository(c, c.req.param('repoId') ?? '', config.capability);
    const value = await readCatalog(c, config, repo);
    checkRevision(c, value);
    if (config.inUse && await one(database(c), config.inUse, repo.id, value.id)) {
      conflict('resource_in_use', 'Move the resources using this entry before deleting it.');
    }
    const at = now();
    await commit(c, { repo, resource_id: value.id, revision: value.revision + 1, type: `${config.prefix}.deleted`,
      sql: `UPDATE ${config.table} SET deleted_at=?,updated_at=?,revision=revision+1 WHERE repo_id=? AND id=? AND revision=?
        ${config.inUse ? `AND NOT EXISTS (${config.inUse})` : ''}`,
      bindings: [at, at, repo.id, value.id, value.revision, ...(config.inUse ? [repo.id, value.id] : [])] });
    return respond(c, { id: value.id, repo_id: repo.id, deleted_at: at, revision: value.revision + 1 });
  });
  if (config.versioned) registerCatalogVersions(app, config);
}

function registerCatalogVersions(app: App, config: Catalog): void {
  const path = `/v1/repos/:repoId/${config.path}/:id/versions`;
  route(app, 'GET', path, { summary: `Read immutable ${config.prefix} Markdown history`, tags: ['markdown'], capability: 'contents.read' }, async c => {
    const repo = await getRepository(c, c.req.param('repoId') ?? '');
    const value = await readCatalog(c, config, repo);
    const p = pagination(c, `${repo.id}:${config.table}:${value.id}:versions`);
    const rows = await many<{ id: string; created_at: string }>(database(c), `SELECT * FROM collaboration_document_versions
      WHERE repo_id=? AND resource_kind=? AND resource_id=? AND ${pageSql()} ORDER BY created_at DESC,id DESC LIMIT ?`,
    repo.id, config.prefix, value.id, ...pageBindings(p));
    return pagedResponse(c, rows, p);
  });
}

export function registerIssueCatalogs(app: App): void {
  registerCatalog(app, {
    path: 'labels', table: 'labels', prefix: 'label', capability: 'issues.triage',
    schema: z.strictObject({ name: title.max(80), color, description: z.string().max(1000).default('') }),
    columns: ['name', 'color', 'description'],
    inUse: 'SELECT 1 FROM (SELECT repo_id,label_id FROM collaboration_item_labels UNION ALL SELECT repo_id,label_id FROM issue_template_labels) WHERE repo_id=? AND label_id=? LIMIT 1',
  });
  registerCatalog(app, {
    path: 'milestones', table: 'milestones', prefix: 'milestone', capability: 'issues.triage', versioned: true,
    schema: z.strictObject({ title, markdown: markdown.default(''), state: z.enum(['open', 'closed']).default('open'), due_at: z.iso.datetime().nullable().default(null) }),
    columns: ['title', 'markdown', 'state', 'due_at'],
    inUse: 'SELECT 1 FROM (SELECT repo_id,milestone_id FROM issues UNION ALL SELECT repo_id,milestone_id FROM pull_requests) WHERE repo_id=? AND milestone_id=? LIMIT 1',
  });
  registerCatalog(app, {
    path: 'issues/statuses', table: 'issue_statuses', prefix: 'issue_status', capability: 'issues.triage',
    schema: z.strictObject({ name: title.max(80), type: z.enum(['backlog', 'open', 'in_progress', 'blocked', 'done', 'cancelled']),
      color: color.default('808080'), position: z.number().int().min(0).max(100000).default(0) }),
    columns: ['name', 'type', 'color', 'position'],
    inUse: 'SELECT 1 FROM (SELECT repo_id,status_id FROM issues UNION ALL SELECT repo_id,status_id FROM issue_templates) WHERE repo_id=? AND status_id=? LIMIT 1',
    validate: async (c, repo, input, old) => {
      if (old && input.type !== undefined && input.type !== old.type
        && await one(database(c), 'SELECT 1 FROM issues WHERE repo_id=? AND status_id=? LIMIT 1', repo.id, old.id)) {
        conflict('status_in_use', 'Move issues to another status before changing this status type.');
      }
    },
  });
  registerCatalog(app, {
    path: 'issues/templates', table: 'issue_templates', prefix: 'issue_template', capability: 'issues.triage', versioned: true,
    schema: z.strictObject({ name: title.max(80), title: z.string().max(300).default(''), markdown,
      description: z.string().max(1000).default(''), status_id: identifier.nullable().default(null),
      enabled: z.boolean().default(true), label_ids: uniqueIds.default([]) }),
    columns: ['name', 'title', 'markdown', 'description', 'status_id', 'enabled'],
    validate: async (c, repo, input) => {
      await related(c, 'issue_statuses', repo.id, input.status_id as string | undefined);
      for (const id of (input.label_ids as string[] | undefined) ?? []) await related(c, 'labels', repo.id, id);
    },
    after: (c, repo, id, input) => input.label_ids === undefined ? [] : [
      stmt(database(c), 'DELETE FROM issue_template_labels WHERE repo_id=? AND template_id=?', repo.id, id),
      ...(input.label_ids as string[]).map(label => stmt(database(c), 'INSERT INTO issue_template_labels(repo_id,template_id,label_id) VALUES (?,?,?)', repo.id, id, label)),
    ],
  });
}

export function registerDiscussionCategories(app: App): void {
  registerCatalog(app, {
    path: 'discussions/categories', table: 'discussion_categories', prefix: 'discussion_category', capability: 'discussions.moderate',
    schema: z.strictObject({ name: title.max(80), description: z.string().max(1000).default(''),
      format: z.enum(['discussion', 'question', 'announcement']), position: z.number().int().min(0).max(100000).default(0) }),
    columns: ['name', 'description', 'format', 'position'],
    inUse: 'SELECT 1 FROM discussions WHERE repo_id=? AND category_id=? LIMIT 1',
    validate: async (c, repo, input, old) => {
      if (old && input.format !== undefined && input.format !== old.format
        && await one(database(c), 'SELECT 1 FROM discussions WHERE repo_id=? AND category_id=? LIMIT 1', repo.id, old.id)) {
        conflict('category_in_use', 'Move discussions before changing this category format.');
      }
    },
  });
}
