import { z } from 'zod';
import { ApiError, auditStatement, authorize, database, encodeCursor, eventStatement, expectedRevision, getRepository, identityDatabase, internalFetch, jsonBody, listResponse, many, mutate, newId, now, one, page, readBounded, registerResourceLocator, requirePrincipal, resolveResourceLocator, resourceResponse, route, routeRepositoryRequest, stmt, verifyInternalRequest } from '@gitknot/core';
import type { App, AppContext } from '@gitknot/core';
import { authenticateRunner, bearerToken, createEnrollment, pollRunner, registerRunner, registrationSchema, rotateRunner, runnerHeartbeatSchema, runnerPollSchema, updateRunnerCapabilities } from '@gitknot/execution/runner-service';
import { attemptAuthSchema, completionSchema, logUploadSchema, outputUploadSchema, stepSecretsSchema, terminationSchema } from '@gitknot/execution/receipt-schemas';
import { attemptRequest } from '@gitknot/execution/transport';
import { runnerExchangeSchema } from '@gitknot/execution/runner-exchanges';
import { activeRunnerSlots } from '@gitknot/execution/runner-slots';
import { assertRunnerPoolScope, authorizeRunnerPool, readRunnerPool, readRunnerRecord, withRunnerAuthorityChange } from '@gitknot/execution/runner-authority';
import { handleRunnerMetadataRequest } from '@gitknot/execution/runner-placement';
import type { AttemptRecord, RunnerPool, RunnerRecord } from '@gitknot/execution/types';
import { executionNotFound, executionReadPage, executionReadResponse, freshExecutionReader, visibleExecutionRecord } from '@gitknot/execution/reads';

const poolSchema = z.object({ account_id: z.string(), repo_id: z.string().nullable().default(null), name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  os: z.enum(['linux', 'darwin', 'windows']), architecture: z.enum(['amd64', 'arm64']), toolchains: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)).min(1).max(128),
  trust: z.enum(['trusted', 'untrusted']), isolation: z.enum(['persistent', 'ephemeral']), max_runners: z.number().int().min(1).max(1000).default(10), max_slots: z.number().int().min(1).max(16).default(1),
}).strict().refine(value => value.trust !== 'untrusted' || value.isolation === 'ephemeral', 'Untrusted code requires disposable-machine isolation.');
const enrollmentSchema = z.object({ pool_id: z.string(), expires_in_seconds: z.number().int().min(60).max(3600).default(600) }).strict();
const stateSchema = z.object({ state: z.enum(['active', 'disabled', 'revoked']) }).strict();

/** These handlers authenticate recovery/cleanup material, never a generic actor. */
export function isRunnerProtocolRequest(request: Request): boolean {
  if (request.method !== 'POST') return false;
  const path = new URL(request.url).pathname;
  return path === '/v1/runners/register' || /^\/v1\/runners\/runner_[A-Za-z0-9_-]+\/rotate$/.test(path)
    || /^\/v1\/attempts\/att_[A-Za-z0-9_-]+\/terminated$/.test(path);
}

async function authorizedPool(c: AppContext, id: string): Promise<RunnerPool> {
  return authorizeRunnerPool(c, id);
}

function publicRunner(row: RunnerRecord): Record<string, unknown> {
  const { credential_hash, toolchains_json, ...record } = row;
  void credential_hash;
  return { ...record, toolchains: JSON.parse(toolchains_json), online: Date.parse(row.last_seen_at) > Date.now() - 90_000 };
}

async function listPools(c: AppContext): Promise<Response> {
  const repoId = c.req.query('repo_id') ?? null;
  let accountId = c.req.query('account_id');
  if (repoId) {
    const repo = await getRepository(c, repoId, 'runners.manage');
    if (accountId && accountId !== repo.owner_id) executionNotFound();
    accountId = repo.owner_id;
  } else {
    if (!accountId) throw new ApiError(422, 'pool_scope_required', 'Specify account_id or repo_id to list runner pools.');
    await authorize(c, 'runners.manage', { account_id: accountId });
  }
  const account = accountId, pools = new Map<string, RunnerPool>();
  const inspect = async (id: string) => {
    const pool = await readRunnerPool(c.env, id);
    if (pool.account_id !== account || repoId !== null && pool.repo_id !== repoId) executionNotFound();
    await assertRunnerPoolScope(c.env, pool, false);
    await authorize(freshExecutionReader(c), 'runners.manage', repoId ? { repo_id: repoId } : { account_id: account });
    return pool;
  };
  const result = await executionReadPage(c, `runner-pools:${account}:${repoId ?? ''}`, (after, limit) => many<{ id: string }>(identityDatabase(c), `
    SELECT id FROM runner_pools WHERE account_id=? AND (? IS NULL OR repo_id=?) AND id>?
    UNION SELECT l.resource_id AS id FROM resource_locators l WHERE l.resource_type='runner_pool' AND l.resource_id>?
      AND ((? IS NOT NULL AND l.repo_id=?) OR (? IS NULL AND l.authority='repository' AND
        (EXISTS (SELECT 1 FROM account_authority_repositories a WHERE a.repo_id=l.repo_id AND a.account_id=?)
         OR EXISTS (SELECT 1 FROM repositories r WHERE r.id=l.repo_id AND r.owner_id=?))))
    ORDER BY id LIMIT ?`, account, repoId, repoId, after, after, repoId, repoId, repoId, account, account, limit), async row =>
    visibleExecutionRecord(async () => { pools.set(row.id, await inspect(row.id)); }));
  const recheck = async () => {
    await authorize(freshExecutionReader(c), 'runners.manage', repoId ? { repo_id: repoId } : { account_id: account });
    for (const row of result.items) await inspect(row.id);
  };
  const items = result.items.map(row => { const { toolchains_json, ...pool } = pools.get(row.id)!; return { ...pool, toolchains: JSON.parse(toolchains_json) }; });
  return executionReadResponse(c, listResponse(c, items, result.next_cursor), recheck);
}

export function registerRunnersRoutes(app: App): void {
  app.post('/internal/execution/runners/metadata', async c => {
    const response = await handleRunnerMetadataRequest(c.req.raw, c.env);
    if (!response) throw new ApiError(404, 'not_found', 'The runner metadata command was not found.');
    return response;
  });
  app.post('/internal/execution/attempts/:attemptId/:action', async c => {
    await verifyInternalRequest(c.req.raw, c.env.INTERNAL_SERVICE_KEY, 'execution');
    const hops = Number(c.req.query('hops') ?? '0');
    if (!Number.isInteger(hops) || hops < 0 || hops > 2) throw new ApiError(503, 'routing_unavailable', 'The attempt route exceeded its hop limit.');
    const body = JSON.parse(new TextDecoder().decode(await readBounded(c.req.raw.body, 1024 * 1024)));
    return c.json(await attemptRequest(c.env, c.req.param('attemptId'), c.req.param('action'), body, hops));
  });
  // Cross-account callbacks carry their own attempt capability. The trusted
  // executor verifies it; this bridge grants no actor or general service scope.
  app.all('/internal/hosted/attempts/:attemptId/:action', async c => {
    const locator = await resolveResourceLocator(c.env, c.req.param('attemptId'), 'attempt');
    if (!locator?.repo_id || locator.authority !== 'repository') throw new ApiError(404, 'not_found', 'The remote attempt was not found.');
    const forwarded = await routeRepositoryRequest(c, locator.repo_id);
    return forwarded ?? c.env.EXECUTOR.fetch(c.req.raw);
  });
  route(app, 'GET', '/v1/runner-pools', { summary: 'List account-authorized or repository-authorized customer runner pools', capability: 'runners.manage' }, listPools);
  route(app, 'POST', '/v1/runner-pools', { summary: 'Create a scoped, trusted runner pool', body: poolSchema, capability: 'runners.manage' }, async c => {
    const input = await jsonBody(c, poolSchema), principal = requirePrincipal(c), db = database(c);
    await authorize(c, 'runners.manage', input.repo_id ? { repo_id: input.repo_id } : { account_id: input.account_id });
    if (input.repo_id && (await getRepository(c, input.repo_id, 'runners.manage')).owner_id !== input.account_id) throw new ApiError(404, 'not_found', 'The repository was not found in this account.');
    const id = newId('pool'), at = now();
    await registerResourceLocator(c.env, { resource_id: id, resource_type: 'runner_pool', repo_id: input.repo_id, authority: 'identity' });
    await mutate(c, { sql: `INSERT INTO runner_pools (id,account_id,repo_id,name,os,architecture,toolchains_json,trust,isolation,max_runners,max_slots,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      bindings: [id, input.account_id, input.repo_id, input.name, input.os, input.architecture, JSON.stringify(input.toolchains), input.trust, input.isolation, input.max_runners, input.max_slots, at, at],
      event: { type: 'runner.pool.created', resource_id: id, resource_revision: 1, repo_id: input.repo_id, account_id: input.account_id, actor_id: principal.id } });
    return resourceResponse(c, { id, ...input, state: 'active', revision: 1, created_at: at, updated_at: at }, 201);
  });
  route(app, 'GET', '/v1/runner-pools/:id', { summary: 'Read runner pool scope and capabilities', capability: 'runners.manage' }, async c => {
    const { toolchains_json, ...pool } = await authorizedPool(c, c.req.param('id')!);
    return resourceResponse(c, { ...pool, toolchains: JSON.parse(toolchains_json) });
  });
  route(app, 'PATCH', '/v1/runner-pools/:id', { summary: 'Enable or disable a runner pool', body: z.object({ state: z.enum(['active', 'disabled']) }).strict(), capability: 'runners.manage' }, async c => {
    const pool = await authorizedPool(c, c.req.param('id')!), revision = expectedRevision(c), input = c.get('input') as { state: string };
    await withRunnerAuthorityChange(c, pool.id, () => mutate(c, { sql: 'UPDATE runner_pools SET state=?,revision=revision+1,updated_at=? WHERE id=? AND account_id=? AND revision=?', bindings: [input.state, now(), pool.id, pool.account_id, revision],
      event: { type: 'runner.pool.updated', resource_id: pool.id, resource_revision: revision + 1, repo_id: pool.repo_id, account_id: pool.account_id, data: { state: input.state } } }));
    return resourceResponse(c, { ...pool, state: input.state, revision: revision + 1 });
  });
  route(app, 'POST', '/v1/runner-enrollments', { summary: 'Issue a one-time pool enrollment', body: enrollmentSchema, capability: 'runners.manage', sensitive: true }, async c => {
    const input = await jsonBody(c, enrollmentSchema), pool = await authorizedPool(c, input.pool_id);
    return c.json(await createEnrollment(c.env, pool, requirePrincipal(c).id, input.expires_in_seconds, c), 201);
  });
  route(app, 'GET', '/v1/runner-enrollments', { summary: 'List one-time enrollment metadata', capability: 'runners.manage' }, async c => {
    const poolId = c.req.query('pool_id');
    if (!poolId) throw new ApiError(422, 'pool_required', 'Specify pool_id to list its enrollments.');
    const pool = await authorizedPool(c, poolId), pagination = page(c);
    const rows = await many<{ id: string }>(database(c), 'SELECT id,pool_id,repo_id,account_id,expires_at,consumed_at,runner_id,revision,created_at FROM runner_enrollments WHERE pool_id=? AND account_id=? AND id>? ORDER BY id LIMIT ?', pool.id, pool.account_id, pagination.cursor ?? '', pagination.limit + 1);
    return listResponse(c, rows.slice(0, pagination.limit), rows.length > pagination.limit ? rows[pagination.limit - 1]!.id : null);
  });
  route(app, 'GET', '/v1/runner-enrollments/:id', { summary: 'Read enrollment expiry and consumption', capability: 'runners.manage' }, async c => {
    const enrollment = await one<{ id: string; pool_id: string; revision: number }>(database(c), 'SELECT id,pool_id,repo_id,account_id,expires_at,consumed_at,runner_id,revision,created_at FROM runner_enrollments WHERE id=?', c.req.param('id'));
    if (!enrollment) throw new ApiError(404, 'not_found', 'The enrollment was not found.');
    await authorizedPool(c, enrollment.pool_id);
    return resourceResponse(c, enrollment);
  });
  route(app, 'DELETE', '/v1/runner-enrollments/:id', { summary: 'Revoke an unused enrollment', capability: 'runners.manage' }, async c => {
    const enrollment = await one<{ id: string; pool_id: string }>(database(c), 'SELECT id,pool_id FROM runner_enrollments WHERE id=?', c.req.param('id'));
    if (!enrollment) throw new ApiError(404, 'not_found', 'The enrollment was not found.');
    const pool = await authorizedPool(c, enrollment.pool_id), revision = expectedRevision(c);
    await withRunnerAuthorityChange(c, pool.id, () => mutate(c, { sql: 'UPDATE runner_enrollments SET expires_at=?,revision=revision+1 WHERE id=? AND pool_id=? AND revision=? AND consumed_at IS NULL',
      bindings: [now(), enrollment.id, pool.id, revision], event: { type: 'runner.enrollment.revoked', resource_id: enrollment.id, resource_revision: revision + 1, repo_id: pool.repo_id, account_id: pool.account_id } }));
    return c.body(null, 204);
  });
  route(app, 'POST', '/v1/runners/register', { summary: 'Consume a one-time runner enrollment', body: registrationSchema, public: true, idempotent: false, sensitive: true }, async c =>
    c.json(await registerRunner(c.env, await jsonBody(c, registrationSchema)), 201));
  route(app, 'GET', '/v1/runner-pools/:id/runners', { summary: 'List machines enrolled in a pool', capability: 'runners.manage' }, async c => {
    const pool = await authorizedPool(c, c.req.param('id')!), pagination = page(c);
    const rows = await many<RunnerRecord>(database(c), 'SELECT * FROM runners WHERE pool_id=? AND account_id=? AND id>? ORDER BY id LIMIT ?', pool.id, pool.account_id, pagination.cursor ?? '', pagination.limit + 1);
    return listResponse(c, rows.slice(0, pagination.limit).map(publicRunner), rows.length > pagination.limit ? rows[pagination.limit - 1]!.id : null);
  });
  route(app, 'PATCH', '/v1/runners/:id', { summary: 'Disable or revoke an enrolled machine', body: stateSchema, capability: 'runners.manage' }, async c => {
    const runner = await readRunnerRecord(c.env, c.req.param('id')!);
    await authorizedPool(c, runner.pool_id);
    const input = await jsonBody(c, stateSchema), revision = expectedRevision(c);
    if (runner.state === 'revoked') throw new ApiError(409, 'runner_revoked', 'A revoked machine must be enrolled again.');
    await withRunnerAuthorityChange(c, runner.pool_id, () => mutate(c, { sql: 'UPDATE runners SET state=?,revision=revision+1,updated_at=? WHERE id=? AND account_id=? AND revision=?', bindings: [input.state, now(), runner.id, runner.account_id, revision],
      event: { type: 'runner.updated', resource_id: runner.id, resource_revision: revision + 1, repo_id: runner.repo_id, account_id: runner.account_id, data: { state: input.state } } }));
    if (input.state !== 'active') {
      const slots = await activeRunnerSlots(c.env, runner.id);
      await Promise.all(slots.map(slot => attemptRequest(c.env, slot.attempt_id, 'cancel', { reason: 'The enrolled machine was disabled or revoked.' })));
    }
    return resourceResponse(c, { ...publicRunner(runner), state: input.state, revision: revision + 1 });
  });
  route(app, 'GET', '/v1/runners/:id', { summary: 'Read authorized machine status and capabilities', capability: 'runners.manage' }, async c => {
    const runner = await readRunnerRecord(c.env, c.req.param('id')!);
    await authorizedPool(c, runner.pool_id);
    return resourceResponse(c, { ...publicRunner(runner), revision: runner.revision });
  });
  route(app, 'POST', '/v1/runners/:id/poll', { summary: 'Poll for a scoped, fenced job assignment', body: runnerPollSchema, idempotent: false, sensitive: true }, async c => {
    const runner = await authenticateRunner(c.env, c.req.param('id')!, bearerToken(c.req.raw));
    return c.json(await pollRunner(c.env, runner, await jsonBody(c, runnerPollSchema)));
  });
  route(app, 'POST', '/v1/runners/:id/heartbeat', { summary: 'Report machine capabilities and active attempts', body: runnerHeartbeatSchema, idempotent: false }, async c => {
    const runner = await authenticateRunner(c.env, c.req.param('id')!, bearerToken(c.req.raw)), input = await jsonBody(c, runnerHeartbeatSchema);
    await updateRunnerCapabilities(database(c), runner, input);
    const slots = await activeRunnerSlots(c.env, runner.id), cancelled: string[] = [];
    for (const active of input.active_attempts) {
      const slot = slots.find(slot => slot.attempt_id === active.attempt_id && slot.generation === active.generation);
      if (!slot || !(await attemptRequest<{ active: boolean }>(c.env, active.attempt_id, 'runner-status', { runner_id: runner.id, generation: active.generation })).active) cancelled.push(active.attempt_id);
    }
    return c.json({ status: 'active', cancel_attempt_ids: cancelled });
  });
  route(app, 'POST', '/v1/runners/:id/rotate', { summary: 'Recoverably exchange an idle machine credential', body: runnerExchangeSchema, public: true, idempotent: false, sensitive: true }, async c =>
    c.json(await rotateRunner(c.env, c.req.param('id')!, bearerToken(c.req.raw), (await jsonBody(c, runnerExchangeSchema)).exchange)));
  registerAttemptRoutes(app);
}

function registerAttemptRoutes(app: App): void {
  const endpoints = [
    ['heartbeat', attemptAuthSchema, 'Renew the current attempt lease'], ['logs', logUploadSchema, 'Upload a checksummed redacted log chunk'],
    ['outputs', outputUploadSchema, 'Upload a declared output chunk'], ['secrets', stepSecretsSchema, 'Resolve just-in-time declared step secrets'],
    ['complete', completionSchema, 'Submit an authenticated completion receipt'],
    ['terminated', terminationSchema, 'Confirm termination after fencing without publishing results'],
  ] as const;
  for (const [action, schema, summary] of endpoints) route(app, 'POST', `/v1/attempts/:id/${action}`, { summary, body: schema, public: action === 'terminated', idempotent: false, sensitive: true }, async c => {
    const body = await jsonBody(c, schema);
    const response = await internalFetch(c.env.EXECUTOR, c.env.INTERNAL_SERVICE_KEY, 'execution', `/internal/attempts/${c.req.param('id')}/${action}`, { body, machine_token: bearerToken(c.req.raw) });
    return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  });
  route(app, 'GET', '/v1/attempts/:id/inputs/:objectId', { summary: 'Download a declared verified dependency output', idempotent: false, streaming: true }, async c => {
    const auth = attemptAuthSchema.parse({ runner_id: c.req.header('x-gitknot-runner'), generation: Number(c.req.header('x-gitknot-generation')), lease_token: c.req.header('x-gitknot-lease') });
    return internalFetch(c.env.EXECUTOR, c.env.INTERNAL_SERVICE_KEY, 'execution', `/internal/attempts/${c.req.param('id')}/inputs/${c.req.param('objectId')}`, { body: auth, machine_token: bearerToken(c.req.raw) });
  });
}
