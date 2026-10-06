# Implementation verification

**Date:** 5 October 2026  
**Scope:** the HTTPS-based product in `proposal.md`; native SSH is the deferred transport extension.  
**Status:** implementation and local verification complete. No deployment, Cloudflare resource provisioning, remote migration, commit or push has been performed. Live-provider acceptance is listed separately below.

## Verification gates

| Gate | Recorded result |
| --- | --- |
| Full high-level suite | Final parent run after review and accounting corrections: **277 passed, one Windows-only skip, 32 files passed**. The native ownership/recovery gate passed 39 checks, and the final billing/operational accounting gate passed 46, including exact settlement, bounded periodic work and retained uncertainty. |
| Browser journeys | **All three expanded journeys passed with zero retries**, including real Docker/compiled-CLI reproduction, complete account TARs, scoped access and explicit revision-conflict recovery. Final evidence: `.gitknot/e2e/run-1791226692414-755db6ee/`. |
| Repository visibility filter | Seven identity scenarios pass, including filtered pagination, private/unlisted discovery denial and current visibility after a metadata-shard move. |
| Execution/API/vault review fixes | **91 checks passed across nine files**, including immutable audiences, streamed revocation, conditional responses, PR event replay, repository-scoped pools, version history, run/log filters and environment retirement. Source and migration 100 are frozen. |
| Installed CLI contracts | **8 checks passed**, including real handlers, the compiled CLI and packed npm executable. Account exports verify native TARs, metadata checksums, nested repository archives and Git bundles. Local clone/helper checks use distinct API/Git ports and reject foreign origins and redirects. |
| TypeScript and cf configuration | Root TypeScript, all-layout configuration validation, both composed build/config comparisons and the offline production plan **passed**. |
| OpenAPI | The final API bundle ran in isolated workerd and exported **632 operations, 414 paths, 255 schemas and 6,421 resolved references** to `docs/api/openapi.json`. |
| Build | Both production layouts **passed**. Default: web/CLI, six Workers, three local Container images and one output root. Isolated-account fixture: seven Workers, three images and two separate account output roots. The active root output is the default direct production build. Images were saved locally, with no upload. |
| Manual browser review | Five findings fixed and verified; ten desktop/mobile WCAG A/AA audits reported zero violations. The README signup and local-email verification flow was exercised. See `dogfood-output/report.md`. |

The browser stack uses production-built web assets, real local Workers/D1/R2/Durable Objects/Queues/Workflows, and native Git processes. Its fixture provisioning uses the actual identity and repository APIs. Business API responses are not intercepted or replaced with mock successes.

## Completed review corrections

Two independent read-only reviews examined product/API/CLI coverage and the physical storage handoff. Their concrete findings were corrected and reviewed again; all identified findings are closed in the inspected source and covered by the recorded verification.

The follow-up reviews found the execution/API/CLI corrections and all six placement findings closed in the inspected source. Creation ownership now uses a stored unpredictable marker and immutable provider ID, verified against actual creation-time provider metadata or the local filesystem's durable creation record. The expanded native gate proves that a lost rejection cannot promote a foreign namespace to owned: its graph and content remain intact, and the original reservations and both fences remain held through retries and aborts. Delayed source-fence acquisition and complete same-cell archive recovery also have passing regressions. Provider creation/metadata semantics remain a separate live acceptance requirement.

The last product review's three follow-ups are also closed in source and their targeted regressions pass: private draft history is excluded from shared archives and owner-scoped in account metadata; current discovery visibility is rechecked after copied-row discovery; and inbox user-state witnesses guard mail's final release transaction. Ops' combined gate passed 50 tests across nine files, and the independent review found no remaining findings in those three cases. The local Git-origin/loopback mismatch is fixed and verified with real clone/read/push and credential-isolation checks. The final whole-repository, browser and build results are recorded above.

| Area | Implemented correction |
| --- | --- |
| Workflow data audiences | Enforced every immutable source-repository audience on run/failure/preview representations, logs, outputs and downloads, including current authorization before streamed bytes. |
| Global collaboration reads | Added current-placement search/feed/inbox reads with bounded pagination, current discovery rules and honest coverage. |
| Federation collaboration | Added user-owned inbox, subscriptions, saved views and activity for managed and organization-scoped SSO users. |
| Workflow triggers | Normalized `pull_request.patch_updated` into pinned, deduplicated verification. |
| Runner administration | Added repository-authorized pool listing without requiring account-wide administration. |
| API/CLI contracts | Reconciled issue/repository/run/log filters, workflow-version history, conditional environment deletion and local Git origins. |
| Reproduction UI | Preserved the selected job and supplied complete commands with explicit isolation inputs. |
| Account exports | Implemented complete versioned account exports, private-user boundaries, durable recovery, funded storage and verified downloads. |
| Placement ownership | Bound target names and creation receipts to immutable identities and required positive ownership evidence before cleanup. |
| Placement rollback | Required native reconciliation before namespace/metadata removal and retained unproven outcomes. |
| Placement retries | Preserved verified scratch after lost acknowledgments and fenced delayed acquisitions after rollback. |
| Move consistency | Preserved credentialed move snapshots and funded fresh canonical/scratch exposure for same-cell archive recovery. |

The five manual/browser findings—shared text contrast, opaque attribution, unlabeled monetary units, keyboard access to code scrolling and mobile export-ID overflow—were fixed and rechecked. The pass also verified sign-in, issue creation/comments, immutable workflow previews, billing reads, mobile drawer focus restoration, sign-out and public documentation navigation. The public support page passed desktop and mobile WCAG A/AA checks with zero violations or incomplete checks. The README's local signup and captured-email verification steps were exercised against the real application.

The longer local run exposed unnecessary periodic accounting overhead: 10,576 zero-nano-USD accrual events and 20,770 storage ledger rows for 79,728 retained bytes. Periodic callers now share configurable hourly UTC checkpoints, while explicit settlement, owner/placement cutover and due retention boundaries retain their exact timestamps. The repeated-sweep regression reduced the same 53-minute interval to 56 events and 112 ledger rows, preserving final money/carry, unknown holds and timely retention. Detailed observations and marginal queue-cost estimates are in `dogfood-output/background-accrual-cost-analysis.json`; these are local/code-level measurements, not live-provider billing evidence.

## Test scope

The suites protect observable behavior: authorization boundaries, real HTTP and native Git/shell operations, production SQL transactions, exactly-once receipts, lost acknowledgments, concurrent revisions, isolation and cleanup. The test review found no extraneous standalone helper-unit suite. Redundant embedded checks were removed, and a URL-helper-only browser check was replaced by actual request-origin observation.

The Windows native-isolation acceptance case requires Windows and an operator-provided execution credential file. Its skip on this macOS host is explicit; these results do not establish Windows acceptance.

## Reproduce the local gates

```sh
npm run setup
npm run typecheck
npm run check:config -- --all-layouts
npm test
npm run test:e2e
npm run build -- --mode production --save-images
npm run check:config -- --mode production --build
npm run openapi -- --build-output .
npm run infra:plan -- --mode production --out .gitknot/infra/production-plan.json
```

Node 24, native Git, a working Docker daemon for image builds, and Playwright Chromium are required. These commands are local/offline with respect to Cloudflare account operations. See [setup](setup.md) for exact prerequisites and [testing](testing.md) for the fixture/runtime boundaries.

## Provider acceptance

Live provider acceptance has not been run. The remaining rollout evidence covers real Artifacts atomic/conditional publication and current limits; hosted microVM isolation, egress/DNS enforcement and verified destruction; account/zone entitlements; email/DNS and Logpush delivery; representative load/soak measurements; and deployed cross-store recovery drills. Local compilation, filesystem Git, SDK boundary tests and local workerd results do not establish those provider outcomes.

The executable workload matrix and required evidence are maintained in [capacity](capacity.md), [operations](operations.md), [Git](git.md), [execution](execution.md) and [recovery](recovery.md).
