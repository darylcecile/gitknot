import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

type QueryResult = D1Result<Record<string, unknown>>;

function values(parameters: unknown[]): SQLInputValue[] {
  return parameters.map(value => {
    if (value === undefined) throw new TypeError('D1 bindings cannot be undefined.');
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError(`Unsupported D1 binding type: ${typeof value}`);
  });
}

class Prepared {
  constructor(readonly owner: SqliteD1, readonly sql: string, readonly parameters: unknown[] = []) {}

  bind(...parameters: unknown[]): D1PreparedStatement {
    return new Prepared(this.owner, this.sql, parameters) as unknown as D1PreparedStatement;
  }

  perform(): QueryResult {
    const started = performance.now();
    const query = this.owner.sqlite.prepare(this.sql);
    const args = values(this.parameters);
    const returnsRows = query.columns().length > 0;
    let results: Record<string, unknown>[] = [];
    let changes = 0;
    let lastRowId = 0;
    if (returnsRows) {
      results = query.all(...args);
      if (!/^\s*(SELECT|PRAGMA|EXPLAIN)\b/i.test(this.sql)) {
        const changed = this.owner.sqlite.prepare('SELECT changes() AS changes, last_insert_rowid() AS last_row_id').get()!;
        changes = Number(changed.changes);
        lastRowId = Number(changed.last_row_id);
      }
    } else {
      const result = query.run(...args);
      changes = Number(result.changes);
      lastRowId = Number(result.lastInsertRowid);
    }
    if (changes) this.owner.bookmark++;
    return {
      success: true, results,
      meta: { duration: performance.now() - started, changes, last_row_id: lastRowId,
        changed_db: changes > 0, size_after: 0, rows_read: results.length, rows_written: changes },
    } as QueryResult;
  }

  async all<T>(): Promise<D1Result<T>> { return this.perform() as unknown as D1Result<T>; }
  async run<T>(): Promise<D1Result<T>> { return this.perform() as unknown as D1Result<T>; }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.perform().results[0];
    return row ? (column ? row[column] : row) as T : null;
  }

  async raw<T>(options?: { columnNames?: boolean }): Promise<T[]> {
    const rows = this.perform().results;
    if (!rows.length) return [];
    const result: unknown[][] = rows.map(row => Object.values(row));
    if (options?.columnNames) result.unshift(Object.keys(rows[0]!));
    return result as T[];
  }
}

/** Real SQLite executes the production schema, constraints and SQL transactions in high-level tests. */
export class SqliteD1 {
  readonly sqlite: DatabaseSync;
  bookmark = 0;

  constructor(filename = ':memory:') {
    this.sqlite = new DatabaseSync(filename);
    this.sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  }

  prepare(sql: string): D1PreparedStatement { return new Prepared(this, sql) as unknown as D1PreparedStatement; }
  withSession(_constraint?: string): D1DatabaseSession { return this as unknown as D1DatabaseSession; }
  getBookmark(): string { return `test-primary-${this.bookmark}`; }

  async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = statements.map(statement => (statement as unknown as Prepared).perform());
      this.sqlite.exec('COMMIT');
      return result as unknown as D1Result<T>[];
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }

  async exec(sql: string): Promise<D1ExecResult> {
    const start = performance.now();
    this.sqlite.exec(sql);
    return { count: 1, duration: performance.now() - start };
  }

  close(): void { this.sqlite.close(); }
  binding(): D1Database { return this as unknown as D1Database; }
}

export async function createTestDatabase(options: { filename?: string; migrations?: string[] } = {}): Promise<SqliteD1> {
  const database = new SqliteD1(options.filename);
  const files = options.migrations ?? (await readdir(resolve(projectRoot, 'migrations'))).filter(name => name.endsWith('.sql')).sort();
  for (const file of files) {
    try { database.sqlite.exec(await readFile(resolve(projectRoot, 'migrations', file), 'utf8')); }
    catch (error) { database.close(); throw new Error(`Migration ${file} failed`, { cause: error }); }
  }
  return database;
}
