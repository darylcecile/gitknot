import type { Field } from "./field-types.ts";

export class FieldError extends Error {
  constructor(public field: string, message: string) {
    super(message);
    this.name = "FieldError";
  }
}

export function fieldValues(fields: Field[], initial: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.fromEntries(fields.map(field => {
    const value = field.type === "password" ? (field.default ?? "")
      : initial[field.name] ?? field.default ?? (field.type === "checkbox" ? false : "");
    if (field.type === "checkbox") return [field.name, typeof value === "string" ? value === "true" : Boolean(value)];
    if (field.type === "datetime-local" && typeof value === "string" && value) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return [field.name,
        new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)];
    }
    return [field.name, value];
  }));
}

/** Old tab drafts may contain JSON strings. Decode them without changing stored data. */
export function structuredValue(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim()) return value;
  try { return JSON.parse(value); } catch { return value; }
}

export function listValue(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String)
    : String(value ?? "").split(",").map(item => item.trim()).filter(Boolean);
}

function serializeValue(field: Field, value: unknown, editing: boolean): unknown {
  if (field.type === "number") {
    if (value === "" || value === null) return null;
    const number = Number(value);
    if (!Number.isFinite(number)) throw new FieldError(field.name, `Enter a number for ${field.label.toLowerCase()}.`);
    if (field.min !== undefined && number < field.min) throw new FieldError(field.name, `${field.label} must be at least ${field.min}.`);
    if (field.max !== undefined && number > field.max) throw new FieldError(field.name, `${field.label} must be at most ${field.max}.`);
    return number;
  }
  if (field.type === "custom") {
    const parsed = structuredValue(value);
    if (parsed !== "" && (parsed === null || typeof parsed !== "object"))
      throw new FieldError(field.name, `Review ${field.label.toLowerCase()} before saving.`);
    return parsed;
  }
  if (field.type === "csv") return listValue(value);
  if (field.type === "datetime-local") {
    if (!value) return null;
    const date = new Date(String(value));
    if (Number.isNaN(date.getTime())) throw new FieldError(field.name, `Choose a valid date for ${field.label.toLowerCase()}.`);
    return date.toISOString();
  }
  return editing && value === "" && (field.name.endsWith("_id") || field.name === "avatar_url") ? null : value;
}

export function serializeFields(fields: Field[], values: Record<string, unknown>, editing = false) {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (editing && field.createOnly) continue;
    const value = values[field.name];
    if (field.required && field.type !== "checkbox" && (value === undefined || value === null
      || (Array.isArray(value) && !value.length) || (typeof value === "string" && !value.trim())))
      throw new FieldError(field.name, `${field.label.replace(/\s+IDs?\b/g, "")} is required.`);
    if (field.type === "password" && !value && !field.required) continue;
    if ((value === "" || value === undefined) && !field.required && (!editing || field.type === "custom")) continue;
    const serialized = serializeValue(field, value, editing);
    const error = field.validate?.(serialized);
    if (error) throw new FieldError(field.name, error);
    result[field.name] = serialized;
  }
  return result;
}
