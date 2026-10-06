import { useState } from "react";
import { record } from "../../api/types.ts";
import { structuredValue } from "../field-values.ts";
import type { FieldEditorProps } from "../field-types.ts";
import { AddRow, Control, RemoveRow, SelectControl } from "./controls.tsx";

type InputEntry = { name: string; value: unknown; type: string };

export function inputEntries(entries: InputEntry[]): Record<string, unknown> {
  const keys = new Set<string>();
  return Object.fromEntries(entries.map(entry => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(entry.name) || ["__proto__", "constructor", "prototype"].includes(entry.name))
      throw new Error("Use a unique input name beginning with a letter or underscore.");
    if (keys.has(entry.name)) throw new Error(`The input “${entry.name}” is listed twice.`);
    keys.add(entry.name);
    if (entry.type === "number" && (entry.value === "" || !Number.isFinite(Number(entry.value)))) throw new Error(`Enter a number for “${entry.name}”.`);
    return [entry.name, entry.type === "number" ? Number(entry.value) : entry.type === "boolean" ? entry.value === true || entry.value === "true" : entry.type === "null" ? null : String(entry.value ?? "")];
  }));
}

export function WorkflowInputsEditor({ value, onChange }: FieldEditorProps) {
  const [entries, setEntries] = useState<InputEntry[]>(() => Object.entries(record(structuredValue(value))).map(([name, value]) => ({
    name, value, type: value === null ? "null" : typeof value,
  })));
  const update = (next: InputEntry[]) => {
    setEntries(next);
    try { onChange(inputEntries(next)); } catch { /* Invalid rows remain editable; native controls explain and block submission. */ }
  };
  const replace = (index: number, next: Partial<InputEntry>) => update(entries.map((entry, position) => position === index ? { ...entry, ...next } : entry));
  return <div className="editor-stack">
    {!entries.length && <p className="field-help">The workflow’s default inputs will be used.</p>}
    {entries.map((entry, index) => <div className="input-entry" key={index}>
      <Control label="Input name">{id => <input id={id} value={entry.name} required pattern="[a-zA-Z_][a-zA-Z0-9_-]{0,63}" autoComplete="off" spellCheck={false}
        ref={element => { element?.setCustomValidity(entries.some((other, position) => position !== index && other.name === entry.name)
          ? "Each input needs a unique name." : ["__proto__", "constructor", "prototype"].includes(entry.name) ? "This input name is reserved." : ""); }}
        onChange={event => replace(index, { name: event.target.value })} />}</Control>
      <SelectControl label="Type" value={entry.type} onChange={type => replace(index, { type, value: type === "boolean" ? false : type === "number" ? 0 : type === "null" ? null : "" })}
        options={[{ value: "string", label: "Text" }, { value: "number", label: "Number" }, { value: "boolean", label: "Boolean" }, { value: "null", label: "None" }]} />
      {entry.type === "boolean" ? <SelectControl label="Value" value={String(entry.value)} onChange={value => replace(index, { value: value === "true" })} options={["true", "false"]} />
        : <Control label="Value">{id => <input id={id} type={entry.type === "number" ? "number" : "text"} step="any" disabled={entry.type === "null"}
          required={entry.type === "number"} value={String(entry.value ?? "")} autoComplete="off" onChange={event => replace(index, { value: event.target.value })} />}</Control>}
      <RemoveRow label={`Remove ${entry.name || "input"}`} onClick={() => update(entries.filter((_, position) => position !== index))} />
    </div>)}
    <AddRow onClick={() => update([...entries, { name: "", value: "", type: "string" }])}>Add an input</AddRow>
  </div>;
}
