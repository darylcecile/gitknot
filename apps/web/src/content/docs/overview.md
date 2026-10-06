GitKnot connects repositories, decisions, reviews, and reproducible workflows. The web application and command line use the same GitKnot API and current permissions.

## Start with your account

[Create an account](/auth/signup), verify your email, and [sign in](/auth/login). If your organization uses single sign-on, use [organization sign-in](/auth/sso). You can manage your profile, passkeys, second factor, and active sessions in [Settings](/settings).

Organizations group members and teams. Repository access depends on your membership, role, credential scope, and repository rules. A token only narrows the authority of its owner; it does not bypass branch protection.

## Create a repository and push code

1. Open [New repository](/repos/new), choose the owning account, and select its visibility.
2. Wait for provisioning to finish, then open the repository. An accepted operation is still in progress until its operation page reports completion.
3. Copy the repository's HTTPS clone URL. Use the [CLI's Git credential helper](/docs/cli) to authenticate ordinary Git clone, fetch, and push operations.

Stable repository IDs continue to identify your work after a rename or transfer. Use the URL returned by GitKnot rather than constructing a remote from an old owner or name.

| Visibility | Audience |
| --- | --- |
| Public | Available for public reading and discovery. |
| Private | Principals granted access to the repository. |
| Internal | The owning organization's authorized members. |
| Unlisted | Public reading through a known URL, without public discovery. |

For private sharing, a repository owner can create a scoped, expiring viewer grant. A viewer link grants read access to its exact repository; keep the link within its intended audience.

## Keep decisions with the change

Use issues for work, discussions for questions and decisions, and tasks to coordinate contributors. Pull requests bind reviews to immutable patch versions. Select a diff line to start a thread on that file, side, and revision; deleted lines remain attached to the old side of the patch.

Markdown is the canonical document format. **Write** and **Markdown** edit the same document. Unsupported blocks are retained as source. If a save conflicts with another edit, your draft stays in the form: inspect the current revision, reconcile the difference, and save against that revision.

Search results include their coverage and freshness. Follow pagination and use a complete code scan when your answer depends on every matching file, not just the current result page.

## Validate, plan, and run

Store workflow YAML under `.gitknot/workflows/`. Register a definition at an exact commit, preview its execution requirements, and run it against pinned source. Each job has explicit dependencies, toolchains, permissions, outputs, and outcomes. The [workflow guide](/docs/workflows) includes a complete example and local reproduction commands.

The owning account pays for usage. [Billing](/billing) distinguishes measured usage, forecasts, and outstanding reservations. Hard budgets and admission controls govern new work; a forecast or threshold notification is not a spending cap.

## Choose a guide

- [Command line](/docs/cli): authentication, HTTPS Git, collaboration, and automation.
- [Workflows](/docs/workflows): definitions, toolchain locks, plans, outputs, and reproduction.
- [API guide](/docs/api): origins, permissions, pagination, revision preconditions, retries, and downloads.
- [Help and keyboard shortcuts](/help): navigation and editor controls.
- [Support](/support): recovery, request IDs, and troubleshooting an unsuccessful operation.
