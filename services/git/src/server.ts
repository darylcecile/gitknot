import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { base64url } from '../../../packages/core/src/crypto.ts';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { GitEvidence, GitMutation, NativeSessionSpec, NativeSessionTicket, PublicationPermit, PublicationResult, RefUpdate } from '../../../packages/git/src/types.ts';
import { DEFAULT_GIT_LIMITS, INTERNAL_REFS } from '../../../packages/git/src/types.ts';
import { boundedJson, safeGitProtocol, pktLine } from '../../../packages/git/src/protocol.ts';
import { gitErrorResponse, GitError, requireValue } from '../../../packages/git/src/errors.ts';
import { gitRuleSchema, validateRef } from '../../../packages/git/src/policy.ts';
import { browse, exportBundle, streamResponse } from './browse.ts';
import { authorizedReadView, createWorkingRepository, installReceiveHooks, readConfiguration, refreshRepository } from './repository.ts';
import type { NativeConfiguration, WorkingRepository } from './repository.ts';
import { ReceiveGuard } from './packets.ts';
import { inspectPublication, publishCanonical } from './publication.ts';
import { runMutation } from './mutations.ts';
import { inspectCollaboration } from './inspection.ts';
import { receiveRestore } from './restore.ts';
import { visibleRefs } from './browse.ts';
import { importLfs } from './lfs-import.ts';
import type { LfsImportBroker } from './lfs-import.ts';
import { copyStorageBaseline } from './storage-evidence.ts';

export interface NativeCallbacks {
  validated(spec: NativeSessionSpec, evidence: GitEvidence): Promise<void>;
  permit(spec: NativeSessionSpec, evidence: GitEvidence): Promise<PublicationPermit>;
  result(spec: NativeSessionSpec, result: PublicationResult): Promise<void>;
  rejected(spec: NativeSessionSpec, reason: string, code?: string): Promise<void>;
}

export interface NativeServiceOptions {
  configuration: NativeConfiguration;
  authenticate(request: Request): Promise<void>;
  callbacks: NativeCallbacks;
  lfs_import?: LfsImportBroker;
  on_error?(error: unknown): void;
}

interface Session {
  id: string;
  token_hash: Buffer;
  hook_token: string;
  spec: NativeSessionSpec;
  work: WorkingRepository;
  hooks?: string;
  used: boolean;
  timer: ReturnType<typeof setTimeout>;
  evidence?: GitEvidence;
  publishing?: Promise<PublicationResult>;
  result?: PublicationResult;
  publication_finalized: boolean;
  mutation?: GitMutation;
}

export class NativeGitService {
  private readonly options: NativeServiceOptions;
  private readonly sessions = new Map<string, Session>();
  private creating = 0;
  private origin = '';

  constructor(options: NativeServiceOptions) { this.options = options; }

  setOrigin(origin: string): void { this.origin = origin; }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/ready' && request.method === 'GET') return new Response('ready');
      if (url.pathname === '/internal/activity' && request.method === 'GET') {
        await this.options.authenticate(request);
        return Response.json({ active_sessions: this.sessions.size + this.creating });
      }
      if (url.pathname === '/internal/sessions' && request.method === 'POST') {
        await this.options.authenticate(request);
        return Response.json(await this.createSession(await boundedJson<NativeSessionSpec>(request)));
      }
      const match = /^\/(sessions|hooks)\/([a-f0-9]{32})\/([a-z-]+)$/u.exec(url.pathname);
      requireValue(match, 'not_found', 'Native Git endpoint not found.', 404);
      const session = this.sessions.get(match[2]);
      requireValue(session, 'session_not_found', 'Native Git session expired or was already consumed.', 404);
      if (match[1] === 'hooks') {
        requireValue(request.headers.get('authorization') === `GitKnot-Hook ${session.hook_token}`, 'invalid_service_credential', 'Invalid native hook capability.', 401);
        return await this.hook(session, match[3], request);
      }
      this.authorizeTicket(session, request);
      requireValue(!session.used, 'session_consumed', 'This native Git session was already consumed.', 409);
      session.used = true;
      try {
        const response = await this.action(session, match[3], request);
        return this.withCleanup(response, session);
      } catch (error) { await this.cleanup(session); throw error; }
    } catch (error) { this.options.on_error?.(error); return gitErrorResponse(error); }
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map(session => this.cleanup(session)));
  }

  private async createSession(spec: NativeSessionSpec): Promise<NativeSessionTicket> {
    const config = this.options.configuration;
    requireValue(this.sessions.size + this.creating < config.max_sessions, 'git_capacity', 'The trusted Git helper pool is busy. Retry shortly.', 429);
    requireValue(spec && ['read', 'receive', 'mutate', 'inspect'].includes(spec.mode), 'invalid_session', 'Invalid native Git session.');
    requireValue(spec.repository && /^[\w-]{1,128}$/u.test(spec.repository.id), 'invalid_session', 'Invalid repository identity.');
    validateRef(`refs/heads/${spec.repository.default_branch}`);
    gitRuleSchema.array().max(200).parse(spec.policy.rules);
    for (const [key, value] of Object.entries(spec.policy.limits)) {
      requireValue(key in DEFAULT_GIT_LIMITS && Number.isSafeInteger(value) && value > 0, 'invalid_limits', 'Invalid native Git limits.', 503);
    }
    requireValue(Object.keys(spec.policy.limits).length === Object.keys(DEFAULT_GIT_LIMITS).length, 'invalid_limits', 'Incomplete native Git limits.', 503);
    if (spec.mode === 'receive' || spec.mode === 'mutate') {
      requireValue(spec.operation_id && spec.publisher_id && spec.fence && spec.actor_id && spec.callback_url,
        'invalid_session', 'Publication identity is required.');
      requireValue(new URL(spec.callback_url).origin === config.callback_origin, 'invalid_callback', 'Invalid publication callback origin.', 503);
    }
    if (spec.candidate_read_ref) {
      validateRef(spec.candidate_read_ref, true);
      requireValue(spec.candidate_read_ref.startsWith(`${INTERNAL_REFS}candidates/`), 'invalid_candidate', 'Invalid candidate read scope.');
    }
    this.creating++;
    const id = crypto.randomUUID().replaceAll('-', '');
    const token = base64url(randomBytes(32));
    const deadline = Date.now() + spec.policy.limits.max_work_ms;
    let work: WorkingRepository | undefined;
    try {
      work = await createWorkingRepository(config, spec.policy.limits, deadline);
      if (spec.mode !== 'inspect') await refreshRepository(work, spec.remote, config, spec.repository.default_branch);
      if (spec.mode === 'read' || spec.mode === 'receive') {
        const source = work;
        try {
          work = await authorizedReadView(source, spec, config);
          if (spec.mode === 'receive') await copyStorageBaseline(source.git, work.git);
        } finally { await source.cleanup(); }
      }
      const session: Session = {
        id, token_hash: hash(token), hook_token: base64url(randomBytes(32)), spec, work,
        used: false, publication_finalized: false,
        timer: setTimeout(() => { void this.cleanup(session).catch(() => {}); }, Math.max(1, deadline - Date.now())),
      };
      session.timer.unref();
      if (spec.mode === 'receive' || spec.mode === 'mutate') {
        requireValue(this.origin, 'native_configuration', 'Native hook callback listener is unavailable.', 503);
        session.hooks = await installReceiveHooks(work, spec, `${this.origin}/hooks/${id}`, session.hook_token);
      }
      this.sessions.set(id, session);
      return { id, token, expires_at: new Date(deadline).toISOString() };
    } catch (error) { await work?.cleanup(); throw error; }
    finally { this.creating--; }
  }

  private async action(session: Session, action: string, request: Request): Promise<Response> {
    const url = new URL(request.url);
    const git = session.work.git;
    const readConfig = session.spec.candidate_read_ref ? [
      ...readConfiguration(), 'transfer.hideRefs=refs/', 'uploadpack.hideRefs=refs/',
      'transfer.hideRefs=!refs/heads/gitknot-candidate', 'uploadpack.hideRefs=!refs/heads/gitknot-candidate',
    ] : readConfiguration();
    if (action === 'upload-advertise' || action === 'receive-advertise') {
      requireValue(request.method === 'GET' && session.spec.mode === 'read', 'invalid_session', 'This session does not permit discovery.', 403);
      const service = action === 'upload-advertise' ? 'upload-pack' : 'receive-pack';
      const env = { GIT_PROTOCOL: safeGitProtocol(request.headers.get('git-protocol')) };
      const child = git.stream([service, '--stateless-rpc', '--advertise-refs', '.'], { config: readConfig, env });
      const response = streamResponse(child, { 'content-type': `application/x-git-${service}-advertisement` });
      // Protocol v2's own version greeting replaces the v0/v1 service prelude for upload-pack.
      if (service === 'upload-pack' && env.GIT_PROTOCOL === 'version=2') return response;
      return prepend(response, Buffer.concat([pktLine(`# service=git-${service}\n`), Buffer.from('0000')]));
    }
    if (action === 'upload') {
      requireValue(request.method === 'POST' && session.spec.mode === 'read' && request.body, 'invalid_session', 'This session does not permit Git reads.', 403);
      const input = boundedInput(request, Math.min(git.limits.max_pack_bytes, 4 * 1024 * 1024));
      const task = git.stream(['upload-pack', '--stateless-rpc', '.'], { input, config: readConfig, env: { GIT_PROTOCOL: safeGitProtocol(request.headers.get('git-protocol')) } });
      return streamResponse(task, { 'content-type': 'application/x-git-upload-pack-result' });
    }
    if (action === 'receive') {
      requireValue(request.method === 'POST' && session.spec.mode === 'receive' && request.body, 'invalid_session', 'This session does not permit Git writes.', 403);
      const input = Readable.fromWeb(request.body as never).pipe(new ReceiveGuard(git.limits));
      const task = git.stream(['receive-pack', '--stateless-rpc', '.'], { input, hooks: session.hooks, config: ['receive.procReceiveRefs=refs/'] });
      return streamResponse(task, { 'content-type': 'application/x-git-receive-pack-result' });
    }
    if (action === 'mutate') {
      requireValue(request.method === 'POST' && session.spec.mode === 'mutate', 'invalid_session', 'This session does not permit native mutations.', 403);
      const mutation = await boundedJson<GitMutation>(request, git.limits.max_metadata_bytes);
      session.mutation = mutation;
      const created = await runMutation(session.work, session.spec, mutation, session.hooks!, this.options.configuration);
      requireValue(session.result?.outcome === 'committed' && session.publication_finalized, 'publication_uncertain', 'The canonical publication must be reconciled.', 409);
      return Response.json({ ...session.result, ...created });
    }
    if (action === 'restore') {
      requireValue(request.method === 'POST' && session.spec.mode === 'mutate' && request.body, 'invalid_session', 'This session does not permit bundle restoration.', 403);
      await receiveRestore(session.work, session.spec, request.body, session.hooks!, this.options.configuration);
      if (session.spec.restore?.expected_refs.length) requireValue(session.publication_finalized && session.result?.outcome === 'committed', 'publication_uncertain', 'The restore publication requires reconciliation.', 409);
      return Response.json({ restored: true, result: session.result ?? null });
    }
    if (action === 'verify') {
      requireValue(request.method === 'POST' && session.spec.mode === 'read', 'invalid_session', 'This session does not permit repository verification.', 403);
      await git.run(['fsck', '--strict', '--full', '--no-reflogs', '--no-dangling']);
      const refs = (await visibleRefs(git)).map(({ ref, oid }) => ({ ref, oid }));
      for (const ref of session.spec.retained_refs ?? []) refs.push({ ref, oid: await git.text(['rev-parse', '--verify', '--end-of-options', ref]) });
      refs.sort((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
      const { expected_refs } = await boundedJson<{ expected_refs?: Array<{ ref: string; oid: string }> }>(request);
      const expected = expected_refs?.toSorted((a, b) => a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
      requireValue(!expected || refs.length === expected.length && refs.every((entry, index) => entry.ref === expected[index]!.ref && entry.oid === expected[index]!.oid),
        'ref_verification', 'Canonical refs differ from the expected inventory.', 409);
      return Response.json({ verified: true, objects_verified: true, refs });
    }
    if (action === 'inspect') {
      requireValue(request.method === 'POST' && session.spec.mode === 'inspect', 'invalid_session', 'This session does not permit inspection.', 403);
      const payload = await boundedJson<{ operation_id: string; evidence: GitEvidence }>(request);
      return Response.json(await inspectPublication(git, session.spec.remote, payload.operation_id, payload.evidence, this.options.configuration.local_authority_root));
    }
    if (action === 'collaboration') {
      requireValue(session.spec.mode === 'read' && request.method === 'POST', 'invalid_session', 'This session does not permit collaboration inspection.', 403);
      return inspectCollaboration(git, session.spec.repository.id, await boundedJson(request), this.options.configuration.local_authority_root);
    }
    requireValue(session.spec.mode === 'read' && request.method === 'GET', 'invalid_session', 'This session does not permit browsing.', 403);
    if (action === 'bundle') return exportBundle(git, session.spec.retained_refs);
    return browse(git, action, url.searchParams, session.spec.candidate_read_ref ? 'refs/heads/gitknot-candidate' : undefined);
  }

  private async hook(session: Session, action: string, request: Request): Promise<Response> {
    requireValue(request.method === 'POST', 'invalid_method', 'Native hooks require POST.', 405);
    if (action === 'rejected') {
      requireValue(!session.publishing, 'publication_state', 'A started publisher requires canonical reconciliation.', 409);
      const error = await boundedJson<{ code: string; message: string }>(request, 4096);
      requireValue(/^[a-z_]{1,64}$/u.test(error.code) && typeof error.message === 'string' && error.message.length <= 1000, 'invalid_rejection', 'Invalid native rejection evidence.');
      await this.options.callbacks.rejected(session.spec, error.message, error.code);
      return Response.json({ rejected: true });
    }
    if (action === 'validated') {
      requireValue(!session.evidence && !session.publishing, 'publication_state', 'This session has already been validated.', 409);
      const { evidence } = await boundedJson<{ evidence: GitEvidence }>(request);
      if (session.mutation?.kind === 'import') {
        const pointers = [...new Map(evidence.updates.flatMap(update => update.lfs_objects).map(object => [object.oid, object])).values()];
        if (pointers.length) {
          requireValue(this.options.lfs_import, 'lfs_import_unavailable', 'The private LFS import broker is unavailable.', 503);
          await importLfs(session.mutation.source, session.spec, pointers, this.options.lfs_import);
        }
      }
      await this.options.callbacks.validated(session.spec, evidence);
      session.evidence = evidence;
      return Response.json({ validated: true });
    }
    requireValue(action === 'publish' && session.evidence, 'publication_state', 'This session has no validated publication.', 409);
    const payload = await boundedJson<{ updates: RefUpdate[]; evidence_digest: string }>(request);
    requireValue(payload.evidence_digest === session.evidence.digest, 'publication_changed', 'Publication evidence changed.', 409);
    if (!session.publishing) session.publishing = this.publish(session);
    return Response.json(await session.publishing);
  }

  private async publish(session: Session): Promise<PublicationResult> {
    const evidence = session.evidence!;
    let permit: PublicationPermit;
    try {
      permit = await this.options.callbacks.permit(session.spec, evidence);
      requireValue(permit.operation_id === session.spec.operation_id && permit.publisher_id === session.spec.publisher_id
        && permit.remote.url === session.spec.remote.url, 'publication_permit', 'Invalid native publication permit.', 403);
    } catch {
      const result: PublicationResult = { operation_id: session.spec.operation_id!, outcome: 'rejected', marker_oid: null,
        refs: evidence.updates.map(({ ref, old_oid, new_oid }) => ({ ref, old_oid, new_oid })), report_status: [], proof: 'not_started',
        reason: 'Current publication policy rejected this operation before canonical Git was contacted.' };
      session.result = result;
      await this.options.callbacks.result(session.spec, result);
      session.publication_finalized = true;
      return result;
    }
    const result = await publishCanonical(session.work.git, permit, evidence, this.options.configuration.local_authority_root);
    session.result = result;
    await this.options.callbacks.result(session.spec, result);
    session.publication_finalized = result.outcome !== 'uncertain';
    return result;
  }

  private authorizeTicket(session: Session, request: Request): void {
    const token = request.headers.get('authorization')?.match(/^GitKnot-Session ([\w-]{43})$/u)?.[1];
    requireValue(token && timingSafeEqual(hash(token), session.token_hash), 'invalid_service_credential', 'Invalid native Git session capability.', 401);
    requireValue(Date.now() < session.work.git.deadline, 'session_expired', 'Native Git session expired.', 410);
  }

  private withCleanup(response: Response, session: Session): Response {
    if (!response.body) { void this.cleanup(session); return response; }
    const reader = response.body.getReader();
    const cleanup = () => this.cleanup(session);
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (!result.done) { controller.enqueue(result.value); return; }
          await cleanup();
          controller.close();
        } catch (error) { await cleanup(); controller.error(error); }
      },
      async cancel(reason) { await reader.cancel(reason); await cleanup(); },
    }), { status: response.status, headers: response.headers });
  }

  private async cleanup(session: Session): Promise<void> {
    if (!this.sessions.delete(session.id)) return;
    clearTimeout(session.timer);
    // A caller disconnect never starts a replacement while an old publisher is still running.
    await session.publishing?.catch(() => {});
    if ((session.spec.mode === 'receive' || session.spec.mode === 'mutate') && !session.publishing) {
      await this.options.callbacks.rejected(session.spec, 'Native receive or validation was rejected before publication.').catch(() => {});
    }
    await session.work.cleanup();
  }
}

export async function startNativeServer(options: NativeServiceOptions, port = 8080, host = '0.0.0.0'): Promise<{ server: Server; service: NativeGitService; origin: string; close(): Promise<void> }> {
  const service = new NativeGitService(options);
  const server = createServer({ requestTimeout: DEFAULT_GIT_LIMITS.max_work_ms + 30_000, headersTimeout: 15_000 }, async (request, response) => {
    try { await sendNodeResponse(response, await service.fetch(nodeRequest(request))); }
    catch { if (response.headersSent) response.destroy(); else { response.writeHead(503); response.end('Git transfer interrupted.'); } }
  });
  server.maxRequestsPerSocket = 100;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const address = server.address();
  requireValue(address && typeof address !== 'string', 'native_listener', 'Native Git listener did not start.', 503);
  const origin = `http://127.0.0.1:${address.port}`;
  service.setOrigin(origin);
  return { server, service, origin, async close() {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

function nodeRequest(request: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (value) for (const part of value) headers.append(name, part);
  }
  const method = request.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : Readable.toWeb(request) as ReadableStream<Uint8Array>;
  return new Request(new URL(request.url ?? '/', `http://${request.headers.host ?? 'git-native.internal'}`), {
    method, headers, body, ...(body ? { duplex: 'half' } : {}),
  } as RequestInit);
}

async function sendNodeResponse(target: ServerResponse, response: Response): Promise<void> {
  target.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) await pipeline(Readable.fromWeb(response.body as never), target);
  else target.end();
}

function hash(value: string): Buffer { return createHash('sha256').update(value).digest(); }

function boundedInput(request: Request, max: number): Readable {
  let size = 0;
  return Readable.fromWeb(request.body! as never).pipe(new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(size <= max ? undefined : new GitError('request_limit', 'Git protocol request exceeds its byte limit.', 413), chunk);
    },
  }));
}

function prepend(response: Response, prefix: Uint8Array): Response {
  const reader = response.body!.getReader();
  let sent = false;
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sent) { sent = true; controller.enqueue(prefix); return; }
      const next = await reader.read();
      if (next.done) controller.close(); else controller.enqueue(next.value);
    },
    cancel(reason) { return reader.cancel(reason); },
  }), { headers: response.headers });
}
