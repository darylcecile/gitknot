import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadAndParseConfig, resolveAndParseConfig, type ParsedInputConfig } from '@cloudflare/config';
import { readBuildOutput } from '@cloudflare/build-output-utils';
import { API, type Project } from 'typescript/unstable/sync';
import { CF_VERSION, MODES, ROOT, VITE_PLUGIN_VERSION, buildOutputRoot, coreShards, environment, executionStorage, identityStorage, resourceName, workerAccount, workerConfigPath, workerName, workerRoles, type Environment, type Mode, type WorkerRole } from '../infra/environment.ts';
import { configuration, secretNames } from '../infra/cloudflare.ts';
import { LINUX_SMALL, limits } from '../infra/limits.ts';
import { resources } from '../infra/inventory.ts';
import { digest } from '../infra/planning.ts';
import { main, writeJson } from '../infra/process.ts';
import { FEDERATION_IDENTITY_CONTRACT } from '../packages/federation/src/types.ts';

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function moduleExports(path: string, project: Project): Set<string> {
  const source = project.program.getSourceFile(path);
  ensure(source, `Missing Worker source: ${path}`);
  const checker = project.checker;
  const symbol = checker.getSymbolAtLocation(source);
  ensure(symbol, `Worker entrypoint is not a module: ${path}`);
  return new Set(checker.getExportsOfModule(symbol).map(value => value.name));
}

async function checkVersions(): Promise<void> {
  for (const [name, required] of [['cf', CF_VERSION], ['@cloudflare/vite-plugin', VITE_PLUGIN_VERSION], ['@cloudflare/config', '0.23.0'], ['@cloudflare/build-output-utils', '0.8.5'], ['miniflare', '5.20261001.0-alpha']] as const) {
    const installed = JSON.parse(await readFile(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')) as { version: string };
    ensure(installed.version === required, `${name} must be pinned to ${required}; found ${installed.version}.`);
  }
  ensure(Number(process.versions.node.split('.')[0]) === 24, 'Node 24 is required for config validation.');
}

type CheckedConfig = { file: string; role: WorkerRole } & ParsedInputConfig;
const IDENTITY_ROLES: readonly WorkerRole[] = ['api', 'git', 'background', 'execution', 'secrets'];

function checkRoutingBindings(worker: NonNullable<ParsedInputConfig['worker']>, env: Environment, file: string): void {
  const home = identityStorage(env);
  const cells = [...env.peers.map(peer => peer.cell_id)];
  if (home.cell !== env.cell && !cells.includes(home.cell)) cells.push(home.cell);
  const apis = { [env.cell]: 'API', ...Object.fromEntries(cells.map((cell, index) => [cell, `CELL_API_${index + 1}`])) };
  const expected = {
    CELL_ID: env.cell, IDENTITY_CELL_ID: home.cell, IDENTITY_SHARD_ID: home.shard, SHARD_ID: 'core-001', ROOT_SHARD_ID: 'core-001',
    SHARD_BINDINGS_JSON: JSON.stringify(Object.fromEntries(coreShards(env).map(shard => [shard.shard, shard.binding]))),
    CELL_BINDINGS_JSON: JSON.stringify(apis),
  };
  for (const [name, value] of Object.entries(expected)) {
    const binding = worker.env?.[name];
    ensure(binding?.type === 'text' && binding.value === value, `${file}: ${name} differs from the bounded routing contract.`);
  }
  for (const name of Object.values(apis)) ensure(worker.env?.[name]?.type === 'worker', `${file}: routing map references missing API binding ${name}.`);
  for (const shard of coreShards(env)) {
    const binding = worker.env?.[shard.binding];
    ensure(binding?.type === 'd1' && binding.name === shard.name, `${file}: routing shard ${shard.shard} is missing or points to another authority.`);
  }
  const identity = worker.env?.IDENTITY_DB;
  ensure(identity?.type === 'd1' && identity.name === home.name, `${file}: identity authorization must use the shared account-primary binding and its physical cell/shard descriptors.`);
}

function checkRuntimeProfile(config: ParsedInputConfig, mode: Mode, file: string, release: boolean): void {
  const worker = config.worker!;
  const profileConfig = worker.env?.HOSTED_PROFILES_JSON;
  ensure(profileConfig?.type === 'text', `${file}: measured profile configuration is missing.`);
  const measured: unknown = JSON.parse(profileConfig.value);
  ensure(Array.isArray(measured), `${file}: hosted profiles must be a JSON array.`);
  const container = config.containers?.[0];
  for (const profile of measured as Record<string, unknown>[]) {
    ensure(profile && typeof profile === 'object' && !Array.isArray(profile), `${file}: a measured profile must be an object.`);
    ensure(container && 'image' in container && 'reference' in container.image && profile.image === container.image.reference, `${file}: admitted image does not match its Container image.`);
    ensure(profile.sdk_version === LINUX_SMALL.ci_sdk && profile.sandbox_version === LINUX_SMALL.sandbox_sdk
      && profile.max_instances === limits(mode).hosted_max_instances && profile.vcpu === LINUX_SMALL.vcpu
      && profile.memory_mib === LINUX_SMALL.memory_mib && profile.disk_mb === LINUX_SMALL.disk_mb, `${file}: measured profile and hard Container allocation disagree.`);
  }
  if (release) ensure(measured.length === 1, `${file}: one measured linux-small profile is required to enable hosted execution.`);
}

function checkLinks(configs: CheckedConfig[], env: Environment): void {
  const workers = new Map(configs.map(config => [config.worker!.name, config.worker!]));
  const owners = new Map(workerRoles(env).map(role => [workerName(env, role), workerAccount(role)]));
  for (const { file, worker } of configs) {
    for (const [name, binding] of Object.entries(worker!.env ?? {})) {
      if (binding.type !== 'worker' && binding.type !== 'durable-object' && binding.type !== 'workflow') continue;
      const target = workers.get(binding.worker);
      if (!target) {
        const peer = [...env.peers.map(peer => peer.cell_id), env.identityCell].some(cell => ['api', 'background', 'git'].some(role => binding.worker === `gitknot-${env.mode}-${cell}-${role}`));
        ensure(binding.type === 'worker' && peer, `${file}: ${name} references an undeclared Worker.`);
        continue;
      }
      const sourceOwner = owners.get(worker!.name)!;
      const targetOwner = owners.get(target.name)!;
      ensure(sourceOwner === targetOwner || Boolean(env.accounts[sourceOwner] && env.accounts[sourceOwner] === env.accounts[targetOwner]), `${file}: ${name} would cross Cloudflare accounts through an unsupported binding.`);
      if (binding.type === 'worker') continue;
      const declared = target.exports?.[binding.exportName];
      ensure(declared?.type === binding.type, `${file}: ${name} references a missing/wrong export kind.`);
      if (binding.type === 'workflow') ensure(declared.type === 'workflow' && declared.name === binding.name, `${file}: ${name} has a mismatched Workflow resource name.`);
    }
  }
}

function checkExecutionLayout(configs: CheckedConfig[], env: Environment, release: boolean): void {
  const control = configs.find(config => config.role === 'execution')!;
  const background = configs.find(config => config.role === 'background')!;
  const api = configs.find(config => config.role === 'api')!;
  for (const config of [api, background, control]) {
    const backups = config.worker!.env?.BACKUPS;
    ensure(backups?.type === 'r2' && backups.name === resourceName(env, 'backups'), `${config.role}: billing's repository-backup kind must resolve to the retained repository bucket.`);
  }
  if (!env.remoteExecutor) {
    for (const config of [api, background, control]) {
      const snapshots = config.worker!.env?.BACKUP_BUCKET;
      ensure(snapshots?.type === 'r2' && snapshots.name === executionStorage(env).name, `${config.role}: SDK snapshots and billing's physical-storage endpoint must share the trusted snapshot bucket.`);
    }
    checkRuntimeProfile(control, env.mode, control.file, release);
    return;
  }
  ensure(!control.worker!.env?.SANDBOX && !control.worker!.env?.BACKUP_BUCKET && !control.containers?.length, 'Remote mode must not configure a second direct runtime pool in the control plane.');
  ensure(!background.worker!.env?.SANDBOX && !background.worker!.env?.BACKUP_BUCKET, 'Remote background must reach the executor through HTTPS, not cross-account runtime bindings.');
  ensure(!api.worker!.env?.BACKUP_BUCKET, 'Remote API must not bind execution-account ephemeral storage.');
  const hosted = configs.find(config => config.role === 'hosted');
  ensure(hosted?.worker, 'Remote mode is missing the hosted Worker.');
  const allowed = new Map(Object.entries({ HOSTED_WORKFLOW: 'workflow', HOSTED_ATTEMPTS: 'durable-object', SANDBOX: 'durable-object', BACKUP_BUCKET: 'r2', HOSTED_EXECUTOR_ID: 'text', HOSTED_CONTROL_KEY: 'secret', HOSTED_CALLBACK_ORIGIN: 'text', HOSTED_PROFILES_JSON: 'text', ENVIRONMENT: 'text' }));
  const bindings = hosted.worker.env ?? {};
  ensure(Object.keys(bindings).length === allowed.size, 'The hosted account must receive exactly its narrow runtime bindings.');
  for (const [name, type] of allowed) ensure(bindings[name]?.type === type, `Hosted binding ${name} is missing or has the wrong kind.`);
  ensure(bindings.HOSTED_EXECUTOR_ID?.type === 'text' && bindings.HOSTED_EXECUTOR_ID.value === env.remoteExecutor.id, 'Hosted executor identity differs from the trusted configuration.');
  ensure(bindings.HOSTED_CALLBACK_ORIGIN?.type === 'text' && bindings.HOSTED_CALLBACK_ORIGIN.value === env.remoteExecutor.callback_origin, 'Hosted callbacks must be pinned to the trusted API origin.');
  ensure(bindings.BACKUP_BUCKET?.type === 'r2' && bindings.BACKUP_BUCKET.name === executionStorage(env).name, 'Hosted ephemeral storage belongs to the wrong runtime.');
  ensure(hosted.worker.triggers?.some(trigger => trigger.type === 'scheduled' && trigger.schedule === '* * * * *'), 'Hosted cleanup needs its independent scheduled reaper.');
  ensure(hosted.worker.domains?.length === 1 && hosted.worker.domains[0] === new URL(env.remoteExecutor.origin).hostname, 'Hosted HTTPS ingress differs from the configured control endpoint.');
  for (const role of ['api', 'background', 'execution'] as const) {
    const worker = configs.find(config => config.role === role)!.worker!;
    const remote = worker.env?.HOSTED_REMOTE_EXECUTOR_JSON;
    ensure(remote?.type === 'text' && JSON.stringify(JSON.parse(remote.value)) === JSON.stringify(env.remoteExecutor), `${role}: remote producer/origin configuration drifted.`);
    ensure(worker.env?.[env.remoteExecutor.key_binding]?.type === 'secret' && worker.env?.[env.remoteExecutor.callback_key_binding ?? 'HOSTED_CALLBACK_KEY']?.type === 'secret', `${role}: dedicated remote control/callback keys are missing.`);
    ensure(worker.env?.HOSTED_PROFILES_JSON?.type === 'text' && bindings.HOSTED_PROFILES_JSON?.type === 'text' && worker.env.HOSTED_PROFILES_JSON.value === bindings.HOSTED_PROFILES_JSON.value, `${role}: admitted and served hosted profiles differ.`);
  }
  checkRuntimeProfile(hosted, env.mode, hosted.file, release);
}

async function checkMode(mode: Mode, sourceExports: Map<string, Set<string>>, release: boolean, project: Project, fixture?: Environment) {
  const env = fixture ?? environment(mode);
  const inventory = resources(env);
  const resourceNames = new Set(inventory.map(resource => resource.name));
  ensure(resourceNames.size === inventory.length, `${mode}: duplicate resource names.`);
  const configs: CheckedConfig[] = [];
  for (const role of workerRoles(env)) {
    const file = workerConfigPath(role);
    const loaded = fixture ? { result: await resolveAndParseConfig(configuration(role, mode, env), { mode, isPreview: false }) }
      : await loadAndParseConfig(file, { mode, isPreview: false });
    ensure(loaded.result.success, `${file}: ${loaded.result.success ? '' : loaded.result.error.message}`);
    const config = loaded.result.data;
    const worker = config.worker;
    ensure(worker, `${file}: Worker missing.`);
    ensure(typeof worker.entrypoint === 'string' && existsSync(worker.entrypoint), `${file}: entrypoint missing.`);
    ensure(worker.workersDev === false && worker.previewUrls === false, `${file}: workers.dev/preview URLs must be disabled.`);
    ensure(config.accountId === env.accounts[workerAccount(role)], `${file}: Worker account does not match its owner.`);
    if (!['api', 'git', 'hosted'].includes(role)) ensure(!worker.domains?.length && !worker.triggers?.some(trigger => trigger.type === 'fetch'), `${file}: private Worker has a public route.`);
    const names = sourceExports.get(worker.entrypoint) ?? moduleExports(worker.entrypoint, project);
    sourceExports.set(worker.entrypoint, names);
    ensure(names.has('default'), `${worker.entrypoint}: default Worker export missing.`);
    for (const [name, value] of Object.entries(worker.exports ?? {})) {
      if ('state' in value && ['deleted', 'renamed', 'transferred'].includes(value.state ?? '')) continue;
      ensure(names.has(name), `${worker.entrypoint}: configuration names missing export ${name}.`);
    }
    for (const name of secretNames(env, role)) ensure(worker.env?.[name]?.type === 'secret', `${file}: required secret ${name} is missing.`);
    for (const name of ['HOSTED_TEST_HTTP', 'HOSTED_ALLOW_LOOPBACK_HTTP', 'HOSTED_TEST_ALLOW_LOOPBACK']) ensure(!worker.env?.[name], `${file}: test-only transport ${name} leaked into authored configuration.`);
    for (const [name, binding] of Object.entries(worker.env ?? {})) {
      ensure(!('dev' in binding) || !binding.dev || !('remote' in binding.dev) || binding.dev.remote !== true, `${file}: remote development binding ${name} is forbidden.`);
      if (binding.type === 'd1' || binding.type === 'r2' || binding.type === 'queue') {
        const resource = inventory.find(resource => resource.name === binding.name);
        ensure(resource, `${file}: ${name} refers to an uninventoried resource.`);
        ensure(resource.account === workerAccount(role) || Boolean(env.accounts[resource.account] && env.accounts[resource.account] === config.accountId), `${file}: ${name} would bind storage across accounts.`);
      }
      if (name.startsWith('SECRETS_KEK_') || name === 'SECRETS_SERVICE_KEYS_JSON' || name === 'SECRETS_FEDERATION_SERVICE_KEYS_JSON') ensure(role === 'secrets', `${file}: broker-only key material exposed to another Worker.`);
      if (name === 'SESSION_KEY' || name === 'IDENTITY_KEYS_JSON') ensure(role === 'api', `${file}: identity master keys belong only to the API.`);
      if (name.startsWith('HOSTED_CALLBACK_KEY')) ensure(['api', 'background', 'execution'].includes(role), `${file}: callback masters belong only to the trusted control plane.`);
      if (binding.type === 'secret') ensure(secretNames(env, role).includes(name), `${file}: undeclared secret ${name}.`);
      if (name === 'FEDERATION_IDENTITY_CONTRACT') ensure(binding.type === 'text' && binding.value === FEDERATION_IDENTITY_CONTRACT, `${file}: federation marker differs from the wired source contract version.`);
    }
    if (role === 'api' || role === 'secrets') {
      ensure(worker.env?.FEDERATION_IDENTITY_CONTRACT?.type === 'text', `${file}: the wired federation contract marker is missing.`);
      ensure(worker.env?.FEDERATION_TRUSTED_ORIGINS_JSON?.type === 'text' && worker.env?.APP_ORIGIN?.type === 'text' && worker.env?.API_ORIGIN?.type === 'text', `${file}: federation origins are incomplete.`);
    }
    if (role === 'api') ensure(worker.env?.IDENTITY_KEYS_JSON?.type === 'secret', `${file}: keyed request fingerprints require the explicit API identity key ring.`);
    if (IDENTITY_ROLES.includes(role) || worker.env?.IDENTITY_DB) checkRoutingBindings(worker, env, file);
    for (const trigger of worker.triggers ?? []) {
      if (trigger.type !== 'queue') continue;
      ensure(trigger.deadLetterQueue && resourceNames.has(trigger.deadLetterQueue), `${file}: queue consumer has no isolated DLQ.`);
      ensure(typeof trigger.maxConcurrency === 'number' && trigger.maxConcurrency > 0, `${file}: unbounded consumer concurrency.`);
      ensure(typeof trigger.maxRetries === 'number' && trigger.maxRetries <= 5, `${file}: queue retry budget missing.`);
    }
    for (const container of config.containers ?? []) {
      ensure(container.schedulingPolicy === 'default', `${file}: the pinned SDK requires default scheduling.`);
      ensure('maxInstances' in container && container.maxInstances > 0 && container.maxInstances <= 10, `${file}: Container hard cap missing or excessive.`);
      ensure('instanceType' in container && container.instanceType === (role === 'egress' ? 'basic' : 'standard-2'), `${file}: runtime profile sizing drift.`);
      ensure(container.ssh?.enabled === false, `${file}: native SSH is deferred.`);
      if (release) ensure('image' in container && 'reference' in container.image && /@sha256:[a-f0-9]{64}$/.test(container.image.reference), `${file}: release image must be a real digest-pinned reference.`);
    }
    if (release) {
      ensure(config.accountId, `${file}: release account is unresolved.`);
      for (const binding of Object.values(worker.env ?? {})) if (binding.type === 'd1') ensure(binding.id && /^[a-f0-9-]{36}$/.test(binding.id), `${file}: release D1 ID is unresolved.`);
    }
    if (['api', 'background', 'execution', 'hosted'].includes(role)) ensure(worker.limits?.subrequests === 65_536, `${file}: the complete artifact/CI envelope requires the explicit 65,536-subrequest budget.`);
    if (role === 'background') ensure(worker.env?.API?.type === 'worker', `${file}: identity mail preparation requires the private API service binding.`);
    configs.push({ file, role, ...config });
  }
  checkLinks(configs, env);
  checkExecutionLayout(configs, env, release);
  if (release) {
    ensure(mode !== 'development', 'Development wrappers are not release configuration.');
    ensure(env.state.zone_id, `${mode}: existing zone not resolved.`);
    for (const resource of inventory) {
      const observed = env.state.resources[resource.key];
      ensure(observed?.name === resource.name && observed.kind === resource.kind && observed.account_id === env.accounts[resource.account], `${mode}: unresolved resource ownership for ${resource.key}.`);
    }
    ensure(process.env[`GITKNOT_${mode.toUpperCase()}_HOSTED_PROFILES_FILE`], `${mode}: measured hosted-profile evidence has not been supplied.`);
    if (env.remoteExecutor) ensure(env.state.hosted_zone_id, `${mode}: hosted origin ownership has not been resolved.`);
  }
  return { mode, resourceNames: [...resourceNames], configs };
}

function remoteFixture(mode: 'staging' | 'production'): Environment {
  const base = environment(mode);
  const id = `configuration-${mode}-${base.executionCell}`;
  return { ...base, accounts: { trusted: '11111111111111111111111111111111', execution: '22222222222222222222222222222222' }, separatedAccounts: true,
    peers: [], previousHostedKeyBindings: ['HOSTED_CONTROL_KEY_PREVIOUS', ...(mode === 'production' ? ['HOSTED_CALLBACK_KEY', 'HOSTED_CALLBACK_KEY_PREVIOUS'] : [])],
    state: { ...base.state, resources: {} },
    remoteExecutor: { id, origin: `https://hosted-${mode}.configuration.invalid`, callback_origin: base.origins.api, producer_id: `hosted:${id}:linux-small`, key_binding: 'HOSTED_CONTROL_KEY_CURRENT', ...(mode === 'production' ? { callback_key_binding: 'HOSTED_CALLBACK_KEY_CURRENT' } : {}) },
  };
}

function metadataCellFixture(): Environment {
  const base = environment('production');
  return { ...base, cell: 'metadata-002', prefix: 'gitknot-production-metadata-002', executionCell: 'exec-002', executionPrefix: 'gitknot-production-exec-002',
    identityCell: 'cell-001', directoryCell: 'cell-001', ingressCell: 'cell-001', shardCount: 2,
    peers: [{ cell_id: 'cell-001' }], remoteExecutor: undefined, previousHostedKeyBindings: [], separatedAccounts: false,
    accounts: { trusted: '11111111111111111111111111111111', execution: '11111111111111111111111111111111' },
    state: { ...base.state, cell_id: 'metadata-002', execution_cell_id: 'exec-002', resources: {} },
  };
}

function deployedBindings(bindings: NonNullable<ParsedInputConfig['worker']>['env']): unknown {
  return Object.fromEntries(Object.entries(bindings ?? {}).map(([name, binding]) => [name, Object.fromEntries(Object.entries(binding).filter(([key]) => key !== 'dev'))]));
}

async function checkBuiltOutputs(mode?: Mode): Promise<void> {
  const primary = await readBuildOutput(ROOT);
  const env = environment(primary.rootConfig.buildContext.mode);
  if (mode) ensure(env.mode === mode, 'Build Output does not match the requested mode.');
  for (const account of ['trusted', 'execution'] as const) {
    const roles = workerRoles(env).filter(role => workerAccount(role) === account);
    if (!roles.length) {
      ensure(!existsSync(join(buildOutputRoot(account), '.cloudflare/output/v0/config.json')), 'Inactive execution-account Build Output remains from an earlier topology.');
      continue;
    }
    const built = account === 'trusted' ? primary : await readBuildOutput(buildOutputRoot(account));
    const names = new Set(roles.map(role => workerName(env, role)));
    ensure(built.rootConfig.accountId === env.accounts[account] && built.rootConfig.buildContext.mode === env.mode, `${account}: Build Output account/mode mismatch.`);
    ensure(Object.values(built.workers).length === names.size && Object.values(built.workers).every(worker => names.has(worker.config.name)), `${account}: Build Output crosses account boundaries or is incomplete.`);
    for (const role of roles) {
      const actual = Object.values(built.workers).find(worker => worker.config.name === workerName(env, role))!.config;
      const parsed = await resolveAndParseConfig(configuration(role, env.mode, env), { mode: env.mode, isPreview: false });
      ensure(parsed.success && parsed.data.worker, `${role}: current build configuration could not be parsed.`);
      const expected = parsed.data.worker;
      ensure(digest(deployedBindings(actual.env)) === digest(deployedBindings(expected.env)), `${role}: Build Output bindings differ from the current topology; rebuild this mode.`);
      ensure(digest(actual.limits) === digest(expected.limits), `${role}: Build Output limits differ from the configured invocation budgets.`);
      ensure(actual.workersDev === false && actual.previewUrls === false && digest(actual.domains) === digest(expected.domains), `${role}: Build Output ingress differs from the reviewed configuration.`);
    }
    if (account === 'trusted') ensure(built.workers.default.assetsDir, 'API Build Output does not contain the Vite client assets.');
  }
}

async function check(): Promise<void> {
  const { values } = parseArgs({ options: { mode: { type: 'string' }, release: { type: 'boolean', default: false }, build: { type: 'boolean', default: false }, 'all-layouts': { type: 'boolean', default: false }, out: { type: 'string' } }, strict: true });
  await checkVersions();
  const selected = values.mode ? [environment(values.mode).mode] : [...MODES];
  if (values.release) ensure(values.mode, '--release requires one explicit --mode.');
  const sourceExports = new Map<string, Set<string>>();
  const checked = [];
  const api = new API({ cwd: ROOT });
  const snapshot = api.updateSnapshot({ openProjects: [join(ROOT, 'tsconfig.json')] });
  try {
    const project = snapshot.getProject(join(ROOT, 'tsconfig.json'));
    ensure(project, 'The pinned TypeScript 7 API could not open the root project.');
    for (const mode of selected) checked.push(await checkMode(mode, sourceExports, values.release, project));
    if (values['all-layouts']) {
      ensure(!values.release, 'Synthetic account-boundary fixtures cannot be used as release evidence.');
      for (const mode of ['staging', 'production'] as const) {
        await checkMode(mode, sourceExports, false, project, remoteFixture(mode));
      }
      const metadata = await checkMode('production', sourceExports, false, project, metadataCellFixture());
      for (const config of metadata.configs.filter(config => IDENTITY_ROLES.includes(config.role))) {
        ensure(config.worker?.env?.IDENTITY_DB?.type === 'd1' && config.worker.env.DB?.type === 'd1' && config.worker.env.IDENTITY_DB.name !== config.worker.env.DB.name, `${config.file}: a metadata cell must not treat its local identity copy as grant authority.`);
      }
    }
  } finally { snapshot.dispose(); api.close(); }
  const names = checked.flatMap(result => result.resourceNames);
  ensure(new Set(names).size === names.length, 'Modes share provider resource names.');
  if (values.build) await checkBuiltOutputs(values.mode ? selected[0] : undefined);
  if (values.out) await writeJson(resolve(values.out), checked);
  console.log(`Validated cf schemas, exports, bindings, private routes, capacity caps, and resource isolation for ${selected.join(', ')}.`);
  if (values['all-layouts']) console.log('Validated isolated-account hosted and shared-identity metadata-cell layouts using explicit synthetic configuration fixtures; no provider requests or execution measurements were made.');
}

main(check);
