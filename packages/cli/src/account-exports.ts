import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { RunnerError } from '../../runner/src/index.ts';
import type { ApiResponse, GitKnotHttpClient, RequestOptions } from '../../runner/src/index.ts';
import { requestFields, requestHeaders, sendApi } from './api.ts';
import { checkFlags, flag, has, identifier, numberFlag } from './args.ts';
import type { Arguments } from './args.ts';
import { apiClient } from './config.ts';
import { print, write } from './io.ts';
import type { CliIO } from './io.ts';

const exportId = z.string().regex(/^aexport_[A-Za-z0-9_-]{1,120}$/);
const date = z.iso.datetime();
const resourceSchema = z.object({
  id: exportId, account_id: z.string().min(1).max(128), schema_version: z.literal(1),
  state: z.enum(['queued', 'capturing', 'verifying', 'completed', 'failed', 'deleting', 'deleted', 'expired']),
  revision: z.number().int().positive(), created_at: date, expires_at: date,
  checksum_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), size_bytes: z.number().int().nonnegative().nullable(),
  coverage: z.object({ complete: z.boolean(), repository_count: z.number().int().nonnegative(),
    verified_repository_count: z.number().int().nonnegative(), account_snapshot_at: date.nullable() }),
  operation: z.object({ id: z.string().regex(/^op_[A-Za-z0-9_-]+$/), kind: z.literal('account.export'),
    status: z.string().min(1).max(64), phase: z.string().max(128), revision: z.number().int().positive() }).nullable(),
  download_path: z.string().max(2048).nullable(),
  error: z.object({ code: z.string().max(128), message: z.string().max(4096) }).nullable().optional(),
});
type ExportResource = z.infer<typeof resourceSchema>;
type ExportResponse = ApiResponse<ExportResource>;
type WatchGoal = 'completed' | 'deleted';
const commonFlags = ['account', 'repo', 'header', 'include', 'timeout', 'max-bytes'];
const actionFlags: Record<string, string[]> = {
  create: ['input', 'field', 'raw-field', 'idempotency-key', 'watch'],
  list: ['limit', 'cursor', 'paginate', 'max-pages'],
  show: ['watch'], view: ['watch'], watch: [],
  download: ['output', 'watch'], delete: ['if-match', 'idempotency-key', 'watch'],
};

function accountScope(args: Arguments): string | null {
  const account = flag(args, 'account'), repo = flag(args, 'repo');
  if (account && repo) throw new RunnerError('usage', 'Select one export scope with --account or --repo.');
  if (repo) return null;
  if (account) return account;
  if (process.env.GITKNOT_REPO || args.words[1] === 'watch' && args.words[2]?.startsWith('op_')) return null;
  return process.env.GITKNOT_ACCOUNT ?? null;
}

function exportResponse(response: ApiResponse<unknown>, account: string, expectedId?: string): ExportResponse {
  const parsed = resourceSchema.safeParse(response.data);
  if (!parsed.success || parsed.data.account_id !== account || expectedId && parsed.data.id !== expectedId) throw new RunnerError('account_export_invalid', 'GitKnot did not return the requested account export metadata.');
  const value = parsed.data;
  if (value.coverage.verified_repository_count > value.coverage.repository_count) throw new RunnerError('account_export_invalid', 'The export coverage counts are inconsistent.');
  return { ...response, data: value };
}

function requestOptions(args: Arguments, signal: AbortSignal, deadline: number): RequestOptions {
  return { signal, headers: requestHeaders(args), timeout_ms: Math.max(1, deadline - Date.now()), retryable: true,
    max_bytes: numberFlag(args, 'max-bytes', 268_435_456, 1, Number.MAX_SAFE_INTEGER) };
}

async function readExport(client: GitKnotHttpClient, path: string, account: string, id: string, args: Arguments, signal: AbortSignal, deadline: number): Promise<ExportResponse> {
  const options = requestOptions(args, signal, deadline), headers = new Headers(options.headers);
  headers.delete('if-match');
  return exportResponse(await client.request('GET', path, { ...options, headers: Object.fromEntries(headers) }), account, id);
}

function terminalCode(value: ExportResource, goal: WatchGoal): number | null {
  if (goal === 'deleted') return value.state === 'deleted' ? 0 : ['failed', 'expired'].includes(value.state) ? 1 : null;
  if (value.state === 'completed') return value.coverage.complete && value.coverage.repository_count === value.coverage.verified_repository_count ? 0 : 1;
  if (['failed', 'deleting', 'deleted', 'expired'].includes(value.state) || ['failed', 'cancelled'].includes(value.operation?.status ?? '')) return 1;
  return null;
}

async function watchExport(client: GitKnotHttpClient, initial: ExportResponse, path: string, goal: WatchGoal, args: Arguments, io: CliIO, signal: AbortSignal, deadline: number): Promise<{ response: ExportResponse; code: number }> {
  let response = initial, previous = '';
  while (!signal.aborted && Date.now() < deadline) {
    const value = response.data, progress = `${value.state} (${value.coverage.verified_repository_count}/${value.coverage.repository_count} repositories verified)`;
    if (progress !== previous) { await write(io.stderr, `GitKnot account export: ${progress}\n`); previous = progress; }
    const code = terminalCode(value, goal);
    if (code !== null) return { response, code };
    await delay(Math.min(2000, Math.max(1, deadline - Date.now())), undefined, { signal }).catch(() => {});
    if (!signal.aborted && Date.now() < deadline) response = await readExport(client, path, value.account_id, value.id, args, signal, deadline);
  }
  throw new RunnerError(signal.aborted ? 'cancelled' : 'watch_timeout', signal.aborted ? 'Watching was cancelled.' : 'The account export did not reach its verified terminal state before --timeout.');
}

async function printExport(response: ExportResponse, args: Arguments, io: CliIO): Promise<void> {
  const headers = Object.fromEntries([...response.headers].filter(([name]) => !['set-cookie', 'authorization', 'cookie'].includes(name.toLowerCase())));
  await print(io, has(args, 'include') ? { status: response.status, headers, body: response.data } : response.data, has(args, 'json'));
}

async function mutationKey(args: Arguments, io: CliIO): Promise<string> {
  const supplied = flag(args, 'idempotency-key'), key = supplied ?? randomUUID();
  if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new RunnerError('usage', '--idempotency-key requires 1–128 visible ASCII characters.');
  if (!supplied) await write(io.stderr, `GitKnot account export idempotency key: ${key}\n`);
  return key;
}

async function createExport(client: GitKnotHttpClient, account: string, collection: string, args: Arguments, io: CliIO, signal: AbortSignal, deadline: number): Promise<ExportResponse> {
  const body = await requestFields(args, io);
  if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)) throw new RunnerError('usage', 'Account export creation accepts only an empty JSON object.');
  return exportResponse(await client.request('POST', collection, { ...requestOptions(args, signal, deadline), body: {}, idempotency_key: await mutationKey(args, io) }), account);
}

async function deleteExport(client: GitKnotHttpClient, account: string, path: string, id: string, args: Arguments, io: CliIO, signal: AbortSignal, deadline: number): Promise<ExportResponse> {
  const options = requestOptions(args, signal, deadline), etag = new Headers(options.headers).get('if-match');
  if (!etag || !/^"[^"\r\n]+"$/.test(etag)) throw new RunnerError('usage', 'Account export deletion requires --if-match with the strong resource ETag from export show --include.');
  return exportResponse(await client.request('DELETE', path, { ...options, idempotency_key: await mutationKey(args, io) }), account, id);
}

async function downloadExport(client: GitKnotHttpClient, response: ExportResponse, path: string, args: Arguments, io: CliIO, signal: AbortSignal, deadline: number): Promise<number> {
  const value = response.data, output = flag(args, 'output');
  if (!output) throw new RunnerError('usage', 'Account export download requires --output FILE.');
  if (value.state !== 'completed' || !value.coverage.complete || value.coverage.repository_count !== value.coverage.verified_repository_count
    || value.checksum_sha256 === null || value.size_bytes === null) throw new RunnerError('account_export_not_ready', 'The account export must be completed with verified full coverage before download.');
  if (Date.parse(value.expires_at) <= Date.now()) throw new RunnerError('account_export_expired', 'This account export has expired.');
  if (value.download_path !== `${path}/download`) throw new RunnerError('account_export_invalid', 'The download path does not belong to the selected account export.');
  const destination = resolve(output);
  const downloaded = await client.download(value.download_path, destination, { digest: `sha256:${value.checksum_sha256}`, size_bytes: value.size_bytes,
    content_type: 'application/x-tar', etag: `"${value.checksum_sha256}"` }, requestOptions(args, signal, deadline));
  await print(io, { id: value.id, account_id: value.account_id, path: destination, ...downloaded }, has(args, 'json'));
  return 0;
}

/** Account scope selects the complete account-export resource, including its cleanup state. */
export async function accountExportCommand(args: Arguments, io: CliIO, signal: AbortSignal): Promise<number | null> {
  const action = args.words[1];
  if (!action || !Object.hasOwn(actionFlags, action)) return null;
  const account = accountScope(args);
  if (!account) return null;
  checkFlags(args, [...commonFlags, ...actionFlags[action]!]);
  const collection = `/v1/accounts/${identifier(account, 'account ID (--account)')}/exports`;
  const creation = action === 'create', listing = action === 'list';
  if (args.words.length !== (creation || listing ? 2 : 3)) throw new RunnerError('usage', creation || listing ? 'This account export command takes no resource ID.' : 'Supply the account export ID.');
  const id = creation || listing ? undefined : exportId.safeParse(args.words[2]);
  if (id && !id.success) throw new RunnerError('usage', 'Use the account export resource ID beginning with aexport_.');
  if (listing) return sendApi(args, io, signal, { method: 'GET', path: collection });
  if (action === 'download' && !flag(args, 'output')) throw new RunnerError('usage', 'Account export download requires --output FILE.');
  const client = await apiClient(args), deadline = Date.now() + numberFlag(args, 'timeout', 600, 1, 86_400) * 1000;
  const resourceId = id?.data, path = resourceId ? `${collection}/${resourceId}` : collection;
  let response = creation ? await createExport(client, account, collection, args, io, signal, deadline)
    : action === 'delete' ? await deleteExport(client, account, path, resourceId!, args, io, signal, deadline)
    : await readExport(client, path, account, resourceId!, args, signal, deadline);
  if (action === 'delete' && !['deleting', 'deleted'].includes(response.data.state)) throw new RunnerError('account_export_cleanup_unconfirmed', 'GitKnot did not confirm the requested export cleanup. Retry with the same idempotency key and resource ETag.');
  let code = creation ? terminalCode(response.data, 'completed') ?? 0 : 0;
  if (action === 'watch' || has(args, 'watch')) {
    const goal = action === 'delete' || !creation && action !== 'download' && ['deleting', 'deleted'].includes(response.data.state) ? 'deleted' : 'completed';
    const result = await watchExport(client, response, `${collection}/${response.data.id}`, goal, args, io, signal, deadline);
    response = result.response; code = result.code;
  }
  if (action === 'download' && code === 0) return downloadExport(client, response, path, args, io, signal, deadline);
  await printExport(response, args, io);
  return code;
}
