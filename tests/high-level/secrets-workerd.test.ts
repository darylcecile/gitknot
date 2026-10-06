import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { base64url, now, signInternalRequest } from '../../packages/core/src/index.ts';
import { createTestDatabase, projectRoot } from '../support/database.ts';

describe('composed private vault in Cloudflare workerd', () => {
  let runtime: Miniflare;
  let db: D1Database;
  const key = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
  const firstKek = key(), secondKek = key(), apiKey = key(), operatorKey = key();

  beforeAll(async () => {
    const bundled = await build({ absWorkingDir: projectRoot, entryPoints: ['workers/secrets/src/index.ts'], bundle: true, write: false,
      format: 'esm', platform: 'node', target: 'es2023',
      banner: { js: "import {createRequire as __createRequire} from 'node:module'; const require = __createRequire('/gitknot-secrets.js');" } });
    const bindings = { ENVIRONMENT: 'test', CELL_ID: 'vault-test', SHARD_ID: 'vault-test', APP_ORIGIN: 'https://gitknot.com', API_ORIGIN: 'https://api.gitknot.com',
      GIT_ORIGIN: 'https://git.gitknot.com', SECRETS_KEK_KEYRING_JSON: JSON.stringify({ first: firstKek, second: secondKek }),
      SECRETS_SERVICE_KEYS_JSON: JSON.stringify({ api: { key: apiKey, scopes: ['vault.manage'] }, operator: { key: operatorKey, scopes: ['vault.rotate'] } }) };
    runtime = new Miniflare(convertV4MiniflareOptions({ cf: false, workers: [
      { name: 'secrets', modules: true, script: bundled.outputFiles[0]!.text, compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: 'vault-workerd-tests' }, bindings: { ...bindings, SECRETS_KEK_CURRENT_ID: 'first' } },
      { name: 'rotated', modules: true, script: bundled.outputFiles[0]!.text, compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: 'vault-workerd-tests' }, bindings: { ...bindings, SECRETS_KEK_CURRENT_ID: 'second' } },
    ] }));
    await runtime.ready;
    db = await runtime.getD1Database('DB', 'secrets') as unknown as D1Database;
    const migrations = (await readdir(join(projectRoot, 'migrations'))).filter((name) => name.endsWith('.sql')).sort();
    const schema = await createTestDatabase({ migrations });
    try {
      const definitions = schema.sqlite.prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all() as { sql: string }[];
      for (const row of definitions) {
        try { await db.prepare(row.sql).run(); }
        catch (error) { throw new Error(`Workerd schema rejected: ${row.sql.slice(0, 160)}`, { cause: error }); }
      }
      for (const table of ['roles', 'role_capabilities']) {
        const rows = schema.sqlite.prepare(`SELECT * FROM ${table}`).all();
        for (const row of rows) await db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).bind(...Object.values(row)).run();
      }
    } finally { schema.close(); }
    const at = now();
    await db.batch([
      db.prepare("INSERT INTO users(id,username,email,email_verified_at,created_at,updated_at) VALUES ('u_workerd','workerd','workerd@example.net',?,?,?)").bind(at, at, at),
      db.prepare("INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES ('u_workerd','user','workerd','Workerd','u_workerd',?,?)").bind(at, at),
      db.prepare("INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES ('u_workerd','user','u_workerd','u_workerd','Workerd','u_workerd',?,?)").bind(at, at),
    ]);
  }, 60_000);
  afterAll(async () => { await runtime?.dispose(); });

  async function call(worker: string, path: string, input: unknown, operator = false) {
    const request = await signInternalRequest(new Request(`https://internal.gitknot.com${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gitknot-service-client': operator ? 'operator' : 'api' }, body: JSON.stringify(input) }),
    operator ? operatorKey : apiKey, operator ? 'vault.rotate' : 'vault.manage');
    return (await runtime.getWorker(worker)).fetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() });
  }

  it('seals with native Web Crypto/D1, rewraps immutable ciphertext, and fences an older deployed writer', async () => {
    const registered = await call('secrets', '/internal/vault/keys/initialize', {}, true);
    expect(registered.status, await registered.clone().text()).toBe(200);
    expect(await registered.json()).toMatchObject({ active_key_id: 'first', initialized: true });
    expect(await (await call('secrets', '/internal/vault/keys/initialize', {}, true)).json()).toMatchObject({ active_key_id: 'first', initialized: false });
    expect((await call('rotated', '/internal/vault/keys/initialize', {}, true)).status).toBe(503);
    const input = { principal: { id: 'u_workerd', kind: 'user', user_id: 'u_workerd', credential_id: null,
      capabilities: null, repository_ids: null, account_ids: null, mfa: false }, scope: { account_id: 'u_workerd' }, kind: 'secret', name: 'TOKEN',
    value: 'native-worker-encrypted-secret', expected_revision: null, operation_id: 'workerd-create' };
    const written = await call('secrets', '/internal/vault/write', input);
    expect(written.status, await written.clone().text()).toBe(200);
    expect(await written.text()).not.toContain(input.value);
    const original = (await db.prepare('SELECT id,ciphertext,iv FROM vault_ciphertexts').first<{ id: string; ciphertext: string; iv: string }>())!;
    expect(original.ciphertext).not.toContain(input.value);
    expect((await call('rotated', '/internal/vault/keys/register', { expected_revision: 1 }, true)).status).toBe(200);
    const rewrapped = await call('rotated', '/internal/vault/keys/rotate', { rotation_id: 'workerd-rotation', target_key_id: 'second', limit: 64 }, true);
    expect(rewrapped.status, await rewrapped.clone().text()).toBe(200);
    expect(await db.prepare('SELECT ciphertext,iv FROM vault_ciphertexts WHERE id=?').bind(original.id).first()).toEqual({ ciphertext: original.ciphertext, iv: original.iv });
    expect((await call('secrets', '/internal/vault/write', { ...input, name: 'STALE', operation_id: 'stale-deployment-write' })).status).toBe(503);
    let state: string;
    do {
      const verified = await call('rotated', '/internal/vault/keys/recovery', { verification_id: 'workerd-recovery', key_id: 'second', limit: 64 }, true);
      expect(verified.status, await verified.clone().text()).toBe(200);
      state = (await verified.json() as { state: string }).state;
    } while (state !== 'complete');
    expect(await db.prepare("SELECT COUNT(*) AS count FROM vault_key_wraps WHERE key_id='second'").first()).toEqual({ count: 1 });
  });
});
