// Product endpoint names live here so changes to backend contracts have one integration point.
const part = (value: string) => encodeURIComponent(value);
export const endpoints = {
  auth: (action: string) => `/v1/auth/${action.split("/").map(part).join("/")}`,
  me: "/v1/me",
  repos: "/v1/repos",
  repo: (id: string, child = "") =>
    `/v1/repos/${part(id)}${child ? `/${child}` : ""}`,
  item: (repo: string, kind: string, id: string, child = "") =>
    `/v1/repos/${part(repo)}/${part(kind)}/${part(id)}${child ? `/${child}` : ""}`,
  accounts: "/v1/accounts",
  account: (id: string, child = "") =>
    `/v1/accounts/${part(id)}${child ? `/${child}` : ""}`,
  orgs: "/v1/orgs",
  org: (id: string, child = "") =>
    `/v1/orgs/${part(id)}${child ? `/${child}` : ""}`,
  profile: (username: string, child = "") =>
    `/v1/users/${part(username)}${child ? `/${child}` : ""}`,
  feed: "/v1/feed",
  inbox: "/v1/inbox",
  search: "/v1/search",
  scans: "/v1/search/code-scans",
  savedSearches: "/v1/saved-filters",
  tokens: "/v1/tokens",
  sessions: "/v1/auth/sessions",
  operation: (id: string) => `/v1/operations/${part(id)}`,
  billing: (account: string, child = "") =>
    `/v1/accounts/${part(account)}/billing${child ? `/${child}` : ""}`,
};

export function query(path: string, values: Record<string, unknown>): string {
  const [pathname, existing = ""] = path.split("?");
  const params = new URLSearchParams(existing);
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (value === null || value === "") params.delete(name);
    else params.set(name, String(value));
  }
  return `${pathname}${params.size ? `?${params}` : ""}`;
}

export const repoLink = (id: string, child = "") =>
  `/repos/${part(id)}${child ? `/${child}` : ""}`;
