# Complete account export contract

## API and clients

Account exports use the existing Operations route registration:

- `POST /v1/accounts/:accountId/exports`, body `{}`, `Idempotency-Key` required: `202` with an export resource and its durable operation.
- `GET /v1/accounts/:accountId/exports`: cursor-paginated resources.
- `GET /v1/accounts/:accountId/exports/:exportId`: current progress, coverage and checksum.
- `GET /v1/accounts/:accountId/exports/:exportId/download`: verified `application/x-tar`, with a SHA-256 ETag and attachment filename.
- `DELETE /v1/accounts/:accountId/exports/:exportId`, `If-Match` required: `202` while verified storage cleanup completes.

Resource fields: `id`, `account_id`, `schema_version:1`, `state`, `revision`, `created_at`, `expires_at`, `checksum_sha256`, `size_bytes`, `coverage`, `operation`, and `download_path` (null until completed). States are `queued`, `capturing`, `verifying`, `completed`, `failed`, `deleting`, `deleted`, and `expired`. `operation` has `id`, `kind:'account.export'`, `status`, `phase`, and `revision`; the normal `/v1/operations/:id` resource remains available. `coverage` identifies the captured repository count and verified count, `complete`, and the account metadata snapshot time.

Clients must wait for `state==='completed' && coverage.complete===true` before offering download. Failed coverage is explicit; a partial repository list is never called a complete export. The CLI and web use these same routes and permissions.

## Version 1 container

The TAR contains `manifest.json`, bounded canonical JSON metadata pages, account-owned asset chunks, and a full nested portable repository archive at `repositories/<repo_id>.gitknot.tar` for every repository in the account snapshot. The manifest is `format:'gitknot.account', version:1`. Every entry has a path, exact byte count and SHA-256. `assets` maps each original object ID to its ordered chunks and complete checksum. Repository entries identify their immutable archive and coherent snapshot boundary. They contain actual Git bundles, collaboration history, workflow definitions and retained content through the repository archive protocol.

The account metadata snapshot and each repository snapshot are individually coherent and immutable. The manifest reports their capture times and the coverage window, rather than claiming a single cross-D1 transaction. Account repository membership is checked again before completion. Changed ownership, missing archives or denied source audiences prevent a complete result.

Ordinary exports include account/profile data, applicable membership/team/role/policy records, customer billing statements and ledger metadata, repository catalog/content, and the account owner's personal collaboration data for a personal account. The `collaborationUserStateInventory` contract supplies identity-primary subscriptions, saved views, inbox overlays, profile preferences and follows; contextual records preserve their user and account partition. The initiating user's repository-local inbox and drafts are copied under each included repository's exact archive fence into private account metadata pages. Organization exports cover organization-owned data and the initiating user's organization-context state; other people's private inbox/preferences and personal authentication material belong to their personal accounts.

Authentication material and protected secret values are excluded: bearer/password/token hashes, private keys, MFA seeds/recovery codes, secret plaintext, ciphertext and wrapped keys. Safe credential, provider and vault metadata records describe reconstruction requirements. Restoring authentication and secrets uses their protected owner-controlled workflows; an ordinary content archive grants no live authority.

Private draft history follows the same user owner as the current draft. Account capture joins immutable `resource_kind='draft'` versions and draft audit records to that captured user's draft rows under the repository fence. Generic account audit pages omit draft records; private draft pages contain only the eligible initiating user's records. Nested repository archives and ordinary repository exports/backups exclude private drafts and their histories altogether. Repository access alone never authorizes another user's unpublished Markdown or draft IDs. Canonical published history remains complete regardless of its author's identity.

## Authorization and durability

Creation requires the complete account metadata capability set exported as `accountExportCapabilities`: account management, billing, membership, team, role, policy, identity, token, installation, runner, vault-metadata and audit reads. Repository content additionally requires current export/read authority for every included repository and all retained historical source audiences. Account administration never substitutes for repository, organization-policy or credential-scope authorization. Capture and every streamed release use current identity authority; a revoked source permission stops output. Execution dependencies use `readRunPlan`, `executionAudience` and `workflowOperationAudience`, preserving private-fork provenance even after a PR head changes.

Migration **101_account_exports.sql** owns the account export journal, materialized identity rows, repository membership receipts and immutable metadata part references. Parent and repository capture operation IDs are stable across lost replies. Generated account storage uses the existing standalone billing/object protocol at the identity home. Cleanup uses verified Billing deletion and preserves uncertain writer holds. Repository archives remain independently verified and billed throughout the container's retention window.
