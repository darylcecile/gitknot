import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import type { GitRemote } from '../../../packages/git/src/types.ts';
import { requireValue } from '../../../packages/git/src/errors.ts';

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b))
      || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  // Global unicast only; mapped IPv4 and special/documentation ranges are excluded.
  return isIP(address) === 6 && /^[23][a-f0-9]{0,3}:/iu.test(address)
    && !/^2001:(?:db8|0|10|20):/iu.test(address) && !address.includes('.');
}

export async function remoteConfiguration(remote: GitRemote, development: boolean, localRoot?: string): Promise<Record<string, string>> {
  requireValue(!remote.authorization || !/[\r\n\x00]/u.test(remote.authorization), 'invalid_remote', 'Invalid source authentication.');
  if (remote.authority === 'local') {
    requireValue(development && localRoot, 'local_authority_disabled', 'Local Git authority is disabled.', 503);
    const path = remote.url.startsWith('file:') ? fileURLToPath(remote.url) : remote.url;
    const [root, target] = await Promise.all([realpath(localRoot), realpath(resolve(path))]);
    requireValue(target.startsWith(`${root}${sep}`), 'invalid_remote', 'Local repository is outside the development authority.');
    return {};
  }
  const url = new URL(remote.url);
  const loopbackTest = development && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  requireValue(url.protocol === 'https:' && (loopbackTest || !url.port || url.port === '443') && !url.username && !url.password && !url.hash && !url.search,
    'invalid_remote', 'Git sources must be credential-free HTTPS repository URLs.');
  if (loopbackTest) return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${url.href}.extraHeader`, GIT_CONFIG_VALUE_0: remote.authorization ? `Authorization: ${remote.authorization}` : '' };
  requireValue(!isIP(url.hostname) && !url.hostname.endsWith('.local') && url.hostname.includes('.'), 'invalid_remote', 'This Git source is not a public HTTPS host.');
  // With the managed interceptor, DNS deliberately resolves to proxy placeholder IPs.
  // The trusted Worker enforces destination/byte policy and performs the real fetch.
  if (process.env.GIT_EGRESS_INTERCEPTED === '1') return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${url.href}.extraHeader`,
    GIT_CONFIG_VALUE_0: remote.authorization ? `Authorization: ${remote.authorization}` : '' };
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  requireValue(addresses.length > 0 && addresses.every(result => publicAddress(result.address)), 'invalid_remote', 'This Git source is not a public HTTPS host.');
  const keys: Array<[string, string]> = [
    [`http.${url.href}.extraHeader`, remote.authorization ? `Authorization: ${remote.authorization}` : ''],
    ['http.curloptResolve', `${url.hostname}:443:${addresses[0].family === 6 ? `[${addresses[0].address}]` : addresses[0].address}`],
  ];
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(keys.length) };
  keys.forEach(([key, value], index) => { env[`GIT_CONFIG_KEY_${index}`] = key; env[`GIT_CONFIG_VALUE_${index}`] = value; });
  return env;
}
