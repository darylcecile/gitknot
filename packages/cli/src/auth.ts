import { z } from 'zod';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { GitKnotHttpClient, RunnerError, cleanEnvironment, configDirectory, decodeUtf8, readBounded, responseSessionCookie, runProcess } from '../../runner/src/index.ts';
import { checkFlags, flag, has, type Arguments } from './args.ts';
import { apiClient, appOrigin, authentication, saveGitOrigin, selectedOrigin, updateAuthHost } from './config.ts';
import type { GitOriginBinding } from './config.ts';
import { advertisedGitOrigin, helperGitOrigin, requestedGitOrigin, validatedCloneUrl } from './git-origin.ts';
import { print, readHidden, readStdin, write, type CliIO } from './io.ts';

const credentialSchema = z.object({ id: z.string(), expires_at: z.string().nullable().optional(), principal_id: z.string().optional(), name: z.string().optional(), capabilities: z.array(z.string()).nullable().optional(), repository_ids: z.array(z.string()).nullable().optional(), account_ids: z.array(z.string()).nullable().optional() });

async function tokenLogin(args: Arguments, io: CliIO, signal: AbortSignal): Promise<number> {
  const origin = selectedOrigin(args);
  if (!has(args, 'with-token') && io.stdin.isTTY) await write(io.stderr, `Create a scoped token at ${appOrigin(origin)}/settings/tokens.\n`);
  const token = (await readHidden(io, 'GitKnot token (hidden): ')).trim();
  if (!/^[A-Za-z0-9_-]{16,512}$/.test(token)) throw new RunnerError('credential_invalid', 'Provide a valid GitKnot token through the hidden prompt or standard input.');
  const client = new GitKnotHttpClient({ origin, token, allow_loopback_http: has(args, 'allow-loopback-http') || process.env.GITKNOT_ALLOW_LOOPBACK_HTTP === '1' });
  const response = await client.request('GET', '/v1/tokens/current', { signal });
  const metadata = credentialSchema.safeParse(response.data);
  if (!metadata.success) throw new RunnerError('credential_invalid', 'GitKnot did not recognize this credential.');
  await updateAuthHost(origin, () => ({ kind: 'token', token, credential_id: metadata.data.id, expires_at: metadata.data.expires_at ?? null }));
  await print(io, { authenticated: true, api_origin: origin, credential_id: metadata.data.id, expires_at: metadata.data.expires_at ?? null }, has(args, 'json'));
  return 0;
}

async function passwordLogin(args: Arguments, io: CliIO, signal: AbortSignal): Promise<number> {
  const input = flag(args, 'input');
  let values: unknown;
  if (input) {
    const text = input === '-' ? await readStdin(io, 16_384) : decodeUtf8(await readBounded(resolve(input), 16_384));
    try { values = JSON.parse(text); } catch { throw new RunnerError('json_invalid', 'Authentication input must contain valid JSON.'); }
  } else {
    const login = flag(args, 'username');
    if (!login) throw new RunnerError('usage', '--username is required for password authentication.');
    const password = await readHidden(io, 'GitKnot password (hidden): ', 1024);
    values = { login, password };
  }
  const parsed = z.object({ login: z.string().min(1).max(254), password: z.string().min(1).max(1024), code: z.string().optional(), recovery_code: z.string().optional() }).strict().safeParse(values);
  if (!parsed.success) throw new RunnerError('credential_invalid', 'Authentication input requires login and password, with optional code or recovery_code.');
  const origin = selectedOrigin(args);
  const client = new GitKnotHttpClient({ origin, allow_loopback_http: has(args, 'allow-loopback-http') || process.env.GITKNOT_ALLOW_LOOPBACK_HTTP === '1', redactions: [parsed.data.password, parsed.data.recovery_code ?? '', parsed.data.code ?? ''] });
  let response = await client.request<Record<string, unknown>>('POST', '/v1/auth/login', { body: { login: parsed.data.login, password: parsed.data.password }, signal });
  if (response.data.mfa_required === true) {
    if (typeof response.data.token !== 'string') throw new RunnerError('authentication_invalid', 'GitKnot returned an invalid second-factor challenge.');
    client.addRedactions([response.data.token]);
    let code = parsed.data.code;
    if (!code && !parsed.data.recovery_code) {
      if (!io.stdin.isTTY) throw new RunnerError('mfa_required', 'Provide the current code or a recovery_code in authentication JSON input.');
      code = await readHidden(io, 'Authenticator code (hidden): ', 128);
    }
    response = await client.request('POST', '/v1/auth/login/mfa', { body: { token: response.data.token, ...(code ? { code } : { recovery_code: parsed.data.recovery_code }) }, signal });
  }
  const cookie = responseSessionCookie(response.headers, origin);
  const session = z.object({ id: z.string(), expires_at: z.string() }).safeParse(response.data.session);
  if (!cookie || !session.success) throw new RunnerError('authentication_invalid', 'GitKnot did not return an authenticated session.');
  await updateAuthHost(origin, () => ({ kind: 'session', token: cookie.value, cookie_name: cookie.name, credential_id: session.data.id, expires_at: session.data.expires_at, login: parsed.data.login }));
  await print(io, { authenticated: true, api_origin: origin, kind: 'session', credential_id: session.data.id, expires_at: session.data.expires_at }, has(args, 'json'));
  return 0;
}

async function credentialHelper(args: Arguments, io: CliIO, signal: AbortSignal): Promise<number> {
  const action = args.words[2];
  if (!['get', 'store', 'erase'].includes(action ?? '')) throw new RunnerError('usage', 'Git credential helper expects get, store, or erase.');
  const input = await readStdin(io, 65_536);
  if (action !== 'get') return 0;
  const requested = requestedGitOrigin(input);
  if (!requested) return 0;
  const auth = await authentication(args, false);
  if (!auth.token || !/^[A-Za-z0-9_-]{16,512}$/.test(auth.token)) return 0;
  const saved = auth.configuration.git_origins?.[auth.origin], expected = helperGitOrigin(args, auth.origin, saved);
  if ((saved || flag(args, 'git-url')) && requested !== expected) return 0;
  const current = await advertisedGitOrigin(args, auth.origin, signal);
  if (requested !== current.origin || expected !== null && current.origin !== expected) return 0;
  if (!saved) await saveGitOrigin(auth.origin, current);
  await write(io.stdout, `username=gitknot\npassword=${auth.token}\n\n`);
  return 0;
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export function gitCredentialHelperCommand(origin: string, binding: GitOriginBinding): string {
  let entry = resolve(process.argv[1]!);
  if (entry.endsWith('.ts')) {
    entry = resolve(dirname(entry), '../dist/cli/src/index.js');
    if (!existsSync(entry)) throw new RunnerError('cli_build_required', 'Build the compiled GitKnot CLI before installing or using its Git credential helper.');
  }
  return `!GITKNOT_CONFIG_DIR=${shellQuote(configDirectory())} ${shellQuote(process.execPath)} ${shellQuote(entry)} auth git-credential --api-url ${shellQuote(origin)} --git-url ${shellQuote(binding.origin)}${binding.allow_loopback_http ? ' --allow-loopback-http' : ''}`;
}

export async function authCommand(args: Arguments, io: CliIO, signal: AbortSignal): Promise<number> {
  const command = args.words[1];
  if (command === 'git-credential') { checkFlags(args, ['git-url']); return credentialHelper(args, io, signal); }
  if (args.words.length > 2) throw new RunnerError('usage', 'Too many positional arguments for auth.');
  if (command === 'login') {
    checkFlags(args, ['with-token', 'username', 'password-stdin', 'input']);
    if (has(args, 'with-token') && (has(args, 'username') || has(args, 'password-stdin') || has(args, 'input'))) throw new RunnerError('usage', 'Select token or password authentication, not both.');
    return has(args, 'username') || has(args, 'password-stdin') || has(args, 'input') ? passwordLogin(args, io, signal) : tokenLogin(args, io, signal);
  }
  if (command === 'status') {
    checkFlags(args, []);
    const auth = await authentication(args);
    const client = await apiClient(args);
    const response = await client.request('GET', '/v1/tokens/current', { signal });
    const metadata = credentialSchema.safeParse(response.data);
    if (!metadata.success) throw new RunnerError('credential_invalid', 'GitKnot did not return credential metadata.');
    await print(io, { authenticated: true, api_origin: auth.origin, kind: auth.session ? 'session' : 'token', ...metadata.data }, has(args, 'json'));
    return 0;
  }
  if (command === 'logout') {
    checkFlags(args, ['local-only']);
    const auth = await authentication(args, false, true);
    const expires = auth.configuration.hosts[auth.origin]?.expires_at;
    const expired = !process.env.GITKNOT_TOKEN && !!expires && Date.parse(expires) <= Date.now();
    let error: unknown;
    if (!expired && !has(args, 'local-only') && (auth.token || auth.session)) {
      try { await (await apiClient(args)).request('POST', '/v1/auth/logout', { signal }); } catch (caught) { error = caught; }
    }
    await updateAuthHost(auth.origin, current => current?.token === auth.configuration.hosts[auth.origin]?.token ? undefined : current);
    if (error) throw new RunnerError('logout_incomplete', 'Local credentials were removed; remote revocation could not be confirmed. Revoke the credential in GitKnot account settings.');
    await print(io, { authenticated: false, api_origin: auth.origin, remote_revoked: !expired && !has(args, 'local-only') && !!(auth.token || auth.session), expired }, has(args, 'json'));
    return 0;
  }
  if (command === 'setup-git') {
    checkFlags(args, []);
    const auth = await authentication(args);
    if (!auth.token) throw new RunnerError('git_token_required', 'Sign in with a scoped token to use HTTPS Git credential integration.');
    const binding = await advertisedGitOrigin(args, auth.origin, signal);
    await saveGitOrigin(auth.origin, binding);
    for (const [key, value] of [[`http.${binding.origin}.followRedirects`, 'false'], [`credential.${binding.origin}.helper`, gitCredentialHelperCommand(auth.origin, binding)]]) {
      const result = await runProcess('git', ['config', '--global', '--replace-all', key!, value!], { cwd: process.cwd(), env: { ...process.env, GITKNOT_TOKEN: undefined }, timeout_ms: 30_000, signal, secrets: [auth.token], onLog: async (bytes) => write(io.stderr, bytes) });
      if (result.exit_code !== 0) throw new RunnerError('git_setup_failed', 'Git credential-helper configuration failed.');
    }
    await print(io, { configured: true, git_origin: binding.origin }, has(args, 'json'));
    return 0;
  }
  throw new RunnerError('usage', 'Use auth login, status, logout, or setup-git.');
}

export async function cloneRepository(args: Arguments, io: CliIO, signal: AbortSignal): Promise<number> {
  checkFlags(args, []);
  if (args.words.length < 3 || args.words.length > 4) throw new RunnerError('usage', 'Use gitknot repo clone OWNER/NAME [DIRECTORY].');
  const auth = await authentication(args, false);
  const name = args.words[2]!.replace(/\.git$/, '');
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(name) || name.split('/').some((part) => part === '.' || part === '..')) throw new RunnerError('usage', 'Use an OWNER/NAME repository name.');
  const binding = await advertisedGitOrigin(args, auth.origin, signal);
  const [owner, repository] = name.split('/');
  const resolved = await (await apiClient(args, false)).request<{ clone_url?: unknown }>('GET', `/v1/repos/resolve/${encodeURIComponent(owner!)}/${encodeURIComponent(repository!)}`, { signal, retryable: true });
  const remote = validatedCloneUrl(resolved.data.clone_url, binding.origin);
  await saveGitOrigin(auth.origin, binding);
  const destination = args.words[3] ?? name.split('/')[1]!.replace(/\.git$/, '');
  const env = { ...cleanEnvironment(homedir()), GITKNOT_API_URL: auth.origin, GITKNOT_CONFIG_DIR: configDirectory(),
    ...(binding.allow_loopback_http ? { GITKNOT_ALLOW_LOOPBACK_HTTP: '1' } : {}), ...(process.env.GITKNOT_TOKEN ? { GITKNOT_TOKEN: process.env.GITKNOT_TOKEN } : {}) };
  const result = await runProcess('git', ['-c', 'credential.helper=', '-c', `credential.helper=${gitCredentialHelperCommand(auth.origin, binding)}`, '-c', 'http.followRedirects=false', 'clone', '--', remote, destination], { cwd: process.cwd(), env, signal, timeout_ms: 600_000, secrets: auth.token ? [auth.token] : [], onLog: async (bytes) => write(io.stderr, bytes) });
  if (result.exit_code !== 0) throw new RunnerError('clone_failed', 'Git could not clone this GitKnot repository.');
  await print(io, { cloned: true, path: resolve(destination), remote }, has(args, 'json'));
  return 0;
}
