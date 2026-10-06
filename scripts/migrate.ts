import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { coreShards, directoryName, environment, localDatabaseId, LOCAL_STATE, ROOT, resourceName } from '../infra/environment.ts';
import { main } from '../infra/process.ts';
import { localCfJson } from '../infra/local-cf.ts';

interface Migration { name: string; path: string; sha256: string }
interface Target { name: string; source: string; kind: 'core' | 'directory' | 'search' }

export async function discoverMigrations(directory: string, allowVirtualTables: boolean): Promise<Migration[]> {
  const names = (await readdir(directory)).filter(name => /^\d+[_-].+\.sql$/.test(name)).sort((a, b) => {
    const order = Number.parseInt(a, 10) - Number.parseInt(b, 10);
    return order || (a < b ? -1 : a > b ? 1 : 0);
  });
  if (!names.length) throw new Error(`No numbered SQL migrations found in ${directory}.`);
  return Promise.all(names.map(async name => {
    const path = join(directory, name);
    const sql = await readFile(path, 'utf8');
    if (!allowVirtualTables && /CREATE\s+VIRTUAL\s+TABLE/i.test(sql)) throw new Error(`FTS/virtual tables must remain in SEARCH_DB: ${path}`);
    return { name, path, sha256: createHash('sha256').update(sql).digest('hex') };
  }));
}

function rawRows(value: unknown): unknown[][] {
  const data = Array.isArray(value) ? value : [value];
  return data.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const result = item as { results?: { rows?: unknown[][] }; result?: unknown; rows?: unknown[][]; success?: boolean };
    if (result.success === false) throw new Error('Local D1 rejected the migration bookkeeping query.');
    if (result.result) return rawRows(result.result);
    return result.results?.rows ?? result.rows ?? [];
  });
}

async function localRaw(database: string, sql: string): Promise<unknown[][]> {
  return rawRows(await localCfJson(['d1', 'raw', database, '--local', '--persist-to', LOCAL_STATE, '--sql', sql]));
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function migrateTarget(target: Target, listOnly: boolean): Promise<void> {
  const id = localDatabaseId(target.name);
  const migrations = await discoverMigrations(target.source, target.kind === 'search');
  const directory = join(ROOT, '.gitknot', 'migrations', target.kind);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const migration of migrations) {
    const sql = await readFile(migration.path, 'utf8');
    // cf appends its filename receipt and sends each file as a single D1 batch.
    // Keep our content hash in that same transaction, including partial runs.
    await writeFile(join(directory, migration.name), `${sql}\nINSERT INTO gitknot_migration_checksums(name,sha256) VALUES (${quote(migration.name)},${quote(migration.sha256)});\n`);
  }
  if (listOnly) {
    console.log(JSON.stringify(await localCfJson(['d1', 'migrations', 'list', id, '--dir', directory, '--local', '--persist-to', LOCAL_STATE]), null, 2));
    return;
  }
  const hashes = new Map((await localRaw(id, 'CREATE TABLE IF NOT EXISTS gitknot_migration_checksums (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL); SELECT name, sha256 FROM gitknot_migration_checksums')).map(row => [String(row[0]), String(row[1])]));
  for (const migration of migrations) {
    const previous = hashes.get(migration.name);
    if (previous && previous !== migration.sha256) throw new Error(`Previously applied migration changed: ${migration.name}. Add a new numbered migration.`);
  }
  await localCfJson(['d1', 'migrations', 'apply', id, '--dir', directory, '--local', '--persist-to', LOCAL_STATE]);
  const applied = new Map((await localRaw(id, 'SELECT name,sha256 FROM gitknot_migration_checksums')).map(row => [String(row[0]), String(row[1])]));
  if (migrations.some(migration => applied.get(migration.name) !== migration.sha256)) throw new Error(`${target.name}: a migration checksum receipt is missing; inspect local state before adopting an unverified pre-existing schema.`);
  console.log(`Local ${target.kind} schema ready: ${target.name} (${id}).`);
}

export async function migrateLocal(options: { database?: string; list?: boolean } = {}): Promise<void> {
  const env = environment('development');
  const targets: Target[] = [
    ...coreShards(env).map(shard => ({ name: shard.name, source: join(ROOT, 'migrations'), kind: 'core' as const })),
    { name: directoryName(env), source: join(ROOT, 'infra/sql/directory'), kind: 'directory' },
    { name: resourceName(env, 'search'), source: join(ROOT, 'ops/search'), kind: 'search' },
  ];
  const selected = options.database && options.database !== 'all' ? targets.filter(target => target.kind === options.database || target.name === options.database) : targets;
  if (!selected.length) throw new Error(`Unknown local database: ${options.database}`);
  for (const target of selected) await migrateTarget(target, options.list ?? false);
}

async function migrateMain(): Promise<void> {
  const { values } = parseArgs({ options: { local: { type: 'boolean', default: false }, database: { type: 'string', default: 'all' }, list: { type: 'boolean', default: false } }, strict: true });
  if (!values.local) throw new Error('This migration tool requires --local. It has no remote migration path.');
  await migrateLocal(values);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(migrateMain);
