const encoder = new TextEncoder();

export function endpointURL(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.hash) {
    throw new Error('endpoint_not_allowed');
  }
  if (value.length > 2048 || !host.includes('.') || host.includes(':') || /^[\d.]+$/.test(host)
    || /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(host)
    || host === 'gitknot.com' || host.endsWith('.gitknot.com')) {
    throw new Error('endpoint_not_allowed');
  }
  url.hostname = host;
  return url;
}

function ipv4Number(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((acc, part) => (acc * 256) + Number(part), 0);
}

const deniedV4: readonly [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
];

/** Conservative global-unicast allowlist. IPv4-mapped/translated and tunnel IPv6 are rejected. */
export function isPublicAddress(address: string): boolean {
  const v4 = ipv4Number(address);
  if (v4 !== null) {
    return !deniedV4.some(([start, bits]) => Math.floor(v4 / 2 ** (32 - bits)) === Math.floor(ipv4Number(start)! / 2 ** (32 - bits)));
  }
  if (address.includes('.') || address.includes('%') || !/^[\da-f:]+$/i.test(address)) return false;
  const pieces = address.toLowerCase().split('::');
  if (pieces.length > 2) return false;
  const left = pieces[0] ? pieces[0].split(':') : [];
  const right = pieces[1] ? pieces[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (pieces.length === 1 && missing !== 0) || (pieces.length === 2 && missing < 1)) return false;
  const groups = [...left, ...Array<string>(missing).fill('0'), ...right];
  if (groups.some((group) => !/^[\da-f]{1,4}$/.test(group))) return false;
  const a = Number.parseInt(groups[0]!, 16);
  const b = Number.parseInt(groups[1]!, 16);
  if ((a & 0xe000) !== 0x2000) return false;
  if (a === 0x2001 && (b < 0x0200 || b === 0x0db8)) return false;
  if (a === 0x2002 || (a === 0x3fff && b < 0x1000)) return false;
  return true;
}

export async function standardSignature(secret: string, eventId: string, timestamp: number, body: string): Promise<string> {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret) || !/^[A-Za-z0-9_:-]+$/.test(eventId)
    || !Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('invalid_signing_input');
  const bytes = Uint8Array.from(atob(secret.slice(6)), (character) => character.charCodeAt(0));
  if (bytes.byteLength < 24 || bytes.byteLength > 64) throw new Error('invalid_signing_key');
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${eventId}.${timestamp}.${body}`)));
  return `v1,${btoa(String.fromCharCode(...signature))}`;
}

export async function readBounded(response: Response, maximum: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('response_too_large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export function retryAt(attempt: number, started: string, retryAfter?: string | null, clock = Date.now()): string | null {
  const delays = [5, 300, 1800, 7200, 18000, 36000, 50400, 72000, 86400];
  const delay = delays[attempt - 1];
  if (delay === undefined || clock - Date.parse(started) >= 7 * 86400_000) return null;
  const requested = retryAfter && /^\d+$/.test(retryAfter) ? clock + Number(retryAfter) * 1000 : Date.parse(retryAfter ?? '');
  const jitter = Math.floor(delay * 1000 * (0.9 + Math.random() * 0.2));
  return new Date(Math.min(clock + 86400_000, Math.max(clock + jitter, Number.isFinite(requested) ? requested : 0))).toISOString();
}
