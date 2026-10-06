import { readdir, mkdir, open, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { z } from 'zod';
import { MAX_TYPED_OUTPUT_WIRE_BYTES, compileWorkflow, fingerprintToolchain, logicalIdentifierSchema, moduleDigest, parseWorkflow, validateWorkflow, verifyManifest, WorkflowValidationError, type CompileContext, type RunManifest, type ToolchainDescriptor, type WorkflowDefinition, type WorkflowEvent, type WorkflowPolicy } from '../../workflows/src/index.ts';
import { RunnerError, atomicJson, createIsolation, decodeOutputWire, decodeUtf8, inspectToolchain, isolationPlatform, isFsError, parseIsolation, privateDirectory, readBounded, readJsonFile, readPinnedFile, resolveLocalRepository, runLocalWorkflow, stateDirectory, type LocalRunOptions, type SourceLocation, type StoredOutput } from '../../runner/src/index.ts';
import { assertOutsideRepository, within } from '../../runner/src/files.ts';
import { checkFlags, flag, has, identifier, parsePair, repeated, requiredFlag, type Arguments } from './args.ts';
import { API_FLAGS, sendApi } from './api.ts';
import { apiClient, repositoryId } from './config.ts';
import { print, write, type CliIO } from './io.ts';

const PLAN_FLAGS = ['repo', 'context', 'event', 'toolchains', 'modules', 'policy', 'commit', 'definition-revision', 'source', 'output', 'trust', 'producer', 'disposable'];
const RUN_FLAGS = [...PLAN_FLAGS, 'manifest', 'local', 'job', 'secret', 'secrets-file', 'vars', 'var', 'no-cache', 'isolation'];

async function workflowFile(value: string | undefined, cwd = process.cwd()): Promise<string> {
  const name = value ?? 'verify';
  if (/\.(?:yaml|yml)$/.test(name) || name.includes('/') || name.includes('\\')) return resolve(cwd, name);
  for (const extension of ['yaml', 'yml']) {
    const file = join(cwd, '.gitknot', 'workflows', `${name}.${extension}`);
    try { await readBounded(file, 1_048_576); return file; } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
  }
  throw new RunnerError('workflow_not_found', `Workflow ${name} was not found in .gitknot/workflows.`);
}

async function registry(args: Arguments, name: string): Promise<Record<string, unknown>> {
  const file = flag(args, name);
  if (!file) return {};
  const parsed = z.record(z.string(), z.unknown()).safeParse(await readJsonFile(resolve(file)));
  if (!parsed.success) throw new RunnerError('configuration_invalid', `--${name} must contain a JSON object.`);
  return parsed.data;
}

async function eventFile(args: Arguments, definition?: WorkflowDefinition): Promise<WorkflowEvent> {
  const path = flag(args, 'event');
  if (!path) return { type: 'workflow.dispatch', ...(definition?.concurrency?.group === 'pull_request' ? { pull_request_id: `local-${definition.name}` } : {}), ref: 'refs/heads/local' };
  const value = await readJsonFile(resolve(path));
  if (!value || typeof value !== 'object') throw new RunnerError('event_invalid', 'The event file must contain a JSON event object.');
  return value as WorkflowEvent;
}

function localPolicy(definition: WorkflowDefinition, commit: string, repoId: string, trust: 'trusted' | 'untrusted', disposable: boolean): WorkflowPolicy {
  const executors = Object.values(definition.jobs).map((job) => (job.executor ?? definition.defaults.executor)!);
  return {
    revision: 'local-1', allowed_workflow_revisions: [commit], access: definition.access,
    hosted_profiles: [...new Set(executors.filter((executor) => executor?.type === 'hosted').map((executor) => executor.profile))],
    self_hosted_pools: Object.fromEntries(executors.filter((executor) => executor?.type === 'self_hosted').map((executor) => [executor.pool, { trust, disposable, repository_ids: [repoId] }])),
    inapplicable_jobs: [],
  };
}

export async function planWorkflow(args: Arguments, signal: AbortSignal): Promise<RunManifest> {
  const path = await workflowFile(args.words[2]);
  const contextPath = flag(args, 'context');
  if (contextPath) {
    const context = await readJsonFile(resolve(contextPath)) as CompileContext;
    if (flag(args, 'event')) context.event = await eventFile(args);
    if (flag(args, 'toolchains')) context.toolchains = await registry(args, 'toolchains') as Record<string, ToolchainDescriptor>;
    if (flag(args, 'modules')) context.modules = await registry(args, 'modules');
    return compileWorkflow(decodeUtf8(await readBounded(path, 1_048_576)), context);
  }
  const source = await resolveLocalRepository(flag(args, 'source') ?? process.cwd(), flag(args, 'commit') ?? 'HEAD', signal);
  if (!within(source.root, path)) throw new RunnerError('definition_location', 'The workflow definition must be inside the pinned source repository.');
  const revision = flag(args, 'definition-revision') ? (await resolveLocalRepository(source.root, flag(args, 'definition-revision'), signal)).commit : source.commit;
  const yaml = await readPinnedFile(source.root, revision, relative(source.root, path).split('\\').join('/'), signal);
  const definition = parseWorkflow(yaml);
  const toolchains = await registry(args, 'toolchains') as Record<string, ToolchainDescriptor>;
  if (!Object.keys(toolchains).length) throw new RunnerError('toolchain_catalog_required', 'Supply --toolchains FILE with exact pinned descriptors. Use workflow toolchain inspect to inspect this host before choosing a lock.');
  const repoId = flag(args, 'repo') ?? process.env.GITKNOT_REPO ?? 'local';
  const level = flag(args, 'trust') ?? 'trusted';
  if (level !== 'trusted' && level !== 'untrusted') throw new RunnerError('usage', '--trust must be trusted or untrusted.');
  const policy = flag(args, 'policy') ? await readJsonFile(resolve(flag(args, 'policy')!)) as WorkflowPolicy : localPolicy(definition, revision, repoId, level, has(args, 'disposable'));
  return compileWorkflow(yaml, {
    repo_id: repoId, commit: source.commit, workflow_revision: revision,
    event: await eventFile(args, definition), trust: { level, fork: false, producer_id: flag(args, 'producer') ?? `local:${hostname()}` },
    policy, toolchains, modules: await registry(args, 'modules'),
  });
}

async function validateCommand(args: Arguments, io: CliIO): Promise<number> {
  checkFlags(args, ['modules', 'limits']);
  let paths: string[];
  if (args.words[2]) paths = [await workflowFile(args.words[2])];
  else {
    const directory = join(process.cwd(), '.gitknot', 'workflows');
    try { paths = (await readdir(directory)).filter((name) => /\.ya?ml$/.test(name)).sort().map((name) => join(directory, name)); }
    catch (error) { if (isFsError(error, 'ENOENT')) throw new RunnerError('workflow_not_found', 'No .gitknot/workflows directory exists.'); throw error; }
    if (!paths.length) throw new RunnerError('workflow_not_found', 'No workflow YAML files were found.');
  }
  const modules = await registry(args, 'modules');
  const limits = flag(args, 'limits') ? await readJsonFile(resolve(flag(args, 'limits')!)) as CompileContext['policy']['limits'] : undefined;
  const results = [];
  for (const path of paths) {
    const result = validateWorkflow(decodeUtf8(await readBounded(path, 1_048_576)), { modules, limits });
    results.push({ path, valid: result.valid, ...(result.definition ? { name: result.definition.name, jobs: Object.keys(result.definition.jobs).length } : {}), issues: result.issues });
  }
  const valid = results.every((result) => result.valid);
  await print(io, { valid, workflows: results }, has(args, 'json'));
  return valid ? 0 : 1;
}

async function localValues(args: Arguments): Promise<{ secrets: Record<string, string>; variables: Record<string, string> }> {
  const secrets: Record<string, string> = {};
  const file = flag(args, 'secrets-file');
  if (file) {
    await assertOutsideRepository(resolve(file));
    const parsed = z.record(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/), z.string()).safeParse(await readJsonFile(resolve(file), 4_194_304, true));
    if (!parsed.success) throw new RunnerError('secrets_invalid', 'Secret input must be a private JSON object of name-to-value strings.');
    Object.assign(secrets, parsed.data);
  }
  for (const value of repeated(args, 'secret')) {
    const [name, variable] = value.includes('=') ? parsePair(value) : [value, value];
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(variable)) throw new RunnerError('usage', '--secret accepts NAME or NAME=ENVIRONMENT_VARIABLE, not a secret value.');
    if (process.env[variable] !== undefined) secrets[name] = process.env[variable]!;
  }
  const variables: Record<string, string> = {};
  if (flag(args, 'vars')) {
    const parsed = z.record(z.string(), z.string()).safeParse(await readJsonFile(resolve(flag(args, 'vars')!)));
    if (!parsed.success) throw new RunnerError('variables_invalid', '--vars requires a JSON object of strings.');
    Object.assign(variables, parsed.data);
  }
  for (const value of repeated(args, 'var')) { const [name, content] = parsePair(value); variables[name] = content; }
  return { secrets, variables };
}

async function executeLocal(manifest: RunManifest, args: Arguments, io: CliIO, signal: AbortSignal, reproduction?: { source: SourceLocation; inputs: Record<string, StoredOutput>; variables?: Record<string, string>; completed_dependencies?: string[] }): Promise<number> {
  const isolation = parseIsolation(await readJsonFile(resolve(requiredFlag(args, 'isolation'))));
  const id = `local_${randomUUID()}`;
  const output = await privateDirectory(flag(args, 'output') ?? join(stateDirectory(), 'runs', id));
  const work = await privateDirectory(join(stateDirectory(), 'work', id));
  const local = await localValues(args);
  const source = flag(args, 'source') || !reproduction ? { url: (await resolveLocalRepository(flag(args, 'source') ?? process.cwd(), manifest.source.commit, signal)).root, commit: manifest.source.commit } : reproduction.source;
  const logFile = await open(join(output, 'logs.txt'), 'wx', 0o600);
  try {
    await atomicJson(join(output, 'manifest.json'), manifest);
    const options: LocalRunOptions = {
      source, work_root: work, output_directory: join(output, 'jobs'), signal, job: flag(args, 'job'),
      disposable: has(args, 'disposable'),
      isolation,
      allow_local_source: !reproduction || !!flag(args, 'source'),
      cache_directory: has(args, 'no-cache') ? undefined : join(stateDirectory(), 'local-caches'),
      secrets: local.secrets, variables: { ...reproduction?.variables, ...local.variables },
      inputs: reproduction?.inputs, completed_dependencies: reproduction?.completed_dependencies,
      onLog: async (bytes) => { await logFile.writeFile(bytes); await write(io.stderr, bytes); },
    };
    const result = await runLocalWorkflow(manifest, options);
    await logFile.sync();
    await atomicJson(join(output, 'result.json'), result);
    await print(io, { ...result, output_directory: output }, has(args, 'json'));
    return result.outcome === 'passed' ? 0 : 1;
  } finally { await logFile.close(); await rm(work, { recursive: true, force: true }); }
}

async function reproduce(args: Arguments, io: CliIO, signal: AbortSignal): Promise<number> {
  checkFlags(args, RUN_FLAGS);
  requiredFlag(args, 'isolation');
  if (flag(args, 'manifest')) {
    const manifest = await verifyManifest(await readJsonFile(resolve(flag(args, 'manifest')!), 16_777_216));
    return executeLocal(manifest, args, io, signal);
  }
  const runId = identifier(args.words[2], 'run ID');
  const jobId = requiredFlag(args, 'job');
  const client = await apiClient(args);
  const response = await client.request<Record<string, unknown>>('GET', `/v1/runs/${runId}/reproduce?job=${encodeURIComponent(jobId)}`, { signal });
  const manifest = await verifyManifest(response.data.manifest);
  const source = z.object({ url: z.string(), commit: z.string(), token: z.string().optional() }).strict().safeParse(response.data.source);
  if (!source.success || source.data.commit !== manifest.source.commit) throw new RunnerError('reproduction_invalid', 'GitKnot did not return the pinned reproduction source.');
  const selected = manifest.jobs.find((job) => job.id === jobId);
  if (!selected) throw new RunnerError('job_unknown', 'The requested job is not in the original manifest.');
  const inputSchema = z.array(z.object({ job_id: logicalIdentifierSchema, name: logicalIdentifierSchema, type: z.enum(['artifact', 'string', 'number', 'boolean', 'json']), digest: z.string(), size_bytes: z.number().int().nonnegative(), download_path: z.string() }).strict().refine(input => input.type === 'artifact' || input.size_bytes <= MAX_TYPED_OUTPUT_WIRE_BYTES));
  const listed = inputSchema.safeParse(response.data.inputs ?? []);
  if (!listed.success) throw new RunnerError('reproduction_invalid', 'GitKnot returned invalid reproduction inputs.');
  const staging = await privateDirectory(join(stateDirectory(), 'reproduction-inputs', randomUUID()));
  const inputs: Record<string, StoredOutput> = {};
  let total = 0;
  try {
    for (const input of listed.data) {
      const definition = manifest.jobs.find((job) => job.id === input.job_id)?.outputs[input.name];
      if (!selected.needs.includes(input.job_id) || !definition || definition.type !== input.type || !input.download_path.startsWith(`/v1/runs/${runId}/`)) throw new RunnerError('reproduction_invalid', 'A reproduction input is not a declared dependency of this job.');
      total += input.size_bytes;
      if (total > manifest.limits.max_input_bytes) throw new RunnerError('input_limit', 'Reproduction inputs exceed the manifest byte limit.');
      const path = join(staging, `${identifier(input.job_id, 'input job')}.${identifier(input.name, 'output name')}`);
      await client.download(input.download_path, path, input, { signal, max_bytes: manifest.limits.max_input_bytes });
      const value = input.type === 'artifact' ? undefined : decodeOutputWire(await readBounded(path, MAX_TYPED_OUTPUT_WIRE_BYTES), input.type);
      inputs[`jobs.${input.job_id}.${input.name}`] = { name: input.name, type: input.type, kind: input.type === 'artifact' ? 'artifact' : 'value', path, digest: input.digest, size_bytes: input.size_bytes, retention_seconds: definition.retention_seconds, media_type: input.type === 'artifact' ? 'application/vnd.gitknot.files+ndjson' : 'application/json', ...(input.type === 'artifact' ? {} : { value }) };
    }
    const completed = z.array(z.string()).safeParse(response.data.completed_dependencies ?? []);
    const variables = z.record(z.string(), z.string()).safeParse(response.data.variables ?? {});
    if (!completed.success || completed.data.some((id) => !selected.needs.includes(id)) || !variables.success) throw new RunnerError('reproduction_invalid', 'Reproduction dependency state or variables are invalid.');
    return await executeLocal(manifest, args, io, signal, { source: source.data, inputs, variables: variables.data, completed_dependencies: completed.data });
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function workflowCommand(args: Arguments, io: CliIO, signal: AbortSignal): Promise<number | null> {
  const command = args.words[1];
  if (command === 'validate') return validateCommand(args, io);
  if (command === 'module-digest') {
    checkFlags(args, []);
    if (!args.words[2]) throw new RunnerError('usage', 'Use workflow module-digest FILE.');
    await print(io, { digest: await moduleDigest(decodeUtf8(await readBounded(resolve(args.words[2]), 1_048_576))) }, has(args, 'json'));
    return 0;
  }
  if (command === 'toolchain' && args.words[2] === 'inspect') {
    checkFlags(args, ['tools', 'name', 'isolation']);
    const tools = (flag(args, 'tools') ?? 'node,npm,git').split(',');
    const home = await privateDirectory(join(stateDirectory(), 'toolchain-probes', randomUUID()));
    const configuration = flag(args, 'isolation') ? parseIsolation(await readJsonFile(resolve(flag(args, 'isolation')!))) : undefined;
    for (const name of ['source', 'home', 'inputs', 'control']) await mkdir(join(home, name), { mode: name === 'inputs' ? 0o755 : 0o700 });
    const isolation = configuration ? createIsolation(configuration, { workspace: join(home, 'source'), home: join(home, 'home'), inputs: join(home, 'inputs'), control: join(home, 'control'), directory: home, deadline_at: Date.now() + 120_000, grace_ms: 1_000 }) : undefined;
    try {
      await isolation?.prepare();
      const descriptor = await inspectToolchain(tools, { cwd: join(home, 'source'), home: join(home, 'home'), signal, ...(isolation ? { execute: isolation.run.bind(isolation), platform: await isolationPlatform(configuration!), environment: isolation.environment() } : {}) });
      const name = flag(args, 'name');
      await print(io, name ? { [name]: descriptor } : { descriptor, fingerprint: await fingerprintToolchain(descriptor) }, has(args, 'json'));
      return 0;
    } finally { await isolation?.stop(); await rm(home, { recursive: true, force: true }); }
  }
  if (command === 'plan') {
    checkFlags(args, PLAN_FLAGS);
    const manifest = await planWorkflow(args, signal);
    if (flag(args, 'output')) await atomicJson(resolve(flag(args, 'output')!), manifest);
    await print(io, manifest, has(args, 'json'));
    return manifest.jobs.some((job) => job.condition.outcome === 'blocked') ? 1 : 0;
  }
  if (command === 'run') {
    if (!has(args, 'local')) {
      checkFlags(args, [...API_FLAGS, 'repo', 'commit', 'ref', 'event']);
      const name = identifier(args.words[2], 'workflow ID or name');
      const repoId = identifier(await repositoryId(args, flag(args, 'repo') ?? process.env.GITKNOT_REPO), 'repository ID (--repo)');
      const event = flag(args, 'event') ? await eventFile(args) : undefined;
      return sendApi(args, io, signal, { method: 'POST', path: `/v1/repos/${repoId}/runs`, fields: { commit: 'commit', ref: 'ref' }, body: { workflow_id: decodeURIComponent(name), event: event ?? { type: 'workflow.manual' } } });
    }
    checkFlags(args, RUN_FLAGS);
    requiredFlag(args, 'isolation');
    const manifest = flag(args, 'manifest') ? await verifyManifest(await readJsonFile(resolve(flag(args, 'manifest')!), 16_777_216)) : await planWorkflow(args, signal);
    return executeLocal(manifest, args, io, signal);
  }
  if (command === 'reproduce') return reproduce(args, io, signal);
  return null;
}
