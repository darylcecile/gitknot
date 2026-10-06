import { z } from 'zod';
import { apiOrigin, RunnerError } from '../../runner/src/index.ts';
import { flag, has } from './args.ts';
import type { Arguments } from './args.ts';
import { apiClient } from './config.ts';
import type { GitOriginBinding } from './config.ts';

const metadataSchema = z.object({ product: z.literal('GitKnot'), api_origin: z.string(), git_origin: z.string() });
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

export function loopbackOptIn(args: Arguments): boolean {
  return has(args, 'allow-loopback-http') || process.env.GITKNOT_ALLOW_LOOPBACK_HTTP === '1';
}

export function validatedGitOrigin(value: string, api: string, allowLoopback: boolean): string {
  try {
    const origin = apiOrigin(value, allowLoopback && loopbackHosts.has(new URL(api).hostname));
    if (new URL(origin).protocol === 'http:' && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?\/?$/i.test(value)) throw new Error('nonliteral loopback');
    return origin;
  } catch { throw new RunnerError('git_origin_invalid', 'GitKnot must advertise a Git HTTPS origin, or an explicitly allowed literal-loopback HTTP origin for a local API.'); }
}

/** The selected API supplies the Git endpoint; neither hostname nor port is inferred. */
export async function advertisedGitOrigin(args: Arguments, api: string, signal?: AbortSignal): Promise<GitOriginBinding> {
  const client = await apiClient(args, false), response = await client.request('GET', '/v1/meta', { signal, retryable: true });
  const parsed = metadataSchema.safeParse(response.data), allowed = loopbackOptIn(args);
  if (!parsed.success || apiOrigin(parsed.data.api_origin, allowed) !== api || client.origin !== api) throw new RunnerError('git_origin_invalid', 'GitKnot did not advertise metadata for the selected API origin.');
  const origin = validatedGitOrigin(parsed.data.git_origin, api, allowed);
  return { origin, allow_loopback_http: allowed && loopbackHosts.has(new URL(api).hostname)
    && (new URL(api).protocol === 'http:' || new URL(origin).protocol === 'http:') };
}

/** Git's stdin is untrusted; duplicate or URL-shaped host fields never select credentials. */
export function requestedGitOrigin(input: string): string | null {
  const fields = new Map<string, string>();
  for (const line of input.split(/\r?\n/)) {
    if (!line) break;
    const separator = line.indexOf('=');
    if (separator < 1) return null;
    const name = line.slice(0, separator);
    if (name !== 'protocol' && name !== 'host') continue;
    if (fields.has(name)) return null;
    fields.set(name, line.slice(separator + 1));
  }
  const protocol = fields.get('protocol'), host = fields.get('host');
  if (!['https', 'http'].includes(protocol ?? '') || !host || /[\x00-\x20\x7f\/@?#\\]/.test(host)) return null;
  if (protocol === 'http' && !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/i.test(host)) return null;
  try { return new URL(`${protocol}://${host}`).origin; } catch { return null; }
}

export function helperGitOrigin(args: Arguments, api: string, binding?: GitOriginBinding): string | null {
  const specified = flag(args, 'git-url');
  const saved = binding ? validatedGitOrigin(binding.origin, api, loopbackOptIn(args) && binding.allow_loopback_http) : null;
  const expected = specified ? validatedGitOrigin(specified, api, loopbackOptIn(args)) : saved;
  return saved && expected !== saved ? null : expected;
}

export function validatedCloneUrl(value: unknown, origin: string): string {
  if (typeof value !== 'string') throw new RunnerError('repository_invalid', 'GitKnot did not return the repository clone URL.');
  try {
    const url = new URL(value);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('.git')) throw new Error();
    return url.href;
  } catch { throw new RunnerError('git_origin_invalid', 'The repository clone URL does not belong to the API’s advertised Git origin.'); }
}
