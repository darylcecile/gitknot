import { z } from 'zod';
import { canonicalJson, deepFreeze, digestJson } from './canonical.ts';
import { evaluateCondition } from './conditions.ts';
import { invalid, WorkflowValidationError } from './errors.ts';
import { accessSchema, commitSchema, digestSchema, toolchainSchema, type Access, type OutputDefinition, type Value, type WorkflowDefinition, type WorkflowModule } from './schema.ts';
import { accessWithin, inputEnvironmentName, isReference, parseDuration, parseWorkflow, validateGraph } from './validation.ts';
import type { CompileContext, CompiledCommand, CompiledJob, CompiledOutput, CompiledStep, ResolvedToolchain, RunManifest, ToolchainDescriptor, WorkflowEvent, WorkflowPolicy } from './types.ts';

export const COMPILER_VERSION = '1.0.0' as const;

const policySchema = z.strictObject({
  revision: z.union([z.string().min(1).max(256), z.number().int().nonnegative()]),
  allowed_workflow_revisions: z.array(commitSchema).min(1).max(512),
  allowed_source_revisions: z.array(commitSchema).max(10_000).optional(),
  allowed_source_trust: z.array(z.enum(['trusted', 'untrusted'])).min(1).optional(),
  access: accessSchema,
  hosted_profiles: z.array(z.string()).max(128),
  self_hosted_pools: z.record(z.string(), z.strictObject({
    trust: z.enum(['trusted', 'untrusted']), disposable: z.boolean(), repository_ids: z.array(z.string()).optional(), producer_id: z.string().regex(/^(?:pool|runner):[a-zA-Z0-9_-]+$/).optional(),
  })),
  inapplicable_jobs: z.array(z.string()).max(512),
  allowed_toolchains: z.array(z.string()).optional(),
  allowed_modules: z.record(z.string(), digestSchema).optional(),
  environments: z.record(z.string(), z.strictObject({ approval_required: z.boolean(), allowed_jobs: z.array(z.string()).optional() })).optional(),
  limits: z.record(z.string(), z.number().int().positive()).optional(),
});

export const workflowEventSchema = z.strictObject({
  type: z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/),
  changed_paths: z.array(z.string().min(1).max(4096)).max(100_000).optional(),
  ref: z.string().max(1024).optional(),
  pull_request_id: z.string().max(128).optional(),
  merge_candidate_id: z.string().max(128).optional(),
  inputs: z.record(z.string().max(128), z.union([z.string().max(65_536), z.number().finite(), z.boolean(), z.null()])).optional(),
});

export const trustIdentitySchema = z.strictObject({
  level: z.enum(['trusted', 'untrusted']), fork: z.boolean(), producer_id: z.string().min(1).max(256),
});

function validateContext(context: CompileContext): { policy: WorkflowPolicy; event: WorkflowEvent } {
  const schema = z.strictObject({
    repo_id: z.string().min(1).max(256), commit: commitSchema, workflow_revision: commitSchema,
    event: workflowEventSchema, trust: trustIdentitySchema, policy: policySchema,
    toolchains: z.record(z.string(), toolchainSchema), modules: z.record(z.string(), z.unknown()).optional(),
    configuration: z.strictObject({ selection_id: z.string().min(1).max(256), selection_digest: digestSchema }).optional(),
  });
  const parsed = schema.safeParse(context);
  if (!parsed.success) throw new WorkflowValidationError(parsed.error.issues.map((issue) => ({ code: issue.code, path: `context.${issue.path.join('.')}`, message: issue.message })));
  const { policy, event, trust } = parsed.data;
  if (!policy.allowed_workflow_revisions.includes(context.workflow_revision)) invalid('definition_untrusted', 'workflow_revision', 'The workflow definition revision is not allowed by trusted policy.');
  if (policy.allowed_source_revisions && !policy.allowed_source_revisions.includes(context.commit)) invalid('source_revision_denied', 'commit', 'The source revision is not allowed by trusted policy.');
  if (policy.allowed_source_trust && !policy.allowed_source_trust.includes(trust.level)) invalid('source_trust_denied', 'trust', 'The source trust class is not allowed by policy.');
  if (trust.fork && trust.level !== 'untrusted') invalid('source_trust_invalid', 'trust', 'Fork source must use the untrusted trust class.');
  const normalizedEvent = { ...event };
  if (event.changed_paths) normalizedEvent.changed_paths = [...new Set(event.changed_paths)].sort();
  return { policy: JSON.parse(JSON.stringify(policy)) as WorkflowPolicy, event: JSON.parse(JSON.stringify(normalizedEvent)) as WorkflowEvent };
}

export async function fingerprintToolchain(descriptor: ToolchainDescriptor): Promise<string> {
  const parsed = toolchainSchema.safeParse(descriptor);
  if (!parsed.success) invalid('toolchain_invalid', 'toolchain', 'A toolchain needs an exact OS, architecture, tool versions and an optional digest-pinned image.');
  return digestJson(JSON.parse(JSON.stringify(parsed.data)));
}

export async function resolveToolchain(name: string, catalog: Record<string, ToolchainDescriptor>): Promise<ResolvedToolchain> {
  const descriptor = catalog[name];
  if (!descriptor) return invalid('toolchain_unresolved', 'toolchain', `Toolchain ${name} is not in the pinned catalog.`);
  const parsed = toolchainSchema.safeParse(descriptor);
  if (!parsed.success) return invalid('toolchain_invalid', `toolchains.${name}`, 'The resolved toolchain descriptor is invalid.');
  return { name, ...JSON.parse(JSON.stringify(parsed.data)) as ToolchainDescriptor, fingerprint: await fingerprintToolchain(parsed.data) };
}

function normalizeAccess(access: Access): Access {
  return { repository: access.repository, capabilities: [...new Set(access.capabilities)].sort(), secrets: [...new Set(access.secrets)].sort() };
}

function enforcePolicy(jobId: string, definition: WorkflowDefinition, context: CompileContext, policy: WorkflowPolicy): void {
  const job = definition.jobs[jobId]!;
  const access = job.access ?? definition.access;
  const ceiling = accessSchema.parse(policy.access);
  if (!accessWithin(access, ceiling)) invalid('policy_access_denied', `jobs.${jobId}.access`, 'Requested permissions exceed the trusted policy ceiling.');
  const untrusted = context.trust.level === 'untrusted' || context.trust.fork;
  if (untrusted && (access.repository === 'write' || access.secrets.length || access.capabilities.length)) invalid('untrusted_access', `jobs.${jobId}.access`, 'Untrusted source receives read-only source access without secrets or privileged capabilities.');
  const executor = (job.executor ?? definition.defaults.executor)!;
  if (executor.type === 'hosted') {
    if (!policy.hosted_profiles.includes(executor.profile)) invalid('executor_denied', `jobs.${jobId}.executor`, 'The hosted profile is not allowed by trusted policy.');
  } else {
    const pool = policy.self_hosted_pools[executor.pool];
    if (!pool) invalid('executor_denied', `jobs.${jobId}.executor`, 'The customer runner pool is not allowed by trusted policy.');
    if (pool.repository_ids && !pool.repository_ids.includes(context.repo_id)) invalid('pool_scope', `jobs.${jobId}.executor`, 'The runner pool does not include this repository.');
    if (untrusted && (!pool.disposable || pool.trust !== 'untrusted')) invalid('pool_trust', `jobs.${jobId}.executor`, 'Untrusted source requires an explicitly disposable, untrusted runner pool.');
    if (!untrusted && pool.trust !== 'trusted') invalid('pool_trust', `jobs.${jobId}.executor`, 'Trusted source requires a trusted runner pool.');
  }
  const toolchain = (job.toolchain ?? definition.defaults.toolchain)!;
  if (policy.allowed_toolchains && !policy.allowed_toolchains.includes(toolchain)) invalid('toolchain_denied', `jobs.${jobId}.toolchain`, 'This toolchain is not allowed by trusted policy.');
  if (job.environment) {
    const environment = policy.environments?.[job.environment];
    if (!environment || (environment.allowed_jobs && !environment.allowed_jobs.includes(jobId))) invalid('environment_denied', `jobs.${jobId}.environment`, 'The protected environment is not allowed for this job.');
    if (untrusted) invalid('environment_trust', `jobs.${jobId}.environment`, 'Untrusted source cannot enter a protected environment.');
  }
}

function compileOutputs(outputs: Record<string, OutputDefinition>): Record<string, CompiledOutput> {
  return Object.fromEntries(Object.entries(outputs).sort(([a], [b]) => a.localeCompare(b)).map(([name, output]) => [name, {
    type: output.type, path: output.path, required: output.required, retention_seconds: parseDuration(output.retention) / 1_000,
  }]));
}

function asValue(value: unknown): Value {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return { literal: value as never };
}

function moduleInputs(module: WorkflowModule, provided: Record<string, Value>): Record<string, Value> {
  return Object.fromEntries(Object.entries(module.inputs).map(([name, spec]) => [name, Object.hasOwn(provided, name) ? provided[name]! : asValue(spec.default ?? null)]));
}

function substituteInputs(env: Record<string, Value>, inputs: Record<string, Value>): Record<string, Value> {
  return Object.fromEntries(Object.entries(env).map(([name, value]) => [name, isReference(value) && 'input' in value ? inputs[value.input]! : value]));
}

function compileStep(step: WorkflowDefinition['jobs'][string]['steps'][number], index: number, definition: WorkflowDefinition, modules: Record<string, WorkflowModule>, jobTimeout: number): CompiledStep {
  const timeout = step.timeout ? parseDuration(step.timeout) : jobTimeout;
  const command = (entry: { run: string; shell?: CompiledCommand['shell']; working_directory: string; env: Record<string, Value>; timeout?: string }, inputs: Record<string, Value> = {}): CompiledCommand => ({
    run: entry.run, shell: entry.shell ?? definition.defaults.shell,
    working_directory: entry.working_directory, env: substituteInputs(entry.env, inputs),
    timeout_ms: entry.timeout ? parseDuration(entry.timeout) : timeout,
  });
  if ('run' in step) return {
    id: step.id ?? `step_${index + 1}`, module: null, commands: [command(step)], env: {}, outputs: compileOutputs(step.outputs), timeout_ms: timeout,
  };
  const module = modules[step.uses]!;
  const inputs = moduleInputs(module, step.with);
  return {
    id: step.id, module: { reference: step.uses, digest: definition.modules[step.uses]! },
    commands: module.steps.map((entry) => command(entry, inputs)),
    env: { ...step.env, ...Object.fromEntries(Object.entries(inputs).map(([name, value]) => [inputEnvironmentName(name), value])) },
    outputs: compileOutputs(module.outputs), timeout_ms: timeout,
  };
}

function concurrencyGroup(definition: WorkflowDefinition, context: CompileContext, event: WorkflowEvent): RunManifest['concurrency'] {
  if (!definition.concurrency) return null;
  const { group, supersede } = definition.concurrency;
  let identity: string | undefined;
  if (group === 'workflow') identity = definition.name;
  if (group === 'ref') identity = event.ref;
  if (group === 'pull_request') identity = event.merge_candidate_id ?? event.pull_request_id ?? (isManualEvent(event.type) ? `manual:${context.commit}` : undefined);
  if (group === 'environment') {
    const environments = [...new Set(Object.values(definition.jobs).map((job) => job.environment).filter(Boolean))];
    if (environments.length !== 1) invalid('concurrency_environment', 'concurrency.group', 'An environment concurrency group requires exactly one environment.');
    identity = environments[0];
  }
  if (!identity) invalid('concurrency_input_missing', 'concurrency.group', `The pinned event is missing the ${group} concurrency identity.`);
  return { group: canonicalJson([context.repo_id, definition.name, group, identity]), supersede };
}

export async function compileWorkflow(input: unknown, context: CompileContext): Promise<RunManifest> {
  const definition = parseWorkflow(input);
  const { policy, event } = validateContext(context);
  if (definition.source !== 'event.commit' && definition.source !== context.commit) invalid('source_mismatch', 'source', 'The definition source does not match the pinned source commit.');
  const { order, modules, limits } = validateGraph(definition, { modules: context.modules, limits: policy.limits });
  for (const [reference, module] of Object.entries(modules)) {
    const digest = await digestJson(module);
    if (digest !== definition.modules[reference]) invalid('module_digest_mismatch', `modules.${reference}`, 'The resolved module content differs from its pinned digest.');
    if (policy.allowed_modules && policy.allowed_modules[reference] !== digest) invalid('module_denied', `modules.${reference}`, 'The module digest is not allowed by trusted policy.');
  }
  const policyDigest = await digestJson(policy);
  const definitionDigest = await digestJson(definition);
  const jobs: CompiledJob[] = [];
  for (const id of order) {
    enforcePolicy(id, definition, context, policy);
    const job = definition.jobs[id]!;
    const timeout = parseDuration(job.timeout ?? definition.defaults.timeout);
    const toolchain = await resolveToolchain((job.toolchain ?? definition.defaults.toolchain)!, context.toolchains);
    const executor = (job.executor ?? definition.defaults.executor)!;
    if (executor.type === 'hosted' && (toolchain.os !== 'linux' || toolchain.arch !== 'x64')) invalid('hosted_toolchain', `jobs.${id}.toolchain`, 'Hosted profiles require Linux/x64; use a matching customer-owned pool for other platforms.');
    const condition = definition.triggers.includes(event.type) || isManualEvent(event.type)
      ? evaluateCondition(job.when, event, policy.inapplicable_jobs.includes(id))
      : { outcome: 'blocked' as const, reason: 'Trigger mismatch: this workflow does not subscribe to the supplied event. This is not a policy-authorized inapplicable verification.' };
    const effectiveConfig = {
      id, executor, toolchain, timeout_ms: timeout, access: normalizeAccess(job.access ?? definition.access), env: job.env,
      steps: job.steps.map((step, index) => compileStep(step, index, definition, modules, timeout)),
      outputs: compileOutputs(job.outputs), reports: job.reports, environment: job.environment ?? null,
    };
    const cache = job.cache ? {
      ...job.cache,
      namespace: await digestJson({ repo_id: context.repo_id, trust: context.trust, job_id: id, effective_config_digest: await digestJson(effectiveConfig), toolchain: toolchain.fingerprint, policy: policyDigest, modules: definition.modules, definition: definitionDigest, paths: job.cache.paths, key_files: job.cache.key_files }),
    } : null;
    jobs.push({
      id, producer_id: executor.type === 'hosted' ? `hosted:${executor.profile}` : policy.self_hosted_pools[executor.pool]!.producer_id ?? `pool:${executor.pool}`, needs: [...job.needs].sort(), executor, toolchain, timeout_ms: timeout,
      access: normalizeAccess(job.access ?? definition.access), env: job.env, condition,
      steps: effectiveConfig.steps,
      outputs: compileOutputs(job.outputs),
      reports: Object.fromEntries(Object.entries(job.reports).map(([name, report]) => [name, { path: report.path, format: report.format, required: report.required, retention_seconds: parseDuration(report.retention) / 1_000 }])),
      cache, environment: job.environment ? { name: job.environment, approval_required: policy.environments![job.environment]!.approval_required } : null,
    });
  }
  const unsigned: Omit<RunManifest, 'digest'> = {
    version: 1, compiler_version: COMPILER_VERSION, repo_id: context.repo_id,
    source: { commit: context.commit, workflow_revision: context.workflow_revision },
    workflow: { name: definition.name, definition_digest: definitionDigest }, policy: { revision: String(policy.revision), digest: policyDigest },
    configuration: context.configuration ?? { selection_id: null, selection_digest: null },
    trust: context.trust, event, modules: definition.modules, jobs, order,
    concurrency: concurrencyGroup(definition, context, event), limits,
  };
  // JSON round-trip severs all references to caller-owned objects before freezing.
  const manifest = JSON.parse(canonicalJson({ ...unsigned, digest: await digestJson(unsigned) })) as RunManifest;
  return deepFreeze(manifest) as RunManifest;
}

export async function moduleDigest(input: unknown): Promise<string> {
  const { parseModule } = await import('./validation.ts');
  return digestJson(parseModule(input));
}

function isManualEvent(type: string): boolean {
  return ['workflow.dispatch', 'workflow.manual', 'workflow_dispatch.requested'].includes(type);
}
