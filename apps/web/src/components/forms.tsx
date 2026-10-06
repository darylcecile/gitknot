import {
  useEffect,
  useId,
  useRef,
  useState,
  Suspense,
  lazy,
  type FormEvent,
  type ReactNode,
} from "react";
import { Plus, Save } from "lucide-react";
import { useParams } from "react-router";
import {
  ApiError,
  activeViewerRepository,
  request,
  requireEtag,
} from "../api/client.ts";
import { useMutation, useResource } from "../api/hooks.ts";
import { query } from "../api/endpoints.ts";
import {
  array,
  record,
  text,
  type Entity,
  type Snapshot,
} from "../api/types.ts";
import {
  Button,
  CopyButton,
  ErrorNotice,
  JsonDetails,
  Loading,
  Modal,
  Notice,
} from "./ui.tsx";
import { ReferencePicker, referenceFor } from "./reference-picker.tsx";
const MarkdownEditor = lazy(async () => ({
  default: (await import("./markdown/editor.tsx")).MarkdownEditor,
}));
const SourceEditor = lazy(async () => ({
  default: (await import("./markdown/editor.tsx")).SourceEditor,
}));

export type Field = {
  name: string;
  label: string;
  type?:
    | "text"
    | "email"
    | "password"
    | "url"
    | "number"
    | "textarea"
    | "markdown"
    | "code"
    | "select"
    | "checkbox"
    | "json"
    | "csv"
    | "datetime-local"
    | "date";
  required?: boolean;
  help?: string;
  placeholder?: string;
  default?: unknown;
  options?: readonly (string | { value: string; label: string })[];
  min?: number;
  max?: number;
  step?: number | string;
  readOnly?: boolean;
  createOnly?: boolean;
  autoComplete?: string;
};

export function fieldValues(
  fields: Field[],
  initial: Record<string, unknown> = {},
): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((field) => {
      const value =
        field.type === "password"
          ? (field.default ?? "")
          : (initial[field.name] ??
            field.default ??
            (field.type === "checkbox" ? false : ""));
      if (field.type === "checkbox")
        return [
          field.name,
          typeof value === "string" ? value === "true" : Boolean(value),
        ];
      if (
        field.type === "datetime-local" &&
        typeof value === "string" &&
        value
      ) {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime()))
          return [
            field.name,
            new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
              .toISOString()
              .slice(0, 16),
          ];
      }
      return [
        field.name,
        field.type === "json" && typeof value !== "string"
          ? JSON.stringify(value, null, 2)
          : field.type === "csv" && Array.isArray(value)
            ? value.join(", ")
            : value,
      ];
    }),
  );
}

export function serializeFields(
  fields: Field[],
  values: Record<string, unknown>,
  editing = false,
) {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (editing && field.createOnly) continue;
    const value = values[field.name];
    if (
      field.required &&
      field.type !== "checkbox" &&
      (value === undefined ||
        value === null ||
        (Array.isArray(value) && value.length === 0) ||
        (typeof value === "string" && !value.trim()))
    )
      throw new Error(`${field.label.replace(/\s+IDs?\b/g, "")} is required.`);
    if (field.type === "password" && !value && !field.required) continue;
    if ((value === "" || value === undefined) && !field.required && !editing)
      continue;
    if (field.type === "number")
      result[field.name] = value === "" ? null : Number(value);
    else if (field.type === "json") {
      try {
        result[field.name] = value === "" ? {} : JSON.parse(String(value));
      } catch {
        throw new Error(`${field.label} must be valid JSON.`);
      }
    } else if (field.type === "csv")
      result[field.name] = Array.isArray(value) ? value.map(String) : String(value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    else if (field.type === "datetime-local")
      result[field.name] = value ? new Date(String(value)).toISOString() : null;
    else
      result[field.name] =
        editing &&
        value === "" &&
        (field.name.endsWith("_id") || field.name === "avatar_url")
          ? null
          : value;
  }
  return result;
}

export function FormField({
  field,
  value,
  onChange,
  disabled,
  reference,
}: {
  field: Field;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  reference?: ReturnType<typeof referenceFor>;
}) {
  const id = useId();
  if (reference && field.type !== "select") return (
    <ReferencePicker key={`${reference.path}:${reference.label}`} id={id} name={field.name} reference={reference}
      value={value} onChange={onChange} multiple={field.type === "csv"} required={field.required}
      disabled={disabled || field.readOnly} help={field.help} />
  );
  const common = {
    id,
    name: field.name,
    required: field.required,
    disabled,
    readOnly: field.readOnly,
    "aria-describedby": field.help ? `${id}-help` : undefined,
  };
  const label = (
    <label htmlFor={id}>
      {field.label}
      {field.required && (
        <span className="required" aria-hidden="true">
          {" "}
          *
        </span>
      )}
    </label>
  );
  if (field.type === "checkbox")
    return (
      <div className="field field-checkbox">
        <input
          {...common}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
        <div>
          {label}
          {field.help && (
            <p id={`${id}-help`} className="field-help">
              {field.help}
            </p>
          )}
        </div>
      </div>
    );
  return (
    <div
      className={`field ${field.type === "markdown" || field.type === "json" || field.type === "textarea" ? "field-full" : ""}`}
    >
      {label}
      {field.type === "code" ? (
        <Suspense fallback={<Loading label="Opening source editor" rows={2} />}>
          <SourceEditor
            id={id}
            value={text(value)}
            onChange={onChange}
            label={field.label}
            language="code"
          />
        </Suspense>
      ) : field.type === "markdown" ? (
        <Suspense
          fallback={<Loading label="Opening Markdown editor" rows={2} />}
        >
          <MarkdownEditor
            id={id}
            value={text(value)}
            onChange={onChange}
            label={field.label}
          />
        </Suspense>
      ) : field.type === "textarea" || field.type === "json" ? (
        <textarea
          {...common}
          className={field.type === "json" ? "code-input" : ""}
          spellCheck={field.type !== "json"}
          rows={field.type === "json" ? 7 : 4}
          value={text(value)}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
        />
      ) : field.type === "select" ? (
        <select
          {...common}
          value={text(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">Select {field.label.toLowerCase()}</option>
          {field.options?.map((option) =>
            typeof option === "string" ? (
              <option key={option} value={option}>
                {option.replaceAll("_", " ")}
              </option>
            ) : (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ),
          )}
        </select>
      ) : (
        <input
          {...common}
          type={field.type === "csv" ? "text" : field.type || "text"}
          min={field.min}
          max={field.max}
          step={field.step}
          value={text(value)}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          autoComplete={
            field.autoComplete ||
            (field.type === "password" ? "new-password" : "off")
          }
        />
      )}
      {field.help && (
        <p id={`${id}-help`} className="field-help">
          {field.help}
        </p>
      )}
    </div>
  );
}

export function Fields({
  fields,
  values,
  setValues,
  editing = false,
  disabled = false,
  path,
}: {
  fields: Field[];
  values: Record<string, unknown>;
  setValues: (values: Record<string, unknown>) => void;
  editing?: boolean;
  disabled?: boolean;
  path?: string;
}) {
  const params = useParams();
  const repoId = params.repoId || path?.match(/^\/v1\/repos\/([^/?]+)/)?.[1] || text(values.repo_id || values.repository_id);
  const accountId = params.accountId || path?.match(/^\/v1\/(?:accounts|orgs)\/([^/?]+)/)?.[1] || text(values.account_id || values.owner_id);
  const needsOwner = fields.some(field => /^(?:principal|user|assignee|reviewer|contributor|accountable|application|installation|required_approver|allowed_approver)/.test(field.name));
  const repository = useResource<Entity>(repoId && !accountId && needsOwner ? `/v1/repos/${encodeURIComponent(repoId)}` : null);
  const ownerId = accountId || text(repository.data?.owner_id);
  return (
    <div className="form-grid">
      {fields
        .filter((field) => !editing || !field.createOnly)
        .map((field) => (
          <FormField
            key={field.name}
            field={field}
            value={values[field.name]}
            disabled={disabled}
            reference={referenceFor(field.name, repoId, ownerId, values, path)}
            onChange={(value) => setValues({ ...values, [field.name]: value,
              ...(field.name === "principal_type" ? { principal_id: "" } : {}),
              ...(field.name === "scope" ? { scope_id: "" } : {}),
              ...(["repo_id", "repository_id"].includes(field.name) ? { item_id: "", subject_id: "" } : {}),
            })}
          />
        ))}
    </div>
  );
}

export function ConflictRecovery({
  error,
  path,
  onRevision,
  context = "draft",
}: {
  error: Error | null;
  path: string;
  onRevision: (snapshot: Snapshot<Entity>) => void;
  context?: "draft" | "action";
}) {
  const [latest, setLatest] = useState<Snapshot<Entity> | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    setLatest(null);
    setLoadError(null);
    setLoading(false);
    return () => controller.current?.abort();
  }, [error, path]);
  if (!(error instanceof ApiError) || !error.conflict) return null;
  return (
    <div className="conflict-recovery">
      <Button
        busy={loading}
        onClick={() => {
          controller.current?.abort();
          const current = new AbortController();
          controller.current = current;
          setLatest(null);
          setLoadError(null);
          setLoading(true);
          void request<Entity>(path, { signal: current.signal })
            .then((snapshot) => {
              requireEtag(snapshot);
              if (!current.signal.aborted) setLatest(snapshot);
            })
            .catch((cause) => {
              if (!current.signal.aborted) setLoadError(cause);
            })
            .finally(() => {
              if (!current.signal.aborted) setLoading(false);
            });
        }}
      >
        Review current version
      </Button>
      <ErrorNotice error={loadError} />
      {latest && (
        <>
          <p className="current-revision">
            Current revision: <code>{latest.etag}</code>
          </p>
          <JsonDetails title="Current server version" value={latest.data} />
          <p>
            {context === "action"
              ? "Review the current state, use this revision, then confirm the action. Your entered values are preserved."
              : "Compare this version with your draft. Continuing changes the expected revision; your draft stays in the form."}
          </p>
          <Button onClick={() => onRevision(latest)}>
            {context === "action"
              ? "Use this revision"
              : "Use this revision, keep my draft"}
          </Button>
        </>
      )}
    </div>
  );
}

export function useDraft(
  key: string | undefined,
  initial: Record<string, unknown>,
  etag?: string | null,
) {
  const restoredEtag = useRef<string | null | undefined>(undefined);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    if (!key) return initial;
    try {
      const stored = sessionStorage.getItem(`gitknot:draft:${key}`);
      if (!stored) return initial;
      const parsed = record(JSON.parse(stored));
      if (parsed.draft_version === 1) {
        restoredEtag.current =
          typeof parsed.etag === "string" ? parsed.etag : null;
        return { ...initial, ...record(parsed.values) };
      }
      return { ...initial, ...parsed };
    } catch {
      return initial;
    }
  });
  const [storageError, setStorageError] = useState(false);
  const [baseline, setBaseline] = useState(initial);
  const [baseEtag, setBaseEtag] = useState(
    restoredEtag.current === undefined ? etag : restoredEtag.current,
  );
  const dirty = JSON.stringify(values) !== JSON.stringify(baseline);
  useEffect(() => {
    if (!key) return;
    try {
      if (dirty)
        sessionStorage.setItem(
          `gitknot:draft:${key}`,
          JSON.stringify({ draft_version: 1, values, etag: baseEtag }),
        );
      else sessionStorage.removeItem(`gitknot:draft:${key}`);
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [key, dirty, values, baseEtag]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const clear = (nextEtag?: string | null) => {
    if (key) {
      try {
        sessionStorage.removeItem(`gitknot:draft:${key}`);
      } catch {
        setStorageError(true);
      }
    }
    setBaseline(values);
    if (nextEtag !== undefined) setBaseEtag(nextEtag);
  };
  return {
    values,
    setValues,
    dirty,
    clear,
    storageError,
    baseEtag,
    rebase: setBaseEtag,
  };
}

export function ResourceForm({
  path,
  fields,
  initial,
  onSaved,
  onCancel,
  submitLabel = "Save changes",
  method,
  draftKey,
  transform,
  children,
  precondition,
  revisionPath,
}: {
  path: string;
  fields: Field[];
  initial?: Snapshot<Entity>;
  onSaved: (result: Snapshot<Entity>) => void;
  onCancel?: () => void;
  submitLabel?: string;
  method?: "POST" | "PATCH" | "PUT";
  draftKey?: string;
  transform?: (
    values: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  children?: ReactNode;
  precondition?: Snapshot<Entity> | null;
  revisionPath?: string;
}) {
  const draft = useDraft(
    draftKey,
    fieldValues(fields, initial?.data),
    (initial || precondition)?.etag,
  );
  const mutation = useMutation();
  const submitting = useRef(false);
  const [preparing, setPreparing] = useState(false);
  const [expected, setExpected] = useState(() => {
    const current = initial || precondition;
    return current && draft.baseEtag
      ? { ...current, etag: draft.baseEtag }
      : current;
  });
  useEffect(() => {
    // An untouched child-create form can follow its parent. Once edited, its
    // original precondition stays pinned until explicit conflict recovery.
    if (!initial && precondition && !draft.dirty) {
      setExpected(precondition);
      draft.rebase(precondition.etag);
    }
  }, [precondition?.etag]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setPreparing(true);
    try {
      const body = serializeFields(fields, draft.values, !!initial);
      const result = await mutation.run<Entity>(path, {
        method: method || (initial ? "PATCH" : "POST"),
        body: transform ? await transform(body) : body,
        etag: expected ? requireEtag(expected) : undefined,
      });
      if (result) {
        if (initial && result.etag) setExpected(result);
        draft.clear(result.etag);
        onSaved(result);
      }
    } catch (cause) {
      mutation.setError(
        cause instanceof Error ? cause : new Error("Check your form fields."),
      );
    } finally {
      submitting.current = false;
      setPreparing(false);
    }
  };
  return (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
      className="resource-form"
    >
      <Fields
        fields={fields}
        values={draft.values}
        setValues={draft.setValues}
        editing={!!initial}
        disabled={mutation.pending || preparing}
        path={path}
      />
      {children}
      <ErrorNotice error={mutation.error} />
      <ConflictRecovery
        error={mutation.error}
        path={revisionPath || path}
        onRevision={(value) => {
          setExpected(value);
          draft.rebase(value.etag);
          if (
            "expected_oid" in draft.values &&
            typeof value.data.commit_oid === "string"
          )
            draft.setValues({
              ...draft.values,
              expected_oid: value.data.commit_oid,
            });
          mutation.clearError();
        }}
      />
      {draft.storageError && (
        <Notice tone="warning">
          Browser draft storage is full or unavailable. Keep this page open
          until your changes are saved.
        </Notice>
      )}
      <footer className="form-actions">
        <span className="muted">
          {draft.dirty
            ? draftKey && !draft.storageError
              ? "Draft saved in this browser tab"
              : "Unsaved changes"
            : ""}
        </span>
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}
        <Button
          type="submit"
          variant="primary"
          busy={mutation.pending || preparing}
          disabled={!!activeViewerRepository()}
        >
          <Save size={15} />
          {submitLabel}
        </Button>
      </footer>
    </form>
  );
}

export function EditResource({
  path,
  fields,
  title,
  buttonLabel = "Edit",
  onSaved,
  sensitive = false,
  snapshot,
}: {
  path: string;
  fields: Field[];
  title: string;
  buttonLabel?: string;
  onSaved: () => void;
  sensitive?: boolean;
  snapshot?: Snapshot<Entity>;
}) {
  const [open, setOpen] = useState(false);
  const resource = useResource<Entity>(open && !snapshot ? path : null);
  const current = snapshot || resource.snapshot;
  return (
    <>
      <Button
        onClick={() => setOpen(true)}
        disabled={!!activeViewerRepository()}
      >
        {buttonLabel}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        wide={fields.some((field) => field.type === "markdown")}
      >
        <ErrorNotice error={resource.error} retry={resource.refresh} />
        {!current && resource.loading && <Loading />}
        {current && (
          <ResourceForm
            key={current.data.id}
            path={path}
            initial={current}
            fields={fields}
            draftKey={sensitive ? undefined : path}
            onCancel={() => setOpen(false)}
            onSaved={() => {
              setOpen(false);
              onSaved();
            }}
          />
        )}
      </Modal>
    </>
  );
}

export function CreateResource({
  path,
  fields,
  title,
  buttonLabel,
  onSaved,
  transform,
  sensitive = false,
  initiallyOpen = false,
}: {
  path: string;
  fields: Field[];
  title: string;
  buttonLabel?: string;
  onSaved: (result: Snapshot<Entity>) => void;
  transform?: (values: Record<string, unknown>) => Record<string, unknown>;
  sensitive?: boolean;
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <Button
        variant="primary"
        onClick={() => setOpen(true)}
        disabled={!!activeViewerRepository()}
      >
        <Plus size={15} />
        {buttonLabel || title}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        wide={fields.some((field) => field.type === "markdown")}
      >
        <ResourceForm
          path={path}
          fields={fields}
          draftKey={sensitive ? undefined : `${path}:new`}
          submitLabel={buttonLabel || title}
          onCancel={() => setOpen(false)}
          transform={transform}
          onSaved={(result) => {
            setOpen(false);
            onSaved(result);
          }}
        />
      </Modal>
    </>
  );
}

export function ActionButton({
  path,
  resourcePath,
  snapshot,
  label,
  title,
  description,
  fields = [],
  body = {},
  onDone,
  danger = false,
  method = "POST",
  confirmText,
  variant,
  sensitive = false,
}: {
  path: string;
  resourcePath?: string;
  snapshot?: Snapshot<unknown> | null;
  label: string;
  title?: string;
  description?: string;
  fields?: Field[];
  body?: Record<string, unknown>;
  onDone: (result: Snapshot<Entity>) => void;
  danger?: boolean;
  method?: "GET" | "POST" | "DELETE" | "PATCH" | "PUT";
  confirmText?: string;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  sensitive?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState(fieldValues(fields));
  const [confirmation, setConfirmation] = useState("");
  const [expected, setExpected] = useState(snapshot);
  const [revisionError, setRevisionError] = useState<Error | null>(null);
  const [fetching, setFetching] = useState(false);
  const [credential, setCredential] = useState<unknown>(null);
  const confirmId = useId();
  const mutation = useMutation();
  const revisionPath = resourcePath || path;
  const begin = () => {
    setOpen(true);
    setConfirmation("");
    mutation.clearError();
    setRevisionError(null);
    if (snapshot) {
      setExpected(snapshot);
      return;
    }
    if (resourcePath || (method !== "POST" && method !== "GET")) {
      setFetching(true);
      void request<Entity>(revisionPath)
        .then(setExpected)
        .catch((cause) => setRevisionError(cause))
        .finally(() => setFetching(false));
    }
  };
  return (
    <>
      <Button
        variant={variant || (danger ? "danger" : "secondary")}
        onClick={begin}
        disabled={method !== "GET" && !!activeViewerRepository()}
      >
        {label}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title || label}
        description={description}
      >
        <form
          className="resource-form"
          onSubmit={(event) => {
            event.preventDefault();
            void (async () => {
              try {
                const valuesBody = {
                  ...body,
                  ...serializeFields(fields, values),
                };
                const result = await mutation.run<Entity>(
                  method === "GET" ? query(path, valuesBody) : path,
                  {
                    method,
                    body: method === "GET" ? undefined : valuesBody,
                    etag:
                      method !== "GET" && expected
                        ? requireEtag(expected)
                        : undefined,
                  },
                );
                if (result) {
                  setOpen(false);
                  const value = record(result.data);
                  if (
                    value.token ||
                    value.secret ||
                    value.recovery_codes ||
                    value.enrollment_token
                  )
                    setCredential(result.data);
                  if (sensitive) setValues(fieldValues(fields));
                  onDone(result);
                }
              } catch (cause) {
                mutation.setError(
                  cause instanceof Error
                    ? cause
                    : new Error("Unable to perform this operation."),
                );
              }
            })();
          }}
        >
          <Fields
            fields={fields}
            values={values}
            setValues={setValues}
            disabled={mutation.pending}
            path={path}
          />
          {confirmText && (
            <div className="field">
              <label htmlFor={confirmId}>
                Type <strong>{confirmText}</strong> to confirm
              </label>
              <input
                id={confirmId}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                required
              />
            </div>
          )}
          <ErrorNotice
            error={revisionError || mutation.error}
            conflictHint="Review the current version before confirming this action. Your entered values are preserved."
          />
          <ConflictRecovery
            error={mutation.error}
            path={revisionPath}
            context="action"
            onRevision={(next) => {
              setExpected(next);
              mutation.clearError();
            }}
          />
          <footer className="form-actions">
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant={danger ? "danger" : "primary"}
              type="submit"
              busy={mutation.pending || fetching}
              disabled={
                !!revisionError ||
                (!!confirmText && confirmation !== confirmText)
              }
            >
              {label}
            </Button>
          </footer>
        </form>
      </Modal>
      <Modal
        open={credential !== null}
        onClose={() => setCredential(null)}
        title="Save this one-time credential"
      >
        <div className="modal-body">
          <OneTimeValue value={credential} />
          <Button onClick={() => setCredential(null)}>I have saved it</Button>
        </div>
      </Modal>
    </>
  );
}

export const markdownField: Field = {
  name: "body",
  label: "Description",
  type: "markdown",
};
export const titleField: Field = {
  name: "title",
  label: "Title",
  required: true,
};
export const nameField: Field = { name: "name", label: "Name", required: true };
export const roleField: Field = {
  name: "role_id",
  label: "Role",
  required: true,
  help: "Choose a starter role or a custom role.",
};
export const expiryField: Field = {
  name: "expires_at",
  label: "Expiration",
  type: "datetime-local",
  required: true,
};

export function OneTimeValue({
  value,
  title = "Save your credential",
}: {
  value: unknown;
  title?: string;
}) {
  const source = record(value);
  const secret = text(
    source.token ||
      source.secret ||
      source.enrollment_token ||
      source.credential ||
      source.recovery_codes,
  );
  const tokens = array<string>(source.recovery_codes);
  if (!secret && !tokens.length) return null;
  return (
    <Notice tone="success">
      <strong>{title}</strong>
      <p>This value is shown once. Store it before leaving this page.</p>
      <pre className="selectable">{secret || tokens.join("\n")}</pre>
      <CopyButton value={secret || tokens.join("\n")} label="Copy value" />
      {source.kind === "viewer" &&
        secret &&
        array<string>(source.repository_ids)[0] && (
          <CopyButton
            value={`${location.origin}/viewer/${encodeURIComponent(array<string>(source.repository_ids)[0]!)}#token=${encodeURIComponent(secret)}`}
            label="Copy private viewer link"
          />
        )}
    </Notice>
  );
}
