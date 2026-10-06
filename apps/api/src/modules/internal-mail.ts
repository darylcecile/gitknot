import { Context } from 'hono';
import { z } from 'zod';
import {
  ApiError, actionToken, authorize, credentialIsCurrent, database, identityDatabaseLocation, mutationStatements, newId, now, one, principalForExplanation,
  readAccountPolicy, readBounded, readRepositoryAuthority, selectIdentityDatabase, sha256, stmt, verifyInternalRequest,
} from '@gitknot/core';
import type { App, AppContext, AppEnv, CredentialRecord, EventRecord, IdentityAction, Principal, UserRecord } from '@gitknot/core';
import { principalSchema } from '../../../../packages/secrets/src/schema.ts';
import { IDENTITY_MAIL_PATH, IDENTITY_MAIL_SCOPE, identityMailEvents } from '../../../../packages/operations/src/mail-contract.ts';
import type { IdentityMailPreparation, PreparedMail } from '../../../../packages/operations/src/mail-contract.ts';

const preparationSchema = z.object({ delivery_id: z.string().min(1).max(128), lease_token: z.string().min(1).max(128),
  shard_id: z.string().min(1).max(128).optional() }).strict();

interface Delivery {
  id: string; event_id: string; user_id: string | null; account_id: string | null; repo_id: string | null;
  template: string; reference_id: string; generation: number; lease_token: string; lease_until: string;
}
interface Invitation {
  id: string; email: string; account_id: string; repo_id: string | null; key_id: string; expires_at: string;
  token_hash: string; created_by: string; principal_json: string; revision: number;
}
interface RenderedIdentityMail {
  message: PreparedMail;
  /** Current-state predicates, committed with the preparation audit before releasing its transient body. */
  predicate: string;
  bindings: unknown[];
}

function scopedContext(c: AppContext, shardId?: string): AppContext {
  const identity = identityDatabaseLocation(c.env);
  if (shardId && shardId !== identity.shard_id) throw new ApiError(409, 'identity_mail_placement_changed', 'Identity mail must be prepared at its primary authority.');
  const scoped = new Context<AppEnv>(c.req.raw, { env: c.env });
  scoped.set('requestId', c.get('requestId'));
  scoped.set('principal', null);
  selectIdentityDatabase(scoped);
  return scoped;
}

function actionLink(c: AppContext, path: string, token: string): string {
  const url = new URL(path, c.env.APP_ORIGIN);
  url.searchParams.set('token', token);
  return url.href;
}

async function renderAction(c: AppContext, delivery: Delivery, event: EventRecord): Promise<RenderedIdentityMail | null> {
  if (identityMailEvents[event.type] !== delivery.template || (event.data.action_id ?? event.resource_id) !== delivery.reference_id) {
    throw new ApiError(403, 'identity_mail_scope_mismatch', 'The delivery is not bound to this identity event.');
  }
  const db = database(c);
  const action = await one<IdentityAction>(db, `SELECT * FROM identity_actions WHERE id=? AND purpose=? AND consumed_at IS NULL AND expires_at>? AND attempts<10`,
    delivery.reference_id, delivery.template, now());
  if (!action?.user_id || !action.key_id || !action.email || delivery.user_id !== action.user_id || delivery.account_id !== action.user_id) return null;
  const user = await one<UserRecord>(db, 'SELECT * FROM users WHERE id=? AND disabled_at IS NULL', action.user_id);
  if (!user || action.auth_revision !== null && action.auth_revision !== user.auth_revision || !z.email().safeParse(action.email).success) return null;
  if (!await one(db, 'SELECT 1 FROM accounts WHERE id=? AND disabled_at IS NULL', user.id)) return null;
  if (action.purpose === 'verify_email' && (user.email_verified_at || user.email.toLowerCase() !== action.email.toLowerCase())) return null;
  if (action.purpose === 'recover_password' && user.email.toLowerCase() !== action.email.toLowerCase()) return null;
  const token = await actionToken(c.env, { ...action, key_id: action.key_id });
  if (await sha256(token) !== action.token_hash) throw new ApiError(503, 'identity_mail_integrity', 'The identity action requires reconciliation.');
  let message: PreparedMail;
  if (action.purpose === 'change_email') message = { to: action.email, security: true, subject: 'Confirm your new GitKnot email address',
    text: `Confirm this email address in your GitKnot account security settings:\n\n${new URL('/settings/security', c.env.APP_ORIGIN).href}\n\nVerification code: ${token}\n\nThis single-use code expires at ${action.expires_at}.` };
  else {
    const recover = action.purpose === 'recover_password';
    message = { to: action.email, security: true, subject: recover ? 'Reset your GitKnot password' : 'Verify your GitKnot email address',
      text: `${recover ? 'You requested a password reset.' : 'Confirm this email address for your GitKnot account.'}\n\n${actionLink(c, recover ? '/auth/reset' : '/auth/verify', token)}\n\nThis single-use link expires at ${action.expires_at}. If you did not request this, you can ignore this email.` };
  }
  return { message, predicate: `EXISTS(SELECT 1 FROM identity_actions a JOIN users u ON u.id=a.user_id JOIN accounts p ON p.id=u.id
    WHERE a.id=? AND a.revision=? AND a.token_hash=? AND a.email=? AND a.consumed_at IS NULL AND a.expires_at>? AND a.attempts<10
      AND u.auth_revision=? AND u.email=? AND u.disabled_at IS NULL AND p.disabled_at IS NULL
      AND (?<>'verify_email' OR u.email_verified_at IS NULL))`,
  bindings: [action.id, action.revision, action.token_hash, action.email, now(), user.auth_revision, user.email, action.purpose] };
}

async function invitationPrincipal(c: AppContext, invitation: Invitation): Promise<Principal | null> {
  const current = await principalForExplanation(database(c), invitation.created_by);
  const parsed = principalSchema.safeParse(JSON.parse(invitation.principal_json));
  if (!current || !parsed.success || current.id !== parsed.data.id) return null;
  const credential = parsed.data.credential_id ? await one<CredentialRecord>(database(c), 'SELECT * FROM credentials WHERE id=? AND principal_id=?', parsed.data.credential_id, current.id) : null;
  if (parsed.data.credential_id && (!credential || !await credentialIsCurrent(database(c), credential))) return null;
  // Current authorization intersects the issued ceilings with live credential, membership and SSO state.
  return { ...current, credential_id: parsed.data.credential_id, capabilities: parsed.data.capabilities, repository_ids: parsed.data.repository_ids,
    account_ids: parsed.data.account_ids, mfa: parsed.data.mfa && (!credential || credential.mfa === 1) };
}

async function renderInvitation(c: AppContext, delivery: Delivery, event: EventRecord): Promise<RenderedIdentityMail | null> {
  if (!['invitation.created', 'invitation.resent'].includes(event.type) || event.resource_id !== delivery.reference_id) {
    throw new ApiError(403, 'identity_mail_scope_mismatch', 'The delivery is not bound to this invitation event.');
  }
  const db = database(c);
  const invitation = await one<Invitation>(db, `SELECT * FROM invitations WHERE id=? AND state='pending' AND expires_at>?`, delivery.reference_id, now());
  if (!invitation || invitation.revision !== delivery.generation || invitation.account_id !== delivery.account_id || invitation.repo_id !== delivery.repo_id
    || !z.email().safeParse(invitation.email).success) return null;
  const principal = await invitationPrincipal(c, invitation);
  if (!principal) return null;
  c.set('principal', principal);
  let permission;
  try { permission = await authorize(c, 'invitations.manage', invitation.repo_id ? { repo_id: invitation.repo_id } : { account_id: invitation.account_id }); }
  catch (error) {
    if (error instanceof ApiError && [401, 403, 404, 409].includes(error.status)) return null;
    throw error;
  }
  const { policy } = await readAccountPolicy(db, invitation.account_id);
  if (invitation.repo_id && !policy.allow_outside_collaborators) return null;
  const domain = invitation.email.slice(invitation.email.lastIndexOf('@') + 1).toLowerCase();
  if (policy.allowed_email_domains.length && !policy.allowed_email_domains.some((value) => value.toLowerCase() === domain)) return null;
  const account = await one<{ name: string; policy_revision: number }>(db, 'SELECT name,policy_revision FROM accounts WHERE id=? AND disabled_at IS NULL', invitation.account_id);
  if (!account || account.policy_revision !== permission.account_policy_revision) return null;
  if (invitation.repo_id) {
    const repo = await readRepositoryAuthority(c, invitation.repo_id);
    if (!repo || repo.owner_id !== invitation.account_id || !['active', 'archived'].includes(repo.state)) return null;
  }
  const token = await actionToken(c.env, { ...invitation, purpose: 'invitation' });
  if (await sha256(token) !== invitation.token_hash) throw new ApiError(503, 'identity_mail_integrity', 'The invitation requires reconciliation.');
  return { message: { to: invitation.email, security: true, subject: 'You have a GitKnot invitation',
    text: `You have been invited to collaborate with ${account.name} on GitKnot.\n\n${actionLink(c, '/invitations', token)}\n\nThis invitation expires at ${invitation.expires_at}. Sign in with this email address to accept.` },
  predicate: `EXISTS(SELECT 1 FROM invitations i JOIN accounts a ON a.id=i.account_id JOIN principals p ON p.id=i.created_by
    WHERE i.id=? AND i.revision=? AND i.state='pending' AND i.expires_at>? AND i.token_hash=? AND i.email=?
      AND a.policy_revision=? AND a.disabled_at IS NULL AND p.disabled_at IS NULL AND (p.expires_at IS NULL OR p.expires_at>?)
       AND (p.user_id IS NULL OR EXISTS(SELECT 1 FROM users u WHERE u.id=p.user_id AND u.disabled_at IS NULL AND u.email_verified_at IS NOT NULL)))`,
   bindings: [invitation.id, invitation.revision, now(), invitation.token_hash, invitation.email, account.policy_revision, now()] };
}

async function prepare(c: AppContext, input: z.infer<typeof preparationSchema>): Promise<IdentityMailPreparation> {
  const db = database(c);
  const delivery = await one<Delivery>(db, `SELECT * FROM mail_deliveries WHERE id=? AND state='sending' AND lease_token=? AND lease_until>?`, input.delivery_id, input.lease_token, now());
  if (!delivery) throw new ApiError(409, 'mail_lease_changed', 'The mail delivery lease is no longer current.');
  const source = await one<{ event_json: string }>(db, 'SELECT event_json FROM outbox WHERE id=?', delivery.event_id);
  if (!source) throw new ApiError(503, 'mail_source_unavailable', 'The committed identity event is unavailable.');
  const event = JSON.parse(source.event_json) as EventRecord;
  if (event.id !== delivery.event_id || (event.account_id ?? null) !== delivery.account_id || (event.repo_id ?? null) !== delivery.repo_id) {
    throw new ApiError(403, 'identity_mail_scope_mismatch', 'The mail event scope does not match its committed delivery.');
  }
  const rendered = delivery.template === 'invitation' ? await renderInvitation(c, delivery, event)
    : ['verify_email', 'recover_password', 'change_email'].includes(delivery.template) ? await renderAction(c, delivery, event) : null;
  if (!rendered) return { delivery_id: delivery.id, message: null };
  const emailHash = await sha256(rendered.message.to.toLowerCase());
  if (await one(db, 'SELECT 1 FROM mail_suppressions WHERE email_hash=?', emailHash)) return { delivery_id: delivery.id, message: null };
  const guard = newId('mailguard');
  try {
    await db.batch(await mutationStatements(c, { statements: [
      stmt(db, `INSERT INTO mutation_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM mail_deliveries d
        WHERE d.id=? AND d.event_id=? AND d.reference_id=? AND d.generation=? AND d.state='sending' AND d.lease_token=? AND d.lease_until>?)
        AND NOT EXISTS(SELECT 1 FROM mail_suppressions WHERE email_hash=?) AND ${rendered.predicate} THEN 1 ELSE 0 END`,
      guard, delivery.id, delivery.event_id, delivery.reference_id, delivery.generation, delivery.lease_token, now(), emailHash, ...rendered.bindings),
      stmt(db, 'DELETE FROM mutation_guards WHERE id=?', guard),
    ], event: { type: 'mail.identity_prepared', resource_id: delivery.id, resource_revision: delivery.generation + 1,
      account_id: delivery.account_id, repo_id: delivery.repo_id, actor_id: event.actor_id,
      data: { template: delivery.template, source_event_id: event.id, reference_id: delivery.reference_id, recipient_hash: emailHash } },
    audit: { action: 'mail.identity_prepared', resource_id: delivery.id,
      details: { template: delivery.template, source_event_id: event.id, reference_id: delivery.reference_id, recipient_hash: emailHash } } }));
  } catch (error) {
    if (/mutation_requires_one_row|CHECK constraint failed/.test(String(error))) throw new ApiError(409, 'identity_mail_changed', 'The identity action changed while mail was being prepared.');
    throw error;
  }
  return { delivery_id: delivery.id, message: rendered.message };
}

/** Private service-bound handler: deliberately absent from the public route/OpenAPI registry. */
export function registerInternalMailRoutes(app: App): void {
  app.post(IDENTITY_MAIL_PATH, async (c) => {
    await verifyInternalRequest(c.req.raw, c.env.INTERNAL_SERVICE_KEY, IDENTITY_MAIL_SCOPE, { database: database(c) });
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(c.req.raw.body, 2048))); }
    catch { throw new ApiError(400, 'invalid_mail_preparation', 'The private mail request must be bounded UTF-8 JSON.'); }
    const parsed = preparationSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(400, 'invalid_mail_preparation', 'The private mail request is invalid.');
    const result = await prepare(scopedContext(c, parsed.data.shard_id), parsed.data);
    return c.json(result, 200, { 'cache-control': 'no-store', pragma: 'no-cache', 'x-content-type-options': 'nosniff' });
  });
}
