Keep the GitKnot request ID with an unsuccessful action. It connects the error shown in your browser or CLI to the exact request that needs investigation.

## Find the request ID

- **Web:** an API error includes a `Request req_…` line. Copy that line and the error message. The error's **Request troubleshooting** link returns to this guide.
- **CLI:** structured errors on stderr include `request_id` when the API supplied one. `gitknot api … --include` also prints safe response headers.
- **HTTP client:** retain the `X-GitKnot-Request-ID` response header, or `error.request_id` in the JSON error body. In browser developer tools, select the unsuccessful request in Network and inspect its response headers.

Each retry has its own request ID. For an uncertain create or operation, retain the original idempotency key as well as the operation or run ID.

## Recover account access

If you forgot your password, use [account recovery](/auth/recover). An email-verification link is handled by [verification](/auth/verify). If your organization requires single sign-on, start from [organization sign-in](/auth/sso); contact your organization's GitKnot owner for membership or identity-provider access.

Use an enrolled passkey, second factor, or saved recovery code when the sign-in screen requests it. After regaining access, review [security settings](/settings/security) and [active sessions](/settings/sessions).

## Resolve a failed edit or operation

| What you see | Next step |
| --- | --- |
| `401` or expired authentication | Sign in again, or inspect the CLI credential with `gitknot auth status`. |
| `403` or a private resource's `404` | Check the selected account, credential scope, repository membership, and SSO requirements with the repository or organization owner. |
| `412` revision conflict | Keep your draft, inspect the current version, reconcile edits, and save against the selected revision. |
| `428` missing precondition | Read the resource and supply its strong ETag in `If-Match`. |
| `409` on a repeated create | Reuse the exact original request with its idempotency key while the outcome is uncertain. A different request needs a different key. |
| `422` validation error | Read the returned field paths or compiler diagnostics and correct the input. |
| `429` throttling | Wait for `Retry-After` before retrying. |
| `202` operation accepted | Open the returned operation or run; check its state and durable result before submitting new work. |
| Interrupted upload or download | Recheck the existing reservation or retained output, then verify its expected bytes and checksum. |
| `5xx` service error | Retain the request ID and time. Retry an uncertain mutation with the same request and idempotency key. |

## Investigate workflow and spending controls

Open the run to inspect each job, its dependencies, attempts, pinned source, and retained logs. A blocked job needs its reported requirement resolved; it does not count as passing. A customer-owned job can remain queued until a matching runner is available. Cancellation remains pending until executor termination is confirmed.

For rejected admission, check the owning account's [Billing & usage](/billing) view for budgets, reservations, and admission status. Account owners manage those controls. See the [workflow guide](/docs/workflows) for toolchain, secret, and environment requirements.

## Provide useful context

When contacting GitKnot support, include:

- The error message and GitKnot request ID.
- The approximate time and whether you were using production or staging.
- The affected account, repository, operation, or run ID.
- The action or CLI command, expected result, and actual result.
- Whether retrying the original operation returns the same state.

Share the smallest relevant error excerpt. Token values, cookies, passwords, recovery codes, secret values, and whole private source files are not needed to identify a request.

For a repository permission or organization-membership change, contact its owner. [Accounts & teams](/accounts) shows the organizations you can access. The [API guide](/docs/api) documents the status, revision, and retry contracts; [Help](/help) covers editor and keyboard controls.
