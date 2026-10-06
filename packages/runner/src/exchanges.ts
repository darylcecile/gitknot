import { basename, dirname, join, resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { canonicalJson } from '../../workflows/src/canonical.ts';
import { RunnerClient, type HttpOptions } from './client.ts';
import { credentialExchangeSchema, deriveRunnerCredential } from './credential-exchange.ts';
import { RunnerError } from './errors.ts';
import { atomicJson, isFsError, privateDirectory, readJsonFile, takeLock } from './files.ts';
import { registrationRequestSchema, registrationSchema, runnerConfigurationDraftSchema, runnerConfigurationSchema, type RunnerConfiguration } from './protocol.ts';

const common = { version: z.literal(1), exchange: credentialExchangeSchema, secret: z.string().min(16).max(16_384) };
export const pendingExchangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('register'), request: registrationRequestSchema, configuration: runnerConfigurationDraftSchema }),
  z.strictObject({ ...common, kind: z.literal('rotate'), request: z.strictObject({}), configuration: runnerConfigurationSchema }),
]);
export type PendingCredentialExchange = z.infer<typeof pendingExchangeSchema>;

export function credentialExchangePath(path: string): string { return `${resolve(path)}.exchange.json`; }

export async function pendingCredentialExchange(path: string): Promise<PendingCredentialExchange | null> {
  try {
    const parsed = pendingExchangeSchema.safeParse(await readJsonFile(credentialExchangePath(path), 2_097_152, true));
    if (!parsed.success) throw new RunnerError('credential_exchange_invalid', 'The private credential exchange journal is invalid.');
    return parsed.data;
  } catch (error) { if (isFsError(error, 'ENOENT')) return null; throw error; }
}

export async function withCredentialExchangeLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await privateDirectory(dirname(resolve(path)));
  const unlock = await takeLock(join(dirname(resolve(path)), '.credential-exchanges', basename(path)));
  try { return await action(); } finally { await unlock(); }
}

export async function saveCredentialExchange(path: string, pending: PendingCredentialExchange): Promise<void> {
  const current = await pendingCredentialExchange(path);
  if (current && canonicalJson(current) !== canonicalJson(pending)) throw new RunnerError('credential_exchange_pending', 'A different credential exchange is pending. Recover it before starting another operation.');
  await atomicJson(credentialExchangePath(path), pendingExchangeSchema.parse(pending));
}

/** Called only while the configuration/execution locks are held. The journal is durable before network I/O. */
export async function finishCredentialExchange(path: string, pending: PendingCredentialExchange, options: Pick<HttpOptions, 'fetch'> = {}): Promise<RunnerConfiguration> {
  const { configuration, exchange, secret } = pending;
  const expected = await deriveRunnerCredential(secret, { api_origin: configuration.api_origin, operation: pending.kind, subject: pending.kind === 'register' ? 'enrollment' : pending.configuration.registration.runner_id, request: pending.request, exchange });
  const client = new RunnerClient({ origin: configuration.api_origin, token: pending.kind === 'rotate' ? secret : undefined, allow_loopback_http: configuration.allow_loopback_http, fetch: options.fetch, redactions: [secret, exchange.nonce, expected] });
  const response = pending.kind === 'register'
    ? await client.register({ ...pending.request, enrollment_token: secret, exchange })
    : await client.rotate(pending.configuration.registration.runner_id, exchange);
  if (response.exchange_id !== exchange.id || response.credential_generation !== exchange.expected_generation + 1 || response.machine_token !== expected) throw new RunnerError('credential_exchange_mismatch', 'GitKnot did not return the exact deterministic credential exchange. The recovery journal was retained.');
  if (!Number.isFinite(Date.parse(response.credential_expires_at)) || Date.parse(response.credential_expires_at) <= Date.now()) throw new RunnerError('credential_exchange_expired', 'The exchanged credential is no longer current.');
  const parsedRegistration = registrationSchema.safeParse(pending.kind === 'register' ? response : { ...pending.configuration.registration, ...response });
  if (!parsedRegistration.success) throw new RunnerError('registration_invalid', 'GitKnot did not return valid runner identity metadata.');
  const registration = parsedRegistration.data;
  if (pending.kind === 'register' && (registration.disposable !== pending.request.disposable || registration.trust === 'untrusted' && !registration.disposable)) throw new RunnerError('runner_trust_mismatch', 'The enrolled pool does not match the requested disposable-machine trust constraints.');
  const installed = runnerConfigurationSchema.parse({ ...configuration, registration });
  let existing: RunnerConfiguration | null = null;
  try { existing = runnerConfigurationSchema.parse(await readJsonFile(path, 1_048_576, true)); }
  catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
  if (existing && (existing.registration.runner_id !== installed.registration.runner_id || ![secret, expected].includes(existing.registration.machine_token))) throw new RunnerError('credential_exchange_conflict', 'The local configuration changed while this credential exchange was pending.');
  await atomicJson(path, installed);
  await rm(credentialExchangePath(path));
  return installed;
}
