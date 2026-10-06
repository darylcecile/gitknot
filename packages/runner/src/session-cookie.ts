export type SessionCookieName = '__Host-gitknot_session' | 'gitknot_session';
export interface SessionCookie { name: SessionCookieName; value: string; expires_at: string | null }
export interface SessionUpdate {
  previous_value: string | null;
  session: SessionCookie | null;
  credential?: { id: string; expires_at: string };
}

export function sessionCookieName(origin: string): SessionCookieName {
  return new URL(origin).protocol === 'https:' ? '__Host-gitknot_session' : 'gitknot_session';
}

function attributes(parts: string[]): Map<string, string | null> | null {
  const result = new Map<string, string | null>();
  for (const part of parts) {
    if (!part.trim()) continue;
    const separator = part.indexOf('='), name = (separator < 0 ? part : part.slice(0, separator)).trim().toLowerCase();
    if (!/^[a-z][a-z-]*$/.test(name) || result.has(name)) return null;
    result.set(name, separator < 0 ? null : part.slice(separator + 1).trim());
  }
  return result;
}

function expiration(values: Map<string, string | null>, clock: number): number | null {
  if (values.has('max-age')) {
    const raw = values.get('max-age');
    if (raw === null || raw === undefined || !/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) return NaN;
    const age = Number(raw);
    return age <= 0 ? 0 : new Date(clock + age * 1000).getTime();
  }
  return values.has('expires') ? Date.parse(values.get('expires') ?? '') : null;
}

/** A host-only, root-path GitKnot cookie, never a general-purpose cookie jar. */
export function responseSessionCookie(headers: Headers, origin: string): SessionCookie | null | undefined {
  const name = sessionCookieName(origin), secure = new URL(origin).protocol === 'https:', clock = Date.now();
  let result: SessionCookie | null | undefined;
  for (const header of headers.getSetCookie()) {
    if (header.length > 8192 || /[\x00-\x1f\x7f]/.test(header)) continue;
    const [pair, ...parts] = header.split(';'), separator = pair!.indexOf('=');
    if (separator < 0 || pair!.slice(0, separator).trim() !== name) continue;
    const value = pair!.slice(separator + 1).trim(), flags = attributes(parts);
    if (!flags || flags.has('domain') || flags.has('partitioned') || flags.get('path') !== '/' || flags.get('httponly') !== null
      || (secure ? flags.get('secure') !== null : flags.has('secure'))) continue;
    const expires = expiration(flags, clock);
    if (expires !== null && !Number.isFinite(expires)) continue;
    if (value !== '' && !/^gks_[A-Za-z0-9_-]{43}$/.test(value)) continue;
    if (expires !== null && expires <= clock) result = null;
    else if (value) result = { name, value, expires_at: expires === null ? null : new Date(expires).toISOString() };
  }
  return result;
}
