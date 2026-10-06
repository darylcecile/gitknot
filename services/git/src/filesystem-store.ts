import { randomUUID } from 'node:crypto';
import { mkdir, open, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GitError } from '../../../packages/git/src/errors.ts';
import { validateRef } from '../../../packages/git/src/policy.ts';
import { DEFAULT_GIT_LIMITS } from '../../../packages/git/src/types.ts';
import type { GitStorageCreationEvidence, GitStorageProvisionOptions } from '../../../packages/git/src/types.ts';
import { creationEvidence, validateOwnershipMarker } from '../../../packages/git/src/storage-proof.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';
import { NativeGit } from './process.ts';

/** Explicit local authority. A failed initialization retains its original claim. */
export async function provisionFilesystemRepository(directory: string, defaultBranch: string,
  options: GitStorageProvisionOptions = {}): Promise<{ remote: string; created?: true; creation?: GitStorageCreationEvidence }> {
  validateRef(`refs/heads/${defaultBranch}`);
  if (options.ownership_marker !== undefined) {
    requireValue(options.create_only === true, 'storage_creation_marker', 'Ownership metadata can only accompany an exclusive create.', 503);
    validateOwnershipMarker(options.ownership_marker);
  }
  if (options.create_only) {
    try { await mkdir(directory, { recursive: false, mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new GitError('storage_namespace_exists', 'The local namespace already exists; this creation did not start.', 409,
        { cause: { proof: 'not_started' } });
    }
  }
  const git = new NativeGit(dirname(directory), DEFAULT_GIT_LIMITS, Date.now() + 30_000, true);
  await git.run(['init', '--bare', '--template=', `--initial-branch=${defaultBranch}`, directory]);
  await stat(join(directory, 'HEAD'));
  const proof: GitStorageCreationEvidence | undefined = options.ownership_marker === undefined ? undefined : {
    version: 1, provider: 'local', storage_name: basename(directory, '.git'), provider_id: randomUUID(), marker: options.ownership_marker,
  };
  if (proof) {
    // Only this request won mkdir. Never create or replace an owner record during
    // an observation/retry, or inside an already-existing foreign namespace.
    const file = await open(join(directory, 'gitknot-creation.json'), 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(proof)); await file.sync(); }
    finally { await file.close(); }
    await syncDirectory(directory);
    await syncDirectory(dirname(directory));
  }
  return { remote: pathToFileURL(directory).href, ...(options.create_only ? { created: true as const } : {}), ...(proof ? { creation: proof } : {}) };
}

export async function readFilesystemCreation(directory: string): Promise<GitStorageCreationEvidence | null> {
  let file;
  try { file = await open(join(directory, 'gitknot-creation.json'), 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const info = await file.stat();
    requireValue(info.isFile() && info.size <= 4096, 'storage_creation_unverified', 'The original filesystem creation receipt is unavailable.', 503);
    const proof = creationEvidence(JSON.parse(await file.readFile('utf8')), basename(directory, '.git'), 'local');
    // A read racing the final create response must not acknowledge a receipt
    // whose file or directory entry has not reached the durable filesystem.
    await file.sync();
    await syncDirectory(directory);
    await syncDirectory(dirname(directory));
    return proof;
  } finally { await file.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
