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
import { Check, Plus } from "lucide-react";
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
import type { Field, FieldContext } from "./field-types.ts";
import { FieldError, fieldValues, listValue, serializeFields, structuredValue } from "./field-values.ts";
import { TokenInput } from "./editors/controls.tsx";
export type { Field } from "./field-types.ts";
export { fieldValues, serializeFields } from "./field-values.ts";
const MarkdownEditor = lazy(async () => ({
  default: (await import("./markdown/editor.tsx")).MarkdownEditor,
}));
const SourceEditor = lazy(async () => ({
  default: (await import("./markdown/editor.tsx")).SourceEditor,
}));

export function FormField({
  field,
  value,
  onChange,
  disabled,
  reference,
  context = { repoId: "", accountId: "", values: {} },
  error,
}: {
  field: Field;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
  reference?: ReturnType<typeof referenceFor>;
  context?: FieldContext;
  error?: string;
}) {
  const id = useId();
  const feedback = <>{field.help && <p id={`${id}-help`} className="field-help">{field.help}</p>}
    {error && <p className="field-error" id={`${id}-error`}>{error}</p>}</>;
  if (field.type === "custom" && field.editor) {
    const Editor = field.editor;
    return <fieldset className="field field-full custom-field" disabled={disabled || field.readOnly} data-field={field.name}
      aria-describedby={error ? `${id}-error` : undefined} aria-invalid={!!error || undefined}>
      <legend>{field.label}{field.required && <span className="required"> *</span>}</legend>
      <Editor id={id} label={field.label} value={structuredValue(value)} onChange={onChange} disabled={disabled || field.readOnly} required={field.required} context={context} />
      {feedback}
    </fieldset>;
  }
  if (reference && field.type !== "select") return (
    <ReferencePicker key={`${reference.path}:${reference.label}`} id={id} name={field.name} reference={reference}
      value={value} onChange={onChange} multiple={field.type === "csv"} required={field.required}
      disabled={disabled || field.readOnly} help={field.help} error={error} />
  );
  if (field.type === "csv") return <div className="field" data-field={field.name}>
    <TokenInput id={id} label={field.label} value={listValue(value)} onChange={onChange} disabled={disabled || field.readOnly}
      required={field.required} placeholder={field.placeholder} />{feedback}
  </div>;
  const common = {
    id,
    name: field.name,
    required: field.required,
    disabled,
    readOnly: field.readOnly,
    "aria-describedby": [field.help ? `${id}-help` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined,
    "aria-invalid": !!error || undefined,
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
      <div className="field field-checkbox" data-field={field.name}>
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
      data-field={field.name}
      className={`field ${field.type === "markdown" || field.type === "textarea" ? "field-full" : ""}`}
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
      ) : field.type === "textarea" ? (
        <textarea
          {...common}
          rows={3}
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
          type={field.type === "custom" ? "text" : field.type || "text"}
          min={field.min}
          max={field.max}
          step={field.step}
          value={text(value)}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          spellCheck={field.type === "email" || field.type === "url" || /(?:username|token|code|ref|oid)/.test(field.name) ? false : undefined}
          autoComplete={
            field.autoComplete ||
            (field.type === "password" ? "new-password" : "off")
          }
        />
      )}
      {feedback}
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
  errors = {},
  contextValues = {},
}: {
  fields: Field[];
  values: Record<string, unknown>;
  setValues: (values: Record<string, unknown>) => void;
  editing?: boolean;
  disabled?: boolean;
  path?: string;
  errors?: Record<string, string>;
  contextValues?: Record<string, unknown>;
}) {
  const params = useParams();
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const repoId = params.repoId || path?.match(/^\/v1\/repos\/([^/?]+)/)?.[1] || text(values.repo_id || values.repository_id || contextValues.repo_id);
  const accountId = params.accountId || path?.match(/^\/v1\/(?:accounts|orgs)\/([^/?]+)/)?.[1] || text(values.account_id || values.owner_id);
  const needsOwner = fields.some(field => field.type === "custom" || /^(?:principal|user|assignee|reviewer|contributor|accountable|application|installation|required_approver|allowed_approver)/.test(field.name));
  const repository = useResource<Entity>(repoId && !accountId && needsOwner ? `/v1/repos/${encodeURIComponent(repoId)}` : null);
  const ownerId = accountId || text(repository.data?.owner_id);
  const visible = fields.filter(field => !editing || !field.createOnly);
  const sections = [...new Set(visible.map(field => field.section).filter((section): section is string => !!section))];
  const render = (field: Field) => (
          <FormField
            key={field.name}
            field={field}
            value={values[field.name]}
            disabled={disabled}
            error={errors[field.name]}
            context={{ repoId, accountId: ownerId, path, values: { ...contextValues, ...values } }}
            reference={referenceFor(field.name, repoId, ownerId, values, path)}
            onChange={(value) => setValues({ ...valuesRef.current, [field.name]: value,
              ...(field.name === "principal_type" ? { principal_id: "" } : {}),
              ...(field.name === "scope" ? { scope_id: "" } : {}),
              ...(["repo_id", "repository_id"].includes(field.name) ? { item_id: "", subject_id: "" } : {}),
              ...(field.name === "head_repo_id" ? { head: {} } : {}),
            })}
          />
  );
  return (
    <div className="form-grid" onInvalidCapture={event => revealField(event.target as HTMLElement)}>
      {visible.filter(field => !field.section).map(render)}
      {sections.map(section => <details className="form-section" key={section}>
        <summary>{section}</summary>
        <div className="form-grid">{visible.filter(field => field.section === section).map(render)}</div>
      </details>)}
    </div>
  );
}

function revealField(element: HTMLElement) {
  let parent: HTMLElement | null = element;
  while (parent) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
    parent = parent.parentElement;
  }
}

function focusFieldError(form: HTMLFormElement | null, error: FieldError) {
  const element = form?.querySelector<HTMLElement>(`[data-field="${CSS.escape(error.field)}"]`);
  if (!element) return;
  revealField(element);
  element.querySelector<HTMLElement>("input, select, textarea, button")?.focus();
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
  const form = useRef<HTMLFormElement>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
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
    setFieldErrors({});
    setSaved(false);
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
        setSaved(true);
        onSaved(result);
      }
    } catch (cause) {
      if (cause instanceof FieldError) {
        setFieldErrors({ [cause.field]: cause.message });
        focusFieldError(form.current, cause);
      }
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
      ref={form}
      onSubmit={(event) => {
        void submit(event);
      }}
      className="resource-form"
    >
      <Fields
        fields={fields}
        values={draft.values}
        setValues={values => { draft.setValues(values); setSaved(false); setFieldErrors({}); }}
        editing={!!initial}
        disabled={mutation.pending || preparing}
        path={path}
        errors={fieldErrors}
        contextValues={initial?.data}
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
        <span className="muted" role="status">
          {saved ? <><Check size={14} aria-hidden="true" /> Saved</> : draft.dirty
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
  method,
  transform,
}: {
  path: string;
  fields: Field[];
  title: string;
  buttonLabel?: string;
  onSaved: () => void;
  sensitive?: boolean;
  snapshot?: Snapshot<Entity>;
  method?: "PATCH" | "PUT";
  transform?: (values: Record<string, unknown>) => Record<string, unknown>;
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
            method={method}
            transform={transform}
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
  variant = "primary",
}: {
  path: string;
  fields: Field[];
  title: string;
  buttonLabel?: string;
  onSaved: (result: Snapshot<Entity>) => void;
  transform?: (values: Record<string, unknown>) => Record<string, unknown>;
  sensitive?: boolean;
  initiallyOpen?: boolean;
  variant?: "primary" | "secondary" | "ghost";
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <Button
        variant={variant}
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
  transform,
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
  transform?: (body: Record<string, unknown>) => Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState(fieldValues(fields));
  const [confirmation, setConfirmation] = useState("");
  const [expected, setExpected] = useState(snapshot);
  const [revisionError, setRevisionError] = useState<Error | null>(null);
  const [fetching, setFetching] = useState(false);
  const [credential, setCredential] = useState<unknown>(null);
  const form = useRef<HTMLFormElement>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
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
          ref={form}
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
                    body: method === "GET" ? undefined : transform ? transform(valuesBody) : valuesBody,
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
                if (cause instanceof FieldError) {
                  setFieldErrors({ [cause.field]: cause.message });
                  focusFieldError(form.current, cause);
                }
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
            setValues={next => { setValues(next); setFieldErrors({}); }}
            disabled={mutation.pending}
            path={path}
            contextValues={record(snapshot?.data)}
            errors={fieldErrors}
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
