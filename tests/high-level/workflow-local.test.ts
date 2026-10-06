import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { compileWorkflow, moduleDigest } from '../../packages/workflows/src/index.ts';
import { runLocalWorkflow, type RunnerIsolation } from '../../packages/runner/src/index.ts';
import { gitFixture, ociFixture, shellNode, workflow, type GitFixture } from '../../packages/runner/tests/support.ts';

describe('real shell execution of portable Git graphs', () => {
  const fixtures: GitFixture[] = [];
  let isolation: RunnerIsolation;
  beforeAll(async () => { isolation = (await ociFixture()).isolation; }, 180_000);
  afterEach(async () => { await Promise.all(fixtures.splice(0).map((fixture) => fixture.close())); });
  const create = async (files: Record<string, string> = {}) => { const fixture = await gitFixture(files); fixture.toolchain = (await ociFixture()).toolchain; fixtures.push(fixture); return fixture; };

  it('uses pinned clean job trees, sequential commands, typed module inputs and immutable dependency artifacts', async () => {
    const fixture = await create({ 'source.txt': 'committed\n' });
    await writeFile(join(fixture.repo, 'source.txt'), 'dirty\n');
    await writeFile(join(fixture.repo, 'untracked-secret'), 'do-not-copy');
    const module = {
      version: 1, name: 'fixture/consumer', module_version: '1.0.0',
      inputs: { message: { type: 'string' }, bundle: { type: 'artifact' } },
      outputs: { answer: { type: 'number', path: 'answer.json' } },
      steps: [{ run: shellNode(`const fs=require('node:fs');const path=require('node:path');if(process.env.GITKNOT_INPUT_MESSAGE!=='hello')throw Error('type');if(fs.readFileSync(path.join(process.env.GITKNOT_INPUT_BUNDLE,'bundle.txt'),'utf8')!=='artifact')throw Error('artifact');fs.writeFileSync('answer.json','42');`) }],
    };
    const source = { ...workflow({
      prepare: { steps: [
        { run: shellNode(String.raw`const fs=require('node:fs');if(fs.readFileSync('source.txt','utf8')!=='committed\n'||fs.existsSync('untracked-secret'))throw Error('dirty checkout');fs.writeFileSync('message.txt','hello');fs.mkdirSync('bundle');fs.writeFileSync('bundle/bundle.txt','artifact');fs.writeFileSync('sequential','yes');`) },
        { run: shellNode(`const fs=require('node:fs');if(fs.readFileSync('sequential','utf8')!=='yes')throw Error('sequential');`) },
      ], outputs: { message: { type: 'string', path: 'message.txt' }, bundle: { path: 'bundle/' } } },
      consume: { needs: ['prepare'], steps: [
        { id: 'consumer', uses: 'fixture/consumer@1.0.0', with: { message: { output: 'jobs.prepare.message' }, bundle: { output: 'jobs.prepare.bundle' } } },
        { run: shellNode(`const fs=require('node:fs');if(fs.existsSync('sequential'))throw Error('shared job tree');if(process.env.ANSWER!=='42')throw Error('typed step output');`), env: { ANSWER: { output: 'steps.consumer.answer' } } },
      ] },
    }), modules: { 'fixture/consumer@1.0.0': await moduleDigest(module) } };
    const plan = await compileWorkflow(source, fixture.context({ modules: { 'fixture/consumer@1.0.0': module } }));
    const result = await runLocalWorkflow(plan, { isolation, source: { url: fixture.repo, commit: fixture.commit }, work_root: join(fixture.root, 'work'), output_directory: join(fixture.root, 'outputs'), allow_local_source: true });
    expect(result.outcome, JSON.stringify(result)).toBe('passed');
    expect(result.jobs.map((job) => [job.job_id, job.outcome])).toEqual([['prepare', 'passed'], ['consume', 'passed']]);
    expect(result.jobs.every((job) => job.cleanup_confirmed)).toBe(true);
    expect(await readdir(join(fixture.root, 'work'))).toEqual([]);
  });

  it('reports missing secrets and exact toolchain mismatches, redacts split secrets, and rejects secret artifacts', async () => {
    const fixture = await create();
    const secret = 'split-secret-value-123456789';
    const source = { ...workflow({ test: { steps: [{ run: shellNode(String.raw`const fs=require('node:fs');const s=process.env.TOKEN;process.stdout.write(s.slice(0,7));setTimeout(()=>{process.stdout.write(s.slice(7)+'\n');fs.writeFileSync('unsafe.txt',s);},30);`), env: { TOKEN: { secret: 'TOKEN' } } }], outputs: { unsafe: { path: 'unsafe.txt' } } } }), access: { repository: 'read', secrets: ['TOKEN'] } };
    const context = fixture.context(); context.policy.access.secrets = ['TOKEN'];
    const plan = await compileWorkflow(source, context);
    const options = { isolation, source: { url: fixture.repo, commit: fixture.commit }, work_root: join(fixture.root, 'work'), output_directory: join(fixture.root, 'missing'), allow_local_source: true };
    const missing = await runLocalWorkflow(plan, options);
    expect(missing.jobs[0]).toMatchObject({ outcome: 'dependency_blocked', missing_secrets: ['TOKEN'] });
    let logs = '';
    const unsafe = await runLocalWorkflow(plan, { ...options, output_directory: join(fixture.root, 'unsafe'), secrets: { TOKEN: secret }, onLog: async (bytes) => { logs += Buffer.from(bytes).toString('utf8'); } });
    expect(logs).toContain('[REDACTED]'); expect(logs).not.toContain(secret);
    expect(unsafe.jobs[0]?.reason).toContain('output_contains_secret');
    expect(unsafe.jobs[0]?.outputs).toEqual([]);
    const mismatch = await compileWorkflow(workflow({ test: { steps: [{ run: 'exit 0' }] } }), { ...fixture.context(), toolchains: { 'fixture@1.0.0': { ...fixture.toolchain, tools: { ...fixture.toolchain.tools, node: '0.0.0' } } } });
    const mismatched = await runLocalWorkflow(mismatch, { ...options, output_directory: join(fixture.root, 'mismatch') });
    expect(mismatched.jobs[0]).toMatchObject({ outcome: 'dependency_blocked', reason: expect.stringContaining('toolchain_mismatch') });
  });

  it('keeps dependency caching independent of verification and deleted source, and treats corrupt caches as misses', async () => {
    const fixture = await create({ 'package-lock.json': '{}', 'obsolete.txt': 'old source' });
    const definition = workflow({ test: { cache: { paths: ['.cache/dependencies'], key_files: ['package-lock.json'] }, env: { REGISTRY: { variable: 'REGISTRY' } }, steps: [{ run: shellNode(`const fs=require('node:fs');if(fs.existsSync('expect-deleted')&&fs.existsSync('obsolete.txt'))throw Error('stale source');if(fs.existsSync('.cache/dependencies/prepared')&&fs.readFileSync('.cache/dependencies/prepared','utf8')!==process.env.REGISTRY)throw Error('stale input lineage');fs.mkdirSync('.cache/dependencies',{recursive:true});fs.writeFileSync('.cache/dependencies/prepared',process.env.REGISTRY);fs.writeFileSync('verified.txt','verified');`) }], outputs: { verification: { type: 'string', path: 'verified.txt' } } } });
    const cache = join(fixture.root, 'cache');
    const run = async (name: string) => runLocalWorkflow(await compileWorkflow(definition, fixture.context()), { isolation, source: { url: fixture.repo, commit: fixture.commit }, allow_local_source: true, work_root: join(fixture.root, 'work'), output_directory: join(fixture.root, name), cache_directory: cache, variables: { REGISTRY: 'primary' } });
    const first = await run('first'); expect(first.outcome).toBe('passed'); expect(first.jobs[0]?.cache_hit).toBe(false);
    const originalDefinitionRevision = fixture.commit;
    await fixture.commitFiles({ 'obsolete.txt': null, 'expect-deleted': 'yes' });
    // Keep trusted policy/definition identity constant; only the exact source tree changes.
    const context = fixture.context(); context.workflow_revision = originalDefinitionRevision; context.policy.allowed_workflow_revisions = [originalDefinitionRevision];
    const plan = await compileWorkflow(definition, context);
    const second = await runLocalWorkflow(plan, { isolation, source: { url: fixture.repo, commit: fixture.commit }, allow_local_source: true, work_root: join(fixture.root, 'work'), output_directory: join(fixture.root, 'second'), cache_directory: cache, variables: { REGISTRY: 'primary' } });
    expect(second.outcome).toBe('passed'); expect(second.jobs[0]?.cache_hit).toBe(true);
    expect(second.jobs[0]?.outputs[0]?.value).toBe('verified');
    for (const name of await readdir(cache)) if (name.endsWith('.ndjson')) await writeFile(join(cache, name), 'corrupted');
    const third = await runLocalWorkflow(plan, { isolation, source: { url: fixture.repo, commit: fixture.commit }, allow_local_source: true, work_root: join(fixture.root, 'work'), output_directory: join(fixture.root, 'third'), cache_directory: cache, variables: { REGISTRY: 'primary' } });
    expect(third.outcome).toBe('passed'); expect(third.jobs[0]?.cache_hit).toBe(false);
    const changedInputs = await runLocalWorkflow(plan, { isolation, source: { url: fixture.repo, commit: fixture.commit }, allow_local_source: true, work_root: join(fixture.root, 'work'), output_directory: join(fixture.root, 'changed-inputs'), cache_directory: cache, variables: { REGISTRY: 'alternate' } });
    expect(changedInputs.outcome).toBe('passed'); expect(changedInputs.jobs[0]?.cache_hit).toBe(false);
  });

  it('keeps real command failures, dependency blocking, report failures and deadlines explicit', async () => {
    const fixture = await create();
    const definition = workflow({
      fail: { steps: [{ run: 'exit 7' }, { run: 'echo must-not-run' }] },
      blocked: { needs: ['fail'], steps: [{ run: 'exit 0' }] },
      report: { steps: [{ run: shellNode(`require('node:fs').writeFileSync('tests.xml','<testsuite tests="1" failures="1"><testcase name="actual"><failure>failed</failure></testcase></testsuite>')`) }], reports: { tests: { path: 'tests.xml', format: 'junit' } } },
      timeout: { timeout: '200ms', steps: [{ run: shellNode('setInterval(()=>{},1000)') }] },
    });
    const result = await runLocalWorkflow(await compileWorkflow(definition, fixture.context()), { isolation, source: { url: fixture.repo, commit: fixture.commit }, allow_local_source: true, work_root: join(fixture.root, 'work'), output_directory: join(fixture.root, 'outputs'), grace_ms: 50 });
    expect(result.outcome).toBe('failed');
    expect(result.jobs.find((job) => job.job_id === 'fail')).toMatchObject({ outcome: 'failed', exit_code: 7, steps: [expect.objectContaining({ outcome: 'failed' })] });
    expect(result.jobs.find((job) => job.job_id === 'blocked')?.outcome).toBe('dependency_blocked');
    expect(result.jobs.find((job) => job.job_id === 'report')).toMatchObject({ outcome: 'failed', reason: 'A test or analysis report contains failures.' });
    expect(result.jobs.find((job) => job.job_id === 'timeout')?.outcome, JSON.stringify(result)).toBe('timed_out');
    expect(await readdir(join(fixture.root, 'work'))).toEqual([]);
  });

  it('enforces streamed byte limits and rejects symlink outputs without touching their targets', async () => {
    const fixture = await create();
    const protectedFile = join(fixture.root, 'outside-credential');
    await writeFile(protectedFile, 'outside remains private');
    const context = fixture.context(); context.policy.limits = { max_log_bytes: 512, max_output_bytes: 512, max_chunk_bytes: 128 };
    const plan = await compileWorkflow(workflow({
      logs: { steps: [{ run: shellNode(`process.stdout.write('x'.repeat(4096))`) }] },
      output: { steps: [{ run: shellNode(`require('node:fs').writeFileSync('large.bin','x'.repeat(1024))`) }], outputs: { large: { path: 'large.bin' } } },
      link: { steps: [{ run: shellNode(`require('node:fs').symlinkSync(${JSON.stringify(protectedFile)},'link')`) }], outputs: { link: { path: 'link' } } },
    }), context);
    const result = await runLocalWorkflow(plan, { isolation, source: { url: fixture.repo, commit: fixture.commit }, allow_local_source: true, work_root: join(fixture.root, 'work'), output_directory: join(fixture.root, 'outputs'), grace_ms: 50 });
    expect(result.jobs.find((job) => job.job_id === 'logs')?.reason).toContain('log_limit');
    expect(result.jobs.find((job) => job.job_id === 'output')?.reason).toContain('output_limit');
    expect(result.jobs.find((job) => job.job_id === 'link')?.reason).toContain('unsafe_symlink');
    expect(result.jobs.every((job) => job.outcome === 'failed' && job.outputs.length === 0)).toBe(true);
    expect(await readFile(protectedFile, 'utf8')).toBe('outside remains private');
  });

  it('keeps unrelated triggers nonqualifying and isolates each job’s effective cache configuration', async () => {
    const fixture = await create({ 'lock.json': '{}' });
    const command = shellNode(`const fs=require('node:fs');const file='.cache/flavor';if(fs.existsSync(file)&&fs.readFileSync(file,'utf8')!==process.env.FLAVOR)process.exit(42);fs.mkdirSync('.cache',{recursive:true});fs.writeFileSync(file,process.env.FLAVOR);`);
    const definition = { ...workflow({
      _alpha: { env: { FLAVOR: 'a' }, cache: { paths: ['.cache'], key_files: ['lock.json'] }, steps: [{ id: '_step', run: command }] },
      _beta: { needs: ['_alpha'], env: { FLAVOR: 'b' }, cache: { paths: ['.cache'], key_files: ['lock.json'] }, steps: [{ id: '_step', run: command }] },
    }), triggers: ['push.updated'] };
    const context = fixture.context({ event: { type: 'issues.updated', changed_paths: [] } });
    context.policy.inapplicable_jobs = ['_alpha', '_beta'];
    const mismatch = await compileWorkflow(definition, context);
    expect(mismatch.jobs.every(job => job.condition.outcome === 'blocked')).toBe(true);
    const execute = (plan: typeof mismatch, name: string) => runLocalWorkflow(plan, { isolation, source: { url: fixture.repo, commit: fixture.commit }, allow_local_source: true, work_root: join(fixture.root, 'work'), output_directory: join(fixture.root, name), cache_directory: join(fixture.root, 'cache') });
    const blocked = await execute(mismatch, 'unrelated');
    expect(blocked.outcome).toBe('failed');
    expect(blocked.jobs.every(job => job.outcome === 'dependency_blocked')).toBe(true);
    const matched = await compileWorkflow(definition, { ...context, event: { type: 'push.updated', changed_paths: ['src/code.ts'] } });
    expect(matched.jobs[0]?.cache?.namespace).not.toBe(matched.jobs[1]?.cache?.namespace);
    const first = await execute(matched, 'first-flavors');
    expect(first.outcome, JSON.stringify(first)).toBe('passed');
    expect(first.jobs.map(job => job.cache_hit)).toEqual([false, false]);
    const cached = await execute(matched, 'cached-flavors');
    expect(cached.outcome).toBe('passed'); expect(cached.jobs.every(job => job.cache_hit)).toBe(true);
  });

  it('round-trips canonical typed values and empty step directories while enforcing a single aggregate output budget', async () => {
    const fixture = await create();
    const definition = workflow({
      _producer: { steps: [{ id: '_step', run: shellNode(`const fs=require('node:fs');fs.mkdirSync('empty');fs.writeFileSync('value.txt',String.fromCharCode(92).repeat(30000));`), outputs: { _empty: { path: 'empty/' }, _value: { type: 'string', path: 'value.txt' } } }], outputs: { _empty: { path: 'empty/' }, _value: { type: 'string', path: 'value.txt' } } },
      _consumer: { needs: ['_producer'], steps: [{ id: '_step', env: { EMPTY: { output: 'jobs._producer._empty' }, VALUE: { output: 'jobs._producer._value' } }, run: shellNode(`if(require('node:fs').readdirSync(process.env.EMPTY).length||process.env.VALUE!==String.fromCharCode(92).repeat(30000))process.exit(42);`) }] },
    });
    const execute = (plan: Awaited<ReturnType<typeof compileWorkflow>>, name: string) => runLocalWorkflow(plan, { isolation, source: { url: fixture.repo, commit: fixture.commit }, allow_local_source: true, work_root: join(fixture.root, 'work'), output_directory: join(fixture.root, name) });
    const valid = await execute(await compileWorkflow(definition, fixture.context()), 'wire');
    expect(valid.outcome, JSON.stringify(valid)).toBe('passed');
    const producer = valid.jobs.find(job => job.job_id === '_producer')!;
    expect(producer.outputs.find(output => output.name === '_value')?.size_bytes).toBe(60002);
    expect(await readFile(producer.outputs.find(output => output.name === '_empty')!.path, 'utf8')).toContain('"type":"directory"');
    const oversized = await execute(await compileWorkflow(workflow({ large: { steps: [{ run: shellNode(`require('node:fs').writeFileSync('value.txt',String.fromCharCode(92).repeat(40000))`) }], outputs: { value: { type: 'string', path: 'value.txt' } } } }), fixture.context()), 'oversized-wire');
    expect(oversized.jobs[0]?.reason).toContain('typed_value_limit'); expect(oversized.jobs[0]?.outputs).toEqual([]);
    const context = fixture.context(); context.policy.limits = { max_output_files: 1 };
    const files = shellNode(`const fs=require('node:fs');fs.writeFileSync('a','a');fs.writeFileSync('b','b');`);
    const exhausted = await execute(await compileWorkflow(workflow({
      artifacts: { steps: [{ run: files }], outputs: { a: { path: 'a' }, b: { path: 'b' } } },
      stages: { steps: [{ id: 'first', run: files, outputs: { a: { type: 'string', path: 'a' } } }], outputs: { b: { type: 'string', path: 'b' } } },
    }), context), 'aggregate-limit');
    expect(exhausted.jobs.every(job => job.outcome === 'failed' && job.reason.includes('output_file_limit'))).toBe(true);
  });
});
