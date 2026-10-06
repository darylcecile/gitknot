import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import {
  ArrowRight,
  Check,
  Code2,
  FolderGit2,
  GitPullRequest,
  KeyRound,
  Search,
  Terminal,
} from "lucide-react";
import { endpoints, repoLink } from "../api/endpoints.ts";
import { apiUrl } from "../api/client.ts";
import { useResource } from "../api/hooks.ts";
import { array, humanize, record, text, type Entity } from "../api/types.ts";
import { ActionButton } from "../components/forms.tsx";
import {
  Button,
  DownloadButton,
  Empty,
  ErrorNotice,
  JsonDetails,
  Loading,
  Metadata,
  Notice,
  PageHeader,
  Panel,
  Status,
  Time,
} from "../components/ui.tsx";

export function OperationPage() {
  const { operationId = "" } = useParams();
  const [poll, setPoll] = useState(3000);
  const operation = useResource<Entity>(endpoints.operation(operationId), {
    poll,
  });
  useEffect(() => {
    if (
      ["completed", "succeeded", "failed", "cancelled"].includes(
        text(operation.data?.state),
      )
    )
      setPoll(0);
  }, [operation.data?.state]);
  const data = operation.data;
  const result = record(data?.result);
  return (
    <>
      <PageHeader
        eyebrow="Durable operation"
        title={data ? humanize(data.type || data.kind) : "Operation"}
        description={operationId}
      />
      <ErrorNotice error={operation.error} retry={operation.refresh} />
      {operation.loading && !data ? (
        <Loading />
      ) : (
        data && (
          <Panel
            title={<Status value={data.state} />}
            actions={<Button onClick={operation.refresh}>Refresh</Button>}
          >
            <div className="panel-body">
              <p>{text(data.description || data.message)}</p>
              <Metadata
                values={{
                  resource: data.resource_id || data.repo_id,
                  initiated_by: data.actor_id,
                  created_at: data.created_at,
                  updated_at: data.updated_at,
                  progress: data.progress,
                  waiting_for: data.waiting_for,
                }}
              />
              {data.error !== undefined && (
                <Notice tone="warning">
                  {text(record(data.error).message || data.error)}
                </Notice>
              )}
              {array<Entity>(data.steps).map((step, index) => (
                <article className="operation-step" key={step.id || index}>
                  <Status value={step.state} />
                  <div>
                    <strong>{text(step.name || step.type)}</strong>
                    <p>{text(step.description || step.message)}</p>
                  </div>
                </article>
              ))}
              {data.state === "failed" && (
                <ActionButton
                  path={`${endpoints.operation(operationId)}/retry`}
                  snapshot={operation.snapshot}
                  label="Retry operation"
                  onDone={operation.refresh}
                />
              )}
              {data.state === "pending" && (
                <ActionButton
                  path={`${endpoints.operation(operationId)}/cancel`}
                  snapshot={operation.snapshot}
                  label="Cancel before execution"
                  danger
                  onDone={operation.refresh}
                />
              )}
              {(data.state === "completed" || data.state === "succeeded") && (
                <div className="row-actions">
                  {text(data.repo_id || result.repo_id) && (
                    <Link
                      className="button button-primary"
                      to={repoLink(text(data.repo_id || result.repo_id))}
                    >
                      Open repository
                      <ArrowRight size={15} />
                    </Link>
                  )}
                  {(typeof result.download_path === "string" ||
                    typeof result.archive_id === "string") && (
                    <DownloadButton
                      path={text(
                        result.download_path,
                        `/v1/archives/${text(result.archive_id)}/content`,
                      )}
                      name={`${operationId}.tar.gz`}
                    >
                      Download archive
                    </DownloadButton>
                  )}
                  {data.kind === "repository.export" && (
                    <Link
                      className="button button-secondary"
                      to={repoLink(text(data.repo_id), "settings/exports")}
                    >
                      Open verified exports
                    </Link>
                  )}
                </div>
              )}
              <JsonDetails
                title="Operation receipts and lineage"
                value={data}
              />
            </div>
          </Panel>
        )
      )}
    </>
  );
}

export function HelpPage() {
  const topics = [
    {
      icon: FolderGit2,
      title: "Start with a repository",
      body: "Create a repository under a personal account or organization. Choose its audience explicitly, then push your project using the HTTPS remote.",
      to: "/repos",
      label: "Open repositories",
    },
    {
      icon: GitPullRequest,
      title: "Keep the decision with the code",
      body: "Issues capture work, tasks coordinate contributors, and pull requests tie reviews to immutable patch versions. Select a diff line to start a review thread.",
      to: "/repos",
      label: "Find a project",
    },
    {
      icon: KeyRound,
      title: "Keep access specific",
      body: "Use scoped, expiring tokens for automation. Roles, credential scopes, and organization ceilings determine effective access; explicit denials win.",
      to: "/settings/tokens",
      label: "Manage credentials",
    },
    {
      icon: Terminal,
      title: "Run with reproducible inputs",
      body: "Validate workflow YAML before execution. Every run pins its source, workflow digest, toolchain, producer, outputs, and policy. Budgets reserve cost before admission.",
      to: "/billing",
      label: "View cost controls",
    },
  ];
  return (
    <>
      <PageHeader
        title="A clear place to build."
        description="A short guide to finding your way around GitKnot."
      />
      <div className="help-grid">
        {topics.map((topic) => (
          <Panel
            key={topic.title}
            title={
              <>
                <topic.icon size={20} />
                {topic.title}
              </>
            }
          >
            <div className="panel-body">
              <p>{topic.body}</p>
              <Link to={topic.to}>
                {topic.label} <ArrowRight size={14} />
              </Link>
            </div>
          </Panel>
        ))}
      </div>
      <Panel title="Keyboard and editing">
        <div className="panel-body">
          <dl className="keyboard-list">
            <div>
              <dt>
                <kbd>⌘ / Ctrl</kbd> + <kbd>K</kbd>
              </dt>
              <dd>Focus workspace search</dd>
            </div>
            <div>
              <dt>
                <kbd>Tab</kbd> / <kbd>Shift Tab</kbd>
              </dt>
              <dd>
                Move between controls; in rich-text tables, move between cells
              </dd>
            </div>
            <div>
              <dt>
                <kbd>Escape</kbd>
              </dt>
              <dd>Close a dialog or mobile navigation</dd>
            </div>
            <div>
              <dt>
                <kbd>⌘ / Ctrl B</kbd> / <kbd>I</kbd>
              </dt>
              <dd>Bold or italic in rich editing</dd>
            </div>
            <div>
              <dt>
                <kbd>⌘ / Ctrl Z</kbd>
              </dt>
              <dd>Undo an edit</dd>
            </div>
          </dl>
          <p>
            Markdown is canonical. Switching between rich text and source
            preserves unsupported blocks exactly. Conflicting saves keep your
            draft and let you inspect the latest server revision.
          </p>
        </div>
      </Panel>
      <Panel title="API & command line">
        <div className="panel-body">
          <p>
            The web application uses the same versioned API as automation.
            Requests use resource revisions, idempotency keys, and current
            access checks.
          </p>
          <div className="row-actions">
            <Link to="/docs/cli" className="button button-secondary">
              CLI guide
            </Link>
            <Link to="/docs/workflows" className="button button-secondary">
              Workflow guide
            </Link>
            <Link to="/docs/api" className="button button-secondary">
              API guide
            </Link>
            <a
              href={apiUrl("/openapi.json")}
              className="button button-secondary"
            >
              <Code2 size={16} />
              OpenAPI specification
            </a>
            <Link to="/support">Request troubleshooting & support</Link>
          </div>
        </div>
      </Panel>
    </>
  );
}

export function NotFoundPage() {
  return (
    <>
      <PageHeader eyebrow="404" title="This thread ends here." />
      <Panel>
        <Empty
          title="Page not found"
          description="The URL may have changed, or this resource is no longer available to your account."
          action={
            <Link className="button button-primary" to="/">
              Back to your workspace
            </Link>
          }
        />
      </Panel>
    </>
  );
}
