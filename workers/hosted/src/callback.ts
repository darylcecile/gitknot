import { ApiError, readBounded } from '@gitknot/core';
import { signCallbackRequest } from '@gitknot/execution/remote/protocol';
import type { RemoteAttemptGrant, RemoteStoredObject } from '@gitknot/execution/remote/protocol';
import { LIMITS } from './types.ts';
import type { HostedEnv } from './types.ts';
import { requireCallbackOrigin } from './validation.ts';

export class RemoteCallbacks {
  constructor(private readonly env: HostedEnv, readonly grant: RemoteAttemptGrant) {
    requireCallbackOrigin(env, grant.callback.origin);
  }

  async json<T>(action: string, body: object = {}): Promise<T> {
    const request = new Request(this.url(action), { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, generation: this.grant.generation, plan_digest: this.grant.plan_digest }),
      signal: AbortSignal.timeout(LIMITS.callback_ms),
    });
    return this.responseJson<T>(await this.send(request));
  }

  async download(action: 'input' | 'cache-read', objectId: string): Promise<Response> {
    const url = this.url(action);
    url.searchParams.set('generation', String(this.grant.generation));
    url.searchParams.set('plan_digest', this.grant.plan_digest);
    url.searchParams.set('object_id', objectId);
    return this.send(new Request(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(120_000) }));
  }

  async snapshot(id: string, part: 'archive' | 'metadata', source: ReadableStream<Uint8Array>, size: number, sha256: string): Promise<RemoteStoredObject> {
    const url = this.url('snapshot-upload');
    url.searchParams.set('generation', String(this.grant.generation));
    url.searchParams.set('plan_digest', this.grant.plan_digest);
    url.searchParams.set('snapshot_id', id);
    url.searchParams.set('snapshot_part', part);
    const request = new Request(url, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(size), 'x-gitknot-content-sha256': sha256,
        'x-gitknot-generation': String(this.grant.generation), 'x-gitknot-plan-digest': this.grant.plan_digest,
        'x-gitknot-snapshot-id': id, 'x-gitknot-snapshot-part': part },
      body: source, signal: AbortSignal.timeout(120_000), duplex: 'half',
    } as RequestInit);
    return this.responseJson<RemoteStoredObject>(await this.send(request));
  }

  private url(action: string): URL {
    if (!/^[a-z-]+$/.test(action)) throw new TypeError('Invalid callback action.');
    // Recheck on replay too, including an already-created durable outbox client.
    const origin = requireCallbackOrigin(this.env, this.grant.callback.origin);
    return new URL(`/internal/hosted/attempts/${this.grant.attempt_id}/${action}`, origin);
  }

  private async send(request: Request): Promise<Response> {
    let response: Response;
    try { response = await fetch(await signCallbackRequest(request, this.grant.callback.token)); }
    catch { throw new ApiError(503, 'callback_unconfirmed', 'The control plane callback was not confirmed.'); }
    if (!response.ok) {
      const action = new URL(request.url).pathname.split('/').at(-1);
      let code: unknown;
      try {
        const body = JSON.parse(new TextDecoder().decode(await readBounded(response.body, 16384))) as { error?: { code?: unknown } };
        code = body.error?.code;
      } catch { /* Responses and exception text are never retained or propagated. */ }
      const quotas = ['log_quota_exceeded', 'output_quota_exceeded', 'snapshot_quota_exceeded', 'egress_quota_exceeded'];
      if (typeof code === 'string' && quotas.includes(code)) throw new ApiError(413, code, 'The attempt exhausted a control-plane resource quota.');
      if ([413, 429].includes(response.status) && ['log', 'output', 'snapshot-upload'].includes(action ?? '')) {
        const kind = action === 'log' ? 'log' : action === 'output' ? 'output' : 'snapshot';
        throw new ApiError(413, `${kind}_quota_exceeded`, 'The attempt exhausted a control-plane resource quota.');
      }
      throw new ApiError(response.status >= 500 ? 503 : 409, response.status >= 500 ? 'callback_unconfirmed' : 'attempt_fenced',
        response.status >= 500 ? 'The control plane callback was not confirmed.' : 'The control plane no longer permits this attempt operation.');
    }
    return response;
  }

  private async responseJson<T>(response: Response): Promise<T> {
    try { return JSON.parse(new TextDecoder().decode(await readBounded(response.body, LIMITS.grant_bytes))) as T; }
    catch { throw new ApiError(502, 'callback_invalid', 'The control plane returned an invalid callback response.'); }
  }
}
