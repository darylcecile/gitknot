import { currentCredentialChain, mutationStatements, newId, now, one, sha256, stmt, canonicalJson } from '@gitknot/core';
import type { AppContext, EventInput } from '@gitknot/core';
import { ScimError, translateScimMutationError } from './errors.ts';
import { condition, guarded } from './store.ts';
import type { ProvisioningContext } from './types.ts';

const leaseMilliseconds = 30_000;

export interface ScimRequestRecord {
  id: string; account_id: string; provider_id: string; credential_id: string;
  request_key: string; request_hash: string; generation: number; attempt_id: string;
  status: 'pending' | 'uncertain' | 'complete'; lease_expires_at: string;
  resource_type: 'User' | 'Group'; planned_resource_id: string; planned_user_id: string | null;
  resource_id: string | null; event_id: string | null; audit_id: string | null;
  committed_at: string | null; expires_at: string; created_at: string; updated_at: string;
}

const current = new WeakMap<AppContext, ScimRequestRecord>();

function busy(): ScimError { return new ScimError(409, 'The provisioning request is in progress. Retry with the same key.', undefined, 2); }

export async function claimScimRequest(c: AppContext, context: ProvisioningContext, kind: 'User' | 'Group', body: unknown): Promise<ScimRequestRecord | null> {
  const key = c.req.header('idempotency-key') ?? newId('unkeyed');
  if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new ScimError(400, 'Idempotency-Key must contain 1–128 visible ASCII characters.', 'invalidValue');
  const url = new URL(c.req.url);
  const hash = await sha256(`${c.req.method}\n${url.pathname}${url.search}\n${canonicalJson(body)}`);
  for (let race = 0; race < 3; race++) {
    const existing = await one<ScimRequestRecord>(c.env.DB, `SELECT * FROM federation_scim_requests
      WHERE account_id=? AND provider_id=? AND credential_id=? AND request_key=?`, context.provider.account_id, context.provider.id, context.token.credential_id, key);
    if (existing) {
      if (existing.request_hash !== hash || existing.resource_type !== kind) throw new ScimError(409, 'This idempotency key belongs to a different request.', 'invalidValue');
      if (existing.committed_at) { await verifyScimReceipt(c, existing); return existing; }
      if (existing.status === 'complete' || existing.expires_at <= now()) throw new ScimError(409, 'This request requires outcome reconciliation before a new key can be used.');
      if (existing.status === 'pending' && existing.lease_expires_at > now()) throw busy();
    }
    const at = now();
    const attempt = newId('fattempt');
    const lease = new Date(Date.now() + leaseMilliseconds).toISOString();
    const claimed = existing
      ? await one<ScimRequestRecord>(c.env.DB, `UPDATE federation_scim_requests SET generation=generation+1,attempt_id=?,status='pending',lease_expires_at=?,updated_at=?
          WHERE id=? AND request_hash=? AND generation=? AND attempt_id=? AND committed_at IS NULL AND status IN ('pending','uncertain')
          AND (status='uncertain' OR lease_expires_at<=?) RETURNING *`, attempt, lease, at, existing.id, hash, existing.generation, existing.attempt_id, at)
      : await one<ScimRequestRecord>(c.env.DB, `INSERT INTO federation_scim_requests
          (id,account_id,provider_id,credential_id,request_key,request_hash,generation,attempt_id,status,lease_expires_at,resource_type,planned_resource_id,expires_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,1,?,'pending',?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING *`, newId('frequest'), context.provider.account_id, context.provider.id,
      context.token.credential_id, key, hash, attempt, lease, kind, newId(kind === 'User' ? 'su' : 'sg'), new Date(Date.now() + 30 * 86_400_000).toISOString(), at, at);
    if (claimed) { current.set(c, claimed); return null; }
  }
  throw busy();
}

async function verifyScimReceipt(c: AppContext, record: ScimRequestRecord): Promise<void> {
  const proof = await one(c.env.DB, `SELECT e.id FROM outbox e JOIN audit_log a ON a.id=?
    WHERE e.id=? AND e.resource_id=? AND e.account_id=? AND a.resource_id=e.resource_id
      AND a.account_id=e.account_id AND a.resource_revision=e.resource_revision`, record.audit_id, record.event_id, record.resource_id, record.account_id);
  if (!record.resource_id || !proof) throw new ScimError(503, 'The committed provisioning outcome could not be verified.');
}

export function currentScimRequest(c: AppContext): ScimRequestRecord {
  const request = current.get(c);
  if (!request) throw new ScimError(503, 'The provisioning request has no durable writer identity.');
  return request;
}

export function scimGenerationGuard(c: AppContext): D1PreparedStatement[] {
  const request = current.get(c);
  if (!request) return [];
  return condition(c.env.DB, `EXISTS (SELECT 1 FROM federation_scim_requests WHERE id=? AND account_id=? AND provider_id=? AND credential_id=?
    AND request_hash=? AND generation=? AND attempt_id=? AND status IN ('pending','uncertain') AND committed_at IS NULL)`,
  request.id, request.account_id, request.provider_id, request.credential_id, request.request_hash, request.generation, request.attempt_id);
}

/** Planned IDs survive takeover, so a crash cannot switch the billed identity. */
export async function bindScimUser(c: AppContext, userId?: string): Promise<string> {
  const request = currentScimRequest(c);
  const selected = userId ?? request.planned_user_id ?? newId('u');
  if (request.planned_user_id && request.planned_user_id !== selected) throw new ScimError(409, 'The provider identity changed while provisioning was pending.', 'mutability');
  const bound = await one<{ planned_user_id: string }>(c.env.DB, `UPDATE federation_scim_requests SET planned_user_id=COALESCE(planned_user_id,?),updated_at=?
    WHERE id=? AND generation=? AND attempt_id=? AND committed_at IS NULL AND (planned_user_id IS NULL OR planned_user_id=?) RETURNING planned_user_id`,
  selected, now(), request.id, request.generation, request.attempt_id, selected);
  if (!bound) throw busy();
  request.planned_user_id = bound.planned_user_id;
  return bound.planned_user_id;
}

export async function failScimRequest(c: AppContext): Promise<void> {
  const request = current.get(c);
  if (!request) return;
  await stmt(c.env.DB, `UPDATE federation_scim_requests SET status='uncertain',lease_expires_at=?,updated_at=?
    WHERE id=? AND generation=? AND attempt_id=? AND committed_at IS NULL`, now(), now(), request.id, request.generation, request.attempt_id).run();
}

/** Business effects, generation fence, source event, audit and receipt are one batch. */
export async function commitScimMutation(c: AppContext, context: ProvisioningContext, event: EventInput, statements: D1PreparedStatement[]): Promise<void> {
  const request = current.get(c);
  const eventId = newId('evt');
  const auditId = newId('audit');
  const receipt = request ? guarded(c.env.DB, stmt(c.env.DB, `UPDATE federation_scim_requests SET resource_id=?,event_id=?,audit_id=?,committed_at=?,status='complete',updated_at=?
    WHERE id=? AND request_hash=? AND generation=? AND attempt_id=? AND status IN ('pending','uncertain') AND committed_at IS NULL`,
  event.resource_id, eventId, auditId, now(), now(), request.id, request.request_hash, request.generation, request.attempt_id)) : [];
  const chain = await currentCredentialChain(c.env.DB, context.token.credential_id);
  const credentialGuards = chain.flatMap(credential => condition(c.env.DB,
    'EXISTS (SELECT 1 FROM credentials WHERE id=? AND revision=? AND revoked_at IS NULL AND expires_at>?)', credential.id, credential.revision, now()));
  try {
    await c.env.DB.batch(await mutationStatements(c, { event: { ...event, id: eventId, account_id: context.provider.account_id,
      actor_id: context.principal.id, data: { ...event.data, provider_id: context.provider.id } },
    audit: { id: auditId, action: event.type, resource_id: event.resource_id },
    statements: [...scimGenerationGuard(c), ...credentialGuards, ...statements, ...receipt] }));
  } catch (error) { translateScimMutationError(error); }
}
