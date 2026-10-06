import { ApiError, readBounded, signInternalRequest } from '@gitknot/core';
import type { Principal } from '@gitknot/core';
import type { BrokerScope, PlanSelection, PlanSelectionInput, PlanSelectionPreview, ResolveAttemptInput, ResolvedSecrets, SecretsClientBindings, WriteEntryInput } from './types.ts';

export async function brokerRequest<T>(env: SecretsClientBindings, scope: BrokerScope, path: string, input: unknown): Promise<T> {
  if (typeof env.SECRETS_CLIENT_ID !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(env.SECRETS_CLIENT_ID)
    || typeof env.SECRETS_CLIENT_KEY !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(env.SECRETS_CLIENT_KEY)) {
    throw new ApiError(503, 'vault_unavailable', 'The private vault service identity is not configured.');
  }
  const request = new Request(`https://internal.gitknot.com${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gitknot-service-client': env.SECRETS_CLIENT_ID },
    body: JSON.stringify(input), signal: AbortSignal.timeout(15_000) });
  let response: Response;
  try { response = await env.SECRETS.fetch(await signInternalRequest(request, env.SECRETS_CLIENT_KEY, scope)); }
  catch { throw new ApiError(503, 'vault_unavailable', 'The private vault could not complete this request.'); }
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(response.status < 500 ? response.status : 503, failure?.error?.code ?? 'vault_unavailable',
      response.status < 500 ? failure?.error?.message ?? 'The vault request was denied.' : 'The private vault could not verify this request.');
  }
  // 64 × 16 KiB values can expand sixfold when JSON escapes control characters.
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(response.body, 8 * 1024 * 1024))) as T;
}

export function selectSecretsForPlan(env: SecretsClientBindings, input: PlanSelectionInput): Promise<PlanSelection> {
  return brokerRequest(env, 'vault.plan', '/internal/vault/select', input);
}

export function previewSecretsForPlan(env: SecretsClientBindings, input: PlanSelectionInput): Promise<PlanSelectionPreview> {
  return brokerRequest(env, 'vault.plan', '/internal/vault/preview', input);
}

export function initializeVaultKeyring(env: SecretsClientBindings): Promise<{ active_key_id: string; initialized: boolean }> {
  return brokerRequest(env, 'vault.rotate', '/internal/vault/keys/initialize', {});
}

export function bindSecretPlan(env: SecretsClientBindings, input: { selection_id: string; plan_digest: string; principal: Principal }): Promise<{ bound: true }> {
  return brokerRequest(env, 'vault.plan', '/internal/vault/bind-plan', input);
}

export function resolveAttemptSecrets(env: SecretsClientBindings, input: ResolveAttemptInput): Promise<ResolvedSecrets> {
  return brokerRequest(env, 'vault.resolve', '/internal/vault/resolve', input);
}

export function writeVaultEntry(env: SecretsClientBindings, input: WriteEntryInput): Promise<Record<string, unknown>> {
  return brokerRequest(env, 'vault.manage', '/internal/vault/write', input);
}
