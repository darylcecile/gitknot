import { signInternalRequest } from '../../packages/core/src/internal.ts';
import { GitError } from '../../packages/git/src/errors.ts';
import type { GitRemote, GitStorageCreationEvidence, GitStorageProvisionOptions } from '../../packages/git/src/types.ts';
import { creationEvidence, validateOwnershipMarker } from '../../packages/git/src/storage-proof.ts';

/** Explicit development authority, backed by real bare Git repositories. */
export class LocalGitStore {
  readonly key: string;

  constructor(key: string, mode: string) {
    if (mode !== 'development' || key.length < 32) throw new Error('Local Git storage requires explicit development mode and an internal key.');
    this.key = key;
  }

  private async call(name: string, method = 'GET', body?: { default_branch: string } & GitStorageProvisionOptions): Promise<{ remote: string; creation?: GitStorageCreationEvidence }> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) throw new GitError('storage_name_invalid', 'Invalid local storage name.', 503);
    const path = `/repositories/${name}`;
    const request = new Request(`http://git-local.internal${path}`, {
      method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const signed = await signInternalRequest(request, this.key, 'git-local-storage');
    const response = await fetch(new Request(`http://127.0.0.1:8792${path}`, signed), { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      if (method === 'PUT' && body?.create_only === true && response.status === 409) {
        const rejection = await response.json().catch(() => null) as { error?: { code?: unknown; proof?: unknown } } | null;
        if (rejection?.error?.code === 'storage_namespace_exists' && rejection.error.proof === 'not_started') {
          throw new GitError('storage_namespace_exists', 'The local repository namespace already exists; creation did not start.', 409, { cause: { proof: 'not_started' } });
        }
      } else await response.body?.cancel();
      throw new GitError(response.status === 404 ? 'storage_not_found' : 'storage_unavailable', 'Local Git storage is unavailable.', response.status);
    }
    const value = await response.json() as { remote?: unknown; created?: unknown; creation?: unknown };
    if (typeof value.remote !== 'string' || !value.remote.startsWith('file://')) throw new Error('Local authority returned an invalid repository path.');
    if (method === 'PUT' && body?.create_only === true && value.created !== true) {
      throw new GitError('storage_create_unconfirmed', 'The local provider did not confirm this exclusive namespace creation.', 503);
    }
    const proof = value.creation === undefined || value.creation === null ? undefined : creationEvidence(value.creation, name, 'local');
    if (body?.ownership_marker !== undefined && proof?.marker !== body.ownership_marker) {
      throw new GitError('storage_creation_unverified', 'The local provider did not confirm the original creation marker.', 503);
    }
    return { remote: value.remote, ...(proof ? { creation: proof } : {}) };
  }

  async provision(name: string, defaultBranch: string, options: GitStorageProvisionOptions = {}): Promise<GitStorageCreationEvidence | undefined> {
    if (options.ownership_marker !== undefined) validateOwnershipMarker(options.ownership_marker);
    const result = await this.call(name, 'PUT', { default_branch: defaultBranch, ...options });
    return result.creation;
  }
  async observeCreation(name: string): Promise<GitStorageCreationEvidence | null> {
    try { return (await this.call(name)).creation ?? null; }
    catch (error) { if (error instanceof GitError && error.status === 404) return null; throw error; }
  }
  async remote(name: string): Promise<string> { return (await this.call(name)).remote; }
  async access(name: string, _scope: 'read' | 'write', _ttl?: number): Promise<GitRemote> { return { authority: 'local', url: await this.remote(name) }; }
  async revoke(name: string, _token: string): Promise<void> { await this.call(name); }
  async delete(name: string): Promise<void> { await this.call(name, 'DELETE'); }
}
