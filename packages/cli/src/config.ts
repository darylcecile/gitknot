import { dirname, join } from 'node:path';
import { z } from 'zod';
import { GitKnotHttpClient, RunnerError, apiOrigin, atomicJson, configDirectory, isFsError, privateDirectory, readJsonFile } from '../../runner/src/index.ts';
import type { SessionUpdate } from '../../runner/src/index.ts';
import { takeLock } from '../../runner/src/files.ts';
import { flag, has, type Arguments } from './args.ts';

const authSchema = z.strictObject({
  version: z.literal(1),
  hosts: z.record(z.string(), z.strictObject({ kind: z.enum(['token', 'session']).default('token'), token: z.string().min(1).max(16_384), cookie_name: z.enum(['__Host-gitknot_session', 'gitknot_session']).optional(), credential_id: z.string().nullable(), expires_at: z.string().nullable(), login: z.string().optional() })),
  git_origins: z.record(z.string(), z.strictObject({ origin: z.string().max(2048), allow_loopback_http: z.boolean() })).optional(),
});
export type AuthConfiguration = z.infer<typeof authSchema>;
export interface GitOriginBinding { origin: string; allow_loopback_http: boolean }
type AuthHost = AuthConfiguration['hosts'][string];

export function authPath(): string { return join(configDirectory(), 'auth.json'); }

export async function loadAuth(path = authPath()): Promise<AuthConfiguration> {
  try {
    const parsed = authSchema.safeParse(await readJsonFile(path, 1_048_576, true));
    if (!parsed.success) throw new RunnerError('auth_config_invalid', 'GitKnot authentication configuration is invalid.');
    await privateDirectory(dirname(path));
    return parsed.data;
  } catch (error) { if (isFsError(error, 'ENOENT')) return { version: 1, hosts: {} }; throw error; }
}

export async function saveAuth(configuration: AuthConfiguration, path = authPath()): Promise<void> {
  await privateDirectory(dirname(path));
  await atomicJson(path, configuration);
}

export async function updateAuthHost(origin: string, update: (current: AuthHost | undefined) => AuthHost | undefined, path = authPath()): Promise<void> {
  const unlock = await takeLock(join(dirname(path), '.auth-update'));
  try {
    const configuration = await loadAuth(path), current = configuration.hosts[origin], next = update(current);
    if (next === current) return;
    if (next) configuration.hosts[origin] = next;
    else delete configuration.hosts[origin];
    await saveAuth(configuration, path);
  } finally { await unlock(); }
}

export async function saveGitOrigin(origin: string, binding: GitOriginBinding): Promise<void> {
  const path = authPath(), unlock = await takeLock(join(dirname(path), '.auth-update'));
  try {
    const configuration = await loadAuth(path), current = configuration.git_origins?.[origin];
    if (current?.origin === binding.origin && current.allow_loopback_http === binding.allow_loopback_http) return;
    (configuration.git_origins ??= {})[origin] = binding;
    await saveAuth(configuration, path);
  } finally { await unlock(); }
}

function persistSession(origin: string, path: string, update: SessionUpdate): Promise<void> {
  return updateAuthHost(origin, current => {
    if ((current?.token ?? null) !== update.previous_value) return current;
    if (!update.session) return undefined;
    const { session, credential } = update;
    const expirations = [session.expires_at, credential?.expires_at].filter((value): value is string => !!value).sort();
    return { kind: 'session', cookie_name: session.name, token: session.value, credential_id: credential?.id ?? null,
      expires_at: expirations[0] ?? null, ...(current?.login ? { login: current.login } : {}) };
  }, path);
}

export function selectedOrigin(args: Arguments): string {
  return apiOrigin(flag(args, 'api-url') ?? process.env.GITKNOT_API_URL ?? 'https://api.gitknot.com', has(args, 'allow-loopback-http') || process.env.GITKNOT_ALLOW_LOOPBACK_HTTP === '1');
}

export async function authentication(args: Arguments, required = true, allowExpired = false): Promise<{ origin: string; token?: string; configuration: AuthConfiguration; session?: { name: '__Host-gitknot_session' | 'gitknot_session'; value: string; app_origin: string } }> {
  const origin = selectedOrigin(args);
  const configuration = await loadAuth();
  const host = configuration.hosts[origin];
  const token = process.env.GITKNOT_TOKEN || host?.token;
  if (required && !token) throw new RunnerError('authentication_required', 'Sign in with gitknot auth login or provide GITKNOT_TOKEN.');
  if (!allowExpired && !process.env.GITKNOT_TOKEN && host?.expires_at && Date.parse(host.expires_at) <= Date.now()) throw new RunnerError('credential_expired', 'Your GitKnot credential expired. Sign in with a current scoped token.');
  if (!process.env.GITKNOT_TOKEN && host?.kind === 'session') {
    return { origin, configuration, session: { name: host.cookie_name ?? '__Host-gitknot_session', value: host.token, app_origin: appOrigin(origin) } };
  }
  return { origin, token, configuration };
}

export function appOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.hostname.startsWith('api.')) url.hostname = url.hostname.slice(4);
  return url.origin;
}

export async function apiClient(args: Arguments, required = true): Promise<GitKnotHttpClient> {
  const path = authPath();
  const auth = await authentication(args, required);
  return new GitKnotHttpClient({ origin: auth.origin, token: auth.token, session: auth.session, allow_loopback_http: has(args, 'allow-loopback-http') || process.env.GITKNOT_ALLOW_LOOPBACK_HTTP === '1',
    on_session_change: process.env.GITKNOT_TOKEN ? undefined : update => persistSession(auth.origin, path, update) });
}

export async function repositoryId(args: Arguments, value: string | undefined): Promise<string | undefined> {
  if (!value?.includes('/')) return value;
  const parts = value.split('/');
  if (parts.length !== 2 || parts.some((part) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(part))) throw new RunnerError('usage', 'Repository names use OWNER/NAME.');
  const response = await (await apiClient(args, false)).request<{ id?: unknown }>('GET', `/v1/repos/resolve/${encodeURIComponent(parts[0]!)}/${encodeURIComponent(parts[1]!)}`);
  if (typeof response.data.id !== 'string' || !/^r_[a-zA-Z0-9_-]+$/.test(response.data.id)) throw new RunnerError('repository_invalid', 'GitKnot did not resolve a stable repository identity.');
  return response.data.id;
}
