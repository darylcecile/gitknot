import { ApiError, canonicalJson, hmac, randomToken, readBounded, sha256, signInternalRequest, verifyHmac, verifyInternalRequest } from '@gitknot/core';
import type { PlanJob, CompletionReceipt } from '../types.ts';
import type { ToolchainDescriptor } from '@gitknot/workflows';
import { z } from 'zod';

export const REMOTE_HOSTED_SCOPE = 'hosted-execution.v1';
export const REMOTE_CALLBACK_SCOPE = 'hosted-callback.v1';

/** Immutable execution capability. It contains no tenant ACL, SQL, or platform key. */
export interface RemoteAttemptGrant {
  version: 1;
  executor_id: string;
  attempt_id: string;
  generation: number;
  run_id: string;
  job_id: string;
  repo_id: string;
  account_id: string;
  plan_digest: string;
  workflow_digest: string;
  policy_revision: number;
  commit_sha: string;
  source_ref: string;
  producer_id: string;
  runtime_name: string;
  runtime_id: string;
  deadline_at: string;
  lease_expires_at: string;
  job: PlanJob;
  toolchain: ToolchainDescriptor;
  callback: { origin: string; token: string };
}

export interface RemoteRuntimeStatus {
  version: 1;
  executor_id: string;
  producer_id: string;
  deadline_at: string;
  attempt_id: string;
  generation: number;
  grant_digest: string;
  runtime_id: string;
  sandbox_id: string;
  state: 'accepted' | 'claiming' | 'running' | 'stopping' | 'destroyed' | 'failed';
  accepted_at: string;
  started_at: string | null;
  destroyed_at: string | null;
  sealed: boolean;
  running: boolean | null;
  in_flight: number;
  ephemeral_objects: number;
  egress_requests: number;
  egress_bytes: number;
  receipt_id: string | null;
  challenge: string;
}

export interface SignedRemoteStatus { status: RemoteRuntimeStatus; signature: string }
export interface RemoteInput {
  reference: string;
  object_id: string;
  type: 'artifact' | 'string' | 'number' | 'boolean' | 'json';
  sha256: string;
  size_bytes: number;
}
export interface RemoteCache {
  snapshot: { id: string; dir: string; localBucket: true };
  archive: { object_id: string; sha256: string; size_bytes: number };
  metadata: { object_id: string; sha256: string; size_bytes: number };
  expires_at: string;
}
export interface RemoteBeginResult {
  execute: boolean;
  status: string;
  lease_expires_at?: string;
  source?: { url: string; commit: string; token: string };
  inputs?: RemoteInput[];
}
export interface RemoteStoredObject { id: string; sha256: string; source_digest: string | null; size_bytes: number }
export interface RemoteSnapshotCommit {
  snapshot: RemoteCache['snapshot'];
  archive_object_id: string;
  metadata_object_id: string;
  cache_key: string | null;
}
export type RemoteCompletion = CompletionReceipt;

export function requireRemoteOrigin(origin: string, allowLoopback = false): string {
  let url: URL;
  try { url = new URL(origin); } catch { throw new ApiError(503, 'remote_origin_invalid', 'The remote execution origin is invalid.'); }
  const local = allowLoopback && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new ApiError(503, 'remote_origin_invalid', 'Remote execution requires an authenticated HTTPS origin.');
  return url.origin;
}

export function remoteRuntimeId(executorId: string, attemptId: string, generation: number): string {
  return `remote:${executorId}:${attemptId}:${generation}`;
}

export function grantDigest(grant: RemoteAttemptGrant): Promise<string> { return sha256(canonicalJson(grant)); }

export async function signRemoteRequest(request: Request, key: string): Promise<Request> {
  return signInternalRequest(request, key, REMOTE_HOSTED_SCOPE);
}
export async function verifyRemoteRequest(request: Request, key: string): Promise<void> {
  await verifyInternalRequest(request, key, REMOTE_HOSTED_SCOPE);
}
export async function signCallbackRequest(request: Request, token: string): Promise<Request> {
  const time = String(Math.floor(Date.now() / 1000)), nonce = randomToken(24);
  const digest = request.headers.get('x-gitknot-content-sha256') ?? await sha256(await readBounded(request.clone().body, 4 * 1024 * 1024));
  if (!/^[a-f0-9]{64}$/.test(digest) || token.length < 32) throw new ApiError(401, 'callback_signature_invalid', 'A bounded callback capability and body checksum are required.');
  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${token}`);
  headers.set('x-gitknot-content-sha256', digest);
  headers.set('x-gitknot-callback-time', time);
  headers.set('x-gitknot-callback-nonce', nonce);
  headers.set('x-gitknot-callback-signature', await hmac(token, callbackSignatureInput(request, time, nonce, digest)));
  return new Request(request, { headers });
}
export async function verifyCallbackRequest(request: Request, token: string, streaming = false): Promise<void> {
  const time = request.headers.get('x-gitknot-callback-time') ?? '', nonce = request.headers.get('x-gitknot-callback-nonce') ?? '';
  const digest = request.headers.get('x-gitknot-content-sha256') ?? '', signature = request.headers.get('x-gitknot-callback-signature') ?? '';
  if (!/^\d{10,12}$/.test(time) || !/^[A-Za-z0-9_-]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(digest)
    || Math.abs(Date.now() / 1000 - Number(time)) > 60 || !await verifyHmac(token, callbackSignatureInput(request, time, nonce, digest), signature)) {
    throw new ApiError(401, 'callback_signature_invalid', 'The attempt callback signature could not be verified.');
  }
  if (!streaming && await sha256(await readBounded(request.clone().body, 4 * 1024 * 1024)) !== digest) throw new ApiError(401, 'callback_body_changed', 'The callback body changed after signing.');
}

function callbackSignatureInput(request: Request, time: string, nonce: string, digest: string): string {
  const url = new URL(request.url);
  // A separately authenticated cell-route envelope may change routing headers.
  // The end-to-end attempt signature binds the stable URL, method and bytes.
  return [request.method.toUpperCase(), url.host, url.pathname + url.search, REMOTE_CALLBACK_SCOPE, time, nonce, digest].join('\n');
}
export async function signRemoteStatus(status: RemoteRuntimeStatus, key: string): Promise<SignedRemoteStatus> {
  return { status, signature: await hmac(key, `GitKnot hosted status v1\n${canonicalJson(status)}`) };
}
const statusSchema = z.object({ version: z.literal(1), executor_id: z.string().min(1).max(64), producer_id: z.string().min(1).max(192), deadline_at: z.iso.datetime(),
  attempt_id: z.string().min(1).max(128), generation: z.number().int().positive(), grant_digest: z.string().regex(/^[a-f0-9]{64}$/), runtime_id: z.string().min(1).max(256),
  sandbox_id: z.string().regex(/^[a-f0-9]{64}$/), state: z.enum(['accepted', 'claiming', 'running', 'stopping', 'destroyed', 'failed']),
  accepted_at: z.iso.datetime(), started_at: z.iso.datetime().nullable(), destroyed_at: z.iso.datetime().nullable(), sealed: z.boolean(), running: z.boolean().nullable(),
  in_flight: z.number().int().nonnegative(), ephemeral_objects: z.number().int().nonnegative(), egress_requests: z.number().int().nonnegative(), egress_bytes: z.number().int().nonnegative(),
  receipt_id: z.string().min(1).max(256).nullable(), challenge: z.string().min(1).max(256),
});
export async function verifyRemoteStatus(value: SignedRemoteStatus, key: string, expected: Pick<RemoteRuntimeStatus, 'executor_id' | 'producer_id' | 'deadline_at' | 'attempt_id' | 'generation' | 'grant_digest' | 'runtime_id' | 'challenge'>): Promise<RemoteRuntimeStatus> {
  const status = value?.status;
  if (!statusSchema.safeParse(status).success || Object.entries(expected).some(([name, content]) => status[name as keyof RemoteRuntimeStatus] !== content)
    || !await verifyHmac(key, `GitKnot hosted status v1\n${canonicalJson(status)}`, value.signature)) throw new ApiError(502, 'remote_status_unverified', 'The remote runtime returned an unverified lifecycle receipt.');
  return status;
}
