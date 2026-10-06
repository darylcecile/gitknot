import { auditStatement, authorize, canonicalJson, eventStatement, identityBinding, many, mutationGuard, newId, now, one, sha256, stmt, verifyInternalRequest } from '@gitknot/core';
import type { Principal, Repository } from '@gitknot/core';
import { PublicationJournal } from '../../../packages/git/src/journal.ts';
import type { JournalStorage } from '../../../packages/git/src/journal.ts';
import { boundedJson, digestJson } from '../../../packages/git/src/protocol.ts';
import { GIT_COORDINATOR_SCOPE } from '../../../packages/git/src/types.ts';
import type { CandidateContext, GitEvidence, GitMovePublisherRequest, GitMovePublisherState, GitOperation, GitOperationKind, GitRepositoryContext, GitRestoreContext, GitRestackContext, GitReviewContext, PublicationPermit, PublicationResult } from '../../../packages/git/src/types.ts';
import { GitError, gitErrorResponse, requireValue } from '../../../packages/git/src/errors.ts';
import { currentActor, internalContext, publicationPolicy, recheckPublication, requireWriteCapabilities, authorizePushDiscovery } from './policy.ts';
import { getRepository } from '@gitknot/core';
import { artifacts } from './storage.ts';
import { createNativeSession, nativeAction, nativeJson } from './native.ts';
import type { GitBindings } from './types.ts';
import { finishRestoreScratch, lifecycleRepository } from './lifecycle.ts';
import { gitCosts } from '../../../packages/git/src/cost.ts';
import { journalStorage } from './journal-storage.ts';
import { publicGitOperation } from '../../../packages/git/src/views.ts';
import { readGitLimits, validateUpdates } from '../../../packages/git/src/policy.ts';
import { reviewRefs } from '../../../packages/git/src/protocol.ts';
import { queuedPublication } from './merge-authorization.ts';
import { gitPlacement, gitShardEnvironment } from './placement.ts';
import { maintenanceRestoreAuthority, requireMovePublisherSettled } from './maintenance.ts';
import { moveRestoreAuthority } from './move-authority.ts';
import { movePublisherPlacement } from './move-publication.ts';
import { moveControl } from '../../../packages/operations/src/move-control.ts';
import { placementStorageName } from '../../../packages/billing/src/placement-state.ts';

interface OpenPublication {
  repo_id: string; operation_id: string; actor?: Principal; kind: GitOperationKind;
  publisher_id: string; fence: string; request_digest?: string; candidate?: CandidateContext;
  storage_name?: string; restore?: GitRestoreContext; barrier_token?: string;
  source_repo_id?: string; restack?: GitRestackContext;
  review?: GitReviewContext;
}

export class RepositoryCoordinator {
  private readonly journal: PublicationJournal;

  constructor(private readonly ctx: DurableObjectState, private readonly env: GitBindings) {
    this.journal = new PublicationJournal(journalStorage(ctx.storage));
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await verifyInternalRequest(request, this.env.INTERNAL_SERVICE_KEY, GIT_COORDINATOR_SCOPE, { database: this.env.DB.withSession('first-primary') });
      const url = new URL(request.url);
      const repoId = url.searchParams.get('repo_id');
      requireValue(repoId, 'repository_required', 'The repository coordinator requires a repository identity.', 400);
      await this.bindRepository(repoId);
      if (url.pathname === '/barrier' || url.pathname === '/barrier/check') return await this.barrier(request, url.pathname.endsWith('/check'));
      if (url.pathname === '/move-publication') {
        requireValue(request.method === 'POST', 'invalid_method', 'Move publisher queries require POST.', 405);
        const input = await boundedJson<GitMovePublisherRequest>(request);
        const placement = await movePublisherPlacement(this.env, repoId, input);
        requireValue(placement.cell_id === this.env.CELL_ID, 'routing_changed', 'The original publisher belongs to another cell.', 409);
        return Response.json(await new RepositoryCoordinator(this.ctx, gitShardEnvironment(this.env, placement.shard_id)).movePublication(repoId, input));
      }
      const begin = url.pathname === '/begin' && request.method === 'POST' ? await boundedJson<OpenPublication>(request.clone()) : undefined;
      const operationId = /^\/operations\/([\w-]+)/u.exec(url.pathname)?.[1];
      let saved: GitOperation | null = null;
      if (operationId) {
        try { saved = await this.journal.get(operationId); }
        catch (error) { if (!(error instanceof GitError) || error.code !== 'operation_not_found') throw error; }
      } else if (url.pathname === '/reconcile') saved = await this.journal.active();
      const placement = saved?.placement ?? await gitPlacement(this.env, repoId, begin?.kind === 'restore' ? begin.operation_id : operationId);
      requireValue(placement.cell_id === this.env.CELL_ID, 'routing_changed', 'Use the repository coordinator in the current Git cell.', 409);
      const handler = new RepositoryCoordinator(this.ctx, gitShardEnvironment(this.env, placement.shard_id));
      return await handler.dispatch(request, repoId);
    } catch (error) { return gitErrorResponse(error); }
  }

  private async dispatch(request: Request, repoId: string): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/begin' && request.method === 'POST') return Response.json(await this.begin(await boundedJson<OpenPublication>(request)));
    if (url.pathname === '/reconcile' && request.method === 'POST') { await this.reconcile(); return Response.json({ operation: await this.journal.active() }); }
    const match = /^\/operations\/([\w-]+)(?:\/(validated|permit|result|rejected))?$/u.exec(url.pathname);
    requireValue(match, 'not_found', 'Repository coordinator endpoint not found.', 404);
    if (!match[2] && request.method === 'GET') return Response.json(await this.readOperation(repoId, match[1]));
    const operation = await this.journal.get(match[1]);
    requireValue(operation.repo_id === repoId, 'operation_not_found', 'Git operation not found.', 404);
    const body = await boundedJson<Record<string, unknown>>(request);
    requireValue(request.method === 'POST' && body.publisher_id === operation.publisher_id
      && typeof body.fence === 'string' && await sha256(body.fence) === operation.fence_hash,
    'stale_publisher', 'This native publisher does not own the operation.', 403);
    if (match[2] === 'validated') return Response.json(await this.validated(operation, body.evidence as GitEvidence));
    if (match[2] === 'permit') return Response.json(await this.permit(operation, String(body.evidence_digest)));
    if (match[2] === 'result') return Response.json(await this.result(operation, body.result as PublicationResult));
    requireValue(match[2] === 'rejected', 'not_found', 'Unknown publication transition.', 404);
    const code = typeof body.code === 'string' && /^[a-z_]{1,64}$/u.test(body.code) ? body.code : 'receive_rejected';
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 1000) : 'Native receive or validation was rejected before publication.';
    const rejected = await this.journal.rejectBeforePublication(operation.id, code, reason);
    await this.finalize(rejected);
    return Response.json(publicGitOperation(await this.journal.get(operation.id)));
  }

  async alarm(): Promise<void> {
    try {
      const operation = await this.journal.active();
      if (operation) {
        requireValue(!operation.placement || operation.placement.cell_id === this.env.CELL_ID, 'publication_placement', 'The publisher journal belongs to another cell.', 503);
        await new RepositoryCoordinator(this.ctx, gitShardEnvironment(this.env, operation.placement?.shard_id ?? this.env.SHARD_ID)).reconcile();
      }
    }
    finally { if (await this.journal.active()) await this.ctx.storage.setAlarm(Date.now() + 60_000); }
  }

  private async readOperation(repoId: string, id: string): Promise<ReturnType<typeof publicGitOperation>> {
    try {
      const operation = await this.journal.get(id);
      requireValue(operation.repo_id === repoId, 'operation_not_found', 'Git operation not found.', 404);
      return publicGitOperation(operation);
    } catch (error) { if (!(error instanceof GitError) || error.code !== 'operation_not_found') throw error; }
    const row = await one<{ id: string; repo_id: string; actor_id: string; kind: GitOperationKind; state: GitOperation['state'];
      policy_revision: number; routing_epoch: number; result_json: string; error_json: string; finalized: number; created_at: string; updated_at: string }>(this.env.DB,
    'SELECT * FROM git_publications WHERE repo_id=? AND id=?', repoId, id);
    requireValue(row, 'operation_not_found', 'Git operation not found.', 404);
    requireValue(row.finalized === 1 && ['committed', 'rejected'].includes(row.state), 'publication_journal_unavailable', 'This publication still requires its original durable coordinator.', 503);
    return { id: row.id, operation_id: row.id, repo_id: row.repo_id, actor_id: row.actor_id, kind: row.kind, state: row.state,
      policy_revision: row.policy_revision, routing_epoch: row.routing_epoch, result: JSON.parse(row.result_json), error: JSON.parse(row.error_json),
      finalized: true, created_at: row.created_at, updated_at: row.updated_at };
  }

  private async bindRepository(repoId: string): Promise<void> {
    await this.ctx.storage.transaction(async tx => {
      const bound = await tx.get<string>('repo_id');
      requireValue(!bound || bound === repoId, 'repository_mismatch', 'Repository coordinator identity mismatch.', 409);
      if (!bound) await tx.put('repo_id', repoId);
    });
  }

  private async begin(input: OpenPublication): Promise<unknown> {
    requireValue(input.repo_id === await this.ctx.storage.get('repo_id'), 'repository_mismatch', 'Repository coordinator identity mismatch.', 409);
    const maintenance = input.kind === 'restore' && input.actor === undefined && input.restore
      ? await maintenanceRestoreAuthority(this.env, input.repo_id, input.operation_id, input.restore.archive_id) : undefined;
    if (maintenance) requireValue(canonicalJson(input.restore) === canonicalJson(maintenance.maintenance.restore),
      'maintenance_publication_scope', 'The admitted restore differs from its verified source archive.', 409);
    const actor = maintenance?.actor ?? await currentActor(this.env, input.actor!);
    const c = internalContext(this.env, actor);
    const lifecycle = input.kind === 'import' || input.kind === 'fork' || input.kind === 'restore';
    const repository = maintenance?.repository ?? (lifecycle ? await lifecycleRepository(c, input.repo_id, input.operation_id, input.kind as 'import' | 'fork' | 'restore') : await getRepository(c, input.repo_id));
    requireValue(repository.cell_id === this.env.CELL_ID && repository.shard_id === this.env.SHARD_ID, 'routing_changed', 'Repository routing changed. Retry through its current GitKnot endpoint.', 409);
    const policy = await publicationPolicy(c, repository, maintenance?.maintenance);
    await requireWriteCapabilities(this.env, policy);
    const queued = await queuedPublication(c, repository, input.operation_id, input.kind, input.candidate);
    if (queued) await authorize(c, 'pull_requests.merge', { repo_id: repository.id, ref: input.candidate!.target_ref, paths: queued.paths });
    else if (!lifecycle) await authorizePushDiscovery(c, repository.id, input.kind === 'merge' ? 'pull_requests.merge' : ['candidate','retain'].includes(input.kind) ? 'pull_requests.write' : 'contents.push');
    if (input.kind === 'restore') requireValue(input.restore, 'restore_target', 'A verified canonical restore manifest is required.', 403);
    const move = input.kind === 'restore' ? await moveRestoreAuthority(this.env, repository, input.operation_id, actor, input.restore!) : undefined;
    if (input.kind === 'restore') requireValue(input.storage_name === (move?.destination.storage_name ?? await placementStorageName(repository.id, input.operation_id)),
      'restore_target', 'Invalid canonical restore target.', 403);
    const snapshot: GitRepositoryContext = {
      id: repository.id, owner_id: repository.owner_id, storage_name: input.kind === 'restore' ? input.storage_name! : repository.storage_name,
      default_branch: repository.default_branch, policy_revision: repository.policy_revision, routing_epoch: repository.routing_epoch,
    };
    const operation: GitOperation = {
      id: input.operation_id, repo_id: repository.id, repository: snapshot, actor, kind: input.kind,
      state: 'receiving', routing_epoch: repository.routing_epoch, policy_revision: repository.policy_revision,
      policy_digest: policy.digest, publisher_id: input.publisher_id, request_digest: input.request_digest,
      fence_hash: await sha256(input.fence), created_at: now(), updated_at: now(),
      deadline_at: new Date(Date.now() + policy.limits.max_work_ms + 30_000).toISOString(), finalized: false,
      ...(input.candidate ? { candidate: input.candidate } : {}),
      bypasses: policy.bypasses?.map(({ id, reason }) => ({ id, reason })),
      ...(input.restore ? { restore: input.restore } : {}),
      ...(input.source_repo_id ? { source_repo_id: input.source_repo_id } : {}), ...(input.restack ? { restack: input.restack } : {}),
      ...(input.review ? { review: input.review } : {}),
      ...(queued ? { merge_queue: queued.proof } : {}),
      placement: { cell_id: this.env.CELL_ID, shard_id: this.env.SHARD_ID },
      ...(maintenance ? { maintenance: maintenance.maintenance } : {}),
      ...(move ? { move } : {}),
    };
    const opened = await this.journal.open(operation, input.barrier_token ? await sha256(input.barrier_token) : undefined);
    await this.mirror(opened);
    await this.ctx.storage.setAlarm(Date.now() + policy.limits.max_work_ms + 30_000);
    return { operation: publicGitOperation(opened), repository: snapshot, policy };
  }

  private async validated(operation: GitOperation, evidence: GitEvidence): Promise<unknown> {
    requireValue(evidence?.version === 1 && evidence.policy_revision === operation.policy_revision
      && evidence.policy_digest === operation.policy_digest && /^[a-f0-9]{40}$/u.test(evidence.marker_oid),
    'validation_mismatch', 'Native validation does not match the admitted policy.', 409);
    const { digest, marker_oid: ignored, marker_object_bytes: markerBytes, ...body } = evidence;
    void ignored; void markerBytes;
    requireValue(await digestJson(body) === digest, 'validation_digest', 'Native validation evidence digest does not match.', 409);
    validateUpdates(evidence.updates, readGitLimits(this.env.LIMITS_JSON).max_refs, ['candidate', 'retain', 'restore'].includes(operation.kind));
    for (const update of evidence.updates) requireValue(update.policy_ref === (operation.kind === 'candidate' ? operation.candidate?.target_ref : update.ref),
      'validation_scope', 'Native validation changed a ref authorization scope.', 409);
    if (operation.kind === 'candidate') requireValue(evidence.updates.length === 1 && evidence.updates[0].ref === `refs/gitknot/candidates/${operation.candidate?.id}`,
      'validation_scope', 'Native validation changed the candidate ref.', 409);
    if (operation.review) {
      const refs = reviewRefs(operation.review.id);
      requireValue(evidence.review?.native_evidence_id === operation.review.id && evidence.review.repo_id === operation.repo_id
        && evidence.review.head_repo_id === operation.review.source_repo_id && evidence.review.base_oid === operation.review.base_oid
        && evidence.review.head_oid === operation.review.head_oid && evidence.updates.length === refs.length
        && evidence.updates.every(update => refs.includes(update.ref)), 'validation_scope', 'Retained review evidence changed its resource association.', 409);
    }
    await recheckPublication(this.env, operation, evidence);
    const saved = await this.journal.validated(operation.id, operation.publisher_id, evidence);
    await this.mirror(saved);
    return { validated: true };
  }

  private async permit(operation: GitOperation, digest: string): Promise<PublicationPermit> {
    requireValue(operation.evidence?.digest === digest, 'validation_mismatch', 'Publication evidence changed.', 409);
    await recheckPublication(this.env, operation, operation.evidence);
    const storage = operation.evidence.storage;
    requireValue(storage?.model === 'logical-reachable-v1', 'storage_evidence_required', 'Canonical publication requires verified native storage evidence.', 503);
    await this.mirror(await this.journal.storageAdmission(operation.id, { requested: true, settled: false }));
    const reservation = await gitCosts.reserveStorage(this.env, {
      account_id: operation.repository.owner_id, repo_id: operation.repo_id, actor_id: operation.actor.id,
      operation_id: operation.id, storage_name: operation.repository.storage_name, routing_epoch: operation.routing_epoch,
      maximum_growth_bytes: storage.maximum_growth_bytes, retention_until: null,
    });
    await this.mirror(await this.journal.storageAdmission(operation.id, { requested: true, reservation_id: reservation.reservation_id, fence: reservation.fence, settled: false }));
    // Admission can take time. Recheck current grants/rules before returning a write capability.
    await recheckPublication(this.env, operation, operation.evidence);
    // Persist the fence BEFORE minting or returning any canonical write credential.
    const publishing = await this.journal.publishing(operation.id, operation.publisher_id, digest);
    await this.mirror(publishing);
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
    const remote = await artifacts(this.env).access(operation.repository.storage_name, 'write', 300);
    return { operation_id: operation.id, publisher_id: operation.publisher_id, evidence_digest: digest,
      marker_oid: operation.evidence.marker_oid, remote };
  }

  private async result(operation: GitOperation, result: PublicationResult): Promise<unknown> {
    requireValue(result && result.operation_id === operation.id && ['committed', 'rejected', 'uncertain'].includes(result.outcome), 'publication_result', 'Invalid native publication result.', 409);
    const refs = operation.evidence?.updates.map(({ ref, old_oid, new_oid }) => ({ ref, old_oid, new_oid }));
    requireValue(refs && JSON.stringify(refs) === JSON.stringify(result.refs), 'publication_result', 'Native publication result changed its exact ref manifest.', 409);
    if (result.outcome === 'rejected') requireValue(result.proof === 'report_status' || result.proof === 'not_started', 'publication_uncertain', 'A rejection requires a definitive native outcome.', 409);
    if (result.outcome === 'committed') requireValue(result.proof === 'marker' || result.proof === 'report_status', 'publication_uncertain', 'Publication success requires canonical evidence.', 409);
    const saved = await this.journal.result(operation.id, result);
    await this.mirror(saved);
    if (saved.state === 'committed' || saved.state === 'rejected') await this.finalize(saved);
    return publicGitOperation(await this.journal.get(operation.id));
  }

  private async reconcile(): Promise<void> {
    const operation = await this.journal.active();
    if (!operation) return;
    await this.reconcileOperation(operation);
  }

  private async reconcileOperation(operation: GitOperation): Promise<void> {
    if (operation.state === 'committed' || operation.state === 'rejected') { await this.finalize(operation); return; }
    if (operation.state === 'receiving' || operation.state === 'validated') {
      if (operation.deadline_at > now()) return;
      await this.finalize(await this.journal.rejectBeforePublication(operation.id, 'receive_timeout', 'The receiver timed out before a canonical publication permit was issued.'));
      return;
    }
    requireValue(operation.evidence, 'publication_evidence_missing', 'A publishing operation has no durable evidence.', 503);
    const policy = { revision: operation.policy_revision, rules: [], signatures: { ssh_signers: [], openpgp_keys: [], openpgp_fingerprints: [] },
      limits: (await import('../../../packages/git/src/policy.ts')).readGitLimits(this.env.LIMITS_JSON) };
    const remote = await artifacts(this.env).access(operation.repository.storage_name, 'read');
    const native = await createNativeSession(this.env, { repository: operation.repository, remote, policy, mode: 'inspect' });
    const result = await nativeJson<PublicationResult>(await nativeAction(native, 'inspect', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation_id: operation.id, evidence: operation.evidence }) }));
    await this.result(operation, result);
    // An absent marker NEVER causes a publishing fence to expire.
  }

  private async movePublication(repoId: string, input: GitMovePublisherRequest): Promise<GitMovePublisherState> {
    const control = await moveControl(this.env, input.operation_id);
    const storageName = control[`${input.side}_storage_name`];
    let reconciled: string | undefined;
    if (input.action === 'settle') {
      if (input.side === 'source') {
        await requireMovePublisherSettled(this.env, repoId, input.operation_id);
        await this.journal.checkBarrier(input.operation_id, await sha256(`move_${input.operation_id}`));
      }
      const active = await this.journal.retireStorage(storageName, input.operation_id);
      requireValue(!active || input.side === 'source' || active.id === input.operation_id,
        'move_publication_scope', 'The physical destination has another active native publisher.', 503);
      if (active) { await this.reconcileOperation(active); reconciled = active.id; }
    }
    const active = await this.journal.active();
    let operation: GitOperation | null = null;
    if (input.side === 'target') {
      try { operation = await this.journal.get(input.operation_id); }
      catch (error) { if (!(error instanceof GitError) || error.code !== 'operation_not_found') throw error; }
      requireValue(!operation || operation.repo_id === repoId && operation.kind === 'restore' && operation.repository.storage_name === storageName
        && operation.routing_epoch === control.target_epoch, 'move_publication_scope', 'The original journal names a different restore target.', 503);
      requireValue(operation || !active || active.repository.storage_name !== storageName,
        'publication_journal_unavailable', 'The destination still has an unresolved native publisher.', 503);
      if (operation && input.action === 'settle' && !operation.finalized && reconciled !== operation.id) {
        await this.reconcileOperation(operation);
        operation = await this.journal.get(operation.id);
      }
    } else {
      if (active?.repository.storage_name === storageName) operation = active;
    }
    let closed = await this.journal.storageRetired(storageName, input.operation_id);
    if (!operation && !closed && input.side === 'target' && ['cleaning', 'active', 'completed'].includes(control.state)) {
      const row = await one<{ target_verified_json: string | null }>(identityBinding(this.env),
        'SELECT target_verified_json FROM billing_placement_git WHERE operation_id=?', input.operation_id);
      const proof = row?.target_verified_json ? JSON.parse(row.target_verified_json) as { verified: boolean; objects_verified: boolean; refs: unknown[] } : null;
      if (proof?.verified && proof.objects_verified && Array.isArray(proof.refs) && proof.refs.length === 0) closed = await this.journal.closeUnstarted(input.operation_id);
    }
    const terminal = operation ? operation.finalized && ['committed', 'rejected'].includes(operation.state) : closed;
    return { operation_id: input.operation_id, repo_id: repoId, storage_name: storageName, cell_id: this.env.CELL_ID, shard_id: this.env.SHARD_ID,
      state: operation?.state ?? 'not_started', terminal, finalized: operation?.finalized ?? closed, closed };
  }

  private async barrier(request: Request, check = false): Promise<Response> {
    const body = await boundedJson<{ token: string; operation_id: string; owner?: string; reason?: string; issued_at?: number; restore_operation_id?: string }>(request);
    requireValue(typeof body.token === 'string' && body.token.length >= 32, 'invalid_barrier', 'A scoped repository barrier token is required.', 400);
    requireValue(typeof body.operation_id === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/u.test(body.operation_id), 'invalid_barrier', 'The exact maintenance operation identity is required.', 400);
    requireValue(body.owner === undefined || body.owner === body.operation_id, 'invalid_barrier', 'Maintenance ownership does not match its operation identity.', 403);
    const hash = await sha256(body.token);
    if (check) {
      requireValue(request.method === 'POST', 'invalid_method', 'Checking maintenance ownership requires POST.', 405);
      return Response.json(await this.journal.checkBarrier(body.operation_id, hash, body.restore_operation_id));
    }
    if (request.method === 'DELETE') {
      await requireMovePublisherSettled(this.env, String(await this.ctx.storage.get('repo_id')), body.operation_id);
      return Response.json(await this.journal.releaseBarrier(body.operation_id, hash));
    }
    else {
      requireValue(request.method === 'POST', 'invalid_method', 'Unsupported repository barrier method.', 405);
      const issued = body.issued_at ?? Number(request.headers.get('x-gitknot-internal-time')) * 1000;
      requireValue(Number.isSafeInteger(issued) && issued <= Date.now() + 60_000, 'invalid_barrier', 'Invalid maintenance request issuance time.', 400);
      const result = await this.journal.barrier({ operation_id: body.operation_id, token_hash: hash, reason: (body.reason ?? 'maintenance').slice(0, 200),
        created_at: now(), acquire_before: new Date(issued + 120_000).toISOString() });
      return Response.json(result, { status: result.held ? 200 : 409 });
    }
  }

  private async mirror(operation: GitOperation): Promise<void> {
    await stmt(this.env.DB, `INSERT INTO git_publications
      (repo_id,id,actor_id,actor_json,kind,state,routing_epoch,policy_revision,publisher_id,request_digest,source_repo_id,context_json,evidence_json,result_json,error_json,finalized,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repo_id,id) DO UPDATE SET state=excluded.state,
      evidence_json=excluded.evidence_json,result_json=excluded.result_json,error_json=excluded.error_json,
      context_json=excluded.context_json,source_repo_id=excluded.source_repo_id,
      finalized=MAX(git_publications.finalized,excluded.finalized),updated_at=excluded.updated_at,revision=git_publications.revision+1`,
    operation.repo_id, operation.id, operation.actor.id, JSON.stringify(operation.actor), operation.kind, operation.state,
    operation.routing_epoch, operation.policy_revision, operation.publisher_id, operation.request_digest ?? null, operation.source_repo_id ?? null,
    JSON.stringify({ repository: operation.repository, placement: operation.placement, candidate: operation.candidate, review: operation.review, restack: operation.restack, restore: operation.restore,
      merge_queue: operation.merge_queue, maintenance: operation.maintenance, move: operation.move, storage_admission: operation.storage_admission }), JSON.stringify(operation.evidence ?? null),
    JSON.stringify(operation.result ?? null), JSON.stringify(operation.error ?? null), operation.finalized ? 1 : 0, operation.created_at, operation.updated_at).run();
  }

  private async finalize(operation: GitOperation): Promise<void> {
    operation = await this.journal.get(operation.id);
    await this.mirror(operation);
    if (operation.storage_admission?.requested && !operation.storage_admission.settled) {
      const reservation = operation.storage_admission;
      const identity = { account_id: operation.repository.owner_id, repo_id: operation.repo_id, operation_id: operation.id,
        reservation_id: reservation.reservation_id, fence: reservation.fence };
      if (operation.state === 'committed') {
        requireValue(operation.evidence?.storage && reservation.reservation_id && reservation.fence && operation.result?.marker_oid,
          'storage_settlement_pending', 'Canonical storage settlement requires its durable admission and marker evidence.', 503);
        const usage = operation.evidence.storage;
        await gitCosts.commitStorage(this.env, { ...identity, reservation_id: reservation.reservation_id, fence: reservation.fence,
          reachable_bytes: usage.reachable_bytes, new_object_bytes: (BigInt(usage.new_object_bytes) + BigInt(operation.evidence.marker_object_bytes ?? '0')).toString(),
          object_count: usage.object_count, evidence_digest: operation.evidence.digest, marker_oid: operation.result.marker_oid, verified_at: now() });
      } else if (operation.state === 'rejected') {
        await gitCosts.abortStorage(this.env, { ...identity, rejection_evidence_id: `git-publication:${operation.id}:${operation.publisher_id}:rejected` });
      } else requireValue(false, 'publication_uncertain', 'Uncertain canonical storage cannot release its financial hold.', 409);
      operation = await this.journal.storageAdmission(operation.id, { ...reservation, settled: true });
    }
    await this.mirror(operation);
    if (operation.kind === 'restore') await finishRestoreScratch(this.env, operation);
    for (let attempt = 0; attempt < 3; attempt++) {
      const db = this.env.DB.withSession('first-primary');
      const row = await one<{ finalized: number }>(db, 'SELECT finalized FROM git_publications WHERE repo_id=? AND id=?', operation.repo_id, operation.id);
      if (row?.finalized === 1) { await this.journal.finalized(operation.id); return; }
      const repo = await one<Repository>(db, 'SELECT * FROM repositories WHERE id=?', operation.repo_id);
      requireValue(repo, 'repository_missing', 'Publication metadata is unavailable.', 503);
      const internalRetention = operation.kind === 'candidate' || operation.kind === 'retain' || !!operation.maintenance || !!operation.move;
      const changesRepository = operation.state === 'committed' && !internalRetention;
      const revision = repo.revision + (changesRepository ? 1 : 0);
      const guard = newId('guard');
      const statements = [
        stmt(db, 'UPDATE git_publications SET finalized=1,revision=revision+1,updated_at=? WHERE repo_id=? AND id=? AND finalized=0', now(), repo.id, operation.id),
        mutationGuard(db, guard),
      ];
      if (changesRepository) {
        statements.push(stmt(db, 'UPDATE repositories SET revision=revision+1,updated_at=? WHERE id=? AND revision=?', now(), repo.id, repo.revision), mutationGuard(db, `${guard}_repo`));
      }
      if (operation.candidate && (operation.kind === 'candidate' || operation.state === 'committed')) {
        const state = operation.kind === 'candidate' ? operation.state === 'committed' ? 'ready' : 'failed' : 'published';
        statements.push(stmt(db, 'UPDATE git_candidates SET state=?,candidate_oid=COALESCE(?,candidate_oid),revision=revision+1,updated_at=? WHERE repo_id=? AND id=?',
          state, operation.kind === 'candidate' ? operation.result?.refs[0]?.new_oid ?? null : null, now(), repo.id, operation.candidate.id));
      }
      if (operation.review) {
        statements.push(stmt(db, 'UPDATE git_review_snapshots SET state=?,merge_base_oid=?,inspection_json=?,updated_at=? WHERE repo_id=? AND id=? AND operation_id=?',
          operation.state === 'committed' ? 'ready' : 'failed', operation.evidence?.review?.merge_base_oid ?? null,
          operation.state === 'committed' ? JSON.stringify(operation.evidence?.review) : null, now(), repo.id, operation.review.id, operation.id));
      }
      const data = { operation_id: operation.id, kind: operation.kind, refs: operation.result?.refs ?? [], candidate_id: operation.candidate?.id ?? null, bypasses: operation.bypasses ?? [] };
      statements.push(eventStatement(db, { id: `evt_git_${operation.id}`, type: internalRetention ? `internal.git.retention.${operation.state}`
        : operation.state === 'committed' ? operation.kind === 'restore' ? 'git.storage.restored' : 'git.refs.updated' : 'git.publication.rejected',
        actor_id: internalRetention ? null : operation.actor.id, resource_id: internalRetention ? operation.id : repo.id, resource_revision: internalRetention ? 1 : revision,
        repo_id: internalRetention ? null : repo.id, account_id: internalRetention ? null : operation.repository.owner_id,
        data: internalRetention ? { operation_id: operation.id, kind: operation.kind } : data }),
      auditStatement(db, { id: `audit_git_${operation.id}`, action: `git.publication.${operation.state}`, actor_id: operation.actor.id,
        credential_id: operation.actor.credential_id, repo_id: repo.id, account_id: operation.repository.owner_id, resource_id: operation.id, resource_revision: 1, details: data }),
      stmt(db, 'DELETE FROM mutation_guards WHERE id IN (?,?)', guard, `${guard}_repo`));
      try {
        await db.batch(statements);
        await this.journal.finalized(operation.id);
        return;
      } catch (error) {
        if (attempt === 2 || !/CHECK constraint|mutation_requires_one_row|UNIQUE constraint/iu.test(String(error))) throw error;
      }
    }
  }
}

export { publicGitOperation } from '../../../packages/git/src/views.ts';
