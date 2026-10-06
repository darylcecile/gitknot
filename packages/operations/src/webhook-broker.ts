import type { Principal } from '@gitknot/core';
import { brokerRequest } from '../../secrets/src/client.ts';
import type { SecretsClientBindings } from '../../secrets/src/types.ts';

export function createSigningKey(env: SecretsClientBindings, input: { webhook_id: string; key_id: string; principal: Principal; overlap_seconds: number }): Promise<{ key_id: string; secret_ref: string; secret: string }> {
  return brokerRequest(env, 'webhooks.manage', '/internal/webhooks/keys', input);
}

export function signDelivery(env: SecretsClientBindings, input: { delivery_id: string; event_id: string; timestamp: number; body: string }): Promise<{ signature: string }> {
  return brokerRequest(env, 'webhooks.sign', '/internal/webhooks/sign', input);
}
