import { useId, useRef, useState } from "react";
import { Link } from "react-router";
import { apiOrigin } from "../api/client.ts";
import { query } from "../api/endpoints.ts";
import { useResource } from "../api/hooks.ts";
import { array, record, text, type Entity } from "../api/types.ts";
import { Fields, type Field } from "../components/forms.tsx";
import { IsolationEditor, type IsolationFile } from "../components/editors/isolation-editor.tsx";
import {
  Button,
  CopyButton,
  DownloadButton,
  ErrorNotice,
  JsonDetails,
  Loading,
  Metadata,
  Modal,
  Notice,
  Panel,
} from "../components/ui.tsx";

type ReproductionChoice = {
  job: string;
  isolation_path: string;
  source_path: string;
  shell: string;
  disposable: boolean;
};

async function inspectIsolation(file: File): Promise<IsolationFile> {
  if (file.size > 65_536)
    throw new Error("Choose an isolation configuration no larger than 64 KiB.");
  let value: Record<string, unknown>;
  try {
    value = record(JSON.parse(await file.text()));
  } catch {
    throw new Error("Choose a valid isolation configuration JSON file.");
  }
  if (value.type === "oci") {
    const image = text(value.image);
    if (!/^(?:sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/.test(image))
      throw new Error("OCI isolation requires an immutable image digest.");
    if (
      value.engine !== undefined &&
      value.engine !== "docker" &&
      value.engine !== "podman"
    )
      throw new Error("OCI isolation supports Docker or Podman.");
    return { name: file.name, type: "oci", image };
  }
  if (value.type === "posix_user") {
    if (
      ![value.uid, value.gid].every(
        (id) =>
          typeof id === "number" &&
          Number.isInteger(id) &&
          id >= 1000 &&
          id <= 2_147_483_647,
      )
    )
      throw new Error(
        "POSIX isolation requires a dedicated UID and GID of at least 1000.",
      );
    return { name: file.name, type: "posix_user" };
  }
  if (value.type === "windows_user" && text(value.credential_file).trim())
    return { name: file.name, type: "windows_user" };
  throw new Error(
    "Choose an isolation configuration with type oci, posix_user, or windows_user, rather than a credential file.",
  );
}

function isolationMismatch(
  file: IsolationFile | null,
  job: Entity | undefined,
): string | null {
  if (!file || !job) return null;
  const tools = record(job.toolchain);
  if (file.type === "oci") {
    if (tools.os !== "linux" || !tools.image)
      return "This job requires its recorded native toolchain. Choose matching native isolation rather than an OCI image.";
    if (file.image !== tools.image)
      return "Choose an OCI configuration with the exact image identity recorded in this job.";
  } else {
    if (tools.image)
      return "This job pins an OCI image. Choose an OCI configuration for that exact image.";
    if (file.type === "windows_user" && tools.os !== "win32")
      return "Windows-user isolation does not match the recorded job platform.";
    if (
      file.type === "posix_user" &&
      !["linux", "darwin"].includes(text(tools.os))
    )
      return "POSIX-user isolation does not match the recorded job platform.";
  }
  return null;
}

function commandFor(runId: string, choice: ReproductionChoice): string {
  const quote = (value: string) =>
    choice.shell === "powershell"
      ? `'${value.replaceAll("'", "''")}'`
      : `'${value.replaceAll("'", "'\\''")}'`;
  const origin = apiOrigin() || window.location.origin;
  const args = [
    "gitknot workflow reproduce",
    quote(runId),
    "--job",
    quote(choice.job),
    "--isolation",
    quote(choice.isolation_path.trim()),
    "--api-url",
    quote(origin),
  ];
  if (choice.source_path.trim())
    args.push("--source", quote(choice.source_path.trim()));
  if (new URL(origin).protocol === "http:") args.push("--allow-loopback-http");
  if (choice.disposable) args.push("--disposable");
  return args.join(" ");
}

export function ReproduceRun({
  path,
  runId,
  manifest,
}: {
  path: string;
  runId: string;
  manifest: Entity | null;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<ReproductionChoice>({
    job: "",
    isolation_path: "",
    source_path: "",
    shell: "posix",
    disposable: false,
  });
  const [requestedJob, setRequestedJob] = useState("");
  const [isolation, setIsolation] = useState<IsolationFile | null>(null);
  const [isolationMode, setIsolationMode] = useState("create");
  const [fileError, setFileError] = useState<Error | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const generation = useRef(0);
  const fileId = useId();
  const changeIsolationMode = (mode: string) => {
    generation.current++;
    setIsolationMode(mode);
    setIsolation(null);
    setInspecting(false);
    setFileError(null);
  };
  const jobs = array<Entity>(manifest?.jobs);
  const job = jobs.find((job) => job.id === choice.job);
  const context = useResource<Entity>(
    open && requestedJob
      ? query(`${path}/reproduce`, { job: requestedJob })
      : null,
  );
  const responseJob = array<Entity>(record(context.data?.manifest).jobs).find(
    (job) => job.id === requestedJob,
  );
  const source = record(context.data?.source);
  const matched =
    !!context.data &&
    context.data.run_id === runId &&
    responseJob?.id === choice.job &&
    typeof source.commit === "string" &&
    source.commit === record(manifest?.source).commit &&
    record(context.data.manifest).digest === manifest?.digest;
  const mismatch = isolationMismatch(isolation, responseJob || job);
  const needsDisposable =
    record(record(context.data?.manifest || manifest).trust).level ===
    "untrusted";
  const safePath = (value: string) =>
    !!value.trim() &&
    !value.trim().startsWith("~") &&
    !/[\x00-\x1f\x7f]/.test(value);
  const selectedFilename = choice.isolation_path
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .at(-1);
  const ready =
    matched &&
    !context.loading &&
    !context.error &&
    isolation &&
    selectedFilename === isolation.name &&
    !mismatch &&
    safePath(choice.isolation_path) &&
    (!choice.source_path || safePath(choice.source_path)) &&
    ["posix", "powershell"].includes(choice.shell) &&
    (!needsDisposable || choice.disposable);
  const fields: Field[] = [
    {
      name: "job",
      label: "Job",
      type: "select",
      required: true,
      options: jobs.map((job) => ({ value: job.id, label: job.id })),
    },
    {
      name: "isolation_path",
      label: "Configuration path",
      required: true,
      help: "Save or move the configuration to this path on the CLI machine. Use an absolute path or a path relative to the directory where you will run the command.",
    },
    {
      name: "source_path",
      label: "Local checkout path (optional)",
      help: "Use an existing checkout containing the pinned commit, or leave empty to fetch the authorized source through GitKnot.",
      section: "Local checkout options",
    },
    {
      name: "shell",
      label: "Command shell",
      type: "select",
      required: true,
      options: [
        { value: "posix", label: "POSIX shell — macOS / Linux" },
        { value: "powershell", label: "PowerShell — Windows / cross-platform" },
      ],
    },
    ...(needsDisposable
      ? [
          {
            name: "disposable",
            label: "I will use a designated disposable machine or VM",
            type: "checkbox" as const,
            help: "The recorded source is untrusted; the CLI requires explicit disposable execution.",
          },
        ]
      : []),
  ];
  return (
    <>
      <Button
        onClick={() => {
          setOpen(true);
          const selected = choice.job || jobs[0]?.id || "";
          setChoice(current => ({ ...current, job: selected }));
          setRequestedJob(selected);
        }}
        disabled={!manifest || !jobs.length}
      >
        Reproduce locally
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Reproduce this run"
        wide
      >
        <div className="modal-body">
          <p>
            Choose a job, prepare its run environment, and copy the command to your terminal.
          </p>
          <Fields
            fields={fields.filter(field => field.name === "job")}
            values={choice}
            setValues={(values) => {
              const next = values as ReproductionChoice;
              if (next.job !== choice.job) { setRequestedJob(next.job); changeIsolationMode(isolationMode); }
              setChoice(next);
            }}
          />
          {job && <section className="reproduction-setup">
            <h3>Run environment</h3>
            <div className="segmented" role="group" aria-label="Environment configuration">
              <button type="button" aria-pressed={isolationMode === "create"} onClick={() => changeIsolationMode("create")}>Create configuration</button>
              <button type="button" aria-pressed={isolationMode === "existing"} onClick={() => changeIsolationMode("existing")}>Use existing file</button>
            </div>
            {isolationMode === "create" ? <IsolationEditor key={job.id} job={responseJob || job} onPrepared={file => {
              setIsolation(file); setFileError(null);
              if (file) setChoice(current => ({ ...current, isolation_path: current.isolation_path ? current.isolation_path.replace(/[^/\\]+$/, file.name) : `./${file.name}` }));
            }} /> : <div className="field">
            <label htmlFor={fileId}>Configuration file</label>
            <input
              id={fileId}
              type="file"
              accept=".json,application/json"
              aria-describedby={`${fileId}-help`}
              onChange={(event) => {
                const file = event.target.files?.[0];
                const current = ++generation.current;
                setIsolation(null);
                setFileError(null);
                if (!file) {
                  setInspecting(false);
                  return;
                }
                setInspecting(true);
                void inspectIsolation(file)
                  .then((value) => {
                    if (generation.current === current) setIsolation(value);
                  })
                  .catch((cause) => {
                    if (generation.current === current)
                      setFileError(
                        cause instanceof Error
                          ? cause
                          : new Error(
                              "Unable to inspect the isolation configuration.",
                            ),
                      );
                  })
                  .finally(() => {
                    if (generation.current === current) setInspecting(false);
                  });
              }}
            />
            <p id={`${fileId}-help`} className="field-help">
              The file is inspected locally for its backend and image identity.
              The CLI validates the complete configuration and host boundary.{" "}
              <Link
                to="/docs/workflows"
                target="_blank"
                rel="noopener noreferrer"
              >
                Supported isolation configurations
              </Link>
              .
            </p>
          </div>}
          </section>}
          {inspecting && (
            <Loading label="Inspecting isolation configuration" rows={1} />
          )}
          {isolation && (
            <p className="isolation-selection">
              Selected configuration: <strong>{isolation.name}</strong> ·{" "}
              <code>{isolation.type}</code>
            </p>
          )}
          <ErrorNotice error={fileError} />
          {mismatch && <Notice tone="warning">{mismatch}</Notice>}
          {isolation && <Fields fields={fields.filter(field => field.name !== "job")} values={choice} setValues={values => setChoice(values as ReproductionChoice)} />}
          {context.loading && <Loading label="Loading reproduction context…" rows={1} />}
          <ErrorNotice error={context.error} retry={context.refresh} />
          {context.data && !matched && (
            <Notice tone="warning">
              The response did not match this run, selected job, and pinned
              source. Load the context again.
            </Notice>
          )}
          {matched && !context.error && (
            <details className="detail-disclosure"><summary>Recorded inputs and provenance</summary><ReproductionEvidence job={responseJob!} data={context.data!} /></details>
          )}
          {ready ? (
            <div className="reproduction-command">
              <pre
                className="source-preview"
                tabIndex={0}
                role="region"
                aria-label="Reproduce command"
              >
                {commandFor(runId, choice)}
              </pre>
              <CopyButton
                value={commandFor(runId, choice)}
                label="Copy reproduce command"
              />
            </div>
          ) : (
            <p className="field-help">
              Prepare the run environment and choose where you will save its configuration to generate the command.
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}

function ReproductionEvidence({ job, data }: { job: Entity; data: Entity }) {
  const source = record(data.source);
  const variables = record(data.variables);
  const inputs = array<Entity>(data.inputs);
  return (
    <section
      className="reproduction-evidence"
      aria-label={`Reproduction context for ${job.id}`}
    >
      <h3>Selected job: {job.id}</h3>
      <Metadata
        values={{
          source_commit: source.commit,
          source_url: source.url,
          plan_digest: data.plan_digest,
          toolchain: record(job.toolchain).name,
          needs: job.needs,
          completed_dependencies: data.completed_dependencies,
          required_secrets: data.required_secrets,
        }}
      />
      <Panel title="Recorded variables">
        <div className="panel-body">
          {Object.keys(variables).length ? (
            <Metadata values={variables} />
          ) : (
            <p>This job has no recorded variables.</p>
          )}
        </div>
      </Panel>
      <Panel title="Selected dependency inputs">
        <div className="panel-body">
          {inputs.length ? (
            inputs.map((input) => (
              <article
                className="output-row"
                key={`${text(input.job_id)}:${text(input.name)}`}
              >
                <div>
                  <strong>
                    {text(input.job_id)} / {text(input.name)}
                  </strong>
                  <Metadata
                    values={{
                      type: input.type,
                      digest: input.digest,
                      size_bytes: input.size_bytes,
                    }}
                  />
                </div>
                <DownloadButton
                  path={text(input.download_path)}
                  name={`${text(input.job_id)}-${text(input.name)}`}
                />
              </article>
            ))
          ) : (
            <p>This job has no retained dependency inputs.</p>
          )}
        </div>
      </Panel>
      {!!array(data.required_secrets).length && (
        <Notice>
          Supply the required secret names explicitly to the CLI. Existing
          values are not included in the reproduction response.
        </Notice>
      )}
      <JsonDetails title="Selected job requirements" value={job} />
    </section>
  );
}
