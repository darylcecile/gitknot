import { signInternalRequest, verifyInternalRequest } from '../../../packages/core/src/internal.ts';
import { boundedJson } from '../../../packages/git/src/protocol.ts';
import { GIT_NATIVE_SCOPE } from '../../../packages/git/src/types.ts';
import type { NativeSessionSpec, PublicationPermit } from '../../../packages/git/src/types.ts';
import { GitError, requireValue } from '../../../packages/git/src/errors.ts';
import { startNativeServer } from './server.ts';
import type { LfsImportTarget } from './lfs-import.ts';
import { diagnostic } from '../../../packages/core/src/errors.ts';
import { access, chmod, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';

const key = process.env.INTERNAL_SERVICE_KEY;
requireValue(key && key.length >= 32, 'native_configuration', 'The native internal service key is not configured.', 503);
const origin = process.env.GIT_CALLBACK_ORIGIN;
requireValue(origin && new URL(origin).protocol === 'https:', 'native_configuration', 'A trusted HTTPS Git callback origin is required.', 503);
requireValue(process.env.GIT_EGRESS_INTERCEPTED === '1', 'native_configuration', 'The production helper requires its trusted egress interceptor.', 503);
await access('/etc/cloudflare/certs/cloudflare-containers-ca.crt', constants.R_OK);
const deadline = Date.parse(process.env.GIT_HELPER_DEADLINE ?? '');
requireValue(Number.isFinite(deadline) && deadline > Date.now() && deadline - Date.now() <= 330_000, 'native_configuration', 'A bounded helper lifetime is required.', 503);
// This independent process deadline does not depend on Worker request consumers or DO alarms.
setTimeout(() => process.exit(0), deadline - Date.now()).unref();
let signingKey = process.env.GIT_SIGNING_KEY;
if (process.env.GIT_SIGNING_PRIVATE_KEY) {
  const secret = process.env.GIT_SIGNING_PRIVATE_KEY;
  requireValue(secret.length <= 16_384 && secret.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----') && !secret.includes('\0'),
    'native_signing_configuration', 'The trusted Git signing key is invalid.', 503);
  await mkdir('/var/lib/gitknot/signing', { mode: 0o700, recursive: true });
  signingKey = '/var/lib/gitknot/signing/platform';
  await writeFile(signingKey, secret.endsWith('\n') ? secret : `${secret}\n`, { mode: 0o600 });
  await chmod(signingKey, 0o600);
  delete process.env.GIT_SIGNING_PRIVATE_KEY;
}
const replay = new Map<string, number>();

async function callback<T>(spec: NativeSessionSpec, action: string, payload: unknown): Promise<T> {
  requireValue(spec.callback_url && new URL(spec.callback_url).origin === origin, 'invalid_callback', 'Invalid Git callback origin.', 503);
  const request = new Request(`${spec.callback_url}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publisher_id: spec.publisher_id, fence: spec.fence, ...payload as object }),
  });
  const response = await fetch(await signInternalRequest(request, key!, GIT_NATIVE_SCOPE), { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  const data = await boundedJson<T & { error?: { code: string; message: string } }>(response);
  if (!response.ok) throw new GitError(data.error?.code ?? 'publication_rejected', data.error?.message ?? 'The publication gate rejected this request.', response.status);
  return data;
}

const native = await startNativeServer({
  on_error(error) { console.error(JSON.stringify({ event: 'git.native.failed', diagnostic: diagnostic(error) })); },
  configuration: {
    mode: 'production', cache_root: '/var/lib/gitknot/cache', max_sessions: Number(process.env.GIT_MAX_SESSIONS ?? '4'),
    callback_origin: origin, signing_key: signingKey, signing_format: process.env.GIT_SIGNING_FORMAT === 'openpgp' ? 'openpgp' : 'ssh',
  },
  async authenticate(request) {
    await verifyInternalRequest(request, key!, GIT_NATIVE_SCOPE);
    const nonce = request.headers.get('x-gitknot-internal-nonce')!;
    for (const [id, expiry] of replay) if (expiry < Date.now()) replay.delete(id);
    requireValue(!replay.has(nonce) && replay.size < 10_000, 'service_request_replayed', 'This internal request was already received.', 409);
    replay.set(nonce, Date.now() + 120_000);
  },
  callbacks: {
    async validated(spec, evidence) { await callback(spec, 'validated', { evidence }); },
    permit(spec, evidence) { return callback<PublicationPermit>(spec, 'permit', { evidence_digest: evidence.digest }); },
    async result(spec, result) { await callback(spec, 'result', { result }); },
    async rejected(spec, reason, code) { await callback(spec, 'rejected', { reason, code }); },
  },
  lfs_import: {
    async reserve(spec, objects) {
      const request = new Request(`${origin}/internal/git/lfs-import/${spec.repository.id}/${spec.operation_id}/${spec.publisher_id}/batch`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objects }),
      });
      const response = await fetch(await signInternalRequest(request, key!, GIT_NATIVE_SCOPE), { redirect: 'error' });
      requireValue(response.ok, 'lfs_import_quota', 'LFS import admission was rejected.', 409);
      return (await boundedJson<{ objects: LfsImportTarget[] }>(response)).objects;
    },
    async upload(spec, target, body) {
      requireValue(target.upload_url && new URL(target.upload_url).origin === origin, 'lfs_upload_scope', 'Invalid internal LFS upload origin.', 503);
      const request = new Request(target.upload_url, { method: 'PUT', headers: { 'x-gitknot-content-sha256': target.oid,
        'content-type': 'application/octet-stream' }, body, duplex: 'half' } as RequestInit);
      const response = await fetch(await signInternalRequest(request, key!, GIT_NATIVE_SCOPE), { redirect: 'error', signal: AbortSignal.timeout(spec.policy.limits.max_work_ms) });
      await response.body?.cancel();
      requireValue(response.ok, 'lfs_import_upload', 'An LFS import upload failed its checksum or quota checks.', 409);
    },
  },
}, Number(process.env.PORT ?? '8080'));

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await native.close();
}
process.on('SIGTERM', () => { void stop().catch(() => { process.exitCode = 1; }); });
process.on('SIGINT', () => { void stop().catch(() => { process.exitCode = 1; }); });
