import { GitError, requireValue } from './errors.ts';
import type { GitRemote, GitStorageCreationEvidence, GitStorageProvisionOptions } from './types.ts';
import { boundedJson } from './protocol.ts';
import { creationEvidence, validateOwnershipMarker } from './storage-proof.ts';

/** Narrow Oct 1, 2026 binding surface, deliberately independent of first-parent log(). */
export interface ArtifactsRepositoryCapability extends Disposable {
  info(): Promise<{ id: string; name: string; remote: string; description: string | null }>;
  createToken(scope: 'read' | 'write', ttl: number): Promise<{ plaintext: string; expiresAt: string | number }>;
  revokeToken(tokenOrId: string): Promise<boolean>;
}

export interface ArtifactsNamespaceBinding {
  get(name: string): Promise<ArtifactsRepositoryCapability>;
  create(name: string, options: { readOnly: boolean; setDefaultBranch: string; description?: string }): Promise<{
    id: string; name: string; remote: string; description: string | null; defaultBranch: string; token: string;
  }>;
  delete(name: string): Promise<boolean>;
}

export interface ArtifactsConfiguration {
  account_id: string;
  namespace: string;
  binding?: ArtifactsNamespaceBinding;
  rest_token?: string;
  transport: 'binding' | 'rest';
  before_operation?: (name: string, count: number) => Promise<void>;
}

interface RestEnvelope<T> { success: boolean; result: T | null; errors: Array<{ code: number; message: string }> }
interface CachedRead { remote: GitRemote; expires: number }
interface ProviderCreation { id: string; name: string; description: string | null; remote: string; token: string }

export class ArtifactsStore {
  private readonly config: ArtifactsConfiguration;
  private readonly reads = new Map<string, CachedRead>();

  constructor(config: ArtifactsConfiguration) {
    this.config = config;
    requireValue(/^[a-f0-9]{32}$/u.test(config.account_id) && /^[a-zA-Z0-9_-]+$/u.test(config.namespace),
      'storage_configuration', 'Git storage placement is not configured.', 503);
    requireValue(config.transport === 'binding' ? config.binding : config.rest_token,
      'storage_configuration', 'The selected Git storage adapter is unavailable.', 503);
  }

  async provision(name: string, defaultBranch: string, options: GitStorageProvisionOptions = {}): Promise<GitStorageCreationEvidence | undefined> {
    this.name(name);
    if (options.ownership_marker !== undefined) {
      requireValue(options.create_only === true, 'storage_creation_marker', 'Ownership metadata can only accompany an exclusive create.', 503);
      validateOwnershipMarker(options.ownership_marker);
    }
    // The catalog assigns a stable opaque name. Retries inspect that exact resource.
    if (!options.create_only) {
      try {
        await this.remote(name);
        return;
      } catch (error) {
        if (!(error instanceof GitError) || error.status !== 404) throw error;
      }
    }
    const created = await this.create(name, defaultBranch, options.ownership_marker);
    requireValue(created.name === name, 'storage_creation_unverified', 'The provider created a different namespace.', 503);
    this.validateRemote(created.remote, name);
    if (options.ownership_marker !== undefined) requireValue(created.description === options.ownership_marker,
      'storage_creation_unverified', 'The provider did not confirm the original creation marker.', 503);
    await this.revoke(name, created.token);
    if (options.ownership_marker === undefined) return;
    const observed = await this.observeCreation(name);
    requireValue(observed?.provider_id === created.id && observed.marker === options.ownership_marker,
      'storage_creation_unverified', 'Fresh provider metadata does not confirm this exact repository creation.', 503);
    return observed;
  }

  private async create(name: string, defaultBranch: string, marker?: string): Promise<ProviderCreation> {
    if (this.config.transport === 'rest') return this.rest<ProviderCreation>('/repos', 'POST', {
      name, default_branch: defaultBranch, read_only: false, ...(marker === undefined ? {} : { description: marker }),
    }, name);
    await this.config.before_operation?.(name, 1);
    try {
      return await this.config.binding!.create(name, { readOnly: false, setDefaultBranch: defaultBranch, ...(marker === undefined ? {} : { description: marker }) });
    } catch (cause) {
      const code = (cause as { code?: unknown } | null)?.code;
      if (code === 'ALREADY_EXISTS' || code === 10201 || cause instanceof Error && /^ALREADY_EXISTS\b/u.test(cause.message)) throw this.createConflict();
      throw new GitError('storage_provision_failed', 'Repository storage could not be created. Retry this operation.', 503, { cause });
    }
  }

  /** Always a fresh metadata read; never write an ownership marker into an existing repo. */
  async observeCreation(name: string): Promise<GitStorageCreationEvidence | null> {
    this.name(name);
    try {
      const info = this.config.transport === 'rest'
        ? await this.rest<Pick<ProviderCreation, 'id' | 'name' | 'description' | 'remote'>>(`/repos/${encodeURIComponent(name)}`, 'GET', undefined, name)
        : await this.withRepository(name, repo => repo.info());
      this.validateRemote(info.remote, name);
      if (!info.description) return null;
      return creationEvidence({ version: 1, provider: 'artifacts', storage_name: info.name, provider_id: info.id, marker: info.description }, name, 'artifacts');
    } catch (error) { if (error instanceof GitError && error.status === 404) return null; throw error; }
  }

  async remote(name: string): Promise<string> {
    this.name(name);
    if (this.config.transport === 'rest') {
      const info = await this.rest<{ remote: string }>(`/repos/${encodeURIComponent(name)}`, 'GET', undefined, name);
      return this.validateRemote(info.remote, name);
    }
    return this.withRepository(name, async repo => this.validateRemote((await repo.info()).remote, name));
  }

  async access(name: string, scope: 'read' | 'write', ttl = 300): Promise<GitRemote> {
    this.name(name);
    const cached = scope === 'read' ? this.reads.get(name) : undefined;
    if (cached && cached.expires > Date.now() + 30_000) return cached.remote;
    const lifetime = Math.max(60, Math.min(3600, ttl));
    const url = await this.remote(name);
    let plaintext: string;
    if (this.config.transport === 'rest') {
      plaintext = (await this.rest<{ plaintext: string }>('/tokens', 'POST', { repo: name, scope, ttl: lifetime }, name)).plaintext;
    } else {
      plaintext = await this.withRepository(name, async repo => (await repo.createToken(scope, lifetime)).plaintext);
    }
    requireValue(/^art_v1_[a-f0-9]{40}\?expires=\d+$/u.test(plaintext), 'storage_token_invalid', 'Git storage returned an invalid access token.', 503);
    const remote: GitRemote = { url, authorization: `Bearer ${plaintext}`, authority: 'artifacts' };
    if (scope === 'read') {
      if (this.reads.size >= 256) this.reads.delete(this.reads.keys().next().value!);
      const expires = Number(plaintext.split('?expires=')[1]) * 1000;
      this.reads.set(name, { remote, expires: Math.min(expires, Date.now() + lifetime * 1000) });
    }
    return remote;
  }

  async revoke(name: string, tokenOrId: string): Promise<void> {
    if (this.config.transport === 'binding') {
      await this.withRepository(name, async repo => {
        requireValue(await repo.revokeToken(tokenOrId), 'storage_revoke_failed', 'Git storage access revocation is incomplete.', 503);
      });
    } else {
      let id = tokenOrId;
      if (tokenOrId.startsWith('art_v1_')) {
        // On a newly created, not-yet-ready repository the initial token is the only
        // active token. Token-ID derivation from plaintext is not a documented API.
        const created = await this.rest<Array<{ id: string }>>(`/repos/${encodeURIComponent(name)}/tokens?state=active&per_page=100&page=1`, 'GET', undefined, name);
        requireValue(created.length === 1, 'storage_revoke_failed', 'The initial Git storage token could not be identified for revocation.', 503);
        id = created[0].id;
      }
      await this.rest(`/tokens/${encodeURIComponent(id)}`, 'DELETE', undefined, name);
    }
    this.reads.delete(name);
  }

  async delete(name: string): Promise<void> {
    this.name(name);
    if (this.config.transport === 'binding') {
      await this.config.before_operation?.(name, 1);
      requireValue(await this.config.binding!.delete(name), 'storage_delete_failed', 'Git storage deletion is incomplete.', 503);
    } else await this.rest(`/repos/${encodeURIComponent(name)}`, 'DELETE', undefined, name);
    this.reads.delete(name);
  }

  private async withRepository<T>(name: string, run: (repo: ArtifactsRepositoryCapability) => Promise<T>): Promise<T> {
    await this.config.before_operation?.(name, 3);
    let repo: ArtifactsRepositoryCapability | undefined;
    try {
      repo = await this.config.binding!.get(name);
      return await run(repo);
    } catch (cause) {
      if (cause instanceof GitError) throw cause;
      const code = (cause as { code?: unknown }).code;
      const notFound = code === 'NOT_FOUND' || code === 10200 || (cause as { status?: unknown }).status === 404
        || cause instanceof Error && /^NOT_FOUND\b/u.test(cause.message);
      throw new GitError(notFound ? 'storage_not_found' : 'storage_unavailable',
        notFound ? 'Repository storage is not ready.' : 'Git storage is temporarily unavailable.', notFound ? 404 : 503, { cause });
    } finally { repo?.[Symbol.dispose](); }
  }

  private async rest<T>(path: string, method = 'GET', body?: unknown, name?: string): Promise<T> {
    if (name) await this.config.before_operation?.(name, 1);
    const base = `https://api.cloudflare.com/client/v4/accounts/${this.config.account_id}/artifacts/namespaces/${this.config.namespace}`;
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        method, headers: { authorization: `Bearer ${this.config.rest_token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
    } catch (cause) { throw new GitError('storage_unavailable', 'Git storage is temporarily unavailable.', 503, { cause }); }
    if (response.status === 404) throw new GitError('storage_not_found', 'Repository storage is not ready.', 404);
    let envelope: RestEnvelope<T>;
    try { envelope = await boundedJson<RestEnvelope<T>>(response); }
    catch { throw new GitError('storage_unavailable', 'Git storage returned an invalid response.', 503); }
    if (path === '/repos' && method === 'POST' && envelope.success === false && Array.isArray(envelope.errors)
      && envelope.errors.some(error => error.code === 10201)) throw this.createConflict();
    requireValue(response.ok && envelope.success && envelope.result !== null, 'storage_unavailable', 'Git storage could not complete this operation.', 503);
    return envelope.result;
  }

  private createConflict(): GitError {
    return new GitError('storage_namespace_exists', 'The provider namespace already exists; this creation did not start.', 409, { cause: { proof: 'not_started' } });
  }

  private validateRemote(remote: string, name: string): string {
    let url: URL;
    try { url = new URL(remote); } catch { throw new GitError('storage_remote_invalid', 'Git storage returned an invalid remote.', 503); }
    requireValue(url.protocol === 'https:' && url.host === `${this.config.account_id}.artifacts.cloudflare.net`
      && url.pathname === `/git/${this.config.namespace}/${name}.git` && !url.username && !url.password && !url.search && !url.hash,
    'storage_remote_invalid', 'Git storage returned an unexpected repository remote.', 503);
    return url.href;
  }

  private name(name: string): void {
    requireValue(/^[a-zA-Z0-9_-]{1,128}$/u.test(name), 'storage_name_invalid', 'Invalid repository storage identity.', 503);
  }
}
