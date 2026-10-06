import { array, record, text } from "./types.ts";

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** Explicit translations between presentation names and the published product modules. */
export function adaptRequest(
  originalPath: string,
  originalMethod: Method,
  input: unknown,
) {
  const url = new URL(originalPath, "https://gitknot.invalid");
  let path = url.pathname;
  let method = originalMethod;
  let body = input;
  const authAliases: Record<string, string> = {
    "/v1/auth/security": "/v1/auth/mfa",
    "/v1/auth/mfa/setup": "/v1/auth/mfa/totp/setup",
    "/v1/auth/mfa/enable": "/v1/auth/mfa/totp/verify",
    "/v1/auth/mfa/verify": "/v1/auth/login/mfa",
    "/v1/auth/passkeys/register/options":
      "/v1/auth/passkeys/registration/options",
    "/v1/auth/passkeys/register/verify":
      "/v1/auth/passkeys/registration/verify",
  };
  path = authAliases[path] || path;
  if (path === "/v1/repos/imports" && method === "POST") {
    const { source_url, source_secret_id, ...rest } = record(body);
    body = {
      ...rest,
      import: { source_url, ...(source_secret_id ? { source_secret_id } : {}) },
    };
    path = "/v1/repos";
  }
  const fork = /^\/v1\/repos\/([^/]+)\/forks$/.exec(path);
  if (fork && method === "POST") {
    body = { ...record(body), fork_source_id: fork[1] };
    path = "/v1/repos";
  }
  if (/^\/v1\/repos\/[^/]+\/unarchive$/.test(path)) {
    path = path.replace(/unarchive$/, "archive");
    method = "DELETE";
    body = undefined;
  }
  if (/\/transfers\/[^/]+\/cancel$/.test(path)) {
    path = path.replace(/\/cancel$/, "");
    method = "DELETE";
    body = undefined;
  }
  path = path.replace(/\/service-identities(?=\/|$)/, "/identities");
  const repositoryToken =
    /^\/v1\/repos\/([^/]+)\/(tokens|viewer-grants)(\/[^/]+(?:\/rotate)?)?$/.exec(
      path,
    );
  if (repositoryToken) {
    path = `/v1/tokens${repositoryToken[3] || ""}`;
    if (method === "POST" && !repositoryToken[3])
      body = {
        ...record(body),
        repository_ids: [repositoryToken[1]],
        ...(repositoryToken[2] === "viewer-grants"
          ? {
              kind: "viewer",
              account_ids: [],
              capabilities: [
                "contents.read",
                "repositories.read",
                "issues.read",
                "pull_requests.read",
                "discussions.read",
                "runs.read",
                "workflows.read",
                "search.read",
                "attachments.read",
              ],
            }
          : {}),
      };
  }
  const workflowRun = /^\/v1\/repos\/([^/]+)\/workflows\/([^/]+)\/runs$/.exec(
    path,
  );
  if (
    method === "GET" &&
    /^\/v1\/repos\/[^/]+\/runs$/.test(path) &&
    url.searchParams.has("state")
  ) {
    const state = url.searchParams.get("state");
    url.searchParams.delete("state");
    if (state && state !== "all")
      url.searchParams.set(
        "status",
        state === "passed"
          ? "succeeded"
          : state === "awaiting_approval"
            ? "waiting_approval"
            : state,
      );
  }
  if (workflowRun && method === "POST") {
    const input = record(body);
    path = `/v1/repos/${workflowRun[1]}/runs`;
    body = {
      workflow_id: workflowRun[2],
      commit: input.commit_oid,
      ref: input.ref,
      event: { type: "workflow.manual", inputs: input.inputs || {} },
    };
  }
  path = path.replace(
    /^\/v1\/repos\/[^/]+\/runs\/([^/]+)(.*)$/,
    "/v1/runs/$1$2",
  );
  path = path.replace(/^(\/v1\/runs\/[^/]+\/outputs\/[^/]+)\/download$/, "$1");
  if (
    /^\/v1\/repos\/[^/]+\/(?:workflows|environments)\/[^/]+$/.test(path) &&
    method === "PATCH"
  )
    method = "PUT";
  path = path.replace(
    /^\/v1\/(?:accounts|repos)\/[^/]+\/runner-pools\/([^/]+)(.*)$/,
    "/v1/runner-pools/$1$2",
  );
  const enrollment = /^\/v1\/runner-pools\/([^/]+)\/enrollments$/.exec(path);
  if (enrollment) {
    body = {
      pool_id: enrollment[1],
      expires_in_seconds: record(body).expires_in_seconds,
    };
    path = "/v1/runner-enrollments";
  }
  path = path.replace(
    /^\/v1\/accounts\/([^/]+)\/(members|teams|invitations)(?=\/|$)/,
    "/v1/orgs/$1/$2",
  );
  if (/^\/v1\/accounts\/org_[^/]+$/.test(path) && method !== "GET")
    path = path.replace("/v1/accounts/", "/v1/orgs/");
  path = path.replace(
    /^(\/v1\/accounts\/[^/]+)\/billing\/(usage|budgets|invoices|statements|subscription|credits)(?=\/|$)/,
    "$1/$2",
  );
  path = path.replace(
    /(\/v1\/accounts\/[^/]+)\/billing\/execution-control$/,
    "$1/billing",
  );
  path = path.replace(
    /(\/v1\/accounts\/[^/]+)\/invoices\/([^/]+)\/download$/,
    "$1/statements/$2/download",
  );
  if (/\/subscription\/cancel$/.test(path)) {
    path = path.replace(/\/cancel$/, "");
    method = "PATCH";
    body = { state: "cancelled" };
  }
  if (
    /\/subscription$/.test(path) &&
    method === "PATCH" &&
    record(body).plan_id
  )
    method = "PUT";
  const webhook = /^\/v1\/repos\/([^/]+)\/webhooks\/([^/]+)(.*)$/.exec(path);
  if (webhook) {
    const tail = webhook[3] || "";
    const delivery = /^\/deliveries\/([^/]+)(.*)$/.exec(tail);
    path = delivery
      ? `/v1/deliveries/${delivery[1]}${delivery[2]}`
      : `/v1/webhooks/${webhook[2]}${tail.replace("/rotate-secret", "/keys")}`;
    if (tail === "/replay") {
      path = "/v1/events/replay";
      const previous = record(body);
      body = {
        repo_id: webhook[1],
        webhook_id: webhook[2],
        since: previous.from,
        until: previous.to,
      };
    }
  }
  if (url.searchParams.has("since_patch")) {
    url.searchParams.set("from_patch", url.searchParams.get("since_patch")!);
    url.searchParams.delete("since_patch");
  }
  if (path === "/v1/auth/password" && method === "POST") method = "PUT";
  path = path
    .replace(/\/issue-templates(?=\/|$)/, "/issues/templates")
    .replace(/\/discussion-categories(?=\/|$)/, "/discussions/categories");
  path = path.replace(
    /(\/(?:issues|pulls|discussions|tasks)\/[^/]+)\/events$/,
    "$1/history",
  );
  path = path.replace(/\/convert-to-issue$/, "/convert");
  if (/^\/v1\/repos\/[^/]+\/diffs$/.test(path))
    path = path.replace(/diffs$/, "diff");
  if (
    /^\/v1\/repos\/[^/]+\/(?:diff|compare)$/.test(path) &&
    url.searchParams.has("head")
  ) {
    url.searchParams.set("ref", url.searchParams.get("head")!);
    url.searchParams.delete("head");
  }
  if (/\/discussions\/[^/]+\/answer$/.test(path) && method === "POST")
    method = "PUT";
  if (path.startsWith("/v1/search/scans"))
    path = path.replace("/v1/search/scans", "/v1/search/code-scans");
  if (path === "/v1/search/saved") path = "/v1/saved-filters";
  if (path === "/v1/feed" && url.searchParams.has("type")) {
    url.searchParams.set("kind", url.searchParams.get("type")!);
    url.searchParams.delete("type");
  }
  if (path === "/v1/inbox") {
    const state = url.searchParams.get("state");
    if (state === "open") url.searchParams.set("state", "outstanding");
    if (state === "resolved") url.searchParams.set("state", "completed");
    if (state === "snoozed") {
      url.searchParams.set("state", "outstanding");
      url.searchParams.set("include_snoozed", "true");
    }
  } else if (url.searchParams.get("state") === "all")
    url.searchParams.delete("state");
  if (path === "/v1/search") {
    const type = url.searchParams.get("type");
    const kinds: Record<string, string> = {
      issues: "issue",
      pulls: "pull_request",
      discussions: "discussion",
      tasks: "task",
      comments: "comment",
    };
    if (type && kinds[type]) url.searchParams.set("kind", kinds[type]!);
    if (type === "repositories") path = "/v1/repos";
    if (type === "users") path = "/v1/users";
    url.searchParams.delete("type");
  }
  const savedScope = /^\/v1\/repos\/([^/]+)\/saved-filters(\/[^/]+)?$/.exec(
    path,
  );
  if (savedScope) {
    path = `/v1/saved-filters${savedScope[2] || ""}`;
    if (method === "POST")
      body = { ...record(body), repo_id: savedScope[1], surface: "issues" };
  }
  if (url.searchParams.has("label_id")) {
    url.searchParams.set("label", url.searchParams.get("label_id")!);
    url.searchParams.delete("label_id");
  }
  if (url.searchParams.has("assignee_id")) {
    url.searchParams.set("assignee", url.searchParams.get("assignee_id")!);
    url.searchParams.delete("assignee_id");
  }
  if (
    body &&
    typeof body === "object" &&
    !(body instanceof Blob) &&
    !(body instanceof FormData)
  ) {
    const next = { ...record(body) };
    if (/^\/v1\/saved-filters(?:\/[^/]+)?$/.test(path) && "query" in next) {
      next.filters = { query: next.query };
      delete next.query;
      if (method === "POST") next.surface ||= "search";
    }
    if (/\/(?:orgs|repos)\/[^/]+\/invitations$/.test(path) && next.expires_at) {
      next.expires_in_seconds = Math.floor(
        (Date.parse(text(next.expires_at)) - Date.now()) / 1000,
      );
      delete next.expires_at;
    }
    if (
      /^\/v1\/repos\/[^/]+\/(issues|pulls|discussions|tasks|milestones)/.test(
        path,
      ) &&
      "body" in next
    ) {
      next.markdown = next.body;
      delete next.body;
    }
    if (
      /^\/v1\/repos\/[^/]+\/labels(?:\/[^/]+)?$/.test(path) &&
      typeof next.color === "string"
    )
      next.color = next.color.replace(/^#/, "");
    if (path === "/v1/auth/login" && "email" in next) {
      next.login = next.email;
      delete next.email;
    }
    if (path === "/v1/auth/login/mfa" && "challenge_id" in next) {
      next.token = next.challenge_id;
      delete next.challenge_id;
    }
    if (path === "/v1/auth/password" && "new_password" in next) {
      next.password = next.new_password;
      delete next.new_password;
    }
    if (path === "/v1/auth/passkeys/registration/verify") {
      next.token = next.challenge_id;
      next.response = next.credential;
      delete next.challenge_id;
      delete next.credential;
      delete next.name;
    }
    if (
      path === "/v1/auth/mfa/totp/setup" ||
      path === "/v1/auth/mfa/recovery-codes"
    ) {
      body = {};
      return { path, method, body };
    }
    if (path === "/v1/auth/mfa/totp/verify") delete next.challenge_id;
    if (
      /^\/v1\/accounts\/[^/]+\/billing$/.test(path) &&
      method === "PATCH" &&
      "paused" in next
    ) {
      next.stopped = next.paused;
      delete next.paused;
    }
    if (/\/roles\/[^/]+$/.test(path) && method === "PATCH") method = "PUT";
    if (
      /\/(?:rules|collaborators|applications)\/[^/]+$/.test(path) &&
      method === "PATCH"
    )
      method = "PUT";
    if (/^\/v1\/repos\/[^/]+\/restore$/.test(path) && next.export_id) {
      next.archive_id = next.export_id;
      delete next.export_id;
    }
    if (
      /\/(?:secrets|variables)\/[^/]+$/.test(path) &&
      method === "PATCH" &&
      "value" in next
    )
      method = "PUT";
    if (
      /\/roles(?:\/[^/]+)?$/.test(path) &&
      Array.isArray(next.capabilities) &&
      next.capabilities.every((value) => typeof value === "string")
    ) {
      next.capabilities = [
        ...next.capabilities.map((capability) => ({
          capability,
          effect: "allow",
        })),
        ...array<string>(next.denials).map((capability) => ({
          capability,
          effect: "deny",
        })),
      ];
      delete next.denials;
    }
    if (
      /\/pulls\/[^/]+\/reviews$/.test(path) &&
      next.decision === "request_changes"
    )
      next.decision = "changes_requested";
    if (
      /\/pulls\/[^/]+\/threads\/[^/]+$/.test(path) &&
      method === "PATCH" &&
      "state" in next
    ) {
      next.resolved = next.state === "resolved";
      delete next.state;
    }
    body = next;
  }
  return {
    path: `${path}${url.searchParams.size ? `?${url.searchParams}` : ""}`,
    method,
    body,
  };
}

export function adaptResponse(
  value: unknown,
  presentationPath?: string,
): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => adaptResponse(item));
  const source = record(value);
  const result: Record<string, unknown> = { ...source };
  for (const [key, item] of Object.entries(source))
    if (Array.isArray(item))
      result[key] = item.map((value) => adaptResponse(value));
  if (
    presentationPath?.startsWith("/v1/inbox?") &&
    new URL(presentationPath, "https://gitknot.invalid").searchParams.get(
      "state",
    ) === "snoozed"
  )
    result.items = array<Record<string, unknown>>(result.items).filter(
      (item) => Date.parse(text(item.snoozed_until)) > Date.now(),
    );
  if (source.item) {
    const item = record(source.item);
    result.title ||= item.title;
    result.kind ||= item.kind;
    result.item_id ||= item.id;
  }
  if (source.owner) result.owner_slug = record(source.owner).slug;
  if (source.plan) result.entitlements ||= record(source.plan).entitlements;
  if (source.included_usage_units !== undefined)
    result.included_usage = source.included_usage_units;
  if (source.operation && typeof source.operation === "object")
    result.operation_id ||= record(source.operation).id;
  if (source.config && typeof source.config === "object")
    result.target = record(source.config).target;
  if (
    presentationPath &&
    (/^\/v1\/repos(?:\?|$)/.test(presentationPath) ||
      (/^\/v1\/search\?/.test(presentationPath) &&
        new URL(presentationPath, "https://gitknot.invalid").searchParams.get(
          "type",
        ) === "repositories"))
  ) {
    const params = new URL(presentationPath, "https://gitknot.invalid")
      .searchParams;
    if (
      Array.isArray(result.items) &&
      (params.get("q") || params.get("visibility"))
    )
      result.items = array<Record<string, unknown>>(result.items).filter(
        (item) =>
          (!params.get("q") ||
            `${text(item.name)} ${text(item.description)}`
              .toLowerCase()
              .includes(params.get("q")!.toLowerCase())) &&
          (!params.get("visibility") ||
            item.visibility === params.get("visibility")),
      );
  }
  const tokenScope =
    presentationPath &&
    /^\/v1\/repos\/([^/]+)\/(tokens|viewer-grants)(?:\?|$)/.exec(
      presentationPath,
    );
  if (tokenScope && Array.isArray(result.items))
    result.items = array<Record<string, unknown>>(result.items).filter(
      (item) =>
        array<string>(item.repository_ids).includes(
          decodeURIComponent(tokenScope[1]!),
        ) &&
        (tokenScope[2] !== "viewer-grants" || item.kind === "viewer"),
    );
  if (source.filters) result.query = record(source.filters).query;
  if (typeof source.markdown === "string") result.body = source.markdown;
  if (source.accepted_comment_id !== undefined)
    result.accepted_answer_id = source.accepted_comment_id;
  if (source.locked_at !== undefined) result.locked = !!source.locked_at;
  if (source.otpauth_uri !== undefined) result.otpauth_url = source.otpauth_uri;
  if (
    (source.options !== undefined && source.token !== undefined) ||
    (source.mfa_required === true && source.token !== undefined)
  )
    result.challenge_id = source.token;
  if (source.totp_enabled !== undefined)
    result.mfa_enabled = source.totp_enabled;
  if (source.state === "draft" && source.current_patch_id !== undefined)
    result.draft = true;
  if (!source.id && source.principal_id) result.id = source.principal_id;
  if (!result.id && (source.oid || source.ref))
    result.id = source.ref || source.oid;
  if (typeof source.status === "string" && source.state === undefined)
    result.state = source.status;
  if (source.commit_sha !== undefined) result.commit_oid = source.commit_sha;
  if (source.job_key !== undefined) result.job_id = source.job_key;
  if (source.source_digest !== undefined) result.digest = source.source_digest;
  if (source.version && typeof source.version === "object") {
    const version = record(source.version);
    result.source = version.definition;
    result.source_commit = version.source_commit;
    result.definition_digest = version.definition_digest;
  }
  if (source.resolved_at !== undefined)
    result.state = source.resolved_at ? "resolved" : "open";
  if (source.measured_usage_units !== undefined)
    result.measured_amount = source.measured_usage_units;
  if (source.forecast_usage_units !== undefined)
    result.forecast_amount = source.forecast_usage_units;
  if (source.admission) {
    const admission = record(source.admission);
    const planBudget = array<Record<string, unknown>>(source.budgets).find(
      (budget) => budget.id === admission.plan_budget_id,
    );
    result.reserved_amount = planBudget?.reserved_units;
    result.execution_paused = admission.stopped;
  }
  if (Array.isArray(source.plans)) {
    result.items = source.plans.map((item) => adaptResponse(item));
    result.next_cursor = null;
  }
  if (source.payable_units !== undefined)
    result.total_amount = source.payable_units;
  if (source.monthly_base_units !== undefined)
    result.price_amount = source.monthly_base_units;
  for (const [from, to] of [
    ["limit_units", "limit_amount"],
    ["settled_units", "settled_amount"],
    ["reserved_units", "reserved_amount"],
    ["safety_buffer_units", "safety_buffer"],
    ["amount_units", "amount"],
    ["total_units", "total_amount"],
    ["scope", "scope_type"],
  ])
    if (source[from!] !== undefined) result[to!] = source[from!];
  if (source.last_status !== undefined)
    result.response_status = source.last_status;
  return result;
}

export function preconditionPath(path: string, method: Method): string | null {
  const base = path.split("?")[0]!;
  if (method === "GET") return null;
  const repository =
    /^(\/v1\/repos\/[^/]+)\/(?:archive|exports|transfers|restore|rule-bypasses|access-reviews|refs)$/.exec(
      base,
    );
  if (repository && method === "POST") return repository[1]!;
  if (
    /^\/v1\/auth\/(?:password|mfa(?:\/.*)?|passkeys\/registration\/verify)$/.test(
      base,
    )
  )
    return "/v1/me";
  const subject =
    /^(\/v1\/repos\/[^/]+\/(?:issues|pulls|discussions|tasks)\/[^/]+)\/(comments|attachments|dependencies|pulls|reviews|review-requests|patches|threads|suggestions|claims|workspaces|proposals|decisions)(?:\/[^/]+)?$/.exec(
      base,
    );
  if (subject && method === "POST") return subject[1]!;
  return null;
}
