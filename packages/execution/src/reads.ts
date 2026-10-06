import { Context } from 'hono';
import { ApiError, base64url, bytes, canonicalJson, database, fromBase64url, getRepository, hmac, one, page, requestDatabaseAuthority, requestDatabaseBinding, requestDatabaseLocation, setRequestDatabase, sha256 } from '@gitknot/core';
import type { AppContext, AppEnv } from '@gitknot/core';
import type { ExecutionPlan, RunRecord } from './types.ts';

const deniedStatuses = new Set([401, 403, 404, 410]);

export function executionNotFound(): never {
  throw new ApiError(404, 'not_found', 'The requested resource was not found.');
}

/** Immutable source IDs may be reused; authorization decisions and D1 sessions may not. */
export function freshExecutionReader(c: AppContext): AppContext {
  const fresh = new Context<AppEnv>(new Request(c.req.url), { env: c.env });
  fresh.set('principal', c.get('principal')); fresh.set('requestId', c.get('requestId'));
  setRequestDatabase(fresh, requestDatabaseBinding(c), requestDatabaseAuthority(c));
  return fresh;
}

export function executionAudience(plan: Pick<ExecutionPlan, 'repo_id' | 'source_repo_id' | 'related_repo_ids' | 'trigger' | 'checkout_candidate_id' | 'source_evidence'>): string[] {
  const related = plan.related_repo_ids;
  if (related !== undefined && (!Array.isArray(related) || related.length > 32 || !related.includes(plan.repo_id))) executionNotFound();
  // Legacy same-repository plans are unambiguous. A retained PR/candidate plan
  // without source provenance cannot inherit the audience of today's PR head.
  if (!related && !plan.source_repo_id && (plan.trigger.pull_request_id || plan.checkout_candidate_id)) executionNotFound();
  const evidence = plan.source_evidence;
  if (evidence && (!Array.isArray(evidence.related_repo_ids) || evidence.related_repo_ids.length > 32)) executionNotFound();
  const ids = [...new Set([plan.repo_id, plan.source_repo_id ?? plan.repo_id, ...(related ?? []),
    ...(evidence ? [evidence.source_repo_id, evidence.head_repo_id, ...evidence.related_repo_ids] : [])])];
  if (ids.length > 32 || ids.some(id => typeof id !== 'string' || !/^r_[A-Za-z0-9_-]+$/.test(id))) executionNotFound();
  return ids;
}

export async function authorizeExecutionAudience(c: AppContext, repoId: string, audience: readonly string[], capability: string): Promise<void> {
  if (!audience.includes(repoId) || audience.length > 32) executionNotFound();
  try {
    await getRepository(c, repoId, capability);
    for (const source of audience) if (source !== repoId) await getRepository(c, source, 'contents.read');
  } catch (error) {
    if (error instanceof ApiError && deniedStatuses.has(error.status)) executionNotFound();
    throw error;
  }
}

export async function readRunPlan(run: RunRecord): Promise<ExecutionPlan> {
  if (await sha256(run.plan_json) !== run.plan_digest) executionNotFound();
  let plan: ExecutionPlan;
  try { plan = JSON.parse(run.plan_json) as ExecutionPlan; } catch { executionNotFound(); }
  if (!plan || typeof plan !== 'object' || plan.repo_id !== run.repo_id || plan.account_id !== run.account_id || plan.commit_sha !== run.commit_sha
    || plan.workflow_digest !== run.workflow_digest || plan.workflow_version_id !== run.workflow_version_id || plan.source_ref !== run.source_ref
    || plan.policy_revision !== run.policy_revision || plan.trust !== run.trust || !plan.trigger
    || plan.trigger.id !== run.trigger_id || plan.trigger.type !== run.trigger_type) executionNotFound();
  executionAudience(plan);
  return plan;
}

export async function authorizeRunRead(c: AppContext, run: RunRecord, capability = 'runs.read'): Promise<ExecutionPlan> {
  c.header('cache-control', 'private, no-store');
  const plan = await readRunPlan(run);
  await authorizeExecutionAudience(c, run.repo_id, executionAudience(plan), capability);
  const repository = await getRepository(c, run.repo_id, capability), location = requestDatabaseLocation(c);
  if (repository.cell_id !== location.cell_id || repository.shard_id !== location.shard_id) {
    throw new ApiError(409, 'execution_placement_changed', 'The execution metadata moved. Read its current location again.');
  }
  return plan;
}

export async function authorizedRun(c: AppContext, id: string, capability = 'runs.read'): Promise<RunRecord> {
  const run = await one<RunRecord>(database(c), 'SELECT * FROM workflow_runs WHERE id=?', id);
  if (!run) executionNotFound();
  await authorizeRunRead(c, run, capability);
  return run;
}

export function runReadAuthorizer(c: AppContext, run: RunRecord, capability = 'runs.read'): () => Promise<void> {
  return async () => {
    const current = await authorizedRun(freshExecutionReader(c), run.id, capability);
    if (current.repo_id !== run.repo_id || current.plan_digest !== run.plan_digest) executionNotFound();
  };
}

export function repositoryReadAuthorizer(c: AppContext, repoId: string, capability: string, audience: readonly string[] = [repoId]): () => Promise<void> {
  return async () => {
    const fresh = freshExecutionReader(c);
    await authorizeExecutionAudience(fresh, repoId, audience, capability);
    const repository = await getRepository(fresh, repoId, capability), location = requestDatabaseLocation(c);
    if (requestDatabaseAuthority(c).kind === 'repository' && (repository.cell_id !== location.cell_id || repository.shard_id !== location.shard_id)) {
      throw new ApiError(409, 'execution_placement_changed', 'The execution metadata moved. Read its current location again.');
    }
  };
}

export function authorizedExecutionStream(stream: ReadableStream<Uint8Array>, authorize: () => Promise<void>): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        await authorize();
        const result = await reader.read();
        if (result.done) { reader.releaseLock(); controller.close(); return; }
        await authorize(); // Storage reads can wait across revocation or movement.
        controller.enqueue(result.value);
      } catch (error) {
        try { await reader.cancel(error); } catch { /* Preserve the authorization failure if upstream already closed. */ }
        reader.releaseLock(); controller.error(error);
      }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
  }, { highWaterMark: 0 });
}

export async function executionReadResponse(c: AppContext, response: Response, authorize: () => Promise<void>): Promise<Response> {
  try { await authorize(); }
  catch (error) {
    for (const name of ['etag', 'link', 'location', 'content-length', 'content-digest', 'content-disposition']) c.header(name, undefined);
    try { await response.body?.cancel(); } catch { /* Keep the current-authority failure. */ }
    throw error;
  }
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'private, no-store');
  return new Response(response.body ? authorizedExecutionStream(response.body, authorize) : null, { status: response.status, headers });
}

/** Filtered scans never expose an unreadable resource ID in their continuation. */
async function cursorKey(c: AppContext): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', fromBase64url(await hmac(c.env.INTERNAL_SERVICE_KEY, 'GitKnot execution read cursor v1')), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function cursorScope(c: AppContext, scope: string): Uint8Array<ArrayBuffer> {
  return bytes(canonicalJson({ scope, principal: c.get('principal') ?? null }));
}

async function scanCursor(c: AppContext, scope: string, after: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: cursorScope(c, scope) }, await cursorKey(c),
    bytes(JSON.stringify({ after, expires: Date.now() + 15 * 60_000 })));
  return `ex1.${base64url(iv)}.${base64url(new Uint8Array(ciphertext))}`;
}

async function readScanCursor(c: AppContext, scope: string, cursor: string | null): Promise<string> {
  if (!cursor) return '';
  // Earlier versions returned a caller-visible resource ID as the cursor.
  if (/^(?:run|release|pool|evt)_[A-Za-z0-9_-]+$/.test(cursor)) return cursor;
  try {
    const [version, nonce, encrypted, extra] = cursor.split('.');
    if (version !== 'ex1' || !nonce || !encrypted || extra) throw new Error('cursor');
    const decoded = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64url(nonce), additionalData: cursorScope(c, scope) }, await cursorKey(c), fromBase64url(encrypted));
    const value = JSON.parse(new TextDecoder().decode(decoded)) as { after: string; expires: number };
    if (typeof value.after !== 'string' || value.after.length > 512 || !/^[A-Za-z0-9_.:-]+$/.test(value.after) || !Number.isSafeInteger(value.expires) || value.expires <= Date.now()) throw new Error('cursor');
    return value.after;
  } catch { throw new ApiError(422, 'invalid_cursor', 'This execution cursor expired or belongs to a different reader or collection.'); }
}

export async function visibleExecutionRecord(authorize: () => Promise<unknown>): Promise<boolean> {
  try { await authorize(); return true; }
  catch (error) { if (error instanceof ApiError && deniedStatuses.has(error.status)) return false; throw error; }
}

export async function executionReadPage<T extends { id: string }>(c: AppContext, scope: string,
  fetch: (after: string, limit: number) => Promise<T[]>, visible: (row: T) => Promise<boolean>): Promise<{ items: T[]; next_cursor: string | null }> {
  const pagination = page(c), items: T[] = [];
  let after = await readScanCursor(c, scope, pagination.cursor);
  for (let scanned = 0; scanned < 1000;) {
    const rows = await fetch(after, 100);
    for (const row of rows) {
      if (await visible(row)) {
        if (items.length === pagination.limit) return { items, next_cursor: await scanCursor(c, scope, after) };
        items.push(row);
      }
      after = row.id; scanned++;
    }
    if (rows.length < 100) return { items, next_cursor: null };
  }
  return { items, next_cursor: await scanCursor(c, scope, after) };
}
