import { Context } from 'hono';
import { identityBinding, identityAuthorityBindings, resolveRepositoryPlacement, resolveResourceLocator, readRepositoryAuthority, cellDatabase, internalFetch, verifyInternalRequest, readBounded, ApiError } from '@gitknot/core';
import { cellService } from '@gitknot/core/routing/cells';
import type { AppEnv, Bindings, Database, Repository } from '@gitknot/core';
import { z } from 'zod';
import type { SecretsBrokerBindings, RuntimeContext } from './types.ts';
import { loadRunnerAuthority } from '../../execution/src/runner-authority.ts';
import type { RunnerAuthorityWitness } from '../../execution/src/runner-authority.ts';

export function vaultEnvironment<T extends Bindings>(env: T): T {
  const primary = identityBinding(env);
  const identity = identityAuthorityBindings(env);
  if (env.CELL_ID === identity.IDENTITY_CELL_ID && env.SHARD_ID === identity.IDENTITY_SHARD_ID) return { ...env, ...identity, DB: primary };
  const shards = typeof env.SHARD_BINDINGS_JSON === 'string' ? JSON.parse(env.SHARD_BINDINGS_JSON) as Record<string, string> : {};
  if (!shards[env.SHARD_ID]) shards[env.SHARD_ID] = 'VAULT_SOURCE_DB';
  return { ...env, ...identity, ROOT_DB: env.ROOT_DB ?? env.DB, ROOT_SHARD_ID: env.ROOT_SHARD_ID ?? env.SHARD_ID,
    VAULT_SOURCE_DB: env.DB, SHARD_BINDINGS_JSON: JSON.stringify(shards), DB: primary, SHARD_ID: 'vault-authority' };
}

const requestSchema = z.object({ action: z.enum(['environment', 'runtime', 'webhook', 'delivery', 'lifecycle']),
  repo_id: z.string().min(1).max(128), resource_id: z.string().min(1).max(128), generation: z.number().int().positive().optional(),
  cell_id: z.string(), shard_id: z.string(), epoch: z.number().int().positive() }).strict();
type AuthorityRequest = z.infer<typeof requestSchema>;

export interface RunnerAuthority {
  id: string; account_id: string; repo_id: string | null; state: string; trust: string; revision: number;
  runner_id: string; pool_id: string; runner_repo_id: string | null; runner_state: string; runner_revision: number;
  credential_generation: number; credential_hash: string; credential_expires_at: string;
  witness: RunnerAuthorityWitness;
}
export interface RuntimeSnapshot { context: RuntimeContext | null; environment: Record<string, unknown> | null; approvals: Record<string, unknown>[]; runner: RunnerAuthority | null }

async function currentRunner(env: Bindings, context: RuntimeContext | null): Promise<RunnerAuthority | null> {
  if (context?.executor !== 'self_hosted' || !context.runner_id || !context.runner_pool_id) return null;
  const { runner, pool, witness } = await loadRunnerAuthority(env, context.runner_id);
  return { id: pool.id, account_id: pool.account_id, repo_id: pool.repo_id, state: pool.state, trust: pool.trust, revision: pool.revision,
    runner_id: runner.id, pool_id: runner.pool_id, runner_repo_id: runner.repo_id, runner_state: runner.state, runner_revision: runner.revision,
    credential_generation: runner.credential_generation, credential_hash: runner.credential_hash, credential_expires_at: runner.credential_expires_at, witness };
}

async function metadata(db: Database, input: AuthorityRequest): Promise<unknown> {
  const stmt = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
  const repository = await stmt('SELECT cell_id,shard_id,routing_epoch FROM repositories WHERE id=?', input.repo_id)
    .first<{ cell_id: string; shard_id: string; routing_epoch: number }>();
  if (!repository || repository.cell_id !== input.cell_id || repository.shard_id !== input.shard_id || repository.routing_epoch !== input.epoch) {
    throw new ApiError(409, 'routing_epoch_changed', 'The metadata database is not the current repository placement.');
  }
  switch (input.action) {
    case 'environment': return stmt('SELECT * FROM workflow_environments WHERE id=? AND repo_id=?', input.resource_id, input.repo_id).first();
    case 'webhook': return stmt('SELECT * FROM webhooks WHERE id=? AND repo_id=?', input.resource_id, input.repo_id).first();
    case 'lifecycle': {
      const rows = await db.batch([
        stmt('SELECT * FROM operations WHERE id=? AND repo_id=?', input.resource_id, input.repo_id),
        stmt("SELECT operation_id FROM operation_steps WHERE operation_id=? AND name='fence' AND state='completed'", input.resource_id),
      ]);
      return { operation: rows[0]!.results[0] ?? null, fenced: rows[1]!.results.length === 1 };
    }
    case 'delivery': {
      const rows = await db.batch([
        stmt('SELECT * FROM webhook_deliveries WHERE id=? AND repo_id=?', input.resource_id, input.repo_id),
        stmt('SELECT w.* FROM webhooks w JOIN webhook_deliveries d ON d.webhook_id=w.id WHERE d.id=? AND d.repo_id=?', input.resource_id, input.repo_id),
        stmt('SELECT e.event_json FROM outbox e JOIN webhook_deliveries d ON d.event_id=e.id WHERE d.id=? AND d.repo_id=?', input.resource_id, input.repo_id),
        stmt("SELECT k.* FROM webhook_keys k JOIN webhook_deliveries d ON d.webhook_id=k.webhook_id WHERE d.id=? AND d.repo_id=? AND (k.state='active' OR (k.state='retiring' AND k.valid_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))) ORDER BY k.id", input.resource_id, input.repo_id),
      ]);
      return { delivery: rows[0]!.results[0] ?? null, webhook: rows[1]!.results[0] ?? null, event: rows[2]!.results[0] ?? null, keys: rows[3]!.results };
    }
    case 'runtime': {
      const rows = await db.batch([
        stmt('SELECT * FROM secret_runtime_context WHERE attempt_id=? AND repo_id=? LIMIT 2', input.resource_id, input.repo_id),
        stmt('SELECT e.* FROM workflow_environments e JOIN secret_runtime_context c ON c.environment_id=e.id AND c.repo_id=e.repo_id WHERE c.attempt_id=? AND c.repo_id=? LIMIT 1', input.resource_id, input.repo_id),
        stmt('SELECT * FROM secret_environment_authorizations WHERE attempt_id=? AND generation=? AND repo_id=? ORDER BY approver_id', input.resource_id, input.generation, input.repo_id),
      ]);
      if (rows[0]!.results.length > 1) throw new ApiError(403, 'attempt_ambiguous', 'The authoritative attempt is ambiguous.');
      return { context: rows[0]!.results[0] ?? null, environment: rows[1]!.results[0] ?? null, approvals: rows[2]!.results, runner: null };
    }
  }
}

export async function vaultMetadata<T>(env: Bindings, input: { action: AuthorityRequest['action']; resource_id: string; repo_id?: string; generation?: number }): Promise<T> {
  let repoId = input.repo_id;
  if (!repoId) {
    const type = input.action === 'runtime' ? 'attempt' : input.action === 'delivery' ? 'delivery' : input.action === 'webhook' ? 'webhook' : 'operation';
    repoId = (await resolveResourceLocator(env, input.resource_id, type))?.repo_id ?? undefined;
  }
  if (!repoId) throw new ApiError(404, 'not_found', 'The authoritative resource locator was not found.');
  const placement = await resolveRepositoryPlacement(env, repoId);
  if (!placement) throw new ApiError(503, 'vault_authority_unavailable', 'The current repository placement could not be verified.');
  const request = { ...input, repo_id: repoId, cell_id: placement.cell_id, shard_id: placement.shard_id, epoch: placement.epoch };
  let result: unknown;
  if (placement.cell_id === env.CELL_ID) result = await metadata(cellDatabase(env, placement.shard_id).withSession('first-primary'), request);
  else {
    const response = await internalFetch(cellService(env, placement.cell_id), env.INTERNAL_SERVICE_KEY, 'vault.authority', '/internal/vault/authority', request);
    if (!response.ok) throw new ApiError(503, 'vault_authority_unavailable', 'The current repository cell could not confirm vault authorization metadata.');
    result = (await response.json() as { result: unknown }).result;
  }
  if (input.action === 'runtime') {
    const snapshot = result as RuntimeSnapshot;
    // Resolve the machine's own typed locator authority independently of the attempt's shard.
    result = { ...snapshot, runner: await currentRunner(env, snapshot.context) };
  }
  return result as T;
}

/** Read-only, fixed metadata protocol. It never reads ciphertext or returns tenant values. */
export async function handleVaultAuthorityRequest(request: Request, env: Bindings): Promise<Response> {
  await verifyInternalRequest(request, env.INTERNAL_SERVICE_KEY, 'vault.authority');
  const input = requestSchema.parse(JSON.parse(new TextDecoder().decode(await readBounded(request.body, 16_384))));
  const current = await resolveRepositoryPlacement(env, input.repo_id);
  if (!current || current.cell_id !== env.CELL_ID || current.shard_id !== input.shard_id || current.epoch !== input.epoch || input.cell_id !== env.CELL_ID) {
    throw new ApiError(409, 'routing_epoch_changed', 'Vault authorization metadata moved to a different placement.');
  }
  return Response.json({ result: await metadata(cellDatabase(env, input.shard_id).withSession('first-primary'), input) });
}
