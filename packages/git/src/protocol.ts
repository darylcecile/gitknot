import { GitError, requireValue } from './errors.ts';
import type { RefUpdate } from './types.ts';

const encoder = new TextEncoder();

export function pktLine(value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  requireValue(bytes.length <= 65_516, 'protocol_error', 'Git packet exceeds its size limit.');
  const packet = new Uint8Array(bytes.length + 4);
  packet.set(encoder.encode((bytes.length + 4).toString(16).padStart(4, '0')));
  packet.set(bytes, 4);
  return packet;
}

export function parseRefCommand(line: string): RefUpdate {
  const match = /^([a-f0-9]{40}) ([a-f0-9]{40}) (refs\/[^\x00\r\n ]+)(?:\x00[^\r\n]*)?\n?$/u.exec(line);
  requireValue(match, 'protocol_error', 'Malformed Git ref update.');
  return { old_oid: match[1], new_oid: match[2], ref: match[3] };
}

export function limitStream(stream: ReadableStream<Uint8Array>, limit: number, code = 'pack_limit'): ReadableStream<Uint8Array> {
  let count = 0;
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      count += chunk.byteLength;
      if (count > limit) throw new GitError(code, 'Git transfer exceeds the configured byte limit.', 413);
      controller.enqueue(chunk);
    },
  }));
}

export async function boundedJson<T>(request: Pick<Request, 'body'>, limit = 2 * 1024 * 1024): Promise<T> {
  requireValue(request.body, 'invalid_json', 'A JSON request body is required.', 400);
  const bytes = await new Response(limitStream(request.body, limit, 'metadata_limit')).arrayBuffer();
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T; }
  catch { throw new GitError('invalid_json', 'Invalid JSON request.', 400); }
}

export async function digestJson(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function transactionRef(operationId: string): string {
  requireValue(/^[a-zA-Z0-9_-]{8,128}$/u.test(operationId), 'invalid_operation', 'Invalid Git operation ID.');
  return `refs/gitknot/transactions/${operationId}`;
}

export function safeGitProtocol(value: string | null): string {
  if (value === null || value === '') return '';
  requireValue(/^(?:version=[012])$/u.test(value), 'protocol_error', 'Unsupported Git protocol negotiation.', 400);
  return value;
}

export async function reviewEvidenceId(repoId: string, sourceRepoId: string, base: string, head: string): Promise<string> {
  return `git_ev_${await digestJson(['git-patch-id-verbatim-v1', repoId, sourceRepoId, base, head])}`;
}

export function reviewRefs(id: string): string[] {
  requireValue(/^git_ev_[a-f0-9]{64}$/u.test(id), 'invalid_review_evidence', 'Invalid retained review identity.');
  return ['base', 'head', 'merge-base'].map(part => `refs/gitknot/reviews/${id}/${part}`);
}
