import { z } from 'zod';
import { canonicalJson, deepFreeze, digestJson } from './canonical.ts';
import { fingerprintToolchain, trustIdentitySchema, workflowEventSchema } from './compiler.ts';
import { invalid, WorkflowValidationError } from './errors.ts';
import { accessSchema, commitSchema, dataTypeSchema, digestSchema, envSchema, executorSchema, identifierSchema, relativePathSchema, shellSchema, toolchainSchema } from './schema.ts';
import { isReference, resolveLimits, topologicalOrder } from './validation.ts';
import type { RunManifest, Value } from './types.ts';

const output = z.strictObject({
  type: dataTypeSchema, path: relativePathSchema, retention_seconds: z.number().int().min(1).max(7_776_000), required: z.boolean(),
});
const command = z.strictObject({
  run: z.string().min(1).max(65_536), shell: shellSchema, working_directory: relativePathSchema, env: envSchema, timeout_ms: z.number().int().positive(),
});
const step = z.strictObject({
  id: identifierSchema,
  module: z.strictObject({ reference: z.string().max(256), digest: digestSchema }).nullable(),
  commands: z.array(command).min(1).max(512), env: envSchema,
  outputs: z.record(identifierSchema, output), timeout_ms: z.number().int().positive(),
});
const job = z.strictObject({
  id: identifierSchema, producer_id: z.string().min(1).max(256), needs: z.array(identifierSchema).max(512), executor: executorSchema,
  toolchain: toolchainSchema.extend({ name: z.string().min(1).max(128), fingerprint: digestSchema }),
  timeout_ms: z.number().int().positive(), access: accessSchema, env: envSchema,
  condition: z.strictObject({ outcome: z.enum(['run', 'not_applicable', 'blocked']), reason: z.string().max(4096) }),
  steps: z.array(step).min(1).max(512), outputs: z.record(identifierSchema, output),
  reports: z.record(identifierSchema, z.strictObject({ path: relativePathSchema, format: z.enum(['junit', 'sarif', 'json']), required: z.boolean(), retention_seconds: z.number().int().min(1).max(7_776_000) })),
  cache: z.strictObject({ paths: z.array(relativePathSchema).min(1).max(32), key_files: z.array(relativePathSchema).min(1).max(64), mode: z.enum(['read', 'read_write']), namespace: digestSchema }).nullable(),
  environment: z.strictObject({ name: z.string().min(1).max(128), approval_required: z.boolean() }).nullable(),
});

export const manifestSchema = z.strictObject({
  version: z.literal(1), compiler_version: z.literal('1.0.0'), repo_id: z.string().min(1).max(256),
  source: z.strictObject({ commit: commitSchema, workflow_revision: commitSchema }),
  workflow: z.strictObject({ name: identifierSchema, definition_digest: digestSchema }),
  policy: z.strictObject({ revision: z.string().min(1).max(256), digest: digestSchema }),
  configuration: z.strictObject({ selection_id: z.string().min(1).max(256).nullable(), selection_digest: digestSchema.nullable() }),
  trust: trustIdentitySchema, event: workflowEventSchema, modules: z.record(z.string().max(256), digestSchema),
  jobs: z.array(job).min(1).max(512), order: z.array(identifierSchema).min(1).max(512),
  concurrency: z.strictObject({ group: z.string().min(1).max(4096), supersede: z.enum(['cancel', 'queue']) }).nullable(),
  limits: z.strictObject({
    max_jobs: z.number(), max_fanout: z.number(), max_steps: z.number(), max_timeout_ms: z.number(),
    max_log_bytes: z.number(), max_output_bytes: z.number(), max_output_files: z.number(), max_input_bytes: z.number(), max_cache_bytes: z.number(), max_chunk_bytes: z.number(),
  }),
  digest: digestSchema,
});

/** Validate bytes read from disk/network, then verify every digest and graph invariant. */
export async function verifyManifest(value: unknown): Promise<RunManifest> {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw new WorkflowValidationError(parsed.error.issues.map((issue) => ({ code: 'manifest_invalid', path: issue.path.join('.'), message: issue.message })));
  const manifest = parsed.data;
  // A parser must not silently supply defaults missing from the signed representation.
  if (canonicalJson(value) !== canonicalJson(manifest)) invalid('manifest_invalid', '', 'The manifest is not a complete canonical compiled plan.');
  const { digest, ...unsigned } = manifest;
  if (await digestJson(unsigned) !== digest) invalid('manifest_digest_mismatch', 'digest', 'The manifest has changed since compilation.');
  const limits = resolveLimits(manifest.limits);
  if ((manifest.configuration.selection_id === null) !== (manifest.configuration.selection_digest === null)) invalid('manifest_invalid', 'configuration', 'Configuration selection identity and digest must be bound together.');
  const jobs = Object.fromEntries(manifest.jobs.map((entry) => [entry.id, entry]));
  if (Object.keys(jobs).length !== manifest.jobs.length) invalid('manifest_invalid', 'jobs', 'Duplicate job IDs.');
  const order = topologicalOrder(jobs, limits);
  if (canonicalJson(order) !== canonicalJson(manifest.order) || canonicalJson(order) !== canonicalJson(manifest.jobs.map((entry) => entry.id))) invalid('manifest_invalid', 'order', 'The manifest must contain the canonical topological order.');
  for (const entry of manifest.jobs) {
    const { name: _name, fingerprint, ...descriptor } = entry.toolchain;
    if (await fingerprintToolchain(descriptor) !== fingerprint) invalid('toolchain_digest_mismatch', `jobs.${entry.id}.toolchain`, 'The toolchain fingerprint is invalid.');
    if (entry.timeout_ms > limits.max_timeout_ms || entry.steps.reduce((count, item) => count + item.commands.length, 0) > limits.max_steps) invalid('manifest_limit', `jobs.${entry.id}`, 'The job exceeds manifest limits.');
    if (new Set(entry.steps.map((item) => item.id)).size !== entry.steps.length) invalid('manifest_invalid', `jobs.${entry.id}.steps`, 'Duplicate step IDs.');
    const seenOutputs: Record<string, Record<string, unknown>> = {};
    const checkReferences = (environment: Record<string, Value>) => {
      for (const value of Object.values(environment)) {
        if (!isReference(value)) continue;
        if ('input' in value) invalid('manifest_invalid', `jobs.${entry.id}`, 'Unresolved module input.');
        if ('secret' in value && !entry.access.secrets.includes(value.secret)) invalid('manifest_invalid', `jobs.${entry.id}`, 'Undeclared secret reference.');
        if ('output' in value) {
          const [scope, producer, name] = value.output.split('.') as [string, string, string];
          const output = scope === 'jobs' && entry.needs.includes(producer) ? jobs[producer]?.outputs[name] : scope === 'steps' ? seenOutputs[producer]?.[name] : undefined;
          if (!output) invalid('manifest_invalid', `jobs.${entry.id}`, 'Unknown, out-of-scope, or forward output reference.');
        }
      }
    };
    checkReferences(entry.env);
    for (const item of entry.steps) {
      if (item.timeout_ms > entry.timeout_ms || item.commands.some((itemCommand) => itemCommand.timeout_ms > item.timeout_ms)) invalid('manifest_limit', `jobs.${entry.id}.steps`, 'A command or step exceeds its enclosing timeout.');
      if (item.module && manifest.modules[item.module.reference] !== item.module.digest) invalid('module_digest_mismatch', `jobs.${entry.id}.steps`, 'A command group has an unrecognized module digest.');
      checkReferences(item.env);
      for (const itemCommand of item.commands) checkReferences(itemCommand.env);
      seenOutputs[item.id] = item.outputs;
    }
    if (manifest.trust.level === 'untrusted' && (entry.access.repository === 'write' || entry.access.secrets.length || entry.access.capabilities.length || entry.environment)) invalid('manifest_invalid', `jobs.${entry.id}.access`, 'Untrusted source has privileged access.');
  }
  return deepFreeze(manifest) as RunManifest;
}

/** Trusted server adapters can select versions after graph expansion, before admission. */
export async function bindManifestConfiguration(input: RunManifest, selection: { selection_id: string; selection_digest: string }): Promise<RunManifest> {
  const original = await verifyManifest(input);
  if (original.configuration.selection_id !== null && canonicalJson(original.configuration) !== canonicalJson(selection)) invalid('configuration_already_bound', 'configuration', 'A bound selection cannot be replaced on an existing manifest.');
  const parsed = z.strictObject({ selection_id: z.string().min(1).max(256), selection_digest: digestSchema }).safeParse(selection);
  if (!parsed.success) invalid('configuration_invalid', 'configuration', 'Configuration selection requires a stable identity and digest.');
  const { digest: _digest, ...unsigned } = original;
  const next = { ...unsigned, configuration: parsed.data };
  return verifyManifest({ ...next, digest: await digestJson(next) });
}
