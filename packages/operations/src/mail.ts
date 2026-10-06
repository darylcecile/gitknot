import { execute, hmac, identityBinding, many, newId, now, one, registerResourceLocator, sha256, stmt } from '@gitknot/core';
import type { EventRecord, UserRecord } from '@gitknot/core';
import { readInboxForDelivery } from '../../../apps/api/src/modules/collaboration/personal.ts';
import { allowed, backgroundContext, principalById } from './authorization.ts';
import { completion, consumeOnce, sourceEvent } from './durable.ts';
import { executionEventRequirements } from './execution-audience.ts';
import { privateJSON, recordDiagnostic } from './private.ts';
import { retryAt } from './security.ts';
import type { OperationsBindings } from './types.ts';
import { IDENTITY_MAIL_PATH, IDENTITY_MAIL_SCOPE, identityMailEvents } from './mail-contract.ts';
import type { IdentityMailPreparation, PreparedMail } from './mail-contract.ts';
import { deliveryTarget, EVENT_RPC_SCOPE, routeDelivery, targetEnvironment, verifyEffectTarget } from './event-routing.ts';
import { backgroundCell, cellShards } from './placement.ts';
import { isIdentityPlacement, localRepository, placementGuard, requireLocalAuthority } from './ownership.ts';
import { mailRecipient, materializeMailRecipients } from './mail-plan.ts';
import type { MailRecipient } from './mail-plan.ts';
import { authorizeActivityRelease } from './mail-release.ts';
import type { ActivityMailProof, MailSourceWitness } from './mail-release.ts';

const activityProofs = new WeakMap<PreparedMail, ActivityMailProof>();

interface MailDelivery {
  id: string;
  event_id: string | null;
  user_id: string | null;
  account_id: string | null;
  repo_id: string | null;
  template: string;
  reference_id: string;
  attempt_count: number;
  generation: number;
  lease_token: string | null;
  lease_until: string | null;
  created_at: string;
}

function mailDomain(env: OperationsBindings): string { return env.ENVIRONMENT === 'production' ? 'mail.gitknot.com' : 'mail.staging.gitknot.com'; }

export async function scheduleMail(env: OperationsBindings, event: EventRecord): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const identity = identityBinding(env).withSession('first-primary');
  const repository = event.repo_id && !/^(?:identity|invitation|runner)\./.test(event.type) ? await requireLocalAuthority(env, event.repo_id) : null;
  const recipients: MailRecipient[] = [];
  const purpose = identityMailEvents[event.type];
  if (purpose) {
    const reference = typeof event.data.action_id === 'string' ? event.data.action_id : event.resource_id;
    const action = await one<{ user_id: string | null }>(identity, 'SELECT user_id FROM identity_actions WHERE id=? AND purpose=?', reference, purpose);
    if (action) recipients.push(await mailRecipient(event, purpose, reference, action.user_id));
  }
  if (event.type === 'invitation.created' || event.type === 'invitation.resent') {
    recipients.push(await mailRecipient(event, 'invitation', event.resource_id, null, event.resource_revision));
  }
  if (event.type === 'runner.enrolled' || event.type === 'runner.enrollment_created') {
    const userId = typeof event.data.user_id === 'string' ? event.data.user_id : event.actor_id;
    if (userId) recipients.push(await mailRecipient(event, 'runner_enrolled', event.resource_id, userId));
  }
  if (['identity.mfa_enrollment_started', 'identity.mfa_enabled', 'identity.mfa_factor_removed', 'identity.passkey_registered', 'identity.password_changed', 'identity.password_reset'].includes(event.type)) {
    const userId = event.account_id ?? event.actor_id;
    if (userId) recipients.push(await mailRecipient(event, 'security_notice', event.id, userId));
  }
  await materializeMailRecipients(env, event, recipients, repository);
}

async function currentInbox(env: OperationsBindings, userId: string, id?: string, digest = false): Promise<MailSourceWitness[]> {
  const principal = await principalById(env, userId);
  if (!principal) return [];
  const visible = [];
  const seen = new Set<string>();
  for (const shard of digest ? cellShards(env) : [env]) {
    const rows = await many<{ id: string; repo_id: string; revision: number }>(shard.DB.withSession('first-primary'), `SELECT id,repo_id,revision FROM collaboration_inbox WHERE user_id=? AND (? IS NULL OR id=?)
      AND state='outstanding' AND (snoozed_until IS NULL OR snoozed_until<=?) ORDER BY updated_at DESC,id LIMIT 50`, userId, id ?? null, id ?? null, now());
    for (const row of rows) {
      const repository = await localRepository(shard, row.repo_id);
      if (seen.has(row.id) || !repository) continue;
      const context = backgroundContext(shard, principal, repository);
      context.req.raw = new Request(context.req.raw, { method: 'POST' });
      const current = await readInboxForDelivery(context, row.id);
      seen.add(row.id);
      const event = current ? await sourceEvent(shard.DB, current.source_event_id) : null;
      if (!event) continue;
      const execution = await executionEventRequirements(shard, principal, event);
      if (execution === null) continue;
      if (current && (digest ? current.digest !== 'off' : current.digest === 'off')) visible.push({ id: row.id, repo_id: current.repo_id,
        item_id: current.item_id, title: current.item.title, reason: current.reason, kind: current.item.kind,
        inbox_revision: current.revision, source_revision: current.source_revision, user_state: structuredClone(current.user_state),
        item_revision: current.item.revision, source_event_id: current.source_event_id, env: shard,
        requirements: [...(context.get('mutation_authority')?.policies ?? []).map(policy => ({ capability: policy.capability, scope: policy.scope })), ...execution] });
      if (visible.length === 50) return visible;
    }
  }
  return visible;
}

async function activityHeaders(env: OperationsBindings, userId: string): Promise<Record<string, string>> {
  const row = await one<{ revision: number; unsubscribe_token_hash: string }>(identityBinding(env).withSession('first-primary'),
    'SELECT revision,unsubscribe_token_hash FROM email_preferences WHERE user_id=?', userId);
  if (!row) return {};
  const token = await hmac(env.INTERNAL_SERVICE_KEY, `email-unsubscribe:${userId}`);
  if (await sha256(token) !== row.unsubscribe_token_hash) throw new Error('unsubscribe_key_unavailable');
  const link = new URL('/v1/email/unsubscribe', env.API_ORIGIN);
  link.searchParams.set('user_id', userId); link.searchParams.set('token', token);
  return { 'List-Unsubscribe': `<${link.href}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', 'List-Id': `GitKnot notifications <notifications.${mailDomain(env)}>` };
}

async function renderActivity(env: OperationsBindings, delivery: MailDelivery): Promise<PreparedMail | null> {
  if (!delivery.user_id) return null;
  // Header/key work precedes every plaintext source read and its final release proof.
  const headers = ['inbox', 'digest'].includes(delivery.template) ? await activityHeaders(env, delivery.user_id) : undefined;
  const db = identityBinding(env).withSession('first-primary');
  const user = await one<UserRecord>(db, 'SELECT * FROM users WHERE id=? AND disabled_at IS NULL AND email_verified_at IS NOT NULL', delivery.user_id);
  if (!user) return null;
  const preference = await one<{ transactional: number; digest: string; revision: number }>(db, 'SELECT transactional,digest,revision FROM email_preferences WHERE user_id=?', user.id);
  if (delivery.template === 'digest' ? preference?.digest === 'off' : preference?.transactional === 0) return null;
  if (delivery.template === 'runner_enrolled') {
    const principal = await principalById(env, user.id);
    if (!principal || !delivery.account_id || !await allowed(env, principal, 'runners.manage', { account_id: delivery.account_id })) return null;
    const message: PreparedMail = { to: user.email, security: true, subject: 'GitKnot runner enrolled', text: `A runner was enrolled for your account. Review current runners and revoke any you do not recognize.\n\n${new URL('/settings/runners', env.APP_ORIGIN).href}` };
    activityProofs.set(message, { user, preference_revision: preference?.revision ?? null, sources: [],
      requirements: [{ capability: 'runners.manage', scope: { account_id: delivery.account_id } }] });
    return message;
  }
  if (delivery.template === 'security_notice') {
    const message: PreparedMail = { to: user.email, security: true, subject: 'GitKnot account security update',
      text: `Your GitKnot account security settings changed. Review the current settings and active credentials.\n\n${new URL('/settings/security', env.APP_ORIGIN).href}` };
    activityProofs.set(message, { user, preference_revision: preference?.revision ?? null, sources: [], requirements: [] });
    return message;
  }
  const inbox = await currentInbox(env, user.id, delivery.template === 'inbox' ? delivery.reference_id : undefined, delivery.template === 'digest');
  if (!inbox.length) return null;
  const surfaces: Record<string, string> = { issue: 'issues', pull_request: 'pulls', discussion: 'discussions', task: 'tasks' };
  const lines = inbox.map((item) => `${item.reason.replaceAll('_', ' ')}: ${item.title.replace(/[\r\n]/g, ' ').slice(0, 300)}\n${new URL(`/repos/${encodeURIComponent(item.repo_id)}/${surfaces[item.kind]}/${encodeURIComponent(item.item_id)}`, env.APP_ORIGIN).href}`);
  const message: PreparedMail = { to: user.email, subject: delivery.template === 'digest' ? 'Your GitKnot decisions digest' : 'You have a GitKnot notification',
    text: `${lines.join('\n\n')}\n\nThese are current outstanding decisions. Review the latest state in GitKnot.`, headers };
  activityProofs.set(message, { user, preference_revision: preference?.revision ?? null, sources: inbox, requirements: [] });
  return message;
}

export async function renderMail(env: OperationsBindings, delivery: MailDelivery): Promise<PreparedMail | null> {
  if (['verify_email', 'recover_password', 'change_email', 'invitation'].includes(delivery.template)) {
    if (!env.API || !delivery.lease_token) throw new Error('identity_mail_service_unavailable');
    const prepared = await privateJSON<IdentityMailPreparation>(env, env.API, IDENTITY_MAIL_SCOPE, IDENTITY_MAIL_PATH,
      { delivery_id: delivery.id, lease_token: delivery.lease_token, shard_id: env.SHARD_ID });
    if (prepared.delivery_id !== delivery.id) throw new Error('identity_mail_delivery_mismatch');
    return prepared.message;
  }
  return renderActivity(env, delivery);
}

export async function deliverMail(env: OperationsBindings, id: string): Promise<void> {
  const target = await routeDelivery(env, id, 'mail');
  if (!target) return;
  env = target;
  const db = env.DB.withSession('first-primary');
  const hint = await one<MailDelivery>(db, 'SELECT * FROM mail_deliveries WHERE id=?', id);
  if (!hint) throw new Error('delivery_source_missing');
  const repository = await requireLocalAuthority(env, hint.template === 'inbox' ? hint.repo_id : null);
  const token = newId('mailattempt');
  const changes = await db.batch([...placementGuard(db, repository), stmt(db, `UPDATE mail_deliveries SET state='sending',lease_token=?,lease_until=?,attempt_count=attempt_count+1,
    authorized_payload_sha256=NULL,authorized_at=NULL,updated_at=?
    WHERE id=? AND state IN ('pending','sending') AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?)`,
  token, new Date(Date.now() + 120_000).toISOString(), now(), id, now(), now())]);
  const claim = changes.at(-1)!;
  if (claim.meta.changes !== 1) return;
  const delivery = (await one<MailDelivery>(db, 'SELECT * FROM mail_deliveries WHERE id=? AND lease_token=?', id, token))!;
  try {
    const message = await renderMail(env, delivery);
    if (!message || await one(identityBinding(env), 'SELECT 1 FROM mail_suppressions WHERE email_hash=?', await sha256(message.to.toLowerCase()))) {
      await execute(db, `UPDATE mail_deliveries SET state='cancelled',error_code='recipient_ineligible',lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?`, now(), id, token);
      return;
    }
    if (!env.EMAIL?.send) throw new Error('email_binding_unavailable');
    await requireLocalAuthority(env, delivery.template === 'inbox' ? delivery.repo_id : null);
    const proof = activityProofs.get(message);
    if (proof) await authorizeActivityRelease(env, delivery, message, proof);
    else if (!await one(db, "SELECT 1 FROM mail_deliveries WHERE id=? AND state='sending' AND lease_token=? AND lease_until>?", id, token, now())) throw new Error('mail_lease_changed');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sent: { messageId: string };
    try {
      sent = await Promise.race([
        env.EMAIL.send({ from: { email: `${message.security ? 'security' : 'notifications'}@${mailDomain(env)}`, name: 'GitKnot' },
          to: message.to, subject: message.subject, text: message.text,
          headers: { ...message.headers, 'Auto-Submitted': 'auto-generated', 'X-GitKnot-Delivery': delivery.id } }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('email_acceptance_uncertain')), 30_000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
    if (!sent.messageId) throw new Error('email_acceptance_missing');
    await execute(db, `UPDATE mail_deliveries SET state='accepted',provider_message_id=?,error_code=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?`, sent.messageId, now(), id, token);
  } catch (error) {
    await recordDiagnostic(env, 'mail', id, error);
    const revoked = error instanceof Error && 'status' in error && [401, 403, 404].includes(Number(error.status));
    const next = revoked ? null : retryAt(delivery.attempt_count, delivery.created_at);
    await execute(db, `UPDATE mail_deliveries SET state=?,next_attempt_at=?,error_code='email_unavailable',lease_token=NULL,lease_until=NULL,enqueued_at=NULL,updated_at=? WHERE id=? AND lease_token=?`,
      revoked ? 'cancelled' : next ? 'pending' : 'failed', next ?? now(), now(), id, token);
  }
}

export async function scheduleDigests(env: OperationsBindings): Promise<void> {
  if (!isIdentityPlacement(env)) return;
  const db = env.DB.withSession('first-primary');
  const rows = await many<{ id: string; digest: string }>(db, `SELECT u.id,COALESCE(p.digest,c.digest,'off') AS digest FROM users u
    LEFT JOIN email_preferences p ON p.user_id=u.id LEFT JOIN collaboration_profile_preferences c ON c.user_id=u.id
    WHERE u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL AND COALESCE(p.digest,c.digest,'off')<>'off'
      AND (p.next_digest_at IS NULL OR p.next_digest_at<=?) ORDER BY u.id LIMIT 100`, now());
  for (const row of rows) {
    const period = new Date().toISOString().slice(0, 10);
    const next = new Date(Date.now() + (row.digest === 'weekly' ? 7 : 1) * 86400_000).toISOString();
    const token = await hmac(env.INTERNAL_SERVICE_KEY, `email-unsubscribe:${row.id}`);
    const id = `mail_${(await sha256(`digest:${row.id}:${period}`)).slice(0, 48)}`;
    await registerResourceLocator(env, { resource_id: id, resource_type: 'delivery', repo_id: null, authority: 'identity' });
    await consumeOnce(db, 'digest', `${row.id}:${period}`, [
      stmt(db, `INSERT INTO email_preferences(user_id,digest,next_digest_at,unsubscribe_token_hash,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET next_digest_at=excluded.next_digest_at`, row.id, row.digest, next, await sha256(token), now()),
      stmt(db, `INSERT OR IGNORE INTO mail_deliveries(id,user_id,template,reference_id,next_attempt_at,created_at,updated_at)
        VALUES(?,?,'digest',?,?,?,?)`, id, row.id, `${row.id}:${period}`, now(), now(), now()),
    ]);
  }
}

export interface EmailProviderEvent {
  type: string;
  source: { type: string; domain: string };
  payload: { eventId: string; messageId: string; recipient: string; delivery: { status: string }; bounce?: { type: string } };
  metadata: { accountId: string; eventSchemaVersion: number; eventTimestamp: string };
}

export async function consumeEmailStatus(env: OperationsBindings, event: EmailProviderEvent): Promise<void> {
  if (event.source?.type !== 'email.sending' || event.source.domain !== mailDomain(env) || event.metadata?.eventSchemaVersion !== 1
    || !env.MAIL_EVENT_ACCOUNT_ID || event.metadata.accountId !== env.MAIL_EVENT_ACCOUNT_ID || !event.payload?.eventId) throw new Error('untrusted_mail_status');
  const db = env.DB.withSession('first-primary');
  await execute(db, `INSERT OR IGNORE INTO email_status_sources(id,event_json,received_at,expires_at) VALUES(?,?,?,?)`, event.payload.eventId, JSON.stringify(event), now(), new Date(Date.now() + 30 * 86400_000).toISOString());
  const delivery = await one<{ id: string }>(db, 'SELECT id FROM mail_deliveries WHERE provider_message_id=?', event.payload.messageId);
  if (!delivery) return;
  const target = await deliveryTarget(env, delivery.id, 'mail');
  if (target.cell_id !== env.CELL_ID || target.shard_id !== env.SHARD_ID) {
    if (target.cell_id === env.CELL_ID) await consumeEmailStatus(targetEnvironment(env, target), event);
    else {
      const receipt = await privateJSON<{ accepted: boolean }>(env, backgroundCell(env, target.cell_id), EVENT_RPC_SCOPE, '/internal/events/email-status', { event, target });
      if (!receipt.accepted) throw new Error('email_status_handoff_unconfirmed');
    }
    await execute(db, "UPDATE email_status_sources SET state='completed' WHERE id=?", event.payload.eventId);
    return;
  }
  await verifyEffectTarget(env, target);
  const status = event.payload.delivery.status;
  const effects: D1PreparedStatement[] = [stmt(db, `INSERT INTO mail_provider_events(id,delivery_id,type,occurred_at,created_at) VALUES(?,?,?,?,?)`,
    event.payload.eventId, delivery.id, event.type, event.metadata.eventTimestamp, now())];
  if (['delivered', 'bounced', 'complained', 'failed', 'rejected'].includes(status)) {
    effects.push(stmt(db, `UPDATE mail_deliveries SET state=?,updated_at=? WHERE id=? AND state<>'complained'
      AND (? IN ('complained','bounced') OR state NOT IN ('bounced','delivered'))`, status === 'rejected' ? 'failed' : status, now(), delivery.id, status));
  }
  if (status === 'complained' || (status === 'bounced' && event.payload.bounce?.type === 'hard')) {
    await execute(identityBinding(env), 'INSERT OR IGNORE INTO mail_suppressions(email_hash,reason,created_at) VALUES(?,?,?)', await sha256(event.payload.recipient.toLowerCase()), status, now());
  }
  effects.push(stmt(db, `UPDATE email_status_sources SET state='completed' WHERE id=?`, event.payload.eventId));
  await consumeOnce(db, 'email-provider', event.payload.eventId, effects);
}

export async function sweepEmailStatus(env: OperationsBindings): Promise<void> {
  const rows = await many<{ event_json: string }>(env.DB, `SELECT event_json FROM email_status_sources WHERE state='pending' AND expires_at>? ORDER BY received_at,id LIMIT 50`, now());
  for (const row of rows) await consumeEmailStatus(env, JSON.parse(row.event_json) as EmailProviderEvent);
  await execute(env.DB, `DELETE FROM email_status_sources WHERE state='completed' AND expires_at<=?`, now());
}
