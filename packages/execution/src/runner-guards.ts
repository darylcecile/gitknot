import { newId, stmt } from '@gitknot/core';
import type { Database } from '@gitknot/core';

export const databaseClock = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** A failed predicate aborts all dependent effects in the D1 batch. */
export function runnerCondition(db: Database, sql: string, values: unknown[] = []): D1PreparedStatement[] {
  const id = newId('guard');
  return [stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN ${sql} THEN 1 ELSE 0 END`, id, ...values),
    stmt(db, 'DELETE FROM mutation_guards WHERE id=?', id)];
}
