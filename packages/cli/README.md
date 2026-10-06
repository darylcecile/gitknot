# GitKnot CLI

Requires Node.js 24 or newer within the supported engine range and Git for local workflows/runner checkout.

```sh
npm install --global @gitknot/cli
gitknot auth login
gitknot repo list
gitknot workflow validate .gitknot/workflows/verify.yaml
gitknot --help
```

From this monorepo, `npm run build --workspace @gitknot/cli` creates the actual executable at `packages/cli/dist/cli/src/index.js`. `npm pack --workspace @gitknot/cli` builds a self-contained package with compiled copies of the portable compiler and runner. It does not import sibling workspaces or execute TypeScript at install/runtime. The only runtime dependencies are YAML/schema/XML parsing libraries.

The complete command reference is in `docs/cli.md`; workflow syntax is in `docs/workflows.md`; the customer-runner wire protocol is in `packages/runner/README.md`.
