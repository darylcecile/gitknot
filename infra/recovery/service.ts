import { signInternalRequest } from '../../packages/core/src/internal.ts';
import { z } from 'zod';

export interface MoveRequest { repo_id: string; target_cell_id: string; target_shard_id: string; expected_epoch: number }

/** Worker-safe adapter: no Node filesystem, process, local runtime or config imports. */
export async function requestShardMove(background: Pick<Fetcher, 'fetch'>, key: string, input: MoveRequest): Promise<{ id: string; status: string }> {
  const request = new Request('https://internal.gitknot.com/internal/operations/move', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  });
  const response = await background.fetch(await signInternalRequest(request, key, 'operations.maintenance'));
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Shard move was not accepted (${response.status}).`); }
  return z.object({ id: z.string().min(1), status: z.enum(['pending', 'waiting', 'running', 'failed', 'completed', 'cancelled']) }).parse(await response.json());
}

export async function recoverPhysicalMove(background: Pick<Fetcher, 'fetch'>, key: string, operationId: string, abort = false): Promise<Record<string, unknown>> {
  if (!/^op_[A-Za-z0-9_-]{1,120}$/.test(operationId)) throw new Error('A durable move operation ID is required.');
  const request = new Request(`https://internal.gitknot.com/internal/operations/move-${abort ? 'abort' : 'recover'}`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation_id: operationId }) });
  const response = await background.fetch(await signInternalRequest(request, key, 'operations.maintenance'));
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Physical move ${abort ? 'rollback' : 'recovery'} remains pending (${response.status}).`); }
  return z.record(z.string(), z.unknown()).parse(await response.json());
}
