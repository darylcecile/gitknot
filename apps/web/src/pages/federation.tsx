import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { request } from "../api/client.ts";
import { useMutation, useResource } from "../api/hooks.ts";
import { displayName, record, text, type Entity } from "../api/types.ts";
import {
  ActionButton,
  EditResource,
  ResourceForm,
  type Field,
} from "../components/forms.tsx";
import { ResourceCollection } from "../components/resources.tsx";
import { ProviderEditor, oidcDefaults } from "../components/editors/provider-editor.tsx";
import { CapabilitiesEditor } from "../components/editors/permissions.tsx";
import {
  Button,
  DownloadButton,
  ErrorNotice,
  JsonDetails,
  Loading,
  Metadata,
  Notice,
  PageHeader,
  Panel,
} from "../components/ui.tsx";

const providerFields: Field[] = [
  { name: "name", label: "Provider name", required: true },
  {
    name: "config",
    label: "Provider configuration",
    type: "custom",
    editor: ProviderEditor,
    default: oidcDefaults,
    required: true,
  },
];

export function FederationProviders({ accountId }: { accountId: string }) {
  const base = `/v1/orgs/${encodeURIComponent(accountId)}/identity-providers`;
  const policy = useResource<Entity>(`${base}/policy`);
  const [discovery, setDiscovery] = useState<unknown>(null);
  return (
    <div className="stack">
      <ResourceCollection
        path={base}
        spec={{
          title: "Identity providers",
          singular: "identity provider",
          fields: providerFields,
          editFields: [
            ...providerFields,
            { name: "enabled", label: "Enabled", type: "checkbox" },
          ],
          columns: ["name", "protocol", "enabled"],
          rowPath: (provider) => `/accounts/${accountId}/sso/${provider.id}`,
        }}
      />
      <Panel title="Organization SSO policy">
        <ErrorNotice error={policy.error} retry={policy.refresh} />
        {policy.snapshot ? (
          <ResourceForm
            path={`${base}/policy`}
            method="PUT"
            initial={{
              ...policy.snapshot,
              data: {
                ...policy.data,
                ...record(policy.data?.policy),
              } as Entity,
            }}
            fields={[
              {
                name: "required",
                label: "Require organization SSO",
                type: "checkbox",
              },
              {
                name: "session_max_age_seconds",
                label: "Maximum SSO session age (seconds)",
                type: "number",
                min: 300,
                max: 43200,
                default: 3600,
                required: true,
              },
              {
                name: "machine_access",
                label: "Machine access",
                type: "select",
                options: ["deny", "scoped"],
                default: "scoped",
                required: true,
              },
            ]}
            onSaved={policy.refresh}
          />
        ) : (
          policy.loading && <Loading />
        )}
      </Panel>
      <Panel title="OIDC discovery">
        <div className="panel-body">
          <ActionButton
            path={`${base}/discovery`}
            label="Discover issuer"
            fields={[
              {
                name: "issuer",
                label: "OIDC issuer URL",
                type: "url",
                required: true,
              },
            ]}
            onDone={(result) => setDiscovery(result.data)}
          />
          {discovery !== null && (
            <Metadata values={record(discovery)} />
          )}
        </div>
      </Panel>
    </div>
  );
}

export function FederationProviderPage() {
  const { accountId = "", providerId = "" } = useParams();
  const base = `/v1/orgs/${encodeURIComponent(accountId)}/identity-providers/${encodeURIComponent(providerId)}`;
  const provider = useResource<Entity>(base);
  const [secretKind, setSecretKind] = useState("oidc_client_secret");
  return (
    <>
      <PageHeader
        eyebrow={
          <Link to={`/accounts/${accountId}/sso`}>Organization identity</Link>
        }
        title={provider.data ? displayName(provider.data) : "Identity provider"}
        actions={
          <EditResource
            path={base}
            title="Configure identity provider"
            fields={[
              ...providerFields,
              { name: "enabled", label: "Enabled", type: "checkbox" },
            ]}
            onSaved={provider.refresh}
          />
        }
      />
      <ErrorNotice error={provider.error} retry={provider.refresh} />
      {provider.data && (
        <Panel title="Current configuration">
          <div className="panel-body">
            <Metadata values={provider.data} />
            <JsonDetails
              title="Tenant, role, and group mapping"
              value={provider.data.config}
            />
            {provider.data.protocol === "saml" && (
              <DownloadButton
                path={`/v1/auth/saml/${providerId}/metadata`}
                name={`${providerId}-metadata.xml`}
              >
                SAML metadata
              </DownloadButton>
            )}
          </div>
        </Panel>
      )}
      <Panel title="Write-only federation secrets">
        <div className="panel-body">
          <label className="field">
            Secret purpose
            <select
              value={secretKind}
              onChange={(event) => setSecretKind(event.target.value)}
            >
              <option value="oidc_client_secret">OIDC client secret</option>
              <option value="saml_signing_key">SAML signing key</option>
            </select>
          </label>
          <ActionButton
            path={`${base}/secrets/${secretKind}`}
            snapshot={provider.snapshot}
            method="PUT"
            label="Rotate secret"
            sensitive
            fields={[
              {
                name: "secret",
                label: "Secret value",
                type: "password",
                autoComplete: "off",
                required: true,
              },
              {
                name: "public_certificate",
                label: "Public certificate (SAML)",
                type: "textarea",
              },
            ]}
            onDone={provider.refresh}
          />
          <ActionButton
            path={`${base}/secrets/${secretKind}`}
            snapshot={provider.snapshot}
            method="DELETE"
            label="Revoke secret"
            danger
            onDone={provider.refresh}
          />
        </div>
      </Panel>
      <ResourceCollection
        path={`${base}/provisioning-tokens`}
        spec={{
          title: "SCIM provisioning credentials",
          singular: "provisioning credential",
          fields: [
            { name: "name", label: "Name", required: true },
            {
              name: "capabilities",
              label: "SCIM capabilities",
              type: "custom",
              editor: CapabilitiesEditor,
              default: [
                "scim.users.read",
                "scim.users.write",
                "scim.groups.read",
                "scim.groups.write",
                "scim.discovery.read",
              ],
              required: true,
            },
            {
              name: "expires_in_seconds",
              label: "Lifetime (seconds)",
              type: "number",
              min: 300,
              max: 31536000,
              default: 7776000,
              required: true,
            },
          ],
          columns: ["name", "capabilities", "expires_at"],
          sensitive: true,
          edit: false,
        }}
      />
      <Panel title="Authorize a personal token for this organization">
        <div className="panel-body">
          <TokenSsoAuthorization base={base} />
        </div>
      </Panel>
    </>
  );
}

function TokenSsoAuthorization({ base }: { base: string }) {
  const [id, setId] = useState("");
  const [done, setDone] = useState(false);
  const mutation = useMutation();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void mutation
          .run(`${base}/credentials/${encodeURIComponent(id)}/authorize`, {
            method: "POST",
            body: {},
          })
          .then((result) => {
            if (result) setDone(true);
          });
      }}
    >
      <div className="field">
        <label htmlFor="sso-token-id">Existing GitKnot credential ID</label>
        <input
          id="sso-token-id"
          value={id}
          onChange={(event) => setId(event.target.value)}
          required
        />
      </div>
      <ErrorNotice error={mutation.error} />
      {done && (
        <Notice tone="success">
          The credential is bound to your current organization SSO session.
        </Notice>
      )}
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={mutation.pending}>
          Authorize token
        </Button>
      </div>
    </form>
  );
}

export function FederationSignIn({ link = false }: { link?: boolean }) {
  const [provider, setProvider] = useState("");
  const [protocol, setProtocol] = useState("oidc");
  const [params] = useSearchParams();
  const mutation = useMutation();
  return (
    <Panel
      title={link ? "Link an organization identity" : "Organization sign-in"}
      description="Use the provider ID supplied by your organization administrator."
    >
      {params.get("identity_linked") && (
        <Notice tone="success">
          Identity linked.
          {params.get("provisioning_required") &&
            " Organization provisioning is still required before access is granted."}
        </Notice>
      )}
      <form
        className="resource-form"
        onSubmit={(event) => {
          event.preventDefault();
          void mutation
            .run<Entity>(
              `/v1/auth/${protocol}/${encodeURIComponent(provider)}/start`,
              {
                method: "POST",
                body: {
                  intent: link ? "link" : "login",
                  return_to: link ? "/settings/federation" : "/",
                },
              },
            )
            .then((result) => {
              if (!result) return;
              try {
                const url = new URL(text(result.data.authorization_url));
                if (url.protocol !== "https:")
                  throw new Error(
                    "The identity provider returned an invalid authorization URL.",
                  );
                window.location.assign(url.href);
              } catch (cause) {
                mutation.setError(
                  cause instanceof Error
                    ? cause
                    : new Error("Unable to start organization sign-in."),
                );
              }
            });
        }}
      >
        <div className="form-grid">
          <div className="field">
            <label htmlFor="federation-protocol">Protocol</label>
            <select
              id="federation-protocol"
              value={protocol}
              onChange={(event) => setProtocol(event.target.value)}
            >
              <option value="oidc">OpenID Connect</option>
              <option value="saml">SAML</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="federation-provider">Provider ID</label>
            <input
              id="federation-provider"
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
              required
            />
          </div>
        </div>
        <ErrorNotice error={mutation.error} />
        <div className="form-actions">
          <Button type="submit" variant="primary" busy={mutation.pending}>
            {link ? "Link identity" : "Continue with organization"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
