import type { Access, DataType, Executor, OutputDefinition, ToolchainDescriptor, Value, WorkflowDefinition } from './schema.ts';

export interface WorkflowEvent {
  type: string;
  changed_paths?: string[];
  ref?: string;
  pull_request_id?: string;
  merge_candidate_id?: string;
  inputs?: Record<string, string | number | boolean | null>;
}

export interface TrustIdentity {
  level: 'trusted' | 'untrusted';
  fork: boolean;
  producer_id: string;
}

export interface WorkflowLimits {
  max_jobs: number;
  max_fanout: number;
  max_steps: number;
  max_timeout_ms: number;
  max_log_bytes: number;
  max_output_bytes: number;
  max_output_files: number;
  max_input_bytes: number;
  max_cache_bytes: number;
  max_chunk_bytes: number;
}

export interface WorkflowPolicy {
  revision: string | number;
  allowed_workflow_revisions: string[];
  allowed_source_revisions?: string[];
  allowed_source_trust?: Array<'trusted' | 'untrusted'>;
  access: Partial<Access>;
  hosted_profiles: string[];
  self_hosted_pools: Record<string, {
    trust: 'trusted' | 'untrusted';
    disposable: boolean;
    repository_ids?: string[];
    producer_id?: string;
  }>;
  inapplicable_jobs: string[];
  allowed_toolchains?: string[];
  allowed_modules?: Record<string, string>;
  environments?: Record<string, { approval_required: boolean; allowed_jobs?: string[] }>;
  limits?: Partial<WorkflowLimits>;
}

export interface CompileContext {
  repo_id: string;
  commit: string;
  workflow_revision: string;
  event: WorkflowEvent;
  trust: TrustIdentity;
  policy: WorkflowPolicy;
  toolchains: Record<string, ToolchainDescriptor>;
  /** Values are module YAML strings or JSON definitions, indexed by name@version. */
  modules?: Record<string, unknown>;
  configuration?: { selection_id: string; selection_digest: string };
}

export interface ResolvedToolchain extends ToolchainDescriptor {
  name: string;
  fingerprint: string;
}

export interface CompiledCommand {
  run: string;
  shell: 'sh' | 'bash' | 'pwsh' | 'cmd';
  working_directory: string;
  env: Record<string, Value>;
  timeout_ms: number;
}

export interface CompiledOutput {
  type: DataType;
  path: string;
  retention_seconds: number;
  required: boolean;
}

export interface CompiledStep {
  id: string;
  module: { reference: string; digest: string } | null;
  commands: CompiledCommand[];
  env: Record<string, Value>;
  outputs: Record<string, CompiledOutput>;
  timeout_ms: number;
}

export interface CompiledJob {
  id: string;
  producer_id: string;
  needs: string[];
  executor: Executor;
  toolchain: ResolvedToolchain;
  timeout_ms: number;
  access: Access;
  env: Record<string, Value>;
  condition: { outcome: 'run' | 'not_applicable' | 'blocked'; reason: string };
  steps: CompiledStep[];
  outputs: Record<string, CompiledOutput>;
  reports: Record<string, { path: string; format: 'junit' | 'sarif' | 'json'; required: boolean; retention_seconds: number }>;
  cache: { paths: string[]; key_files: string[]; mode: 'read' | 'read_write'; namespace: string } | null;
  environment: { name: string; approval_required: boolean } | null;
}

export interface RunManifest {
  version: 1;
  compiler_version: '1.0.0';
  repo_id: string;
  source: { commit: string; workflow_revision: string };
  workflow: { name: string; definition_digest: string };
  policy: { revision: string; digest: string };
  configuration: { selection_id: string | null; selection_digest: string | null };
  trust: TrustIdentity;
  event: WorkflowEvent;
  modules: Record<string, string>;
  jobs: CompiledJob[];
  order: string[];
  concurrency: { group: string; supersede: 'cancel' | 'queue' } | null;
  limits: WorkflowLimits;
  digest: string;
}

export type JobOutcome = 'passed' | 'failed' | 'dependency_blocked' | 'cancelled' | 'timed_out' | 'not_applicable';
export interface StepResult {
  id: string;
  outcome: JobOutcome;
  exit_code: number | null;
  signal: string | null;
}

export interface ValidationOptions {
  modules?: Record<string, unknown>;
  limits?: Partial<WorkflowLimits>;
}

export interface ValidationResult {
  valid: boolean;
  definition?: WorkflowDefinition;
  issues: import('./errors.ts').WorkflowIssue[];
}

export type { Access, DataType, Executor, OutputDefinition, ToolchainDescriptor, Value, WorkflowDefinition };
