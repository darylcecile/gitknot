import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { digestJson, type CompiledJob, type WorkflowLimits } from '../../workflows/src/index.ts';
import { createArchive, fileDigest, restoreArchive } from './archive.ts';
import { RunnerError } from './errors.ts';
import { atomicJson, isFsError, readJsonFile, safeWorkspacePath } from './files.ts';
import { captureProcess, cleanEnvironment } from './process.ts';

interface CacheOptions {
  job: CompiledJob;
  workspace: string;
  directory: string;
  private_directory: string;
  limits: WorkflowLimits;
  signal?: AbortSignal;
  secrets: string[];
  configuration_digest?: string | null;
  input_digests?: Record<string, string>;
  variables?: Record<string, string>;
}

export async function cacheIdentity(options: CacheOptions): Promise<string | null> {
  if (!options.job.cache) return null;
  const files: Record<string, string> = {};
  for (const path of options.job.cache.key_files) {
    try {
      const source = await safeWorkspacePath(options.workspace, path);
      files[path] = (await fileDigest(source, options.limits.max_input_bytes, options.signal)).digest;
    } catch (error) {
      if (isFsError(error, 'ENOENT')) return null;
      throw error;
    }
  }
  const effectiveConfig = { env: options.job.env, steps: options.job.steps, access: options.job.access, executor: options.job.executor, environment: options.job.environment, toolchain: options.job.toolchain, timeout_ms: options.job.timeout_ms };
  return digestJson({ namespace: options.job.cache.namespace, job_id: options.job.id, effective_config_digest: await digestJson(effectiveConfig), files, producer: options.job.producer_id, configuration: options.configuration_digest ?? null, inputs: options.input_digests ?? {}, variables: options.variables ?? {} });
}

export async function validateCachePaths(options: CacheOptions): Promise<void> {
  if (!options.job.cache) return;
  for (const path of options.job.cache!.paths) {
    const result = await captureProcess('git', ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${join(options.private_directory, 'empty-hooks')}`, 'ls-files', '-z', '--', path], { cwd: options.workspace, env: cleanEnvironment(options.private_directory), timeout_ms: 10_000, signal: options.signal });
    if (result.exit_code !== 0) throw new RunnerError('cache_invalid', 'Unable to verify cache paths against the pinned source tree.');
    if (result.output.length) throw new RunnerError('cache_source_collision', 'Dependency caches cannot overlay tracked source files.');
    await safeWorkspacePath(options.workspace, path, true);
  }
}

export async function restoreCache(options: CacheOptions, key: string | null): Promise<boolean> {
  if (!key || !options.job.cache) return false;
  await validateCachePaths(options);
  const base = join(options.directory, key.slice(7));
  let metadata: { digest: string; size_bytes: number };
  try { metadata = await readJsonFile(`${base}.json`, 4096, true) as typeof metadata; }
  catch (error) {
    if (isFsError(error, 'ENOENT')) return false;
    if (error instanceof RunnerError && error.code === 'json_invalid') return false;
    throw error;
  }
  if (!metadata || !/^sha256:[a-f0-9]{64}$/.test(metadata.digest) || !Number.isSafeInteger(metadata.size_bytes) || metadata.size_bytes < 0 || metadata.size_bytes > options.limits.max_cache_bytes) return false;
  const staging = join(options.private_directory, 'cache-restore');
  try {
    await restoreArchive(`${base}.ndjson`, staging, metadata, { max_bytes: options.limits.max_cache_bytes, max_files: options.limits.max_output_files, signal: options.signal }, options.job.cache.paths);
    for (const path of options.job.cache.paths) {
      const source = await safeWorkspacePath(staging, path, true);
      const target = await safeWorkspacePath(options.workspace, path, true);
      await rm(target, { recursive: true, force: true });
      await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
      try { await rename(source, target); }
      catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
    }
    return true;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof RunnerError && ['input_checksum', 'archive_invalid', 'input_limit', 'cache_scope'].includes(error.code) || isFsError(error, 'ENOENT')) {
      for (const path of options.job.cache.paths) await rm(await safeWorkspacePath(options.workspace, path, true), { recursive: true, force: true });
      await Promise.all([rm(`${base}.json`, { force: true }), rm(`${base}.ndjson`, { force: true })]);
      return false;
    }
    throw error;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export async function saveCache(options: CacheOptions, key: string | null): Promise<void> {
  if (!key || !options.job.cache || options.job.cache.mode === 'read') return;
  // The immutable source index was checked BEFORE repository code ran. Never execute Git against job-modified .git metadata here.
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const paths: string[] = [];
  for (const path of options.job.cache.paths) {
    try { await safeWorkspacePath(options.workspace, path); paths.push(path); }
    catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
  }
  if (!paths.length) return;
  const base = join(options.directory, key.slice(7));
  const metadata = await createArchive(options.workspace, paths, `${base}.ndjson`, { max_bytes: options.limits.max_cache_bytes, max_files: options.limits.max_output_files, signal: options.signal, secrets: options.secrets });
  await atomicJson(`${base}.json`, metadata);
}
