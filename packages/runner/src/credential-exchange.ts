import { z } from 'zod';
import { canonicalJson, digestJson } from '../../workflows/src/canonical.ts';

/** Portable client/server contract; this module has no Node or infrastructure imports. */
export const credentialExchangeSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(/^rce_[a-f0-9]{32}$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expected_generation: z.number().int().min(0),
});
export type CredentialExchange = z.infer<typeof credentialExchangeSchema>;
export type CredentialExchangeKind = 'register' | 'rotate';

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function createCredentialExchange(expectedGeneration: number): CredentialExchange {
  return credentialExchangeSchema.parse({ version: 1, id: `rce_${crypto.randomUUID().replaceAll('-', '')}`, nonce: base64url(crypto.getRandomValues(new Uint8Array(32))), expected_generation: expectedGeneration });
}

export async function deriveRunnerCredential(secret: string, input: {
  api_origin: string;
  operation: CredentialExchangeKind;
  /** 'enrollment' for registration; the immutable runner ID for rotation. */
  subject: string;
  /** Registration fields excluding enrollment_token/exchange, or {} for rotation. */
  request: unknown;
  exchange: CredentialExchange;
}): Promise<string> {
  const exchange = credentialExchangeSchema.parse(input.exchange);
  const encoded = exchange.nonce.replaceAll('-', '+').replaceAll('_', '/') + '=';
  const nonce = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
  if (nonce.byteLength !== 32 || base64url(nonce) !== exchange.nonce) throw new Error('Invalid credential exchange nonce.');
  const origin = new URL(input.api_origin);
  if (origin.origin !== input.api_origin) throw new Error('Credential exchange requires a canonical API origin.');
  const info = new TextEncoder().encode(canonicalJson({
    protocol: 'gitknot.runner-credential-exchange.v1',
    api_origin: origin.origin,
    operation: input.operation,
    subject: input.subject,
    exchange_id: exchange.id,
    generation: exchange.expected_generation + 1,
    request_digest: await digestJson(input.request),
  }));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: nonce, info }, key, 256);
  return `gkt_${base64url(new Uint8Array(derived))}`;
}
