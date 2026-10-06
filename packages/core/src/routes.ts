import type { Handler } from 'hono';
import type { StatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { ApiError, diagnostic, errorResponse } from './errors.ts';
import { execute, one } from './db.ts';
import { base64url, canonicalJson, fromBase64url, fromHex, hex, hmac, newId, now, sha256, verifyHmac } from './crypto.ts';
import { identityKeys } from './auth.ts';
import { bodyBytes, captureMutationAuthority, isJsonMediaType, jsonBody, requestPolicies, requirePrincipal } from './http.ts';
import { readBounded } from './limits.ts';
import { requestDatabaseBinding, selectedRepositoryScope } from './routing.ts';
import { repositoryCleanupRequest } from './routing/lifecycle.ts';
import type { App, AppContext, AppEnv, IdempotencyContext, IdempotencyRecord, RequestAuthorization, RequestPolicy } from './types.ts';

export type RouteAuthorization = (c: AppContext, record: IdempotencyRecord | null) => RequestAuthorization[] | Promise<RequestAuthorization[]>;

interface MutationIdempotency {
  /** Default: all effects must use mutate() or mutationStatements() in one D1 batch. */
  strategy?: 'mutation';
  /** Resolve every policy scope, including indirect resources and ref/path conditions. No effects. */
  /** Also enforced when the caller omits Idempotency-Key. Prefer RouteOptions.authorization for new routes. */
  authorization?: RouteAuthorization;
  /**
   * Read-only recovery for a nonstandard resource: return its registered GET path
   * or a currently authorized public response. Never repeat the mutation.
   */
  recover?: (c: AppContext, record: IdempotencyRecord) => Promise<Response | string | null>;
}

interface ExternalIdempotency {
  strategy: 'external';
  authorization?: RouteAuthorization;
  /**
   * Reconcile the persisted operation_id or the immutable resource bound by its
   * committed D1 intent. Return null/202 until that operation completes; a local timeout
   * never permits replacing it. Sensitive recovery may settle an existing issuance
   * but must never issue another credential. Its response body is always discarded.
   */
  recover: (c: AppContext, record: IdempotencyRecord) => Promise<Response | null>;
}

export type IdempotencyOptions = MutationIdempotency | ExternalIdempotency;

export interface RouteOptions {
  summary: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  body?: z.ZodType;
  requestBody?: Record<string, unknown>;
  response?: z.ZodType;
  capability?: string;
  /** Complete mutation requirements, including indirect resources; independent of retry keys. */
  authorization?: RouteAuthorization;
  public?: boolean;
  idempotent?: boolean;
  idempotency?: IdempotencyOptions;
  /** Required for one-time issuance; set before any credential is created. */
  sensitive?: boolean;
  streaming?: boolean;
  parameters?: Record<string, unknown>[];
  responses?: Record<string, unknown>;
}

interface RouteDefinition extends RouteOptions { method: string; path: string }
const definitions = new WeakMap<App, RouteDefinition[]>();

// Kept local so the shared recovery/context API remains compatible with callers.
interface FingerprintedRequest extends IdempotencyRecord {
  fingerprint_version: number;
  fingerprint_key_id: string | null;
}

const fingerprintVersion = 1;
const fingerprintKeyDomain = 'GitKnot request fingerprint key v1\0';
const fingerprintMessageDomain = 'GitKnot request fingerprint message v1\0';
const fingerprintPreconditions = ['if-match', 'if-none-match', 'if-unmodified-since', 'if-modified-since', 'if-range'] as const;

function fingerprintUnavailable(): never {
  throw new ApiError(503, 'idempotency_fingerprint_unavailable', 'GitKnot could not verify this request fingerprint. Restore its retained key version and retry with the same idempotency key.');
}

/** Private, fixed-domain signing only: never expose a general HMAC or key-selection endpoint. */
async function requestFingerprint(c: AppContext, key: string, bodyHash: string, record: FingerprintedRequest | null) {
  if (record?.fingerprint_version === 0) {
    throw new ApiError(409, 'idempotency_fingerprint_retired', 'This request predates protected fingerprints. Inspect its original resource or operation before starting another request.');
  }
  if (record && record.fingerprint_version !== fingerprintVersion) return fingerprintUnavailable();
  // SESSION_KEY alone has no retained version history. Fingerprints require the
  // explicit identity ring shared by every API cell in this environment.
  if (typeof c.env.IDENTITY_KEYS_JSON !== 'string') return fingerprintUnavailable();
  let ring: ReturnType<typeof identityKeys>;
  try { ring = identityKeys(c.env); } catch { return fingerprintUnavailable(); }
  const keyId = record ? record.fingerprint_key_id : ring.current;
  if (!keyId || !/^[a-zA-Z0-9_-]{1,32}$/.test(keyId) || !Object.hasOwn(ring.keys, keyId)) return fingerprintUnavailable();
  const signingKey = fromBase64url(await hmac(ring.keys[keyId], fingerprintKeyDomain));
  const url = new URL(c.req.url);
  // Placement, host and credential IDs deliberately do not participate: resource
  // IDs/paths and principals survive cell moves and credential/key rotation.
  const message = fingerprintMessageDomain + canonicalJson({ version: fingerprintVersion, key_id: keyId,
    principal_id: requirePrincipal(c).id, idempotency_key: key, method: c.req.method,
    path: url.pathname + url.search, preconditions: Object.fromEntries(fingerprintPreconditions.map(name => [name, c.req.header(name) ?? null])),
    body_sha256: bodyHash });
  if (record) {
    if (!/^[a-f0-9]{64}$/.test(record.request_hash)) return fingerprintUnavailable();
    if (!await verifyHmac(signingKey, message, base64url(fromHex(record.request_hash)))) {
      throw new ApiError(409, 'idempotency_conflict', 'This idempotency key was used with a different request.');
    }
    return { hash: record.request_hash, keyId };
  }
  return { hash: hex(fromBase64url(await hmac(signingKey, message))), keyId };
}

// This delay limits duplicate work; the generation CAS, not this clock, fences it.
const requestLeaseMilliseconds = 30_000;
const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const policySchema = z.array(z.object({
  capability: z.string().min(1).max(100),
  scope: z.object({ repo_id: z.string().optional(), account_id: z.string().optional(),
    ref: z.string().optional(), paths: z.array(z.string()).optional() }).strict(),
  repo_id: z.string().nullable(), account_id: z.string().nullable(),
  policy_revision: z.number().int().nullable(), account_policy_revision: z.number().int().nullable(),
  routing_epoch: z.number().int().nullable(),
  repository_revision: z.number().int().nullable().optional(),
}).strict()).max(32);

function supportsIdempotency(c: AppContext, options: RouteOptions): boolean {
  return options.idempotent !== false && !options.streaming && mutationMethods.has(c.req.method)
    && !!c.get('principal') && !c.req.path.startsWith('/v1/auth/');
}

function storedPolicies(record: IdempotencyRecord | null): RequestPolicy[] {
  if (!record) return [];
  try { return policySchema.parse(JSON.parse(record.policy_json)); }
  catch { throw new ApiError(503, 'idempotency_policy_unavailable', 'GitKnot could not verify this request’s authorization context.'); }
}

function inferredAuthorization(c: AppContext, definition: RouteDefinition, record: IdempotencyRecord | null): RequestAuthorization[] {
  if (!definition.capability) return [];
  const pattern = definition.path.split('/');
  const parameters = c.req.param();
  const body = c.get('input');
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  const pathId = pattern[3]?.startsWith(':') ? parameters[pattern[3].slice(1)] : undefined;
  let scope: RequestAuthorization['scope'] | undefined;
  if (pattern[2] === 'repos' && pathId) scope = { repo_id: pathId };
  else if (['accounts', 'orgs'].includes(pattern[2]) && pathId) scope = { account_id: pathId };
  else if (typeof input.repo_id === 'string') scope = { repo_id: input.repo_id };
  else if (typeof input.account_id === 'string') scope = { account_id: input.account_id };
  else if (typeof input.owner_id === 'string') scope = { account_id: input.owner_id };
  else if (record?.repo_id) scope = { repo_id: record.repo_id };
  else if (record?.account_id) scope = { account_id: record.account_id };
  return scope ? [{ capability: definition.capability, scope }] : [];
}

async function admission(c: AppContext, definition: RouteDefinition, record: IdempotencyRecord | null) {
  const authority = await captureMutationAuthority(c);
  authority.capability = definition.capability;
  const resolvers = [...new Set([definition.authorization, definition.idempotency?.authorization].filter(value => value !== undefined))];
  const resolved = resolvers.length ? (await Promise.all(resolvers.map(resolve => resolve(c, record)))).flat()
    : inferredAuthorization(c, definition, record);
  // A deployment or resource move cannot silently weaken an earlier request's
  // policy. Reevaluate its original requirements as well as the current ones.
  const requirements = new Map<string, RequestAuthorization>();
  for (const { capability, scope } of [...storedPolicies(record), ...resolved]) {
    const value = { capability, scope: Object.fromEntries(Object.entries(scope).filter(([, entry]) => entry !== undefined)) };
    requirements.set(canonicalJson(value), value);
  }
  await requestPolicies(c, [...requirements.values()]);
  return { credential_versions: authority.credential_versions, policies: authority.policies };
}

function pending(c: AppContext, reconciling = false): never {
  c.header('retry-after', '2');
  throw new ApiError(409, reconciling ? 'idempotency_reconciling' : 'idempotency_in_progress',
    'GitKnot is reconciling the existing request. Retry with the same idempotency key.');
}

function requestAuthority(c: AppContext): D1Database {
  return requestDatabaseBinding(c);
}

async function initialRequestScope(c: AppContext, authority: D1Database, policies: RequestPolicy[]): Promise<{ repo_id: string | null; account_id: string | null }> {
  const repoId = selectedRepositoryScope(c);
  const policy = repoId ? policies.find(value => value.repo_id === repoId) : policies.find(value => !value.repo_id);
  if (policy?.account_id) return { repo_id: repoId, account_id: policy.account_id };
  const repository = repoId ? await one<{ owner_id: string }>(authority.withSession('first-primary'), 'SELECT owner_id FROM repositories WHERE id=?', repoId) : null;
  return { repo_id: repoId, account_id: repository?.owner_id ?? null };
}

function readRecord(authority: D1Database, principalId: string, key: string): Promise<FingerprintedRequest | null> {
  return one(authority.withSession('first-primary'), 'SELECT * FROM idempotency_keys WHERE principal_id=? AND key=?', principalId, key);
}

function matchesPath(pattern: string, path: string): boolean {
  const parts = pattern.split('/');
  const values = path.split('/');
  return parts.length === values.length && parts.every((part, index) => /^:[a-zA-Z0-9_]+$/.test(part) ? !!values[index] : part === values[index]);
}

function readPath(app: App, c: AppContext, value: string | null | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try { url = new URL(value, c.req.url); } catch { return null; }
  if (url.origin !== new URL(c.req.url).origin || url.search || url.hash) return null;
  return apiRoutes(app).some(route => route.method === 'GET' && !route.streaming && !route.sensitive && matchesPath(route.path, url.pathname))
    ? url.pathname : null;
}

function inferredReadPath(app: App, c: AppContext, definition: RouteDefinition, record: IdempotencyRecord): string | null {
  const saved = readPath(app, c, record.recovery_path);
  if (saved) return saved;
  const id = record.resource_id;
  if (!id) return null;
  // Asynchronous creations have an explicit, independently authorized operation resource.
  if (id.startsWith('op_')) {
    const operation = readPath(app, c, `/v1/operations/${encodeURIComponent(id)}`);
    if (operation) return operation;
  }
  const pattern = definition.path.split('/');
  const actual = new URL(c.req.url).pathname.split('/');
  const parameters = c.req.param();
  const candidates: { path: string; score: number }[] = [];
  for (const target of apiRoutes(app)) {
    if (target.method !== 'GET' || target.streaming || target.sensitive) continue;
    const parts = target.path.split('/');
    if (!parts.at(-1)!.startsWith(':')) {
      if (definition.method !== 'POST' && matchesPath(target.path, actual.join('/'))) candidates.push({ path: actual.join('/'), score: parts.length * 10 });
      continue;
    }
    const collection = parts.at(-2)!;
    if (collection === 'repos' && id !== record.repo_id || ['accounts', 'orgs'].includes(collection) && id !== record.account_id) continue;
    const prefix = parts.slice(0, -1).every((part, index) => part.startsWith(':') ? pattern[index]?.startsWith(':') : part === pattern[index]);
    const sameCollection = pattern.some(part => !part.startsWith(':') && part.replace(/s$/, '') === collection.replace(/s$/, ''));
    if (!prefix && !sameCollection) continue;
    const materialized = parts.map((part, index) => {
      if (!part.startsWith(':')) return part;
      if (index === parts.length - 1) return encodeURIComponent(id);
      const parameter = parameters[part.slice(1)];
      const value = prefix ? actual[index] : parameter ? encodeURIComponent(parameter) : undefined;
      return value || null;
    });
    if (materialized.some(part => part === null)) continue;
    candidates.push({ path: materialized.join('/'), score: parts.length * 10 + Number(prefix) });
  }
  return candidates.sort((a, b) => b.score - a.score)[0]?.path ?? null;
}

async function verifiedCommit(authority: D1Database, record: IdempotencyRecord): Promise<void> {
  const proof = await one(authority.withSession('first-primary'), `SELECT e.id FROM outbox e JOIN audit_log a ON a.id=?
    WHERE e.id=? AND e.resource_id=? AND a.resource_id=e.resource_id AND a.resource_revision=e.resource_revision`,
  record.audit_id, record.event_id, record.resource_id);
  if (!proof) throw new ApiError(503, 'idempotency_recovery_unavailable', 'GitKnot could not verify this request’s committed outcome. Retry with the same key.');
}

async function recoveredResponse(c: AppContext, response: Response, status = response.status): Promise<Response> {
  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) c.header('retry-after', retryAfter);
    // This is a current GET/adapter error, never an earlier request's cached error.
    let error: { code?: string; message?: string; details?: unknown } | undefined;
    try { error = (JSON.parse(new TextDecoder().decode(await readBounded(response.body, 64 * 1024))) as { error?: typeof error }).error; }
    catch { /* Keep failed or non-JSON recovery responses within the public error contract. */ }
    return errorResponse(new ApiError(response.status, error?.code ?? 'idempotency_recovery_unavailable',
      error?.message ?? 'GitKnot could not retrieve the current result of this request.', error?.details), c);
  }
  const headers = new Headers(response.headers);
  headers.delete('set-cookie');
  headers.set('idempotency-replayed', 'true');
  headers.set('x-gitknot-request-id', c.get('requestId'));
  headers.set('cache-control', 'no-store');
  if ([204, 205, 304].includes(status)) {
    void response.body?.cancel().catch(() => undefined);
    headers.delete('content-length');
  }
  return c.newResponse([204, 205, 304].includes(status) ? null : response.body, { status: status as StatusCode, headers });
}

async function recoverGet(app: App, c: AppContext, path: string, record: IdempotencyRecord): Promise<Response> {
  const approved = readPath(app, c, path);
  if (!approved) throw new ApiError(503, 'idempotency_recovery_unavailable', 'This request’s resource recovery endpoint is unavailable.');
  const headers = new Headers();
  for (const name of ['authorization', 'cookie', 'origin']) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  // Reenter the real read route: current authentication, lifecycle, indirect
  // ownership, fork audiences and output/backup authorization all run normally.
  let context: AppContext['executionCtx'] | undefined;
  try { context = c.executionCtx; } catch { /* Standalone Hono requests have no execution context. */ }
  const response = await app.fetch(new Request(new URL(approved, c.req.url), { headers }), c.env, context);
  const originalStatus = record.response_status;
  const status = originalStatus && originalStatus >= 200 && originalStatus < 300 ? originalStatus
    : approved.startsWith('/v1/operations/') ? 202 : c.req.method === 'POST' ? 201 : 200;
  return recoveredResponse(c, response, status);
}

async function replay(app: App, c: AppContext, record: IdempotencyRecord, definition: RouteDefinition, authority: D1Database): Promise<Response> {
  if (record.committed_at) await verifiedCommit(authority, record);
  if (!record.replayable && (record.strategy !== 'external' || record.status === 'complete')) return oneTimeIssued();
  const recovery = record.strategy === 'legacy' ? undefined : definition.idempotency?.recover;
  if (recovery) {
    const result = await recovery(c, record);
    if (!record.replayable) {
      if (result instanceof Response) {
        try {
          if (result.ok && result.status !== 202) await finishIdempotency(app, c, result, definition);
        } finally { void result.body?.cancel().catch(() => undefined); }
      }
      return oneTimeIssued();
    }
    if (typeof result === 'string') {
      if (record.strategy === 'external') throw new ApiError(503, 'idempotency_recovery_unavailable', 'The external operation requires a definitive adapter receipt.');
      return recoverGet(app, c, result, record);
    }
    if (result) return recoveredResponse(c, result);
    return pending(c, true);
  }
  // External work is never restarted or declared complete from a D1 progress
  // event. Its adapter must reconcile its own durable operation identity.
  if (record.strategy === 'external') return pending(c, true);
  const path = inferredReadPath(app, c, definition, record);
  if (path) return recoverGet(app, c, path, record);
  if (!record.committed_at && (!record.response_status || record.response_status >= 400)) {
    throw new ApiError(409, 'idempotency_recovery_required', 'The earlier attempt has no fenced completion receipt. Its outcome must be reconciled before another operation can start.');
  }
  throw new ApiError(409, 'idempotency_result_available', 'The operation was already accepted. Retrieve its current resource instead.');
}

function installContext(c: AppContext, definition: RouteDefinition, authority: D1Database, record: Pick<IdempotencyRecord,
  'principal_id' | 'key' | 'request_hash' | 'generation' | 'attempt_id' | 'strategy' | 'operation_id' | 'replayable'>,
decision: Awaited<ReturnType<typeof admission>>): void {
  c.set('idempotency', { key: record.key, principal_id: record.principal_id, request_hash: record.request_hash,
    generation: record.generation, attempt_id: record.attempt_id ?? '', strategy: record.strategy === 'external' ? 'external' : 'mutation',
    operation_id: record.operation_id, authority, ...decision, capability: definition.capability,
    sensitive: !!definition.sensitive || !record.replayable, recovering: false });
}

async function beginIdempotency(app: App, c: AppContext, definition: RouteDefinition): Promise<Response | null> {
  const key = c.req.header('idempotency-key');
  if (!key || !supportsIdempotency(c, definition)) return null;
  if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new ApiError(400, 'invalid_idempotency_key', 'Use 1–128 visible ASCII characters for Idempotency-Key.');
  if (c.req.raw.body && !isJsonMediaType(c.req.header('content-type'))) throw new ApiError(415, 'json_required', 'Idempotent request bodies must use a JSON media type.');
  const actor = requirePrincipal(c);
  // This unkeyed intermediate is transient and is never written to metadata.
  const bodyHash = await sha256(await bodyBytes(c));
  const authority = requestAuthority(c);
  const strategy = definition.idempotency?.strategy ?? 'mutation';
  for (let race = 0; race < 3; race++) {
    const record = await readRecord(authority, actor.id, key);
    const decision = await admission(c, definition, record);
    const { hash, keyId } = await requestFingerprint(c, key, bodyHash, record);
    if (record) {
      if (record.strategy !== 'legacy' && strategy !== record.strategy) {
        throw new ApiError(409, 'idempotency_strategy_changed', 'This request must be reconciled using its original execution strategy.');
      }
      if (record.committed_at || record.strategy === 'external' || record.strategy === 'legacy' || record.resource_id || record.event_id || record.status === 'complete') {
        if (record.strategy !== 'legacy') {
          installContext(c, definition, authority, record, decision);
          c.get('idempotency')!.recovering = true;
        }
        return replay(app, c, record, definition, authority);
      }
      if (record.expires_at <= now()) throw new ApiError(409, 'idempotency_key_expired', 'This request key expired. Verify its outcome before starting a new operation.');
      if (record.status === 'pending' && record.lease_expires_at && record.lease_expires_at > now()) return pending(c);
    }
    const attempt = newId('attempt');
    const timestamp = now();
    const lease = new Date(Date.now() + requestLeaseMilliseconds).toISOString();
    const operation = record?.operation_id ?? (strategy === 'external' ? newId('op') : null);
    const scope = await initialRequestScope(c, authority, decision.policies);
    const result = record
      ? await execute(authority, `UPDATE idempotency_keys SET generation=generation+1,attempt_id=?,status='pending',lease_expires_at=?,
          policy_json=?,updated_at=?,repo_id=COALESCE(repo_id,?),account_id=COALESCE(account_id,?) WHERE principal_id=? AND key=? AND request_hash=? AND generation=? AND attempt_id IS ?
          AND strategy='mutation' AND status IN ('pending','uncertain') AND committed_at IS NULL AND event_id IS NULL AND resource_id IS NULL`,
        attempt, lease, canonicalJson(decision.policies), timestamp, scope.repo_id, scope.account_id, actor.id, key, hash, record.generation, record.attempt_id)
      : await execute(authority, `INSERT INTO idempotency_keys(principal_id,key,request_hash,strategy,generation,attempt_id,lease_expires_at,
          operation_id,policy_json,replayable,created_at,updated_at,expires_at,repo_id,account_id,fingerprint_version,fingerprint_key_id)
          VALUES (?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(principal_id,key) DO NOTHING`,
        actor.id, key, hash, strategy, attempt, lease, operation, canonicalJson(decision.policies), definition.sensitive ? 0 : 1,
        timestamp, timestamp, new Date(Date.now() + 30 * 86400_000).toISOString(), scope.repo_id, scope.account_id, fingerprintVersion, keyId);
    if (!result.meta.changes) continue;
    installContext(c, definition, authority, { principal_id: actor.id, key, request_hash: hash, strategy,
      generation: (record?.generation ?? 0) + 1, attempt_id: attempt, operation_id: operation,
      replayable: record?.replayable ?? (definition.sensitive ? 0 : 1) }, decision);
    return null;
  }
  return pending(c);
}

function oneTimeIssued(): never {
  throw new ApiError(409, 'one_time_value_already_issued',
    'This request may already have issued a one-time credential. Inspect and rotate the existing credential if its value was not received.');
}

function assertRequestGeneration(record: IdempotencyRecord | null, request: IdempotencyContext): asserts record is IdempotencyRecord {
  if (!record || record.generation !== request.generation || record.attempt_id !== request.attempt_id) {
    throw new ApiError(409, 'idempotency_request_superseded', 'This request generation can no longer complete. Retry with the same idempotency key.');
  }
}

async function finishIdempotency(app: App, c: AppContext, response: Response, definition: RouteDefinition): Promise<void> {
  const request = c.get('idempotency');
  if (!request) return;
  if (request.recovering && !response.ok) return;
  const record = await readRecord(request.authority, request.principal_id, request.key);
  assertRequestGeneration(record, request);
  if (record.status === 'complete') return;
  if (!response.ok) {
    // No errors are cached. A later guarded generation reruns authorization and
    // validation; an external adapter reconciles the original operation instead.
    const result = await execute(request.authority, `UPDATE idempotency_keys SET status='uncertain',response_body=NULL,lease_expires_at=?,updated_at=?
      WHERE principal_id=? AND key=? AND request_hash=? AND generation=? AND attempt_id=? AND status<>'complete'`,
    now(), now(), request.principal_id, request.key, request.request_hash, request.generation, request.attempt_id);
    if (!result.meta.changes) assertRequestGeneration(await readRecord(request.authority, request.principal_id, request.key), request);
    return;
  }
  const sensitive = request.sensitive || response.headers.has('set-cookie');
  const headers: Record<string, string> = {};
  for (const name of sensitive ? [] : ['content-type', 'etag', 'location', 'retry-after']) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  const path = sensitive ? null : readPath(app, c, headers.location) ?? inferredReadPath(app, c, definition, record);
  // Persist only safe, registered resource paths, never a redirect carrying credentials.
  if (headers.location && !readPath(app, c, headers.location)) delete headers.location;
  const pendingExternal = request.strategy === 'external' && response.status === 202;
  const result = await execute(request.authority, `UPDATE idempotency_keys SET status=?,response_status=?,response_body=NULL,
    response_headers_json=?,recovery_path=?,replayable=MIN(replayable,?),updated_at=?
    WHERE principal_id=? AND key=? AND request_hash=? AND generation=? AND attempt_id=? AND status<>'complete'`,
  pendingExternal ? 'uncertain' : 'complete', response.status, JSON.stringify(headers), path, sensitive ? 0 : 1,
  now(), request.principal_id, request.key, request.request_hash, request.generation, request.attempt_id);
  if (!result.meta.changes) assertRequestGeneration(await readRecord(request.authority, request.principal_id, request.key), request);
}

export function route(app: App, method: string, path: string, options: RouteOptions, handler: Handler<AppEnv>): void {
  const normalizedMethod = method.toUpperCase();
  if (options.idempotency?.strategy === 'external' && (!(options.authorization || options.idempotency.authorization) || !options.idempotency.recover)) {
    throw new TypeError(`External request recovery requires authorization and a durable-operation reconciler: ${normalizedMethod} ${path}`);
  }
  const registered = definitions.get(app) ?? [];
  const signature = path.replace(/:[a-zA-Z0-9_]+/g, ':parameter');
  if (registered.some(existing => existing.method === normalizedMethod && existing.path.replace(/:[a-zA-Z0-9_]+/g, ':parameter') === signature)) {
    throw new Error(`Duplicate API route: ${normalizedMethod} ${path}`);
  }
  const definition = { ...options, method: normalizedMethod, path };
  registered.push(definition);
  definitions.set(app, registered);
  app.on(normalizedMethod, path, async (c, next) => {
    const cleanup = repositoryCleanupRequest(c.req.raw);
    // Capture the credential before consuming JSON or an arbitrarily slow stream.
    if (mutationMethods.has(c.req.method) && !cleanup) await captureMutationAuthority(c);
    if (options.body) await jsonBody(c, options.body);
    let result: Response;
    try {
      const existing = await beginIdempotency(app, c, definition);
      if (existing) result = existing;
      else {
        if (mutationMethods.has(c.req.method) && !cleanup && !c.get('idempotency')) await admission(c, definition, null);
        const response = await handler(c, next);
        result = response instanceof Response ? response : c.res;
      }
    } catch (error) {
      result = errorResponse(error, c);
    }
    try { await finishIdempotency(app, c, result, definition); }
    catch (error) {
      if (error instanceof ApiError && error.code === 'idempotency_request_superseded') return errorResponse(error, c);
      console.error(JSON.stringify({ event: 'idempotency.finalization_failed', request_id: c.get('requestId'), diagnostic: diagnostic(error) }));
    }
    return result;
  });
}

const schemaDataKeywords = new Set(['example', 'examples', 'default', 'const', 'enum']);
const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** JSON Schema resources with an explicit $id already establish their own scope. */
function scopedSchema(value: unknown, reference: string, anchorPrefix: string, map = false): unknown {
  if (Array.isArray(value)) return value.map(item => scopedSchema(item, reference, anchorPrefix));
  if (!object(value) || !map && typeof value.$id === 'string') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (map) return [key, scopedSchema(child, reference, anchorPrefix)];
    if (schemaDataKeywords.has(key)) return [key, child];
    if (['$ref', '$dynamicRef'].includes(key) && typeof child === 'string' && child.startsWith('#')) {
      const fragment = decodeURIComponent(child.slice(1));
      if (fragment.startsWith('/components/')) return [key, child];
      return [key, !fragment || fragment.startsWith('/') ? reference + child.slice(1) : `#${anchorPrefix}${child.slice(1)}`];
    }
    if (['$anchor', '$dynamicAnchor'].includes(key) && typeof child === 'string') return [key, anchorPrefix + child];
    return [key, scopedSchema(child, reference, anchorPrefix, schemaMaps.has(key))];
  }));
}

function hasSchemaLocalReference(value: unknown, map = false): boolean {
  if (Array.isArray(value)) return value.some(item => hasSchemaLocalReference(item));
  if (!object(value) || !map && typeof value.$id === 'string') return false;
  return Object.entries(value).some(([key, child]) => {
    if (map) return hasSchemaLocalReference(child);
    if (schemaDataKeywords.has(key)) return false;
    if (['$ref', '$dynamicRef'].includes(key) && typeof child === 'string') return child.startsWith('#') && !decodeURIComponent(child.slice(1)).startsWith('/components/');
    return hasSchemaLocalReference(child, schemaMaps.has(key));
  });
}

function schemaComponents() {
  const schemas: Record<string, unknown> = {};
  function register(schema: Record<string, unknown>, hint: string): Record<string, string> {
    const base = `GitKnot_${hint.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    let name = base;
    for (let suffix = 2; Object.hasOwn(schemas, name); suffix++) name = `${base}_${suffix}`;
    const reference = `#/components/schemas/${name}`;
    schemas[name] = scopedSchema(schema, reference, `${name}__`);
    return { $ref: reference };
  }
  function fromZod(schema: z.ZodType, hint: string, io: 'input' | 'output'): Record<string, string> {
    const { $schema: dialect, ...result } = z.toJSONSchema(schema, { target: 'draft-2020-12', io });
    void dialect;
    return register(result, hint);
  }
  function metadata(value: unknown, hint: string, examples = false): unknown {
    if (Array.isArray(value)) return value.map((item, index) => metadata(item, `${hint}_${index}`));
    if (!object(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => {
      if (key === 'example' || examples && key === 'value') return [key, child];
      // Preserve the supplied media type, headers, encoding, descriptions and
      // response codes; only relocate an embedded schema that needs a local root.
      if (key === 'schema') return [key, object(child) && hasSchemaLocalReference(child) ? register(child, `${hint}_Schema`) : child];
      if (key === 'examples' && object(child)) return [key, Object.fromEntries(Object.entries(child).map(([name, example]) =>
        [name, metadata(example, `${hint}_Example_${name}`, true)]))];
      return [key, metadata(child, `${hint}_${key}`)];
    }));
  }
  return { schemas, fromZod, metadata };
}

function pointerTarget(root: unknown, fragment: string): unknown {
  const pointer = decodeURIComponent(fragment.slice(1));
  if (!pointer) return root;
  if (!pointer.startsWith('/')) return undefined;
  let target = root;
  for (const encoded of pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/.test(encoded)) return undefined;
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (target === null || typeof target !== 'object' || !Object.hasOwn(target, key)) return undefined;
    target = (target as Record<string, unknown>)[key];
  }
  return target;
}

/** Reject a broken public contract instead of publishing unresolved local references. */
function assertLocalReferences(document: Record<string, unknown>): void {
  type Kind = 'openapi' | 'schema' | 'schema-map' | 'examples' | 'example';
  const references: { root: Record<string, unknown>; reference: string }[] = [];
  const anchors = new Map<Record<string, unknown>, Map<string, unknown>>();
  const pending: { value: unknown; root: Record<string, unknown>; kind: Kind }[] = [{ value: document, root: document, kind: 'openapi' }];
  while (pending.length) {
    const { value, root: enclosing, kind } = pending.pop()!;
    if (Array.isArray(value)) { pending.push(...value.map(value => ({ value, root: enclosing, kind }))); continue; }
    if (!object(value)) continue;
    if (kind === 'schema-map' || kind === 'examples') {
      pending.push(...Object.values(value).map(value => ({ value, root: enclosing, kind: kind === 'schema-map' ? 'schema' as const : 'example' as const })));
      continue;
    }
    const root = kind === 'schema' && typeof value.$id === 'string' ? value : enclosing;
    for (const [key, child] of Object.entries(value)) {
      if (kind === 'schema' && schemaDataKeywords.has(key) || kind === 'example' && key === 'value' || kind === 'openapi' && key === 'example') continue;
      if (['$anchor', '$dynamicAnchor'].includes(key) && typeof child === 'string') {
        const entries = anchors.get(root) ?? new Map<string, unknown>();
        if (entries.has(child) && entries.get(child) !== value) throw new Error(`Ambiguous OpenAPI schema anchor: #${child}`);
        entries.set(child, value);
        anchors.set(root, entries);
      }
      if (['$ref', '$dynamicRef'].includes(key) && typeof child === 'string' && child.startsWith('#')) references.push({ root, reference: child });
      const nextKind: Kind = kind === 'schema' ? schemaMaps.has(key) ? 'schema-map' : 'schema'
        : key === 'schema' ? 'schema' : key === 'schemas' ? 'schema-map' : key === 'examples' ? 'examples' : 'openapi';
      pending.push({ value: child, root, kind: nextKind });
    }
  }
  for (const { root, reference } of references) {
    const fragment = decodeURIComponent(reference.slice(1));
    const target = !fragment || fragment.startsWith('/') ? pointerTarget(root, reference) : anchors.get(root)?.get(fragment);
    if (target === undefined) throw new Error(`Unresolved local OpenAPI reference: ${reference}`);
  }
}

function operationId(route: RouteDefinition): string {
  return route.operationId ?? `${route.method.toLowerCase()}_${route.path.replace(/^\/v1\//, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/_$/, '')}`;
}

export function apiRoutes(app: App): ReadonlyArray<RouteDefinition> {
  return definitions.get(app) ?? [];
}

export function openApiDocument(app: App, origin = 'https://api.gitknot.com'): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const components = schemaComponents();
  for (const definition of apiRoutes(app)) {
    const id = operationId(definition);
    const path = definition.path.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');
    const parameters: Record<string, unknown>[] = Array.from(path.matchAll(/\{([^}]+)\}/g), match => ({
      name: match[1], in: 'path', required: true, schema: { type: 'string' },
    }));
    if (definition.method === 'GET' && !definition.streaming) parameters.push(
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 } },
      { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Opaque pagination cursor from next_cursor.' },
    );
    if (['PATCH', 'PUT', 'DELETE'].includes(definition.method)) parameters.push({
      name: 'If-Match', in: 'header', schema: { type: 'string' }, description: 'Strong ETag of the revision being changed.',
    });
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(definition.method) && definition.idempotent !== false
      && !definition.streaming && !definition.path.startsWith('/v1/auth/')) parameters.push({
      name: 'Idempotency-Key', in: 'header', schema: { type: 'string', maxLength: 128 },
      description: 'Retry key bound to the principal, exact body and preconditions for 30 days. Recovery returns the currently authorized resource representation; response bodies and one-time credentials are not cached. External operations retain their original operation identity.',
    });
    const responseSchema = definition.response ? components.fromZod(definition.response, `${id}_Response`, 'output') : { type: 'object', additionalProperties: true };
    const success = { description: 'Successful request. Resource reads and mutations include an ETag where revisioned.',
      headers: { 'X-GitKnot-Request-ID': { schema: { type: 'string' } }, ETag: { schema: { type: 'string' } } },
      content: definition.streaming
        ? { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } }
        : { 'application/json': { schema: responseSchema } } };
    paths[path] ??= {};
    paths[path][definition.method.toLowerCase()] = {
      operationId: id, summary: definition.summary,
      ...(definition.description ? { description: definition.description } : {}),
      tags: definition.tags ?? [definition.path.split('/')[2] ?? 'platform'],
      security: definition.public ? [] : [{ bearerAuth: [] }, { sessionCookie: [] }],
      parameters: [...parameters, ...components.metadata(definition.parameters ?? [], `${id}_Parameters`) as Record<string, unknown>[]],
      ...(definition.capability ? { 'x-gitknot-capability': definition.capability } : {}),
      ...(definition.requestBody ? { requestBody: components.metadata(definition.requestBody, `${id}_Request`) }
        : definition.body ? { requestBody: { required: true, content: { 'application/json': { schema: components.fromZod(definition.body, `${id}_Request`, 'input') } } } } : {}),
      responses: { '200': success, ...(definition.method === 'POST' ? { '201': success, '202': { ...success, description: 'Accepted; follow the returned operation resource.' } } : {}),
        '400': { $ref: '#/components/responses/Error' }, '401': { $ref: '#/components/responses/Error' },
        '403': { $ref: '#/components/responses/Error' }, '404': { $ref: '#/components/responses/Error' },
        '409': { $ref: '#/components/responses/Error' }, '412': { $ref: '#/components/responses/Error' },
        '422': { $ref: '#/components/responses/Error' }, '428': { $ref: '#/components/responses/Error' },
        '429': { $ref: '#/components/responses/RateLimited' }, '503': { $ref: '#/components/responses/Error' },
        ...components.metadata(definition.responses ?? {}, `${id}_Responses`) as Record<string, unknown> },
    };
  }
  const document = {
    openapi: '3.1.0', jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: { title: 'GitKnot API', version: '1.0.0', description: 'GitKnot accounts, repositories, collaboration, verification, and usage. All timestamps are UTC RFC3339. Native SSH is a later transport extension.',
      contact: { name: 'GitKnot support', url: 'https://gitknot.com/support' } },
    servers: [{ url: origin }], paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, sessionCookie: { type: 'apiKey', in: 'cookie', name: '__Host-gitknot_session' } },
      schemas: { ...components.schemas, Error: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message', 'request_id'], properties: {
        code: { type: 'string' }, message: { type: 'string' }, request_id: { type: 'string' }, details: {},
      } } } } },
      responses: {
        Error: { description: 'Structured GitKnot error. Private resources may return 404 to protect their existence.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        RateLimited: { description: 'Request rate or admission capacity exceeded. Retry after the specified number of seconds.', headers: { 'Retry-After': { schema: { type: 'integer', minimum: 1 } } }, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    },
  };
  assertLocalReferences(document);
  return document;
}
