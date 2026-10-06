import { useEffect, useState } from "react";
import { useCollection } from "../api/hooks.ts";
import { query } from "../api/endpoints.ts";
import { ApiError } from "../api/client.ts";
import { displayName, record, text, type Entity } from "../api/types.ts";
import { useAuth } from "../auth-context.ts";
import { Button, ErrorNotice } from "./ui.tsx";

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
    environment_id: ["environments", "Environment"], rule_ids: ["rules", "Rules"],
    archive_id: ["backups", "Recovery archive"],
  };
  if (repo && catalogs[name]) {
    const [path, label] = catalogs[name];
    return { path: `${repo}/${path}`, label };
  }
  if (name === "role_id" && (repo || account)) return { path: `${repo || account}/roles`, label: "Role" };
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
  id, name, reference, value, onChange, multiple, required, disabled, help,
}: {
  id: string; name: string; reference: Reference; value: unknown;
  onChange: (value: string | string[]) => void; multiple: boolean; required?: boolean; disabled?: boolean;
  help?: string;
}) {
  const user = useAuth().session?.user;
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [known, setKnown] = useState<Record<string, string>>({});
  const [parentId, setParentId] = useState("");
  const [category, setCategory] = useState(reference.collections?.[0] || "");
  useEffect(() => { const timer = setTimeout(() => setTerm(search), 200); return () => clearTimeout(timer); }, [search]);
  const path = reference.collections ? (reference.path ? `${reference.path}/${category}` : "") : reference.path;
  const primary = useCollection<Entity>(path ? query(path, { limit: 100, q: path === "/v1/users" ? term : undefined }) : null);
  const extraPath = reference.discoverUsers ? "/v1/users" : reference.fallback !== path ? reference.fallback : null;
  const fallback = useCollection<Entity>(extraPath ? query(extraPath, { limit: 100, q: term }) : null);
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
  const selected = Array.isArray(value) ? value.map(String) : text(value).split(",").map(item => item.trim()).filter(Boolean);
  const visible = choices.filter(item => item.label.toLowerCase().includes(search.toLowerCase()));
  const error = collection.error || collection.moreError || (reference.child ? primary.error : fallback.error);
  const toggle = (key: string) => onChange(selected.includes(key) ? selected.filter(item => item !== key) : [...selected, key]);

  return (
    <fieldset className="field reference-picker" disabled={disabled}>
      <legend id={`${id}-label`}>{reference.label}{required && <span className="required" aria-hidden="true"> *</span>}</legend>
      {reference.child && <select aria-label={`Repository for ${reference.label.toLowerCase()}`} value={parentId} onChange={event => { setParentId(event.target.value); onChange(""); }}>
        <option value="">Choose a repository</option>
        {primary.items.map(item => { const option = choice(item, false); return <option key={option.value} value={option.value}>{option.label}</option>; })}
      </select>}
      {reference.child && primary.cursor && <Button onClick={() => void primary.loadMore()} busy={primary.loadingMore}>More repositories</Button>}
      {reference.collections && <select aria-label="Conversation type" value={category} onChange={event => { setCategory(event.target.value); onChange(""); }}>
        {reference.collections.map(kind => <option key={kind} value={kind}>{kind === "pulls" ? "Pull requests" : kind[0]!.toUpperCase() + kind.slice(1)}</option>)}
      </select>}
      <input type="search" aria-label={`Search ${reference.label.toLowerCase()}`} placeholder={`Find ${reference.label.toLowerCase()}…`}
        value={search} maxLength={100} onChange={event => setSearch(event.target.value)} />
      {multiple ? (
        <>
          {selected.length > 0 && <div className="reference-selected">{selected.map(key => (
            <Button key={key} onClick={() => toggle(key)} aria-label={`Remove ${known[key] || labels[key] || "selected item"}`}>
              {known[key] || labels[key] || "Selected item"} ×
            </Button>
          ))}</div>}
          <div className="reference-options" role="group" aria-labelledby={`${id}-label`}>
            {visible.map(item => <label key={item.value}>
              <input type="checkbox" checked={selected.includes(item.value)} onChange={() => toggle(item.value)} />{item.label}
            </label>)}
          </div>
        </>
      ) : (
        <select id={id} name={name} aria-labelledby={`${id}-label`} required={required} value={selected[0] || ""} onChange={event => onChange(event.target.value)}>
          <option value="">{required ? "Choose an option" : "None"}</option>
          {selected[0] && !visible.some(item => item.value === selected[0]) && <option value={selected[0]}>{known[selected[0]] || "Current selection"}</option>}
          {visible.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
      )}
      {collection.loading && <span role="status" className="field-help">Loading choices…</span>}
      {!collection.loading && !visible.length && !error && <p className="field-help">{search ? "No matching choices on this page." : "No choices available yet."}</p>}
      <ErrorNotice error={error} retry={collection.refresh} />
      {collection.cursor && <Button onClick={() => void collection.loadMore()} busy={collection.loadingMore}>Load more choices</Button>}
      {collection !== fallback && fallback.cursor && <Button onClick={() => void fallback.loadMore()} busy={fallback.loadingMore}>More people</Button>}
      {help && <p className="field-help">{help}</p>}
    </fieldset>
  );
}
