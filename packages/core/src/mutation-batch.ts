import { database, one } from './db.ts';
import { ApiError } from './errors.ts';
import { requestDatabaseBinding, requestDatabaseLocation, selectedRepositoryScope } from './routing/cells.ts';
import { sameDatabaseLocation } from './routing/locations.ts';
import { ordinaryMetadataFenceScope } from './routing/metadata-fences.ts';
import type { RepositoryMetadataFence } from './routing/metadata-fences.ts';
import type { AppContext } from './types.ts';

export interface MutationBatchExecutionOptions {
  /** Additional time spent deferring a known, aborted ordinary metadata write. */
  metadata_fence_wait_ms?: number;
}

interface FenceRow extends RepositoryMetadataFence { state: 'held' | 'released' }
const defaultFenceWaitMilliseconds = 2500;
const maximumFenceWaitMilliseconds = 3000;

function ordinaryFenceAbort(error: unknown): boolean {
  // A transport failure or a generic CAS conflict is never evidence of this
  // specific transactional abort. The named error comes from migration 097.
  if (error instanceof ApiError) return false;
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    if (/^(?:D1_ERROR:\s*)?repository_metadata_fenced(?:: SQLITE_CONSTRAINT(?:_TRIGGER)?(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?)?$/.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

function busy(c: AppContext, repoId: string | null, fence?: FenceRow): ApiError {
  c.header('retry-after', '1');
  return new ApiError(423, 'repository_metadata_busy', 'Repository maintenance is still being reconciled. Retry the same request after the indicated delay.', {
    repo_id: repoId, ...(fence ? { operation_id: fence.operation_id } : {}), retry_after_seconds: 1,
  });
}

function matchingFence(left: FenceRow, right: FenceRow): boolean {
  return left.repo_id === right.repo_id && left.operation_id === right.operation_id
    && left.routing_epoch === right.routing_epoch && left.fence_id === right.fence_id;
}

async function readBeforeDeadline(c: AppContext, binding: D1Database, repoId: string, deadline: number, observed?: FenceRow): Promise<FenceRow | null> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw busy(c, repoId, observed);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      one<FenceRow>(binding.withSession('first-primary'),
        'SELECT repo_id,operation_id,routing_epoch,fence_id,state FROM repository_metadata_fences WHERE repo_id=?', repoId),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(busy(c, repoId, observed)), remaining); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function waitForRelease(c: AppContext, binding: D1Database, repoId: string, epoch: number, milliseconds: number): Promise<FenceRow> {
  const deadline = performance.now() + milliseconds;
  const observed = await readBeforeDeadline(c, binding, repoId, deadline);
  if (!observed) throw busy(c, repoId);
  if (observed.routing_epoch !== epoch) {
    throw new ApiError(412, 'revision_conflict', 'The repository placement changed while this transaction was waiting. Refresh and retry.');
  }
  let current = observed;
  let interval = 25;
  while (current.state === 'held') {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw busy(c, repoId, observed);
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(interval, remaining)));
    const next = await readBeforeDeadline(c, binding, repoId, deadline, observed);
    // A replacement acquisition is another maintenance operation, not a reason
    // to chase fences or refresh any request authority indefinitely.
    if (!next || !matchingFence(observed, next)) throw busy(c, repoId, observed);
    current = next;
    interval = Math.min(interval * 2, 200);
  }
  if (current.state !== 'released') throw busy(c, repoId, observed);
  return current;
}

/**
 * Execute one frozen transaction, with at most one retry after its exact local
 * fence releases. No validation, allocation, ID, policy, or request generation is
 * recreated here. All original SQL guards remain in both attempted batches.
 */
export async function executeMutationBatch(c: AppContext, statements: D1PreparedStatement[], options: MutationBatchExecutionOptions = {}): Promise<D1Result[]> {
  const milliseconds = options.metadata_fence_wait_ms ?? defaultFenceWaitMilliseconds;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > maximumFenceWaitMilliseconds) {
    throw new TypeError(`Metadata fence deferral must be between 0 and ${maximumFenceWaitMilliseconds} milliseconds.`);
  }
  const batch = [...statements];
  const db = database(c);
  const binding = requestDatabaseBinding(c);
  const repoId = ordinaryMetadataFenceScope(batch);
  const routing = c.get('routing');
  const epoch = routing?.epoch;
  const eligible = repoId !== null && selectedRepositoryScope(c) === repoId && routing?.resource_id === repoId
    && sameDatabaseLocation(routing, requestDatabaseLocation(c));
  try { return await db.batch(batch); }
  catch (error) {
    if (!ordinaryFenceAbort(error)) throw error;
    if (!eligible || milliseconds === 0) throw busy(c, repoId);
  }
  const released = await waitForRelease(c, binding, repoId!, epoch!, milliseconds);
  try { return await db.batch(batch); }
  catch (error) {
    // A fresh fence racing the final read is still enforced by the SQL guard.
    // Stop rather than repeating the wait for a different acquisition.
    if (ordinaryFenceAbort(error)) throw busy(c, repoId, released);
    throw error;
  }
}
