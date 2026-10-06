import { createHash } from 'node:crypto';
import { CloudflareClient, object, records, result, type JsonObject } from './cf-client.ts';
import { resources, topology, type ResourceKind, type ResourceSpec } from './inventory.ts';
import type { Environment, ResourceState } from './environment.ts';
import { observeVersionOwned, type VersionOwnedObservation } from './observations.ts';
import { resolveHostnameZone, resolveNamedZone, type OwnedZone } from './zones.ts';

export interface PlannedResource {
  spec: ResourceSpec;
  action: 'resolve' | 'create' | 'adopt';
  observed?: ResourceState;
}

export interface ResourcePlan {
  version: 1;
  mode: Environment['mode'];
  cell_id: string;
  execution_cell_id: string;
  generated_at: string;
  resolved: boolean;
  spec_sha256: string;
  zone_id?: string;
  hosted_zone?: OwnedZone;
  resources: PlannedResource[];
  infrastructure: ReturnType<typeof topology>;
  observations?: { dns: JsonObject[]; email_limits: unknown; email_domains: JsonObject[]; rulesets: JsonObject[]; hosted_dns?: JsonObject[] };
  version_owned?: VersionOwnedObservation[];
}

export function digest(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonical(value)]));
    return input;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
}

export function offlinePlan(env: Environment): ResourcePlan {
  const infrastructure = topology(env);
  return {
    version: 1, mode: env.mode, cell_id: env.cell, execution_cell_id: env.executionCell,
    generated_at: new Date().toISOString(), resolved: false,
    spec_sha256: digest({ mode: env.mode, cell: env.cell, executionCell: env.executionCell, directoryCell: env.directoryCell, identityCell: env.identityCell, ingressCell: env.ingressCell, peers: env.peers, recovery: env.recovery, accounts: env.accounts, remoteExecutor: env.remoteExecutor, previousHostedKeys: env.previousHostedKeyBindings, resources: resources(env), policies: infrastructure.bucket_policies, ingress: infrastructure.ingress, waf: infrastructure.waf, hosted: infrastructure.hosted ? { executor: infrastructure.hosted.executor, rate_limits: infrastructure.hosted.rate_limits, waf: infrastructure.hosted.waf } : undefined, subscriptions: infrastructure.event_subscriptions }),
    resources: resources(env).map(spec => ({ spec, action: 'resolve' })), infrastructure,
  };
}

const LIST: Record<ResourceKind, string[]> = {
  d1: ['d1', 'list'], r2: ['r2', 'buckets', 'list'], queue: ['queues', 'list'], artifacts: ['artifacts', 'namespaces', 'list'],
};
export const CREATE: Record<ResourceKind, string[]> = {
  d1: ['d1', 'create'], r2: ['r2', 'buckets', 'create'], queue: ['queues', 'create'], artifacts: ['artifacts', 'namespaces', 'create'],
};

function nextCursor(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = object(value);
  const cursor = data.cursor ?? data.next_cursor ?? (data.result_info && typeof data.result_info === 'object' ? object(data.result_info).cursor : undefined);
  return typeof cursor === 'string' && cursor ? cursor : undefined;
}

async function listResources(client: CloudflareClient, env: Environment, spec: ResourceSpec): Promise<JsonObject[]> {
  const found: JsonObject[] = [];
  let cursor: string | undefined;
  for (let page = 1; page <= 10_000; page++) {
    const args = [...LIST[spec.kind]];
    if (spec.kind === 'd1') args.push('--per-page', '1000', '--page', String(page));
    if (spec.kind === 'r2') args.push('--per-page', '1000', '--name-contains', `gitknot-${env.mode}-`);
    if (spec.kind === 'artifacts') args.push('--limit', '1000');
    if (cursor) args.push('--cursor', cursor);
    if (spec.kind === 'r2' && env.jurisdiction) args.push('--cf-r2-jurisdiction', env.jurisdiction);
    const response = await client.read(args, spec.account);
    const batch = records(response);
    found.push(...batch);
    const next = nextCursor(response) ?? nextCursor(result(response));
    if (spec.kind === 'd1' && batch.length === 1000) continue;
    if (!next) return found;
    if (next === cursor) throw new Error('Cloudflare repeated a pagination cursor.');
    cursor = next;
  }
  throw new Error('Cloudflare resource pagination exceeded its bounded limit.');
}

export function observedResource(env: Environment, spec: ResourceSpec, value: JsonObject): ResourceState {
  const id = value.uuid ?? value.id ?? value.queue_id ?? (spec.kind === 'artifacts' ? value.namespace ?? value.name : undefined) ?? (spec.kind === 'r2' ? value.name : undefined);
  if (typeof id !== 'string' || !id) throw new Error(`Cloudflare returned no stable identifier for ${spec.key}.`);
  const account = env.accounts[spec.account];
  if (!account) throw new Error(`Missing ${spec.account} account.`);
  if (value.jurisdiction && env.jurisdiction && value.jurisdiction !== env.jurisdiction) throw new Error(`${spec.name} is in a different jurisdiction.`);
  const existing = env.state.resources[spec.key];
  if (existing && (existing.id !== id || existing.name !== spec.name || existing.account_id !== account)) {
    throw new Error(`Recorded identity for ${spec.key} differs from Cloudflare. Resolve the state conflict before applying.`);
  }
  return { id, name: spec.name, kind: spec.kind, account_id: account, observed_at: new Date().toISOString() };
}

export async function findResource(client: CloudflareClient, env: Environment, spec: ResourceSpec): Promise<ResourceState | undefined> {
  const values = await listResources(client, env, spec);
  const matches = values.filter(value => (value.name ?? value.queue_name ?? value.namespace) === spec.name);
  if (matches.length > 1) throw new Error(`More than one ${spec.kind} matches ${spec.name}.`);
  return matches[0] ? observedResource(env, spec, matches[0]) : undefined;
}

export async function resolveZone(client: CloudflareClient, env: Environment): Promise<string> {
  const zone = await resolveNamedZone(client, env, 'trusted', 'gitknot.com');
  if (env.state.zone_id && zone.id !== env.state.zone_id) throw new Error('The zone ID differs from recorded operator state.');
  return zone.id;
}

export async function resolveHostedZone(client: CloudflareClient, env: Environment): Promise<OwnedZone | undefined> {
  if (!env.remoteExecutor) return undefined;
  const zone = await resolveHostnameZone(client, env, 'execution', new URL(env.remoteExecutor.origin).hostname);
  if (env.state.hosted_zone_id && env.state.hosted_zone_id !== zone.id) throw new Error('The hosted origin zone differs from recorded operator state.');
  return zone;
}

function safeDns(record: JsonObject): JsonObject {
  return Object.fromEntries(['id', 'name', 'type', 'content', 'proxied', 'ttl'].map(key => [key, record[key]]));
}

export async function resolvePlan(env: Environment): Promise<ResourcePlan> {
  if (env.mode === 'development') throw new Error('Development uses local workerd resources. Remote resolution requires staging or production.');
  const client = new CloudflareClient(env);
  const plan = offlinePlan(env);
  const zoneId = await resolveZone(client, env);
  const hostedZone = await resolveHostedZone(client, env);
  const resolved: PlannedResource[] = [];
  // Resource lookups deliberately use exact names and bounded, paginated reads.
  for (const item of plan.resources) {
    const observed = await findResource(client, env, item.spec);
    if (item.spec.existing && !observed) throw new Error(`Shared authority ${item.spec.name} must already exist; initialize its owning cell first.`);
    resolved.push({ spec: item.spec, action: observed ? 'adopt' : 'create', ...(observed ? { observed } : {}) });
  }
  const hostnames = Object.values(env.origins).map(origin => new URL(origin).hostname);
  const [dns, emailLimits, emailDomains, rulesets, versionOwned] = await Promise.all([
    Promise.all(hostnames.map(host => client.read(['dns', 'records', 'list', '--zone', zoneId, '--name', host, '--per-page', '100']))),
    client.read(['email-sending', 'limits', 'get']),
    client.read(['email-sending', 'subdomains', 'list', '--zone', zoneId]),
    client.read(['rulesets', 'account-rulesets', 'list', '--zone', zoneId, '--per-page', '100']),
    observeVersionOwned(client, env),
  ]);
  const hostedDns = hostedZone ? records(await client.read(['dns', 'records', 'list', '--zone', hostedZone.id, '--name', new URL(env.remoteExecutor!.origin).hostname, '--per-page', '100'], 'execution')).map(safeDns) : undefined;
  return { ...plan, resolved: true, zone_id: zoneId, hosted_zone: hostedZone, resources: resolved, version_owned: versionOwned,
    observations: { dns: dns.flatMap(value => records(value).map(safeDns)), email_limits: result(emailLimits), email_domains: records(emailDomains), rulesets: records(rulesets), hosted_dns: hostedDns },
  };
}
