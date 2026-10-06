import { identityBinding } from './authority/identity.ts';
import { newId, now } from './crypto.ts';
import { many, one, stmt } from './db.ts';
import { ApiError } from './errors.ts';
import { cellDatabaseLocation, identityDatabaseLocation, sameDatabaseLocation } from './routing/locations.ts';
import type { Bindings, Database, EventRecord } from './types.ts';

export const globalResourceTypes = ['operation', 'run', 'workflow_operation', 'webhook', 'delivery', 'archive',
  'object', 'attempt', 'runner_pool', 'runner_enrollment', 'runner'] as const;
export type GlobalResourceType = typeof globalResourceTypes[number];
export type ResourceLocatorAuthority = 'identity' | 'repository';
export interface ResourceLocator { resource_id: string; resource_type: GlobalResourceType; repo_id: string | null; authority: ResourceLocatorAuthority }
export type ResourceLocatorInput = Omit<ResourceLocator, 'authority'> & { authority?: ResourceLocatorAuthority };
const accountResources = new Set<GlobalResourceType>(['runner_pool', 'runner_enrollment', 'runner']);

interface ResourceTable { type: GlobalResourceType; table: string; id: string }
const resourceTables: ResourceTable[] = [
  { type: 'operation', table: 'operations', id: 'id' },
  { type: 'run', table: 'workflow_runs', id: 'id' },
  { type: 'run', table: 'workflow_run_requests', id: 'run_id' },
  { type: 'workflow_operation', table: 'workflow_run_requests', id: 'id' },
  { type: 'webhook', table: 'webhooks', id: 'id' },
  { type: 'delivery', table: 'webhook_deliveries', id: 'id' },
  { type: 'archive', table: 'repository_archives', id: 'id' },
  { type: 'object', table: 'object_manifests', id: 'id' },
  { type: 'attempt', table: 'execution_attempts', id: 'id' },
  { type: 'runner_pool', table: 'runner_pools', id: 'id' },
  { type: 'runner_enrollment', table: 'runner_enrollments', id: 'id' },
  { type: 'runner', table: 'runners', id: 'id' },
];
const collections: Record<string, GlobalResourceType> = {
  operations: 'operation', runs: 'run', 'workflow-operations': 'workflow_operation', webhooks: 'webhook',
  deliveries: 'delivery', archives: 'archive', objects: 'object', uploads: 'object', attempts: 'attempt',
  'runner-pools': 'runner_pool', 'runner-enrollments': 'runner_enrollment', runners: 'runner',
};

export function globalResourcePath(path: string): { id: string; type: GlobalResourceType } | null {
  const [, version, collection, id] = path.split('/');
  const type = collection ? collections[collection] : undefined;
  if (version !== 'v1' || !type || !id || !/^[a-z][a-z0-9]*_[A-Za-z0-9_-]{1,120}$/.test(id)) return null;
  return { id, type };
}

export function resourceTypeForEvent(event: Pick<EventRecord, 'type' | 'resource_id'>): GlobalResourceType | null {
  const prefix = event.resource_id.split('_')[0];
  if (prefix === 'op') return event.type.startsWith('workflow.operation.') ? 'workflow_operation' : 'operation';
  return ({ run: 'run', wh: 'webhook', delivery: 'delivery', archive: 'archive', obj: 'object', attempt: 'attempt',
    pool: 'runner_pool', enr: 'runner_enrollment', runner: 'runner' } as Record<string, GlobalResourceType>)[prefix!] ?? null;
}

/** Initial single-D1 resources themselves are a synchronous locator fast path. */
export function requiresResourceLocatorIndex(env: Bindings): boolean {
  return !sameDatabaseLocation(identityDatabaseLocation(env), cellDatabaseLocation(env)) || !!env.SHARD_BINDINGS_JSON || !!env.CELL_BINDINGS_JSON;
}

function validateLocator(locator: ResourceLocatorInput): void {
  if (!globalResourceTypes.includes(locator.resource_type) || !/^[a-z][a-z0-9]*_[A-Za-z0-9_-]{1,120}$/.test(locator.resource_id)
    || locator.repo_id !== null && !/^r_[A-Za-z0-9_-]{1,120}$/.test(locator.repo_id)
    || locator.authority !== undefined && !['identity', 'repository'].includes(locator.authority)
    || locator.authority === 'repository' && locator.repo_id === null) {
    throw new TypeError('Invalid immutable resource locator.');
  }
}

function resolvedLocator(locator: ResourceLocatorInput): ResourceLocator {
  validateLocator(locator);
  return { ...locator, authority: locator.authority ?? (accountResources.has(locator.resource_type) || !locator.repo_id ? 'identity' : 'repository') };
}

function locatorStatement(db: Database, locator: ResourceLocator): D1PreparedStatement {
  validateLocator(locator);
  // The immutable trigger rejects any attempt to bind an existing ID to another
  // repository/type, including an orphan intent from a failed earlier create.
  return stmt(db, `INSERT INTO resource_locators(resource_id,resource_type,repo_id,authority,created_at) VALUES (?,?,?,?,?)
    ON CONFLICT(resource_id) DO UPDATE SET resource_type=excluded.resource_type,repo_id=excluded.repo_id,authority=excluded.authority`,
  locator.resource_id, locator.resource_type, locator.repo_id, locator.authority, now());
}

async function registerLocators(env: Bindings, locators: ResourceLocator[]): Promise<void> {
  if (!locators.length) return;
  const db = identityBinding(env).withSession('first-primary');
  try { await db.batch(locators.map(locator => locatorStatement(db, locator))); }
  catch (error) {
    if (/resource_locator_immutable/.test(String(error))) {
      throw new ApiError(409, 'resource_locator_conflict', 'This resource ID is already assigned to a different immutable resource.');
    }
    throw new ApiError(503, 'resource_locator_unavailable', 'GitKnot could not durably register this resource ID. Retry the same request.');
  }
}

/** Must complete before the resource's create/intent batch is acknowledged. */
export async function registerResourceLocator(env: Bindings, locator: ResourceLocatorInput): Promise<void> {
  await registerLocators(env, [resolvedLocator(locator)]);
}

export async function registerEventResourceLocator(env: Bindings, event: EventRecord, required = false,
  authority?: ResourceLocatorAuthority): Promise<ResourceLocator | null> {
  const type = resourceTypeForEvent(event);
  if (!type) return null;
  if (!required && !requiresResourceLocatorIndex(env) && !await one(identityBinding(env),
    "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='resource_locators'")) return null;
  const locator = resolvedLocator({ resource_id: event.resource_id, resource_type: type, repo_id: event.repo_id ?? null,
    ...(accountResources.has(type) ? { authority } : {}) });
  await registerResourceLocator(env, locator);
  return locator;
}

async function tableNames(db: Database): Promise<Set<string>> {
  return new Set((await many<{ name: string }>(db, 'SELECT name FROM sqlite_schema WHERE type=\'table\''))
    .map(row => row.name));
}

/** Older retained rows may reveal an immutable repo ID, never current authority. */
async function legacyLocatorHint(env: Bindings, resourceId: string, type: GlobalResourceType): Promise<ResourceLocator | null> {
  const db = identityBinding(env).withSession('first-primary');
  const available = await tableNames(db);
  for (const entry of resourceTables.filter(entry => entry.type === type && available.has(entry.table))) {
    const hint = await one<{ repo_id: string | null }>(db, `SELECT repo_id FROM ${entry.table} WHERE ${entry.id}=? LIMIT 1`, resourceId);
    if (hint) return resolvedLocator({ resource_id: resourceId, resource_type: type, repo_id: hint.repo_id });
  }
  return null;
}

export async function resolveResourceLocator(env: Bindings, resourceId: string, type: GlobalResourceType): Promise<ResourceLocator | null> {
  let locator: ResourceLocator | null;
  try {
    locator = await one<ResourceLocator>(identityBinding(env).withSession('first-primary'),
      'SELECT resource_id,resource_type,repo_id,authority FROM resource_locators WHERE resource_id=?', resourceId);
  } catch (error) {
    // Older single-database test/rolling-upgrade schemas still have the real
    // resource row as their locator. Multiple placements require the migration.
    if (requiresResourceLocatorIndex(env) || !/no such table.*resource_locators/i.test(String(error))) throw error;
    return legacyLocatorHint(env, resourceId, type);
  }
  if (locator) return locator.resource_type === type ? locator : null;
  const hint = await legacyLocatorHint(env, resourceId, type);
  if (hint) await registerResourceLocator(env, hint);
  return hint;
}

/** Source writes must be fenced while this final pre-cutover backfill runs. */
export async function registerRepositoryResourceLocators(env: Bindings, db: Database, repoId: string): Promise<void> {
  if (!/^r_[A-Za-z0-9_-]{1,120}$/.test(repoId)) throw new TypeError('Invalid repository locator scope.');
  const available = await tableNames(db);
  for (const entry of resourceTables.filter(entry => !accountResources.has(entry.type) && available.has(entry.table))) {
    let cursor = '';
    for (;;) {
      const rows = await many<{ id: string }>(db, `SELECT DISTINCT ${entry.id} AS id FROM ${entry.table}
        WHERE repo_id=? AND ${entry.id}>? ORDER BY ${entry.id} LIMIT 100`, repoId, cursor);
      if (!rows.length) break;
      await registerLocators(env, rows.map(row => resolvedLocator({ resource_id: row.id, resource_type: entry.type, repo_id: repoId })));
      cursor = rows.at(-1)!.id;
    }
  }
}

/** Optional local guard for creators that retain the synchronous single-DB path. */
export function resourceLocatorGuard(db: Database, locator: ResourceLocator): D1PreparedStatement[] {
  const id = newId('guard');
  return [stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN EXISTS (
    SELECT 1 FROM resource_locators WHERE resource_id=? AND resource_type=? AND repo_id IS ? AND authority=?
  ) THEN 1 ELSE 0 END`, id, locator.resource_id, locator.resource_type, locator.repo_id, locator.authority),
  stmt(db, 'DELETE FROM mutation_guards WHERE id=?', id)];
}
