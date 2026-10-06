import { useEffect, useRef, useState } from "react";
import { GitBranch } from "lucide-react";
import { request } from "../../api/client.ts";
import { query } from "../../api/endpoints.ts";
import { useCollection } from "../../api/hooks.ts";
import { array, record, text, type Entity } from "../../api/types.ts";
import type { FieldEditorProps } from "../field-types.ts";
import { structuredValue } from "../field-values.ts";
import { Button, ErrorNotice } from "../ui.tsx";
import { AddRow, Control, EditorSection, ReferenceControl, RemoveRow, TextControl } from "./controls.tsx";

export function validateRevision(value: unknown): string | undefined {
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(text(record(value).commit_oid))
    ? undefined : "Choose a branch or enter a full commit ID.";
}

export function validateBranchRevision(value: unknown): string | undefined {
  return validateRevision(value) || (!text(record(value).ref).trim() ? "Choose a source branch or enter its full ref." : undefined);
}

export function RevisionEditor({ value, onChange, context, id, label = "Branch or tag", disabled }: FieldEditorProps) {
  const selection = record(structuredValue(value));
  const repoId = context.repoId;
  const refs = useCollection<Entity>(repoId ? `/v1/repos/${encodeURIComponent(repoId)}/refs` : null);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), [repoId]);
  const select = (ref: string) => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    onChange({ ...selection, ref, commit_oid: "" });
    setError(null);
    if (!ref) { setResolving(false); return; }
    setResolving(true);
    void request<Entity>(query(`/v1/repos/${encodeURIComponent(repoId)}/commits`, { ref, limit: 1 }), { signal: current.signal })
      .then(result => {
        const commit = text(result.data.revision || array<Entity>(result.data.items)[0]?.oid);
        if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(commit)) throw new Error("This ref has no readable commit. Choose another branch.");
        if (!current.signal.aborted) onChange({ ...selection, ref, commit_oid: commit });
      }).catch(cause => { if (!current.signal.aborted) setError(cause instanceof Error ? cause : new Error("Could not read this revision.")); })
      .finally(() => { if (!current.signal.aborted) setResolving(false); });
  };
  useEffect(() => {
    if (repoId && selection.ref && !selection.commit_oid) select(text(selection.ref));
  }, [repoId]);
  return <div className="editor-stack">
    <div className="revision-select"><GitBranch size={16} aria-hidden="true" /><select id={id} aria-label={label} value={text(selection.ref)}
      onChange={event => select(event.target.value)} disabled={disabled || !repoId}>
      <option value="">{repoId ? "Choose a branch or tag…" : "Choose a repository first"}</option>
      {selection.ref && !refs.items.some(item => item.ref === selection.ref) ? <option value={text(selection.ref)}>{text(selection.ref)}</option> : null}
      {refs.items.map(item => <option key={text(item.ref)} value={text(item.ref)}>{text(item.ref).replace(/^refs\/(heads|tags)\//, "")}</option>)}
    </select></div>
    {resolving ? <p className="field-help" role="status">Resolving the exact commit…</p>
      : selection.commit_oid ? <p className="field-help">Pinned to <code>{text(selection.commit_oid).slice(0, 12)}</code></p> : null}
    <ErrorNotice error={error || refs.error} retry={() => selection.ref ? select(text(selection.ref)) : refs.refresh()} />
    {refs.cursor && <Button busy={refs.loadingMore} onClick={() => void refs.loadMore()}>More branches</Button>}
    <EditorSection title="Use a specific commit">
      <TextControl label="Full commit ID" value={selection.commit_oid}
        onChange={commit_oid => { controller.current?.abort(); setResolving(false); onChange({ ...selection, commit_oid }); }} />
      <TextControl label="Source ref" value={selection.ref} placeholder="refs/heads/main…" onChange={ref => onChange({ ...selection, ref })} />
    </EditorSection>
  </div>;
}

export function HeadRevisionEditor(props: FieldEditorProps) {
  const repoId = text(props.context.values.head_repo_id) || props.context.repoId;
  return <RevisionEditor key={repoId} {...props} context={{ ...props.context, repoId }} />;
}

export function ScanRepositoriesEditor(props: FieldEditorProps) {
  const repositories = array<Record<string, unknown>>(structuredValue(props.value));
  const update = (index: number, next: Record<string, unknown>) => props.onChange(repositories.map((item, position) => position === index ? next : item));
  return <div className="editor-stack">
    {repositories.map((item, index) => <div className="revision-row" key={index}>
      <ReferenceControl name="repo_id" label="Repository" value={item.repo_id} context={props.context} multiple={false} required
        onChange={repo_id => update(index, { repo_id, commit_oid: "" })} />
      <Control label="Revision">{id => <RevisionEditor {...props} id={id} label="Branch or tag" value={item} context={{ ...props.context, repoId: text(item.repo_id) }}
        onChange={next => update(index, { repo_id: item.repo_id, commit_oid: record(next).commit_oid, ref: record(next).ref })} />}</Control>
      <RemoveRow label={`Remove repository ${index + 1}`} onClick={() => props.onChange(repositories.filter((_, position) => position !== index))} />
    </div>)}
    <AddRow onClick={() => props.onChange([...repositories, { repo_id: "", commit_oid: "" }])}>Add a repository</AddRow>
    <p className="field-help">Each repository is scanned at the selected commit, even if its branch changes.</p>
  </div>;
}

export function validateScanRepositories(value: unknown) {
  const repositories = array<Record<string, unknown>>(value);
  if (!repositories.length) return "Add at least one repository to scan.";
  if (repositories.some(item => !item.repo_id || validateRevision(item))) return "Choose a repository and a revision for every scan target.";
  if (new Set(repositories.map(item => item.repo_id)).size !== repositories.length) return "Choose one revision per repository.";
  return undefined;
}
