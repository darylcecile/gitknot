# Portable compiler integration contract

The public entry point is `@gitknot/workflows` (`src/index.ts`). It has no Node-only or infrastructure-provider dependencies. The CLI and customer runner use this same compiler and manifest.

```ts
import { compileWorkflow, validateWorkflow, verifyManifest } from '@gitknot/workflows';

const manifest = await compileWorkflow(yamlOrObject, {
  repo_id: 'r_example',
  commit: '<full 40- or 64-character lowercase Git object ID>',
  workflow_revision: '<full trusted definition commit>',
  event: { type: 'pull_request.updated', changed_paths: ['src/index.ts'] },
  trust: { level: 'trusted', fork: false, producer_id: 'pool:linux-build' },
  policy: {
    revision: '1',
    allowed_workflow_revisions: ['<full trusted definition commit>'],
    access: { repository: 'read' },
    hosted_profiles: ['linux-small'],
    self_hosted_pools: {},
    inapplicable_jobs: [],
  },
  toolchains: {
    'node-24@2026-10-01': {
      os: 'linux', arch: 'x64',
      tools: { node: '24.9.0', npm: '11.6.0', git: '2.51.0' },
    },
  },
  modules: {},
});
```

`validateWorkflow` is synchronous and returns `{valid, definition?, issues}`. It validates syntax, graph, references, limits, and resolved module types when a module registry is supplied. `compileWorkflow` is asynchronous (Web Crypto SHA-256), validates trusted policy and resolves toolchains/modules, and returns a deeply frozen JSON manifest. It throws `WorkflowValidationError` with safe `{code,path,message}` issues. `verifyManifest` recomputes the manifest digest before execution; malformed or altered manifests are rejected.

The manifest contains `version`, `compiler_version`, `repo_id`, `source: {commit, workflow_revision}`, `workflow: {name, definition_digest}`, `policy: {revision, digest}`, `configuration: {selection_id, selection_digest}`, `trust`, `event`, `modules`, `jobs`, `order`, `concurrency`, `limits`, and `digest`. Jobs are an array identified by `id`; `needs` names dependencies. Each job has an exact executor, `producer_id`, a resolved `toolchain` with `fingerprint`, `timeout_ms`, effective `access`, `steps` (sequential command groups), `outputs`, `reports`, `cache`, `environment`, and an explicit `condition` (`run`, `not_applicable`, or `blocked` with a reason). The digest binds the definition, modules, pinned source, toolchains, policy, trust identity, event inputs, configuration selection, and complete graph. It excludes wall-clock time and generated run/attempt IDs.

Before remote secret use, supply `context.configuration: {selection_id, selection_digest}` from the private broker's version/scope selection, then bind that selection to the returned manifest digest. Both fields are null when no selection is bound (for example, an offline plan). The remote runtime rejects secret release without that binding. Pool entries can specify `producer_id: 'pool:<stable-id>'`; otherwise the job uses `pool:<executor.pool>`. Hosted jobs use `hosted:<profile>`. `trust.producer_id` additionally binds the trusted compilation identity; per-job producer identities permit mixed executor pools in one graph.

Adapters selecting per-job broker versions after graph expansion can call `bindManifestConfiguration(manifest, {selection_id, selection_digest})` before admission. For multiple selections, use a stable selection-set identity and the canonical digest of the job-to-selection ID/digest map. This returns a newly frozen manifest and digest; store/pass that final manifest and bind the broker selections to the enclosing final execution-plan identity. An existing non-null selection cannot be replaced.

The caller must obtain `workflow_revision`, policy, module definitions, and toolchain catalog from trusted storage. Never treat contributor-supplied compilation context as authorization. `policy.allowed_workflow_revisions` is required; source revisions can additionally be restricted by `allowed_source_revisions`. Untrusted/fork source cannot receive write access or secrets, or use a persistent customer pool. A condition can report `not_applicable` only for a job explicitly permitted by trusted policy.

Full syntax and runtime semantics are in `docs/workflows.md`. Wire protocol and receipt semantics are in `packages/runner/README.md`.

Repository placement is a server concern: `docs/routing.md` defines immutable global-resource locators and the separate primary identity authority. Compiler context and manifests retain logical repository/source/policy identity across a shard move. Execution creators must register pending run IDs before acknowledging planning, use locator type `workflow_operation` for their separate operation resources, and preserve `IDENTITY_DB` when routing metadata `DB`. The exact creator handoff is recorded in `packages/runner/README.md` under “Global IDs and repository movement.”
