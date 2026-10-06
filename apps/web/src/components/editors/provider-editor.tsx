import { array, record, text } from "../../api/types.ts";
import { useMutation } from "../../api/hooks.ts";
import type { FieldContext, FieldEditorProps } from "../field-types.ts";
import { listValue, structuredValue } from "../field-values.ts";
import { Button, ErrorNotice } from "../ui.tsx";
import { AddRow, Control, EditorSection, ReferenceControl, RemoveRow, SelectControl, TextControl, Toggle, TokenInput, updateProperty } from "./controls.tsx";
import { CapabilityPicker } from "./permissions.tsx";

export const oidcDefaults = { protocol: "oidc", external_id_claim: "sub", tenant_claim: "", tenant_values: [] };
const commonKeys = ["tenant_claim", "tenant_values", "external_id_claim", "email_claim", "email_verified_claim", "name_claim", "provisioning", "max_authentication_age_seconds", "mappings"];

export function switchProviderProtocol(config: Record<string, unknown>, protocol: string) {
  return { ...Object.fromEntries(Object.entries(config).filter(([key]) => commonKeys.includes(key))), protocol };
}

export function ProviderEditor({ value, onChange, context }: FieldEditorProps) {
  const config = record(structuredValue(value));
  const protocol = text(config.protocol, "oidc");
  const discovery = useMutation();
  const update = (key: string, next: unknown) => onChange(updateProperty(config, key, next));
  return <div className="editor-stack">
    <SelectControl label="Sign-in protocol" value={protocol} onChange={next => onChange(switchProviderProtocol(config, next))}
      options={[{ value: "oidc", label: "OpenID Connect" }, { value: "saml", label: "SAML 2.0" }]} />
    <TextControl label={protocol === "oidc" ? "Issuer URL" : "Issuer / entity ID"} type={protocol === "oidc" ? "url" : "text"}
      value={config.issuer} onChange={next => update("issuer", next)} required placeholder="https://identity.example.com…" />
    {protocol === "oidc" ? <>
      <div className="discovery-action"><Button busy={discovery.pending} disabled={!config.issuer || !context.accountId}
        onClick={() => {
          void discovery.run(`/v1/orgs/${encodeURIComponent(context.accountId)}/identity-providers/discovery`, { method: "POST", body: { issuer: config.issuer } })
            .then(result => {
              if (!result) return;
              const document = record(result.data);
              const endpoints = Object.fromEntries(["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"].filter(key => typeof document[key] === "string").map(key => [key, document[key]]));
              onChange({ ...config, ...endpoints });
            });
        }}>Discover endpoints</Button><span className="field-help">Fill in the provider’s endpoints automatically.</span></div>
      <ErrorNotice error={discovery.error} />
      <TextControl label="Client ID" value={config.client_id} onChange={next => update("client_id", next)} required />
      <EditorSection title="Provider endpoints">
        <TextControl label="Authorization endpoint" type="url" value={config.authorization_endpoint} onChange={next => update("authorization_endpoint", next)} required />
        <TextControl label="Token endpoint" type="url" value={config.token_endpoint} onChange={next => update("token_endpoint", next)} required />
        <TextControl label="Signing keys URL" type="url" value={config.jwks_uri} onChange={next => update("jwks_uri", next)} required />
      </EditorSection>
    </> : <>
      <TextControl label="Single sign-on URL" type="url" value={config.sso_url} onChange={next => update("sso_url", next)} required />
      <Certificates value={listValue(config.signing_certificates)} onChange={next => update("signing_certificates", next)} />
    </>}
    <div className="editor-subheading"><h3>Connect your organization</h3><p className="field-help">Use the claim names supplied by your identity provider.</p></div>
    <TextControl label="Tenant claim" value={config.tenant_claim} onChange={next => update("tenant_claim", next)} required placeholder="For example, tid…" />
    <TokenInput label="Allowed tenant values" value={config.tenant_values} onChange={next => update("tenant_values", next)} required placeholder="Your organization’s tenant ID…" />
    <TextControl label="Immutable user ID claim" value={config.external_id_claim} onChange={next => update("external_id_claim", next)} required placeholder="For example, sub…" />
    <EditorSection title="Provisioning and profile claims">
      <SelectControl label="Create users" value={config.provisioning || "scim_only"} onChange={next => update("provisioning", next)} options={[{ value: "scim_only", label: "Through SCIM provisioning" }, { value: "jit", label: "When they first sign in" }]} />
      {[["email_claim", "Email claim", "email"], ["email_verified_claim", "Verified email claim", "email_verified"], ["name_claim", "Display name claim", "name"]].map(([key, label, fallback]) =>
        <TextControl key={key} label={label!} value={config[key!] ?? fallback} onChange={next => update(key!, next)} required />)}
      <TextControl label="Maximum authentication age (seconds)" type="number" min={60} max={900} value={config.max_authentication_age_seconds ?? 300} onChange={next => update("max_authentication_age_seconds", Number(next))} />
    </EditorSection>
    <EditorSection title="Role and team mapping"><ProviderMappings value={record(config.mappings)} onChange={next => update("mappings", next)} context={context} /></EditorSection>
    <EditorSection title="Protocol options">
      {protocol === "oidc" ? <>
        <SelectControl label="Client authentication" value={config.token_endpoint_auth_method || "client_secret_basic"} onChange={next => update("token_endpoint_auth_method", next)} options={["client_secret_basic", "client_secret_post", "none"]} />
        <TokenInput label="Scopes" value={config.scopes ?? ["openid", "profile", "email"]} onChange={next => update("scopes", next)} required />
        <TokenInput label="Signing algorithms" value={config.signing_algorithms ?? ["RS256"]} onChange={next => update("signing_algorithms", next)} required />
        <TokenInput label="MFA assurance values" value={config.mfa_acr_values} onChange={next => update("mfa_acr_values", next)} />
        <Toggle label="Require the issuer in authorization responses" checked={config.require_authorization_response_issuer !== false} onChange={next => update("require_authorization_response_issuer", next)} />
      </> : <>
        <Toggle label="Require signed responses" checked={config.response_signature_required !== false} onChange={next => update("response_signature_required", next)} />
        <Toggle label="Sign authentication requests" checked={config.sign_authn_requests !== false} onChange={next => update("sign_authn_requests", next)} />
        <SelectControl label="Name ID format" value={config.name_id_format || "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"} onChange={next => update("name_id_format", next)}
          options={[{ value: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent", label: "Persistent" }, { value: "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified", label: "Unspecified" }]} />
        <TokenInput label="MFA contexts" value={config.mfa_contexts ?? ["https://refeds.org/profile/mfa"]} onChange={next => update("mfa_contexts", next)} required />
      </>}
    </EditorSection>
  </div>;
}

function Certificates({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const certificates = value.length ? value : [""];
  return <div className="editor-stack">{certificates.map((certificate, index) => <div className="certificate-row" key={index}>
    <Control label={`Signing certificate${index ? ` ${index + 1}` : ""}`}>{id => <textarea id={id} required rows={4} value={certificate} spellCheck={false}
      placeholder="Paste the PEM certificate…" onChange={event => onChange(certificates.map((item, position) => position === index ? event.target.value : item))} />}</Control>
    {certificates.length > 1 && <RemoveRow label={`Remove certificate ${index + 1}`} onClick={() => onChange(certificates.filter((_, position) => position !== index))} />}
  </div>)}{certificates.length < 3 && <AddRow onClick={() => onChange([...certificates, ""])}>Add a signing certificate</AddRow>}</div>;
}

function MappingRows({ label, value, onChange, context, destination, sourceKey = "value" }: {
  label: string; value: unknown; onChange: (value: Record<string, unknown>[]) => void; context: FieldContext; destination: "role_id" | "team_id"; sourceKey?: string;
}) {
  const rows = array<Record<string, unknown>>(value);
  const replace = (index: number, key: string, value: unknown) => onChange(rows.map((row, position) => position === index ? { ...row, [key]: value } : row));
  return <div className="editor-stack"><h4>{label}</h4>{rows.map((row, index) => <div className="editable-row" key={index}>
    <TextControl label={sourceKey === "value" ? "Claim value" : "External group ID"} value={row[sourceKey]} onChange={next => replace(index, sourceKey, next)} required />
    <ReferenceControl name={destination} label={destination === "role_id" ? "GitKnot role" : "GitKnot team"} value={row[destination]} context={context} multiple={false} required
      path={destination === "team_id" ? `/v1/orgs/${encodeURIComponent(context.accountId)}/teams` : undefined} onChange={next => replace(index, destination, next)} />
    <RemoveRow label="Remove mapping" onClick={() => onChange(rows.filter((_, position) => position !== index))} />
  </div>)}<AddRow onClick={() => onChange([...rows, { [sourceKey]: "", [destination]: "" }])}>Add mapping</AddRow></div>;
}

function ProviderMappings({ value, onChange, context }: { value: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void; context: FieldContext }) {
  const update = (key: string, next: unknown) => onChange(updateProperty(value, key, next));
  return <div className="editor-stack">
    <ReferenceControl name="role_id" label="Default role" value={value.default_role_id ?? "member"} onChange={next => update("default_role_id", next)} context={context} multiple={false} required />
    <TextControl label="Role claim" value={value.role_claim} onChange={next => update("role_claim", next || null)} />
    <MappingRows label="Role mapping" value={value.role_mappings} onChange={next => update("role_mappings", next)} context={context} destination="role_id" />
    <ReferenceControl name="role_id" label="Allowed roles" value={value.role_ceiling ?? ["member"]} onChange={next => update("role_ceiling", next)} context={context} required />
    <TextControl label="Group claim" value={value.group_claim} onChange={next => update("group_claim", next || null)} />
    <MappingRows label="Team mapping" value={value.team_mappings} onChange={next => update("team_mappings", next)} context={context} destination="team_id" />
    <MappingRows label="SCIM group mapping" value={value.scim_group_mappings} onChange={next => update("scim_group_mappings", next)} context={context} destination="team_id" sourceKey="external_id" />
    <ReferenceControl name="team_ids" label="Allowed teams" value={value.team_ceiling} onChange={next => update("team_ceiling", next)} context={context} path={`/v1/orgs/${encodeURIComponent(context.accountId)}/teams`} />
    <Toggle label="Deny unmapped roles" checked={value.deny_unmapped_roles !== false} onChange={next => update("deny_unmapped_roles", next)} />
    <Toggle label="Deny unmapped groups" checked={value.deny_unmapped_groups !== false} onChange={next => update("deny_unmapped_groups", next)} />
    <TokenInput label="Denied role values" value={value.denied_role_values} onChange={next => update("denied_role_values", next)} />
    <EditorSection title="Permission ceiling"><CapabilityPicker value={value.capability_ceiling ?? ["accounts.read", "members.read", "teams.read", "repositories.create"]} onChange={next => update("capability_ceiling", next)} patterns /></EditorSection>
    <EditorSection title="Denied permissions"><CapabilityPicker value={value.denied_capabilities} onChange={next => update("denied_capabilities", next)} patterns /></EditorSection>
  </div>;
}
