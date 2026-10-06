import { QUEUES } from './cloudflare.ts';
import { coreShards, directoryName, executionContainerName, executionStorage, identityStorage, localDatabaseId, resourceName, workerAccount, workerName, workerConfigPath, workerRoles, type AccountRole, type Environment } from './environment.ts';
import { limits, LINUX_SMALL, PROVIDER_LIMITS } from './limits.ts';

export type ResourceKind = 'd1' | 'r2' | 'queue' | 'artifacts';
export interface ResourceSpec {
  key: string;
  kind: ResourceKind;
  account: AccountRole;
  name: string;
  purpose: string;
  body: Record<string, unknown>;
  existing?: boolean;
}

export interface PolicySpec {
  key: string;
  account: AccountRole;
  read: string[];
  apply: string[];
  body: Record<string, unknown>;
}

export function resources(env: Environment): ResourceSpec[] {
  const execution = executionStorage(env);
  const identity = identityStorage(env);
  const d1 = (key: string, suffix: string, purpose: string): ResourceSpec => ({
    key, kind: 'd1', account: 'trusted', name: resourceName(env, suffix), purpose,
    body: { name: resourceName(env, suffix), ...(env.jurisdiction ? { jurisdiction: env.jurisdiction } : {}), read_replication: { mode: 'auto' } },
  });
  const r2 = (suffix: string, purpose: string, account: AccountRole = 'trusted'): ResourceSpec => ({
    key: `r2.${suffix}`, kind: 'r2', account, name: resourceName(env, suffix, account), purpose,
    body: { name: resourceName(env, suffix, account), storageClass: 'Standard' },
  });
  return [
    { ...d1('d1.directory', 'directory', 'Shared routing directory: immutable resource ID → cell/shard/epoch.'), name: directoryName(env), body: { ...d1('d1.directory', 'directory', '').body, name: directoryName(env) }, existing: env.cell !== env.directoryCell },
    ...coreShards(env).map(shard => d1(shard.key, shard.shard, 'Authoritative identity/catalog/collaboration/workflow/billing metadata; no FTS virtual tables.')),
    ...(identity.existing ? [{ key: identity.key, kind: 'd1' as const, account: 'trusted' as const, name: identity.name, purpose: 'Shared existing account/credential authority. Metadata cells do not authorize from cloned local identity rows.', body: { name: identity.name }, existing: true }] : []),
    d1('d1.search', 'search', 'Rebuildable full-text projections, isolated from native D1 exports.'),
    r2('blobs', 'Private, authorized logs/outputs/LFS/uploads/export objects with checksums.'),
    r2('backups', 'Independent retained backups; application cleanup credentials cannot shorten retention.'),
    r2('logpush', 'Operational trace delivery with bounded retention.'),
    { key: execution.key, kind: 'r2', account: execution.account, name: execution.name,
      purpose: env.remoteExecutor ? 'Ephemeral hosted-account SDK staging; the runtime journals and verifies deletion. Retained objects are copied to trusted BLOBS.' : 'Direct SDK execution snapshots only; never repository backups.',
      body: { name: execution.name, storageClass: 'Standard' } },
    ...(env.remoteExecutor ? [r2('hosted-logpush', 'Execution-account operational traces, independently credentialed and retained.', 'execution')] : []),
    ...QUEUES.flatMap(queue => [false, true].map(dlq => {
      const suffix = `${queue.suffix}${dlq ? '-dlq' : ''}`;
      return {
        key: `queue.${suffix}`, kind: 'queue' as const, account: 'trusted' as const,
        name: resourceName(env, suffix), purpose: dlq ? `Dead letters for ${queue.binding}; durable source events remain replayable.` : `${queue.binding}: ID-only delivery, bounded retries and independent backpressure.`,
        body: { queue_name: resourceName(env, suffix), settings: { message_retention_period: 14 * 86400 }, ...(env.jurisdiction ? { jurisdiction: env.jurisdiction } : {}) },
      };
    })),
    { key: 'artifacts.repositories', kind: 'artifacts', account: 'trusted', name: resourceName(env, 'repositories'), purpose: 'Canonical Git namespace; one explicit write gate, repository-scoped tokens.', body: { namespace: resourceName(env, 'repositories'), ...(env.jurisdiction ? { jurisdiction: env.jurisdiction } : {}) } },
  ];
}

function lifecycleRule(id: string, prefix: string, days: number) {
  return { id, enabled: true, conditions: { prefix }, deleteObjectsTransition: { condition: { type: 'Age', maxAge: days * 86400 } } };
}

export function bucketPolicies(env: Environment): PolicySpec[] {
  return resources(env).filter(resource => resource.kind === 'r2').flatMap(bucket => {
    const jurisdiction = env.jurisdiction ? ['--cf-r2-jurisdiction', env.jurisdiction] : [];
    const args = [bucket.name, ...jurisdiction];
    const rules: Record<string, unknown>[] = [{
      id: 'gitknot-abort-incomplete-uploads', enabled: true, conditions: { prefix: '' },
      abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 86400 } },
    }];
    if (bucket.key === 'r2.logpush' || bucket.key === 'r2.hosted-logpush') rules.push(lifecycleRule('gitknot-trace-retention', '', 14));
    // Object manifests control ordinary blob/snapshot retention. A broad age
    // rule would delete live LFS, review commits, or referenced output objects.
    if (bucket.key === 'r2.backups') rules.push(lifecycleRule('gitknot-backup-retention', 'scheduled/', limits(env.mode).backup_retention_days));
    const policies: PolicySpec[] = [
      { key: `${bucket.key}.private`, account: bucket.account, read: ['r2', 'buckets', 'domains', 'managed', 'list', ...args], apply: ['r2', 'buckets', 'domains', 'managed', 'update', ...args], body: { enabled: false } },
      { key: `${bucket.key}.lifecycle`, account: bucket.account, read: ['r2', 'buckets', 'lifecycle', 'get', ...args], apply: ['r2', 'buckets', 'lifecycle', 'update', ...args], body: { rules } },
    ];
    if (bucket.key === 'r2.backups') policies.push({
      key: 'r2.backups.lock', account: 'trusted',
      read: ['r2', 'buckets', 'locks', 'get', ...args], apply: ['r2', 'buckets', 'locks', 'update', ...args],
      body: { rules: [{ id: 'gitknot-recovery-window', enabled: true, prefix: 'scheduled/', condition: { type: 'Age', maxAgeSeconds: 30 * 86400 } }] },
    });
    return policies;
  });
}

export function ingressRules(env: Environment) {
  const apiHost = new URL(env.origins.api).hostname;
  const appHost = new URL(env.origins.app).hostname;
  const gitHost = new URL(env.origins.git).hostname;
  const callbacks = '(starts_with(http.request.uri.path, "/internal/hosted/attempts/"))';
  const rule = (ref: string, expression: string, maximum: number, contentType: string, content: string) => ({
    ref: `${env.prefix}-${ref}`, description: `${env.prefix}: ${ref}`, expression, enabled: true, action: 'block',
    action_parameters: { response: { status_code: 429, content_type: contentType, content } },
    ratelimit: { characteristics: ['cf.colo.id', 'ip.src'], period: 60, requests_per_period: maximum, mitigation_timeout: 60 },
  });
  return {
    name: `${env.prefix}-machine-ingress`, kind: 'zone', phase: 'http_ratelimit',
    rules: [
      rule('api-request-limit', `(http.host eq "${apiHost}" or (http.host eq "${appHost}" and starts_with(http.request.uri.path, "/v1/")))${env.remoteExecutor ? ` and not ${callbacks}` : ''}`, 600, 'application/json', JSON.stringify({ error: { code: 'rate_limited', message: 'Too many requests. Retry in 60 seconds.' } })),
      ...(env.remoteExecutor ? [rule('hosted-callback-data-limit', `(http.host eq "${apiHost}" and ${callbacks} and (ends_with(http.request.uri.path, "/log") or ends_with(http.request.uri.path, "/output") or ends_with(http.request.uri.path, "/snapshot-upload") or ends_with(http.request.uri.path, "/cache-read") or ends_with(http.request.uri.path, "/input")))`, 10_000, 'application/json', JSON.stringify({ error: { code: 'rate_limited', message: 'Hosted data delivery is temporarily rate limited.' } }))] : []),
      rule('git-request-limit', `(http.host eq "${gitHost}")`, 180, 'text/plain', 'GitKnot: too many Git requests. Retry in 60 seconds.\n'),
    ],
  };
}

export function hostedIngressRules(env: Environment) {
  if (!env.remoteExecutor) throw new Error('Hosted ingress requires a configured remote executor.');
  const host = new URL(env.remoteExecutor.origin).hostname;
  return {
    name: `${env.executionPrefix}-hosted-ingress`, kind: 'zone', phase: 'http_ratelimit',
    rules: [{
      ref: `${env.executionPrefix}-hosted-accept-limit`, description: 'Bound new hosted admission requests independently from status and cleanup.',
      expression: `(http.host eq "${host}" and ends_with(http.request.uri.path, "/accept"))`, enabled: true, action: 'block',
      action_parameters: { response: { status_code: 429, content_type: 'application/json', content: JSON.stringify({ error: { code: 'rate_limited', message: 'Hosted admission is temporarily rate limited.' } }) } },
      ratelimit: { characteristics: ['cf.colo.id', 'ip.src'], period: 60, requests_per_period: 600, mitigation_timeout: 60 },
    }],
  };
}

export function hostedWafRules(env: Environment) {
  if (!env.remoteExecutor) throw new Error('Hosted ingress requires a configured remote executor.');
  const host = new URL(env.remoteExecutor.origin).hostname;
  return {
    name: `${env.executionPrefix}-hosted-waf`, kind: 'zone', phase: 'http_request_firewall_custom',
    rules: [
      { ref: `${env.executionPrefix}-hosted-no-challenges`, description: 'Hosted control is a signed machine protocol.', expression: `(http.host eq "${host}")`, enabled: true,
        action: 'skip', action_parameters: { products: ['bic', 'securityLevel'], phases: ['http_request_sbfm'] }, logging: { enabled: true } },
      { ref: `${env.executionPrefix}-hosted-methods`, description: 'The hosted control endpoint accepts POST only.', expression: `(http.host eq "${host}" and http.request.method ne "POST")`, enabled: true,
        action: 'block', action_parameters: { response: { status_code: 403, content_type: 'application/json', content: JSON.stringify({ error: { code: 'method_not_allowed' } }) } } },
    ],
  };
}

export function wafRules(env: Environment) {
  const api = new URL(env.origins.api).hostname;
  const app = new URL(env.origins.app).hostname;
  const git = new URL(env.origins.git).hostname;
  const machine = `(http.host in {"${api}" "${git}"} or (http.host eq "${app}" and starts_with(http.request.uri.path, "/v1/")))`;
  return {
    name: `${env.prefix}-protocol-waf`, kind: 'zone', phase: 'http_request_firewall_custom',
    rules: [
      { ref: `${env.prefix}-machine-challenge-exclusions`, description: `${env.prefix}: protocol clients do not render browser challenges`, expression: machine, enabled: true,
        action: 'skip', action_parameters: { products: ['bic', 'securityLevel'], phases: ['http_request_sbfm'] }, logging: { enabled: true } },
      { ref: `${env.prefix}-unsupported-methods`, description: `${env.prefix}: reject unsupported machine-protocol methods`,
        expression: `${machine} and not http.request.method in {"GET" "HEAD" "POST" "PUT" "PATCH" "DELETE" "OPTIONS"}`, enabled: true,
        action: 'block', action_parameters: { response: { status_code: 403, content_type: 'text/plain', content: 'GitKnot: unsupported HTTP method.\n' } } },
    ],
  };
}

export function topology(env: Environment) {
  return {
    mode: env.mode, cell_id: env.cell, execution_cell_id: env.executionCell, accounts: env.accounts,
    directory_cell_id: env.directoryCell, identity_cell_id: env.identityCell, identity_shard_id: identityStorage(env).shard, ingress_cell_id: env.ingressCell, peers: env.peers, recovery: env.recovery,
    zone: { name: 'gitknot.com', existing: true, id: env.state.zone_id ?? null },
    origins: env.origins,
    resources: resources(env),
    local_database_ids: env.mode === 'development' ? Object.fromEntries(resources(env).filter(resource => resource.kind === 'd1').map(resource => [resource.name, localDatabaseId(resource.name)])) : undefined,
    bucket_policies: bucketPolicies(env),
    workers: workerRoles(env).map(role => ({ role, name: workerName(env, role), account: workerAccount(role), configuration: workerConfigPath(role), public: role === 'api' || role === 'git' || role === 'hosted' })),
    namespaces: [
      { binding: 'REPO_COORDINATOR', class: 'RepositoryCoordinator', worker: workerName(env, 'git'), storage: 'sqlite' },
      { binding: 'GIT_CONTAINERS', class: 'GitContainer', worker: workerName(env, 'git'), storage: 'sqlite' },
      { binding: 'ATTEMPTS', class: 'AttemptController', worker: workerName(env, 'execution'), storage: 'sqlite' },
      { binding: 'ADMISSION', class: 'AdmissionController', worker: workerName(env, 'execution'), storage: 'sqlite' },
      { binding: 'SANDBOX', class: env.remoteExecutor ? 'HostedSandbox' : 'Sandbox', worker: workerName(env, env.remoteExecutor ? 'hosted' : 'execution'), storage: 'sqlite' },
      ...(env.remoteExecutor ? [{ binding: 'HOSTED_ATTEMPTS', class: 'RemoteAttemptController', worker: workerName(env, 'hosted'), storage: 'sqlite' }] : []),
      { binding: 'EGRESS', class: 'WebhookEgress', worker: workerName(env, 'egress'), storage: 'sqlite' },
    ],
    workflows: [
      { binding: 'RUN_WORKFLOW', class: 'RunWorkflow', name: resourceName(env, 'runs') },
      { binding: 'OPERATIONS', class: 'OperationWorkflow', name: resourceName(env, 'operations') },
      ...(env.remoteExecutor ? [{ binding: 'HOSTED_WORKFLOW', class: 'HostedAttemptWorkflow', name: resourceName(env, 'hosted-attempts', 'execution') }] : []),
    ],
    containers: [
      { name: resourceName(env, 'native-git'), image: 'services/git/Dockerfile', instance_type: 'standard-2', max_instances: limits(env.mode).git_max_instances, trust: 'native-git' },
      { ...LINUX_SMALL, dockerfile: env.remoteExecutor ? 'workers/hosted/Dockerfile' : LINUX_SMALL.dockerfile, name: executionContainerName(env), account: executionStorage(env).account, max_instances: limits(env.mode).hosted_max_instances, trust: 'untrusted-job' },
      { name: resourceName(env, 'webhook-egress'), image: 'infra/egress/Dockerfile', instance_type: 'basic', max_instances: 2, trust: 'webhook-egress' },
    ],
    ingress: ingressRules(env),
    waf: wafRules(env),
    hosted: env.remoteExecutor ? { executor: env.remoteExecutor, zone_id: env.state.hosted_zone_id, zone_name: env.state.hosted_zone_name, storage: executionStorage(env), rate_limits: hostedIngressRules(env), waf: hostedWafRules(env) } : undefined,
    email: { domain: env.mode === 'production' ? 'mail.gitknot.com' : 'mail.staging.gitknot.com', binding: 'EMAIL', provider_capacity_must_be_observed: true },
    observability: { analytics_dataset: resourceName(env, 'metrics').replaceAll('-', '_'), logpush_dataset: 'workers_trace_events', bucket: resourceName(env, 'logpush'), ledger_is_financial_authority: true },
    event_subscriptions: [
      { source: 'artifacts', queue: resourceName(env, 'artifacts-events'), events: ['repo.created', 'repo.deleted', 'repo.forked', 'repo.imported'], scope: 'account; consumer filters the exact namespace' },
      { source: 'email.sending', domain: env.mode === 'production' ? 'mail.gitknot.com' : 'mail.staging.gitknot.com', queue: resourceName(env, 'mail'), events: ['message.delivered', 'message.deferred', 'message.bounced', 'message.failed', 'message.rejected', 'message.complained'] },
    ],
    limits: limits(env.mode), provider_limits: PROVIDER_LIMITS,
    release_gates: ['Measured hosted profile and digest-pinned image', 'Artifacts atomic/conditional publication attestation', 'Cloudflare plan entitlements and actual limits', 'Fresh-cell restore and route-epoch fencing drill', 'Mail sending DNS and quota', 'Logpush destination credentials and verified delivery'],
    account_separation: env.remoteExecutor ? 'HTTPS remote runtime; execution Worker/D1/admission/vault remain trusted; hosted account owns only its Workflow/DO/Sandbox and ephemeral storage' : 'direct hosted execution in the trusted account, with separate native-Git and customer-job Container pools',
  };
}
