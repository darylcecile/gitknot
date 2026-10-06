import {
  array,
  record,
  text,
  type Entity,
  type Page,
  type Snapshot,
} from "./types.ts";
import { adaptRequest, adaptResponse, preconditionPath } from "./adapter.ts";
import { resolveApiOrigin, resolveApiPath, resolveApiUrl } from "./origin.ts";

export function apiOrigin() {
  return resolveApiOrigin(
    window.location.origin,
    import.meta.env.VITE_API_ORIGIN,
  );
}
export function apiPath(input: string) {
  return resolveApiPath(
    input,
    window.location.origin,
    import.meta.env.VITE_API_ORIGIN,
  );
}
let csrfToken: string | null = null;
let viewerGrant: { repoId: string; token: string } | null = null;
export function setViewerGrant(
  value: { repoId: string; token: string } | null,
) {
  viewerGrant = value;
}
export function activeViewerRepository() {
  return viewerGrant?.repoId || null;
}
export function readHeaders(path: string): Headers {
  const headers = new Headers();
  if (viewerGrant && !/^\/v1\/(auth(?:\/|$)|me(?:\/|$))/.test(path))
    headers.set("Authorization", `Bearer ${viewerGrant.token}`);
  return headers;
}
const operationRevisions = new Map<string, string>();

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly details: unknown;
  readonly retryAfter: string | null;

  constructor(status: number, body: unknown, headers = new Headers()) {
    const error = record(record(body).error);
    super(
      text(
        error.message,
        status === 0
          ? "Unable to connect. Check your connection and try again."
          : `Request failed (${status}).`,
      ),
    );
    this.name = "ApiError";
    this.status = status;
    this.code = text(error.code, "request_failed");
    this.requestId =
      text(error.request_id) ||
      headers.get("X-GitKnot-Request-ID") ||
      headers.get("X-Request-ID");
    this.details = error.details;
    this.retryAfter = headers.get("Retry-After");
  }

  get conflict() {
    return (
      this.status === 412 ||
      (this.status === 409 && /revision|stale_|concurrent/.test(this.code))
    );
  }
}

export function setCsrfToken(value: unknown) {
  csrfToken = typeof value === "string" ? value : null;
}

export function apiUrl(path: string): string {
  const normalized = apiPath(path);
  return resolveApiUrl(
    adaptRequest(normalized, "GET", undefined).path,
    window.location.origin,
    import.meta.env.VITE_API_ORIGIN,
  );
}

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  etag?: string | null;
  idempotencyKey?: string;
  signal?: AbortSignal;
  headers?: HeadersInit;
  nativeTree?: boolean;
};

export async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<Snapshot<T>> {
  path = apiPath(path);
  const requested = new URL(path, "https://gitknot.invalid");
  if (
    requested.pathname === "/v1/subscriptions/current" &&
    (!options.method || options.method === "GET")
  ) {
    const subscription = await findCollectionItem(
      "/v1/subscriptions",
      (item) =>
        item.repo_id === requested.searchParams.get("repo_id") &&
        (item.item_id || null) ===
          (requested.searchParams.get("item_id") || null),
      options,
    );
    return { data: { subscription } as T, etag: null, requestId: null };
  }
  const following = /^\/v1\/users\/([^/]+)\/following-user\/([^/]+)$/.exec(
    requested.pathname,
  );
  if (following && (!options.method || options.method === "GET")) {
    const relationship = await findCollectionItem(
      `/v1/users/${following[1]}/following`,
      (item) => item.following_id === decodeURIComponent(following[2]!),
      options,
    );
    return { data: { relationship } as T, etag: null, requestId: null };
  }
  const files = /^(\/v1\/repos\/[^/]+)\/files$/.exec(requested.pathname);
  if (
    files &&
    (!options.method || options.method === "GET") &&
    !options.nativeTree
  )
    return browseGit<T>(files[1]!, requested.searchParams, options);
  if (
    requested.pathname === "/v1/accounts" &&
    (!options.method || options.method === "GET")
  ) {
    const [organizations, profile] = await Promise.all([
      request<{ items: unknown[]; next_cursor: string | null }>(
        `/v1/orgs${requested.search}`,
        options,
      ),
      requested.searchParams.has("cursor")
        ? Promise.resolve(null)
        : request<Record<string, unknown>>("/v1/me", options),
    ]);
    const personal: unknown[] = [];
    if (profile) {
      try {
        personal.push(
          (
            await request(
              `/v1/accounts/${encodeURIComponent(text(profile.data.id))}`,
              options,
            )
          ).data,
        );
      } catch (error) {
        if (!(error instanceof ApiError) || ![403, 404].includes(error.status))
          throw error;
      }
    }
    return {
      ...organizations,
      data: {
        ...organizations.data,
        items: [...personal, ...organizations.data.items],
      } as T,
    };
  }
  const profileRepos = /^\/v1\/users\/([^/]+)\/repos$/.exec(requested.pathname);
  if (profileRepos && (!options.method || options.method === "GET")) {
    const profile = await request<{ id: string }>(
      `/v1/users/${profileRepos[1]}`,
      options,
    );
    requested.searchParams.set("owner_id", profile.data.id);
    return request<T>(`/v1/repos?${requested.searchParams}`, options);
  }
  const adapted = adaptRequest(path, options.method || "GET", options.body);
  path = adapted.path;
  const method = adapted.method;
  options = { ...options, body: adapted.body };
  const headers = readHeaders(path);
  new Headers(options.headers).forEach((value, key) => headers.set(key, value));
  headers.set("Accept", "application/json");
  if (method !== "GET") headers.set("X-GitKnot-CSRF", "1");
  if (csrfToken && method !== "GET") headers.set("X-CSRF-Token", csrfToken);
  const parent = preconditionPath(path, method);
  if (
    method === "POST" &&
    /\/repos\/[^/]+\/files$/.test(path) &&
    typeof record(options.body).expected_oid === "string"
  )
    options.etag = JSON.stringify(record(options.body).expected_oid);
  if (!options.etag && parent) {
    const saved = options.idempotencyKey
      ? operationRevisions.get(options.idempotencyKey)
      : null;
    options.etag =
      saved || requireEtag(await request(parent, { signal: options.signal }));
    if (options.idempotencyKey)
      operationRevisions.set(options.idempotencyKey, options.etag);
  }
  if (options.etag) {
    if (options.etag.startsWith("W/"))
      throw new Error("A strong resource ETag is required to save changes.");
    headers.set("If-Match", options.etag);
  }
  if (method !== "GET")
    headers.set(
      "Idempotency-Key",
      options.idempotencyKey || crypto.randomUUID(),
    );
  const body =
    options.body instanceof FormData || options.body instanceof Blob
      ? options.body
      : options.body === undefined
        ? undefined
        : JSON.stringify(options.body);
  if (body !== undefined && typeof body === "string")
    headers.set("Content-Type", "application/json");
  let response: Response;
  const url = apiUrl(path);
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: options.signal,
      credentials: "include",
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new ApiError(0, null);
  }
  const content = await response.text();
  let data: unknown = null;
  if (content) {
    try {
      data =
        response.ok &&
        !response.headers.get("Content-Type")?.includes("json") &&
        /\/(diff|diffs)(?:\?|$)/.test(path)
          ? { diff: content }
          : JSON.parse(content);
    } catch {
      throw new ApiError(
        response.ok ? 502 : response.status,
        {
          error: {
            message:
              "The service returned an unreadable response. Please retry.",
            code: "invalid_response",
          },
        },
        response.headers,
      );
    }
  }
  if (!response.ok) throw new ApiError(response.status, data, response.headers);
  if (options.idempotencyKey) operationRevisions.delete(options.idempotencyKey);
  const nextCsrf =
    response.headers.get("X-CSRF-Token") ||
    record(data).csrf_token ||
    record(record(data).session).csrf_token;
  if (typeof nextCsrf === "string") setCsrfToken(nextCsrf);
  return {
    data: adaptResponse(data, `${requested.pathname}${requested.search}`) as T,
    etag: response.headers.get("ETag"),
    requestId:
      response.headers.get("X-GitKnot-Request-ID") ||
      response.headers.get("X-Request-ID"),
  };
}

export async function download(path: string, name: string) {
  path = adaptRequest(apiPath(path), "GET", undefined).path;
  const logs = new URL(path, "https://gitknot.invalid");
  if (/^\/v1\/runs\/[^/]+\/logs\/download$/.test(logs.pathname)) {
    logs.pathname = logs.pathname.replace(/\/download$/, "");
    const chunks = new Map<string, Entity>();
    let cursor: string | null = null;
    do {
      if (cursor) logs.searchParams.set("cursor", cursor);
      const page = await request<Page<Entity>>(
        `${logs.pathname}${logs.search}`,
      );
      for (const item of page.data.items) chunks.set(item.id, item);
      cursor = page.data.next_cursor;
    } while (cursor);
    saveBlob(
      new Blob(
        [...chunks.values()]
          .sort((a, b) => Number(a.sequence) - Number(b.sequence))
          .map((item) => text(item.text)),
        { type: "text/plain" },
      ),
      name,
    );
    return;
  }
  const response = await fetch(apiUrl(path), {
    headers: readHeaders(path),
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) {
    let error: unknown;
    try {
      error = await response.json();
    } catch {
      error = null;
    }
    throw new ApiError(response.status, error, response.headers);
  }
  const blob = await response.blob();
  saveBlob(blob, name);
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name.replace(/[\\/]/g, "-");
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function revisionSnapshot<T extends { revision?: number }>(
  data: T,
): Snapshot<T> {
  return {
    data,
    etag:
      typeof data.revision === "number"
        ? JSON.stringify(String(data.revision))
        : null,
    requestId: null,
  };
}

async function browseGit<T>(
  base: string,
  params: URLSearchParams,
  options: RequestOptions,
): Promise<Snapshot<T>> {
  const ref = params.get("ref") || "HEAD";
  let commit = ref;
  if (!/^[a-f0-9]{40,64}$/.test(ref)) {
    try {
      const history = await request<Page<Entity>>(
        `${base}/commits?ref=${encodeURIComponent(ref)}&limit=1`,
        options,
      );
      commit = text(history.data.revision || history.data.items[0]?.oid);
    } catch (error) {
      if (
        !params.get("path") &&
        error instanceof ApiError &&
        error.status === 404
      ) {
        const refs = await request<Page<Entity>>(
          `${base}/refs?limit=1`,
          options,
        );
        if (!refs.data.items.length)
          return {
            ...refs,
            data: { items: [], next_cursor: null, empty_repository: true } as T,
          };
      }
      throw error;
    }
  }
  const pinned = new URLSearchParams(params);
  pinned.set("ref", commit);
  try {
    const tree = await request<Entity>(`${base}/files?${pinned}`, {
      ...options,
      nativeTree: true,
    });
    return { ...tree, data: { ...tree.data, commit_oid: commit } as T };
  } catch (error) {
    if (
      !(error instanceof ApiError) ||
      error.code !== "tree_not_found" ||
      !params.get("path")
    )
      throw error;
  }
  const response = await fetch(apiUrl(`${base}/raw?${pinned}`), {
    headers: readHeaders(`${base}/raw`),
    credentials: "include",
    signal: options.signal,
    cache: "no-store",
  });
  if (!response.ok) {
    let error: unknown = null;
    try {
      error = await response.json();
    } catch {
      /* Non-JSON download failures retain their HTTP status. */
    }
    throw new ApiError(response.status, error, response.headers);
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new ApiError(502, {
      error: { message: "The file stream was empty." },
    });
  const chunks: Uint8Array[] = [];
  let size = 0;
  let large = false;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > 2 * 1024 * 1024) {
      large = true;
      await reader.cancel();
      break;
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(large ? 0 : size);
  let offset = 0;
  for (const chunk of large ? [] : chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let content = "";
  let binary = large || bytes.includes(0);
  if (!binary) {
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      binary = true;
    }
  }
  const etag = response.headers.get("ETag");
  const oid = etag?.replace(/^"|"$/g, "") || "";
  return {
    data: {
      id: oid,
      oid,
      type: "blob",
      path: params.get("path"),
      content,
      binary,
      too_large: large,
      ...(large ? {} : { size }),
      commit_oid: commit,
    } as T,
    etag,
    requestId: response.headers.get("X-GitKnot-Request-ID"),
  };
}

async function findCollectionItem(
  path: string,
  predicate: (item: Entity) => boolean,
  options: RequestOptions,
): Promise<Entity | null> {
  let cursor: string | null = null;
  do {
    const page: Snapshot<Page<Entity>> = await request<Page<Entity>>(
      `${path}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      options,
    );
    const item = page.data.items.find(predicate);
    if (item) return item;
    cursor = page.data.next_cursor;
  } while (cursor);
  return null;
}

export function requireEtag(snapshot: Snapshot<unknown>): string {
  if (!snapshot.etag || snapshot.etag.startsWith("W/")) {
    throw new Error(
      "The server did not provide a strong revision ETag. Refresh this resource before saving.",
    );
  }
  return snapshot.etag;
}
