import { ApiError, canonicalJson, sha256 } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import type { DirectoryBackup } from '@cloudflare/sandbox';
import type { AttemptContext } from '../types.ts';
import type { DestructionReceipt } from '../attempt-machine.ts';
import { assertActiveRepository, attemptContext, currentGeneration, executionResourceEnvironment, primary } from '../store.ts';
import type { RuntimeFacts, RuntimeGrant } from './runtime-types.ts';
import { EXECUTION_LIMITS } from '../config.ts';

export interface LocalRuntimeRequest { attempt_id: string; generation: number }
export interface LocalRuntimeScope extends LocalRuntimeRequest {
  repo_id: string;
  account_id: string;
  plan_digest: string;
  producer_id: string;
  toolchain_digest: string;
  runtime_id: string;
  runtime_name: string;
  allocated_at: string;
  reservation_id: string;
  reservation_fence: string;
  cell_id: string;
  shard_id: string;
  retention_seconds: number;
  activated: boolean;
}
export const LOCAL_SCOPE_KEY = 'hosted:local-scope';

export interface LocalSandboxControl {
  arm(input: LocalRuntimeRequest): Promise<{ armed: true }>;
  activate(input: LocalRuntimeRequest, sourceUrl: string): Promise<{ lease_expires_at: string }>;
  refreshLease(input: LocalRuntimeRequest): Promise<{ lease_expires_at: string }>;
  enableLeaseFile(input: LocalRuntimeRequest): Promise<void>;
  checkoutComplete(input: LocalRuntimeRequest): Promise<void>;
  stopJobProcesses(): Promise<boolean>;
  runtimeStatus(input: LocalRuntimeRequest): Promise<RuntimeFacts>;
  retainSnapshot(input: LocalRuntimeRequest, snapshot: DirectoryBackup, cacheKey: string | null): Promise<void>;
  destroyAndVerify(input: LocalRuntimeRequest): Promise<DestructionReceipt>;
}

export async function localAttemptEnvironment(env: Bindings, input: LocalRuntimeRequest, active = false): Promise<{ env: Bindings; context: AttemptContext }> {
  const selected = await executionResourceEnvironment(env, input.attempt_id, 'attempt');
  const context = await attemptContext(primary(selected), input.attempt_id), attempt = context.attempt;
  if (attempt.generation !== input.generation || attempt.executor !== 'hosted' || attempt.execution_backend === 'remote'
    || !attempt.runtime_id || !attempt.runtime_name || !attempt.deadline_at || !attempt.reservation_id || !attempt.reservation_fence) throw localFenced();
  if (active) {
    await assertActiveRepository(primary(selected), context);
    if (!['leased', 'running'].includes(attempt.status) || !attempt.lease_expires_at
      || Math.min(Date.parse(attempt.deadline_at), Date.parse(attempt.lease_expires_at)) <= Date.now()
      || context.run.status === 'cancelling' || await currentGeneration(primary(selected), attempt) !== attempt.generation) throw localFenced();
  }
  return { env: selected, context };
}

export function localScope(env: Bindings, context: AttemptContext): LocalRuntimeScope {
  const a = context.attempt;
  return { attempt_id: a.id, generation: a.generation, repo_id: a.repo_id, account_id: a.account_id, plan_digest: a.plan_digest,
    producer_id: a.producer_id, toolchain_digest: a.toolchain_digest, runtime_id: a.runtime_id!, runtime_name: a.runtime_name!,
    allocated_at: a.allocated_at!, reservation_id: a.reservation_id!, reservation_fence: a.reservation_fence!, cell_id: env.CELL_ID,
    shard_id: env.SHARD_ID, retention_seconds: context.job.cache && context.job.cache.mode !== 'read' && !context.job.steps.some(step => step.secrets.length)
      ? context.job.cache.retention_seconds : 3600, activated: false };
}

export async function localRuntimeGrant(env: Bindings, context: AttemptContext): Promise<RuntimeGrant> {
  const a = context.attempt;
  const identity = { executor_id: `local:${env.CELL_ID}`, attempt_id: a.id, generation: a.generation,
    producer_id: a.producer_id, runtime_id: a.runtime_id!, runtime_name: a.runtime_name!, sandbox_id: a.runtime_id!, deadline_at: a.deadline_at! };
  return { ...identity, grant_digest: await sha256(canonicalJson({ ...identity, plan_digest: a.plan_digest, toolchain_digest: a.toolchain_digest })),
    lease_expires_at: a.lease_expires_at!, egress: context.job.egress, cache_bytes: context.job.limits?.cache_bytes ?? EXECUTION_LIMITS.cache_bytes, source_url: null };
}

export function localFenced(): ApiError { return new ApiError(409, 'attempt_fenced', 'The local hosted allocation is closed or no longer current.'); }
