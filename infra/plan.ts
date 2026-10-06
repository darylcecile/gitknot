import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { environment } from './environment.ts';
import { offlinePlan, resolvePlan } from './planning.ts';
import { main, writeJson } from './process.ts';

export async function planMain(): Promise<void> {
  const { values } = parseArgs({ options: { mode: { type: 'string', default: 'production' }, resolve: { type: 'boolean', default: false }, out: { type: 'string' } }, strict: true });
  const env = environment(values.mode);
  const plan = values.resolve ? await resolvePlan(env) : offlinePlan(env);
  if (values.out) {
    await writeJson(resolve(values.out), plan);
    console.log(`Wrote ${values.resolve ? 'read-only resolved' : 'offline'} plan to ${resolve(values.out)}.`);
  } else console.log(JSON.stringify(plan, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(planMain);
