import { canonicalJson, limits, many, now, one } from '@gitknot/core';
import { z } from 'zod';
import { GitAdmissionBook } from './git-book.ts';
import { invariant } from './errors.ts';
import { admissionRequest } from './transport.ts';
import { storageFundingWindow } from './storage-policy.ts';
import { activeSlice } from './catalog.ts';
import { verifyStorageHandoff } from './storage-transfer.ts';
import type { StorageHandoff } from './storage-transfer.ts';
import type { BillingBindings } from './types.ts';
import type { CanonicalGitMeter, GitFundingWindow } from './git-types.ts';

const identity = z.object({ repo_id: z.string().min(1).max(128), storage_name: z.string().min(1).max(256), operation_id: z.string().min(1).max(128) });

/** The shared lifecycle handoff owns retries; both financial participants retain their intermediate states. */
export async function handleGitTransfer(env: BillingBindings, book: GitAdmissionBook, target: string, action: string, raw: unknown): Promise<unknown> {
  const input = identity.parse(raw), account = target.startsWith('account:');
  const phase = action === 'git-transfer-activate' || action === 'git-transfer-settle' ? 'commit'
    : action === 'git-transfer-abort' || action === 'git-transfer-resume' ? 'abort' : 'prepare';
  const handoff = await verifyStorageHandoff(env, input.operation_id, phase);
  invariant(input.repo_id === handoff.repo_id, 'git_transfer_scope', 'Canonical storage is outside this repository handoff.');
  const receiving = ['git-transfer-prepare', 'git-transfer-activate', 'git-transfer-abort'].includes(action);
  if (account) invariant(target === `account:${receiving ? handoff.to_account_id : handoff.from_account_id}`, 'git_transfer_scope', 'The canonical handoff reached another owner.');
  if (action === 'git-transfer-prepare') return prepareImport(env, book, target, handoff, input, raw);
  const meter = await book.gitMeter(input.repo_id, input.storage_name);
  const source = account && receiving ? await admissionRequest<CanonicalGitMeter>(env, `account:${handoff.from_account_id}`, 'git-meter', input) : meter;
  invariant(source, 'git_meter_missing', 'The canonical source meter is unavailable.', 404);
  if (!account) invariant(target === `capacity:${source.slice_id}`, 'git_transfer_scope', 'The canonical handoff reached another platform slice.');
  const remote = (name: string, payload: unknown = raw) => admissionRequest(env, `capacity:${source.slice_id}`, name, payload);
  switch (action) {
    case 'git-transfer-fence': {
      if (meter?.state === 'stored') {
        const through = now();
        if (account) await remote('git-accrue', { ...input, through });
        await book.accrueGit(input.repo_id, input.storage_name, through);
      }
      if (account) await remote(action);
      return book.fenceGitTransfer(input.repo_id, input.storage_name, input.operation_id, handoff.to_account_id);
    }
    case 'git-transfer-activate':
    case 'git-transfer-settle': {
      const { effective_at } = identity.extend({ effective_at: z.iso.datetime() }).parse(raw);
      invariant(handoff.effective_at === effective_at, 'git_transfer_boundary', 'The canonical owner boundary must be the committed catalog timestamp.');
      if (account) await remote(action);
      return action === 'git-transfer-activate' ? book.activateGitImport(input.repo_id, input.storage_name, input.operation_id, effective_at)
        : book.settleGitTransfer(input.repo_id, input.storage_name, input.operation_id, effective_at);
    }
    case 'git-transfer-abort':
      if (account) await remote(action);
      await book.abortGitImport(input.repo_id, input.storage_name, input.operation_id);
      return { aborted: true };
    case 'git-transfer-resume':
      if (account) await remote(action);
      await book.resumeGitOwner(input.repo_id, input.storage_name, input.operation_id);
      return { resumed: true };
    default: throw new Error('Unknown canonical owner transition');
  }
}

async function prepareImport(env: BillingBindings, book: GitAdmissionBook, target: string, handoff: StorageHandoff,
  input: z.infer<typeof identity>, raw: unknown): Promise<CanonicalGitMeter> {
  if (target.startsWith('capacity:')) {
    const { source, window } = raw as { source: CanonicalGitMeter; window: GitFundingWindow };
    const current = await book.gitMeter(input.repo_id, input.storage_name);
    invariant(current?.state === 'transferring' && current.transfer_operation_id === input.operation_id && target === `capacity:${current.slice_id}`
      && current.logical_bytes === source.logical_bytes && current.retained_bound_bytes === source.retained_bound_bytes
      && canonicalJson(current.rates) === canonicalJson(source.rates), 'git_transfer_source_changed', 'The canonical capacity source does not match its fenced account meter.');
    await activeSlice(env, current.slice_id, true);
    return book.prepareGitImport(source, input.operation_id, handoff.to_account_id, handoff.actor_id, window);
  }
  const source = await admissionRequest<CanonicalGitMeter>(env, `account:${handoff.from_account_id}`, 'git-meter', input);
  invariant(source && source.account_id === handoff.from_account_id, 'git_transfer_source_changed', 'The former canonical owner is unavailable.');
  const funded = storageFundingWindow(now(), null, source.renewal_policy);
  const imported = await book.prepareGitImport(source, input.operation_id, handoff.to_account_id, handoff.actor_id,
    { ...funded, renew_after: funded.renew_after! }, String(limits(env).repository_storage_bytes));
  await admissionRequest(env, `capacity:${source.slice_id}`, 'git-transfer-prepare', { ...input, source,
    window: { funded_until: imported.funded_until, commitment_until: imported.commitment_until, renew_after: imported.renew_after } });
  return imported;
}

export async function prepareCanonicalTransfers(env: BillingBindings, handoff: StorageHandoff): Promise<{ processed: number; remaining: boolean }> {
  const rows = await many<{ body_json: string }>(env.DB, `SELECT s.body_json FROM billing_git_repositories s WHERE s.coordinator_id=? AND s.repo_id=?
    AND json_extract(s.body_json,'$.state') IN ('stored','transferring') AND NOT EXISTS
    (SELECT 1 FROM billing_git_transfers t WHERE t.operation_id=? AND t.storage_name=s.storage_name AND t.state='prepared') ORDER BY s.storage_name LIMIT 32`,
  `account:${handoff.from_account_id}`, handoff.repo_id, handoff.operation_id);
  for (const row of rows) {
    const source = JSON.parse(row.body_json) as CanonicalGitMeter;
    const input = { repo_id: handoff.repo_id, storage_name: source.storage_name, operation_id: handoff.operation_id };
    await env.DB.prepare(`INSERT OR IGNORE INTO billing_git_transfers(operation_id,repo_id,storage_name,from_account_id,to_account_id,state,source_json)
      VALUES (?,?,?,?,?,'preparing',?)`).bind(handoff.operation_id, handoff.repo_id, source.storage_name, handoff.from_account_id, handoff.to_account_id, row.body_json).run();
    await admissionRequest(env, `account:${handoff.from_account_id}`, 'git-transfer-fence', input);
    const receiving = await admissionRequest<CanonicalGitMeter>(env, `account:${handoff.to_account_id}`, 'git-transfer-prepare', input);
    await env.DB.prepare("UPDATE billing_git_transfers SET state='prepared',target_json=? WHERE operation_id=? AND storage_name=? AND state='preparing'")
      .bind(JSON.stringify(receiving), handoff.operation_id, source.storage_name).run();
  }
  const remaining = await one(env.DB, `SELECT 1 FROM billing_git_repositories s WHERE s.coordinator_id=? AND s.repo_id=?
    AND json_extract(s.body_json,'$.state') IN ('stored','transferring') AND NOT EXISTS
    (SELECT 1 FROM billing_git_transfers t WHERE t.operation_id=? AND t.storage_name=s.storage_name AND t.state='prepared') LIMIT 1`,
  `account:${handoff.from_account_id}`, handoff.repo_id, handoff.operation_id);
  return { processed: rows.length, remaining: !!remaining };
}

export async function completeCanonicalTransfers(env: BillingBindings, handoff: StorageHandoff, effectiveAt: string): Promise<{ processed: number; remaining: boolean }> {
  const rows = await many<{ storage_name: string }>(env.DB, "SELECT storage_name FROM billing_git_transfers WHERE operation_id=? AND state='prepared' ORDER BY storage_name LIMIT 32", handoff.operation_id);
  for (const row of rows) {
    const input = { repo_id: handoff.repo_id, storage_name: row.storage_name, operation_id: handoff.operation_id, effective_at: effectiveAt };
    await admissionRequest(env, `account:${handoff.to_account_id}`, 'git-transfer-activate', input);
    await admissionRequest(env, `account:${handoff.from_account_id}`, 'git-transfer-settle', input);
    await env.DB.prepare("UPDATE billing_git_transfers SET state='complete',effective_at=? WHERE operation_id=? AND storage_name=? AND state='prepared'")
      .bind(effectiveAt, handoff.operation_id, row.storage_name).run();
  }
  return { processed: rows.length, remaining: !!await one(env.DB, "SELECT 1 FROM billing_git_transfers WHERE operation_id=? AND state<>'complete' LIMIT 1", handoff.operation_id) };
}

export async function abortCanonicalTransfers(env: BillingBindings, handoff: StorageHandoff): Promise<{ processed: number; remaining: boolean }> {
  const rows = await many<{ storage_name: string }>(env.DB, "SELECT storage_name FROM billing_git_transfers WHERE operation_id=? AND state<>'aborted' ORDER BY storage_name LIMIT 32", handoff.operation_id);
  for (const row of rows) {
    const input = { repo_id: handoff.repo_id, storage_name: row.storage_name, operation_id: handoff.operation_id };
    await admissionRequest(env, `account:${handoff.to_account_id}`, 'git-transfer-abort', input);
    await admissionRequest(env, `account:${handoff.from_account_id}`, 'git-transfer-resume', input);
    await env.DB.prepare("UPDATE billing_git_transfers SET state='aborted' WHERE operation_id=? AND storage_name=?").bind(handoff.operation_id, row.storage_name).run();
  }
  return { processed: rows.length, remaining: !!await one(env.DB, "SELECT 1 FROM billing_git_transfers WHERE operation_id=? AND state<>'aborted' LIMIT 1", handoff.operation_id) };
}
