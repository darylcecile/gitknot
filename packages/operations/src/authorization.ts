import { Context } from 'hono';
import { ApiError, authorize, credentialIsCurrent, identityBinding, newId, now, one, readRepositoryAuthority,
  selectRepositoryDatabase } from '@gitknot/core';
import type { CredentialRecord } from '@gitknot/core';
import type { AppContext, AppEnv, EventRecord, Principal, Repository } from '@gitknot/core';
import { executionEventRequirements } from './execution-audience.ts';
import type { OperationsBindings, Webhook } from './types.ts';

export function backgroundContext(env: OperationsBindings, principal: Principal, repository?: Repository): AppContext {
  const context = new Context<AppEnv>(new Request('https://internal.gitknot.com/authorization'), { env });
  context.set('principal', principal);
  context.set('database', env.DB.withSession('first-primary'));
  context.set('requestId', newId('background'));
  if (repository) {
    selectRepositoryDatabase(context, { repo_id: repository.id, cell_id: repository.cell_id, shard_id: repository.shard_id,
      epoch: repository.routing_epoch, state: repository.state === 'deleted' ? 'deleted' : 'active', operation_id: null });
    context.set('routing', { resource_id: repository.id, cell_id: repository.cell_id, shard_id: repository.shard_id,
      epoch: repository.routing_epoch, expected_state: repository.state, lifecycle: true });
  }
  return context;
}

export async function principalById(env: OperationsBindings, id: string): Promise<Principal | null> {
  const db = identityBinding(env).withSession('first-primary');
  const row = await one<{ id: string; kind: Principal['kind']; user_id: string | null }>(db,
    `SELECT id,kind,user_id FROM principals WHERE id=? AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at>?)`, id, now());
  if (!row) return null;
  if (row.user_id && !await one(db, 'SELECT 1 FROM users WHERE id=? AND disabled_at IS NULL', row.user_id)) return null;
  return { ...row, credential_id: null, capabilities: null, repository_ids: null, account_ids: null, mfa: false };
}

export async function allowed(env: OperationsBindings, principal: Principal, capability: string, scope: { repo_id?: string; account_id?: string }): Promise<boolean> {
  try { await authorize(backgroundContext(env, principal), capability, scope); return true; }
  catch (error) {
    if (error instanceof ApiError && [401, 403, 404].includes(error.status)) return false;
    throw error;
  }
}

export async function webhookAuthorization(env: OperationsBindings, webhook: Webhook, capability = 'contents.read', event?: EventRecord): Promise<'authorized' | 'changed' | 'revoked' | 'event_denied'> {
  const db = env.DB.withSession('first-primary');
  const current = await one<Webhook>(db, `SELECT * FROM webhooks WHERE id=? AND repo_id=? AND state='active'`, webhook.id, webhook.repo_id);
  if (!current) return 'revoked';
  const identity = identityBinding(env).withSession('first-primary');
  const principal = await principalById(env, current.principal_id);
  if (!principal) return 'revoked';
  const repo = await readRepositoryAuthority(backgroundContext(env, principal), current.repo_id);
  if (!repo || repo.owner_id !== current.account_id || ['deleted', 'provisioning', 'transfer_pending', 'moving'].includes(repo.state)) return 'revoked';
  const snapshot = JSON.parse(current.principal_json) as Principal;
  if (snapshot.id !== principal.id) throw new Error('subscription_principal_mismatch');
  principal.capabilities = snapshot.capabilities;
  principal.repository_ids = snapshot.repository_ids;
  principal.account_ids = snapshot.account_ids;
  if (snapshot.credential_id) {
    const credential = await one<CredentialRecord>(identity, 'SELECT * FROM credentials WHERE id=? AND principal_id=?', snapshot.credential_id, principal.id);
    if (!credential || !await credentialIsCurrent(identity, credential)) return 'revoked';
    principal.credential_id = credential.id;
    principal.mfa = credential.mfa === 1;
  }
  if (current.installation_id) {
    const install = await one<{ capabilities_json: string; repository_ids_json: string }>(identity,
      `SELECT i.capabilities_json,i.repository_ids_json FROM installations i JOIN applications a ON a.id=i.application_id
       WHERE i.id=? AND i.id=? AND i.account_id=? AND i.suspended_at IS NULL AND a.disabled_at IS NULL`,
    current.installation_id, principal.id, repo.owner_id);
    if (!install) return 'revoked';
    const repositories = JSON.parse(install.repository_ids_json) as string[];
    if (!repositories.includes(repo.id)) return 'revoked';
    if (!await allowed(env, { ...principal, capabilities: JSON.parse(install.capabilities_json) as string[], repository_ids: repositories, account_ids: [repo.owner_id] }, capability, { repo_id: repo.id })) return 'revoked';
  }
  if (!await allowed(env, principal, capability, { repo_id: repo.id })) return 'revoked';
  if (event && await executionEventRequirements(env, principal, event) === null) return 'event_denied';
  return current.revision === webhook.revision ? 'authorized' : 'changed';
}

export async function webhookAuthorized(env: OperationsBindings, webhook: Webhook, capability = 'contents.read'): Promise<boolean> {
  return await webhookAuthorization(env, webhook, capability) !== 'revoked';
}

/** Rehydrate against the identity primary while retaining the original credential ceilings. */
export async function rehydrateOperationPrincipal(env: OperationsBindings, snapshot: Principal): Promise<Principal> {
  if (!snapshot.credential_id) throw new ApiError(401, 'operation_credential_required', 'The operation requires its initiating credential.');
  const db = identityBinding(env).withSession('first-primary');
  const credential = await one<CredentialRecord>(db, 'SELECT * FROM credentials WHERE id=? AND principal_id=?', snapshot.credential_id, snapshot.id);
  const principal = await principalById(env, snapshot.id);
  if (!credential || !principal || !await credentialIsCurrent(db, credential) || principal.kind !== snapshot.kind || principal.user_id !== snapshot.user_id) {
    throw new ApiError(403, 'operation_access_revoked', 'The initiating credential or principal is no longer current.');
  }
  return { ...snapshot, kind: principal.kind, user_id: principal.user_id, mfa: snapshot.mfa && credential.mfa === 1 };
}

export async function operationsMaintenanceContext(env: OperationsBindings, repository: Repository): Promise<AppContext> {
  const record = await one(identityBinding(env), `SELECT 1 FROM principals p JOIN accounts a ON a.id=p.account_id
    WHERE p.id='svc_operations_maintenance' AND p.kind='service' AND p.user_id IS NULL AND p.account_id='acc_operations_system'
      AND p.disabled_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?) AND a.disabled_at IS NULL`, now());
  if (!record) throw new Error('operations_maintenance_authority_unavailable');
  return backgroundContext(env, { id: 'svc_operations_maintenance', kind: 'service', user_id: null, credential_id: null,
    capabilities: [], repository_ids: [], account_ids: [], mfa: false }, repository);
}
