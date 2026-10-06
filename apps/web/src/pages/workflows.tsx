import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  Box,
  ChevronRight,
  Clock3,
  Download,
  GitCommitHorizontal,
  Play,
  Terminal,
  Workflow,
} from "lucide-react";
import { endpoints, query, repoLink } from "../api/endpoints.ts";
import {
  ApiError,
  apiUrl,
  readHeaders,
  revisionSnapshot,
} from "../api/client.ts";
import { useCollection, useMutation, useResource } from "../api/hooks.ts";
import {
  array,
  displayName,
  humanize,
  record,
  text,
  type Entity,
  type Snapshot,
} from "../api/types.ts";
import {
  ActionButton,
  CreateResource,
  EditResource,
  Fields,
  ResourceForm,
  fieldValues,
  nameField,
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
import { SourceEditor } from "../components/markdown/editor.tsx";
import { ResourceCollection } from "../components/resources.tsx";
import { useRepository } from "./repositories.tsx";
import { ReproduceRun } from "./reproduction.tsx";
import { useAuth } from "../auth-context.ts";
import { WorkflowInputsEditor } from "../components/editors/input-editor.tsx";
import { RevisionEditor, validateRevision } from "../components/editors/revision-picker.tsx";

function definitionFields(branch: string, commit = ""): Field[] { return [
  {
    name: "path",
    label: "Workflow file path",
    required: true,
    placeholder: ".gitknot/workflows/ci.yaml…",
  },
  {
    name: "source",
    label: "Definition revision",
    type: "custom",
    editor: RevisionEditor,
    validate: validateRevision,
    default: { ref: `refs/heads/${branch.replace(/^refs\/heads\//, "")}`, commit_oid: commit },
    required: true,
  },
]; }
const definitionBody = ({ source, ...body }: Record<string, unknown>) => ({ ...body, source_commit: record(source).commit_oid });
const runFields: Field[] = [
  {
    name: "source",
    label: "Run from",
    type: "custom",
    editor: RevisionEditor,
    default: {},
    required: true,
    validate: value => validateRevision(value) || (!record(value).ref ? "Choose a source ref." : undefined),
  },
  { name: "inputs", label: "Workflow inputs", type: "custom", editor: WorkflowInputsEditor, default: {}, section: "Customize inputs" },
];

const runBody = ({ source, ...body }: Record<string, unknown>) => ({ ...body, ...record(source) });

export function WorkflowsPage() {
  const { repo } = useRepository();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const workflows = useCollection<Entity>(endpoints.repo(repo.id, "workflows"));
  const runs = useCollection<Entity>(
    query(endpoints.repo(repo.id, "runs"), {
      workflow_id: params.get("workflow_id"),
      state: params.get("state"),
    }),
  );
  return (
    <>
      <PageHeader
        title="Workflows"
        description="Build, test, and ship your changes."
        actions={
          <>
            <Link
              className="button button-secondary"
              to={repoLink(repo.id, "workflows/validate")}
            >
              Validate a workflow
            </Link>
            <CreateResource
              path={endpoints.repo(repo.id, "workflows")}
              title="Add workflow"
              fields={definitionFields(repo.default_branch)}
              transform={definitionBody}
              onSaved={workflows.refresh}
            />
          </>
        }
      />
      <div className="workflow-layout">
        <aside className="workflow-list">
          <button
            type="button"
            className={!params.get("workflow_id") ? "active" : ""}
            onClick={() => setParams({})}
          >
            <Workflow size={17} />
            All workflows
          </button>
          <ErrorNotice error={workflows.error} retry={workflows.refresh} />
          {workflows.items.map((workflow) => (
            <Link
              key={workflow.id}
              to={repoLink(repo.id, `workflows/${workflow.id}`)}
            >
              <Workflow size={16} />
              <span>{displayName(workflow)}</span>
              <ChevronRight size={13} />
            </Link>
          ))}
          <Link to={repoLink(repo.id, "environments")}>Environments</Link>
          <Link to={repoLink(repo.id, "runners")}>Runner pools</Link>
        </aside>
        <Panel
          title="Recent runs"
          actions={
            <select
              aria-label="Filter run state"
              value={params.get("state") || ""}
              onChange={(event) => {
                const next = new URLSearchParams(params);
                next.set("state", event.target.value);
                setParams(next);
              }}
            >
              <option value="">All states</option>
              {[
                "planning",
                "queued",
                "running",
                "waiting",
                "waiting_approval",
                "cancelling",
                "passed",
                "failed",
                "cancelled",
                "timed_out",
                "not_applicable",
                "runner_unreachable",
              ].map((state) => (
                <option key={state}>{state}</option>
              ))}
            </select>
          }
        >
          <ErrorNotice error={runs.error} retry={runs.refresh} />
          {runs.loading && !runs.data ? (
            <Loading />
          ) : runs.items.length ? (
            runs.items.map((run) => (
              <RunRow key={run.id} run={run} repoId={repo.id} />
            ))
          ) : (
            !runs.error && (
              <Empty
                title="No matching runs in this view"
                description="Register a repository workflow, validate its plan, and run it against an exact revision."
              />
            )
          )}
          <Pagination {...runs} />
        </Panel>
      </div>
    </>
  );
}

function RunRow({ run, repoId }: { run: Entity; repoId: string }) {
  return (
    <article className="run-row">
      <Status value={run.state || run.status} />
      <div>
        <Link to={repoLink(repoId, `runs/${run.id}`)}>
          {text(run.title || run.workflow_name || run.name, run.id)}
        </Link>
        <p>
          {run.commit_oid ? (
            <code>{text(run.commit_oid).slice(0, 8)}</code>
          ) : run.requested_commit_sha ? (
            <span>
              Requested{" "}
              <code>{text(run.requested_commit_sha).slice(0, 8)}</code>
            </span>
          ) : null}
          <span>
            {text(
              run.ref ||
                run.source_ref ||
                run.requested_source_ref ||
                run.branch,
            )}
          </span>
          <span>{humanize(run.trigger_type || run.event_type)}</span>
        </p>
      </div>
      <div className="run-time">
        <Time value={run.created_at} />
        {run.duration_ms !== undefined && (
          <span>{Math.round(Number(run.duration_ms) / 1000)}s</span>
        )}
      </div>
    </article>
  );
}

export function WorkflowPage() {
  const { repo } = useRepository();
  const { workflowId = "" } = useParams();
  const navigate = useNavigate();
  const path = endpoints.repo(
    repo.id,
    `workflows/${encodeURIComponent(workflowId)}`,
  );
  const workflow = useResource<Entity>(path);
  const versions = useCollection<Entity>(`${path}/versions`);
  const runs = useCollection<Entity>(
    query(endpoints.repo(repo.id, "runs"), { workflow_id: workflowId }),
  );
  return (
    <>
      <PageHeader
        eyebrow={<Link to={repoLink(repo.id, "workflows")}>Workflows</Link>}
        title={workflow.data ? displayName(workflow.data) : "Workflow"}
        actions={
          <>
            <EditResource
              path={path}
              title="Edit workflow"
              fields={definitionFields(repo.default_branch, text(workflow.data?.source_commit))}
              transform={definitionBody}
              onSaved={() => {
                workflow.refresh();
                versions.refresh();
              }}
            />
            <ActionButton
              path={`${path}/runs`}
              snapshot={workflow.snapshot}
              label="Run workflow"
              variant="primary"
              fields={runFields}
              transform={runBody}
              onDone={(result) =>
                navigate(
                  repoLink(
                    repo.id,
                    `runs/${text(result.data.run_id || result.data.id)}`,
                  ),
                )
              }
            />
          </>
        }
      />
      <ErrorNotice error={workflow.error} retry={workflow.refresh} />
      {workflow.data && (
        <Panel title="Pinned definition">
          <div className="panel-body">
            <Metadata
              values={{
                path: workflow.data.path,
                ref: workflow.data.ref,
                digest: workflow.data.digest || workflow.data.definition_digest,
                enabled: workflow.data.enabled,
              }}
            />
            {workflow.data.source !== undefined && (
              <details className="json-details"><summary>View workflow source</summary><pre className="source-preview">{text(workflow.data.source)}</pre></details>
            )}
            <ActionButton
              path={`${path}/plan`}
              label="Preview execution plan"
              fields={runFields}
              transform={runBody}
              onDone={(result) =>
                navigate(repoLink(repo.id, `plans/${result.data.id}`))
              }
            />
          </div>
        </Panel>
      )}
      <Panel title="Run history">
        <ErrorNotice error={runs.error} retry={runs.refresh} />
        {runs.items.map((run) => (
          <RunRow key={run.id} run={run} repoId={repo.id} />
        ))}
        <Pagination {...runs} />
      </Panel>
      <Panel title="Approved versions">
        <ErrorNotice error={versions.error} retry={versions.refresh} />
        {versions.loading && !versions.data ? (
          <Loading />
        ) : (
          versions.items.map((version) => (
            <article className="panel-body" key={version.id}>
              <h3>
                {text(version.source_commit).slice(0, 12)}{" "}
                {version.id === workflow.data?.current_version_id && (
                  <Badge tone="green">Current</Badge>
                )}
              </h3>
              <Metadata
                values={{
                  definition_commit: version.source_commit,
                  definition_digest: version.definition_digest,
                  policy_revision: version.policy_revision,
                  approved_by: version.approved_by,
                  approved_at: version.created_at,
                }}
              />
              <JsonDetails title="Immutable workflow version" value={version} />
            </article>
          ))
        )}
        <Pagination {...versions} />
      </Panel>
    </>
  );
}

export function ValidateWorkflowPage() {
  const { repo } = useRepository();
  const [source, setSource] = useState("");
  const [result, setResult] = useState<{
    source: string;
    data: unknown;
  } | null>(null);
  const mutation = useMutation();
  return (
    <>
      <PageHeader
        title="Validate before you run"
        description="Check workflow types, dependencies, permissions, and output references without allocating an executor."
      />
      <Panel title="Workflow YAML">
        <form
          className="resource-form"
          onSubmit={(event) => {
            event.preventDefault();
            void mutation
              .run(endpoints.repo(repo.id, "workflows/validate"), {
                method: "POST",
                body: { source },
              })
              .then((value) => {
                if (value) setResult({ source, data: value.data });
              });
          }}
        >
          <SourceEditor
            value={source}
            onChange={setSource}
            label="Workflow YAML source"
            language="code"
          />
          <ErrorNotice error={mutation.error} />
          <div className="form-actions">
            <Button
              type="submit"
              variant="primary"
              busy={mutation.pending}
              disabled={!source.trim()}
            >
              Validate workflow
            </Button>
          </div>
        </form>
      </Panel>
      {result?.source === source && (
        <WorkflowPreviewDetails
          preview={record(result.data)}
          title="Validation result"
        />
      )}
    </>
  );
}

function WorkflowPreviewDetails({
  preview,
  title = "Preview and provenance",
}: {
  preview: Record<string, unknown>;
  title?: string;
}) {
  const { repo } = useRepository();
  const source = record(preview.source);
  const definition = record(preview.definition);
  const cost = record(preview.cost);
  const diagnostics = array<Entity>(preview.diagnostics);
  const jobs = array<Entity>(preview.jobs);
  return (
    <>
      <Panel
        title={title}
        actions={<Status value={text(preview.status, "unknown")} />}
      >
        <div className="panel-body">
          <Notice>
            Preview only. A run rechecks current permissions, source, capacity,
            and spending controls before admission.
          </Notice>
          <Metadata
            values={{
              source_commit: source.commit,
              source_ref: source.ref,
              source_verified: source.verified,
              definition: definition.origin,
              definition_commit: definition.source_commit,
              definition_digest: definition.digest,
              policy_revision: preview.policy_revision,
              payer: record(preview.payer).account_id,
              maximum_cost: text(cost.maximum_cost, "Unavailable"),
              currency: cost.currency,
              expires_at: preview.expires_at,
              manifest_digest: preview.manifest_digest,
            }}
          />
          {preview.kind === "validation" && (
            <Link to={repoLink(repo.id, `plans/${text(preview.id)}`)}>
              Open saved validation preview
            </Link>
          )}
        </div>
      </Panel>
      <Panel title="Compiler diagnostics">
        <div className="panel-body">
          {diagnostics.length ? (
            diagnostics.map((diagnostic, index) => (
              <article
                className="preview-job"
                key={`${text(diagnostic.path)}:${index}`}
              >
                <Status value={text(diagnostic.severity)} />
                <p>{text(diagnostic.message)}</p>
                <code>
                  {text(diagnostic.path)} · {text(diagnostic.code)}
                </code>
              </article>
            ))
          ) : (
            <p>No compiler diagnostics for this source and policy.</p>
          )}
        </div>
      </Panel>
      <Panel title="Jobs and requirements">
        <div className="panel-body">
          {jobs.length ? (
            jobs.map((job) => (
              <article className="preview-job" key={job.id}>
                <h3>{job.id}</h3>
                <Metadata
                  values={{
                    needs: array<string>(job.needs).join(", ") || "None",
                    executor: record(job.executor).type,
                    runner_pool: job.runner_pool_id,
                    toolchain: record(job.toolchain).name,
                    timeout_ms: job.timeout_ms,
                    possible_outcome: job.possible_outcome,
                    maximum_cost: text(
                      record(job.cost).maximum_cost,
                      "Unavailable",
                    ),
                    configuration: record(job.configuration).status,
                  }}
                />
                <JsonDetails title="Pinned job requirements" value={job} />
              </article>
            ))
          ) : (
            <p>
              The compiler has no resolved jobs for this preview. Review its
              diagnostics.
            </p>
          )}
          <JsonDetails title="Complete compiler preview" value={preview} />
        </div>
      </Panel>
    </>
  );
}

export function PlanPage() {
  const { repo } = useRepository();
  const { planId = "" } = useParams();
  const plan = useResource<Entity>(
    endpoints.repo(repo.id, `plans/${encodeURIComponent(planId)}`),
  );
  return (
    <>
      <PageHeader
        title="Execution plan"
        description="An expiring, read-only snapshot of pinned source, workflow, tools, permissions, outputs, and maximum cost."
      />
      <ErrorNotice error={plan.error} retry={plan.refresh} />
      {plan.loading && !plan.data ? (
        <Loading />
      ) : (
        plan.data && <WorkflowPreviewDetails preview={plan.data} />
      )}
    </>
  );
}

const terminalStates = new Set([
  "passed",
  "success",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "completed",
]);

export function RunPage() {
  const { repo } = useRepository();
  const { runId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const path = endpoints.repo(repo.id, `runs/${encodeURIComponent(runId)}`);
  const [poll, setPoll] = useState(3000);
  const run = useResource<Entity>(path, { poll });
  const attempts = useCollection<Entity>(`${path}/attempts`, { poll });
  const outputs = useCollection<Entity>(`${path}/outputs`, { poll });
  const jobs = useCollection<Entity>(`${path}/jobs`, { poll });
  const frozen = useResource<Entity>(
    run.data?.plan_digest ? `${path}/manifest` : null,
  );
  const approvals = useCollection<Entity>(`${path}/approvals`, { poll });
  const navigate = useNavigate();
  useEffect(() => {
    setPoll(run.data && terminalStates.has(text(run.data.state)) ? 0 : 3000);
  }, [run.data?.state]);
  const data = run.data;
  const attemptId = params.get("attempt") || attempts.items[0]?.id || "";
  return (
    <>
      <PageHeader
        eyebrow={<Link to={repoLink(repo.id, "workflows")}>Workflow runs</Link>}
        title={
          data
            ? text(data.title || data.workflow_name || data.name, runId)
            : "Workflow run"
        }
        description={runId}
        actions={
          data && (
            <>
              {!terminalStates.has(text(data.state)) && (
                <ActionButton
                  path={`${path}/cancel`}
                  resourcePath={path}
                  snapshot={run.snapshot}
                  label="Cancel run"
                  description="Cancellation revokes credentials and stops new jobs. The run stays cancelling until executor termination is confirmed."
                  danger
                  onDone={run.refresh}
                />
              )}
              <ActionButton
                path={`${path}/rerun`}
                snapshot={run.snapshot}
                label="Rerun"
                fields={[
                  {
                    name: "jobs",
                    label: "Job IDs (optional)",
                    type: "csv",
                    help: "Choose jobs to rerun with their affected dependents. Leave empty to use the backend's failed-job selection.",
                  },
                ]}
                onDone={(result) =>
                  navigate(
                    repoLink(
                      repo.id,
                      `runs/${text(result.data.run_id || result.data.id)}`,
                    ),
                  )
                }
              />
              <ReproduceRun
                key={runId}
                path={path}
                runId={runId}
                manifest={frozen.data}
              />
            </>
          )
        }
      />
      <ErrorNotice error={run.error} retry={run.refresh} />
      {run.loading && !data ? (
        <Loading />
      ) : (
        data && (
          <>
            <div className="run-overview">
              <div>
                <Status value={data.state} />
                <span>{text(data.queue_reason || data.failure_reason)}</span>
              </div>
              <Metadata
                values={{
                  commit: data.commit_oid,
                  ref: data.ref,
                  workflow_digest:
                    data.workflow_digest || data.definition_digest,
                  plan_digest: data.plan_digest,
                  policy_revision: data.policy_revision,
                  queue_position: data.queue_position,
                  payer: data.account_id,
                  maximum_cost: data.maximum_cost,
                  started_at: data.started_at,
                  completed_at: data.completed_at,
                }}
              />
            </div>
            <div className="run-layout">
              <aside className="job-list">
                <h2>Jobs & attempts</h2>
                <ErrorNotice error={attempts.error} retry={attempts.refresh} />
                {attempts.items.map((attempt) => (
                  <button
                    type="button"
                    className={attemptId === attempt.id ? "active" : ""}
                    key={attempt.id}
                    onClick={() => {
                      const next = new URLSearchParams(params);
                      next.set("attempt", attempt.id);
                      setParams(next);
                    }}
                  >
                    <Terminal size={16} />
                    <span>
                      <strong>
                        {text(attempt.job_name || attempt.job_id, attempt.id)}
                      </strong>
                      <small>
                        Attempt{" "}
                        {text(attempt.number || attempt.generation, "1")}
                      </small>
                    </span>
                    <Status value={attempt.state} />
                  </button>
                ))}
                {!attempts.items.length && (
                  <p className="muted">No attempts admitted yet.</p>
                )}
                <Pagination {...attempts} />
              </aside>
              <div className="run-main">
                {attemptId ? (
                  <AttemptPanel
                    path={path}
                    attempt={attempts.items.find(
                      (attempt) => attempt.id === attemptId,
                    )}
                    attemptId={attemptId}
                    live={poll > 0}
                  />
                ) : (
                  <Panel>
                    <Empty
                      title="Waiting for admission"
                      description={text(
                        data.queue_reason,
                        "The scheduler is checking dependencies, capabilities, and budget availability.",
                      )}
                    />
                  </Panel>
                )}
                <Panel
                  title="Outputs & provenance"
                  description="Immutable outputs belong to an exact source, plan, producer, and attempt."
                >
                  <ErrorNotice error={outputs.error} retry={outputs.refresh} />
                  {outputs.items.map((output) => (
                    <article className="output-row" key={output.id}>
                      <Box size={22} />
                      <div>
                        <strong>{displayName(output)}</strong>
                        <Metadata
                          values={{
                            digest: output.digest || output.sha256,
                            size_bytes: output.size_bytes,
                            attempt: output.attempt_id,
                            commit: output.commit_oid,
                            retention_until: output.expires_at,
                          }}
                        />
                      </div>
                      <div className="row-actions">
                        <DownloadButton
                          path={`${path}/outputs/${output.id}/download`}
                          name={displayName(output)}
                        />
                        <ActionButton
                          path={`${path}/promotions`}
                          label="Promote artifact"
                          description={`Request approval for this exact artifact: ${text(output.digest || output.source_digest)}.`}
                          body={{ artifact_id: output.id }}
                          fields={[
                            {
                              name: "environment_id",
                              label: "Destination environment ID",
                              required: true,
                            },
                          ]}
                          onDone={approvals.refresh}
                        />
                      </div>
                    </article>
                  ))}
                  {!outputs.items.length && !outputs.error && (
                    <div className="panel-body muted">
                      Outputs appear after an authorized attempt publishes them.
                    </div>
                  )}
                  <Pagination {...outputs} />
                </Panel>
                <ApprovalList
                  path={path}
                  approvals={approvals.items}
                  snapshot={run.snapshot}
                  refresh={approvals.refresh}
                  error={approvals.error}
                />
                <Panel title="Frozen manifest">
                  <div className="panel-body">
                    <ErrorNotice error={frozen.error} retry={frozen.refresh} />
                    {frozen.data ? (
                      <JsonDetails
                        title="Portable manifest and pinned requirements"
                        value={frozen.data}
                      />
                    ) : (
                      !frozen.error && (
                        <p>
                          The portable manifest becomes available after
                          compilation.
                        </p>
                      )
                    )}
                    <DownloadButton
                      path={`${path}/manifest`}
                      name={`${runId}-manifest.json`}
                    >
                      Download manifest
                    </DownloadButton>
                  </div>
                </Panel>
                <Panel
                  title="Every verification outcome"
                  description="Dependency-blocked and inapplicable requirements remain explicit."
                >
                  <ErrorNotice error={jobs.error} retry={jobs.refresh} />
                  {jobs.items.map((job) => (
                    <article
                      className="requirement-row panel-body"
                      key={job.id || text(job.job_key)}
                    >
                      <Status value={job.state || job.status} />
                      <div>
                        <strong>{text(job.job_key || job.name, job.id)}</strong>
                        <Metadata
                          values={{
                            reason: job.reason,
                            needs: record(job.definition).needs,
                            outcome: job.outcome,
                            attempt: job.current_attempt_id,
                          }}
                        />
                        <JsonDetails
                          title="Job requirement and inputs"
                          value={job}
                        />
                      </div>
                    </article>
                  ))}
                  <Pagination {...jobs} />
                </Panel>
              </div>
            </div>
          </>
        )
      )}
    </>
  );
}

function AttemptPanel({
  path,
  attempt,
  attemptId,
  live,
}: {
  path: string;
  attempt?: Entity;
  attemptId: string;
  live: boolean;
}) {
  return (
    <Panel
      title={
        <>
          <Terminal size={17} />
          {text(attempt?.job_name || attempt?.job_id, "Execution logs")}
        </>
      }
      actions={attempt && <Status value={attempt.state} />}
    >
      <div className="attempt-meta">
        <Metadata
          values={{
            executor: attempt?.executor,
            runner: attempt?.runner_id,
            pool: attempt?.runner_pool_id,
            image: attempt?.image_digest,
            toolchain: attempt?.toolchain_fingerprint,
            exit_code: attempt?.exit_code,
            signal: attempt?.signal,
            reason: attempt?.reason,
          }}
        />
      </div>
      <LiveLogs
        path={query(`${path}/logs`, { attempt_id: attemptId })}
        live={live && !terminalStates.has(text(attempt?.state))}
      />
      <div className="panel-body">
        <DownloadButton
          path={query(`${path}/logs/download`, { attempt_id: attemptId })}
          name={`${attemptId}.log`}
        >
          Download complete log
        </DownloadButton>
      </div>
    </Panel>
  );
}

// Poll durable numbered chunks instead of opening unauthenticated EventSource connections.
// Fetch includes cookies, supports abort, and never drops prior chunks after a reconnect.
function LiveLogs({ path, live }: { path: string; live: boolean }) {
  const [chunks, setChunks] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<Error | null>(null);
  const [following, setFollowing] = useState(true);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const output = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor: string | null = null;
    setChunks(new Map());
    setLoading(true);
    const load = async () => {
      try {
        const response = await fetch(apiUrl(query(path, { cursor })), {
          credentials: "include",
          signal: controller.signal,
          cache: "no-store",
          headers: new Headers([
            ...readHeaders(path),
            ["Accept", "application/json, text/plain"],
          ]),
        });
        if (!response.ok) {
          let body: unknown;
          try {
            body = await response.json();
          } catch {
            body = null;
          }
          throw new ApiError(response.status, body, response.headers);
        }
        if (response.headers.get("Content-Type")?.includes("json")) {
          const data = record(await response.json());
          const items = array<Entity>(data.items || data.chunks);
          if (!controller.signal.aborted)
            setChunks((previous) => {
              const next = new Map(previous);
              for (const item of items)
                next.set(
                  text(item.sequence ?? item.index ?? item.id),
                  text(item.content || item.text || item.data),
                );
              if (data.content) next.set("complete", text(data.content));
              return next;
            });
          cursor = text(data.next_cursor) || null;
        } else {
          const content = await response.text();
          if (!controller.signal.aborted)
            setChunks(new Map([["complete", content]]));
        }
        if (!controller.signal.aborted) setError(null);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(
            cause instanceof Error
              ? cause
              : new Error("Log connection failed."),
          );
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          if (cursor || live) timer = setTimeout(load, cursor ? 0 : 2000);
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [path, live, retry]);
  useEffect(() => {
    if (following && output.current)
      output.current.scrollTop = output.current.scrollHeight;
  }, [chunks, following]);
  const content = [...chunks.entries()]
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
    .map(([, chunk]) => chunk)
    .join("");
  return (
    <>
      <div className="log-toolbar">
        <span>
          <span className={`status-dot ${live ? "live" : ""}`} />
          {live ? "Live output" : "Retained output"}
        </span>
        <label>
          <input
            type="checkbox"
            checked={following}
            onChange={(event) => setFollowing(event.target.checked)}
          />
          Follow output
        </label>
        <span aria-live="polite">
          {loading
            ? "Connecting…"
            : error
              ? "Disconnected — retrying"
              : live
                ? "Connected"
                : "Complete"}
        </span>
      </div>
      <ErrorNotice error={error} retry={() => setRetry((value) => value + 1)} />
      <pre
        className="log-output"
        ref={output}
        tabIndex={0}
        aria-label="Execution output"
      >
        {content ||
          (loading
            ? "Connecting to durable log storage…"
            : "No log output has been published yet.")}
      </pre>
    </>
  );
}

function ApprovalList({
  path,
  approvals,
  snapshot,
  refresh,
  error,
}: {
  path: string;
  approvals: Entity[];
  snapshot: Snapshot<Entity> | null;
  refresh: () => void;
  error: Error | null;
}) {
  return (
    <Panel
      title="Environment approvals"
      description="An approval authorizes one exact artifact, commit, plan, and destination."
    >
      <ErrorNotice error={error} retry={refresh} />
      {approvals.map((approval) => (
        <article className="approval-row" key={approval.id}>
          <div>
            <h3>
              {text(
                approval.environment_name || approval.destination,
                approval.id,
              )}
            </h3>
            <Status value={approval.state} />
            <Metadata
              values={{
                commit: approval.commit_oid,
                artifact_digest: approval.artifact_digest,
                plan_digest: approval.plan_digest,
                destination: approval.destination,
                expires_at: approval.expires_at,
              }}
            />
          </div>
          {["pending", "waiting", "waiting_approval"].includes(
            text(approval.state),
          ) && (
            <div className="row-actions">
              <ActionButton
                path={`${path}/approvals`}
                snapshot={revisionSnapshot(approval)}
                label="Approve exact artifact"
                description={`Approve ${text(approval.artifact_digest)} for ${text(approval.destination)} at commit ${text(approval.commit_oid)}.`}
                body={{
                  promotion_id: approval.id,
                  decision: "approved",
                }}
                onDone={refresh}
              />
              <ActionButton
                path={`${path}/approvals`}
                snapshot={revisionSnapshot(approval)}
                label="Reject"
                danger
                body={{ promotion_id: approval.id, decision: "rejected" }}
                onDone={refresh}
              />
            </div>
          )}
          {approval.state === "approved" && (
            <ActionButton
              path={`${path}/promotions/${approval.id}/promote`}
              snapshot={revisionSnapshot(approval)}
              label="Publish approved artifact"
              description={`Publish the approved artifact ${text(approval.artifact_digest)} to ${text(approval.destination)}.`}
              onDone={refresh}
            />
          )}
        </article>
      ))}
      {!approvals.length && !error && (
        <div className="panel-body muted">
          No environment approvals requested.
        </div>
      )}
    </Panel>
  );
}

export function EnvironmentsPage() {
  const { repo } = useRepository();
  const { session } = useAuth();
  return (
    <>
      <PageHeader
        title="Environments"
        description="Protect destinations with exact-artifact approvals and scoped configuration."
      />
      <ResourceCollection
        path={endpoints.repo(repo.id, "environments")}
        spec={{
          title: "Environments",
          singular: "environment",
          fields: [
            nameField,
            { name: "destination", label: "Destination", required: true },
            {
              name: "target_ref",
              label: "Accepted target ref",
              required: true,
              default: `refs/heads/${repo.default_branch.replace(/^refs\/heads\//, "")}`,
            },
            {
              name: "allowed_approvers",
              label: "Required approver IDs",
              type: "csv",
            },
            {
              name: "allow_self_approval",
              label: "Allow self approval",
              type: "checkbox",
              default: false,
            },
            {
              name: "required_approvals",
              label: "Required approvals",
              type: "number",
              default: 1,
              min: 0,
              max: 10,
            },
          ],
          columns: ["name", "destination", "updated_at"],
          allowDelete: !!session,
          rowPath: (environment) =>
            repoLink(repo.id, `environments/${environment.id}`),
        }}
      />
    </>
  );
}
