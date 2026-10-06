import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import type { GitEvidence, GitRemote, PublicationPermit, PublicationResult, RefUpdate } from '../../../packages/git/src/types.ts';
import { ZERO_OID } from '../../../packages/git/src/types.ts';
import { transactionRef } from '../../../packages/git/src/protocol.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';
import { NativeGit } from './process.ts';
import { remoteConfiguration } from './remote.ts';
import { nativeHookPath } from './hook-path.ts';

export async function remoteRefs(git: NativeGit, remote: GitRemote, refs: string[], localRoot?: string): Promise<Map<string, string>> {
  const env = await remoteConfiguration(remote, git.development, localRoot);
  const output = await git.text(['ls-remote', '--refs', remote.url, ...refs], { env, max_output: git.limits.max_metadata_bytes });
  const result = new Map<string, string>();
  for (const line of output.split('\n').filter(Boolean)) {
    const [oid, ref] = line.split('\t');
    requireValue(/^[a-f0-9]{40}$/u.test(oid) && ref?.startsWith('refs/'), 'invalid_remote_refs', 'Canonical Git returned an invalid ref listing.', 503);
    result.set(ref, oid);
  }
  return result;
}

export async function publishCanonical(git: NativeGit, permit: PublicationPermit, evidence: GitEvidence, localRoot?: string): Promise<PublicationResult> {
  requireValue(permit.evidence_digest === evidence.digest && permit.marker_oid === evidence.marker_oid, 'publication_permit', 'Publication permit does not match the validated objects.', 409);
  const markerRef = transactionRef(permit.operation_id);
  const updates = evidence.updates.map(({ ref, old_oid, new_oid }) => ({ ref, old_oid, new_oid }));
  const all = [...updates, { ref: markerRef, old_oid: ZERO_OID, new_oid: evidence.marker_oid }];
  const base: PublicationResult = { operation_id: permit.operation_id, outcome: 'uncertain', refs: updates, marker_oid: null, report_status: [] };
  let environment: Record<string, string>;
  try { environment = await remoteConfiguration(permit.remote, git.development, localRoot); }
  catch { return { ...base, outcome: 'rejected', proof: 'not_started', reason: 'Canonical Git access could not be prepared.' }; }
  // A leading '+' or --force would override the exact lease semantics; neither is used here.
  const hooks = await publicationHooks(git, all);
  const args = ['push', '--porcelain', '--atomic', '--no-follow-tags', '--verify',
    ...all.map(update => `--force-with-lease=${update.ref}:${update.old_oid === ZERO_OID ? '' : update.old_oid}`),
    permit.remote.url,
    ...all.map(update => `${update.new_oid === ZERO_OID ? '' : update.new_oid}:${update.ref}`),
  ];
  let push;
  try { push = await git.run(args, { env: environment, hooks, allow_failure: true }); }
  catch {
    return { ...base, reason: 'The canonical publisher was interrupted. Its outcome must be reconciled.' };
  }
  // Git omits up-to-date refs from its wire command list. The trusted pre-push hook
  // rejects omitted refs and mismatched advertised OIDs before any pack is sent.
  let approved = false;
  try { approved = await readFile(join(git.directory, 'gitknot-publication-ready'), 'utf8') === JSON.stringify(all); } catch { /* no approval */ }
  if (!approved) return { ...base, outcome: 'rejected', proof: 'not_started', reason: 'Canonical refs or atomic capabilities changed before publication. Fetch and retry.' };
  const statuses = porcelainStatuses(push.stdout, all);
  let actual: Map<string, string>;
  try { actual = await remoteRefs(git, permit.remote, all.map(update => update.ref), localRoot); }
  catch { return { ...base, report_status: statuses, reason: 'Canonical publication read-back is pending.' }; }
  const matches = all.every(update => (actual.get(update.ref) ?? ZERO_OID) === update.new_oid);
  if (push.code === 0 && matches && statuses.length === all.length && statuses.every(status => [' ', '+', '-', '*'].includes(status.status))) {
    return { ...base, outcome: 'committed', marker_oid: evidence.marker_oid, report_status: statuses, proof: 'report_status' };
  }
  // A complete rejection for every changing ref is a definitive protocol outcome.
  const rejected = statuses.length === all.length && statuses.every(status => status.status === '!' && status.remote_rejected);
  if (rejected && !actual.has(markerRef)) {
    return { ...base, outcome: 'rejected', report_status: statuses, proof: 'report_status', reason: 'Canonical Git rejected the conditional atomic publication. Fetch and retry.' };
  }
  // Even if a local process lost report-status, the exact atomic marker is recovery evidence.
  if (matches) return { ...base, outcome: 'committed', marker_oid: evidence.marker_oid, report_status: statuses, proof: 'marker' };
  return { ...base, report_status: statuses, reason: 'The canonical publication outcome is uncertain. Repository writes remain fenced.' };
}

async function publicationHooks(git: NativeGit, updates: RefUpdate[]): Promise<string> {
  const directory = join(git.directory, 'gitknot-publication-hooks');
  await mkdir(directory, { mode: 0o700 });
  const entry = await nativeHookPath();
  requireValue(!/[\r\n'\\]/u.test(entry + process.execPath), 'native_configuration', 'Invalid native hook path.', 503);
  await writeFile(join(git.directory, 'gitknot-approved-publication.json'), JSON.stringify(updates), { mode: 0o600 });
  await writeFile(join(directory, 'pre-push'), `#!/bin/sh\nexec '${process.execPath}' --max-old-space-size=128 --experimental-strip-types '${entry}' pre-push\n`, { mode: 0o700 });
  return directory;
}

export async function inspectPublication(git: NativeGit, remote: GitRemote, operationId: string, evidence: GitEvidence, localRoot?: string): Promise<PublicationResult> {
  const marker = transactionRef(operationId);
  const refs = evidence.updates.map(({ ref, old_oid, new_oid }) => ({ ref, old_oid, new_oid }));
  const actual = await remoteRefs(git, remote, [...refs.map(update => update.ref), marker], localRoot);
  const committed = actual.get(marker) === evidence.marker_oid && refs.every(update => (actual.get(update.ref) ?? ZERO_OID) === update.new_oid);
  return { operation_id: operationId, outcome: committed ? 'committed' : 'uncertain', refs,
    marker_oid: actual.get(marker) ?? null, report_status: [], ...(committed ? { proof: 'marker' as const } : {}),
    ...(committed ? {} : { reason: 'The old publisher has no conclusive canonical outcome. Its fence is retained.' }),
  };
}

function porcelainStatuses(output: Buffer, updates: RefUpdate[]): Array<{ ref: string; status: string; remote_rejected: boolean }> {
  const expected = new Set(updates.map(update => update.ref));
  const result: Array<{ ref: string; status: string; remote_rejected: boolean }> = [];
  for (const line of output.toString().split('\n')) {
    const match = /^([ +*!=\-])\t[^\t]*:(refs\/[^\t]+)\t(.*)$/u.exec(line);
    if (!match) continue;
    requireValue(expected.delete(match[2]), 'invalid_report_status', 'Canonical Git reported an unexpected or duplicate ref result.', 503);
    // "remote failure" includes a missing report-status and is never rejection proof.
    result.push({ ref: match[2], status: match[1], remote_rejected: match[3].startsWith('[remote rejected]') });
  }
  return result;
}
