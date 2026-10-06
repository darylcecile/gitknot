import { useEffect, useState } from "react";
import { array, record, text } from "../../api/types.ts";
import type { FieldContext, FieldEditorProps } from "../field-types.ts";
import { structuredValue, listValue } from "../field-values.ts";
import { Button } from "../ui.tsx";
import { AddRow, Control, EditorSection, ReferenceControl, RemoveRow, SelectControl, TextControl, Toggle, TokenInput, updateProperty } from "./controls.tsx";

export const protectedBranchRule = {
  version: 1, target: "refs/heads/main", updates: "pull_request_only",
  reviews: { minimum: 1, disallow_author_approval: true, resolved_threads: true },
  history: { allow_force_push: false, allow_deletion: false },
};

export function validateRule(value: unknown): string | undefined {
  const rule = record(value);
  if (!listValue(rule.target).length) return "Choose at least one branch or tag pattern.";
  if (listValue(rule.target).some(target => !/^refs\/(heads|tags|notes)\/.+/.test(target))) return "Use a full ref pattern, such as refs/heads/main.";
  const verification = record(rule.verification);
  if (listValue(verification.required).length && !listValue(verification.trusted_producers).length)
    return "Choose a trusted producer for the required checks.";
  if (Object.entries(record(record(rule.reviews).required_owners)).some(([path, owners]) => !path.trim() || !listValue(owners).length))
    return "Choose at least one owner for each path pattern.";
  return undefined;
}

export function BranchRuleEditor({ value, onChange, context }: FieldEditorProps) {
  const rule = record(structuredValue(value));
  const update = (key: string, next: unknown) => onChange(updateProperty(rule, key, next));
  const nested = (section: string, key: string, next: unknown) => update(section, updateProperty(record(rule[section]), key, next));
  const reviews = record(rule.reviews);
  const history = record(rule.history);
  const signatures = record(rule.signatures);
  const files = record(rule.files);
  const verification = record(rule.verification);
  return <div className="editor-stack">
    <div className="preset-bar"><span>Start with</span>
      <Button variant="ghost" onClick={() => onChange({ ...protectedBranchRule, target: rule.target || protectedBranchRule.target })}>Protected branch</Button>
      <Button variant="ghost" onClick={() => onChange({ version: 1, target: "refs/tags/v*", history: { allow_force_push: false, allow_deletion: false }, signatures: { tags: true, annotated_tags: true } })}>Release tags</Button>
    </div>
    <TokenInput label="Branches and tags" value={rule.target} onChange={next => update("target", next)} required placeholder="refs/heads/main…" />
    <SelectControl label="Changes to these refs" value={rule.updates || "any"} onChange={next => update("updates", next)} options={[
      { value: "any", label: "Allow direct pushes" }, { value: "pull_request_only", label: "Require a pull request" }, { value: "blocked", label: "Block all updates" },
    ]} />
    <div className="choice-grid">
      <Toggle label="Prevent force pushes" checked={history.allow_force_push === false} onChange={checked => nested("history", "allow_force_push", !checked)} />
      <Toggle label="Prevent deletion" checked={history.allow_deletion === false} onChange={checked => nested("history", "allow_deletion", !checked)} />
    </div>
    <EditorSection title={`Reviews${Number(reviews.minimum) > 0 ? ` · ${reviews.minimum} required` : ""}`}>
      <TextControl label="Required approvals" type="number" min={0} max={100} value={reviews.minimum ?? 0} onChange={next => nested("reviews", "minimum", Number(next))} />
      <Toggle label="Exclude the author’s approval" checked={reviews.disallow_author_approval === true} onChange={next => nested("reviews", "disallow_author_approval", next)} />
      <Toggle label="Resolve conversations before merging" checked={reviews.resolved_threads === true} onChange={next => nested("reviews", "resolved_threads", next)} />
      <ReferenceControl name="reviewer_ids" label="Required reviewers" value={reviews.required_reviewers} context={context} onChange={next => nested("reviews", "required_reviewers", next)} />
      <PathOwners value={reviews.required_owners} context={context} onChange={next => nested("reviews", "required_owners", next)} />
    </EditorSection>
    <EditorSection title="Required checks">
      <TokenInput label="Check names" value={verification.required} onChange={next => nested("verification", "required", next)} placeholder="For example, test…" />
      <TokenInput label="Trusted producers" value={verification.trusted_producers} onChange={next => update("verification", { required: [], ...verification, trusted_producers: next })} placeholder="Producer identity…" />
      <Toggle label="Check the exact merge candidate" checked={verification.revision === "merge_candidate"} onChange={checked => update("verification", updateProperty({ required: [], ...verification }, "revision", checked ? "merge_candidate" : undefined))} />
      <EditorSection title="Combine checks with all / any conditions">
        {verification.expression ? <>
          <CheckExpression value={record(verification.expression)} onChange={next => update("verification", { required: [], ...verification, expression: next })} />
          <Button variant="ghost" onClick={() => update("verification", updateProperty(verification, "expression", undefined))}>Remove check conditions</Button>
        </> : <AddRow onClick={() => update("verification", { required: [], ...verification, expression: { type: "all", checks: [{ type: "check", key: "", producers: [] }] } })}>Add check conditions</AddRow>}
      </EditorSection>
    </EditorSection>
    <EditorSection title="History and merge methods">
      <Toggle label="Require linear history" checked={history.linear === true} onChange={next => nested("history", "linear", next)} />
      <Toggle label="Prevent creation of matching refs" checked={history.allow_creation === false} onChange={next => nested("history", "allow_creation", !next)} />
      <SelectControl label="Allowed merge methods" value={rule.merge_strategies ? "selected" : "all"} onChange={next => update("merge_strategies", next === "all" ? undefined : ["merge", "squash", "rebase", "ff-only"])} options={[{ value: "all", label: "All methods" }, { value: "selected", label: "Choose methods" }]} />
      {rule.merge_strategies !== undefined && <div className="choice-grid">{["merge", "squash", "rebase", "ff-only"].map(strategy => <Toggle key={strategy} label={strategy === "ff-only" ? "Fast-forward only" : strategy[0]!.toUpperCase() + strategy.slice(1)}
        checked={listValue(rule.merge_strategies).includes(strategy)} onChange={checked => update("merge_strategies", checked ? [...listValue(rule.merge_strategies), strategy] : listValue(rule.merge_strategies).filter(item => item !== strategy))} />)}</div>}
    </EditorSection>
    <EditorSection title="Files and signatures">
      <TokenInput label="Blocked paths" value={files.denied_paths} onChange={next => nested("files", "denied_paths", next)} placeholder="For example, secrets/**…" />
      <TokenInput label="Allowed paths" value={files.allowed_paths} onChange={next => nested("files", "allowed_paths", next.length ? next : undefined)} placeholder="All paths by default…" />
      <TextControl label="Maximum file size (bytes)" type="number" min={1} value={files.max_bytes} onChange={next => nested("files", "max_bytes", next ? Number(next) : undefined)} />
      <Toggle label="Block detected secrets" checked={files.block_secrets === true} onChange={next => nested("files", "block_secrets", next)} />
      <Toggle label="Inspect every supplied object" checked={files.inspect_all_supplied_objects === true} onChange={next => nested("files", "inspect_all_supplied_objects", next)} />
      <Toggle label="Require signed commits" checked={signatures.commits === true} onChange={next => nested("signatures", "commits", next)} />
      <Toggle label="Require signed tags" checked={signatures.tags === true} onChange={next => nested("signatures", "tags", next)} />
      <Toggle label="Require annotated tags" checked={signatures.annotated_tags === true} onChange={next => nested("signatures", "annotated_tags", next)} />
    </EditorSection>
    <EditorSection title="Push access and emergency bypass">
      <ReferenceControl name="principal_ids" label="Who can push" context={context} value={record(rule.push).allowed_principals}
        onChange={next => update("push", listValue(next).length ? { ...record(rule.push), allowed_principals: next } : undefined)} />
      <Toggle label="Allow an audited emergency bypass" checked={Boolean(rule.bypass)} onChange={checked => update("bypass", checked ? { capability: "rules.break_glass", reason_required: true, maximum_duration_seconds: 900 } : undefined)} />
      {rule.bypass !== undefined && <TextControl label="Maximum bypass duration (minutes)" type="number" min={1 / 60} max={30} step="any" value={Number(record(rule.bypass).maximum_duration_seconds) / 60}
        onChange={next => nested("bypass", "maximum_duration_seconds", Math.round(Number(next) * 60))} />}
    </EditorSection>
  </div>;
}

function PathOwners({ value, onChange, context }: { value: unknown; onChange: (value: Record<string, unknown>) => void; context: FieldContext }) {
  const [entries, setEntries] = useState(() => Object.entries(record(value)));
  useEffect(() => setEntries(Object.entries(record(value))), [value]);
  const update = (next: [string, unknown][]) => {
    setEntries(next);
    if (next.every(([path]) => path.trim()) && new Set(next.map(([path]) => path)).size === next.length)
      onChange(Object.fromEntries(next));
  };
  return <div className="editor-stack"><p className="field-label">Code owners by path</p>
    {entries.map(([path, owners], index) => <div className="editable-row" key={index}>
      <Control label="Path pattern">{id => <input id={id} value={path} required autoComplete="off" spellCheck={false}
        ref={element => { element?.setCustomValidity(entries.some(([other], position) => index !== position && other === path) ? "Each path pattern needs to be unique." : ""); }}
        onChange={event => update(entries.map((entry, position) => position === index ? [event.target.value, owners] : entry))} />}</Control>
      <ReferenceControl name="reviewer_ids" label="Owners" context={context} value={owners} onChange={next => update(entries.map((entry, position) => position === index ? [path, next] : entry))} required />
      <RemoveRow label={`Remove owners for ${path || "path"}`} onClick={() => update(entries.filter((_, position) => position !== index))} />
    </div>)}
    <AddRow onClick={() => update([...entries, ["", []]])}>Add path owners</AddRow>
  </div>;
}

function CheckExpression({ value, onChange, depth = 1 }: { value: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void; depth?: number }) {
  const checks = array<Record<string, unknown>>(value.checks);
  const update = (key: string, next: unknown) => onChange(updateProperty(value, key, next));
  return <div className="check-expression editor-stack">
    <SelectControl label="Condition" value={value.type} onChange={type => onChange(type === "check" ? { type, key: "", producers: [] } : { type, checks: [{ type: "check", key: "", producers: [] }] })}
      options={[{ value: "check", label: "A check passes" }, ...(depth < 8 ? [{ value: "all", label: "All conditions pass" }, { value: "any", label: "Any condition passes" }] : [])]} />
    {value.type === "check" ? <>
      <TextControl label="Check name" value={value.key} onChange={next => update("key", next)} required />
      <TokenInput label="Producers" value={value.producers} onChange={next => update("producers", next)} required />
      <TextControl label="Workflow digest (optional)" value={value.workflow_digest} onChange={next => update("workflow_digest", next)} />
      <TokenInput label="Include paths" value={record(value.paths).include} onChange={next => update("paths", { exclude: [], ...record(value.paths), include: next })} />
      <TokenInput label="Exclude paths" value={record(value.paths).exclude} onChange={next => update("paths", { include: [], ...record(value.paths), exclude: next })} />
    </> : <>
      {checks.map((check, index) => <div className="check-child" key={index}><CheckExpression value={check} depth={depth + 1} onChange={next => update("checks", checks.map((item, position) => position === index ? next : item))} />
        {checks.length > 1 && <RemoveRow label="Remove condition" onClick={() => update("checks", checks.filter((_, position) => position !== index))} />}</div>)}
      <AddRow onClick={() => update("checks", [...checks, { type: "check", key: "", producers: [] }])}>Add condition</AddRow>
    </>}
  </div>;
}

export function RulePreviewEditor(props: FieldEditorProps) {
  const value = record(structuredValue(props.value));
  return <div className="editor-stack">
    <TextControl label="Rule name" value={value.name} onChange={name => props.onChange({ ...value, name })} required />
    <SelectControl label="Enforcement" value={value.enforcement || "active"} onChange={enforcement => props.onChange({ ...value, enforcement })}
      options={[{ value: "active", label: "Active" }, { value: "evaluate", label: "Evaluate only" }, { value: "disabled", label: "Disabled" }]} />
    <BranchRuleEditor {...props} value={value.config} onChange={config => props.onChange({ ...value, config })} />
  </div>;
}
