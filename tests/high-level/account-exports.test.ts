import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { accountExport } from '../../packages/operations/src/account-export-state.ts';
import { cleanupAccountExport, runAccountExport } from '../../packages/operations/src/account-export.ts';
import { completeOperation, operationById, runLifecycle } from '../../packages/operations/src/lifecycle.ts';
import { backgroundContext } from '../../packages/operations/src/authorization.ts';
import { admissionRequest } from '../../packages/billing/src/transport.ts';
import { reserveStandaloneStorage } from '../../packages/billing/src/storage.ts';
import { commitStorageObject } from '../../packages/billing/src/execution.ts';
import type { StorageObject } from '../../packages/billing/src/types.ts';
import { base64url, many, now, one, prepareCredential, sha256, stmt, withAccountAuthorityBarrier } from '../../packages/core/src/index.ts';
import type { AccountExportManifest } from '../../packages/operations/src/account-export-types.ts';
import { moveFixture } from '../support/move-fixture.ts';
import { createSecretsBroker } from '../../packages/secrets/src/index.ts';
import type { SecretsBrokerBindings } from '../../packages/secrets/src/types.ts';

type Fixture = Awaited<ReturnType<typeof moveFixture>>;
const run = promisify(execFile);

function request(test: Fixture, method: string, path: string, body?: unknown, revision?: number, key = path) {
  return (test.env.API as Fetcher).fetch(new Request(`${test.env.API_ORIGIN}${path}`, { method, headers: {
    authorization: `Bearer ${test.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(['POST', 'DELETE'].includes(method) ? { 'idempotency-key': key } : {}), ...(revision === undefined ? {} : { 'if-match': `"${revision}"` }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
}

async function create(test: Fixture, key = 'account-export') {
  const path = `/v1/accounts/${test.accountId}/exports`, response = await request(test, 'POST', path, {}, undefined, key);
  expect(response.status, await response.clone().text()).toBe(202);
  const exported = await response.json() as { id: string; operation: { id: string } };
  const replay = await request(test, 'POST', path, {}, undefined, key);
  expect(await replay.json()).toMatchObject({ id: exported.id, operation: { id: exported.operation.id } });
  return { ...exported, path: `${path}/${exported.id}` };
}

async function denyContent(test: Fixture, repoId = test.repoId) {
  const context = backgroundContext(test.env, test.actor);
  await withAccountAuthorityBarrier(context, test.accountId, 'export-test-denial', async () => {
    await stmt(test.env.DB, `INSERT INTO access_grants(id,account_id,repo_id,principal_type,principal_id,capability,effect,created_by,created_at,updated_at)
      VALUES('export_deny',?,?,'user',?,'contents.read','deny',?,?,?)`, test.accountId, repoId, test.actor.id, test.actor.id, now(), now()).run();
  });
}

async function asset(test: Fixture) {
  const data = new TextEncoder().encode('Real account-owned avatar bytes'), checksum = await sha256(data), key = `${test.accountId}/assets/avatar`;
  const funding = await reserveStandaloneStorage(test.env, { account_id: test.accountId, repo_id: null, actor_id: test.actor.id, object_id: 'obj_avatar',
    key, bucket: 'blobs', maximum_bytes: String(data.length), retention_until: null });
  const head = await test.env.BLOBS.put(key, data, { sha256: checksum, customMetadata: { object_id: 'obj_avatar', upload_generation: '1' } });
  const billed = await commitStorageObject(test.env, { account_id: test.accountId, object_id: 'obj_avatar', reservation_id: funding.reservation_id,
    fence: funding.fence, bytes: String(data.length), etag: head!.etag, checksum });
  await stmt(test.env.DB, `INSERT INTO object_manifests(id,account_id,kind,object_key,filename,bytes,sha256,state,created_by,billing_reservation_id,billing_fence,
    storage_accrued_at,upload_generation,created_at,updated_at) VALUES('obj_avatar',?,'avatar',?,'avatar.txt',?,?,'ready',?,?,?,?,1,?,?)`,
  test.accountId, key, data.length, checksum, test.actor.id, funding.reservation_id, funding.fence, billed.accrued_at, now(), now()).run();
  return data;
}

it('exports real account data and a complete native repository archive, recovers lost storage replies, and verifies cleanup', async () => {
  const test = await moveFixture(), directory = await mkdtemp('/private/var/folders/zh/l70grz9n3ll9j9c_f1ghp7gr0000gn/T/opencode/account-export-');
  try {
    const head = await test.initializeGit(), avatar = await asset(test), at = now();
    const issue = await request(test, 'POST', `/v1/repos/${test.repoId}/issues`, { title: 'Account export history', markdown: 'Complete retained collaboration Markdown.' });
    expect(issue.status, await issue.clone().text()).toBe(201);
    const filter = await request(test, 'POST', '/v1/saved-filters', { repo_id: test.repoId, name: 'My personal saved view', surface: 'issues', filters: { state: 'open' } });
    expect(filter.status, await filter.clone().text()).toBe(201);
    await test.env.DB.batch([
      stmt(test.env.DB, "UPDATE users SET bio='Account profile in the archive',password_hash='never-export-password-hash' WHERE id=?", test.actor.id),
      stmt(test.env.DB, "INSERT INTO user_mfa(user_id,salt,key_id,setup_expires_at,created_at) VALUES(?,'never-export-authenticator-salt','test',?,?)", test.actor.id, at, at),
      stmt(test.env.DB, `INSERT INTO vault_entries(id,account_id,scope_type,scope_id,kind,name,policy_json,current_version_id,created_by,created_at,updated_at)
        VALUES('secret_export',?,'user',?,'secret','PRIVATE_TOKEN','{}','sv_export',?,?,?)`, test.accountId, test.accountId, test.actor.id, at, at),
      stmt(test.env.DB, "INSERT INTO vault_ciphertexts(id,account_id,purpose,context_json,iv,ciphertext,created_at) VALUES('cipher_export',?,'tenant_secret','{}','private-iv','never-export-secret-ciphertext',?)", test.accountId, at),
      stmt(test.env.DB, "INSERT INTO vault_versions(id,entry_id,account_id,version,ciphertext_id,created_at,created_by) VALUES('sv_export','secret_export',?,1,'cipher_export',?,?)", test.accountId, at, test.actor.id),
    ]);
    const exported = await create(test), operation = await operationById(test.env, exported.operation.id);
    const put = test.source.backups.put.bind(test.source.backups); let lost = true, writes = 0;
    test.source.backups.put = async (...args) => {
      const result = await put(...args);
      if (args[0].endsWith(`/exports/${exported.id}/metadata/accounts/00000000.json`)) {
        writes++;
        if (lost) { lost = false; throw new Error('Lost account metadata PUT acknowledgement'); }
      }
      return result;
    };
    await expect(runAccountExport(test.env, operation)).rejects.toThrow();
    expect(lost).toBe(false);
    const result = await runAccountExport(test.env, operation);
    await completeOperation(test.env, operation, result);
    expect(writes).toBe(1);
    const status = await request(test, 'GET', exported.path);
    const resource = await status.json() as { revision: number; checksum_sha256: string; size_bytes: number };
    expect(resource).toMatchObject({ state: 'completed', coverage: { complete: true, repository_count: 1, verified_repository_count: 1 }, operation: { status: 'completed' } });
    const download = await request(test, 'GET', `${exported.path}/download`);
    expect(download.status, await download.clone().text()).toBe(200);
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(bytes.byteLength).toBe(resource.size_bytes); expect(await sha256(bytes)).toBe(resource.checksum_sha256);
    const archive = join(directory, 'account.tar'); await writeFile(archive, bytes);
    await run('tar', ['-xf', archive, '-C', directory]);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as AccountExportManifest;
    expect(manifest).toMatchObject({ format: 'gitknot.account', version: 1, account_id: test.accountId, coverage: { complete: true, repository_count: 1 } });
    let text = '';
    for (const part of manifest.metadata) {
      const data = await readFile(join(directory, part.path)); expect(await sha256(data)).toBe(part.sha256); text += new TextDecoder().decode(data);
    }
    expect(text).toContain('Account profile in the archive'); expect(text).toContain('My personal saved view'); expect(text).toContain('PRIVATE_TOKEN');
    for (const value of ['never-export-password-hash', 'never-export-authenticator-salt', 'never-export-secret-ciphertext', test.token]) expect(text).not.toContain(value);
    expect(manifest.assets).toHaveLength(1);
    expect(Buffer.concat(await Promise.all(manifest.assets[0]!.parts.map(part => readFile(join(directory, part.path)))))).toEqual(Buffer.from(avatar));
    const repository = manifest.repositories[0]!;
    const repoTar = await readFile(join(directory, repository.path)); expect(await sha256(repoTar)).toBe(repository.sha256);
    await run('tar', ['-xf', join(directory, repository.path), '-C', directory]);
    expect(await test.git(test.sourceStores.get(test.storageName)!, 'bundle', 'list-heads', join(directory, 'repository.bundle'))).toContain(`${head} refs/heads/main`);
    const itemParts = await readdir(join(directory, 'metadata', 'collaboration_items', 'snapshot-v2'));
    expect(await readFile(join(directory, 'metadata', 'collaboration_items', 'snapshot-v2', itemParts[0]!), 'utf8')).toContain('Complete retained collaboration Markdown.');
    expect(await one(test.env.DB, 'SELECT scope_id FROM storage_quotas WHERE scope_id=?', test.accountId)).toBeNull();

    const streaming = await request(test, 'GET', `${exported.path}/download`), reader = streaming.body!.getReader();
    expect((await reader.read()).value?.byteLength).toBeGreaterThan(0);
    await denyContent(test);
    await expect(reader.read()).rejects.toThrow();
    expect((await request(test, 'GET', `${exported.path}/download`)).status).toBe(404);
    expect((await request(test, 'DELETE', exported.path, undefined, resource.revision, 'delete-export')).status).toBe(202);
    const remove = test.source.backups.delete.bind(test.source.backups); let failure = true;
    test.source.backups.delete = async keys => { if (failure) { failure = false; throw new Error('Physical deletion unavailable'); } await remove(keys); };
    await expect(cleanupAccountExport(test.env, await accountExport(test.env, exported.id))).rejects.toThrow();
    expect((await accountExport(test.env, exported.id)).state).toBe('deleting');
    const object = (await one<{ object_id: string }>(test.env.DB, "SELECT object_id FROM account_export_parts WHERE export_id=? AND path='manifest.json'", exported.id))!;
    expect((await admissionRequest<StorageObject>(test.env, `account:${test.accountId}`, 'get-object', { object_id: object.object_id })).state).toBe('stored');
    await cleanupAccountExport(test.env, await accountExport(test.env, exported.id));
    expect((await accountExport(test.env, exported.id)).state).toBe('deleted');
    expect((await admissionRequest<StorageObject>(test.env, `account:${test.accountId}`, 'get-object', { object_id: object.object_id })).state).toBe('deleted');
    expect(test.source.backups.objects.size).toBe(0);
    expect(await test.source.blobs.head(`${test.accountId}/assets/avatar`)).not.toBeNull();
    expect(await many(test.env.DB, 'SELECT * FROM account_export_rows WHERE export_id=?', exported.id)).toEqual([]);
  } finally { await test.close(); await rm(directory, { recursive: true, force: true }); }
}, 120_000);

it('refuses a complete account export when an owner’s current content authorization excludes a repository', async () => {
  const test = await moveFixture();
  try {
    await test.initializeGit(); await denyContent(test);
    const exported = await create(test, 'denied-export'), operation = await operationById(test.env, exported.operation.id);
    await expect(runAccountExport(test.env, operation)).rejects.toMatchObject({ code: 'account_export_incomplete' });
    const response = await request(test, 'GET', exported.path);
    expect(await response.json()).toMatchObject({ state: 'failed', coverage: { complete: false }, download_path: null });
    expect((await request(test, 'GET', `${exported.path}/download`)).status).toBe(409);
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS n FROM account_export_parts WHERE export_id=?', exported.id)).toEqual({ n: 0 });
  } finally { await test.close(); }
}, 60_000);

it('keeps another user’s private draft current/history/IDs out of account and repository archives and preserves private state through restore', async () => {
  const test = await moveFixture(), directory = await mkdtemp('/private/var/folders/zh/l70grz9n3ll9j9c_f1ghp7gr0000gn/T/opencode/draft-export-');
  try {
    await test.initializeGit();
    const at = now(), marker = crypto.randomUUID();
    await test.env.DB.batch([
      stmt(test.env.DB, "INSERT INTO users(id,username,email,email_verified_at,created_at,updated_at) VALUES('u_bob','bob','bob@example.net',?,?,?)", at, at, at),
      stmt(test.env.DB, "INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES('u_bob','user','bob','Bob','u_bob',?,?)", at, at),
      stmt(test.env.DB, "INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES('u_bob','user','u_bob','u_bob','Bob','u_bob',?,?)", at, at),
    ]);
    const bob = await prepareCredential(test.env.DB, { principal_id: 'u_bob', user_id: 'u_bob', kind: 'personal', name: 'Private draft owner', capabilities: ['*'],
      repository_ids: null, account_ids: null, auth_revision: 1, mfa: false, created_by: 'u_bob', expires_at: new Date(Date.now() + 86400_000).toISOString() });
    await bob.statement.run();
    await withAccountAuthorityBarrier(backgroundContext(test.env, test.actor), test.accountId, 'draft export fixture contributor', async () => {
      await stmt(test.env.DB, `INSERT INTO access_grants(id,account_id,repo_id,principal_type,principal_id,role_id,effect,created_by,created_at,updated_at)
        VALUES('draft_bob',?,?,'user','u_bob','contributor','allow',?,?,?)`, test.accountId, test.repoId, test.actor.id, at, at).run();
    });
    let sequence = 0;
    const call = (method: string, path: string, body?: unknown, revision?: number, token = test.token) => (test.env.API as Fetcher).fetch(new Request(`${test.env.API_ORIGIN}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'idempotency-key': `draft-export-${++sequence}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(revision === undefined ? {} : { 'if-match': `"${revision}"` }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const json = async (response: Response, status = 201) => { expect(response.status, await response.clone().text()).toBe(status); return response.json() as Promise<{ id: string; revision: number; operation?: { id: string } }>; };
    const repo = `/v1/repos/${test.repoId}`;
    const shared = await json(await call('POST', `${repo}/issues`, { title: 'Shared history', markdown: `canonical-before-${marker}` }));
    const sharedRevision = await json(await call('PATCH', `${repo}/issues/${shared.id}`, { markdown: `canonical-after-${marker}` }, shared.revision), 200);
    await json(await call('POST', `${repo}/issues/${shared.id}/comments`, { markdown: `bob-published-${marker}` }, sharedRevision.revision, bob.token));
    const own = await json(await call('POST', `${repo}/drafts`, { kind: 'comment', item_id: shared.id, markdown: `alice-private-before-${marker}` }));
    await json(await call('PATCH', `${repo}/drafts/${own.id}`, { markdown: `alice-private-after-${marker}` }, own.revision), 200);
    const other = await json(await call('POST', `${repo}/drafts`, { kind: 'issue', title: `bob-private-title-${marker}`, markdown: `bob-private-before-${marker}` }, undefined, bob.token));
    await json(await call('PATCH', `${repo}/drafts/${other.id}`, { markdown: `bob-private-after-${marker}` }, other.revision, bob.token), 200);
    expect((await call('GET', `${repo}/drafts/${other.id}`)).status).toBe(404);
    const otherHistory = await many<{ id: string }>(test.env.DB, "SELECT id FROM collaboration_document_versions WHERE resource_kind='draft' AND resource_id=?", other.id);
    const forbidden = [other.id, ...otherHistory.map(row => row.id), `bob-private-title-${marker}`, `bob-private-before-${marker}`, `bob-private-after-${marker}`];
    const lifecycle = async (id: string) => {
      const operation = await operationById(test.env, id), result = await runLifecycle(test.env, operation, { do: (_name, _options, callback) => callback() });
      await completeOperation(test.env, operation, result); return result;
    };
    const scan = async (file: string): Promise<string> => {
      const files = (await run('tar', ['-tf', file])).stdout.trim().split('\n').filter(path => path.endsWith('.json'));
      let text = '';
      for (const path of files) text += (await run('tar', ['-xOf', file, path], { maxBuffer: 8 * 1024 * 1024 })).stdout;
      return text;
    };
    const exported = await create(test, 'draft-account-export');
    const accountOperation = await operationById(test.env, exported.operation.id);
    await completeOperation(test.env, accountOperation, await runAccountExport(test.env, accountOperation));
    const accountDownload = await call('GET', `${exported.path}/download`);
    expect(accountDownload.status).toBe(200);
    const accountFile = join(directory, 'account.tar'); await writeFile(accountFile, new Uint8Array(await accountDownload.arrayBuffer()));
    const accountText = await scan(accountFile);
    for (const canary of forbidden) expect(accountText).not.toContain(canary);
    expect(accountText).toContain(`alice-private-before-${marker}`); expect(accountText).toContain(`alice-private-after-${marker}`); expect(accountText).toContain(own.id);
    const nestedFile = join(directory, 'nested.tar');
    await run('tar', ['-xf', accountFile, '-C', directory, `repositories/${test.repoId}.gitknot.tar`]);
    await writeFile(nestedFile, await readFile(join(directory, 'repositories', `${test.repoId}.gitknot.tar`)));
    const nestedText = await scan(nestedFile);
    for (const canary of [...forbidden, own.id, `alice-private-before-${marker}`]) expect(nestedText).not.toContain(canary);
    expect(nestedText).toContain(`canonical-before-${marker}`); expect(nestedText).toContain(`bob-published-${marker}`);

    const ordinary = await json(await call('POST', `${repo}/exports`, {}), 202);
    const archive = await lifecycle(ordinary.operation!.id);
    const ordinaryDownload = await call('GET', `${repo}/exports/${ordinary.id}/download`);
    expect(ordinaryDownload.status).toBe(200);
    const ordinaryFile = join(directory, 'ordinary.tar'); await writeFile(ordinaryFile, new Uint8Array(await ordinaryDownload.arrayBuffer()));
    const ordinaryText = await scan(ordinaryFile);
    for (const canary of [...forbidden, own.id]) expect(ordinaryText).not.toContain(canary);
    expect(ordinaryText).toContain(`canonical-after-${marker}`); expect(ordinaryText).toContain(`bob-published-${marker}`);
    const backup = await json(await call('POST', `${repo}/backups`, {}), 202);
    const backedUp = await lifecycle(backup.id);
    const backupDownload = await call('GET', `/v1/archives/${backedUp.archive_id}/content`);
    expect(backupDownload.status).toBe(200);
    const backupFile = join(directory, 'backup.tar'); await writeFile(backupFile, new Uint8Array(await backupDownload.arrayBuffer()));
    for (const canary of forbidden) expect(await scan(backupFile)).not.toContain(canary);
    expect(await one(test.env.DB, "SELECT COUNT(*) AS n FROM archive_snapshot_rows WHERE archive_id=? AND table_name='collaboration_document_versions' AND json_extract(data_json,'$.resource_kind')='draft'", archive.archive_id)).toEqual({ n: 0 });

    const lateItem = await json(await call('POST', `${repo}/issues`, { title: 'Later item', markdown: 'Absent from the selected archive' }));
    const lateDraft = await json(await call('POST', `${repo}/drafts`, { kind: 'comment', item_id: lateItem.id, markdown: `bob-private-late-${marker}` }, undefined, bob.token));
    const broker = createSecretsBroker(), serviceKey = base64url(randomBytes(32));
    test.env.SECRETS_CLIENT_ID = 'draft-restore'; test.env.SECRETS_CLIENT_KEY = serviceKey;
    const brokerEnv: SecretsBrokerBindings = { ...test.env, SECRETS_KEK_CURRENT_ID: 'draft', SECRETS_KEK_KEYRING_JSON: JSON.stringify({ draft: base64url(randomBytes(32)) }),
      SECRETS_SERVICE_KEYS_JSON: JSON.stringify({ 'draft-restore': { key: serviceKey, scopes: ['vault.lifecycle'] } }) };
    test.env.SECRETS = { fetch: (request: Request) => broker.fetch(request, brokerEnv, test.source.context) } as Fetcher;
    const current = await one<{ revision: number }>(test.env.DB, 'SELECT revision FROM repositories WHERE id=?', test.repoId);
    const deleting = await json(await call('DELETE', repo, undefined, current!.revision), 202); await lifecycle(deleting.operation!.id);
    const deleted = (await one<{ revision: number }>(test.env.DB, 'SELECT revision FROM repositories WHERE id=?', test.repoId))!;
    const restoring = await json(await call('POST', `${repo}/restore`, { archive_id: archive.archive_id }, deleted.revision), 202); await lifecycle(restoring.operation!.id);
    expect(await many(test.env.DB, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(await one(test.env.DB, 'SELECT user_id,item_id,markdown FROM collaboration_drafts WHERE id=?', lateDraft.id))
      .toEqual({ user_id: 'u_bob', item_id: null, markdown: `bob-private-late-${marker}` });
    expect(await many(test.env.DB, "SELECT id FROM collaboration_document_versions WHERE resource_kind='draft' AND resource_id=? ORDER BY id", other.id))
      .toEqual([...otherHistory].sort((a, b) => a.id.localeCompare(b.id)));
    expect((await call('GET', `${repo}/drafts/${own.id}`)).status).toBe(200);
  } finally { await test.close(); await rm(directory, { recursive: true, force: true }); }
}, 120_000);
