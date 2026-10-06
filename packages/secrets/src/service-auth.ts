import { ApiError, verifyInternalRequest } from '@gitknot/core';
import { z } from 'zod';
import { secretBinding } from './crypto.ts';
import type { BrokerClient, BrokerScope, SecretsBrokerBindings } from './types.ts';

const scopes = z.enum(['vault.manage', 'vault.plan', 'vault.resolve', 'vault.rotate', 'vault.lifecycle', 'webhooks.manage', 'webhooks.sign']);
const configSchema = z.record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/), scopes: z.array(scopes).min(1).max(7),
  account_ids: z.array(z.string()).max(256).nullable().default(null), repository_ids: z.array(z.string()).max(256).nullable().default(null),
}).strict());

export async function verifyBrokerClient(request: Request, env: SecretsBrokerBindings, scope: BrokerScope): Promise<BrokerClient> {
  let config: z.infer<typeof configSchema>;
  try { config = configSchema.parse(JSON.parse(await secretBinding(env.SECRETS_SERVICE_KEYS_JSON))); }
  catch { throw new ApiError(503, 'vault_identity_unavailable', 'Vault service identities are not configured.'); }
  const entries = Object.values(config);
  if (new Set(entries.map((client) => client.key)).size !== entries.length
    || entries.some((client) => new Set(client.key).size < 16 || /placeholder|changeme|example/i.test(client.key))) {
    throw new ApiError(503, 'vault_identity_unavailable', 'Vault service identities require distinct operator-provisioned keys.');
  }
  const id = request.headers.get('x-gitknot-service-client') ?? '';
  const selected = Object.hasOwn(config, id) ? config[id] : undefined;
  if (!selected || !selected.scopes.includes(scope)) throw new ApiError(403, 'service_scope_denied', 'This service identity is not authorized for the requested vault purpose.');
  if (scope === 'vault.rotate' && (selected.account_ids !== null || selected.repository_ids !== null)) {
    throw new ApiError(403, 'service_scope_denied', 'Global key maintenance requires an explicitly unscoped maintenance identity.');
  }
  await verifyInternalRequest(request, selected.key, scope, { database: env.DB });
  return { id, ...selected };
}
