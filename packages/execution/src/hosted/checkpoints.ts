import { ApiError, canonicalJson, execute, now, one, sha256, stmt } from '@gitknot/core';
import type { Bindings } from '@gitknot/core';
import { z } from 'zod';
import type { AttemptContext, CompletionReceipt } from '../types.ts';
import { guardedBatch, primary } from '../store.ts';
import { localAttemptEnvironment, localFenced } from './local-runtime.ts';
import type { LocalRuntimeRequest } from './local-runtime.ts';

export type LocalHostedDraft = Omit<CompletionReceipt, 'log_manifest_digest'> & { log_manifest_digest: string | null };
interface CheckpointRow {
  attempt_id: string; repo_id: string; account_id: string; generation: number; plan_digest: string; producer_id: string;
  toolchain_digest: string; runtime_id: string; claim_id: string; claimed_at: string;
  draft_json: string | null; draft_hash: string | null; receipt_json: string | null; receipt_hash: string | null;
}
const digest = z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/);
const rawDigest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const draftSchema = z.object({ attempt_id: id, generation: z.number().int().positive(), plan_digest: digest, runner_id: z.string().min(1).max(256),
  conclusion: z.enum(['succeeded', 'failed', 'cancelled', 'timed_out', 'infrastructure_failed']), exit_code: z.number().int().min(0).max(255).nullable(),
  signal: z.string().regex(/^(?:SIG[A-Z0-9]{1,16}|UNKNOWN)$/).nullable(), resource_exhaustion: z.enum(['memory', 'disk', 'processes', 'logs', 'outputs', 'egress']).nullable(),
  toolchain_digest: digest, outputs: z.array(z.object({ name: id, sha256: rawDigest, size_bytes: z.number().int().nonnegative().max(1024 ** 3) }).strict()).max(128),
  log_manifest_digest: rawDigest.nullable(), process_group_stopped: z.boolean(), started_at: z.iso.datetime(), finished_at: z.iso.datetime(),
}).strict();

export function normalizeLocalHostedDraft(value: unknown): LocalHostedDraft {
  const parsed = draftSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(422, 'hosted_draft_invalid', 'The normalized hosted execution facts are invalid.');
  const draft = parsed.data;
  if (Date.parse(draft.finished_at) < Date.parse(draft.started_at) || draft.conclusion === 'succeeded'
    && (draft.exit_code !== 0 || draft.signal !== null || draft.resource_exhaustion !== null || !draft.process_group_stopped)) {
    throw new ApiError(422, 'hosted_draft_invalid', 'The hosted execution facts do not prove a clean successful exit.');
  }
  return draft;
}

function matches(row: CheckpointRow, context: AttemptContext): void {
  const a = context.attempt;
  if (row.attempt_id !== a.id || row.repo_id !== a.repo_id || row.account_id !== a.account_id || row.generation !== a.generation
    || row.plan_digest !== a.plan_digest || row.runtime_id !== a.runtime_id || row.producer_id !== a.producer_id || row.toolchain_digest !== a.toolchain_digest) throw localFenced();
}

function draftIdentity(draft: LocalHostedDraft, context: AttemptContext): void {
  const a = context.attempt;
  if (draft.attempt_id !== a.id || draft.generation !== a.generation || draft.plan_digest !== a.plan_digest
    || draft.runner_id !== a.producer_id || draft.toolchain_digest !== a.toolchain_digest
    || draft.outputs.some(output => !Object.hasOwn(context.job.outputs, output.name))) throw localFenced();
}

async function readRow(env: Bindings, context: AttemptContext): Promise<CheckpointRow | null> {
  const a = context.attempt;
  const row = await one<CheckpointRow>(primary(env), 'SELECT * FROM local_hosted_checkpoints WHERE attempt_id=? AND repo_id=? AND account_id=? AND generation=?', a.id, a.repo_id, a.account_id, a.generation);
  if (row) matches(row, context);
  return row;
}

/** A successful insert is the one execution claim, before CP begin or source access. */
export async function claimLocalHostedAttempt(env: Bindings, input: LocalRuntimeRequest, claimId: string): Promise<boolean> {
  const selected = await localAttemptEnvironment(env, input, true), a = selected.context.attempt, db = primary(selected.env);
  const existing = await readRow(selected.env, selected.context);
  if (existing) return false;
  const at = now();
  const result = await execute(db, `INSERT OR IGNORE INTO local_hosted_checkpoints
    (attempt_id,repo_id,account_id,generation,plan_digest,producer_id,toolchain_digest,runtime_id,claim_id,claimed_at,updated_at)
    SELECT id,repo_id,account_id,generation,plan_digest,producer_id,toolchain_digest,runtime_id,?,?,? FROM execution_attempts a
    WHERE a.id=? AND a.repo_id=? AND a.account_id=? AND a.generation=? AND a.executor='hosted' AND COALESCE(a.execution_backend,'local')='local'
      AND a.status='leased' AND a.execution_started_at IS NULL AND a.lease_expires_at>? AND a.deadline_at>?
      AND EXISTS (SELECT 1 FROM workflow_jobs j WHERE j.id=a.job_id AND j.current_attempt_id=a.id AND j.generation=a.generation)`,
  claimId, at, at, a.id, a.repo_id, a.account_id, a.generation, at, at);
  return result.meta.changes === 1;
}

export async function persistLocalHostedDraft(env: Bindings, input: LocalRuntimeRequest, claimId: string, value: LocalHostedDraft): Promise<void> {
  const selected = await localAttemptEnvironment(env, input), context = selected.context, a = context.attempt;
  const draft = normalizeLocalHostedDraft(value), row = await readRow(selected.env, context);
  if (!row || row.claim_id !== claimId) throw localFenced();
  draftIdentity(draft, context);
  const json = canonicalJson(draft), hash = await sha256(json);
  if (row.draft_hash) {
    if (row.draft_hash !== hash || row.draft_json !== json) throw new ApiError(409, 'hosted_draft_conflict', 'The attempt already has different normalized execution facts.');
    return;
  }
  const db = primary(selected.env);
  await guardedBatch(db, stmt(db, `UPDATE local_hosted_checkpoints SET draft_json=?,draft_hash=?,updated_at=?
    WHERE attempt_id=? AND repo_id=? AND account_id=? AND generation=? AND claim_id=? AND draft_json IS NULL`,
  json, hash, now(), a.id, a.repo_id, a.account_id, a.generation, claimId), []);
}

export async function readLocalHostedProgress(env: Bindings, input: LocalRuntimeRequest): Promise<LocalHostedDraft | null> {
  const selected = await localAttemptEnvironment(env, input), row = await readRow(selected.env, selected.context);
  if (!row?.draft_json || !row.draft_hash) return null;
  if (await sha256(row.draft_json) !== row.draft_hash) throw new ApiError(503, 'hosted_draft_corrupt', 'The durable hosted draft failed integrity verification.');
  const draft = normalizeLocalHostedDraft(JSON.parse(row.draft_json));
  draftIdentity(draft, selected.context);
  return draft;
}

/** CP-safe lookup: no SDK imports, source capability or tenant secret values. */
export async function readLocalHostedDraft(env: Bindings, attemptId: string, generation: number): Promise<CompletionReceipt | null> {
  const selected = await localAttemptEnvironment(env, { attempt_id: attemptId, generation }), row = await readRow(selected.env, selected.context);
  if (!row?.receipt_json || !row.receipt_hash) {
    // The SDK/Workflow can disappear after persisting facts but before finalizing.
    // A known process stop or the independently recorded destruction permits
    // finalization; this never executes a command or asserts an unobserved stop.
    if (!row?.draft_json || !row.draft_hash || await sha256(row.draft_json) !== row.draft_hash) return null;
    const draft = normalizeLocalHostedDraft(JSON.parse(row.draft_json));
    draftIdentity(draft, selected.context);
    return draft.log_manifest_digest ? finalizeLocalHostedDraft(selected.env, { attempt_id: attemptId, generation }, draft.log_manifest_digest) : null;
  }
  if (await sha256(row.receipt_json) !== row.receipt_hash) throw new ApiError(503, 'hosted_draft_corrupt', 'The durable hosted receipt failed integrity verification.');
  const receipt = normalizeLocalHostedDraft(JSON.parse(row.receipt_json));
  draftIdentity(receipt, selected.context);
  if (!receipt.log_manifest_digest || !receipt.process_group_stopped) throw new ApiError(503, 'hosted_draft_corrupt', 'The hosted receipt is not finalized.');
  return { ...receipt, log_manifest_digest: receipt.log_manifest_digest };
}

export async function finalizeLocalHostedDraft(env: Bindings, input: LocalRuntimeRequest, logDigest: string): Promise<CompletionReceipt | null> {
  const selected = await localAttemptEnvironment(env, input), a = selected.context.attempt, row = await readRow(selected.env, selected.context);
  if (!row?.draft_json || !row.draft_hash) return null;
  if (row.receipt_json) return readLocalHostedDraft(selected.env, input.attempt_id, input.generation);
  if (await sha256(row.draft_json) !== row.draft_hash || !rawDigest.safeParse(logDigest).success) throw new ApiError(503, 'hosted_draft_corrupt', 'The durable hosted draft failed integrity verification.');
  const draft = normalizeLocalHostedDraft(JSON.parse(row.draft_json));
  draftIdentity(draft, selected.context);
  if (draft.log_manifest_digest && draft.log_manifest_digest !== logDigest) throw new ApiError(409, 'hosted_log_conflict', 'The finalized log digest differs from the durable draft.');
  if (!draft.process_group_stopped) {
    const proof = await one(primary(selected.env), `SELECT receipt_id FROM execution_runtime_receipts WHERE runtime_id=? AND attempt_id=? AND repo_id=? AND generation=? AND state='destroyed'`, a.runtime_id, a.id, a.repo_id, a.generation);
    if (!proof) return null;
  }
  const receipt: CompletionReceipt = { ...draft, process_group_stopped: true, log_manifest_digest: logDigest };
  const json = canonicalJson(receipt), hash = await sha256(json), db = primary(selected.env);
  await guardedBatch(db, stmt(db, `UPDATE local_hosted_checkpoints SET receipt_json=?,receipt_hash=?,updated_at=?
    WHERE attempt_id=? AND repo_id=? AND account_id=? AND generation=? AND receipt_json IS NULL AND draft_hash=?`,
  json, hash, now(), a.id, a.repo_id, a.account_id, a.generation, row.draft_hash), []);
  return receipt;
}
