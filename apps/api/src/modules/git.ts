import { z } from 'zod';
import { ApiError, authorize, database, etag, expectedRevision, getRepository, identityDatabase, jsonBody, many, mutate, newId, now, one, requirePrincipal, route, sha256, stmt } from '@gitknot/core';
import type { App, AppContext, IdempotencyOptions, IdempotencyRecord, Principal, Repository, RequestAuthorization } from '@gitknot/core';
import { GitError, gitServiceJson, gitServiceRequest, handleLfs, runGitOperation, validatePath, validateRef, ZERO_OID } from '@gitknot/git';
import type { CandidateContext, GitAuthor, GitMutation, PublicGitOperation } from '@gitknot/git';
import { withRepositoryBarrier } from './repositories/shared.ts';

const oid = z.string().regex(/^[a-f0-9]{40}$/u);
const fullRef = z.string().max(1024).refine(value => { try { validateRef(value); return true; } catch { return false; } }, 'Use a valid full Git ref.');
const path = z.string().max(4096).refine(value => { try { validatePath(value); return true; } catch { return false; } }, 'Use a repository-relative path.');
const updateSchema = z.object({ ref: fullRef, old_oid: oid, new_oid: oid }).strict();
const refSchema = z.object({ updates: z.array(updateSchema).min(1).max(16) }).strict();
const editSchema = z.object({
  ref: fullRef, expected_oid: oid, message: z.string().min(1).max(64 * 1024),
  edits: z.array(z.object({ path, content_base64: z.string().max(2 * 1024 * 1024).optional(),
    delete: z.boolean().optional(), mode: z.enum(['100644', '100755']).optional() }).strict()).min(1).max(1000),
}).strict();
const candidateSchema = z.object({
  source_repo_id: z.string().max(128), source_oid: oid, target_ref: fullRef, target_oid: oid,
  strategy: z.enum(['merge', 'squash', 'rebase', 'ff-only']), pull_request_id: z.string().max(128).optional(),
  message: z.string().min(1).max(64 * 1024).default('Merge proposed changes'),
}).strict();

interface CandidateRow extends CandidateContext {
  repo_id: string; candidate_oid: string | null; policy_revision: number; actor_id: string; state: string;
  revision: number; created_at: string; updated_at: string; internal_ref: string;
}

export function registerGitRoutes(app: App): void {
  const base = '/v1/repos/:repoId';
  for (const [suffix, action] of [
    ['refs', 'refs'], ['commits', 'commits'], ['files', 'tree'], ['raw', 'raw'],
    ['diff', 'diff'], ['compare', 'compare'], ['archives', 'archive'],
  ] as const) {
    route(app, 'GET', `${base}/${suffix}`, { summary: `Read repository Git ${suffix}`, tags: ['git'], capability: 'contents.read',
      streaming: ['raw', 'diff', 'archive'].includes(action) }, api(async c => {
      const repository = await getRepository(c, c.req.param('repoId')!);
      return browseRequest(c, repository, action, Object.fromEntries(new URL(c.req.url).searchParams));
    }));
  }
  route(app, 'GET', `${base}/commits/:oid`, { summary: 'Read a repository-associated native Git commit', tags: ['git'], capability: 'contents.read' }, api(async c => {
    const repository = await getRepository(c, c.req.param('repoId')!);
    const commit = oid.parse(c.req.param('oid'));
    return browseRequest(c, repository, 'commit', { ref: commit });
  }));
  route(app, 'GET', `${base}/trees/:oid`, { summary: 'Read a repository-associated Git tree', tags: ['git'], capability: 'contents.read' }, api(async c => {
    const repository = await getRepository(c, c.req.param('repoId')!);
    return browseRequest(c, repository, 'tree', { ...Object.fromEntries(new URL(c.req.url).searchParams), oid: oid.parse(c.req.param('oid')) });
  }));
  route(app, 'POST', `${base}/refs`, { summary: 'Publish an exact conditional atomic ref transaction', tags: ['git'], body: refSchema, capability: 'contents.push', idempotency: gitIdempotency('refs') }, api(async c => {
    const repository = await getRepository(c, c.req.param('repoId')!);
    repositoryRevision(c, repository);
    const input = await jsonBody(c, refSchema);
    return mutationResponse(c, repository, { kind: 'refs', updates: input.updates });
  }));
  route(app, 'POST', `${base}/files`, { summary: 'Commit browser file edits through the protected Git publication gate', tags: ['git'], body: editSchema, capability: 'contents.push', idempotency: gitIdempotency('edit'),
    parameters: [{ name: 'If-Match', in: 'header', required: true, schema: { type: 'string' }, description: 'The quoted expected branch commit OID, or the zero OID when creating an empty branch.' }] }, api(async c => {
    const repository = await getRepository(c, c.req.param('repoId')!);
    const input = await jsonBody(c, editSchema);
    if (!c.req.header('if-match')) throw new ApiError(428, 'precondition_required', 'Send the quoted expected commit OID in If-Match.');
    if (c.req.header('if-match') !== etag(input.expected_oid)) throw new ApiError(412, 'revision_conflict', 'If-Match must agree with the expected branch commit.');
    return mutationResponse(c, repository, { kind: 'edit', ...input, author: await commitAuthor(c) });
  }));
  route(app, 'GET', `${base}/git/operations/:id`, { summary: 'Inspect durable Git publication and reconciliation status', tags: ['git'], capability: 'contents.read' }, api(async c => {
    const repository = await getRepository(c, c.req.param('repoId')!);
    const publication = await one<{ source_repo_id: string | null }>(database(c), 'SELECT source_repo_id FROM git_publications WHERE repo_id=? AND id=?', repository.id, c.req.param('id'));
    if (publication?.source_repo_id) await getRepository(c, publication.source_repo_id);
    return gitServiceRequest(c.env, `/internal/git/repositories/${repository.id}/operations/${encodeURIComponent(c.req.param('id')!)}`);
  }));
  route(app, 'GET', `${base}/git/bundle`, { summary: 'Export every customer Git ref as a verified native bundle', tags: ['git'], capability: 'repositories.export', streaming: true }, api(async c => {
    const repository = await getRepository(c, c.req.param('repoId')!, 'repositories.export');
    return checkedResponse(await gitServiceRequest(c.env, `/internal/git/repositories/${repository.id}/export`, { actor: requirePrincipal(c) }));
  }));
  registerCandidateRoutes(app, base);
  registerSigningKeys(app, base);
  for (const [method, suffix] of [
    ['POST', '/objects/batch'], ['PUT', '/uploads/:id'], ['POST', '/uploads/:id/verify'], ['GET', '/objects/:oid'], ['HEAD', '/objects/:oid'],
  ]) {
    route(app, method, `${base}/lfs${suffix}`, { summary: 'Transfer repository-scoped Git LFS objects', tags: ['lfs'], streaming: true, idempotent: false }, api(async c => {
      const repository = await getRepository(c, c.req.param('repoId')!);
      return handleLfs(c, repository, c.req.path.split('/lfs/')[1], `${c.env.API_ORIGIN}/v1/repos/${repository.id}/lfs`);
    }));
  }
}

function registerCandidateRoutes(app: App, base: string): void {
  route(app, 'POST', `${base}/git/candidates`, { summary: 'Construct and retain an actual native merge candidate', tags: ['git'], body: candidateSchema, capability: 'pull_requests.write', idempotency: gitIdempotency('candidate') }, api(async c => {
    const repository = await getRepository(c, c.req.param('repoId')!);
    repositoryRevision(c, repository);
    const input = await jsonBody(c, candidateSchema);
    await getRepository(c, input.source_repo_id);
    const { message, ...context } = input;
    const candidate: CandidateContext = { ...context, id: newId('gc') };
    return mutationResponse(c, repository, { kind: 'candidate', candidate, author: await commitAuthor(c), message });
  }));
  route(app, 'GET', `${base}/git/candidates/:id`, { summary: 'Read a retained merge candidate and its private checkout remote', tags: ['git'], capability: 'contents.read' }, api(async c => {
    const repository = await getRepository(c, c.req.param('repoId')!);
    const candidate = await candidateFor(c, repository, c.req.param('id')!);
    c.header('etag', etag(candidate.revision));
    const { internal_ref: hidden, ...publicCandidate } = candidate;
    void hidden;
    return c.json({ ...publicCandidate, clone_url: `${c.env.GIT_ORIGIN}/repositories/${repository.id}/candidates/${candidate.id}.git` });
  }));
  route(app, 'POST', `${base}/git/candidates/:id/publish`, { summary: 'Publish a current candidate after fresh protected-branch checks', tags: ['git'], capability: 'pull_requests.merge', idempotency: gitIdempotency('merge') }, api(async c => {
    const repository = await getRepository(c, c.req.param('repoId')!);
    const candidate = await candidateFor(c, repository, c.req.param('id')!);
    if (expectedRevision(c) !== candidate.revision || candidate.state !== 'ready' || !candidate.candidate_oid) {
      throw new ApiError(412, 'candidate_obsolete', 'This merge candidate changed. Rebuild and verify the current candidate.');
    }
    return mutationResponse(c, repository, { kind: 'merge', candidate: {
      id: candidate.id, source_repo_id: candidate.source_repo_id, source_oid: candidate.source_oid,
      target_ref: candidate.target_ref, target_oid: candidate.target_oid, strategy: candidate.strategy,
      ...(candidate.pull_request_id ? { pull_request_id: candidate.pull_request_id } : {}),
    }, candidate_oid: candidate.candidate_oid });
  }));
}

function registerSigningKeys(app: App, base: string): void {
  const schema = z.object({ principal_id: z.string().max(128), kind: z.enum(['ssh', 'openpgp']), public_key: z.string().min(32).max(128 * 1024),
    fingerprint: z.string().regex(/^[A-Fa-f0-9]{40,64}$/u).optional(), expires_at: z.iso.datetime().optional() }).strict();
  route(app, 'GET', `${base}/git/signing-keys`, { summary: 'List repository-trusted public signing keys', tags: ['git'], capability: 'rules.read' }, api(async c => {
    const repository = await getRepository(c, c.req.param('repoId')!, 'rules.read');
    const rows = await many(database(c), 'SELECT id,principal_id,kind,public_key,fingerprint,expires_at,revoked_at,revision,created_at FROM git_signing_keys WHERE repo_id=? ORDER BY id LIMIT 1000', repository.id);
    return c.json({ items: rows, next_cursor: null });
  }));
  route(app, 'POST', `${base}/git/signing-keys`, { summary: 'Trust a public signing key for native raw-object verification', tags: ['git'], capability: 'rules.manage', body: schema }, api(async c => {
    const repository = await getRepository(c, c.req.param('repoId')!, 'rules.manage');
    repositoryRevision(c, repository);
    const input = await jsonBody(c, schema);
    if (input.expires_at && input.expires_at <= now()) throw new ApiError(422, 'key_expired', 'Choose a future key expiration.');
    if (!await one(identityDatabase(c), 'SELECT id FROM principals WHERE id=? AND disabled_at IS NULL', input.principal_id)) throw new ApiError(404, 'not_found', 'Signing principal not found.');
    let fingerprint: string;
    if (input.kind === 'ssh') {
      const match = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/=]+)(?: [^\r\n]*)?$/u.exec(input.public_key);
      if (!match) throw new ApiError(422, 'invalid_signing_key', 'Use an OpenSSH-format public signing key.');
      const decoded = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
      fingerprint = await sha256(decoded);
    } else {
      if (!input.fingerprint || !input.public_key.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----') || input.public_key.includes('PRIVATE KEY')) {
        throw new ApiError(422, 'invalid_signing_key', 'Use an armored OpenPGP public key and its full fingerprint.');
      }
      fingerprint = input.fingerprint.toUpperCase();
    }
    const id = newId('gkey');
    const actor = requirePrincipal(c);
    await withRepositoryBarrier(c, repository.id, 'git.signing_key.trusted', () => mutate(c, { sql: 'UPDATE repositories SET policy_revision=policy_revision+1,revision=revision+1,updated_at=? WHERE id=? AND revision=?',
      bindings: [now(), repository.id, repository.revision], event: { type: 'git.signing_key.trusted', resource_id: repository.id,
        resource_revision: repository.revision + 1, repo_id: repository.id, account_id: repository.owner_id, data: { key_id: id, fingerprint } },
      after: [stmt(database(c), 'INSERT INTO git_signing_keys(repo_id,id,principal_id,kind,public_key,fingerprint,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        repository.id, id, input.principal_id, input.kind, input.public_key, fingerprint, input.expires_at ?? null, actor.id, now())] }));
    c.header('etag', etag(1));
    return c.json({ id, principal_id: input.principal_id, kind: input.kind, fingerprint, expires_at: input.expires_at ?? null, revision: 1 }, 201);
  }));
  route(app, 'DELETE', `${base}/git/signing-keys/:id`, { summary: 'Revoke repository signing trust', tags: ['git'], capability: 'rules.manage' }, api(async c => {
    const repository = await getRepository(c, c.req.param('repoId')!, 'rules.manage');
    const row = await one<{ revision: number }>(database(c), 'SELECT revision FROM git_signing_keys WHERE repo_id=? AND id=? AND revoked_at IS NULL', repository.id, c.req.param('id'));
    if (!row) throw new ApiError(404, 'not_found', 'Signing key not found.');
    if (expectedRevision(c) !== row.revision) throw new ApiError(412, 'revision_conflict', 'Signing key changed. Refresh and retry.');
    await withRepositoryBarrier(c, repository.id, 'git.signing_key.revoked', () => mutate(c, { sql: 'UPDATE git_signing_keys SET revoked_at=?,revision=revision+1 WHERE repo_id=? AND id=? AND revision=? AND revoked_at IS NULL',
      bindings: [now(), repository.id, c.req.param('id'), row.revision], event: { type: 'git.signing_key.revoked', resource_id: c.req.param('id')!,
        resource_revision: row.revision + 1, repo_id: repository.id, account_id: repository.owner_id },
      after: [stmt(database(c), 'UPDATE repositories SET policy_revision=policy_revision+1,revision=revision+1,updated_at=? WHERE id=?', now(), repository.id)] }));
    return c.body(null, 204);
  }));
}

async function browseRequest(c: AppContext, repository: Repository, action: string, query: Record<string, string>): Promise<Response> {
  return checkedResponse(await gitServiceRequest(c.env, `/internal/git/repositories/${repository.id}/browse/${action}`, { actor: c.get('principal'), query }));
}

async function checkedResponse(response: Response): Promise<Response> {
  if (!response.ok) {
    const body = await response.json() as { error?: { code: string; message: string } };
    throw new ApiError(response.status, body.error?.code ?? 'git_unavailable', body.error?.message ?? 'Git processing is temporarily unavailable.');
  }
  return response;
}

async function mutationResponse(c: AppContext, repository: Repository, mutation: GitMutation): Promise<Response> {
  const actor = requirePrincipal(c);
  const id = c.get('idempotency')?.operation_id ?? newId('gop');
  const encoded = JSON.stringify(mutation);
  await mutate(c, { sql: 'INSERT INTO git_api_commands(id,repo_id,actor_id,principal_json,command_json,command_sha256,created_at) VALUES (?,?,?,?,?,?,?)',
    bindings: [id, repository.id, actor.id, JSON.stringify(actor), encoded, await sha256(encoded), now()],
    event: { type: 'git.command.accepted', resource_id: id, resource_revision: 1, repo_id: repository.id, account_id: repository.owner_id,
      data: { operation_id: id, kind: mutation.kind } } });
  const operation = await runGitOperation(c.env, repository.id, { operation_id: id, actor, mutation });
  c.header('location', `/v1/repos/${repository.id}/git/operations/${id}`);
  return operationResponse(c, operation);
}

interface ApiCommand { id: string; repo_id: string; actor_id: string; principal_json: string; command_json: string; command_sha256: string }

function gitIdempotency(kind: 'refs' | 'edit' | 'candidate' | 'merge'): IdempotencyOptions {
  return {
    strategy: 'external',
    async authorization(c, record) {
      const repoId = c.req.param('repoId');
      const command = record?.operation_id ? await one<ApiCommand>(database(c), 'SELECT * FROM git_api_commands WHERE id=? AND repo_id=? AND actor_id=?', record.operation_id, repoId, requirePrincipal(c).id) : null;
      const mutation = command ? JSON.parse(command.command_json) as GitMutation : await requestMutation(c, kind);
      const requirements: RequestAuthorization[] = [{ capability: 'contents.read', scope: { repo_id: repoId } }];
      if (mutation.kind === 'candidate' || mutation.kind === 'merge') {
        requirements.push({ capability: 'contents.read', scope: { repo_id: mutation.candidate.source_repo_id } });
      }
      const saved = record?.operation_id ? await one<{ evidence_json: string | null }>(database(c), 'SELECT evidence_json FROM git_publications WHERE repo_id=? AND id=?', repoId, record.operation_id) : null;
      const evidence = saved?.evidence_json ? JSON.parse(saved.evidence_json) as { updates?: Array<{ policy_ref: string; paths: string[]; pathless?: boolean }> } | null : null;
      const capability = kind === 'merge' ? 'pull_requests.merge' : kind === 'candidate' ? 'pull_requests.write' : 'contents.push';
      if (evidence?.updates) for (const update of evidence.updates) requirements.push({ capability, scope: { repo_id: repoId, ref: update.policy_ref, paths: update.pathless ? undefined : update.paths } });
      else if (mutation.kind === 'edit') requirements.push({ capability, scope: { repo_id: repoId, ref: mutation.ref, paths: mutation.edits.map(edit => edit.path) } });
      else if (mutation.kind === 'refs') for (const update of mutation.updates) requirements.push({ capability, scope: { repo_id: repoId, ref: update.ref, paths: [] } });
      else requirements.push({ capability, scope: { repo_id: repoId, ...(mutation.kind === 'candidate' || mutation.kind === 'merge' ? { ref: mutation.candidate.target_ref, paths: [] } : {}) } });
      // Unknown graph paths are request admission only; the canonical gate checks every
      // actual path. Recovery uses its durable complete evidence and the pinned actor.
      return requirements;
    },
    async recover(c, record) { return recoverGitCommand(c, record, kind); },
  };
}

async function requestMutation(c: AppContext, kind: 'refs' | 'edit' | 'candidate' | 'merge'): Promise<GitMutation> {
  if (kind === 'refs') return { kind, ...(await jsonBody(c, refSchema)) };
  if (kind === 'edit') return { kind, ...(await jsonBody(c, editSchema)), author: await commitAuthor(c) };
  if (kind === 'candidate') {
    const { message, ...candidate } = await jsonBody(c, candidateSchema);
    return { kind, candidate: { ...candidate, id: 'gc_request_admission' }, message, author: await commitAuthor(c) };
  }
  const repository = await getRepository(c, c.req.param('repoId'));
  const candidate = await candidateFor(c, repository, c.req.param('id')!);
  if (!candidate.candidate_oid) throw new ApiError(409, 'candidate_missing', 'The candidate is not ready for publication.');
  return { kind, candidate: { id: candidate.id, source_repo_id: candidate.source_repo_id, source_oid: candidate.source_oid,
    target_ref: candidate.target_ref, target_oid: candidate.target_oid, strategy: candidate.strategy,
    ...(candidate.pull_request_id ? { pull_request_id: candidate.pull_request_id } : {}) }, candidate_oid: candidate.candidate_oid };
}

async function recoverGitCommand(c: AppContext, record: IdempotencyRecord, kind: 'refs' | 'edit' | 'candidate' | 'merge'): Promise<Response> {
  if (!record.operation_id) throw new ApiError(503, 'git_recovery_unavailable', 'This Git request has no durable operation identity.');
  const repository = await getRepository(c, c.req.param('repoId'));
  const command = await one<ApiCommand>(database(c), 'SELECT * FROM git_api_commands WHERE id=? AND repo_id=? AND actor_id=?', record.operation_id, repository.id, requirePrincipal(c).id);
  if (!command) {
    const mutation = await requestMutation(c, kind);
    if (kind === 'refs' || kind === 'candidate') repositoryRevision(c, repository);
    if (mutation.kind === 'candidate') mutation.candidate.id = `gc_${record.operation_id}`;
    if (mutation.kind === 'edit' && c.req.header('if-match') !== etag(mutation.expected_oid)) throw new ApiError(412, 'revision_conflict', 'The expected branch commit does not match If-Match.');
    if (kind === 'merge') {
      const candidate = await candidateFor(c, repository, c.req.param('id')!);
      if (expectedRevision(c) !== candidate.revision || candidate.state !== 'ready') throw new ApiError(412, 'candidate_obsolete', 'The merge candidate changed.');
    }
    return mutationResponse(c, repository, mutation);
  }
  if (await sha256(command.command_json) !== command.command_sha256) throw new ApiError(503, 'git_command_corrupt', 'The accepted Git command cannot be verified.');
  const lookup = await gitServiceRequest(c.env, `/internal/git/repositories/${repository.id}/operations/${record.operation_id}`);
  let operation: PublicGitOperation;
  if (lookup.status === 404) operation = await runGitOperation(c.env, repository.id, { operation_id: command.id,
    actor: JSON.parse(command.principal_json) as Principal, mutation: JSON.parse(command.command_json) as GitMutation });
  else {
    await checkedResponse(lookup);
    operation = await lookup.json() as PublicGitOperation;
    if (['publishing', 'uncertain'].includes(operation.state) || !operation.finalized) {
      await gitServiceJson(c.env, `/internal/git/repositories/${repository.id}/reconcile`, {});
      operation = await gitServiceJson(c.env, `/internal/git/repositories/${repository.id}/operations/${record.operation_id}`);
    }
  }
  c.header('location', `/v1/repos/${repository.id}/git/operations/${record.operation_id}`);
  return operationResponse(c, operation);
}

function operationResponse(c: AppContext, operation: PublicGitOperation): Response {
  if (operation.state === 'rejected') return c.json(operation, 409);
  return c.json(operation, operation.state === 'committed' && operation.finalized ? 201 : 202);
}

function repositoryRevision(c: AppContext, repository: Repository): void {
  if (expectedRevision(c) !== repository.revision) throw new ApiError(412, 'revision_conflict', 'The repository changed. Refresh and retry.');
}

async function candidateFor(c: AppContext, repository: Repository, id: string): Promise<CandidateRow> {
  const candidate = await one<CandidateRow>(database(c), 'SELECT * FROM git_candidates WHERE repo_id=? AND id=?', repository.id, id);
  if (!candidate) throw new ApiError(404, 'not_found', 'Merge candidate not found.');
  await getRepository(c, candidate.source_repo_id);
  return candidate;
}

async function commitAuthor(c: AppContext): Promise<GitAuthor> {
  const actor = requirePrincipal(c);
  const user = actor.user_id ? await one<{ display_name: string; username: string; email: string }>(identityDatabase(c), 'SELECT display_name,username,email FROM users WHERE id=?', actor.user_id) : null;
  return { name: user?.display_name || user?.username || actor.id, email: user?.email ?? `${actor.id}@users.gitknot.com` };
}

function api(handler: (c: AppContext) => Promise<Response>): (c: AppContext) => Promise<Response> {
  return async c => {
    try { return await handler(c); }
    catch (error) { if (error instanceof GitError) throw new ApiError(error.status, error.code, error.message); throw error; }
  };
}
