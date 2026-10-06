The `gitknot` command connects to `https://api.gitknot.com` and uses GitKnot credentials. Git operations use the repository's HTTPS remote.

## Install

Use Node.js 24. Install native Git for clone, push, local workflows, and runner checkout.

```sh
npm install --global @gitknot/cli
gitknot --version
gitknot --help
```

`gitknot GROUP --help` describes the installed commands for a group, such as `gitknot issue --help` or `gitknot api --help`.

## Authenticate and configure Git

Create a scoped, expiring token in [Settings → Tokens](/settings/tokens), then use the hidden token prompt:

```sh
gitknot auth login
gitknot auth status
gitknot auth setup-git
gitknot repo clone OWNER/NAME
```

Replace `OWNER/NAME` with a repository you can access. The credential helper supplies the token only to the selected GitKnot Git host. It keeps credential values out of your remote URL and repository configuration.

Automation can pipe a token into `gitknot auth login --with-token` or supply `GITKNOT_TOKEN` to the process. To create a human session for account-security operations, use `gitknot auth login --username YOUR_LOGIN`; the client prompts for the password and any required second factor.

Authentication is stored per API origin in your private GitKnot configuration directory. `gitknot auth logout` revokes the current credential and removes the local copy. `gitknot auth logout --local-only` removes only the local copy, leaving the server credential active.

## Work with repositories and reviews

`--repo` accepts a stable repository ID or an authorized `OWNER/NAME`. Set `GITKNOT_REPO` to reuse the same repository across commands. Account-scoped commands accept `--account` or `GITKNOT_ACCOUNT`.

```sh
gitknot repo list --paginate
gitknot issue create --repo OWNER/NAME \
  --title 'Preserve review context' --body 'Keep the decision with the patch.'
gitknot pr list --repo OWNER/NAME --paginate
gitknot workflow list --repo OWNER/NAME
gitknot billing budgets --account ACCOUNT_ID
```

Use actual account and repository identifiers from GitKnot. Other command groups cover discussions, tasks, teams, notifications, webhooks, environments, secrets, and exports.

## Call the complete API

```sh
gitknot api GET /v1/repos --paginate
gitknot api GET /v1/api-capabilities
gitknot api GET /openapi.json --output openapi.json
```

| Option | Use |
| --- | --- |
| `--input FILE` or `--input -` | Read a JSON request from a file or stdin. |
| `--field key=value` | Add a JSON-typed field. Nested keys use dots. |
| `--raw-field key=value` | Preserve an exact string, including monetary quantities. |
| `--query key=value` | Add a query parameter. Repeat for more parameters. |
| `--include` | Print status, ETag, and request-ID headers without credentials. |
| `--if-match '"7"'` | Supply the strong ETag from the resource you read. Use its actual value. |
| `--idempotency-key KEY` | Keep the same key and request when retrying an uncertain mutation. |
| `--paginate` | Emit complete cursor pages as JSON Lines, including coverage metadata. |
| `--output FILE` | Stream response bytes into a file. |
| `--watch` | Wait for a run or durable operation to finish. An unsuccessful outcome exits nonzero. |

A `202` response means accepted, not completed. Keep the returned operation or run ID and follow its status. The [API guide](/docs/api) explains concurrent changes and retry semantics.

## Workflows, downloads, and secrets

```sh
gitknot workflow validate
gitknot run watch RUN_ID
gitknot run manifest RUN_ID --output plan.json
gitknot secret set REGISTRY_TOKEN --repo OWNER/NAME --value-stdin
```

`plan.json` is the portable manifest accepted by `--manifest`; a reproduction response is a separate envelope containing the manifest and authorized inputs. The [workflow guide](/docs/workflows) covers planning and the explicit `--isolation` configuration required to execute or reproduce locally.

Secret values use hidden input, stdin, or an owner-only file. Secret-management reads return metadata and versions. To rotate a value, use the existing entry's ETag with `--if-match`.

## Troubleshoot a command

Errors are structured JSON on stderr and include a GitKnot request ID when available. Exit `0` indicates successful work, `1` indicates an API, validation, blocked, or execution failure, and `2` indicates invalid command usage. Interrupted work exits `130` or `143` after cancellation cleanup.

Use `--include` to retain response metadata. Take the error code, request ID, command, and relevant resource ID to [Support](/support). Authentication cookies, token values, and secret inputs are not needed for diagnosis.
