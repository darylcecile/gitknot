import { CloudflareClient, object, records, result } from './cf-client.ts';
import { resourceName, type Environment } from './environment.ts';
import { digest } from './planning.ts';
import { writeJson } from './process.ts';

export function eventSubscriptions(env: Environment, zoneId = env.state.zone_id) {
  return [
    {
      key: 'subscription.artifacts', name: resourceName(env, 'artifacts-lifecycle'), queue_key: 'queue.artifacts-events',
      source: { type: 'artifacts' }, events: ['repo.created', 'repo.deleted', 'repo.forked', 'repo.imported'],
    },
    {
      key: 'subscription.mail', name: resourceName(env, 'mail-status'), queue_key: 'queue.mail',
      source: { type: 'email.sending', domain: env.mode === 'production' ? 'mail.gitknot.com' : 'mail.staging.gitknot.com', ...(zoneId ? { zone_id: zoneId } : {}) },
      events: ['message.delivered', 'message.deferred', 'message.bounced', 'message.failed', 'message.rejected', 'message.complained'],
    },
  ];
}

async function list(client: CloudflareClient) {
  const values: Record<string, unknown>[] = [];
  for (let page = 1; page <= 10_000; page++) {
    const batch = records(await client.read(['queues', 'subscriptions', 'list', '--page', String(page), '--per-page', '100']));
    values.push(...batch);
    if (batch.length < 100) return values;
  }
  throw new Error('Subscription pagination exceeded its bounded limit.');
}

export async function provisionEventSubscriptions(client: CloudflareClient, env: Environment): Promise<void> {
  let existing = await list(client);
  for (const spec of eventSubscriptions(env)) {
    const queueId = env.state.resources[spec.queue_key]?.id;
    if (!queueId) throw new Error(`Resolve ${spec.queue_key} before event subscriptions.`);
    const body = { name: spec.name, enabled: true, source: spec.source, events: spec.events, destination: { type: 'queues.queue', queue_id: queueId } };
    let found = existing.find(value => value.name === spec.name);
    if (!found) {
      // These documented sources are newer than the beta CLI's convenience
      // enum. The supported raw --body path preserves the full API shape.
      found = object(result(await client.apply(['queues', 'subscriptions', 'create', '--body', JSON.stringify(body)])));
      existing = await list(client);
      found = existing.find(value => value.id === found!.id);
    }
    if (!found || typeof found.id !== 'string' || found.enabled !== true
      || digest(found.destination) !== digest(body.destination) || digest(found.events) !== digest(body.events)
      || !Object.entries(spec.source).every(([key, value]) => object(found!.source)[key] === value)) {
      throw new Error(`Event subscription ${spec.name} differs from its reviewed source/queue/event scope.`);
    }
    env.state.resources[spec.key] = { id: found.id, name: spec.name, kind: 'event-subscription', account_id: env.accounts.trusted!, spec_sha256: digest(body), observed_at: new Date().toISOString() };
    await writeJson(env.statePath, env.state);
  }
}
