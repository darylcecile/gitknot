import { ApiError, authorize, getRepository, identityBinding, many, one, readRepositoryAuthority, selectIdentityDatabase } from '@gitknot/core';
import type { Principal, Repository } from '@gitknot/core';
import { backgroundContext, rehydrateOperationPrincipal } from './authorization.ts';
import { accountExportCapabilities, accountExportReadCapabilities } from './account-export-types.ts';
import type { AccountExport } from './account-export-types.ts';
import type { OperationsBindings } from './types.ts';
import { userScope } from '../../../apps/api/src/modules/collaboration/user-state.ts';
import { requireAccountDraftClosure } from './archive-privacy.ts';

export async function accountExport(env: OperationsBindings, id: string): Promise<AccountExport> {
  const row = await one<AccountExport>(identityBinding(env).withSession('first-primary'), 'SELECT * FROM account_exports WHERE id=?', id);
  if (!row) throw new ApiError(404, 'not_found', 'The account export was not found.');
  return row;
}

export async function accountExportPrincipal(env: OperationsBindings, exported: AccountExport): Promise<Principal> {
  return rehydrateOperationPrincipal(env, JSON.parse(exported.principal_json) as Principal);
}

export async function authorizeAccountExport(env: OperationsBindings, principal: Principal, exported: AccountExport, all = false): Promise<void> {
  if (principal.id !== exported.created_by) throw new ApiError(404, 'not_found', 'The account export was not found.');
  const current = await rehydrateOperationPrincipal(env, principal);
  const context = backgroundContext(env, current);
  selectIdentityDatabase(context);
  for (const capability of accountExportCapabilities) await authorize(context, capability, { account_id: exported.account_id });
  const account = await one<{ type: string; owner_user_id: string | null }>(identityBinding(env), 'SELECT type,owner_user_id FROM accounts WHERE id=? AND disabled_at IS NULL', exported.account_id);
  if (!account || account.type === 'user' && account.owner_user_id !== current.user_id) throw new ApiError(403, 'account_export_owner_required', 'Personal account data requires its current user owner.');
  if (exported.account_snapshot_at) await requireAccountDraftClosure(identityBinding(env), exported.id, current.user_id);
  if (current.user_id && exported.account_snapshot_at) {
    const captured = await many<{ table_name: string }>(identityBinding(env), `SELECT DISTINCT table_name FROM account_export_rows WHERE export_id=?
      UNION SELECT DISTINCT table_name FROM account_export_repository_rows WHERE export_id=?`, exported.id, exported.id);
    const scopes: Record<string, string> = { collaboration_user_subscriptions: 'subscriptions.manage', collaboration_user_saved_filters: 'saved_filters.manage',
      collaboration_user_inbox_state: 'inbox.read', collaboration_inbox: 'inbox.read', collaboration_profile_preferences: 'users.profile.write', user_follows: 'users.follow' };
    for (const capability of new Set(captured.flatMap(row => scopes[row.table_name] ? [scopes[row.table_name]!] : []))) {
      const privateContext = backgroundContext(env, current);
      selectIdentityDatabase(privateContext);
      privateContext.req.raw = new Request(`https://internal.gitknot.com/account-export?account_id=${encodeURIComponent(exported.account_id)}`);
      const scope = await userScope(privateContext, capability);
      if (scope.account_id !== exported.account_id) throw new ApiError(403, 'account_export_context_changed', 'The private user-state context is outside this export authority.');
    }
  }
  if (!all) return;
  let after = '';
  for (;;) {
    const rows = await many<{ repo_id: string; capabilities: string }>(identityBinding(env), `SELECT repo_id,json_group_array(capability) AS capabilities
      FROM account_export_audiences WHERE export_id=? AND repo_id>? GROUP BY repo_id ORDER BY repo_id LIMIT 100`, exported.id, after);
    if (!rows.length) return;
    for (const row of rows) {
      const scope = backgroundContext(env, current);
      selectIdentityDatabase(scope);
      for (const capability of JSON.parse(row.capabilities) as string[]) await getRepository(scope, row.repo_id, capability);
    }
    after = rows.at(-1)!.repo_id;
  }
}

export async function authorizeExportRepository(env: OperationsBindings, principal: Principal, repoId: string): Promise<Repository> {
  const context = backgroundContext(env, await rehydrateOperationPrincipal(env, principal));
  selectIdentityDatabase(context);
  let repository: Repository | undefined;
  for (const capability of accountExportReadCapabilities) repository = await getRepository(context, repoId, capability);
  if (!repository || !['active', 'archived'].includes(repository.state)) throw new ApiError(409, 'account_export_repository_unavailable', 'Every repository must have a coherent exportable state.');
  return repository;
}

/** Enrollment rows discover IDs; every owner and state is read at current placement. */
export async function accountRepositoryInventory(env: OperationsBindings, principal: Principal, accountId: string): Promise<Repository[]> {
  const result: Repository[] = []; let after = '';
  const db = identityBinding(env).withSession('first-primary');
  for (;;) {
    const rows = await many<{ id: string }>(db, `SELECT id FROM (SELECT id FROM repositories WHERE owner_id=?
      UNION SELECT repo_id AS id FROM account_authority_repositories WHERE account_id=?) WHERE id>? ORDER BY id LIMIT 100`, accountId, accountId, after);
    if (!rows.length) return result;
    for (const row of rows) {
      const repository = await readRepositoryAuthority(backgroundContext(env, principal), row.id);
      if (!repository) throw new ApiError(503, 'account_export_inventory_unconfirmed', 'The complete repository inventory could not be confirmed.');
      if (repository.owner_id === accountId) result.push(repository);
      if (result.length > 4096) throw new ApiError(422, 'account_export_repository_limit', 'The complete export exceeds the supported repository envelope.');
    }
    after = rows.at(-1)!.id;
  }
}
