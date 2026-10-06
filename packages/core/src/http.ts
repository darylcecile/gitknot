import type { z } from 'zod';
import type { StatusCode } from 'hono/utils/http-status';
import { ApiError } from './errors.ts';
import { base64url, bytes, canonicalJson, fromBase64url } from './crypto.ts';
import { limits, readBounded } from './limits.ts';
import { currentCredentialChain } from './auth.ts';
import { identityDatabase } from './authority/identity.ts';
import { captureIdentityAuthority } from './authority/guards.ts';
import { authorize, type PermissionExplanation } from './policy.ts';
import type { AppContext, MutationAuthority, Principal, RequestAuthorization, RequestPolicy } from './types.ts';

const requestBodies = new WeakMap<Request, Promise<Uint8Array<ArrayBuffer>>>();
const validatedBodies = new WeakMap<Request, Map<z.ZodType, unknown>>();
const authorityCaptures = new WeakMap<AppContext, Promise<MutationAuthority>>();

export function bodyBytes(c: AppContext): Promise<Uint8Array<ArrayBuffer>> {
  let result = requestBodies.get(c.req.raw);
  if (!result) {
    const maximum = limits(c.env).json_bytes;
    const declared = Number(c.req.header('content-length'));
    if (declared > maximum) throw new ApiError(413, 'payload_too_large', 'The JSON request is too large.');
    const original = c.req.raw;
    result = readBounded(original.body, maximum).then(content => {
      // Keep bounded bytes replayable for Hono parsers and authenticated service forwarding.
      // Reading a tee branch here can otherwise retain an unbounded unread sibling.
      if (original.body) {
        const replay = new Request(original, { body: content });
        c.req.raw = replay;
        requestBodies.set(replay, Promise.resolve(content));
      }
      return content;
    });
    requestBodies.set(original, result);
  }
  return result;
}

export async function jsonBody<S extends z.ZodType>(c: AppContext, schema: S): Promise<z.infer<S>> {
  let value: unknown;
  const cached = validatedBodies.get(c.req.raw);
  if (cached?.has(schema)) return cached.get(schema) as z.infer<S>;
  if (!isJsonMediaType(c.req.header('content-type'))) {
    throw new ApiError(415, 'json_required', 'Use Content-Type: application/json for this request.');
  }
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bodyBytes(c))); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_json', 'The request body must be valid UTF-8 JSON.');
  }
  const parsed = await schema.safeParseAsync(value);
  if (!parsed.success) throw new ApiError(422, 'validation_failed', 'Some fields need your attention.', {
    fields: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code, message: issue.message })),
  });
  const entries = cached ?? new Map<z.ZodType, unknown>();
  entries.set(schema, parsed.data);
  validatedBodies.set(c.req.raw, entries);
  c.set('input', parsed.data);
  return parsed.data;
}

export function isJsonMediaType(value: string | null | undefined): boolean {
  return /^application\/(?:[\w.+-]+\+)?json(?:\s*;|\s*$)/i.test(value ?? '');
}

export function input<T>(c: AppContext): T {
  return c.get('input') as T;
}

export function requirePrincipal(c: AppContext): Principal {
  const principal = c.get('principal');
  if (!principal) throw new ApiError(401, 'authentication_required', 'Sign in to GitKnot to continue.');
  return principal;
}

/** Capture before reading a stream or evaluating policy; never refresh an in-flight grant. */
export function captureMutationAuthority(c: AppContext): Promise<MutationAuthority> {
  const pending = authorityCaptures.get(c);
  if (pending) return pending;
  const existing = c.get('mutation_authority');
  if (existing) return Promise.resolve(existing);
  const principal = structuredClone(c.get('principal') ?? null);
  const capture = (async (): Promise<MutationAuthority> => {
    const chain = principal?.credential_id ? await currentCredentialChain(identityDatabase(c), principal.credential_id) : [];
    const authority: MutationAuthority = { principal, policies: [],
      credential_versions: chain.map(({ id, revision, parent_id, principal_id, user_id, auth_revision }) =>
        ({ id, revision, parent_id, principal_id, user_id, auth_revision })) };
    c.set('mutation_authority', authority);
    await captureIdentityAuthority(c, authority, chain);
    return authority;
  })();
  authorityCaptures.set(c, capture);
  return capture;
}

function authorizationKey(value: RequestAuthorization): string {
  return canonicalJson({ capability: value.capability,
    scope: Object.fromEntries(Object.entries(value.scope).filter(([, entry]) => entry !== undefined)) });
}

/** Retain the earliest decision for every scope, including dependencies with other capabilities. */
export function retainRequestPolicies(authority: MutationAuthority, policies: RequestPolicy[]): void {
  const known = new Set(authority.policies.map(authorizationKey));
  for (const policy of policies) {
    const key = authorizationKey(policy);
    if (known.has(key)) continue;
    if (authority.policies.length >= 32) throw new ApiError(422, 'authorization_scope_limit', 'This mutation exceeds the supported number of authorization scopes.');
    authority.policies.push(structuredClone(policy));
    known.add(key);
  }
}

/** Identity's authorize() records successful decisions here after authority capture. */
export function recordRequestPolicy(c: AppContext, requirement: RequestAuthorization, decision: PermissionExplanation): void {
  const authority = c.get('mutation_authority');
  if (!authority || !decision.allowed || decision.principal_id !== (authority.principal?.id ?? null)) return;
  const scope = Object.fromEntries(Object.entries(requirement.scope).filter(([, value]) => value !== undefined)) as RequestAuthorization['scope'];
  retainRequestPolicies(authority, [{ capability: requirement.capability, scope,
    repo_id: decision.repo_id, account_id: decision.account_id, repository_revision: decision.repository_revision,
    policy_revision: decision.policy_revision, account_policy_revision: decision.account_policy_revision, routing_epoch: decision.routing_epoch }]);
}

/** Freeze the authorization decision that a guarded request's SQL must fence. */
export async function requestPolicies(c: AppContext, requirements: RequestAuthorization[]): Promise<RequestPolicy[]> {
  if (requirements.length > 32) throw new TypeError('A request may bind at most 32 authorization scopes.');
  await captureMutationAuthority(c);
  const policies: RequestPolicy[] = [];
  for (const requirement of requirements) {
    const scope = structuredClone(Object.fromEntries(Object.entries(requirement.scope).filter(([, value]) => value !== undefined))) as RequestAuthorization['scope'];
    const decision = await authorize(c, requirement.capability, scope);
    recordRequestPolicy(c, { capability: requirement.capability, scope }, decision);
    policies.push({ capability: requirement.capability, scope, repo_id: decision.repo_id, account_id: decision.account_id,
      policy_revision: decision.policy_revision, account_policy_revision: decision.account_policy_revision,
      routing_epoch: decision.routing_epoch, repository_revision: decision.repository_revision });
  }
  return policies;
}

export function etag(revision: number | string): string {
  return `"${revision}"`;
}

export function expectedRevision(c: AppContext): number {
  const value = c.req.header('if-match');
  if (!value) throw new ApiError(428, 'precondition_required', 'Send the resource ETag in If-Match to protect concurrent edits.');
  const match = /^"(?:r)?([1-9][0-9]*)"$/.exec(value);
  const revision = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(revision)) throw new ApiError(400, 'invalid_precondition', 'If-Match must contain the current strong resource ETag.');
  return revision;
}

export function page(c: AppContext): { limit: number; cursor: string | null } {
  const raw = c.req.query('limit');
  const limit = raw === undefined ? 30 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > limits(c.env).page_size) {
    throw new ApiError(422, 'invalid_pagination', `limit must be between 1 and ${limits(c.env).page_size}.`);
  }
  const cursor = c.req.query('cursor') ?? null;
  if (cursor !== null && (cursor.length > 2048 || !/^[\w.-]+$/.test(cursor))) {
    throw new ApiError(422, 'invalid_cursor', 'The pagination cursor is invalid.');
  }
  return { limit, cursor };
}

export function encodeCursor(value: Record<string, unknown> | string): string {
  return base64url(bytes(JSON.stringify(value)));
}

export function decodeCursor<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(new TextDecoder().decode(fromBase64url(value))) as T; }
  catch { throw new ApiError(422, 'invalid_cursor', 'The pagination cursor is invalid.'); }
}

export function listResponse<T>(c: AppContext, items: T[], nextCursor: string | null = null): Response {
  if (nextCursor) {
    const url = new URL(c.req.url);
    url.searchParams.set('cursor', nextCursor);
    c.header('link', `<${url.pathname}${url.search}>; rel="next"`);
  }
  return c.json({ items, next_cursor: nextCursor });
}

export function resourceResponse<T extends { revision?: number }>(c: AppContext, value: T, status = 200): Response {
  if (value.revision !== undefined) c.header('etag', etag(value.revision));
  return c.newResponse(JSON.stringify(value), status as StatusCode, { 'content-type': 'application/json; charset=utf-8' });
}
