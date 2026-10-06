import { Context, Hono } from 'hono';
import { ApiError, auditStatement, many, newId, now, one, readBounded } from '@gitknot/core';
import type { AppContext, AppEnv } from '@gitknot/core';
import { z } from 'zod';
import { verifyBrokerClient } from './service-auth.ts';
import { changeEntry, fenceRepositoryVault, writeEntry } from './management.ts';
import { bindPlan, previewPlan, selectPlan } from './plans.ts';
import { resolveRuntime } from './runtime.ts';
import { abortRecovery, initializeKeyring, registerKeyring, retireKey, rotateKeyBatch, verifyRecoveryBatch } from './keys.ts';
import { createWebhookKey, signWebhookDelivery } from './webhooks.ts';
import { principalSchema, resolveSchema, resourceId, scopeSelectorSchema, selectionSchema, vaultNameSchema, vaultPolicySchema, writeEntrySchema } from './schema.ts';
import type { BrokerClient, BrokerScope, SecretsBrokerBindings } from './types.ts';
import { vaultEnvironment } from './authority.ts';

const changeSchema = z.object({
  principal: principalSchema, scope: scopeSelectorSchema, kind: z.enum(['secret', 'variable']), name: vaultNameSchema,
  expected_revision: z.number().int().positive(), operation_id: z.string().min(1).max(256), policy: vaultPolicySchema.optional(),
  version_id: resourceId.optional(), reason: z.string().max(1000).optional(),
}).strict();
const batchSchema = z.object({ rotation_id: resourceId, target_key_id: resourceId, limit: z.number().int().min(1).max(64).default(32) }).strict();
const recoverySchema = z.object({ verification_id: resourceId, key_id: resourceId, limit: z.number().int().min(1).max(64).default(32) }).strict();
type Handler = (c: AppContext, env: SecretsBrokerBindings, client: BrokerClient, body: unknown) => Promise<unknown>;
const handlers: Record<string, { scope: BrokerScope; run: Handler }> = {
  '/internal/vault/write': { scope: 'vault.manage', run: (c, e, client, body) => writeEntry(c, e, client, writeEntrySchema.parse(body)) },
  '/internal/vault/delete': { scope: 'vault.manage', run: (c, _e, client, body) => changeEntry(c, client, 'delete', changeSchema.parse(body)) },
  '/internal/vault/policy': { scope: 'vault.manage', run: (c, _e, client, body) => changeEntry(c, client, 'policy', changeSchema.parse(body)) },
  '/internal/vault/revoke-version': { scope: 'vault.manage', run: (c, _e, client, body) => changeEntry(c, client, 'revoke-version', changeSchema.parse(body)) },
  '/internal/vault/select': { scope: 'vault.plan', run: (c, _e, client, body) => selectPlan(c, client, selectionSchema.parse(body)) },
  '/internal/vault/preview': { scope: 'vault.plan', run: (c, _e, client, body) => previewPlan(c, client, selectionSchema.parse(body)) },
  '/internal/vault/bind-plan': { scope: 'vault.plan', run: (c, _e, client, body) => bindPlan(c, client,
    z.object({ selection_id: resourceId, plan_digest: z.string().regex(/^[a-f0-9]{64}$/), principal: principalSchema }).strict().parse(body)) },
  '/internal/vault/resolve': { scope: 'vault.resolve', run: (c, e, client, body) => resolveRuntime(c, e, client, resolveSchema.parse(body)) },
  '/internal/vault/keys/initialize': { scope: 'vault.rotate', run: (c, e, client, body) => { z.object({}).strict().parse(body); return initializeKeyring(c, e, client); } },
  '/internal/vault/keys/register': { scope: 'vault.rotate', run: (c, e, client, body) => registerKeyring(c, e, client,
    z.object({ expected_revision: z.number().int().nonnegative() }).strict().parse(body).expected_revision) },
  '/internal/vault/keys/rotate': { scope: 'vault.rotate', run: (c, e, client, body) => rotateKeyBatch(c, e, client, batchSchema.parse(body)) },
  '/internal/vault/keys/recovery': { scope: 'vault.rotate', run: (c, e, client, body) => verifyRecoveryBatch(c, e, client, recoverySchema.parse(body)) },
  '/internal/vault/keys/abort-recovery': { scope: 'vault.rotate', run: (c, e, client, body) => abortRecovery(c, e, client,
    z.object({ verification_id: resourceId }).strict().parse(body).verification_id) },
  '/internal/vault/keys/retire': { scope: 'vault.rotate', run: (c, e, client, body) => retireKey(c, e, client,
    z.object({ key_id: resourceId }).strict().parse(body).key_id) },
  '/internal/vault/fence-repository': { scope: 'vault.lifecycle', run: (c, _e, client, body) => fenceRepositoryVault(c, client,
    z.object({ repo_id: resourceId, previous_account_id: resourceId, operation_id: resourceId }).strict().parse(body)) },
  '/internal/webhooks/keys': { scope: 'webhooks.manage', run: (c, e, client, body) => createWebhookKey(c, e, client,
    z.object({ webhook_id: resourceId, key_id: resourceId, principal: principalSchema, overlap_seconds: z.number().int().min(0).max(86_400) }).strict().parse(body)) },
  '/internal/webhooks/sign': { scope: 'webhooks.sign', run: (c, e, client, body) => signWebhookDelivery(c, e, client,
    z.object({ delivery_id: resourceId, event_id: resourceId, timestamp: z.number().int(), body: z.string().max(131_072) }).strict().parse(body)) },
};

export function createSecretsBroker(): { fetch(request: Request, env: SecretsBrokerBindings | AppEnv['Bindings'], context?: ExecutionContext): Response | Promise<Response> } {
  const app = new Hono<AppEnv>();
  app.post('*', async (c) => {
    c.set('requestId', newId('vault_request'));
    c.set('database', c.env.DB.withSession('first-primary'));
    c.set('principal', null);
    const endpoint = Object.hasOwn(handlers, c.req.path) ? handlers[c.req.path] : undefined;
    if (!endpoint) throw new ApiError(404, 'not_found', 'Endpoint not found.');
    const env = c.env as SecretsBrokerBindings;
    const client = await verifyBrokerClient(c.req.raw, env, endpoint.scope);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(c.req.raw.body, 1024 * 1024))); }
    catch { throw new ApiError(400, 'invalid_json', 'The vault request must be bounded UTF-8 JSON.'); }
    try {
      const value = await endpoint.run(c, env, client, body);
      return c.json(value as Record<string, unknown>, 200, { 'cache-control': 'no-store', 'pragma': 'no-cache', 'x-content-type-options': 'nosniff' });
    } catch (error) {
      if (endpoint.scope === 'vault.resolve') {
        const input = resolveSchema.safeParse(body);
        if (input.success) await auditStatement(env.DB, { action: 'vault.resolve.denied', resource_id: input.data.attempt_id,
          actor_id: `service:${client.id}`, request_id: c.get('requestId'), details: { generation: input.data.generation, step_id: input.data.step_id,
            code: error instanceof ApiError ? error.code : 'vault_unavailable' } }).run();
      }
      throw error;
    }
  });
  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Endpoint not found.' } }, 404));
  app.onError((error, c) => {
    const invalid = error instanceof z.ZodError;
    const known = error instanceof ApiError;
    const code = invalid ? 'validation_failed' : known ? error.code : 'vault_unavailable';
    // Do not log exceptions, bodies, headers or plaintext-bearing Workflow state.
    console.error(JSON.stringify({ event: 'vault.request_failed', code, request_id: c.get('requestId') }));
    return new Response(JSON.stringify({ error: { code, message: invalid ? 'The vault request does not match its operation schema.'
      : known ? error.message : 'The private vault could not verify this operation.', request_id: c.get('requestId') } }), {
      status: invalid ? 422 : known ? error.status : 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  });
  return { fetch: (request, env, context) => app.fetch(request, vaultEnvironment(env), context) };
}

/** Resumes only previously authorized durable rotation/recovery jobs; it has no plaintext response channel. */
export async function sweepVault(env: SecretsBrokerBindings): Promise<{ advanced: number; failed: number }> {
  env = vaultEnvironment(env);
  const c = new Context<AppEnv>(new Request('https://internal.gitknot.com/vault-maintenance'), { env });
  c.set('requestId', newId('vault_maintenance'));
  c.set('principal', null);
  const client: BrokerClient = { id: 'vault-maintenance', key: '', scopes: ['vault.rotate'], account_ids: null, repository_ids: null };
  let advanced = 0, failed = 0;
  const rotations = await many<{ id: string; target_key_id: string }>(env.DB, "SELECT id,target_key_id FROM vault_key_rotations WHERE state='running' ORDER BY id LIMIT 4");
  for (const row of rotations) { try { await rotateKeyBatch(c, env, client, { rotation_id: row.id, target_key_id: row.target_key_id, limit: 32 }); advanced++; } catch { failed++; } }
  const recoveries = await many<{ id: string; key_id: string }>(env.DB, "SELECT id,key_id FROM vault_recovery_verifications WHERE state='running' ORDER BY id LIMIT 1");
  for (const row of recoveries) { try { await verifyRecoveryBatch(c, env, client, { verification_id: row.id, key_id: row.key_id, limit: 32 }); advanced++; } catch { failed++; } }
  await env.DB.prepare('DELETE FROM internal_nonces WHERE expires_at<? AND (scope LIKE ? OR scope LIKE ?)').bind(now(), 'vault.%', 'webhooks.%').run();
  return { advanced, failed };
}
