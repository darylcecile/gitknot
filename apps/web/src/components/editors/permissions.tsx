import { useId, useState } from "react";
import { Search, ShieldCheck } from "lucide-react";
import { useResource } from "../../api/hooks.ts";
import { array, humanize, record, text } from "../../api/types.ts";
import type { FieldEditorProps } from "../field-types.ts";
import { listValue, structuredValue } from "../field-values.ts";
import { Badge, Button, ErrorNotice } from "../ui.tsx";
import { EditorSection, TokenInput } from "./controls.tsx";

const presets = [
  { name: "Read code", values: ["repositories.read", "contents.read"] },
  { name: "Push code", values: ["repositories.read", "contents.read", "contents.push"] },
  { name: "Collaborate", values: ["repositories.read", "issues.read", "issues.write", "pull_requests.read", "pull_requests.write"] },
] as const;

export function capabilityOptions(document: unknown): string[] {
  const paths = record(record(document).paths);
  return [...new Set(Object.values(paths).flatMap(path => Object.values(record(path)))
    .map(operation => text(record(operation)["x-gitknot-capability"])).filter(Boolean))].sort();
}

export function CapabilityPicker({ value, onChange, patterns = false }: {
  value: unknown; onChange: (value: string[]) => void; patterns?: boolean;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const catalog = useResource<Record<string, unknown>>("/openapi.json");
  const selected = listValue(value);
  const options = [...new Set([...capabilityOptions(catalog.data), ...selected])].sort();
  const filtered = options.filter(option => option.replaceAll("_", " ").includes(search.toLowerCase())
    || humanize(option).toLowerCase().includes(search.toLowerCase()));
  const groups = [...new Set(filtered.map(option => option.split(".")[0]!))];
  const toggle = (capability: string) => onChange(selected.includes(capability)
    ? selected.filter(item => item !== capability) : [...selected, capability]);
  return <div className="permission-picker">
    <div className="preset-bar"><ShieldCheck size={16} aria-hidden="true" /><span>Start with</span>
      {presets.map(preset => <Button key={preset.name} variant="ghost" onClick={() => onChange([...new Set([...selected, ...preset.values])])}>{preset.name}</Button>)}
    </div>
    <div className="picker-search"><Search size={16} aria-hidden="true" /><input id={id} type="search" aria-label="Find a permission"
      placeholder="Find a permission…" value={search} onChange={event => setSearch(event.target.value)} /></div>
    <div className="permission-groups">
      {groups.map(group => <details key={group} open={search ? true : undefined}>
        <summary><span>{humanize(group)}</span><span className="muted">{selected.filter(item => item.split(".")[0] === group).length || ""}</span></summary>
        <div>{filtered.filter(option => option.split(".")[0] === group).map(option => <label className="permission-option" key={option}>
          <input type="checkbox" checked={selected.includes(option)} onChange={() => toggle(option)} />
          <span>{humanize(option.slice(group.length + 1)) || "All permissions"}<small>{option}</small></span>
        </label>)}</div>
      </details>)}
      {catalog.loading && <p className="field-help" role="status">Loading permissions…</p>}
      {!catalog.loading && !filtered.length && <p className="field-help">No matching permissions.</p>}
    </div>
    <ErrorNotice error={catalog.error} retry={catalog.refresh} />
    <div className="selection-summary"><Badge>{selected.length} selected</Badge>
      {selected.length > 0 && <Button variant="ghost" onClick={() => onChange([])}>Clear selection</Button>}
    </div>
    {patterns && <EditorSection title="Permission patterns"><TokenInput label="Permission names or patterns" value={selected}
      placeholder="For example, contents.*…" onChange={onChange} /></EditorSection>}
  </div>;
}

export function CapabilitiesEditor({ value, onChange }: FieldEditorProps) {
  return <CapabilityPicker value={structuredValue(value) || []} onChange={onChange} />;
}

export function RolePermissionsEditor({ value, onChange }: FieldEditorProps) {
  const rules = array<Record<string, unknown>>(structuredValue(value));
  const allow = rules.filter(rule => rule.effect === "allow").map(rule => text(rule.capability));
  const deny = rules.filter(rule => rule.effect === "deny").map(rule => text(rule.capability));
  const update = (effect: string, values: string[]) => onChange([
    ...rules.filter(rule => rule.effect !== effect), ...values.map(capability => ({ capability, effect })),
  ]);
  return <div className="editor-stack"><CapabilityPicker value={allow} onChange={next => update("allow", next)} patterns />
    <EditorSection title={`Explicit denials${deny.length ? ` (${deny.length})` : ""}`}>
      <p className="field-help">Deny a permission even when another role allows it.</p>
      <CapabilityPicker value={deny} onChange={next => update("deny", next)} patterns />
    </EditorSection>
  </div>;
}

export function EventsEditor({ value, onChange }: FieldEditorProps) {
  const selected = listValue(structuredValue(value));
  const groups = ["repository", "ref", "git", "issue", "pull_request", "review", "discussion", "task", "workflow", "run", "membership", "billing"];
  return <div className="editor-stack">
    <label className="option-row"><input type="checkbox" checked={selected.includes("*")}
      onChange={event => onChange(event.target.checked ? ["*"] : [])} /><span>All events</span></label>
    {!selected.includes("*") && <div className="choice-grid">{groups.map(group => <label key={group} className="option-row">
      <input type="checkbox" checked={selected.includes(`${group}.*`)} onChange={event => onChange(event.target.checked
        ? [...selected, `${group}.*`] : selected.filter(item => item !== `${group}.*`))} />{humanize(group)}
    </label>)}</div>}
    <EditorSection title="Specific events"><TokenInput label="Event names" value={selected.filter(item => !item.endsWith("*"))}
      placeholder="For example, issue.created…" onChange={next => onChange([...selected.filter(item => item.endsWith("*")), ...next])} /></EditorSection>
  </div>;
}
