import { database } from '@gitknot/core/db';
import { fenceAccountAuthority, identityBinding, identityDatabase, readRepositoryAuthority, releaseAccountAuthority, withAccountAuthorityBarrier } from '@gitknot/core/authority';
import { ApiError, newId, now, one, randomToken, readBounded, signInternalRequest, stmt,
  type AppContext, type Bindings, type Database, type Principal, type Repository } from '@gitknot/core';
import { checkedWrite, currentPolicyBarrier, identityBatch, inPolicyBarrier } from '@gitknot/core/auth';

export interface CatalogOperation {
  id: string; kind: string; resource_id: string; repo_id: string; account_id: string; actor_id: string;
  status: 'pending' | 'waiting' | 'running' | 'completed' | 'failed' | 'cancelled'; phase: string; progress: number; revision: number;
  created_at: string; updated_at: string; completed_at: string | null;
}

export async function publicRepository(c: AppContext, repo: Repository): Promise<Record<string, unknown> & { revision: number }> {
  const owner = await one<{ id: string; type: string; slug: string; name: string }>(identityDatabase(c), 'SELECT id,type,slug,name FROM accounts WHERE id=?', repo.owner_id);
  if (!owner) throw new ApiError(503, 'catalog_unavailable', 'GitKnot could not read this repository owner.');
  return { id: repo.id, owner_id: repo.owner_id, owner, name: repo.name, slug: repo.slug, description: repo.description,
    visibility: repo.visibility, default_branch: repo.default_branch, state: repo.state, revision: repo.revision, policy_revision: repo.policy_revision,
    fork_source_id: repo.fork_source_id, created_by: repo.created_by, created_at: repo.created_at, updated_at: repo.updated_at,
    deleted_at: repo.deleted_at, recovery_until: repo.recovery_until,
    clone_url: `${c.env.GIT_ORIGIN}/${encodeURIComponent(owner.slug)}/${encodeURIComponent(repo.slug)}.git`,
    html_url: `${c.env.APP_ORIGIN}/repos/${encodeURIComponent(repo.id)}`,
    operations_url: `/v1/repos/${repo.id}/operations` };
}

export function prepareRepositoryOperation(c: AppContext, repository: Repository, kind: string, value: {
  input?: Record<string, unknown>; previous_state?: string | null; desired_state?: string | null; id?: string;
  status?: CatalogOperation['status']; phase?: string; principal?: Principal;
} = {}): { operation: CatalogOperation; statements: D1PreparedStatement[] } {
  const actor = value.principal ?? c.get('principal');
  if (!actor) throw new ApiError(401, 'authentication_required', 'A GitKnot account is required.');
  const id = value.id ?? newId('op');
  const timestamp = now();
  const operation: CatalogOperation = { id, kind: `repository.${kind}`, resource_id: repository.id, repo_id: repository.id, account_id: repository.owner_id,
    actor_id: actor.id, status: value.status ?? 'pending', phase: value.phase ?? 'queued', progress: 0, revision: 1,
    created_at: timestamp, updated_at: timestamp, completed_at: null };
  const input = JSON.stringify({ ...value.input, principal: actor });
  return { operation, statements: [
    stmt(database(c), `INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,status,phase,input_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, operation.kind, repository.id, repository.id, repository.owner_id, actor.id, operation.status, operation.phase, input, timestamp, timestamp),
    stmt(database(c), `INSERT INTO repository_lifecycle(operation_id,repo_id,account_id,kind,state,previous_state,desired_state,input_json,expected_repository_revision,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, id, repository.id, repository.owner_id, kind, operation.status === 'waiting' ? 'waiting' : 'queued',
    value.previous_state ?? null, value.desired_state ?? null, input, repository.revision, actor.id, timestamp, timestamp),
  ] };
}

export function operationResponse(c: AppContext, operation: CatalogOperation): void {
  c.header('location', `/v1/operations/${operation.id}`);
  c.header('retry-after', '2');
}

interface Barrier { id: string; repo_id: string; token: string; reason: string; state: string }

async function requestBarrier(env: Bindings, barrier: Barrier, method: 'POST' | 'DELETE'): Promise<void> {
  if (!env.GIT_SERVICE?.fetch) throw new ApiError(503, 'git_service_unavailable', 'Repository coordination is temporarily unavailable.');
  const request = new Request(`https://internal.gitknot.com/internal/git/repositories/${encodeURIComponent(barrier.repo_id)}/barrier`, {
    method, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ operation_id: barrier.id, owner: barrier.id, token: barrier.token, reason: barrier.reason }),
  });
  let response: Response;
  try { response = await env.GIT_SERVICE.fetch(await signInternalRequest(request, env.INTERNAL_SERVICE_KEY, 'git-service')); }
  catch { throw new ApiError(503, 'repository_coordination_pending', 'GitKnot is reconciling repository coordination. Retry shortly.'); }
  let body: { held?: boolean; error?: { code?: string } };
  try { body = JSON.parse(new TextDecoder().decode(await readBounded(response.body, 16_384))) as typeof body; }
  catch { throw new ApiError(503, 'repository_coordination_pending', 'GitKnot could not confirm repository coordination.'); }
  if (response.status === 409) throw new ApiError(409, 'repository_busy', 'A Git publication or repository operation must finish before this change.');
  if (!response.ok || body.held !== (method === 'POST')) {
    throw new ApiError(503, 'repository_coordination_pending', 'GitKnot could not confirm repository coordination.');
  }
}

async function releaseBarrier(env: Bindings, barrier: Barrier, db: Database = identityBinding(env)): Promise<void> {
  await stmt(db, "UPDATE catalog_barriers SET state='releasing',updated_at=? WHERE id=? AND state!='released'", now(), barrier.id).run();
  await requestBarrier(env, barrier, 'DELETE');
  await stmt(db, "UPDATE catalog_barriers SET state='released',updated_at=? WHERE id=?", now(), barrier.id).run();
}

/** A synchronous metadata mutation cannot race an already-admitted Git publisher. */
export async function withRepositoryBarrier<T>(c: AppContext, repoId: string, reason: string, mutation: () => Promise<T>, additionalAccounts: string[] = []): Promise<T> {
  const repo = await readRepositoryAuthority(c, repoId);
  if (!repo) throw new ApiError(404, 'not_found', 'The repository was not found.');
  return withAccountAuthorityBarriers(c, [repo.owner_id, ...additionalAccounts], reason, () => nativeRepositoryBarrier(c, repoId, reason, mutation));
}

export async function withAccountAuthorityBarriers<T>(c: AppContext, accountIds: string[], reason: string, action: () => Promise<T>): Promise<T> {
  const accounts = [...new Set(accountIds)].sort();
  const enter = (index: number): Promise<T> => index === accounts.length ? action()
    : withAccountAuthorityBarrier(c, accounts[index]!, reason, () => enter(index + 1));
  return enter(0);
}

async function nativeRepositoryBarrier<T>(c: AppContext, repoId: string, reason: string, mutation: () => Promise<T>): Promise<T> {
  const db = identityDatabase(c);
  const barrier: Barrier = { id: newId('barrier'), repo_id: repoId, token: randomToken(), reason, state: 'acquiring' };
  await stmt(db, 'INSERT INTO catalog_barriers(id,repo_id,token,reason,state,recover_after,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    barrier.id, repoId, barrier.token, reason, 'acquiring', new Date(Date.now() + 120_000).toISOString(), now(), now()).run();
  try { await requestBarrier(c.env, barrier, 'POST'); }
  catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      // A cancellation receipt installs a tombstone even when acquisition lost
      // to a publisher; a delayed acquisition must never resurrect this request.
      await releaseBarrier(c.env, barrier, db);
    }
    throw error;
  }
  await stmt(db, "UPDATE catalog_barriers SET state='held',updated_at=? WHERE id=?", now(), barrier.id).run();
  let result: T;
  try { result = await mutation(); }
  catch (error) {
    try { await releaseBarrier(c.env, barrier, db); }
    catch { console.error(JSON.stringify({ event: 'catalog.barrier_recovery_pending', barrier_id: barrier.id, repository_id: repoId })); }
    throw error;
  }
  await releaseBarrier(c.env, barrier, db);
  return result;
}

/** Background sweeper integration: release abandoned metadata-only barriers. */
export async function recoverCatalogBarriers(env: Bindings): Promise<number> {
  const db = identityBinding(env);
  const rows = await stmt(db, "SELECT id,repo_id,token,reason,state FROM catalog_barriers WHERE state!='released' AND recover_after<=? ORDER BY id LIMIT 50", now()).all<Barrier>();
  let recovered = 0;
  for (const barrier of rows.results) {
    try { await releaseBarrier(env, barrier); recovered++; }
    catch { await stmt(db, 'UPDATE catalog_barriers SET recover_after=?,updated_at=? WHERE id=?', new Date(Date.now() + 120_000).toISOString(), now(), barrier.id).run(); }
  }
  return recovered;
}

/** Stop new admission before collecting repository barriers, including creations
 * racing the collection. The metadata commit must still own this durable fence. */
export async function withAccountPolicyBarrier<T>(c: AppContext, accountId: string, reason: string, expectedPolicyRevision: number | null | undefined, mutation: () => Promise<T>): Promise<T> {
  const db = identityDatabase(c);
  const account = await one<{ policy_revision: number }>(db, 'SELECT policy_revision FROM accounts WHERE id=? AND disabled_at IS NULL', accountId);
  if (!account) throw new ApiError(404, 'not_found', 'The requested account was not found.');
  if (expectedPolicyRevision != null && expectedPolicyRevision !== account.policy_revision) throw new ApiError(412, 'revision_conflict', 'The account access policy changed. Retry against current state.');
  const collect = async (): Promise<T> => {
    const candidates = await stmt(db, `SELECT repo_id AS id FROM account_authority_repositories WHERE account_id=?
      UNION SELECT id FROM repositories WHERE owner_id=? ORDER BY id`, accountId, accountId).all<{ id: string }>();
    const repositories: string[] = [];
    for (const candidate of candidates.results) {
      const repo = await readRepositoryAuthority(c, candidate.id);
      if (repo?.owner_id === accountId && repo.state !== 'deleted') repositories.push(repo.id);
    }
    const acquire = (index: number): Promise<T> => index === repositories.length ? mutation()
      : nativeRepositoryBarrier(c, repositories[index]!, reason, () => acquire(index + 1));
    return acquire(0);
  };
  if (currentPolicyBarrier(c, accountId)) return withAccountAuthorityBarrier(c, accountId, reason, collect);
  const id = newId('policy_barrier');
  await identityBatch(db, [
    ...checkedWrite(db, stmt(db, `UPDATE accounts SET policy_revision=policy_revision WHERE id=? AND policy_revision=?
      AND NOT EXISTS (SELECT 1 FROM account_policy_barriers WHERE account_id=?)`, accountId, expectedPolicyRevision ?? account.policy_revision, accountId)),
    stmt(db, 'INSERT INTO account_policy_barriers(account_id,id,reason,previous_policy_revision,recover_after,created_at) VALUES (?,?,?,?,?,?)',
      accountId, id, reason, account.policy_revision, new Date(Date.now() + 120_000).toISOString(), now()),
  ]);
  try {
    return await inPolicyBarrier(c, accountId, id, async () => {
      await fenceAccountAuthority(c, accountId, id);
      return collect();
    });
  } finally {
    await releaseAccountAuthority(c.env, accountId, id);
  }
}
