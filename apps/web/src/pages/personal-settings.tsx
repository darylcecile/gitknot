import { useState } from "react";
import { Link, NavLink, useParams } from "react-router";
import { KeyRound, ShieldCheck } from "lucide-react";
import { useAuth } from "../auth.tsx";
import { endpoints } from "../api/endpoints.ts";
import { request, revisionSnapshot } from "../api/client.ts";
import { useCollection, useMutation, useResource } from "../api/hooks.ts";
import { record, text, type Entity } from "../api/types.ts";
import {
  ActionButton,
  OneTimeValue,
  ResourceForm,
  expiryField,
  nameField,
  type Field,
} from "../components/forms.tsx";
import {
  Button,
  ErrorNotice,
  JsonDetails,
  Loading,
  Metadata,
  Modal,
  Notice,
  PageHeader,
  Panel,
  Status,
  Time,
} from "../components/ui.tsx";
import { ResourceCollection } from "../components/resources.tsx";
import { subscriptionFields } from "../components/subscription.tsx";
import { FederationSignIn } from "./federation.tsx";

const sections = [
  ["profile", "Public profile"],
  ["security", "Password & sign-in"],
  ["sessions", "Sessions"],
  ["tokens", "Personal tokens"],
  ["notifications", "Notifications"],
  ["privacy", "Privacy"],
  ["federation", "Federated identities"],
];

export function PersonalSettingsPage() {
  const { section = "profile" } = useParams();
  const auth = useAuth();
  const profile = useResource<Entity>(endpoints.me);
  let content;
  if (section === "profile")
    content = (
      <Panel
        title="Public profile"
        description="Your identity across repositories and conversations."
      >
        <ErrorNotice error={profile.error} retry={profile.refresh} />
        {profile.snapshot ? (
          <ResourceForm
            path={endpoints.me}
            initial={{
              ...profile.snapshot,
              data: (profile.data?.user || profile.data) as Entity,
            }}
            fields={[
              { name: "display_name", label: "Name", required: true },
              { name: "bio", label: "Bio", type: "textarea" },
              { name: "avatar_url", label: "Avatar URL", type: "url" },
            ]}
            draftKey="me:profile"
            onSaved={() => {
              profile.refresh();
              void auth.refresh();
            }}
          />
        ) : (
          profile.loading && <Loading />
        )}
      </Panel>
    );
  else if (section === "security") content = <SecuritySettings />;
  else if (section === "sessions")
    content = (
      <ResourceCollection
        path={endpoints.sessions}
        spec={{
          title: "Active sessions",
          singular: "session",
          fields: [],
          create: false,
          edit: false,
          columns: ["name", "created_at", "last_used_at", "expires_at"],
          description:
            "Revoke sessions you no longer use. Revocation is checked against current authoritative state.",
        }}
      />
    );
  else if (section === "tokens")
    content = (
      <ResourceCollection
        path={endpoints.tokens}
        spec={{
          title: "Personal access tokens",
          singular: "token",
          fields: [
            nameField,
            {
              name: "capabilities",
              label: "Capabilities",
              type: "csv",
              required: true,
            },
            {
              name: "repository_ids",
              label: "Repository IDs",
              type: "csv",
              required: true,
            },
            { name: "account_ids", label: "Account IDs", type: "csv" },
            expiryField,
          ],
          sensitive: true,
          edit: false,
          columns: ["name", "capabilities", "expires_at", "last_used_at"],
          description:
            "Tokens add restrictions to your current grants. A token never grants more access than its owner.",
        }}
      />
    );
  else if (section === "notifications")
    content = (
      <>
        <PreferenceForm
          path="/v1/me/email-preferences"
          title="Notification preferences"
          fields={[
            {
              name: "transactional",
              label: "Email notifications",
              type: "checkbox",
              default: true,
            },
            {
              name: "digest",
              label: "Digest frequency",
              type: "select",
              options: ["off", "daily", "weekly"],
              default: "daily",
            },
          ]}
        />
        <PreferenceForm
          path={`/v1/users/${auth.session!.user.id}/preferences`}
          title="Activity and follow privacy"
          fields={[
            {
              name: "activity_visibility",
              label: "Activity audience",
              type: "select",
              options: ["public", "followers", "private"],
              required: true,
            },
            {
              name: "show_follow_graph",
              label: "Show follower and following lists",
              type: "checkbox",
            },
            {
              name: "digest",
              label: "Activity digest",
              type: "select",
              options: ["off", "daily", "weekly"],
              required: true,
            },
          ]}
        />
        <ResourceCollection
          path="/v1/subscriptions"
          spec={{
            title: "Thread and repository subscriptions",
            singular: "subscription",
            fields: [
              {
                name: "repo_id",
                label: "Repository ID",
                required: true,
                createOnly: true,
              },
              {
                name: "item_id",
                label: "Conversation ID (optional)",
                createOnly: true,
              },
              ...subscriptionFields,
            ],
            columns: ["repo_id", "item_id", "mode", "digest"],
          }}
        />
      </>
    );
  else if (section === "privacy")
    content = (
      <PreferenceForm
        path="/v1/me"
        title="Profile privacy"
        fields={[
          {
            name: "show_email",
            label: "Show email on public profile",
            type: "checkbox",
            default: false,
          },
          {
            name: "profile_visibility",
            label: "Profile visibility",
            type: "select",
            options: ["public", "private"],
            default: "public",
          },
        ]}
      />
    );
  else if (section === "federation") content = <FederationSignIn link />;
  else content = <Notice>Choose a settings section.</Notice>;
  return (
    <>
      <PageHeader
        title="Your settings"
        description="A profile that feels like you, with access you can account for."
      />
      <div className="settings-layout">
        <nav className="settings-navigation" aria-label="Personal settings">
          {sections.map(([path, label]) => (
            <NavLink
              end
              key={path}
              className={path === section ? "active" : ""}
              to={`/settings/${path}`}
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

function PreferenceForm({
  path,
  title,
  fields,
}: {
  path: string;
  title: string;
  fields: Field[];
}) {
  const resource = useResource<Entity>(path);
  const [saved, setSaved] = useState(false);
  return (
    <Panel title={title}>
      <ErrorNotice error={resource.error} retry={resource.refresh} />
      {saved && <Notice tone="success">Preferences updated.</Notice>}
      {resource.snapshot ? (
        <ResourceForm
          key={path}
          path={path}
          fields={fields}
          initial={resource.snapshot}
          method={path.endsWith("email-preferences") ? "PUT" : "PATCH"}
          draftKey={path}
          onSaved={() => {
            setSaved(true);
            resource.refresh();
          }}
        />
      ) : (
        resource.loading && <Loading />
      )}
    </Panel>
  );
}

function SecuritySettings() {
  const auth = useAuth();
  const [mfa, setMfa] = useState<unknown>(null);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const security = useResource<Entity>("/v1/auth/security");
  const passkeys = useCollection<Entity>("/v1/auth/passkeys");
  const mutation = useMutation();
  return (
    <>
      <Panel title="Confirm your identity">
        <div className="panel-body">
          <p>Security administration requires a recent sign-in.</p>
          <ActionButton
            path="/v1/auth/reauthenticate"
            label="Confirm identity"
            fields={[
              {
                name: "password",
                label: "Password",
                type: "password",
                required: true,
              },
              { name: "code", label: "Authenticator code (if enabled)" },
              {
                name: "recovery_code",
                label: "Recovery code (instead of authenticator)",
              },
            ]}
            sensitive
            onDone={() => {
              security.refresh();
              void auth.refresh();
            }}
          />
        </div>
      </Panel>
      <Panel title="Change password">
        {passwordSaved && <Notice tone="success">Password changed.</Notice>}
        <ResourceForm
          path="/v1/auth/password"
          fields={[
            {
              name: "current_password",
              label: "Current password",
              type: "password",
              required: true,
            },
            {
              name: "new_password",
              label: "New password",
              type: "password",
              required: true,
              help: "Use a unique password with at least 12 characters.",
            },
            { name: "code", label: "Authenticator code (if enabled)" },
            {
              name: "recovery_code",
              label: "Recovery code (instead of authenticator)",
            },
          ]}
          submitLabel="Change password"
          onSaved={() => {
            setPasswordSaved(true);
            void auth.refresh();
          }}
        />
      </Panel>
      <Panel title="Multi-factor authentication">
        <div className="panel-body">
          <ErrorNotice error={security.error} retry={security.refresh} />
          {security.data && (
            <Metadata
              values={{
                mfa_enabled: security.data.mfa_enabled,
                email_verified_at: security.data.email_verified_at,
              }}
            />
          )}
          <div className="row-actions">
            <ActionButton
              path="/v1/auth/mfa/setup"
              label="Set up authenticator"
              sensitive
              onDone={(result) => setMfa(result.data)}
            />
            <ActionButton
              path="/v1/auth/mfa/recovery-codes"
              label="Regenerate recovery codes"
              sensitive
              onDone={(result) => setMfa(result.data)}
            />
            <ActionButton
              path="/v1/auth/mfa/totp"
              snapshot={security.snapshot}
              label="Remove authenticator"
              method="DELETE"
              fields={[
                { name: "code", label: "Authenticator code", required: true },
              ]}
              danger
              sensitive
              onDone={security.refresh}
            />
          </div>
          {mfa !== null && (
            <>
              <OneTimeValue
                value={mfa}
                title="Save your recovery information"
              />
              {record(mfa).otpauth_url !== undefined && (
                <div>
                  <p>
                    Add this enrollment URI to your authenticator, then confirm
                    the generated code.
                  </p>
                  <pre className="selectable">
                    {text(record(mfa).otpauth_url)}
                  </pre>
                  <ResourceForm
                    path="/v1/auth/mfa/enable"
                    fields={[
                      {
                        name: "code",
                        label: "Authenticator code",
                        required: true,
                      },
                    ]}
                    transform={(body) => ({
                      ...body,
                      challenge_id: record(mfa).challenge_id,
                    })}
                    submitLabel="Enable MFA"
                    onSaved={(result) => {
                      setMfa(result.data);
                      security.refresh();
                    }}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </Panel>
      <Panel
        title="Passkeys"
        description="Use your device’s biometric or security-key authentication."
      >
        <div className="panel-body">
          <ErrorNotice error={passkeys.error} retry={passkeys.refresh} />
          {passkeys.items.map((passkey) => (
            <div className="setting-row" key={passkey.id}>
              <div>
                <strong>{text(passkey.name, "Passkey")}</strong>
                <p>
                  Last used <Time value={passkey.last_used_at} />
                </p>
              </div>
              <ActionButton
                path={`/v1/auth/passkeys/${passkey.id}`}
                snapshot={revisionSnapshot(passkey)}
                method="DELETE"
                label="Remove passkey"
                danger
                onDone={passkeys.refresh}
              />
            </div>
          ))}
          <PasskeyRegistration onRegistered={passkeys.refresh} />
        </div>
      </Panel>
    </>
  );
}

function PasskeyRegistration({ onRegistered }: { onRegistered: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [name, setName] = useState("");
  const [registered, setRegistered] = useState<unknown>(null);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        void (async () => {
          try {
            if (
              !window.PublicKeyCredential ||
              !PublicKeyCredential.parseCreationOptionsFromJSON
            )
              throw new Error(
                "This browser does not support passkey registration. Use a current browser or a security key through another device.",
              );
            const options = await request<Entity>(
              "/v1/auth/passkeys/register/options",
              { method: "POST", body: { name } },
            );
            const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(
              (options.data.options ||
                options.data) as PublicKeyCredentialCreationOptionsJSON,
            );
            const credential = (await navigator.credentials.create({
              publicKey,
            })) as PublicKeyCredential | null;
            if (!credential) throw new Error("Passkey creation was cancelled.");
            const result = await request("/v1/auth/passkeys/register/verify", {
              method: "POST",
              body: {
                challenge_id: options.data.challenge_id,
                name,
                credential: credential.toJSON(),
              },
            });
            setRegistered(result.data);
            setName("");
            onRegistered();
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause
                : new Error("Passkey registration failed."),
            );
          } finally {
            setPending(false);
          }
        })();
      }}
    >
      <div className="field">
        <label htmlFor="passkey-name">Passkey name</label>
        <input
          id="passkey-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </div>
      <OneTimeValue value={registered} title="Save your recovery codes" />
      <ErrorNotice error={error} />
      <Button type="submit" busy={pending}>
        <KeyRound size={16} />
        Register passkey
      </Button>
    </form>
  );
}
