import { ApiError, captureMutationAuthority, database, getRepository, identityBinding, now, one, prepareDerivedCredential, requestPolicies } from '@gitknot/core';
import type { AppContext } from '@gitknot/core';
import type { CredentialRecord } from '@gitknot/core';
import { primary } from './store.ts';
import type { ExecutionObject, ExecutionPlan, JobRecord, RunRecord } from './types.ts';
import { commitIdentityCredential } from './credentials.ts';
import { authorizeRunRead, executionAudience } from './reads.ts';

export async function reproduceRun(c: AppContext, run: RunRecord, jobKey?: string): Promise<Record<string, unknown>> {
  await captureMutationAuthority(c);
  const plan = await authorizeRunRead(c, run), db = database(c), identities = identityBinding(c.env).withSession('first-primary'), actor = c.get('principal');
  const job = jobKey ? plan.jobs.find(value => value.key === jobKey) : undefined;
  if (jobKey && !job) throw new ApiError(404, 'job_not_found', 'The requested job was not found in this plan.');
  const sourceId = plan.source_repo_id ?? run.repo_id;
  const audience = executionAudience(plan);
  await requestPolicies(c, audience.map(id => ({ capability: 'contents.read', scope: { repo_id: id } })));
  const sourceRepo = await getRepository(c, sourceId), owner = await one<{ slug: string }>(identities, 'SELECT slug FROM accounts WHERE id=?', sourceRepo.owner_id);
  if (!owner) throw new ApiError(404, 'not_found', 'The repository source is unavailable.');
  let token: string | undefined;
  if (actor) {
    const user = actor.user_id ? await one<{ auth_revision: number }>(identities, 'SELECT auth_revision FROM users WHERE id=? AND disabled_at IS NULL', actor.user_id) : null;
    if (actor.user_id && !user) throw new ApiError(403, 'reproduction_actor_revoked', 'The requesting user is no longer active.');
    const source = actor.credential_id ? await one<CredentialRecord>(identities, 'SELECT * FROM credentials WHERE id=? AND principal_id=?', actor.credential_id, actor.id) : null;
    const credential = await prepareDerivedCredential(identities, actor, { principal_id: actor.id, user_id: actor.user_id, kind: 'job', name: `reproduce ${run.id}`, capabilities: ['contents.read'],
      repository_ids: audience, account_ids: actor.account_ids, parent_id: actor.credential_id, auth_revision: user?.auth_revision ?? null, mfa: actor.mfa,
      authenticated_at: source?.authenticated_at, expires_at: new Date(Math.min(Date.now() + 300_000, source ? Date.parse(source.expires_at) : Infinity)).toISOString(), created_by: actor.id });
    await commitIdentityCredential(c.env, c, credential.statements, { type: 'workflow.reproduction.authorized', resource_id: run.id, resource_revision: run.revision, repo_id: run.repo_id, account_id: run.account_id,
      actor_id: actor.id, data: { credential_id: credential.credential.id } });
    token = credential.token;
  }
  const path = plan.checkout_candidate_id ? `repositories/${run.repo_id}/candidates/${plan.checkout_candidate_id}.git` : `${owner.slug}/${sourceRepo.slug}.git`;
  const inputs: Record<string, unknown>[] = [], completed: string[] = [];
  for (const name of job?.needs ?? []) {
    const dependency = await one<JobRecord>(db, 'SELECT * FROM workflow_jobs WHERE run_id=? AND repo_id=? AND job_key=?', run.id, run.repo_id, name);
    if (dependency && ['succeeded', 'not_applicable'].includes(dependency.status)) completed.push(name);
  }
  for (const input of job?.inputs ?? []) {
    const dependency = await one<JobRecord>(db, `SELECT * FROM workflow_jobs WHERE run_id=? AND repo_id=? AND job_key=? AND status='succeeded'`, run.id, run.repo_id, input.job);
    const object = dependency && await one<ExecutionObject>(db, `SELECT * FROM execution_objects WHERE attempt_id=? AND repo_id=? AND kind='manifest' AND name=? AND state='sealed' AND expires_at>?`,
      dependency.current_attempt_id ?? dependency.reused_attempt_id, run.repo_id, `output:${input.output}`, now());
    if (!object) throw new ApiError(410, 'reproduction_input_expired', 'A required reproduction input is no longer retained.');
    const stored = await c.env.BLOBS.get(object.object_key);
    if (!stored) throw new ApiError(410, 'reproduction_input_expired', 'A required reproduction manifest is unavailable.');
    const manifest = await stored.json<{ size_bytes: number }>();
    const type = plan.jobs.find(value => value.key === input.job)!.outputs[input.output]!.type ?? 'artifact';
    inputs.push({ job_id: input.job, name: input.output, type, digest: `sha256:${object.source_digest}`, size_bytes: manifest.size_bytes,
      download_path: `/v1/runs/${run.id}/reproduction-inputs/${object.id}` });
  }
  return { run_id: run.id, plan_digest: run.plan_digest, manifest: plan.portable_manifest,
    source: { url: new URL(path, `${c.env.GIT_ORIGIN}/`).href, commit: run.commit_sha, ...(token ? { token } : {}) },
    inputs, completed_dependencies: completed, variables: job?.variables ?? {},
    required_secrets: [...new Set((job ? [job] : plan.jobs).flatMap(value => value.steps.flatMap(step => step.secrets.map(secret => secret.name))))],
    secrets_available: false };
}
