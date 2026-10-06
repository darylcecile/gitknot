import { ApiError } from '@gitknot/core';
import type { AttemptIdentity, AttemptRecord, AttemptStatus, ExecutionPlan, JobRecord, JobStatus, PlanJob, RunStatus, RunnerPool, RunnerRecord, Trust } from './types.ts';

export const TERMINAL_ATTEMPTS = new Set<AttemptStatus>(['succeeded', 'failed', 'cancelled', 'timed_out', 'runner_unreachable', 'infrastructure_failed']);
export const TERMINAL_JOBS = new Set<JobStatus>(['succeeded', 'failed', 'dependency_blocked', 'cancelled', 'timed_out', 'not_applicable', 'runner_unreachable']);
export const TERMINAL_RUNS = new Set<RunStatus>(['succeeded', 'failed', 'cancelled', 'timed_out', 'not_applicable', 'runner_unreachable']);

export function nextJobState(job: PlanJob, dependencies: Array<Pick<JobRecord, 'status' | 'job_key'>>): { status: JobStatus; reason: string | null } {
  if (job.blocked_reason) return { status: 'dependency_blocked', reason: job.blocked_reason };
  if (!job.applicable) return { status: 'not_applicable', reason: job.inapplicable_reason ?? 'Trusted policy declares this requirement inapplicable.' };
  if (dependencies.length !== job.needs.length) return { status: 'dependency_blocked', reason: 'A required dependency is missing from the immutable plan.' };
  const failed = dependencies.find(dep => TERMINAL_JOBS.has(dep.status) && !['succeeded', 'not_applicable'].includes(dep.status));
  if (failed) return { status: 'dependency_blocked', reason: `Dependency ${failed.job_key} ended ${failed.status}.` };
  if (dependencies.some(dep => !TERMINAL_JOBS.has(dep.status))) return { status: 'waiting', reason: 'Waiting for dependencies.' };
  for (const input of job.inputs) {
    if (dependencies.some(dep => dep.job_key === input.job && dep.status === 'not_applicable')) {
      return { status: 'dependency_blocked', reason: `Required output ${input.job}.${input.output} has no producing job.` };
    }
  }
  return { status: 'ready', reason: null };
}

export function summarizeRun(jobs: Array<Pick<JobRecord, 'status'>>, cancelling = false): RunStatus {
  if (jobs.length === 0) return 'not_applicable';
  if (jobs.some(job => !TERMINAL_JOBS.has(job.status))) {
    if (cancelling || jobs.some(job => job.status === 'cancelling')) return 'cancelling';
    if (jobs.some(job => job.status === 'running')) return 'running';
    if (jobs.some(job => job.status === 'waiting_approval')) return 'waiting_approval';
    return 'waiting';
  }
  if (jobs.some(job => job.status === 'runner_unreachable')) return 'runner_unreachable';
  if (jobs.some(job => job.status === 'timed_out')) return 'timed_out';
  if (jobs.some(job => ['failed', 'dependency_blocked'].includes(job.status))) return 'failed';
  if (cancelling || jobs.some(job => job.status === 'cancelled')) return 'cancelled';
  return jobs.every(job => job.status === 'not_applicable') ? 'not_applicable' : 'succeeded';
}

export function affectedJobs(jobs: PlanJob[], selected: string[]): Set<string> {
  const keys = new Set(jobs.map(job => job.key));
  if (selected.some(key => !keys.has(key))) throw new ApiError(422, 'unknown_job', 'A requested job is not part of this run.');
  const affected = new Set(selected);
  for (let changed = true; changed;) {
    changed = false;
    for (const job of jobs) {
      if (!affected.has(job.key) && job.needs.some(key => affected.has(key))) { affected.add(job.key); changed = true; }
    }
  }
  return affected;
}

export function concurrencyKey(plan: Pick<ExecutionPlan, 'repo_id' | 'trigger' | 'concurrency'>): string | null {
  if (!plan.concurrency.key) return null;
  if (plan.concurrency.supersede) {
    if (!plan.trigger.type.startsWith('pull_request.') || !plan.trigger.pull_request_id) {
      throw new ApiError(422, 'invalid_supersession', 'Only pull-request verification may supersede an older run.');
    }
    return `${plan.repo_id}:pr:${plan.trigger.pull_request_id}:${plan.concurrency.key}`;
  }
  // Candidate identity keeps merge candidates independent, even for a PR workflow.
  return `${plan.repo_id}:group:${plan.concurrency.key}`;
}

export function runnerMatches(pool: RunnerPool, runner: RunnerRecord, context: { account_id: string; repo_id: string; trust: Trust; job: PlanJob }): string | null {
  if (runner.state !== 'active' || pool.state !== 'active') return 'runner_disabled';
  if (runner.pool_id !== pool.id || runner.account_id !== context.account_id || pool.account_id !== context.account_id) return 'tenant_mismatch';
  if ((pool.repo_id && pool.repo_id !== context.repo_id) || (runner.repo_id && runner.repo_id !== context.repo_id)) return 'repository_mismatch';
  if (pool.trust !== context.trust || (context.trust === 'untrusted' && pool.isolation !== 'ephemeral')) return 'trust_mismatch';
  if (context.job.executor.type !== 'self_hosted' || ![pool.id, pool.name].includes(context.job.executor.pool)) return 'pool_mismatch';
  if (runner.os !== context.job.toolchain.os || runner.architecture !== context.job.toolchain.architecture) return 'platform_mismatch';
  const required = context.job.toolchain.digest;
  const allowed: string[] = JSON.parse(pool.toolchains_json);
  const available: string[] = JSON.parse(runner.toolchains_json);
  if (!allowed.includes(required) || !available.includes(required)) return 'toolchain_unavailable';
  if (context.job.producer_id !== `pool:${pool.id}`) return 'producer_mismatch';
  return null;
}

export function assertCurrentReceipt(attempt: AttemptRecord, identity: AttemptIdentity, currentGeneration: number, clock = Date.now()): void {
  if (attempt.id !== identity.attempt_id || attempt.generation !== identity.generation || currentGeneration !== identity.generation
    || attempt.plan_digest !== identity.plan_digest || (attempt.runner_id ?? attempt.producer_id) !== identity.runner_id) {
    throw new ApiError(409, 'stale_attempt', 'This receipt does not belong to the current attempt generation.');
  }
  if (!['leased', 'running'].includes(attempt.status)) throw new ApiError(409, 'attempt_closed', 'This attempt no longer accepts results.');
  if (!attempt.deadline_at || !attempt.lease_expires_at || Date.parse(attempt.deadline_at) <= clock || Date.parse(attempt.lease_expires_at) <= clock) {
    throw new ApiError(409, 'attempt_expired', 'The attempt lease or whole-job deadline has expired.');
  }
}

export function safeRelativePath(path: string): string {
  if (!path || path.length > 512 || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path) || path.startsWith('/')
    || path.split('/').some(segment => segment === '..' || segment === '.git') || /^[a-z]:/i.test(path)) {
    throw new ApiError(422, 'unsafe_path', 'Paths must stay inside the clean job workspace.');
  }
  return path.replace(/\/$/, '');
}
