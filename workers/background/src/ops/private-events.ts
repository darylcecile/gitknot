import { z } from 'zod';
import { ApiError, resolveRepositoryPlacement } from '@gitknot/core';
import { readCommittedEvent, targetEnvironment, verifyEffectTarget } from '../../../../packages/operations/src/event-routing.ts';
import { consumeEmailStatus, deliverMail } from '../../../../packages/operations/src/mail.ts';
import type { EmailProviderEvent } from '../../../../packages/operations/src/mail.ts';
import { deliverWebhook } from '../../../../packages/operations/src/webhooks.ts';
import { shardEnvironment } from '../../../../packages/operations/src/placement.ts';
import type { OperationsBindings } from '../../../../packages/operations/src/types.ts';
import { consumeEvent, receiveEventEffect } from './events.ts';
import { readReplayPage } from '../../../../packages/operations/src/replay.ts';
import { produceCodeScanPage } from '../../../../packages/operations/src/code-scans.ts';
import { executionEventRequirements } from '../../../../packages/operations/src/execution-audience.ts';
import { sourceEvent } from '../../../../packages/operations/src/durable.ts';
import { principalSchema } from '../../../../packages/secrets/src/schema.ts';

const identifier = z.string().min(1).max(256);
const location = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const sourceSchema = z.object({ event_id: identifier, cell_id: location, shard_id: location }).strict();
const consumerSchema = z.enum(['webhooks', 'mail', 'index', 'meter', 'operations']);
const targetSchema = z.object({ cell_id: location, shard_id: location, repo_id: identifier.nullable(), epoch: z.number().int().positive().nullable() }).strict();

export async function privateEventRequest(env: OperationsBindings, path: string, body: unknown): Promise<Response> {
  if (path === '/internal/events/audience') {
    const input = z.object({ repo_id: identifier, event_id: identifier, principal: principalSchema }).strict().parse(body);
    const placement = await resolveRepositoryPlacement(env, input.repo_id);
    if (!placement || placement.cell_id !== env.CELL_ID) throw new ApiError(409, 'event_placement_changed', 'The event audience moved.');
    const local = shardEnvironment(env, placement.shard_id), event = await sourceEvent(local.DB, input.event_id);
    if (!event || event.repo_id !== input.repo_id) throw new ApiError(503, 'event_source_unconfirmed', 'The event source could not be confirmed.');
    return Response.json(await executionEventRequirements(local, input.principal, event));
  }
  if (path === '/internal/events/scan-page') {
    const input = z.object({ operation_id: identifier, repo_id: identifier, cursor: identifier.nullable(), shard_id: location }).strict().parse(body);
    return Response.json(await produceCodeScanPage(shardEnvironment(env, input.shard_id), input));
  }
  if (path === '/internal/events/replay-page') {
    const source = z.object({ replay_id: identifier, repo_id: identifier, cell_id: location, shard_id: location, cursor: identifier.nullable() }).strict().parse(body);
    if (source.cell_id !== env.CELL_ID) throw new Error('replay_source_cell_mismatch');
    return Response.json(await readReplayPage(env, source));
  }
  if (path === '/internal/events/source') {
    const source = sourceSchema.parse(body);
    if (source.cell_id !== env.CELL_ID) throw new ApiError(409, 'event_source_cell_mismatch', 'This cell does not own the declared event source.');
    return Response.json(await readCommittedEvent(env, source));
  }
  if (path === '/internal/events/consume') {
    const input = sourceSchema.extend({ consumer: consumerSchema.optional() }).strict().parse(body);
    if (input.cell_id !== env.CELL_ID) throw new ApiError(409, 'event_source_cell_mismatch', 'This cell does not own the declared event source.');
    await consumeEvent(shardEnvironment(env, input.shard_id), input.event_id, input.consumer);
    return Response.json({ accepted: true });
  }
  if (path === '/internal/events/effect') {
    const input = z.object({ source: sourceSchema, consumer: consumerSchema, target: targetSchema }).strict().parse(body);
    return Response.json(await receiveEventEffect(env, input.source, input.consumer, input.target));
  }
  if (path === '/internal/events/delivery') {
    const input = z.object({ delivery_id: identifier, kind: z.enum(['mail', 'webhook']), target: targetSchema }).strict().parse(body);
    const target = targetEnvironment(env, input.target);
    await verifyEffectTarget(target, input.target);
    if (input.kind === 'mail') await deliverMail(target, input.delivery_id);
    else await deliverWebhook(target, input.delivery_id);
    return Response.json({ accepted: true });
  }
  if (path === '/internal/events/email-status') {
    const input = z.object({ event: z.record(z.string(), z.unknown()), target: targetSchema }).strict().parse(body);
    const target = targetEnvironment(env, input.target);
    await verifyEffectTarget(target, input.target);
    await consumeEmailStatus(target, input.event as unknown as EmailProviderEvent);
    return Response.json({ accepted: true });
  }
  return new Response(null, { status: 404 });
}
