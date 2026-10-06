import { readFile, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import type { GitEvidence, GitPolicy, GitRule, NativeSessionSpec, RefEvidence, RefUpdate } from '../../../packages/git/src/types.ts';
import { INTERNAL_REFS, ZERO_OID } from '../../../packages/git/src/types.ts';
import { checkPaths, matchGitPattern, rulesForRef, validateUpdates } from '../../../packages/git/src/policy.ts';
import { digestJson, reviewRefs } from '../../../packages/git/src/protocol.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';
import { NativeGit } from './process.ts';
import { objectInfo, ObjectReader, reachableObjects, suppliedObjects, totalObjectBytes } from './objects.ts';
import type { ObjectInfo } from './objects.ts';
import { SignatureVerifier } from './signatures.ts';
import { markerObjectBytes, storageEvidence } from './storage-evidence.ts';
import { lfsPointer } from './lfs-pointer.ts';

export interface HookManifest extends Pick<NativeSessionSpec, 'repository' | 'policy' | 'operation_id' | 'publisher_id' | 'actor_id' | 'kind' | 'candidate' | 'restore' | 'review'> {
  hook_url: string;
  hook_token: string;
  deadline: number;
  development: boolean;
}

const secretDetectors = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/u,
  /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{60,255}\b/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
];

export async function readHookManifest(directory: string): Promise<HookManifest> {
  return JSON.parse(await readFile(join(directory, 'gitknot-session.json'), 'utf8')) as HookManifest;
}

export async function validateReceive(git: NativeGit, manifest: HookManifest, updates: RefUpdate[]): Promise<GitEvidence> {
  validateUpdates(updates, git.limits.max_refs, ['candidate', 'restore', 'retain'].includes(manifest.kind!));
  let review: Record<string, unknown> | undefined;
  if (manifest.kind === 'retain') {
    requireValue(manifest.review, 'review_context', 'A retained review requires its scoped revision context.');
    review = JSON.parse(await readFile(join(git.directory, 'gitknot-review.json'), 'utf8')) as Record<string, unknown>;
    const refs = reviewRefs(manifest.review.id);
    const oids = [manifest.review.base_oid, manifest.review.head_oid, review.merge_base_oid];
    requireValue(review.native_evidence_id === manifest.review.id && review.repo_id === manifest.repository.id
      && review.head_repo_id === manifest.review.source_repo_id && updates.length === 3
      && updates.every(update => update.old_oid === ZERO_OID && refs.some((ref, index) => ref === update.ref && oids[index] === update.new_oid)),
    'review_ref_scope', 'Retained review refs do not match their verified inspection.');
  }
  if (manifest.kind === 'restore') {
    const expected = manifest.restore?.expected_refs;
    requireValue(expected && updates.length === expected.length && updates.every(update => update.old_oid === ZERO_OID
      && expected.some(ref => ref.ref === update.ref && ref.oid === update.new_oid)), 'restore_refs', 'Restore ref commands differ from the verified archive.');
  }
  const supplied = await objectInfo(git, await suppliedObjects(git, process.env.GIT_QUARANTINE_PATH));
  const suppliedBytes = totalObjectBytes(supplied, git.limits.max_inflated_bytes);
  const verifier = new SignatureVerifier(git, manifest.policy.signatures);
  const reader = new ObjectReader(git);
  const evidence: RefEvidence[] = [];
  const storageRules = manifest.policy.rules.filter(rule => rule.files?.inspect_all_supplied_objects);
  try {
    // All supplied objects get structural/size checks, even when no ref makes them reachable.
    await inspectObjects(git, reader, verifier, supplied, storageRules, true);
    for (const update of updates) {
      const policyRef = policyRefFor(manifest, update);
      const rules = rulesForRef(manifest.policy.rules, policyRef).filter(rule => !manifest.policy.bypasses?.some(bypass =>
        rule.id && bypass.rule_ids.includes(rule.id) && bypass.expires_at > new Date().toISOString()
        && bypass.refs.some(pattern => matchGitPattern(pattern, policyRef))));
      evidence.push(await inspectRef(git, reader, verifier, update, policyRef, rules, manifest));
    }
  } finally { await reader.close().catch(error => { reader.abort(); throw error; }); }
  const body = {
    version: 1 as const, updates: evidence, supplied_objects: supplied.size,
    supplied_bytes: suppliedBytes, policy_revision: manifest.policy.revision, policy_digest: manifest.policy.digest,
    storage: await storageEvidence(git, updates),
    ...(review ? { review } : {}),
  };
  requireValue(Buffer.byteLength(JSON.stringify(body)) <= git.limits.max_metadata_bytes - 1024, 'evidence_limit', 'Git validation evidence exceeds its limit.', 413);
  const digest = await digestJson(body);
  const marker = await makeMarker(git, manifest, updates, digest);
  const result: GitEvidence = { ...body, digest, marker_oid: marker, marker_object_bytes: await markerObjectBytes(git, marker) };
  await writeFile(join(git.directory, 'gitknot-evidence.json'), JSON.stringify(result), { mode: 0o600 });
  return result;
}

function policyRefFor(manifest: HookManifest, update: RefUpdate): string {
  if (manifest.kind !== 'candidate') return update.ref;
  requireValue(manifest.candidate && update.ref === `${INTERNAL_REFS}candidates/${manifest.candidate.id}`
    && update.old_oid === ZERO_OID, 'candidate_ref', 'Invalid merge-candidate ref update.');
  return manifest.candidate.target_ref;
}

async function inspectRef(git: NativeGit, reader: ObjectReader, verifier: SignatureVerifier, update: RefUpdate, policyRef: string, rules: GitRule[], manifest: HookManifest): Promise<RefEvidence> {
  const current = await git.run(['show-ref', '--verify', '--hash', update.ref], { allow_failure: true });
  const currentOid = current.code === 0 ? current.stdout.toString().trim() : ZERO_OID;
  requireValue(currentOid === update.old_oid, 'stale_ref', 'A ref changed since the client last fetched it.', 409);
  const create = update.old_oid === ZERO_OID;
  const remove = update.new_oid === ZERO_OID;
  for (const rule of rules) {
    requireValue(rule.updates !== 'blocked', 'ref_blocked', 'Repository policy blocks updates to this ref.');
    requireValue(!create || manifest.kind === 'candidate' || rule.history?.allow_creation !== false, 'creation_denied', 'Repository policy does not allow this ref to be created.');
    requireValue(!remove || rule.history?.allow_deletion !== false, 'deletion_denied', 'Repository policy does not allow this ref to be deleted.');
  }
  const empty: RefEvidence = { ...update, policy_ref: policyRef, paths: [], new_commits: [], fast_forward: false, object_count: 0, inflated_bytes: 0, lfs_objects: [] };
  if (remove) {
    empty.pathless = await git.text(['cat-file', '-t', `${update.old_oid}^{}`]) === 'blob';
    requireValue(!empty.pathless || rules.every(rule => !rule.files?.allowed_paths && !rule.files?.denied_paths), 'pathless_object', 'A path-scoped rule cannot authorize this object ref.');
    // Deletion changes every path in the removed tree, and must obey scoped-write grants.
    empty.paths = await treePaths(git, update.old_oid);
    checkPaths(rules, empty.paths);
    return empty;
  }
  const previous = manifest.kind === 'candidate' ? manifest.candidate?.target_oid : create ? undefined : update.old_oid;
  const objects = await reachableObjects(git, update.new_oid, previous);
  const tip = objects.get(update.new_oid)!;
  empty.pathless = await git.text(['cat-file', '-t', `${update.new_oid}^{}`]) === 'blob';
  requireValue(!update.ref.startsWith('refs/heads/') || tip.type === 'commit', 'branch_object', 'Branches must point directly to commits.');
  if (update.ref.startsWith('refs/tags/') && rules.some(rule => rule.signatures?.annotated_tags || rule.signatures?.tags)) {
    requireValue(tip.type === 'tag', 'annotated_tag_required', 'Repository policy requires an annotated, verified tag.');
  }
  let fastForward = create;
  if (!create) {
    const ancestry = await git.run(['merge-base', '--is-ancestor', `${update.old_oid}^{commit}`, `${update.new_oid}^{commit}`], { allow_failure: true });
    fastForward = ancestry.code === 0;
    // Repointing a tag is a force update even when its peeled commits are ancestral.
    if (update.ref.startsWith('refs/tags/')) fastForward = false;
    requireValue(fastForward || rules.every(rule => rule.history?.allow_force_push !== false), 'force_push_denied', 'Repository policy requires a fast-forward update.');
  }
  const commits = [...objects.values()].filter(info => info.type === 'commit').map(info => info.oid);
  requireValue(commits.length <= git.limits.max_commits, 'history_limit', 'This update introduces too many commits.', 413);
  const paths = new Set<string>();
  for (const oid of commits) {
    const changed = await git.run(['diff-tree', '--root', '-m', '--no-commit-id', '--no-renames', '--no-ext-diff', '--no-textconv', '--name-only', '-r', '-z', oid], { max_output: git.limits.max_metadata_bytes });
    addPaths(paths, changed.stdout, git.limits.max_paths);
    if (rules.some(rule => rule.history?.linear)) {
      const parents = await git.text(['rev-list', '--parents', '--max-count=1', oid]);
      requireValue(parents.split(' ').length <= 2, 'linear_history_required', 'Repository policy does not allow merge commits on this ref.');
    }
  }
  if (!create) {
    const delta = await git.run(['diff-tree', '--no-commit-id', '--no-renames', '--no-ext-diff', '--no-textconv', '--name-only', '-r', '-z', update.old_oid, update.new_oid], { allow_failure: true });
    // Tags may point to blobs. Path-scoped rules cannot authorize an unpathed object.
    requireValue(delta.code === 0 || rules.every(rule => !rule.files?.allowed_paths && !rule.files?.denied_paths), 'pathless_object', 'A path-scoped rule cannot authorize this object ref.');
    if (delta.code === 0) addPaths(paths, delta.stdout, git.limits.max_paths);
  }
  if (!commits.length && (tip.type === 'tree' || tip.type === 'tag')) {
    for (const path of await treePaths(git, update.new_oid)) paths.add(path);
  }
  requireValue(!empty.pathless || rules.every(rule => !rule.files?.allowed_paths && !rule.files?.denied_paths), 'pathless_object', 'A path-scoped rule cannot authorize this object ref.');
  checkPaths(rules, [...paths]);
  const lfs = await inspectObjects(git, reader, verifier, objects, rules, false);
  return { ...empty, paths: [...paths].sort(), new_commits: commits, fast_forward: fastForward,
    object_count: objects.size, inflated_bytes: totalObjectBytes(objects, git.limits.max_inflated_bytes), lfs_objects: lfs };
}

function addPaths(paths: Set<string>, bytes: Buffer, max: number): void {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const value = decoder.decode(bytes);
  for (const path of value.split('\0').filter(Boolean)) {
    requireValue(!/[\x00-\x1f\x7f]/u.test(path), 'unsupported_path', 'Repository policy requires UTF-8 paths without control characters.');
    paths.add(path);
    requireValue(paths.size <= max, 'path_limit', 'This update changes too many paths.', 413);
  }
}

async function treePaths(git: NativeGit, oid: string): Promise<string[]> {
  const tree = await git.run(['ls-tree', '-r', '-z', '--name-only', oid], { allow_failure: true });
  if (tree.code !== 0) return [];
  const paths = new Set<string>();
  addPaths(paths, tree.stdout, git.limits.max_paths);
  return [...paths];
}

async function inspectObjects(git: NativeGit, reader: ObjectReader, verifier: SignatureVerifier, objects: Map<string, ObjectInfo>, rules: GitRule[], supplied: boolean): Promise<Array<{ oid: string; size: number }>> {
  totalObjectBytes(objects, git.limits.max_inflated_bytes);
  const lfs = new Map<string, number>();
  let treeEntries = 0;
  const maxFile = Math.min(git.limits.max_blob_bytes, ...rules.map(rule => rule.files?.max_bytes ?? git.limits.max_blob_bytes));
  for (const info of objects.values()) {
    requireValue(info.size <= (info.type === 'blob' ? maxFile : git.limits.max_blob_bytes), 'file_size_limit', 'A Git object exceeds the repository file-size policy.', 413);
    const raw = await reader.read(info);
    if (rules.some(rule => rule.files?.block_secrets)) {
      const text = raw.toString();
      requireValue(!secretDetectors.some(detector => detector.test(text)), 'secret_detected', 'A supplied Git object contains a blocked credential or private key. Remove it from every introduced commit.');
    }
    for (const rule of rules) {
      requireValue(!rule.files?.secret_literals?.some(secret => raw.includes(Buffer.from(secret))), 'secret_detected', 'A supplied Git object matches a repository secret-blocking rule.');
    }
    if ((info.type === 'commit' && rules.some(rule => rule.signatures?.commits))
      || (info.type === 'tag' && rules.some(rule => rule.signatures?.tags))) await verifier.verify(info, raw);
    if (info.type === 'tree') {
      // Native ls-tree validates names, modes and nested entries, including unreferenced supplied trees.
      const entries = await git.run(['ls-tree', '-r', '-t', '-z', info.oid], { max_output: git.limits.max_metadata_bytes });
      const paths: string[] = [];
      for (const entry of new TextDecoder('utf-8', { fatal: true }).decode(entries.stdout).split('\0').filter(Boolean)) {
        treeEntries++;
        requireValue(treeEntries <= git.limits.max_tree_entries, 'tree_limit', 'Git tree traversal exceeded its work limit.', 413);
        const tab = entry.indexOf('\t');
        requireValue(tab !== -1 && !/[\x00-\x1f\x7f]/u.test(entry.slice(tab + 1)), 'invalid_tree', 'A Git tree contains an unsupported path.');
        paths.push(entry.slice(tab + 1));
      }
      if (supplied) checkPaths(rules, paths);
    }
    const pointer = info.type === 'blob' ? lfsPointer(raw) : null;
    if (pointer) {
      const { oid, size } = pointer;
      requireValue(size <= git.limits.lfs_object_bytes, 'file_size_limit', 'An LFS object exceeds its byte limit.', 413);
      requireValue(rules.every(rule => rule.files?.max_bytes === undefined || size <= rule.files.max_bytes), 'file_size_limit', 'An LFS file exceeds the repository file-size policy.', 413);
      requireValue(!lfs.has(oid) || lfs.get(oid) === size, 'invalid_lfs_pointer', 'Git LFS pointers disagree on object size.');
      lfs.set(oid, size);
    }
  }
  return [...lfs].map(([oid, size]) => ({ oid, size }));
}

async function makeMarker(git: NativeGit, manifest: HookManifest, updates: RefUpdate[], digest: string): Promise<string> {
  const contents = JSON.stringify({ version: 1, repo_id: manifest.repository.id, operation_id: manifest.operation_id,
    publisher_id: manifest.publisher_id, actor_id: manifest.actor_id, updates, evidence_digest: digest });
  const blob = await git.text(['hash-object', '-w', '--stdin'], { input: contents });
  const tree = await git.text(['mktree'], { input: `100644 blob ${blob}\tpublication.json\n` });
  return git.text(['commit-tree', tree], { input: `GitKnot publication ${manifest.operation_id}\n`, env: {
    GIT_AUTHOR_NAME: 'GitKnot', GIT_AUTHOR_EMAIL: 'git@gitknot.com', GIT_COMMITTER_NAME: 'GitKnot', GIT_COMMITTER_EMAIL: 'git@gitknot.com',
  } });
}
