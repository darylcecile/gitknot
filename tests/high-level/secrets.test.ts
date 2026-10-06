import { Context, Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  base64url, canonicalJson, errorResponse, hashPassword, many, now, one, registerResourceLocator, sha256, signInternalRequest, stmt, withAccountAuthorityBarrier,
} from '../../packages/core/src/index.ts';
import type { AppEnv, Principal } from '../../packages/core/src/types.ts';
import {
  bindSecretPlan, brokerRequest, createSecretsBroker, previewSecretsForPlan, resolveAttemptSecrets, selectSecretsForPlan, writeVaultEntry,
} from '../../packages/secrets/src/index.ts';
import type { Ciphertext, KeyWrap, PlanSelection, SecretsBrokerBindings, SecretsClientBindings } from '../../packages/secrets/src/types.ts';
import { ciphertextIdentity, loadKeyring, openValue } from '../../packages/secrets/src/crypto.ts';
import { registerSecretsRoutes } from '../../apps/api/src/modules/secrets.ts';
import secretsWorker from '../../workers/secrets/src/index.ts';
import { createTestEnvironment } from '../support/environment.ts';
import type { TestEnvironment } from '../support/environment.ts';
import { createTestDatabase } from '../support/database.ts';

const open: Array<{ close(): void }> = [];
afterEach(() => { vi.useRealTimers(); for (const test of open.splice(0)) test.close(); });
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const accountId = 'org_vault_testing';

async function fixture() {
  const test = await createTestEnvironment(); open.push(test);
  const key = random(), apiKey = random(), executionKey = random(), operatorKey = random();
  const broker = createSecretsBroker();
  const env: SecretsBrokerBindings = { ...test.env, SECRETS_KEK_CURRENT_ID: 'kek_v1', SECRETS_KEK_KEYRING_JSON: JSON.stringify({ kek_v1: key }),
    SECRETS_SERVICE_KEYS_JSON: JSON.stringify({
      api: { key: apiKey, scopes: ['vault.manage', 'vault.plan', 'webhooks.manage'] },
      execution: { key: executionKey, scopes: ['vault.resolve', 'vault.plan'] },
      operator: { key: operatorKey, scopes: ['vault.rotate'] },
    }) };
  const service = { fetch: (request: Request) => broker.fetch(request, env, test.context) } as unknown as Fetcher;
  const client: SecretsClientBindings = { SECRETS: service, SECRETS_CLIENT_ID: 'api', SECRETS_CLIENT_KEY: apiKey };
  const executor: SecretsClientBindings = { ...client, SECRETS_CLIENT_ID: 'execution', SECRETS_CLIENT_KEY: executionKey };
  const operator: SecretsClientBindings = { ...client, SECRETS_CLIENT_ID: 'operator', SECRETS_CLIENT_KEY: operatorKey };
  const at = now();
  const passwordHash = await hashPassword(random());
  for (const name of ['owner', 'approver', 'runner']) await env.DB.batch([
    stmt(env.DB, 'INSERT INTO users(id,username,email,password_hash,email_verified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', `u_${name}`, name, `${name}@example.net`, passwordHash, at, at, at),
    stmt(env.DB, "INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES (?,'user',?,?,?,?,?)", `u_${name}`, name, name, `u_${name}`, at, at),
    stmt(env.DB, "INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES (?,'user',?,?,?,?,?,?)", `u_${name}`, `u_${name}`, `u_${name}`, name, `u_${name}`, at, at),
  ]);
  await env.DB.batch([
    stmt(env.DB, "INSERT INTO accounts(id,type,slug,name,owner_user_id,created_at,updated_at) VALUES (?,'organization','vault-testing','Vault','u_owner',?,?)", accountId, at, at),
    stmt(env.DB, "INSERT INTO memberships(account_id,principal_id,role_id,state,created_by,created_at,updated_at) VALUES (?,'u_owner','owner','active','u_owner',?,?)", accountId, at, at),
    stmt(env.DB, "INSERT INTO memberships(account_id,principal_id,role_id,state,created_by,created_at,updated_at) VALUES (?,'u_approver','maintainer','active','u_owner',?,?)", accountId, at, at),
    stmt(env.DB, "INSERT INTO roles(id,account_id,name,created_by,created_at,updated_at) VALUES ('secret_user',?,'Secret user','u_owner',?,?)", accountId, at, at),
    ...['secrets.use', 'workflows.run', 'contents.read', 'variables.read'].map((capability) => stmt(env.DB, "INSERT INTO role_capabilities(role_id,capability,effect) VALUES ('secret_user',?,'allow')", capability)),
    stmt(env.DB, "INSERT INTO memberships(account_id,principal_id,role_id,state,created_by,created_at,updated_at) VALUES (?,'u_runner','secret_user','active','u_owner',?,?)", accountId, at, at),
    stmt(env.DB, "INSERT INTO repositories(id,owner_id,name,slug,visibility,state,cell_id,shard_id,storage_name,created_by,created_at,updated_at) VALUES ('r_vault',?,'vault','vault','private','active','local','core','storage_vault','u_owner',?,?)", accountId, at, at),
    stmt(env.DB, "INSERT INTO workflow_environments(id,repo_id,account_id,name,destination,target_ref,required_approvals,allow_self_approval,allowed_approvers_json,created_at,updated_at) VALUES ('env_prod','r_vault',?,'production','https://releases.example.net','refs/heads/main',1,0,'[\"u_approver\"]',?,?)", accountId, at, at),
  ]);
  const principal: Principal = { id: 'u_owner', kind: 'user', user_id: 'u_owner', credential_id: null, capabilities: null, repository_ids: null, account_ids: null, mfa: false };
  await brokerRequest(operator, 'vault.rotate', '/internal/vault/keys/register', { expected_revision: 0 });
  return { ...test, brokerEnv: env, client, executor, operator, principal, keys: { key, apiKey, executionKey, operatorKey } };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function put(test: Fixture, scope: { account_id?: string; repo_id?: string; environment_id?: string }, value: string, operation: string,
  name = 'TOKEN', expectedRevision: number | null = null) {
  return writeVaultEntry(test.client, { principal: test.principal, scope, name, value, kind: 'secret', expected_revision: expectedRevision,
    operation_id: operation, policy: { version: 1, enabled: true, repository_ids: ['r_vault'], workflow_ids: null, actor_ids: null,
      environment_ids: null, refs: null, allow_cross_account: scope.account_id === 'u_owner', allow_self_hosted: false, runner_pool_ids: [],
      require_environment: false, not_before: null, expires_at: null } });
}

async function selection(test: Fixture, environmentId: string | null = null, principal = test.principal, selfHosted = false): Promise<PlanSelection> {
  return selectSecretsForPlan(test.client, { principal, repo_id: 'r_vault', workflow_id: 'wf_vault', commit_oid: 'a'.repeat(40), ref: 'refs/heads/main',
    trust_class: 'trusted', executor: selfHosted ? 'self_hosted' : 'hosted', runner_pool_id: selfHosted ? 'pool_vault' : null, environment_id: environmentId,
    steps: [{ step_id: 'publish', secrets: ['TOKEN'], variables: [] }] });
}

async function runningAttempt(test: Fixture, selected: PlanSelection, principal = test.principal): Promise<{ attempt_id: string; generation: number; step_id: string; names: string[] }> {
  const db = test.env.DB;
  const at = now();
  const plan = { actor: { id: principal.id, kind: principal.kind, user_id: principal.user_id, credential_id: principal.credential_id }, routing_epoch: 1, selection_digest: selected.selection_digest };
  const planDigest = await sha256(JSON.stringify(plan));
  await bindSecretPlan(test.client, { selection_id: selected.selection_id, plan_digest: planDigest, principal });
  const definition = { secret_selection_digest: selected.selection_digest, environment: selected.context.environment_id ? { id: selected.context.environment_id } : null };
  await db.batch([
    stmt(db, "INSERT INTO workflows(id,repo_id,account_id,name,path,current_version_id,created_by,created_at,updated_at) VALUES ('wf_vault','r_vault',?,'vault','.gitknot/workflows/vault.yaml','wv_vault',?,?,?)", accountId, principal.id, at, at),
    stmt(db, "INSERT INTO workflow_versions(id,workflow_id,repo_id,account_id,source_commit,definition_digest,definition,definition_json,policy_revision,approved_by,created_at) VALUES ('wv_vault','wf_vault','r_vault',?,?,?,'{}','{}',1,?,?)", accountId, 'a'.repeat(40), 'b'.repeat(64), principal.id, at),
    stmt(db, `INSERT INTO workflow_runs(id,repo_id,account_id,workflow_id,workflow_version_id,commit_sha,source_ref,workflow_digest,plan_digest,plan_json,policy_revision,trigger_type,trigger_id,trust,status,requested_by,request_key,request_hash,created_at,updated_at)
      VALUES('run_vault','r_vault',?,'wf_vault','wv_vault',?,'refs/heads/main',?,?,?,1,'workflow.manual','trigger_vault','trusted','running',?,'run-key','run-hash',?,?)`,
    accountId, 'a'.repeat(40), 'b'.repeat(64), planDigest, JSON.stringify(plan), principal.id, at, at),
    stmt(db, "INSERT INTO workflow_jobs(id,repo_id,account_id,run_id,job_key,definition_json,status,generation,current_attempt_id,created_at,updated_at) VALUES ('job_vault','r_vault',?,'run_vault','publish',?,'running',1,'att_vault',?,?)", accountId, JSON.stringify(definition), at, at),
    stmt(db, `INSERT INTO execution_attempts(id,repo_id,account_id,run_id,job_id,generation,plan_digest,toolchain_digest,producer_id,executor,profile,status,credential_hash,lease_expires_at,deadline_at,queue_deadline_at,created_at,updated_at,pool_id,runner_id,runner_credential_generation,runner_credential_hash)
      VALUES('att_vault','r_vault',?,'run_vault','job_vault',1,?,?,'hosted:linux-small',?,'linux-small','running','scoped-attempt-credential',?,?,?,?,?,?,?,?,?)`,
    accountId, planDigest, 'c'.repeat(64), selected.context.executor, new Date(Date.now() + 300_000).toISOString(), new Date(Date.now() + 300_000).toISOString(), new Date(Date.now() + 600_000).toISOString(), at, at,
    selected.context.runner_pool_id, selected.context.executor === 'self_hosted' ? 'machine_vault' : null, selected.context.executor === 'self_hosted' ? 1 : null, selected.context.executor === 'self_hosted' ? 'a'.repeat(64) : null),
  ]);
  if (selected.context.environment_id) await db.batch([
    stmt(db, `INSERT INTO execution_objects(id,repo_id,account_id,run_id,attempt_id,generation,kind,name,object_key,sha256,size_bytes,content_type,state,expires_at,created_at,source_digest)
      VALUES('artifact_vault','r_vault',?,'run_vault','att_vault',1,'output','bundle','test/artifact',?,1,'application/zip','sealed',?,?,?)`, accountId, 'd'.repeat(64), new Date(Date.now() + 86_400_000).toISOString(), at, 'd'.repeat(64)),
    stmt(db, `INSERT INTO workflow_promotions(id,repo_id,account_id,run_id,job_id,environment_id,environment_revision,artifact_id,artifact_digest,commit_sha,plan_digest,destination,target_ref,status,requested_by,request_key,request_hash,created_at,updated_at)
      VALUES('promotion_vault','r_vault',?,'run_vault','job_vault','env_prod',1,'artifact_vault',?,?,?,'https://releases.example.net','refs/heads/main','approved',?,'promotion-key','promotion-hash',?,?)`,
    accountId, 'd'.repeat(64), 'a'.repeat(40), planDigest, principal.id, at, at),
    stmt(db, "INSERT INTO workflow_promotion_barriers(promotion_id,repo_id,account_id,state,owner_id,checked_commit,checked_at,updated_at) VALUES ('promotion_vault','r_vault',?,'held','promotion_vault',?,?,?)", accountId, 'a'.repeat(40), at, at),
  ]);
  return { attempt_id: 'att_vault', generation: 1, step_id: 'publish', names: ['TOKEN'] };
}

describe('encrypted write-only vault and runtime authority', () => {
  it('fences retired-environment writes, selection and runtime use while retaining authorized history and revocation', async () => {
    const test = await fixture();
    await put(test, { repo_id: 'r_vault', environment_id: 'env_prod' }, 'environment-history-secret', 'environment-history');
    const selected = await selection(test, 'env_prod'), attempt = await runningAttempt(test, selected);
    const plan = (await one<{ plan_digest: string }>(test.env.DB, "SELECT plan_digest FROM workflow_runs WHERE id='run_vault'"))!;
    await test.env.DB.prepare(`INSERT INTO environment_approvals(id,repo_id,account_id,run_id,promotion_id,approver_id,artifact_digest,commit_sha,plan_digest,destination,environment_revision,decision,created_at,approver_mfa)
      VALUES('approval_environment_history','r_vault',?,'run_vault','promotion_vault','u_approver',?,?,?,'https://releases.example.net',1,'approved',?,0)`)
      .bind(accountId, 'd'.repeat(64), 'a'.repeat(40), plan.plan_digest, now()).run();
    expect((await resolveAttemptSecrets(test.executor, attempt)).values.TOKEN).toBe('environment-history-secret');
    const scope = { repo_id: 'r_vault', environment_id: 'env_prod' };
    await brokerRequest(test.client, 'vault.manage', '/internal/vault/delete', { principal: test.principal, scope, kind: 'secret', name: 'TOKEN', expected_revision: 1, operation_id: 'delete-before-environment' });
    const original = test.brokerEnv.DB;
    let retired = false;
    test.brokerEnv.DB = {
      prepare: (sql: string) => original.prepare(sql), withSession: () => original.withSession('first-primary'),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!retired && statements.some(statement => String((statement as unknown as { sql: string }).sql).includes('INSERT INTO vault_entries'))) {
          retired = true;
          const c = new Context<AppEnv>(new Request('https://internal.gitknot.com/environment-retirement'), { env: test.brokerEnv });
          await withAccountAuthorityBarrier(c, accountId, 'Environment retirement', async () => {
            expect(await one(original, "SELECT COUNT(*) AS count FROM vault_entries WHERE environment_id='env_prod' AND deleted_at IS NULL")).toEqual({ count: 0 });
            await original.prepare("UPDATE workflow_environments SET state='deleted',deleted_at=?,deleted_by='u_owner',revision=revision+1 WHERE id='env_prod'").bind(now()).run();
          });
        }
        return original.batch(statements);
      },
    } as unknown as D1Database;
    await expect(put(test, scope, 'late-environment-secret', 'late-environment-write', 'LATE_TOKEN')).rejects.toMatchObject({ code: 'vault_state_changed' });
    expect(retired).toBe(true);
    expect(await one(original, "SELECT COUNT(*) AS count FROM vault_entries WHERE name='LATE_TOKEN'")).toEqual({ count: 0 });
    await expect(put(test, scope, 'another-secret', 'write-after-retirement', 'NEW_TOKEN')).rejects.toMatchObject({ code: 'environment_deleted' });
    await expect(selection(test, 'env_prod')).rejects.toMatchObject({ code: 'environment_deleted' });
    await expect(resolveAttemptSecrets(test.executor, attempt)).rejects.toMatchObject({ code: 'environment_denied' });
    const app = new Hono<AppEnv>(); app.onError(errorResponse);
    app.use('*', async (c, next) => { c.set('principal', test.principal); c.set('requestId', 'retired-environment-history'); c.set('database', c.env.DB.withSession('first-primary')); await next(); });
    registerSecretsRoutes(app);
    const path = 'https://api.gitknot.com/v1/repos/r_vault/environments/env_prod/secrets/TOKEN';
    const metadata = await app.fetch(new Request(path), test.env, test.context);
    expect(metadata.status).toBe(200); expect(await metadata.text()).not.toContain('environment-history-secret');
    const versions = await app.fetch(new Request(`${path}/versions`), test.env, test.context);
    expect(versions.status).toBe(200); expect(await versions.text()).not.toContain('environment-history-secret');
    const version = selected.steps[0]!.secrets[0]!;
    await brokerRequest(test.client, 'vault.manage', '/internal/vault/revoke-version', { principal: test.principal, scope, kind: 'secret', name: 'TOKEN',
      expected_revision: 2, version_id: version.version_id, reason: 'Retained history revocation', operation_id: 'retired-environment-revocation' });
    expect(await one(original, 'SELECT COUNT(*) AS count FROM vault_use_events')).toEqual({ count: 1 });
  });

  it('previews the same authorized version digest with metadata only and no selection or authority issuance', async () => {
    const test = await fixture(), at = now();
    await test.env.DB.batch([
      stmt(test.env.DB, "INSERT INTO workflows(id,repo_id,account_id,name,path,current_version_id,created_by,created_at,updated_at) VALUES('wf_preview','r_vault',?,'preview','.gitknot/workflows/preview.yaml','wv_preview','u_owner',?,?)", accountId, at, at),
      stmt(test.env.DB, "INSERT INTO workflow_versions(id,workflow_id,repo_id,account_id,source_commit,definition_digest,definition,definition_json,policy_revision,approved_by,created_at) VALUES('wv_preview','wf_preview','r_vault',?,?,?,'{}','{}',1,'u_owner',?)", accountId, 'a'.repeat(40), 'b'.repeat(64), at),
    ]);
    const input = { principal: test.principal, repo_id: 'r_vault', workflow_id: 'wf_preview', commit_oid: 'a'.repeat(40), ref: 'refs/heads/main',
      trust_class: 'trusted' as const, executor: 'hosted' as const, runner_pool_id: null, environment_id: null, steps: [{ step_id: 'preview', secrets: [] as string[], variables: [] as string[] }] };
    const changes = () => Number(test.db.sqlite.prepare('SELECT total_changes() AS changes').get()!.changes);
    const before = changes();
    await previewSecretsForPlan(test.client, input);
    expect(changes() - before).toBe(1); // The authenticated request's anti-replay nonce only.
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM account_authority_epochs')).toEqual({ count: 0 });
    await put(test, { repo_id: 'r_vault' }, 'never-return-this-secret', 'preview-secret');
    await writeVaultEntry(test.client, { principal: test.principal, scope: { repo_id: 'r_vault' }, kind: 'variable', name: 'REGION', value: 'omit-this-variable-value', expected_revision: null, operation_id: 'preview-variable' });
    input.steps = [{ step_id: 'preview', secrets: ['TOKEN'], variables: ['REGION'] }];
    test.brokerEnv.SECRETS_KEK_KEYRING_JSON = 'preview-does-not-load-decryption-keys';
    const selectedBefore = changes();
    const preview = await previewSecretsForPlan(test.client, input);
    expect(changes() - selectedBefore).toBe(1);
    expect(preview).not.toHaveProperty('selection_id');
    expect(preview.steps[0]!.secrets[0]).not.toHaveProperty('value');
    expect(preview.steps[0]!.variables[0]).not.toHaveProperty('value');
    expect(JSON.stringify(preview)).not.toContain('never-return-this-secret');
    expect(JSON.stringify(preview)).not.toContain('omit-this-variable-value');
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM vault_selections')).toEqual({ count: 0 });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM vault_use_events')).toEqual({ count: 0 });
    const executable = await selectSecretsForPlan(test.client, input);
    expect(preview.selection_digest).toBe(executable.selection_digest);
    expect(preview.context).toEqual(executable.context);
    await expect(previewSecretsForPlan(test.operator, input)).rejects.toThrow(/authorized|scope/i);
    await expect(previewSecretsForPlan(test.client, { ...input, principal: { ...input.principal, capabilities: ['workflows.run', 'secrets.manage'] } })).rejects.toThrow();
  });

  it('requires a persisted lifecycle fence and revokes only the former repository namespace', async () => {
    const test = await fixture();
    await put(test, { repo_id: 'r_vault' }, 'repository-secret', 'lifecycle-repo');
    await put(test, { account_id: 'u_owner' }, 'personal-secret', 'lifecycle-personal');
    const key = random();
    const configured = JSON.parse(String(test.brokerEnv.SECRETS_SERVICE_KEYS_JSON)) as Record<string, unknown>;
    configured.lifecycle = { key, scopes: ['vault.lifecycle'], account_ids: [accountId] };
    test.brokerEnv.SECRETS_SERVICE_KEYS_JSON = JSON.stringify(configured);
    const client = { ...test.client, SECRETS_CLIENT_ID: 'lifecycle', SECRETS_CLIENT_KEY: key };
    const input = { repo_id: 'r_vault', previous_account_id: accountId, operation_id: 'op_vault_delete' };
    await expect(brokerRequest(client, 'vault.lifecycle', '/internal/vault/fence-repository', input)).rejects.toThrow(/fence/i);
    await test.env.DB.batch([
      stmt(test.env.DB, "INSERT INTO operations(id,kind,resource_id,repo_id,account_id,actor_id,status,created_at,updated_at) VALUES ('op_vault_delete','repository.delete','r_vault','r_vault',?,'u_owner','running',?,?)", accountId, now(), now()),
      stmt(test.env.DB, "INSERT INTO operation_steps(operation_id,name,state,idempotency_key,receipt_json,completed_at) VALUES ('op_vault_delete','fence','completed','fence_vault_delete','{}',?)", now()),
    ]);
    expect(await brokerRequest(client, 'vault.lifecycle', '/internal/vault/fence-repository', input)).toEqual({ revoked: true });
    expect(await brokerRequest(client, 'vault.lifecycle', '/internal/vault/fence-repository', input)).toEqual({ revoked: true });
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM vault_entries WHERE repo_id=? AND deleted_at IS NULL', 'r_vault')).toEqual({ count: 0 });
    expect(await one(test.env.DB, "SELECT COUNT(*) AS count FROM vault_entries WHERE account_id='u_owner' AND deleted_at IS NULL")).toEqual({ count: 1 });
  });

  it('keeps values out of management APIs, enforces scope precedence, and separates manage from use', async () => {
    const test = await fixture();
    await put(test, { account_id: 'u_owner' }, 'personal-secret', 'personal');
    await put(test, { account_id: accountId }, 'organization-secret', 'organization');
    await put(test, { repo_id: 'r_vault' }, 'repository-secret', 'repository');
    await put(test, { repo_id: 'r_vault', environment_id: 'env_prod' }, 'environment-secret', 'environment');
    expect((await selection(test)).steps[0]!.secrets[0]!.scope_type).toBe('repository');
    expect((await selection(test, 'env_prod')).steps[0]!.secrets[0]!.scope_type).toBe('environment');
    const app = new Hono<AppEnv>(); app.onError(errorResponse);
    app.use('*', async (c, next) => { c.set('principal', test.principal); c.set('requestId', 'vault_metadata'); c.set('database', c.env.DB.withSession('first-primary')); await next(); });
    registerSecretsRoutes(app);
    const response = await app.fetch(new Request('https://api.gitknot.com/v1/repos/r_vault/secrets'), test.env, test.context);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('repository-secret');
    const adminOnly: Principal = { ...test.principal, capabilities: ['secrets.manage', 'workflows.run'] };
    await expect(selection(test, null, adminOnly)).rejects.toThrow();
    const ciphertexts = await many<{ ciphertext: string }>(test.env.DB, 'SELECT ciphertext FROM vault_ciphertexts');
    expect(ciphertexts.every((row) => !row.ciphertext.includes('secret'))).toBe(true);
    const decrypted = await test.client.SECRETS.fetch(await signInternalRequest(new Request('https://internal.gitknot.com/internal/vault/decrypt', { method: 'POST', body: '{}' }), test.keys.executionKey, 'vault.resolve'));
    expect(decrypted.status).toBe(404);
  });

  it('binds every DEK/payload to identity, rewraps immutable ciphertext and verifies recovery before retiring keys', async () => {
    const test = await fixture();
    await put(test, { repo_id: 'r_vault' }, 'rotation-secret', 'create');
    const selected = await selection(test);
    const attempt = await runningAttempt(test, selected);
    const original = (await one<Ciphertext>(test.env.DB, 'SELECT * FROM vault_ciphertexts'))!;
    const wrapped = (await one<KeyWrap>(test.env.DB, 'SELECT * FROM vault_key_wraps'))!;
    const ring = await loadKeyring(test.brokerEnv);
    await expect(openValue(original, wrapped, ring.keys.get('kek_v1')!, { ...ciphertextIdentity(original), account_id: 'another-account' })).rejects.toThrow();
    await expect(test.env.DB.prepare('UPDATE vault_ciphertexts SET ciphertext=? WHERE id=?').bind('tampered', original.id).run()).rejects.toThrow(/immutable/);
    const newKey = random();
    test.brokerEnv.SECRETS_KEK_KEYRING_JSON = JSON.stringify({ kek_v1: test.keys.key, kek_v2: newKey }); test.brokerEnv.SECRETS_KEK_CURRENT_ID = 'kek_v2';
    await brokerRequest(test.operator, 'vault.rotate', '/internal/vault/keys/register', { expected_revision: 1 });
    const rotation = await brokerRequest<{ state: string }>(test.operator, 'vault.rotate', '/internal/vault/keys/rotate', { rotation_id: 'rotation_test', target_key_id: 'kek_v2', limit: 64 });
    expect(rotation.state).toBe('complete');
    expect(await one(test.env.DB, 'SELECT ciphertext,iv FROM vault_ciphertexts WHERE id=?', original.id)).toEqual({ ciphertext: original.ciphertext, iv: original.iv });
    let recovery: { state: string };
    do { recovery = await brokerRequest(test.operator, 'vault.rotate', '/internal/vault/keys/recovery', { verification_id: 'recovery_test', key_id: 'kek_v2', limit: 64 }); } while (recovery.state !== 'complete');
    test.brokerEnv.SECRETS_KEK_KEYRING_JSON = JSON.stringify({ kek_v2: newKey });
    expect((await resolveAttemptSecrets(test.executor, attempt)).values).toEqual({ TOKEN: 'rotation-secret' });
    await expect(brokerRequest(test.operator, 'vault.rotate', '/internal/vault/keys/retire', { key_id: 'kek_v1' })).rejects.toThrow(/backup|recovery|Keep/i);
    test.brokerEnv.SECRETS_KEK_KEYRING_JSON = JSON.stringify({ kek_v2: base64url(new Uint8Array(32)) });
    await expect(resolveAttemptSecrets(test.executor, attempt)).rejects.toThrow();
  });

  it('requires current attempt generations, exact declared names and caller purpose grants', async () => {
    const test = await fixture();
    await put(test, { repo_id: 'r_vault' }, 'runtime-secret', 'runtime');
    const attempt = await runningAttempt(test, await selection(test));
    expect((await resolveAttemptSecrets(test.executor, attempt)).values.TOKEN).toBe('runtime-secret');
    const entry = (await one<{ revision: number }>(test.env.DB, "SELECT revision FROM vault_entries WHERE repo_id='r_vault' AND name='TOKEN'"))!;
    await brokerRequest(test.client, 'vault.manage', '/internal/vault/delete', { principal: test.principal, scope: { repo_id: 'r_vault' }, kind: 'secret', name: 'TOKEN',
      expected_revision: entry.revision, operation_id: 'runtime-delete' });
    await expect(resolveAttemptSecrets(test.executor, attempt)).rejects.toThrow(/policy|unavailable|denied/i);
    await expect(resolveAttemptSecrets(test.client, attempt)).rejects.toThrow(/service|authorized/i);
    await expect(resolveAttemptSecrets({ ...test.executor, SECRETS_CLIENT_KEY: test.env.INTERNAL_SERVICE_KEY }, attempt)).rejects.toThrow();
    await expect(resolveAttemptSecrets(test.executor, { ...attempt, names: ['INTERNAL_SERVICE_KEY'] })).rejects.toThrow(/declared|step/i);
    await test.env.DB.prepare("UPDATE workflow_jobs SET generation=2 WHERE id='job_vault'").run();
    await expect(resolveAttemptSecrets(test.executor, attempt)).rejects.toThrow(/generation|authorized/i);
    await test.env.DB.prepare("UPDATE workflow_jobs SET generation=1 WHERE id='job_vault'").run();
    await test.env.DB.prepare("UPDATE workflow_runs SET status='cancelling' WHERE id='run_vault'").run();
    await expect(resolveAttemptSecrets(test.executor, attempt)).rejects.toThrow();
    expect(await one(test.env.DB, 'SELECT COUNT(*) AS count FROM vault_use_events')).toEqual({ count: 1 });
  });

  it('fences a membership/authorization-barrier change that races decryption before any value is returned', async () => {
    const test = await fixture();
    await put(test, { repo_id: 'r_vault' }, 'raced-secret', 'raced');
    const runner: Principal = { ...test.principal, id: 'u_runner', user_id: 'u_runner' };
    const attempt = await runningAttempt(test, await selection(test, null, runner), runner);
    const original = test.brokerEnv.DB;
    let injected = false;
    test.brokerEnv.DB = {
      prepare: (sql: string) => original.prepare(sql), withSession: () => original.withSession('first-primary'),
      batch: async (statements: D1PreparedStatement[]) => {
        const use = statements.some((statement) => String((statement as unknown as { sql?: string }).sql).includes('INSERT INTO vault_use_events'));
        if (use && !injected) {
          injected = true;
          await original.prepare('INSERT INTO account_policy_barriers(account_id,id,reason,previous_policy_revision,recover_after,created_at) VALUES (?,?,?,?,?,?)')
            .bind(accountId, 'barrier_revoke', 'Revocation in progress', 1, new Date(Date.now() + 60_000).toISOString(), now()).run();
        }
        return original.batch(statements);
      },
    } as unknown as D1Database;
    await expect(resolveAttemptSecrets(test.executor, attempt)).rejects.toThrow(/changed|state/i);
    expect(injected).toBe(true);
    expect(await one(original, 'SELECT COUNT(*) AS count FROM vault_use_events')).toEqual({ count: 0 });
  });

  it('requires a current exact environment approval and rejects a newer accepted target', async () => {
    const test = await fixture();
    for (const name of ['owner', 'approver']) await test.env.DB.prepare(`INSERT INTO credentials(id,principal_id,user_id,kind,name,token_hash,token_prefix,auth_revision,mfa,authenticated_at,expires_at,created_by,created_at)
      VALUES (?, ?, ?, 'session','MFA approval',?,'gks_test',1,1,?,?,'u_owner',?)`).bind(`cred_${name}`, `u_${name}`, `u_${name}`, await sha256(random()), now(), new Date(Date.now() + 600000).toISOString(), now()).run();
    await test.env.DB.prepare("INSERT INTO user_mfa(user_id,salt,key_id,enabled_at,setup_expires_at,created_at) VALUES ('u_owner',?,'identity-test',?,?,?)").bind(random(), now(), now(), now()).run();
    await test.env.DB.prepare("INSERT INTO account_policies(account_id,config_json,updated_by,updated_at) VALUES (?,'{\"require_mfa\":true}','u_owner',?)").bind(accountId, now()).run();
    test.principal.credential_id = 'cred_owner'; test.principal.mfa = true;
    await put(test, { repo_id: 'r_vault', environment_id: 'env_prod' }, 'production-secret', 'production');
    const selected = await selection(test, 'env_prod');
    const attempt = await runningAttempt(test, selected);
    await expect(resolveAttemptSecrets(test.executor, attempt)).rejects.toThrow(/approval/i);
    const run = (await one<{ plan_digest: string }>(test.env.DB, "SELECT plan_digest FROM workflow_runs WHERE id='run_vault'"))!;
    await test.env.DB.prepare(`INSERT INTO environment_approvals(id,repo_id,account_id,run_id,promotion_id,approver_id,artifact_digest,commit_sha,plan_digest,destination,environment_revision,decision,created_at,approver_credential_id,approver_mfa)
      VALUES ('approval_vault','r_vault',?,'run_vault','promotion_vault','u_approver',?,?,?,'https://releases.example.net',1,'approved',?,'cred_approver',1)`)
      .bind(accountId, 'd'.repeat(64), 'a'.repeat(40), run.plan_digest, now()).run();
    expect((await resolveAttemptSecrets(test.executor, attempt)).values.TOKEN).toBe('production-secret');
    await test.env.DB.prepare("UPDATE workflow_promotion_barriers SET checked_commit=? WHERE promotion_id='promotion_vault'").bind('e'.repeat(40)).run();
    await expect(resolveAttemptSecrets(test.executor, attempt)).rejects.toThrow(/approval/i);
    await test.env.DB.prepare("UPDATE workflow_promotion_barriers SET checked_commit=? WHERE promotion_id='promotion_vault'").bind('a'.repeat(40)).run();
    await test.env.DB.prepare("UPDATE credentials SET revoked_at=? WHERE id='cred_approver'").bind(now()).run();
    await expect(resolveAttemptSecrets(test.executor, attempt)).rejects.toThrow(/approval/i);
  });

  it.each(['identity', 'repository'] as const)('loads %s-located machine authority and fences original credential hash/generation at release', async authority => {
    const test = await fixture(), at = now();
    await test.env.DB.batch([
      stmt(test.env.DB, "INSERT INTO principals(id,kind,user_id,account_id,name,created_by,created_at,updated_at) VALUES('machine_vault','runner',NULL,?,'Machine','u_owner',?,?)", accountId, at, at),
      stmt(test.env.DB, `INSERT INTO credentials(id,principal_id,user_id,kind,name,token_hash,token_prefix,capabilities_json,mfa,authenticated_at,expires_at,created_by,created_at)
        VALUES('cred_machine','machine_vault',NULL,'runner','Machine',?,'gkr_test','["workflows.run"]',0,?,?,'u_owner',?)`, 'a'.repeat(64), at, new Date(Date.now() + 600000).toISOString(), at),
    ]);
    await writeVaultEntry(test.client, { principal: test.principal, scope: { repo_id: 'r_vault' }, name: 'TOKEN', value: 'machine-secret', kind: 'secret', expected_revision: null,
      operation_id: 'machine-secret', policy: { version: 1, enabled: true, repository_ids: ['r_vault'], workflow_ids: null, actor_ids: null, environment_ids: null,
        refs: null, allow_cross_account: false, allow_self_hosted: true, runner_pool_ids: ['pool_vault'], require_environment: false, not_before: null, expires_at: null } });
    let attempt = await runningAttempt(test, await selection(test, null, test.principal, true));
    const shard = await createTestDatabase(); open.push(shard);
    for (const table of ['users', 'accounts', 'repositories', 'workflows', 'workflow_versions', 'workflow_runs', 'workflow_jobs', 'execution_attempts']) {
      for (const row of test.db.sqlite.prepare(`SELECT * FROM ${table}`).all()) await shard.prepare(`INSERT OR IGNORE INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).bind(...Object.values(row)).run();
    }
    await shard.prepare("UPDATE repositories SET shard_id='vault_remote' WHERE id='r_vault'").run();
    await test.env.DB.prepare("INSERT INTO resource_routes(resource_id,resource_type,cell_id,shard_id,state,updated_at) VALUES('r_vault','repository','local','vault_remote','active',?) ON CONFLICT(resource_id) DO UPDATE SET shard_id=excluded.shard_id").bind(now()).run();
    Object.assign(test.brokerEnv, { IDENTITY_DB: test.env.DB, IDENTITY_CELL_ID: 'local', IDENTITY_SHARD_ID: 'core', SHARD_BINDINGS_JSON: '{"vault_remote":"VAULT_REMOTE_DB"}', VAULT_REMOTE_DB: shard.binding() });
    const machineDb = authority === 'identity' ? test.env.DB : shard.binding();
    await machineDb.batch([
      stmt(machineDb, `INSERT INTO runner_pools(id,account_id,repo_id,name,os,architecture,toolchains_json,trust,isolation,max_runners,created_at,updated_at)
        VALUES('pool_vault',?,'r_vault','Vault','linux','amd64','[]','trusted','ephemeral',1,?,?)`, accountId, at, at),
      stmt(machineDb, `INSERT INTO runners(id,account_id,repo_id,pool_id,name,os,architecture,toolchains_json,credential_hash,credential_generation,credential_expires_at,last_seen_at,created_at,updated_at)
        VALUES('machine_vault',?,'r_vault','pool_vault','Machine','linux','amd64','[]',?,1,?,?,?,?)`, accountId, 'a'.repeat(64), new Date(Date.now() + 600000).toISOString(), at, at, at),
    ]);
    for (const [resource_id, resource_type] of [['machine_vault', 'runner'], ['pool_vault', 'runner_pool']] as const) {
      await registerResourceLocator(test.brokerEnv, { resource_id, resource_type, authority, repo_id: 'r_vault' });
    }
    expect(await one(authority === 'identity' ? shard.binding() : test.env.DB, 'SELECT COUNT(*) AS count FROM runners')).toEqual({ count: 0 });
    expect(await one(shard.binding(), "SELECT COUNT(*) AS count FROM principals WHERE id='machine_vault'")).toEqual({ count: 0 });
    expect((await resolveAttemptSecrets(test.executor, attempt)).values.TOKEN).toBe('machine-secret');
    const activate = async (generation: number, hash: string, credentialGeneration: number) => {
      const original = (await one<Record<string, unknown>>(shard.binding(), "SELECT * FROM execution_attempts WHERE id='att_vault'"))!;
      const row = { ...original, id: `att_vault_${generation}`, generation, runner_credential_hash: hash, runner_credential_generation: credentialGeneration };
      await shard.prepare(`INSERT INTO execution_attempts(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).bind(...Object.values(row)).run();
      await registerResourceLocator(test.brokerEnv, { resource_id: row.id, resource_type: 'attempt', repo_id: 'r_vault', authority: 'repository' });
      await shard.prepare("UPDATE workflow_jobs SET current_attempt_id=?,generation=? WHERE id='job_vault'").bind(row.id, generation).run();
      return { ...attempt, attempt_id: row.id, generation };
    };
    await expect(resolveAttemptSecrets(test.executor, await activate(2, 'b'.repeat(64), 1))).rejects.toThrow(/credential|producer|runner/i);
    await expect(resolveAttemptSecrets(test.executor, await activate(3, 'a'.repeat(64), 2))).rejects.toThrow(/credential|producer|runner/i);
    attempt = await activate(4, 'a'.repeat(64), 1);
    const changeMachine = (action: () => Promise<unknown>) => withAccountAuthorityBarrier(new Context<AppEnv>(new Request('https://internal.gitknot.com/test-machine-change'), { env: test.brokerEnv }), accountId, 'Runner assurance regression', action);
    const db = test.brokerEnv.IDENTITY_DB!;
    let raced = false;
    const binding = { prepare: (sql: string) => db.prepare(sql), withSession: () => db.withSession('first-primary'), batch: async (statements: D1PreparedStatement[]) => {
      if (!raced && statements.some(statement => String((statement as unknown as { sql: string }).sql).includes('INSERT INTO vault_use_events'))) {
        raced = true; await changeMachine(() => machineDb.prepare("UPDATE runner_pools SET trust='untrusted',revision=revision+1 WHERE id='pool_vault'").run());
      }
      return db.batch(statements);
    } } as unknown as D1Database;
    test.brokerEnv.IDENTITY_DB = binding; test.brokerEnv.DB = binding;
    await expect(resolveAttemptSecrets(test.executor, attempt)).rejects.toThrow(/changed|state/i);
    expect(raced).toBe(true);
    expect(await one(db, 'SELECT COUNT(*) AS count FROM vault_use_events')).toEqual({ count: 1 });
  });

  it('mounts the federation broker on the real private Worker and stores enterprise secrets only as authenticated ciphertext', async () => {
    const test = await fixture();
    const env = test.brokerEnv;
    env.FEDERATION_IDENTITY_CONTRACT = 'gitknot.identity.federation.v1';
    env.FEDERATION_TRUSTED_ORIGINS_JSON = '["https://login.example.com"]';
    env.SECRETS_FEDERATION_SERVICE_KEYS_JSON = JSON.stringify({ api: { key: test.keys.apiKey, scopes: ['federation.manage', 'federation.exchange', 'federation.sign', 'federation.rotate'] } });
    const at = now();
    await env.DB.batch([
      stmt(env.DB, `INSERT INTO credentials(id,principal_id,user_id,kind,name,token_hash,token_prefix,auth_revision,mfa,authenticated_at,expires_at,created_by,created_at)
        VALUES ('cred_federation','u_owner','u_owner','session','Local MFA',?,'gks_test',1,1,?,?,'u_owner',?)`, await sha256(random()), at, new Date(Date.now() + 600_000).toISOString(), at),
      stmt(env.DB, `INSERT INTO federation_providers(id,account_id,name,protocol,config_json,enabled,created_by,created_at,updated_at)
        VALUES ('idp_vault_testing',?,'Company','oidc',?,0,'u_owner',?,?)`, accountId, JSON.stringify({ protocol: 'oidc', issuer: 'https://login.example.com/tenant',
        authorization_endpoint: 'https://login.example.com/authorize', token_endpoint: 'https://login.example.com/token', jwks_uri: 'https://login.example.com/jwks',
        client_id: 'client_vault', tenant_claim: 'tid', tenant_values: ['company'], external_id_claim: 'oid' }), at, at),
    ]);
    const body = { account_id: accountId, provider_id: 'idp_vault_testing', credential_id: 'cred_federation', expected_revision: 1,
      operation_id: await sha256('enterprise-secret'), kind: 'oidc_client_secret', secret: 'enterprise-confidential-client-secret' };
    const request = await signInternalRequest(new Request('https://internal.gitknot.com/internal/federation/secrets', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gitknot-service-client': 'api' }, body: JSON.stringify(body) }), test.keys.apiKey, 'federation.manage');
    const response = await secretsWorker.fetch(request, env, test.context);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.text()).not.toContain(body.secret);
    const encrypted = await one<{ ciphertext: string; kek_id: string }>(env.DB, 'SELECT ciphertext,kek_id FROM federation_client_secrets');
    expect(encrypted?.kek_id).toBe('kek_v1');
    expect(encrypted?.ciphertext).not.toContain(body.secret);
    await put(test, { repo_id: 'r_vault' }, 'late-backup-secret', 'late-backup');
    const backupCipher = (await one<Ciphertext>(env.DB, 'SELECT * FROM vault_ciphertexts'))!;
    const backupWrap = (await one<KeyWrap>(env.DB, 'SELECT * FROM vault_key_wraps WHERE ciphertext_id=?', backupCipher.id))!;
    const oldRing = await loadKeyring(env);
    // The backup is taken long after the old wrap was created, immediately before replacement.
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 36 * 86400000);
    env.SECRETS_KEK_KEYRING_JSON = JSON.stringify({ kek_v1: test.keys.key, kek_v2: random() }); env.SECRETS_KEK_CURRENT_ID = 'kek_v2';
    await brokerRequest(test.operator, 'vault.rotate', '/internal/vault/keys/register', { expected_revision: 1 });
    await brokerRequest(test.operator, 'vault.rotate', '/internal/vault/keys/rotate', { rotation_id: 'backup-rotation', target_key_id: 'kek_v2', limit: 64 });
    await brokerRequest(test.operator, 'vault.rotate', '/internal/vault/keys/recovery', { verification_id: 'backup-incomplete-recovery', key_id: 'kek_v2', limit: 64 });
    await expect(brokerRequest(test.operator, 'vault.rotate', '/internal/vault/keys/recovery', { verification_id: 'backup-incomplete-recovery', key_id: 'kek_v2', limit: 64 })).rejects.toThrow(/federation|Rewrap/i);
    await brokerRequest(test.operator, 'vault.rotate', '/internal/vault/keys/abort-recovery', { verification_id: 'backup-incomplete-recovery' });
    const rewrap = await signInternalRequest(new Request('https://internal.gitknot.com/internal/federation/rewrap', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gitknot-service-client': 'api' }, body: '{"limit":64}' }), test.keys.apiKey, 'federation.rotate');
    const rotation = await secretsWorker.fetch(rewrap, env, test.context);
    expect(rotation.status, await rotation.clone().text()).toBe(200);
    let recovery: { state: string; completed_at: string };
    do { recovery = await brokerRequest(test.operator, 'vault.rotate', '/internal/vault/keys/recovery', { verification_id: 'backup-complete-recovery', key_id: 'kek_v2', limit: 64 }); } while (recovery.state !== 'complete');
    await expect(brokerRequest(test.operator, 'vault.rotate', '/internal/vault/keys/retire', { key_id: 'kek_v1' })).rejects.toThrow(/backup retention|Keep/i);
    const restored = await openValue(backupCipher, backupWrap, oldRing.keys.get('kek_v1')!, ciphertextIdentity(backupCipher));
    expect(new TextDecoder().decode(restored)).toBe('late-backup-secret'); restored.fill(0);
    vi.setSystemTime(Date.parse(recovery.completed_at) + 32 * 86400000 - 1);
    await expect(brokerRequest(test.operator, 'vault.rotate', '/internal/vault/keys/retire', { key_id: 'kek_v1' })).rejects.toThrow(/backup retention|Keep/i);
    vi.setSystemTime(Date.now() + 2);
    expect(await brokerRequest(test.operator, 'vault.rotate', '/internal/vault/keys/retire', { key_id: 'kek_v1' })).toEqual({ retired: true });
  });
});
