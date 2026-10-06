import {
  ApiError, auditStatement, authorize, canonicalJson, currentPolicyBarrier, eventStatement, execute, explainAuthorization, fenceAccountAuthority,
  getRepository, identityBinding, inPolicyBarrier, many, mutationGuard, mutationStatements, newId, now, one,
  readAccountPolicy, registerRepositoryPlacement, requestPolicies, sha256, signInternalRequest, stmt,
  resolveRoute,
} from '@gitknot/core';
import type { AppContext, Database, Principal, Repository } from '@gitknot/core';
import { allowed, backgroundContext, operationsMaintenanceContext, principalById, rehydrateOperationPrincipal } from './authorization.ts';
import { consumeOnce } from './durable.ts';
import { archiveStream, createArchive, readArchive, verifyArchive } from './archive.ts';
import { deleteExpiredObjects } from './objects.ts';
import { privateJSON, recordDiagnostic } from './private.ts';
import { readBounded } from './security.ts';
import type { Operation, OperationsBindings } from './types.ts';
import { brokerRequest } from '../../secrets/src/client.ts';
import { purgeCollaborationMetadata, purgeExecutionArtifacts, purgeRepositoryAttachments, purgeRepositoryLfs } from './purge.ts';
import { commitRepositoryStorageTransfer, prepareRepositoryStorageTransfer, storageTransferReceipts } from '../../billing/src/storage-transfer.ts';
import { financialEnvironment } from './placement.ts';
import { validateWorkspaceRetention } from './retention.ts';
import { quiesceRepositoryExecution } from '@gitknot/execution/recovery';
import { withAccountAuthorityBarriers } from '../../../apps/api/src/modules/repositories/shared.ts';
import { placementGuard, requireLocalAuthority } from './ownership.ts';
import { requireMaintenanceAuthority } from './maintenance-authority.ts';
import type { StorageObject } from '../../billing/src/types.ts';
import type { StoredObject } from './objects.ts';
import { acquireMetadataFence, operationFence, operationFenceGuard, ownerBatch, ownerExecute, releaseMetadataFence, withOperationMetadataFences } from './metadata-fence.ts';
import { applyArchiveRestore, prepareArchiveRestore, retirePreviousRestoreObjects, verifyArchiveRestore } from './restore.ts';
import type { GitMaintenanceMove } from '../../git/src/types.ts';
import { authorizeRestoreSource } from './restore-access.ts';
import { abandonReadOnlySnapshot, definitiveSnapshotFailure, snapshotAbandoned } from './snapshot-abandonment.ts';
import { placementStorageName } from '../../billing/src/placement-state.ts';
import { moveControl } from './move-control.ts';

export interface LifecycleRow {
  operation_id: string; repo_id: string; account_id: string; kind: string; state: string;
  previous_state: string | null; desired_state: string | null; input_json: string;
  expected_repository_revision: number; created_by: string;
}

export interface Verification { verified: true; objects_verified: true; refs: { ref: string; oid: string }[] }
export interface Stepper {
  do<T>(name: string, options: { retries: { limit: number; delay: string; backoff: 'exponential' }; timeout: string }, callback: () => Promise<T>): Promise<T>;
}

export async function operationById(env: OperationsBindings, id: string): Promise<Operation> {
  const operation = await one<Operation>(env.DB.withSession('first-primary'), 'SELECT * FROM operations WHERE id=?', id);
  if (!operation) throw new Error('operation_not_found');
  return operation;
}

export function operationInput(operation: Operation): Record<string, unknown> {
  const input: unknown = JSON.parse(operation.input_json);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_operation_input');
  return input as Record<string, unknown>;
}

export async function operationActor(env: OperationsBindings, operation: Operation): Promise<Principal> {
  const current = await principalById(env, operation.actor_id);
  if (!current) throw new ApiError(403, 'actor_revoked', 'The initiating principal is no longer authorized.');
  const input = operationInput(operation);
  const saved = input.principal ?? input.actor;
  if (saved && typeof saved === 'object' && 'id' in saved && saved.id === current.id) {
    const actor = saved as Principal;
    if (actor.credential_id) return rehydrateOperationPrincipal(env, actor);
    return { ...current, credential_id: actor.credential_id, capabilities: actor.capabilities,
      repository_ids: actor.repository_ids, account_ids: actor.account_ids, mfa: actor.mfa };
  }
  return current;
}

async function repository(env: OperationsBindings, operation: Operation): Promise<Repository> {
  const row = await one<Repository>(env.DB.withSession('first-primary'), 'SELECT * FROM repositories WHERE id=?', operation.repo_id);
  if (!row) throw new Error('operation_repository_missing');
  return row;
}

async function phase<T extends Record<string, unknown>>(env: OperationsBindings, operation: Operation, name: string, action: () => Promise<T>): Promise<T> {
  const db = env.DB.withSession('first-primary');
  const existing = await one<{ state: string; receipt_json: string | null }>(db,
    'SELECT state,receipt_json FROM operation_steps WHERE operation_id=? AND name=?', operation.id, name);
  if (existing?.state === 'completed' && existing.receipt_json) return JSON.parse(existing.receipt_json) as T;
  const current = await operationById(env, operation.id);
  if (current.status === 'cancelled') throw new ApiError(409, 'operation_cancelled', 'The operation was cancelled.');
  if (['snapshot_abandoning', 'snapshot_abandoned'].includes(current.phase)) {
    await abandonReadOnlySnapshot(env, current);
    throw snapshotAbandoned();
  }
  const owner = await requireLocalAuthority(env, operation.repo_id, operation.id);
  await db.batch([
    ...await operationFenceGuard(db, operation.repo_id, operation.id),
    ...placementGuard(db, owner, await operationFence(db, operation.id)),
    stmt(db, `INSERT INTO operation_steps(operation_id,name,state,idempotency_key,attempts,started_at)
      VALUES(?,?,'running',?,1,?) ON CONFLICT(operation_id,name) DO UPDATE SET state='running',attempts=attempts+1,error_code=NULL`,
    operation.id, name, `${operation.id}:${name}`, now()),
    stmt(db, `UPDATE operations SET status='running',phase=?,revision=revision+1,updated_at=? WHERE id=? AND status NOT IN ('completed','cancelled')`, name, now(), operation.id),
    stmt(db, `UPDATE repository_lifecycle SET state='running',attempts=attempts+1,updated_at=? WHERE operation_id=? AND state<>'completed'`, now(), operation.id),
  ]);
  let result: T;
  try { result = await action(); }
  catch (error) {
    await recordDiagnostic(env, `lifecycle-step:${name}`, operation.id, error);
    if (name === 'archive' && definitiveSnapshotFailure(error) && await abandonReadOnlySnapshot(env, operation)) throw snapshotAbandoned();
    throw error;
  }
  const encoded = canonicalJson(result);
  if (new TextEncoder().encode(encoded).byteLength > 512 * 1024) throw new Error('operation_checkpoint_too_large');
  const committed = await one<{ state: string }>(db, 'SELECT state FROM operation_steps WHERE operation_id=? AND name=?', operation.id, name);
  if (committed?.state === 'completed') return result;
  const latest = await requireLocalAuthority(env, operation.repo_id, operation.id);
  await db.batch([...await operationFenceGuard(db, operation.repo_id, operation.id), ...placementGuard(db, latest, await operationFence(db, operation.id)),
    stmt(db, `UPDATE operation_steps SET state='completed',receipt_json=?,completed_at=?,error_code=NULL WHERE operation_id=? AND name=?`, encoded, now(), operation.id, name)]);
  return result;
}

async function verifyGit(env: OperationsBindings, operation: Operation, expected?: { ref: string; oid: string }[]): Promise<Verification> {
  const result = await privateJSON<Verification>(env, env.GIT_SERVICE, 'git-service', `/internal/git/repositories/${operation.repo_id}/verify`, {
    operation_id: operation.id, ...(expected ? { expected_refs: expected } : {}),
  });
  if (result.verified !== true || result.objects_verified !== true || !Array.isArray(result.refs)
    || result.refs.some((entry) => !entry.ref.startsWith('refs/') || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.oid))) throw new Error('git_verification_missing');
  if (expected && canonicalJson([...expected].sort((a, b) => a.ref.localeCompare(b.ref))) !== canonicalJson([...result.refs].sort((a, b) => a.ref.localeCompare(b.ref)))) throw new Error('git_ref_verification_mismatch');
  return result;
}

async function fence(env: OperationsBindings, operation: Operation): Promise<{ token: string; repository: Repository }> {
  const repo = await repository(env, operation);
  const token = `lifecycle_${operation.id}`;
  const result = await privateJSON<{ held: boolean }>(env, env.GIT_SERVICE, 'git-service', `/internal/git/repositories/${repo.id}/barrier`, {
    operation_id: operation.id, owner: operation.id, token, reason: operation.kind,
  });
  if (result.held !== true) throw new Error('lifecycle_fence_missing');
  await ownerExecute(env, repo.id, operation.id, `UPDATE operations_maintenance_intents SET barrier_token_hash=?,barrier_held_at=COALESCE(barrier_held_at,?)
    WHERE operation_id=? AND barrier_released_at IS NULL`, await sha256(token), now(), operation.id);
  const directory = (env.DIRECTORY_DB ?? identityBinding(env)).withSession('first-primary');
  const current = await one<{ operation_id: string | null; epoch: number }>(directory, 'SELECT operation_id,epoch FROM resource_routes WHERE resource_id=?', repo.id);
  if (current) {
    const claim = await execute(directory, `UPDATE resource_routes SET state='fenced',operation_id=?,updated_at=?
      WHERE resource_id=? AND epoch=? AND (operation_id IS NULL OR operation_id=?)`, operation.id, now(), repo.id, repo.routing_epoch, operation.id);
    if (claim.meta.changes !== 1) throw new Error('repository_directory_fenced');
  }
  if (await one(env.DB, `SELECT 1 FROM webhook_deliveries WHERE repo_id=? AND state='sending' AND lease_until>?
    UNION ALL SELECT 1 FROM mail_deliveries WHERE repo_id=? AND state='sending' AND lease_until>? LIMIT 1`, repo.id, now(), repo.id, now())) {
    throw new Error('repository_deliveries_draining');
  }
  await acquireMetadataFence(env, repo.id, operation.id, repo.routing_epoch);
  return { token, repository: repo };
}

async function releaseFence(env: OperationsBindings, operation: Operation, token: string, deleted = false): Promise<void> {
  const released = await privateJSON<{ held: boolean }>(env, env.GIT_SERVICE, 'git-service', `/internal/git/repositories/${operation.repo_id}/barrier`, { operation_id: operation.id, token }, 'DELETE');
  if (released.held !== false) throw new Error('lifecycle_release_unconfirmed');
  await ownerExecute(env, operation.repo_id!, operation.id, 'UPDATE operations_maintenance_intents SET barrier_released_at=? WHERE operation_id=? AND barrier_token_hash=?', now(), operation.id, await sha256(token));
  const directory = (env.DIRECTORY_DB ?? identityBinding(env)).withSession('first-primary');
  await execute(directory, `UPDATE resource_routes SET state=?,operation_id=NULL,updated_at=? WHERE resource_id=? AND operation_id=?`, deleted ? 'deleted' : 'active', now(), operation.repo_id, operation.id);
  const metadata = await operationFence(env.DB, operation.id);
  if (!metadata) throw new Error('lifecycle_metadata_fence_missing');
  await releaseMetadataFence(env, metadata, 'release-fence');
}

async function revokeRepository(env: OperationsBindings, operation: Operation): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const timestamp = now();
  try {
    const vault = await brokerRequest<{ revoked: boolean }>(env, 'vault.lifecycle', '/internal/vault/fence-repository', {
      repo_id: operation.repo_id, previous_account_id: operation.account_id, operation_id: operation.id,
    });
    if (!vault.revoked) throw new Error('vault_revocation_unconfirmed');
  } catch (error) {
    const receipt = await one(db, 'SELECT 1 FROM audit_log WHERE id=? AND repo_id=?', `audit:vault-transfer:${operation.id}`, operation.repo_id);
    const active = await one(db, 'SELECT 1 FROM vault_entries WHERE repo_id=? AND account_id=? AND deleted_at IS NULL LIMIT 1', operation.repo_id, operation.account_id);
    if (!receipt || active) throw error;
  }
  await revokeRepositoryIdentity(env, operation);
  await ownerBatch(env, operation.repo_id!, operation.id, [
    stmt(db, `UPDATE webhooks SET state='revoked',revoked_at=?,revision=revision+1,updated_at=? WHERE repo_id=? AND state<>'revoked'`, timestamp, timestamp, operation.repo_id),
    stmt(db, `UPDATE webhook_keys SET state='revoked',valid_until=? WHERE webhook_id IN (SELECT id FROM webhooks WHERE repo_id=?)`, timestamp, operation.repo_id),
    stmt(db, `UPDATE webhook_deliveries SET state='cancelled',error_code='repository_access_revoked',revision=revision+1,updated_at=? WHERE repo_id=? AND state IN ('pending','sending')`, timestamp, operation.repo_id),
    stmt(db, `UPDATE workflows SET state='disabled',revision=revision+1,updated_at=? WHERE repo_id=? AND state='active'`, timestamp, operation.repo_id),
    stmt(db, `UPDATE mail_deliveries SET state='cancelled',error_code='repository_access_revoked',updated_at=? WHERE repo_id=? AND state IN ('pending','sending')`, timestamp, operation.repo_id),
  ]);
}

/** Account-owned grants and runner records retain their one primary authority through every move. */
export async function revokeRepositoryIdentity(env: OperationsBindings, operation: Operation): Promise<void> {
  const db = identityBinding(env).withSession('first-primary');
  if (await one(db, "SELECT 1 FROM processed_events WHERE consumer='lifecycle-identity-revoke' AND event_id=?", operation.id)) return;
  const repo = await repository(env, operation);
  const context = await operationsMaintenanceContext(env, repo);
  const dependencies = await many<{ account_id: string | null; user_id: string | null }>(db,
    `SELECT DISTINCT p.account_id,c.user_id FROM credentials c JOIN principals p ON p.id=c.principal_id
      WHERE c.revoked_at IS NULL AND EXISTS(SELECT 1 FROM json_each(c.repository_ids_json) WHERE value=?)`, repo.id);
  const accounts = [...new Set([repo.owner_id, operation.account_id,
    ...dependencies.flatMap(row => [row.account_id, row.user_id])].filter((id): id is string => id !== null))];
  if (accounts.length > 256) throw new Error('repository_identity_dependency_limit');
  const at = now();
  await withAccountAuthorityBarriers(context, accounts, `repository.revoke:${operation.id}`, () => consumeOnce(db, 'lifecycle-identity-revoke', operation.id, [
    stmt(db, `UPDATE credentials SET revoked_at=?,revision=revision+1 WHERE revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM json_each(credentials.repository_ids_json) WHERE value=?)`, at, repo.id),
    stmt(db, `UPDATE access_grants SET revoked_at=?,revision=revision+1,updated_at=? WHERE repo_id=? AND account_id=? AND revoked_at IS NULL`, at, at, repo.id, operation.account_id),
    stmt(db, `UPDATE invitations SET state='revoked',revision=revision+1,updated_at=? WHERE repo_id=? AND account_id=? AND state='pending'`, at, repo.id, operation.account_id),
    stmt(db, `UPDATE installations SET repository_ids_json=(SELECT json_group_array(value) FROM json_each(installations.repository_ids_json) WHERE value<>?),revision=revision+1,updated_at=?
      WHERE account_id=? AND EXISTS(SELECT 1 FROM json_each(installations.repository_ids_json) WHERE value=?)`, repo.id, at, operation.account_id, repo.id),
    stmt(db, `UPDATE runner_pools SET state='disabled',revision=revision+1,updated_at=? WHERE repo_id=? AND account_id=? AND state='active'`, at, repo.id, operation.account_id),
    stmt(db, `UPDATE runners SET state='revoked',revision=revision+1,updated_at=? WHERE repo_id=? AND account_id=? AND state<>'revoked'`, at, repo.id, operation.account_id),
    eventStatement(db, { id: `evt_identity_revoke_${operation.id}`, type: 'repository.credentials_revoked', resource_id: repo.id,
      resource_revision: repo.revision, repo_id: repo.id, account_id: operation.account_id, actor_id: operation.actor_id, data: { operation_id: operation.id } }),
  ]).then(() => undefined));
}

export async function quiesceExecution(env: OperationsBindings, operation: Operation): Promise<void> {
  if (!operation.repo_id) throw new Error('operation_repository_missing');
  const result = await quiesceRepositoryExecution(env, operation.repo_id);
  if (!result.ready || result.pending !== 0) throw new ApiError(503, 'repository_execution_draining',
    'Repository execution teardown is still being verified.', { pending: result.pending, customer_unreachable: result.customer_unreachable });
}

async function authorizeOperation(env: OperationsBindings, operation: Operation, kind: string): Promise<void> {
  if (kind === 'purge') { await requireMaintenanceAuthority(env, operation.repo_id!, operation.id, 'repository.purge'); return; }
  if (await validateWorkspaceRetention(env, operation, kind)) return;
  if (kind === 'backup' && operationInput(operation).maintenance === true && operation.actor_id === 'system:operations') {
    await requireMaintenanceAuthority(env, operation.repo_id!, operation.id, 'repository.backup'); return;
  }
  if (kind === 'delete' && await one(env.DB, `SELECT 1 FROM repository_lifecycle l JOIN repositories r ON r.id=l.repo_id
    WHERE l.operation_id=? AND l.repo_id=? AND l.kind='delete' AND l.desired_state='deleted' AND l.created_by=? AND r.state='deleted'`,
  operation.id, operation.repo_id, operation.actor_id)) return;
  const actor = await operationActor(env, operation);
  if (['provision', 'import', 'fork'].includes(kind)) {
    if (!operation.account_id || !await allowed(env, actor, 'repositories.create', { account_id: operation.account_id })) throw new ApiError(403, 'operation_access_revoked', 'Repository creation is no longer authorized.');
    return;
  }
  const capability = kind === 'backup' ? 'repositories.export' : kind === 'rename' ? 'repositories.manage' : kind === 'move' ? 'repositories.manage' : `repositories.${kind}`;
  if (!operation.repo_id) throw new Error('operation_repository_missing');
  const explanation = await explainAuthorization(backgroundContext(env, actor), capability, { repo_id: operation.repo_id });
  const lifecycleDenials = new Set(['repository_unavailable', 'repository_archived', 'transfer_pending']);
  // The durable operation itself owns this lifecycle barrier; every grant/credential/policy denial still applies.
  const ownsBarrier = await one(env.DB, `SELECT 1 FROM repository_lifecycle WHERE operation_id=? AND repo_id=? AND state IN ('queued','running','waiting','failed')`, operation.id, operation.repo_id);
  const lifecycleOnly = ownsBarrier && explanation.matched_grants.some((grant) => grant.effect === 'allow')
    && explanation.reasons.every((reason) => lifecycleDenials.has(reason.code));
  if (!explanation.allowed && !lifecycleOnly) throw new ApiError(403, 'operation_access_revoked', 'This repository operation is no longer authorized.');
}

async function importRepository(env: OperationsBindings, operation: Operation, fork: boolean): Promise<Record<string, unknown>> {
  const input = operationInput(operation);
  const actor = await operationActor(env, operation);
  const repo = await repository(env, operation);
  let url = typeof input.source_url === 'string' ? input.source_url : '';
  if (fork) {
    const sourceId = typeof input.source_repo_id === 'string' ? input.source_repo_id : repo.fork_source_id;
    if (!sourceId || !await allowed(env, actor, 'contents.read', { repo_id: sourceId })) throw new ApiError(403, 'fork_source_revoked', 'Source repository access is no longer authorized.');
    // The Git gateway resolves the current source remote without issuing a customer-visible storage credential.
    const result = await privateJSON<{ state: string; finalized: boolean; result: { outcome: string; operation_id: string } }>(env, env.GIT_SERVICE, 'git-service', `/internal/git/repositories/${repo.id}/mutate`, {
      operation_id: operation.id, actor, mutation: { kind: 'fork', source_repo_id: sourceId },
    });
    if (result.state !== 'committed' || !result.finalized || result.result?.outcome !== 'committed' || result.result.operation_id !== operation.id) throw new Error('fork_publication_unconfirmed');
    // The native publication gate copies and verifies every newly reachable LFS pointer before canonical publication.
    return { operation_id: result.result.operation_id, outcome: result.result.outcome };
  }
  const source = new URL(url);
  if (source.protocol !== 'https:' || source.username || source.password || source.hash) throw new Error('invalid_import_url');
  url = source.href;
  let authorization: string | undefined;
  if (typeof input.secret_ref === 'string' || typeof input.source_secret_id === 'string') {
    if (typeof env.SECRETS_CLIENT_KEY !== 'string' || typeof env.SECRETS_CLIENT_ID !== 'string') throw new Error('import_broker_unavailable');
    const request = new Request('https://internal.gitknot.com/internal/operations/import-credential', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gitknot-service-client': env.SECRETS_CLIENT_ID }, body: JSON.stringify({ operation_id: operation.id }) });
    const response = await env.SECRETS.fetch(await signInternalRequest(request, env.SECRETS_CLIENT_KEY, 'operations.import'));
    if (!response.ok) throw new Error('import_credential_unavailable');
    const credential = JSON.parse(await readBounded(response, 16_384)) as { authorization: string };
    authorization = credential.authorization;
  }
  const result = await privateJSON<{ state: string; finalized: boolean; result: { outcome: string; operation_id: string } }>(env, env.GIT_SERVICE, 'git-service', `/internal/git/repositories/${repo.id}/mutate`, {
    operation_id: operation.id, actor, mutation: { kind: 'import', source: { authority: 'artifacts', url, ...(authorization ? { authorization } : {}) } },
  });
  if (result.state !== 'committed' || !result.finalized || result.result?.outcome !== 'committed' || result.result.operation_id !== operation.id) throw new Error('import_publication_unconfirmed');
  return { operation_id: result.result.operation_id, outcome: result.result.outcome };
}

async function updateCatalog(env: OperationsBindings, operation: Operation, values: { state: Repository['state']; name?: string; owner_id?: string; visibility?: Repository['visibility']; storage_name?: string; effective_at?: string }, extra: D1PreparedStatement[] = [], authorities: AppContext[] = []): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const repo = await repository(env, operation);
  await validateWorkspaceRetention(env, operation, operation.kind.split('.').at(-1)!);
  const owner = values.owner_id ?? repo.owner_id;
  const name = values.name ?? repo.name;
  const guard = newId('guard');
  const timestamp = values.effective_at ?? now();
  const internal = await operationsMaintenanceContext(env, repo);
  const accounts = [...new Set([repo.owner_id, owner])].sort();
  await registerRepositoryPlacement(env, { repo_id: repo.id, account_id: owner, cell_id: env.CELL_ID, shard_id: env.SHARD_ID, epoch: repo.routing_epoch });
  const after: D1PreparedStatement[] = [];
  if (name !== repo.name || owner !== repo.owner_id) {
    const previousOwner = await one<{ slug: string }>(identityBinding(env), 'SELECT slug FROM accounts WHERE id=?', repo.owner_id);
    if (!previousOwner) throw new Error('repository_owner_unavailable');
    after.push(stmt(db, `INSERT OR IGNORE INTO repository_aliases(owner_slug,repository_slug,repo_id,created_at)
      VALUES(?,?,?,?)`, previousOwner.slug, repo.slug, repo.id, timestamp));
  }
  let statements = [
    stmt(db, `UPDATE repositories SET state=?,owner_id=?,name=?,slug=?,visibility=?,storage_name=?,policy_revision=policy_revision+1,
      revision=revision+1,updated_at=?,deleted_at=CASE WHEN ?='deleted' THEN COALESCE(deleted_at,?) ELSE NULL END,
      recovery_until=CASE WHEN ?='deleted' THEN COALESCE(recovery_until,?) ELSE NULL END WHERE id=? AND revision=?`,
    values.state, owner, name, name.toLowerCase(), values.visibility ?? repo.visibility, values.storage_name ?? repo.storage_name,
    timestamp, values.state, timestamp, values.state, new Date(Date.now() + 30 * 86400_000).toISOString(), repo.id, repo.revision),
    mutationGuard(db, guard), ...after, ...extra,
    stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard),
  ];
  await withAccountAuthorityBarriers(internal, accounts, `repository.lifecycle:${operation.id}`, () => inheritBarriers(internal, authorities, accounts,
    () => withOperationMetadataFences([internal, ...authorities], operation.id, async () => {
    if (authorities.length) {
      for (const [index, context] of authorities.entries()) statements = await mutationStatements(context, { statements,
        event: { type: index === authorities.length - 1 ? 'repository.transfer_published' : 'repository.transfer_initiator_rechecked',
          resource_id: repo.id, resource_revision: repo.revision + 1, repo_id: repo.id, account_id: owner,
          data: { operation_id: operation.id, previous_owner_id: repo.owner_id, state: values.state } },
      });
    } else statements = await mutationStatements(internal, { statements, event: {
      type: values.state === 'moving' ? 'repository.lifecycle_updated' : `repository.${operation.kind.split('.').at(-1)}_completed`,
      resource_id: repo.id, resource_revision: repo.revision + 1, repo_id: repo.id, account_id: owner, actor_id: operation.actor_id,
      data: { state: values.state, operation_id: operation.id },
    } });
    await consumeOnce(db, `catalog:${operation.id}:${values.state}`, operation.id, statements);
  })));
}

async function inheritBarriers<T>(source: AppContext, contexts: AppContext[], accounts: string[], action: () => Promise<T>): Promise<T> {
  const pairs = contexts.flatMap(context => accounts.map(account => ({ context, account })));
  const enter = async (index: number): Promise<T> => {
    const pair = pairs[index];
    if (!pair) return action();
    const id = currentPolicyBarrier(source, pair.account);
    if (!id) throw new Error('lifecycle_account_barrier_missing');
    return inPolicyBarrier(pair.context, pair.account, id, async () => {
      await fenceAccountAuthority(pair.context, pair.account, id);
      return enter(index + 1);
    });
  };
  return enter(0);
}

interface TransferRow {
  id: string; source_owner_id: string; destination_owner_id: string; destination_name: string; accepted_by: string | null;
  accepted_at: string | null; accepted_principal_json: string | null; expires_at: string; previous_state: 'active' | 'archived'; storage_effective_at: string | null;
  revision: number;
}

async function transferContext(env: OperationsBindings, operation: Operation): Promise<TransferRow> {
  const row = await one<TransferRow>(env.DB, `SELECT * FROM repository_transfers WHERE operation_id=? AND repo_id=? AND state IN ('accepted','moving','completed')`, operation.id, operation.repo_id);
  if (!row?.accepted_by || !row.accepted_at) throw new Error('transfer_awaiting_acceptance');
  return row;
}

async function transfer(env: OperationsBindings, operation: Operation): Promise<Record<string, unknown>> {
  const db = env.DB.withSession('first-primary');
  const row = await transferContext(env, operation);
  const repo = await repository(env, operation);
  if (repo.owner_id === row.destination_owner_id && row.storage_effective_at) return { destination_owner_id: row.destination_owner_id, state: row.previous_state, effective_at: row.storage_effective_at };
  const accepted = row.accepted_principal_json ? JSON.parse(row.accepted_principal_json) as Principal : null;
  if (!accepted || accepted.id !== row.accepted_by || !accepted.credential_id) throw new Error('transfer_receiver_authority_missing');
  const receiver = await rehydrateOperationPrincipal(env, accepted);
  const receiverContext = backgroundContext(env, receiver, repo);
  await requestPolicies(receiverContext, [
    { capability: 'repositories.create', scope: { account_id: row.destination_owner_id } },
    { capability: 'repositories.transfer', scope: { account_id: row.destination_owner_id } },
  ]);
  const sender = await operationActor(env, operation);
  const senderContext = backgroundContext(env, sender, repo);
  await requestPolicies(senderContext, [{ capability: 'repositories.transfer', scope: { repo_id: repo.id } }]);
  const account = await one<{ type: string }>(identityBinding(env), 'SELECT type FROM accounts WHERE id=? AND disabled_at IS NULL', row.destination_owner_id);
  if (!account) throw new Error('transfer_destination_unavailable');
  const { policy } = await readAccountPolicy(identityBinding(env), row.destination_owner_id);
  if (repo.fork_source_id) await authorize(receiverContext, 'contents.read', { repo_id: repo.fork_source_id });
  const visibility = repo.visibility === 'internal' && account.type !== 'organization' ? 'private' : repo.visibility;
  if (!policy.allowed_repository_visibilities.includes(visibility)) throw new Error('transfer_visibility_policy');
  if (await one(db, "SELECT 1 FROM object_manifests WHERE repo_id=? AND state IN ('reserving','pending','uploading','deleting') LIMIT 1", repo.id)) throw new Error('transfer_uploads_draining');
  if (await one(db, `SELECT 1 FROM object_manifests WHERE repo_id=? AND state='ready' AND (billing_reservation_id IS NULL OR billing_fence IS NULL) LIMIT 1`, repo.id)) throw new Error('transfer_storage_accounting_unconfirmed');
  const effective = now();
  const acceptanceGuard = newId('guard');
  await updateCatalog(env, operation, { state: 'moving', owner_id: row.destination_owner_id, name: row.destination_name, visibility, effective_at: effective }, [
    stmt(db, `UPDATE repository_transfers SET state='moving',storage_effective_at=?,revision=revision+1,updated_at=?
      WHERE id=? AND state='accepted' AND storage_effective_at IS NULL AND revision=? AND accepted_by=? AND accepted_principal_json=?`,
    effective, effective, row.id, row.revision, row.accepted_by, row.accepted_principal_json),
    mutationGuard(db, acceptanceGuard),
    stmt(db, `UPDATE workflows SET account_id=?,state='disabled',revision=revision+1,updated_at=? WHERE repo_id=?`, row.destination_owner_id, now(), repo.id),
    stmt(db, `UPDATE repository_rules SET account_id=?,revision=revision+1,updated_at=? WHERE repo_id=? AND account_id=?`, row.destination_owner_id, now(), repo.id, row.source_owner_id),
    stmt(db, 'DELETE FROM repository_name_reservations WHERE repo_id=? AND transfer_id=?', repo.id, row.id),
    stmt(db, 'DELETE FROM mutation_guards WHERE id=?', acceptanceGuard),
  ], [senderContext, receiverContext]);
  const committed = await transferContext(env, operation);
  if (!committed.storage_effective_at) throw new Error('transfer_owner_boundary_unconfirmed');
  return { destination_owner_id: row.destination_owner_id, state: row.previous_state, effective_at: committed.storage_effective_at };
}

async function applyStorageReceipts(env: OperationsBindings, operation: Operation, after: string): Promise<{ cursor: string | null }> {
  const finance = financialEnvironment(env);
  const page = await storageTransferReceipts(finance, operation.id, after, 100);
  const transfer = await transferContext(env, operation);
  const db = env.DB.withSession('first-primary');
  for (const receipt of page.items) {
    if (receipt.account_id !== transfer.destination_owner_id) throw new Error('storage_receipt_owner_mismatch');
    const source = await one<{ source_json: string }>(finance.DB, "SELECT source_json FROM billing_storage_transfers WHERE operation_id=? AND object_id=? AND state='complete'", operation.id, receipt.object_id);
    if (!source) throw new Error('storage_transfer_evidence_missing');
    const physical = JSON.parse(source.source_json) as StorageObject;
    if (physical.id !== receipt.object_id || physical.account_id !== transfer.source_owner_id || physical.attribution.repo_id !== operation.repo_id) throw new Error('storage_transfer_source_mismatch');
    const manifest = await one<StoredObject>(db, 'SELECT * FROM object_manifests WHERE id=? AND repo_id=?', receipt.object_id, operation.repo_id);
    const execution = await one<{ id: string; account_id: string; object_key: string }>(db, 'SELECT id,account_id,object_key FROM execution_objects WHERE id=? AND repo_id=?', receipt.object_id, operation.repo_id);
    const snapshots = await many<{ id: string; account_id: string }>(db, 'SELECT id,account_id FROM execution_snapshots WHERE repo_id=? AND (archive_key=? OR metadata_key=?)', operation.repo_id, physical.key, physical.key);
    if (!manifest && !execution && !snapshots.length) throw new Error('storage_transfer_manifest_missing');
    const effects: D1PreparedStatement[] = [];
    const checked = (statement: D1PreparedStatement) => {
      const guard = newId('guard'); effects.push(statement, mutationGuard(db, guard), stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard));
    };
    if (manifest) {
      const prior = manifest.account_id === transfer.source_owner_id;
      if (manifest.state !== 'ready' || manifest.object_key !== physical.key || manifest.bucket !== physical.bucket
        || manifest.account_id !== (prior ? transfer.source_owner_id : receipt.account_id)
        || manifest.billing_reservation_id !== (prior ? physical.reservation_id : receipt.reservation_id)
        || manifest.billing_fence !== (prior ? physical.fence : receipt.fence)) throw new Error('storage_transfer_manifest_changed');
      checked(stmt(db, `UPDATE object_manifests SET account_id=?,billing_reservation_id=?,billing_fence=?,storage_accrued_at=?,revision=revision+1,updated_at=?
        WHERE id=? AND repo_id=? AND account_id=? AND billing_fence=? AND revision=? AND state='ready'`, receipt.account_id, receipt.reservation_id,
      receipt.fence, transfer.storage_effective_at, now(), manifest.id, operation.repo_id, manifest.account_id, manifest.billing_fence, manifest.revision));
    }
    if (execution) {
      if (execution.object_key !== physical.key || ![transfer.source_owner_id, receipt.account_id].includes(execution.account_id)) throw new Error('execution_storage_owner_changed');
      checked(stmt(db, 'UPDATE execution_objects SET account_id=? WHERE id=? AND repo_id=? AND account_id=?', receipt.account_id, execution.id, operation.repo_id, execution.account_id));
    }
    for (const snapshot of snapshots) {
      if (![transfer.source_owner_id, receipt.account_id].includes(snapshot.account_id)) throw new Error('snapshot_storage_owner_changed');
      checked(stmt(db, 'UPDATE execution_snapshots SET account_id=? WHERE id=? AND repo_id=? AND account_id=?', receipt.account_id, snapshot.id, operation.repo_id, snapshot.account_id));
    }
    const repository = await requireLocalAuthority(env, operation.repo_id, operation.id);
    await consumeOnce(db, `storage-handoff:${operation.id}`, receipt.object_id, [
      ...await operationFenceGuard(db, operation.repo_id, operation.id),
      ...placementGuard(db, repository, await operationFence(db, operation.id)), ...effects,
      stmt(db, `UPDATE git_lfs_uploads SET account_id=?,billing_reservation_id=?,billing_fence=? WHERE repo_id=? AND object_id=? AND state='complete'`, receipt.account_id, receipt.reservation_id, receipt.fence, operation.repo_id, receipt.object_id),
      auditStatement(db, { action: 'repository.storage_ownership_applied', resource_id: receipt.object_id, repo_id: operation.repo_id,
        account_id: receipt.account_id, actor_id: operation.actor_id, details: { operation_id: operation.id, previous_account_id: transfer.source_owner_id } }),
      eventStatement(db, { type: 'repository.storage_ownership_applied', resource_id: receipt.object_id, resource_revision: (manifest?.revision ?? 0) + 1,
        repo_id: operation.repo_id, account_id: receipt.account_id, actor_id: operation.actor_id, data: { operation_id: operation.id, previous_account_id: transfer.source_owner_id } }),
    ]);
  }
  return { cursor: page.next_cursor };
}

async function purge(env: OperationsBindings, operation: Operation): Promise<Record<string, unknown>> {
  const db = env.DB.withSession('first-primary');
  const repo = await repository(env, operation);
  if (repo.state !== 'deleted' || !repo.recovery_until || repo.recovery_until > now()) throw new Error('recovery_window_open');
  const pinned = await one(db, `SELECT 1 FROM repository_retention_pins WHERE source_repo_id=? AND (expires_at IS NULL OR expires_at>?)
    UNION ALL SELECT 1 FROM repositories WHERE fork_source_id=? AND state<>'deleted'
    UNION ALL SELECT 1 FROM git_candidates c JOIN repositories r ON r.id=c.repo_id WHERE c.source_repo_id=? AND c.repo_id<>? AND c.state IN ('ready','published') AND r.state<>'deleted'
    UNION ALL SELECT 1 FROM pull_patches p JOIN repositories r ON r.id=p.repo_id WHERE p.head_repo_id=? AND p.repo_id<>? AND r.state<>'deleted' LIMIT 1`, repo.id, now(), repo.id, repo.id, repo.id, repo.id, repo.id);
  if (pinned) throw new Error('repository_retention_pinned');
  const result = await privateJSON<{ deleted: boolean; verified: boolean }>(env, env.GIT_SERVICE, 'git-service', `/internal/git/repositories/${repo.id}/purge`,
    { operation_id: operation.id, storage_name: repo.storage_name, retained_refs: [] });
  if (result.deleted !== true || result.verified !== true) throw new Error('native_purge_unconfirmed');
  await purgeRepositoryAttachments(env, repo.id, operation.id);
  await purgeRepositoryLfs(env, repo.id, operation.id);
  await ownerExecute(env, repo.id, operation.id, `UPDATE object_manifests SET retention_until=?,reference_count=0,revision=revision+1,updated_at=?
    WHERE repo_id=? AND state IN ('ready','pending','failed') AND kind NOT IN ('archive_chunk','collaboration_attachment','git_lfs')`, now(), now(), repo.id);
  while (await deleteExpiredObjects(env, repo.id, operation.id) === 100) { /* Bounded batches retain per-object deletion receipts. */ }
  if (await one(db, `SELECT 1 FROM object_manifests WHERE repo_id=? AND state<>'deleted' AND kind<>'archive_chunk' LIMIT 1`, repo.id)) throw new Error('repository_object_purge_incomplete');
  await purgeExecutionArtifacts(env, repo.id, operation.id);
  await purgeCollaborationMetadata(env, repo.id, operation.id);
  return { deleted: true, storage_verified: true };
}

async function restoreAuthorizer(env: OperationsBindings, operation: Operation, archiveId: string): Promise<() => Promise<void>> {
  const manifest = await readArchive(env, archiveId, operation.repo_id!);
  let expected: GitMaintenanceMove | null = null;
  return async () => {
    if (operation.actor_id === 'system:operations' && operation.kind === 'repository.move') {
      const proof = await privateJSON<GitMaintenanceMove>(env, env.GIT_SERVICE, 'git-service',
        `/internal/git/repositories/${operation.repo_id}/move-restore-authority`, { operation_id: operation.id, archive_id: archiveId });
      const route = await resolveRoute(env, operation.repo_id!);
      const archive = await one<{ manifest_sha256: string }>(env.DB, 'SELECT manifest_sha256 FROM repository_archives WHERE id=?', archiveId);
      if (!route || route.state !== 'fenced' || route.operation_id !== operation.id || proof.purpose !== 'repository.move'
        || proof.operation_id !== operation.id || proof.repo_id !== operation.repo_id || proof.archive_id !== archiveId
        || proof.source.cell_id !== route.cell_id || proof.source.shard_id !== route.shard_id || proof.source.epoch !== route.epoch
        || proof.destination.cell_id !== env.CELL_ID || proof.destination.shard_id !== env.SHARD_ID || proof.destination.epoch !== route.epoch + 1
        || proof.manifest_sha256 !== archive?.manifest_sha256 || proof.restore.bundle_sha256 !== manifest.git.sha256
        || proof.restore.bundle_bytes !== manifest.git.bytes || canonicalJson(proof.restore.expected_refs) !== canonicalJson(manifest.git.refs)
        || expected && canonicalJson(proof) !== canonicalJson(expected)) throw new Error('move_restore_authority_changed');
      expected = proof;
      return;
    }
    const context = backgroundContext(env, await operationActor(env, operation), await repository(env, operation));
    await getRepository(context, operation.repo_id!, operation.kind === 'repository.move' ? 'repositories.export' : 'repositories.restore');
    for (const source of manifest.audience_repo_ids) if (source !== operation.repo_id) {
      if (operation.kind === 'repository.restore') await authorizeRestoreSource(context, operation.id, operation.repo_id!, source);
      else await getRepository(context, source, 'contents.read');
    }
  };
}

async function restoreMutationContexts(env: OperationsBindings, operation: Operation, archiveId: string): Promise<AppContext[]> {
  const manifest = await readArchive(env, archiveId, operation.repo_id!);
  const repo = await repository(env, operation);
  const actor = await operationActor(env, operation);
  const sources = manifest.audience_repo_ids.filter(id => id !== repo.id);
  const contexts: AppContext[] = [];
  for (let offset = 0; offset < Math.max(sources.length, 1); offset += 16) {
    const context = backgroundContext(env, actor, repo);
    await requestPolicies(context, [{ capability: 'repositories.restore', scope: { repo_id: repo.id } }]);
    for (const source of sources.slice(offset, offset + 16)) await authorizeRestoreSource(context, operation.id, repo.id, source);
    contexts.push(context);
  }
  return contexts;
}

export async function restoreGit(env: OperationsBindings, operation: Operation, archiveId: string): Promise<{ storage_name: string; refs: { ref: string; oid: string }[] }> {
  const manifest = await readArchive(env, archiveId, operation.repo_id!);
  const authorizePart = await restoreAuthorizer(env, operation, archiveId);
  await authorizePart();
  await verifyArchive(env, manifest);
  const storageName = operation.kind === 'repository.move' ? (await moveControl(env, operation.id)).target_storage_name
    : await placementStorageName(operation.repo_id!, operation.id);
  const url = new URL(`https://internal.gitknot.com/internal/git/repositories/${operation.repo_id}/restore`);
  url.searchParams.set('operation_id', operation.id); url.searchParams.set('archive_id', archiveId); url.searchParams.set('storage_name', storageName);
  const init = { method: 'POST', headers: { 'content-type': 'application/x-git-bundle', 'x-gitknot-content-sha256': manifest.git.sha256 },
    body: archiveStream(env, manifest, 'git/', authorizePart), duplex: 'half' as const };
  const request = new Request(url, init);
  const response = await env.GIT_SERVICE.fetch(await signInternalRequest(request, env.INTERNAL_SERVICE_KEY, 'git-service'));
  if (!response.ok) { await response.body?.cancel(); throw new Error('native_restore_failed'); }
  const result = JSON.parse(await readBounded(response, 1024 * 1024)) as Verification;
  if (result.verified !== true || result.objects_verified !== true || canonicalJson(result.refs) !== canonicalJson(manifest.git.refs)) throw new Error('native_restore_unconfirmed');
  return { storage_name: storageName, refs: result.refs };
}

export async function completeOperation(env: OperationsBindings, operation: Operation, result: Record<string, unknown>): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const timestamp = now();
  const current = await operationById(env, operation.id);
  if (current.status === 'completed') return;
  const repository = await requireLocalAuthority(env, operation.kind === 'collaboration.code_scan' ? null : operation.repo_id, operation.id);
  const guard = newId('guard');
  await db.batch([
    ...await operationFenceGuard(db, operation.kind === 'collaboration.code_scan' ? null : operation.repo_id),
    ...placementGuard(db, repository),
    stmt(db, `UPDATE operations SET status='completed',phase='completed',progress=100,result_json=?,error_json=NULL,
      revision=revision+1,updated_at=?,completed_at=? WHERE id=? AND revision=? AND status<>'cancelled'`, JSON.stringify(result), timestamp, timestamp, operation.id, current.revision),
    mutationGuard(db, guard),
    stmt(db, `UPDATE repository_lifecycle SET state='completed',result_json=?,failure_code=NULL,updated_at=? WHERE operation_id=?`, JSON.stringify(result), timestamp, operation.id),
    eventStatement(db, { type: 'operation.completed', resource_id: operation.id, resource_revision: current.revision + 1, repo_id: operation.repo_id,
      account_id: operation.account_id, actor_id: operation.actor_id, data: { kind: operation.kind } }),
    stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard),
  ]);
}

export async function runLifecycle(env: OperationsBindings, operation: Operation, step: Stepper): Promise<Record<string, unknown>> {
  const lifecycle = await one<LifecycleRow>(env.DB.withSession('first-primary'), 'SELECT * FROM repository_lifecycle WHERE operation_id=?', operation.id);
  const kind = lifecycle?.kind ?? operation.kind.split('.').at(-1)!;
  const run = <T extends Record<string, unknown>>(name: string, action: () => Promise<T>) => step.do(name,
    { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '30 minutes' }, () => phase(env, operation, name, action));
  await run('authorize', async () => { await authorizeOperation(env, operation, kind); return { authorized: true }; });
  if (['provision', 'import', 'fork'].includes(kind)) {
    await run('provision', async () => privateJSON<Record<string, unknown>>(env, env.GIT_SERVICE, 'git-service', `/internal/git/repositories/${operation.repo_id}/provision`, { operation_id: operation.id, actor: await operationActor(env, operation) }));
    if (kind !== 'provision') await run(kind, () => importRepository(env, operation, kind === 'fork'));
    const verified = await run('verify-storage', async () => ({ ...await verifyGit(env, operation) }));
    await run('activate', async () => { await authorizeOperation(env, operation, kind); await updateCatalog(env, operation, { state: 'active' }); return { active: true }; });
    return { repository_id: operation.repo_id, verified: verified.verified };
  }
  const barrier = await run('fence-writes', async () => ({ ...await fence(env, operation) }));
  if (['delete', 'archive', 'transfer', 'restore', 'purge'].includes(kind)) await run('drain-execution', async () => { await quiesceExecution(env, operation); return { drained: true }; });
  let result: Record<string, unknown> = { repository_id: operation.repo_id };
  if (['export', 'backup'].includes(kind)) {
    const verified = await run('verify-export-source', async () => ({ ...await verifyGit(env, operation) }));
    const archive = await run('archive', () => createArchive(env, operation, barrier.repository as unknown as Repository, verified.refs as { ref: string; oid: string }[], kind as 'export' | 'backup'));
    result = { ...result, archive_id: archive.archive_id, sha256: archive.sha256 };
    await run('record-export', async () => {
      await ownerExecute(env, operation.repo_id!, operation.id, `UPDATE repository_exports SET state='completed',object_key=?,checksum_sha256=?,size_bytes=?,revision=revision+1,completed_at=? WHERE operation_id=? AND state<>'completed'`, archive.manifest_key, archive.sha256, archive.bytes, now(), operation.id);
      return { recorded: true };
    });
  }
  if (kind === 'delete') {
    await run('verify-retained-source', async () => ({ ...await verifyGit(env, operation) }));
    await run('delete-catalog', async () => { await updateCatalog(env, operation, { state: 'deleted' }); return { deleted: true }; });
    await run('delete-revoke-credentials', async () => { await revokeRepository(env, operation); return { revoked: true }; });
  }
  if (kind === 'archive' || kind === 'unarchive') await run('archive-state', async () => {
    if (kind === 'archive') await ownerExecute(env, operation.repo_id!, operation.id, `UPDATE workflows SET state='disabled',revision=revision+1,updated_at=? WHERE repo_id=? AND state='active'`, now(), operation.repo_id);
    await updateCatalog(env, operation, { state: kind === 'archive' ? 'archived' : 'active' }); return { state: kind === 'archive' ? 'archived' : 'active' };
  });
  if (kind === 'transfer') {
    const context = await run('transfer-context', async () => ({ ...await transferContext(env, operation) }));
    const finance = financialEnvironment(env);
    let prepared = false;
    for (let page = 0; page < 4000; page++) {
      const progress = await run(`storage-prepare-${page}`, async () => ({ ...await prepareRepositoryStorageTransfer(finance, {
        operation_id: operation.id, repo_id: operation.repo_id!, from_account_id: context.source_owner_id,
        to_account_id: context.destination_owner_id, actor_id: context.accepted_by!,
      }) }));
      if (progress.state === 'prepared') { prepared = true; break; }
      if (!progress.processed) throw new Error('storage_handoff_prepare_stalled');
    }
    if (!prepared) throw new Error('storage_handoff_page_limit');
    result = { ...result, ...await run('transfer-owner', () => transfer(env, operation)) };
    await run('transfer-revoke-credentials', async () => { await revokeRepository(env, operation); return { revoked: true }; });
    let settled = false;
    for (let page = 0; page < 4000; page++) {
      const progress = await run(`storage-commit-${page}`, async () => ({ ...await commitRepositoryStorageTransfer(finance, { operation_id: operation.id, effective_at: String(result.effective_at) }) }));
      if (progress.state === 'complete') { settled = true; break; }
      if (!progress.processed) throw new Error('storage_handoff_commit_stalled');
    }
    if (!settled) throw new Error('storage_handoff_page_limit');
    let cursor: string | null = '';
    for (let page = 0; cursor !== null && page < 4000; page++) {
      const applied = await run(`storage-manifests-${page}`, () => applyStorageReceipts(env, operation, cursor!));
      cursor = applied.cursor;
    }
    if (cursor !== null) throw new Error('storage_receipt_page_limit');
    await run('transfer-activate', async () => {
      if (await one(env.DB, `SELECT 1 FROM object_manifests WHERE repo_id=? AND state<>'deleted' AND account_id<>? LIMIT 1`, operation.repo_id, context.destination_owner_id)) throw new Error('storage_ownership_unconfirmed');
      if (await one(env.DB, `SELECT 1 FROM execution_objects WHERE repo_id=? AND state<>'deleted' AND account_id<>?
        UNION ALL SELECT 1 FROM execution_snapshots WHERE repo_id=? AND state<>'deleted' AND account_id<>? LIMIT 1`,
      operation.repo_id, context.destination_owner_id, operation.repo_id, context.destination_owner_id)) throw new Error('execution_storage_ownership_unconfirmed');
      await updateCatalog(env, operation, { state: result.state as 'active' | 'archived' }, [
        stmt(env.DB, `UPDATE repository_transfers SET state='completed',revision=revision+1,updated_at=? WHERE operation_id=? AND state='moving'`, now(), operation.id),
        stmt(env.DB, 'UPDATE repository_archives SET account_id=?,revision=revision+1 WHERE repo_id=? AND account_id=?', context.destination_owner_id, operation.repo_id, context.source_owner_id),
      ]);
      return { activated: true };
    });
  }
  if (kind === 'rename') await run('rename', async () => {
    const input = operationInput(operation); if (typeof input.name !== 'string') throw new Error('rename_name_required');
    await updateCatalog(env, operation, { state: barrier.repository.state as Repository['state'], name: input.name }); return { renamed: true };
  });
  if (kind === 'purge') result = { ...result, ...await run('purge-storage', () => purge(env, operation)) };
  if (kind === 'restore') {
    const input = operationInput(operation);
    const archiveId = typeof input.archive_id === 'string' ? input.archive_id : undefined;
    if (archiveId) {
      await run('restore-prepare-snapshot', async () => {
        await prepareArchiveRestore(env, operation, archiveId, await restoreAuthorizer(env, operation, archiveId));
        return { prepared: true };
      });
      const restored = await run('restore-storage', () => restoreGit(env, operation, archiveId));
      await run('restore-catalog', async () => {
        await (await restoreAuthorizer(env, operation, archiveId))();
        await applyArchiveRestore(env, operation, restored.storage_name as string, await restoreMutationContexts(env, operation, archiveId));
        await verifyArchiveRestore(env, operation);
        return { restored: true };
      });
      await run('verify-restored-storage', async () => ({ ...await verifyGit(env, operation, restored.refs as { ref: string; oid: string }[]) }));
      await run('restore-retire-previous-objects', async () => { await retirePreviousRestoreObjects(env, operation); return { retired: true }; });
    } else {
      const retained = await repository(env, operation);
      if (retained.state !== 'deleted' || !retained.recovery_until || retained.recovery_until <= now()) throw new Error('recovery_window_closed');
      await run('verify-retained-restore', async () => ({ ...await verifyGit(env, operation) }));
    }
    await run('restore-revoke-credentials', async () => { await revokeRepository(env, operation); return { revoked: true }; });
    await run('restore-activate', async () => { await updateCatalog(env, operation, { state: 'active' }); return { activated: true }; });
    result = { ...result, ...(archiveId ? { archive_id: archiveId } : {}), restored: true };
  }
  if (!['archive', 'unarchive', 'delete', 'restore', 'purge', 'export', 'backup', 'transfer', 'rename'].includes(kind)) throw new Error('unsupported_lifecycle_operation');
  await run('release-fence', async () => { await releaseFence(env, operation, barrier.token as string, kind === 'delete' || kind === 'purge'); return { released: true }; });
  return result;
}

export async function failOperation(env: OperationsBindings, id: string, error: unknown): Promise<void> {
  await recordDiagnostic(env, 'lifecycle', id, error);
  const code = error instanceof ApiError && error.status < 500 ? error.code : 'operation_step_unconfirmed';
  const retryable = !(error instanceof ApiError && [401, 403, 404].includes(error.status));
  const operation = await operationById(env, id);
  if (await abandonReadOnlySnapshot(env, operation)) return;
  try { await requireLocalAuthority(env, operation.kind === 'collaboration.code_scan' ? null : operation.repo_id, operation.id); }
  catch (failure) {
    if (failure instanceof ApiError && failure.code === 'background_placement_changed') return;
    throw failure;
  }
  await env.DB.batch([
    ...await operationFenceGuard(env.DB, operation.kind === 'collaboration.code_scan' ? null : operation.repo_id, operation.id),
    stmt(env.DB, `UPDATE operations SET status='failed',error_json=?,revision=revision+1,updated_at=? WHERE id=? AND status NOT IN ('completed','cancelled')`,
      JSON.stringify({ code, message: 'The current step could not be confirmed. Durable state is retained for recovery.', retryable }), now(), id),
    stmt(env.DB, `UPDATE repository_lifecycle SET state='failed',failure_code=?,updated_at=? WHERE operation_id=? AND state<>'completed'`, code, now(), id),
  ]);
}
