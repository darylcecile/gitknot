import { useState } from "react";
import { record, text, type Entity } from "../../api/types.ts";
import { Button, ErrorNotice } from "../ui.tsx";
import { EditorSection, SelectControl, TextControl } from "./controls.tsx";

export type IsolationFile = { name: string; type: "oci" | "posix_user" | "windows_user"; image?: string };

export function isolationConfiguration(toolchain: Record<string, unknown>, values: Record<string, unknown>) {
  if (toolchain.image) {
    if (!/^(?:sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})$/.test(text(toolchain.image))) throw new Error("This job does not have a pinned container image.");
    if (toolchain.os !== "linux") throw new Error("Container reproduction requires the recorded Linux image.");
    return { type: "oci" as const, image: text(toolchain.image), engine: text(values.engine, "docker"), network: text(values.network, "none"),
      cpus: boundedNumber(values.cpus ?? 2, 0.1, 64, "CPU limit"), memory_mb: boundedNumber(values.memory_mb ?? 2048, 128, 262144, "Memory", true),
      pids: boundedNumber(values.pids ?? 256, 16, 4096, "Process limit", true) };
  }
  if (toolchain.os === "win32") {
    if (!text(values.credential_file).trim()) throw new Error("Enter the path to the Windows credential file.");
    return { type: "windows_user" as const, credential_file: text(values.credential_file).trim() };
  }
  if (!["linux", "darwin"].includes(text(toolchain.os))) throw new Error("This job does not specify a supported native platform.");
  return { type: "posix_user" as const, uid: boundedNumber(values.uid, 1000, 2147483647, "User ID", true), gid: boundedNumber(values.gid, 1000, 2147483647, "Group ID", true) };
}

function boundedNumber(value: unknown, min: number, max: number, label: string, integer = false) {
  const number = Number(value);
  if (value === "" || value === undefined || !Number.isFinite(number) || number < min || number > max || integer && !Number.isInteger(number))
    throw new Error(`${label} must be ${integer ? "a whole number" : "a number"} between ${min} and ${max}.`);
  return number;
}

export function IsolationEditor({ job, onPrepared }: { job: Entity; onPrepared: (file: IsolationFile | null) => void }) {
  const tools = record(job.toolchain);
  const [values, setValues] = useState<Record<string, unknown>>({ engine: "docker", network: "none", cpus: 2, memory_mb: 2048, pids: 256 });
  const [error, setError] = useState<Error | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const update = (key: string, value: unknown) => { setValues(current => ({ ...current, [key]: value })); setDownloaded(false); onPrepared(null); };
  return <form className="editor-stack isolation-builder" onSubmit={event => {
    event.preventDefault();
    try {
      const config = isolationConfiguration(tools, values);
      const name = "gitknot-isolation.json";
      const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2) + "\n"], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onPrepared({ name, type: config.type, ...(config.type === "oci" ? { image: config.image } : {}) });
      setDownloaded(true);
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause : new Error("Could not prepare the configuration.")); }
  }}>
    {tools.image ? <>
      <SelectControl label="Container engine" value={values.engine} onChange={next => update("engine", next)} options={[{ value: "docker", label: "Docker" }, { value: "podman", label: "Podman" }]} />
      <p className="field-help">Uses this job’s exact container image and a private workspace.</p>
      <EditorSection title="Container options">
        <SelectControl label="Network access" value={values.network} onChange={next => update("network", next)} options={[{ value: "none", label: "No network" }, { value: "bridge", label: "Bridge network" }]} />
        <div className="choice-grid"><TextControl label="CPU limit" type="number" min={0.1} max={64} step={0.1} value={values.cpus} onChange={next => update("cpus", next)} required />
          <TextControl label="Memory (MB)" type="number" min={128} max={262144} value={values.memory_mb} onChange={next => update("memory_mb", next)} required /></div>
        <TextControl label="Process limit" type="number" min={16} max={4096} value={values.pids} onChange={next => update("pids", next)} required />
      </EditorSection>
    </> : tools.os === "win32" ? <TextControl label="Windows credential file" value={values.credential_file} onChange={next => update("credential_file", next)} required
      help="Path on the machine running the CLI. The credential stays on that machine." /> : <>
      <p className="field-help">Use a dedicated local user for the recorded native toolchain.</p>
      <div className="choice-grid"><TextControl label="User ID" type="number" min={1000} max={2147483647} value={values.uid} onChange={next => update("uid", next)} required />
        <TextControl label="Group ID" type="number" min={1000} max={2147483647} value={values.gid} onChange={next => update("gid", next)} required /></div>
    </>}
    <ErrorNotice error={error} />
    <div className="row-actions"><Button type="submit">Download configuration</Button>{downloaded && <span className="field-help" role="status">Configuration prepared</span>}</div>
  </form>;
}
