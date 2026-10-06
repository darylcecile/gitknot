import type { Context, Hono } from 'hono';

export type PrincipalKind = 'user' | 'application' | 'service' | 'agent' | 'runner' | 'job' | 'viewer';

export interface Principal {
  id: string;
  kind: PrincipalKind;
  user_id: string | null;
  credential_id: string | null;
  capabilities: string[] | null;
  repository_ids: string[] | null;
  account_ids: string[] | null;
  mfa: boolean;
}

export interface Repository {
  id: string;
  owner_id: string;
  name: string;
  slug: string;
  description: string;
  visibility: 'public' | 'private' | 'internal' | 'unlisted';
  default_branch: string;
  state: 'provisioning' | 'active' | 'archived' | 'transfer_pending' | 'moving' | 'deleted';
  revision: number;
  policy_revision: number;
  routing_epoch: number;
  cell_id: string;
  shard_id: string;
  storage_name: string;
  fork_source_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  recovery_until: string | null;
}

export interface EventRecord {
  id: string;
  type: string;
  version: number;
  occurred_at: string;
  actor_id: string | null;
  resource_id: string;
  resource_revision: number;
  repo_id?: string | null;
  account_id?: string | null;
  data: Record<string, unknown>;
}

export interface RequestAuthorization {
  capability: string;
  scope: { repo_id?: string; account_id?: string; ref?: string; paths?: string[] };
}

export interface RequestPolicy extends RequestAuthorization {
  repo_id: string | null;
  account_id: string | null;
  policy_revision: number | null;
  account_policy_revision: number | null;
  routing_epoch: number | null;
  /** Optional for recovery records written before request-wide authority capture. */
  repository_revision?: number | null;
}

export interface CredentialVersion {
  id: string;
  revision: number;
  parent_id: string | null;
  principal_id: string;
  user_id: string | null;
  auth_revision: number | null;
}

export interface AccountAuthorityVersion {
  account_id: string;
  epoch: number;
  policy_revision: number;
  phase: 'active' | 'fenced';
  barrier_id: string | null;
}

export interface PrincipalAuthorityVersion {
  id: string;
  kind: PrincipalKind;
  user_id: string | null;
  account_id: string | null;
}

/** Operator-configured physical D1 placement; binding aliases may differ in JS. */
export interface DatabaseLocation { cell_id: string; shard_id: string }
export type RequestDatabaseAuthority =
  | { kind: 'identity' | 'cell'; location: DatabaseLocation }
  | { kind: 'repository'; location: DatabaseLocation; repo_id: string };

/** Physical source of durable metadata, not a tenant authorization scope. */
export interface MetadataMessageLocation { cell_id?: string; shard_id?: string }

/** The original authority for a request, independent of optional retry keys. */
export interface MutationAuthority {
  principal: Principal | null;
  credential_versions: CredentialVersion[];
  policies: RequestPolicy[];
  capability?: string;
  /** Primary account epochs captured before a cross-database policy decision. */
  account_versions?: AccountAuthorityVersion[];
  principal_versions?: PrincipalAuthorityVersion[];
  /** Earliest credential/principal expiry, checked by the metadata database clock. */
  identity_expires_at?: string | null;
}

/** Durable metadata only. Response bodies and credential values are never recovery records. */
export interface IdempotencyRecord {
  principal_id: string;
  key: string;
  request_hash: string;
  strategy: 'mutation' | 'external' | 'legacy';
  generation: number;
  attempt_id: string | null;
  status: 'pending' | 'complete' | 'uncertain';
  lease_expires_at: string | null;
  expires_at: string;
  operation_id: string | null;
  resource_id: string | null;
  repo_id: string | null;
  account_id: string | null;
  event_id: string | null;
  audit_id: string | null;
  committed_at: string | null;
  policy_json: string;
  recovery_path: string | null;
  response_status: number | null;
  response_headers_json: string | null;
  replayable: number;
}

export interface IdempotencyContext {
  key: string;
  principal_id: string;
  request_hash: string;
  generation: number;
  attempt_id: string;
  strategy: 'mutation' | 'external';
  operation_id: string | null;
  authority: D1Database;
  policies: RequestPolicy[];
  credential_versions: CredentialVersion[];
  capability?: string;
  sensitive: boolean;
  recovering: boolean;
}

export interface Bindings {
  DB: D1Database;
  /** Current identity authority, preserved when DB selects a repository shard. */
  IDENTITY_DB?: D1Database;
  IDENTITY_CELL_ID?: string;
  IDENTITY_SHARD_ID?: string;
  DIRECTORY_DB?: D1Database;
  SEARCH_DB?: D1Database;
  BLOBS: R2Bucket;
  BACKUPS: R2Bucket;
  EVENTS: Queue<{ event_id: string } & MetadataMessageLocation>;
  DISPATCH: Queue<{ attempt_id: string; run_id?: string; generation?: number } & MetadataMessageLocation>;
  WEBHOOK_DELIVERIES: Queue<{ delivery_id: string } & MetadataMessageLocation>;
  MAIL_DELIVERIES: Queue<{ delivery_id: string } & MetadataMessageLocation>;
  REPO_COORDINATOR: DurableObjectNamespace;
  ADMISSION: DurableObjectNamespace;
  ATTEMPTS: DurableObjectNamespace;
  RUN_WORKFLOW: Workflow;
  OPERATIONS: Workflow;
  GIT_SERVICE: Fetcher;
  SECRETS: Fetcher;
  EXECUTOR: Fetcher;
  API?: Fetcher;
  ARTIFACTS?: unknown;
  ENVIRONMENT: 'development' | 'test' | 'staging' | 'production';
  APP_ORIGIN: string;
  API_ORIGIN: string;
  GIT_ORIGIN: string;
  CELL_ID: string;
  SHARD_ID: string;
  LIMITS_JSON?: string;
  INTERNAL_SERVICE_KEY: string;
  SESSION_KEY?: string;
  [binding: string]: unknown;
}

export interface AppVariables {
  principal: Principal | null;
  requestId: string;
  database: D1DatabaseSession;
  input: unknown;
  routing?: { resource_id: string; cell_id: string; shard_id: string; epoch: number;
    expected_state?: Repository['state']; lifecycle?: boolean };
  mutation_authority?: MutationAuthority;
  idempotency?: IdempotencyContext;
}

export type AppEnv = { Bindings: Bindings; Variables: AppVariables };
export type App = Hono<AppEnv>;
export type AppContext = Context<AppEnv>;
export type Database = D1Database | D1DatabaseSession;
