import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { bindings, defineContainer, exports, triggers, type CloudflareConfig, type ContainerConfig, type WorkerConfig } from 'cf/config';
import { COMPATIBILITY_DATE, ROOT, coreShards, directoryName, environment, executionContainerName, executionStorage, identityStorage, localDatabaseId, resourceName, scopedVariable, workerAccount, workerName, workerSourcePath, type Environment, type WorkerRole } from './environment.ts';
import { LINUX_SMALL, limits } from './limits.ts';
import { parseIdentityKeyRing } from './identity-keys.ts';

type BindingMap = NonNullable<WorkerConfig['env']>;

export const QUEUES = [
  { binding: 'EVENTS', suffix: 'events', batch: 25, concurrency: 8 },
  { binding: 'DISPATCH', suffix: 'dispatch', batch: 10, concurrency: 4 },
  { binding: 'WEBHOOK_DELIVERIES', suffix: 'webhooks', batch: 10, concurrency: 8 },
  { binding: 'MAIL_DELIVERIES', suffix: 'mail', batch: 10, concurrency: 2 },
  { binding: 'INDEX_EVENTS', suffix: 'indexing', batch: 25, concurrency: 4 },
  { binding: 'METER_EVENTS', suffix: 'metering', batch: 25, concurrency: 4 },
  { binding: 'ARTIFACTS_EVENTS', suffix: 'artifacts-events', batch: 10, concurrency: 2 },
] as const;

export const SECRET_NAMES: Record<WorkerRole, readonly string[]> = {
  api: ['INTERNAL_SERVICE_KEY', 'SESSION_KEY', 'IDENTITY_KEYS_JSON', 'SECRETS_CLIENT_KEY'],
  git: ['INTERNAL_SERVICE_KEY'],
  background: ['INTERNAL_SERVICE_KEY', 'SECRETS_CLIENT_KEY'],
  execution: ['INTERNAL_SERVICE_KEY', 'SECRETS_CLIENT_KEY'],
  secrets: ['INTERNAL_SERVICE_KEY', 'SECRETS_KEK_KEYRING_JSON', 'SECRETS_SERVICE_KEYS_JSON', 'SECRETS_FEDERATION_SERVICE_KEYS_JSON'],
  egress: ['INTERNAL_SERVICE_KEY'],
  hosted: ['HOSTED_CONTROL_KEY'],
};

const REMOTE_CALLERS: readonly WorkerRole[] = ['api', 'background', 'execution'];

export function secretNames(env: Environment, role: WorkerRole): string[] {
  const remote = env.remoteExecutor;
  const control = remote && REMOTE_CALLERS.includes(role)
    ? [remote.key_binding, ...env.previousHostedKeyBindings, remote.callback_key_binding ?? 'HOSTED_CALLBACK_KEY'] : [];
  return [...new Set([...SECRET_NAMES[role], ...control])];
}

function database(env: Environment, key: string, name: string) {
  // A local database always has a stable explicit ID. cf's resource CLI and
  // workerd must use the same ID, not an inferred per-Worker binding name.
  const recorded = env.mode === 'development' ? undefined : env.state.resources[key];
  if (recorded && (recorded.kind !== 'd1' || recorded.name !== name || recorded.account_id !== env.accounts.trusted)) {
    throw new Error(`Recorded ${key} does not match its selected database and trusted account. Resolve the authority state before building.`);
  }
  const id = env.mode === 'development' ? localDatabaseId(name) : recorded?.id;
  return bindings.d1({ name, ...(id ? { id } : {}), dev: { remote: false } });
}

function storageBindings(env: Environment): BindingMap {
  const identity = identityStorage(env);
  return {
    ...Object.fromEntries(coreShards(env).map(shard => [shard.binding, database(env, shard.key, shard.name)])),
    DIRECTORY_DB: database(env, 'd1.directory', directoryName(env)),
    IDENTITY_DB: database(env, identity.key, identity.name),
    SEARCH_DB: database(env, 'd1.search', resourceName(env, 'search')),
    BLOBS: bindings.r2({ name: resourceName(env, 'blobs'), ...(env.jurisdiction ? { jurisdiction: env.jurisdiction } : {}), dev: { remote: false } }),
    BACKUPS: bindings.r2({ name: resourceName(env, 'backups'), ...(env.jurisdiction ? { jurisdiction: env.jurisdiction } : {}), dev: { remote: false } }),
  };
}

function queueBindings(env: Environment): BindingMap {
  return Object.fromEntries(QUEUES.map(queue => [queue.binding, bindings.queue({ name: resourceName(env, queue.suffix), dev: { remote: false } })]));
}

function coordinationBindings(env: Environment): BindingMap {
  return {
    REPO_COORDINATOR: bindings.durableObject({ worker: workerName(env, 'git'), exportName: 'RepositoryCoordinator' }),
    ADMISSION: bindings.durableObject({ worker: workerName(env, 'execution'), exportName: 'AdmissionController' }),
    ATTEMPTS: bindings.durableObject({ worker: workerName(env, 'execution'), exportName: 'AttemptController' }),
    RUN_WORKFLOW: bindings.workflow({ name: resourceName(env, 'runs'), worker: workerName(env, 'background'), exportName: 'RunWorkflow' }),
    OPERATIONS: bindings.workflow({ name: resourceName(env, 'operations'), worker: workerName(env, 'background'), exportName: 'OperationWorkflow' }),
  };
}

function serviceBindings(env: Environment): BindingMap {
  const peers: BindingMap = {};
  const apis: Record<string, string> = { [env.cell]: 'API' };
  const backgrounds: Record<string, string> = {};
  const gits: Record<string, string> = {};
  const cells = [...env.peers.map(peer => peer.cell_id)];
  // Account admission has one durable home even when the repository is elsewhere.
  if (env.identityCell !== env.cell && !cells.includes(env.identityCell)) cells.push(env.identityCell);
  cells.forEach((cell, index) => {
    const api = `CELL_API_${index + 1}`;
    const background = `CELL_BACKGROUND_${index + 1}`;
    const git = `CELL_GIT_${index + 1}`;
    peers[api] = bindings.worker({ worker: `gitknot-${env.mode}-${cell}-api`, dev: { remote: false } });
    peers[background] = bindings.worker({ worker: `gitknot-${env.mode}-${cell}-background`, dev: { remote: false } });
    peers[git] = bindings.worker({ worker: `gitknot-${env.mode}-${cell}-git`, dev: { remote: false } });
    apis[cell] = api;
    backgrounds[cell] = background;
    gits[cell] = git;
  });
  return {
    GIT_SERVICE: bindings.worker({ worker: workerName(env, 'git'), dev: { remote: false } }),
    SECRETS: bindings.worker({ worker: workerName(env, 'secrets'), dev: { remote: false } }),
    EXECUTOR: bindings.worker({ worker: workerName(env, 'execution'), dev: { remote: false } }),
    API: bindings.worker({ worker: workerName(env, 'api'), dev: { remote: false } }),
    BACKGROUND: bindings.worker({ worker: workerName(env, 'background'), dev: { remote: false } }),
    WEBHOOK_EGRESS: bindings.worker({ worker: workerName(env, 'egress'), dev: { remote: false } }),
    ...peers,
    CELL_BINDINGS_JSON: bindings.text(JSON.stringify(apis)),
    CELL_BACKGROUND_BINDINGS_JSON: bindings.text(JSON.stringify(backgrounds)),
    CELL_GIT_BINDINGS_JSON: bindings.text(JSON.stringify(gits)),
  };
}

function profiles(env: Environment): string {
  const path = scopedVariable(env.mode, 'HOSTED_PROFILES_FILE');
  if (!path) return '[]';
  // Evidence is operator-provided. Do not invent measurements to enable a pool.
  const value: unknown = JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));
  if (!Array.isArray(value)) throw new Error('HOSTED_PROFILES_FILE must contain a JSON array.');
  return JSON.stringify(value);
}

function federationBindings(env: Environment): BindingMap {
  const path = scopedVariable(env.mode, 'FEDERATION_TRUSTED_ORIGINS_FILE');
  const values: unknown = path ? JSON.parse(readFileSync(resolve(ROOT, path), 'utf8')) : [];
  if (!Array.isArray(values) || values.length > 128) throw new Error('Federation trusted origins must be a bounded JSON array.');
  for (const value of values) {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('Federation trust entries must be bounded origin strings.');
    const url = new URL(String(value));
    const privateName = /(?:^|\.)(?:localhost|local|internal|test|invalid|home|lan|onion)$/.test(url.hostname);
    if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.port
      || url.hostname.endsWith('.') || !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':') || privateName) {
      throw new Error('Federation trust entries must be exact public HTTPS origins without credentials or custom ports.');
    }
  }
  return {
    FEDERATION_IDENTITY_CONTRACT: bindings.text('gitknot.identity.federation.v1'),
    FEDERATION_TRUSTED_ORIGINS_JSON: bindings.text(JSON.stringify(values)),
  };
}

function publicBindings(env: Environment, role: WorkerRole): BindingMap {
  const config = limits(env.mode);
  const identity = identityStorage(env);
  return {
    ENVIRONMENT: bindings.text(env.mode),
    APP_ORIGIN: bindings.text(env.origins.app),
    API_ORIGIN: bindings.text(env.origins.api),
    GIT_ORIGIN: bindings.text(env.origins.git),
    CELL_ID: bindings.text(env.cell),
    IDENTITY_CELL_ID: bindings.text(identity.cell),
    IDENTITY_SHARD_ID: bindings.text(identity.shard),
    EXECUTION_CELL_ID: bindings.text(env.executionCell),
    SHARD_ID: bindings.text('core-001'),
    ROOT_SHARD_ID: bindings.text('core-001'),
    SHARD_BINDINGS_JSON: bindings.text(JSON.stringify(Object.fromEntries(coreShards(env).map(shard => [shard.shard, shard.binding])))),
    LIMITS_JSON: bindings.text(JSON.stringify({ ...config, execution_paused: env.recovery || scopedVariable(env.mode, 'EXECUTION_PAUSED') === 'true' })),
    HOSTED_PROFILES_JSON: bindings.text(profiles(env)),
    BILLING_PLATFORM_SLICE_ID: bindings.text(scopedVariable(env.mode, 'BILLING_PLATFORM_SLICE_ID') ?? resourceName(env, 'linux-small', 'execution')),
    ...(scopedVariable(env.mode, 'BILLING_GIT_STORAGE_SLICE_ID') ? { BILLING_GIT_STORAGE_SLICE_ID: bindings.text(scopedVariable(env.mode, 'BILLING_GIT_STORAGE_SLICE_ID')!) } : {}),
    ...(scopedVariable(env.mode, 'BILLING_ESSENTIAL_SLICE_ID') ? { BILLING_ESSENTIAL_SLICE_ID: bindings.text(scopedVariable(env.mode, 'BILLING_ESSENTIAL_SLICE_ID')!) } : {}),
    ARTIFACTS_NAMESPACE: bindings.text(resourceName(env, 'repositories')),
    ...(env.accounts.trusted ? { ARTIFACTS_ACCOUNT_ID: bindings.text(env.accounts.trusted) } : {}),
    ...(['api', 'background', 'execution'].includes(role) ? { SECRETS_CLIENT_ID: bindings.text(`${env.mode}-${env.cell}-${role}`) } : {}),
    ...federationBindings(env),
    ...(env.remoteExecutor && REMOTE_CALLERS.includes(role) ? { HOSTED_REMOTE_EXECUTOR_JSON: bindings.text(JSON.stringify(env.remoteExecutor)) } : {}),
  };
}

function commonBindings(env: Environment, role: WorkerRole): BindingMap {
  return {
    ...publicBindings(env, role), ...storageBindings(env), ...queueBindings(env),
    ...coordinationBindings(env), ...serviceBindings(env),
    ...Object.fromEntries(secretNames(env, role).map(name => [name, bindings.secret()])),
    METRICS: bindings.analyticsEngineDataset({ name: resourceName(env, 'metrics').replaceAll('-', '_') }),
  };
}

export function nativeContainer(env: Environment): ContainerConfig {
  const image = scopedVariable(env.mode, 'GIT_IMAGE') ?? env.state.images.native_git;
  return defineContainer({
    name: resourceName(env, 'native-git'),
    image: image ? { reference: image } : { dockerfile: join(ROOT, 'services/git/Dockerfile'), buildContext: ROOT },
    instanceType: 'standard-2',
    schedulingPolicy: 'default',
    maxInstances: limits(env.mode).git_max_instances,
    ssh: { enabled: false },
    observability: { enabled: true, logs: { enabled: true } },
  });
}

export function sandboxContainer(env: Environment): ContainerConfig {
  const image = scopedVariable(env.mode, 'SANDBOX_IMAGE') ?? env.state.images.sandbox;
  return defineContainer({
    name: executionContainerName(env),
    image: image ? { reference: image } : { dockerfile: join(ROOT, env.remoteExecutor ? 'workers/hosted/Dockerfile' : LINUX_SMALL.dockerfile), buildContext: ROOT, buildVars: { SANDBOX_BASE_IMAGE: LINUX_SMALL.base_image } },
    instanceType: LINUX_SMALL.instance_type,
    schedulingPolicy: 'default',
    maxInstances: limits(env.mode).hosted_max_instances,
    ssh: { enabled: false },
    // Application logs contain user commands. They are redacted and persisted
    // by the executor; raw Container stdout must not bypass that path.
    observability: { enabled: false, logs: { enabled: false } },
  });
}

export function egressContainer(env: Environment): ContainerConfig {
  const image = scopedVariable(env.mode, 'EGRESS_IMAGE') ?? env.state.images.egress;
  return defineContainer({
    name: resourceName(env, 'webhook-egress'),
    image: image ? { reference: image } : { dockerfile: join(ROOT, 'infra/egress/Dockerfile'), buildContext: ROOT },
    instanceType: 'basic', schedulingPolicy: 'default', maxInstances: 2,
    ssh: { enabled: false }, observability: { enabled: true, logs: { enabled: true } },
  });
}

function rateNamespace(env: Environment, role: string): string {
  return String(Number.parseInt(createHash('sha256').update(`${env.prefix}:${role}`).digest('hex').slice(0, 8), 16));
}

function roleConfiguration(env: Environment, role: WorkerRole, common: BindingMap): { worker: Partial<WorkerConfig>; containers: ContainerConfig[] } {
  switch (role) {
    case 'api': return { worker: {
      env: { ...common,
        ...(!env.remoteExecutor ? { BACKUP_BUCKET: bindings.r2({ name: executionStorage(env).name, ...(env.jurisdiction ? { jurisdiction: env.jurisdiction } : {}), dev: { remote: false } }) } : {}),
        ASSETS: bindings.assets(), API_RATE_LIMIT: bindings.rateLimit({ namespace: rateNamespace(env, 'api'), simple: { limit: 300, period: 60 } }),
      },
      domains: env.mode === 'development' || env.recovery || env.cell !== env.ingressCell ? [] : [new URL(env.origins.app).hostname, new URL(env.origins.api).hostname],
      assets: { notFoundHandling: 'single-page-application', runWorkerFirst: true },
    }, containers: [] };
    case 'git': {
      const container = nativeContainer(env);
      return { worker: {
        domains: env.mode === 'development' || env.recovery || env.cell !== env.ingressCell ? [] : [new URL(env.origins.git).hostname],
        env: { ...common,
          ARTIFACTS: bindings.artifacts({ namespace: resourceName(env, 'repositories'), dev: { remote: false } }),
          GIT_STORAGE_MODE: bindings.text('artifacts'),
          GIT_CONTAINERS: bindings.durableObject({ worker: workerName(env, 'git'), exportName: 'GitContainer' }),
          GIT_HELPER_POOL_SIZE: bindings.text(String(limits(env.mode).git_max_instances)),
          GIT_MAX_SESSIONS: bindings.text('4'),
          GIT_NATIVE_IMAGE: bindings.text(scopedVariable(env.mode, 'GIT_IMAGE') ?? env.state.images.native_git ?? 'source:services/git/Dockerfile'),
          GIT_RATE_LIMIT: bindings.rateLimit({ namespace: rateNamespace(env, 'git'), simple: { limit: 120, period: 60 } }),
        },
        exports: {
          RepositoryCoordinator: exports.durableObject({ storage: 'sqlite' }),
          GitContainer: exports.durableObject({ storage: 'sqlite', container }),
        },
      }, containers: [container] };
    }
    case 'background': return { worker: {
      env: { ...common,
        ...(!env.remoteExecutor ? {
          SANDBOX: bindings.durableObject({ worker: workerName(env, 'execution'), exportName: 'Sandbox' }),
          BACKUP_BUCKET: bindings.r2({ name: executionStorage(env).name, ...(env.jurisdiction ? { jurisdiction: env.jurisdiction } : {}), dev: { remote: false } }),
        } : {}),
        EMAIL: bindings.sendEmail({ allowedSenderAddresses: ['notifications', 'security'].map(sender => `${sender}@${env.mode === 'production' ? 'mail.gitknot.com' : 'mail.staging.gitknot.com'}`), dev: { remote: false } }),
        MAIL_DOMAIN: bindings.text(env.mode === 'production' ? 'mail.gitknot.com' : 'mail.staging.gitknot.com'),
        ...(env.accounts.trusted ? { MAIL_EVENT_ACCOUNT_ID: bindings.text(env.accounts.trusted) } : {}),
        MAIL_FROM: bindings.text(`GitKnot <notifications@${env.mode === 'production' ? 'mail.gitknot.com' : 'mail.staging.gitknot.com'}>`),
      },
      exports: {
        RunWorkflow: exports.workflow({ name: resourceName(env, 'runs'), limits: { steps: 1_024 }, concurrency: { limit: env.mode === 'production' ? 100 : 10 } }),
        OperationWorkflow: exports.workflow({ name: resourceName(env, 'operations'), limits: { steps: 1_024 }, concurrency: { limit: env.mode === 'production' ? 25 : 5 } }),
      },
      triggers: env.recovery ? [] : [triggers.scheduled({ schedule: '* * * * *' }), ...QUEUES.map(queue => triggers.queue({
        name: resourceName(env, queue.suffix), deadLetterQueue: resourceName(env, `${queue.suffix}-dlq`),
        maxBatchSize: queue.batch, maxBatchTimeout: 2, maxConcurrency: queue.concurrency, maxRetries: 5, retryDelay: 30,
      }))],
    }, containers: [] };
    case 'execution': {
      const container = env.remoteExecutor ? undefined : sandboxContainer(env);
      return { worker: {
        env: { ...common,
          ...(!env.remoteExecutor ? {
            SANDBOX: bindings.durableObject({ worker: workerName(env, 'execution'), exportName: 'Sandbox' }),
            BACKUP_BUCKET: bindings.r2({ name: executionStorage(env).name, ...(env.jurisdiction ? { jurisdiction: env.jurisdiction } : {}), dev: { remote: false } }),
          } : {}),
        },
        exports: {
          AttemptController: exports.durableObject({ storage: 'sqlite' }),
          AdmissionController: exports.durableObject({ storage: 'sqlite' }),
          ...(container ? { Sandbox: exports.durableObject({ storage: 'sqlite', container }), ContainerProxy: exports.worker() } : {}),
        },
      }, containers: container ? [container] : [] };
    }
    case 'secrets': return { worker: {
      env: {
        ...Object.fromEntries(coreShards(env).map(shard => [shard.binding, common[shard.binding]!])),
        IDENTITY_DB: common.IDENTITY_DB!,
        IDENTITY_CELL_ID: common.IDENTITY_CELL_ID!,
        IDENTITY_SHARD_ID: common.IDENTITY_SHARD_ID!,
        DIRECTORY_DB: common.DIRECTORY_DB!,
        SHARD_ID: common.SHARD_ID!,
        ROOT_SHARD_ID: common.ROOT_SHARD_ID!,
        SHARD_BINDINGS_JSON: common.SHARD_BINDINGS_JSON!,
        CELL_BINDINGS_JSON: common.CELL_BINDINGS_JSON!,
        API: common.API!,
        ...Object.fromEntries(Object.entries(common).filter(([name]) => name.startsWith('CELL_API_'))),
        ENVIRONMENT: bindings.text(env.mode),
        CELL_ID: bindings.text(env.cell),
        APP_ORIGIN: bindings.text(env.origins.app),
        API_ORIGIN: bindings.text(env.origins.api),
        ...federationBindings(env),
        SECRETS_KEK_CURRENT_ID: bindings.text(scopedVariable(env.mode, 'KEK_CURRENT_ID') ?? (env.mode === 'development' ? 'local-v1' : 'primary-v1')),
        SECRETS_KEK_KEYRING_JSON: bindings.secret(),
        SECRETS_SERVICE_KEYS_JSON: bindings.secret(),
        SECRETS_FEDERATION_SERVICE_KEYS_JSON: bindings.secret(),
        INTERNAL_SERVICE_KEY: bindings.secret(),
      },
      logpush: false,
      triggers: env.recovery ? [] : [triggers.scheduled({ schedule: '*/5 * * * *' })],
      observability: { enabled: true, redactQueryString: true, logs: { enabled: true, invocationLogs: false }, traces: { enabled: false } },
    }, containers: [] };
    case 'egress': {
      const container = egressContainer(env);
      return { worker: {
        env: {
          DB: common.DB!, ENVIRONMENT: bindings.text(env.mode), INTERNAL_SERVICE_KEY: bindings.secret(),
          EGRESS: bindings.durableObject({ worker: workerName(env, 'egress'), exportName: 'WebhookEgress' }),
        },
        exports: { WebhookEgress: exports.durableObject({ storage: 'sqlite', container }) },
      }, containers: [container] };
    }
    case 'hosted': {
      const remote = env.remoteExecutor;
      if (!remote) throw new Error('The hosted Worker requires a mode-specific HOSTED_EXECUTOR_FILE.');
      const container = sandboxContainer(env);
      return { worker: {
        domains: env.mode === 'development' ? [] : [new URL(remote.origin).hostname],
        env: {
          HOSTED_WORKFLOW: bindings.workflow({ name: resourceName(env, 'hosted-attempts', 'execution'), worker: workerName(env, 'hosted'), exportName: 'HostedAttemptWorkflow' }),
          HOSTED_ATTEMPTS: bindings.durableObject({ worker: workerName(env, 'hosted'), exportName: 'RemoteAttemptController' }),
          SANDBOX: bindings.durableObject({ worker: workerName(env, 'hosted'), exportName: 'HostedSandbox' }),
          BACKUP_BUCKET: bindings.r2({ name: executionStorage(env).name, ...(env.jurisdiction ? { jurisdiction: env.jurisdiction } : {}), dev: { remote: false } }),
          HOSTED_EXECUTOR_ID: bindings.text(remote.id),
          HOSTED_CONTROL_KEY: bindings.secret(),
          HOSTED_CALLBACK_ORIGIN: bindings.text(remote.callback_origin),
          HOSTED_PROFILES_JSON: bindings.text(profiles(env)),
          ENVIRONMENT: bindings.text(env.mode),
        },
        exports: {
          HostedAttemptWorkflow: exports.workflow({ name: resourceName(env, 'hosted-attempts', 'execution'), limits: { steps: 1_024 }, concurrency: { limit: limits(env.mode).hosted_max_instances } }),
          RemoteAttemptController: exports.durableObject({ storage: 'sqlite' }),
          HostedSandbox: exports.durableObject({ storage: 'sqlite', container }),
          ContainerProxy: exports.worker(),
        },
        triggers: [triggers.scheduled({ schedule: '* * * * *' })],
        observability: { enabled: true, redactQueryString: true, logs: { enabled: true, invocationLogs: false }, traces: { enabled: true, headSamplingRate: 0.01 } },
      }, containers: [container] };
    }
  }
}

export function configuration(role: WorkerRole, mode?: string, env = environment(mode)): CloudflareConfig & { worker: WorkerConfig; containers: ContainerConfig[] } {
  const common = role === 'hosted' ? {} : commonBindings(env, role);
  const selected = roleConfiguration(env, role, common);
  return {
    ...(env.accounts[workerAccount(role)] ? { accountId: env.accounts[workerAccount(role)] } : {}),
    worker: {
      name: workerName(env, role),
      entrypoint: workerSourcePath(role),
      compatibilityDate: COMPATIBILITY_DATE,
      compatibilityFlags: ['nodejs_compat'],
      workersDev: false, previewUrls: false,
      limits: { cpuMs: role === 'background' || role === 'hosted' ? 300_000 : 30_000, subrequests: ['api', 'background', 'execution', 'hosted'].includes(role) ? 65_536 : 100 },
      observability: { enabled: true, redactQueryString: true, logs: { enabled: true, headSamplingRate: 1, invocationLogs: true }, traces: { enabled: true, headSamplingRate: 0.05 } },
      logpush: env.mode !== 'development',
      ...selected.worker,
    },
    containers: selected.containers,
  };
}

export function localKeys(): Record<WorkerRole, Record<string, string>> {
  const path = join(ROOT, '.gitknot/local/keys.json');
  if (!existsSync(path)) throw new Error('Local keys are missing. Run npm run setup first.');
  const keys = JSON.parse(readFileSync(path, 'utf8')) as Record<WorkerRole, Record<string, string>>;
  const selected: Partial<Record<WorkerRole, Record<string, string>>> = {};
  for (const [role, names] of Object.entries(SECRET_NAMES)) {
    selected[role as WorkerRole] = Object.fromEntries(names.map(name => {
      const value = keys[role as WorkerRole]?.[name];
      if (typeof value !== 'string' || !value) throw new Error(`Local ${role}/${name} is missing. Rerun node scripts/setup.ts --skip-install --skip-migrations to add new local key bindings without replacing existing keys.`);
      return [name, value];
    }));
  }
  parseIdentityKeyRing(selected.api?.IDENTITY_KEYS_JSON);
  return selected as Record<WorkerRole, Record<string, string>>;
}

export function localWorker(role: WorkerRole, containers: boolean): WorkerConfig {
  const worker = configuration(role, 'development').worker;
  const env = { ...worker.env };
  for (const [name, value] of Object.entries(localKeys()[role])) env[name] = bindings.text(value);
  // The native helper is a real local Git process, explicitly selected only by
  // this development wrapper. Production configuration never receives it.
  if (role === 'git') {
    delete env.ARTIFACTS;
    env.GIT_STORAGE_MODE = bindings.text('local');
    env.GIT_NATIVE_ORIGIN = bindings.text('http://127.0.0.1:8790');
    env.GIT_LOCAL_ROOT = bindings.text(join(ROOT, '.gitknot/git/repositories'));
    worker.entrypoint = join(ROOT, 'infra/local/git-worker.ts');
  }
  if (role === 'api') delete env.ASSETS;
  if (role === 'egress') {
    return { ...worker, entrypoint: join(ROOT, 'infra/local/egress.ts'), exports: {}, env: { INTERNAL_SERVICE_KEY: bindings.text(localKeys().egress.INTERNAL_SERVICE_KEY!) } };
  }
  const configuredExports = { ...worker.exports };
  if (!containers || role === 'git') {
    for (const [name, value] of Object.entries(configuredExports)) {
      if (value.type === 'durable-object' && 'container' in value) configuredExports[name] = exports.durableObject({ storage: 'sqlite' });
    }
  }
  const { assets: _assets, ...rest } = worker;
  return { ...rest, env, exports: configuredExports };
}

export function developmentConfiguration(useContainers: boolean): CloudflareConfig {
  const env = environment('development');
  return {
    worker: {
      name: `${env.prefix}-local-router`,
      entrypoint: join(ROOT, 'infra/local/router.ts'),
      compatibilityDate: COMPATIBILITY_DATE,
      workersDev: false, previewUrls: false,
      env: {
        API: bindings.worker({ worker: workerName(env, 'api') }),
        GIT: bindings.worker({ worker: workerName(env, 'git') }),
        BACKGROUND: bindings.worker({ worker: workerName(env, 'background') }),
        SECRETS: bindings.worker({ worker: workerName(env, 'secrets') }),
      },
    },
    containers: useContainers ? [sandboxContainer(env)] : [],
  };
}
