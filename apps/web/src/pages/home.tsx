import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import {
  Activity,
  ArrowRight,
  CheckCheck,
  CircleDot,
  GitPullRequest,
  Inbox,
  Search,
  Star,
} from "lucide-react";
import { useAuth } from "../auth.tsx";
import { endpoints, query, repoLink } from "../api/endpoints.ts";
import { useCollection, useResource } from "../api/hooks.ts";
import {
  array,
  displayName,
  humanize,
  record,
  text,
  type Entity,
  type Repository,
  type User,
} from "../api/types.ts";
import {
  ActionButton,
  CreateResource,
  EditResource,
  type Field,
} from "../components/forms.tsx";
import {
  Avatar,
  Badge,
  Button,
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
import { revisionSnapshot } from "../api/client.ts";
import { useAttribution } from "../components/attribution.tsx";

export function activityLink(item: Entity): string | null {
  const repo = text(item.repo_id || item.repository_id);
  const subject = record(item.item || item.subject || item.resource);
  const kind = text(
    item.resource_type ||
      item.subject_type ||
      subject.kind ||
      subject.type ||
      item.kind ||
      item.type,
  ).split(".")[0];
  const id = text(
    item.item_id ||
      subject.id ||
      item.resource_id ||
      item.subject_id ||
      item.id,
  );
  if (repo && item.path)
    return repoLink(
      repo,
      `code/${text(item.path).split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(text(item.commit_oid))}#L${text(item.line, "1")}`,
    );
  if (repo && kind === "comment") {
    const section = id.startsWith("iss_")
      ? "issues"
      : id.startsWith("pr_")
        ? "pulls"
        : id.startsWith("disc_")
          ? "discussions"
          : id.startsWith("task_")
            ? "tasks"
            : null;
    if (section) return repoLink(repo, `${section}/${id}#comment-${item.id}`);
  }
  if (
    repo &&
    id &&
    ["issue", "pull", "pull_request", "discussion", "task", "run"].includes(
      kind!,
    )
  ) {
    const section =
      kind === "pull_request" || kind === "pull" ? "pulls" : `${kind}s`;
    return repoLink(repo, `${section}/${encodeURIComponent(id)}`);
  }
  return repo ? repoLink(repo) : null;
}

function ActivityRow({ item }: { item: Entity }) {
  const actor = useAttribution(item);
  const link = activityLink(item);
  return (
    <article className="activity-row">
      <Avatar name={actor.name} url={actor.avatar} small decorative />
      <div>
        <div className="activity-title">
          <strong title={actor.detail}>{actor.name}</strong>
          <span>{humanize(item.event_type || item.type || item.action)}</span>
          <Time value={item.occurred_at || item.created_at} />
        </div>
        {link ? (
          <Link className="activity-subject" to={link}>
            {text(
              item.title ||
                record(item.subject).title ||
                record(item.resource).title ||
                item.resource_id,
              "View activity",
            )}
          </Link>
        ) : (
          <p className="activity-subject">{text(item.title || item.summary)}</p>
        )}
        {item.reason !== undefined && (
          <p className="muted small">{text(item.reason)}</p>
        )}
        {Number(item.group_count) > 1 && (
          <Badge>{text(item.group_count)} grouped updates</Badge>
        )}
      </div>
    </article>
  );
}

export function HomePage() {
  const { session } = useAuth();
  const [filter, setFilter] = useState("");
  const feed = useCollection<Entity>(
    query(endpoints.feed, { type: filter, limit: 20 }),
  );
  const inbox = useCollection<Entity>(
    query(endpoints.inbox, { state: "open", limit: 5 }),
  );
  const repos = useCollection<Repository>(query(endpoints.repos, { limit: 5 }));
  return (
    <>
      <PageHeader
        eyebrow="Your workspace"
        title="A little more connected."
        description={`Welcome${session?.user.display_name ? `, ${session.user.display_name.split(" ")[0]}` : " back"}. Here’s where the work is moving.`}
        actions={
          <Link className="button button-primary" to="/repos/new">
            New repository
            <ArrowRight size={16} />
          </Link>
        }
      />
      <div className="dashboard-grid">
        <div className="dashboard-main">
          <Panel
            title={
              <>
                <Activity size={18} />
                Activity
              </>
            }
            description="A chronological view of your collaboration."
            actions={
              <select
                aria-label="Filter activity"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option value="">All activity</option>
                <option value="issue">Issues</option>
                <option value="pull_request">Pull requests</option>
                <option value="discussion">Discussions</option>
                <option value="task">Tasks</option>
              </select>
            }
          >
            <ErrorNotice error={feed.error} retry={feed.refresh} />
            {feed.loading && !feed.data ? (
              <Loading rows={6} />
            ) : feed.items.length ? (
              feed.items.map((item) => (
                <ActivityRow key={item.id} item={item} />
              ))
            ) : (
              !feed.error && (
                <Empty
                  title="Your next chapter starts here"
                  description="Activity from the people and repositories you follow will appear here."
                  action={
                    <Link className="button button-secondary" to="/repos">
                      Explore repositories
                    </Link>
                  }
                />
              )
            )}
            <Pagination {...feed} />
          </Panel>
        </div>
        <aside className="dashboard-aside">
          <Panel
            title={
              <>
                <Inbox size={18} />
                Needs your attention
              </>
            }
            actions={
              <Link to="/inbox" aria-label="Open inbox">
                <ArrowRight size={16} />
              </Link>
            }
          >
            <ErrorNotice error={inbox.error} retry={inbox.refresh} />
            {inbox.loading && !inbox.data ? (
              <Loading rows={2} />
            ) : inbox.items.length ? (
              inbox.items.map((item) => (
                <div className="attention-item" key={item.id}>
                  <CircleDot size={16} />
                  <div>
                    <Link to={activityLink(item) || "/inbox"}>
                      {text(
                        item.title || item.summary,
                        humanize(item.kind || item.reason),
                      )}
                    </Link>
                    <span>{humanize(item.reason || item.kind)}</span>
                  </div>
                </div>
              ))
            ) : (
              !inbox.error && (
                <div className="quiet-state">
                  <CheckCheck size={25} />
                  <strong>You’re all caught up</strong>
                  <p>
                    Outstanding decisions will stay here until you resolve them.
                  </p>
                </div>
              )
            )}
          </Panel>
          <Panel
            title="Your repositories"
            actions={<Link to="/repos">View all</Link>}
          >
            <ErrorNotice error={repos.error} retry={repos.refresh} />
            {repos.loading && !repos.data ? (
              <Loading rows={2} />
            ) : repos.items.length ? (
              repos.items.map((repo) => (
                <Link
                  className="compact-repo"
                  key={repo.id}
                  to={repoLink(repo.id)}
                >
                  <span className="repo-letter" aria-hidden="true">
                    {repo.name.slice(0, 1).toUpperCase()}
                  </span>
                  <div>
                    <strong>{repo.name}</strong>
                    <span>{repo.description || repo.visibility}</span>
                  </div>
                  <ArrowRight size={15} />
                </Link>
              ))
            ) : (
              !repos.error && (
                <Empty
                  title="A home for your next project"
                  action={<Link to="/repos/new">Create a repository</Link>}
                />
              )
            )}
          </Panel>
          <div className="workspace-note">
            <span className="eyebrow">Work with confidence</span>
            <h3>Every change has context.</h3>
            <p>
              Connect a task, open a pull request, and keep the decision with
              the code.
            </p>
            <Link to="/help">
              Find your way around <ArrowRight size={14} />
            </Link>
          </div>
        </aside>
      </div>
    </>
  );
}

export function InboxPage() {
  const [params, setParams] = useSearchParams();
  const state = params.get("state") || "open";
  const inbox = useCollection<Entity>(
    query(endpoints.inbox, { state, reason: params.get("reason") }),
  );
  return (
    <>
      <PageHeader
        eyebrow="Your work"
        title="Inbox"
        description="Activity tells you what happened. Your inbox keeps track of what needs a decision."
        actions={
          <Link
            className="button button-secondary"
            to="/settings/notifications"
          >
            Notification preferences
          </Link>
        }
      />
      <div className="filter-bar">
        <div className="segmented">
          {["open", "snoozed", "resolved", "all"].map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={state === value}
              onClick={() => setParams({ state: value })}
            >
              {humanize(value)}
            </button>
          ))}
        </div>
        <select
          aria-label="Notification reason"
          value={params.get("reason") || ""}
          onChange={(event) => {
            const next = new URLSearchParams(params);
            next.set("reason", event.target.value);
            setParams(next);
          }}
        >
          <option value="">All reasons</option>
          <option value="mention">Mentions</option>
          <option value="assignment">Assignments</option>
          <option value="review_request">Review requests</option>
          <option value="task_accountability">Task accountability</option>
        </select>
      </div>
      <Panel>
        <ErrorNotice error={inbox.error} retry={inbox.refresh} />
        {inbox.loading && !inbox.data ? (
          <Loading />
        ) : inbox.items.length ? (
          inbox.items.map((item) => (
            <article className="inbox-row" key={item.id}>
              <span className={`inbox-marker ${item.read_at ? "read" : ""}`} />
              <div className="inbox-content">
                <div className="row-title">
                  <Link to={activityLink(item) || `/inbox/${item.id}`}>
                    {text(
                      item.title || item.summary,
                      humanize(item.reason || item.kind),
                    )}
                  </Link>
                  <Status value={item.state} />
                </div>
                <p>
                  <span>{humanize(item.reason || item.kind)}</span>
                  <span className="separator">·</span>
                  <Time value={item.created_at} />
                </p>
                <details>
                  <summary>Why am I seeing this?</summary>
                  <p>{text(item.explanation || item.reason)}</p>
                  <JsonDetails value={item} />
                </details>
              </div>
              <div className="row-actions">
                {!item.read_at && (
                  <ActionButton
                    path={`${endpoints.inbox}/${item.id}`}
                    method="PATCH"
                    label="Mark read"
                    body={{ read: true }}
                    onDone={inbox.refresh}
                  />
                )}
                {item.state !== "completed" && (
                  <>
                    {item.reason === "mention" ? (
                      <ActionButton
                        path={`${endpoints.inbox}/${item.id}`}
                        method="PATCH"
                        label="Acknowledge"
                        description="Mark the outstanding decision as resolved. Reading an event does not resolve it."
                        body={{ state: "completed" }}
                        onDone={inbox.refresh}
                      />
                    ) : (
                      <Link
                        className="button button-secondary"
                        to={activityLink(item) || `/inbox/${item.id}`}
                      >
                        Resolve at source
                      </Link>
                    )}
                    <ActionButton
                      path={`${endpoints.inbox}/${item.id}`}
                      method="PATCH"
                      label="Snooze"
                      fields={[
                        {
                          name: "snoozed_until",
                          label: "Remind me at",
                          type: "datetime-local",
                          required: true,
                        },
                      ]}
                      onDone={inbox.refresh}
                    />
                  </>
                )}
                <SubscriptionButton
                  repoId={text(item.repo_id)}
                  itemId={text(item.item_id)}
                  onSaved={inbox.refresh}
                />
              </div>
            </article>
          ))
        ) : (
          !inbox.error && (
            <Empty
              title="Nothing outstanding"
              description="Mentions, assignments, review requests, and approvals appear here when they need your attention."
            />
          )
        )}
        <Pagination {...inbox} />
      </Panel>
    </>
  );
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") || "";
  const type = params.get("type") || "";
  const { session } = useAuth();
  const saved = useCollection<Entity>(session ? endpoints.savedSearches : null);
  const [input, setInput] = useState(q);
  const search = useCollection<Entity>(
    q && type !== "code"
      ? query(endpoints.search, {
          q,
          type: params.get("type"),
          repo_id: params.get("repo_id"),
          ref: params.get("ref"),
        })
      : null,
  );
  const navigate = useNavigate();
  const coverage = record(search.data?.coverage);
  return (
    <>
      <PageHeader
        eyebrow="Across your workspace"
        title="Find the thread."
        description="Search code, issues, changes, and conversations with visible coverage."
      />
      <form
        className="search-form"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          const next = new URLSearchParams(params);
          next.set("q", input);
          setParams(next);
        }}
      >
        <Search size={20} />
        <input
          aria-label="Search query"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Search your workspace"
          autoFocus
        />
        <Button type="submit" variant="primary">
          Search
        </Button>
      </form>
      <div className="filter-bar">
        <div className="segmented">
          {[
            "",
            "code",
            "issues",
            "pulls",
            "discussions",
            "tasks",
            "comments",
            "repositories",
            "users",
          ].map((type) => (
            <button
              type="button"
              key={type}
              aria-pressed={(params.get("type") || "") === type}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set("type", type);
                setParams(next);
              }}
            >
              {type || "All"}
            </button>
          ))}
        </div>
        {q && session && !["code", "repositories", "users"].includes(type) && (
          <CreateResource
            path={endpoints.savedSearches}
            title="Save search"
            fields={[
              { name: "name", label: "Name", required: true },
              { name: "query", label: "Query", default: q, required: true },
            ]}
            transform={(body) => ({
              name: body.name,
              surface: "search",
              repo_id: params.get("repo_id") || null,
              filters: {
                query: body.query,
                ...(type
                  ? {
                      kind: (
                        {
                          issues: "issue",
                          pulls: "pull_request",
                          discussions: "discussion",
                          tasks: "task",
                          comments: "comment",
                        } as Record<string, string>
                      )[type],
                    }
                  : {}),
              },
            })}
            onSaved={saved.refresh}
          />
        )}
      </div>
      {search.data?.coverage !== undefined && (
        <div className="search-coverage">
          <Badge tone={coverage.complete === true ? "green" : "amber"}>
            {coverage.complete === true
              ? "Complete for this scope"
              : "Partial or indexed results"}
          </Badge>
          <span>
            {text(coverage.indexed_at || search.data.indexed_at) ? (
              <>
                Indexed{" "}
                <Time value={coverage.indexed_at || search.data.indexed_at} />
              </>
            ) : (
              "Index freshness not reported"
            )}
          </span>
          {coverage.revision !== undefined && (
            <code>{text(coverage.revision)}</code>
          )}
          <details>
            <summary>Coverage & exclusions</summary>
            <Metadata
              values={{
                scanned_revisions:
                  coverage.revisions || coverage.scanned_revisions,
                indexed: coverage.indexed,
                total: coverage.total,
                exclusions: coverage.exclusions,
                truncated: coverage.truncated,
                ...coverage,
              }}
            />
          </details>
          {session && <CodeScanCreate queryText={q} />}
        </div>
      )}
      {type === "code" ? (
        <CodeScansPanel queryText={q} />
      ) : (
        <Panel>
          <ErrorNotice error={search.error} retry={search.refresh} />
          {search.loading ? (
            <Loading />
          ) : search.items.length ? (
            search.items.map((item) => (
              <article className="search-result" key={item.id}>
                <div>
                  <Badge>{humanize(item.type || item.kind)}</Badge>
                  <span className="mono muted">
                    {text(item.path || item.repo_id)}
                  </span>
                </div>
                <h3>
                  <Link
                    to={
                      type === "repositories"
                        ? repoLink(item.id)
                        : type === "users"
                          ? `/users/${text(item.username)}`
                          : activityLink(item) || repoLink(text(item.repo_id))
                    }
                  >
                    {displayName(item)}
                  </Link>
                </h3>
                {item.snippet !== undefined && (
                  <pre className="search-snippet">{text(item.snippet)}</pre>
                )}
                <Metadata
                  values={{
                    revision: item.revision_oid || item.commit_oid,
                    line: item.line,
                  }}
                />
              </article>
            ))
          ) : (
            !search.error && (
              <Empty
                title={
                  q
                    ? "No matching results in this scope"
                    : "Follow an idea anywhere"
                }
                description={
                  q
                    ? "Check the query and the reported index coverage, or request a complete scan."
                    : "Search a symbol, a decision, or a conversation. Results only include content you can access."
                }
              />
            )
          )}
          <Pagination {...search} />
        </Panel>
      )}
      {session && (
        <Panel title="Saved searches">
          <ErrorNotice error={saved.error} retry={saved.refresh} />
          {saved.items
            .filter((item) => item.surface === "search")
            .map((item) => (
              <div className="setting-row" key={item.id}>
                <div>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => {
                      const filters = record(item.filters);
                      const types: Record<string, string> = {
                        issue: "issues",
                        pull_request: "pulls",
                        discussion: "discussions",
                        task: "tasks",
                        comment: "comments",
                      };
                      const q = text(filters.query);
                      setInput(q);
                      setParams({
                        q,
                        ...(filters.kind
                          ? { type: types[text(filters.kind)] || "" }
                          : {}),
                        ...(item.repo_id
                          ? { repo_id: text(item.repo_id) }
                          : {}),
                      });
                    }}
                  >
                    {displayName(item)}
                  </button>
                  <p>{text(record(item.filters).query)}</p>
                </div>
                <div className="row-actions">
                  <EditResource
                    path={`${endpoints.savedSearches}/${item.id}`}
                    title="Edit saved search"
                    fields={[
                      { name: "name", label: "Name", required: true },
                      {
                        name: "filters",
                        label: "Search filters",
                        type: "json",
                        required: true,
                      },
                    ]}
                    onSaved={saved.refresh}
                  />
                  <ActionButton
                    path={`${endpoints.savedSearches}/${item.id}`}
                    snapshot={revisionSnapshot(item)}
                    label="Delete saved search"
                    method="DELETE"
                    onDone={saved.refresh}
                  />
                </div>
              </div>
            ))}
          <Pagination {...saved} />
        </Panel>
      )}
    </>
  );
}

function CodeScanCreate({ queryText }: { queryText: string }) {
  const navigate = useNavigate();
  return (
    <CreateResource
      path={endpoints.scans}
      title="Run complete scan"
      fields={[
        {
          name: "query",
          label: "Literal search query",
          default: queryText,
          required: true,
        },
        {
          name: "repositories",
          label: "Repositories and pinned commits",
          type: "json",
          default: [],
          required: true,
          help: "List objects with repo_id and commit_oid. Every repository is scanned at its exact immutable commit.",
        },
        { name: "case_sensitive", label: "Case sensitive", type: "checkbox" },
        { name: "include_globs", label: "Include paths", type: "csv" },
        { name: "exclude_globs", label: "Exclude paths", type: "csv" },
        {
          name: "retention_days",
          label: "Result retention (days)",
          type: "number",
          min: 1,
          max: 7,
          default: 1,
          required: true,
        },
      ]}
      onSaved={(result) => navigate(`/search/scans/${result.data.id}`)}
    />
  );
}

function CodeScansPanel({ queryText }: { queryText: string }) {
  const scans = useCollection<Entity>(endpoints.scans);
  return (
    <Panel
      title="Complete code scans"
      description="Code search records the exact scanned commits, exclusions, and full paginated result coverage."
      actions={<CodeScanCreate queryText={queryText} />}
    >
      <ErrorNotice error={scans.error} retry={scans.refresh} />
      {scans.loading && !scans.data ? (
        <Loading />
      ) : (
        scans.items.map((scan) => (
          <div className="setting-row" key={scan.id}>
            <div>
              <Link to={`/search/scans/${scan.id}`}>
                {text(scan.query, scan.id)}
              </Link>
              <p>
                <Time value={scan.created_at} />
              </p>
            </div>
            <Status value={scan.state} />
          </div>
        ))
      )}
      {!scans.items.length && !scans.loading && !scans.error && (
        <Empty
          title="No code scans yet"
          description="Choose exact repository revisions and start a complete scan."
        />
      )}
      <Pagination {...scans} />
    </Panel>
  );
}

export function SearchScanPage() {
  const { scanId = "" } = useParams();
  const scan = useResource<Entity>(
    `${endpoints.scans}/${encodeURIComponent(scanId)}`,
    { poll: 5000 },
  );
  const results = useCollection<Entity>(
    `${endpoints.scans}/${encodeURIComponent(scanId)}/results`,
  );
  const exclusions = useCollection<Entity>(
    `${endpoints.scans}/${encodeURIComponent(scanId)}/exclusions`,
  );
  useEffect(() => {
    if (["completed", "failed", "cancelled"].includes(text(scan.data?.state))) {
      results.refresh();
      exclusions.refresh();
    }
  }, [scan.data?.state]);
  return (
    <>
      <PageHeader
        title="Complete search scan"
        description="Results are tied to the scanned repository revisions."
        actions={
          scan.data &&
          !["completed", "failed", "cancelled"].includes(
            text(scan.data.state),
          ) && (
            <ActionButton
              path={`${endpoints.scans}/${scanId}`}
              snapshot={scan.snapshot}
              method="DELETE"
              label="Cancel scan"
              danger
              onDone={scan.refresh}
            />
          )
        }
      />
      <ErrorNotice error={scan.error} retry={scan.refresh} />
      {scan.data && (
        <Panel title={<Status value={scan.data.state} />}>
          <div className="panel-body">
            <Metadata values={scan.data} />
            <JsonDetails title="Coverage manifest" value={scan.data.coverage} />
          </div>
        </Panel>
      )}
      <Panel title="Results">
        <ErrorNotice error={results.error} retry={results.refresh} />
        {results.items.map((item) => (
          <article className="search-result" key={item.id}>
            <Link
              to={
                activityLink(item) ||
                repoLink(text(item.repo_id), `code/${text(item.path)}`)
              }
            >
              {text(item.path, displayName(item))}
            </Link>
            <pre>{text(item.snippet || item.text || item.line_text)}</pre>
          </article>
        ))}
        <Pagination {...results} />
      </Panel>
      <Panel title="Exclusions">
        <ErrorNotice error={exclusions.error} retry={exclusions.refresh} />
        {exclusions.items.map((item, index) => (
          <div className="panel-body" key={item.id || index}>
            <Metadata values={item} />
          </div>
        ))}
        <Pagination {...exclusions} />
      </Panel>
    </>
  );
}

export function ProfilePage() {
  const { username = "" } = useParams();
  const profile = useResource<User>(endpoints.profile(username));
  const repos = useCollection<Repository>(
    profile.data ? query(endpoints.repos, { owner_id: profile.data.id }) : null,
  );
  const activity = useCollection<Entity>(
    profile.data ? endpoints.profile(profile.data.id, "activity") : null,
  );
  const { session } = useAuth();
  const following = useResource<{ relationship: Entity | null }>(
    session && profile.data && session.user.id !== profile.data.id
      ? endpoints.profile(session.user.id, `following-user/${profile.data.id}`)
      : null,
  );
  const relationship = following.data?.relationship;
  if (!profile.data && profile.loading) return <Loading />;
  const user = profile.data;
  return (
    <>
      <ErrorNotice error={profile.error} retry={profile.refresh} />
      {user && (
        <>
          <div className="profile-header">
            <Avatar
              name={user.display_name || username}
              url={user.avatar_url}
              decorative
            />
            <div>
              <PageHeader
                eyebrow={`@${username}`}
                title={user.display_name || username}
                description={user.bio}
              />
            </div>
            {session?.user.username === username ? (
              <Link className="button button-secondary" to="/settings/profile">
                Edit profile
              </Link>
            ) : (
              session &&
              (following.loading ? (
                <span role="status">Loading follow status…</span>
              ) : (
                following.data && (
                  <ActionButton
                    path={endpoints.profile(
                      session.user.id,
                      relationship
                        ? `following/${relationship.id}`
                        : "following",
                    )}
                    snapshot={
                      relationship ? revisionSnapshot(relationship) : undefined
                    }
                    label={relationship ? "Unfollow" : "Follow"}
                    method={relationship ? "DELETE" : "POST"}
                    body={relationship ? {} : { user_id: user.id }}
                    onDone={following.refresh}
                  />
                )
              ))
            )}
          </div>
          <ErrorNotice error={following.error} retry={following.refresh} />
          <div className="dashboard-grid">
            <Panel title="Repositories">
              <ErrorNotice error={repos.error} retry={repos.refresh} />
              {repos.items.map((repo) => (
                <Link
                  className="compact-repo"
                  key={repo.id}
                  to={repoLink(repo.id)}
                >
                  <span className="repo-letter" aria-hidden="true">
                    {repo.name.slice(0, 1)}
                  </span>
                  <div>
                    <strong>{repo.name}</strong>
                    <span>{repo.description}</span>
                  </div>
                  <Badge>{repo.visibility}</Badge>
                </Link>
              ))}
              {!repos.items.length && !repos.loading && !repos.error && (
                <Empty
                  title="No visible repositories"
                  description="Only repositories available to you are shown."
                />
              )}
              <Pagination {...repos} />
            </Panel>
            <Panel title="Activity">
              <ErrorNotice error={activity.error} retry={activity.refresh} />
              {activity.items.map((item) => (
                <ActivityRow key={item.id} item={item} />
              ))}
              {!activity.items.length &&
                !activity.loading &&
                !activity.error && <Empty title="No visible activity yet" />}
              <Pagination {...activity} />
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
