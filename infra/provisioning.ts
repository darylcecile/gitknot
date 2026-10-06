import { open, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CloudflareClient, object, records, result, type JsonObject } from './cf-client.ts';
import { bucketPolicies, hostedIngressRules, hostedWafRules, ingressRules, resources, wafRules, type ResourceSpec } from './inventory.ts';
import { CREATE, digest, findResource, observedResource, offlinePlan, resolveHostedZone, resolveZone, type ResourcePlan } from './planning.ts';
import { ROOT, stateSchema, type AccountRole, type Environment } from './environment.ts';
import { writeJson } from './process.ts';
import { provisionEventSubscriptions } from './subscriptions.ts';
import { reconcileResourcePolicy } from './resource-policies.ts';

async function saveState(env: Environment): Promise<void> {
  env.state.updated_at = new Date().toISOString();
  await writeJson(env.statePath, stateSchema.parse(env.state));
}

async function provisionResource(client: CloudflareClient, env: Environment, spec: ResourceSpec): Promise<void> {
  let observed = await findResource(client, env, spec);
  if (spec.existing && !observed) throw new Error(`Shared authority ${spec.name} is absent. This metadata-cell plan cannot create a substitute identity authority.`);
  if (!observed) {
    const jurisdiction = spec.kind === 'r2' && env.jurisdiction ? ['--cf-r2-jurisdiction', env.jurisdiction] : [];
    try {
      const response = await client.apply([...CREATE[spec.kind], ...jurisdiction, '--body', JSON.stringify(spec.body)], spec.account);
      observed = observedResource(env, spec, object(result(response), `Created ${spec.kind}`));
    } catch (error) {
      // A timed-out creation may have succeeded. Adopt only a fresh, exact-name
      // read; a failure is never converted to a made-up identifier.
      observed = await findResource(client, env, spec);
      if (!observed) throw error;
    }
  }
  env.state.resources[spec.key] = observed;
  await saveState(env);
  if (!spec.existing) await reconcileResourcePolicy(client, env, spec, observed);
  env.state.resources[spec.key] = { ...observed, spec_sha256: digest(spec.body) };
  await saveState(env);
  console.log(`Resolved ${spec.key}: ${spec.name}`);
}

function mergeRules(current: JsonObject, desired: JsonObject): JsonObject {
  const newRules = desired.rules;
  if (!Array.isArray(newRules)) return desired;
  const oldRules = current.rules;
  if (oldRules !== undefined && !Array.isArray(oldRules)) throw new Error('Unexpected provider policy shape.');
  const keys = new Set(newRules.map(rule => object(rule).id ?? object(rule).ref));
  const retained = (oldRules as unknown[] | undefined ?? []).filter(rule => !keys.has(object(rule).id ?? object(rule).ref));
  return { ...desired, rules: [...retained, ...newRules] };
}

async function provisionBucketPolicies(client: CloudflareClient, env: Environment): Promise<void> {
  for (const spec of bucketPolicies(env)) {
    const current = object(result(await client.read(spec.read, spec.account)));
    const body = mergeRules(current, spec.body);
    const relevant = Object.fromEntries(Object.keys(body).map(key => [key, current[key]]));
    if (digest(relevant) === digest(body)) continue;
    const force = spec.apply.includes('lifecycle') || spec.apply.includes('locks') ? ['--force'] : [];
    await client.apply([...spec.apply, ...force, '--body', JSON.stringify(body)], spec.account);
    const updated = object(result(await client.read(spec.read, spec.account)));
    for (const [key, value] of Object.entries(body)) {
      if (digest(updated[key]) !== digest(value)) throw new Error(`Policy ${spec.key} failed read-back verification.`);
    }
    console.log(`Applied ${spec.key}.`);
  }
}

function matches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => matches(actual[index], value));
  if (expected && typeof expected === 'object') return Boolean(actual && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => matches((actual as JsonObject)[key], value)));
  return actual === expected;
}

async function provisionRuleset(client: CloudflareClient, env: Environment, zone: string, desired: ReturnType<typeof ingressRules> | ReturnType<typeof wafRules> | ReturnType<typeof hostedIngressRules> | ReturnType<typeof hostedWafRules>, stateKey: string, account: AccountRole = 'trusted'): Promise<void> {
  const summaries = records(await client.read(['rulesets', 'account-rulesets', 'list', '--zone', zone, '--per-page', '100'], account));
  const candidates = summaries.filter(value => value.phase === desired.phase && value.kind === 'zone');
  if (candidates.length > 1) throw new Error('More than one zone rate-limit entrypoint exists.');
  const summary = candidates[0];
  let id: string;
  if (summary) {
    if (typeof summary.id !== 'string') throw new Error('Ruleset ID missing.');
    id = summary.id;
    const current = object(result(await client.read(['rulesets', 'account-rulesets', 'get', id, '--zone', zone], account)));
    const targetRefs = new Set(desired.rules.map(rule => rule.ref));
    const rules = (Array.isArray(current.rules) ? current.rules : []).map(value => object(value));
    const matched = rules.filter(rule => targetRefs.has(String(rule.ref)));
    const clean = (rule: JsonObject) => Object.fromEntries(Object.entries(rule).filter(([key]) => !['id', 'version', 'last_updated'].includes(key)));
    if (matched.length !== desired.rules.length || !desired.rules.every(rule => matches(matched.find(current => current.ref === rule.ref), rule))) {
      const retained = rules.filter(rule => !targetRefs.has(String(rule.ref))).map(clean);
      await client.apply(['rulesets', 'account-rulesets', 'update', id, '--zone', zone, '--body', JSON.stringify({ ...desired, name: current.name ?? desired.name, rules: [...retained, ...desired.rules] })], account);
    }
  } else {
    const created = object(result(await client.apply(['rulesets', 'account-rulesets', 'create', '--zone', zone, '--body', JSON.stringify(desired)], account)));
    if (typeof created.id !== 'string') throw new Error('Created ruleset ID missing.');
    id = created.id;
  }
  const verified = object(result(await client.read(['rulesets', 'account-rulesets', 'get', id, '--zone', zone], account)));
  const verifiedRules = (Array.isArray(verified.rules) ? verified.rules : []).map(rule => object(rule));
  if (desired.rules.some(rule => !matches(verifiedRules.find(actual => actual.ref === rule.ref), rule))) throw new Error('Ingress rules failed read-back verification.');
  env.state.resources[stateKey] = { id, kind: 'ruleset', name: desired.name, account_id: env.accounts[account]!, spec_sha256: digest(desired), observed_at: new Date().toISOString() };
  await saveState(env);
}

async function provisionMail(client: CloudflareClient, env: Environment, zone: string): Promise<void> {
  const name = env.mode === 'production' ? 'mail.gitknot.com' : 'mail.staging.gitknot.com';
  let domains = records(await client.read(['email-sending', 'subdomains', 'list', '--zone', zone]));
  if (!domains.some(domain => domain.name === name && domain.enabled !== false)) {
    await client.apply(['email-sending', 'subdomains', 'create', '--zone', zone, '--name', name]);
    domains = records(await client.read(['email-sending', 'subdomains', 'list', '--zone', zone]));
  }
  const domain = domains.find(value => value.name === name && value.enabled !== false);
  if (!domain) throw new Error('Email sending subdomain failed read-back verification.');
  env.state.resources['email.domain'] = { id: String(domain.id ?? name), name, kind: 'email', account_id: env.accounts.trusted!, observed_at: new Date().toISOString() };
  await saveState(env);
}

export async function applyPlan(env: Environment, plan: ResourcePlan): Promise<void> {
  if (env.mode === 'development' || !plan.resolved || !plan.zone_id) throw new Error('Apply requires a remotely resolved staging/production plan.');
  if (plan.spec_sha256 !== offlinePlan(env).spec_sha256 || plan.mode !== env.mode || plan.cell_id !== env.cell || plan.execution_cell_id !== env.executionCell) {
    throw new Error('The reviewed plan does not match the current mode, cell, accounts, or desired resource specification.');
  }
  const lock = `${env.statePath}.lock`;
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  const handle = await open(lock, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    const client = new CloudflareClient(env, true);
    if (await resolveZone(client, env) !== plan.zone_id) throw new Error('The reviewed plan targets a different zone than the existing gitknot.com zone.');
    const hostedZone = await resolveHostedZone(client, env);
    if (env.remoteExecutor && (!hostedZone || !plan.hosted_zone || hostedZone.id !== plan.hosted_zone.id || hostedZone.account_id !== plan.hosted_zone.account_id)) throw new Error('The hosted execution origin zone differs from the reviewed plan.');
    // The lock protects only local state; provider-side exact-name reads still
    // precede every create, including retries after interrupted applications.
    env.state.accounts = env.accounts;
    env.state.zone_id = plan.zone_id;
    if (hostedZone) {
      env.state.hosted_zone_id = hostedZone.id;
      env.state.hosted_zone_name = hostedZone.name;
    }
    for (const observation of plan.version_owned ?? []) {
      // This is an observation of an existing version-owned resource. Only a
      // later operator rollout can create/update these resources.
      env.state.resources[observation.key] = observation.resource;
    }
    for (const spec of resources(env)) await provisionResource(client, env, spec);
    await provisionBucketPolicies(client, env);
    await provisionRuleset(client, env, plan.zone_id, ingressRules(env), 'zone.ratelimit');
    await provisionRuleset(client, env, plan.zone_id, wafRules(env), 'zone.waf');
    if (hostedZone) {
      await provisionRuleset(client, env, hostedZone.id, hostedIngressRules(env), 'zone.hosted-ratelimit', 'execution');
      await provisionRuleset(client, env, hostedZone.id, hostedWafRules(env), 'zone.hosted-waf', 'execution');
    }
    await provisionMail(client, env, plan.zone_id);
    await provisionEventSubscriptions(client, env);
    await saveState(env);
  } finally {
    await handle.close();
    await rm(lock);
  }
}

export async function withPrivateBody<T>(body: unknown, run: (path: string) => Promise<T>): Promise<T> {
  const directory = join(ROOT, '.gitknot', 'private-requests');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(body), { mode: 0o600, flag: 'wx' });
  try { return await run(path); }
  finally { await rm(path); }
}

export async function readPlan(path: string): Promise<ResourcePlan> {
  const data = object(JSON.parse(await readFile(path, 'utf8')));
  if (data.version !== 1 || !Array.isArray(data.resources) || typeof data.spec_sha256 !== 'string') throw new Error('Invalid GitKnot infrastructure plan.');
  return data as unknown as ResourcePlan;
}
