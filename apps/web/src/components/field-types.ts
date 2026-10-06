import type { ComponentType } from "react";

export type FieldContext = {
  repoId: string;
  accountId: string;
  path?: string;
  values: Record<string, unknown>;
};

export type FieldEditorProps = {
  id: string;
  label?: string;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  required?: boolean;
  context: FieldContext;
};

export type Field = {
  name: string;
  label: string;
  type?: "text" | "email" | "password" | "url" | "number" | "textarea"
    | "markdown" | "code" | "select" | "checkbox" | "csv" | "custom"
    | "datetime-local" | "date";
  required?: boolean;
  help?: string;
  placeholder?: string;
  default?: unknown;
  options?: readonly (string | { value: string; label: string; description?: string })[];
  min?: number;
  max?: number;
  step?: number | string;
  readOnly?: boolean;
  createOnly?: boolean;
  autoComplete?: string;
  /** Optional controls share one disclosure instead of competing with the task. */
  section?: string;
  editor?: ComponentType<FieldEditorProps>;
  validate?: (value: unknown) => string | undefined;
};
