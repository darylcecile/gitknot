import { useEffect, useState } from "react";
import { useCollection } from "../api/hooks.ts";
import { query } from "../api/endpoints.ts";
import { ApiError } from "../api/client.ts";
import { displayName, record, text, type Entity } from "../api/types.ts";
import { useAuth } from "../auth-context.ts";
import { Button, ErrorNotice } from "./ui.tsx";
import { ChevronDown, Check, Search } from "lucide-react";
import { Popover } from "./popover.tsx";

type Reference = {
  path: string; label: string; fallback?: string; kind?: string;
  child?: string; collections?: readonly string[]; discoverUsers?: boolean;
};

export function referenceFor(
  name: string,
  repoId: string,
  accountId: string,
  values: Record<string, unknown>,
  formPath = "",
): Reference | null {
  const repo = repoId ? `/v1/repos/${encodeURIComponent(repoId)}` : "";
  const account = accountId ? `/v1/accounts/${encodeURIComponent(accountId)}` : "";
  const people = {
    path: accountId.startsWith("org_") ? `/v1/orgs/${encodeURIComponent(accountId)}/members` : "/v1/users",
    fallback: "/v1/users",
  };
  const labels: Record<string, string> = {
    assignee_ids: "Assignees", reviewer_ids: "Reviewers", user_id: "Person",
    accountable_user_id: "Accountable person", contributor_ids: "Contributors",
    principal_ids: "Contributors", contributor_id: "Contributor", actor_id: "Person",
    author_id: "Author", assignee_id: "Assignee", actor_ids: "People",
    required_approver_ids: "Required approvers", allowed_approvers: "Required approvers",
    user_ids: formPath.includes("review") ? "Reviewers" : "Assignees",
  };
  if (labels[name]) return { ...people, label: labels[name] };
  if (name === "principal_id") {
    const kind = text(values.principal_type, "user");
    if (kind === "user") return { ...people, label: "Person" };
    if (kind === "team" && accountId.startsWith("org_"))
      return { path: `/v1/orgs/${encodeURIComponent(accountId)}/teams`, label: "Team" };
    if (["viewer", "runner"].includes(kind)) return { path: "/v1/tokens", label: "Identity", kind };
    if (account) return { path: `${account}/${kind === "application" ? "applications" : "identities"}`, label: "Identity", kind };
  }
  if (["repo_id", "repository_id", "head_repo_id", "repository_ids", "repo_ids"].includes(name))
    return { path: "/v1/repos", label: name === "head_repo_id" ? "Source repository" : name.endsWith("s") ? "Repositories" : "Repository" };
  if (["account_id", "account_ids", "owner_id", "destination_owner_id"].includes(name))
    return { path: "/v1/accounts", label: name === "account_ids" ? "Accounts" : name.includes("owner") ? "Owner" : "Account", discoverUsers: name === "destination_owner_id" };
  if (name === "item_id" || name === "subject_id")
    return { path: repo, label: "Conversation", collections: ["issues", "pulls", "discussions", "tasks"] };
  if (name === "scope_id") {
    const scope = text(values.scope);
    if (scope === "actor") return { ...people, label: "Person" };
    if (scope === "team") return { path: `/v1/orgs/${encodeURIComponent(accountId)}/teams`, label: "Team" };
    if (scope === "account") return { path: "/v1/accounts", label: "Account" };
    if (scope === "repository" || scope === "workflow") return {
      path: query("/v1/repos", { owner_id: accountId }),
      label: scope === "workflow" ? "Workflow" : "Repository",
      ...(scope === "workflow" ? { child: "workflows" } : {}),
    };
  }
  const catalogs: Record<string, [string, string]> = {
    label_ids: ["labels", "Labels"], label_id: ["labels", "Label"],
    milestone_id: ["milestones", "Milestone"], status_id: ["issues/statuses", "Status"],
    template_id: ["issues/templates", "Template"], category_id: ["discussions/categories", "Category"],
    issue_id: ["issues", "Issue"], duplicate_of_id: ["issues", "Original issue"],
    depends_on_id: [formPath.includes("/pulls/") ? "pulls" : "issues", "Depends on"],
    pull_id: ["pulls", "Pull request"], task_id: ["tasks", "Task"],
    environment_id: ["environments", "Environment"], environment_ids: ["environments", "Environments"],
    rule_ids: ["rules", "Rules"], replace_rule_id: ["rules", "Rule"], workflow_ids: ["workflows", "Workflows"],
    source_secret_id: ["secrets", "Source credential"],
    archive_id: ["backups", "Recovery archive"],
  };
  if (repo && catalogs[name]) {
    const [path, label] = catalogs[name];
    return { path: `${repo}/${path}`, label };
  }
  if (name === "role_id" && (repo || account)) return { path: `${repo || account}/roles`, label: "Role" };
  if (["team_id", "team_ids"].includes(name) && accountId.startsWith("org_")) return { path: `/v1/orgs/${encodeURIComponent(accountId)}/teams`, label: "Team" };
  if (name === "workflow_ids" && !repo) return { path: query("/v1/repos", { owner_id: accountId }), label: "Workflows", child: "workflows" };
  if (name === "credential_id") return { path: "/v1/tokens", label: "Credential" };
  if (account && ["application_id", "installation_id"].includes(name))
    return { path: `${account}/${name === "application_id" ? "applications" : "installations"}`, label: name === "application_id" ? "Application" : "Installation" };
  return null;
}

function choice(item: Entity, principal: boolean) {
  const value = text(principal ? item.principal_id || item.id : item.id);
  const name = displayName(item);
  const owner = text(item.owner_slug || record(item.owner).slug);
  const label = item.username ? `${name} (@${text(item.username)})`
    : owner ? `${owner}/${text(item.name)}`
      : item.number ? `#${text(item.number)} · ${name}`
        : item.slug && item.slug !== name ? `${name} (${text(item.slug)})`
        : name === value ? `${text(item.kind, "Saved item")} · ${text(item.created_at).slice(0, 10) || "current"}` : name;
  return { value, label };
}

export function ReferencePicker({
  id, name, reference, value, onChange, multiple, required, disabled, help, error: validationError,
}: {
  id: string; name: string; reference: Reference; value: unknown;
  onChange: (value: string | string[]) => void; multiple: boolean; required?: boolean; disabled?: boolean;
  help?: string; error?: string;
}) {
  const user = useAuth().session?.user;
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [known, setKnown] = useState<Record<string, string>>({});
  const [parentId, setParentId] = useState("");
  const [category, setCategory] = useState(reference.collections?.[0] || "");
  const [open, setOpen] = useState(false);
  const selected = Array.isArray(value) ? value.map(String) : text(value).split(",").map(item => item.trim()).filter(Boolean);
  const active = open || selected.length > 0;
  useEffect(() => { const timer = setTimeout(() => setTerm(search), 200); return () => clearTimeout(timer); }, [search]);
  const path = reference.collections ? (reference.path ? `${reference.path}/${category}` : "") : reference.path;
  const primary = useCollection<Entity>(path && active ? query(path, { limit: 100, q: path === "/v1/users" ? term : undefined }) : null);
  const extraPath = reference.discoverUsers ? "/v1/users" : reference.fallback !== path ? reference.fallback : null;
  const fallback = useCollection<Entity>(extraPath && active ? query(extraPath, { limit: 100, q: term }) : null);
  const denied = primary.error instanceof ApiError && [403, 404].includes(primary.error.status);
  const nested = useCollection<Entity>(reference.child && parentId ? query(`/v1/repos/${encodeURIComponent(parentId)}/${reference.child}`, { limit: 100 }) : null);
  const collection = reference.child ? nested : denied && extraPath ? fallback : primary;
  const people = reference.path === "/v1/users" || reference.path.endsWith("/members");
  const choices = [...new Map([
    ...(people && user ? [user] : []), ...collection.items, ...(collection !== fallback && !reference.child ? fallback.items : []),
  ].filter(item => !item.deleted_at && item.state !== "deleted" && item.state !== "suspended"
    && (!reference.kind || !item.kind || item.kind === reference.kind))
    .map(item => choice(item, name === "principal_id" || reference.path.endsWith("/members")))
    .filter(item => item.value).map(item => [item.value, item])).values()];
  const labels = Object.fromEntries(choices.map(item => [item.value, item.label]));
  const signature = JSON.stringify(labels);
  useEffect(() => { setKnown(previous => ({ ...previous, ...JSON.parse(signature) })); }, [signature]);
  const visible = choices.filter(item => item.label.toLowerCase().includes(search.toLowerCase()));
  const error = collection.error || collection.moreError || (reference.child ? primary.error : fallback.error);
  const toggle = (key: string) => onChange(selected.includes(key) ? selected.filter(item => item !== key) : [...selected, key]);

  const summary = selected.length ? selected.map(key => known[key] || labels[key] || "Current selection").join(", ")
    : `Choose ${reference.label.toLowerCase()}…`;
  return (
    <fieldset className="field reference-picker" disabled={disabled} data-field={name} aria-invalid={!!validationError || undefined}>
      <legend id={`${id}-label`}>{reference.label}{required && <span className="required" aria-hidden="true"> *</span>}</legend>
      <Popover id={`${id}-choices`} label={`${reference.label}: ${summary}`} className="reference-popover" onOpenChange={setOpen}
        trigger={<><span className={selected.length ? "" : "muted"}>{summary}</span>{multiple && selected.length > 1 && <span className="selection-count">{selected.length}</span>}<ChevronDown size={14} aria-hidden="true" /></>}>
        {close => <div className="reference-popup">
      {reference.child && <select aria-label={`Repository for ${reference.label.toLowerCase()}`} value={parentId} onChange={event => { setParentId(event.target.value); onChange(""); }}>
        <option value="">Choose a repository</option>
        {primary.items.map(item => { const option = choice(item, false); return <option key={option.value} value={option.value}>{option.label}</option>; })}
      </select>}
      {reference.child && primary.cursor && <Button onClick={() => void primary.loadMore()} busy={primary.loadingMore}>More repositories</Button>}
      {reference.collections && <select aria-label="Conversation type" value={category} onChange={event => { setCategory(event.target.value); onChange(""); }}>
        {reference.collections.map(kind => <option key={kind} value={kind}>{kind === "pulls" ? "Pull requests" : kind[0]!.toUpperCase() + kind.slice(1)}</option>)}
      </select>}
      <div className="picker-search"><Search size={15} aria-hidden="true" /><input type="search" aria-label={`Search ${reference.label.toLowerCase()}`} placeholder={`Find ${reference.label.toLowerCase()}…`}
        value={search} maxLength={100} onChange={event => setSearch(event.target.value)} /></div>
      {multiple ? (
        <>
          {selected.filter(key => !visible.some(item => item.value === key)).map(key => <label className="reference-current" key={key}>
            <input type="checkbox" checked onChange={() => toggle(key)} />{known[key] || labels[key] || "Current selection"}
          </label>)}
          <div className="reference-options" role="group" aria-labelledby={`${id}-label`}>
            {visible.map(item => <label key={item.value}>
              <input type="checkbox" checked={selected.includes(item.value)} onChange={() => toggle(item.value)} />{item.label}
            </label>)}
          </div>
        </>
      ) : (
        <div className="reference-options" role="group" aria-labelledby={`${id}-label`}>
          {!required && <button type="button" onClick={() => { onChange(""); close(); }}>None</button>}
          {visible.map(item => <button type="button" key={item.value} aria-pressed={selected[0] === item.value}
            onClick={() => { onChange(item.value); close(); }}><span>{item.label}</span>{selected[0] === item.value && <Check size={15} aria-hidden="true" />}</button>)}
        </div>
      )}
      {collection.loading && <span role="status" className="field-help">Loading choices…</span>}
      {!collection.loading && !visible.length && !error && <p className="field-help">{search ? "No matching choices on this page." : "No choices available yet."}</p>}
      <ErrorNotice error={error} retry={collection.refresh} />
      {collection.cursor && <Button onClick={() => void collection.loadMore()} busy={collection.loadingMore}>Load more choices</Button>}
      {collection !== fallback && fallback.cursor && <Button onClick={() => void fallback.loadMore()} busy={fallback.loadingMore}>More people</Button>}
      {multiple && <div className="picker-footer"><span>{selected.length} selected</span><Button variant="ghost" onClick={() => onChange([])}>Clear</Button><Button onClick={() => close()}>Done</Button></div>}
        </div>}
      </Popover>
      {help && <p className="field-help">{help}</p>}
      {validationError && <p className="field-error">{validationError}</p>}
    </fieldset>
  );
}
