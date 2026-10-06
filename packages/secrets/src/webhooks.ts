import { ApiError, auditStatement, bytes, canonicalJson, many, newId, now, one, sha256, stmt } from '@gitknot/core';
import type { AppContext, EventRecord, Principal } from '@gitknot/core';
import { authorizationWitness, authorizeVault, checkClientScope, currentRuntimePrincipal } from './authorization.ts';
import { loadKeyring, randomKeyBytes, sealValue } from './crypto.ts';
import { envelopeStatements, vaultBatch } from './database.ts';
import { activeEncryptionKey, decryptCiphertext } from './keys.ts';
import { principalSchema } from './schema.ts';
import type { BrokerClient, CipherIdentity, Ciphertext, SecretsBrokerBindings } from './types.ts';
import { vaultMetadata } from './authority.ts';

interface Webhook { id: string; account_id: string; repo_id: string; principal_id: string; principal_json: string; installation_id: string | null; state: string; revision: number; events_json: string }
interface Delivery { id: string; webhook_id: string; account_id: string; repo_id: string; event_id: string; state: string; lease_until: string | null; revision: number }

function identity(webhook: Webhook, ciphertextId: string): CipherIdentity {
  return { format: 1, purpose: 'webhook_signing', entry_id: webhook.id, version_id: ciphertextId, version: 1,
    account_id: webhook.account_id, repo_id: webhook.repo_id, environment_id: null, scope_type: 'repository', scope_id: webhook.repo_id, name: 'WEBHOOK_SIGNING_KEY' };
}

function base64(raw: Uint8Array): string { return btoa(Array.from(raw, (byte) => String.fromCharCode(byte)).join('')); }

export async function createWebhookKey(c: AppContext, env: SecretsBrokerBindings, client: BrokerClient, input: {
  webhook_id: string; key_id: string; principal: Principal; overlap_seconds: number;
}): Promise<{ key_id: string; secret_ref: string; secret: string }> {
  const hook = await vaultMetadata<Webhook | null>(env, { action: 'webhook', resource_id: input.webhook_id });
  if (!hook || hook.state === 'revoked') throw new ApiError(404, 'not_found', 'The webhook was not found.');
  checkClientScope(client, hook);
  const witness = await authorizationWitness(c, input.principal, hook);
  await authorizeVault(c, input.principal, 'webhooks.manage', hook);
  if (await one(env.DB, 'SELECT id FROM vault_webhook_keys WHERE id=?', input.key_id)) {
    throw new ApiError(409, 'one_time_key_already_issued', 'This signing key was already issued once. Rotate it if the response was lost.');
  }
  const raw = randomKeyBytes();
  try {
    const ref = newId('whsecret');
    const envelope = await sealValue(raw, identity(hook, ref), await activeEncryptionKey(env));
    const current = await vaultMetadata<Webhook | null>(env, { action: 'webhook', resource_id: hook.id, repo_id: hook.repo_id });
    if (!current || canonicalJson(current) !== canonicalJson(hook)) throw new ApiError(412, 'webhook_changed', 'The authoritative webhook changed before key creation.');
    const guard = newId('vault_guard');
    const operation = `webhook-key:${input.key_id}`;
    await vaultBatch(env.DB, stmt(env.DB, 'INSERT INTO vault_operations (id,account_id,principal_id,request_hash,resource_id,response_json,created_at) VALUES (?,?,?,?,?,?,?)',
      operation, hook.account_id, input.principal.id, await sha256(canonicalJson({ ...input, principal: input.principal.id })), input.key_id,
      JSON.stringify({ key_id: input.key_id, secret_ref: ref }), now()), [
      ...envelopeStatements(env.DB, envelope),
      stmt(env.DB, 'INSERT INTO vault_webhook_keys (id,webhook_id,account_id,repo_id,ciphertext_id,created_by,created_at) VALUES (?,?,?,?,?,?,?)',
        input.key_id, hook.id, hook.account_id, hook.repo_id, ref, input.principal.id, now()),
      auditStatement(env.DB, { action: 'webhooks.signing_key.created', resource_id: input.key_id, account_id: hook.account_id, repo_id: hook.repo_id,
        actor_id: input.principal.id, credential_id: input.principal.credential_id, request_id: c.get('requestId'), details: { webhook_id: hook.id, overlap_seconds: input.overlap_seconds } }),
    ], [witness]);
    return { key_id: input.key_id, secret_ref: ref, secret: `whsec_${base64(raw)}` };
  } finally { raw.fill(0); }
}

function publicEvent(event: EventRecord): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const name of ['ref', 'before', 'after', 'commit_oid', 'head_oid', 'base_oid', 'state', 'action', 'number', 'run_id', 'item_id']) {
    const value = event.data[name];
    if ((typeof value === 'string' && value.length <= 1024) || typeof value === 'number' || typeof value === 'boolean' || value === null) data[name] = value;
  }
  return { id: event.id, type: event.type, version: event.version, occurred_at: event.occurred_at, actor_id: event.actor_id,
    resource_id: event.resource_id, resource_revision: event.resource_revision, repo_id: event.repo_id ?? null, account_id: event.account_id ?? null, data };
}

function eventCapability(type: string): string {
  if (/^(pull_request|review)\./.test(type)) return 'pull_requests.read';
  if (type.startsWith('issue.')) return 'issues.read';
  if (type.startsWith('discussion.')) return 'discussions.read';
  if (type.startsWith('task.')) return 'tasks.read';
  if (/^(workflow|run)\./.test(type)) return 'runs.read';
  if (type.startsWith('membership.')) return 'members.read';
  if (type.startsWith('billing.')) return 'billing.read';
  return 'contents.read';
}

async function webhookPrincipal(c: AppContext, hook: Webhook): Promise<Principal> {
  const snapshot = principalSchema.parse(JSON.parse(hook.principal_json));
  if (snapshot.id !== hook.principal_id) throw new ApiError(503, 'webhook_principal_mismatch', 'The webhook identity requires reconciliation.');
  const current = await currentRuntimePrincipal(c.env.DB, { actor_id: snapshot.id, actor_kind: snapshot.kind,
    actor_user_id: snapshot.user_id, actor_credential_id: snapshot.credential_id });
  const principal = { ...snapshot, mfa: current.mfa };
  if (hook.installation_id) {
    const installation = await one<{ capabilities_json: string; repository_ids_json: string }>(c.env.DB,
      `SELECT i.capabilities_json,i.repository_ids_json FROM installations i JOIN applications a ON a.id=i.application_id
      WHERE i.id=? AND i.id=? AND i.account_id=? AND i.suspended_at IS NULL AND a.disabled_at IS NULL`, hook.installation_id, principal.id, hook.account_id);
    if (!installation) throw new ApiError(403, 'installation_revoked', 'The webhook installation is no longer authorized.');
    principal.capabilities = JSON.parse(installation.capabilities_json) as string[];
    principal.repository_ids = JSON.parse(installation.repository_ids_json) as string[];
    principal.account_ids = [hook.account_id];
  }
  return principal;
}

export async function signWebhookDelivery(c: AppContext, env: SecretsBrokerBindings, client: BrokerClient, input: {
  delivery_id: string; event_id: string; timestamp: number; body: string;
}): Promise<{ signature: string }> {
  if (!Number.isSafeInteger(input.timestamp) || Math.abs(Date.now() / 1000 - input.timestamp) > 60 || new TextEncoder().encode(input.body).length > 128 * 1024) {
    throw new ApiError(422, 'invalid_delivery_signature_request', 'Delivery signing requires a fresh timestamp and a bounded event envelope.');
  }
  type DeliverySnapshot = { delivery: Delivery | null; webhook: Webhook | null; event: { event_json: string } | null; keys: Array<{ id: string; state: string; valid_until: string | null; secret_ref: string }> };
  const snapshot = await vaultMetadata<DeliverySnapshot>(env, { action: 'delivery', resource_id: input.delivery_id });
  const delivery = snapshot.delivery;
  if (!delivery || delivery.state !== 'sending' || !delivery.lease_until || delivery.lease_until <= now()) throw new ApiError(403, 'delivery_not_current', 'Only a currently leased delivery may be signed.');
  const hook = snapshot.webhook;
  if (!hook || hook.state !== 'active' || hook.account_id !== delivery.account_id || delivery.event_id !== input.event_id) throw new ApiError(403, 'webhook_inactive', 'The webhook is not active.');
  checkClientScope(client, hook);
  const principal = await webhookPrincipal(c, hook);
  const witness = await authorizationWitness(c, principal, hook);
  const row = snapshot.event;
  if (!row) throw new ApiError(403, 'event_unavailable', 'The persisted event is not available to this webhook.');
  const event = JSON.parse(row.event_json) as EventRecord;
  const patterns = JSON.parse(hook.events_json) as string[];
  if (!/^(repository|ref|git|issue|pull_request|review|discussion|task|workflow|run|membership|billing)\./.test(event.type)
    || !patterns.some((p) => p === '*' || p === event.type || (p.endsWith('.*') && event.type.startsWith(p.slice(0, -1))))) {
    throw new ApiError(403, 'event_scope_denied', 'The event is outside this webhook subscription.');
  }
  let body: unknown;
  try { body = JSON.parse(input.body); } catch { throw new ApiError(422, 'invalid_event_body', 'The event envelope must be JSON.'); }
  if (canonicalJson(body) !== canonicalJson(publicEvent(event))) throw new ApiError(403, 'event_body_mismatch', 'The signing body must exactly represent the persisted public event.');
  await authorizeVault(c, principal, eventCapability(event.type), hook);
  const keyRows: Array<{ id: string; ciphertext_id: string; state: string }> = [];
  for (const selected of snapshot.keys) {
    const value = await one<{ id: string; ciphertext_id: string }>(env.DB, `SELECT id,ciphertext_id FROM vault_webhook_keys
      WHERE id=? AND webhook_id=? AND account_id=? AND repo_id=? AND ciphertext_id=? AND revoked_at IS NULL`, selected.id, hook.id, hook.account_id, hook.repo_id, selected.secret_ref);
    if (value) keyRows.push({ ...value, state: selected.state });
  }
  if (!keyRows.length || keyRows.length > 2 || !keyRows.some((key) => key.state === 'active')) throw new ApiError(503, 'webhook_key_unavailable', 'The active webhook key set could not be verified.');
  const ring = await loadKeyring(env);
  const signatures: string[] = [];
  for (const row of keyRows) {
    const ciphertext = await one<Ciphertext>(env.DB, 'SELECT * FROM vault_ciphertexts WHERE id=? AND account_id=? AND purpose=?', row.ciphertext_id, hook.account_id, 'webhook_signing');
    if (!ciphertext) throw new ApiError(503, 'webhook_key_unavailable', 'An encrypted webhook key is missing.');
    const raw = await decryptCiphertext(env.DB, ring, ciphertext, identity(hook, row.ciphertext_id));
    try {
      const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      signatures.push(`v1,${base64(new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes(`${event.id}.${input.timestamp}.${input.body}`))))}`);
    } finally { raw.fill(0); }
  }
  const id = newId('vsign');
  const guards = keyRows.map(() => newId('vault_guard'));
  const current = await vaultMetadata<DeliverySnapshot>(env, { action: 'delivery', resource_id: input.delivery_id, repo_id: hook.repo_id });
  if (canonicalJson(current) !== canonicalJson(snapshot) || !current.delivery?.lease_until || current.delivery.lease_until <= now()) throw new ApiError(409, 'delivery_fenced', 'The current delivery authorization changed before signing.');
  await vaultBatch(env.DB, stmt(env.DB, `INSERT INTO vault_webhook_signatures
    (id,delivery_id,event_id,webhook_id,account_id,repo_id,timestamp,body_sha256,key_ids_json,service_client_id,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  id, delivery.id, event.id, hook.id, hook.account_id, hook.repo_id, input.timestamp, await sha256(input.body), JSON.stringify(keyRows.map((key) => key.id)), client.id, now()), [
    ...keyRows.map((key, i) => stmt(env.DB, `INSERT INTO vault_write_guards (id,valid) SELECT ?,CASE WHEN EXISTS
      (SELECT 1 FROM vault_webhook_keys WHERE id=? AND webhook_id=? AND revoked_at IS NULL) THEN 1 ELSE 0 END`, guards[i], key.id, hook.id)),
    auditStatement(env.DB, { action: 'webhooks.delivery.signed', resource_id: delivery.id, account_id: hook.account_id, repo_id: hook.repo_id,
      actor_id: principal.id, request_id: c.get('requestId'), details: { event_id: event.id, signature_audit_id: id, key_ids: keyRows.map((key) => key.id), service_client_id: client.id } }),
    stmt(env.DB, 'DELETE FROM vault_write_guards WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(guards)),
  ], [witness]);
  return { signature: signatures.join(' ') };
}
