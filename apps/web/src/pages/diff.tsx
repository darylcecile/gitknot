import { useState } from "react";
import { useSearchParams } from "react-router";
import { FileDiff, MessageSquarePlus } from "lucide-react";
import { endpoints, query } from "../api/endpoints.ts";
import { useResource } from "../api/hooks.ts";
import { array, text, type Entity } from "../api/types.ts";
import { ResourceForm } from "../components/forms.tsx";
import {
  Badge,
  Button,
  Empty,
  ErrorNotice,
  JsonDetails,
  Loading,
  Modal,
  Notice,
  PageHeader,
  Panel,
} from "../components/ui.tsx";
import { useRepository } from "./repositories.tsx";

type DiffLine = {
  text: string;
  kind: "add" | "delete" | "context" | "hunk";
  oldLine: number | null;
  newLine: number | null;
};
type DiffFile = {
  path: string;
  oldPath?: string;
  lines: DiffLine[];
  binary: boolean;
};

function repositoryDiffPath(...values: unknown[]): string {
  return text(
    values.find(
      (value) =>
        typeof value === "string" && value.length > 0 && value !== "/dev/null",
    ),
  );
}

export function parseUnifiedDiff(source: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of source.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      const match = /^diff --git a\/(.*?) b\/(.*)$/.exec(line);
      current = {
        path: match?.[2] || line.slice(11),
        oldPath: match?.[1],
        lines: [],
        binary: false,
      };
      files.push(current);
      continue;
    }
    if (!current) {
      current = { path: "Changes", lines: [], binary: false };
      files.push(current);
    }
    if (!inHunk && line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "");
      current.path = repositoryDiffPath(path, current.oldPath, current.path);
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      current.oldPath =
        repositoryDiffPath(line.slice(4).replace(/^a\//, "")) || undefined;
      continue;
    }
    if (/^(Binary files|GIT binary patch)/.test(line)) current.binary = true;
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      current.lines.push({
        text: line,
        kind: "hunk",
        oldLine: null,
        newLine: null,
      });
      continue;
    }
    if (line.startsWith("+"))
      current.lines.push({
        text: line.slice(1),
        kind: "add",
        oldLine: null,
        newLine: newLine++,
      });
    else if (line.startsWith("-"))
      current.lines.push({
        text: line.slice(1),
        kind: "delete",
        oldLine: oldLine++,
        newLine: null,
      });
    else if (line.startsWith(" "))
      current.lines.push({
        text: line.slice(1),
        kind: "context",
        oldLine: oldLine++,
        newLine: newLine++,
      });
    else if (line)
      current.lines.push({
        text: line,
        kind: "hunk",
        oldLine: null,
        newLine: null,
      });
  }
  return files.filter((file) => file.lines.length > 0 || file.binary);
}

export function DiffViewer({
  data,
  review,
}: {
  data: Entity;
  review?: {
    path: string;
    patchId: string;
    headOid: string;
    oldPatchId?: string;
    refresh: () => void;
  };
}) {
  const [anchor, setAnchor] = useState<{
    path: string;
    line: number;
    side: "old" | "new";
  } | null>(null);
  const source = text(data.diff || data.patch || data.unified_diff);
  const resources = array<Entity>(data.files);
  const files: DiffFile[] = resources.length
    ? resources.flatMap((file) => {
        const parsed = parseUnifiedDiff(text(file.patch || file.diff));
        return parsed.length
          ? parsed.map((item) => ({
              ...item,
              path: repositoryDiffPath(
                file.path,
                file.new_path,
                file.old_path,
                item.path,
              ),
            }))
          : [
              {
                path: repositoryDiffPath(
                  file.path,
                  file.new_path,
                  file.old_path,
                ),
                oldPath: repositoryDiffPath(file.old_path) || undefined,
                lines: [],
                binary: file.binary === true,
              },
            ];
      })
    : parseUnifiedDiff(source);
  return (
    <>
      <div className="diff-summary">
        <FileDiff size={17} />
        <strong>
          {files.length} changed {files.length === 1 ? "file" : "files"}
        </strong>
        {data.base_oid !== undefined && (
          <code>
            {text(data.base_oid).slice(0, 12)} →{" "}
            {text(data.head_oid).slice(0, 12)}
          </code>
        )}
      </div>
      {data.truncated === true && (
        <Notice tone="warning">
          This response is truncated. Review the full authorized patch before
          approving.
        </Notice>
      )}
      {!files.length && (
        <Panel>
          <Empty title="No changes in this comparison" />
        </Panel>
      )}
      {files.map((file, index) => (
        <details className="diff-file" open key={`${file.path}-${index}`}>
          <summary>
            <FileDiff size={15} />
            <strong>{file.path}</strong>
            {file.oldPath && file.oldPath !== file.path && (
              <span className="muted">from {file.oldPath}</span>
            )}
            <span className="diff-additions">
              +{file.lines.filter((line) => line.kind === "add").length}
            </span>
            <span className="diff-deletions">
              −{file.lines.filter((line) => line.kind === "delete").length}
            </span>
          </summary>
          {file.binary ? (
            <div className="panel-body muted">
              Binary file changed. Use the authorized file browser to inspect
              each revision.
            </div>
          ) : (
            <div
              className="diff-scroll"
              tabIndex={0}
              aria-label={`Diff for ${file.path}`}
            >
              <table className="diff-table">
                <thead className="sr-only">
                  <tr>
                    <th scope="col">Previous line</th>
                    <th scope="col">Current line</th>
                    {review && <th scope="col">Review</th>}
                    <th scope="col">Change</th>
                    <th scope="col">Code</th>
                  </tr>
                </thead>
                <tbody>
                  {file.lines.map((line, lineIndex) => (
                    <tr key={lineIndex} className={`diff-${line.kind}`}>
                      <td className="line-number">{line.oldLine}</td>
                      <td className="line-number">{line.newLine}</td>
                      {review && (
                        <td className="diff-comment-cell">
                          {line.kind !== "hunk" && (
                            <button
                              type="button"
                              aria-label={`Comment on ${file.path} line ${line.newLine ?? line.oldLine}`}
                              onClick={() =>
                                setAnchor({
                                  path: file.path,
                                  line: line.newLine ?? line.oldLine ?? 1,
                                  side: line.kind === "delete" ? "old" : "new",
                                })
                              }
                            >
                              <MessageSquarePlus size={13} />
                            </button>
                          )}
                        </td>
                      )}
                      <td className="diff-sign" aria-hidden="true">
                        {line.kind === "add"
                          ? "+"
                          : line.kind === "delete"
                            ? "−"
                            : ""}
                      </td>
                      <td className="diff-code">
                        <code>{line.text || " "}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </details>
      ))}
      {review && (
        <Modal
          open={!!anchor}
          onClose={() => setAnchor(null)}
          title="Comment on this revision"
          description={
            anchor
              ? `${anchor.path}:${anchor.line} · ${anchor.side} side`
              : undefined
          }
          wide
        >
          <ResourceForm
            path={`${review.path}/threads`}
            fields={[
              {
                name: "body",
                label: "Comment",
                type: "markdown",
                required: true,
              },
            ]}
            draftKey={`${review.path}:anchor:${anchor?.path}:${anchor?.line}`}
            revisionPath={review.path}
            transform={(body) => ({
              ...body,
              patch_id:
                anchor?.side === "old" && review.oldPatchId
                  ? review.oldPatchId
                  : review.patchId,
              path: anchor?.path,
              side:
                anchor?.side === "old" && review.oldPatchId
                  ? "new"
                  : anchor?.side,
              start_line: anchor?.line,
              end_line: anchor?.line,
            })}
            submitLabel="Start review thread"
            onCancel={() => setAnchor(null)}
            onSaved={() => {
              setAnchor(null);
              review.refresh();
            }}
          />
        </Modal>
      )}
    </>
  );
}

export function ComparePage() {
  const { repo } = useRepository();
  const [params, setParams] = useSearchParams();
  const [base, setBase] = useState(params.get("base") || repo.default_branch);
  const [head, setHead] = useState(params.get("head") || "");
  const diff = useResource<Entity>(
    params.get("head")
      ? query(endpoints.repo(repo.id, "diffs"), {
          base: params.get("base") || repo.default_branch,
          head: params.get("head"),
        })
      : null,
  );
  return (
    <>
      <PageHeader
        title="Compare revisions"
        description="Inspect the exact changes between two branches, tags, or commit IDs."
      />
      <form
        className="compare-form"
        onSubmit={(event) => {
          event.preventDefault();
          setParams({ base, head });
        }}
      >
        <div className="field">
          <label htmlFor="compare-base">Base revision</label>
          <input
            id="compare-base"
            value={base}
            onChange={(event) => setBase(event.target.value)}
            required
          />
        </div>
        <span>→</span>
        <div className="field">
          <label htmlFor="compare-head">Head revision</label>
          <input
            id="compare-head"
            value={head}
            onChange={(event) => setHead(event.target.value)}
            required
          />
        </div>
        <Button variant="primary" type="submit">
          Compare
        </Button>
      </form>
      <ErrorNotice error={diff.error} retry={diff.refresh} />
      {diff.loading ? (
        <Loading />
      ) : diff.data ? (
        <DiffViewer data={diff.data} />
      ) : (
        <Panel>
          <Empty
            title="Choose two revisions"
            description="Enter a base and head to view their file-by-file differences."
          />
        </Panel>
      )}
    </>
  );
}
