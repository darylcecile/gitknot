import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT } from '../infra/environment.ts';
import { isolatedOpenApi, OPENAPI_ORIGIN, verifyOpenApi } from '../infra/openapi.ts';
import { main } from '../infra/process.ts';

async function liveOpenApi(origin: string): Promise<unknown> {
  const url = new URL('/openapi.json', origin);
  if (url.username || url.password || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Live OpenAPI export requires an HTTPS origin or explicit loopback HTTP origin.');
  }
  let response: Response;
  try { response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
  catch { throw new Error('Could not read the selected live API. Omit --url/GITKNOT_API_URL to export from isolated workerd.'); }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`The live API returned HTTP ${response.status} while exporting OpenAPI.`); }
  return response.json();
}

async function exportOpenApi(): Promise<void> {
  const { values } = parseArgs({ options: { url: { type: 'string' }, 'build-output': { type: 'string' }, out: { type: 'string', default: 'docs/api/openapi.json' } }, strict: true });
  const origin = values.url ?? process.env.GITKNOT_API_URL;
  if (origin && values['build-output']) throw new Error('Choose either a live --url or --build-output.');
  const value = origin ? await liveOpenApi(origin) : await isolatedOpenApi(values['build-output']);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The API did not return an OpenAPI object.');
  const document = { ...value, servers: [{ url: OPENAPI_ORIGIN }] };
  verifyOpenApi(document);
  const output = resolve(ROOT, values.out);
  const temporary = `${output}.${randomUUID()}.tmp`;
  await mkdir(dirname(output), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
    await rename(temporary, output);
  } finally { await rm(temporary, { force: true }); }
  const summary = verifyOpenApi(JSON.parse(await readFile(output, 'utf8')));
  console.log(`Wrote and verified ${output}: ${summary.operations} operations, ${summary.paths} paths, ${summary.schemas} schemas, ${summary.references} resolved references (${origin ? 'live API' : 'isolated workerd'}).`);
}

main(exportOpenApi);
