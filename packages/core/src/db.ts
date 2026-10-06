import type { AppContext, Database } from './types.ts';

export type SqlValue = string | number | null | ArrayBuffer | Uint8Array;

export function database(c: AppContext): D1DatabaseSession {
  const existing = c.get('database');
  if (existing) return existing;
  const session = c.env.DB.withSession('first-primary');
  c.set('database', session);
  return session;
}

export function stmt(db: Database, sql: string, ...values: unknown[]): D1PreparedStatement {
  return values.length ? db.prepare(sql).bind(...values) : db.prepare(sql);
}

export async function one<T>(db: Database, sql: string, ...values: unknown[]): Promise<T | null> {
  return stmt(db, sql, ...values).first<T>();
}

export async function many<T>(db: Database, sql: string, ...values: unknown[]): Promise<T[]> {
  const result = await stmt(db, sql, ...values).all<T>();
  if (!result.success) throw new Error('The metadata query failed.');
  return result.results;
}

export async function execute(db: Database, sql: string, ...values: unknown[]): Promise<D1Result> {
  const result = await stmt(db, sql, ...values).run();
  if (!result.success) throw new Error('The metadata mutation failed.');
  return result;
}

export function json<T>(value: string | null | undefined, fallback: T): T {
  return value == null ? fallback : JSON.parse(value) as T;
}
