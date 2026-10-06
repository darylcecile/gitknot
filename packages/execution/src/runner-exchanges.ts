import { ApiError, auditStatement, authorize, canonicalJson, credentialIsCurrent, eventStatement, identityDatabaseLocation, many, mutationStatements, now, one, ownedAccountAuthority, prepareCredential, principalForExplanation, readRepositoryAuthority, releaseAccountAuthority, sameDatabaseLocation, sha256, stmt, withAccountAuthorityBarrier } from '@gitknot/core';
import type { AccountAuthorityVersion, Bindings, CredentialRecord, Database } from '@gitknot/core';
import { credentialExchangeSchema, deriveRunnerCredential } from '@gitknot/runner/credential-exchange';
import type { CredentialExchange } from '@gitknot/runner/credential-exchange';
import { z } from 'zod';
import { guardedBatch, identityPrimary } from './store.ts';
import type { RunnerPool, RunnerRecord } from './types.ts';
import { assertRunnerPoolScope, enrollRunnerMetadataAuthority, loadRunnerAuthority, readRunnerPool, runnerFencePredicate, runnerIdentityContext } from './runner-authority.ts';
import { registerRunnerChildLocator, runnerMetadataRequest, runnerResourcePlacement, sameRunnerPlacement, type RunnerPlacement } from './runner-placement.ts';
import { projectionStatements, readProjection, verifyRunnerProjection } from './runner-projections.ts';
import { databaseClock, runnerCondition } from './runner-guards.ts';

export const runnerExchangeSchema = z.object({ exchange: credentialExchangeSchema }).strict();
export interface RunnerEnrollment {
  id: string; account_id: string; repo_id: string | null; pool_id: string; token_hash: string; expires_at: string;
  consumed_at: string | null; runner_id: string | null; registration_hash: string | null; created_by: string; created_at: string; revision: number;
}
export interface RunnerProjection {
  pool: RunnerPool;
  runner: RunnerRecord;
  previous: RunnerRecord | null;
  enrollment: RunnerEnrollment | null;
  source_credential_id: string | null;
  source_credential_revision: number | null;
  source_credential_expires_at: string | null;
  created_by: string;
}
export interface RunnerExchange {
  id: string; kind: 'register' | 'rotate'; runner_id: string; pool_id: string; account_id: string; scope_repo_id: string | null;
  metadata_authority: 'identity' | 'repository'; metadata_repo_id: string | null; enrollment_id: string | null;
  source_hash: string; nonce_hash: string; request_hash: string; expected_generation: number;
  credential_id: string; credential_generation: number; credential_json: string; projection_json: string; projection_hash: string;
  state: 'pending' | 'committed'; response_json: string; expires_at: string; created_at: string; committed_at: string | null;
}

export async function exchangeRequestHash(env: Bindings, input: object, exchange: CredentialExchange): Promise<string> {
  return sha256(canonicalJson({ api_origin: env.API_ORIGIN, input, version: exchange.version, id: exchange.id, expected_generation: exchange.expected_generation }));
}

export async function deriveMachineCredential(env: Bindings, source: string, exchange: CredentialExchange, kind: RunnerExchange['kind'], request: object, runnerId?: string): Promise<string> {
  try { return await deriveRunnerCredential(source, { api_origin: env.API_ORIGIN, operation: kind, subject: kind === 'register' ? 'enrollment' : runnerId!, request, exchange }); }
  catch { throw new ApiError(422, 'invalid_credential_exchange', 'The credential exchange identity, nonce, or API origin is invalid.'); }
}

export function machineCredentialStatement(db: Database, credential: CredentialRecord): D1PreparedStatement {
  return stmt(db, `INSERT INTO credentials (id,principal_id,user_id,kind,name,token_hash,token_prefix,capabilities_json,repository_ids_json,account_ids_json,ref_patterns_json,path_patterns_json,parent_id,rotation_of_id,auth_revision,mfa,authenticated_at,expires_at,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, credential.id, credential.principal_id, credential.user_id, credential.kind, credential.name, credential.token_hash, credential.token_prefix,
  credential.capabilities_json, credential.repository_ids_json, credential.account_ids_json, credential.ref_patterns_json, credential.path_patterns_json, credential.parent_id,
  credential.rotation_of_id, credential.auth_revision, credential.mfa, credential.authenticated_at, credential.expires_at, credential.created_by, credential.created_at);
}

export function exchangeStatement(db: Database, row: RunnerExchange): D1PreparedStatement {
  return stmt(db, `INSERT INTO runner_credential_exchanges (id,kind,runner_id,pool_id,account_id,scope_repo_id,metadata_authority,metadata_repo_id,enrollment_id,
    source_hash,nonce_hash,request_hash,expected_generation,credential_id,credential_generation,credential_json,projection_json,projection_hash,state,response_json,expires_at,created_at,committed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, row.id, row.kind, row.runner_id, row.pool_id, row.account_id, row.scope_repo_id, row.metadata_authority, row.metadata_repo_id, row.enrollment_id,
  row.source_hash, row.nonce_hash, row.request_hash, row.expected_generation, row.credential_id, row.credential_generation, row.credential_json, row.projection_json, row.projection_hash, row.state, row.response_json, row.expires_at, row.created_at, row.committed_at);
}

export function parseRunnerProjection(row: RunnerExchange): RunnerProjection {
  try {
    const projection = JSON.parse(row.projection_json) as RunnerProjection;
    const next = projection.runner, pool = projection.pool, credential = JSON.parse(row.credential_json) as CredentialRecord;
    if (next.id !== row.runner_id || next.pool_id !== row.pool_id || next.account_id !== row.account_id || next.repo_id !== row.scope_repo_id
      || next.credential_generation !== row.credential_generation || next.credential_expires_at !== row.expires_at || next.state !== 'active'
      || pool.id !== row.pool_id || pool.account_id !== row.account_id || pool.repo_id !== row.scope_repo_id
      || credential.id !== row.credential_id || credential.principal_id !== row.runner_id || credential.kind !== 'runner'
      || credential.token_hash !== next.credential_hash || credential.expires_at !== row.expires_at || credential.parent_id !== null
      || (row.kind === 'register' ? projection.enrollment?.id !== row.enrollment_id || projection.previous !== null
        : projection.previous?.credential_generation !== row.expected_generation || projection.previous.credential_hash !== row.source_hash || !projection.source_credential_id)) throw new Error();
    return projection;
  } catch { throw new ApiError(503, 'runner_exchange_corrupt', 'The durable runner projection could not be verified.'); }
}

export async function readRunnerExchange(env: Bindings, id: string): Promise<RunnerExchange | null> {
  const row = await one<RunnerExchange>(identityPrimary(env), 'SELECT * FROM runner_credential_exchanges WHERE id=?', id);
  if (row && await sha256(row.projection_json) !== row.projection_hash) throw new ApiError(503, 'runner_exchange_corrupt', 'The immutable runner projection digest is invalid.');
  return row;
}

async function poolRepositoryIds(env: Bindings, pool: RunnerPool): Promise<string[]> {
  if (pool.repo_id) return [pool.repo_id];
  // The identity catalog supplies IDs only. A moved/retained owner is never a grant.
  const hints = await many<{ id: string }>(identityPrimary(env), 'SELECT id FROM repositories WHERE owner_id=? ORDER BY id LIMIT 1000', pool.account_id);
  const ids: string[] = [], context = runnerIdentityContext(env);
  for (const hint of hints) {
    const repository = await readRepositoryAuthority(context, hint.id);
    if (repository?.owner_id === pool.account_id && repository.state === 'active') ids.push(repository.id);
  }
  return ids;
}

function idleSourceGuard(db: Database, runner: RunnerRecord, credential: CredentialRecord): D1PreparedStatement[] {
  return runnerCondition(db, `EXISTS (SELECT 1 FROM credentials c JOIN principals p ON p.id=c.principal_id JOIN accounts a ON a.id=p.account_id
    WHERE c.id=? AND c.principal_id=? AND c.token_hash=? AND c.revision=? AND c.kind='runner' AND c.parent_id IS NULL AND c.revoked_at IS NULL
      AND c.expires_at>${databaseClock} AND p.kind='runner' AND p.disabled_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>${databaseClock})
      AND p.account_id=? AND a.disabled_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM runner_slot_reservations WHERE runner_id=? AND (state='leased' OR state='reserved' AND expires_at>${databaseClock}))
    AND (?=0 OR (NOT EXISTS (SELECT 1 FROM runner_disposable_consumption WHERE runner_id=?)
      AND NOT EXISTS (SELECT 1 FROM runner_slot_reservations WHERE runner_id=? AND assigned_at IS NOT NULL)))
    AND NOT EXISTS (SELECT 1 FROM runner_retirements WHERE runner_id=?)`,
  [credential.id, runner.id, credential.token_hash, credential.revision, runner.account_id, runner.id, runner.disposable, runner.id, runner.id, runner.id]);
}

export async function prepareRunnerExchange(env: Bindings, exchange: CredentialExchange, kind: RunnerExchange['kind'], source: string, request: object,
  pool: RunnerPool, placement: RunnerPlacement, runner: RunnerRecord, enrollment: RunnerEnrollment | null, previous: RunnerRecord | null, sourceCredential: CredentialRecord | null): Promise<RunnerExchange> {
  const db = identityPrimary(env), expires = runner.credential_expires_at;
  const prepared = await prepareCredential(db, { principal_id: runner.id, user_id: null, kind: 'runner', name: runner.name, capabilities: ['runners.poll', 'runners.heartbeat'],
    repository_ids: runner.repo_id ? [runner.repo_id] : null, account_ids: [runner.account_id], rotation_of_id: sourceCredential?.id ?? null,
    auth_revision: null, mfa: false, expires_at: expires, created_by: enrollment?.created_by ?? runner.id });
  const token = await deriveMachineCredential(env, source, exchange, kind, request, runner.id);
  prepared.credential.id = `cred_${exchange.id.slice(4)}`;
  prepared.credential.token_hash = await sha256(token);
  // Journals retain only hashes and public metadata, including no secret prefix.
  prepared.credential.token_prefix = 'gkt_';
  runner = { ...runner, credential_hash: prepared.credential.token_hash };
  const projection: RunnerProjection = { pool, runner, previous, enrollment, source_credential_id: sourceCredential?.id ?? null,
    source_credential_revision: sourceCredential?.revision ?? null, source_credential_expires_at: sourceCredential?.expires_at ?? null, created_by: enrollment?.created_by ?? runner.id };
  const projectionJson = canonicalJson(projection);
  const response = kind === 'register' ? { runner_id: runner.id, pool_id: pool.id, pool_name: pool.name, account_id: pool.account_id, repository_ids: await poolRepositoryIds(env, pool),
    trust: pool.trust, disposable: Boolean(runner.disposable), credential_expires_at: expires, credential_generation: 1, exchange_id: exchange.id, heartbeat_interval_seconds: 15, poll_timeout_seconds: 25 }
    : { credential_expires_at: expires, credential_generation: runner.credential_generation, exchange_id: exchange.id };
  const row: RunnerExchange = { id: exchange.id, kind, runner_id: runner.id, pool_id: pool.id, account_id: pool.account_id, scope_repo_id: pool.repo_id,
    metadata_authority: placement.locator.authority, metadata_repo_id: placement.locator.repo_id, enrollment_id: enrollment?.id ?? null,
    source_hash: await sha256(source), nonce_hash: await sha256(exchange.nonce), request_hash: await exchangeRequestHash(env, request, exchange), expected_generation: exchange.expected_generation,
    credential_id: prepared.credential.id, credential_generation: runner.credential_generation, credential_json: canonicalJson(prepared.credential), projection_json: projectionJson,
    projection_hash: await sha256(projectionJson), state: 'pending', response_json: canonicalJson(response), expires_at: expires, created_at: now(), committed_at: null };
  await registerRunnerChildLocator(env, placement, runner.id, 'runner');
  try {
    await db.batch([...(sourceCredential ? idleSourceGuard(db, runner, sourceCredential) : []), exchangeStatement(db, row),
      stmt(db, 'INSERT INTO runner_credential_exchange_locks(runner_id,exchange_id,account_id,created_at) VALUES (?,?,?,?)', row.runner_id, row.id, row.account_id, row.created_at)]);
  } catch (error) {
    const duplicate = await readRunnerExchange(env, row.id);
    if (duplicate) return duplicate;
    if (/UNIQUE constraint|mutation_requires_one_row/i.test(String(error))) throw new ApiError(409, 'credential_exchange_conflict', 'The credential source or machine changed or already has a different durable exchange. Recover the original exchange.');
    throw error;
  }
  return row;
}

async function sourceIsCurrent(env: Bindings, row: RunnerExchange, projection: RunnerProjection): Promise<void> {
  if (row.expires_at <= now()) throw new ApiError(401, 'credential_recovery_denied', 'The exchanged credential has expired.');
  if (row.kind === 'register') {
    if (!projection.enrollment || projection.enrollment.expires_at <= now() || !await principalForExplanation(identityPrimary(env), projection.created_by)) throw new ApiError(401, 'enrollment_invalid', 'The enrollment or its creator is no longer active.');
    return;
  }
  const source = await one<CredentialRecord>(identityPrimary(env), 'SELECT * FROM credentials WHERE id=? AND principal_id=? AND token_hash=?', projection.source_credential_id, row.runner_id, row.source_hash);
  if (!source || source.revision !== projection.source_credential_revision || source.expires_at !== projection.source_credential_expires_at
    || !await credentialIsCurrent(identityPrimary(env), source)) throw new ApiError(401, 'credential_recovery_denied', 'The original credential was independently changed, revoked or expired.');
  if (await one(identityPrimary(env), `SELECT attempt_id FROM runner_slot_reservations WHERE runner_id=? AND (state='leased' OR state='reserved' AND expires_at>${databaseClock}) LIMIT 1`, row.runner_id)) throw new ApiError(409, 'runner_busy', 'Machine credentials cannot rotate while a slot is active or cleanup is unconfirmed.');
  if (projection.runner.disposable && (projection.previous?.assignment_attempt_id
    || await one(identityPrimary(env), 'SELECT runner_id FROM runner_disposable_consumption WHERE runner_id=?', row.runner_id)
    || await one(identityPrimary(env), 'SELECT attempt_id FROM runner_slot_reservations WHERE runner_id=? AND assigned_at IS NOT NULL LIMIT 1', row.runner_id))) throw new ApiError(409, 'disposable_consumed', 'A consumed disposable machine cannot rotate or receive another assignment.');
}

function identityCommitStatements(env: Bindings, db: Database, row: RunnerExchange, projection: RunnerProjection, placement: RunnerPlacement, fence: AccountAuthorityVersion): D1PreparedStatement[] {
  const at = now(), credential = JSON.parse(row.credential_json) as CredentialRecord;
  const authority = runnerFencePredicate(env, { ...placement, location: identityDatabaseLocation(env) }, fence);
  const statements = runnerCondition(db, authority.sql, authority.values);
  statements.push(...runnerCondition(db, `EXISTS (SELECT 1 FROM accounts WHERE id=? AND disabled_at IS NULL)
    AND EXISTS (SELECT 1 FROM runner_credential_exchange_locks WHERE runner_id=? AND exchange_id=? AND account_id=?)
    AND NOT EXISTS (SELECT 1 FROM runner_retirements WHERE runner_id=?) AND ?>${databaseClock}`,
  [row.account_id, row.runner_id, row.id, row.account_id, row.runner_id, row.expires_at]));
  if (row.kind === 'register') {
    statements.push(...runnerCondition(db, `?>${databaseClock}`, [projection.enrollment!.expires_at]));
    statements.push(stmt(db, `INSERT INTO principals(id,kind,account_id,name,created_by,created_at,updated_at) VALUES (?,'runner',?,?,?,?,?)`, row.runner_id, row.account_id, projection.runner.name, projection.created_by, at, at));
  } else {
    statements.push(...idleSourceGuard(db, projection.previous!, { ...credential, id: projection.source_credential_id!, token_hash: row.source_hash, revision: projection.source_credential_revision! }));
    statements.push(...runnerCondition(db, 'EXISTS (SELECT 1 FROM credentials WHERE id=? AND expires_at=?)', [projection.source_credential_id, projection.source_credential_expires_at]));
    statements.push(stmt(db, 'UPDATE credentials SET revoked_at=?,revision=revision+1 WHERE id=? AND token_hash=? AND revoked_at IS NULL', at, projection.source_credential_id, row.source_hash));
  }
  statements.push(machineCredentialStatement(db, credential));
  statements.push(stmt(db, "UPDATE runner_credential_exchanges SET state='committed',committed_at=? WHERE id=? AND state='pending'", at, row.id));
  statements.push(stmt(db, 'DELETE FROM runner_credential_exchange_locks WHERE runner_id=? AND exchange_id=?', row.runner_id, row.id));
  statements.push(eventStatement(db, { type: row.kind === 'register' ? 'runner.registered' : 'runner.credential.rotated', resource_id: row.runner_id, resource_revision: projection.runner.revision, account_id: row.account_id, repo_id: row.scope_repo_id, actor_id: projection.created_by, data: { pool_id: row.pool_id, exchange_id: row.id, credential_generation: row.credential_generation } }));
  statements.push(auditStatement(db, { action: row.kind === 'register' ? 'runners.registered' : 'runners.credential_rotated', resource_id: row.runner_id, account_id: row.account_id, repo_id: row.scope_repo_id, actor_id: projection.created_by, details: { exchange_id: row.id, pool_id: row.pool_id } }));
  return statements;
}

async function recoverExchangeBarrier(env: Bindings, row: RunnerExchange): Promise<void> {
  const abandoned = await one<{ id: string; reason: string; recover_after: string }>(identityPrimary(env), 'SELECT id,reason,recover_after FROM account_policy_barriers WHERE account_id=?', row.account_id);
  if (abandoned?.reason === `runner-exchange:${row.id}` && abandoned.recover_after <= now()) await releaseAccountAuthority(env, row.account_id, abandoned.id);
}

async function completePendingExchange(env: Bindings, initial: RunnerExchange): Promise<void> {
  const projection = parseRunnerProjection(initial), placement = await runnerResourcePlacement(env, initial.runner_id, 'runner');
  if (placement.locator.authority !== initial.metadata_authority || placement.locator.repo_id !== initial.metadata_repo_id
    || !sameRunnerPlacement(placement, await runnerResourcePlacement(env, initial.pool_id, 'runner_pool'))) throw new ApiError(409, 'runner_exchange_placement', 'The exchange no longer matches its immutable storage authority.');
  await assertRunnerPoolScope(env, await readRunnerPool(env, initial.pool_id));
  await enrollRunnerMetadataAuthority(env, placement, initial.account_id);
  const actor = initial.kind === 'register' ? await principalForExplanation(identityPrimary(env), projection.created_by) : null;
  const context = runnerIdentityContext(env, actor);
  // Generic admission intentionally rejects an account with a policy barrier.
  // Capture the grant before fencing, then retain its guards in the commit batch.
  if (initial.kind === 'register') await authorize(context, 'runners.manage', projection.pool.repo_id ? { repo_id: projection.pool.repo_id } : { account_id: projection.pool.account_id });
  await withAccountAuthorityBarrier(context, initial.account_id, `runner-exchange:${initial.id}`, async () => {
    const row = await readRunnerExchange(env, initial.id);
    if (!row || row.state === 'committed') return;
    const fence = ownedAccountAuthority(context, row.account_id);
    if (!fence) throw new ApiError(503, 'runner_exchange_fence', 'The machine account fence could not be established.');
    const pool = await readRunnerPool(env, row.pool_id);
    await assertRunnerPoolScope(env, pool);
    if (pool.revision !== projection.pool.revision) throw new ApiError(409, 'runner_pool_changed', 'Pool policy changed while the credential exchange was pending.');
    await sourceIsCurrent(env, row, projection);
    const db = identityPrimary(env);
    const sourceAuthority = row.kind === 'register' ? await mutationStatements(context, { statements: [], event: {
      type: 'runner.exchange.authorized', resource_id: row.id, resource_revision: 1, repo_id: row.scope_repo_id, account_id: row.account_id,
      data: { runner_id: row.runner_id, pool_id: row.pool_id },
    } }) : [];
    const identity = [...sourceAuthority, ...identityCommitStatements(env, db, row, projection, placement, fence)];
    if (sameDatabaseLocation(identityDatabaseLocation(env), placement.location)) {
      const receipt = await readProjection(db, row.id);
      if (receipt) await verifyRunnerProjection(env, placement, row);
      await guardedBatch(db, stmt(db, "UPDATE runner_credential_exchanges SET state='pending' WHERE id=? AND state='pending'", row.id), [
        ...(receipt ? [] : projectionStatements(env, db, placement, row, projection, fence)), ...identity,
      ]);
    } else {
      await runnerMetadataRequest(env, placement, { action: 'project', exchange_id: row.id, fence: { ...fence, phase: 'fenced', barrier_id: fence.barrier_id! } });
      await verifyRunnerProjection(env, placement, row);
      await sourceIsCurrent(env, row, projection);
      await guardedBatch(db, stmt(db, "UPDATE runner_credential_exchanges SET state='pending' WHERE id=? AND state='pending'", row.id), identity);
    }
  });
}

async function assertRetiredExchangeSource(env: Bindings, row: RunnerExchange): Promise<void> {
  const projection = parseRunnerProjection(row);
  if (row.kind === 'register') {
    if (projection.enrollment!.expires_at <= now()) throw new ApiError(401, 'credential_recovery_denied', 'The original enrollment recovery lifetime expired.');
    return;
  }
  const source = await one<CredentialRecord>(identityPrimary(env), 'SELECT * FROM credentials WHERE id=? AND principal_id=? AND token_hash=?', projection.source_credential_id, row.runner_id, row.source_hash);
  if (!source || source.kind !== 'runner' || source.parent_id !== null || source.revision !== projection.source_credential_revision! + 1
    || source.revoked_at !== row.committed_at || source.expires_at !== projection.source_credential_expires_at || source.expires_at <= now()) throw new ApiError(401, 'credential_recovery_denied', 'The source credential was independently changed, revoked or expired after its recorded exchange.');
}

export async function recoverRunnerExchange(env: Bindings, exchange: CredentialExchange, kind: RunnerExchange['kind'], source: string, request: object, runnerId?: string): Promise<Record<string, unknown> | null> {
  let row = await readRunnerExchange(env, exchange.id);
  if (!row) return null;
  if (row.kind !== kind || row.source_hash !== await sha256(source) || row.nonce_hash !== await sha256(exchange.nonce)
    || row.request_hash !== await exchangeRequestHash(env, request, exchange) || row.expected_generation !== exchange.expected_generation
    || row.credential_generation !== exchange.expected_generation + 1 || runnerId && row.runner_id !== runnerId || row.expires_at <= now()) throw new ApiError(401, 'credential_recovery_denied', 'Only the exact recorded credential exchange may be recovered.');
  await recoverExchangeBarrier(env, row);
  if (row.state === 'pending') {
    try { await completePendingExchange(env, row); }
    catch (error) {
      const committed = await readRunnerExchange(env, row.id);
      if (committed?.state !== 'committed') throw error;
    }
    row = (await readRunnerExchange(env, row.id))!;
  }
  if (row.state !== 'committed') throw new ApiError(503, 'credential_exchange_pending', 'The credential exchange has not completed both authorities.');
  const authority = await loadRunnerAuthority(env, row.runner_id);
  if (authority.runner.pool_id !== row.pool_id || authority.runner.account_id !== row.account_id || authority.runner.credential_generation !== row.credential_generation
    || authority.credential.id !== row.credential_id || authority.pool.revision !== parseRunnerProjection(row).pool.revision) throw new ApiError(409, 'credential_exchange_retired', 'The exchanged credential or pool authority is no longer current.');
  await verifyRunnerProjection(env, await runnerResourcePlacement(env, row.runner_id, 'runner'), row);
  await assertRetiredExchangeSource(env, row);
  const token = await deriveMachineCredential(env, source, exchange, kind, request, row.runner_id);
  if (await sha256(token) !== authority.credential.token_hash) throw new ApiError(409, 'credential_exchange_changed', 'The deterministic exchange no longer matches this machine.');
  return { ...(JSON.parse(row.response_json) as Record<string, unknown>), machine_token: token };
}

export { projectRunnerExchange } from './runner-projections.ts';
