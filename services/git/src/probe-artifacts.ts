/** Operator-run acceptance probe against an EXISTING isolated Artifacts repository. Never auto-runs in CI. */
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NativeGit } from './process.ts';
import { createWorkingRepository, refreshRepository } from './repository.ts';
import type { WorkingRepository } from './repository.ts';
import { publishCanonical, inspectPublication, remoteRefs } from './publication.ts';
import { DEFAULT_GIT_LIMITS, ZERO_OID } from '../../../packages/git/src/types.ts';
import type { GitCapabilitiesAttestation, GitEvidence, GitRemote, PublicationPermit, RefUpdate } from '../../../packages/git/src/types.ts';
import { digestJson, limitStream, pktLine, transactionRef } from '../../../packages/git/src/protocol.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';

const remoteUrl = process.env.ARTIFACTS_PROBE_REMOTE;
const authorization = process.env.ARTIFACTS_PROBE_AUTHORIZATION;
const account = process.env.ARTIFACTS_ACCOUNT_ID;
const namespace = process.env.ARTIFACTS_NAMESPACE;
const image = process.env.GIT_NATIVE_IMAGE;
const evidenceKey = process.env.GIT_PROBE_EVIDENCE_KEY;
requireValue(remoteUrl && authorization && account && namespace && image && evidenceKey, 'probe_configuration',
  'Supply an existing isolated probe remote, scoped write authorization, account, namespace, image digest, and durable evidence key.');
const url = new URL(remoteUrl);
requireValue(url.protocol === 'https:' && url.hostname === `${account}.artifacts.cloudflare.net` && url.pathname.startsWith(`/git/${namespace}/`)
  && !url.username && !url.password && !url.search, 'probe_remote', 'The probe remote does not belong to the configured namespace.');
const remote: GitRemote = { authority: 'artifacts', url: url.href, authorization };
const maxPack = Number(process.env.GIT_PROBE_MAX_PACK_BYTES ?? DEFAULT_GIT_LIMITS.max_pack_bytes);
requireValue(Number.isSafeInteger(maxPack) && maxPack > 0 && maxPack <= DEFAULT_GIT_LIMITS.max_repository_bytes / 2, 'probe_limit', 'Invalid pack-size acceptance limit.');
const root = await mkdtemp(join(process.env.GIT_PROBE_TMP ?? tmpdir(), 'gitknot-artifacts-probe-'));
const config = { mode: 'development' as const, cache_root: root, max_sessions: 4, callback_origin: 'https://git.gitknot.com' };
const limits = { ...DEFAULT_GIT_LIMITS, max_pack_bytes: maxPack, max_work_ms: 600_000 };
const works: WorkingRepository[] = [];
const owned = new Set<string>();
const prefix = `gitknot-probe-${crypto.randomUUID().replaceAll('-', '')}`;
const a = `refs/heads/${prefix}-a`;
const b = `refs/heads/${prefix}-b`;
const records: Array<Record<string, unknown>> = [];

try {
  const advertisement = await fetch(`${remote.url}/info/refs?service=git-receive-pack`, { headers: { authorization: authorization! }, redirect: 'error' });
  requireValue(advertisement.ok && advertisement.body, 'probe_advertisement', 'Receive-pack discovery failed.');
  const advertised = Buffer.from(await new Response(limitStream(advertisement.body, 4 * 1024 * 1024)).arrayBuffer()).toString('binary');
  requireValue(/(?:\0| )atomic(?: |\n)/u.test(advertised), 'probe_atomic', 'Artifacts does not advertise atomic push; publication remains disabled.');
  const initial = await working();
  const base = await commit(initial.git, 'base');
  const first = await publication(initial.git, [{ ref: a, old_oid: ZERO_OID, new_oid: base }, { ref: b, old_oid: ZERO_OID, new_oid: base }]);
  requireValue((await publishCanonical(initial.git, first.permit, first.evidence)).outcome === 'committed', 'probe_create', 'The initial atomic publication failed.');
  owned.add(a); owned.add(b);
  const [left, right] = await Promise.all([working(), working()]);
  await Promise.all([refreshRepository(left, remote, config), refreshRepository(right, remote, config)]);
  const one = await commit(left.git, 'one', base);
  const two = await commit(right.git, 'two', base);
  const race = await Promise.all([publication(left.git, [{ ref: a, old_oid: base, new_oid: one }]), publication(right.git, [{ ref: a, old_oid: base, new_oid: two }])]);
  const results = await Promise.all([publishCanonical(left.git, race[0].permit, race[0].evidence), publishCanonical(right.git, race[1].permit, race[1].evidence)]);
  requireValue(results.filter(result => result.outcome === 'committed').length === 1 && results.filter(result => result.outcome === 'rejected').length === 1,
    'probe_race', 'Competing expected-old publications did not produce exactly one winner.');
  const winnerIndex = results[0].outcome === 'committed' ? 0 : 1;
  const winner = winnerIndex === 0 ? left : right;
  const winningOid = winnerIndex === 0 ? one : two;
  const accepted = race[winnerIndex];
  const recovery = await inspectPublication(winner.git, remote, accepted.permit.operation_id, accepted.evidence);
  requireValue(recovery.outcome === 'committed' && recovery.proof === 'marker', 'probe_recovery', 'Canonical marker recovery failed after discarding the publisher receipt.');
  const atomicFailure = await publication(winner.git, [{ ref: a, old_oid: base, new_oid: base }, { ref: b, old_oid: base, new_oid: winningOid }]);
  const failed = await rawAtomic(winner.git, [...atomicFailure.evidence.updates, { ref: transactionRef(atomicFailure.permit.operation_id), old_oid: ZERO_OID, new_oid: atomicFailure.evidence.marker_oid }]);
  requireValue(failed.every(line => line.startsWith('ng ')), 'probe_atomic_failure', 'The server accepted part of a stale atomic transaction.');
  const afterFailure = await remoteRefs(winner.git, remote, [a, b, transactionRef(atomicFailure.permit.operation_id)]);
  requireValue(afterFailure.get(a) === winningOid && afterFailure.get(b) === base && !afterFailure.has(transactionRef(atomicFailure.permit.operation_id)),
    'probe_atomic_failure', 'A failed atomic transaction changed canonical refs.');
  // ABA: return the business ref to its old OID, then replay the old publisher's exact wire commands.
  const back = await publication(winner.git, [{ ref: a, old_oid: winningOid, new_oid: base }]);
  requireValue((await publishCanonical(winner.git, back.permit, back.evidence)).outcome === 'committed', 'probe_aba_setup', 'ABA setup publication failed.');
  const replay = await rawAtomic(winner.git, [...accepted.evidence.updates, { ref: transactionRef(accepted.permit.operation_id), old_oid: ZERO_OID, new_oid: accepted.evidence.marker_oid }]);
  requireValue(replay.every(line => line.startsWith('ng ')) && (await remoteRefs(winner.git, remote, [a])).get(a) === base,
    'probe_stale_publisher', 'An old publisher overwrote a later accepted ref state.');
  const large = await working();
  const largeOid = await largeCommit(large.git, maxPack);
  const largeRef = `refs/heads/${prefix}-large`;
  const largePush = await publication(large.git, [{ ref: largeRef, old_oid: ZERO_OID, new_oid: largeOid }]);
  requireValue((await publishCanonical(large.git, largePush.permit, largePush.evidence)).outcome === 'committed', 'probe_large_pack', 'The configured large-pack transfer was not accepted and verified.');
  owned.add(largeRef);
  records.push({ check: 'advertised_atomic', passed: true }, { check: 'competing_expected_old', results },
    { check: 'server_failed_atomic_unchanged', report_status: failed }, { check: 'receipt_loss_recovery', result: recovery },
    { check: 'old_publisher_wire_replay_after_aba', report_status: replay }, { check: 'large_incompressible_transfer', source_bytes: maxPack });
  const attestation: GitCapabilitiesAttestation = { version: 1, authority: 'artifacts', account_id: account!, namespace: namespace!, native_image: image!,
    tested_at: new Date().toISOString(), expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), atomic: true, conditional: true,
    failed_atomic_unchanged: true, stale_publisher_excluded: true, acceptance_recovery: true, max_pack_bytes: maxPack, evidence_key: evidenceKey! };
  const path = process.env.GIT_PROBE_OUTPUT ?? join(root, 'evidence.json');
  await writeFile(path, JSON.stringify({ attestation, records }, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ attestation, evidence_file: path }) + '\n');
} finally {
  if (works[0] && owned.size) {
    const current = await remoteRefs(works[0].git, remote, [...owned]);
    const updates = [...current].filter(([ref]) => owned.has(ref)).map(([ref, oid]) => ({ ref, old_oid: oid, new_oid: ZERO_OID }));
    if (updates.length) {
      const status = await rawAtomic(works[0].git, updates);
      requireValue(status.every(line => line.startsWith('ok ')) && !(await remoteRefs(works[0].git, remote, [...owned])).size, 'probe_cleanup', 'Probe ref cleanup is not confirmed.');
    }
  }
  await Promise.all(works.map(work => work.cleanup()));
  // Keep the local evidence document for the operator to persist under evidence_key.
}

async function working(): Promise<WorkingRepository> {
  const work = await createWorkingRepository(config, limits, Date.now() + limits.max_work_ms);
  works.push(work); return work;
}

async function commit(git: NativeGit, text: string, parent?: string): Promise<string> {
  const blob = await git.text(['hash-object', '-w', '--stdin'], { input: text });
  const tree = await git.text(['mktree'], { input: `100644 blob ${blob}\tprobe.txt\n` });
  return commitTree(git, tree, text, parent);
}

async function commitTree(git: NativeGit, tree: string, message: string, parent?: string): Promise<string> {
  return git.text(['commit-tree', tree, ...(parent ? ['-p', parent] : [])], { input: `${message}\n`, env: {
    GIT_AUTHOR_NAME: 'GitKnot probe', GIT_AUTHOR_EMAIL: 'git@gitknot.com', GIT_COMMITTER_NAME: 'GitKnot probe', GIT_COMMITTER_EMAIL: 'git@gitknot.com',
  } });
}

async function largeCommit(git: NativeGit, bytes: number): Promise<string> {
  const entries = [];
  for (let remaining = bytes, index = 0; remaining > 0; index++) {
    const size = Math.min(remaining, 16 * 1024 * 1024);
    const oid = await git.text(['hash-object', '-w', '--stdin'], { input: randomBytes(size) });
    entries.push(`100644 blob ${oid}\tblock-${index}\n`); remaining -= size;
  }
  return commitTree(git, await git.text(['mktree'], { input: entries.join('') }), 'large pack probe');
}

async function publication(git: NativeGit, updates: RefUpdate[]): Promise<{ permit: PublicationPermit; evidence: GitEvidence }> {
  const id = `probe_${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
  const marker = await commit(git, JSON.stringify({ operation_id: id, updates }));
  owned.add(transactionRef(id));
  const evidence: GitEvidence = { version: 1, updates: updates.map(update => ({ ...update, policy_ref: update.ref, paths: [], new_commits: [],
    fast_forward: true, object_count: 0, inflated_bytes: 0, lfs_objects: [] })), supplied_objects: 0, supplied_bytes: 0, policy_revision: 1,
    digest: await digestJson(updates), marker_oid: marker };
  return { evidence, permit: { operation_id: id, publisher_id: id, evidence_digest: evidence.digest, marker_oid: marker, remote } };
}

async function rawAtomic(git: NativeGit, updates: RefUpdate[]): Promise<string[]> {
  const tips = updates.map(update => update.new_oid).filter(oid => oid !== ZERO_OID);
  const objects = tips.length ? await git.text(['rev-list', '--objects', '--no-object-names', ...tips], { max_output: limits.max_objects * 41 }) : '';
  const pack = objects ? (await git.run(['pack-objects', '--stdout'], { input: `${objects}\n`, max_output: maxPack + 1024 * 1024 })).stdout : Buffer.alloc(0);
  const commands = updates.map((update, index) => pktLine(`${update.old_oid} ${update.new_oid} ${update.ref}${index === 0 ? '\0report-status atomic' : ''}\n`));
  const response = await fetch(`${remote.url}/git-receive-pack`, { method: 'POST', redirect: 'error', headers: {
    authorization: authorization!, 'content-type': 'application/x-git-receive-pack-request',
  }, body: Buffer.concat([...commands, Buffer.from('0000'), pack]) });
  requireValue(response.ok && response.body, 'probe_protocol', 'The raw atomic Git request failed.');
  const data = Buffer.from(await new Response(limitStream(response.body, 1024 * 1024)).arrayBuffer());
  const lines = [];
  for (let offset = 0; offset + 4 <= data.length;) {
    const length = Number.parseInt(data.subarray(offset, offset + 4).toString('ascii'), 16);
    if (!length) break;
    requireValue(length >= 4 && offset + length <= data.length, 'probe_protocol', 'Invalid native Git report-status.');
    const line = data.subarray(offset + 4, offset + length).toString('utf8').trim();
    if (line.startsWith('ok ') || line.startsWith('ng ')) lines.push(line);
    offset += length;
  }
  requireValue(lines.length === updates.length, 'probe_protocol', 'The server did not report every requested ref.');
  return lines;
}
