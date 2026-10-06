# GitKnot CLI

The public executable is `gitknot`. It uses `https://api.gitknot.com`, authenticates with GitKnot identities, and uses `https://git.gitknot.com` for Git. Staging endpoints follow the same `api.staging.gitknot.com` / `git.staging.gitknot.com` convention.

## Install and build

```sh
npm install --global @gitknot/cli
gitknot --help
```

For a checkout of this monorepo:

```sh
npm run build --workspace @gitknot/cli
node packages/cli/dist/cli/src/index.js --help
npm pack --workspace @gitknot/cli
```

The npm package has a real `bin` entry, a Node shebang, executable permissions, and compiled JavaScript copies of the CLI, workflow compiler, and runner. Runtime installation requires Node 24 and the declared YAML/Zod/XML dependencies; it does not depend on TypeScript execution, sibling workspace paths, a development bundler, or cloud credentials. Git is required for clone, local workflows, and runner checkout.

## Authentication

```sh
gitknot auth login
gitknot auth status
gitknot auth setup-git
gitknot auth logout
```

Default login accepts a scoped token created in GitKnot account settings. The prompt does not echo the token. Automation can pipe a token using `gitknot auth login --with-token`, or supply `GITKNOT_TOKEN` for a single process. Tokens are verified through `/v1/tokens/current`; status prints metadata, never the value. Logout revokes the current credential through `/v1/auth/logout` and removes local storage. `--local-only` explicitly removes local authentication without a network request.

Security administration supports a recent human session:

```sh
gitknot auth login --username alice
# Noninteractive input is a private JSON document with login/password and,
# when required, code or recovery_code:
gitknot auth login --input /private/path/login.json
```

The client uses `/v1/auth/login` and `/v1/auth/login/mfa`, captures only the GitKnot session cookie, and supplies the exact GitKnot web origin plus `X-GitKnot-CSRF: 1` for cookie-authenticated mutations. Session credentials remain separate from bearer authentication on the wire. Use a scoped token for the Git credential helper.

Authentication is stored per API origin at `$XDG_CONFIG_HOME/gitknot/auth.json` (default `~/.config/gitknot/auth.json`), or `%APPDATA%/GitKnot` on Windows. `GITKNOT_CONFIG_DIR` overrides it. Files are owner-only, written atomically, and rejected if stored inside a Git workspace or through a symlink. POSIX credential files require mode `0600`; directories use `0700`. Windows state uses a current-user SID-only DACL, with inherited grants removed using `icacls`. No credential is placed in a Git remote URL or repository configuration.

`auth setup-git` discovers `git_origin` from the selected API's `/v1/meta`, records that API-to-Git origin binding in private CLI configuration, and installs a command-only helper for the exact Git scheme, host, and port. The helper checks the current advertised origin before releasing a scoped token. Git's `store` and `erase` messages do not change API authentication. `gitknot repo clone OWNER/NAME [DIRECTORY]` uses the authorized resolver's `clone_url`, validates it against the advertised Git origin, and uses the same helper. Both setup and clone disable HTTP redirects for their Git transport.

For explicitly enabled local development, API and Git ports remain distinct:

```sh
gitknot auth login --api-url http://localhost:8787 --allow-loopback-http
gitknot auth setup-git --api-url http://localhost:8787 --allow-loopback-http
gitknot repo clone YOUR_USERNAME/try-gitknot --api-url http://localhost:8787 --allow-loopback-http
```

The local API advertises `http://localhost:8788` as its Git origin. The generated helper retains the explicit loopback opt-in, so subsequent stock `git fetch` and `git push` can authenticate without putting credentials in the remote URL or command arguments. HTTP Git is permitted only for a literal loopback endpoint advertised by a local API with the opt-in; HTTPS remains the default for production and staging. A different Git host, scheme, or port receives no credential.

## Every API operation

```sh
gitknot api GET /v1/repos --paginate
gitknot api GET /v1/api-capabilities
gitknot api GET /openapi.json --output openapi.json
gitknot api PATCH /v1/repos/r_catalog/issues/issue_123 \
  --if-match '"7"' --field state=closed
gitknot api POST /v1/repos/r_catalog/exports \
  --idempotency-key export-2026-10-04 --input export.json --watch
```

`api [METHOD] PATH` supports GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS. The default is GET, or POST when a request body/fields are supplied. Paths are relative `/v1/...` paths, with `/openapi.json` also supported. Credentials are sent only to the configured origin; redirects and cross-origin request paths are rejected.

| Option | Behavior |
| --- | --- |
| `--input FILE` / `--input -` | JSON body from a file or stdin. |
| `--field key=value` | JSON-typed field; dot-separated nested keys supported. Arrays/objects use JSON values. |
| `--raw-field key=value` | An exact string, useful for decimal monetary quantities. |
| `--query key=value` | Repeatable query parameters. GET semantic fields become query parameters. |
| `--header 'Name: value'` | Additional headers; authentication/host/cookie headers are managed by the client. |
| `--if-match '"7"'` | Preserve the API's strong revision precondition. Stale writes fail instead of being silently refreshed. |
| `--idempotency-key KEY` | Reuse the same key/body for uncertain creates/operations. A key is otherwise generated for a mutation. |
| `--include` | Include HTTP status and safe response headers such as ETag/request ID. Cookie/token headers are omitted. |
| `--paginate` | Emit each complete cursor page as JSON Lines, preserving freshness/coverage metadata. Repeated cursors and limits fail explicitly. |
| `--limit`, `--cursor`, `--max-pages` | Cursor navigation and a finite pagination bound. |
| `--binary --input FILE` | Stream exact binary request bytes, e.g. a reserved upload. Set Content-Type with `--header` when needed. |
| `--output FILE` | Stream response bytes into an atomically written file. |
| `--sha256 DIGEST --size BYTES` | Verify an exact binary download against its authorized manifest. |
| `--watch` | Poll an operation/run through a terminal outcome, including approvals/waiting states. Failed verification/operations exit nonzero. |
| `--timeout SECONDS`, `--max-bytes BYTES` | Bounded requests, watching, uploads/downloads, and paginated output. |

An API response is preserved as JSON or text. `--json` uses compact JSON. Cursor pages retain `items` and `next_cursor`, not an unlabeled partial concatenation. Binary transfers print their actual checksum and size after completion. `202` is acceptance, not success; use the returned operation resource or `--watch`.

Runs and workflow operations use immutable global URLs (`/v1/runs/:id` and `/v1/workflow-operations/:id`). A planning response can expose a run ID before the run row exists; `--watch` follows that run's globally registered identity. Workflow-operation resources use locator type `workflow_operation`, even though their IDs use the `op_` prefix. The API resolves current repository placement on each request, so watching, cancellation, reproduction and receipt replay retain the same public URLs after a repository move. See [the routing contract](routing.md).

## Semantic commands

All semantic API commands accept the same input, field, query, ETag, idempotency, pagination and watch options. Use `gitknot GROUP --help` for individual commands.

| Group | Commands |
| --- | --- |
| `repo` | list, create, view, edit, delete, clone, archive, unarchive, restore, import, fork, transfer, refs, commits, tree, file, compare, collaborators, rules, permissions |
| `issue` | list, view, create, edit, close, reopen, comment, comments, assign, labels, dependencies, link |
| `pr` | list, view, create, edit, close, reopen, comment, review, reviews, review-request, threads, patches, diff, compare, merge, eligibility, queue, dequeue, restack, dependencies |
| `search` | query, code query, complete code scan, scan status, paginated results |
| `workflow` | list, view, create, edit, delete, versions, validate, plan, run, reproduce, module-digest, toolchain inspect |
| `run` | list, view, watch, cancel, rerun, jobs, attempts, logs, outputs, manifest, approve |
| `secret`, `variable` | list, view, set, versions, delete |
| `billing` | view, plans, usage, budgets, budget, invoices, statements, statement-download, subscription, credits, budget-create, budget-edit, subscription-edit |
| `export` | create, view, watch, download, restore for repositories; create, list, show/view, watch, download, delete for accounts |
| `runner` | list, view, enroll, revoke, register, start, status, rotate; pool list/create/view/edit/delete |
| Other groups | org, team, user, discussion, task, environment, token, label, milestone, inbox, feed, webhook |

Repository-scoped commands use `--repo r_id` / `GITKNOT_REPO`; `OWNER/NAME` is resolved through the authorized repository resolver. Account-scoped commands use `--account org_id` / `GITKNOT_ACCOUNT`. Stable IDs survive renames and transfers. Use `--environment env_id` with a repository for environment secrets/variables. Code search starts a complete scan with `search code QUERY --repo REPO --commit FULL_COMMIT`, or a multi-repository `--input` document.

```sh
gitknot issue create --repo r_catalog --title 'Preserve review context' --body 'Canonical Markdown.'
gitknot pr create --repo r_catalog --title 'Keep patch history' \
  --base-ref refs/heads/main --head-ref refs/heads/patch-history \
  --base-oid FULL_BASE_COMMIT --head-oid FULL_HEAD_COMMIT
gitknot run watch run_example
gitknot secret set REGISTRY_TOKEN --repo r_catalog --value-stdin
gitknot variable set API_URL --repo r_catalog --value https://gitknot.com
gitknot billing budgets --account org_acme
gitknot export create --repo r_catalog --watch
```

Secret values use hidden input, `--value-stdin`, or `--value-file`, never a `--value` argument. `set` creates a name; supply the existing entry's `--if-match` ETag to rotate it. Management reads return metadata/version history only. Money and metered quantities remain exact decimal strings; use JSON strings or `--raw-field`, rather than floating-point CLI coercion.

### Complete account exports

```sh
gitknot export create --account org_acme \
  --idempotency-key account-backup-2026-10-05 --watch --json
gitknot export list --account org_acme --limit 20 --paginate
gitknot export show aexport_ID --account org_acme --include
gitknot export watch aexport_ID --account org_acme --timeout 1800
gitknot export download aexport_ID --account org_acme \
  --output acme.gitknot-account.tar --max-bytes 1073741824
gitknot export delete aexport_ID --account org_acme \
  --if-match '"7"' --idempotency-key account-backup-cleanup-2026-10-05 --watch
```

`--account` selects the account export contract in [account-exports.md](account-exports.md). `GITKNOT_ACCOUNT` supplies the default when no repository scope is selected; an explicit `--account` overrides an ambient `GITKNOT_REPO`. Use one explicit scope. `show` and `view` both read account export metadata. Repository exports continue to use `--repo`; their operation IDs remain usable with `export watch`.

Creation sends the required empty JSON object and one stable `Idempotency-Key` across transport retries. Supply the same key again after an uncertain response to recover the original export and operation. An automatically generated key is printed to stderr before the request. Creation without `--watch` reports accepted progress; it does not label queued capture complete.

Account watching follows the export resource's `queued`, `capturing`, `verifying`, and cleanup states. Completion succeeds only with `state: completed` and verified complete coverage. Failed, expired, or incomplete capture exits nonzero. Deletion uses the **resource ETag from `show --include`**, preserves the caller's precondition, and returns accepted cleanup progress; `delete --watch` waits for `state: deleted`.

Download requires complete verified coverage and an unexpired export. It checks the exact account/export download path, `application/x-tar`, the checksum ETag, byte count, and the streamed SHA-256 before atomically installing the owner-readable output file. `--watch` can wait for capture before download. The default download bound is 256 MiB; raise `--max-bytes` for a larger export. The version-1 TAR contains `manifest.json` (`gitknot.account`), account metadata, and full nested repository archives.

## Local workflow commands

See [workflow syntax and execution](workflows.md) for trusted context, explicit toolchain locks, conditions, modules, reports, and reproducibility.
These examples use your configured `./isolation.json` file, described under [customer-owned runner](#customer-owned-runner).

```sh
gitknot workflow validate
gitknot workflow plan verify --event event.json --toolchains toolchains.json --output plan.json
gitknot workflow run verify --local --manifest plan.json --source . --secret REGISTRY_TOKEN --isolation ./isolation.json
gitknot workflow reproduce run_example --job test --isolation ./isolation.json
```

The local executor runs real shell commands in separate clean job directories at the pinned commit, with a minimal environment. It does not inherit the CLI token, provider credentials, Git global configuration, or the runner machine credential. Missing secrets/inputs/toolchains are explicit blocked outcomes. Logs are redacted before disk/terminal output. Local output files and summaries live under the private GitKnot state directory, configurable with `GITKNOT_STATE_DIR`.

### Reproduction API contract

`GET /v1/runs/:id/manifest` returns the original portable `RunManifest` (or use the generic API to inspect a server envelope). `GET /v1/runs/:id/reproduce?job=JOB` returns:

```ts
{
  manifest: RunManifest,
  source: {url: string, commit: string, token?: string},
  inputs: Array<{
    job_id: string, name: string, type: 'artifact'|'string'|'number'|'boolean'|'json',
    digest: string, size_bytes: number, download_path: string
  }>,
  variables: Record<string, string>,
  completed_dependencies: string[],
  unavailable_secrets?: string[]
}
```

The server authorizes current access, binds the source capability to the original commit, lists only immutable successful direct dependency outputs, and uses run-scoped `/v1/runs/:id/...` download paths. Values are canonical JSON bytes; artifacts use the streaming archive format documented in the runner protocol. Secret plaintext is not returned. The CLI validates all references and checksums before execution, reports unavailable values, and never uploads a local result as an accepted verification.

## Customer-owned runner

```sh
gitknot runner pool create --account org_acme --input pool.json
gitknot runner enroll --pool pool_build
# Pipe the one-time enrollment token into the customer machine:
gitknot runner register --name builder-1 --toolchains toolchains.json --isolation isolation.json --enrollment-token-stdin
gitknot runner start --name builder-1
gitknot runner status --name builder-1
gitknot runner rotate --name builder-1
```

Registration verifies actual host tools before advertising their fingerprints. Enrollment is one-time; only the rotatable machine credential is saved. Default capacity is one slot. A runner daemon owns an exclusive private state lock; stop it before separate credential rotation. `--once` performs one poll/assignment, and `--max-assignments N` is useful for supervised bounded workers. Untrusted pools require `--disposable`, accept one assignment, then exit for the customer supervisor to destroy the machine/VM.

Customer execution requires an explicit credential boundary. `isolation.json` selects `oci` (digest-pinned local Docker/Podman image), `posix_user` (root supervisor plus dedicated non-root UID/GID), or `windows_user` (LocalSystem service plus a different nonadministrator batch-logon account and native Windows Job Objects). Same-user native execution is rejected before polling. The OCI mode mounts only the source, job home, and read-only dependency inputs, with private PID/IPC namespaces and no engine socket, supervisor paths, or daemon logging. Native execution uses a dedicated account; controller credentials are never passed to its environment or inherited handles. Untrusted pools additionally require disposable-machine/VM operation and server-side one-assignment consumption.

For example, `{ "type":"oci", "engine":"docker", "image":"node@sha256:YOUR_APPROVED_IMAGE_DIGEST", "network":"bridge" }` selects a preloaded immutable Linux image. There is no implicit image pull or mutable-tag fallback. `workflow toolchain inspect --isolation isolation.json --name NAME` inspects tools inside that exact boundary. `workflow run --local --isolation isolation.json` uses the same backend. Native POSIX work-root ancestors must grant the execution UID directory traversal; keep supervisor state in a separate private sibling. Windows requires a supervisor-only `credential_file` containing `{username,domain,password}` for a locked-down batch-logon account; it is delivered only to the trusted helper's stdin, never to job arguments or environment.

Machine state/receipts are outside job workspaces. The runner long-polls and heartbeats over outbound HTTPS, checks repository/pool/trust/toolchain matching, fetches a credential-free clean checkout, streams numbered checksummed logs/outputs, cancels entire process groups, and persists an immutable completion receipt before submission. Restart replays a finished receipt; it never reruns an uncertain attempt. Revoked/expired generations cannot publish results. See [the exact runner protocol](../packages/runner/README.md).

## Errors and exits

- `0`: successful command, successful verification, or explicitly inapplicable verification.
- `1`: API/runtime/validation failure, blocked/mismatched reproduction, unsuccessful watched operation, or unsuccessful local test/build.
- `2`: invalid command-line usage.
- `130` / `143`: interrupted/stopped execution after cancellation cleanup.

Errors are structured JSON on stderr with a GitKnot code/message and request ID when available. Normal CLI errors do not print stack traces, raw provider failures, request bodies, or credentials. `--api-url` selects an explicit origin. HTTP is accepted only for literal loopback hosts with `--allow-loopback-http` or `GITKNOT_ALLOW_LOOPBACK_HTTP=1`; production runners require HTTPS.

## Implementation dependencies and server integration

The CLI and runner use Node built-ins, `yaml`, `zod`, and pinned `fast-xml-parser@5.11.2` for safely validated JUnit reports. The XML parser's versioned declarations were checked after Context7 became unavailable; entity processing is disabled and DTD/entity declarations are rejected. The package build uses the monorepo's TypeScript compiler with relative import-extension rewriting.

The identity service supplies token inspection, password/MFA session creation and revocation. Workflow control supplies the runner protocol, immutable manifests/reproduction, scoped blob reads, step-secret release, and receipt acceptance. The generic `api` command exposes the complete registered contract, including new capability surfaces without waiting for another semantic alias.
