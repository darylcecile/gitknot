import { ApiError, canonicalJson, identityBinding, mutationGuard, mutationStatements, newId, now, one, requestPolicies, selectIdentityDatabase, sha256, stmt } from '@gitknot/core';
import type { AppContext, RequestAuthorization, UserRecord } from '@gitknot/core';
import { readInboxForDelivery } from '../../../apps/api/src/modules/collaboration/personal.ts';
import { backgroundContext, principalById } from './authorization.ts';
import { isIdentityPlacement, requireLocalAuthority } from './ownership.ts';
import type { PreparedMail } from './mail-contract.ts';
import type { OperationsBindings } from './types.ts';
import { sourceEvent } from './durable.ts';
import { executionEventRequirements } from './execution-audience.ts';
import { inboxDeliveryUserStateGuards } from '../../../apps/api/src/modules/collaboration/personal-inbox.ts';
import type { InboxDeliveryUserState } from '../../../apps/api/src/modules/collaboration/personal-inbox.ts';

export interface MailSourceWitness {
  env: OperationsBindings; id: string; repo_id: string; item_id: string; title: string; reason: string; kind: string;
  inbox_revision: number; source_revision: number; item_revision: number; source_event_id: string; requirements: RequestAuthorization[];
  user_state: InboxDeliveryUserState;
}
export interface ActivityMailProof {
  user: Pick<UserRecord, 'id' | 'email' | 'revision' | 'auth_revision'>;
  preference_revision: number | null;
  requirements: RequestAuthorization[];
  sources: MailSourceWitness[];
}
interface SendLease { id: string; event_id: string | null; template: string; reference_id: string; generation: number; lease_token: string | null; lease_until: string | null; repo_id: string | null }

async function revalidateSources(env: OperationsBindings, userId: string, sources: MailSourceWitness[]): Promise<void> {
  const principal = await principalById(env, userId);
  if (!principal) throw new ApiError(403, 'mail_recipient_revoked', 'The mail recipient is no longer eligible.');
  for (const source of sources) {
    const repo = await requireLocalAuthority(source.env, source.repo_id);
    const current = await readInboxForDelivery(backgroundContext(source.env, principal, repo!), source.id);
    if (!current) throw new ApiError(403, 'mail_source_revoked', 'A mail source is no longer visible to its recipient.');
    const event = await sourceEvent(source.env.DB, source.source_event_id);
    if (!event || await executionEventRequirements(source.env, principal, event) === null) throw new ApiError(403, 'mail_source_revoked', 'The notification execution audience is no longer visible.');
    if (current.user_state.user_id !== source.user_state.user_id || current.user_state.context_account_id !== source.user_state.context_account_id
      || current.user_state.notification_id !== source.user_state.notification_id || current.user_state.repository_id !== source.user_state.repository_id
      || current.user_state.subject_id !== source.user_state.subject_id || current.source_revision !== source.source_revision
      || current.source_event_id !== source.source_event_id || current.revision !== source.inbox_revision || current.item.revision !== source.item_revision || current.item.title !== source.title
      || current.reason !== source.reason || current.item_id !== source.item_id) throw new ApiError(409, 'mail_source_changed', 'The notification changed before release.');
  }
}

async function releaseContexts(env: OperationsBindings, lease: SendLease, proof: ActivityMailProof, identity = false): Promise<AppContext[]> {
  const principal = await principalById(env, proof.user.id);
  if (!principal) throw new ApiError(403, 'mail_recipient_revoked', 'The mail recipient is no longer eligible.');
  const repository = await requireLocalAuthority(env, lease.template === 'inbox' ? lease.repo_id : null);
  const requirements = [...new Map([...proof.requirements, ...proof.sources.flatMap(source => source.requirements)]
    .map(requirement => [canonicalJson(requirement), requirement])).values()];
  const contexts: AppContext[] = [];
  for (let offset = 0; offset < Math.max(requirements.length, 1); offset += 16) {
    const context = backgroundContext(env, principal, identity ? undefined : repository ?? undefined);
    if (identity || !repository) selectIdentityDatabase(context);
    await requestPolicies(context, requirements.slice(offset, offset + 16));
    contexts.push(context);
  }
  return contexts;
}

/** Last async action before EMAIL.send: current policy, source versions, recipient and the exact send lease commit together. */
export async function authorizeActivityRelease(env: OperationsBindings, lease: SendLease, message: PreparedMail, proof: ActivityMailProof): Promise<void> {
  const emailHash = await sha256(message.to.toLowerCase());
  const payloadHash = await sha256(canonicalJson(message));
  const contexts = await releaseContexts(env, lease, proof);
  const colocated = isIdentityPlacement(env);
  const identityContexts = colocated ? contexts : await releaseContexts(env, lease, proof, true);
  await revalidateSources(env, proof.user.id, proof.sources);
  const identity = identityBinding(env).withSession('first-primary');
  const current = await one<UserRecord>(identity, 'SELECT * FROM users WHERE id=? AND disabled_at IS NULL AND email_verified_at IS NOT NULL', proof.user.id);
  const preferences = await one<{ revision: number }>(identity, 'SELECT revision FROM email_preferences WHERE user_id=?', proof.user.id);
  if (!current || current.email !== proof.user.email || current.revision !== proof.user.revision || current.auth_revision !== proof.user.auth_revision
    || (preferences?.revision ?? null) !== proof.preference_revision || await one(identity, 'SELECT 1 FROM mail_suppressions WHERE email_hash=?', emailHash)) {
    throw new ApiError(409, 'mail_recipient_changed', 'The mail recipient or preferences changed before release.');
  }
  const db = env.DB.withSession('first-primary');
  const guard = newId('mailguard');
  const witnesses = proof.sources.filter(source => source.env.CELL_ID === env.CELL_ID && source.env.SHARD_ID === env.SHARD_ID);
  const witnessSql = `EXISTS(SELECT 1 FROM collaboration_inbox i JOIN collaboration_items t ON t.id=i.item_id AND t.repo_id=i.repo_id
    WHERE i.id=? AND i.user_id=? AND i.revision=? AND i.state='outstanding' AND (i.snoozed_until IS NULL OR i.snoozed_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      AND t.id=? AND t.revision=? AND t.deleted_at IS NULL)`;
  let statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < witnesses.length; offset += 16) {
    const group = witnesses.slice(offset, offset + 16);
    const id = newId('mailguard');
    statements.push(stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN ${group.map(() => witnessSql).join(' AND ')} THEN 1 ELSE 0 END`,
      id, ...group.flatMap(source => [source.id, proof.user.id, source.source_revision, source.item_id, source.item_revision])),
    stmt(db, 'DELETE FROM mutation_guards WHERE id=?', id));
  }
  const predicates: string[] = [];
  const values: unknown[] = [];
  if (colocated) {
    predicates.push(`EXISTS(SELECT 1 FROM users WHERE id=? AND email=? AND revision=? AND auth_revision=? AND disabled_at IS NULL AND email_verified_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM mail_suppressions WHERE email_hash=?)
      AND (SELECT revision FROM email_preferences WHERE user_id=?) IS ?`);
    values.push(proof.user.id, proof.user.email, proof.user.revision, proof.user.auth_revision, emailHash, proof.user.id, proof.preference_revision);
  }
  if (colocated) for (const source of proof.sources) statements.push(...inboxDeliveryUserStateGuards(identity, source.user_state));
  statements.push(stmt(db, `UPDATE mail_deliveries SET ${colocated ? 'authorized_payload_sha256=?,authorized_at=?' : 'updated_at=updated_at'} WHERE id=? AND event_id IS ?
    AND reference_id=? AND generation=? AND state='sending' AND lease_token=? AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    ${predicates.length ? `AND ${predicates.join(' AND ')}` : ''}`, ...(colocated ? [payloadHash, now()] : []), lease.id, lease.event_id, lease.reference_id, lease.generation, lease.lease_token, ...values),
  mutationGuard(db, guard), stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard));
  for (const context of contexts) statements = await mutationStatements(context, { statements,
    event: { type: colocated ? 'mail.release_authorized' : 'mail.release_prepared', resource_id: lease.id, resource_revision: lease.generation + 1, repo_id: lease.repo_id,
      data: { recipient_hash: emailHash, payload_sha256: payloadHash } } });
  await db.batch(statements);
  if (!colocated) await authorizeIdentityRelease(identity, identityContexts, lease, proof, emailHash, payloadHash);
}

/** Repository witnesses/lease are prepared first; user intent is the final release decision at its sole authority. */
async function authorizeIdentityRelease(db: D1DatabaseSession, contexts: AppContext[], lease: SendLease, proof: ActivityMailProof,
  emailHash: string, payloadHash: string): Promise<void> {
  const guard = newId('mailguard');
  let statements = proof.sources.flatMap(source => inboxDeliveryUserStateGuards(db, source.user_state));
  statements.push(stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN
    EXISTS(SELECT 1 FROM users WHERE id=? AND email=? AND revision=? AND auth_revision=? AND disabled_at IS NULL AND email_verified_at IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM mail_suppressions WHERE email_hash=?) AND (SELECT revision FROM email_preferences WHERE user_id=?) IS ?
    AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    THEN 1 ELSE 0 END`, guard, proof.user.id, proof.user.email, proof.user.revision, proof.user.auth_revision, emailHash, proof.user.id, proof.preference_revision, lease.lease_until),
  stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard));
  const leaseHash = await sha256(`${lease.id}:${lease.lease_token}`);
  for (const context of contexts) statements = await mutationStatements(context, { statements,
    event: { type: 'mail.release_authorized', resource_id: lease.id, resource_revision: lease.generation + 1, repo_id: lease.repo_id,
      data: { recipient_hash: emailHash, payload_sha256: payloadHash, lease_sha256: leaseHash, event_id: lease.event_id } } });
  await db.batch(statements);
}
