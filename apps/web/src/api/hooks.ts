import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiPath, request } from "./client.ts";
import { adaptRequest } from "./adapter.ts";
import { query } from "./endpoints.ts";
import type { Page, Snapshot } from "./types.ts";

export function useResource<T>(
  path: string | null,
  options: { poll?: number } = {},
) {
  const [snapshot, setSnapshot] = useState<Snapshot<T> | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  const lastPath = useRef(path);

  useEffect(() => {
    if (!path) {
      setLoading(false);
      setSnapshot(null);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (lastPath.current !== path) setSnapshot(null);
    lastPath.current = path;
    const load = async () => {
      setLoading(true);
      try {
        const next = await request<T>(path, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setSnapshot(next);
          setError(null);
        }
      } catch (cause) {
        if (
          !controller.signal.aborted &&
          cause instanceof ApiError &&
          [401, 403, 404, 410].includes(cause.status)
        )
          setSnapshot(null);
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause
              : new Error("Unable to load this resource."),
          );
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          if (options.poll) timer = setTimeout(load, options.poll);
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [path, version, options.poll]);

  const current = lastPath.current === path ? snapshot : null;
  return {
    data: current?.data ?? null,
    snapshot: current,
    error: lastPath.current === path ? error : null,
    loading: lastPath.current !== path || loading,
    refresh,
    setSnapshot,
  };
}

export function useCollection<T>(
  path: string | null,
  options: { poll?: number } = {},
) {
  const resource = useResource<Page<T>>(path, options);
  const [extra, setExtra] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<Error | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);
  const moreController = useRef<AbortController | null>(null);
  useEffect(() => {
    generation.current += 1;
    moreController.current?.abort();
    setLoadingMore(false);
    setExtra([]);
    setCursor(resource.data?.next_cursor ?? null);
    setMoreError(null);
  }, [path, resource.data]);
  useEffect(() => () => moreController.current?.abort(), []);
  const loadMore = async () => {
    if (!path || !cursor || loadingMore) return;
    const current = generation.current;
    moreController.current = new AbortController();
    setLoadingMore(true);
    try {
      const pinnedRef =
        /\/files(?:\?|$)/.test(path) &&
        typeof resource.data?.commit_oid === "string"
          ? resource.data.commit_oid
          : undefined;
      const next = await request<Page<T>>(
        query(path, { cursor, ...(pinnedRef ? { ref: pinnedRef } : {}) }),
        {
          signal: moreController.current.signal,
        },
      );
      if (current !== generation.current) return;
      setExtra((items) => [...items, ...next.data.items]);
      setCursor(next.data.next_cursor);
      setMoreError(null);
    } catch (cause) {
      if (
        current === generation.current &&
        cause instanceof Error &&
        cause.name !== "AbortError"
      )
        setMoreError(cause);
    } finally {
      if (current === generation.current) setLoadingMore(false);
    }
  };
  return {
    ...resource,
    items: resource.data ? [...(resource.data.items ?? []), ...extra] : [],
    cursor,
    loadingMore,
    loadMore,
    moreError,
  };
}

export function useMutation() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const active = useRef(false);
  const attempt = useRef<{
    signature: string;
    key: string;
    path: string;
    options: NonNullable<Parameters<typeof request>[1]>;
  } | null>(null);
  const run = async <T>(
    path: string,
    options: Parameters<typeof request>[1] = {},
  ): Promise<Snapshot<T> | null> => {
    if (active.current) return null;
    active.current = true;
    setPending(true);
    setError(null);
    try {
      const signature = `${path}:${options.method}:${options.etag || ""}:${JSON.stringify(options.body)}`;
      if (attempt.current?.signature !== signature) {
        const prepared = adaptRequest(
          apiPath(path),
          options.method || "GET",
          options.body,
        );
        attempt.current = {
          signature,
          key: crypto.randomUUID(),
          path: prepared.path,
          options: { ...options, method: prepared.method, body: prepared.body },
        };
      }
      const result = await request<T>(attempt.current.path, {
        ...attempt.current.options,
        idempotencyKey: attempt.current.key,
      });
      attempt.current = null;
      return result;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause : new Error("Unable to save changes."),
      );
      return null;
    } finally {
      active.current = false;
      setPending(false);
    }
  };
  return { run, pending, error, setError, clearError: () => setError(null) };
}
