import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readBuildOutput, type BuildOutputWorker } from '@cloudflare/build-output-utils';
import { Miniflare, type MiniflareWorkerConfig } from 'miniflare';
import { ROOT } from './environment.ts';
import { cf, offlineEnvironment } from './process.ts';
import { createProjects, projectDirectory } from './projects.ts';

export const OPENAPI_ORIGIN = 'https://api.gitknot.com';
export interface OpenApiSummary { paths: number; operations: number; references: number; schemas: number }
type JsonObject = Record<string, unknown>;
type SchemaKind = 'openapi' | 'schema' | 'schema-map' | 'examples' | 'example';
const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const schemaData = new Set(['example', 'examples', 'default', 'const', 'enum']);
const schemaMaps = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);

function object(value: unknown, description: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${description} must be an object.`);
  return value as JsonObject;
}

async function apiBuild(root?: string): Promise<BuildOutputWorker> {
  const project = root ? resolve(ROOT, root) : projectDirectory('api');
  if (!root) {
    if (['cloudflare.config.ts', 'vite.config.ts', 'package.json'].some(file => !existsSync(join(project, file)))) await createProjects();
    await cf(['build', '--mode', 'production'], { cwd: project, env: offlineEnvironment({ GITKNOT_MODE: 'production' }), capture: true, timeout: 300_000 });
  }
  const built = await readBuildOutput(project);
  if (built.rootConfig.buildContext.mode !== 'production') throw new Error('OpenAPI export requires a production API build. Omit --build-output to build the current API source.');
  const worker = built.workers.default;
  const origin = worker.config.env?.API_ORIGIN;
  if (!worker.bundleDir || !worker.config.manifest || origin?.type !== 'text' || origin.value !== OPENAPI_ORIGIN) {
    throw new Error('The selected Build Output is not the production GitKnot API Worker.');
  }
  return worker;
}

async function runtimeManifest(worker: BuildOutputWorker): Promise<NonNullable<MiniflareWorkerConfig['manifest']>> {
  const source = worker.config.manifest!;
  const entries = await Promise.all(Object.entries(source.modules).filter(([, module]) => module.type !== 'sourcemap').map(async ([name, module]) => {
    const content = Uint8Array.from(await readFile(join(worker.bundleDir!, name)));
    const contents = module.type === 'wasm' || module.type === 'data' ? content : new TextDecoder('utf-8', { fatal: true }).decode(content);
    return [name, { type: module.type, contents }] as const;
  }));
  return { mainModule: source.mainModule, modulesRoot: worker.bundleDir!, modules: Object.fromEntries(entries) };
}

/** Execute the actual API bundle once, with public metadata bindings and no application resources. */
export async function isolatedOpenApi(buildRoot?: string): Promise<unknown> {
  const worker = await apiBuild(buildRoot);
  const manifest = await runtimeManifest(worker);
  const env: NonNullable<MiniflareWorkerConfig['env']> = {};
  for (const name of ['ENVIRONMENT', 'APP_ORIGIN', 'API_ORIGIN', 'GIT_ORIGIN']) {
    const binding = worker.config.env?.[name];
    if (binding?.type !== 'text') throw new Error(`The API build is missing public metadata binding ${name}.`);
    env[name] = binding;
  }
  let outboundRequests = 0;
  const runtime = new Miniflare({
    host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false }, unsafeEnableSharedStorage: false,
    workers: [{
      config: { name: worker.config.name, compatibilityDate: worker.config.compatibilityDate,
        compatibilityFlags: worker.config.compatibilityFlags, manifest, env },
      dev: { cacheAPI: false, unsafeRegisterWorker: false, outboundService: { type: 'fetcher', handler: () => {
        outboundRequests++;
        throw new Error('OpenAPI export attempted an outbound request.');
      } } },
    }],
  });
  try {
    const response = await runtime.dispatchFetch(`${OPENAPI_ORIGIN}/openapi.json`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`The isolated API Worker returned HTTP ${response.status} while exporting OpenAPI.`); }
    const document: unknown = await response.json();
    if (outboundRequests) throw new Error('OpenAPI generation attempted external I/O; the artifact was not accepted.');
    return document;
  } finally { await runtime.dispose(); }
}

function pointer(root: unknown, fragment: string): unknown {
  let target = root;
  if (!fragment) return target;
  for (const encoded of fragment.slice(1).split('/')) {
    if (/~(?:[^01]|$)/.test(encoded)) return undefined;
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) return undefined;
    target = (target as JsonObject)[key];
  }
  return target;
}

function childKind(kind: SchemaKind, key: string): SchemaKind {
  if (kind === 'schema') return schemaMaps.has(key) ? 'schema-map' : 'schema';
  if (key === 'schema') return 'schema';
  if (key === 'schemas') return 'schema-map';
  return key === 'examples' ? 'examples' : 'openapi';
}

/** Check every bundled reference, respecting JSON Schema resource/anchor scopes and literal examples. */
function verifyReferences(document: JsonObject): number {
  const references: { root: JsonObject; reference: string }[] = [];
  const anchors = new Map<JsonObject, Map<string, unknown>>();
  const pending: { value: unknown; root: JsonObject; kind: SchemaKind }[] = [{ value: document, root: document, kind: 'openapi' }];
  while (pending.length) {
    const { value, root: enclosing, kind } = pending.pop()!;
    if (Array.isArray(value)) { pending.push(...value.map(value => ({ value, root: enclosing, kind }))); continue; }
    if (!value || typeof value !== 'object') continue;
    const item = value as JsonObject;
    if (kind === 'schema-map' || kind === 'examples') {
      pending.push(...Object.values(item).map(value => ({ value, root: enclosing, kind: kind === 'schema-map' ? 'schema' as const : 'example' as const })));
      continue;
    }
    const root = kind === 'schema' && typeof item.$id === 'string' ? item : enclosing;
    for (const [key, child] of Object.entries(item)) {
      if (kind === 'schema' && schemaData.has(key) || kind === 'example' && key === 'value' || kind === 'openapi' && (key === 'example' || key.startsWith('x-'))) continue;
      if ((key === '$anchor' || key === '$dynamicAnchor') && typeof child === 'string') {
        const known = anchors.get(root) ?? new Map<string, unknown>();
        if (known.has(child) && known.get(child) !== item) throw new Error(`Duplicate OpenAPI schema anchor: #${child}`);
        known.set(child, item);
        anchors.set(root, known);
      }
      if (key === '$ref' || key === '$dynamicRef') {
        if (typeof child !== 'string') throw new Error(`OpenAPI ${key} must be a string.`);
        references.push({ root, reference: child });
      }
      pending.push({ value: child, root, kind: childKind(kind, key) });
    }
  }
  for (const { root, reference } of references) {
    if (!reference.startsWith('#')) throw new Error(`OpenAPI reference is not bundled in the artifact: ${reference}`);
    const fragment = decodeURIComponent(reference.slice(1));
    const target = !fragment || fragment.startsWith('/') ? pointer(root, fragment) : anchors.get(root)?.get(fragment);
    if (target === undefined) throw new Error(`Unresolved OpenAPI reference: ${reference}`);
  }
  return references.length;
}

export function verifyOpenApi(value: unknown): OpenApiSummary {
  const document = object(value, 'OpenAPI document');
  if (document.openapi !== '3.1.0' || object(document.info, 'OpenAPI info').title !== 'GitKnot API') throw new Error('The API did not return the GitKnot OpenAPI 3.1 contract.');
  const paths = object(document.paths, 'OpenAPI paths');
  const ids = new Set<string>();
  for (const [path, pathValue] of Object.entries(paths)) {
    if (!path.startsWith('/')) throw new Error(`Invalid OpenAPI path: ${path}`);
    for (const [method, operationValue] of Object.entries(object(pathValue, `OpenAPI path ${path}`))) {
      if (!methods.has(method)) continue;
      const operation = object(operationValue, `${method.toUpperCase()} ${path}`);
      const id = operation.operationId;
      if (typeof id !== 'string' || !id || ids.has(id)) throw new Error(`Missing or duplicate operationId for ${method.toUpperCase()} ${path}.`);
      object(operation.responses, `Responses for ${id}`);
      ids.add(id);
    }
  }
  if (!ids.size) throw new Error('The OpenAPI contract contains no operations.');
  if (!Array.isArray(document.servers) || document.servers.length !== 1 || object(document.servers[0], 'OpenAPI server').url !== OPENAPI_ORIGIN) {
    throw new Error('The published OpenAPI contract must use the production API origin.');
  }
  const schemas = object(object(document.components, 'OpenAPI components').schemas, 'OpenAPI schemas');
  return { paths: Object.keys(paths).length, operations: ids.size, references: verifyReferences(document), schemas: Object.keys(schemas).length };
}
