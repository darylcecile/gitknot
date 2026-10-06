import { z } from 'zod';
import { EXECUTION_LIMITS } from './config.ts';
import { logicalIdentifierSchema } from '@gitknot/workflows';

const id = z.string().regex(/^[a-z][a-z0-9]*_[a-zA-Z0-9_-]{1,120}$/);
const logicalId = logicalIdentifierSchema;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const attemptAuthSchema = z.object({ runner_id: id, generation: z.number().int().positive(), lease_token: z.string().min(32).max(256) }).strict();
const encoded = z.string().max(Math.ceil(EXECUTION_LIMITS.log_chunk_bytes / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const chunk = z.object({ sequence: z.number().int().min(0).max(65535), digest, size_bytes: z.number().int().min(0).max(EXECUTION_LIMITS.log_chunk_bytes) }).strict();
export const logUploadSchema = attemptAuthSchema.extend({ ...chunk.shape, data_base64: encoded }).strict();
export const outputUploadSchema = logUploadSchema.extend({ name: logicalId, kind: z.enum(['artifact', 'report', 'value']), final: z.boolean(), media_type: z.string().max(128), retention_seconds: z.number().int().min(1).max(EXECUTION_LIMITS.max_retention_seconds) }).strict();
export const stepSecretsSchema = attemptAuthSchema.extend({ step_id: logicalId, names: z.array(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,127}$/)).max(64) }).strict();
const outcome = z.enum(['passed', 'failed', 'dependency_blocked', 'cancelled', 'timed_out', 'not_applicable']);
export const portableReceiptSchema = z.object({
  version: z.literal(1), attempt_id: id, run_id: id, job_id: logicalId, runner_id: id, generation: z.number().int().positive(),
  manifest_digest: digest, commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), toolchain_fingerprint: digest,
  outcome, started_at: z.iso.datetime(), finished_at: z.iso.datetime(), exit_code: z.number().int().nullable(), signal: z.string().max(64).nullable(), reason: z.string().max(4096),
  logs: z.array(chunk).max(65536), outputs: z.array(z.object({ name: logicalId, kind: z.enum(['artifact', 'report', 'value']), digest,
    size_bytes: z.number().int().nonnegative().max(EXECUTION_LIMITS.output_bytes), chunks: z.array(chunk).max(65536) }).strict()).max(128),
  steps: z.array(z.object({ id: logicalId, outcome, exit_code: z.number().int().nullable(), signal: z.string().max(64).nullable() }).strict()).max(512), cleanup_confirmed: z.literal(true),
}).strict();
export const completionSchema = attemptAuthSchema.extend({ receipt: portableReceiptSchema, receipt_digest: digest }).strict();
export const terminationSchema = attemptAuthSchema.extend({ termination: z.object({ version: z.literal(1), attempt_id: id, runner_id: id,
  generation: z.number().int().positive(), manifest_digest: digest, commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  finished_at: z.iso.datetime(), cleanup_confirmed: z.literal(true) }).strict(), termination_digest: digest }).strict();
export type PortableReceipt = z.infer<typeof portableReceiptSchema>;
