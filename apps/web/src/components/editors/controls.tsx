import { useId, useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "../ui.tsx";
import { listValue } from "../field-values.ts";
import type { FieldContext } from "../field-types.ts";
import { ReferencePicker, referenceFor } from "../reference-picker.tsx";

export function Control({ label, help, children }: { label: string; help?: string; children: (id: string, helpId?: string) => ReactNode }) {
  const id = useId();
  return <div className="field"><label htmlFor={id}>{label}</label>
    {children(id, help ? `${id}-help` : undefined)}
    {help && <p className="field-help" id={`${id}-help`}>{help}</p>}
  </div>;
}

export function TextControl({ label, value, onChange, help, placeholder, required, type = "text", min, max, step }: {
  label: string; value: unknown; onChange: (value: string) => void; help?: string;
  placeholder?: string; required?: boolean; type?: string; min?: number; max?: number; step?: number | string;
}) {
  return <Control label={label} help={help}>{(id, helpId) => <input id={id} name={id} type={type}
    value={value === undefined || value === null ? "" : String(value)} onChange={event => onChange(event.target.value)}
    required={required} placeholder={placeholder} min={min} max={max} step={step} autoComplete="off"
    spellCheck={false} aria-describedby={helpId} />}</Control>;
}

export function SelectControl({ label, value, onChange, options, help }: {
  label: string; value: unknown; onChange: (value: string) => void; help?: string;
  options: readonly (string | { value: string; label: string })[];
}) {
  return <Control label={label} help={help}>{(id, helpId) => <select id={id} name={id} value={String(value ?? "")}
    onChange={event => onChange(event.target.value)} aria-describedby={helpId}>
    {options.map(option => { const choice = typeof option === "string" ? { value: option, label: option.replaceAll("_", " ") } : option;
      return <option key={choice.value} value={choice.value}>{choice.label}</option>; })}
  </select>}</Control>;
}

export function Toggle({ label, description, checked, onChange }: {
  label: string; description?: string; checked: boolean; onChange: (checked: boolean) => void;
}) {
  return <label className="option-row"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />
    <span><strong>{label}</strong>{description && <span className="field-help">{description}</span>}</span>
  </label>;
}

export function EditorSection({ title, children }: { title: string; children: ReactNode }) {
  return <details className="editor-section"><summary>{title}</summary><div className="editor-section-body">{children}</div></details>;
}

/** Editable values remain individual tokens; pasting a comma-separated list still works. */
export function TokenInput({ label, value, onChange, placeholder = "Add a value…", required, disabled, id: providedId }: {
  label: string; value: unknown; onChange: (value: string[]) => void; placeholder?: string;
  required?: boolean; disabled?: boolean; id?: string;
}) {
  const generatedId = useId();
  const id = providedId || generatedId;
  const [draft, setDraft] = useState("");
  const values = listValue(value).map(item => item.trim()).filter(Boolean);
  const tokens = draft.trim() && values.at(-1) === draft.trim() ? values.slice(0, -1) : values;
  const changeDraft = (next: string) => {
    const parts = next.split(/[\n,]/);
    setDraft(parts.at(-1) || "");
    onChange([...new Set([...tokens, ...parts].map(item => item.trim()).filter(Boolean))]);
  };
  return <div className="token-field">
    <label htmlFor={id}>{label}</label>
    <div className="token-input" data-disabled={disabled || undefined}>
      {tokens.map((token, index) => <span className="token" key={index}>
        <span>{token}</span><button type="button" disabled={disabled} aria-label={`Remove ${token}`}
          onClick={() => onChange(values.filter((_, position) => position !== index))}><X size={12} aria-hidden="true" /></button>
      </span>)}
      <input id={id} name={id} value={draft} placeholder={tokens.length ? "Add another…" : placeholder}
        autoComplete="off" spellCheck={false} disabled={disabled} required={required && !tokens.length}
        onChange={event => changeDraft(event.target.value)} onBlur={() => setDraft("")}
        onKeyDown={event => {
          if (event.key === "Enter" && draft.trim()) { event.preventDefault(); setDraft(""); }
          if (event.key === "Backspace" && !draft && tokens.length) { event.preventDefault(); setDraft(tokens.at(-1)!); }
        }} />
    </div>
  </div>;
}

export function ReferenceControl({ name, label, value, onChange, context, multiple = true, path, required }: {
  name: string; label: string; value: unknown; onChange: (value: string | string[]) => void;
  context: FieldContext; multiple?: boolean; path?: string; required?: boolean;
}) {
  const id = useId();
  const reference = path ? { path, label } : referenceFor(name, context.repoId, context.accountId, context.values, context.path);
  if (!reference) return multiple
    ? <TokenInput label={label} value={value} onChange={onChange} required={required} />
    : <TextControl label={label} value={value} onChange={onChange} required={required} />;
  return <ReferencePicker id={id} name={name} reference={{ ...reference, label }} value={value} onChange={onChange}
    multiple={multiple} required={required} />;
}

export function AddRow({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <Button className="add-row" variant="ghost" onClick={onClick}><Plus size={14} aria-hidden="true" />{children}</Button>;
}

export function RemoveRow({ label, onClick }: { label: string; onClick: () => void }) {
  return <Button variant="ghost" aria-label={label} onClick={onClick}><X size={16} aria-hidden="true" /></Button>;
}

export function updateProperty(source: Record<string, unknown>, key: string, value: unknown) {
  const next = { ...source };
  if (value === undefined || value === "") delete next[key];
  else next[key] = value;
  return next;
}
