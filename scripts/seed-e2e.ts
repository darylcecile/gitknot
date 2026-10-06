import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { actionToken } from '@gitknot/core/auth';
import { fingerprintToolchain } from '@gitknot/workflows';
import { ociFixture } from '../packages/runner/tests/support.ts';

export const E2E_APP = 'http://localhost:5173';
export const E2E_API = 'http://localhost:8787';
export type FixtureUser = {
  id: string;
  username: string;
  email: string;
  password: string;
};
export type E2EFixtures = {
  version: 1;
  state: string;
  owner: FixtureUser;
  outsider: FixtureUser;
  repository: { id: string; name: string; clone_url: string; commit: string };
  deletion: {
    path: string;
    base_oid: string;
    head_oid: string;
    head_ref: string;
  };
  workflow: { id: string; path: string; source: string };
  pool: { id: string; name: string };
  reproduction: {
    variable_name: string;
    variable_value: string;
    isolation_path: string;
    source_path: string;
  };
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function fixtureFile() {
  const path = process.env.GITKNOT_E2E_FIXTURE_FILE;
  if (
    !path ||
    !resolve(path).startsWith(`${resolve(root, '.gitknot/e2e')}${sep}`)
  )
    throw new Error(
      'Start the isolated Playwright E2E stack; no external credentials or server reuse are supported.',
    );
  return resolve(path);
}

export async function loadE2EFixtures(): Promise<E2EFixtures> {
  const fixture = JSON.parse(
    await readFile(fixtureFile(), 'utf8'),
  ) as E2EFixtures;
  if (
    fixture.version !== 1 ||
    fixture.state !== process.env.GITKNOT_LOCAL_STATE
  )
    throw new Error('The E2E fixture belongs to a different local state.');
  return fixture;
}

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
export class LocalApiSession {
  private cookie = '';
  async call(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      etag?: string;
      expected?: number[];
    } = {},
  ) {
    if (!path.startsWith('/v1/'))
      throw new Error('Fixture HTTP calls must use a local GitKnot API path.');
    const method = options.method || 'GET';
    const headers = new Headers({
      Origin: E2E_APP,
      Accept: 'application/json',
    });
    if (this.cookie) headers.set('Cookie', this.cookie);
    if (method !== 'GET') {
      headers.set('X-GitKnot-CSRF', '1');
      headers.set('Idempotency-Key', randomUUID());
    }
    if (options.etag) headers.set('If-Match', options.etag);
    if (options.body !== undefined)
      headers.set('Content-Type', 'application/json');
    const response = await fetch(`${E2E_API}${path}`, {
      method,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(60_000),
    });
    const cookies = response.headers.getSetCookie();
    const session = cookies.find((value) =>
      /^(?:__Host-)?gitknot_session=/.test(value),
    );
    if (session) this.cookie = session.split(';')[0]!;
    const text = await response.text();
    const data = text ? (JSON.parse(text) as JsonObject) : {};
    if (!(options.expected || [200, 201, 202, 204]).includes(response.status))
      throw new Error(
        `${method} ${path}: HTTP ${response.status} ${JSON.stringify(data)}`,
      );
    return {
      data,
      status: response.status,
      etag: response.headers.get('ETag') || '',
    };
  }
}

async function localSql(sql: string): Promise<unknown[][]> {
  const { coreShards, environment, localDatabaseId, LOCAL_STATE } =
    await import('../infra/environment.ts');
  const { localCfJson } = await import('../infra/local-cf.ts');
  const databaseId = localDatabaseId(
    coreShards(environment('development'))[0]!.name,
  );
  const response = await localCfJson([
    'd1',
    'raw',
    databaseId,
    '--local',
    '--persist-to',
    LOCAL_STATE,
    '--sql',
    sql,
  ]);
  return (response as Array<{ results: { rows: unknown[][] } }>).flatMap(
    (value) => value.results.rows,
  );
}
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function createVerifiedUser(
  label: string,
): Promise<{ user: FixtureUser; api: LocalApiSession }> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const user = {
    id: '',
    username: `e2e-${label}-${suffix}`,
    email: `e2e-${label}-${suffix}@example.test`,
    password: `E2e-${randomUUID()}-${randomUUID()}`,
  };
  const api = new LocalApiSession();
  await api.call('/v1/auth/signup', {
    method: 'POST',
    body: {
      username: user.username,
      email: user.email,
      display_name: `E2E ${label}`,
      password: user.password,
    },
  });
  const rows = await localSql(
    `SELECT json_object('id',id,'purpose',purpose,'key_id',key_id,'expires_at',expires_at) FROM identity_actions WHERE email=${quote(user.email)} AND purpose='verify_email' AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`,
  );
  if (!rows[0]?.[0])
    throw new Error(
      `Signup did not create a real verification action for ${label}.`,
    );
  const action = JSON.parse(String(rows[0][0])) as {
    id: string;
    purpose: string;
    key_id: string;
    expires_at: string;
  };
  const keys = JSON.parse(
    await readFile(resolve(root, '.gitknot/local/keys.json'), 'utf8'),
  ) as { api: { SESSION_KEY: string; IDENTITY_KEYS_JSON: string } };
  const token = await actionToken(
    {
      SESSION_KEY: keys.api.SESSION_KEY,
      IDENTITY_KEYS_JSON: keys.api.IDENTITY_KEYS_JSON,
    },
    action,
  );
  await api.call('/v1/auth/verify', { method: 'POST', body: { token } });
  await api.call('/v1/auth/login', {
    method: 'POST',
    body: { login: user.email, password: user.password },
  });
  user.id = String((await api.call('/v1/me')).data.id);
  return { user, api };
}

async function seedCapacity() {
  const { bootstrapLocalCapacity, describeLocalCapacity } = await import('../infra/local/capacity.ts');
  describeLocalCapacity(await bootstrapLocalCapacity());
}

async function waitOperation(api: LocalApiSession, id: string) {
  const deadline = Date.now() + 90_000;
  let last: JsonObject = {};
  while (Date.now() < deadline) {
    last = (await api.call(`/v1/operations/${encodeURIComponent(id)}`)).data;
    const state = last.status || last.state;
    if (state === 'completed' || state === 'succeeded') return;
    if (state === 'failed' || state === 'cancelled')
      throw new Error(
        `Repository operation ${id} ${state}: ${JSON.stringify(last)}`,
      );
    await delay(750);
  }
  throw new Error(`Repository provisioning timed out: ${JSON.stringify(last)}`);
}

async function git(
  args: string[],
  cwd: string,
  authorization?: string,
): Promise<string> {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  };
  if (authorization)
    Object.assign(env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`gitknot:${authorization}`).toString('base64')}`,
    });
  const child = spawn('git', args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  let output = '';
  let errors = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    errors += String(chunk);
  });
  await new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0
        ? done()
        : reject(
            new Error(`Native git ${args[0]} failed (${code}): ${errors}`),
          ),
    );
  });
  return output.trim();
}

async function prepareRepository(
  api: LocalApiSession,
  owner: FixtureUser,
  state: string,
) {
  const created = await api.call('/v1/repos', {
    method: 'POST',
    body: {
      owner_id: owner.id,
      name: 'e2e-verification',
      visibility: 'private',
      description: 'Real local protocol and browser verification',
      default_branch: 'main',
    },
  });
  const id = String(created.data.id);
  await waitOperation(
    api,
    String(object(created.data.operation).id || created.data.operation_id),
  );
  const repository = (await api.call(`/v1/repos/${id}`)).data;
  console.log(`[E2E fixtures] repository provisioned: ${id}`);
  const progress = JSON.parse(
    await readFile(resolve(state, 'seed-progress.json'), 'utf8'),
  ) as JsonObject;
  await writeFile(
    resolve(state, 'seed-progress.json'),
    JSON.stringify({ ...progress, repository }, null, 2),
    { mode: 0o600 },
  );
  const token = await api.call('/v1/tokens', {
    method: 'POST',
    body: {
      name: 'E2E fixture publication',
      capabilities: ['contents.read', 'contents.push', 'repositories.read'],
      repository_ids: [id],
      account_ids: [owner.id],
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    },
  });
  const working = resolve(state, 'git-workspace');
  await mkdir(resolve(working, '.gitknot/workflows'), {
    recursive: true,
    mode: 0o700,
  });
  const workflow = `version: 1\nname: e2e_verify\ntriggers: [workflow.manual]\nsource: event.commit\ndefaults:\n  executor: { type: self_hosted, pool: e2e_pool }\n  toolchain: e2e_node24\n  timeout: 1m\naccess:\n  repository: read\n  capabilities: [variables.read]\njobs:\n  verify:\n    env:\n      PROOF_CONTEXT: { variable: E2E_REPRO_CONTEXT }\n    steps:\n      - run: node --version\n      - run: node -e 'require("node:fs").writeFileSync("proof.json", JSON.stringify({context:process.env.PROOF_CONTEXT}))'\n    outputs:\n      proof: { type: json, path: proof.json, retention: 1d }\n`;
  await writeFile(
    resolve(working, 'README.md'),
    '# E2E repository\r\n\r\nReal Git bytes, retained exactly.\r\n',
    { mode: 0o600 },
  );
  await writeFile(
    resolve(working, '.gitknot/workflows/verify.yaml'),
    workflow,
    { mode: 0o600 },
  );
  await writeFile(
    resolve(working, 'retired.txt'),
    'A removed line retained for review.\n-- legacy option\n',
    { mode: 0o600 },
  );
  try {
    await git(['init', '--initial-branch=main'], working);
    await git(['config', 'user.name', owner.username], working);
    await git(['config', 'user.email', owner.email], working);
    await git(['add', '.'], working);
    await git(
      ['commit', '-m', 'Publish actual E2E source and workflow'],
      working,
    );
    await git(
      ['remote', 'add', 'origin', String(repository.clone_url)],
      working,
    );
    console.log(
      '[E2E fixtures] publishing source through the stock Git HTTP transport',
    );
    await git(
      ['push', '--atomic', 'origin', 'main'],
      working,
      String(token.data.token),
    );
    const commit = await git(['rev-parse', 'HEAD'], working);
    await git(['switch', '--create', 'e2e-delete'], working);
    await git(['rm', 'retired.txt'], working);
    await git(
      ['commit', '-m', 'Delete retired source for anchored review'],
      working,
    );
    await git(
      ['push', '--atomic', 'origin', 'e2e-delete'],
      working,
      String(token.data.token),
    );
    const deletionHead = await git(['rev-parse', 'HEAD'], working);
    return {
      repository: {
        id,
        name: String(repository.name),
        clone_url: String(repository.clone_url),
        commit,
      },
      workflow,
      deletion: {
        path: 'retired.txt',
        base_oid: commit,
        head_oid: deletionHead,
        head_ref: 'refs/heads/e2e-delete',
      },
    };
  } catch (error) {
    const publications = await localSql(
      `SELECT json_object('id',id,'repo_id',repo_id,'state',state,'error',json(error_json),'result',json(result_json)) FROM git_publications WHERE repo_id=${quote(id)}`,
    ).catch(() => []);
    let trace: unknown;
    try {
      const response = await fetch(
        `${E2E_API}/cdn-cgi/local/explorer/api/local/observability/query`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sql: 'SELECT * FROM spans LIMIT 1000' }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      trace = { status: response.status, data: await response.json() };
    } catch (cause) {
      trace = { error: cause instanceof Error ? cause.message : String(cause) };
    }
    await writeFile(
      resolve(state, 'git-failure.json'),
      JSON.stringify({ repo_id: id, publications, trace }, null, 2),
      { mode: 0o600 },
    );
    throw error;
  } finally {
    const current = await api.call(`/v1/tokens/${token.data.id}`);
    await api.call(`/v1/tokens/${token.data.id}`, {
      method: 'DELETE',
      etag: current.etag,
    });
  }
}

async function seed() {
  const state = resolve(process.env.GITKNOT_LOCAL_STATE || '');
  if (!state.startsWith(`${resolve(root, '.gitknot/e2e')}${sep}`))
    throw new Error(
      'Fixture seeding is restricted to isolated .gitknot/e2e state.',
    );
  await seedCapacity();
  const owner = await createVerifiedUser('owner');
  const outsider = await createVerifiedUser('outsider');
  console.log(
    '[E2E fixtures] two independent accounts signed up, verified, and authenticated',
  );
  await writeFile(
    resolve(state, 'seed-progress.json'),
    JSON.stringify({ owner: owner.user, outsider: outsider.user }, null, 2),
    { mode: 0o600 },
  );
  const prepared = await prepareRepository(owner.api, owner.user, state);
  // Use the maintained real OCI fixture: its image exists and its tools are
  // inspected inside that exact immutable image, rather than inventing a lock.
  const runtime = await ociFixture();
  const descriptor = runtime.toolchain;
  const isolationPath = resolve(state, "reproduction's isolation.json");
  await writeFile(isolationPath, JSON.stringify(runtime.isolation, null, 2), {
    mode: 0o600,
  });
  const variable = {
    name: 'E2E_REPRO_CONTEXT',
    value: `context-${randomUUID()}`,
  };
  await owner.api.call(`/v1/repos/${prepared.repository.id}/variables`, {
    method: 'POST',
    body: variable,
  });
  const digest = await fingerprintToolchain(descriptor);
  const pool = (
    await owner.api.call('/v1/runner-pools', {
      method: 'POST',
      body: {
        account_id: owner.user.id,
        repo_id: prepared.repository.id,
        name: 'e2e_pool',
        os: descriptor.os === 'win32' ? 'windows' : descriptor.os,
        architecture: descriptor.arch === 'x64' ? 'amd64' : descriptor.arch,
        toolchains: [digest],
        trust: 'trusted',
        isolation: 'ephemeral',
        max_runners: 1,
        max_slots: 1,
      },
    })
  ).data;
  const policy = await owner.api.call(
    `/v1/repos/${prepared.repository.id}/workflow-policy`,
  );
  await owner.api.call(`/v1/repos/${prepared.repository.id}/workflow-policy`, {
    method: 'PUT',
    etag: policy.etag,
    body: {
      policy: {
        access: {
          repository: 'read',
          capabilities: ['variables.read'],
          secrets: [],
        },
        hosted_profiles: [],
        self_hosted_pools: { e2e_pool: { trust: 'trusted', disposable: true } },
        inapplicable_jobs: [],
        allowed_toolchains: ['e2e_node24'],
      },
      toolchains: { e2e_node24: descriptor },
      modules: {},
      infrastructure_retries: 0,
      egress: {
        hosts: [],
        max_requests: 0,
        max_bytes: 0,
        max_request_bytes: 0,
      },
    },
  });
  const workflow = (
    await owner.api.call(`/v1/repos/${prepared.repository.id}/workflows`, {
      method: 'POST',
      body: {
        path: '.gitknot/workflows/verify.yaml',
        source_commit: prepared.repository.commit,
      },
    })
  ).data;
  const fixtures: E2EFixtures = {
    version: 1,
    state,
    owner: owner.user,
    outsider: outsider.user,
    repository: prepared.repository,
    deletion: prepared.deletion,
    workflow: {
      id: String(workflow.id),
      path: '.gitknot/workflows/verify.yaml',
      source: prepared.workflow,
    },
    pool: { id: String(pool.id), name: 'e2e_pool' },
    reproduction: {
      variable_name: variable.name,
      variable_value: variable.value,
      isolation_path: isolationPath,
      source_path: resolve(state, 'git-workspace'),
    },
  };
  await writeFile(fixtureFile(), `${JSON.stringify(fixtures, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(fixtureFile(), 0o600);
  console.log(
    `E2E fixtures verified through actual HTTP and native Git: ${prepared.repository.id}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  seed().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
