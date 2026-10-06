import { createReadStream } from 'node:fs';
import { Buffer } from 'node:buffer';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RunnerError, decodeUtf8, readBounded, type GitKnotHttpClient, type RequestOptions } from '../../runner/src/index.ts';
import { assignField, flag, has, numberFlag, parsePair, parseValue, repeated, type Arguments } from './args.ts';
import { apiClient } from './config.ts';
import { print, readStdin, write, type CliIO } from './io.ts';

export const API_FLAGS = ['method', 'header', 'field', 'raw-field', 'query', 'input', 'binary', 'if-match', 'idempotency-key', 'include', 'paginate', 'max-pages', 'limit', 'cursor', 'output', 'max-bytes', 'sha256', 'size', 'timeout', 'watch'];

export async function jsonInput(args: Arguments, io: CliIO): Promise<unknown | undefined> {
  const input = flag(args, 'input');
  if (!input || has(args, 'binary')) return undefined;
  const source = input === '-' ? await readStdin(io, 16_777_216) : decodeUtf8(await readBounded(resolve(input), 16_777_216));
  try { return JSON.parse(source); } catch { throw new RunnerError('json_invalid', 'The request input must contain valid JSON.'); }
}

export async function requestFields(args: Arguments, io: CliIO, aliases: Record<string, string> = {}, initial: Record<string, unknown> = {}): Promise<unknown> {
  const input = await jsonInput(args, io);
  const extra = [...repeated(args, 'field'), ...repeated(args, 'raw-field')];
  const suppliedAliases = Object.keys(aliases).filter((name) => has(args, name));
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) {
    if (extra.length || suppliedAliases.length || Object.keys(initial).length) throw new RunnerError('usage', 'Field options require a JSON object request body.');
    return input;
  }
  const body: Record<string, unknown> = { ...initial, ...(input as Record<string, unknown> | undefined) };
  for (const value of repeated(args, 'field')) { const [name, content] = parsePair(value); assignField(body, name, parseValue(content)); }
  for (const value of repeated(args, 'raw-field')) { const [name, content] = parsePair(value); assignField(body, name, content); }
  for (const name of suppliedAliases) assignField(body, aliases[name]!, name === 'draft' ? true : flag(args, name)!);
  return Object.keys(body).length ? body : undefined;
}

function queryFields(path: string, args: Arguments, values?: unknown): string {
  const url = new URL(path, 'https://api.gitknot.com');
  for (const value of repeated(args, 'query')) { const [name, content] = parsePair(value, 'query'); url.searchParams.append(name, content); }
  for (const name of ['limit', 'cursor']) if (flag(args, name)) url.searchParams.set(name, flag(args, name)!);
  if (values && typeof values === 'object' && !Array.isArray(values)) {
    for (const [name, value] of Object.entries(values)) url.searchParams.set(name, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return `${url.pathname}${url.search}`;
}

export function requestHeaders(args: Arguments): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const value of repeated(args, 'header')) {
    const delimiter = value.indexOf(':');
    if (delimiter < 1) throw new RunnerError('usage', 'Use --header "Header-Name: value".');
    const name = value.slice(0, delimiter).trim();
    const content = value.slice(delimiter + 1).trim();
    if (!/^[a-zA-Z0-9-]+$/.test(name) || /[\r\n\x00]/.test(content) || ['host', 'authorization', 'cookie'].includes(name.toLowerCase())) throw new RunnerError('usage', 'This header is invalid or managed by GitKnot authentication.');
    headers[name] = content;
  }
  const revision = flag(args, 'if-match');
  if (revision) {
    if (!/^"[^"\r\n]+"$/.test(revision)) throw new RunnerError('usage', '--if-match requires a strong ETag, including its double quotes.');
    headers['If-Match'] = revision;
  }
  return headers;
}

async function binaryBody(args: Arguments, signal: AbortSignal): Promise<(() => ReadableStream<Uint8Array>) | undefined> {
  if (!has(args, 'binary')) return undefined;
  const input = flag(args, 'input');
  if (!input || input === '-') throw new RunnerError('usage', 'Binary upload requires --input FILE so retries can reopen the exact input.');
  const path = resolve(input);
  const maximum = numberFlag(args, 'max-bytes', 268_435_456, 1, 4_294_967_296);
  const info = await stat(path);
  if (!info.isFile() || info.size > maximum) throw new RunnerError('input_limit', 'Binary upload must be a regular file within --max-bytes.');
  return () => {
    let bytes = 0;
    return (Readable.toWeb(createReadStream(path, { signal })) as ReadableStream<Uint8Array>).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maximum || bytes > info.size) throw new RunnerError('input_changed', 'The upload file grew beyond its declared length.');
        controller.enqueue(chunk);
      },
      flush() { if (bytes !== info.size) throw new RunnerError('input_changed', 'The upload file changed while it was being read.'); },
    }));
  };
}

const TERMINAL_SUCCESS = new Set(['completed', 'succeeded', 'passed', 'not_applicable']);
const TERMINAL_FAILURE = new Set(['failed', 'cancelled', 'timed_out', 'runner_unreachable', 'infrastructure_failed', 'dependency_blocked']);

export async function watchResource(client: GitKnotHttpClient, path: string, io: CliIO, args: Arguments, signal: AbortSignal): Promise<{ resource: unknown; code: number }> {
  const deadline = Date.now() + numberFlag(args, 'timeout', 600, 1, 86_400) * 1_000;
  let previous = '';
  while (!signal.aborted && Date.now() < deadline) {
    const response = await client.request<Record<string, unknown>>('GET', path, { signal, retryable: true });
    const resource = response.data;
    if (!resource || typeof resource !== 'object') throw new RunnerError('api_response_invalid', 'GitKnot did not return a resource state.');
    const status = String(resource.status ?? resource.state ?? 'unknown');
    if (status !== previous) { await write(io.stderr, `GitKnot: ${status}\n`); previous = status; }
    if (TERMINAL_SUCCESS.has(status)) return { resource, code: 0 };
    if (TERMINAL_FAILURE.has(status)) return { resource, code: 1 };
    await delay(Math.min(2_000, Math.max(1, deadline - Date.now())), undefined, { signal }).catch(() => {});
  }
  throw new RunnerError(signal.aborted ? 'cancelled' : 'watch_timeout', signal.aborted ? 'Watching was cancelled.' : 'The resource did not reach a terminal state before --timeout.');
}

function operationPath(data: unknown, location: string | null): string {
  if (location?.startsWith('/v1/')) return location;
  if (data && typeof data === 'object') {
    const resource = data as Record<string, unknown>;
    const operation = resource.operation && typeof resource.operation === 'object' ? resource.operation as Record<string, unknown> : null;
    // A planning response may expose both a pending run and its operation. Watch the returned resource itself.
    if (typeof resource.id === 'string' && /^run_[a-zA-Z0-9_-]+$/.test(resource.id)) return `/v1/runs/${resource.id}`;
    const id = operation?.id ?? resource.operation_id ?? resource.id;
    const workflowOperation = resource.resource_type === 'workflow_operation'
      || typeof resource.run_id === 'string' && ['run', 'rerun', 'cancel', 'approve', 'promote'].includes(String(resource.kind));
    if (workflowOperation && typeof id === 'string' && /^op_[a-zA-Z0-9_-]+$/.test(id)) return `/v1/workflow-operations/${id}`;
    if (typeof id === 'string' && /^(?:op|operation)_[a-zA-Z0-9_-]+$/.test(id)) return `/v1/operations/${id}`;
    if (typeof id === 'string' && /^run_[a-zA-Z0-9_-]+$/.test(id)) return `/v1/runs/${id}`;
  }
  throw new RunnerError('operation_unavailable', 'GitKnot did not identify the resource to watch.');
}

export async function sendApi(args: Arguments, io: CliIO, signal: AbortSignal, request: { method: string; path: string; fields?: Record<string, string>; body?: Record<string, unknown>; watch?: boolean; public?: boolean }): Promise<number> {
  // The API, including public signup/discovery endpoints, owns authentication requirements.
  const client = await apiClient(args, false);
  const method = (flag(args, 'method') ?? request.method).toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) throw new RunnerError('usage', 'Use a supported HTTP method.');
  const fields = await requestFields(args, io, request.fields, request.body);
  let path = queryFields(request.path, args, method === 'GET' || method === 'HEAD' ? fields : undefined);
  const bodyFactory = await binaryBody(args, signal);
  if (bodyFactory && (method === 'GET' || method === 'HEAD')) throw new RunnerError('usage', 'Binary bodies require an upload method.');
  if (bodyFactory && fields !== undefined) throw new RunnerError('usage', 'Binary upload cannot be combined with JSON fields.');
  const headers = requestHeaders(args);
  const options: RequestOptions = {
    signal, headers, timeout_ms: numberFlag(args, 'timeout', 120, 1, 86_400) * 1_000,
    max_bytes: numberFlag(args, 'max-bytes', 268_435_456, 1, 4_294_967_296), body_factory: bodyFactory,
    body: bodyFactory || method === 'GET' || method === 'HEAD' ? undefined : fields ?? (method === 'POST' ? {} : undefined),
    idempotency_key: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? flag(args, 'idempotency-key') ?? randomUUID() : undefined,
    retryable: method === 'GET' || method === 'HEAD' || !bodyFactory,
  };
  if (flag(args, 'output')) {
    if (has(args, 'paginate') || has(args, 'watch')) throw new RunnerError('usage', '--output cannot be combined with --paginate or --watch.');
    const digestValue = flag(args, 'sha256');
    const digest = digestValue ? (digestValue.startsWith('sha256:') ? digestValue : `sha256:${digestValue}`) : undefined;
    const size = flag(args, 'size') ? numberFlag(args, 'size', 0, 0) : undefined;
    const destination = resolve(flag(args, 'output')!);
    const downloaded = await client.download(path, destination, { digest, size_bytes: size }, { ...options, method });
    await print(io, { path: destination, ...downloaded }, has(args, 'json'));
    return 0;
  }
  const pages = numberFlag(args, 'max-pages', 10_000, 1, 100_000);
  const cursors = new Set<string>();
  let outputBytes = 0;
  for (let page = 0; page < pages; page += 1) {
    const response = await client.request(method, path, options);
    if (request.watch || has(args, 'watch')) {
      const target = method === 'GET' ? path : operationPath(response.data, response.headers.get('location'));
      const watched = await watchResource(client, target, io, args, signal);
      await print(io, watched.resource, has(args, 'json')); return watched.code;
    }
    const safeHeaders = Object.fromEntries([...response.headers.entries()].filter(([name]) => !['set-cookie', 'authorization', 'cookie'].includes(name.toLowerCase())));
    const value = has(args, 'include') ? { status: response.status, headers: safeHeaders, body: response.data } : response.data;
    outputBytes += Buffer.byteLength(JSON.stringify(value));
    if (outputBytes > options.max_bytes!) throw new RunnerError('output_limit', 'Paginated output exceeds --max-bytes. Continue from the last returned cursor.');
    await print(io, value, has(args, 'json') || has(args, 'paginate'));
    if (!has(args, 'paginate')) return 0;
    if (method !== 'GET' || !response.data || typeof response.data !== 'object' || !Array.isArray((response.data as { items?: unknown }).items)) throw new RunnerError('pagination_invalid', '--paginate requires a GET list endpoint.');
    const next = (response.data as { next_cursor?: unknown }).next_cursor;
    if (next === null || next === undefined) return 0;
    if (typeof next !== 'string' || cursors.has(next)) throw new RunnerError('pagination_invalid', 'GitKnot returned an invalid or repeated pagination cursor.');
    cursors.add(next);
    const url = new URL(path, client.origin); url.searchParams.set('cursor', next); path = `${url.pathname}${url.search}`;
  }
  throw new RunnerError('pagination_limit', 'Pagination reached --max-pages. Continue from the last returned cursor.');
}
