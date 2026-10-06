import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { secretNames } from '../infra/cloudflare.ts';
import { CloudflareClient, object, records, result } from '../infra/cf-client.ts';
import { environment, resourceName, workerAccount, workerName, workerRoles, type AccountRole, type Environment, type WorkerRole } from '../infra/environment.ts';
import { applyPlan, readPlan, withPrivateBody } from '../infra/provisioning.ts';
import { main, writeJson } from '../infra/process.ts';
import { parseIdentityKeyRing } from '../infra/identity-keys.ts';

async function privateJson(path: string): Promise<Record<string, unknown>> {
  const status = await stat(path);
  if (process.platform !== 'win32' && (status.mode & 0o077) !== 0) throw new Error('Secret input files must have mode 0600 or stricter.');
  return object(JSON.parse(await readFile(path, 'utf8')), 'Private request');
}

async function uploadSecrets(env: Environment, role: WorkerRole, path: string, apply: boolean): Promise<void> {
  const values = await privateJson(path);
  const required = secretNames(env, role);
  for (const name of Object.keys(values)) {
    if (!required.includes(name) || typeof values[name] !== 'string' || (values[name] as string).length < 32) throw new Error(`Invalid or unowned secret ${name} for ${role}.`);
  }
  for (const name of required) if (!(name in values)) throw new Error(`Required secret ${name} is absent.`);
  const identityKeys = role === 'api' ? Object.values(parseIdentityKeyRing(values.IDENTITY_KEYS_JSON).keys) : [];
  if (env.remoteExecutor && ['api', 'background', 'execution'].includes(role)) {
    const platformKeys = [values.INTERNAL_SERVICE_KEY, values.SESSION_KEY, values.SECRETS_CLIENT_KEY, ...identityKeys];
    const controlKeys = [env.remoteExecutor.key_binding, ...env.previousHostedKeyBindings.filter(name => name.startsWith('HOSTED_CONTROL_KEY'))].map(name => values[name]);
    const callbackKeys = [env.remoteExecutor.callback_key_binding ?? 'HOSTED_CALLBACK_KEY', ...env.previousHostedKeyBindings.filter(name => name.startsWith('HOSTED_CALLBACK_KEY'))].map(name => values[name]);
    if (callbackKeys.some(key => platformKeys.includes(key)) || controlKeys.some(key => platformKeys.includes(key) || callbackKeys.includes(key))) {
      throw new Error('Hosted transport/callback keys must be distinct from each other, general service keys, identity masters and vault caller keys.');
    }
  }
  console.log(`${apply ? 'Updating' : 'Planned update of'} ${Object.keys(values).join(', ')} on ${workerName(env, role)}.`);
  if (!apply) return;
  const client = new CloudflareClient(env, true);
  const body = Object.fromEntries(Object.entries(values).map(([name, text]) => [name, { type: 'secret_text', text }]));
  await withPrivateBody(body, file => client.apply(['workers', 'secrets', 'bulk', '--worker', workerName(env, role), '--file', file], workerAccount(role)));
  const names = new Set(records(await client.read(['workers', 'secrets', 'list', '--worker', workerName(env, role)], workerAccount(role))).map(secret => secret.name));
  if (Object.keys(values).some(name => !names.has(name))) throw new Error('Secret names failed provider read-back verification.');
}

async function configureLogpush(env: Environment, path: string, apply: boolean, account: AccountRole): Promise<void> {
  if (account === 'execution' && !env.remoteExecutor) throw new Error('Execution-account Logpush requires the remote hosted topology.');
  const credentials = await privateJson(path);
  if (typeof credentials.access_key_id !== 'string' || typeof credentials.secret_access_key !== 'string') throw new Error('Logpush credentials require access_key_id and secret_access_key.');
  const remote = account === 'execution';
  const name = resourceName(env, remote ? 'hosted-workers-logpush' : 'workers-logpush', account);
  const bucket = resourceName(env, remote ? 'hosted-logpush' : 'logpush', account);
  console.log(`${apply ? 'Configuring' : 'Planned'} ${account} Workers Logpush to ${bucket}.`);
  if (!apply) return;
  const client = new CloudflareClient(env, true);
  const existing = records(await client.read(['logpush', 'account-jobs', 'list'], account)).find(job => job.name === name);
  if (existing) {
    if (existing.dataset !== 'workers_trace_events' || existing.enabled !== true) throw new Error('An existing Logpush job differs from the requested configuration.');
    console.log('Matching Logpush job already exists.');
    return;
  }
  const parameters = new URLSearchParams({ 'account-id': env.accounts[account]!, 'access-key-id': credentials.access_key_id, 'secret-access-key': credentials.secret_access_key });
  const destination = `r2://${bucket}/workers/{DATE}?${parameters}`;
  const body = {
    name, dataset: 'workers_trace_events', destination_conf: destination, enabled: true,
    output_options: { field_names: ['Event', 'EventTimestampMs', 'Outcome', 'ScriptName', 'Exceptions', 'CPUTimeMs', 'WallTimeMs'], timestamp_format: 'rfc3339' },
    filter: JSON.stringify({ where: { key: 'ScriptName', operator: 'in', value: workerRoles(env).filter(role => role !== 'secrets' && workerAccount(role) === account).map(role => workerName(env, role)) } }),
  };
  const response = await withPrivateBody(body, file => client.apply(['logpush', 'account-jobs', 'create', '--body', `@${file}`], account));
  const created = object(result(response));
  if (typeof created.id !== 'number') throw new Error('No Logpush job ID returned.');
  env.state.resources[remote ? 'observability.hosted-logpush' : 'observability.logpush'] = { id: String(created.id), kind: 'logpush', name, account_id: env.accounts[account]!, observed_at: new Date().toISOString() };
  await writeJson(env.statePath, env.state);
}

async function provision(): Promise<void> {
  const { values } = parseArgs({ options: {
    mode: { type: 'string', default: 'production' }, apply: { type: 'boolean', default: false }, plan: { type: 'string' },
    'secrets-file': { type: 'string' }, worker: { type: 'string' }, 'logpush-credentials': { type: 'string' },
    account: { type: 'string', default: 'trusted' },
  }, strict: true });
  const env = environment(values.mode);
  if (values['secrets-file']) {
    const roles = workerRoles(env);
    if (!roles.includes(values.worker as WorkerRole)) throw new Error(`--secrets-file requires an active --worker ${roles.join('|')}.`);
    await uploadSecrets(env, values.worker as WorkerRole, resolve(values['secrets-file']), values.apply);
    return;
  }
  if (values['logpush-credentials']) {
    if (values.account !== 'trusted' && values.account !== 'execution') throw new Error('--account must be trusted or execution.');
    await configureLogpush(env, resolve(values['logpush-credentials']), values.apply, values.account);
    return;
  }
  if (!values.plan) throw new Error('Use --plan <resolved-plan.json>. Create it with npm run infra:plan -- --resolve --mode production --out <path>.');
  const plan = await readPlan(resolve(values.plan));
  if (!values.apply) {
    console.log(JSON.stringify({ mode: plan.mode, cell: plan.cell_id, resolved: plan.resolved, resources: plan.resources.map(item => ({ action: item.action, kind: item.spec.kind, name: item.spec.name })), policies: ['D1 read replication', 'queue retention', 'R2 default storage class and private access', 'retention and backup locks', 'machine-protocol WAF/rate limits', 'email domain', 'Artifacts/email event subscriptions'], state: env.statePath }, null, 2));
    return;
  }
  await applyPlan(env, plan);
  console.log(`Infrastructure resource state recorded in ${env.statePath}. Worker builds and rollout are separate operations.`);
}

main(provision);
