import { CloudflareClient, records, type JsonObject } from './cf-client.ts';
import { executionContainerName, executionStorage, resourceName, workerAccount, workerName, workerRoles, type AccountRole, type Environment, type ResourceState } from './environment.ts';

export interface VersionOwnedObservation { key: string; resource: ResourceState }

async function pageList(client: CloudflareClient, args: string[], account: AccountRole): Promise<JsonObject[]> {
  const all: JsonObject[] = [];
  for (let page = 1; page <= 10_000; page++) {
    const rows = records(await client.read([...args, '--per-page', '100', '--page', String(page)], account));
    all.push(...rows);
    if (rows.length < 100) return all;
  }
  throw new Error('Version-owned resource discovery exceeded its bounded page count.');
}

function observed(env: Environment, key: string, kind: string, name: string, id: unknown, account: AccountRole): VersionOwnedObservation {
  if (typeof id !== 'string' && typeof id !== 'number') throw new Error(`Resource ${key} has no provider identifier.`);
  const accountId = env.accounts[account];
  if (!accountId) throw new Error(`Resource ${key} has no selected account.`);
  return { key, resource: { id: String(id), name, kind, account_id: accountId, observed_at: new Date().toISOString() } };
}

/** Observe deployment-owned resources; planning never creates a Worker/version. */
export async function observeVersionOwned(client: CloudflareClient, env: Environment): Promise<VersionOwnedObservation[]> {
  const observations: VersionOwnedObservation[] = [];
  const roles = workerRoles(env);
  for (const role of roles) {
    const account = workerAccount(role);
    const name = workerName(env, role);
    const scripts = await pageList(client, ['workers', 'scripts', 'search', '--name', name], account);
    const match = scripts.find(script => (script.id === name || script.name === name));
    if (match) observations.push(observed(env, `worker.${role}`, 'worker', name, match.id ?? match.name, account));
  }
  const accounts: AccountRole[] = env.separatedAccounts ? ['trusted', 'execution'] : ['trusted'];
  for (const account of accounts) {
    const desiredWorkers = new Set(roles.filter(role => env.accounts[workerAccount(role)] === env.accounts[account]).map(role => workerName(env, role)));
    const namespaces = await pageList(client, ['durable-objects', 'namespaces', 'list'], account);
    for (const namespace of namespaces) {
      const script = namespace.script ?? namespace.script_name;
      const className = namespace.class ?? namespace.class_name;
      if (typeof script !== 'string' || typeof className !== 'string' || !desiredWorkers.has(script)) continue;
      observations.push(observed(env, `durable-object.${script}.${className}`, 'durable-object', `${script}/${className}`, namespace.id, account));
    }
  }
  const workflows = await pageList(client, ['workflows', 'list', '--search', env.prefix], 'trusted');
  for (const suffix of ['runs', 'operations']) {
    const name = resourceName(env, suffix);
    const found = workflows.find(workflow => workflow.name === name || workflow.id === name);
    if (found) observations.push(observed(env, `workflow.${suffix}`, 'workflow', name, found.id ?? found.name, 'trusted'));
  }
  if (env.remoteExecutor) {
    const name = resourceName(env, 'hosted-attempts', 'execution');
    const hostedWorkflows = await pageList(client, ['workflows', 'list', '--search', name], 'execution');
    const found = hostedWorkflows.find(workflow => workflow.name === name || workflow.id === name);
    if (found) observations.push(observed(env, 'workflow.hosted-attempts', 'workflow', name, found.id ?? found.name, 'execution'));
  }
  const applications = [
    { key: 'native-git', account: 'trusted' as const, name: resourceName(env, 'native-git') },
    { key: 'webhook-egress', account: 'trusted' as const, name: resourceName(env, 'webhook-egress') },
    { key: env.remoteExecutor ? 'hosted-linux-small' : 'linux-small', account: executionStorage(env).account, name: executionContainerName(env) },
  ];
  for (const { key, account, name } of applications) {
    const response = await client.read(['containers', 'applications', 'list', '--name', name, '--per-page', '100'], account);
    const found = records(response).find(application => application.name === name);
    if (found) observations.push(observed(env, `container.${key}`, 'container', name, found.id, account));
  }
  // Logpush API responses include destination credentials. Keep identifiers
  // only; never serialize the provider's destination_conf into plan or state.
  const jobs = records(await client.read(['logpush', 'account-jobs', 'list']));
  const logpushName = resourceName(env, 'workers-logpush');
  const logpush = jobs.find(job => job.name === logpushName);
  if (logpush) observations.push(observed(env, 'observability.logpush', 'logpush', logpushName, logpush.id, 'trusted'));
  if (env.remoteExecutor) {
    const hostedJobs = records(await client.read(['logpush', 'account-jobs', 'list'], 'execution'));
    const name = resourceName(env, 'hosted-workers-logpush', 'execution');
    const job = hostedJobs.find(value => value.name === name);
    if (job) observations.push(observed(env, 'observability.hosted-logpush', 'logpush', name, job.id, 'execution'));
  }
  return observations;
}
