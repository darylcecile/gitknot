import { CloudflareClient, object, result } from './cf-client.ts';
import type { Environment, ResourceState } from './environment.ts';
import type { ResourceSpec } from './inventory.ts';

/** Reconcile mutable settings on adopted resources, then verify their real value. */
export async function reconcileResourcePolicy(client: CloudflareClient, env: Environment, spec: ResourceSpec, resource: ResourceState): Promise<void> {
  if (spec.kind === 'artifacts') return; // Namespace jurisdiction is immutable and checked during adoption.
  const jurisdiction = env.jurisdiction ? ['--cf-r2-jurisdiction', env.jurisdiction] : [];
  const policy = spec.kind === 'd1' ? {
    read: ['d1', 'get', resource.id],
    apply: ['d1', 'update', resource.id, '--read-replication-mode', 'auto'],
    matches: (value: Record<string, unknown>) => value.read_replication && object(value.read_replication).mode === 'auto',
  } : spec.kind === 'queue' ? {
    read: ['queues', 'get', resource.id],
    apply: ['queues', 'edit', resource.id, '--settings-message-retention-period', String(14 * 86400)],
    matches: (value: Record<string, unknown>) => value.settings && object(value.settings).message_retention_period === 14 * 86400,
  } : {
    read: ['r2', 'buckets', 'get', resource.name, ...jurisdiction],
    apply: ['r2', 'buckets', 'edit', resource.name, ...jurisdiction, '--cf-r2-storage-class', 'Standard'],
    matches: (value: Record<string, unknown>) => value.storageClass === 'Standard',
  };
  const current = object(result(await client.read(policy.read, spec.account)));
  if (policy.matches(current)) return;
  await client.apply(policy.apply, spec.account);
  const updated = object(result(await client.read(policy.read, spec.account)));
  if (!policy.matches(updated)) throw new Error(`Managed policy for ${spec.name} failed provider read-back verification.`);
}
