import { useState } from "react";
import {
  Link,
  NavLink,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import {
  CircleDot,
  GitPullRequest,
  ListTodo,
  MessageSquare,
  Plus,
  Search,
} from "lucide-react";
import { endpoints, query, repoLink } from "../api/endpoints.ts";
import { useCollection, useMutation, useResource } from "../api/hooks.ts";
import { request, requireEtag, revisionSnapshot } from "../api/client.ts";
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
  ResourceForm,
  markdownField,
  titleField,
  type Field,
} from "../components/forms.tsx";
import {
  Avatar,
  Badge,
  Button,
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
import { ResourceCollection } from "../components/resources.tsx";
import { SubscriptionButton } from "../components/subscription.tsx";
import { useRepository } from "./repositories.tsx";
import { DiffViewer } from "./diff.tsx";
import { Attribution, useAttribution } from "../components/attribution.tsx";

export type CollaborationKind = "issues" | "pulls" | "discussions" | "tasks";
const kinds = {
  issues: {
    title: "Issues",
    singular: "issue",
    description:
      "Plan the work, capture the details, and keep progress visible.",
    icon: CircleDot,
  },
  pulls: {
    title: "Pull requests",
    singular: "pull request",
    description:
      "Review a proposal, understand the evidence, and make a clear decision.",
    icon: GitPullRequest,
  },
  discussions: {
    title: "Discussions",
    singular: "discussion",
    description: "Give questions, ideas, and decisions a place to take shape.",
    icon: MessageSquare,
  },
  tasks: {
    title: "Tasks",
    singular: "task",
    description:
      "Coordinate people and agents around a shared base and a clear owner.",
    icon: ListTodo,
  },
};

function itemFields(kind: CollaborationKind, creating = false): Field[] {
  const fields: Field[] = [titleField, markdownField];
  if (!creating)
    fields.push({
      name: "state",
      label: "State",
      type: "select",
      options:
        kind === "issues"
          ? ["open", "closed"]
          : kind === "pulls"
            ? ["open", "draft", "closed"]
            : kind === "tasks"
              ? ["active", "completed", "cancelled"]
              : ["open", "closed"],
    });
  if (kind === "issues")
    fields.push(
      {
        name: "assignee_ids",
        label: "Assignee IDs",
        type: "csv",
        createOnly: true,
      },
      { name: "label_ids", label: "Label IDs", type: "csv", createOnly: true },
      { name: "milestone_id", label: "Milestone ID" },
      { name: "status_id", label: "Typed status ID" },
      { name: "template_id", label: "Template ID", createOnly: true },
      {
        name: "priority",
        label: "Priority",
        type: "select",
        options: ["none", "low", "normal", "high", "urgent"],
        default: "normal",
      },
      { name: "due_at", label: "Due date", type: "datetime-local" },
    );
  if (kind === "pulls")
    fields.push(
      {
        name: "draft",
        label: "Draft pull request",
        type: "checkbox",
        default: true,
        createOnly: true,
      },
      {
        name: "base_ref",
        label: "Base branch",
        required: creating,
        createOnly: true,
        help: "Full ref, such as refs/heads/main.",
      },
      {
        name: "head_ref",
        label: "Head branch",
        required: creating,
        createOnly: true,
      },
      { name: "head_repo_id", label: "Head repository ID", createOnly: true },
      {
        name: "base_oid",
        label: "Exact base commit",
        required: creating,
        createOnly: true,
      },
      {
        name: "head_oid",
        label: "Exact head commit",
        required: creating,
        createOnly: true,
      },
      { name: "task_id", label: "Originating task ID", createOnly: true },
      { name: "milestone_id", label: "Milestone ID" },
    );
  if (kind === "discussions")
    fields.push({ name: "category_id", label: "Category ID", required: true });
  if (kind === "tasks")
    fields.push(
      { name: "issue_id", label: "Linked issue ID" },
      {
        name: "accountable_user_id",
        label: "Accountable person ID",
        required: true,
      },
      {
        name: "contributor_ids",
        label: "Contributor IDs",
        type: "csv",
        createOnly: true,
      },
      {
        name: "base_oid",
        label: "Base commit",
        required: true,
        createOnly: true,
      },
    );
  return fields;
}

export function CollaborationList({ kind }: { kind: CollaborationKind }) {
  const { repo } = useRepository();
  const spec = kinds[kind];
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [input, setInput] = useState(params.get("q") || "");
  const state = params.get("state") || (kind === "tasks" ? "active" : "open");
  const path = endpoints.repo(repo.id, kind);
  const baseCommit = useResource<Entity>(
    kind === "pulls" && params.get("new") === "1"
      ? query(endpoints.repo(repo.id, "commits"), {
          ref: repo.default_branch,
          limit: 1,
        })
      : null,
  );
  const createFields = itemFields(kind, true).map((field) => ({
    ...field,
    default:
      params.get(field.name) ||
      (field.name === "base_ref"
        ? `refs/heads/${repo.default_branch.replace(/^refs\/heads\//, "")}`
        : field.name === "base_oid" && baseCommit.data
          ? baseCommit.data.revision
          : field.default),
  }));
  const items = useCollection<Entity>(
    query(path, {
      state,
      q: params.get("q"),
      label_id: params.get("label_id"),
      assignee_id: params.get("assignee_id"),
    }),
  );
  return (
    <>
      <PageHeader
        title={spec.title}
        description={spec.description}
        actions={
          baseCommit.loading ? (
            <span role="status">Resolving base revision…</span>
          ) : (
            <CreateResource
              path={path}
              title={`New ${spec.singular}`}
              fields={createFields}
              initiallyOpen={params.get("new") === "1"}
              onSaved={(result) =>
                navigate(repoLink(repo.id, `${kind}/${result.data.id}`))
              }
            />
          )
        }
      />
      <ErrorNotice error={baseCommit.error} retry={baseCommit.refresh} />
      <div className="filter-bar">
        <div className="segmented">
          {(kind === "tasks"
            ? ["active", "completed", "cancelled", "all"]
            : kind === "pulls"
              ? ["open", "draft", "closed", "all"]
              : kind === "discussions"
                ? ["open", "answered", "closed", "all"]
                : ["open", "closed", "all"]
          ).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={state === value}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set("state", value);
                setParams(next);
              }}
            >
              {humanize(value)}
            </button>
          ))}
        </div>
        <form
          className="inline-search"
          onSubmit={(event) => {
            event.preventDefault();
            const next = new URLSearchParams(params);
            next.set("q", input);
            setParams(next);
          }}
        >
          <Search size={16} />
          <input
            aria-label={`Filter ${spec.title.toLowerCase()}`}
            placeholder="Filter by title or keyword…"
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
          <Button type="submit" variant="ghost">
            Filter
          </Button>
        </form>
        {kind === "issues" && (
          <Link
            to={repoLink(repo.id, "issues/manage")}
            className="button button-secondary"
          >
            Labels & milestones
          </Link>
        )}
        {kind === "discussions" && (
          <Link
            to={repoLink(repo.id, "discussions/categories")}
            className="button button-secondary"
          >
            Categories
          </Link>
        )}
      </div>
      <Panel>
        <ErrorNotice error={items.error} retry={items.refresh} />
        {items.loading && !items.data ? (
          <Loading rows={6} />
        ) : items.items.length ? (
          items.items.map((item) => (
            <article key={item.id} className="work-item">
              <spec.icon
                size={20}
                className={`work-icon state-${text(item.state)}`}
              />
              <div>
                <h3>
                  <Link to={repoLink(repo.id, `${kind}/${item.id}`)}>
                    {displayName(item)}
                  </Link>
                  {item.draft === true && <Badge>Draft</Badge>}
                </h3>
                <p>
                  <span>#{text(item.number, item.id)}</span>
                  <span className="separator">·</span>
                  <Status value={item.state || item.status} />
                  <span className="separator">·</span>
                  <Attribution value={item} />
                  <Time value={item.updated_at || item.created_at} />
                </p>
                <div className="label-list">
                  {array<Entity | string>(item.labels).map((label) => (
                    <Badge key={typeof label === "string" ? label : label.id}>
                      {typeof label === "string" ? label : displayName(label)}
                    </Badge>
                  ))}
                </div>
              </div>
              {item.comment_count !== undefined && (
                <span className="comment-count">
                  <MessageSquare size={14} />
                  {text(item.comment_count)}
                </span>
              )}
            </article>
          ))
        ) : (
          !items.error && (
            <Empty
              title={`No ${spec.title.toLowerCase()} in this view`}
              description={`Create a ${spec.singular} or change your filters to find existing work.`}
            />
          )
        )}
        <Pagination {...items} />
      </Panel>
    </>
  );
}

export function CollaborationDetail({ kind }: { kind: CollaborationKind }) {
  const { repo } = useRepository();
  const { itemId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") || "conversation";
  const path = endpoints.item(repo.id, kind, itemId);
  const item = useResource<Entity>(path);
  const comments = useCollection<Entity>(`${path}/comments`);
  const activity = useCollection<Entity>(`${path}/events`);
  const navigate = useNavigate();
  const [passage, setPassage] = useState<{
    quote: string;
    start: number;
    end: number;
  } | null>(null);
  const data = item.data;
  if (!data && item.loading) return <Loading />;
  if (!data) return <ErrorNotice error={item.error} retry={item.refresh} />;
  const refresh = () => {
    item.refresh();
    comments.refresh();
    activity.refresh();
  };
  const actionFields: Field[] = [
    { name: "body", label: "Comment", type: "markdown", required: true },
  ];
  return (
    <>
      <PageHeader
        eyebrow={
          <Link to={repoLink(repo.id, kind)}>
            {kinds[kind].title} / #{text(data.number, itemId)}
          </Link>
        }
        title={displayName(data)}
        actions={
          <EditResource
            path={path}
            title={`Edit ${kinds[kind].singular}`}
            fields={itemFields(kind)}
            onSaved={refresh}
          />
        }
      />
      <div className="item-meta">
        <Status value={data.state} />
        {data.draft === true && <Badge>Draft</Badge>}
        <Attribution value={data} />
        <span>
          opened <Time value={data.created_at} />
        </span>
        {kind === "pulls" && (
          <>
            <code>{text(data.head_ref)}</code>
            <span>→</span>
            <code>{text(data.base_ref)}</code>
          </>
        )}
      </div>
      {kind === "pulls" && (
        <nav className="tabs" aria-label="Pull request views">
          {["conversation", "changes", "patches", "checks", "dependencies"].map(
            (value) => (
              <button
                key={value}
                type="button"
                className={tab === value ? "active" : ""}
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.set("tab", value);
                  setParams(next);
                }}
              >
                {humanize(value)}
              </button>
            ),
          )}
        </nav>
      )}
      {kind === "pulls" && tab !== "conversation" ? (
        <PullReviewContent
          tab={tab}
          path={path}
          item={data}
          refresh={refresh}
        />
      ) : (
        <div className="detail-grid">
          <div className="detail-main">
            <Panel title="Description">
              <div className="panel-body">
                {text(data.body || data.body_markdown) ? (
                  <Markdown
                    source={text(data.body || data.body_markdown)}
                    onPassage={setPassage}
                  />
                ) : (
                  <p className="muted">No description provided.</p>
                )}
              </div>
            </Panel>
            {passage && (
              <Notice>
                <strong>Comment on the selected passage</strong>
                <blockquote>{passage.quote}</blockquote>
                <p>
                  The comment will be anchored to revision {text(data.revision)}
                  .
                </p>
                <Button onClick={() => setPassage(null)}>
                  Clear selection
                </Button>
              </Notice>
            )}
            <Panel title="Conversation">
              <ErrorNotice error={comments.error} retry={comments.refresh} />
              {comments.loading && !comments.data ? (
                <Loading rows={2} />
              ) : (
                comments.items.map((comment) => (
                  <Comment
                    key={comment.id}
                    comment={comment}
                    path={`${path}/comments/${comment.id}`}
                    refresh={refresh}
                    discussion={
                      kind === "discussions"
                        ? {
                            path,
                            snapshot: item.snapshot,
                            accepted: data.accepted_answer_id === comment.id,
                          }
                        : undefined
                    }
                  />
                ))
              )}
              {!comments.items.length &&
                !comments.loading &&
                !comments.error && (
                  <div className="panel-body muted">
                    Start the conversation with a comment, question, or a little
                    more context.
                  </div>
                )}
              <Pagination {...comments} />
            </Panel>
            <Panel title="Add a comment">
              <ResourceForm
                key={`comment-${comments.items.length}`}
                path={`${path}/comments`}
                fields={actionFields}
                precondition={item.snapshot}
                revisionPath={path}
                draftKey={`${path}:comment`}
                transform={async (values) => {
                  if (!passage) return values;
                  const digest = await crypto.subtle.digest(
                    "SHA-256",
                    new TextEncoder().encode(passage.quote),
                  );
                  const sha256 = [...new Uint8Array(digest)]
                    .map((byte) => byte.toString(16).padStart(2, "0"))
                    .join("");
                  return {
                    ...values,
                    anchor: {
                      document_revision: data.document_revision,
                      start: passage.start,
                      end: passage.end,
                      sha256,
                    },
                  };
                }}
                submitLabel="Post comment"
                onSaved={() => {
                  setPassage(null);
                  refresh();
                }}
              />
            </Panel>
            <AttachmentPanel path={path} />
            <Panel title="Activity history">
              <ErrorNotice error={activity.error} retry={activity.refresh} />
              {activity.items.map((event) => (
                <div className="timeline-row" key={event.id}>
                  <span className="timeline-dot" />
                  <div>
                    {humanize(event.type || event.event_type)}{" "}
                    <span className="muted">
                      <Attribution value={event} />
                    </span>
                    <Time value={event.created_at || event.occurred_at} />
                    <JsonDetails value={event} />
                  </div>
                </div>
              ))}
              <Pagination {...activity} />
            </Panel>
          </div>
          <aside className="detail-sidebar">
            <Panel title="Details">
              <div className="panel-body">
                <Metadata
                  values={{
                    assignees: data.assignee_ids || data.assignees,
                    labels: data.labels || data.label_ids,
                    milestone: data.milestone_id,
                    dependencies: data.dependency_ids,
                    duplicate_of: data.duplicate_of,
                    category: data.category_id,
                    owner: data.accountable_user_id || data.owner_id,
                    base_commit: data.base_oid,
                    contributors: data.contributor_ids,
                    task: data.task_id,
                    revision: data.revision,
                  }}
                />
              </div>
            </Panel>
            <Panel title="Actions">
              <div className="stack panel-body">
                <SubscriptionButton repoId={repo.id} itemId={itemId} />
                {kind === "issues" && (
                  <>
                    <ActionButton
                      path={`${path}/assignees`}
                      snapshot={item.snapshot}
                      label="Assign people"
                      method="PUT"
                      fields={[
                        {
                          name: "user_ids",
                          label: "Assignee IDs",
                          type: "csv",
                          default: array<Entity>(data.assignees).map(
                            (user) => user.id,
                          ),
                        },
                      ]}
                      onDone={refresh}
                    />
                    <ActionButton
                      path={`${path}/labels`}
                      snapshot={item.snapshot}
                      label="Set labels"
                      method="PUT"
                      fields={[
                        {
                          name: "label_ids",
                          label: "Label IDs",
                          type: "csv",
                          default: array<Entity>(data.labels).map(
                            (label) => label.id,
                          ),
                        },
                      ]}
                      onDone={refresh}
                    />
                    <ActionButton
                      path={`${path}/duplicate`}
                      snapshot={item.snapshot}
                      label={
                        data.duplicate_of_id
                          ? "Clear duplicate"
                          : "Mark duplicate"
                      }
                      method="PUT"
                      fields={
                        data.duplicate_of_id
                          ? []
                          : [
                              {
                                name: "duplicate_of_id",
                                label: "Original issue ID",
                                required: true,
                              },
                            ]
                      }
                      body={
                        data.duplicate_of_id ? { duplicate_of_id: null } : {}
                      }
                      onDone={refresh}
                    />
                    <ActionButton
                      path={path}
                      snapshot={item.snapshot}
                      label={
                        data.state === "closed" ? "Reopen issue" : "Close issue"
                      }
                      method="PATCH"
                      body={{
                        state: data.state === "closed" ? "open" : "closed",
                      }}
                      onDone={refresh}
                    />
                  </>
                )}
                {kind === "discussions" && (
                  <>
                    <ActionButton
                      path={`${path}/pin`}
                      snapshot={item.snapshot}
                      method="PUT"
                      label={
                        data.pinned ? "Unpin discussion" : "Pin discussion"
                      }
                      body={{ pinned: !data.pinned }}
                      onDone={refresh}
                    />
                    <ActionButton
                      path={`${path}/issue`}
                      snapshot={item.snapshot}
                      method="PUT"
                      label={
                        data.converted_issue_id
                          ? "Unlink issue"
                          : "Link existing issue"
                      }
                      body={data.converted_issue_id ? { issue_id: null } : {}}
                      fields={
                        data.converted_issue_id
                          ? []
                          : [
                              {
                                name: "issue_id",
                                label: "Issue ID",
                                required: true,
                              },
                            ]
                      }
                      onDone={refresh}
                    />
                    <ActionButton
                      path={`${path}/convert-to-issue`}
                      snapshot={item.snapshot}
                      label="Convert to issue"
                      description="Create a linked issue while preserving the discussion and its context."
                      fields={[{ ...titleField, default: data.title }]}
                      onDone={(result) =>
                        navigate(
                          repoLink(
                            repo.id,
                            `issues/${text(result.data.issue_id || result.data.id)}`,
                          ),
                        )
                      }
                    />
                    <ActionButton
                      path={`${path}/lock`}
                      snapshot={item.snapshot}
                      label={
                        data.locked ? "Unlock discussion" : "Lock discussion"
                      }
                      method="PUT"
                      body={{ locked: !data.locked }}
                      fields={[
                        { name: "reason", label: "Reason", required: true },
                      ]}
                      onDone={refresh}
                    />
                  </>
                )}
                {kind === "pulls" && (
                  <PullActions
                    path={path}
                    item={data}
                    snapshot={item.snapshot}
                    refresh={refresh}
                  />
                )}
                {kind === "tasks" && (
                  <>
                    <ActionButton
                      path={`${path}/contributors`}
                      snapshot={item.snapshot}
                      method="PUT"
                      label="Set contributors"
                      fields={[
                        {
                          name: "principal_ids",
                          label: "Contributor principal IDs",
                          type: "csv",
                          default: data.contributor_ids,
                        },
                      ]}
                      onDone={refresh}
                    />
                    <ActionButton
                      path={path}
                      snapshot={item.snapshot}
                      label="Complete task"
                      method="PATCH"
                      body={{ state: "completed" }}
                      fields={[
                        {
                          name: "decision_markdown",
                          label: "Decision summary",
                          type: "markdown",
                          required: true,
                        },
                      ]}
                      onDone={refresh}
                    />
                  </>
                )}
              </div>
            </Panel>
          </aside>
        </div>
      )}
      {kind === "tasks" && (
        <>
          <Panel title="Decision">
            <div className="panel-body">
              {data.decision_markdown ? (
                <Markdown source={text(data.decision_markdown)} />
              ) : (
                <p className="muted">No final decision has been recorded.</p>
              )}
            </div>
          </Panel>
          <TaskCoordination path={path} />
        </>
      )}
      {kind === "issues" && (
        <div className="stack">
          <ResourceCollection
            path={`${path}/dependencies`}
            spec={{
              title: "Dependencies",
              singular: "dependency",
              fields: [
                {
                  name: "depends_on_id",
                  label: "Depends on issue ID",
                  required: true,
                },
              ],
              columns: ["depends_on_id", "created_at"],
              edit: false,
            }}
            onChanged={refresh}
          />
          <ResourceCollection
            path={`${path}/pulls`}
            spec={{
              title: "Linked changes",
              singular: "linked pull request",
              fields: [
                { name: "pull_id", label: "Pull request ID", required: true },
                {
                  name: "closes_issue",
                  label: "Close issue when merged",
                  type: "checkbox",
                },
              ],
              columns: ["pull_id", "closes_issue", "created_at"],
              edit: false,
            }}
            onChanged={refresh}
          />
        </div>
      )}
      <DocumentHistory path={path} snapshot={item.snapshot} refresh={refresh} />
    </>
  );
}

function Comment({
  comment,
  path,
  refresh,
  discussion,
}: {
  comment: Entity;
  path: string;
  refresh: () => void;
  discussion?: {
    path: string;
    snapshot: ReturnType<typeof useResource<Entity>>["snapshot"];
    accepted: boolean;
  };
}) {
  const author = useAttribution(comment);
  return (
    <article
      id={`comment-${comment.id}`}
      className={`comment ${discussion?.accepted ? "comment-accepted" : ""}`}
    >
      <header>
        <Avatar name={author.name} url={author.avatar} small decorative />
        <strong className="comment-author" title={author.detail}>
          {author.name}
        </strong>
        <Time value={comment.created_at} />
        {discussion?.accepted && <Badge tone="green">Accepted answer</Badge>}
        <div className="row-actions">
          <EditResource
            path={path}
            title="Edit comment"
            fields={[{ ...markdownField, label: "Comment", required: true }]}
            onSaved={refresh}
          />
          <ActionButton
            path={path}
            label="Delete"
            method="DELETE"
            danger
            description="Delete this comment from the conversation."
            onDone={refresh}
          />
        </div>
      </header>
      {comment.anchor !== undefined && (
        <details>
          <summary>Original anchor</summary>
          <JsonDetails value={comment.anchor} />
        </details>
      )}
      <Markdown source={text(comment.body || comment.body_markdown)} />
      <div className="row-actions">
        <CreateResource
          path={path.replace(/\/[^/]+$/, "")}
          title="Reply"
          fields={[
            { name: "body", label: "Reply", type: "markdown", required: true },
          ]}
          transform={(body) => ({
            ...body,
            parent_id: comment.id,
            ...(comment.review_thread_id
              ? { review_thread_id: comment.review_thread_id }
              : {}),
          })}
          onSaved={refresh}
        />
        <ActionButton
          path={`${path}/moderation`}
          snapshot={revisionSnapshot(comment)}
          method="PUT"
          label={
            comment.state === "hidden" ? "Restore comment" : "Hide comment"
          }
          body={{ state: comment.state === "hidden" ? "visible" : "hidden" }}
          fields={[
            { name: "reason", label: "Moderation reason", required: true },
          ]}
          onDone={refresh}
        />
      </div>
      {discussion && !discussion.accepted && (
        <ActionButton
          path={`${discussion.path}/answer`}
          snapshot={discussion.snapshot}
          label="Accept answer"
          method="POST"
          body={{ comment_id: comment.id }}
          onDone={refresh}
        />
      )}
      {discussion?.accepted && (
        <ActionButton
          path={`${discussion.path}/answer`}
          snapshot={discussion.snapshot}
          label="Clear accepted answer"
          method="PUT"
          body={{ comment_id: null }}
          onDone={refresh}
        />
      )}
    </article>
  );
}

function AttachmentPanel({ path }: { path: string }) {
  const attachments = useCollection<Entity>(`${path}/attachments`);
  const [file, setFile] = useState<File | null>(null);
  const mutation = useMutation();
  const [reservation, setReservation] = useState<Snapshot<Entity> | null>(null);
  const [uploading, setUploading] = useState(false);
  return (
    <Panel title="Attachments">
      <div className="panel-body">
        <ErrorNotice error={attachments.error} retry={attachments.refresh} />
        {attachments.items.map((item) => (
          <p key={item.id}>
            <DownloadButton
              path={`${path}/attachments/${encodeURIComponent(item.id)}/content`}
              name={text(item.filename, displayName(item))}
            >
              {text(item.filename, displayName(item))}
            </DownloadButton>
            <span className="muted"> {text(item.bytes)} bytes</span>
            <Status value={item.state} />
            <ActionButton
              path={`${path}/attachments/${item.id}`}
              snapshot={revisionSnapshot(item)}
              label="Remove attachment"
              method="DELETE"
              danger
              onDone={attachments.refresh}
            />
          </p>
        ))}
        <form
          className="attachment-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!file) return;
            const form = event.currentTarget;
            setUploading(true);
            void (async () => {
              try {
                if (file.size > 16 * 1024 * 1024)
                  throw new Error("Attachments may contain at most 16 MiB.");
                let reserved = reservation;
                if (!reserved) {
                  const digest = await crypto.subtle.digest(
                    "SHA-256",
                    await file.arrayBuffer(),
                  );
                  const sha256 = [...new Uint8Array(digest)]
                    .map((byte) => byte.toString(16).padStart(2, "0"))
                    .join("");
                  reserved = await mutation.run<Entity>(`${path}/attachments`, {
                    method: "POST",
                    body: {
                      filename: file.name,
                      content_type: file.type || "application/octet-stream",
                      bytes: file.size,
                      sha256,
                    },
                  });
                  if (!reserved) return;
                  setReservation(reserved);
                } else
                  reserved = await request<Entity>(
                    `${path}/attachments/${reserved.data.id}`,
                  );
                const result =
                  reserved.data.state === "ready"
                    ? reserved
                    : await mutation.run<Entity>(
                        `${path}/attachments/${reserved.data.id}/content`,
                        {
                          method: "PUT",
                          body: file,
                          etag: requireEtag(reserved),
                        },
                      );
                if (result) {
                  setFile(null);
                  setReservation(null);
                  form.reset();
                  attachments.refresh();
                }
              } catch (cause) {
                mutation.setError(
                  cause instanceof Error
                    ? cause
                    : new Error("Attachment upload failed."),
                );
              } finally {
                setUploading(false);
              }
            })();
          }}
        >
          <label className="field">
            Attach a file
            <input
              type="file"
              onChange={(event) => {
                setFile(event.target.files?.[0] || null);
                setReservation(null);
              }}
              required
            />
          </label>
          <Button
            type="submit"
            busy={mutation.pending || uploading}
            disabled={!file}
          >
            Upload attachment
          </Button>
          <ErrorNotice error={mutation.error} />
        </form>
      </div>
    </Panel>
  );
}

function DocumentHistory({
  path,
  snapshot,
  refresh,
}: {
  path: string;
  snapshot: Snapshot<Entity> | null;
  refresh: () => void;
}) {
  const versions = useCollection<Entity>(`${path}/versions`);
  return (
    <Panel
      title="Document history"
      description="Every canonical Markdown revision remains inspectable and restorable."
    >
      <ErrorNotice error={versions.error} retry={versions.refresh} />
      {versions.items.map((version) => (
        <details className="patch-row" key={version.id}>
          <summary>
            Revision {text(version.document_revision)} ·{" "}
            {text(version.created_at)}
          </summary>
          <Markdown source={text(version.markdown)} />
          <Metadata
            values={{
              sha256: version.sha256,
              actor: version.actor_id,
              restored_from: version.restored_from,
            }}
          />
          <ActionButton
            path={`${path}/restore`}
            snapshot={snapshot}
            label="Restore this revision"
            description="Restore this canonical source as a new revision, retaining the existing history."
            body={{ document_revision: version.document_revision }}
            onDone={refresh}
          />
        </details>
      ))}
      <Pagination {...versions} />
    </Panel>
  );
}

function PullActions({
  path,
  item,
  snapshot,
  refresh,
}: {
  path: string;
  item: Entity;
  snapshot: ReturnType<typeof useResource<Entity>>["snapshot"];
  refresh: () => void;
}) {
  return (
    <>
      {item.draft === true && (
        <ActionButton
          path={path}
          snapshot={snapshot}
          label="Ready for review"
          method="PATCH"
          body={{ state: "open" }}
          onDone={refresh}
        />
      )}
      <CreateResource
        path={`${path}/review-requests`}
        title="Request review"
        fields={[
          {
            name: "reviewer_ids",
            label: "Reviewer IDs",
            type: "csv",
            required: true,
          },
        ]}
        onSaved={refresh}
      />
      <ActionButton
        path={`${path}/reviews`}
        snapshot={snapshot}
        label="Submit review"
        fields={[
          {
            name: "decision",
            label: "Decision",
            type: "select",
            required: true,
            options: ["comment", "approve", "request_changes"],
          },
          {
            name: "patch_id",
            label: "Patch version",
            default: item.patch_version_id || item.current_patch_id,
            required: true,
          },
          { name: "body", label: "Review summary", type: "markdown" },
          {
            name: "scope",
            label: "Review scope",
            type: "select",
            options: ["all", "files"],
            default: "all",
            required: true,
          },
          {
            name: "paths",
            label: "Reviewed paths (file-scoped reviews)",
            type: "csv",
          },
        ]}
        onDone={refresh}
      />
      <ActionButton
        path={`${path}/merge-queue`}
        snapshot={snapshot}
        label="Add to merge queue"
        description="The merge queue builds and verifies the exact candidate against the current target."
        fields={[
          {
            name: "strategy",
            label: "Merge strategy",
            type: "select",
            default: "merge",
            options: ["merge", "squash", "rebase"],
            required: true,
          },
        ]}
        onDone={refresh}
      />
      <ActionButton
        path={`${path}/restack`}
        snapshot={snapshot}
        label="Restack"
        description="Restack this change on its current dependencies. Changed patches may invalidate reviews and verification."
        fields={[
          { name: "onto_oid", label: "New base commit", required: true },
        ]}
        onDone={refresh}
      />
      <ActionButton
        path={path}
        snapshot={snapshot}
        label={
          item.state === "closed" ? "Reopen pull request" : "Close pull request"
        }
        method="PATCH"
        body={{ state: item.state === "closed" ? "open" : "closed" }}
        onDone={refresh}
      />
    </>
  );
}

function PullReviewContent({
  tab,
  path,
  item,
  refresh,
}: {
  tab: string;
  path: string;
  item: Entity;
  refresh: () => void;
}) {
  if (tab === "changes")
    return <PullChanges path={path} item={item} refresh={refresh} />;
  if (tab === "patches") return <PatchHistory path={path} />;
  if (tab === "checks") return <PullChecks path={path} />;
  return (
    <ResourceCollection
      path={`${path}/dependencies`}
      spec={{
        title: "Dependencies",
        singular: "dependency",
        fields: [
          {
            name: "depends_on_id",
            label: "Depends on pull request ID",
            required: true,
          },
        ],
        columns: ["depends_on_id", "created_at"],
        edit: false,
      }}
      onChanged={refresh}
    />
  );
}

function PullChanges({
  path,
  item,
  refresh,
}: {
  path: string;
  item: Entity;
  refresh: () => void;
}) {
  const [since, setSince] = useState("");
  const patches = useCollection<Entity>(`${path}/patches`);
  const changes = useResource<Entity>(
    query(`${path}/diff`, { since_patch: since }),
  );
  const threads = useCollection<Entity>(`${path}/threads`);
  const suggestions = useCollection<Entity>(`${path}/suggestions`);
  const impact = useResource<Entity>(
    since ? query(`${path}/compare`, { from_patch: since }) : null,
  );
  const refreshAll = () => {
    threads.refresh();
    suggestions.refresh();
    refresh();
  };
  return (
    <>
      <div className="filter-bar">
        <label>
          Changes since{" "}
          <select
            value={since}
            onChange={(event) => setSince(event.target.value)}
            aria-label="Compare patch versions"
          >
            <option value="">Base revision</option>
            {patches.items.map((patch) => (
              <option key={patch.id} value={patch.id}>
                Patch {text(patch.number || patch.version, patch.id)}
              </option>
            ))}
          </select>
        </label>
        <Badge>
          Current patch {text(item.patch_version_id || item.current_patch_id)}
        </Badge>
      </div>
      <ErrorNotice error={patches.error} retry={patches.refresh} />
      <Pagination {...patches} />
      <ErrorNotice error={impact.error} retry={impact.refresh} />
      {impact.data && (
        <Panel title="Changes since this review">
          <div className="panel-body">
            <Metadata
              values={{
                unchanged_patch: impact.data.unchanged_patch,
                changed_paths: impact.data.changed_paths,
              }}
            />
            <JsonDetails
              title="Review preservation and invalidation"
              value={impact.data.reviews}
            />
          </div>
        </Panel>
      )}
      <ErrorNotice error={changes.error} retry={changes.refresh} />
      {changes.loading && !changes.data ? (
        <Loading />
      ) : (
        changes.data && (
          <DiffViewer
            data={changes.data}
            review={{
              path,
              patchId: text(item.patch_version_id || item.current_patch_id),
              headOid: text(item.head_oid),
              oldPatchId: since || undefined,
              refresh: refreshAll,
            }}
          />
        )
      )}
      <Panel title="Review threads">
        <ErrorNotice error={threads.error} retry={threads.refresh} />
        {threads.items.map((thread) => (
          <ReviewThread
            key={thread.id}
            path={path}
            thread={thread}
            item={item}
            refresh={refreshAll}
          />
        ))}
        {!threads.items.length && !threads.loading && !threads.error && (
          <Empty
            title="No review threads"
            description="Select a line in the diff to leave a revision-anchored comment or suggestion."
          />
        )}
        <Pagination {...threads} />
      </Panel>
      <Panel title="Suggested changes">
        <ErrorNotice error={suggestions.error} retry={suggestions.refresh} />
        {suggestions.items.map((suggestion) => (
          <article className="review-thread" key={suggestion.id}>
            <Status value={suggestion.state} />
            <Metadata
              values={{
                thread: suggestion.thread_id,
                patch: suggestion.patch_id,
              }}
            />
            <pre className="source-preview">{text(suggestion.replacement)}</pre>
            {["proposed", "failed"].includes(text(suggestion.state)) && (
              <div className="row-actions">
                <ActionButton
                  path={`${path}/suggestions/${suggestion.id}/apply`}
                  snapshot={revisionSnapshot(suggestion)}
                  label="Apply suggested change"
                  body={{ pull_revision: item.revision }}
                  fields={[
                    {
                      name: "message",
                      label: "Commit message",
                      default: "Apply suggested change",
                      required: true,
                    },
                  ]}
                  description="Publish this exact replacement through the canonical Git policy gate."
                  onDone={refreshAll}
                />
                <ActionButton
                  path={`${path}/suggestions/${suggestion.id}`}
                  snapshot={revisionSnapshot(suggestion)}
                  method="DELETE"
                  label="Reject suggestion"
                  onDone={refreshAll}
                />
              </div>
            )}
          </article>
        ))}
        <Pagination {...suggestions} />
      </Panel>
    </>
  );
}

function ReviewThread({
  path,
  thread,
  item,
  refresh,
}: {
  path: string;
  thread: Entity;
  item: Entity;
  refresh: () => void;
}) {
  const comments = useCollection<Entity>(
    query(`${path}/comments`, { review_thread_id: thread.id }),
  );
  const reload = () => {
    comments.refresh();
    refresh();
  };
  return (
    <article className="review-thread">
      <header>
        <code>
          {text(thread.path)}:{text(thread.start_line)}–{text(thread.end_line)}
        </code>
        <Status value={thread.resolved_at ? "resolved" : "open"} />
        {thread.outdated === true || thread.outdated === 1 ? (
          <Badge tone="amber">Earlier patch</Badge>
        ) : null}
        <ActionButton
          path={`${path}/threads/${thread.id}`}
          snapshot={revisionSnapshot(thread)}
          method="PATCH"
          label={thread.resolved_at ? "Reopen thread" : "Resolve thread"}
          body={{ resolved: !thread.resolved_at }}
          onDone={reload}
        />
      </header>
      <Metadata
        values={{
          patch: thread.patch_id,
          side: thread.side,
          anchor_fingerprint: thread.anchor_fingerprint,
        }}
      />
      <ErrorNotice error={comments.error} retry={comments.refresh} />
      {comments.items.map((comment) => (
        <Comment
          key={comment.id}
          comment={comment}
          path={`${path}/comments/${comment.id}`}
          refresh={reload}
        />
      ))}
      <Pagination {...comments} />
      <div className="row-actions">
        <CreateResource
          path={`${path}/comments`}
          title="Reply to thread"
          fields={[
            { name: "body", label: "Reply", type: "markdown", required: true },
          ]}
          transform={(body) => ({ ...body, review_thread_id: thread.id })}
          onSaved={reload}
        />
        {thread.side === "new" && !thread.resolved_at && !thread.outdated && (
          <CreateResource
            path={`${path}/suggestions`}
            title="Suggest a change"
            fields={[
              {
                name: "replacement",
                label: "Replacement source",
                type: "textarea",
                help: "Replace the exact anchored line range. Empty source deletes those lines.",
              },
            ]}
            transform={(body) => ({
              replacement: body.replacement || "",
              thread_id: thread.id,
            })}
            onSaved={reload}
          />
        )}
      </div>
    </article>
  );
}

function PatchHistory({ path }: { path: string }) {
  const patches = useCollection<Entity>(`${path}/patches`);
  return (
    <Panel
      title="Patch history"
      description="Comments and review decisions remain tied to the patch they reviewed."
    >
      <ErrorNotice error={patches.error} retry={patches.refresh} />
      {patches.items.map((patch) => (
        <article className="patch-row" key={patch.id}>
          <h3>Patch {text(patch.number || patch.version, patch.id)}</h3>
          <Metadata
            values={{
              head: patch.head_oid,
              base: patch.base_oid,
              created_at: patch.created_at,
              invalidated_reviews: patch.invalidated_reviews,
              preserved_reviews: patch.preserved_reviews,
            }}
          />
          <JsonDetails title="Patch evidence" value={patch} />
        </article>
      ))}
      <Pagination {...patches} />
    </Panel>
  );
}

function PullChecks({ path }: { path: string }) {
  const checks = useResource<Entity>(`${path}/merge-eligibility`);
  return (
    <Panel
      title="Merge eligibility"
      description="Required verification binds to the candidate, policy, workflow digest, and trusted producer."
    >
      <ErrorNotice error={checks.error} retry={checks.refresh} />
      {checks.loading && !checks.data ? (
        <Loading />
      ) : (
        checks.data && (
          <div className="panel-body">
            <Status
              value={
                checks.data.state ||
                (checks.data.eligible === true ? "approved" : "blocked")
              }
            />
            <Metadata
              values={{
                candidate: checks.data.candidate_oid,
                policy_revision: checks.data.policy_revision,
                queue_position: checks.data.queue_position,
                queue_reason: checks.data.queue_reason,
              }}
            />
            {array<Entity>(checks.data.requirements || checks.data.checks).map(
              (check, index) => (
                <article className="requirement-row" key={check.id || index}>
                  <Status value={check.state || check.status} />
                  <div>
                    <strong>{displayName(check)}</strong>
                    <p>{text(check.reason || check.explanation)}</p>
                    <Metadata
                      values={{
                        producer: check.producer_id,
                        workflow_digest: check.workflow_digest,
                        commit: check.commit_oid,
                      }}
                    />
                  </div>
                </article>
              ),
            )}
            <JsonDetails
              title="Complete policy explanation"
              value={checks.data}
            />
          </div>
        )
      )}
    </Panel>
  );
}

function TaskCoordination({ path }: { path: string }) {
  return (
    <div className="stack">
      <ResourceCollection
        path={`${path}/claims`}
        spec={{
          title: "Work claims",
          singular: "claim",
          description:
            "Expiring claims make overlapping work visible without locking the repository.",
          fields: [
            {
              name: "description",
              label: "Intended work",
              type: "textarea",
              required: true,
            },
            {
              name: "paths",
              label: "Intended paths",
              type: "csv",
              required: true,
              help: "Literal repository path prefixes, separated by commas.",
            },
            {
              name: "lease_seconds",
              label: "Lease duration (seconds)",
              type: "number",
              default: 300,
              min: 30,
              max: 3600,
              required: true,
            },
          ],
          columns: ["principal_id", "paths", "expires_at"],
          edit: false,
        }}
        actions={(claim, refresh) => (
          <ActionButton
            path={`${path}/claims/${claim.id}/heartbeat`}
            snapshot={revisionSnapshot(claim)}
            resourcePath={`${path}/claims/${claim.id}`}
            label="Renew claim"
            onDone={refresh}
          />
        )}
      />
      <ResourceCollection
        path={`${path}/workspaces`}
        spec={{
          title: "Workspaces",
          singular: "workspace",
          description:
            "Private workspaces retain the base revision and expire under a visible retention policy.",
          fields: [
            { name: "name", label: "Name", required: true },
            { name: "owner_id", label: "Destination account ID (optional)" },
            {
              name: "principal_id",
              label: "Contributor principal ID (optional)",
            },
            {
              name: "retention_days",
              label: "Retention (days)",
              type: "number",
              default: 14,
              min: 1,
              max: 90,
              required: true,
            },
          ],
          columns: [
            "workspace_repo_id",
            "state",
            "base_oid",
            "retention_until",
          ],
          editFields: [
            {
              name: "retention_days",
              label: "Retention (days)",
              type: "number",
              default: 14,
              min: 1,
              max: 90,
              required: true,
            },
          ],
          rowPath: (workspace) => repoLink(text(workspace.workspace_repo_id)),
        }}
      />
      <ResourceCollection
        path={`${path}/proposals`}
        spec={{
          title: "Proposals and evidence",
          singular: "proposal",
          fields: [
            { name: "pull_id", label: "Pull request ID", required: true },
            {
              name: "summary_markdown",
              label: "Proposal summary",
              type: "markdown",
              required: true,
            },
            { name: "evidence_markdown", label: "Evidence", type: "markdown" },
          ],
          editFields: [
            {
              name: "summary_markdown",
              label: "Proposal summary",
              type: "markdown",
              required: true,
            },
            { name: "evidence_markdown", label: "Evidence", type: "markdown" },
            {
              name: "disposition",
              label: "Disposition",
              type: "select",
              options: ["proposed", "accepted", "abandoned"],
              required: true,
            },
          ],
          columns: ["pull_id", "disposition", "updated_at"],
          allowDelete: false,
        }}
      />
    </div>
  );
}

export function IssueManagementPage() {
  const { repo } = useRepository();
  return (
    <>
      <PageHeader
        title="Issue organization"
        description="Shared labels, milestones, templates, and saved views for this repository."
      />
      <div className="stack">
        <ResourceCollection
          path={endpoints.repo(repo.id, "labels")}
          spec={{
            title: "Labels",
            singular: "label",
            fields: [
              { name: "name", label: "Name", required: true },
              { name: "description", label: "Description" },
              {
                name: "color",
                label: "Color",
                default: "#237b5b",
                required: true,
              },
            ],
            columns: ["name", "description", "color"],
          }}
        />
        <ResourceCollection
          path={endpoints.repo(repo.id, "milestones")}
          spec={{
            title: "Milestones",
            singular: "milestone",
            fields: [
              titleField,
              { ...markdownField, required: true },
              { name: "due_at", label: "Due date", type: "datetime-local" },
              {
                name: "state",
                label: "State",
                type: "select",
                options: ["open", "closed"],
                default: "open",
              },
            ],
            columns: ["title", "state", "due_at"],
          }}
        />
        <ResourceCollection
          path={endpoints.repo(repo.id, "issue-templates")}
          spec={{
            title: "Issue templates",
            singular: "template",
            fields: [
              { name: "name", label: "Name", required: true },
              titleField,
              markdownField,
            ],
            columns: ["name", "title", "updated_at"],
            createTransform: (body) => ({ ...body, body: text(body.body) }),
          }}
        />
        <ResourceCollection
          path={endpoints.repo(repo.id, "issues/statuses")}
          spec={{
            title: "Typed statuses",
            singular: "status",
            fields: [
              { name: "name", label: "Name", required: true },
              {
                name: "type",
                label: "Status type",
                type: "select",
                options: [
                  "backlog",
                  "open",
                  "in_progress",
                  "blocked",
                  "done",
                  "cancelled",
                ],
                required: true,
              },
              {
                name: "color",
                label: "Six-digit color",
                default: "808080",
                required: true,
              },
              {
                name: "position",
                label: "Sort position",
                type: "number",
                min: 0,
                default: 0,
              },
            ],
            columns: ["name", "type", "color"],
          }}
        />
        <ResourceCollection
          path={endpoints.repo(repo.id, "saved-filters")}
          spec={{
            title: "Saved filters",
            singular: "filter",
            fields: [
              { name: "name", label: "Name", required: true },
              { name: "query", label: "Search query", required: true },
            ],
            columns: ["name", "query"],
          }}
        />
      </div>
    </>
  );
}

export function DiscussionCategoriesPage() {
  const { repo } = useRepository();
  return (
    <>
      <PageHeader title="Discussion categories" />
      <ResourceCollection
        path={endpoints.repo(repo.id, "discussion-categories")}
        spec={{
          title: "Categories",
          singular: "category",
          fields: [
            { name: "name", label: "Name", required: true },
            { name: "description", label: "Description" },
            {
              name: "format",
              label: "Format",
              type: "select",
              options: ["discussion", "question", "announcement"],
              default: "question",
              required: true,
            },
          ],
          columns: ["name", "description", "format"],
        }}
      />
    </>
  );
}
