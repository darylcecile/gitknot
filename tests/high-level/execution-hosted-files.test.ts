import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as fileSystem from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { dependencyRestoreScript, dependencySnapshotScript } from '../../packages/execution/src/hosted/scripts.ts';
import { collectOutputScript, restoreInputScript } from '../../packages/execution/src/hosted/output-script.ts';
import { jobSupervisorScript, launchStepScript } from '../../packages/execution/src/hosted/job-scripts.ts';

const roots: string[] = [];
const temporary = process.env.TMPDIR ?? '/private/var/folders/zh/l70grz9n3ll9j9c_f1ghp7gr0000gn/T/opencode';
async function writableDirectories(root: string): Promise<void> {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) await writableDirectories(join(root, entry.name));
}
afterEach(async () => { for (const root of roots.splice(0)) { await writableDirectories(root); await rm(root, { recursive: true, force: true }); } });

async function fixture() {
  const root = await mkdtemp(join(temporary, 'gitknot-hosted-files-')); roots.push(root);
  const workspace = join(root, 'workspace'), snapshot = join(root, 'snapshot'), control = join(root, 'control');
  await Promise.all([workspace, snapshot, control].map(path => mkdir(path, { recursive: true })));
  const execute = (source: string, key: string, value: unknown) => {
    const script = source.replaceAll('/workspace', workspace).replaceAll('/tmp/gitknot-snapshot', snapshot).replaceAll('/tmp/gitknot-control', control);
    return execFileSync(process.execPath, ['-e', script], { env: { ...process.env, [key]: JSON.stringify(value) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  };
  const git = (...args: string[]) => execFileSync('git', ['-C', workspace, '-c', 'user.name=Test', '-c', 'user.email=test@example.net', ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet');
  return { root, workspace, snapshot, control, execute, git };
}

describe('hosted filesystem boundaries using the real executor helper scripts', () => {
  it('restores only declared dependencies onto the exact new tree and excludes authentication files from snapshots', async () => {
    const test = await fixture();
    await writeFile(join(test.workspace, 'deleted.ts'), 'old tracked source');
    await writeFile(join(test.workspace, 'package-lock.json'), '{}');
    test.git('add', '.'); test.git('commit', '--quiet', '-m', 'old');
    await mkdir(join(test.workspace, '.cache/npm'), { recursive: true });
    await writeFile(join(test.workspace, '.cache/npm/dependency'), 'cached dependency');
    await writeFile(join(test.workspace, '.cache/npm/.npmrc'), '//registry/:_authToken=never-snapshot');
    await writeFile(join(test.control, 'tracked-source'), 'deleted.ts\0package-lock.json\0');
    test.execute(dependencySnapshotScript, 'GITKNOT_CACHE_SPEC', { paths: ['.cache/npm'], masks: ['never-snapshot'], max_bytes: 1024 });
    expect(await readFile(join(test.snapshot, '.cache/npm/dependency'), 'utf8')).toBe('cached dependency');
    await expect(readFile(join(test.snapshot, '.cache/npm/.npmrc'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(test.snapshot, 'deleted.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    test.git('rm', '--quiet', 'deleted.ts'); test.git('commit', '--quiet', '-m', 'delete');
    const commit = test.git('rev-parse', 'HEAD');
    await rm(join(test.workspace, '.cache'), { recursive: true });
    // Host-path remapping and the current local UID are the explicit filesystem
    // test boundary; production fixes these to /workspace and uid 10000.
    test.execute(dependencyRestoreScript, 'GITKNOT_CACHE_SPEC', { paths: ['.cache/npm'], max_bytes: 1024, uid: process.getuid?.(), gid: process.getgid?.() });
    expect(test.git('rev-parse', 'HEAD')).toBe(commit);
    expect(test.git('diff', '--name-only', 'HEAD')).toBe('');
    await expect(readFile(join(test.workspace, 'deleted.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(test.workspace, '.cache/npm/dependency'), 'utf8')).toBe('cached dependency');
    await writeFile(join(test.workspace, '.cache/npm/persisted-secret'), 'never-snapshot');
    expect(() => test.execute(dependencySnapshotScript, 'GITKNOT_CACHE_SPEC', { paths: ['.cache/npm'], masks: ['never-snapshot'], max_bytes: 1024 })).toThrow('Secret-bearing cache rejected');
  });

  it('produces a deterministic portable file archive and rejects traversal while restoring it', async () => {
    const test = await fixture();
    await mkdir(join(test.workspace, 'dist'));
    await writeFile(join(test.workspace, 'dist/index.js'), 'console.log("verified");\n');
    const archive = join(test.control, 'artifact.ndjson');
    const metadata = JSON.parse(test.execute(collectOutputScript, 'GITKNOT_OUTPUT_SPEC', { path: 'dist', type: 'artifact', kind: 'artifact', destination: archive, masks: [], mask_width: 1, max_bytes: 16384 })) as { size_bytes: number; sha256: string };
    expect(metadata.size_bytes).toBeGreaterThan(0);
    const target = join(test.root, 'mounted/input');
    test.execute(restoreInputScript, 'GITKNOT_INPUT_SPEC', { archive, destination: target, max_bytes: 16384 });
    expect(await readFile(join(target, 'index.js'), 'utf8')).toBe('console.log("verified");\n');
    const unsafe = join(test.control, 'unsafe.ndjson');
    await writeFile(unsafe, `${JSON.stringify({ format: 'gitknot.files', version: 1 })}\n${JSON.stringify({ path: '../escape', mode: 420, sequence: 0, final: true, data_base64: 'eA==' })}\n`);
    expect(() => test.execute(restoreInputScript, 'GITKNOT_INPUT_SPEC', { archive: unsafe, destination: join(test.root, 'bad'), max_bytes: 16384 })).toThrow();
    await expect(readFile(join(test.root, 'escape'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('applies hostile tenant environment only after the supervisor privilege-drop boundary', async () => {
    const test = await fixture();
    const values = { LD_PRELOAD: '/workspace/hostile.so', BASH_ENV: '/workspace/root-hook', PATH: '/workspace/bin', TOKEN: 'tenant-secret' };
    await writeFile(join(test.control, 'step-0.json'), JSON.stringify({ env: values, shell: 'bash', working_directory: '.', deadline: Date.now() + 10000,
      step_deadline: Date.now() + 10000, log_bytes: 1024 }));
    let called = false;
    const stop = new Error('The test inspects the boundary without starting a privileged process.');
    const script = jobSupervisorScript.replaceAll('/workspace', await realpath(test.workspace)).replaceAll('/tmp/gitknot-control', test.control);
    expect(() => runInNewContext(script, {
      process: { argv: ['node', 'supervisor.cjs', '0'], getuid: () => 0 },
      require(name: string) {
        if (name === 'node:fs') return { ...fileSystem, createWriteStream: () => ({}) };
        if (name !== 'node:child_process') throw new Error('Unexpected supervisor dependency.');
        return { spawn(command: string, args: string[], options: { env: Record<string, string>; detached: boolean }) {
          called = true;
          expect(command).toBe('/usr/bin/setpriv');
          expect(args.slice(0, 7)).toEqual(['--reuid=10000', '--regid=10000', '--clear-groups', '--no-new-privs', '--bounding-set=-all', '/usr/bin/env', '-i']);
          expect(options.env).toEqual({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/root' });
          expect(options.detached).toBe(true);
          for (const [key, value] of Object.entries(values)) expect(args.slice(7)).toContain(`${key}=${value}`);
          throw stop;
        } };
      },
    })).toThrow(stop);
    expect(called).toBe(true);
    expect(launchStepScript(0)).toContain('/usr/bin/env -i');
  });
});
