A GitKnot workflow is a versioned YAML document in `.gitknot/workflows/`. The compiler turns a definition and its trusted context into a checksummed, immutable graph. Source, definition revision, toolchains, permissions, dependencies, and output identities travel with that graph.

## A complete definition

Save this as `.gitknot/workflows/verify.yaml` in a Node project with `npm test` and `npm run build` scripts:

```yaml
version: 1
name: verify
triggers: [workflow.dispatch, pull_request.updated, merge_candidate.created]
source: event.commit
defaults:
  executor: { type: hosted, profile: linux-small }
  toolchain: node-24@2026-10-01
  timeout: 10m
access:
  repository: read
concurrency:
  group: pull_request
  supersede: cancel
jobs:
  test:
    cache:
      paths: [.cache/npm]
      key_files: [package-lock.json]
    steps:
      - run: npm ci --cache .cache/npm
      - run: npm test
  build:
    needs: [test]
    steps:
      - run: npm ci
      - run: npm run build
    outputs:
      bundle: { path: dist/, retention: 14d }
```

`node-24@2026-10-01` is a named toolchain lock. Select a toolchain approved for your repository and executor; the name resolves to exact OS, architecture, executable versions, and an image digest where applicable. It does not install tools or select the latest Node version. Hosted profile availability is returned by `GET /v1/hosted-profiles`.

Commands within one job run sequentially in the same checkout. Each job gets a **fresh checkout at the exact source commit**. The build job depends on test, but does not inherit its files; that is why both jobs install their dependencies.

## Validate and register

1. Run `gitknot workflow validate verify`, or paste the YAML into the repository's **Workflows → Validate a workflow** view.
2. Commit and push the definition. In **Add workflow**, supply its repository-relative path and full definition commit ID.
3. Open the registered definition and choose **Preview execution plan** with the full source commit, source ref, and any manual inputs.
4. Inspect the pinned requirements, then use **Run workflow** to submit execution. Validation and previewing do not allocate an executor.

Repository managers configure the trusted toolchain catalog, allowed modules and pools, and permission ceilings. Approving a new definition revision is separate from choosing the source commit for a run.

YAML accepts data only: duplicate keys, aliases, custom tags, multiple documents, and unknown fields are rejected. Jobs need unique names and valid dependencies. Commands, output paths, output references, and permission requirements are checked before execution.

## Dependencies, outputs, and outcomes

- `needs: [test]` declares a direct job dependency. Dependent jobs cannot proceed after a failed required dependency.
- Artifacts declare a repository-relative `path` and retention. `bundle` above is an artifact produced by the build job.
- Typed values and artifacts can flow through explicit references such as `{ output: jobs.prepare.bundle }`. The producer must be a direct dependency.
- A cache can restore declared dependencies; it cannot substitute for running a required verification.
- Conditions use pinned events, refs, and complete changed-path data. A false condition is nonblocking only when trusted policy permits that job to be inapplicable.
- Run pages show each job's outcome and retained attempts. A queued, blocked, cancelled, or timed-out job is not a passing verification.

## Permissions, secrets, and spending

Workflow access is bounded by repository policy; a job cannot request more authority than its workflow. Declare secret names in `access.secrets`, then reference them explicitly in command environments. GitKnot selects immutable versions and releases the active step's required values. Secret plaintext is excluded from manifests and management reads.

Account budgets and repository limits control admission. The plan describes requirements; execution applies current permissions, capacity, and spending controls again. Cancelling a run fences new work and remains pending until executor termination is confirmed.

Environment promotion binds an exact verified artifact, source commit, and destination. Required approvals apply to that identity, rather than authorizing a later rebuild with different bytes.

## Customer-owned executors

To target an approved customer-owned pool, use `executor: { type: self_hosted, pool: linux-build }`. The pool name, trust class, isolation, and declared toolchain fingerprints must match the repository's policy and registered machines.

Customer runners connect outbound to GitKnot. Their supervisor and job credentials are separated by an explicit execution boundary. A runner enrollment is one-time; a machine credential can be rotated or revoked. `gitknot runner --help` describes pool, enrollment, registration, and daemon commands.

## Plan and reproduce locally

Local execution requires an `isolation.json` configuration for your execution boundary. The supported types are `oci`, `posix_user`, and `windows_user`. OCI uses a preloaded, digest-pinned image; native modes use a dedicated job identity distinct from the supervisor. Match the toolchain descriptor to that boundary.

```sh
gitknot workflow toolchain inspect --name node-24@2026-10-01 \
  --tools node,npm,git --isolation isolation.json > toolchains.json
```

When deliberately creating a local toolchain lock, record the exact tools in the selected boundary under the same name as your workflow's `toolchain`. To reproduce an existing manifest, use its original descriptor rather than replacing the lock with different local tools. Then compile the committed definition:

```sh
gitknot workflow plan verify --toolchains toolchains.json --output plan.json
gitknot workflow run verify --local --manifest plan.json \
  --source . --isolation isolation.json
```

Planning reads the workflow at the pinned definition revision, not an uncommitted working copy. Validation reads your working YAML. The CLI's default local event is `workflow.dispatch`; `--event event.json` supplies explicit event, ref, and changed-path context when needed.

To reproduce a server run, replace `RUN_ID` and `test` with the actual run and job:

```sh
gitknot workflow reproduce RUN_ID --job test --isolation isolation.json
gitknot run manifest RUN_ID --output plan.json
```

**Download manifest** on the run page and `GET /v1/runs/RUN_ID/manifest` return the portable manifest directly. `GET /v1/runs/RUN_ID/reproduce?job=test` returns an envelope with that manifest, pinned source, and authorized dependency inputs. The CLI verifies their identities and checksums before execution. Missing secrets, approvals, inputs, or matching tools are reported as unavailable. Local results remain local evidence.

See the [CLI guide](/docs/cli) for authentication and command options, or [Support](/support) for request-ID and blocked-run troubleshooting.
