import { ApiError, newId, readBounded, verifyInternalRequest } from '@gitknot/core';
import { acceptDispatch } from '@gitknot/execution';
import { deliverMail, consumeEmailStatus } from '../../../../packages/operations/src/mail.ts';
import type { EmailProviderEvent } from '../../../../packages/operations/src/mail.ts';
import { operationalMetrics } from '../../../../packages/operations/src/meter.ts';
import { abortShardMove, moveAction, receiveMoveObject, recoverShardMove } from '../../../../packages/operations/src/movement.ts';
import { backgroundCell, cellShards, shardEnvironment } from '../../../../packages/operations/src/placement.ts';
import { privateJSON, recordDiagnostic } from '../../../../packages/operations/src/private.ts';
import { deliverWebhook } from '../../../../packages/operations/src/webhooks.ts';
import { consumers } from '../../../../packages/operations/src/types.ts';
import type { Consumer, OperationsBindings } from '../../../../packages/operations/src/types.ts';
import { artifactsSignal, consumeEvent } from './events.ts';
import { sweep } from './sweep.ts';
import { EVENT_RPC_SCOPE } from '../../../../packages/operations/src/event-routing.ts';
import { privateEventRequest } from './private-events.ts';
import { submitShardMove } from '../../../../packages/operations/src/move-request.ts';
import { accountExportPrivate } from '../../../../packages/operations/src/account-export.ts';

type MessageBody = { event_id?: string; consumer?: Consumer; delivery_id?: string; kind?: string; attempt_id?: string; run_id?: string; cell_id?: string; shard_id?: string; type?: string };

async function handleMessage(base: OperationsBindings, message: Message<unknown>, queueName: string): Promise<void> {
  const body = message.body as MessageBody;
  if (!body || typeof body !== 'object') throw new Error('invalid_queue_message');
  if (body.cell_id !== undefined && (typeof body.cell_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(body.cell_id))) throw new Error('invalid_source_cell');
  if (body.cell_id && body.cell_id !== base.CELL_ID && typeof body.event_id === 'string') {
    if (typeof body.shard_id !== 'string') throw new Error('event_source_shard_required');
    const receipt = await privateJSON<{ accepted: boolean }>(base, backgroundCell(base, body.cell_id), EVENT_RPC_SCOPE, '/internal/events/consume',
      { event_id: body.event_id, consumer: body.consumer, cell_id: body.cell_id, shard_id: body.shard_id });
    if (!receipt.accepted) throw new Error('event_source_handoff_unconfirmed');
    return;
  }
  if (body.cell_id && body.cell_id !== base.CELL_ID && !body.delivery_id && !body.attempt_id) throw new Error('queue_source_cell_mismatch');
  if (body.type?.startsWith('cf.email.sending.')) {
    for (const shard of cellShards(base)) await consumeEmailStatus(shard, body as unknown as EmailProviderEvent);
    return;
  }
  if (body.type?.startsWith('cf.artifacts.')) {
    for (const shard of cellShards(base)) await artifactsSignal(shard, body);
    return;
  }
  const env = shardEnvironment(base, typeof body.shard_id === 'string' ? body.shard_id : base.SHARD_ID);
  if (typeof body.attempt_id === 'string') { await acceptDispatch(env, body as Parameters<typeof acceptDispatch>[1]); return; }
  if (typeof body.delivery_id === 'string') {
    if (body.kind === 'mail' || /-mail(?:-dlq)?$/.test(queueName)) await deliverMail(env, body.delivery_id);
    else if (body.kind === 'webhook' || /-webhooks(?:-dlq)?$/.test(queueName)) await deliverWebhook(env, body.delivery_id);
    else throw new Error('unknown_delivery_queue');
    return;
  }
  if (typeof body.event_id === 'string') {
    const consumer = body.consumer ?? (/-indexing(?:-dlq)?$/.test(queueName) ? 'index' : /-metering(?:-dlq)?$/.test(queueName) ? 'meter' : undefined);
    if (consumer && !consumers.includes(consumer)) throw new Error('unknown_event_consumer');
    await consumeEvent(env, body.event_id, consumer);
    return;
  }
  throw new Error('unknown_queue_message');
}

export default {
  async scheduled(_controller: ScheduledController, env: OperationsBindings): Promise<void> {
    let failed = 0;
    for (const shard of cellShards(env)) {
      try { failed += (await sweep(shard)).failed; }
      catch (error) { failed++; console.error(JSON.stringify({ component: 'scheduled-shard', shard_id: shard.SHARD_ID, error: error instanceof Error ? error.message : String(error) })); }
    }
    if (failed) throw new Error(`background_recovery_tasks_failed:${failed}`);
  },
  async queue(batch: MessageBatch<unknown>, env: OperationsBindings): Promise<void> {
    // Bound per-isolate fanout; slow recipients already have independently leased durable rows.
    for (let offset = 0; offset < batch.messages.length; offset += 4) {
      await Promise.all(batch.messages.slice(offset, offset + 4).map(async (message) => {
        try { await handleMessage(env, message, batch.queue); message.ack(); }
        catch (error) {
          await recordDiagnostic(env, 'queue', message.id, error);
          message.retry({ delaySeconds: 30 });
        }
      }));
    }
  },
  async fetch(request: Request, env: OperationsBindings): Promise<Response> {
    const requestId = newId('request');
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/internal/')) return new Response(null, { status: 404 });
      const moving = url.pathname.startsWith('/internal/moves/');
      const events = url.pathname.startsWith('/internal/events/');
      const streaming = url.pathname === '/internal/moves/object' && request.method === 'PUT';
      await verifyInternalRequest(request, env.INTERNAL_SERVICE_KEY, moving ? 'operations.move' : events ? EVENT_RPC_SCOPE : 'operations.maintenance', { database: env.DB, streaming });
      if (streaming) return await receiveMoveObject(shardEnvironment(env, url.searchParams.get('shard_id') ?? env.SHARD_ID), request);
      const value: unknown = request.method === 'GET' ? {} : JSON.parse(new TextDecoder().decode(await readBounded(request.body, 4 * 1024 * 1024)));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, 'invalid_request', 'The request body must be an object.');
      const body = value as Record<string, unknown>;
      if (url.pathname.startsWith('/internal/account-exports/') && request.method === 'POST') return accountExportPrivate(env, url.pathname, body);
      if (events) {
        if (request.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'This private method requires POST.');
        return await privateEventRequest(env, url.pathname, body);
      }
      if (moving) {
        if (request.method !== 'POST' || typeof body.target_shard_id !== 'string') throw new ApiError(400, 'invalid_request', 'A destination shard is required.');
        return Response.json(await moveAction(shardEnvironment(env, body.target_shard_id), url.pathname.split('/').at(-1)!, body));
      }
      if (url.pathname === '/internal/operations/metrics' && request.method === 'GET') return Response.json({ shards:
        await Promise.all(cellShards(env).map(async shard => ({ cell_id: shard.CELL_ID, shard_id: shard.SHARD_ID, metrics: await operationalMetrics(shard) }))) });
      if (url.pathname === '/internal/operations/sweep' && request.method === 'POST') {
        const shards = typeof body.shard_id === 'string' ? [shardEnvironment(env, body.shard_id)] : cellShards(env);
        let succeeded = 0, failed = 0;
        for (const shard of shards) {
          const result = await sweep(shard); succeeded += result.succeeded; failed += result.failed;
        }
        return Response.json({ succeeded, failed }, { status: failed ? 503 : 200 });
      }
      if (['/internal/operations/move', '/internal/operations/restore'].includes(url.pathname) && request.method === 'POST') {
        return await submitShardMove(env, body, url.pathname.endsWith('/restore'));
      }
      if (['/internal/operations/move-recover', '/internal/operations/move-abort'].includes(url.pathname) && request.method === 'POST') {
        if (typeof body.operation_id !== 'string' || !/^op_[A-Za-z0-9_-]{1,120}$/.test(body.operation_id)) throw new ApiError(400, 'invalid_move_operation', 'A durable move operation ID is required.');
        return Response.json(await (url.pathname.endsWith('move-abort') ? abortShardMove(env, body.operation_id) : recoverShardMove(env, body.operation_id)));
      }
      return new Response(null, { status: 404 });
    } catch (error) {
      await recordDiagnostic(env, 'private-api', requestId, error);
      return Response.json({ error: { code: error instanceof ApiError ? error.code : 'operation_unavailable',
        message: 'The private operation could not be confirmed.', request_id: requestId } }, { status: error instanceof ApiError ? error.status : 503 });
    }
  },
} satisfies ExportedHandler<OperationsBindings, unknown>;
