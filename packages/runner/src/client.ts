import { randomUUID, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { sha256, verifyManifest } from '../../workflows/src/index.ts';
import { abortError, RunnerApiError, RunnerError, throwIfAborted } from './errors.ts';
import { redactText } from './redaction.ts';
import { assignmentSchema, registrationSchema, rotationResponseSchema, type Assignment, type AttemptAuth, type CompletionReceipt, type LogChunk, type RunnerCapabilities, type RunnerRegistration, type TerminationReceipt } from './protocol.ts';
import type { CredentialExchange } from './credential-exchange.ts';
import { responseSessionCookie, sessionCookieName } from './session-cookie.ts';
import type { SessionUpdate } from './session-cookie.ts';

export function apiOrigin(value: string, allowLoopbackHttp = false): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new RunnerError('api_origin_invalid', 'Expected a GitKnot API HTTPS origin.'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new RunnerError('api_origin_invalid', 'An API origin cannot contain credentials, a path, or query parameters.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowLoopbackHttp && loopback && url.protocol === 'http:')) throw new RunnerError('https_required', 'GitKnot requires HTTPS; HTTP is available only for explicitly enabled loopback development.');
  return url.origin;
}

export interface HttpOptions {
  origin?: string;
  token?: string;
  allow_loopback_http?: boolean;
  fetch?: typeof fetch;
  redactions?: string[];
  session?: { name: '__Host-gitknot_session' | 'gitknot_session'; value: string; app_origin: string };
  /** Called before consuming the response body, and again if session metadata arrives. */
  on_session_change?: (update: SessionUpdate) => Promise<void>;
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeout_ms?: number;
  max_bytes?: number;
  retryable?: boolean;
  idempotency_key?: string;
  body_factory?: () => ReadableStream<Uint8Array>;
  method?: string;
}

export interface ApiResponse<T> { data: T; status: number; headers: Headers }

async function readResponse(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > maximum) throw new RunnerError('api_response_limit', 'The GitKnot response exceeds its byte limit.');
      chunks.push(value);
    }
    const bytes = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally { await reader.cancel().catch(() => {}); }
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const header = response?.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    const value = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - Date.now();
    if (Number.isFinite(value)) return Math.max(0, Math.min(30_000, value));
  }
  return Math.min(5_000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100);
}

export class GitKnotHttpClient {
  readonly origin: string;
  protected token: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly redactions: string[];
  private session: HttpOptions['session'];
  private readonly manageSession: boolean;
  private readonly onSessionChange: HttpOptions['on_session_change'];

  constructor(options: HttpOptions = {}) {
    this.origin = apiOrigin(options.origin ?? 'https://api.gitknot.com', options.allow_loopback_http);
    this.token = options.token;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.redactions = [...(options.redactions ?? []), ...(options.token ? [options.token] : [])];
    this.session = options.session ? { ...options.session } : undefined;
    this.manageSession = !!(options.session || options.on_session_change);
    this.onSessionChange = options.on_session_change;
    if (options.session) {
      if (!/^gks_[A-Za-z0-9_-]{43}$/.test(options.session.value) || options.session.name !== sessionCookieName(this.origin)) throw new RunnerError('credential_invalid', 'The stored session credential is invalid for this API origin.');
      this.redactions.push(options.session.value);
    }
  }

  setToken(token: string): void { this.redactions.push(token); this.token = token; }
  addRedactions(values: string[]): void { this.redactions.push(...values); }

  private async persistSession(update: SessionUpdate): Promise<void> {
    try { await this.onSessionChange?.(update); }
    catch (error) {
      if (error instanceof RunnerError) throw error;
      throw new RunnerError('session_persistence_failed', 'GitKnot could not persist the updated session credential.');
    }
  }

  private async acceptSession(response: Response, previous: string | null): Promise<void> {
    if (response.redirected || response.url && new URL(response.url).origin !== this.origin) throw new RunnerError('api_origin_invalid', 'The GitKnot response left the selected API origin.');
    const session = responseSessionCookie(response.headers, this.origin);
    if (session) this.addRedactions([session.value]);
    if (!this.manageSession || session === undefined || session === null && !this.session) return;
    // A delayed response for an older credential cannot undo a later rotation.
    if ((this.token ?? this.session?.value ?? null) !== previous) return;
    const appOrigin = this.session?.app_origin ?? this.origin;
    this.session = session ? { name: session.name, value: session.value, app_origin: appOrigin } : undefined;
    this.token = undefined;
    await this.persistSession({ previous_value: previous, session });
  }

  private async sessionMetadata(response: Response, data: unknown): Promise<void> {
    if (!this.onSessionChange || !this.session) return;
    const session = responseSessionCookie(response.headers, this.origin);
    if (!session || session.value !== this.session.value) return;
    const parsed = z.object({ session: z.object({ id: z.string().regex(/^cred_[A-Za-z0-9_-]{1,120}$/), expires_at: z.string().max(32) }) }).safeParse(data);
    if (!parsed.success || !Number.isFinite(Date.parse(parsed.data.session.expires_at))) return;
    await this.persistSession({ previous_value: session.value, session, credential: parsed.data.session });
  }

  protected url(path: string): string {
    if ((!path.startsWith('/v1/') && path !== '/openapi.json') || path.startsWith('//') || path.includes('\\') || /[\r\n\x00]/.test(path)) throw new RunnerError('api_path_invalid', 'API paths must be relative /v1/... paths or /openapi.json.');
    let url: URL;
    try {
      for (const segment of path.split('?')[0]!.split('/')) if (['.', '..'].includes(decodeURIComponent(segment))) throw new Error();
      url = new URL(path, this.origin);
    } catch { throw new RunnerError('api_path_invalid', 'API path is invalid.'); }
    if (url.origin !== this.origin || (!url.pathname.startsWith('/v1/') && url.pathname !== '/openapi.json')) throw new RunnerError('api_path_invalid', 'API requests cannot leave the configured origin.');
    return url.href;
  }

  protected async requestResponse(method: string, path: string, options: RequestOptions, signal: AbortSignal): Promise<Response> {
    const previous = this.token ?? this.session?.value ?? null;
    const headers = new Headers(options.headers);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    headers.set('User-Agent', 'gitknot/0.1.0');
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    else if (this.session) {
      headers.set('Cookie', `${this.session.name}=${this.session.value}`);
      headers.set('Origin', this.session.app_origin);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('X-GitKnot-CSRF', '1');
    }
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (options.body_factory && !headers.has('Content-Type')) headers.set('Content-Type', 'application/octet-stream');
    if (options.idempotency_key) headers.set('Idempotency-Key', options.idempotency_key);
    const init: RequestInit & { duplex?: 'half' } = { method, headers, body: options.body_factory ? options.body_factory() : options.body === undefined ? undefined : JSON.stringify(options.body), redirect: 'error', signal };
    if (options.body_factory) init.duplex = 'half';
    const response = await this.fetcher(this.url(path), init);
    try { await this.acceptSession(response, previous); }
    catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
    return response;
  }

  private async responseError(response: Response, signal: AbortSignal): Promise<RunnerApiError> {
    let envelope: unknown;
    try { envelope = JSON.parse(new TextDecoder().decode(await readResponse(response, 65_536, signal))); }
    catch { envelope = null; }
    const parsed = z.object({ error: z.object({ code: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), message: z.string().max(4096), request_id: z.string().max(256).optional() }) }).safeParse(envelope);
    if (!parsed.success) return new RunnerApiError('api_error', `GitKnot returned HTTP ${response.status}.`, response.status);
    const error = parsed.data.error;
    return new RunnerApiError(error.code, redactText(error.message.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''), this.redactions), response.status, error.request_id);
  }

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
    const timeout = AbortSignal.timeout(options.timeout_ms ?? 30_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const attempts = options.retryable ? 5 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      throwIfAborted(signal);
      let response: Response | undefined;
      try {
        response = await this.requestResponse(method, path, options, signal);
        if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
          await response.body?.cancel();
          await delay(retryDelay(response, attempt), undefined, { signal });
          continue;
        }
        if (!response.ok) throw await this.responseError(response, signal);
        const bytes = await readResponse(response, options.max_bytes ?? 16_777_216, signal);
        let data: unknown = null;
        if (bytes.byteLength) {
          const text = new TextDecoder().decode(bytes);
          if ((response.headers.get('content-type') ?? '').includes('json')) {
            try { data = JSON.parse(text); } catch { throw new RunnerError('api_response_invalid', 'GitKnot returned invalid JSON.'); }
          } else data = text;
        }
        await this.sessionMetadata(response, data);
        return { data: data as T, status: response.status, headers: response.headers };
      } catch (error) {
        if (options.signal?.aborted) throw abortError(options.signal);
        if (timeout.aborted) throw new RunnerError('api_timeout', 'The GitKnot API request exceeded its deadline.');
        if (error instanceof RunnerError) throw error;
        if (attempt + 1 >= attempts) throw new RunnerError('api_unavailable', 'The GitKnot API could not be reached.');
        await delay(retryDelay(response, attempt), undefined, { signal }).catch(() => {});
      }
    }
    throw new RunnerError('api_unavailable', 'The GitKnot API could not be reached.');
  }

  async download(path: string, destination: string, expected: { digest?: string; size_bytes?: number; content_type?: string; etag?: string } = {}, options: RequestOptions = {}): Promise<{ digest: string; size_bytes: number }> {
    const timeout = AbortSignal.timeout(options.timeout_ms ?? 120_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    if ((expected.digest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(expected.digest)) || (expected.size_bytes !== undefined && (!Number.isSafeInteger(expected.size_bytes) || expected.size_bytes < 0 || expected.size_bytes > (options.max_bytes ?? 268_435_456)))) throw new RunnerError('input_limit', 'Input metadata exceeds its declared limits.');
    const response = await this.requestResponse(options.method ?? 'GET', path, options, signal).catch(error => {
      if (error instanceof RunnerError) throw error;
      throw new RunnerError('api_unavailable', 'The input could not be downloaded.');
    });
    if (!response.ok) throw await this.responseError(response, signal);
    if (expected.content_type && response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== expected.content_type
      || expected.etag && response.headers.get('etag') !== expected.etag) {
      await response.body?.cancel().catch(() => {});
      throw new RunnerError('input_metadata_mismatch', 'The download headers do not match the verified resource metadata.');
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.download`;
    const file = await open(temporary, 'wx', 0o600);
    const hash = createHash('sha256');
    const reader = response.body?.getReader();
    let total = 0;
    try {
      for (;;) {
        throwIfAborted(signal);
        if (!reader) break;
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > (expected.size_bytes ?? options.max_bytes ?? 268_435_456)) throw new RunnerError('input_limit', 'Input exceeded its declared length.');
        hash.update(value); await file.writeFile(value);
      }
      const digest = `sha256:${hash.digest('hex')}`;
      if ((expected.size_bytes !== undefined && total !== expected.size_bytes) || (expected.digest !== undefined && digest !== expected.digest)) throw new RunnerError('input_checksum', 'Input checksum or size does not match its immutable manifest.');
      await file.sync(); await file.close(); await rename(temporary, destination);
      return { digest, size_bytes: total };
    } catch (error) {
      await file.close().catch(() => {}); await rm(temporary, { force: true });
      if (signal.aborted) throw abortError(signal);
      if (error instanceof RunnerError) throw error;
      throw new RunnerError('input_unavailable', 'The input download was interrupted.');
    } finally { await reader?.cancel().catch(() => {}); }
  }
}

export class RunnerClient extends GitKnotHttpClient {
  async register(body: { enrollment_token: string; name: string; capabilities: RunnerCapabilities; slots: 1; disposable: boolean; exchange: CredentialExchange }): Promise<RunnerRegistration> {
    const response = await this.request('POST', '/v1/runners/register', { body, idempotency_key: body.exchange.id, retryable: true });
    const parsed = registrationSchema.safeParse(response.data);
    if (!parsed.success) throw new RunnerError('registration_invalid', 'GitKnot returned an invalid runner registration.');
    return parsed.data;
  }

  async rotate(runnerId: string, exchange: CredentialExchange): Promise<z.infer<typeof rotationResponseSchema>> {
    const response = await this.request('POST', `/v1/runners/${runnerId}/rotate`, { body: { exchange }, idempotency_key: exchange.id, retryable: true });
    const parsed = rotationResponseSchema.safeParse(response.data);
    if (!parsed.success) throw new RunnerError('rotation_invalid', 'GitKnot returned an invalid durable credential-exchange response.');
    return parsed.data;
  }

  async poll(runner: RunnerRegistration, capabilities: RunnerCapabilities, signal?: AbortSignal): Promise<Assignment | null> {
    const response = await this.request('POST', `/v1/runners/${runner.runner_id}/poll`, {
      body: { pool_id: runner.pool_id, capabilities, available_slots: 1, wait_seconds: runner.poll_timeout_seconds },
      timeout_ms: (runner.poll_timeout_seconds + 10) * 1_000, signal, retryable: true,
    });
    if (response.status === 204) return null;
    const envelope = z.object({ assignment: assignmentSchema.nullable(), retry_after_seconds: z.number().min(0).max(60).optional() }).safeParse(response.data);
    if (!envelope.success) throw new RunnerError('assignment_invalid', 'GitKnot returned an invalid assignment.');
    if (!envelope.data.assignment) return null;
    const assignment = envelope.data.assignment;
    return { ...assignment, manifest: await verifyManifest(assignment.manifest) };
  }

  async heartbeat(runner: RunnerRegistration, capabilities: RunnerCapabilities, active: Array<{ attempt_id: string; generation: number }>, signal?: AbortSignal): Promise<{ status: 'active' | 'revoked'; cancel_attempt_ids: string[] }> {
    const response = await this.request('POST', `/v1/runners/${runner.runner_id}/heartbeat`, { body: { pool_id: runner.pool_id, capabilities, available_slots: active.length ? 0 : 1, active_attempts: active }, signal, retryable: true });
    const parsed = z.object({ status: z.enum(['active', 'revoked']), cancel_attempt_ids: z.array(z.string()).default([]) }).safeParse(response.data);
    if (!parsed.success) throw new RunnerError('heartbeat_invalid', 'GitKnot returned an invalid runner heartbeat.');
    return parsed.data;
  }

  async attemptHeartbeat(attemptId: string, auth: AttemptAuth, signal?: AbortSignal): Promise<{ status: 'active' | 'cancelled' | 'revoked' | 'expired'; lease_expires_at?: string }> {
    const response = await this.request('POST', `/v1/attempts/${attemptId}/heartbeat`, { body: auth, signal, retryable: true });
    const parsed = z.object({ status: z.enum(['active', 'cancelled', 'revoked', 'expired']), lease_expires_at: z.string().optional() }).safeParse(response.data);
    if (!parsed.success) throw new RunnerError('heartbeat_invalid', 'GitKnot returned an invalid attempt heartbeat.');
    return parsed.data;
  }

  async secrets(attemptId: string, auth: AttemptAuth, stepId: string, names: string[], signal?: AbortSignal): Promise<Record<string, string>> {
    const response = await this.request('POST', `/v1/attempts/${attemptId}/secrets`, { body: { ...auth, step_id: stepId, names }, signal, retryable: true, max_bytes: 4_194_304 });
    const parsed = z.object({ values: z.record(z.string(), z.string()), expires_at: z.string() }).safeParse(response.data);
    if (!parsed.success || !Number.isFinite(Date.parse(parsed.data.expires_at)) || Date.parse(parsed.data.expires_at) <= Date.now()) throw new RunnerError('secret_missing', 'The broker did not return current step-scoped secrets.', { names });
    if (Object.keys(parsed.data.values).some((name) => !names.includes(name))) throw new RunnerError('secret_scope', 'The broker returned secrets outside the requested step scope.');
    return parsed.data.values;
  }

  async log(attemptId: string, auth: AttemptAuth, chunk: LogChunk, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (data.byteLength !== chunk.size_bytes || await sha256(data) !== chunk.digest) throw new RunnerError('log_checksum', 'A local log chunk failed checksum validation.');
    const response = await this.request('POST', `/v1/attempts/${attemptId}/logs`, { body: { ...auth, ...chunk, data_base64: Buffer.from(data).toString('base64') }, idempotency_key: `${attemptId}:${auth.generation}:log:${chunk.sequence}`, signal, retryable: true });
    const ack = z.object({ accepted: z.literal(true), sequence: z.literal(chunk.sequence), digest: z.literal(chunk.digest) }).safeParse(response.data);
    if (!ack.success) throw new RunnerError('log_ack_invalid', 'GitKnot did not acknowledge the exact log chunk.');
  }

  async output(attemptId: string, auth: AttemptAuth, chunk: { name: string; kind: 'artifact' | 'report' | 'value'; sequence: number; final: boolean; digest: string; size_bytes: number; media_type: string; retention_seconds: number }, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (data.byteLength !== chunk.size_bytes || await sha256(data) !== chunk.digest) throw new RunnerError('output_checksum', 'A local output chunk failed checksum validation.');
    const response = await this.request('POST', `/v1/attempts/${attemptId}/outputs`, { body: { ...auth, ...chunk, data_base64: Buffer.from(data).toString('base64') }, idempotency_key: `${attemptId}:${auth.generation}:output:${chunk.name}:${chunk.sequence}`, signal, retryable: true });
    const ack = z.object({ accepted: z.literal(true), name: z.literal(chunk.name), sequence: z.literal(chunk.sequence), digest: z.literal(chunk.digest) }).safeParse(response.data);
    if (!ack.success) throw new RunnerError('output_ack_invalid', 'GitKnot did not acknowledge the exact output chunk.');
  }

  async complete(attemptId: string, auth: AttemptAuth, receipt: CompletionReceipt, receiptDigest: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request('POST', `/v1/attempts/${attemptId}/complete`, { body: { ...auth, receipt, receipt_digest: receiptDigest }, idempotency_key: `${attemptId}:${auth.generation}:complete:${receiptDigest}`, signal, retryable: true });
    const ack = z.object({ accepted: z.literal(true), receipt_digest: z.literal(receiptDigest) }).safeParse(response.data);
    if (!ack.success) throw new RunnerError('receipt_ack_invalid', 'GitKnot did not acknowledge the exact completion receipt.');
  }

  async terminated(attemptId: string, auth: AttemptAuth, termination: TerminationReceipt, digest: string): Promise<void> {
    const response = await this.request('POST', `/v1/attempts/${attemptId}/terminated`, { body: { ...auth, termination, termination_digest: digest }, timeout_ms: 5_000, idempotency_key: `${attemptId}:${auth.generation}:terminated` });
    if (!z.object({ accepted: z.literal(true), termination_digest: z.literal(digest) }).safeParse(response.data).success) throw new RunnerError('termination_ack_invalid', 'GitKnot did not acknowledge process termination.');
  }
}
