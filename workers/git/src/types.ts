import type { Bindings } from '@gitknot/core';
import type { ArtifactsNamespaceBinding } from '../../../packages/git/src/artifacts.ts';

export interface GitBindings extends Bindings {
  ARTIFACTS?: ArtifactsNamespaceBinding;
  ARTIFACTS_ACCOUNT_ID: string;
  ARTIFACTS_NAMESPACE: string;
  ARTIFACTS_TRANSPORT?: 'binding' | 'rest';
  ARTIFACTS_API_TOKEN?: string;
  GIT_NATIVE_IMAGE: string;
  GIT_CONTAINERS: DurableObjectNamespace;
  GIT_HELPER_POOL_SIZE?: string;
  GIT_MAX_SESSIONS?: string;
  GIT_STORAGE_MODE?: 'artifacts' | 'local';
  GIT_RATE_LIMIT?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  GIT_HELPER_EGRESS_BYTES?: string;
  GIT_HELPER_OPERATIONS?: string;
  GIT_HELPER_PROFILE?: string;
  GIT_SIGNING_PRIVATE_KEY?: string;
  CELL_GIT_BINDINGS_JSON?: string;
}
