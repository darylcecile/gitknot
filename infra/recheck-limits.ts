import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { main, writeJson } from './process.ts';

const SOURCES = {
  artifacts: 'https://developers.cloudflare.com/artifacts/platform/limits/',
  artifacts_pricing: 'https://developers.cloudflare.com/artifacts/platform/pricing/',
  d1: 'https://developers.cloudflare.com/d1/platform/limits/',
  d1_export: 'https://developers.cloudflare.com/d1/best-practices/import-export-data/',
  workers: 'https://developers.cloudflare.com/workers/platform/limits/',
  durable_objects: 'https://developers.cloudflare.com/durable-objects/platform/limits/',
  containers: 'https://developers.cloudflare.com/containers/platform/limits/',
  container_pricing: 'https://developers.cloudflare.com/containers/platform/pricing/',
  workflows: 'https://developers.cloudflare.com/workflows/reference/limits/',
  queues: 'https://developers.cloudflare.com/queues/platform/limits/',
  email: 'https://developers.cloudflare.com/email-service/platform/limits/',
  secrets: 'https://developers.cloudflare.com/secrets-store/manage-secrets/',
  cf: 'https://developers.cloudflare.com/cf/projects/cloudflare-config/',
} as const;

async function recheck(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: 'string', default: '.gitknot/infra/limits-observation.json' }, compare: { type: 'string' } }, strict: true });
  const previous = values.compare ? JSON.parse(await readFile(resolve(values.compare), 'utf8')) as { sources: { name: string; sha256: string }[] } : undefined;
  const observed = await Promise.all(Object.entries(SOURCES).map(async ([name, url]) => {
    const response = await fetch(url, { headers: { accept: 'text/markdown' }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Cannot recheck ${name}: HTTP ${response.status}.`);
    const content = await response.text();
    const sha256 = createHash('sha256').update(content).digest('hex');
    return { name, url, sha256, changed: previous ? previous.sources.find(source => source.name === name)?.sha256 !== sha256 : null, content };
  }));
  await writeJson(resolve(values.out!), { observed_at: new Date().toISOString(), sources: observed });
  console.log(JSON.stringify({ output: resolve(values.out!), sources: observed.map(({ content: _content, ...source }) => source) }, null, 2));
  console.log('Compare published limits and account entitlements with infra/limits.ts before updating admission or rollout limits.');
}

main(recheck);
