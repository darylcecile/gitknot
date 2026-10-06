GitKnot's versioned REST API is the same interface used by the web application and CLI. The **OpenAPI specification** linked above is generated from the registered application endpoints.

## Origins and discovery

| Environment | API | HTTPS Git |
| --- | --- | --- |
| Production | `https://api.gitknot.com/v1` | `https://git.gitknot.com` |
| Staging | `https://api.staging.gitknot.com/v1` | `https://git.staging.gitknot.com` |

`GET /v1/meta` returns the configured API and Git origins, OpenAPI URL, pagination conventions, and resource limits. `GET /v1/api-capabilities` describes the signed-in principal, credential ceiling, and registered operation requirements.

The following public read requires no credential:

```sh
curl --fail-with-body --include https://api.gitknot.com/v1/meta
```

The [CLI](/docs/cli) manages authentication and can call every API operation:

```sh
gitknot api GET /v1/api-capabilities --include
gitknot api GET /v1/repos --paginate
gitknot api GET /openapi.json --output openapi.json
```

## Authentication and authorization

Automation uses a scoped GitKnot credential in `Authorization: Bearer …`. Browser sessions use a secure, HttpOnly cookie owned by the API host. Cross-origin browser requests must include credentials; unsafe cookie-authenticated requests also send the configured GitKnot web `Origin` and `X-GitKnot-CSRF: 1`.

Keep production and staging credentials on their respective API hosts. Credentials belong in headers or the session cookie, not in API URLs. A private repository may return `404` instead of disclosing that it exists. Possessing an object ID or commit hash does not grant access.

## Resources and complete pagination

Single-resource responses are JSON objects. Collections contain `items` and `next_cursor`; a null cursor marks the end. Follow the returned opaque cursor with the same filters, or the `Link` header's next-page URL. Most lists default to 30 entries and cap each page at 100; use the limits published by the actual endpoint.

Resource IDs survive renames, transfers, and placement changes. Timestamps are UTC RFC3339 strings. Search responses retain coverage, freshness, and truncation metadata; a partial or stale page is not a complete negative answer.

## Conditional edits

Read the resource and retain its strong `ETag` response header. Supply that exact value in `If-Match` on a revisioned mutation, including the quotes.

For example, after reading an issue whose ETag is `"7"`:

```sh
gitknot api PATCH /v1/repos/REPO_ID/issues/ISSUE_ID \
  --if-match '"7"' --field state=closed
```

Use the real IDs and current ETag from your read. A missing precondition returns `428`; a stale one returns `412`. Preserve the pending draft, inspect the current version, and reconcile the changes before submitting with a new ETag. Retrying automatically with the latest ETag can overwrite another contributor's work.

## Retryable operations

Send a unique `Idempotency-Key` for a create or operation request. If its outcome is uncertain, retry the same method, path, parameters, body, revision, and key. Changing the request with the same key returns a conflict. Replayed responses still require current access.

Long operations return `202` with a durable operation or run ID. Follow the returned resource until it reports a terminal result; accepted is not completed. Keep the original ID when investigating an interrupted request. One-time credential values are not replayed from a cache: if the first value was lost, rotate the existing credential.

## Files, uploads, and portable manifests

Use the authorized file and download paths returned by GitKnot. Raw file reads accept an exact `ref` and repository-relative `path`. Reserve an attachment with its filename, byte count, and SHA-256 checksum, upload the exact bytes, then complete the existing reservation. Follow its state after an interrupted upload.

`GET /v1/runs/RUN_ID/manifest` returns a portable workflow manifest. The reproduction endpoint additionally returns pinned source and authorized dependency inputs. Keep the envelope distinct from the manifest accepted by the CLI's `--manifest` option. Artifact reads check current access and retained output identity.

Billing values use exact decimal strings in the API's declared units. Monetary amounts expressed as `USD/1000000000` are nanodollars. Preserve those strings or use integer arithmetic rather than floating-point conversion.

## Errors and request IDs

API errors contain `error.code`, a human-readable `error.message`, and `error.request_id`. Field validation includes actionable field paths. Responses carry `X-GitKnot-Request-ID`; throttled requests also include `Retry-After`.

For an unsuccessful request, record the method, path, status, error code, request ID, approximate time, and operation or run ID. The [support guide](/support) explains recovery and how to provide that context. Keep authentication headers, passwords, and secret values out of reports.
