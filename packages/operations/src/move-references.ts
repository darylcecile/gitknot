import { Context } from 'hono';
import { identityBinding, many, now, one, readRepositoryAuthority, sha256, stmt } from '@gitknot/core';
import type { AppEnv, Bindings } from '@gitknot/core';

type IdentityTable = 'users' | 'accounts' | 'principals' | 'applications' | 'installations' | 'repositories';
const tables = new Set<IdentityTable>(['users', 'accounts', 'principals', 'applications', 'installations', 'repositories']);
const columns = { users: 'id', accounts: 'id,type,owner_user_id', principals: 'id,kind,user_id,account_id',
  applications: 'id,account_id', installations: 'id,application_id,account_id' } as const;

/** Minimal, disabled FK material. Grants, credentials, keys and account policy are never copied. */
export class MoveReferences {
  private readonly seen = new Set<string>();
  constructor(private readonly env: Bindings, private readonly movingRepo: string) {}

  async forRows(table: string, rows: Record<string, unknown>[]): Promise<void> {
    const foreign = await many<{ table: IdentityTable; from: string; to: string }>(this.env.DB, `PRAGMA foreign_key_list(${table})`);
    for (const reference of foreign) {
      if (!tables.has(reference.table) || reference.to !== 'id') continue;
      for (const row of rows) if (typeof row[reference.from] === 'string') await this.ensure(reference.table, row[reference.from] as string);
    }
  }

  private async ensure(table: IdentityTable, id: string): Promise<void> {
    const key = `${table}:${id}`;
    if (this.seen.has(key) || table === 'repositories' && id === this.movingRepo) return;
    if (await one(this.env.DB, `SELECT 1 FROM ${table} WHERE id=?`, id)) { this.seen.add(key); return; }
    if (table === 'repositories') await this.repository(id);
    else {
      const row = await one<Record<string, unknown>>(identityBinding(this.env).withSession('first-primary'),
        `SELECT ${columns[table]} FROM ${table} WHERE id=?`, id);
      if (!row) throw new Error(`move_identity_reference_missing:${table}`);
      if (table === 'users') await this.user(id);
      if (table === 'accounts') await this.account(id, row);
      if (table === 'principals') await this.principal(id, row);
      if (table === 'applications') await this.application(id, row);
      if (table === 'installations') await this.installation(id, row);
    }
    this.seen.add(key);
  }

  private async user(id: string): Promise<void> {
    const key = (await sha256(id)).slice(0, 40);
    await stmt(this.env.DB, `INSERT INTO users(id,username,email,display_name,disabled_at,created_at,updated_at)
      VALUES(?,?,?,'Metadata reference',?,?,?) ON CONFLICT(id) DO NOTHING`, id, `fk-${key}`, `fk-${key}@metadata.invalid`, now(), now(), now()).run();
  }

  private async account(id: string, row: Record<string, unknown>): Promise<void> {
    if (typeof row.owner_user_id === 'string') await this.ensure('users', row.owner_user_id);
    await stmt(this.env.DB, `INSERT INTO accounts(id,type,slug,name,owner_user_id,disabled_at,created_at,updated_at)
      VALUES(?,?,?,'Metadata reference',?,?,?,?) ON CONFLICT(id) DO NOTHING`, id, row.type, `fk-${(await sha256(id)).slice(0, 40)}`,
    row.owner_user_id, now(), now(), now()).run();
  }

  private async principal(id: string, row: Record<string, unknown>): Promise<void> {
    if (typeof row.user_id === 'string') await this.ensure('users', row.user_id);
    if (typeof row.account_id === 'string') await this.ensure('accounts', row.account_id);
    await stmt(this.env.DB, `INSERT INTO principals(id,kind,user_id,account_id,name,disabled_at,created_by,created_at,updated_at)
      VALUES(?,?,?,?,'Metadata reference',?,'system:operations',?,?) ON CONFLICT(id) DO NOTHING`, id, row.kind, row.user_id, row.account_id, now(), now(), now()).run();
  }

  private async application(id: string, row: Record<string, unknown>): Promise<void> {
    await this.ensure('accounts', String(row.account_id));
    await stmt(this.env.DB, `INSERT INTO applications(id,account_id,name,capabilities_json,disabled_at,created_by,created_at,updated_at)
      VALUES(?,?,'Metadata reference','[]',?,'system:operations',?,?) ON CONFLICT(id) DO NOTHING`, id, row.account_id, now(), now(), now()).run();
  }

  private async installation(id: string, row: Record<string, unknown>): Promise<void> {
    await this.ensure('accounts', String(row.account_id));
    await this.ensure('principals', id);
    await this.ensure('applications', String(row.application_id));
    await stmt(this.env.DB, `INSERT INTO installations(id,application_id,account_id,capabilities_json,repository_ids_json,suspended_at,installed_by,created_at,updated_at)
      VALUES(?,?,?,'[]','[]',?,'system:operations',?,?) ON CONFLICT(id) DO NOTHING`, id, row.application_id, row.account_id, now(), now(), now()).run();
  }

  private async repository(id: string): Promise<void> {
    const context = new Context<AppEnv>(new Request('https://internal.gitknot.com/move-reference'), { env: this.env });
    const source = await readRepositoryAuthority(context, id);
    if (!source) throw new Error('move_repository_reference_missing');
    await this.ensure('accounts', source.owner_id);
    const name = `fk-${(await sha256(id)).slice(0, 40)}`;
    await stmt(this.env.DB, `INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,routing_epoch,created_by,created_at,updated_at)
      VALUES(?,?,?,?,'private','moving',?,?,?,?,?, ?,?) ON CONFLICT(id) DO NOTHING`, id, source.owner_id, name, name,
    source.cell_id, source.shard_id, `metadata-${id}`, source.routing_epoch, source.created_by, now(), now()).run();
  }
}
