import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { command, offlineEnvironment } from '../process.ts';
import { ROOT } from '../environment.ts';
import type { Fixture } from './scenarios.ts';

export interface GitLoadClient { perform(sequence: number): Promise<{ status: number; expected: boolean; bytes: number }>; close(): Promise<void> }

export async function gitLoadClient(fixture: Fixture, token: string | undefined, worker: number): Promise<GitLoadClient> {
  const directory = await mkdtemp(join(ROOT, '.gitknot', `load-git-${worker}-`));
  const remote = new URL(fixture.git_remote!);
  const env = offlineEnvironment({
    GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'GitKnot capacity fixture', GIT_AUTHOR_EMAIL: 'load@gitknot.invalid',
    GIT_COMMITTER_NAME: 'GitKnot capacity fixture', GIT_COMMITTER_EMAIL: 'load@gitknot.invalid',
    GIT_CONFIG_COUNT: token ? '2' : '1', GIT_CONFIG_KEY_0: 'http.followRedirects', GIT_CONFIG_VALUE_0: 'false',
    ...(token ? { GIT_CONFIG_KEY_1: `http.${remote.origin}/.extraHeader`, GIT_CONFIG_VALUE_1: `Authorization: Basic ${Buffer.from(`gitknot:${token}`).toString('base64')}` } : {}),
  });
  const git = (args: string[], input?: string) => command('git', args, { cwd: directory, env, input, capture: true, timeout: 180_000 });
  try {
    await git(['init', '--bare', '.']);
    await git(['remote', 'add', 'origin', remote.href]);
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return {
    async perform(sequence) {
      const ref = `refs/heads/${fixture.git_branch}`;
      await git(['fetch', '--no-tags', '--depth=1', 'origin', `${ref}:refs/remotes/origin/load`]);
      const old = (await git(['rev-parse', 'refs/remotes/origin/load'])).trim();
      const tree = (await git(['rev-parse', `${old}^{tree}`])).trim();
      const oid = (await git(['commit-tree', tree, '-p', old], `Concurrent capacity fixture ${worker}:${sequence}\n`)).trim();
      try {
        await git(['push', '--porcelain', '--atomic', `--force-with-lease=${ref}:${old}`, 'origin', `${oid}:${ref}`]);
        return { status: 201, expected: true, bytes: 0 };
      } catch (error) {
        const output = error instanceof Error ? error.message : '';
        // Count an actual stale-old conflict separately from transport/policy
        // failures. A failure is never recorded as a successful publication.
        if (/stale info|cannot lock ref.*expected|fetch first|stale_old|stale.old|lease.*reject/i.test(output)) return { status: 409, expected: true, bytes: 0 };
        return { status: 500, expected: false, bytes: 0 };
      }
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
