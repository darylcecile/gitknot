import { record, text } from "../../api/types.ts";
import type { FieldEditorProps } from "../field-types.ts";
import { listValue, structuredValue } from "../field-values.ts";
import { Button } from "../ui.tsx";
import { CapabilityPicker } from "./permissions.tsx";
import { EditorSection, ReferenceControl, SelectControl, TextControl, Toggle, TokenInput, updateProperty } from "./controls.tsx";

function localDate(value: unknown) {
  if (!value) return "";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? "" : new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function DateControl({ label, value, onChange }: { label: string; value: unknown; onChange: (value: string | undefined) => void }) {
  return <TextControl label={label} type="datetime-local" value={localDate(value)}
    onChange={next => onChange(next ? new Date(next).toISOString() : undefined)} />;
}

export function ScopeConditionsEditor({ value, onChange }: FieldEditorProps) {
  const conditions = record(structuredValue(value));
  const update = (key: string, next: unknown) => onChange(updateProperty(conditions, key, next));
  return <div className="editor-stack">
    <p className="field-help">Applies to all refs and paths unless you narrow the scope.</p>
    <TokenInput label="Only these refs" value={conditions.refs} onChange={next => update("refs", next.length ? next : undefined)} placeholder="refs/heads/main…" />
    <TokenInput label="Only these paths" value={conditions.paths} onChange={next => update("paths", next.length ? next : undefined)} placeholder="For example, src/**…" />
    <Toggle label="Require two-factor authentication" checked={conditions.require_mfa === true} onChange={next => update("require_mfa", next)} />
    <div className="choice-grid"><DateControl label="Active from" value={conditions.not_before} onChange={next => update("not_before", next)} />
      <DateControl label="Active until" value={conditions.expires_at} onChange={next => update("expires_at", next)} /></div>
  </div>;
}

export function vaultDefaults(repoId: string) {
  return { version: 1, enabled: true, repository_ids: repoId ? [repoId] : [], workflow_ids: null, actor_ids: null,
    environment_ids: null, refs: null, allow_cross_account: false, allow_self_hosted: false, runner_pool_ids: [],
    require_environment: false, not_before: null, expires_at: null };
}

export function VaultPolicyEditor({ value, onChange, context }: FieldEditorProps) {
  const policy = record(structuredValue(value));
  const update = (key: string, next: unknown) => onChange({ ...policy, [key]: next });
  if (!Object.keys(policy).length) return <div className="default-setting">
    <p>Uses the default access for this {context.repoId ? "repository" : "account"}.</p>
    <Button onClick={() => onChange(vaultDefaults(context.repoId))}>Customize access</Button>
  </div>;
  const repo = context.repoId ? `/v1/repos/${encodeURIComponent(context.repoId)}` : "";
  return <div className="editor-stack">
    <Toggle label="Available to workflows" checked={policy.enabled !== false} onChange={next => update("enabled", next)} />
    <ReferenceControl name="repository_ids" label="Allowed repositories" value={policy.repository_ids} onChange={next => update("repository_ids", next)} context={context} />
    <EditorSection title="Workflow and identity restrictions">
      {[{ key: "workflow_ids", name: "workflow_ids", label: "Workflows", path: repo ? `${repo}/workflows` : undefined },
        { key: "actor_ids", name: "user_ids", label: "People" },
        { key: "environment_ids", name: "environment_ids", label: "Environments", path: repo ? `${repo}/environments` : undefined }].map(scope => <div className="editor-stack" key={scope.key}>
          <Toggle label={`Restrict ${scope.label.toLowerCase()}`} checked={policy[scope.key] !== null && policy[scope.key] !== undefined}
            onChange={checked => update(scope.key, checked ? [] : null)} />
          {policy[scope.key] !== null && policy[scope.key] !== undefined && <ReferenceControl name={scope.name} label={`Allowed ${scope.label.toLowerCase()}`} value={policy[scope.key]}
            context={context} path={scope.path} onChange={next => update(scope.key, next)} />}
        </div>)}
      <Toggle label="Restrict branches and tags" checked={policy.refs !== null && policy.refs !== undefined} onChange={checked => update("refs", checked ? [] : null)} />
      {policy.refs !== null && policy.refs !== undefined && <TokenInput label="Allowed refs" value={policy.refs} onChange={next => update("refs", next)} placeholder="refs/heads/main…" />}
      <Toggle label="Require an environment" checked={policy.require_environment === true} onChange={next => update("require_environment", next)} />
    </EditorSection>
    <EditorSection title="Runner access and availability">
      <Toggle label="Allow self-hosted runners" checked={policy.allow_self_hosted === true} onChange={next => update("allow_self_hosted", next)} />
      {policy.allow_self_hosted === true && <ReferenceControl name="runner_pool_ids" label="Allowed runner pools" value={policy.runner_pool_ids} context={context}
        path={`/v1/runner-pools?${context.repoId ? `repo_id=${encodeURIComponent(context.repoId)}` : `account_id=${encodeURIComponent(context.accountId)}`}`} onChange={next => update("runner_pool_ids", next)} required />}
      <Toggle label="Allow the selected repositories in other accounts" checked={policy.allow_cross_account === true} onChange={next => update("allow_cross_account", next)} />
      <div className="choice-grid"><DateControl label="Active from" value={policy.not_before} onChange={next => update("not_before", next ?? null)} />
        <DateControl label="Expires" value={policy.expires_at} onChange={next => update("expires_at", next ?? null)} /></div>
    </EditorSection>
    <Button variant="ghost" onClick={() => onChange(vaultDefaults(context.repoId))}>Reset access to defaults</Button>
  </div>;
}

export function AccountPolicyEditor({ value, onChange }: FieldEditorProps) {
  const policy = record(structuredValue(value));
  const update = (key: string, next: unknown) => onChange({ ...policy, [key]: next });
  const visibilities = listValue(policy.allowed_repository_visibilities ?? ["public", "private", "internal", "unlisted"]);
  const kinds = listValue(policy.allowed_credential_kinds ?? ["session", "personal", "installation", "service", "agent", "runner", "job", "viewer"]);
  return <div className="editor-stack">
    <Toggle label="Require verified email" checked={policy.require_verified_email !== false} onChange={next => update("require_verified_email", next)} />
    <Toggle label="Require two-factor authentication" checked={policy.require_mfa === true} onChange={next => update("require_mfa", next)} />
    <Toggle label="Allow outside collaborators" checked={policy.allow_outside_collaborators !== false} onChange={next => update("allow_outside_collaborators", next)} />
    <EditorSection title="Repositories">
      <p className="field-label">Allowed visibility</p>
      <div className="choice-grid">{["private", "public", "internal", "unlisted"].map(visibility => <Toggle key={visibility} label={visibility[0]!.toUpperCase() + visibility.slice(1)}
        checked={visibilities.includes(visibility)} onChange={checked => update("allowed_repository_visibilities", checked ? [...visibilities, visibility] : visibilities.filter(item => item !== visibility))} />)}</div>
      <SelectControl label="Default visibility" value={policy.default_repository_visibility || "private"} onChange={next => update("default_repository_visibility", next)} options={[...new Set([text(policy.default_repository_visibility, "private"), ...visibilities])]} />
      <SelectControl label="Repository creator role" value={policy.default_repository_creator_role || "administrator"} onChange={next => update("default_repository_creator_role", next)} options={["administrator", "maintainer", "contributor"]} />
      <Toggle label="Allow public forks" checked={policy.allow_public_forks !== false} onChange={next => update("allow_public_forks", next)} />
    </EditorSection>
    <EditorSection title="Credentials and email domains">
      <TextControl label="Maximum token lifetime (days)" type="number" min={300 / 86400} max={365} step="any" value={Number(policy.maximum_token_lifetime_seconds ?? 7776000) / 86400}
        onChange={next => update("maximum_token_lifetime_seconds", Math.round(Number(next) * 86400))} />
      <p className="field-label">Allowed credential types</p>
      <div className="choice-grid">{["session", "personal", "installation", "service", "agent", "runner", "job", "viewer"].map(kind => <Toggle key={kind} label={kind[0]!.toUpperCase() + kind.slice(1)}
        checked={kinds.includes(kind)} onChange={checked => update("allowed_credential_kinds", checked ? [...kinds, kind] : kinds.filter(item => item !== kind))} />)}</div>
      <TokenInput label="Allowed email domains" value={policy.allowed_email_domains} placeholder="All domains by default…" onChange={next => update("allowed_email_domains", next)} />
    </EditorSection>
    <EditorSection title="Permission limits">
      <Toggle label="Limit the permissions available in this account" checked={policy.allowed_capabilities !== null && policy.allowed_capabilities !== undefined}
        onChange={checked => update("allowed_capabilities", checked ? [] : null)} />
      {policy.allowed_capabilities !== null && policy.allowed_capabilities !== undefined && <CapabilityPicker value={policy.allowed_capabilities} onChange={next => update("allowed_capabilities", next)} patterns />}
      <EditorSection title="Always-denied permissions"><CapabilityPicker value={policy.denied_capabilities} onChange={next => update("denied_capabilities", next)} patterns /></EditorSection>
    </EditorSection>
  </div>;
}

export function validateAccountPolicy(value: unknown) {
  const policy = record(value);
  const visibilities = listValue(policy.allowed_repository_visibilities);
  if (policy.allowed_repository_visibilities && !visibilities.includes(text(policy.default_repository_visibility, "private")))
    return "The default repository visibility must also be allowed.";
  if (policy.allowed_credential_kinds && !listValue(policy.allowed_credential_kinds).length) return "Allow at least one credential type.";
  return undefined;
}

export function SearchFiltersEditor({ value, onChange, context }: FieldEditorProps) {
  const filters = record(structuredValue(value));
  const update = (key: string, next: unknown) => onChange(updateProperty(filters, key, next));
  return <div className="editor-stack">
    <TextControl label="Search query" value={filters.query} onChange={next => update("query", next)} />
    <div className="choice-grid">
      <SelectControl label="Type" value={filters.kind} onChange={next => update("kind", next)} options={[{ value: "", label: "Everything" }, { value: "issue", label: "Issues" }, { value: "pull_request", label: "Pull requests" }, { value: "discussion", label: "Discussions" }, { value: "task", label: "Tasks" }, { value: "comment", label: "Comments" }]} />
      <SelectControl label="State" value={filters.state} onChange={next => update("state", next)} options={[{ value: "", label: "Any state" }, "open", "closed", "draft", "active", "completed", "cancelled"]} />
    </div>
    <EditorSection title="Narrow the results">
      <ReferenceControl name="repo_ids" label="Repositories" value={filters.repo_ids} onChange={next => update("repo_ids", next)} context={context} />
    </EditorSection>
  </div>;
}
