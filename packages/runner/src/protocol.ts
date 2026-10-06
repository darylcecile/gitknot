import { z } from 'zod';
import { MAX_TYPED_OUTPUT_WIRE_BYTES, logicalIdentifierSchema, type RunManifest, type StepResult, type ToolchainDescriptor, type JobOutcome } from '../../workflows/src/index.ts';
import { credentialExchangeSchema } from './credential-exchange.ts';
import { isolationSchema, type RunnerIsolation } from './isolation-types.ts';
import { toolchainSchema } from '../../workflows/src/schema.ts';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const date = z.string().refine((value) => /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)), 'Expected a UTC timestamp.');
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const token = z.string().min(16).max(16_384).refine((value) => !/[\x00-\x20\x7f]/.test(value));

export const capabilitiesSchema = z.strictObject({
  os: z.enum(['linux', 'darwin', 'win32']), arch: z.enum(['x64', 'arm64']),
  toolchains: z.record(z.string().min(1).max(128), digest), labels: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).max(64),
});

export const registrationSchema = z.strictObject({
  runner_id: id, pool_id: id, pool_name: id.optional(), account_id: id, repository_ids: z.array(id).max(100_000),
  trust: z.enum(['trusted', 'untrusted']), disposable: z.boolean(), machine_token: token,
  credential_expires_at: date,
  credential_generation: z.number().int().positive(), exchange_id: credentialExchangeSchema.shape.id,
  heartbeat_interval_seconds: z.number().int().min(1).max(60), poll_timeout_seconds: z.number().int().min(1).max(50),
});

export const registrationRequestSchema = z.strictObject({
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/), capabilities: capabilitiesSchema,
  slots: z.literal(1), disposable: z.boolean(),
});
export const rotationResponseSchema = z.strictObject({
  machine_token: token, credential_expires_at: date, credential_generation: z.number().int().positive(), exchange_id: credentialExchangeSchema.shape.id,
});

export const runnerConfigurationDraftSchema = z.strictObject({
  version: z.literal(1), api_origin: z.string(), capabilities: capabilitiesSchema,
  toolchains: z.record(z.string(), toolchainSchema), state_directory: z.string().min(1), work_directory: z.string().min(1),
  allow_loopback_http: z.boolean(), allowed_git_origins: z.array(z.string()).max(16), isolation: isolationSchema,
});
export const runnerConfigurationSchema = runnerConfigurationDraftSchema.extend({ registration: registrationSchema });

export const inputSchema = z.strictObject({
  job_id: logicalIdentifierSchema, name: logicalIdentifierSchema, type: z.enum(['artifact', 'string', 'number', 'boolean', 'json']),
  digest, size_bytes: z.number().int().nonnegative(), download_path: z.string().min(1).max(4096),
}).refine(input => input.type === 'artifact' || input.size_bytes <= MAX_TYPED_OUTPUT_WIRE_BYTES, 'Typed inputs exceed the canonical wire-byte limit.');

export const assignmentSchema = z.strictObject({
  attempt_id: id, run_id: id, job_id: logicalIdentifierSchema, generation: z.number().int().positive(), lease_token: token,
  lease_expires_at: date, deadline_at: date, manifest: z.unknown(),
  source: z.strictObject({ url: z.string().min(1).max(4096), commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), token: token.optional() }),
  inputs: z.array(inputSchema).max(1024).optional(), variables: z.record(z.string(), z.string().max(65_536)).optional(),
  approved_environment: z.strictObject({ name: id, manifest_digest: digest, commit: z.string() }).optional(),
});

export type RunnerCapabilities = z.infer<typeof capabilitiesSchema>;
export type RunnerRegistration = z.infer<typeof registrationSchema>;
export type AssignmentInput = z.infer<typeof inputSchema>;
export type Assignment = Omit<z.infer<typeof assignmentSchema>, 'manifest'> & { manifest: RunManifest };

export interface RunnerConfiguration {
  version: 1;
  api_origin: string;
  registration: RunnerRegistration;
  capabilities: RunnerCapabilities;
  toolchains: Record<string, ToolchainDescriptor>;
  state_directory: string;
  work_directory: string;
  allow_loopback_http: boolean;
  allowed_git_origins: string[];
  isolation: RunnerIsolation;
}

export interface AttemptAuth { runner_id: string; generation: number; lease_token: string }
export interface LogChunk { sequence: number; digest: string; size_bytes: number }
export interface OutputChunk extends LogChunk { name: string }
export interface ReceiptOutput {
  name: string;
  kind: 'artifact' | 'report' | 'value';
  digest: string;
  size_bytes: number;
  chunks: Array<{ sequence: number; digest: string; size_bytes: number }>;
}

export interface CompletionReceipt {
  version: 1;
  attempt_id: string;
  run_id: string;
  job_id: string;
  runner_id: string;
  generation: number;
  manifest_digest: string;
  commit: string;
  toolchain_fingerprint: string;
  outcome: JobOutcome;
  started_at: string;
  finished_at: string;
  exit_code: number | null;
  signal: string | null;
  reason: string;
  logs: LogChunk[];
  outputs: ReceiptOutput[];
  steps: StepResult[];
  cleanup_confirmed: true;
}

export interface TerminationReceipt {
  version: 1;
  attempt_id: string;
  runner_id: string;
  generation: number;
  manifest_digest: string;
  commit: string;
  finished_at: string;
  cleanup_confirmed: true;
}
