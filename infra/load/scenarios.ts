import { z } from 'zod';

export const SCENARIOS = ['health', 'metadata-read', 'metadata-write', 'many-repositories', 'large-organization', 'ci-burst', 'slow-webhooks', 'git-push-race', 'soak'] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const fixtureSchema = z.object({
  repo_ids: z.array(z.string().regex(/^r_[\w-]+$/)).default([]),
  account_id: z.string().optional(),
  organization_read_path: z.string().startsWith('/v1/').optional(),
  run_path: z.string().startsWith('/v1/').optional(),
  run_request: z.record(z.string(), z.unknown()).optional(),
  git_remote: z.url().optional(),
  git_branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/).default('load-test'),
  webhook_id: z.string().optional(),
}).strict();
export type Fixture = z.infer<typeof fixtureSchema>;

export interface ScenarioRequest { path: string; method: 'GET' | 'POST'; body?: unknown; expected: number[] }

export function validateFixture(scenario: Scenario, fixture: Fixture): void {
  if (!['health', 'git-push-race', 'large-organization'].includes(scenario) && fixture.repo_ids.length === 0) throw new Error(`${scenario} requires repo_ids in --fixture.`);
  if (scenario === 'large-organization' && !fixture.organization_read_path) throw new Error('large-organization requires the intended authorized organization_read_path.');
  if (scenario === 'ci-burst' && (!fixture.run_request || !fixture.run_path)) throw new Error('ci-burst requires a real immutable run_request and run_path in the fixture.');
  if (scenario === 'git-push-race' && !fixture.git_remote) throw new Error('git-push-race requires git_remote and an existing disposable git_branch.');
  if (scenario === 'slow-webhooks' && !fixture.webhook_id) throw new Error('slow-webhooks requires a configured, active slow webhook_id.');
}

export function scenarioRequest(scenario: Exclude<Scenario, 'git-push-race'>, fixture: Fixture, sequence: number, runId: string): ScenarioRequest {
  const repo = fixture.repo_ids[sequence % Math.max(1, fixture.repo_ids.length)];
  const issue = (): ScenarioRequest => ({ path: `/v1/repos/${repo}/issues`, method: 'POST', expected: [201], body: { title: `Load ${runId} #${sequence}`, body: 'Capacity fixture. Measures authoritative write, outbox, and projection delivery.' } });
  switch (scenario) {
    case 'health': return { path: '/health/ready', method: 'GET', expected: [200] };
    case 'metadata-read': return { path: `/v1/repos/${repo}/issues?limit=20`, method: 'GET', expected: [200] };
    case 'metadata-write': return issue();
    case 'many-repositories': return { path: `/v1/repos/${repo}`, method: 'GET', expected: [200] };
    case 'large-organization': return { path: fixture.organization_read_path!, method: 'GET', expected: [200] };
    case 'ci-burst': return { path: fixture.run_path!, method: 'POST', expected: [201, 202, 409, 429], body: fixture.run_request };
    case 'slow-webhooks': return sequence % 3 === 0
      ? { path: `/v1/webhooks/${fixture.webhook_id}/deliveries?limit=20`, method: 'GET', expected: [200] }
      : issue();
    case 'soak': return sequence % 10 === 0 ? issue() : { path: `/v1/repos/${repo}/issues?limit=20`, method: 'GET', expected: [200] };
  }
}
