import { ArtifactsStore } from '../../../packages/git/src/artifacts.ts';
import type { GitBindings } from './types.ts';
import type { GitRemote, GitStorageCreationEvidence, GitStorageProvisionOptions } from '../../../packages/git/src/types.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';
import { LocalGitStore } from '../../../infra/local/git-store.ts';
import { admitGitControlOperation } from './native.ts';

interface GitStore {
  provision(name: string, defaultBranch: string, options?: GitStorageProvisionOptions): Promise<GitStorageCreationEvidence | undefined>;
  observeCreation(name: string): Promise<GitStorageCreationEvidence | null>;
  remote(name: string): Promise<string>;
  access(name: string, scope: 'read' | 'write', ttl?: number): Promise<GitRemote>;
  delete(name: string): Promise<void>;
}
const stores = new WeakMap<object, GitStore>();

export function artifacts(env: GitBindings): GitStore {
  let store = stores.get(env);
  if (!store) {
    if (env.GIT_STORAGE_MODE === 'local') {
      requireValue(env.ENVIRONMENT === 'development', 'local_authority_disabled', 'Local Git storage requires explicit development mode.', 503);
      store = new LocalGitStore(env.INTERNAL_SERVICE_KEY, env.ENVIRONMENT);
    } else store = new ArtifactsStore({ account_id: env.ARTIFACTS_ACCOUNT_ID, namespace: env.ARTIFACTS_NAMESPACE,
      transport: env.ARTIFACTS_TRANSPORT ?? 'binding', binding: env.ARTIFACTS, rest_token: env.ARTIFACTS_API_TOKEN,
      before_operation: (name, count) => admitGitControlOperation(env, name, count) });
    stores.set(env, store);
  }
  return store;
}
