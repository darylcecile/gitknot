import { ApiError, authorize, execute, hmac, many, mutationStatements, newId, now, one, principalForExplanation, signInternalRequest, stmt } from '@gitknot/core';
import type { AppContext, Bindings, Database } from '@gitknot/core';
import { resolveSourceRef } from './source.ts';
import { guardedBatch, identityPrimary, primary } from './store.ts';
import { responseJson } from './transport.ts';
import type { ExecutionObject, JobRecord, PlanJob, RunRecord } from './types.ts';
import type { AttemptContext } from './types.ts';
import { authorizeExecutionActor, currentApproverAuthority, currentExecutionActor } from './authorization.ts';
import type { ExecutionPlan } from './types.ts';

export interface EnvironmentRecord {
  id: string; repo_id: string; account_id: string; name: string; destination: string; target_ref: string;
  required_approvals: number; allow_self_approval: number; allowed_approvers_json: string; revision: number; created_at: string; updated_at: string;
  state: 'active' | 'deleted'; deleted_at: string | null; deleted_by: string | null;
}
export interface PromotionRecord {
  id: string; repo_id: string; account_id: string; run_id: string; job_id: string | null; environment_id: string; environment_revision: number;
  artifact_id: string; artifact_digest: string; commit_sha: string; plan_digest: string; destination: string; target_ref: string;
  status: 'waiting' | 'waiting_approval' | 'approved' | 'promoting' | 'released' | 'rejected' | 'invalidated' | 'cancelled';
  requested_by: string; request_key: string; request_hash: string; revision: number; created_at: string; updated_at: string; released_at: string | null;
  enqueue_sequence: number;
  requester_credential_id: string | null;
}

export async function createPromotion(db: Database, run: RunRecord, environment: EnvironmentRecord, artifact: ExecutionObject,
  actorId: string, requestKey: string, requestHash: string, jobId: string | null = null, apiContext?: AppContext): Promise<PromotionRecord> {
  const existing = await one<PromotionRecord>(db, 'SELECT * FROM workflow_promotions WHERE repo_id=? AND request_key=?', run.repo_id, requestKey);
  if (existing) {
    if (existing.request_hash !== requestHash) throw new ApiError(409, 'idempotency_conflict', 'The promotion key was used for a different artifact.');
    return existing;
  }
  if (environment.state !== 'active') throw new ApiError(410, 'environment_deleted', 'The protected environment was retired.');
  if (environment.repo_id !== run.repo_id || artifact.repo_id !== run.repo_id || artifact.kind !== 'manifest' || !artifact.name.startsWith('output:') || !artifact.source_digest || artifact.state !== 'sealed' || artifact.expires_at <= now()) throw new ApiError(409, 'artifact_unavailable', 'Select a retained, verified output artifact from this repository.');
  const producer = await one<{ status: string; plan_digest: string; commit_sha: string }>(db, `SELECT a.status,a.plan_digest,r.commit_sha FROM execution_attempts a JOIN workflow_runs r ON r.id=a.run_id AND r.repo_id=a.repo_id WHERE a.id=? AND a.repo_id=?`, artifact.attempt_id, run.repo_id);
  if (!producer || producer.status !== 'succeeded' || producer.commit_sha !== run.commit_sha || producer.plan_digest !== run.plan_digest) throw new ApiError(409, 'artifact_unverified', 'The artifact was not verified for this exact commit and plan.');
  const id = newId('promotion'), at = now();
  const actor = (JSON.parse(run.plan_json) as ExecutionPlan).actor;
  const credentialId = apiContext?.get('principal')?.credential_id ?? (actorId === actor.id ? actor.credential_id : null);
  await guardedBatch(db, stmt(db, `INSERT INTO workflow_promotions (id,repo_id,account_id,run_id,job_id,environment_id,environment_revision,artifact_id,artifact_digest,commit_sha,plan_digest,destination,target_ref,status,requested_by,request_key,request_hash,created_at,updated_at,requester_credential_id,enqueue_sequence)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(enqueue_sequence),0)+1 FROM workflow_promotions WHERE repo_id=? AND environment_id=?)
      WHERE EXISTS (SELECT 1 FROM workflow_environments e JOIN repositories repo ON repo.id=e.repo_id JOIN workflow_runs r ON r.id=? AND r.repo_id=repo.id
         WHERE e.id=? AND e.repo_id=? AND e.revision=? AND e.state='active' AND repo.owner_id=? AND repo.state='active' AND repo.policy_revision=r.policy_revision AND r.status NOT IN ('cancelling','cancelled'))
        AND EXISTS (SELECT 1 FROM execution_objects o JOIN execution_attempts a ON a.id=o.attempt_id WHERE o.id=? AND o.repo_id=? AND o.source_digest=? AND o.state='sealed' AND o.expires_at>? AND a.status='succeeded' AND a.plan_digest=?)`,
  id, run.repo_id, run.account_id, run.id, jobId, environment.id, environment.revision, artifact.id, artifact.source_digest, run.commit_sha, run.plan_digest,
  environment.destination, environment.target_ref, environment.required_approvals ? 'waiting_approval' : 'approved', actorId, requestKey, requestHash, at, at, credentialId, run.repo_id, environment.id,
  run.id, environment.id, run.repo_id, environment.revision, run.account_id, artifact.id, run.repo_id, artifact.source_digest, at, run.plan_digest), [], {
    context: apiContext, event: { type: 'workflow.promotion.requested', resource_id: id, resource_revision: 1, repo_id: run.repo_id, account_id: run.account_id,
      actor_id: actorId, data: { run_id: run.id, environment_id: environment.id, artifact_digest: artifact.source_digest, commit_sha: run.commit_sha, plan_digest: run.plan_digest } },
  });
  const promotion = await one<PromotionRecord>(db, 'SELECT * FROM workflow_promotions WHERE id=? AND repo_id=?', id, run.repo_id);
  if (!promotion) throw new Error('The committed promotion could not be read.');
  return promotion;
}

export async function jobEnvironmentReady(env: Bindings, run: RunRecord, job: JobRecord, definition: PlanJob): Promise<boolean> {
  if (!definition.environment) return true;
  const db = primary(env);
  const environment = await one<EnvironmentRecord>(db, 'SELECT * FROM workflow_environments WHERE id=? AND repo_id=?', definition.environment.id, run.repo_id);
  if (!environment || environment.state !== 'active') {
    await execute(db, `UPDATE workflow_jobs SET status='dependency_blocked',reason='The protected environment is retired or unavailable.',completed_at=?,updated_at=?,revision=revision+1
      WHERE id=? AND repo_id=? AND current_attempt_id IS NULL AND status IN ('waiting','ready','waiting_approval')`, now(), now(), job.id, run.repo_id);
    return false;
  }
  const producer = await one<JobRecord>(db, `SELECT * FROM workflow_jobs WHERE run_id=? AND repo_id=? AND job_key=? AND status='succeeded'`, run.id, run.repo_id, definition.environment.artifact_job);
  const artifact = producer && await one<ExecutionObject>(db, `SELECT * FROM execution_objects WHERE attempt_id=? AND repo_id=? AND kind='manifest' AND name=? AND state='sealed' AND expires_at>?`,
    producer.current_attempt_id ?? producer.reused_attempt_id, run.repo_id, `output:${definition.environment.artifact_name}`, now());
  if (!environment || !artifact) throw new ApiError(409, 'environment_artifact_unavailable', 'The environment requires a verified artifact before admission.');
  const authority = await authorizeExecutionActor(env, JSON.parse(run.plan_json) as ExecutionPlan);
  const promotion = await createPromotion(db, run, environment, artifact, run.requested_by, `job:${job.id}`, `${run.plan_digest}:${artifact.source_digest}`, job.id, authority);
  if (['invalidated', 'cancelled', 'rejected'].includes(promotion.status)) {
    await execute(db, `UPDATE workflow_jobs SET status='dependency_blocked',reason='The exact artifact approval is no longer valid.',completed_at=?,updated_at=?,revision=revision+1 WHERE id=? AND repo_id=? AND current_attempt_id IS NULL`, now(), now(), job.id, run.repo_id);
    return false;
  }
  if (promotion.status !== 'approved' || await environmentPredecessor(db, promotion)) {
    await execute(db, `UPDATE workflow_jobs SET status='waiting_approval',reason=?,updated_at=?,revision=revision+1 WHERE id=? AND repo_id=? AND current_attempt_id IS NULL AND status!='waiting_approval'`,
      promotion.status !== 'approved' ? 'Waiting for approval of the exact artifact, commit, plan, and destination.' : 'An earlier environment release is queued.', now(), job.id, run.repo_id);
    return false;
  }
  await withAcceptedTarget(env, promotion, async () => { await assertPromotionCurrent(db, promotion); await requireCurrentApprovals(env, promotion, environment); });
  return true;
}

export async function decidePromotion(env: Bindings, db: Database, promotion: PromotionRecord, actorId: string, decision: 'approved' | 'rejected', apiContext?: AppContext, operationId?: string): Promise<void> {
  apiContext ??= await currentApproverAuthority(env, promotion.repo_id, actorId) ?? undefined;
  if (!apiContext) throw new ApiError(403, 'approver_revoked', 'A current authorized approver is required.');
  await authorize(apiContext, 'environments.approve', { repo_id: promotion.repo_id });
  const principal = apiContext?.get('principal');
  if (principal && principal.id !== actorId) throw new ApiError(403, 'approval_identity_mismatch', 'Approval assurance must belong to the authenticated approver.');
  if (!['waiting_approval', 'approved'].includes(promotion.status)) throw new ApiError(409, 'approval_closed', 'This promotion no longer accepts approvals.');
  const environment = await assertPromotionCurrent(db, promotion);
  const allowed: string[] = JSON.parse(environment.allowed_approvers_json);
  if (allowed.length && !allowed.includes(actorId)) throw new ApiError(403, 'approver_not_allowed', 'This environment requires one of its designated approvers.');
  if (!environment.allow_self_approval && actorId === promotion.requested_by) throw new ApiError(403, 'self_approval_denied', 'The release requester cannot approve this environment.');
  await withAcceptedTarget(env, promotion, async lock => {
    const at = now();
    await guardedBatch(db, stmt(db, `UPDATE workflow_promotions SET revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND revision=? AND status IN ('waiting_approval','approved')`, at, promotion.id, promotion.repo_id, promotion.revision), [
      lock.witness,
      stmt(db, `INSERT INTO environment_approvals (id,repo_id,account_id,run_id,promotion_id,approver_id,artifact_digest,commit_sha,plan_digest,destination,environment_revision,decision,created_at,approver_credential_id,approver_mfa,operation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        newId('approval'), promotion.repo_id, promotion.account_id, promotion.run_id, promotion.id, actorId, promotion.artifact_digest, promotion.commit_sha, promotion.plan_digest, promotion.destination, promotion.environment_revision, decision, at, principal?.credential_id ?? null, principal?.mfa ? 1 : 0, operationId ?? null),
      stmt(db, `UPDATE workflow_promotions SET status=CASE WHEN EXISTS (SELECT 1 FROM environment_approvals WHERE promotion_id=? AND decision='rejected') THEN 'rejected'
        WHEN (SELECT COUNT(*) FROM environment_approvals WHERE promotion_id=? AND decision='approved')>=? THEN 'approved' ELSE 'waiting_approval' END WHERE id=? AND repo_id=?`, promotion.id, promotion.id, environment.required_approvals, promotion.id, promotion.repo_id),
      lock.cleanup,
    ], { context: apiContext, event: { type: 'workflow.approval.decided', resource_id: promotion.id, resource_revision: promotion.revision + 1, repo_id: promotion.repo_id, account_id: promotion.account_id, actor_id: actorId, data: { run_id: promotion.run_id, decision } },
      audit: { action: `environments.${decision}`, resource_id: promotion.id, resource_revision: promotion.revision + 1, repo_id: promotion.repo_id, account_id: promotion.account_id, actor_id: actorId,
        details: { artifact_digest: promotion.artifact_digest, commit_sha: promotion.commit_sha, plan_digest: promotion.plan_digest, destination: promotion.destination } } });
  });
}

async function assertPromotionCurrent(db: Database, promotion: PromotionRecord): Promise<EnvironmentRecord> {
  const environment = await one<EnvironmentRecord>(db, 'SELECT * FROM workflow_environments WHERE id=? AND repo_id=?', promotion.environment_id, promotion.repo_id);
  const current = await one<{ policy_revision: number; state: string; owner_id: string }>(db, 'SELECT policy_revision,state,owner_id FROM repositories WHERE id=?', promotion.repo_id);
  const run = await one<RunRecord>(db, 'SELECT * FROM workflow_runs WHERE id=? AND repo_id=?', promotion.run_id, promotion.repo_id);
  if (!environment || environment.state !== 'active' || environment.revision !== promotion.environment_revision || environment.destination !== promotion.destination || environment.target_ref !== promotion.target_ref
    || !current || current.state !== 'active' || current.owner_id !== promotion.account_id || !run || run.policy_revision !== current.policy_revision || ['cancelling', 'cancelled'].includes(run.status)
    || run.plan_digest !== promotion.plan_digest || run.commit_sha !== promotion.commit_sha) throw new ApiError(409, 'approval_invalidated', 'The environment, repository policy, or exact release inputs changed.');
  const object = await one<ExecutionObject>(db, `SELECT * FROM execution_objects WHERE id=? AND repo_id=? AND state='sealed' AND expires_at>?`, promotion.artifact_id, promotion.repo_id, now());
  if (!object || object.source_digest !== promotion.artifact_digest) throw new ApiError(409, 'artifact_expired', 'The approved artifact is no longer retained.');
  return environment;
}

async function environmentPredecessor(db: Database, promotion: PromotionRecord): Promise<boolean> {
  return !!await one(db, `SELECT id FROM workflow_promotions WHERE repo_id=? AND environment_id=? AND id!=? AND status IN ('waiting','waiting_approval','approved','promoting')
    AND enqueue_sequence<? LIMIT 1`, promotion.repo_id, promotion.environment_id, promotion.id, promotion.enqueue_sequence);
}

export async function promoteArtifact(env: Bindings, promotionId: string, apiContext?: AppContext): Promise<{ released: boolean; release_id?: string }> {
  const db = primary(env);
  const promotion = await one<PromotionRecord>(db, 'SELECT * FROM workflow_promotions WHERE id=?', promotionId);
  if (!promotion) throw new ApiError(404, 'not_found', 'The promotion was not found.');
  const prior = await one<{ id: string }>(db, 'SELECT id FROM workflow_releases WHERE promotion_id=? AND repo_id=?', promotion.id, promotion.repo_id);
  if (prior) return { released: true, release_id: prior.id };
  if (promotion.status !== 'approved' || await environmentPredecessor(db, promotion)) return { released: false };
  const run = await one<RunRecord>(db, 'SELECT * FROM workflow_runs WHERE id=? AND repo_id=?', promotion.run_id, promotion.repo_id);
  if (!run) throw new ApiError(409, 'run_unavailable', 'The release run is unavailable.');
  apiContext ??= await authorizeExecutionActor(env, JSON.parse(run.plan_json) as ExecutionPlan);
  if (promotion.job_id) {
    const job = await one<JobRecord>(db, 'SELECT * FROM workflow_jobs WHERE id=? AND repo_id=?', promotion.job_id, promotion.repo_id);
    if (job?.status !== 'succeeded') return { released: false };
  }
  return withAcceptedTarget(env, promotion, async lock => {
    const environment = await assertPromotionCurrent(db, promotion);
    const approvals = await approvalWitnesses(env, promotion, environment);
    const at = now(), id = newId('release');
    await guardedBatch(db, stmt(db, `UPDATE workflow_promotions SET status='released',released_at=?,revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND revision=? AND status='approved'
      AND NOT EXISTS (SELECT 1 FROM workflow_promotions older WHERE older.repo_id=? AND older.environment_id=? AND older.id!=? AND older.status IN ('waiting','waiting_approval','approved','promoting') AND older.enqueue_sequence<?)`,
    at, at, promotion.id, promotion.repo_id, promotion.revision, promotion.repo_id, promotion.environment_id, promotion.id, promotion.enqueue_sequence), [
      lock.witness,
      ...approvals,
      stmt(db, `INSERT INTO workflow_releases (id,repo_id,account_id,run_id,promotion_id,environment_id,artifact_id,artifact_digest,commit_sha,plan_digest,destination,accepted_target_commit,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, promotion.repo_id, promotion.account_id, promotion.run_id, promotion.id, promotion.environment_id, promotion.artifact_id, promotion.artifact_digest, promotion.commit_sha, promotion.plan_digest, promotion.destination, promotion.commit_sha, at),
      lock.cleanup,
    ], { context: apiContext, event: { type: 'workflow.release.published', resource_id: id, resource_revision: 1, repo_id: promotion.repo_id, account_id: promotion.account_id,
      data: { run_id: promotion.run_id, artifact_digest: promotion.artifact_digest, commit_sha: promotion.commit_sha, plan_digest: promotion.plan_digest, destination: promotion.destination } } });
    return { released: true, release_id: id };
  });
}

async function barrier(env: Bindings, promotion: PromotionRecord, method: 'POST' | 'DELETE'): Promise<void> {
  const token = await hmac(env.INTERNAL_SERVICE_KEY, `GitKnot promotion barrier v1:${promotion.id}:${promotion.plan_digest}`);
  const request = new Request(`https://internal.gitknot.com/internal/git/repositories/${promotion.repo_id}/barrier`, { method,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, reason: `Artifact promotion ${promotion.id}` }) });
  const response = await env.GIT_SERVICE.fetch(await signInternalRequest(request, env.INTERNAL_SERVICE_KEY, 'git-service'));
  if (method === 'DELETE' && response.status === 403) {
    const value = await response.json() as { error?: { code: string } };
    if (value.error?.code === 'invalid_barrier') return;
  }
  await responseJson(response);
}

interface PromotionLock { witness: D1PreparedStatement; cleanup: D1PreparedStatement }

async function withAcceptedTarget<T>(env: Bindings, promotion: PromotionRecord, effect: (lock: PromotionLock) => Promise<T>): Promise<T> {
  const db = primary(env);
  const owner = newId('gate');
  const claimed = await execute(db, `INSERT INTO workflow_promotion_barriers (promotion_id,repo_id,account_id,state,owner_id,updated_at) VALUES (?,?,?,'acquiring',?,?)
    ON CONFLICT(promotion_id) DO UPDATE SET state='acquiring',owner_id=excluded.owner_id,updated_at=excluded.updated_at WHERE workflow_promotion_barriers.state='released'`, promotion.id, promotion.repo_id, promotion.account_id, owner, now());
  if (!claimed.meta.changes) throw new ApiError(409, 'promotion_in_progress', 'The environment decision is being reconciled. Retry shortly.');
  await barrier(env, promotion, 'POST');
  try {
    let principal = await principalForExplanation(identityPrimary(env), promotion.requested_by);
    if (!principal) throw new ApiError(403, 'release_identity_revoked', 'The release requester is no longer active.');
    principal = await currentExecutionActor(env, { id: principal.id, kind: principal.kind, user_id: principal.user_id, credential_id: promotion.requester_credential_id });
    const commit = await resolveSourceRef(env, promotion.repo_id, promotion.target_ref, principal);
    await execute(db, `UPDATE workflow_promotion_barriers SET state='held',checked_commit=?,checked_at=?,updated_at=? WHERE promotion_id=? AND repo_id=? AND owner_id=?`, commit, now(), now(), promotion.id, promotion.repo_id, owner);
    if (commit !== promotion.commit_sha) {
      await execute(db, `UPDATE workflow_promotions SET status='invalidated',revision=revision+1,updated_at=? WHERE id=? AND repo_id=? AND status NOT IN ('released','cancelled','rejected')`, now(), promotion.id, promotion.repo_id);
      if (promotion.job_id) await execute(db, `UPDATE workflow_jobs SET status='dependency_blocked',reason='A newer target invalidated this release approval.',completed_at=?,updated_at=?,revision=revision+1 WHERE id=? AND repo_id=? AND status NOT IN ('running','cancelling')`, now(), now(), promotion.job_id, promotion.repo_id);
      throw new ApiError(409, 'approval_invalidated', 'A newer accepted target commit invalidated this artifact approval.');
    }
    const lock: PromotionLock = {
      witness: stmt(db, `INSERT INTO mutation_guards (id,ok) SELECT ?,CASE WHEN EXISTS (
        SELECT 1 FROM workflow_promotion_barriers b JOIN workflow_promotions p ON p.id=b.promotion_id JOIN workflow_environments e ON e.id=p.environment_id
        JOIN workflow_runs r ON r.id=p.run_id JOIN repositories repo ON repo.id=p.repo_id
        WHERE b.promotion_id=? AND b.owner_id=? AND b.state='held' AND b.checked_commit=p.commit_sha AND b.checked_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 seconds')
        AND e.state='active' AND e.revision=p.environment_revision AND e.destination=p.destination AND r.policy_revision=repo.policy_revision AND repo.state='active'
      ) THEN 1 ELSE 0 END`, owner, promotion.id, owner),
      cleanup: stmt(db, 'DELETE FROM mutation_guards WHERE id=?', owner),
    };
    return await effect(lock);
  } finally {
    const releasing = await execute(db, `UPDATE workflow_promotion_barriers SET state='releasing',updated_at=? WHERE promotion_id=? AND repo_id=? AND owner_id=? AND state IN ('acquiring','held')`, now(), promotion.id, promotion.repo_id, owner);
    if (releasing.meta.changes === 1) {
      await barrier(env, promotion, 'DELETE');
      await execute(db, `UPDATE workflow_promotion_barriers SET state='released',updated_at=? WHERE promotion_id=? AND repo_id=? AND owner_id=? AND state='releasing'`, now(), promotion.id, promotion.repo_id, owner);
    }
  }
}

async function requireCurrentApprovals(env: Bindings, promotion: PromotionRecord, environment: EnvironmentRecord): Promise<AppContext[]> {
  const approvals = await many<{ approver_id: string; approver_credential_id: string | null }>(primary(env), `SELECT approver_id,approver_credential_id FROM environment_approvals WHERE promotion_id=? AND repo_id=? AND decision='approved'
    AND artifact_digest=? AND commit_sha=? AND plan_digest=? AND destination=? AND environment_revision=?`, promotion.id, promotion.repo_id, promotion.artifact_digest, promotion.commit_sha, promotion.plan_digest, promotion.destination, promotion.environment_revision);
  const allowed: string[] = JSON.parse(environment.allowed_approvers_json);
  const valid = new Map<string, AppContext>();
  for (const approval of approvals) {
    if (allowed.length && !allowed.includes(approval.approver_id) || !environment.allow_self_approval && approval.approver_id === promotion.requested_by) continue;
    const authority = await currentApproverAuthority(env, promotion.repo_id, approval.approver_id, approval.approver_credential_id);
    if (authority) valid.set(approval.approver_id, authority);
  }
  if (valid.size < environment.required_approvals) throw new ApiError(409, 'approval_invalidated', 'The required environment approvers are no longer authorized.');
  return [...valid.values()].slice(0, environment.required_approvals);
}

async function approvalWitnesses(env: Bindings, promotion: PromotionRecord, environment: EnvironmentRecord): Promise<D1PreparedStatement[]> {
  const authorities = await requireCurrentApprovals(env, promotion, environment);
  return (await Promise.all(authorities.map(context => mutationStatements(context, { statements: [], event: {
    type: 'execution.approval.rechecked', resource_id: promotion.id, resource_revision: promotion.revision, repo_id: promotion.repo_id, account_id: promotion.account_id,
    data: { run_id: promotion.run_id, artifact_digest: promotion.artifact_digest, plan_digest: promotion.plan_digest },
  } })))).flat();
}

export async function withEnvironmentSecrets<T>(env: Bindings, context: AttemptContext, effect: () => Promise<T>): Promise<T> {
  if (!context.job.environment) return effect();
  const promotion = await one<PromotionRecord>(primary(env), `SELECT * FROM workflow_promotions WHERE job_id=? AND repo_id=? AND run_id=? AND status='approved'`, context.attempt.job_id, context.attempt.repo_id, context.attempt.run_id);
  if (!promotion || promotion.plan_digest !== context.attempt.plan_digest) throw new ApiError(403, 'environment_approval_required', 'The attempt has no current exact-artifact approval.');
  return withAcceptedTarget(env, promotion, async () => {
    const environment = await assertPromotionCurrent(primary(env), promotion);
    const witnesses = await approvalWitnesses(env, promotion, environment);
    if (witnesses.length) await primary(env).batch(witnesses);
    return effect();
  });
}

export async function recoverPromotionBarriers(env: Bindings): Promise<void> {
  const db = primary(env);
  const cutoff = new Date(Date.now() - 120_000).toISOString();
  const records = await many<PromotionRecord>(db, `SELECT p.* FROM workflow_promotions p JOIN workflow_promotion_barriers b ON b.promotion_id=p.id AND b.repo_id=p.repo_id WHERE b.state!='released' AND b.updated_at<? ORDER BY b.updated_at LIMIT 16`, cutoff);
  for (const promotion of records) {
    const owner = newId('gate');
    const fenced = await execute(db, `UPDATE workflow_promotion_barriers SET state='releasing',owner_id=?,updated_at=? WHERE promotion_id=? AND repo_id=? AND state!='released' AND updated_at<?`, owner, now(), promotion.id, promotion.repo_id, cutoff);
    if (fenced.meta.changes !== 1) continue;
    await barrier(env, promotion, 'DELETE');
    await execute(db, `UPDATE workflow_promotion_barriers SET state='released',updated_at=? WHERE promotion_id=? AND repo_id=? AND owner_id=? AND state='releasing'`, now(), promotion.id, promotion.repo_id, owner);
  }
}
