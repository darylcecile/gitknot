import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { verifyManifest } from '@gitknot/workflows';
import {
  E2E_API,
  E2E_APP,
  loadE2EFixtures,
  type FixtureUser,
} from '../../scripts/seed-e2e.ts';

type Resource = Record<string, unknown>;
const object = (value: unknown): Resource =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Resource)
    : {};
const items = (value: unknown): Resource[] =>
  Array.isArray(value) ? (value as Resource[]) : [];
const exec = promisify(execFile);

async function executeReproductionCommand(
  page: Page,
  command: string,
  info: TestInfo,
) {
  const fixture = await loadE2EFixtures();
  const temporary = join(tmpdir(), 'opencode');
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  // The runner canonicalizes private directories; macOS tmpdir() may use /var.
  const directory = await realpath(
    await mkdtemp(join(temporary, 'gitknot-e2e-reproduce-')),
  );
  const bin = join(directory, 'bin');
  await mkdir(bin, { mode: 0o700 });
  await symlink(
    resolve('packages/cli/dist/cli/src/index.js'),
    join(bin, 'gitknot'),
  );
  let tokenId: string | undefined;
  try {
    const token = await api(page, '/v1/tokens', {
      method: 'POST',
      body: {
        name: 'E2E selected-job reproduction',
        capabilities: ['contents.read', 'runs.read'],
        repository_ids: [fixture.repository.id],
        account_ids: [fixture.owner.id],
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    tokenId = String(token.data.id);
    const result = await exec('/bin/sh', ['-c', command], {
      cwd: directory,
      timeout: 90_000,
      maxBuffer: 4_194_304,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH || ''}`,
        GITKNOT_TOKEN: String(token.data.token),
        GITKNOT_CONFIG_DIR: join(directory, 'auth'),
        GITKNOT_STATE_DIR: join(directory, 'state'),
      },
    });
    const output = JSON.parse(result.stdout) as Resource;
    expect(output.outcome, result.stderr).toBe('passed');
    expect(output.commit).toBe(fixture.repository.commit);
    const proof = items(
      items(output.jobs).find((job) => job.job_id === 'verify')?.outputs,
    ).find((value) => value.name === 'proof');
    expect(proof).toMatchObject({
      type: 'json',
      value: { context: fixture.reproduction.variable_value },
    });
    const proofPath = await realpath(String(proof?.path));
    expect(
      proofPath.startsWith(`${directory}${sep}`),
      JSON.stringify({ directory, proofPath }),
    ).toBe(true);
    const bytes = await readFile(proofPath);
    expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(
      proof?.digest,
    );
    await writeFile(info.outputPath('local-reproduction-proof.json'), bytes, {
      mode: 0o600,
    });
    await writeFile(
      info.outputPath('local-reproduction-result.json'),
      JSON.stringify(output, null, 2),
      { mode: 0o600 },
    );
  } finally {
    try {
      if (tokenId) {
        const current = await api(page, `/v1/tokens/${tokenId}`);
        await api(page, `/v1/tokens/${tokenId}`, {
          method: 'DELETE',
          etag: current.etag,
        });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function api(
  page: Page,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    etag?: string;
    status?: number | number[];
  } = {},
) {
  const response = await page.request.fetch(`${E2E_API}${path}`, {
    method: options.method || 'GET',
    headers: {
      Origin: E2E_APP,
      'X-GitKnot-CSRF': '1',
      'Idempotency-Key': randomUUID(),
      ...(options.etag ? { 'If-Match': options.etag } : {}),
    },
    ...(options.body === undefined ? {} : { data: options.body }),
  });
  const content = await response.text();
  let data: Resource = {};
  try {
    data = content ? object(JSON.parse(content)) : {};
  } catch {
    /* Raw Git downloads are checked as exact bytes by their callers. */
  }
  const expected =
    options.status === undefined
      ? [200, 201, 202, 204]
      : Array.isArray(options.status)
        ? options.status
        : [options.status];
  expect(
    expected,
    `${options.method || 'GET'} ${path}: HTTP ${response.status()} ${JSON.stringify(data.error || {})}`,
  ).toContain(response.status());
  return { response, data, content, etag: response.headers().etag || '' };
}

async function signIn(page: Page, user: FixtureUser) {
  await page.goto('/auth/login');
  await page.getByLabel('Email address').fill(user.email);
  await page.getByLabel(/^Password/).fill(user.password);
  const login = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/v1/auth/login' &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  expect((await login).status()).toBe(200);
  await expect(page).toHaveURL(`${E2E_APP}/`);
  const me = await api(page, '/v1/me');
  expect(me.data.id).toBe(user.id);
  expect(me.data.email_verified).toBe(true);
  const workspace = page.getByRole('combobox', {
    name: 'Workspace',
    exact: true,
  });
  const personal = workspace.locator(`option[value="${user.id}"]`);
  await expect(personal).toHaveCount(1);
  await expect(personal).toContainText('Personal ·');
  await expect(personal).toContainText(`(@${user.username})`);
  await expect(
    workspace.getByRole('option', { name: 'Choose a workspace', exact: true }),
  ).toBeDisabled();
}

function runtimeErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      !/Failed to load resource: the server responded with a status of (401|403|404|412)/.test(
        message.text(),
      )
    )
      errors.push(message.text());
  });
  return errors;
}

async function recordEvidence(info: TestInfo, values: Resource) {
  const fixture = await loadE2EFixtures();
  await writeFile(
    resolve(
      fixture.state,
      `journey-${info.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 55)}.json`,
    ),
    JSON.stringify(values, null, 2),
    { mode: 0o600 },
  );
}

async function fillSource(
  page: Page,
  container: ReturnType<Page['locator']>,
  label: string,
  source: string,
) {
  await container
    .getByRole('button', { name: 'Markdown', exact: true })
    .click();
  const editor = container.getByRole('textbox', { name: label, exact: true });
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(source);
}

test('private collaboration: provisioning, canonical Markdown, revisions, comments, and second-principal denial', async ({
  page,
  browser,
}, info) => {
  const fixture = await loadE2EFixtures();
  const errors = runtimeErrors(page);
  await test.step('use the canonical browser origin when opening the numeric dev URL', async () => {
    const canonical = new URL('/auth/login?source=local-dev#origin-check', E2E_APP);
    const numeric = new URL(canonical);
    numeric.hostname = '127.0.0.1';
    expect((await page.goto(numeric.href))?.status()).toBe(200);
    await expect(page).toHaveURL(canonical.href);
  });
  await test.step('read the advertised documentation and support deep links without signing in', async () => {
    for (const [path, title, content] of [
      ['/docs', 'GitKnot documentation', 'Create a repository and push code'],
      ['/docs/cli', 'GitKnot CLI', 'gitknot auth setup-git'],
      ['/docs/workflows', 'GitKnot workflows', 'triggers: [workflow.dispatch'],
      ['/docs/api', 'GitKnot API', 'X-GitKnot-CSRF'],
      ['/support', 'GitKnot support', 'X-GitKnot-Request-ID'],
    ]) {
      expect((await page.goto(path!))?.status()).toBe(200);
      await expect(
        page.getByRole('heading', { level: 1, name: title, exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('article')).toContainText(content!);
      await expect(page).toHaveURL(`${E2E_APP}${path}`);
      await expect(page).toHaveTitle(`${title} · GitKnot`);
    }
    const supportEmail =
      process.env.VITE_SUPPORT_EMAIL?.trim() || 'support@gitknot.com';
    const contact = page
      .getByRole('region', { name: 'Contact GitKnot support' })
      .getByRole('link', { name: supportEmail, exact: true });
    await expect(contact).toBeVisible();
    const recipient = await contact.getAttribute('href');
    expect(recipient).toMatch(/^mailto:/);
    expect(decodeURIComponent(recipient!.slice('mailto:'.length))).toBe(
      supportEmail,
    );
    const opening = page.waitForEvent('popup');
    const specification = page
      .context()
      .waitForEvent(
        'response',
        (response) => new URL(response.url()).pathname === '/openapi.json',
      );
    await page
      .getByRole('link', { name: 'OpenAPI specification', exact: true })
      .click();
    const popup = await opening;
    const response = await specification;
    expect(response.status()).toBe(200);
    expect(new URL(response.url()).origin).toBe(new URL(E2E_APP).origin);
    const schema = (await response.json()) as {
      paths: Resource;
      info: { contact: { url: string } };
    };
    expect(schema.paths).toHaveProperty('/v1/runs/{id}/manifest');
    expect(schema.info.contact.url).toBe('https://gitknot.com/support');
    await popup.close();
    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole('navigation', { name: 'Documentation', exact: true })
      .getByRole('link', { name: 'Command line', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'GitKnot CLI', exact: true }),
    ).toBeVisible();
    const code = page
      .getByRole('region', { name: /^Scrollable code block/ })
      .first();
    await expect(code).toHaveAttribute('tabindex', '0');
    await code.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(code).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(() => code.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 1280, height: 720 });
  });
  await signIn(page, fixture.owner);
  await page
    .context()
    .storageState({ path: resolve(fixture.state, 'owner-browser-state.json') });
  await chmod(resolve(fixture.state, 'owner-browser-state.json'), 0o600);

  let repoId = '';
  await test.step('create and genuinely provision a private repository', async () => {
    await page.goto('/repos/new');
    await page.getByLabel(/^Owner account/).selectOption(fixture.owner.id);
    await page.getByLabel(/^Name/).fill(`browser-${randomUUID().slice(0, 8)}`);
    await page
      .getByLabel(/^Description/)
      .fill('Private browser collaboration verification');
    await page.getByLabel(/^Visibility/).selectOption('private');
    const created = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/v1/repos' &&
        response.request().method() === 'POST',
    );
    await page
      .getByRole('button', { name: 'Create repository', exact: true })
      .click();
    const response = await created;
    expect(response.status()).toBe(202);
    repoId = String((await response.json()).id);
    await expect(
      page.getByRole('link', { name: 'Open repository', exact: true }),
    ).toBeVisible({ timeout: 90_000 });
    expect((await api(page, `/v1/repos/${repoId}`)).data.state).toBe('active');
  });

  let issueId = '';
  const title = `A reviewable decision ${randomUUID().slice(0, 8)}`;
  const unsupported =
    '<custom-block data-version="1">\n  exact & unsupported\n</custom-block>\n';
  const source = `A **reviewable** proposal.\n\n${unsupported}`;
  await test.step('create an issue through the real rich/source editor', async () => {
    await page.goto(`/repos/${repoId}/issues`);
    await page.getByRole('button', { name: 'New issue', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New issue' });
    await dialog.getByLabel(/^Title/).fill(title);
    await fillSource(page, dialog, 'Description', source);
    await dialog.getByRole('button', { name: 'Write', exact: true }).click();
    await expect(dialog.locator('.preserved-block')).toContainText(
      'exact & unsupported',
    );
    await dialog
      .getByRole('button', { name: 'New issue', exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/repos/${repoId}/issues/[^/?]+$`));
    issueId = new URL(page.url()).pathname.split('/').at(-1)!;
    expect(
      (await api(page, `/v1/repos/${repoId}/issues/${issueId}`)).data.markdown,
    ).toBe(source);
  });

  await test.step('retain unsupported CRLF bytes across a real rich edit and concurrent save', async () => {
    const path = `/v1/repos/${repoId}/issues/${issueId}`;
    const original = await api(page, path);
    const crlf = source.replaceAll('\n', '\r\n');
    await api(page, path, {
      method: 'PATCH',
      etag: original.etag,
      body: { markdown: crlf },
    });
    await page.reload();
    await page
      .getByRole('button', { name: 'Edit', exact: true })
      .first()
      .click();
    const edit = page.getByRole('dialog', { name: 'Edit issue' });
    await edit.getByRole('button', { name: 'Markdown', exact: true }).click();
    await edit.getByRole('button', { name: 'Write', exact: true }).click();
    await edit.locator('.ProseMirror p').first().click();
    await page.keyboard.insertText(' clearer ');
    await edit.getByLabel(/^Title/).fill(`${title} · my draft`);
    const beforeRace = await api(page, path);
    await api(page, path, {
      method: 'PATCH',
      etag: beforeRace.etag,
      body: { title: `${title} · concurrent editor` },
    });
    await edit
      .getByRole('button', { name: 'Save changes', exact: true })
      .click();
    await expect(edit.getByRole('alert')).toContainText(
      'changed while you were working',
    );
    await expect(edit.getByLabel(/^Title/)).toHaveValue(`${title} · my draft`);
    await edit.getByRole('button', { name: 'Review current version' }).click();
    await edit
      .getByRole('button', { name: 'Use this revision, keep my draft' })
      .click();
    await edit
      .getByRole('button', { name: 'Save changes', exact: true })
      .click();
    await expect(edit).not.toBeVisible();
    const saved = await api(page, path);
    expect(saved.data.title).toBe(`${title} · my draft`);
    expect(String(saved.data.markdown)).toContain(
      unsupported.replaceAll('\n', '\r\n'),
    );
    const versions = await api(page, `${path}/versions`);
    expect(
      items(versions.data.items).some(
        (version) => version.title === `${title} · concurrent editor`,
      ),
    ).toBe(true);
  });

  await test.step('post a revision-bound comment', async () => {
    const panel = page.locator('section.panel').filter({
      has: page.getByRole('heading', { name: 'Add a comment', exact: true }),
    });
    await fillSource(
      page,
      panel,
      'Comment',
      'A comment sent through the production collaboration API.',
    );
    const response = page.waitForResponse(
      (value) =>
        new URL(value.url()).pathname ===
          `/v1/repos/${repoId}/issues/${issueId}/comments` &&
        value.request().method() === 'POST',
    );
    await panel
      .getByRole('button', { name: 'Post comment', exact: true })
      .click();
    expect((await response).status()).toBe(201);
    await expect(page.locator('.comment')).toContainText(
      'production collaboration API',
    );
    await expect(page.locator('.comment-author').last()).toHaveText(
      'E2E owner',
    );
    await expect(page.locator('.comment-author').last()).not.toContainText(
      fixture.owner.id,
    );
  });

  await test.step('a different verified principal cannot discover or read private content', async () => {
    const context = await browser.newContext({ baseURL: E2E_APP });
    try {
      const outsider = await context.newPage();
      await signIn(outsider, fixture.outsider);
      await api(outsider, `/v1/repos/${repoId}`, { status: 404 });
      await api(outsider, `/v1/repos/${repoId}/issues/${issueId}`, {
        status: 404,
      });
      await api(
        outsider,
        `/v1/repos/${fixture.repository.id}/raw?ref=${fixture.repository.commit}&path=README.md`,
        { status: 404 },
      );
      await outsider.goto(`/repos/${repoId}/issues/${issueId}`);
      await expect(outsider.getByRole('alert')).toBeVisible();
      await expect(outsider.locator('body')).not.toContainText(title);
    } finally {
      await context.close();
    }
  });

  await test.step('capture and download a complete account export with real metadata and repository archives', async () => {
    const accountId = fixture.owner.id;
    await page.goto(`/accounts/${accountId}/exports`);
    await page
      .getByRole('button', { name: 'Create account export', exact: true })
      .click();
    const create = page.getByRole('dialog', {
      name: 'Create account export',
      exact: true,
    });
    const creating = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/v1/accounts/${accountId}/exports` &&
        response.request().method() === 'POST',
    );
    await create
      .getByRole('button', { name: 'Create account export', exact: true })
      .click();
    const created = await creating;
    expect(created.status(), await created.text()).toBe(202);
    const id = String((await created.json()).id);
    await expect(page).toHaveURL(
      `${E2E_APP}/accounts/${accountId}/exports/${id}`,
    );
    const download = page.getByRole('button', {
      name: 'Download complete account archive',
      exact: true,
    });
    await expect(download).toBeVisible({ timeout: 120_000 });
    const ready = await api(page, `/v1/accounts/${accountId}/exports/${id}`);
    expect(ready.data).toMatchObject({
      id,
      state: 'completed',
      coverage: {
        complete: true,
        repository_count: 2,
        verified_repository_count: 2,
      },
    });
    const downloading = page.waitForEvent('download');
    await download.click();
    const file = await downloading;
    expect(await file.failure()).toBeNull();
    const archive = info.outputPath('complete-account.gitknot.tar');
    await file.saveAs(archive);
    const bytes = await readFile(archive);
    expect(bytes.byteLength).toBe(Number(ready.data.size_bytes));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      ready.data.checksum_sha256,
    );
    const manifest = JSON.parse(
      (
        await exec('tar', ['-xOf', archive, 'manifest.json'], {
          maxBuffer: 4_194_304,
        })
      ).stdout,
    ) as Resource;
    expect(manifest).toMatchObject({
      format: 'gitknot.account',
      version: 1,
      account_id: accountId,
      coverage: { complete: true, repository_count: 2 },
    });
    const repositories = items(manifest.repositories);
    expect(repositories.map((repository) => repository.repo_id).sort()).toEqual(
      [repoId, fixture.repository.id].sort(),
    );
    const accountMetadata = items(manifest.metadata).find((part) =>
      String(part.path).startsWith('metadata/accounts/'),
    );
    expect(accountMetadata).toBeTruthy();
    const rows = JSON.parse(
      (
        await exec('tar', ['-xOf', archive, String(accountMetadata?.path)], {
          maxBuffer: 4_194_304,
        })
      ).stdout,
    ) as Resource[];
    expect(
      rows.some(
        (row) => row.id === accountId && row.slug === fixture.owner.username,
      ),
    ).toBe(true);
    const nested = repositories.find(
      (repository) => repository.repo_id === fixture.repository.id,
    )!;
    const nestedBytes = (
      await exec('tar', ['-xOf', archive, String(nested.path)], {
        encoding: 'buffer',
        maxBuffer: 16_777_216,
      })
    ).stdout;
    expect(createHash('sha256').update(nestedBytes).digest('hex')).toBe(
      nested.sha256,
    );
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Workspace navigation' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await recordEvidence(info, { repo_id: repoId, issue_id: issueId });
});

test('code and scoped settings: native files, viewer downloads, write-only vault, and token revocation', async ({
  page,
  browser,
}, info) => {
  const fixture = await loadE2EFixtures();
  const errors = runtimeErrors(page);
  await signIn(page, fixture.owner);
  const repoId = fixture.repository.id;

  await test.step('browse and download the actual native Git file', async () => {
    await page.goto(`/repos/${repoId}`);
    await page
      .locator('.file-list')
      .getByRole('link')
      .filter({ has: page.getByText('README.md', { exact: true }) })
      .click();
    await expect(page.locator('.file-content')).toContainText(
      'Real Git bytes, retained exactly.',
    );
    const downloading = page.waitForEvent('download');
    const requesting = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        request.method() === 'GET' &&
        url.pathname === `/v1/repos/${repoId}/raw` &&
        url.searchParams.get('path') === 'README.md'
      );
    });
    await page.getByRole('button', { name: 'Raw file', exact: true }).click();
    const downloaded = await downloading;
    expect(new URL((await requesting).url()).origin).toBe(
      new URL(E2E_APP).origin,
    );
    expect(await downloaded.failure()).toBeNull();
    const path = info.outputPath('README.md');
    await downloaded.saveAs(path);
    expect(await readFile(path, 'utf8')).toBe(
      '# E2E repository\r\n\r\nReal Git bytes, retained exactly.\r\n',
    );
    await page.goto(`/repos/${repoId}/history`);
    await expect(page.locator('.commit-row')).toContainText(
      'Publish actual E2E source and workflow',
    );
  });

  let viewerId = '';
  await test.step('review an actual native deletion diff using the original repository path', async () => {
    const created = await api(page, `/v1/repos/${repoId}/pulls`, {
      method: 'POST',
      status: 201,
      body: {
        title: 'Review deleted source',
        markdown:
          'Keep the removed file anchored to its immutable old-side lines.',
        base_ref: 'refs/heads/main',
        head_ref: fixture.deletion.head_ref,
        base_oid: fixture.deletion.base_oid,
        head_oid: fixture.deletion.head_oid,
        draft: false,
      },
    });
    const pullId = String(created.data.id);
    const diff = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        `/v1/repos/${repoId}/pulls/${pullId}/diff`,
    );
    await page.goto(`/repos/${repoId}/pulls/${pullId}?tab=changes`);
    const nativeDiff = await diff;
    expect(nativeDiff.status()).toBe(200);
    expect(await nativeDiff.text()).toContain('+++ /dev/null');
    const file = page.locator('.diff-file').filter({
      has: page.locator('summary strong', { hasText: fixture.deletion.path }),
    });
    await expect(file.locator('summary strong')).toHaveText(
      fixture.deletion.path,
    );
    await expect(file.locator('summary')).not.toContainText('/dev/null');
    await expect(file.locator('summary')).not.toContainText('legacy option');
    await file
      .getByRole('button', {
        name: `Comment on ${fixture.deletion.path} line 1`,
        exact: true,
      })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Comment on this revision',
    });
    await fillSource(
      page,
      dialog,
      'Comment',
      'This removed line remains reviewable at the original patch.',
    );
    const posted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/v1/repos/${repoId}/pulls/${pullId}/threads` &&
        response.request().method() === 'POST',
    );
    await dialog
      .getByRole('button', { name: 'Start review thread', exact: true })
      .click();
    const response = await posted;
    expect(response.status()).toBe(201);
    expect(response.request().postDataJSON()).toMatchObject({
      path: fixture.deletion.path,
      side: 'old',
      patch_id: created.data.current_patch_id,
      start_line: 1,
      end_line: 1,
    });
    const threads = await api(
      page,
      `/v1/repos/${repoId}/pulls/${pullId}/threads`,
    );
    expect(
      items(threads.data.items).some(
        (thread) =>
          thread.path === fixture.deletion.path &&
          thread.side === 'old' &&
          thread.start_line === 1,
      ),
    ).toBe(true);
  });

  await test.step('create a viewer grant in the UI and use it without a session cookie', async () => {
    await page.goto(`/repos/${repoId}/settings/viewer-grants`);
    await page
      .getByRole('button', { name: 'Create viewer grant', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Create viewer grant' });
    await dialog
      .getByLabel(/^Name/)
      .fill(`E2E viewer ${randomUUID().slice(0, 8)}`);
    const expires = new Date(Date.now() + 30 * 60_000);
    await dialog
      .getByLabel(/^Expiration/)
      .fill(
        new Date(expires.getTime() - expires.getTimezoneOffset() * 60_000)
          .toISOString()
          .slice(0, 16),
      );
    const created = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/v1/tokens' &&
        response.request().method() === 'POST',
    );
    await dialog
      .getByRole('button', { name: 'Create viewer grant', exact: true })
      .click();
    const response = await created;
    expect(response.status()).toBe(201);
    const token = (await response.json()) as { id: string; token: string };
    viewerId = token.id;
    const context = await browser.newContext({ baseURL: E2E_APP });
    try {
      const viewer = await context.newPage();
      const requests: Array<{ url: string; authorization?: string }> = [];
      viewer.on('request', (request) =>
        requests.push({
          url: request.url(),
          authorization: request.headers().authorization,
        }),
      );
      await viewer.goto(
        `/viewer/${repoId}#token=${encodeURIComponent(token.token)}`,
      );
      await viewer
        .getByRole('button', { name: 'Open repository', exact: true })
        .click();
      await expect(viewer).toHaveURL(`${E2E_APP}/repos/${repoId}`);
      await viewer
        .locator('.file-list')
        .getByRole('link')
        .filter({ has: viewer.getByText('README.md', { exact: true }) })
        .click();
      const downloading = viewer.waitForEvent('download');
      await viewer
        .getByRole('button', { name: 'Raw file', exact: true })
        .click();
      expect(await (await downloading).failure()).toBeNull();
      const raw = requests.filter(
        (value) =>
          new URL(value.url).pathname.endsWith('/raw') &&
          new URL(value.url).searchParams.get('path') === 'README.md',
      );
      expect(raw.length).toBeGreaterThanOrEqual(2);
      expect(
        raw.every(
          (request) => request.authorization === `Bearer ${token.token}`,
        ),
      ).toBe(true);
      expect(
        requests.every((request) => !request.url.includes(token.token)),
      ).toBe(true);
      expect(
        await viewer.evaluate(() =>
          JSON.stringify({ ...localStorage, ...sessionStorage }),
        ),
      ).not.toContain(token.token);
      const current = await api(page, `/v1/tokens/${token.id}`);
      await api(page, `/v1/tokens/${token.id}`, {
        method: 'DELETE',
        etag: current.etag,
      });
      await viewer.reload();
      await expect(viewer.getByRole('alert')).toBeVisible();
      await expect(viewer.locator('.file-content')).not.toBeVisible();
    } finally {
      await context.close();
    }
  });

  const name = `E2E_${randomUUID().replaceAll('-', '_').toUpperCase()}`;
  const secret = `first-${randomUUID()}`;
  const rotated = `rotated-${randomUUID()}`;
  await test.step('create, rotate, and revoke a real write-only secret', async () => {
    await page.goto(`/repos/${repoId}/settings/secrets`);
    await page
      .getByRole('button', { name: 'Create secret', exact: true })
      .click();
    const create = page.getByRole('dialog', { name: 'Create secret' });
    await create.getByLabel(/^Name/).fill(name);
    await create.getByLabel(/^Secret value/).fill(secret);
    await create
      .getByRole('button', { name: 'Create secret', exact: true })
      .click();
    const row = page.getByRole('row').filter({ hasText: name });
    await expect(row).toBeVisible();
    const path = `/v1/repos/${repoId}/secrets/${name}`;
    const metadata = await api(page, path);
    expect(metadata.data).not.toHaveProperty('value');
    expect(
      await page.evaluate(() =>
        JSON.stringify({ ...localStorage, ...sessionStorage }),
      ),
    ).not.toContain(secret);
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'Edit secret' });
    await expect(edit.getByLabel(/^Secret value/)).toHaveValue('');
    await edit.getByLabel(/^Secret value/).fill(rotated);
    await edit
      .getByRole('button', { name: 'Save changes', exact: true })
      .click();
    await expect(edit).not.toBeVisible();
    const updated = await api(page, path);
    expect(updated.etag).not.toBe(metadata.etag);
    expect(JSON.stringify(updated.data)).not.toContain(rotated);
    await row.getByRole('button', { name: 'Remove', exact: true }).click();
    const remove = page.getByRole('dialog', { name: `Remove ${name}?` });
    await remove.getByRole('textbox').fill(name);
    const deleting = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === path &&
        response.request().method() === 'DELETE',
    );
    await remove.getByRole('button', { name: 'Remove', exact: true }).click();
    expect((await deleting).status()).toBe(204);
    await expect(row).not.toBeVisible();
    const deleted = await api(page, path, { status: 200 });
    expect(deleted.data).toMatchObject({
      id: metadata.data.id,
      kind: 'secret',
      name,
      revision: Number(updated.data.revision) + 1,
    });
    expect(deleted.data.deleted_at).toEqual(expect.any(String));
    expect(Number.isFinite(Date.parse(String(deleted.data.deleted_at)))).toBe(
      true,
    );
    expect(deleted.etag).not.toBe(updated.etag);
    expect(deleted.data).not.toHaveProperty('value');
    expect(deleted.data).not.toHaveProperty('ciphertext');
    expect(JSON.stringify(deleted.data)).not.toContain(secret);
    expect(JSON.stringify(deleted.data)).not.toContain(rotated);
    const active = await api(page, `/v1/repos/${repoId}/secrets`);
    expect(
      items(active.data.items).some(
        (entry) => entry.id === deleted.data.id || entry.name === name,
      ),
    ).toBe(false);
    const versions = items((await api(page, `${path}/versions`)).data.items);
    expect(versions).toHaveLength(2);
    expect(
      versions.every(
        (version) => !('value' in version) && !('ciphertext' in version),
      ),
    ).toBe(true);
    expect(JSON.stringify(versions)).not.toContain(secret);
    expect(JSON.stringify(versions)).not.toContain(rotated);
  });
  expect(errors).toEqual([]);
  await recordEvidence(info, {
    repo_id: repoId,
    revoked_viewer_id: viewerId,
    revoked_secret: name,
  });
});

test('workflow and billing: real compiled plan, queued-run cancellation, provenance, budgets, and admission controls', async ({
  page,
  browser,
}, info) => {
  const fixture = await loadE2EFixtures();
  const errors = runtimeErrors(page);
  await signIn(page, fixture.owner);
  const repoId = fixture.repository.id;
  let runId = '';
  let cancellationReview: Resource | null = null;

  await test.step('validate and read a real immutable preview without starting a run', async () => {
    const before = items(
      (await api(page, `/v1/repos/${repoId}/runs`)).data.items,
    ).map((run) => run.id);
    await page.goto(`/repos/${repoId}/workflows/validate`);
    await page
      .getByRole('textbox', { name: 'Workflow YAML source', exact: true })
      .focus();
    await page.keyboard.insertText(fixture.workflow.source);
    const validating = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/v1/repos/${repoId}/workflows/validate` &&
        response.request().method() === 'POST',
    );
    await page
      .getByRole('button', { name: 'Validate workflow', exact: true })
      .click();
    const validated = await validating;
    expect(validated.status(), await validated.text()).toBe(200);
    expect(validated.request().postDataJSON()).toEqual({
      source: fixture.workflow.source,
    });
    const validation = (await validated.json()) as Resource;
    expect(validation, JSON.stringify(validation.diagnostics)).toMatchObject({
      kind: 'validation',
      valid: true,
      executable: false,
      manifest_digest: null,
      definition: { origin: 'submitted_draft' },
    });
    await expect(
      page.getByRole('heading', { name: 'Validation result', exact: true }),
    ).toBeVisible();

    await page.goto(`/repos/${repoId}/workflows/${fixture.workflow.id}`);
    await page
      .getByRole('button', { name: 'Preview execution plan', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Preview execution plan',
      exact: true,
    });
    await dialog.getByLabel(/^Source commit/).fill(fixture.repository.commit);
    await dialog.getByLabel(/^Source ref/).fill('refs/heads/main');
    const creating = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/v1/repos/${repoId}/workflows/${fixture.workflow.id}/plan` &&
        response.request().method() === 'POST',
    );
    await dialog
      .getByRole('button', { name: 'Preview execution plan', exact: true })
      .click();
    const response = await creating;
    expect(response.status(), await response.text()).toBe(201);
    expect(response.request().postDataJSON()).toEqual({
      commit_oid: fixture.repository.commit,
      ref: 'refs/heads/main',
      inputs: {},
    });
    const created = (await response.json()) as Resource;
    expect(created, JSON.stringify(created.diagnostics)).toMatchObject({
      kind: 'plan',
      valid: true,
      executable: false,
      definition: {
        origin: 'approved_workflow',
        workflow_id: fixture.workflow.id,
      },
      source: { commit: fixture.repository.commit, verified: true },
      order: ['verify'],
    });
    expect(object(created.cost).maximum_cost_units).toMatch(/^\d+$/);
    const path = `/v1/repos/${repoId}/plans/${String(created.id)}`;
    const saved = await api(page, path);
    expect(saved.etag).toBe(response.headers().etag);
    expect(saved.data).toEqual(created);
    await expect(page).toHaveURL(
      `${E2E_APP}/repos/${repoId}/plans/${String(created.id)}`,
    );
    await expect(
      page.getByRole('heading', { name: 'Jobs and requirements', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'verify', exact: true }),
    ).toBeVisible();
    expect(
      items((await api(page, `/v1/repos/${repoId}/runs`)).data.items).map(
        (run) => run.id,
      ),
    ).toEqual(before);
  });

  await test.step('dispatch the approved native Git workflow and inspect its immutable plan', async () => {
    const history = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/v1/repos/${repoId}/workflows/${fixture.workflow.id}/versions` &&
        response.request().method() === 'GET',
    );
    await page.goto(`/repos/${repoId}/workflows/${fixture.workflow.id}`);
    const versions = await history;
    expect(versions.status()).toBe(200);
    expect(
      items(object(await versions.json()).items).some(
        (version) =>
          version.source_commit === fixture.repository.commit &&
          version.definition === fixture.workflow.source,
      ),
    ).toBe(true);
    await expect(
      page.getByRole('heading', { name: 'Approved versions', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'e2e_verify', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Run workflow', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Run workflow',
      exact: true,
    });
    await dialog.getByLabel(/^Source commit/).fill(fixture.repository.commit);
    await dialog.getByLabel(/^Source ref/).fill('refs/heads/main');
    const dispatched = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/v1/repos/${repoId}/runs` &&
        response.request().method() === 'POST',
    );
    await dialog
      .getByRole('button', { name: 'Run workflow', exact: true })
      .click();
    const response = await dispatched;
    expect(response.status()).toBe(202);
    const accepted = (await response.json()) as Resource;
    runId = String(accepted.id);
    await expect(page).toHaveURL(new RegExp(`/repos/${repoId}/runs/${runId}$`));
    await expect
      .poll(
        async () => (await api(page, `/v1/runs/${runId}`)).data.commit_sha,
        { timeout: 60_000, intervals: [1000] },
      )
      .toBe(fixture.repository.commit);
    const run = await api(page, `/v1/runs/${runId}`);
    expect(run.data.commit_sha).toBe(fixture.repository.commit);
    expect(run.data.plan_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(accepted.revision).toEqual(expect.any(Number));
    if (accepted.status === 'planning')
      expect(Number(run.data.revision)).toBeGreaterThan(
        Number(accepted.revision),
      );
    else
      expect(Number(run.data.revision)).toBeGreaterThanOrEqual(
        Number(accepted.revision),
      );
    const reproduction = await api(page, `/v1/runs/${runId}/reproduce`);
    const manifest = object(reproduction.data.manifest);
    expect(JSON.stringify(reproduction.data)).toContain(
      fixture.repository.commit,
    );
    expect(JSON.stringify(manifest)).toContain('e2e_verify');
    expect(
      items((await api(page, `/v1/runs/${runId}/jobs`)).data.items).length,
    ).toBeGreaterThan(0);
    await expect(
      page.getByText('Every verification outcome', { exact: true }),
    ).toBeVisible();
    const downloading = page.waitForEvent('download');
    const requesting = page.waitForRequest(
      (request) =>
        request.method() === 'GET' &&
        new URL(request.url()).pathname === `/v1/runs/${runId}/manifest`,
    );
    await page
      .getByRole('button', { name: 'Download manifest', exact: true })
      .click();
    const downloaded = await downloading;
    expect(new URL((await requesting).url()).origin).toBe(
      new URL(E2E_APP).origin,
    );
    expect(await downloaded.failure()).toBeNull();
    const path = info.outputPath('portable-manifest.json');
    await downloaded.saveAs(path);
    const portable = JSON.parse(await readFile(path, 'utf8')) as unknown;
    const verified = await verifyManifest(portable);
    expect(verified.workflow.name).toBe('e2e_verify');
    expect(portable).not.toHaveProperty('manifest');
  });

  await test.step('load selected-job context and execute the copied CLI command with a real isolation file', async () => {
    await page
      .getByRole('button', { name: 'Reproduce locally', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Reproduce this run',
      exact: true,
    });
    await dialog.getByLabel(/^Job/).selectOption('verify');
    await expect(
      dialog.getByRole('button', {
        name: 'Copy reproduce command',
        exact: true,
      }),
    ).not.toBeVisible();
    await dialog
      .getByLabel('Choose existing isolation JSON', { exact: true })
      .setInputFiles(fixture.reproduction.isolation_path);
    await dialog
      .getByLabel(/^Existing isolation configuration path/)
      .fill(fixture.reproduction.isolation_path);
    await dialog
      .getByLabel(/^Local checkout path/)
      .fill(fixture.reproduction.source_path);
    await dialog.getByLabel(/^Command shell/).selectOption('posix');
    const requested = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/v1/runs/${runId}/reproduce` &&
        response.request().method() === 'GET',
    );
    await dialog
      .getByRole('button', { name: 'Load reproduction context', exact: true })
      .click();
    const response = await requested;
    expect(response.status(), await response.text()).toBe(200);
    const url = new URL(response.url());
    expect(url.searchParams.get('job')).toBe('verify');
    expect(url.searchParams.has('job_id')).toBe(false);
    expect([...url.searchParams.keys()]).toEqual(['job']);
    const reproduction = (await response.json()) as Resource;
    expect(
      object(reproduction.variables)[fixture.reproduction.variable_name],
    ).toBe(fixture.reproduction.variable_value);
    const evidence = dialog.getByRole('region', {
      name: 'Reproduction context for verify',
      exact: true,
    });
    await expect(evidence).toContainText(fixture.reproduction.variable_value);
    await expect(evidence).toContainText(fixture.repository.commit);
    const sourceToken = object(reproduction.source).token;
    if (typeof sourceToken === 'string')
      await expect(dialog).not.toContainText(sourceToken);
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin: E2E_APP,
      });
    await dialog
      .getByRole('button', { name: 'Copy reproduce command', exact: true })
      .click();
    await expect(dialog.getByText('Copied', { exact: true })).toBeVisible();
    const command = await page.evaluate(() => navigator.clipboard.readText());
    expect(command).toBe(
      await dialog.locator('.reproduction-command pre').innerText(),
    );
    await executeReproductionCommand(page, command, info);
    await dialog
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click();
    expect(
      items((await api(page, `/v1/runs/${runId}/outputs`)).data.items),
    ).toEqual([]);
  });

  await test.step('cancel real queued work and retain a durable terminal result', async () => {
    await page.getByRole('button', { name: 'Cancel run', exact: true }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Cancel run',
      exact: true,
    });
    const cancelling = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/v1/runs/${runId}/cancel` &&
        response.request().method() === 'POST',
    );
    await dialog
      .getByRole('button', { name: 'Cancel run', exact: true })
      .click();
    let cancelled = await cancelling;
    expect([202, 412], await cancelled.text()).toContain(cancelled.status());
    expect(cancelled.request().headers()['if-match']).toMatch(/^"\d+"$/);
    expect(cancelled.request().postDataJSON()).toEqual({});
    if (cancelled.status() === 412) {
      const conflict = (await cancelled.json()) as {
        error: { code: string; request_id: string };
      };
      expect(conflict.error.code).toBe('revision_conflict');
      const alert = dialog.getByRole('alert');
      await expect(alert).toBeVisible();
      await expect(alert).toHaveAccessibleName(
        'This resource changed while you were working.',
      );
      await expect(alert).toContainText(
        'Review the current version before confirming this action.',
      );
      await expect(alert).toContainText(conflict.error.request_id);
      const previousHeaders = cancelled.request().headers();
      await dialog
        .getByRole('button', { name: 'Review current version', exact: true })
        .click();
      const revision = dialog.locator(
        '.conflict-recovery .current-revision code',
      );
      await expect(revision).toBeVisible();
      const etag = (await revision.innerText()).trim();
      expect(etag).toMatch(/^"\d+"$/);
      const reviewedRevision = Number(etag.slice(1, -1));
      expect(reviewedRevision).toBeGreaterThan(
        Number(previousHeaders['if-match']!.slice(1, -1)),
      );
      const serverVersion = dialog.locator('.conflict-recovery .json-details');
      await serverVersion
        .getByText('Current server version', { exact: true })
        .click();
      const current = JSON.parse(
        await serverVersion.locator('pre').innerText(),
      ) as Resource;
      expect(current.id).toBe(runId);
      expect(current.revision).toBe(reviewedRevision);
      await dialog
        .getByRole('button', { name: 'Use this revision', exact: true })
        .click();
      await expect(alert).not.toBeVisible();
      await expect(dialog).toBeVisible();
      const confirming = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/v1/runs/${runId}/cancel` &&
          response.request().method() === 'POST',
      );
      await dialog
        .getByRole('button', { name: 'Cancel run', exact: true })
        .click();
      cancelled = await confirming;
      expect(cancelled.request().headers()['if-match']).toBe(etag);
      expect(cancelled.request().headers()['idempotency-key']).not.toBe(
        previousHeaders['idempotency-key'],
      );
      cancellationReview = {
        conflict_request_id: conflict.error.request_id,
        original_etag: previousHeaders['if-match'],
        reviewed_etag: etag,
        confirmation_request_id: cancelled.headers()['x-gitknot-request-id'],
      };
    }
    expect(cancelled.status(), await cancelled.text()).toBe(202);
    await expect(dialog).not.toBeVisible();
    await expect
      .poll(async () => (await api(page, `/v1/runs/${runId}`)).data.status, {
        timeout: 60_000,
        intervals: [1000],
      })
      .toBe('cancelled');
    expect(
      items((await api(page, `/v1/runs/${runId}/outputs`)).data.items),
    ).toEqual([]);
  });

  await test.step('read actual billing and change an enforceable scoped budget', async () => {
    const accountId = fixture.owner.id;
    await page.goto(`/billing/${accountId}/overview`);
    const billing = await api(page, `/v1/accounts/${accountId}/billing`);
    expect(billing.data.monetary_unit).toBe('USD/1000000000');
    expect(billing.data.measured_usage_units).toMatch(/^-?\d+$/);
    await expect(
      page.getByText('Measured usage', { exact: true }),
    ).toBeVisible();
    const planPanel = page
      .locator('section.panel')
      .filter({
        has: page.getByRole('heading', { name: 'Your plan', exact: true }),
      });
    await expect(planPanel.locator('.included-usage')).toContainText(
      '$0.50 USD',
    );
    await expect(planPanel.locator('.included-usage')).not.toContainText(
      '500000000',
    );
    await page.goto(`/billing/${accountId}/subscription`);
    const freePlan = page
      .locator('.setting-row')
      .filter({
        has: page.getByRole('heading', { name: 'Free', exact: true }),
      });
    await expect(freePlan.locator('.included-usage')).toContainText(
      '$0.50 USD',
    );
    await page.goto(`/billing/${accountId}/budgets`);
    await page
      .getByRole('button', { name: 'Create budget', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Create budget' });
    await dialog.getByLabel(/^Scope \*/).selectOption('repository');
    await dialog.getByRole('combobox', { name: 'Repository', exact: true }).selectOption(repoId);
    await dialog.getByLabel(/^Limit \(USD\)/).fill('0.025');
    await dialog
      .getByRole('button', { name: 'Create budget', exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    const budgets = await api(page, `/v1/accounts/${accountId}/budgets`);
    expect(
      items(budgets.data.items).some(
        (budget) =>
          budget.scope === 'repository' &&
          budget.scope_id === repoId &&
          budget.limit_units === '25000000',
      ),
    ).toBe(true);
    await page.goto(`/billing/${accountId}/overview`);
    await page
      .getByRole('button', { name: 'Pause admission', exact: true })
      .click();
    const pause = page.getByRole('dialog', { name: 'Pause admission' });
    await pause
      .getByLabel(/^Reason/)
      .fill('Verify the real E2E admission stop control');
    await pause
      .getByRole('button', { name: 'Pause admission', exact: true })
      .click();
    await expect(pause).not.toBeVisible();
    expect(
      object(
        (await api(page, `/v1/accounts/${accountId}/billing`)).data.admission,
      ).stopped,
    ).toBe(true);
    await page
      .getByRole('button', { name: 'Resume admission', exact: true })
      .click();
    const resume = page.getByRole('dialog', { name: 'Resume admission' });
    await resume
      .getByLabel(/^Reason/)
      .fill('Restore admission after E2E verification');
    await resume
      .getByRole('button', { name: 'Resume admission', exact: true })
      .click();
    await expect(resume).not.toBeVisible();
    expect(
      object(
        (await api(page, `/v1/accounts/${accountId}/billing`)).data.admission,
      ).stopped,
    ).toBe(false);
  });
  await test.step('a repository-scoped runner manager lists only that repository’s pools', async () => {
    const issued = await api(page, '/v1/tokens', {
      method: 'POST',
      body: {
        name: 'E2E repository runner manager',
        capabilities: ['runners.manage', 'repositories.read', 'contents.read'],
        repository_ids: [repoId],
        account_ids: [fixture.owner.id],
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      },
    });
    const context = await browser.newContext({
      baseURL: E2E_APP,
      extraHTTPHeaders: {
        Authorization: `Bearer ${String(issued.data.token)}`,
      },
    });
    try {
      const limited = await context.newPage();
      await api(limited, `/v1/runner-pools?account_id=${fixture.owner.id}`, {
        status: 403,
      });
      const listing = limited.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/v1/runner-pools' &&
          response.request().method() === 'GET',
      );
      await limited.goto(`/repos/${repoId}/runners`);
      const response = await listing;
      expect(response.status(), await response.text()).toBe(200);
      expect(new URL(response.url()).searchParams.get('repo_id')).toBe(repoId);
      const pools = items(object(await response.json()).items);
      expect(pools.some((pool) => pool.id === fixture.pool.id)).toBe(true);
      expect(pools.every((pool) => pool.repo_id === repoId)).toBe(true);
      await expect(
        limited.getByRole('row').filter({ hasText: fixture.pool.name }),
      ).toBeVisible();
    } finally {
      await context.close();
      const current = await api(page, `/v1/tokens/${String(issued.data.id)}`);
      await api(page, `/v1/tokens/${String(issued.data.id)}`, {
        method: 'DELETE',
        etag: current.etag,
      });
    }
  });

  await test.step('delete an idle environment and read its retained metadata', async () => {
    const name = `e2e-idle-${randomUUID().slice(0, 8)}`;
    await page.goto(`/repos/${repoId}/environments`);
    await page
      .getByRole('button', { name: 'Create environment', exact: true })
      .click();
    const create = page.getByRole('dialog', {
      name: 'Create environment',
      exact: true,
    });
    await create.getByLabel(/^Name/).fill(name);
    await create.getByLabel(/^Destination/).fill(`release:${name}`);
    await create.getByLabel(/^Required approvals/).fill('0');
    const creating = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/v1/repos/${repoId}/environments` &&
        response.request().method() === 'POST',
    );
    await create
      .getByRole('button', { name: 'Create environment', exact: true })
      .click();
    const created = await creating;
    expect(created.status(), await created.text()).toBe(201);
    const id = String((await created.json()).id);
    await page.getByRole('link', { name, exact: true }).click();
    await page
      .getByRole('button', { name: 'Delete environment', exact: true })
      .click();
    const remove = page.getByRole('dialog', {
      name: 'Delete environment',
      exact: true,
    });
    await remove.getByRole('textbox').fill(name);
    const deleting = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/v1/repos/${repoId}/environments/${id}` &&
        response.request().method() === 'DELETE',
    );
    await remove
      .getByRole('button', { name: 'Delete environment', exact: true })
      .click();
    const deleted = await deleting;
    expect(deleted.status(), await deleted.text()).toBe(204);
    const tombstone = await api(
      page,
      `/v1/repos/${repoId}/environments/${id}`,
      { status: 200 },
    );
    expect(tombstone.data).toMatchObject({
      id,
      name,
      state: 'deleted',
      deleted_at: expect.any(String),
    });
    expect(
      items(
        (await api(page, `/v1/repos/${repoId}/environments`)).data.items,
      ).some((environment) => environment.id === id),
    ).toBe(false);
    await expect(
      page.getByText('This environment is deleted.', { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Delete environment', exact: true }),
    ).not.toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Create secret', exact: true }),
    ).not.toBeVisible();
  });

  expect(errors).toEqual([]);
  await recordEvidence(info, {
    repo_id: repoId,
    run_id: runId,
    account_id: fixture.owner.id,
    cancellation_review: cancellationReview,
  });
});
