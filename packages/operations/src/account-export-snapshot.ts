import { ApiError, canonicalJson, identityBinding, many, mutationGuard, mutationStatements, newId, now, one, requestPolicies, sha256, stmt } from '@gitknot/core';
import type { Database, Principal, Repository } from '@gitknot/core';
import { backgroundContext } from './authorization.ts';
import { accountExport, accountRepositoryInventory, authorizeAccountExport, authorizeExportRepository } from './account-export-state.ts';
import { accountExportCapabilities, accountExportReadCapabilities } from './account-export-types.ts';
import type { AccountExport } from './account-export-types.ts';
import type { OperationsBindings } from './types.ts';
import { collaborationUserStateInventory } from '../../../apps/api/src/modules/collaboration/user-state.ts';

interface Scope { table: string; where: string; values: unknown[]; omit?: string[]; fields?: Record<string, string> }
const secretColumns = new Set(['password_hash', 'token_hash', 'token_prefix', 'code_hash', 'salt', 'key_id', 'last_used_ip_hash', 'credential_hash',
  'cleanup_lease_hash', 'runner_credential_hash', 'registration_hash', 'ciphertext', 'iv', 'wrapped_dek', 'encrypted_private_key', 'secret_hash', 'unsubscribe_token_hash']);

function scopes(accountId: string, userId: string | null, personal: boolean): Scope[] {
  const owned = (table: string, omit?: string[]): Scope => ({ table, where: 'account_id=?', values: [accountId], omit });
  const invoices = (table: string): Scope => ({ table, where: 'invoice_id IN (SELECT id FROM billing_invoices WHERE account_id=?)', values: [accountId] });
  return [
    { table: 'accounts', where: 'id=?', values: [accountId] },
    { table: 'users', where: 'id=?', values: [personal ? userId : null] },
    ...['memberships', 'teams', 'team_members', 'account_policies', 'access_grants', 'invitations', 'applications', 'installations'].map(table => owned(table)),
    { table: 'principals', where: 'account_id=? OR id IN (SELECT principal_id FROM memberships WHERE account_id=?)', values: [accountId, accountId] },
    { table: 'roles', where: 'account_id=? OR built_in=1', values: [accountId] },
    { table: 'role_capabilities', where: 'role_id IN (SELECT id FROM roles WHERE account_id=? OR built_in=1)', values: [accountId] },
    { table: 'credentials', where: 'principal_id IN (SELECT id FROM principals WHERE account_id=?)', values: [accountId] },
    ...['passkeys', 'user_mfa', 'recovery_codes', 'email_preferences'].map(table => ({ table, where: 'user_id=?', values: [personal ? userId : null] })),
    ...['billing_accounts', 'billing_budgets', 'billing_invoices', 'billing_credits', 'billing_alerts', 'billing_subscription_changes', 'billing_plan_segments',
      'billing_seat_events', 'billing_seat_reservations', 'billing_payment_events'].map(table => owned(table, ['request_hash'])),
    ...['billing_invoice_entries', 'billing_invoice_lines', 'billing_credit_applications'].map(invoices),
    { table: 'billing_ledger', where: 'account_id=? AND operating_cost=0', values: [accountId] },
    { table: 'billing_storage_objects', where: "account_id=? AND coordinator_id='account:'||? AND COALESCE(json_extract(body_json,'$.placement_shadow'),0)=0", values: [accountId, accountId], omit: ['body_json', 'coordinator_id', 'object_key'] },
    { table: 'billing_reservations', where: "account_id=? AND coordinator_id='account:'||?", values: [accountId, accountId], omit: ['body_json', 'fence', 'maximum_platform_units', 'coordinator_id'] },
    { table: 'billing_prices', where: 'id IN (SELECT price_id FROM billing_ledger WHERE account_id=? AND operating_cost=0)', values: [accountId], omit: ['platform_unit_price_units'] },
    { table: 'billing_plans', where: 'id IN (SELECT plan_id FROM billing_accounts WHERE account_id=?)', values: [accountId] },
    ...['runner_pools', 'runner_enrollments', 'runners'].map(table => owned(table)),
    ...['federation_providers', 'federation_org_policies', 'federation_subjects', 'federation_scim_users', 'federation_scim_groups', 'federation_scim_group_members', 'federation_team_memberships'].map(table => owned(table)),
    owned('vault_entries'),
    { ...owned('vault_versions'), fields: { plain_value: "CASE WHEN EXISTS(SELECT 1 FROM vault_entries e WHERE e.id=vault_versions.entry_id AND e.kind='variable') THEN plain_value ELSE NULL END" } },
    owned('vault_version_revocations'),
    { table: 'object_manifests', where: "account_id=? AND repo_id IS NULL AND kind NOT IN ('account_export_chunk','archive_chunk','scan_chunk','collaboration_code_scan')", values: [accountId], omit: ['billing_fence', 'billing_reservation_id', 'object_key'] },
    { table: 'audit_log', where: "account_id=? AND action NOT GLOB 'draft.*' AND resource_id NOT GLOB 'draft_*'", values: [accountId], omit: ['details_json', 'credential_id'] },
    ...collaborationUserStateInventory.map(scope => ({ table: scope.table,
      where: `${scope.user_column}=?${scope.context_column ? ` AND (${scope.context_column}=?${personal ? ` OR ${scope.context_column} IS NULL` : ''})` : ''}`,
      values: scope.context_column ? [userId, accountId] : [personal ? userId : null] })),
  ];
}

async function jsonRow(db: Database, scope: Scope): Promise<string> {
  const columns = (await many<{ name: string }>(db, `PRAGMA table_info(${scope.table})`)).map(row => row.name)
    .filter(name => !secretColumns.has(name) && !scope.omit?.includes(name));
  const objects: string[] = [];
  for (let offset = 0; offset < columns.length; offset += 16) {
    const object = `json_object(${columns.slice(offset, offset + 16).map(name => `'${name}',${scope.fields?.[name] ?? `"${name}"`}`).join(',')})`;
    objects.push(`substr(${object},2,length(${object})-2)`);
  }
  return `('{'||${objects.join("||','||")}||'}')`;
}

export async function materializeAccountExport(env: OperationsBindings, exported: AccountExport, principal: Principal): Promise<AccountExport> {
  if (exported.account_snapshot_at) return exported;
  await authorizeAccountExport(env, principal, exported);
  const db = identityBinding(env).withSession('first-primary');
  const repositories = await accountRepositoryInventory(env, principal, exported.account_id);
  for (const repository of repositories) await authorizeExportRepository(env, principal, repository.id);
  const account = (await one<{ type: string; owner_user_id: string | null }>(db, 'SELECT type,owner_user_id FROM accounts WHERE id=?', exported.account_id))!;
  const available = new Set((await many<{ name: string }>(db, "SELECT name FROM sqlite_schema WHERE type='table'")).map(row => row.name));
  const selected = scopes(exported.account_id, principal.user_id, account.type === 'user');
  if (selected.some(scope => !available.has(scope.table))) throw new Error('account_export_schema_incomplete');
  const guard = newId('guard');
  const statements: D1PreparedStatement[] = [stmt(db, `UPDATE account_exports SET state='capturing',account_snapshot_at=?,tables_json=?,repository_set_sha256=?,revision=revision+1,updated_at=?
    WHERE id=? AND account_snapshot_at IS NULL AND state IN ('queued','capturing') AND EXISTS(SELECT 1 FROM operations o WHERE o.id=account_exports.operation_id AND o.status<>'cancelled')`,
  now(), canonicalJson(selected.map(scope => scope.table)), await sha256(canonicalJson(repositories.map(row => row.id).sort())), now(), exported.id),
  mutationGuard(db, guard), stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard)];
  for (const scope of selected) statements.push(stmt(db, `INSERT INTO account_export_rows(export_id,table_name,row_key,data_json)
    SELECT ?,?,rowid,${await jsonRow(db, scope)} FROM ${scope.table} WHERE ${scope.where}`, exported.id, scope.table, ...scope.values));
  for (const repository of repositories) {
    const id = `op_axr_${(await sha256(`${exported.id}:${repository.id}`)).slice(0, 48)}`;
    statements.push(stmt(db, 'INSERT INTO account_export_repositories(export_id,repo_id,operation_id,archive_id) VALUES(?,?,?,?)', exported.id, repository.id, id, `archive_${id}`),
      ...accountExportReadCapabilities.map(capability => stmt(db, 'INSERT OR IGNORE INTO account_export_audiences(export_id,repo_id,capability) VALUES(?,?,?)', exported.id, repository.id, capability)));
  }
  for (const scope of collaborationUserStateInventory) {
    for (const column of scope.repository_columns) statements.push(stmt(db, `INSERT OR IGNORE INTO account_export_audiences(export_id,repo_id,capability)
      SELECT export_id,json_extract(data_json,?),'contents.read' FROM account_export_rows WHERE export_id=? AND table_name=? AND json_extract(data_json,?) IS NOT NULL`,
    `$.${column}`, exported.id, scope.table, `$.${column}`));
    if ('json_repository_columns' in scope) for (const path of scope.json_repository_columns) {
      const [column, field] = path.split('.');
      statements.push(stmt(db, `INSERT OR IGNORE INTO account_export_audiences(export_id,repo_id,capability)
        SELECT r.export_id,j.value,'contents.read' FROM account_export_rows r,json_each(json_extract(r.data_json,?),?) j
          WHERE r.export_id=? AND r.table_name=?`, `$.${column}`, `$.${field}`, exported.id, scope.table));
    }
  }
  const context = backgroundContext(env, principal);
  await requestPolicies(context, accountExportCapabilities.map(capability => ({ capability, scope: { account_id: exported.account_id } })));
  await authorizeAccountExport(env, principal, exported);
  try { await db.batch(await mutationStatements(context, { statements, event: { type: 'account.export.snapshot_captured', resource_id: exported.id,
    resource_revision: exported.revision + 1, account_id: exported.account_id, actor_id: principal.id, data: { repository_count: repositories.length } } })); }
  catch (error) { if (!(await accountExport(env, exported.id)).account_snapshot_at) throw error; }
  const captured = await accountExport(env, exported.id);
  await authorizeAccountExport(env, principal, captured, true);
  return captured;
}

export async function verifyAccountRepositorySet(env: OperationsBindings, exported: AccountExport, principal: Principal): Promise<void> {
  const repositories: Repository[] = await accountRepositoryInventory(env, principal, exported.account_id);
  if (await sha256(canonicalJson(repositories.map(row => row.id).sort())) !== exported.repository_set_sha256) throw new ApiError(409, 'account_export_repository_membership_changed', 'Account repository membership changed during capture.');
}
