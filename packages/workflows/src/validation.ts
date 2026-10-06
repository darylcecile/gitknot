import { parseDocument } from 'yaml';
import { canonicalJson } from './canonical.ts';
import { invalid, WorkflowValidationError, type WorkflowIssue } from './errors.ts';
import { moduleSchema, workflowSchema, type Access, type DataType, type Value, type WorkflowDefinition, type WorkflowModule } from './schema.ts';
import type { ValidationOptions, ValidationResult, WorkflowLimits } from './types.ts';

export const DEFAULT_LIMITS: Readonly<WorkflowLimits> = Object.freeze({
  max_jobs: 128,
  max_fanout: 32,
  max_steps: 128,
  max_timeout_ms: 3_600_000,
  max_log_bytes: 16_777_216,
  max_output_bytes: 268_435_456,
  max_output_files: 10_000,
  max_input_bytes: 268_435_456,
  max_cache_bytes: 268_435_456,
  max_chunk_bytes: 262_144,
});

const HARD_LIMITS: WorkflowLimits = {
  max_jobs: 512,
  max_fanout: 128,
  max_steps: 512,
  max_timeout_ms: 86_400_000,
  max_log_bytes: 1_073_741_824,
  max_output_bytes: 4_294_967_296,
  max_output_files: 100_000,
  max_input_bytes: 4_294_967_296,
  max_cache_bytes: 4_294_967_296,
  max_chunk_bytes: 1_048_576,
};

export function resolveLimits(overrides: Partial<WorkflowLimits> = {}): WorkflowLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    const ceiling = HARD_LIMITS[key as keyof WorkflowLimits];
    if (!ceiling || !Number.isSafeInteger(value) || value < 1 || value > ceiling) {
      invalid('limit_invalid', `limits.${key}`, `Expected a positive integer no greater than ${ceiling ?? 0}.`);
    }
  }
  if (limits.max_chunk_bytes > limits.max_log_bytes || limits.max_chunk_bytes > limits.max_output_bytes) {
    invalid('limit_invalid', 'limits.max_chunk_bytes', 'Chunk size cannot exceed the log or output byte limit.');
  }
  if (limits.max_chunk_bytes < 4) invalid('limit_invalid', 'limits.max_chunk_bytes', 'UTF-8 chunks must allow a complete four-byte code point.');
  return limits;
}

export function parseDuration(value: string): number {
  const match = /^([1-9][0-9]*)(ms|s|m|h|d)$/.exec(value);
  if (!match) return invalid('duration_invalid', '', 'Use a positive duration such as 500ms, 30s, 10m, 1h, or 14d.');
  const scale: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const result = Number(match[1]) * scale[match[2]!]!;
  if (!Number.isSafeInteger(result)) return invalid('duration_invalid', '', 'Duration exceeds the supported range.');
  return result;
}

export function parseDefinition(input: unknown): unknown {
  if (typeof input !== 'string') {
    if (canonicalJson(input).length > 1_048_576) invalid('definition_size', '', 'Definition exceeds 1 MiB.');
    return input;
  }
  if (new TextEncoder().encode(input).byteLength > 1_048_576) invalid('definition_size', '', 'Definition exceeds 1 MiB.');
  try {
    const document = parseDocument(input, { version: '1.2', schema: 'core', strict: true, uniqueKeys: true, merge: false, customTags: [] });
    if (document.errors.length || document.warnings.length) {
      const problem = document.errors[0] ?? document.warnings[0]!;
      const position = problem.linePos?.[0];
      invalid('yaml_invalid', position ? `line ${position.line}:${position.col}` : '', `Invalid YAML (${problem.code}). Duplicate keys, unknown tags, and multiple documents are not allowed.`);
    }
    return document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof WorkflowValidationError) throw error;
    return invalid('yaml_invalid', '', 'Invalid YAML. Aliases, cyclic structures, and custom tags are not supported.');
  }
}

export function parseWorkflow(input: unknown): WorkflowDefinition {
  const parsed = workflowSchema.safeParse(parseDefinition(input));
  if (!parsed.success) throw new WorkflowValidationError(parsed.error.issues.map((issue) => ({ code: issue.code, path: issue.path.join('.'), message: issue.message })));
  return parsed.data;
}

export function parseModule(input: unknown): WorkflowModule {
  const parsed = moduleSchema.safeParse(parseDefinition(input));
  if (!parsed.success) throw new WorkflowValidationError(parsed.error.issues.map((issue) => ({ code: issue.code, path: `module.${issue.path.join('.')}`, message: issue.message })));
  for (const [name, spec] of Object.entries(parsed.data.inputs)) {
    if (spec.default !== undefined && !matchesType(spec.default, spec.type)) invalid('module_input_type', `inputs.${name}.default`, `Default must have type ${spec.type}.`);
    if (!spec.required && spec.default === undefined) invalid('module_input_default', `inputs.${name}`, 'Optional inputs must declare a typed default.');
  }
  validateRetention(parsed.data.outputs, 'module.outputs');
  const names = Object.keys(parsed.data.inputs).map(inputEnvironmentName);
  if (new Set(names).size !== names.length) invalid('module_input_collision', 'inputs', 'Input names must have distinct uppercase environment names.');
  for (const [index, command] of parsed.data.steps.entries()) {
    for (const value of Object.values(command.env)) {
      if (!isReference(value)) continue;
      if ('output' in value) invalid('module_output_scope', `steps.${index}.env`, 'A module consumes outputs through its typed inputs.');
      if ('input' in value && !Object.hasOwn(parsed.data.inputs, value.input)) invalid('module_input_unknown', `steps.${index}.env`, 'Unknown module input.');
      if ('secret' in value && !parsed.data.access.secrets.includes(value.secret)) invalid('secret_undeclared', `steps.${index}.env`, 'Module secret is not declared in module access.');
    }
  }
  return parsed.data;
}

export function inputEnvironmentName(name: string): string {
  return `GITKNOT_INPUT_${name.replaceAll('-', '_').toUpperCase()}`;
}

export function isReference(value: Value): value is Exclude<Value, string | number | boolean | null> {
  return value !== null && typeof value === 'object';
}

export function matchesType(value: unknown, type: DataType): boolean {
  if (type === 'artifact') return false; // Artifacts require a typed output reference, not an arbitrary host path.
  if (type === 'json') return true;
  return typeof value === type && (type !== 'number' || Number.isFinite(value));
}

export function accessWithin(requested: Access, ceiling: Access): boolean {
  const rank = { none: 0, read: 1, write: 2 };
  return rank[requested.repository] <= rank[ceiling.repository]
    && requested.capabilities.every((capability) => ceiling.capabilities.includes(capability))
    && requested.secrets.every((name) => ceiling.secrets.includes(name));
}

export function topologicalOrder(jobs: Record<string, { needs: string[] }>, limits: WorkflowLimits): string[] {
  const ids = Object.keys(jobs).sort();
  if (!ids.length || ids.length > limits.max_jobs) invalid('graph_size', 'jobs', `Expected 1–${limits.max_jobs} jobs.`);
  const children = new Map(ids.map((id) => [id, [] as string[]]));
  const pending = new Map<string, number>();
  for (const id of ids) {
    const needs = jobs[id]!.needs;
    if (new Set(needs).size !== needs.length) invalid('dependency_duplicate', `jobs.${id}.needs`, 'Dependencies must be unique.');
    if (needs.length > limits.max_fanout) invalid('graph_fanout', `jobs.${id}.needs`, `At most ${limits.max_fanout} dependencies are allowed.`);
    for (const dependency of needs) {
      if (!children.has(dependency)) invalid('dependency_missing', `jobs.${id}.needs`, `Unknown dependency ${dependency}.`);
      children.get(dependency)!.push(id);
    }
    pending.set(id, needs.length);
  }
  for (const [id, dependents] of children) {
    if (dependents.length > limits.max_fanout) invalid('graph_fanout', `jobs.${id}`, `At most ${limits.max_fanout} dependents are allowed.`);
  }
  const ready = ids.filter((id) => pending.get(id) === 0);
  const order: string[] = [];
  while (ready.length) {
    if (ready.length > limits.max_fanout) invalid('graph_fanout', 'jobs', `The ready graph frontier exceeds ${limits.max_fanout} jobs.`);
    const id = ready.shift()!;
    order.push(id);
    for (const child of children.get(id)!) {
      const remaining = pending.get(child)! - 1;
      pending.set(child, remaining);
      if (remaining === 0) ready.push(child);
    }
    ready.sort();
  }
  if (order.length !== ids.length) invalid('graph_cycle', 'jobs', 'The dependency graph contains a cycle.');
  return order;
}

export function stepId(step: WorkflowDefinition['jobs'][string]['steps'][number], index: number): string {
  return step.id ?? `step_${index + 1}`;
}

function referenceType(value: Value, path: string, workflow: WorkflowDefinition, jobId: string, steps: Record<string, Record<string, { type: DataType }>>): DataType | null {
  if (!isReference(value)) return value === null ? 'json' : typeof value as 'string' | 'number' | 'boolean';
  if ('literal' in value) return typeof value.literal === 'string' || typeof value.literal === 'boolean' || typeof value.literal === 'number' ? typeof value.literal as DataType : 'json';
  if ('input' in value) return invalid('input_scope', path, 'Input references are only valid inside a versioned module.');
  if ('secret' in value || 'variable' in value) return 'string';
  const [scope, producer, name] = value.output.split('.') as [string, string, string];
  if (scope === 'jobs') {
    if (!workflow.jobs[jobId]!.needs.includes(producer)) invalid('output_dependency', path, 'Job output references must name a direct needs dependency.');
    const output = workflow.jobs[producer]?.outputs[name];
    if (!output) return invalid('output_unknown', path, 'Unknown job output reference.');
    return output.type;
  }
  const output = steps[producer]?.[name];
  if (!output) return invalid('output_unknown', path, 'Unknown or forward step output reference.');
  return output.type;
}

function validateValues(values: Record<string, Value>, path: string, workflow: WorkflowDefinition, jobId: string, steps: Record<string, Record<string, { type: DataType }>>, access: Access): void {
  for (const [key, value] of Object.entries(values)) {
    referenceType(value, `${path}.${key}`, workflow, jobId, steps);
    if (isReference(value) && 'secret' in value && !access.secrets.includes(value.secret)) invalid('secret_undeclared', `${path}.${key}`, 'Secret is not declared in job access.');
  }
}

function validateModuleInputs(step: Extract<WorkflowDefinition['jobs'][string]['steps'][number], { uses: string }>, module: WorkflowModule, workflow: WorkflowDefinition, jobId: string, outputs: Record<string, Record<string, { type: DataType }>>, path: string): void {
  for (const name of Object.keys(step.with)) {
    if (!Object.hasOwn(module.inputs, name)) invalid('module_input_unknown', `${path}.with.${name}`, 'This module does not declare that input.');
  }
  for (const [name, spec] of Object.entries(module.inputs)) {
    const value = step.with[name];
    if (value === undefined) {
      if (spec.required && spec.default === undefined) invalid('module_input_required', `${path}.with.${name}`, 'Required module input is missing.');
      continue;
    }
    const actual = referenceType(value, `${path}.with.${name}`, workflow, jobId, outputs);
    if ((spec.type !== 'json' && actual !== spec.type) || (spec.type === 'json' && actual === 'artifact')) invalid('module_input_type', `${path}.with.${name}`, `Expected ${spec.type}, received ${actual}.`);
  }
}

function validateRetention(outputs: Record<string, { retention: string }>, path: string): void {
  for (const [name, output] of Object.entries(outputs)) {
    const duration = parseDuration(output.retention);
    if (duration < 1_000 || duration > 90 * 86_400_000 || duration % 1_000 !== 0) invalid('retention_limit', `${path}.${name}`, 'Retention must be a whole number of seconds between 1 second and 90 days.');
  }
}

export function validateGraph(workflow: WorkflowDefinition, options: ValidationOptions = {}): { order: string[]; modules: Record<string, WorkflowModule>; limits: WorkflowLimits } {
  const limits = resolveLimits(options.limits);
  const order = topologicalOrder(workflow.jobs, limits);
  const modules: Record<string, WorkflowModule> = Object.create(null) as Record<string, WorkflowModule>;
  for (const id of order) {
    const job = workflow.jobs[id]!;
    const access = job.access ?? workflow.access;
    if (access.repository === 'none') invalid('checkout_permission', `jobs.${id}.access`, 'Pinned source checkout requires repository read access.');
    if (!accessWithin(access, workflow.access)) invalid('permission_escalation', `jobs.${id}.access`, 'Job permissions exceed workflow access.');
    if (!(job.executor ?? workflow.defaults.executor)) invalid('executor_missing', `jobs.${id}.executor`, 'Declare an executor on the job or in defaults.');
    if (!(job.toolchain ?? workflow.defaults.toolchain)) invalid('toolchain_missing', `jobs.${id}.toolchain`, 'Declare a pinned toolchain on the job or in defaults.');
    const timeout = parseDuration(job.timeout ?? workflow.defaults.timeout);
    if (timeout > limits.max_timeout_ms) invalid('timeout_limit', `jobs.${id}.timeout`, `Job timeout exceeds ${limits.max_timeout_ms}ms.`);
    const outputs: Record<string, Record<string, { type: DataType }>> = Object.create(null) as Record<string, Record<string, { type: DataType }>>;
    validateValues(job.env, `jobs.${id}.env`, workflow, id, outputs, access);
    let commandCount = 0;
    for (const [index, step] of job.steps.entries()) {
      const name = stepId(step, index);
      const path = `jobs.${id}.steps.${index}`;
      if (Object.hasOwn(outputs, name)) invalid('step_duplicate', `${path}.id`, 'Step IDs must be unique within a job.');
      if (step.timeout && parseDuration(step.timeout) > timeout) invalid('timeout_limit', `${path}.timeout`, 'A step timeout cannot exceed its job timeout.');
      validateValues(step.env, `${path}.env`, workflow, id, outputs, access);
      if ('run' in step) {
        validateRetention(step.outputs, `${path}.outputs`);
        outputs[name] = step.outputs;
        commandCount += 1;
        continue;
      }
      if (!Object.hasOwn(workflow.modules, step.uses)) invalid('module_unpinned', `${path}.uses`, 'Pin this module by digest in workflow.modules.');
      const source = options.modules?.[step.uses];
      if (source === undefined) invalid('module_unresolved', `${path}.uses`, 'Supply this versioned module in the trusted module registry.');
      const module = modules[step.uses] ?? parseModule(source);
      if (`${module.name}@${module.module_version}` !== step.uses) invalid('module_version', `${path}.uses`, 'Resolved module name/version does not match its reference.');
      if (!accessWithin(module.access, access)) invalid('module_permissions', `${path}.uses`, 'Module requires permissions outside the job access declaration.');
      validateValues(step.with, `${path}.with`, workflow, id, outputs, access);
      validateModuleInputs(step, module, workflow, id, outputs, path);
      for (const command of module.steps) {
        if (command.timeout && parseDuration(command.timeout) > (step.timeout ? parseDuration(step.timeout) : timeout)) invalid('timeout_limit', `${path}.uses`, 'A module command timeout exceeds its enclosing step timeout.');
      }
      modules[step.uses] = module;
      outputs[name] = module.outputs;
      commandCount += module.steps.length;
    }
    if (commandCount > limits.max_steps) invalid('step_limit', `jobs.${id}.steps`, `At most ${limits.max_steps} expanded commands are allowed per job.`);
    validateRetention(job.outputs, `jobs.${id}.outputs`);
    validateRetention(job.reports, `jobs.${id}.reports`);
    if (Object.keys(job.outputs).some((name) => Object.hasOwn(job.reports, name))) invalid('output_name_collision', `jobs.${id}.reports`, 'Reports and job outputs must have distinct names.');
    if (job.cache) {
      const paths = job.cache.paths.map((path) => path.replace(/\/$/, ''));
      if (paths.some((path, index) => paths.some((other, otherIndex) => index !== otherIndex && (path === other || path.startsWith(`${other}/`))))) invalid('cache_path_overlap', `jobs.${id}.cache.paths`, 'Cache paths must be distinct and must not contain one another.');
    }
    if (job.environment && workflow.concurrency?.supersede === 'cancel') invalid('environment_concurrency', `jobs.${id}.environment`, 'Environment jobs must queue rather than supersede older releases.');
  }
  for (const reference of Object.keys(workflow.modules)) {
    if (!Object.hasOwn(modules, reference)) invalid('module_unused', `modules.${reference}`, 'Remove unused module pins.');
  }
  return { order, modules, limits };
}

export function validateWorkflow(input: unknown, options: ValidationOptions = {}): ValidationResult {
  try {
    const definition = parseWorkflow(input);
    validateGraph(definition, options);
    return { valid: true, definition, issues: [] };
  } catch (error) {
    if (error instanceof WorkflowValidationError) return { valid: false, issues: error.issues };
    throw error;
  }
}

export function issue(code: string, path: string, message: string): WorkflowIssue {
  return { code, path, message };
}
