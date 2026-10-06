import { useEffect, useMemo, useState } from "react";
import {
  Link,
  NavLink,
  Outlet,
  useNavigate,
  useOutletContext,
  useParams,
  useSearchParams,
} from "react-router";
import {
  ArrowRight,
  Code2,
  FileCode2,
  Folder,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Globe2,
  History,
  ListTodo,
  Lock,
  MessageSquare,
  Plus,
  Search,
  Settings,
  Workflow,
} from "lucide-react";
import { endpoints, query, repoLink } from "../api/endpoints.ts";
import { useCollection, useResource } from "../api/hooks.ts";
import {
  array,
  displayName,
  record,
  text,
  type Entity,
  type Page,
  type Repository,
  type Snapshot,
} from "../api/types.ts";
import {
  ActionButton,
  CreateResource,
  ResourceForm,
  nameField,
  type Field,
} from "../components/forms.tsx";
import {
  Badge,
  Breadcrumbs,
  Button,
  CopyButton,
  DownloadButton,
  Empty,
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
import { Markdown } from "../components/markdown/render.tsx";
import { SubscriptionButton } from "../components/subscription.tsx";
import { useAuth } from "../auth.tsx";
import { revisionSnapshot } from "../api/client.ts";

export const repositoryFields: Field[] = [
  {
    name: "owner_id",
    label: "Owner account",
    required: true,
    help: "The personal or organization account that owns and pays for this repository.",
  },
  nameField,
  { name: "description", label: "Description", type: "textarea" },
  {
    name: "visibility",
    label: "Visibility",
    type: "select",
    required: true,
    default: "private",
    options: ["private", "public", "internal", "unlisted"],
    help: "Private requires access. Internal is organization-only. Unlisted is readable by anyone with the URL.",
  },
  {
    name: "default_branch",
    label: "Default branch",
    default: "main",
    required: true,
  },
];

export function RepositoriesPage() {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get("q") || "");
  const repositories = useCollection<Repository>(
    query(endpoints.repos, {
      q: params.get("q"),
      visibility: params.get("visibility"),
      owner_id: params.get("owner_id"),
      state: params.get("state"),
    }),
  );
  return (
    <>
      <PageHeader
        eyebrow="Your code, together"
        title="Repositories"
        description="A home for every project and all the work around it."
        actions={
          <>
            <Link className="button button-secondary" to="/repos/import">
              Import repository
            </Link>
            <Link className="button button-primary" to="/repos/new">
              <Plus size={16} />
              New repository
            </Link>
          </>
        }
      />
      <div className="filter-bar">
        {session && (
          <select
            aria-label="Repository lifecycle state"
            value={params.get("state") || ""}
            onChange={(event) => {
              const next = new URLSearchParams(params);
              next.set("state", event.target.value);
              if (event.target.value === "deleted" && !next.has("owner_id"))
                next.set("owner_id", session.user.id);
              setParams(next);
            }}
          >
            <option value="">All active repositories</option>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
            <option value="provisioning">Provisioning</option>
            <option value="deleted">Deleted / recovery</option>
          </select>
        )}
        <form
          className="inline-search"
          onSubmit={(event) => {
            event.preventDefault();
            const next = new URLSearchParams(params);
            next.set("q", search);
            setParams(next);
          }}
        >
          <Search size={16} />
          <input
            aria-label="Filter repositories"
            placeholder="Find a repository…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Button type="submit" variant="ghost">
            Filter
          </Button>
        </form>
        <select
          aria-label="Repository visibility"
          value={params.get("visibility") || ""}
          onChange={(event) => {
            const next = new URLSearchParams(params);
            next.set("visibility", event.target.value);
            setParams(next);
          }}
        >
          <option value="">All visibility</option>
          {["public", "private", "internal", "unlisted"].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>
      <ErrorNotice error={repositories.error} retry={repositories.refresh} />
      {repositories.loading && !repositories.data ? (
        <Panel>
          <Loading rows={5} />
        </Panel>
      ) : repositories.items.length ? (
        <div className="repository-grid">
          {repositories.items.map((repo) => (
            <article className="repository-card" key={repo.id}>
              <div className="repository-card-top">
                <span className="repo-emblem">
                  <FolderGit2 size={24} strokeWidth={1.5} />
                </span>
                <Badge>
                  {repo.visibility === "private" ? (
                    <Lock size={11} />
                  ) : (
                    <Globe2 size={11} />
                  )}
                  {repo.visibility}
                </Badge>
              </div>
              <span className="repo-owner">
                {repo.owner_slug || repo.owner_id}
              </span>
              <h2>
                {repo.state === "deleted" ? (
                  repo.name
                ) : (
                  <Link to={repoLink(repo.id)}>{repo.name}</Link>
                )}
              </h2>
              <p>{repo.description || "Code and collaboration, connected."}</p>
              <footer>
                <span>
                  <GitBranch size={13} />
                  {repo.default_branch}
                </span>
                <Status value={repo.state} />
                <Time value={repo.updated_at} />
              </footer>
              {repo.state === "deleted" && (
                <ActionButton
                  path={endpoints.repo(repo.id, "restore")}
                  snapshot={revisionSnapshot(repo)}
                  label="Restore repository"
                  description={`Restore retained repository data. Recovery window: ${text(repo.recovery_until)}.`}
                  onDone={(result) =>
                    navigate(
                      `/operations/${text(result.data.operation_id || record(result.data.operation).id || result.data.id)}`,
                    )
                  }
                />
              )}
            </article>
          ))}
        </div>
      ) : (
        !repositories.error && (
          <Panel>
            <Empty
              title="Make room for your next idea"
              description="Create a repository or import an existing project to bring code, issues, and workflows together."
              action={
                <Link to="/repos/new" className="button button-primary">
                  Create repository
                  <ArrowRight size={15} />
                </Link>
              }
            />
          </Panel>
        )
      )}
      <Pagination {...repositories} />
    </>
  );
}

export function NewRepositoryPage({
  importing = false,
}: {
  importing?: boolean;
}) {
  const navigate = useNavigate();
  const accounts = useCollection<Entity>(endpoints.accounts);
  const fields: Field[] = repositoryFields.map((field) =>
    field.name === "owner_id"
      ? {
          ...field,
          type: "select",
          options: accounts.items.map((account) => ({
            value: account.id,
            label: displayName(account),
          })),
        }
      : field,
  );
  if (importing)
    fields.push(
      {
        name: "source_url",
        label: "Source HTTPS Git URL",
        type: "url",
        required: true,
      },
      {
        name: "source_secret_id",
        label: "Source credential secret reference",
        help: "For a private source, select the ID of a write-only secret containing the source credential.",
      },
    );
  return (
    <>
      <PageHeader
        eyebrow={<Link to="/repos">Repositories</Link>}
        title={
          importing ? "Bring your project along." : "Start something good."
        }
        description={
          importing
            ? "Import Git history and refs through an authenticated, durable operation."
            : "Choose an owner and an explicit audience. You can refine access in repository settings."
        }
      />
      <div className="form-page">
        <Panel>
          <ErrorNotice error={accounts.error} retry={accounts.refresh} />
          <ResourceForm
            path={importing ? "/v1/repos/imports" : endpoints.repos}
            fields={fields}
            draftKey={`repository-${importing ? "import" : "create"}`}
            submitLabel={importing ? "Start import" : "Create repository"}
            onSaved={(result) => {
              const repoId = text(
                result.data.repo_id ||
                  result.data.repository_id ||
                  record(result.data.repository).id,
              );
              const operationId = text(
                result.data.operation_id || record(result.data.operation).id,
              );
              navigate(
                operationId
                  ? `/operations/${operationId}`
                  : repoLink(repoId || result.data.id),
              );
            }}
          />
        </Panel>
      </div>
    </>
  );
}

type RepositoryContext = {
  repo: Repository;
  snapshot: Snapshot<Repository>;
  refresh: () => void;
};
export const useRepository = () => useOutletContext<RepositoryContext>();

export function RepositoryLayout() {
  const { repoId = "" } = useParams();
  const repository = useResource<Repository>(endpoints.repo(repoId));
  const repo = repository.data;
  if (repository.loading && !repo) return <Loading />;
  if (!repo || !repository.snapshot)
    return <ErrorNotice error={repository.error} retry={repository.refresh} />;
  const tabs = [
    { path: "", label: "Code", icon: Code2 },
    { path: "issues", label: "Issues", icon: ListTodo },
    { path: "pulls", label: "Pull requests", icon: GitPullRequest },
    { path: "discussions", label: "Discussions", icon: MessageSquare },
    { path: "tasks", label: "Tasks", icon: ListTodo },
    { path: "workflows", label: "Workflows", icon: Workflow },
    { path: "settings", label: "Settings", icon: Settings },
  ];
  return (
    <>
      <div className="repository-heading">
        <div>
          <Breadcrumbs
            items={[
              {
                label: repo.owner_slug || repo.owner_id,
                to: `/accounts/${repo.owner_id}`,
              },
              { label: repo.name, to: repoLink(repo.id) },
            ]}
          />
          <Badge>{repo.visibility}</Badge>
          {repo.state !== "active" && <Status value={repo.state} />}
        </div>
        <div className="row-actions">
          <SubscriptionButton repoId={repo.id} label="Watch" />
          <CreateResource
            path={endpoints.repo(repo.id, "forks")}
            title="Fork"
            fields={[
              {
                name: "owner_id",
                label: "Destination account ID",
                required: true,
              },
              nameField,
            ]}
            onSaved={(result) => {
              window.location.assign(
                result.data.operation_id
                  ? `/operations/${text(result.data.operation_id)}`
                  : repoLink(text(result.data.repo_id || result.data.id)),
              );
            }}
          />
        </div>
      </div>
      <nav aria-label="Repository navigation" className="tabs repository-tabs">
        {tabs.map((tab) => (
          <NavLink
            key={tab.path}
            to={repoLink(repo.id, tab.path)}
            end={!tab.path}
          >
            <tab.icon size={16} />
            {tab.label}
          </NavLink>
        ))}
      </nav>
      {repo.state === "archived" && (
        <Notice>
          This repository is archived and read-only. Browsing and export remain
          available.
        </Notice>
      )}
      {repo.visibility === "unlisted" && (
        <Notice>
          Anyone with the URL can read this repository. It is excluded from
          public discovery.
        </Notice>
      )}
      <Outlet
        context={
          {
            repo,
            snapshot: repository.snapshot,
            refresh: repository.refresh,
          } satisfies RepositoryContext
        }
      />
    </>
  );
}

export function CodePage() {
  const { repo } = useRepository();
  const { "*": routePath = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const ref = params.get("ref") || repo.default_branch;
  const path = routePath || params.get("path") || "";
  const filesPath = query(endpoints.repo(repo.id, "files"), { ref, path });
  const content = useCollection<Entity>(filesPath);
  const refs = useCollection<Entity>(endpoints.repo(repo.id, "refs"));
  const readme = useResource<Entity>(
    path
      ? null
      : query(endpoints.repo(repo.id, "files"), { ref, path: "README.md" }),
  );
  const [viewMode, setViewMode] = useState<"rendered" | "source">("rendered");
  const data = content.data;
  const entries = content.items;
  const isDirectory =
    data &&
    (Array.isArray(data.items) ||
      Array.isArray(data.entries) ||
      data.type === "tree");
  const source = data && !isDirectory ? text(data.content || data.text) : "";
  const isMarkdown = /\.(md|markdown)$/i.test(path);
  const crumbs = path.split("/").filter(Boolean);
  const clone =
    repo.clone_url ||
    `${import.meta.env.VITE_GIT_ORIGIN || "https://git.gitknot.com"}/${repo.owner_slug || repo.owner_id}/${repo.slug || repo.name}.git`;
  return (
    <>
      <div className="code-toolbar">
        <div className="branch-picker">
          <GitBranch size={15} />
          <select
            aria-label="Branch or tag"
            value={ref}
            onChange={(event) => {
              const next = new URLSearchParams(params);
              next.set("ref", event.target.value);
              setParams(next);
            }}
          >
            <option value={ref}>{ref}</option>
            {refs.items
              .filter((item) => text(item.name || item.ref) !== ref)
              .map((item) => (
                <option
                  value={text(item.name || item.ref)}
                  key={item.id || text(item.name || item.ref)}
                >
                  {text(item.name || item.ref)}
                </option>
              ))}
          </select>
        </div>
        <Link
          to={repoLink(
            repo.id,
            `history?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
          )}
          className="button button-secondary"
        >
          <History size={15} />
          History
        </Link>
        <Link
          to={repoLink(repo.id, "refs")}
          className="button button-secondary"
        >
          Branches & tags
        </Link>
        <Link
          to={repoLink(repo.id, "compare")}
          className="button button-secondary"
        >
          Compare
        </Link>
        <Link
          to={repoLink(
            repo.id,
            `edit?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`,
          )}
          className="button button-secondary"
        >
          {isDirectory || !path ? "New file" : "Propose edit"}
        </Link>
        <details className="clone-popover">
          <summary className="button button-primary">
            <Code2 size={16} />
            Clone
          </summary>
          <div>
            <label>HTTPS remote</label>
            <code>{clone}</code>
            <CopyButton
              value={`git clone ${clone}`}
              label="Copy clone command"
            />
            <p>Use a scoped GitKnot token for authenticated Git access.</p>
          </div>
        </details>
      </div>
      <ErrorNotice error={refs.error} retry={refs.refresh} />
      <Pagination {...refs} />
      {path && (
        <Breadcrumbs
          items={[
            {
              label: repo.name,
              to: repoLink(repo.id, `?ref=${encodeURIComponent(ref)}`),
            },
            ...crumbs.map((part, index) => ({
              label: part,
              to:
                index === crumbs.length - 1
                  ? undefined
                  : repoLink(
                      repo.id,
                      `code/${crumbs
                        .slice(0, index + 1)
                        .map(encodeURIComponent)
                        .join("/")}?ref=${encodeURIComponent(ref)}`,
                    ),
            })),
          ]}
        />
      )}
      <Panel
        title={path || repo.name}
        actions={
          data &&
          !isDirectory && (
            <div className="row-actions">
              {isMarkdown && (
                <div className="segmented">
                  <button
                    type="button"
                    aria-pressed={viewMode === "rendered"}
                    onClick={() => setViewMode("rendered")}
                  >
                    Rendered
                  </button>
                  <button
                    type="button"
                    aria-pressed={viewMode === "source"}
                    onClick={() => setViewMode("source")}
                  >
                    Source
                  </button>
                </div>
              )}
              <DownloadButton
                path={query(endpoints.repo(repo.id, "raw"), { ref, path })}
                name={path.split("/").at(-1) || "file"}
              >
                Raw file
              </DownloadButton>
            </div>
          )
        }
      >
        <ErrorNotice error={content.error} retry={content.refresh} />
        {content.loading && !data ? (
          <Loading />
        ) : isDirectory ? (
          entries.length ? (
            <div className="file-list">
              {path && (
                <Link
                  className="file-row"
                  to={repoLink(
                    repo.id,
                    `code/${crumbs.slice(0, -1).map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
                  )}
                >
                  <Folder size={17} />
                  <strong>..</strong>
                </Link>
              )}
              {entries.map((item) => {
                const itemPath = text(
                  item.path,
                  [path, text(item.name)].filter(Boolean).join("/"),
                );
                const directory =
                  item.type === "tree" ||
                  item.type === "directory" ||
                  item.kind === "directory";
                return (
                  <Link
                    key={itemPath}
                    className="file-row"
                    to={repoLink(
                      repo.id,
                      `code/${itemPath.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`,
                    )}
                  >
                    {directory ? (
                      <Folder size={17} className="folder-icon" />
                    ) : (
                      <FileCode2 size={17} />
                    )}
                    <strong>
                      {text(item.name, itemPath.split("/").at(-1))}
                    </strong>
                    <span>
                      {text(item.last_commit_message || item.message)}
                    </span>
                    <span className="file-size">
                      {item.size !== undefined ? `${text(item.size)} B` : ""}
                    </span>
                  </Link>
                );
              })}
            </div>
          ) : (
            <Empty
              title="Your repository is ready for code"
              description="Push an existing project over HTTPS or propose your first file."
              action={
                <CopyButton
                  value={`git remote add origin ${clone}`}
                  label="Copy remote command"
                />
              }
            />
          )
        ) : data ? (
          data.binary ? (
            <Empty
              title={
                data.too_large ? "File is too large to preview" : "Binary file"
              }
              description="Download the authorized original to inspect this file. Text previews are bounded at 2 MiB."
            />
          ) : (
            <div className="file-content">
              {isMarkdown && viewMode === "rendered" ? (
                <Markdown
                  source={source}
                  repository={{
                    id: repo.id,
                    ref: text(data.commit_oid, ref),
                    path,
                  }}
                />
              ) : (
                <CodeLines source={source} />
              )}
            </div>
          )
        ) : null}
      </Panel>
      <Pagination {...content} />
      {!path && readme.data?.content !== undefined && (
        <Panel title="README.md">
          <div className="panel-body">
            <Markdown
              source={text(readme.data.content)}
              repository={{
                id: repo.id,
                ref: text(readme.data.commit_oid, ref),
                path: "README.md",
              }}
            />
          </div>
        </Panel>
      )}
      {!path && repo.description && (
        <p className="repo-description">{repo.description}</p>
      )}
    </>
  );
}

export function CodeLines({ source }: { source: string }) {
  const lines = useMemo(() => source.split(/\r\n?|\n/), [source]);
  const pageSize = 1000;
  const [start, setStart] = useState(0);
  useEffect(() => {
    const reveal = () => {
      const number = Number(/^#L(\d+)$/.exec(location.hash)?.[1] || 1);
      setStart(
        Math.floor(
          (Math.min(Math.max(number, 1), lines.length) - 1) / pageSize,
        ) * pageSize,
      );
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [lines.length]);
  return (
    <>
      <div className="code-lines" tabIndex={0} aria-label="File source">
        {lines.slice(start, start + pageSize).map((line, index) => (
          <div id={`L${start + index + 1}`} key={start + index}>
            <a
              href={`#L${start + index + 1}`}
              aria-label={`Line ${start + index + 1}`}
            >
              {start + index + 1}
            </a>
            <code>{line || " "}</code>
          </div>
        ))}
      </div>
      {lines.length > pageSize && (
        <div className="pagination row-actions">
          <Button
            disabled={start === 0}
            onClick={() => setStart((value) => Math.max(0, value - pageSize))}
          >
            Previous lines
          </Button>
          <span>
            Lines {start + 1}–{Math.min(start + pageSize, lines.length)} of{" "}
            {lines.length}
          </span>
          <Button
            disabled={start + pageSize >= lines.length}
            onClick={() => setStart((value) => value + pageSize)}
          >
            Next lines
          </Button>
        </div>
      )}
    </>
  );
}

export function EditFilePage() {
  const { repo } = useRepository();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const path = params.get("path") || "";
  const ref = params.get("ref") || repo.default_branch;
  const file = useResource<Entity>(
    query(endpoints.repo(repo.id, "files"), { path, ref }),
  );
  if (!file.data && file.loading) return <Loading />;
  if (file.data?.binary)
    return (
      <Panel>
        <Empty
          title="This file requires a Git client to edit"
          description="The browser editor supports UTF-8 text within the preview limit."
          action={
            <DownloadButton
              path={query(endpoints.repo(repo.id, "raw"), {
                path,
                ref: file.data.commit_oid || ref,
              })}
              name={path.split("/").at(-1) || "file"}
            />
          }
        />
      </Panel>
    );
  const fields: Field[] = [
    { name: "path", label: "File path", default: path, required: true },
    {
      name: "ref",
      label: "Existing proposal branch",
      default: ref.startsWith("refs/") ? ref : `refs/heads/${ref}`,
      required: true,
      help: "The proposed edit is published through the same branch-policy gate as Git pushes.",
    },
    {
      name: "expected_oid",
      label: "Expected base commit",
      default:
        file.data?.commit_oid ||
        (file.data?.empty_repository ? "0".repeat(40) : ""),
      required: true,
    },
    { name: "message", label: "Commit message", required: true },
    {
      name: "content",
      label: "File content",
      type: /\.(md|markdown)$/i.test(path) ? "markdown" : "code",
      default: text(file.data?.content),
    },
  ];
  return (
    <>
      <PageHeader
        title={path ? "Propose a file edit" : "Propose a new file"}
        description="Your edit becomes an ordinary proposed change with a pinned base revision."
      />
      <ErrorNotice error={file.error} retry={file.refresh} />
      <Notice>
        Create a proposal branch from the intended base commit before editing.{" "}
        <Link to={repoLink(repo.id, "refs")}>Manage branches and tags</Link>.
        After publication, open a pull request to review the change.
      </Notice>
      <Panel>
        <ResourceForm
          path={endpoints.repo(repo.id, "files")}
          fields={fields}
          draftKey={`${repo.id}:${ref}:${path}:edit`}
          submitLabel="Create proposed change"
          revisionPath={query(endpoints.repo(repo.id, "files"), { path, ref })}
          transform={(values) => {
            const bytes = new TextEncoder().encode(text(values.content));
            let binary = "";
            for (let offset = 0; offset < bytes.length; offset += 8192)
              binary += String.fromCharCode(
                ...bytes.subarray(offset, offset + 8192),
              );
            return {
              ref: values.ref,
              expected_oid: values.expected_oid,
              message: values.message,
              edits: [{ path: values.path, content_base64: btoa(binary) }],
            };
          }}
          onSaved={(result) =>
            navigate(
              repoLink(
                repo.id,
                `git/operations/${text(result.data.operation_id || result.data.id)}`,
              ),
            )
          }
        />
      </Panel>
    </>
  );
}

export function HistoryPage() {
  const { repo } = useRepository();
  const [params] = useSearchParams();
  const commits = useCollection<Entity>(
    query(endpoints.repo(repo.id, "commits"), {
      ref: params.get("ref") || repo.default_branch,
      path: params.get("path"),
    }),
  );
  return (
    <>
      <PageHeader
        eyebrow={repo.name}
        title="Commit history"
        description={
          params.get("path") || "The history behind this repository."
        }
      />
      <Panel>
        <ErrorNotice error={commits.error} retry={commits.refresh} />
        {commits.loading && !commits.data ? (
          <Loading />
        ) : (
          commits.items.map((commit) => (
            <article className="commit-row" key={commit.id || text(commit.oid)}>
              <GitCommitHorizontal size={20} />
              <div>
                <Link
                  to={repoLink(
                    repo.id,
                    `commits/${text(commit.oid || commit.id)}`,
                  )}
                >
                  {text(commit.message || commit.subject).split("\n")[0]}
                </Link>
                <p>
                  {text(record(commit.author).name || commit.author_name)}
                  <span className="separator">·</span>
                  <Time
                    value={
                      commit.committed_at ||
                      record(commit.committer).date ||
                      commit.created_at
                    }
                  />
                </p>
              </div>
              <Link
                className="commit-sha"
                to={repoLink(
                  repo.id,
                  `code?ref=${text(commit.oid || commit.id)}`,
                )}
              >
                {text(commit.oid || commit.id).slice(0, 8)}
              </Link>
            </article>
          ))
        )}
        {!commits.items.length && !commits.loading && !commits.error && (
          <Empty title="No commits in this view" />
        )}
        <Pagination {...commits} />
      </Panel>
    </>
  );
}

export function CommitPage() {
  const { repo } = useRepository();
  const { commitId = "" } = useParams();
  const commit = useResource<Entity>(
    endpoints.repo(repo.id, `commits/${encodeURIComponent(commitId)}`),
  );
  return (
    <>
      <PageHeader title="Commit" description={commitId} />
      <ErrorNotice error={commit.error} retry={commit.refresh} />
      {commit.data ? (
        <Panel title={text(commit.data.message)}>
          <div className="panel-body">
            <Metadata values={commit.data} />
            <Link
              className="button button-secondary"
              to={repoLink(
                repo.id,
                `compare?base=${text(array(commit.data.parents)[0])}&head=${commitId}`,
              )}
            >
              View changes
            </Link>
            <Link
              className="button button-secondary"
              to={repoLink(repo.id, `code?ref=${commitId}`)}
            >
              Browse files
            </Link>
          </div>
        </Panel>
      ) : (
        commit.loading && <Loading />
      )}
    </>
  );
}

export function RefsPage() {
  const { repo, snapshot } = useRepository();
  const refs = useCollection<Entity>(endpoints.repo(repo.id, "refs"));
  const navigate = useNavigate();
  const zero = "0".repeat(40);
  return (
    <>
      <PageHeader
        title="Branches & tags"
        description="Every ref mutation uses exact old/new object IDs and the canonical publication gate."
      />
      <Panel title="Create a branch or tag">
        <ResourceForm
          path={endpoints.repo(repo.id, "refs")}
          precondition={snapshot}
          revisionPath={endpoints.repo(repo.id)}
          fields={[
            {
              name: "ref",
              label: "Full ref name",
              required: true,
              help: "Use refs/heads/name or refs/tags/name.",
            },
            { name: "new_oid", label: "Starting commit ID", required: true },
          ]}
          transform={(body) => ({ updates: [{ ...body, old_oid: zero }] })}
          submitLabel="Create ref"
          onSaved={(result) =>
            navigate(
              repoLink(
                repo.id,
                `git/operations/${text(result.data.operation_id || result.data.id)}`,
              ),
            )
          }
        />
      </Panel>
      <Panel title="Current refs">
        <ErrorNotice error={refs.error} retry={refs.refresh} />
        {refs.loading && !refs.data ? (
          <Loading />
        ) : (
          refs.items.map((ref) => (
            <div className="commit-row" key={text(ref.ref)}>
              <GitBranch size={18} />
              <div>
                <Link
                  to={repoLink(
                    repo.id,
                    `?ref=${encodeURIComponent(text(ref.ref))}`,
                  )}
                >
                  {text(ref.ref)}
                </Link>
                <p className="mono">{text(ref.oid)}</p>
              </div>
              <Link
                className="button button-secondary"
                to={repoLink(
                  repo.id,
                  `edit?ref=${encodeURIComponent(text(ref.ref))}`,
                )}
              >
                Add a file
              </Link>
              <ActionButton
                path={endpoints.repo(repo.id, "refs")}
                snapshot={snapshot}
                resourcePath={endpoints.repo(repo.id)}
                label="Delete ref"
                danger
                confirmText={text(ref.ref)}
                body={{
                  updates: [{ ref: ref.ref, old_oid: ref.oid, new_oid: zero }],
                }}
                onDone={(result) =>
                  navigate(
                    repoLink(
                      repo.id,
                      `git/operations/${text(result.data.operation_id || result.data.id)}`,
                    ),
                  )
                }
              />
            </div>
          ))
        )}
        {!refs.items.length && !refs.loading && !refs.error && (
          <Empty
            title="No published refs"
            description="Push your first commit over HTTPS to initialize this repository, or create an empty-branch file with a zero expected OID."
          />
        )}
        <Pagination {...refs} />
      </Panel>
    </>
  );
}

export function GitOperationPage() {
  const { repo } = useRepository();
  const { operationId = "" } = useParams();
  const [poll, setPoll] = useState(2000);
  const operation = useResource<
    Entity & { error: { code: string; message: string } | null }
  >(
    endpoints.repo(
      repo.id,
      `git/operations/${encodeURIComponent(operationId)}`,
    ),
    { poll },
  );
  useEffect(() => {
    if (
      operation.data &&
      ["committed", "rejected"].includes(text(operation.data.state))
    )
      setPoll(0);
  }, [operation.data?.state]);
  return (
    <>
      <PageHeader title="Git publication" description={operationId} />
      <ErrorNotice error={operation.error} retry={operation.refresh} />
      {operation.data ? (
        <Panel title={<Status value={operation.data.state} />}>
          <div className="panel-body">
            <Metadata
              values={{
                actor: operation.data.actor_id,
                policy_revision: operation.data.policy_revision,
                finalized: operation.data.finalized,
              }}
            />
            {operation.data.error && (
              <Notice tone="warning">
                {text(record(operation.data.error).message)}
              </Notice>
            )}
            {array<Entity>(record(operation.data.result).refs).map((ref) => (
              <div className="setting-row" key={text(ref.ref)}>
                <div>
                  <h3>{text(ref.ref)}</h3>
                  <p className="mono">
                    {text(ref.old_oid)} → {text(ref.new_oid)}
                  </p>
                </div>
                {operation.data?.state === "committed" && (
                  <div className="row-actions">
                    <Link
                      className="button button-secondary"
                      to={repoLink(
                        repo.id,
                        `?ref=${encodeURIComponent(text(ref.ref))}`,
                      )}
                    >
                      Browse revision
                    </Link>
                    <Link
                      className="button button-primary"
                      to={repoLink(
                        repo.id,
                        `pulls?new=1&head_ref=${encodeURIComponent(text(ref.ref))}&head_oid=${text(ref.new_oid)}`,
                      )}
                    >
                      Open pull request
                    </Link>
                  </div>
                )}
              </div>
            ))}
            <JsonDetails
              title="Canonical publication receipt"
              value={operation.data}
            />
          </div>
        </Panel>
      ) : (
        operation.loading && <Loading />
      )}
    </>
  );
}
