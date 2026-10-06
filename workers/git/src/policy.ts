import { Context } from 'hono';
import { authorize, canonicalJson, credentialIsCurrent, database, explainAuthorization, getRepository, identityBinding, identityDatabase, many, now, one } from '@gitknot/core';
import type { AppContext, AppEnv, CredentialRecord, Principal, Repository } from '@gitknot/core';
import { gitRuleSchema, matchGitPattern, readGitLimits, rulesForRef } from '../../../packages/git/src/policy.ts';
import { digestJson } from '../../../packages/git/src/protocol.ts';
import type { GitCapabilitiesAttestation, GitEvidence, GitMaintenanceMove, GitOperation, GitPolicy, GitRule } from '../../../packages/git/src/types.ts';
import { ZERO_OID } from '../../../packages/git/src/types.ts';
import { GitError, requireValue } from '../../../packages/git/src/errors.ts';
import { copyLfsObjects, verifyLfsPointers } from '../../../packages/git/src/lfs.ts';
import type { GitBindings } from './types.ts';
import { verifyAdditionalMergeRules } from './verification.ts';
import { queuedPublication } from './merge-authorization.ts';
import { gitPlacement } from './placement.ts';
import { maintenanceRestoreAuthority } from './maintenance.ts';
import { moveRestoreAuthority } from './move-authority.ts';
import { placementStorageName } from '../../../packages/billing/src/placement-state.ts';

export function internalContext(env: GitBindings, actor: Principal | null): AppContext {
  const c = new Context<AppEnv>(new Request('https://internal.gitknot.com/internal/git/policy'), { env });
  c.set('principal', actor);
  c.set('requestId', crypto.randomUUID());
  c.set('database', env.DB.withSession('first-primary'));
  return c;
}

export async function currentActor(env: GitBindings, actor: Principal): Promise<Principal> {
  requireValue(actor && actor.credential_id, 'authentication_required', 'A current authenticated GitKnot credential is required.', 401);
  const db = identityBinding(env).withSession('first-primary');
  const credential = await one<CredentialRecord>(db, 'SELECT * FROM credentials WHERE id=? AND principal_id=?', actor.credential_id, actor.id);
  requireValue(credential && await credentialIsCurrent(db, credential), 'credential_revoked', 'The Git credential expired or was revoked.', 401);
  const principal = await one<Pick<Principal, 'id' | 'kind' | 'user_id'>>(db, 'SELECT id,kind,user_id FROM principals WHERE id=? AND disabled_at IS NULL', actor.id);
  requireValue(principal && principal.kind === actor.kind && principal.user_id === actor.user_id, 'principal_inactive', 'The authenticated Git identity is no longer active.', 401);
  // authorize() also reads the current credential chain, so retain the original operation's
  // ceilings here: both the saved and current credential scopes must permit the action.
  return { ...principal, credential_id: credential.id, capabilities: actor.capabilities,
    repository_ids: actor.repository_ids, account_ids: actor.account_ids, mfa: actor.mfa && credential.mfa === 1 };
}

export async function authorizePushDiscovery(c: AppContext, repoId: string, capability = 'contents.push'): Promise<void> {
  requireValue(c.get('principal'), 'authentication_required', 'Authenticate with a GitKnot token to push.', 401);
  const explanation = await explainAuthorization(c, capability, { repo_id: repoId });
  if (explanation.allowed) return;
  // Ref/path-scoped credentials cannot be fully evaluated until quarantine supplies all paths.
  // This only admits bounded validation; a complete authorize() is mandatory for each update.
  const incomplete = explanation.requirements.length > 0 && explanation.requirements.every(value => value === 'ref' || value === 'paths')
    && explanation.reasons.every(reason => ['no_matching_grant', 'credential_condition'].includes(reason.code)
      || reason.code === 'explicit_deny' && explanation.matched_grants.some(grant => grant.id === reason.source
        && grant.effect === 'deny' && (grant.conditions?.refs || grant.conditions?.paths)));
  if (!incomplete) await authorize(c, capability, { repo_id: repoId });
}

export async function loadPolicy(c: AppContext, repository: Repository): Promise<GitPolicy> {
  type RuleRow = { id: string; repo_id: string | null; target_json: string; config_json: string; revision: number };
  const [accountRules, repositoryRules] = await Promise.all([
    many<RuleRow>(identityDatabase(c), "SELECT id,repo_id,target_json,config_json,revision FROM repository_rules WHERE account_id=? AND repo_id IS NULL AND enforcement='active' ORDER BY id", repository.owner_id),
    many<RuleRow>(database(c), "SELECT id,repo_id,target_json,config_json,revision FROM repository_rules WHERE account_id=? AND repo_id=? AND enforcement='active' ORDER BY id", repository.owner_id, repository.id),
  ]);
  const rows = [...accountRules, ...repositoryRules].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const rules: GitRule[] = rows.map(row => {
    try { return gitRuleSchema.parse({ ...JSON.parse(row.config_json), id: row.id, target: JSON.parse(row.target_json) }); }
    catch { throw new GitError('git_policy_unavailable', 'Repository Git rules could not be evaluated.', 503); }
  });
  const storedKeys = await many<{ principal_id: string; kind: string; public_key: string; fingerprint: string }>(database(c),
    `SELECT principal_id,kind,public_key,fingerprint FROM git_signing_keys WHERE repo_id=? AND revoked_at IS NULL
     AND (expires_at IS NULL OR expires_at>?) ORDER BY id`, repository.id, now());
  const activeSigners = new Set<string>();
  for (const id of new Set(storedKeys.map(key => key.principal_id))) {
    if (await one(identityDatabase(c), 'SELECT 1 FROM principals WHERE id=? AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at>?)', id, now())) activeSigners.add(id);
  }
  const keys = storedKeys.filter(key => activeSigners.has(key.principal_id));
  const bypassRows = c.get('principal') ? await many<{ id: string; reason: string; created_at: string; rule_ids_json: string; refs_json: string; expires_at: string }>(database(c),
    'SELECT id,reason,created_at,rule_ids_json,refs_json,expires_at FROM rule_bypasses WHERE repo_id=? AND principal_id=? AND policy_revision=? AND revoked_at IS NULL AND expires_at>? ORDER BY id',
    repository.id, c.get('principal')!.id, repository.policy_revision, now()) : [];
  const bypasses = bypassRows.map(row => {
    const ids = JSON.parse(row.rule_ids_json) as string[];
    requireValue(row.reason.trim() && ids.length && ids.every(id => rows.some(rule => rule.id === id && rule.repo_id === repository.id))
      && ids.every(id => Date.parse(row.expires_at) - Date.parse(row.created_at) <= (rules.find(rule => rule.id === id)?.bypass?.maximum_duration_seconds ?? 1800) * 1000),
    'invalid_rule_bypass', 'A rule bypass has invalid scope or duration.', 503);
    return { id: row.id, reason: row.reason, rule_ids: ids, refs: JSON.parse(row.refs_json) as string[], expires_at: row.expires_at };
  });
  if (bypasses.length) await authorize(c, 'rules.break_glass', { repo_id: repository.id });
  const policy: GitPolicy = { revision: repository.policy_revision, rules, bypasses, limits: readGitLimits(c.env.LIMITS_JSON), signatures: {
    ssh_signers: keys.filter(key => key.kind === 'ssh').map(key => `${key.principal_id} ${key.public_key}`),
    openpgp_keys: keys.filter(key => key.kind === 'openpgp').map(key => key.public_key),
    openpgp_fingerprints: keys.filter(key => key.kind === 'openpgp').map(key => key.fingerprint),
  } };
  const account = await one<{ policy_revision: number }>(identityDatabase(c), 'SELECT policy_revision FROM accounts WHERE id=?', repository.owner_id);
  requireValue(account, 'policy_unavailable', 'Repository account policy is unavailable.', 503);
  policy.digest = await digestJson({ ...policy, account_policy_revision: account.policy_revision, rule_revisions: rows.map(row => [row.id, row.revision]) });
  return policy;
}

export async function requireWriteCapabilities(env: GitBindings, policy: GitPolicy): Promise<void> {
  if (env.ENVIRONMENT === 'development' && env.GIT_STORAGE_MODE === 'local') return;
  requireValue(/(?:^|@)sha256:[a-f0-9]{64}$/u.test(env.GIT_NATIVE_IMAGE), 'git_rollout_checks_required', 'Git writes require an immutable native image digest.', 503);
  const row = await one<{ attestation_json: string; expires_at: string }>(env.DB.withSession('first-primary'),
    'SELECT attestation_json,expires_at FROM git_storage_capabilities WHERE account_id=? AND namespace=? AND native_image=?', env.ARTIFACTS_ACCOUNT_ID, env.ARTIFACTS_NAMESPACE, env.GIT_NATIVE_IMAGE);
  requireValue(row && row.expires_at > now(), 'git_rollout_checks_required', 'Git writes are awaiting storage compatibility verification.', 503);
  const value = JSON.parse(row.attestation_json) as GitCapabilitiesAttestation;
  requireValue(value.version === 1 && value.authority === 'artifacts' && value.account_id === env.ARTIFACTS_ACCOUNT_ID
    && value.namespace === env.ARTIFACTS_NAMESPACE && value.native_image === env.GIT_NATIVE_IMAGE && value.expires_at > now()
    && value.atomic === true && value.conditional === true && value.failed_atomic_unchanged === true
    && value.stale_publisher_excluded === true && value.acceptance_recovery === true && value.max_pack_bytes >= policy.limits.max_pack_bytes
    && typeof value.evidence_key === 'string' && value.evidence_key.length > 0,
  'git_rollout_checks_required', 'Git writes are awaiting storage compatibility verification.', 503);
}

export async function publicationPolicy(c: AppContext, repository: Repository, maintenance?: GitMaintenanceMove): Promise<GitPolicy> {
  const policy = await loadPolicy(c, repository);
  if (!maintenance) return policy;
  // A maintenance move copies the exact retained source graph into a new store.
  // Push-only rules cannot require it to invent a user or rewrite old signatures.
  return { ...policy, rules: [], bypasses: undefined, signatures: { ssh_signers: [], openpgp_keys: [], openpgp_fingerprints: [] },
    digest: await digestJson({ mode: 'maintenance-move-restore-v1', repository_policy: policy.digest, maintenance }) };
}

export async function recheckPublication(env: GitBindings, operation: GitOperation, evidence?: GitEvidence): Promise<{ c: AppContext; repository: Repository; policy: GitPolicy }> {
  const placement = await gitPlacement(env, operation.repo_id, operation.kind === 'restore' ? operation.id : undefined);
  requireValue(placement.cell_id === env.CELL_ID && placement.shard_id === env.SHARD_ID && placement.epoch === operation.routing_epoch
    && (placement.state === 'active' || operation.kind === 'restore'), 'stale_routing_epoch', 'The Git repository placement changed or is fenced.', 409);
  requireValue(!operation.maintenance || operation.kind === 'restore' && operation.restore, 'maintenance_publication_scope', 'Maintenance authority is limited to its exact restore.', 403);
  const maintenance = operation.maintenance ? await maintenanceRestoreAuthority(env, operation.repo_id, operation.id,
    operation.restore!.archive_id, operation.maintenance) : undefined;
  if (maintenance) {
    requireValue(operation.actor.id === maintenance.actor.id && operation.actor.kind === 'service' && operation.actor.credential_id === null
      && operation.actor.user_id === null && canonicalJson(operation.restore) === canonicalJson(maintenance.maintenance.restore)
      && operation.repository.storage_name === (operation.move?.destination.storage_name ?? await placementStorageName(operation.repo_id, operation.id)),
    'maintenance_publication_scope', 'The restore changed its service attribution, manifest, or fresh store.', 409);
    if (evidence) requireValue(evidence.updates.length === operation.restore!.expected_refs.length && evidence.updates.every(update => update.old_oid === ZERO_OID
      && operation.restore!.expected_refs.some(ref => ref.ref === update.ref && ref.oid === update.new_oid)),
    'maintenance_publication_scope', 'The native update differs from the verified move archive.', 409);
  }
  const actor = maintenance?.actor ?? await currentActor(env, operation.actor);
  const c = internalContext(env, actor);
  const lifecycle = operation.kind === 'import' || operation.kind === 'fork' || operation.kind === 'restore';
  const repository = maintenance?.repository ?? (lifecycle ? await (await import('./lifecycle.ts')).lifecycleRepository(c, operation.repo_id, operation.id, operation.kind as 'import' | 'fork' | 'restore')
    : await getRepository(c, operation.repo_id));
  if (operation.move) {
    requireValue(operation.kind === 'restore' && operation.restore && operation.repository.storage_name === operation.move.destination.storage_name,
      'move_publication_scope', 'The native publisher changed its admitted move target.', 409);
    await moveRestoreAuthority(env, repository, operation.id, actor, operation.restore, operation.move);
    if (evidence) requireValue(evidence.updates.length === operation.restore.expected_refs.length && evidence.updates.every(update => update.old_oid === ZERO_OID
      && operation.restore!.expected_refs.some(ref => ref.ref === update.ref && ref.oid === update.new_oid)),
    'move_publication_scope', 'The native update differs from its frozen move archive.', 409);
  }
  requireValue(repository.routing_epoch === operation.routing_epoch && repository.policy_revision === operation.policy_revision,
    'stale_policy', 'Repository routing or policy changed during validation. Fetch and retry.', 409);
  const policy = await publicationPolicy(c, repository, maintenance?.maintenance);
  requireValue(!operation.policy_digest || operation.policy_digest === policy.digest, 'stale_policy', 'Repository Git rules changed during validation. Retry the operation.', 409);
  await requireWriteCapabilities(env, policy);
  if (operation.merge_queue) await queuedPublication(c, repository, operation.id, operation.kind, operation.candidate, operation.merge_queue);
  const capability = operation.kind === 'merge' || operation.kind === 'candidate' && operation.merge_queue
    ? 'pull_requests.merge' : ['candidate', 'retain'].includes(operation.kind) ? 'pull_requests.write' : 'contents.push';
  if (!evidence) { if (!lifecycle) await authorizePushDiscovery(c, repository.id, capability); }
  else for (const update of evidence.updates) {
    if (!lifecycle) await authorize(c, capability, { repo_id: repository.id, ref: update.policy_ref, paths: update.pathless ? undefined : update.paths });
    const sourceRepo = operation.kind === 'fork' ? repository.fork_source_id : operation.candidate?.source_repo_id ?? operation.source_repo_id;
    if (sourceRepo && sourceRepo !== repository.id && update.lfs_objects.length) {
      await getRepository(c, sourceRepo);
      if (operation.kind === 'candidate' || operation.kind === 'retain') await verifyLfsPointers(c.env.DB, sourceRepo, update.lfs_objects);
      else { await copyLfsObjects(env, actor, sourceRepo, repository.id, update.lfs_objects); await verifyLfsPointers(c.env.DB, repository.id, update.lfs_objects); }
    } else await verifyLfsPointers(c.env.DB, repository.id, update.lfs_objects);
    const rules = rulesForRef(policy.rules, update.policy_ref).filter(rule => !policy.bypasses?.some(bypass =>
      rule.id && bypass.rule_ids.includes(rule.id) && bypass.refs.some(pattern => matchGitPattern(pattern, update.policy_ref))));
    for (const rule of rules) {
      checkPublicationRule(rule, operation);
      if (rule.push) requireValue(rule.push.allowed_principals.includes(actor.id), 'push_principal_denied', 'Repository policy restricts pushes on this ref to other principals.');
    }
  }
  if (operation.candidate) {
    await getRepository(c, operation.candidate.source_repo_id);
    if (operation.kind === 'merge') await checkMergeCandidate(c, operation, evidence!);
  }
  if (operation.source_repo_id) await getRepository(c, operation.source_repo_id);
  if (operation.review) {
    const review = await one<{ source_repo_id: string; base_oid: string; head_oid: string; state: string }>(c.env.DB,
      'SELECT * FROM git_review_snapshots WHERE repo_id=? AND id=? AND operation_id=?', repository.id, operation.review.id, operation.id);
    requireValue(review?.state === 'building' && review.source_repo_id === operation.review.source_repo_id
      && review.base_oid === operation.review.base_oid && review.head_oid === operation.review.head_oid,
    'review_scope_changed', 'The retained review operation changed during validation.', 409);
  }
  if (operation.restack) {
    const row = await one<{ repo_id: string; head_oid: string; head_ref: string; merge_base_oid: string }>(c.env.DB, `SELECT p.repo_id,p.head_oid,p.head_ref,v.merge_base_oid
      FROM pull_requests p JOIN collaboration_items i ON i.id=p.id AND i.repo_id=p.repo_id
      JOIN pull_patches v ON v.id=p.current_patch_id AND v.repo_id=p.repo_id
      WHERE p.id=? AND p.head_repo_id=? AND i.state IN ('open','draft') AND i.deleted_at IS NULL`, operation.restack.pull_request_id, repository.id);
    requireValue(row && row.head_oid === operation.restack.expected_oid && row.head_ref === operation.restack.ref
      && row.merge_base_oid === operation.restack.old_base_oid, 'restack_patch_changed', 'The pull request patch changed during restack validation.', 409);
    await getRepository(c, row.repo_id);
  }
  return { c, repository, policy };
}

function checkPublicationRule(rule: GitRule, operation: GitOperation): void {
  requireValue(rule.updates !== 'blocked', 'ref_blocked', 'Repository policy blocks this ref update.');
  if (['candidate', 'restore', 'retain'].includes(operation.kind)) return;
  const requiresPull = rule.updates === 'pull_request_only' || (rule.reviews?.minimum ?? 0) > 0
    || !!rule.reviews?.required_owners || !!rule.reviews?.required_reviewers?.length || rule.reviews?.resolved_threads
    || !!rule.verification?.required.length || !!rule.verification?.expression;
  requireValue(!requiresPull || operation.kind === 'merge' && operation.candidate?.pull_request_id, 'pull_request_required', 'Repository policy requires an eligible, verified pull request.');
  if (rule.merge_strategies && operation.candidate) requireValue(rule.merge_strategies.includes(operation.candidate.strategy), 'merge_strategy_denied', 'This merge strategy is not permitted by repository policy.');
}

async function checkMergeCandidate(c: AppContext, operation: GitOperation, evidence: GitEvidence): Promise<void> {
  const candidate = operation.candidate!;
  const row = await one<{ source_repo_id: string; source_oid: string; target_ref: string; target_oid: string; candidate_oid: string; policy_revision: number; state: string }>(c.env.DB,
    'SELECT * FROM git_candidates WHERE repo_id=? AND id=?', operation.repo_id, candidate.id);
  requireValue(row && row.state === 'ready' && row.source_repo_id === candidate.source_repo_id && row.source_oid === candidate.source_oid
    && row.target_ref === candidate.target_ref && row.target_oid === candidate.target_oid && row.policy_revision === operation.policy_revision
    && evidence.updates.length === 1 && evidence.updates[0].new_oid === row.candidate_oid && evidence.updates[0].old_oid === row.target_oid,
  'candidate_obsolete', 'The merge candidate is no longer current. Rebuild and verify it.', 409);
  if (!candidate.pull_request_id) return;
  // The collaboration module owns review validity and trusted workflow-result interpretation.
  const { getMergeEligibility } = await import('../../../apps/api/src/modules/collaboration/merge.ts');
  const result = await getMergeEligibility(c, candidate.pull_request_id, {
    repo_id: operation.repo_id, candidate_id: candidate.id, strategy: candidate.strategy as 'merge' | 'squash' | 'rebase',
  });
  requireValue(result.eligible && result.candidate_oid === row.candidate_oid && result.target_oid === row.target_oid
    && result.head_oid === candidate.source_oid && result.policy_revision === operation.policy_revision,
  'merge_not_eligible', 'Pull request requirements are not currently satisfied.', 409);
  const repo = await getRepository(c, operation.repo_id);
  const rules = rulesForRef((await loadPolicy(c, repo)).rules, candidate.target_ref);
  await verifyAdditionalMergeRules(c, repo.id, candidate.pull_request_id, row.candidate_oid, operation.policy_revision,
    evidence.updates.flatMap(update => update.paths), rules, result.reviews);
}
