import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { command, gitFixture, ociFixture, projectRoot, workflow } from '../../packages/runner/tests/support.ts';
import { compileWorkflow } from '../../packages/workflows/src/index.ts';
import { atomicWrite, executeJob, privateDirectory } from '../../packages/runner/src/index.ts';

describe('privileged supervisor and native process isolation', () => {
  beforeAll(async () => {
    await ociFixture();
    await command('npm', ['run', 'build', '--workspace', '@gitknot/cli'], projectRoot);
  }, 180_000);

  it('denies a malicious native job credential access and removes a detached UID-owned orphan on cancellation', async () => {
    const fixture = await ociFixture();
    if (fixture.isolation.type !== 'oci') throw Error('Expected the real container test host');
    const output = await command('docker', ['run', '--rm', '--init', '--network=none', '--user', '0:0', '--mount', `type=bind,src=${join(projectRoot,'packages','cli','dist')},dst=/opt/gitknot/dist,readonly`, '--mount', `type=bind,src=${join(projectRoot,'node_modules')},dst=/opt/gitknot/node_modules,readonly`, '--mount', `type=bind,src=${join(projectRoot,'packages','runner','tests','native-posix.mjs')},dst=/opt/gitknot/native-posix.mjs,readonly`, '--entrypoint', 'node', fixture.isolation.image, '/opt/gitknot/native-posix.mjs'], projectRoot);
    expect(output).toContain('NATIVE_ISOLATION_AND_ORPHAN_CLEANUP_PASSED');
  });
});

describe('Windows LocalSystem native isolation acceptance', () => {
  it.skipIf(process.platform !== 'win32' || !process.env.GITKNOT_WINDOWS_EXECUTION_CREDENTIAL_FILE)('blocks a malicious job credential read and destroys detached descendants through its Job Object', async () => {
    const fixture = await gitFixture();
    try {
      const state = await privateDirectory(join(fixture.root, 'supervisor'));
      const credential = join(state, 'machine.json'); await atomicWrite(credential, 'system-machine-credential-canary');
      const attack = `const fs=require('node:fs');try{fs.readFileSync(${JSON.stringify(credential)});throw Error('credential accessible')}catch(e){if(!['EACCES','EPERM'].includes(e.code))throw e}require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true}).unref();process.stdout.write('WINDOWS_BOUNDARY_ENFORCED');setInterval(()=>{},1000)`;
      const definition = workflow({ test: { steps: [{ run: `node -e '${attack.replaceAll("'", "''")}'`, shell: 'pwsh' }] } });
      const plan = await compileWorkflow(definition, fixture.context());
      const abort = new AbortController(); let logs = '';
      const result = await executeJob(plan, 'test', { source: { url: fixture.repo, commit: fixture.commit }, work_root: join(fixture.root, 'work'), output_directory: join(fixture.root, 'outputs'), allow_local_source: true, isolation: { type: 'windows_user', credential_file: process.env.GITKNOT_WINDOWS_EXECUTION_CREDENTIAL_FILE! }, signal: abort.signal, grace_ms: 100, onLog: async bytes => { logs += Buffer.from(bytes).toString('utf8'); if (logs.includes('WINDOWS_BOUNDARY_ENFORCED')) abort.abort(); } });
      expect(result.outcome).toBe('cancelled'); expect(result.cleanup_confirmed).toBe(true);
      expect(logs).toContain('WINDOWS_BOUNDARY_ENFORCED'); expect(logs).not.toContain('system-machine-credential-canary');
      expect(await readFile(credential, 'utf8')).toBe('system-machine-credential-canary');
    } finally { await fixture.close(); }
  });
});
