import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { NativeGit } from './process.ts';
import { remoteConfiguration } from './remote.ts';
import type { GitLimits, GitRemote, NativeSessionSpec } from '../../../packages/git/src/types.ts';
import { INTERNAL_REFS } from '../../../packages/git/src/types.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';
import { nativeHookPath } from './hook-path.ts';

export interface NativeConfiguration {
  mode: 'production' | 'development' | 'test';
  cache_root: string;
  local_authority_root?: string;
  max_sessions: number;
  callback_origin: string;
  signing_key?: string;
  signing_format?: 'ssh' | 'openpgp';
  /** Explicit local TLS test trust; rejected by the production entry point. */
  test_https_ca_file?: string;
}

export interface WorkingRepository { path: string; git: NativeGit; cleanup(): Promise<void> }

export async function createWorkingRepository(config: NativeConfiguration, limits: GitLimits, deadline: number): Promise<WorkingRepository> {
  requireValue(config.mode !== 'production' || process.platform === 'linux', 'native_platform', 'The production Git service requires Linux.', 503);
  await mkdir(config.cache_root, { recursive: true, mode: 0o700 });
  const path = await mkdtemp(join(config.cache_root, 'gitknot-'));
  await chmod(path, 0o700);
  requireValue(!config.test_https_ca_file || config.mode === 'test', 'native_configuration', 'Test TLS trust is available only in explicit test mode.', 503);
  const ca = config.test_https_ca_file ?? (process.env.GIT_EGRESS_INTERCEPTED === '1' ? '/etc/cloudflare/certs/cloudflare-containers-ca.crt' : undefined);
  const git = new NativeGit(path, limits, deadline, config.mode !== 'production', ca ? { GIT_SSL_CAINFO: ca } : {});
  try {
    await git.run(['init', '--bare', '--template=', '--object-format=sha1', '--initial-branch=main', '.']);
    return { path, git, cleanup: () => rm(path, { recursive: true, force: true }) };
  } catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
}

export async function refreshRepository(work: WorkingRepository, remote: GitRemote, config: NativeConfiguration, defaultBranch = 'main'): Promise<void> {
  const environment = await remoteConfiguration(remote, config.mode !== 'production', config.local_authority_root);
  await work.git.run(['fetch', '--no-tags', '--no-recurse-submodules', '--prune', '--no-write-fetch-head', remote.url, '+refs/*:refs/*'], { env: environment });
  await work.git.run(['symbolic-ref', 'HEAD', `refs/heads/${defaultBranch}`]);
  await enforceDiskLimit(work.path, work.git.limits.max_repository_bytes);
}

/** Git v2 accepts arbitrary existing OIDs: hideRefs alone is not an object confidentiality boundary. */
export async function authorizedReadView(source: WorkingRepository, spec: NativeSessionSpec, config: NativeConfiguration): Promise<WorkingRepository> {
  const raw = await source.git.text(['for-each-ref', '--format=%(refname)%09%(objectname)'], { max_output: spec.policy.limits.max_metadata_bytes });
  const refs = raw.split('\n').filter(Boolean).map(line => {
    const [ref, oid] = line.split('\t'); return { ref, oid };
  }).filter(entry => spec.candidate_read_ref ? entry.ref === spec.candidate_read_ref
    : !entry.ref.startsWith(INTERNAL_REFS) || spec.retained_refs?.includes(entry.ref));
  requireValue(!spec.candidate_read_ref || refs.length === 1, 'candidate_not_found', 'Retained merge candidate not found.', 404);
  const view = await createWorkingRepository(config, source.git.limits, source.git.deadline);
  try {
    if (refs.length) {
      // No alternates, hardlinks, checkout, or reuse of a delta against a hidden object.
      const pack = source.git.stream(['pack-objects', '--stdout', '--revs', '--no-reuse-delta', '--no-reuse-object'], {
        input: `${[...new Set(refs.map(ref => ref.oid))].join('\n')}\n`, max_output: source.git.limits.max_repository_bytes,
      });
      try {
        await view.git.run(['index-pack', '--stdin', '--strict', `--max-input-size=${source.git.limits.max_repository_bytes}`], { input: pack.output });
        requireValue((await pack.completion).code === 0, 'read_view_failed', 'The authorized repository snapshot could not be constructed.', 503);
      } finally { pack.stop(); }
      const updates = refs.map(entry => `create ${spec.candidate_read_ref ? 'refs/heads/gitknot-candidate' : entry.ref} ${entry.oid}\n`).join('');
      await view.git.run(['update-ref', '--stdin'], { input: `start\n${updates}prepare\ncommit\n` });
    }
    await view.git.run(['symbolic-ref', 'HEAD', spec.candidate_read_ref ? 'refs/heads/gitknot-candidate' : `refs/heads/${spec.repository.default_branch}`]);
    return view;
  } catch (error) { await view.cleanup(); throw error; }
}

export async function installReceiveHooks(work: WorkingRepository, spec: NativeSessionSpec, hookUrl: string, hookToken: string): Promise<string> {
  const hooks = join(work.path, 'gitknot-hooks');
  await mkdir(hooks, { mode: 0o700 });
  const entry = await nativeHookPath();
  requireValue(!/[\r\n'\\]/u.test(entry) && !/[\r\n'\\]/u.test(process.execPath), 'native_configuration', 'Invalid native executable path.', 503);
  for (const name of ['pre-receive', 'proc-receive']) {
    const path = join(hooks, name);
    await writeFile(path, `#!/bin/sh\nexec '${process.execPath}' --max-old-space-size=256 --experimental-strip-types '${entry}' '${name}'\n`, { mode: 0o700 });
  }
  const manifest = {
    repository: spec.repository, policy: spec.policy, operation_id: spec.operation_id,
    publisher_id: spec.publisher_id, actor_id: spec.actor_id, kind: spec.kind,
    candidate: spec.candidate, restore: spec.restore, review: spec.review, hook_url: hookUrl, hook_token: hookToken,
    deadline: work.git.deadline, development: work.git.development,
  };
  await writeFile(join(work.path, 'gitknot-session.json'), JSON.stringify(manifest), { mode: 0o600 });
  const options = [
    ['core.hooksPath', hooks], ['receive.procReceiveRefs', 'refs/'], ['receive.advertiseAtomic', 'true'],
    ['receive.advertisePushOptions', 'false'], ['receive.fsckObjects', 'true'], ['receive.unpackLimit', '0'],
    ['receive.maxInputSize', String(spec.policy.limits.max_pack_bytes)], ['receive.denyDeletes', 'false'],
    ['receive.denyNonFastForwards', 'false'], ['receive.denyCurrentBranch', 'ignore'],
  ];
  for (const [key, value] of options) await work.git.run(['config', '--local', key, value]);
  return hooks;
}

export function readConfiguration(candidateRef?: string): string[] {
  const config = [
    `transfer.hideRefs=${INTERNAL_REFS}`, `uploadpack.hideRefs=${INTERNAL_REFS}`,
    'uploadpack.allowAnySHA1InWant=false', 'uploadpack.allowTipSHA1InWant=false',
    'uploadpack.allowReachableSHA1InWant=false', 'uploadpack.allowFilter=false',
  ];
  if (candidateRef) config.push(`transfer.hideRefs=!${candidateRef}`, `uploadpack.hideRefs=!${candidateRef}`);
  return config;
}

export async function enforceDiskLimit(path: string, limit: number): Promise<number> {
  let total = 0;
  const pending = [resolve(path)];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile()) total += (await stat(child)).size;
      requireValue(total <= limit, 'repository_size_limit', 'Repository processing exceeds the disk quota.', 413);
    }
  }
  return total;
}
