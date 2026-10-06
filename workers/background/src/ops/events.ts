import { canonicalJson, one } from '@gitknot/core';
import { handleWorkflowEvent } from '@gitknot/execution';
import {
  claimConsumer, completion, consumeOnce, deferConsumer, enqueueConsumers, fanoutEvent,
} from '../../../../packages/operations/src/durable.ts';
import { scheduleMail } from '../../../../packages/operations/src/mail.ts';
import { projectUsage } from '../../../../packages/operations/src/meter.ts';
import { privateJSON, recordDiagnostic } from '../../../../packages/operations/src/private.ts';
import { indexEvent } from '../../../../packages/operations/src/search.ts';
import { enqueueDeliveries, scheduleWebhooks } from '../../../../packages/operations/src/webhooks.ts';
import type { Consumer, OperationsBindings } from '../../../../packages/operations/src/types.ts';
import { effectTarget, EVENT_RPC_SCOPE, eventReference, readCommittedEvent, retainEventSource, targetEnvironment, verifyEffectTarget } from '../../../../packages/operations/src/event-routing.ts';
import type { CommittedEvent, EffectTarget, EventReference } from '../../../../packages/operations/src/event-routing.ts';
import { backgroundCell } from '../../../../packages/operations/src/placement.ts';
import { consumeStorageDeletion } from '../../../../packages/operations/src/storage-cleanup.ts';

async function applyEvent(env: OperationsBindings, source: CommittedEvent, consumer: Consumer): Promise<void> {
  const db = env.DB.withSession('first-primary');
  const event = source.event;
  switch (consumer) {
    case 'webhooks': await scheduleWebhooks(env, event); await enqueueDeliveries(env); break;
    case 'mail': await scheduleMail(env, event); await enqueueDeliveries(env); break;
    case 'index': await indexEvent(env, event); break;
    case 'meter': await projectUsage(env, event); break;
    case 'operations':
      if (event.type === 'billing.storage.deletion_requested') await consumeStorageDeletion(env, event);
      else await handleWorkflowEvent(env, event);
      await consumeOnce(db, 'operations', event.id, [completion(db, 'operations', event.id)]);
      break;
  }
}

/** A handoff acknowledges completion only after the current placement's durable receipt. */
export async function receiveEventEffect(base: OperationsBindings, reference: EventReference, consumer: Consumer, target: EffectTarget): Promise<{ completed: boolean }> {
  const env = targetEnvironment(base, target);
  await verifyEffectTarget(env, target);
  const source = await readCommittedEvent(env, reference);
  const current = await effectTarget(env, source.event, consumer);
  if (canonicalJson(current) !== canonicalJson(target)) throw new Error('event_effect_target_changed');
  await retainEventSource(env, source, consumer, target);
  if (await one(env.DB, 'SELECT 1 FROM processed_events WHERE consumer=? AND event_id=?', consumer, reference.event_id)) return { completed: true };
  const lease = await claimConsumer(env, consumer, reference.event_id);
  if (!lease) return { completed: false };
  try { await applyEvent(env, source, consumer); }
  catch (error) { await deferConsumer(env, consumer, reference.event_id, lease); throw error; }
  return { completed: !!await one(env.DB, 'SELECT 1 FROM processed_events WHERE consumer=? AND event_id=?', consumer, reference.event_id) };
}

export async function consumeEvent(env: OperationsBindings, eventId: string, consumer?: Consumer): Promise<void> {
  const source = await readCommittedEvent(env, eventReference(env, eventId));
  if (!consumer) { await fanoutEvent(env, eventId); await enqueueConsumers(env); return; }
  if (!await one(env.DB, 'SELECT 1 FROM event_consumer_jobs WHERE event_id=? AND consumer=?', eventId, consumer)) await fanoutEvent(env, eventId);
  const lease = await claimConsumer(env, consumer, eventId);
  if (!lease) return;
  try {
    const db = env.DB.withSession('first-primary');
    const target = await effectTarget(env, source.event, consumer);
    if (target.cell_id === env.CELL_ID && target.shard_id === env.SHARD_ID) {
      await verifyEffectTarget(env, target);
      await applyEvent(env, source, consumer);
    } else {
      const result = target.cell_id === env.CELL_ID ? await receiveEventEffect(env, eventReference(env, eventId), consumer, target)
        : await privateJSON<{ completed: boolean }>(env, backgroundCell(env, target.cell_id), EVENT_RPC_SCOPE, '/internal/events/effect',
          { source: eventReference(env, eventId), consumer, target });
      if (!result.completed) throw new Error('event_effect_pending');
      await consumeOnce(db, consumer, eventId, [completion(db, consumer, eventId)]);
    }
  } catch (error) {
    await recordDiagnostic(env, `consumer:${consumer}`, eventId, error);
    await deferConsumer(env, consumer, eventId, lease);
    // The retry is now durable; Queues is only the wake-up transport.
  }
}

export async function artifactsSignal(env: OperationsBindings, value: unknown): Promise<void> {
  const event = value as { type?: string; source?: { namespace?: string; repoName?: string }; metadata?: { accountId?: string; eventSchemaVersion?: number } };
  if (!event.type?.startsWith('cf.artifacts.') || event.source?.namespace !== env.ARTIFACTS_NAMESPACE
    || event.metadata?.accountId !== env.ARTIFACTS_ACCOUNT_ID || event.metadata?.eventSchemaVersion !== 1) throw new Error('untrusted_artifacts_event');
  const repo = await one<{ id: string }>(env.DB.withSession('first-primary'), 'SELECT id FROM repositories WHERE storage_name=?', event.source?.repoName ?? '');
  if (!repo) return;
  // Upstream events have neither trustworthy actors nor stable occurrence IDs. They trigger reconciliation, never product event synthesis.
  await privateJSON(env, env.GIT_SERVICE, 'git-service', `/internal/git/repositories/${repo.id}/reconcile`, {});
}
