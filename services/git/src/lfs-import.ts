import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { Readable } from 'node:stream';
import { publicAddress } from './remote.ts';
import type { GitRemote, NativeSessionSpec } from '../../../packages/git/src/types.ts';
import { boundedJson, limitStream } from '../../../packages/git/src/protocol.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';

export interface LfsImportTarget { oid: string; size: number; upload_id?: string; upload_url?: string }
export interface LfsImportBroker {
  reserve(spec: NativeSessionSpec, objects: Array<{ oid: string; size: number }>): Promise<LfsImportTarget[]>;
  upload(spec: NativeSessionSpec, target: LfsImportTarget, body: ReadableStream<Uint8Array>): Promise<void>;
}

export async function importLfs(source: GitRemote, spec: NativeSessionSpec, objects: Array<{ oid: string; size: number }>, broker: LfsImportBroker): Promise<void> {
  if (!objects.length) return;
  requireValue(source.authority === 'artifacts', 'lfs_import_source', 'External LFS imports require a public HTTPS source.');
  const sourceUrl = new URL(source.url);
  const base = sourceUrl.href.replace(/\/$/u, '').replace(/(?:\.git)?$/u, '.git');
  for (let offset = 0; offset < objects.length; offset += spec.policy.limits.lfs_batch_objects) {
    const page = objects.slice(offset, offset + spec.policy.limits.lfs_batch_objects);
    const targets = await broker.reserve(spec, page);
    const missing = targets.filter(target => !!target.upload_url);
    if (!missing.length) continue;
    const response = await publicHttps(`${base}/info/lfs/objects/batch`, 'POST', {
      'content-type': 'application/vnd.git-lfs+json', accept: 'application/vnd.git-lfs+json',
      ...(source.authorization ? { authorization: source.authorization } : {}),
    }, JSON.stringify({ operation: 'download', transfers: ['basic'], hash_algo: 'sha256', objects: missing.map(({ oid, size }) => ({ oid, size })) }));
    requireValue(response.ok, 'lfs_source_denied', 'The source LFS service did not authorize the private import.', 409);
    const batch = await boundedJson<{ objects: Array<{ oid: string; size: number; error?: unknown; actions?: { download?: { href: string; header?: Record<string, string> } } }> }>(response, spec.policy.limits.max_metadata_bytes);
    requireValue(Array.isArray(batch.objects), 'lfs_source_invalid', 'The source LFS batch response is invalid.', 409);
    for (const target of missing) {
      const entries = batch.objects.filter(object => object.oid === target.oid && object.size === target.size);
      requireValue(entries.length === 1 && !entries[0].error && entries[0].actions?.download, 'lfs_source_missing', 'The source repository is missing an LFS object.', 409);
      const action = entries[0].actions!.download!;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(action.header ?? {})) {
        requireValue(['authorization', 'accept', 'x-amz-content-sha256', 'x-amz-date', 'x-amz-security-token'].includes(name.toLowerCase())
          && typeof value === 'string' && value.length <= 8192 && !/[\r\n\0]/u.test(value), 'lfs_source_header', 'The source returned an unsupported LFS download header.', 409);
        headers[name] = value;
      }
      const downloaded = await publicHttps(action.href, 'GET', headers);
      requireValue(downloaded.ok && downloaded.body, 'lfs_source_missing', 'An LFS source object could not be downloaded.', 409);
      await broker.upload(spec, target, limitStream(downloaded.body, target.size, 'lfs_object_limit'));
    }
  }
}

/** DNS-pinned HTTPS with no redirect following; source-supplied object URLs cannot target a private network. */
async function publicHttps(value: string, method: string, headers: Record<string, string>, body?: string): Promise<Response> {
  const url = new URL(value);
  requireValue(url.protocol === 'https:' && (!url.port || url.port === '443') && !url.username && !url.password && !url.hash, 'lfs_source_url', 'The source returned an invalid HTTPS LFS URL.', 409);
  const intercepted = process.env.GIT_EGRESS_INTERCEPTED === '1';
  const addresses = intercepted ? [] : await lookup(url.hostname, { all: true });
  requireValue(intercepted || addresses.length > 0 && addresses.every(result => publicAddress(result.address)), 'lfs_source_url', 'The source LFS host is not publicly routable.', 409);
  const address = addresses[0];
  return new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(url, { method, headers, timeout: 30_000,
      ...(address ? { family: address.family, lookup: (_host: string, _options: unknown, callback: (error: Error | null, address: string, family: number) => void) => callback(null, address.address, address.family) } : {}) }, response => {
      const output = new Headers();
      if (response.headers['content-type']) output.set('content-type', response.headers['content-type']);
      resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status: response.statusCode ?? 502, headers: output }));
    });
    request.once('error', reject);
    request.once('timeout', () => request.destroy(new Error('LFS source timed out.')));
    request.end(body);
  });
}
