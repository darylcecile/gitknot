import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { createServer, request as httpsRequest } from 'node:https';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { Hono } from 'hono';
import { createTestDatabase } from '../support/database.ts';
import type { SqliteD1 } from '../support/database.ts';
import type { AppEnv, Bindings, Repository } from '../../packages/core/src/types.ts';
import { authenticate } from '../../packages/core/src/auth.ts';
import { errorResponse } from '../../packages/core/src/errors.ts';
import { canonicalJson, sha256 } from '../../packages/core/src/crypto.ts';
import { registerGitRoutes } from '../../apps/api/src/modules/git.ts';
import { publicGitOperation } from '../../packages/git/src/views.ts';
import { journalStorage } from '../../workers/git/src/journal-storage.ts';
import { signInternalRequest, verifyInternalRequest } from '../../packages/core/src/internal.ts';
import { PublicationJournal } from '../../packages/git/src/journal.ts';
import type { JournalStorage } from '../../packages/git/src/journal.ts';
import { DEFAULT_GIT_LIMITS, GIT_NATIVE_SCOPE, ZERO_OID } from '../../packages/git/src/types.ts';
import type { GitEvidence, GitMutation, GitOperation, GitPolicy, NativeSessionSpec, NativeSessionTicket, PublicationResult } from '../../packages/git/src/types.ts';
import { digestJson, pktLine, reviewEvidenceId, reviewRefs, transactionRef } from '../../packages/git/src/protocol.ts';
import { GitError } from '../../packages/git/src/errors.ts';
import { startNativeServer } from '../../services/git/src/server.ts';
import type { NativeCallbacks } from '../../services/git/src/server.ts';
import gitGateway, { coordinatorRequest } from '../../workers/git/src/gateway.ts';
import { RepositoryCoordinator } from '../../workers/git/src/coordinator.ts';
import { loadPolicy, recheckPublication } from '../../workers/git/src/policy.ts';
import type { GitBindings } from '../../workers/git/src/types.ts';
import { handleRoutingRpc, identityAuthorityBindings, routeResourceRequest, withAccountAuthorityBarrier } from '../../packages/core/src/routing.ts';
import { internalContext } from '../../workers/git/src/policy.ts';
import { scheduleMaintenance } from '../../packages/operations/src/dispatch.ts';
import type { OperationsBindings } from '../../packages/operations/src/types.ts';
import { submitShardMove } from '../../packages/operations/src/move-request.ts';
import { TestBucket } from '../support/storage.ts';
import { AdmissionController, admissionRequest, storagePlacement } from '../../packages/billing/src/index.ts';
import type { AdmissionControl, Budget, CanonicalGitMeter, PlacementGitHold } from '../../packages/billing/src/index.ts';
import { registerCollaborationRoutes } from '../../apps/api/src/modules/collaboration.ts';
import { moveFixture } from '../support/move-fixture.ts';
import { abortShardMove, runShardMove } from '../../packages/operations/src/movement.ts';
import { moveControl } from '../../packages/operations/src/move-control.ts';
import { movePublisherState } from '../../workers/git/src/move-publication.ts';
import { operationById } from '../../packages/operations/src/lifecycle.ts';
import { archiveStream, readArchive } from '../../packages/operations/src/archive.ts';
import { LocalGitStore } from '../../infra/local/git-store.ts';
import { provisionFilesystemRepository, readFilesystemCreation } from '../../services/git/src/filesystem-store.ts';

const exec = promisify(execFile);
const key = 'local-native-protocol-test-internal-key-000000000000000000';
const authorization = `Basic ${Buffer.from('gitknot:local-private-git-token').toString('base64')}`;
const actor = { id: 'u_native_test', kind: 'user' as const, user_id: 'u_native_test', credential_id: 'cred_native_test', capabilities: null, repository_ids: null, account_ids: null, mfa: true };
let root: string;
let ca: Buffer;
let certPath: string;
let origin: string;
let native: Awaited<ReturnType<typeof startNativeServer>>;
let gateway: ReturnType<typeof createServer>;
const fixtures = new Map<string, Fixture>();
const diagnostics: unknown[] = [];
const integratedGateways = new Map<string, GitBindings>();

class SqliteJournal implements JournalStorage {
  db: DatabaseSync;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('CREATE TABLE IF NOT EXISTS journal(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,result TEXT NOT NULL)');
  }
  async get<T>(key: string): Promise<T | undefined> {
    const row = this.db.prepare('SELECT value FROM journal WHERE key=?').get(key) as { value: Uint8Array } | undefined;
    return row ? deserialize(row.value) as T : undefined;
  }
  async put<T>(key: string, value: T): Promise<void> { this.db.prepare('INSERT INTO journal(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, serialize(value)); }
  async delete(key: string): Promise<boolean> { return this.db.prepare('DELETE FROM journal WHERE key=?').run(key).changes > 0; }
  async list<T>(options: { prefix?: string; startAfter?: string; limit?: number } = {}): Promise<Map<string, T>> {
    const rows = this.db.prepare('SELECT key,value FROM journal WHERE key>? ORDER BY key').all(options.startAfter ?? '') as Array<{ key: string; value: Uint8Array }>;
    return new Map(rows.filter(row => row.key.startsWith(options.prefix ?? '')).slice(0, options.limit ?? Infinity).map(row => [row.key, deserialize(row.value) as T]));
  }
  async transaction<T>(callback: (storage: JournalStorage) => Promise<T>): Promise<T> {
    const work = this.tail.then(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try { const result = await callback(this); this.db.exec('COMMIT'); return result; }
      catch (error) { this.db.exec('ROLLBACK'); throw error; }
    });
    this.tail = work.catch(() => {});
    return work;
  }
}

class Fixture {
  readonly id = `r_${crypto.randomUUID().replaceAll('-', '')}`;
  readonly directory: string;
  readonly canonical: string;
  readonly client: string;
  readonly repository;
  policy: GitPolicy = { revision: 1, rules: [], signatures: { ssh_signers: [], openpgp_keys: [], openpgp_fingerprints: [] }, limits: { ...DEFAULT_GIT_LIMITS, max_work_ms: 60_000 } };
  storage: SqliteJournal;
  journal: PublicationJournal;
  dropResult = false;
  authorized = true;
  beforePermit?: () => Promise<void>;
  afterPermit?: () => Promise<void>;
  publicationCheck?: (operation: GitOperation, evidence: GitEvidence) => Promise<void>;
  lastOperation?: string;

  constructor() {
    this.directory = join(root, this.id);
    this.canonical = join(this.directory, 'canonical.git');
    this.client = join(this.directory, 'client');
    this.repository = { id: this.id, owner_id: actor.id, storage_name: this.id, default_branch: 'main', policy_revision: 1, routing_epoch: 1 };
    this.storage = new SqliteJournal(':memory:');
    this.journal = new PublicationJournal(journalStorage(this.storage as unknown as DurableObjectStorage));
  }

  async initialize(): Promise<this> {
    await mkdir(this.directory, { recursive: true });
    this.storage.db.close();
    this.storage = new SqliteJournal(join(this.directory, 'journal.sqlite'));
    this.journal = new PublicationJournal(journalStorage(this.storage as unknown as DurableObjectStorage));
    await git(this.directory, ['init', '--bare', '--initial-branch=main', this.canonical]);
    await git(this.directory, ['init', '--initial-branch=main', this.client]);
    fixtures.set(this.id, this);
    return this;
  }

  get remote(): string { return `${origin}/${this.id}.git`; }

  async commit(path: string, content: string, message = 'change'): Promise<string> {
    await mkdir(join(this.client, path, '..'), { recursive: true });
    await writeFile(join(this.client, path), content);
    await git(this.client, ['add', '--', path]);
    await git(this.client, ['commit', '-m', message]);
    return (await git(this.client, ['rev-parse', 'HEAD'])).stdout.trim();
  }

  async push(...refs: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
    return git(this.client, [...transport(), 'push', '--atomic', this.remote, ...refs]);
  }

  async begin(kind: GitOperation['kind'], mutation?: GitMutation, operationId?: string): Promise<NativeSessionSpec> {
    const id = operationId ?? `gop_${crypto.randomUUID().replaceAll('-', '')}`;
    const publisher = `pub_${crypto.randomUUID().replaceAll('-', '')}`;
    const candidate = mutation && (mutation.kind === 'candidate' || mutation.kind === 'merge') ? mutation.candidate : undefined;
    const operation: GitOperation = { id, repo_id: this.id, repository: this.repository, actor, kind, state: 'receiving',
      policy_revision: this.policy.revision, routing_epoch: 1, publisher_id: publisher, fence_hash: 'local-test-fence',
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(), deadline_at: new Date(Date.now() + 60_000).toISOString(), finalized: false,
      ...(candidate ? { candidate } : {}) };
    await this.journal.open(operation);
    this.lastOperation = id;
    return { repository: this.repository, policy: structuredClone(this.policy), remote: { authority: 'local', url: this.canonical },
      mode: kind === 'push' ? 'receive' : 'mutate', operation_id: id, publisher_id: publisher, fence: 'local-test-fence', actor_id: actor.id, kind,
      callback_url: `${origin}/internal`, ...(candidate ? { candidate } : {}), ...(mutation?.kind === 'retain' ? { review: mutation.review } : {}) };
  }

  async read(action: string, query: Record<string, string> = {}, extra: Partial<NativeSessionSpec> = {}): Promise<Response> {
    const spec: NativeSessionSpec = { repository: this.repository, policy: structuredClone(this.policy), remote: { authority: 'local', url: this.canonical }, mode: 'read', ...extra };
    return nativeAction(await session(spec), action, 'GET', undefined, query);
  }

  async mutate(mutation: GitMutation, operationId?: string): Promise<Response> {
    return nativeAction(await session(await this.begin(mutation.kind, mutation, operationId)), 'mutate', 'POST', JSON.stringify(mutation));
  }

  async accepted(result: PublicationResult): Promise<void> {
    if (this.dropResult) throw new Error('Injected lost durable receipt after native outcome');
    await this.journal.result(result.operation_id, result);
    if (result.outcome !== 'uncertain') {
      this.storage.db.prepare('INSERT OR IGNORE INTO events(id,actor_id,result) VALUES (?,?,?)').run(result.operation_id, actor.id, JSON.stringify(result));
      await this.journal.finalized(result.operation_id);
    }
  }

  async inspect(): Promise<PublicationResult> {
    const operation = await this.journal.active();
    if (!operation?.evidence) throw new Error('No operation to inspect');
    const request = await session({ repository: this.repository, policy: this.policy, remote: { authority: 'local', url: this.canonical }, mode: 'inspect' });
    return (await nativeAction(request, 'inspect', 'POST', JSON.stringify({ operation_id: operation.id, evidence: operation.evidence }))).json() as Promise<PublicationResult>;
  }
}

const callbacks: NativeCallbacks = {
  async validated(spec, evidence) {
    if (integratedGateways.has(spec.repository.id)) { await integratedCallback(spec, 'validated', { evidence }); return; }
    const fixture = fixtures.get(spec.repository.id)!;
    if (!fixture.authorized || spec.policy.revision !== fixture.policy.revision) throw new GitError('stale_policy', 'Current permission or policy changed.', 409);
    await fixture.publicationCheck?.(await fixture.journal.get(spec.operation_id!), evidence);
    await fixture.journal.validated(spec.operation_id!, spec.publisher_id!, evidence);
  },
  async permit(spec, evidence) {
    if (integratedGateways.has(spec.repository.id)) return integratedCallback(spec, 'permit', { evidence_digest: evidence.digest });
    const fixture = fixtures.get(spec.repository.id)!;
    await fixture.beforePermit?.();
    if (!fixture.authorized || spec.policy.revision !== fixture.policy.revision) throw new GitError('stale_policy', 'Current permission or policy changed.', 409);
    await fixture.publicationCheck?.(await fixture.journal.get(spec.operation_id!), evidence);
    await fixture.journal.publishing(spec.operation_id!, spec.publisher_id!, evidence.digest);
    await fixture.afterPermit?.();
    return { operation_id: spec.operation_id!, publisher_id: spec.publisher_id!, evidence_digest: evidence.digest, marker_oid: evidence.marker_oid,
      remote: { authority: 'local', url: fixture.canonical } };
  },
  async result(spec, result) {
    if (integratedGateways.has(spec.repository.id)) { await integratedCallback(spec, 'result', { result }); return; }
    await fixtures.get(spec.repository.id)!.accepted(result);
  },
  async rejected(spec, reason, code) {
    if (integratedGateways.has(spec.repository.id)) { await integratedCallback(spec, 'rejected', { reason, code }); return; }
    const fixture = fixtures.get(spec.repository.id)!;
    const operation = await fixture.journal.get(spec.operation_id!);
    if (operation.state === 'receiving' || operation.state === 'validated') {
      await fixture.journal.rejectBeforePublication(operation.id, code ?? 'receive_rejected', reason ?? 'Native receive rejected the push.');
      await fixture.journal.finalized(operation.id);
    }
  },
};

beforeAll(async () => {
  const base = process.platform === 'darwin' ? '/private/var/folders/zh/l70grz9n3ll9j9c_f1ghp7gr0000gn/T/opencode' : tmpdir();
  root = await mkdtemp(join(base, 'git-native-'));
  certPath = join(root, 'localhost.pem');
  const privateKey = join(root, 'localhost.key');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', privateKey, '-out', certPath,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
  ca = await readFile(certPath);
  gateway = createServer({ key: await readFile(privateKey), cert: ca }, async (request, response) => {
    try {
      if (request.headers.authorization !== authorization) { response.writeHead(401, { 'www-authenticate': 'Basic realm="GitKnot test"' }); response.end(); return; }
      const url = new URL(request.url!, origin);
      const match = /^\/(r_[a-f0-9]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/u.exec(url.pathname);
      const fixture = match ? fixtures.get(match[1]) : undefined;
      if (!fixture || !fixture.authorized) { response.writeHead(404); response.end(); return; }
      const service = match![2] === 'info/refs' ? url.searchParams.get('service') : match![2];
      const push = service === 'git-receive-pack' && request.method === 'POST';
      const spec = push ? await fixture.begin('push') : { repository: fixture.repository, policy: structuredClone(fixture.policy),
        remote: { authority: 'local' as const, url: fixture.canonical }, mode: 'read' as const };
      const ticket = await session(spec);
      const action = match![2] === 'info/refs' ? service === 'git-receive-pack' ? 'receive-advertise' : 'upload-advertise' : push ? 'receive' : 'upload';
      const result = await nativeAction(ticket, action, request.method!, request.method === 'POST' ? Readable.toWeb(request) as ReadableStream<Uint8Array> : undefined, {},
        { 'git-protocol': String(request.headers['git-protocol'] ?? '') });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) await pipeline(Readable.fromWeb(result.body as never), response); else response.end();
    } catch (error) {
      if (response.headersSent) response.destroy();
      else { response.writeHead(error instanceof GitError ? error.status : 500); response.end(error instanceof Error ? error.message : 'error'); }
    }
  });
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const address = gateway.address() as { port: number };
  origin = `https://localhost:${address.port}`;
  native = await startNativeServer({ configuration: { mode: 'test', cache_root: join(root, 'cache'), local_authority_root: root,
    max_sessions: 8, callback_origin: origin, test_https_ca_file: certPath }, authenticate: request => verifyInternalRequest(request, key, GIT_NATIVE_SCOPE), callbacks,
    on_error(error) { diagnostics.push(error instanceof Error ? { message: error.message, cause: error.cause } : error); } }, 0, '127.0.0.1');
}, 30_000);

afterAll(async () => {
  await native?.close();
  gateway?.closeAllConnections();
  await new Promise<void>(resolve => gateway?.close(() => resolve()));
  for (const fixture of fixtures.values()) fixture.storage.db.close();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('real native Git over authenticated HTTPS (explicit local authority)', () => {
  test('stock clone/fetch/push, native browsing, browser edits, archives and complete bundles', async () => {
    const fixture = await new Fixture().initialize();
    const first = await fixture.commit('README.md', '# Real Git\n');
    const pushed = await fixture.push('HEAD:refs/heads/main');
    expect(pushed.code, pushed.stderr).toBe(0);
    expect((await git(fixture.canonical, ['rev-parse', 'refs/heads/main'])).stdout.trim()).toBe(first);
    const clone = join(fixture.directory, 'clone');
    expect((await git(fixture.directory, [...transport(), 'clone', '--depth=1', fixture.remote, clone])).code).toBe(0);
    expect(await readFile(join(clone, 'README.md'), 'utf8')).toBe('# Real Git\n');
    const edited = await fixture.mutate({ kind: 'edit', ref: 'refs/heads/main', expected_oid: first, message: 'Browser edit', author: { name: 'Web actor', email: 'actor@example.test' },
      edits: [{ path: 'README.md', content_base64: Buffer.from('# Updated\n').toString('base64') }] });
    expect(edited.status, await edited.clone().text()).toBe(200);
    const update = await edited.json() as PublicationResult;
    expect(update.outcome).toBe('committed');
    expect((await git(clone, [...transport(), 'fetch', '--unshallow', 'origin'])).code).toBe(0);
    const commit = await (await fixture.read('commit')).json() as { message: string };
    expect(commit.message).toBe('Browser edit\n');
    const raw = await fixture.read('raw', { path: 'README.md' });
    expect(await raw.text()).toBe('# Updated\n');
    await git(fixture.client, ['notes', 'add', '-m', 'Native notes round trip', first]);
    const notes = await fixture.push('refs/notes/commits');
    expect(notes.code, notes.stderr).toBe(0);
    expect((await git(clone, [...transport(), 'fetch', fixture.remote, 'refs/notes/commits:refs/notes/commits'])).code).toBe(0);
    expect((await git(clone, ['notes', 'show', first])).stdout.trim()).toBe('Native notes round trip');
    const compare = await (await fixture.read('compare', { base: first })).json() as { ahead: number; files: Array<{ path: string }> };
    expect(compare.ahead).toBe(1);
    expect(compare.files.map(file => file.path)).toContain('README.md');
    const archive = await fixture.read('archive', { format: 'tar' });
    await writeFile(join(fixture.directory, 'repo.tar'), Buffer.from(await archive.arrayBuffer()));
    expect((await exec('tar', ['-tf', join(fixture.directory, 'repo.tar')])).stdout).toContain('README.md');
    const bundle = await fixture.read('bundle');
    await writeFile(join(fixture.directory, 'repo.bundle'), Buffer.from(await bundle.arrayBuffer()));
    expect((await git(fixture.client, ['bundle', 'verify', join(fixture.directory, 'repo.bundle')])).code).toBe(0);
    expect((await fixture.read('refs')).status).toBe(200);
    expect((fixture.storage.db.prepare('SELECT actor_id FROM events LIMIT 1').get() as { actor_id: string }).actor_id).toBe(actor.id);
  }, 90_000);

  test('all introduced history, all refs, deletes, tags, file limits and ancestry are enforced before publication', async () => {
    const fixture = await new Fixture().initialize();
    const first = await fixture.commit('allowed.txt', 'base\n');
    expect((await fixture.push('HEAD:refs/heads/main')).code).toBe(0);
    fixture.policy.rules = [
      { target: 'refs/heads/**', history: { allow_force_push: false, allow_deletion: false }, files: { denied_paths: ['restricted/**'], block_secrets: true, max_bytes: 1024 } },
      { target: 'refs/tags/private/**', history: { allow_creation: false } },
    ];
    await fixture.commit('secret.txt', `ghp_${'A'.repeat(36)}\n`, 'Introduce secret');
    await git(fixture.client, ['rm', 'secret.txt']);
    await git(fixture.client, ['commit', '-m', 'Remove secret']);
    expect((await fixture.push('HEAD:refs/heads/main')).code).not.toBe(0);
    expect((await git(fixture.canonical, ['rev-parse', 'main'])).stdout.trim()).toBe(first);
    await git(fixture.client, ['reset', '--hard', first]);
    const second = await fixture.commit('allowed.txt', 'second\n');
    expect((await fixture.push('HEAD:refs/heads/main')).code).toBe(0);
    await git(fixture.client, ['reset', '--hard', first]);
    await fixture.commit('allowed.txt', 'alternate\n');
    expect((await fixture.push('--force', 'HEAD:refs/heads/main')).code).not.toBe(0);
    expect((await fixture.push(':refs/heads/main')).code).not.toBe(0);
    await git(fixture.client, ['reset', '--hard', second]);
    await fixture.commit('allowed.txt', 'third\n');
    await git(fixture.client, ['tag', 'private/blocked']);
    expect((await fixture.push('HEAD:refs/heads/main', 'refs/tags/private/blocked')).code).not.toBe(0);
    expect((await git(fixture.canonical, ['rev-parse', 'main'])).stdout.trim()).toBe(second);
    await git(fixture.client, ['reset', '--hard', second]);
    await fixture.commit('restricted/blocked.txt', 'denied\n');
    expect((await fixture.push('HEAD:refs/heads/main')).code).not.toBe(0);
    await git(fixture.client, ['reset', '--hard', second]);
    await fixture.commit('large.txt', 'x'.repeat(16_384));
    expect((await fixture.push('HEAD:refs/heads/main')).code).not.toBe(0);
  }, 120_000);

  test('surplus unreachable supplied objects cannot bypass storage-wide secret rules', async () => {
    const fixture = await new Fixture().initialize();
    const old = await fixture.commit('a.txt', 'base');
    expect((await fixture.push('HEAD:refs/heads/main')).code).toBe(0);
    fixture.policy.rules = [{ target: 'refs/**', files: { block_secrets: true, inspect_all_supplied_objects: true } }];
    const next = await fixture.commit('a.txt', 'safe content');
    const surplus = (await gitInput(fixture.client, ['hash-object', '-w', '--stdin'], Buffer.from(`ghp_${'Z'.repeat(36)}`))).toString().trim();
    const objects = (await git(fixture.client, ['rev-list', '--objects', '--no-object-names', next, `^${old}`])).stdout;
    const pack = await gitInput(fixture.client, ['pack-objects', '--stdout'], Buffer.from(`${objects}${surplus}\n`));
    const data = Buffer.concat([pktLine(`${old} ${next} refs/heads/main\0report-status atomic\n`), Buffer.from('0000'), pack]);
    const response = await requestHttps(`${fixture.remote}/git-receive-pack`, data);
    expect(response.body.toString()).toContain('ng refs/heads/main');
    expect((await git(fixture.canonical, ['rev-parse', 'main'])).stdout.trim()).toBe(old);
  }, 60_000);

  test('raw native SSH signatures are verified and unsigned new commits are rejected', async () => {
    const fixture = await new Fixture().initialize();
    const base = await fixture.commit('a.txt', 'base');
    expect((await fixture.push('HEAD:refs/heads/main')).code).toBe(0);
    const signing = join(fixture.directory, 'signing');
    await exec('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', signing, '-q']);
    fixture.policy.signatures.ssh_signers = [`${actor.id} ${(await readFile(`${signing}.pub`, 'utf8')).trim()}`];
    fixture.policy.rules = [{ target: 'refs/heads/main', signatures: { commits: true } }, { target: 'refs/tags/signed', signatures: { tags: true } }];
    await fixture.commit('a.txt', 'unsigned');
    expect((await fixture.push('HEAD:refs/heads/main')).code).not.toBe(0);
    await git(fixture.client, ['reset', '--hard', base]);
    await writeFile(join(fixture.client, 'a.txt'), 'signed');
    await git(fixture.client, ['add', 'a.txt']);
    expect((await git(fixture.client, ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${signing}`, 'commit', '-S', '-m', 'Signed'])).code).toBe(0);
    const pushed = await fixture.push('HEAD:refs/heads/main');
    expect(pushed.code, pushed.stderr).toBe(0);
    await git(fixture.client, ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${signing}`, 'tag', '-s', '-m', 'Signed tag', 'signed']);
    const tagged = await fixture.push('refs/tags/signed');
    expect(tagged.code, tagged.stderr).toBe(0);
  }, 90_000);

  test('lost acceptance receipts recover from real canonical markers after journal restart; uncertain old publishers stay fenced', async () => {
    const fixture = await new Fixture().initialize();
    const head = await fixture.commit('a.txt', 'accepted bytes');
    fixture.dropResult = true;
    const push = await fixture.push('HEAD:refs/heads/main');
    expect(push.code).not.toBe(0);
    expect((await git(fixture.canonical, ['rev-parse', 'main'])).stdout.trim()).toBe(head);
    const active = await fixture.journal.active();
    expect(active?.state).toBe('publishing');
    fixture.storage.db.close();
    fixture.storage = new SqliteJournal(join(fixture.directory, 'journal.sqlite'));
    fixture.journal = new PublicationJournal(journalStorage(fixture.storage as unknown as DurableObjectStorage));
    await fixture.storage.put(`operation:${active!.id}`, { ...active, deadline_at: '2000-01-01T00:00:00.000Z' });
    await expect(fixture.begin('push')).rejects.toMatchObject({ code: 'publication_in_progress' });
    const inspected = await fixture.inspect();
    expect(inspected.outcome).toBe('committed');
    expect(inspected.marker_oid).toBe(active!.evidence!.marker_oid);
    fixture.dropResult = false;
    await fixture.accepted(inspected);
    await fixture.accepted(inspected);
    expect((fixture.storage.db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count).toBe(1);
    expect(await fixture.journal.active()).toBeNull();

    const absent = await new Fixture().initialize();
    await absent.commit('a.txt', 'not published');
    absent.dropResult = true;
    absent.beforePermit = async () => {
      const op = await absent.journal.active();
      await absent.journal.publishing(op!.id, op!.publisher_id, op!.evidence!.digest);
      throw new Error('Injected process loss before a write permit response');
    };
    expect((await absent.push('HEAD:refs/heads/main')).code).not.toBe(0);
    const unknown = await absent.inspect();
    expect(unknown.outcome).toBe('uncertain');
    await absent.journal.result(unknown.operation_id, unknown);
    await expect(absent.journal.finalized(unknown.operation_id)).rejects.toMatchObject({ code: 'publication_uncertain' });
    await expect(absent.begin('push')).rejects.toMatchObject({ code: 'publication_in_progress' });
  }, 90_000);

  test('retained native candidates stay hidden, merge publication is real, and forks reuse quarantine', async () => {
    const fixture = await new Fixture().initialize();
    const base = await fixture.commit('base.txt', 'base');
    expect((await fixture.push('HEAD:refs/heads/main')).code).toBe(0);
    const head = await fixture.commit('feature.txt', 'feature');
    expect((await fixture.push('HEAD:refs/heads/feature')).code).toBe(0);
    const candidate = { id: `gc_${crypto.randomUUID().replaceAll('-', '')}`, source_repo_id: fixture.id, source_oid: head, target_ref: 'refs/heads/main', target_oid: base, strategy: 'merge' as const };
    const response = await fixture.mutate({ kind: 'candidate', candidate, author: { name: 'Merge actor', email: 'merge@example.test' }, message: 'Actual candidate' });
    expect(response.status, await response.clone().text()).toBe(200);
    const result = await response.json() as PublicationResult & { candidate_oid: string };
    expect((await git(fixture.canonical, ['rev-parse', `refs/gitknot/candidates/${candidate.id}`])).stdout.trim()).toBe(result.candidate_oid);
    expect((await git(fixture.client, [...transport(), 'ls-remote', fixture.remote])).stdout).not.toContain('refs/gitknot/');
    expect((await fixture.read('commit', { ref: result.candidate_oid })).status).toBe(404);
    expect((await git(fixture.client, [...transport(), 'fetch', fixture.remote, result.candidate_oid])).code).not.toBe(0);
    const emptyPack = await gitInput(fixture.client, ['pack-objects', '--stdout'], Buffer.alloc(0));
    const borrowHidden = await requestHttps(`${fixture.remote}/git-receive-pack`, Buffer.concat([
      pktLine(`${ZERO_OID} ${result.candidate_oid} refs/heads/borrow-hidden\0report-status atomic\n`), Buffer.from('0000'), emptyPack,
    ]));
    expect(borrowHidden.body.toString()).toContain('ng refs/heads/borrow-hidden');
    expect((await git(fixture.canonical, ['show-ref', '--verify', 'refs/heads/borrow-hidden'])).code).not.toBe(0);
    const advertisement = await fixture.read('upload-advertise', {}, { candidate_read_ref: `refs/gitknot/candidates/${candidate.id}` });
    const advertised = await advertisement.text();
    expect(advertised).toContain('refs/heads/gitknot-candidate');
    expect(advertised).not.toContain('refs/heads/main');
    const merged = await fixture.mutate({ kind: 'merge', candidate, candidate_oid: result.candidate_oid });
    expect(merged.status, `${await merged.clone().text()}\n${JSON.stringify(diagnostics.slice(-3))}`).toBe(200);
    expect((await git(fixture.canonical, ['rev-parse', 'main'])).stdout.trim()).toBe(result.candidate_oid);
    const fork = await new Fixture().initialize();
    const forked = await fork.mutate({ kind: 'fork', source: { authority: 'local', url: fixture.canonical } });
    expect(forked.status, await forked.clone().text()).toBe(200);
    expect((await git(fork.canonical, ['rev-parse', 'main'])).stdout.trim()).toBe(result.candidate_oid);
    expect((await git(fork.canonical, ['for-each-ref', '--format=%(refname)', 'refs/gitknot/candidates/'])).stdout).toBe('');
  }, 120_000);

  test('current policy changes and missing upstream atomic capability never report success', async () => {
    const changed = await new Fixture().initialize();
    await changed.commit('a.txt', 'candidate');
    changed.beforePermit = async () => { changed.policy.revision++; };
    expect((await changed.push('HEAD:refs/heads/main')).code).not.toBe(0);
    expect((await git(changed.canonical, ['show-ref'])).stdout).toBe('');
    const noAtomic = await new Fixture().initialize();
    await noAtomic.commit('a.txt', 'candidate');
    await git(noAtomic.canonical, ['config', 'receive.advertiseAtomic', 'false']);
    expect((await noAtomic.push('HEAD:refs/heads/main')).code).not.toBe(0);
    expect((await git(noAtomic.canonical, ['show-ref'])).stdout).toBe('');
  }, 60_000);

  test('an intervening same-new-OID update cannot bypass the exact-old lease by becoming up-to-date', async () => {
    const fixture = await new Fixture().initialize();
    await fixture.commit('a.txt', 'old');
    expect((await fixture.push('HEAD:refs/heads/main')).code).toBe(0);
    const next = await fixture.commit('a.txt', 'new');
    fixture.beforePermit = async () => {
      const external = await git(fixture.client, ['push', fixture.canonical, 'HEAD:refs/heads/main']);
      expect(external.code, external.stderr).toBe(0);
    };
    expect((await fixture.push('HEAD:refs/heads/main')).code).not.toBe(0);
    const operation = await fixture.journal.get(fixture.lastOperation!);
    expect(operation.result?.outcome).toBe('rejected');
    expect(operation.result?.proof).toBe('not_started');
    expect((await git(fixture.canonical, ['rev-parse', 'main'])).stdout.trim()).toBe(next);
    expect((await git(fixture.canonical, ['show-ref', '--verify', transactionRef(operation.id)])).code).not.toBe(0);
  }, 60_000);

  test('private HTTPS import and checksummed full-bundle restoration produce actual native refs', async () => {
    const source = await new Fixture().initialize();
    const head = await source.commit('private.txt', 'private source bytes');
    expect((await source.push('HEAD:refs/heads/main')).code).toBe(0);
    const imported = await new Fixture().initialize();
    const importedResponse = await imported.mutate({ kind: 'import', source: { authority: 'artifacts', url: source.remote, authorization } });
    expect(importedResponse.status, `${await importedResponse.clone().text()} ${JSON.stringify(diagnostics.slice(-2))}`).toBe(200);
    expect((await git(imported.canonical, ['rev-parse', 'main'])).stdout.trim()).toBe(head);
    const config = await readFile(join(imported.canonical, 'config'), 'utf8');
    expect(config).not.toContain('Authorization');
    expect(config).not.toContain(key);
    const bundle = Buffer.from(await (await source.read('bundle')).arrayBuffer());
    const restore = { archive_id: 'archive_native_test', bundle_sha256: await sha256Bytes(bundle), bundle_bytes: bundle.length, expected_refs: [{ ref: 'refs/heads/main', oid: head }] };
    const restored = await new Fixture().initialize();
    const spec = await restored.begin('restore');
    const response = await nativeAction(await session({ ...spec, restore }), 'restore', 'POST', bundle);
    expect(response.status, `${await response.clone().text()} ${JSON.stringify(diagnostics.slice(-2))}`).toBe(200);
    expect((await git(restored.canonical, ['rev-parse', 'main'])).stdout.trim()).toBe(head);
    const corrupt = await new Fixture().initialize();
    const tampered = Buffer.from(bundle); tampered[tampered.length - 1] ^= 1;
    const rejected = await nativeAction(await session({ ...await corrupt.begin('restore'), restore }), 'restore', 'POST', tampered);
    expect(rejected.status).toBe(422);
    expect((await git(corrupt.canonical, ['show-ref'])).stdout).toBe('');
  }, 120_000);

  test('collaboration inspection, text suggestions and native restacks preserve exact source revisions', async () => {
    const fixture = await new Fixture().initialize();
    const base = await fixture.commit('base.txt', 'base\n');
    expect((await fixture.push('HEAD:refs/heads/main')).code).toBe(0);
    await git(fixture.client, ['checkout', '-b', 'feature']);
    const feature = await fixture.commit('feature.txt', 'one\ntwo\n');
    expect((await fixture.push('HEAD:refs/heads/feature')).code).toBe(0);
    await git(fixture.client, ['checkout', 'main']);
    const onto = await fixture.commit('base.txt', 'advanced\n');
    expect((await fixture.push('HEAD:refs/heads/main')).code).toBe(0);
    const inspect = async (inspection: unknown) => nativeAction(await session({ repository: fixture.repository, policy: fixture.policy,
      remote: { authority: 'local', url: fixture.canonical }, mode: 'read' }), 'collaboration', 'POST', JSON.stringify({ inspection }));
    const patch = await inspect({ kind: 'patch', head_repo_id: fixture.id, base_oid: base, head_oid: feature });
    expect(patch.status, await patch.clone().text()).toBe(200);
    const evidence = await patch.json() as { complete: boolean; files: Array<{ path: string; patch_fingerprint: string; hunks: unknown[] }> };
    expect(evidence.complete).toBe(true);
    expect(evidence.files[0].path).toBe('feature.txt');
    expect(evidence.files[0].patch_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const suggestion = await inspect({ kind: 'suggestion', head_oid: feature, path: 'feature.txt', start_line: 2, end_line: 2, replacement: 'changed' });
    const prepared = await suggestion.json() as { edit: { content_base64: string; mode: string } };
    expect(Buffer.from(prepared.edit.content_base64, 'base64').toString()).toBe('one\nchanged\n');
    const restack = await fixture.mutate({ kind: 'restack', ref: 'refs/heads/feature', expected_oid: feature, old_base_oid: base,
      onto_oid: onto, onto_repo_id: fixture.id, pull_request_id: 'pr_native_smoke' });
    expect(restack.status, `${await restack.clone().text()} ${JSON.stringify(diagnostics.slice(-2))}`).toBe(200);
    const result = await restack.json() as PublicationResult;
    expect((await git(fixture.canonical, ['rev-parse', `${result.refs[0].new_oid}^`])).stdout.trim()).toBe(onto);
    expect((await git(fixture.canonical, ['show', `${result.refs[0].new_oid}:feature.txt`])).stdout).toBe('one\ntwo\n');
  }, 120_000);

  test('Git API external request recovery reuses the actual canonical publication after a lost response', async () => {
    const fixture = await new Fixture().initialize();
    const db = await createTestDatabase();
    try {
      const at = new Date().toISOString();
      const token = `gkt_${'b'.repeat(43)}`;
      db.sqlite.prepare('INSERT INTO users(id,username,email,display_name,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(actor.id, 'native-api', 'native-api@example.test', 'Native API actor', at, at, at);
      db.sqlite.prepare("INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES (?,'user',?,?,?,?,?)").run(actor.id, 'native-api', 'Native API owner', actor.id, at, at);
      db.sqlite.prepare("INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES (?,'user',?,?,?,?,?,?)").run(actor.id, actor.id, actor.id, 'Native API actor', actor.id, at, at);
      db.sqlite.prepare(`INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
        VALUES (?,?,?,?,'private','active','local','core',?,?,?,?)`).run(fixture.id, actor.id, fixture.id, fixture.id, fixture.id, actor.id, at, at);
      db.sqlite.prepare(`INSERT INTO credentials(id,principal_id,user_id,kind,name,token_hash,token_prefix,capabilities_json,auth_revision,mfa,authenticated_at,expires_at,created_by,created_at)
        VALUES (?,?,?,'personal','Native API',?,?,'["*"]',1,1,?,?,?,?)`).run(actor.credential_id, actor.id, actor.id, await sha256(token), token.slice(0, 12), at, new Date(Date.now() + 3600_000).toISOString(), actor.id, at);
      let dropped = false;
      const submitted: string[] = [];
      const env = { DB: db.binding(), DIRECTORY_DB: db.binding(), ENVIRONMENT: 'test', API_ORIGIN: 'http://api.test', APP_ORIGIN: 'http://api.test',
        CELL_ID: 'local', SHARD_ID: 'core', INTERNAL_SERVICE_KEY: key,
        IDENTITY_KEYS_JSON: JSON.stringify({ current: 'test', keys: { test: Buffer.alloc(32, 7).toString('base64url') } }),
        GIT_SERVICE: { async fetch(request: Request) {
          await verifyInternalRequest(request, key, 'git-service');
          const url = new URL(request.url);
          if (url.pathname.endsWith('/mutate')) {
            const input = await request.json() as { operation_id: string; mutation: GitMutation };
            submitted.push(input.operation_id);
            const result = await fixture.mutate(input.mutation, input.operation_id);
            expect(result.status, await result.clone().text()).toBe(200);
            if (!dropped) { dropped = true; throw new Error('Injected lost response after real canonical acceptance'); }
            return Response.json(publicGitOperation(await fixture.journal.get(input.operation_id)));
          }
          const id = url.pathname.split('/operations/')[1];
          if (id) { try { return Response.json(publicGitOperation(await fixture.journal.get(id))); } catch { return new Response(null, { status: 404 }); } }
          throw new Error('Unexpected Git API recovery route');
        } },
      } as unknown as Bindings;
      const api = new Hono<AppEnv>();
      api.onError(errorResponse);
      api.use('*', async (c, next) => {
        c.set('requestId', crypto.randomUUID()); c.set('database', env.DB.withSession('first-primary'));
        const routed = await routeResourceRequest(c);
        if (routed) return routed;
        c.set('principal', await authenticate(c.req.raw, env)); await next();
      });
      registerGitRoutes(api);
      const body = JSON.stringify({ ref: 'refs/heads/main', expected_oid: ZERO_OID, message: 'Idempotent API edit', edits: [{ path: 'idempotent.txt', content_base64: Buffer.from('one publication').toString('base64') }] });
      const request = () => new Request(`http://api.test/v1/repos/${fixture.id}/files`, { method: 'POST', body, headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'lost-native-response', 'if-match': `"${ZERO_OID}"`,
      } });
      expect((await api.fetch(request(), env)).status).toBeGreaterThanOrEqual(500);
      const recovered = await api.fetch(request(), env);
      expect(recovered.status, await recovered.clone().text()).toBe(201);
      expect(submitted).toHaveLength(1);
      const persisted = db.sqlite.prepare('SELECT operation_id FROM idempotency_keys WHERE principal_id=? AND key=?').get(actor.id, 'lost-native-response') as { operation_id: string };
      expect((await recovered.json() as { operation_id: string }).operation_id).toBe(persisted.operation_id);
      expect((fixture.storage.db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count).toBe(1);
      expect((await git(fixture.canonical, ['show', 'main:idempotent.txt'])).stdout).toBe('one publication');
      db.sqlite.prepare('UPDATE credentials SET revoked_at=? WHERE id=?').run(new Date().toISOString(), actor.credential_id);
      expect((await api.fetch(request(), env)).status).toBe(401);
      expect(submitted).toHaveLength(1);
    } finally { db.close(); }
  }, 120_000);

  test('out-of-order maintenance release tombstones acquisitions, while a real publisher fence stays exclusive', async () => {
    const fixture = await new Fixture().initialize();
    const id = 'barrier_out_of_order';
    const token = await sha256('exact maintenance token');
    const released = await fixture.journal.releaseBarrier(id, token);
    expect(released).toEqual({ held: false, released: true, operation_id: id });
    expect(await fixture.journal.releaseBarrier(id, token)).toEqual(released);
    const acquisition = { operation_id: id, token_hash: token, reason: 'maintenance', created_at: new Date().toISOString(), acquire_before: new Date(Date.now() + 120_000).toISOString() };
    expect(await fixture.journal.barrier(acquisition)).toEqual(released);
    await expect(fixture.journal.barrier({ ...acquisition, token_hash: 'different-token' })).rejects.toMatchObject({ code: 'invalid_barrier' });
    const active = { ...acquisition, operation_id: 'barrier_next_operation' };
    expect((await fixture.journal.barrier(active)).held).toBe(true);
    expect((await fixture.journal.barrier(active)).held).toBe(true);
    await expect(fixture.begin('push')).rejects.toMatchObject({ code: 'repository_fenced' });
    await fixture.journal.releaseBarrier(active.operation_id, token);
    await fixture.begin('push');
    const operation = (await fixture.journal.active())!;
    await fixture.storage.put(`operation:${operation.id}`, { ...operation, state: 'uncertain', deadline_at: '2000-01-01T00:00:00.000Z' });
    await fixture.journal.releaseBarrier('unrelated_release', token);
    await expect(fixture.begin('push')).rejects.toMatchObject({ code: 'publication_in_progress' });
    await expect(fixture.journal.barrier({ ...active, operation_id: 'barrier_third_operation' })).rejects.toMatchObject({ code: 'publication_in_progress' });
  });

  test('review refs retain private history after force pushes and verbatim fingerprints detect whitespace changes', async () => {
    const target = await new Fixture().initialize();
    const base = await target.commit('base.txt', 'base\n');
    expect((await target.push('HEAD:refs/heads/main')).code).toBe(0);
    const source = await new Fixture().initialize();
    expect((await source.mutate({ kind: 'fork', source: { authority: 'local', url: target.canonical } })).status).toBe(200);
    await git(source.client, ['fetch', source.canonical, 'refs/heads/main']);
    await git(source.client, ['reset', '--hard', 'FETCH_HEAD']);
    const head = await source.commit('code.py', 'if True:\n  print("x")\n');
    expect((await source.push('HEAD:refs/heads/main')).code).toBe(0);
    const id = await reviewEvidenceId(target.id, source.id, base, head);
    const retained = await target.mutate({ kind: 'retain', review: { id, source_repo_id: source.id, base_oid: base, head_oid: head }, source: { authority: 'local', url: source.canonical } });
    expect(retained.status, `${await retained.clone().text()} ${JSON.stringify(diagnostics.slice(-2))}`).toBe(200);
    const inspection = (await target.journal.get(target.lastOperation!)).evidence!.review as { fingerprint_algorithm: string; patch_fingerprint: string };
    expect(inspection.fingerprint_algorithm).toBe('git-patch-id-verbatim-v1');
    await git(source.client, ['reset', '--hard', base]);
    await source.commit('replacement.txt', 'replacement\n');
    expect((await source.push('--force', 'HEAD:refs/heads/main')).code).toBe(0);
    expect((await source.read('commit', { ref: head })).status).toBe(404);
    expect((await target.read('commit', { ref: head })).status).toBe(404);
    const ticket = await session({ repository: target.repository, policy: target.policy, remote: { authority: 'local', url: target.canonical }, mode: 'read', retained_refs: reviewRefs(id) });
    const historical = await nativeAction(ticket, 'collaboration', 'POST', JSON.stringify({ retained_refs: reviewRefs(id), inspection: {
      kind: 'diff', head_repo_id: source.id, base_oid: base, head_oid: head, pull_id: 'pr_history', to_patch_id: 'patch_history',
    } }));
    expect(historical.status, await historical.clone().text()).toBe(200);
    expect((await historical.json() as { diff: string }).diff).toContain('  print("x")');
    await git(source.client, ['reset', '--hard', head]);
    const changed = await source.commit('code.py', 'if True:\n    print("x")\n');
    expect((await source.push('--force', 'HEAD:refs/heads/main')).code).toBe(0);
    const changedId = await reviewEvidenceId(target.id, source.id, base, changed);
    const updated = await target.mutate({ kind: 'retain', review: { id: changedId, source_repo_id: source.id, base_oid: base, head_oid: changed }, source: { authority: 'local', url: source.canonical } });
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect((await target.journal.get(target.lastOperation!)).evidence!.review!.patch_fingerprint).not.toBe(inspection.patch_fingerprint);
    const exported = Buffer.from(await (await target.read('bundle')).arrayBuffer());
    await writeFile(join(target.directory, 'public.bundle'), exported);
    expect((await git(target.directory, ['bundle', 'list-heads', 'public.bundle'])).stdout).not.toContain('refs/gitknot/');
  }, 120_000);

  test('native scan continuation reports cumulative searched and excluded files without dropping a split file', async () => {
    const fixture = await new Fixture().initialize();
    await fixture.commit('a.txt', 'match one\nmatch two\nmatch three\n');
    await fixture.commit('excluded.txt', 'match excluded\n');
    await writeFile(join(fixture.client, 'binary.bin'), new Uint8Array([0, 1, 2]));
    await git(fixture.client, ['add', 'binary.bin']); await git(fixture.client, ['commit', '-m', 'binary']);
    const head = (await git(fixture.client, ['rev-parse', 'HEAD'])).stdout.trim();
    expect((await fixture.push('HEAD:refs/heads/main')).code).toBe(0);
    let cursor: string | null = null;
    let lastSearched = 0; let lastExcluded = 0;
    const matched: number[] = [];
    do {
      const ticket = await session({ repository: fixture.repository, policy: fixture.policy, remote: { authority: 'local', url: fixture.canonical }, mode: 'read' });
      const response = await nativeAction(ticket, 'collaboration', 'POST', JSON.stringify({ inspection: { kind: 'scan', commit_oid: head, query: 'match',
        case_sensitive: true, include_globs: [], exclude_globs: ['excluded.txt'], cursor, max_results: 1 } }));
      expect(response.status, await response.clone().text()).toBe(200);
      const page = await response.json() as { matches: Array<{ line: number }>; scanned_files: number; excluded_files: number; total_files: number; next_cursor: string | null };
      matched.push(...page.matches.map(match => match.line));
      expect(page.scanned_files).toBeGreaterThanOrEqual(lastSearched);
      expect(page.excluded_files).toBeGreaterThanOrEqual(lastExcluded);
      lastSearched = page.scanned_files; lastExcluded = page.excluded_files; cursor = page.next_cursor;
      if (cursor === null) expect(page.scanned_files + page.excluded_files).toBe(page.total_files);
    } while (cursor !== null);
    expect(matched).toEqual([1, 2, 3]);
    expect(lastSearched).toBe(1); expect(lastExcluded).toBe(2);
  }, 90_000);

  test('compressed pack expansion and streamed pack-byte ceilings reject before canonical publication', async () => {
    const fixture = await new Fixture().initialize();
    const base = await fixture.commit('base.txt', 'base');
    expect((await fixture.push('HEAD:refs/heads/main')).code).toBe(0);
    fixture.policy.limits.max_pack_bytes = 32 * 1024;
    fixture.policy.limits.max_inflated_bytes = 32 * 1024;
    await fixture.commit('compressed.txt', 'x'.repeat(128 * 1024));
    expect((await fixture.push('HEAD:refs/heads/main')).code).not.toBe(0);
    expect((await git(fixture.canonical, ['rev-parse', 'main'])).stdout.trim()).toBe(base);
    await git(fixture.client, ['reset', '--hard', base]);
    fixture.policy.limits.max_inflated_bytes = 1024 * 1024;
    await writeFile(join(fixture.client, 'random.bin'), randomBytes(128 * 1024));
    await git(fixture.client, ['add', 'random.bin']); await git(fixture.client, ['commit', '-m', 'incompressible pack']);
    expect((await fixture.push('HEAD:refs/heads/main')).code).not.toBe(0);
    expect((await git(fixture.canonical, ['rev-parse', 'main'])).stdout.trim()).toBe(base);
  }, 90_000);

  test('the real Git gateway inspects a complete cross-repository patch without retaining refs for merge-only callers', async () => {
    const target = await new Fixture().initialize();
    const base = await target.commit('base.txt', 'base\n');
    expect((await target.push('HEAD:refs/heads/main')).code).toBe(0);
    const source = await new Fixture().initialize();
    expect((await source.mutate({ kind: 'fork', source: { authority: 'local', url: target.canonical } })).status).toBe(200);
    await git(source.client, ['fetch', source.canonical, 'refs/heads/main']);
    await git(source.client, ['reset', '--hard', 'FETCH_HEAD']);
    const head = await source.commit('scoped/change.py', 'if True:\n  print("complete patch")\n');
    expect((await source.push('HEAD:refs/heads/main')).code).toBe(0);
    const setup = await gatewayFixture([target, source]);
    try {
      const inspect = (retain?: unknown) => internalGit(setup.env, target.id, 'collaboration/inspect', {
        actor, ...(retain === undefined ? {} : { retain }), inspection: { kind: 'patch', head_repo_id: source.id, base_oid: base, head_oid: head },
      });
      const result = await inspect(false);
      expect(result.status, await result.clone().text()).toBe(200);
      const patch = await result.json() as { complete: boolean; fingerprint_algorithm: string; files: { path: string; hunks: unknown[] }[] };
      expect(patch).toMatchObject({ complete: true, fingerprint_algorithm: 'git-patch-id-verbatim-v1' });
      expect(patch.files.map(file => file.path)).toEqual(['scoped/change.py']);
      expect(patch.files[0].hunks).toHaveLength(1);
      expect((await git(target.canonical, ['for-each-ref', '--format=%(refname)', 'refs/gitknot/reviews/'])).stdout).toBe('');
      expect(setup.db.sqlite.prepare('SELECT COUNT(*) AS n FROM git_review_snapshots').get()).toMatchObject({ n: 0 });
      expect(setup.db.sqlite.prepare('SELECT COUNT(*) AS n FROM git_publications').get()).toMatchObject({ n: 0 });
      for (const retain of [undefined, true]) expect((await inspect(retain)).status).toBe(404);
      expect((await inspect('false')).status).toBe(422);
      setup.db.sqlite.prepare('UPDATE credentials SET repository_ids_json=? WHERE id=?').run(JSON.stringify([target.id]), actor.credential_id);
      expect((await inspect(false)).status).toBe(404);
      setup.db.sqlite.prepare('UPDATE credentials SET repository_ids_json=? WHERE id=?').run(JSON.stringify([source.id]), actor.credential_id);
      expect((await inspect(false)).status).toBe(404);
    } finally { setup.close(); }
  }, 120_000);

  test('native Git enforces LFS size and ownership for CRLF and legacy reference-client pointer encodings', async () => {
    const fixture = await new Fixture().initialize();
    const base = await fixture.commit('base.txt', 'base\n');
    expect((await fixture.push('HEAD:refs/heads/main')).code).toBe(0);
    const setup = await gatewayFixture([fixture]);
    try {
      setup.db.sqlite.prepare('UPDATE credentials SET capabilities_json=? WHERE id=?').run('["*"]', actor.credential_id);
      setup.db.sqlite.prepare(`INSERT INTO repository_rules(id,account_id,repo_id,name,enforcement,target_json,config_json,created_by,created_at,updated_at)
        VALUES ('rule_pointer_size',?,?,'LFS byte ceiling','active','"refs/heads/main"','{"files":{"max_bytes":1024}}',?,?,?)`)
        .run(actor.id, fixture.id, actor.id, new Date().toISOString(), new Date().toISOString());
      fixture.policy = await loadPolicy(internalContext(setup.env, actor), setup.db.sqlite.prepare('SELECT * FROM repositories WHERE id=?').get(fixture.id) as unknown as Repository);
      let observed: GitEvidence | undefined;
      fixture.publicationCheck = async (operation, evidence) => { observed = evidence; await recheckPublication(setup.env, operation, evidence); };
      const pointer = (version: string, newline: string, size: number) => [`version ${version}`, `oid sha256:${'a'.repeat(64)}`, `size ${size}`, ''].join(newline);
      for (const [version, newline] of [
        ['https://git-lfs.github.com/spec/v1', '\n'], ['https://git-lfs.github.com/spec/v1', '\r\n'],
        ['https://hawser.github.com/spec/v1', '\r\n'], ['http://git-media.io/v/2', '\n'],
      ]) {
        await git(fixture.client, ['reset', '--hard', base]);
        await fixture.commit('scoped/large.dat', pointer(version, newline, 4096));
        expect((await fixture.push('HEAD:refs/heads/main')).code).not.toBe(0);
        expect((await fixture.journal.get(fixture.lastOperation!)).error?.code).toBe('file_size_limit');
        expect((await git(fixture.canonical, ['rev-parse', 'main'])).stdout.trim()).toBe(base);
      }
      await git(fixture.client, ['reset', '--hard', base]);
      await fixture.commit('scoped/large.dat', `\u0085\r\n${pointer('https://hawser.github.com/spec/v1', '\r\n', 512)}`);
      expect((await fixture.push('HEAD:refs/heads/main')).code).not.toBe(0);
      expect(observed?.updates[0].lfs_objects).toEqual([{ oid: 'a'.repeat(64), size: 512 }]);
      expect((await fixture.journal.get(fixture.lastOperation!)).error?.code).toBe('lfs_object_missing');
      expect((await git(fixture.canonical, ['rev-parse', 'main'])).stdout.trim()).toBe(base);
    } finally { fixture.publicationCheck = undefined; setup.close(); }
  }, 120_000);

  test('signing trust cannot be revoked while an already-permitted native publisher remains active', async () => {
    const fixture = await new Fixture().initialize();
    await fixture.commit('scoped/file.txt', 'base\n');
    expect((await fixture.push('HEAD:refs/heads/main')).code).toBe(0);
    const setup = await gatewayFixture([fixture]);
    try {
      setup.db.sqlite.prepare('UPDATE credentials SET capabilities_json=? WHERE id=?').run('["*"]', actor.credential_id);
      const signing = join(fixture.directory, 'revocation-signing');
      await exec('ssh-keygen', ['-t', 'ed25519', '-N', '', '-f', signing, '-q']);
      const publicKey = (await readFile(`${signing}.pub`, 'utf8')).trim();
      const at = new Date().toISOString();
      setup.db.sqlite.prepare(`INSERT INTO repository_rules(id,account_id,repo_id,name,enforcement,target_json,config_json,created_by,created_at,updated_at)
        VALUES ('rule_signing_fence',?,?,'Signed commits','active','"refs/heads/main"','{"signatures":{"commits":true}}',?,?,?)`).run(actor.id, fixture.id, actor.id, at, at);
      setup.db.sqlite.prepare(`INSERT INTO git_signing_keys(repo_id,id,principal_id,kind,public_key,fingerprint,created_by,created_at)
        VALUES (?,'gkey_revocation',?,'ssh',?,?,?,?)`).run(fixture.id, actor.id, publicKey, await sha256(publicKey), actor.id, at);
      const refreshPolicy = async () => { fixture.policy = await loadPolicy(internalContext(setup.env, actor), setup.db.sqlite.prepare('SELECT * FROM repositories WHERE id=?').get(fixture.id) as unknown as Repository); };
      await refreshPolicy();
      fixture.publicationCheck = async (operation, evidence) => { await recheckPublication(setup.env, operation, evidence); };
      const api = gatewayApi(setup.env);
      const revoke = () => api.fetch(new Request(`http://api.test/v1/repos/${fixture.id}/git/signing-keys/gkey_revocation`, {
        method: 'DELETE', headers: { authorization: `Bearer gkt_${'g'.repeat(43)}`, 'if-match': '"1"' },
      }), setup.env);
      let attempted = false;
      fixture.afterPermit = async () => {
        expect((await fixture.journal.active())?.state).toBe('publishing');
        const response = await revoke(); attempted = true;
        expect(response.status, await response.clone().text()).toBe(409);
        expect(setup.db.sqlite.prepare("SELECT revoked_at FROM git_signing_keys WHERE id='gkey_revocation'").get()).toMatchObject({ revoked_at: null });
      };
      const sign = async (text: string) => {
        await writeFile(join(fixture.client, 'scoped/file.txt'), text);
        await git(fixture.client, ['add', 'scoped/file.txt']);
        const result = await git(fixture.client, ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${signing}`, 'commit', '-S', '-m', text]);
        expect(result.code, result.stderr).toBe(0);
      };
      await sign('permitted before revocation\n');
      const push = await fixture.push('HEAD:refs/heads/main');
      expect(push.code, push.stderr).toBe(0);
      expect(attempted).toBe(true);
      const accepted = (await git(fixture.canonical, ['rev-parse', 'main'])).stdout.trim();
      fixture.afterPermit = undefined;
      const revoked = await revoke();
      expect(revoked.status, await revoked.clone().text()).toBe(204);
      expect(setup.db.sqlite.prepare("SELECT revoked_at FROM git_signing_keys WHERE id='gkey_revocation'").get()!.revoked_at).not.toBeNull();
      await refreshPolicy(); await sign('signed with a now-revoked key\n');
      expect((await fixture.push('HEAD:refs/heads/main')).code).not.toBe(0);
      expect((await git(fixture.canonical, ['rev-parse', 'main'])).stdout.trim()).toBe(accepted);
    } finally { fixture.afterPermit = undefined; fixture.publicationCheck = undefined; setup.close(); }
  }, 120_000);

  test('a durable scheduled backup exports protected private review refs only while its exact maintenance barrier is held', async () => {
    const target = await new Fixture().initialize();
    const base = await target.commit('base.txt', 'base\n');
    expect((await target.push('HEAD:refs/heads/main')).code).toBe(0);
    const source = await new Fixture().initialize();
    expect((await source.mutate({ kind: 'fork', source: { authority: 'local', url: target.canonical } })).status).toBe(200);
    await git(source.client, ['fetch', source.canonical, 'refs/heads/main']); await git(source.client, ['reset', '--hard', 'FETCH_HEAD']);
    const head = await source.commit('private.txt', 'protected historical source\n');
    expect((await source.push('HEAD:refs/heads/main')).code).toBe(0);
    const evidenceId = await reviewEvidenceId(target.id, source.id, base, head);
    const retained = await target.mutate({ kind: 'retain', review: { id: evidenceId, source_repo_id: source.id, base_oid: base, head_oid: head }, source: { authority: 'local', url: source.canonical } });
    expect(retained.status, await retained.clone().text()).toBe(200);
    const saved = await target.journal.get(target.lastOperation!);
    const setup = await gatewayFixture([target, source]);
    try {
      const at = new Date().toISOString();
      setup.db.sqlite.prepare(`INSERT INTO git_review_snapshots(repo_id,id,source_repo_id,base_oid,head_oid,merge_base_oid,operation_id,actor_id,state,inspection_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'ready',?,?,?)`).run(target.id, evidenceId, source.id, base, head, saved.evidence!.review!.merge_base_oid as string,
      saved.id, actor.id, JSON.stringify(saved.evidence!.review), at, at);
      await scheduleMaintenance(setup.env as unknown as OperationsBindings);
      const scheduled = setup.db.sqlite.prepare("SELECT id FROM operations WHERE repo_id=? AND kind='repository.backup'").get(target.id)!;
      const operationId = String(scheduled.id);
      setup.db.sqlite.prepare("UPDATE operations SET status='running',phase='archive' WHERE id=?").run(operationId);
      const token = `lifecycle_${operationId}`;
      expect((await internalGit(setup.env, target.id, 'barrier', { operation_id: operationId, token })).status).toBe(200);
      setup.db.sqlite.prepare('UPDATE operations_maintenance_intents SET barrier_token_hash=?,barrier_held_at=? WHERE operation_id=?').run(await sha256(token), at, operationId);
      const before = setup.helperCalls.length;
      expect((await internalGit(setup.env, target.id, 'export', { maintenance: true, include_retained_refs: true })).status).toBe(404);
      expect((await internalGit(setup.env, target.id, 'export', { operation_id: operationId, barrier_token: 'wrong-token', include_retained_refs: true })).status).toBe(403);
      expect(setup.helperCalls).toHaveLength(before);
      const response = await internalGit(setup.env, target.id, 'export', { operation_id: operationId, include_retained_refs: true });
      expect(response.status, await response.clone().text()).toBe(200);
      const bundle = join(target.directory, 'maintenance.bundle');
      await writeFile(bundle, Buffer.from(await response.arrayBuffer()));
      const refs = await git(target.directory, ['bundle', 'list-heads', bundle]);
      expect(refs.code, refs.stderr).toBe(0);
      for (const ref of reviewRefs(evidenceId)) expect(refs.stdout).toContain(ref);
      expect(refs.stdout).toContain(head);
      expect(setup.db.sqlite.prepare('SELECT source_repo_id FROM git_review_snapshots WHERE id=?').get(evidenceId)).toMatchObject({ source_repo_id: source.id });
      expect((await internalGit(setup.env, target.id, 'barrier', { operation_id: operationId, token }, 'DELETE')).status).toBe(200);
      const count = setup.helperCalls.length;
      // Even a lagging held-at metadata receipt cannot replace the live journal proof.
      expect((await internalGit(setup.env, target.id, 'export', { operation_id: operationId, include_retained_refs: true })).status).toBe(409);
      expect(setup.helperCalls).toHaveLength(count);
    } finally { setup.close(); }
  }, 120_000);

  test('accepted merge-queue candidates use scoped merge authority and recheck queue ownership before real publication', async () => {
    const fixture = await new Fixture().initialize();
    const base = await fixture.commit('base.txt', 'base\n');
    expect((await fixture.push('HEAD:refs/heads/main')).code).toBe(0);
    const head = await fixture.commit('scoped/feature.txt', 'feature\n');
    expect((await fixture.push('HEAD:refs/heads/feature')).code).toBe(0);
    const setup = await gatewayFixture([fixture]);
    try {
      fixture.publicationCheck = async (operation, evidence) => { await recheckPublication(setup.env, operation, evidence); };
      const candidate = { id: 'candidate_accepted_queue', source_repo_id: fixture.id, source_oid: head, target_ref: 'refs/heads/main', target_oid: base,
        strategy: 'merge' as const, pull_request_id: 'pr_scoped_queue' };
      const mutation: GitMutation = { kind: 'candidate', candidate, author: { name: 'Scoped merger', email: 'merge@example.test' }, message: 'Scoped queue candidate' };
      const ordinary = await internalGit(setup.env, fixture.id, 'mutate', { operation_id: 'ordinary_candidate_denied', actor, mutation });
      expect(ordinary.status, await ordinary.clone().text()).toBe(404);
      expect(setup.db.sqlite.prepare('SELECT COUNT(*) AS n FROM git_candidates').get()).toMatchObject({ n: 0 });
      await insertMergeQueue(setup.db, fixture, base, head, candidate.id);
      const realCoordinator = setup.env.REPO_COORDINATOR;
      let admissionCalls = 0;
      setup.env.REPO_COORDINATOR = { idFromName: (id: string) => id, get: () => ({ fetch: async (request: Request) => {
        await verifyInternalRequest(request, key, 'git-coordinator'); admissionCalls++;
        return Response.json({ error: { code: 'test_admission_unavailable', message: 'Injected loss before native admission.' } }, { status: 503 });
      } }) } as unknown as DurableObjectNamespace;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await internalGit(setup.env, fixture.id, 'mutate', { operation_id: 'op_scoped_queue_candidate_1', actor, mutation });
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: { code: 'test_admission_unavailable' } });
      }
      expect(admissionCalls).toBe(2);
      expect(setup.db.sqlite.prepare('SELECT COUNT(*) AS n FROM git_candidates').get()).toMatchObject({ n: 1 });
      setup.env.REPO_COORDINATOR = realCoordinator;
      const open = async (id: string, supplied = candidate) => {
        const response = await coordinatorRequest(setup.env, fixture.id, '/begin', { repo_id: fixture.id, operation_id: id,
          actor, kind: 'candidate', publisher_id: `pub_${id}`, fence: 'local-test-fence', candidate: supplied });
        return response;
      };
      expect((await open('wrong_native_operation')).status).toBe(409);
      expect((await open('op_scoped_queue_candidate_1', { ...candidate, target_ref: 'refs/heads/other' })).status).toBe(409);
      setup.db.sqlite.prepare('UPDATE credentials SET path_patterns_json=? WHERE id=?').run('["elsewhere/**"]', actor.credential_id);
      expect((await open('op_scoped_queue_candidate_1')).status).toBe(404);
      setup.db.sqlite.prepare('UPDATE credentials SET path_patterns_json=? WHERE id=?').run('["scoped/**"]', actor.credential_id);
      const opened = await open('op_scoped_queue_candidate_1');
      expect(opened.status, await opened.clone().text()).toBe(200);
      const { policy } = await opened.json() as { policy: GitPolicy };
      fixture.policy = policy;
      const saved = await fixture.journal.get('op_scoped_queue_candidate_1');
      expect(saved.merge_queue).toEqual({ id: 'mergeq_scoped', operation_id: 'op_scoped_queue', patch_id: 'patch_scoped_queue' });
      const ticket = await session({ repository: fixture.repository, policy, mode: 'mutate', remote: { authority: 'local', url: fixture.canonical },
        operation_id: saved.id, publisher_id: saved.publisher_id, fence: 'local-test-fence', actor_id: actor.id, kind: 'candidate', candidate, callback_url: `${origin}/internal` });
      const created = await nativeAction(ticket, 'mutate', 'POST', JSON.stringify(mutation));
      expect(created.status, `${await created.clone().text()} ${JSON.stringify(diagnostics.slice(-2))}`).toBe(200);
      const result = await created.json() as PublicationResult;
      expect((await git(fixture.canonical, ['rev-parse', `refs/gitknot/candidates/${candidate.id}`])).stdout.trim()).toBe(result.refs[0].new_oid);
      expect((await git(fixture.canonical, ['rev-parse', 'main'])).stdout.trim()).toBe(base);
      setup.db.sqlite.prepare("UPDATE pull_merge_queue SET candidate_id='candidate_cancelled_queue' WHERE id='mergeq_scoped'").run();
      setup.db.sqlite.prepare('UPDATE collaboration_operation_contexts SET checkpoint_json=? WHERE operation_id=?').run(
        JSON.stringify({ candidate_id: 'candidate_cancelled_queue', candidate_operation_id: 'op_scoped_queue_candidate_2' }), 'op_scoped_queue');
      const cancelled = { ...candidate, id: 'candidate_cancelled_queue' };
      const reopened = await open('op_scoped_queue_candidate_2', cancelled);
      expect(reopened.status, await reopened.clone().text()).toBe(200);
      fixture.beforePermit = async () => { setup.db.sqlite.prepare("UPDATE pull_merge_queue SET state='cancelled' WHERE id='mergeq_scoped'").run(); };
      const next = await fixture.journal.get('op_scoped_queue_candidate_2');
      const rejected = await nativeAction(await session({ repository: fixture.repository, policy, mode: 'mutate', remote: { authority: 'local', url: fixture.canonical },
        operation_id: next.id, publisher_id: next.publisher_id, fence: 'local-test-fence', actor_id: actor.id, kind: 'candidate', candidate: cancelled, callback_url: `${origin}/internal` }),
      'mutate', 'POST', JSON.stringify({ ...mutation, candidate: cancelled }));
      expect(rejected.status).toBe(409);
      expect((await git(fixture.canonical, ['show-ref', '--verify', `refs/gitknot/candidates/${cancelled.id}`])).code).not.toBe(0);
      expect((await git(fixture.canonical, ['rev-parse', 'main'])).stdout.trim()).toBe(base);
    } finally { fixture.publicationCheck = undefined; fixture.beforePermit = undefined; setup.close(); }
  }, 120_000);

  test('stock Git follows moved names to the current cell, streams a large pack to its real gate, and reauthenticates primary credentials', async () => {
    const original = await new Fixture().initialize();
    const base = await original.commit('base.txt', 'source namespace\n');
    expect((await original.push('HEAD:refs/heads/main')).code).toBe(0);
    const relocated = await new Fixture().initialize();
    expect((await relocated.mutate({ kind: 'fork', source: { authority: 'local', url: original.canonical } })).status).toBe(200);
    await git(relocated.client, ['fetch', relocated.canonical, 'refs/heads/main']);
    await git(relocated.client, ['reset', '--hard', 'FETCH_HEAD']);
    const current = await relocated.commit('destination.txt', 'current cell namespace\n');
    expect((await relocated.push('HEAD:refs/heads/main')).code).toBe(0);
    const setup = await gatewayFixture([original, relocated]);
    const destination = await createTestDatabase();
    const destinationJournal = new SqliteJournal(':memory:');
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const maintenance = { operation_id: 'move_native_gateway', token: 'native-gateway-maintenance-token-0000000000', reason: 'move' };
      const acquired = await internalGit(setup.env, original.id, 'barrier', maintenance);
      expect(acquired.status, await acquired.clone().text()).toBe(200);
      const competing = { ...maintenance, operation_id: 'different_native_maintenance', token: 'different-maintenance-token-000000000000' };
      const blocked = await internalGit(setup.env, original.id, 'barrier', competing);
      expect(blocked.status, await blocked.clone().text()).toBe(409);
      expect(await blocked.json()).toMatchObject({ error: { code: 'repository_fenced' } });
      expect((await internalGit(setup.env, original.id, 'barrier', competing, 'DELETE')).status).toBe(200);
      expect((await journalStorage(original.storage as unknown as DurableObjectStorage).get<{ operation_id: string }>('barrier'))?.operation_id).toBe(maintenance.operation_id);
      setup.db.sqlite.prepare('UPDATE credentials SET capabilities_json=?,ref_patterns_json=NULL,path_patterns_json=NULL WHERE id=?')
        .run('["contents.read","contents.push"]', actor.credential_id);
      for (const table of ['users', 'accounts', 'principals', 'credentials']) {
        for (const row of setup.db.sqlite.prepare(`SELECT * FROM ${table} WHERE id=?`).all(table === 'credentials' ? actor.credential_id : actor.id)) {
          const columns = Object.keys(row);
          destination.sqlite.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row));
        }
      }
      const row = setup.db.sqlite.prepare('SELECT * FROM repositories WHERE id=?').get(original.id)!;
      const moved = { ...row, cell_id: 'other', shard_id: 'moved', routing_epoch: 2, revision: 2, slug: 'renamed-native', storage_name: relocated.id };
      destination.sqlite.prepare(`INSERT INTO repositories(${Object.keys(moved).join(',')}) VALUES (${Object.keys(moved).map(() => '?').join(',')})`).run(...Object.values(moved));
      const at = new Date().toISOString();
      destination.sqlite.prepare('INSERT INTO repository_aliases(owner_slug,repository_slug,repo_id,created_at) VALUES (?,?,?,?)')
        .run('native-gateway', original.id, original.id, at);
      setup.db.sqlite.prepare("UPDATE repositories SET state='moving' WHERE id=?").run(original.id);
      setup.db.sqlite.prepare("INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,epoch,state,updated_at) VALUES (?,'repository','other','moved',2,'active',?)").run(original.id, at);
      destination.sqlite.prepare(`INSERT INTO repository_rules(id,account_id,repo_id,name,enforcement,target_json,config_json,created_by,created_at,updated_at)
        VALUES ('rule_moved_size',?,?,'Actual destination rule','active','"refs/heads/main"',?, ?,?,?)`)
        .run(actor.id, original.id, JSON.stringify({ files: { max_bytes: 4 * 1024 * 1024 } }), actor.id, at, at);
      Object.assign(setup.env, identityAuthorityBindings(setup.env));
      setup.env.CELL_BINDINGS_JSON = '{"other":"OTHER_API"}';
      setup.env.CELL_GIT_BINDINGS_JSON = '{"other":"OTHER_GIT"}';
      const target = { ...setup.env, ...identityAuthorityBindings(setup.env), DB: destination.binding(), CELL_ID: 'other', SHARD_ID: 'moved',
        CELL_BINDINGS_JSON: '{"local":"HOME_API"}', CELL_GIT_BINDINGS_JSON: '{"local":"HOME_GIT"}' } as GitBindings;
      const coordinator = new RepositoryCoordinator({ storage: Object.assign(destinationJournal, { setAlarm: async () => {} }) } as unknown as DurableObjectState, target);
      target.REPO_COORDINATOR = { idFromName: (id: string) => id, get: () => coordinator } as unknown as DurableObjectNamespace;
      target.GIT_SERVICE = { fetch: (request: Request) => gitGateway.fetch(request, target) } as unknown as Fetcher;
      setup.env.OTHER_API = { fetch: (request: Request) => handleRoutingRpc(request, target) };
      target.HOME_API = { fetch: (request: Request) => handleRoutingRpc(request, setup.env) };
      target.HOME_GIT = { fetch: (request: Request) => gitGateway.fetch(request, setup.env) };
      let packBytes = 0;
      let bytesAtDestination = -1;
      let forwardedDiscovery: Request | undefined;
      setup.env.OTHER_GIT = { fetch: async (request: Request) => {
        if (new URL(request.url).pathname.endsWith('/git-transport')) {
          if (request.method === 'POST') bytesAtDestination = packBytes;
          else forwardedDiscovery = new Request(request);
        }
        return gitGateway.fetch(request, target);
      } };
      const released = await internalGit(target, original.id, 'barrier', maintenance, 'DELETE');
      expect(released.status, await released.clone().text()).toBe(200);
      expect(await released.json()).toMatchObject({ held: false, released: true, operation_id: maintenance.operation_id });
      expect((await internalGit(target, original.id, 'barrier', maintenance)).status).toBe(409);
      expect(await destinationJournal.get('barrier')).toBeUndefined();
      expect(setup.db.sqlite.prepare('SELECT cell_id,shard_id FROM git_barrier_routes WHERE repo_id=? AND operation_id=?').get(original.id, maintenance.operation_id))
        .toMatchObject({ cell_id: 'local', shard_id: 'core' });
      integratedGateways.set(original.id, setup.env);
      server = createServer({ key: await readFile(join(root, 'localhost.key')), cert: ca }, async (incoming, outgoing) => {
        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(name, value);
          let body: ReadableStream<Uint8Array> | undefined;
          if (incoming.method === 'POST') body = (Readable.toWeb(incoming) as ReadableStream<Uint8Array>).pipeThrough(new TransformStream({
            transform(chunk, controller) { packBytes += chunk.byteLength; controller.enqueue(chunk); },
          }));
          const request = new Request(`https://localhost${incoming.url}`, { method: incoming.method, headers, body, ...(body ? { duplex: 'half' } : {}) } as RequestInit);
          const response = await gitGateway.fetch(request, setup.env);
          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          if (response.body) await pipeline(Readable.fromWeb(response.body as never), outgoing); else outgoing.end();
        } catch { if (outgoing.headersSent) outgoing.destroy(); else outgoing.writeHead(503).end(); }
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      const remote = `https://localhost:${port}/native-gateway/${original.id}.git`;
      const credentials = ['-c', `http.sslCAInfo=${certPath}`, '-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`gitknot:gkt_${'g'.repeat(43)}`).toString('base64')}`];
      const clone = join(original.directory, 'moved-clone');
      const cloned = await git(original.directory, [...credentials, 'clone', remote, clone]);
      expect(cloned.code, cloned.stderr).toBe(0);
      expect(await readFile(join(clone, 'destination.txt'), 'utf8')).toBe('current cell namespace\n');
      expect((await git(original.canonical, ['rev-parse', 'main'])).stdout.trim()).toBe(base);
      expect((await git(clone, [...credentials, 'ls-remote', `https://localhost:${port}/native-gateway/renamed-native.git`])).stdout).toContain(current);
      const replay = await gitGateway.fetch(new Request(forwardedDiscovery!), target);
      expect(replay.status, await replay.clone().text()).toBe(409);
      const altered = new Request(forwardedDiscovery!, { headers: { ...Object.fromEntries(forwardedDiscovery!.headers), authorization: 'Bearer altered-actual-credential' } });
      expect((await gitGateway.fetch(altered, target)).status).toBe(401);
      await mkdir(join(clone, 'scoped'));
      await writeFile(join(clone, 'scoped/large.bin'), randomBytes(6 * 1024 * 1024));
      await git(clone, ['add', 'scoped/large.bin']); await git(clone, ['commit', '-m', 'Large real pack']);
      packBytes = 0;
      const pushed = await git(clone, [...credentials, 'push', '--atomic', remote, 'HEAD:refs/heads/main']);
      expect(pushed.code).not.toBe(0);
      expect(packBytes, `${pushed.stderr}\n${JSON.stringify(diagnostics.slice(-3))}`).toBeGreaterThan(4 * 1024 * 1024);
      expect(bytesAtDestination).toBeGreaterThanOrEqual(0);
      expect(bytesAtDestination).toBeLessThan(1024 * 1024);
      expect(destination.sqlite.prepare('SELECT state,error_json,routing_epoch FROM git_publications WHERE repo_id=?').get(original.id))
        .toMatchObject({ state: 'rejected', routing_epoch: 2, error_json: expect.stringContaining('file_size_limit') });
      expect(setup.db.sqlite.prepare('SELECT COUNT(*) AS n FROM git_publications').get()).toMatchObject({ n: 0 });
      expect((await git(relocated.canonical, ['rev-parse', 'main'])).stdout.trim()).toBe(current);
      await withAccountAuthorityBarrier(internalContext(setup.env, actor), actor.id, 'test.credential_revoked', async () => {
        setup.db.sqlite.prepare('UPDATE credentials SET revoked_at=? WHERE id=?').run(at, actor.credential_id);
      });
      expect(destination.sqlite.prepare('SELECT revoked_at FROM credentials WHERE id=?').get(actor.credential_id)).toMatchObject({ revoked_at: null });
      expect((await git(clone, [...credentials, 'ls-remote', remote])).code).not.toBe(0);
    } finally {
      integratedGateways.delete(original.id);
      server?.closeAllConnections();
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      setup.close(); destination.close(); destinationJournal.db.close();
    }
  }, 180_000);

  test('credentialless maintenance move restores the exact graph, rechecks source authority, and retains both fences through receipt loss', async () => {
    const setup = await moveFixture();
    const target = setup.target, destination = setup.destination.db, source = setup.source.db;
    try {
      const head = await setup.initializeGit(), at = new Date().toISOString();
      source.sqlite.prepare(`INSERT INTO repository_rules(id,account_id,repo_id,name,enforcement,target_json,config_json,created_by,created_at,updated_at)
        VALUES ('rule_move',?,?,'Protected source','active','"refs/heads/main"',?,?,?,?)`).run(setup.accountId, setup.repoId,
      JSON.stringify({ updates: 'blocked', signatures: { commits: true }, push: { allowed_principals: [setup.actor.id] } }), setup.actor.id, at, at);
      const accepted = await submitShardMove(setup.env, { repo_id: setup.repoId, expected_epoch: 1, target_cell_id: target.CELL_ID, target_shard_id: target.SHARD_ID }, false);
      expect(accepted.status, await accepted.clone().text()).toBe(202);
      const operationId = (await accepted.json() as { id: string }).id, token = `move_${operationId}`, archiveId = `archive_${operationId}`;
      const nativeService = target.GIT_SERVICE;
      let paused = false;
      target.GIT_SERVICE = { fetch: (request: Request) => {
        const url = new URL(request.url);
        if (url.pathname === `/internal/git/repositories/${setup.repoId}/restore` && url.searchParams.get('operation_id') === operationId) {
          paused = true;
          return Promise.resolve(Response.json({ error: { code: 'test_pause_before_restore', message: 'Pause at the funded native boundary.' } }, { status: 503 }));
        }
        return nativeService.fetch(request);
      } } as Fetcher;
      // The production mover captures metadata, funds both cells, and copies the real archive before this native-only interruption.
      try { await expect(runShardMove(setup.env, await operationById(setup.env, operationId))).rejects.toThrow(); }
      finally { target.GIT_SERVICE = nativeService; }
      expect(paused, setup.diagnostics.map(String).join('\n')).toBe(true);
      const placement = await storagePlacement(setup.env, operationId);
      expect(placement).toMatchObject({ state: 'prepared', operation_id: operationId, repo_id: setup.repoId, account_id: setup.accountId,
        source_cell_id: setup.env.CELL_ID, source_shard_id: setup.env.SHARD_ID, source_epoch: 1,
        target_cell_id: target.CELL_ID, target_shard_id: target.SHARD_ID, target_epoch: 2,
        source_storage_name: setup.storageName, target_git_slice_id: target.BILLING_GIT_STORAGE_SLICE_ID });
      const manifest = await readArchive(setup.env, archiveId, setup.repoId);
      const bundle = Buffer.from(await new Response(archiveStream(setup.env, manifest, 'git/')).arrayBuffer());
      const funded = source.sqlite.prepare('SELECT body_json,source_verified_json FROM billing_placement_git WHERE operation_id=?').get(operationId)!;
      const hold = JSON.parse(String(funded.body_json)) as PlacementGitHold;
      expect(hold).toMatchObject({ operation_id: operationId, account_id: setup.accountId, repo_id: setup.repoId,
        storage_name: placement.target_storage_name, slice_id: placement.target_git_slice_id, state: 'reserved' });
      expect(BigInt(hold.bytes)).toBeGreaterThanOrEqual(BigInt(bundle.length));
      expect(BigInt(hold.maximum_units)).toBeGreaterThan(0n);
      expect(BigInt(hold.maximum_platform_units)).toBeGreaterThan(0n);
      expect(BigInt(hold.scratch_platform_units)).toBeGreaterThan(0n);
      expect(JSON.parse(String(funded.source_verified_json))).toMatchObject({ verified: true, objects_verified: true, refs: manifest.git.refs });
      type Totals = { control: AdmissionControl; budgets: Budget[] };
      for (const participant of [`account:${setup.accountId}`, `capacity:${placement.target_git_slice_id}`]) {
        const totals = await admissionRequest<Totals>(target, participant, 'snapshot');
        expect(BigInt(totals.control.reserved_bytes)).toBeGreaterThanOrEqual(BigInt(hold.bytes) * 2n);
        expect(totals.budgets.some(budget => BigInt(budget.reserved_units) > 0n)).toBe(true);
      }
      expect(setup.admissionHomes.get(target.CELL_ID)!.has(`account:${setup.accountId}`)).toBe(false);
      expect(destination.sqlite.prepare('SELECT * FROM credentials WHERE id=?').get(setup.actor.credential_id)).toBeUndefined();
      expect(destination.sqlite.prepare('SELECT COUNT(*) AS n FROM billing_storage_placements').get()).toMatchObject({ n: 0 });
      expect(target).toMatchObject({ IDENTITY_CELL_ID: setup.env.CELL_ID, IDENTITY_SHARD_ID: setup.env.SHARD_ID });
      const assertMetadataFences = () => {
        const sourceFence = source.sqlite.prepare('SELECT state,routing_epoch,fence_id FROM repository_metadata_fences WHERE repo_id=?').get(setup.repoId)!;
        const targetFence = destination.sqlite.prepare('SELECT state,routing_epoch,fence_id FROM repository_metadata_fences WHERE repo_id=?').get(setup.repoId)!;
        expect(sourceFence).toMatchObject({ state: 'held', routing_epoch: 1 });
        expect(targetFence).toMatchObject({ state: 'held', routing_epoch: 2 });
        expect(targetFence.fence_id).not.toBe(sourceFence.fence_id);
      };
      assertMetadataFences();
      expect(source.sqlite.prepare('SELECT * FROM billing_placement_scratch WHERE operation_id=?').get(operationId)).toBeUndefined();
      const sourceRepository = source.sqlite.prepare('SELECT * FROM repositories WHERE id=?').get(setup.repoId)!;
      const sourceService = target.SOURCE_GIT as Fetcher;
      let authorityReads = 0;
      target.SOURCE_GIT = { fetch: (request: Request) => {
        if (new URL(request.url).pathname.endsWith('/move-restore-authority')) authorityReads++;
        return sourceService.fetch(request);
      } };
      let loseResult = true;
      const lostResults: PublicationResult[] = [];
      const namespace = target.REPO_COORDINATOR;
      target.REPO_COORDINATOR = { idFromName: namespace.idFromName.bind(namespace), get: (id: DurableObjectId) => ({ fetch: async (request: Request) => {
        if (loseResult && new URL(request.url).pathname.endsWith('/result')) {
          const body = await request.clone().json() as { result: PublicationResult };
          expect(body.result).toMatchObject({ outcome: 'committed', operation_id: operationId });
          lostResults.push(body.result);
          return Response.json({ error: { code: 'test_receipt_lost', message: 'Injected lost native result.' } }, { status: 503 });
        }
        return namespace.get(id).fetch(request);
      } }) } as unknown as DurableObjectNamespace;
      const targetName = placement.target_storage_name;
      expect((await moveControl(setup.env, operationId)).target_storage_name).toBe(targetName);
      const restore = async (archive = archiveId) => {
        const url = new URL(`https://internal.gitknot.com/internal/git/repositories/${setup.repoId}/restore`);
        url.search = new URLSearchParams({ operation_id: operationId, archive_id: archive, storage_name: targetName }).toString();
        return gitGateway.fetch(await signInternalRequest(new Request(url, { method: 'POST', headers: {
          'content-type': 'application/x-git-bundle', 'x-gitknot-content-sha256': await sha256(bundle) }, body: bundle }), setup.env.INTERNAL_SERVICE_KEY, 'git-service'), setup.env);
      };
      const release = async () => setup.env.GIT_SERVICE.fetch(await signInternalRequest(new Request(`https://internal.gitknot.com/internal/git/repositories/${setup.repoId}/barrier`, {
        method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operation_id: operationId, token }),
      }), setup.env.INTERNAL_SERVICE_KEY, 'git-service'));
      expect((await restore('archive_from_another_operation')).status).toBe(403);
      destination.sqlite.prepare("UPDATE repositories SET owner_id='acc_operations_system' WHERE id=?").run(setup.repoId);
      expect((await restore()).status).toBe(409);
      destination.sqlite.prepare('UPDATE repositories SET owner_id=? WHERE id=?').run(setup.accountId, setup.repoId);
      source.sqlite.prepare("UPDATE operations SET status='cancelled' WHERE id=?").run(operationId);
      expect((await restore()).status).toBe(403);
      source.sqlite.prepare("UPDATE operations SET status='running' WHERE id=?").run(operationId);
      expect(setup.destinationStores.has(targetName)).toBe(false);
      // No current user credential participates in this move.
      source.sqlite.prepare('UPDATE credentials SET revoked_at=? WHERE id=?').run(at, setup.actor.credential_id);
      const response = await restore();
      expect(response.status).toBeGreaterThanOrEqual(400);
      const stored = setup.destinationStores.get(targetName)!;
      expect(stored, `${await response.clone().text()} ${JSON.stringify(setup.diagnostics.slice(-3))}`).toBeDefined();
      expect(lostResults).toHaveLength(1);
      expect(setup.provisions.get(targetName)).toBe(1);
      expect((await git(stored, ['rev-parse', 'main'])).stdout.trim()).toBe(head);
      expect(await setup.git(stored, 'fsck', '--strict', '--full', '--no-dangling')).toBe('');
      const restoredRefs = (await setup.git(stored, 'for-each-ref', '--format=%(refname) %(objectname)')).split('\n')
        .filter(line => line && !line.startsWith('refs/gitknot/transactions/')).map(line => { const [ref, oid] = line.split(' '); return { ref, oid }; });
      expect(restoredRefs).toEqual(manifest.git.refs);
      expect((await git(setup.sourceStores.get(setup.storageName)!, ['rev-parse', 'main'])).stdout.trim()).toBe(head);
      expect(destination.sqlite.prepare('SELECT actor_id,state,finalized FROM git_publications WHERE id=?').get(operationId))
        .toMatchObject({ actor_id: 'system:operations', state: 'publishing', finalized: 0 });
      const retainedScratch = source.sqlite.prepare('SELECT state,object_key FROM billing_placement_scratch WHERE operation_id=?').get(operationId)!;
      expect(retainedScratch.state).toBe('stored');
      expect(await setup.destination.blobs.head(String(retainedScratch.object_key))).not.toBeNull();
      const stagedRepository = destination.sqlite.prepare('SELECT * FROM repositories WHERE id=?').get(setup.repoId)!;
      destination.sqlite.exec('PRAGMA foreign_keys=OFF');
      destination.sqlite.prepare('DELETE FROM repositories WHERE id=?').run(setup.repoId);
      try {
        // A missing metadata row is not proof that the original DO publisher never ran.
        expect(await movePublisherState(setup.env, setup.repoId, { operation_id: operationId, side: 'target', action: 'read' }))
          .toMatchObject({ terminal: false, finalized: false, state: 'publishing', storage_name: targetName });
        expect((await release()).status).toBe(409);
        expect((await git(stored, ['rev-parse', transactionRef(operationId)])).stdout.trim()).toBe(lostResults[0].marker_oid);
      } finally {
        const fields = Object.keys(stagedRepository);
        destination.sqlite.prepare(`INSERT INTO repositories(${fields.join(',')}) VALUES(${fields.map(() => '?').join(',')})`).run(...Object.values(stagedRepository));
        destination.sqlite.exec('PRAGMA foreign_keys=ON');
      }
      source.sqlite.prepare("UPDATE operations_maintenance_intents SET purpose='repository.backup' WHERE operation_id=?").run(operationId);
      expect((await restore()).status).toBe(403);
      expect((await release()).status).toBe(409);
      assertMetadataFences();
      loseResult = false;
      const reconciled = await coordinatorRequest(target, setup.repoId, '/reconcile', {});
      expect(reconciled.status, await reconciled.clone().text()).toBe(200);
      const row = destination.sqlite.prepare('SELECT actor_json,context_json,state,finalized FROM git_publications WHERE id=?').get(operationId)!;
      expect(row).toMatchObject({ state: 'committed', finalized: 1 });
      expect(JSON.parse(String(row.actor_json))).toMatchObject({ id: 'system:operations', kind: 'service', user_id: null, credential_id: null });
      expect(JSON.parse(String(row.context_json))).toMatchObject({ maintenance: { purpose: 'repository.move', source: { epoch: 1 }, destination: { epoch: 2 } },
        storage_admission: { settled: true } });
      const meter = await admissionRequest<CanonicalGitMeter>(target, `account:${setup.accountId}`, 'git-meter', { repo_id: setup.repoId, storage_name: targetName });
      expect(meter).toMatchObject({ state: 'stored', account_id: setup.accountId, storage_cell_id: target.CELL_ID, placement_handoff_id: operationId });
      const scratch = source.sqlite.prepare('SELECT state,object_key FROM billing_placement_scratch WHERE operation_id=?').get(operationId)!;
      expect(scratch.state).toBe('deleted');
      expect(await setup.destination.blobs.head(String(scratch.object_key))).toBeNull();
      expect(destination.sqlite.prepare('SELECT owner_id,revision,storage_name FROM repositories WHERE id=?').get(setup.repoId))
        .toMatchObject({ owner_id: setup.accountId, revision: sourceRepository.revision, storage_name: setup.storageName });
      expect(authorityReads).toBeGreaterThanOrEqual(4);
      source.sqlite.prepare("UPDATE operations_maintenance_intents SET purpose='repository.move' WHERE operation_id=?").run(operationId);
      expect((await restore()).status).toBe(200);
      expect(setup.provisions.get(targetName)).toBe(1);
      expect((await release()).status).toBe(200);
      expect((await restore()).status).toBe(409);
    } finally { await setup.close(); }
  }, 120_000);

  test('credentialed cross-cell move recovers the original provision and scratch writer without changing its frozen catalog snapshot', async () => {
    const setup = await moveFixture(), ingress = await createTestDatabase();
    const { env, target } = setup, source = setup.source.db, destination = setup.destination.db;
    try {
      const base = await setup.initializeGit();
      const localStore = new LocalGitStore(env.INTERNAL_SERVICE_KEY, 'development');
      await localStore.provision(setup.storageName, 'main');
      await localStore.provision(setup.storageName, 'main', { create_only: false });
      await expect(localStore.provision(setup.storageName, 'another-operations-branch', { create_only: true }))
        .rejects.toMatchObject({ code: 'storage_namespace_exists', status: 409, cause: { proof: 'not_started' } });
      expect(await setup.git(setup.sourceStores.get(setup.storageName)!, 'rev-parse', 'main')).toBe(base);
      expect(await setup.git(setup.sourceStores.get(setup.storageName)!, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
      await setup.internalGit('mutate', { operation_id: 'gop_move_history', actor: setup.actor, mutation: { kind: 'edit', ref: 'refs/heads/main', expected_oid: base,
        message: 'Preserved descendant', author: { name: 'Original principal', email: 'physical@example.net' },
        edits: [{ path: 'history.txt', content_base64: Buffer.from('Restored by the recorded credential\n').toString('base64') }] } });
      await setup.internalGit('mutate', { operation_id: 'gop_move_branch', actor: setup.actor,
        mutation: { kind: 'refs', updates: [{ ref: 'refs/heads/previous', old_oid: ZERO_OID, new_oid: base }] } });
      const head = await setup.git(setup.sourceStores.get(setup.storageName)!, 'rev-parse', 'main');
      // The target ingress shard contains neither repository metadata nor identity authority.
      Object.assign(target, { TARGET_DB: target.DB, DB: ingress.binding(), SHARD_ID: 'ingress',
        SHARD_BINDINGS_JSON: '{"ingress":"DB","destination":"TARGET_DB"}' });
      const accepted = await submitShardMove(env, { repo_id: setup.repoId, expected_epoch: 1, target_cell_id: target.CELL_ID,
        target_shard_id: 'destination', principal: setup.actor }, false);
      expect(accepted.status).toBe(202);
      const { id } = await accepted.json() as { id: string }, operation = await operationById(env, id);
      const capturedRepository = source.sqlite.prepare('SELECT * FROM repositories WHERE id=?').get(setup.repoId)!;
      let loseProvision = true, loseRestore = true, scratchWrites = 0;
      const providerFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
      vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const response = await providerFetch(input, init);
        if (loseProvision && new URL(request.url).origin === 'http://127.0.0.1:8792' && request.method === 'PUT') {
          loseProvision = false;
          throw new Error('Provider created the original namespace but its acknowledgment was lost');
        }
        return response;
      });
      const put = setup.destination.blobs.put.bind(setup.destination.blobs);
      setup.destination.blobs.put = async (...args) => {
        if (args[2]?.customMetadata?.billing_placement_scratch === id) scratchWrites++;
        return put(...args);
      };
      const service = target.GIT_SERVICE;
      target.GIT_SERVICE = { fetch: async (request: Request) => {
        const response = await service.fetch(request);
        if (loseRestore && new URL(request.url).pathname.endsWith('/restore') && response.ok) {
          loseRestore = false;
          throw new Error('Native publication finished but the mover lost its restore receipt');
        }
        return response;
      } } as Fetcher;
      await expect(runShardMove(env, operation)).rejects.toThrow();
      expect(loseProvision, setup.diagnostics.map(String).join('\n')).toBe(false);
      const control = await moveControl(env, id), targetName = control.target_storage_name;
      const creationClaim = source.sqlite.prepare('SELECT state,creation_marker,creation_receipt_json FROM billing_placement_namespaces WHERE operation_id=?').get(id)!;
      expect(creationClaim).toMatchObject({ state: 'creating', creation_receipt_json: null });
      const providerCreation = await readFilesystemCreation(setup.destinationStores.get(targetName)!);
      expect(providerCreation).toMatchObject({ version: 1, provider: 'local', storage_name: targetName, marker: creationClaim.creation_marker, provider_id: expect.any(String) });
      expect(await localStore.observeCreation(targetName)).toEqual(providerCreation);
      const scratch = source.sqlite.prepare('SELECT * FROM billing_placement_scratch WHERE operation_id=?').get(id)!;
      expect(scratch).toMatchObject({ state: 'stored', deleted_at: null });
      expect(await setup.destination.blobs.head(String(scratch.object_key))).toMatchObject({ size: Number(scratch.bytes) });
      expect(scratchWrites).toBe(1);
      expect(setup.provisions.get(targetName)).toBe(1);
      expect(destination.sqlite.prepare('SELECT 1 FROM git_publications WHERE id=?').get(id)).toBeUndefined();
      const provision = source.sqlite.prepare("SELECT * FROM billing_placement_receipts WHERE operation_id=? AND step='git-provision'").get(id)!;
      expect(provision).toBeDefined();
      const frozenRows = source.sqlite.prepare('SELECT table_name,row_key,data_json FROM move_source_rows WHERE operation_id=? ORDER BY table_name,row_key').all(id);
      expect(await movePublisherState(env, setup.repoId, { operation_id: id, side: 'target', action: 'read' }))
        .toMatchObject({ terminal: false, state: 'not_started', closed: false });
      await expect(runShardMove(env, operation)).rejects.toThrow();
      expect(loseRestore, setup.diagnostics.map(String).join('\n')).toBe(false);
      const ownedCreation = source.sqlite.prepare('SELECT state,creation_receipt_json FROM billing_placement_namespaces WHERE operation_id=?').get(id)!;
      expect(ownedCreation.state).toBe('owned');
      expect(JSON.parse(String(ownedCreation.creation_receipt_json))).toEqual(providerCreation);
      const publication = destination.sqlite.prepare('SELECT actor_json,context_json,state,finalized FROM git_publications WHERE id=?').get(id)!;
      expect(publication).toMatchObject({ state: 'committed', finalized: 1 });
      expect(JSON.parse(String(publication.actor_json))).toEqual(setup.actor);
      expect(JSON.parse(String(publication.context_json))).toMatchObject({ move: { operation_id: id, actor_id: setup.actor.id,
        actor_sha256: await sha256(canonicalJson(setup.actor)), repository_revision: capturedRepository.revision,
        snapshot_sha256: control.snapshot_sha256, manifest_sha256: control.archive_manifest_sha256,
        source: { cell_id: env.CELL_ID, shard_id: env.SHARD_ID, epoch: 1, storage_name: setup.storageName },
        destination: { cell_id: target.CELL_ID, shard_id: 'destination', epoch: 2, storage_name: targetName } }, storage_admission: { settled: true } });
      expect(JSON.parse(String(publication.context_json)).maintenance).toBeUndefined();
      expect(destination.sqlite.prepare('SELECT * FROM repositories WHERE id=?').get(setup.repoId))
        .toEqual({ ...capturedRepository, cell_id: target.CELL_ID, shard_id: 'destination', routing_epoch: 2 });
      expect(source.sqlite.prepare('SELECT * FROM repositories WHERE id=?').get(setup.repoId)).toEqual(capturedRepository);
      expect(source.sqlite.prepare('SELECT state,uploaded_at,object_key FROM billing_placement_scratch WHERE operation_id=?').get(id))
        .toEqual({ state: 'deleted', uploaded_at: scratch.uploaded_at, object_key: scratch.object_key });
      expect(await setup.destination.blobs.head(String(scratch.object_key))).toBeNull();
      const restored = setup.destinationStores.get(targetName)!;
      expect(await setup.git(restored, 'rev-parse', 'main')).toBe(head);
      expect(await setup.git(restored, 'rev-parse', 'previous')).toBe(base);
      expect(await setup.git(restored, 'show', 'main:history.txt')).toBe('Restored by the recorded credential');
      expect(await setup.git(restored, 'fsck', '--strict', '--full', '--no-dangling')).toBe('');
      const completed = await runShardMove(env, operation);
      expect(completed).toMatchObject({ moved: true, restored: false, routing_epoch: 2 });
      expect(await runShardMove(env, operation)).toEqual(completed);
      expect(scratchWrites).toBe(1); expect(setup.provisions.get(targetName)).toBe(1);
      expect(await localStore.observeCreation(targetName)).toEqual(providerCreation);
      expect(source.sqlite.prepare('SELECT state,creation_receipt_json FROM billing_placement_namespaces WHERE operation_id=?').get(id)).toEqual(ownedCreation);
      expect(source.sqlite.prepare("SELECT * FROM billing_placement_receipts WHERE operation_id=? AND step='git-provision'").get(id)).toEqual(provision);
      expect(source.sqlite.prepare('SELECT table_name,row_key,data_json FROM move_source_rows WHERE operation_id=? ORDER BY table_name,row_key').all(id)).toEqual(frozenRows);
      expect(destination.sqlite.prepare('SELECT revision,policy_revision,routing_epoch FROM repositories WHERE id=?').get(setup.repoId))
        .toEqual({ revision: Number(capturedRepository.revision) + 1, policy_revision: capturedRepository.policy_revision, routing_epoch: 2 });
      expect(destination.sqlite.prepare('SELECT actor_id,credential_id FROM audit_log WHERE id=?').get(`audit_git_${id}`))
        .toEqual({ actor_id: setup.actor.id, credential_id: setup.actor.credential_id });
      expect(setup.sourceStores.size).toBe(0);
      for (const db of [ingress, destination]) expect(db.sqlite.prepare('SELECT 1 FROM credentials WHERE id=?').get(setup.actor.credential_id)).toBeUndefined();
      expect(ingress.sqlite.prepare('SELECT COUNT(*) AS n FROM repositories').get()).toMatchObject({ n: 0 });
      expect(ingress.sqlite.prepare('SELECT COUNT(*) AS n FROM git_publications').get()).toMatchObject({ n: 0 });
      expect(setup.admissionHomes.get(target.CELL_ID)!.has(`account:${setup.accountId}`)).toBe(false);
      for (const db of [source, destination]) expect(db.sqlite.prepare('SELECT state FROM repository_metadata_fences WHERE repo_id=?').get(setup.repoId)).toMatchObject({ state: 'released' });
    } finally { await setup.close(); ingress.close(); }
  }, 180_000);

  test('move rollback retains a permitted native publisher until its original delayed acceptance is reconciled', async () => {
    const setup = await moveFixture();
    const { env, target } = setup, source = setup.source.db, destination = setup.destination.db;
    let releasePermit!: () => void, reachedPermit!: () => void;
    const permitHeld = new Promise<void>(resolve => { reachedPermit = resolve; });
    const resumePermit = new Promise<void>(resolve => { releasePermit = resolve; });
    let running: Promise<unknown> | undefined;
    try {
      const head = await setup.initializeGit();
      const accepted = await submitShardMove(env, { repo_id: setup.repoId, expected_epoch: 1, target_cell_id: target.CELL_ID, target_shard_id: target.SHARD_ID }, false);
      const { id } = await accepted.json() as { id: string }, operation = await operationById(env, id);
      const namespace = target.REPO_COORDINATOR;
      let permits = 0;
      target.REPO_COORDINATOR = { idFromName: namespace.idFromName.bind(namespace), get: (name: DurableObjectId) => ({ fetch: async (request: Request) => {
        const response = await namespace.get(name).fetch(request);
        if (new URL(request.url).pathname === `/operations/${id}/permit` && response.ok) {
          permits++; reachedPermit(); await resumePermit;
        }
        return response;
      } }) } as unknown as DurableObjectNamespace;
      running = runShardMove(env, operation);
      void running.catch(() => {});
      await Promise.race([permitHeld, running.then(() => { throw new Error('The move completed without reaching its native permit boundary.'); })]);
      const control = await moveControl(env, id), restored = setup.destinationStores.get(control.target_storage_name)!;
      const scratch = source.sqlite.prepare('SELECT state,object_key FROM billing_placement_scratch WHERE operation_id=?').get(id)!;
      expect(scratch.state).toBe('stored');
      expect(destination.sqlite.prepare('SELECT state,finalized FROM git_publications WHERE id=?').get(id)).toMatchObject({ state: 'publishing', finalized: 0 });
      await expect(abortShardMove(env, id)).rejects.toThrow();
      expect(await movePublisherState(env, setup.repoId, { operation_id: id, side: 'target', action: 'read' }))
        .toMatchObject({ state: 'uncertain', terminal: false, finalized: false, closed: true });
      expect((await git(restored, ['show-ref', '--verify', transactionRef(id)])).code).not.toBe(0);
      expect(setup.destinationStores.has(control.target_storage_name)).toBe(true);
      expect(await setup.destination.blobs.head(String(scratch.object_key))).not.toBeNull();
      for (const db of [source, destination]) expect(db.sqlite.prepare('SELECT state FROM repository_metadata_fences WHERE repo_id=?').get(setup.repoId)).toMatchObject({ state: 'held' });
      expect(await setup.git(setup.sourceStores.get(setup.storageName)!, 'rev-parse', 'main')).toBe(head);
      releasePermit();
      await running.catch(() => {});
      const published = destination.sqlite.prepare('SELECT state,finalized,result_json FROM git_publications WHERE id=?').get(id)!;
      expect(published, setup.diagnostics.map(String).join('\n')).toMatchObject({ state: 'committed', finalized: 1 });
      const result = JSON.parse(String(published.result_json)) as PublicationResult;
      expect(await setup.git(restored, 'rev-parse', transactionRef(id))).toBe(result.marker_oid);
      expect(await setup.git(restored, 'rev-parse', 'main')).toBe(head);
      expect(await setup.git(restored, 'fsck', '--strict', '--full', '--no-dangling')).toBe('');
      expect(permits).toBe(1); expect(setup.provisions.get(control.target_storage_name)).toBe(1);
      expect(await abortShardMove(env, id)).toMatchObject({ aborted: true, routing_epoch: 3 });
      expect(setup.destinationStores.has(control.target_storage_name)).toBe(false);
      expect(destination.sqlite.prepare('SELECT 1 FROM repositories WHERE id=?').get(setup.repoId)).toBeUndefined();
      expect(await movePublisherState(env, setup.repoId, { operation_id: id, side: 'target', action: 'read' }))
        .toMatchObject({ state: 'committed', terminal: true, finalized: true, closed: true });
      expect(await setup.git(setup.sourceStores.get(setup.storageName)!, 'rev-parse', 'main')).toBe(head);
      for (const db of [source, destination]) expect(db.sqlite.prepare('SELECT state FROM repository_metadata_fences WHERE repo_id=?').get(setup.repoId)).toMatchObject({ state: 'released' });
    } finally { releasePermit(); await running?.catch(() => {}); await setup.close(); }
  }, 180_000);

  test('a definitively unstarted move publisher releases its original scratch only through fenced rollback', async () => {
    const setup = await moveFixture();
    const source = setup.source.db, destination = setup.destination.db;
    try {
      const head = await setup.initializeGit();
      const accepted = await submitShardMove(setup.env, { repo_id: setup.repoId, expected_epoch: 1, target_cell_id: setup.target.CELL_ID,
        target_shard_id: setup.target.SHARD_ID, principal: setup.actor }, false);
      const { id } = await accepted.json() as { id: string }, operation = await operationById(setup.env, id);
      const put = setup.destination.blobs.put.bind(setup.destination.blobs);
      let scratchWrites = 0;
      setup.destination.blobs.put = async (...args) => {
        const result = await put(...args);
        if (args[2]?.customMetadata?.billing_placement_scratch === id) {
          scratchWrites++;
          source.sqlite.prepare('UPDATE credentials SET revoked_at=? WHERE id=?').run(new Date().toISOString(), setup.actor.credential_id);
        }
        return result;
      };
      await expect(runShardMove(setup.env, operation)).rejects.toThrow();
      const control = await moveControl(setup.env, id);
      expect(scratchWrites).toBe(1);
      expect(source.sqlite.prepare("SELECT 1 FROM billing_placement_receipts WHERE operation_id=? AND step='git-provision'").get(id)).toBeUndefined();
      expect(setup.provisions.get(control.target_storage_name)).toBeUndefined();
      expect(destination.sqlite.prepare('SELECT 1 FROM git_publications WHERE id=?').get(id)).toBeUndefined();
      const scratch = source.sqlite.prepare('SELECT state,object_key FROM billing_placement_scratch WHERE operation_id=?').get(id)!;
      expect(scratch.state).toBe('stored');
      expect(await setup.destination.blobs.head(String(scratch.object_key))).not.toBeNull();
      for (const db of [source, destination]) expect(db.sqlite.prepare('SELECT state FROM repository_metadata_fences WHERE repo_id=?').get(setup.repoId)).toMatchObject({ state: 'held' });
      expect(await abortShardMove(setup.env, id)).toMatchObject({ aborted: true, routing_epoch: 3 });
      expect(await movePublisherState(setup.env, setup.repoId, { operation_id: id, side: 'target', action: 'read' }))
        .toMatchObject({ state: 'not_started', closed: true, terminal: true, finalized: true });
      expect(source.sqlite.prepare('SELECT state FROM billing_placement_scratch WHERE operation_id=?').get(id)).toMatchObject({ state: 'deleted' });
      expect(await setup.destination.blobs.head(String(scratch.object_key))).toBeNull();
      expect(setup.provisions.get(control.target_storage_name)).toBeUndefined();
      expect(await setup.git(setup.sourceStores.get(setup.storageName)!, 'rev-parse', 'main')).toBe(head);
      expect(destination.sqlite.prepare('SELECT 1 FROM repositories WHERE id=?').get(setup.repoId)).toBeUndefined();
      for (const db of [source, destination]) expect(db.sqlite.prepare('SELECT state FROM repository_metadata_fences WHERE repo_id=?').get(setup.repoId)).toMatchObject({ state: 'released' });
      const capacity = await admissionRequest<{ control: { reserved_bytes: string; stored_bytes: string } }>(setup.env, `capacity:${setup.target.BILLING_GIT_STORAGE_SLICE_ID}`, 'snapshot');
      expect(capacity.control).toMatchObject({ reserved_bytes: '0', stored_bytes: '0' });
    } finally { await setup.close(); }
  }, 120_000);

  test('a rejected create-only race never adopts or deletes the foreign filesystem namespace on retry or rollback', async () => {
    const setup = await moveFixture();
    const source = setup.source.db, destination = setup.destination.db;
    try {
      const head = await setup.initializeGit();
      const accepted = await submitShardMove(setup.env, { repo_id: setup.repoId, expected_epoch: 1, target_cell_id: setup.target.CELL_ID,
        target_shard_id: setup.target.SHARD_ID }, false);
      const { id } = await accepted.json() as { id: string }, operation = await operationById(setup.env, id);
      const providerFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
      let foreignPath = '', creates = 0;
      vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.origin === 'http://127.0.0.1:8792' && request.method === 'PUT') {
          creates++;
          if (!foreignPath) {
            const name = url.pathname.split('/').at(-1)!;
            foreignPath = join(dirname(dirname(setup.sourceStores.get(setup.storageName)!)), 'destination', `${name}.git`);
            await mkdir(dirname(foreignPath), { recursive: true });
            await provisionFilesystemRepository(foreignPath, 'foreign', { create_only: true });
            await writeFile(join(foreignPath, 'foreign-owner'), 'Belongs to the competing provider creator\n');
          }
        }
        return providerFetch(input, init);
      });
      await expect(runShardMove(setup.env, operation)).rejects.toThrow();
      expect(foreignPath, setup.diagnostics.map(String).join('\n')).not.toBe('');
      expect(creates).toBe(1);
      const control = await moveControl(setup.env, id);
      expect(destination.sqlite.prepare('SELECT 1 FROM git_publications WHERE id=?').get(id)).toBeUndefined();
      await expect(runShardMove(setup.env, operation)).rejects.toThrow();
      expect(creates).toBe(1);
      expect(destination.sqlite.prepare('SELECT 1 FROM git_publications WHERE id=?').get(id)).toBeUndefined();
      expect(await setup.git(foreignPath, 'symbolic-ref', 'HEAD')).toBe('refs/heads/foreign');
      expect(await abortShardMove(setup.env, id)).toMatchObject({ aborted: true, routing_epoch: 3 });
      expect(await readFile(join(foreignPath, 'foreign-owner'), 'utf8')).toBe('Belongs to the competing provider creator\n');
      expect(await setup.git(foreignPath, 'symbolic-ref', 'HEAD')).toBe('refs/heads/foreign');
      expect(await setup.git(setup.sourceStores.get(setup.storageName)!, 'rev-parse', 'main')).toBe(head);
      expect(source.sqlite.prepare('SELECT state FROM billing_placement_scratch WHERE operation_id=?').get(id)).toMatchObject({ state: 'deleted' });
      expect(await movePublisherState(setup.env, setup.repoId, { operation_id: id, side: 'target', action: 'read' }))
        .toMatchObject({ terminal: true, state: 'not_started', closed: true, storage_name: control.target_storage_name });
    } finally { await setup.close(); }
  }, 120_000);

  test('a lost create-only rejection preserves the foreign graph and the original funded fences through retry and abort', async () => {
    const setup = await moveFixture();
    const { env, target } = setup, source = setup.source.db, destination = setup.destination.db;
    try {
      const head = await setup.initializeGit(), sourcePath = setup.sourceStores.get(setup.storageName)!;
      const accepted = await submitShardMove(env, { repo_id: setup.repoId, expected_epoch: 1, target_cell_id: target.CELL_ID, target_shard_id: target.SHARD_ID }, false);
      const { id } = await accepted.json() as { id: string }, operation = await operationById(env, id);
      const providerFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
      const put = setup.destination.blobs.put.bind(setup.destination.blobs);
      let foreignPath = '', foreignHead = '', creates = 0, deletes = 0, scratchWrites = 0, lostRejection = false;
      setup.destination.blobs.put = async (...args) => {
        if (args[2]?.customMetadata?.billing_placement_scratch === id) scratchWrites++;
        return put(...args);
      };
      vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init), url = new URL(request.url);
        const provider = url.origin === 'http://127.0.0.1:8792';
        if (provider && request.method === 'DELETE') deletes++;
        if (provider && request.method === 'PUT') {
          creates++;
          const name = url.pathname.split('/').at(-1)!;
          foreignPath = join(dirname(dirname(sourcePath)), 'destination', `${name}.git`);
          await mkdir(dirname(foreignPath), { recursive: true });
          await provisionFilesystemRepository(foreignPath, 'foreign', { create_only: true, ownership_marker: `gk-other-creator-v1:${Buffer.from(randomBytes(32)).toString('hex')}` });
          const work = join(dirname(foreignPath), 'foreign-work');
          await setup.git(dirname(foreignPath), 'clone', '--template=', '--no-local', sourcePath, work);
          await setup.git(work, 'checkout', '-b', 'foreign');
          await writeFile(join(work, 'foreign.txt'), 'Only the competing creator owns these objects\n');
          await setup.git(work, 'add', '--', 'foreign.txt');
          await setup.git(work, '-c', 'user.name=Foreign creator', '-c', 'user.email=foreign@example.test', 'commit', '-m', 'Independent foreign graph');
          await setup.git(work, 'push', foreignPath, 'HEAD:refs/heads/foreign');
          foreignHead = await setup.git(foreignPath, 'rev-parse', 'foreign');
          const rejected = await providerFetch(input, init);
          expect(rejected.status).toBe(409);
          expect(await rejected.json()).toEqual({ error: { code: 'storage_namespace_exists', proof: 'not_started' } });
          lostRejection = true;
          throw new Error('The actual provider refusal was lost before the Git caller received its proof');
        }
        return providerFetch(input, init);
      });
      await expect(runShardMove(env, operation)).rejects.toThrow();
      expect(lostRejection, setup.diagnostics.map(String).join('\n')).toBe(true);
      const control = await moveControl(env, id);
      const claim = source.sqlite.prepare('SELECT * FROM billing_placement_namespaces WHERE operation_id=?').get(id)!;
      expect(claim).toMatchObject({ state: 'creating', creation_receipt_json: null, owned_at: null, not_started_at: null });
      const foreignCreation = await readFilesystemCreation(foreignPath);
      expect(foreignCreation?.marker).not.toBe(claim.creation_marker);
      expect(foreignCreation).not.toBeNull();
      const scratch = source.sqlite.prepare('SELECT * FROM billing_placement_scratch WHERE operation_id=?').get(id)!;
      expect(scratch.state).toBe('stored');
      const sourceRepository = source.sqlite.prepare('SELECT * FROM repositories WHERE id=?').get(setup.repoId)!;
      const targetRepository = destination.sqlite.prepare('SELECT * FROM repositories WHERE id=?').get(setup.repoId)!;
      const reservations = async () => {
        const participants = [`account:${setup.accountId}`, `capacity:${target.BILLING_GIT_STORAGE_SLICE_ID}`];
        return Promise.all(participants.map(async participant => {
          const snapshot = await admissionRequest<{ control: AdmissionControl; budgets: Budget[] }>(env, participant, 'snapshot');
          expect(BigInt(snapshot.control.reserved_bytes)).toBeGreaterThan(0n);
          return { bytes: snapshot.control.reserved_bytes, budgets: snapshot.budgets.map(budget => [budget.id, budget.reserved_units]) };
        }));
      };
      const originalReservations = await reservations();
      const unchanged = async () => {
        expect(creates).toBe(1); expect(deletes).toBe(0); expect(scratchWrites).toBe(1);
        expect(setup.provisions.get(control.target_storage_name)).toBe(1);
        expect(await readFilesystemCreation(foreignPath)).toEqual(foreignCreation);
        expect(await setup.git(foreignPath, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(`refs/heads/foreign ${foreignHead}`);
        expect(await setup.git(foreignPath, 'show', 'foreign:foreign.txt')).toBe('Only the competing creator owns these objects');
        expect(await setup.git(foreignPath, 'fsck', '--strict', '--full', '--no-dangling')).toBe('');
        expect(await setup.git(sourcePath, 'rev-parse', 'main')).toBe(head);
        expect(source.sqlite.prepare('SELECT * FROM billing_placement_namespaces WHERE operation_id=?').get(id)).toEqual(claim);
        expect(source.sqlite.prepare('SELECT * FROM billing_placement_scratch WHERE operation_id=?').get(id)).toEqual(scratch);
        expect(await setup.destination.blobs.head(String(scratch.object_key))).toMatchObject({ size: Number(scratch.bytes) });
        expect(source.sqlite.prepare('SELECT * FROM repositories WHERE id=?').get(setup.repoId)).toEqual(sourceRepository);
        expect(destination.sqlite.prepare('SELECT * FROM repositories WHERE id=?').get(setup.repoId)).toEqual(targetRepository);
        expect(destination.sqlite.prepare('SELECT 1 FROM git_publications WHERE id=?').get(id)).toBeUndefined();
        expect(await reservations()).toEqual(originalReservations);
        for (const db of [source, destination]) expect(db.sqlite.prepare('SELECT state FROM repository_metadata_fences WHERE repo_id=?').get(setup.repoId)).toMatchObject({ state: 'held' });
        const barrier = await coordinatorRequest(env, setup.repoId, '/barrier/check', { operation_id: id, token: `move_${id}` });
        expect(barrier.status, await barrier.clone().text()).toBe(200);
        const released = await coordinatorRequest(env, setup.repoId, '/barrier', { operation_id: id, token: `move_${id}` }, 'DELETE');
        expect(released.status).toBe(409);
      };
      await unchanged();
      await expect(runShardMove(env, operation)).rejects.toThrow();
      await unchanged();
      for (let retry = 0; retry < 2; retry++) {
        await expect(abortShardMove(env, id)).rejects.toThrow();
        await unchanged();
      }
      expect((await moveControl(env, id)).state).toBe('aborting');
      expect((await storagePlacement(env, id)).state).toBe('aborting');
    } finally { await setup.close(); }
  }, 180_000);

  test('purge excludes self-owned candidates but preserves external private candidate and patch history', async () => {
    const original = await new Fixture().initialize();
    const base = await original.commit('base.txt', 'base\n');
    expect((await original.push('HEAD:refs/heads/main')).code).toBe(0);
    const head = await original.commit('private.txt', 'retained outside the deleted repository\n');
    expect((await original.push('HEAD:refs/heads/feature')).code).toBe(0);
    const self = { id: 'candidate_self_purge', source_repo_id: original.id, source_oid: head, target_ref: 'refs/heads/main', target_oid: base, strategy: 'merge' as const };
    const own = await original.mutate({ kind: 'candidate', candidate: self, author: { name: 'Native actor', email: 'native@example.test' }, message: 'Same repository candidate' });
    expect(own.status, await own.clone().text()).toBe(200);
    const selfResult = await own.json() as PublicationResult;
    const foreign = await new Fixture().initialize();
    expect((await foreign.mutate({ kind: 'fork', source: { authority: 'local', url: original.canonical } })).status).toBe(200);
    const external = { ...self, id: 'candidate_external_purge' };
    const retained = await foreign.mutate({ kind: 'candidate', candidate: external, source: { authority: 'local', url: original.canonical },
      author: { name: 'Native actor', email: 'native@example.test' }, message: 'External private candidate' });
    expect(retained.status, await retained.clone().text()).toBe(200);
    const externalResult = await retained.json() as PublicationResult;
    const setup = await gatewayFixture([original, foreign]);
    try {
      const at = new Date().toISOString();
      for (const [repoId, candidate, result] of [[original.id, self, selfResult], [foreign.id, external, externalResult]] as const) {
        setup.db.sqlite.prepare(`INSERT INTO git_candidates(repo_id,id,source_repo_id,source_oid,target_ref,target_oid,candidate_oid,internal_ref,strategy,policy_revision,actor_id,state,operation_id,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,1,?,'ready',?,?,?)`).run(repoId, candidate.id, original.id, head, candidate.target_ref, base, result.refs[0].new_oid,
        `refs/gitknot/candidates/${candidate.id}`, candidate.strategy, actor.id, result.operation_id, at, at);
      }
      setup.db.sqlite.prepare("UPDATE repositories SET state='deleted',recovery_until=? WHERE id=?").run('2000-01-01T00:00:00.000Z', original.id);
      setup.db.sqlite.prepare(`INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,status,input_json,created_at,updated_at)
        VALUES ('op_purge_native_self','repository.purge',?,?,?,'system:operations','running','{"maintenance":true}',?,?)`).run(original.id, original.id, actor.id, at, at);
      const purge = () => internalGit(setup.env, original.id, 'purge', { operation_id: 'op_purge_native_self', storage_name: original.id, retained_refs: [] });
      expect((await purge()).status).toBe(409);
      setup.db.sqlite.prepare("UPDATE git_candidates SET state='obsolete' WHERE repo_id=?").run(foreign.id);
      setup.db.sqlite.prepare(`INSERT INTO collaboration_items(id,repo_id,kind,number,title,markdown,author_id,state,created_at,updated_at)
        VALUES ('pr_external_history',?,'pull_request',1,'Private review','',?,'open',?,?)`).run(foreign.id, actor.id, at, at);
      setup.db.sqlite.prepare(`INSERT INTO pull_requests(id,repo_id,head_repo_id,base_ref,head_ref,base_oid,head_oid)
        VALUES ('pr_external_history',?,?,'refs/heads/main','refs/heads/feature',?,?)`).run(foreign.id, original.id, base, head);
      setup.db.sqlite.prepare(`INSERT INTO pull_patches(id,repo_id,pull_id,version,head_repo_id,base_oid,head_oid,merge_base_oid,patch_fingerprint,native_evidence_id,created_by,created_at)
        VALUES ('patch_external_history',?,'pr_external_history',1,?,?,?,?,?,'git_ev_external_history',?,?)`).run(foreign.id, original.id, base, head, base, 'a'.repeat(64), actor.id, at);
      expect((await purge()).status).toBe(409);
      expect((await git(foreign.canonical, ['show', 'refs/heads/feature:private.txt'])).stdout).toBe('retained outside the deleted repository\n');
      setup.db.sqlite.prepare("UPDATE repositories SET state='deleted' WHERE id=?").run(foreign.id);
      const deleted = await purge();
      expect(deleted.status, await deleted.clone().text()).toBe(200);
      expect(await deleted.json()).toEqual({ deleted: true, verified: true });
      await expect(stat(original.canonical)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await git(foreign.canonical, ['show', 'refs/heads/feature:private.txt'])).stdout).toBe('retained outside the deleted repository\n');
    } finally { setup.close(); }
  }, 120_000);

  test('public PR creation and patch updates retain real native history without invalidating their catalog snapshot', async () => {
    const fixture = await new Fixture().initialize();
    const setup = await gatewayFixture([fixture]);
    const stores: SqliteJournal[] = [];
    try {
      setup.db.sqlite.prepare('UPDATE credentials SET capabilities_json=?,ref_patterns_json=NULL,path_patterns_json=NULL WHERE id=?').run('["*"]', actor.credential_id);
      setup.env.IDENTITY_KEYS_JSON = JSON.stringify({ current: 'test', keys: { test: Buffer.alloc(32, 7).toString('base64url') } });
      setup.env.BILLING_GIT_STORAGE_SLICE_ID = 'slice_pr_retention';
      const at = new Date().toISOString();
      const until = new Date(Date.now() + 86400_000).toISOString();
      setup.db.sqlite.prepare(`INSERT INTO billing_platform_pools(id,period_start,period_end,limit_units,safety_buffer_units,baseline_commitment_units,allocated_units,max_instances,allocated_instances,state)
        VALUES ('pool_pr_retention',?,?,'1000000000000','0','0','1000000000',1,0,'active')`).run(at, until);
      setup.db.sqlite.prepare(`INSERT INTO billing_capacity_slices(id,pool_id,cell_id,limit_units,max_instances,max_storage_bytes,valid_until,state,created_at)
        VALUES ('slice_pr_retention','pool_pr_retention','local','1000000000',0,'1000000000',?,'active',?)`).run(until, at);
      const controllers = new Map<string, AdmissionController>();
      setup.env.ADMISSION = { idFromName: (name: string) => ({ toString: () => name }), get(id: { toString(): string }) {
        let controller = controllers.get(id.toString());
        if (!controller) {
          const storage = Object.assign(new SqliteJournal(':memory:'), { setAlarm: async () => {} });
          stores.push(storage);
          controller = new AdmissionController({ id, storage, blockConcurrencyWhile: (callback: () => Promise<unknown>) => callback(), waitUntil() {} } as unknown as DurableObjectState, setup.env);
          controllers.set(id.toString(), controller);
        }
        return { fetch: (request: Request) => controller!.fetch(request) };
      } } as unknown as DurableObjectNamespace;
      integratedGateways.set(fixture.id, setup.env);
      const api = gatewayApi(setup.env);
      registerCollaborationRoutes(api);
      const call = (path: string, body: unknown, idempotencyKey: string, revision?: string) => api.fetch(new Request(`http://api.test/v1/repos/${fixture.id}/${path}`, {
        method: 'POST', headers: { authorization: `Bearer gkt_${'g'.repeat(43)}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey,
          ...(revision ? { 'if-match': `"${revision}"` } : {}) }, body: JSON.stringify(body),
      }), setup.env);
      const success = async <T>(response: Response): Promise<T> => {
        const body = await response.json(); expect(response.status, `${JSON.stringify(body)} ${JSON.stringify(diagnostics.slice(-3))}`).toBe(201); return body as T;
      };
      const catalog = () => setup.db.sqlite.prepare('SELECT revision,policy_revision,routing_epoch,updated_at FROM repositories WHERE id=?').get(fixture.id)!;
      const initial = await success<{ result: PublicationResult }>(await call('files', { ref: 'refs/heads/main', expected_oid: ZERO_OID,
        message: 'Create native PR base', edits: [{ path: 'README.md', content_base64: Buffer.from('main\n').toString('base64') },
          { path: 'deleted.txt', content_base64: Buffer.from('old-side review line\n').toString('base64') }] }, 'native-pr-base', ZERO_OID));
      const base = initial.result.refs[0].new_oid;
      await success(await call('refs', { updates: [{ ref: 'refs/heads/feature', old_oid: ZERO_OID, new_oid: base }] }, 'native-pr-branch', String(catalog().revision)));
      const proposed = await success<{ result: PublicationResult }>(await call('files', { ref: 'refs/heads/feature', expected_oid: base,
        message: 'Delete reviewed file', edits: [{ path: 'deleted.txt', delete: true }] }, 'native-pr-head', base));
      const head = proposed.result.refs[0].new_oid;
      const before = catalog();
      const request = { title: 'Retained native deletion', markdown: 'Exact review evidence', base_ref: 'refs/heads/main', head_ref: 'refs/heads/feature', base_oid: base, head_oid: head };
      const pull = await success<{ id: string; revision: number; current_patch_id: string; patch: { native_evidence_id: string } }>(await call('pulls', request, 'native-pr-create'));
      expect(catalog()).toEqual(before);
      const retention = setup.db.sqlite.prepare(`SELECT p.state,p.finalized,p.context_json,s.id FROM git_review_snapshots s
        JOIN git_publications p ON p.repo_id=s.repo_id AND p.id=s.operation_id WHERE s.repo_id=? AND s.id=?`).get(fixture.id, pull.patch.native_evidence_id)!;
      expect(retention).toMatchObject({ state: 'committed', finalized: 1 });
      expect(JSON.parse(String(retention.context_json))).toMatchObject({ storage_admission: { settled: true } });
      for (const ref of reviewRefs(pull.patch.native_evidence_id)) expect((await git(fixture.canonical, ['show-ref', '--verify', ref])).code).toBe(0);
      const replay = await success<{ id: string }>(await call('pulls', request, 'native-pr-create'));
      expect(replay.id).toBe(pull.id);
      expect(setup.db.sqlite.prepare("SELECT COUNT(*) AS n FROM collaboration_items WHERE kind='pull_request'").get()).toMatchObject({ n: 1 });
      const diff = await api.fetch(new Request(`http://api.test/v1/repos/${fixture.id}/pulls/${pull.id}/diff`, { headers: { authorization: `Bearer gkt_${'g'.repeat(43)}` } }), setup.env);
      expect(diff.status, await diff.clone().text()).toBe(200);
      expect(await diff.text()).toContain('+++ /dev/null');
      const amended = await success<{ result: PublicationResult }>(await call('files', { ref: 'refs/heads/feature', expected_oid: head,
        message: 'Amend the proposal', edits: [{ path: 'README.md', content_base64: Buffer.from('amended proposal\n').toString('base64') }] }, 'native-pr-amend', head));
      const nextHead = amended.result.refs[0].new_oid;
      const beforePatch = catalog();
      await success(await call(`pulls/${pull.id}/patches`, { base_oid: base, head_oid: nextHead }, 'native-pr-patch', String(pull.revision)));
      expect(catalog()).toEqual(beforePatch);
      expect(setup.db.sqlite.prepare('SELECT COUNT(*) AS n FROM pull_patches WHERE pull_id=?').get(pull.id)).toMatchObject({ n: 2 });
      const realGit = setup.env.GIT_SERVICE;
      let interleaved = false;
      setup.env.GIT_SERVICE = { fetch: async (incoming: Request) => {
        const inspect = new URL(incoming.url).pathname.endsWith('/collaboration/inspect')
          ? await incoming.clone().json() as { retain?: boolean; inspection?: { kind: string } } : null;
        const response = await realGit.fetch(incoming);
        if (!interleaved && response.ok && inspect?.retain === true && inspect.inspection?.kind === 'patch') {
          interleaved = true;
          await success(await call('refs', { updates: [{ ref: 'refs/heads/concurrent', old_oid: ZERO_OID, new_oid: base }] },
            'native-pr-concurrent-ref', String(catalog().revision)));
        }
        return response;
      } } as unknown as Fetcher;
      const rejected = await call('pulls', { ...request, title: 'Must retain its original snapshot', head_oid: nextHead }, 'native-pr-concurrent-create');
      expect(rejected.status, await rejected.clone().text()).toBe(412);
      expect(interleaved).toBe(true);
      expect(catalog().policy_revision).toBe(beforePatch.policy_revision);
      expect(catalog().revision).toBe(Number(beforePatch.revision) + 1);
      expect(setup.db.sqlite.prepare("SELECT COUNT(*) AS n FROM collaboration_items WHERE kind='pull_request'").get()).toMatchObject({ n: 1 });
      setup.env.GIT_SERVICE = realGit;
      const beforeCandidate = catalog();
      const candidate = await success<{ result: PublicationResult }>(await call('git/candidates', { source_repo_id: fixture.id, source_oid: nextHead,
        target_ref: 'refs/heads/main', target_oid: base, strategy: 'merge', message: 'Retained verification candidate' }, 'native-pr-candidate', String(beforeCandidate.revision)));
      expect(candidate.result.refs[0].ref).toMatch(/^refs\/gitknot\/candidates\//u);
      expect(catalog()).toEqual(beforeCandidate);
    } finally {
      integratedGateways.delete(fixture.id); setup.close();
      for (const store of stores) store.db.close();
    }
  }, 120_000);
});

function insertSqlRow(db: SqliteD1, table: string, row: Record<string, string | number | bigint | Uint8Array | null>): void {
  const fields = Object.keys(row);
  db.sqlite.prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`).run(...Object.values(row));
}

function copySqlRow(source: SqliteD1, target: SqliteD1, table: string, id: string, field = 'id'): void {
  const row = source.sqlite.prepare(`SELECT * FROM ${table} WHERE ${field}=?`).get(id);
  expect(row).toBeDefined();
  insertSqlRow(target, table, row!);
}

async function integratedCallback<T>(spec: NativeSessionSpec, action: string, payload: unknown): Promise<T> {
  const env = integratedGateways.get(spec.repository.id)!;
  const request = new Request(`${spec.callback_url}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ publisher_id: spec.publisher_id, fence: spec.fence, ...payload as object }),
  });
  const response = await gitGateway.fetch(await signInternalRequest(request, key, GIT_NATIVE_SCOPE), env);
  const result = await response.json() as T & { error?: { code: string; message: string } };
  if (!response.ok) throw new GitError(result.error?.code ?? 'callback_failed', result.error?.message ?? 'Native gateway callback failed.', response.status);
  return result;
}

/** Real gateway/identity/queue admission and native processes; explicit filesystem storage replaces Artifacts. */
async function gatewayFixture(repositories: Fixture[]): Promise<{ env: GitBindings; db: SqliteD1; helperCalls: string[]; localStores: Map<string, string>; close(): void }> {
  const db = await createTestDatabase();
  const at = new Date().toISOString();
  db.sqlite.prepare('INSERT INTO users(id,username,email,display_name,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(actor.id, 'native-gateway', 'native-gateway@example.test', 'Native gateway actor', at, at, at);
  db.sqlite.prepare("INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES (?,'user',?,?,?,?,?)")
    .run(actor.id, 'native-gateway', 'Native gateway owner', actor.id, at, at);
  db.sqlite.prepare("INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES (?,'user',?,?,?,?,?,?)")
    .run(actor.id, actor.id, actor.id, 'Native gateway actor', actor.id, at, at);
  db.sqlite.prepare(`INSERT INTO credentials(id,principal_id,user_id,kind,name,token_hash,token_prefix,capabilities_json,ref_patterns_json,path_patterns_json,
    auth_revision,mfa,authenticated_at,expires_at,created_by,created_at) VALUES (?,?,?,'personal','Merge only',?,'gateway',
    '["contents.read","pull_requests.merge"]','["refs/heads/main"]','["scoped/**"]',1,1,?,?,?,?)`)
    .run(actor.credential_id, actor.id, actor.id, await sha256(`gkt_${'g'.repeat(43)}`), at, new Date(Date.now() + 3600_000).toISOString(), actor.id, at);
  for (const repository of repositories) db.sqlite.prepare(`INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at)
    VALUES (?,?,?,?,'private','active','local','core',?,?,?,?)`).run(repository.id, actor.id, repository.id, repository.id, repository.id, actor.id, at, at);
  const helperCalls: string[] = [];
  const env = { DB: db.binding(), DIRECTORY_DB: db.binding(), ENVIRONMENT: 'development', GIT_STORAGE_MODE: 'local',
    API_ORIGIN: 'http://api.test', APP_ORIGIN: 'http://api.test', GIT_ORIGIN: origin, CELL_ID: 'local', SHARD_ID: 'core', INTERNAL_SERVICE_KEY: key,
    GIT_CONTAINERS: { idFromName: (id: string) => id, get: () => ({ fetch: (request: Request) => { helperCalls.push(new URL(request.url).pathname); return native.service.fetch(request); } }) },
  } as unknown as GitBindings;
  const coordinators = new Map<string, RepositoryCoordinator>();
  env.REPO_COORDINATOR = { idFromName: (id: string) => id, get: (id: string) => {
    let coordinator = coordinators.get(id);
    if (!coordinator) {
      const fixture = repositories.find(repository => repository.id === id)!;
      const storage = Object.assign(fixture.storage, { setAlarm: async () => {} });
      coordinator = new RepositoryCoordinator({ storage } as unknown as DurableObjectState, env);
      coordinators.set(id, coordinator);
    }
    return coordinator;
  } } as unknown as DurableObjectNamespace;
  env.GIT_SERVICE = { fetch: (request: Request) => gitGateway.fetch(request, env) } as unknown as Fetcher;
  const originalFetch = globalThis.fetch;
  const localStores = new Map(repositories.map(repository => [repository.id, repository.canonical]));
  const localStore = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
    const request = input instanceof Request ? input : new Request(input, options);
    const url = new URL(request.url);
    if (url.origin !== 'http://127.0.0.1:8792') return originalFetch(input, options);
    const canonical = new Request(`http://git-local.internal${url.pathname}`, request);
    await verifyInternalRequest(canonical, key, 'git-local-storage');
    const name = /^\/repositories\/([\w-]+)$/u.exec(url.pathname)?.[1];
    if (!name) return new Response(null, { status: 404 });
    let directory = localStores.get(name);
    if (request.method === 'PUT') {
      const input = await canonical.json() as { default_branch: string };
      directory ??= join(root, 'gateway-stores', `${name}.git`);
      await mkdir(join(root, 'gateway-stores'), { recursive: true });
      const created = await git(root, ['init', '--bare', `--initial-branch=${input.default_branch}`, directory]);
      expect(created.code, created.stderr).toBe(0);
      localStores.set(name, directory);
    }
    if (!directory) return new Response(null, { status: 404 });
    if (request.method === 'DELETE') { await rm(directory, { recursive: true, force: true }); localStores.delete(name); }
    else await stat(join(directory, 'HEAD'));
    return Response.json({ remote: pathToFileURL(directory).href });
  });
  return { env, db, helperCalls, localStores, close() { localStore.mockRestore(); db.close(); } };
}

function gatewayApi(env: GitBindings): Hono<AppEnv> {
  const api = new Hono<AppEnv>();
  api.onError(errorResponse);
  api.use('*', async (c, next) => {
    c.set('requestId', crypto.randomUUID()); c.set('database', env.DB.withSession('first-primary'));
    const routed = await routeResourceRequest(c);
    if (routed) return routed;
    c.set('principal', await authenticate(c.req.raw, env)); await next();
  });
  registerGitRoutes(api);
  return api;
}

async function internalGit(env: GitBindings, repoId: string, action: string, body: unknown, method = 'POST'): Promise<Response> {
  const request = new Request(`https://internal.gitknot.com/internal/git/repositories/${repoId}/${action}`, {
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return gitGateway.fetch(await signInternalRequest(request, key, 'git-service'), env);
}

async function insertMergeQueue(db: SqliteD1, fixture: Fixture, base: string, head: string, candidateId: string): Promise<void> {
  const at = new Date().toISOString();
  db.sqlite.prepare(`INSERT INTO collaboration_items(id,repo_id,kind,number,title,markdown,author_id,state,created_at,updated_at)
    VALUES ('pr_scoped_queue',?,'pull_request',1,'Scoped merge','',?,'open',?,?)`).run(fixture.id, actor.id, at, at);
  db.sqlite.prepare(`INSERT INTO pull_requests(id,repo_id,head_repo_id,base_ref,head_ref,base_oid,head_oid,current_patch_id)
    VALUES ('pr_scoped_queue',?,?,'refs/heads/main','refs/heads/feature',?,?,'patch_scoped_queue')`).run(fixture.id, fixture.id, base, head);
  db.sqlite.prepare(`INSERT INTO pull_patches(id,repo_id,pull_id,version,head_repo_id,base_oid,head_oid,merge_base_oid,patch_fingerprint,native_evidence_id,created_by,created_at)
    VALUES ('patch_scoped_queue',?,'pr_scoped_queue',1,?,?,?,?,?,'evidence_queue',?,?)`).run(fixture.id, fixture.id, base, head, base, 'a'.repeat(64), actor.id, at);
  db.sqlite.prepare(`INSERT INTO pull_patch_files(repo_id,pull_id,patch_id,path,change_kind,patch_fingerprint,old_lines,new_lines,binary,hunks_json)
    VALUES (?,'pr_scoped_queue','patch_scoped_queue','scoped/feature.txt','added',?,0,1,0,'[]')`).run(fixture.id, 'b'.repeat(64));
  const input = JSON.stringify({ queue_id: 'mergeq_scoped', pull_id: 'pr_scoped_queue', patch_id: 'patch_scoped_queue', strategy: 'merge' });
  db.sqlite.prepare(`INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,status,input_json,created_at,updated_at)
    VALUES ('op_scoped_queue','collaboration.merge','mergeq_scoped',?,?,?,'running',?,?,?)`).run(fixture.id, actor.id, actor.id, input, at, at);
  db.sqlite.prepare(`INSERT INTO collaboration_operation_contexts(operation_id,repo_id,item_id,principal_json,input_digest,checkpoint_json,created_at,updated_at)
    VALUES ('op_scoped_queue',?,'pr_scoped_queue',?,?,?,?,?)`).run(fixture.id, JSON.stringify(actor), await sha256(input),
    JSON.stringify({ candidate_id: candidateId, candidate_operation_id: 'op_scoped_queue_candidate_1' }), at, at);
  db.sqlite.prepare(`INSERT INTO pull_merge_queue(id,repo_id,pull_id,patch_id,target_ref,head_oid,base_oid,strategy,policy_revision,candidate_id,operation_id,state,requested_by,created_at,updated_at)
    VALUES ('mergeq_scoped',?,'pr_scoped_queue','patch_scoped_queue','refs/heads/main',?,?,'merge',1,?,'op_scoped_queue','preparing',?,?,?)`)
    .run(fixture.id, head, base, candidateId, actor.id, at, at);
}

function transport(): string[] { return ['-c', `http.sslCAInfo=${certPath}`, '-c', `http.extraHeader=Authorization: ${authorization}`]; }

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd, timeout: 90_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Test author', GIT_AUTHOR_EMAIL: 'author@example.test', GIT_COMMITTER_NAME: 'Test actor', GIT_COMMITTER_EMAIL: 'actor@example.test' } });
    return { ...result, code: 0 };
  } catch (error) { const value = error as { stdout?: string; stderr?: string; code?: number }; return { stdout: value.stdout ?? '', stderr: value.stderr ?? '', code: value.code ?? 1 }; }
}

async function gitInput(cwd: string, args: string[], input: Buffer): Promise<Buffer> {
  const child = spawn('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const result: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on('data', data => result.push(data)); child.stderr.on('data', data => errors.push(data)); child.stdin.end(input);
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(Buffer.concat(errors).toString()))); });
  return Buffer.concat(result);
}

async function session(spec: NativeSessionSpec): Promise<NativeSessionTicket> {
  const request = new Request(`${native.origin}/internal/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) });
  const response = await fetch(await signInternalRequest(request, key, GIT_NATIVE_SCOPE));
  if (!response.ok) throw new Error(`Native session failed: ${await response.text()}`);
  return response.json() as Promise<NativeSessionTicket>;
}

async function nativeAction(ticket: NativeSessionTicket, action: string, method: string, body?: BodyInit, query: Record<string, string> = {}, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${native.origin}/sessions/${ticket.id}/${action}?${new URLSearchParams(query)}`, { method, headers: {
    authorization: `GitKnot-Session ${ticket.token}`, 'content-type': 'application/json', ...extra,
  }, body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);
}

async function requestHttps(url: string, body: Buffer): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { method: 'POST', ca, headers: { authorization, 'content-type': 'application/x-git-receive-pack-request', 'content-length': String(body.length) } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk)); response.once('end', () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks) })); response.once('error', reject);
    });
    request.once('error', reject); request.end(body);
  });
}

async function sha256Bytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
