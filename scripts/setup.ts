import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseIdentityKeyRing, sessionIdentityKeyRing } from '../infra/identity-keys.ts';

// Keep the bootstrap's imports dependency-free so `node scripts/setup.ts`
// works before the first npm install on Node 24.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function install(): Promise<void> {
  const args = existsSync(join(root, 'package-lock.json')) ? ['ci'] : ['install'];
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: root, stdio: 'inherit', shell: false });
  await new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? done() : reject(new Error(`npm installation failed (${code}).`)));
  });
}

function ensureIdentityKeys(api: Record<string, string> | undefined): boolean {
  if (!api) throw new Error('Restore the existing local API key material before setup.');
  if (api.IDENTITY_KEYS_JSON !== undefined) {
    parseIdentityKeyRing(api.IDENTITY_KEYS_JSON);
    return false;
  }
  api.IDENTITY_KEYS_JSON = sessionIdentityKeyRing(api.SESSION_KEY);
  return true;
}

async function createLocalKeys(): Promise<void> {
  const directory = join(root, '.gitknot', 'local');
  const path = join(directory, 'keys.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const random = () => btoa(String.fromCharCode(...randomBytes(32))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  if (existsSync(path)) {
    const existing = JSON.parse(await readFile(path, 'utf8')) as Record<string, Record<string, string>>;
    const federation = existing.secrets && existing.api?.SECRETS_CLIENT_KEY && !existing.secrets.SECRETS_FEDERATION_SERVICE_KEYS_JSON;
    let changed = ensureIdentityKeys(existing.api);
    if (existing.secrets?.SECRETS_SERVICE_KEYS_JSON) {
      const clients = JSON.parse(existing.secrets.SECRETS_SERVICE_KEYS_JSON) as Record<string, { key: string; scopes: string[] }>;
      const operator = `development-${process.env.GITKNOT_DEVELOPMENT_CELL_ID ?? 'cell-001'}-operator`;
      if (!clients[operator]) {
        clients[operator] = { key: random(), scopes: ['vault.rotate'] };
        existing.secrets.SECRETS_SERVICE_KEYS_JSON = JSON.stringify(clients); changed = true;
      }
    }
    if (!existing.hosted?.HOSTED_CONTROL_KEY) {
      existing.hosted = { ...existing.hosted, HOSTED_CONTROL_KEY: random() };
      changed = true;
    }
    if (existing.secrets && !existing.secrets.INTERNAL_SERVICE_KEY && existing.api?.INTERNAL_SERVICE_KEY) {
      existing.secrets.INTERNAL_SERVICE_KEY = existing.api.INTERNAL_SERVICE_KEY;
      changed = true;
    }
    if (existing.background?.SESSION_KEY) {
      delete existing.background.SESSION_KEY;
      changed = true;
    }
    if (federation) {
      existing.secrets!.SECRETS_FEDERATION_SERVICE_KEYS_JSON = JSON.stringify({
        [`development-${process.env.GITKNOT_DEVELOPMENT_CELL_ID ?? 'cell-001'}-api`]: {
          key: existing.api!.SECRETS_CLIENT_KEY, scopes: ['federation.manage', 'federation.exchange', 'federation.sign'], account_ids: null, repository_ids: null,
        },
      });
      changed = true;
    }
    if (changed) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    }
    await chmod(path, 0o600);
    return;
  }
  const internal = random();
  const api = random();
  const background = random();
  const execution = random();
  const session = random();
  const client = (role: string) => `development-${process.env.GITKNOT_DEVELOPMENT_CELL_ID ?? 'cell-001'}-${role}`;
  const value = {
    api: { INTERNAL_SERVICE_KEY: internal, SESSION_KEY: session, IDENTITY_KEYS_JSON: sessionIdentityKeyRing(session), SECRETS_CLIENT_KEY: api },
    git: { INTERNAL_SERVICE_KEY: internal },
    egress: { INTERNAL_SERVICE_KEY: internal },
    background: { INTERNAL_SERVICE_KEY: internal, SECRETS_CLIENT_KEY: background },
    execution: { INTERNAL_SERVICE_KEY: internal, SECRETS_CLIENT_KEY: execution },
    hosted: { HOSTED_CONTROL_KEY: random() },
    secrets: {
      INTERNAL_SERVICE_KEY: internal,
      SECRETS_KEK_KEYRING_JSON: JSON.stringify({ 'local-v1': random() }),
      SECRETS_SERVICE_KEYS_JSON: JSON.stringify({
        [client('api')]: { key: api, scopes: ['vault.manage', 'vault.plan', 'webhooks.manage'] },
        [client('background')]: { key: background, scopes: ['vault.plan', 'vault.resolve', 'webhooks.sign'] },
        [client('execution')]: { key: execution, scopes: ['vault.plan', 'vault.resolve'] },
        [client('operator')]: { key: random(), scopes: ['vault.rotate'] },
      }),
      SECRETS_FEDERATION_SERVICE_KEYS_JSON: JSON.stringify({
        [client('api')]: { key: api, scopes: ['federation.manage', 'federation.exchange', 'federation.sign'], account_ids: null, repository_ids: null },
      }),
    },
  };
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

async function setup(): Promise<void> {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 24) throw new Error('Use Node 24 from .node-version for cf configuration and local native services.');
  const { values } = parseArgs({ options: { 'skip-install': { type: 'boolean', default: false }, 'skip-migrations': { type: 'boolean', default: false } }, strict: true });
  if (!values['skip-install']) await install();
  // Load public .env settings before deriving the local caller IDs.
  const { createProjects } = await import('../infra/projects.ts');
  await createLocalKeys();
  for (const directory of ['.cloudflare/state', '.gitknot/git/repositories', '.gitknot/git/sessions', '.gitknot/backups', '.gitknot/mailbox']) {
    await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
  }
  await createProjects();
  if (!values['skip-migrations']) {
    const { migrateLocal } = await import('./migrate.ts');
    await migrateLocal();
    const { bootstrapLocalCapacity, describeLocalCapacity } = await import('../infra/local/capacity.ts');
    describeLocalCapacity(await bootstrapLocalCapacity());
  }
  console.log('Local GitKnot state is ready. Run npm run dev. Local keys are in .gitknot/local/keys.json (mode 0600).');
}

setup().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
