# GitKnot web application

`apps/web` is the production React SPA served by the API Worker's static assets. It has no separate Cloudflare deployment configuration. The parent application owns asset binding, SPA fallback, security headers, root workspace scripts, and the production API deployment.

## Running and building

- Node 24; npm workspace `@gitknot/web`.
- `npm run dev --workspace @gitknot/web` starts Vite on `127.0.0.1:5173`.
- `/v1` and `/openapi.json` proxy to `GITKNOT_DEV_API_URL` (default `http://127.0.0.1:8787`). Set the local API's `APP_ORIGIN` to the browser origin, including its port.
- `src/api/origin.ts` is the central validated origin resolver. `gitknot.com` always uses `https://api.gitknot.com`; `staging.gitknot.com` always uses `https://api.staging.gitknot.com`. Authentication, JSON requests, uploads, private downloads, Markdown API links, and OpenAPI links all use the same `apiUrl` boundary. This keeps host-only `__Host-` session cookies on the API host that receives subsequent requests.
- Localhost defaults to the same-origin development proxy, including production-build previews served locally. A nonstandard application hostname requires an explicit `VITE_API_ORIGIN`. Overrides must be bare HTTPS origins (HTTP is accepted only for loopback development); a production/staging hostname rejects an override for the wrong canonical environment. The same built artifact can therefore serve both public environments without accidentally using the other API.
- GitKnot-generated absolute resource URLs are validated and rebased onto the selected API, including rebasing canonical URLs through the localhost proxy. Arbitrary external origins and URL-embedded credentials are rejected. `VITE_GIT_ORIGIN` configures the fallback displayed Git remote; repository metadata normally supplies its canonical clone URL.
- `npm run typecheck --workspace @gitknot/web` and `npm run build --workspace @gitknot/web` are local, non-deploying checks. Output is `apps/web/dist`.
- The assets host must fall back to `index.html` for client routes and keep API errors as API errors. `/v1/*` must never receive SPA HTML.

Exact dependency versions are in `apps/web/package.json`: React/React DOM 19.3.0, React Router 8.4.0, Vite 8.3.2, plugin-react 6.1.1, TypeScript 7.0.2, Marked 18.0.14, DOMPurify 3.4.16, Mermaid 12.1.0, and the pinned ProseMirror/CodeMirror modules. No app dependency relies on an unpinned CDN or a browser-only demo service. The parent owns the root lockfile; the web package does not create a second lockfile.

## API integration

`src/api/endpoints.ts` holds product endpoint names; `src/api/adapter.ts` translates module-specific routes/representations. `src/api/client.ts` is the only JSON mutation transport.

Relationship fields use the shared `ReferencePicker`: people, labels, milestones, statuses, templates, repositories/accounts, linked work, roles and environments are selected by readable names in compact, searchable popovers. Multi-selection uses checkboxes; search and pagination consume the existing authorized collections. Stored IDs remain request values, and clearing a selection preserves the API's explicit empty-list behavior. Dedicated controlled editors in `src/components/editors/` replace JSON configuration input; `field-values.ts` keeps typed serialization and legacy tab-draft decoding separate from rendering. See [interface design](interface-design.md) for the visual and interaction system.

- Cookies always use `credentials: include`; unsafe requests send the identity contract's `X-GitKnot-CSRF: 1`. Session state comes from `/v1/me`; authentication never stores bearer credentials in local storage.
- Single resources are plain JSON; collections consume `{items,next_cursor}` without inventing results or totals. Loading, failed initial loads, failed subsequent pages, empty results, and unknown server states are distinct.
- Updates use the resource's strong ETag. Collection entries with a revision use the core-documented `"<revision>"` encoding when their module has no individual GET route. Weak ETags are rejected.
- A conflict keeps form state and its original expected revision. The user can inspect the current resource and explicitly choose a new expected revision while keeping the draft. There is no automatic overwrite/retry with a fresh revision.
- Every unsafe request carries an idempotency key, including PUT-based secret version creation. A form retains its prepared request body, key, and expected revision after an uncertain response; time-relative transformations such as invitation expiry do not change on retry. Editing the operation creates a new key. Parent preconditions resolved by the client are retained with uncertain operation keys.
- Abortable reads ignore stale results after navigation. Pagination cursors are scoped to each query. Polling is limited to live runs/operations and stops for terminal run states.
- Non-sensitive drafts and their original base ETags live in this browser tab's session storage and are cleared on sign-out. Restoring an older draft does not silently adopt a newer server revision. Secret/token/password inputs do not persist. Failed saves preserve form state. Uploads reserve a checksummed manifest, PUT exact bytes, and reconcile the existing manifest when retrying.
- `/viewer/:repoId#token=…` accepts only a server-confirmed `viewer` credential with exactly that repository scope. The fragment is removed from the address bar and the credential remains in memory. Viewer reads and downloads use an Authorization header, including Blob-backed attachment downloads and Markdown API links; personal, installation, and runner credentials are never put into URLs. Leaving viewer access clears the in-memory grant.
- Request IDs and structured validation details are exposed in errors. A 404 does not distinguish absence from insufficient access.

Some public APIs expose collection reads rather than individual reads. The adapter looks up the actual authorized personal account referenced by `/v1/me`, combines it with `/v1/orgs`, resolves profile repositories through the user's immutable ID, and finds an environment through its complete authorized paginated collection. Managed federation users are not given an invented personal account. Following/subscription lookups similarly traverse the real authorized collections. Git directories and raw files are resolved to an immutable commit before preview and pagination.

## Routes and operations

| Web route | View and actions |
| --- | --- |
| `/auth/login`, `/auth/signup`, `/auth/verify`, `/auth/recover`, `/auth/reset` | Password sign-in, passkey sign-in, second factor, registration, verification, recovery, and reset |
| `/auth/sso`, `/accounts/:id/sso`, `/accounts/:id/sso/:providerId` | OIDC/SAML sign-in and explicit linking, provider discovery/configuration, write-only provider secrets, required SSO policy, SCIM credentials, fresh-SSO token authorization |
| `/viewer/:repoId` | Expiring private viewer access with header-authenticated downloads |
| `/` | Chronological API activity, outstanding decisions, accessible repositories |
| `/inbox` | Reason/state filters, mark read, explicitly resolve, snooze, mute, explanations |
| `/search`, `/search/scans/:id` | Search types and scope, visible coverage/freshness/exclusions/truncation, saved searches, full scan status/results |
| `/users/:username` | Public/private profile representation, visible repositories/activity, follow/unfollow |
| `/repos`, `/repos/new`, `/repos/import` | Repository filtering, visibility, ownership, create, private-source import |
| `/repos/:repoId`, `/code/*` | Branch/tag selection, directory navigation, source/Markdown views, line permalinks, authorized raw download, HTTPS clone commands |
| `/repos/:repoId/edit` | Canonical-source file proposal with an exact base and commit message |
| `/repos/:repoId/refs`, `/git/operations/:id` | Conditional branch/tag creation/deletion, canonical Git publication progress, receipt and proposed-change navigation |
| `/repos/:repoId/history`, `/commits/:oid`, `/compare` | Git history, commit metadata, pinned tree and unified file diffs |
| `/repos/:repoId/issues`, `/issues/:id` | Issue creation/editing, typed status, priority, dates, templates, labels, assignments, milestones, dependencies, duplicates, linked PRs, comments, document versions/restore, attachments, event history |
| `/repos/:repoId/issues/manage` | Labels, milestones, issue templates, saved filters |
| `/repos/:repoId/pulls`, `/pulls/:id` | Draft/open changes, exact source/base revisions, comments, reviewers, scoped reviews, patch history/comparisons, review impact, anchored threads, suggestions, dependency edges, restack, merge eligibility and queue submission |
| `/repos/:repoId/discussions`, `/discussions/:id`, `/discussions/categories` | Categories, threads/replies, accepted answers, locking/moderation, conversion to linked issue |
| `/repos/:repoId/tasks`, `/tasks/:id` | Accountability, contributors, pinned base, path claims, heartbeat renewal, private workspaces, decision context |
| `/repos/:repoId/workflows`, `/workflows/:id`, `/workflows/validate`, `/plans/:id` | Approved definitions, immutable-version approval, YAML validation, execution-plan inspection, manual runs and history |
| `/repos/:repoId/runs/:id` | Live retained log chunks, attempts, every job outcome, exact provenance/outputs, cancel, rerun selected jobs, local reproduction, promotion request, exact-artifact approval/rejection and publication |
| `/repos/:repoId/environments`, `/environments/:id` | Protected destinations, target refs, approver policies, scoped vaults and promotions |
| `/repos/:repoId/runners`, `/runners/:poolId` | Customer pools, trust/isolation/toolchains, enrollment and online machine state, disable/revoke |
| `/repos/:repoId/settings/:section` | Repository metadata/visibility, access grants, custom roles, rules, dry run, permission explanation, credentials/viewer grants, vaults, webhooks, integrations, ownership transfer, archive/unarchive, delete/restore/export, audit |
| `/repos/:repoId/settings/webhooks/:id` | One-time signing keys, endpoint state, deliveries/attempts, same-event redelivery, retained event replay |
| `/accounts`, `/accounts/:id/:section`, `/accounts/:id/teams/:teamId` | Organizations, members, teams, invitations, role/policy settings, service identities, grants, vaults, runners, audit |
| `/invitations`, `/invitations/:id`, `/transfers/:repoId/:transferId` | Invitation-token and exact seat-quote acknowledgment, payer review, receiving-owner transfer acceptance without requiring prior source-repository access |
| `/settings/:section` | Profile, password, recent reauthentication, TOTP enrollment/recovery codes, passkeys, session revocation, personal scoped tokens, notifications, privacy/federation |
| `/billing`, `/billing/:accountId/:section`, `/billing/:accountId/invoices/:id` | Payer selection, measured/forecast usage, reservations, exact ledger attribution, enforceable budgets/safety buffers/thresholds, admission stop, subscription, credits, invoices/statements |
| `/operations/:id` | Durable lifecycle phase, status, receipts, failure, result and authorized archive download |
| `/help` | Product navigation, keyboard shortcuts, API reference |
| `/docs`, `/docs/cli`, `/docs/workflows`, `/docs/api` | Public getting-started, command-line, workflow, and REST guides; canonical-origin OpenAPI link |
| `/support` | Public request-ID troubleshooting, access recovery, operation/workflow diagnostics and support context |

All navigation is client-routeable with an explicit not-found view. A shared header contains Overview, Repositories, Inbox, search, and the account menu. Primary navigation becomes a native modal drawer on narrow screens; repository tabs scroll within their container and grouped settings navigation becomes a select. Dialogs use native focus trapping/Escape behavior. The application includes a skip link, visible keyboard focus, text labels, reduced-motion and forced-colors treatments.

Account navigation lives in the account menu. “Go to account” uses a disabled “Choose an account…” prompt and labels each actual account by name and unique slug. Values remain immutable account IDs. Account administration is separate from the everyday project navigation.

### Public documentation

`src/pages/documentation.tsx` serves the advertised `/docs/cli` and `/support` URLs and the `/docs`, `/docs/workflows`, and `/docs/api` guides without an authentication guard. The maintained user-facing Markdown lives in `src/content/docs/` and is bundled by Vite as raw text in the lazy documentation page. It uses the same Marked/DOMPurify renderer as repository documents. Unknown guide slugs render the existing not-found page. Navigation, the help view, and request-ID errors link to these surfaces.

The curated guides are grounded in `packages/cli/src/{commands,help,workflows}.ts`, `packages/workflows/src/{schema,compiler}.ts`, `packages/core/src/routes.ts`, the registered API modules, and `docs/{cli,workflows,api-conventions}.md`. Keep command flags, examples, and protocol descriptions aligned when changing those contracts. Local execution/reproduction examples include the CLI's required `--isolation` input. Operator resource configuration stays in the repository's `docs/` and `infra/` trees.

Vite emits the content into `apps/web/dist/assets/`; there is no runtime Markdown fetch or external documentation service. Production deep links use the existing API `ASSETS` fallback and `notFoundHandling: 'single-page-application'` configuration in `infra/cloudflare.ts`. Public navigation/read and actual OpenAPI HTTP response checks are part of the existing collaboration E2E journey.

The public `/support` page links to `mailto:support@gitknot.com`, the product owner's selected contact. Override the visible address and mailto recipient with the public build setting `VITE_SUPPORT_EMAIL`; blank values use the default. Set it in the web workspace's Vite environment file or the build process environment. The address is displayed as text and URI-encoded in the mailto link. The page asks for the GitKnot request ID, error message, approximate time, and affected resource ID and includes recovery and organization-owner guidance.

### Review and manifest parity

Manifest downloads use the actual `GET /v1/runs/:id/manifest` endpoint; the adapter no longer aliases it to the reproduction envelope. The workflow E2E downloads the browser-delivered file and verifies it with the CLI/compiler's `verifyManifest` implementation.

Deleted-file patches retain their original repository-relative path when the new-side header is `+++ /dev/null`. File headers are parsed only before a hunk, so removed text beginning with `-- ` cannot replace the path either. Native deletion fixtures are published through stock Git, then the browser journey posts a real old-side review thread and verifies its persisted path, side, patch identity, and line.

## Canonical Markdown and security

The rich editor is a real ProseMirror document with keyboard commands, undo/redo, links, lists/tasks, tables, code, and inline marks. The source editor is CodeMirror 6. Marked lexes canonical blocks and DOMPurify sanitizes their rendering. Unmodified blocks retain their original source bytes, including CRLF; unsupported HTML/extended blocks are atomic source nodes. CodeMirror changes are mapped back to canonical offsets so untouched mixed line endings are retained. Editing another block cannot reserialize these nodes. Mode switches without document changes never serialize the source. Plain canonical Markdown is sent to the API and is the export format.

Rendered passage anchors use unambiguous source offsets plus the source fragment's SHA-256 and document revision. Diff comments use immutable patch ID, path, side, and line range. Comparisons against an earlier patch retain the earlier patch identity for old-side anchors.

Mermaid is lazy-loaded, configured strictly with bounded diagram size/edges, sanitized as SVG, and displayed in a sandboxed iframe without scripts or same-origin permission and with its own restrictive CSP. Markdown HTML cannot insert script, embedded frames, forms, event handlers, or inline styles. External images use no-referrer. Code/logs are rendered as text.

## Verification and integration work

### Real isolated-stack verification

The final expanded three-journey suite passed together on fresh local state at `.gitknot/e2e/run-1791226692414-755db6ee`: **3 passed, zero retries, no skips**. It used production-built web assets, six real local Workers, native Git helpers, and local D1/R2/DO/Queues/Workflows. It also executed the copied CLI reproduction command through real Docker isolation and verified the complete account TAR, account metadata and nested repository checksum. No business API responses were mocked. The earlier expanded pass and its manual-review state remain at `.gitknot/e2e/run-1791220981372-74e24757`; the unexpanded pass is at `.gitknot/e2e/run-1791195006954-03a96bc8`.

The workflow-specific run at `.gitknot/e2e/run-1791194751468-5dafd865` also exercised the visible conflict branch: stale `If-Match: "2"` returned 412; **Review current version** fetched `"3"`; **Use this revision** adopted it; a separate confirmation sent that exact revision and returned 202. The run finished cancelled at revision 5. Its evidence is `execution-run-revision-verification.json`. Migration `098_workflow_run_revisions.sql` preserves monotonic versions across planning/materialization and checks cancellation's precondition in the intent transaction.

The final source integration includes physical cross-cell placement, complete account exports, global collaboration reads and managed-SSO private state. The combined checks and manual browser/accessibility evidence are recorded in `docs/verification.md` and `dogfood-output/report.md`.

### Resolved integration findings

Earlier full run `.gitknot/e2e/run-1791193212547-43d3acc1` reported **1 passed, 2 failed, no skips** and exposed the following contracts:

- **Collaboration passed**, including the corrected workspace account labels.
- **Code, deleted-file review, viewer access, and secret create/rotate/delete succeeded.** The journey stopped on its outdated assertion that GET after DELETE must return 404. The billing owner documents the retained tombstone contract in `docs/secrets.md`: DELETE returns 204; authorized GET returns current revision/deletion metadata without a secret value or ciphertext; active lists omit the entry; history remains metadata-only and runtime use is denied. The revised journey checks those properties rather than absence of retained audit metadata. `current_version_id` remains an audit reference, not authority to use a deleted entry.
- **Validation, saved preview, plan read, run creation, reproduction, and portable-manifest download succeeded.** Cancel then returned 412 `revision_conflict`, request `req_2bb0ca7db5804a31852aee3475cd3fe8`. The execution owner identified a server ABA bug in the retained 09:41:45–09:41:59 trace: planning ETag 2, materialized queued ETag 1, then waiting ETag 2. Its fix seeds materialized revisions above the creation operation and makes cancellation's expected-revision check transactional. The test retains numeric strong ETags and checks materialization/review progression rather than accepting tag reuse.

The saved cancellation screenshot contains the visible error message and request ID; its accessibility snapshot exposed an unnamed alert. `ErrorNotice` now explicitly names the alert from its visible message. Cancellation's **Review current version** reads the run resource rather than the `/cancel` action endpoint. Recovery shows the read ETag and server state, requires an explicit **Use this revision** choice, then a separate **Cancel run** confirmation. A new conflict clears the prior reviewed snapshot. No read or adoption submits the action. The E2E handles a real 412 with this visible flow, requires a higher reviewed numeric revision, verifies the confirmation's exact `If-Match`, and records the two request IDs/ETags as evidence. The server fix and the complete browser flow now pass as recorded above.

Static checks after these UI/test changes: web production build and root typechecking passed. The earlier movement/workerd type diagnostics were resolved before the combined verification pass.

Earlier full run `.gitknot/e2e/run-1791190941318-179ad83c` also reported **1 passed, 2 failed, no skips**:

- **Collaboration passed**, including public docs/support, provisioning, Markdown/revisions/conflicts, comments, and second-principal denial.
- **Native review and viewer flows passed within the code/settings journey.** The real PR create returned 201 (`pr_b824d762ebfe496a81b7ea307cde0f19`, patch `patch_911991f990184b0a926b6537b530828a`); the real review-thread POST returned 201 with `path: retired.txt`, `side: old`, and lines 1–1 (`thread_06441620079a41189c94b9c0d18f7fd5`). The gateway implementation now excludes internal retention from catalog revision bumps (`workers/git/src/coordinator.ts:307–308`), resolving the prior PR-412 cause.
- **Resolved vault fence reproduction:** `POST /v1/repos/r_21ddc348d6c24afc9d5f83b019fa3c99/secrets` returned 503 `vault_write_fenced`, request `req_19a967e9de40449d88c828d456ed2398`. The private broker recorded `vault_request_775ff44b2d7a4a75b22ae4cce1aa9741`. The latest run successfully creates, rotates, and deletes the secret.
- **Resolved validation fence reproduction:** `POST /v1/repos/r_21ddc348d6c24afc9d5f83b019fa3c99/workflows/validate` with `{source}` returned 409 `execution_conflict`, request `req_5fdbcc59a1b94e59b3684fac670bb81d`. The parent's saved 09:03 diagnostic identified an autobackup-held metadata fence. The latest run succeeds through validation/preview/plan/run; the shared transaction fix defers the matching short backup fence while retaining the exact transaction and its guards.

Historical reproduction evidence remains in the retained Playwright `trace.zip` files, error contexts, and `stack.log` in those runs.

`playwright.config.ts` now launches `scripts/e2e.ts`, which runs the infrastructure-owned local setup/dev commands with a fresh `GITKNOT_LOCAL_STATE` beneath `.gitknot/e2e/`. The harness builds the web workspace, starts the real multiworker/native stack with `dev.ts --no-web`, and serves the emitted production assets on port 5173 with Vite preview and the real local API proxy. It waits for real API/native-helper/web readiness and real HTTP fixture creation before declaring the test stack ready. Missing services fail startup; the previous credential-dependent skips have been removed. `scripts/seed-e2e.ts` signs up and verifies fixture users through the production identity API and `actionToken` helper, provisions a repository through the durable operation, and publishes source and a deletion branch with stock Git through the local gateway.

An earlier stack attempt reached signup, verification, login, and successful repository provisioning, then failed on `POST http://localhost:8788/e2e-owner-36eaa6c8e4/e2e-verification.git/git-receive-pack` with HTTP 503. In isolated state `.gitknot/e2e/run-1791160744881-a138bef2`, publication `gop_a019f3858815445399176dbdf226f6b3` for `r_592b7c799aea4dd0ad07866c04f7d980` is durably `rejected` with `receive_rejected` (“Native receive or validation was rejected before publication”). The repository itself is `active`.

The native build root cause was Vite transforming the `new URL('./hooks.ts', import.meta.url)` expressions into `data:video/mp2t;base64,…` URLs before passing them to `fileURLToPath`. The native owner has since fixed the executable hook path; both source and deletion-branch pushes succeed in the latest isolated run.

A subsequent fresh-state attempt at `.gitknot/e2e/run-1791161593205-03ddd6b5` exposed duplicate insertion of principal `system:collaboration-retention` by migrations `026` and `086`. The migration owners reconciled it. The latest fresh local setup applies all current schemas successfully; no setup error is treated as readiness or a skipped test.

`tests/e2e/web.spec.ts` now contains three real journeys: (1) UI repository provisioning, canonical Markdown, revision conflicts, comments and denial to another verified principal; (2) native Git file/history/download flows, UI-issued viewer grants, header-only anonymous private downloads, and write-only vault rotation/revocation; (3) an actual compiled workflow run, durable queued-run cancellation, provenance, exact-unit billing, scoped budgets, and admission stop/resume. It never intercepts or stubs API responses.

Run `npm run test:e2e` on Node 24 with Playwright Chromium installed. No pre-existing account, repository, or credential flags are required. The harness refuses occupied local stack ports instead of silently reusing another server. It calls the infrastructure setup/dev scripts without modifying them, uses their production schemas/auth helpers, and emits a readiness receipt only after fixture API operations succeed. D1/R2/DO/Queues/Workflows state, client checkout, private fixture credentials, logs, traces and reports reside under the run's `.gitknot/e2e/` directory. Native repositories use the infrastructure-owned Git store and fresh opaque repository IDs; unrelated repositories are never deleted. Set `GITKNOT_LOCAL_STATE` to a new descendant of `.gitknot/e2e/` to select an explicit isolated run directory.

An earlier standalone harness run, `.gitknot/e2e/run-1791174342480-8276418d`, completed real signup/verification/login, repository provisioning, both native Git pushes, scoped token revocation, runner-pool creation, policy configuration, and immutable workflow registration. This was startup/fixture verification; the latest full-journey result is recorded above.

Agent-browser reviewed all five public documentation/support URLs against that real stack. Three observed accessibility defects were fixed: empty metadata title, breadcrumb contrast, and public sidebar sign-in contrast. Subsequent desktop WCAG A/AA audits returned zero violations; the collected console had no application errors. At 390px, document widths stayed within the viewport and the navigation dialog restored keyboard focus after Escape. Mobile screenshot/axe commands timed out in the browser tool, so mobile accessibility is not claimed as audited. Evidence is in the run's `browser-review.md`. Root/web typechecks and the web build passed at that stage; current check results are recorded above.

Historical PR-412 reproduction: `.gitknot/e2e/run-1791175309127-72a05dab` reached `POST /v1/repos/r_ddcc5ce799ca456ea635d18398a185d5/pulls` and received 412 `revision_conflict`, request `req_657d7ec59844404f9d7de0b829649c66`. Internal review retention incremented the catalog revision before the collaboration transaction's exact-revision guard. This is resolved by the gateway's internal-retention handling and the successful PR/deletion-thread responses in the latest full run. The historical trace is retained for reference.

After the preview routes landed, the workflow journey was expanded to validate source, create/read the saved preview and its strong ETag, inspect rendered requirements, and verify that previewing does not create a run before dispatching. Its attempted invocation was refused because another active E2E supervisor (`npm exec tsx scripts/e2e.ts`, state `.gitknot/e2e/run-1791175375692-2148f8fc`) owned ports 5173/8787 and the native helpers. That existing process was left with its owner; this is a startup failure, not a skipped/passing workflow test.

The earlier long-lived manual QA stack later stopped responding. Subsequent fresh full E2E execution supersedes that startup issue. Actual raw-download origin observations and native review assertions continue to exercise the production-built web assets and real backend. Manual review coverage and any browser-tool interruptions remain explicit in `dogfood-output/report.md`.

### Registered backend contracts

These are the integrated contracts exercised by the browser journeys. The UI preserves structured API errors and current authorization requirements.

- Execution now registers the preview routes with the requested body contract:
  - `POST /v1/repos/:repoId/workflows/validate` with `{source: string}` (optional pinned context is also supported); returns HTTP 200 with a saved validation preview.
  - `POST /v1/repos/:repoId/workflows/:workflowId/plan` with `{commit_oid, ref, inputs}`; returns HTTP 201 with `id` and an expiring immutable preview.
  - `GET /v1/repos/:repoId/plans/:planId`; reauthorizes and checks source/policy/configuration freshness, with explicit 409/410 for stale/expired previews.
  - Both response forms include `status` (`compiled`, `blocked`, `invalid`), `valid`, `executable: false`, structured `source`, `definition`, `cost`, `jobs`, and `diagnostics`, plus `expires_at` and a strong preview-digest ETag. The UI now displays provenance, exact quoted costs, diagnostic severities, and job requirements while preserving the complete response for inspection. The E2E workflow journey checks both create/read contracts and that previewing does not create a run.
- Runner listing accepts `repo_id` with repository-scoped `runners.manage`; account lists retain account-wide authority. An optional account filter must match the repository owner.
- Environments expose individual reads and revision-conditional deletion. A deleted environment retains authorized metadata/history and rejects new use; the UI removes its vault-creation and promotion controls.
- Git browsing/browser publication, collaboration fields and subresources, account/identity/federation routes, global run/runner routes, exact-unit billing, named vault entries, repository lifecycle, and audit reads match their registered module contracts. Run filters are server-side and cursor-bound; repository visibility uses current authority. Any additional client filtering is over authorized pages with retained pagination and no invented total count.
- Deployment headers must permit bundled ES modules and sandboxed diagram frames. No browser deployment, cloud provisioning, authenticated production interaction, or fake demo data is performed by the web package.

## Post-manual-QA integration pass

This section records the newer web changes after the earlier three-journey evidence, without changing that historical result.

- `pages/reproduction.tsx` sends the canonical `?job=` selector and renders the selected job, pinned source/toolchain, actual variable context, completed dependencies, and authorized dependency downloads. The command requires a user-selected existing isolation JSON file, its explicitly entered CLI-host path, and a command-shell choice. Supported OCI/POSIX-user/Windows-user backends are checked against the recorded platform/image; the CLI performs full configuration/runtime validation. Commands include `--job`, `--isolation`, the effective API origin, and optional user-entered local source/disposable flags. Shell arguments are quoted, input fields remain in component state across errors, and response checkout credentials are excluded from the rendered evidence and command. The passive frozen-manifest panel uses `/manifest`.
- Repository runner pools request `/v1/runner-pools?repo_id=...`; account views retain `account_id`. Repository creation fixes the pool scope to that repository. Workflow pages expose the approved `/versions` collection. Environment reads use their real individual GET, and authenticated deletion uses the existing conditional-confirmation controls; deleted metadata stays readable while vault creation/promotion controls are removed.
- `/accounts/:accountId/exports` and `/accounts/:accountId/exports/:exportId` implement the published complete-account-export contract in `docs/account-exports.md`. Downloads require both completed state and complete coverage. Views show coverage/checksums, durable operation progress, and revision-conditional cleanup.
- Run-list UI state filters translate to validated API `status` values; server pagination performs filtering. Unmaterialized creation requests show their requested commit distinctly rather than presenting it as verified source.
- Shared small-text/avatar colors address the measured dashboard/repository/editor/billing/plan failures. The replacement colors calculate to 5.01–6.13:1 on the reported computed backgrounds; an actual final browser audit is still required. Adjacent-name and labeled-link avatars/initials are decorative, while standalone identity avatars have an explicit image role/name. Comment/actor labels use resource-authorized summaries or the matching signed-in identity, with principal IDs only as technical fallbacks and no per-author profile requests.
- Included usage uses the existing BigInt-backed `Amount` formatter with USD in both overview and plan selection. Subscription customer fields are explicit; raw financial units appear only under labeled technical details. Shared sanitized Markdown rendering makes overflowing code blocks named keyboard-focusable regions and updates them on resize without reserializing the Markdown.

The existing three browser journeys now cover those boundaries. They additionally execute the copied selected-job CLI command against the actual API and verify its local checksummed JSON proof. This uses the existing `packages/runner/tests/support.ts` real OCI fixture, so Docker is required along with Node 24 and Git; the harness builds the packaged CLI, inspects exact tools inside the immutable fixture image, writes an actual isolation configuration, and creates the non-secret context variable through the vault API. No provider measurement is fabricated. The account-export journey reads the delivered TAR manifest, account metadata, and nested repository checksum. Other added observations cover repo-scoped pool access versus account denial, environment tombstones, displayed USD allowances, author attribution, and native keyboard scrolling. The earlier explicit 412 review/ETag/CAS and secret-tombstone checks remain part of these journeys.

Consolidated verification: root TypeScript and the web production build passed, followed by the expanded three-journey pass above. The final manual pass verified all five reported UI findings and recorded ten desktop/mobile WCAG A/AA audits with zero reported violations. Decorative monograms and partially occluded scroll regions have explicit manual follow-up notes. The editor mode container has a named group role, and activity rows use the same authorized attribution helper as comments; both small refinements were rebuilt and checked in the real browser.

The local README walkthrough was also exercised through signup, the captured development email viewer, verification and login. In Local Explorer, open the message and expand **Content** to find its verification URL. Evidence, remaining manual audit notes and screenshots are in `dogfood-output/verification-summary.json` and `dogfood-output/report.md`.
