import { z } from 'zod';

export const logicalIdentifierSchema = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/).refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value), 'Reserved identifier.');
export const identifierSchema = logicalIdentifierSchema;
export const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const commitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const durationSchema = z.string().regex(/^[1-9][0-9]*(?:ms|s|m|h|d)$/);
export const moduleReferenceSchema = z.string().regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*@[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/);
export const dataTypeSchema = z.enum(['string', 'number', 'boolean', 'json', 'artifact']);
export const shellSchema = z.enum(['sh', 'bash', 'pwsh', 'cmd']);

export function isSafeRelativePath(path: string, allowGlob = false): boolean {
  if (!path || path.length > 512 || /[\x00-\x1f\x7f\\:]/.test(path) || path.startsWith('/') || path.startsWith('~')) return false;
  if (!allowGlob && /[*?\[\]{}]/.test(path)) return false;
  if (allowGlob && /[\[\]{}]/.test(path)) return false;
  const parts = path.replace(/\/$/, '').split('/');
  return parts.every((part) => part !== '' && part !== '..' && (part !== '.' || path === '.') && (part === '.' || !/[. ]$/.test(part)) && part.toLowerCase() !== '.git' && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

export const relativePathSchema = z.string().refine((path) => isSafeRelativePath(path), 'Expected a safe repository-relative path without traversal or .git metadata.');
export const globPathSchema = z.string().refine((path) => isSafeRelativePath(path, true), 'Expected a safe repository-relative path pattern.');
export const environmentNameSchema = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/).refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value), 'Reserved environment name.');
const scalarSchema = z.union([z.string().max(65_536), z.number().finite(), z.boolean(), z.null()]);
export const referenceSchema = z.union([
  z.strictObject({ input: identifierSchema }),
  z.strictObject({ output: z.string().regex(/^(?:jobs|steps)\.[a-zA-Z_][a-zA-Z0-9_-]*\.[a-zA-Z_][a-zA-Z0-9_-]*$/) }),
  z.strictObject({ secret: environmentNameSchema }),
  z.strictObject({ variable: environmentNameSchema }),
]);
export const valueSchema = z.union([scalarSchema, referenceSchema, z.strictObject({ literal: z.json() })]);
export const envSchema = z.record(environmentNameSchema, valueSchema);

export const accessSchema = z.strictObject({
  repository: z.enum(['none', 'read', 'write']).default('none'),
  capabilities: z.array(z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/)).max(128).default([]),
  secrets: z.array(environmentNameSchema).max(64).default([]),
});

export const executorSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('hosted'), profile: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/) }),
  z.strictObject({ type: z.literal('self_hosted'), pool: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/) }),
]);

export const outputSchema = z.strictObject({
  type: dataTypeSchema.default('artifact'),
  path: relativePathSchema,
  retention: durationSchema.default('14d'),
  required: z.boolean().default(true),
});
export const outputsSchema = z.record(identifierSchema, outputSchema);

export const commandSchema = z.strictObject({
  run: z.string().min(1).max(65_536),
  shell: shellSchema.optional(),
  working_directory: relativePathSchema.default('.'),
  env: envSchema.default({}),
  timeout: durationSchema.optional(),
});

export const stepSchema = z.union([
  z.strictObject({
    id: identifierSchema.optional(),
    ...commandSchema.shape,
    outputs: outputsSchema.default({}),
  }),
  z.strictObject({
    id: identifierSchema,
    uses: moduleReferenceSchema,
    with: z.record(identifierSchema, valueSchema).default({}),
    env: envSchema.default({}),
    timeout: durationSchema.optional(),
  }),
]);

export const conditionSchema = z.strictObject({
  paths: z.strictObject({
    include: z.array(globPathSchema).min(1).max(128),
    exclude: z.array(globPathSchema).max(128).default([]),
  }).optional(),
  events: z.array(z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/)).min(1).max(32).optional(),
  refs: z.array(z.string().max(1024).regex(/^refs\/(?:heads|tags)\/[^\s\x00-\x1f]+$/)).min(1).max(64).optional(),
});

export const cacheSchema = z.strictObject({
  paths: z.array(relativePathSchema).min(1).max(32),
  key_files: z.array(relativePathSchema).min(1).max(64),
  mode: z.enum(['read', 'read_write']).default('read_write'),
});
export const reportsSchema = z.record(identifierSchema, z.strictObject({
  path: relativePathSchema,
  format: z.enum(['junit', 'sarif', 'json']),
  required: z.boolean().default(true),
  retention: durationSchema.default('14d'),
}));
export const jobSchema = z.strictObject({
  needs: z.array(identifierSchema).max(512).default([]),
  executor: executorSchema.optional(),
  toolchain: z.string().min(1).max(128).optional(),
  timeout: durationSchema.optional(),
  access: accessSchema.optional(),
  env: envSchema.default({}),
  when: conditionSchema.optional(),
  cache: cacheSchema.optional(),
  environment: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/).optional(),
  steps: z.array(stepSchema).min(1).max(512),
  outputs: outputsSchema.default({}),
  reports: reportsSchema.default({}),
});

export const workflowSchema = z.strictObject({
  version: z.literal(1),
  name: identifierSchema,
  triggers: z.array(z.string().regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/)).min(1).max(32),
  source: z.union([z.literal('event.commit'), commitSchema]),
  defaults: z.strictObject({
    executor: executorSchema.optional(),
    toolchain: z.string().min(1).max(128).optional(),
    timeout: durationSchema.default('10m'),
    shell: shellSchema.default('sh'),
  }).default({ timeout: '10m', shell: 'sh' }),
  access: accessSchema.default({ repository: 'read', capabilities: [], secrets: [] }),
  concurrency: z.strictObject({
    group: z.enum(['pull_request', 'ref', 'workflow', 'environment']),
    supersede: z.enum(['cancel', 'queue']).default('queue'),
  }).optional(),
  modules: z.record(moduleReferenceSchema, digestSchema).default({}),
  jobs: z.record(identifierSchema, jobSchema).refine((jobs) => Object.keys(jobs).length > 0, 'At least one job is required.'),
});

export const moduleSchema = z.strictObject({
  version: z.literal(1),
  name: z.string().regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/),
  module_version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/),
  inputs: z.record(identifierSchema, z.strictObject({
    type: dataTypeSchema,
    required: z.boolean().default(true),
    default: z.json().optional(),
  })).default({}),
  outputs: outputsSchema.default({}),
  access: accessSchema.default({ repository: 'none', capabilities: [], secrets: [] }),
  steps: z.array(commandSchema).min(1).max(128),
});

export const toolchainSchema = z.strictObject({
  os: z.enum(['linux', 'darwin', 'win32']),
  arch: z.enum(['x64', 'arm64']),
  tools: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), z.string().min(1).max(256).refine((version) => !/[\r\n\x00]/.test(version) && !/^(?:latest|\*|[~^><=])/.test(version), 'Tool versions must be exact.')),
  image: z.string().regex(/^(?:sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/).optional(),
});

export type WorkflowDefinition = z.infer<typeof workflowSchema>;
export type WorkflowModule = z.infer<typeof moduleSchema>;
export type Access = z.infer<typeof accessSchema>;
export type Executor = z.infer<typeof executorSchema>;
export type Value = z.infer<typeof valueSchema>;
export type DataType = z.infer<typeof dataTypeSchema>;
export type OutputDefinition = z.infer<typeof outputSchema>;
export type ToolchainDescriptor = z.infer<typeof toolchainSchema>;
export type WorkflowCondition = z.infer<typeof conditionSchema>;
