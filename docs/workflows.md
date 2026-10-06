# GitKnot workflows

A workflow is a versioned declarative document in `.gitknot/workflows/*.yaml`. GitKnot compiles it once into an immutable, checksummed graph. Hosted execution, customer machines, local execution, and reproduction use that graph. A workflow never needs a Cloudflare account, credential, configuration file, or SDK.

The exact proposal example is committed as `.gitknot/workflows/verify.yaml`. `.gitknot/workflows/customer.yaml` demonstrates the same commands on a customer-owned pool.

## Small complete example

```yaml
version: 1
name: verify
triggers: [pull_request.updated, merge_candidate.created]
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

Commands in one job run sequentially in the same checkout. Every job starts from a **new checkout at the exact source commit**. `needs` supplies ordering and explicit output dependencies; jobs do not share working directories. A command failure stops the rest of its command group/job. A dependency failure produces `dependency_blocked` for dependent jobs, while independent jobs continue.

The default shell is `sh -e`. Explicit `bash` uses `--noprofile --norc -e -o pipefail`; `pwsh` uses noninteractive/no-profile execution and terminating PowerShell errors; `cmd` uses `/d /s /c`. A command can override `shell`, `working_directory`, `env`, and `timeout`. A module's command sequence occupies one job allocation. Cancellation terminates the entire process group/tree, then force-kills after a bounded grace period.

## Syntax and validation

Only YAML 1.2 core scalar/sequence/mapping values are accepted. Duplicate keys, aliases, merge keys, custom tags, multiple documents, unknown fields, non-finite numbers, cyclic JSON, and definitions larger than 1 MiB are rejected. No configuration evaluation or executable expression language runs during compilation.

| Field | Contract |
| --- | --- |
| `version` | Exactly `1`. |
| `name` | Stable identifier, at most 64 characters. |
| `triggers` | Dotted GitKnot event names. `workflow.dispatch` is the explicit manual trigger. |
| `source` | `event.commit` or a full lowercase 40/64-character Git commit ID. Branch names are resolved before compilation. |
| `defaults` | Executor, named toolchain, timeout (default `10m`), shell (default `sh`). |
| `access` | `repository: read|write|none`, `capabilities: [...]`, `secrets: [...]`. Executed jobs require source-read access. Defaults are read-only, with no capabilities/secrets. |
| `concurrency` | `group: pull_request|ref|workflow|environment`, `supersede: cancel|queue`. Groups are scoped to repository and workflow. Merge-candidate identities never collide with PR identities. Environment jobs require queue semantics. |
| `modules` | A mapping of exact `name@1.2.3` references to `sha256:...` digests. |
| `jobs` | Named jobs containing `steps`, and optional `needs`, executor/toolchain/access overrides, `env`, `when`, `cache`, `outputs`, `reports`, or `environment`. |

Durations are positive integers with `ms`, `s`, `m`, `h`, or `d`. Command and step timeouts cannot exceed the whole-job timeout. Retention is a whole number of seconds from one second to 90 days, matching the execution API; the server may impose a tighter organization ceiling. Paths are repository-relative, without traversal, `.git`, drive/UNC paths, backslashes, device names, or symbolic links. Path conditions support `*`, `**`, and `?` only.

Default compiler limits are 128 jobs, a 32-job ready frontier/fan-out, 128 expanded commands per job, and a one-hour maximum job timeout. Default per-job limits are 16 MiB of logs, 256 MiB of encoded outputs, 10,000 output files, 256 MiB of inputs/caches, and 256 KiB upload chunks. Trusted policy can supply bounded overrides. Limits apply to actual streamed bytes, including encoded archive overhead, and to checkout/execution/upload deadlines. A cache never converts a verification task into an automatic pass.

## Executors and pinned toolchains

```yaml
executor: { type: hosted, profile: linux-small }
# Or:
executor: { type: self_hosted, pool: linux-build }
```

A toolchain name resolves through a trusted catalog, for example:

```json
{
  "node-24@2026-10-01": {
    "os": "linux",
    "arch": "x64",
    "tools": { "node": "24.9.0", "npm": "11.6.0", "git": "2.51.0" }
  }
}
```

These example versions illustrate an explicit lock; use the catalog actually approved for your pool. Supported OS values are `linux`, `darwin`, `win32`; architectures are `x64`, `arm64`. Hosted profiles require Linux/x64. An optional `image` must use an OCI `@sha256:...` identity. The resolved descriptor's canonical SHA-256 fingerprint is embedded in every job.

Local/customer execution interrogates each declared executable and compares exact versions, OS, architecture, and the fingerprint before job commands. Node's leading `v`, Git's `git version ` prefix, and Python's `Python ` prefix are normalized; other version strings are the exact first version-output line. There is no range matching, automatic tool installation, or substitution of the current host for a named catalog entry. OCI execution additionally requires an exact `sha256:<local-image-id>` or registry `@sha256:<digest>` identity in the approved descriptor and verifies it against the selected isolation image. A direct host cannot attest an OCI image identity.

Inspect tools when deliberately creating a lock:

```sh
gitknot workflow toolchain inspect --name local-node@1.0.0 --tools node,npm,git > toolchains.json
```

## Typed modules and output references

A module is a data document resolved by a trusted registry. It has `version`, `name`, `module_version`, typed `inputs`, declared `outputs`, minimum `access`, and sequential command `steps`:

```yaml
version: 1
name: acme/greet
module_version: 1.0.0
inputs:
  message: { type: string }
outputs:
  greeting: { type: string, path: greeting.txt }
steps:
  - run: printf '%s' "$GITKNOT_INPUT_MESSAGE" > greeting.txt
```

Run `gitknot workflow module-digest greet.yaml`, then put that exact digest under `modules: { "acme/greet@1.0.0": "sha256:..." }`. Supply the actual module document in the trusted module registry (for offline CLI use, `--modules modules.json` maps references to JSON definitions or YAML strings).

```yaml
steps:
  - id: greeting
    uses: acme/greet@1.0.0
    with:
      message: { output: jobs.prepare.message }
  - run: printf '%s\n' "$GREETING"
    env:
      GREETING: { output: steps.greeting.greeting }
```

Module inputs/outputs use `string`, `number`, `boolean`, `json`, or `artifact`. Inputs are required by default; optional inputs need a typed `default`. Each input is supplied as `GITKNOT_INPUT_UPPERCASE_NAME`, or consumed explicitly as `{input: name}` in module command environments. Colliding uppercase names are rejected. Modules may group commands but cannot recursively import other modules or evaluate arbitrary configuration code.

Values can be scalars, `{literal: <JSON>}`, `{secret: NAME}`, `{variable: NAME}`, or `{output: jobs.JOB.OUTPUT}` / `{output: steps.STEP.OUTPUT}`. Output references must exist and have the right type. Job references must name a direct `needs` dependency; step references must name a previous step. Artifact inputs require typed output references, never arbitrary host filesystem paths. Input values are passed in environment variables; they are not interpolated into shell source.

Module output declarations name files produced by their command group. String outputs remove one final newline; numeric/boolean/JSON outputs must parse with the declared type. Typed values are capped at 64 KiB. Artifacts are copied into separate, read-only input directories; an environment reference resolves to the input directory path. Every consumer receives its own copy.

Workflow access is bounded by trusted policy. Job access cannot exceed workflow access. Module requirements cannot exceed job access. Both the module's exact version and normalized content digest are verified; changing a module's permissions or implementation changes the digest.

## Conditions and explicit outcomes

```yaml
when:
  paths:
    include: [src/**, package-lock.json]
    exclude: [src/**/*.md]
  events: [pull_request.updated]
  refs: [refs/heads/main]
```

Conditions are evaluated from pinned event inputs. Changed paths must cover the complete change (including both names for renames). Missing path/ref context and exceeded evaluation budgets produce an explicit blocked plan, not a pass. The glob evaluator has bounded dynamic-programming work, rather than unbounded regex backtracking.

A false condition is `not_applicable` **only when trusted policy lists the job in `inapplicable_jobs`**. Otherwise it is `blocked` and execution reports `dependency_blocked`. Contributor-controlled YAML cannot declare itself exempt. A trigger mismatch is always a blocked, nonqualifying plan; caller-supplied event types cannot manufacture an inapplicable required check.

Job outcomes are `passed`, `failed`, `dependency_blocked`, `cancelled`, `timed_out`, and `not_applicable`. Missing dependency outputs remain blocking even when a dependency was legitimately inapplicable. Local/CLI verification exits nonzero for unsuccessful or blocked work.

## Caches, outputs, reports, and environments

- **Caches:** only declared dependency paths are restored, after clean pinned checkout. Tracked source paths cannot be overlaid. Cache identity binds repository, trust class and producer, exact toolchain, policy/definition/module digests, configuration selection, dependency-output digests, variables, declared paths, and key-file contents. Trusted and untrusted caches cannot overwrite each other. `mode: read` disables cache writes. Missing key files produce a cache miss. Locally supplied unversioned secret values disable cache reuse.
- **Artifacts:** outputs default to `type: artifact`; declare `path`, `retention`, and optional `required: false`. Archives stream deterministic relative filenames, executable bits, and file bytes, with checksums and bounded extraction. Links, devices, `.git` metadata, path collisions/traversal, and detected credential/secret contents are rejected. Output directories are snapshotted after job processes stop.
- **Reports:** `reports: { tests: {path: reports/tests.xml, format: junit} }` supports `junit`, `sarif`, and `json`. JUnit XML is validated with DTD/entity processing disabled. JUnit failures/errors and SARIF error-level results fail verification even if a command exited zero. Failure reports are retained when available. Report names and artifact names must be distinct.
- **Environments:** `environment: production` must be permitted by trusted policy. A required approval binds the environment name, exact commit, and manifest digest; the server additionally binds the promoted artifact/destination. A local run without that approval reports it as unavailable. Environment jobs queue rather than silently discarding older releases.
- **Secrets:** declare names in `access.secrets` and explicitly reference them in command environments. The server selects immutable versions/scopes before compilation; `context.configuration: {selection_id, selection_digest}` binds that broker selection into the manifest. It releases only the active step's names immediately before the step. Plaintext values never enter the manifest. Logs are redacted across stream-chunk boundaries before disk/upload. Masking does not make arbitrary code safe to receive a secret.

## Local planning, execution, and reproduction

```sh
gitknot workflow validate verify
gitknot workflow plan verify --event event.json --toolchains toolchains.json --output plan.json
gitknot workflow run verify --local --manifest plan.json --source .
gitknot workflow reproduce run_example --job test
```

Without `--context`, planning resolves the source commit and reads the workflow at `--definition-revision` (defaulting to that commit), not from dirty/untracked files. `validate` examines the working YAML so errors can be caught before committing. A full trusted `--context context.json` is also supported for offline compilation; its schema is `CompileContext` in `packages/workflows/src/types.ts`. Locally constructed policy is labeled `local-1` and cannot authorize a public verified result.

An event file has `{type, changed_paths?, ref?, pull_request_id?, merge_candidate_id?, inputs?}`. PR concurrency requires its PR ID; merge-candidate runs use the candidate ID. Source and definition revisions live separately in compilation context.

Provide a local secret explicitly with `--secret NAME` (read from that environment variable), `--secret NAME=OTHER_ENV_NAME`, or `--secrets-file /private/path/secrets.json` (owner-only permissions, outside a repository). Variables use `--vars variables.json` or `--var NAME=value`. Unavailable secrets, inputs, variables, approvals, or toolchain identities are reported explicitly. Untrusted local source requires an explicitly designated disposable machine via `--disposable`.

Local logs, manifests, immutable outputs and result summaries are stored under the user's private GitKnot state directory; `--output DIRECTORY` selects an external result directory. Jobs are cleaned before completion. Reproduction verifies the original manifest and downloaded input checksums and can reuse immutable successful direct dependencies. It does not fabricate inaccessible secrets or approvals. A result from a local command is local evidence, not an authenticated server verification receipt.

## Compiler integration

`@gitknot/workflows` exports `workflowSchema`, `moduleSchema`, `manifestSchema`, `parseWorkflow`, `parseModule`, `validateWorkflow`, `compileWorkflow`, `verifyManifest`, `moduleDigest`, `fingerprintToolchain`, `resolveToolchain`, `canonicalJson`, `digestJson`, `sha256`, `DEFAULT_LIMITS`, and the manifest/context/result types. Its implementation uses YAML, Zod, and Web Crypto, with no Node-only or infrastructure SDK import.

`compileWorkflow(definition, context)` returns a deeply frozen JSON object whose digest binds normalized definition, resolved modules, source and definition commits, toolchains, policy revision/content, secret selection, event inputs, trust identity, per-job producer identity, and complete graph. There are no timestamps, random IDs, or credentials in the compiled identity. `verifyManifest` validates the complete schema and recomputes the manifest and toolchain fingerprints before execution.

See `packages/workflows/README.md` for the server call contract and `packages/runner/README.md` for enrollment, lease, blob and receipt protocols.
