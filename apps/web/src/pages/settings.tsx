import { useState } from "react";
import {
  Link,
  NavLink,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import { KeyRound, ShieldCheck, Users } from "lucide-react";
import { useAuth } from "../auth.tsx";
import { request, revisionSnapshot } from "../api/client.ts";
import { endpoints, query, repoLink } from "../api/endpoints.ts";
import { useCollection, useMutation, useResource } from "../api/hooks.ts";
import {
  displayName,
  record,
  text,
  type Account,
  type Entity,
} from "../api/types.ts";
import {
  ActionButton,
  CreateResource,
  EditResource,
  OneTimeValue,
  ResourceForm,
  expiryField,
  nameField,
  roleField,
  type Field,
} from "../components/forms.tsx";
import {
  Badge,
  Button,
  CopyButton,
  DownloadButton,
  Empty,
  ErrorNotice,
  JsonDetails,
  Loading,
  Metadata,
  Modal,
  Notice,
  PageHeader,
  Pagination,
  Panel,
  Status,
  Time,
} from "../components/ui.tsx";
import {
  ResourceCollection,
  type CollectionSpec,
} from "../components/resources.tsx";
import { useRepository } from "./repositories.tsx";
import { FederationProviders } from "./federation.tsx";
import { Amount } from "./billing.tsx";
import { AccountExportsPanel } from "./account-exports.tsx";

const capabilityField: Field = {
  name: "capabilities",
  label: "Capabilities",
  type: "csv",
  required: true,
  help: "Explicit capability names, separated by commas. Example: contents.read, issues.write.",
};
const policyField: Field = {
  name: "policy",
  label: "Access policy",
  type: "json",
  help: "Leave blank on creation to use the API's scoped default. An explicit policy must include repository_ids and is validated before use.",
};
const tokenFields: Field[] = [
  nameField,
  capabilityField,
  {
    name: "repository_ids",
    label: "Repository scope",
    type: "csv",
    required: true,
  },
  { name: "account_ids", label: "Account scope", type: "csv" },
  expiryField,
];
const roleFields: Field[] = [
  nameField,
  { name: "description", label: "Description" },
  {
    name: "capabilities",
    label: "Capabilities and effects",
    type: "json",
    required: true,
    default: [{ capability: "contents.read", effect: "allow" }],
    help: 'Each entry names an explicit capability and an "allow" or "deny" effect.',
  },
];
const grantFields: Field[] = [
  { name: "principal_id", label: "Principal ID", required: true },
  {
    name: "principal_type",
    label: "Principal type",
    type: "select",
    options: [
      "user",
      "team",
      "service",
      "agent",
      "application",
      "runner",
      "viewer",
    ],
    default: "user",
    required: true,
  },
  roleField,
  {
    name: "effect",
    label: "Effect",
    type: "select",
    options: ["allow", "deny"],
    default: "allow",
    required: true,
  },
  { name: "conditions", label: "Scope conditions", type: "json", default: {} },
  { ...expiryField, required: false },
];

const repositorySections = [
  ["general", "General"],
  ["access", "Collaborators"],
  ["roles", "Custom roles"],
  ["rules", "Branch & tag rules"],
  ["permissions", "Permission explanation"],
  ["tokens", "Credentials"],
  ["viewer-grants", "Viewer grants"],
  ["secrets", "Secrets & variables"],
  ["webhooks", "Webhooks"],
  ["integrations", "Installations"],
  ["transfers", "Transfers"],
  ["exports", "Exports & recovery"],
  ["audit", "Audit history"],
];

export function RepositorySettingsPage() {
  const { repo, snapshot, refresh } = useRepository();
  const { section = "general" } = useParams();
  const base = endpoints.repo(repo.id);
  const navigate = useNavigate();
  let content;
  if (section === "general")
    content = (
      <>
        <Panel title="Repository details">
          <ResourceForm
            key={repo.id}
            path={base}
            initial={snapshot}
            fields={[
              nameField,
              { name: "description", label: "Description", type: "textarea" },
              {
                name: "default_branch",
                label: "Default branch",
                required: true,
              },
              {
                name: "visibility",
                label: "Visibility",
                type: "select",
                options: ["public", "private", "internal", "unlisted"],
                required: true,
                help: "Unlisted content is readable by anyone with the URL. Internal is restricted to the owning organization.",
              },
            ]}
            draftKey={`${base}:settings`}
            onSaved={refresh}
          />
        </Panel>
        <Panel title="Repository lifecycle">
          <div className="setting-row">
            <div>
              <h3>
                {repo.state === "archived"
                  ? "Unarchive repository"
                  : "Archive repository"}
              </h3>
              <p>
                Archival makes code and collaboration read-only and stops
                scheduled execution.
              </p>
            </div>
            <ActionButton
              path={`${base}/${repo.state === "archived" ? "unarchive" : "archive"}`}
              snapshot={snapshot}
              label={repo.state === "archived" ? "Unarchive" : "Archive"}
              onDone={(result) => {
                refresh();
                if (result.data?.operation_id)
                  navigate(`/operations/${text(result.data.operation_id)}`);
              }}
            />
          </div>
          <div className="setting-row">
            <div>
              <h3>Delete repository</h3>
              <p>
                Access is revoked immediately. Retained content can be restored
                within the documented recovery window.
              </p>
            </div>
            <ActionButton
              path={base}
              snapshot={snapshot}
              label="Delete repository"
              method="DELETE"
              danger
              confirmText={repo.name}
              onDone={(result) =>
                navigate(
                  result.data?.operation_id
                    ? `/operations/${text(result.data.operation_id)}`
                    : "/repos",
                )
              }
            />
          </div>
        </Panel>
      </>
    );
  else if (section === "access")
    content = (
      <ResourceCollection
        path={`${base}/collaborators`}
        spec={{
          title: "Collaborators",
          singular: "grant",
          fields: grantFields,
          columns: ["principal_id", "role_id", "expires_at"],
        }}
      />
    );
  else if (section === "roles")
    content = (
      <ResourceCollection
        path={`${base}/roles`}
        spec={{
          title: "Custom roles",
          singular: "role",
          fields: roleFields,
          columns: ["name", "description", "capabilities"],
        }}
      />
    );
  else if (section === "rules") content = <RulesPanel base={base} />;
  else if (section === "permissions")
    content = <PermissionExplanation base={base} />;
  else if (section === "tokens")
    content = (
      <ResourceCollection
        path={`${base}/tokens`}
        spec={{
          title: "Scoped credentials",
          singular: "token",
          description:
            "Expiring credentials are shown once. Their effective access is intersected with current grants and policy.",
          fields: tokenFields.filter(
            (field) => field.name !== "repository_ids",
          ),
          sensitive: true,
          edit: false,
          columns: ["name", "capabilities", "expires_at", "last_used_at"],
        }}
      />
    );
  else if (section === "viewer-grants")
    content = (
      <ResourceCollection
        path={`${base}/viewer-grants`}
        spec={{
          title: "Viewer grants",
          singular: "viewer grant",
          description:
            "Revocable, expiring private sharing. Possession of a content hash does not grant access.",
          fields: [
            { name: "name", label: "Name", required: true },
            expiryField,
          ],
          sensitive: true,
          edit: false,
          columns: ["name", "expires_at", "last_used_at"],
        }}
      />
    );
  else if (section === "secrets") content = <VaultPanel base={base} />;
  else if (section === "webhooks")
    content = (
      <WebhooksPanel
        base={base}
        linkBase={repoLink(repo.id, "settings/webhooks")}
      />
    );
  else if (section === "integrations")
    content = (
      <AccountIntegrations accountId={repo.owner_id} repoId={repo.id} />
    );
  else if (section === "transfers")
    content = (
      <ResourceCollection
        path={`${base}/transfers`}
        spec={{
          title: "Ownership transfers",
          singular: "transfer",
          description:
            "The receiving owner accepts before policy, credentials, integrations, and payer are recomputed.",
          fields: [
            {
              name: "destination_owner_id",
              label: "Receiving account ID",
              required: true,
            },
          ],
          edit: false,
          columns: ["destination_owner_id", "state", "created_at"],
          allowDelete: false,
          rowPath: (transfer) => `/transfers/${repo.id}/${transfer.id}`,
        }}
        actions={(item, reload) => (
          <>
            <ActionButton
              path={`${base}/transfers/${item.id}/accept`}
              resourcePath={`${base}/transfers/${item.id}`}
              label="Accept transfer"
              onDone={reload}
            />
            <ActionButton
              path={`${base}/transfers/${item.id}/cancel`}
              resourcePath={`${base}/transfers/${item.id}`}
              label="Cancel transfer"
              onDone={reload}
            />
          </>
        )}
      />
    );
  else if (section === "exports") content = <ExportsPanel base={base} />;
  else if (section === "audit") content = <AuditPanel path={`${base}/audit`} />;
  else
    content = (
      <Empty
        title="Setting not found"
        action={
          <Link to={repoLink(repo.id, "settings")}>Repository settings</Link>
        }
      />
    );
  return (
    <>
      <PageHeader
        title="Repository settings"
        description="Explicit access, explainable policy, and a clear lifecycle."
      />
      <div className="settings-layout">
        <nav className="settings-navigation" aria-label="Repository settings">
          {repositorySections.map(([path, label]) => (
            <NavLink
              end
              key={path}
              to={repoLink(repo.id, `settings/${path}`)}
              className={section === path ? "active" : ""}
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="settings-content stack">{content}</div>
      </div>
    </>
  );
}

function RulesPanel({ base }: { base: string }) {
  const [dryRun, setDryRun] = useState<unknown>(null);
  return (
    <>
      <Notice>
        Organization constraints compose with repository rules. Content-write
        access does not bypass branch policy.
      </Notice>
      <ResourceCollection
        path={`${base}/rules`}
        spec={{
          title: "Branch & tag rules",
          singular: "rule",
          description:
            "Select refs and define review, verification, history, signature, path, and publication requirements.",
          fields: [
            nameField,
            {
              name: "enforcement",
              label: "Enforcement",
              type: "select",
              options: ["active", "evaluate", "disabled"],
              default: "active",
            },
            {
              name: "config",
              label: "Rule definition",
              type: "json",
              required: true,
              help: "The server validates all typed requirements and rejects contradictory rules.",
              default: {
                version: 1,
                target: "refs/heads/main",
                updates: "pull_request_only",
                reviews: { minimum: 1, disallow_author_approval: true },
                history: { allow_force_push: false, allow_deletion: false },
              },
            },
          ],
          columns: ["name", "target", "enforcement", "mandatory"],
        }}
      />
      <Panel title="Preview effective policy">
        <div className="panel-body">
          <ActionButton
            path={`${base}/rules/preview`}
            label="Preview policy change"
            fields={[
              {
                name: "rule",
                label: "Proposed rule",
                type: "json",
                required: true,
                help: "Supply name, enforcement, and the complete config object.",
              },
              {
                name: "replace_rule_id",
                label: "Rule being replaced (optional)",
              },
              { name: "ref", label: "Target ref" },
              { name: "paths", label: "Changed paths", type: "csv" },
            ]}
            onDone={(result) => setDryRun(result.data)}
          />
          {dryRun !== null && (
            <pre className="source-preview">
              {JSON.stringify(dryRun, null, 2)}
            </pre>
          )}
        </div>
      </Panel>
      <ResourceCollection
        path={`${base}/rule-bypasses`}
        spec={{
          title: "Emergency bypasses",
          singular: "bypass",
          description:
            "Time-bounded, explicitly scoped, audited break-glass access.",
          fields: [
            {
              name: "rule_ids",
              label: "Rule IDs",
              type: "csv",
              required: true,
            },
            { name: "refs", label: "Exact refs", type: "csv", required: true },
            {
              name: "reason",
              label: "Reason",
              type: "textarea",
              required: true,
            },
            {
              name: "duration_seconds",
              label: "Duration (seconds)",
              type: "number",
              min: 1,
              max: 1800,
              default: 900,
              required: true,
            },
          ],
          edit: false,
          columns: ["id", "reason", "expires_at"],
        }}
      />
    </>
  );
}

export function PermissionExplanation({ base }: { base: string }) {
  const [explanation, setExplanation] = useState<unknown>(null);
  return (
    <Panel
      title="Why allowed / why denied"
      description="Effective access intersects current grants, credential scope, and policy ceilings. Explicit denials win."
    >
      <ResourceForm
        path={`${base}/permissions/explain`}
        fields={[
          {
            name: "principal_id",
            label: "Principal ID (optional)",
            help: "Leave blank to explain your own access.",
          },
          { name: "capability", label: "Capability", required: true },
          { name: "credential_id", label: "Credential ID" },
          { name: "ref", label: "Ref" },
          { name: "paths", label: "Paths", type: "csv" },
        ]}
        submitLabel="Explain permission"
        onSaved={(result) => setExplanation(result.data)}
      />
      {explanation !== null && (
        <div className="panel-body">
          <pre className="source-preview">
            {JSON.stringify(explanation, null, 2)}
          </pre>
        </div>
      )}
    </Panel>
  );
}

export function VaultPanel({ base }: { base: string }) {
  return (
    <>
      <Notice>
        Precedence: environment → repository → owner account → explicitly
        allowed personal scope. Existing secret values are never returned by
        management APIs.
      </Notice>
      <ResourceCollection
        path={`${base}/secrets`}
        spec={{
          title: "Secrets",
          singular: "secret",
          description:
            "Write-only encrypted values. Rotation creates an immutable new version.",
          fields: [
            { ...nameField, createOnly: true },
            {
              name: "value",
              label: "Secret value",
              type: "password",
              required: true,
            },
            policyField,
          ],
          sensitive: true,
          columns: ["name", "version", "updated_at"],
          itemPath: (item) =>
            `${base}/secrets/${encodeURIComponent(text(item.name))}`,
        }}
        actions={(item, refresh) => (
          <SecretHistory
            path={`${base}/secrets/${encodeURIComponent(text(item.name))}/versions`}
            name={displayName(item)}
          />
        )}
      />
      <ResourceCollection
        path={`${base}/variables`}
        spec={{
          title: "Variables",
          singular: "variable",
          description:
            "Readable configuration values, with the same explicit scope and precedence.",
          fields: [
            { ...nameField, createOnly: true },
            { name: "value", label: "Value", type: "textarea", required: true },
            policyField,
          ],
          columns: ["name", "value", "updated_at"],
          itemPath: (item) =>
            `${base}/variables/${encodeURIComponent(text(item.name))}`,
        }}
      />
    </>
  );
}

function SecretHistory({ path, name }: { path: string; name: string }) {
  const [open, setOpen] = useState(false);
  const versions = useCollection<Entity>(open ? path : null);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Versions</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`${name} · version history`}
      >
        <div className="modal-body">
          <ErrorNotice error={versions.error} retry={versions.refresh} />
          {versions.items.map((version) => (
            <Metadata key={version.id} values={version} />
          ))}
          <Pagination {...versions} />
        </div>
      </Modal>
    </>
  );
}

export function WebhooksPanel({
  base,
  linkBase,
}: {
  base: string;
  linkBase: string;
}) {
  return (
    <ResourceCollection
      path={`${base}/webhooks`}
      spec={{
        title: "Webhooks",
        singular: "webhook",
        description:
          "Versioned, signed events with durable deliveries, bounded retries, and replay.",
        fields: [
          { name: "url", label: "HTTPS endpoint", type: "url", required: true },
          {
            name: "events",
            label: "Event subscriptions",
            type: "csv",
            required: true,
          },
          {
            name: "installation_id",
            label: "Installation ID (optional)",
            createOnly: true,
          },
        ],
        editFields: [
          { name: "url", label: "HTTPS endpoint", type: "url", required: true },
          {
            name: "events",
            label: "Event subscriptions",
            type: "csv",
            required: true,
          },
          {
            name: "state",
            label: "Delivery state",
            type: "select",
            options: ["active", "disabled"],
            required: true,
          },
        ],
        sensitive: true,
        columns: ["url", "state", "created_at"],
        rowPath: (webhook) => `${linkBase}/${webhook.id}`,
      }}
    />
  );
}

export function WebhookPage() {
  const { repo } = useRepository();
  const { webhookId = "" } = useParams();
  const path = endpoints.repo(
    repo.id,
    `webhooks/${encodeURIComponent(webhookId)}`,
  );
  const webhook = useResource<Entity>(path);
  const deliveries = useCollection<Entity>(`${path}/deliveries`);
  const [secret, setSecret] = useState<unknown>(null);
  const [selected, setSelected] = useState("");
  const delivery = useResource<Entity>(
    selected ? `${path}/deliveries/${selected}` : null,
  );
  return (
    <>
      <PageHeader
        title={webhook.data ? displayName(webhook.data) : "Webhook"}
        actions={
          <>
            <ActionButton
              path={`${path}/rotate-secret`}
              snapshot={webhook.snapshot}
              label="Rotate signing key"
              description="Create a new Standard Webhooks signing key with a bounded retiring-key overlap."
              onDone={(result) => setSecret(result.data)}
            />
            <ActionButton
              path={`${path}/replay`}
              snapshot={webhook.snapshot}
              label="Replay events"
              fields={[
                {
                  name: "from",
                  label: "From",
                  type: "datetime-local",
                  required: true,
                },
                {
                  name: "to",
                  label: "Through",
                  type: "datetime-local",
                  required: true,
                },
              ]}
              onDone={deliveries.refresh}
            />
          </>
        }
      />
      <ErrorNotice error={webhook.error} retry={webhook.refresh} />
      <OneTimeValue value={secret} />
      <Panel title="Delivery history">
        <ErrorNotice error={deliveries.error} retry={deliveries.refresh} />
        {deliveries.items.map((item) => (
          <article className="delivery-row" key={item.id}>
            <Status value={item.state || item.status} />
            <button
              type="button"
              className="text-button"
              onClick={() => setSelected(item.id)}
            >
              {text(item.event_type || item.event_id, item.id)}
            </button>
            <span>HTTP {text(item.response_status, "—")}</span>
            <Time value={item.created_at} />
            <ActionButton
              path={`${path}/deliveries/${item.id}/redeliver`}
              resourcePath={`${path}/deliveries/${item.id}`}
              label="Redeliver"
              description="Create a new attempt for the original event identity."
              onDone={deliveries.refresh}
            />
          </article>
        ))}
        {!deliveries.items.length &&
          !deliveries.loading &&
          !deliveries.error && (
            <Empty
              title="No deliveries yet"
              description="Subscribed repository events will appear here with attempts and response details."
            />
          )}
        <Pagination {...deliveries} />
      </Panel>
      <Modal
        open={!!selected}
        onClose={() => setSelected("")}
        title="Delivery details"
        wide
      >
        <div className="modal-body">
          <ErrorNotice error={delivery.error} retry={delivery.refresh} />
          {delivery.data && (
            <>
              <Metadata values={delivery.data} />
              <pre className="source-preview">
                {JSON.stringify(delivery.data, null, 2)}
              </pre>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}

export function ExportsPanel({ base }: { base: string }) {
  const navigate = useNavigate();
  return (
    <>
      <ResourceCollection
        path={`${base}/exports`}
        spec={{
          title: "Portable exports",
          singular: "export",
          description:
            "Versioned archives include Git, canonical Markdown, collaboration history, workflow definitions, and authorized object manifests.",
          fields: [],
          edit: false,
          allowDelete: false,
          columns: ["id", "state", "created_at"],
          rowPath: (item) => `/operations/${text(item.operation_id, item.id)}`,
        }}
        actions={(item) =>
          item.state === "completed" ? (
            <DownloadButton
              path={`${base}/exports/${item.id}/download`}
              name={`${item.id}.tar.gz`}
            />
          ) : null
        }
      />
      <Panel title="Restore from a retained archive">
        <div className="panel-body">
          <p>
            Restore validates content and lineage in fresh storage before
            reopening access.
          </p>
          <ActionButton
            path={`${base}/restore`}
            label="Start restore"
            fields={[
              {
                name: "archive_id",
                label: "Verified archive ID (optional)",
              },
            ]}
            onDone={(result) =>
              navigate(
                `/operations/${text(result.data.operation_id, result.data.id)}`,
              )
            }
          />
        </div>
      </Panel>
    </>
  );
}

export function AuditPanel({ path }: { path: string }) {
  const audit = useCollection<Entity>(path);
  return (
    <Panel title="Audit history">
      <ErrorNotice error={audit.error} retry={audit.refresh} />
      {audit.loading && !audit.data ? (
        <Loading />
      ) : (
        audit.items.map((item) => (
          <article className="audit-row" key={item.id}>
            <div>
              <strong>{text(item.action || item.event_type)}</strong>
              <span className="muted"> {text(item.actor_id)}</span>
              <Time value={item.created_at} />
            </div>
            <JsonDetails value={item} />
          </article>
        ))
      )}
      {!audit.items.length && !audit.loading && !audit.error && (
        <Empty title="No audit events in this scope" />
      )}
      <Pagination {...audit} />
    </Panel>
  );
}

export function AccountsPage() {
  const accounts = useCollection<Account>(endpoints.accounts);
  const navigate = useNavigate();
  return (
    <>
      <PageHeader
        title="Accounts & teams"
        description="Personal projects and shared organizations use the same explicit permission model."
        actions={
          <CreateResource
            path={endpoints.orgs}
            title="Create organization"
            fields={[
              nameField,
              { name: "slug", label: "URL name", required: true },
            ]}
            onSaved={(result) =>
              navigate(
                `/accounts/${text(result.data.account_id, result.data.id)}`,
              )
            }
          />
        }
      />
      <ErrorNotice error={accounts.error} retry={accounts.refresh} />
      {accounts.loading && !accounts.data ? (
        <Loading />
      ) : (
        <div className="account-grid">
          {accounts.items.map((account) => (
            <Link
              to={`/accounts/${account.id}`}
              key={account.id}
              className="account-card"
            >
              <Users size={24} />
              <div>
                <h2>{account.name}</h2>
                <p>@{account.slug}</p>
              </div>
              <Badge>{account.type}</Badge>
            </Link>
          ))}
        </div>
      )}
      <Pagination {...accounts} />
      <Link className="button button-secondary" to="/invitations">
        Your invitations
      </Link>
    </>
  );
}

const accountSections = [
  ["overview", "Overview"],
  ["members", "Members"],
  ["teams", "Teams"],
  ["invitations", "Invitations"],
  ["roles", "Custom roles"],
  ["identities", "Service identities"],
  ["integrations", "Applications & installations"],
  ["sso", "SSO & provisioning"],
  ["secrets", "Secrets & variables"],
  ["runners", "Runner pools"],
  ["permissions", "Access grants"],
  ["settings", "Account settings"],
  ["exports", "Account exports"],
  ["audit", "Audit history"],
];

export function AccountPage() {
  const { accountId = "", section = "overview" } = useParams();
  const account = useResource<Account>(endpoints.account(accountId));
  const base = endpoints.account(accountId);
  if (!account.data && account.loading) return <Loading />;
  if (!account.data || !account.snapshot)
    return <ErrorNotice error={account.error} retry={account.refresh} />;
  const data = account.data;
  let content;
  if (section === "overview")
    content = (
      <Panel title={data.name}>
        <div className="panel-body">
          <Metadata
            values={{
              type: data.type,
              slug: data.slug,
              owner: data.owner_user_id,
              created_at: data.created_at,
            }}
          />
          <div className="row-actions">
            <Link
              className="button button-secondary"
              to={`/repos?owner_id=${data.id}`}
            >
              Repositories
            </Link>
            <Link
              className="button button-secondary"
              to={`/repos?owner_id=${data.id}&state=deleted`}
            >
              Deleted repositories
            </Link>
            <Link
              className="button button-secondary"
              to={`/billing/${data.id}`}
            >
              Billing & usage
            </Link>
            <Link
              className="button button-secondary"
              to={`/accounts/${data.id}/runners`}
            >
              Runner pools
            </Link>
          </div>
        </div>
      </Panel>
    );
  else if (section === "members")
    content = (
      <ResourceCollection
        path={`${base}/members`}
        spec={{
          title: "Members",
          singular: "member",
          fields: [
            {
              name: "principal_id",
              label: "User ID",
              required: true,
              createOnly: true,
            },
            roleField,
            {
              name: "state",
              label: "Membership state",
              type: "select",
              options: ["active", "suspended"],
              required: true,
            },
          ],
          columns: ["name", "role_id", "state"],
          create: false,
        }}
      />
    );
  else if (section === "teams")
    content = (
      <ResourceCollection
        path={`${base}/teams`}
        spec={{
          title: "Teams",
          singular: "team",
          fields: [
            nameField,
            { name: "slug", label: "URL name", required: true },
            { name: "description", label: "Description" },
            {
              name: "visibility",
              label: "Team visibility",
              type: "select",
              options: ["members", "secret"],
              default: "members",
              required: true,
            },
          ],
          columns: ["name", "slug", "description"],
          rowPath: (team) => `/accounts/${accountId}/teams/${team.id}`,
        }}
      />
    );
  else if (section === "invitations")
    content = (
      <ResourceCollection
        path={`${base}/invitations`}
        spec={{
          title: "Invitations",
          singular: "invitation",
          description:
            "Seat-cost effects are shown before the recipient accepts.",
          fields: [
            {
              name: "email",
              label: "Email address",
              type: "email",
              required: true,
            },
            roleField,
            expiryField,
          ],
          edit: false,
          columns: ["email", "role_id", "state", "expires_at"],
        }}
      />
    );
  else if (section === "roles")
    content = (
      <ResourceCollection
        path={`${base}/roles`}
        spec={{
          title: "Custom roles",
          singular: "role",
          fields: roleFields,
          columns: ["name", "capabilities", "updated_at"],
        }}
      />
    );
  else if (section === "identities")
    content = (
      <ResourceCollection
        path={`${base}/service-identities`}
        spec={{
          title: "Service identities",
          singular: "service identity",
          fields: [
            nameField,
            {
              name: "kind",
              label: "Kind",
              type: "select",
              options: ["service", "agent"],
              default: "service",
              required: true,
            },
            capabilityField,
            { name: "repository_ids", label: "Repository scope", type: "csv" },
            expiryField,
          ],
          columns: ["name", "kind", "expires_at"],
          editFields: [nameField, { ...expiryField, required: false }],
          sensitive: true,
        }}
        actions={(identity, reload) => (
          <ActionButton
            path="/v1/tokens"
            label="Issue credential"
            sensitive
            body={{
              kind: identity.kind,
              principal_id: identity.id,
              account_ids: [accountId],
            }}
            fields={tokenFields
              .filter((field) => field.name !== "account_ids")
              .map((field) =>
                field.name === "repository_ids"
                  ? { ...field, required: false }
                  : field,
              )}
            onDone={reload}
          />
        )}
      />
    );
  else if (section === "integrations")
    content = <AccountIntegrations accountId={accountId} />;
  else if (section === "sso")
    content = <FederationProviders accountId={accountId} />;
  else if (section === "secrets") content = <VaultPanel base={base} />;
  else if (section === "permissions")
    content = (
      <ResourceCollection
        path={`${base}/grants`}
        spec={{
          title: "Account access grants",
          singular: "grant",
          fields: grantFields,
          columns: ["principal_id", "role_id", "effect", "expires_at"],
          edit: false,
        }}
      />
    );
  else if (section === "runners")
    content = (
      <RunnerPools base={base} linkBase={`/accounts/${accountId}/runners`} />
    );
  else if (section === "audit") content = <AuditPanel path={`${base}/audit`} />;
  else if (section === "exports")
    content = <AccountExportsPanel accountId={accountId} />;
  else if (section === "settings")
    content = (
      <>
        <Panel title="Account settings">
          {data.type === "organization" ? (
            <ResourceForm
              path={base}
              initial={account.snapshot}
              fields={[
                nameField,
                { name: "slug", label: "URL name", required: true },
                { name: "description", label: "Description", type: "textarea" },
              ]}
              draftKey={`${base}:settings`}
              onSaved={account.refresh}
            />
          ) : (
            <div className="panel-body">
              <Link className="button button-secondary" to="/settings/profile">
                Edit personal account profile
              </Link>
            </div>
          )}
        </Panel>
        <AccountPolicyPanel base={base} />
      </>
    );
  else content = <Empty title="Account section not found" />;
  return (
    <>
      <PageHeader
        eyebrow={
          data.type === "organization" ? "Organization" : "Personal account"
        }
        title={data.name}
        description={`@${data.slug}`}
        actions={
          <Link className="button button-secondary" to={`/billing/${data.id}`}>
            Billing & usage
          </Link>
        }
      />
      <div className="settings-layout">
        <nav className="settings-navigation" aria-label="Account navigation">
          {accountSections
            .filter(
              ([path]) =>
                data.type === "organization" ||
                !["members", "teams", "invitations", "sso"].includes(path!),
            )
            .map(([path, label]) => (
              <NavLink
                key={path}
                className={section === path ? "active" : ""}
                end
                to={`/accounts/${accountId}/${path}`}
              >
                {label}
              </NavLink>
            ))}
        </nav>
        <div className="settings-content stack">{content}</div>
      </div>
    </>
  );
}

export function TeamPage() {
  const { accountId = "", teamId = "" } = useParams();
  const base = endpoints.account(
    accountId,
    `teams/${encodeURIComponent(teamId)}`,
  );
  const team = useResource<Entity>(base);
  return (
    <>
      <PageHeader
        eyebrow={<Link to={`/accounts/${accountId}/teams`}>Teams</Link>}
        title={team.data ? displayName(team.data) : "Team"}
      />
      <ErrorNotice error={team.error} retry={team.refresh} />
      <div className="stack">
        <ResourceCollection
          path={`${base}/members`}
          spec={{
            title: "Team members",
            singular: "team member",
            fields: [
              {
                name: "principal_id",
                label: "User ID",
                required: true,
                createOnly: true,
              },
              {
                name: "role",
                label: "Team role",
                type: "select",
                options: ["member", "maintainer"],
                default: "member",
                required: true,
              },
            ],
            columns: ["principal_id", "role", "created_at"],
          }}
        />
        <TeamRepositoryGrant teamId={teamId} accountId={accountId} />
      </div>
    </>
  );
}

function TeamRepositoryGrant({
  teamId,
  accountId,
}: {
  teamId: string;
  accountId: string;
}) {
  const [repoId, setRepoId] = useState("");
  const [role, setRole] = useState("reader");
  const [granted, setGranted] = useState<Entity | null>(null);
  const mutation = useMutation();
  return (
    <Panel
      title="Repository access"
      description="Team access is an explicit repository grant, checked against the owning account's policy."
    >
      <form
        className="resource-form"
        onSubmit={(event) => {
          event.preventDefault();
          void mutation
            .run<Entity>(endpoints.repo(repoId, "collaborators"), {
              method: "POST",
              body: {
                principal_type: "team",
                principal_id: teamId,
                role_id: role,
                conditions: {},
              },
            })
            .then((result) => {
              if (result) setGranted(result.data);
            });
        }}
      >
        <div className="form-grid">
          <div className="field">
            <label htmlFor="team-repository-id">Repository ID</label>
            <input
              id="team-repository-id"
              value={repoId}
              onChange={(event) => setRepoId(event.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="team-role">Role ID</label>
            <input
              id="team-role"
              value={role}
              onChange={(event) => setRole(event.target.value)}
              required
            />
          </div>
        </div>
        <ErrorNotice error={mutation.error} />
        {granted && (
          <Notice tone="success">
            Team access granted.{" "}
            <Link to={repoLink(repoId, "settings/access")}>
              Review repository access
            </Link>
            .
          </Notice>
        )}
        <div className="form-actions">
          <Link to={`/repos?owner_id=${accountId}`}>Find a repository</Link>
          <Button type="submit" variant="primary" busy={mutation.pending}>
            Grant team access
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function AccountPolicyPanel({ base }: { base: string }) {
  const policy = useResource<Entity>(`${base}/policy`);
  const [preview, setPreview] = useState<unknown>(null);
  return (
    <Panel
      title="Account policy ceiling"
      description="Policy applies to all current grants and credentials in this account."
    >
      <ErrorNotice error={policy.error} retry={policy.refresh} />
      {policy.snapshot ? (
        <ResourceForm
          path={`${base}/policy`}
          method="PUT"
          initial={policy.snapshot}
          fields={[
            {
              name: "policy",
              label: "Typed account policy",
              type: "json",
              required: true,
            },
          ]}
          transform={(body) => record(body.policy)}
          draftKey={`${base}:policy`}
          onSaved={policy.refresh}
        />
      ) : (
        policy.loading && <Loading />
      )}
      {policy.data && (
        <ResourceForm
          key={`preview-${text(policy.data.revision)}`}
          path={`${base}/policy/preview`}
          fields={[
            {
              name: "policy",
              label: "Policy to preview",
              type: "json",
              required: true,
              default: policy.data.policy,
            },
          ]}
          transform={(body) => record(body.policy)}
          submitLabel="Preview policy"
          onSaved={(result) => setPreview(result.data)}
        />
      )}
      {preview !== null && (
        <div className="panel-body">
          <pre className="source-preview">
            {JSON.stringify(preview, null, 2)}
          </pre>
        </div>
      )}
    </Panel>
  );
}

export function AccountIntegrations({
  accountId,
  repoId,
}: {
  accountId: string;
  repoId?: string;
}) {
  const base = endpoints.account(accountId);
  const installationFields: Field[] = [
    { name: "application_id", label: "Application ID", required: true },
    {
      name: "repository_ids",
      label: "Repository scope",
      type: "csv",
      default: repoId ? [repoId] : [],
      required: true,
    },
    capabilityField,
  ];
  return (
    <div className="stack">
      <ResourceCollection
        path={`${base}/applications`}
        spec={{
          title: "Registered applications",
          singular: "application",
          fields: [
            nameField,
            { name: "description", label: "Description", type: "textarea" },
            { name: "homepage_url", label: "HTTPS homepage", type: "url" },
            capabilityField,
          ],
          columns: ["name", "homepage_url", "capabilities"],
        }}
      />
      <ResourceCollection
        path={`${base}/installations`}
        spec={{
          title: "Account installations",
          singular: "installation",
          fields: installationFields,
          editFields: [
            installationFields[1]!,
            capabilityField,
            {
              name: "suspended",
              label: "Suspend installation",
              type: "checkbox",
            },
          ],
          columns: ["application_id", "repository_ids", "capabilities"],
        }}
        actions={(installation, reload) => (
          <ActionButton
            path="/v1/tokens"
            label="Issue installation token"
            sensitive
            body={{
              kind: "installation",
              principal_id: installation.id,
              account_ids: [accountId],
              repository_ids: installation.repository_ids,
            }}
            fields={[
              nameField,
              { ...capabilityField, default: installation.capabilities },
              {
                ...expiryField,
                help: "Installation credentials must expire within one hour.",
              },
            ]}
            onDone={reload}
          />
        )}
      />
    </div>
  );
}

export function InvitationsPage() {
  const { invitationId } = useParams();
  const invitations = useCollection<Entity>(
    invitationId ? null : "/v1/invitations",
  );
  const single = useResource<Entity>(
    invitationId ? `/v1/invitations/${encodeURIComponent(invitationId)}` : null,
  );
  const items = invitationId
    ? single.data
      ? [single.data]
      : []
    : invitations.items;
  return (
    <>
      <PageHeader
        title="Your invitations"
        description="Review the destination, role, expiration, and seat impact before joining."
      />
      <Panel>
        <ErrorNotice error={invitations.error} retry={invitations.refresh} />
        <ErrorNotice error={single.error} retry={single.refresh} />
        {items.map((invitation) => (
          <Invitation
            key={invitation.id}
            invitation={invitation}
            refresh={invitations.refresh}
          />
        ))}
        {!invitations.items.length &&
          !invitations.loading &&
          !invitations.error && <Empty title="No pending invitations" />}
        <Pagination {...invitations} />
      </Panel>
    </>
  );
}

function Invitation({
  invitation,
  refresh,
}: {
  invitation: Entity;
  refresh: () => void;
}) {
  const path = `/v1/invitations/${invitation.id}`;
  const preview = useResource<Entity>(path);
  const [params] = useSearchParams();
  const { invitationId } = useParams();
  const quote = record(preview.data?.seat_quote);
  const tokenField: Field = {
    name: "token",
    label: "Invitation token from your email",
    type: "password",
    autoComplete: "off",
    required: true,
    default: invitationId === invitation.id ? params.get("token") || "" : "",
  };
  return (
    <article className="invitation-row">
      <div>
        <h3>
          {text(
            invitation.account_name || invitation.organization_name,
            invitation.account_id as string,
          )}
        </h3>
        <Metadata
          values={{
            role: invitation.role_id,
            expires_at: invitation.expires_at,
          }}
        />
        <ErrorNotice error={preview.error} retry={preview.refresh} />
        {preview.data && <Metadata values={preview.data} />}
        {preview.data && (
          <Notice>
            Payer: {text(preview.data.payer_account_id)}. Additional monthly
            seat cost: <Amount value={quote.monthly_delta_units} />.
            Current-period maximum:{" "}
            <Amount value={quote.maximum_current_period_units} />.
          </Notice>
        )}
      </div>
      <div className="row-actions">
        {preview.data && (
          <ActionButton
            path={`${path}/accept`}
            resourcePath={path}
            label="Accept invitation"
            description="Accept the displayed role and seat-cost effect."
            fields={[tokenField]}
            sensitive
            body={{
              seat_quote: {
                subscription_revision: quote.subscription_revision,
                plan_id: quote.plan_id,
                maximum_monthly_units: quote.monthly_delta_units,
                maximum_current_period_units:
                  quote.maximum_current_period_units,
              },
            }}
            onDone={refresh}
          />
        )}
        <ActionButton
          path={`${path}/decline`}
          resourcePath={path}
          label="Decline"
          fields={[tokenField]}
          sensitive
          onDone={refresh}
        />
      </div>
    </article>
  );
}

export function RunnerPools({
  base,
  linkBase,
}: {
  base: string;
  linkBase: string;
}) {
  const repositoryScope = base.startsWith("/v1/repos/");
  const repository = useResource<Entity>(repositoryScope ? base : null);
  const accountId = repositoryScope
    ? text(repository.data?.owner_id)
    : base.split("/")[3] || "";
  if (!accountId)
    return (
      <>
        <ErrorNotice error={repository.error} retry={repository.refresh} />
        {repository.loading && <Loading />}
      </>
    );
  return (
    <ResourceCollection
      path={query(
        "/v1/runner-pools",
        repositoryScope
          ? { repo_id: base.split("/")[3] }
          : { account_id: accountId },
      )}
      spec={{
        title: "Runner pools",
        singular: "runner pool",
        description:
          "Customer-owned machines connect outbound over HTTPS. Untrusted work requires a designated disposable pool.",
        fields: [
          nameField,
          {
            name: "account_id",
            label: "Owning account",
            default: accountId,
            readOnly: true,
            required: true,
          },
          {
            name: "repo_id",
            label: repositoryScope
              ? "Repository scope"
              : "Repository scope (optional)",
            default: repositoryScope ? base.split("/")[3] : "",
            readOnly: repositoryScope,
            required: repositoryScope,
            help: repositoryScope
              ? "This pool belongs to this repository."
              : "Leave empty for an account-scoped pool.",
          },
          {
            name: "os",
            label: "Operating system",
            type: "select",
            options: ["linux", "darwin", "windows"],
            required: true,
          },
          {
            name: "architecture",
            label: "Architecture",
            type: "select",
            options: ["amd64", "arm64"],
            required: true,
          },
          {
            name: "trust",
            label: "Trust level",
            type: "select",
            options: ["trusted", "untrusted"],
            default: "trusted",
            required: true,
          },
          {
            name: "isolation",
            label: "Machine isolation",
            type: "select",
            options: ["persistent", "ephemeral"],
            default: "ephemeral",
            required: true,
          },
          {
            name: "toolchains",
            label: "Toolchain SHA-256 fingerprints",
            type: "csv",
            required: true,
          },
          {
            name: "max_slots",
            label: "Maximum active jobs",
            type: "number",
            default: 1,
            min: 1,
            max: 16,
            required: true,
          },
          {
            name: "max_runners",
            label: "Maximum enrolled machines",
            type: "number",
            default: 10,
            min: 1,
            max: 1000,
            required: true,
          },
        ],
        editFields: [
          {
            name: "state",
            label: "Pool state",
            type: "select",
            options: ["active", "disabled"],
            required: true,
          },
        ],
        allowDelete: false,
        columns: ["name", "os", "architecture", "trust"],
        itemPath: (pool) => `/v1/runner-pools/${pool.id}`,
        rowPath: (pool) => `${linkBase}/${pool.id}`,
      }}
    />
  );
}

export function RepositoryRunnersPage() {
  const { repo } = useRepository();
  return (
    <>
      <PageHeader title="Runner pools" />
      <RunnerPools
        base={endpoints.repo(repo.id)}
        linkBase={repoLink(repo.id, "runners")}
      />
    </>
  );
}

export function RunnerPoolPage() {
  const { accountId, repoId, poolId = "" } = useParams();
  const base = repoId
    ? endpoints.repo(repoId)
    : endpoints.account(accountId || "");
  const path = `${base}/runner-pools/${encodeURIComponent(poolId)}`;
  const pool = useResource<Entity>(path);
  const runners = useCollection<Entity>(`${path}/runners`, { poll: 10_000 });
  const [enrollment, setEnrollment] = useState<unknown>(null);
  return (
    <>
      <PageHeader
        title={pool.data ? displayName(pool.data) : "Runner pool"}
        description="One-time enrollment, explicit capabilities, and revocable machine identities."
        actions={
          <ActionButton
            path={`${path}/enrollments`}
            snapshot={pool.snapshot}
            label="Enroll runner"
            fields={[
              {
                name: "expires_in_seconds",
                label: "Enrollment validity (seconds)",
                type: "number",
                default: 600,
                min: 60,
                max: 3600,
                required: true,
              },
            ]}
            onDone={(result) => setEnrollment(result.data)}
          />
        }
      />
      <ErrorNotice error={pool.error} retry={pool.refresh} />
      {pool.data && (
        <Panel title="Pool capabilities">
          <div className="panel-body">
            <Metadata values={pool.data} />
          </div>
        </Panel>
      )}
      <OneTimeValue value={enrollment} title="Runner enrollment" />
      {record(enrollment).token !== undefined && (
        <Notice>
          <code>gitknot runner register --token &lt;enrollment-token&gt;</code>
          <p>
            Run this on the customer-owned machine. Store the resulting machine
            credential outside job workspaces.
          </p>
        </Notice>
      )}
      <Panel title="Enrolled runners">
        <ErrorNotice error={runners.error} retry={runners.refresh} />
        {runners.items.map((runner) => (
          <article className="runner-row" key={runner.id}>
            <div>
              <strong>{displayName(runner)}</strong>
              <Status value={runner.state || runner.status} />
              <Metadata
                values={{
                  online: runner.online,
                  last_heartbeat: runner.last_seen_at,
                  slots: runner.max_slots || runner.slots,
                  toolchain: runner.toolchains,
                  active_attempt: runner.attempt_id,
                }}
              />
            </div>
            <ActionButton
              path={`/v1/runners/${runner.id}`}
              snapshot={revisionSnapshot(runner)}
              label="Revoke runner"
              method="PATCH"
              body={{ state: "revoked" }}
              description="Stop new assignments and revoke machine credentials. In-flight attempts remain fenced until their outcome is confirmed."
              danger
              onDone={runners.refresh}
            />
          </article>
        ))}
        {!runners.items.length && !runners.loading && !runners.error && (
          <Empty
            title="No machines enrolled"
            description="Create a short-lived enrollment token and register a machine with the GitKnot runner."
          />
        )}
        <Pagination {...runners} />
      </Panel>
    </>
  );
}

export function EnvironmentPage() {
  const { repoId = "", environmentId = "" } = useParams();
  const { session } = useAuth();
  const path = endpoints.repo(
    repoId,
    `environments/${encodeURIComponent(environmentId)}`,
  );
  const environment = useResource<Entity>(path);
  const deleted = environment.data?.state === "deleted";
  return (
    <>
      <PageHeader
        title={environment.data ? displayName(environment.data) : "Environment"}
        actions={
          session &&
          environment.data &&
          !deleted && (
            <ActionButton
              path={path}
              resourcePath={path}
              snapshot={environment.snapshot}
              method="DELETE"
              label="Delete environment"
              description="Delete this idle environment and invalidate its unused approvals. Active jobs, cleanup, promotion barriers, and live vault entries must be resolved first."
              confirmText={displayName(environment.data)}
              danger
              onDone={environment.refresh}
            />
          )
        }
      />
      <ErrorNotice error={environment.error} retry={environment.refresh} />
      {deleted && (
        <Notice>
          This environment is deleted. Its metadata and release history remain
          available for review.
        </Notice>
      )}
      {environment.data && (
        <Panel title="Destination and approval policy">
          <div className="panel-body">
            <Metadata values={environment.data} />
          </div>
        </Panel>
      )}
      <div className="stack">
        {environment.data && !deleted && <VaultPanel base={path} />}
        <ResourceCollection
          path={endpoints.repo(repoId, "releases")}
          spec={{
            title: "Repository releases",
            singular: "release",
            description:
              "Release records bind the verified artifact, source, approval, and destination.",
            fields: [],
            columns: ["artifact_digest", "destination", "created_at"],
            create: false,
            rowPath: (release) =>
              repoLink(repoId, `runs/${text(release.run_id)}`),
            edit: false,
            allowDelete: false,
          }}
        />
        {!deleted && (
          <Panel title="Promote a verified artifact">
            <div className="panel-body">
              <Link
                className="button button-primary"
                to={repoLink(repoId, "workflows")}
              >
                Choose an output from a workflow run
              </Link>
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}

export function TransferPage() {
  const { repoId = "", transferId = "" } = useParams();
  const path = endpoints.repo(
    repoId,
    `transfers/${encodeURIComponent(transferId)}`,
  );
  const transfer = useResource<Entity>(path);
  const navigate = useNavigate();
  return (
    <>
      <PageHeader
        title="Repository ownership transfer"
        description="Review the destination, audience, access, and billing ownership before accepting."
      />
      <ErrorNotice error={transfer.error} retry={transfer.refresh} />
      {transfer.loading && !transfer.data ? (
        <Loading />
      ) : (
        transfer.data && (
          <Panel title={<Status value={transfer.data.state} />}>
            <div className="panel-body">
              <Metadata values={transfer.data} />
              <CopyButton
                value={`${location.origin}/transfers/${repoId}/${transferId}`}
                label="Copy acceptance link"
              />
              {transfer.data.state === "awaiting_acceptance" && (
                <div className="row-actions">
                  <ActionButton
                    path={`${path}/accept`}
                    snapshot={transfer.snapshot}
                    label="Accept ownership"
                    description="Accept the repository, its future charges, and the receiving account's policy. Credentials and integrations are reconciled before writes reopen."
                    onDone={(result) => {
                      const operationId = text(
                        result.data?.operation_id ||
                          record(result.data?.operation).id,
                      );
                      if (operationId) navigate(`/operations/${operationId}`);
                      else transfer.refresh();
                    }}
                  />
                  <ActionButton
                    path={path}
                    snapshot={transfer.snapshot}
                    method="DELETE"
                    label="Decline or cancel transfer"
                    onDone={transfer.refresh}
                  />
                </div>
              )}
            </div>
          </Panel>
        )
      )}
    </>
  );
}
