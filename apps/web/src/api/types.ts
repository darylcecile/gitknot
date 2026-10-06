export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type Entity = { id: string; revision?: number; [key: string]: unknown };
export type Page<T> = {
  items: T[];
  next_cursor: string | null;
  [key: string]: unknown;
};
export type Snapshot<T> = {
  data: T;
  etag: string | null;
  requestId: string | null;
};
export type User = Entity & {
  username: string;
  display_name: string;
  email?: string;
  bio?: string;
  avatar_url?: string;
  email_verified_at?: string | null;
};
export type Account = Entity & {
  slug: string;
  name: string;
  type: "user" | "organization";
};
export type Session = {
  user: User;
  accounts?: Account[];
  csrf_token?: string;
  [key: string]: unknown;
};
export type Repository = Entity & {
  owner_id: string;
  owner_slug?: string;
  name: string;
  slug: string;
  description: string;
  visibility: "public" | "private" | "internal" | "unlisted";
  default_branch: string;
  state: string;
  updated_at: string;
  clone_url?: string;
};

export const text = (value: unknown, fallback = ""): string =>
  typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : fallback;
export const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const array = <T = Entity>(value: unknown): T[] =>
  Array.isArray(value) ? (value as T[]) : [];
export const displayName = (item: Record<string, unknown>): string =>
  text(
    item.title ||
      item.display_name ||
      item.name ||
      item.username ||
      item.slug ||
      item.path ||
      item.filename ||
      item.url ||
      item.id,
    "Untitled",
  );
export const humanize = (value: unknown): string =>
  text(value).replaceAll("_", " ").replaceAll(".", " › ");
