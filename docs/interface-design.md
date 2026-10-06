# Interface design

GitKnot is a working environment for code and collaboration. The interface should help someone find a project, understand a change, and take the next action with as little setup as possible.

## Visual system

| Token | Value | Purpose |
| --- | --- | --- |
| Surface | `#ffffff` | Content and editing |
| Canvas | `#f6f8fa` | Navigation and grouped controls |
| Text | `#1f2328` | Primary content |
| Muted text | `#59636e` | Supporting information |
| Link | `#0969da` | Navigation and references |
| Primary action | `#1f7a3f` | The main action in a workflow |
| Border | `#d8dee4` | Grouping without decorative shadows |

Use the system font for product text and a system monospace stack for source, commands, and immutable revisions. Body text is 14px; secondary information is 12–13px; page titles are 24–26px. Color is functional: most of the interface is neutral, links are blue, primary actions are green, and statuses include text. Shadows belong to overlays.

The main content has a 1280px maximum width. Use compact lists for repositories and work, a local sidebar for settings, and one shared header for global navigation. On mobile, the primary navigation opens in a native dialog and long settings navigation becomes a grouped select. Keep repository tabs horizontally scrollable without making the document itself scroll horizontally.

## Interaction principles

- Lead with the task. A new issue begins with its title and description. Assignments, labels, dates, and other optional details are available in a named disclosure.
- Keep administrative actions in context. Account administration is in the account menu; repository actions are in the repository menu; resource-row actions are in an overflow menu.
- Distinguish conversation, related work, activity, and document history. Each is a deep-linkable view rather than another panel below the conversation.
- Use actual names when choosing relationships. Searchable single/multi-select popovers share the authorized collections, pagination, and ID-valued request contract.
- Start with useful presets. Permissions offer read-code, push-code, and collaboration presets. Branch protection starts with an ordinary protected branch and exposes reviews, checks, signatures, and other restrictions on demand.
- Keep optional settings optional. Vault entries can use their scoped defaults. Typed restriction controls appear when customizing access.
- Choosing a branch resolves an exact commit. Pull requests, workflow definitions, runs, and code scans continue to send pinned revisions; opening a picker does not publish or execute work.
- Workflow inputs use named, typed rows. Roles, rules, scope conditions, account policy, federation, webhooks, and saved searches use dedicated controls. JSON is limited to expandable diagnostic output and optional file import.
- Local reproduction can generate a CLI isolation file from the recorded job platform. Users choose the host-specific settings, download the configuration, and supply its actual CLI-host path. Existing configuration files remain importable.
- Preserve drafts and concurrency semantics. Structured editors retain unedited nested values. Existing JSON-encoded tab drafts are decoded at the form boundary. Strong ETags, deliberate conflict recovery, and the central mutation transport remain the save contract.

## Motion and accessibility

Use short, interruptible CSS transitions for feedback and occasional overlays: 120ms press feedback, 160ms popovers, and 180ms dialogs, with `cubic-bezier(0.23, 1, 0.32, 1)`. Popovers originate at their trigger; dialogs remain centered. Navigation and repeated keyboard interactions are immediate. Reduced-motion preferences disable movement. Avoid page-entry choreography and animated layout dimensions.

Native dialogs handle modality, Escape, and focus trapping. Native popovers handle top-layer positioning and light dismissal. Dialogs render outside overflow containers, so an action menu can close while its editing dialog remains open. Controls have visible labels and focus rings, and failed field validation reveals its enclosing disclosure. Save feedback is announced without moving focus.

## Sources

- [Emil Kowalski: design engineering skills](https://emilkowal.ski/skill) — purposeful motion, immediate response, and restraint.
- [GitHub](https://github.com/primer/react) and [Primer forms](https://primer.style/product/ui-patterns/forms/) / [progressive disclosure](https://primer.style/product/ui-patterns/progressive-disclosure/) — content hierarchy, familiar repository interactions, and concise task flows.
- [Anthropic frontend design](https://www.skills.sh/anthropics/skills/frontend-design) — intentional typography, palette, layout, and copy grounded in the product.
- [Vercel web design guidelines](https://www.skills.sh/vercel-labs/agent-skills/web-design-guidelines) — semantics, keyboard access, state, validation, and responsive behavior.
- [Vercel composition patterns](https://www.skills.sh/vercel-labs/agent-skills/vercel-composition-patterns) — explicit editor components with shared controls and controlled state.
- [UI/UX Pro Max](https://www.skills.sh/nextlevelbuilder/ui-ux-pro-max-skill/ui-ux-pro-max) — visual hierarchy, progressive disclosure, accessible contrast, and interaction density.
