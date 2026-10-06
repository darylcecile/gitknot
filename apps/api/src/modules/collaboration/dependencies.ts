import { z } from 'zod';
import { database, jsonBody, listResponse, many, newId, now, one, requirePrincipal, route, stmt } from '@gitknot/core';
import type { App } from '@gitknot/core';
import {
  assertAcyclic, checkRevision, commit, dependencyFence, getItem, identifier, itemFence,
  itemTouch, nextCursor, notFound, pageBindings, pageSql, pagination, respond, updateItem,
} from './common.ts';
import { pullDetails } from './patches.ts';

interface Dependency { id: string; repo_id: string; depends_on_id: string; created_at: string; revision: number }

export function registerDependencies(app: App, type: 'issue' | 'pull'): void {
  const kind = type === 'issue' ? 'issue' : 'pull_request';
  const collection = type === 'issue' ? 'issues' : 'pulls';
  const capability = type === 'issue' ? 'issues.triage' : 'pull_requests.write';
  const table = type === 'issue' ? 'issue_dependencies' : 'pull_dependencies';
  const column = type === 'issue' ? 'issue_id' : 'pull_id';
  const path = `/v1/repos/:repoId/${collection}/:itemId/dependencies`;
  route(app, 'GET', path, { summary: `List ${type} dependencies`, tags: [collection], capability: 'contents.read' }, async c => {
    const { item, repo } = await getItem(c, kind, c.req.param('itemId'));
    const p = pagination(c, `${repo.id}:${item.id}:dependencies`);
    const rows = await many<Dependency>(database(c), `SELECT * FROM ${table} WHERE repo_id=? AND ${column}=?
      AND ${pageSql()} ORDER BY created_at DESC,id DESC LIMIT ?`, repo.id, item.id, ...pageBindings(p));
    const visible: object[] = [];
    for (const row of rows.slice(0, p.limit)) {
      const target = await getItem(c, kind, row.depends_on_id, 'contents.read', repo.id);
      visible.push({ ...row, dependency: { id: target.item.id, title: target.item.title, state: target.item.state, revision: target.item.revision } });
    }
    return listResponse(c, visible, rows.length > p.limit ? nextCursor(p, rows[p.limit - 1]) : null);
  });
  const schema = z.strictObject({ depends_on_id: identifier });
  route(app, 'POST', path, { summary: `Add an acyclic ${type} dependency`, tags: [collection], capability, body: schema }, async c => {
    const { item, repo } = await getItem(c, kind, c.req.param('itemId'), capability);
    checkRevision(c, item);
    const input = await jsonBody(c, schema);
    const target = (await getItem(c, kind, input.depends_on_id, 'contents.read', repo.id)).item;
    await assertAcyclic(c, type, repo.id, item.id, target.id);
    const id = newId('dep');
    const at = now();
    const stackBase = type === 'pull' ? (await pullDetails(c, target)).head_oid : null;
    const updated = await updateItem(c, repo, item, `${kind}.dependency_added`, {}, [
      ...itemFence(database(c), target), ...dependencyFence(database(c), type, repo.id, item.id, target.id),
      stmt(database(c), `INSERT INTO ${table}(id,repo_id,${column},depends_on_id,created_by,created_at,revision${type === 'pull' ? ',base_oid' : ''}) VALUES (?,?,?,?,?,?,1${type === 'pull' ? ',?' : ''})`,
        id, repo.id, item.id, target.id, requirePrincipal(c).id, at, ...(type === 'pull' ? [stackBase] : [])),
    ], { dependency_id: id, depends_on_id: target.id });
    return respond(c, { id, repo_id: repo.id, [column]: item.id, depends_on_id: target.id, revision: 1, item_revision: updated.revision, created_at: at }, 201);
  });
  route(app, 'DELETE', `${path}/:id`, { summary: `Remove ${type} dependency`, tags: [collection], capability }, async c => {
    const { item, repo } = await getItem(c, kind, c.req.param('itemId'), capability);
    const value = await one<Dependency>(database(c), `SELECT * FROM ${table} WHERE repo_id=? AND ${column}=? AND id=?`, repo.id, item.id, c.req.param('id'));
    if (!value) notFound();
    checkRevision(c, value);
    await getItem(c, kind, value.depends_on_id, 'contents.read', repo.id);
    await commit(c, { repo, item, resource_id: value.id, revision: value.revision + 1, type: `${kind}.dependency_removed`,
      sql: `DELETE FROM ${table} WHERE repo_id=? AND ${column}=? AND id=? AND revision=?`,
      bindings: [repo.id, item.id, value.id, value.revision], after: [...itemFence(database(c), item), itemTouch(database(c), item)],
      data: { depends_on_id: value.depends_on_id } });
    return respond(c, { id: value.id, deleted: true, revision: value.revision + 1, item_revision: item.revision + 1 });
  });
}
