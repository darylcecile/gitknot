import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { endpoints } from "../api/endpoints.ts";
import { useCollection, useResource } from "../api/hooks.ts";
import { record, text, type Entity } from "../api/types.ts";
import { ActionButton, CreateResource } from "../components/forms.tsx";
import {
  DownloadButton,
  ErrorNotice,
  JsonDetails,
  Loading,
  Metadata,
  Notice,
  PageHeader,
  Pagination,
  Panel,
  Status,
  Time,
} from "../components/ui.tsx";

const activeStates = new Set(["queued", "capturing", "verifying", "deleting"]);
const exportLink = (accountId: string, exportId: string) =>
  `/accounts/${encodeURIComponent(accountId)}/exports/${encodeURIComponent(exportId)}`;

function ExportDownload({ value }: { value: Entity }) {
  if (
    value.state !== "completed" ||
    record(value.coverage).complete !== true ||
    typeof value.download_path !== "string"
  )
    return null;
  return (
    <DownloadButton path={value.download_path} name={`${value.id}.gitknot.tar`}>
      Download complete account archive
    </DownloadButton>
  );
}

export function AccountExportsPanel({ accountId }: { accountId: string }) {
  const path = endpoints.account(accountId, "exports");
  const navigate = useNavigate();
  const [poll, setPoll] = useState(0);
  const exports = useCollection<Entity>(path, { poll });
  const active = exports.items.some((value) =>
    activeStates.has(text(value.state)),
  );
  useEffect(() => setPoll(active ? 3000 : 0), [active]);
  return (
    <Panel
      title="Complete account exports"
      description="Account metadata and every authorized repository, with explicit coverage and verified archive checksums."
      actions={
        <CreateResource
          path={path}
          title="Create account export"
          fields={[]}
          onSaved={(result) => navigate(exportLink(accountId, result.data.id))}
        />
      }
    >
      <ErrorNotice error={exports.error} retry={exports.refresh} />
      {exports.loading && !exports.data ? (
        <Loading />
      ) : (
        exports.items.map((value) => (
          <article className="panel-body" key={value.id}>
            <h3>
              <Link to={exportLink(accountId, value.id)}>
                Account export <Time value={value.created_at} />
              </Link>
            </h3>
            <Status value={value.state} />
            <Metadata
              values={{
                coverage: value.coverage,
                expires_at: value.expires_at,
                size_bytes: value.size_bytes,
              }}
            />
            <ExportDownload value={value} />
          </article>
        ))
      )}
      {!exports.loading && !exports.error && !exports.items.length && (
        <p className="panel-body">No account exports have been requested.</p>
      )}
      <Pagination {...exports} />
    </Panel>
  );
}

export function AccountExportPage() {
  const { accountId = "", exportId = "" } = useParams();
  const path = endpoints.account(
    accountId,
    `exports/${encodeURIComponent(exportId)}`,
  );
  const [poll, setPoll] = useState(3000);
  const exported = useResource<Entity>(path, { poll });
  useEffect(() => {
    if (exported.data)
      setPoll(activeStates.has(text(exported.data.state)) ? 3000 : 0);
  }, [exported.data?.state]);
  const data = exported.data;
  const operation = record(data?.operation);
  return (
    <>
      <PageHeader
        eyebrow={
          <Link to={`/accounts/${encodeURIComponent(accountId)}/exports`}>
            Account exports
          </Link>
        }
        title="Complete account export"
        description={exportId}
        actions={
          data &&
          !["deleted", "deleting", "expired"].includes(text(data.state)) && (
            <ActionButton
              path={path}
              resourcePath={path}
              snapshot={exported.snapshot}
              label="Delete export"
              method="DELETE"
              danger
              confirmText={exportId}
              description="Remove this retained account archive through verified storage cleanup."
              onDone={exported.refresh}
            />
          )
        }
      />
      <ErrorNotice error={exported.error} retry={exported.refresh} />
      {exported.loading && !data ? (
        <Loading />
      ) : (
        data && (
          <Panel
            title="Capture and verification"
            actions={<Status value={data.state} />}
          >
            <div className="panel-body">
              <Metadata
                values={{
                  account: data.account_id,
                  schema_version: data.schema_version,
                  created_at: data.created_at,
                  expires_at: data.expires_at,
                  size_bytes: data.size_bytes,
                  checksum_sha256: data.checksum_sha256,
                  operation_phase: operation.phase,
                }}
              />
              <h3>Coverage</h3>
              <Metadata values={record(data.coverage)} />
              {record(data.coverage).complete !== true && (
                <Notice>
                  The export is not yet verified complete. Follow its operation
                  for capture progress or a reported failure.
                </Notice>
              )}
              {data.state === "failed" && (
                <Notice tone="warning">
                  {text(
                    record(data.error).message,
                    "The export did not complete. Inspect its durable operation before retrying.",
                  )}{" "}
                  <code>{text(record(data.error).code)}</code>
                </Notice>
              )}
              <div className="row-actions">
                {typeof operation.id === "string" && (
                  <Link
                    className="button button-secondary"
                    to={`/operations/${encodeURIComponent(operation.id)}`}
                  >
                    View durable operation
                  </Link>
                )}
                <ExportDownload value={data} />
              </div>
              <p>
                Account and repository snapshots are individually coherent. The
                manifest records their capture times, included repositories,
                checksums, and excluded protected authentication and secret
                material.
              </p>
              <JsonDetails
                title="Export metadata and operation receipt"
                value={data}
              />
            </div>
          </Panel>
        )
      )}
    </>
  );
}
