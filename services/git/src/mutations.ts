import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import type { BrowserEdit, CandidateContext, GitAuthor, GitMutation, NativeSessionSpec, RefUpdate } from '../../../packages/git/src/types.ts';
import { INTERNAL_REFS, ZERO_OID } from '../../../packages/git/src/types.ts';
import { validateOid, validatePath, validateRef, validateUpdates } from '../../../packages/git/src/policy.ts';
import { GitError, requireValue } from '../../../packages/git/src/errors.ts';
import { NativeGit } from './process.ts';
import { associatedObject, resolveCommit, visibleRefs, readCommit } from './browse.ts';
import { createWorkingRepository, refreshRepository } from './repository.ts';
import type { NativeConfiguration, WorkingRepository } from './repository.ts';
import { remoteConfiguration } from './remote.ts';
import { inspectCollaboration } from './inspection.ts';
import { reviewRefs } from '../../../packages/git/src/protocol.ts';

export async function runMutation(stage: WorkingRepository, spec: NativeSessionSpec, mutation: GitMutation, hooks: string, config: NativeConfiguration): Promise<{ candidate_oid?: string }> {
  requireValue(mutation.kind === spec.kind, 'mutation_kind', 'Mutation does not match its publication operation.');
  const producer = await createWorkingRepository(config, spec.policy.limits, stage.git.deadline);
  try {
    let updates: RefUpdate[];
    let candidateOid: string | undefined;
    if (mutation.kind === 'import' || mutation.kind === 'fork') {
      requireValue((await visibleRefs(stage.git)).length === 0, 'import_not_empty', 'Imports and forks require an empty target repository.', 409);
      await refreshRepository(producer, mutation.source, config, spec.repository.default_branch);
      updates = (await visibleRefs(producer.git)).map(ref => ({ ref: ref.ref, old_oid: ZERO_OID, new_oid: ref.oid }));
      requireValue(updates.length > 0, 'empty_source', 'The source repository has no refs to import.');
    } else {
      await refreshRepository(producer, spec.remote, config, spec.repository.default_branch);
      if (mutation.kind === 'retain') {
        const response = await inspectCollaboration(producer.git, spec.repository.id, { source: mutation.source,
          inspection: { kind: 'patch', head_repo_id: mutation.review.source_repo_id, base_oid: mutation.review.base_oid, head_oid: mutation.review.head_oid } }, config.local_authority_root);
        const inspection = await response.json() as { native_evidence_id: string; merge_base_oid: string };
        requireValue(inspection.native_evidence_id === mutation.review.id, 'review_evidence_mismatch', 'Retained review evidence changed its identity.');
        await writeFile(join(stage.path, 'gitknot-review.json'), JSON.stringify(inspection), { mode: 0o600 });
        const refs = reviewRefs(mutation.review.id);
        updates = [mutation.review.base_oid, mutation.review.head_oid, inspection.merge_base_oid].map((oid, index) => ({ ref: refs[index], old_oid: ZERO_OID, new_oid: oid }));
      } else if (mutation.kind === 'edit') {
        validateRef(mutation.ref);
        validateOid(mutation.expected_oid);
        const base = mutation.expected_oid === ZERO_OID ? ZERO_OID : await resolveCommit(producer.git, mutation.ref);
        if (base === ZERO_OID) requireValue(!(await visibleRefs(producer.git)).some(ref => ref.ref === mutation.ref), 'stale_ref', 'The branch already exists.', 412);
        requireValue(base === mutation.expected_oid, 'stale_ref', 'This branch changed before the edit was applied.', 412);
        const oid = await editCommit(producer.git, base, mutation.edits, mutation.message, mutation.author, config);
        updates = [{ ref: mutation.ref, old_oid: base, new_oid: oid }];
      } else if (mutation.kind === 'refs') {
        updates = mutation.updates;
        for (const update of updates) if (update.new_oid !== ZERO_OID) await associatedObject(producer.git, update.new_oid);
      } else if (mutation.kind === 'restack') {
        validateRef(mutation.ref);
        for (const oid of [mutation.expected_oid, mutation.old_base_oid, mutation.onto_oid]) validateOid(oid, false);
        requireValue(await resolveCommit(producer.git, mutation.ref) === mutation.expected_oid, 'stale_ref', 'The source branch changed before restacking.', 409);
        if (mutation.source) {
          const env = await remoteConfiguration(mutation.source, producer.git.development, config.local_authority_root);
          await producer.git.run(['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', mutation.source.url,
            '+refs/heads/*:refs/gitknot/source/heads/*', '+refs/tags/*:refs/gitknot/source/tags/*'], { env });
          await proveSourceHead(producer.git, mutation.onto_oid);
        } else await associatedObject(producer.git, mutation.onto_oid);
        const ancestor = await producer.git.run(['merge-base', '--is-ancestor', mutation.old_base_oid, mutation.expected_oid], { allow_failure: true });
        requireValue(ancestor.code === 0, 'restack_base', 'The saved patch base is not an ancestor of the source head.', 409);
        const commits = (await producer.git.text(['rev-list', '--reverse', '--topo-order', `${mutation.old_base_oid}..${mutation.expected_oid}`], { max_output: producer.git.limits.max_commits * 41 })).split('\n').filter(Boolean);
        const next = await replayCommits(producer.git, commits, mutation.onto_oid, config);
        updates = [{ ref: mutation.ref, old_oid: mutation.expected_oid, new_oid: next }];
      } else if (mutation.kind === 'candidate') {
        if (mutation.source) {
          const env = await remoteConfiguration(mutation.source, producer.git.development, config.local_authority_root);
          await producer.git.run(['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', mutation.source.url,
            '+refs/heads/*:refs/gitknot/source/heads/*', '+refs/tags/*:refs/gitknot/source/tags/*'], { env });
          await proveSourceHead(producer.git, mutation.candidate.source_oid);
        } else await associatedObject(producer.git, mutation.candidate.source_oid);
        candidateOid = await createCandidate(producer.git, mutation.candidate, mutation.author, mutation.message, config);
        updates = [{ ref: `${INTERNAL_REFS}candidates/${mutation.candidate.id}`, old_oid: ZERO_OID, new_oid: candidateOid }];
      } else {
        requireValue(mutation.kind === 'merge', 'mutation_kind', 'Unsupported Git mutation.');
        const candidateRef = `${INTERNAL_REFS}candidates/${mutation.candidate.id}`;
        const actual = await producer.git.text(['rev-parse', '--verify', '--end-of-options', candidateRef]);
        requireValue(actual === mutation.candidate_oid, 'candidate_changed', 'The merge candidate changed or is no longer retained.', 409);
        updates = [{ ref: mutation.candidate.target_ref, old_oid: mutation.candidate.target_oid, new_oid: actual }];
      }
    }
    validateUpdates(updates, spec.policy.limits.max_refs, mutation.kind === 'candidate' || mutation.kind === 'retain');
    const args = ['push', '--porcelain', '--atomic', '--no-follow-tags',
      ...updates.map(update => `--force-with-lease=${update.ref}:${update.old_oid === ZERO_OID ? '' : update.old_oid}`),
      pathToFileURL(stage.path).href,
      ...updates.map(update => `${update.new_oid === ZERO_OID ? '' : update.new_oid}:${update.ref}`),
    ];
    // Local transport is only between disposable producer/quarantine repositories. The receive
    // hooks own the remote canonical push. Passing the trusted hooks path also prevents Git's
    // inherited -c configuration from disabling hooks in its child receive-pack process.
    const result = await producer.git.run(args, { hooks, config: ['protocol.file.allow=always'], allow_failure: true });
    if (result.code !== 0) throw new GitError('publication_rejected', 'The Git publication was rejected. Inspect its operation for details.', 409, { cause: result.stderr.toString().slice(0, 4096) });
    return { ...(candidateOid ? { candidate_oid: candidateOid } : {}) };
  } finally { await producer.cleanup(); }
}

async function editCommit(git: NativeGit, base: string, edits: BrowserEdit[], message: string, author: GitAuthor, config: NativeConfiguration): Promise<string> {
  requireValue(edits.length > 0 && edits.length <= 1000, 'edit_limit', 'A browser edit must contain between 1 and 1000 file changes.');
  const index = git.withEnvironment({ GIT_INDEX_FILE: join(git.directory, 'gitknot-edit-index') });
  await index.run(base === ZERO_OID ? ['read-tree', '--empty'] : ['read-tree', base]);
  const paths = new Set<string>();
  let bytes = 0;
  for (const edit of edits) {
    validatePath(edit.path);
    requireValue(!paths.has(edit.path), 'duplicate_path', 'A browser edit may change each path only once.');
    paths.add(edit.path);
    if (edit.delete) {
      requireValue(edit.content_base64 === undefined, 'invalid_edit', 'A deleted file cannot also have contents.');
      // Index-only removal works in the bare producer and keeps the path literal.
      await index.run(['update-index', '-z', '--index-info'], { input: `0 ${ZERO_OID}\t${edit.path}\0` });
      continue;
    }
    requireValue(typeof edit.content_base64 === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(edit.content_base64), 'invalid_edit', 'File contents must be canonical base64.');
    const content = Buffer.from(edit.content_base64, 'base64');
    bytes += content.length;
    requireValue(content.length <= git.limits.max_blob_bytes && bytes <= git.limits.max_metadata_bytes, 'edit_limit', 'Browser edits exceed the configured byte limit.', 413);
    const oid = await index.text(['hash-object', '-w', '--stdin'], { input: content });
    requireValue(edit.mode === undefined || ['100644', '100755'].includes(edit.mode), 'invalid_file_mode', 'Browser edits support regular and executable files.');
    await index.run(['update-index', '--add', '--cacheinfo', edit.mode ?? '100644', oid, edit.path]);
  }
  const tree = await index.text(['write-tree']);
  return createCommit(git, tree, base === ZERO_OID ? [] : [base], author, message, config);
}

async function createCandidate(git: NativeGit, candidate: CandidateContext, author: GitAuthor, message: string, config: NativeConfiguration): Promise<string> {
  validateRef(candidate.target_ref);
  validateOid(candidate.target_oid, false);
  validateOid(candidate.source_oid, false);
  const target = await resolveCommit(git, candidate.target_ref);
  requireValue(target === candidate.target_oid, 'stale_base', 'The target branch changed; rebuild the merge candidate.', 409);
  if (candidate.strategy === 'ff-only') {
    const ancestry = await git.run(['merge-base', '--is-ancestor', target, candidate.source_oid], { allow_failure: true });
    requireValue(ancestry.code === 0, 'merge_not_fast_forward', 'This merge is not a fast-forward.', 409);
    return candidate.source_oid;
  }
  if (candidate.strategy === 'rebase') return rebaseCandidate(git, candidate, config);
  requireValue(candidate.strategy === 'merge' || candidate.strategy === 'squash', 'merge_strategy', 'Unsupported merge strategy.');
  const tree = await mergeTree(git, target, candidate.source_oid);
  return createCommit(git, tree, candidate.strategy === 'merge' ? [target, candidate.source_oid] : [target], author, message, config);
}

async function mergeTree(git: NativeGit, target: string, source: string, base?: string): Promise<string> {
  const result = await git.run(['merge-tree', '--write-tree', ...(base ? [`--merge-base=${base}`] : []), target, source], { allow_failure: true });
  requireValue(result.code === 0, 'merge_conflict', 'The proposed merge has conflicts that must be resolved.', 409);
  const tree = result.stdout.toString().split('\n')[0];
  validateOid(tree, false);
  return tree;
}

async function rebaseCandidate(git: NativeGit, candidate: CandidateContext, config: NativeConfiguration): Promise<string> {
  const list = await git.text(['rev-list', '--reverse', '--topo-order', `${candidate.target_oid}..${candidate.source_oid}`], { max_output: git.limits.max_commits * 41 });
  const commits = list.split('\n').filter(Boolean);
  requireValue(commits.length <= git.limits.max_commits, 'history_limit', 'Rebase exceeds the configured history limit.');
  return replayCommits(git, commits, candidate.target_oid, config);
}

async function replayCommits(git: NativeGit, commits: string[], base: string, config: NativeConfiguration): Promise<string> {
  let onto = base;
  for (const oid of commits) {
    const commit = await readCommit(git, oid);
    const parents = commit.parents as string[];
    requireValue(parents.length === 1, 'rebase_non_linear', 'Rebase candidates require single-parent source commits. Choose merge or squash for non-linear history.', 409);
    const tree = await mergeTree(git, onto, oid, parents[0]);
    const author = commit.author as { name: string; email: string };
    onto = await createCommit(git, tree, [onto], author, commit.message as string, config);
  }
  return onto;
}

async function createCommit(git: NativeGit, tree: string, parents: string[], author: GitAuthor, message: string, config: NativeConfiguration): Promise<string> {
  requireValue(author.name.length <= 200 && author.email.length <= 320 && !/[\r\n\0<>]/u.test(author.name + author.email), 'invalid_author', 'Invalid commit author.');
  requireValue(message.trim().length > 0 && Buffer.byteLength(message) <= 64 * 1024 && !message.includes('\0'), 'invalid_message', 'Invalid commit message.');
  const args = ['commit-tree', tree, ...parents.flatMap(parent => ['-p', parent])];
  const signing: string[] = [];
  if (config.signing_key) {
    args.push('-S');
    signing.push(`user.signingKey=${config.signing_key}`, `gpg.format=${config.signing_format ?? 'ssh'}`);
  }
  return git.text(args, { input: message.endsWith('\n') ? message : `${message}\n`, config: signing, env: {
    GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: 'GitKnot', GIT_COMMITTER_EMAIL: 'git@gitknot.com',
  } });
}

async function proveSourceHead(git: NativeGit, oid: string): Promise<void> {
  validateOid(oid, false);
  const refs = await git.text(['for-each-ref', '--format=%(objectname)', 'refs/gitknot/source/']);
  requireValue(refs.length > 0, 'source_not_found', 'Source repository has no visible refs.', 404);
  const history = await git.text(['rev-list', '--stdin'], { input: `${refs}\n`, max_output: git.limits.max_objects * 41 });
  requireValue(history.split('\n').includes(oid), 'source_not_found', 'Source commit is not reachable from the source repository.', 404);
}
