import { sha256 } from '@gitknot/core';
import { quoteExecution } from './catalog.ts';
import { admissionRequest } from './transport.ts';
import type {
  BillingBindings, CommitStorageInput, Reservation, ReservationIdentity, ReservationResult, ReserveExecutionInput,
  ReserveStorageInput, SettleExecutionInput, StartExecutionInput, StorageObject,
} from './types.ts';

function result(r: Reservation): ReservationResult {
  const queued = ['queued', 'preparing', 'prepared'].includes(r.state);
  return {
    status: queued ? 'queued' : r.state === 'starting' ? 'running' : r.state as ReservationResult['status'],
    account_id: r.quote.attribution.account_id, reservation_id: r.id, fence: r.fence, ticket: r.ticket,
    ...(queued ? { reason: r.state === 'queued' ? 'tenant_capacity' : 'platform_capacity' } : {}),
    maximum_charge_units: r.quote.maximum_charge_units, maximum_platform_units: r.quote.maximum_platform_units, deadline_at: r.deadline_at,
  };
}

export async function reserveExecution(env: BillingBindings, input: ReserveExecutionInput): Promise<ReservationResult> {
  const identity = `${input.account_id}:${input.attempt_id}:${input.generation}`;
  const id = `bres_${(await sha256(identity)).slice(0, 48)}`;
  const normalized = {
    account_id: input.account_id, repo_id: input.repo_id, actor_id: input.actor_id, workflow_id: input.workflow_id ?? null, team_id: input.team_id ?? null,
    run_id: input.run_id, attempt_id: input.attempt_id, generation: input.generation, executor: input.executor, profile: input.profile,
    maximum_duration_ms: input.maximum_duration_ms, maximum_storage_bytes: input.maximum_storage_bytes ?? '0',
    storage_retention_seconds: input.storage_retention_seconds ?? 0, maximum_egress_bytes: input.maximum_egress_bytes ?? '0',
  };
  const request_hash = await sha256(JSON.stringify(normalized));
  const fence = `bf_${await sha256(`${identity}:${request_hash}`)}`;
  const quote = await quoteExecution(env, normalized);
  const reservation = await admissionRequest<Reservation>(env, `account:${input.account_id}`, 'reserve', { id, fence, request_hash, quote });
  return result(reservation);
}

export async function startExecution(env: BillingBindings, input: StartExecutionInput): Promise<ReservationResult & { runtime_id: string }> {
  const r = await admissionRequest<Reservation>(env, `account:${input.account_id}`, 'start', input);
  return { ...result(r), runtime_id: r.runtime_id! };
}

export async function settleExecution(env: BillingBindings, input: SettleExecutionInput): Promise<ReservationResult & { actual_units: string }> {
  const r = await admissionRequest<Reservation>(env, `account:${input.account_id}`, 'settle', input);
  return { ...result(r), actual_units: r.actual_units! };
}

export async function cancelExecutionReservation(env: BillingBindings, input: ReservationIdentity): Promise<ReservationResult> {
  return result(await admissionRequest<Reservation>(env, `account:${input.account_id}`, 'cancel', input));
}

export async function reserveStorageObject(env: BillingBindings, input: ReserveStorageInput): Promise<StorageObject> {
  const bucket = input.bucket === 'backups' && /^backups\/[a-f0-9-]{36}\/(data\.sqsh|meta\.json)$/.test(input.key) ? 'snapshots' : input.bucket;
  return admissionRequest(env, `account:${input.account_id}`, 'storage-reserve', { ...input, bucket });
}

export async function commitStorageObject(env: BillingBindings, input: CommitStorageInput): Promise<StorageObject> {
  return admissionRequest(env, `account:${input.account_id}`, 'storage-commit', { ...input, checksum: input.checksum.replace(/^sha256:/, '') });
}

export async function accrueStorage(env: BillingBindings, input: { account_id: string; object_id: string; through?: string }): Promise<StorageObject> {
  return admissionRequest(env, `account:${input.account_id}`, 'storage-accrue', { object_id: input.object_id, through: input.through ?? new Date().toISOString() });
}

/** The coordinator itself performs delete + head verification; callers cannot assert deletion through a public API. */
export async function deleteStorageObject(env: BillingBindings, input: { account_id: string; object_id: string }): Promise<StorageObject> {
  return admissionRequest(env, `account:${input.account_id}`, 'storage-delete', { object_id: input.object_id });
}
