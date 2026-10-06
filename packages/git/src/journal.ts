import type { GitEvidence, GitOperation, PublicationResult } from './types.ts';
import { GitError, requireValue } from './errors.ts';

export interface JournalStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<unknown>;
  transaction<T>(callback: (storage: JournalStorage) => Promise<T>): Promise<T>;
}

export interface RepositoryBarrier { operation_id: string; token_hash: string; reason: string; created_at: string; acquire_before: string }
interface BarrierRecord extends RepositoryBarrier { state: 'held' | 'released'; released_at?: string; replay_until?: string }

/** All state transitions persist before granting the corresponding capability. */
export class PublicationJournal {
  private readonly storage: JournalStorage;
  constructor(storage: JournalStorage) { this.storage = storage; }

  async get(id: string): Promise<GitOperation> {
    const operation = await this.storage.get<GitOperation>(`operation:${id}`);
    requireValue(operation, 'operation_not_found', 'Git operation not found.', 404);
    return operation;
  }

  async active(): Promise<GitOperation | null> {
    const id = await this.storage.get<string>('active');
    return id ? this.get(id) : null;
  }

  async open(operation: GitOperation, barrierHash?: string): Promise<GitOperation> {
    return this.storage.transaction(async tx => {
      const existing = await tx.get<GitOperation>(`operation:${operation.id}`);
      if (existing) {
        requireValue(existing.repo_id === operation.repo_id && existing.actor.id === operation.actor.id && existing.publisher_id === operation.publisher_id
          && existing.request_digest === operation.request_digest,
          'idempotency_conflict', 'This operation ID already belongs to another publication.', 409);
        return existing;
      }
      requireValue(!await tx.get(`retired-storage:${operation.repository.storage_name}`) && !await tx.get(`closed-operation:${operation.id}`), 'publication_closed',
        'This physical Git namespace was permanently closed by its lifecycle owner.', 409);
      const barrier = await tx.get<RepositoryBarrier>('barrier');
      requireValue(!barrier || barrier.token_hash === barrierHash, 'repository_fenced', 'Repository maintenance currently blocks writes.', 409);
      requireValue(!await tx.get('active'), 'publication_in_progress', 'A previous Git publication is still being reconciled. Retry after its outcome is known.', 409);
      await tx.put(`operation:${operation.id}`, operation);
      await tx.put('active', operation.id);
      return operation;
    });
  }

  async validated(id: string, publisher: string, evidence: GitEvidence): Promise<GitOperation> {
    return this.change(id, operation => {
      this.publisher(operation, publisher);
      if (operation.state === 'validated' && operation.evidence?.digest === evidence.digest) return;
      requireValue(operation.state === 'receiving', 'publication_state', 'This operation no longer accepts validation.', 409);
      operation.evidence = evidence;
      operation.state = 'validated';
    });
  }

  async publishing(id: string, publisher: string, digest: string): Promise<GitOperation> {
    return this.change(id, operation => {
      this.publisher(operation, publisher);
      requireValue(operation.state === 'validated' && operation.evidence?.digest === digest,
        'publication_state', 'A publication permit has already been issued or its evidence changed.', 409);
      operation.state = 'publishing';
    });
  }

  async storageAdmission(id: string, values: NonNullable<GitOperation['storage_admission']>): Promise<GitOperation> {
    return this.change(id, operation => {
      requireValue(values.settled || operation.state === 'validated', 'publication_state', 'A closed publisher cannot acquire a new storage hold.', 409);
      const previous = operation.storage_admission;
      requireValue(!previous?.reservation_id || previous.reservation_id === values.reservation_id, 'storage_admission_conflict', 'The storage reservation identity changed.', 409);
      operation.storage_admission = values;
    });
  }

  /** Close before observing absence: a delayed begin can never reuse this namespace. */
  async retireStorage(storageName: string, owner: string): Promise<GitOperation | null> {
    return this.storage.transaction(async tx => {
      const prior = await tx.get<string>(`retired-storage:${storageName}`);
      requireValue(!prior || prior === owner, 'storage_retirement_conflict', 'Another lifecycle operation owns this namespace retirement.', 409);
      await tx.put(`retired-storage:${storageName}`, owner);
      const id = await tx.get<string>('active');
      const operation = id ? await tx.get<GitOperation>(`operation:${id}`) : undefined;
      requireValue(!id || operation, 'publication_journal_unavailable', 'The active native publisher has no readable original journal.', 503);
      if (!operation || operation.repository.storage_name !== storageName) return null;
      if (operation.state === 'receiving' || operation.state === 'validated') {
        operation.state = 'rejected';
        operation.error = { code: 'storage_retired', message: 'The lifecycle owner closed this namespace before a canonical permit was issued.' };
        operation.updated_at = new Date().toISOString();
        await tx.put(`operation:${operation.id}`, operation);
      }
      return operation;
    });
  }

  async storageRetired(storageName: string, owner: string): Promise<boolean> {
    return await this.storage.get(`retired-storage:${storageName}`) === owner;
  }

  async closeUnstarted(id: string): Promise<boolean> {
    return this.storage.transaction(async tx => {
      if (await tx.get(`operation:${id}`)) return false;
      requireValue(await tx.get('active') !== id, 'publication_journal_unavailable', 'An active publisher cannot be closed from a missing operation record.', 503);
      await tx.put(`closed-operation:${id}`, true);
      return true;
    });
  }

  async result(id: string, result: PublicationResult): Promise<GitOperation> {
    return this.change(id, operation => {
      if (operation.state === 'committed') {
        requireValue(result.outcome === 'committed' && result.marker_oid === operation.result?.marker_oid, 'publication_conflict', 'Publication outcomes disagree.', 409);
        return;
      }
      requireValue(operation.state !== 'rejected', 'publication_state', 'This publication has already been rejected.', 409);
      if (result.outcome === 'committed') {
        requireValue(operation.evidence?.marker_oid === result.marker_oid && result.operation_id === id,
          'publication_conflict', 'Canonical publication evidence does not match this operation.', 409);
      }
      operation.result = result;
      operation.state = result.outcome;
    });
  }

  async rejectBeforePublication(id: string, code: string, message: string): Promise<GitOperation> {
    return this.change(id, operation => {
      requireValue(operation.state === 'receiving' || operation.state === 'validated',
        'publication_uncertain', 'The publisher may already be active; reconciliation is required.', 409);
      operation.state = 'rejected';
      operation.error = { code, message };
    });
  }

  async finalized(id: string): Promise<GitOperation> {
    return this.storage.transaction(async tx => {
      const journal = new PublicationJournal(tx);
      const operation = await journal.get(id);
      requireValue(operation.state === 'committed' || operation.state === 'rejected', 'publication_uncertain', 'An uncertain publication cannot release its fence.', 409);
      operation.finalized = true;
      operation.updated_at = new Date().toISOString();
      await tx.put(`operation:${id}`, operation);
      if (await tx.get('active') === id) await tx.delete('active');
      return operation;
    });
  }

  async barrier(barrier: RepositoryBarrier): Promise<{ held: boolean; released: boolean; operation_id: string }> {
    return this.storage.transaction(async tx => {
      const previous = await tx.get<BarrierRecord>(`barrier-history:${barrier.operation_id}`);
      requireValue(!previous || previous.token_hash === barrier.token_hash, 'invalid_barrier', 'This maintenance operation belongs to another token.', 403);
      if (previous?.state === 'released') return { held: false, released: true, operation_id: barrier.operation_id };
      const active = await tx.get<RepositoryBarrier>('barrier');
      requireValue(!active || active.token_hash === barrier.token_hash && (!active.operation_id || active.operation_id === barrier.operation_id),
        'repository_fenced', 'Repository maintenance is already in progress.', 409);
      if (active) return { held: true, released: false, operation_id: barrier.operation_id };
      requireValue(barrier.acquire_before > new Date().toISOString(), 'barrier_request_expired', 'This maintenance acquisition expired before it could take effect.', 409);
      requireValue(!await tx.get('active'), 'publication_in_progress', 'A Git publication must finish before maintenance can start.', 409);
      await tx.put('barrier', barrier);
      await tx.put(`barrier-history:${barrier.operation_id}`, { ...barrier, state: 'held' } satisfies BarrierRecord);
      return { held: true, released: false, operation_id: barrier.operation_id };
    });
  }

  async releaseBarrier(operationId: string, tokenHash: string): Promise<{ held: false; released: true; operation_id: string }> {
    return this.storage.transaction(async tx => {
      const prior = await tx.get<BarrierRecord>(`barrier-history:${operationId}`);
      requireValue(!prior || prior.token_hash === tokenHash, 'invalid_barrier', 'Invalid repository maintenance token.', 403);
      const barrier = await tx.get<RepositoryBarrier>('barrier');
      if (barrier && (barrier.operation_id === operationId || !barrier.operation_id && barrier.token_hash === tokenHash)) {
        requireValue(barrier.token_hash === tokenHash, 'invalid_barrier', 'Invalid repository maintenance token.', 403);
        requireValue(!await tx.get('active'), 'publication_in_progress', 'The maintenance publisher must be reconciled before its barrier can be released.', 409);
        await tx.delete('barrier');
      }
      const at = new Date().toISOString();
      // A release that arrives before acquisition is a cancellation tombstone, not a no-op.
      // Compact tombstones are retained for the coordinator lifetime, covering the 30-day
      // request replay contract and forbidding deliberate reuse after that minimum window.
      await tx.put(`barrier-history:${operationId}`, { operation_id: operationId, token_hash: tokenHash,
        reason: prior?.reason ?? 'released-before-acquisition', created_at: prior?.created_at ?? at,
        acquire_before: prior?.acquire_before ?? at, state: 'released', released_at: prior?.released_at ?? at,
        replay_until: prior?.replay_until ?? new Date(Date.now() + 31 * 86400_000).toISOString() } satisfies BarrierRecord);
      return { held: false, released: true, operation_id: operationId };
    });
  }

  async checkBarrier(operationId: string, tokenHash: string, restoreOperationId?: string): Promise<{ held: true; operation_id: string }> {
    return this.storage.transaction(async tx => {
      const barrier = await tx.get<RepositoryBarrier>('barrier');
      requireValue(barrier?.operation_id === operationId && barrier.token_hash === tokenHash,
        'maintenance_barrier_required', 'The maintenance operation no longer owns this repository barrier.', 409);
      const id = await tx.get<string>('active');
      const publisher = id ? await tx.get<GitOperation>(`operation:${id}`) : undefined;
      requireValue(!id || restoreOperationId === operationId && id === operationId && publisher?.kind === 'restore'
        && publisher.maintenance?.operation_id === operationId, 'publication_in_progress', 'A publisher must be reconciled before this maintenance read.', 409);
      return { held: true, operation_id: operationId };
    });
  }

  private async change(id: string, update: (operation: GitOperation) => void): Promise<GitOperation> {
    return this.storage.transaction(async tx => {
      const operation = await new PublicationJournal(tx).get(id);
      update(operation);
      operation.updated_at = new Date().toISOString();
      await tx.put(`operation:${id}`, operation);
      return operation;
    });
  }

  private publisher(operation: GitOperation, publisher: string): void {
    if (operation.publisher_id !== publisher) throw new GitError('stale_publisher', 'This publisher does not own the operation.', 409);
  }
}
