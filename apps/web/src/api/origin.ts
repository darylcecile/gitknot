const publicApiOrigins = new Map([
  ["gitknot.com", "https://api.gitknot.com"],
  ["www.gitknot.com", "https://api.gitknot.com"],
  ["api.gitknot.com", "https://api.gitknot.com"],
  ["staging.gitknot.com", "https://api.staging.gitknot.com"],
  ["api.staging.gitknot.com", "https://api.staging.gitknot.com"],
]);
const canonicalApis = new Set([
  "https://api.gitknot.com",
  "https://api.staging.gitknot.com",
]);

function localHostname(hostname: string) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function configuredApi(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("VITE_API_ORIGIN must be an absolute API origin.");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "VITE_API_ORIGIN must contain only an origin, without credentials, a path, or query parameters.",
    );
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && localHostname(url.hostname))
  )
    throw new Error(
      "The API origin must use HTTPS; HTTP is supported only for local development.",
    );
  return url.origin;
}

/** Host-based defaults keep one artifact correct in production, staging, and local previews. */
export function resolveApiOrigin(
  appOrigin: string,
  configured?: string,
): string {
  const app = new URL(appOrigin);
  const expected = publicApiOrigins.get(app.hostname);
  const override = configured?.trim() ? configuredApi(configured.trim()) : null;
  if (expected) {
    if (override && override !== expected)
      throw new Error(
        `This GitKnot environment must use ${expected} for authentication and API requests.`,
      );
    return expected;
  }
  if (override) return override;
  if (localHostname(app.hostname)) return "";
  throw new Error("Configure VITE_API_ORIGIN for this application hostname.");
}

/** Rebase GitKnot-generated absolute URLs onto the same API that owns the session cookie. */
export function resolveApiPath(
  input: string,
  appOrigin: string,
  configured?: string,
): string {
  const apiOrigin = resolveApiOrigin(appOrigin, configured);
  const app = new URL(appOrigin).origin;
  let url: URL;
  try {
    url = new URL(input, apiOrigin || app);
  } catch {
    throw new Error("This API URL is invalid.");
  }
  const allowed = new Set([...canonicalApis, app, apiOrigin || app]);
  if (
    localHostname(new URL(app).hostname) &&
    localHostname(url.hostname) &&
    url.protocol === new URL(app).protocol
  )
    allowed.add(url.origin);
  if (!allowed.has(url.origin) || url.username || url.password)
    throw new Error("API requests must target the configured GitKnot API.");
  if (!url.pathname.startsWith("/v1/") && url.pathname !== "/openapi.json")
    throw new Error("This is not a GitKnot API resource.");
  return `${url.pathname}${url.search}`;
}

export function resolveApiUrl(
  input: string,
  appOrigin: string,
  configured?: string,
): string {
  return `${resolveApiOrigin(appOrigin, configured)}${resolveApiPath(input, appOrigin, configured)}`;
}
