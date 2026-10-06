# GitKnot API conventions

The production endpoint is `https://api.gitknot.com/v1`. The web app calls the same application services and permission checks. The complete generated OpenAPI document is served at `/openapi.json`; with `npm run dev` running, `npm run openapi` exports that actual Worker contract to a versioned file. Set `GITKNOT_API_URL` to read another intended GitKnot API origin.

## Authentication and current permissions

Use a scoped GitKnot bearer credential in `Authorization: Bearer …`. Browser sessions use secure, HttpOnly cookies. Unsafe cookie-authenticated requests require the configured GitKnot web origin and `X-GitKnot-CSRF: 1`; cross-origin browser requests are restricted to the configured application origin. Tokens are independent of repository rules, so a content-write scope does not bypass branch policy.

Authorization starts from primary-consistent metadata. A private repository or object may return `404` to protect its existence. Object IDs, commit hashes, and cached content never substitute for a permission check. Scope discovery is available at `/v1/api-capabilities`; a repository's permission explanation reports the effective decision for a concrete operation.

## Representations

Single-resource responses are JSON objects. Lists return `{ "items": [...], "next_cursor": "…" }`; a null cursor marks the end. Follow the returned cursor or `Link: …; rel="next"` header. Most lists default to 30 items and are bounded at 100. Each endpoint validates supported filters and applies authorization before exposing results.

Timestamps are UTC RFC3339 strings. Stable IDs remain unchanged by renames, transfers, or storage moves. Provider account, namespace, shard, and bucket identifiers are private implementation details.

Errors have this form:

```json
{
  "error": {
    "code": "revision_conflict",
    "message": "This resource changed while you were editing it. Refresh it and reapply your changes.",
    "request_id": "req_…"
  }
}
```

Validation errors include field paths. Every response carries `X-GitKnot-Request-ID`; retain it for support. Throttled requests carry `Retry-After`. Internal provider diagnostics are retained in operational logs and are not copied into public errors.

## Concurrent changes

Revisioned resources return a strong `ETag`, for example `"7"`. Supply it in `If-Match` when changing that resource. Missing preconditions return `428`; stale revisions return `412`. A failed compare-and-swap rolls back the associated outbox event and all dependent effects. Refresh the resource and preserve/reapply the user's pending edits.

For retryable creation or operation requests, generate an `Idempotency-Key` and reuse the same key and exact request body until the outcome is known. Keys are bound to the authenticated principal, method, path, query, body, and supplied revision. A changed request returns `409`. Completed responses are replayed only after current access is rechecked. In-progress or uncertain requests stay fenced rather than being executed again. One-time credential values are never stored in the replay cache; rotate the existing credential if its first response was lost.

Imports, forks, transfers, exports, and other long operations return `202` with an operation ID. Inspect the operation resource to follow its phase, waiting conditions, durable result, or actionable failure. Queue delivery does not determine whether a mutation committed: the transaction and its recoverable outbox are authoritative.

## Objects and downloads

Reserve an upload with its filename, byte count, and SHA-256 checksum. The reservation applies account and repository storage limits atomically. Upload the exact bytes, then use its completion endpoint to reconcile an interrupted request. The reserved space is retained while storage acceptance is uncertain. Downloads require current access and support a single byte range. Blob keys and unsigned storage download URLs are never public.

## Versioning

`/v1` is the stable major contract. Additive fields and new enum values are announced in the API changelog; clients should ignore unknown object fields and show unknown states rather than treating them as success. Incompatible changes use a new major version. Deprecations include a published migration guide and a minimum 180-day overlap before retirement, except where a credential or security incident requires earlier revocation.
