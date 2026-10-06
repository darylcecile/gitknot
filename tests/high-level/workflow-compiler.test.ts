import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileWorkflow, moduleDigest, validateWorkflow, verifyManifest } from '../../packages/workflows/src/index.ts';
import { gitFixture, workflow, type GitFixture } from '../../packages/runner/tests/support.ts';

describe('portable workflow language and trusted immutable plans', () => {
  let fixture: GitFixture;
  beforeAll(async () => { fixture = await gitFixture(); });
  afterAll(async () => { await fixture.close(); });

  it('accepts the exact proposal YAML and freezes the same graph independently of mapping order', async () => {
    const source = await readFile(new URL('../../.gitknot/workflows/verify.yaml', import.meta.url), 'utf8');
    expect(validateWorkflow(source).valid).toBe(true);
    const context = fixture.context({ event: { type: 'pull_request.updated', pull_request_id: 'pr_fixture', changed_paths: ['src/app.ts'] }, toolchains: { 'node-24@2026-10-01': { os: 'linux', arch: 'x64', tools: { node: '24.9.0', npm: '11.6.0', git: '2.51.0' } } } });
    context.policy.hosted_profiles = ['linux-small'];
    const manifest = await compileWorkflow(source, context);
    const definition = validateWorkflow(source).definition!;
    const reordered = { ...definition, jobs: Object.fromEntries(Object.entries(definition.jobs).reverse()) };
    expect((await compileWorkflow(reordered, context)).digest).toBe(manifest.digest);
    expect(manifest.order).toEqual(['test', 'build']);
    expect(manifest.jobs[0]?.steps.map((step) => step.commands[0]?.run)).toEqual(['npm ci --cache .cache/npm', 'npm test']);
    expect(Object.isFrozen(manifest.jobs[0]?.steps)).toBe(true);
    context.trust.producer_id = 'another-actor';
    expect(manifest.trust.producer_id).toBe('gitknot-control-plane');
    expect((await compileWorkflow(source, context)).digest).not.toBe(manifest.digest);
    await expect(verifyManifest({ ...manifest, source: { ...manifest.source, commit: 'a'.repeat(40) } })).rejects.toMatchObject({ code: 'workflow_invalid' });
  });

  it('binds source, toolchain, policy, broker selection and module content into the plan identity', async () => {
    const module = { version: 1, name: 'fixture/task', module_version: '1.0.0', inputs: { count: { type: 'number' } }, outputs: { answer: { type: 'number', path: 'answer.json' } }, steps: [{ run: 'printf 1 > answer.json' }] };
    const digest = await moduleDigest(module);
    const source = { ...workflow({ test: { steps: [{ id: 'task', uses: 'fixture/task@1.0.0', with: { count: 1 } }] } }), modules: { 'fixture/task@1.0.0': digest } };
    const context = fixture.context({ modules: { 'fixture/task@1.0.0': module } });
    const original = await compileWorkflow(source, context);
    const changedPolicy = await compileWorkflow(source, { ...context, policy: { ...context.policy, revision: '2' } });
    const changedSource = await compileWorkflow(source, { ...context, commit: 'b'.repeat(40) });
    const changedTools = await compileWorkflow(source, { ...context, toolchains: { 'fixture@1.0.0': { ...fixture.toolchain, tools: { ...fixture.toolchain.tools, node: '99.0.0' } } } });
    const boundSecrets = await compileWorkflow(source, { ...context, configuration: { selection_id: 'selection_fixture', selection_digest: `sha256:${'d'.repeat(64)}` } });
    expect(new Set([original, changedPolicy, changedSource, changedTools, boundSecrets].map((plan) => plan.digest)).size).toBe(5);
    await expect(compileWorkflow(source, { ...context, modules: { 'fixture/task@1.0.0': { ...module, steps: [{ run: 'printf 2 > answer.json' }] } } })).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'module_digest_mismatch' })] });
    const invalid = { ...source, jobs: { test: { steps: [{ id: 'task', uses: 'fixture/task@1.0.0', with: { count: 'not a number' } }] } } };
    expect(validateWorkflow(invalid, { modules: context.modules }).issues).toContainEqual(expect.objectContaining({ code: 'module_input_type' }));
  });

  it('rejects ambiguous YAML, cyclic/unbounded graphs, permissions and forward/untyped references before executing', async () => {
    const duplicate = 'version: 1\nversion: 1\nname: bad\n';
    expect(validateWorkflow(duplicate).valid).toBe(false);
    expect(validateWorkflow('version: 1\nx: &x [*x]\n').valid).toBe(false);
    const cases = [
      workflow({ one: { needs: ['two'], steps: [{ run: 'true' }] }, two: { needs: ['one'], steps: [{ run: 'true' }] } }),
      workflow({ one: { needs: ['missing'], steps: [{ run: 'true' }] } }),
      workflow({ one: { timeout: '2d', steps: [{ run: 'true' }] } }),
      workflow({ one: { access: { repository: 'write' }, steps: [{ run: 'true' }] } }),
      workflow({ one: { steps: [{ run: 'true', env: { INPUT: { output: 'steps.later.result' } } }, { id: 'later', run: 'true' }] } }),
      workflow({ one: { steps: [{ run: 'true' }], outputs: { unsafe: { path: '../credentials' } } } }),
    ];
    for (const input of cases) expect(validateWorkflow(input).valid).toBe(false);
    expect(validateWorkflow(workflow({ one: { steps: [{ run: 'true' }] }, two: { steps: [{ run: 'true' }] } }), { limits: { max_fanout: 1 } }).valid).toBe(false);
  });

  it('allows inapplicability only through trusted policy and keeps unknown coverage blocking', async () => {
    const source = workflow({ test: { when: { paths: { include: ['src/**'], exclude: ['src/**/*.md'] } }, steps: [{ run: 'true' }] } });
    const context = fixture.context({ event: { type: 'workflow.dispatch', changed_paths: ['docs/readme.md'] } });
    expect((await compileWorkflow(source, context)).jobs[0]?.condition.outcome).toBe('blocked');
    context.policy.inapplicable_jobs = ['test'];
    expect((await compileWorkflow(source, context)).jobs[0]?.condition.outcome).toBe('not_applicable');
    expect((await compileWorkflow(source, { ...context, event: { type: 'workflow.dispatch' } })).jobs[0]?.condition.outcome).toBe('blocked');
    expect((await compileWorkflow(source, { ...context, event: { type: 'workflow.dispatch', changed_paths: ['src/nested/code.ts'] } })).jobs[0]?.condition.outcome).toBe('run');
    await expect(compileWorkflow(source, { ...context, workflow_revision: 'e'.repeat(40) })).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'definition_untrusted' })] });
    await expect(compileWorkflow(source, { ...context, trust: { level: 'untrusted', fork: true, producer_id: 'fork' } })).rejects.toMatchObject({ issues: [expect.objectContaining({ code: 'pool_trust' })] });
  });
});
