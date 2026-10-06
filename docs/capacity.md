# Capacity and cost envelope

Capacity comes from bounded cells, measured admission, and retention. The values below are planning inputs checked **4–5 October 2026**, not measured service commitments.

## Current ceilings and operating targets

| Area | Published ceiling / planning fact | Initial GitKnot envelope |
| --- | --- | --- |
| D1 | 10 GB per database; a primary serializes queries | Move around 6.5 GB or earlier for latency/export limits; 1–8 explicit core bindings per cell |
| Identity authority | One current account-primary binding, initially colocated with the first core DB | `IDENTITY_DB` is shared across metadata cells; stale destination membership/policy copies are not authorization |
| Artifacts | 1 GB repository, 32 MB blob, 1 TB account in the published reference | Configurable repository/blob caps; recheck the expected limit increase at rollout |
| Artifacts requests | 2,000 / 10 s per namespace; Git rate is per repository | Partition namespaces; do not assume another namespace raises one hot repository's limit |
| Workers | 128 MiB isolate memory; zone request-upload limit also applies | Stream Git/object content; bounded metadata, results and logs; initial push budget 90 MiB |
| Worker subrequests | Paid default 10,000; configurable up to 10 million | 65,536 on API/background/execution/hosted; a 1-GiB direct output alone consumes 16,384 reserve/put/seal/checksum calls |
| Remote snapshot callback | Zone HTTP request-body limit is independent of Workers Paid | Trusted API callback domain must admit the selected cache allowance plus 16 MiB in one binary request |
| Durable Objects | ~1,000 requests/s soft planning limit per object | Per-repository publication and per-account/capacity-slice coordination, not one global object |
| Hosted Containers | Linux/amd64; account vCPU and regional capacity constraints | `standard-2`: 1 vCPU / 6 GiB / 12 GB; 10 production or 2 staging instances per execution cell |
| Trusted Git Containers | Separate disposable cache/process pool | 3 production or 1 staging instances, 4 sessions each, independent hard deadline |
| Webhook egress | Slow endpoints can consume duration/concurrency | Two `basic` instances; bounded HTTPS request/response sizes and 30-second idle shutdown |
| Workflows | 50,000 active paid instances; ordinary event/step data 1 MiB | 100 production run / 25 operation concurrency; R2 for large results; 1,024-step config budget |
| Queues | 128 KiB message; paid default retention 4 days, maximum 14 | 64 KiB product payload cap, ID/reference messages, 14-day retention and per-queue DLQs |
| Email | Beta sending quotas depend on account readiness | Read actual quota; reserve security mail capacity before onboarding |
| D1 recovery | Native export blocks queries and excludes virtual tables; SQL import has a 5 GiB-file limit | Search is separate; measure export amplification and restore time before a shard grows past the validated import envelope |

`infra/limits.ts` is the reviewed baseline. `LIMITS_JSON` passes product limits to the runtime; native Git overrides are under its `git` key. Raising a config value does not raise the provider limit. Restore/import/export paths need their own large-object proofs in addition to public Git push tests.

Normal local setup allocates a finite 10 USD development slice from a named 25 USD local pool with separate 1 USD safety and baseline commitments, two instance slots, 2 GB storage and a fixed 30-day admission window. This uses billing's real immutable-slice allocator. Existing budgets, holds, stops and deadlines are preserved, and expired allocations are not automatically renewed. See [local operating allocation](setup.md#finite-local-operating-allocation) for inspection and explicit new-generation funding. These are local operator limits, not hosted profile measurements.

Exactly one configured hosted runtime pool is active per topology: direct mode attaches it to the trusted execution Worker; remote mode attaches the dedicated `hosted-linux-small` application to the execution-account hosted Worker. The latter adds an independent scheduled/DO reaper, one attempt Workflow, a minimal 16-shard reaper index and ephemeral R2 staging. Cross-account capability checks and signed destruction proofs do not substitute for measuring actual VM/firewall/SDK behavior on the provider. Account and cell instance caps must still be summed across a rollout that retains older pools.

For example, a 1-GiB cache allowance requires a callback upload allowance of at least **1,040 MiB (1,090,519,040 bytes)**. Record the actual trusted API zone setting and exercise a maximum archive during provider acceptance. Neither 65,536 Worker subrequests nor request streaming raises the zone's HTTP admission ceiling; this calculation is a configuration prerequisite, not measured transfer evidence.

### Recheck published documentation

```sh
npx tsx infra/recheck-limits.ts --out .gitknot/infra/limits-2026-10-04.json
npx tsx infra/recheck-limits.ts --compare .gitknot/infra/limits-2026-10-04.json --out .gitknot/infra/limits-latest.json
```

This reads public official documentation and stores source URLs, content hashes, timestamps and text. It does not log in or change limits. Separately run read-only cf command discovery/schema inspection for account entitlements and usage; public documentation is not proof that this account has capacity.

## Executable workload matrix

`scripts/load-test.ts` uses real HTTP or stock Git clients. It records exact operation count, status/error classes, elapsed time, response bytes, p50/p95/p99, and pass/fail thresholds. It limits concurrency, request count, duration, rate, and response size. Tokens come from `GITKNOT_LOAD_TOKEN`, never a command-line URL. Non-loopback targets require `--allow-remote`.

```sh
npm run test:load -- --scenario health
npm run test:load -- --scenario metadata-read --fixture .gitknot/capacity.json --requests 2000 --concurrency 16 --rps 50 --max-p95-ms 300
npm run test:load -- --scenario metadata-write --fixture .gitknot/capacity.json --requests 500 --concurrency 8 --rps 20 --max-p95-ms 700
npm run test:load -- --scenario git-push-race --fixture .gitknot/capacity.json --requests 100 --concurrency 8 --rps 5 --max-p95-ms 30000
npm run test:load -- --scenario soak --fixture .gitknot/capacity.json --requests 1000000 --duration 3600 --concurrency 16 --rps 50
```

Copy `infra/load/fixture.example.json` to an ignored file and replace its IDs with actual capacity fixtures. The tool does not manufacture successful repositories/runs. Keep a dedicated disposable branch for `git-push-race`; it creates real commits against expected-old leases and records stale-old conflicts separately from successful publication and transport failure.

| Scenario | Executable behavior | Additional observations |
| --- | --- | --- |
| `many-repositories` | Rotate current authorized repository reads across `repo_ids` | Namespace/DB distribution, mostly-idle working set, cache/memory growth |
| `metadata-read` / `metadata-write` | Hot-repository issue reads / real issue creation | Primary latency, outbox lag, query/index work, write amplification |
| `large-organization` | Repeated actual `organization_read_path` from fixture | Membership/authorization fanout, cursor behavior, concurrent revocation |
| `git-push-race` | Native expected-old/atomic pushes from concurrent clients | At most one accepted conflicting old OID; source attribution and coordinator recovery |
| `ci-burst` | Submit the fixture's real `run_path`/`run_request` with unique idempotency keys | Admission-to-start, reservations, fair queue, cap saturation, cleanup; 409/429 are counted separately |
| `slow-webhooks` | Emit source issue changes and inspect configured `webhook_id` deliveries | Fast destinations continue, retries bounded, replay/deduplication works, source retained |
| `soak` | 90% reads / 10% writes until bounded count/duration | Leaks, WAL/storage growth, cache retention, cleanup and reconciliation drift |

Application status acceptance is not enough for financial/runtime proof. During the hosted matrix independently record allocations, start/stop times, destruction confirmation, peak live instances/vCPU, total byte/egress counts, active reservations and ledger settlements. Inject cancellation, consumer disconnection, controller death and lost callbacks. Demonstrate that a missing cleanup callback retains the hold and that cleanup is still possible after a budget cap.

## Cost accounting

At the illustrative published rates used in the proposal, a fully busy ten-instance 1-vCPU/6-GiB/12-GB pool is approximately **$1.29/hour of compute**. This excludes API/storage/queue/orchestration, trusted Git/egress helpers, network, retained storage, and allowances. A hard instance cap bounds the rate; admission reservations bound how much work is allowed to accumulate.

Use exact ledger units and immutable price versions. Reserve allocation through verified destruction plus retained-storage commitments and a shutdown/accounting buffer. Queue/approval waiting is not runner time. Do not release a runtime reservation based only on lease expiry or a successful SDK `finally` path. Analytics Engine is sampled and cannot authorize spending or settle invoices.

The Artifacts proposal observed conflicting October 14/15 billing-start statements. Budget from the earlier published date until clarified, and recheck current pricing rather than embedding an expired assumption in the ledger.

## Acceptance evidence

Record source/config/image hashes, cf/SDK versions, account/cell, dataset distribution, client location, request mix/rate, concurrency, failure injection, latency/status histograms, live runtime and billing measurements, and recovery timestamps. Keep warm and cold measurements separate. Publish availability/latency/RPO/RTO commitments only after representative sustained runs and successful restore drills.

Sources: [D1](https://developers.cloudflare.com/d1/platform/limits/), [Artifacts](https://developers.cloudflare.com/artifacts/platform/limits/), [Workers](https://developers.cloudflare.com/workers/platform/limits/), [DOs](https://developers.cloudflare.com/durable-objects/platform/limits/), [Containers](https://developers.cloudflare.com/containers/platform/limits/), [Workflows](https://developers.cloudflare.com/workflows/reference/limits/), [Queues](https://developers.cloudflare.com/queues/platform/limits/), [Email](https://developers.cloudflare.com/email-service/platform/limits/), [D1 import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/).
