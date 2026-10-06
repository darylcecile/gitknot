import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { builtinModules } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'vite';
import { Miniflare } from 'miniflare';
import { COMPATIBILITY_DATE, LOCAL_STATE, ROOT, environment, identityStorage, localDatabaseId, resourceName, scopedVariable, type Environment } from '../environment.ts';
import { limits } from '../limits.ts';
import { main } from '../process.ts';
import type { LocalCapacityPlan, LocalCapacityReport } from './capacity-worker.ts';

function capacityPlan(env: Environment, generation: string): LocalCapacityPlan {
  if (env.mode !== 'development') throw new Error('Capacity bootstrap only operates on local development D1.');
  if (!/^[a-z][a-z0-9-]{0,19}$/.test(generation)) throw new Error('Local allocation generations must be lowercase identifiers of at most 20 characters.');
  const platform = scopedVariable('development', 'BILLING_PLATFORM_SLICE_ID') ?? resourceName(env, 'linux-small', 'execution');
  const git = scopedVariable('development', 'BILLING_GIT_STORAGE_SLICE_ID') ?? platform;
  const essential = scopedVariable('development', 'BILLING_ESSENTIAL_SLICE_ID');
  const discretionaryPool = `${env.prefix}-local-discretionary-${generation}`;
  const essentialPool = `${env.prefix}-local-essential-${generation}`;
  if (essential === platform || essential === git) throw new Error('Essential and discretionary local capacity must use distinct slices.');
  const slices: LocalCapacityPlan['slices'] = [
    { id: platform, pool_id: discretionaryPool, purpose: 'discretionary', limit_units: '10000000000', max_instances: limits('development').hosted_max_instances, max_storage_bytes: '2000000000' },
    ...(git !== platform ? [{ id: git, pool_id: discretionaryPool, purpose: 'discretionary' as const, limit_units: '10000000000', max_instances: 0, max_storage_bytes: '2000000000' }] : []),
    ...(essential ? [{ id: essential, pool_id: essentialPool, purpose: 'essential' as const, limit_units: '10000000000', max_instances: limits('development').git_max_instances, max_storage_bytes: '0' }] : []),
  ];
  if (slices.some(slice => !/^[A-Za-z0-9_-]{1,128}$/.test(slice.id))) throw new Error('Configured local billing slice IDs must match the billing admission contract.');
  return { mode: 'development', cell: env.cell, generation, starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 30 * 86400_000).toISOString(), slices,
    pools: [
      { id: discretionaryPool, purpose: 'discretionary', limit_units: '25000000000', safety_buffer_units: '1000000000', baseline_commitment_units: '1000000000', max_instances: limits('development').hosted_max_instances },
      ...(essential ? [{ id: essentialPool, purpose: 'essential' as const, limit_units: '25000000000', safety_buffer_units: '1000000000', baseline_commitment_units: '1000000000', max_instances: limits('development').git_max_instances }] : []),
    ],
  };
}

async function allocatorManifest() {
  const built = await build({ configFile: false, root: ROOT, envDir: false, publicDir: false, logLevel: 'error',
    resolve: { conditions: ['workerd', 'browser'], alias: Object.fromEntries(builtinModules.filter(name => !name.startsWith('node:')).map(name => [name, `node:${name}`])) },
    build: { target: 'esnext', write: false, minify: false, lib: { entry: join(ROOT, 'infra/local/capacity-worker.ts'), formats: ['es'], fileName: () => 'capacity.mjs' },
      rollupOptions: { external: id => id.startsWith('node:') || id.startsWith('cloudflare:') },
    },
  });
  const results = Array.isArray(built) ? built : [built];
  const modules: Record<string, { type: 'esm'; contents: string }> = {};
  let mainModule: string | undefined;
  for (const result of results) {
    if (!('output' in result)) throw new Error('The local allocator requires a one-shot Worker bundle.');
    for (const output of result.output) {
      if (output.type !== 'chunk') throw new Error('The local allocator bundle unexpectedly contains an asset.');
      modules[output.fileName] = { type: 'esm', contents: output.code };
      if (output.isEntry) mainModule = output.fileName;
    }
  }
  if (!mainModule) throw new Error('The local allocator Worker entrypoint is missing.');
  return { mainModule, modulesRoot: ROOT, modules };
}

export async function bootstrapLocalCapacity(options: { mode?: string; generation?: string; inspect?: boolean } = {}): Promise<LocalCapacityReport> {
  if (options.mode && options.mode !== 'development') throw new Error('Capacity bootstrap only operates on local development D1.');
  const env = environment('development'), identity = identityStorage(env);
  const plan = capacityPlan(env, options.generation ?? 'initial-v1');
  const token = Buffer.from(randomBytes(32)).toString('base64url');
  const runtime = new Miniflare({ host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false }, unsafeEnableSharedStorage: false,
    resourcePersistencePath: join(LOCAL_STATE, 'v3'), workers: [{ config: {
      name: `${env.prefix}-local-capacity`, compatibilityDate: COMPATIBILITY_DATE, compatibilityFlags: ['nodejs_compat'],
      manifest: await allocatorManifest(), env: {
        DB: { type: 'd1', name: identity.name, id: localDatabaseId(identity.name), dev: { remote: false } },
        LOCAL_CAPACITY_PLAN: { type: 'text', value: JSON.stringify(plan) }, LOCAL_CAPACITY_KEY: { type: 'text', value: token },
      },
    }, dev: { cacheAPI: false, unsafeRegisterWorker: false, outboundService: { type: 'fetcher', handler: () => { throw new Error('Local funding attempted external I/O.'); } } } }],
  });
  try {
    const response = await runtime.dispatchFetch('http://localhost/', { method: options.inspect ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    const result = await response.json() as LocalCapacityReport & { error?: string };
    if (!response.ok || result.mode !== 'development' || !Array.isArray(result.allocations)) throw new Error(result.error ?? 'The local allocator returned no verified result.');
    return result;
  } finally { await runtime.dispose(); }
}

export function describeLocalCapacity(report: LocalCapacityReport): void {
  for (const slice of report.allocations) console.log(`Local ${slice.purpose} allocation ${slice.id}: ${slice.action}, ${slice.status}; cap ${slice.limit_units ?? 'unfunded'} nano-USD, expires ${slice.valid_until ?? 'unallocated'}.`);
}

async function capacityMain(): Promise<void> {
  const { values } = parseArgs({ options: { mode: { type: 'string', default: 'development' }, generation: { type: 'string', default: 'initial-v1' }, inspect: { type: 'boolean', default: false } }, strict: true });
  describeLocalCapacity(await bootstrapLocalCapacity(values));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(capacityMain);
