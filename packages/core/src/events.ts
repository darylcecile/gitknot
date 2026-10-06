import { ApiError } from './errors.ts';
import { database, stmt } from './db.ts';
import { canonicalJson, newId, now } from './crypto.ts';
import { currentPolicyBarrier } from './auth.ts';
import { accountAuthorityGuard, prepareAccountAuthority, primaryIdentityGuard, remoteIdentityGuard, repositoryPolicyIsLocal } from './authority/guards.ts';
import { separateIdentityAuthority } from './authority/identity.ts';
import { captureMutationAuthority, requestPolicies, retainRequestPolicies } from './http.ts';
import { registerEventResourceLocator, resourceLocatorGuard } from './locators.ts';
import { requestDatabaseLocation, selectedRepositoryScope } from './routing/cells.ts';
import { sameDatabaseLocation } from './routing/locations.ts';
import { currentRepositoryMetadataFence, repositoryMetadataFenceGuard } from './routing/metadata-fences.ts';
import { executeMutationBatch } from './mutation-batch.ts';
import type { AppContext, Database, EventRecord, IdempotencyContext, RequestAuthorization, RequestPolicy } from './types.ts';
import { routingGuardStatement } from './routing.ts';

export { executeMutationBatch } from './mutation-batch.ts';
export type { MutationBatchExecutionOptions } from './mutation-batch.ts';

export interface EventInput {
  id?: string;
  type: string;
  version?: number;
  occurred_at?: string;
  actor_id?: string | null;
  resource_id: string;
  resource_revision: number;
  repo_id?: string | null;
  account_id?: string | null;
  data?: Record<string, unknown>;
}

export interface AuditInput {
  id?: string;
  action: string;
  resource_id: string;
  resource_revision?: number;
  account_id?: string | null;
  repo_id?: string | null;
  actor_id?: string | null;
  credential_id?: string | null;
  request_id?: string;
  created_at?: string;
  details?: Record<string, unknown>;
}

export function makeEvent(value: EventInput): EventRecord {
  return {
    id: value.id ?? newId('evt'), type: value.type, version: value.version ?? 1,
    occurred_at: value.occurred_at ?? now(), actor_id: value.actor_id ?? null,
    resource_id: value.resource_id, resource_revision: value.resource_revision,
    repo_id: value.repo_id ?? null, account_id: value.account_id ?? null,
    data: value.data ?? {},
  };
}

export function eventStatement(db: Database, value: EventInput): D1PreparedStatement {
  const event = makeEvent(value);
  return stmt(db, `INSERT INTO outbox
    (id,type,version,occurred_at,actor_id,resource_id,resource_revision,repo_id,account_id,payload_json,event_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`, event.id, event.type, event.version, event.occurred_at,
  event.actor_id, event.resource_id, event.resource_revision, event.repo_id ?? null,
  event.account_id ?? null, JSON.stringify(event.data), JSON.stringify(event));
}

export function auditStatement(db: Database, value: AuditInput): D1PreparedStatement {
  return stmt(db, `INSERT INTO audit_log
    (id,account_id,repo_id,actor_id,credential_id,action,resource_id,resource_revision,request_id,details_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, value.id ?? newId('audit'), value.account_id ?? null,
  value.repo_id ?? null, value.actor_id ?? null, value.credential_id ?? null, value.action,
  value.resource_id, value.resource_revision ?? null, value.request_id ?? 'background',
  JSON.stringify(value.details ?? {}), value.created_at ?? now());
}

export function mutationGuard(db: Database, id = newId('guard')): D1PreparedStatement {
  return stmt(db, 'INSERT INTO mutation_guards (id,ok) VALUES (?,changes())', id);
}

export interface Mutation {
  sql: string;
  bindings?: unknown[];
  event: EventInput;
  audit?: AuditInput;
  after?: D1PreparedStatement[];
  authorizations?: RequestAuthorization[];
}

export interface MutationBatch {
  /** Include a guard after every conditional write whose success the operation requires. */
  statements: D1PreparedStatement[];
  event: EventInput;
  audit?: AuditInput;
  /** Additional requirements are retained alongside every route/handler scope. */
  authorizations?: RequestAuthorization[];
}

function requestOwnership(db: Database, request: IdempotencyContext, id: string): D1PreparedStatement {
  return stmt(db, `INSERT INTO idempotency_write_guards(id,ok) SELECT ?,CASE WHEN EXISTS (
    SELECT 1 FROM idempotency_keys WHERE principal_id=? AND key=? AND request_hash=? AND generation=? AND attempt_id=?
      AND strategy=? AND status IN ('pending','uncertain') AND (strategy='external' OR committed_at IS NULL)
  ) THEN 1 ELSE 0 END`, id, request.principal_id, request.key, request.request_hash,
  request.generation, request.attempt_id, request.strategy);
}

function policyGuard(c: AppContext, db: Database, policy: RequestPolicy, id: string, localRepository: boolean): D1PreparedStatement | null {
  const conditions: string[] = [];
  const values: unknown[] = [id];
  if (policy.account_id && !separateIdentityAuthority(c)) {
    conditions.push('EXISTS (SELECT 1 FROM accounts WHERE id=? AND policy_revision=? AND disabled_at IS NULL)');
    values.push(policy.account_id, policy.account_policy_revision);
    const barrier = currentPolicyBarrier(c, policy.account_id);
    conditions.push(barrier
      ? 'EXISTS (SELECT 1 FROM account_policy_barriers WHERE account_id=? AND id=?)'
      : 'NOT EXISTS (SELECT 1 FROM account_policy_barriers WHERE account_id=?)');
    values.push(policy.account_id, ...(barrier ? [barrier] : []));
  }
  if (policy.repo_id && localRepository) {
    conditions.push('EXISTS (SELECT 1 FROM repositories WHERE id=? AND owner_id=? AND policy_revision=? AND routing_epoch=?)');
    values.push(policy.repo_id, policy.account_id, policy.policy_revision, policy.routing_epoch);
    if (policy.repository_revision != null) {
      conditions.push('EXISTS (SELECT 1 FROM repositories WHERE id=? AND revision=?)');
      values.push(policy.repo_id, policy.repository_revision);
    }
  }
  return conditions.length ? stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN ${conditions.join(' AND ')} THEN 1 ELSE 0 END`, ...values) : null;
}

/**
 * Build one atomic effects/source-event/audit/receipt batch. Shared module batch
 * helpers use this around their guarded statements, retaining their error mapper.
 * External operations must use the route's external strategy and durable journal;
 * a D1 progress event is not evidence that an R2/Git operation completed.
 */
export async function mutationStatements(c: AppContext, mutation: MutationBatch): Promise<D1PreparedStatement[]> {
  const db = database(c);
  const authority = await captureMutationAuthority(c);
  const actor = c.get('principal');
  const event = makeEvent({ ...mutation.event, actor_id: mutation.event.actor_id ?? actor?.id ?? null });
  const audit: AuditInput = {
    action: event.type, resource_id: event.resource_id, resource_revision: event.resource_revision,
    account_id: event.account_id, repo_id: event.repo_id, actor_id: event.actor_id,
    credential_id: actor?.credential_id ?? null, request_id: c.get('requestId'),
    ...mutation.audit,
    id: mutation.audit?.id ?? newId('audit'),
  };
  const before: D1PreparedStatement[] = [];
  const after: D1PreparedStatement[] = [];
  const routing = c.get('routing');
  const metadataRepo = selectedRepositoryScope(c);
  if (routing && metadataRepo === routing.resource_id && sameDatabaseLocation(routing, requestDatabaseLocation(c))) {
    const guard = newId('guard');
    before.push(routingGuardStatement(db, routing.resource_id, routing.epoch, guard, routing.expected_state));
    after.push(stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard));
  }
  const request = c.get('idempotency');
  // Retry metadata may have been supplemented by a shared module. It cannot
  // replace or drop the route's other scopes, and is never the source of identity.
  if (request) retainRequestPolicies(authority, request.policies);
  if (mutation.authorizations) await requestPolicies(c, mutation.authorizations);
  if (!authority.policies.length && authority.capability && (event.repo_id || event.account_id)) {
    await requestPolicies(c, [{ capability: authority.capability,
      scope: event.repo_id ? { repo_id: event.repo_id } : { account_id: event.account_id! } }]);
  }
  if (authority.principal || actor) {
    const identity = newId('guard');
    before.push(separateIdentityAuthority(c) ? remoteIdentityGuard(c, authority, db, identity) : primaryIdentityGuard(c, authority, db, identity));
    after.push(stmt(db, 'DELETE FROM mutation_guards WHERE id=?', identity));
  }
  const policies = await Promise.all(authority.policies.map(async policy => ({ policy, local: await repositoryPolicyIsLocal(c, policy) })));
  const versions = await prepareAccountAuthority(c, authority, policies);
  for (const version of versions) {
    const guard = newId('guard');
    before.push(accountAuthorityGuard(c, db, version, guard));
    after.push(stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard));
  }
  for (const { policy, local } of policies) {
    const guard = newId('guard');
    const statement = policyGuard(c, db, policy, guard, local);
    if (!statement) continue;
    before.push(statement);
    after.push(stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard));
  }
  const repositoryStorage = metadataRepo !== null;
  const locator = await registerEventResourceLocator(c.env, event, separateIdentityAuthority(c), repositoryStorage ? 'repository' : 'identity');
  if (locator && !separateIdentityAuthority(c)) before.push(...resourceLocatorGuard(db, locator));
  if (request) {
    const ownership = newId('guard');
    before.push(requestOwnership(db, request, ownership));
    request.policies = authority.policies;
    const receipt = newId('guard');
    after.push(stmt(db, `UPDATE idempotency_keys SET resource_id=?,repo_id=?,account_id=?,event_id=?,audit_id=?,
      committed_at=?,policy_json=?,updated_at=? WHERE principal_id=? AND key=? AND request_hash=?
      AND generation=? AND attempt_id=? AND strategy=? AND status IN ('pending','uncertain')`,
    event.resource_id, event.repo_id ?? null, event.account_id ?? null, event.id, audit.id!, now(), canonicalJson(request.policies), now(),
    request.principal_id, request.key, request.request_hash, request.generation, request.attempt_id, request.strategy),
    stmt(db, 'INSERT INTO idempotency_write_guards(id,ok) VALUES (?,changes())', receipt),
    stmt(db, 'DELETE FROM idempotency_write_guards WHERE id IN (?,?)', ownership, receipt));
  }
  if (metadataRepo) {
    const guard = newId('guard');
    // Genuine credential/policy/revision/generation conflicts win immediately.
    // The local fence remains a commit-time guard before any resource effects.
    before.push(repositoryMetadataFenceGuard(db, metadataRepo, guard, currentRepositoryMetadataFence(c, metadataRepo)));
    after.push(stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard));
  }
  return [...before, ...mutation.statements, eventStatement(db, event), auditStatement(db, audit), ...after];
}

/** A failed compare-and-swap aborts the event and every dependent effect in the batch. */
export async function mutate(c: AppContext, mutation: Mutation): Promise<D1Result[]> {
  const db = database(c);
  const guard = newId('guard');
  const statements = await mutationStatements(c, { event: mutation.event, audit: mutation.audit, authorizations: mutation.authorizations, statements: [
    stmt(db, mutation.sql, ...(mutation.bindings ?? [])), mutationGuard(db, guard),
    ...(mutation.after ?? []), stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard),
  ] });
  try {
    return await executeMutationBatch(c, statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/idempotency_generation_current/i.test(message)) {
      throw new ApiError(409, 'idempotency_request_superseded', 'This request generation can no longer write. Retry with the same idempotency key.');
    }
    if (/mutation_requires_one_row|CHECK constraint failed.*(?:ok|mutation)/i.test(message)) {
      throw new ApiError(412, 'revision_conflict', 'This resource changed while you were editing it. Refresh it and reapply your changes.');
    }
    if (/UNIQUE constraint failed/i.test(message)) {
      throw new ApiError(409, 'already_exists', 'A resource with these details already exists.');
    }
    throw error;
  }
}
