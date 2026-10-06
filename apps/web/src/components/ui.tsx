import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { Link } from "react-router";
import {
  AlertCircle,
  ArrowDownToLine,
  Check,
  ChevronRight,
  Clipboard,
  FileQuestion,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import { ApiError, download } from "../api/client.ts";
import { humanize, record, text } from "../api/types.ts";

export function Button({
  children,
  variant = "secondary",
  busy,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      className={`button button-${variant} ${className}`}
      {...props}
      disabled={props.disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy && <LoaderCircle className="spin" size={15} />}
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = "",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <span className={`badge ${tone ? `badge-${tone}` : ""}`}>{children}</span>
  );
}

export function Status({ value }: { value: unknown }) {
  const status = text(value, "unknown");
  const positive = [
    "active",
    "open",
    "passed",
    "success",
    "succeeded",
    "completed",
    "committed",
    "approved",
    "online",
    "settled",
    "paid",
    "accepted",
  ].includes(status);
  const negative = [
    "failed",
    "denied",
    "rejected",
    "deleted",
    "error",
    "timed_out",
    "overdue",
    "revoked",
  ].includes(status);
  const working = [
    "running",
    "queued",
    "pending",
    "provisioning",
    "cancelling",
    "awaiting_approval",
    "transfer_pending",
    "blocked",
    "draft",
  ].includes(status);
  return (
    <Badge
      tone={
        positive ? "green" : negative ? "red" : working ? "amber" : "neutral"
      }
    >
      <span className="status-dot" />
      {humanize(status)}
    </Badge>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-heading">
      <div className="page-heading-content">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </header>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  className = "",
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className="panel-heading">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <FileQuestion size={23} strokeWidth={1.5} />
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

export function Loading({
  label = "Loading…",
  rows = 4,
}: {
  label?: string;
  rows?: number;
}) {
  return (
    <div className="loading-state" role="status" aria-label={label}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton-row" key={index}>
          <span className="skeleton skeleton-icon" />
          <div>
            <span className="skeleton skeleton-title" />
            <span className="skeleton skeleton-description" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ErrorNotice({
  error,
  retry,
  conflictHint = "Your draft is preserved. Review the current revision before trying again.",
}: {
  error: Error | null | undefined;
  retry?: () => void;
  conflictHint?: string;
}) {
  const messageId = useId();
  if (!error) return null;
  const apiError = error instanceof ApiError ? error : null;
  const fields = record(apiError?.details);
  return (
    <div
      className="notice notice-error"
      role="alert"
      aria-labelledby={messageId}
    >
      <AlertCircle size={18} />
      <div>
        <strong id={messageId}>
          {apiError?.conflict
            ? "This resource changed while you were working."
            : error.message}
        </strong>
        {apiError?.conflict && <p>{conflictHint}</p>}
        {apiError?.requestId && (
          <small>
            Request {apiError.requestId} ·{" "}
            <Link to="/support">Request troubleshooting</Link>
          </small>
        )}
        {apiError?.retryAfter && <p>Try again after {apiError.retryAfter}.</p>}
        {Object.keys(fields).length > 0 && (
          <details>
            <summary>Details</summary>
            <pre>{JSON.stringify(fields, null, 2)}</pre>
          </details>
        )}
      </div>
      {retry && (
        <Button onClick={retry}>
          <RefreshCw size={14} />
          Retry
        </Button>
      )}
    </div>
  );
}

export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "success" | "warning";
}) {
  return (
    <div className={`notice notice-${tone}`} role="status">
      {tone === "success" ? <Check size={18} /> : <AlertCircle size={18} />}
      <div>{children}</div>
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "modal-wide" : ""}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={onClose}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget && event.clientX !== 0) {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            onClose();
        }
      }}
    >
      <header className="modal-heading">
        <div>
          <h2 id={titleId}>{title}</h2>
          {description && <p id={descriptionId}>{description}</p>}
        </div>
        <Button variant="ghost" aria-label="Close dialog" onClick={onClose}>
          <X size={18} />
        </Button>
      </header>
      {open && children}
    </dialog>
  );
}

export function CopyButton({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    if (copied) {
      const id = setTimeout(() => setCopied(false), 2000);
      return () => clearTimeout(id);
    }
  }, [copied]);
  return (
    <>
      <Button
        aria-label={label}
        onClick={() => {
          void navigator.clipboard
            .writeText(value)
            .then(() => {
              setCopied(true);
              setError(null);
            })
            .catch(() =>
              setError(
                new Error(
                  "Clipboard access is unavailable. Select and copy the text manually.",
                ),
              ),
            );
        }}
      >
        {copied ? <Check size={15} /> : <Clipboard size={15} />}
        {copied ? "Copied" : label}
      </Button>
      <ErrorNotice error={error} />
    </>
  );
}

export function DownloadButton({
  path,
  name,
  children = "Download",
}: {
  path: string;
  name: string;
  children?: ReactNode;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  return (
    <>
      <Button
        busy={pending}
        onClick={() => {
          setPending(true);
          setError(null);
          void download(path, name)
            .catch((cause) =>
              setError(
                cause instanceof Error ? cause : new Error("Download failed."),
              ),
            )
            .finally(() => setPending(false));
        }}
      >
        <ArrowDownToLine size={15} />
        {children}
      </Button>
      <ErrorNotice error={error} />
    </>
  );
}

export function Time({ value }: { value: unknown }) {
  if (typeof value !== "string") return <span>—</span>;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return <span>{value}</span>;
  return (
    <time dateTime={value} title={date.toLocaleString()}>
      {date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year:
          date.getFullYear() !== new Date().getFullYear()
            ? "numeric"
            : undefined,
      })}
    </time>
  );
}

export function Avatar({
  name,
  url,
  small = false,
  decorative = false,
}: {
  name: string;
  url?: string;
  small?: boolean;
  decorative?: boolean;
}) {
  return (
    <span
      className={`avatar ${small ? "avatar-small" : ""}`}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative || undefined}
    >
      {url && /^https?:\/\//.test(url) ? (
        <img src={url} alt="" referrerPolicy="no-referrer" loading="lazy" />
      ) : (
        name.slice(0, 2).toUpperCase()
      )}
    </span>
  );
}

export function Metadata({ values }: { values: Record<string, unknown> }) {
  return (
    <dl className="metadata">
      {Object.entries(values)
        .filter(
          ([, value]) => value !== undefined && value !== null && value !== "",
        )
        .map(([label, value]) => (
          <div key={label}>
            <dt>{humanize(label)}</dt>
            <dd>
              {typeof value === "object" ? (
                <code>{JSON.stringify(value)}</code>
              ) : (
                text(
                  value,
                  value === true ? "Yes" : value === false ? "No" : "—",
                )
              )}
            </dd>
          </div>
        ))}
    </dl>
  );
}

export function JsonDetails({
  value,
  title = "Technical details",
}: {
  value: unknown;
  title?: string;
}) {
  return (
    <details className="json-details">
      <summary>{title}</summary>
      <pre tabIndex={0}>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export function Breadcrumbs({
  items,
}: {
  items: { label: string; to?: string }[];
}) {
  return (
    <nav aria-label="Breadcrumb" className="breadcrumbs">
      <ol>
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`}>
            {index > 0 && <ChevronRight size={13} />}
            {item.to ? (
              <Link to={item.to}>{item.label}</Link>
            ) : (
              <span aria-current="page">{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function Pagination({
  cursor,
  loadingMore,
  loadMore,
  moreError,
}: {
  cursor: string | null;
  loadingMore: boolean;
  loadMore: () => unknown;
  moreError: Error | null;
}) {
  return (
    <>
      <ErrorNotice error={moreError} />
      {cursor && (
        <div className="pagination">
          <Button
            busy={loadingMore}
            onClick={() => {
              void loadMore();
            }}
          >
            Load more
          </Button>
        </div>
      )}
    </>
  );
}

export function Money({
  value,
  currency = "USD",
  scale = 100,
}: {
  value: unknown;
  currency?: string;
  scale?: number;
}) {
  if (value === undefined || value === null || value === "")
    return <span>—</span>;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return <span>—</span>;
  return (
    <span className="numeric">
      {new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        maximumFractionDigits: scale > 100 ? 4 : 2,
      }).format(numeric / scale)}
    </span>
  );
}
