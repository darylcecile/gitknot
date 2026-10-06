import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { ROOT } from '../infra/environment.ts';
import { gitLoadClient } from '../infra/load/git.ts';
import { fixtureSchema, SCENARIOS, scenarioRequest, validateFixture, type ScenarioRequest } from '../infra/load/scenarios.ts';
import { main, writeJson } from '../infra/process.ts';

function target(value: string, allowRemote: boolean): URL {
  const url = new URL(value);
  if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('Load targets must be HTTP(S) URLs without embedded credentials.');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !allowRemote) throw new Error('A non-loopback load target requires --allow-remote.');
  return url;
}

async function perform(base: URL, request: ScenarioRequest, token: string | undefined, id: string, timeout: number) {
  const response = await fetch(new URL(request.path, base), {
    method: request.method, redirect: 'error', signal: AbortSignal.timeout(timeout),
    headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(request.body ? { 'content-type': 'application/json', 'idempotency-key': id } : {}) },
    ...(request.body ? { body: JSON.stringify(request.body) } : {}),
  });
  let bytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 32 * 1024 * 1024) { await reader.cancel(); throw new Error('Load response exceeded its byte cap.'); }
      }
    } finally { reader.releaseLock(); }
  }
  return { status: response.status, expected: request.expected.includes(response.status), bytes };
}

async function load(): Promise<void> {
  const { values } = parseArgs({ options: {
    scenario: { type: 'string', default: 'health' }, fixture: { type: 'string' }, 'base-url': { type: 'string', default: 'http://localhost:8787' },
    concurrency: { type: 'string', default: '8' }, requests: { type: 'string', default: '200' }, duration: { type: 'string', default: '60' },
    rps: { type: 'string', default: '20' }, timeout: { type: 'string', default: '30000' }, 'allow-remote': { type: 'boolean', default: false },
    'max-error-rate': { type: 'string', default: '0.01' }, 'max-p95-ms': { type: 'string', default: '1000' }, out: { type: 'string' },
  }, strict: true });
  const scenario = z.enum(SCENARIOS).parse(values.scenario);
  const concurrency = z.coerce.number().int().min(1).max(128).parse(values.concurrency);
  const count = z.coerce.number().int().min(1).max(1_000_000).parse(values.requests);
  const duration = z.coerce.number().min(1).max(86400).parse(values.duration) * 1000;
  const rps = z.coerce.number().positive().max(10_000).parse(values.rps);
  const timeout = z.coerce.number().int().min(100).max(180_000).parse(values.timeout);
  const maxError = z.coerce.number().min(0).max(1).parse(values['max-error-rate']);
  const maxP95 = z.coerce.number().positive().parse(values['max-p95-ms']);
  const base = target(values['base-url']!, values['allow-remote']);
  const fixture = fixtureSchema.parse(values.fixture ? JSON.parse(await readFile(resolve(values.fixture), 'utf8')) : {});
  validateFixture(scenario, fixture);
  if (fixture.git_remote) target(fixture.git_remote, values['allow-remote']);
  const runId = randomUUID();
  const token = process.env.GITKNOT_LOAD_TOKEN;
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  let failures = 0;
  let bytes = 0;
  let next = 0;
  await mkdir(join(ROOT, '.gitknot'), { recursive: true, mode: 0o700 });
  const started = performance.now();
  console.log(`Running ${scenario}: ${base.origin}, ${concurrency} clients, at most ${count} operations / ${duration / 1000}s, ${rps} requested ops/s.`);
  await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
    const git = scenario === 'git-push-race' ? await gitLoadClient(fixture, token, worker) : undefined;
    try {
      while (next < count && performance.now() - started < duration) {
        const sequence = next++;
        const launchAt = started + sequence * 1000 / rps;
        if (launchAt - started >= duration) break;
        await delay(Math.max(0, launchAt - performance.now()));
        const requestStarted = performance.now();
        try {
          const result = git ? await git.perform(sequence) : await perform(base, scenarioRequest(scenario === 'git-push-race' ? 'health' : scenario, fixture, sequence, runId), token, `${runId}:${sequence}`, timeout);
          statuses[result.status] = (statuses[result.status] ?? 0) + 1;
          if (!result.expected) failures++;
          bytes += result.bytes;
        } catch {
          statuses.network_error = (statuses.network_error ?? 0) + 1;
          failures++;
        }
        latencies.push(performance.now() - requestStarted);
      }
    } finally { await git?.close(); }
  }));
  const elapsed = performance.now() - started;
  latencies.sort((a, b) => a - b);
  const percentile = (fraction: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * fraction))] ?? 0;
  const report = {
    version: 1, run_id: runId, scenario, target: base.origin, completed_at: new Date().toISOString(),
    operations: latencies.length, failures, statuses, bytes, duration_ms: Math.round(elapsed),
    operations_per_second: Number((latencies.length * 1000 / elapsed).toFixed(2)),
    latency_ms: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), maximum: latencies.at(-1) ?? 0 },
    acceptance: { maximum_error_rate: maxError, maximum_p95_ms: maxP95 },
    passed: latencies.length > 0 && failures / latencies.length <= maxError && percentile(0.95) <= maxP95,
  };
  const path = values.out ? resolve(values.out) : join(ROOT, '.gitknot', 'load', `${runId}.json`);
  await writeJson(path, report);
  console.log(JSON.stringify(report, null, 2));
  console.log(`Evidence written to ${path}.`);
  if (!report.passed) process.exitCode = 1;
}

main(load);
