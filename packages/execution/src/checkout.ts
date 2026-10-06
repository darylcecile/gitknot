import { ApiError, authorize, captureMutationAuthority, getRepository, hmac, identityBinding, now, one, separateIdentityAuthority, sha256, stmt } from '@gitknot/core';
import type { Bindings, CredentialRecord } from '@gitknot/core';
import { federationCredentialStatements } from '@gitknot/federation/integration';
import { attemptContext, guardedBatch, primary } from './store.ts';
import type { AttemptContext } from './types.ts';
import { currentExecutionActor, repositoryExecutionContext } from './authorization.ts';
import { commitIdentityCredential, revokeExecutionCredentials } from './credentials.ts';

export interface CheckoutCapability { url: string; commit: string; token: string; credential_id: string; expires_at: string }

/** A child of the initiating GitKnot identity, never an Artifacts/provider token. */
export async function checkoutCapability(env: Bindings, context: AttemptContext): Promise<CheckoutCapability> {
  const db = primary(env);
  const identities = identityBinding(env).withSession('first-primary');
  const a = context.attempt;
  const source = await currentExecutionActor(env, context.plan.actor);
  const authority = await repositoryExecutionContext(env, source, context.run.repo_id);
  await captureMutationAuthority(authority);
  for (const repoId of context.plan.related_repo_ids ?? [context.plan.source_repo_id ?? a.repo_id]) await authorize(authority, 'contents.read', { repo_id: repoId });
  if (!['leased', 'running'].includes(a.status) || !a.lease_expires_at || a.lease_expires_at <= now()) throw new ApiError(409, 'attempt_fenced', 'The attempt cannot receive source access.');
  const sourceRepoId = context.plan.source_repo_id ?? a.repo_id;
  const repository = await getRepository(authority, sourceRepoId), owner = await one<{ slug: string }>(identities, 'SELECT slug FROM accounts WHERE id=? AND disabled_at IS NULL', repository.owner_id);
  if (repository.state !== 'active' || !owner) throw new ApiError(404, 'not_found', 'The repository is not available for checkout.');
  const parent = context.plan.actor.credential_id;
  const identity = await one<{ id: string }>(identities, 'SELECT id FROM principals WHERE id=? AND disabled_at IS NULL', context.plan.actor.id);
  if (!identity) throw new ApiError(403, 'source_access_revoked', 'The initiating identity no longer has source access.');
  const user = context.plan.actor.user_id ? await one<{ auth_revision: number }>(identities, 'SELECT auth_revision FROM users WHERE id=? AND disabled_at IS NULL', context.plan.actor.user_id) : null;
  if (context.plan.actor.user_id && !user) throw new ApiError(403, 'source_access_revoked', 'The initiating user is no longer active.');
  const id = `cred_checkout_${a.id}_${a.generation}`;
  const sourceCredential = source.credential_id ? await one<CredentialRecord>(identities, 'SELECT * FROM credentials WHERE id=? AND principal_id=?', source.credential_id, source.id) : null;
  const expires = new Date(Math.min(Date.parse(a.deadline_at!), Date.now() + 5 * 60_000, sourceCredential ? Date.parse(sourceCredential.expires_at) : Infinity)).toISOString();
  const token = `gkt_${await hmac(env.INTERNAL_SERVICE_KEY, ['GitKnot checkout v1', a.id, a.generation, a.plan_digest].join('\n'))}`;
  const hash = await sha256(token);
  const at = now();
  const existing = await one<CredentialRecord>(identities, 'SELECT * FROM credentials WHERE id=?', id);
  if (existing && (existing.token_hash !== hash || existing.parent_id !== parent || existing.principal_id !== source.id || existing.user_id !== source.user_id)) throw new ApiError(409, 'checkout_identity_changed', 'The original checkout credential must be recovered without changing its identity.');
  const target: CredentialRecord = { id, principal_id: source.id, user_id: source.user_id, kind: 'job', name: `checkout ${a.id}`, token_hash: hash, token_prefix: token.slice(0, 12),
    capabilities_json: JSON.stringify(['contents.read']), repository_ids_json: JSON.stringify(context.plan.related_repo_ids ?? [sourceRepoId]), account_ids_json: source.account_ids === null ? null : JSON.stringify(source.account_ids),
    ref_patterns_json: null, path_patterns_json: null, parent_id: parent, rotation_of_id: null, auth_revision: user?.auth_revision ?? null,
    mfa: source.mfa ? 1 : 0, authenticated_at: sourceCredential?.authenticated_at ?? at, expires_at: expires, revoked_at: null, last_used_at: null, revision: 1, created_by: source.id, created_at: at };
  const issuance = existing ? [] : [stmt(identities, `INSERT INTO credentials (id,principal_id,user_id,kind,name,token_hash,token_prefix,capabilities_json,repository_ids_json,account_ids_json,parent_id,auth_revision,mfa,authenticated_at,expires_at,created_by,created_at)
    VALUES (?,?,?,'job',?,?,?,?,?,?,?,?,?,?,?,?,?)`, target.id, target.principal_id, target.user_id, target.name, target.token_hash, target.token_prefix, target.capabilities_json,
  target.repository_ids_json, target.account_ids_json, target.parent_id, target.auth_revision, target.mfa, target.authenticated_at, target.expires_at, target.created_by, target.created_at),
    ...await federationCredentialStatements(identities, source, target)];
  const separate = separateIdentityAuthority(authority);
  if (separate && issuance.length) await commitIdentityCredential(env, authority, issuance, { type: 'execution.checkout.prepared', resource_id: a.id, resource_revision: a.revision,
    repo_id: a.repo_id, account_id: a.account_id, actor_id: source.id, data: { credential_id: id, generation: a.generation } });
  try { await guardedBatch(db, stmt(db, `UPDATE execution_attempts SET checkout_credential_id=? WHERE id=? AND repo_id=? AND generation=?
    AND status IN ('leased','running') AND lease_expires_at>? AND deadline_at>?
    AND EXISTS (SELECT 1 FROM workflow_jobs j WHERE j.id=execution_attempts.job_id AND j.current_attempt_id=execution_attempts.id AND j.generation=execution_attempts.generation)
    AND EXISTS (SELECT 1 FROM workflow_runs r WHERE r.id=execution_attempts.run_id AND r.status NOT IN ('cancelling','cancelled'))`,
  id, a.id, a.repo_id, a.generation, at, at), separate ? [] : issuance, { context: authority,
    event: { type: existing ? 'workflow.checkout.reused' : 'workflow.checkout.issued', resource_id: a.id, resource_revision: a.revision, repo_id: a.repo_id, account_id: a.account_id,
      actor_id: source.id, data: { run_id: a.run_id, credential_id: id, generation: a.generation } } }); }
  catch (error) { if (separate && !existing) await revokeExecutionCredentials(env, [id], 'Unpublished checkout capability.'); throw error; }
  const stored = await one<{ expires_at: string; revoked_at: string | null }>(identities, 'SELECT expires_at,revoked_at FROM credentials WHERE id=? AND token_hash=?', id, hash);
  if (!stored || stored.revoked_at || stored.expires_at <= now()) throw new ApiError(409, 'checkout_expired', 'Source access for this attempt has already expired or been consumed.');
  const path = context.plan.checkout_candidate_id ? `repositories/${a.repo_id}/candidates/${context.plan.checkout_candidate_id}.git`
    : `${encodeURIComponent(owner.slug)}/${encodeURIComponent(repository.slug)}.git`;
  const url = new URL(path, `${env.GIT_ORIGIN}/`).href;
  return { url, commit: context.run.commit_sha, token, credential_id: id, expires_at: stored.expires_at };
}

export async function revokeCheckout(env: Bindings, attemptId: string): Promise<void> {
  const { attempt } = await attemptContext(primary(env), attemptId);
  await revokeExecutionCredentials(env, [`cred_checkout_${attempt.id}_${attempt.generation}`], 'The checkout capability is closed.');
}

export function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export function exactCheckoutScript(source: Pick<CheckoutCapability, 'url' | 'commit'>): string {
  const remote = new URL(source.url);
  if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(source.commit)) throw new ApiError(422, 'invalid_checkout', 'Checkout requires a pinned GitKnot HTTPS source.');
  return [
    'set -eu',
    'umask 077',
    'mkdir -p /tmp/gitknot-control',
    'chmod 700 /tmp/gitknot-control',
    'rm -rf -- /workspace',
    'mkdir -p /workspace',
    "printf '#!/bin/sh\\ncase \"$1\" in *Username*) printf gitknot;; *) printf \"%%s\" \"$GITKNOT_SOURCE_TOKEN\";; esac\\n' > /tmp/gitknot-control/askpass",
    'chmod 700 /tmp/gitknot-control/askpass',
    "trap 'rm -f /tmp/gitknot-control/askpass' EXIT",
    'export HOME=/tmp/gitknot-control GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/tmp/gitknot-control/askpass',
    'unset GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_DIR GIT_WORK_TREE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'git -c init.templateDir= init /workspace >/dev/null',
    `git -C /workspace -c core.hooksPath=/dev/null -c credential.helper= -c protocol.file.allow=never -c protocol.ext.allow=never -c http.followRedirects=false fetch --no-tags --no-recurse-submodules --depth=1 ${shellQuote(source.url)} ${shellQuote(source.commit)}`,
    `git -C /workspace -c core.hooksPath=/dev/null checkout --detach --force ${shellQuote(source.commit)}`,
    `test "$(git -C /workspace rev-parse HEAD)" = ${shellQuote(source.commit)}`,
    'git -C /workspace clean -ffdx',
    'git -C /workspace config --local core.hooksPath /dev/null',
    'git -C /workspace config --local credential.helper ""',
    'git -C /workspace ls-files -z > /tmp/gitknot-control/tracked-source',
    'rm -f /tmp/gitknot-control/askpass',
    'unset GITKNOT_SOURCE_TOKEN GIT_ASKPASS',
    'chown -R 10000:10000 /workspace',
  ].join('\n');
}
